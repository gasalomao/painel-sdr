/**
 * Reviews AI — reúne TODAS as avaliações do Google capturadas de um lead
 * (reviews_detalhes + featured_reviews + review_topics + distribuição de
 * estrelas) e gera um resumo com o modelo de IA escolhido e o prompt
 * escolhido. O resumo fica cacheado no próprio lead
 * (leads_extraidos.resumo_avaliacoes) e é exposto como variável
 * {{resumo_avaliacoes}} nos disparos.
 *
 * Log completo (o que a IA retornou, modelo, prompt, tokens) vai pra
 * reviews_ai_logs.
 *
 * Tolerante a banco antigo: se as colunas/tabela da migração reviews_ai.sql
 * não existirem, o resumo é calculado e retornado mas não persistido
 * (PGRST204 é capturado e ignorado silenciosamente — mesmo padrão do
 * scraper-engine com as colunas do Maps).
 */
import { supabaseAdmin } from "@/lib/supabase_admin";

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias

/** Limite duro do texto de reviews enviado pra IA (~15k chars ≈ 4-5k tokens). */
const MAX_REVIEWS_CHARS = 15000;
/** Cap por avaliação individual — cauda longa de 1 review raramente agrega
 *  sinal novo e estoura o budget em reviews de 3000+ chars. */
const PER_REVIEW_CHAR_CAP = 450;

/** Comprime o texto de 1 review: normaliza espaços e corta em ~450 chars
 *  na última frase completa (nunca no meio da palavra). */
export function compressReviewText(raw: string, cap = PER_REVIEW_CHAR_CAP): string {
  const t = String(raw || "").replace(/\s+/g, " ").trim();
  if (t.length <= cap) return t;
  const cut = t.slice(0, cap);
  const lastStop = Math.max(cut.lastIndexOf("."), cut.lastIndexOf("!"), cut.lastIndexOf("?"));
  return (lastStop > cap * 0.6 ? cut.slice(0, lastStop + 1) : cut.trimEnd()) + "…";
}

/** Faixa de estrelas da review (1-5); 0 = sem nota parseável. */
function starBucket(r: any): number {
  const n = parseFloat(String(r?.nota ?? r?.rating ?? "").replace(",", "."));
  return Number.isFinite(n) && n >= 1 && n <= 5 ? Math.round(n) : 0;
}

export const DEFAULT_REVIEWS_PROMPT = `Você é um analista de reputação. Vai receber as avaliações públicas do Google de um negócio — quando há muitas, vem uma amostra estratificada por nota (1-3★ priorizadas) MAIS a distribuição completa de todas no cabeçalho; use as duas.
Produza um resumo objetivo em PT-BR com esta estrutura exata:

ELOGIOS: o que os clientes mais elogiam (2-4 bullets, com os termos reais usados).
RECLAMAÇÕES: o que os clientes mais reclamam (2-4 bullets — dor real, sem inventar).
GANCHO: 1 frase pronta e específica que um vendedor pode usar numa primeira abordagem, citando um elogio real OU uma dor real.
NOTA GERAL: 1 linha com o tom geral (ex: "reputação sólida, principal dor é demora no atendimento").

Regras: só afirme o que está nas avaliações. Se não houver reclamações, escreva "nenhuma reclamação relevante". Máx 150 palavras.`;

function isMissingColumn(err: any): boolean {
  return err?.code === "PGRST204" || /column .* does not exist/i.test(err?.message || "");
}
function isMissingTable(err: any): boolean {
  return err?.code === "42P01" || /relation .* does not exist/i.test(err?.message || "") || /schema cache .* table/i.test(err?.message || "");
}

/** Linha de review — shape gravado pelo scraper-engine ({autor,nota,data,texto,...}).
 *  AUTOR omitido deliberadamente: é ruído p/ análise de reputação (~20% dos
 *  chars) — o sinal está na nota + data + texto. */
