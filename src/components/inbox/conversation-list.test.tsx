import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@/types";
import { ConversationList } from "./conversation-list";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/components/ui/scroll-area", () => ({ ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/lib/supabase", () => ({
  supabase: { from: () => {
    const query = new Proxy({}, { get: (_, key) => key === "then"
      ? (resolve: (result: unknown) => void) => Promise.resolve(resolve({ data: [], error: null }))
      : () => query });
    return query;
  } },
}));

const jid = "5511999990001@s.whatsapp.net";
const oldPhoto = "https://pps.whatsapp.net/old.jpg";
const newPhoto = "https://pps.whatsapp.net/new.jpg";
const conversation: Conversation = {
  id: jid, instance_name: "own", user_id: "a", contact_id: "contact-a", status: "open", unread_count: 0,
  created_at: "2026-01-01", updated_at: "2026-01-01",
  contact: { id: "contact-a", account_id: "a", user_id: "a", remote_jid: jid, phone: "5511999990001", name: "Contato", avatar_url: oldPhoto, created_at: "2026-01-01", updated_at: "2026-01-01" },
};
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetch.mockReset();
  vi.stubGlobal("fetch", mocks.fetch);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function sync(): Promise<ReturnType<typeof vi.fn>> {
  const loaded = vi.fn();
  render(<ConversationList activeConversationId={null} onSelect={vi.fn()} conversations={[conversation]} onConversationsLoaded={loaded} clientId="a" />);
  await waitFor(() => expect(loaded).toHaveBeenCalled());
  loaded.mockClear();
  fireEvent.click(screen.getByRole("button", { name: "Fotos" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Fotos" })).not.toBeDisabled());
  return loaded;
}

describe("ConversationList sincronização manual de fotos", () => {
  it.each([
    { name: "HTTP 502", status: 502, body: { success: false, error: "Provedor indisponível" } },
    { name: "HTTP 200 success:false", status: 200, body: { success: false, partial: false, failed: 0, avatars: { [jid]: oldPhoto } } },
    { name: "HTTP 200 parcial", status: 200, body: { success: false, partial: true, failed: 1, avatars: { [jid]: oldPhoto } } },
    { name: "HTTP 200 cancelado", status: 200, body: { success: false, partial: true, failed: 0, cancelled: true, avatars: { [jid]: oldPhoto } } },
    { name: "HTTP 200 inválido", status: 200, body: {} },
  ])("não anuncia sucesso quando a segunda chamada retorna $name", async ({ status, body }) => {
    mocks.fetch.mockResolvedValueOnce(response({ success: true, updated: 2 })).mockResolvedValueOnce(response(body, status));
    const loaded = await sync();
    expect(mocks.fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toEqual({ jids: [jid], instance: "own", force: true });
    expect(mocks.toast.error).toHaveBeenCalledWith(expect.stringContaining("Falha ao sincronizar fotos"));
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(loaded).not.toHaveBeenCalled();
  });

  it("reporta erro de rede da segunda chamada sem descartar a foto anterior", async () => {
    mocks.fetch.mockResolvedValueOnce(response({ success: true, updated: 0 })).mockRejectedValueOnce(new TypeError("fetch failed"));
    const loaded = await sync();
    expect(mocks.toast.error).toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(loaded).not.toHaveBeenCalled();
  });

  it("interrompe hidratação quando o bulk informa sucesso parcial", async () => {
    mocks.fetch.mockResolvedValueOnce(response({ success: true, partial: true, failed: 1, updated: 1 }));
    await sync();
    expect(mocks.toast.error).toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("aplica avatares e anuncia sucesso somente após as duas chamadas concluírem", async () => {
    mocks.fetch.mockResolvedValueOnce(response({ success: true, updated: 1 }))
      .mockResolvedValueOnce(response({ success: true, partial: false, failed: 0, avatars: { [jid]: newPhoto } }));
    const loaded = await sync();
    expect(loaded).toHaveBeenCalledWith([expect.objectContaining({ contact: expect.objectContaining({ avatar_url: newPhoto }) })]);
    expect(mocks.toast.success).toHaveBeenCalledWith("Sincronização concluída: 1 fotos atualizadas!");
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });
});
