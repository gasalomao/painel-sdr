import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { buildOrganizerSystemPrompt } from "@/lib/organizer-prompt";

export const dynamic = "force-dynamic";

/**
 * GET /api/organizer/effective-prompt
 *
 * Devolve o PROMPT FINAL EXATO que vai ser enviado pra IA quando o
 * Organizador rodar pra este cliente — concatenando:
 *   1) Prompt base (custom do cliente OU universal auto-adaptativo)
 *   2) Contexto automático do Agente IA ativo desta conta
 *   3) Apêndice semântico do kanban com as colunas reais do cliente
 *   4) Data corrente
 */
export async function GET(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const [{ data: client }, { data: cols }, { data: activeAgent }] = await Promise.all([
    supabaseAdmin
      .from("clients")
      .select("organizer_prompt")
      .eq("id", ctx.clientId)
      .maybeSingle(),
    supabaseAdmin
      .from("kanban_columns")
      .select("*")
      .eq("client_id", ctx.clientId)
      .order("order_index", { ascending: true }),
    supabaseAdmin
      .from("agent_settings")
      .select("name, main_prompt, role")
      .eq("client_id", ctx.clientId)
      .eq("is_active", true)
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const customPrompt = (client?.organizer_prompt || "").trim() || null;
  const { systemPrompt, defaultBasePrompt, kanbanAppendix, dateContext, agentAppendix } =
    buildOrganizerSystemPrompt(customPrompt, cols || [], new Date(), [], activeAgent);

  return NextResponse.json({
    ok: true,
    fullPrompt: systemPrompt,
    customPrompt,
    defaultBasePrompt,
    kanbanAppendix,
    agentAppendix,
    dateContext,
    columns: cols || [],
  });
}
