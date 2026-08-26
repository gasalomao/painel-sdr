/**
 * Ordem de modelos OpenRouter p/ TRANSCRIÇÃO DE ÁUDIO do agente.
 * Salvo em agent_settings.options.transcription_models (jsonb — sem migração).
 *
 * GET  ?agent_id=        → { models: string[] }   (ordem escolhida ou [])
 * POST { agent_id, models } → salva; [] volta ao padrão grátis-primeiro.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { supabase } from "@/lib/supabase";
import { requireClientId } from "@/lib/tenant";
import { getTranscriptionModels, invalidateTranscriptionModelsCache } from "@/lib/bot-status";

const adminClient = supabaseAdmin || supabase;
export const dynamic = "force-dynamic";

/** Verifica que o agente pertence ao cliente (admin pode qualquer). */
async function agentOwned(agentId: number, clientId: string, isAdmin: boolean): Promise<boolean> {
  if (!adminClient) return false;
  const { data } = await adminClient
    .from("agent_settings")
    .select("id, client_id")
    .eq("id", agentId)
    .maybeSingle();
  if (!data) return false;
  return isAdmin || data.client_id === clientId;
}

function sanitizeModels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => String(s || "").trim().slice(0, 200))
    .filter(Boolean)
    .slice(0, 10);
}

export async function GET(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  const agentId = Number(req.nextUrl.searchParams.get("agent_id"));
  if (!agentId) return NextResponse.json({ success: false, error: "agent_id obrigatório" }, { status: 400 });
  if (!(await agentOwned(agentId, auth.clientId!, auth.isAdmin))) {
    return NextResponse.json({ success: false, error: "Agente não encontrado" }, { status: 404 });
  }
  const models = await getTranscriptionModels(agentId);
  return NextResponse.json({ success: true, models });
}

export async function POST(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!adminClient) return NextResponse.json({ success: false, error: "DB indisponível" }, { status: 500 });

  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ success: false, error: "JSON inválido" }, { status: 400 });
  }
  const agentId = Number(body?.agent_id);
  const models = sanitizeModels(body?.models);
  if (!agentId) return NextResponse.json({ success: false, error: "agent_id obrigatório" }, { status: 400 });
  if (!(await agentOwned(agentId, auth.clientId!, auth.isAdmin))) {
    return NextResponse.json({ success: false, error: "Agente não encontrado" }, { status: 404 });
  }

  // Read-modify-write do jsonb options — preserva as outras chaves
  // (gemini_api_key, openrouter_api_key, etc).
  const { data: cur } = await adminClient
    .from("agent_settings")
    .select("options")
    .eq("id", agentId)
    .maybeSingle();
  const nextOptions = { ...((cur?.options as Record<string, unknown>) || {}), transcription_models: models };
  const { error } = await adminClient
    .from("agent_settings")
    .update({ options: nextOptions })
    .eq("id", agentId);
  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }

  // Cache do webhook é no mesmo processo — invalida pra valer na hora.
  try {
    invalidateTranscriptionModelsCache(agentId);
  } catch { /* TTL 30s cobre */ }

  return NextResponse.json({ success: true, models });
}
