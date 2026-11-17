// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { timingSafeEqualEdge } from "@/lib/auth-edge";
import { resolveSafeUploadFormat } from "@/lib/media-upload-safety";
import { mergeRealtimeLog } from "@/lib/realtime-logs";

const mocks = vi.hoisted(() => ({
  requireClientId: vi.fn(),
  clientIdFromInstance: vi.fn(async () => "tenant-sync"),
  findClientByEmail: vi.fn(),
  verifyPassword: vi.fn(),
  signSession: vi.fn(),
  createAuthSession: vi.fn(),
  findMessages: vi.fn(async () => ({ records: [] })),
  supabaseFrom: vi.fn(),
  storageGetBucket: vi.fn(async () => ({ data: { name: "whatsapp_media" }, error: null })),
  storageCreateBucket: vi.fn(async () => ({ error: null })),
  storageUpload: vi.fn(async () => ({ error: null })),
  storageGetPublicUrl: vi.fn((path: string) => ({ data: { publicUrl: `https://cdn.example/whatsapp_media/${path}` } })),
}));

vi.mock("@/lib/auth", () => ({
  findClientByEmail: mocks.findClientByEmail,
  verifyPassword: mocks.verifyPassword,
  signSession: mocks.signSession,
  createAuthSession: mocks.createAuthSession,
  SESSION_COOKIE: "sdr_session",
  SESSION_TTL: 3600,
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: mocks.requireClientId,
  clientIdFromInstance: mocks.clientIdFromInstance,
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: mocks.supabaseFrom,
    storage: {
      getBucket: mocks.storageGetBucket,
      createBucket: mocks.storageCreateBucket,
      from: () => ({
        upload: mocks.storageUpload,
        getPublicUrl: mocks.storageGetPublicUrl,
      }),
    },
  },
}));

vi.mock("@/lib/evolution", () => ({
  evolution: {
    findMessages: mocks.findMessages,
  },
}));

