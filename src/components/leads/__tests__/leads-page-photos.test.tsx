import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup, act } from "@testing-library/react";
import LeadsPage from "@/app/leads/page";
import { supabase } from "@/lib/supabase";

vi.mock("@/lib/use-session", () => ({
  useClientSession: () => ({
    clientId: "client-test-123",
    loading: false,
    session: { authenticated: true, clientId: "client-test-123" },
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
      status: "novo",
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

  beforeEach(() => {
    vi.clearAllMocks();

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
          then: (res: any) => Promise.resolve(res({ data: [...sampleLeads], count: 2 })),
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
        return response({ ok: true, columns: [] });
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
