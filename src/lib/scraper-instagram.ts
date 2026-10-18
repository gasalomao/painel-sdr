/** Confirma somente o formato do perfil informado no Maps; não faz acesso remoto. */
export function normalizeInstagramProfile(value: string): string {
  try {
    let url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return "";
    // ponytail: um redirecionamento explícito do Maps; encadeamentos exigem outro critério, não navegação.
    if (["google.com", "www.google.com", "google.com.br", "www.google.com.br"].includes(url.hostname) && url.pathname === "/url") {
      url = new URL(url.searchParams.get("q") || url.searchParams.get("url") || "");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return "";
    if (!["instagram.com", "www.instagram.com", "m.instagram.com"].includes(url.hostname)) return "";
    const match = url.pathname.match(/^\/([^/]+)\/?$/);
    if (!match) return "";
    const username = decodeURIComponent(match[1]);
    if (
      !username || username.length > 30 || /[^a-z\d_.]/i.test(username) ||
      username.startsWith(".") || username.endsWith(".") || username.includes("..")
    ) return "";
    if (["accounts", "login", "logout", "signup", "robots.txt", "favicon.ico", "sitemap.xml", "p", "reel", "reels", "stories", "explore", "direct", "share", "about", "legal", "privacy", "terms", "challenge", "developer", "developers", "api", "graphql", "oauth", "download", "web", "emails"].includes(username.toLowerCase())) return "";
    return `https://www.instagram.com/${username}/`;
  } catch {
    return "";
  }
}
