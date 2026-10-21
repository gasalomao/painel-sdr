import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/layout/header", () => ({ Header: () => null }));
vi.mock("@/lib/use-session", () => ({ useClientSession: () => ({ clientId: "client-test" }) }));
vi.mock("@/components/media-uploader", () => ({
  MediaUploader: ({ onChange }: { onChange: (file: Record<string, string>) => void }) => (
    <button onClick={() => onChange({ mediaUrl: "https://example.com/test.png", mediaType: "image", mediaFileName: "test.png", mediaMimetype: "image/png" })}>Anexar arquivo de teste</button>
  ),
}));
vi.mock("@/components/lead-intelligence-batch", () => ({ LeadIntelligenceBatch: () => <span>Inteligência dos leads</span> }));
vi.mock("@/components/ai-module-shared", () => ({ ModelOptions: () => <option value="modelo-teste">Modelo de teste</option> }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (table: string) => {
      const result = { data: table === "channel_connections" ? [{ instance_name: "Comercial" }] : table === "leads_extraidos" ? [{ id: 7, remoteJid: "5527999990000@s.whatsapp.net", nome_negocio: "Empresa de teste", ramo_negocio: "Serviços", status: "novo" }] : [] };
      const query = { select: () => query, eq: () => query, order: () => query, in: () => query, limit: () => query, then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve) };
      return query;
    },
    channel: () => { const channel = { on: () => channel, subscribe: () => channel }; return channel; },
    removeChannel: vi.fn(),
  },
}));

import DisparoPage from "@/app/disparo/page";

const fetchMock = vi.fn<typeof fetch>();
const campaign = {
  id: "campaign-test", name: "Campanha de teste", instance_name: "Comercial", message_template: "Olá, {{nome_empresa}}!",
  status: "paused", total_targets: 3, sent_count: 1, failed_count: 0, min_interval_seconds: 35, max_interval_seconds: 70,
  allowed_start_hour: 8, allowed_end_hour: 19, created_at: "2026-10-21T12:00:00Z", humanize_messages: true,
  personalize_with_ai: false, use_web_search: false, ai_model: null, ai_prompt: null,
  media_url: "https://example.com/original.pdf", media_type: "document", media_caption: "Apresentação", media_file_name: "original.pdf", media_mimetype: "application/pdf",
};

