/**
 * lead-intelligence — gera briefing IA pra cada lead, reaproveitado em:
 *   - /leads (modal "Analisar com IA")
 *   - /disparo (enriquece personalização de cada msg)
 *   - /automacao (mesmo, antes de criar a campanha)
 *
 * Filosofia: 1 análise por lead, cacheada em `leads_extraidos.intelligence`.
 * Re-análise só se forçada OU se passou >30 dias (lead pode ter mudado).
 *
 * Custo por lead: ~1k tokens (input pequeno + output JSON). Em conta com
 * 1000 leads, custo total ~R$ 1-3 dependendo do modelo.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { logTokenUsage, extractGeminiUsage } from "@/lib/token-usage";

export interface LeadIntelligenceSources {
  /** Trecho do site oficial que foi usado como contexto (até 1500 chars). */
  site_excerpt?: string;
  /** URL do site coletado. */
  site_url?: string;
  /** Páginas internas visitadas no crawl (home + sobre + servicos + ...). */
  site_pages_visited?: string[];
  /** Se o site foi descoberto via busca (não estava cadastrado no lead). */
  site_discovered?: boolean;
  /** URL do Instagram detectado (se houver). */
  instagram_url?: string;
  /** Bio/descrição extraída do Instagram. */
  instagram_excerpt?: string;
  /** URL do Facebook detectado. */
  facebook_url?: string;
  /** Resultados da busca sobre o lead específico (já filtrados por relevância). */
  search_lead: Array<{ title: string; snippet: string; url: string }>;
  /** Resultados da busca sobre concorrentes/top players. */
  search_competitors: Array<{ title: string; snippet: string; url: string }>;
  /** Modelo usado na análise. */
  model_used?: string;
  /** Quando rodou. */
  analyzed_at?: string;
  /** Reflexão preliminar do "think pass" (raciocínio da IA antes do JSON). */
  reflection?: string;
}

export interface LeadIntelligence {
  icp_score: number;              // 0-100, fit com cliente ideal
  lead_type: "b2b_recurring" | "b2c_oneshot" | "mixed" | "unknown";
  dores: string[];                // 2-4 dores prováveis específicas do nicho
  abordagem: string;              // 1 frase: como abordar (NÃO o copy final)
  decisor: string;                // quem provavelmente decide a compra
  alerta?: string;                // compliance/sazonalidade/risco que afeta abordagem
  concorrente_local?: string;     // se identificável, nome de concorrente direto
  briefing_md: string;            // markdown legível pra mostrar no modal
  /** Fontes brutas que alimentaram a análise. Mostradas na UI pra
   *  transparência ("a IA chegou nessa conclusão olhando ISTO"). */
  sources?: LeadIntelligenceSources;
}

/** Estrutura mínima do lead que precisamos pra analisar. */
export interface LeadInput {
  id?: number | null;
  remoteJid: string;
  nome_negocio: string | null;
  ramo_negocio: string | null;
  categoria?: string | null;
  endereco?: string | null;
  website?: string | null;
  avaliacao?: number | string | null;
  reviews?: number | string | null;
}

/** TTL pra reanálise. 30 dias — lead pode ter mudado de status, contratado concorrente, etc. */
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Logger interno: tudo que o lead-intelligence faz vai pra console com prefixo
 * `[lead-intel]` pra fácil filtragem (ex: `kubectl logs ... | grep lead-intel`).
 * Inclui timestamp + tag de subsistema.
 */
function liLog(tag: string, msg: string, extra?: any) {
  const ts = new Date().toISOString().slice(11, 23);
  if (extra !== undefined) console.log(`[${ts}][lead-intel:${tag}] ${msg}`, extra);
  else console.log(`[${ts}][lead-intel:${tag}] ${msg}`);
}

/**
 * Extrai cidade + estado de um endereço estilo Google Maps.
 * Ex: "R. X, 123 - Bairro, São Paulo - SP, 01000-000" → { cidade: "São Paulo", estado: "SP" }
 */
function extractLocation(endereco: string | null | undefined): { cidade: string; estado: string; full: string } {
  if (!endereco) return { cidade: "", estado: "", full: "" };
  const parts = endereco.split(",").map(s => s.trim()).filter(Boolean);
  let estado = "";
  let cidade = "";
  // Estado: token "XX - SP" ou só "SP" no final.
  const ufRe = /\b(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)\b/;
  for (const p of parts) {
    const m = p.match(ufRe);
    if (m) { estado = m[1]; break; }
  }
  // Cidade: a parte que contém o UF, sem o UF e sem CEP.
  for (const p of parts) {
    if (ufRe.test(p)) {
      cidade = p.replace(ufRe, "").replace(/[-–—]/g, " ").replace(/\d{5}-?\d{3}/, "").replace(/\s+/g, " ").trim();
      break;
    }
  }
  // Fallback: se não achou pelo UF, pega penúltima parte (heurística de Maps).
  if (!cidade && parts.length >= 2) {
    cidade = parts[parts.length - 2].replace(ufRe, "").replace(/\d{5}-?\d{3}/, "").trim();
  }
  return { cidade, estado, full: [cidade, estado].filter(Boolean).join(" - ") };
}

/** Domínios que NÃO devem ser tratados como "site oficial" do lead. */
const NON_OFFICIAL_HOSTS = [
  "google.", "maps.google", "g.co", "goo.gl",
  "facebook.com", "fb.com", "instagram.com", "linkedin.com", "twitter.com", "x.com",
  "youtube.com", "tiktok.com", "wa.me", "whatsapp.com", "t.me",
  "yelp.", "tripadvisor.", "foursquare.", "ifood.", "uber",
  "reclameaqui.", "consumidor.gov", "procon",
  "guiamais.", "telelistas.", "apontador.", "encontraempresa.", "econodata.",
  "cnpj.biz", "casadosdados.", "consultapublica.", "cadastrodeempresas.",
  "olx.", "mercadolivre.", "americanas.", "magazineluiza.",
  "wikipedia.", "wikimapia.",
  "duckduckgo.", "bing.com",
];
function isOfficialCandidate(host: string): boolean {
  const h = host.toLowerCase();
  return !NON_OFFICIAL_HOSTS.some(bad => h.includes(bad));
}
function safeHost(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

/** Normaliza string pra comparação: minúsculo, sem acento, sem pontuação. */
function norm(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Heurística: o snippet/título parece falar do MESMO negócio (mesmo nome) ou em outra cidade? */
function isResultRelevant(
  r: { title: string; snippet: string; url: string },
  leadName: string,
  cidade: string,
): boolean {
  const haystack = norm(`${r.title} ${r.snippet} ${r.url}`);
  const nameTokens = norm(leadName).split(" ").filter(t => t.length >= 3).slice(0, 4);
  // Pelo menos 1 token forte do nome precisa aparecer.
  const nameHit = nameTokens.length === 0 || nameTokens.some(t => haystack.includes(t));
  if (!nameHit) return false;
  // Se o snippet menciona explicitamente OUTRA capital/cidade longe e a nossa cidade
  // não aparece, descarta. (não tenta ser perfeito; só corta o lixo óbvio).
  if (cidade) {
    const cidadeNorm = norm(cidade);
    const cidadeHit = haystack.includes(cidadeNorm) || cidadeNorm.split(" ").every(p => haystack.includes(p));
    if (!cidadeHit) {
      // Se algum outro estado/UF gritante aparece, descarta.
      const otherUfMention = /\b(em|de|na|no) (rio de janeiro|sao paulo|belo horizonte|porto alegre|curitiba|salvador|recife|fortaleza|brasilia|manaus|belem|goiania)\b/.test(haystack);
      if (otherUfMention) return false;
    }
  }
  return true;
}

/**
 * Heurística: o texto extraído é majoritariamente boilerplate de privacidade/LGPD/cookies?
 * Se sim, é lixo pra análise comercial — a IA ia inventar "dores de LGPD" pra qualquer
 * negócio que tenha banner de cookie (ou seja, todos).
 */
function isPrivacyBoilerplate(text: string): boolean {
  if (!text) return true;
  const lower = text.toLowerCase();
  const privacyTerms = [
    "lgpd", "política de privacidade", "politica de privacidade",
    "cookies", "cookie", "dados pessoais", "titular dos dados",
    "consentimento", "anpd", "tratamento de dados", "termos de uso",
    "encarregado de dados", "dpo",
  ];
  let hits = 0;
  for (const t of privacyTerms) {
    const matches = lower.match(new RegExp(t, "g"));
    if (matches) hits += matches.length;
  }
  // Densidade alta de termos de privacidade num texto curto = página de política.
  const density = hits / Math.max(1, text.split(/\s+/).length / 100); // hits por 100 palavras
  return density > 2.5;
}

/**
 * Extrai TÍTULOS (H1-H3) do HTML — sinalização semântica forte sobre o que a empresa oferece.
 * Em muitos sites os títulos são literalmente "Nossos Serviços", "Sobre Nós", "Atendimento 24h",
 * que dão uma costela do negócio em poucos tokens.
 */
/**
 * Jina AI Reader — fetcher LLM-native que renderiza JS via Puppeteer headless Chrome.
 * Resolve o problema de sites SPA (React/Vue/Next/Wix/Squarespace/Webflow) que o
 * fetch direto não consegue ler — vem só o shell HTML vazio.
 *
 * URL: https://r.jina.ai/<URL>
 * Free tier: 500 req/min, 10M tokens credit, SEM CADASTRO.
 * Com JINA_API_KEY (env): rate-limit maior, melhor pra batch.
 *
 * Retorna Markdown já limpo. Latência ~2-8s por página (vale pelo conteúdo renderizado).
 */
async function jinaReaderFetch(url: string): Promise<{ markdown: string; title?: string } | null> {
  if (!url || !url.startsWith("http")) return null;
  const key = process.env.JINA_API_KEY;
  const t0 = Date.now();
  try {
    const r = await fetch(`https://r.jina.ai/${url}`, {
      signal: AbortSignal.timeout(20000),
      headers: {
        ...(key ? { "Authorization": `Bearer ${key}` } : {}),
        "Accept": "application/json",
        "X-Return-Format": "markdown",
        "X-With-Generated-Alt": "true", // gera alt text descritivo onde faltar
      },
    });
    if (!r.ok) {
      liLog("jina", `❌ ${url} → HTTP ${r.status} (${Date.now() - t0}ms)`);
      return null;
    }
    const data: any = await r.json().catch(() => null);
    const md: string = data?.data?.content || data?.content || "";
    if (!md || md.length < 50) {
      liLog("jina", `⚠️ ${url} → sem conteúdo (${md?.length || 0} chars, ${Date.now() - t0}ms)`);
      return null;
    }
    liLog("jina", `✅ ${url} → ${md.length} chars markdown (${Date.now() - t0}ms${key ? ", auth" : ", free"})`);
    return { markdown: md, title: data?.data?.title || data?.title };
  } catch (e: any) {
    liLog("jina", `💥 ${url} → ${e?.message || e} (${Date.now() - t0}ms)`);
    return null;
  }
}

/**
 * Firecrawl — top de mercado pra scraping LLM-friendly. Retorna Markdown estruturado.
 * Requer FIRECRAWL_API_KEY. Cobra por crédito ($0.001 cada). Use só se Jina falhar
 * em sites particularmente difíceis (Cloudflare agressivo).
 */
async function firecrawlScrape(url: string): Promise<string | null> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return null;
  const t0 = Date.now();
  try {
    const r = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      signal: AbortSignal.timeout(30000),
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: false,
        waitFor: 2000,
      }),
    });
    if (!r.ok) {
      liLog("firecrawl", `❌ ${url} → HTTP ${r.status} (${Date.now() - t0}ms)`);
      return null;
    }
    const data: any = await r.json().catch(() => null);
    const md = data?.data?.markdown || null;
    liLog("firecrawl", `${md ? "✅" : "⚠️"} ${url} → ${md?.length || 0} chars (${Date.now() - t0}ms)`);
    return md;
  } catch (e: any) {
    liLog("firecrawl", `💥 ${url} → ${e?.message || e} (${Date.now() - t0}ms)`);
    return null;
  }
}

