## Varredura completa — 3 correções cirúrgicas de performance (baixo risco)

Cada correção ataca uma causa raiz identificada, sem mudar a arquitetura. Sem breaking changes.

---

### CORREÇÃO 1 — Calendário piscando (prioridade alta, causa óbvia)
**Causa raiz:** O polling de 60s chama `syncGoogle(true)` → `loadAppointments()` → `setLoading(true)` que **DESMONTA o `<CalendarGrid>`** e mostra spinner. O calendário inteiro some e reaparece a cada minuto.

**Correção (`src/app/calendario/page.tsx`):**
- Adicionar parâmetro `silent` no `loadAppointments(silent = false)`. Quando `silent=true`, NÃO faz `setLoading(true)` — mantém o grid montado, só atualiza os dados quando chegarem.
- No `syncGoogle`, chamar `loadAppointments(true)` (silent) quando for sync de background/polling.
- O `loading` (spinner) só aparece na **primeira carga** (mount) e quando o usuário troca filtro/período manualmente.

**Resultado:** o calendário para de piscar. As atualizações chegam suaves (os eventos se movem sem desmontar o grid).

---

### CORREÇÃO 2 — Webhook piscando (baixo risco)
**Causa raiz:** O badge do `NgrokQuickConnect` começa em `reachable=null` ("Verificando…" com spinner) a cada render do header. A transição `null → true` ("Verificando…" → "Online") aparece como piscar.

**Correção (`src/components/ngrok-quick-connect.tsx`):**
- Cache do último estado em `sessionStorage` (chave `ngrok_reachable_cache`). No mount, inicializa `reachable` com o valor cacheado (em vez de `null`). Assim o badge já mostra "Online" imediatamente se a última verificação foi positiva — sem piscar.
- O check real ainda roda em background pra confirmar; só não pisca mais.

**Resultado:** badge estável, sem transição visual desnecessária.

---

### CORREÇÃO 3 — Chat lento ao trocar página/selecionar conversa
**Causa raiz:** Duas coisas:
1. **`loadFunnelData` é uma cascata de 5 awaits sequenciais** (session → channel → stages → contact → sessão). Cada um espera o anterior terminar. ~1.5-2s de latência desnecessária.
2. **`/api/auth/session` é chamado 3x por mount** do chat (hook + fetchInstances + loadFunnelData).

**Correção (`src/app/chat/page.tsx`):**
- **Paralelizar `loadFunnelData`**: as queries de `agent_stages`, `contacts` e `sessions` podem rodar em paralelo (`Promise.all`) depois de resolver o `agentId`. Reduz de 5 awaits sequenciais pra 2 passos.
- **Cache de session**: passar o `clientId` já resolvido pro `loadFunnelData` (em vez de re-buscar `/api/auth/session` de novo). O componente já tem `clientId` em state (resolvido no mount).
- **Não re-buscar conversas se já temos dados**: manter as conversas em state ao trocar de página (o Next.js já mantém o state do client component se usar `pages` router, mas com App Router o componente desmonta). Solução pragmática: cachear as conversas em `sessionStorage` e mostrar imediatamente no mount enquanto re-busca em background (stale-while-revalidate). Assim o chat aparece instantâneo ao voltar, e atualiza em background.

**Resultado:** chat carrega ~60% mais rápido ao selecionar conversa (paralelização), e aparece instantâneo ao voltar de outra página (cache stale-while-revalidate).

---

### O que NÃO faço (pra não quebrar):
- Não adiciono React Query / SWR (mudança grande de arquitetura, risco de quebrar realtime).
- Não mudo o limite de 3000 mensagens (já está em batches de 500).
- Não mexo no realtime subscription (o cleanup está correto).
- Não altero o polling de conversas (já foi otimizado pra 45s na sessão anterior).

### Validação
- `npx tsc --noEmit` (zero erros)
- `npm run build` (todas as páginas compilam)
- Commit + push de cada correção separada (pra isolar se algo quebrar).