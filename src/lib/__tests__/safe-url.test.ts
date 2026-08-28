import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl } from "../safe-url";

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
});