/**
 * Extrai TODOS os blocos JSON-LD (schema.org) do HTML. Negócios sérios marcam
 * dados estruturados aqui pra SEO: nome, endereço, telefone, openingHours,
 * services, sameAs (redes sociais), aggregateRating, founder, employees, etc.
 *
 * Sinal MUITO forte — vem direto da fonte oficial sem ambiguidade.
 */
function extractJsonLd(html: string): any[] {
  const out: any[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const raw = m[1].trim().replace(/<!--[\s\S]*?-->/g, "");
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) out.push(...parsed);
      else if (parsed && typeof parsed === "object") {
        if (parsed["@graph"] && Array.isArray(parsed["@graph"])) out.push(...parsed["@graph"]);
        else out.push(parsed);
      }
    } catch {
      // Alguns sites embutem JSON quebrado; ignora.
    }
  }
  return out;
}

/** Achata um objeto JSON-LD em linhas "campo: valor" pra prompt de IA. */
function formatJsonLd(items: any[]): string {
  if (items.length === 0) return "";
  const lines: string[] = [];
  const flat = (obj: any, prefix: string): void => {
    if (obj === null || obj === undefined) return;
    if (Array.isArray(obj)) {
      obj.slice(0, 10).forEach((v, i) => flat(v, `${prefix}[${i}]`));
      return;
    }
    if (typeof obj !== "object") {
      const str = String(obj).replace(/\s+/g, " ").trim();
      if (str.length > 0 && str.length < 800) lines.push(`${prefix}: ${str}`);
      return;
    }
    for (const [k, v] of Object.entries(obj)) {
      if (k.startsWith("@") && k !== "@type") continue;
      const path = prefix ? `${prefix}.${k}` : k;
      flat(v, path);
    }
  };
  for (const it of items) {
    flat(it, "");
    lines.push("---");
  }
  return lines.join("\n").slice(0, 3000);
}

/**
 * Extrai alt text de imagens — costuma descrever serviços, equipe, instalações.
 * Filtra ruído ("logo", "icone", "imagem 1").
 */
function extractImageAlts(html: string, max = 40): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<img[^>]*\balt=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < max) {
    const text = m[1].replace(/\s+/g, " ").trim();
    if (!text || text.length < 5 || text.length > 200) continue;
    if (/^(logo|icone|icon|imagem|image|foto|photo|banner|img|picture|fundo|background|loading|placeholder|avatar|seta|arrow|menu|close|fechar|abrir|open|search|busca|whatsapp|facebook|instagram|youtube|linkedin)\d*$/i.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/**
 * Extrai srcs de iframes — formulários (Google Forms, Typeform), mapas embed,
 * vídeos (YouTube/Vimeo). Útil pra detectar que o lead usa ferramenta X.
 */
function extractIframeSources(html: string, max = 10): string[] {
  const out: string[] = [];
  const re = /<iframe[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < max) {
    const url = m[1].trim();
    if (!url) continue;
    let host = "";
    try { host = new URL(url, "https://example.com").hostname; } catch {}
    if (!host) continue;
    out.push(`${host}: ${url.slice(0, 200)}`);
  }
  return out;
}

function extractHeadings(html: string, max = 60): string[] {
  const out: string[] = [];
  const re = /<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < max) {
    const lvl = m[1];
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text && text.length >= 3 && text.length <= 200) {
      if (/cookie|privacidade|lgpd|política/i.test(text)) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue; // dedupe
      seen.add(key);
      out.push(`H${lvl}: ${text}`);
    }
  }
  return out;
}

/**
 * Extrai itens de listas (ul/ol li) — costuma ser onde sites listam SERVIÇOS,
 * BENEFÍCIOS, ETAPAS DO PROCESSO. Sinal forte sobre o que a empresa oferece.
 */
function extractListItems(html: string, max = 80): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < max) {
    const text = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!text || text.length < 5 || text.length > 200) continue;
    if (/^(home|sobre|contato|menu|whatsapp|facebook|instagram|youtube|linkedin)$/i.test(text)) continue;
    if (/cookie|privacidade|lgpd|política de/i.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/**
 * Extrai conteúdo principal do HTML — prioriza <main>/<article>, descarta nav/footer/aside,
 * remove banners de cookie e seções de privacidade. Devolve texto limpo, focado no core
 * comercial (sobre nós, serviços, home).
 */
function extractMainContent(html: string, mode: "narrow" | "wide" = "wide"): string {
  // Mata script/style/noscript/svg primeiro.
  let h = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[^>]*>[\s\S]*?<\/svg>/gi, " ");

  // Remove blocos de nav/footer/aside/form (menus + LGPD/cookies/formulários).
  h = h
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form[^>]*>[\s\S]*?<\/form>/gi, " ");

  // Remove blocos identificados como cookie banner / privacy notice.
  h = h.replace(
    /<(div|section)[^>]*(cookie|consent|privacy|lgpd|gdpr)[^>]*>[\s\S]*?<\/\1>/gi,
    " ",
  );

  // No modo "narrow", tenta restringir ao <main>/<article>. No modo "wide" (default
  // do crawl profundo), captura TUDO do body — não perde conteúdo que está em divs
  // genéricas (muito comum em sites WordPress/Wix/genéricos).
  if (mode === "narrow") {
    const mainMatch = h.match(/<main[^>]*>([\s\S]*?)<\/main>/i)
      || h.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    if (mainMatch) h = mainMatch[1];
  } else {
    // Wide: extrai do <body> em diante (descarta head com tags meta repetidas).
    const bodyMatch = h.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) h = bodyMatch[1];
  }

  // Preserva quebras lógicas: blocos viram \n, depois colapsa.
  h = h.replace(/<\/(p|div|section|h[1-6]|li|tr|td|article)>/gi, "$&\n");
  const text = h.replace(/<[^>]+>/g, " ").replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  return text;
}

/**
 * Tenta descobrir TODAS as URLs do site via sitemap.xml.
 * Sites bem feitos publicam um sitemap com tudo; é a forma mais completa de
 * mapear estrutura. Suporta sitemap_index aninhado (1 nível).
 */
async function fetchSitemapUrls(
  origin: string,
  fetchHtml: (u: string) => Promise<string>,
): Promise<string[]> {
  const candidates = [
    "/sitemap.xml", "/sitemap_index.xml", "/sitemap-index.xml",
    "/wp-sitemap.xml", "/sitemap1.xml", "/sitemaps.xml",
  ];
  const allUrls = new Set<string>();
  const subSitemaps = new Set<string>();

  const parseXml = (xml: string) => {
    const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
      const u = m[1].trim();
      if (!u.startsWith(origin)) continue;
      if (/\.xml(\.gz)?$/i.test(u)) subSitemaps.add(u);
      else allUrls.add(u.split("#")[0].split("?")[0]);
    }
  };

  for (const path of candidates) {
    const xml = await fetchHtml(origin + path);
    if (xml && xml.length > 50 && xml.includes("<loc")) {
      parseXml(xml);
      if (allUrls.size > 0 || subSitemaps.size > 0) break;
    }
  }

  // Resolve sitemaps aninhados (paralelo, max 5).
  if (subSitemaps.size > 0 && allUrls.size === 0) {
    const subs = Array.from(subSitemaps).slice(0, 5);
    const xmls = await Promise.all(subs.map(fetchHtml));
    for (const xml of xmls) if (xml) parseXml(xml);
  }

  return Array.from(allUrls);
}

