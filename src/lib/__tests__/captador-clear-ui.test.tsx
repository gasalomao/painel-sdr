import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/layout/header", () => ({ Header: () => null }));
import CaptadorPage from "@/app/captador/page";

const fetchMock = vi.fn<typeof fetch>();
let emit: (data: Record<string, unknown>) => void;
const lead = { name: "Dentista offline", phones: "11999990000", fullAddress: "Rua Offline", categories: "Dentista",
  averageRating: "4.9", reviewCount: "100", website: "", instagram: "", facebook: "", extractedAt: "offline" };

beforeEach(() => {
  fetchMock.mockReset().mockResolvedValue(Response.json({ leads: [lead] }));
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("EventSource", class {
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    constructor() { emit = data => this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) })); }
    close() {}
  });
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function openLeads(): Promise<HTMLElement> {
  render(<CaptadorPage />);
  fireEvent.click(screen.getByRole("button", { name: /Leads & Console/ }));
  await screen.findByText("1 clientes");
  return screen.getByRole("button", { name: "Limpar", exact: true });
}

describe("limpeza segura no Captador", () => {
  it("bloqueia limpeza durante captura e pausa sem modificar a lista", async () => {
    const button = await openLeads();
    act(() => emit({ event: "status", isScraping: true, isPaused: false }));
    expect(button).toBeDisabled();
    act(() => emit({ event: "status", isScraping: true, isPaused: true }));
    expect(button).toBeDisabled();
    expect(screen.getByText("1 clientes")).toBeInTheDocument();
    act(() => emit({ event: "status", isScraping: false, isPaused: false }));
    expect(button).toBeEnabled();
  });

  it.each(["http", "conexão"])("preserva a lista se limpeza falha por %s", async failure => {
    const button = await openLeads();
    if (failure === "http") fetchMock.mockResolvedValueOnce(Response.json({ error: "Ocupado" }, { status: 409 }));
    else fetchMock.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await act(async () => {});
    expect(screen.getByText("1 clientes")).toBeInTheDocument();
    expect(button).toBeEnabled();
  });

  it("limpa a lista somente após confirmação HTTP", async () => {
    const button = await openLeads();
    fetchMock.mockResolvedValueOnce(Response.json({ success: true }));
    fireEvent.click(button);
    await screen.findByText("0 clientes");
    expect(button).toBeDisabled();
    expect(fetchMock).toHaveBeenLastCalledWith("/api/scraper", expect.objectContaining({ body: JSON.stringify({ action: "clear" }) }));
  });
});
