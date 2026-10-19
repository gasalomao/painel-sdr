/**
 * scraper-engine — engine do scraper Google Maps + Puppeteer extraído
 * de /api/scraper pra permitir CHAMADA DIRETA pelo automation-worker
 * (sem HTTP self-call, que falha em alguns ambientes).
 *
 * Quem usa:
 *   - /api/scraper/route.ts  — wrappers HTTP pro /captador (browser)
 *   - lib/automation-worker  — chama startScraperRun() direto, in-process
 *
 * Estado é módulo-singleton — uma única instância de scraper por processo
 * Node, exatamente como antes.
 */

import { supabase, supabaseAdmin } from "@/lib/supabase";
import { readCaptureIds, readRejectedCaptureIds, updateAutomationCapture, type AutomationCaptureRow } from "@/lib/automation-capture";
import { getEvolutionConfig } from "@/lib/evolution";
import { summarizeReviewsForLead } from "@/lib/reviews-ai";
import { extractLocation } from "@/lib/lead-intelligence";
import { isValidCityName, ufFromCep, computeExpansionCandidates, proximitySearchTerm, normRegionName } from "@/lib/geo-regions";
import { fetchPublicHttpUrl } from "@/lib/safe-url";
import { extractGoogleReviewCount, parseGoogleReviewCount, parseMinReviews, reviewCountFilterReason } from "@/lib/scraper-review-count";
import { normalizeInstagramProfile } from "@/lib/scraper-instagram";
import { makeSearchKey, loadExhaustedSearches, markSearchExhausted } from "@/lib/scraper-search-memory";
import os from "os";
import fs from "fs";
import path from "path";

export interface Lead {
  name: string;
  phones: string;
  remoteJid: string;
  fullAddress: string;
  categories: string;
  averageRating: string;
  reviewCount: string;
  website: string;
  instagram: string;
  facebook: string;
  extractedAt: string;
  /** Reviews escritas (autor, nota, data, texto + fotoAutor + fotos anexadas
   *  + respostaDono + contador útil) — captura profunda do painel de detalhe
   *  do Maps. Vem como array de objetos já serializável. */
  reviewsDetalhes?: any[];
  /** Blob estruturado do painel "Sobre" do Maps. Inclui:
   *  - about (descrição curta)
   *  - descricao (descrição estendida)
   *  - services (lista de serviços)
   *  - subcategorias
   *  - pessoasProcuramPor ("As pessoas procuram por")
   *  - popularTimes (horários de pico da semana)
   *  - redesAdicionais (LinkedIn/Twitter/YouTube/TikTok/WhatsApp/Telegram)
   *  - menuUrl, reservaUrl
   *  - plusCode, lat, lng, placeId (espelhados p/ acesso fácil)
   *  - atualizadoEm
   */
  businessDetails?: any;
  openingHours?: any;
  attributes?: any[];
  priceRange?: string;
  openNow?: string;
  photos?: string[];
  mapsUrl?: string;
  /** Plus Code (Open Location Code) — referência única do lugar. */
  plusCode?: string;
  /** Latitude decimal (string p/ evitar perda de precisão). */
  lat?: string;
  /** Longitude decimal (string). */
  lng?: string;
  /** Place ID Google (ChIJ... ou 0x...:0x...). */
  placeId?: string;
  /** Distribuição de estrelas: { "5estrelas": 120, "4estrelas": 30, ... }. */
  distribuicaoEstrelas?: Record<string, number>;
  /** CEP extraído do endereço/painel. */
  cep?: string;

  // ============================================================
  // CAMPOS EXTRAS — captura ESTENDIDA (2026-07-22):
  // ============================================================

  /** Status operacional: "Operacional", "Permanently closed", "Temporarily closed". */
  businessStatus?: string;

  /** Se o dono reivindicou a ficha (Claimed). Negócios "Claimed" tendem a
   *  ser mais atenciosos/responsivos — sinal positivo pra B2B. */
  claimed?: boolean;

  /** Nome do proprietário/gerente quando exibido publicamente. */
  ownerName?: string;

  /** Ano de fundação do negócio (quando disponível). */
  yearEstablished?: string;

  /** Número TOTAL de fotos que o Google Maps tem do local (não só as 50 que
   *  capturamos em photos[] — isso é o count agregado). */
  totalPhotoCount?: number;

  /** Tópicos de reviews do Google: { "Comida": "4.8", "Atendimento": "4.5" }.
   *  Mostra os pontos fortes e fracos do negócio por categoria. */
  reviewTopics?: Record<string, string>;

  /** Reviews em destaque (Featured) — selecionadas pelo Google como mais úteis. */
  featuredReviews?: string[];

  /** Categorias secundárias (além da principal). */
  additionalCategories?: string[];

  /** Endereço separado em componentes: rua, número, bairro, cidade, estado, cep. */
  addressComponents?: {
    rua?: string;
    numero?: string;
    bairro?: string;
    cidade?: string;
    estado?: string;
    cep?: string;
    pais?: string;
  } | null;
}

export interface ScraperSettings {
  webhookUrl?: string;
  webhookEnabled?: boolean;
  mode?: string;
  filterEmpty?: boolean;
  filterDuplicates?: boolean;
  filterLandlines?: boolean;
  filterWithWebsite?: boolean;
  /** Exige link de perfil do Instagram identificado no painel do negócio. */
  filterWithInstagram?: boolean;
  /** Total mínimo de pessoas que avaliaram, independente da nota/comentários. 0 desativa. */
  minReviews?: number;
  captureAllReviews?: boolean;
  /** Limite máximo de leads a captar antes de parar. Quando atingido, o scraper
   *  sai do loop limpo, fecha o navegador, e o worker detecta o cap no próximo
   *  tick e avança pra fase de disparo. Sem limite = sem parada por contagem. */
  maxLeads?: number;
  client_id?: string | null;
  /** Resumo automático de avaliações com IA logo após salvar cada lead
   *  (fluxo Busca do /prospeccao-sites). Automação NÃO passa isto — ela roda
   *  o resumo em batch na fase de dispatch (automation-worker). */
  reviews_ai?: { enabled?: boolean; model?: string; prompt?: string | null };
  /** Run de REPOSIÇÃO (automation-worker): usa o mesmo checkpoint, excluindo IDs rejeitados da meta. */
  topup?: boolean;
}

type CaptureSearchCursor = { key: string; seenURLs: string[] };

type RunContext = {
  generation: number;
  clientId: string;
  automationId: string | null;
  captureAttemptId: string | null;
  captureSessionId: string | null;
  captureCount: number;
  captureGoal: number;
  checkpointFailed: boolean;
  searchCursor: CaptureSearchCursor | null;
  isScraping: boolean;
  isStopping: boolean;
  isPaused: boolean;
  keepRunning: boolean;
  leads: Lead[];
  niche: string;
  region: string;
};

let activeRun: RunContext | null = null;
let runGeneration = 0;
const leadsByOwner = new Map<string, Lead[]>();
const searchByOwner = new Map<string, { niche: string; region: string }>();
const sseClients = new Map<ReadableStreamDefaultController, string | null>();

function normalizeClientId(clientId?: string | null): string | null {
  const normalized = typeof clientId === "string" ? clientId.trim() : "";
  return normalized || null;
}

function ownerKey(clientId: string, automationId: string | null): string {
  return `${clientId}:${automationId || "manual"}`;
}

function hasRunAccess(clientId?: string | null, automationId: string | null = null): boolean {
  const normalized = normalizeClientId(clientId);
  if (!normalized || !activeRun || activeRun.clientId !== normalized) return false;
  return activeRun.automationId === automationId;
}

export function attachSseClient(ctrl: ReadableStreamDefaultController, clientId: string | null): void {
  sseClients.set(ctrl, normalizeClientId(clientId));
  const status = getStatus(clientId);
  try {
    ctrl.enqueue(new TextEncoder().encode(
      `data: ${JSON.stringify({ event: "status", isScraping: status.isScraping, isPaused: status.isPaused, leadCount: status.leadCount })}\n\n`
    ));
  } catch {}
}
export function detachSseClient(ctrl: ReadableStreamDefaultController): void {
  sseClients.delete(ctrl);
}

function broadcastToClient(clientId: string, data: Record<string, unknown>): void {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const [ctrl, subscribedClientId] of sseClients) {
    if (subscribedClientId !== clientId) continue;
    try {
      ctrl.enqueue(new TextEncoder().encode(msg));
    } catch {
      sseClients.delete(ctrl);
    }
  }
}

async function logToAutomation(clientId: string, automationId: string | null, message: string, level: "info" | "success" | "warning" | "error" = "info", kind: "scrape" | "state" | "error" = "scrape") {
  if (!automationId) return;
  try {
    const client = supabaseAdmin || supabase;
    if (!client) return;
    // .insert() do Supabase NÃO lança em erro de banco — devolve { error }.
    // Sem checar isso, uma falha de gravação (RLS, constraint) ficava
    // invisível e o log da automação parecia "incompleto" sem motivo.
    const { error } = await client.from("automation_logs").insert({
      automation_id: automationId,
      client_id: clientId,
      kind,
      level,
      message: String(message).slice(0, 1000),
      metadata: {},
    });
    if (error) console.warn("[SCRAPER] falha gravando automation_logs:", error.message);
  } catch (e) {
    console.warn("[SCRAPER] exceção gravando automation_logs:", (e as Error).message);
  }
}

function sendRunLog(run: RunContext, message: string, type: string = "info") {
  const timestamp = new Date().toLocaleTimeString("pt-BR");
  if (!run.automationId) broadcastToClient(run.clientId, { event: "log", message, type, timestamp });
  console.log(`[SCRAPER] ${type.toUpperCase()}: ${message}`);
  if (run.automationId && !message.startsWith("[DEBUG]")) {
    const lvl: "info" | "success" | "warning" | "error" =
      type === "success" ? "success" :
      type === "warning" ? "warning" :
      type === "error" ? "error" : "info";
    logToAutomation(run.clientId, run.automationId, message, lvl).catch(() => {});
  }
}

function findChromeOnWindows(): string | null {
  const paths = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ];
  for (const p of paths) {
    if (fs.existsSync(/*turbopackIgnore: true*/ p)) return p;
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isLandline(phone: string): boolean {
  const clean = phone.replace(/\D/g, "");
  if (clean.startsWith("55") && clean.length === 12) return true;
  if (clean.length === 10) return true;
  if (clean.startsWith("0800") || clean.startsWith("3003") || clean.startsWith("4004")) return true;
  const local = clean.startsWith("55") ? clean.substring(4) : clean.substring(2);
  if (local.length === 8 && /^[2345]/.test(local)) return true;
  return false;
}

function formatJid(phone: string): string {
  let clean = phone.replace(/\D/g, "");
  if (!clean) return "";
  if (clean.length >= 10 && clean.length <= 11) {
    clean = "55" + clean;
  }
  return `${clean}@s.whatsapp.net`;
}

/**
 * Filtros de lead (sem telefone / duplicado / fixo / com site) num ponto
 * único. Chamado ANTES da captura profunda de reviews (economiza o scroll
 * caro em leads que vão ser descartados) e de novo no fim (defesa).
 */
export function evaluateLeadFilters(
  cleanPhone: string,
  websiteStr: string,
  settings: ScraperSettings,
  existingLeads: Lead[],
  reviewCount = "",
  instagram = "",
): { pass: boolean; reason: string } {
  if (settings.filterEmpty && cleanPhone === "") return { pass: false, reason: "Sem telefone" };
  if (settings.filterDuplicates && cleanPhone !== "" && existingLeads.find((l) => l.phones.replace(/\D/g, "") === cleanPhone)) {
    return { pass: false, reason: "Telefone duplicado" };
  }
  if (settings.filterLandlines && cleanPhone !== "" && isLandline(cleanPhone)) return { pass: false, reason: "Telefone fixo" };
  if (settings.filterWithWebsite && websiteStr) return { pass: false, reason: "Com site" };
  const reviewReason = reviewCountFilterReason(reviewCount, settings.minReviews);
  if (reviewReason) return { pass: false, reason: reviewReason };
  if (settings.filterWithInstagram && !normalizeInstagramProfile(instagram)) return { pass: false, reason: "Sem Instagram" };
  return { pass: true, reason: "" };
}

/** Chave estável de URL de place do Maps (sem o segmento de viewport /@lat,lng
 *  que varia entre buscas) — usada pra não reprocessar o mesmo negócio que
 *  aparece em duas buscas da mesma automação. */
export function placeUrlKey(url: string): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    const host = parsed.host.replace(/^maps\.google\./, "www.google.");
    const cleanPath = parsed.pathname.replace(/\/@[^/]+/, "").replace(/\/+$/, "");
    const cid = parsed.searchParams.get("cid");
    const query = cid ? `?cid=${cid}` : "";
    return `${parsed.protocol}//${host}${cleanPath}${query}`;
  } catch {
    return url.replace(/\/@[^/]+/, "").split("?")[0].split("#")[0].replace(/\/+$/, "");
  }
}

export function formatLeadForN8n(lead: Lead, search?: { niche: string; region: string }) {
  // Caminho CHAVE-VALOR p/ integrações n8n/Zapier/Make (chaves snake_case,
  // fácil de mapear). Inclui TODOS os campos capturados do Maps — não perde
  // mais reviews, fotos, horários, popular times, redes sociais, etc.
  const bd: any = lead.businessDetails || {};
  return {
    // ---- Identificação básica ----
    nome_do_negocio: lead.name || "",
    telefone: lead.phones || "",
    endereco: lead.fullAddress || "",
    categoria_do_negocio: lead.categories || "",
    nicho_pesquisado: search?.niche || "",
    regiao_pesquisada: search?.region || "",
    avaliacao: lead.averageRating || "",
    numero_avaliacoes: lead.reviewCount || "",
    website: lead.website || "",
    instagram: lead.instagram || "",
    facebook: lead.facebook || "",
    extraido_em: lead.extractedAt || "",
    remoteJid: lead.remoteJid || "",
    // ---- Localização precisa ----
    place_id: lead.placeId || "",
    plus_code: lead.plusCode || "",
    lat: lead.lat || "",
    lng: lead.lng || "",
    cep: lead.cep || "",
    maps_url: lead.mapsUrl || "",
    // ---- Funcionamento ----
    faixa_preco: lead.priceRange || "",
    aberto_agora: lead.openNow || "",
    horarios_funcionamento: lead.openingHours || null,
    // ---- Detalhes (sobre + serviços + subcategorias + redes) ----
    detalhes: lead.businessDetails || null,
    redes_adicionais: bd.redesAdicionais || null,
    menu_url: bd.menuUrl || "",
    reserva_url: bd.reservaUrl || "",
    descricao: bd.descricao || bd.about || "",
    servicos: bd.services || null,
    subcategorias: bd.subcategorias || null,
    pessoas_procuram_por: bd.pessoasProcuramPor || null,
    horarios_populares: bd.popularTimes || null,
    atualizado_em: bd.atualizadoEm || "",
    // ---- Atributos (delivery, acessibilidade, pagamentos, etc.) ----
    atributos: lead.attributes || null,
    // ---- Fotos ----
    fotos: lead.photos || null,
    // ---- Distribuição de estrelas (5★, 4★, 3★, 2★, 1★) ----
    distribuicao_estrelas: lead.distribuicaoEstrelas || null,
    // ---- Reviews completas (autor, nota, data, texto, fotos, respostaDono, util) ----
    reviews_detalhes: lead.reviewsDetalhes || null,
  };
}

/**
 * Checa se um remoteJid já está presente no CRM. "CRM" aqui inclui:
 *  - `leads_extraidos` (lead já capturado anteriormente, qualquer status)
 *  - `contacts`        (já existe conversa/contato real no WhatsApp)
 *
 * Se qualquer uma das duas tabelas tiver o JID, o lead é considerado DUPLICADO
 * e deve ser pulado por completo (não conta no maxLeads, não vai pra UI, não salva).
 *
 * Retorna `null` se NÃO está no CRM, ou string descritiva se está (pra log).
 */
