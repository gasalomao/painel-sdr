/**
 * Cliente do chat.deepseek.com — reverse engineering do app web.
 *
 * ⚠ AVISO IMPORTANTE: chat.deepseek.com NÃO é uma API pública. Esta camada
 *   imita o que o site faz internamente quando o usuário manda uma mensagem.
 *   Funciona enquanto o DeepSeek não mudar a rota/payload — quando mudar, este
 *   arquivo é o ÚNICO que precisa ser atualizado.
 *
 * Proteções embutidas (NÃO eliminam o risco de ban, só reduzem):
 *   - Headers de browser real (User-Agent moderno, Origin, Referer, etc.).
 *   - Rate-limit por token (1 req a cada N ms, configurável via env).
 *   - HTTP proxy opcional (DEEPSEEK_HTTP_PROXY=http://user:pass@host:port).
 *   - Auto-pausa do token quando upstream devolve 401/403 (token revogado).
 *   - Cria UMA chat_session por chamada e descarta — não acumula histórico
 *     no lado do DeepSeek (menor footprint pra detectar como bot).
 *
 * NÃO faz:
 *   - Fingerprint randomization (não vale a guerra de gatos).
 *   - Resolver cloudflare turnstile (se cair nisso, falha e ponto).
 *   - Multi-conta-de-uma-IP (passe um proxy diferente por instância se quiser).
 */

import { autoPauseToken, type DsFingerprint } from "./deepseek-chat-manager";

const UPSTREAM = process.env.DEEPSEEK_CHAT_BASE || "https://chat.deepseek.com";
// Min ms entre requests do MESMO token. 4s = ~15 req/min — abaixo do que um
// humano digita em rajada, conservador.
const MIN_INTERVAL_MS = Math.max(1000, Number(process.env.DEEPSEEK_CHAT_MIN_INTERVAL_MS) || 4000);
const HTTP_PROXY = process.env.DEEPSEEK_HTTP_PROXY || "";

// Fingerprint default (usado quando o token ainda não tem um — tokens antigos
// criados antes do feature de fingerprint estável).
const DEFAULT_FINGERPRINT: DsFingerprint = {
  ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  locale: "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
  secChUa: '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
  secChUaPlatform: '"Windows"',
  appVersion: "20241129.5",
};

/**
 * Monta os headers de browser pra ESTA conta. Headers ESTÁVEIS por token —
 * uma conta sempre manda o mesmo User-Agent (mudar toda hora seria suspeito),
 * mas DIFERENTES contas têm fingerprints diferentes (parece N pessoas reais).
 */
function browserHeaders(fp: DsFingerprint, token: string): Record<string, string> {
  const locale = fp.locale.split(",")[0]?.replace("-", "_") || "pt_BR";
  return {
    "Accept": "*/*",
    "Accept-Language": fp.locale,
    "Authorization": `Bearer ${token}`,
    "Content-Type": "application/json",
    "Origin": "https://chat.deepseek.com",
    "Referer": "https://chat.deepseek.com/",
    "Sec-Ch-Ua": fp.secChUa,
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": fp.secChUaPlatform,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    "User-Agent": fp.ua,
    "x-app-version": fp.appVersion,
    "x-client-locale": locale,
    "x-client-platform": "web",
    "x-client-version": "1.0.0-always",
  };
}

// Cooldown por token — não persiste entre restarts (in-memory). Suficiente: o
// painel raramente reinicia no meio de uso, e o pior caso é dar um disparo
// extra na 1ª request pós-restart, o que é aceitável.
const LAST_CALL = new Map<string, number>();

async function rateLimit(tokenId: string): Promise<void> {
  const last = LAST_CALL.get(tokenId) || 0;
  const wait = MIN_INTERVAL_MS - (Date.now() - last);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  LAST_CALL.set(tokenId, Date.now());
}

