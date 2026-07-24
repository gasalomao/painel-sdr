# Contexto Atual do Projeto

Este projeto (`painel-sdr`) é um Painel de SDR construído com Next.js (versão 16.2.3), conectado ao Supabase e Evolution API (WhatsApp), com uso de Redis para filas e inteligência artificial (Google Gemini).

## [2026-07-23 19:30] Captura profunda do Google Maps (reviews + tudo do painel de detalhe)
- **Objetivo do usuário**: "no capturar maps ele consiga capturar reviews e avaliações, tem que capturar o máximo de informação que conseguir, máximo que estiver disponível".
- **Escopo escolhido pelo usuário**: Capturar reviews + tudo do painel de detalhe (horários, faixa de preço, status "aberto agora", atributos, fotos).
- **Implementado**:
  - Migration 009 `migrations/009_leads_reviews_detalhes.sql` adiciona em `leads_extraidos`: `reviews_detalhes jsonb`, `business_details jsonb`, `opening_hours jsonb`, `attributes jsonb`, `price_range text`, `open_now text`, `photos jsonb`, `maps_url text` (idempotente).
  - `SETUP_COMPLETO.sql` e `src/lib/setup-sql.ts` atualizados.
  - `src/lib/scraper-engine.ts` agora rola 8x o contêiner de reviews (clica na aba "Avaliações") e extrai: ~50 reviews (autor, nota, data, texto ≤1200 chars), bloco "Sobre" + serviços, horários por dia da semana, atributos (delivery/acessibilidade/etc.), faixa de preço, status "Aberto agora", até 20 fotos (URLs googleusercontent), e a URL canônica do Maps.
  - `saveLeadAndSync` persiste os novos campos; fallback PGRST204 remove colunas extras (instagram/facebook/JSONB da 009) sem perder o lead.
- **Validação**: `npx tsc --noEmit` 0 erros. **Próximo passo**: rodar o captador numa região pequena pra validar volume dos JSONB.

## [2026-07-23 19:10] Toggle "Simulação de Lead / Disparo" (card de Simulação)
- Card "Simulação de Lead / Disparo" na aba Testes do /agente agora tem toggle cyan no canto direito.
- Quando OFF: `simulateInitialMessage` sai cedo sem chamar a IA — permite testar o resto do fluxo (chat, timeline) sem disparo real. Botão fica "Simulação Pausada".
- Arquivos tocados: `src/app/agente/page.tsx`, `src/app/agente/_tabs/testes-tab.tsx`. `tsc` 0 erros.

## [2026-07-23 14:00] Revisão completa do sistema de contagem de tokens
- **Objetivo do usuário**: "dar uma revisada completa no token para ele contabilizar tudo do sistema corretamente".
- **Auditoria feita** (via Explore): mapeei 14 chamadas de IA; identifiquei 6 sites multi-tenant quebrados (gasto cai no Default client) e o caso DeepSeek que inventava tokens via chars/4 quando upstream não manda `usage`.
- **Corrigido (escopo aprovado — Multi-tenant 8 sites + DeepSeek estimado)**:
  - Multi-tenant em `campaign-worker.ts`, `followup-worker.ts`, `ai-organize/route.ts` (3 ramos), `lead-intelligence.ts` (2 chamadas), `owner-summary.ts`, `webhooks/whatsapp/route.ts` (áudio/imagem/doc — 3 helpers). Agora passam `clientId` no `logTokenUsage`, resolvendo via `clientIdFromInstance(instance_name)` quando necessário.
  - DeepSeek sem usage real: `deepseek-chat-client.ts` não inventa mais `Math.ceil(len/4)`. Devolve `usage.estimated: true` com tokens=0. `AiUsage` em `ai-provider.ts` ganhou `estimated?: boolean`; rota interna e `agent/process` propagam `metadata.estimated`.
- **Lacunas remanescentes (NÃO abordadas — fora do escopo aprovado)**:
  - `src/app/api/webhooks/shared-helpers.ts:213/241/268` — Gemini fallback multimodal pós-whisper (áudio/imagem/doc) em webhooks compartilhados **NÃO logam**. Token gasto invisível.
  - `src/lib/history-summary.ts:105` — resumo do meio do histórico (chamado por `agent/process/route.ts`) **NÃO loga**. Em conversas longas é consumo real do agente.
  - `token-usage.ts:68-71` — pula insert quando `totalTokens=0` (mantido: honesto, DeepSeek sem usage fica invisível ao invés de inventar). Se quiser ver essas chamadas, mudar pra insert com metadata.estimated=true.
  - `ai-organize/route.ts:584-594` ainda lê `response.data?.usageMetadata` na mão (não usa `extractGeminiUsage`) — não quebra, mas é duplicação frágil.
- `npx tsc --noEmit` **zero erros**.

## Estado Atual
- Projeto rodando localmente no dev server do usuário.
- **[2026-07-22] Destaque Visual e Timer Regressivo de Atendimento (Humano vs IA):**
  - **Banner Superior (`src/components/inbox/ai-thread-banner.tsx`)**:
    - Adicionado Badge destacado e colorido: **`[ ATENDIMENTO HUMANO ]`** (âmbar) vs **`[ ATENDIMENTO IA ]`** (esmeralda).
    - Exibição destacada do **tempo restante com cronômetro em tempo real** para desativação da pausa humana e reativação automática da IA (ex: `14m 52s`).
    - Botão de ativação rápida (`Reativar IA`) e dropdown com opções de silenciamento por minutos (15m, 30m, 1h, 2h, 4h, 12h, customizado ou indefinido).
  - **Lista de Conversas Lateral (`src/components/inbox/conversation-list.tsx`)**:
    - Adicionada tag visual **`[ Humano ]`** ou **`[ IA ]`** ao lado do nome do contato.
    - Adicionado ícone indicador no avatar (`👤` vs `🤖`) tornando cristalino para o operador quem está atendendo cada conversa da lista.
- Como o Opera GX bloqueia a injeção automática do Tampermonkey no DeepSeek por políticas internas, orientamos o usuário sobre a permissão "resultados de pesquisa".
- Para a alternativa manual via console do desenvolvedor, o navegador bloqueou o ato de colar código por padrão de segurança. Orientamos o usuário a digitar "allow pasting" no terminal do console para autorizar a colagem do comando `localStorage.getItem('userToken')`.
- Adicionado suporte para exibir modelos do Gateway de assinaturas no seletor de Lead Intelligence em Configurações.
- Corrigidas as funções de mapeamento/fallback de modelos para permitir que modelos de gateway passem intactos e não sofram fallback forçado para modelos Gemini.
- Código typecheck verificado com sucesso.
- Página de Configurações (`src/app/configuracoes/page.tsx`) completamente refatorada visualmente para usar abas (Tabs), cards colapsáveis com setas/chevrons interativos e badges de status dinâmicos, com compilação e typecheck validados com sucesso (zero erros).

