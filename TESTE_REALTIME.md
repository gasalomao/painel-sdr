# TESTE DE ARQUIVOS EM TEMPO REAL

## ✅ IMPLEMENTAÇÃO CONCLUÍDA

**Data:** 2026-10-09  
**Tempo:** ~30 minutos  
**Status:** Código implementado, aguardando teste manual

---

## MUDANÇAS REALIZADAS

### 1. Worker (`src/lib/sites/worker.ts` - Linha 71)
✅ Modificado para emitir `website_run_activities` após cada tool call
- Detecta tools: write, create, patch, delete, rename
- Insere registro com tipo, mensagem, status, details
- Log de erro se falhar (não bloqueia execução)

### 2. Agent (`src/lib/sites/agent.ts`)
✅ Salvamento de checkpoint incremental adicionado em 2 locais:
- **Linha ~516:** Após tool calls regulares (write, create, patch)
- **Linha ~562:** Após edits extraídos de code blocks
- Console.log para debugging
- Não falha operação se checkpoint falhar

### 3. UI (`src/app/sites/[projectId]/page.tsx` - Linha 188)
✅ Listener SSE adicionado:
- Conecta EventSource para `/runs/${runId}/activities?stream=true`
- Detecta eventos `file_*` com status completed
- Busca checkpoint atualizado via `GET /files?run_id=...`
- Atualiza `checkpointPreview` automaticamente
- Console.logs para debugging
- Cleanup ao desmontar componente

---

## COMO TESTAR

### Pré-requisitos
1. Worker rodando: `npm run sites:worker`
2. Dev server rodando: `npm run dev`
3. DevTools aberto (F12) → Console

### Teste 1: Criar Site Novo

1. Abrir http://localhost:3000/sites
2. Criar novo projeto: "Site Teste Realtime"
3. Abrir projeto
4. **Abrir DevTools Console (F12)**
5. Enviar prompt: "Crie um site simples com header azul e footer cinza"

**Esperar ver:**
```
[SSE] File file_create detected: src/Header.tsx
[Checkpoint] Updated with 2 files
[SSE] File file_create detected: src/Footer.tsx
[Checkpoint] Updated with 3 files
[SSE] File file_write detected: src/App.tsx
[Checkpoint] Updated with 3 files
```

**Verificar:**
- ✅ Arquivos aparecem na árvore em <500ms cada
- ✅ Preview atualiza automaticamente
- ✅ Contador "3 arquivos" incrementa corretamente

### Teste 2: Editar Site Existente

1. Mesmo projeto do teste anterior
2. Enviar prompt: "Mude a cor do header para vermelho"
3. **Verificar Console:**

```
[SSE] File file_patch detected: src/Header.tsx
[Checkpoint] Updated with 3 files
```

**Verificar:**
- ✅ Mudança aparece instantaneamente
- ✅ Preview mostra header vermelho

### Teste 3: Múltiplos Arquivos

1. Enviar prompt: "Adicione Hero, Features e CTA components"
2. **Verificar Console:**

```
[SSE] File file_create detected: src/Hero.tsx
[Checkpoint] Updated with 4 files
[SSE] File file_create detected: src/Features.tsx
[Checkpoint] Updated with 5 files
[SSE] File file_create detected: src/CTA.tsx
[Checkpoint] Updated with 6 files
[SSE] File file_patch detected: src/App.tsx
[Checkpoint] Updated with 6 files
```

**Verificar:**
- ✅ 3+ eventos SSE chegam sequencialmente
- ✅ Árvore atualiza 3+ vezes
- ✅ Latência <500ms por arquivo

### Teste 4: Tab "Arquivos ao Vivo"

1. Durante geração, clicar na tab "Arquivos ao Vivo"
2. **Verificar:**
- ✅ Contador atualiza em tempo real: "Gerando... 3 de ? arquivos"
- ✅ Lista de arquivos cresce dinamicamente
- ✅ Ícone animado enquanto gera

---

## DEBUGGING

### SSE não conecta

**Sintomas:** Nenhum log `[SSE]` no console

**Verificar:**
1. URL correta: `/api/sites/runs/${runId}/activities?stream=true`
2. Auth funcionando (cookie válido)
3. Supabase Realtime habilitado:
   - Dashboard → Settings → API → Realtime: ON
4. Tentar manual:
   ```bash
   curl -N "http://localhost:3000/api/sites/runs/<runId>/activities?stream=true" -H "Cookie: ..."
   ```

### Eventos chegam mas checkpoint não atualiza

**Sintomas:** Logs `[SSE]` aparecem, mas `[Checkpoint]` não

**Verificar:**
1. Worker salvando checkpoint? Ver logs worker:
   ```
   [Checkpoint] Saved after write
   ```
2. Endpoint `/files?run_id=X` retorna checkpoint?
   ```bash
   curl "http://localhost:3000/api/sites/<projectId>/files?run_id=<runId>"
   ```
3. Adicionar breakpoint em `page.tsx` linha ~210

### Latência alta (>2s)

**Sintomas:** Arquivos aparecem, mas lentamente

**Verificar:**
1. Network waterfall no DevTools
2. Tamanho do checkpoint:
   - Worker log: checkpoint size
   - Se >1MB, otimizar depois
3. DB performance (queries lentas?)

### UI não re-renderiza

**Sintomas:** `setCheckpointPreview` chamado, mas árvore não atualiza

**Verificar:**
1. Estado sendo atualizado? React DevTools
2. Adicionar log no componente:
   ```tsx
   useEffect(() => {
     console.log('[FilesTree] Checkpoint updated:', checkpointPreview?.files);
   }, [checkpointPreview]);
   ```
3. Forçar re-render com key:
   ```tsx
   <FilesTree key={checkpointPreview?.version} ... />
   ```

---

## MÉTRICAS ESPERADAS

| Métrica | Alvo | Como medir |
|---------|------|------------|
| Latência SSE | <100ms | `eventTimestamp` - `data.timestamp` |
| Latência total | <500ms | `Date.now()` - `event.timestamp` |
| Taxa de sucesso | 100% | Todos arquivos aparecem |
| Uptime SSE | >99% | Conexão não cai durante geração |

---

## PRÓXIMOS PASSOS (Após confirmar funcionando)

1. ✅ Remover console.logs (ou manter só erros)
2. ✅ Adicionar métricas estruturadas
3. ✅ Implementar Fase 2: Thinking panel, Skills badge
4. ✅ Implementar Fase 3: Code diff viewer
5. ✅ Otimizar: Checkpoint diff (apenas mudanças)
6. ✅ Otimizar: WebSocket bidirecional

---

## ROLLBACK (Se algo quebrar)

```bash
# Reverter worker
git checkout src/lib/sites/worker.ts

# Reverter agent
git checkout src/lib/sites/agent.ts

# Reverter UI
git checkout src/app/sites/[projectId]/page.tsx

# Testar
npm test
npm run sites:test-preview
```

---

## STATUS FINAL

**Código:** ✅ Implementado  
**Compilação:** ✅ Limpo (só warnings antigas)  
**Testes automáticos:** ⏳ Aguardando  
**Teste manual:** ⏳ Aguardando  

**Estimativa de sucesso:** 95%  
**Próximo passo:** Rodar worker + dev server e testar manualmente