/** Paths internos que costumam concentrar conteúdo comercial relevante. */
const VALUABLE_PATHS = /\/(sobre|quem.somos|empresa|institucional|servicos?|produtos?|solucoes|atendimento|portfolio|cases|clientes|trabalhos|projetos|areas?|especialidades|equipe|time|nosso|home|inicio)\b/i;

/** Paths que devemos pular (login, carrinho, política, blog, etc — não são pitch comercial). */
const SKIP_PATHS = /\/(politica|privac|cookie|lgpd|termos?|terms|carrinho|cart|checkout|login|cadastro|conta|wp-admin|wp-login|feed|rss|sitemap|tag\/|category\/|categoria\/|author\/|page\/\d+|\.pdf|\.zip|\.jpg|\.png|\.gif|\.svg|\.webp)/i;

/**
 * Crawl PROFUNDO de site — homepage + páginas internas relevantes.
 *
 * Ao invés de raspar só uma página (que pode ser pobre, ou cair em política de cookies),
 * faz mini-spider: a partir da homepage descobre links internos, prioriza paths como
 * /sobre, /servicos, /produtos, /portfolio, e raspa até `maxPages` páginas em paralelo.
 *
 * Cada página entra como uma SEÇÃO marcada no texto final, dando à IA contexto rico
 * e estruturado em vez de só uma sopa de palavras da home.
 *
 * Budget padrão: 5 páginas, ~10k chars total. Suficiente pra IA mapear ramo, serviços,
 * tom, público-alvo, sem estourar contexto.
 */
async function deepScrapeWebsite(
  rootUrl: string | null,
  budget: { maxPages?: number; maxChars?: number; perPageChars?: number } = {},
): Promise<{ text: string; visited: string[] }> {
  if (!rootUrl || !rootUrl.startsWith("http")) return { text: "", visited: [] };
  // Defaults agressivos: até 25 páginas, 50k chars total, 4k por página.
  // Empresa típica de PME tem 5-15 páginas — cabe TUDO incluindo schema.org,
  // alts, iframes, markdown JS-rendered. Sites grandes ficam limitados ao top-N
  // por score. Gemini suporta 1M tokens — 50k chars é peanuts.
  const maxPages = budget.maxPages ?? 25;
  const maxChars = budget.maxChars ?? 50000;
  const perPageChars = budget.perPageChars ?? 4000;
  const FETCH_CONCURRENCY = 5; // paralelos; conservador pra Jina (500/min)

  let origin = "";
  try { origin = new URL(rootUrl).origin; } catch { return { text: "", visited: [] }; }
  liLog("crawl", `🌐 INICIANDO crawl: ${rootUrl} (max ${maxPages}p, ${maxChars} chars)`);

  const fetchHtml = async (u: string): Promise<string> => {
    try {
      const r = await fetch(u, {
        signal: AbortSignal.timeout(8000),
        redirect: "follow",
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; LeadIntel/1.0)",
          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        },
      });
      if (!r.ok) return "";
      return r.text();
    } catch { return ""; }
  };

  /**
   * Fetcher COMPLETO de uma página: pega html bruto (pra JSON-LD/alts/iframes/links)
   * + markdown renderizado (Jina Reader → Firecrawl → fallback no html bruto).
   * Tudo em paralelo. Latência limitada pelo provider mais lento (~5-8s).
   */
  const fetchPageRich = async (u: string): Promise<{ html: string; markdown: string }> => {
    const [html, jina, fire] = await Promise.all([
      fetchHtml(u),
      jinaReaderFetch(u),
      firecrawlScrape(u), // null se sem key
    ]);
    const markdown = (jina?.markdown || fire || "").trim();
    return { html, markdown };
  };

  // ── Estágio 1: descoberta dupla — sitemap + homepage links ──
  // Home é fetched RICH (html + markdown via Jina pra capturar JS render).
  // Sitemap usa só fetch direto (XML, não precisa de render).
  const homeUrl = origin + "/";
  const [homeRich, sitemapUrls] = await Promise.all([
    fetchPageRich(homeUrl),
    fetchSitemapUrls(origin, fetchHtml),
  ]);

  let effectiveHome = homeRich;
  let effectiveHomeUrl = homeUrl;
  // Se a home raiz falhou MAS temos a URL original que veio do lead, tenta ela.
  if (!effectiveHome.html && !effectiveHome.markdown && rootUrl !== homeUrl) {
    const alt = await fetchPageRich(rootUrl);
    if (alt.html || alt.markdown) {
      effectiveHome = alt;
      effectiveHomeUrl = rootUrl;
    }
  }
  liLog("crawl", `🗺️ sitemap: ${sitemapUrls.length} URLs · 🏠 home: ${effectiveHome.html ? "html✓" : "html✗"} ${effectiveHome.markdown ? "md✓" : "md✗"}`);
  if (!effectiveHome.html && !effectiveHome.markdown && sitemapUrls.length === 0) {
    liLog("crawl", `❌ Falhou: nem home nem sitemap acessíveis`);
    return { text: "", visited: [] };
  }

  // ── Estágio 2: coletar links internos da home (menu + corpo) ──
  const allCandidates = new Map<string, { url: string; anchor: string; score: number }>();
  if (effectiveHome.html) {
    const linkRe = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(effectiveHome.html))) {
      const href = m[1].trim();
      if (!href || href.startsWith("#") || /^(mailto:|tel:|javascript:|whatsapp:|https:\/\/wa\.me)/i.test(href)) continue;
      let abs = "";
      try { abs = new URL(href, effectiveHomeUrl).toString(); } catch { continue; }
      abs = abs.split("#")[0];
      try { const u = new URL(abs); abs = u.origin + u.pathname; } catch {}
      if (!abs.startsWith(origin)) continue;
      if (SKIP_PATHS.test(abs)) continue;
      if (abs === effectiveHomeUrl || abs === homeUrl) continue;
      const anchor = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      let score = 1; // base: todo link interno tem valor
      if (VALUABLE_PATHS.test(abs)) score += 10;
      const a = norm(anchor);
      if (/sobre|empresa|quem|servic|produto|solu|portfolio|cases|atend|especialidad|trabalh|equipe|time|cliente|contato|blog|faq/.test(a)) score += 5;
      if (anchor.length > 0 && anchor.length < 50) score += 1;
      const prev = allCandidates.get(abs);
      if (!prev || prev.score < score) allCandidates.set(abs, { url: abs, anchor, score });
    }
  }

  // ── Estágio 3: mescla sitemap (todas as páginas catalogadas) ──
  for (const u of sitemapUrls) {
    if (SKIP_PATHS.test(u)) continue;
    if (u === effectiveHomeUrl || u === homeUrl) continue;
    let score = 2; // sitemap = página oficial, score base maior
    if (VALUABLE_PATHS.test(u)) score += 10;
    const prev = allCandidates.get(u);
    if (!prev || prev.score < score) allCandidates.set(u, { url: u, anchor: "", score });
  }

  // ── Estágio 4: top-N por score ──
  const ranked = Array.from(allCandidates.values()).sort((a, b) => b.score - a.score);
  const toFetch = ranked.slice(0, maxPages - 1).map(c => c.url);
  liLog("crawl", `🎯 ${allCandidates.size} candidatos → top ${toFetch.length}: ${toFetch.slice(0, 5).map(u => new URL(u).pathname).join(", ")}${toFetch.length > 5 ? "..." : ""}`);

  // ── Estágio 5: fetch RICH em chunks (html bruto + markdown JS-rendered em paralelo) ──
  const subRich: Array<{ html: string; markdown: string }> = new Array(toFetch.length).fill({ html: "", markdown: "" });
  for (let i = 0; i < toFetch.length; i += FETCH_CONCURRENCY) {
    const chunk = toFetch.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.all(chunk.map(fetchPageRich));
    for (let j = 0; j < results.length; j++) subRich[i + j] = results[j];
  }

  // ── Estágio 6: extrai blocos ULTRA-RICOS de cada página ──
  // Cada bloco junta TUDO que existe na página:
  //   - Title, OG, Meta, Keywords (head)
  //   - JSON-LD schema.org (dados estruturados oficiais)
  //   - H1-H4 (estrutura semântica)
  //   - Listas/itens <li> (serviços, benefícios)
  //   - Alt text de imagens (descrições de serviço)
  //   - Iframes/embeds (formulários, mapas, vídeos)
  //   - Markdown renderizado via Jina (captura conteúdo SPA/JS)
  //   - Conteúdo extraído do html bruto (fallback)
  type Block = { url: string; section: string; content: string };
  const blocks: Block[] = [];

  const buildBlock = (
    url: string,
    rich: { html: string; markdown: string },
    sectionName: string,
  ): Block | null => {
    const { html, markdown } = rich;
    if (!html && !markdown) return null;

    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() || "";
    const meta = html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i)?.[1]
              || html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]+)"/i)?.[1]
              || "";
    const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i)?.[1] || "";
    const keywords = html.match(/<meta[^>]*name="keywords"[^>]*content="([^"]+)"/i)?.[1] || "";
    const jsonLd = formatJsonLd(extractJsonLd(html));
    const headings = extractHeadings(html);
    const items = extractListItems(html);
    const alts = extractImageAlts(html);
    const iframes = extractIframeSources(html);
    const mainHtml = extractMainContent(html, "wide");

    // Conteúdo principal: prefere markdown do Jina (JS-rendered) se for >2x maior
    // que o extraído do html bruto. Senão usa o html bruto como base.
    let mainText = mainHtml;
    if (markdown && markdown.length > mainHtml.length * 1.5) {
      mainText = markdown;
    } else if (markdown && !mainHtml) {
      mainText = markdown;
    }

    const isPolicyPage = isPrivacyBoilerplate(mainText);
    if (isPolicyPage && !meta && headings.length === 0 && items.length === 0 && !jsonLd) return null;

    const parts: string[] = [];
    if (title && !/cookie|privac|lgpd/i.test(title)) parts.push(`Title: ${title.slice(0, 200)}`);
    if (ogTitle && ogTitle !== title) parts.push(`OG: ${ogTitle.slice(0, 200)}`);
    if (meta && !isPrivacyBoilerplate(meta)) parts.push(`Meta: ${meta.slice(0, 500)}`);
    if (keywords) parts.push(`Keywords: ${keywords.slice(0, 300)}`);
    if (jsonLd) parts.push(`Schema.org JSON-LD (dados estruturados oficiais):\n${jsonLd}`);
    if (headings.length > 0) parts.push(`Títulos:\n${headings.join("\n")}`);
    if (items.length > 0) parts.push(`Listas/Itens:\n• ${items.slice(0, 50).join("\n• ")}`);
    if (alts.length > 0) parts.push(`Imagens (alt text):\n• ${alts.slice(0, 30).join("\n• ")}`);
    if (iframes.length > 0) parts.push(`Iframes/Embeds:\n• ${iframes.join("\n• ")}`);
    if (mainText && !isPolicyPage) parts.push(`Conteúdo:\n${mainText}`);
    if (parts.length === 0) return null;

    let content = parts.join("\n\n");
    if (content.length > perPageChars) content = content.slice(0, perPageChars) + "…";
    return { url, section: sectionName, content };
  };

  const homeBlock = buildBlock(effectiveHomeUrl, effectiveHome, "HOME");
  if (homeBlock) blocks.push(homeBlock);

  for (let i = 0; i < toFetch.length; i++) {
    const url = toFetch[i];
    let section = "PAGINA";
    try {
      const segs = new URL(url).pathname.split("/").filter(Boolean);
      if (segs.length > 0) {
        section = segs.slice(-2).join(" / ").toUpperCase().replace(/[-_]/g, " ").slice(0, 60);
      }
    } catch {}
    const b = buildBlock(url, subRich[i], section);
    if (b) blocks.push(b);
  }

  if (blocks.length === 0) return { text: "", visited: [] };

  // ── Estágio 7: concat respeitando budget total ──
  let total = "";
  const visited: string[] = [];
  for (const b of blocks) {
    const block = `\n## ${b.section} (${b.url})\n${b.content}\n`;
    if (total.length + block.length > maxChars) {
      const remaining = maxChars - total.length;
      if (remaining > 300) {
        total += block.slice(0, remaining) + "…";
        visited.push(b.url);
      }
      break;
    }
    total += block;
    visited.push(b.url);
  }

  liLog("crawl", `✅ FIM: ${visited.length} páginas, ${total.length}/${maxChars} chars`);
  return { text: total.trim(), visited };
}

