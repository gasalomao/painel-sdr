# AUDIT FLOWS

## Status

Mapa inicial estático. Cada fluxo será promovido a VALIDADO somente após leitura ponta a ponta e, quando seguro, execução isolada.

## FLOW-001 — Login e sessão

```text
POST /api/auth/login
  -> validação/rate limit
  -> clients/auth_sessions
  -> JWT assinado
  -> cookie HTTP
  -> src/proxy.ts em requests seguintes
  -> verifySession
  -> requireClientId nos handlers
```

**Invariantes esperados**

- Credenciais não aparecem em logs/respostas.
- Usuário inativo não autentica.
- Logout/reset/revogação invalidam acesso.
- Admin e impersonation preservam ownership explícito.

**Riscos em validação:** bypass de header interno, revogação não aplicada, rate limit local.

## FLOW-002 — Request autenticado multi-tenant

```text
Browser/API client
  -> cookie/header
  -> src/proxy.ts
  -> route.ts
  -> requireClientId/guard local
  -> query com client_id
  -> response filtrada
```

**Invariantes esperados**

- Tenant vem apenas da sessão validada.
- IDs relacionados pertencem ao mesmo tenant.
- Admin/impersonation são explícitos.
- Service role nunca substitui autorização.

**Riscos em validação:** handlers dependentes apenas do proxy; body `clientId`; referências cruzadas.

## FLOW-003 — Webhook Evolution

```text
Evolution externa
  -> /api/webhooks/whatsapp ou /evolution-go
  -> identificar instância
  -> validar segredo/assinatura
  -> resolver client_id
  -> deduplicar evento
  -> contato/sessão/mensagem
  -> mídia/storage
  -> agente IA/resposta opcional
```

**Invariantes esperados**

- Fail closed para instância/segredo desconhecido.
- Deduplicação tenant-scoped.
- Nenhum fallback para tenant default em evento externo.
- Replays e eventos fora de ordem são seguros.

## FLOW-004 — Webhook WhatsApp Cloud

```text
Meta Cloud
  -> verify challenge ou POST assinado
  -> phone_number_id
  -> channel connection + client_id
  -> status/message dedup tenant-scoped
  -> contact/session/message
  -> storage
  -> IA/resposta opcional
```

**Riscos em validação:** assinatura ausente aceita; resolver sem client_id; inserts globais.

## FLOW-005 — Envio manual de mensagem

```text
UI chat
  -> /api/send-message
  -> sessão + tenant
  -> validar instância/contato
  -> provider do canal
  -> envio externo
  -> persistência/status
  -> realtime/UI
```

**Edge cases:** double click, timeout após envio externo antes da persistência, retry e duplicação.

## FLOW-006 — Campanha

```text
UI disparo
  -> /api/campaigns
  -> validar tenant, instance, agent, leads
  -> campaign + targets
  -> instrumentation/campaign-worker
  -> claim target
  -> personalização IA opcional
  -> envio WhatsApp
  -> log/status/retry
```

**Invariantes esperados:** ownership composto, claim atômico, idempotência e lock distribuído.

## FLOW-007 — Automação e follow-up

```text
Config UI/API
  -> automation/followup records
  -> scheduler in-process
  -> selecionar elegíveis
  -> verificar resposta/pausa
  -> gerar conteúdo
  -> enviar
  -> avançar estado
```

**Edge cases:** duas réplicas, resposta simultânea, retry após timeout, JID compartilhado entre tenants.

## FLOW-008 — Appointment e Google Calendar

```text
Calendário/API
  -> appointment tenant-scoped
  -> OAuth Google por agente
  -> create/update/delete event
  -> sync periódico bidirecional
  -> reminder/follow-up
```

**Edge cases:** token expirado, evento removido durante sync, conflito simultâneo, timezone, duplicação.

## FLOW-009 — Agente IA e RAG

```text
Mensagem/teste
  -> /api/agent/process
  -> tenant + agent settings
  -> histórico e contexto
  -> retrieval vector tenant/agent-scoped
  -> combo/provider/model
  -> parsing/tool/business rules
  -> resposta
  -> persistência e envio opcional
```

**Invariantes esperados:** isolamento de knowledge, output não confiável, timeout/retry limitado, custo observável.

## FLOW-010 — Scraper/prospecção

```text
UI/API scraper
  -> iniciar run por tenant
  -> Puppeteer/Maps
  -> coletar/enriquecer leads
  -> estado/SSE
  -> persistência ou webhook outbound
  -> reviews IA opcional
```

**Riscos em validação:** estado singleton compartilhado, SSRF, stop/clear cross-tenant, browser/resource leaks.

## FLOW-011 — Setup/build SQL

```text
npm run build
  -> scripts/build-setup-sql.mjs
  -> ler SETUP_COMPLETO.sql
  -> gerar src/lib/setup-sql.ts
  -> next build
  -> standalone image
```

**Riscos em validação:** caminho fonte incorreto, snapshot divergente, build verde com type errors.

## FLOW-012 — Worker BullMQ

```text
Producer esperado
  -> Redis queue
  -> src/workers/message-worker.ts
  -> provider de mensagem
  -> status/retry
```

**Status:** NÃO VALIDADO; producer/startup/queue name precisam ser comprovados.
