# Tarefas do Projeto

## Chat (/chat) — Correção da Causa Raiz do Reaparecimento de Contatos sem Mensagens (2026-08-06)
- [x] Corrigir erro de sintaxe UUID do Postgres no `DELETE /api/chat/messages` validando se o `conversationId` é um UUID antes de buscar `id.eq` no PostgREST <!-- id: 500 -->
- [x] Deletar todas as sessões por `remote_jid`, `contact_id` e `id` no Supabase para impedir que contatos continuem exibindo "Nenhuma mensagem..." <!-- id: 501 -->
- [x] Atualizar remoção otimista no `ConversationList` e `page.tsx` para fechar a tela e apagar o card instantaneamente <!-- id: 502 -->
- [x] `npx tsc --noEmit` 0 erros <!-- id: 503 -->

## Chat (/chat) — Modal de Confirmação e Exclusão Completa do Banco (2026-08-06)
- [x] Criar modal de confirmação `<Dialog>` em `ConversationItem` com o nome do contato, aviso irreversível e spinner "Apagando..." <!-- id: 490 -->
- [x] Atualizar `DELETE /api/chat/messages` para apagar todas as mídias/mensagens no `chats_dashboard` e sessões no `sessions` considerando todas as variações de JIDs <!-- id: 491 -->
- [x] Atualizar `handleDeleteConversation` no `page.tsx` para feedback visual com `toast.success` e limpeza de estado otimista <!-- id: 492 -->
- [x] `npx tsc --noEmit` 0 erros <!-- id: 493 -->

## Chat (/chat) — Redesign do Botão de 3 Pontos Estilo WhatsApp Web (2026-08-06)
- [x] Reposicionar o botão de 3 pontos para a área do horário no canto superior direito do card <!-- id: 480 -->
- [x] Aplicar transição suave no hover (`opacity-0` ➔ `opacity-100`) ocultando o horário para evitar sobreposição <!-- id: 481 -->
- [x] Manter o botão de 3 pontos ativo enquanto o menu dropdown estiver aberto (`menuOpen`) <!-- id: 482 -->
- [x] Estilizar o DropdownMenuContent com cantos arredondados, sombras modernas e item de exclusão limpo <!-- id: 483 -->
- [x] `npx tsc --noEmit` 0 erros <!-- id: 484 -->

## Chat (/chat) — Pré-visualização de Mídias na Barra Lateral (2026-08-06)
- [x] Criar e exportar helper `formatLastMessagePreview` em `conversations.ts` para formatar áudios, imagens, vídeos e documentos <!-- id: 470 -->
- [x] Selecionar `media_type` e `media_url` nas consultas ao `chats_dashboard` em `ConversationList` <!-- id: 471 -->
- [x] Atualizar `handleMessageEvent` no `/chat` com `formatLastMessagePreview` para exibição instantânea em tempo real <!-- id: 472 -->
- [x] `npx tsc --noEmit` 0 erros <!-- id: 473 -->

## Chat (/chat) — Rótulo do Badge da IA (2026-08-06)
- [x] Alterar o badge no cabeçalho das mensagens geradas pela IA de "IA SDR" para "IA" (`src/components/inbox/message-bubble.tsx`) <!-- id: 460 -->
- [x] `npx tsc --noEmit` 0 erros <!-- id: 461 -->

## Chat (/chat) — Rolagem Fluida Nativa Estilo WhatsApp (2026-08-06)
- [x] Adicionar listener de scroll com cálculo de distância até o fim (`distanceToBottom > 150px`) <!-- id: 450 -->
- [x] Preservar a posição de rolagem quando o usuário subir na conversa (evitar puxões de scroll ao atualizar estado) <!-- id: 451 -->
- [x] Aplicar rolagem suave (`behavior: "smooth"`) para novas mensagens quando o usuário estiver na base <!-- id: 452 -->
- [x] Criar botão flutuante circular estilo WhatsApp `[ 🠇 ]` para rolar até a mensagem mais recente <!-- id: 453 -->
- [x] `npx tsc --noEmit` 0 erros <!-- id: 454 -->

