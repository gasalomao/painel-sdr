import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { webSearch } from "@/lib/web-search";
import { extractGeminiUsage } from "@/lib/token-usage";

export async function POST(req: NextRequest) {
  try {
    const { baseMessage, model, customPrompt, nomeEmpresa, ramo, useWebSearch } = await req.json();

    if (!baseMessage) {
      return NextResponse.json({ success: false, error: "baseMessage é obrigatório" }, { status: 400 });
    }

    // 1. Pegar API Key das configurações do sistema
    const { data: cfg } = await supabase.from("ai_organizer_config").select("api_key").eq("id", 1).maybeSingle();
    const apiKey = cfg?.api_key || "";
    if (!apiKey) {
      return NextResponse.json({ success: false, error: "Sem API key Gemini configurada no sistema. Salve em Configurações." }, { status: 400 });
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    
    // 2. Definir tools se o Web Search estiver ativado
    const tools = useWebSearch ? [{
      functionDeclarations: [{
        name: "web_search",
        description: "Busca rápida na internet. Use pra descobrir algo específico sobre a empresa do cliente que tornaria a mensagem mais relevante.",
        parameters: {
          type: SchemaType.OBJECT,
          properties: { query: { type: SchemaType.STRING, description: "O que buscar — frase curta" } },
          required: ["query"],
        },
      }],
    }] : undefined;

    const aiModelName = model || "gemini-1.5-flash";
    const generativeModel = genAI.getGenerativeModel({ model: aiModelName, tools });

    // 3. Montar Prompt do Sistema
    const customInstructions = customPrompt?.trim();
    const sys = customInstructions
      ? `${customInstructions}\n\nDADOS DO LEAD:\n- Empresa: ${nomeEmpresa || "(não informada)"}\n- Ramo: ${ramo || "(não informado)"}\n\nMENSAGEM-BASE (template do operador):\n"""\n${baseMessage}\n"""\n\n${useWebSearch ? "Ferramenta web_search disponível: use no máximo 1x pra pegar UM detalhe relevante da empresa." : ""}\n\nDevolva APENAS a mensagem final, em PT-BR, sem aspas, sem explicação.`
      : `Você é um SDR experiente fazendo uma primeira abordagem PROFISSIONAL via WhatsApp.\n\nDADOS DO LEAD:\n- Empresa: ${nomeEmpresa || "(não informada)"}\n- Ramo: ${ramo || "(não informado)"}\n\nMENSAGEM-BASE (template do operador):\n"""\n${baseMessage}\n"""\n\nINSTRUÇÕES:\n- Reescreva a MENSAGEM-BASE de forma natural, curta (até 3 frases), em PT-BR.\n- Mantenha o sentido original do template.\n- Personalize SUTILMENTE pra empresa/ramo (sem inventar nada).\n${useWebSearch ? "- Se útil, use a tool web_search pra confirmar UM detalhe da empresa (1 chamada no máximo). NÃO repita pesquisas." : ""}\n- Não use emojis exagerados.\n- NÃO invente dados que não tem certeza.\n- Devolva APENAS a mensagem final, sem aspas e sem explicação.`;

    const chat = generativeModel.startChat({ history: [{ role: "user", parts: [{ text: sys }] }] });
    let res = await chat.sendMessage([{ text: "Gere a mensagem final agora." }]);

    // Acumula tokens
    let tp = 0, tc = 0, tt = 0;
    const u = extractGeminiUsage(res);
    tp += u.promptTokens; tc += u.completionTokens; tt += u.totalTokens;

    let finalText = res.response.text().trim().replace(/^["']|["']$/g, "");

    // 4. Lidar com Web Search Tool Call
    const calls = res.response.functionCalls();
    if (calls && calls.length > 0 && useWebSearch) {
      const call = calls[0];
      if (call.name === "web_search") {
        const q = String((call.args as any)?.query || "");
        try {
          const results = await webSearch(q, 3);
          const summary = results.length > 0
            ? results.map(r => `${r.title}: ${r.snippet}`).join("\n")
            : "Nenhum resultado.";
          const r2 = await chat.sendMessage([{
            functionResponse: { name: "web_search", response: { results: summary } }
          }]);
          
          const u2 = extractGeminiUsage(r2);
          tp += u2.promptTokens; tc += u2.completionTokens; tt += u2.totalTokens;
          
          finalText = r2.response.text().trim().replace(/^["']|["']$/g, "");
        } catch {
          // Mantém finalText anterior
        }
      }
    }

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
