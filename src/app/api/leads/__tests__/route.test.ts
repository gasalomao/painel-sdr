// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

type QueryResult = { data?: unknown; count?: number | null; error?: { message: string } | null };

const mocks = vi.hoisted(() => {
  const calls: Array<{ table: string; op: string; args: unknown[] }> = [];
  let campaignResult: QueryResult = { data: [], error: null };
  const leadsResultsQueue: QueryResult[] = [];
  let statusResult: QueryResult = { data: { id: "lead-1", status: "qualified" }, error: null };

  const makeLeadsChain = () => {
    const chain: Record<string, unknown> = {
      select: (...args: unknown[]) => {
        calls.push({ table: "leads_extraidos", op: "select", args });
        return chain;
      },
      update: (...args: unknown[]) => {
        calls.push({ table: "leads_extraidos", op: "update", args });
        return chain;
      },
      order: (...args: unknown[]) => {
        calls.push({ table: "leads_extraidos", op: "order", args });
        return chain;
      },
      eq: (...args: unknown[]) => {
        calls.push({ table: "leads_extraidos", op: "eq", args });
        return chain;
      },
      or: (...args: unknown[]) => {
        calls.push({ table: "leads_extraidos", op: "or", args });
        return chain;
      },
      range: (...args: unknown[]) => {
        calls.push({ table: "leads_extraidos", op: "range", args });
        return chain;
      },
      limit: (...args: unknown[]) => {
        calls.push({ table: "leads_extraidos", op: "limit", args });
        return chain;
      },
      maybeSingle: async () => {
        calls.push({ table: "leads_extraidos", op: "maybeSingle", args: [] });
        return statusResult;
      },
      then: (resolve: (v: QueryResult) => unknown) => {
        const next = leadsResultsQueue.shift() ?? { data: [], count: 0, error: null };
        return Promise.resolve(next).then(resolve);
      },
    };
    return chain;
  };

  const makeCampaignChain = () => {
    const chain: Record<string, unknown> = {
      select: (...args: unknown[]) => {
        calls.push({ table: "campaign_targets", op: "select", args });
        return chain;
      },
      eq: (...args: unknown[]) => {
        calls.push({ table: "campaign_targets", op: "eq", args });
        return chain;
      },
      then: (resolve: (v: QueryResult) => unknown) => Promise.resolve(campaignResult).then(resolve),
    };
    return chain;
  };

  return {
    requireClientId: vi.fn(),
    calls,
    leadsResultsQueue,
    setCampaignResult: (v: QueryResult) => {
      campaignResult = v;
    },
    setStatusResult: (v: QueryResult) => {
      statusResult = v;
    },
    from: vi.fn((table: string) =>
      table === "campaign_targets" ? makeCampaignChain() : makeLeadsChain()
    ),
  };
});

vi.mock("@/lib/tenant", () => ({
  requireClientId: mocks.requireClientId,
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: mocks.from,
  },
}));

import { GET } from "@/app/api/leads/route";
import { PATCH } from "@/app/api/leads/[id]/status/route";

