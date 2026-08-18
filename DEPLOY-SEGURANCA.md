# Deploy Seguro — Easypanel (copiar e colar)

> Gerado em 2026-08-14. Siga a ORDEM. Não pule etapas.

---

## PASSO 1 — Env do stack SUPABASE (sistema-supabase)

Easypanel → serviço Supabase → Environment → cole TUDO abaixo → Save → **Redeploy**.

```
########################################################
# Secrets - YOU MUST CHANGE THESE BEFORE GOING INTO PRODUCTION
########################################################
POSTGRES_PASSWORD=your-super-secret-and-long-postgres-password
JWT_SECRET=31f060502cd39271a0a646cb2b0463a362bd063f519f9b42c3696a6426de00ee
ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg2NzM3NzgyLCJleHAiOjIxMDIwOTc3ODJ9.mmRJtbLFlihENc5nG--kUTniPHWDApLlWWJVTnvhbkY
SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UiLCJpYXQiOjE3ODY3Mzc3ODIsImV4cCI6MjEwMjA5Nzc4Mn0.Sq7NpaEF_s9bdVLELBItQwhbJ1d6z7QZJ2WX7BpZ8YE
DASHBOARD_USERNAME=gasalomao
DASHBOARD_PASSWORD=f7c2a9e41d8b3m6Kq2Xw
SECRET_KEY_BASE=9f4d2b8a7c1e5f3a9b6d2c8e4f1a7b3d5c9e2f6a8b4d1c7e3f5a9b2d6c8e4f1a
VAULT_ENC_KEY=your-32-character-encryption-key
PG_META_CRYPTO_KEY=your-encryption-key-32-chars-min

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

**Login do Studio (salve!):** usuário `gasalomao` / senha `f7c2a9e41d8b3m6Kq2Xw`

---

## PASSO 2 — Env do PAINEL (sistema-sdr)

Easypanel → serviço do painel → Environment → cole TUDO abaixo → Save → **Rebuild** (Deploy from source: branch `main`, já está com commit `fd30d9d`).

```
# ============= SUPABASE =============
NEXT_PUBLIC_SUPABASE_URL=https://sistema-supabase.ridnii.easypanel.host
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg2NzM3NzgyLCJleHAiOjIxMDIwOTc3ODJ9.mmRJtbLFlihENc5nG--kUTniPHWDApLlWWJVTnvhbkY
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UiLCJpYXQiOjE3ODY3Mzc3ODIsImV4cCI6MjEwMjA5Nzc4Mn0.Sq7NpaEF_s9bdVLELBItQwhbJ1d6z7QZJ2WX7BpZ8YE

# ============= AUTH =============
# Assina o JWT de sessão do painel + X-Internal-Secret
AUTH_SECRET=5793a0481a799fb3b64291d4bd5a08e40989244784f207e3cb3b8a7e8e4eff79

# ============= EVOLUTION API (legado — fallback) =============
EVOLUTION_API_URL=https://sistema-evolution-api.ridnii.easypanel.host
EVOLUTION_API_KEY=Gabriel@3074
EVOLUTION_INSTANCE=sdr

# ============= EVOLUTION GO =============
EVOLUTION_GO_URL=https://sistema-evolution-go.ridnii.easypanel.host
EVOLUTION_GO_KEY=Gabriel@30741852

# ============= REDIS =============
REDIS_HOST=sistema_redis
REDIS_PORT=6379
REDIS_PASSWORD=Gabriel@3074
REDIS_USERNAME=default

# ============= APP =============
ADMIN_PASSWORD=Gabriel@3074
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
| DASHBOARD_PASSWORD | `Gabriel@3074` | forte e única |
| DISABLE_SIGNUP | false | true (app não usa signup do Supabase) |
| SECRET_KEY_BASE | default público | novo |
| AUTH_SECRET (painel) | não existia (fallback = SERVICE_ROLE) | segredo próprio |

**Não mexi de propósito:** `POSTGRES_PASSWORD`, `VAULT_ENC_KEY`, `PG_META_CRYPTO_KEY`
(o volume do Postgres já foi criado com eles; trocar pela env QUEBRA o banco) e
chaves Evolution/Redis/ADMIN (rotacionar depois nos respectivos painéis, se quiser).

Os REVOKEs de segurança no banco continuam valendo (já rodados, ficam no banco).