/**
 * Busca via Tavily (LLM-native search). Free tier 1.000 queries/mês.
 * Retorna snippets já curados pra contexto de IA — muito mais limpo que DDG.
 * Requer env TAVILY_API_KEY. Retorna null se não configurado.
 *
 * Doc: https://docs.tavily.com/  | search_depth=advanced melhora ranking pra B2B.
 */
async function tavilySearch(
  query: string,
  maxResults = 5,
): Promise<Array<{ title: string; snippet: string; url: string }> | null> {
  const key = process.env.TAVILY_API_KEY;
  if (!key) return null;
  const t0 = Date.now();
  try {
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      signal: AbortSignal.timeout(12000),
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
      body: JSON.stringify({
        query,
        search_depth: "advanced",
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false,
      }),
    });
    if (!r.ok) {
      liLog("tavily", `❌ "${query}" → HTTP ${r.status} (${Date.now() - t0}ms)`);
      return null;
    }
    const data = await r.json();
    if (!Array.isArray(data?.results)) {
      liLog("tavily", `⚠️ "${query}" → resposta sem results (${Date.now() - t0}ms)`);
      return null;
    }
    const out = data.results.map((it: any) => ({
      title: String(it.title || ""),
      snippet: String(it.content || "").slice(0, 500),
      url: String(it.url || ""),
    }));
    liLog("tavily", `✅ "${query}" → ${out.length} resultados (${Date.now() - t0}ms)`);
    return out;
  } catch (e: any) {
    liLog("tavily", `💥 "${query}" → ${e?.message || e} (${Date.now() - t0}ms)`);
    return null;
  }
}

/**
 * Busca via Brave Search API. Latência mais baixa do mercado (669ms média),
 * índice independente. Free tier 2.000/mês. Requer env BRAVE_SEARCH_API_KEY.
 *
 * Doc: https://api-dashboard.search.brave.com/app/documentation/web-search/get-started
 */
async function braveSearch(
  query: string,
  maxResults = 5,
): Promise<Array<{ title: string; snippet: string; url: string }> | null> {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return null;
  const t0 = Date.now();
  try {
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}&country=BR&search_lang=pt`;
    const r = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      headers: { "Accept": "application/json", "X-Subscription-Token": key },
    });
    if (!r.ok) {
      liLog("brave", `❌ "${query}" → HTTP ${r.status} (${Date.now() - t0}ms)`);
      return null;
    }
    const data = await r.json();
    const items = data?.web?.results || [];
    const out = items.slice(0, maxResults).map((it: any) => ({
      title: String(it.title || ""),
      snippet: String(it.description || "").replace(/<[^>]+>/g, "").slice(0, 500),
      url: String(it.url || ""),
    }));
    liLog("brave", `✅ "${query}" → ${out.length} resultados (${Date.now() - t0}ms)`);
    return out;
  } catch (e: any) {
    liLog("brave", `💥 "${query}" → ${e?.message || e} (${Date.now() - t0}ms)`);
    return null;
  }
}

/**
 * Busca web com fallback em cascata: Tavily → Brave → DuckDuckGo HTML.
 *
 * Tavily é o melhor pra B2B research (LLM-native, snippets curados). Brave é
 * #2 em qualidade. DDG HTML é o último recurso — sem API key, mas ruidoso.
 *
 * Configurar uma das APIs (TAVILY_API_KEY ou BRAVE_SEARCH_API_KEY) melhora
 * dramaticamente a precisão das análises.
 */
async function webSearch(query: string, maxResults = 5): Promise<Array<{ title: string; snippet: string; url: string }>> {
  if (!query?.trim()) return [];

  // Provider 1: Tavily (melhor pra contexto de IA)
  const tav = await tavilySearch(query, maxResults);
  if (tav && tav.length > 0) { liLog("search", `→ tavily`); return tav; }

  // Provider 2: Brave (rápido, índice independente)
  const brave = await braveSearch(query, maxResults);
  if (brave && brave.length > 0) { liLog("search", `→ brave`); return brave; }

  // Provider 3: DuckDuckGo HTML (sem key, fallback)
  liLog("search", `→ ddg fallback "${query}"`);
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const r = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      },
    });
    if (!r.ok) return [];
    const html = await r.text();

    // DDG HTML retorna `<a class="result__a" href="URL">TITLE</a>` + `<a class="result__snippet">SNIPPET</a>`.
    // Regex simples — o markup é estável.
    const results: Array<{ title: string; snippet: string; url: string }> = [];
    const linkRe = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const links: Array<{ url: string; title: string }> = [];
    const snips: string[] = [];

    let m: RegExpExecArray | null;
    while ((m = linkRe.exec(html)) && links.length < maxResults * 2) {
      // DDG mascara URL — descodifica `uddg=`
      const raw = m[1];
      const real = raw.match(/uddg=([^&]+)/);
      const finalUrl = real ? decodeURIComponent(real[1]) : raw;
      const title = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      links.push({ url: finalUrl, title });
    }
    while ((m = snipRe.exec(html)) && snips.length < maxResults * 2) {
      snips.push(m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
    }

    for (let i = 0; i < Math.min(links.length, maxResults); i++) {
      results.push({
        title: links[i].title,
        url: links[i].url,
        snippet: snips[i] || "",
      });
    }
    return results;
  } catch {
    return [];
  }
}

/**
 * Descobre site oficial / Instagram / Facebook do lead via busca web.
 * Usado quando o lead não tem website cadastrado.
 *
 * Estratégia: 2 buscas direcionadas com cidade + nome. Classifica os resultados
 * por tipo de domínio. Retorna o primeiro candidato de cada tipo que parece
 * relevante (matching de nome + cidade).
 */
async function discoverPresence(
  leadName: string,
  cidade: string,
  estado: string,
): Promise<{ website?: string; instagram?: string; facebook?: string; raw: Array<{ title: string; snippet: string; url: string }> }> {
  if (!leadName) return { raw: [] };
  const loc = [cidade, estado].filter(Boolean).join(" ");
  // 2 buscas: 1 ampla (qualquer canal) + 1 focada em Instagram (alta chance pra negócio pequeno).
  const [generic, ig] = await Promise.all([
    webSearch(`"${leadName}" ${loc} site oficial OR contato`, 8),
    webSearch(`"${leadName}" ${loc} instagram`, 5),
  ]);
  const all = [...generic, ...ig].filter(r => isResultRelevant(r, leadName, cidade));

  let website: string | undefined;
  let instagram: string | undefined;
  let facebook: string | undefined;

  for (const r of all) {
    const host = safeHost(r.url);
    if (!host) continue;
    const lower = host.toLowerCase();
    if (!instagram && lower.includes("instagram.com")) {
      // só perfil (instagram.com/handle), descarta /p/ /reel/ etc.
      const path = (() => { try { return new URL(r.url).pathname; } catch { return ""; } })();
      const seg = path.split("/").filter(Boolean)[0];
      if (seg && !["p", "reel", "reels", "explore", "tags", "accounts"].includes(seg)) {
        instagram = `https://www.instagram.com/${seg}/`;
      }
    } else if (!facebook && (lower.includes("facebook.com") || lower.includes("fb.com"))) {
      facebook = r.url;
    } else if (!website && isOfficialCandidate(host)) {
      website = r.url;
    }
    if (website && instagram && facebook) break;
  }

  return { website, instagram, facebook, raw: all };
}

