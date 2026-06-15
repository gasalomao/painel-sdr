import { describe, it, expect, afterEach, vi } from "vitest";
import { isPrivateOrLocalHost, isPrivateOrLocalUrl, isUrlSafeForProd } from "../url-guard";

describe("isPrivateOrLocalHost", () => {
  it("bloqueia localhost, 0.0.0.0 e loopback IPv4", () => {
    expect(isPrivateOrLocalHost("localhost")).toBe(true);
    expect(isPrivateOrLocalHost("0.0.0.0")).toBe(true);
    expect(isPrivateOrLocalHost("127.0.0.1")).toBe(true);
    expect(isPrivateOrLocalHost("127.123.45.6")).toBe(true);
  });

  it("bloqueia ranges RFC1918", () => {
    expect(isPrivateOrLocalHost("10.0.0.1")).toBe(true);
    expect(isPrivateOrLocalHost("10.255.255.255")).toBe(true);
    expect(isPrivateOrLocalHost("192.168.1.1")).toBe(true);
    expect(isPrivateOrLocalHost("172.16.0.1")).toBe(true);
    expect(isPrivateOrLocalHost("172.31.255.255")).toBe(true);
  });

  it("permite 172.15.x.x e 172.32.x.x (FORA do range privado)", () => {
    expect(isPrivateOrLocalHost("172.15.0.1")).toBe(false);
    expect(isPrivateOrLocalHost("172.32.0.1")).toBe(false);
  });

  it("bloqueia link-local 169.254.x.x", () => {
    expect(isPrivateOrLocalHost("169.254.169.254")).toBe(true); // AWS metadata
  });

  it("bloqueia IPv6 loopback e ULA", () => {
    expect(isPrivateOrLocalHost("::1")).toBe(true);
    expect(isPrivateOrLocalHost("fc00::1")).toBe(true);
    expect(isPrivateOrLocalHost("fd12:3456::1")).toBe(true);
  });

  it("permite hosts públicos", () => {
    expect(isPrivateOrLocalHost("example.com")).toBe(false);
    expect(isPrivateOrLocalHost("api.openai.com")).toBe(false);
    expect(isPrivateOrLocalHost("8.8.8.8")).toBe(false);
    expect(isPrivateOrLocalHost("203.0.113.1")).toBe(false);
  });

  it("bloqueia hostname vazio", () => {
    expect(isPrivateOrLocalHost("")).toBe(true);
    expect(isPrivateOrLocalHost("   ")).toBe(true);
  });

  it("é case-insensitive", () => {
    expect(isPrivateOrLocalHost("LOCALHOST")).toBe(true);
  });
});

describe("isPrivateOrLocalUrl", () => {
  it("bloqueia URL com host privado", () => {
    expect(isPrivateOrLocalUrl("http://127.0.0.1:3000/x")).toBe(true);
    expect(isPrivateOrLocalUrl("https://192.168.1.1/api")).toBe(true);
  });

  it("permite URL pública", () => {
    expect(isPrivateOrLocalUrl("https://example.com/path")).toBe(false);
  });

  it("URL inválida trata como bloqueada (defensive)", () => {
    expect(isPrivateOrLocalUrl("not a url")).toBe(true);
    expect(isPrivateOrLocalUrl("")).toBe(true);
  });
});

describe("isUrlSafeForProd", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("em dev, qualquer URL passa (mesmo localhost)", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(isUrlSafeForProd("http://localhost:3000")).toBe(true);
    expect(isUrlSafeForProd("https://example.com")).toBe(true);
  });

  it("em prod exige HTTPS + host público", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isUrlSafeForProd("https://example.com")).toBe(true);
    expect(isUrlSafeForProd("http://example.com")).toBe(false); // HTTP
    expect(isUrlSafeForProd("https://127.0.0.1")).toBe(false); // privado
    expect(isUrlSafeForProd("https://10.0.0.1")).toBe(false);
    expect(isUrlSafeForProd("notaurl")).toBe(false);
  });
});