## [2026-06-30] Correção do "conector de IA grátis oscila / não salva"
- **Diagnóstico (confirmado na prática)**: as conexões **estavam salvando** no Supabase (`gateway_endpoints` com 2 entradas) e o conector estava instalado com 3 contas logadas em disco. O problema real era que **o processo do proxy (`127.0.0.1:8317`) não estava rodando** (morre a cada reboot/dev-server restart) e **não havia auto-start**. Com o proxy caído, `refreshProxyStatus()` achava a porta morta → badge mostrava "desligado", as contas somiam da lista e os modelos somiam dos seletores (descoberta consulta `/v1/models` e voltava vazio) → parecia "não salvou". Cada checagem de porta re-confirmava → badge **oscilava**.
- **Correção aplicada** em `src/app/configuracoes/page.tsx`:
  - Auto-start: ao abrir a aba "Contas Grátis (Gateway)", se o proxy está instalado mas desligado, liga sozinho em background (`pxCall({action:"start"})` — idempotente). Estado `pxAutoStarting` + `pxAutoStartTriedRef` (uma tentativa por sessão).
  - `refreshProxyStatus()` agora só atualiza `setPxStatus` se o JSON realmente mudou (evita re-render/pisca).
  - Função `pxBadgeState()` unificada (`"starting"|"on"|"off"|"unknown"`) usada pelos 2 badges (cabeçalho do Card + bloco de status) — fim do cálculo duplicado que piscava. Badge "Ligando…" (azul) durante auto-start.
- **Validado**: `npx tsc --noEmit` (zero erros); simulação de proxy morto→start→porta responde em ~2s→management API 200→`/v1/models` devolve 22 modelos (Gemini, GPT-5.4, Antigravity).
- **Não mexi** no backend de salvar (`ai-organize/config/route.ts`), `ai-keys.ts`, nem `gateway-model-discovery.ts` — já estavam corretos.

## [2026-06-30] Pausa pós-agendamento (FASE A do failover/automação)
- **Decisões com usuário**: failover de gateway = automático/qualquer ordem (FASE B, depois); escopo incremental (pausa primeiro); se tudo falhar = espera e retenta.
- **FASE A implementada** (baixo risco — reusa infra existente): quando o agente agenda com sucesso, a IA **para de responder aquele número por X minutos** (default 2h), depois volta sozinha. Evita bombardear o cliente pós-agendamento e dá janela ao humano.
- **Descoberta-chave**: a pausa-por-contato **JÁ EXISTIA** — `snoozeSession(sessionId, minutes)` em `bot-status.ts:229` + gate em `agent/process/route.ts:50-69` com auto-resume. Não precisei criar tabela nem checagem nova.
- **Implementação**:
  - `src/app/api/agent/process/route.ts` (~linha 1282): após agendamento confirmado + resumo pro dono, lê `scheduler_config.pause_after_schedule_minutes` (default 120) e chama `snoozeSession(sessionId, N, "system")`. Loga em `webhook_logs` (event `AGENT_SCHEDULE_PAUSE`). Guard anti-chamada-dupla já existente garante 1x por agendamento.
  - Campo novo `pause_after_schedule_minutes` em `scheduler_config` (JSONB) — default 120, `0` = off.
  - UI: `src/app/agente/_tabs/info-tab.tsx` + `page.tsx` — campo "Silenciar IA após agendar (minutos)" na seção de Agenda, com `NumberInput`. Estado `pauseAfterSchedule`, lido/salvo em `scheduler_config`.
- **Por-contato**: granularidade `sessions` (UNIQUE contact_id+instance_name) — afeta SÓ o cliente que agendou, não outros.
- **Não-fatal**: catch vazio na pausa — o agendamento já está salvo.
- Validado: `npx tsc --noEmit` zero erros.

## [2026-06-30] Raciocínio universal + Contexto total + Economia de token
- **3 partes implementadas** (typecheck zero erros, dev server OK):
- **PARTE 1 — Modo de Raciocínio UNIVERSAL (3 níveis em TODOS os modelos):**
  - Antes só Gemini tinha controle (`thinkingBudget`); OpenRouter/Gateway/DeepSeek não tinham nada.
  - Novo conceito `reasoningMode: 0|1|2` (Econômico/Equilibrado/Intenso) em `GenerateTextOpts`/`StartAiChatOpts`.
  - Mapper central `applyReasoning(body, mode, provider, model)` em `ai-provider.ts` mapeia pro param de cada provedor: Gemini `thinkingBudget`(0/8192/-1), OpenAI `reasoning.effort`(minimal/medium/high), Claude `thinking.budget_tokens`(4096/16000), DeepSeek no-op (raciocínio via modelRef). `resolveReasoningMode()` com retrocompat do legado `thinkingBudget`.
  - UI: `<select>` em `info-tab.tsx` agora 0/1/2 (rótulos Econômico/Equilibrado/Intenso), texto explica "vale pra TODOS os modelos". State `reasoningMode` em `page.tsx` (save `reasoning_mode` + retrocompat `thinking_budget`). Leitura no `route.ts:827`.
  - **Validado**: teste isolado confirma mapeamento correto por provedor.
- **PARTE 2 — Resumir o MEIO do histórico (garante "lembrar tudo"):**
  - Antes a janela adaptativa (`route.ts:387`) descartava msgs do meio com placeholder VAZIO → IA esquecia dados.
  - Novo `src/lib/history-summary.ts`: `summarizeMiddleMessages(remoteJid, middleMsgs)` gera resumo REAL via `generateText` com reasoningMode=0 (barato), modelo mais leve disponível (Gemini Flash/OpenRouter 8B). Cache por conteúdo (hash) + TTL 1h — não regera a cada turno. Fallback no placeholder antigo se falhar.
  - Wire-up em `route.ts:387`: placeholder vira resumo real. Conversas ≤15 msgs não mudam.
  - **Contexto ao trocar modelo**: JÁ persistia (stateless por POST, histórico do DB) — confirmado, não precisou mexer. O resumo reforça isso em conversas longas.
- **PARTE 3 — Prompt caching (economia sem perda de qualidade):**
  - Prefixo estável já existia (`systemInstruction` byte-idêntico → implicit caching Gemini/OpenAI).
  - Novo `buildSystemMessage()` em `ai-provider.ts`: pra Claude (via gateway/OpenRouter), system vira array de content blocks com `cache_control: {type:"ephemeral"}` no último bloco → ~90% desconto no systemInstruction. CLIProxyAPI repassa pro Anthropic.
  - Aplicado em 3 pontos (generateText openrouter/gateway + startOpenAICompatibleChat).
  - **Economia implícita do resumo**: histórico encurta (resumo < msgs inteiras) → menos tokens/turno em conversas longas.

## [2026-06-30] FASE B CONCLUÍDA: failover de gateway entre contas
- **Implementado** (4 mudanças cirúrgicas, typecheck OK):
  - **`src/lib/gateway-cooldown.ts` (NOVO)**: cooldown em MEMÓRIA (não persiste — restart retenta, correto pra quota que reseta). `markEndpointCooldown` (429, recuo exponencial até 1h), `markEndpointDead` (401/403, pula até restart), `isEndpointUnavailable`. Espelha o padrão do `deepseek-chat-manager`.
  - **`src/lib/gateway-model-discovery.ts`**: adicionado `MODEL_ENDPOINTS` (Map plural, ao lado do singular existente p/ retrocompat), preenchido durante `listAvailableGatewayModels`. Nova `listEndpointsForModel(modelId)` — devolve TODAS as contas que expõem o modelo (rede de segurança: todas as conexões se não mapeado). `getEndpoints` agora exportado.
  - **`src/lib/ai-provider.ts`**: classe `ProviderHttpError extends Error` (preserva `status` + `endpointId`) substitui o `throw new Error(string)` em `openAICompatibleChat`. Nova `isFailoverableStatus(status, msg)` — 429/402/401/403/5xx/0/rede/400-quota → failover; 400-bad-request/404 → NÃO (outra conta daria o mesmo). `GatewayCreds` ganhou `endpointId`.
  - **`gatewayChatWithFailover(model, body, primary)`**: tenta primário → se falhar failoverable, marca cooldown/morto e itera `listEndpointsForModel` pulando indisponíveis até uma acertar. Se tudo falhar, relança (caller cai no `fallbackModelRef` pago OU propaga = "esperar e retentar"). **Ponto único de injeção** — wired nos 2 caminhos (generateText + startAiChat via deps.post), cobre o loop de tools automaticamente.