export function formatReviewLine(r: any): string {
  if (!r || typeof r !== "object") return "";
  const nota = r.nota != null && String(r.nota).trim() ? `${String(r.nota).replace(",", ".")}★` : "";
  const data = r.data || r.relative_time || "";
  const texto = compressReviewText(r.texto || r.text || r.comment || "");
  if (!texto) return "";
  return `- (${nota}${data ? ` · ${data}` : ""}) "${texto}"`;
}

/**
 * Monta o texto consolidado de TODAS as avaliações do lead.
 * Combina reviews_detalhes + featured_reviews (dedup, de colunas ou intelligence), tópicos e distribuição.
 */
export function buildReviewsInput(lead: {
  nome_negocio?: string | null;
  ramo_negocio?: string | null;
  categoria?: string | null;
  avaliacao?: any;
  reviews?: any;
  reviews_detalhes?: any;
  featured_reviews?: any;
  review_topics?: any;
  distribuicao_estrelas?: any;
  intelligence?: any;
}): string {
  const intel = lead.intelligence && typeof lead.intelligence === "object" ? lead.intelligence : null;
  const rawReviews = [
    ...(Array.isArray(lead.reviews_detalhes) ? lead.reviews_detalhes : []),
    ...(Array.isArray(lead.featured_reviews) ? lead.featured_reviews : []),
    ...(Array.isArray(intel?.reviews_detalhes) ? intel.reviews_detalhes : []),
    ...(Array.isArray(intel?.featured_reviews) ? intel.featured_reviews : []),
  ];

  const all: any[] = [];
  const seen = new Set<string>();
  for (const r of rawReviews) {
    const line = formatReviewLine(r);
    const sig = line.replace(/^[^"]*/, "").slice(0, 100);
    if (line && !seen.has(sig)) { seen.add(sig); all.push(r); }
  }

  const lines: string[] = [];
  lines.push(`NEGÓCIO: ${lead.nome_negocio || "?"} · RAMO: ${lead.ramo_negocio || lead.categoria || "?"}`);
  const nota = Number(lead.avaliacao);
  if (Number.isFinite(nota) && nota > 0) lines.push(`NOTA MÉDIA GOOGLE: ${nota}/5 (${lead.reviews ?? "?"} avaliações)`);

  const topicsObj = (lead.review_topics && typeof lead.review_topics === "object")
    ? lead.review_topics
    : (intel?.review_topics && typeof intel.review_topics === "object" ? intel.review_topics : null);
  if (topicsObj && Object.keys(topicsObj).length) {
    const topics = Object.entries(topicsObj).map(([k, v]) => `${k}: ${v}`).join(" · ");
    lines.push(`TÓPICOS DO GOOGLE: ${topics}`);
  }

  const distObj = (lead.distribuicao_estrelas && typeof lead.distribuicao_estrelas === "object")
    ? lead.distribuicao_estrelas
    : (intel?.distribuicao_estrelas && typeof intel.distribuicao_estrelas === "object" ? intel.distribuicao_estrelas : null);
  if (distObj && Object.keys(distObj).length) {
    const dist = Object.entries(distObj).map(([k, v]) => `${k}★:${v}`).join(" · ");
    lines.push(`DISTRIBUIÇÃO: ${dist}`);
  }

  // ─── Estratificação por faixa de estrelas ───
  // Problema antigo: incluía as reviews em ordem de chegada até estourar o
  // budget → com 200+ reviews, cortava a cauda INTEIRA (e as 1-2★, mais
  // recentes, sumiam junto). Solução: rodízio entre faixas priorizando
  // as queixas (1-3★ = dor real = gancho de venda), depois 5★/4★, e a
  // distribuição completa de TODAS fica no cabeçalho. Nenhum segmento
  // fica sem representação, e se tudo couber no budget entra tudo.
  const byBucket = new Map<number, any[]>();
  for (const r of all) {
    const b = starBucket(r);
    const arr = byBucket.get(b);
    if (arr) arr.push(r);
    else byBucket.set(b, [r]);
  }
  const bucketOrder = [1, 2, 3, 5, 4, 0];
  const ordered: any[] = [];
  for (let progress = true; progress; ) {
    progress = false;
    for (const b of bucketOrder) {
      const arr = byBucket.get(b);
      if (arr && arr.length) { ordered.push(arr.shift()!); progress = true; }
    }
  }

  lines.push(`AVALIAÇÕES (${all.length} capturadas):`);
  const totalsByBucket = new Map<number, number>();
  for (const r of all) totalsByBucket.set(starBucket(r), (totalsByBucket.get(starBucket(r)) || 0) + 1);
  const printedByBucket = new Map<number, number>();
  let used = 0;
  let printed = 0;
  for (const r of ordered) {
    const line = formatReviewLine(r);
    if (!line) continue;
    if (used + line.length > MAX_REVIEWS_CHARS) break;
    lines.push(line);
    used += line.length;
    printed++;
    const b = starBucket(r);
    printedByBucket.set(b, (printedByBucket.get(b) || 0) + 1);
  }
  if (printed < all.length) {
    const left = bucketOrder
      .map((b) => [b, (totalsByBucket.get(b) || 0) - (printedByBucket.get(b) || 0)] as [number, number])
      .filter(([, c]) => c > 0)
      .map(([b, c]) => `${b ? `${b}★` : "s/ nota"}: ${c}`)
      .join(" · ");
    lines.push(`(— a distribuição completa de TODAS as ${all.length} avaliações está na linha DISTRIBUIÇÃO acima; não incluídas por limite de tamanho: ${left} —)`);
  }
  return lines.join("\n");
}

export interface ReviewsAiResult {
  leadId: number;
  nome_negocio: string | null;
  resumo: string;
  cached: boolean;
  persisted: boolean;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  modelUsed?: string;
}

/** Lê o resumo cacheado do lead (coluna nova ou intelligence) com fallback pra reviews_ai_logs. */
export async function getCachedReviewsSummary(leadIdOrJid: { leadId?: number; remoteJid?: string }): Promise<string | null> {
  try {
    let q = supabaseAdmin.from("leads_extraidos").select("resumo_avaliacoes, resumo_avaliacoes_at, intelligence");
    q = leadIdOrJid.leadId != null ? q.eq("id", leadIdOrJid.leadId) : q.eq("remoteJid", leadIdOrJid.remoteJid!);
    const { data, error } = await q.maybeSingle();
    if (error && isMissingColumn(error)) {
      // Fallback sem colunas novas
      let qRetry = supabaseAdmin.from("leads_extraidos").select("intelligence");
      qRetry = leadIdOrJid.leadId != null ? qRetry.eq("id", leadIdOrJid.leadId) : qRetry.eq("remoteJid", leadIdOrJid.remoteJid!);
      const { data: retryData } = await qRetry.maybeSingle();
      const intelResumo = (retryData?.intelligence as any)?.resumo_avaliacoes;
      const intelAt = (retryData?.intelligence as any)?.resumo_avaliacoes_at;
      if (intelResumo) {
        const fresh = !intelAt || Date.now() - new Date(intelAt).getTime() < CACHE_TTL_MS;
        if (fresh) return String(intelResumo);
      }
    } else if (!error && data) {
      if (data.resumo_avaliacoes) {
        const fresh = !data.resumo_avaliacoes_at ||
          Date.now() - new Date(data.resumo_avaliacoes_at).getTime() < CACHE_TTL_MS;
        if (fresh) return String(data.resumo_avaliacoes);
      }
      const intelResumo = (data.intelligence as any)?.resumo_avaliacoes;
      const intelAt = (data.intelligence as any)?.resumo_avaliacoes_at;
      if (intelResumo) {
        const fresh = !intelAt || Date.now() - new Date(intelAt).getTime() < CACHE_TTL_MS;
        if (fresh) return String(intelResumo);
      }
    }
  } catch { /* segue pro fallback de logs */ }
  try {
    let q = supabaseAdmin.from("reviews_ai_logs").select("response, created_at");
    q = leadIdOrJid.leadId != null ? q.eq("lead_id", leadIdOrJid.leadId) : q.eq("remote_jid", leadIdOrJid.remoteJid!);
    const { data, error } = await q.order("created_at", { ascending: false }).limit(1).maybeSingle();
    if (!error && data?.response) {
      const fresh = !data.created_at || Date.now() - new Date(data.created_at).getTime() < CACHE_TTL_MS;
      if (fresh) return String(data.response);
    }
  } catch { /* tabela pode não existir */ }
  return null;
}

/**
 * Analisa as avaliações de 1 lead com IA.
 * - Cache de 7 dias no próprio lead (force=true reprocessa).
 * - Persiste na coluna nova + loga em reviews_ai_logs (tolerante a schema antigo).
 */
export async function summarizeReviewsForLead(opts: {
  leadId: number;
  /** modelRef escolhido pelo usuário (gemini-x / openrouter:x / gateway:x). */
  model: string;
  customPrompt?: string | null;
  force?: boolean;
  clientId?: string | null;
  /** origem do disparo da análise — vai no log. */
  source?: "manual" | "automation" | "campaign" | "capture";
  automationId?: string | null;
}): Promise<ReviewsAiResult | { error: string }> {
  // 1) Tentativa completa com todas as colunas novas + clássicas
  const { data: lead, error } = await supabaseAdmin
    .from("leads_extraidos")
    .select(`id, client_id, "remoteJid", nome_negocio, ramo_negocio, categoria, avaliacao, reviews,
             intelligence, observacoes,
             reviews_detalhes, featured_reviews, review_topics, distribuicao_estrelas,
             resumo_avaliacoes, resumo_avaliacoes_at`)
    .eq("id", opts.leadId)
    .maybeSingle();

  if (error && isMissingColumn(error)) {
    // 2) Fallback para schema sem migração (apenas colunas originais seguras)
    const retry = await supabaseAdmin
      .from("leads_extraidos")
      .select(`id, client_id, "remoteJid", nome_negocio, ramo_negocio, categoria, avaliacao, reviews, intelligence, observacoes`)
      .eq("id", opts.leadId)
      .maybeSingle();
    if (retry.error || !retry.data) return { error: retry.error?.message || "Lead não encontrado" };

    // Cache hit no intelligence?
    if (!opts.force) {
      const intelResumo = (retry.data.intelligence as any)?.resumo_avaliacoes;
      const intelAt = (retry.data.intelligence as any)?.resumo_avaliacoes_at;
      if (intelResumo) {
        const fresh = !intelAt || Date.now() - new Date(intelAt).getTime() < CACHE_TTL_MS;
        if (fresh) {
          return {
            leadId: retry.data.id,
            nome_negocio: retry.data.nome_negocio,
            resumo: String(intelResumo),
            cached: true,
            persisted: true,
          };
        }
      }
    }
    return processLead(retry.data as any, opts, false);
  }
  if (error || !lead) return { error: error?.message || "Lead não encontrado" };

  // Cache hit?
  if (!opts.force && (lead as any).resumo_avaliacoes) {
    const at = (lead as any).resumo_avaliacoes_at;
    const fresh = !at || Date.now() - new Date(at).getTime() < CACHE_TTL_MS;
    if (fresh) {
      return {
        leadId: lead.id,
        nome_negocio: lead.nome_negocio,
        resumo: String((lead as any).resumo_avaliacoes),
        cached: true,
        persisted: true,
      };
    }
  }

  return processLead(lead as any, opts, true);
}

async function processLead(
  lead: any,
  opts: { model: string; customPrompt?: string | null; clientId?: string | null; source?: string; automationId?: string | null },
  canPersist: boolean,
): Promise<ReviewsAiResult | { error: string }> {
  const reviewsInput = buildReviewsInput(lead);
  const intel = lead.intelligence && typeof lead.intelligence === "object" ? lead.intelligence : null;
  const hasReviews =
    (Array.isArray(lead.reviews_detalhes) && lead.reviews_detalhes.length > 0) ||
    (Array.isArray(lead.featured_reviews) && lead.featured_reviews.length > 0) ||
    (Array.isArray(intel?.reviews_detalhes) && intel.reviews_detalhes.length > 0) ||
    (Array.isArray(intel?.featured_reviews) && intel.featured_reviews.length > 0);

  if (!hasReviews) {
    return { error: "sem avaliações capturadas (ative 'Capturar todas as avaliações' e recapture o lead)" };
  }

  // Chaves + modelo — mesmo pipeline do resto do sistema.
  const { getAiKeys } = await import("@/lib/ai-keys");
  const { generateText, providerOf } = await import("@/lib/ai-provider");
  const { resolveModel } = await import("@/lib/ai-default-model");
  const keys = await getAiKeys();
  const modelRef = (await resolveModel(opts.model, opts.clientId || lead.client_id)) || opts.model;
  const provider = providerOf(modelRef);
  if (provider === "gemini" && !keys.gemini) return { error: "API key Gemini não configurada (Configurações)" };
  if (provider === "openrouter" && !keys.openrouter) return { error: "API key OpenRouter não configurada (Configurações)" };

  const system = (opts.customPrompt && opts.customPrompt.trim()) || DEFAULT_REVIEWS_PROMPT;

  const gen = await generateText({
    modelRef,
    system,
    prompt: reviewsInput,
    maxOutputTokens: 2048,
    geminiApiKey: keys.gemini,
    openrouterApiKey: keys.openrouter,
  });

  const resumo = (gen.text || "").trim();
  if (!resumo) return { error: "IA retornou resposta vazia" };

  // Persistência: tenta coluna nova, se falhar salva dentro de intelligence.resumo_avaliacoes
  let persisted = false;
  try {
    const { error: updErr } = await supabaseAdmin
      .from("leads_extraidos")
      .update({ resumo_avaliacoes: resumo, resumo_avaliacoes_at: new Date().toISOString() })
      .eq("id", lead.id);
    if (!updErr) {
      persisted = true;
    } else if (isMissingColumn(updErr)) {
      const mergedIntel = {
        ...(typeof lead.intelligence === "object" && lead.intelligence ? lead.intelligence : {}),
        resumo_avaliacoes: resumo,
        resumo_avaliacoes_at: new Date().toISOString(),
      };
      const { error: intelErr } = await supabaseAdmin
        .from("leads_extraidos")
        .update({ intelligence: mergedIntel })
        .eq("id", lead.id);
      persisted = !intelErr;
    }
  } catch {
    persisted = false;
  }
  // Log completo — o que a IA retornou
  try {
    await supabaseAdmin.from("reviews_ai_logs").insert({
      client_id: opts.clientId || lead.client_id || null,
      lead_id: lead.id,
      remote_jid: lead.remoteJid,
      nome_negocio: lead.nome_negocio,
      model: modelRef,
      prompt: system,
      response: resumo,
      cached: false,
      prompt_tokens: gen.usage?.promptTokens || 0,
      completion_tokens: gen.usage?.completionTokens || 0,
      total_tokens: gen.usage?.totalTokens || 0,
      source: opts.source || "manual",
      automation_id: opts.automationId || null,
    });
  } catch { /* tabela nova pode não existir — log é best-effort */ }

  return {
    leadId: lead.id,
    nome_negocio: lead.nome_negocio,
    resumo,
    cached: false,
    persisted,
    usage: gen.usage,
    modelUsed: gen.modelUsed || modelRef,
  };
}
