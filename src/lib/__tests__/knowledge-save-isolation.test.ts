import { describe, it, expect, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireClientId: vi.fn(),
  indexKnowledgeDocument: vi.fn(),
  deleteKnowledgeChunks: vi.fn(),
}));

vi.mock("@/lib/tenant", () => ({ requireClientId: mocks.requireClientId }));
vi.mock("@/lib/rag", () => ({
  indexKnowledgeDocument: mocks.indexKnowledgeDocument,
  deleteKnowledgeChunks: mocks.deleteKnowledgeChunks,
}));

type Call = { table: string; method: string; args: unknown[] };
const calls: Call[] = [];
const results: Record<string, unknown> = {};

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const b: Record<string, unknown> = {};
      const rec =
        (m: string) =>
        (...a: unknown[]) => {
          calls.push({ table, method: m, args: a });
          return b;
        };
      b.select = rec("select");
      b.eq = rec("eq");
      b.insert = rec("insert");
      b.update = rec("update");
      b.delete = rec("delete");
      b.order = rec("order");
      b.maybeSingle = async () =>
        results[table] ?? { data: null, error: null };
      b.single = async () => results[`${table}:single`] ?? { data: null, error: null };
      return b;
    },
  },
}));

import { POST } from "@/app/api/agent/knowledge/save/route";

function req(body: unknown) {
  return { json: async () => body } as any;
}

describe("SEC-H4 /api/agent/knowledge/save isolamento", () => {
  beforeEach(() => {
    calls.length = 0;
    for (const k of Object.keys(results)) delete results[k];
    mocks.requireClientId.mockResolvedValue({ ok: true, clientId: "tenant-A" });
    mocks.indexKnowledgeDocument.mockResolvedValue(undefined);
    mocks.deleteKnowledgeChunks.mockResolvedValue(undefined);
  });

  it("create com agent de OUTRO tenant → 403 e não insere", async () => {
    results["agent_settings"] = { data: { id: 7, client_id: "tenant-B" } };
    const res = await POST(req({ action: "create", agent_id: 7, title: "t", content: "conteúdo" }));
    expect(res.status).toBe(403);
    expect(calls.some((c) => c.method === "insert")).toBe(false);
    expect(mocks.indexKnowledgeDocument).not.toHaveBeenCalled();
  });

  it("create com agent inexistente → 403", async () => {
    results["agent_settings"] = { data: null };
    const res = await POST(req({ action: "create", agent_id: 99, title: "t", content: "c" }));
    expect(res.status).toBe(403);
  });

  it("create com agent do próprio tenant → insere com client_id do caller", async () => {
    results["agent_settings"] = { data: { id: 7, client_id: "tenant-A" } };
    results["agent_knowledge:single"] = { data: { id: 10, agent_id: 7 }, error: null };
    const res = await POST(req({ action: "create", agent_id: 7, title: "t", content: "c" }));
    expect(res.status).toBe(200);
    const insert = calls.find((c) => c.method === "insert");
    expect((insert?.args[0] as any).client_id).toBe("tenant-A");
  });

  it("create em agent legado sem dono (client_id NULL) ainda funciona", async () => {
    results["agent_settings"] = { data: { id: 1, client_id: null } };
    results["agent_knowledge:single"] = { data: { id: 11, agent_id: 1 }, error: null };
    const res = await POST(req({ action: "create", agent_id: 1, title: "t", content: "c" }));
    expect(res.status).toBe(200);
  });

  it("update reindexa com o agent_id REAL da row, não o do body", async () => {
    results["agent_knowledge:single"] = { data: { id: 10, agent_id: 7 }, error: null };
    const res = await POST(req({ action: "update", id: 10, agent_id: 999, title: "t", content: "c" }));
    expect(res.status).toBe(200);
    expect(mocks.indexKnowledgeDocument).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 7 })
    );
  });

  it("delete de documento de outro tenant → 404 e preserva chunks", async () => {
    results["agent_knowledge"] = { data: null, error: null };
    const res = await POST(req({ action: "delete", id: 99 }));
    expect(res.status).toBe(404);
    expect(mocks.deleteKnowledgeChunks).not.toHaveBeenCalled();
  });

  it("delete próprio usa cascade do banco em vez de apagar chunks sem tenant", async () => {
    results["agent_knowledge"] = { data: { id: 10 }, error: null };
    const res = await POST(req({ action: "delete", id: 10 }));
    expect(res.status).toBe(200);
    expect(mocks.deleteKnowledgeChunks).not.toHaveBeenCalled();
  });
});
