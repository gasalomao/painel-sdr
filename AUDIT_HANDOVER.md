# HANDOVER — painel-sdr (Sistema, Auditoria e Próximos Passos)

Documento completo para qualquer IA/desenvolvedor entender o sistema do zero:
o que é, como roda, arquitetura, o que a auditoria profunda encontrou, o que já
foi corrigido e o que falta fazer.

> Contexto da geração: auditoria profunda end-to-end executada em 2026-08-28
> (read-only + correções cirúrgicas validadas). Baseline verde no final.

---

## 1. O que é este sistema

**painel-sdr** — painel web multi-tenant de SDR (Sales Development
Representative) assistido por IA, usado por agências para fazer prospecção
ativa via WhatsApp. Em português (BR). Cada cliente (tenant) conecta um número
WhatsApp, captura leads (Google Maps / sites), dispara campanhas com follow-up
automático e conversa com os leads por um agente de IA com base de conhecimento
própria (RAG) e agenda. Login: cookie de sessão JWT próprio (não Supabase Auth
UI). Painel admin para operar/personificar tenants.

## 2. Stack

| Camada | Tecnologia |
|---|---|
| App | Next.js 16.3.1 (App Router), React 19.2.4, TypeScript 5 |
| Estilo | Tailwind CSS 4, shadcn/ui, lucide-react, recharts, sonner, dnd-kit |
| Banco | Supabase/Postgres + `pgvector` (RAG, HNSW), via `@supabase/supabase-js` |
| Sessão | JWT em cookie (`src/lib/auth.ts` node / `auth-edge.ts` middleware) |
| Gate | `src/proxy.ts` (middleware Next): rotas públicas, sessão, admin e feature-gating |
| WhatsApp | Evolution API, Evolution **GO**, WhatsApp Cloud API (Meta), via `channel_connections` |
| Scraper | Puppeteer Core/Extra/Stealth (Google Maps → leads) |
| IA | Gemini SDK primário; escada cross-provider (OpenRouter multi-chave, falbacks, circuit-breaker); combos por agente; Whisper (local cpp) e OpenRouter/Gemini p/ transcrição de áudio |
| Jobs | Next.js usa webhooks + `instrumentation.ts` (scheduler in-process); BullMQ + ioredis existem mas estão **LEGADO/ORFÃOS** |
| Testes | Vitest 2.1.9 — 69 suites (52 offline determinísticas, 17 live que tocam rede/DB/IA real) |
| Deploy | Container único (EasyPanel). In-memory locks assumem 1 réplica. |

## 3. Comandos

- `npm run dev` — dev
- `npm run test` — **baseline offline**: 646 testes passam, 1 skip. ZERO rede/DB.
- `npm run lint` — 0 errors / ~1600 warnings (`any` é warning proposital; ver `eslint.config.mjs`)
- `npm run build` — builda `scripts/build-setup-sql.mjs` (gera `src/lib/setup-sql.ts` de `SETUP_COMPLETO.sql`) + next build
- Typecheck manual: `npx tsc --noEmit --incremental false` (limpo; ATENÇÃO:
  `next.config.ts` tem `typescript.ignoreBuildErrors: true` — o build **não**
  valida tipos. Se aparecerem erros só em `.next/dev/types/*`, são artefatos
  stale gerados, apague a pasta e rode de novo — não são bugs do código.)

## 4. Estrutura (mapa)

```
src/app/                  Páginas (dashboard, chat, captador, leads, agente,
                          whatsapp, disparo, follow-up, automacao, tokens,
                          organizador, configuracoes, admin/*, login)
src/app/api/              ~60 route handlers (App Router)
  webhooks/               evolution / evolution-go / whatsapp / whatsapp-cloud
                          (validam assinatura → encaminham p/ agent/process
                          com X-Internal-Secret)
  agent/                  process (motor do atendente IA), knowledge/* (KB+RAG),
                          transcription-models, diagnose-ai
  ai-organize/            Organizador (LLM move leads entre colunas do CRM)
  chat/                   messages (DELETE etc.), sync
  admin/                  clients (gestão de tenants) — PROTEGIDO NO PROXY
  organizer/run-now/      trigger manual do organizador (server-to-server)
src/lib/                  Núcleo: auth.ts, auth-edge.ts, internal-auth.ts,
  supabase.ts (anon+admin server), session-lock.ts (mutex por sessão),
  rag.ts (chunk+embed+search pgvector), ai-provider.ts (escada de providers),
  organizer.ts, followup worker, scraper-engine.ts, template-vars, pii, etc.
src/components/           UI (lay down shadcn): inbox/, integracoes/, ui/
src/workers/              message-worker.ts + queue-manager (BullMQ) — LEGADO,
                          importa MESSAGE_QUEUE_NAME inexistente; nada liga.
sql/ + migrations/        SETUP_COMPLETO.sql fonte canônica; vários fix_*.sql
scripts/                  build-setup-sql.mjs, check-migrations.mjs, recover-*
                      teste*.test.ts (as seguras ficam no default run)
AUDIT_*.md                Documentação da auditoria (findings, mapa, progresso)
```

