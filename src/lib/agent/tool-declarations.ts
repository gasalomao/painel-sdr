import { SchemaType } from "@google/generative-ai";
import type { AiFunctionDecl } from "@/lib/ai-provider";

export interface BuildToolDeclarationsParams {
  knowledgeTopics: Array<{ title: string }>;
  hasCatalogOrPhotoKb: boolean;
  sitePreviewAutoDetect: boolean;
  hasPreviaOrLink: boolean;
  webSearchEnabled: boolean;
  calendarEnabled: boolean;
  calendarDuration: number;
  calendarOptionalFields: Record<string, boolean>;
  calendarAutoCapture: {
    empresa?: boolean;
    necessidade?: boolean;
    telefone?: boolean;
  };
  necessidadeLabel: string;
  customTools: Array<{ name: string; description: string }>;
  activeStage: {
    captured_variables?: Array<{ name?: string; description?: string }>;
  } | null;
}

/**
 * Monta dinamicamente as declarações de ferramentas (function/tool calling) do agente
 * de acordo com base de conhecimento, calendário Google, pesquisa web, prévia e funil.
 */
export function buildAgentFunctionDeclarations(params: BuildToolDeclarationsParams): AiFunctionDecl[] {
  const {
    knowledgeTopics,
    hasCatalogOrPhotoKb,
    sitePreviewAutoDetect,
    hasPreviaOrLink,
    webSearchEnabled,
    calendarEnabled,
    calendarDuration,
    calendarOptionalFields,
    calendarAutoCapture,
    necessidadeLabel,
    customTools,
    activeStage,
  } = params;

  const functionDeclarations: AiFunctionDecl[] = [];

  if (knowledgeTopics.length > 0) {
    const topicList = knowledgeTopics.map((k) => `"${k.title}"`).join(", ");
    functionDeclarations.push({
      name: "search_knowledge_base",
      description:
        `Base de conhecimento OFICIAL da empresa (serviços, planos, FAQs, scripts de vendas/objeções, procedimentos, contratos, políticas, catálogo de produtos, preços e estoque). ` +
        `Tópicos disponíveis: ${topicList}. ` +
        `CHAMADA OBRIGATÓRIA quando o cliente perguntar sobre qualquer um dos tópicos disponíveis ou sobre: ` +
        `COMO FUNCIONA, SERVIÇO, PLANO, PACOTE, METODOLOGIA, PROCEDIMENTO, DÚVIDA FREQUENTE (FAQ), OBJEÇÃO, CONTRATO, ` +
        `PREÇO, VALOR, MENSALIDADE, PARCELAMENTO, DESCONTO, PRODUTO, MODELO, COR, TAMANHO, ESTOQUE, DISPONIBILIDADE, ` +
        `HORÁRIO, ENDEREÇO, ENTREGA, PRAZO, GARANTIA, TROCA, RECLAMAÇÃO, POLÍTICA ou ESPECIFICAÇÃO TÉCNICA. ` +
        `Também chame quando o cliente disser "tem X?" / "vocês fazem/vendem Y?" / "quanto custa" / "como funciona". ` +
        `PROIBIDO responder sobre esses tópicos SEM chamar esta tool primeiro. ` +
        `PROIBIDO INVENTAR informações que não vieram no retorno. ` +
        `Se a base não retornar resultados, diga ao cliente que vai verificar — nunca chute.`,
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          query: {
            type: SchemaType.STRING,
            description:
              `Termos da busca (3-6 palavras-chave). Use o vocabulário do cliente ou o tema da dúvida, ` +
              `não precisa bater literal com o título. Exemplos: ` +
              `"como funciona plano anual", "objeção preço caro", "prazo entrega site", ` +
              `"preço iPhone 15", "horário atendimento sábado", "política cancelamento".`,
          },
        },
        required: ["query"],
      },
    });

    if (hasCatalogOrPhotoKb) {
      functionDeclarations.push({
        name: "update_product_stock",
        description:
          "Atualiza a quantidade em estoque de um produto na base de conhecimento quando uma venda for concluída ou confirmada pelo cliente. Reduz a quantidade disponível no banco de dados.",
        parameters: {
          type: SchemaType.OBJECT,
          properties: {
            product_name: {
              type: SchemaType.STRING,
              description: "Nome do produto/modelo vendido (ex: 'iPhone 15 128GB', 'Camiseta Polo G', 'Apartamento 302')",
            },
            quantity_sold: {
              type: SchemaType.NUMBER,
              description: "Quantidade de unidades vendidas (padrão: 1)",
            },
          },
          required: ["product_name"],
        },
      });
    }
  }

  if (sitePreviewAutoDetect) {
    functionDeclarations.push({
      name: "solicitar_previa_site",
      description:
        "Chame quando o cliente confirmar formalmente que aceita a proposta da prévia gratuita do site da empresa dele e concordar em olhar quando o link for enviado. Dispara o pipeline autônomo na VPS.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          confirmacao: {
            type: SchemaType.STRING,
            description: "A frase ou confirmação dita pelo cliente (ex: 'sim, pode mandar', 'combinado')",
          },
        },
        required: ["confirmacao"],
      },
    });
  }

  if (sitePreviewAutoDetect || hasPreviaOrLink) {
    functionDeclarations.push({
      name: "agendar_reuniao_fechamento",
      description:
        "Chame quando o cliente concordar com um horário para a ligação rápida de 5 minutos no WhatsApp para alinhamento e fechamento do site.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          horario_confirmado: {
            type: SchemaType.STRING,
            description: "O horário exato combinado (ex: 'hoje às 16h30', 'amanhã às 10h')",
          },
          resumo_necessidades: {
            type: SchemaType.STRING,
            description: "Resumo de ajustes ou preferências mencionadas pelo cliente",
          },
        },
        required: ["horario_confirmado"],
      },
    });
  }

  if (webSearchEnabled) {
    functionDeclarations.push({
      name: "web_search",
      description:
        "Busca rápida na internet (DuckDuckGo). Use quando precisar de informação atualizada que não está nem na conversa nem na base de conhecimento (notícias, dados, fatos recentes). NÃO use pra coisas inventadas.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          query: { type: SchemaType.STRING, description: "O que buscar — frase curta e específica" },
        },
        required: ["query"],
      },
    });
    functionDeclarations.push({
      name: "web_fetch",
      description:
        "Acessa e lê o conteúdo completo de uma página web (URL). Use sempre após a busca (web_search) retornar links úteis, para ler o site oficial da empresa do lead, detalhes de notícias ou especificações completas de produtos.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          url: { type: SchemaType.STRING, description: "A URL completa do site para ler (ex: https://exemplo.com)" },
        },
        required: ["url"],
      },
    });
  }

  if (calendarEnabled) {
    const askedFields = Object.entries(calendarOptionalFields)
      .filter(([, v]) => v)
      .map(([k]) => k);

    const scheduleProps: Record<string, { type: SchemaType; description: string }> = {
      summary: { type: SchemaType.STRING, description: "Título do evento. Ex: Reunião com [nome do cliente]" },
      start_datetime: {
        type: SchemaType.STRING,
        description:
          "Data e hora de início ISO8601 (ex: 2026-04-25T14:00:00). PROIBIDO chutar — só usar horário confirmado via check_google_calendar_availability.",
      },
      duration_minutes: {
        type: SchemaType.NUMBER,
        description: `Duração em minutos. Padrão: ${calendarDuration}. Use esse valor a menos que o cliente peça outro.`,
      },
    };
    if (calendarAutoCapture.empresa) {
      scheduleProps.empresa = {
        type: SchemaType.STRING,
        description: "Empresa do cliente. NÃO PERGUNTE. Se foi mencionada na conversa, preencha; senão deixe vazio.",
      };
    }
    if (calendarAutoCapture.necessidade) {
      scheduleProps.necessidade = {
        type: SchemaType.STRING,
        description: `${necessidadeLabel}: resumo curto (1 linha) que o cliente quer/precisa. NÃO PERGUNTE diretamente — infira da conversa baseado no contexto do nicho.`,
      };
    }

    const ASK_DESCS: Record<string, string> = {
      nome: "Nome completo do cliente. PERGUNTE diretamente antes de agendar.",
      email: "E-mail do cliente. PERGUNTE diretamente — vira convidado oficial do evento.",
    };
    for (const f of askedFields) {
      if (ASK_DESCS[f]) scheduleProps[f] = { type: SchemaType.STRING, description: ASK_DESCS[f] };
    }

    const askTxt = askedFields.length > 0
      ? ` ANTES de chamar, PERGUNTE diretamente ao cliente: ${askedFields.join(", ")}.`
      : "";

    functionDeclarations.push({
      name: "schedule_google_calendar",
      description:
        `Agenda reunião no calendário (duração padrão ${calendarDuration} min). CHAME UMA ÚNICA VEZ por agendamento: depois que marcar, está marcado — NÃO chame de novo quando o cliente responder "ok", "combinado", "obrigada" etc (isso duplicaria o evento). PRÉ-REQUISITO OBRIGATÓRIO: você JÁ DEVE ter chamado check_google_calendar_availability nesta mesma conversa antes de criar o evento — proibido chutar horário. O horário (start_datetime) é no fuso de Brasília (America/Sao_Paulo); mande o horário que combinou com o cliente, sem converter.${askTxt} Empresa e necessidade você INFERE da conversa, NUNCA pergunta. Telefone é automático.`,
      parameters: { type: SchemaType.OBJECT, properties: scheduleProps, required: ["summary", "start_datetime", ...askedFields] },
    });

    functionDeclarations.push({
      name: "check_google_calendar_availability",
      description: "Checa a agenda do vendedor informando os horários livres num determinado dia. OBRIGATÓRIO USAR antes de sugerir horários ao cliente.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          date: { type: SchemaType.STRING, description: "Data para checar disponibilidade no formato YYYY-MM-DD. Ex: 2026-04-25" },
        },
        required: ["date"],
      },
    });

    functionDeclarations.push({
      name: "list_google_calendar_events",
      description:
        "Lista os eventos já agendados num intervalo de datas. Use QUANDO o cliente pedir pra cancelar/remarcar uma reunião, pra você descobrir o event_id dela. Retorna array com {id, summary, start, end, attendees}. Depois de listar, use cancel_google_calendar_event passando o id correto (o que bate com o que o cliente descreveu). NUNCA chute event_id.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          date_from: { type: SchemaType.STRING, description: "Data inicial (YYYY-MM-DD). Se o cliente só disse 'amanhã' ou 'sexta', use essa mesma data aqui." },
          date_to: { type: SchemaType.STRING, description: "Data final (YYYY-MM-DD). Opcional. Se omitir, considera só o date_from (único dia)." },
        },
        required: ["date_from"],
      },
    });

    functionDeclarations.push({
      name: "cancel_google_calendar_event",
      description:
        "Cancela (deleta) um evento do Google Calendar. PRÉ-REQUISITO: você JÁ DEVE ter chamado list_google_calendar_events nesta conversa pra obter o event_id real — é PROIBIDO inventar event_id. Se a lista retornar vários eventos no período, confirme com o cliente qual antes de cancelar.",
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          event_id: { type: SchemaType.STRING, description: "ID exato do evento retornado por list_google_calendar_events. Copie o campo 'id' da listagem." },
          reason: { type: SchemaType.STRING, description: "Motivo opcional (ex: 'cliente não poderá comparecer'). Fica no log interno." },
        },
        required: ["event_id"],
      },
    });
  }

  for (const t of customTools) {
    functionDeclarations.push({
      name: t.name,
      description: t.description,
      parameters: {
        type: SchemaType.OBJECT,
        properties: {
          query: { type: SchemaType.STRING, description: "Argumento principal, formato livre a seu critério" },
        },
        required: ["query"],
      },
    });
  }

  if (activeStage) {
    const varsToCapture = activeStage.captured_variables;
    if (Array.isArray(varsToCapture) && varsToCapture.length > 0) {
      const properties: Record<string, { type: SchemaType; description: string }> = {};
      for (const v of varsToCapture) {
        if (v.name) {
          properties[v.name] = { type: SchemaType.STRING, description: v.description || v.name };
        }
      }
      functionDeclarations.push({
        name: "save_variables",
        description: "Salva as variáveis que você extraiu do cliente na etapa atual. Chame assim que o cliente responder com as informações.",
        parameters: { type: SchemaType.OBJECT, properties },
      });
    }

    functionDeclarations.push({
      name: "complete_current_stage",
      description: "Chame esta ferramenta apenas quando você considerar que concluiu o objetivo da etapa atual E já salvou todas as variáveis necessárias. Isso moverá o cliente para a próxima etapa.",
    });
  }

  return functionDeclarations;
}

