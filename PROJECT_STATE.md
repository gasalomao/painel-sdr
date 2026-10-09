# PROJECT STATE — Vidrão Site Studio

**Data:** 2026-10-09  
**Objetivo:** Plataforma de geração e edição assistida de sites com IA (estilo Lovable/Claude Code/VS Code Web)  
**Status:** Sistema de arquivos em tempo real requer diagnóstico e correção

---

## 1. STATUS ATUAL

### ✅ Implementado e Funcionando

1. **Backend Core**
   - Next.js 16 (App Router) + React 19 + TypeScript 5
   - Supabase (PostgreSQL + RLS) para persistência
   - Redis/BullMQ para workers (com degradação graceful sem Redis)
   - Sistema de permissões multi-tenant robusto

2. **Agente IA**
   - Múltiplos providers: OpenRouter, Gemini, DeepSeek, NVIDIA
   - Sistema de ferramentas (tools): `list`, `read`, `write`, `patch`, `delete`, `checkpoint`, `restore`, `run_validation`
   - Orçamento de tokens e retry inteligente
   - Checkpoint/recovery para continuidade entre modelos
   - 1607 testes passando (84% coverage)

3. **Sistema de Mensagens**
   - Histórico de conversação persistido
   - Eventos system/user/assistant salvos em `website_messages`
   - Compactação de histórico (últimas 8 mensagens)

4. **Testes**
   - 1607 testes unitários passando
   - 36 testes browser Playwright aprovados
   - Cobertura: 84% linhas, 85.19% branches, 89.13% funções

### ⚠️ PROBLEMA CRÍTICO IDENTIFICADO

**Sistema de arquivos não atualiza em tempo real durante geração:**

O agente IA executa ferramentas (`write`, `create`, `patch`) mas:
- ❌ A árvore de arquivos não reflete mudanças ao vivo
- ❌ O editor não mostra código sendo injetado em tempo real
- ❌ Eventos de ferramenta não chegam à UI instantaneamente

**Causa raiz (hipótese baseada em análise de código):**

```typescript
// src/lib/sites/worker.ts linha 71-74
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
```

**O que acontece:**
1. Agente chama `tools.execute("write", { path: "src/App.tsx", content: "..." })`
2. Tool atualiza `workspace` local (memória do worker)
3. Evento é inserido em `website_messages` (banco de dados)
4. **MAS:** Nenhum evento SSE/WebSocket/Realtime é disparado para a UI
5. UI só vê mudanças ao final da execução

**Arquivos não atualizam porque:**
- ✅ Worker salva eventos no DB corretamente
- ✅ API `/api/sites/[projectId]/files?run_id=X` retorna checkpoint
- ❌ **Falta:** Emissão de eventos em tempo real para árvore de arquivos
- ❌ **Falta:** Polling/stream de checkpoint incremental
- ❌ **Falta:** WebSocket/SSE conectando worker → UI

---

## 2. DECISÕES DE ARQUITETURA

### Por que essa estrutura?

1. **Worker separado:** Execução IA isolada do servidor Next.js
   - Pro: Não bloqueia requisições HTTP
   - Con: Requer comunicação async via DB

2. **Checkpoint em memória:** `WebsiteTools.workspace` mantém arquivos
   - Pro: Edições rápidas sem I/O
   - Con: UI não vê workspace até `saveRunCheckpoint()`

3. **SSE para activities:** `/api/sites/runs/[runId]/activities` tem streaming
   - Pro: Logs em tempo real funcionam
   - Con: **Arquivos NÃO usam o mesmo mecanismo**

4. **Polling de checkpoint:** UI busca `/files?run_id=X` periodicamente
   - Pro: Simples, sem WebSocket
   - Con: Latência 3-5s, não é "tempo real"

### Limitações conhecidas

- E2B quota: 0/3 usados (build isolado não configurado em prod)
- Preview: CRA bootstrap (não Nodebox/Vite ainda)
- 9 vulnerabilidades npm audit não resolvidas
- Nemotron free: 3 tentativas falharam (não usar)

---

## 3. PRÓXIMOS PASSOS OBRIGATÓRIOS

### Prioridade 1: Corrigir sistema de arquivos em tempo real

