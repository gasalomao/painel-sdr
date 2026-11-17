import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireClientId: vi.fn(),
  supabaseFrom: vi.fn(),
  storageListBuckets: vi.fn(async () => ({ data: [{ name: "chat-media" }] })),
  storageUpload: vi.fn(async () => ({ error: null })),
  storageGetPublicUrl: vi.fn(() => ({ data: { publicUrl: "https://cdn.example/a.png" } })),
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: mocks.requireClientId,
  clientIdFromInstance: vi.fn(async () => "tenant-a"),
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: mocks.supabaseFrom,
    storage: {
      listBuckets: mocks.storageListBuckets,
      upload: mocks.storageUpload,
      from: () => ({
        upload: mocks.storageUpload,
        getPublicUrl: mocks.storageGetPublicUrl,
      }),
    },
  },
}));

vi.mock("@/lib/evolution", () => ({
  evolution: {
    fetchInstances: vi.fn(async () => []),
    findMessages: vi.fn(async () => ({ records: [{ key: { id: "msg-1", fromMe: false, remoteJid: "5511999990000@s.whatsapp.net" }, message: { conversation: "Oi" } }] })),
    logout: vi.fn(async () => ({})),
    deleteInstance: vi.fn(async () => ({})),
    ensureInstanceConfigured: vi.fn(async () => ({})),
  },
}));
vi.mock("@/lib/providers/evolution-go", () => ({ evolutionGo: {} }));
vi.mock("@/lib/channel", () => ({
  getStatus: vi.fn(async () => ({ state: "open", data: {} })),
}));

import { POST as saveLead } from "@/app/api/leads/save/route";
import { DELETE as deleteLead } from "@/app/api/leads/delete/route";
import { DELETE as deleteChatMessages } from "@/app/api/chat/messages/route";
import { POST as syncEvolutionChat } from "@/app/api/chat/sync-evolution/route";
import { POST as uploadMedia } from "@/app/api/upload-media/route";
import { GET as getWhatsapp, POST as postWhatsapp } from "@/app/api/whatsapp/route";

describe("Hardening estrito via requireClientId + supabaseAdmin nas rotas operacionais", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireClientId.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Sessão inválida" }, { status: 401 }),
    });
  });

  it("bloqueia sessão revogada ou ausente com 401 em todas as rotas migradas", async () => {
    const r1 = await saveLead(new NextRequest("http://localhost/api/leads/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remoteJid: "5511999990000@s.whatsapp.net" }),
    }));
    const r2 = await deleteLead(new NextRequest("http://localhost/api/leads/delete?id=1", { method: "DELETE" }));
    const r3 = await deleteChatMessages(new NextRequest("http://localhost/api/chat/messages", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageIds: ["m1"] }),
    }));
    const r4 = await uploadMedia(new NextRequest("http://localhost/api/upload-media", { method: "POST" }));
    const r5 = await getWhatsapp(new NextRequest("http://localhost/api/whatsapp"));
    const r6 = await postWhatsapp(new NextRequest("http://localhost/api/whatsapp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "status", instanceName: "inst-1" }),
    }));

    for (const res of [r1, r2, r3, r4, r5, r6]) {
      expect(res.status).toBe(401);
    }
    expect(mocks.supabaseFrom).not.toHaveBeenCalled();
  });

  it("executa delete de mensagens via supabaseAdmin escopado ao client_id da sessão", async () => {
    const eqMock = vi.fn();
    const inMock = vi.fn(async () => ({ error: null }));
    const chain = {
      delete: vi.fn(() => chain),
      eq: (...args: unknown[]) => {
        eqMock(...args);
        return chain;
      },
      in: inMock,
    };
    mocks.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-x",
      isAdmin: false,
      impersonating: false,
      claims: {} as never,
    });
    mocks.supabaseFrom.mockReturnValue(chain);

    const res = await deleteChatMessages(new NextRequest("http://localhost/api/chat/messages", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageIds: ["m1", "m2"], clientId: "tenant-atacante" }),
    }));

    expect(res.status).toBe(200);
    expect(mocks.supabaseFrom).toHaveBeenCalledWith("chats_dashboard");
    expect(eqMock).toHaveBeenCalledWith("client_id", "tenant-x");
    expect(inMock).toHaveBeenCalledWith("id", ["m1", "m2"]);
  });

  it("escopa a checagem de duplicidade de sync-evolution ao client_id autenticado", async () => {
    const eqMock = vi.fn();
    const chain = {
      select: vi.fn(() => chain),
      eq: (...args: unknown[]) => {
        eqMock(...args);
        return chain;
      },
      in: vi.fn(async () => ({ data: [{ message_id: "msg-1" }], error: null })),
    };
    mocks.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-evo",
      isAdmin: false,
      impersonating: false,
      claims: {} as never,
    });
    mocks.supabaseFrom.mockReturnValue(chain);

    const res = await syncEvolutionChat(new NextRequest("http://localhost/api/chat/sync-evolution", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remoteJid: "5511999990000@s.whatsapp.net" }),
    }));

    expect(res.status).toBe(200);
    expect(mocks.supabaseFrom).toHaveBeenCalledWith("chats_dashboard");
    expect(eqMock).toHaveBeenCalledWith("client_id", "tenant-evo");
  });
});
