## Atualização — 05/10/2026: Impeccable integral por etapa

Integração fundamentada no upstream fixado em `87a6ab0c145adb85cbd428a99fa1377305e0818d`. Ver `docs/SITE_STUDIO_IMPECCABLE.md` para fontes, cobertura e adaptações do executor. Toggle controla prompt/ferramentas/revisão/eventos; criação carrega todos os fundamentos integrais; biblioteca completa consultável; contrato privado exigido antes de código e persistido por revisão; crítica visual exige evidências. Removidas receitas fixas por segmento. Sem migration, publicação ou chamada paga.

Gates iniciais: 1.297 testes passaram (31 skipped), TypeScript e lint focado sem erros. Gates finais abaixo ao concluir.

---

## Atualização — 05/10/2026: imagens e custo de edição

Correções e estudo detalhados em `docs/SITE_STUDIO_OTIMIZACAO.md`: ligação dos assets ao preview com renovação de URLs, intenção de logo após anexo, validação de logo omitida, patch SEARCH/REPLACE sem sobrescrita, compactação de leituras antigas e recortes explícitos de fontes. Alterações anteriores locais foram preservadas. Não houve commit, chamada paga, publicação ou migration remota.

Verificação final: suíte completa passou com 1.283 testes (31 skipped); 120 testes focados passaram após integração com alterações simultâneas na seleção de modelos; TypeScript e ESLint sem erros (1.640 warnings no lint global); lint focado final sem erros; build de produção aprovado; git diff --check aprovado. O build anterior registrou 24 warnings de tracing em áreas fora do Studio. Alterações simultâneas de gateway/aliases de assets foram preservadas; a seleção foi ajustada para não usar modelo textual em QA visual nem inventar modelo OpenRouter ausente.

---

# Site Studio — Progresso e pendências (18/09/2026)

Branch `main`, HEAD `3c3bf40`. Todas as alterações NÃO commitadas (não commitar sem pedido explícito).

## Estado verificado agora (offline)

- Suíte completa `src/lib/sites` + `src/lib/__tests__`: 75 arquivos passando, 18 skipped (dependem de env/credenciais), 1039 testes, 0 falhas.
- Teste SQL real em PGlite (`website-studio-sql.test.ts`, 31/31) roda por padrão no `npm test` — valida migration `migrations/016_website_studio.sql` inteira: quotas, claims CAS, idempotência, RLS service-role, deployments, formulário/lead atômico, RPC `website_list_recoverable_deployments`.
- Suíte de providers (`site-providers.test.ts`, 107/107): espelho das transições SQL + reconciliação Cloudflare + timeouts de rede no fluxo de publicação.
- Worker (`src/lib/sites/__tests__/worker.test.ts`, 29/29): heartbeat, renovação de lease, recuperação de deployments e shutdown.

## Verificado nesta sessão

