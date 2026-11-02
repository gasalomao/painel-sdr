# ARQUITETURA DEFINITIVA: AUTOMAÇÃO END-TO-END COM OPENCODE CLI NA VPS (EASYPANEL)

**Estratégia:** Execução Real do OpenCode CLI Headless + Skill Impeccable na VPS  
**Hospedagem:** EasyPanel / Docker Container (Linux x64)  
**Objetivo:** Eliminar 100% da operação manual do operador. O sistema executa o OpenCode com a Skill Impeccable na VPS exatamente como é feito hoje no computador local, usando as fotos baixadas do Maps e o arquivo `INFORMACOES-DO-NEGOCIO.txt`.

---

## 1. FLUXO GERAL DA OPERAÇÃO NA VPS

```
[ MAPS SCRAPER ] (Captura dados + lista de fotos)
       │
       ▼
[ CAMPANHA DISPARO ] ───> Disparo Frio Humanizado (Evolution API)
       │
       ▼
[ FASE 1: SARAH SDR ] ──> Qualificação no WhatsApp
       │
   Aceitou prévia e confirmou (Msg 8.1 & 8.2)?
       │
       ▼ [ TRAVA ANTI-DESPERDÍCIO ]
 Status = PREVIA_SOLICITADA
       │
 ══════╪══════════════════════════════════════════════════════════════
       │ WORKER AUTÔNOMO NO EASYPANEL (Segundo Plano na VPS)
       ▼
 1. Montagem do Workspace do Lead (/tmp/workspace-[lead_id]/)
    ├── Download paralelo das fotos em alta resolução (/fotos/foto-01.jpg, ...)
    ├── Extração de inteligência do WhatsApp (PIX, links de agenda Tua Agenda, etc.)
    └── Geração do briefing completo: INFORMACOES-DO-NEGOCIO.txt
       │
 2. Execução Headless do OpenCode CLI com Skill Impeccable
    ├── Comando: opencode run --standalone --auto --format json
    ├── O OpenCode lê INFORMACOES-DO-NEGOCIO.txt + pasta /fotos
    ├── Executa a Skill Impeccable ($impeccable design / shape / craft)
    └── Gera index.html, styles.css, tokens.css e código de produção
       │
 3. Deploy Instantâneo Vercel API (POST /v13/deployments)
    └── Retorno da URL pública: https://[slug-empresa].vercel.app
       │
 4. QA em 3 Camadas na VPS
    ├── Camada 1: Healthcheck HTTP (Status 200, < 3s)
    ├── Camada 2: Puppeteer Headless (DOM mobile 375x812, fotos com naturalWidth > 0)
    └── Camada 3: Avaliação Estética LLM Vision com critique.md (Score >= 80)
       │
 Status = PREVIA_PRONTA
 ══════╪══════════════════════════════════════════════════════════════
       │
       ▼
[ FASE 2: SARAH CLOSER ]
    ├── 1. O Ping de Atenção ("Acabei de finalizar no computador...")
    ├── 2. O Drop do Link ("Dá uma olhadinha no celular...")
    ├── 3. Matriz de Fechamento (Zero jargão, zero preço por texto, duplo vínculo)
    └── 4. Cadência Anti-Vácuo (Follow-ups automáticos de 3h e 24h)
       │
   Cliente confirma horário da ligação de 5 minutos?
       │
       ▼
 Status = REUNIAO_AGENDADA
    ├── Pausa imediata do bot (bot_status = 'paused')
    └── Notificação push/WhatsApp para o Salomão com resumo completo
```

---

## 2. PREPARAÇÃO DO CONTAINER NO EASYPANEL

Para que o OpenCode CLI e a Impeccable rodem de forma 100% autônoma dentro da VPS:

### 2.1 Dependências Instaladas no Container Docker
1. **OpenCode CLI:** Instalado globalmente no ambiente Linux da VPS.
2. **Skill Impeccable:** Instalada no OpenCode da VPS via:
   ```bash
   npx --yes impeccable install
   ```
   Isso disponibiliza os comandos `$impeccable init`, `$impeccable shape`, `$impeccable design`, `$impeccable critique`, `$impeccable polish` dentro do CLI do OpenCode na VPS.
