# Variáveis de Ambiente — Easypanel

Cole tudo na aba **Environment** do serviço `sdr` no Easypanel.
Depois de colar, clique **Deploy** (ou **Rebuild** se já tinha deployado antes).

---

## Environment Variables (aba "Environment")

Cole o bloco inteiro substituindo pelos seus valores reais:

```env
# ============= SUPABASE (self-hosted) =============
NEXT_PUBLIC_SUPABASE_URL=https://seu-supabase.easypanel.host
NEXT_PUBLIC_SUPABASE_ANON_KEY=sua-anon-key
SUPABASE_SERVICE_ROLE_KEY=sua-service-role-key

# ============= EVOLUTION API (WhatsApp) =============
EVOLUTION_API_URL=https://seu-evolution-api.easypanel.host
EVOLUTION_API_KEY=sua-evolution-api-key
EVOLUTION_INSTANCE=sdr

# ============= EVOLUTION GO (WhatsApp — Go/whatsmeow) =============
EVOLUTION_GO_URL=https://seu-evolution-go.easypanel.host
EVOLUTION_GO_KEY=sua-evolution-go-key

# ============= REDIS =============
REDIS_HOST=sistema_redis
REDIS_PORT=6379
REDIS_PASSWORD=sua-senha-redis
REDIS_USERNAME=default

# ============= APP =============
ADMIN_PASSWORD=sua-senha-admin
NEXT_PUBLIC_APP_URL=https://seu-app.easypanel.host
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
NEXT_PUBLIC_SUPABASE_URL=https://seu-supabase.easypanel.host
NEXT_PUBLIC_SUPABASE_ANON_KEY=sua-anon-key
NEXT_PUBLIC_APP_URL=https://seu-app.easypanel.host
SUPABASE_SERVICE_ROLE_KEY=sua-service-role-key
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

1. Acesse o **Supabase Studio** da sua VPS
2. Vá em **SQL Editor** → **New Query**
3. Cole o conteúdo INTEIRO do arquivo `SETUP_COMPLETO.sql` (está na raiz do projeto)
4. Clique **Run**
5. Deve aparecer: `✅ Todas as tabelas essenciais foram criadas.`

> **IMPORTANTE**: Rode o SQL ANTES do primeiro deploy. Se o app iniciar sem tabelas, vai dar erro.

---

## Checklist de Deploy

- [ ] SQL rodado no Supabase (`SETUP_COMPLETO.sql`)
- [ ] Builder configurado como `Dockerfile`
- [ ] Todas as envs coladas no Environment
- [ ] Build Args preenchidos
- [ ] Domínio ativo com SSL
- [ ] Deploy verde (sem erros)
- [ ] Login com senha definida em `ADMIN_PASSWORD`
- [ ] Configurações → Setup do Banco → Verificar agora = ✅ verde
- [ ] Configurações → Evolution API → Testar conexão = ✅ verde
- [ ] Configurações → Google Gemini → Testar chave = ✅ verde
