import React from "react";
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import LeadsPage from "@/app/leads/page";
import { toast } from "sonner";
import * as photoSync from "@/lib/lead-photo-sync";

const session = vi.hoisted(() => ({ clientId: "client-test-123" }));
vi.mock("@/lib/use-session", () => ({
  useClientSession: () => ({
    clientId: session.clientId,
    loading: false,
    session: { authenticated: true, clientId: session.clientId },
  }),
}));

vi.mock("@/components/layout/header", () => ({
  Header: () => <div data-testid="header" />,
}));

vi.mock("next/dynamic", () => ({
  default: () => {
    const Component = () => <div data-testid="kanban-dynamic" />;
    Component.displayName = "DynamicKanban";
    return Component;
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock("@/components/leads/lead-drawer", () => ({
  LeadDrawer: ({ open, lead }: { open: boolean; lead: { nome_negocio: string } | null }) =>
    open && lead ? <div role="dialog" aria-label="Ficha do cliente">{lead.nome_negocio}</div> : null,
}));

vi.mock("@/components/add-lead-dialog", () => ({
  AddLeadDialog: ({ open, onCreated }: { open: boolean; onCreated: () => void }) =>
    open ? <button onClick={onCreated}>Concluir cadastro de teste</button> : null,
}));

const mockFetch = vi.fn();
const mockSupabaseFrom = vi.fn();

vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: (...args: unknown[]) => mockSupabaseFrom(...args),
  },
}));

