# Memória Persistente do Projeto

- **Tecnologias**: Next.js 16.2.3, React 19, Supabase, Redis (BullMQ), TailwindCSS.
- **Banco de Dados**: Supabase (com Realtime habilitado na tabela `n8n_chat_histories` para chat).
- **Hospedagem**: Easypanel na Hostinger.
- **Estrutura de Build**: Build com Dockerfile e Build Args para injeção de variáveis públicas do Supabase em tempo de compilação.
- **Redis**: O aplicativo possui tratamento de erros robusto para conexão de Redis para evitar crashes locais.

---

## Arquitetura de provedores de IA

- **Roteador central**: `src/lib/ai-provider.ts` decide Gemini × OpenRouter × Gateway baseado no prefixo do `modelRef` (`openrouter:`, `gateway:`, sem prefixo = Gemini).
  - **Caminho crítico** — qualquer mudança ali afeta Agente IA, Disparo, Follow-up, Organizador IA, Inteligência de Cliente. Tocar só com OK explícito do usuário.
- **Chaves**: lidas em `src/lib/ai-keys.ts` (cache 30s) de `ai_organizer_config` (id=1) no Supabase. Campos: `api_key` (Gemini), `openrouter_api_key`, `gateway_endpoints` (JSON array de conexões).
- **Modelos**: descoberta dinâmica em `src/lib/gateway-model-discovery.ts` (TTL 10min) — bate em `{baseUrl}/models` de cada gateway endpoint. Cada modelo carrega o id da conexão de origem.
- **Agrupamento**: `src/lib/model-grouping.ts` (puro, sem React). Provedores ordenados gemini → openrouter → gateway. Subgrupos por família (Claude, Gemini, GPT, etc) ou "Grátis" (OpenRouter `:free`).
- **Seletor compartilhado**: `src/components/ai-module-shared.tsx` exporta `AIModelSelect` (dropdown rico com busca) e `ModelOptions` (optgroup nativo).

## Conector OAuth de assinaturas (CLIProxyAPI)

- Painel baixa e roda o binário `CLIProxyAPI` localmente em `.gateway-proxy/` (porta 8317). Gerenciado por `src/lib/gateway-proxy-manager.ts`.
- Management API em `http://127.0.0.1:8317/v0/management/*` — autenticada por `management.key` random gerada na instalação.
- Suporta Gemini (gemini-cli), Claude (anthropic), OpenAI (codex), Antigravity. Cada login OAuth gera um arquivo em `auths/<provider>-<email>-<sufixo>.json`.
- Multi-conta funciona NATIVAMENTE no binário — rotaciona round-robin sozinho.
- **Sidecars locais** (não tocam Supabase):
  - `auth-meta/<file>.json` — apelido + createdAt
  - `auths-paused/<file>.json` — contas "estacionadas" (proxy não usa, login fica salvo)
- Path traversal bloqueado por `safeAuthName()` em todas as actions de management.

## DeepSeek "modo conta" (reverse-engineering — isolado)

- **Por que separado**: chat.deepseek.com NÃO tem OAuth oficial como os outros. Usa o `userToken` da sessão web. Reverse-engineering — risco de ban real, isolado pra não levar nada junto se quebrar.
- **Chaves em localStorage**: chat.deepseek.com armazena o token na chave `userToken` envolvido em uma string JSON `{"value": "eyJhbGci..."}`. O script de captura e o backend devem decodificar e limpar este JSON para extrair o JWT puro.
- **Arquivos**: tudo em `src/lib/deepseek-chat-*.ts` + `src/app/api/deepseek-chat/*`. Zero acoplamento com gateway-proxy-manager.
- **Storage local**: `.deepseek-chat/tokens.json` + `subscriptions.json` (sem Supabase).
- **Proteções**: rate-limit 4s/token (env `DEEPSEEK_CHAT_MIN_INTERVAL_MS`), HTTP proxy via `DEEPSEEK_HTTP_PROXY`, fingerprint estável por conta, auto-pausa em 401/403/429.
- **Captura do token**:
  - Userscript Tampermonkey (recomendado, automático) — subscription long-lived idempotente.
  - Bookmarklet — code 15min single-use.
  - Manual — paste do localStorage.
- **Rota OpenAI-shape**: `/api/deepseek-chat/v1/{models,chat/completions}` — auto-registrada como gateway endpoint (origin do painel) ao adicionar 1º token.
- **Linha ética sustentada**: NÃO implementar fazenda de contas, turnstile solver, headless browser, fingerprint randomization completo. Foi recusado explicitamente nesta sessão.

## Padrões de storage no painel

- **Configurações de IA** (api keys, gateway endpoints, modelos default): `ai_organizer_config` (id=1) — Supabase. Cache 30s in `ai-keys.ts`, invalidado em qualquer PATCH.
- **Estado do conector OAuth**: arquivos em `.gateway-proxy/` no FS local (binário, key, auths). NÃO Supabase.
- **DeepSeek modo conta**: arquivos em `.deepseek-chat/` no FS local. NÃO Supabase.
- **Tudo file-based usa fallback de pasta**: env → cwd → tmpdir (em `resolveBaseDir`). Funciona em Docker com permissão correta.

## Convenções de UI (Configurações)

- Organização geral em 4 abas (Tabs): "Chaves API & Banco", "WhatsApp (Evolution)", "Contas Grátis (Gateway)", e "Modelos Ativos".
- Seções organizadas em `<Card>` por tópico, agora 100% colapsáveis ao clicar no cabeçalho, com chevrons giratórios de estado (`ChevronRight` / `ChevronDown`) e badges coloridos de status dinâmicos (`Ativa`, `Opcional`, `Banco Pronto`, `Conectado`, `Ligado`, `Ativo`).
- Conexões "1 clique" no card do Gateway (botões coloridos por provedor).
- Detalhes secundários em `<details>` recolhível.
- Erros em banners vermelhos com ícone + whitespace-pre-wrap.
- Loading states com `Loader2` da lucide-react animado.
- Apelido editável: input inline com botão "Salvar" que só aparece quando dirty.