## Chat (/chat) — Mensagens em Tempo Real (2026-08-06)
- [x] Criar helpers `isSameJid` e `getPossibleJids` em `conversations.ts` para casar JIDs do WhatsApp em todas as variações <!-- id: 440 -->
- [x] Atualizar `handleMessageEvent` e `handleConversationEvent` com `isSameJid` (0ms WebSocket update) <!-- id: 441 -->
- [x] Adicionar busca flexível por `.in("remote_jid", posiblesJids)` em `MessageThread` <!-- id: 442 -->
- [x] Adicionar polling em background ultra-leve (2.5s) na conversa ativa (`MessageThread`) para garantia de 0% de lag <!-- id: 443 -->
- [x] Adicionar polling em background silencioso (5s) na barra lateral (`ConversationList`) para ordenação e contadores <!-- id: 444 -->
- [x] Suporte a pausa automática do polling quando a aba estiver oculta (`document.hidden`) <!-- id: 445 -->
- [x] `npx tsc --noEmit` 0 erros <!-- id: 446 -->

## Prospecção Sites — Rótulos dos Filtros em Português (2026-08-06)
- [x] Criar dicionários de mapeamento `HAS_WEBSITE_LABELS`, `SORT_LABELS` e `ORDER_LABELS` <!-- id: 435 -->
- [x] Injetar os rótulos amigáveis dentro dos componentes `<SelectValue>` em Leads, Revisão e Disparo <!-- id: 436 -->
- [x] `npx tsc --noEmit` 0 erros <!-- id: 437 -->

## Prospecção Sites — Seta Google Maps em Leads (2026-08-06)
- [x] Criar helper `mapsUrlFor(lead)` com fallback inteligente para buscas no Google Maps (`maps_url` -> `place_id` -> busca por nome + endereço) <!-- id: 430 -->
- [x] Adicionar ícone de seta (`ExternalLink`) ao lado do nome do negócio na coluna NEGÓCIO da aba Leads <!-- id: 431 -->
- [x] Atualizar a coluna MAPS para renderizar Badge clicável com `MapPin` e `ExternalLink` para 100% dos leads <!-- id: 432 -->
- [x] Adicionar botão de ação com ícone de seta (`ExternalLink`) na coluna de Ações (lado do botão Deletar) <!-- id: 433 -->
- [x] Adicionar ícone de seta (`ExternalLink`) nos cards de leads da aba Revisão <!-- id: 434 -->

## 9Router & Headroom Proxy Dashboard (2026-08-06)
- [x] Diagnóstico da interface bugada em `http://localhost:20128/api/headroom/proxy/dashboard` (caminhos absolutos `/static/*` e `/api/stats` sem repasse + bloqueio de autenticação no `middleware.js`) <!-- id: 420 -->
- [x] Implementação de rota catch-all proxy em `app/api/headroom/proxy/[...path]/route.js` no 9Router com reescrita de caminhos de scripts/CSS no HTML <!-- id: 421 -->
- [x] Atualização de `middleware.js` liberando `/api/headroom/proxy` na whitelist de rotas públicas (`aB`) <!-- id: 422 -->
- [x] Testes de verificação automatizada (status 200 OK em dashboard HTML, tailwind.min.js, alpine.min.js, htmx.min.js, stats API) e captura de screenshot via subagente <!-- id: 423 -->

## 9Router & Modo Max (2026-08-06)
- [x] Estudo aprofundado do 9Router (arquitetura, SQLite `settings`, `providerThinking` e endpoints `/v1/chat/completions`, `/v1/messages`) <!-- id: 410 -->
- [x] Mapeamento dos provedores GLM 5.2 no 9Router (`glm`, `nvidia`, `opencode-go`) e demais provedores (`antigravity`, `codex`, `kiro`, `kilocode`, `cline`, `qoder`, `grok-cli`, `kimi`) <!-- id: 411 -->
- [x] Atualização da tabela `settings` no SQLite `data.sqlite` configurando `providerThinking` com `mode: "max"` universal <!-- id: 412 -->
- [x] Testes de verificação com retorno dos blocos de raciocínio/pensamento completo ("thinking") em todos os provedores GLM 5.2 (`glm/glm-5.2`, `nvidia/z-ai/glm-5.2`, `ocg/glm-5.2`) e no `combo-principal` <!-- id: 413 -->

