# Deploy Seguro — Easypanel (copiar e colar)

> Gerado em 2026-08-14. Siga a ORDEM. Não pule etapas.

---

## PASSO 1 — Env do stack SUPABASE (sistema-supabase)

Easypanel → serviço Supabase → Environment → cole TUDO abaixo → Save → **Redeploy**.

```
########################################################
# Secrets - YOU MUST CHANGE THESE BEFORE GOING INTO PRODUCTION
########################################################
POSTGRES_PASSWORD=<ROTATE_IN_SECRET_MANAGER>
JWT_SECRET=<ROTATE_IN_SECRET_MANAGER>
ANON_KEY=<REGENERATE_AFTER_JWT_ROTATION>
SERVICE_ROLE_KEY=<REGENERATE_AFTER_JWT_ROTATION>
DASHBOARD_USERNAME=<CONFIGURE_IN_SECRET_MANAGER>
DASHBOARD_PASSWORD=<ROTATE_IN_SECRET_MANAGER>
SECRET_KEY_BASE=<ROTATE_IN_SECRET_MANAGER>
VAULT_ENC_KEY=<PRESERVE_OR_ROTATE_WITH_MIGRATION_PLAN>
PG_META_CRYPTO_KEY=<PRESERVE_OR_ROTATE_WITH_MIGRATION_PLAN>

########
# PostgreSQL
########
POSTGRES_HOST=db
POSTGRES_DB=postgres
POSTGRES_PORT=5432
POOLER_PROXY_PORT_TRANSACTION=6543
POOLER_DEFAULT_POOL_SIZE=20
POOLER_MAX_CLIENT_CONN=100
POOLER_TENANT_ID=your-tenant-id
POOLER_DB_POOL_SIZE=5

########
# API proxy
########
KONG_HTTP_PORT=8000
KONG_HTTPS_PORT=8443

########
# API PostgREST
########
PGRST_DB_SCHEMAS=public,storage,graphql_public

########
# GoTrue
########
SITE_URL=https://$(PRIMARY_DOMAIN)
ADDITIONAL_REDIRECT_URLS=
JWT_EXPIRY=3600
DISABLE_SIGNUP=true
API_EXTERNAL_URL=http://localhost:8000

## Mailer (auth)
MAILER_URLPATHS_CONFIRMATION="/auth/v1/verify"
MAILER_URLPATHS_INVITE="/auth/v1/verify"
MAILER_URLPATHS_RECOVERY="/auth/v1/verify"
MAILER_URLPATHS_EMAIL_CHANGE="/auth/v1/verify"
ENABLE_EMAIL_SIGNUP=true
ENABLE_EMAIL_AUTOCONFIRM=false
SMTP_ADMIN_EMAIL=admin@example.com
SMTP_HOST=supabase-mail
SMTP_PORT=2500
SMTP_USER=fake_mail_user
SMTP_PASS=fake_mail_password
SMTP_SENDER_NAME=fake_sender
ENABLE_ANONYMOUS_USERS=false

## Phone (auth)
ENABLE_PHONE_SIGNUP=false
ENABLE_PHONE_AUTOCONFIRM=true

########
# Dashboard
########
STUDIO_DEFAULT_ORGANIZATION=Default Organization
STUDIO_DEFAULT_PROJECT=Default localhost
SUPABASE_PUBLIC_URL=http://localhost:8000

## Support
IMGPROXY_ENABLE_WEBP_DETECTION=true

## OpenAI API SQL Assistant
OPENAI_API_KEY=

########
# Edge Functions
########
FUNCTIONS_VERIFY_JWT=false

########
# Logflare
########
LOGFLARE_PUBLIC_ACCESS_TOKEN=your-super-secret-and-long-logflare-key-public
LOGFLARE_PRIVATE_ACCESS_TOKEN=your-super-secret-and-long-logflare-key-private

########
# OS
########
DOCKER_SOCKET_LOCATION=/var/run/docker.sock

## Google details
GOOGLE_PROJECT_ID=GOOGLE_PROJECT_ID
GOOGLE_PROJECT_NUMBER=GOOGLE_PROJECT_NUMBER
```

