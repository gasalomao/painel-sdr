# Site Studio — providers, contratos e provisionamento

## Contrato de integração (coordenador)

Spec: `SITE_STUDIO.md`, módulos quality/publish. Nenhum código gerado executa no Next ou no worker principal. Next enfileira `website_runs.kind = 'build'`; worker separado lê a revisão imutável em `base_revision_id`, carrega assets privados e chama `createSiteBuildProvider().build({ project, files, assets }, signal)`. Persistir resultado em `website_builds`, usage e término do run. `kind` aceita `agent | build` (default `agent`).

## Contrato de publicação atômica (provider owner, 17/09/2026)

Implementação requer estes RPCs service_role; ausência falha fechado ANTES de qualquer efeito Cloudflare. Nunca usar fallback para inserts não atômicos.

- `website_begin_deployment(p_client_id uuid, p_project_id uuid, p_build_id uuid, p_rollback_id uuid, p_expected_revision_id uuid, p_idempotency_key text, p_hostname text) RETURNS jsonb`: trava projeto; verifica acesso ativo, não arquivado/deletado, revisão atual esperada, QA aprovado e critic. Rollback exige deployment publicado no mesmo tenant/projeto/build e já fixa `provider_id` da versão anterior com `phase='version_ready'` (retomada não recria versão nem reenvia assets). Reutiliza chave idêntica sem cobrar; conflito de payload/chave gera `website_idempotency_conflict`. Reserva hostname global (mesmo projeto pode reutilizar; outro gera `website_domain_conflict`), bloqueia outro deployment ativo e runs ativos, consome quota diária `deploys` e insere ledger append-only exatamente uma vez. Insere deployment `deploying` e retorna linha inteira. `idempotency_key` é a chave HTTP bruta, não prefixada. Hostname fica congelado na linha.
- Colunas deployment: `hostname text NOT NULL`, `expected_revision_id uuid NOT NULL`, `rollback_id uuid NULL`, `phase text NOT NULL DEFAULT 'reserved'` (`reserved|version_creating|version_ready|activating`; machine monotônica `reserved → version_creating → version_ready → activating`), `claim_id uuid NULL`, `lease_expires_at timestamptz NULL`, `updated_at timestamptz NOT NULL DEFAULT now()`. `provider_id` guarda version UUID. UNIQUE(client_id,project_id,idempotency_key) NOT NULL; UNIQUE parcial(client_id,project_id) WHERE status='deploying'. Publicados/failed são terminais e imutáveis.
- `website_claim_deployment(p_client_id uuid,p_project_id uuid,p_deployment_id uuid,p_claim_id uuid,p_lease_seconds integer DEFAULT 300) RETURNS jsonb`: compare-and-set de `deploying` sem lease ou expirado; lease 15-300s (default 300); retorna NULL se outro claim ainda ativo. Nunca troca status nem apaga provider_id/phase. Recovery chama novamente o mesmo ID, não cria outra publicação.
- `website_renew_deployment(p_client_id uuid,p_project_id uuid,p_deployment_id uuid,p_claim_id uuid,p_lease_seconds integer DEFAULT 300) RETURNS boolean`: renova lease do claim dono (claim_id igual e lease ainda válida); perda de claim/expiração gera `website_lease_lost`. Worker chama a cada 60s durante a publicação; abortar ao perder.
- `website_checkpoint_deployment(p_client_id uuid,p_project_id uuid,p_deployment_id uuid,p_claim_id uuid,p_provider_id text,p_phase text) RETURNS jsonb`: requer claim não expirado, escopo, monotonicidade da phase (`reserved→version_creating`, `version_creating→version_ready`, `version_ready→activating`; `activating` é terminal para checkpoint); `version_creating` exige `p_provider_id` NULL, demais phases exigem UUID (provider_id só muda de NULL para UUID, nunca substituído); renova lease +300s. Retorna linha; perda de lease gera `website_lease_lost`.
- `website_finish_deployment(p_client_id uuid,p_project_id uuid,p_deployment_id uuid,p_claim_id uuid,p_status text,p_error text) RETURNS jsonb`: requer claim válido; `deploying` só registra erro/pending e libera lease; `failed` permitido somente antes de `activating`; `published` exige version, phase activating, revisão/tenant/projeto/QA ainda válidos, ativa domínio reservado e atualiza published_deployment_id/url/status/last_published_at atomicamente. URL derivada de hostname, nunca entrada do browser. Libera claim/lease e retorna linha inteira. Finalização publicada idêntica é idempotente.
- Trava de edição: todas as mutações de projeto/revisões/assets/run usam a mesma trava de projeto e rejeitam enquanto houver deployment `deploying`; publicação rejeita runs ativos. Impede corrida entre QA e ativação. Slug <=63 e UNIQUE global, inclusive soft-deleted; hostname UNIQUE global nunca liberado por soft-delete.
- Erros estáveis: `website_active_deployment`, `website_active_run`, `website_revision_conflict`, `website_idempotency_conflict`, `website_domain_conflict`, `website_quota_exceeded`, `website_lease_lost`, `website_forbidden`, `website_not_found`, `website_invalid_input`.
- Recovery no worker (implementado): loop dedicado a cada 60s chama `website_list_recoverable_deployments(p_after_id uuid DEFAULT NULL)` (deployments `deploying` no Cloudflare sem lease ou expirada, tenant ativo com sites, `ORDER BY id ASC LIMIT 5`, paginação keyset) e chama `resumeSiteDeployment(clientId,projectId,deploymentId)` — CAS via `website_claim_deployment` preserva lease de outro worker ativo. POST repetido com mesma chave também reconcilia. Não liberar deployment por timeout: ativação externa pode ter ocorrido. A versão já persistida é reutilizada; resultado só vira published após leitura do deployment Cloudflare ativo (version UUID em 100%) e probe HTTPS real do hostname publicado (200 + text/html).

