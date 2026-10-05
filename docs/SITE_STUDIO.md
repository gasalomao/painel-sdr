# Site Studio IA — arquitetura e contrato de implementação

## Discovery (17/09/2026)
Base main, HEAD 3c3bf40, árvore limpa. Next.js 16/React 19/TypeScript, Supabase com sessão JWT própria. Tenant é clients.id; negócio é leads_extraidos.id (BIGINT). requireClientId valida sessão persistida. service_role contorna RLS: toda consulta nova exige filtro client_id e relações compostas. RLS server-only bloqueia anon/authenticated. Infra real usa timers em Next; não existe BullMQ/Redis apesar do AGENTS. OpenRouter já possui descoberta, multi-key, cooldown, combos e usage. Reutilizar essas funções, ampliando contratos sem alterar comportamento padrão do agente SDR. Uploads públicos atuais não servem ao Studio. Não há construtor existente; prospeccao-sites é outreach.

Baseline: TypeScript aprovado; ESLint zero erros e 1610 warnings preexistentes (discovery). Testes e build ainda precisam de baseline seguro.

## Objetivo e escopo
Produto integrado /sites: projetos de leads confirmados ou do zero, chat que altera arquivos, assets privados, modelos dinâmicos, skills/prompt versionados, preview, snapshots, QA isolado e publicação Cloudflare. Sites V1 são React + Vite + TypeScript + CSS, sem backend próprio ou instalação arbitrária. Não é editor visual drag-and-drop.

## Mapa de capacidades e ordem
| Módulo | Responsabilidade | Dependência |
| --- | --- | --- |
| foundation | auth/gate, schema, projetos, arquivos, revisions | sessão/Supabase existentes |
| instructions | biblioteca skills e prompt versionado | foundation |
| agent | loop controlado, ferramentas, modelo, cancelamento, usage | foundation/instructions/OpenRouter |
| assets-preview | uploads/vision, preview responsivo | foundation/agent |
| quality | E2B build/render/screenshots/critic | agent/assets-preview |
| publish | Cloudflare Static Assets, rollback, forms CRM | quality |

## Decisões
- OpenCode SDK oficial avaliado em https://opencode.ai/docs/sdk/: cliente depende de opencode server; createOpencode inicia servidor local. Não iniciar no Painel. V1 usa loop controlado em processo/container de worker separado, preservando WebsiteAgentRuntime. Nenhuma execução de código gerado nesse worker: somente E2B.
- Worker confiável dedicado é executado separadamente do servidor web usando a mesma infraestrutura server-side de AI/DB. Ferramentas têm apenas mapa de arquivos e contexto explícito do projeto. Nenhuma ferramenta shell/DB/segredos. Next somente persiste/enfileira/consulta/cancela runs. Nunca iniciar worker no instrumentation do Painel.
- E2B: microVM por build, timeout e kill em finally; React/Vite/TypeScript fixos e scripts do operador. Browser Playwright somente E2B, não Puppeteer do Painel. Comparação com runtime próprio: menor operação e isolamento mais forte; exige credencial e template provisionado. CodeSandbox/Sandpack avaliado para preview; decidir preview de origem isolada com pacote fixo, sem executar fontes no Next.
- Cloudflare Workers Static Assets via APIs atuais de direct upload: manifest, upload buckets, versão imutável e deployments. Sem Pages legado. URL gerenciada e rollback sem IA. https://developers.cloudflare.com/workers/static-assets/direct-upload/
- Credenciais somente env/server; UI mostra presença/ausência. Não chamar IA/build/deploy pagos nos testes padrão. Live requer opt-in explícito.
- Não aplicar migrations remotas, não commitar e não publicar exemplos publicamente nesta sessão.

## Contratos compartilhados
Fonte canônica de tipos: src/lib/sites/types.ts. HTTP em /api/sites e /api/sites/[projectId]/...; dados retornados JSON {projects}, {project}, {files}, {skills}, etc. Erros {error}, sem detalhes de secrets.

WebsiteProject: id/client_id/name/slug/lead_id/client_context/instructions/model_mode/model_id/selected_skill_ids/cta/status/current_revision_id/published_deployment_id/published_url/last_published_at/created_at/updated_at/deleted_at.
WebsiteClientContext: somente campos explicitamente confirmados (name, segment, phone, whatsapp, website, city, address, description, services, notes). Nenhuma linha integral enviada ao modelo.
WebsiteFiles = Record<string,string>. Paths POSIX relativos allowlisted src/, public/, index.html. package.json e configs técnicos fixos e imutáveis.
WebsiteSkill: id/client_id nullable/name/slug/description/instructions/category/tags/priority/trigger_mode/is_enabled/is_builtin/version/timestamps. Builtins em código, overrides privados versionados. Segurança é código imutável, não skill customizada.
WebsiteRun: id/client_id/project_id/status (queued/planning/editing/validating/completed/failed/cancelled), prompt, model_id, base_revision_id, error, cancel_requested, lease_expires_at, timestamps.
WebsiteBuild: id/client_id/project_id/revision_id/status/success/logs/errors/warnings/duration_ms/artifact (manifest map base64 files)/screenshots/qa/created_at.
WebsiteDeployment: id/client_id/project_id/build_id/provider/status/provider_id/url/error/created_at. Cloudflare provider_version_id imutável; rollback cria novo registro referindo versão anterior.

## Verificação
Vitest offline com mocks no limite externo; sem rede/IA real. Testar auth/tenant/IDs/tools/paths/uploads/revisions/cancel/falhas/modelos/skills/prompts/deploy/forms/rate limit. Gates por incremento: npm run test, npm run lint, npx tsc --noEmit --incremental false, npm run build. Falhas baseline devem ser separadas de regressões, nunca ignoradas. Revisão independente final. Exemplos Aurora/Norte offline exercitam contratos; avaliação visual gerada por IA live somente com opt-in, nunca chamar fixture de evidência visual real.

## Definition of Done
Fluxo completo executável após migration, worker e credenciais provisionados. Dependência não configurada retorna READY — AWAITING CREDENTIALS, não sucesso falso. Registrar exatamente checks executados e limites ainda não verificados.
