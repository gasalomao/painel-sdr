# Guia Rápido de Implementação — Sistema de Arquivos em Tempo Real

**Tempo estimado:** 2-3 horas  
**Dificuldade:** Média  
**Pré-requisitos:** Sistema atual funcionando (1607 testes passando)

---

## CHECKLIST DE IMPLEMENTAÇÃO

### ☐ Passo 1: Modificar Worker (30 min)

**Arquivo:** `src/lib/sites/worker.ts`

**Localização:** Linha 71, função `event`

**Mudança:**

```typescript
// ANTES (linha 71-74)
const event: WebsiteAgentDependencies["event"] = async (run, message) => {
  await check(run);
  const { error } = await db.from("website_messages").insert({ 
    client_id: run.client_id, 
    project_id: run.project_id, 
    run_id: run.id, 
    ...message 
  });
  databaseError(error);
};

// DEPOIS
const event: WebsiteAgentDependencies["event"] = async (run, message) => {
  await check(run);
  
  // Salvar em messages (histórico)
  const { error } = await db.from("website_messages").insert({ 
    client_id: run.client_id, 
    project_id: run.project_id, 
    run_id: run.id, 
    ...message 
  });
  databaseError(error);

  // ✅ NOVO: Emitir activity para eventos de tool
  if (message.role === "system") {
    try {
      const content = JSON.parse(String(message.content));
      
      if (content.tool && ["write", "create", "patch", "delete", "rename"].includes(content.tool)) {
        const { error: actError } = await db.from("website_run_activities").insert({
          run_id: run.id,
          type: `file_${content.tool}`,
          message: content.path ? `${content.tool}: ${content.path}` : content.tool,
          status: content.status || "completed",
          details: content,
          duration_ms: content.duration || null,
          created_at: new Date().toISOString()
        });
        
        if (actError) {
          console.error("[worker] Failed to insert activity:", actError);
        }
      }
    } catch (e) {
      // Não é JSON ou não tem tool, ignorar silenciosamente
    }
  }
};
```

**Testar:**
```powershell
npm run sites:worker
# Verificar que inicia sem erros
```

---

### ☐ Passo 2: Modificar UI (45 min)

**Arquivo:** `src/components/sites/site-files-panel.tsx`

**Adicionar no início do componente:**

```typescript
// Importar no topo
import { useEffect, useRef } from "react";

// Dentro do componente SiteFilesPanel
const eventSourceRef = useRef<EventSource | null>(null);

useEffect(() => {
  if (!runId || !["editing", "validating"].includes(status)) {
    // Limpar conexão existente
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    return;
  }

  // Conectar SSE
  const eventSource = new EventSource(
    `/api/sites/runs/${runId}/activities?stream=true`
  );
  eventSourceRef.current = eventSource;

  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      
      // Detectar mudança de arquivo
      if (
        data.type?.startsWith("file_") && 
        data.status === "completed" &&
        data.details?.path
      ) {
        console.log(`[SSE] File ${data.type} detected:`, data.details.path);
        
        // Buscar checkpoint atualizado
        fetch(`/api/sites/${projectId}/files?run_id=${runId}`)
          .then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
          })
          .then(responseData => {
            if (responseData.checkpoint) {
              console.log(`[Checkpoint] Updated with ${Object.keys(responseData.checkpoint.files).length} files`);
              setFiles(responseData.checkpoint.files);
              setVersion(responseData.checkpoint.version);
              
              // Opcional: Highlight do arquivo alterado
              const changedPath = data.details.path;
              if (changedPath) {
                // Adicionar classe CSS temporária
                const element = document.querySelector(`[data-path="${changedPath}"]`);
                if (element) {
                  element.classList.add("highlight-changed");
                  setTimeout(() => {
                    element.classList.remove("highlight-changed");
                  }, 2000);
                }
              }
            }
          })
          .catch(err => {
            console.error("[Checkpoint] Fetch error:", err);
          });
      }
    } catch (e) {
      console.error("[SSE] Parse error:", e);
    }
  };

  eventSource.onerror = (err) => {
    console.warn("[SSE] Connection error, will retry...", err);
    eventSource.close();
    eventSourceRef.current = null;
  };

  return () => {
    console.log("[SSE] Cleaning up connection");
    eventSource.close();
    eventSourceRef.current = null;
  };
}, [runId, status, projectId]);
```

**Adicionar CSS para highlight (no mesmo arquivo ou em CSS global):**

```css
/* Animação de highlight */
@keyframes file-highlight {
  0% { background-color: rgb(59 130 246 / 0.2); }
  100% { background-color: transparent; }
}

.highlight-changed {
  animation: file-highlight 2s ease-out;
}
```

**Testar:**
```powershell
npm run dev
# Abrir site, criar mensagem, ver console logs
```

