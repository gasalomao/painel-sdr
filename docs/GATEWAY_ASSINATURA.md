# Gateway de Assinatura — usar contas no lugar de API key

Este guia explica como usar suas **contas / assinaturas** de IA (Google Gemini,
Anthropic Claude, OpenAI ChatGPT) dentro do painel **sem gastar crédito de API** —
como se você estivesse usando pelo site/app oficial. É **100% opcional**: se você
não configurar nada, tudo continua funcionando com API key (Gemini / OpenRouter)
exatamente como antes.

---

## 1. A ideia em uma frase

Em vez de o painel chamar a API paga de cada provedor, ele chama um **proxy local
OpenAI-compatível** que você roda na sua máquina/servidor. Nesse proxy você faz
**login nas suas contas** (Gemini, Claude, ChatGPT). O proxy traduz as chamadas e
responde usando a sua assinatura. Para o painel, é só mais um "provedor de modelos".

```
  Painel SDR ──HTTP──> Proxy local (OpenAI-compatível) ──login──> Suas contas: Gemini, Claude, ChatGPT
  (gateway:...)         http://localhost:8317/v1                   (assinaturas, sem crédito de API)
```

Dá pra conectar **mais de uma conta ao mesmo tempo** — uma conexão por conta. O
painel junta os modelos de todas e roteia cada chamada para a conta certa (ver §5).

> 🚀 **Atalho:** na maioria dos casos você não precisa instalar nada na mão — use
> o **modo 1 clique** (§3), em que o próprio painel instala o proxy e abre o login.

O painel conversa com o proxy usando o **mesmo protocolo do OpenRouter**
(`/v1/chat/completions` + `/v1/models`). Por isso, tool-calling, contagem de
tokens e preservação de contexto continuam funcionando igual — nada se perde.

---

## 2. Por que isso "nunca quebra"

Ao configurar o gateway você define um **modelo de fallback** (ex.:
`gemini:gemini-2.5-flash`). Se o proxy estiver:

- fora do ar (você não subiu o processo),
- deslogado (a sessão da conta expirou), ou
- sem cota (atingiu o limite da assinatura),

o painel **cai automaticamente** no modelo de fallback (via API key) e responde
ao usuário normalmente, sem erro. A troca acontece de forma transparente e
**só no início de uma conversa** — nunca no meio, para não perder contexto.

---

## 3. Conectar em 1 clique (recomendado — o painel faz tudo)

Se o painel roda num **computador/servidor próprio** (seu PC, uma VPS — não
hospedagem serverless tipo Vercel), você não precisa instalar nada na mão:

1. Vá em **Configurações → Gateway de Assinatura → "Conectar conta em 1 clique"**.
2. Clique em **Conectar conta Gemini / Claude / ChatGPT**.
3. No primeiro clique o painel **baixa, configura e liga** o conector
   (CLIProxyAPI oficial, direto do GitHub) sozinho — só a primeira vez demora
   (~1 minuto, é o download).
4. Abre uma aba com a **página de login oficial** do provedor (Google /
   Anthropic / OpenAI). Faça o login normal da sua assinatura.
5. Volte pro painel: ele **detecta o login, salva a conexão sozinho** e os
   modelos da conta aparecem no grupo "Gateway (Assinatura)" de todos os
   seletores. Pronto — sem gastar API.

Quer mais de uma conta? **Repita o clique** pros outros provedores — todas
ficam no mesmo conector, numa única conexão salva ("Conector local (painel)").

> 💰 **Funciona com conta grátis?** Depende do provedor (regra deles, não do
> painel): **Gemini = sim** — conta Google grátis já dá uma cota generosa via
> Gemini CLI (≈60 req/min, 1.000 req/dia). **Claude** exige assinatura
> **Pro/Max** (conta free loga mas não autoriza uso). **ChatGPT** exige
> **Plus ou superior** (o login Codex não está disponível no plano free).

Como funciona por baixo (transparência):

- O conector é instalado em `.gateway-proxy/` dentro da pasta do painel e escuta
  **só em localhost** (`http://127.0.0.1:8317`).
- Instalar/ligar/login passam pela rota interna `/api/gateway-proxy`
  (**só admin**). A chave de gerenciamento do conector fica **no servidor** — o
  navegador nunca a vê.