3. **Puppeteer Dependencies:** Bibliotecas Chromium já presentes para o Scraper do Maps.

### 2.2 Variáveis de Ambiente no EasyPanel
- `VERCEL_TOKEN`: Token de deploy da Vercel API.
- `OPENAI_API_KEY` / `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY`: Chaves de IA configuradas no OpenCode (`~/.config/opencode/opencode.json` ou variáveis de ambiente padrão).
- `EVOLUTION_API_URL` e `EVOLUTION_API_KEY`: Integração do WhatsApp.
- `SUPABASE_SERVICE_ROLE_KEY`: Acesso ao banco de dados pelo worker.

---

## 3. PASSO A PASSO TÉCNICO DETALHADO

### ETAPA 1: Qualificação Fria (Sarah Fase 1) e Trava de Criação
- **1ª Mensagem:**
  *"Oi, tudo bem? Aqui é a Sarah, da Salomão AI. Achei a {{nome_empresa}} pesquisando por {{ramo}} no Google Maps e notei que o perfil de vocês lá está sem site. Tive uma ideia de como ficaria um site profissional para destacar o trabalho de vocês na frente dos concorrentes. Posso preparar uma prévia gratuita e te mandar aqui no WhatsApp para você ver como fica?"*
- **Aceite da Prévia (8.1):**
  *"Show, já passei aqui para a nossa equipe montar a prévia da {{nome_empresa}}! Como a gente cria algo personalizado pro seu negócio mesmo, leva até 2 dias úteis para ficar pronto. Como o pessoal vai dedicar um tempo exclusivo nisso, quando a gente finalizar e te mandar o link por aqui você consegue dar uma olhadinha rápida para dizer o que achou?"*
- **Confirmação do Cliente (8.2):**
  Cliente responde *"Combinado / Pode mandar"*.
  IA responde: *"Perfeito então, combinado! Assim que ficar pronto a gente já te chama aqui com o link. Bom trabalho por aí!"*
- **Ação Técnica:** O sistema altera o status do lead para `PREVIA_SOLICITADA`, disparando a execução do worker na VPS.

---

### ETAPA 2: Montagem do Workspace do Lead na VPS
Assim que o lead entra em `PREVIA_SOLICITADA`:
1. **Criação do Workspace Temporário:**
   O worker cria a pasta `/tmp/workspace-[lead_id]/` e subpasta `/tmp/workspace-[lead_id]/fotos/`.
2. **Download das Fotos em Alta Resolução:**
   - Executa `downloadAllPlacePhotos` (`src/lib/lead-maps-kit.ts`).
   - Converte URLs do Maps para resolução máxima (`=w1600-h1200-k-no`).
   - Salva as fotos baixadas como `fotos/foto-01.jpg`, `fotos/foto-02.jpg`, etc.
3. **Extração de Inteligência do WhatsApp (`whatsapp-context-extractor.ts`):**
   - Varre as mensagens trocadas com o lead até aquele momento.
   - Extrai: links de agendamento externos (Tua Agenda, Trinks, Calendly), regras de PIX antecipado, horários e serviços específicos.
4. **Geração do Briefing Oficial (`INFORMACOES-DO-NEGOCIO.txt`):**
   - Executa `formatLeadKitTxt` (`src/lib/lead-maps-kit.ts`), gravando no workspace o mesmo arquivo que você baixa hoje no Painel:
     - Identificação, Nicho, Endereço e iframe do Maps.
     - Telefone, link WhatsApp pronto com mensagem de CTA.
     - Insights do WhatsApp do cliente (PIX, links de agenda).
     - Lista das fotos disponíveis na pasta `./fotos/`.
     - Dores e proposta de valor do nicho.

---

