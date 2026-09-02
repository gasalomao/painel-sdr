# Blockers

| ID | Bloqueio | Impacto | Como desbloquear | Status |
|---|---|---|---|---|
| BLK-001 | Estado real de RLS/grants/triggers/buckets no Supabase implantado não introspectado | Isolamento de produção não comprovado | Acesso autorizado a staging/produção somente leitura | BLOCKED |
| BLK-002 | SHA/imagem ativa no EasyPanel não exposta por endpoint | Deploy exato não comprovado | Evidência do painel ou metadata de build segura | BLOCKED |
| BLK-003 | Flags/credenciais live de OpenRouter ausentes/não confirmadas | Matriz live não executável | `RUN_LIVE_AI_TESTS=1` e chave no processo | BLOCKED |
| BLK-004 | Instância/número Evolution exclusivos de teste não confirmados | Live channel bloqueado | Flag e target de teste explícitos | BLOCKED |
| BLK-005 | Google Calendar staging não autorizado | Live OAuth/sync bloqueado | Credenciais e calendário sintético | BLOCKED |
| BLK-006 | Rotação/invalidação de credenciais versionadas exige controle externo | Release blocker até comprovação | Rotacionar, invalidar sessões e auditar histórico sem divulgar valores | BLOCKED |

Blockers serão atualizados quando houver nova evidência; nunca convertidos por suposição.