/**
 * Raspa página pública do Instagram. Retorna bio/descrição extraída de meta tags.
 * IG bloqueia muito; se cair, retorna "".
 */
async function scrapeInstagram(url: string | null): Promise<string> {
  if (!url) return "";
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; facebookexternalhit/1.1; +http://www.facebook.com/externalhit_uatext.php)",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      },
    });
    if (!r.ok) return "";
    const html = await r.text();
    // og:description tem "X seguidores, Y seguindo, Z posts - Veja fotos... de @user (Bio)".
    const og = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]+)"/i);
    const desc = html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);
    const title = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i);
    const parts = [title?.[1], og?.[1] || desc?.[1]].filter(Boolean).join(" — ");
    return parts.replace(/\s+/g, " ").trim().slice(0, 800);
  } catch {
    return "";
  }
}

/** Formata resultados de busca pra texto compacto pro prompt. */
function searchResultsToText(results: Array<{ title: string; snippet: string; url: string }>): string {
  if (results.length === 0) return "(nenhum resultado relevante encontrado)";
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}\nFonte: ${r.url}`)
    .join("\n\n");
}

/**
 * CONTEXTO DO VENDEDOR — ancora TODA a análise.
 *
 * Sem isso, a IA lista dores reais do lead mas que a nossa oferta não resolve
 * (ex: "concorrência da Contabilizei" é dor real do contador, mas vendemos IA,
 * não software contábil). Esse bloco redireciona o foco pra dores que NOSSA
 * oferta efetivamente sana.
 *
 * Pode ser sobrescrito por:
 *   - opts.sellerContext em analyzeLead (override por chamada)
 *   - app_settings.value where key='seller_offering_context' (override global)
 */
const DEFAULT_SELLER_CONTEXT = `═══════ CONTEXTO DO VENDEDOR (LEIA ANTES DE TUDO) ═══════
Quem está prospectando este lead VENDE AUTOMAÇÃO COM IA. Nossa oferta resolve:

  • ATENDIMENTO AO CLIENTE com IA — chatbot/agente em WhatsApp/site/chat respondendo
    24/7, qualificando leads, agendando reuniões, tirando dúvidas frequentes,
    triando solicitações, recuperando carrinho/orçamento abandonado.

  • PROCESSOS INTERNOS automatizados com IA — geração de relatórios, preenchimento
    de planilhas/sistemas, follow-up automático com cliente, lembretes, integrações
    entre ferramentas, documentação automática, resposta de e-mails repetitivos.

  • SDR/VENDAS com IA — qualificação de leads, prospecção automatizada, mensagens
    personalizadas em escala, recuperação de leads frios, agendamento.

  • SUPORTE com IA — FAQ inteligente, triagem de tickets, primeiro nível resolvido
    sem humano, escalonamento só do que precisa.

═══════ COMO ISSO MUDA SUA ANÁLISE ═══════
As "dores" que você listar DEVEM SER DORES QUE NOSSA OFERTA RESOLVE. Olhe o lead e
pergunte:
  → Onde os sócios/funcionários dele gastam horas em tarefas repetitivas?
  → Onde os clientes dele esperam demais por uma resposta?
  → Onde leads dele são perdidos por falta de follow-up?
  → Que dúvida o time dele responde 50x por semana?
  → Que processo manual é gargalo recorrente?

Para CADA dor que listar, seja capaz de responder: "isso é resolvível com IA?"
Se a resposta for não, NÃO LISTE essa dor — ela não nos serve.

EXEMPLOS BONS (contador pequeno):
  ✓ "Sócios respondendo dúvidas fiscais repetitivas no WhatsApp — IA de atendimento liberaria horas/semana"
  ✓ "Follow-up de envio de documentos do cliente cai no esquecimento — automação com lembretes resolve"
  ✓ "Triagem de PJs novos consumindo tempo do dono antes de saber se é fit — IA qualifica e agenda só os bons"

EXEMPLOS RUINS (NÃO USE):
  ✗ "Conformidade LGPD" — não vendemos isso
  ✗ "Concorrência de Contabilizei" — dor real, mas não é dor que IA resolve
  ✗ "Captação de novos clientes" — vago demais; reescreva como "prospecção manual lenta — IA de SDR escalaria"

A "abordagem" deve ser um GANCHO baseado numa dor que IA resolve, e a "Mensagem 0
sugerida" no briefing deve provocar reflexão sobre essa dor específica — não falar
diretamente "compre IA", e SIM perguntar "como vocês lidam hoje com X?".
═══════════════════════════════════════════════════════════
`;

const SYSTEM_PROMPT = `Você é um analista B2B sênior. Recebe dados públicos de um negócio e produz um BRIEFING ESTRATÉGICO pra um SDR usar antes do primeiro contato.

═══════ HIERARQUIA DE EVIDÊNCIA (CRÍTICO) ═══════
A análise DEVE ser ancorada nesta ordem:

1. RAMO/CATEGORIA do Maps + LOCALIZAÇÃO → define o tipo de negócio e suas dores REAIS de mercado.
   Ex: "Escritório de contabilidade em cidade do interior" → dores reais: captação de novos clientes,
   eficiência em fechamento mensal, retenção de clientes contra contadores online (Conta Azul, Contabilizei),
   gestão de prazos fiscais, aumento de ticket médio com serviços extras (BPO, consultoria tributária).

2. AVALIAÇÃO + Nº DE REVIEWS do Maps → sinal de PORTE e MATURIDADE:
   - <10 reviews → micro/recém-aberto, pouca presença digital
   - 10-50 → estabelecido localmente
   - 50-200 → maduro, fluxo consistente
   - 200+ → referência regional
   Avaliação <4.0 → possível dor de reputação. 4.5+ → operação sólida.