---

### ☐ Passo 3: Garantir Checkpoint Incremental (30 min)

**Arquivo:** `src/lib/sites/agent.ts`

**Localização:** Classe `WebsiteAgentRuntime`, método que executa tools

**Mudança:**

```typescript
// Procurar onde tools são executados (provavelmente linha ~400-500)
// Adicionar salvamento de checkpoint após cada write/create/patch

private async executeToolSafe(name: string, args: unknown): Promise<unknown> {
  const result = await this.tools.execute(name, args);
  
  // ✅ NOVO: Salvar checkpoint após mudanças de arquivo
  if (["write", "create", "patch"].includes(name) && this.deps.checkpoint) {
    try {
      await this.deps.checkpoint(this.run, {
        files: this.tools.files,
        request: this.currentRequest || undefined,
        notes: this.notes || undefined,
        budgetConsumed: this.budgetConsumed,
        assetIds: this.assetIds,
        designDirection: this.tools.designDirection,
        progress: this.progress,
        qaReport: this.qaReport
      });
      console.log(`[Checkpoint] Saved after ${name}`);
    } catch (err) {
      console.error(`[Checkpoint] Save failed:`, err);
      // Não falhar a operação por erro de checkpoint
    }
  }
  
  return result;
}
```

**Nota:** Se a estrutura for diferente, procurar onde `this.tools.execute(` é chamado e adicionar o checkpoint logo após.

---

### ☐ Passo 4: Testar Manualmente (30 min)

**Cenário 1: Criar site novo**

1. Abrir DevTools → Console
2. Criar novo projeto de site
3. Enviar prompt: "Crie um site simples com header azul"
4. **Verificar:**
   - ✅ Console mostra `[SSE] File file_create detected: src/Header.tsx`
   - ✅ Console mostra `[Checkpoint] Updated with X files`
   - ✅ Árvore de arquivos atualiza em <1 segundo
   - ✅ Arquivo aparece com highlight (fade azul)

**Cenário 2: Editar site existente**

1. Site já criado (mínimo 2 arquivos)
2. Enviar prompt: "Mude a cor do header para vermelho"
3. **Verificar:**
   - ✅ Console mostra `[SSE] File file_patch detected: src/Header.tsx`
   - ✅ Árvore atualiza quase instantaneamente
   - ✅ Preview atualiza (se implementado)

**Cenário 3: Múltiplos arquivos**

1. Enviar prompt: "Adicione Footer, Hero e CTA components"
2. **Verificar:**
   - ✅ 3+ eventos SSE chegam sequencialmente
   - ✅ Árvore atualiza 3+ vezes
   - ✅ Contador de arquivos incrementa: "3 arquivos" → "6 arquivos"

**Cenário 4: Erro/Interrupção**

1. Durante geração, parar worker (`Ctrl+C` no terminal)
2. **Verificar:**
   - ✅ UI mostra erro de conexão SSE
   - ✅ Arquivos parcialmente criados ainda aparecem
   - ✅ Checkpoint salvo até o ponto de falha

---

### ☐ Passo 5: Validação com Testes (20 min)

**Executar suíte de testes:**

```powershell
# Testes unitários
npm test
# Deve passar: 1607 testes

# Testes browser
npm run sites:test-preview
# Deve passar: 36 testes

# TypeScript
npx tsc --noEmit --incremental false
# Deve passar sem erros

# Lint
npm run lint -- src/lib/sites src/components/sites
# Deve passar (avisos OK, erros não)
```

**Se algum teste falhar:**

1. Verificar mensagem de erro
2. Reverter mudança relacionada
3. Testar novamente
4. Ajustar implementação

---

### ☐ Passo 6: Logging e Debug (10 min)

**Adicionar logs estruturados:**

```typescript
// No worker (src/lib/sites/worker.ts)
if (actError) {
  console.error("[worker] Failed to insert activity:", {
    run_id: run.id,
    tool: content.tool,
    path: content.path,
    error: actError.message
  });
}

// Na UI (site-files-panel.tsx)
console.log("[SSE] File updated:", {
  type: data.type,
  path: data.details.path,
  filesCount: Object.keys(responseData.checkpoint.files).length,
  latency: Date.now() - data.timestamp
});
```

**Monitorar em produção:**

```powershell
# Ver logs do worker
npm run sites:worker | grep "file_"

# Ver eventos SSE
curl -N "http://localhost:3000/api/sites/runs/<runId>/activities?stream=true" | grep "file_"
```

---

## DIAGRAMA DE ARQUITETURA