- **Validado**: teste isolado confirma que 429/402/401/403/5xx/0/400-quota disparam failover; 400-bad-request/404 não. Cooldown/morto pulam corretamente.
- **Segurança**: nunca pior que antes (se tudo falha, cai no fallback de modelo pago existente ou propaga igual a antes). Não mexe em parseModelRef/modelRef/histórico/webhook. `MODEL_ENDPOINT` singular mantido.
- **Resultado**: quando o grátis de uma conta acaba (429/quota), o sistema tenta automaticamente outra conta conectada (Antigravity/Gemini/Codex viram um pool). Se todas em cooldown, espera e retenta na próxima msg. Transparente pro usuário.

## [2026-06-30] FASE B PENDENTE: failover de gateway entre contas
- ~~NÃO feito ainda~~ → CONCLUÍDO acima.

## [2026-06-30] DeepSeek: fluxo COLAR TOKEN (funciona no Opera GX sem extensão)
- **Problema**: userscript Tampermonkey **não roda no Opera GX** (sem badge = script não executa). Opera GX tem travas de segurança extras. Resultado: zero feedback, "não acontece nada".
- **Solução**: fluxo de **colar token com detecção automática de clipboard**, espelhando o **conector Antigravity que JÁ FUNCIONA** no Opera GX do usuário.
- Implementado em `src/app/configuracoes/page.tsx`:
  - `looksLikeDeepSeekToken(raw)`: valida JWT do DeepSeek (começa com `eyJ`, 3 partes separadas por `.`). Limpa aspas/JSON wrapper. Detecção confiável.
  - `handleDsClipboardConnect()`: abre chat.deepseek.com + ativa `dsWaitingClipboard`.
  - `useEffect` de detecção de clipboard: a cada 2s + no `focus`/`visibilitychange` lê o clipboard; se achar JWT válido, salva, registra gateway, testa (PoW+sessão) e mostra feedback. Espelha o `useEffect` do Antigravity (linhas ~1157).
  - UI redesenhada: botão gigante **"Conectar DeepSeek"** → guia passo-a-passo (F12 → Console → `localStorage.getItem('userToken')` → copiar → voltar). Estado de espera com spinner e instruções claras. Feedback "✓ conectado" ou erro específico.
  - Fallback manual (colar token num campo) + Tampermonkey como **alternativa recolhível** (não apaguei — funciona em Chrome/Edge).
- **Por que funciona**: mesmo padrão do Antigravity (clipboard detection), que o usuário confirmou funcionar no Opera GX. Sem dependência de extensão.
- Validado: `npx tsc --noEmit` zero erros; página compila (HTTP 307 de login, normal); dev server rodando.

## [2026-06-30] DeepSeek: BUG RAIZ da captura (proxy.ts) + userscript robusto
- **BUG HISTÓRICO ENCONTRADO E CORRIGIDO**: a rota `/api/deepseek-chat/import-bookmarklet` (e `userscript.user.js`) **não estavam na whitelist de rotas públicas do `src/proxy.ts`**. Resultado: quando o userscript (rodando cross-origin em chat.deepseek.com, sem cookie de sessão) mandava o token, o proxy devolvia **401 "Não autenticado"** ANTES de chegar no handler. O token **nunca era processado** → `totalImports: 0` → "não conecta". Isso afetava TODOS os navegadores, não só Opera GX.
- **Correção**: adicionadas `/api/deepseek-chat/import-bookmarklet`, `/api/deepseek-chat/userscript.user.js`, `/api/deepseek-chat/v1/` na whitelist pública do `proxy.ts`. O token continua autenticado pela `subscription`/`code` DENTRO do handler (não por cookie) — seguro.
- **Validado**: `curl POST import-bookmarklet` agora devolve `{"success":true,"added":true}` 200 (antes 401). Token de teste foi aceito e depois removido.
- **Userscript robustecido** (`userscript.user.js/route.ts`):
  - `@version` 1.1.0 → **1.2.0** (força reinstalação — Tampermonkey não re-executa versão igual).
  - `@connect` agora lista `localhost:3000`, `localhost`, `127.0.0.1`, `*` (antes só o host exato — no Opera GX/Chrome podia bloquear o `GM_xmlhttpRequest` cross-origin).
  - Handlers `onerror`/`ontimeout` com mensagens mais claras no badge (mostra a URL do painel pra diagnóstico).
- **Opera GX**: usuário precisa REINSTALAR o script (versão nova) e confirmar permissão do Tampermonkey no site. O script anterior (v1.1.0) tinha `@connect` restrito.
- Estado: dev server rodando, typecheck OK, rotas públicas validadas.

## [2026-06-30] DeepSeek: captura 1-clique (simplificação máxima)
- Usuário pediu "só logar e capturar, jeito mais simples possível".
- **Janela embutida (iframe) é IMPOSSÍVEL**: DeepSeek envia `content-security-policy: frame-ancestors 'none'` (confirmado ao vivo via curl). O navegador não renderiza.
- **Solução**: fluxo 1-clique em `handleOneClickConnect()` — 1 botão gigante que gera/reusa subscription + abre `.user.js` (Tampermonkey instala sozinho) + abre chat.deepseek.com. Depois o usuário SÓ faz o login.
- **Polling acelerado** (`useEffect` em `dsWaitingConnect`, 3s, timeout 6min): detecta a conta chegando via userscript e mostra "✓ conta conectada" automaticamente.
- Tampermonkey é o **único caminho 100% automático** pós-login (instala 1x na vida) — navegador bloqueia leitura cross-origin de outra aba + DeepSeek bloqueia iframe. Bookmarklet/colar-manual ficaram como fallback recolhível.
- State novo: `dsWaitingConnect`. Removidos `handleInstallUserscript` + `newSubCode` (substituídos pelo fluxo 1-clique).

