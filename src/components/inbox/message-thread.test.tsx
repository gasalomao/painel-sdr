import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@/types";
import { MessageThread } from "./message-thread";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}));

vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: React.forwardRef<HTMLDivElement, { children: React.ReactNode }>(function MockScrollArea(
    { children },
    ref
  ) {
    return (
      <div ref={ref} data-slot="scroll-area-viewport">
        {children}
      </div>
    );
  }),
}));

const conversation: Conversation = {
  id: "5511999990001@s.whatsapp.net",
  instance_name: "own",
  user_id: "tenant-a",
  contact_id: "contact-1",
  status: "open",
  unread_count: 0,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  contact: {
    id: "contact-1",
    account_id: "tenant-a",
    user_id: "tenant-a",
    remote_jid: "5511999990001@s.whatsapp.net",
    phone: "5511999990001",
    name: "Cliente Teste",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollTo = vi.fn();
  mocks.fetch.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/inbox/messages")) {
      return new Response(JSON.stringify({ ok: true, messages: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  vi.stubGlobal("fetch", mocks.fetch);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MessageThread envio manual", () => {
  it("dispara apenas um toast de erro quando /api/send-message falha e preserva o rascunho", async () => {
    mocks.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/inbox/messages")) {
        return new Response(JSON.stringify({ ok: true, messages: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/send-message") {
        return new Response(JSON.stringify({ success: false, error: "Instância desconectada" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    render(
      <MessageThread
        conversation={conversation}
        contact={conversation.contact ?? null}
        messages={[]}
        onMessagesLoaded={vi.fn()}
        onNewMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
        onStatusChange={vi.fn()}
        clientId="tenant-a"
        realtimeConnected
      />
    );

    const input = screen.getByRole("textbox", { name: "Mensagem" }) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Rascunho importante" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensagem" }));

    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledTimes(1));
    expect(mocks.toast.error).toHaveBeenCalledWith("Instância desconectada");
    expect(input.value).toBe("Rascunho importante");
  });

  it("não dispara chamada redundante para /api/agent/control após envio bem-sucedido", async () => {
    mocks.fetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/api/inbox/messages")) {
        return new Response(JSON.stringify({ ok: true, messages: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url === "/api/send-message") {
        return new Response(JSON.stringify({ success: true, msgId: "msg-ok", sent: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const onNewMessage = vi.fn();
    render(
      <MessageThread
        conversation={conversation}
        contact={conversation.contact ?? null}
        messages={[]}
        onMessagesLoaded={vi.fn()}
        onNewMessage={onNewMessage}
        onUpdateMessage={vi.fn()}
        onStatusChange={vi.fn()}
        clientId="tenant-a"
        realtimeConnected
      />
    );

    const input = screen.getByRole("textbox", { name: "Mensagem" });
    fireEvent.change(input, { target: { value: "Olá cliente" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensagem" }));

    await waitFor(() => expect(onNewMessage).toHaveBeenCalledTimes(1));
    expect(mocks.fetch.mock.calls.some(([u]) => String(u) === "/api/agent/control")).toBe(false);
  });

  it("exibe o motivo da pausa (pause_reason) no banner quando a IA está pausada", () => {
    render(
      <MessageThread
        conversation={{
          ...conversation,
          bot_status: "bot_paused",
          paused_by: "system",
          pause_reason: "Objetivo alcançado: agendar reunião",
        }}
        contact={conversation.contact ?? null}
        messages={[]}
        onMessagesLoaded={vi.fn()}
        onNewMessage={vi.fn()}
        onUpdateMessage={vi.fn()}
        onStatusChange={vi.fn()}
        clientId="tenant-a"
        realtimeConnected
      />
    );

    expect(screen.getByText(/Objetivo alcançado: agendar reunião/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Reativar IA/i })).toBeTruthy();
  });
});

