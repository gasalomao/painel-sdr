import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@/types";
import { ConversationList } from "./conversation-list";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  photoSyncFetch: vi.fn(),
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
  inboxData: { sessions: [] as any[], messages: [] as any[], columns: [] as any[], leads: [] as any[] },
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/components/ui/scroll-area", () => ({ ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

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
  mocks.inboxData = { sessions: [], messages: [], columns: [], leads: [] };
  mocks.photoSyncFetch.mockReset();
  mocks.fetch.mockReset().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/inbox/conversations")) {
      return response({ ok: true, ...mocks.inboxData });
    }
    return mocks.photoSyncFetch(url, init);
  });
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
    mocks.photoSyncFetch.mockResolvedValueOnce(response({ success: true, updated: 2 })).mockResolvedValueOnce(response(body, status));
    const loaded = await sync();
    expect(mocks.photoSyncFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(mocks.photoSyncFetch.mock.calls[1][1].body)).toEqual({ jids: [jid], instance: "own", force: true });
    expect(mocks.toast.error).toHaveBeenCalledWith(expect.stringContaining("Falha ao sincronizar fotos"));
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(loaded).not.toHaveBeenCalled();
  });

  it("reporta erro de rede da segunda chamada sem descartar a foto anterior", async () => {
    mocks.photoSyncFetch.mockResolvedValueOnce(response({ success: true, updated: 0 })).mockRejectedValueOnce(new TypeError("fetch failed"));
    const loaded = await sync();
    expect(mocks.toast.error).toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(loaded).not.toHaveBeenCalled();
  });

  it("interrompe hidratação quando o bulk informa sucesso parcial", async () => {
    mocks.photoSyncFetch.mockResolvedValueOnce(response({ success: true, partial: true, failed: 1, updated: 1 }));
    await sync();
    expect(mocks.toast.error).toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(mocks.photoSyncFetch).toHaveBeenCalledTimes(1);
  });

  it("aplica avatares e anuncia sucesso somente após as duas chamadas concluírem", async () => {
    mocks.photoSyncFetch.mockResolvedValueOnce(response({ success: true, updated: 1 }))
      .mockResolvedValueOnce(response({ success: true, partial: false, failed: 0, avatars: { [jid]: newPhoto } }));
    const loaded = await sync();
    expect(loaded).toHaveBeenCalledWith([expect.objectContaining({ contact: expect.objectContaining({ avatar_url: newPhoto }) })]);
    expect(mocks.toast.success).toHaveBeenCalledWith("Sincronização concluída: 1 fotos atualizadas!");
    expect(mocks.toast.error).not.toHaveBeenCalled();
  });
});

describe("ConversationList filtro por coluna do Kanban", () => {
  it("renderiza o seletor de colunas do Kanban", async () => {
    render(
      <ConversationList
        activeConversationId={null}
        onSelect={vi.fn()}
        conversations={[conversation]}
        onConversationsLoaded={vi.fn()}
        clientId="a"
      />
    );
    expect(screen.getByRole("button", { name: "Filtrar por coluna do Kanban" })).toBeInTheDocument();
    expect(screen.getByText("Kanban")).toBeInTheDocument();
  });

  it("exibe leads da coluna mesmo que nunca tenham conversado e prioriza conversas mais recentes primeiro", async () => {
    const uncontactedLead = {
      id: 99,
      nome_negocio: "Oficina do João (Sem Conversa)",
      telefone: "5511988887777",
      remoteJid: "5511988887777@s.whatsapp.net",
      status: "follow-up",
      photos: ["https://example.com/foto.jpg"],
      created_at: "2026-01-02",
    };
    const contactedLead = {
      id: 100,
      nome_negocio: "Restaurante Silva (Com Conversa)",
      telefone: "5511999990001",
      remoteJid: jid,
      status: "follow-up",
      photos: null,
      created_at: "2026-01-01",
    };
    mocks.inboxData.leads = [uncontactedLead, contactedLead];

    const convWithChat: Conversation = {
      ...conversation,
      last_message_at: "2026-01-05T10:00:00Z",
      last_message_text: "Última mensagem enviada",
      contact: {
        ...conversation.contact!,
        name: "Restaurante Silva (Com Conversa)",
      },
    };

    const onSelect = vi.fn();
    render(
      <ConversationList
        activeConversationId={null}
        onSelect={onSelect}
        conversations={[convWithChat]}
        onConversationsLoaded={vi.fn()}
        clientId="a"
      />
    );

    // Abre o dropdown do Kanban e seleciona "Follow-Up"
    fireEvent.click(screen.getByRole("button", { name: "Filtrar por coluna do Kanban" }));
    fireEvent.click(screen.getByText("Follow-Up"));

    // Ambos devem aparecer na tela
    await waitFor(() => {
      expect(screen.getByText("Restaurante Silva (Com Conversa)")).toBeInTheDocument();
      expect(screen.getByText("Oficina do João (Sem Conversa)")).toBeInTheDocument();
    });

    // A conversa com histórico aparece primeiro, o lead sem histórico aparece depois
    const items = screen.getAllByRole("button");
    const contactedIdx = items.findIndex((el) => el.textContent?.includes("Restaurante Silva"));
    const uncontactedIdx = items.findIndex((el) => el.textContent?.includes("Oficina do João"));
    expect(contactedIdx).toBeLessThan(uncontactedIdx);

    // O lead sem conversa prévia possui o badge "Sem conversa"
    expect(screen.getByText("Sem conversa")).toBeInTheDocument();

    // Ao clicar no lead sem conversa, dispara onSelect para iniciar chat
    fireEvent.click(screen.getByText("Oficina do João (Sem Conversa)"));
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "5511988887777@s.whatsapp.net",
        is_synthetic: true,
        contact: expect.objectContaining({
          name: "Oficina do João (Sem Conversa)",
          phone: "5511988887777",
          avatar_url: "https://example.com/foto.jpg",
        }),
      })
    );
  });
});