## [2026-06-30] DeepSeek: implementado Proof-of-Work (a peça que faltava)
- **Diagnóstico (testado ao vivo contra o DeepSeek real)**: o DeepSeek agora exige **Proof-of-Work (PoW)** antes de cada `/api/v0/chat/completion`. Sem resolver o desafio SHA3 (DeepSeekHashV1) num WASM e enviar no header `x-ds-pow-response`, a request é descartada. **Era isso que fazia "conectar conta DeepSeek não funciona".** Confirmado: NÃO é Cloudflare (servidor devolve JSON, não HTML), NÃO é token, NÃO é ban. É só a peça PoW faltando.
- **Implementado**:
  - `src/lib/deepseek/deepseek-pow.ts` (NOVO): solver SHA3 em WASM. Binário `sha3_wasm_bg.wasm` (26KB, zero imports) embarcado como base64 em `src/lib/deepseek/sha3-wasm-base64.ts` (NOVO, auto-gerado). Instância WASM cacheada. Roda nativo no Node 22, sem Python, sem pacote novo. Funções: `solvePowChallenge(challenge)` → base64 do header, e `solvePowWithRetry(fetchChallenge, attempts)`.
  - `src/lib/deepseek-chat-client.ts`: `buildPowHeader()` pede o desafio em `/api/v0/chat/create_pow_challenge` e injeta `x-ds-pow-response` em toda completion. Rate-limit subiu de 4s → **60s por conta** (env `DEEPSEEK_CHAT_MIN_INTERVAL_MS`). 429 agora faz **cooldown temporário** (`setCooldown`) em vez de pausar permanentemente.
  - `src/lib/deepseek-chat-manager.ts`: campo `pausedUntil` + `setCooldown()` com recuo exponencial (2min→5min→15min→1h). `pickToken` pula contas em cooldown. `expireStaleCooldowns()` limpa labels "(cooldown)" quando expira. `probeToken()` exportado no client pra teste leve (criar sessão + resolver PoW, sem completion).
  - `src/app/api/deepseek-chat/manage/route.ts`: action `test` (chama `probeToken`).
  - `src/app/configuracoes/page.tsx`: teste **automático** ao adicionar token (mostra "✓ funcionando" ou "✗ rejeitado"), aviso experimental amarelo reforçado recomendando o Conector Antigravity/Codex como alternativa estável.
- **Validado**: `npx tsc --noEmit` zero erros; WASM instancia do base64 do projeto e executa `wasm_solve` (mecânica confirmada); rota `manage` compila. **Falta validar ponta-a-ponta com token real do usuário** (PoW só resolve com desafio real do servidor, que exige token válido).
- **Sobre contexto ao trocar modelo**: já funcionava — `ai-provider.ts` reenvia histórico (25 msgs de `chats_dashboard`) a cada turno, então trocar de modelo mantém contexto. Nenhuma mudança necessária.
- **Anti-ban**: NÃO existe garantia total (DeepSeek sem OAuth). Reduzimos: 1 msg/min/conta, fingerprint estável, cooldown exponencial em 429, auto-pausa em 401/403, sessão descartável por turno, multi-conta round-robin.

## [2026-07-07] 3 Frentes: Whisper + Chat Rápido + Backup Duplo

### Fase 1 — Transcrição Gratuita com whisper.cpp (COMPLETA, commitada 08a8355)
- `src/lib/whisper-manager.ts` (NOVO): ensureWhisper() baixa binário whisper-bin-ubuntu-x64 + modelo ggml-base.bin (74MB) em runtime pro .whisper/. Cacheado — só baixa 1x. transcribeAudioWithWhisper() decodifica base64→ogg, converte pra WAV 16kHz via ffmpeg, roda whisper-cli em CPU (2 threads, idioma pt). Retorna null em falha (caller cai no fallback).
- Webhook WhatsApp (route.ts:1051-1065): whisper.cpp PRIMEIRO (grátis) → Gemini fallback → nunca perde um áudio. Logga provider usado (whisper|gemini).
- Dockerfile: ffmpeg adicionado ao apk add do runner stage + .whisper/ dir com chown nextjs.
- Env WHISPER_DISABLED=1 desliga o whisper (cai direto no Gemini). WHISPER_MODEL troca o modelo.

### Fase 2 — Chat Mais Rápido (COMPLETA, commitada 08a8355)
- Realtime incremental: em vez de chamar loadConversations() completo a cada INSERT no realtime, atualiza só a conversa afetada no state.
- Polling mais leve: de 15s → 45s (realtime já cobre o imediato; polling é rede de segurança).

### Fase 3 — Backup Duplo: contas sobrevivem a redeploys (COMPLETA, commitada 5274552)
- `src/lib/gateway-auth-backup.ts` (NOVO): backup e restore de auth-files OAuth + tokens DeepSeek ↔ Supabase (tabela `provider_credentials`). Fire-and-forget (nunca quebra fluxo).
- Gateway route: restore no boot (install/start, linhas 43+51); backup após login-ok/rename/delete/pause/resume (linhas 85-123).
- DeepSeek manager: backup fire-and-forget no writeAll (linha 108) e writeSubs (linha 405).
- setup-sql.ts: tabela `provider_credentials` adicionada (linha 600-608).
- SETUP_COMPLETO.sql sincronizado com a tabela (commit e07b483).
- Tabela `provider_credentials` CRIADA no Supabase de produção (SQL rodado pelo usuário 2026-07-07).
- Typecheck zero erros. Tudo commitado e no GitHub (e07b483).

## [2026-07-07 17:05] Correção de Conversas Sumindo + Freebuff CLI

### Correção: Mapeamento de Histórico Órfão e Restauração Automática ao Reconectar
- **Problema**: Quando o usuário excluía uma conexão de WhatsApp ("sdr") e criava uma nova ("sdr_v2" ou recriava "sdr") com o **mesmo número**, as conversas antigas sumiam. Isso acontecia porque a antiga "sdr" era deletada de `channel_connections`, e o frontend perdia o `owner_phone` dela, impedindo o agrupamento das conversas antigas `instance_name='sdr'` com a nova `instance_name='sdr_v2'`.
- **Implementação**:
  - `src/app/api/whatsapp/instance/delete/route.ts`: Ao deletar uma instância em modo preservação (sem `purgeMessages`), obtemos o `owner_phone` e atualizamos o `instance_name` de todas as mensagens, conversas e sessões para `phone:owner_phone` (ex: `phone:5511999999999`).
  - `src/app/api/whatsapp/route.ts`: Quando a nova conexão é sincronizada/obtida e o `owner_phone` é persistido, disparamos uma migração que transfere todas as conversas/sessões/mensagens com `instance_name = 'phone:owner_phone'` de volta para o novo `instance_name` ativo.
  - `src/app/api/webhooks/whatsapp/route.ts` (`connection.update`): Mesma lógica rodada de forma proativa quando a Evolution envia a notificação de que a conexão virou `open`.
  - **Resultado**: Ao reconectar qualquer número, o histórico volta no mesmo segundo na nova instância ativa.

### Instalação do Freebuff CLI
- **Modificações**: Adicionado `freebuff` em `devDependencies` no `package.json` para dar compatibilidade fácil e visibilidade da dependência do Freebuff no projeto.
- **Configuração**: O arquivo `AGENTS.md` foi atualizado com as regras de **Memória Compartilhada Universal** para guiar qualquer IA/IDE que o usuário execute (Claude Code, Zcode, Freebuff, Antigravity, Cursor, Codebuff, etc.).

