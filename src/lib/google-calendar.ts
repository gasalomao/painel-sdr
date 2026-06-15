/**
 * Cliente Google Calendar pra agentes IA com OAuth conectado.
 *
 * Fluxo:
 *   - Cada agent_settings tem `options.google_credentials` (JSON do OAuth Client
 *     do Google Cloud Console) e `options.google_tokens` (refresh + access).
 *   - O usuário conectou via /api/auth/google/url → callback (já existe).
 *   - Aqui criamos um oauth2Client autenticado por agentId. Quando o access_token
 *     expira (Google retorna invalid_grant ou exp passou), refreshamos com o
 *     refresh_token e persistimos os tokens novos em agent_settings.options.
 *
 * Toda função recebe `agentId` e busca os tokens do banco. Idempotente — pode
 * chamar várias vezes na mesma request sem custo de re-autenticação porque o
 * oauth2Client do Google guarda o access_token em memória.
 */

import { google } from "googleapis";
import type { calendar_v3 } from "googleapis";
import { supabaseAdmin } from "@/lib/supabase_admin";

export type GoogleCalendarEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  colorId?: string;
  visibility?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: { email: string; displayName?: string; responseStatus?: string }[];
  htmlLink?: string;
  recurrence?: string[];
  conferenceData?: any;
  organizer?: { email?: string; displayName?: string };
};

/** Falha esperada — caller decide se cai pra fallback ou propaga. */
export class GoogleCalendarError extends Error {
  constructor(message: string, public readonly code: "no_credentials" | "no_tokens" | "refresh_failed" | "api_error", public readonly detail?: unknown) {
    super(message);
    this.name = "GoogleCalendarError";
  }
}

type AgentOptions = {
  google_credentials?: string; // JSON string
  google_tokens?: {
    access_token?: string;
    refresh_token?: string;
    scope?: string;
    token_type?: string;
    expiry_date?: number;
  };
  calendar_connected_email?: string;
  app_url?: string;
};

/**
 * Cria um OAuth2 client autenticado pra esse agente. Persiste tokens novos
 * automaticamente quando o Google emitir refresh.
 */
async function getOAuthClient(agentId: number) {
  if (!supabaseAdmin) throw new GoogleCalendarError("Supabase admin indisponível", "no_credentials");

  const { data: agent } = await supabaseAdmin
    .from("agent_settings")
    .select("id, options")
    .eq("id", agentId)
    .maybeSingle();

  if (!agent) throw new GoogleCalendarError(`Agente ${agentId} não encontrado`, "no_credentials");

  const opts = (agent.options || {}) as AgentOptions;
  if (!opts.google_credentials) {
    throw new GoogleCalendarError("Google credentials não configuradas pro agente", "no_credentials");
  }
  if (!opts.google_tokens?.refresh_token) {
    throw new GoogleCalendarError("Agente ainda não autenticou no Google (sem refresh_token)", "no_tokens");
  }

  let creds: any;
  try {
    creds = JSON.parse(opts.google_credentials);
  } catch {
    throw new GoogleCalendarError("Google credentials JSON inválido", "no_credentials");
  }
  const { client_id, client_secret, redirect_uris } = creds.web || creds.installed || {};
  if (!client_id || !client_secret) {
    throw new GoogleCalendarError("Google credentials sem client_id/client_secret", "no_credentials");
  }

  // O redirect_uri não é usado em chamadas de API com refresh — só importa pro
  // flow inicial de OAuth. Mas a lib exige um valor.
  const redirectUri = (redirect_uris && redirect_uris[0]) || "http://localhost:3000";
  const oauth2 = new google.auth.OAuth2(client_id, client_secret, redirectUri);
  oauth2.setCredentials(opts.google_tokens);

  // Quando a lib refreshar o access_token sozinha (porque expirou), persiste
  // os novos tokens no banco pra próxima request reaproveitar.
  oauth2.on("tokens", async (tokens) => {
    try {
      const merged = { ...opts.google_tokens, ...tokens };
      const newOptions = { ...opts, google_tokens: merged };
      await supabaseAdmin!
        .from("agent_settings")
        .update({ options: newOptions })
        .eq("id", agentId);
    } catch (e) {
      console.warn(`[google-calendar] falha persistindo tokens refresh do agente ${agentId}:`, (e as Error).message);
    }
  });

  return oauth2;
}