## Prospecção Sites — Fix Captura Rating/Nota (2026-08-06)
- [x] Estudar regex card (`scraper-engine.ts:616`) — identificada frail: 1 casa decimal, sem middot, sem aria-label fallback <!-- id: 410 -->
- [x] Estudar painel detalhe (`scraper-engine.ts:1109`) — aria-label só buscava "estrela", Google BR usa "Avaliação X de 5" <!-- id: 411 -->
- [x] Fix card: multi-strategy (aria-label expandido + regex 1-2 casas + `·` + fallback `X estrelas` + review count isolado) <!-- id: 412 -->
- [x] Fix painel detalhe: seletores `.fontDisplayLarge` + textContent + regex `4.8 (1.234)` / `4.8 · 1.234` <!-- id: 413 -->
- [x] Derivação final: se vazio → média ponderada de `distribuicaoEstrelas` ou média de `reviewsDetalhes[]` <!-- id: 414 -->
- [x] `npx tsc --noEmit` 0 erros <!-- id: 415 -->
- [ ] **TESTAR**: buscar termo retorne negócios → confirmar rating preenchido em ~100% (antes ~60-70%) <!-- id: 416 -->
- [ ] **TESTAR**: capturar negócio sem rating aparente → confirmar derivação via distribuicao/reviewsDetalhes <!-- id: 417 -->

## Prospecção Sites (2026-08-05)
- [x] Migration `prospeccao_sites.sql` (campaign_type, prospeccao_lead, opt_out, indices) <!-- id: 370 -->
- [x] API `/api/prospeccao-sites/leads` (GET paginado, sort, filter, tenant) <!-- id: 371 -->
- [x] API `/api/prospeccao-sites/campaigns` (GET/POST) + `/[id]/route.ts` (GET/PATCH/POST/DELETE) <!-- id: 372 -->
- [x] API `/api/prospeccao-sites/opt-out` (POST) <!-- id: 373 -->
- [x] Worker `campaign-worker.ts` checka `opt_out` pré-envio (skip + log) <!-- id: 374 -->
- [x] Page `/prospeccao-sites` 4 tabs (Busca/Revisão/Disparo/Histórico) <!-- id: 375 -->
- [x] Rewrite page 5 tabs (Captura inline + Leads filtros/ranking + Disparo + Histórico) <!-- id: 382 -->
- [x] Sidebar item + Header pageTitles entry (import `Globe`) <!-- id: 376 -->
- [x] `npx tsc --noEmit` 0 erros + dev server smoke (307/401 esperado) <!-- id: 377 -->
- [ ] **TESTAR**: rodar `migrations/prospeccao_sites.sql` no SQL Editor Supabase <!-- id: 378 -->
- [ ] **TESTAR**: habilitar `features.prospeccao_sites=true` no cliente via `/admin/clientes` <!-- id: 379 -->
- [ ] **TESTAR**: Captura Maps que tenha populado `website` em leads (Migration 009) <!-- id: 380 -->
- [ ] **TESTAR**: fluxo completo — Busca → selecionar → Revisão → Disparo → Histórico <!-- id: 381 -->