- Quotas: reserva de tokens antes de cada chamada OpenRouter (incluindo fallbacks) com settlement pelo gasto real; builds pagos são admitidos por execução E2B antes do provider (sem dupla cobrança com `queue_build`).
- Deployments (Cloudflare): phases `reserved → version_creating → version_ready → activating`; `website_renew_deployment` renova lease a cada 60s com fencing por `claim_id`; abort ao perder claim; reconcilia versão por `deployment.id` após resposta ambígua; consulta versão ativa antes de ativar (sem POST duplicado); falha terminal `failed` só antes de `activating`.
- Formulário CRM: idempotência por chave, rate limit por projeto e IP, criação de lead atômica com origem `website` e dedup por `(client_id, remoteJid)` derivado do telefone.
- Worker: heartbeat ocioso via `website_claim_next_run` (~3s), renovação de lease durante execução, health real em `getWebsiteIntegrations`.
- Worker — recuperação de deployments travados (pendência antiga #1, resolvida): loop dedicado a cada 60s via RPC `website_list_recoverable_deployments` (paginação keyset `p_after_id`, lotes de 5, preserva lease ativa), chamando `resumeSiteDeployment` com CAS e timeout de run; erros não abortam o ciclo; encerramento limpo no shutdown (`src/lib/sites/worker.ts:202`).
- Provider de deployment: chamadas Supabase do fluxo de publicação (claim, leitura, checkpoints, finish, renew) usam `AbortSignal.any([signal, AbortSignal.timeout(10_000)])` — corrige vazamento de abort/cancel no resume.
- Gates rodados: `npm run lint` (0 erros), `npx tsc --noEmit --incremental false` (0 erros), `npm run build` (ok — `src/lib/setup-sql.ts` regenerado com a migration 016), `git diff --check` (limpo, apenas avisos CRLF).
- Docs sincronizadas (18/09): `SITE_STUDIO_PROVIDERS.md` agora documenta `version_creating`, a machine monotônica de phases, `website_renew_deployment` (lease 15-300s, fencing por claim), `website_list_recoverable_deployments` (keyset, lotes de 5) e o `website_submit_form` real (remoteJid derivado do telefone + dedup `ON CONFLICT` — comportamento canônico coberto pelos testes PGlite). `idempotency_key` verificada: bruta em `publishSite` (`deployment-provider.ts:397`) e nos dois RPCs (016:861, 1018) — docs corretas. `SITE_STUDIO.md` não cita mais `website_agent_runs`.
- UI — pendências antigas #4 resolvidas (18/09):
  - Skills do projeto: builtins são `always`/`automatic` por design e `selected_skill_ids uuid[]` impede marcá-las sem migration; painel do projeto agora explica isso e aponta o caminho (duplicar skill padrão na biblioteca com ativação Manual).
  - Undo/redo do editor: mudanças externas de `files` (ação do agente, restauração, salvar) agora empilham o snapshot anterior no `undoStack` (`site-files-panel.tsx`) — Ctrl+Z volta ao estado pré-mudança como rascunho.
  - Assets/URLs assinadas: bug real — `listWebsiteAssets` retornava linhas cruas sem assinar, então os thumbs do chat nunca renderizavam após recarregar (upload recém-feito funcionava por assinar no POST). Agora assina apenas os `ready`; statuses pending/failed/deleting seguem visíveis sem URL. Teto conhecido: TTL de 300s; a lista reassina ao remontar a página.
  - `GET /builds`: screenshots base64 completos saem apenas no build mais recente e nos builds da revisão atual (thumb da lista de sites + checagem de reuso de publicação); demais builds retornam `screenshots` vazio e a UI já tratava ausência ("Aprovada com ressalvas", fallback de letra).
- Gates re-rodados pós-correções de UI: `npm run lint` (0 erros), `npx tsc --noEmit --incremental false` (0), `npm test` (75 arquivos, 1039 testes, 0 falhas; assets 17/17), `npm run build` (ok).

## Pendências (o que falta)

1. **Credenciais — READY — AWAITING CREDENTIALS:** `E2B_API_KEY`, `E2B_SITE_TEMPLATE_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SITES_WORKER_ENABLED=true`. Migration nunca aplicada em banco real; fluxo E2E real (criar→conversar→validar→publicar→copiar URL) não executado.
2. **Browser QA:** Playwright não instalado no repo; não usar o Puppeteer do Painel para testar código gerado.
3. **Exemplos Aurora/Norte:** só gerar com opt-in explícito (chamadas pagas).
4. **Revisão independente de segurança/UX/custos.**

## Retomar

- Testes: `npm test` (vitest, uma passada).
- Worker: `npm run sites:worker`.
- Gates: `npm run lint` → `npx tsc --noEmit --incremental false` → `npm run build` → `git diff --check`.
- Chaves da sessão: SQL `ses_f4e5acbe2ffemAhEFc7MZ6femv`, skills/assets/prompts `ses_f4e5acbbdffekPVunMExc4GA5T`, worker/agente `ses_f4e5acb98ffe36q4NXNta7KAMw`, UI `ses_f4e5acb71ffeZtZGY30X3Xollg`, reconciliação quotas `ses_f4d52f96affeUyKB48GOyd10Sb`, deployments `ses_f4d52f91cffey0qTX7HCOhRuzg`.
