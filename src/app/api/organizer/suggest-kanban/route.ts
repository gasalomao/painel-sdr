import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { getAiKeys } from "@/lib/ai-keys";
import { generateText, providerDisplayName, providerOf } from "@/lib/ai-provider";
import { logTokenUsage } from "@/lib/token-usage";
import { extractJsonSafe, isTerminalColumn } from "@/lib/organizer-prompt";

export const dynamic = "force-dynamic";

/**
 * POST /api/organizer/suggest-kanban { agentId }
 *
 * Lê o agente escolhido pelo cliente (nome, cargo, prompt, personalidade, tom)
 * e pede pra IA sugerir:
 *   1) As colunas ideais do Kanban para aquele negócio/funil (com status_key, label, cor, is_terminal e rationale)
 *   2) Um prompt de Organizador IA enxuto, cirúrgico e sob medida para aquelas colunas e nicho
 *
 * Funciona com TODOS os provedores (OpenCode/Gateway, OpenRouter, NVIDIA NIM, Combos e Gemini).
 */
export async function POST(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const agentId = Number(body.agentId);
  if (!agentId) return NextResponse.json({ ok: false, error: "agentId é obrigatório" }, { status: 400 });

  const { data: agent, error: agentErr } = await supabaseAdmin
    .from("agent_settings")
    .select("id, name, role, main_prompt, personality, tone, client_id, options")
    .eq("id", agentId)
    .eq("client_id", ctx.clientId)
    .maybeSingle();
  if (agentErr || !agent) {
    return NextResponse.json({ ok: false, error: "Agente não encontrado neste cliente" }, { status: 404 });
  }

  const [{ data: cfg }, aiKeys] = await Promise.all([
    supabaseAdmin
      .from("ai_organizer_config")
      .select("api_key, openrouter_api_key, nvidia_api_key, model")
      .eq("id", 1)
      .maybeSingle(),
    getAiKeys(),
  ]);

  const geminiKey = (cfg?.api_key || aiKeys.gemini || process.env.GEMINI_API_KEY || "").trim();
  const openrouterKey = (cfg?.openrouter_api_key || aiKeys.openrouter || process.env.OPENROUTER_API_KEY || "").trim();
  const nvidiaKey = (cfg?.nvidia_api_key || aiKeys.nvidia || process.env.NVIDIA_API_KEY || "").trim();

  const requestedModel = typeof body.model === "string" ? body.model.trim() : "";
  const model =
    (ctx.isAdmin && requestedModel ? requestedModel : "") ||
    cfg?.model ||
    aiKeys.defaultAiModel ||
    "gemini-2.5-flash";

  const customGoal = (agent as any)?.options?.custom_goal_text || "";

  const systemPrompt = `
Você é um especialista sênior em CRM, Funis de Vendas no WhatsApp e Automação Comercial.
Sua tarefa é analisar o Agente de IA abaixo e desenhar:
1. A estrutura de colunas do Kanban PERFEITA para o nicho e o fluxo exato desse agente.
2. As diretrizes do Organizador IA que vão mover os leads automaticamente entre essas colunas analisando as conversas.

REGRAS PARA AS COLUNAS ("columns"):
- Sugira entre 6 e 10 colunas em ordem lógica de avanço no funil (do início ao fechamento/descarte).
- A PRIMEIRA coluna (index 0) DEVE ter status_key="novo" e is_system=true (leads recém-extraídos/cadastrados sem abordagem).
- Logo após "novo", inclua etapas que reflitam a jornada real do agente. Exemplo:
  - Se o agente prospecta empresas e oferece uma PRÉVIA GRATUITA de site antes de agendar ligação: crie colunas para "primeiro_contato", "em_qualificacao", "previa_solicitada", "em_negociacao" (prévia enviada/proposta), "agendado", "follow-up", "fechado", "sem_interesse", "descartado".
  - Se o agente é de clínica/consultório/estética/advocacia/imobiliária: crie colunas fiéis ao funil desse nicho (ex: "novo", "primeiro_contato", "em_triagem", "orcamento_enviado", "agendado", "follow-up", "fechado", "sem_interesse", "descartado").
- Cada coluna deve ter:
  - "status_key": slug curto em snake_case minúsculo sem acentos (ex: "primeiro_contato", "previa_solicitada").
  - "label": Nome claro em português (máx 26 caracteres).
  - "color": Cor hex vibrante e distinta (#3b82f6, #06b6d4, #8b5cf6, #a855f7, #ec4899, #f59e0b, #f97316, #22c55e, #ef4444, #737373).
  - "is_terminal": true APENAS para colunas finais (ex: venda fechada, sem interesse, descartado); false para as demais.
  - "rationale": 1 frase curta explicando quando o lead entra nessa coluna.

REGRAS PARA O PROMPT ("organizer_prompt"):
- Escreva um prompt objetivo, claro e direto (entre 15 e 25 linhas) instruindo o Organizador IA sobre como classificar as conversas deste nicho usando exatamente os "status_key" das colunas sugeridas.
- Explique claramente:
  - Quando mover para cada "status_key" com base no que o CLIENTE respondeu vs. o que o SDR/IA enviou.
  - Que leads onde só o SDR falou (sem resposta humana real) ficam em "primeiro_contato" (ou "follow-up").
  - Que URAs/robôs em loop ou números errados vão para "descartado".
  - Que leads em etapas avançadas não devem regredir de coluna por respostas curtas ("ok", "obrigado", "❤️").

FORMATO DE SAÍDA (APENAS JSON VÁLIDO, SEM MARKDOWN):
{
  "business_type": "Resumo de 1 linha do nicho e objetivo identificados",
  "columns": [
    { "status_key": "novo", "label": "Lead Extraído", "color": "#3b82f6", "is_terminal": false, "rationale": "..." }
  ],
  "organizer_prompt": "Texto das diretrizes do organizador adaptado às colunas acima..."
}
`.trim();

  const userPrompt = `
DADOS DO AGENTE DE IA DA CONTA:
Nome: ${agent.name || "(sem nome)"}
Função/Cargo: ${agent.role || "(não informado)"}
Objetivo personalizado ativo: ${customGoal || "(não definido)"}
Personalidade: ${(agent.personality || "").slice(0, 400)}
Tom de voz: ${(agent.tone || "").slice(0, 300)}

INSTRUÇÕES / ROTEIRO DO AGENTE:
${(agent.main_prompt || "(vazio)").slice(0, 4500)}
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
      sourceLabel: `suggest-kanban:${agent.name}`,
      clientId: ctx.clientId,
      model: out.model,
      provider: providerDisplayName(out.provider),
      promptTokens: out.usage.promptTokens,
      completionTokens: out.usage.completionTokens,
      totalTokens: out.usage.totalTokens,
      metadata: { estimated: out.usage.estimated || undefined },
    });

    const parsed = extractJsonSafe<any>(out.text);

    if (!Array.isArray(parsed?.columns) || parsed.columns.length < 3 || typeof parsed.organizer_prompt !== "string") {
      return NextResponse.json({ ok: false, error: "IA retornou estrutura incompleta. Tente novamente." }, { status: 500 });
    }

    const sanitizedCols = parsed.columns.slice(0, 12).map((c: any, idx: number) => {
      const status_key = idx === 0
        ? "novo"
        : String(c.status_key || `col_${idx}`)
            .toLowerCase()
            .normalize("NFD")
            .replace(/[\u0300-\u036f]/g, "")
            .replace(/[^a-z0-9_-]/g, "_")
            .slice(0, 30);
      const label = String(c.label || status_key).trim().slice(0, 32);
      const is_terminal =
        idx === 0
          ? false
          : typeof c.is_terminal === "boolean"
            ? c.is_terminal
            : isTerminalColumn({ status_key, label });
      return {
        status_key,
        label,
        color: /^#[0-9a-fA-F]{6}$/.test(String(c.color || "")) ? c.color : "#6b7280",
        order_index: idx,
        is_system: idx === 0,
        is_terminal,
        rationale: String(c.rationale || "").slice(0, 200),
      };
    });

    const suggestionPayload = {
      business_type: String(parsed.business_type || "Negócio identificado").slice(0, 240),
      columns: sanitizedCols,
      organizer_prompt: parsed.organizer_prompt.trim(),
    };

    return NextResponse.json({
      ok: true,
      ...suggestionPayload,
      suggestion: suggestionPayload,
    });
  } catch (e: any) {
    console.error("[suggest-kanban] erro:", e?.message);
    return NextResponse.json(
      { ok: false, error: `Falha ao gerar sugestão: ${e?.message || "erro desconhecido"}` },
      { status: 500 }
    );
  }
}
