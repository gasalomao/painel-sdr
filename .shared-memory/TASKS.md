# Tarefas do Projeto

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

