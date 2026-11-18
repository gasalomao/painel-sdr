/**
 * Pure shared state synchronization, mutual-exclusion / dependency auto-toggle,
 * presets, URL-level host classifiers and qualification objective resolver for all
 * Google Maps capture and automation surfaces.
 *
 * Strictly zero Node/server dependencies so client pages can import it safely.
 */

export type SiteHealthStatus = "no_site" | "broken_site" | "weak_site" | "active_site";

export type SiteFilterMode =
  | "any"
  | "no_site"
  | "broken_or_no_site"
  | "only_broken_or_weak"
  | "only_active_site";

export type QualificationObjective = "site_sales" | "ai_automation" | "general";

export type ScraperPresetId =
  | "vender_sites"
  | "vender_ia"
  | "direto_socio"
  | "volume_rapido";

export type ScraperSurface = "prospeccao-sites" | "automacao" | "captador";

export const SOCIAL_ONLY_HOSTS: readonly string[] = [
  "instagram.com",
  "facebook.com",
  "fb.com",
  "wa.me",
  "whatsapp.com",
  "api.whatsapp.com",
  "web.whatsapp.com",
  "t.me",
  "telegram.me",
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "linkedin.com",
  "twitter.com",
  "x.com",
  "threads.net",
  "pinterest.com",
  "kwai.com",
];

export const THIRD_PARTY_PLATFORM_HOSTS: readonly string[] = [
  "ifood.com.br",
  "anota.ai",
  "goomer.app",
  "cardapioweb.com",
  "menudino.com",
  "instadelivery.com.br",
  "ola.click",
  "saipos.com",
  "neemo.com.br",
  "yooga.app",
  "pedir.to",
  "pede.ai",
  "doctoralia.com",
  "doctoralia.com.br",
  "trinks.com",
  "booksy.com",
  "avec.app",
  "calendly.com",
  "cal.com",
  "sympla.com.br",
  "eventbrite.com.br",
  "booking.com",
  "airbnb.com",
  "airbnb.com.br",
  "tripadvisor.com.br",
  "mercadolivre.com.br",
  "mercadolivre.com",
  "shopee.com.br",
  "olx.com.br",
  "enjoei.com.br",
  "magazineluiza.com.br",
  "elo7.com.br",
  "getninjas.com.br",
  "habitissimo.com.br",
  "guiamais.com.br",
  "apontador.com.br",
  "solutudo.com.br",
  "reclameaqui.com.br",
  "jusbrasil.com.br",
];

export const IMPROVISED_HOSTS: readonly string[] = [
  "linktr.ee",
  "bio.site",
  "beacons.ai",
  "canva.site",
  "my.canva.site",
  "sites.google.com",
  "docs.google.com",
  "forms.gle",
  "drive.google.com",
  "wixsite.com",
  "blogspot.com",
  "wordpress.com",
  "weebly.com",
  "webnode.page",
  "webnode.com",
  "webnode.com.br",
  "carrd.co",
  "linkbio.co",
  "taplink.cc",
  "milkshake.app",
  "shor.by",
  "lnk.bio",
  "flow.page",
  "campsite.bio",
  "bento.me",
  "solo.to",
  "bit.ly",
  "keepo.io",
  "zaap.bio",
  "atom.bio",
  "allmylinks.com",
  "msha.ke",
  "negocio.site",
  "business.site",
  "000webhostapp.com",
  "netlify.app",
  "vercel.app",
  "github.io",
  "pages.dev",
  "web.app",
  "firebaseapp.com",
  "lovable.app",
  "webflow.io",
  "framer.website",
  "framer.app",
  "notion.site",
  "strikingly.com",
  "jimdofree.com",
  "yolasite.com",
  "tumblr.com",
];

export function extractUrlHostname(rawUrl: string): string {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return parsed.hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function matchesDomainList(host: string, list: readonly string[]): boolean {
  const cleanHost = String(host || "").toLowerCase().replace(/^www\./, "");
  if (!cleanHost) return false;
  return list.some((domain) => cleanHost === domain || cleanHost.endsWith(`.${domain}`));
}

export function classifyNonOwnWebsiteUrl(
  rawUrl: string | null | undefined,
): "empty" | "social_link_only" | "third_party_platform" | null {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) return "empty";
  const host = extractUrlHostname(trimmed);
  if (!host) return "empty";
  if (matchesDomainList(host, SOCIAL_ONLY_HOSTS)) return "social_link_only";
  if (matchesDomainList(host, THIRD_PARTY_PLATFORM_HOSTS)) return "third_party_platform";
  return null;
}