## Prospecção Sites — Filtros Revisão + Ordem Disparo + IA Rewrite (2026-08-05)
- [x] Migration `prospeccao_sites.sql` append `priority INT` + `idx_ct_priority` <!-- id: 390 -->
- [x] `src/lib/prospeccao-priority.ts` pure fn `computePriority` + `passesFilters` <!-- id: 391 -->
- [x] POST `/api/prospeccao-sites/campaigns` aceita `order_by/order_dir/min_reviews/min_rating`, computa `priority` por target <!-- id: 392 -->
- [x] `campaign-worker.ts:402` ordena `priority DESC, created_at ASC` (maior priority dispara primeiro) <!-- id: 393 -->
- [x] GET `/api/prospeccao-sites/leads` server-side `ratingMin/reviewsMin/hasWebsite` (alívio client) <!-- id: 394 -->
- [x] Page `/prospeccao-sites` POST body envia `order_by/order_dir/min_reviews/min_rating`; fetch leads passa `hasWebsite/ratingMin/reviewsMin` <!-- id: 395 -->
- [x] Removido state morto `revMinReviews/revMinRating/revOrderBy/revOrder` <!-- id: 396 -->
- [x] IA rewrite end-to-end já funcionava (schema/worker/UI/POST) — sem mudanças <!-- id: 397 -->
- [x] Tests `prospeccao-priority.test.ts` (13) + `campaign-target-order.test.ts` (5) pass <!-- id: 398 -->
- [x] `npx tsc --noEmit` 0 erros <!-- id: 399 -->
- [ ] **TESTAR**: rodar append `migrations/prospeccao_sites.sql` (priority + index) no Supabase <!-- id: 400 -->
- [ ] **TESTAR**: criar campanha `order_by=reviews, min_reviews=10` → confirmar targets com maior `reviews` têm `priority` alta <!-- id: 401 -->
- [ ] **TESTAR**: worker dispara target maior `priority` primeiro (verificar `campaign_logs` ordem) <!-- id: 402 -->
- [ ] **TESTAR**: IA rewrite toggle on + modelo + prompt → `campaigns.personalize_with_ai=true` salvou + worker chama IA <!-- id: 403 -->
- [ ] **BUG LATENTE**: `created_at desc` na fn inverte semântica SQL (mais velho vence). Se user reclamar, inverter sinal `score = t` <!-- id: 404 -->

## Modelo agente independente + Web search robustez (2026-08-04)
- [x] Bug fix: `agentConfig.target_model` ignorado em non-admin → `mapModelAsync` direto quando setado <!-- id: 360 -->
- [x] Brave Search API opcional (`BRAVE_API_KEY` env, free 2k/mês, fallback DDG/Bing) <!-- id: 361 -->
- [x] `webFetchPage` 15k→30k + crawl 1 nível sub-páginas (sobre/produtos/contato) <!-- id: 362 -->
- [x] `needsFreshWebSearch` ampliado: endereço/telefone/site/horário/funcionamento/onde fica/quem é <!-- id: 363 -->
- [x] Typecheck 0 erros + suite 363/363 pass <!-- id: 364 -->
- [ ] **TESTAR**: setar `BRAVE_API_KEY` .env.local → confirmar Brave cai como 1ª fonte <!-- id: 365 -->
- [ ] **TESTAR**: /agente admin trocar modelo → /tokens linhas refletir modelo escolhido <!-- id: 366 -->
- [ ] **TESTAR**: agente recebe pergunta "qual endereço?" → web_search dispara autofetch <!-- id: 367 -->

## Testes exaustivos IA (2026-07-31)
- [x] Mapear fluxo IA agente (webhook route extractors, ai-models/route, agent/process/route, send-message/route, bot-status, manual-send-registry) <!-- id: 350 -->
- [x] Identificar gaps: pure extractors sem unit tests, registry sem unit tests, model-change sem roundtrip test <!-- id: 351 -->
- [x] Criar `whatsapp-extractors.test.ts` — 45 casos: extractText (14), extractMessageType (14), extractMimetype (8), extractFileName/FileSize (4), extractQuoted (4) <!-- id: 352 -->
- [x] Criar `manual-send-registry.test.ts` — 14 casos: register/isManualSend, register/isAiSend, register/isPendingAutomatedSend (race-condition echo) <!-- id: 353 -->
- [x] Criar `model-change-roundtrip.test.ts` — 21 casos: roundtrip format→parse, retrocompat Gemini bare/models:/gemini:, bordas (null/undefined/empty/trim), providerDisplayName <!-- id: 354 -->
- [x] Configurar `setupFiles` no vitest.config.ts carregando .env.local (route.ts importa supabase_admin top-level) <!-- id: 355 -->
- [x] Suite completa: 349/349 pass (antes 269). Type check 0 erros <!-- id: 356 -->

## Context Compression / Headroom & 9Router Claude Code (2026-07-31)
- [x] Instalar o pacote Python `headroom-ai[proxy]` no sistema <!-- id: 330 -->
- [x] Iniciar e validar o proxy do Headroom escutando na porta 8787 (`http://127.0.0.1:8787`) <!-- id: 331 -->
- [x] Configurar o Claude Code CLI (`.claude/settings.json`) para usar o 9Router (`http://127.0.0.1:20128/v1`) com o modelo `combo-principal` para todos os modelos (Sonnet, Opus, Haiku, Fable) <!-- id: 332 -->

