// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  requireClientId: vi.fn(),
  storageListBuckets: vi.fn(async () => ({ data: [{ name: "chat-media" }] })),
  storageUpload: vi.fn(async () => ({ error: null })),
  storageGetPublicUrl: vi.fn((path: string) => ({
    data: { publicUrl: `https://cdn.example/chat-media/${path}` },
  })),
}));

vi.mock("@/lib/tenant", () => ({
  requireClientId: mocks.requireClientId,
}));

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    storage: {
      listBuckets: mocks.storageListBuckets,
      createBucket: vi.fn(async () => ({ error: null })),
      from: () => ({
        upload: mocks.storageUpload,
        getPublicUrl: mocks.storageGetPublicUrl,
      }),
    },
  },
}));

import { POST } from "@/app/api/upload-media/route";
import { resetSaasLimitsStateForTests } from "@/lib/saas-limits";

function makeUploadRequest(fileName: string, mimeType: string, content = "conteudo") {
  const form = new FormData();
  const file = new File([content], fileName, { type: mimeType });
  form.append("file", file);
  return new NextRequest("http://localhost/api/upload-media", {
    method: "POST",
    body: form,
  });
}

describe("POST /api/upload-media (allowlist MIME/extensão e prefixo por tenant)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetSaasLimitsStateForTests();
    mocks.requireClientId.mockResolvedValue({
      ok: true,
      clientId: "tenant-123",
      isAdmin: false,
      impersonating: false,
      claims: {} as never,
    });
  });

  it("retorna 401 quando sessão é inválida", async () => {
    mocks.requireClientId.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "Não autenticado" }, { status: 401 }),
    });

    const res = await POST(makeUploadRequest("foto.png", "image/png"));
    expect(res.status).toBe(401);
    expect(mocks.storageUpload).not.toHaveBeenCalled();
  });

  it.each([
    ["payload.svg", "image/svg+xml"],
    ["disfarce.svg", "image/png"],
    ["pagina.html", "text/html"],
    ["index.htm", "text/html"],
    ["script.js", "application/javascript"],
    ["rotina.sh", "application/x-sh"],
    ["binario.exe", "application/octet-stream"],
    ["xml-attack.xml", "application/xml"],
    ["php-shell.php", "image/jpeg"],
    ["trocado.jpg", "application/pdf"],
  ])("rejeita upload perigoso ou inconsistente (%s / %s) com HTTP 415", async (name, mime) => {
    const res = await POST(makeUploadRequest(name, mime));
    const json = await res.json();

    expect(res.status).toBe(415);
    expect(json.success).toBe(false);
    expect(mocks.storageUpload).not.toHaveBeenCalled();
  });

  it("aceita imagem PNG e grava sob prefixo do client_id autenticado", async () => {
    const res = await POST(makeUploadRequest("produto.png", "image/png"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mocks.storageUpload).toHaveBeenCalledTimes(1);

    const [uploadedPath, , uploadOpts] = mocks.storageUpload.mock.calls[0] as unknown as [
      string,
      Buffer,
      { contentType: string; upsert: boolean }
    ];
    expect(uploadedPath).toMatch(/^tenant-123\/kb_\d+_[a-z0-9]+\.png$/);
    expect(uploadOpts.contentType).toBe("image/png");
    expect(json.url).toContain("tenant-123/kb_");
  });

  it("aceita áudio com parâmetros codecs=opus no MIME e normaliza contentType", async () => {
    const res = await POST(makeUploadRequest("nota-voz.ogg", "audio/ogg; codecs=opus"));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    const [uploadedPath, , uploadOpts] = mocks.storageUpload.mock.calls[0] as unknown as [
      string,
      Buffer,
      { contentType: string }
    ];
    expect(uploadedPath).toMatch(/^tenant-123\/kb_.*\.ogg$/);
    expect(uploadOpts.contentType).toBe("audio/ogg");
  });

  it("deriva MIME seguro quando navegador envia application/octet-stream para PDF válido", async () => {
    const res = await POST(makeUploadRequest("catalogo.pdf", "application/octet-stream"));
    expect(res.status).toBe(200);

    const [uploadedPath, , uploadOpts] = mocks.storageUpload.mock.calls[0] as unknown as [
      string,
      Buffer,
      { contentType: string }
    ];
    expect(uploadedPath).toMatch(/^tenant-123\/kb_.*\.pdf$/);
    expect(uploadOpts.contentType).toBe("application/pdf");
  });

  it("sanitiza clientId contra path traversal antes de compor a chave no bucket", async () => {
    mocks.requireClientId.mockResolvedValueOnce({
      ok: true,
      clientId: "tenant/../outro",
      isAdmin: false,
      impersonating: false,
      claims: {} as never,
    });

    const res = await POST(makeUploadRequest("foto.jpg", "image/jpeg"));
    expect(res.status).toBe(200);

    const [uploadedPath] = mocks.storageUpload.mock.calls[0] as unknown as [string];
    expect(uploadedPath).not.toContain("..");
    expect(uploadedPath).toMatch(/^tenant____outro\/kb_.*\.jpg$/);
  });

  it("bloqueia com HTTP 413 quando arquivo excede limite do plano SaaS", async () => {
    const req = new NextRequest("http://localhost/api/upload-media", { method: "POST" });
    const bigForm = new FormData();
    const fakeBigFile = {
      name: "video-pesado.mp4",
      type: "video/mp4",
      size: 35 * 1024 * 1024,
      arrayBuffer: async () => new ArrayBuffer(8),
    } as unknown as File;
    vi.spyOn(bigForm, "get").mockReturnValue(fakeBigFile);
    vi.spyOn(req, "formData").mockResolvedValue(bigForm);

    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(mocks.storageUpload).not.toHaveBeenCalled();
  });
});
