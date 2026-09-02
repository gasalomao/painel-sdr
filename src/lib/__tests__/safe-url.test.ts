import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

const lookup = vi.hoisted(() => vi.fn());
const request = vi.hoisted(() => vi.fn());
vi.mock("node:dns/promises", () => ({ lookup }));
vi.mock("node:http", () => ({ request }));
vi.mock("node:https", () => ({ request }));

import { assertPublicHttpUrl, assertPublicHttpUrlResolved, fetchPublicHttpUrl } from "../safe-url";

type MockIncomingResponse = Readable & {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
};

function respondWith(statusCode: number, headers: Record<string, string> = {}, body = ""): void {
  request.mockImplementationOnce((
    _url: URL,
    _options: Record<string, unknown>,
    onResponse: (response: MockIncomingResponse) => void,
  ) => {
    const response = Object.assign(Readable.from([Buffer.from(body)]), {
      statusCode,
      statusMessage: "",
      headers,
    }) as MockIncomingResponse;
    queueMicrotask(() => onResponse(response));
    return Object.assign(new EventEmitter(), { end: vi.fn(), destroy: vi.fn() });
  });
}

beforeEach(() => {
  lookup.mockReset();
  request.mockReset();
});

describe("assertPublicHttpUrl (guard SSRF)", () => {
  it("aceita URLs públicas http/https", () => {
    expect(assertPublicHttpUrl("https://n8n.example.com/webhook/abc")).toEqual({ ok: true });
    expect(assertPublicHttpUrl("http://api.serpro.gov.br:8080/hook")).toEqual({ ok: true });
  });

  it("bloqueia schemes não-http", () => {
    expect(assertPublicHttpUrl("file:///etc/passwd").ok).toBe(false);
    expect(assertPublicHttpUrl("gopher://x").ok).toBe(false);
    expect(assertPublicHttpUrl("ftp://1.2.3.4").ok).toBe(false);
  });

  it("bloqueia localhost e sufixos internos", () => {
    expect(assertPublicHttpUrl("http://localhost:5678/webhook").ok).toBe(false);
    expect(assertPublicHttpUrl("http://servico.localhost/x").ok).toBe(false);
    expect(assertPublicHttpUrl("http://n8n.local/webhook").ok).toBe(false);
    expect(assertPublicHttpUrl("http://db.internal:5432").ok).toBe(false);
  });

  it("bloqueia IPv4 privado/loopback/link-local/metadata", () => {
    expect(assertPublicHttpUrl("http://127.0.0.1/").ok).toBe(false);
    expect(assertPublicHttpUrl("http://10.0.0.5/").ok).toBe(false);
    expect(assertPublicHttpUrl("http://192.168.1.10/").ok).toBe(false);
    expect(assertPublicHttpUrl("http://172.16.0.1/").ok).toBe(false);
    expect(assertPublicHttpUrl("http://172.31.255.255/").ok).toBe(false);
    expect(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data").ok).toBe(false);
    expect(assertPublicHttpUrl("http://100.64.0.1/").ok).toBe(false);
  });

  it("bloqueia IPv6 interno e IP numérico encodado", () => {
    expect(assertPublicHttpUrl("http://[::1]/").ok).toBe(false);
    expect(assertPublicHttpUrl("http://[fe80::1]/").ok).toBe(false);
    expect(assertPublicHttpUrl("http://2130706433/").ok).toBe(false);
  });

  it("bloqueia userinfo e URL malformada", () => {
    expect(assertPublicHttpUrl("http://user:pass@evil.com/hook").ok).toBe(false);
    expect(assertPublicHttpUrl("not a url").ok).toBe(false);
    expect(assertPublicHttpUrl("").ok).toBe(false);
  });

  it("aceita IP privado com escape hatch env", () => {
    process.env.ALLOW_PRIVATE_WEBHOOK_URLS = "1";
    try {
      expect(assertPublicHttpUrl("http://192.168.0.20:5678/webhook/x")).toEqual({ ok: true });
      expect(assertPublicHttpUrl("http://localhost:5678/hook")).toEqual({ ok: true });
    } finally {
      delete process.env.ALLOW_PRIVATE_WEBHOOK_URLS;
    }
  });

  it("IP público literal passa", () => {
    expect(assertPublicHttpUrl("https://142.250.79.46/")).toEqual({ ok: true });
    expect(assertPublicHttpUrl("http://8.8.8.8/")).toEqual({ ok: true });
  });

  it("bloqueia domínio público que resolve para IP privado", async () => {
    lookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    const result = await assertPublicHttpUrlResolved("https://rebinding.example/hook");
    expect(result.ok).toBe(false);
  });

  it("aceita domínio quando todos os IPs resolvidos são públicos", async () => {
    lookup.mockResolvedValue([
      { address: "142.250.79.46", family: 4 },
      { address: "2607:f8b0:4004:c1b::71", family: 6 },
    ]);
    await expect(assertPublicHttpUrlResolved("https://public.example/hook")).resolves.toEqual({ ok: true });
  });

  it("fixa a conexão no IP público já validado para impedir DNS rebinding", async () => {
    lookup.mockResolvedValue([
      { address: "142.250.79.46", family: 4 },
      { address: "142.250.79.47", family: 4 },
    ]);
    respondWith(200, { "content-type": "text/plain" }, "ok");

    const res = await fetchPublicHttpUrl("https://public.example/hook");

    expect(await res.text()).toBe("ok");
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      new URL("https://public.example/hook"),
      expect.objectContaining({
        lookup: expect.any(Function),
        servername: "public.example",
      }),
      expect.any(Function),
    );
    const options = request.mock.calls[0][1] as {
      lookup: (hostname: string, options: { all?: boolean }, callback: (error: Error | null, address: unknown, family?: number) => void) => void;
    };
    const callback = vi.fn();
    options.lookup("public.example", { all: true }, callback);
    expect(callback).toHaveBeenCalledWith(null, [
      { address: "142.250.79.46", family: 4 },
      { address: "142.250.79.47", family: 4 },
    ]);
  });

  it("bloqueia redirect sem seguir o location", async () => {
    lookup.mockResolvedValue([{ address: "142.250.79.46", family: 4 }]);
    respondWith(302, { location: "http://127.0.0.1/admin" });

    const res = await fetchPublicHttpUrl("https://public.example/hook");

    expect(res.ok).toBe(false);
    expect(res.status).toBe(502);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
