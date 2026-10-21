import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ConfiguracoesPage from "./page";

vi.mock("@/components/layout/header", () => ({ Header: () => <header>Painel SDR</header> }));

const demoCombo = { id: "demo", name: "Combo de teste", models: [
  { modelRef: "gemini-2.5-flash", label: "Gemini", enabled: true },
  { modelRef: "gateway:gpt", label: "GPT reserva", enabled: true },
] };

let admin = true;
let impersonating = false;
const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  let data: object = { success: true };
  if (url === "/api/auth/session") data = { authenticated: true, isAdmin: admin, impersonating };
  else if (url === "/api/ai-organize/config") data = init?.method === "PATCH"
    ? { success: true }
    : { success: true, config: { has_api_key: true, gateway_endpoints: [{ id: "demo", label: "Conta de teste", base_url: "http://localhost:8317/v1", has_api_key: true }], openrouter_keys: [] } };
  else if (url === "/api/ai-combos") data = { success: true, combos: [demoCombo] };
  else if (url === "/api/ai-models") data = { success: true, models: [{ id: "gemini-2.5-flash", name: "Gemini", provider: "gemini" }] };
  else if (url === "/api/gateway-proxy") data = { success: true, status: { installed: false, running: false, accounts: [] } };
  else if (url === "/api/deepseek-chat/manage") data = { success: true, tokens: [], subscriptions: [] };
  else if (url === "/api/settings/lead-intelligence") data = { success: true, model: "gemini-2.5-flash", models: [{ id: "gemini-2.5-flash", name: "Gemini Flash", provider: "gemini" }] };
  else if (url === "/api/settings/embedding-model") data = { success: true, model: "gemini-embedding-001" };
  else if (url === "/api/ai-models/embeddings") data = { success: true, models: [{ id: "gemini-embedding-001", name: "Gemini Embedding", provider: "gemini" }] };
  return { ok: true, json: async () => data } as Response;
});

beforeEach(() => {
  admin = true;
  impersonating = false;
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "alert").mockImplementation(() => {});
  vi.spyOn(window, "confirm").mockReturnValue(false);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function openSettings() {
  render(<ConfiguracoesPage />);
  await screen.findByRole("navigation", { name: "Categorias de configurações" });
}

describe("Configurações: apresentação sem alterar integrações", () => {
  it("mantém as cinco categorias e os rascunhos ao navegar", async () => {
    await openSettings();
    const key = screen.getByLabelText("Substituir chave");
    fireEvent.change(key, { target: { value: "chave-sintetica-nao-enviar" } });
    for (const name of ["WhatsApp", "Contas e conexões", "Modelos de IA", "Backup"]) {
      fireEvent.click(screen.getByRole("button", { name, exact: true }));
      expect(screen.getByRole("button", { name, exact: true }).getAttribute("aria-pressed")).toBe("true");
    }
    expect(screen.getByRole("button", { name: "Acessar Painel de Backup" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Chaves e banco", exact: true }));
    expect((screen.getByLabelText("Substituir chave") as HTMLInputElement).value).toBe("chave-sintetica-nao-enviar");
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("expande seções por botão e preserva o payload de salvar Gemini", async () => {
    await openSettings();
    const toggle = screen.getByRole("button", { name: /Google Gemini API Key/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.change(screen.getByLabelText("Substituir chave"), { target: { value: "  chave-sintetica  " } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar", exact: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/ai-organize/config", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ api_key: "chave-sintetica" }),
    })));
    await waitFor(() => expect((screen.getByLabelText("Substituir chave") as HTMLInputElement).value).toBe(""));
  });

  it.each([{ isAdmin: false, impersonating: false }, { isAdmin: true, impersonating: true }])("preserva a restrição administrativa: %j", async (session) => {
    admin = session.isAdmin;
    impersonating = session.impersonating;
    render(<ConfiguracoesPage />);
    await screen.findByText(/Configurações do sistema estão disponíveis apenas para administradores/);
    expect(screen.queryByRole("navigation", { name: "Categorias de configurações" })).toBeNull();
    expect(screen.queryByLabelText("Substituir chave")).toBeNull();
  });

  it("preserva chaves salvas do Gateway e as ações dos combos", async () => {
    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Contas e conexões", exact: true }));
    await screen.findByRole("combobox", { name: "Adicionar modelo ao combo Combo de teste" });
    fireEvent.change(screen.getByLabelText("Apelido"), { target: { value: "  Novo apelido  " } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar conexões" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/ai-organize/config", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ gateway_endpoints: [{ id: "demo", label: "Novo apelido", base_url: "http://localhost:8317/v1" }], gateway_fallback_model: "" }),
    })));
    fireEvent.click(screen.getByRole("button", { name: "Diminuir prioridade de Gemini" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/ai-combos", expect.objectContaining({
      method: "POST", body: JSON.stringify({ combos: [{ ...demoCombo, models: [...demoCombo.models].reverse() }] }),
    })));
    fireEvent.click(screen.getByRole("button", { name: "Excluir combo Combo de teste" }));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("Excluir o combo"));
    expect(fetchMock.mock.calls.filter(([url, init]) => String(url) === "/api/ai-combos" && init?.method === "POST")).toHaveLength(1);
  });

  it("mantém seleção automática de modelo e confirmação de reindexação", async () => {
    await openSettings();
    fireEvent.click(screen.getByRole("button", { name: "Modelos de IA", exact: true }));
    const model = await screen.findByLabelText("Modelo ativo de Lead Intelligence");
    fireEvent.change(model, { target: { value: "gemini-2.5-flash" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/lead-intelligence", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ model: "gemini-2.5-flash" }),
    })));
    fireEvent.click(screen.getByRole("button", { name: "Re-indexar base agora" }));
    expect(window.confirm).toHaveBeenCalled();
    expect(fetchMock.mock.calls.some(([url]) => String(url) === "/api/agent/reindex-kb")).toBe(false);
  });
});