function calendarClient(oauth2: any): calendar_v3.Calendar {
  return google.calendar({ version: "v3", auth: oauth2 });
}

// ============================================================================
// CRUD
// ============================================================================

export type CreateEventInput = {
  agentId: number;
  calendarId?: string;
  title: string;
  description?: string;
  startAt: Date | string;
  endAt: Date | string;
  timeZone?: string;
  /** Lista de emails (string[]) OU objetos { email, displayName? } */
  attendees?: Array<string | { email: string; displayName?: string }>;
  location?: string;
  allDay?: boolean;
  visibility?: "default" | "public" | "private" | "confidential";
  colorId?: string;
  /** Cria evento recorrente — array de RRULE Google ("RRULE:FREQ=WEEKLY;COUNT=10") */
  recurrence?: string[];
  /** Cria Google Meet automaticamente quando true */
  createMeet?: boolean;
};

export async function createCalendarEvent(input: CreateEventInput): Promise<GoogleCalendarEvent> {
  const oauth2 = await getOAuthClient(input.agentId);
  const cal = calendarClient(oauth2);
  const calendarId = input.calendarId || "primary";
  const tz = input.timeZone || "America/Sao_Paulo";

  // Normaliza attendees: aceita string[] OU {email,displayName}[]
  const attendees = input.attendees?.map(a =>
    typeof a === "string" ? { email: a } : { email: a.email, displayName: a.displayName }
  );

  // Datas dia-inteiro usam `date` (sem dateTime). Eventos com hora usam dateTime.
  const start = input.allDay
    ? { date: new Date(input.startAt).toISOString().slice(0, 10) }
    : { dateTime: new Date(input.startAt).toISOString(), timeZone: tz };
  const end = input.allDay
    ? { date: new Date(input.endAt).toISOString().slice(0, 10) }
    : { dateTime: new Date(input.endAt).toISOString(), timeZone: tz };

  try {
    const res = await cal.events.insert({
      calendarId,
      sendUpdates: attendees && attendees.length > 0 ? "all" : "none",
      conferenceDataVersion: input.createMeet ? 1 : 0,
      requestBody: {
        summary: input.title,
        description: input.description,
        location: input.location,
        visibility: input.visibility,
        colorId: input.colorId,
        recurrence: input.recurrence,
        start,
        end,
        attendees,
        conferenceData: input.createMeet
          ? {
              createRequest: {
                requestId: `meet-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                conferenceSolutionKey: { type: "hangoutsMeet" },
              },
            }
          : undefined,
      },
    });
    return res.data as GoogleCalendarEvent;
  } catch (e: any) {
    throw new GoogleCalendarError(
      `Falha ao criar evento no Google: ${e?.message || e}`,
      e?.code === 401 ? "refresh_failed" : "api_error",
      e?.errors
    );
  }
}

export type ListEventsInput = {
  agentId: number;
  calendarId?: string;
  timeMin?: Date | string;
  timeMax?: Date | string;
  maxResults?: number;
};

export async function listCalendarEvents(input: ListEventsInput): Promise<GoogleCalendarEvent[]> {
  const oauth2 = await getOAuthClient(input.agentId);
  const cal = calendarClient(oauth2);
  const calendarId = input.calendarId || "primary";
  try {
    const res = await cal.events.list({
      calendarId,
      timeMin: input.timeMin ? new Date(input.timeMin).toISOString() : undefined,
      timeMax: input.timeMax ? new Date(input.timeMax).toISOString() : undefined,
      maxResults: input.maxResults || 50,
      singleEvents: true,
      orderBy: "startTime",
    });
    return (res.data.items || []) as GoogleCalendarEvent[];
  } catch (e: any) {
    throw new GoogleCalendarError(`Falha ao listar eventos: ${e?.message || e}`, "api_error", e?.errors);
  }
}

export type UpdateEventInput = {
  agentId: number;
  calendarId?: string;
  eventId: string;
  title?: string;
  description?: string;
  startAt?: Date | string;
  endAt?: Date | string;
  timeZone?: string;
  location?: string;
  allDay?: boolean;
  visibility?: "default" | "public" | "private" | "confidential";
  colorId?: string;
  attendees?: Array<string | { email: string; displayName?: string }>;
  recurrence?: string[];
};

export async function updateCalendarEvent(input: UpdateEventInput): Promise<GoogleCalendarEvent> {
  const oauth2 = await getOAuthClient(input.agentId);
  const cal = calendarClient(oauth2);
  const calendarId = input.calendarId || "primary";
  const tz = input.timeZone || "America/Sao_Paulo";

  const patch: any = {};
  if (input.title !== undefined) patch.summary = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.location !== undefined) patch.location = input.location;
  if (input.visibility !== undefined) patch.visibility = input.visibility;
  if (input.colorId !== undefined) patch.colorId = input.colorId;
  if (input.recurrence !== undefined) patch.recurrence = input.recurrence;
  if (input.startAt) {
    patch.start = input.allDay
      ? { date: new Date(input.startAt).toISOString().slice(0, 10) }
      : { dateTime: new Date(input.startAt).toISOString(), timeZone: tz };
  }
  if (input.endAt) {
    patch.end = input.allDay
      ? { date: new Date(input.endAt).toISOString().slice(0, 10) }
      : { dateTime: new Date(input.endAt).toISOString(), timeZone: tz };
  }
  if (input.attendees !== undefined) {
    patch.attendees = input.attendees.map(a =>
      typeof a === "string" ? { email: a } : { email: a.email, displayName: a.displayName }
    );
  }

  try {
    const res = await cal.events.patch({
      calendarId,
      eventId: input.eventId,
      sendUpdates: patch.attendees ? "all" : "none",
      requestBody: patch,
    });
    return res.data as GoogleCalendarEvent;
  } catch (e: any) {
    throw new GoogleCalendarError(`Falha ao atualizar evento: ${e?.message || e}`, "api_error", e?.errors);
  }
}

export async function cancelCalendarEvent(agentId: number, eventId: string, calendarId = "primary"): Promise<void> {
  const oauth2 = await getOAuthClient(agentId);
  const cal = calendarClient(oauth2);
  try {
    await cal.events.delete({ calendarId, eventId });
  } catch (e: any) {
    // 410 (Gone) = já deletado. Não-fatal.
    if (e?.code === 410) return;
    throw new GoogleCalendarError(`Falha ao cancelar evento: ${e?.message || e}`, "api_error", e?.errors);
  }
}

/**
 * Verifica disponibilidade num intervalo. Retorna true se NÃO há conflitos
 * no Google Calendar do agente.
 *
 * Importante: NÃO consulta o banco local. O caller deve fazer 2 checks:
 *   1. anti-double-booking local (constraint do banco em appointments)
 *   2. essa função (eventos manuais que o dono criou direto no Google)
 */
export async function isAvailable(
  agentId: number,
  startAt: Date | string,
  endAt: Date | string,
  calendarId = "primary"
): Promise<boolean> {
  const oauth2 = await getOAuthClient(agentId);
  const cal = calendarClient(oauth2);
  try {
    const res = await cal.freebusy.query({
      requestBody: {
        timeMin: new Date(startAt).toISOString(),
        timeMax: new Date(endAt).toISOString(),
        items: [{ id: calendarId }],
      },
    });
    const busy = res.data.calendars?.[calendarId]?.busy || [];
    return busy.length === 0;
  } catch (e: any) {
    throw new GoogleCalendarError(`Falha ao verificar disponibilidade: ${e?.message || e}`, "api_error", e?.errors);
  }
}

/**
 * Checa se o agente tem OAuth Google configurado (sem fazer chamada de rede).
 * Útil pra UI mostrar "Conectado / Não conectado" e pro worker decidir
 * se deve tentar sincronizar.
 */
export async function hasCalendarConnected(agentId: number): Promise<{
  connected: boolean;
  email?: string;
  reason?: "no_credentials" | "no_tokens";
}> {
  if (!supabaseAdmin) return { connected: false, reason: "no_credentials" };
  const { data: agent } = await supabaseAdmin
    .from("agent_settings")
    .select("options")
    .eq("id", agentId)
    .maybeSingle();
  const opts = (agent?.options || {}) as AgentOptions;
  if (!opts.google_credentials) return { connected: false, reason: "no_credentials" };
  if (!opts.google_tokens?.refresh_token) return { connected: false, reason: "no_tokens" };
  return { connected: true, email: opts.calendar_connected_email };
}
