# AUDIT FINDINGS

## Legenda

- **CONFIRMADO:** evidência suficiente e, quando aplicável, reprodução segura.
- **PROVÁVEL:** evidência estática forte; validação independente/reprodução pendente.
- **HIPÓTESE:** indício inicial.
- **NÃO VALIDADO:** depende de runtime, banco ou ambiente indisponível.

Este arquivo começa com triagem preliminar. Achados só serão promovidos para CONFIRMADO após leitura direta das fontes e/ou teste seguro.

## Fila preliminar

### PRE-SEC-0001 — Header interno pode contornar autenticação global

**Severidade candidata:** CRITICAL  
**Confiança:** 95% — PROVÁVEL  
**Área:** proxy/auth  
**Arquivo:** `src/proxy.ts`  
**Evidência inicial:** discovery apontou que a presença de `x-internal-secret` permite requests `/api/*` sem comparar o valor.  
**Impacto candidato:** acesso anônimo a handlers que confiam apenas no proxy.  
**Próxima prova:** leitura direta do proxy, helper canônico e testes existentes; characterization test local sem iniciar servidor.  
**Status:** AGUARDANDO GATES A–C.

### PRE-SEC-0002 — Handlers administrativos podem não possuir autorização local

**Severidade candidata:** CRITICAL quando combinada com PRE-SEC-0001  
**Confiança:** 90% — PROVÁVEL  
**Área:** admin  
**Arquivos:** `src/app/api/admin/clients/route.ts`, `src/app/api/admin/clients/[id]/route.ts`  
**Impacto candidato:** leitura/criação/alteração/exclusão de tenants e privilégios.  
**Próxima prova:** revisar todos os métodos e dependências de proxy; identificar cascades.  
**Status:** AGUARDANDO GATES A–C.

### PRE-SEC-0003 — Material sensível pode estar documentado em texto claro

**Severidade candidata:** CRITICAL  
**Confiança:** 85% — PROVÁVEL  
**Área:** secrets  
**Arquivo:** `DEPLOY-SEGURANCA.md`  
**Evidência inicial:** scanner/revisor indicou valores não-placeholder para credenciais. Valores não serão reproduzidos.  
**Impacto candidato:** comprometimento se ativos ou presentes no histórico.  
**Próxima prova:** secret scan mascarado, status de tracking e histórico; rotação exige ação humana/operacional.  
**Status:** NÃO CORRIGIR AUTOMATICAMENTE; possível rotação externa.

### PRE-DATA-0001 — RLS/grants podem permitir bypass de isolamento multi-tenant

**Severidade candidata:** CRITICAL  
**Confiança:** 90% no design do repo; estado de produção NÃO VALIDADO  
**Área:** Supabase/PostgreSQL/RLS  
**Arquivos:** `migrations/001_multi_tenant.sql`, `migrations/fix_permissao_supa.sql`, `migrations/FIX_RLS.sql`, `security/hardening.sql`  
**Sintoma candidato:** anon key pública com grants/policies incompatíveis com tenant isolation.  
**Próxima prova:** comparar todo SQL de RLS e construir consulta read-only para estado real; não executar sem acesso seguro.  
**Status:** REQUIRES HIGH-RISK CHANGE se confirmado no banco.

### PRE-SEC-0004 — Webhooks Evolution podem falhar abertos

**Severidade candidata:** HIGH/CRITICAL  
**Confiança:** 90% — PROVÁVEL  
**Área:** webhooks  
**Arquivos:** `src/app/api/webhooks/whatsapp/route.ts`, `src/app/api/webhooks/evolution-go/route.ts`  
**Impacto candidato:** payload forjado persistido e possível acionamento de IA/mensagens.  
**Próxima prova:** mapear todos os branches de assinatura, defaults e testes.  
**Status:** AGUARDANDO GATES A–C.

### PRE-DATA-0002 — WhatsApp Cloud pode persistir sem `client_id`