```
┌─────────────────────────────────────────────────────────────────┐
│                           USUÁRIO                                │
│                     (envia "Crie um header")                     │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│                      NEXT.JS API ROUTE                           │
│               POST /api/sites/[projectId]/runs                   │
│                                                                   │
│  1. Cria row em website_runs                                     │
│  2. Enfileira job em BullMQ                                      │
│  3. Retorna { run_id: "xxx" }                                    │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ↓
┌─────────────────────────────────────────────────────────────────┐
│                      WORKER (BullMQ)                             │
│                   src/lib/sites/worker.ts                        │
│                                                                   │
│  1. Carrega checkpoint                                           │
│  2. Inicia WebsiteAgentRuntime                                   │
│  3. Loop de chat com IA                                          │
│     ├─ IA responde com tool_calls                               │
│     ├─ Execute tool: tools.execute("write", {...})              │
│     │   └─ workspace["src/Header.tsx"] = content                │
│     │                                                             │
│     ├─ ✅ Emite evento:                                          │
│     │   INSERT INTO website_messages                            │
│     │   { role: "system", content: '{"tool":"write",...}' }    │
│     │                                                             │
│     └─ ✅ NOVO: Emite activity:                                  │
│         INSERT INTO website_run_activities                       │
│         { type: "file_write", message: "write: src/Header.tsx" }│
│                                                                   │
│  4. ✅ Salva checkpoint incremental:                             │
│     UPDATE website_runs SET checkpoint = {...}                   │
│                                                                   │
│  5. Repete até conclusão                                         │
└────────────────┬───────────────────────────┬────────────────────┘
                 │                           │
                 │                           │ (Realtime trigger)
                 │                           ↓
                 │              ┌────────────────────────────┐
                 │              │   SUPABASE REALTIME        │
                 │              │                            │
                 │              │   Detecta INSERT em        │
                 │              │   website_run_activities   │
                 │              │                            │
                 │              │   Publica evento via SSE   │
                 │              └──────────┬─────────────────┘
                 │                         │
                 │                         │
                 ↓                         ↓
┌────────────────────────────┐  ┌──────────────────────────────┐
│  GET /files?run_id=X       │  │  GET /activities?stream=true │
│                            │  │                              │
│  Retorna checkpoint:       │  │  Server-Sent Events:         │
│  {                         │  │  data: {"type":"file_write", │
│    version: "abc123",      │  │         "path":"Header.tsx"} │
│    files: {                │  │                              │
│      "src/Header.tsx": ... │  │  ✅ Conexão persistente      │
│    }                       │  │  ✅ Push automático          │
│  }                         │  │  ✅ <100ms latência          │
└────────────┬───────────────┘  └───────────┬──────────────────┘
             │                              │
             │                              │
             └──────────────┬───────────────┘
                            │
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│                    UI REACT COMPONENT                            │
│              src/components/sites/site-files-panel.tsx           │
│                                                                   │
│  useEffect(() => {                                               │
│    const eventSource = new EventSource("/activities?stream=true");│
│                                                                   │
│    eventSource.onmessage = (event) => {                         │
│      const data = JSON.parse(event.data);                       │
│                                                                   │
│      if (data.type === "file_write") {                          │
│        // ✅ Evento recebido (<100ms)                            │
│                                                                   │
│        fetch("/files?run_id=X")                                 │
│          .then(res => res.json())                               │
│          .then(data => {                                        │
│            setFiles(data.checkpoint.files);                     │
│            // ✅ Árvore atualiza (<500ms total)                  │
│          });                                                     │
│      }                                                           │
│    };                                                            │
│  }, [runId]);                                                    │
│                                                                   │
│  return (                                                        │
│    <Tree files={files} />                                       │
│  );                                                              │
└─────────────────────────────────────────────────────────────────┘
```

**Fluxo de Dados:**

1. User → Next.js: POST run
2. Next.js → BullMQ: Enfileira job
3. Worker → IA: Chat loop
4. IA → Worker: Tool calls
5. Worker → DB: INSERT activity ✅
6. Supabase → SSE: Realtime push ✅
7. SSE → UI: Event notification ✅
8. UI → Next.js: GET checkpoint ✅
9. Next.js → UI: Checkpoint data
10. UI: Render updated tree ✅

**Latência Total:** ~200-500ms (vs 3-5 segundos antes)

---

## TROUBLESHOOTING

### Problema: SSE não conecta

**Sintomas:**
- Console não mostra `[SSE] File ... detected`
- `eventSource.readyState === 2` (CLOSED)

**Soluções:**
1. Verificar rota `/api/sites/runs/[runId]/activities/route.ts` existe
2. Verificar auth: `GET /activities` requer login
3. Verificar Supabase Realtime está habilitado:
   - Supabase Dashboard → Settings → API → Realtime: ON
4. Testar manualmente:
   ```bash
   curl -N "http://localhost:3000/api/sites/runs/<runId>/activities?stream=true" \
     -H "Cookie: ..." # copiar do browser
   ```

