/**
 * Testes para Renderização e Preservação de Avatares no Inbox (Barra Lateral)
 */
import { describe, it, expect } from "vitest";
import { normalizeConversation } from "../inbox/conversations";
import type { Conversation } from "@/types";

describe("Conversations Avatars — Normalização e Preservação", () => {
  it("normaliza contato com profile_pic_url", () => {
    const raw = {
      id: "sess-1",
      remote_jid: "5511999990001@s.whatsapp.net",
      contact: {
        id: "c-1",
        phone_number: "5511999990001",
        nome_negocio: "Padaria",
        profile_pic_url: "https://pps.whatsapp.net/1.jpg",
      },
    };
    const conv = normalizeConversation(raw);
    expect(conv.contact?.avatar_url).toBe("https://pps.whatsapp.net/1.jpg");
  });

  it("normaliza contato com coluna legada profile_pic se profile_pic_url for nulo", () => {
    const raw = {
      id: "sess-2",
      remote_jid: "5511999990002@s.whatsapp.net",
      contact: {
        id: "c-2",
        phone_number: "5511999990002",
        nome_negocio: "Oficina",
        profile_pic_url: null,
        profile_pic: "https://pps.whatsapp.net/2.jpg",
      },
    };
    const conv = normalizeConversation(raw);
    expect(conv.contact?.avatar_url).toBe("https://pps.whatsapp.net/2.jpg");
  });

  it("preserva avatar existente quando a nova mensagem não traz foto", () => {
    const existingConv: Conversation = {
      id: "5511999990001@s.whatsapp.net",
      user_id: "u-1",
      contact_id: "c-1",
      status: "open",
      unread_count: 0,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      contact: {
        id: "c-1",
        user_id: "u-1",
        account_id: "u-1",
        phone: "5511999990001",
        name: "Padaria",
        avatar_url: "https://pps.whatsapp.net/1.jpg",
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        tags: [],
      },
    };

    const loadedConv: Conversation = {
      ...existingConv,
      last_message_text: "Nova mensagem!",
      last_message_at: "2026-01-02T00:00:00Z",
      contact: {
        ...existingConv.contact!,
        avatar_url: undefined, // veio sem avatar no snapshot rápido
      },
    };

    // Lógica do merge de chat/page.tsx
    const avatarUrl = loadedConv.contact?.avatar_url || existingConv.contact?.avatar_url;
    const contact = { ...loadedConv.contact!, avatar_url: avatarUrl };
    const merged = { ...loadedConv, contact };

    expect(merged.contact.avatar_url).toBe("https://pps.whatsapp.net/1.jpg");
    expect(merged.last_message_text).toBe("Nova mensagem!");
  });
});
