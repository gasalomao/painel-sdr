import { describe, expect, it } from "vitest";
import { normalizeInstagramProfile } from "../scraper-instagram";

describe("normalizeInstagramProfile", () => {
  it.each([
    ["https://www.instagram.com/loja.exemplo/?igsh=abc", "https://www.instagram.com/loja.exemplo/"],
    ["http://instagram.com/Loja_123", "https://www.instagram.com/Loja_123/"],
    ["https://m.instagram.com/loja/", "https://www.instagram.com/loja/"],
    ["https://www.google.com/url?q=https%3A%2F%2Finstagram.com%2Floja%2F&sa=U", "https://www.instagram.com/loja/"],
    ["https://www.google.com.br/url?url=https%3A%2F%2Fwww.instagram.com%2Floja%2F", "https://www.instagram.com/loja/"],
  ])("normaliza perfil sem acesso remoto: %s", (input, expected) => {
    expect(normalizeInstagramProfile(input)).toBe(expected);
  });

  it.each([
    ["https://instagram.com/loja%2Eexemplo/", "https://www.instagram.com/loja.exemplo/"],
    ["https://instagram.com/%6Coja/", "https://www.instagram.com/loja/"],
    ["https://instagram.com/%4Coja%5F123/", "https://www.instagram.com/Loja_123/"],
    [`https://instagram.com/${"%61".repeat(30)}/`, `https://www.instagram.com/${"a".repeat(30)}/`],
    ["https://www.google.com/url?q=https%3A%2F%2Finstagram.com%2Floja%252Eexemplo%2F", "https://www.instagram.com/loja.exemplo/"],
  ])("decodifica uma única vez o segmento do perfil: %s", (input, expected) => {
    expect(normalizeInstagramProfile(input)).toBe(expected);
  });

  it.each(["loja.txt", "loja.ico", "loja.xml", "login.loja", "robots.txt.loja", "favicon.ico.loja"])("preserva username legítimo com ponto: %s", (username) => {
    expect(normalizeInstagramProfile(`https://instagram.com/${username}/`)).toBe(`https://www.instagram.com/${username}/`);
  });

  it.each([
    "login", "logout", "signup", "robots.txt", "favicon.ico", "sitemap.xml", "LOGIN", "FAVICON.ICO",
    "%6Cogin", "robots%2Etxt", "favicon%2Eico", "sitemap%2Exml",
  ])("rejeita endpoint reservado mesmo codificado: %s", (endpoint) => {
    expect(normalizeInstagramProfile(`https://instagram.com/${endpoint}/`)).toBe("");
  });

  it.each([
    "%", "%2", "%GG", "%C3%28", "%FF", "%ED%A0%80",
    "%2Floja", "loja%2Fextra", "loja%2F", "loja%5Cextra", "loja%3Fnext", "loja%23parte",
    "loja%20exemplo", "loja%00", "loja%0A", "loja%C3%A1", "%2Eloja", "loja%2E", "loja%2E%2Eexemplo",
    "%256Coja", "loja%252Eexemplo", "loja%252Fextra", "loja%255Cextra",
    "%25256Coja", `${"%61".repeat(31)}`,
  ])("rejeita escapes inválidos, separadores ou dupla codificação: %s", (segment) => {
    expect(normalizeInstagramProfile(`https://instagram.com/${segment}/`)).toBe("");
  });

  it.each([
    `https://www.google.com/url?q=${encodeURIComponent("https://www.google.com/url?q=https%3A%2F%2Finstagram.com%2Floja%2F")}`,
    `https://www.google.com/url?url=${encodeURIComponent("https://www.google.com.br/url?url=https%3A%2F%2Finstagram.com%2Floja%2F")}`,
    `https://www.google.com/url?q=${encodeURIComponent("https://instagram.com/loja%252Eexemplo/")}`,
  ])("não segue redirecionamento encadeado nem decodificação repetida: %s", (input) => {
    expect(normalizeInstagramProfile(input)).toBe("");
  });

  it.each([
    "", "@loja", "instagram.com/loja", "https://instagram.com/", "https://instagram.com/accounts/login/",
    "https://instagram.com/p/abc/", "https://instagram.com/reel/abc/", "https://instagram.com/reels/",
    "https://instagram.com/stories/loja/123/", "https://instagram.com/explore/", "https://instagram.com/direct/",
    "https://instagram.com.evil.test/loja/", "https://fakeinstagram.com/loja/",
    "https://example.test/?url=https://instagram.com/loja/", "https://instagram.com@evil.test/loja/",
    "https://user:password@instagram.com/loja/", "https://instagram.com:444/loja/",
    "javascript:alert('instagram.com/loja')", "ftp://instagram.com/loja/",
    "https://google.com.evil.test/url?q=https://instagram.com/loja/",
    "https://www.google.com/search?q=https://instagram.com/loja/",
    "https://instagram.com/loja/extra", "https://instagram.com/../", "https://instagram.com/.loja/",
    "https://instagram.com/loja./", "https://instagram.com/loja..exemplo/",
    `https://instagram.com/${"a".repeat(31)}/`,
  ])("não confirma perfil por URL inválida ou não atribuível: %s", (input) => {
    expect(normalizeInstagramProfile(input)).toBe("");
  });
});
