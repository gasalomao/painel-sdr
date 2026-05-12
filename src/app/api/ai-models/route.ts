import { NextRequest, NextResponse } from "next/server";
import { supabase, supabaseAdmin } from "@/lib/supabase";

// Lê com service role pra contornar RLS (mesmo motivo que ai-organize).
const adminClient = supabaseAdmin || supabase;

export async function GET(req: NextRequest) {
  try {
    const { data: orgConfig, error: cfgErr } = await adminClient
      .from("ai_organizer_config")
      .select("api_key")
      .eq("id", 1)
      .maybeSingle();
    if (cfgErr) console.warn("[AI-MODELS] Falha ao ler config:", cfgErr.message);
    if (!orgConfig || !orgConfig.api_key) {
       return NextResponse.json({ success: false, error: "API Key não encontrada. Salve sua chave Gemini em Configurações." });
    }

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${orgConfig.api_key}`);
    const json = await res.json();

    if (!res.ok) {
        throw new Error(json.error?.message || "Erro ao consultar Google AI");
    }

    // Filtra apenas os generativos que suportam text (gemini, nao embed)
    const models = json.models.filter((m: any) => m.name.includes("gemini") && m.supportedGenerationMethods.includes("generateContent")).map((m: any) => ({
        id: m.name.replace("models/", ""),
        name: m.displayName,
        version: m.version,
        description: m.description
    }));

    return NextResponse.json({ success: true, models });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