export async function checkCrmDuplicate(
  remoteJid: string,
  clientId: string,
  identity?: Pick<Lead, "phones" | "placeId" | "mapsUrl">,
): Promise<string | null> {
  const normalizedClientId = normalizeClientId(clientId);
  if (!normalizedClientId) throw new Error("client_id obrigatório para consultar duplicatas do CRM");
  const client = supabaseAdmin || supabase;
  if (!client) throw new Error("Supabase client não inicializado");
  const digits = formatJid(identity?.phones || remoteJid.split("@")[0]).split("@")[0];
  const queries: { table: string; column: string; value: string; pattern?: boolean; maps?: boolean }[] = [];
  if (remoteJid || digits) {
    for (const jid of new Set([remoteJid, digits ? `${digits}@s.whatsapp.net` : ""].filter(Boolean))) {
      queries.push({ table: "leads_extraidos", column: "remoteJid", value: jid }, { table: "contacts", column: "remote_jid", value: jid });
    }
    // Formatação legada não é identidade: (11) 99999-0000 e +55 11 99999-0000 são o mesmo telefone.
    const local = digits.startsWith("55") && digits.length >= 12 ? digits.slice(2) : digits;
    if (local) for (const [table, column] of [["leads_extraidos", "telefone"], ["contacts", "phone_number"]]) {
      queries.push({ table, column, value: `%${local.split("").join("%")}%`, pattern: true });
    }
  }
  if (identity?.placeId) queries.push({ table: "leads_extraidos", column: "place_id", value: identity.placeId });
  if (identity?.mapsUrl) {
    const key = placeUrlKey(identity.mapsUrl);
    const stem = key.split("/data=")[0].split("?")[0].replace(/[\\%_]/g, "\\$&");
    queries.push({ table: "leads_extraidos", column: "maps_url", value: `${stem}%`, pattern: true, maps: true });
  }
  for (const check of queries) {
    let query = client.from(check.table).select(`id,${check.column}`).eq("client_id", normalizedClientId);
    query = check.pattern ? query.ilike(check.column, check.value) : query.eq(check.column, check.value);
    if (check.pattern) {
      // Pagina para nunca aceitar um falso negativo por truncamento do servidor.
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await query.range(offset, offset + 999);
        if (error) throw new Error(`Falha ao verificar duplicata no CRM: ${error.message}`);
        if (((data || []) as unknown as Record<string, unknown>[]).some(row => check.maps
          ? placeUrlKey(String(row.maps_url || "")) === placeUrlKey(identity!.mapsUrl!)
          : formatJid(String(row[check.column] || "")) === `${digits}@s.whatsapp.net`)) return check.table;
        if (!data || data.length < 1000) break;
        if (offset >= 99_000) throw new Error("Consulta de duplicatas excedeu o limite seguro; refine a identidade do negócio.");
      }
    } else {
      const { data, error } = await query.limit(1).maybeSingle();
      if (error) {
        if ((error as { code?: string }).code === "PGRST116") return check.table;
        throw new Error(`Falha ao verificar duplicata no CRM: ${error.message}`);
      }
      if (data) return check.table;
    }
  }
  return null;
}

function captureMatches(run: RunContext, row: AutomationCaptureRow): boolean {
  return row.client_id === run.clientId && row.id === run.automationId && row.status === "running"
    && row.phase === "scraping" && !!run.captureAttemptId && row.scrape_filters._captureAttemptId === run.captureAttemptId
    && typeof row.scrape_filters._captureSessionId === "string" && !!row.scrape_filters._captureSessionId
    && (!run.captureSessionId || row.scrape_filters._captureSessionId === run.captureSessionId);
}

function captureCount(row: AutomationCaptureRow): number {
  const rejected = new Set(readRejectedCaptureIds(row.scrape_filters));
  return readCaptureIds(row.scrape_filters).filter(id => !rejected.has(id)).length;
}

async function checkpointCapture(run: RunContext, savedLeadId?: number, searchCursor?: CaptureSearchCursor): Promise<boolean> {
  if (!run.keepRunning || activeRun !== run) return false;
  if (!run.automationId) return true;
  if (!run.captureAttemptId) { run.keepRunning = false; return false; }
  const now = Date.now();
  const row = await updateAutomationCapture(run.clientId, run.automationId, current => {
    if (!run.keepRunning || activeRun !== run || !captureMatches(run, current)) return null;
    const ids = readCaptureIds(current.scrape_filters);
    const goal = Number(current.scrape_max_leads) || 0;
    if (savedLeadId && goal > 0 && captureCount(current) >= goal && !ids.includes(savedLeadId)) return null;
    if (savedLeadId && !ids.includes(savedLeadId)) ids.push(savedLeadId);
    const rejected = new Set(readRejectedCaptureIds(current.scrape_filters));
    return {
      scraped_count: ids.filter(id => !rejected.has(id)).length,
      scrape_filters: { ...current.scrape_filters, _capturedLeadIds: ids,
        _captureHeartbeatAt: new Date(now).toISOString(), _captureLeaseUntil: new Date(now + 120_000).toISOString(),
        ...(savedLeadId ? { _lastProgressAt: new Date(now).toISOString() } : {}),
        ...(searchCursor ? { _captureSearchCursor: searchCursor } : {}) },
    };
  }).catch((error: unknown) => { run.checkpointFailed = true; throw error; });
  if (!row) { run.keepRunning = false; return false; }
  run.captureSessionId = String(row.scrape_filters._captureSessionId);
  run.captureCount = captureCount(row);
  run.captureGoal = Number(row.scrape_max_leads) || 0;
  const cursor = row.scrape_filters._captureSearchCursor as Partial<CaptureSearchCursor> | undefined;
  if (typeof cursor?.key === "string" && Array.isArray(cursor.seenURLs)) {
    run.searchCursor = { key: cursor.key, seenURLs: cursor.seenURLs.filter((url): url is string => typeof url === "string") };
  }
  return true;
}