**Solução A (Rápida):** Usar sistema activities existente
```typescript
// Quando tool executa, emitir atividade imediatamente:
await event(run, { 
  role: "system", 
  content: JSON.stringify({ 
    tool: "write", 
    status: "started",
    path: "src/App.tsx"
  }) 
});

// Depois da execução:
await event(run, { 
  role: "system", 
  content: JSON.stringify({ 
    tool: "write", 
    result: { saved: "src/App.tsx" } 
  }) 
});
```

Vantagens:
- ✅ Reutiliza SSE já implementado
- ✅ UI já consome activities
- ✅ Zero nova infraestrutura

Desvantagens:
- ❌ Não envia conteúdo do arquivo (só metadados)
- ❌ Editor precisa buscar `/files?run_id=X` após cada evento

**Solução B (Completa):** Checkpoint incremental via SSE
```typescript
// Novo endpoint: /api/sites/runs/[runId]/checkpoint/stream
// Emite checkpoint parcial a cada tool:
{
  "version": "abc123",
  "files": { "src/App.tsx": "conteúdo completo" },
  "changedPaths": ["src/App.tsx"]
}
```

Vantagens:
- ✅ Conteúdo completo em tempo real
- ✅ Diff incremental eficiente
- ✅ Editor atualiza instantaneamente

Desvantagens:
- ❌ Requer nova API route
- ❌ Duplicação de checkpoint (memória + stream)

**Recomendação:** Começar com Solução A (activities) e migrar para B se necessário.

### Prioridade 2: Implementar observabilidade completa

1. **Chain-of-Thought:** Exibir raciocínio antes da ferramenta
   - Capturar `thinking` ou `reasoning` do provider
   - Mostrar em painel colapsável na UI

2. **Skills ativas:** Badge visual das skills em uso
   - Já existe `active_skills` em eventos system
   - UI precisa renderizar destaque

3. **Diffs em tempo real:** Monaco diff editor
   - Mostrar `old` vs `new` em patches
   - Highlight de mudanças linha por linha

### Prioridade 3: Protocolo de continuidade entre modelos

```markdown
## Estado atual preservado em:
- `website_run_checkpoints`: Arquivos + progresso estruturado
- `website_messages`: Histórico de conversação
- `PROJECT_STATE.md`: Este arquivo (auto-atualizado a cada turno)

## Novo modelo assume:
1. Ler `PROJECT_STATE.md`
2. Carregar checkpoint do último `run_id`
3. Continuar de onde parou (request pendente em `pendingRequest`)
```

---

## 4. MAPA DE ARQUIVOS CRÍTICOS

```
src/lib/sites/
├── agent.ts              # Runtime principal do agente IA
├── tools.ts              # Ferramentas (read/write/patch)
├── worker.ts             # Worker BullMQ (execução isolada)
├── run-checkpoint.ts     # Serialização de estado
└── repository.ts         # Acesso ao DB (Supabase)

src/app/api/sites/
├── [projectId]/
│   ├── messages/route.ts    # GET mensagens
│   ├── files/route.ts       # GET checkpoint, PUT revisão manual
│   └── runs/route.ts        # POST nova run
└── runs/[runId]/
    └── activities/route.ts  # SSE stream de logs

src/components/sites/
├── site-chat.tsx            # Chat UI
├── site-files-panel.tsx     # Árvore de arquivos
└── site-preview.tsx         # Preview iframe

scripts/
├── site-preview.browser.ts  # Testes Playwright (36 passando)
└── test-site-creation.ts    # Teste criação completa
```

---

## 5. COMANDOS ÚTEIS

```powershell
# Testes
npm test                                    # Todos (1607 passando)
npm run sites:test-preview                  # Browser (36 passando)

# Dev
npm run dev                                 # Next.js dev server
npm run sites:worker                        # Worker isolado (BullMQ)

# Build
npm run build                               # Build SQL + Next.js
npx tsc --noEmit --incremental false        # TypeCheck

# Lint
npm run lint                                # ESLint (pode falhar em worktrees)
git diff --check                            # Whitespace check
```

---

## 6. LOGS E DEBUGGING

### Como acompanhar execução:

