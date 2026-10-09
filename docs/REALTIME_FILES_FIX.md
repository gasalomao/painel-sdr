# Correção do Sistema de Arquivos em Tempo Real — Vidrão

**Problema:** Arquivos não aparecem em tempo real enquanto a IA gera código  
**Análise:** 2026-10-09  
**Status:** Diagnóstico completo → Implementação pendente

---

## 1. DIAGNÓSTICO DA CAUSA RAIZ

### Fluxo Atual (QUEBRADO)

```
1. User envia mensagem
   ↓
2. POST /api/sites/[projectId]/runs
   ↓
3. Worker BullMQ pega a run
   ↓
4. Agente IA chama tools:
   - tools.execute("write", { path: "src/App.tsx", content: "..." })
   - tools.execute("create", { path: "src/Header.tsx", content: "..." })
   ↓
5. WebsiteTools atualiza workspace local (memória)
   ↓
6. Evento salvo em website_messages:
   { role: "tool", content: '{"saved": "src/App.tsx"}' }
   ↓
7. ❌ PROBLEMA: UI não sabe que arquivo mudou
   ↓
8. saveRunCheckpoint() salva tudo no final
   ↓
9. UI faz polling GET /files?run_id=X a cada 3-5s
   ↓
10. ✅ Arquivos aparecem APÓS conclusão (latência 3-5s+)
```

### Por que não funciona em tempo real?

**Evento está no DB, mas não chega à UI:**

```typescript
// src/lib/sites/worker.ts linha 71-74
const event: WebsiteAgentDependencies["event"] = async (run, message) => {
  await check(run);
  const { error } = await db
    .from("website_messages")
    .insert({ 
      client_id: run.client_id, 
      project_id: run.project_id, 
      run_id: run.id, 
      ...message 
    });
  databaseError(error);
};
```

**Problema 1:** `website_messages` não tem Realtime configurado  
**Problema 2:** UI não escuta `website_messages`, só `website_run_activities`  
**Problema 3:** Tool events não contêm conteúdo do arquivo, só metadados

### Arquitetura Atual (Parcialmente Funcional)

```
┌─────────────────────────────────────────────────┐
│                    WORKER                        │
│                                                  │
│  WebsiteAgentRuntime                            │
│  ├── tools.execute("write", ...)                │
│  │   └── workspace["src/App.tsx"] = content     │ ← Memória local
│  │                                               │
│  ├── event({ role: "system", content: {...} })  │
│  │   └── INSERT INTO website_messages           │ ← DB, mas sem Realtime
│  │                                               │
│  └── saveRunCheckpoint()                        │
│      └── UPDATE website_runs SET checkpoint     │ ← Só no final
│                                                  │
└─────────────────────────────────────────────────┘
                        │
                        │ (polling a cada 3-5s)
                        ↓
┌─────────────────────────────────────────────────┐
│                      UI                          │
│                                                  │
│  useEffect(() => {                              │
│    const poll = setInterval(() => {             │
│      fetch(`/files?run_id=${runId}`)           │ ← Latência 3-5s
│        .then(data => setFiles(data.files))     │
│    }, 3000)                                     │
│  }, [runId])                                    │
│                                                  │
└─────────────────────────────────────────────────┘
```

**Resultado:** Arquivos aparecem em "lotes" a cada 3-5 segundos, não instantaneamente.

---

## 2. SOLUÇÃO PROPOSTA (Solução A — Rápida)

### Reutilizar sistema de activities (SSE) existente

**Por que activities funciona:**

```typescript
// src/app/api/sites/runs/[runId]/activities/route.ts
export async function GET(request: NextRequest) {
  if (stream) {
    return new Response(
      new ReadableStream({
        async start(controller) {
          // ✅ Envia atividades existentes
          const existingActivities = await supabase
            .from("website_run_activities")
            .select("*")
            .eq("run_id", runId);

          // ✅ Subscreve a novos eventos via Realtime
          const channel = supabase
            .channel(`run-activities:${runId}`)
            .on("postgres_changes", {
              event: "INSERT",
              schema: "public",
              table: "website_run_activities",
              filter: `run_id=eq.${runId}`
            }, (payload) => {
              controller.enqueue(encoder.encode(formatSSE(payload.new)));
            })
            .subscribe();
        }
      }),
      {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        }
      }
    );
  }
}
```

**Logs em tempo real funcionam porque:**
1. ✅ Worker insere em `website_run_activities`
2. ✅ Supabase Realtime detecta INSERT
3. ✅ SSE envia evento para UI
4. ✅ UI renderiza log instantaneamente