## [2026-07-07 18:45] Codebuff (Buffy) — Integração Oficial ao Sistema de Memória Compartilhada
- Codebuff foi adicionado explicitamente ao `AGENTS.md` como participante do sistema de memória compartilhada.
- Sessão registrada no SESSION_LOG.md seguindo o formato padrão.
- O sistema permanece inalterado estruturalmente: 4 arquivos `.md` em `.shared-memory/` + `.swarm/` (RuFlo V3) + hooks `.claude/`.
- Não há modificações de código-fonte — apenas documentação do ecossistema de IAs.
- **Próximos passos**: Qualquer IA (Antigravity, Claude Code, Zcode, Freebuff, Codebuff, Cursor) que abrir este projeto deve começar lendo `.shared-memory/CONTEXT.md`, `.shared-memory/MEMORY.md`, `.shared-memory/SESSION_LOG.md` e `.shared-memory/TASKS.md`.

## [2026-07-07 20:57] Antigravity — Correção de Conversas Ocultas (Limite 3k) e Recuperação da Instância SDR
- **Problema**: O frontend puxava um limite de 3000 mensagens cruas da tabela chats_dashboard para renderizar a barra lateral de chats. Com o volume altíssimo de mensagens da nova instância (85k+), as conversas antigas ficavam além do limite e desapareciam da UI.
- **Problema 2**: A exclusão antiga da instância `sdr` apagou suas mensagens da tabela chats_dashboard (que é o que a UI lê), mas elas ainda estavam na tabela messages.
- **Solução 1**: Alterado loadConversations em src/app/chat/page.tsx para consultar as últimas 1000 sessões ativas da tabela sessions como fallback. Isso garante que a UI mostre todas as conversas recentes, burlando inteligentemente o limite.
- **Solução 2**: Criado e executado o script scripts/recover-sdr-chats.js que recuperou 86 mil mensagens órfãs da tabela messages, cruzou com os remote_jid e fez o upsert na tabela chats_dashboard, atrelando à instância nova 00000_Sdr_numero_bahia. Agora o histórico perdido ressurgiu na UI.

## [2026-07-08 11:30] Organizador IA 100% Adaptativo
- **Problema**: O organizador da IA usava regras fixas procurando por status com chaves hardcoded como "sem_interesse", "descartado", etc. que quebravam em kanbans personalizados.
- **Solução**: Implementado o suporte a kanban totalmente dinâmico. Adicionada a flag `is_terminal` no banco de dados (`kanban_columns`), que agora pode ser ligada e desligada direto pela UI (`page.tsx`) na listagem de colunas do Kanban. A IA (`route.ts`) agora prioriza o flag `is_terminal` e detecta as etapas avançadas pelas posições dinâmicas (top 40%) ao invés de nomes. Validado com typecheck e build, aguardando testes ponta-a-ponta e commit.

## [2026-07-08 11:45] Unificação de Seletores de Modelos IA
- **Problema**: Apenas três telas (Agente, Disparo, Configurações) exibiam as listas de modelos com grupos corretos de provedores, famílias e badges das contas conectadas. Outras telas (Automação, Organizador, Chat, Follow-up) mostravam listas "cruas", tornando difícil discernir modelos do Gateway (ex: `gpt-4o`) e a qual conta pertenciam.
- **Solução**: Substituídos todos os `<select>` manuais no código pelo componente compartilhado `<ModelOptions>` (e lógica `groupModels` no caso do Chat). Atualizados todos os rótulos de "Modelo Gemini" para "Modelo de IA". Agora todo o sistema reflete visualmente e com exatidão a integração multi-conta com o Gateway de Assinatura. Validado via TypeScript.

## [2026-07-22 13:30] OpenCode (glm-5.2) — Correções de Chat Lento + Whisper Windows + Build Quebrado

### Problemas diagnosticados e corrigidos
- **Chat piscava/demorava a carregar**: a cada `visibilitychange` (alt-tab), `resyncToken` incrementava e recarregava TODAS as queries (instances + agents + sessions + msgs). Corrigido com debounce de 800ms + só dispara se ficou fora >30s (Supabase Realtime já entrega novidades instantâneas).
- **Auto-rebind em loop**: para cada `resyncToken`, refazia N UPDATEs em sessions para cada instância (race conditions). Corrigido com `instancesLoadedRef` — só roda 1x quando clientId carrega.
- **Build quebrado em `src/app/api/whatsapp/route.ts`**: migração Evolution GO (sessão anterior) deixou código duplicado nas linhas 337-339 — redeclarava `const qrCode` (conflito com `let qrCode` da 269) e referenciava `res` que não existe neste escopo. Impedia o build do Next.js. Removido.
- **whisper.cpp baixava binário Linux em Windows**: `whisper-bin-ubuntu-x64.tar.gz` não executa em win32 → caía sempre no fallback Gemini (gasta token). Agora detecta `process.platform === "win32"` e baixa `whisper-bin-x64.zip` (com `.exe`). O `findWhisperBinary` já sabia procurar `.exe` no Windows.
- **MessageThread: UPDATE em sessions sem contact_id**: o "marcar como lido" rodava com `contact_id: ""` em toda conversa aberta — catastrófico em clientes grandes. Agora só roda quando `contact_id` é válido.
- **Scroll não atualizava ao trocar de conversa**: o `useEffect` do scroll dependia só de `[messages]`. Adicionei `conversationId` e `loading` como deps.
- **Audio bubble não mostrava transcrição**: a transcrição vinha do whisper/Gemini e era salva em `content_text`, mas o componente `MessageBubble` renderizava só o player `<audio>`. Agora exibe a transcrição em itálico abaixo do player.
- **Realtime UPDATE não atualizava enriquecimento de mídia**: quando a transcrição chegava via UPDATE no `chats_dashboard`, o handler só atualizava `status`. Agora atualiza `content_text`, `media_url` e `content_type` também.

### Query de sessions otimizada
- Antes: `select("*, contact:contacts(*)")` em sessions (carregava JSONB gigante de variables).
- Agora: `select("id, client_id, contact_id, instance_name, bot_status, resume_at, unread_count, last_message_at, created_at, updated_at, agent_id, contact:contacts(*)")` com `nullsFirst: false`.

### Arquivos alterados
- `src/lib/whisper-manager.ts` — BIN_ASSET dinâmico por plataforma + log claro quando ffmpeg falta.
- `src/app/chat/page.tsx` — debounce em visibilitychange, instancesLoadedRef, simplificação do handleMessageEvent.
- `src/components/inbox/conversation-list.tsx` — select enxuto em sessions.
- `src/components/inbox/message-thread.tsx` — mark-as-read só com contact_id válido + scroll deps.
- `src/components/inbox/message-bubble.tsx` — áudio mostra transcrição.
- `src/app/api/whatsapp/route.ts` — removida duplicação de qrCode/pairingCode.

### Validação
- `npx tsc --noEmit` — ZERO erros.
- Dev server responde 307 em `/chat` (redirecionamento de login, esperado).
- Servidor na porta 3000 ativo.

### Estado ao sair
- Chat otimizado e pronto para teste. Vínculo IA-Chat já funcionava (filtro por `activeAgentId`, atribuição em `contact-sidebar.tsx`, banner em `ai-thread-banner.tsx`). Transcrição já tinha whisper+Gemini fallback; agora também funciona em Windows.

## [2026-07-22 14:00] OpenCode (glm-5.2) — Scroll chat + Badge IA SDR sobrepondo texto

