/**
 * crm-lead-profile — normalização, projeção leve (anti-TOAST), sanitização contra
 * prompt-injection e resolução de prioridades (`crm_overrides` > `enrichment` > colunas)
 * para o CRM (`/leads`, Kanban, `LeadDrawer`, `/chat`) e alimentação controlada da IA.
 */

import {
  formatCnpj,
  isValidBusinessEmail,
  isValidCnpj,
  normalizeBrPhoneDigits,
  toModern13DigitBrMobile,
} from "@/lib/br-crm-utils";
import type {
  CnpjPartner,
  LeadEnrichmentData,
  SiteHealthStatus,
  WhatsAppChannelType,
} from "@/lib/scraper-lead-enrichment";
import { resolveLeadGoogleYear } from "@/lib/scraper-lead-filters";

export const LEAD_AI_DOSSIER_MODES = ["inherit", "strategic", "full", "off"] as const;
export type LeadAiDossierMode = (typeof LEAD_AI_DOSSIER_MODES)[number];

export const AGENT_AI_DOSSIER_MODES = ["strategic", "full", "off"] as const;
export type AgentAiDossierMode = (typeof AGENT_AI_DOSSIER_MODES)[number];

export const VALID_WHATSAPP_CHANNEL_TYPES = [
  "socio_direto",
  "provavel_socio",
  "recepcao_comercial",
  "indefinido",
] as const satisfies readonly WhatsAppChannelType[];

export interface LeadCrmOverrides {
  socioDecisor?: string | null;
  primeiroNomeSocio?: string | null;
  canalWhatsapp?: WhatsAppChannelType | null;
  telefoneAlternativo?: string | null;
  telefoneAlternativoLabel?: string | null;
  cnpj?: string | null;
  porte?: string | null;
  servicoPrincipal?: string | null;
  aiDossierMode?: LeadAiDossierMode | null;
  updatedAt?: string;
}

export interface LeadAlternativePhone {
  telefone: string;
  formatted: string;
  label: string;
}

/**
 * Projeção ultraleve (~150B) trafegada na listagem `/api/leads` (Lista, Kanban e Chat)
 * sem expor arrays JSONB pesados (`reviews_detalhes`, `photos`, `featured_reviews`).
 */
export interface LeadCrmSummary {
  socioDecisor: string | null;
  primeiroNomeSocio: string | null;
  canalWhatsapp: WhatsAppChannelType | null;
  canalLabel: string | null;
  telefoneAlternativo: string | null;
  telefoneAlternativoFormatted: string | null;
  telefoneAlternativoLabel: string | null;
  cnpj: string | null;
  porte: string | null;
  anosEmpresa: number | null;
  anoGoogle: number | null;
  siteHealth: SiteHealthStatus | null;
  siteStatusLabel: string | null;
  hasPaidTraffic: boolean;
  trafficTags: string[];
  managementTools: string[];
  qualificationScore: number | null;
  servicoPrincipal: string | null;
  aiDossierMode: LeadAiDossierMode;
  richSignalsCount: number;
}

/**
 * Dossiê completo carregado sob demanda na abertura da Ficha (`GET /api/leads/[id]/crm`).
 */
export interface LeadCrmDossier extends LeadCrmSummary {
  faixaEtariaSocio: string | null;
  socios: CnpjPartner[];
  razaoSocial: string | null;
  situacaoCadastral: string | null;
  capitalSocial: number | null;
  cnaeDescricao: string | null;
  emailValidado: string | null;
  emailSource: "site_html" | "cnpj_receita" | "manual" | null;
  telefonesAlternativos: LeadAlternativePhone[];
  siteDiagnostico: string | null;
  discoveredRealWebsite: string | null;
  abandonedCopyrightYear: number | null;
  isFranchise: boolean;
  claimed: boolean | null;
  ownerActiveOnMaps: boolean;
  horarioFuncionamento: string | null;
  priceRange: string | null;
  totalPhotos: number | null;
  topicosAvaliacoes: string[];
  qualificationReasons: string[];
  enrichedAt: string | null;
}

export interface CrmProfilePatchInput {
  socio_decisor?: unknown;
  canal_whatsapp?: unknown;
  telefone_alternativo?: unknown;
  cnpj?: unknown;
  email?: unknown;
  website?: unknown;
  instagram?: unknown;
  facebook?: unknown;
  porte?: unknown;
  servico_principal?: unknown;
  ai_dossier_mode?: unknown;
}