## 5. Fluxos principais (o sistema em movimento)

1. **Captação**: `/captador` e `/prospeccao-sites` disparam o scraper
   (Puppeteer/stealth no Google Maps) → leads caem no banco por `client_id`.
2. **Distribuição/Disparo**: campanhas em `/disparo` e `/follow-up` montam
   passos (template + variáveis + humanize) e enviam via `channel_connections`
   ativa do tenant (Evolution/Evolution-GO/Cloud API).
3. **Resposta do lead**: webhook (Evolution GO etc.) valida assinatura →
   normaliza mensagem → forward com `X-Internal-Secret` →
   `/api/agent/process` → `session-lock` serializa por conversa → agente IA
   (prompt do tenant + RAG pgvector + ferramentas: agenda, CRM, imagem) responde.
4. **Inbox**: `/chat` lê `chats_dashboard`/`sessions` temporeal; operador
   assume conversa (status open) ou devolve pro bot.
5. **Organizador**: `instrumentation.ts` (scheduler in-process) ou
   `run-now` dispara `/api/ai-organize` com internal secret → LLM recoloca
   leads nas colunas do CRM por regra do tenant (`ai_organizer_config`).
6. **KB/RAG**: `/api/agent/knowledge/save` cria/edita/apaga docs de
   `agent_knowledge` (sempre com `client_id` do auth) e reindexa embeddings
   (`indexKnowledgeDocument` / `deleteKnowledgeChunks` em `lib/rag.ts`).
7. **Admin**: `/admin` gerencia clients/features/impersonate. Gate no proxy:
   rotas `/api/admin/**` **sempre** exigem JWT admin (não aceitam internal
   secret — ver Segurança).

## 6. Modelo de segurança (pós-auditoria)

- **Sessão**: cookie JWT; `verifySession` (edge/node) retorna claims com
  `clientId`, `isAdmin`, `impersonating`, `features`.
- **Proxy** (`src/proxy.ts`):
  - Públicas: `_next`, assets, `/login`, webhooks validados assinatura,
    DeepSeek bookmarklet (auth própria no handler).
  - **`X-Internal-Secret` agora compara o VALOR** (`AUTH_SECRET ||
    SUPABASE_SERVICE_ROLE_KEY`) — antes bastava a PRESENÇA do header.
  - `/api/admin/**` **nunca** passa por internal secret — só admin JWT.
  - Feature-gate: path → `clients.features[key] !== false`; admin real ignora.
- **Internal secret**: helper `src/lib/internal-auth.ts` (`hasInternalSecret`
  com `timingSafeEqual`). Senders legítimos: `instrumentation.ts` →
  `/api/ai-organize`; webhooks → `/api/agent/process`; `organizer/run-now` →
  `/api/ai-organize`. Todos usam `getInternalSecret()`.
- **Autoridade de tenant**: rotas devem derivar `client_id` da SESSÃO e nunca
  confiar no body. (Corrigido em `chat/messages`; ver Achados.)

## 7. Baseline de verificação (pós-correções)

| Verificação | Resultado |
|---|---|
| `npm test` | 646 passed / 1 skipped (52 arquivos). Zero falhas. ~6s. |
| `npm run lint` | **0 errors** / 1611 warnings (`no-explicit-any` = warning por política) |
| `npx tsc --noEmit` | **limpo** |
| Git | 10 arquivos modificados + 8 AUDIT_*.md novos. **Nada commitado.** |

## 8. O que a auditoria CORRIGIU (10 arquivos, todos validados)

### Segurança
1. **`src/proxy.ts` (CRITICAL)** — Bypass de auth: qualquer request `/api/*`
   com header `x-internal-secret` (valor qualquer) passava sem cookie e sem o
   proxy conferir o valor. Como vários handlers não revalidam o secret, isso
   abria até `/api/admin/clients` sem sessão. Agora compara o valor exato e
   **remove `/api/admin/**` do bypass** (admin só com JWT). Senders internos
   reais continuam passando (usam o secret verdadeiro).