### ETAPA 3: Execução Autônoma do OpenCode CLI na VPS
O worker executa um processo filho não-interativo dentro de `/tmp/workspace-[lead_id]/`:

```bash
opencode run --standalone --auto --format json "Você é um designer de elite utilizando a skill Impeccable (\$impeccable design).

INSTRUÇÕES OBRIGATÓRIAS:
1. Leia o arquivo INFORMACOES-DO-NEGOCIO.txt para entender toda a essência, contatos, endereço, serviços e particularidades do negócio (inclusive regras de PIX e links de agendamento extraídos do WhatsApp).
2. Utilize as fotos reais da empresa disponíveis na pasta ./fotos/ para compor o site. Nunca use imagens quebradas ou placeholders.
3. Execute o modo Persuade da Impeccable: crie um Visual World autoral coerente com o nicho (para Estética/Bronzeamento: paleta luxuosa terrosa/dourado/nude, proibido parede de mar/azul; para Obras/Vidraçaria: precisão técnica e industrial).
4. Centralize os tokens em tokens.css com escala tipográfica fluida em clamp() e espaçamentos semânticos.
5. Desenvolva index.html e styles.css com código de alta fidelidade e botões de ação apontando para o WhatsApp da empresa.
6. Não use templates genéricos de IA, nem gradientes roxo/azul clichês.
7. Ao finalizar a criação, execute a verificação da Impeccable para garantir conformidade."
```

- **Parâmetros-chave:**
  - `--standalone`: Inicia servidor isolado sem conflito com outros processos.
  - `--auto`: Auto-aprova todas as criações e escritas de arquivos no workspace sem travar por confirmação de terminal.
  - `--format json`: Retorna o log de execução estruturado para monitoramento no painel.

---

### ETAPA 4: Deploy Automático na Vercel API (`vercel-deployer.ts`)
1. Assim que o OpenCode conclui a escrita dos arquivos em `/tmp/workspace-[lead_id]/`, o conector de deploy lê todos os arquivos gerados (`index.html`, `styles.css`, `tokens.css` e as imagens de `./fotos/`).
2. Faz uma requisição REST direta para a API da Vercel:
   `POST https://api.vercel.com/v13/deployments`
   - Header: `Authorization: Bearer ${VERCEL_TOKEN}`
   - Body: Arquivos e imagens codificados em base64/UTF-8.
3. A Vercel constrói e publica o site em ~3 segundos, retornando:
   `https://[slug-empresa].vercel.app`
4. O link é salvo no banco de dados em `leads_extraidos.link_previa`.

---

### ETAPA 5: Auditoria Tripla de Qualidade pós-Deploy (`qa-inspector.ts`)
Antes de liberar o link para o cliente no WhatsApp:
1. **Healthcheck HTTP:** Valida status 200 e resposta rápida da URL da Vercel.
2. **Puppeteer Headless:**
   - Carrega o site em viewport mobile (375x812).
   - Inspeciona todas as tags `<img>` e confirma que `naturalWidth > 0` (zero fotos quebradas).
   - Verifica se o botão de WhatsApp aponta para o número com DDI 55.
   - Verifica se não há overflow horizontal (`scrollWidth > clientWidth`).
   - Tira um screenshot fullpage mobile (`previa_screenshot.png`).
3. **Avaliação Estética LLM Vision com `critique.md`:**
   - Submete o screenshot para o modelo com visão juntamente com o checklist de `critique.md`.
   - Avalia paleta, hierarquia visual e originalidade por nicho.
   - Atribui nota de 0 a 100.
4. **Gate de Aprovação:** Se score ≥ 80 e 0 fotos quebradas -> Status vira `PREVIA_PRONTA`. (Se reprovar, reexecuta o OpenCode com prompt de correção cirúrgica).

---

### ETAPA 6: Sarah Fase 2 (Entrega e Fechamento no WhatsApp)
Com status `PREVIA_PRONTA`, o robô retoma a conversa com o cliente:

