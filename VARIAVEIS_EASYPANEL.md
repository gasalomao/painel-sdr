# 🔧 Variáveis de Ambiente — Easypanel (serviço `sdr`)

Cole tudo na aba **Environment** do serviço `sdr` no Easypanel.
Depois de colar, clique **Deploy** (ou **Rebuild** se já tinha deployado antes).

---

## Environment Variables (aba "Environment")

Cole o bloco inteiro:

```env
# ============= SUPABASE (self-hosted) =============
NEXT_PUBLIC_SUPABASE_URL=https://sistema-supabase.ridnli.easypanel.host
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJzZXJ2aWNlX3JvbGUiLAogICAgImlzcyI6ICJzdXBhYmFzZS1kZW1vIiwKICAgICJpYXQiOiAxNjQxNzY5MjAwLAogICAgImV4cCI6IDE3OTk1MzU2MDAKfQ.DaYlNEoUrrEn2Ig7tqibS-PHK5vgusbcbo7X36XVt4Q

# ============= EVOLUTION (WhatsApp) =============
EVOLUTION_API_URL=https://sistema-evolution-api.ridnli.easypanel.host
EVOLUTION_API_KEY=Gabriel@3074
EVOLUTION_INSTANCE=sdr

# ============= REDIS =============
REDIS_HOST=sistema_redis
REDIS_PORT=6379
REDIS_PASSWORD=Gabriel@3074
REDIS_USERNAME=default

# ============= APP =============
ADMIN_PASSWORD=Gabriel@3074
NEXT_PUBLIC_APP_URL=https://sistema-sdr.ridnli.easypanel.host
INTERNAL_APP_URL=http://localhost:3000
PORT=3000
HOSTNAME=0.0.0.0
NODE_ENV=production
```

---

## Build Args (aba "Build" → "Build Args")

Estas variáveis `NEXT_PUBLIC_*` são fixadas no JavaScript durante o `next build`.
Se mudar alguma depois, precisa fazer **Rebuild** (Restart não basta).

Cole na aba Build Args:

```
NEXT_PUBLIC_SUPABASE_URL=https://sistema-supabase.ridnli.easypanel.host
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJhbm9uIiwKICAgICJpc3MiOiAic3VwYWJhc2UtZGVtbyIsCiAgICAiaWF0IjogMTY0MTc2OTIwMCwKICAgICJleHAiOiAxNzk5NTM1NjAwCn0.dc_X5iR_VP_qT0zsiyj_I_OZ2T9FtRU2BBNWN8Bu4GE
NEXT_PUBLIC_APP_URL=https://sistema-sdr.ridnli.easypanel.host
SUPABASE_SERVICE_ROLE_KEY=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyAgCiAgICAicm9sZSI6ICJzZXJ2aWNlX3JvbGUiLAogICAgImlzcyI6ICJzdXBhYmFzZS1kZW1vIiwKICAgICJpYXQiOiAxNjQxNzY5MjAwLAogICAgImV4cCI6IDE3OTk1MzU2MDAKfQ.DaYlNEoUrrEn2Ig7tqibS-PHK5vgusbcbo7X36XVt4Q
```

---

## Builder Config (aba "Fonte/Source")

| Campo | Valor |
|---|---|
| **Builder** | `Dockerfile` |
| **Dockerfile Path** | `Dockerfile` |
| **Port** | `3000` |

---

## SQL — Setup do Banco de Dados

Como o Supabase é novo, precisa criar todas as tabelas:

1. Acesse o **Supabase Studio** da sua VPS: `http://157.173.110.24:8000` (ou pelo domínio público)
2. Vá em **SQL Editor** → **New Query**
3. Cole o conteúdo INTEIRO do arquivo `SETUP_COMPLETO.sql` (está na raiz do projeto, 759 linhas)
4. Clique **Run**
5. Deve aparecer: `✅ Todas as 26 tabelas essenciais foram criadas.`

> **IMPORTANTE**: Rode o SQL ANTES do primeiro deploy. Se o app iniciar sem tabelas, vai dar erro.

---

## Checklist de Deploy

- [ ] SQL rodado no Supabase (`SETUP_COMPLETO.sql`)
- [ ] Builder configurado como `Dockerfile`
- [ ] Todas as envs coladas no Environment
- [ ] Build Args preenchidos
- [ ] Domínio `https://sistema-sdr.ridnli.easypanel.host` ativo
- [ ] Deploy verde (sem erros)
- [ ] Login com senha `Gabriel@3074`
- [ ] Configurações → Setup do Banco → Verificar agora = ✅ verde
- [ ] Configurações → Evolution API → Testar conexão = ✅ verde
- [ ] Configurações → Google Gemini → Testar chave = ✅ verde