export function isNonWebsiteUrl(rawUrl: string | null | undefined): boolean {
  return classifyNonOwnWebsiteUrl(rawUrl) !== null;
}

export interface ScraperFilterSyncState {
  filterEmpty: boolean;
  filterDuplicates: boolean;
  filterLandlines: boolean;
  filterWithWebsite: boolean;
  filterWithInstagram: boolean;
  captureAllReviews: boolean;
  reviewsAiEnabled: boolean;
  turboMode: boolean;
  filterClosedBusinesses: boolean;
  auditSiteHealth: boolean;
  siteFilterMode: SiteFilterMode;
  enrichCnpj: boolean;
  prioritizePartnerPhone: boolean;
  validateWhatsApp: boolean;
  excludeMei: boolean;
  excludeFranchises: boolean;
  huntPartnerDirectPhone: boolean;
  expandNeighborhoods: boolean;
  prioritizeByScore: boolean;
  minCapitalSocial: string;
  personalizeWithAi?: boolean;
  antibanMixer?: boolean;
}

export type ScraperFilterChangeAction =
  | { type: "filterWithWebsite"; value: boolean }
  | { type: "siteFilterMode"; value: SiteFilterMode }
  | { type: "auditSiteHealth"; value: boolean }
  | { type: "enrichCnpj"; value: boolean }
  | { type: "excludeMei"; value: boolean }
  | { type: "minCapitalSocial"; value: string }
  | { type: "huntPartnerDirectPhone"; value: boolean }
  | { type: "prioritizePartnerPhone"; value: boolean }
  | { type: "validateWhatsApp"; value: boolean }
  | { type: "turboMode"; value: boolean }
  | { type: "captureAllReviews"; value: boolean }
  | { type: "reviewsAiEnabled"; value: boolean }
  | { type: "prioritizeByScore"; value: boolean }
  | { type: "personalizeWithAi"; value: boolean }
  | { type: "antibanMixer"; value: boolean }
  | { type: "preset"; preset: ScraperPresetId };

export interface ScraperFilterSyncResult {
  state: ScraperFilterSyncState;
  autoNote: string | null;
}

export interface ScraperPresetOption {
  id: ScraperPresetId;
  label: string;
  shortDesc: string;
}

export const SCRAPER_PRESET_OPTIONS: readonly ScraperPresetOption[] = [
  {
    id: "vender_sites",
    label: "Vender Sites",
    shortDesc: "Foca leads sem site próprio ou com site quebrado/fraco + CNPJ e WA",
  },
  {
    id: "vender_ia",
    label: "Vender IA / Automação",
    shortDesc: "Empresas ativas (sem MEI/franquia), auditoria digital + Score IA",
  },
  {
    id: "direto_socio",
    label: "Direto no Sócio",
    shortDesc: "9º dígito Anatel + WhatsApp pessoal do dono + filtro ME/EPP/Ltda",
  },
  {
    id: "volume_rapido",
    label: "Extração Rápida",
    shortDesc: "Modo Turbo leve sem auditoria/CNPJ para alto volume",
  },
];

const SITE_AUDIT_REQUIRED_MODES = new Set<SiteFilterMode>([
  "broken_or_no_site",
  "only_broken_or_weak",
  "only_active_site",
]);

function maybeDisableOrphanScore(next: ScraperFilterSyncState, notes: string[]): void {
  if (next.prioritizeByScore && !next.auditSiteHealth && !next.enrichCnpj) {
    next.prioritizeByScore = false;
    notes.push("Priorização por Score desativada pois auditoria de site e CNPJ estão desligadas.");
  }
}

