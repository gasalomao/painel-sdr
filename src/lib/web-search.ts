export type SearchResult = { title: string; url: string; snippet: string };

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const FETCH_HEADERS: Record<string, string> = {
  "User-Agent": BROWSER_UA,
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
};

export function needsFreshWebSearch(text: string): boolean {
  const query = String(text || "").trim();
  if (!query) return false;

  const asksForSearch = /\b(pesquis[ea]|busc[ae]|procure|veja\s+(?:na\s+)?internet|na\s+web|online|google|site\s+oficial)\b/i.test(query);
  const currentTopic = /\b(cotação|d[oó]lar|euro|c[aâ]mbio|not[ií]cia|clima|tempo|previs[aã]o|placar|resultado|eleiç[aã]o|presidente|data\s+de\s+hoje)\b/i.test(query);
  const asksCurrentFact = /\b(qual|quanto|quem|quando|onde|como\s+(?:est[aá]|estão)|me\s+(?:diga|fale|informe)|atual(?:izado)?|recent(?:e|es)|últim[ao]s?)\b/i.test(query) && /\b(hoje|agora|atual(?:izado)?)\b/i.test(query);

  return asksForSearch || currentTopic || asksCurrentFact;
}

export async function webSearch(query: string, maxResults = 8): Promise<SearchResult[]> {
  if (!query?.trim()) return [];
  const q = query.trim().slice(0, 500);
  const limit = Math.min(Math.max(Math.floor(maxResults) || 8, 1), 10);

  const fx = detectCurrencyQuery(q);
  if (fx) {
    const r = await fetchExchangeRate(fx.from, fx.to).catch(() => null);
    if (r) return [r];
  }

  const inst = await tryInstantAnswer(q).catch(() => [] as SearchResult[]);
  if (inst.length > 0) return inst.slice(0, limit);

  const lite = filterAds(await tryDdgLite(q, limit).catch(() => [] as SearchResult[]));
  if (lite.length > 0) return lite;

  const ddgHtml = filterAds(await tryDdgHtmlPost(q, limit).catch(() => [] as SearchResult[]));
  if (ddgHtml.length > 0) return ddgHtml;

  const bing = filterAds(await tryBing(q, limit).catch(() => [] as SearchResult[]));
  if (bing.length > 0) return bing;

  return [];
}

export function formatResultsForAI(results: SearchResult[]): string {
  if (!results?.length) return "Nenhum resultado encontrado na busca.";
  return results.map((r, i) =>
    `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet || "(sem descrição)"}`
  ).join("\n\n");
}

function isAd(href: string): boolean {
  const h = href.toLowerCase();
  if (h.includes("y.js?") || h.includes("y.js&")) return true;
  if (h.includes("ad_domain=") || h.includes("ad_provider=") || h.includes("ad_type=")) return true;
  if (h.includes("/ad?") || h.includes("/ad&")) return true;
  if (h.includes("bing.com/aclick") || h.includes("bing.com/a/")) return true;
  return false;
}

function filterAds(results: SearchResult[]): SearchResult[] {
  return results.filter(r => {
    const u = r.url.toLowerCase();
    if (u.includes("duckduckgo.com/y.js")) return false;
    if (u.includes("duckduckgo.com%2fy.js")) return false;
    if (u.includes("/y.js?ad_")) return false;
    if (isAd(r.url)) return false;
    return true;
  });
}

