import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeJid } from "@/lib/jid-utils";

export interface CrmIdentity {
  lead_id?: number | string | null;
  remoteJid?: string | null;
  remote_jid?: string | null;
  phone?: string | null;
  phone_number?: string | null;
  phone_normalized?: string | null;
  name?: string | null;
}

export interface ContactCrmLead {
  id: number;
  client_id: string;
  remoteJid: string | null;
  telefone: string | null;
  nome_negocio: string | null;
  status: string | null;
  created_at: string | null;
}

export interface ContactCrmColumn {
  status_key: string;
  label: string;
  is_terminal?: boolean;
}

export type ContactCrmResolution = { state: "found" | "missing" | "ambiguous" | "unresolved"; lead: ContactCrmLead | null };
export type ContactCrmData = ContactCrmResolution & { columns: ContactCrmColumn[]; created?: boolean };
export const CONTACT_CRM_LEAD_FIELDS = "id, client_id, remoteJid, telefone, nome_negocio, status, created_at";

function normalizeCrmPhoneJid(value?: string | null): string | null {
  if (!value) return null;
  let input = value.trim().replace(/^phone:/i, "");
  if (!input.includes("@") && /^[+\d\s().-]+$/.test(input)) {
    const digits = input.replace(/\D/g, "");
    if (digits.startsWith("00")) input = `+${digits.slice(2)}`;
    else if (!input.startsWith("+") && /^0[1-9]\d{9,10}$/.test(digits)) input = digits.slice(1);
  }
  const jid = normalizeJid(input);
  return jid?.endsWith("@s.whatsapp.net") && jid.split("@")[0].length >= 10 ? jid : null;
}

/** Chave SOMENTE de comparação; nunca persistir como endereço de transporte. */
export function canonicalCrmIdentity(value?: string | null): string | null {
  const input = value?.trim().replace(/^phone:/i, "");
  if (input && (/^\d+(?:-\d+)?@g\.us$/.test(input) || /^\d+@lid$/.test(input))) return input;
  const jid = normalizeCrmPhoneJid(value);
  if (!jid) return null;
  let digits = jid.split("@")[0];
  // Somente celulares BR: 9 seguido de 6–9. Não confundir fixo 3456 com 93456.
  if (/^55[1-9]\d9[6-9]\d{7}$/.test(digits)) digits = digits.slice(0, 4) + digits.slice(5);
  return `${digits}@s.whatsapp.net`;
}

function identityValues(identity: CrmIdentity): (string | null | undefined)[] {
  const jids = [identity.remote_jid, identity.remoteJid].filter((value): value is string => !!value);
  // phone_number costuma ser cópia do usuário do JID: preservar país/tipo desse JID.
  const jidDigits = new Set(jids.filter((jid) => jid.includes("@")).map((jid) => jid.split("@")[0].split(":")[0].replace(/\D/g, "")));
  const phones = [identity.phone_number, identity.phone, identity.phone_normalized]
    .filter((phone) => phone && !jidDigits.has(phone.replace(/\D/g, "")));
  return [...jids, ...phones];
}

/** Prioriza JID real; preserva o nono dígito e nunca converte LID copiado em telefone. */
export function contactCrmTransportJid(identity: CrmIdentity): string | null {
  return identityValues(identity).map(normalizeCrmPhoneJid).find((jid) => jid !== null) ?? null;
}

function identities(identity: CrmIdentity): Set<string> {
  return new Set(identityValues(identity).map(canonicalCrmIdentity).filter((value): value is string => !!value));
}

export async function resolveContactLead(db: SupabaseClient, clientId: string, contact: CrmIdentity): Promise<ContactCrmResolution> {
  const leadId = Number(contact.lead_id);
  if (Number.isSafeInteger(leadId) && leadId > 0) {
    const { data, error } = await db.from("leads_extraidos").select(CONTACT_CRM_LEAD_FIELDS)
      .eq("client_id", clientId).eq("id", leadId).maybeSingle();
    if (error) throw error;
    if (data) return { state: "found", lead: data as ContactCrmLead };
  }

  const targets = identities(contact);
  if (!targets.size) return { state: "unresolved", lead: null };
  let match: ContactCrmLead | null = null;
  // ponytail: sem coluna canônica/indexada, pagina identidades do tenant; migrar para índice quando necessário.
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await db.from("leads_extraidos").select(CONTACT_CRM_LEAD_FIELDS)
      .eq("client_id", clientId).order("id", { ascending: true }).range(offset, offset + pageSize - 1);
    if (error) throw error;
    if (!data) throw new Error("Consulta de leads indisponível");
    for (const lead of data as ContactCrmLead[]) {
      const candidates = identities({ remoteJid: lead.remoteJid, phone: lead.telefone });
      if (![...candidates].some((identity) => targets.has(identity))) continue;
      if (match && match.id !== lead.id) return { state: "ambiguous", lead: null };
      match = lead;
    }
    if (data.length < pageSize) break;
  }
  return { state: match ? "found" : "missing", lead: match };
}
