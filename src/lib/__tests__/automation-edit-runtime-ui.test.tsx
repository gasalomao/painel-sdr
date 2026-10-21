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
const minimumLabel = "Mínimo de avaliações no Google";
const minimumHelper = "Quantidade de pessoas que deram estrelas, com ou sem comentário. Não filtra pela nota. 0 = sem mínimo.";
const minimumError = "Informe um inteiro entre 0 e 2147483647.";
const instagramHelper = "Exige perfil informado no Google Maps; não busca no site.";
const editableAutomation = {
  id: "auto-1", name: "Padarias", instance_name: "whatsapp-A", status: "paused", phase: "idle",
  niches: ["padaria"], regions: ["Vitória/ES"], scrape_max_leads: 20, scraped_count: 0,
  scrape_filters: {
    filterEmpty: false, filterDuplicates: false, filterLandlines: false,
    filterWithInstagram: true, filterWithWebsite: true, minReviews: 40,
    captureAllReviews: false, reviews_ai: { enabled: false, model: "modelo-teste", prompt: null },
    futurePublicFilter: { mode: "preservar" },
  },
  dispatch_template: "Mensagem anterior", followup_enabled: false, followup_steps: [],
};

function mockAutomationRequests(automations: Record<string, unknown>[] = []): void {
  fetchMock.mockImplementation(async (input, init) => {
    if (init?.method === "POST" || init?.method === "PATCH") {
      return Response.json({ success: true, automation: { id: "nova" } });
    }
    if (input === "/api/auth/session") return Response.json({ authenticated: true });
    if (input === "/api/automations") return Response.json({ success: true, automations });
    return Response.json({ success: true, instances: [], models: [{ id: "modelo-teste" }] });
  });
}