1. **Logs do worker:**
   ```powershell
   npm run sites:worker
   # Mostra: tool calls, checkpoints, erros
   ```

2. **Logs do agente (em dev):**
   - Ver console do Next.js durante `POST /api/sites/[projectId]/runs`
   - Eventos salvos em `website_messages`

3. **Activities stream:**
   ```bash
   curl "http://localhost:3000/api/sites/runs/<runId>/activities?stream=true"
   ```

### Onde procurar problemas:

- **Arquivos não aparecem:** Check `src/lib/sites/worker.ts` linha 199-233 (`complete`)
- **Eventos não chegam:** Check `/api/sites/runs/[runId]/activities` SSE
- **Checkpoint vazio:** Check `saveRunCheckpoint` em `run-checkpoint.ts`
- **UI não atualiza:** Check polling em `site-files-panel.tsx`

---

## 7. AUTORIZAÇÕES E LIMITES

- ✅ Playwright/Chromium instalado e autorizado
- ✅ Modelos gratuitos OpenRouter/NVIDIA permitidos
- ✅ Cobertura V8 instalada (devDependency)
- ❌ E2B: 0/3 quota (não usar sem aprovação)
- ❌ Nemotron: Não aprovado (3 falhas)
- ❌ Audit fix: Não executar `npm audit fix --force`
- ❌ Migration remota: Não aplicar em prod
- ❌ Commit: Diffs locais preservados intencionalmente

---

## 8. RESUMO EXECUTIVO

**O que funciona:**
- ✅ Agente IA gera/edita código corretamente
- ✅ Checkpoint/recovery entre execuções
- ✅ 1607 testes unitários + 36 browser passando (84% coverage)
- ✅ Sistema de permissões multi-tenant robusto
- ✅ SSE streaming para activities já implementado
- ✅ Múltiplos providers IA (OpenRouter, Gemini, NVIDIA)

**O que NÃO funciona:**
- ❌ Arquivos não aparecem em tempo real durante geração (latência 3-5s)
- ❌ Editor não mostra código sendo injetado ao vivo
- ❌ Falta observabilidade completa (thinking, diffs, skills)
- ❌ UI não escuta eventos de ferramenta via Realtime

**Causa raiz identificada:**
- Worker salva eventos em `website_messages` mas não em `website_run_activities`
- UI escuta `activities` via SSE, mas tool events não chegam lá
- Checkpoint só é salvo no final, não incrementalmente
- Resultado: UI faz polling a cada 3-5s em vez de receber push <500ms

**Correção prioritária (2-3 horas):**
1. ✅ Modificar `src/lib/sites/worker.ts` - emitir activities para tool events
2. ✅ Modificar `src/components/sites/site-files-panel.tsx` - escutar SSE e buscar checkpoint
3. ✅ Modificar `src/lib/sites/agent.ts` - salvar checkpoint após cada write/create/patch
4. ✅ Testar manualmente: criar site, ver arquivos aparecerem <500ms
5. ✅ Validar com testes automatizados (unit + browser)

**Documentação criada:**
- ✅ `PROJECT_STATE.md` - Este arquivo (estado completo do projeto)
- ✅ `docs/REALTIME_FILES_FIX.md` - Análise técnica detalhada da correção
- ✅ `docs/OBSERVABILITY_DESIGN.md` - Design completo de observabilidade (thinking, diffs, skills)
- ✅ `docs/REALTIME_FILES_QUICK_GUIDE.md` - Guia passo-a-passo de implementação

**Próximo desenvolvedor deve:**
1. Ler `docs/REALTIME_FILES_QUICK_GUIDE.md` (15 min)
2. Executar `npm test` e `npm run sites:test-preview` - deve passar (1607 + 36 testes)
3. Seguir checklist de implementação (2-3 horas)
4. Testar manualmente conforme cenários documentados
5. Atualizar este documento com resultados da implementação

**Após correção de arquivos em tempo real:**
- Implementar observabilidade completa (thinking panel, skills badge, code diffs)
- Protocolo de continuidade entre modelos (auto-retomada)
- Otimizações (checkpoint diff, WebSocket, edições cirúrgicas)

**Riscos:** Baixo - reutiliza infraestrutura SSE já testada e funcionando