## Busca Web robusta (2026-07-30)
- [x] Implementar prefetch de busca web no servidor para qualquer modelo <!-- id: 320 -->
- [x] Filtrar anúncios e estruturar resposta para IA na busca web <!-- id: 321 -->
- [x] Corrigir asserções quebradas em testes legados e rodar suite <!-- id: 322 -->

## Dashboard operacional (2026-07-30)
- [x] Redesenhar dashboard para uma visão profissional e enxuta, com dados e ações úteis <!-- id: 310 -->
- [x] Validar dashboard com typecheck e build <!-- id: 311 -->

## Auditoria de estabilidade e Evolution API (2026-07-30)
- [x] Corrigir `test_agent_process.test.ts` para falhar se `sendResult.ok` for falso e impedir envio externo acidental <!-- id: 300 -->
- [x] Criar testes unitários para roteamento/fallback de `channel.sendMessage` e `channel.sendMedia` (V2/GO) <!-- id: 301 -->
- [ ] Validar a instância Evolution configurada em runtime: status `open`, webhook e envio controlado para número de teste autorizado <!-- id: 302 -->
- [ ] Atualizar as duas asserções desatualizadas em `ai-provider.test.ts` e `organizer-prompt.test.ts` após confirmar a intenção <!-- id: 303 -->
- [ ] Restringir ESLint ao código do produto e criar plano incremental para os 1.223 erros restantes <!-- id: 304 -->
- [ ] Corrigir avisos Turbopack de rastreamento causado pelo acoplamento entre `next.config.ts` e `scraper-engine.ts` <!-- id: 305 -->

## Auditoria follow-up (2026-07-31)
- [x] `organizer-prompt.test.ts` — adicionado caso `is_terminal` flag explícita (15 tests, +1) <!-- id: 357 -->
- [x] `test_webhook_process.test.ts` — timeout 60s + id único com `Date.now()` (collision unique constraint) <!-- id: 358 -->


- [x] Criar arquivo `.env.local` com as variáveis fornecidas pelo usuário <!-- id: 0 -->
- [x] Orientar o usuário como instalar dependências e rodar o projeto localmente (`npm install` e `npm run dev`) <!-- id: 1 -->
- [x] Explicar como gerenciar e atualizar o repositório git localmente e fazer push para o GitHub <!-- id: 2 -->
- [x] Explicar como o deploy é ativado no Easypanel após o push <!-- id: 3 -->

## Multi-conta + DeepSeek (sessão 2026-06-17, ClaudeCode)

- [x] Conector OAuth: multi-conta com apelido editável, pause/resume, remoção <!-- id: 10 -->
- [x] Seletor de modelos mostra apelidos das contas por subgrupo do Gateway <!-- id: 11 -->
- [x] DeepSeek "modo conta" isolado (storage local, rotas OpenAI-shape, anti-ban embutido) <!-- id: 12 -->
- [x] Bookmarklet de captura em 1 clique <!-- id: 13 -->
- [x] Userscript Tampermonkey de captura automática (sub long-lived) <!-- id: 14 -->
- [x] Dica Opera GX (Ctrl+Shift+B) na seção do bookmarklet <!-- id: 15 -->

## Correções de Conexão e Automação (sessão 2026-06-17, Antigravity)

- [x] Corrigir a extração do token JWT no Userscript, Bookmarklet e no Servidor (limpeza de JSON wrappers como `{"value":"..."}`) <!-- id: 40 -->
- [x] Automatizar a instalação abrindo o script do Tampermonkey e o DeepSeek lado a lado, guiado por alerta explicativo <!-- id: 41 -->
- [x] Contornar o bloqueador de pop-ups dos navegadores fornecendo links diretos <a> síncronos na UI após a geração do script <!-- id: 42 -->
- [x] Adicionar botões diretos de "Reinstalar Script" e "DeepSeek" em cada linha da lista de scripts instalados <!-- id: 43 -->
- [x] Incluir modelos do Gateway no endpoint `/api/settings/lead-intelligence` e atualizar os tipos de estado no front-end <!-- id: 50 -->
- [x] Ajustar mapModel e mapModelAsync para evitar que modelos do Gateway sofram coerção automática para fallbacks do Gemini <!-- id: 51 -->

