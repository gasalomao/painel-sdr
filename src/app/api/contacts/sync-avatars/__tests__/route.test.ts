import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "../route";
import { requireClientId } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase_admin";

vi.mock("@/lib/tenant", () => ({ requireClientId: vi.fn(), isInstanceOwnedByClient: vi.fn().mockResolvedValue(true) }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { from: vi.fn() } }));
vi.mock("@/lib/channel", () => ({ bulkSyncProfilePics: vi.fn().mockResolvedValue(0), fetchProfilePicture: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/evolution", () => ({ getEvolutionConfig: vi.fn().mockResolvedValue({ instance: "global" }) }));

function database(options: { connection?: boolean; leadError?: boolean } = {}) {
  const connection = {
    select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), in: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(), maybeSingle: vi.fn().mockResolvedValue({ data: options.connection === false ? null : { instance_name: "own", provider: "evolution", status: "connected", client_id: "a" }, error: null }),
  };
  const leads = {
    select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), order: vi.fn().mockReturnThis(), gt: vi.fn().mockReturnThis(), lte: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: { id: 0 }, error: options.leadError ? { message: "database unavailable" } : null }),
    limit: vi.fn().mockReturnThis(),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: [], count: 0, error: options.leadError ? { message: "database unavailable" } : null })),
  };
  vi.mocked(supabaseAdmin.from).mockImplementation((table) => (table === "channel_connections" ? connection : leads) as unknown as ReturnType<typeof supabaseAdmin.from>);
  return { connection, leads };
}

function request(payload: unknown): NextRequest {
  return new NextRequest("http://localhost/api/contacts/sync-avatars", { method: "POST", body: JSON.stringify(payload) });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireClientId).mockResolvedValue({ ok: true, clientId: "a", isAdmin: true, impersonating: false, claims: {} as never });
});

describe("sync avatars boundaries", () => {
  it("does not report success when the lead query fails", async () => {
    database({ leadError: true });
    const response = await POST(request({ instance: "own", scope: "leads" }));
    expect(response.status).toBe(500);
    expect((await response.json()).success).toBe(false);
    expect(supabaseAdmin.from).toHaveBeenCalledWith("leads_extraidos");
  });

  it("requires an owned connection even for administrators", async () => {
    database({ connection: false });
    const response = await POST(request({ instance: "other", scope: "leads" }));
    expect(response.status).toBe(404);
    expect((await response.json()).success).toBe(false);
  });

  it("paginates beyond 200 leads by ID, independent of displayed cards", async () => {
    const db = database();
    const rows = Array.from({ length: 245 }, (_, index) => ({ id: index + 1, telefone: null, remoteJid: null }));
    let cursor = 0;
    let upper = 245;
    let totalOnly = false;
    let descending = false;
    let take = 41;
    db.leads.select.mockImplementation((_fields: string, options?: { head?: boolean }) => { totalOnly = !!options?.head; return db.leads; });
    db.leads.gt.mockImplementation((_field: string, value: number) => { cursor = value; return db.leads; });
    db.leads.lte.mockImplementation((_field: string, value: number) => { upper = value; return db.leads; });
    db.leads.order.mockImplementation((_field: string, options: { ascending: boolean }) => { descending = !options.ascending; return db.leads; });
    db.leads.limit.mockImplementation((value: number) => { take = value; return db.leads; });
    db.leads.maybeSingle.mockImplementation(async () => ({ data: { id: descending ? 245 : 1 }, error: null }));
    db.leads.then = (resolve) => Promise.resolve(resolve({ data: totalOnly ? null : rows.filter((row) => row.id > cursor && row.id <= upper).slice(0, take), count: 245, error: null }));
    let next: number | null = 0;
    let processed = 0;
    let pages = 0;
    do {
      const response = await POST(request({ scope: "leads", cursor: next, ...(pages > 0 ? { upperId: 245 } : {}) }));
      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.upperId).toBe(245);
      expect(data.total).toBe(245);
      expect(data.processed).toBeLessThanOrEqual(40);
      expect(data.skipped).toBe(data.processed);
      expect(data.success).toBe(true);
      processed += data.processed;
      next = data.nextCursor;
      pages++;
    } while (next !== null && pages < 10);
    expect(processed).toBe(245);
    expect(pages).toBe(7);
    expect(db.leads.eq).toHaveBeenCalledWith("client_id", "a");
    expect(db.connection.eq).toHaveBeenCalledWith("client_id", "a");
  });

  it.each([{ cursor: -1 }, { cursor: 1.5 }, { instance: 42 }, { scope: "other" }, null, []])("rejects invalid batch input %j", async (payload) => {
    database();
    expect((await POST(request(payload))).status).toBe(400);
    expect(supabaseAdmin.from).not.toHaveBeenCalled();
  });
});
