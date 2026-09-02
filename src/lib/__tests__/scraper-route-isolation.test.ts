import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifySession: vi.fn(),
  isSessionLiveStrict: vi.fn(),
  startScraperRun: vi.fn(),
  stopScraper: vi.fn(),
  pauseScraper: vi.fn(),
  resumeScraper: vi.fn(),
  clearLeads: vi.fn(),
  getLeads: vi.fn(),
  sendLeadsBatch: vi.fn(),
  attachSseClient: vi.fn(),
  detachSseClient: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => ({ value: "session-token" }) })),
}));
vi.mock("@/lib/auth", () => ({
  SESSION_COOKIE: "session",
  verifySession: mocks.verifySession,
  isSessionLiveStrict: mocks.isSessionLiveStrict,
}));
vi.mock("@/lib/scraper-engine", () => ({
  startScraperRun: mocks.startScraperRun,
  stopScraper: mocks.stopScraper,
  pauseScraper: mocks.pauseScraper,
  resumeScraper: mocks.resumeScraper,
  clearLeads: mocks.clearLeads,
  getLeads: mocks.getLeads,
  getStatus: vi.fn(),
  sendLeadsBatch: mocks.sendLeadsBatch,
  attachSseClient: mocks.attachSseClient,
  detachSseClient: mocks.detachSseClient,
}));

import { GET, POST } from "@/app/api/scraper/route";

const tenantId = "tenant-A";

function request(body: unknown): Request {
  return new Request("http://localhost/api/scraper", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/scraper tenant scope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifySession.mockResolvedValue({ clientId: tenantId, sessionId: "session-A" });
    mocks.isSessionLiveStrict.mockResolvedValue(true);
    mocks.startScraperRun.mockReturnValue({ ok: true });
    mocks.stopScraper.mockReturnValue(true);
    mocks.getLeads.mockReturnValue({ leads: [], count: 0 });
  });

  it("vincula SSE ao tenant autenticado", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    expect(mocks.isSessionLiveStrict).toHaveBeenCalledWith("session-A", "session-token");
    expect(mocks.attachSseClient).toHaveBeenCalledWith(expect.anything(), tenantId);
    await response.body?.cancel();
    expect(mocks.detachSseClient).toHaveBeenCalledWith(expect.anything());
  });

  it("rejeita sessão revogada no GET e POST", async () => {
    mocks.isSessionLiveStrict.mockResolvedValue(false);

    const getResponse = await GET();
    const postResponse = await POST(request({ action: "get_leads" }) as never);

    expect(getResponse.status).toBe(401);
    expect(postResponse.status).toBe(401);
    expect(mocks.attachSseClient).not.toHaveBeenCalled();
    expect(mocks.getLeads).not.toHaveBeenCalled();
  });

  it("injeta o tenant no start e ignora automation_id do body", async () => {
    const response = await POST(request({
      action: "start",
      niches: ["padaria"],
      regions: ["Vitória"],
      automation_id: "automation-de-outro-tenant",
    }) as never);

    expect(response.status).toBe(200);
    expect(mocks.startScraperRun).toHaveBeenCalledWith(expect.objectContaining({ client_id: tenantId }));
    expect(mocks.startScraperRun.mock.calls[0][0]).not.toHaveProperty("automation_id");
  });

  it("escopa leitura e controle ao tenant autenticado", async () => {
    await POST(request({ action: "get_leads" }) as never);
    await POST(request({ action: "stop" }) as never);

    expect(mocks.getLeads).toHaveBeenCalledWith(tenantId);
    expect(mocks.stopScraper).toHaveBeenCalledWith(tenantId);
  });
});