- No mesmo card há **Ligar/Desligar conector** e **Atualizar status**. Se a
  máquina reiniciar e o conector estiver desligado, clique em **Ligar conector**
  — ou direto em "Conectar conta", que ele liga sozinho antes do login.

> 💻 **Painel rodando em servidor/VPS (não no seu PC)?** Depois que você loga,
> o provedor redireciona para `http://localhost:1455/...` (ChatGPT; Gemini usa
> `:8085`, Claude `:54545`) — esse "localhost" é o do **servidor**, então a sua
> aba mostra **"localhost recusou a conexão" (ERR_CONNECTION_REFUSED)**. **É
> esperado e não é falha do login**: copie a **URL inteira** da barra de
> endereço dessa aba e cole no campo do aviso azul ("…cole aqui") no painel,
> depois clique em **Concluir login**. O servidor entrega o código ao conector
> e o resto segue automático.

> 🐳 **Painel em Docker/Easypanel:** monte um **volume** na pasta
> `.gateway-proxy/` do app — é onde ficam o binário do conector e os logins
> (`auths/`). Sem volume, cada deploy/restart do container apaga tudo e você
> precisa conectar as contas de novo.

> 🛑 **Hospedagem serverless (Vercel etc.):** não dá pra rodar processo
> persistente — o botão avisa com uma mensagem clara. Nesse caso use o **modo
> manual** (§4): rode o proxy em qualquer máquina sua e cadastre a URL.

---

## 4. Modo manual — rodar o proxy você mesmo (CLIProxyAPI)

> 💡 O modo 1 clique (§3) faz exatamente isto automaticamente. Este capítulo é
> pra quem prefere controlar o proxy por conta própria (outra máquina, Docker,
> painel em serverless).

Recomendamos o **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)**
(open-source), que embrulha os logins do Gemini CLI / Claude Code / Codex CLI em
endpoints compatíveis com OpenAI. Qualquer proxy que exponha
`/v1/chat/completions` e `/v1/models` no formato OpenAI também serve.

> ⚠️ Os comandos exatos mudam conforme a versão do proxy. Use o README do projeto
> como fonte da verdade. O fluxo geral é sempre este:

1. **Instale** o proxy (binário, Docker ou `go install`, conforme o projeto).
2. **Faça login** nas contas que você quer usar. Cada provedor tem seu comando de
   login, que abre o navegador para você autenticar com a conta da assinatura:
   - Google Gemini (sua conta Google / Gemini Advanced)
   - Anthropic Claude (sua conta Claude Pro/Max)
   - OpenAI ChatGPT (sua conta ChatGPT Plus)
3. **Suba o servidor**. Por padrão ele escuta em algo como
   `http://localhost:8317`. O endpoint OpenAI fica em `http://localhost:8317/v1`.
4. (Opcional) Defina um **token/chave** de acesso ao proxy, se quiser proteger o
   endpoint. Muitos setups locais não exigem chave.

Dica de produção: rode o proxy como serviço (systemd, Docker `restart: always`,
PM2) para ele subir junto com a máquina e ficar sempre disponível.

---

## 5. Configurar no painel (uma ou VÁRIAS contas)

