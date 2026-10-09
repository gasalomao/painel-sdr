import { describe, expect, it } from "vitest";
import { sanitizeSiteDiagnostic } from "../../../../scripts/diagnose-site-readonly";

describe("read-only diagnostic redaction", () => {
  it("redacts URLs, bearer tokens, emails, phone numbers and terminal control bytes", () => {
    const input = "TS2322 src/App.tsx:4 https://private.test?token=secret Bearer private-key contact@example.test +55 (11) 99999-1234\u001b[31m";
    const result = sanitizeSiteDiagnostic(input);
    expect(result).toContain("TS2322 src/App.tsx:4");
    expect(result).not.toMatch(/private-key|private\.test|secret|contact@|99999|\u001b/);
  });

  it("omits unrecognized secrets and personal names instead of relying on a redaction denylist", () => {
    const input = "TS2322 src/App.tsx:4 GEMINI_API_KEY=AIzaSyReviewOnlyPlaceholderABC Fulano de Tal Rua da Pessoa 42";
    const result = sanitizeSiteDiagnostic(input);
    expect(result).toContain("TS2322 src/App.tsx:4");
    expect(result).not.toMatch(/AIza|Fulano|Rua da Pessoa|GEMINI_API_KEY/);
  });

  it("only reports diagnostic identifiers and never arbitrary source fragments", () => {
    expect(sanitizeSiteDiagnostic("a".repeat(2000))).toBe("[detalhe omitido]");
    expect(sanitizeSiteDiagnostic(null)).toBe("");
  });
});