export function applyScraperFilterChange(
  current: ScraperFilterSyncState,
  action: ScraperFilterChangeAction,
  surface: ScraperSurface = "captador",
): ScraperFilterSyncResult {
  const next: ScraperFilterSyncState = { ...current };
  const notes: string[] = [];

  switch (action.type) {
    case "filterWithWebsite": {
      if (action.value) {
        next.filterWithWebsite = true;
        next.siteFilterMode = "no_site";
        if (next.auditSiteHealth) {
          next.auditSiteHealth = false;
          notes.push("Auditoria de site desligada automaticamente ao ativar 'Somente sem site'.");
        }
        maybeDisableOrphanScore(next, notes);
      } else {
        next.filterWithWebsite = false;
        if (next.siteFilterMode === "no_site") {
          next.siteFilterMode = "any";
        }
      }
      break;
    }

    case "siteFilterMode": {
      next.siteFilterMode = action.value;
      if (action.value === "no_site") {
        next.filterWithWebsite = true;
        if (next.auditSiteHealth) {
          next.auditSiteHealth = false;
          notes.push("Auditoria HTTP de site desligada automaticamente para focar leads sem site.");
        }
        maybeDisableOrphanScore(next, notes);
      } else if (action.value === "any") {
        next.filterWithWebsite = false;
      } else if (SITE_AUDIT_REQUIRED_MODES.has(action.value)) {
        const hadNoSite = next.filterWithWebsite;
        const hadAuditOff = !next.auditSiteHealth;
        next.filterWithWebsite = false;
        next.auditSiteHealth = true;
        if (hadNoSite || hadAuditOff) {
          notes.push(
            hadAuditOff && hadNoSite
              ? "Auditoria de site ativada automaticamente e 'Somente sem site' desmarcado para avaliar os sites."
              : hadAuditOff
                ? "Auditoria de site ativada automaticamente para aplicar este filtro de qualidade."
                : "Modo alterado para avaliar sites compatíveis com este filtro.",
          );
        }
      }
      break;
    }

    case "auditSiteHealth": {
      if (action.value) {
        next.auditSiteHealth = true;
        if (next.filterWithWebsite || next.siteFilterMode === "no_site") {
          next.filterWithWebsite = false;
          next.siteFilterMode = surface === "prospeccao-sites" ? "broken_or_no_site" : "any";
          notes.push(
            surface === "prospeccao-sites"
              ? "Filtro de site ajustado para 'Sem site + Quebrado' para auditar sites sem descartá-los."
              : "'Somente sem site' desativado automaticamente para permitir auditar a saúde dos sites.",
          );
        }
      } else {
        next.auditSiteHealth = false;
        if (SITE_AUDIT_REQUIRED_MODES.has(next.siteFilterMode)) {
          next.siteFilterMode = "any";
          next.filterWithWebsite = false;
          notes.push("Filtro por saúde do site redefinido para 'Todos' ao desligar a auditoria.");
        }
        maybeDisableOrphanScore(next, notes);
      }
      break;
    }

    case "enrichCnpj": {
      if (action.value) {
        next.enrichCnpj = true;
      } else {
        const disabledChildren: string[] = [];
        if (next.excludeMei) {
          next.excludeMei = false;
          disabledChildren.push("Ignorar MEI");
        }
        if ((Number(next.minCapitalSocial) || 0) > 0) {
          next.minCapitalSocial = "0";
          disabledChildren.push("Capital mínimo");
        }
        if (next.huntPartnerDirectPhone) {
          next.huntPartnerDirectPhone = false;
          disabledChildren.push("Modo Direto no Dono");
        }
        next.enrichCnpj = false;
        if (disabledChildren.length > 0) {
          notes.push(
            `${disabledChildren.join(", ")} ${disabledChildren.length > 1 ? "foram limpos" : "foi limpo"} automaticamente ao desligar o CNPJ (evita descarte em massa).`,
          );
        }
        maybeDisableOrphanScore(next, notes);
      }
      break;
    }

    case "excludeMei": {
      next.excludeMei = action.value;
      if (action.value && !next.enrichCnpj) {
        next.enrichCnpj = true;
        notes.push("Enriquecimento de CNPJ ativado automaticamente para filtrar MEIs.");
      }
      break;
    }

    case "minCapitalSocial": {
      next.minCapitalSocial = action.value;
      if ((Number(action.value) || 0) > 0 && !next.enrichCnpj) {
        next.enrichCnpj = true;
        notes.push("Enriquecimento de CNPJ ativado automaticamente para validar capital social.");
      }
      break;
    }

    case "huntPartnerDirectPhone": {
      if (action.value) {
        const autoEnabled: string[] = [];
        if (!next.enrichCnpj) {
          next.enrichCnpj = true;
          autoEnabled.push("CNPJ/QSA");
        }
        if (!next.prioritizePartnerPhone) {
          next.prioritizePartnerPhone = true;
          autoEnabled.push("Priorizar celular do sócio");
        }
        if (!next.validateWhatsApp) {
          next.validateWhatsApp = true;
          autoEnabled.push("Validar WhatsApp na Evolution");
        }
        next.huntPartnerDirectPhone = true;
        if (autoEnabled.length > 0) {
          notes.push(
            `Dependências ativadas para o Modo Direto no Dono: ${autoEnabled.join(", ")}.`,
          );
        }
      } else {
        next.huntPartnerDirectPhone = false;
      }
      break;
    }

    case "prioritizePartnerPhone": {
      next.prioritizePartnerPhone = action.value;
      if (!action.value && next.huntPartnerDirectPhone) {
        next.huntPartnerDirectPhone = false;
        notes.push("Modo Direto no Dono desativado pois depende da priorização de telefone do sócio.");
      }
      break;
    }

    case "validateWhatsApp": {
      next.validateWhatsApp = action.value;
      if (!action.value && next.huntPartnerDirectPhone) {
        next.huntPartnerDirectPhone = false;
        notes.push("Modo Direto no Dono desativado pois exige validação de perfil WhatsApp na Evolution.");
      }
      break;
    }

    case "turboMode": {
      if (action.value) {
        next.turboMode = true;
        if (next.captureAllReviews || next.reviewsAiEnabled) {
          next.captureAllReviews = false;
          next.reviewsAiEnabled = false;
          notes.push("Avaliações completas/IA desativadas para preservar velocidade e RAM do Modo Turbo.");
        }
      } else {
        next.turboMode = false;
      }
      break;
    }

    case "captureAllReviews": {
      if (action.value) {
        next.captureAllReviews = true;
        if (next.turboMode) {
          next.turboMode = false;
          notes.push("Modo Turbo pausado automaticamente para permitir rolagem completa das avaliações.");
        }
      } else {
        next.captureAllReviews = false;
        if (next.reviewsAiEnabled) {
          next.reviewsAiEnabled = false;
          notes.push("Resumo de avaliações com IA desativado pois depende de 'Capturar todas as avaliações'.");
        }
      }
      break;
    }

    case "reviewsAiEnabled": {
      if (action.value) {
        next.reviewsAiEnabled = true;
        next.captureAllReviews = true;
        if (next.turboMode) {
          next.turboMode = false;
          notes.push("Capturar todas as avaliações ativado e Modo Turbo pausado para o resumo com IA.");
        }
      } else {
        // Preserva captureAllReviews conforme contrato de UX existente
        next.reviewsAiEnabled = false;
      }
      break;
    }

    case "prioritizeByScore": {
      if (action.value) {
        next.prioritizeByScore = true;
        if (!next.auditSiteHealth && !next.enrichCnpj) {
          next.auditSiteHealth = true;
          next.enrichCnpj = true;
          notes.push("Auditoria de site e CNPJ reativados para calcular o Score ICP.");
        }
      } else {
        next.prioritizeByScore = false;
      }
      break;
    }

    case "personalizeWithAi": {
      next.personalizeWithAi = action.value;
      if (action.value && next.antibanMixer !== false) {
        next.antibanMixer = false;
        notes.push("Misturador Anti-Ban estático desativado pois a IA já reescreve cada mensagem de forma única.");
      }
      break;
    }

    case "antibanMixer": {
      next.antibanMixer = action.value;
      if (action.value && next.personalizeWithAi) {
        next.personalizeWithAi = false;
        notes.push("Reescrita com IA desativada automaticamente ao ligar o Misturador Anti-Ban estático.");
      }
      break;
    }

    case "preset": {
      if (action.preset === "vender_sites") {
        next.filterEmpty = true;
        next.filterDuplicates = true;
        next.filterLandlines = false;
        next.filterWithWebsite = false;
        next.siteFilterMode = "broken_or_no_site";
        next.auditSiteHealth = true;
        next.enrichCnpj = true;
        next.prioritizePartnerPhone = true;
        next.validateWhatsApp = true;
        next.excludeMei = false;
        next.excludeFranchises = true;
        next.huntPartnerDirectPhone = false;
        next.filterClosedBusinesses = true;
        next.turboMode = true;
        next.captureAllReviews = false;
        next.reviewsAiEnabled = false;
        next.prioritizeByScore = true;
        notes.push("Perfil 'Vender Sites' aplicado: captura sem site ou com site quebrado/fraco + CNPJ e WhatsApp.");
      } else if (action.preset === "vender_ia") {
        next.filterEmpty = true;
        next.filterDuplicates = true;
        next.filterLandlines = false;
        next.filterWithWebsite = false;
        next.siteFilterMode = "any";
        next.auditSiteHealth = true;
        next.enrichCnpj = true;
        next.prioritizePartnerPhone = true;
        next.validateWhatsApp = true;
        next.excludeMei = true;
        next.excludeFranchises = true;
        next.huntPartnerDirectPhone = false;
        next.filterClosedBusinesses = true;
        next.turboMode = true;
        next.captureAllReviews = false;
        next.reviewsAiEnabled = false;
        next.prioritizeByScore = true;
        notes.push("Perfil 'Vender IA / Automação' aplicado: empresas maduras (sem MEI/franquia) ranqueadas para atendimento IA.");
      } else if (action.preset === "direto_socio") {
        next.filterEmpty = true;
        next.filterDuplicates = true;
        next.filterLandlines = false;
        next.filterClosedBusinesses = true;
        next.enrichCnpj = true;
        next.prioritizePartnerPhone = true;
        next.validateWhatsApp = true;
        next.huntPartnerDirectPhone = true;
        next.excludeMei = true;
        next.excludeFranchises = true;
        next.turboMode = true;
        next.captureAllReviews = false;
        next.reviewsAiEnabled = false;
        next.prioritizeByScore = true;
        notes.push("Perfil 'Direto no Sócio' aplicado: 9º dígito Anatel + QSA + perfil pessoal no WhatsApp.");
      } else if (action.preset === "volume_rapido") {
        next.filterEmpty = true;
        next.filterDuplicates = true;
        next.filterClosedBusinesses = true;
        next.turboMode = true;
        next.auditSiteHealth = false;
        next.siteFilterMode = "any";
        next.filterWithWebsite = false;
        next.enrichCnpj = false;
        next.excludeMei = false;
        next.minCapitalSocial = "0";
        next.huntPartnerDirectPhone = false;
        next.prioritizePartnerPhone = false;
        next.validateWhatsApp = true;
        next.captureAllReviews = false;
        next.reviewsAiEnabled = false;
        next.prioritizeByScore = false;
        notes.push("Perfil 'Extração Rápida' aplicado: Modo Turbo puro sem consultas extras de site ou CNPJ.");
      }
      break;
    }
  }

  return {
    state: next,
    autoNote: notes.length > 0 ? notes.join(" ") : null,
  };
}