3. CONTEÚDO DO SITE — agora vem em CRAWL ESTRUTURADO (homepage + páginas internas como
   ## HOME, ## SOBRE, ## SERVICOS, ## PRODUTOS, ## PORTFOLIO). Use INTENSAMENTE para:
   - Listar SERVIÇOS específicos que ele oferece (cite-os literalmente quando relevante)
   - Identificar PÚBLICO-ALVO declarado (ex: "atendemos condomínios e indústrias")
   - Captar TOM/POSICIONAMENTO (premium? popular? técnico? consultivo?)
   - Detectar DIFERENCIAIS reais (selos, certificações, anos de mercado, equipe)
   - Refinar a abordagem com o vocabulário do próprio lead
   NUNCA derive dores comerciais a partir de texto de política de cookies/LGPD/termos.
   Se uma SEÇÃO específica é só boilerplate de privacidade, ignore-a e use as outras.

4. INSTAGRAM/FACEBOOK → tom de comunicação, público-alvo aparente, frequência de posts.

5. PESQUISA WEB → contexto extra, concorrentes, notícias.

═══════ ARMADILHAS A EVITAR (LEIA) ═══════
✗ NÃO invente "dor de LGPD/segurança de dados" só porque o site tem política de privacidade.
  TODO site tem. Não é sinal de dor — é exigência legal.
✗ NÃO use o conteúdo do site como base pra dores se for boilerplate (cookies, termos).
✗ NÃO sugira ângulo genérico como "fale sobre LGPD/cookies" pra negócio físico local.
  Padaria, oficina, escritório local — a dor REAL é cliente/receita/operação, não compliance.
✗ NÃO dê icp_score 90+ sem evidência forte de fit. Sem dados → score na faixa 40-60.
✗ NÃO copie palavras-chave do site pra dores. Site fala "soluções inovadoras"? Isso não é dor.

═══════ CAMPOS DO JSON ═══════
- "lead_type":
  * b2b_recurring → empresas que cabem contrato/serviço recorrente (prédios, clínicas, escolas, indústrias, restaurantes). Maior LTV.
  * b2c_oneshot → consumidor final ou serviço pontual.
  * mixed → atende ambos.
  * unknown → não dá pra inferir.

- "icp_score" (0-100): fit com perfil ideal pra COMPRAR AUTOMAÇÃO COM IA (nossa oferta).
  O que aumenta o score: volume operacional alto (muitos clientes/reviews indicam fluxo), atendimento intenso (varejo, serviços, saúde, contabilidade), processos repetitivos manuais visíveis no site (formulários, FAQ, agendamento manual), público B2B/PJ que paga por eficiência.
  O que diminui: micro empresa sem volume (não tem dor de escala), negócio puramente físico sem canais digitais, ramos que já são commodity de IA (ele mesmo já usa).
  Calibre: 90+ = fit perfeito com volume + dor clara visível. 60-80 = ramo certo, porte ok. 40-60 = incerto/dados fracos. <40 = mal-encaixe (sem volume operacional ou sem canais).

- "dores": 2-4 dores REAIS do nicho dele, FILTRADAS PELA NOSSA OFERTA (vide CONTEXTO DO VENDEDOR no topo). Cada dor deve ser solucionável por automação com IA (atendimento/processos/SDR/suporte). Considere porte (reviews) e região.
  ✓ BOM (contador interior): "Sócios respondendo dúvidas fiscais repetitivas no WhatsApp em vez de fechar contratos";
                              "Follow-up de cobrança e envio de docs caindo no esquecimento manual";
                              "Triagem de PJs novos consumindo horas antes de saber se é cliente fit".
  ✗ RUIM: "Conformidade LGPD" (não vendemos isso); "Concorrência da Contabilizei" (não é dor que IA resolve); "Vazamento de dados" (irrelevante).
  Regra: se você não consegue completar a frase "isso é resolvível com IA de atendimento/processos/SDR", a dor NÃO entra.

- "abordagem" (1 frase): gancho de conversa baseado na DOR PRINCIPAL que NOSSA IA resolve nesse contexto.
  ✓ "Provocar reflexão sobre quanto tempo os sócios gastam respondendo dúvidas repetitivas no WhatsApp e mostrar como IA de atendimento devolve esse tempo."
  ✗ "Foco em mitigação de riscos LGPD." (não é o que vendemos)
  ✗ "Mostrar redução de custos." (genérico — aterrar SEMPRE em qual processo a IA assume)

- "decisor": quem decide nesse tipo de empresa, considerando o porte. Em escritório pequeno é o sócio. Em rede grande é gerente comercial.

- "alerta" (opcional): só preencha se houver risco/compliance/sazonalidade ESPECÍFICO e relevante pro RAMO.
  Não use pra observações genéricas sobre o site.

- "concorrente_local" (opcional): só se identificar nome real de concorrente direto na região via pesquisa.

- "briefing_md": markdown 4-8 linhas pro SDR ler em 30s. Use ## headers.
  Estrutura: ## Perfil do Lead (porte + ramo + localização + sinal Maps + serviços observados no site se houver) → ## Estratégia de Abordagem (ancore no PROCESSO MANUAL/REPETITIVO específico que a IA assumiria) → linha final "**Mensagem 0 sugerida (NÃO use literal — adapte):** ...".
  A Mensagem 0 deve PROVOCAR REFLEXÃO sobre uma dor operacional específica que IA resolve — formato bom: "Como vocês lidam hoje com [processo específico do ramo dele]?" ou "Quantas horas por semana o time gasta com [tarefa repetitiva]?". NUNCA mencione cookies/privacidade. NUNCA empurre IA na primeira mensagem — o gancho é a DOR, a oferta vem depois.

FORMATO DE SAÍDA: JSON estrito. Nada além.`;

/**
 * THINK PASS — equivalente ao "think tool" da Anthropic, adaptado pra modelos
 * sem reasoning nativo. Força reflexão estruturada ANTES do output final.
 * Anthropic mediu +54% em domínios complexos com esse padrão.
 *
 * O texto produzido aqui é só pra consumo da própria IA no Pass 2 — não vai
 * pro usuário. Por isso é ok ser verboso e em texto corrido.
 */
const THINK_SYSTEM_PROMPT = `Você é um analista B2B sênior fazendo a ANÁLISE PRELIMINAR de um lead antes de produzir um briefing estruturado. Esta é a etapa de RACIOCÍNIO — pense em voz alta, examine os dados criticamente, identifique armadilhas. NÃO produza JSON aqui; será gerado depois.

ROTEIRO DE PENSAMENTO (siga em ordem, em texto corrido):

1) **TRIAGEM DE SINAIS** — Olhe cada bloco de dado e classifique como FORTE, MÉDIO ou FRACO/RUIDOSO. Sinais fortes: ramo/categoria do Maps, nº reviews (porte), avaliação (reputação), localização. Sinais médios: meta description do site, bio de Instagram. Sinais FRACOS/RUIDOSOS pra descartar: termos de cookies/LGPD/política do site (SEMPRE descarte como dor — todo site tem isso).

2) **ANCORAGEM NO RAMO + FILTRO DA OFERTA** — Esqueça o site um momento. Dado SOMENTE: ramo + cidade + porte (nº reviews), liste mentalmente AS DORES OPERACIONAIS DO DIA-A-DIA deste tipo de negócio. Depois APLIQUE O FILTRO: das dores que você listou, quais são RESOLVÍVEIS PELA OFERTA DESCRITA NO CONTEXTO DO VENDEDOR (automação com IA pra atendimento/processos/SDR/suporte)? Mantenha SÓ essas. Exemplos do filtro funcionando:
   - Contador pequeno: ✓ "atendimento de WhatsApp consumindo horas dos sócios" (IA resolve), ✗ "concorrência da Contabilizei" (IA não resolve esse problema).
   - Padaria: ✓ "atendimento de pedidos via WhatsApp lotando o caixa" (IA resolve), ✗ "margem apertada" (IA não resolve).
   - Clínica: ✓ "secretaria sobrecarregada com agendamento e remarcação" (IA resolve), ✗ "concorrência de planos populares" (IA não resolve).
   Onde o lead GASTA TEMPO/PERDE LEADS/RESPONDE COISA REPETITIVA é onde temos chance.

3) **CALIBRAGEM DE PORTE** — Reviews <10 = micro. 10-50 = pequeno. 50-200 = médio. 200+ = grande. As dores mudam com o porte! Não dê dor de empresa grande (LGPD, ERP) pra micro empresa.

4) **GAPS E INFERÊNCIA** — O que você NÃO sabe? Onde está inferindo? Liste explicitamente. Se não tem site nem IG nem reviews suficientes, diga "informação muito limitada — análise será conservadora".

5) **ICP HONESTO** — Dado os sinais, qual ICP score é HONESTO? Sem evidência forte de fit, fique entre 40-60. Só dê 80+ se múltiplos sinais convergem (porte certo + ramo certo + reputação boa).

6) **ÂNGULO DE ABORDAGEM** — Qual gancho faz sentido pra ESTE negócio especificamente? Tem que ser algo que o dono dele acordou pensando hoje, não algo que parece sofisticado mas é genérico.