async function saveLeadAndSync(lead: Lead, settings: ScraperSettings, run: RunContext): Promise<number | null> {
  const hasWhatsApp = !!lead.remoteJid;

  try {
    const client = supabaseAdmin || supabase;
    if (!client) throw new Error("Supabase client não inicializado");

    if (!await checkpointCapture(run)) return null;
    if (run.checkpointFailed) throw new Error("Checkpoint anterior falhou; aguarde reconciliação da captura.");
    const dupSource = await checkCrmDuplicate(lead.remoteJid, run.clientId, lead);
    if (dupSource) {
      sendRunLog(run, `⏭️ "${lead.name}" já estava no CRM (${dupSource}) — pulando`, "info");
      return null;
    }
    if (!run.keepRunning || activeRun !== run || run.captureGoal > 0 && run.captureCount >= run.captureGoal) return null;

    // Schema do leads_extraidos: avaliacao (NUMERIC), reviews (INT). Notas:
    //   - O nome correto da coluna é `avaliacao`, NÃO `rating` — bug histórico
    //     que rejeitava todos os INSERTs em bancos novos.
    //   - `instagram` e `facebook` foram adicionadas via migration (PARTE 3
    //     do SETUP_COMPLETO.sql); se o banco for muito antigo e não tiver
    //     elas, o fallback abaixo retira-as e tenta de novo.
    const fullPayload = {
      client_id: run.clientId,
      remoteJid: lead.remoteJid || null,
      nome_negocio: lead.name,
      telefone: lead.phones,
      ramo_negocio: lead.categories,
      endereco: lead.fullAddress,
      avaliacao: lead.averageRating ? Number(lead.averageRating) || null : null,
      reviews: parseGoogleReviewCount(lead.reviewCount),
      website: lead.website,
      instagram: lead.instagram,
      facebook: lead.facebook,
      // ---- Captura profunda do Maps (Migration 009) ----
      reviews_detalhes: lead.reviewsDetalhes || null,
      business_details: run.automationId ? {
        ...(lead.businessDetails || {}),
        _automationCapture: { automationId: run.automationId, sessionId: run.captureSessionId, attemptId: run.captureAttemptId },
      } : lead.businessDetails || null,
      opening_hours: lead.openingHours || null,
      attributes: lead.attributes || null,
      price_range: lead.priceRange || null,
      open_now: lead.openNow || null,
      photos: lead.photos || null,
      maps_url: lead.mapsUrl || null,
      // ---- Campos extras do painel de detalhe (Migration 011) ----
      place_id: lead.placeId || null,
      plus_code: lead.plusCode || null,
      lat: lead.lat ? Number(lead.lat) || null : null,
      lng: lead.lng ? Number(lead.lng) || null : null,
      cep: lead.cep || null,
      distribuicao_estrelas: lead.distribuicaoEstrelas || null,
      // ---- Campos extras da captura estendida (Migration 012) ----
      business_status: lead.businessStatus || null,
      claimed: lead.claimed ?? null,
      owner_name: lead.ownerName || null,
      year_established: lead.yearEstablished || null,
      total_photo_count: lead.totalPhotoCount ?? null,
      review_topics: lead.reviewTopics || null,
      featured_reviews: lead.featuredReviews || null,
      additional_categories: lead.additionalCategories || null,
      address_components: lead.addressComponents || null,
      instance_name: (await getEvolutionConfig()).instance,
      status: hasWhatsApp ? "novo" : "sem_contato",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (!run.keepRunning || activeRun !== run || (run.captureGoal > 0 && run.captureCount >= run.captureGoal)) return null;

    let savedId: number | null = null;

    const insertResult = await client.from("leads_extraidos").insert(fullPayload).select("id").single();
    let insError = insertResult.error as any;
    if (!insError) savedId = insertResult.data?.id ?? null;

    // PGRST204 = coluna inexistente. Banco antigo sem instagram/facebook/ou
    // sem as colunas JSONB da Migration 009/011/012 — tenta só com colunas garantidas.
    if (insError && insError.code === "PGRST204" && !run.automationId) {
      const minimal: any = { ...fullPayload };
      const maybeMissing = [
        "instagram", "facebook",
        "reviews_detalhes", "business_details", "opening_hours", "attributes",
        "price_range", "open_now", "photos", "maps_url",
        "place_id", "plus_code", "lat", "lng", "cep", "distribuicao_estrelas",
        // ---- Campos extras Migration 012 ----
        "business_status", "claimed", "owner_name", "year_established",
        "total_photo_count", "review_topics", "featured_reviews",
        "additional_categories", "address_components",
      ];
      for (const k of maybeMissing) delete minimal[k];
      const retry = await client.from("leads_extraidos").insert(minimal).select("id").single();
      insError = retry.error as any;
      if (!insError) savedId = retry.data?.id ?? null;
      if (!insError) {
        sendRunLog(run, `(banco antigo — lead salvo sem colunas extras do Maps/reviews)`, "warning");
      }
    }

    if (insError) throw insError;
    if (!Number.isSafeInteger(savedId) || !savedId || savedId <= 0) throw new Error("INSERT sem ID confirmado; captura não contabilizada.");
    // O marcador foi salvo no mesmo INSERT: falha/crash aqui é reconciliável pelo worker.
    if (!await checkpointCapture(run, savedId)) {
      if (run.automationId) {
        try {
          await client.from("leads_extraidos").update({
            business_details: lead.businessDetails || null,
          }).eq("id", savedId).eq("client_id", run.clientId);
        } catch {
          // Best effort rollback
        }
      }
      return null;
    }

    if (hasWhatsApp) {
      sendRunLog(run, `✅ Salvo: ${lead.name}`, "success");
    } else {
      sendRunLog(run, `✅ Salvo: ${lead.name} (sem WhatsApp — status: sem_contato)`, "success");
    }

    // Webhook realtime (best-effort): falha aqui não derruba o save.
    if (!run.automationId && run.keepRunning && activeRun === run && settings.webhookEnabled && settings.mode === "realtime" && settings.webhookUrl) {
      try {
        const payload = formatLeadForN8n(lead, { niche: run.niche, region: run.region });
        await fetchPublicHttpUrl(settings.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        sendRunLog(run, `[Webhook] Lead enviado: ${lead.name}`, "success");
      } catch (err) {
        sendRunLog(run, `[Webhook] Falha ao enviar para n8n: ${(err as Error).message}`, "error");
      }
    }

    return savedId;
  } catch (err: any) {
    const msg = err?.message || String(err);
    const detail = err?.details || err?.hint || "";
    console.error("Erro ao salvar no Supabase (CRM):", msg, detail);
    sendRunLog(run, `❌ Falha ao salvar "${lead.name}": ${msg}${detail ? ` (${detail})` : ""}`, "error");
    throw new Error(`Falha persistindo lead: ${msg}`);
  }
}

async function runScraper(niches: string[], regions: string[], settings: ScraperSettings, run: RunContext) {
  const isCurrentRun = () => activeRun === run && run.generation === runGeneration;
  const leadsStore = run.leads;
  const currentClientId = run.clientId;
  broadcastToClient(run.clientId, { event: "status", isScraping: true, isPaused: false, leadCount: 0 });
  sendRunLog(run, "Iniciando o Robô do lado do Servidor...", "info");

  let scraperError: string | null = null;
  let crmSkipped = 0; // contador de leads pulados por já estarem no CRM (escopo do finally)

  let browser;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let heartbeatPending: Promise<void> | undefined;
  let transientDetailError = false;
  try {
    if (!await checkpointCapture(run)) return;
    if (run.captureGoal > 0 && run.captureCount >= run.captureGoal) return;
    if (run.automationId) {
      heartbeat = setInterval(() => {
        if (heartbeatPending) return;
        heartbeatPending = checkpointCapture(run).then(() => {}, error => {
          scraperError = (error as Error).message;
          run.keepRunning = false;
        }).finally(() => { heartbeatPending = undefined; });
      }, 30_000);
      heartbeat.unref?.();
    }
    const puppeteerExtra = (await import("puppeteer-extra")).default;
    const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
    puppeteerExtra.use(StealthPlugin());

    let executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    if (!executablePath) {
      if (os.platform() === "win32") {
        executablePath = findChromeOnWindows() || undefined;
        if (executablePath) sendRunLog(run, `Ambiente Windows detectado. Usando: ${executablePath}`, "info");
        else sendRunLog(run, "Aviso: Navegador não encontrado no Windows. Tente instalar o Chrome.", "warning");
      } else {
        const linuxPaths = [
          "/usr/bin/chromium-browser",
          "/usr/bin/chromium",
          "/usr/bin/google-chrome-stable",
          "/usr/bin/google-chrome",
        ];
        for (const p of linuxPaths) {
          if (fs.existsSync(/*turbopackIgnore: true*/ p)) {
            executablePath = p;
            break;
          }
        }
      }
    }

    const launchOptions: Record<string, unknown> = {
      headless: true,
      executablePath,
      ignoreDefaultArgs: ["--enable-automation"],
      env: {
        ...process.env,
        HOME: process.env.HOME && fs.existsSync(process.env.HOME) ? process.env.HOME : "/tmp",
        CHROME_CRASHPAD_PIPE_NAME: "",
      },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--no-first-run",
        "--no-zygote",
        "--disable-breakpad",
        "--disable-crash-reporter",
        "--crash-dumps-dir=/tmp",
        "--enable-crash-reporter-for-testing=0",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-domain-reliability",
        "--disable-features=AudioServiceOutOfProcess,IsolateOrigins,site-per-process",
        "--disable-hang-monitor",
        "--disable-ipc-flooding-protection",
        "--disable-popup-blocking",
        "--disable-prompt-on-repost",
        "--disable-renderer-backgrounding",
        "--disable-sync",
        "--force-color-profile=srgb",
        "--metrics-recording-only",
        "--password-store=basic",
        "--use-mock-keychain",
        "--window-size=1280,800",
        "--lang=pt-BR,pt",
      ],
    };

    browser = await puppeteerExtra.launch(launchOptions);
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });
    try {
      if (typeof page.setCookie === "function") {
        await page.setCookie(
          { name: "SOCS", value: "CAISNQgDEitnd3NfMjAyNDA2MTAtMF9SQzJfZXVyb3BlX3N0YXR1c19jYTFfMjAyNDA2MTAuMV9wMBoCcHQgAQ", domain: ".google.com", path: "/" },
          { name: "SOCS", value: "CAISNQgDEitnd3NfMjAyNDA2MTAtMF9SQzJfZXVyb3BlX3N0YXR1c19jYTFfMjAyNDA2MTAuMV9wMBoCcHQgAQ", domain: ".google.com.br", path: "/" },
          { name: "CONSENT", value: "PENDING+999", domain: ".google.com", path: "/" },
          { name: "CONSENT", value: "PENDING+999", domain: ".google.com.br", path: "/" },
        );
      }
    } catch {}

    const effectiveFilters = {
      filterEmpty: settings.filterEmpty === true, filterDuplicates: run.automationId ? true : settings.filterDuplicates === true,
      filterLandlines: settings.filterLandlines === true, filterWithWebsite: settings.filterWithWebsite === true,
      filterWithInstagram: settings.filterWithInstagram === true, minReviews: settings.minReviews || 0,
    };
    const exhaustedSearches = await loadExhaustedSearches(run.clientId, effectiveFilters);
    const queue: { niche: string; region: string; proximity?: boolean }[] = [];
    for (const region of regions) for (const niche of niches) queue.push({ niche: niche.trim(), region: region.trim() });
    // Nichos distintos mantêm cursores independentes, inclusive quando compartilham região.
    const processedByNiche = new Map<string, Set<string>>();
    sendRunLog(run, `📋 Fila: ${queue.length} buscas${settings.maxLeads ? ` · limite ${settings.maxLeads} leads` : ""}`, "info");

    const maxLeads = Number(settings.maxLeads) || 0; // limite desta tentativa, worker passa apenas o restante
    const reachedLimit = (): boolean => maxLeads > 0 && leadsStore.length >= maxLeads
      || run.captureGoal > 0 && run.captureCount >= run.captureGoal;

    // ─── EXPANSÃO AUTOMÁTICA PRA CIDADES VIZINHAS ───
    // Problema real de log: 1 nicho × 1 região, limite 40, Google esgota os
    // ~113 resultados da cidade e os filtros (sem site etc.) descartam quase
    // tudo → run termina com 5/40 sem nunca olhar cidade nenhuma do entorno.
    // Solução: colher as cidades dos ENDEREÇOS dos próprios resultados
    // (inclusive dos descartados — o card tem endereço de graça) e, quando a
    // última busca da fila acaba abaixo do limite, enfileirar o mesmo nicho
    // nessas cidades. Places repetidos entre buscas já são dedupados por
    // processedPlaceKeys — expandir nunca gera lead duplicado.
    const norm = normRegionName;
    const searchedByNiche = new Map(niches.map(niche => [niche.trim(), new Set<string>(regions.map(region => norm(region)))]));
    const cityCounts = new Map<string, number>();
    // ponytail: limita custo por tentativa, não o alcance geográfico; memória durável avança no retry.
    const queryBudget = 20;
    const attemptDeadline = Date.now() + 20 * 60_000;
    let queriesExecuted = 0;
    // Semeadura de proximidade (expansão universal pra lugar não mapeado): 1x por região por run.
    const proximitySeededRegions = new Set<string>();

    outer: for (let i = 0; i < queue.length; i++) {
      if (!run.keepRunning || !isCurrentRun()) {
        sendRunLog(run, "Parada recebida. Abortando fila.", "warning");
        break;
      }
      // Já bateu o limite ANTES de começar a próxima busca? Para já.
      if (reachedLimit()) {
        sendRunLog(run, `✓ Limite de ${maxLeads} leads atingido. Encerrando captação.`, "success");
        break;
      }
      while (run.isPaused && run.keepRunning) await sleep(1000);
      if (!run.keepRunning) break;

      const search = queue[i];
      const searchKey = makeSearchKey(search.niche, search.proximity ? `perto de ${search.region}` : search.region, effectiveFilters);
      const searchTerm = search.proximity ? proximitySearchTerm(search.niche, search.region) : `${search.niche} ${search.region}`;
      if (!exhaustedSearches.has(searchKey)) {
      if (queriesExecuted >= queryBudget) break;
      if (Date.now() >= attemptDeadline) throw new Error("Tempo máximo desta tentativa atingido; progresso preservado para retomar.");
      queriesExecuted++;
      if (!await checkpointCapture(run)) break;
      sendRunLog(run, `(${i + 1}/${queue.length}) Buscando: "${searchTerm}"...`, "info");

      const encodedSearch = encodeURIComponent(searchTerm).replace(/%20/g, "+");
      await page.goto(`https://www.google.com/maps/search/${encodedSearch}?hl=pt-BR`, {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      sendRunLog(run, "Mapa carregado. Aguardando resultados...", "info");

      // ---- Bypassing Google Consent / Cookie Page ----
      try {
        const hasConsent = await page.evaluate(() => {
          const isConsentUrl = window.location.href.includes("consent.google.com");
          if (isConsentUrl) return true;
          const text = (document.body?.innerText || "").toLowerCase();
          return text.includes("antes de continuar para o google") ||
                 text.includes("before you continue to google") ||
                 text.includes("antes de continuar para o youtube") ||
                 text.includes("antes de continuar") ||
                 text.includes("bevor sie zu google weitergehen") ||
                 text.includes("avant de continuer");
        });

        if (hasConsent) {
          sendRunLog(run, "Detectado aviso de privacidade/consentimento do Google. Aceitando...", "warning");
          await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const acceptButton = buttons.find(b => {
              const text = (b.textContent || b.innerText || "").toLowerCase();
              return text.includes('aceitar tudo') ||
                     text.includes('accept all') ||
                     text.includes('concordo') ||
                     text.includes('i agree') ||
                     text.includes('agree') ||
                     text.includes('aceitar') ||
                     text.includes('aceito') ||
                     text.includes('alle akzeptieren') ||
                     text.includes('tout accepter') ||
                     text.includes('aceptar todo');
            });
            if (acceptButton) {
              (acceptButton as HTMLButtonElement).click();
            } else {
              const form = document.querySelector('form[action*="consent.google.com/save"]');
              if (form) {
                (form as HTMLFormElement).submit();
              }
            }
          });
          // Espera navegação pós-consentimento se houve redirecionamento
          await Promise.race([
            page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 8000 }).catch(() => {}),
            sleep(4000),
          ]);
          if (page.url().includes("consent.google.com")) {
            await page.goto(`https://www.google.com/maps/search/${encodedSearch}?hl=pt-BR`, {
              waitUntil: "domcontentloaded",
              timeout: 30000,
            }).catch(() => {});
          }
        }
      } catch (e) {
        console.warn("[SCRAPER] Falha ao tentar aceitar consentimento do Google:", e);
      }
      // ------------------------------------------------

      let hasFeed = true;
      let explicitlyExhausted = false;
      let singlePlaceLead: { name: string; url: string; cardData: any } | null = null;
      try {
        await page.waitForSelector('[role="feed"]', { timeout: 15000 });
      } catch (error) {
        if ((error as Error).name !== "TimeoutError") throw error;
        hasFeed = false;

        singlePlaceLead = await page.evaluate(() => {
          const isPlaceUrl = window.location.href.includes("/maps/place/");
          const h1 = document.querySelector('h1.DUwDvf') || document.querySelector('h1');
          const hasAction = !!document.querySelector('button[data-item-id="address"]') || !!document.querySelector('button[data-item-id*="phone"]');
          if (!isPlaceUrl && !hasAction) return null;

          const name = h1?.textContent?.trim() || "";
          if (!name) return null;

          const addressBtn = document.querySelector('button[data-item-id="address"]');
          const address = addressBtn ? addressBtn.textContent?.trim().replace(/^[\s]+/, "") : "";

          const phoneBtn = document.querySelector('button[data-item-id*="phone"]');
          const phone = phoneBtn ? phoneBtn.textContent?.trim().replace(/^[\s]+/, "") : "";

          const siteBtn = document.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement | null;
          const website = siteBtn && !siteBtn.href.includes("google.com") ? siteBtn.href : "";

          const ratingEl = document.querySelector('div.F7nice span[aria-hidden="true"]');
          const rating = ratingEl ? ratingEl.textContent?.trim().replace(",", ".") : "";

          const reviewsEl = document.querySelector('div.F7nice span[aria-label*="avalia"]');
          const reviewText = reviewsEl ? reviewsEl.getAttribute("aria-label") || "" : "";
          const rm = reviewText.match(/(\d[\d.,]*)/);
          const reviewCount = rm ? parseInt(rm[1].replace(/\D/g, ""), 10) : undefined;

          const catBtn = document.querySelector('button[jsaction*="category"]');
          const category = catBtn ? catBtn.textContent?.trim() : "";

          return {
            name,
            url: window.location.href,
            cardData: {
              name,
              fullAddress: address,
              categories: category ? [category] : [],
              phone,
              website,
              averageRating: rating,
              reviewCount,
              reviewCountSources: [reviewText],
            },
          };
        });

        if (singlePlaceLead) {
          sendRunLog(run, `📍 Estabelecimento único localizado: "${singlePlaceLead.name}". Coletando dados...`, "info");
        } else {
          explicitlyExhausted = await page.evaluate(() => /nenhum resultado|não foi possível encontrar|no results found/i.test(document.body.innerText));
          if (!explicitlyExhausted) {
            sendRunLog(run, `Nenhum resultado utilizável para "${searchTerm}". Avançando busca.`, "warning");
            explicitlyExhausted = true;
          } else {
            sendRunLog(run, `Nenhum resultado para "${searchTerm}". Verificando expansão.`, "warning");
          }
        }
      }

      const processedPlaceKeys = processedByNiche.get(search.niche) || new Set<string>();
      processedByNiche.set(search.niche, processedPlaceKeys);
      const seenURLs = new Set(run.searchCursor?.key === searchKey ? run.searchCursor.seenURLs : []);
      const saveSearchCursor = async (): Promise<void> => {
        if (!run.automationId) return;
        if (seenURLs.size > 2000) throw new Error("Limite de progresso desta busca atingido; refine a região antes de retomar.");
        await checkpointCapture(run, undefined, { key: searchKey, seenURLs: [...seenURLs] });
      };
      const extractedPlaces = new Set<string>();
      let scrolling = hasFeed || !!singlePlaceLead;
      let emptyScrolls = 0;
      let previousCardsInDom = 0;
      if (hasFeed) sendRunLog(run, "Rolando para capturar cartões...", "info");

      while (scrolling && run.keepRunning && isCurrentRun()) {
        if (Date.now() >= attemptDeadline) throw new Error("Tempo máximo desta tentativa atingido; progresso preservado para retomar.");
        const previousExtractedSize = extractedPlaces.size;

        let newLeads: { name: string; url: string; cardData?: any }[] = [];
        if (hasFeed) {
          await page.evaluate(() => {
            const feed = document.querySelector('[role="feed"]');
            if (feed) feed.scrollBy(0, 1000);
          });
          await sleep(2000);

          newLeads = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll(".Nv2PK"));
            return items.map((item) => {
              const nameEl = item.querySelector(".qBF1Pd");
              const urlEl = item.querySelector("a");
              return {
                name: nameEl ? nameEl.textContent?.trim() || "" : "",
                url: urlEl ? urlEl.getAttribute("href") || "" : "",
              };
            }).filter((l) => l.name && l.url);
          });
        } else if (singlePlaceLead) {
          newLeads = [singlePlaceLead];
          scrolling = false;
          explicitlyExhausted = true;
        }

        for (const lead of newLeads) {
          if (!run.keepRunning || !isCurrentRun()) break;
          while (run.isPaused && run.keepRunning) await sleep(1000);
          if (!run.keepRunning) break;

          const placeKey = placeUrlKey(lead.url);
          if (seenURLs.has(placeKey)) continue;
          if (extractedPlaces.has(placeKey)) continue;
          extractedPlaces.add(placeKey);

          if (placeKey && processedPlaceKeys.has(placeKey)) continue;
          if (placeKey) processedPlaceKeys.add(placeKey);
          const markCandidateSeen = async (): Promise<void> => { seenURLs.add(placeKey); await saveSearchCursor(); };

          const cardData = lead.cardData || await page.evaluate((leadName: string) => {
            const items = Array.from(document.querySelectorAll(".Nv2PK"));
            const item = items.find((el) => el.querySelector(".qBF1Pd")?.textContent?.trim() === leadName);
            if (!item) return null;
            const spans = Array.from(item.querySelectorAll(".W4Efsd > span")).map((s) => s.textContent?.trim() || "");
            const category = spans.find((s) => s.length > 2 && !s.includes("·") && !s.match(/\d/)) || "";
            const address = spans.find((s) => s.includes(",") || s.includes("Av.") || s.includes("Rua")) || spans[spans.length - 1] || "";
            const textC = item.textContent || "";

            // Nota média por ARIA/texto. O total é extraído separadamente no
            // Node, mesmo quando o ARIA da nota não inclui a quantidade.
            let rating = "";

            // (1) aria-label: "Avaliação 4.8 de 5", "4.8 stars", "Rated 4.8"
            const ariaEl = item.querySelector('[role="img"][aria-label], [aria-label*="estrela" i], [aria-label*="star" i], [aria-label*="avalia" i], [aria-label*="rated" i]') as HTMLElement | null;
            if (ariaEl) {
              const aria = ariaEl.getAttribute("aria-label") || "";
              const rm = aria.match(/(\d(?:[.,]\d{1,2})?)\s*(?:de\s*5\s*)?(?:estrela|star)/i)
                      || aria.match(/(?:avalia(?:ç|c)(?:ã|a)o|rated|rating|nota)\s*[:\s]*(\d(?:[.,]\d{1,2})?)/i);
              if (rm) rating = (rm[1] || rm[2] || "").replace(",", ".");
            }

            // (2) regex expandida sobre textContent
            if (!rating) {
              const rMatch = textC.match(/(\d(?:[.,]\d{1,2})?)\s*(?:·|\s)*\(([\d.,]+[kKmM]?)\)/i);
              if (rMatch) rating = rMatch[1].replace(",", ".");
            }
            // (3) nota isolada seguida de parênteses em qualquer posição
            if (!rating) {
              const rMatch2 = textC.match(/(\d\.\d{1,2}|\d,\d{1,2})\s*[\(]?\s*(\d[\d.,]*[kKmM]?)\s*[\)]?/);
              if (rMatch2 && parseFloat(rMatch2[1].replace(",", ".")) <= 5) {
                rating = rMatch2[1].replace(",", ".");
              }
            }
            // (4) fallback `4.8 estrelas` solto
            if (!rating) {
              const rMatch3 = textC.match(/(\d(?:[.,]\d{1,2})?)\s*(?:estrela|star)/i);
              if (rMatch3) rating = rMatch3[1].replace(",", ".");
            }

            // Site do card (botão "Site" do resultado) — permite descartar
            // "Com site" SEM abrir o painel de detalhes (economia grande).
            const websiteEl = item.querySelector('a[data-value="Website"], a[data-item-id="authority"]') as HTMLAnchorElement | null;

            return {
              name: leadName,
              fullAddress: address,
              categories: category || "Comércio",
              averageRating: rating,
              reviewCount: "",
              reviewCountSources: [
                ...Array.from(item.querySelectorAll('.UY7F9')).map(el => el.textContent || ""),
                ...Array.from(item.querySelectorAll('[role="img"][aria-label]')).map(el => el.getAttribute("aria-label") || ""),
                textC,
              ],
              website: websiteEl?.href || "",
            };
          }, lead.name);

          if (!cardData) continue;
          cardData.reviewCount = extractGoogleReviewCount(cardData.reviewCountSources);

          // Colhe a cidade do endereço ANTES de qualquer descarte — até os
          // descartados alimentam o mapa de cidades vizinhas pra expansão.
          // Filtra estritamente por isValidCityName para impedir que ruas e
          // avenidas (ex: "Av. Amazonas") virem termos de busca.
          const loc = extractLocation(cardData.fullAddress);
          if (loc.cidade && isValidCityName(loc.cidade)) {
            cityCounts.set(loc.cidade, (cityCounts.get(loc.cidade) || 0) + 1);
          }

          // Descarte ULTRAPRECOCE: site já visível no card → nem abre o
          // painel de detalhes (pula navegação + reviews + filtros).
          if (settings.filterWithWebsite && cardData.website) {
            sendRunLog(run, `🚫 Descartado (Com site): ${lead.name}`, "warning");
            await markCandidateSeen();
            continue;
          }

          const cardReviewReason = reviewCountFilterReason(cardData.reviewCount, settings.minReviews, true);
          if (cardReviewReason) {
            sendRunLog(run, `🚫 Descartado (${cardReviewReason}): ${lead.name}`, "warning");
            await markCandidateSeen();
            continue;
          }

          let phoneStr = "";
          let websiteStr = "";
          // Motivo do descarte antecipado (pós-FASE 1): quando setado, pula a
          // FASE 2 (reviews profundas) — o scroll caro não roda pra lead que
          // vai ser descartado. Vazio = passou nos filtros.
          let discardedByFilters = "";
          let instagramStr = "";
          let facebookStr = "";
          let reviewsDetalhes: any[] = [];
          let businessDetails: any = null;
          let openingHours: any = null;
          let attributes: any[] = [];
          let priceRange = "";
          let openNow = "";
          let photos: string[] = [];
          let mapsUrl = "";
          let plusCode = "";
          let lat = "";
          let lng = "";
          let placeId = "";
          let distribuicaoEstrelas: Record<string, number> | undefined;
          let cep = "";
          // ---- Campos extras (2026-07-22) ----
          let businessStatus = "Operacional";
          let claimed = false;
          let ownerName = "";
          let yearEstablished = "";
          let totalPhotoCount: number | null = null;
          let reviewTopics: Record<string, string> | undefined;
          let featuredReviews: string[] | undefined;
          let additionalCategories: string[] | undefined;
          let addressComponents: any = null;
          let detailsPage;
          try {
            if (lead.url && browser) {
              detailsPage = await browser.newPage();
              try {
                if (typeof detailsPage.setCookie === "function") {
                  await detailsPage.setCookie(
                    { name: "SOCS", value: "CAISNQgDEitnd3NfMjAyNDA2MTAtMF9SQzJfZXVyb3BlX3N0YXR1c19jYTFfMjAyNDA2MTAuMV9wMBoCcHQgAQ", domain: ".google.com", path: "/" },
                    { name: "SOCS", value: "CAISNQgDEitnd3NfMjAyNDA2MTAtMF9SQzJfZXVyb3BlX3N0YXR1c19jYTFfMjAyNDA2MTAuMV9wMBoCcHQgAQ", domain: ".google.com.br", path: "/" },
                  );
                }
              } catch {}
              await detailsPage.setRequestInterception(true);
              detailsPage.on("request", (req: { resourceType: () => string; abort: () => void; continue: () => void }) => {
                if (["image", "stylesheet", "font"].includes(req.resourceType())) req.abort();
                else req.continue();
              });
                await detailsPage.goto(lead.url, { waitUntil: "domcontentloaded", timeout: 15000 });
                await sleep(2000);
                // ---- Espera ativa pelo botão de telefone (lazy loading do Google Maps) ----
                // O Google Maps carrega o painel de detalhes mas o botão "Ligar"
                // pode demorar a aparecer. Tentamos até 5s esperando pelo elemento.
                try {
                 await detailsPage.waitForSelector(
                    '[data-item-id^="phone"], [data-tooltip*="telefone" i], [aria-label*="telefone" i], [aria-label*="phone" i], [aria-label*="Ligar" i], [aria-label*="Call" i]',
                    { timeout: 5000 }
                  );
                } catch {
                  // Se não achou nesse tempo, continua mesmo assim (fallbacks no evaluate resolverão).
                }

              // ============================================================
              // FASE 1 — Captura do PAINEL PRINCIPAL (antes de qualquer
              // clique em abas). Aqui estão phone, website, instagram,
              // facebook, priceRange, openNow, horários, atributos, fotos,
              // bloco "Sobre" e qualquer review já renderizada no card
              // inicial (Google mostra as 2-3 mais recentes no topo).
              // NÃO clica em nada — clique em "Avaliações" muda o painel
              // e esconde o botão de telefone, quebrando a captura.
              // ============================================================
              const mainExtracted = await detailsPage.evaluate(() => {
                let phone = "";
                let website = "";
                let instagram = "";
                let facebook = "";
                const redesAdicionais: Record<string, string> = {};
                const detailPanel = document.querySelector('h1')?.closest('[role="main"]') || document.querySelector('[role="main"]');
                const unrelatedContent = '[data-review-id], .jftiEf, [role="article"], [jslog*="review"], [role="feed"], .Nv2PK';
                const businessName = detailPanel?.querySelector('h1')?.textContent?.trim() || "";
                // Apenas contatos atribuídos ao negócio, não links de perguntas/recomendações.
                // O Maps expõe a região "Informações de <negócio>" com telefone/endereço.
                const contactRegions = Array.from(detailPanel?.querySelectorAll('[role="region"]') || [])
                  .filter(region => businessName && region.getAttribute('aria-label')?.includes(businessName)
                    && region.querySelector('[data-item-id="address"], [data-item-id^="phone:"]')
                    && !region.closest(unrelatedContent));
                const instagramLinks = Array.from(detailPanel?.querySelectorAll<HTMLAnchorElement>('a[href]') || [])
                  .filter(a => !a.closest(unrelatedContent)
                    && (a.getAttribute('data-item-id') === 'authority' || contactRegions.some(region => region.contains(a))))
                  .map(a => a.href);

                // ---- Redes sociais e contatos (varredura de TODOS os links) ----
                const siteEls = Array.from(document.querySelectorAll('a[data-item-id="authority"], a[data-tooltip*="site" i], a[aria-label*="website" i], a[href^="http"]'));
                for (const a of siteEls) {
                  const v = (a as HTMLAnchorElement).href.toLowerCase();
                  if (v.includes("instagram.com")) { if (!instagram) instagram = (a as HTMLAnchorElement).href; }
                  else if (v.includes("facebook.com") || v.includes("fb.com")) { if (!facebook) facebook = (a as HTMLAnchorElement).href; }
                  else if (v.includes("linkedin.com")) { if (!redesAdicionais.linkedin) redesAdicionais.linkedin = (a as HTMLAnchorElement).href; }
                  else if (v.includes("twitter.com") || v.includes("x.com")) { if (!redesAdicionais.twitter) redesAdicionais.twitter = (a as HTMLAnchorElement).href; }
                  else if (v.includes("youtube.com") || v.includes("youtu.be")) { if (!redesAdicionais.youtube) redesAdicionais.youtube = (a as HTMLAnchorElement).href; }
                  else if (v.includes("tiktok.com")) { if (!redesAdicionais.tiktok) redesAdicionais.tiktok = (a as HTMLAnchorElement).href; }
                  else if (v.includes("wa.me") || v.includes("whatsapp.com")) { if (!redesAdicionais.whatsapp) redesAdicionais.whatsapp = (a as HTMLAnchorElement).href; }
                  else if (v.includes("t.me")) { if (!redesAdicionais.telegram) redesAdicionais.telegram = (a as HTMLAnchorElement).href; }
                  else if (v.includes("pinterest.com")) { if (!redesAdicionais.pinterest) redesAdicionais.pinterest = (a as HTMLAnchorElement).href; }
                  else if (!v.includes("google.com") && !v.includes("gstatic.com") && !website) {
                    if (!a.hasAttribute("jslog")) website = (a as HTMLAnchorElement).href;
                  }
                }

                const authorityEl = document.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement;
                if (authorityEl?.href && !authorityEl.href.includes("google.com")) website = authorityEl.href;

                // ---- Menu, Reservas, Agendamento ----
                let menuUrl = "";
                const menuEl = document.querySelector('a[data-item-id="menu"], a[aria-label*="menu" i], a[aria-label*="cardápio" i]') as HTMLAnchorElement;
                if (menuEl?.href) menuUrl = menuEl.href;
                let reservaUrl = "";
                const reservaEl = document.querySelector('a[data-item-id*="reserv"], a[aria-label*="reserva" i], a[aria-label*="Reserve" i], a[data-item-id="action_reservations"]') as HTMLAnchorElement;
                if (reservaEl?.href) reservaUrl = reservaEl.href;

                // ---- Telefone (vários seletores + fallback body text) ----
                // Regex brasileira expandida: aceita +55, DDD com/sem parênteses,
                // 9 inicial com/sem espaço, 4-5 dígitos + 4 dígitos, separadores -, . , espaço.
                // Ex: (27) 9 9876-5432 | (27) 99876-5432 | +55 27 3376-5432 | 2733765432 | 3376-5432
                const phoneRe = /(?:\+?55\s?)?(?:\(?0?\d{2}\)?[\s]?)?(?:9[\s]?)?(\d{4,5}[-\s.]?\d{4})/;

                const tooltipEls = Array.from(document.querySelectorAll(
                  '[data-item-id^="phone:tls"], [data-item-id^="phone"], ' +
                  'button[data-item-id^="phone"], a[data-item-id^="phone"], ' +
                  '[data-tooltip*="telefone" i], [aria-label*="telefone" i], ' +
                  '[data-tooltip*="phone" i], [aria-label*="phone" i], ' +
                  'button[aria-label*="Ligar" i], a[aria-label*="Ligar" i], ' +
                  'button[aria-label*="Call" i], a[aria-label*="Call" i]'
                ));
                for (const item of tooltipEls) {
                  const labelText = (item as HTMLElement).ariaLabel || item.getAttribute("data-tooltip") || item.getAttribute("data-item-id") || "";
                  const match = labelText.match(phoneRe);
                  if (match) { phone = labelText.trim(); break; }
                  const btnText = (item as HTMLElement).textContent || "";
                  const btnMatch = btnText.match(phoneRe);
                  if (btnMatch) { phone = btnText.trim(); break; }
                  // Se o aria-label é tipo "Ligar para +55 27 3376-5432", extrai só o número
                  const cleanNum = labelText.replace(/[^\d+]/g, "");
                  if (cleanNum.length >= 8) { phone = labelText; break; }
                }
                // Fallback 1: escanear botões que podem conter "Ligar" como texto
                if (!phone) {
                  const callButtons = Array.from(document.querySelectorAll('button, a'));
                  for (const btn of callButtons) {
                    const txt = (btn as HTMLElement).textContent || "";
                    if (/^(Ligar|Call)/i.test(txt.trim())) {
                      const aria = (btn as HTMLElement).getAttribute("aria-label") || txt;
                      const m = aria.match(phoneRe);
                      if (m) { phone = aria.trim(); break; }
                    }
                  }
                }
                // Fallback 2: varre o body inteiro com regex robusta
                if (!phone) {
                  const bodyText = document.body.innerText || "";
                  const bodyMatch = bodyText.match(phoneRe);
                  if (bodyMatch) phone = bodyMatch[0].trim();
                }
                // Fallback 3: procura por padrão "Telefone:" ou "Phone:" seguido de número
                if (!phone) {
                  const bodyText2 = document.body.innerText || "";
                  const labelMatch = bodyText2.match(/(?:Telefone|Phone|Tel\.?)\s*:?\s*(\+?\d[\d\s().-]{7,})/i);
                  if (labelMatch) phone = labelMatch[1].trim();
                }

                const canonicalHref = (document.querySelector('a[data-item-id="place_id"]') as HTMLAnchorElement)?.href
                  || (document.querySelector('link[rel="canonical"]') as HTMLLinkElement)?.href
                  || location.href;
                const mapsUrl = canonicalHref;

                // ---- Place ID (0x...:0x... ou ChIJ...) extraído da URL ----
                let placeId = "";
                const pidMatch1 = mapsUrl.match(/0x[0-9a-f]+:0x[0-9a-f]+/i);
                if (pidMatch1) placeId = pidMatch1[0];
                const pidMatch2 = mapsUrl.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
                if (!placeId && pidMatch2) placeId = pidMatch2[1];
                const pidMatch3 = mapsUrl.match(/!2s(ChIJ[A-Za-z0-9_-]+)/);
                if (!placeId && pidMatch3) placeId = pidMatch3[1];
                const pidMatch4 = mapsUrl.match(/(ChIJ[A-Za-z0-9_-]+)/);
                if (!placeId && pidMatch4) placeId = pidMatch4[1];

                // ---- Latitude / Longitude extraídas da URL (!3dLAT!4dLNG) ----
                let lat = "";
                let lng = "";
                const latMatch = mapsUrl.match(/!3d(-?\d{1,3}\.\d+)/);
                const lngMatch = mapsUrl.match(/!4d(-?\d{1,3}\.\d+)/);
                if (latMatch) lat = latMatch[1];
                if (lngMatch) lng = lngMatch[1];
                // fallback na URL curta @lat,lng
                if (!lat) {
                  const atMatch = mapsUrl.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
                  if (atMatch) { lat = atMatch[1]; lng = atMatch[2]; }
                }

                // ---- Plus Code (Open Location Code) ----
                let plusCode = "";
                const plusEl = document.querySelector('[data-item-id="olr"], button[data-item-id*="olr"]') as HTMLElement;
                if (plusEl) {
                  plusCode = (plusEl.innerText || plusEl.getAttribute("aria-label") || "").trim();
                }
                if (!plusCode) {
                  const bodyTxt2 = document.body.innerText || "";
                  const pcMatch = bodyTxt2.match(/\b([23456789CFGHJMPQRVWX]{4}\+[23456789CFGHJMPQRVWX]{2,3}(?:,[23456789CFGHJMPQRVWX]+)?)\b/);
                  if (pcMatch) plusCode = pcMatch[1];
                }

                // ---- Faixa de preço + status "Aberto agora" ----
                let priceRange = "";
                const bodyTxt = document.body.innerText || "";
                const priceMatch = bodyTxt.match(/\${1,4}\s*·/) || bodyTxt.match(/\b(\${1,4})\b/);
                if (priceMatch) priceRange = priceMatch[1] || priceMatch[0].trim();
                let openNow = "";
                const openMatch = bodyTxt.match(/(Aberto agora|Fechado|Fechado temporariamente|Aberto 24 horas|Aberto .*?horas)/i);
                if (openMatch) openNow = openMatch[1];

                // ---- Horários de funcionamento detalhados por dia ----
                const openingHours: any = {};
                const hoursEls = Array.from(document.querySelectorAll('[aria-label*="horário" i], [aria-label*="hours" i], [data-tooltip*="horário" i]'));
                if (hoursEls.length > 0) {
                  const txt = (hoursEls[0] as HTMLElement).textContent || "";
                  const dayRe = /(Dom|Seg|Ter|Qua|Qui|Sex|S[aá]b|Sun|Mon|Tue|Wed|Thu|Fri|Sat)[\s:]+([0-9h:.\-–\s]+[0-9h:.\-–\s ]*)/gi;
                  let m: RegExpExecArray | null;
                  while ((m = dayRe.exec(txt))) openingHours[m[1]] = m[2].trim();
                  if (Object.keys(openingHours).length === 0) openingHours.raw = txt.slice(0, 500);
                }

                // ---- Popular times (horários de movimento da semana) ----
                const popularTimes: any = {};
                // Google renderiza como barras com aria-label "Movimentação: Segunda-feira, 14h, X%"
                const popEls = Array.from(document.querySelectorAll('div[aria-label*="movimentação" i], div[aria-label*="popular" i], bar[aria-label*="movimentação" i]'));
                for (const el of popEls) {
                  const aria = (el as HTMLElement).getAttribute("aria-label") || "";
                  const m = aria.match(/(Domingo|Segunda|Ter[cç]a|Quarta|Quinta|Sexta|S[aá]bado|Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)[^\d]*(\d{1,2})\s*h[^\d]*?(\d+)%/i);
                  if (m) {
                    const day = m[1];
                    if (!popularTimes[day]) popularTimes[day] = [];
                    popularTimes[day].push({ hora: parseInt(m[2]), ocupacao: parseInt(m[3]) });
                  }
                }
                // também tenta o bloco "Movimentação atual"
                const liveMatch = bodyTxt.match(/(?:Movimentação atual|Live){1}[:\s]*((?:Muito|Bastante|Pouco|Normal|Ocupad[oa]|Vazio|Tranquilo)[^\n.]{0,30})/i);
                if (liveMatch) popularTimes.atual = liveMatch[1].trim();

                // ---- Atributos (delivery, acessibilidade, etc.) — captura categoria + valor ----
                const attributes: any[] = [];
                const attrSeen = new Set<string>();
                const attrEls = Array.from(document.querySelectorAll('div[role="button"][aria-label], button[aria-label], div.D2Ei1b, button[jsaction*="pane"]'));
                for (const el of attrEls) {
                  const t = (el as HTMLElement).getAttribute("aria-label") || (el as HTMLElement).textContent || "";
                  const trimmed = t.trim();
                  if (!trimmed || trimmed.length > 80) continue;
                  if (/(delivery|entrega|retirada|takeout|dine-in|balcão|reserva|wheelchair|cadeira|estacionamento|parking|acessib|wifi|ar condicionado|pet friendly|aceita|cart[aã]o|dinheiro|pix|debit|credit|outdoor|ar livre|drive-thru)/i.test(trimmed)) {
                    if (!attrSeen.has(trimmed)) {
                      attrSeen.add(trimmed);
                      attributes.push(trimmed);
                    }
                  }
                  if (attributes.length >= 50) break;
                }

                // ---- Fotos (aumenta pra 50 e captura categorias) ----
                const photoSeen = new Set<string>();
                const photos: string[] = [];
                const imgEls = Array.from(document.querySelectorAll('img[src*="googleusercontent"], img[src*="ggpht"]'));
                for (const img of imgEls) {
                  const src = (img as HTMLImageElement).src.split("=")[0];
                  if (src && !photoSeen.has(src)) {
                    photoSeen.add(src);
                    photos.push(src);
                    if (photos.length >= 50) break;
                  }
                }

                // ---- Bloco "Sobre" + Serviços + Descrição completa ----
                const businessDetails: any = {};
                const aboutEl = document.querySelector('[aria-label*="sobre" i], [aria-label*="about" i], section[data-id="about"]');
                if (aboutEl) businessDetails.about = ((aboutEl as HTMLElement).innerText || "").slice(0, 5000);

                // Descrição estendida (alguns lugares têm "Descrição" separada do "Sobre")
                const descEl = document.querySelector('[aria-label*="descri" i], [jslog*="description"]');
                if (descEl) businessDetails.descricao = ((descEl as HTMLElement).innerText || "").slice(0, 3000);

                // Subcategorias / "As pessoas buscam por"
                const subcategorias: string[] = [];
                const subcatEls = Array.from(document.querySelectorAll('button[jslog*="attribute"], .gm2-body-text, .Rk53df'));
                for (const sc of subcatEls) {
                  const txt = (sc as HTMLElement).textContent?.trim() || "";
                  if (txt.length >= 3 && txt.length <= 80 && !subcategorias.includes(txt)) subcategorias.push(txt);
                  if (subcategorias.length >= 30) break;
                }
                if (subcategorias.length) businessDetails.subcategorias = subcategorias;

                // "As pessoas procuram por" / "People often search for"
                const pProcuram: string[] = [];
                const pProcuramMatch = bodyTxt.match(/(?:As pessoas procuram por|People (?:often )?search for)[:\s]*([^\n]{5,500})/i);
                if (pProcuramMatch) {
                  const itens = pProcuramMatch[1].split(/[,·|]/).map(s => s.trim()).filter(s => s.length >= 3 && s.length <= 80);
                  businessDetails.pessoasProcuramPor = itens.slice(0, 20);
                }

                // Serviços listados
                const serviceEls = Array.from(document.querySelectorAll('div[role="button"][aria-label*="serviço" i], li'));
                const services: string[] = [];
                for (const s of serviceEls) {
                  const t = (s as HTMLElement).textContent?.trim() || "";
                  if (t.length >= 3 && t.length <= 80 && !services.includes(t)) services.push(t);
                  if (services.length >= 30) break;
                }
                if (services.length) businessDetails.services = services;

                // "Atualizado há X" / Informações verificadas pelo dono
                const updatedMatch = bodyTxt.match(/(?:atualizado|updated)\s+(?:em|h[aá]|há)\s+([^\n.]{2,40})/i);
                if (updatedMatch) businessDetails.atualizadoEm = updatedMatch[1].trim();

                // ---- Anexar dados extras em businessDetails ----
                businessDetails.plusCode = plusCode;
                businessDetails.lat = lat;
                businessDetails.lng = lng;
                businessDetails.placeId = placeId;
                if (Object.keys(popularTimes).length > 0) businessDetails.popularTimes = popularTimes;
                if (Object.keys(redesAdicionais).length > 0) businessDetails.redesAdicionais = redesAdicionais;
                if (menuUrl) businessDetails.menuUrl = menuUrl;
                if (reservaUrl) businessDetails.reservaUrl = reservaUrl;

                // ---- CEP separado do endereço completo ----
                let cep = "";
                const cepMatch = bodyTxt.match(/\b(\d{5}-\d{3})\b/);
                if (cepMatch) cep = cepMatch[1];

                // ============================================================
                // CAPTURA EXTRA — campos avançados (2026-07-22):
                // - businessStatus: "Operacional" / "Permanently closed" / "Temporariamente fechado"
                // - claimed: se o dono reivindicou a ficha (sinal de negócio ativo/responsivo)
                // - ownerName: nome do dono/gerente quando listado publicamente
                // - yearEstablished: ano de fundação
                // - totalPhotoCount: nº TOTAL de fotos (mesmo que só pegamos 50)
                // - reviewTopics: tópicos do Google ("Comida: 4.8★", "Atendimento: 4.5★")
                // - featuredReviews: reviews em destaque escolhidas pelo Google
                // - additionalCategories: categorias secundárias
                // - addressComponents: rua/numero/bairro/cidade/estado separados
                // ============================================================
                let businessStatus = "Operacional";
                if (/permanently closed|fechado definitivamente|encerrado/i.test(bodyTxt)) {
                  businessStatus = "Permanently closed";
                } else if (/temporarily closed|fechado temporariamente/i.test(bodyTxt)) {
                  businessStatus = "Temporarily closed";
                }

                let claimed = false;
                const claimEl = document.querySelector('[aria-label*="reivindicad" i], [aria-label*="claim" i], [jslog*="claim"]');
                if (claimEl) claimed = true;
                // Fallback: o botão "Reivindicar esta empresa" aparece quando
                // NÃO é claimed. Se ele NÃO está, é porque JÁ é claimed.
                const claimThisBtn = document.querySelector('button[data-item-id*="claim"], button[aria-label*="Reivindicar" i]');
                if (!claimThisBtn) {
                  // Sem botão de reivindicar = já é gerenciado pelo dono.
                  // Confirmamos com mais um sinal: presence de "Gerenciar no Google"
                  // ou posts recentes / atualizações do dono.
                  const ownerManaged = document.querySelector('[jslog*="merchant"], [data-item-id*="owner"]');
                  if (ownerManaged) claimed = true;
                }

                let ownerName = "";
                const ownerNameEl = document.querySelector('[aria-label*="gerente" i], [aria-label*="manager" i], [jslog*="owner_name"]');
                if (ownerNameEl) {
                  const txt = (ownerNameEl as HTMLElement).innerText || "";
                  const m = txt.match(/(?:gerente|manager|propriet[aá]rio|owner)[:\s]*([^\n,]{2,60})/i);
                  if (m) ownerName = m[1].trim();
                }

                let yearEstablished = "";
                const yearMatch = bodyTxt.match(/(?:fundado|aberto|since|desde|established)\s+(?:em\s+|in\s+)?(\d{4})/i);
                if (yearMatch) yearEstablished = yearMatch[1];

                let totalPhotoCount: number | null = null;
                const photoCountMatch = bodyTxt.match(/(\d[\d.]*)\s+(?:fotos?|photos?)/i);
                if (photoCountMatch) {
                  totalPhotoCount = parseInt(photoCountMatch[1].replace(/\D/g, "")) || null;
                }

                // Tópicos das reviews: "Comida: 4.8", "Atendimento: 4.5", etc.
                // Google agrupa reviews em tópicos quando tem volume suficiente.
                const reviewTopics: Record<string, string> = {};
                const topicEls = Array.from(document.querySelectorAll('[jslog*="topic_rating"], [data-topic-rating], div[aria-label*=":" i]'));
                for (const tEl of topicEls) {
                  const aria = (tEl as HTMLElement).getAttribute("aria-label") || (tEl as HTMLElement).textContent || "";
                  const tm = aria.match(/([^:]{2,40}):\s*(\d(?:[.,]\d)?)/);
                  if (tm) {
                    const topic = tm[1].trim();
                    const rating = tm[2];
                    if (topic.length >= 3 && topic.length <= 40) reviewTopics[topic] = rating;
                  }
                  if (Object.keys(reviewTopics).length >= 10) break;
                }

                // Reviews em destaque (Featured) — selecionadas pelo Google
                const featuredReviews: any[] = [];
                const featuredEls = Array.from(document.querySelectorAll('[jslog*="featured"], div[data-featured="true"], div[aria-label*="destaque" i]'));
                for (const fEl of featuredEls) {
                  const txt = ((fEl as HTMLElement).innerText || "").slice(0, 1500).trim();
                  if (txt.length > 30) featuredReviews.push(txt);
                  if (featuredReviews.length >= 3) break;
                }

                // Categorias secundárias (além da principal)
                const additionalCategories: string[] = [];
                const catEls = Array.from(document.querySelectorAll('button[jslog*="category"], button[aria-label*="categoria" i], a[href*="/search/"]'));
                for (const c of catEls) {
                  const txt = (c as HTMLElement).textContent?.trim() || "";
                  if (txt && txt.length >= 3 && txt.length <= 60 && !additionalCategories.includes(txt)) {
                    additionalCategories.push(txt);
                  }
                  if (additionalCategories.length >= 10) break;
                }

                // Address components (rua/numero/bairro/cidade/estado separados)
                const addressComponents: any = {};
                // Extrai endereço completo do painel de detalhes do Google Maps
                let fullAddress = "";
                const addrEl = document.querySelector('[data-item-id="address"], button[data-item-id="address"]') as HTMLElement;
                if (addrEl) fullAddress = (addrEl.innerText || addrEl.getAttribute("aria-label") || "").trim();
                if (!fullAddress) {
                  // Fallback: procura texto que parece endereço no body
                  const addrMatch = bodyTxt.match(/((?:Rua|Av\.?|Avenida|Travessa|Alameda|Praça|Rod\.?|Estrada)\s+[^,\n]+,\s*\d+)/i);
                  if (addrMatch) fullAddress = addrMatch[1].trim();
                }
                if (fullAddress) {
                  // Cidade/Estado: "São Paulo, SP" no final do endereço
                  const cityStateMatch = fullAddress.match(/([^,]+),\s*([A-Z]{2})\s*(?:[-,]|\s*$)/);
                  if (cityStateMatch) {
                    addressComponents.cidade = cityStateMatch[1].trim();
                    addressComponents.estado = cityStateMatch[2].trim();
                  }
                  // CEP
                  if (cep) addressComponents.cep = cep;
                  // Rua + número
                  const streetMatch = fullAddress.match(/^(?:Rua|Av\.?|Avenida|Travessa|Alameda|Praça|Rod\.?)\s+([^,]+?),?\s*(\d+)?/i);
                  if (streetMatch) {
                    addressComponents.rua = streetMatch[0].trim();
                    if (streetMatch[2]) addressComponents.numero = streetMatch[2];
                  }
                  // Bairro: entre vírgulas (ex: "Rua X, 123, Bairro Y, Cidade - UF")
                  const parts = fullAddress.split(",").map((p: string) => p.trim());
                  if (parts.length >= 3) {
                    // 2º item costuma ser número, 3º bairro
                    if (!addressComponents.bairro && parts[2] && !/^\d/.test(parts[2])) {
                      addressComponents.bairro = parts[2].split(" - ")[0];
                    }
                  }
                }

                // ---- Avaliação agregada (estrelas + nº de reviews) ----
                // Google BR usa ária "Avaliação 4.8 de 5" (sem "estrela") e
                // `.F6sie`/`.MW4l2` nem sempre tem — multi-strategy igual ao
                // card. Praticamente todo negócio tem rating no painel detalhe.
                let ratingAggregate: string = "";
                const rEl = document.querySelector(
                  '[role="img"][aria-label], [aria-label*="estrela" i], [aria-label*="star" i], [aria-label*="avalia" i], [aria-label*="rated" i], .F6sie, .MW4l2, .fontDisplayLarge'
                );
                if (rEl) {
                  const aria = (rEl as HTMLElement).getAttribute("aria-label") || "";
                  const m1 = aria.match(/(\d(?:[.,]\d{1,2})?)\s*(?:de\s*5\s*)?(?:estrela|star)/i)
                          || aria.match(/(?:avalia(?:ç|c)(?:ã|a)o|rated|rating|nota)\s*[:\s]*(\d(?:[.,]\d{1,2})?)/i);
                  if (m1) ratingAggregate = (m1[1] || m1[2] || "").replace(",", ".");
                }
                // textContent do próprio elemento rating (caso ária vazia)
                if (!ratingAggregate && rEl) {
                  const rt = (rEl as HTMLElement).textContent || "";
                  const tm = rt.match(/(\d(?:[.,]\d{1,2})?)/);
                  if (tm && parseFloat(tm[1].replace(",", ".")) <= 5) ratingAggregate = tm[1].replace(",", ".");
                }
                // bodyTxt: forma `4.8 (1.234)` / `4.8 · 1.234` / `4.8 estrelas`
                if (!ratingAggregate) {
                  const bMatch = bodyTxt.match(/(\d(?:[.,]\d{1,2})?)\s*(?:·|\s)*[\(]?\s*(\d[\d.,]*[kKmM]?)\s*[\)]?/)
                              || bodyTxt.match(/(\d(?:[.,]\d{1,2})?)\s*(?:estrela|star)/i);
                  if (bMatch) ratingAggregate = bMatch[1].replace(",", ".");
                }
                // Só fontes do resumo agregado; avaliações individuais trazem
                // totais do perfil do autor, que NÃO pertencem ao negócio.
                const reviewCountSources: string[] = [];
                // Somente resumo/controle agregado do negócio atual, nunca
                // barras por estrela, tópicos, autores ou outros resultados.
                for (const summary of Array.from(detailPanel?.querySelectorAll('.F7nice, button[jsaction*="moreReviews"]') || [])) {
                  if (summary.closest('[data-review-id], .jftiEf, [role="article"], [jslog*="review"], [role="feed"], .Nv2PK')) continue;
                  reviewCountSources.push(
                    summary.getAttribute("aria-label") || "",
                    ...Array.from(summary.querySelectorAll('[aria-label]')).map(el => el.getAttribute("aria-label") || ""),
                  );
                  // Não concatena a nota inteira com o total: "5" + "123 reviews"
                  // viraria "5 123 reviews", um falso total de 5.123 votos.
                  const texts = document.createTreeWalker(summary, NodeFilter.SHOW_TEXT);
                  while (texts.nextNode()) reviewCountSources.push(texts.currentNode.textContent || "");
                }

                // ---- Distribuição de estrelas (5★, 4★, 3★, 2★, 1★) ----
                // Google mostra como barras com aria-label "5 estrelas: 123".
                const distribuicaoEstrelas: Record<string, number> = {};
                const distEls = Array.from(document.querySelectorAll('tr[aria-label*="estrela" i], div[aria-label*="estrela" i], bar[aria-label*="star" i]'));
                for (const el of distEls) {
                  const aria = (el as HTMLElement).getAttribute("aria-label") || (el as HTMLElement).textContent || "";
                  const dm = aria.match(/(\d)\s*(?:estrela|star)s?[^0-9]*(\d[\d.,]*)/i);
                  if (dm) {
                    const star = dm[1];
                    const count = parseInt(dm[2].replace(/\D/g, "")) || 0;
                    distribuicaoEstrelas[`${star}estrelas`] = count;
                  }
                }

                // ---- Reviews que já vêm renderizadas no painel principal ----
                // Google coloca as 2-3 mais recentes no topo.
                const reviewEls0 = Array.from(document.querySelectorAll('div[role="article"][aria-label], div[data-review-id], div[jslog*="review"]'));
                const reviewsInitial: any[] = [];
                const reviewSeen = new Set<string>();
                for (const r of reviewEls0) {
                  const aria = r.getAttribute("aria-label") || "";
                  const authorMatch = aria.match(/(?:avaliaç(?:ão)?\s+de|review\s+by)\s+(.+?)(?::|\s+\d\s)/i);
                  const author = authorMatch ? authorMatch[1].trim() : "";
                  const ratingMatch = aria.match(/(\d(?:[.,]\d)?)\s*(?:estrela|star)/i);
                  const rating = ratingMatch ? ratingMatch[1] : "";
                  const text = ((r as HTMLElement).innerText || "").slice(0, 1500).trim();
                  const sig = text.slice(0, 80);
                  if (!text || reviewSeen.has(sig)) continue;
                  reviewSeen.add(sig);
                  const dateMatch = text.match(/(há\s+\d+\s+\w+|\d+\s+(?:dias?|semanas?|meses|anos?|day|week|month|year)s?\s+ago)/i);
                  // Foto do reviewer (avatar)
                  const authorImg = r.querySelector('img[src*="googleusercontent"], img[src*="ggpht"]') as HTMLImageElement;
                  const fotoAutor = authorImg ? (authorImg.src.split("=")[0]) : "";
                  // Fotos anexadas à review (não contar o avatar)
                  const fotos: string[] = [];
                  const reviewImgs = Array.from(r.querySelectorAll('img[src*="googleusercontent"], img[src*="ggpht"]'));
                  for (const img of reviewImgs) {
                    const src = (img as HTMLImageElement).src.split("=")[0];
                    if (src && src !== fotoAutor && !fotos.includes(src) && fotos.length < 8) fotos.push(src);
                  }
                  // Resposta do dono (bloco separado dentro da review)
                  let respostaDono = "";
                  const ownerReplyEl = r.querySelector('[jslog*="owner"], div[data-owner-response], [class*="owner"]');
                  if (ownerReplyEl) respostaDono = ((ownerReplyEl as HTMLElement).innerText || "").slice(0, 1500).trim();
                  // Contador "útil" / likes
                  let util = 0;
                  const utilMatch = text.match(/(\d+)\s*(?:pessoas?|pessoa|users?|people)\s*(?:acharam|found|marked)\s*(?:útil|useful|helpful)/i);
                  if (utilMatch) util = parseInt(utilMatch[1]);
                  reviewsInitial.push({
                    autor: author,
                    nota: rating,
                    data: dateMatch ? dateMatch[1] : "",
                    texto: text,
                    fotoAutor,
                    fotos: fotos.length ? fotos : undefined,
                    respostaDono: respostaDono || undefined,
                    util: util || undefined,
                  });
                  if (reviewsInitial.length >= 50) break;
                }

                return {
                  phone, website, instagram, facebook, instagramLinks,
                  mapsUrl,
                  priceRange,
                  openNow,
                  openingHours,
                  attributes,
                  photos,
                  businessDetails,
                  reviews: reviewsInitial,
                  ratingAggregate,
                  reviewCountSources,
                  distribuicaoEstrelas: Object.keys(distribuicaoEstrelas).length > 0 ? distribuicaoEstrelas : undefined,
                  cep,
                  plusCode,
                  lat,
                  lng,
                  placeId,
                  // ---- Campos extras (2026-07-22) ----
                  businessStatus,
                  claimed,
                  ownerName,
                  yearEstablished,
                  totalPhotoCount,
                  reviewTopics: Object.keys(reviewTopics).length > 0 ? reviewTopics : undefined,
                  featuredReviews: featuredReviews.length > 0 ? featuredReviews : undefined,
                  additionalCategories: additionalCategories.length > 0 ? additionalCategories : undefined,
                  addressComponents: Object.keys(addressComponents).length > 0 ? addressComponents : undefined,
                };
              });

              if (mainExtracted) {
                phoneStr = mainExtracted.phone;
                websiteStr = mainExtracted.website;
                instagramStr = settings.filterWithInstagram
                  ? mainExtracted.instagramLinks.map(normalizeInstagramProfile).find(Boolean) || ""
                  : mainExtracted.instagram;
                facebookStr = mainExtracted.facebook;
                if (Array.isArray(mainExtracted.reviews) && mainExtracted.reviews.length > 0) reviewsDetalhes = mainExtracted.reviews;
                if (mainExtracted.businessDetails && Object.keys(mainExtracted.businessDetails).length > 0) businessDetails = mainExtracted.businessDetails;
                if (mainExtracted.openingHours && Object.keys(mainExtracted.openingHours).length > 0) openingHours = mainExtracted.openingHours;
                if (Array.isArray(mainExtracted.attributes) && mainExtracted.attributes.length > 0) attributes = mainExtracted.attributes;
                if (mainExtracted.priceRange) priceRange = mainExtracted.priceRange;
                if (mainExtracted.openNow) openNow = mainExtracted.openNow;
                if (Array.isArray(mainExtracted.photos) && mainExtracted.photos.length > 0) photos = mainExtracted.photos;
                if (mainExtracted.mapsUrl) mapsUrl = mainExtracted.mapsUrl;
                // fallback: se o scraper principal (cardData) não tiver pego
                // rating/reviews, usa o que veio do painel de detalhe.
                if (!cardData.averageRating && mainExtracted.ratingAggregate) cardData.averageRating = mainExtracted.ratingAggregate;
                cardData.reviewCount = extractGoogleReviewCount(mainExtracted.reviewCountSources, cardData.reviewCount);
                if (mainExtracted.plusCode) plusCode = mainExtracted.plusCode;
                if (mainExtracted.lat) lat = mainExtracted.lat;
                if (mainExtracted.lng) lng = mainExtracted.lng;
                if (mainExtracted.placeId) placeId = mainExtracted.placeId;
                if (mainExtracted.distribuicaoEstrelas) distribuicaoEstrelas = mainExtracted.distribuicaoEstrelas;
                if (mainExtracted.cep) cep = mainExtracted.cep;
                // ---- Campos extras (2026-07-22) ----
                if (mainExtracted.businessStatus) businessStatus = mainExtracted.businessStatus;
                if (mainExtracted.claimed) claimed = mainExtracted.claimed;
                if (mainExtracted.ownerName) ownerName = mainExtracted.ownerName;
                if (mainExtracted.yearEstablished) yearEstablished = mainExtracted.yearEstablished;
                if (mainExtracted.totalPhotoCount != null) totalPhotoCount = mainExtracted.totalPhotoCount;
                if (mainExtracted.reviewTopics) reviewTopics = mainExtracted.reviewTopics;
                if (mainExtracted.featuredReviews) featuredReviews = mainExtracted.featuredReviews;
                if (mainExtracted.additionalCategories) additionalCategories = mainExtracted.additionalCategories;
                if (mainExtracted.addressComponents) addressComponents = mainExtracted.addressComponents;
                // Colheita de cidade REAL do painel de detalhes — fonte
                // universal: o Google SEMPRE traz "Cidade, UF" no painel, para
                // qualquer lugar do Brasil (conhecido ou não no dicionário).
                if (addressComponents?.cidade) {
                  const detUf =
                    (addressComponents.estado ? String(addressComponents.estado).toUpperCase() : "") ||
                    (cep ? ufFromCep(cep) : "") || "";
                  const key = detUf ? `${addressComponents.cidade} - ${detUf}` : addressComponents.cidade;
                  if (isValidCityName(addressComponents.cidade)) {
                    cityCounts.set(key, (cityCounts.get(key) || 0) + 1);
                  }
                }
              }

              // ============================================================
              // FILTROS ANTECIPADOS — logo após a FASE 1 (telefone + site já
              // conhecidos). Descarta ANTES da captura profunda de reviews:
              // não gastamos 10-30s de scroll em lead que será descartado.
              // ============================================================
              const earlyCheck = evaluateLeadFilters(phoneStr.replace(/\D/g, ""), websiteStr, settings, leadsStore, cardData.reviewCount, instagramStr);
              if (!earlyCheck.pass) {
                discardedByFilters = earlyCheck.reason;
                sendRunLog(run, `🚫 Descartado (${earlyCheck.reason}): ${lead.name}`, "warning");
              }

              // ============================================================
              // DUPLICATA DE CRM ANTECIPADA — logo após a FASE 1 (telefone
              // já conhecido). Se o JID já está no CRM, descarta NA HORA e
              // pula a FASE 2 (reviews profundas = 10-30s de scroll caro).
              // ============================================================
              if (!discardedByFilters) {
                const earlyJid = formatJid(phoneStr);
                const earlyDup = await checkCrmDuplicate(earlyJid, currentClientId, { phones: phoneStr, mapsUrl: mapsUrl || lead.url, placeId });
                if (earlyDup) {
                  crmSkipped++;
                  sendRunLog(run, `⏭️ Já no CRM (${earlyDup}): ${lead.name}`, "info");
                  discardedByFilters = `Já no CRM (${earlyDup})`;
                }
              }

              // ============================================================
              // FASE 2 — Capturar reviews profundas.
              // ============================================================
              const reviewLimit = settings.captureAllReviews ? Number.MAX_SAFE_INTEGER : 50;
              if (!discardedByFilters && (settings.captureAllReviews || reviewsDetalhes.length < reviewLimit)) {
                try {
                  // ---- Abrir a lista de reviews (UI nova 2025+ do Maps) ----
                  // A UI nova NÃO tem [role="feed"] na aba Avaliações: as
                  // reviews ficam num div.m6QErb rolável. Além disso, lead.url
                  // (URL de card, com /data=!...) + "/reviews" gera URL
                  // inválida → Google cai no Overview sem reviews → captura
                  // congela nas 2-3 de preview (bug "3 de ~492").
                  // Clicar a ABA primeiro SEMPRE: o wait inicial resolvia no
                  // preview do Overview (2-3 .jftiEf soltos) e o loop nunca
                  // via a lista completa. Clique em aba já ativa é no-op.
                  if (settings.captureAllReviews) {
                    sendRunLog(run, `📝 Carregando todas as avaliações disponíveis: ${cardData.name}`, "info");
                  }
                  const reviewWaitSel = '.jftiEf, div[data-review-id], div[role="feed"]';
                  await detailsPage.evaluate(() => {
                    const tab = Array.from(document.querySelectorAll('[role="tab"], button[aria-label*="valia" i]'))
                      .find((el) => /avalia/i.test(`${(el as HTMLElement).innerText || ""} ${(el as HTMLElement).getAttribute("aria-label") || ""}`));
                    (tab as HTMLElement | undefined)?.click();
                  });
                  let reviewsVisible = await detailsPage.waitForSelector(reviewWaitSel, { timeout: 6000 }).catch(() => null);
                  if (!reviewsVisible) {
                    await detailsPage.evaluate(() => {
                      const cands = Array.from(document.querySelectorAll('button, [role="button"], a')) as HTMLElement[];
                      const trigger = cands.find((e) => /^[\d.,]+[kK]?\s*(?:avalia|review)/i.test((e.innerText || "").trim()) || /(?:avaliações|avaliacoes|reviews?)\s*$/i.test((e.getAttribute("aria-label") || "").trim()));
                      trigger?.click();
                    });
                    reviewsVisible = await detailsPage.waitForSelector(reviewWaitSel, { timeout: 5000 }).catch(() => null);
                  }
                  if (!reviewsVisible) {
                    // Último recurso: URL /reviews — precisa de URL limpa
                    // (sem /@lat,lng nem /data=!..., que o Google ignora).
                    const base = lead.url.split("?")[0].replace(/\/$/, "");
                    const cutIdx = [base.indexOf("/@"), base.indexOf("/data=")].filter((i) => i > 0).sort((a, b) => a - b)[0];
                    const cleanBase = cutIdx ? base.slice(0, cutIdx) : base;
                    const reviewsUrl = cleanBase.endsWith("/reviews") ? cleanBase : `${cleanBase}/reviews`;
                    if (reviewsUrl !== base || !cutIdx) {
                      await detailsPage.goto(reviewsUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
                      await detailsPage.waitForSelector(reviewWaitSel, { timeout: 8000 }).catch(() => {});
                    }
                  }
                  await sleep(1200);
                  await detailsPage.evaluate(() => { delete (window as any).__painelSdrReviews; });

                  // Distribuição de estrelas (barras 5★-1★) — melhor capturar
                  // aqui pq a página de reviews sempre mostra elas no topo.
                  if (!distribuicaoEstrelas) {
                    const dist = await detailsPage.evaluate(() => {
                      const out: Record<string, number> = {};
                      const distEls = Array.from(document.querySelectorAll('tr[aria-label*="estrela" i], div[aria-label*="estrela" i], bar[aria-label*="star" i], tr[jslog*="review"]'));
                      for (const el of distEls) {
                        const aria = (el as HTMLElement).getAttribute("aria-label") || (el as HTMLElement).textContent || "";
                        const dm = aria.match(/(\d)\s*(?:estrela|star)s?[^0-9]*(\d[\d.,]*)/i);
                        if (dm) out[`${dm[1]}estrelas`] = parseInt(dm[2].replace(/\D/g, "")) || 0;
                      }
                      return out;
                    });
                    if (Object.keys(dist).length > 0) distribuicaoEstrelas = dist;
                  }

                  let semNovidade = 0;
                  let cachedCountAnterior = 0;
                  const MAX_ROLAGENS = settings.captureAllReviews ? 1000 : 25;
                  // "Capturar todas" = paciência maior: o Maps carrega reviews
                  // em lazy chunks; 3 rodadas sem novidade (~3,5s) cortava
                  // listas longas no meio. 6 rodadas (~7s) cobre chunks lentos.
                  const PACIENCIA = settings.captureAllReviews ? 6 : 3;
                  // Container travado: se scrollTop não move por 2 rodadas,
                  // ativa rolagens alternativas (janela + wheel no feed) —
                  // sem isso, negócios grandes paravam nas ~5 iniciais.
                  let semMovimento = 0;
                  let scrollAggressivo = false;
                  for (let i = 0; i < MAX_ROLAGENS; i++) {
                    await detailsPage.evaluate(() => {
                      const reviewSelector = '.jftiEf, div[role="article"][aria-label], div[data-review-id], div[jslog*="review"]';
                      for (const review of Array.from(document.querySelectorAll(reviewSelector))) {
                        const expand = Array.from(review.querySelectorAll('button, [role="button"]')).find((element) => /^(?:mais|more)$/i.test((element.textContent || "").trim())) as HTMLElement | undefined;
                        expand?.click();
                      }
                    });
                    await sleep(250);
                    const novos = await detailsPage.evaluate((aggressive: boolean) => {
                      const reviewSelector = '.jftiEf, div[role="article"][aria-label], div[data-review-id], div[jslog*="review"]';
                      const cacheKey = "__painelSdrReviews";
                      const cached = ((window as any)[cacheKey] ||= {}) as Record<string, any>;
                      for (const review of Array.from(document.querySelectorAll(reviewSelector))) {
                        const element = review as HTMLElement;
                        const aria = element.getAttribute("aria-label") || "";
                        const text = element.innerText.trim().slice(0, 12000);
                        const signature = text.slice(0, 180);
                        if (!text || cached[signature]) continue;
                        const authorMatch = aria.match(/(?:avaliaç(?:ão)?\s+de|review\s+by)\s+(.+?)(:|\s+\d\s)/i);
                        const ratingMatch = aria.match(/(\d(?:[.,]\d)?)\s*(?:estrela|star)/i) || text.match(/(\d(?:[.,]\d)?)\s*(?:estrela|star)/i);
                        const dateMatch = text.match(/(há\s+\d+\s+\w+|\d+\s+(?:dias?|semanas?|meses|anos?|day|week|month|year)s?\s+ago)/i);
                        const authorImage = element.querySelector('img[src*="googleusercontent"], img[src*="ggpht"]') as HTMLImageElement | null;
                        const fotoAutor = authorImage?.src.split("=")[0] || "";
                        const fotos = Array.from(element.querySelectorAll('img[src*="googleusercontent"], img[src*="ggpht"]'))
                          .map((image) => (image as HTMLImageElement).src.split("=")[0])
                          .filter((src) => src && src !== fotoAutor)
                          .filter((src, index, list) => list.indexOf(src) === index)
                          .slice(0, 8);
                        const ownerReply = Array.from(element.querySelectorAll('[jslog*="owner"], div[data-owner-response], [class*="owner"]'))
                          .map((reply) => (reply as HTMLElement).innerText.trim())
                          .find((reply) => reply.length > 0) || "";
                        const utilMatch = text.match(/(\d+)\s*(?:pessoas?|pessoa|users?|people)\s*(?:acharam|found|marked)\s*(?:útil|useful|helpful)/i);
                        cached[signature] = {
                          autor: authorMatch ? authorMatch[1].trim() : "",
                          nota: ratingMatch ? ratingMatch[1] : "",
                          data: dateMatch ? dateMatch[1] : "",
                          texto: text,
                          fotoAutor: fotoAutor || undefined,
                          fotos: fotos.length ? fotos : undefined,
                          respostaDono: ownerReply || undefined,
                          util: utilMatch ? parseInt(utilMatch[1]) : undefined,
                        };
                      }
                      const firstReview = document.querySelector(reviewSelector) as HTMLElement | null;
                      // Encontra o ancestral QUE ROLA DE VERDADE — confiar em
                      // seletor fixo ([role="feed"]/.m6QErb) falha quando o
                      // overflow está num pai: scrollBy não move nada, o feed
                      // não lazy-loada e a captura congela nas iniciais.
                      const scroller = (() => {
                        let el: HTMLElement | null = firstReview?.closest('[role="feed"]') || firstReview;
                        while (el && el !== document.body) {
                          if (el.scrollHeight > el.clientHeight + 50) return el;
                          el = el.parentElement;
                        }
                        return (document.scrollingElement as HTMLElement) || document.body;
                      })();
                      const before = scroller?.scrollTop || 0;
                      if (scroller) scroller.scrollBy(0, Math.max(1200, scroller.clientHeight * 0.85));
                      if (aggressive) {
                        // Fallbacks: ancestral com overflow não encontrado ou
                        // trocado pelo Google → rola a janela e simula wheel
                        // no feed (dispara o lazy-load por outros caminhos).
                        window.scrollBy(0, 800);
                        const feedEl = document.querySelector('[role="feed"], div.m6QErb') as HTMLElement | null;
                        feedEl?.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 1500 }));
                      }
                      return { before, cachedCount: Object.keys(cached).length };
                    }, scrollAggressivo);
                    await sleep(900);
                    const progresso = await detailsPage.evaluate((before: number) => {
                      const firstReview = document.querySelector('.jftiEf, div[role="article"][aria-label], div[data-review-id], div[jslog*="review"]') as HTMLElement | null;
                      const scroller = (() => {
                        let el: HTMLElement | null = firstReview?.closest('[role="feed"]') || firstReview;
                        while (el && el !== document.body) {
                          if (el.scrollHeight > el.clientHeight + 50) return el;
                          el = el.parentElement;
                        }
                        return (document.scrollingElement as HTMLElement) || document.body;
                      })();
                      return { moved: !!scroller && scroller.scrollTop > before, cachedCount: Object.keys((window as any).__painelSdrReviews || {}).length };
                    }, novos.before);
                    if (progresso.cachedCount === cachedCountAnterior) {
                      semNovidade++;
                      if (semNovidade >= PACIENCIA) break;
                    } else {
                      semNovidade = 0;
                    }
                    // Escala a rolagem quando o container está travado.
                    semMovimento = progresso.moved ? 0 : semMovimento + 1;
                    scrollAggressivo = semMovimento >= 2;
                    cachedCountAnterior = progresso.cachedCount;
                  }
                  const reviewExtracted = await detailsPage.evaluate((limit: number) => {
                    const reviewSelector = '.jftiEf, div[role="article"][aria-label], div[data-review-id], div[jslog*="review"]';
                    const reviewEls = Array.from(document.querySelectorAll(reviewSelector));
                    const cached = (window as any).__painelSdrReviews || {};
                    const out: any[] = Object.values(cached);
                    const seen = new Set(out.map((review: any) => review.texto.slice(0, 80)));
                    for (const r of reviewEls) {
                      const aria = r.getAttribute("aria-label") || "";
                      const authorMatch = aria.match(/(?:avaliaç(?:ão)?\s+de|review\s+by)\s+(.+?)(?::|\s+\d\s)/i);
                      const author = authorMatch ? authorMatch[1].trim() : "";
                      const ratingMatch = aria.match(/(\d(?:[.,]\d)?)\s*(?:estrela|star)/i);
                      const rating = ratingMatch ? ratingMatch[1] : "";
                      const text = ((r as HTMLElement).innerText || "").slice(0, 12000).trim();
                      const sig = text.slice(0, 80);
                      if (!text || seen.has(sig)) continue;
                      seen.add(sig);
                      const dateMatch = text.match(/(há\s+\d+\s+\w+|\d+\s+(?:dias?|semanas?|meses|anos?|day|week|month|year)s?\s+ago)/i);
                      // Foto do reviewer (avatar)
                      const authorImg = r.querySelector('img[src*="googleusercontent"], img[src*="ggpht"]') as HTMLImageElement;
                      const fotoAutor = authorImg ? (authorImg.src.split("=")[0]) : "";
                      // Fotos anexadas à review (não contar o avatar)
                      const fotos: string[] = [];
                      const reviewImgs = Array.from(r.querySelectorAll('img[src*="googleusercontent"], img[src*="ggpht"]'));
                      for (const img of reviewImgs) {
                        const src = (img as HTMLImageElement).src.split("=")[0];
                        if (src && src !== fotoAutor && !fotos.includes(src) && fotos.length < 8) fotos.push(src);
                      }
                      // Resposta do dono
                      let respostaDono = "";
                      const ownerReplyEl = r.querySelector('[jslog*="owner"], div[data-owner-response], [class*="owner"]');
                      if (ownerReplyEl) respostaDono = ((ownerReplyEl as HTMLElement).innerText || "").slice(0, 1500).trim();
                      // Contador "útil"
                      let util = 0;
                      const utilMatch = text.match(/(\d+)\s*(?:pessoas?|pessoa|users?|people)\s*(?:acharam|found|marked)\s*(?:útil|useful|helpful)/i);
                      if (utilMatch) util = parseInt(utilMatch[1]);
                      out.push({
                        autor: author,
                        nota: rating,
                        data: dateMatch ? dateMatch[1] : "",
                        texto: text,
                        fotoAutor: fotoAutor || undefined,
                        fotos: fotos.length ? fotos : undefined,
                        respostaDono: respostaDono || undefined,
                        util: util || undefined,
                      });
                      if (out.length >= limit) break;
                    }
                    return out;
                  }, reviewLimit);
                  if (Array.isArray(reviewExtracted) && reviewExtracted.length > 0) {
                    // merge (dedupe por sig 80 chars)
                    const merged = new Map<string, any>();
                    for (const rv of [...reviewsDetalhes, ...reviewExtracted]) {
                      const sig = (rv.texto || rv.text || "").slice(0, 80);
                      merged.set(sig, rv);
                    }
                    reviewsDetalhes = Array.from(merged.values()).slice(0, reviewLimit);
                    if (settings.captureAllReviews) {
                      // Cobertura: parseia o total declarado pelo Google
                      // ("1.234", "2,5k") e mostra capturadas vs esperadas —
                      // se ficar muito abaixo, dá pra ver NO LOG que a
                      // rolagem parou cedo.
                      const expected = parseGoogleReviewCount(cardData.reviewCount) || 0;
                      sendRunLog(run,
                        `📝 ${reviewsDetalhes.length} avaliações capturadas${expected > 0 ? ` (de ~${expected} no Google)` : ""}: ${cardData.name}`,
                        "success",
                      );
                    }
                  }
                } catch (error) {
                  if (/target closed|session closed|protocol error|connection closed|browser.*disconnect|execution context.*destroyed/i.test((error as Error).message)) throw error;
                  // Falha só nas reviews mantém os dados válidos do painel principal.
                }
              }
            }
          } catch (error) {
            // Não persistir um painel incompleto nem consumir definitivamente o candidato.
            transientDetailError = true;
            processedPlaceKeys.delete(placeKey);
            if (!run.keepRunning || !isCurrentRun()) break;
            throw error;
          } finally {
            if (detailsPage) await detailsPage.close().catch(() => {});
          }

          const cleanPhone = phoneStr.replace(/\D/g, "");
          // Mesma avaliação do ponto antecipado (defesa: cobre o caso em que
          // a página de detalhe nem abriu). Se já foi descartado antes, o log
          // já saiu — não repete.
          const finalCheck = discardedByFilters
            ? { pass: false, reason: discardedByFilters }
            : evaluateLeadFilters(cleanPhone, websiteStr, settings, leadsStore, cardData.reviewCount, instagramStr);

          if (finalCheck.pass) {
            const jid = formatJid(phoneStr);
            // Filtro CRM: se o JID já está no leads_extraidos OU contacts, pula
            // SEM contar pro maxLeads, sem broadcast, sem salvar duplicata.
            const dupSource = await checkCrmDuplicate(jid, currentClientId, { phones: phoneStr, mapsUrl: mapsUrl || lead.url, placeId });
            if (dupSource) {
              crmSkipped++;
              sendRunLog(run, `⏭️ Já no CRM (${dupSource}): ${cardData.name}`, "info");
            } else {
              // ---- Fallback final de rating: se nem card nem painel detalhe
              // devolveram nota (raro, mas acontece em variantes de DOM),
              // deriva média ponderada da distribuicaoEstrelas ou média
              // simples das notas individuais em reviewsDetalhes.
              // Praticamente todo negócio no Maps tem ao menos uma nota
              // alcançável por algum desses caminhos.
              // -----------------------------------------------------------
              if (!cardData.averageRating) {
                if (distribuicaoEstrelas && Object.keys(distribuicaoEstrelas).length > 0) {
                  let total = 0, sum = 0;
                  for (const [k, v] of Object.entries(distribuicaoEstrelas)) {
                    const star = parseInt(k) || 0;
                    if (star > 0 && v > 0) { total += v; sum += star * v; }
                  }
                  if (total > 0) cardData.averageRating = (sum / total).toFixed(1);
                } else if (reviewsDetalhes.length > 0) {
                  const rates = reviewsDetalhes
                    .map((r: any) => parseFloat(String(r?.rating || "").replace(",", ".")))
                    .filter((n: number) => !isNaN(n) && n > 0);
                  if (rates.length > 0) cardData.averageRating = (rates.reduce((a: number, b: number) => a + b, 0) / rates.length).toFixed(1);
                }
              }
              const finalLead: Lead = {
                name: cardData.name,
                fullAddress: cardData.fullAddress,
                categories: cardData.categories,
                // tira rótulo "Telefone:"/"Phone:" que o aria-label carrega —
                // coluna telefone salva só o número pro CRM
                phones: phoneStr.replace(/^\s*(?:Telefone|Phone|Tel\.?)\s*:?\s*/i, ""),
                averageRating: cardData.averageRating,
                reviewCount: cardData.reviewCount,
                website: websiteStr,
                instagram: instagramStr,
                facebook: facebookStr,
                remoteJid: jid,
                extractedAt: new Date().toLocaleString("pt-BR"),
                reviewsDetalhes: reviewsDetalhes.length > 0 ? reviewsDetalhes : undefined,
                businessDetails: businessDetails || undefined,
                openingHours: openingHours || undefined,
                attributes: attributes.length > 0 ? attributes : undefined,
                priceRange: priceRange || undefined,
                openNow: openNow || undefined,
                photos: photos.length > 0 ? photos : undefined,
                mapsUrl: mapsUrl || lead.url,
                plusCode: plusCode || undefined,
                lat: lat || undefined,
                lng: lng || undefined,
                placeId: placeId || undefined,
                distribuicaoEstrelas: distribuicaoEstrelas,
                cep: cep || undefined,
                // ---- Campos extras (2026-07-22) — captura estendida ----
                businessStatus: businessStatus || undefined,
                claimed: claimed || undefined,
                ownerName: ownerName || undefined,
                yearEstablished: yearEstablished || undefined,
                totalPhotoCount: totalPhotoCount ?? undefined,
                reviewTopics,
                featuredReviews,
                additionalCategories,
                addressComponents,
              };
              if (!isCurrentRun() || !run.keepRunning) break;
              const savedLeadId = await saveLeadAndSync(finalLead, settings, run);
              if (!savedLeadId || !isCurrentRun() || !run.keepRunning) continue;
              leadsStore.push(finalLead);
              broadcastToClient(run.clientId, { event: "new_lead", lead: finalLead, count: run.automationId ? run.captureCount : leadsStore.length });
              await markCandidateSeen();

              // Resumo automático de avaliações com IA — roda NA HORA em cada
              // lead salvo (fluxo Busca com "Resumir avaliações com IA" ligado).
              // Best-effort: falha não interrompe a captura.
              if (savedLeadId && settings.reviews_ai?.enabled && settings.reviews_ai.model) {
                sendRunLog(run, `🧠 Resumindo avaliações de "${finalLead.name}" com IA (${settings.reviews_ai.model})...`, "info");
                try {
                  const r = await summarizeReviewsForLead({
                    leadId: savedLeadId,
                    model: settings.reviews_ai.model,
                    customPrompt: settings.reviews_ai.prompt || null,
                    clientId: run.clientId,
                    source: "capture",
                  });
                  if ("error" in r) {
                    sendRunLog(run, `⚠️ Reviews-IA "${finalLead.name}": ${r.error}`, "warning");
                  } else {
                    sendRunLog(run, `🧠 Resumo de avaliações ${r.cached ? "(cache) " : ""}salvo: ${finalLead.name}`, "success");
                  }
                } catch (e: any) {
                  sendRunLog(run, `⚠️ Reviews-IA falhou (${finalLead.name}): ${e?.message || e}`, "warning");
                }
              }

              // Bateu o limite? Para tudo agora — sai do scroll, sai da fila.
              if (reachedLimit()) {
                sendRunLog(run, `🎯 Limite de ${maxLeads} leads atingido. Encerrando.`, "success");
                scrolling = false;
                break outer;
              }
            }
          } else if (!discardedByFilters) {
            sendRunLog(run, `🚫 Descartado (${finalCheck.reason}): ${lead.name}`, "warning");
          }
          await markCandidateSeen();
        }

        if (hasFeed) {
          const isEnd = await page.evaluate(() => {
            const feed = document.querySelector('[role="feed"]');
            if (!feed) return false;
            return feed.textContent?.includes("Você chegou ao final") || feed.textContent?.includes("final da lista") || false;
          });
          if (isEnd) {
            explicitlyExhausted = true;
            scrolling = false;
            sendRunLog(run, `Fim dos resultados para "${searchTerm}". Total: ${extractedPlaces.size}`, "info");
          } else {
            const madeProgress = extractedPlaces.size > previousExtractedSize || newLeads.length > previousCardsInDom;
            emptyScrolls = madeProgress ? 0 : emptyScrolls + 1;
            previousCardsInDom = newLeads.length;
            if (emptyScrolls >= 10) throw new Error(`Resultados sem progresso para "${searchTerm}"; retomar após espera.`);
          }
        }
      }

      if (explicitlyExhausted && run.keepRunning && isCurrentRun() && !transientDetailError && !run.checkpointFailed) {
        if (!await checkpointCapture(run)) break;
        await markSearchExhausted(run.clientId, search.niche, search.proximity ? `perto de ${search.region}` : search.region, effectiveFilters, "exhausted");
        exhaustedSearches.add(searchKey);
      }
      }

      // ─── PONTO DE EXPANSÃO ───
      // Roda SÓ na última busca da fila: se ainda falta lead pro limite e
      // há orçamento nesta tentativa, enfileira o nicho nas cidades vizinhas reais.
      // Camadas (em ordem):
      //  1) Região metropolitana oficial (dictionary) quando conhecida;
      //  2) Cidades vizinhas colhidas dos endereços reais (painel de detalhes
      //     do Google — universal, qualquer cidade do Brasil);
      //  3) Fallback universal: busca de proximidade ("{nicho} perto de
      //     {região}") alimenta a camada 2, então expande em seguida.
      if (
        i === queue.length - 1 &&
        settings.mode === "batch" &&
        maxLeads > 0 &&
        leadsStore.length < maxLeads &&
        run.keepRunning &&
        queriesExecuted < queryBudget
      ) {
        const additions: { niche: string; region: string }[] = [];
        for (const niche of niches.map(value => value.trim())) {
          const searchedRegions = searchedByNiche.get(niche)!;
          // Sempre usa a origem, nunca a última cidade expandida (evita deriva geográfica).
          for (let scanned = 0; scanned < 6000; scanned += 5) {
            const candidates = computeExpansionCandidates({ regions, cityCounts, alreadySearched: searchedRegions, limit: 5 });
            if (!candidates.length) break;
            let added = false;
            for (const region of candidates) {
              searchedRegions.add(norm(region));
              if (exhaustedSearches.has(makeSearchKey(niche, region, effectiveFilters))) continue;
              additions.push({ niche, region });
              added = true;
            }
            if (added) break;
          }
        }
        if (additions.length > 0) {
          queue.push(...additions);
          sendRunLog(run, `🧭 ${leadsStore.length}/${maxLeads} leads — expandindo nas proximidades: ${[...new Set(additions.map(item => item.region))].join(", ")}.`, "info");
        } else {
          // Sem candidato conhecido — semeia UMA busca de proximidade por região,
          // cujos resultados (endereços reais do painel de detalhes) colhem as
          // cidades vizinhas pra expansão na próxima passada. Universal: cobre
          // até cidades minúsculas não mapeadas.
          const toSeed = regions.filter(r => !proximitySeededRegions.has(norm(r)));
          if (toSeed.length > 0) {
            for (const r of toSeed) proximitySeededRegions.add(norm(r));
            for (const n of niches) {
              for (const r of toSeed) if (!exhaustedSearches.has(makeSearchKey(n.trim(), `perto de ${r}`, effectiveFilters))) queue.push({ niche: n.trim(), region: r, proximity: true });
            }
            sendRunLog(run,
              `🧭 ${leadsStore.length}/${maxLeads} leads e fila esgotada — buscando nas cercanias de ${toSeed.join(", ")} pra descobrir cidades vizinhas.`,
              "info"
            );
            // Semeadura também consome o orçamento de consultas desta tentativa.
          } else {
            sendRunLog(run, `🧭 Fila esgotada: ${leadsStore.length}/${maxLeads} leads e nenhuma cidade vizinha nova pra expandir. Encerrando.`, "info");
          }
        }
      }
    }

    if (isCurrentRun()) sendRunLog(run, `Fila processada. Total confirmado nesta tentativa: ${leadsStore.length} leads`, "info");

    // Webhook só do run manual atual que terminou sem stop/erro. Automação dispara pelo worker.
    if (!run.automationId && run.keepRunning && settings.webhookEnabled && settings.mode === "batch" && settings.webhookUrl && leadsStore.length > 0 && isCurrentRun()) {
      sendRunLog(run, "Enviando em massa para n8n...", "info");
      try {
        const payload = leadsStore.map((lead) => formatLeadForN8n(lead, { niche: run.niche, region: run.region }));
        await fetchPublicHttpUrl(settings.webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        sendRunLog(run, `[Webhook] ${payload.length} leads enviados em massa!`, "success");
      } catch (err) {
        sendRunLog(run, `[Webhook] Falha no envio em massa: ${(err as Error).message}`, "error");
      }
    }
  } catch (err) {
    scraperError = (err as Error).message || String(err);
    sendRunLog(run, `❌ Erro no scraper: ${scraperError}`, "error");
  } finally {
    run.isStopping = true;
    if (heartbeat) clearInterval(heartbeat);
    if (heartbeatPending) await heartbeatPending;
    if (browser) await browser.close().catch(() => {});
    // Run SUBSTITUÍDO por forceRestart: só fecha o próprio browser e sai.
    // Resetar isScraping/marcar automação em erro aqui matava o run novo
    // (bug: restart deixava o run antigo "concluir" com 0 leads por cima
    // do run recém-nascido).
    if (!isCurrentRun()) {
      sendRunLog(run, `♻️ Run substituído por um restart — ignorando conclusão deste run.`, "info");
      return;
    }
    if (run.automationId && run.captureAttemptId) {
      try {
        await updateAutomationCapture(run.clientId, run.automationId, current => {
          if (!isCurrentRun() || !captureMatches(run, current)) return null;
          const now = Date.now();
          const total = run.checkpointFailed ? Math.max(0, Number(current.scraped_count) || 0) : captureCount(current);
          const goal = Number(current.scrape_max_leads) || 0;
          const reached = run.keepRunning && !scraperError && !run.checkpointFailed && !transientDetailError && goal > 0 && total >= goal;
          const outcome = scraperError || transientDetailError ? "error" : !run.keepRunning ? "stopped" : reached ? "goal_reached" : "exhausted";
          const failures = reached ? 0 : (Number(current.scrape_filters._captureFailures) || 0) + 1;
          const retryAt = new Date(now + Math.min(15 * 60_000, 30_000 * 2 ** Math.min(failures - 1, 5))).toISOString();
          return {
            scraped_count: total,
            ...(scraperError ? { last_error: `Scraper falhou: ${scraperError}`.slice(0, 500), last_error_at: new Date(now).toISOString() } : {}),
            scrape_filters: { ...current.scrape_filters, _captureAttemptId: null, _captureLeaseUntil: null,
              _captureFinishedAt: new Date(now).toISOString(), _captureLastOutcome: outcome,
              _captureFailures: failures, _captureRetryAt: reached || outcome === "stopped" ? null : retryAt,
              _scrapeFinishedAt: reached ? new Date(now).toISOString() : null },
          };
        });
      } catch (error) {
        // Não sinaliza sucesso: lease expira e worker reconcilia os marcadores de INSERT.
        console.warn("[SCRAPER-ENGINE] falha finalizando checkpoint:", (error as Error).message);
      }
    }
    run.isScraping = false;
    run.isStopping = false;
    run.isPaused = false;
    if (isCurrentRun()) activeRun = null;
    if (!run.automationId) {
      broadcastToClient(run.clientId, { event: "status", isScraping: false, isPaused: false, leadCount: leadsStore.length });
    }
    sendRunLog(run, `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, "info");
    const completed = !scraperError && run.keepRunning && (!run.automationId || run.captureGoal > 0 && run.captureCount >= run.captureGoal);
    sendRunLog(run, completed ? "🏁 Captação concluída" : "Captação encerrada sem concluir a meta; progresso preservado.", completed ? "success" : "warning");
    sendRunLog(run, `   ${leadsStore.length} lead(s) novo(s) confirmado(s)`, leadsStore.length > 0 ? "success" : "info");
    if (crmSkipped > 0) sendRunLog(run, `   ⏭️ ${crmSkipped} lead(s) pulado(s) (já no CRM)`, "info");
    sendRunLog(run, `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`, "info");

    // O scheduler decide retry/disparo usando o checkpoint persistido; o engine não dispara mensagens.
  }
}

// ===========================================================================
// PUBLIC API — chamada por route.ts (HTTP) e automation-worker (in-process)
// ===========================================================================

export interface StartOpts {
  niches: string[];
  regions: string[];
  webhookUrl?: string;
  webhookEnabled?: boolean;
  mode?: string;
  filterEmpty?: boolean;
  filterDuplicates?: boolean;
  filterLandlines?: boolean;
  filterWithWebsite?: boolean;
  /** Exige link de perfil do Instagram identificado no painel do negócio. */
  filterWithInstagram?: boolean;
  /** Total mínimo de pessoas que avaliaram, independente da nota/comentários. 0 desativa. */
  minReviews?: number;
  captureAllReviews?: boolean;
  /** Limite de leads — quando atingido o scraper sai limpo. */
  maxLeads?: number;
  automation_id?: string | null;
  /** Token persistido pelo worker antes de iniciar esta tentativa. */
  captureAttemptId?: string;
  client_id?: string | null;
  reviews_ai?: { enabled?: boolean; model?: string; prompt?: string | null };
  /** Run de reposição de leads inválidos, com o mesmo token e checkpoint protegido. */
  topup?: boolean;
  /** Se true, reseta qualquer captura travada anterior e força o início limpo. */
  forceRestart?: boolean;
}

/**
 * Inicia o scraper. Retorna { ok: true } imediato; o scraping roda em
 * background. Run existente do mesmo dono retorna alreadyRunning sem permitir
 * que outro cliente ou automação assuma a captura.
 */
export function startScraperRun(opts: StartOpts): { ok: boolean; error?: string; alreadyRunning?: boolean; busy?: boolean } {
  const clientId = normalizeClientId(opts.client_id);
  const automationId = opts.automation_id || null;
  if (!clientId) return { ok: false, error: "client_id é obrigatório." };
  if (!opts.niches?.length || !opts.regions?.length) {
    return { ok: false, error: "Forneça pelo menos 1 nicho e 1 região." };
  }
  const minReviews = parseMinReviews(opts.minReviews);
  if (minReviews === null) return { ok: false, error: "Mínimo de avaliações deve ser um inteiro entre 0 e 2147483647." };
  const booleanFilters = [
    ["filterEmpty", "Filtro de telefone"], ["filterDuplicates", "Filtro de duplicatas"],
    ["filterLandlines", "Filtro de telefone fixo"], ["filterWithWebsite", "Filtro de site"],
    ["filterWithInstagram", "Somente com Instagram"],
  ] as const;
  for (const [key, label] of booleanFilters) {
    if (opts[key] !== undefined && typeof opts[key] !== "boolean") return { ok: false, error: `${label} deve ser um booleano.` };
  }
  if (activeRun) {
    if (!hasRunAccess(clientId, automationId)) {
      return { ok: false, busy: true, error: "O extrator está ocupado por outra captura." };
    }
    if (activeRun.isStopping) {
      return { ok: false, busy: true, error: "O extrator ainda está encerrando a captura anterior." };
    }
    if (!opts.forceRestart) return { ok: true, alreadyRunning: true };
    if (automationId && activeRun.captureAttemptId === opts.captureAttemptId) {
      return { ok: false, busy: true, error: "Reinício exige uma nova tentativa persistida pelo worker." };
    }
    activeRun.keepRunning = false;
    activeRun.isScraping = false;
    activeRun.isStopping = false;
    activeRun.isPaused = false;
  }

  const generation = ++runGeneration;
  const leads: Lead[] = [];
  const run: RunContext = {
    generation,
    clientId,
    automationId,
    captureAttemptId: opts.captureAttemptId || null,
    captureSessionId: null,
    captureCount: 0,
    captureGoal: 0,
    checkpointFailed: false,
    searchCursor: null,
    isScraping: true,
    isStopping: false,
    isPaused: false,
    keepRunning: true,
    leads,
    niche: opts.niches[0],
    region: opts.regions[0],
  };
  activeRun = run;
  leadsByOwner.set(ownerKey(clientId, automationId), leads);
  searchByOwner.set(ownerKey(clientId, automationId), { niche: run.niche, region: run.region });
  void runScraper(opts.niches, opts.regions, {
    webhookUrl: opts.webhookUrl,
    webhookEnabled: opts.webhookEnabled,
    mode: opts.mode,
    filterEmpty: opts.filterEmpty === true,
    filterDuplicates: automationId ? true : opts.filterDuplicates === true,
    filterLandlines: opts.filterLandlines === true,
    filterWithWebsite: opts.filterWithWebsite === true,
    filterWithInstagram: opts.filterWithInstagram === true,
    minReviews,
    captureAllReviews: opts.captureAllReviews,
    maxLeads: opts.maxLeads,
    reviews_ai: opts.reviews_ai,
    topup: opts.topup,
  }, run);
  return { ok: true };
}

export function stopScraper(clientId: string | null, automationId: string | null = null): boolean {
  if (!hasRunAccess(clientId, automationId) || !activeRun) return false;
  const run = activeRun;
  run.keepRunning = false;
  run.isScraping = false;
  run.isStopping = true;
  run.isPaused = false;
  sendRunLog(run, "Parando robô...", "warning");
  return true;
}

export function pauseScraper(clientId: string | null, automationId: string | null = null): boolean {
  if (!hasRunAccess(clientId, automationId) || !activeRun?.isScraping || activeRun.isStopping) return false;
  activeRun.isPaused = true;
  sendRunLog(activeRun, "Extração pausada.", "warning");
  broadcastToClient(activeRun.clientId, { event: "status", isScraping: true, isPaused: true, leadCount: activeRun.leads.length });
  return true;
}

export function resumeScraper(clientId: string | null, automationId: string | null = null): boolean {
  if (!hasRunAccess(clientId, automationId) || !activeRun?.isScraping || !activeRun.isPaused || activeRun.isStopping) return false;
  activeRun.isPaused = false;
  sendRunLog(activeRun, "Extração retomada.", "info");
  broadcastToClient(activeRun.clientId, { event: "status", isScraping: true, isPaused: false, leadCount: activeRun.leads.length });
  return true;
}

export function clearLeads(clientId: string | null, automationId: string | null = null): boolean {
  const normalized = normalizeClientId(clientId);
  if (!normalized) return false;
  if (activeRun?.clientId === normalized && activeRun.automationId !== automationId) return false;
  const leads = leadsByOwner.get(ownerKey(normalized, automationId)) || [];
  leads.length = 0;
  leadsByOwner.set(ownerKey(normalized, automationId), leads);
  broadcastToClient(normalized, { event: "leads_update", leads: [], count: 0 });
  return true;
}

export function getLeads(clientId: string | null, automationId: string | null = null): { leads: Lead[]; count: number } {
  const normalized = normalizeClientId(clientId);
  if (!normalized) return { leads: [], count: 0 };
  if (activeRun?.clientId === normalized && activeRun.automationId !== automationId) return { leads: [], count: 0 };
  const leads = leadsByOwner.get(ownerKey(normalized, automationId)) || [];
  return { leads, count: leads.length };
}

export function getStatus(clientId: string | null, automationId: string | null = null): { isScraping: boolean; isPaused: boolean; leadCount: number; automationId?: string | null } {
  const normalized = normalizeClientId(clientId);
  if (!normalized) return { isScraping: false, isPaused: false, leadCount: 0 };
  const leads = leadsByOwner.get(ownerKey(normalized, automationId)) || [];
  if (!hasRunAccess(normalized, automationId) || !activeRun) return { isScraping: false, isPaused: false, leadCount: leads.length };
  return { isScraping: activeRun.isScraping || activeRun.isStopping, isPaused: activeRun.isPaused, leadCount: leads.length, automationId: activeRun.automationId };
}

export async function sendLeadsBatch(webhookUrl: string, clientId: string | null, automationId: string | null = null) {
  const normalized = normalizeClientId(clientId);
  if (!normalized) return { ok: false, error: "Extrator indisponível." };
  if (activeRun?.clientId === normalized && activeRun.automationId !== automationId) return { ok: false, error: "Extrator indisponível." };
  const key = ownerKey(normalized, automationId);
  const leads = [...(leadsByOwner.get(key) || [])];
  if (!webhookUrl || leads.length === 0) return { ok: false, error: "Sem leads ou URL" };
  const search = searchByOwner.get(key);
  try {
    const payload = leads.map((lead) => formatLeadForN8n(lead, search));
    const res = await fetchPublicHttpUrl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return { ok: true, count: payload.length };
    return { ok: false, error: `Erro: ${res.status}` };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
