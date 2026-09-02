# Threat Model

Status: `PASS` (2026-09-01). Condensação STRIDE das 8 frontes auditadas.

## Ativos
PII de leads/contatos, tokens OAuth Google + credenciais Evolution/Cloud (`agent_settings.options`, `channel_connections.provider_config`, `provider_credentials`), `clients.password_hash`, sessões, identidade do remetente WhatsApp, agenda, base de conhecimento, custo de IA.

## Fronteiras e ameaças principais

1. **Browser → Next API (cookie JWT)**
   - Spoofing: JWT-only em ~todas as rotas; revogação raramente checada (SEC-H5).
   - Tampering: `features`/claims congeladas por 30d.
   - Elevação: SEC-C2 (corrigido em FIX-001) — cadeia impersonate/logout/stop-impersonate.
2. **Browser → PostgREST/Realtime (anon key pública)**
   - Disclosure/Tampering total se RLS off (SEC-C1). Correção estrutural: mover acesso do browser para APIs + hardening SQL.
3. **Evolution/Meta → webhooks públicos**
   - Spoofing: validação fail-open (SEC-C3). Forgery vira prompt injection com tools.
   - Tampering cross-tenant: updates por `message_id`/`remote_jid` sem `client_id` (SEC-M17).
4. **Tenant admin → runtime do agente**
   - Tampering: KB create com `agent_id` alheio (SEC-H4); custom_tools SSRF (SEC-M15).
5. **Contato WhatsApp → LLM**
   - Prompt injection → tools com efeitos (calendar CRUD sem escopo por contato — SEC-H7; webhooks custom; envio WhatsApp).
6. **Servidor → URLs externas**
   - SSRF: `safe-url.ts` sem DNS/redirect check (SEC-M15).
7. **Env/segredos**
   - Um único segredo assina tudo e cai para service_role (SEC-H6); `serviceRole` via querystring (SEC-M12); build ARG com service key no Dockerfile (OPS).
8. **Timers/jobs → efeitos externos**
   - Duplicação em multi-réplica (sem lease); follow-up target órfão em `processing`.

## Aceites e invariants
- `jose` HS256 pinned; constant-time compare em secrets/senhas; sessões persistidas como hash.
- Invariant a manter: TODO handler admin verifica ou fica atrás do proxy; nunca confiar em `impersonating` claims para elevar privilégio.
