import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { assertTaskId, findTaskLead, parseTaskInput, TASK_COLUMNS, taskErrorResponse, tasksWithLeadNames } from "@/lib/dashboard-tasks";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;
    const { id } = await context.params;
    assertTaskId(id);
    const { completed, ...input } = parseTaskInput(await req.json().catch(() => null), true);
    if (input.lead_id !== undefined && input.lead_id !== null && !await findTaskLead(input.lead_id, auth.clientId)) {
      return NextResponse.json({ error: "Lead não encontrado" }, { status: 404 });
    }
    const patch: Record<string, unknown> = { ...input };
    if (completed === true) {
      // O trigger SQL preserva atomicamente a primeira conclusão, sem leitura obsoleta.
      patch.completed_at = new Date().toISOString();
    } else if (completed === false) {
      patch.completed_at = null;
    }
    const { data, error } = await supabaseAdmin.from("dashboard_tasks").update(patch)
      .eq("client_id", auth.clientId).eq("id", id).select(TASK_COLUMNS).maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: "Tarefa não encontrada" }, { status: 404 });
    const [task] = await tasksWithLeadNames([data], auth.clientId).catch(() => [{ ...data, lead_name: null }]);
    return NextResponse.json({ task });
  } catch (error: unknown) {
    return taskErrorResponse(error);
  }
}