2. **`src/app/api/chat/messages/route.ts` (CRITICAL)** — DELETE aceitava
   `clientId` do body como autoridade sem sessão (anônimo apagava conversas de
   qualquer tenant). Agora 401 sem cookie; escopo = `session.clientId`.
   Único caller UI (`src/app/chat/page.tsx`) envia cookie same-origin — ok.
3. **`src/app/api/agent/knowledge/save/route.ts` (HIGH / IDOR)** — update e
   delete usavam `.eq("id")` sem `client_id`: qualquer tenant autenticado
   editava/apagava KB de outro — e o update ainda **reescrevia `client_id`
   roubando o documento**. Agora ambos escopados por `auth.clientId`; chunks
   RAG só são apagados depois de remover row própria.

### Quebras de UI/robustez
4. **`src/app/whatsapp/page.tsx`** — select de `channel_connections` omitia
   `provider`; cards Cloud API nunca apareciam e filtros caíam errado. Agora
   busca `provider` e `provider_config->phone_number_id` (extrai só o campo
   necessário do JSON — `webhook_secret` continua fora do browser; had comment
   de segurança proibindo select amplo por causa do secret).
5. **`src/app/captador/page.tsx`** — `new URL(lead.website)` no render: lead
   com site inválido (vem do scraper) quebrava a página inteira. Novo helper
   `safeHostname()`.

### Qualidade/Lint (React 19 + config)
6..8. Correção dos 3 erros reais de React 19 (regras novas
`set-state-in-effect` e `purity`):
   - `src/components/inbox/conversation-list.tsx` — reset de `imgError` virou
     ajuste no render (padrão "adjust state when props change").
   - `src/app/prospeccao-sites/page.tsx` (`CountdownCard`) — `Date.now()` fora
     do render (via `requestAnimationFrame` + interval), caso vazio derivado.
   - `src/app/agente/_tabs/ajustes-tab.tsx` — reset de `chosen/orderLoaded`
     no render ao trocar de agente; effect virou só fetch.
9. **`eslint.config.mjs`** — ignora `public/**` (vendor minificado opus não é
   fonte) e `scripts/recover-sdr-chats.js` (CommonJS one-off). Resolve 9 dos 12
   erros de lint (os outros 3 eram os acima).
10. **`vitest.config.ts`** — exclui do `npm test` as 17 suites LIVE que batiam
    rede/DB de produção/IA real e guard no escopo errado (algumas escreviam em
    tabelas!). Padrão agora 100% offline e seguro. Suites live rodam
    explicitamente por nome de arquivo.

### Falsos positivos identificados (não corrigir)
- `src/lib/session-lock.ts` — achado inicial dizia lock in-memory "quebrado";
  releitura confirma a cadeia de promises correta (`prev.then(→release)` +
  `finally`). Limitação real: single-container (documentada no arquivo).
- `scripts/build-setup-sql.mjs` — usa `process.cwd()`, sem path hardcoded.

## 9. O que FALTA FAZER (pendências, em ordem de prioridade)

1. **[HIGH] `src/app/api/agent/process/route.ts` — remover/restringir
   `x-test-agent-id`.** Header de teste permite forçar `agent_id` arbitrário
   (bypass de tenant) fora de ambiente de teste. Comportamento: aceitar apenas
   quando `NODE_ENV !== 'production'` ou exigir internal secret junto. Verificar
   suites `test_agent_process.test.ts` (live!) que o usam — ajustar setup delas.
2. **[HIGH] RLS / GRANT ALL no Supabase.** SQLs históricos abrem permissões
   (`migrations/fix_permissao_supa.sql`, `migrations/FIX_RLS.sql`, `GRANT ALL`).
   Requer acesso ao projeto Supabase para reescrever policies por tenant.
   **Não validavel nem corrigível no repo** — marcar sessão dedicada de banco.
3. **[MEDIUM] Worker BullMQ órfão** — decidir: (a) remover
   `src/workers/*` + dependências `bullmq/ioredis`, ou (b) reintroduzir fila
   (vai exigir Redis e migrar scheduler). Hoje é código morto quebrado
   (`MESSAGE_QUEUE_NAME` inexistente). Recomendo remover (lazy win).
4. **[MEDIUM] `typescript.ignoreBuildErrors: true` em `next.config.ts`** —
   tsc está limpo; remover o override para o build voltar a validar tipos
   (garantia futura). Testar `npm run build` depois.
5. **[LOW] ~1600 warnings `no-explicit-any`** — política documentada em
   `eslint.config.mjs`. Endurecer gradualmente por domínio quando houver janela.