> No modo 1 clique esta parte é **automática** (a conexão "Conector local
> (painel)" é criada e salva sozinha). Os passos abaixo são pro modo manual —
> ou pra revisar/editar o que foi salvo.

Vá em **Configurações → Gateway de Assinatura (contas, sem API)**. A área é uma
**lista de conexões** — cada conexão é uma conta. Você pode ter **várias ao mesmo
tempo** (ex.: Gemini + Claude + ChatGPT).

Para cada conta:

1. Clique em **Adicionar conexão** (ou no atalho **+ Gemini / + Claude / + ChatGPT**,
   que já preenche o apelido).
2. Preencha os campos:

   | Campo | O que é | Exemplo |
   |---|---|---|
   | **Apelido** | nome livre só pra você identificar | `Claude Pro` |
   | **URL do proxy** | endereço do proxy, terminando em `/v1` | `http://localhost:8317/v1` |
   | **Chave do proxy** | token do proxy, **se** você configurou um | *(em branco se não exige)* |

3. Clique em **Testar** naquela conexão (faz um `GET /v1/models` e conta quantos
   modelos ela expõe).

Embaixo da lista há um campo único de **Modelo de fallback** (vale para todas as
conexões). Por fim clique em **Salvar conexões**.

> **Um proxy ou vários?** Tanto faz. Um único CLIProxyAPI pode logar em várias
> contas e expor tudo numa URL só — nesse caso, **uma conexão** já basta e os
> modelos das três contas aparecem juntos. Se preferir isolar, rode um proxy por
> conta (portas diferentes) e cadastre **uma conexão por URL**. Os dois jeitos
> funcionam; o painel roteia cada modelo para a conta certa automaticamente.

> Apenas **admin** pode configurar o gateway (é uma credencial compartilhada por
> todo o sistema, igual às API keys).

As conexões ficam salvas no banco (`ai_organizer_config.gateway_endpoints`, um
JSON com `{id, label, base_url, api_key}` por conta) + `gateway_fallback_model`.
As colunas antigas `gateway_base_url`/`gateway_api_key` continuam aceitas (uma
config antiga de conexão única vira automaticamente a primeira conexão da lista).
Se o seu banco ainda não tem a coluna `gateway_endpoints`, rode a atualização de
schema em **Configurações → Banco de dados** (o SQL é idempotente — pode rodar de
novo sem risco).

> 🔒 **Chaves preservadas:** ao reabrir a tela, o campo de chave de cada conexão
> vem **vazio** (a chave é secreta e nunca volta pro navegador) — mas continua
> salva. Só digite de novo se quiser **trocar** a chave; salvar sem digitar mantém
> a que já estava.

---

## 6. Como usar (e como alternar entre conta e API)

Depois de conectar, **todo seletor de modelo** do sistema passa a mostrar um grupo
novo: **"Gateway (Assinatura)"**, ao lado de "Google Gemini" e "OpenRouter".

- Escolher um modelo do grupo **Gateway (Assinatura)** → usa a **conta/assinatura**.
- Escolher um modelo do grupo **Google Gemini** → usa a **API key** do Gemini (AI Studio).
- Escolher um modelo do grupo **OpenRouter** → usa a **API key** do OpenRouter.

A escolha é **por recurso** e pode ser trocada a qualquer momento. Ou seja, você
pode ter o Agente de WhatsApp na assinatura do Claude, o Organizador na API do
Gemini, o Disparo na assinatura do ChatGPT — como preferir.

Com **várias contas conectadas**, o grupo "Gateway (Assinatura)" lista os modelos
de todas elas juntos (um Claude, um Gemini, um GPT…). Ao escolher um modelo, o
painel descobre sozinho **qual conexão** o expõe e roteia a chamada para aquela
conta — você não precisa dizer de qual conta é. Se duas contas expuserem o mesmo
modelo, a **primeira conexão da lista** atende.

### Gemini: alternar entre AI Studio (API) e conta

Como você pediu, dá pra usar o Gemini das duas formas e trocar quando quiser:

- **Modo AI Studio (API):** configure a *Google Gemini API Key* e, no seletor,
  escolha um modelo do grupo **"Google Gemini"** (`gemini:...`).
- **Modo conta/assinatura:** conecte o gateway com login na sua conta Google e, no
  seletor, escolha o Gemini que aparece no grupo **"Gateway (Assinatura)"**
  (`gateway:...`).

Os dois modos coexistem; basta trocar o modelo selecionado no recurso.

Onde isso vale: **Agente IA** (sandbox + WhatsApp), **Disparo em massa**,
**Follow-up**, **Organizador**, **reescrita de mensagens**, **sugestões de
prompt/kanban**, **lead intelligence**, **resumo do dono** — todos os pontos do
sistema que usam IA têm o seletor com os três grupos.

> **Embeddings (RAG):** o gateway é só para **chat**. O seletor de modelo de
> *embeddings* continua mostrando apenas Gemini/OpenRouter, porque assinaturas de
> chat não expõem endpoint de embeddings. Isso é intencional.

---

## 7. Referência técnica (prefixos de modelo)

Internamente cada modelo é referenciado por um `modelRef` com prefixo de provedor:

| Prefixo | Provedor | Caminho |
|---|---|---|
| `gemini:` (ou sem prefixo) | Gemini API | SDK `@google/generative-ai` |
| `openrouter:` | OpenRouter | `https://openrouter.ai/api/v1/chat/completions` |
| `gateway:` | Gateway de Assinatura | `{gateway_base_url}/chat/completions` |

Repare que o `modelRef` **não** carrega a conta — é só `gateway:<modelId>`. A
conta certa é resolvida em tempo de chamada: `gateway-model-discovery` consulta o
`/v1/models` de **todas** as conexões, monta um mapa `modelId → conexão` e
`resolveGatewayEndpointForModel()` devolve a conexão dona daquele modelo. Com
**uma** conexão, esse passo é instantâneo (sem descoberta). Isso mantém o
`modelRef` simples e estável mesmo com várias contas.

O código vive em [`src/lib/ai-provider.ts`](../src/lib/ai-provider.ts) (dispatch,
chamada OpenAI-compatível, resolução por modelo e lógica de fallback),
[`src/lib/ai-keys.ts`](../src/lib/ai-keys.ts) (carrega as conexões do banco, com
fallback do formato antigo de conexão única) e
[`src/lib/gateway-model-discovery.ts`](../src/lib/gateway-model-discovery.ts)
(lista e mescla os modelos de todas as conexões via `/v1/models` e resolve a
conexão de cada modelo).

---

## 8. Solução de problemas

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| **Testar** (na conexão) falha com erro de rede | proxy não está rodando | suba o proxy; confirme a porta/URL daquela conexão |
| Testa OK mas as respostas vêm do fallback | conta deslogada ou sem cota | refaça o login no proxy; cheque a cota da assinatura |
| Grupo "Gateway (Assinatura)" não aparece nos seletores | nenhuma conexão salva, ou `/v1/models` vazio | salve ao menos uma conexão; confirme que o proxy lista modelos |
| Um modelo específico não aparece | a conta que o expõe está fora/deslogada | teste aquela conexão; relogue a conta no proxy |
| Salvou e veio um aviso de "colunas não existem" | schema desatualizado | rode a atualização de schema em Configurações → Banco de dados |
| Conexão exige chave e o **Testar** dá 401 | chave ausente/errada (ou só salva, não digitada) | digite a *Chave do proxy* daquela conexão (a salva continua válida pro uso real) |
| Botão **Conectar conta** falha citando "servidor próprio/serverless" | painel hospedado em serverless (sem processo persistente) | use o modo manual (§4): proxy em máquina sua + cadastrar a URL |
| Status do conector: "proxy na porta 8317 fora do controle do painel" | já existe um CLIProxyAPI seu rodando nessa porta | desligue o seu e use o 1 clique, **ou** cadastre a URL dele no modo manual |
| Login no 1 clique não conclui (fica "esperando…") | aba de login fechada/bloqueada ou login não finalizado | use o link "Clique aqui pra abrir a página de login" no aviso azul e termine o login |
| Depois de logar, a aba vira **"localhost recusou a conexão"** (`ERR_CONNECTION_REFUSED` em `localhost:1455`/`8085`/`54545`) | o provedor redireciona pro `localhost` **do servidor** — quando o painel roda em VPS/Docker, seu navegador não o alcança | **é esperado**: copie a URL inteira dessa aba e cole no campo do aviso azul → **Concluir login**. O servidor entrega o código ao conector |
| Conectou, mas o login some depois de um deploy/restart (Docker) | `.gateway-proxy/` é apagada com o container | monte um volume na pasta `.gateway-proxy/` do app |

Para desconectar **uma** conta, clique no ícone de lixeira da conexão e **Salvar
conexões**. Para desligar tudo de uma vez e voltar a usar só API key, clique em
**Desconectar todas** (limpa a lista e o gateway legado; as API keys de
Gemini/OpenRouter continuam intactas).

---

## 9. Segurança

- A **URL/apelido** de cada conexão e o **modelo de fallback** não são segredos
  (endereço local + nomes) — por isso aparecem preenchidos no formulário.
- A **chave de cada conexão** é tratada como segredo: nunca é devolvida pela API; a
  tela só mostra um indicador de "🔑 chave salva" por conexão. Ao salvar sem
  digitar, a chave anterior é preservada (casada por `id` da conexão).
- Mantenha o proxy acessível **apenas** pela rede onde o painel roda (localhost ou
  rede interna). Não exponha o proxy na internet sem autenticação.
- As sessões das suas contas ficam **no proxy**, não no painel. O painel só guarda
  como alcançar o proxy.
- **Modo 1 clique:** os arquivos do conector ficam em `.gateway-proxy/` (binário,
  `config.yaml`, `management.key` e os logins em `auths/`). Essa pasta é **local
  do servidor** — não versione nem copie pra lugares públicos. O conector escuta
  só em localhost e o gerenciamento exige a chave que só o servidor conhece.