### Mudanças Necessárias

**1. Worker: Emitir atividade para cada tool call**

```typescript
// src/lib/sites/agent.ts (modificar WebsiteAgentRuntime)

async executeTool(name: string, args: unknown): Promise<unknown> {
  const startTime = Date.now();
  
  // ✅ Emitir "started" via activities
  await this.deps.event(this.run, {
    role: "system",
    content: JSON.stringify({
      tool: name,
      status: "started",
      path: args.path || null, // se aplicável
      timestamp: Date.now()
    })
  });

  try {
    // Executar tool original
    const result = await this.tools.execute(name, args);
    const duration = Date.now() - startTime;

    // ✅ Emitir "completed" via activities
    await this.deps.event(this.run, {
      role: "system",
      content: JSON.stringify({
        tool: name,
        status: "completed",
        result: {
          saved: result.saved || null,
          path: result.path || args.path || null
        },
        duration,
        timestamp: Date.now()
      })
    });

    return result;
  } catch (error) {
    // ✅ Emitir "error"
    await this.deps.event(this.run, {
      role: "system",
      content: JSON.stringify({
        tool: name,
        status: "error",
        error: error.message,
        timestamp: Date.now()
      })
    });
    throw error;
  }
}
```

**2. UI: Escutar eventos de tool e buscar checkpoint**

```typescript
// src/components/sites/site-files-panel.tsx

useEffect(() => {
  if (!runId || status !== "editing") return;

  // Conectar SSE de activities
  const eventSource = new EventSource(
    `/api/sites/runs/${runId}/activities?stream=true`
  );

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      // Se é evento de tool que salva arquivo
      if (
        data.type === "system" && 
        data.details?.tool && 
        ["write", "create", "patch", "delete", "rename"].includes(data.details.tool) &&
        data.status === "completed"
      ) {
        // ✅ Buscar checkpoint atualizado IMEDIATAMENTE
        fetch(`/api/sites/${projectId}/files?run_id=${runId}`)
          .then(res => res.json())
          .then(data => {
            if (data.checkpoint) {
              setFiles(data.checkpoint.files);
              setVersion(data.checkpoint.version);
            }
          });
      }
    } catch (e) {
      console.error("Error parsing SSE event:", e);
    }
  };

  return () => eventSource.close();
}, [runId, status, projectId]);
```

**3. Converter eventos system para activities (worker)**

```typescript
// src/lib/sites/worker.ts - modificar createWebsiteAgentDependencies

const event: WebsiteAgentDependencies["event"] = async (run, message) => {
  await check(run);
  
  // Salvar em website_messages (histórico)
  const { error: msgError } = await db
    .from("website_messages")
    .insert({ 
      client_id: run.client_id, 
      project_id: run.project_id, 
      run_id: run.id, 
      ...message 
    });
  databaseError(msgError);

  // ✅ NOVO: Se é evento system com tool, também salvar em activities
  if (message.role === "system") {
    try {
      const content = JSON.parse(message.content);
      
      if (content.tool) {
        const activityType = 
          content.tool === "write" ? "file_write" :
          content.tool === "create" ? "file_create" :
          content.tool === "patch" ? "file_patch" :
          content.tool === "delete" ? "file_delete" :
          content.tool === "read" ? "file_read" :
          "tool_call";

        const { error: actError } = await db
          .from("website_run_activities")
          .insert({
            run_id: run.id,
            type: activityType,
            message: content.path 
              ? `${content.tool}: ${content.path}`
              : content.tool,
            status: content.status || null,
            details: content,
            duration_ms: content.duration || null,
            created_at: new Date().toISOString()
          });
        
        if (actError) {
          console.error("[worker] Failed to insert activity:", actError);
        }
      }
    } catch {
      // Não é JSON ou não tem tool, ignorar
    }
  }
};
```

### Fluxo Corrigido (FUNCIONAL)

```
1. User envia mensagem
   ↓
2. POST /api/sites/[projectId]/runs
   ↓
3. Worker pega run
   ↓
4. Agente chama tool:
   tools.execute("write", { path: "src/App.tsx", content: "..." })
   ↓
5. ✅ Emite evento "tool started" → website_run_activities
   ↓
6. ✅ Supabase Realtime detecta INSERT
   ↓
7. ✅ SSE envia evento para UI (<100ms)
   ↓
8. ✅ UI recebe evento, faz GET /files?run_id=X
   ↓
9. ✅ UI atualiza árvore de arquivos (~200ms total)
   ↓
10. ✅ Arquivo aparece em tempo real!
```