/** Resolve o `dispatcher` da undici quando um HTTP proxy estiver setado. */
let cachedDispatcher: any | null | undefined;
async function getDispatcher(): Promise<any | null> {
  if (cachedDispatcher !== undefined) return cachedDispatcher;
  if (!HTTP_PROXY) { cachedDispatcher = null; return null; }
  try {
    // undici está no graph do Next.js (transitivo) — `eval`+`import()` evita
    // tanto o type-resolve (sem @types/undici) quanto o bundling estático.
    // Se não estiver presente, cai no fetch normal sem proxy.
    const dynamicImport = new Function("m", "return import(m)") as (m: string) => Promise<any>;
    const u: any = await dynamicImport("undici");
    if (u?.ProxyAgent) cachedDispatcher = new u.ProxyAgent(HTTP_PROXY);
    else cachedDispatcher = null;
    return cachedDispatcher;
  } catch {
    cachedDispatcher = null;
    return null;
  }
}

async function ds(method: string, path: string, token: string, fp: DsFingerprint, body?: unknown): Promise<Response> {
  const dispatcher = await getDispatcher();
  const init: any = {
    method,
    headers: browserHeaders(fp, token),
    body: body ? JSON.stringify(body) : undefined,
  };
  if (dispatcher) init.dispatcher = dispatcher;
  return fetch(`${UPSTREAM}${path}`, init);
}

/** Erro tipado com flag de "token morto" pra o caller auto-pausar. */
export class DsUpstreamError extends Error {
  status: number;
  tokenDead: boolean;
  constructor(status: number, message: string, tokenDead = false) {
    super(message);
    this.status = status;
    this.tokenDead = tokenDead;
  }
}

/**
 * Cria uma session vazia — chat.deepseek.com exige um chat_session_id antes
 * de mandar uma completion. Descartamos depois da conversa (não persistimos).
 */
async function createSession(token: string, fp: DsFingerprint): Promise<string> {
  const res = await ds("POST", "/api/v0/chat_session/create", token, fp, { agent: "chat" });
  if (res.status === 401 || res.status === 403) {
    throw new DsUpstreamError(res.status, "Token rejeitado pelo DeepSeek (expirou ou foi revogado).", true);
  }
  if (!res.ok) {
    const txt = (await res.text().catch(() => "")).slice(0, 200);
    throw new DsUpstreamError(res.status, `Falha ao criar sessão DeepSeek (HTTP ${res.status}): ${txt}`);
  }
  const j: any = await res.json().catch(() => null);
  const id = j?.data?.biz_data?.id || j?.data?.id || j?.id;
  if (!id) throw new DsUpstreamError(500, "DeepSeek não devolveu chat_session_id.");
  return String(id);
}

/**
 * Roda uma completion e retorna a string final + tokens estimados. Buffer-isa
 * o stream SSE do upstream (mais simples e suficiente: nosso /chat/completions
 * pode devolver streaming ou non-stream a partir disso).
 *
 * O `prompt` que o chat.deepseek.com recebe é o ÚLTIMO turn do usuário; ele
 * NÃO suporta histórico explícito (a sessão guarda). Aqui contornamos isso
 * concatenando o histórico em texto único no prompt — comportamento próximo
 * ao esperado pela maioria dos chamadores.
 */
