import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import WhatsAppPage from "../page";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
}));

vi.mock("@/components/layout/header", () => ({ Header: () => <header>WhatsApp</header> }));
vi.mock("@/lib/use-session", () => ({ useClientSession: () => ({ clientId: "demo1" }) }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      let mutation = false;
      const query = {
        select: () => query,
        order: () => query,
        eq: (column: string, value: unknown) => { mocks.eq(column, value); return query; },
        update: (value: unknown) => { mutation = true; mocks.update(value); return query; },
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({
          data: mutation ? null : table === "channel_connections"
            ? [{ id: "connection-1", instance_name: "demo1_suporte", agent_id: 1, status: "close", provider: "evolution" }]
            : [{ id: 1, name: "Comercial" }, { id: 2, name: "Suporte" }],
          error: null,
        }).then(resolve),
      };
      return query;
    },
  },
}));

beforeEach(() => {
  mocks.fetch.mockReset();
  mocks.update.mockClear();
  mocks.eq.mockClear();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.fetch.mockImplementation(async (input: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as { action?: string } : {};
    const data = input.includes("/proxy") ? { success: true, proxy: { enabled: false } }
      : input.includes("/config/ngrok") ? { url: "https://painel.exemplo.test" }
      : body.action === "connect" ? { success: true, qrCode: "data:image/png;base64,cXI=" }
      : input.includes("/instance/delete") ? { ok: true, deleted: {}, evolution: true }
      : { success: true, state: "close" };
    return new Response(JSON.stringify(data));
  });
  vi.spyOn(window, "alert").mockImplementation(() => {});
  vi.spyOn(window, "confirm").mockReturnValue(false);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("WhatsApp — apresentação preserva os fluxos existentes", () => {
  it("gera o QR da conexão correta e mantém o seletor de agente acessível", async () => {
    render(<WhatsAppPage />);
    const select = await screen.findByLabelText("Agente responsável");
    fireEvent.change(select, { target: { value: "2" } });
    await waitFor(() => expect(mocks.update).toHaveBeenCalledWith({ agent_id: 2 }));
    expect(mocks.eq).toHaveBeenCalledWith("client_id", "demo1");
    fireEvent.click(await screen.findByRole("button", { name: "Conectar com QR Code" }));
    expect(await screen.findByAltText("QR Code para conectar demo1_suporte")).toBeTruthy();
    expect(mocks.fetch).toHaveBeenCalledWith("/api/whatsapp", expect.objectContaining({
      method: "POST", body: JSON.stringify({ action: "connect", instanceName: "demo1_suporte" }),
    }));
  });

  it("mantém manutenção e as duas confirmações de exclusão com histórico preservado por padrão", async () => {
    render(<WhatsAppPage />);
    await screen.findByLabelText("Agente responsável");
    const summary = screen.getByText("Gerenciar conexão");
    const disclosure = summary.closest("details");
    expect(disclosure?.open).toBe(false);
    fireEvent.click(summary);
    for (const name of ["Sincronizar fotos", "Sincronizar webhook", "Diagnosticar webhook", "Configurar proxy", "Reiniciar instância", "Desconectar"]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("button", { name: "Excluir conexão" }));
    expect(mocks.fetch.mock.calls.some(([url]) => String(url).includes("/instance/delete"))).toBe(false);
    vi.mocked(window.confirm).mockReturnValueOnce(true).mockReturnValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Excluir conexão" }));
    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledWith("/api/whatsapp/instance/delete", expect.objectContaining({
      method: "POST", body: JSON.stringify({ instanceName: "demo1_suporte", force: true, purgeMessages: false }),
    })));
  });

  it("mantém Cloud, validação e campos rotulados sem chamar o serviço ao abrir", async () => {
    render(<WhatsAppPage />);
    await screen.findByLabelText("Agente responsável");
    fireEvent.click(screen.getByRole("button", { name: "Nova conexão Cloud" }));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByLabelText("Phone Number ID *")).toBeTruthy();
    expect(screen.getByLabelText("Access Token *").getAttribute("type")).toBe("password");
    fireEvent.click(screen.getByRole("button", { name: "Salvar", exact: true }));
    expect(await screen.findByText("Nome da conexão, phone_number_id e access_token são obrigatórios.")).toBeTruthy();
    expect(mocks.fetch.mock.calls.some(([url]) => url === "/api/whatsapp/cloud")).toBe(false);
  });
});
