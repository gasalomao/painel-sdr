import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { DEFAULT_KANBAN_COLUMNS } from "@/app/api/kanban-columns/route";
import { canonicalCrmIdentity, contactCrmTransportJid, CONTACT_CRM_LEAD_FIELDS, resolveContactLead, type ContactCrmColumn, type CrmIdentity } from "@/lib/inbox/contact-crm";

export const dynamic = "force-dynamic";

type Input = Record<string, unknown>;
type StoredContact = CrmIdentity & { id?: string; nome_negocio?: string | null; push_name?: string | null };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class CrmRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function errorResponse(error: unknown): NextResponse {
  return NextResponse.json({ error: error instanceof CrmRequestError ? error.message : "Não foi possível consultar ou atualizar o CRM." },
    { status: error instanceof CrmRequestError ? error.status : 500 });
}

async function authorize(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth;
  if (!supabaseAdmin) throw new Error("DB indisponível");
  return auth;
}

async function readInput(req: NextRequest): Promise<Input> {
  const input: unknown = await req.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new CrmRequestError("Corpo JSON inválido", 400);
  return input as Input;
}

async function readContact(input: Input, clientId: string): Promise<StoredContact> {
  if (input.contactId) {
    if (typeof input.contactId !== "string" || !uuid.test(input.contactId)) throw new CrmRequestError("Contato inválido", 400);
    const { data, error } = await supabaseAdmin.from("contacts")
      .select("id, lead_id, remote_jid, phone_number, nome_negocio, push_name")
      .eq("client_id", clientId).eq("id", input.contactId).maybeSingle();
    if (error) throw error;
    if (!data) throw new CrmRequestError("Contato não encontrado", 404);
    return data as StoredContact;
  }
  const contact: StoredContact = {};
  for (const key of ["phone", "remote_jid", "remoteJid", "name"] as const) {
    const value = input[key];
    if (value !== undefined && value !== null && (typeof value !== "string" || value.length > (key === "name" ? 200 : 100))) {
      throw new CrmRequestError("Identidade de contato inválida", 400);
    }
    if (typeof value === "string") contact[key] = value.trim();
  }
  if (![contact.phone, contact.remote_jid, contact.remoteJid].some(canonicalCrmIdentity)) throw new CrmRequestError("Informe telefone com DDD ou JID válido", 400);
  return contact;
}

async function readColumns(clientId: string): Promise<ContactCrmColumn[]> {
  const { data, error } = await supabaseAdmin.from("kanban_columns").select("*")
    .eq("client_id", clientId).order("order_index", { ascending: true });
  if (error) throw error;
  if (!data) throw new Error("Consulta de colunas indisponível");
  return data.length ? data.map((column) => ({
    status_key: column.status_key, label: column.label, is_terminal: column.is_terminal === true,
  })) : DEFAULT_KANBAN_COLUMNS;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authorize(req);
    if (!auth.ok) return auth.response;
    const contact = await readContact(Object.fromEntries(req.nextUrl.searchParams), auth.clientId);
    const [resolution, columns] = await Promise.all([
      resolveContactLead(supabaseAdmin, auth.clientId, contact), readColumns(auth.clientId),
    ]);
    return NextResponse.json({ ...resolution, columns }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}

/** Criação explícita: resolve novamente antes de inserir; GET nunca repara vínculos. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authorize(req);
    if (!auth.ok) return auth.response;
    const contact = await readContact(await readInput(req), auth.clientId);
    const columns = await readColumns(auth.clientId);
    let resolution = await resolveContactLead(supabaseAdmin, auth.clientId, contact);
    if (resolution.state === "ambiguous" || resolution.state === "unresolved") {
      return NextResponse.json({ ...resolution, columns }, { status: 409 });
    }
    let created = false;
    if (!resolution.lead) {
      const jid = contactCrmTransportJid(contact);
      if (!jid) throw new CrmRequestError("Identidade de contato insuficiente", 400);
      const { data, error } = await supabaseAdmin.from("leads_extraidos").insert({
        client_id: auth.clientId,
        nome_negocio: contact.nome_negocio || contact.push_name || contact.name || "Lead WhatsApp",
        telefone: jid.split("@")[0], remoteJid: jid, status: columns[0].status_key,
        primeiro_contato_at: new Date().toISOString(), primeiro_contato_source: "whatsapp_chat",
      }).select(CONTACT_CRM_LEAD_FIELDS).single();
      if (error) {
        if (error.code !== "23505") throw error;
        resolution = await resolveContactLead(supabaseAdmin, auth.clientId, contact);
        if (!resolution.lead) return NextResponse.json({ ...resolution, columns }, { status: 409 });
      } else {
        if (!data) throw new Error("Lead não retornado");
        resolution = { state: "found", lead: data };
        created = true;
      }
    }
    if (contact.id && resolution.lead) {
      const { data, error } = await supabaseAdmin.from("contacts").update({ lead_id: resolution.lead.id })
        .eq("client_id", auth.clientId).eq("id", contact.id).select("id").maybeSingle();
      if (error) throw error;
      if (!data) throw new CrmRequestError("Contato não encontrado", 404);
    }
    return NextResponse.json({ ...resolution, columns, created });
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = await authorize(req);
    if (!auth.ok) return auth.response;
    const input = await readInput(req);
    if (typeof input.leadId !== "number" || !Number.isSafeInteger(input.leadId) || input.leadId <= 0
      || typeof input.status !== "string" || !input.status || input.status.length > 100) throw new CrmRequestError("Lead ou etapa inválida", 400);
    const columns = await readColumns(auth.clientId);
    if (!columns.some((column) => column.status_key === input.status)) throw new CrmRequestError("Etapa não encontrada no funil", 400);
    const { data, error } = await supabaseAdmin.from("leads_extraidos").update({ status: input.status })
      .eq("client_id", auth.clientId).eq("id", input.leadId).select(CONTACT_CRM_LEAD_FIELDS).maybeSingle();
    if (error) throw error;
    if (!data) throw new CrmRequestError("Lead não encontrado", 404);
    return NextResponse.json({ lead: data });
  } catch (error) { return errorResponse(error); }
}
