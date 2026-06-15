import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { webSearch } from "@/lib/web-search";
import { logTokenUsage } from "@/lib/token-usage";
import { requireClientId } from "@/lib/tenant";
import { startAiChat, providerOf, providerDisplayName } from "@/lib/ai-provider";

export async function POST(req: NextRequest) {
  // AUTH: precisa de sessão. Sem auth qualquer um queimava a Gemini API key.
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;

  try {
    const { baseMessage, model, customPrompt, nomeEmpresa, ramo, useWebSearch } = await req.json();

    if (!baseMessage) {
      return NextResponse.json({ success: false, error: "baseMessage é obrigatório" }, { status: 400 });
    }

    // 1. Pegar API Keys das configurações do sistema (Gemini + OpenRouter).
    const { data: cfg } = await supabase.from("ai_organizer_config").select("api_key, openrouter_api_key").eq("id", 1).maybeSingle();
    const geminiApiKey = cfg?.api_key && String(cfg.api_key).trim() ? String(cfg.api_key).trim() : null;
    const openrouterApiKey = (cfg as any)?.openrouter_api_key && String((cfg as any).openrouter_api_key).trim()
      ? String((cfg as any).openrouter_api_key).trim() : null;

    const { resolveModel } = await import("@/lib/ai-default-model");
    const aiModelName = await resolveModel(model, ctx.clientId);
    if (!aiModelName) {
      return NextResponse.json({ success: false, error: "Modelo IA não configurado pelo admin." }, { status: 400 });
    }
    const provider = providerOf(aiModelName);
    if (provider === "gemini" && !geminiApiKey) {
      return NextResponse.json({ success: false, error: "Sem API key Gemini configurada no sistema. Salve em Configurações." }, { status: 400 });
    }
    if (provider === "openrouter" && !openrouterApiKey) {
      return NextResponse.json({ success: false, error: "Sem API key OpenRouter configurada no sistema. Salve em Configurações." }, { status: 400 });
    }

    // 2. Definir tools se o Web Search estiver ativado (declaração neutra).
    const tools = useWebSearch ? [{
      name: "web_search",
      description: "Busca rápida na internet. Use pra descobrir algo específico sobre a empresa do cliente que tornaria a mensagem mais relevante.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "O que buscar — frase curta" } },
        required: ["query"],
      },
    }] : [];
    // 3. Montar Prompt do Sistema
    const customInstructions = customPrompt?.trim();
    const sys = customInstructions
      ? `${customInstructions}\n\nDADOS DO LEAD:\n- Empresa: ${nomeEmpresa || "(não informada)"}\n- Ramo: ${ramo || "(não informado)"}\n\nMENSAGEM-BASE (template do operador):\n"""\n${baseMessage}\n"""\n\n${useWebSearch ? "Ferramenta web_search disponível: use no máximo 1x pra pegar UM detalhe relevante da empresa." : ""}\n\nDevolva APENAS a mensagem final, em PT-BR, sem aspas, sem explicação.`
      : `Você é um SDR experiente fazendo uma primeira abordagem PROFISSIONAL via WhatsApp.\n\nDADOS DO LEAD:\n- Empresa: ${nomeEmpresa || "(não informada)"}\n- Ramo: ${ramo || "(não informado)"}\n\nMENSAGEM-BASE (template do operador):\n"""\n${baseMessage}\n"""\n\nINSTRUÇÕES:\n- Reescreva a MENSAGEM-BASE de forma natural, curta (até 3 frases), em PT-BR.\n- Mantenha o sentido original do template.\n- Personalize SUTILMENTE pra empresa/ramo (sem inventar nada).\n${useWebSearch ? "- Se útil, use a tool web_search pra confirmar UM detalhe da empresa (1 chamada no máximo). NÃO repita pesquisas." : ""}\n- Não use emojis exagerados.\n- NÃO invente dados que não tem certeza.\n- Devolva APENAS a mensagem final, sem aspas e sem explicação.`;

    // Sessão de chat unificada (Gemini OU OpenRouter, conforme o modelo).
    const session = await startAiChat({
      modelRef: aiModelName,
      systemInstruction: sys,
      history: [],
      tools,
      geminiApiKey,
      openrouterApiKey,
    });

    let turn = await session.sendUser("Gere a mensagem final agora.");
    const effectiveModel = session.modelUsed();

    // Acumula tokens
    let tp = turn.usage.promptTokens, tc = turn.usage.completionTokens, tt = turn.usage.totalTokens;
    let finalText = turn.text.replace(/^["']|["']$/g, "");

    // 4. Lidar com Web Search Tool Call
    const call = turn.toolCalls[0];
    if (call && useWebSearch && call.name === "web_search") {
      const q = String((call.args as any)?.query || "");
      try {
        const results = await webSearch(q, 3);
        const summary = results.length > 0
          ? results.map(r => `${r.title}: ${r.snippet}`).join("\n")
          : "Nenhum resultado.";
        turn = await session.sendToolResults([{ name: "web_search", id: call.id, response: { results: summary } }]);
        tp += turn.usage.promptTokens; tc += turn.usage.completionTokens; tt += turn.usage.totalTokens;
        finalText = turn.text.replace(/^["']|["']$/g, "");
      } catch {
        // Mantém finalText anterior
      }
    }

    // Tracking — antes só devolvia `usage` no JSON sem gravar em ai_token_usage.
    // Resultado: gastos do Agent Rewrite invisíveis no painel /tokens.
    await logTokenUsage({
      source: "agent",
      sourceLabel: "Agent Rewrite",
      // Loga o modelo que REALMENTE foi cobrado (pode diferir do pedido se houve fallback)
      model: effectiveModel,
      provider: providerDisplayName(provider),
      promptTokens: tp,
      completionTokens: tc,
      totalTokens: tt,
      clientId: ctx.clientId,
      metadata: {
        useWebSearch: !!useWebSearch,
        nomeEmpresa: nomeEmpresa || null,
        ramo: ramo || null,
      },
    });

    return NextResponse.json({
      success: true,
      text: finalText,
      usage: { promptTokens: tp, completionTokens: tc, totalTokens: tt }
    });
  } catch (error: any) {
    console.error("[AGENT REWRITE API ERROR]", error);
    return NextResponse.json({ success: false, error: error.message || String(error) }, { status: 500 });
  }
}
