import { describe, it, expect } from "vitest";
import { sortConversationsByLastMessage, normalizeConversations } from "../inbox/conversations";
import type { Conversation } from "@/types";

function makeConv(id: string, last_message_at?: string, updated_at?: string, created_at?: string): Conversation {
  return {
    id,
    session_id: `sess-${id}`,
    user_id: "client-1",
    contact_id: "",
    status: "open",
    last_message_text: "test",
    last_message_at: last_message_at,
    unread_count: 0,
    created_at: created_at || "2024-01-01T00:00:00.000Z",
    updated_at: updated_at || created_at || "2024-01-01T00:00:00.000Z",
    bot_status: "bot_paused",
    resume_at: undefined,
    last_instance: undefined,
    instance_name: undefined,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
    ai_handoff_summary: undefined,
  };
}

describe("sortConversationsByLastMessage", () => {
  it("ordena por last_message_at DESC (mais nova no topo)", () => {
    const convs = [
      makeConv("A", "2024-03-01T10:00:00.000Z"),
      makeConv("B", "2024-03-01T12:00:00.000Z"),
      makeConv("C", "2024-03-01T09:00:00.000Z"),
    ];
    const sorted = sortConversationsByLastMessage(convs);
    expect(sorted[0].id).toBe("B");
    expect(sorted[1].id).toBe("A");
    expect(sorted[2].id).toBe("C");
  });

  it("nao muta o array original", () => {
    const convs = [
      makeConv("A", "2024-01-01T00:00:00.000Z"),
      makeConv("B", "2024-02-01T00:00:00.000Z"),
    ];
    const sorted = sortConversationsByLastMessage(convs);
    expect(convs[0].id).toBe("A");
    expect(sorted[0].id).toBe("B");
  });

  it("fallback para updated_at quando last_message_at ausente", () => {
    const convs = [
      makeConv("A", undefined, "2024-03-01T10:00:00.000Z"),
      makeConv("B", "2024-03-01T12:00:00.000Z"),
    ];
    const sorted = sortConversationsByLastMessage(convs);
    expect(sorted[0].id).toBe("B"); // 12h > 10h
  });

  it("fallback para created_at quando last_message_at e updated_at ausentes", () => {
    const convs = [
      makeConv("A", undefined, undefined, "2024-03-01T08:00:00.000Z"),
      makeConv("B", undefined, undefined, "2024-03-01T09:00:00.000Z"),
    ];
    const sorted = sortConversationsByLastMessage(convs);
    expect(sorted[0].id).toBe("B");
  });

  it("conversa sem nenhuma data vai pro final (timestamp 0)", () => {
    const convs = [
      makeConv("A"),
      makeConv("B", "2024-03-01T12:00:00.000Z"),
    ];
    const sorted = sortConversationsByLastMessage(convs);
    expect(sorted[0].id).toBe("B");
    expect(sorted[1].id).toBe("A");
  });

  it("simula cenario WhatsApp: nova mensagem sobe conversa pro topo", () => {
    const antes = [
      makeConv("velho1", "2024-03-01T08:00:00.000Z"),
      makeConv("velho2", "2024-03-01T09:00:00.000Z"),
      makeConv("velho3", "2024-03-01T07:00:00.000Z"),
    ];
    // velho3 recebe nova mensagem - timestamp atualizado
    const atualizado = antes.map((c) =>
      c.id === "velho3"
        ? { ...c, last_message_at: "2024-03-01T10:00:00.000Z" }
        : c
    );
    const sorted = sortConversationsByLastMessage(atualizado);
    expect(sorted[0].id).toBe("velho3"); // sobe pro topo
    expect(sorted[1].id).toBe("velho2");
    expect(sorted[2].id).toBe("velho1");
  });

  it("simula bug do poll: merge preserva timestamp mais novo do realtime", () => {
    const prev = [
      makeConv("X", "2024-03-01T10:00:00.000Z"), // realtime atualizou
      makeConv("Y", "2024-03-01T08:00:00.000Z"),
    ];
    const pollLoaded = [
      makeConv("X", "2024-03-01T05:00:00.000Z"), // DB stale - webhook nao atualizou ainda
      makeConv("Y", "2024-03-01T08:00:00.000Z"),
    ];
    const prevMap = new Map<string, Conversation>();
    for (const c of prev) prevMap.set(c.id.replace(/\D/g, "") || c.id, c);
    const merged = pollLoaded.map((c) => {
      const existing = prevMap.get(c.id.replace(/\D/g, "") || c.id);
      if (!existing) return c;
      const existingTime = new Date(existing.last_message_at || 0).getTime();
      const loadedTime = new Date(c.last_message_at || 0).getTime();
      if (existingTime > loadedTime) {
        return { ...c, last_message_at: existing.last_message_at };
      }
      return c;
    });
    const sorted = sortConversationsByLastMessage(merged);
    expect(sorted[0].id).toBe("X"); // X continua no topo (10h > 8h)
  });
});

describe("normalizeConversations — dedup + sort", () => {
  it("deduplica por remoteJid mantendo o mais novo", () => {
    const rows = [
      {
        id: 1,
        client_id: "c1",
        contact_id: "ct1",
        remote_jid: "55119@s.whatsapp.net",
        bot_status: "bot_active",
        last_message_at: "2024-03-01T08:00:00.000Z",
        created_at: "2024-01-01T00:00:00.000Z",
        updated_at: "2024-03-01T08:00:00.000Z",
        unread_count: 2,
      },
      {
        id: 2,
        client_id: "c1",
        contact_id: "ct1",
        remote_jid: "55119@s.whatsapp.net",
        bot_status: "bot_paused",
        last_message_at: "2024-03-01T10:00:00.000Z",
        created_at: "2024-01-01T00:00:00.000Z",
        updated_at: "2024-03-01T10:00:00.000Z",
        unread_count: 3,
      },
    ];
    const result = normalizeConversations(rows);
    expect(result).toHaveLength(1);
    expect(result[0].last_message_at).toBe("2024-03-01T10:00:00.000Z");
    expect(result[0].unread_count).toBe(5); // 2 + 3
  });

  it("ordena resultado final por last_message_at DESC", () => {
    const rows = [
      {
        id: 1,
        client_id: "c1",
        contact_id: "ct1",
        remote_jid: "55111@s.whatsapp.net",
        bot_status: "bot_active",
        last_message_at: "2024-03-01T08:00:00.000Z",
        created_at: "2024-01-01T00:00:00.000Z",
        updated_at: "2024-03-01T08:00:00.000Z",
        unread_count: 0,
      },
      {
        id: 2,
        client_id: "c1",
        contact_id: "ct2",
        remote_jid: "55112@s.whatsapp.net",
        bot_status: "bot_active",
        last_message_at: "2024-03-01T12:00:00.000Z",
        created_at: "2024-01-01T00:00:00.000Z",
        updated_at: "2024-03-01T12:00:00.000Z",
        unread_count: 0,
      },
    ];
    const result = normalizeConversations(rows);
    expect(result[0].id).toBe("55112@s.whatsapp.net");
    expect(result[1].id).toBe("55111@s.whatsapp.net");
  });
});