**Severidade candidata:** HIGH  
**Confiança:** 90% — PROVÁVEL  
**Área:** multi-tenant/webhook  
**Arquivo:** `src/app/api/webhooks/whatsapp-cloud/route.ts`  
**Impacto candidato:** contatos/sessões/mensagens no tenant errado; status global.  
**Próxima prova:** trace completo phone number -> connection -> tenant -> queries/inserts.  
**Status:** AGUARDANDO GATES A–C.

### PRE-AUTH-0001 — Revogação pode não invalidar JWT na maioria das rotas

**Severidade candidata:** HIGH  
**Confiança:** 90% — PROVÁVEL  
**Área:** auth/session  
**Arquivos:** `src/lib/auth-edge.ts`, `src/lib/auth.ts`, `src/lib/tenant.ts`, `src/proxy.ts`  
**Impacto candidato:** token revogado continua aceito até expiração.  
**Próxima prova:** mapear todas as chamadas a `isSessionLive`, logout, reset e disable.  
**Status:** AGUARDANDO GATES A–C.

### PRE-TENANT-0001 — Referências de instância/agente/lead/documento podem atravessar tenants

**Severidade candidata:** HIGH  
**Confiança:** 80–90% conforme subfluxo — PROVÁVEL  
**Área:** campaigns, automations, follow-up, appointments, knowledge, reviews AI  
**Impacto candidato:** uso/leitura/alteração de recursos de outro tenant.  
**Próxima prova:** matriz ownership por endpoint, query e worker.  
**Status:** QUEUED.

### PRE-SEC-0005 — URL de webhook do scraper pode permitir SSRF autenticado

**Severidade candidata:** HIGH  
**Confiança:** 85% — PROVÁVEL  
**Área:** scraper/outbound HTTP  
**Arquivos:** `src/app/api/scraper/route.ts`, `src/lib/scraper-engine.ts`  
**Próxima prova:** localizar guard de URL, redirects, DNS e todos os fetches.  
**Status:** QUEUED.

### PRE-CONC-0001 — Schedulers in-process podem duplicar jobs entre réplicas

**Severidade candidata:** HIGH  
**Confiança:** 90% na implementação; topologia NÃO VALIDADA  
**Área:** concurrency/reliability  
**Arquivo:** `src/instrumentation.ts`  
**Impacto candidato:** mensagens, IA e transições duplicadas.  
**Próxima prova:** verificar claims/locks em cada worker e deployment replica count.  
**Status:** QUEUED; provável REQUIRES HIGH-RISK CHANGE.

### PRE-TEST-0001 — Suite padrão pode executar testes live com efeitos reais

**Severidade candidata:** HIGH para confiabilidade de CI/desenvolvimento  
**Confiança:** 90% — PROVÁVEL  
**Área:** tests  
**Arquivos:** `vitest.config.ts`, `src/lib/__tests__/setup.ts`, suites `*.live.test.ts`  
**Impacto candidato:** escrita DB, chamadas de IA, browser e rede em `npm test`.  
**Próxima prova:** classificar todas as suites e guards antes de executar.  
**Status:** BASELINE BLOQUEADO.

### PRE-BUILD-0001 — Build pode ignorar type errors

**Severidade candidata:** MEDIUM/HIGH  
**Confiança:** 100% — CONFIRMADO ESTATICAMENTE  
**Área:** build/CI  
**Evidência:** `next.config.ts:20-23` define `typescript.ignoreBuildErrors: true`; `.github/workflows/ci.yml` não possui etapa explícita de typecheck.  
**Impacto:** build verde não prova type safety.  
**Próxima prova:** executar `tsc --noEmit --incremental false`.  
**Status:** CONFIRMADO, runtime impact pendente.

### PRE-BUILD-0002 — Gerador de SQL procura fonte em caminho divergente

