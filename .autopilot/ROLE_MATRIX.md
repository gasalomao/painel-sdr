# Role Matrix

Status: `PASS` (2026-09-01) — modelo real implementado (não o alvo idealizado).

| Papel | Base de confiança | Alcança | Enforcement | Gaps conhecidos |
|---|---|---|---|---|
| Anônimo | — | `/login`, `/api/auth/*`, `/api/webhooks/*`, `/api/whisper-status`, deepseek-chat import/userscript/v1 | `proxy.ts:49-68` | Webhooks fail-open (SEC-C3); whisper-status público executa binário (SEC-006) |
| Cliente (tenant user) | JWT `sdr_session` | APIs/páginas do próprio tenant; pages com feature gate | proxy + `requireClientId` | Revogação bypass (SEC-H5); gate de feature só em página (SEC-M8); browser acessa PostgREST (SEC-C1) |
| Cliente com feature off | idem | Todas as APIs mesmo com feature off | — | SEC-M8 |
| Admin | JWT `isAdmin=true` | `/admin/*`, `/api/admin/*`, impersonação | só `proxy.ts:106-117` | Sem auth in-handler (SEC-M9) |
| Admin impersonando | JWT `actorId=admin, clientId=target, impersonating=true` | Tenant alvo; gates de feature aplicam | proxy (`isAdmin` forçado false em `tenant.ts:51`/`proxy.ts:123`) | M10 refutado; ciclo corrigido em FIX-001 |
| Worker interno | header `x-internal-secret` | `/api/*` exceto `/api/admin` | proxy + `internal-auth.ts` | Mesmo segredo do JWT (SEC-H6) |
| Remetente de webhook | `webhook_secret` por instância | ingestão de mensagem + trigger do agente | apenas se `webhook_strict=true` | SEC-C3 |
| LLM (agente) | nenhuma | Calendar CRUD, KB, custom tools, envio WhatsApp | prompt apenas | SEC-H7 |

Nota: o modelo alvo (PLATFORM_SUPERADMIN/TENANT_OWNER/SDR_OPERATOR etc.) NÃO existe no código — há apenas boolean `is_admin` por client e mapa `features`. Journeys de SDR são operadas pelo dono do tenant sem RBAC granular.
