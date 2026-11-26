import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSessionMessageHandled,
  markSessionMessagesHandled,
  resetHandledMessagesForTests,
} from "../session-lock";
import { extractUnansweredCustomerMessagesAfterAi } from "../agent-history";

describe("session-lock — rastreamento de mensagens já atendidas (TTL)", () => {
  beforeEach(() => {
    resetHandledMessagesForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetHandledMessagesForTests();
  });

  it("marca message_ids por sessão e expira após 10 minutos", () => {
    const t0 = 1_700_000_000_000;
    vi.setSystemTime(t0);

    markSessionMessagesHandled("sess-1", ["wamid-1", "wamid-2", null, "  "], t0);
    expect(isSessionMessageHandled("sess-1", "wamid-1", t0 + 1_000)).toBe(true);
    expect(isSessionMessageHandled("sess-1", "wamid-2", t0 + 1_000)).toBe(true);
    expect(isSessionMessageHandled("sess-2", "wamid-1", t0 + 1_000)).toBe(false);

    // Após 10 min + 1 ms, expira
    expect(isSessionMessageHandled("sess-1", "wamid-1", t0 + 10 * 60_000 + 1)).toBe(false);
  });
});

describe("extractUnansweredCustomerMessagesAfterAi (anti-atropelamento KS Limpeza)", () => {
  it("descarta mensagem antiga já respondida pela IA e mantém apenas a nova mensagem pós-IA", () => {
    const chrono = [
      {
        message_id: "m1",
        sender_type: "customer",
        content: "Quero saber os valores",
        created_at: "2026-11-25T08:45:40.000Z",
      },
      {
        message_id: "ai-1",
        sender_type: "ai",
        content: "Oi! Tudo bem? Qual o nome da sua empresa?",
        created_at: "2026-11-25T08:46:04.000Z",
      },
      {
        message_id: "m2",
        sender_type: "customer",
        content: "KS Limpeza",
        created_at: "2026-11-25T08:46:20.000Z",
      },
    ];

    const res = extractUnansweredCustomerMessagesAfterAi(
      chrono,
      "2026-11-25T08:45:00.000Z",
      {
        currentMessageId: "m2",
        isMessageHandled: (id) => id === "m1",
      },
    );

    expect(res.answeredByNewerAi).toBe(true);
    expect(res.unansweredCustomerMessages.map((m) => m.content)).toEqual(["KS Limpeza"]);
  });

  it("retorna lista vazia quando a última IA já respondeu todas as mensagens do lote", () => {
    const chrono = [
      {
        message_id: "m1",
        sender_type: "customer",
        content: "Oi",
        created_at: "2026-11-25T08:45:40.000Z",
      },
      {
        message_id: "ai-1",
        sender_type: "ai",
        content: "Olá! Como posso ajudar?",
        created_at: "2026-11-25T08:46:04.000Z",
      },
    ];

    const res = extractUnansweredCustomerMessagesAfterAi(
      chrono,
      "2026-11-25T08:45:00.000Z",
      {
        currentMessageId: "m1",
        isMessageHandled: (id) => id === "m1",
      },
    );

    expect(res.answeredByNewerAi).toBe(true);
    expect(res.unansweredCustomerMessages).toEqual([]);
  });

  it("nunca repesca mensagem humana recebida ANTES da abertura da IA (cenário real KS Limpeza)", () => {
    const chrono = [
      {
        message_id: "camp-1",
        sender_type: "ai",
        content: "Bom dia, é o pessoal da KS Limpeza?",
        created_at: "2026-11-25T11:46:01.000Z",
      },
      {
        message_id: "auto-1",
        sender_type: "customer",
        content: "K.S. Limpeza e higienização de Ar-Condicionado...",
        created_at: "2026-11-25T11:46:04.000Z",
      },
      {
        message_id: "human-1",
        sender_type: "customer",
        content: "Bom dia, sim, em que posso ajudá-la?",
        created_at: "2026-11-25T11:46:57.000Z",
      },
      {
        message_id: "ai-open-1",
        sender_type: "ai",
        content: "Oi! Tudo bem? Vi a KS Limpeza no Google... Hoje vocês têm site próprio ou usam mais Instagram e WhatsApp?",
        created_at: "2026-11-25T11:47:36.000Z",
      },
    ];

    const res = extractUnansweredCustomerMessagesAfterAi(
      chrono,
      "2026-11-25T11:46:02.000Z",
      {
        currentMessageId: "human-1",
        isMessageHandled: () => false,
      },
    );

    expect(res.answeredByNewerAi).toBe(true);
    expect(res.unansweredCustomerMessages).toEqual([]);
  });
});
