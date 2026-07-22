import type { Conversation, Contact, Tag } from "@/types";

/**
 * Mapeia a tabela sessions (conversations) com RLS e join com contacts
 */
export const CONVERSATION_SELECT =
  "*, contact:contacts(*)";

/**
 * Normaliza os dados brutos da tabela sessions + contacts do painel-sdr
 * para o formato esperado pelos componentes do inbox.
 */
export function normalizeConversation(raw: any): Conversation {
  if (!raw) return raw;

  const rawContact = raw.contact;
  const remoteJid = rawContact?.remote_jid || raw.remote_jid || raw.id;
  
  // Resolve o contato mapeando os campos do painel-sdr para o wacrm
  const contact: Contact | undefined = rawContact
    ? {
        id: rawContact.id,
        user_id: rawContact.client_id || "",
        account_id: rawContact.client_id || "",
        phone: rawContact.phone_number || "",
        name: rawContact.nome_negocio || rawContact.push_name || rawContact.phone_number || "Sem Nome",
        company: rawContact.nome_negocio || "",
        avatar_url: rawContact.profile_pic_url || undefined,
        created_at: rawContact.created_at,
        updated_at: rawContact.updated_at || rawContact.created_at,
        remote_jid: remoteJid,
        // No painel-sdr, tags é array de strings (text[]) em contacts. Mapeamos para objetos Tag do wacrm
        tags: (rawContact.tags || []).map((tName: string) => ({
          id: `tag-${tName}`,
          name: tName,
          color: "#3b82f6", // cor padrão
          user_id: rawContact.client_id || "",
          created_at: new Date().toISOString()
        }))
      }
    : undefined;

  // Resolve o status mapeando bot_status do painel-sdr para status do wacrm:
  // bot_paused (humano atende) -> open
  // bot_active (ia atende)     -> pending
  // closed (se houver)         -> closed
  let status: "open" | "pending" | "closed" = "open";
  if (raw.bot_status === "bot_active") {
    status = "pending";
  } else if (raw.bot_status === "closed") {
    status = "closed";
  }

  return {
    id: remoteJid, // Chave primária de busca de mensagens no chats_dashboard
    session_id: raw.id, // ID único da tabela sessions
    user_id: raw.client_id || "",
    contact_id: raw.contact_id || "",
    status,
    assigned_agent_id: raw.agent_id ? String(raw.agent_id) : undefined,
    last_message_text: raw.last_message || "",
    last_message_at: raw.last_message_at || raw.updated_at || raw.created_at,
    unread_count: raw.unread_count || 0,
    created_at: raw.created_at,
    updated_at: raw.updated_at || raw.created_at,
    contact,
    bot_status: raw.bot_status || "bot_active",
    resume_at: raw.resume_at || null,
    last_instance: raw.instance_name || null,
    instance_name: raw.instance_name || null,
    // Estado extra do bot do painel-sdr (conector de IA)
    ai_autoreply_disabled: raw.bot_status === "bot_paused",
    ai_reply_count: 0,
    ai_handoff_summary: raw.variables?.handoff_summary || null
  };
}

/**
 * Normaliza e DEDUPLICA as sessões por remoteJid (id do contato).
 * Se o mesmo contato possuir múltiplas sessões (ex: de instâncias antigas),
 * combina-as em uma única conversa no Inbox, mantendo o histórico mais recente
 * e somando a contagem de não lidos para garantir chaves únicas no React.
 */
export function normalizeConversations(rows: any[]): Conversation[] {
  const map = new Map<string, Conversation>();

  for (const row of rows || []) {
    const norm = normalizeConversation(row);
    if (!norm || !norm.id) continue;

    const existing = map.get(norm.id);
    if (!existing) {
      map.set(norm.id, norm);
    } else {
      const existingTime = new Date(existing.last_message_at || existing.updated_at || 0).getTime();
      const newTime = new Date(norm.last_message_at || norm.updated_at || 0).getTime();

      const newer = newTime >= existingTime ? norm : existing;
      const older = newTime >= existingTime ? existing : norm;

      map.set(norm.id, {
        ...newer,
        unread_count: (existing.unread_count || 0) + (norm.unread_count || 0),
        contact: newer.contact || older.contact,
        last_instance: newer.last_instance || older.last_instance,
        instance_name: newer.instance_name || older.instance_name,
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    const timeA = new Date(a.last_message_at || a.updated_at || a.created_at || 0).getTime();
    const timeB = new Date(b.last_message_at || b.updated_at || b.created_at || 0).getTime();
    return timeB - timeA;
  });
}

export interface ContactFilters {
  tagIds: string[];
  company: string | null;
}

export function matchesContactFilters(
  conversation: Conversation,
  { tagIds, company }: ContactFilters,
): boolean {
  if (tagIds.length > 0) {
    const contactTags = conversation.contact?.tags ?? [];
    if (!contactTags.some((t) => tagIds.includes(t.id) || tagIds.includes(t.name))) return false;
  }

  if (company !== null && conversation.contact?.company?.trim() !== company) {
    return false;
  }

  return true;
}
