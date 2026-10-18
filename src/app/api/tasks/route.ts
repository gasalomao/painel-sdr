import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { findTaskLead, parseTaskInput, parseTaskQuery, TASK_COLUMNS, taskErrorResponse, tasksWithLeadNames } from "@/lib/dashboard-tasks";
import type { DashboardTasksResponse } from "@/types/dashboard-tasks";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;
    const { status, page, limit } = parseTaskQuery(req.nextUrl.searchParams);
    const now = new Date();
    const soon = new Date(now.getTime() + 30 * 60_000).toISOString();
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
    const instant = now.toISOString();
    const count = () => supabaseAdmin.from("dashboard_tasks").select("id", { count: "exact", head: true }).eq("client_id", auth.clientId);
    let list = supabaseAdmin.from("dashboard_tasks").select(TASK_COLUMNS).eq("client_id", auth.clientId);
    list = status === "pending"
      ? list.is("completed_at", null).order("due_at", { ascending: true })
      : list.not("completed_at", "is", null).order("completed_at", { ascending: false });
    const [tasks, pending, overdue, dueSoon, upcoming, completed] = await Promise.all([
      list.order("id", { ascending: true }).range(page * limit, (page + 1) * limit - 1),
      count().is("completed_at", null),
      count().is("completed_at", null).lt("due_at", instant),
      count().is("completed_at", null).gte("due_at", instant).lte("due_at", soon),
      count().is("completed_at", null).gt("due_at", soon).lte("due_at", tomorrow),
      count().not("completed_at", "is", null),
    ]);
    for (const result of [tasks, pending, overdue, dueSoon, upcoming, completed]) if (result.error) throw result.error;
    const counts = {
      pending: pending.count ?? 0, overdue: overdue.count ?? 0, dueSoon: dueSoon.count ?? 0,
      upcoming: upcoming.count ?? 0, completed: completed.count ?? 0,
    };
    const response: DashboardTasksResponse = {
      tasks: await tasksWithLeadNames(tasks.data ?? [], auth.clientId), total: counts[status], counts,
    };
    return NextResponse.json(response);
  } catch (error: unknown) {
    return taskErrorResponse(error);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;
    const input = parseTaskInput(await req.json().catch(() => null));
    if (input.lead_id !== undefined && input.lead_id !== null && !await findTaskLead(input.lead_id, auth.clientId)) {
      return NextResponse.json({ error: "Lead não encontrado" }, { status: 404 });
    }
    const { data, error } = await supabaseAdmin.from("dashboard_tasks").insert({
      client_id: auth.clientId, text: input.text, due_at: input.due_at, lead_id: input.lead_id ?? null,
    }).select(TASK_COLUMNS).maybeSingle();
    if (error) throw error;
    if (!data) return NextResponse.json({ error: "Tarefa não encontrada" }, { status: 404 });
    // O nome é opcional; uma falha após o INSERT não pode incentivar criação duplicada.
    const [task] = await tasksWithLeadNames([data], auth.clientId).catch(() => [{ ...data, lead_name: null }]);
    return NextResponse.json({ task }, { status: 201 });
  } catch (error: unknown) {
    return taskErrorResponse(error);
  }
}