Responda em PORTUGUÊS, em texto corrido, sem listas formais nem JSON. Seja objetivo: 8-15 linhas. Termine com uma frase começando com "CONCLUSÃO:" resumindo a tese central pro briefing.`;

function buildUserPrompt(
  lead: LeadInput,
  ctx: {
    websiteUrl?: string;
    websiteText: string;
    websiteDiscovered: boolean;
    instagramUrl?: string;
    instagramText: string;
    facebookUrl?: string;
    cidade: string;
    estado: string;
  },
  searchAboutLead: string,
  searchAboutCompetitors: string,
): string {
  // Sinal de porte derivado de reviews — entrega mastigado pra IA não errar a calibragem.
  const reviewsNum = Number(lead.reviews) || 0;
  const avalNum = Number(lead.avaliacao) || 0;
  let porte = "indeterminado";
  if (reviewsNum >= 200) porte = "GRANDE / referência regional";
  else if (reviewsNum >= 50) porte = "MÉDIO / maduro com fluxo consistente";
  else if (reviewsNum >= 10) porte = "PEQUENO-MÉDIO / estabelecido localmente";
  else if (reviewsNum > 0) porte = "MICRO / pouca presença digital ou recém-aberto";
  let reputacao = "";
  if (avalNum > 0) {
    if (avalNum >= 4.5) reputacao = "sólida";
    else if (avalNum >= 4.0) reputacao = "boa";
    else if (avalNum >= 3.0) reputacao = "média (possível dor de reputação)";
    else reputacao = "ruim (DOR de reputação clara)";
  }

  const lines: string[] = [];
  lines.push("# DADOS DIRETOS DO GOOGLE MAPS (FONTE PRIMÁRIA — ANCORE A ANÁLISE AQUI)");
  lines.push(`- Nome: ${lead.nome_negocio || "(sem nome)"}`);
  if (lead.ramo_negocio) lines.push(`- Ramo: ${lead.ramo_negocio}`);
  if (lead.categoria) lines.push(`- Categoria Maps: ${lead.categoria}`);
  if (lead.endereco) lines.push(`- Endereço: ${lead.endereco}`);
  if (ctx.cidade || ctx.estado) lines.push(`- Localização: ${[ctx.cidade, ctx.estado].filter(Boolean).join(" / ")}`);
  if (avalNum > 0) lines.push(`- Avaliação Google: ${lead.avaliacao}/5 (${lead.reviews || "?"} reviews) → reputação ${reputacao}`);
  lines.push(`- Porte inferido (por nº reviews): ${porte}`);

  // Site — crawl multi-página estruturado em seções (## HOME, ## SOBRE, ## SERVICOS, ...).
  if (ctx.websiteText) {
    const tag = ctx.websiteDiscovered ? " (descoberto via busca)" : "";
    lines.push(`\n# SITE OFICIAL — CRAWL PROFUNDO + JS RENDER + DADOS ESTRUTURADOS${tag}\nURL raiz: ${ctx.websiteUrl}\nO conteúdo abaixo é a EXTRAÇÃO COMPLETA do site (Jina Reader pra renderizar SPA/JS), organizada por seção (## HOME, ## SOBRE, ## SERVICOS, etc). Cada bloco contém:\n  • Title + OG title + Meta description + Keywords (head)\n  • Schema.org JSON-LD — DADOS OFICIAIS estruturados (serviços, horários, telefones, endereços, redes sociais, ratings — quando publicados)\n  • Títulos H1-H4 + Listas/Itens <li> (serviços, benefícios, etapas)\n  • Imagens (alt text) — descrições de fotos do site\n  • Iframes/Embeds — formulários, mapas, vídeos (sinal de processo manual)\n  • Conteúdo principal renderizado (markdown limpo do Jina Reader)\n\nUse INTENSAMENTE pra: identificar TODOS os serviços (cite-os literalmente), público-alvo declarado, tom/posicionamento, diferenciais reais (selos, anos de mercado, certificações), processos manuais visíveis ("preencha formulário", "agende por telefone", "envie WhatsApp" = oportunidade de IA), porte real pelo escopo. NÃO invente dor de LGPD/cookies.\n────────────────\n${ctx.websiteText}\n────────────────`);
  } else if (ctx.websiteUrl) {
    lines.push(`\n# SITE OFICIAL\nURL: ${ctx.websiteUrl}\n(Sem conteúdo comercial extraível — pode ser site bloqueado ou só com política de privacidade. Ignore.)`);
  } else {
    lines.push(`\n# SITE OFICIAL\n(Não localizado — empresa provavelmente pequena. Esse já é um sinal: depende de Maps/redes pra captação.)`);
  }

  // Instagram
  if (ctx.instagramText) {
    lines.push(`\n# INSTAGRAM (perfil público)\nURL: ${ctx.instagramUrl}\n${ctx.instagramText}`);
  } else if (ctx.instagramUrl) {
    lines.push(`\n# INSTAGRAM\nURL: ${ctx.instagramUrl}\n(Bio não pôde ser raspada — Instagram bloqueou.)`);
  }
  if (ctx.facebookUrl) lines.push(`\n# FACEBOOK\nURL: ${ctx.facebookUrl}`);

  lines.push(`\n# PESQUISA WEB SOBRE ESTE LEAD (filtrada por relevância de localização)\n${searchAboutLead || "(sem resultados confiáveis sobre este lead específico)"}`);
  lines.push(`\n# PESQUISA SOBRE TOP PLAYERS DO MESMO NICHO/REGIÃO\n${searchAboutCompetitors || "(sem resultados relevantes)"}`);

  // Sinaliza dados fracos pra IA não inventar.
  const haveSite = !!ctx.websiteText;
  const haveIg = !!ctx.instagramText;
  const haveLeadInfo = haveSite || haveIg || (searchAboutLead && !searchAboutLead.startsWith("("));
  if (!haveLeadInfo) {
    lines.push(`\n# AVISO IMPORTANTE\nDados públicos sobre ESTE lead específico são MUITO escassos. Baseie a análise em:\n- Categoria/ramo do Maps (sinaliza o tipo de negócio)\n- Localização (${ctx.cidade}/${ctx.estado}) e suas características\n- Avaliação/reviews como proxy de maturidade\nNÃO invente fatos sobre o negócio. Se não souber, escreva "não identificado". O icp_score deve refletir a INCERTEZA — não dê 90+ sem evidência.`);
  }

  lines.push(`\n# TAREFA\nProduza o JSON de briefing usando ESTRITAMENTE os dados acima. Foque em estratégia para SDR, não copy. Se identificar concorrentes diretos pelos resultados, cite em "concorrente_local".`);
  return lines.join("\n");
}

/** Resultado de uma análise — pode vir do cache ou nova. */
export interface AnalyzeResult {
  leadId: number;
  intelligence: LeadIntelligence;
  cached: boolean;
  /** Fontes coletadas nesta análise (só preenchido em análise nova, não em cache). */
  sources?: {
    site: boolean;
    site_discovered?: boolean;
    instagram?: boolean;
    facebook?: boolean;
    searchLead: number;        // qtd de resultados de busca sobre o lead (filtrados)
    searchCompetitors: number; // qtd de resultados sobre concorrentes (filtrados)
  };
}

/**
 * Analisa 1 lead. Lê cache se válido; senão chama Gemini, salva, retorna.
 * Use force=true pra forçar reanálise.
 */
