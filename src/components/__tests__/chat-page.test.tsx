import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ChatPage from "@/app/chat/page";

const { from, replace, requests } = vi.hoisted(() => ({
  from: vi.fn(), replace: vi.fn(), requests: [] as { url: string; body: Record<string, unknown> }[],
}));
vi.mock("@/components/layout/header", () => ({ Header: () => <header><h1>Atendimento</h1></header> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }), useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/use-session", () => ({ useClientSession: () => ({ clientId: "client-test", loading: false }) }));
vi.mock("@/hooks/use-realtime", () => ({ useRealtime: () => ({ isConnected: true }) }));
vi.mock("@/lib/supabase", () => ({ supabase: { from } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const jid = "5511999991001@s.whatsapp.net";
const date = "2026-10-20T12:00:00Z";
const contacts = [
  { id: "contact-a", client_id: "client-test", remote_jid: jid, phone_number: "5511999991001", push_name: "Marina Oliveira", tags: ["Proposta"], created_at: date },
  { id: "contact-b", client_id: "client-test", remote_jid: "5511999991002@s.whatsapp.net", phone_number: "5511999991002", push_name: "Clínica Horizonte", tags: [], created_at: date },
];

beforeEach(() => {
  requests.length = 0;
  replace.mockClear();
  HTMLElement.prototype.scrollTo = vi.fn();
  from.mockImplementation((table: string) => {
    let single = false;
    let onlyJids: string[] | undefined;
    const query = {
      select: () => query, eq: () => query, order: () => query, limit: () => query,
      in: (_key: string, values: string[]) => { onlyJids = values; return query; },
      update: () => query, insert: () => query,
      maybeSingle: () => { single = true; return query; },
      single: () => { single = true; return query; },
      then: (resolve: (value: unknown) => void) => {
        const sessions = contacts.map((contact, i) => ({ id: `session-${i}`, client_id: "client-test", contact_id: contact.id, contact, instance_name: "Comercial", agent_id: 1, bot_status: i === 0 ? "bot_paused" : "bot_active", unread_count: i === 1 ? 2 : 0, last_message_at: date, created_at: date }));
        const messages = [{ id: "m1", remote_jid: jid, content: "Podemos conversar amanhã?", sender_type: "customer", created_at: date }];
        const data: unknown[] = table === "sessions" ? sessions : table === "channel_connections" ? [{ id: "i1", instance_name: "Comercial", status: "open" }] : table === "agent_settings" ? [{ id: 1, name: "Assistente comercial" }] : table === "chats_dashboard" ? messages.filter(m => !onlyJids || onlyJids.includes(m.remote_jid)) : [];
        return Promise.resolve({ data: single ? data[0] || null : data, error: null }).then(resolve);
      },
    };
    return query;
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    requests.push({ url, body });
    return new Response(JSON.stringify({ success: true, messageId: "sent-test", key: { id: "sent-test" }, avatars: {} }), { status: 200 });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openConversation(): Promise<void> {
  await screen.findByText("Marina Oliveira");
  fireEvent.click(screen.getByRole("button", { name: /Marina Oliveira/ }));
  await screen.findByRole("textbox", { name: "Mensagem" });
}

describe("Chat — regressão da apresentação", () => {
  it("mantém busca, seleção, histórico, retorno e detalhes", async () => {
    render(<ChatPage />);
    const search = await screen.findByRole("textbox", { name: "Buscar contatos ou mensagens" });
    await screen.findByText("Clínica Horizonte");
    fireEvent.change(search, { target: { value: "Marina" } });
    expect(screen.queryByText("Clínica Horizonte")).toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    await openConversation();
    expect(replace).toHaveBeenCalledWith(`/chat?c=${jid}`, { scroll: false });
    expect(await screen.findByText("Podemos conversar amanhã?", { selector: "p.whitespace-pre-wrap" })).toBeDefined();
    const toggle = screen.getByRole("button", { name: "Ocultar detalhes do contato" });
    fireEvent.click(toggle);
    expect(screen.queryByRole("textbox", { name: "Anotações do contato" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Exibir detalhes do contato" }));
    expect(screen.getByRole("textbox", { name: "Anotações do contato" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Voltar para conversas" }));
    expect(screen.getByText("Nenhuma conversa selecionada")).toBeDefined();
    expect(replace).toHaveBeenCalledWith("/chat", { scroll: false });
  });

  it("preserva filtros de conexão e agente, sincronização e menus de mídia", async () => {
    render(<ChatPage />);
    const connection = screen.getByRole("combobox", { name: "Conexão WhatsApp" });
    const agent = screen.getByRole("combobox", { name: "Agente de IA" });
    await screen.findByText("Clínica Horizonte");
    fireEvent.change(connection, { target: { value: "Comercial" } });
    fireEvent.change(agent, { target: { value: "1" } });
    expect(await screen.findByText("Marina Oliveira")).toBeDefined();
    const calls = from.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Sincronizar conversas" }));
    await waitFor(() => expect(from.mock.calls.length).toBeGreaterThan(calls));
    await openConversation();
    fireEvent.click(screen.getByRole("button", { name: "Anexar arquivo" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Imagens" })).toBeDefined();
    expect(within(menu).getByRole("menuitem", { name: "Vídeos" })).toBeDefined();
    expect(within(menu).getByRole("menuitem", { name: "Documentos" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Gravar áudio" })).toBeDefined();
  });

  it("mantém envio por botão e Enter sem duplicação ou mudança do destinatário", async () => {
    render(<ChatPage />);
    await openConversation();
    const input = screen.getByRole("textbox", { name: "Mensagem" });
    fireEvent.change(input, { target: { value: "Olá, Marina!" } });
    fireEvent.click(screen.getByRole("button", { name: "Enviar mensagem" }));
    await waitFor(() => expect(requests.filter(r => r.url === "/api/send-message")).toHaveLength(1));
    const send = requests.find(r => r.url === "/api/send-message");
    expect(send?.body).toMatchObject({ instanceName: "Comercial", remoteJid: jid, text: "Olá, Marina!" });
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
    await waitFor(() => expect(screen.getByRole("button", { name: "Gravar áudio" }).hasAttribute("disabled")).toBe(false));
    fireEvent.change(input, { target: { value: "Segunda mensagem" } });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(requests.filter(r => r.url === "/api/send-message")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Enter", shiftKey: false });
    await waitFor(() => expect(requests.filter(r => r.url === "/api/send-message")).toHaveLength(2));
  });
});