1. **O Ping de Atenção:**
   *"Oi! Tudo bem? Acabei de finalizar aqui no computador a prévia do site da {{nome_empresa}} e já subi no ar para teste. Você tá com o celular na mão agora para eu te mandar o link e você dar uma olhada rápida?"*
2. **O Drop do Link (quando o cliente responde Sim / Pode mandar):**
   *"Dá uma olhadinha aí no celular! Como é uma prévia inicial, montamos com o que encontramos disponível na internet só para você ter uma ideia de como a estrutura funciona, mas depois deixamos 100% do seu jeito, com as suas fotos e cores preferidas. Me conta: o que achou dessa ideia para a {{nome_empresa}}?"*
3. **Matriz de Conversão em Ligação de 5 Minutos:**
   - **Zero Preço por Texto:** Nunca passar valores por mensagem.
   - **Zero Termos Técnicos:** Proibido falar "domínio", "hospedagem", "servidor", "DNS".
   - **Regra do Duplo Vínculo:** Sempre propor 2 horários fechados (ex: *"Pode ser agora às 16h30 ou fica melhor às 17h?"*).
   - **Se o cliente pedir mudança de cor/fotos:** Valida o gosto imediatamente (*"Boa! Inclusive puxar para [estilo] vai valorizar muito mais o seu espaço..."*) e chama para a ligação rápida de 5 minutos para alinhar ao vivo.
   - **Se o cliente perguntar o preço:** Explicar que muda conforme os recursos (citando o link de agendamento ou PIX dele) e convidar para os 5 minutinhos no WhatsApp para passar o valor exato com 2 opções de horário.
   - **Se o cliente estiver ocupado:** Agendar para o fim do dia ou manhã seguinte com 2 opções fechadas.
4. **Cadência Anti-Vácuo:**
   - 3h sem resposta: *"E aí, conseguiu abrir o link aí no celular ou a correria hoje tá grande?"*
   - 24h sem resposta: *"Oi! Passando só pra saber se você conseguiu abrir o modelo do site no celular. Preciso saber se curtiu a ideia pra decidir se mantenho esse link de teste ativo aqui pra vocês!"*
5. **Handoff Final (`REUNIAO_AGENDADA`):**
   - Cliente confirma o horário:
     - Status vira `REUNIAO_AGENDADA`.
     - Bot é pausado naquele JID (`bot_status = 'paused'`).
     - Sistema notifica no WhatsApp do Salomão:
       *"🎉 Reunião Agendada! Empresa: {{nome_empresa}} | Horário: {{horario}} | Link: {{link_previa}} | Resumo: {{ajustes_pedidos}}"*

---

## 4. CRONOGRAMA DE IMPLEMENTAÇÃO EM CÓDIGO

A execução será realizada na seguinte ordem técnica:

1. **Passo 1 — Migration SQL:** `migrations/019_prospeccao_autonoma_previa.sql` (Colunas `previa_status`, `link_previa`, `previa_whatsapp_insights`, etc.).
2. **Passo 2 — Extrator de Insights WhatsApp:** `src/lib/sites/whatsapp-context-extractor.ts`.
3. **Passo 3 — Gerador do Kit no Workspace:** `src/lib/sites/workspace-provisioner.ts` (Baixa fotos do Maps via `downloadAllPlacePhotos` + cria `INFORMACOES-DO-NEGOCIO.txt`).
4. **Passo 4 — Executor do OpenCode CLI na VPS:** `src/lib/sites/opencode-runner.ts` (Execução headless com `--standalone --auto`).
5. **Passo 5 — Deployer Vercel REST API:** `src/lib/sites/vercel-deployer.ts`.
6. **Passo 6 — Inspetor de QA Triplo:** `src/lib/sites/qa-inspector.ts` (Puppeteer + LLM Vision).
7. **Passo 7 — Atualização do Agente Sarah (Fase 1 e Fase 2):** `src/app/api/agent/process/route.ts`.
8. **Passo 8 — Worker de Fila:** `scripts/autonomous-site-worker.ts`.