export interface ValidatedCrmProfilePatch {
  ok: true;
  topLevelColumns: Record<string, string | null>;
  overridesPatch: Partial<LeadCrmOverrides>;
}

export interface InvalidCrmProfilePatch {
  ok: false;
  error: string;
}

const PROMPT_INJECTION_PATTERNS = [
  /<\s*\/?\s*(?:lead_context|system|assistant|user|instruction|prompt|tool_call)\b[^>]*>/gi,
  /\b(?:ignore\s+(?:all\s+)?(?:previous|prior|above)\s+instructions?|disregard\s+previous|system\s*prompt\s*:)/gi,
  /```+/g,
];

/**
 * Sanitiza strings vindas de páginas externas / Google Maps antes de injetar em prompts de IA.
 */
export function sanitizePromptSignal(raw: unknown, maxLength = 180): string {
  if (typeof raw !== "string") return "";
  let cleaned = raw
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/<[^>]{1,120}>/g, " ");
  for (const re of PROMPT_INJECTION_PATTERNS) {
    cleaned = cleaned.replace(re, " ");
  }
  cleaned = cleaned
    .replace(/(?:^|\s)#+\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length > maxLength) {
    return `${cleaned.slice(0, maxLength - 1).trimEnd()}…`;
  }
  return cleaned;
}

export function formatBrPhoneDisplay(raw?: string | null): string {
  if (!raw) return "";
  const digits = String(raw).replace(/@.*$/, "").replace(/\D/g, "");
  const norm = normalizeBrPhoneDigits(digits) || digits;
  if (norm.length === 13 && norm.startsWith("55")) {
    return `+${norm.slice(0, 2)} (${norm.slice(2, 4)}) ${norm.slice(4, 9)}-${norm.slice(9)}`;
  }
  if (norm.length === 12 && norm.startsWith("55")) {
    return `+${norm.slice(0, 2)} (${norm.slice(2, 4)}) ${norm.slice(4, 8)}-${norm.slice(8)}`;
  }
  if (norm.length === 11) {
    return `(${norm.slice(0, 2)}) ${norm.slice(2, 7)}-${norm.slice(7)}`;
  }
  if (norm.length === 10) {
    return `(${norm.slice(0, 2)}) ${norm.slice(2, 6)}-${norm.slice(6)}`;
  }
  return String(raw).trim();
}

export function formatChannelBadgeLabel(channel: WhatsAppChannelType | string | null | undefined): string | null {
  if (channel === "socio_direto") return "WhatsApp do sócio";
  if (channel === "provavel_socio") return "Provável sócio";
  if (channel === "recepcao_comercial") return "Recepção";
  return null;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asFiniteNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const parsed = Number(v.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asStringArray(v: unknown, limit = 8): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string" && item.trim()) {
      out.push(item.trim());
      if (out.length >= limit) break;
    }
  }
  return out;
}

function parseLeadAiDossierMode(v: unknown): LeadAiDossierMode {
  if (v === "strategic" || v === "full" || v === "off" || v === "inherit") {
    return v;
  }
  return "inherit";
}

/**
 * Resolve o modo efetivo de injeção de dossiê na IA combinando preferência por lead
 * (`inherit` por padrão) e configuração do agente (`sdr_enrichment_dossier_enabled` / `sdr_enrichment_dossier_mode`).
 */
export function resolveEffectiveAiDossierMode(
  leadRow: Record<string, unknown> | null | undefined,
  agentOptions: Record<string, unknown> | null | undefined,
): AgentAiDossierMode {
  const bd = asRecord(leadRow?.business_details);
  const overrides = asRecord(bd.crm_overrides);
  const leadMode = parseLeadAiDossierMode(overrides.aiDossierMode);

  if (leadMode === "off") return "off";
  if (leadMode === "strategic" || leadMode === "full") return leadMode;

  const opts = asRecord(agentOptions);
  const explicitAgentMode = opts.sdr_enrichment_dossier_mode;
  if (explicitAgentMode === "off") return "off";
  if (opts.sdr_enrichment_dossier_enabled === false) return "off";
  if (explicitAgentMode === "full") return "full";
  if (explicitAgentMode === "strategic") return "strategic";
  return opts.sdr_enrichment_dossier_enabled === true ? "strategic" : "off";
}

function formatOpeningHoursCompact(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === "string") return raw.trim() || null;
  if (Array.isArray(raw)) {
    const parts = raw
      .map((item) => {
        if (typeof item === "string") return item.trim();
        const obj = asRecord(item);
        const day = asNonEmptyString(obj.day) || asNonEmptyString(obj.dia);
        const hours = asNonEmptyString(obj.hours) || asNonEmptyString(obj.horario);
        return day && hours ? `${day}: ${hours}` : "";
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.slice(0, 7).join(" · ") : null;
  }
  if (typeof raw === "object") {
    const parts = Object.entries(asRecord(raw))
      .filter(([k, val]) => !k.startsWith("_") && val != null && String(val).trim() !== "")
      .map(([k, val]) => `${k}: ${String(val).trim()}`);
    return parts.length > 0 ? parts.slice(0, 7).join(" · ") : null;
  }
  return null;
}

function extractReviewTopicsList(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return asStringArray(raw, 8);
  if (typeof raw === "object") {
    return Object.keys(asRecord(raw))
      .filter((k) => !k.startsWith("_") && k.trim().length > 0)
      .slice(0, 8);
  }
  return [];
}

function resolveAlternativePhones(
  primaryPhoneRaw: string | null,
  overrides: Record<string, unknown>,
  enr: Partial<LeadEnrichmentData>,
): LeadAlternativePhone[] {
  const primaryDigits = normalizeBrPhoneDigits(primaryPhoneRaw || "");
  const primaryModern = primaryDigits ? toModern13DigitBrMobile(primaryDigits) || primaryDigits : "";
  const seen = new Set<string>(primaryModern ? [primaryModern] : []);
  const list: LeadAlternativePhone[] = [];

  const push = (rawPhone: unknown, rawLabel: string) => {
    if (typeof rawPhone !== "string" || !rawPhone.trim()) return;
    const norm = normalizeBrPhoneDigits(rawPhone);
    const key = norm ? toModern13DigitBrMobile(norm) || norm : rawPhone.replace(/\D/g, "");
    if (!key || key.length < 10 || seen.has(key) || list.length >= 3) return;
    seen.add(key);
    list.push({
      telefone: key,
      formatted: formatBrPhoneDisplay(key),
      label: rawLabel,
    });
  };

  if ("telefoneAlternativo" in overrides) {
    if (typeof overrides.telefoneAlternativo === "string" && overrides.telefoneAlternativo.trim()) {
      push(
        overrides.telefoneAlternativo,
        asNonEmptyString(overrides.telefoneAlternativoLabel) || "Contato reserva",
      );
    }
  }

  if (Array.isArray(enr.telefonesAlternativos)) {
    for (const item of enr.telefonesAlternativos) {
      if (item && typeof item === "object") {
        push(item.telefone, item.label || "Contato alternativo");
      }
    }
  }
  push(enr.telefoneRecepcao, "Recepção / Maps");
  push(enr.telefoneSocio, "WhatsApp do sócio");
  push(enr.telefoneMapsOriginal, "Telefone Maps");

  return list;
}

/**
 * Extrai a projeção leve `LeadCrmSummary` de uma linha de `leads_extraidos`.
 */
export function extractLeadCrmSummary(row: Record<string, unknown> | null | undefined): LeadCrmSummary {
  const r = asRecord(row);
  const bd = asRecord(r.business_details);
  const enr = asRecord(bd.enrichment) as Partial<LeadEnrichmentData>;
  const overrides = asRecord(bd.crm_overrides);

  const hasSocioOverride = Object.prototype.hasOwnProperty.call(overrides, "socioDecisor");
  const socioDecisor = hasSocioOverride
    ? asNonEmptyString(overrides.socioDecisor)
    : asNonEmptyString(enr.socioDecisor) || asNonEmptyString(r.owner_name);

  const primeiroNomeSocio = socioDecisor
    ? (hasSocioOverride
        ? asNonEmptyString(overrides.primeiroNomeSocio)
        : asNonEmptyString(enr.primeiroNomeSocio)) ||
      socioDecisor.split(/\s+/)[0] ||
      null
    : null;

  const rawChannel = Object.prototype.hasOwnProperty.call(overrides, "canalWhatsapp")
    ? overrides.canalWhatsapp
    : enr.whatsappChannelType;
  const canalWhatsapp: WhatsAppChannelType | null =
    rawChannel === "socio_direto" ||
    rawChannel === "provavel_socio" ||
    rawChannel === "recepcao_comercial" ||
    rawChannel === "indefinido"
      ? rawChannel
      : null;

  const primaryPhone = asNonEmptyString(r.telefone) || asNonEmptyString(r.remoteJid);
  const altPhones = resolveAlternativePhones(primaryPhone, overrides, enr);
  const firstAlt = altPhones[0] ?? null;

  const rawCnpj = Object.prototype.hasOwnProperty.call(overrides, "cnpj")
    ? asNonEmptyString(overrides.cnpj)
    : asNonEmptyString(enr.cnpj);
  const cnpjDigits = rawCnpj ? rawCnpj.replace(/\D/g, "") : "";
  const cnpj = cnpjDigits.length === 14 ? formatCnpj(cnpjDigits) : rawCnpj;

  const rawPorte = Object.prototype.hasOwnProperty.call(overrides, "porte")
    ? asNonEmptyString(overrides.porte)
    : asNonEmptyString(enr.porte);
  const porte = rawPorte && rawPorte !== "Não informado" ? rawPorte : null;

  const anosNum = asFiniteNumber(enr.anosEmpresa);
  const anosEmpresa = anosNum !== null && anosNum >= 0 ? Math.floor(anosNum) : null;

  const anoGoogle = resolveLeadGoogleYear({
    yearEstablished: (r.year_established as string | number | null | undefined) ?? null,
  });

  const rawHealth = enr.siteHealth;
  const website = asNonEmptyString(r.website);
  const siteHealth: SiteHealthStatus | null =
    rawHealth === "no_site" ||
    rawHealth === "broken_site" ||
    rawHealth === "weak_site" ||
    rawHealth === "active_site"
      ? rawHealth
      : website === null && Object.keys(enr).length > 0
        ? "no_site"
        : null;

  const siteStatusLabel = asNonEmptyString(enr.siteStatusLabel);
  const trafficTags = asStringArray(enr.trafficTags, 5);
  const hasPaidTraffic = enr.hasPaidTrafficTag === true || trafficTags.length > 0;
  const managementTools = asStringArray(enr.managementTools, 6);

  const intel = asRecord(r.intelligence);
  const rawScore =
    asFiniteNumber(enr.qualificationScore) ??
    asFiniteNumber(r.icp_score) ??
    asFiniteNumber(intel.icp_score);
  const qualificationScore =
    rawScore !== null && rawScore >= 0 && rawScore <= 100 ? Math.round(rawScore) : null;

  const servicoPrincipal = Object.prototype.hasOwnProperty.call(overrides, "servicoPrincipal")
    ? asNonEmptyString(overrides.servicoPrincipal)
    : asNonEmptyString(enr.servicoPrincipal);

  const aiDossierMode = parseLeadAiDossierMode(overrides.aiDossierMode);

  let richSignalsCount = 0;
  if (socioDecisor) richSignalsCount++;
  if (canalWhatsapp && canalWhatsapp !== "indefinido") richSignalsCount++;
  if (firstAlt) richSignalsCount++;
  if (cnpj) richSignalsCount++;
  if (porte || anosEmpresa !== null || anoGoogle !== null) richSignalsCount++;
  if (siteHealth) richSignalsCount++;
  if (hasPaidTraffic) richSignalsCount++;
  if (managementTools.length > 0) richSignalsCount++;
  if (servicoPrincipal) richSignalsCount++;

  return {
    socioDecisor,
    primeiroNomeSocio,
    canalWhatsapp,
    canalLabel: formatChannelBadgeLabel(canalWhatsapp),
    telefoneAlternativo: firstAlt?.telefone ?? null,
    telefoneAlternativoFormatted: firstAlt?.formatted ?? null,
    telefoneAlternativoLabel: firstAlt?.label ?? null,
    cnpj,
    porte,
    anosEmpresa,
    anoGoogle,
    siteHealth,
    siteStatusLabel,
    hasPaidTraffic,
    trafficTags,
    managementTools,
    qualificationScore,
    servicoPrincipal,
    aiDossierMode,
    richSignalsCount,
  };
}

/**
 * Extrai o dossiê completo de uma linha de `leads_extraidos` para a Ficha CRM e IA.
 */
export function extractFullLeadCrmDossier(row: Record<string, unknown> | null | undefined): LeadCrmDossier {
  const r = asRecord(row);
  const bd = asRecord(r.business_details);
  const enr = asRecord(bd.enrichment) as Partial<LeadEnrichmentData>;
  const overrides = asRecord(bd.crm_overrides);
  const summary = extractLeadCrmSummary(r);

  const primaryPhone = asNonEmptyString(r.telefone) || asNonEmptyString(r.remoteJid);
  const telefonesAlternativos = resolveAlternativePhones(primaryPhone, overrides, enr);

  const socios: CnpjPartner[] = Array.isArray(enr.socios)
    ? enr.socios
        .filter((s): s is CnpjPartner => Boolean(s && typeof s === "object" && typeof s.nome === "string" && s.nome.trim()))
        .slice(0, 6)
    : [];

  const capitalNum = asFiniteNumber(enr.capitalSocial);
  const capitalSocial = capitalNum !== null && capitalNum > 0 ? capitalNum : null;

  const topEmail = asNonEmptyString(r.email);
  const enrEmail = asNonEmptyString(enr.emailValidado);
  const emailValidado = topEmail || enrEmail;
  const emailSource: "site_html" | "cnpj_receita" | "manual" | null = topEmail
    ? enrEmail === topEmail && (enr.emailSource === "site_html" || enr.emailSource === "cnpj_receita")
      ? enr.emailSource
      : "manual"
    : enr.emailSource === "site_html" || enr.emailSource === "cnpj_receita"
      ? enr.emailSource
      : null;

  const abandonedNum = asFiniteNumber(enr.abandonedCopyrightYear);
  const photosNum = asFiniteNumber(r.total_photo_count);

  const horarioFuncionamento = formatOpeningHoursCompact(r.opening_hours);
  const priceRange = asNonEmptyString(r.price_range);
  const topicosAvaliacoes = extractReviewTopicsList(r.review_topics);
  const claimed = typeof r.claimed === "boolean" ? r.claimed : null;
  const cnaeDescricao = asNonEmptyString(enr.cnaeDescricao);
  const razaoSocial = asNonEmptyString(enr.razaoSocial);

  let extraSignals = summary.richSignalsCount;
  if (capitalSocial !== null) extraSignals++;
  if (horarioFuncionamento) extraSignals++;
  if (topicosAvaliacoes.length > 0) extraSignals++;
  if (cnaeDescricao) extraSignals++;

  return {
    ...summary,
    richSignalsCount: extraSignals,
    faixaEtariaSocio: asNonEmptyString(enr.faixaEtariaSocio) || socios[0]?.faixaEtaria || null,
    socios,
    razaoSocial,
    situacaoCadastral: asNonEmptyString(enr.situacaoCadastral),
    capitalSocial,
    cnaeDescricao,
    emailValidado,
    emailSource,
    telefonesAlternativos,
    siteDiagnostico: asNonEmptyString(enr.siteDiagnostico),
    discoveredRealWebsite: asNonEmptyString(enr.discoveredRealWebsite),
    abandonedCopyrightYear: abandonedNum !== null && abandonedNum > 1990 ? Math.floor(abandonedNum) : null,
    isFranchise: enr.isFranchise === true,
    claimed,
    ownerActiveOnMaps: enr.ownerActiveOnMaps === true,
    horarioFuncionamento,
    priceRange,
    totalPhotos: photosNum !== null && photosNum >= 0 ? Math.floor(photosNum) : null,
    topicosAvaliacoes,
    qualificationReasons: asStringArray(enr.qualificationReasons, 8),
    enrichedAt: asNonEmptyString(enr.enrichedAt),
  };
}

/**
 * Valida e normaliza o payload `crm_profile` de edição discreta na Ficha CRM.
 */
export function validateAndNormalizeCrmProfilePatch(
  rawInput: unknown,
): ValidatedCrmProfilePatch | InvalidCrmProfilePatch {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return { ok: false, error: "Dados de perfil CRM inválidos." };
  }
  const input = rawInput as CrmProfilePatchInput;
  const topLevelColumns: Record<string, string | null> = {};
  const overridesPatch: Partial<LeadCrmOverrides> = {};
  let touched = false;

  if ("socio_decisor" in input) {
    touched = true;
    if (input.socio_decisor === null || input.socio_decisor === "") {
      topLevelColumns.owner_name = null;
      overridesPatch.socioDecisor = null;
      overridesPatch.primeiroNomeSocio = null;
    } else if (typeof input.socio_decisor === "string" && input.socio_decisor.trim().length <= 160) {
      const clean = input.socio_decisor.trim();
      topLevelColumns.owner_name = clean || null;
      overridesPatch.socioDecisor = clean || null;
      overridesPatch.primeiroNomeSocio = clean ? clean.split(/\s+/)[0] || null : null;
    } else {
      return { ok: false, error: "Nome do sócio/decisor inválido (máximo 160 caracteres)." };
    }
  }

  if ("canal_whatsapp" in input) {
    touched = true;
    const val = input.canal_whatsapp;
    if (val === null || val === "") {
      overridesPatch.canalWhatsapp = null;
    } else if (
      typeof val === "string" &&
      (VALID_WHATSAPP_CHANNEL_TYPES as readonly string[]).includes(val)
    ) {
      overridesPatch.canalWhatsapp = val as WhatsAppChannelType;
    } else {
      return { ok: false, error: "Classificação de canal WhatsApp inválida." };
    }
  }

  if ("telefone_alternativo" in input) {
    touched = true;
    const val = input.telefone_alternativo;
    if (val === null || val === "") {
      overridesPatch.telefoneAlternativo = null;
    } else if (typeof val === "string" && val.trim().length <= 32) {
      const trimmed = val.trim();
      if (!trimmed) {
        overridesPatch.telefoneAlternativo = null;
      } else {
        const norm = normalizeBrPhoneDigits(trimmed);
        const digits = trimmed.replace(/\D/g, "");
        const resolved = norm ? toModern13DigitBrMobile(norm) || norm : digits;
        if (resolved.length < 10 || resolved.length > 15) {
          return { ok: false, error: "Telefone reserva inválido (informe DDD + número)." };
        }
        overridesPatch.telefoneAlternativo = resolved;
      }
    } else {
      return { ok: false, error: "Telefone reserva inválido." };
    }
  }

  if ("cnpj" in input) {
    touched = true;
    const val = input.cnpj;
    if (val === null || val === "") {
      overridesPatch.cnpj = null;
    } else if (typeof val === "string" && val.trim().length <= 24) {
      const trimmed = val.trim();
      if (!trimmed) {
        overridesPatch.cnpj = null;
      } else {
        const digits = trimmed.replace(/\D/g, "");
        if (!isValidCnpj(digits)) {
          return { ok: false, error: "CNPJ inválido (verifique os 14 dígitos)." };
        }
        overridesPatch.cnpj = digits;
      }
    } else {
      return { ok: false, error: "CNPJ inválido." };
    }
  }

  if ("email" in input) {
    touched = true;
    const val = input.email;
    if (val === null || val === "") {
      topLevelColumns.email = null;
    } else if (typeof val === "string" && val.trim().length <= 180) {
      const clean = val.trim().toLowerCase();
      if (!clean) {
        topLevelColumns.email = null;
      } else if (!isValidBusinessEmail(clean) && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean)) {
        return { ok: false, error: "E-mail inválido." };
      } else {
        topLevelColumns.email = clean;
      }
    } else {
      return { ok: false, error: "E-mail inválido (máximo 180 caracteres)." };
    }
  }

  for (const col of ["website", "instagram", "facebook"] as const) {
    if (col in input) {
      touched = true;
      const val = input[col];
      if (val === null || val === "") {
        topLevelColumns[col] = null;
      } else if (typeof val === "string" && val.trim().length <= 300) {
        topLevelColumns[col] = val.trim() || null;
      } else {
        return { ok: false, error: `Campo ${col} inválido (máximo 300 caracteres).` };
      }
    }
  }

  if ("porte" in input) {
    touched = true;
    const val = input.porte;
    if (val === null || val === "") {
      overridesPatch.porte = null;
    } else if (typeof val === "string" && val.trim().length <= 80) {
      overridesPatch.porte = val.trim() || null;
    } else {
      return { ok: false, error: "Porte empresarial inválido (máximo 80 caracteres)." };
    }
  }

  if ("servico_principal" in input) {
    touched = true;
    const val = input.servico_principal;
    if (val === null || val === "") {
      overridesPatch.servicoPrincipal = null;
    } else if (typeof val === "string" && val.trim().length <= 140) {
      overridesPatch.servicoPrincipal = val.trim() || null;
    } else {
      return { ok: false, error: "Serviço principal inválido (máximo 140 caracteres)." };
    }
  }

  if ("ai_dossier_mode" in input) {
    touched = true;
    const val = input.ai_dossier_mode;
    if (
      typeof val === "string" &&
      (LEAD_AI_DOSSIER_MODES as readonly string[]).includes(val)
    ) {
      overridesPatch.aiDossierMode = val as LeadAiDossierMode;
    } else {
      return { ok: false, error: "Modo de uso pela IA inválido." };
    }
  }

  if (!touched) {
    return { ok: false, error: "Nenhum campo de perfil informado." };
  }

  overridesPatch.updatedAt = new Date().toISOString();
  return { ok: true, topLevelColumns, overridesPatch };
}

