import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/layout/header", () => ({ Header: () => null }));
vi.mock("@/app/automacao/AutomationLogs", () => ({ AutomationLogs: () => null }));
vi.mock("@/components/media-uploader", () => ({ MediaUploader: () => null }));
vi.mock("@/components/lead-intelligence-batch", () => ({ LeadIntelligenceBatch: () => null }));
vi.mock("@/components/ai-module-shared", () => ({ ModelOptions: () => null }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({ select: () => ({ order: async () => ({ data: [] }) }) }),
    channel: () => {
      const channel = { on: () => channel, subscribe: () => channel };
      return channel;
    },
    removeChannel: vi.fn(),
  },
}));

import AutomacaoPage from "@/app/automacao/page";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "alert").mockImplementation(() => {});
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

afterEach(async () => {
  await act(async () => {});
  cleanup();
  vi.unstubAllGlobals();
});

describe("edição da automação com checkpoints de captura", () => {
  it.each([
    { source: "prospeccao-sites", count: 2, sessionId: null, reviews: { enabled: false } },
    { source: "origem-invalida", count: 0, sessionId: "session-1", reviews: { enabled: true, model: "modelo-teste", prompt: "Resuma as avaliações" } },
  ])("envia só filtros públicos e a origem permitida ($source) ao editar o disparo", async ({ source, count, sessionId, reviews }) => {
    const publicFilters = {
      filterEmpty: true,
      filterDuplicates: false,
      filterLandlines: false,
      filterWithWebsite: true,
      filterWithInstagram: true,
      minReviews: 25,
      captureAllReviews: reviews.enabled,
      reviews_ai: reviews,
    };
    const runtimeFilters = {
      ...publicFilters,
      _source: source,
      _captureSessionId: sessionId,
      _capturedLeadIds: [11, 12],
      _captureRetryAt: "2026-10-19T12:00:00Z",
      _futureMarker: { cursor: 4 },
    };
    const originalFilters = structuredClone(runtimeFilters);
    const automation = {
      id: "auto-1",
      name: "Padarias",
      instance_name: "whatsapp-A",
      status: "paused",
      phase: "paused",
      niches: ["padaria"],
      regions: ["Vitória/ES"],
      scrape_max_leads: 20,
      scraped_count: count,
      scrape_filters: runtimeFilters,
      dispatch_template: "Mensagem anterior",
      followup_enabled: false,
      followup_steps: [],
    };
    let finishModels!: (response: Response) => void;
    const modelsResponse = new Promise<Response>(resolve => { finishModels = resolve; });
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "PATCH") return Response.json({ success: true });
      if (input === "/api/ai-models") return modelsResponse;
      if (input === "/api/auth/session") return Response.json({ authenticated: true });
      if (input === "/api/automations") return Response.json({ success: true, automations: [automation] });
      return Response.json({ success: true, instances: [], models: [] });
    });
    render(<AutomacaoPage />);
    fireEvent.click(await screen.findByTitle("Editar automação"));
    expect(screen.getByRole("checkbox", { name: "Pular sem telefone" })).toBeDisabled();
    expect(screen.getByText("A captura já foi iniciada. Crie outra automação para mudar nichos, regiões, filtros ou meta.")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("Ex: {{saudacao}} {{nome_empresa}}! Vi vocês no Maps…"), {
      target: { value: "Mensagem revisada" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar Rascunho" }));

    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1));
    const [url, init] = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(url).toBe("/api/automations/auto-1");
    expect(payload).toMatchObject({
      dispatch_template: "Mensagem revisada",
      niches: automation.niches,
      regions: automation.regions,
      scrape_max_leads: automation.scrape_max_leads,
    });
    expect(payload.scrape_filters).toEqual({
      ...publicFilters,
      ...(source === "prospeccao-sites" ? { _source: source } : {}),
    });
    expect(runtimeFilters).toEqual(originalFilters);
    await act(async () => finishModels(Response.json({ success: true, models: [{ id: "modelo-atrasado" }] })));
    await waitFor(() => expect(screen.queryByText("Editando automação")).not.toBeInTheDocument());
  });

  it("bloqueia salvar enquanto a automação está rodando e orienta pausar", async () => {
    fetchMock.mockImplementation(async (input) => {
      if (input === "/api/auth/session") return Response.json({ authenticated: true });
      if (input === "/api/automations") return Response.json({ success: true, automations: [{
        id: "auto-1", name: "Padarias", instance_name: "whatsapp-A", status: "running", phase: "scraping",
        scraped_count: 0, scrape_filters: {}, niches: ["padaria"], regions: ["Vitória/ES"],
      }] });
      return Response.json({ success: true, instances: [], models: [] });
    });
    render(<AutomacaoPage />);
    fireEvent.click(await screen.findByTitle("Editar automação"));

    const save = screen.getByRole("button", { name: "Salvar Rascunho" });
    expect(save).toBeDisabled();
    expect(screen.getByRole("button", { name: "Salvar e Iniciar" })).toBeDisabled();
    expect(screen.getByText("Pause a automação antes de editar e salvar a configuração.")).toBeInTheDocument();
    fireEvent.click(save);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
  });
});