export async function chatComplete(args: {
  tokenId: string;
  token: string;
  fingerprint?: DsFingerprint;
  model: string;     // "deepseek-chat" | "deepseek-reasoner"
  prompt: string;
  signal?: AbortSignal;
}): Promise<{ content: string; usage: { promptTokens: number; completionTokens: number } }> {
  await rateLimit(args.tokenId);
  const fp = args.fingerprint || DEFAULT_FINGERPRINT;
  const thinking = /reason/i.test(args.model);

  let sessionId: string;
  try {
    sessionId = await createSession(args.token, fp);
  } catch (e: any) {
    if (e instanceof DsUpstreamError && e.tokenDead) autoPauseToken(args.tokenId, "token rejeitado");
    throw e;
  }

  const dispatcher = await getDispatcher();
  const init: any = {
    method: "POST",
    headers: {
      ...browserHeaders(fp, args.token),
      Accept: "text/event-stream",
    },
    body: JSON.stringify({
      chat_session_id: sessionId,
      parent_message_id: null,
      prompt: args.prompt,
      ref_file_ids: [],
      thinking_enabled: thinking,
      search_enabled: false,
    }),
    signal: args.signal,
  };
  if (dispatcher) init.dispatcher = dispatcher;
  const res = await fetch(`${UPSTREAM}/api/v0/chat/completion`, init);

  if (res.status === 401 || res.status === 403) {
    autoPauseToken(args.tokenId, "token rejeitado");
    throw new DsUpstreamError(res.status, "Token rejeitado pelo DeepSeek (expirou ou foi revogado).", true);
  }
  if (res.status === 429) {
    autoPauseToken(args.tokenId, "rate-limit/429");
    throw new DsUpstreamError(429, "DeepSeek devolveu 429 — esta conta foi pausada automaticamente. Retome em 1 hora ou troque pra outra conta.", true);
  }
  if (!res.ok || !res.body) {
    const txt = (await res.text().catch(() => "")).slice(0, 200);
    throw new DsUpstreamError(res.status, `Upstream DeepSeek HTTP ${res.status}: ${txt}`);
  }

  // Parse SSE: linhas "data: {...}". Cada evento traz fragmento de texto. Os
  // nomes exatos dos campos variam — tentamos vários: choices[].delta.content,
  // delta, content, message.content. Acumulamos tudo que for string.
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let content = "";
  let promptTokens = 0;
  let completionTokens = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let j: any;
      try { j = JSON.parse(payload); } catch { continue; }
      const piece =
        j?.choices?.[0]?.delta?.content ??
        j?.choices?.[0]?.message?.content ??
        j?.delta?.content ??
        j?.content ??
        "";
      if (typeof piece === "string") content += piece;
      // Métrica é opcional — usa se DeepSeek mandar; senão estima depois.
      if (typeof j?.usage?.prompt_tokens === "number") promptTokens = j.usage.prompt_tokens;
      if (typeof j?.usage?.completion_tokens === "number") completionTokens = j.usage.completion_tokens;
    }
  }
  // Estimativa rude (4 chars ≈ 1 token) só pra OpenAI-shape ficar completo.
  if (!promptTokens) promptTokens = Math.ceil(args.prompt.length / 4);
  if (!completionTokens) completionTokens = Math.ceil(content.length / 4);
  return { content, usage: { promptTokens, completionTokens } };
}

/**
 * Achata um histórico OpenAI-shape (`messages[]`) num único prompt textual,
 * que é o que o chat.deepseek.com aceita. Mantém papéis com prefixo simples.
 */
export function messagesToPrompt(messages: Array<{ role?: string; content?: any }>): string {
  const parts: string[] = [];
  for (const m of messages || []) {
    const role = (m?.role || "user").toLowerCase();
    const content = typeof m?.content === "string" ? m.content
      : Array.isArray(m?.content)
        // OpenAI vision-shape: array de partes; pegamos só texto.
        ? m.content.filter((p: any) => p?.type === "text" || typeof p?.text === "string").map((p: any) => p.text || "").join("\n")
        : "";
    if (!content.trim()) continue;
    if (role === "system") parts.push(`[Sistema]\n${content}`);
    else if (role === "assistant") parts.push(`[Assistente]\n${content}`);
    else parts.push(`[Usuário]\n${content}`);
  }
  return parts.join("\n\n");
}

/** Lista estática dos modelos que o chat expõe (2025). Se mudar, edite aqui. */
export const DEEPSEEK_CHAT_MODELS = [
  { id: "deepseek-chat", description: "DeepSeek V3 (modelo padrão do chat)" },
  { id: "deepseek-reasoner", description: "DeepSeek R1 — modo raciocínio (mais lento, melhor em mate/lógica)" },
];