/**
 * Sanitizes scraper/automation filter objects on the backend so conflicting or
 * orphaned flags (e.g., `excludeMei` or `minCapitalSocial` when `enrichCnpj === false`)
 * never accidentally reject 100% of leads. Never mutates caller input or `_` runtime markers.
 */
export function normalizeScraperSettingsForBackend<T extends Record<string, unknown>>(raw: T): T {
  const out: Record<string, unknown> = { ...raw };

  const explicitSiteMode = typeof out.siteFilterMode === "string" ? out.siteFilterMode : undefined;
  if (explicitSiteMode === "no_site") {
    out.filterWithWebsite = true;
  } else if (
    explicitSiteMode === "broken_or_no_site" ||
    explicitSiteMode === "only_broken_or_weak" ||
    explicitSiteMode === "only_active_site"
  ) {
    out.filterWithWebsite = false;
    out.auditSiteHealth = true;
  } else if (out.filterWithWebsite === true && (!explicitSiteMode || explicitSiteMode === "any")) {
    out.siteFilterMode = "no_site";
  }

  if (out.huntPartnerDirectPhone === true) {
    out.enrichCnpj = true;
    out.prioritizePartnerPhone = true;
    out.validateWhatsApp = true;
  }

  if (out.enrichCnpj === false) {
    out.excludeMei = false;
    out.huntPartnerDirectPhone = false;
    if ("minCapitalSocial" in out) {
      out.minCapitalSocial = 0;
    }
  }

  const reviewsAi = out.reviews_ai as { enabled?: boolean } | undefined;
  if (out.captureAllReviews === false && reviewsAi && typeof reviewsAi === "object") {
    out.reviews_ai = { ...reviewsAi, enabled: false };
  }

  return out as T;
}

export function resolveQualificationObjective(input: {
  source?: string | null;
  siteFilterMode?: SiteFilterMode | string | null;
  filterWithWebsite?: boolean;
  isAutomation?: boolean;
  explicitObjective?: QualificationObjective | null;
}): QualificationObjective {
  if (
    input.explicitObjective === "site_sales" ||
    input.explicitObjective === "ai_automation" ||
    input.explicitObjective === "general"
  ) {
    return input.explicitObjective;
  }
  if (
    input.source === "prospeccao-sites" ||
    input.filterWithWebsite === true ||
    input.siteFilterMode === "no_site" ||
    input.siteFilterMode === "broken_or_no_site" ||
    input.siteFilterMode === "only_broken_or_weak"
  ) {
    return "site_sales";
  }
  if (input.isAutomation === true || input.siteFilterMode === "only_active_site") {
    return "ai_automation";
  }
  return "general";
}