6. **[LOW] Revalidar suites live** — colocar guards corretos (opt-in via env,
   sandbox de banco) antes de reusá-las em CI.
7. **[INFO] Áreas não validadas em runtime** — não houve teste end-to-end com
   Evolution/WhatsApp real, Gemini real, Postgres com dados, scheduler rodando,
   nem browser QA. Só análise estática + suite offline.

## 10. Como continuar (roteiro para o próximo agente)

1. Ler este arquivo → então `AUDIT_FINDINGS.md` (detalhe por achado) e
   `AUDIT_SYSTEM_MAP.md` (mapa completo).
2. Rodar baseline: `npm test`, `npm run lint`, `npx tsc --noEmit` — deve estar
   tudo verde antes de mexer em qualquer coisa.
3. Atacar pendências 9.1 → 9.4 (ilhas próprias, testáveis localmente).
4. Para 9.2 (RLS): precisa de dashboard Supabase + cuidado com tenants ativos.
5. Regras do repositório (em `AGENTS.md`): UI em PT-BR; sem `any` novo;
   queries sempre com escopo `client_id`/tenant; nunca expor secrets no browser
   (ver comentário em whatsapp/page.tsx); nada commitar `.env*`.

## 11. Observações gerais da auditoria (julgar ao estender)

- Código antigo, utilitário e pragmático: comentários em PT-BR explicando
  decisões reais de produção ("Safe", "bug histórico: userscript...").
- Segurança era frágil especialmente no perímetro (proxy) e rotas que aceitavam
  clientId do cliente. Pós-correções, o gate está consistente, mas **confiança
  alta só após teste E2E com sessões reais** (há suites live para isso, mal
  configuradas — pendência 6).
- A escada de IA (Gemini → OpenRouter multi-key → modelo alternativo) está bem
  isolada em `src/lib/ai-provider.ts` com testes offline cobrindo failover,
  cooldown e circuit-breaker. Melhor ponto de arquitetura do repositório.
- Pontos mais frágeis restantes: scraper (Puppeteer, race em SSE singleton),
  RLS no banco, legado BullMQ. Tratar com cuidado e teste por perto.
- Git: **trabalho NÃO commitado**. Revisar `git diff`, criar branch e commitar
  em grupos lógicos (security / lint / ui / vitest) antes de qualquer push.

---

## 12. Atualiza��o final de execu��o (todas as pend�ncias aplic�veis CONCLU�DAS)

| Pend�ncia original | A��o tomada | Status |
|---|---|---|
| 9.1 x-test-agent-id | Restrito em src/app/api/agent/process/route.ts: s� aceito quando NODE_ENV !== 'production' OU com X-Internal-Secret v�lido. Em produ��o sem secret, usa channel.agent_id. | CONCLU�DO |
| 9.2 RLS / GRANT ALL | Criado migrations/HARDEN_RLS.sql com plano faseado: Fase 0 auditoria, Fase 1 (aplic�vel j�) revoga anon de 10 tabelas server-only sens�veis (i_organizer_config, provider_credentials, uth_sessions, etc. � zero quebra), Fase 2 checklist p/ migrar 18 componentes client antes de travar o resto. | CONCLU�DO (SQL pronto) |
| 9.3 BullMQ �rf�o | Removidos src/workers/ (message-worker.ts quebrado) e src/lib/redis-queue.ts. Removidas depend�ncias ullmq e ioredis do package.json + lockfile limpo. Zero quebra (utomation-worker usa timers in-process). | CONCLU�DO |
| 9.4 ignoreBuildErrors | Removido de 
ext.config.ts (ignoreBuildErrors: false). 
pm run build executado e passou 100% com valida��o de tipos reativada. | CONCLU�DO |
| 9.6 Suites live | Guards describe.skip adicionados nas 5 suites desprotegidas (campaign-pregen.live, scraper-restart-race.live, whisper-e2e-real, prospeccao-sites-e2e, petshop-live-validate). itest.config.ts agora inclui todas as 69 suites: 51 rodam (646 testes passam), 18 se autopulam offline, e execu��o expl�cita ($env:LIVE_E2E="1"; npx vitest run ...) volta a funcionar. | CONCLU�DO |

### Estado final do pipeline
- 
pm test: 69 suites / 51 pass / 18 skip / 646 testes verdes / 0 falhas / ~9s
- 
pm run lint: 0 errors / 1610 warnings (pol�tica ny)
- 
px tsc --noEmit: limpo
- 
pm run build: gerou todas as p�ginas + middleware + type-check ativo