function mockRequests(campaigns: Record<string, unknown>[] = []): void {
  fetchMock.mockImplementation(async (input, init) => {
    if (init?.method === "POST" || init?.method === "PATCH") return Response.json({ success: true, campaign: { id: "new-campaign", total_targets: 1 } });
    if (input === "/api/auth/session") return Response.json({ authenticated: true, clientId: "client-test", isAdmin: true });
    if (input === "/api/campaigns") return Response.json({ success: true, campaigns });
    if (input === "/api/ai-models") return Response.json({ success: true, models: [{ id: "modelo-teste", name: "Modelo de teste" }] });
    if (String(input).startsWith("/api/campaigns/")) return Response.json({ success: true, targets: [{ id: "target-test", nome_negocio: "Empresa de teste", remote_jid: "5527999990000@s.whatsapp.net", status: "sent", rendered_message: "Olá, Empresa de teste!" }] });
    return Response.json({ success: true, instances: [{ instanceName: "Comercial" }] });
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  localStorage.clear();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(window, "alert").mockImplementation(() => {});
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await act(async () => {});
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("interface de disparo sem mudança do contrato", () => {
  it("cria com destinatários, template, ritmo, IA, humanização e mídia; só inicia quando solicitado", async () => {
    mockRequests();
    render(<DisparoPage />);
    fireEvent.click(screen.getByRole("button", { name: "Nova campanha", exact: true }));
    fireEvent.change(screen.getByLabelText("Nome da campanha"), { target: { value: "Nova campanha de teste" } });
    await waitFor(() => expect(screen.getByLabelText("Conta do WhatsApp")).not.toBeDisabled());
    fireEvent.change(screen.getByLabelText("Conta do WhatsApp"), { target: { value: "Comercial" } });
    fireEvent.change(screen.getByLabelText("Mensagem-base"), { target: { value: "Olá, {{nome_empresa}}!" } });
    fireEvent.click(await screen.findByRole("checkbox", { name: "Selecionar Empresa de teste" }));
    expect(screen.getByRole("status")).toHaveTextContent("1 contato selecionado");
    expect(screen.getByText("Olá, Empresa de teste!")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Intervalo mínimo (segundos)"), { target: { value: "40" } });
    fireEvent.change(screen.getByLabelText("Intervalo máximo (segundos)"), { target: { value: "80" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Humanizar disparo", exact: true }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Personalizar mensagem com IA", exact: true }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Pesquisar empresa na internet", exact: true }));
    fireEvent.change(screen.getByLabelText("Prompt da personalização"), { target: { value: "Seja breve e profissional." } });
    fireEvent.click(screen.getByRole("button", { name: "Anexar arquivo de teste" }));
    fireEvent.change(screen.getByLabelText("Legenda da mídia"), { target: { value: "Conheça nosso trabalho" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar e iniciar (1 lead)", exact: true }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2));
    const posts = fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts[0][0]).toBe("/api/campaigns");
    expect(JSON.parse(String(posts[0][1]?.body))).toMatchObject({
      name: "Nova campanha de teste", instance_name: "Comercial", message_template: "Olá, {{nome_empresa}}!", lead_ids: [7],
      min_interval_seconds: 40, max_interval_seconds: 80, allowed_start_hour: 9, allowed_end_hour: 20,
      humanize_messages: true, personalize_with_ai: true, use_web_search: true, ai_model: "modelo-teste", ai_prompt: "Seja breve e profissional.",
      media_url: "https://example.com/test.png", media_type: "image", media_caption: "Conheça nosso trabalho", media_file_name: "test.png", media_mimetype: "image/png",
    });
    expect(posts[1][0]).toBe("/api/campaigns/new-campaign");
    expect(JSON.parse(String(posts[1][1]?.body))).toEqual({ action: "start" });
  });

  it("edita preservando destinatários, campos e anexos; salvar rascunho não inicia o envio", async () => {
    mockRequests([campaign]);
    render(<DisparoPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Editar Campanha de teste" }));
    expect(screen.getByRole("checkbox", { name: "Humanizar disparo", exact: true })).toBeChecked();
    expect(screen.queryByRole("checkbox", { name: "Selecionar Empresa de teste" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Mensagem-base"), { target: { value: "Mensagem revisada" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar rascunho", exact: true }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1));
    const [url, init] = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    const payload = JSON.parse(String(init?.body));
    expect(url).toBe("/api/campaigns/campaign-test");
    expect(payload).not.toHaveProperty("lead_ids");
    expect(payload).toMatchObject({ message_template: "Mensagem revisada", min_interval_seconds: 35, max_interval_seconds: 70, allowed_start_hour: 8, allowed_end_hour: 19, humanize_messages: true, media_url: campaign.media_url, media_caption: "Apresentação", media_type: "document" });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("mantém retomar, histórico e exclusão; histórico não contém controles do formulário", async () => {
    mockRequests([campaign]);
    render(<DisparoPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Retomar", exact: true }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/campaigns/campaign-test", expect.objectContaining({ method: "POST", body: JSON.stringify({ action: "start" }) })));
    fireEvent.click(screen.getByRole("button", { name: "Ver mensagens enviadas (1/3)" }));
    expect(await screen.findByText("Olá, Empresa de teste!")).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Humanizar disparo", exact: true })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Anexar arquivo de teste" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Excluir Campanha de teste" }));
    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/campaigns/campaign-test", { method: "DELETE" }));
  });
});
