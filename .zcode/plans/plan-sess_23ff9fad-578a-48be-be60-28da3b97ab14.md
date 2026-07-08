## Diagnóstico completo do Organizador IA

### Como funciona hoje (confirmado)
A IA **se adapta a kanbans customizados** via um apêndice dinâmico no prompt que lista as colunas reais do cliente (`status_key`, `label`, `order_index`). A IA é instruída a usar SÓ essas colunas. Então a IA em si está correta.

### Os 6 pontos hardcoded que LIMITAM a inteligência
Quando o kanban tem nomes diferentes do padrão B2B (ex: "arquivado" em vez de "sem_interesse", "fechado_negocio" em vez de "fechado"), estes pontos falham:

1. **`route.ts:287`** — detecção de terminal por regex fixa `/sem_interesse|descartado|perdido|.../`. Coluna "arquivado" = não detectada como terminal.
2. **`route.ts:341`** — filtro de economia sempre inclui `"sem_interesse","descartado","fechado"` mesmo se não existem no kanban.
3. **`route.ts:391-409`** — heurística R1/R2 grava status fixos `"sem_interesse"`/`"descartado"` (não existem no kanban custom → decisão descartada pela validação).
4. **`route.ts:475-498`** — flags de contexto checam literalmente `"fechado"`, `"agendado"`, `"follow-up"`.
5. **`route.ts:716-719`** — validação sempre aceita `"sem_interesse"` e `"descartado"` mesmo que não existam no kanban.
6. **`route.ts:739-740`** — detecção de estágio avançado usa regex de nomes fixos.

### Solução: campo `is_terminal` no kanban + lógica 100% dinâmica

**1. Migration — adicionar `is_terminal` em `kanban_columns`**
```sql
ALTER TABLE kanban_columns ADD COLUMN IF NOT EXISTS is_terminal boolean DEFAULT false;
```
- O usuário marca quais colunas são "finais" (sem volta) na UI do organizador.
- Default: colunas com nome que casa o regex atual são marcadas automaticamente.

**2. `route.ts` — usar `is_terminal` em vez de regex**
- `terminalSet` = `kanbanCols.filter(c => c.is_terminal).map(c => c.status_key)` (linha 288).
- Heurística R1/R2 (391-409): usar o primeiro terminal do kanban (em vez de "sem_interesse" fixo).
- Validação (716-719): aceitar SÓ status_keys do kanban (não forçar "sem_interesse"/"descartado").
- Flags de contexto (475-498): detectar estágios por posição no kanban (top 30%) em vez de nome.
- Detecção avançada (739-740): já tem a parte de 60% (adaptativa) — priorizar ela.

**3. `organizer-prompt.ts` — apêndice mostra `is_terminal`**
- No apêndice do kanban, marcar colunas terminais com `[TERMINAL]` pra IA saber.

**4. UI do organizador (`organizador/page.tsx`)**
- Adicionar toggle "Coluna final (sem volta)" em cada coluna do editor de kanban.
- Salvar via PATCH em `/api/kanban-columns`.

**5. API kanban-columns** — aceitar `is_terminal` no POST/PATCH.

### O que NÃO mudo (pra não quebrar)
- Não altero as 17 regras (R1-R17) do prompt base — elas já usam "ou equivalente do kanban".
- Não mudo o scheduler (5 min) nem o cache (60s).
- Não mudo o formato da resposta da IA (JSON array).
- Não mudo a tabela `leads_extraidos` (status continua texto livre).
- Não mudo o drag-and-drop do kanban de leads.

### Validação
- `npx tsc --noEmit` + `npm run build`.
- Teste: criar kanban com colunas "novo → quente → negociando → ganho [TERMINAL] → perdido [TERMINAL]" → confirmar que a IA move corretamente e que terminais são respeitados.
- Commit + push.

### Resultado
O Organizador IA vai funcionar perfeitamente com **QUALQUER kanban** — a IA entende as colunas customizadas, sabe quais são terminais (marcados pelo usuário), respeita a hierarquia (ordem), e não rebaixa leads em estágios avançados. Tudo 100% adaptativo, sem hardcoding de nomes B2B.