**Latência:** ~200-300ms (vs 3-5s+ antes)

---

## 3. VANTAGENS E DESVANTAGENS

### Solução A (Activities + Polling)

**Vantagens:**
- ✅ Reutiliza infraestrutura SSE já implementada e testada
- ✅ Zero novas rotas API ou tabelas DB
- ✅ UI já consome activities, código existe
- ✅ Implementação rápida (1-2 horas)
- ✅ Compatível com checkpoint incremental futuro

**Desvantagens:**
- ❌ Dois requests por mudança (SSE evento + GET checkpoint)
- ❌ Conteúdo do arquivo não vem no SSE (só path)
- ❌ Latência ~200-300ms (aceitável, mas não instantâneo)

### Solução B (Checkpoint Stream — Futura)

**Vantagens:**
- ✅ Conteúdo completo no SSE (zero GET adicional)
- ✅ Latência ~50-100ms (mais rápido)
- ✅ Diff incremental eficiente

**Desvantagens:**
- ❌ Requer nova API route: `/checkpoint/stream`
- ❌ Duplicação de dados (checkpoint salvo + stream)
- ❌ Mais complexo (3-5 horas implementação)

**Recomendação:** Começar com A, migrar para B só se latência for problema.

---

## 4. IMPLEMENTAÇÃO PASSO-A-PASSO

### Passo 1: Modificar `src/lib/sites/worker.ts`

```typescript
// Adicionar emissão de activities para eventos system com tool
const event: WebsiteAgentDependencies["event"] = async (run, message) => {
  await check(run);
  
  // Salvar em messages (histórico)
  const { error: msgError } = await db
    .from("website_messages")
    .insert({ 
      client_id: run.client_id, 
      project_id: run.project_id, 
      run_id: run.id, 
      ...message 
    });
  databaseError(msgError);

  // Se é evento system com tool, emitir activity
  if (message.role === "system") {
    try {
      const content = JSON.parse(String(message.content));
      
      if (content.tool && ["write", "create", "patch", "delete", "rename"].includes(content.tool)) {
        const { error: actError } = await db
          .from("website_run_activities")
          .insert({
            run_id: run.id,
            type: `file_${content.tool}`,
            message: content.path ? `${content.tool}: ${content.path}` : content.tool,
            status: content.status || null,
            details: content,
            duration_ms: content.duration || null,
            created_at: new Date().toISOString()
          });
        
        if (actError) {
          console.error("[worker] Failed to insert activity:", actError);
        }
      }
    } catch {
      // Não é JSON ou não tem tool
    }
  }
};
```

### Passo 2: Modificar `src/components/sites/site-files-panel.tsx`

```typescript
// Adicionar listener SSE
useEffect(() => {
  if (!runId || !["editing", "validating"].includes(status)) return;

  const eventSource = new EventSource(
    `/api/sites/runs/${runId}/activities?stream=true`
  );

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      // Eventos de mudança de arquivo
      if (
        data.type?.startsWith("file_") && 
        data.status === "completed" &&
        data.details?.result?.path
      ) {
        // Buscar checkpoint atualizado
        fetch(`/api/sites/${projectId}/files?run_id=${runId}`)
          .then(res => res.json())
          .then(responseData => {
            if (responseData.checkpoint) {
              setFiles(responseData.checkpoint.files);
              setVersion(responseData.checkpoint.version);
              
              // Opcional: highlight do arquivo alterado
              setHighlightedPath(data.details.result.path);
              setTimeout(() => setHighlightedPath(null), 2000);
            }
          })
          .catch(err => {
            console.error("Error fetching checkpoint:", err);
          });
      }
    } catch (e) {
      console.error("Error parsing SSE event:", e);
    }
  };

  eventSource.onerror = () => {
    console.warn("SSE connection lost, reconnecting...");
    eventSource.close();
  };

  return () => eventSource.close();
}, [runId, status, projectId]);
```

### Passo 3: Garantir checkpoint incremental no agent

```typescript
// src/lib/sites/agent.ts - após cada tool call bem-sucedido

async executeTool(name: string, args: unknown): Promise<unknown> {
  // ... execução do tool
  
  // Salvar checkpoint incremental após write/create/patch
  if (["write", "create", "patch"].includes(name)) {
    await this.saveCheckpoint();
  }
  
  return result;
}
```

### Passo 4: Testar

```powershell
# Terminal 1: Worker
npm run sites:worker

# Terminal 2: Next.js
npm run dev

# Terminal 3: SSE monitor
curl "http://localhost:3000/api/sites/runs/<runId>/activities?stream=true"

# Enviar mensagem no chat e observar:
# 1. SSE recebe evento "file_write"
# 2. UI busca checkpoint
# 3. Árvore atualiza <500ms
```

