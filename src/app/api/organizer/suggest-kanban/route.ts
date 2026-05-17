import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { logTokenUsage, extractGeminiUsage } from "@/lib/token-usage";
import { DEFAULT_ORGANIZER_BASE_PROMPT } from "@/lib/organizer-prompt";

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

  // 1) Pega API key central do Gemini
  const { data: cfg } = await supabaseAdmin
    .from("ai_organizer_config")
    .select("api_key, model")
    .eq("id", 1)
    .maybeSingle();
  if (!cfg?.api_key) {
    return NextResponse.json({ ok: false, error: "API Key do Gemini não configurada em /configuracoes" }, { status: 400 });
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

  const prompt = `Você é especialista em CRM e processos de venda multi-nicho.

A partir do agente IA descrito abaixo, identifique o NICHO real do negócio
(salão de beleza, manicure, imobiliária, advocacia, clínica, SaaS B2B,
e-commerce, restaurante, qualquer outro) e gere DUAS coisas:

1. Estrutura de Kanban (5 a 8 colunas) adequada AO NICHO REAL.
2. Prompt customizado pro Organizador IA — REESCRITA do template padrão
   abaixo, mantendo TODAS as 17 regras (R1-R17) e a estrutura, mas:
   - Adaptando exemplos e vocabulário pro nicho identificado.
     Ex: pra manicure, falar "agendamento", "atendimento", "esmalte", em vez
     de "reunião", "proposta", "contrato".
   - Substituindo nas regras as MENÇÕES de status pelos status_key que VOCÊ
     vai sugerir no kanban (use os mesmos status_key na lista de colunas E
     dentro do prompt).
   - Mantendo as seções "REGRAS DE DECISÃO", "HIERARQUIA", "COMO ESCREVER
     razao E resumo", "ARMADILHAS", "FORMATO DE RESPOSTA" — todas elas.
   - Preservando o cabeçalho que explica que recebe conversas de HOJE +
     contexto histórico + flags ⚑.

## Agente IA
- Nome: ${agent.name || "(sem nome)"}
- Função: ${agent.role || "(não especificada)"}
- Personalidade: ${agent.personality || "(não especificada)"}
- Tom de voz: ${agent.tone || "(não especificado)"}

## Prompt principal do agente
${(agent.main_prompt || "(vazio)").slice(0, 2000)}

## Base de conhecimento (amostra)
${knowledgeSnippet || "(vazia)"}

## TEMPLATE OBRIGATÓRIO do prompt do Organizador (reescreva preservando estrutura R1-R17)

${DEFAULT_ORGANIZER_BASE_PROMPT}

## Regras pras colunas do kanban
- status_key: snake_case, ASCII, sem espaços. Use vocabulário do nicho
  (ex: pra manicure → "agendado", "em_atendimento", "atendido", "recorrente").
- label: nome user-friendly em PT-BR.
- color: hex 7-char (#3b82f6). Azul/ciano pra estágios iniciais, amarelo/laranja
  pra intermediários, verde pra positivos (fechado/atendido), vermelho pra
  perdido/cancelado.
- Sempre inclua coluna inicial ("novo" ou equivalente do nicho) e pelo menos
  UM estágio terminal positivo (ex: "fechado", "atendido", "concluido") +
  UM terminal negativo (ex: "perdido", "cancelado", "sem_interesse").

## Regras pro prompt reescrito
- Em PT-BR, instrutivo, claro, MANTENDO a mesma quantidade de regras (R1-R17).
- USE OS MESMOS status_key que você sugeriu nas colunas, dentro das regras.
  (Não invente status que não existem no kanban sugerido.)
- Adapte os EXEMPLOS de cada regra ao nicho real.
- Saída: somente o texto reescrito (sem markdown extra, sem comentário).`;

  // 5) Chama Gemini com response schema estruturado pra garantir JSON válido
  const genAI = new GoogleGenerativeAI(cfg.api_key);
  const modelName = cfg.model || "gemini-2.5-flash";
  const model = genAI.getGenerativeModel({
    model: modelName,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: {
        type: SchemaType.OBJECT,
        properties: {
          business_type: { type: SchemaType.STRING, description: "Ex: 'SaaS B2B', 'Atendimento e-commerce', 'Clínica médica', etc" },
          columns: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                status_key: { type: SchemaType.STRING },
                label: { type: SchemaType.STRING },
                color: { type: SchemaType.STRING },
                rationale: { type: SchemaType.STRING, description: "Por que essa coluna existe e quando usar" },
              },
              required: ["status_key", "label", "color"],
            },
          },
          organizer_prompt: {
            type: SchemaType.STRING,
            description: "Reescrita do template R1-R17 adaptada ao nicho + status_keys das colunas sugeridas. Mínimo 2000 chars.",
          },
        },
        required: ["business_type", "columns", "organizer_prompt"],
      },
    },
  });

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const parsed = JSON.parse(text);

    // Token tracking
    const u = extractGeminiUsage(result);
    await logTokenUsage({
      source: "organizer",
      sourceId: ctx.clientId,
      sourceLabel: "Sugestão de Kanban",
      model: modelName,
      promptTokens: u.promptTokens,
      completionTokens: u.completionTokens,
      totalTokens: u.totalTokens,
      clientId: ctx.clientId,
      metadata: { kind: "suggest_kanban", agentId: agent.id },
    });

    return NextResponse.json({ ok: true, suggestion: parsed, model: modelName });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: "Falha ao gerar sugestão: " + (e?.message || String(e)) }, { status: 500 });
  }
}
