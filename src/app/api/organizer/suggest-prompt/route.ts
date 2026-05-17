import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { logTokenUsage, extractGeminiUsage } from "@/lib/token-usage";
import { DEFAULT_ORGANIZER_BASE_PROMPT } from "@/lib/organizer-prompt";

export const dynamic = "force-dynamic";

/**
 * POST /api/organizer/suggest-prompt   body: { agentId? }
 *
 * Diferente de /suggest-kanban (que propõe colunas novas), aqui o kanban já
 * existe — só reescrevemos o PROMPT do Organizador adaptado ao nicho do
 * agente + status_keys das colunas que já estão configuradas.
 *
 * Retorna o texto sugerido (sem salvar). UI deixa o usuário revisar + aplicar.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const body = await req.json().catch(() => ({}));

  const { data: cfg } = await supabaseAdmin
    .from("ai_organizer_config")
    .select("api_key, model")
    .eq("id", 1)
    .maybeSingle();
  if (!cfg?.api_key) {
    return NextResponse.json({ ok: false, error: "API Key do Gemini não configurada. Avise o admin." }, { status: 400 });
  }

  // Agente (1º do cliente ou o informado)
  let agentQ = supabaseAdmin
    .from("agent_settings")
    .select("id, name, role, personality, tone, main_prompt")
    .eq("client_id", ctx.clientId);
  agentQ = body.agentId
    ? agentQ.eq("id", body.agentId).limit(1)
    : agentQ.order("id", { ascending: true }).limit(1);
  const { data: agents } = await agentQ;
  const agent = (agents || [])[0];
  if (!agent) {
    return NextResponse.json({ ok: false, error: "Nenhum agente IA cadastrado pra esta conta. Crie um em /agente primeiro." }, { status: 404 });
  }

  // Kanban atual (precisa ter colunas)
  const { data: cols } = await supabaseAdmin
    .from("kanban_columns")
    .select("status_key, label, order_index")
    .eq("client_id", ctx.clientId)
    .order("order_index", { ascending: true });
  if (!cols || cols.length === 0) {
    return NextResponse.json({ ok: false, error: "Seu Kanban está vazio. Crie colunas (ou use Sugestão automática) antes de gerar o prompt." }, { status: 400 });
  }

  // Base de conhecimento do agente — dá contexto do nicho real
  const { data: kb } = await supabaseAdmin
    .from("agent_knowledge")
    .select("title, content")
    .eq("client_id", ctx.clientId)
    .eq("agent_id", agent.id)
    .limit(15);
  const knowledgeSnippet = (kb || []).slice(0, 10).map((k) =>
    `- ${k.title}: ${String(k.content || "").slice(0, 200)}`
  ).join("\n");

  const kanbanList = cols.map((c, i) => `  ${i}. status_key="${c.status_key}" → label="${c.label}"`).join("\n");

  const prompt = `Você é especialista em CRM e funis de venda multi-nicho.

Tarefa: REESCREVER o template padrão de prompt do Organizador IA, mantendo
fielmente toda a estrutura (todas as 17 regras R1-R17, seções HIERARQUIA,
COMO ESCREVER razao/resumo, ARMADILHAS, FORMATO DE RESPOSTA) — mas:

1) Adaptar VOCABULÁRIO e EXEMPLOS ao nicho real do agente abaixo
   (ex: manicure → "agendamento", "atendimento", "esmalte";
    advocacia → "consulta", "processo", "honorário";
    SaaS → "trial", "onboarding", "churn").

2) Substituir todas as menções a status genéricos pelos status_key REAIS
   do kanban configurado abaixo. NÃO invente status que não estão na lista.

3) Adaptar a regra de HIERARQUIA pra refletir a ordem real do kanban.

4) Identificar quais status_key são TERMINAIS POSITIVOS (compra/atendimento
   concluído) e TERMINAIS NEGATIVOS (cancelado/perdido) e mencioná-los
   explicitamente nas regras R3, R11, R17 (terminais positivos) e R1, R2,
   R15-cancela (terminais negativos).

## AGENTE IA DA CONTA
- Nome: ${agent.name || "(sem nome)"}
- Função: ${agent.role || "(não especificada)"}
- Personalidade: ${agent.personality || "(não especificada)"}
- Tom: ${agent.tone || "(não especificado)"}

## Prompt principal do agente
${(agent.main_prompt || "(vazio)").slice(0, 2000)}

## Base de conhecimento (amostra)
${knowledgeSnippet || "(vazia)"}

## KANBAN ATUAL — use EXATAMENTE estes status_key nas regras
${kanbanList}

## TEMPLATE OBRIGATÓRIO PRA REESCREVER (preserve cada regra R1-R17 e cada seção)

${DEFAULT_ORGANIZER_BASE_PROMPT}

## Regras de saída
- Em PT-BR, instrutivo, sem markdown extra.
- Preserve a contagem de regras (R1 até R17).
- USE os status_key acima literalmente dentro das regras (não os labels).
- Saída: somente o texto do prompt reescrito (string única), nada mais.`;

  const genAI = new GoogleGenerativeAI(cfg.api_key);
  const modelName = cfg.model || "gemini-2.5-flash";
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          business_type: { type: SchemaType.STRING, description: "Nicho identificado em 2-4 palavras." },
          organizer_prompt: { type: SchemaType.STRING, description: "Prompt reescrito com R1-R17 adaptado. Mínimo 2000 chars." },
        },
        required: ["business_type", "organizer_prompt"],
      },
    },
  });

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const parsed = JSON.parse(text);

    const u = extractGeminiUsage(result);
    await logTokenUsage({
      source: "organizer",
      sourceId: ctx.clientId,
      sourceLabel: "Sugestão de prompt",
      model: modelName,
      promptTokens: u.promptTokens,
      completionTokens: u.completionTokens,
      totalTokens: u.totalTokens,
      clientId: ctx.clientId,
      metadata: { kind: "suggest_prompt", agentId: agent.id, kanbanCols: cols.length },
    });

    return NextResponse.json({
      ok: true,
      suggestion: parsed,
      model: modelName,
      kanbanCols: cols.map(c => ({ status_key: c.status_key, label: c.label })),
      agentName: agent.name,
    });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: "Falha ao gerar sugestão: " + (e?.message || String(e)) }, { status: 500 });
  }
}