async function openCaptureForm(mode: "create" | "edit"): Promise<void> {
  mockAutomationRequests(mode === "edit" ? [editableAutomation] : []);
  render(<AutomacaoPage />);
  if (mode === "edit") {
    fireEvent.click(await screen.findByTitle("Editar automação"));
  } else {
    fireEvent.click(await screen.findByRole("button", { name: "Nova automação" }));
    fireEvent.change(screen.getByLabelText("Nome da automação"), { target: { value: "Nova captura" } });
    const instanceSelect = screen.getByLabelText("Instância WhatsApp");
    const option = document.createElement("option");
    option.value = "whatsapp-A";
    instanceSelect.appendChild(option);
    fireEvent.change(instanceSelect, { target: { value: "whatsapp-A" } });
  }
  fireEvent.click(screen.getByRole("button", { name: /Captação e análise/ }));
}

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
      futurePublicFilter: { mode: "preservar" },
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
    fireEvent.click(screen.getByRole("button", { name: /Captação e análise/ }));
    expect(screen.getByRole("checkbox", { name: "Pular sem telefone" })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Pular duplicados" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Pular fixos" })).not.toBeChecked();
    expect(screen.getByRole("spinbutton", { name: minimumLabel })).toHaveValue(25);
    expect(screen.getByRole("spinbutton", { name: minimumLabel })).toBeDisabled();
    expect(screen.getByRole("spinbutton", { name: "Limite de leads" })).toHaveValue(20);
    expect(screen.getByRole("spinbutton", { name: "Limite de leads" })).toBeDisabled();
    for (const name of ["Somente com Instagram", "Capturar somente leads sem site"]) {
      expect(screen.getByRole("checkbox", { name })).toBeChecked();
      expect(screen.getByRole("checkbox", { name })).toBeDisabled();
    }
    const captureReviews = screen.getByRole("checkbox", { name: "Capturar todas as avaliações", exact: true });
    const reviewsAi = screen.getByRole("checkbox", { name: /Resumir avaliações do Google com IA/ });
    expect(captureReviews).toBeDisabled();
    expect(reviewsAi).toBeDisabled();
    expect(captureReviews).toHaveProperty("checked", reviews.enabled);
    expect(reviewsAi).toHaveProperty("checked", reviews.enabled);
    if (reviews.enabled) {
      expect(screen.getByLabelText("Modelo de IA das avaliações")).toHaveValue("modelo-teste");
      expect(screen.getByLabelText("Modelo de IA das avaliações")).toBeDisabled();
      expect(screen.getByLabelText(/Prompt das avaliações/)).toHaveValue("Resuma as avaliações");
      expect(screen.getByLabelText(/Prompt das avaliações/)).toBeDisabled();
    }
    expect(screen.getByText("A captura já foi iniciada. Crie outra automação para mudar nichos, regiões, filtros ou meta.")).toBeInTheDocument();
    await act(async () => finishModels(Response.json({ success: true, models: [{ id: "modelo-atrasado" }] })));
    if (reviews.enabled) expect(screen.getByLabelText("Modelo de IA das avaliações")).toHaveValue("modelo-teste");
    fireEvent.click(screen.getByRole("button", { name: /Mensagem inicial/ }));
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
    await waitFor(() => expect(screen.queryByText("Editando automação")).not.toBeInTheDocument());
  });

  it("não injeta defaults nem normaliza filtros legados de uma captura bloqueada", async () => {
    const scrapeFilters = {
      minReviews: "legado", reviews_ai: { enabled: true, prompt: "Não alterar" },
      futurePublicFilter: { mode: "preservar" }, _captureSessionId: "session-legada", _futureMarker: 7,
    };
    mockAutomationRequests([{ ...editableAutomation, scrape_filters: scrapeFilters }]);
    render(<AutomacaoPage />);
    fireEvent.click(await screen.findByTitle("Editar automação"));
    fireEvent.click(screen.getByRole("button", { name: /Captação e análise/ }));
    expect(screen.getByRole("spinbutton", { name: minimumLabel })).toBeDisabled();
    for (const name of ["Pular sem telefone", "Pular duplicados", "Pular fixos", "Somente com Instagram", "Capturar somente leads sem site", "Capturar todas as avaliações"]) {
      expect(screen.getByRole("checkbox", { name, exact: true })).not.toBeChecked();
      expect(screen.getByRole("checkbox", { name, exact: true })).toBeDisabled();
    }
    expect(screen.getByRole("checkbox", { name: /Resumir avaliações do Google com IA/ })).toBeChecked();
    expect(screen.getByLabelText("Modelo de IA das avaliações")).toHaveValue("");
    expect(screen.getByLabelText("Modelo de IA das avaliações")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Salvar Rascunho" }));

    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1));
    const [, init] = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(JSON.parse(String(init?.body)).scrape_filters).toEqual({
      minReviews: "legado", reviews_ai: { enabled: true, prompt: "Não alterar" },
      futurePublicFilter: { mode: "preservar" },
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("oferece os filtros acessíveis e mantém os defaults e a explicação de continuidade", async () => {
    await openCaptureForm("create");
    const minimum = screen.getByRole("spinbutton", { name: minimumLabel });
    expect(minimum).toHaveValue(0);
    expect(minimum).toHaveAttribute("min", "0");
    expect(minimum).toHaveAttribute("step", "1");
    expect(minimum).toHaveAttribute("max", "2147483647");
    expect(minimum).toHaveAccessibleDescription(minimumHelper);
    const instagram = screen.getByRole("checkbox", { name: "Somente com Instagram" });
    expect(instagram).not.toBeChecked();
    expect(instagram).toHaveAccessibleDescription(instagramHelper);
    expect(screen.getByRole("checkbox", { name: "Capturar somente leads sem site" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Capturar todas as avaliações", exact: true })).not.toBeChecked();
    for (const name of ["Pular sem telefone", "Pular duplicados", "Pular fixos"]) {
      expect(screen.getByRole("checkbox", { name })).toBeChecked();
    }
    expect(screen.getByRole("spinbutton", { name: "Limite de leads" })).toHaveValue(100);
    expect(screen.getByText(/somente leads elegíveis e salvos contam/i)).toHaveTextContent(/continua.*abaixo da meta/i);
    fireEvent.click(screen.getByRole("button", { name: "Salvar Rascunho" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1));
    const [, init] = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      scrape_max_leads: 100,
      scrape_filters: {
        filterEmpty: true, filterDuplicates: true, filterLandlines: true,
        minReviews: 0, filterWithInstagram: false, filterWithWebsite: false,
        captureAllReviews: false, reviews_ai: { enabled: false },
      },
    });
  });

  it.each(["create", "edit"] as const)("persiste os filtros da referência ao salvar no modo %s", async mode => {
    await openCaptureForm(mode);
    if (mode === "edit") {
      expect(screen.getByRole("spinbutton", { name: minimumLabel })).toHaveValue(40);
      expect(screen.getByRole("checkbox", { name: "Somente com Instagram" })).toBeChecked();
      expect(screen.getByRole("checkbox", { name: "Capturar somente leads sem site" })).toBeChecked();
    }
    fireEvent.change(screen.getByRole("spinbutton", { name: minimumLabel }), { target: { value: "25" } });
    const filters = [
      ["Pular sem telefone", true], ["Pular duplicados", false], ["Pular fixos", false],
      ["Somente com Instagram", true], ["Capturar somente leads sem site", true],
    ] as const;
    for (const [name, checked] of filters) {
      const checkbox = screen.getByRole("checkbox", { name }) as HTMLInputElement;
      if (checkbox.checked !== checked) fireEvent.click(checkbox);
    }
    fireEvent.change(screen.getByRole("spinbutton", { name: "Limite de leads" }), { target: { value: "50" } });
    fireEvent.click(screen.getByRole("button", { name: /Horários e revisão/ }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar Rascunho" }));

    const method = mode === "edit" ? "PATCH" : "POST";
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === method)).toHaveLength(1));
    const [url, init] = fetchMock.mock.calls.find(([, init]) => init?.method === method)!;
    const payload = JSON.parse(String(init?.body));
    expect(url).toBe(mode === "edit" ? "/api/automations/auto-1" : "/api/automations");
    expect(payload).toMatchObject({
      scrape_max_leads: 50,
      scrape_filters: {
        minReviews: 25, filterWithInstagram: true, filterWithWebsite: true,
        filterEmpty: true, filterDuplicates: false, filterLandlines: false,
        captureAllReviews: false, reviews_ai: { enabled: false },
      },
    });
    if (mode === "edit") expect(payload.scrape_filters.futurePublicFilter).toEqual({ mode: "preservar" });
  });

  it.each((["create", "edit"] as const).flatMap(mode => ["0", "25", "2147483647"].map(value => ({ mode, value }))))(
    "aceita mínimo $value sem ativar avaliações/IA no modo $mode", async ({ mode, value }) => {
      await openCaptureForm(mode);
      fireEvent.change(screen.getByRole("spinbutton", { name: minimumLabel }), { target: { value } });
      fireEvent.click(screen.getByRole("button", { name: "Salvar Rascunho" }));
      const method = mode === "edit" ? "PATCH" : "POST";
      await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === method)).toHaveLength(1));
      const [, init] = fetchMock.mock.calls.find(([, init]) => init?.method === method)!;
      expect(JSON.parse(String(init?.body)).scrape_filters).toMatchObject({
        minReviews: Number(value), captureAllReviews: false, reviews_ai: { enabled: false },
      });
    },
  );

  it.each((["create", "edit"] as const).flatMap(mode => ["", "-1", "1.5", "2147483648", "1e309", "abc"].map(value => ({ mode, value }))))(
    "bloqueia mínimo inválido '$value' de outra etapa e limpa o erro ao corrigir no modo $mode", async ({ mode, value }) => {
      await openCaptureForm(mode);
      const minimum = screen.getByRole("spinbutton", { name: minimumLabel });
      fireEvent.change(minimum, { target: { value } });
      fireEvent.click(screen.getByRole("button", { name: /Mensagem inicial/ }));
      fireEvent.click(screen.getByRole("button", { name: "Salvar Rascunho" }));
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST" || init?.method === "PATCH")).toHaveLength(0);
      expect(screen.getByRole("region", { name: "Captação e análise" })).toBeVisible();
      expect(minimum).toHaveAttribute("aria-invalid", "true");
      expect(minimum).toHaveAccessibleDescription(`${minimumHelper} ${minimumError}`);
      expect(screen.getByRole("alert")).toHaveTextContent(minimumError);
      expect(screen.getByRole("checkbox", { name: "Capturar todas as avaliações", exact: true })).not.toBeChecked();
      expect(screen.getByRole("checkbox", { name: /Resumir avaliações do Google com IA/ })).not.toBeChecked();
      fireEvent.click(screen.getByRole("button", { name: /Mensagem inicial/ }));
      fireEvent.click(screen.getByRole("button", { name: "Salvar e Iniciar" }));
      expect(screen.getByRole("region", { name: "Captação e análise" })).toBeVisible();
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST" || init?.method === "PATCH")).toHaveLength(0);
      fireEvent.change(minimum, { target: { value: "25" } });
      expect(minimum).toHaveAttribute("aria-invalid", "false");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Salvar Rascunho" }));
      const method = mode === "edit" ? "PATCH" : "POST";
      await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === method)).toHaveLength(1));
    },
  );

  it.each([false, true])("permite avaliações completas com IA=%s sem acoplar os demais filtros", async withAi => {
    await openCaptureForm("create");
    const fullReviews = screen.getByRole("checkbox", { name: "Capturar todas as avaliações", exact: true });
    const reviewsAi = screen.getByRole("checkbox", { name: /Resumir avaliações do Google com IA/ });
    fireEvent.click(fullReviews);
    expect(fullReviews).toBeChecked();
    expect(reviewsAi).not.toBeChecked();
    fireEvent.click(fullReviews);
    expect(fullReviews).not.toBeChecked();
    fireEvent.click(reviewsAi);
    expect(fullReviews).toBeChecked();
    fireEvent.change(screen.getByLabelText(/Prompt das avaliações/), { target: { value: "Resuma elogios e reclamações" } });
    if (!withAi) fireEvent.click(reviewsAi);
    expect(fullReviews).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: minimumLabel })).toHaveValue(0);
    expect(screen.getByRole("checkbox", { name: "Somente com Instagram" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Salvar Rascunho" }));

    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1));
    const [, init] = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(init?.body)).scrape_filters).toMatchObject({
      captureAllReviews: true,
      reviews_ai: { enabled: withAi, model: "modelo-teste", prompt: "Resuma elogios e reclamações" },
    });
  });

  it("preserva todos os ajustes ao navegar pelas etapas e criar um rascunho", async () => {
    fetchMock.mockImplementation(async (input, init) => {
      if (init?.method === "POST") return Response.json({ success: true, automation: { id: "nova" } });
      if (input === "/api/auth/session") return Response.json({ authenticated: true, isAdmin: true });
      if (input === "/api/automations") return Response.json({ success: true, automations: [] });
      return Response.json({ success: true, instances: [], models: [{ id: "modelo-teste" }] });
    });
    render(<AutomacaoPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Nova automação" }));
    fireEvent.change(screen.getByLabelText("Nome da automação"), { target: { value: "Teste por etapas" } });
    const instanceSelect = screen.getByLabelText("Instância WhatsApp");
    const option = document.createElement("option");
    option.value = "whatsapp-teste";
    instanceSelect.appendChild(option);
    fireEvent.change(instanceSelect, { target: { value: "whatsapp-teste" } });

    fireEvent.click(screen.getByRole("button", { name: /Captação e análise/ }));
    fireEvent.change(screen.getByLabelText(/Nichos/), { target: { value: "padaria artesanal\ncafeteria" } });
    fireEvent.change(screen.getByLabelText(/Regiões/), { target: { value: "Vitória/ES" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Ativar Lead Intelligence/ }));

    fireEvent.click(screen.getByRole("button", { name: /Mensagem inicial/ }));
    fireEvent.change(screen.getByLabelText("Mensagem-base (template)"), { target: { value: "Olá " } });
    fireEvent.click(screen.getByRole("button", { name: /Empresa.*nome_empresa/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Humanizar disparo/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Reescrever cada mensagem/ }));
    expect(screen.getByLabelText("Modelo de IA do disparo")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^4.*Follow-up/ }));
    fireEvent.click(screen.getByRole("button", { name: "Adicionar etapa" }));
    expect(screen.getAllByLabelText(/Mensagem do follow-up/)).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Remover follow-up 3" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Ativar follow-up automático/ }));

    fireEvent.click(screen.getByRole("button", { name: /Horários e revisão/ }));
    fireEvent.change(screen.getByLabelText("Horário inicial"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: /Identificação/ }));
    expect(screen.getByLabelText("Nome da automação")).toHaveValue("Teste por etapas");
    fireEvent.click(screen.getByRole("button", { name: "Salvar Rascunho" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const [, init] = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      name: "Teste por etapas", instance_name: "whatsapp-teste", niches: ["padaria artesanal", "cafeteria"],
      regions: ["Vitória/ES"], dispatch_template: "Olá {{nome_empresa}}", dispatch_humanize: true,
      dispatch_personalize: true, lead_intelligence_enabled: true, followup_enabled: false,
      allowed_start_hour: 10, followup_steps: [{ day_offset: 2 }, { day_offset: 5 }],
    });
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