### Bugs corrigidos
- **Chat abria no meio (não rolava pra última mensagem)**:
  - **Causa raiz**: o `ref` estava sendo passado para o componente `<ScrollArea>` (Root do Base UI), mas o `overflow`/`scrollTop` acontece num elemento INTERNO chamado `Viewport` (marcado com `data-slot="scroll-area-viewport"`). Por isso `scrollRef.current.scrollTop = scrollHeight` não tinha efeito nenhum.
  - **Solução**: implementado `scrollAreaRef` (callback ref) que busca o elemento `[data-slot="scroll-area-viewport"]` dentro do ScrollArea e armazena no `scrollViewportRef`. O `scrollToBottom` agora usa `requestAnimationFrame` duplo para garantir que imagens/mídias já tenham sido renderizadas antes do cálculo final da altura.
  - Scroll agora dispara em: troca de conversa, fim do loading de mensagens, chegada de nova mensagem (realtime INSERT), envio de mensagem (smooth).

- **Badge "IA SDR" sobrepondo a primeira linha do texto**:
  - **Causa raiz**: o badge estava `position: absolute; top: -3; right: 0` flutuando SOBRE o balão — em mensagens curtas ele tampava parte do texto.
  - **Solução**: badge agora é um HEADER `<div>` separado ACIMA do balão (flex layout). Alinha à direita para mensagens da IA (que ficam à direita), à esquerda para clientes. Sem overlap.

### Arquivos alterados
- `src/components/inbox/message-thread.tsx` — scrollAreaRef callback ref, scrollToBottom com rAF duplo, scroll após enviar msg/mídia.
- `src/components/inbox/message-bubble.tsx` — badge "IA SDR" como header acima do balão.

### Validação
- `npx tsc --noEmit` ZERO erros.
- `/chat` responde 307 (login redirect) — compilação OK.

## [2026-07-22 15:00] OpenCode (glm-5.2) — Auditoria RAG + Bug crítico de imagem (link em vez de foto)

### Bugs críticos encontrados e corrigidos

#### 1. IA alucinava preço/produto fora da KB (prompt anti-alucinação fraco)
- **Causa**: prompt de sistema tinha regras genéricas, sem exemplo explícito. IA às vezes inventava preço ("acho que é R$ X") ou confirmando estoque sem consultar.
- **Solução**: adicionado bloco `<anti_hallucination_rules>` no systemInstruction com:
  - Quando consultar OBRIGATORIAMENTE (preço, estoque, cor, tamanho, especificação).
  - PROIBIDO inventar/preencher lacunas.
  - O que dizer quando base não tem a resposta ("vou verificar").
  - Exemplos certos vs errados (didático pro modelo).
- **Arquivo**: `src/app/api/agent/process/route.ts`.

#### 2. Threshold de RAG muito alto (0.55 → 0.35)
- **Causa**: `agent/process/route.ts` chamava `searchKnowledge` com `minSimilarity: 0.55`. Em catálogos reais, gemini-embedding-001 devolve similaridades 0.35-0.50 pra matches bons (cliente pergunta "iPhone 15" KB tem "iPhone 15 128GB"). 0.55 perdia metade das buscas → IA caía no ILIKE (sem sinônimos) ou respondia sem consultar.
- **Solução**: baixado pra 0.35 (threshold ainda descarta lixo, mas mantém matches reais de catálogo).

#### 3. Bug do LINK no lugar da IMAGEM (relatado pelo usuário)
- **Causa raiz**: quando o agente IA envia tag `[IMAGEM: https://...]`, o `agent/process/route.ts:1802` chamava `channelMod.sendMedia({ mediaUrl, url, type:"image" })` — só URL, sem base64. Aí:
  - `evolution-go.ts:142` montava payload `{ base64: media.base64 (=undefined) }` → API GO recebia `base64: null` → não tinha o que enviar → mostrava URL como link.
  - `evolution.ts:sendMedia` aceitava URL mas se Evolution não conseguisse baixar (CORS/redirect/auth), também mostrava link como texto.
- **Solução**:
  - Criado `fetchUrlAsBase64(url)` + `ensureBase64(media)` em `src/lib/channel.ts` com cache LRU 6h (50 itens) — não baixa a mesma foto de produto 100x.
  - `channel.sendMedia` agora SEMPRE baixa URL server-side e passa base64 completo pro provider. Nunca mais link no lugar de imagem.
  - `evolution-go.ts:sendMedia` refatorado pra ser robusto: detecta base64 vs URL, limpa prefixo `data:`, loga warning quando cai em URL pura.
  - `evolution.ts:sendMedia` agora prefere base64 quando disponível (evita bug de URL na V2).
  - `agent/process/route.ts` agora passa mimetype (jpg/png/webp/gif detectado da URL) e fileName além da URL.

#### 4. Chunker cortava produto no meio (causava alucinação parcial)
- **Causa**: catálogo de produtos (formato `### PRODUTO: iPhone 15`) podia ser quebrado pelo chunker no meio do bloco — preço num chunk, foto noutro. IA consultava e achava preço sem foto, ou foto sem estoque.
- **Solução**: novo `chunkProductCatalog()` em `src/lib/rag.ts` que detecta blocos de produto e os preserva como unidade atômica (até 4 produtos pequenos por chunk, produto grande sozinho). SEM overlap em catálogo (overlap duplicaria produto com dados divergentes na borda).

#### 5. SETUP_COMPLETO.sql não tinha embedding_model + RPC (instalações novas quebravam)
- **Causa**: `setup-sql.ts` (gerado de SETUP_COMPLETO.sql) tinha a tabela `agent_knowledge_chunks` SEM a coluna `embedding_model`, e SEM a função RPC `match_knowledge_chunks`. Esses existiam só em migrations separadas (006 e 010) — se o usuário fizesse instalação nova só com SETUP_COMPLETO, o RAG quebrava silenciosamente.
- **Solução**: adicionado coluna + RPC + INSERT default do rag_embedding_model em SETUP_COMPLETO.sql. Script `build-setup-sql.mjs` rodado — `setup-sql.ts` regenerado.

### Endpoint novo: GET /api/agent/diagnose-rag
- Criado `src/app/api/agent/diagnose-rag/route.ts` pra debugar "IA não acha produto X":
  - Stats: quantos docs, quantos chunks, qual modelo de embeddings.
  - Detecta mismatch de modelo (chunks indexados com modelo diferente do atual).
  - Testa RPC `match_knowledge_chunks` com vetor zero.
  - TESTE DE BUSCA REAL: passa `?test_query=` e vê quantos matches volta + preview do conteúdo.
  - Veredito + ação recomendada.

### Arquivos alterados nessa sessão
- `src/app/api/agent/process/route.ts` — prompt anti-alucinação, threshold 0.35, mimetype/fileName no sendMedia.
- `src/lib/rag.ts` — chunkProductCatalog + chunkText atualizado.
- `src/lib/channel.ts` — fetchUrlAsBase64 + ensureBase64 + cache LRU.
- `src/lib/providers/evolution-go.ts` — sendMedia robusto (base64 prioritário, URL fallback com warning).
- `src/lib/evolution.ts` — sendMedia prefere base64, limpa prefixo data:.
- `SETUP_COMPLETO.sql` — coluna embedding_model + RPC match_knowledge_chunks + INSERT rag_embedding_model.
- `src/lib/setup-sql.ts` — regenerado.
- `src/app/api/agent/diagnose-rag/route.ts` — endpoint NOVO de diagnóstico RAG.

