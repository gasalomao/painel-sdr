import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LoginPage from "./page";

const navigation = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), from: "/leads" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: navigation.push, refresh: navigation.refresh }),
  useSearchParams: () => new URLSearchParams({ from: navigation.from }),
}));
beforeEach(() => { navigation.from = "/leads"; vi.clearAllMocks(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function fillCredentials(): void {
  fireEvent.change(screen.getByLabelText("Usuário ou e-mail"), { target: { value: "  Operador@Empresa.com  " } });
  fireEvent.change(screen.getByLabelText("Senha", { exact: true }), { target: { value: "senha-teste" } });
}

describe("login", () => {
  it("associa os labels e permite consultar a senha sem enviar o formulário", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    render(<LoginPage />);
    expect(screen.getByLabelText("Usuário ou e-mail")).toHaveAttribute("autocomplete", "username");
    const password = screen.getByLabelText("Senha", { exact: true });
    expect(password).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Mostrar senha" }));
    expect(password).toHaveAttribute("type", "text");
    fireEvent.click(screen.getByRole("button", { name: "Ocultar senha" }));
    expect(password).toHaveAttribute("type", "password");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserva payload, evento de sessão, redirecionamento e atualização após entrar", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const sessionChanged = vi.fn();
    window.addEventListener("session-changed", sessionChanged, { once: true });
    render(<LoginPage />);
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/leads"));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "operador@empresa.com", password: "senha-teste" }),
    });
    expect(sessionChanged).toHaveBeenCalledOnce();
    expect(navigation.refresh).toHaveBeenCalledOnce();
  });

  it("anuncia erro da API e mantém as credenciais para uma nova tentativa", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "Credenciais inválidas" }) }));
    render(<LoginPage />);
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Credenciais inválidas");
    expect(screen.getByLabelText("Senha", { exact: true })).toHaveValue("senha-teste");
    expect(screen.getByRole("button", { name: "Entrar" })).toBeEnabled();
    expect(navigation.push).not.toHaveBeenCalled();
  });

  it("mostra carregamento e não permite novo envio durante a requisição", async () => {
    let finish!: (value: unknown) => void;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise((resolve) => { finish = resolve; })));
    render(<LoginPage />);
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    expect(screen.getByRole("button", { name: "Entrando…" })).toBeDisabled();
    finish({ ok: false, json: async () => ({ error: "Tente novamente" }) });
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Entrar" })).toBeEnabled();
  });

  it("apresenta erro de conexão sem perder os dados digitados", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Sem conexão")));
    render(<LoginPage />);
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Sem conexão");
    expect(screen.getByRole("button", { name: "Entrar" })).toBeEnabled();
  });

  it("preserva a proteção contra retorno para o próprio login", async () => {
    navigation.from = "/login?from=/leads";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) }));
    render(<LoginPage />);
    fillCredentials();
    fireEvent.click(screen.getByRole("button", { name: "Entrar" }));
    await waitFor(() => expect(navigation.push).toHaveBeenCalledWith("/"));
  });
});