function response(body: unknown, status = 200, ok = true): Response {
  return {
    status,
    ok,
    json: async () => body,
  } as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("LeadsPage - Sincronização e Hidratação de Fotos", () => {
  const sampleLeads = [
    {
      id: 1,
      remoteJid: "5511999990001@s.whatsapp.net",
      nome_negocio: "Auto Mecânica Alpha",
      telefone: "11999990001",
      ramo_negocio: "Oficina",
      endereco: "Rua 1",
      rating: "4.8",
      reviews: "10",
      website: "",
      instagram: "",
      facebook: "",
      maps_url: "",
      status: "novo" as string | null,
      next_follow_up: null,
      created_at: "2026-10-18T10:00:00.000Z",
      primeiro_contato_source: null,
      primeiro_contato_at: null,
    },
    {
      id: 2,
      remoteJid: "5511999990002@s.whatsapp.net",
      nome_negocio: "Padaria Beta",
      telefone: "11999990002",
      ramo_negocio: "Alimentação",
      endereco: "Rua 2",
      rating: "5.0",
      reviews: "25",
      website: "",
      instagram: "",
      facebook: "",
      maps_url: "",
      status: "interessado",
      next_follow_up: null,
      created_at: "2026-10-18T11:00:00.000Z",
      primeiro_contato_source: null,
      primeiro_contato_at: null,
    },
  ];

  let totalCount = 2;
  let customColumns: { id: string; status_key: string; label: string; color: string }[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    session.clientId = "client-test-123";
    totalCount = 2;
    customColumns = [];
    sampleLeads[0].status = "novo";

    mockSupabaseFrom.mockImplementation((table: string) => {
      if (table === "campaign_targets") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          then: (res: any) => Promise.resolve(res({ data: [] })),
        };
      }
      if (table === "leads_extraidos") {
        const query: any = {
          select: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          or: vi.fn().mockReturnThis(),
          range: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          then: (res: (result: { data: typeof sampleLeads; count: number }) => unknown) => Promise.resolve(res({ data: [...sampleLeads], count: totalCount })),
        };
        return query;
      }
      return {
        select: vi.fn().mockReturnThis(),
        then: (res: any) => Promise.resolve(res({ data: [] })),
      };
    });

    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/kanban-columns")) {
        return response({ ok: true, columns: customColumns });
      }
      if (url.includes("/api/contacts/avatars")) {
        return response({
          success: true,
          avatars: {
            "5511999990001@s.whatsapp.net": "https://pps.whatsapp.net/v/alpha.jpg",
          },
        });
      }
      return response({});
    });

    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("mantém busca acessível, abertura explícita da ficha e troca de visualização", async () => {
    render(<LeadsPage />);
    await waitFor(() => expect(screen.getAllByText("Auto Mecânica Alpha")[0]).toBeInTheDocument());
    expect(screen.getByRole("searchbox", { name: "Buscar clientes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lista", pressed: true })).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Abrir ficha de Auto Mecânica Alpha" })[0]);
    expect(screen.getByRole("dialog", { name: "Ficha do cliente" })).toHaveTextContent("Auto Mecânica Alpha");
    fireEvent.click(screen.getByRole("button", { name: "Kanban", exact: true }));
    expect(screen.getByTestId("kanban-dynamic")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Kanban", pressed: true })).toBeInTheDocument();
  });

  it("aplica a busca mantendo o escopo do cliente e permite limpar os filtros", async () => {
    render(<LeadsPage />);
    await waitFor(() => expect(screen.getAllByText("Auto Mecânica Alpha")[0]).toBeInTheDocument());
    fireEvent.change(screen.getByRole("searchbox", { name: "Buscar clientes" }), { target: { value: "Alpha" } });
    await waitFor(() => {
      const query = mockSupabaseFrom.mock.results.filter((_, index) => mockSupabaseFrom.mock.calls[index][0] === "leads_extraidos").at(-1)?.value;
      expect(query.eq).toHaveBeenCalledWith("client_id", "client-test-123");
      expect(query.or).toHaveBeenCalledWith(expect.stringContaining("nome_negocio.ilike.%Alpha%"));
    });
    fireEvent.click(screen.getByRole("button", { name: "Limpar filtros" }));
    expect(screen.getByRole("searchbox", { name: "Buscar clientes" })).toHaveValue("");
  });

  it("restringe a troca da tabela por cards a telas abaixo de 640px, preservando a seleção em tablets", () => {
    // JSDOM não aplica media queries; conferir também o contrato do CSS real.
    const css = readFileSync("src/app/leads/leads.module.css", "utf8");
    const mobileRules = css.match(/@media\s*\(max-width:\s*639px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(mobileRules).toMatch(/\.desktopTable\s*\{\s*display:\s*none;/);
    expect(mobileRules).toMatch(/\.mobileList\s*\{\s*display:\s*block;/);
    const tabletRules = css.match(/@media\s*\(max-width:\s*1023px\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(tabletRules).not.toMatch(/\.desktopTable\s*\{\s*display:\s*none;/);
  });

  it("preserva seleção em massa e paginação sem disparar exclusões ao cancelar", async () => {
    totalCount = 32;
    render(<LeadsPage />);
    await waitFor(() => expect(screen.getAllByText("Auto Mecânica Alpha")[0]).toBeInTheDocument());
    fireEvent.click(screen.getByRole("checkbox", { name: "Selecionar todos os leads desta página" }));
    expect(screen.getByText("2 leads selecionados")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Excluir selecionados" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancelar", exact: true }));
    expect(mockFetch.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Próximo" }));
    await waitFor(() => expect(screen.getByText("Página 2 de 3")).toBeInTheDocument());
    expect(screen.queryByText("2 leads selecionados")).not.toBeInTheDocument();
    const queries = mockSupabaseFrom.mock.results.filter((_, index) => mockSupabaseFrom.mock.calls[index][0] === "leads_extraidos");
    expect(queries.at(-1)?.value.range).toHaveBeenCalledWith(15, 29);
  });

  it("mantém a lista utilizável para etapa nula quando as colunas foram personalizadas", async () => {
    sampleLeads[0].status = null;
    customColumns = [{ id: "col-1", status_key: "qualificado", label: "Qualificado", color: "" }];
    render(<LeadsPage />);
    await waitFor(() => expect(screen.getAllByText("Auto Mecânica Alpha")[0]).toBeInTheDocument());
    expect(screen.getAllByText("Lead Extraído")).toHaveLength(2);
  });

  it("recarrega a lista após adicionar um cliente mesmo quando já está na primeira página", async () => {
    render(<LeadsPage />);
    await waitFor(() => expect(screen.getAllByText("Auto Mecânica Alpha")[0]).toBeInTheDocument());
    const before = mockSupabaseFrom.mock.calls.filter(([table]) => table === "leads_extraidos").length;
    fireEvent.click(screen.getByRole("button", { name: "Adicionar Cliente" }));
    fireEvent.click(screen.getByRole("button", { name: "Concluir cadastro de teste" }));
    await waitFor(() => expect(mockSupabaseFrom.mock.calls.filter(([table]) => table === "leads_extraidos").length).toBeGreaterThan(before));
  });

  it("hidrata fotos em cache com cachedOnly: true e não faz chamada remota automática na visualização", async () => {
    render(<LeadsPage />);

    await waitFor(() => {
      expect(screen.getAllByText("Auto Mecânica Alpha")[0]).toBeInTheDocument();
      expect(screen.getAllByText("Padaria Beta")[0]).toBeInTheDocument();
    });

    // Chamou /api/contacts/avatars com cachedOnly: true
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/contacts/avatars",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          jids: ["5511999990001@s.whatsapp.net", "5511999990002@s.whatsapp.net"],
          cachedOnly: true,
        }),
      })
    );

    // Não fez nenhuma chamada subsequente com cachedOnly: false na visualização
    const providerCalls = mockFetch.mock.calls.filter(([url, init]) => {
      if (!url.includes("/api/contacts/avatars")) return false;
      const body = JSON.parse(init?.body as string || "{}");
      return body.cachedOnly === false;
    });
    expect(providerCalls).toHaveLength(0);
  });

  it("executa sincronização sequencial em lote com aria-live e atualiza leads sem fetchLeads total", async () => {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes("/api/kanban-columns")) {
        return response({ ok: true, columns: [] });
      }
      if (url.includes("/api/contacts/avatars")) {
        return response({ success: true, avatars: {} });
      }
      if (url.includes("/api/contacts/sync-avatars")) {
        const body = JSON.parse(init?.body as string || "{}");
        if (body.cursor === 0) {
          return response({
            success: true,
            partial: false,
            processed: 1,
            updated: 1,
            noPhoto: 0,
            skipped: 0,
            failed: 0,
            total: 2,
            upperId: 100,
            nextCursor: 1,
            avatars: {
              "5511999990001@s.whatsapp.net": "https://pps.whatsapp.net/v/alpha-novo.jpg",
            },
          });
        }
        return response({
          success: true,
          partial: false,
          processed: 1,
          updated: 1,
          noPhoto: 0,
          skipped: 0,
          failed: 0,
          total: 2,
          upperId: 100,
          nextCursor: null,
          avatars: {
            "5511999990002@s.whatsapp.net": "https://pps.whatsapp.net/v/beta-novo.jpg",
          },
        });
      }
      return response({});
    });

    render(<LeadsPage />);
    await waitFor(() => expect(screen.getAllByText("Auto Mecânica Alpha")[0]).toBeInTheDocument());

    const syncButton = screen.getByRole("button", { name: /Sincronizar fotos de todos os leads/i });
    fireEvent.click(syncButton);

    // Live region status aparece
    await waitFor(() => {
      const statusRegion = screen.getByRole("status");
      expect(statusRegion).toBeInTheDocument();
      expect(statusRegion).toHaveAttribute("aria-live", "polite");
    });

    // Conclui sincronização
    await waitFor(() => {
      expect(screen.getByText(/Sincronização concluída/i)).toBeInTheDocument();
    });

    // Ambas as chamadas de sync-avatars foram feitas com scope: "leads" e upperId snapshot
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/contacts/sync-avatars",
      expect.objectContaining({
        body: JSON.stringify({ scope: "leads", cursor: 0 }),
      })
    );
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/contacts/sync-avatars",
      expect.objectContaining({
        body: JSON.stringify({ scope: "leads", cursor: 1, upperId: 100 }),
      })
    );
  });

  it("anuncia preparação sem 0/0 e não diz que fotos estão atualizadas quando WhatsApp não disponibiliza", async () => {
    const pendingBatch = deferred<Response>();
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/kanban-columns")) return response({ ok: true, columns: [] });
      if (url.includes("/api/contacts/sync-avatars")) return pendingBatch.promise;
      return response({ success: true, avatars: {} });
    });
    render(<LeadsPage />);
    await waitFor(() => expect(screen.getAllByText("Auto Mecânica Alpha")[0]).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /Sincronizar fotos de todos os leads/i }));
    expect(screen.getByRole("status")).toHaveTextContent(/Preparando sincronização/i);
    expect(screen.getByRole("status")).not.toHaveTextContent("0/0");
    await act(async () => pendingBatch.resolve(response({ success: true, processed: 2, updated: 0, noPhoto: 2, skipped: 0, failed: 0, total: 2, upperId: 2, nextCursor: null, avatars: {} })));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/2 sem foto/i));
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringMatching(/já estão atualizadas/i));
  });

  it("normaliza remoteJid inválido/LID pelo telefone na hidratação e ao aplicar sincronização", async () => {
    const original = sampleLeads[0].remoteJid;
    sampleLeads[0].remoteJid = "1234567890123@lid";
    try {
      render(<LeadsPage />);
      await waitFor(() => expect(screen.getAllByText("Auto Mecânica Alpha")[0]).toBeInTheDocument());
      const hydration = mockFetch.mock.calls.find(([url]) => url.includes("/api/contacts/avatars"));
      expect(JSON.parse(hydration?.[1]?.body as string).jids).toContain("5511999990001@s.whatsapp.net");
      expect(JSON.parse(hydration?.[1]?.body as string).jids).not.toContain("1234567890123@lid");
    } finally {
      sampleLeads[0].remoteJid = original;
    }
  });

  it("preserva foto válida exibida quando o lote retorna null", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/kanban-columns")) return response({ ok: true, columns: [] });
      if (url.includes("/api/contacts/avatars")) return response({ success: true, avatars: { "5511999990001@s.whatsapp.net": "https://pps.whatsapp.net/v/alpha.jpg" } });
      if (url.includes("/api/contacts/sync-avatars")) return response({
        success: false, partial: true, processed: 2, updated: 0, noPhoto: 1, skipped: 0, failed: 1,
        total: 2, upperId: 2, nextCursor: null, avatars: { "5511999990001@s.whatsapp.net": null },
      });
      return response({});
    });
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      set src(value: string) { if (value) this.onload?.(); }
    });
    render(<LeadsPage />);
    await waitFor(() => expect(screen.getAllByRole("img", { name: "Auto Mecânica Alpha" }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /Sincronizar fotos de todos os leads/i }));
    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    expect(screen.getAllByRole("img", { name: "Auto Mecânica Alpha" }).length).toBeGreaterThan(0);
  });

  it("ignora callbacks, conclusão e limpeza da sincronização do tenant anterior", async () => {
    vi.stubGlobal("Image", class {
      onload: (() => void) | null = null;
      set src(value: string) { if (value) this.onload?.(); }
    });
    const oldRun = deferred<photoSync.SyncProgressState>();
    const newRun = deferred<photoSync.SyncProgressState>();
    let oldCallbacks: photoSync.SyncOptions = {};
    let newCallbacks: photoSync.SyncOptions = {};
    vi.spyOn(photoSync, "syncLeadPhotosSequentially")
      .mockImplementationOnce((options = {}) => { oldCallbacks = options; return oldRun.promise; })
      .mockImplementationOnce((options = {}) => { newCallbacks = options; return newRun.promise; });
    const { rerender } = render(<LeadsPage />);
    await waitFor(() => expect(screen.getAllByRole("img", { name: "Auto Mecânica Alpha" }).length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: /Sincronizar fotos de todos os leads/i }));
    session.clientId = "client-second";
    rerender(<LeadsPage />);
    expect(oldCallbacks.signal?.aborted).toBe(true);
    await waitFor(() => expect(screen.getByRole("button", { name: /Sincronizar fotos de todos os leads/i })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: /Sincronizar fotos de todos os leads/i }));
    const stale: photoSync.SyncProgressState = {
      processed: 99, total: 99, updated: 99, noPhoto: 0, skipped: 0, failed: 0,
      avatars: { "5511999990001@s.whatsapp.net": "https://pps.whatsapp.net/stale.jpg" },
      inFlight: false, cancelled: false,
    };
    await act(async () => {
      oldCallbacks.onBatchAvatars?.(stale.avatars);
      oldCallbacks.onProgress?.(stale);
      oldRun.resolve(stale);
    });
    expect(screen.getByRole("status")).toHaveTextContent(/Preparando sincronização/i);
    expect(screen.getAllByRole("img", { name: "Auto Mecânica Alpha" }).every(image => image.getAttribute("src")?.includes("alpha.jpg"))).toBe(true);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    rerender(<></>);
    expect(newCallbacks.signal?.aborted).toBe(true);
    await act(async () => newRun.resolve({ ...stale, updated: 0, avatars: {}, cancelled: true }));
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("permite cancelar sincronização pelo botão Cancelar e interrompe próximos lotes", async () => {
    const pendingBatch = deferred<Response>();

    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/kanban-columns")) return response({ ok: true, columns: [] });
      if (url.includes("/api/contacts/avatars")) return response({ success: true, avatars: {} });
      if (url.includes("/api/contacts/sync-avatars")) {
        return pendingBatch.promise;
      }
      return response({});
    });

    render(<LeadsPage />);
    await waitFor(() => expect(screen.getAllByText("Auto Mecânica Alpha")[0]).toBeInTheDocument());

    const syncButton = screen.getByRole("button", { name: /Sincronizar fotos de todos os leads/i });
    fireEvent.click(syncButton);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Cancelar/i })).toBeInTheDocument();
    });

    // Usuário clica em Cancelar enquanto batch 1 está pendente
    fireEvent.click(screen.getByRole("button", { name: /Cancelar/i }));

    // Batch 1 conclui
    await act(async () => {
      pendingBatch.resolve(response({
        success: true,
        processed: 1,
        updated: 1,
        noPhoto: 0,
        skipped: 0,
        failed: 0,
        total: 5,
        upperId: 100,
        nextCursor: 1,
        avatars: {},
      }));
    });

    await waitFor(() => {
      expect(screen.getByText(/Sincronização interrompida/i)).toBeInTheDocument();
    });

    // Não realizou a segunda requisição após o cancelamento
    const syncCalls = mockFetch.mock.calls.filter(([url]) => url.includes("/api/contacts/sync-avatars"));
    expect(syncCalls).toHaveLength(1);
  });
});