describe("BFF CRM Leads: GET /api/leads & PATCH /api/leads/[id]/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.calls.length = 0;
    mocks.leadsResultsQueue.length = 0;
    mocks.setCampaignResult({ data: [], error: null });
    mocks.setStatusResult({ data: { id: "lead-1", status: "contacted" }, error: null });
    mocks.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-crm",
      isAdmin: false,
      impersonating: false,
      claims: {} as never,
    });
  });

  it("retorna 401 quando sessão inválida no GET /api/leads e PATCH /api/leads/[id]/status", async () => {
    mocks.requireClientId.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Não autenticado" }, { status: 401 }),
    });

    const getRes = await GET(new NextRequest("http://localhost/api/leads"));
    const patchRes = await PATCH(
      new NextRequest("http://localhost/api/leads/lead-1/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "won" }),
      }),
      { params: Promise.resolve({ id: "lead-1" }) }
    );

    expect(getRes.status).toBe(401);
    expect(patchRes.status).toBe(401);
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("escopa listagem paginada ao tenant da sessão, sanitiza busca PostgREST e retorna sentJids", async () => {
    mocks.setCampaignResult({ data: [{ remote_jid: "5511999991111@s.whatsapp.net" }], error: null });
    mocks.leadsResultsQueue.push({
      data: [{ id: "1", nome_negocio: "Café Alpha", status: "new" }],
      count: 42,
      error: null,
    });

    const res = await GET(
      new NextRequest(
        "http://localhost/api/leads?view=list&page=1&pageSize=15&search=Cafe,Ltda(100%)&category=Cafeteria&disparo=pending&clientId=atacante"
      )
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.totalCount).toBe(42);
    expect(json.sentJids).toEqual(["5511999991111@s.whatsapp.net"]);
    expect(json.leads).toHaveLength(1);

    expect(mocks.calls).toContainEqual({
      table: "leads_extraidos",
      op: "eq",
      args: ["client_id", "tenant-crm"],
    });
    expect(mocks.calls).not.toContainEqual({
      table: "leads_extraidos",
      op: "eq",
      args: ["client_id", "atacante"],
    });
    expect(mocks.calls).toContainEqual({
      table: "leads_extraidos",
      op: "range",
      args: [15, 29],
    });
    const orSearch = mocks.calls.find(
      (c) => c.table === "leads_extraidos" && c.op === "or" && String(c.args[0]).includes("nome_negocio.ilike.")
    );
    expect(orSearch).toBeTruthy();
    expect(String(orSearch?.args[0])).toContain("Cafe Ltda 100\\%");
    expect(String(orSearch?.args[0])).not.toContain("(100%)");
  });

  it("faz fallback automático para '*' quando projeção de colunas falha no banco do tenant", async () => {
    mocks.leadsResultsQueue.push(
      { data: null, count: null, error: { message: 'column "icp_score" does not exist' } },
      { data: [{ id: "2", nome_negocio: "Clínica B" }], count: 1, error: null }
    );

    const res = await GET(new NextRequest("http://localhost/api/leads?view=kanban"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.leads).toHaveLength(1);
    const selects = mocks.calls.filter((c) => c.table === "leads_extraidos" && c.op === "select");
    expect(selects).toHaveLength(2);
    expect(selects[1].args[0]).toBe("*");
    expect(mocks.calls).toContainEqual({
      table: "leads_extraidos",
      op: "limit",
      args: [500],
    });
  });

  it("retorna export completo escopado ao tenant quando view=export", async () => {
    mocks.leadsResultsQueue.push({
      data: [{ id: "10", nome_negocio: "Loja Export" }],
      error: null,
    });

    const res = await GET(new NextRequest("http://localhost/api/leads?view=export"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.leads).toHaveLength(1);
    expect(mocks.from).not.toHaveBeenCalledWith("campaign_targets");
    expect(mocks.calls).toContainEqual({
      table: "leads_extraidos",
      op: "select",
      args: ["*"],
    });
    expect(mocks.calls).toContainEqual({
      table: "leads_extraidos",
      op: "eq",
      args: ["client_id", "tenant-crm"],
    });
  });

  it("PATCH /api/leads/[id]/status valida status, aplica client_id e retorna 404 para outro tenant", async () => {
    const badRes = await PATCH(
      new NextRequest("http://localhost/api/leads/lead-1/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "   " }),
      }),
      { params: Promise.resolve({ id: "lead-1" }) }
    );
    expect(badRes.status).toBe(400);

    mocks.setStatusResult({ data: null, error: null });
    const crossTenantRes = await PATCH(
      new NextRequest("http://localhost/api/leads/lead-other/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "won" }),
      }),
      { params: Promise.resolve({ id: "lead-other" }) }
    );
    expect(crossTenantRes.status).toBe(404);
    expect(mocks.calls).toContainEqual({
      table: "leads_extraidos",
      op: "eq",
      args: ["id", "lead-other"],
    });
    expect(mocks.calls).toContainEqual({
      table: "leads_extraidos",
      op: "eq",
      args: ["client_id", "tenant-crm"],
    });

    mocks.setStatusResult({ data: { id: "lead-1", status: "won" }, error: null });
    const okRes = await PATCH(
      new NextRequest("http://localhost/api/leads/lead-1/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "won" }),
      }),
      { params: Promise.resolve({ id: "lead-1" }) }
    );
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({
      success: true,
      lead: { id: "lead-1", status: "won" },
    });
  });
});
