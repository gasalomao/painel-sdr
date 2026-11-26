/**
 * scraper-lead-enrichment — auditoria gratuita de saúde do site, descoberta
 * de CNPJ (HTML + RDAP Registro.br + Web Search), consulta gratuita em cascata
 * à Receita Federal (BrasilAPI → OpenCNPJ → MinhaReceita) e resolução de
 * WhatsApp do sócio decisor sem custo de API externa.
 */

import {
  cleanShortCompanyName,
  isPlausibleHumanPersonName,
  NON_PERSON_NOISE_TOKENS,
  sanitizeHumanPersonName,
} from "@/lib/lead-name-hygiene";
import { isPrivateOrLocalUrl } from "@/lib/url-guard";
import { webSearch, type SearchResult } from "@/lib/web-search";
import {
  SOCIAL_ONLY_HOSTS,
  IMPROVISED_HOSTS,
  classifyNonOwnWebsiteUrl,
  matchesDomainList,
  type QualificationObjective,
  type SiteFilterMode,
  type SiteHealthStatus,
} from "@/lib/scraper-filter-sync";
import {
  expandBrPhoneCheckVariants,
  formatCnpj,
  isAnatel8DigitMobile,
  isBrMobileDigits,
  isEffectiveBrMobile,
  isValidBusinessEmail,
  isValidCnpj,
  normalizeBrPhoneDigits,
  toModern13DigitBrMobile,
} from "@/lib/br-crm-utils";

export {
  expandBrPhoneCheckVariants,
  formatCnpj,
  isAnatel8DigitMobile,
  isBrMobileDigits,
  isEffectiveBrMobile,
  isValidBusinessEmail,
  isValidCnpj,
  normalizeBrPhoneDigits,
  toModern13DigitBrMobile,
  type QualificationObjective,
  type SiteFilterMode,
  type SiteHealthStatus,
};

export interface SiteAuditResult {
  status: SiteHealthStatus;
  issueCode?: string;
  statusLabel: string;
  diagnosticoComercial: string;
  auditUncertain?: boolean;
  httpStatus?: number;
  finalUrl?: string;
  responseTimeMs?: number;
  extractedWhatsApps: string[];
  extractedCnpjs: string[];
  extractedEmails?: string[];
  extractedInstagram?: string;
  hasPaidTrafficTag?: boolean;
  trafficTags?: string[];
  discoveredRealWebsite?: string;
  managementTools?: string[];
  abandonedCopyrightYear?: number;
  siteQualityScore?: number;
  siteWeaknesses?: string[];
  siteStrengths?: string[];
  hasMobileViewport?: boolean;
  hasSsl?: boolean;
  hasClearCta?: boolean;
}

export interface CnpjPartner {
  nome: string;
  qualificacao: string;
  faixaEtaria?: string;
}

export type CnpjSource = "site_html" | "rdap_br" | "web_search";

export interface CnpjEnrichmentResult {
  cnpj: string;
  razaoSocial: string;
  nomeFantasia?: string;
  situacaoCadastral: string;
  isAtiva: boolean;
  isMei: boolean;
  porte: string;
  capitalSocial: number;
  dataInicioAtividade?: string;
  anosEmpresa?: number;
  municipio?: string;
  uf?: string;
  cep?: string;
  email?: string;
  cnaeDescricao?: string;
  telefonesReceita: string[];
  socioDecisor?: string;
  primeiroNomeSocio?: string;
  faixaEtariaSocio?: string;
  socios: CnpjPartner[];
  source: CnpjSource;
  rdapFrozen?: boolean;
}

export type WhatsAppSource =
  | "google_maps"
  | "website_wame"
  | "cnpj_socio"
  | "socio_web"
  | "instagram_bio";

export type WhatsAppChannelType =
  | "socio_direto"
  | "provavel_socio"
  | "recepcao_comercial"
  | "indefinido";

export interface LeadEnrichmentData {
  siteHealth: SiteHealthStatus;
  siteStatusLabel: string;
  siteIssueCode?: string;
  siteDiagnostico?: string;
  auditUncertain?: boolean;
  siteHttpStatus?: number;
  cnpj?: string;
  razaoSocial?: string;
  situacaoCadastral?: string;
  porte?: string;
  isMei?: boolean;
  capitalSocial?: number;
  dataInicioAtividade?: string;
  anosEmpresa?: number;
  socioDecisor?: string;
  primeiroNomeSocio?: string;
  faixaEtariaSocio?: string;
  socios?: CnpjPartner[];
  cnaeDescricao?: string;
  emailValidado?: string;
  emailSource?: "site_html" | "cnpj_receita";
  telefoneSocio?: string;
  telefoneMapsOriginal?: string;
  telefoneRecepcao?: string;
  telefonesAlternativos?: Array<{ telefone: string; label: string }>;
  whatsappSource?: WhatsAppSource;
  whatsappVerified?: boolean;
  whatsappChannelType?: WhatsAppChannelType;
  hasReceptionist?: boolean;
  ownerActiveOnMaps?: boolean;
  hasPaidTrafficTag?: boolean;
  trafficTags?: string[];
  discoveredRealWebsite?: string;
  managementTools?: string[];
  abandonedCopyrightYear?: number;
  isFranchise?: boolean;
  empresaCurta?: string;
  servicoPrincipal?: string;
  recommendedApproach?: string;
  siteQualityScore?: number;
  siteWeaknesses?: string[];
  qualificationObjective?: QualificationObjective;
  qualificationScore: number;
  qualificationReasons: string[];
  enrichedAt: string;
}

export type FetchLike = typeof fetch;
export type SearchLike = (query: string, maxResults?: number) => Promise<SearchResult[]>;
export type WhatsAppCheckFn = (
  numbers: string[],
) => Promise<Record<string, { exists: boolean; jid: string | null }>>;
export type BusinessProfileCheckFn = (
  phoneOrJid: string,
) => Promise<{ isBusiness: boolean; description?: string } | null>;

export interface EnrichLeadInput {
  tenantId?: string;
  name: string;
  phone: string;
  mapsWhatsAppUrl?: string;
  website?: string;
  instagram?: string;
  categories?: string;
  fullAddress?: string;
  cep?: string;
  cidade?: string;
  uf?: string;
  averageRating?: string;
  reviewCount?: string;
  claimed?: boolean;
  ownerName?: string;
  services?: ReadonlyArray<string>;
  reviews?: ReadonlyArray<{ texto?: string; respostaDono?: string }>;
  precomputedSiteAudit?: SiteAuditResult;
  options: {
    auditSiteHealth: boolean;
    enrichCnpj: boolean;
    prioritizePartnerPhone: boolean;
    validateWhatsApp: boolean;
    huntPartnerDirectPhone?: boolean;
    qualificationObjective?: QualificationObjective;
  };
  fetchImpl?: FetchLike;
  searchFn?: SearchLike;
  checkWhatsAppFn?: WhatsAppCheckFn;
  checkBusinessProfileFn?: BusinessProfileCheckFn;
}

export interface EnrichLeadOutput {
  enrichment: LeadEnrichmentData;
  siteAudit: SiteAuditResult;
  cnpjResult: CnpjEnrichmentResult | null;
  bestPhone: string;
  bestRemoteJid: string;
  usedLandlineWithWhatsApp: boolean;
  noActiveWhatsApp: boolean;
  partnerWhatsAppFound: string;
}

const MAX_CACHE_ENTRIES = 500;
const MAX_PHONE_ROOT_ENTRIES = 1000;
const MAX_SITE_HTML_BYTES = 256 * 1024;
const SITE_AUDIT_TIMEOUT_MS = 8500;
const RDAP_TIMEOUT_MS = 3500;
const CNPJ_TIMEOUT_MS = 4000;
const MAX_REDIRECTS = 4;

interface RdapCacheEntry {
  cnpj: string | null;
  frozen: boolean;
}

const GLOBAL_TENANT_SCOPE = "__global__";
const rdapDomainCache = new Map<string, RdapCacheEntry>();
const cnpjDataCache = new Map<string, CnpjEnrichmentResult | null>();
const tenantPhoneToCnpjRoots = new Map<string, Map<string, Set<string>>>();
const tenantEmailToCnpjRoots = new Map<string, Map<string, Set<string>>>();
const partnerPhoneSearchCache = new Map<string, string[]>();

