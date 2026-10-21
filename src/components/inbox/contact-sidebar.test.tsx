import React from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Contact } from "@/types";
import { ContactSidebar } from "./contact-sidebar";

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), tagsFetch: vi.fn(), writes: [] as { payload: Record<string, unknown>; filters: [string, unknown][] }[], writeResult: null as Promise<unknown> | null, toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/components/ui/scroll-area", () => ({ ScrollArea: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/lib/supabase", () => ({
  supabase: { from: () => {
    let write: typeof mocks.writes[number] | undefined;
    const query = {
      select: () => query, order: () => query, limit: () => query,
      maybeSingle: () => query, single: () => query,
      update: (payload: Record<string, unknown>) => { write = { payload, filters: [] }; mocks.writes.push(write); return query; },
      eq: (key: string, value: unknown) => { write?.filters.push([key, value]); return query; },
      then: (resolve: (result: unknown) => unknown) => (write && mocks.writeResult
        ? mocks.writeResult : Promise.resolve({ data: write ? { id: "contact-a" } : null, error: null })).then(resolve),
    };
    return query;
  } },
}));

const contact: Contact = {
  id: "11111111-1111-4111-8111-111111111111", user_id: "tenant-a", account_id: "tenant-a", name: "Vidraçaria Geral",
  phone: "5511987654321", remote_jid: "5511987654321@s.whatsapp.net",
  created_at: "2026-01-01", updated_at: "2026-01-01", tags: [],
};
const lead = { id: 7, client_id: "tenant-a", nome_negocio: "Vidraçaria Geral", telefone: "(11) 8765-4321", status: "proposta_especial", created_at: "2026-01-01" };
const columns = [{ status_key: "novo", label: "Lead Extraído" }, { status_key: "proposta_especial", label: "Proposta personalizada" }];
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const found = () => response({ state: "found", lead, columns });

