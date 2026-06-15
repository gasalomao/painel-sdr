import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { logTokenUsage } from "@/lib/token-usage";
import { DEFAULT_ORGANIZER_BASE_PROMPT } from "@/lib/organizer-prompt";
import { resolveModel } from "@/lib/ai-default-model";
import { generateText, providerOf, providerDisplayName } from "@/lib/ai-provider";

export const dynamic = "force-dynamic";

/**
 * POST /api/organizer/suggest-kanban
 *
 * Analisa o agente IA principal do cliente (name, role, personality, prompt,
 * knowledge base) e usa Gemini pra sugerir:
 *   - Lista de colunas Kanban adequadas ao negócio
 *   - Prompt customizado pro Organizador IA
 *
 * O cliente pode aceitar (replace) ou rejeitar. Não persiste nada — só
 * retorna a sugestão.
 *
 * Body opcional: { agentId } — se ausente, pega o 1º agente do cliente.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const body = await req.json().catch(() => ({}));

  // 1) Pega API keys centrais (Gemini + OpenRouter)
  const { data: cfg } = await supabaseAdmin
    .from("ai_organizer_config")
    .select("api_key, openrouter_api_key, model")
    .eq("id", 1)
    .maybeSingle();
  const geminiApiKey = cfg?.api_key && String(cfg.api_key).trim() ? String(cfg.api_key).trim() : null;
  const openrouterApiKey = (cfg as any)?.openrouter_api_key && String((cfg as any).openrouter_api_key).trim()
    ? String((cfg as any).openrouter_api_key).trim() : null;
  if (!geminiApiKey && !openrouterApiKey) {
    return NextResponse.json({ ok: false, error: "Nenhuma API Key de IA configurada em /configuracoes" }, { status: 400 });
  }

  // 2) Pega o agente do cliente (1º se não passou agentId)
  let agentQ = supabaseAdmin
    .from("agent_settings")
    .select("id, name, role, personality, tone, main_prompt")
    .eq("client_id", ctx.clientId)
    .order("id", { ascending: true })
    .limit(1);
  if (body.agentId) agentQ = supabaseAdmin
    .from("agent_settings")
    .select("id, name, role, personality, tone, main_prompt")
    .eq("client_id", ctx.clientId)
    .eq("id", body.agentId)
    .limit(1);

  const { data: agents } = await agentQ;
  const agent = (agents || [])[0];
  if (!agent) {
    return NextResponse.json({ ok: false, error: "Nenhum agente IA encontrado pra este cliente. Crie um agente em /agente primeiro." }, { status: 404 });
  }

  // 3) Pega bases de conhecimento (dá mais contexto sobre o negócio)
  const { data: kb } = await supabaseAdmin
    .from("agent_knowledge")
    .select("title, content")
    .eq("client_id", ctx.clientId)
    .eq("agent_id", agent.id)
    .limit(20);

  // 4) Monta o prompt pro Gemini
  const knowledgeSnippet = (kb || []).slice(0, 10).map((k) =>
    `- ${k.title}: ${String(k.content || "").slice(0, 200)}`
  ).join("\n");

  // Detecta agente "vazio/genérico": sem dados suficientes pra identificar nicho.
  // Nesse caso instruímos o modelo a NÃO inventar nicho aleatório (era a causa de
  // sugerir "Salão de Beleza" pra um agente sem prompt definido).
  const mainPrompt = (agent.main_prompt || "").trim();
  const knowledgeIsEmpty = !knowledgeSnippet;
  const promptIsThin = mainPrompt.replace(/\s+/g, " ").length < 80;
  const agentInfoIsThin = promptIsThin && knowledgeIsEmpty
    && (!agent.role || agent.role.trim().length < 8);

  const groundingRule = agentInfoIsThin
    ? `\n## ⚠ ATENÇÃO — INFORMAÇÃO INSUFICIENTE
O prompt/função/conhecimento deste agente NÃO descrevem um nicho específico.
NÃO INVENTE um nicho (não escolha salão, clínica, imobiliária, etc por conta
própria). Defina business_type EXATAMENTE como
"Genérico — defina o prompt do agente para personalizar" e gere um kanban
GENÉRICO de vendas/atendimento com estes status_key: novo, em_contato,
qualificado, agendado, fechado, perdido. Use vocabulário neutro no prompt
reescrito (cliente, atendimento, proposta), sem termos de nicho.`
    : `\nIdentifique o nicho ESTRITAMENTE a partir do que está descrito no agente
abaixo (função, personalidade, prompt principal, base de conhecimento). É
PROIBIDO inventar um nicho que não esteja claramente indicado nesses dados —
na dúvida, prefira um kanban genérico de vendas/atendimento a chutar um ramo.`;

  const prompt = `Você é especialista em CRM e processos de venda multi-nicho.

Sua tarefa: a partir EXCLUSIVAMENTE das informações do agente IA abaixo,
gerar DUAS coisas adequadas ao negócio REAL desse agente:
${groundingRule}

1. Estrutura de Kanban (5 a 8 colunas) adequada ao negócio do agente.
2. Prompt customizado pro Organizador IA — REESCRITA do template padrão
   abaixo, mantendo TODAS as 17 regras (R1-R17) e a estrutura, mas:
   - Adaptando exemplos e vocabulário ao negócio identificado a partir do agente.
   - Substituindo nas regras as MENÇÕES de status pelos status_key que VOCÊ
     vai sugerir no kanban (use os mesmos status_key na lista de colunas E
     dentro do prompt).
   - Mantendo as seções "REGRAS DE DECISÃO", "HIERARQUIA", "COMO ESCREVER
     razao E resumo", "ARMADILHAS", "FORMATO DE RESPOSTA" — todas elas.
   - Preservando o cabeçalho que explica que recebe conversas de HOJE +
     contexto histórico + flags ⚑.

## Agente IA (ÚNICA fonte do nicho)
- Nome: ${agent.name || "(sem nome)"}
- Função: ${agent.role || "(não especificada)"}
- Personalidade: ${agent.personality || "(não especificada)"}
- Tom de voz: ${agent.tone || "(não especificado)"}

## Prompt principal do agente
${(mainPrompt || "(vazio)").slice(0, 2000)}

## Base de conhecimento (amostra)
${knowledgeSnippet || "(vazia)"}

## TEMPLATE OBRIGATÓRIO do prompt do Organizador (reescreva preservando estrutura R1-R17)

${DEFAULT_ORGANIZER_BASE_PROMPT}

## Regras pras colunas do kanban
- status_key: snake_case, ASCII, sem espaços, coerente com o negócio do agente.
- label: nome user-friendly em PT-BR.
- color: hex 7-char (#3b82f6). Azul/ciano pra estágios iniciais, amarelo/laranja
  pra intermediários, verde pra positivos (fechado/atendido), vermelho pra
  perdido/cancelado.
- Sempre inclua coluna inicial ("novo" ou equivalente) e pelo menos UM estágio
  terminal positivo (ex: "fechado", "atendido", "concluido") + UM terminal
  negativo (ex: "perdido", "cancelado", "sem_interesse").

## Regras pro prompt reescrito
- Em PT-BR, instrutivo, claro, MANTENDO a mesma quantidade de regras (R1-R17).
- USE OS MESMOS status_key que você sugeriu nas colunas, dentro das regras.
  (Não invente status que não existem no kanban sugerido.)
- Adapte os EXEMPLOS de cada regra ao nicho real.
- Saída: somente o texto reescrito (sem markdown extra, sem comentário).`;

  // 5) Chama IA (Gemini OU OpenRouter) pedindo saída JSON estruturada.
  const modelName = (await resolveModel(body.model || cfg?.model || "gemini-2.5-flash", ctx.clientId)) || "gemini-2.5-flash";
  const provider = providerOf(modelName);
  if (provider === "gemini" && !geminiApiKey) {
    return NextResponse.json({ ok: false, error: "API Key Gemini não configurada." }, { status: 400 });
  }
  if (provider === "openrouter" && !openrouterApiKey) {
    return NextResponse.json({ ok: false, error: "API Key OpenRouter não configurada." }, { status: 400 });
  }

  // Schema estruturado (só Gemini garante via responseSchema; o prompt já
  // descreve o formato, então o OpenRouter em json_object também devolve JSON).
  const geminiResponseSchema = {
    type: "object",
    properties: {
      business_type: { type: "string", description: "Ex: 'SaaS B2B', 'Atendimento e-commerce', 'Clínica médica', etc" },
      columns: {
        type: "array",
        items: {
          type: "object",
          properties: {
            status_key: { type: "string" },
            label: { type: "string" },
            color: { type: "string" },
            rationale: { type: "string", description: "Por que essa coluna existe e quando usar" },
          },
          required: ["status_key", "label", "color"],
        },
      },
      organizer_prompt: {
        type: "string",
        description: "Reescrita do template R1-R17 adaptada ao nicho + status_keys das colunas sugeridas. Mínimo 2000 chars.",
      },
    },
    required: ["business_type", "columns", "organizer_prompt"],
  };

  try {
    const out = await generateText({
      modelRef: modelName,
      prompt,
      jsonMode: true,
      geminiResponseSchema,
      geminiApiKey,
      openrouterApiKey,
    });
    const parsed = JSON.parse(out.text);

    // Token tracking
    await logTokenUsage({
      source: "organizer",
      sourceId: ctx.clientId,
      sourceLabel: "Sugestão de Kanban",
      model: out.modelUsed,
      provider: providerDisplayName(provider),
      promptTokens: out.usage.promptTokens,
      completionTokens: out.usage.completionTokens,
      totalTokens: out.usage.totalTokens,
      clientId: ctx.clientId,
      metadata: { kind: "suggest_kanban", agentId: agent.id },
    });

    return NextResponse.json({ ok: true, suggestion: parsed, model: modelName });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: "Falha ao gerar sugestão: " + (e?.message || String(e)) }, { status: 500 });
  }
}