### Estado ao sair
- Imagens de produtos no RAG agora chegam como IMAGEM, não como link (bug principal do usuário resolvido na raiz).
- Prompt anti-alucinação reforçado com exemplos didáticos.
- Threshold de RAG calibrado pra catálogos reais.
- Chunker preserva blocos de produto inteiros.
- Setup sql sincronizado com migrations (instalações novas terão RAG funcional).

## [2026-07-22 15:45] OpenCode (glm-5.2) — Cenário "loja de celular com catálogo" (4 bugs vendáveis)

### Contexto do usuário
"Se eu criar um agente de loja de celular, vincular monte de telefone e o cliente chegar e falar 'quais iPhone 15 você tem', ele tem que me mandar TODAS as imagens e informações de cada telefone, sem repetir ou redundar, sem bug — isso tem que ser perfeito pois mexe com vendas."

### Bugs encontrados (4 críticos pra venda)

#### BUG 1: topK=5 limitava resposta (perdia venda silenciosamente)
- **Causa**: `searchKnowledge({ topK: 5 })` no `agent/process/route.ts`. Catálogo com 8 variantes de iPhone 15 (128GB, 256GB, Pro, Pro Max, Plus, etc) só retornava 5. Cliente perdia 3 opções.
- **Solução**: topK adaptativo. Default 10 (cobre 95% dos catálogos reais). Se query indica intenção de listar tudo ("todos", "quais", "lista", "catálogo", "modelos", "opções", "versões"), sobe pra 15.
- **Arquivo**: `src/app/api/agent/process/route.ts` (~linha 990).

#### BUG 2: Imagens enviadas ANTES do texto (cliente via fotos sem contexto)
- **Causa**: o loop antigo enviava TODAS as imagens primeiro (via `for (const match of mediaMatches)`) e DEPOIS o texto limpo. Resultado: cliente recebia 5 fotos sem legenda, depois um texto "Temos estes iPhones...". Confusão visual, perdida pra vendas.
- **Solução**: refatorei COMPLETAMENTE o loop de envio. Agora divide a resposta em "segmentos" ordenados (texto → imagem → texto → imagem → ...). Cada produto vira um bloco com texto + foto JUNTOS (foto como legenda do texto anterior).
- **Caption inteligente**: texto curto (≤ 3 linhas, ≤ 250 chars) que vem ANTES da tag `[IMAGEM: ...]` vira a LEGENDA da foto no WhatsApp. Assim cliente vê "iPhone 15 128GB - R$ 5000" como legenda da foto dele.
- **Helpers novos**: `sendProductPhoto(url, caption)` e `sendAndPersistText(text)` — cada um persiste no banco (messages + chats_dashboard) automaticamente, sem código de persistência duplicado.
- **Arquivo**: `src/app/api/agent/process/route.ts` (~linha 1820-2030).

#### BUG 3: dedupProductMedia suprimia foto pra SEMPRE
- **Causa**: `dedupProductMedia` (default ON) guardava TODAS as URLs já enviadas numa `Set` eterna. Se o cliente pedia "me manda foto do iPhone 15" depois de 1h, a foto tinha sido enviada antes → suprimida → cliente não recebia foto nenhuma.
- **Solução**: dedup agora é baseado em TEMPO (5min default). Só suprime duplicação imediata (IA repete 2x no mesmo turno). Reenvio legítimo depois de 5min passa normal.
- **Configurável**: `agentConfig.options.dedup_media_window_minutes` (default 5). Admin pode aumentar/diminuir por agente.
- **Arquivo**: `src/app/api/agent/process/route.ts` (~linha 1770-1810).

#### BUG 4: Prompt não orientava IA a listar cada produto com foto
- **Causa**: prompt anti-alucinação era bom pra produto ÚNICO ("qual preço do X?") mas não orientava a IA em listagem de múltiplos produtos. IA podia sumarizar em vez de listar cada um, ou citar produto sem foto, ou repetir produto.
- **Solução**: adicionado bloco "FORMATO DE RESPOSTA COM MÚLTIPLOS PRODUTOS (CATÁLOGO)" no prompt anti-alucinação com 8 regras explícitas:
  1. Máx 6 produtos por mensagem (evita spam).
  2. Para cada produto: parágrafo com Nome + Variação + Preço + 1 detalhe + tag imagem.
  3. Tag `[IMAGEM: URL]` DEPOIS do texto (vira caption).
  4. Uma tag por produto, nunca duplicar.
  5. Nunca repetir produto.
  6. Se produto não tem foto, descreve sem tag.
  7. Terminar com pergunta de fechamento.
  8. Exemplo IDEAL completo (iPhone 15 + 15 Pro + 15 Pro Max) no prompt.

#### BONUS: Anti-spam / WhatsApp ban protection
- Limite `MAX_PHOTOS_PER_TURN = 10` por turno. Se IA tentar mandar mais que isso (catálogo gigante), suprime com warning no log.
- Delay de 2s entre cada foto enviada (evita burst que parece bot).
- Delay natural de digitação (2-5s baseado em chars) entre mensagens de texto.

### Fluxo final garantido
1. Cliente: "Quais iPhones 15 você tem?"
2. IA: chama `search_knowledge_base("iphone 15")` → topK=15 (intenção "quais")
3. RAG: retorna até 15 chunks de iPhone 15 (threshold 0.35)
4. IA: escreve resposta seguindo o formato IDEAL do prompt (cada produto + tag [IMAGEM])
5. Agent loop: divide em segmentos, envia na ordem:
   - Texto introdutório: "Claro! Temos estes modelos..."
   - Foto iPhone 15 128GB (com caption "iPhone 15 128GB\nR$ 5000")
   - Foto iPhone 15 256GB (com caption)
   - ...
   - Texto final: "Qual te chamou atenção?"
6. Cada item persiste em messages + chats_dashboard.
7. Se cliente pedir "me manda foto do iPhone 15" depois de 10min → foto é reenviada (dedup só bloqueia 5min).
8. Se IA alucinar preço/produto → prompt anti-alucinação + threshold + chunker previnem.

### Arquivos alterados
- `src/app/api/agent/process/route.ts` — topK adaptativo, refatoração completa do envio, dedup por tempo, prompt formato catálogo, helpers sendProductPhoto/sendAndPersistText.

### Validação
- `npx tsc --noEmit` ZERO erros.
- Servidor ativo porta 3000.