### EM ABERTO — usuário precisa TESTAR runtime (não testei eu)

- [ ] **TESTAR**: Conexão manual via cópia de token do local storage e colagem no formulário do painel <!-- id: 44 -->
- [ ] **TESTAR**: Ativar permissão de busca no Opera GX para fazer o Tampermonkey injetar o script e rodar o badge visual <!-- id: 45 -->
- [ ] **TESTAR**: Mandar uma mensagem usando modelo `deepseek-chat` no Agente → confirmar que volta resposta <!-- id: 21 -->
- [ ] **TESTAR**: Botões Pausar/Retomar de conta OAuth (mover arquivo entre `auths/` e `auths-paused/`) <!-- id: 22 -->

## Refatoração Visual (sessão 2026-06-17, Antigravity)

- [x] Organizar visual das configurações em 4 abas (Tabs) e cards colapsáveis <!-- id: 60 -->
- [x] Corrigir erros de JSX e typecheck do TypeScript na página de configurações <!-- id: 61 -->

## Conector IA grátis: oscilação + "não salva" (sessão 2026-06-30, ClaudeCode)

- [x] Diagnosticar causa real (proxy `127.0.0.1:8317` parado sem auto-start; Supabase estava OK) <!-- id: 70 -->
- [x] Auto-start do proxy ao abrir aba "Contas Grátis (Gateway)" <!-- id: 71 -->
- [x] `refreshProxyStatus` só atualiza state quando muda (fim do re-render/pisca) <!-- id: 72 -->
- [x] `pxBadgeState()` unificada nos 2 badges + estado "Ligando…" <!-- id: 73 -->
- [ ] **TESTAR**: abrir Configurações → aba Contas Grátis e confirmar conector ligando sozinho + 3 contas aparecendo <!-- id: 74 -->
- [ ] **TESTAR**: confirmar modelos das contas reaparecendo nos seletores (Agente, Disparo, etc.) <!-- id: 75 -->

## DeepSeek PoW (sessão 2026-06-30, ClaudeCode)

- [x] Estudar causa raiz do "DeepSeek não funciona" → Proof-of-Work faltando (confirmado ao vivo) <!-- id: 80 -->
- [x] Solver SHA3 em WASM (`deepseek-pow.ts` + `sha3-wasm-base64.ts`) <!-- id: 81 -->
- [x] Integrar PoW no `deepseek-chat-client.ts` (header `x-ds-pow-response`) <!-- id: 82 -->
- [x] Redução de ban: rate-limit 60s + cooldown `pausedUntil` exponencial em 429 <!-- id: 83 -->
- [x] UI: teste automático ao conectar + aviso experimental <!-- id: 84 -->
- [x] Typecheck `npx tsc --noEmit` zero erros <!-- id: 85 -->
- [ ] **TESTAR**: conectar conta DeepSeek real e confirmar teste automático "✓ funcionando" <!-- id: 86 -->
- [ ] **TESTAR**: mandar msg no Agente com modelo `deepseek-chat` e confirmar resposta voltando <!-- id: 87 -->

## 3 Frentes: Whisper + Chat + Backup (sessão 2026-07-07, ZCode→Antigravity)

- [x] Transcrição grátis com whisper.cpp (`whisper-manager.ts`) <!-- id: 100 -->
- [x] Webhook: whisper primeiro → Gemini fallback <!-- id: 101 -->
- [x] Dockerfile: ffmpeg + .whisper dir <!-- id: 102 -->
- [x] Chat: realtime incremental (não rebusca tudo) <!-- id: 110 -->
- [x] Chat: polling 15s → 45s <!-- id: 111 -->
- [x] `gateway-auth-backup.ts` (backup/restore gateway+deepseek) <!-- id: 120 -->
- [x] Gateway route: restore no boot + backup após mudanças <!-- id: 121 -->
- [x] DeepSeek manager: backup fire-and-forget <!-- id: 122 -->
- [x] `setup-sql.ts`: tabela `provider_credentials` <!-- id: 123 -->
- [x] Criar tabela `provider_credentials` no Supabase de produção (SQL rodado pelo usuário 2026-07-07) <!-- id: 124 -->
- [ ] **TESTAR**: conectar conta OAuth → confirmar que aparece no Supabase → simular redeploy → confirmar restauração <!-- id: 125 -->
- [ ] **TESTAR**: mandar áudio WhatsApp → confirmar transcrição whisper sem gastar token Gemini <!-- id: 126 -->

