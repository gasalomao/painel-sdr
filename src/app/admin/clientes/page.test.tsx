import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AdminClientesPage from "./page";

vi.mock("@/components/layout/header", () => ({ Header: () => <header>Painel</header> }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const clients = [
  { id: "cliente-1", name: "Ana Silva", email: "ana@exemplo.com", is_admin: false, is_active: true, default_ai_model: "modelo-salvo", features: { chat: true, sites: false }, created_at: "2026-10-01" },
  { id: "cliente-2", name: "Bruno", email: "bruno", is_admin: false, is_active: false, default_ai_model: null, features: {}, created_at: "2026-10-01" },
  { id: "00000000-0000-0000-0000-000000000001", name: "Default", email: "default@local", is_admin: true, is_active: true, default_ai_model: null, features: {}, created_at: "2026-10-01" },
];
const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => url === "/api/ai-models"
      ? { success: true, models: [{ id: "modelo-da-api", name: "Modelo da API" }] }
      : { ok: true, clients },
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); fetchMock.mockReset(); });

async function openMenu(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: `Mais ações de ${name}` }));
  return screen.findByRole("menu");
}

describe("Gestão de clientes", () => {
  it("busca por nome/usuário e combina filtros sem fazer novas consultas", async () => {
    render(<AdminClientesPage />);
    await screen.findByText("Ana Silva");
    fireEvent.change(screen.getByRole("searchbox", { name: "Buscar clientes" }), { target: { value: "ANA@EXEMPLO" } });
    expect(screen.getByText("Ana Silva")).toBeInTheDocument();
    expect(screen.queryByText("Bruno")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "inactive" } });
    expect(screen.getByText("Nenhum resultado encontrado")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Limpar filtros" }));
    fireEvent.change(screen.getByLabelText("Tipo de conta"), { target: { value: "admin" } });
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.queryByText("Ana Silva")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("edita preservando modelo salvo e envia flags e notas ao endpoint original", async () => {
    render(<AdminClientesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Editar Ana Silva" }));
    const dialog = await screen.findByRole("dialog", { name: "Editar cliente" });
    await within(dialog).findByText("1 modelo(s) disponíveis");
    expect(within(dialog).getByLabelText("Modelo de IA padrão")).toHaveValue("modelo-salvo");
    fireEvent.change(within(dialog).getByLabelText("Nome"), { target: { value: "Ana atualizada" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Sites IA" }));
    fireEvent.change(within(dialog).getByLabelText("Notas internas"), { target: { value: "Nota preservada" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/clients/cliente-1", expect.objectContaining({
      method: "PATCH", body: expect.any(String),
    })));
    const request = fetchMock.mock.calls.find(([url, options]) => url === "/api/admin/clients/cliente-1" && options?.method === "PATCH");
    expect(JSON.parse(request![1].body)).toMatchObject({ name: "Ana atualizada", default_ai_model: "modelo-salvo", features: { chat: true, sites: true }, notes: "Nota preservada" });
    expect(JSON.parse(request![1].body)).not.toHaveProperty("password");
  });

  it("cria conta com modelo vindo da API e senha obrigatória", async () => {
    render(<AdminClientesPage />);
    await screen.findByText("Ana Silva");
    fireEvent.click(screen.getByRole("button", { name: "Novo cliente" }));
    const dialog = await screen.findByRole("dialog", { name: "Novo cliente" });
    await waitFor(() => expect(within(dialog).getByLabelText("Modelo de IA padrão")).toHaveValue("modelo-da-api"));
    fireEvent.change(within(dialog).getByLabelText("Nome"), { target: { value: "Nova conta" } });
    fireEvent.change(within(dialog).getByLabelText("Usuário ou e-mail"), { target: { value: "NOVA" } });
    fireEvent.change(within(dialog).getByLabelText("Senha inicial"), { target: { value: "senha-forte-123" } });
    fireEvent.click(within(dialog).getByRole("switch", { name: "Administrador" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Criar cliente" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/clients", expect.objectContaining({ method: "POST" })));
    const request = fetchMock.mock.calls.find(([, options]) => options?.method === "POST");
    expect(JSON.parse(request![1].body)).toMatchObject({ email: "nova", is_admin: true, default_ai_model: "modelo-da-api", password: "senha-forte-123" });
  });

  it("mantém proteções de apresentação e exclusão e confirmação destrutiva", async () => {
    render(<AdminClientesPage />);
    let menu = await openMenu("Bruno");
    expect(within(menu).getByRole("menuitem", { name: "Entrar como cliente" })).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(menu, { key: "Escape" });
    menu = await openMenu("Default");
    expect(within(menu).queryByRole("menuitem", { name: "Entrar como cliente" })).not.toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: /Excluir cliente/ })).toHaveAttribute("aria-disabled", "true");
    fireEvent.keyDown(menu, { key: "Escape" });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    menu = await openMenu("Ana Silva");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Excluir cliente" }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("IRREVERSÍVEL"));
    expect(fetchMock.mock.calls.some(([, options]) => options?.method === "DELETE")).toBe(false);
  });

  it("ativa conta pelo endpoint existente e permite abrir credenciais", async () => {
    render(<AdminClientesPage />);
    const menu = await openMenu("Bruno");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Ativar cliente" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/admin/clients/cliente-2", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ is_active: true }) })));
    fireEvent.click(within(await openMenu("Ana Silva")).getByRole("menuitem", { name: "Enviar credenciais" }));
    const dialog = await screen.findByRole("dialog", { name: "Credenciais de acesso" });
    expect(within(dialog).getByLabelText("Usuário")).toHaveValue("ana@exemplo.com");
    expect(within(dialog).getByRole("button", { name: "Aplicar senha e copiar" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Gerar senha forte" }));
    expect((within(dialog).getByLabelText("Nova senha") as HTMLInputElement).value).toHaveLength(12);
  });

  it("copia as credenciais somente após aplicar a senha e permite repetir quando a API recusa", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      render(<AdminClientesPage />);
      fireEvent.click(within(await openMenu("Ana Silva")).getByRole("menuitem", { name: "Enviar credenciais" }));
      const dialog = await screen.findByRole("dialog", { name: "Credenciais de acesso" });
      fireEvent.change(within(dialog).getByLabelText("Nova senha"), { target: { value: "senha-teste-123" } });
      fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ ok: false, error: "Sem permissão" }) });
      fireEvent.click(within(dialog).getByRole("button", { name: "Aplicar senha e copiar" }));
      expect(await within(dialog).findByRole("alert")).toHaveTextContent("Sem permissão");
      expect(writeText).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole("button", { name: "Aplicar senha e copiar" }));
      expect(await within(dialog).findByRole("status")).toHaveTextContent("Senha aplicada e credenciais copiadas.");
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/clients/cliente-1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ password: "senha-teste-123" }) }));
      expect(writeText).toHaveBeenCalledTimes(1);
      const message = writeText.mock.calls[0][0] as string;
      expect(message).toContain(window.location.origin);
      expect(message).toContain("Usuário: ana@exemplo.com");
      expect(message).toContain("Senha: senha-teste-123");
      expect(message).toContain("troque a senha no primeiro login");
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("mostra falha de carregamento sem tratar erro como lista vazia e permite tentar novamente", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ ok: false, error: "Acesso indisponível" }) });
    render(<AdminClientesPage />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Acesso indisponível");
    fireEvent.click(screen.getByRole("button", { name: "Tentar novamente" }));
    expect(await screen.findByText("Ana Silva")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