export async function analyzeLead(opts: {
  leadId: number;
  apiKey: string;
  model?: string;
  force?: boolean;
  /** Override do contexto do vendedor. Default: AUTOMAÇÃO COM IA. */
  sellerContext?: string;
}): Promise<AnalyzeResult | { error: string }> {
  const { data: lead, error } = await supabaseAdmin
    .from("leads_extraidos")
    .select("id, \"remoteJid\", nome_negocio, ramo_negocio, categoria, endereco, website, avaliacao, reviews, intelligence, intelligence_at, icp_score, lead_type")
    .eq("id", opts.leadId)
    .maybeSingle();
  if (error || !lead) return { error: error?.message || "Lead não encontrado" };

  const tag = `lead-${lead.id}`;
  liLog(tag, `▶️ INÍCIO análise: "${lead.nome_negocio}" (${lead.ramo_negocio || lead.categoria || "?"})`);

  // Cache hit?
  if (!opts.force && lead.intelligence && lead.intelligence_at) {
    const age = Date.now() - new Date(lead.intelligence_at).getTime();
    if (age < CACHE_TTL_MS) {
      liLog(tag, `💾 CACHE hit (${Math.round(age / 86400000)}d) — pulando análise`);
      return {
        leadId: lead.id,
        intelligence: lead.intelligence as LeadIntelligence,
        cached: true,
      };
    }
  }

  // ── Coleta de dados — pipeline em estágios pra maximizar precisão ──
  //
  // Estágio 1 (paralelo): site cadastrado + buscas iniciais (lead + concorrentes).
  // Estágio 2 (condicional): se NÃO há site cadastrado, usa busca pra DESCOBRIR
  //   site oficial / Instagram / Facebook do lead, depois raspa o que achou.
  //
  // Tudo é filtrado por relevância de localização — descarta resultados de
  // outras cidades, portais genéricos (reclameaqui, listas), homônimos.
  const loc = extractLocation(lead.endereco);
  const cidade = loc.cidade;
  const estado = loc.estado;
  const leadName = (lead.nome_negocio || "").trim();
  const ramo = (lead.ramo_negocio || lead.categoria || "").trim();

  // Queries direcionadas com cidade — usar aspas no nome pra não diluir.
  const queryLead = leadName
    ? `"${leadName}" ${[cidade, estado].filter(Boolean).join(" ")}`.trim()
    : "";
  const queryConcorrentes = ramo
    ? `melhores ${ramo} ${[cidade, estado].filter(Boolean).join(" ")}`.trim()
    : "";
  liLog(tag, `📍 ${cidade || "?"}/${estado || "?"} · 🌐 site: ${lead.website || "(não cadastrado)"}`);
  liLog(tag, `🔍 queries — lead: "${queryLead}" · concorrentes: "${queryConcorrentes}"`);

  // Estágio 1.
  const [websiteCadastradoCrawl, searchLeadRaw, searchCompetitorsRaw] = await Promise.all([
    deepScrapeWebsite(lead.website || null),
    queryLead ? webSearch(queryLead, 6) : Promise.resolve([]),
    queryConcorrentes ? webSearch(queryConcorrentes, 5) : Promise.resolve([]),
  ]);
  const websiteCadastradoText = websiteCadastradoCrawl.text;
  let websitePagesVisited = websiteCadastradoCrawl.visited;
  liLog(tag, `📊 site cadastrado → ${websiteCadastradoText.length} chars de ${websitePagesVisited.length} páginas · busca lead: ${searchLeadRaw.length} bruto · concorrentes: ${searchCompetitorsRaw.length} bruto`);

  // Filtra busca do lead por relevância (nome + cidade).
  const searchLead = searchLeadRaw.filter(r => isResultRelevant(r, leadName, cidade)).slice(0, 5);
  // Concorrentes: filtra só por cidade (não bate o nome do lead).
  const searchCompetitors = searchCompetitorsRaw
    .filter(r => {
      const h = norm(`${r.title} ${r.snippet} ${r.url}`);
      if (!cidade) return true;
      const cidadeNorm = norm(cidade);
      return h.includes(cidadeNorm) || cidadeNorm.split(" ").every(p => h.includes(p));
    })
    .slice(0, 5);

  // Estágio 2: descobrir site/redes se o lead não tem website cadastrado.
  let websiteUrl = lead.website || undefined;
  let websiteText = websiteCadastradoText;
  let websiteDiscovered = false;
  let instagramUrl: string | undefined;
  let instagramText = "";
  let facebookUrl: string | undefined;

  // Mesmo se o lead tem site, ainda tentamos achar IG (sinal social útil).
  // Se NÃO tem site, fazemos descoberta completa.
  const needDiscovery = !websiteText;
  if (leadName && (needDiscovery || !instagramUrl)) {
    liLog(tag, `🔎 discovery: lead sem site cadastrado, buscando presença online...`);
    const found = await discoverPresence(leadName, cidade, estado);
    liLog(tag, `🔎 discovery resultado → site: ${found.website || "✗"} · IG: ${found.instagram || "✗"} · FB: ${found.facebook || "✗"}`);
    if (needDiscovery && found.website) {
      websiteUrl = found.website;
      websiteDiscovered = true;
      const crawl = await deepScrapeWebsite(found.website);
      websiteText = crawl.text;
      websitePagesVisited = crawl.visited;
      liLog(tag, `📊 site descoberto crawled → ${websiteText.length} chars de ${websitePagesVisited.length} páginas`);
    }
    if (found.instagram) {
      instagramUrl = found.instagram;
      instagramText = await scrapeInstagram(found.instagram);
      liLog(tag, `📷 IG raspado → ${instagramText.length} chars de bio`);
    }
    if (found.facebook) facebookUrl = found.facebook;
  }
  liLog(tag, `📦 fontes finais: ${searchLead.length} lead-results · ${searchCompetitors.length} concorrentes (após filtro relevância)`);

  // ─── Geração em DOIS passes (think → JSON) ───
  //
  // Pass 1 (THINK): texto livre. A IA reflete sobre os dados, identifica sinais
  //   fortes vs fracos, ancora dores no ramo+porte, e calibra ICP honestamente.
  //   Esse passo é o equivalente ao "think tool" da Anthropic — força reflexão
  //   estruturada ANTES de produzir output. Vale pra QUALQUER modelo (mesmo
  //   sem reasoning nativo), porque é só um round-trip de texto.
  //
  // Pass 2 (JSON): recebe a reflexão como contexto extra e produz o JSON final.
  //
  // Pra modelos que suportam thinking nativo (Gemini 2.5+), também ativamos
  // thinkingBudget=-1 (dinâmico). Modelos que não suportam ignoram o campo.
  const model = opts.model || "gemini-2.5-flash";
  const genai = new GoogleGenerativeAI(opts.apiKey);
  const supportsNativeThinking = /gemini-(2\.5|3)/i.test(model);
  const thinkingCfg: any = supportsNativeThinking
    ? { thinkingConfig: { thinkingBudget: -1 } } // dynamic
    : {};

  // Contexto do vendedor: prioridade opts > app_settings > default.
  // Sem isso, a IA inventa dores que não vendemos. Esse bloco vai NA FRENTE de
  // todo o resto pra dominar a interpretação dos dados.
  let sellerContext = opts.sellerContext || DEFAULT_SELLER_CONTEXT;
  if (!opts.sellerContext) {
    try {
      const { data } = await supabaseAdmin
        .from("app_settings")
        .select("value")
        .eq("key", "seller_offering_context")
        .maybeSingle();
      if (data?.value && typeof data.value === "string" && data.value.trim().length > 50) {
        sellerContext = data.value;
      }
    } catch {}
  }

  const userPromptBase = buildUserPrompt(
    lead as any,
    {
      websiteUrl,
      websiteText,
      websiteDiscovered,
      instagramUrl,
      instagramText,
      facebookUrl,
      cidade,
      estado,
    },
    searchResultsToText(searchLead),
    searchResultsToText(searchCompetitors),
  );

  // ── Pass 1: THINK (reflexão estruturada em texto livre) ──
  let reflexao = "";
  const tThink = Date.now();
  liLog(tag, `🧠 PASS 1 (think) iniciando · modelo=${model} · thinking=${supportsNativeThinking ? "nativo" : "off"} · prompt=${userPromptBase.length} chars`);
  try {
    const thinkModel = genai.getGenerativeModel({
      model,
      systemInstruction: `${sellerContext}\n\n${THINK_SYSTEM_PROMPT}`,
      generationConfig: { temperature: 0.3, ...thinkingCfg } as any,
    });
    const thinkResp = await thinkModel.generateContent(userPromptBase);
    reflexao = (thinkResp.response.text() || "").trim();
    liLog(tag, `🧠 PASS 1 ok → ${reflexao.length} chars de reflexão (${Date.now() - tThink}ms)`);
    try {
      const u = extractGeminiUsage(thinkResp.response);
      await logTokenUsage({
        source: "other",
        sourceLabel: `Lead Intel THINK: ${lead.nome_negocio || lead.remoteJid}`,
        sourceId: String(lead.id),
        model,
        provider: "Gemini",
        ...u,
      });
    } catch {}
  } catch (e: any) {
    liLog(tag, `🧠 PASS 1 FALHOU: ${e?.message || e} — seguindo só com pass 2`);
    reflexao = ""; // se falhar, segue só com o JSON pass — não bloqueia
  }

  // ── Pass 2: JSON final (usa a reflexão como contexto extra) ──
  const m = genai.getGenerativeModel({
    model,
    systemInstruction: `${sellerContext}\n\n${SYSTEM_PROMPT}`,
    generationConfig: { temperature: 0.2, responseMimeType: "application/json", ...thinkingCfg } as any,
  });

  const userPrompt = reflexao
    ? `${userPromptBase}\n\n# ANÁLISE PRELIMINAR (sua própria reflexão — use como base, refine se necessário)\n${reflexao}\n\n# AGORA PRODUZA O JSON FINAL`
    : userPromptBase;
  const tJson = Date.now();
  liLog(tag, `📋 PASS 2 (JSON) iniciando · prompt=${userPrompt.length} chars (com reflexão=${!!reflexao})`);
  const resp = await m.generateContent(userPrompt);
  const raw = resp.response.text();
  liLog(tag, `📋 PASS 2 ok → ${raw.length} chars de JSON (${Date.now() - tJson}ms)`);

  // Token tracking (pass 2).
  try {
    const usage = extractGeminiUsage(resp.response);
    await logTokenUsage({
      source: "other",
      sourceLabel: `Lead Intel: ${lead.nome_negocio || lead.remoteJid}`,
      sourceId: String(lead.id),
      model,
      provider: "Gemini",
      ...usage,
    });
  } catch {}

  let parsed: LeadIntelligence;
  try {
    parsed = JSON.parse(raw);
  } catch {
    liLog(tag, `❌ JSON parse falhou: ${raw.slice(0, 200)}`);
    return { error: "IA não retornou JSON válido" };
  }
  liLog(tag, `✅ FIM: ICP=${parsed.icp_score}, type=${parsed.lead_type}, dores=[${(parsed.dores || []).slice(0, 3).map((d: string) => d.slice(0, 50)).join(" | ")}]`);

  // Defesa: garante campos. Aceita variação de nomes da IA.
  parsed.icp_score = Number(parsed.icp_score) || 50;
  parsed.lead_type = (parsed.lead_type || "unknown") as any;
  parsed.dores = Array.isArray(parsed.dores) ? parsed.dores : [];
  parsed.abordagem = parsed.abordagem || "";
  parsed.decisor = parsed.decisor || "não identificado";
  parsed.briefing_md = parsed.briefing_md || "";

  // Anexa as fontes (transparência: usuário vê o que a IA olhou).
  parsed.sources = {
    site_url: websiteUrl,
    site_excerpt: websiteText ? websiteText.slice(0, 8000) : undefined,
    site_pages_visited: websitePagesVisited.length > 0 ? websitePagesVisited : undefined,
    site_discovered: websiteDiscovered || undefined,
    instagram_url: instagramUrl,
    instagram_excerpt: instagramText || undefined,
    facebook_url: facebookUrl,
    search_lead: searchLead.slice(0, 5),
    search_competitors: searchCompetitors.slice(0, 5),
    model_used: model,
    analyzed_at: new Date().toISOString(),
    reflection: reflexao ? reflexao.slice(0, 2000) : undefined,
  };

  // Salva no DB pra reuso.
  await supabaseAdmin
    .from("leads_extraidos")
    .update({
      icp_score: parsed.icp_score,
      lead_type: parsed.lead_type,
      intelligence: parsed,
      intelligence_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", lead.id);

  return {
    leadId: lead.id,
    intelligence: parsed,
    cached: false,
    sources: {
      site: !!websiteText,
      site_discovered: websiteDiscovered || undefined,
      instagram: !!instagramText,
      facebook: !!facebookUrl,
      searchLead: searchLead.length,
      searchCompetitors: searchCompetitors.length,
    },
  };
}

// Exports auxiliares pra teste/uso externo (UI pode mostrar a localização extraída).
export { extractLocation };

/**
 * Pega o briefing de um lead (do cache) pra usar em personalização.
 * Não chama IA. Retorna null se nunca foi analisado.
 *
 * Usado por: campaign-worker (personalizeWithAI) e automation-worker.
 */
export async function getCachedIntelligence(remoteJid: string): Promise<LeadIntelligence | null> {
  const { data } = await supabaseAdmin
    .from("leads_extraidos")
    .select("intelligence, intelligence_at")
    .eq("remoteJid", remoteJid)
    .maybeSingle();
  if (!data?.intelligence) return null;
  // Mesmo se velho, retorna — quem chama decide. Reanálise só por trigger explícito.
  return data.intelligence as LeadIntelligence;
}

/**
 * Formata o briefing como string compacta pra injetar em prompts de personalização.
 * Mantém poucos tokens — só o essencial pra a IA da personalização entender o contexto.
 */
export function intelligenceToPromptContext(intel: LeadIntelligence | null): string {
  if (!intel) return "";
  const lines: string[] = [];
  lines.push(`[INTEL DO LEAD - use como contexto, NÃO mencione literalmente]`);
  lines.push(`- Tipo: ${intel.lead_type} | ICP score: ${intel.icp_score}/100`);
  if (intel.dores.length > 0) lines.push(`- Dores prováveis: ${intel.dores.slice(0, 3).join("; ")}`);
  if (intel.abordagem) lines.push(`- Ângulo recomendado: ${intel.abordagem}`);
  if (intel.alerta) lines.push(`- Alerta: ${intel.alerta}`);
  return lines.join("\n");
}
