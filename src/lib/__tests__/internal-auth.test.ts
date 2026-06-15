import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { hasInternalSecret, getInternalSecret, INTERNAL_SECRET_HEADER } from "../internal-auth";

function fakeReq(headerVal: string | null) {
  return {
    headers: {
      get: (k: string) => (k.toLowerCase() === INTERNAL_SECRET_HEADER ? headerVal : null),
    },
  } as any;
}

describe("getInternalSecret", () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    delete process.env.AUTH_SECRET;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });
  afterEach(() => {
    process.env = { ...ENV };
  });

  it("retorna AUTH_SECRET quando presente", () => {
    process.env.AUTH_SECRET = "abc";
    expect(getInternalSecret()).toBe("abc");
  });

  it("usa SUPABASE_SERVICE_ROLE_KEY como fallback", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = "srv";
    expect(getInternalSecret()).toBe("srv");
  });

  it("retorna string vazia se nenhum env definido", () => {
    expect(getInternalSecret()).toBe("");
  });

  it("AUTH_SECRET tem precedência sobre SERVICE_ROLE", () => {
    process.env.AUTH_SECRET = "primary";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "fallback";
    expect(getInternalSecret()).toBe("primary");
  });
});

describe("hasInternalSecret", () => {
  const ENV = { ...process.env };
  beforeEach(() => {
    process.env.AUTH_SECRET = "topsecret";
  });
  afterEach(() => {
    process.env = { ...ENV };
  });

  it("retorna true quando header bate exato", () => {
    expect(hasInternalSecret(fakeReq("topsecret"))).toBe(true);
  });

  it("retorna false sem header", () => {
    expect(hasInternalSecret(fakeReq(null))).toBe(false);
  });

  it("retorna false com header errado", () => {
    expect(hasInternalSecret(fakeReq("wrong"))).toBe(false);
  });

  it("retorna false quando secret vazio (mesmo com header presente)", () => {
    delete process.env.AUTH_SECRET;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(hasInternalSecret(fakeReq(""))).toBe(false);
  });

  it("comparação é case-sensitive", () => {
    expect(hasInternalSecret(fakeReq("TOPSECRET"))).toBe(false);
  });
});