beforeEach(() => {
  mocks.fetch.mockReset(); mocks.tagsFetch.mockReset(); mocks.toast.error.mockClear(); mocks.toast.success.mockClear();
  mocks.writes = []; mocks.writeResult = null;
  mocks.fetch.mockImplementation(async () => found());
  mocks.tagsFetch.mockImplementation(async () => response({ tags: ["fazer_site", "fazer_video", "Reunião"] }));
  vi.stubGlobal("fetch", (url: string, init?: RequestInit) => url.startsWith("/api/contacts/tags") ? mocks.tagsFetch(url, init) : mocks.fetch(url, init));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function EditableSidebar({ initial = contact }: { initial?: Contact }): React.JSX.Element {
  const [value, setValue] = React.useState(initial);
  return <ContactSidebar contact={value} clientId="tenant-a" onContactUpdate={setValue} />;
}

describe("ContactSidebar tags", () => {
  it("sugere por trecho sem acento e vincula por clique sem reiniciar CRM", async () => {
    render(<EditableSidebar />);
    await screen.findByLabelText("Estágio no Funil");
    const input = screen.getByRole("combobox", { name: "Nova tag do contato" });
    fireEvent.input(input, { inputType: "insertText", target: { value: "site" } });
    fireEvent.click(await screen.findByRole("option", { name: "fazer_site" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remover tag fazer_site" })).toBeDefined());
    expect(mocks.writes[0]).toEqual({ payload: { tags: ["fazer_site"] }, filters: expect.arrayContaining([["id", contact.id], ["client_id", "tenant-a"]]) });
    expect(input).toHaveValue("");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    fireEvent.input(input, { inputType: "insertText", target: { value: "reuniao" } });
    expect(await screen.findByRole("option", { name: "Reunião" })).toBeDefined();
  });

  it("vincula sugestão por teclado e não sugere tags vinculadas", async () => {
    render(<EditableSidebar />);
    const input = screen.getByRole("combobox", { name: "Nova tag do contato" });
    fireEvent.input(input, { inputType: "insertText", target: { value: "site" } });
    await screen.findByRole("option", { name: "fazer_site" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    await screen.findByRole("button", { name: "Remover tag fazer_site" });
    fireEvent.input(input, { inputType: "insertText", target: { value: "site" } });
    expect(screen.queryByRole("option", { name: "fazer_site" })).toBeNull();
    expect(mocks.writes).toHaveLength(1);
  });

  it("mantém texto livre e preserva entrada em falha ou zero linhas", async () => {
    render(<EditableSidebar />);
    const input = screen.getByLabelText("Nova tag do contato");
    fireEvent.input(input, { inputType: "insertText", target: { value: "nova_tag" } });
    mocks.writeResult = Promise.resolve({ data: null, error: null });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar tag" }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    expect(input).toHaveValue("nova_tag");
    expect(screen.queryByRole("button", { name: "Remover tag nova_tag" })).toBeNull();
    mocks.writeResult = null;
    fireEvent.click(screen.getByRole("button", { name: "Adicionar tag" }));
    await screen.findByRole("button", { name: "Remover tag nova_tag" });
  });

  it("ignora catálogo e escrita antigos ao trocar empresa e contato", async () => {
    let finishTags!: (value: Response) => void;
    let finishWrite!: (value: unknown) => void;
    mocks.tagsFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finishTags = resolve; }));
    mocks.writeResult = new Promise((resolve) => { finishWrite = resolve; });
    const onContactUpdate = vi.fn();
    const { rerender } = render(<ContactSidebar contact={contact} clientId="tenant-a" onContactUpdate={onContactUpdate} />);
    fireEvent.input(screen.getByLabelText("Nova tag do contato"), { inputType: "insertText", target: { value: "antiga" } });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar tag" }));
    mocks.tagsFetch.mockResolvedValueOnce(response({ tags: ["outra_empresa"] }));
    rerender(<ContactSidebar contact={{ ...contact, id: "contact-b", user_id: "tenant-b" }} clientId="tenant-b" onContactUpdate={onContactUpdate} />);
    await act(async () => { finishTags(response({ tags: ["antiga_empresa"] })); finishWrite({ data: { id: contact.id }, error: null }); });
    expect(onContactUpdate).not.toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalledWith("Tag adicionada!");
    const input = screen.getByLabelText("Nova tag do contato");
    expect(input).toHaveValue("");
    fireEvent.input(input, { inputType: "insertText", target: { value: "empresa" } });
    expect(await screen.findByRole("option", { name: "outra_empresa" })).toBeDefined();
    expect(screen.queryByRole("option", { name: "antiga_empresa" })).toBeNull();
  });

  it("não reabre sugestões atrasadas depois que o foco sai das tags", async () => {
    let finish!: (value: Response) => void;
    mocks.tagsFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    render(<EditableSidebar />);
    const input = screen.getByLabelText("Nova tag do contato");
    const note = screen.getByLabelText("Anotações do contato");
    act(() => { input.focus(); });
    fireEvent.input(input, { inputType: "insertText", target: { value: "site" } });
    expect(input).toHaveAttribute("aria-expanded", "false");
    act(() => { note.focus(); });
    await act(async () => { finish(response({ tags: ["fazer_site"] })); });
    expect(input).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("listbox", { name: "Tags existentes" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Anotações do contato" })).toHaveFocus();
    expect(note.closest('[aria-hidden="true"]')).toBeNull();
    act(() => { input.focus(); });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(await screen.findByRole("option", { name: "fazer_site" })).toBeDefined();
  });

  it("abre sugestões do catálogo atrasado quando o foco permanece no input", async () => {
    let finish!: (value: Response) => void;
    mocks.tagsFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    render(<EditableSidebar />);
    const input = screen.getByLabelText("Nova tag do contato");
    act(() => { input.focus(); });
    fireEvent.input(input, { inputType: "insertText", target: { value: "site" } });
    await act(async () => { finish(response({ tags: ["fazer_site"] })); });
    expect(await screen.findByRole("option", { name: "fazer_site" })).toBeDefined();
    expect(input).toHaveFocus();
  });

  it("reutiliza nome do catálogo sem diferenciar maiúsculas e bloqueia tag duplicada", async () => {
    render(<EditableSidebar />);
    await screen.findByLabelText("Estágio no Funil");
    const input = screen.getByLabelText("Nova tag do contato");
    fireEvent.input(input, { inputType: "insertText", target: { value: "FAZER_SITE" } });
    await screen.findByRole("option", { name: "fazer_site" });
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar tag" }));
    await screen.findByRole("button", { name: "Remover tag fazer_site" });
    expect(mocks.writes[0].payload).toEqual({ tags: ["fazer_site"] });
    fireEvent.input(input, { inputType: "insertText", target: { value: "FAZER_SITE" } });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar tag" }));
    expect(mocks.writes).toHaveLength(1);
    expect(mocks.toast.error).toHaveBeenCalledWith("Esta tag já está associada ao contato.");
  });

  it("preserva texto e permite repetir adição após erro de rede", async () => {
    render(<EditableSidebar />);
    const input = screen.getByLabelText("Nova tag do contato");
    fireEvent.input(input, { inputType: "insertText", target: { value: "tag_livre" } });
    mocks.writeResult = Promise.resolve({ data: null, error: { message: "offline" } });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar tag" }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    expect(input).toHaveValue("tag_livre");
    mocks.writeResult = null;
    fireEvent.click(screen.getByRole("button", { name: "Adicionar tag" }));
    await screen.findByRole("button", { name: "Remover tag tag_livre" });
  });

  it("informa falha do catálogo e permite tentar novamente", async () => {
    mocks.tagsFetch.mockResolvedValueOnce(response({ error: "offline" }, 500));
    render(<EditableSidebar />);
    const retry = await screen.findByRole("button", { name: "Recarregar tags" });
    fireEvent.click(retry);
    fireEvent.input(screen.getByLabelText("Nova tag do contato"), { inputType: "insertText", target: { value: "site" } });
    expect(await screen.findByRole("option", { name: "fazer_site" })).toBeDefined();
  });
});

describe("ContactSidebar concorrência", () => {
  it("preserva rascunho de anotação ao adicionar e remover tags", async () => {
    render(<EditableSidebar />);
    await screen.findByLabelText("Estágio no Funil");
    const note = screen.getByLabelText("Anotações do contato");
    fireEvent.change(note, { target: { value: "Rascunho não salvo" } });
    fireEvent.input(screen.getByLabelText("Nova tag do contato"), { inputType: "insertText", target: { value: "nova" } });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar tag" }));
    fireEvent.click(await screen.findByRole("button", { name: "Remover tag nova" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Remover tag nova" })).toBeNull());
    expect(note).toHaveValue("Rascunho não salvo");
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["notes", "tags"])("mescla callbacks sem perder tags ou notas quando %s termina primeiro", async (first) => {
    let finishNote!: (value: unknown) => void;
    let finishTag!: (value: unknown) => void;
    render(<EditableSidebar />);
    await screen.findByLabelText("Estágio no Funil");
    fireEvent.change(screen.getByLabelText("Anotações do contato"), { target: { value: "  Salva  " } });
    mocks.writeResult = new Promise((resolve) => { finishNote = resolve; });
    fireEvent.click(screen.getByRole("button", { name: "Salvar Anotações" }));
    mocks.writeResult = new Promise((resolve) => { finishTag = resolve; });
    fireEvent.input(screen.getByLabelText("Nova tag do contato"), { inputType: "insertText", target: { value: "nova" } });
    fireEvent.click(screen.getByRole("button", { name: "Adicionar tag" }));
    const ok = { data: { id: contact.id }, error: null };
    await act(async () => { (first === "notes" ? finishNote : finishTag)(ok); });
    await act(async () => { (first === "notes" ? finishTag : finishNote)(ok); });
    expect(screen.getByRole("button", { name: "Remover tag nova" })).toBeDefined();
    expect(screen.getByLabelText("Anotações do contato")).toHaveValue("Salva");
    expect(mocks.writes).toHaveLength(2);
    expect(mocks.writes[0]).toEqual({ payload: { notes: "Salva" }, filters: [["id", contact.id], ["client_id", "tenant-a"]] });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
  });

  it("preserva edição feita enquanto a nota anterior está sendo salva e impede clique duplo", async () => {
    let finish!: (value: unknown) => void;
    mocks.writeResult = new Promise((resolve) => { finish = resolve; });
    render(<EditableSidebar />);
    const note = screen.getByLabelText("Anotações do contato");
    fireEvent.change(note, { target: { value: "Primeira" } });
    const save = screen.getByRole("button", { name: "Salvar Anotações" });
    fireEvent.click(save); fireEvent.click(save);
    fireEvent.change(note, { target: { value: "Edição mais recente" } });
    await act(async () => { finish({ data: { id: contact.id }, error: null }); });
    expect(note).toHaveValue("Edição mais recente");
    expect(mocks.writes).toHaveLength(1);
  });

  it.each([{ data: null, error: null }, { data: null, error: { message: "offline" } }])("preserva anotação em falha e não anuncia sucesso (%j)", async (result) => {
    mocks.writeResult = Promise.resolve(result);
    const onContactUpdate = vi.fn();
    render(<ContactSidebar contact={contact} clientId="tenant-a" onContactUpdate={onContactUpdate} />);
    fireEvent.change(screen.getByLabelText("Anotações do contato"), { target: { value: "Não perder" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar Anotações" }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalled());
    expect(screen.getByLabelText("Anotações do contato")).toHaveValue("Não perder");
    expect(onContactUpdate).not.toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
  });

  it("descarta salvamento de nota antigo ao trocar empresa e contato", async () => {
    let finish!: (value: unknown) => void;
    mocks.writeResult = new Promise((resolve) => { finish = resolve; });
    const onContactUpdate = vi.fn();
    const { rerender } = render(<ContactSidebar contact={contact} clientId="tenant-a" onContactUpdate={onContactUpdate} />);
    fireEvent.change(screen.getByLabelText("Anotações do contato"), { target: { value: "Antiga" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar Anotações" }));
    const next = { ...contact, id: "contact-b", notes: "Outra empresa" };
    rerender(<ContactSidebar contact={next} clientId="tenant-b" onContactUpdate={onContactUpdate} />);
    await act(async () => { finish({ data: { id: contact.id }, error: null }); });
    expect(onContactUpdate).not.toHaveBeenCalled();
    expect(mocks.toast.success).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Anotações do contato")).toHaveValue("Outra empresa");
  });

  it("preserva tag em falha de remoção e impede escrita duplicada", async () => {
    const tag = { id: "nova", name: "nova", user_id: "tenant-a", color: "blue", created_at: "2026-01-01" };
    let finish!: (value: unknown) => void;
    mocks.writeResult = new Promise((resolve) => { finish = resolve; });
    render(<EditableSidebar initial={{ ...contact, tags: [tag] }} />);
    const remove = screen.getByRole("button", { name: "Remover tag nova" });
    fireEvent.click(remove); fireEvent.click(remove);
    await act(async () => { finish({ data: null, error: { message: "offline" } }); });
    expect(mocks.writes).toHaveLength(1);
    expect(remove).toBeEnabled();
    expect(mocks.toast.error).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Remover tag nova" })).toBeDefined();
  });
});

describe("ContactSidebar CRM", () => {
  it("preserva CRM ao atualizar dados irrelevantes e trocar apenas a sessão", async () => {
    const { rerender } = render(<ContactSidebar contact={contact} clientId="tenant-a" sessionId="session-a" />);
    await screen.findByLabelText("Estágio no Funil");
    mocks.fetch.mockResolvedValue(response({ error: "Falha transitória" }, 500));
    const updated = { ...contact, name: "Novo nome", notes: "Nova anotação", avatar_url: "/photo.png", tags: [{ id: "fazer_site", name: "fazer_site", user_id: "tenant-a", color: "blue", created_at: "2026-01-01" }] };
    rerender(<ContactSidebar contact={updated} clientId="tenant-a" sessionId="session-b" />);
    await act(async () => {});
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Consultando CRM...")).toBeNull();
    expect((screen.getByLabelText("Estágio no Funil") as HTMLSelectElement).value).toBe("proposta_especial");
  });

  it("usa identidade transitória quando ID não é UUID", async () => {
    render(<ContactSidebar contact={{ ...contact, id: contact.remote_jid! }} clientId="tenant-a" />);
    await screen.findByLabelText("Estágio no Funil");
    const url = new URL(mocks.fetch.mock.calls[0][0], "http://localhost");
    expect(url.searchParams.has("contactId")).toBe(false);
    expect(url.searchParams.get("remote_jid")).toBe(contact.remote_jid);
  });

  it("consulta novamente quando muda empresa ou identidade", async () => {
    const { rerender } = render(<ContactSidebar contact={contact} clientId="tenant-a" />);
    await screen.findByLabelText("Estágio no Funil");
    rerender(<ContactSidebar contact={contact} clientId="tenant-b" />);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2));
    rerender(<ContactSidebar contact={{ ...contact, phone: "5521987654321" }} clientId="tenant-b" />);
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(3));
  });
  it("reconhece lead formatado e mostra a etapa personalizada real", async () => {
    render(<ContactSidebar contact={contact} clientId="tenant-a" />);
    const select = await screen.findByLabelText("Estágio no Funil");
    expect((select as HTMLSelectElement).value).toBe("proposta_especial");
    expect(screen.getByRole("option", { name: "Proposta personalizada" })).toBeDefined();
    expect(screen.queryByText("Este contato não está cadastrado como Lead.")).toBeNull();
    expect(new URL(mocks.fetch.mock.calls[0][0], "http://localhost").searchParams.get("contactId")).toBe(contact.id);
  });

  it("não anuncia inexistência nem permite criar durante carregamento ou falha", async () => {
    let resolve!: (result: Response) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    render(<ContactSidebar contact={contact} clientId="tenant-a" />);
    expect(screen.queryByText("Este contato não está cadastrado como Lead.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Criar Lead no Kanban" })).toBeNull();
    await act(async () => resolve(response({ error: "Falha ao consultar CRM" }, 500)));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível consultar o CRM");
    expect(screen.queryByRole("button", { name: "Criar Lead no Kanban" })).toBeNull();
    mocks.fetch.mockResolvedValueOnce(found());
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByLabelText("Estágio no Funil")).toBeDefined();
  });

  it("não permite duplicar matches ambíguos", async () => {
    mocks.fetch.mockResolvedValueOnce(response({ state: "ambiguous", lead: null, columns }));
    render(<ContactSidebar contact={contact} clientId="tenant-a" />);
    expect(await screen.findByText(/Mais de um lead corresponde/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Criar Lead no Kanban" })).toBeNull();
  });

  it("ignora resposta atrasada do contato anterior", async () => {
    let resolve!: (result: Response) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    const { rerender } = render(<ContactSidebar contact={contact} clientId="tenant-a" />);
    mocks.fetch.mockResolvedValueOnce(response({ state: "found", lead: { ...lead, id: 8, nome_negocio: "Outro lead", status: "novo" }, columns }));
    rerender(<ContactSidebar contact={{ ...contact, id: "contact-b", phone: "5521999991111" }} clientId="tenant-a" />);
    await screen.findByText("Outro lead");
    await act(async () => resolve(found()));
    expect(screen.getByText("Outro lead")).toBeDefined();
    expect((screen.getByLabelText("Estágio no Funil") as HTMLSelectElement).value).toBe("novo");
  });

  it("atualiza estágio e relê ao reabrir a sidebar", async () => {
    const { unmount } = render(<ContactSidebar contact={contact} clientId="tenant-a" />);
    const select = await screen.findByLabelText("Estágio no Funil");
    mocks.fetch.mockResolvedValueOnce(response({ lead: { ...lead, status: "novo" } }));
    fireEvent.change(select, { target: { value: "novo" } });
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe("novo"));
    expect(mocks.fetch).toHaveBeenLastCalledWith("/api/contacts/crm", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ leadId: 7, status: "novo" }) }));
    unmount();
    mocks.fetch.mockResolvedValueOnce(response({ state: "found", lead: { ...lead, status: "proposta_especial" }, columns }));
    render(<ContactSidebar contact={contact} clientId="tenant-a" />);
    expect((await screen.findByLabelText("Estágio no Funil") as HTMLSelectElement).value).toBe("proposta_especial");
  });

  it("preserva status salvo que não aparece mais nas colunas", async () => {
    mocks.fetch.mockResolvedValueOnce(response({ state: "found", lead: { ...lead, status: "etapa_legada" }, columns }));
    render(<ContactSidebar contact={contact} clientId="tenant-a" />);
    const select = await screen.findByLabelText("Estágio no Funil");
    expect((select as HTMLSelectElement).value).toBe("etapa_legada");
    expect(screen.getByRole("option", { name: "etapa_legada" })).toBeDefined();
  });

  it("não aplica escrita atrasada ao próximo contato", async () => {
    const { rerender } = render(<ContactSidebar contact={contact} clientId="tenant-a" />);
    const select = await screen.findByLabelText("Estágio no Funil");
    let resolve!: (result: Response) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise<Response>((done) => { resolve = done; }));
    fireEvent.change(select, { target: { value: "novo" } });
    mocks.fetch.mockResolvedValueOnce(response({ state: "found", lead: { ...lead, id: 8, nome_negocio: "Outro lead" }, columns }));
    rerender(<ContactSidebar contact={{ ...contact, id: "contact-b" }} clientId="tenant-a" />);
    await screen.findByText("Outro lead");
    await act(async () => resolve(response({ lead: { ...lead, status: "novo" } })));
    expect(screen.getByText("Outro lead")).toBeDefined();
    expect((screen.getByLabelText("Estágio no Funil") as HTMLSelectElement).value).toBe("proposta_especial");
  });

  it("preserva edição do contato enquanto cria ou vincula lead", async () => {
    mocks.fetch.mockResolvedValueOnce(response({ state: "missing", lead: null, columns }));
    const onContactUpdate = vi.fn();
    const { rerender } = render(<ContactSidebar contact={contact} clientId="tenant-a" onContactUpdate={onContactUpdate} />);
    const button = await screen.findByRole("button", { name: "Criar Lead no Kanban" });
    let finish!: (value: Response) => void;
    mocks.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    fireEvent.click(button);
    const updated = { ...contact, notes: "Nova anotação", tags: [{ id: "nova", name: "nova", user_id: "tenant-a", color: "blue", created_at: "2026-01-01" }] };
    rerender(<ContactSidebar contact={updated} clientId="tenant-a" onContactUpdate={onContactUpdate} />);
    await act(async () => { finish(response({ state: "found", lead, columns })); });
    expect(onContactUpdate).toHaveBeenCalledWith({ ...updated, lead_id: lead.id });
  });

  it("revalida antes de criar e aceita lead existente sem falsa mensagem de criação", async () => {
    mocks.fetch.mockResolvedValueOnce(response({ state: "missing", lead: null, columns }));
    const onContactUpdate = vi.fn();
    render(<ContactSidebar contact={contact} clientId="tenant-a" onContactUpdate={onContactUpdate} />);
    const button = await screen.findByRole("button", { name: "Criar Lead no Kanban" });
    mocks.fetch.mockResolvedValueOnce(response({ state: "found", lead, columns, created: false }));
    fireEvent.click(button);
    expect(await screen.findByLabelText("Estágio no Funil")).toBeDefined();
    expect(onContactUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: contact.id, lead_id: 7 }));
    expect(mocks.toast.success).toHaveBeenLastCalledWith("Lead existente vinculado ao contato.");
  });
});
