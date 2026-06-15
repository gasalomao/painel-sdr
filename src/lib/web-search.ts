/**
 * Tool web_search — busca rápida na internet sem precisar de API key.
 *
 * Estratégia (em ordem de prioridade):
 *   1. Detector de câmbio  → AwesomeAPI (BR, sem chave) — preciso e instantâneo
 *   2. DDG Instant Answer  → fatos/definições rápidas (Wikipedia)
 *   3. DDG Lite HTML       → resultados gerais (lite.duckduckgo.com — sem captcha como o html.duckduckgo.com tem)
 *
 * Disponível pra qualquer modelo (Gemini, Claude, etc.) via function calling.
 */

export type SearchResult = { title: string; url: string; snippet: string };

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Busca principal — tenta cada estratégia até ter resultado útil */
export async function webSearch(query: string, maxResults = 5): Promise<SearchResult[]> {
  if (!query || !query.trim()) return [];
  const q = query.trim();

  // 1) Câmbio — detecta padrões tipo "valor do dólar", "USD", "USD to BRL" etc.
  const fx = detectCurrencyQuery(q);
  if (fx) {
    const r = await fetchExchangeRate(fx.from, fx.to).catch(() => null);
    if (r) return [r];
  }

  // 2) Instant Answer (rápido pra fatos/definições)
  const inst = await tryInstantAnswer(q).catch(() => [] as SearchResult[]);
  if (inst.length > 0) return inst.slice(0, maxResults);

  // 3) DDG Lite HTML (busca geral)
  const lite = await tryDdgLite(q, maxResults).catch(() => [] as SearchResult[]);
  if (lite.length > 0) return lite;

  return [];
}

/* ============================================================
   1) DETECTOR + FETCH DE CÂMBIO (AwesomeAPI)
   ============================================================ */

function detectCurrencyQuery(q: string): { from: string; to: string } | null {
  const lower = q.toLowerCase();
  // Casos comuns em PT
  if (/dolar|dólar|usd/.test(lower) && !/euro|gbp|libra/.test(lower)) {
    if (/canad|cad/.test(lower)) return { from: "CAD", to: "BRL" };
    return { from: "USD", to: "BRL" };
  }
  if (/euro|eur/.test(lower)) return { from: "EUR", to: "BRL" };
  if (/libra|gbp|esterlin/.test(lower)) return { from: "GBP", to: "BRL" };
  if (/iene|jpy|yen/.test(lower)) return { from: "JPY", to: "BRL" };
  if (/bitcoin|btc/.test(lower)) return { from: "BTC", to: "BRL" };
  // Padrão "USD to BRL" / "USD/BRL"
  const m = lower.match(/\b([a-z]{3})\s*(?:to|\/|para)\s*([a-z]{3})\b/);
  if (m) return { from: m[1].toUpperCase(), to: m[2].toUpperCase() };
  return null;
}

async function fetchExchangeRate(from: string, to: string): Promise<SearchResult | null> {
  const url = `https://economia.awesomeapi.com.br/json/last/${from}-${to}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) return null;
  const data = await res.json();
  const key = `${from}${to}`;
  const row = data?.[key];
  if (!row) return null;
  const bid = Number(row.bid);
  const high = Number(row.high);
  const low = Number(row.low);
  const pct = Number(row.pctChange);
  const updatedAt = row.create_date || row.timestamp;
  const arrow = pct >= 0 ? "↑" : "↓";
  const snippet = `Cotação atual: 1 ${from} = R$ ${bid.toFixed(4)} ${arrow} ${pct.toFixed(2)}% hoje | Mín R$ ${low.toFixed(4)} · Máx R$ ${high.toFixed(4)} | Atualizado: ${updatedAt}`;
  return {
    title: `${from}/${to} — R$ ${bid.toFixed(4)}`,
    url: `https://economia.awesomeapi.com.br/last/${from}-${to}`,
    snippet,
  };
}

/* ============================================================
   2) DDG INSTANT ANSWER (Wikipedia-like)
   ============================================================ */

async function tryInstantAnswer(query: string): Promise<SearchResult[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(7000) });
  if (!res.ok) return [];
  const d: any = await res.json();
  const out: SearchResult[] = [];
  if (d.AbstractText) out.push({ title: d.Heading || query, url: d.AbstractURL || "", snippet: d.AbstractText });
  if (d.Answer)        out.push({ title: d.AnswerType || "Resposta direta", url: "", snippet: String(d.Answer) });
  if (d.Definition)    out.push({ title: d.Heading || query, url: d.DefinitionURL || "", snippet: d.Definition });
  if (Array.isArray(d.RelatedTopics)) {
    for (const t of d.RelatedTopics.slice(0, 3)) {
      if (t.Text && t.FirstURL) out.push({ title: t.Text.split(" - ")[0], url: t.FirstURL, snippet: t.Text });
    }
  }
  return out;
}

/* ============================================================
   3) DDG LITE HTML (busca geral — endpoint que NÃO bloqueia)
   ============================================================ */

async function tryDdgLite(query: string, maxResults: number): Promise<SearchResult[]> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": BROWSER_UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      "Referer": "https://lite.duckduckgo.com/",
    },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`DDG lite HTTP ${res.status}`);
  const html = await res.text();

  // Parse: cada resultado é uma <a rel="nofollow" href="..."> ... </a>
  // Snippet costuma vir em <td class="result-snippet"> ... </td>
  const results: SearchResult[] = [];
  const linkRe = /<a[^>]+rel="nofollow"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  // Snippets em ordem (alinhamos por índice)
  const snippetRe = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;
  const snippets: string[] = [];
  let sm: RegExpExecArray | null;
  while ((sm = snippetRe.exec(html))) snippets.push(stripTags(sm[1]).trim());

  let lm: RegExpExecArray | null;
  let i = 0;
  while ((lm = linkRe.exec(html)) && results.length < maxResults) {
    const rawHref = lm[1];
    const title = stripTags(lm[2]).trim();
    if (!title || /^\d+\.\s*$/.test(title)) continue;

    // Pula anúncios (DDG redireciona via /y.js?ad_...)
    if (rawHref.includes("/y.js?ad_") || rawHref.includes("ad_provider=") || rawHref.includes("/ad?")) {
      continue;
    }

    const realUrl = rawHref.startsWith("//duckduckgo.com/l/?")
      ? decodeURIComponent(("//" + rawHref).match(/uddg=([^&]+)/)?.[1] || rawHref)
      : rawHref.startsWith("//")
        ? "https:" + rawHref
        : rawHref;
    results.push({ title, url: realUrl, snippet: snippets[i] || "" });
    i++;
  }
  return results;
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}
