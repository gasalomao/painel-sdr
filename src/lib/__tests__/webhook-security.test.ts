import { describe, it, expect } from "vitest";
import { safeSecretEqual, shouldLogOnce } from "../webhook-security";

describe("safeSecretEqual", () => {
  it("segredos iguais → true", () => {
    expect(safeSecretEqual("abc123", "abc123")).toBe(true);
  });

  it("segredos diferentes do mesmo tamanho → false", () => {
    expect(safeSecretEqual("abc123", "abc124")).toBe(false);
  });

  it("tamanhos diferentes → false", () => {
    expect(safeSecretEqual("curto", "um-pouco-mais-longo")).toBe(false);
  });

  it("não lança quando o tamanho UTF-16 coincide mas o tamanho UTF-8 difere", () => {
    expect(() => safeSecretEqual("é", "a")).not.toThrow();
    expect(safeSecretEqual("é", "a")).toBe(false);
  });

  it("null/undefined/vazio → false (nunca casa 'ausente' com 'ausente')", () => {
    expect(safeSecretEqual(null, null)).toBe(false);
    expect(safeSecretEqual("", "")).toBe(false);
    expect(safeSecretEqual(undefined, "x")).toBe(false);
  });
});

describe("shouldLogOnce", () => {
  it("primeira ocorrência libera, repetições suprimem", () => {
    expect(shouldLogOnce("test-bucket", "inst-1")).toBe(true);
    expect(shouldLogOnce("test-bucket", "inst-1")).toBe(false);
    expect(shouldLogOnce("test-bucket", "inst-2")).toBe(true);
    expect(shouldLogOnce("outro-bucket", "inst-1")).toBe(true);
  });
});
