# Tenant Isolation Matrix

Status: `PASS` mapeado por código (2026-09-01). Coluna "RLS prod" = estado efetivo do banco: `BLOCKED` globalmente (requer introspecção SQL em produção — ação humana).

| Recurso | Chave de tenant | Mecanismo | Estado | Evidência / gap |
|---|---|---|---|---|
| APIs de dados (handlers) | JWT `clientId` via `requireClientId` | `.eq("client_id", …)` | SOUND na maioria | Exceções abaixo |
| Browser direto (anon client) | variável client-side | filtros removíveis + RLS | **BROKEN/UNKNOWN** | SEC-C1; `src/lib/supabase.ts` |
| Realtime | nenhuma | nenhum filtro | **OPEN se RLS off** | `use-realtime.ts:39-45` (SEC-M18) |
| `agent_knowledge` create | body `agent_id` | nada | **BROKEN** | SEC-H4 `knowledge/save/route.ts:28-37` |
| RAG vector RPC | `p_client_id` | filtro na RPC | SOUND | `rag.ts:512-515` |
| RAG fallback ILIKE / topics | só `agent_id` | — | **BROKEN** | `rag.ts:542-550` (SEC-H4) |
| `chat_history_summaries` | nenhuma | — | **BROKEN** | `history-summary.ts:26-31` |
| Webhooks (evo/legacy/cloud) | instance→channel lookup; fallback `DEFAULT_CLIENT_ID` | secret opt-in | **FAIL-OPEN** | SEC-C3 + SEC-M17 |
| `instance_name` | UNIQUE global + adoção | constraint DB | OK, takeover de instância não reclamada | `SETUP_COMPLETO.sql:337` |
| Appointments / calendar tools | credencial do tenant | por agente; sem escopo por contato | PARCIAL | SEC-H7 |
| Sessões | JWT + `auth_sessions` | crypto + revoke parcial | PARCIAL | SEC-H5 (C2 corrigido) |
| Admin plane | `isAdmin` claim + proxy | proxy only | PARCIAL | SEC-M9 |
| Scraper / SSE | nenhuma | singleton global | **BROKEN** | SEC-H8 |
| Campanha/followup/automação envio | instance do DB | sem ownership check | **BROKEN** | SEC-H10 |
| Cache de canal | `instance_name` global | n/a | risco de cruzamento | `channel.ts:29-67` |
| Prod: RLS/grants efetivos | — | — | **BLOCKED** | Introspecção SQL pendente (ação humana) |

Testes A↔B existentes: `agent-tenant-isolation.test.ts` (parcial). Lacuna geral: CRUD A→B por subsistema e teste de RPC/Storage/Realtime — marcados TODO na TEST_MATRIX.