describe("ConversationList hidratação inicial de avatares", () => {
  it("não descarta conversas recém-carregadas quando conversations começa vazio", async () => {
    const semFotoJid = "5511977776666@s.whatsapp.net";
    mocks.inboxData.sessions = [
      {
        id: "sess-1",
        contact_id: "c-1",
        instance_name: "own",
        bot_status: "bot_active",
        unread_count: 1,
        last_message: "Oi",
        last_message_at: "2026-01-05T12:00:00Z",
        contact: {
          id: "c-1",
          remote_jid: semFotoJid,
          phone_number: "5511977776666",
          name: "Carlos",
          avatar_url: null,
        },
      },
    ];
    mocks.photoSyncFetch.mockResolvedValueOnce(
      response({ success: true, avatars: { [semFotoJid]: newPhoto } })
    );

    const loaded = vi.fn();
    render(
      <ConversationList
        activeConversationId={null}
        onSelect={vi.fn()}
        conversations={[]}
        onConversationsLoaded={loaded}
        clientId="a"
        instances={[{ id: "1", instance_name: "own", status: "open" } as any]}
      />
    );

    await waitFor(() => expect(loaded).toHaveBeenCalledTimes(2));
    expect(loaded.mock.calls[0][0]).toHaveLength(1);
    expect(loaded.mock.calls[1][0]).toEqual([
      expect.objectContaining({
        id: semFotoJid,
        contact: expect.objectContaining({ avatar_url: newPhoto }),
      }),
    ]);
  });

  it("hidrata avatares quando instances chega depois do carregamento inicial", async () => {
    const semFotoJid = "5511977775555@s.whatsapp.net";
    const initialConv: Conversation = {
      id: semFotoJid,
      instance_name: "own",
      user_id: "a",
      contact_id: "c-2",
      status: "open",
      unread_count: 0,
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
      contact: {
        id: "c-2",
        account_id: "a",
        user_id: "a",
        remote_jid: semFotoJid,
        phone: "5511977775555",
        name: "Ana",
        avatar_url: undefined,
        created_at: "2026-01-01",
        updated_at: "2026-01-01",
      },
    };
    mocks.photoSyncFetch.mockResolvedValueOnce(
      response({ success: true, avatars: { [semFotoJid]: newPhoto } })
    );

    const loaded = vi.fn();
    const { rerender } = render(
      <ConversationList
        activeConversationId={null}
        onSelect={vi.fn()}
        conversations={[initialConv]}
        onConversationsLoaded={loaded}
        clientId="a"
        instances={[]}
      />
    );

    await waitFor(() => expect(loaded).toHaveBeenCalledTimes(1));
    expect(mocks.photoSyncFetch).not.toHaveBeenCalled();

    rerender(
      <ConversationList
        activeConversationId={null}
        onSelect={vi.fn()}
        conversations={[initialConv]}
        onConversationsLoaded={loaded}
        clientId="a"
        instances={[{ id: "1", instance_name: "own", status: "open" } as any]}
      />
    );

    await waitFor(() => expect(mocks.photoSyncFetch).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(loaded).toHaveBeenLastCalledWith([
        expect.objectContaining({
          id: semFotoJid,
          contact: expect.objectContaining({ avatar_url: newPhoto }),
        }),
      ])
    );
  });
});