Schema necessário ao coordenador/migration agent:
- `website_builds`: contrato `WebsiteBuild`; artifact/screenshots/qa JSONB, revision_id e escopo composto. Limites já aplicados no producer: arquivo <=20MB, total <=40MB, <=500 arquivos, resultado <=80MB, screenshots PNG desktop/mobile. Retenção pode remover builds antigos, mas nunca o build referenciado por `published_deployment_id` nem o do deployment em curso.
- `website_deployments`: contrato `WebsiteDeployment` mais `idempotency_key text NOT NULL`; UNIQUE(client_id,project_id,idempotency_key), índice único parcial (client_id,project_id) WHERE status='deploying'. `provider_id` é CF version ID, não deployment ID. Transições agora via RPCs do contrato de publicação atômica (acima); linha congelada em published/failed.
- `website_domains`: id/client_id/project_id/hostname/status/created_at; hostname globalmente UNIQUE. Status pending/active/failed; pending não autoriza Origin.
- `website_form_submissions`: id/client_id/project_id/idempotency_key/payload/lead_id/created_at; UNIQUE(client_id,project_id,idempotency_key).
- `website_rate_limit(key text, "limit" int, window_seconds int) RETURNS boolean`: incremento atômico compartilhado, service_role somente; erro nega requisição.
- `website_submit_form(p_client_id uuid,p_project_id uuid,p_idempotency_key text,p_payload jsonb) RETURNS jsonb`: transação service_role que verifica projeto publicado, reutiliza submissão idêntica (conflito se payload difere), cria lead e submissão atomicamente e retorna `{id}`. Payload: nome 2-120, email <=254, telefone <=30, mensagem <=3000, `consent = true`, telefone OU email obrigatórios. Lead com origem `website` (`primeiro_contato_source`, `website_project_id`, status `novo`), nome/email/telefone/mensagem; nunca client_id do browser. Com telefone: `remoteJid` derivado dos dígitos (10-15) + `@s.whatsapp.net`, dedup por `ON CONFLICT (client_id, "remoteJid") DO NOTHING` (lead existente re-selecionado `FOR SHARE`); sem telefone, `lead_id` NULL. Bloquear corrida via UNIQUE e transação; não criar lead duplicado em retry; falha do lead é falha do envio (500, chave preservada). `idempotency_key` é a chave HTTP bruta, não prefixada.
- `website_usage` ledger: coordenador mantém esquema/registro de consumo; quotas de build/deploy são admitidas atomicamente via `website_rate_limit` antes do trabalho.

Imports compartilhados aguardados: `server.requireSitesContext`, `repository.getProject/getFiles/saveRevision`, `settings.getWebsiteSettings`, `starter.getStarterFiles/validateFiles`. Rotas validarão autenticação e escopo antes de acessar IDs.

## Gates

Publicação exige build da revisão atual, success, status ready, qa.passed, zero erros, screenshots PNG reais desktop/mobile e critic stamp `qa.visual_review` não vazio (escrito exclusivamente pelo critic confiável, nunca pelo sandbox/cliente). Rollback usa versão anterior persistida e não chama IA.

## Credenciais

Ausência de E2B_API_KEY/E2B_SITE_TEMPLATE_ID ou CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID: `READY — AWAITING CREDENTIALS`.

Env opcionais: CLOUDFLARE_ZONE_ID (domínio `${slug}.${base_domain}`), CLOUDFLARE_WORKERS_SUBDOMAIN (alternativa workers.dev), SITE_FORMS_TRUSTED_IP_HEADER (somente header sobrescrito pelo proxy confiável). Nunca transmitir segredos/env do host ao sandbox.

## Fontes oficiais consultadas em 17/09/2026

- https://docs.e2b.dev/sandbox.md
- https://docs.e2b.dev/network/internet-access.md
- https://docs.e2b.dev/filesystem/read-write.md
- https://docs.e2b.dev/template/defining-template.md
- https://docs.e2b.dev/template/build.md
- https://developers.cloudflare.com/workers/static-assets/direct-upload/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/versions/methods/create/
- https://developers.cloudflare.com/workers/versions-and-deployments/
- https://developers.cloudflare.com/api/resources/workers/subresources/domains/methods/update/
- https://playwright.dev/docs/api/class-page#page-screenshot

Verificação offline: `npm run test -- src/lib/__tests__/site-providers.test.ts src/lib/__tests__/site-forms.test.ts`; `npm run lint`; `npx tsc --noEmit --incremental false`. Nenhum build E2B, browser local, publicação ou migration remota é executado nos testes.