---

## 5. VALIDAÇÃO E TESTES

### Testes Manuais

1. **Criar site novo:**
   - Prompt: "Crie um site de portfólio com 3 seções"
   - ✅ Arquivos aparecem ao vivo (<500ms cada)
   - ✅ Árvore expande automaticamente
   - ✅ Contador de arquivos atualiza

2. **Editar site existente:**
   - Prompt: "Mude a cor do header para azul"
   - ✅ `patch` detectado via SSE
   - ✅ Editor mostra diff (se aberto)
   - ✅ Preview atualiza

3. **Múltiplos arquivos:**
   - Prompt: "Adicione Header, Footer e Hero components"
   - ✅ 3 eventos `file_create` sequenciais
   - ✅ Árvore atualiza 3x
   - ✅ Ordem correta

### Testes Automatizados

```typescript
// src/lib/sites/__tests__/realtime-files.test.ts

describe("Realtime file updates", () => {
  it("emite activity ao criar arquivo", async () => {
    const mockDb = createMockSupabase();
    const deps = createWebsiteAgentDependencies(mockDb, "worker-1");
    
    await deps.event(mockRun, {
      role: "system",
      content: JSON.stringify({
        tool: "create",
        status: "completed",
        path: "src/App.tsx",
        result: { saved: "src/App.tsx" }
      })
    });

    expect(mockDb.from("website_run_activities").insert).toHaveBeenCalledWith(
      expect.objectContaining({
        run_id: mockRun.id,
        type: "file_create",
        message: "create: src/App.tsx"
      })
    );
  });

  it("UI busca checkpoint ao receber evento SSE", async () => {
    // Simular SSE
    const mockFetch = vi.fn();
    global.fetch = mockFetch;

    const component = render(<SiteFilesPanel runId="run-123" status="editing" />);
    
    // Simular mensagem SSE
    const event = new MessageEvent("message", {
      data: JSON.stringify({
        type: "file_write",
        status: "completed",
        details: { result: { path: "src/App.tsx" } }
      })
    });
    
    window.dispatchEvent(event);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/files?run_id=run-123")
      );
    });
  });
});
```

---

## 6. ROLLBACK E CONTINGÊNCIA

### Se a solução não funcionar:

1. **Reverter mudanças:**
   ```bash
   git checkout src/lib/sites/worker.ts
   git checkout src/components/sites/site-files-panel.tsx
   ```

2. **Fallback: Polling mais agressivo**
   ```typescript
   // Temporário: reduzir intervalo de 3s para 500ms
   useEffect(() => {
     const interval = setInterval(() => {
       fetchCheckpoint();
     }, 500); // ⚠️ Não ideal, mas funciona
     return () => clearInterval(interval);
   }, [runId]);
   ```

### Debugging:

```powershell
# Verificar se activities está recebendo eventos
SELECT * FROM website_run_activities WHERE run_id = 'xxx' ORDER BY created_at DESC;

# Monitorar SSE
curl -N "http://localhost:3000/api/sites/runs/<runId>/activities?stream=true"

# Logs do worker
npm run sites:worker | grep "file_"
```

---

## 7. PRÓXIMAS MELHORIAS (Pós-MVP)

1. **Checkpoint stream completo (Solução B):**
   - Nova rota `/api/sites/runs/[runId]/checkpoint/stream`
   - Emite conteúdo completo via SSE
   - Elimina GET adicional

2. **WebSocket bidirecional:**
   - Substituir SSE por WebSocket
   - Permitir cancelamento mid-run via WS
   - Heartbeat para detectar desconexão

3. **Diff incremental:**
   - Enviar apenas patches (old/new) via SSE
   - Monaco diff editor ao vivo
   - Menos tráfego de rede

4. **Observabilidade completa:**
   - Chain-of-thought em painel separado
   - Highlight de skills ativas
   - Timeline visual de ferramentas

---

## RESUMO EXECUTIVO

**Problema:** Arquivos não aparecem em tempo real (latência 3-5s)  
**Causa:** Eventos salvos no DB, mas UI não escuta via Realtime  
**Solução:** Emitir tool events via `website_run_activities` (SSE já funciona)  
**Esforço:** 2-3 horas implementação + 1 hora testes  
**Resultado esperado:** Latência <500ms, arquivos aparecem ao vivo  
**Riscos:** Baixo (reutiliza infraestrutura existente)