function setLru<K, V>(map: Map<K, V>, key: K, val: V, max: number): void {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  if (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

export function clearEnrichmentCachesForTest(): void {
  rdapDomainCache.clear();
  cnpjDataCache.clear();
  tenantPhoneToCnpjRoots.clear();
  tenantEmailToCnpjRoots.clear();
  partnerPhoneSearchCache.clear();
}

function getTenantPhoneMap(tenantId?: string): Map<string, Set<string>> {
  const scope = String(tenantId || "").trim() || GLOBAL_TENANT_SCOPE;
  let phoneMap = tenantPhoneToCnpjRoots.get(scope);
  if (!phoneMap) {
    phoneMap = new Map<string, Set<string>>();
    tenantPhoneToCnpjRoots.set(scope, phoneMap);
  }
  return phoneMap;
}

function getTenantEmailMap(tenantId?: string): Map<string, Set<string>> {
  const scope = String(tenantId || "").trim() || GLOBAL_TENANT_SCOPE;
  let emailMap = tenantEmailToCnpjRoots.get(scope);
  if (!emailMap) {
    emailMap = new Map<string, Set<string>>();
    tenantEmailToCnpjRoots.set(scope, emailMap);
  }
  return emailMap;
}

function canonicalAccountingPhoneKey(digits: string): string {
  const clean = normalizeBrPhoneDigits(digits);
  if (!clean) return "";
  return toModern13DigitBrMobile(clean) || clean;
}

function recordPhoneCnpjRoot(digits: string, cnpj: string, tenantId = GLOBAL_TENANT_SCOPE): void {
  const cleanPhone = canonicalAccountingPhoneKey(digits);
  const root = String(cnpj || "").replace(/\D/g, "").slice(0, 8);
  if (!cleanPhone || root.length !== 8) return;
  const phoneMap = getTenantPhoneMap(tenantId);
  let roots = phoneMap.get(cleanPhone);
  if (!roots) {
    roots = new Set<string>();
    setLru(phoneMap, cleanPhone, roots, MAX_PHONE_ROOT_ENTRIES);
  }
  roots.add(root);
}

function recordEmailCnpjRoot(rawEmail: string, cnpj: string, tenantId = GLOBAL_TENANT_SCOPE): void {
  const email = String(rawEmail || "").trim().toLowerCase();
  const root = String(cnpj || "").replace(/\D/g, "").slice(0, 8);
  if (!email || !email.includes("@") || root.length !== 8) return;
  const emailMap = getTenantEmailMap(tenantId);
  let roots = emailMap.get(email);
  if (!roots) {
    roots = new Set<string>();
    setLru(emailMap, email, roots, MAX_PHONE_ROOT_ENTRIES);
  }
  roots.add(root);
}

/**
 * Semeia a memória anti-contador de um tenant com pares telefone/email + CNPJ já persistidos no CRM.
 */
export function seedTenantPhoneCnpjRoots(
  tenantId: string,
  entries: ReadonlyArray<{ phone?: string; email?: string; cnpj: string }>,
): void {
  const scope = String(tenantId || "").trim() || GLOBAL_TENANT_SCOPE;
  for (const entry of entries) {
    if (entry.phone && entry.cnpj) {
      recordPhoneCnpjRoot(entry.phone, entry.cnpj, scope);
    }
    if (entry.email && entry.cnpj) {
      recordEmailCnpjRoot(entry.email, entry.cnpj, scope);
    }
  }
}

export function isLikelyAccountingPhone(digits: string, tenantId = GLOBAL_TENANT_SCOPE): boolean {
  const cleanPhone = canonicalAccountingPhoneKey(digits);
  if (!cleanPhone) return false;
  const scope = String(tenantId || "").trim() || GLOBAL_TENANT_SCOPE;
  const scopedRoots = tenantPhoneToCnpjRoots.get(scope)?.get(cleanPhone);
  return !!scopedRoots && scopedRoots.size >= 2;
}

const ACCOUNTING_EMAIL_RE =
  /(?:contabil|contador|contabilidade|escritorio|assessoria|fiscal|tributar|bpo|legalizacao|aberturaempresa)/i;

export function isLikelyAccountingEmail(rawEmail: string, tenantId = GLOBAL_TENANT_SCOPE): boolean {
  const email = String(rawEmail || "").trim().toLowerCase();
  if (!isValidBusinessEmail(email)) return true;
  if (ACCOUNTING_EMAIL_RE.test(email)) return true;
  const scope = String(tenantId || "").trim() || GLOBAL_TENANT_SCOPE;
  const scopedRoots = tenantEmailToCnpjRoots.get(scope)?.get(email);
  return !!scopedRoots && scopedRoots.size >= 2;
}

/**
 * Extrai e-mails comerciais reais de páginas HTML (priorizando links mailto:).
 */
export function extractEmailsFromHtml(html: string): string[] {
  if (!html) return [];
  const found: string[] = [];
  const push = (raw: string) => {
    const clean = decodeURIComponent(raw || "")
      .replace(/^mailto:/i, "")
      .split("?")[0]
      .trim()
      .toLowerCase();
    if (isValidBusinessEmail(clean) && !ACCOUNTING_EMAIL_RE.test(clean) && !found.includes(clean)) {
      found.push(clean);
    }
  };

  const mailtoRe = /href\s*=\s*["']mailto:([^"'<>#\s]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = mailtoRe.exec(html)) !== null) {
    push(m[1] || "");
    if (found.length >= 3) return found;
  }

  const visibleText = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const emailRe = /\b([a-z0-9._%+-]{2,64}@[a-z0-9.-]+\.[a-z]{2,10})\b/gi;
  while ((m = emailRe.exec(visibleText)) !== null) {
    push(m[1] || "");
    if (found.length >= 3) break;
  }
  return found;
}

/**
 * Extrai CNPJs válidos de textos/HTML (formatado XX.XXX.XXX/XXXX-XX ou próximo a rótulo CNPJ).
 */
export function extractCnpjsFromText(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();

  const formattedRe = /\b(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})\b/g;
  let m: RegExpExecArray | null;
  while ((m = formattedRe.exec(text)) !== null) {
    const digits = m[1].replace(/\D/g, "");
    if (isValidCnpj(digits)) found.add(digits);
  }

  const labeledRe = /\bcnpj\s*[:\-#]?\s*(\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}|\d{14})\b/gi;
  while ((m = labeledRe.exec(text)) !== null) {
    const digits = m[1].replace(/\D/g, "");
    if (isValidCnpj(digits)) found.add(digits);
  }

  const rawUrlRe = /(?:^|\D)(\d{14})(?=\D|$)/g;
  if (/cnpj\.biz|casadosdados|econodata|consultacnpj|informecadastral|cadastroempresa|cnpj/i.test(text)) {
    while ((m = rawUrlRe.exec(text)) !== null) {
      if (isValidCnpj(m[1])) found.add(m[1]);
    }
  }

  return Array.from(found);
}

/**
 * Extrai telefones brasileiros de links WhatsApp (wa.me, api.whatsapp.com, whatsapp://send).
 */
export function extractWhatsAppPhonesFromHtml(html: string): string[] {
  if (!html) return [];
  const found = new Set<string>();
  const patterns = [
    /https?:\/\/(?:api\.|web\.)?whatsapp\.com\/send\/?\?[^"'\s<>]*?\bphone=([+\d%2B\-()\s]{8,24})/gi,
    /https?:\/\/wa\.me\/([+\d]{8,18})/gi,
    /whatsapp:\/\/send\?[^"'\s<>]*?\bphone=([+\d%2B\-()\s]{8,24})/gi,
  ];

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      const raw = decodeURIComponent(m[1] || "").replace(/\D/g, "");
      const normalized = normalizeBrPhoneDigits(raw);
      if (normalized) found.add(normalized);
    }
  }

  return Array.from(found);
}

const PT_BR_PREPOSITIONS = new Set(["da", "de", "do", "das", "dos", "e", "em"]);

export function toTitleCasePtBr(name: string): string {
  const cleaned = String(name || "")
    .replace(/^\s*(?:\d{2}\.?\d{3}\.?\d{3}\/?\d{0,4}-?\d{0,2}|\d{8,14})\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";

  return cleaned
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .map((word, idx) => {
      if (idx > 0 && PT_BR_PREPOSITIONS.has(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function isCorporateEntityPartner(name: string, qualificacao: string): boolean {
  const n = name.toUpperCase();
  const q = qualificacao.toUpperCase();
  if (/PESSOA JUR[IÍ]DICA|SOCIEDADE|FUNDO|HOLDING/.test(q)) return true;
  return /\b(LTDA|S\/A|S\.A\.|EIRELI|HOLDING|PARTICIPACOES|PARTICIPAÇÕES|MEI|INC|LLC)\b/.test(n);
}

export function pickManagingPartner(
  socios: CnpjPartner[],
  razaoSocial?: string,
  isMei?: boolean,
): { fullName: string; firstName: string; faixaEtaria?: string } | null {
  const humanPartners = (socios || []).filter(
    (s) => s.nome && !isCorporateEntityPartner(s.nome, s.qualificacao || ""),
  );

  const priorityRe = /(s[oó]cio[\s-]*administrador|administrador|titular|presidente|diretor|empres[aá]rio)/i;
  const preferred =
    humanPartners.find((s) => priorityRe.test(s.qualificacao || "")) ||
    humanPartners[0];

  if (preferred) {
    const fullName = toTitleCasePtBr(preferred.nome);
    const firstName = fullName.split(/\s+/)[0] || "";
    const faixaEtaria = typeof preferred.faixaEtaria === "string" && preferred.faixaEtaria.trim()
      ? preferred.faixaEtaria.trim()
      : undefined;
    if (fullName && firstName.length >= 2) {
      return { fullName, firstName, ...(faixaEtaria ? { faixaEtaria } : {}) };
    }
  }

  if (isMei && razaoSocial) {
    const cleaned = toTitleCasePtBr(
      razaoSocial.replace(/\b(LTDA|ME|EPP|EIRELI|EI)\b/gi, "").trim(),
    );
    const firstName = cleaned.split(/\s+/)[0] || "";
    if (cleaned && firstName.length >= 2 && !/\d/.test(firstName)) {
      return { fullName: cleaned, firstName };
    }
  }

  return null;
}

function normalizeHttpUrl(rawUrl: string): string {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

function getHostname(rawUrl: string): string {
  try {
    return new URL(normalizeHttpUrl(rawUrl)).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function matchesHostList(host: string, list: readonly string[]): boolean {
  return matchesDomainList(host, list);
}

async function readUpToBytes(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) {
    const txt = await res.text().catch(() => "");
    return txt.slice(0, maxBytes);
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      const remaining = maxBytes - total;
      chunks.push(value.length > remaining ? value.subarray(0, remaining) : value);
      total += value.length;
      if (total >= maxBytes) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}

function describeNetworkError(err: unknown): { code: string; label: string; diag: string } {
  const errorObj = err instanceof Error ? err : new Error(String(err || ""));
  const cause = (errorObj as { cause?: { code?: string; message?: string } }).cause;
  const rawCode = String(cause?.code || (errorObj as { code?: string }).code || "");
  const msg = `${rawCode} ${cause?.message || ""} ${errorObj.message || ""}`.toUpperCase();

  if (/CERT_HAS_EXPIRED|EXPIRED/.test(msg)) {
    return {
      code: "ssl_expired",
      label: "Site com SSL vencido",
      diag: "com aviso de segurança (certificado SSL vencido) ao tentar abrir",
    };
  }
  if (/TLS|CERT|SSL|ALTNAME|SELF_SIGNED|VERIFY_LEAF/.test(msg)) {
    return {
      code: "ssl_error",
      label: "Erro de segurança SSL",
      diag: "exibindo alerta de 'Site não seguro' (erro de certificado SSL)",
    };
  }
  if (/ENOTFOUND|EAI_AGAIN|NXDOMAIN|DNS/.test(msg)) {
    return {
      code: "dns_error",
      label: "Domínio fora do ar",
      diag: "fora do ar (domínio não encontrado ou expirado)",
    };
  }
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH/.test(msg)) {
    return {
      code: "connection_refused",
      label: "Servidor fora do ar",
      diag: "fora do ar (servidor não responde)",
    };
  }
  if (/TIMEOUT|ABORT/.test(msg) || errorObj.name === "TimeoutError" || errorObj.name === "AbortError") {
    return {
      code: "timeout",
      label: "Site travando / Timeout",
      diag: "muito lento ou travando sem carregar",
    };
  }
  return {
    code: "unreachable",
    label: "Site inacessível",
    diag: "inacessível para quem clica no Google Maps",
  };
}

function isWafOrBotChallenge(res: Response): boolean {
  if (res.status !== 401 && res.status !== 403 && res.status !== 429 && res.status !== 503) {
    return false;
  }
  const cfRay = res.headers.get("cf-ray");
  const cfMitigated = (res.headers.get("cf-mitigated") || "").toLowerCase();
  const server = (res.headers.get("server") || "").toLowerCase();
  const poweredBy = (res.headers.get("x-powered-by") || "").toLowerCase();
  const wafHeaders = [
    res.headers.get("x-sucuri-id"),
    res.headers.get("x-waf"),
    res.headers.get("x-amz-cf-id"),
    res.headers.get("x-litespeed-cache"),
    res.headers.get("x-imunify360"),
  ].some(Boolean);
  return (
    wafHeaders ||
    !!cfRay ||
    cfMitigated.includes("challenge") ||
    server.includes("cloudflare") ||
    server.includes("sucuri") ||
    server.includes("cloudfront") ||
    server.includes("akamai") ||
    server.includes("imperva") ||
    server.includes("incapsula") ||
    server.includes("litespeed") ||
    server.includes("imunify360") ||
    server.includes("wordfence") ||
    server.includes("mod_security") ||
    server.includes("awselb") ||
    server.includes("awswaf") ||
    server.includes("fastly") ||
    server.includes("ddos-guard") ||
    poweredBy.includes("sucuri") ||
    poweredBy.includes("imunify360")
  );
}

function detectBrokenHtmlPattern(html: string): { code: string; label: string; diag: string } | null {
  const lower = html.toLowerCase();
  if (/cgi-sys\/suspendedpage|conta suspensa|account suspended|este site est[aá] suspenso|site suspenso/.test(lower)) {
    return {
      code: "account_suspended",
      label: "Hospedagem suspensa",
      diag: "exibindo aviso de conta/hospedagem suspensa",
    };
  }
  if (/error establishing a database connection|erro ao estabelecer uma conex[aã]o com o banco de dados/.test(lower)) {
    return {
      code: "db_error",
      label: "Erro de banco de dados",
      diag: "quebrado exibindo erro de conexão com o banco de dados",
    };
  }
  if (/there has been a critical error on this website|h[aá] um erro cr[ií]tico no seu site|fatal error:\s+uncaught|parse error:\s+syntax error/i.test(html)) {
    return {
      code: "fatal_cms_error",
      label: "Erro crítico no site",
      diag: "quebrado exibindo erro crítico/PHP na tela",
    };
  }
  if (/<title>\s*index of \//i.test(html) || /<h1>\s*index of \//i.test(html) || /cgi-sys\/defaultwebpage\.cgi/i.test(lower)) {
    return {
      code: "directory_listing",
      label: "Site quebrado (Index of /)",
      diag: "quebrado mostrando diretórios internos ou página padrão do servidor",
    };
  }
  if (
    /este dom[ií]nio est[aá] registrado|domain is parked|compre este dom[ií]nio|registro\.br.*estacionado|hugedomains|sedoparking|afternic\.com|dan\.com\/buy-domain|bodis\.com/i.test(
      lower,
    )
  ) {
    return {
      code: "parked_domain",
      label: "Domínio estacionado",
      diag: "caindo em página genérica de domínio estacionado ou à venda sem site",
    };
  }
  if (/<(?:title|h1)[^>]*>[^<]*(?:slot gacor|togel online|judi online|situs toto|maxwin)/i.test(html)) {
    return {
      code: "hacked_spam_domain",
      label: "Domínio comprometido/invadido",
      diag: "redirecionando ou comprometido por spam externo em vez do site da empresa",
    };
  }
  return null;
}

function detectPlaceholderHtmlPattern(
  html: string,
  visibleLen: number,
): { code: string; label: string; diag: string } | null {
  const lower = html.toLowerCase();
  const titleAndH1 = (html.match(/<(?:title|h1|h2)[^>]*>[\s\S]{0,200}<\/(?:title|h1|h2)>/gi) || []).join(" ").toLowerCase();

  if (
    visibleLen < 700 &&
    (/p[aá]gina em constru[çc][aã]o|site em constru[çc][aã]o|estamos em manuten[çc][aã]o|site em manuten[çc][aã]o|novo site em breve|voltamos em breve|under construction|coming soon/.test(
      titleAndH1,
    ) ||
      (/p[aá]gina em constru[çc][aã]o|site em manuten[çc][aã]o|coming soon/.test(lower) && html.length < 18000))
  ) {
    return {
      code: "under_construction",
      label: "Site em construção",
      diag: "travado em página de 'Site em construção / manutenção' sem captar clientes",
    };
  }

  if (
    /just another wordpress site|s[oó] mais um site wordpress|meu primeiro site|welcome to nginx|apache2 (?:ubuntu|debian) default page|iis windows server|seu site est[aá] pronto|site publicado com sucesso|bem-vindo [àa] sua nova hospedagem/i.test(
      lower,
    ) &&
    visibleLen < 1200
  ) {
    return {
      code: "cms_placeholder",
      label: "Site modelo sem edição",
      diag: "publicado com modelo padrão de hospedagem/WordPress sem conteúdo comercial",
    };
  }

  const loremMatches = lower.match(/lorem ipsum dolor sit amet/g);
  if (loremMatches && loremMatches.length >= 2) {
    return {
      code: "template_lorem_ipsum",
      label: "Template inacabado",
      diag: "com textos genéricos de modelo ('Lorem ipsum') visíveis ao cliente",
    };
  }

  return null;
}

const INSTAGRAM_IGNORE_SEGMENTS = new Set([
  "p",
  "reel",
  "reels",
  "stories",
  "explore",
  "accounts",
  "share",
  "tv",
  "about",
  "legal",
  "developer",
  "direct",
  "oauth",
]);

export function extractInstagramFromHtml(html: string): string | undefined {
  if (!html) return undefined;
  const re = /https?:\/\/(?:www\.)?instagram\.com\/([A-Za-z0-9._]{2,30})(?:[/?#"'\s<]|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const seg = (m[1] || "").trim().replace(/\.$/, "");
    if (!seg || INSTAGRAM_IGNORE_SEGMENTS.has(seg.toLowerCase())) continue;
    return `https://www.instagram.com/${seg}/`;
  }
  return undefined;
}

function stripNonVisibleHtml(html: string): string {
  return String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function evaluateWebsiteQuality(input: {
  html: string;
  currentUrl: string;
  extractedWhatsApps: string[];
  hasPaidTrafficTag: boolean;
  managementTools: string[];
  abandonedCopyrightYear?: number;
}): {
  qualityScore: number;
  weaknesses: string[];
  strengths: string[];
  hasHeadTag: boolean;
  hasViewport: boolean;
  hasSsl: boolean;
  hasClearCta: boolean;
  isSpaShell: boolean;
  visibleLen: number;
} {
  const { html, currentUrl, extractedWhatsApps, hasPaidTrafficTag, managementTools, abandonedCopyrightYear } = input;
  const visibleText = stripNonVisibleHtml(html);
  const visibleLen = visibleText.length;
  const hasHeadTag = /<head[\s>]/i.test(html);
  const hasViewport = /<meta\b[^>]*name\s*=\s*["']viewport["'][^>]*>/i.test(html);
  const hasSsl = currentUrl.startsWith("https://");
  const isSpaShell =
    (/<div[^>]+id\s*=\s*["'](?:root|app|__next|__nuxt|svelte)["'][^>]*>/i.test(html) &&
      /<script\b[^>]*src\s*=/i.test(html)) ||
    /<script\b[^>]*type\s*=\s*["']module["'][^>]*>/i.test(html) ||
    /wixstatic\.com|wix-warmup-data|data-wf-site|website-files\.com|framerusercontent\.com|static1\.squarespace\.com|squarespace\.com\/universal|cdn\.shopify\.com|shopify\.theme|tiendanube|nuvemshop|bubbleapps\.io|elementor-page|wp-content\/plugins\/elementor/i.test(
      html,
    );

  const hasWhatsAppSignal =
    extractedWhatsApps.length > 0 ||
    /joinchat|whatshelp|leadster|tawk\.to|jivochat|tidio|zendesk|intercom|wpp-button|btn-whatsapp|floating-wpp|whatsapp/i.test(
      html,
    );
  const hasTelOrForm =
    /href\s*=\s*["']tel:/i.test(html) ||
    /<form\b/i.test(html) ||
    managementTools.length > 0;
  const hasCtaKeywords =
    /\b(?:agend(?:e|ar|amento)|or[çc]amento|fale conosco|falar com|atendimento|marcar consulta|solicitar|whatsapp|entre em contato)\b/i.test(
      visibleText,
    );
  const hasClearCta = hasWhatsAppSignal || hasTelOrForm || hasCtaKeywords;

  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const rawTitle = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "";
  const isGenericTitle =
    !rawTitle ||
    rawTitle.length < 4 ||
    /^(?:home|index|document|untitled|page|website|welcome|just another wordpress site)$/i.test(rawTitle);

  const hasMetaDesc =
    /<meta\b[^>]*(?:name\s*=\s*["']description["']|property\s*=\s*["']og:description["'])[^>]*content\s*=\s*["'][^"']{15,}["']/i.test(
      html,
    );
  const hasH1 = /<h1\b[^>]*>[\s\S]*?\S[\s\S]*?<\/h1>/i.test(html);
  const hasSchemaOrg = /application\/ld\+json/i.test(html);
  const hasLegacyFrames = /<frameset\b/i.test(html);
  const hasAnalyticsOrTracking =
    hasPaidTrafficTag ||
    /googletagmanager\.com|google-analytics\.com|clarity\.ms|hotjar\.com/i.test(html);

  let score = 35;
  const weaknesses: string[] = [];
  const strengths: string[] = [];

  if (hasSsl) {
    score += 15;
    strengths.push("HTTPS ativo");
  } else {
    score -= 20;
    weaknesses.push("sem cadeado HTTPS");
  }

  if (hasViewport) {
    score += 15;
    strengths.push("adaptado para celular");
  } else if (hasHeadTag) {
    score -= 25;
    weaknesses.push("desconfigurado no celular (sem viewport mobile)");
  }

  if (hasLegacyFrames) {
    score -= 20;
    weaknesses.push("tecnologia antiga em frames");
  }

  if (hasWhatsAppSignal) {
    score += 20;
    strengths.push("botão/canal de WhatsApp");
  }
  if (hasTelOrForm) {
    score += 10;
    strengths.push("formulário/telefone clicável");
  }
  if (hasCtaKeywords) {
    score += 8;
  }

  if (hasHeadTag && !isSpaShell && !hasWhatsAppSignal && !hasTelOrForm) {
    score -= 8;
    weaknesses.push("sem botão de WhatsApp ou formulário de contato");
  }

  if (!isGenericTitle) {
    score += 8;
  } else if (hasHeadTag && !isSpaShell) {
    score -= 5;
    weaknesses.push("título SEO genérico ou ausente");
  }

  if (hasMetaDesc) {
    score += 7;
    strengths.push("meta descrição configurada");
  }
  if (hasH1) score += 5;
  if (hasSchemaOrg) score += 5;

  if (isSpaShell) {
    score += 10;
  } else if (visibleLen >= 400) {
    score += 10;
  } else if (visibleLen >= 120) {
    score += 5;
  } else if (hasHeadTag && visibleLen < 60) {
    score -= 25;
    weaknesses.push("quase sem conteúdo visível");
  }

  if (hasAnalyticsOrTracking) {
    score += 7;
    strengths.push("monitoramento/pixel ativo");
  }

  if (abandonedCopyrightYear) {
    score -= 12;
    weaknesses.push(`rodapé parado em © ${abandonedCopyrightYear}`);
  }

  return {
    qualityScore: Math.max(0, Math.min(100, score)),
    weaknesses,
    strengths,
    hasHeadTag,
    hasViewport,
    hasSsl,
    hasClearCta,
    isSpaShell,
    visibleLen,
  };
}

/**
 * Detecta tags de tráfego pago e tracking (Google Ads/GTM, Meta Pixel, TikTok/LinkedIn)
 * nos primeiros 64KB já baixados pela auditoria sem nenhum request adicional.
 */
export function detectPaidTrafficTags(html: string): string[] {
  if (!html) return [];
  const tags: string[] = [];
  if (/googletagmanager\.com\/gtm\.js|googletagmanager\.com\/gtag\/js\?[^"']*id=AW-|gtag\s*\(\s*['"]config['"]\s*,\s*['"]AW-|googleadservices\.com\/pagead/i.test(html)) {
    tags.push("Google Ads/GTM");
  }
  if (/connect\.facebook\.net\/[^"']*fbevents\.js|fbq\s*\(\s*['"]init['"]/i.test(html)) {
    tags.push("Meta Pixel");
  }
  if (/analytics\.tiktok\.com|snap\.licdn\.com|cdn\.taboola\.com/i.test(html)) {
    tags.push("Pixel Anúncios");
  }
  return tags;
}

const BIO_NOISE_HOSTS = [
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "schema.org",
  "w3.org",
  "ogp.me",
  "apple.com",
  "play.google.com",
  "google.com",
  "goo.gl",
  "g.page",
  "cloudflare.com",
  "wixstatic.com",
  "cloudinary.com",
  "amazonaws.com",
  "googleusercontent.com",
  "gravatar.com",
  "unpkg.com",
  "jsdelivr.net",
  "sentry.io",
  "typeform.com",
  "forms.gle",
  "spotify.com",
  "calendly.com",
  "linktr.ee",
  "beacons.ai",
  "bio.site",
  "carrd.co",
  "doctoralia.com",
  "doctoralia.com.br",
  "trinks.com",
  "booksy.com",
  "simplesdental.com",
];

const ASSET_EXTENSION_RE = /\.(?:png|jpe?g|gif|svg|webp|ico|css|js|woff2?|ttf|eot|pdf|mp4|webm|xml|json)(?:[?#]|$)/i;

/**
 * Extrai a URL real do site próprio da empresa quando o Maps aponta para um agregador (linktr.ee, bio.site, etc.).
 */
export function extractExternalBusinessUrlFromBioHtml(html: string, bioUrl?: string): string | undefined {
  if (!html) return undefined;
  const unescaped = html.replace(/\\\//g, "/");
  const bioHost = bioUrl ? getHostname(bioUrl) : "";
  const candidates: Array<{ url: string; host: string; score: number }> = [];
  const seen = new Set<string>();

  const patterns = [
    /<a\b[^>]*href\s*=\s*["'](https?:\/\/[^"'<>#\s]+)["']/gi,
    /"(?:url|href|link|website)"\s*:\s*"(https?:\/\/[^"<>#\s]+)"/gi,
  ];

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(unescaped)) !== null) {
      const rawUrl = (m[1] || "").trim().replace(/&amp;/g, "&");
      if (!rawUrl || seen.has(rawUrl)) continue;
      seen.add(rawUrl);

      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        continue;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      if (ASSET_EXTENSION_RE.test(parsed.pathname)) continue;
      if (isPrivateOrLocalUrl(rawUrl)) continue;

      const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
      if (!host || !host.includes(".")) continue;
      if (bioHost && (host === bioHost || host.endsWith(`.${bioHost}`))) continue;
      if (matchesHostList(host, SOCIAL_ONLY_HOSTS)) continue;
      if (matchesHostList(host, IMPROVISED_HOSTS)) continue;
      if (matchesHostList(host, BIO_NOISE_HOSTS)) continue;

      let score = 10;
      if (host.endsWith(".br")) score += 15;
      if (parsed.pathname === "/" || parsed.pathname === "") score += 5;
      if (parsed.pathname.length > 40) score -= 3;
      candidates.push({ url: parsed.toString(), host, score });
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.url.length - b.url.length);
  return candidates[0]?.url;
}

/**
 * Encontra até 1 subpágina interna de contato/sobre no mesmo host para recuperar CNPJ/WhatsApp de rodapés ausentes na home.
 */
export function findInternalContactSubpageUrl(html: string, baseUrl: string): string | undefined {
  if (!html || !baseUrl) return undefined;
  let baseParsed: URL;
  try {
    baseParsed = new URL(normalizeHttpUrl(baseUrl));
  } catch {
    return undefined;
  }
  const baseHost = getHostname(baseUrl);
  const basePath = baseParsed.pathname.replace(/\/+$/, "") || "/";

  const candidates: Array<{ url: string; priority: number }> = [];
  const seen = new Set<string>();
  const anchorRe = /<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null) {
    const rawHref = (m[1] || "").trim();
    if (!rawHref || /^(?:mailto:|tel:|javascript:|whatsapp:)/i.test(rawHref)) continue;

    let resolved: URL;
    try {
      resolved = new URL(rawHref, baseParsed);
    } catch {
      continue;
    }
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") continue;
    if (ASSET_EXTENSION_RE.test(resolved.pathname)) continue;
    if (getHostname(resolved.toString()) !== baseHost) continue;
    if (isPrivateOrLocalUrl(resolved.toString())) continue;

    const cleanPath = resolved.pathname.replace(/\/+$/, "") || "/";
    if (cleanPath === basePath && !resolved.search) continue;

    resolved.hash = "";
    const finalUrl = resolved.toString();
    if (seen.has(finalUrl)) continue;
    seen.add(finalUrl);

    const pathNorm = normSearchText(cleanPath);
    const labelNorm = normSearchText(m[2].replace(/<[^>]+>/g, " "));
    let priority = 0;

    if (/(?:^|\s)(contato|fale conosco|faleconosco|atendimento|contact)(?:\s|$)/.test(pathNorm) ||
        /^(contato|fale conosco|contact)$/.test(labelNorm)) {
      priority = 3;
    } else if (/(?:^|\s)(sobre|sobre nos|sobrenos|quem somos|quemsomos|a empresa|empresa|institucional|about)(?:\s|$)/.test(pathNorm) ||
        /^(sobre|sobre nos|quem somos|institucional|a empresa)$/.test(labelNorm)) {
      priority = 2;
    } else if (/(privacidade|politica de privacidade|termos|lgpd)/.test(pathNorm)) {
      priority = 1;
    }

    if (priority > 0) {
      candidates.push({ url: finalUrl, priority });
    }
  }

  candidates.sort((a, b) => b.priority - a.priority || a.url.length - b.url.length);
  return candidates[0]?.url;
}

const MANAGEMENT_TOOL_PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "Doctoralia", re: /doctoralia\.com(?:\.br)?/i },
  { name: "Clinicorp", re: /clinicorp\.com/i },
  { name: "Simples Dental", re: /simplesdental\.com|simples-dental/i },
  { name: "Feegow", re: /feegow\.com|feegowclinic/i },
  { name: "iClinic", re: /iclinic\.com\.br/i },
  { name: "Trinks", re: /trinks\.com/i },
  { name: "Booksy", re: /booksy\.com/i },
  { name: "RD Station", re: /rdstation\.com|d335luupugsy2\.cloudfront\.net|rd-js/i },
  { name: "HubSpot", re: /js\.hs-scripts\.com|hsforms\.net|hubspot\.com/i },
  { name: "Gupy", re: /gupy\.io/i },
  { name: "TuoTempo", re: /tuotempo\.com/i },
  { name: "Avec", re: /avec\.app|bellesoftware\.com/i },
];

/**
 * Detecta ferramentas pagas de agenda, CRM ou automação no HTML (zero custo extra de rede).
 */
export function detectManagementTools(html: string): string[] {
  if (!html) return [];
  const detected: string[] = [];
  for (const tool of MANAGEMENT_TOOL_PATTERNS) {
    if (tool.re.test(html)) detected.push(tool.name);
  }
  return detected;
}

/**
 * Detecta rodapé com copyright desatualizado (<= currentYear - 4), evitando falsos positivos em faixas como "© 2016–2026".
 */
export function detectAbandonedCopyrightYear(
  html: string,
  referenceYear = new Date().getFullYear(),
): number | undefined {
  if (!html) return undefined;
  const years: number[] = [];
  const re = /(?:©|&copy;|copyright|todos os direitos reservados)[^\n<]{0,60}/gi;
  const reverseRe = /\b(20\d{2})\s*(?:©|&copy;|todos os direitos reservados)/gi;

  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const matches = m[0].match(/\b(20\d{2})\b/g) || [];
    for (const yStr of matches) {
      const y = Number(yStr);
      if (y >= 2005 && y <= referenceYear) years.push(y);
    }
  }
  while ((m = reverseRe.exec(html)) !== null) {
    const y = Number(m[1]);
    if (y >= 2005 && y <= referenceYear) years.push(y);
  }

  if (years.length === 0) return undefined;
  const latestYear = Math.max(...years);
  return latestYear <= referenceYear - 4 ? latestYear : undefined;
}

const HUMAN_NAME_NOISE_TOKENS = NON_PERSON_NOISE_TOKENS;

function normalizeHumanCandidate(raw: string, businessName?: string): string | undefined {
  const cleaned = String(raw || "")
    .replace(/^\s*(?:dr\.?|dra\.?|prof\.?|arq\.?|adv\.?|eng\.?)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || /\d/.test(cleaned)) return undefined;

  const title = toTitleCasePtBr(cleaned);
  const words = title.split(" ").filter(Boolean);
  const nonPrep = words.filter((w) => !PT_BR_PREPOSITIONS.has(w.toLowerCase()));
  if (nonPrep.length < 2 || nonPrep.length > 4) return undefined;

  for (const token of nonPrep) {
    const norm = normSearchText(token);
    if (norm.length < 2 || HUMAN_NAME_NOISE_TOKENS.has(norm)) return undefined;
  }
  if (!isPlausibleHumanPersonName(title, { businessName })) return undefined;
  return title;
}

/**
 * Extrai nome completo provável do dono/profissional responsável via owner_name, título do Maps ("Dra. Nome Sobrenome", "... - Nome Sobrenome") ou assinatura de resposta a avaliações.
 */
export function extractPersonNameFromLeadSignals(input: {
  ownerName?: string;
  leadName?: string;
  reviews?: ReadonlyArray<{ texto?: string; respostaDono?: string }>;
}): string | undefined {
  const rawLeadName = String(input.leadName || "").trim();
  if (input.ownerName) {
    const sanitized = sanitizeHumanPersonName(input.ownerName, { businessName: rawLeadName || undefined });
    const fromOwner = sanitized
      ? sanitized.replace(/^\s*(?:dr\.?|dra\.?|prof\.?|arq\.?|adv\.?|eng\.?)\s+/i, "").trim()
      : normalizeHumanCandidate(input.ownerName, rawLeadName || undefined);
    if (fromOwner && normalizeHumanCandidate(fromOwner, rawLeadName || undefined)) {
      return normalizeHumanCandidate(fromOwner, rawLeadName || undefined);
    }
  }

  if (rawLeadName) {
    const drMatch = rawLeadName.match(
      /(?:^|[\s\-–|:()])(?:dr\.?|dra\.?|prof\.?)\s+([A-Za-zÀ-ÿ]+(?:\s+(?:da|de|do|dos|das|e)?\s*[A-Za-zÀ-ÿ]+){1,3})/i,
    );
    if (drMatch?.[1]) {
      const words = drMatch[1].trim().split(/\s+/);
      for (let len = Math.min(words.length, 4); len >= 2; len--) {
        const candidate = normalizeHumanCandidate(words.slice(0, len).join(" "));
        if (candidate) return candidate;
      }
    }

    const segments = rawLeadName.split(/\s*(?:\||–|—|•|:|\s+-\s+|\bpor\b)\s*/i).map((s) => s.trim());
    for (let idx = 0; idx < segments.length; idx++) {
      const seg = segments[idx];
      if (!seg) continue;
      if (idx === 0 && !/\b(?:dr\.?|dra\.?|prof\.?)\b/i.test(seg)) {
        // Ignora segmento principal da marca sem título para não confundir nome fantasia com pessoa
        continue;
      }
      const candidate = normalizeHumanCandidate(seg, rawLeadName);
      if (candidate) return candidate;
    }
  }

  if (Array.isArray(input.reviews)) {
    const signoffRe = /(?:^|[\n.!?])\s*(?:[Aa]tt\.?|[Aa]tenciosamente|[Aa]bra[çc]os?|[Gg]rat[oa]|[Ee]quipe|[Aa]ss\.?)\s*[,:\-–!]*\s*(?:(?:[Dd]r\.?|[Dd]ra\.?)\s+)?([A-ZÀ-Ú][a-zà-ú]{1,}(?:\s+(?:da|de|do|dos|das|e))?(?:\s+[A-ZÀ-Ú][a-zà-ú]{1,}){1,2})/g;
    for (const r of input.reviews) {
      const reply = String(r?.respostaDono || "").trim();
      if (!reply) continue;
      let sigMatch: RegExpExecArray | null;
      let lastCandidate: string | undefined;
      while ((sigMatch = signoffRe.exec(reply)) !== null) {
        const candidate = normalizeHumanCandidate(sigMatch[1]);
        if (candidate) lastCandidate = candidate;
      }
      signoffRe.lastIndex = 0;
      if (lastCandidate) return lastCandidate;
    }
  }

  return undefined;
}

/**
 * Audita a saúde técnica e a maturidade de conversão de um site em < 4,5s lendo até 256KB
 * sem custo externo. Extrai também links WhatsApp (`wa.me`), Instagram e CNPJs do HTML.
 */
export async function auditLeadWebsite(
  rawUrl: string | null | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<SiteAuditResult> {
  const raw = String(rawUrl || "").trim();
  if (!raw) {
    return {
      status: "no_site",
      statusLabel: "Sem site",
      diagnosticoComercial: "sem site cadastrado no Google Maps",
      extractedWhatsApps: [],
      extractedCnpjs: [],
      siteQualityScore: 0,
    };
  }

  const host = getHostname(raw);
  if (!host) {
    return {
      status: "no_site",
      statusLabel: "Sem site",
      diagnosticoComercial: "sem site válido cadastrado no Google Maps",
      extractedWhatsApps: [],
      extractedCnpjs: [],
      siteQualityScore: 0,
    };
  }

  const preClass = classifyNonOwnWebsiteUrl(raw);
  if (preClass === "social_link_only") {
    return {
      status: "no_site",
      issueCode: "social_link_only",
      statusLabel: "Só rede social/WhatsApp",
      diagnosticoComercial: "usando apenas link de rede social em vez de site profissional",
      extractedWhatsApps: extractWhatsAppPhonesFromHtml(raw),
      extractedCnpjs: [],
      extractedInstagram: extractInstagramFromHtml(raw),
      siteQualityScore: 10,
    };
  }
  if (preClass === "third_party_platform") {
    return {
      status: "no_site",
      issueCode: "third_party_platform",
      statusLabel: "Só plataforma de terceiros",
      diagnosticoComercial: "usando apenas cardápio/agenda de terceiros sem site profissional próprio",
      extractedWhatsApps: extractWhatsAppPhonesFromHtml(raw),
      extractedCnpjs: [],
      siteQualityScore: 15,
    };
  }

  const isImprovisedHost = matchesHostList(host, IMPROVISED_HOSTS);
  let currentUrl = normalizeHttpUrl(raw);
  const startMs = Date.now();
  let lastHopMs = 0;
  let lastRes: Response | null = null;
  let networkError: unknown = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (isPrivateOrLocalUrl(currentUrl)) {
      return {
        status: isImprovisedHost ? "weak_site" : "active_site",
        statusLabel: isImprovisedHost ? "Site improvisado/gratuito" : "URL bloqueada",
        diagnosticoComercial: isImprovisedHost
          ? "usando página improvisada gratuita em vez de um site profissional próprio"
          : "",
        extractedWhatsApps: [],
        extractedCnpjs: [],
        siteQualityScore: isImprovisedHost ? 30 : 50,
      };
    }

    const hopStart = Date.now();
    try {
      const res = await fetchImpl(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(SITE_AUDIT_TIMEOUT_MS),
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "pt-BR,pt;q=0.9",
        },
      });
      lastHopMs = Date.now() - hopStart;

      if (res.status >= 300 && res.status < 400) {
        const location = res.headers.get("location");
        res.body?.cancel?.().catch(() => {});
        if (!location || hop === MAX_REDIRECTS) {
          lastRes = res;
          break;
        }
        currentUrl = new URL(location, currentUrl).toString();
        const redirectedNonSite = classifyNonOwnWebsiteUrl(currentUrl);
        if (redirectedNonSite === "social_link_only" || redirectedNonSite === "third_party_platform") {
          lastRes = res;
          break;
        }
        continue;
      }

      lastRes = res;
      break;
    } catch (err) {
      lastHopMs = Date.now() - hopStart;
      networkError = err;
      const errDiag = describeNetworkError(err);
      const rawMsg = err instanceof Error ? err.message : String(err || "");
      const isTransientRetryable =
        hop === 0 &&
        (errDiag.code === "timeout" || /ECONNRESET|UND_ERR_CONNECT_TIMEOUT/i.test(rawMsg));

      if (isTransientRetryable) {
        let retryUrl = currentUrl;
        try {
          const parsedRetry = new URL(currentUrl);
          if (parsedRetry.hostname && !parsedRetry.hostname.startsWith("www.") && parsedRetry.hostname.split(".").length <= 3) {
            parsedRetry.hostname = `www.${parsedRetry.hostname}`;
            const wwwCandidate = parsedRetry.toString();
            if (!isPrivateOrLocalUrl(wwwCandidate)) retryUrl = wwwCandidate;
          }
        } catch {}

        try {
          const retryStart = Date.now();
          const retryRes = await fetchImpl(retryUrl, {
            method: "GET",
            redirect: "manual",
            signal: AbortSignal.timeout(SITE_AUDIT_TIMEOUT_MS),
            headers: {
              "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "pt-BR,pt;q=0.9",
            },
          });
          lastHopMs = Date.now() - retryStart;
          currentUrl = retryUrl;
          networkError = null;
          if (retryRes.status >= 300 && retryRes.status < 400) {
            const location = retryRes.headers.get("location");
            retryRes.body?.cancel?.().catch(() => {});
            if (!location || hop === MAX_REDIRECTS) {
              lastRes = retryRes;
              break;
            }
            currentUrl = new URL(location, currentUrl).toString();
            const redirectedNonSite = classifyNonOwnWebsiteUrl(currentUrl);
            if (redirectedNonSite === "social_link_only" || redirectedNonSite === "third_party_platform") {
              lastRes = retryRes;
              break;
            }
            continue;
          }
          lastRes = retryRes;
          break;
        } catch (retryErr) {
          networkError = retryErr;
        }
      }

      // Fallback HTTP caso o link tenha vindo HTTPS mas falhou TLS ou vice-versa
      if (hop === 0 && currentUrl.startsWith("https://")) {
        const httpFallback = `http://${currentUrl.slice("https://".length)}`;
        try {
          const resHttp = await fetchImpl(httpFallback, {
            method: "GET",
            redirect: "manual",
            signal: AbortSignal.timeout(SITE_AUDIT_TIMEOUT_MS),
          });
          if (resHttp.ok || (resHttp.status >= 300 && resHttp.status < 400)) {
            await resHttp.body?.cancel?.().catch(() => {});
            const tlsDiag = describeNetworkError(err);
            return {
              status: tlsDiag.code.startsWith("ssl") ? "broken_site" : "weak_site",
              issueCode: tlsDiag.code,
              statusLabel: tlsDiag.code.startsWith("ssl") ? tlsDiag.label : "Site sem HTTPS",
              diagnosticoComercial: tlsDiag.code.startsWith("ssl")
                ? tlsDiag.diag
                : "abrindo sem cadeado de segurança HTTPS",
              httpStatus: resHttp.status,
              finalUrl: httpFallback,
              responseTimeMs: Date.now() - startMs,
              extractedWhatsApps: [],
              extractedCnpjs: [],
              siteQualityScore: tlsDiag.code.startsWith("ssl") ? 10 : 35,
              hasSsl: false,
            };
          }
          await resHttp.body?.cancel?.().catch(() => {});
        } catch {
          // Segue para retornar o erro principal abaixo
        }
      }
      break;
    }
  }

  const elapsed = Date.now() - startMs;

  if (!lastRes) {
    const info = describeNetworkError(networkError);
    if (info.code === "timeout") {
      return {
        status: isImprovisedHost ? "weak_site" : "active_site",
        issueCode: isImprovisedHost ? "improvised_host" : "audit_timeout_unverified",
        statusLabel: isImprovisedHost ? "Site improvisado/gratuito" : "Site não verificado (lento/protegido)",
        diagnosticoComercial: isImprovisedHost
          ? "usando página improvisada gratuita em vez de um site profissional próprio"
          : "",
        auditUncertain: !isImprovisedHost,
        finalUrl: currentUrl,
        responseTimeMs: elapsed,
        extractedWhatsApps: [],
        extractedCnpjs: [],
        siteQualityScore: isImprovisedHost ? 30 : 55,
        hasSsl: currentUrl.startsWith("https://"),
      };
    }
    return {
      status: "broken_site",
      issueCode: info.code,
      statusLabel: info.label,
      diagnosticoComercial: info.diag,
      finalUrl: currentUrl,
      responseTimeMs: elapsed,
      extractedWhatsApps: [],
      extractedCnpjs: [],
      siteQualityScore: 0,
    };
  }

  const finalHost = getHostname(currentUrl);
  const redirectedToNonWebsite = classifyNonOwnWebsiteUrl(currentUrl);
  if (redirectedToNonWebsite === "social_link_only" || redirectedToNonWebsite === "third_party_platform") {
    await lastRes.body?.cancel?.().catch(() => {});
    return {
      status: "weak_site",
      issueCode: "redirects_to_social",
      statusLabel: "Domínio redireciona p/ rede social",
      diagnosticoComercial: "com domínio próprio apenas redirecionando para rede social/plataforma sem site próprio",
      httpStatus: lastRes.status,
      finalUrl: currentUrl,
      responseTimeMs: elapsed,
      extractedWhatsApps: extractWhatsAppPhonesFromHtml(currentUrl),
      extractedCnpjs: [],
      extractedInstagram: extractInstagramFromHtml(currentUrl),
      siteQualityScore: 28,
      siteWeaknesses: ["domínio apenas redireciona para rede social/terceiro"],
      hasSsl: currentUrl.startsWith("https://"),
    };
  }

  const effectiveImprovisedHost = isImprovisedHost || (!!finalHost && matchesHostList(finalHost, IMPROVISED_HOSTS));

  if (isWafOrBotChallenge(lastRes)) {
    await lastRes.body?.cancel?.().catch(() => {});
    return {
      status: effectiveImprovisedHost ? "weak_site" : "active_site",
      issueCode: effectiveImprovisedHost ? "improvised_host" : "waf_protected",
      statusLabel: effectiveImprovisedHost ? "Site improvisado/gratuito" : "Site ativo (protegido)",
      diagnosticoComercial: effectiveImprovisedHost
        ? "usando página improvisada gratuita em vez de um site profissional próprio"
        : "",
      auditUncertain: !effectiveImprovisedHost,
      httpStatus: lastRes.status,
      finalUrl: currentUrl,
      responseTimeMs: elapsed,
      extractedWhatsApps: [],
      extractedCnpjs: [],
      siteQualityScore: effectiveImprovisedHost ? 35 : 65,
      hasSsl: currentUrl.startsWith("https://"),
    };
  }

  const contentType = (lastRes.headers.get("content-type") || "").toLowerCase();
  const isTextLike = !contentType || /html|text|xml|json/.test(contentType);
  const html = isTextLike ? await readUpToBytes(lastRes, MAX_SITE_HTML_BYTES) : "";
  if (!isTextLike) await lastRes.body?.cancel?.().catch(() => {});

  const extractedWhatsApps = extractWhatsAppPhonesFromHtml(html);
  const extractedCnpjs = extractCnpjsFromText(html);
  const extractedEmails = extractEmailsFromHtml(html);
  let extractedInstagram = extractInstagramFromHtml(html);
  const trafficTags = detectPaidTrafficTags(html);
  let managementTools = detectManagementTools(html);
  let abandonedCopyrightYear = detectAbandonedCopyrightYear(html);
  const discoveredRealWebsite = effectiveImprovisedHost
    ? extractExternalBusinessUrlFromBioHtml(html, currentUrl)
    : undefined;

  // 1-hop em subpágina interna (/contato, /sobre, /quem-somos) quando o rodapé da home não trouxe CNPJ
  if (lastRes.ok && !effectiveImprovisedHost && extractedCnpjs.length === 0 && html) {
    const subpageUrl = findInternalContactSubpageUrl(html, currentUrl);
    if (subpageUrl && !isPrivateOrLocalUrl(subpageUrl)) {
      try {
        const subRes = await fetchImpl(subpageUrl, {
          method: "GET",
          redirect: "manual",
          signal: AbortSignal.timeout(2500),
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "pt-BR,pt;q=0.9",
          },
        });
        const subType = (subRes.headers.get("content-type") || "").toLowerCase();
        if (subRes.ok && (!subType || /html|text|xml/.test(subType))) {
          const subHtml = await readUpToBytes(subRes, MAX_SITE_HTML_BYTES);
          for (const cnpj of extractCnpjsFromText(subHtml)) {
            if (!extractedCnpjs.includes(cnpj)) extractedCnpjs.push(cnpj);
          }
          for (const wa of extractWhatsAppPhonesFromHtml(subHtml)) {
            if (!extractedWhatsApps.includes(wa)) extractedWhatsApps.push(wa);
          }
          for (const em of extractEmailsFromHtml(subHtml)) {
            if (!extractedEmails.includes(em)) extractedEmails.push(em);
          }
          if (!extractedInstagram) {
            extractedInstagram = extractInstagramFromHtml(subHtml);
          }
          for (const t of detectPaidTrafficTags(subHtml)) {
            if (!trafficTags.includes(t)) trafficTags.push(t);
          }
          const subTools = detectManagementTools(subHtml);
          if (subTools.length > 0) {
            managementTools = Array.from(new Set([...managementTools, ...subTools]));
          }
          if (!abandonedCopyrightYear) {
            abandonedCopyrightYear = detectAbandonedCopyrightYear(subHtml);
          }
        } else {
          await subRes.body?.cancel?.().catch(() => {});
        }
      } catch {
        // Subpágina opcional — falha silenciosa preservando resultado da home
      }
    }
  }

  const hasPaidTrafficTag = trafficTags.length > 0;
  const quality = evaluateWebsiteQuality({
    html,
    currentUrl,
    extractedWhatsApps,
    hasPaidTrafficTag,
    managementTools,
    abandonedCopyrightYear,
  });

  const auditExtras = {
    ...(extractedEmails.length > 0 ? { extractedEmails } : {}),
    ...(extractedInstagram ? { extractedInstagram } : {}),
    ...(hasPaidTrafficTag ? { hasPaidTrafficTag, trafficTags } : {}),
    ...(discoveredRealWebsite ? { discoveredRealWebsite } : {}),
    ...(managementTools.length > 0 ? { managementTools } : {}),
    ...(abandonedCopyrightYear ? { abandonedCopyrightYear } : {}),
    siteQualityScore: quality.qualityScore,
    ...(quality.weaknesses.length > 0 ? { siteWeaknesses: quality.weaknesses } : {}),
    ...(quality.strengths.length > 0 ? { siteStrengths: quality.strengths } : {}),
    hasMobileViewport: quality.hasViewport,
    hasSsl: quality.hasSsl,
    hasClearCta: quality.hasClearCta,
  };

  const brokenPattern = detectBrokenHtmlPattern(html);
  if (brokenPattern) {
    return {
      status: "broken_site",
      issueCode: brokenPattern.code,
      statusLabel: brokenPattern.label,
      diagnosticoComercial: brokenPattern.diag,
      httpStatus: lastRes.status,
      finalUrl: currentUrl,
      responseTimeMs: elapsed,
      extractedWhatsApps,
      extractedCnpjs,
      ...auditExtras,
      siteQualityScore: 5,
    };
  }

  // HTTP 401/403/429 sem padrão explícito de erro/suspensão no HTML costuma ser WAF ou bloqueio anti-crawler.
  if (lastRes.status === 401 || lastRes.status === 403 || lastRes.status === 429) {
    return {
      status: effectiveImprovisedHost ? "weak_site" : "active_site",
      issueCode: effectiveImprovisedHost ? "improvised_host" : "waf_protected",
      statusLabel: effectiveImprovisedHost ? "Site improvisado/gratuito" : "Site ativo (protegido)",
      diagnosticoComercial: effectiveImprovisedHost
        ? "usando página improvisada gratuita em vez de um site profissional próprio"
        : "",
      auditUncertain: !effectiveImprovisedHost,
      httpStatus: lastRes.status,
      finalUrl: currentUrl,
      responseTimeMs: elapsed,
      extractedWhatsApps,
      extractedCnpjs,
      ...auditExtras,
      siteQualityScore: effectiveImprovisedHost ? 35 : 65,
    };
  }

  if (
    lastRes.status === 404 ||
    lastRes.status === 410 ||
    lastRes.status === 451 ||
    lastRes.status >= 500
  ) {
    const isCfOriginDown = lastRes.status >= 520 && lastRes.status <= 530;
    return {
      status: "broken_site",
      issueCode: `http_${lastRes.status}`,
      statusLabel: isCfOriginDown
        ? `Servidor fora do ar (Erro ${lastRes.status})`
        : `Site com erro HTTP ${lastRes.status}`,
      diagnosticoComercial: isCfOriginDown
        ? `com servidor de origem offline (erro Cloudflare ${lastRes.status})`
        : `retornando página de erro (HTTP ${lastRes.status}) para os visitantes`,
      httpStatus: lastRes.status,
      finalUrl: currentUrl,
      responseTimeMs: elapsed,
      extractedWhatsApps,
      extractedCnpjs,
      ...auditExtras,
      siteQualityScore: 0,
    };
  }

  if (effectiveImprovisedHost) {
    return {
      status: "weak_site",
      issueCode: "improvised_host",
      statusLabel: "Site improvisado/gratuito",
      diagnosticoComercial: "usando página improvisada gratuita em vez de um site profissional próprio",
      httpStatus: lastRes.status,
      finalUrl: currentUrl,
      responseTimeMs: elapsed,
      extractedWhatsApps,
      extractedCnpjs,
      ...auditExtras,
    };
  }

  if (currentUrl.startsWith("http://")) {
    return {
      status: "weak_site",
      issueCode: "no_https",
      statusLabel: "Site sem HTTPS (Não seguro)",
      diagnosticoComercial: "abrindo sem cadeado de segurança HTTPS ('Site não seguro')",
      httpStatus: lastRes.status,
      finalUrl: currentUrl,
      responseTimeMs: elapsed,
      extractedWhatsApps,
      extractedCnpjs,
      ...auditExtras,
    };
  }

  const placeholderPattern = detectPlaceholderHtmlPattern(html, quality.visibleLen);
  if (placeholderPattern) {
    return {
      status: "weak_site",
      issueCode: placeholderPattern.code,
      statusLabel: placeholderPattern.label,
      diagnosticoComercial: placeholderPattern.diag,
      httpStatus: lastRes.status,
      finalUrl: currentUrl,
      responseTimeMs: elapsed,
      extractedWhatsApps,
      extractedCnpjs,
      ...auditExtras,
      siteQualityScore: Math.min(quality.qualityScore, 22),
    };
  }

  if (lastHopMs > 7500 || elapsed > 10000) {
    return {
      status: "weak_site",
      issueCode: "slow_site",
      statusLabel: "Site muito lento",
      diagnosticoComercial: `muito lento para abrir (${(Math.max(lastHopMs, elapsed) / 1000).toFixed(1)}s na resposta)`,
      httpStatus: lastRes.status,
      finalUrl: currentUrl,
      responseTimeMs: elapsed,
      extractedWhatsApps,
      extractedCnpjs,
      ...auditExtras,
    };
  }

  if (quality.hasHeadTag && !quality.isSpaShell && quality.visibleLen < 60 && extractedWhatsApps.length === 0) {
    return {
      status: "weak_site",
      issueCode: "empty_or_thin_page",
      statusLabel: "Site vazio/incompleto",
      diagnosticoComercial: "abrindo quase em branco, sem conteúdo comercial nem canais de contato",
      httpStatus: lastRes.status,
      finalUrl: currentUrl,
      responseTimeMs: elapsed,
      extractedWhatsApps,
      extractedCnpjs,
      ...auditExtras,
    };
  }

  if (quality.hasHeadTag && !quality.hasViewport) {
    return {
      status: "weak_site",
      issueCode: "not_mobile_friendly",
      statusLabel: "Site sem versão mobile",
      diagnosticoComercial:
        extractedWhatsApps.length === 0
          ? "desconfigurado no celular (sem adaptação mobile) e sem botão direto de WhatsApp"
          : "desconfigurado no celular por não ter adaptação mobile responsiva",
      httpStatus: lastRes.status,
      finalUrl: currentUrl,
      responseTimeMs: elapsed,
      extractedWhatsApps,
      extractedCnpjs,
      ...auditExtras,
    };
  }

  if (quality.hasHeadTag && !quality.isSpaShell && quality.weaknesses.length >= 2 && quality.qualityScore < 40) {
    const reasonSummary = quality.weaknesses.slice(0, 2).join(" e ");
    return {
      status: "weak_site",
      issueCode: "low_conversion_site",
      statusLabel: "Site defasado / baixa conversão",
      diagnosticoComercial: reasonSummary
        ? `com site defasado (${reasonSummary})`
        : "com site antigo e baixa estrutura para gerar contatos",
      httpStatus: lastRes.status,
      finalUrl: currentUrl,
      responseTimeMs: elapsed,
      extractedWhatsApps,
      extractedCnpjs,
      ...auditExtras,
    };
  }

  return {
    status: "active_site",
    statusLabel: quality.qualityScore >= 78 ? "Site estruturado" : "Site ativo",
    diagnosticoComercial:
      quality.qualityScore >= 78
        ? "site ativo, responsivo e bem estruturado para conversão"
        : quality.weaknesses.length > 0
          ? `site ativo, mas ${quality.weaknesses[0]}`
          : "site ativo e funcionando",
    httpStatus: lastRes.status,
    finalUrl: currentUrl,
    responseTimeMs: elapsed,
    extractedWhatsApps,
    extractedCnpjs,
    ...auditExtras,
  };
}

/**
 * Consulta gratuita no RDAP oficial do Registro.br para domínios .br/.com.br.
 * Devolve o CNPJ titular exato mesmo se o site estiver offline ou com SSL quebrado.
 */
export async function lookupRdapBrDomain(
  websiteUrl: string | null | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<RdapCacheEntry> {
  const host = getHostname(String(websiteUrl || ""));
  if (!host || !host.endsWith(".br")) {
    return { cnpj: null, frozen: false };
  }

  // Extrai o domínio registrável (ex: "sub.clinica.com.br" → "clinica.com.br")
  const parts = host.split(".").filter(Boolean);
  const registrable =
    parts.length >= 3 && ["com", "net", "org", "edu", "gov", "adv", "med", "odo", "eng", "eti", "inf", "arq", "ind", "tur", "vet"].includes(parts[parts.length - 2])
      ? parts.slice(-3).join(".")
      : parts.slice(-2).join(".");

  const cached = rdapDomainCache.get(registrable);
  if (cached) return cached;

  try {
    const res = await fetchImpl(`https://rdap.registro.br/domain/${encodeURIComponent(registrable)}`, {
      method: "GET",
      signal: AbortSignal.timeout(RDAP_TIMEOUT_MS),
      headers: { Accept: "application/rdap+json, application/json" },
    });
    if (!res.ok) {
      await res.body?.cancel?.().catch(() => {});
      const empty: RdapCacheEntry = { cnpj: null, frozen: false };
      setLru(rdapDomainCache, registrable, empty, MAX_CACHE_ENTRIES);
      return empty;
    }

    const data: unknown = await res.json().catch(() => null);
    if (!data || typeof data !== "object") {
      return { cnpj: null, frozen: false };
    }
    const obj = data as Record<string, unknown>;
    const statuses = Array.isArray(obj.status)
      ? obj.status.map((s) => String(s).toLowerCase())
      : [];
    const frozen = statuses.some((s) => s.includes("hold") || s.includes("frozen") || s.includes("pending delete"));

    let cnpj: string | null = null;
    const entities = Array.isArray(obj.entities) ? obj.entities : [];
    for (const ent of entities) {
      if (!ent || typeof ent !== "object") continue;
      const eObj = ent as Record<string, unknown>;
      const publicIds = Array.isArray(eObj.publicIds) ? eObj.publicIds : [];
      for (const pid of publicIds) {
        if (!pid || typeof pid !== "object") continue;
        const pObj = pid as Record<string, unknown>;
        if (String(pObj.type || "").toLowerCase() === "cnpj") {
          const digits = String(pObj.identifier || "").replace(/\D/g, "");
          if (isValidCnpj(digits)) {
            cnpj = digits;
            break;
          }
        }
      }
      if (!cnpj && typeof eObj.handle === "string") {
        const handleDigits = eObj.handle.replace(/\D/g, "");
        if (isValidCnpj(handleDigits)) cnpj = handleDigits;
      }
      if (cnpj) break;
    }

    const result: RdapCacheEntry = { cnpj, frozen };
    setLru(rdapDomainCache, registrable, result, MAX_CACHE_ENTRIES);
    return result;
  } catch {
    return { cnpj: null, frozen: false };
  }
}

function normSearchText(s: string): string {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const SEARCH_NOISE_WORDS = new Set([
  "ltda", "eireli", "me", "epp", "s/a", "sa", "cia", "de", "da", "do", "das", "dos", "e", "em",
]);

/**
 * Remove sufixos de SEO do Google Maps ("Marca | Especialidade - Cidade") para melhorar buscas de CNPJ.
 */
export function cleanLeadNameForSearch(rawName: string): string {
  const withoutParens = String(rawName || "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!withoutParens) return "";

  const segments = withoutParens
    .split(/\s*(?:\||–|—|•|:|\s+-\s+)\s*/)
    .map((s) => s.trim())
    .filter(Boolean);

  let core = segments[0] || withoutParens;
  if (segments.length > 1 && (/^(?:dr\.?|dra\.?)$/i.test(core) || core.length < 3)) {
    core = `${core} ${segments[1]}`.trim();
  }
  return core.replace(/\s+/g, " ").trim();
}

/**
 * Retorna até 3 CNPJs candidatos encontrados na web via busca gratuita (sem aspas rígidas).
 */
export async function discoverCnpjsViaWebSearch(
  leadName: string,
  cidade?: string,
  uf?: string,
  searchFn: SearchLike = webSearch,
  personName?: string,
): Promise<string[]> {
  const coreName = cleanLeadNameForSearch(leadName);
  const queryName = coreName.length >= 3 ? coreName : String(leadName || "").trim();
  if (queryName.length < 3 && !personName) return [];

  const locationPart = [cidade, uf].filter(Boolean).join(" ");
  const nameTokens = normSearchText(`${queryName} ${leadName}`)
    .split(" ")
    .filter((t) => t.length >= 3 && !SEARCH_NOISE_WORDS.has(t))
    .slice(0, 5);
  const personTokens = normSearchText(personName || "")
    .split(" ")
    .filter((t) => t.length >= 3 && !SEARCH_NOISE_WORDS.has(t))
    .slice(0, 4);
  const cityNorm = normSearchText(cidade || "");
  const ufNorm = normSearchText(uf || "");

  const scoreResults = (results: SearchResult[], scores: Map<string, number>, requirePersonMatch = false) => {
    for (const r of results) {
      const combined = `${r.title} ${r.snippet} ${r.url}`;
      const cnpjs = extractCnpjsFromText(combined);
      if (cnpjs.length === 0) continue;

      const haystack = normSearchText(combined);
      const tokenHits = nameTokens.filter((t) => haystack.includes(t)).length;
      const personHits = personTokens.filter((t) => haystack.includes(t)).length;

      if (requirePersonMatch) {
        if (personTokens.length >= 2 && personHits < 2) continue;
        if (personTokens.length === 1 && personHits === 0) continue;
      } else if (nameTokens.length > 0 && tokenHits === 0 && personHits < 2) {
        continue;
      }

      let score = Math.max(tokenHits * 10, personHits * 12);
      if (cityNorm && haystack.includes(cityNorm)) score += 15;
      if (ufNorm && new RegExp(`\\b${ufNorm}\\b`).test(haystack)) score += 5;

      for (const cnpj of cnpjs) {
        const prev = scores.get(cnpj) ?? 0;
        if (score > prev) scores.set(cnpj, score);
      }
    }
  };

  try {
    const candidateScores = new Map<string, number>();

    if (queryName.length >= 3) {
      const query = `${queryName} ${locationPart} CNPJ`.trim();
      const results = await searchFn(query, 6);
      if (Array.isArray(results) && results.length > 0) {
        scoreResults(results, candidateScores, false);
      }
    }

    // Busca reversa por pessoa física ("Dra. Nome Sobrenome" / assinatura do dono) quando busca por nome fantasia não retorna CNPJ
    if (candidateScores.size === 0 && personName && personTokens.length >= 2) {
      const personQuery = `"${personName}" ${locationPart} CNPJ socio`.trim();
      const personResults = await searchFn(personQuery, 6);
      if (Array.isArray(personResults) && personResults.length > 0) {
        scoreResults(personResults, candidateScores, true);
      }
    }

    return Array.from(candidateScores.entries())
      .filter(([, score]) => score >= 10)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([cnpj]) => cnpj);
  } catch {
    return [];
  }
}

/**
 * Descobre o melhor CNPJ candidato na web via busca gratuita quando o lead não tem domínio .br nem CNPJ no HTML.
 */
export async function discoverCnpjViaWebSearch(
  leadName: string,
  cidade?: string,
  uf?: string,
  searchFn: SearchLike = webSearch,
): Promise<string | null> {
  const candidates = await discoverCnpjsViaWebSearch(leadName, cidade, uf, searchFn);
  return candidates[0] ?? null;
}

function calcYearsActive(dataInicio?: string): number | undefined {
  if (!dataInicio) return undefined;
  const parsed = Date.parse(dataInicio);
  if (!Number.isFinite(parsed)) return undefined;
  const years = (Date.now() - parsed) / (365.25 * 24 * 60 * 60 * 1000);
  if (years < 0 || years > 200) return undefined;
  return Math.floor(years);
}

function normalizeBrasilApiOrMinhaReceita(
  raw: Record<string, unknown>,
  cnpj: string,
  source: CnpjSource,
  tenantId = GLOBAL_TENANT_SCOPE,
): CnpjEnrichmentResult {
  const situacaoRaw = String(raw.descricao_situacao_cadastral || raw.situacao_cadastral || "").trim();
  const situacaoUpper = situacaoRaw.toUpperCase();
  const situacaoCode = Number(raw.situacao_cadastral);
  const isAtiva = situacaoUpper === "ATIVA" || situacaoCode === 2;

  const isMei = raw.opcao_pelo_mei === true || /MEI/i.test(String(raw.porte || ""));
  const porte = isMei
    ? "MEI"
    : String(raw.porte || raw.descricao_porte || "").trim() || "Não informado";

  const qsaRaw = Array.isArray(raw.qsa) ? raw.qsa : [];
  const socios: CnpjPartner[] = [];
  for (const item of qsaRaw) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const nome = String(p.nome_socio || p.nome || "").trim();
    if (!nome) continue;
    socios.push({
      nome,
      qualificacao: String(p.qualificacao_socio || p.qualificacao || "").trim(),
      faixaEtaria: typeof p.faixa_etaria === "string" ? p.faixa_etaria : undefined,
    });
  }

  const telefones: string[] = [];
  for (const field of [raw.ddd_telefone_1, raw.ddd_telefone_2]) {
    const normalized = normalizeBrPhoneDigits(String(field || ""));
    if (normalized && !telefones.includes(normalized)) {
      telefones.push(normalized);
      recordPhoneCnpjRoot(normalized, cnpj, tenantId);
    }
  }

  const razaoSocial = String(raw.razao_social || "").trim();
  const partner = pickManagingPartner(socios, razaoSocial, isMei);
  const dataInicio = typeof raw.data_inicio_atividade === "string" ? raw.data_inicio_atividade : undefined;
  const rawEmail = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : undefined;
  if (rawEmail) recordEmailCnpjRoot(rawEmail, cnpj, tenantId);
  const cnaeDescricao =
    typeof raw.cnae_fiscal_descricao === "string" && raw.cnae_fiscal_descricao.trim()
      ? raw.cnae_fiscal_descricao.trim()
      : undefined;

  return {
    cnpj,
    razaoSocial,
    nomeFantasia: typeof raw.nome_fantasia === "string" ? raw.nome_fantasia.trim() : undefined,
    situacaoCadastral: situacaoRaw || (isAtiva ? "ATIVA" : "DESCONHECIDA"),
    isAtiva,
    isMei,
    porte,
    capitalSocial: Number(raw.capital_social) || 0,
    dataInicioAtividade: dataInicio,
    anosEmpresa: calcYearsActive(dataInicio),
    municipio: typeof raw.municipio === "string" ? raw.municipio.trim() : undefined,
    uf: typeof raw.uf === "string" ? raw.uf.trim().toUpperCase() : undefined,
    cep: typeof raw.cep === "string" ? raw.cep.replace(/\D/g, "") : undefined,
    email: rawEmail,
    ...(cnaeDescricao ? { cnaeDescricao } : {}),
    telefonesReceita: telefones,
    socioDecisor: partner?.fullName,
    primeiroNomeSocio: partner?.firstName,
    ...(partner?.faixaEtaria ? { faixaEtariaSocio: partner.faixaEtaria } : {}),
    socios,
    source,
  };
}

function normalizeOpenCnpj(
  raw: Record<string, unknown>,
  cnpj: string,
  source: CnpjSource,
  tenantId = GLOBAL_TENANT_SCOPE,
): CnpjEnrichmentResult {
  const situacaoRaw = String(raw.situacao_cadastral || "").trim();
  const isAtiva = situacaoRaw.toUpperCase() === "ATIVA";
  const porteRaw = String(raw.porte_empresa || raw.porte || "").trim();
  const opcaoMei = String(raw.opcao_mei || "").toUpperCase();
  const isMei = opcaoMei === "S" || raw.opcao_mei === true || /MEI/i.test(porteRaw);
  const porte = isMei ? "MEI" : porteRaw || "Não informado";

  const qsaRaw = Array.isArray(raw.QSA) ? raw.QSA : (Array.isArray(raw.qsa) ? raw.qsa : []);
  const socios: CnpjPartner[] = [];
  for (const item of qsaRaw) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const nome = String(p.nome_socio || p.nome || "").trim();
    if (!nome) continue;
    socios.push({
      nome,
      qualificacao: String(p.qualificacao_socio || p.qualificacao || "").trim(),
      faixaEtaria: typeof p.faixa_etaria === "string" ? p.faixa_etaria : undefined,
    });
  }

  const telefones: string[] = [];
  const telList = Array.isArray(raw.telefones) ? raw.telefones : [];
  for (const telItem of telList) {
    if (!telItem || typeof telItem !== "object") continue;
    const tObj = telItem as Record<string, unknown>;
    const combined = `${String(tObj.ddd || "")}${String(tObj.numero || "")}`;
    const normalized = normalizeBrPhoneDigits(combined);
    if (normalized && !telefones.includes(normalized)) {
      telefones.push(normalized);
      recordPhoneCnpjRoot(normalized, cnpj, tenantId);
    }
  }

  const razaoSocial = String(raw.razao_social || "").trim();
  const partner = pickManagingPartner(socios, razaoSocial, isMei);
  const dataInicio = typeof raw.data_inicio_atividade === "string" ? raw.data_inicio_atividade : undefined;
  const capitalParsed =
    typeof raw.capital_social === "string"
      ? Number(raw.capital_social.replace(/\./g, "").replace(",", "."))
      : Number(raw.capital_social);
  const rawEmail = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : undefined;
  if (rawEmail) recordEmailCnpjRoot(rawEmail, cnpj, tenantId);
  const cnaeDescricao =
    typeof raw.cnae_principal_descricao === "string" && raw.cnae_principal_descricao.trim()
      ? raw.cnae_principal_descricao.trim()
      : typeof raw.descricao_cnae === "string" && raw.descricao_cnae.trim()
        ? raw.descricao_cnae.trim()
        : undefined;

  return {
    cnpj,
    razaoSocial,
    nomeFantasia: typeof raw.nome_fantasia === "string" ? raw.nome_fantasia.trim() : undefined,
    situacaoCadastral: situacaoRaw || (isAtiva ? "ATIVA" : "DESCONHECIDA"),
    isAtiva,
    isMei,
    porte,
    capitalSocial: Number.isFinite(capitalParsed) ? capitalParsed : 0,
    dataInicioAtividade: dataInicio,
    anosEmpresa: calcYearsActive(dataInicio),
    municipio: typeof raw.municipio === "string" ? raw.municipio.trim() : undefined,
    uf: typeof raw.uf === "string" ? raw.uf.trim().toUpperCase() : undefined,
    cep: typeof raw.cep === "string" ? raw.cep.replace(/\D/g, "") : undefined,
    email: rawEmail,
    ...(cnaeDescricao ? { cnaeDescricao } : {}),
    telefonesReceita: telefones,
    socioDecisor: partner?.fullName,
    primeiroNomeSocio: partner?.firstName,
    ...(partner?.faixaEtaria ? { faixaEtariaSocio: partner.faixaEtaria } : {}),
    socios,
    source,
  };
}

/**
 * Consulta gratuita de CNPJ em cascata sem necessidade de API key:
 * BrasilAPI → OpenCNPJ → Minha Receita (com cache LRU em memória).
 */
export async function lookupCnpjFreeCascade(
  rawCnpj: string,
  source: CnpjSource = "site_html",
  fetchImpl: FetchLike = fetch,
  tenantId = GLOBAL_TENANT_SCOPE,
): Promise<CnpjEnrichmentResult | null> {
  const cnpj = String(rawCnpj || "").replace(/\D/g, "");
  if (!isValidCnpj(cnpj)) return null;

  if (cnpjDataCache.has(cnpj)) {
    const cached = cnpjDataCache.get(cnpj);
    if (cached) {
      for (const tel of cached.telefonesReceita) {
        recordPhoneCnpjRoot(tel, cnpj, tenantId);
      }
      return { ...cached, source };
    }
    return null;
  }

  const providers: Array<{
    name: string;
    url: string;
    parse: (json: Record<string, unknown>) => CnpjEnrichmentResult;
  }> = [
    {
      name: "brasilapi",
      url: `https://brasilapi.com.br/api/cnpj/v1/${cnpj}`,
      parse: (j) => normalizeBrasilApiOrMinhaReceita(j, cnpj, source, tenantId),
    },
    {
      name: "opencnpj",
      url: `https://api.opencnpj.org/${cnpj}`,
      parse: (j) => normalizeOpenCnpj(j, cnpj, source, tenantId),
    },
    {
      name: "minhareceita",
      url: `https://minhareceita.org/${cnpj}`,
      parse: (j) => normalizeBrasilApiOrMinhaReceita(j, cnpj, source, tenantId),
    },
  ];

  for (const p of providers) {
    try {
      const res = await fetchImpl(p.url, {
        method: "GET",
        signal: AbortSignal.timeout(CNPJ_TIMEOUT_MS),
        headers: { Accept: "application/json" },
      });
      if (!res.ok) {
        await res.body?.cancel?.().catch(() => {});
        continue;
      }
      const data: unknown = await res.json().catch(() => null);
      if (!data || typeof data !== "object" || Array.isArray(data)) continue;
      const obj = data as Record<string, unknown>;
      if (!obj.razao_social && !obj.cnpj) continue;
      const normalized = p.parse(obj);
      setLru(cnpjDataCache, cnpj, normalized, MAX_CACHE_ENTRIES);
      return normalized;
    } catch {
      // Tenta o próximo provider gratuito
    }
  }

  return null;
}

/**
 * Validação cruzada para CNPJs descobertos via Web Search (evita falso-positivo homônimo).
 */
export function isCnpjMatchingLead(
  cnpjData: CnpjEnrichmentResult,
  leadName: string,
  cidade?: string,
  uf?: string,
  extra?: { cep?: string; phone?: string; personName?: string },
): boolean {
  if (cnpjData.source === "site_html" || cnpjData.source === "rdap_br") {
    return true;
  }

  const ufClean = String(uf || "").trim().toUpperCase();
  if (ufClean && cnpjData.uf && cnpjData.uf !== ufClean) {
    return false;
  }

  const leadPhone = extra?.phone ? normalizeBrPhoneDigits(extra.phone) : "";
  const leadPhoneModern = leadPhone ? toModern13DigitBrMobile(leadPhone) : "";
  if (
    leadPhone &&
    cnpjData.telefonesReceita.some((t) => t === leadPhone || toModern13DigitBrMobile(t) === leadPhoneModern)
  ) {
    return true;
  }

  const leadCep = String(extra?.cep || "").replace(/\D/g, "");
  const receitCep = String(cnpjData.cep || "").replace(/\D/g, "");
  if (leadCep.length >= 5 && receitCep.length >= 5 && leadCep.slice(0, 5) === receitCep.slice(0, 5)) {
    return true;
  }

  const cityClean = normSearchText(cidade || "");
  const receitCity = normSearchText(cnpjData.municipio || "");
  const cityMatches = !cityClean || !receitCity || receitCity.includes(cityClean) || cityClean.includes(receitCity);

  const corpNames = normSearchText(`${cnpjData.razaoSocial} ${cnpjData.nomeFantasia || ""}`);
  const LEAD_MATCH_GENERIC_WORDS = new Set([
    "ltda", "eireli", "clinica", "centro", "loja", "consultorio", "instituto",
    "espaco", "studio", "salao", "barbearia", "estetica", "avancada", "integrada",
    "saude", "odontologia", "odonto", "implantes", "harmonizacao", "facial", "corporal",
    "fisioterapia", "psicologia", "nutricao", "dermatologia", "medica", "medico",
    "dentista", "dra", "dr", "prof",
  ]);
  const leadTokens = normSearchText(cleanLeadNameForSearch(leadName) || leadName)
    .split(" ")
    .filter((t) => t.length >= 3 && !LEAD_MATCH_GENERIC_WORDS.has(t));

  const nameMatches = leadTokens.length === 0 || leadTokens.some((t) => corpNames.includes(t));

  const personTokens = extra?.personName
    ? normSearchText(extra.personName)
        .split(" ")
        .filter((t) => t.length >= 3 && !SEARCH_NOISE_WORDS.has(t))
    : [];

  let partnerMatchesPerson = false;
  if (personTokens.length >= 2) {
    const partnerText = normSearchText(
      `${(cnpjData.socios || []).map((s) => s.nome).join(" ")} ${cnpjData.razaoSocial}`,
    );
    const hits = personTokens.filter((t) => partnerText.includes(t)).length;
    if (partnerText.includes(personTokens[0]) && hits >= 2) {
      partnerMatchesPerson = true;
    }
  }

  const isPersonBrandedLead =
    personTokens.length >= 2 &&
    (leadTokens.length === 0 || leadTokens.every((t) => personTokens.includes(t)));

  if (isPersonBrandedLead) {
    return cityMatches && partnerMatchesPerson;
  }

  return cityMatches && (leadTokens.length > 0 ? nameMatches || partnerMatchesPerson : partnerMatchesPerson || corpNames.length > 0);
}

const KNOWN_FRANCHISE_CHAINS: ReadonlyArray<string> = [
  "odontocompany",
  "oral unic",
  "oral sin",
  "sorridents",
  "dentista do povo",
  "amorsaude",
  "amor saude",
  "cartao de todos",
  "dr consulta",
  "espacolaser",
  "espaco laser",
  "giolaser",
  "maislaser",
  "royal face",
  "botoclinic",
  "magrass",
  "smart fit",
  "bluefit",
  "skyfit",
  "panobianco",
  "wizard",
  "ccaa",
  "fisk",
  "kumon",
  "knn idiomas",
  "cacau show",
  "o boticario",
  "drogasil",
  "droga raia",
  "pague menos",
  "drogaria sao paulo",
  "ultrafarma",
  "localiza",
  "movida",
  "unidas",
  "chiquinho sorvetes",
  "sodie doces",
];

/**
 * Identifica grandes redes nacionais / franquias e sociedades anônimas que não compram site autônomo local.
 */
export function detectFranchiseOrChain(input: {
  name: string;
  website?: string;
  razaoSocial?: string;
  capitalSocial?: number;
}): { isFranchise: boolean; reason: string } {
  const rawName = String(input.name || "");
  if (/\bre\/?max\b/i.test(rawName)) {
    return { isFranchise: true, reason: "Franquia/Rede nacional (RE/MAX)" };
  }
  const haystack = normSearchText(`${rawName} ${input.razaoSocial || ""}`);
  for (const chain of KNOWN_FRANCHISE_CHAINS) {
    const escaped = chain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^| )${escaped}(?:$| )`).test(haystack)) {
      return { isFranchise: true, reason: `Franquia/Rede nacional (${chain})` };
    }
  }
  if (input.website && /\/(?:unidades|franquias|filiais)(?:\/|\?|$)/i.test(input.website)) {
    return { isFranchise: true, reason: "Site institucional de rede/franquia" };
  }
  if (input.razaoSocial && /\b(?:S\/A|S\.A\.|SOCIEDADE\s+ANONIMA)\b/i.test(input.razaoSocial)) {
    return { isFranchise: true, reason: "Sociedade Anônima (S/A)" };
  }
  if (typeof input.capitalSocial === "number" && input.capitalSocial >= 5_000_000) {
    return { isFranchise: true, reason: "Empresa de grande porte (capital >= R$ 5M)" };
  }
  return { isFranchise: false, reason: "" };
}

const PT_UF_CODE_SET = new Set([
  "ac", "al", "ap", "am", "ba", "ce", "df", "es", "go", "ma", "mt", "ms", "mg",
  "pa", "pb", "pr", "pe", "pi", "rj", "rn", "rs", "ro", "rr", "sc", "sp", "se", "to",
]);

/**
 * Extrai um nome curto e natural da empresa para o 1º contato e abordagem humana no WhatsApp.
 */
export function extractShortCompanyName(rawName: string, cidade?: string): string {
  return cleanShortCompanyName(rawName, cidade);
}

const MAPS_UI_SERVICE_NOISE_RE = /^(?:salvos?|recentes?|baixar o aplicativo|compartilhar|rotas?|salvar|enviar para|reivindicar|vis[aã]o geral|avalia[çc][õo]es|sobre|fotos|fechado|aberto agora|aberto 24 horas|outros hor[aá]rios)$/i;

/**
 * Remove ícones PUA (\uE000-\uF8FF), horários e botões de UI do Google Maps de `services[]`
 * e retorna o serviço/especialidade principal limpa do negócio.
 */
export function cleanGoogleServicesList(
  rawServices: unknown,
  categories?: string,
  rawName?: string,
): { cleanList: string[]; mainService: string } {
  const items: string[] = Array.isArray(rawServices)
    ? rawServices.map((s) => String(s || ""))
    : typeof rawServices === "string"
      ? rawServices.split(/[,|\n]/)
      : [];

  const cleanList: string[] = [];
  const seen = new Set<string>();

  for (const raw of items) {
    const cleaned = raw
      .replace(/[\uE000-\uF8FF]/g, "")
      .replace(/^[\s·•\-–—]+|[\s·•\-–—]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!cleaned || cleaned.length < 3 || /^\d+$/.test(cleaned)) continue;
    if (MAPS_UI_SERVICE_NOISE_RE.test(cleaned)) continue;
    if (/^\d{1,2}[:h]\d{2}(?:\s*[–\-aà]\s*\d{1,2}[:h]\d{2})?$/i.test(cleaned)) continue;
    if (/^(?:dom|seg|ter|qua|qui|sex|s[aá]b)(?:\.|\s|$)/i.test(cleaned)) continue;

    const key = cleaned.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      cleanList.push(cleaned);
    }
    if (cleanList.length >= 15) break;
  }

  let subtitleService = "";
  if (rawName) {
    const segs = String(rawName)
      .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]+/gu, " ")
      .split(/\s*(?:\||–|—|•|\s+-\s+)\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const seg of segs.slice(1)) {
      const normSeg = normSearchText(seg);
      if (!normSeg || normSeg.length < 4) continue;
      if (PT_UF_CODE_SET.has(normSeg)) continue;
      if (/^[a-z ]+\s+(?:ac|al|ap|am|ba|ce|df|es|go|ma|mt|ms|mg|pa|pb|pr|pe|pi|rj|rn|rs|ro|rr|sc|sp|se|to)$/.test(normSeg)) continue;
      subtitleService = seg;
      break;
    }
  }

  const firstCat = String(categories || "")
    .split(",")[0]
    ?.replace(/[\uE000-\uF8FF]/g, "")
    .trim() || "";

  const mainService = subtitleService || cleanList[0] || firstCat;
  return { cleanList, mainService };
}

/**
 * Classifica o canal de atendimento do WhatsApp encontrado (Sócio Direto vs. Recepção/Secretária)
 * e se o proprietário responde avaliações no Google Maps.
 */
export function detectReceptionistSignals(input: {
  categories?: string;
  reviews?: ReadonlyArray<{ texto?: string; respostaDono?: string }>;
  businessProfileDescription?: string;
  isBusinessWhatsApp?: boolean;
  whatsappSource?: WhatsAppSource;
  hasIdentifiedSocio?: boolean;
  isMei?: boolean;
  sociosCount?: number;
}): {
  hasReceptionist: boolean;
  ownerActiveOnMaps: boolean;
  channelType: WhatsAppChannelType;
} {
  const reviews = Array.isArray(input.reviews) ? input.reviews : [];
  const ownerActiveOnMaps = reviews.some(
    (r) =>
      Boolean(r.respostaDono && r.respostaDono.trim()) ||
      /Resposta do propriet[aá]rio|Response from the owner/i.test(r.texto || ""),
  );

  const receptionistInReviews = reviews.some((r) =>
    /\b(?:recep[çc][aã]o|recepcionistas?|secret[aá]ri[ao]s?|atendentes?|triagem)\b|contato virtual|meninas da recep/i.test(
      r.texto || "",
    ),
  );
  const receptionistInProfile = /\b(?:recep[çc][aã]o|agendamentos?|marque sua consulta|central de atendimento|sac|hor[aá]rio de atendimento|secret[aá]ri[ao])\b/i.test(
    input.businessProfileDescription || "",
  );
  const categoryImpliesReception =
    input.isBusinessWhatsApp === true &&
    /\b(?:cl[ií]nica|odont|m[eé]dic|est[eé]tic|hospital|laborat|advoc|escrit[oó]rio|imobili[aá]ria|concession[aá]ria)\b/i.test(
      input.categories || "",
    );

  const hasReceptionist = Boolean(
    receptionistInReviews || receptionistInProfile || categoryImpliesReception,
  );

  let channelType: WhatsAppChannelType = "indefinido";
  if (input.whatsappSource === "cnpj_socio" || input.whatsappSource === "socio_web") {
    channelType = "socio_direto";
  } else if (input.isBusinessWhatsApp === false && input.hasIdentifiedSocio) {
    channelType = "socio_direto";
  } else if (
    hasReceptionist &&
    (input.whatsappSource === "google_maps" || input.whatsappSource === "website_wame" || !input.whatsappSource)
  ) {
    channelType = "recepcao_comercial";
  } else if (
    input.isMei === true ||
    ((input.sociosCount ?? 0) === 1 &&
      !hasReceptionist &&
      /\b(?:vidra[çc]aria|marcenaria|esquadrias|serralheria|m[oó]veis|est[eé]tica|eletricista|encanador|gesso|pedreiro|pintor)\b/i.test(
        input.categories || "",
      ))
  ) {
    channelType = "provavel_socio";
  }

  return { hasReceptionist, ownerActiveOnMaps, channelType };
}

/**
 * Busca web gratuita focada no nome completo do sócio-administrador para localizar celular direto quando a Receita não tiver.
 */
export async function discoverPartnerDirectPhonesViaWeb(
  socioDecisor: string,
  cidade?: string,
  uf?: string,
  mapsPhoneDigits?: string,
  searchFn: SearchLike = webSearch,
): Promise<string[]> {
  const words = normSearchText(socioDecisor)
    .split(" ")
    .filter((w) => w.length >= 2 && !PT_BR_PREPOSITIONS.has(w));
  if (words.length < 2) return [];

  const firstWord = words[0];
  const lastWord = words[words.length - 1];
  const locationPart = [cidade, uf].filter(Boolean).join(" ");
  const cacheKey = `${normSearchText(socioDecisor)}|${normSearchText(locationPart)}`;

  const cached = partnerPhoneSearchCache.get(cacheKey);
  if (cached) {
    const mapsModern = mapsPhoneDigits ? toModern13DigitBrMobile(mapsPhoneDigits) : "";
    return cached.filter((p) => p !== mapsModern && p !== mapsPhoneDigits);
  }

  const query = `"${socioDecisor}" ${locationPart} whatsapp OR celular OR telefone`.trim();
  const mapsModern = mapsPhoneDigits ? toModern13DigitBrMobile(mapsPhoneDigits) : "";
  const mapsDdd = mapsModern.length >= 4 ? mapsModern.slice(2, 4) : "";

  try {
    const results = await searchFn(query, 5);
    if (!Array.isArray(results) || results.length === 0) {
      setLru(partnerPhoneSearchCache, cacheKey, [], MAX_CACHE_ENTRIES);
      return [];
    }

    const found: string[] = [];
    const phonePattern = /(?:\+?55\s?)?(?:\(?\d{2}\)?\s?)9\s?\d{4}[-\s.]?\d{4}/g;

    for (const r of results) {
      const combined = `${r.title} ${r.snippet} ${r.url}`;
      const norm = normSearchText(combined);
      if (!norm.includes(firstWord) || !norm.includes(lastWord)) continue;

      const waNumbers = extractWhatsAppPhonesFromHtml(combined);
      const rawMatches = combined.match(phonePattern) || [];
      const parsedMatches = rawMatches.map((m) => normalizeBrPhoneDigits(m)).filter(Boolean);

      for (const candidate of [...waNumbers, ...parsedMatches]) {
        const modern = toModern13DigitBrMobile(candidate);
        if (!isBrMobileDigits(modern)) continue;
        if (mapsDdd && modern.slice(2, 4) !== mapsDdd) continue;
        if (modern === mapsModern || modern === mapsPhoneDigits) continue;
        if (!found.includes(modern)) found.push(modern);
        if (found.length >= 2) break;
      }
      if (found.length >= 2) break;
    }

    setLru(partnerPhoneSearchCache, cacheKey, found, MAX_CACHE_ENTRIES);
    return found;
  } catch {
    return [];
  }
}

export function computeLeadQualificationScore(input: {
  siteAudit: SiteAuditResult;
  cnpjResult: CnpjEnrichmentResult | null;
  reviewCount?: string;
  averageRating?: string;
  claimed?: boolean;
  hasPartnerWhatsApp?: boolean;
  ownerActiveOnMaps?: boolean;
  hasReceptionist?: boolean;
  objective?: QualificationObjective;
}): { score: number; reasons: string[] } {
  const objective: QualificationObjective = input.objective || "site_sales";
  let score = 30;
  const reasons: string[] = [];

  const siteQuality = input.siteAudit.siteQualityScore;

  if (objective === "ai_automation") {
    if (input.siteAudit.status === "active_site") {
      const highQuality = siteQuality !== undefined && siteQuality >= 75;
      score += highQuality ? 22 : 18;
      reasons.push(highQuality ? "Presença digital estruturada p/ IA" : "Site ativo para atendimento IA");
    } else if (input.siteAudit.status === "weak_site") {
      score += 13;
      reasons.push(`Canal digital com gargalo (${input.siteAudit.statusLabel})`);
    } else if (input.siteAudit.status === "broken_site") {
      score += 8;
      reasons.push(`Site com falha (${input.siteAudit.statusLabel})`);
    } else {
      score += 6;
      reasons.push("Operação via Maps/WhatsApp sem site");
    }

    if (input.siteAudit.hasPaidTrafficTag) {
      score += 12;
      reasons.push("Investe em tráfego pago (alta demanda p/ IA)");
    }

    if ((input.siteAudit.managementTools?.length ?? 0) > 0) {
      score += 8;
      reasons.push(`Usa sistemas (${input.siteAudit.managementTools!.slice(0, 2).join(", ")})`);
    }

    if (input.hasReceptionist) {
      score += 6;
      reasons.push("Recepção/triagem identificada");
    }
  } else if (objective === "general") {
    if (input.siteAudit.status === "active_site") {
      score += 14;
      reasons.push("Site ativo");
    } else if (input.siteAudit.status === "weak_site" || input.siteAudit.status === "broken_site") {
      score += 14;
      reasons.push(input.siteAudit.statusLabel);
    } else {
      score += 10;
      reasons.push("Sem site próprio");
    }

    if (input.siteAudit.hasPaidTrafficTag) {
      score += 8;
      reasons.push("Investe em anúncios online");
    }

    if ((input.siteAudit.managementTools?.length ?? 0) > 0) {
      score += 6;
      reasons.push(`Usa sistemas (${input.siteAudit.managementTools!.slice(0, 2).join(", ")})`);
    }
  } else {
    // Objetivo "site_sales" (preserva baseline broken_site = 58 e com Ads = 65)
    if (input.siteAudit.status === "broken_site") {
      score += 28;
      reasons.push(`Site com falha (${input.siteAudit.statusLabel})`);
    } else if (input.siteAudit.status === "weak_site") {
      score += 18;
      reasons.push(`Site fraco (${input.siteAudit.statusLabel})`);
    } else if (input.siteAudit.status === "no_site") {
      score += 14;
      reasons.push(
        input.siteAudit.issueCode === "third_party_platform"
          ? "Depende de plataforma de terceiros (sem site próprio)"
          : "Sem site profissional",
      );
    } else {
      const highQuality = siteQuality !== undefined && siteQuality >= 80;
      score += highQuality ? 4 : 8;
      reasons.push(highQuality ? "Site já bem estruturado" : "Site ativo com margem de melhoria");
    }

    if (
      input.siteAudit.hasPaidTrafficTag &&
      (input.siteAudit.status === "broken_site" || input.siteAudit.status === "weak_site")
    ) {
      score += 7;
      reasons.push("Anuncia online com site precário");
    }

    if ((input.siteAudit.managementTools?.length ?? 0) > 0) {
      score += 6;
      reasons.push(`Usa sistemas (${input.siteAudit.managementTools!.slice(0, 2).join(", ")})`);
    }

    if (input.siteAudit.abandonedCopyrightYear) {
      score += 4;
      reasons.push(`Copyright desatualizado (${input.siteAudit.abandonedCopyrightYear})`);
    }
  }

  const reviews = parseInt(String(input.reviewCount || "0").replace(/\D/g, ""), 10) || 0;
  const rating = parseFloat(String(input.averageRating || "0").replace(",", ".")) || 0;

  if (objective === "ai_automation") {
    if (reviews >= 100) {
      score += 18;
      reasons.push(`${reviews} avaliações no Google (alto volume)`);
    } else if (reviews >= 40) {
      score += 13;
      reasons.push(`${reviews} avaliações no Google`);
    } else if (reviews >= 15) {
      score += 8;
    }
  } else {
    if (reviews >= 50) {
      score += 12;
      reasons.push(`${reviews} avaliações no Google`);
    } else if (reviews >= 15) {
      score += 6;
    }
  }
  if (rating >= 4.4) {
    score += 6;
    reasons.push(`Nota ${rating.toFixed(1)}★`);
  }
  if (input.claimed) {
    score += 4;
  }
  if (input.ownerActiveOnMaps) {
    score += 4;
    reasons.push("Dono responde avaliações");
  }

  if (input.cnpjResult) {
    if (input.cnpjResult.isAtiva) {
      score += 8;
    } else {
      score -= 30;
      reasons.push(`CNPJ ${input.cnpjResult.situacaoCadastral}`);
    }

    if (!input.cnpjResult.isMei) {
      score += 8;
      reasons.push(`Porte ${input.cnpjResult.porte}`);
    }
    if (input.cnpjResult.capitalSocial >= 30000) {
      score += 7;
      reasons.push(`Capital social R$ ${Math.round(input.cnpjResult.capitalSocial).toLocaleString("pt-BR")}`);
    }
    if ((input.cnpjResult.anosEmpresa ?? 0) >= 2) {
      score += 5;
      reasons.push(`${input.cnpjResult.anosEmpresa}+ anos de CNPJ`);
    }
    if (input.cnpjResult.socioDecisor) {
      score += 6;
      reasons.push(`Sócio decisor: ${input.cnpjResult.primeiroNomeSocio || input.cnpjResult.socioDecisor}`);
    }
  }

  if (input.hasPartnerWhatsApp) {
    score += 8;
    reasons.push("WhatsApp direto localizado");
  }

  return {
    score: Math.max(0, Math.min(100, score)),
    reasons,
  };
}

/**
 * Executa o pipeline completo de auditoria do site, descoberta de CNPJ/sócio e
 * resolução de WhatsApp (usando apenas APIs públicas gratuitas + Evolution local).
 */
export async function enrichCapturedLead(input: EnrichLeadInput): Promise<EnrichLeadOutput> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const tenantId = input.tenantId || GLOBAL_TENANT_SCOPE;
  const mapsPhoneDigits = normalizeBrPhoneDigits(input.phone);
  const mapsPhoneModern = mapsPhoneDigits ? toModern13DigitBrMobile(mapsPhoneDigits) : "";
  const mapsWaCandidates = extractWhatsAppPhonesFromHtml(input.mapsWhatsAppUrl || "");

  const preSiteClass = classifyNonOwnWebsiteUrl(input.website);
  let siteAudit: SiteAuditResult = input.precomputedSiteAudit || (
    preSiteClass === "social_link_only"
      ? {
          status: "no_site",
          issueCode: "social_link_only",
          statusLabel: "Só rede social/WhatsApp",
          diagnosticoComercial: "usando apenas link de rede social em vez de site profissional",
          extractedWhatsApps: extractWhatsAppPhonesFromHtml(input.website || ""),
          extractedCnpjs: [],
          extractedInstagram: extractInstagramFromHtml(input.website || ""),
          siteQualityScore: 10,
        }
      : preSiteClass === "third_party_platform"
        ? {
            status: "no_site",
            issueCode: "third_party_platform",
            statusLabel: "Só plataforma de terceiros",
            diagnosticoComercial: "usando apenas cardápio/agenda de terceiros sem site profissional próprio",
            extractedWhatsApps: extractWhatsAppPhonesFromHtml(input.website || ""),
            extractedCnpjs: [],
            siteQualityScore: 15,
          }
        : {
            status: input.website ? "active_site" : "no_site",
            statusLabel: input.website ? "Site informado" : "Sem site",
            diagnosticoComercial: input.website ? "" : "sem site cadastrado no Google Maps",
            extractedWhatsApps: [],
            extractedCnpjs: [],
          }
  );

  let rdapInfo: RdapCacheEntry = { cnpj: null, frozen: false };

  const shouldAuditSite =
    !input.precomputedSiteAudit && (input.options.auditSiteHealth || input.options.prioritizePartnerPhone);
  const shouldLookupRdap = input.options.enrichCnpj && !!input.website && getHostname(input.website).endsWith(".br");
  const extractedPersonName = extractPersonNameFromLeadSignals({
    ownerName: input.ownerName,
    leadName: input.name,
    reviews: input.reviews,
  });

  const [auditOut, rdapOut] = await Promise.all([
    shouldAuditSite ? auditLeadWebsite(input.website, fetchImpl) : Promise.resolve(siteAudit),
    shouldLookupRdap ? lookupRdapBrDomain(input.website, fetchImpl) : Promise.resolve(rdapInfo),
  ]);
  siteAudit = auditOut;
  rdapInfo = rdapOut;

  // 1-hop real domain resolution quando Maps apontou link-in-bio (linktr.ee, bio.site, beacons.ai, etc.)
  if (siteAudit.discoveredRealWebsite && !input.precomputedSiteAudit) {
    const bioUrl = siteAudit.discoveredRealWebsite;
    const realShouldRdap = input.options.enrichCnpj && getHostname(bioUrl).endsWith(".br");
    const [realAudit, realRdap] = await Promise.all([
      shouldAuditSite ? auditLeadWebsite(bioUrl, fetchImpl) : Promise.resolve<SiteAuditResult | null>(null),
      realShouldRdap ? lookupRdapBrDomain(bioUrl, fetchImpl) : Promise.resolve<RdapCacheEntry>({ cnpj: null, frozen: false }),
    ]);
    if (realAudit) {
      const mergedWhatsApps = Array.from(new Set([...siteAudit.extractedWhatsApps, ...realAudit.extractedWhatsApps]));
      const mergedCnpjs = Array.from(new Set([...siteAudit.extractedCnpjs, ...realAudit.extractedCnpjs]));
      const mergedEmails = Array.from(new Set([...(siteAudit.extractedEmails || []), ...(realAudit.extractedEmails || [])]));
      const mergedTags = Array.from(new Set([...(siteAudit.trafficTags || []), ...(realAudit.trafficTags || [])]));
      const mergedTools = Array.from(new Set([...(siteAudit.managementTools || []), ...(realAudit.managementTools || [])]));
      siteAudit = {
        ...realAudit,
        discoveredRealWebsite: bioUrl,
        extractedWhatsApps: mergedWhatsApps,
        extractedCnpjs: mergedCnpjs,
        ...(mergedEmails.length > 0 ? { extractedEmails: mergedEmails } : {}),
        ...(realAudit.extractedInstagram || siteAudit.extractedInstagram
          ? { extractedInstagram: realAudit.extractedInstagram || siteAudit.extractedInstagram }
          : {}),
        ...(mergedTags.length > 0 ? { hasPaidTrafficTag: true, trafficTags: mergedTags } : {}),
        ...(mergedTools.length > 0 ? { managementTools: mergedTools } : {}),
        ...(realAudit.abandonedCopyrightYear || siteAudit.abandonedCopyrightYear
          ? { abandonedCopyrightYear: realAudit.abandonedCopyrightYear || siteAudit.abandonedCopyrightYear }
          : {}),
      };
    }
    if (realRdap.cnpj || realRdap.frozen) {
      rdapInfo = {
        cnpj: realRdap.cnpj || rdapInfo.cnpj,
        frozen: realRdap.frozen || rdapInfo.frozen,
      };
    }
  }

  if (rdapInfo.frozen && siteAudit.status !== "broken_site") {
    siteAudit = {
      ...siteAudit,
      status: "broken_site",
      issueCode: "domain_frozen",
      statusLabel: "Domínio congelado no Registro.br",
      diagnosticoComercial: "com domínio congelado/suspenso no Registro.br",
    };
  }

  let cnpjResult: CnpjEnrichmentResult | null = null;
  if (input.options.enrichCnpj) {
    const htmlCnpj = siteAudit.extractedCnpjs[0];
    if (rdapInfo.cnpj) {
      cnpjResult = await lookupCnpjFreeCascade(rdapInfo.cnpj, "rdap_br", fetchImpl, tenantId);
    }
    if (!cnpjResult && htmlCnpj) {
      cnpjResult = await lookupCnpjFreeCascade(htmlCnpj, "site_html", fetchImpl, tenantId);
    }
    if (!cnpjResult) {
      const cepHint =
        String(input.cep || "").replace(/\D/g, "") ||
        (String(input.fullAddress || "").match(/\b\d{5}-?\d{3}\b/)?.[0] || "").replace(/\D/g, "");
      const searchedCnpjs = await discoverCnpjsViaWebSearch(
        input.name,
        input.cidade,
        input.uf,
        input.searchFn,
        extractedPersonName,
      );
      let firstInactiveMatch: CnpjEnrichmentResult | null = null;
      for (const searchedCnpj of searchedCnpjs) {
        const candidate = await lookupCnpjFreeCascade(searchedCnpj, "web_search", fetchImpl, tenantId);
        if (
          candidate &&
          isCnpjMatchingLead(candidate, input.name, input.cidade, input.uf, {
            cep: cepHint,
            phone: mapsPhoneDigits,
            personName: extractedPersonName,
          })
        ) {
          if (candidate.isAtiva) {
            cnpjResult = candidate;
            break;
          }
          if (!firstInactiveMatch) firstInactiveMatch = candidate;
        }
      }
      if (!cnpjResult && firstInactiveMatch) {
        cnpjResult = firstInactiveMatch;
      }
    }
  }

  // Candidatos de telefone do CNPJ filtrando contadores / números repetidos
  const cnpjEmailLooksAccounting = !!(
    cnpjResult?.email && /contabil|contador|escritorio|assessoria/i.test(cnpjResult.email)
  );
  const receitaCandidates = (cnpjResult?.telefonesReceita || []).filter((tel) => {
    if (!tel || isLikelyAccountingPhone(tel, tenantId)) return false;
    if (cnpjEmailLooksAccounting && tel !== mapsPhoneDigits) return isEffectiveBrMobile(tel);
    return true;
  });

  const receitaMobileVariants: string[] = [];
  const rawReceitaMobile = receitaCandidates.find((tel) => {
    if (!isEffectiveBrMobile(tel)) return false;
    return toModern13DigitBrMobile(tel) !== mapsPhoneModern;
  });
  if (rawReceitaMobile) {
    for (const variant of expandBrPhoneCheckVariants(rawReceitaMobile)) {
      if (!receitaMobileVariants.includes(variant)) {
        receitaMobileVariants.push(variant);
      }
    }
  }
  const receitaMobile = receitaMobileVariants[0] || "";

  let socioWebPhones: string[] = [];
  if (
    input.options.huntPartnerDirectPhone &&
    !receitaMobile &&
    cnpjResult?.socioDecisor
  ) {
    socioWebPhones = await discoverPartnerDirectPhonesViaWeb(
      cnpjResult.socioDecisor,
      input.cidade,
      input.uf,
      mapsPhoneDigits,
      input.searchFn,
    );
  }

  // Monta ordem de candidatos para validação real na Evolution API:
  // Prioridade do modo "Direto no Dono": Celular CNPJ (9º dígito Anatel) -> Celular Sócio Web -> wa.me do site -> Google Maps -> Fixos CNPJ
  const candidatePriority: Array<{ digits: string; source: WhatsAppSource }> = [];
  const pushCandidate = (digits: string, source: WhatsAppSource) => {
    const clean = normalizeBrPhoneDigits(digits);
    if (!clean) return;
    if (!candidatePriority.some((c) => c.digits === clean)) {
      candidatePriority.push({ digits: clean, source });
    }
  };

  if (input.options.prioritizePartnerPhone) {
    for (const d of receitaMobileVariants) pushCandidate(d, "cnpj_socio");
    for (const d of socioWebPhones) pushCandidate(d, "socio_web");
    for (const d of siteAudit.extractedWhatsApps) pushCandidate(d, "website_wame");
    for (const d of mapsWaCandidates) pushCandidate(d, "website_wame");
  }
  if (mapsPhoneDigits) pushCandidate(mapsPhoneDigits, "google_maps");
  if (!input.options.prioritizePartnerPhone) {
    for (const d of receitaMobileVariants) pushCandidate(d, "cnpj_socio");
    for (const d of socioWebPhones) pushCandidate(d, "socio_web");
    for (const d of siteAudit.extractedWhatsApps) pushCandidate(d, "website_wame");
    for (const d of mapsWaCandidates) pushCandidate(d, "website_wame");
  }
  for (const d of receitaCandidates) {
    for (const variant of expandBrPhoneCheckVariants(d)) {
      pushCandidate(variant, "cnpj_socio");
    }
  }

  let bestPhone = mapsPhoneDigits || candidatePriority[0]?.digits || "";
  let bestRemoteJid = bestPhone ? `${bestPhone}@s.whatsapp.net` : "";
  let whatsappSource: WhatsAppSource = bestPhone && bestPhone === mapsPhoneDigits
    ? "google_maps"
    : candidatePriority[0]?.source || "google_maps";
  let whatsappVerified = false;
  let noActiveWhatsApp = false;
  let partnerWhatsAppFound =
    receitaMobile || socioWebPhones[0] || siteAudit.extractedWhatsApps[0] || "";
  let chosenBusinessProfile: { isBusiness: boolean; description?: string } | null = null;

  if (input.options.validateWhatsApp && input.checkWhatsAppFn && candidatePriority.length > 0) {
    try {
      const checkMap = await input.checkWhatsAppFn(candidatePriority.map((c) => c.digits));
      if (checkMap && Object.keys(checkMap).length > 0) {
        const verifiedHits: Array<{ digits: string; jid: string; source: WhatsAppSource }> = [];
        const seenJids = new Set<string>();
        let sawFalse = false;
        for (const cand of candidatePriority) {
          const hit = checkMap[cand.digits] || Object.entries(checkMap).find(([k]) => k.endsWith(cand.digits.slice(-8)))?.[1];
          if (hit?.exists) {
            const jid = hit.jid || `${cand.digits}@s.whatsapp.net`;
            if (!seenJids.has(jid)) {
              seenJids.add(jid);
              verifiedHits.push({
                digits: cand.digits,
                jid,
                source: cand.source,
              });
            }
          } else if (hit && hit.exists === false) {
            sawFalse = true;
          }
        }

        if (verifiedHits.length > 0) {
          whatsappVerified = true;
          let chosen = verifiedHits[0];

          // Desempate Inteligente: se houver >= 2 WhatsApps distintos, prefere conta Pessoal vs Business de triagem
          if (input.options.huntPartnerDirectPhone && input.checkBusinessProfileFn) {
            if (verifiedHits.length >= 2) {
              const pair = verifiedHits.slice(0, 2);
              const profiles = await Promise.allSettled(
                pair.map((h) => input.checkBusinessProfileFn!(h.jid)),
              );
              const p0 = profiles[0].status === "fulfilled" ? profiles[0].value : null;
              const p1 = profiles[1].status === "fulfilled" ? profiles[1].value : null;
              if (p1 && !p1.isBusiness && p0?.isBusiness) {
                chosen = pair[1];
                chosenBusinessProfile = p1;
              } else {
                chosenBusinessProfile = p0;
              }
            } else {
              chosenBusinessProfile = await input.checkBusinessProfileFn(chosen.jid).catch(() => null);
            }
          }

          bestPhone = chosen.digits;
          bestRemoteJid = chosen.jid;
          whatsappSource = chosen.source;
          const directHit = verifiedHits.find(
            (h) => h.source === "cnpj_socio" || h.source === "socio_web" || h.source === "website_wame",
          );
          if (directHit) partnerWhatsAppFound = directHit.digits;
        } else if (sawFalse && verifiedHits.length === 0) {
          noActiveWhatsApp = true;
        }
      }
    } catch {
      // Sem instância conectada ou erro transitório: segue degradação graciosa
    }
  } else if (input.options.prioritizePartnerPhone && candidatePriority.length > 0) {
    const directCand = candidatePriority.find(
      (c) => c.source === "cnpj_socio" || c.source === "socio_web" || c.source === "website_wame",
    );
    if (directCand && (!mapsPhoneDigits || !isBrMobileDigits(mapsPhoneDigits))) {
      bestPhone = directCand.digits;
      bestRemoteJid = `${directCand.digits}@s.whatsapp.net`;
      whatsappSource = directCand.source;
    }
  }

  const usedLandlineWithWhatsApp =
    !!bestPhone && !isBrMobileDigits(bestPhone) && whatsappVerified;

  const socioDecisor = cnpjResult?.socioDecisor || extractedPersonName;
  const primeiroNomeSocio = cnpjResult?.primeiroNomeSocio || (socioDecisor ? socioDecisor.split(/\s+/)[0] : undefined);

  // Salva telefone de recepção/Maps como backup quando priorizamos número direto do sócio
  const bestModern = bestPhone ? toModern13DigitBrMobile(bestPhone) : "";
  const backupCommercial = [mapsPhoneDigits, ...mapsWaCandidates, ...siteAudit.extractedWhatsApps]
    .filter(Boolean)
    .find((tel) => toModern13DigitBrMobile(tel) !== bestModern);
  const telefoneRecepcao =
    (whatsappSource === "cnpj_socio" || whatsappSource === "socio_web" || whatsappSource === "website_wame") &&
    backupCommercial
      ? backupCommercial
      : undefined;

  // Coleta telefones alternativos limpos (sem duplicar bestPhone nem incluir contador)
  const telefonesAlternativos: Array<{ telefone: string; label: string }> = [];
  const seenAltPhones = new Set<string>(bestModern ? [bestModern] : []);
  const pushAltPhone = (rawTel: string | undefined, label: string) => {
    if (!rawTel) return;
    const norm = normalizeBrPhoneDigits(rawTel);
    if (!norm || isLikelyAccountingPhone(norm, tenantId)) return;
    const modern = toModern13DigitBrMobile(norm) || norm;
    if (seenAltPhones.has(modern) || telefonesAlternativos.length >= 3) return;
    seenAltPhones.add(modern);
    telefonesAlternativos.push({ telefone: modern, label });
  };
  pushAltPhone(telefoneRecepcao || mapsPhoneDigits, "Recepção / Maps");
  for (const wa of siteAudit.extractedWhatsApps) pushAltPhone(wa, "WhatsApp Site");
  pushAltPhone(partnerWhatsAppFound, "Sócio / Receita");
  for (const recTel of receitaCandidates) pushAltPhone(recTel, "Receita Federal");

  // E-mail validado: prioridade 1 = HTML do site oficial; prioridade 2 = CNPJ (com trava anti-contador)
  const htmlEmail = (siteAudit.extractedEmails || []).find((em) => !isLikelyAccountingEmail(em, tenantId));
  const cnpjValidEmail =
    cnpjResult?.email && !isLikelyAccountingEmail(cnpjResult.email, tenantId)
      ? cnpjResult.email
      : undefined;
  const emailValidado = htmlEmail || cnpjValidEmail;
  const emailSource: "site_html" | "cnpj_receita" | undefined = htmlEmail
    ? "site_html"
    : cnpjValidEmail
      ? "cnpj_receita"
      : undefined;

  const { hasReceptionist, ownerActiveOnMaps, channelType } = detectReceptionistSignals({
    categories: input.categories,
    reviews: input.reviews,
    businessProfileDescription: chosenBusinessProfile?.description,
    isBusinessWhatsApp: chosenBusinessProfile?.isBusiness,
    whatsappSource: bestPhone ? whatsappSource : undefined,
    hasIdentifiedSocio: Boolean(socioDecisor),
    isMei: cnpjResult?.isMei,
    sociosCount: cnpjResult?.socios?.length,
  });

  const empresaCurta = extractShortCompanyName(input.name, input.cidade);
  const { mainService } = cleanGoogleServicesList(input.services, input.categories, input.name);
  const franchiseCheck = detectFranchiseOrChain({
    name: input.name,
    website: input.website,
    razaoSocial: cnpjResult?.razaoSocial,
    capitalSocial: cnpjResult?.capitalSocial,
  });

  const recommendedApproach =
    channelType === "socio_direto" && primeiroNomeSocio
      ? `Chamar direto o sócio ${primeiroNomeSocio}`
      : channelType === "recepcao_comercial" && primeiroNomeSocio
        ? `Fura-secretária pedindo encaminhamento para ${primeiroNomeSocio}`
        : undefined;

  const qualificationObjective: QualificationObjective = input.options.qualificationObjective || "site_sales";
  const { score, reasons } = computeLeadQualificationScore({
    siteAudit,
    cnpjResult,
    reviewCount: input.reviewCount,
    averageRating: input.averageRating,
    claimed: input.claimed,
    hasPartnerWhatsApp: !!partnerWhatsAppFound,
    ownerActiveOnMaps,
    hasReceptionist,
    objective: qualificationObjective,
  });

  const enrichment: LeadEnrichmentData = {
    siteHealth: siteAudit.status,
    siteStatusLabel: siteAudit.statusLabel,
    siteIssueCode: siteAudit.issueCode,
    siteDiagnostico: siteAudit.diagnosticoComercial || undefined,
    ...(siteAudit.auditUncertain ? { auditUncertain: true } : {}),
    siteHttpStatus: siteAudit.httpStatus,
    ...(siteAudit.siteQualityScore !== undefined ? { siteQualityScore: siteAudit.siteQualityScore } : {}),
    ...(siteAudit.siteWeaknesses?.length ? { siteWeaknesses: siteAudit.siteWeaknesses } : {}),
    qualificationObjective,
    cnpj: cnpjResult?.cnpj,
    razaoSocial: cnpjResult?.razaoSocial || undefined,
    situacaoCadastral: cnpjResult?.situacaoCadastral,
    porte: cnpjResult?.porte,
    isMei: cnpjResult?.isMei,
    capitalSocial: cnpjResult?.capitalSocial,
    dataInicioAtividade: cnpjResult?.dataInicioAtividade,
    anosEmpresa: cnpjResult?.anosEmpresa,
    socioDecisor,
    primeiroNomeSocio,
    ...(cnpjResult?.faixaEtariaSocio ? { faixaEtariaSocio: cnpjResult.faixaEtariaSocio } : {}),
    socios: cnpjResult?.socios,
    ...(cnpjResult?.cnaeDescricao ? { cnaeDescricao: cnpjResult.cnaeDescricao } : {}),
    ...(emailValidado ? { emailValidado, emailSource } : {}),
    telefoneSocio: partnerWhatsAppFound || undefined,
    telefoneMapsOriginal: mapsPhoneDigits || undefined,
    ...(telefoneRecepcao ? { telefoneRecepcao } : {}),
    ...(telefonesAlternativos.length > 0 ? { telefonesAlternativos } : {}),
    whatsappSource: bestPhone ? whatsappSource : undefined,
    whatsappVerified: input.options.validateWhatsApp ? whatsappVerified : undefined,
    whatsappChannelType: channelType,
    hasReceptionist,
    ownerActiveOnMaps,
    ...(siteAudit.hasPaidTrafficTag ? { hasPaidTrafficTag: true, trafficTags: siteAudit.trafficTags } : {}),
    ...(siteAudit.discoveredRealWebsite ? { discoveredRealWebsite: siteAudit.discoveredRealWebsite } : {}),
    ...(siteAudit.managementTools?.length ? { managementTools: siteAudit.managementTools } : {}),
    ...(siteAudit.abandonedCopyrightYear ? { abandonedCopyrightYear: siteAudit.abandonedCopyrightYear } : {}),
    ...(franchiseCheck.isFranchise ? { isFranchise: true } : {}),
    ...(empresaCurta ? { empresaCurta } : {}),
    ...(mainService ? { servicoPrincipal: mainService } : {}),
    ...(recommendedApproach ? { recommendedApproach } : {}),
    qualificationScore: score,
    qualificationReasons: reasons,
    enrichedAt: new Date().toISOString(),
  };

  return {
    enrichment,
    siteAudit,
    cnpjResult,
    bestPhone,
    bestRemoteJid,
    usedLandlineWithWhatsApp,
    noActiveWhatsApp,
    partnerWhatsAppFound,
  };
}

