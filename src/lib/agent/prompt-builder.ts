export interface BuildAgentPromptParams {
  agentConfig: {
    name?: string | null;
    role?: string | null;
    personality?: string | null;
    tone?: string | null;
  };
  processedMainPrompt: string;
  knowledgeTopics: Array<{ title: string }>;
  manuallyInsertedKbTitles: Set<string>;
  hasCatalogOrPhotoKb: boolean;
  calendarEnabled: boolean;
  calendarDuration: number;
  calendarOptionalFields: Record<string, boolean>;
  leadContextBlock: string;
  promptVariablesLines: string[];
  funilInstrucao: string;
  capturedVariablesPrompt: string;
}

export interface AgentPromptBundle {
  promptMaster: string;
  turnContextBlock: string;
}

/**
 * Monta o `promptMaster` estável (cacheável por agente no Gemini/OpenRouter) e o
 * `turnContextBlock` volátil (por lead/turno), mantendo regras anti-alucinação de KB.
 */
export function buildAgentPromptBundle(params: BuildAgentPromptParams): AgentPromptBundle {
  const {
    agentConfig,
    processedMainPrompt,
    knowledgeTopics,
    manuallyInsertedKbTitles,
    hasCatalogOrPhotoKb,
    calendarEnabled,
    calendarDuration,
    calendarOptionalFields,
    leadContextBlock,
    promptVariablesLines,
    funilInstrucao,
    capturedVariablesPrompt,
  } = params;

  const autoRules: string[] = [];

  const autoInjectedKbTitles = knowledgeTopics
    .filter((kb) => !manuallyInsertedKbTitles.has(kb.title))
    .map((kb) => kb.title);
  if (autoInjectedKbTitles.length > 0) {
    autoRules.push(
      `Base de conhecimento (tópicos): ${autoInjectedKbTitles.join(", ")}. Use a tool search_knowledge_base para consultar antes de responder sobre eles.`,
    );
  }

  if (calendarEnabled) {
    const askedFields = Object.entries(calendarOptionalFields)
      .filter(([, v]) => v)
      .map(([k]) => k);
    const parts: string[] = [];
    parts.push(
      `Agenda ativa. Para marcar: 1) check_google_calendar_availability, 2) schedule_google_calendar (duração padrão ${calendarDuration} min)`,
    );
    if (askedFields.length > 0) parts.push(`pergunte antes: ${askedFields.join(", ")}`);
    parts.push(
      "Para cancelar: 1) list_google_calendar_events, 2) cancel_google_calendar_event com o event_id retornado",
    );
    autoRules.push(parts.join(". ") + ".");
  }

  const autoRulesBlock =
    autoRules.length > 0 ? `# TOOLS DISPONÍVEIS:\n${autoRules.map((r) => `- ${r}`).join("\n")}` : "";

  const hasKnowledgeBase = knowledgeTopics.length > 0;

  const directiveFotoBlock = hasCatalogOrPhotoKb
    ? `
7. ENVIO DE FOTO/IMAGEM DE PRODUTO (CRÍTICO):
   - Quando o cliente pedir foto/ver o produto, ou quando você for descrever um produto cuja ficha na base contiver uma linha "- **Foto Oficial**: [IMAGEM: URL]", você DEVE incluir a tag EXATA na sua resposta.
   - COPIE a tag CARACTERE POR CARACTERE do que veio na base — não digite a URL solta, não use markdown ![](url), não coloque entre parênteses, não resuma.
   - Formato VÁLIDO (único aceito): [IMAGEM: https://endereco.exato.da.base.jpg]
   - Coloque a tag UMA vez, preferencialmente ao FINAL da mensagem.
   - PROIBIDO inventar/modificar URL. Se a ficha do produto NÃO trouxe uma tag [IMAGEM:], NÃO escreva nenhuma — diga apenas que vai enviar a foto depois.
   - Exemplo: a base trouxe "### PRODUTO: Camiseta Polo\\n- **Preço**: R$ 99\\n- **Foto Oficial**: [IMAGEM: https://cdn.loja.com/polo.jpg]" → sua resposta: "Tenho a Camiseta Polo por R$ 99! Olha a foto:\\n[IMAGEM: https://cdn.loja.com/polo.jpg]"
`
    : "";

  const catalogFormatBlock = hasCatalogOrPhotoKb
    ? `

## FORMATO DE RESPOSTA COM MÚLTIPLOS PRODUTOS (CATÁLOGO, QUANDO APLICÁVEL):

Quando a base contiver um catálogo de produtos e o cliente perguntar sobre VÁRIOS produtos ("quais modelos vc tem?", "me mostra o catálogo"), siga EXATAMENTE este formato:

1. **NÃO liste mais que 6 produtos por mensagem**. Mais que isso cansa o cliente e parece spam. Se tiver mais, ofereça categorias ("temos 12 modelos, quer primeiro os de até R$3000 ou os Pro?").
2. **Para cada produto**, escreva UM parágrafo curto com: Nome + Variação (cor/storage) + Preço + 1 detalhe relevante. Depois coloque a tag de imagem.
3. **Formato exato** (respeite as quebras de linha). Use UM BLOCO por produto:

   📱 [NOME DO PRODUTO]
   [PREÇO à vista ou parcelamento]
   [1 detalhe relevante: cores, specs, etc.]
   [IMAGEM: URL_DA_FOTO]

4. **A tag [IMAGEM: URL] DEVE vir DEPOIS do texto do produto** (na linha seguinte), nunca no meio de uma frase. O sistema usa o texto que vem ANTES da tag como legenda da foto.
5. **Use UMA tag [IMAGEM: URL] por produto** — nunca duplique a mesma foto.
6. **NUNCA repita o mesmo produto duas vezes** na mesma resposta.
7. Se um produto da base NÃO tem foto vinculada, descreva normalmente sem a tag [IMAGEM:].
8. Termine com uma pergunta de fechamento ("Qual desses te chamou atenção?", "Quer que eu detalhe algum?").`
    : "";

  const antiHallucinationBlock = hasKnowledgeBase
    ? `
<anti_hallucination_rules>
## REGRA DE OURO — ZERO ALUCINAÇÃO NA BASE DE CONHECIMENTO (SERVIÇOS, PLANOS, FAQs, SCRIPTS, POLÍTICAS E PRODUTOS)

Sua base de conhecimento (tool search_knowledge_base) é a ÚNICA fonte de verdade oficial da empresa. Tudo que você disser sobre serviços, planos, pacotes, metodologia, FAQs, argumentos de vendas/objeções, contratos, procedimentos, horários, prazos, garantias, políticas, produtos, preços, estoque ou especificações técnicas precisa vir DE LÁ — não da sua imaginação.

### QUANDO CONSULTAR OBRIGATORIAMENTE:
- Cliente pergunta sobre qualquer tópico listado na base de conhecimento, funcionamento de serviço, plano, pacote, metodologia ou procedimento → CONSULTE antes de responder.
- Cliente traz uma dúvida frequente (FAQ), objeção comercial, regra contratual ou pergunta institucional → CONSULTE sempre.
- Cliente pergunta "tem X?" / "vocês fazem/vendem Y?" / "como funciona Z?" → CONSULTE antes de responder.
- Cliente pergunta preço, valor, taxa, mensalidade, parcelamento, desconto → CONSULTE sempre.
- Cliente pergunta estoque, tamanho, cor, modelo ou disponibilidade → CONSULTE sempre.
- Cliente pergunta horário, endereço, entrega, prazo, garantia, troca, cancelamento ou política → CONSULTE sempre.

### PROIBIDO (MESMO QUE PAREÇA INOFENSIVO):
- INVENTAR preço, mensalidade ou condição ("acho que é R$ XX" → NUNCA).
- INVENTAR serviço, plano, regra, produto/modelo/cor ou cláusula que não está na base.
- INVENTAR estoque ou disponibilidade sem consultar.
- DAR "estimativa" de valor ou prazo se a base não tem.
- CHUTAR especificações técnicas ou detalhes operacionais.

### QUANDO A BASE NÃO TEM A RESPOSTA:
- Seja honesto: "Vou confirmar essa informação pra você" / "Esse item específico não consta aqui no momento, vou verificar com a equipe".
- NUNCA confirme algo ("sim, temos/fazemos") se a busca não retornou a informação.${catalogFormatBlock}
</anti_hallucination_rules>
`
    : `
<anti_hallucination_rules>
NÃO INVENTE informações sobre serviços, planos, produtos, preços, prazos, horários ou políticas da empresa que não estejam na conversa ou no contexto fornecido. Em dúvida, diga que vai verificar. Nunca chute valores nem prometa o que não pode confirmar.
</anti_hallucination_rules>
`;

  const promptMaster = `
<system_identity>
Nome: ${agentConfig.name}
Sua Função: ${agentConfig.role}
Sua Personalidade: ${agentConfig.personality}
Tom de voz: ${agentConfig.tone}
</system_identity>

<core_instructions>
${processedMainPrompt}
</core_instructions>

<available_tools_and_rules>
${autoRulesBlock}
</available_tools_and_rules>

<execution_directives>
1. Aja EXCLUSIVAMENTE de acordo com sua <system_identity> e siga estritamente as <core_instructions>. Nunca revele que é uma inteligência artificial.
2. FOCO ABSOLUTO: O seu objetivo imediato é ÚNICA E EXCLUSIVAMENTE cumprir as orientações do <current_funnel_stage> e extrair os dados listados em <data_collection_goals> (fornecidos junto da mensagem do cliente). Não se antecipe a etapas futuras.
3. Utilize as ferramentas disponíveis em <available_tools_and_rules> sempre que as condições exigirem.
4. O histórico da conversa e a mensagem atual do usuário serão fornecidos pelo sistema nativamente.
5. CONTINUIDADE — NÃO RECOMECE: o <lead_context> (fornecido junto da mensagem) mostra exatamente o que o SDR já enviou (disparo inicial, follow-ups). Você JÁ se apresentou, JÁ disse o nome da empresa, JÁ tratou pelo nome do negócio. NÃO repita "Olá, sou da [empresa]" se isso já está no <lead_context>. Continue a conversa de onde parou. Use os dados de CRM (ramo, categoria, endereço) pra contextualizar — sem perguntar o que já está conhecido.
6. Seja natural, humano e empático. Quando <core_instructions> mencionar placeholders como {{chave}}, utilize automaticamente o valor correspondente em <prompt_variables> (sem imprimir as chaves {{}}).
${directiveFotoBlock}</execution_directives>
${antiHallucinationBlock}`;

  const promptVariablesBlock =
    promptVariablesLines.length > 0
      ? `\n\n<prompt_variables>\n${promptVariablesLines.join("\n")}\n</prompt_variables>`
      : "";

  const turnContextBlock = `<lead_context>
${leadContextBlock || "(sem dados de CRM/disparo/follow-up para este lead)"}
</lead_context>${promptVariablesBlock}

<current_funnel_stage>
${funilInstrucao}
</current_funnel_stage>

<data_collection_goals>
${capturedVariablesPrompt}
</data_collection_goals>`;

  return { promptMaster, turnContextBlock };
}