**Severidade candidata:** MEDIUM/HIGH  
**Confiança:** 95% — PROVÁVEL  
**Área:** build/database setup  
**Arquivos:** `scripts/build-setup-sql.mjs`, `migrations/SETUP_COMPLETO.sql`, `src/lib/setup-sql.ts`  
**Impacto candidato:** build usa snapshot SQL obsoleto silenciosamente.  
**Próxima prova:** leitura direta, comparação determinística sem escrever e teste isolado em temp.  
**Status:** QUEUED.

### PRE-WORKER-0001 — Worker BullMQ pode estar inoperante

**Severidade candidata:** MEDIUM  
**Confiança:** 85% — PROVÁVEL  
**Área:** queue/worker  
**Arquivos:** `src/workers/message-worker.ts`, `src/lib/redis-queue.ts`, `package.json`, `Dockerfile`  
**Evidência inicial:** símbolo de fila/import/startup/producer parecem incompletos.  
**Próxima prova:** typecheck, busca de producers e entrypoints externos.  
**Status:** QUEUED.

### PRE-RUNTIME-0001 — Node 20 pode ser incompatível com Puppeteer Core resolvido

**Severidade candidata:** HIGH para scraper/container  
**Confiança:** 85% — PROVÁVEL  
**Área:** runtime/dependencies  
**Evidência inicial:** Docker/CI usam Node 20; lockfile reportado com engine Puppeteer >=22.12.  
**Próxima prova:** ler lockfile, `npm ls`/engine check read-only e docs oficiais se necessário.  
**Status:** QUEUED.

## Template para promoção de finding

```text
## ID
Título
Severidade
Confiança e score
Área
Arquivo/função
Fluxo
Sintoma
Causa raiz
Evidência
Como reproduzir
Esperado
Atual
Impacto
Probabilidade
Correção proposta
Risco da correção
Teste necessário
Teste de regressão
Problemas semelhantes procurados
Status
```

## Revisao de achados (2026-08-28, pos-verbatim)
- FALSO POSITIVO: session-lock.ts � cadeia de promises confere (prev.then->release no finally). Limitacao single-container ja documentada no arquivo. Retirado da lista de bugs.
- FALSO POSITIVO: build-setup-sql.mjs � usa process.cwd(), sem path hardcoded. Retirado.
- CORRIGIDO (frontend): whatsapp/page.tsx select agora traz provider + provider_config->phone_number_id (campo de exibicao apenas; webhook_secret segue fora do browser). Secao Cloud API volta a listar conexoes.
- CORRIGIDO (frontend): captador/page.tsx safeHostname() � new URL() sem guard crashava a tabela de leads com website invalido.
- CORRIGIDO (lint): 3 erros reais React 19 (set-state-in-effect x2, purity x1) + ignores de vendor/scripts.

## Correcoes de SEGURANCA aplicadas (2026-08-28)
- CRITICAL ? proxy.ts: bypass x-internal-secret exigia apenas PRESENCA do header. Agora compara o VALOR (AUTH_SECRET||SERVICE_ROLE_KEY) e exclui /api/admin/** do bypass (admin = sempre JWT). Senders internos (instrumentation->ai-organize, webhooks->agent/process, organizer run-now) continuam passando com o secret real. Edge: env de build; se ausente, header cai no fluxo de cookie.
- CRITICAL ? chat/messages DELETE: clientId do body ele borrado como autoridade. Agora 401 sem cookie de sessao; escopo = session.clientId. Callers (chat/page.tsx) usam cookie same-origin � sem quebra.
- HIGH ? agent/knowledge/save: update/delete sem filtro client_id (IDOR + roubo de doc cross-tenant via rewrite de client_id). Escopo .eq(client_id, auth.clientId) em ambos; delete so limpa chunks DEPOIS de apagar row propria.
- Remanescente (documentado, nao aplicado � requer ciclo proprio): FALLBACK x-test-agent-id em agent/process; GRANT ALL/RLS aberta (requer acesso ao banco); GRANT de admin/clients agora coberto no gate do proxy.