### Problema: Eventos chegam mas checkpoint não atualiza

**Sintomas:**
- Console mostra `[SSE] File file_write detected`
- Console mostra erro `[Checkpoint] Fetch error: 404`

**Soluções:**
1. Verificar `saveRunCheckpoint()` foi chamado no worker
2. Verificar `GET /files?run_id=X` retorna checkpoint:
   ```bash
   curl "http://localhost:3000/api/sites/<projectId>/files?run_id=<runId>"
   ```
3. Verificar `checkpoint` não é `null` na resposta
4. Adicionar log no worker:
   ```typescript
   await saveRunCheckpoint(db, run, checkpoint, check);
   console.log(`[Worker] Checkpoint saved: ${Object.keys(checkpoint.files).length} files`);
   ```

### Problema: Latência alta (>2s)

**Sintomas:**
- Arquivos aparecem, mas lentamente
- `latency` no log >2000ms

**Soluções:**
1. Verificar network waterfall no DevTools (F12 → Network)
2. Verificar se checkpoint está muito grande (>1MB):
   ```typescript
   const size = new TextEncoder().encode(JSON.stringify(checkpoint)).length;
   console.log(`[Checkpoint] Size: ${(size / 1024).toFixed(2)} KB`);
   ```
3. Se >1MB, otimizar:
   - Enviar apenas `changedPaths` em vez de todos os arquivos
   - Comprimir checkpoint com gzip
4. Verificar se DB está respondendo rápido:
   ```sql
   EXPLAIN ANALYZE 
   SELECT checkpoint FROM website_runs WHERE id = 'xxx';
   ```

### Problema: UI não re-renderiza

**Sintomas:**
- `setFiles()` é chamado (vê no log)
- Árvore não atualiza visualmente

**Soluções:**
1. Verificar `files` tem referência nova:
   ```typescript
   setFiles({ ...responseData.checkpoint.files }); // ✅ Novo objeto
   // vs
   setFiles(responseData.checkpoint.files); // ❌ Mesma referência
   ```
2. Verificar `React.memo` ou `useMemo` não está bloqueando:
   ```typescript
   const Tree = React.memo(TreeComponent); // ⚠️ Pode causar problema
   ```
3. Adicionar `key` forçando re-render:
   ```tsx
   <Tree key={version} files={files} />
   ```

---

## ROLLBACK

Se algo der muito errado:

```bash
# Reverter worker
git checkout src/lib/sites/worker.ts

# Reverter UI
git checkout src/components/sites/site-files-panel.tsx

# Verificar testes
npm test
npm run sites:test-preview
```

**Fallback temporário:** Reduzir intervalo de polling:

```typescript
// Em site-files-panel.tsx
useEffect(() => {
  const interval = setInterval(() => {
    fetchCheckpoint();
  }, 500); // 500ms (antes: 3000ms)
  return () => clearInterval(interval);
}, [runId]);
```

---

## MÉTRICAS DE SUCESSO

**Antes:**
- 🐌 Latência: 3-5 segundos
- 📊 Taxa de atualização: 100% (mas lenta)
- 🔍 Debug: Difícil (sem logs)

**Depois:**
- ⚡ Latência: <500ms (P95)
- 📊 Taxa de atualização: 100% (instantânea)
- 🔍 Debug: Fácil (logs estruturados)

**Validação:**

```typescript
// Adicionar métrica
const startTime = Date.now();
eventSource.onmessage = (event) => {
  const latency = Date.now() - JSON.parse(event.data).timestamp;
  console.log(`[Metric] SSE latency: ${latency}ms`);
  
  // Track
  if (latency > 500) {
    console.warn(`[Alert] High latency detected: ${latency}ms`);
  }
};
```

---

## PRÓXIMOS PASSOS

Após implementar arquivo em tempo real:

1. ✅ **Observabilidade:** Thinking panel, skills badge (ver `OBSERVABILITY_DESIGN.md`)
2. ✅ **Diff visual:** Monaco editor com diff side-by-side
3. ✅ **Continuidade:** Protocolo entre modelos (ver `PROJECT_STATE.md`)
4. 🔲 **Otimização:** Checkpoint incremental com diff (apenas mudanças)
5. 🔲 **WebSocket:** Substituir SSE por WS bidirecional
6. 🔲 **Polish:** Animações, transições, UX refinado

**Documentação completa:** Ver `docs/` para detalhes técnicos.

---

## CONTATOS E SUPORTE

- **Projeto:** painel-sdr (Vidrão Site Studio)
- **Docs:** `docs/REALTIME_FILES_*.md`
- **State:** `PROJECT_STATE.md`
- **Testes:** 1607 unit + 36 browser
- **Coverage:** 84% linhas, 85% branches

**Última atualização:** 2026-10-09
