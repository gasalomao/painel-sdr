import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireClientId: vi.fn(),
  from: vi.fn(),
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: mocks.requireClientId,
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: { from: mocks.from },
}));

import { GET as getConversations } from "@/app/api/inbox/conversations/route";
import { GET as getMessages } from "@/app/api/inbox/messages/route";
import { GET as getSessionInfo, PATCH as patchSession } from "@/app/api/inbox/sessions/route";
import { PATCH as patchContact } from "@/app/api/contacts/[id]/route";

function chain(result: unknown) {
  const calls: { method: string; args: unknown[] }[] = [];
  const builder: Record<string, unknown> = {
    calls,
    select: (...args: unknown[]) => { calls.push({ method: "select", args }); return builder; },
    update: (...args: unknown[]) => { calls.push({ method: "update", args }); return builder; },
    eq: (...args: unknown[]) => { calls.push({ method: "eq", args }); return builder; },
    in: (...args: unknown[]) => { calls.push({ method: "in", args }); return builder; },
    order: (...args: unknown[]) => { calls.push({ method: "order", args }); return builder; },
    limit: (...args: unknown[]) => { calls.push({ method: "limit", args }); return builder; },
    maybeSingle: (...args: unknown[]) => { calls.push({ method: "maybeSingle", args }); return builder; },
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(result).then(res, rej),
  };
  return builder;
}

describe("BFF Inbox + Contatos (multi-tenant e requireClientId)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-a",
      isAdmin: false,
      impersonating: false,
      claims: {},
    });
  });

  it("bloqueia todas as rotas sem sessão válida com 401", async () => {
    mocks.requireClientId.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Não autenticado" }, { status: 401 }),
    });

    const responses = await Promise.all([
      getConversations(new NextRequest("http://localhost/api/inbox/conversations")),
      getMessages(new NextRequest("http://localhost/api/inbox/messages?jids=a@s.whatsapp.net")),
      getSessionInfo(new NextRequest("http://localhost/api/inbox/sessions?contact_id=c1")),
      patchSession(new NextRequest("http://localhost/api/inbox/sessions", { method: "PATCH", body: "{}" })),
      patchContact(
        new NextRequest("http://localhost/api/contacts/c1", { method: "PATCH", body: "{}" }),
        { params: Promise.resolve({ id: "c1" }) },
      ),
    ]);

    for (const res of responses) {
      expect(res.status).toBe(401);
    }
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("escopa conversas e mensagens ao tenant autenticado e faz fallback V2", async () => {
    const queries: { table: string; calls: { method: string; args: unknown[] }[] }[] = [];
    mocks.from.mockImplementation((table: string) => {
      const q = chain(
        table === "messages"
          ? { data: [{ id: "m-v2", sender: "customer", content: "Oi", created_at: "2026-01-01T00:00:00Z" }], error: null }
          : { data: [], error: null },
      );
      queries.push({ table, calls: q.calls as { method: string; args: unknown[] }[] });
      return q;
    });

    const convRes = await getConversations(new NextRequest("http://localhost/api/inbox/conversations?mode=full"));
    expect(convRes.status).toBe(200);
    for (const t of ["sessions", "chats_dashboard", "kanban_columns", "leads_extraidos"]) {
      const q = queries.find((x) => x.table === t);
      expect(q?.calls).toContainEqual({ method: "eq", args: ["client_id", "tenant-a"] });
    }

    const msgRes = await getMessages(
      new NextRequest("http://localhost/api/inbox/messages?jids=5511@s.whatsapp.net&session_id=s1&conversation_id=5511@s.whatsapp.net"),
    );
    const msgJson = await msgRes.json();
    expect(msgRes.status).toBe(200);
    expect(msgJson.source).toBe("messages");
    expect(msgJson.rows[0]).toMatchObject({ sender_type: "customer", content: "Oi" });
  });

  it("atualiza contato/sessão validando ownership por client_id e retorna 404 quando 0 linhas", async () => {
    const cChain = chain({ data: null, error: null });
    mocks.from.mockReturnValue(cChain);

    const notFound = await patchContact(
      new NextRequest("http://localhost/api/contacts/c-other", {
        method: "PATCH",
        body: JSON.stringify({ notes: "Nota" }),
      }),
      { params: Promise.resolve({ id: "c-other" }) },
    );
    expect(notFound.status).toBe(404);
    expect(cChain.calls).toContainEqual({ method: "eq", args: ["id", "c-other"] });
    expect(cChain.calls).toContainEqual({ method: "eq", args: ["client_id", "tenant-a"] });

    const badStatus = await patchSession(
      new NextRequest("http://localhost/api/inbox/sessions", {
        method: "PATCH",
        body: JSON.stringify({ contactId: "c1", bot_status: "hax" }),
      }),
    );
    expect(badStatus.status).toBe(400);
  });

  it("não permite que admin vincule agent_id de outro tenant à sessão e sanitiza erro 500", async () => {
    mocks.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-a",
      isAdmin: true,
      impersonating: true,
      claims: {},
    });
    const agentOtherTenant = chain({ data: { id: 99, client_id: "tenant-b" }, error: null });
    mocks.from.mockReturnValue(agentOtherTenant);

    const crossAgent = await patchSession(
      new NextRequest("http://localhost/api/inbox/sessions", {
        method: "PATCH",
        body: JSON.stringify({ contactId: "c1", agent_id: 99 }),
      }),
    );
    expect(crossAgent.status).toBe(404);

    const dbErr = chain({ data: null, error: { message: "relation secret_sql failed" } });
    mocks.from.mockReturnValue(dbErr);
    const convErrRes = await getConversations(new NextRequest("http://localhost/api/inbox/conversations?mode=poll"));
    const convErrJson = await convErrRes.json();
    expect(convErrRes.status).toBe(500);
    expect(convErrJson.error).toBe("Falha ao carregar conversas");
  });
});