export async function webFetchPage(url: string): Promise<{ success: boolean; title?: string; content?: string; error?: string }> {
  if (!url?.startsWith("http")) return { success: false, error: "URL inválida. Deve iniciar com http/https." };
  
  const cleanUrl = url.trim();
  const key = process.env.JINA_API_KEY;
  try {
    // 1. Tenta o Jina AI Reader (ideal para LLM: markdown direto de SPA renderizado no Puppeteer)
    const res = await fetch(`https://r.jina.ai/${cleanUrl}`, {
      signal: AbortSignal.timeout(18000),
      headers: {
        ...(key ? { "Authorization": `Bearer ${key}` } : {}),
        "Accept": "application/json",
        "X-Return-Format": "markdown",
        "X-With-Generated-Alt": "true"
      }
    });

    if (res.ok) {
      const data: any = await res.json().catch(() => null);
      const md = data?.data?.content || data?.content || "";
      if (md && md.length > 50) {
        return {
          success: true,
          title: data?.data?.title || data?.title || "",
          content: md.slice(0, 15000) // limita para não estourar contexto
        };
      }
    }
  } catch {
    // Falha do Jina passa pro fallback
  }

  // 2. Fallback: Fetch direto de HTML e limpeza de tags
  try {
    const res = await fetch(cleanUrl, {
      headers: { "User-Agent": BROWSER_UA },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return { success: false, error: `Falha no acesso direto: HTTP ${res.status}` };
    const html = await res.text();
    
    // Extrai o body ou pega o texto inteiro limpo
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    const contentHtml = bodyMatch ? bodyMatch[1] : html;
    
    // Remove scripts e estilos antes de limpar tags
    const cleanHtml = contentHtml
      .replace(/<script[^>]*>([\s\S]*?)<\/script>/gi, "")
      .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, "");
    
    const text = stripTags(cleanHtml);
    if (text.length > 50) {
      return {
        success: true,
        content: text.slice(0, 8000)
      };
    }
  } catch (err: any) {
    return { success: false, error: err.message };
  }

  return { success: false, error: "Nenhum conteúdo pôde ser extraído desta página." };
}

function resolveDdgUrl(rawHref: string): string {
  const uddg = rawHref.match(/uddg=([^&]+)/);
  if (uddg) return decodeURIComponent(uddg[1]);
  if (rawHref.startsWith("//")) return "https:" + rawHref;
  return rawHref;
}

function resolveBingUrl(rawHref: string, html: string): string {
  const u = rawHref.match(/u=([^"&]+)/);
  if (u) return decodeURIComponent(u[1]);
  const p = rawHref.match(/[?&]p=([^&]+)/);
  if (p) {
    const target = html.match(new RegExp(`ru=([^&"]+).{0,200}?u=${p[1].replace(/[+*.?^$()|[\]\\]/g, "\\$&")}`, "i"));
    if (target) return decodeURIComponent(target[1]);
  }
  return rawHref;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#\d+;/g, "").replace(/\s+/g, " ").trim();
}

function detectCurrencyQuery(q: string): { from: string; to: string } | null {
  const l = q.toLowerCase();
  if (/dolar|dólar|usd/.test(l) && !/euro|gbp|libra/.test(l)) {
    return /canad|cad/.test(l) ? { from: "CAD", to: "BRL" } : { from: "USD", to: "BRL" };
  }
  if (/euro|eur/.test(l)) return { from: "EUR", to: "BRL" };
  if (/libra|gbp|esterlin/.test(l)) return { from: "GBP", to: "BRL" };
  if (/iene|jpy|yen/.test(l)) return { from: "JPY", to: "BRL" };
  if (/bitcoin|btc/.test(l)) return { from: "BTC", to: "BRL" };
  const m = l.match(/\b([a-z]{3})\s*(?:to|\/|para)\s*([a-z]{3})\b/);
  return m ? { from: m[1].toUpperCase(), to: m[2].toUpperCase() } : null;
}

async function fetchExchangeRate(from: string, to: string): Promise<SearchResult | null> {
  const res = await fetch(`https://economia.awesomeapi.com.br/json/last/${from}-${to}`, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const d: any = await res.json();
  const row = d?.[`${from}${to}`];
  if (!row) return null;
  const bid = Number(row.bid), high = Number(row.high), low = Number(row.low), pct = Number(row.pctChange);
  return {
    title: `${from}/${to} — R$ ${bid.toFixed(4)}`,
    url: `https://economia.awesomeapi.com.br/last/${from}-${to}`,
    snippet: `Cotação: 1 ${from} = R$ ${bid.toFixed(4)} ${pct >= 0 ? "↑" : "↓"} ${pct.toFixed(2)}% | Mín ${low.toFixed(4)} · Máx ${high.toFixed(4)}`,
  };
}

async function tryInstantAnswer(query: string): Promise<SearchResult[]> {
  const res = await fetch(`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`, {
    headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(7000),
  });
  if (!res.ok) return [];
  const d: any = await res.json();
  const out: SearchResult[] = [];
  if (d.AbstractText) out.push({ title: d.Heading || query, url: d.AbstractURL || "", snippet: d.AbstractText });
  if (d.Answer) out.push({ title: "Resposta direta", url: "", snippet: String(d.Answer) });
  if (d.Definition) out.push({ title: d.Heading || query, url: d.DefinitionURL || "", snippet: d.Definition });
  if (Array.isArray(d.RelatedTopics)) {
    for (const t of d.RelatedTopics.slice(0, 4)) {
      if (t.Text && t.FirstURL) out.push({ title: t.Text.split(" - ")[0].slice(0, 80), url: t.FirstURL, snippet: t.Text });
      if (Array.isArray(t.Topics)) for (const s of t.Topics.slice(0, 2))
        if (s.Text && s.FirstURL) out.push({ title: s.Text.split(" - ")[0].slice(0, 80), url: s.FirstURL, snippet: s.Text });
    }
  }
  return out;
}

async function tryDdgLite(query: string, maxResults: number): Promise<SearchResult[]> {
  const res = await fetch(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, {
    headers: { ...FETCH_HEADERS, "Referer": "https://lite.duckduckgo.com/" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`DDG lite HTTP ${res.status}`);
  return parseLinksGeneric(await res.text(), maxResults);
}

function parseLinksGeneric(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Snippets: result-snippet class, or any <td> with >30 chars and no <a>
  const snippetRe = /<td[^>]*class="[^"]*result-snippet[^"]*"[^>]*>([\s\S]*?)<\/td>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) snippets.push(stripTags(sm[1]).trim());
  if (snippets.length === 0) {
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
    while ((sm = tdRe.exec(html))) {
      const t = stripTags(sm[1]).trim();
      if (t.length > 30 && !/^\d+\.\s*$/.test(t) && !/<a\s/i.test(sm[1])) snippets.push(t);
    }
  }

  // Links: rel="nofollow" OR class="result__a"
  const linkRe = /<a[^>]+(?:rel="nofollow"|class="[^"]*result__a[^"]*")[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let lm: RegExpExecArray | null, si = 0;
  while ((lm = linkRe.exec(html)) && results.length < maxResults) {
    const href = lm[1], title = stripTags(lm[2]).trim();
    if (!title || /^\d+\.\s*$/.test(title) || isAd(href)) continue;
    const url = resolveDdgUrl(href);
    if (!url || url.startsWith("javascript:")) continue;
    results.push({ title, url, snippet: snippets[si] || "" });
    si++;
  }
  return results;
}

async function tryDdgHtmlPost(query: string, maxResults: number): Promise<SearchResult[]> {
  const res = await fetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: { ...FETCH_HEADERS, "Content-Type": "application/x-www-form-urlencoded", "Referer": "https://html.duckduckgo.com/" },
    body: `q=${encodeURIComponent(query)}`,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`DDG html HTTP ${res.status}`);
  return parseLinksGeneric(await res.text(), maxResults);
}

async function tryBing(query: string, maxResults: number): Promise<SearchResult[]> {
  const res = await fetch(`https://www.bing.com/search?q=${encodeURIComponent(query)}&setlang=pt-BR`, {
    headers: { ...FETCH_HEADERS, "Referer": "https://www.bing.com/" },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`Bing HTTP ${res.status}`);
  const html = await res.text();
  const results: SearchResult[] = [];

  const blockRe = /<li[^>]+class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  let bm: RegExpExecArray | null;
  while ((bm = blockRe.exec(html)) && results.length < maxResults) {
    const block = bm[1];
    const lm = block.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!lm) continue;
    const href = stripTags(lm[1]).trim(), title = stripTags(lm[2]).trim();
    if (!title || isAd(href)) continue;
    const url = resolveBingUrl(href, html);
    let snippet = "";
    const pm = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    if (pm) snippet = stripTags(pm[1]);
    results.push({ title, url, snippet });
  }
  return results;
}