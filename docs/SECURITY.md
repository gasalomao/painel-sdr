# Modelo de Segurança

## Visão Geral

O Painel SDR implementa segurança em múltiplas camadas: autenticação JWT com PBKDF2, isolamento multi-tenant na aplicação, feature gating granular, e auditoria de sessões.

## 1. Autenticação

### Fluxo de Login

```
Browser → POST /api/auth/login {email, password}
  → findClientByEmail(email) via supabaseAdmin
  → verifyPassword(plain, stored)  // PBKDF2-SHA256, 100k iters, timing-safe
  → generate sessionId (randomUUID)
  → signSession(claims)  // JWT HS256 via jose
  → createAuthSession({id, token_hash, userAgent, ip})  // DB
  → Set-Cookie: sdr_session=<jwt>; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000
  → 200 {ok: true}
```

### Especificações Criptográficas

| Componente | Algoritmo | Detalhe |
|------------|-----------|---------|
| Hash de senha | PBKDF2-SHA256 | 100.000 iterações, 64 bytes output, 16 bytes salt |
| Comparação | `timingSafeEqual` | Constant-time (anti-timing-attack) |
| Session token | JWT HS256 | Biblioteca `jose`, edge-compatible |
| Secret | `AUTH_SECRET` ou fallback `SUPABASE_SERVICE_ROLE_KEY` | Codificado para `Uint8Array` |
| Token hash em DB | SHA-256 hex | Nunca armazena o JWT cru |
| TTL da sessão | 30 dias | Configurável em `SESSION_TTL` |

### Validação de Sessão

Cada request passa por `proxy.ts`:

1. Lê cookie `sdr_session`
2. `verifySession(token)` — verificação criptográfica (edge-safe)
3. Se válida: extrai `claims` → `{clientId, actorId, email, isAdmin, impersonating, features}`
4. Rotas de API re-validam via `requireClientId(req)`

### Revogação de Sessão

- `auth_sessions` table: `revoked_at`, `expires_at`
- `isSessionLive(sessionId, token)` checa revogação no DB
- **Fails-open**: se DB cair, retorna `true` (evita logout em massa — tradeoff disponibilidade vs segurança)
- Logout: `revokeSession(id)` + clear cookie
- Troca de senha: `revokeAllClientSessions(clientId)` — revoga todos os dispositivos

## 2. Multi-Tenancy

### Modelo de Isolamento

O sistema **não usa RLS** (Row Level Security) do Postgres. Isolamento é 100% na aplicação:

```
src/lib/tenant.ts:
  requireClientId(req)
    → verifySession(cookie) → claims.clientId
    → retorna {ok: true, clientId, isAdmin}
    
  Toda query Supabase:
    supabase.from("leads").select("*").eq("client_id", clientId)
```

### Auto-Resolução de Tenant (Triggers)

3 triggers PostgreSQL resolvem `client_id` automaticamente quando NULL:

| Trigger | Tabela | Lógica |
|---------|--------|--------|
| `set_client_id_on_insert` | `chats_dashboard` | `instance_name → channel_connections.client_id` |
| `set_client_id_on_message` | `messages` | `session_id → sessions.instance_name → client_id` |
| `set_client_id_on_contact` | `contacts` | `remote_jid → chats_dashboard.jid → client_id` |

### DEFAULT_CLIENT_ID

`00000000-0000-0000-0000-000000000001` — bucket para dados pré-multi-tenant e instâncias não resolvidas. Dados legados ficam isolados aqui.

### Admin Bypass

Admins (`is_admin = true`) enxergam todos os tenants. Durante impersonação, `isAdmin` é `false` e `impersonating` é `true` — o admin "vê o que o cliente vê".

## 3. Feature Gating

### Implementação

14 features controladas por cliente via `clients.features` (JSONB):

```typescript
const PATH_TO_FEATURE = {
  "/leads": "leads",
  "/chat": "chat", 
  "/agente": "agente",
  "/automacao": "automacao",
  "/disparo": "disparo",
  "/follow-up": "followup",
  "/captador": "captador",
  "/whatsapp": "whatsapp",
  "/tokens": "tokens",
  "/organizador": "organizador",
  "/configuracoes": "configuracoes",
  // ...
};
```

### Política Default-Allow

```typescript
hasFeature(key) → isAdmin || features[key] !== false
```

Se a chave não existe → permite acesso. Para bloquear, explicitamente setar `false`.

### Feature Gating no Proxy vs API

- **proxy.ts**: bloqueia páginas HTML por feature
- **API routes**: fazem o próprio check quando necessário
- **Componentes UI**: auto-gate via `session.features[key] !== false`

## 4. Admin Impersonation

Admin pode "logar como" qualquer cliente para suporte/debug.

### Fluxo

```
1. Admin → POST /api/admin/impersonate {clientId}
2. JWT gerado com {actorId: admin.id, clientId: target.id, impersonating: true}
3. Cookie atualizado
4. UI mostra ImpersonationBanner (banner amarelo no topo)
5. Admin vê o sistema como o cliente vê
6. POST /api/admin/stop-impersonate → restaura sessão admin original
```

### Segurança

- `/api/admin/impersonate` requer `isAdmin` (checkado no proxy)
- `/api/admin/stop-impersonate` **exempt** do gate admin (para permitir auto-restauração)
- Sessão original preservada no `actorId` do JWT
- Banner visível em todas as páginas durante impersonação

## 5. Internal Secret

Comunicação server-to-server usa header compartilhado:

```typescript
// src/lib/internal-auth.ts
INTERNAL_SECRET_HEADER = "x-internal-secret"
getInternalSecret() → AUTH_SECRET || SUPABASE_SERVICE_ROLE_KEY
hasInternalSecret(req) → req.headers.get(header) === secret
```

### Uso

- Scheduler (instrumentation.ts) → API routes (organizer, campaigns)
- Webhooks internos → Agent process
- Worker → Channel send

### Proxy Bypass

O proxy permite qualquer rota `/api/` com o header interno válido — não exige cookie de sessão. O endpoint re-valida o valor do secret.

## 6. Considerações e Recomendações

### Pontos Fortes

- PBKDF2 com 100k iterações + timing-safe compare
- JWT em cookie httpOnly (não acessível por JS)
- Hash de token nunca armazenado em texto plano
- Revogação de sessão via DB
- Mensagens de erro genéricas (no email enumeration)
- Isolamento multi-tenant centralizado em `requireClientId`

### Pontos de Atenção

| Concern | Status | Mitigação Atual |
|---------|--------|-----------------|
| `sameSite: lax` | Permite CSRF em GET | Mutações só via POST |
| `isSessionLive` fails-open | Logout em massa evitado | Tradeoff deliberado |
| Internal secret non-constant-time | Timing attack teórico | Rede interna |
| Secret compartilhado JWT + internal | Comprometimento duplo | Rotação recomendada |
| Feature default-allow | Chave faltante permite acesso | Setar false explicitamente |
| SSRF em `fetchUrlAsBase64` | Aceita qualquer URL | Timeout 60s + 100MB cap |
| Tokens em JSONB | Cloud API access_token em texto plano | Criptografia em app level recomendada |
| Sem rate limiting de login | Brute force possível | PBKDF2 100k iters é a mitigação |

### Variáveis de Ambiente de Segurança

| Variável | Obrigatória | Descrição |
|----------|:-----------:|-----------|
| `AUTH_SECRET` | Recomendada | Secret para JWT. Fallback: service role key |
| `SUPABASE_SERVICE_ROLE_KEY` | Sim | Bypass RLS + fallback de secret |
| `ADMIN_PASSWORD` | Sim | Senha do admin inicial |