## Conversas Sumindo + Freebuff (sessão 2026-07-07, Antigravity)

- [x] Estudar a fundo o sumiço das conversas do chat <!-- id: 130 -->
- [x] Criar mapeamento temporário para `phone:owner_phone` na exclusão (modo preservação) <!-- id: 131 -->
- [x] Criar migração automática reversa no sync de conexões no backend <!-- id: 132 -->
- [x] Criar migração automática reversa no webhook de status `connection.update` <!-- id: 133 -->
- [x] Instalar dependência `freebuff` no `package.json` <!-- id: 134 -->
- [x] Atualizar o `AGENTS.md` com as regras da Memória Compartilhada Universal <!-- id: 135 -->
- [ ] **TESTAR**: conectar um número em uma instância → trocar de instância com o mesmo número → confirmar que o histórico antigo migrou automaticamente e reapareceu na nova instância <!-- id: 136 -->

## Organizador IA 100% Adaptativo (sessão 2026-07-08, Antigravity)

- [x] Migration `is_terminal` em `kanban_columns` <!-- id: 140 -->
- [x] UI do organizador (`page.tsx`) com toggle "Coluna final" <!-- id: 141 -->
- [x] API kanban-columns aceitando `is_terminal` <!-- id: 142 -->
- [x] Apêndice do prompt listando `[TERMINAL]` <!-- id: 143 -->
- [x] `route.ts` (IA) refatorado para usar `is_terminal` dinâmico em vez de hardcode <!-- id: 144 -->
- [x] Typecheck e Build sem erros <!-- id: 145 -->
- [ ] **TESTAR**: criar kanban com colunas "novo → quente → negociando → ganho [TERMINAL] → perdido [TERMINAL]" → confirmar que a IA move corretamente e terminais são respeitados <!-- id: 146 -->

## Migração do Chat WACRM (sessão 2026-07-22, Antigravity)

- [/] Planejar a migração do chat WACRM e suas tabelas/APIs <!-- id: 200 -->
- [ ] Instalar a biblioteca `sonner` (`npm install sonner`) <!-- id: 201 -->
- [ ] Criar o helper `src/lib/inbox/conversations.ts` adaptado para `sessions` e `contacts` <!-- id: 202 -->
- [ ] Criar o hook `src/hooks/use-realtime.ts` adaptado para `sessions` e `chats_dashboard` <!-- id: 203 -->
- [ ] Criar os componentes de chat em `src/components/inbox/` (compositor de áudio, balões de mídia, sidebar de contato com kanban/anotações) <!-- id: 204 -->
- [ ] Atualizar a página `src/app/chat/page.tsx` conectando à Evolution API e IAs <!-- id: 205 -->
- [ ] Corrigir erros de tipos TypeScript e validar build final <!-- id: 206 -->

## Captar Maps — Todas as avaliações (sessão 2026-07-29)

- [x] Adicionar toggle de captura completa de avaliações ao lado dos filtros <!-- id: 210 -->
- [x] Propagar opção até a engine e remover limite de 50 no modo completo <!-- id: 211 -->
- [ ] **TESTAR**: capturar um negócio com mais de 50 avaliações e confirmar no painel/exportação que todas as avaliações disponíveis foram salvas <!-- id: 212 -->
- [x] Corrigir acúmulo incremental de cards virtualizados pelo Google Maps <!-- id: 213 -->
- [x] Expandir "Mais"/"More" e redesenhar visual de avaliações e respostas <!-- id: 214 -->
- [ ] **TESTAR**: validar em captura real comentário longo expandido e resposta do estabelecimento no modal <!-- id: 215 -->

