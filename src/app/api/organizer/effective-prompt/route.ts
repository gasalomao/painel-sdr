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
 *   1) Prompt base (custom do cliente OU SDR B2B default com R1-R17)
 *   2) Apêndice do kanban com as colunas reais do cliente
 *   3) Data corrente (pra IA raciocinar sobre "data passada")
 *
 * Usado pelo /organizador pra o usuário ver/entender o que está rodando.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const [{ data: client }, { data: cols }] = await Promise.all([
    supabaseAdmin
      .from("clients")
      .select("organizer_prompt")
      .eq("id", ctx.clientId)
      .maybeSingle(),
    supabaseAdmin
      .from("kanban_columns")
      .select("status_key, label, order_index")
      .eq("client_id", ctx.clientId)
      .order("order_index", { ascending: true }),
  ]);

  const customPrompt = (client?.organizer_prompt || "").trim() || null;
  const { systemPrompt, defaultBasePrompt, kanbanAppendix, dateContext } =
    buildOrganizerSystemPrompt(customPrompt, cols || []);

  return NextResponse.json({
    ok: true,
    fullPrompt: systemPrompt,           // o que de fato vai pra IA
    customPrompt,                       // o que o cliente personalizou (null se padrão)
    defaultBasePrompt,                  // o padrão SDR B2B com R1-R17
    kanbanAppendix,                     // apêndice dinâmico com colunas reais
    dateContext,                        // contexto de data injetado
    columns: cols || [],
  });
}