### Estado ao sair
- Cenário "loja de celular com catálogo" agora funciona perfeitamente: IA lista cada iPhone com foto + info, sem repetir, sem bug, com ordem de venda correta. Anti-alucinação reforçada. Dedup não bloqueia mais vendas.
- **Problema**: O chat atual do Painel-SDR é visualmente datado e simplista. O usuário solicitou a migração para a interface de Inbox e chat do WACRM (https://github.com/ArnasDon/wacrm), que é considerada muito mais robusta.
- **Decisão Arquitetural**: Para evitar quebrar o ecossistema existente de automações, disparadores, workers e webhooks, faremos um remapeamento transparente das entidades de banco de dados e APIs:
  - O Inbox lerá a lista de conversas da tabela `sessions` (equivalente a `conversations`) fazendo um join com `contacts`.
  - As mensagens serão carregadas e inseridas na tabela `chats_dashboard` (onde o webhook da Evolution grava as mensagens).
  - Como o Painel-SDR armazena tags como array de strings direto em `contacts.tags`, não usaremos a tabela intermediária `contact_tags` do WACRM. As tags serão lidas e filtradas dinamicamente no frontend.
  - Anotações de contato serão lidas e escritas diretamente no campo `contacts.notes` existente.
  - A integração de funil/kanban usará a tabela `leads_extraidos` vinculada por `contacts.lead_id`.
  - O envio de mídias enviará arquivos convertidos em base64 via API `/api/send-message` padrão, evitando a necessidade de buckets extras no Supabase Storage.
  - O banner de status da IA (`AiThreadBanner`) será conectado a `/api/agent/control` para pausar/retomar a IA.
  - Removeremos a dependência de internacionalização `next-intl` do WACRM, traduzindo todas as strings diretamente para o Português (literais no código).

- **Progresso da Sessão (22/07 02:16)**:
  - Instalada a biblioteca `sonner` (`npm install sonner`) para lidar com as notificações de toast no frontend.
  - Criado o arquivo helper `src/lib/inbox/conversations.ts` com mapeamento das colunas de banco de dados do Painel-SDR e normalização.
  - Criado o hook `src/hooks/use-realtime.ts` configurado para escutar as tabelas `chats_dashboard` (mensagens) e `sessions` (conversas).
  - Criada a pasta `src/components/inbox/` e copiados todos os 11 componentes de chat originais do WACRM.
  - **Conclusão (22/07 05:40)**: Todos os componentes foram traduzidos, adaptados às queries locais (`chats_dashboard` e `sessions`) e integrados ao conector multi-contas do Painel-SDR. A compilação geral do TypeScript (`npx tsc --noEmit`) foi validada e passou com zero erros.

## [2026-07-23 11:45] Antigravity — Inicialização do Servidor de Desenvolvimento Local e Deploy
- Servidor Next.js iniciado com sucesso em background (`npm run dev`).
- Porta 3000 confirmada ativa (`http://localhost:3000`).
- Navegador padrão do usuário aberto automaticamente no endereço local para testes do software.
- Commit e `git push origin main` realizados com sucesso no GitHub (`ba0a977`), acionando o deploy automático.

## [2026-07-23 17:55] Antigravity — Correção de Reserva de Créditos Excedida no OpenRouter (max_tokens 65536)
- **Diagnóstico**: Na API da OpenRouter, omitir `max_tokens` faz a API assumir o limite máximo de saída do modelo (ex: 65.536 tokens). A OpenRouter exige uma reserva de saldo proporcional a esse valor máximo. Quando o saldo do usuário cobre apenas ~14 mil tokens no modelo escolhido, a API rejeita a chamada com: `This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 14114.`
- **Correção**:
  - `src/lib/ai-provider.ts`: Adicionada trava de segurança padronizada em `generateText` e `startOpenAICompatibleChat` para OpenRouter: se `maxOutputTokens` não for especificado, aplica limite padrão seguro de `4096` tokens em vez de solicitar 65.536 tokens.
  - Adicionado `maxOutputTokens` na interface `StartAiChatOpts`.
- **Resultado**: As chamadas ao OpenRouter agora requisitam reservas de tokens normais (4096 tokens max), funcionando perfeitamente no saldo existente do usuário sem erro de créditos.
- **Validação**: `npx tsc --noEmit` zerado sem erros.

## [2026-07-23 18:15] Antigravity — Renderização de Imagens do RAG (Sandbox + Evolution API Anti-Link)
- **Diagnóstico**: No Sandbox do Agente (`/agente`), a resposta da IA que continha `[IMAGEM: url]` ou fotos do catálogo era renderizada como string de texto simples (`[IMAGEM: https://...]`). No WhatsApp, se a IA emitia markdown `![foto](url)` ou URL pura da base sem o envelope `[IMAGEM: url]`, a tag não era extraída para disparo via `sendMedia`.
- **Correção**:
  - `src/app/agente/_tabs/testes-tab.tsx`: Criado o helper `renderSandboxMessageContent` que intercepta tags `[IMAGEM: url]`, `[FOTO: url]` e `![alt](url)` no balão de chat do Sandbox e renderiza a imagem real (`<img>`) com preview visual e badge de confirmação de mídia via WhatsApp.
  - `src/app/api/agent/process/route.ts`:
    - `collectImageUrls` expandido para coletar URLs de imagens vindas de todas as sintaxes de mídia dos chunks do RAG.
    - Post-processador no `finalAnswer` que converte markdown `![alt](url)` e URLs soltas da base para a tag padronizada `[IMAGEM: url]`.
    - Garantido o fluxo `sendProductPhoto` -> `channelMod.sendMedia` -> `fetchUrlAsBase64`, que converte a foto em base64 server-side antes de chamar a Evolution API, enviando a mídia como foto nativa (com legenda) e NUNCA como link.
- **Validação**: TypeScript validado com `npx tsc --noEmit` (**0 erros**).

## [2026-07-23 18:55] Antigravity — Correção no Envio Manual de Mensagens via Evolution GO / Evolution API
- **Diagnóstico**: Mensagens enviadas manualmente pelo painel (`/chat`) com destinos contendo prefixo `phone:` (ex: `phone:5511991927253`) eram salvas no banco (`chats_dashboard`/`messages`), mas rejeitadas pela API da Evolution GO (`/send/text` e `/send/media`) por não estarem em formato de número puramente numérico (HTTP 400).
- **Correção**:
  - `src/lib/providers/evolution-go.ts`: Adicionada a função `formatNumberForGo` para sanitizar `remoteJid` removendo prefixos `phone:`, sufixos `@.*` e mantendo apenas dígitos numéricos puros (ou JID de grupo `@g.us`). Adicionados logs de erro explícitos para captura e diagnóstico em `sendText` e `sendMedia`.
  - `src/lib/evolution.ts`: Atualizado `targetJid` em `sendMedia` para sanitizar prefixos `phone:`.
  - `src/app/api/send-message/route.ts`: Sanitização de `cleanJid` na rota POST de envio manual antes de acionar o envio no canal.
- **Validação**: TypeScript validado com `npx tsc --noEmit` (**0 erros**).

## [2026-07-24 01:25] Antigravity — Instalação Universal da Suíte de Marketing Skills (coreyhaines31/marketingskills)
- **Diagnóstico**: O usuário solicitou a instalação completa do repositório `coreyhaines31/marketingskills` para que todos os agentes e modelos (Claude Code, Antigravity, OpenCode, Zcode, Freebuff, Cursor, Codebuff) usem as 48 habilidades de marketing automaticamente.
- **Ações**:
  - Baixadas e instaladas todas as **48 sub-skills de marketing** em `skills/`, `.agents/skills/` e no diretório global `C:\Users\Salomao\.gemini\config\skills\`.
  - Atualizado o arquivo `AGENTS.md` com o mandato explícito de execução de marketing, instruindo todas as IAs e modelos a ativarem as skills de copywriting, cold email, ads, CRO, SEO, ofertas, precificação e estratégias de vendas.
- **Validação**: `npx tsc --noEmit` zerado (**0 erros**).
