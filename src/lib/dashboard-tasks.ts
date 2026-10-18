import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import type { DashboardTask } from "@/types/dashboard-tasks";

export type TaskRow = Omit<DashboardTask, "lead_name">;
export type TaskInput = { text?: string; due_at?: string; lead_id?: number | null; completed?: boolean };
export const TASK_COLUMNS = "id,text,due_at,completed_at,lead_id,created_at,updated_at";

export class TaskInputError extends Error {}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return y > 0 && m >= 1 && m <= 12 && d >= 1 && d <= days[m - 1]
    && Number(hour) < 24 && Number(minute) < 60 && Number(second ?? 0) < 60
    && (zone === "Z" || (Number(zone.slice(1, 3)) < 24 && Number(zone.slice(4)) < 60))
    && Number.isFinite(Date.parse(value));
}

export function parseTaskInput(body: unknown, patch = false): TaskInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new TaskInputError("Corpo JSON inválido");
  const input = body as Record<string, unknown>;
  const allowed = patch ? ["text", "due_at", "lead_id", "completed"] : ["text", "due_at", "lead_id"];
  if (!Object.keys(input).length || Object.keys(input).some((key) => !allowed.includes(key))) {
    throw new TaskInputError("Campos inválidos para tarefa");
  }
  const result: TaskInput = {};
  if (!patch || "text" in input) {
    if (typeof input.text !== "string" || !input.text.trim() || input.text.trim().length > 1000) {
      throw new TaskInputError("Texto obrigatório (máximo 1.000 caracteres)");
    }
    result.text = input.text.trim();
  }
  if (!patch || "due_at" in input) {
    if (!validTimestamp(input.due_at)) throw new TaskInputError("Data e hora inválidas; informe o fuso horário");
    result.due_at = new Date(input.due_at).toISOString();
  }
  if ("lead_id" in input) {
    if (input.lead_id !== null && (typeof input.lead_id !== "number" || !Number.isInteger(input.lead_id) || input.lead_id < 1 || input.lead_id > 2147483647)) {
      throw new TaskInputError("ID do lead inválido");
    }
    result.lead_id = input.lead_id as number | null;
  }
  if ("completed" in input) {
    if (typeof input.completed !== "boolean") throw new TaskInputError("Conclusão inválida");
    result.completed = input.completed;
  }
  return result;
}

export function parseTaskQuery(params: URLSearchParams): { status: "pending" | "completed"; page: number; limit: number } {
  const status = params.get("status") ?? "pending";
  const page = params.get("page") ?? "0", limit = params.get("limit") ?? "10";
  if ((status !== "pending" && status !== "completed") || !/^\d+$/.test(page) || !/^\d+$/.test(limit)
    || !Number.isSafeInteger(Number(page)) || Number(limit) < 1 || Number(limit) > 100
    || !Number.isSafeInteger((Number(page) + 1) * Number(limit))) {
    throw new TaskInputError("Paginação ou status inválido");
  }
  return { status, page: Number(page), limit: Number(limit) };
}

export function assertTaskId(id: string): void {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(id)) throw new TaskInputError("ID da tarefa inválido");
}

export function taskErrorResponse(error: unknown): NextResponse {
  const dbError = error && typeof error === "object" ? error as { code?: string; message?: string } : {};
  const message = dbError.message || "Erro interno";
  if (["42P01", "PGRST205"].includes(dbError.code ?? "") && /(?:relation|table)\s+["'](?:public\.)?dashboard_tasks["']/i.test(message)) {
    return NextResponse.json({ code: "TASKS_SETUP_REQUIRED", error: "Execute migrations/017_dashboard_tasks.sql no SQL Editor para habilitar as tarefas." }, { status: 503 });
  }
  return NextResponse.json({ error: message }, { status: error instanceof TaskInputError ? 400 : 500 });
}

export async function findTaskLead(leadId: number, clientId: string): Promise<{ id: number; nome_negocio: string | null } | null> {
  const { data, error } = await supabaseAdmin.from("leads_extraidos").select("id,nome_negocio")
    .eq("client_id", clientId).eq("id", leadId).maybeSingle();
  if (error) throw error;
  return data;
}

export async function tasksWithLeadNames(tasks: TaskRow[], clientId: string): Promise<DashboardTask[]> {
  const ids = [...new Set(tasks.flatMap((task) => task.lead_id === null ? [] : [task.lead_id]))];
  const names = new Map<number, string | null>();
  if (ids.length) {
    const { data, error } = await supabaseAdmin.from("leads_extraidos").select("id,nome_negocio")
      .eq("client_id", clientId).in("id", ids);
    if (error) throw error;
    for (const lead of data ?? []) names.set(lead.id, lead.nome_negocio);
  }
  return tasks.map((task) => ({
    id: task.id, text: task.text, due_at: task.due_at, completed_at: task.completed_at,
    lead_id: task.lead_id, lead_name: task.lead_id === null ? null : names.get(task.lead_id) ?? null,
    created_at: task.created_at, updated_at: task.updated_at,
  }));
}
