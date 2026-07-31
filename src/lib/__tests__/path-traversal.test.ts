/**
 * Testa guards de path traversal (auth-meta filename sanitization).
 *
 * POR QUE EXISTE: o conector OAuth permite apelidos editáveis pelo usuário
 * para contas conectadas. O apelido vira nome de arquivo em
 * `.gateway-proxy/auths/<apelido>-<provider>-<email>.json`. Se não for
 * saneado, "../etc/passwd" tenta escapar do diretório.
 *
 * Princípio testado: o PERIGO real é path traversal (../, \\, /). Apelidos
 * com caracteres não alfanuméricos viram "_" pra não confundir o filesystem.
 * Não saneamos palavras como "passwd" — elas são inócuas como nome de arquivo.
 */
import { describe, it, expect } from "vitest";

// Replica a lógica usada em gateway-proxy-manager.ts (safeAuthName).
// Caracteres permitidos: letras, dígitos, hífen, underscore. Resto vira _.
// Path traversal (.., /, \) é removido ou neutralizado.
const SAFE_AUTH_NAME_REGEX = /^[a-zA-Z0-9-_]+$/;
function safeAuthName(input: string): string {
  const cleaned = (input || "")
    .replace(/\.\.+/g, "_") // ".." vira _ (bloqueia travessia ../..)
    .replace(/[\\/]+/g, "_") // separadores de path viram _
    .replace(/[^a-zA-Z0-9-_]+/g, "_") // outros não-seguros viram _
    .replace(/^_+|_+$/g, "") // remove _ no início/fim
    .slice(0, 64);
  if (!cleaned) return "account";
  if (SAFE_AUTH_NAME_REGEX.test(cleaned)) return cleaned;
  return "account";
}

describe("safeAuthName — path traversal guard", () => {
  it("bloqueia travessia de diretório (sem ../ no resultado)", () => {
    const out = safeAuthName("../etc/passwd");
    expect(out).not.toContain("..");
    expect(out).not.toContain("/");
    expect(out).not.toContain("\\");
  });

  it("bloqueia separadores Windows e Linux (vazam _ em vez)", () => {
    expect(safeAuthName("foo/bar")).toBe("foo_bar");
    expect(safeAuthName("foo\\bar")).toBe("foo_bar");
    expect(safeAuthName("foo/../bar")).toBe("foo___bar");
  });

  it("aceita apelido válido simples", () => {
    expect(safeAuthName("Pessoal")).toBe("Pessoal");
    expect(safeAuthName("Trabalho-2024")).toBe("Trabalho-2024");
    expect(safeAuthName("conta_1")).toBe("conta_1");
  });

  it("substitui espaços e caracteres especiais por underscore", () => {
    const out = safeAuthName("Minha Conta Principal!");
    expect(out).not.toContain(" ");
    expect(out).not.toContain("!");
    expect(SAFE_AUTH_NAME_REGEX.test(out)).toBe(true);
  });

  it("entrada vazia → fallback 'account'", () => {
    expect(safeAuthName("")).toBe("account");
    expect(safeAuthName("   ")).toBe("account");
    expect(safeAuthName(null as any)).toBe("account");
  });

  it("entrada só com caracteres não-seguros → fallback 'account'", () => {
    expect(safeAuthName("!@#$%")).toBe("account");
    expect(safeAuthName("___")).toBe("account");
  });

  it("trunca apelidos muito longos (cap 64)", () => {
    const long = "a".repeat(200);
    expect(safeAuthName(long).length).toBeLessThanOrEqual(64);
  });

  it("rejeita payload malicious de config.yaml (sem ., /, \\)", () => {
    const malicious = "../../.gateway-proxy/config.yaml";
    const out = safeAuthName(malicious);
    expect(out).not.toContain("..");
    expect(out).not.toContain("/");
    expect(out).not.toContain("\\");
    expect(SAFE_AUTH_NAME_REGEX.test(out)).toBe(true);
  });

  it("preserva apelidos com números e hifens válidos", () => {
    expect(safeAuthName("account-2024-v2")).toBe("account-2024-v2");
    expect(SAFE_AUTH_NAME_REGEX.test(safeAuthName("123-abc"))).toBe(true);
  });

  it("ACEITA palavra 'passwd' como apelido (não é perigosa fora de path)", () => {
    // 'passwd' sozinho é só texto; o risco era "../etc/passwd" como PATH.
    const out = safeAuthName("passwd");
    expect(SAFE_AUTH_NAME_REGEX.test(out)).toBe(true);
  });
});
