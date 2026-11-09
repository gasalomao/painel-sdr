import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { getAiKeys } from "@/lib/ai-keys";
import { generateText, providerDisplayName } from "@/lib/ai-provider";
import { extractJsonSafe, isTerminalColumn } from "@/lib/organizer-prompt";
import { logTokenUsage } from "@/lib/token-usage";

export const dynamic = "force-dynamic";

/**
 * POST /api/organizer/suggest-prompt { agentId?, model? }
 *
 * Gera um prompt personalizado do Organizador IA para ESTE cliente,
 * lendo:
 *   1) As colunas atuais do Kanban (kanban_columns)
 *   2) O agente IA ativo da conta (agent_settings)
 *
 * Funciona com TODOS os provedores (OpenCode/Gateway, OpenRouter, NVIDIA NIM, Combos e Gemini).
 */
export async function POST(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const requestedAgentId = body.agentId ? Number(body.agentId) : null;
  const requestedModel = typeof body.model === "string" ? body.model.trim() : "";

  const [{ data: cfg }, { data: cols }, { data: agents }, aiKeys] = await Promise.all([
    supabaseAdmin
      .from("ai_organizer_config")
      .select("api_key, openrouter_api_key, nvidia_api_key, model")
      .eq("id", 1)
      .maybeSingle(),
    supabaseAdmin
      .from("kanban_columns")
      .select("*")
      .eq("client_id", ctx.clientId)
      .order("order_index", { ascending: true }),
    supabaseAdmin
      .from("agent_settings")
      .select("id, name, role, main_prompt, personality, tone, is_active, options")
      .eq("client_id", ctx.clientId)
      .order("id", { ascending: false }),
    getAiKeys(),
  ]);

  const geminiKey = (cfg?.api_key || aiKeys.gemini || process.env.GEMINI_API_KEY || "").trim();
  const openrouterKey = (cfg?.openrouter_api_key || aiKeys.openrouter || process.env.OPENROUTER_API_KEY || "").trim();
  const nvidiaKey = (cfg?.nvidia_api_key || aiKeys.nvidia || process.env.NVIDIA_API_KEY || "").trim();

  if (!cols || cols.length === 0) {
    return NextResponse.json({ ok: false, error: "Configure ao menos uma coluna no Kanban antes de gerar o prompt." }, { status: 400 });
  }

  const agent = requestedAgentId
    ? (agents || []).find((a: any) => a.id === requestedAgentId)
    : (agents || []).find((a: any) => a.is_active) || (agents || [])[0];

  if (!agent) {
    return NextResponse.json({ ok: false, error: "Nenhum agente IA encontrado neste cliente. Crie um em /agente primeiro." }, { status: 404 });
  }

  const model =
    (ctx.isAdmin && requestedModel ? requestedModel : "") ||
    cfg?.model ||
    aiKeys.defaultAiModel ||
    "gemini-2.5-flash";

  const kanbanDescription = cols
    .map((c: any, i: number) => {
      const term = isTerminalColumn(c) ? " [TERMINAL]" : "";
      return `  ${i}. status_key="${c.status_key}" → label="${c.label}"${term}`;
    })
    .join("\n");

  const customGoal = (agent as any)?.options?.custom_goal_text || "";

  const systemPrompt = `
Você é um especialista sênior em CRM e Classificação Automática de Conversas no WhatsApp.
Sua missão é escrever as diretrizes do Organizador IA ("organizer_prompt") sob medida para:
1. O nicho e o fluxo do Agente de IA do cliente.
2. As colunas REAIS do Kanban deste cliente (usando EXATAMENTE os status_key listados).

REGRAS OBRIGATÓRIAS:
- Escreva um prompt estruturado, direto e de alta precisão (entre 18 e 30 linhas) em português.
- Explique para cada "status_key" do Kanban a condição exata da conversa (o que o CLIENTE disse vs. o que o SDR/IA enviou) que faz o lead ir para aquela coluna.
- Deixe explícito:
  1. Mensagens "SDR:" são da nossa empresa/IA; mensagens "CLIENTE:" são do lead.
  2. Se apenas o SDR falou e o cliente não respondeu (ou só mandou saudação automática única), manter em "primeiro_contato" (ou "follow-up").
  3. Se o atendimento do cliente for um robô/URA preso em loop repetitivo ("Escolha 1 ou 2", "Não entendemos sua mensagem") ou número errado → mover para a coluna de descarte ("descartado").
  4. Regra Anti-Regressão: um lead que já avançou (ex: já pediu prévia, já recebeu link/proposta ou já agendou) NUNCA volta para colunas iniciais só porque respondeu "ok", "obrigado", "combinado" ou reagiu com emoji ("❤️", "👍").
  5. Instrução final do formato JSON esperado pelo avaliador: array JSON com { "jid", "status", "lead_type", "razao", "resumo" }.

FORMATO DE SAÍDA (APENAS JSON VÁLIDO, SEM MARKDOWN):
{
  "business_type": "Resumo de 1 linha do nicho e fluxo identificados",
  "organizer_prompt": "Texto completo do prompt personalizado para este Kanban..."
}
`.trim();

  const userPrompt = `
=== AGENTE IA DESTA CONTA ===
Nome: ${agent.name || "(sem nome)"}
Função/Cargo: ${agent.role || "(não informado)"}
Objetivo personalizado: ${customGoal || "(não definido)"}
Personalidade: ${(agent.personality || "").slice(0, 400)}
Tom de voz: ${(agent.tone || "").slice(0, 300)}

Instruções / Roteiro do Agente:
${(agent.main_prompt || "(vazio)").slice(0, 4200)}

=== COLUNAS REAIS DO KANBAN DESTA CONTA ===
${kanbanDescription}
`.trim();

  try {
    const out = await generateText({
      model,
      systemPrompt,
      userPrompt,
      temperature: 0.3,
      maxTokens: 2500,
      jsonMode: true,
      reasoningMode: 0,
      geminiApiKey: geminiKey,
      openrouterApiKey: openrouterKey,
      nvidiaApiKey: nvidiaKey,
    });

    await logTokenUsage({
      source: "organizer",
      sourceId: agent.id,
      sourceLabel: `suggest-prompt:${agent.name}`,
      clientId: ctx.clientId,
      model: out.model,
      provider: providerDisplayName(out.provider),
      promptTokens: out.usage.promptTokens,
      completionTokens: out.usage.completionTokens,
      totalTokens: out.usage.totalTokens,
      metadata: { estimated: out.usage.estimated || undefined },
    });

    const parsed = extractJsonSafe<any>(out.text);

    if (!parsed || typeof parsed.organizer_prompt !== "string" || parsed.organizer_prompt.trim().length < 80) {
      return NextResponse.json({ ok: false, error: "IA retornou prompt vazio ou incompleto. Tente novamente." }, { status: 500 });
    }

    const suggestionPayload = {
      business_type: String(parsed.business_type || "Negócio identificado").slice(0, 240),
      organizer_prompt: parsed.organizer_prompt.trim(),
      model,
    };

    return NextResponse.json({
      ok: true,
      ...suggestionPayload,
      suggestion: suggestionPayload,
    });
  } catch (e: any) {
    console.error("[suggest-prompt] erro:", e?.message);
    return NextResponse.json(
      { ok: false, error: `Falha ao gerar prompt: ${e?.message || "erro desconhecido"}` },
      { status: 500 }
    );
  }
}