describe("Hardening helpers e correções operacionais", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("timingSafeEqualEdge valida strings UTF-8 sem short-circuit por prefixo/tamanho", () => {
    expect(timingSafeEqualEdge("segredo-123", "segredo-123")).toBe(true);
    expect(timingSafeEqualEdge("segredo-123", "segredo-124")).toBe(false);
    expect(timingSafeEqualEdge("segredo", "segredo-maior")).toBe(false);
    expect(timingSafeEqualEdge("ação-✓", "ação-✓")).toBe(true);
    expect(timingSafeEqualEdge("", "")).toBe(true);
  });

  it("resolveSafeUploadFormat aceita mídias legítimas (incluindo audio/mp4 + .mp4 Safari) e bloqueia SVG/HTML", () => {
    expect(resolveSafeUploadFormat("nota.mp4", "audio/mp4")).toEqual({
      ext: "m4a",
      contentType: "audio/mp4",
    });
    expect(resolveSafeUploadFormat("audio.ogg", "audio/ogg; codecs=opus")).toEqual({
      ext: "ogg",
      contentType: "audio/ogg",
    });
    expect(resolveSafeUploadFormat("", "image/svg+xml")).toBeNull();
    expect(resolveSafeUploadFormat("", "text/html")).toBeNull();
    expect(resolveSafeUploadFormat("cartao.vcf", "text/vcard")).toEqual({
      ext: "vcf",
      contentType: "text/vcard",
    });
  });

  it("mergeRealtimeLog deduplica por id e fallback created_at+message em modos append e prepend", () => {
    const base = [
      { id: 1, created_at: "2026-11-16T10:00:00Z", message: "Inicio" },
      { id: 2, created_at: "2026-11-16T10:00:05Z", message: "Enviado" },
    ];
    expect(mergeRealtimeLog(base, { id: 2, created_at: "2026-11-16T10:00:05Z", message: "Enviado" })).toHaveLength(2);
    expect(mergeRealtimeLog(base, { id: 3, created_at: "2026-11-16T10:00:10Z", message: "Novo" }, 2)).toEqual([
      { id: 2, created_at: "2026-11-16T10:00:05Z", message: "Enviado" },
      { id: 3, created_at: "2026-11-16T10:00:10Z", message: "Novo" },
    ]);
    expect(
      mergeRealtimeLog(base, { id: 3, created_at: "2026-11-16T10:00:10Z", message: "Topo" }, 2, "prepend")
    ).toEqual([
      { id: 3, created_at: "2026-11-16T10:00:10Z", message: "Topo" },
      { id: 1, created_at: "2026-11-16T10:00:00Z", message: "Inicio" },
    ]);
  });

  it("sync-evolution aplica clamp máximo de 200 mensagens e mínimo 1", async () => {
    mocks.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-sync",
      isAdmin: false,
      impersonating: false,
      claims: {} as never,
    });
    const { POST } = await import("@/app/api/chat/sync-evolution/route");

    await POST(
      new NextRequest("http://localhost/api/chat/sync-evolution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remoteJid: "5511999990000@s.whatsapp.net", count: 999999 }),
      })
    );
    expect(mocks.findMessages).toHaveBeenCalledWith("5511999990000@s.whatsapp.net", 200);

    await POST(
      new NextRequest("http://localhost/api/chat/sync-evolution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remoteJid: "5511999990000@s.whatsapp.net", count: -5 }),
      })
    );
    expect(mocks.findMessages).toHaveBeenCalledWith("5511999990000@s.whatsapp.net", 1);
  });

  it("POST /api/auth/login reinicia windowStart após expirar a janela de 15 minutos", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-16T12:00:00.000Z"));
    mocks.findClientByEmail.mockResolvedValue(null);

    const { POST } = await import("@/app/api/auth/login/route");
    const tryLogin = () =>
      POST(
        new NextRequest("http://localhost/api/auth/login", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.77" },
          body: JSON.stringify({ email: "window-reset@example.com", password: "errada" }),
        })
      );

    // 8 tentativas falhas na primeira janela (abaixo do bloqueio de 10)
    for (let i = 0; i < 8; i++) {
      expect((await tryLogin()).status).toBe(401);
    }

    // Avança 16 minutos: janela deve resetar windowStart para agora, permitindo nova janela completa de 9 antes de 429
    vi.setSystemTime(new Date("2026-11-16T12:16:00.000Z"));
    for (let i = 0; i < 9; i++) {
      expect((await tryLogin()).status).toBe(401);
    }
    expect((await tryLogin()).status).toBe(429);
  });

  it("sync-evolution encaminha instanceName do tenant, bloqueia 403 cross-tenant e resolve instância padrão do cliente", async () => {
    mocks.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-sync",
      isAdmin: false,
      impersonating: false,
      claims: {} as never,
    });
    const { POST } = await import("@/app/api/chat/sync-evolution/route");

    // 1. Instância de outro tenant → 403 e NÃO consulta Evolution
    mocks.clientIdFromInstance.mockResolvedValueOnce("outro-tenant");
    const denied = await POST(
      new NextRequest("http://localhost/api/chat/sync-evolution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remoteJid: "5511999990000@s.whatsapp.net", instanceName: "inst-alheia" }),
      })
    );
    expect(denied.status).toBe(403);
    expect(mocks.findMessages).not.toHaveBeenCalled();

    // 2. Instância pertencente ao tenant → encaminha como 3º parâmetro de findMessages
    mocks.clientIdFromInstance.mockResolvedValueOnce("tenant-sync");
    const allowed = await POST(
      new NextRequest("http://localhost/api/chat/sync-evolution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remoteJid: "5511999990000@s.whatsapp.net", count: 15, instanceName: "inst-tenant-b" }),
      })
    );
    expect(allowed.status).toBe(200);
    expect(mocks.findMessages).toHaveBeenCalledWith("5511999990000@s.whatsapp.net", 15, "inst-tenant-b");

    // 3. Sem instanceName → resolve instância do próprio tenant em channel_connections
    mocks.supabaseFrom.mockImplementationOnce(() => ({
      select: () => ({
        eq: () => ({
          limit: () => ({
            maybeSingle: async () => ({ data: { instance_name: "inst-auto-tenant" }, error: null }),
          }),
        }),
      }),
    }));
    await POST(
      new NextRequest("http://localhost/api/chat/sync-evolution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remoteJid: "5511999990000@s.whatsapp.net", count: 10 }),
      })
    );
    expect(mocks.findMessages).toHaveBeenCalledWith("5511999990000@s.whatsapp.net", 10, "inst-auto-tenant");
  });

  it("uploadMediaBase64 em shared-helpers bloqueia SVG/HTML e grava PNG sob prefixo clientId/jid", async () => {
    const { uploadMediaBase64 } = await import("@/app/api/webhooks/shared-helpers");

    const blockedSvg = await uploadMediaBase64("PHN2Zz4=", "5511999990000@s.whatsapp.net", "image/svg+xml", "tenant-a");
    const blockedHtml = await uploadMediaBase64("PGh0bWw+", "5511999990000@s.whatsapp.net", "text/html", "tenant-a");
    expect(blockedSvg).toBeNull();
    expect(blockedHtml).toBeNull();
    expect(mocks.storageUpload).not.toHaveBeenCalled();

    const okUrl = await uploadMediaBase64("iVBORw0KGgo=", "5511999990000@s.whatsapp.net", "image/png", "tenant-a");
    expect(okUrl).toContain("tenant-a/5511999990000@s.whatsapp.net/");
    expect(okUrl).toMatch(/\.png$/);
    expect(mocks.storageUpload).toHaveBeenCalledTimes(1);
    const [pathArg, , optsArg] = mocks.storageUpload.mock.calls[0] as unknown as [
      string,
      Buffer,
      { contentType: string; upsert: boolean }
    ];
    expect(pathArg).toMatch(/^tenant-a\/5511999990000@s\.whatsapp\.net\/\d+\.png$/);
    expect(optsArg.contentType).toBe("image/png");
    expect(optsArg.upsert).toBe(true);

    // Aceita fileName seguro com octet-stream e bloqueia extensão perigosa via fileName
    const blockedExt = await uploadMediaBase64("PHN2Zz4=", "5511999990000@s.whatsapp.net", "application/octet-stream", "tenant-a", "evil.svg");
    expect(blockedExt).toBeNull();

    const pdfUrl = await uploadMediaBase64("JVBERi0=", "5511999990000@s.whatsapp.net", "application/octet-stream", "tenant-a", "contrato.pdf");
    expect(pdfUrl).toMatch(/^https:\/\/cdn\.example\/whatsapp_media\/tenant-a\/5511999990000@s\.whatsapp\.net\/\d+\.pdf$/);
  });
});