**Login do Studio:** configure usuário e senha pelo gerenciador de segredos; nunca registre os valores neste repositório.

---

## PASSO 2 — Env do PAINEL (sistema-sdr)

Easypanel → serviço do painel → Environment → cole TUDO abaixo → Save → **Rebuild** (Deploy from source: branch `main`, já está com commit `fd30d9d`).

```
# ============= SUPABASE =============
NEXT_PUBLIC_SUPABASE_URL=https://sistema-supabase.ridnii.easypanel.host
NEXT_PUBLIC_SUPABASE_ANON_KEY=<REGENERATE_AFTER_JWT_ROTATION>
SUPABASE_SERVICE_ROLE_KEY=<REGENERATE_AFTER_JWT_ROTATION>

# ============= AUTH =============
# Assina o JWT de sessão do painel + X-Internal-Secret
AUTH_SECRET=<ROTATE_IN_SECRET_MANAGER>

# ============= EVOLUTION API (legado — fallback) =============
EVOLUTION_API_URL=https://sistema-evolution-api.ridnii.easypanel.host
EVOLUTION_API_KEY=<ROTATE_IN_SECRET_MANAGER>
EVOLUTION_INSTANCE=sdr

# ============= EVOLUTION GO =============
EVOLUTION_GO_URL=https://sistema-evolution-go.ridnii.easypanel.host
EVOLUTION_GO_KEY=<ROTATE_IN_SECRET_MANAGER>

# ============= REDIS =============
REDIS_HOST=sistema_redis
REDIS_PORT=6379
REDIS_PASSWORD=<ROTATE_IN_SECRET_MANAGER>
REDIS_USERNAME=default

# ============= APP =============
ADMIN_PASSWORD=<ROTATE_IN_SECRET_MANAGER>
NEXT_PUBLIC_APP_URL=https://sistema-sdr.ridnii.easypanel.host
INTERNAL_APP_URL=http://localhost:3000
PORT=3000
HOSTNAME=0.0.0.0
NODE_ENV=production
```

---

## PASSO 3 — Verificações pós-deploy

1. Painel abre e login funciona: `https://sistema-sdr.ridnii.easypanel.host`
   (logins antigos caem — o JWT agora usa AUTH_SECRET novo; só logar de novo)
2. Whisper OK: `https://sistema-sdr.ridnii.easypanel.host/api/whisper-status`
   → deve responder 200 com `"whisperBinExec":{"ok":true}`
3. Mandar mensagem de teste no WhatsApp → aparece no chat em tempo real.
4. Mandar um áudio → transcreve em ~20s.

## Por que essas mudanças (resumo)

| Item | Antes | Agora |
|---|---|---|
| Chaves Supabase | JWTs demo públicos (qualquer um acessava o banco) | Novas, assinadas com JWT_SECRET novo |
| DASHBOARD_PASSWORD | valor exposto no histórico | segredo forte e único no gerenciador |
| DISABLE_SIGNUP | false | true (app não usa signup do Supabase) |
| SECRET_KEY_BASE | default público | novo |
| AUTH_SECRET (painel) | não existia (fallback = SERVICE_ROLE) | segredo próprio |

**Rotação obrigatória:** JWT/Supabase, Dashboard, AUTH, Evolution, Redis e ADMIN foram expostos no histórico e devem ser substituídos nos respectivos serviços. Para `POSTGRES_PASSWORD`, `VAULT_ENC_KEY` e `PG_META_CRYPTO_KEY`, execute uma migração planejada; alterar somente a env pode indisponibilizar dados existentes.

Os REVOKEs de segurança no banco continuam valendo (já rodados, ficam no banco).
