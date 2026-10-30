import fs from "fs";
import os from "os";
import path from "path";
import JSZip from "jszip";

export interface MapsKitReview {
  autor?: string;
  nota?: string | number;
  data?: string;
  texto?: string;
  fotoAutor?: string;
  fotos?: string[];
  respostaDono?: string;
  util?: number;
}

export interface MapsKitAddressComponents {
  rua?: string;
  numero?: string;
  bairro?: string;
  cidade?: string;
  estado?: string;
  cep?: string;
  pais?: string;
}

export interface ScrapedMapsKitData {
  name?: string;
  categories?: string;
  additionalCategories?: string[];
  averageRating?: string;
  reviewCount?: string;
  distribuicaoEstrelas?: Record<string, number>;
  fullAddress?: string;
  addressComponents?: MapsKitAddressComponents;
  cep?: string;
  plusCode?: string;
  lat?: string;
  lng?: string;
  placeId?: string;
  mapsUrl?: string;
  phone?: string;
  website?: string;
  instagram?: string;
  facebook?: string;
  redesAdicionais?: Record<string, string>;
  menuUrl?: string;
  reservaUrl?: string;
  priceRange?: string;
  openNow?: string;
  businessStatus?: string;
  claimed?: boolean;
  ownerName?: string;
  yearEstablished?: string;
  totalPhotoCount?: number | null;
  openingHours?: Record<string, string>;
  popularTimes?: Record<string, unknown>;
  about?: string;
  descricao?: string;
  services?: string[];
  subcategorias?: string[];
  pessoasProcuramPor?: string[];
  attributes?: string[];
  attributeSections?: Record<string, string[]>;
  reviewTopics?: Record<string, string>;
  featuredReviews?: string[];
  reviews?: MapsKitReview[];
  photos?: string[];
}

export interface EnrichedLeadKitData {
  id: string | number;
  nomeNegocio: string;
  ramoNegocio: string;
  categoriasAdicionais: string[];
  telefone: string;
  remoteJid: string;
  email: string;
  endereco: string;
  addressComponents: MapsKitAddressComponents;
  cep: string;
  plusCode: string;
  lat: string;
  lng: string;
  placeId: string;
  mapsUrl: string;
  website: string;
  instagram: string;
  facebook: string;
  redesAdicionais: Record<string, string>;
  menuUrl: string;
  reservaUrl: string;
  avaliacao: string;
  totalAvaliacoes: string;
  distribuicaoEstrelas: Record<string, number>;
  faixaPreco: string;
  abertoAgora: string;
  statusOperacional: string;
  fichaReivindicada: boolean | null;
  proprietario: string;
  anoFundacao: string;
  horariosFuncionamento: Record<string, string>;
  horariosPico: Record<string, unknown>;
  sobre: string;
  descricao: string;
  servicos: string[];
  subcategorias: string[];
  pessoasProcuramPor: string[];
  atributos: string[];
  atributosPorSecao: Record<string, string[]>;
  topicosAvaliacoes: Record<string, string>;
  avaliacoesDestaque: string[];
  avaliacoesDetalhes: MapsKitReview[];
  fotosUrls: string[];
  totalFotosDeclarado: number | null;
  resumoIa: string;
  justificativaIa: string;
  briefingIa: string;
  doresIa: string[];
  abordagemIa: string;
  observacoesCrm: string;
  profilePicUrl: string;
}

export interface DownloadedPhotoInfo {
  fileName: string;
  originalUrl: string;
  resolvedUrl: string;
  mimeType: string;
  sizeBytes: number;
  data: Buffer;
}

export interface BuildLeadMapsKitResult {
  buffer: Buffer;
  fileName: string;
  photoCount: number;
  txtContent: string;
  enrichedData: EnrichedLeadKitData;
  dbPatch: Record<string, unknown>;
}

/**
 * Identifica se uma URL de imagem do Google pertence a uma foto real do estabelecimento
 * (excluindo avatares de perfis de avaliadores `/a/` ou `/a-/`, ícones estáticos minúsculos, etc.).
 */
export function isGooglePlacePhotoUrl(rawUrl: string | null | undefined): boolean {
  if (!rawUrl || typeof rawUrl !== "string") return false;
  const trimmed = rawUrl.trim();
  const normalized = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  if (!/^https?:\/\//i.test(normalized)) return false;

  const lower = normalized.toLowerCase();
  const isGoogleHost =
    lower.includes("googleusercontent.com") ||
    lower.includes("ggpht.com") ||
    lower.includes("googleapis.com/v1/thumbnail");
  if (!isGoogleHost) return false;

  // Exclui avatares de contas de usuários do Google (reviews/perfis)
  if (/googleusercontent\.com\/a-?\//i.test(lower)) return false;
  if (/ggpht\.com\/a-?\//i.test(lower)) return false;

  // Exclui ícones estáticos ou tiles de mapa vetorial
  if (lower.includes("/vt/") || lower.includes("maps.gstatic.com")) return false;

  // Exclui miniaturas quadradas de avatar explícitas (ex: =s32-c, =s40-c, =w36-h36)
  if (/=[sw](?:16|20|24|28|32|36|40|44|48|50|60|64)(?:-h\d+)?(?:-p)?-c\b/i.test(lower)) {
    return false;
  }

  return true;
}

/**
 * Chave canônica da foto (sem sufixos de redimensionamento `=w...` ou `=s...`)
 * para deduplicar a mesma imagem capturada em resoluções diferentes.
 */
export function getGooglePhotoBaseKey(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  const normalized = trimmed.startsWith("//") ? `https:${trimmed}` : trimmed;
  if (normalized.includes("googleusercontent.com") || normalized.includes("ggpht.com")) {
    return normalized.split("=")[0];
  }
  try {
    const parsed = new URL(normalized);
    parsed.searchParams.delete("w");
    parsed.searchParams.delete("h");
    return parsed.toString();
  } catch {
    return normalized;
  }
}

/**
 * Gera URLs candidatas em alta resolução para uma foto do Google Maps,
 * em ordem de prioridade (alta resolução -> resolução média -> URL original).
 */
export function toHighResGooglePhotoUrls(rawUrl: string): string[] {
  const rawTrimmed = rawUrl.trim();
  if (!rawTrimmed) return [];
  const trimmed = rawTrimmed.startsWith("//") ? `https:${rawTrimmed}` : rawTrimmed;

  if (trimmed.includes("googleusercontent.com") || trimmed.includes("ggpht.com")) {
    const base = trimmed.split("=")[0];
    const candidates = [
      `${base}=w1600-h1200-k-no`,
      `${base}=s1600-k-no`,
      `${base}=w1200-h900-k-no`,
      `${base}=s1200`,
      `${base}=w800-h600-k-no`,
      ...(trimmed.includes("=") ? [trimmed] : []),
      `${base}=s1024`,
      base,
    ];
    return Array.from(new Set(candidates));
  }

  if (trimmed.includes("streetviewpixels-pa.googleapis.com")) {
    const hiRes = trimmed
      .replace(/([?&])w=\d+/i, "$1w=1600")
      .replace(/([?&])h=\d+/i, "$1h=1200");
    return Array.from(new Set([hiRes, trimmed]));
  }

  return [trimmed];
}

export function slugifyFileName(input: string): string {
  const clean = (input || "estabelecimento")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return clean || "estabelecimento";
}

function asNonEmptyString(val: unknown): string {
  if (typeof val === "string") return val.trim();
  if (typeof val === "number" && Number.isFinite(val)) return String(val);
  return "";
}

function asStringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0);
}

function asStringRecord(val: unknown): Record<string, string> {
  if (!val || typeof val !== "object" || Array.isArray(val)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
    const str = asNonEmptyString(v);
    if (k.trim() && str) out[k.trim()] = str;
  }
  return out;
}

/**
 * Mescla todos os dados já salvos no banco (`leads_extraidos`) com os dados
 * recém-extraídos do Google Maps (`scraped`), preservando o máximo de informações.
 */
export function mergeMapsKitData(
  dbLead: Record<string, unknown>,
  scraped?: Partial<ScrapedMapsKitData> | null
): EnrichedLeadKitData {
  const s = scraped || {};
  const bd =
    dbLead.business_details && typeof dbLead.business_details === "object" && !Array.isArray(dbLead.business_details)
      ? (dbLead.business_details as Record<string, unknown>)
      : {};
  const intel =
    dbLead.intelligence && typeof dbLead.intelligence === "object" && !Array.isArray(dbLead.intelligence)
      ? (dbLead.intelligence as Record<string, unknown>)
      : {};
  const dbAddr =
    dbLead.address_components && typeof dbLead.address_components === "object" && !Array.isArray(dbLead.address_components)
      ? (dbLead.address_components as Record<string, unknown>)
      : {};

  const nomeNegocio =
    asNonEmptyString(dbLead.nome_negocio) ||
    asNonEmptyString(s.name) ||
    "Estabelecimento";

  const ramoNegocio =
    asNonEmptyString(dbLead.ramo_negocio) ||
    asNonEmptyString(dbLead.categoria) ||
    asNonEmptyString(s.categories) ||
    "Comércio / Serviços";

  const categoriasAdicionais = Array.from(
    new Set([
      ...asStringArray(s.additionalCategories),
      ...asStringArray(dbLead.additional_categories),
    ])
  ).filter((c) => c.toLowerCase() !== ramoNegocio.toLowerCase());

  const telefone =
    asNonEmptyString(dbLead.telefone) ||
    asNonEmptyString(s.phone);

  const remoteJid = asNonEmptyString(dbLead.remoteJid);
  const email = asNonEmptyString(dbLead.email);

  const endereco =
    asNonEmptyString(s.fullAddress) ||
    asNonEmptyString(dbLead.endereco);

  const addressComponents: MapsKitAddressComponents = {
    rua: asNonEmptyString(s.addressComponents?.rua) || asNonEmptyString(dbAddr.rua) || undefined,
    numero: asNonEmptyString(s.addressComponents?.numero) || asNonEmptyString(dbAddr.numero) || undefined,
    bairro: asNonEmptyString(s.addressComponents?.bairro) || asNonEmptyString(dbAddr.bairro) || undefined,
    cidade: asNonEmptyString(s.addressComponents?.cidade) || asNonEmptyString(dbAddr.cidade) || undefined,
    estado: asNonEmptyString(s.addressComponents?.estado) || asNonEmptyString(dbAddr.estado) || undefined,
    cep: asNonEmptyString(s.addressComponents?.cep) || asNonEmptyString(dbAddr.cep) || asNonEmptyString(s.cep) || asNonEmptyString(dbLead.cep) || undefined,
    pais: asNonEmptyString(s.addressComponents?.pais) || asNonEmptyString(dbAddr.pais) || "Brasil",
  };

  const cep =
    addressComponents.cep ||
    asNonEmptyString(s.cep) ||
    asNonEmptyString(dbLead.cep);

  const plusCode =
    asNonEmptyString(s.plusCode) ||
    asNonEmptyString(dbLead.plus_code) ||
    asNonEmptyString(bd.plusCode);

  const lat =
    asNonEmptyString(s.lat) ||
    asNonEmptyString(dbLead.lat) ||
    asNonEmptyString(bd.lat);

  const lng =
    asNonEmptyString(s.lng) ||
    asNonEmptyString(dbLead.lng) ||
    asNonEmptyString(bd.lng);

  const placeId =
    asNonEmptyString(s.placeId) ||
    asNonEmptyString(dbLead.place_id) ||
    asNonEmptyString(bd.placeId);

  const fallbackMapsQuery = encodeURIComponent(`${nomeNegocio} ${endereco}`.trim());
  const mapsUrl =
    asNonEmptyString(s.mapsUrl) ||
    asNonEmptyString(dbLead.maps_url) ||
    `https://www.google.com/maps/search/?api=1&query=${fallbackMapsQuery}`;

  const website =
    asNonEmptyString(dbLead.website) ||
    asNonEmptyString(s.website) ||
    asNonEmptyString((intel.sources as Record<string, unknown> | undefined)?.site_url);

  const instagram =
    asNonEmptyString(dbLead.instagram) ||
    asNonEmptyString(s.instagram) ||
    asNonEmptyString((intel.sources as Record<string, unknown> | undefined)?.instagram_url);

  const facebook =
    asNonEmptyString(dbLead.facebook) ||
    asNonEmptyString(s.facebook) ||
    asNonEmptyString((intel.sources as Record<string, unknown> | undefined)?.facebook_url);

  const redesAdicionais: Record<string, string> = {
    ...asStringRecord(bd.redesAdicionais),
    ...(s.redesAdicionais || {}),
  };

  const menuUrl =
    asNonEmptyString(s.menuUrl) ||
    asNonEmptyString(bd.menuUrl);

  const reservaUrl =
    asNonEmptyString(s.reservaUrl) ||
    asNonEmptyString(bd.reservaUrl);

  const avaliacao =
    asNonEmptyString(s.averageRating) ||
    asNonEmptyString(dbLead.avaliacao) ||
    asNonEmptyString(dbLead.rating);

  const totalAvaliacoes =
    asNonEmptyString(s.reviewCount) ||
    asNonEmptyString(dbLead.reviews);

  const distribuicaoEstrelas: Record<string, number> = {};
  const rawDist = s.distribuicaoEstrelas || (dbLead.distribuicao_estrelas as Record<string, unknown> | undefined);
  if (rawDist && typeof rawDist === "object" && !Array.isArray(rawDist)) {
    for (const [k, v] of Object.entries(rawDist)) {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) distribuicaoEstrelas[k] = n;
    }
  }

  const faixaPreco =
    asNonEmptyString(s.priceRange) ||
    asNonEmptyString(dbLead.price_range);

  const abertoAgora =
    asNonEmptyString(s.openNow) ||
    asNonEmptyString(dbLead.open_now);

  const statusOperacional =
    asNonEmptyString(s.businessStatus) ||
    asNonEmptyString(dbLead.business_status) ||
    "Operacional";

  const fichaReivindicada =
    typeof s.claimed === "boolean"
      ? s.claimed
      : typeof dbLead.claimed === "boolean"
        ? dbLead.claimed
        : null;

  const proprietario =
    asNonEmptyString(s.ownerName) ||
    asNonEmptyString(dbLead.owner_name);

  const anoFundacao =
    asNonEmptyString(s.yearEstablished) ||
    asNonEmptyString(dbLead.year_established);

  // Horários de funcionamento: mescla banco + extraído ao vivo
  const dbHours = asStringRecord(dbLead.opening_hours);
  const scrapedHours = asStringRecord(s.openingHours);
  const horariosFuncionamento: Record<string, string> = {
    ...dbHours,
    ...scrapedHours,
  };
  if (Object.keys(horariosFuncionamento).length > 1 && "raw" in horariosFuncionamento) {
    delete horariosFuncionamento.raw;
  }

  const horariosPico: Record<string, unknown> =
    (s.popularTimes && Object.keys(s.popularTimes).length > 0
      ? s.popularTimes
      : bd.popularTimes && typeof bd.popularTimes === "object" && !Array.isArray(bd.popularTimes)
        ? (bd.popularTimes as Record<string, unknown>)
        : {});

  const sobre =
    asNonEmptyString(s.about) ||
    asNonEmptyString(bd.about);

  const descricao =
    asNonEmptyString(s.descricao) ||
    asNonEmptyString(bd.descricao);

  const servicos = Array.from(
    new Set([
      ...asStringArray(s.services),
      ...asStringArray(bd.services),
    ])
  );

  const subcategorias = Array.from(
    new Set([
      ...asStringArray(s.subcategorias),
      ...asStringArray(bd.subcategorias),
    ])
  );

  const pessoasProcuramPor = Array.from(
    new Set([
      ...asStringArray(s.pessoasProcuramPor),
      ...asStringArray(bd.pessoasProcuramPor),
    ])
  );

  const atributos = Array.from(
    new Set([
      ...asStringArray(s.attributes),
      ...asStringArray(dbLead.attributes),
    ])
  );

  const atributosPorSecao: Record<string, string[]> = {};
  const existingSections =
    bd.attributeSections && typeof bd.attributeSections === "object" && !Array.isArray(bd.attributeSections)
      ? (bd.attributeSections as Record<string, unknown>)
      : {};
  for (const [sec, items] of Object.entries(existingSections)) {
    const arr = asStringArray(items);
    if (arr.length > 0) atributosPorSecao[sec] = arr;
  }
  if (s.attributeSections) {
    for (const [sec, items] of Object.entries(s.attributeSections)) {
      const arr = asStringArray(items);
      if (arr.length > 0) {
        atributosPorSecao[sec] = Array.from(new Set([...(atributosPorSecao[sec] || []), ...arr]));
      }
    }
  }

  const topicosAvaliacoes: Record<string, string> = {
    ...asStringRecord(dbLead.review_topics),
    ...(s.reviewTopics || {}),
  };

  const avaliacoesDestaque = Array.from(
    new Set([
      ...asStringArray(s.featuredReviews),
      ...asStringArray(dbLead.featured_reviews),
    ])
  );

  // Reviews detalhadas (deduplicadas pelo início do texto)
  const rawReviews: unknown[] = [
    ...(Array.isArray(s.reviews) ? s.reviews : []),
    ...(Array.isArray(dbLead.reviews_detalhes) ? dbLead.reviews_detalhes : []),
  ];
  const seenReviewSigs = new Set<string>();
  const avaliacoesDetalhes: MapsKitReview[] = [];
  for (const item of rawReviews) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const texto = asNonEmptyString(r.texto) || asNonEmptyString(r.text);
    if (!texto) continue;
    const sig = texto.slice(0, 80).toLowerCase();
    if (seenReviewSigs.has(sig)) continue;
    seenReviewSigs.add(sig);
    avaliacoesDetalhes.push({
      autor: asNonEmptyString(r.autor) || asNonEmptyString(r.author) || "Cliente Google",
      nota: asNonEmptyString(r.nota) || asNonEmptyString(r.rating) || "",
      data: asNonEmptyString(r.data) || asNonEmptyString(r.date) || "",
      texto,
      fotoAutor: asNonEmptyString(r.fotoAutor) || undefined,
      fotos: asStringArray(r.fotos),
      respostaDono: asNonEmptyString(r.respostaDono) || undefined,
      util: typeof r.util === "number" ? r.util : undefined,
    });
    if (avaliacoesDetalhes.length >= 40) break;
  }

  // Fotos do estabelecimento: mescla fotos ao vivo + fotos salvas + fotos anexadas em avaliações
  const reviewAttachedPhotos: string[] = [];
  for (const rv of avaliacoesDetalhes) {
    if (rv.fotos) {
      for (const p of rv.fotos) {
        if (isGooglePlacePhotoUrl(p)) reviewAttachedPhotos.push(p);
      }
    }
  }

  const rawPhotoCandidates = [
    ...asStringArray(s.photos),
    ...asStringArray(dbLead.photos),
    ...reviewAttachedPhotos,
  ];
  const seenPhotoKeys = new Set<string>();
  const fotosUrls: string[] = [];
  for (const url of rawPhotoCandidates) {
    if (!isGooglePlacePhotoUrl(url)) continue;
    const key = getGooglePhotoBaseKey(url);
    if (seenPhotoKeys.has(key)) continue;
    seenPhotoKeys.add(key);
    fotosUrls.push(url);
    if (fotosUrls.length >= 120) break;
  }

  const totalFotosDeclarado =
    typeof s.totalPhotoCount === "number" && s.totalPhotoCount > 0
      ? s.totalPhotoCount
      : typeof dbLead.total_photo_count === "number" && dbLead.total_photo_count > 0
        ? dbLead.total_photo_count
        : fotosUrls.length > 0
          ? fotosUrls.length
          : null;

  return {
    id: (dbLead.id as string | number) ?? "",
    nomeNegocio,
    ramoNegocio,
    categoriasAdicionais,
    telefone,
    remoteJid,
    email,
    endereco,
    addressComponents,
    cep,
    plusCode,
    lat,
    lng,
    placeId,
    mapsUrl,
    website,
    instagram,
    facebook,
    redesAdicionais,
    menuUrl,
    reservaUrl,
    avaliacao,
    totalAvaliacoes,
    distribuicaoEstrelas,
    faixaPreco,
    abertoAgora,
    statusOperacional,
    fichaReivindicada,
    proprietario,
    anoFundacao,
    horariosFuncionamento,
    horariosPico,
    sobre,
    descricao,
    servicos,
    subcategorias,
    pessoasProcuramPor,
    atributos,
    atributosPorSecao,
    topicosAvaliacoes,
    avaliacoesDestaque,
    avaliacoesDetalhes,
    fotosUrls,
    totalFotosDeclarado,
    resumoIa: asNonEmptyString(dbLead.resumo_ia),
    justificativaIa: asNonEmptyString(dbLead.justificativa_ia),
    briefingIa: asNonEmptyString(intel.briefing_md),
    doresIa: asStringArray(intel.dores),
    abordagemIa: asNonEmptyString(intel.abordagem),
    observacoesCrm: asNonEmptyString(dbLead.observacoes),
    profilePicUrl: asNonEmptyString(dbLead.profilePicUrl),
  };
}

function normalizePhoneDigits(phone: string, remoteJid: string): string {
  const fromPhone = (phone || "").replace(/\D/g, "");
  const fromJid = (remoteJid || "").replace(/@.*$/, "").replace(/\D/g, "");
  const raw = fromPhone.length >= 10 ? fromPhone : fromJid;
  if (!raw) return "";
  if (raw.length >= 10 && raw.length <= 11 && !raw.startsWith("55")) {
    return `55${raw}`;
  }
  return raw;
}

/**
 * Gera o conteúdo completo do arquivo `INFORMACOES-DO-NEGOCIO.txt` estruturado
 * para alimentar e enriquecer a criação de sites profissionais.
 */
export function formatLeadKitTxt(
  data: EnrichedLeadKitData,
  downloadedPhotos: Pick<DownloadedPhotoInfo, "fileName" | "originalUrl" | "sizeBytes">[]
): string {
  const lines: string[] = [];
  const hr = "================================================================================";
  const subHr = "--------------------------------------------------------------------------------";

  const phoneDigits = normalizePhoneDigits(data.telefone, data.remoteJid);
  const whatsappUrl = phoneDigits ? `https://wa.me/${phoneDigits}` : "";
  const whatsappCtaUrl = phoneDigits
    ? `https://wa.me/${phoneDigits}?text=${encodeURIComponent(`Olá! Vi o site da ${data.nomeNegocio} e gostaria de mais informações.`)}`
    : "";

  const destinationQuery = data.lat && data.lng
    ? `${data.lat},${data.lng}`
    : encodeURIComponent(`${data.nomeNegocio} ${data.endereco}`.trim());
  const directionsUrl = `https://www.google.com/maps/dir/?api=1&destination=${destinationQuery}`;
  const embedQuery = encodeURIComponent(`${data.nomeNegocio} ${data.endereco}`.trim() || data.nomeNegocio);
  const mapsEmbedHtml = `<iframe src="https://www.google.com/maps?q=${embedQuery}&output=embed" width="100%" height="450" style="border:0;" allowfullscreen="" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>`;

  lines.push(hr);
  lines.push(`KIT COMPLETO PARA CRIAÇÃO DE SITE — ${data.nomeNegocio.toUpperCase()}`);
  lines.push(`Extraído em: ${new Date().toLocaleString("pt-BR")}`);
  lines.push(hr);
  lines.push("");

  // 1. IDENTIFICAÇÃO DO NEGÓCIO
  lines.push("1. IDENTIFICAÇÃO DO ESTABELECIMENTO");
  lines.push(subHr);
  lines.push(`Nome do Lugar / Empresa: ${data.nomeNegocio}`);
  lines.push(`Categoria / Nicho Principal: ${data.ramoNegocio}`);
  if (data.categoriasAdicionais.length > 0) {
    lines.push(`Categorias Secundárias: ${data.categoriasAdicionais.join(" | ")}`);
  }
  if (data.subcategorias.length > 0) {
    lines.push(`Subcategorias / Especialidades: ${data.subcategorias.join(" | ")}`);
  }
  lines.push(`Status Operacional: ${data.statusOperacional}`);
  if (data.abertoAgora) lines.push(`Status no Momento da Extração: ${data.abertoAgora}`);
  if (data.faixaPreco) lines.push(`Faixa de Preço: ${data.faixaPreco}`);
  if (data.anoFundacao) lines.push(`Ano de Fundação: ${data.anoFundacao}`);
  if (data.proprietario) lines.push(`Proprietário / Responsável: ${data.proprietario}`);
  if (data.fichaReivindicada !== null) {
    lines.push(`Ficha Verificada pelo Proprietário no Google: ${data.fichaReivindicada ? "Sim" : "Não informada"}`);
  }
  lines.push("");

  // 2. CONTATOS, WHATSAPP E REDES SOCIAIS
  lines.push("2. CONTATOS, WHATSAPP E REDES SOCIAIS (PRONTOS PARA BOTÕES DO SITE)");
  lines.push(subHr);
  lines.push(`Telefone Exibido: ${data.telefone || "Não informado"}`);
  if (phoneDigits) {
    lines.push(`Telefone (Apenas Números): +${phoneDigits}`);
    lines.push(`Link para Ligar (href): tel:+${phoneDigits}`);
    lines.push(`Link Direto WhatsApp: ${whatsappUrl}`);
    lines.push(`Link WhatsApp com Mensagem Pronta (CTA): ${whatsappCtaUrl}`);
  }
  lines.push(`E-mail: ${data.email || "Não informado"}`);
  lines.push(`Website Atual: ${data.website || "Não possui / Não informado"}`);
  lines.push(`Instagram: ${data.instagram || "Não informado"}`);
  lines.push(`Facebook: ${data.facebook || "Não informado"}`);
  if (data.menuUrl) lines.push(`Link do Cardápio / Menu: ${data.menuUrl}`);
  if (data.reservaUrl) lines.push(`Link de Agendamento / Reserva: ${data.reservaUrl}`);
  for (const [rede, url] of Object.entries(data.redesAdicionais)) {
    lines.push(`${rede.charAt(0).toUpperCase() + rede.slice(1)}: ${url}`);
  }
  lines.push("");

  // 3. LOCALIZAÇÃO E GOOGLE MAPS
  lines.push("3. ENDEREÇO, LOCALIZAÇÃO E LINKS DO GOOGLE MAPS");
  lines.push(subHr);
  lines.push(`Endereço Completo: ${data.endereco || "Não informado"}`);
  if (data.addressComponents.rua) lines.push(`Logradouro / Rua: ${data.addressComponents.rua}`);
  if (data.addressComponents.numero) lines.push(`Número: ${data.addressComponents.numero}`);
  if (data.addressComponents.bairro) lines.push(`Bairro: ${data.addressComponents.bairro}`);
  if (data.addressComponents.cidade) lines.push(`Cidade: ${data.addressComponents.cidade}`);
  if (data.addressComponents.estado) lines.push(`Estado (UF): ${data.addressComponents.estado}`);
  if (data.cep) lines.push(`CEP: ${data.cep}`);
  if (data.plusCode) lines.push(`Plus Code (Google): ${data.plusCode}`);
  if (data.lat && data.lng) lines.push(`Coordenadas GPS (Lat, Lng): ${data.lat}, ${data.lng}`);
  if (data.placeId) lines.push(`Google Place ID: ${data.placeId}`);
  lines.push(`Link do Google Maps: ${data.mapsUrl}`);
  lines.push(`Link "Como Chegar" (Rotas no Maps): ${directionsUrl}`);
  lines.push(`Código Iframe (Mapa Embutido para o Site):`);
  lines.push(`  ${mapsEmbedHtml}`);
  lines.push("");

  // 4. HORÁRIO DE FUNCIONAMENTO
  lines.push("4. HORÁRIO DE FUNCIONAMENTO");
  lines.push(subHr);
  const hourEntries = Object.entries(data.horariosFuncionamento);
  if (hourEntries.length > 0) {
    for (const [dia, horario] of hourEntries) {
      const labelDia = dia === "raw" ? "Horário Geral" : dia.charAt(0).toUpperCase() + dia.slice(1);
      lines.push(`  • ${labelDia}: ${horario}`);
    }
  } else if (data.abertoAgora) {
    lines.push(`  • Status informado no Maps: ${data.abertoAgora}`);
  } else {
    lines.push("  • Horário detalhado não listado publicamente na ficha do Google Maps.");
  }

  if (Object.keys(data.horariosPico).length > 0) {
    lines.push("");
    lines.push("Movimentação / Horários de Pico:");
    for (const [dia, info] of Object.entries(data.horariosPico)) {
      if (typeof info === "string") {
        lines.push(`  • ${dia}: ${info}`);
      } else if (Array.isArray(info)) {
        const resumo = info
          .map((item) => {
            if (item && typeof item === "object") {
              const rec = item as Record<string, unknown>;
              return `${rec.hora}h (${rec.ocupacao}%)`;
            }
            return "";
          })
          .filter(Boolean)
          .join(", ");
        if (resumo) lines.push(`  • ${dia}: ${resumo}`);
      }
    }
  }
  lines.push("");

  // 5. SOBRE O NEGÓCIO, SERVIÇOS, COMODIDADES E DIFERENCIAIS
  lines.push("5. SOBRE O NEGÓCIO, SERVIÇOS, COMODIDADES E ATRIBUTOS");
  lines.push(subHr);
  if (data.sobre) {
    lines.push("Resumo / Sobre (Google Maps):");
    lines.push(data.sobre);
    lines.push("");
  }
  if (data.descricao && data.descricao !== data.sobre) {
    lines.push("Descrição Detalhada:");
    lines.push(data.descricao);
    lines.push("");
  }
  if (data.servicos.length > 0) {
    lines.push("Serviços / Itens Identificados:");
    for (const srv of data.servicos) {
      lines.push(`  • ${srv}`);
    }
    lines.push("");
  }
  if (Object.keys(data.atributosPorSecao).length > 0) {
    lines.push("Diferenciais, Estrutura e Comodidades (Aba Sobre do Google Maps):");
    for (const [secao, itens] of Object.entries(data.atributosPorSecao)) {
      lines.push(`  [${secao}]`);
      for (const item of itens) {
        lines.push(`    - ${item}`);
      }
    }
    lines.push("");
  } else if (data.atributos.length > 0) {
    lines.push("Atributos, Comodidades e Formas de Atendimento:");
    for (const attr of data.atributos) {
      lines.push(`  • ${attr}`);
    }
    lines.push("");
  }
  if (data.pessoasProcuramPor.length > 0) {
    lines.push(`Termos Relacionados ("As pessoas também buscam por"): ${data.pessoasProcuramPor.join(", ")}`);
    lines.push("");
  }
  if (
    !data.sobre &&
    !data.descricao &&
    data.servicos.length === 0 &&
    Object.keys(data.atributosPorSecao).length === 0 &&
    data.atributos.length === 0
  ) {
    lines.push(`Atuação principal em ${data.ramoNegocio}${data.addressComponents.cidade ? ` na região de ${data.addressComponents.cidade}` : ""}.`);
    lines.push("");
  }

  // 6. REPUTAÇÃO E DEPOIMENTOS REAIS DE CLIENTES
  lines.push("6. REPUTAÇÃO E AVALIAÇÕES DO GOOGLE MAPS (PROVA SOCIAL PARA O SITE)");
  lines.push(subHr);
  lines.push(`Nota Média no Google: ${data.avaliacao ? `${data.avaliacao} ★ (de 5.0)` : "Sem nota registrada"}`);
  lines.push(`Total de Avaliações: ${data.totalAvaliacoes || "0"}`);
  if (Object.keys(data.distribuicaoEstrelas).length > 0) {
    const distStr = ["5estrelas", "4estrelas", "3estrelas", "2estrelas", "1estrelas"]
      .filter((k) => k in data.distribuicaoEstrelas)
      .map((k) => `${k.replace("estrelas", "★")}: ${data.distribuicaoEstrelas[k]}`)
      .join(" | ");
    if (distStr) lines.push(`Distribuição das Notas: ${distStr}`);
  }
  if (Object.keys(data.topicosAvaliacoes).length > 0) {
    const topicosStr = Object.entries(data.topicosAvaliacoes)
      .map(([topico, nota]) => `${topico} (${nota})`)
      .join(" | ");
    lines.push(`Tópicos Mais Comentados pelos Clientes: ${topicosStr}`);
  }
  if (data.avaliacoesDestaque.length > 0) {
    lines.push("");
    lines.push("Destaques Selecionados pelo Google:");
    for (const dest of data.avaliacoesDestaque) {
      lines.push(`  "${dest}"`);
    }
  }
  if (data.avaliacoesDetalhes.length > 0) {
    lines.push("");
    lines.push(`Depoimentos Reais de Clientes (${data.avaliacoesDetalhes.length} coletados — ótimos para seção de Depoimentos):`);
    data.avaliacoesDetalhes.forEach((rv, idx) => {
      const estrelas = rv.nota ? ` — ${rv.nota}★` : "";
      const dataStr = rv.data ? ` (${rv.data})` : "";
      const textoLimpo = (rv.texto || "").replace(/\s+/g, " ").trim();
      lines.push(`  [${idx + 1}] ${rv.autor || "Cliente"}${estrelas}${dataStr}`);
      lines.push(`      "${textoLimpo}"`);
      if (rv.respostaDono) {
        lines.push(`      ↳ Resposta do estabelecimento: "${rv.respostaDono.replace(/\s+/g, " ").trim()}"`);
      }
    });
  }
  lines.push("");

  // 7. INTELIGÊNCIA IA & NOTAS DO CRM (SE DISPONÍVEL)
  if (data.resumoIa || data.briefingIa || data.justificativaIa || data.observacoesCrm || data.doresIa.length > 0) {
    lines.push("7. ANÁLISE DE INTELIGÊNCIA & OBSERVAÇÕES DO NEGÓCIO");
    lines.push(subHr);
    if (data.resumoIa) {
      lines.push(`Resumo das Avaliações / Percepção do Público (IA):`);
      lines.push(data.resumoIa);
      lines.push("");
    }
    if (data.justificativaIa) {
      lines.push(`Justificativa / Diagnóstico IA:`);
      lines.push(data.justificativaIa);
      lines.push("");
    }
    if (data.briefingIa) {
      lines.push(`Briefing Estratégico (Lead Intelligence):`);
      lines.push(data.briefingIa);
      lines.push("");
    }
    if (data.doresIa.length > 0) {
      lines.push(`Pontos de Atenção / Oportunidades: ${data.doresIa.join(" | ")}`);
    }
    if (data.abordagemIa) {
      lines.push(`Posicionamento Sugerido: ${data.abordagemIa}`);
    }
    if (data.observacoesCrm) {
      lines.push(`Anotações do CRM: ${data.observacoesCrm}`);
    }
    lines.push("");
  }

  // 8. CATÁLOGO DE FOTOS BAIXADAS
  lines.push("8. FOTOS DO ESTABELECIMENTO INCLUÍDAS NESTE PACOTE (PASTA /fotos)");
  lines.push(subHr);
  lines.push(`Total de Fotos Baixadas: ${downloadedPhotos.length}`);
  if (downloadedPhotos.length > 0) {
    downloadedPhotos.forEach((p, idx) => {
      const kb = Math.max(1, Math.round(p.sizeBytes / 1024));
      lines.push(`  ${idx + 1}. fotos/${p.fileName} (${kb} KB) -> ${p.originalUrl}`);
    });
  } else if (data.fotosUrls.length > 0) {
    lines.push("Links diretos das fotos no Google Maps:");
    data.fotosUrls.forEach((u, idx) => {
      lines.push(`  ${idx + 1}. ${toHighResGooglePhotoUrls(u)[0] || u}`);
    });
  } else {
    lines.push("  • Nenhuma foto pública encontrada na ficha do Google Maps para este estabelecimento.");
  }
  lines.push("");

  // 9. DADOS ESTRUTURADOS E SEO LOCAL (PARA COLAR NO SITE / IA DE CRIAÇÃO DE SITES)
  lines.push("9. SUGESTÃO DE SEO LOCAL & SCHEMA.ORG (PRONTO PARA O SITE)");
  lines.push(subHr);
  const cidadeUf = [data.addressComponents.cidade, data.addressComponents.estado].filter(Boolean).join(" - ");
  const seoTitle = `${data.nomeNegocio} | ${data.ramoNegocio}${cidadeUf ? ` em ${cidadeUf}` : ""}`;
  const seoDesc = `${data.nomeNegocio} — ${data.ramoNegocio}${data.endereco ? ` em ${data.endereco}` : ""}. ${data.avaliacao ? `Avaliação ${data.avaliacao} estrelas no Google.` : ""
    } Entre em contato${data.telefone ? ` pelo telefone/WhatsApp ${data.telefone}` : ""}!`.trim();
  lines.push(`Título SEO Sugerido (<title>): ${seoTitle}`);
  lines.push(`Meta Description Sugerida: ${seoDesc}`);
  lines.push("");

  const schemaJsonLd: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: data.nomeNegocio,
    description: data.sobre || data.descricao || seoDesc,
    telephone: data.telefone || undefined,
    email: data.email || undefined,
    url: data.website || undefined,
    hasMap: data.mapsUrl,
    priceRange: data.faixaPreco || undefined,
    address: {
      "@type": "PostalAddress",
      streetAddress: [data.addressComponents.rua, data.addressComponents.numero].filter(Boolean).join(", ") || data.endereco || undefined,
      addressLocality: data.addressComponents.cidade || undefined,
      addressRegion: data.addressComponents.estado || undefined,
      postalCode: data.cep || undefined,
      addressCountry: "BR",
    },
    ...(data.lat && data.lng
      ? {
        geo: {
          "@type": "GeoCoordinates",
          latitude: Number(data.lat),
          longitude: Number(data.lng),
        },
      }
      : {}),
    ...(data.avaliacao && Number(data.avaliacao) > 0
      ? {
        aggregateRating: {
          "@type": "AggregateRating",
          ratingValue: Number(String(data.avaliacao).replace(",", ".")),
          reviewCount: Math.max(1, parseInt(String(data.totalAvaliacoes || "1").replace(/\D/g, ""), 10) || 1),
        },
      }
      : {}),
    sameAs: [data.instagram, data.facebook, ...Object.values(data.redesAdicionais)].filter(Boolean),
  };

  lines.push("Schema.org JSON-LD (LocalBusiness):");
  lines.push(JSON.stringify(schemaJsonLd, null, 2));
  lines.push("");
  lines.push(hr);

  return lines.join("\r\n");
}

function findChromeExecutable(): string | undefined {
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(/*turbopackIgnore: true*/ process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  if (os.platform() === "win32") {
    const winPaths = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ];
    for (const p of winPaths) {
      if (p && fs.existsSync(/*turbopackIgnore: true*/ p)) return p;
    }
  } else {
    const linuxPaths = [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
    ];
    for (const p of linuxPaths) {
      if (fs.existsSync(/*turbopackIgnore: true*/ p)) return p;
    }
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Faz uma varredura profunda ao vivo na ficha do estabelecimento no Google Maps
 * (Visão Geral + Horários Expandidos + Aba Sobre + Aba Avaliações + Galeria de Fotos)
 * usando Puppeteer com Stealth Plugin.
 */
export async function scrapeGoogleMapsPlaceForKit(input: {
  mapsUrl?: string | null;
  nomeNegocio?: string | null;
  endereco?: string | null;
  telefone?: string | null;
}): Promise<ScrapedMapsKitData | null> {
  const executablePath = findChromeExecutable();
  if (!executablePath) {
    console.warn("[MAPS-KIT] Navegador Chrome/Chromium não encontrado para extração ao vivo; usando dados do banco.");
    return null;
  }

  let browser: { newPage: () => Promise<any>; close: () => Promise<void> } | null = null;
  try {
    const puppeteerExtra = (await import("puppeteer-extra")).default;
    const StealthPlugin = (await import("puppeteer-extra-plugin-stealth")).default;
    puppeteerExtra.use(StealthPlugin());

    browser = await puppeteerExtra.launch({
      headless: true,
      executablePath,
      ignoreDefaultArgs: ["--enable-automation"],
      env: {
        ...process.env,
        HOME: process.env.HOME && fs.existsSync(process.env.HOME) ? process.env.HOME : os.tmpdir(),
        CHROME_CRASHPAD_PIPE_NAME: "",
      },
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-zygote",
        "--disable-extensions",
        "--disable-background-networking",
        "--window-size=1366,900",
        "--lang=pt-BR,pt",
      ],
    });
    if (!browser) return null;

    const page = await browser.newPage();
    await page.evaluateOnNewDocument("window.__name = (fn) => fn;");
    await page.setViewport({ width: 1366, height: 900 });
    await page.setExtraHTTPHeaders({ "Accept-Language": "pt-BR,pt;q=0.9" });

    // Intercepta respostas de rede do Google Maps (imagens + metadados de fotos XHR + IDs da ficha)
    const networkPhotoUrls: string[] = [];
    const networkPhotoKeys = new Set<string>();
    let netHexId = "";
    let netKgId = "";

    const recordNetworkPhoto = (raw: string) => {
      let cleaned = raw.replace(/\\u003d/gi, "=").replace(/\\\//g, "/").replace(/^["']|["']$/g, "").trim();
      if (cleaned.startsWith("//")) cleaned = `https:${cleaned}`;
      if (!isGooglePlacePhotoUrl(cleaned)) return;
      const key = getGooglePhotoBaseKey(cleaned);
      if (!networkPhotoKeys.has(key)) {
        networkPhotoKeys.add(key);
        networkPhotoUrls.push(cleaned);
      }
    };

    page.on("response", async (res: { url: () => string; text: () => Promise<string> }) => {
      try {
        const resUrl = res.url();
        if (
          (resUrl.includes("googleusercontent.com") || resUrl.includes("ggpht.com")) &&
          isGooglePlacePhotoUrl(resUrl)
        ) {
          recordNetworkPhoto(resUrl);
          return;
        }
        if (
          resUrl.includes("/maps/preview/place") ||
          resUrl.includes("photometa") ||
          resUrl.includes("GeoPhotoService") ||
          resUrl.includes("batchexecute") ||
          resUrl.includes("/search?tbm=map") ||
          resUrl.includes("/maps/place/")
        ) {
          const body = await res.text().catch(() => "");
          if (!body) return;
          if (!netHexId) {
            const hm = body.match(/\b(0x[0-9a-f]{8,16}:0x[0-9a-f]{8,16})\b/i);
            if (hm) netHexId = hm[1];
          }
          if (!netKgId) {
            const km = body.match(/(\/g\/[a-z0-9_]+)/i);
            if (km) netKgId = km[1];
          }
          const matches = body.match(
            /(?:https?:)?(?:\\\/\\\/|\/\/)(?:lh\d+|geo\d+)\.(?:googleusercontent|ggpht)\.com(?:\\\/|\/)(?:p|gps-cs-s|gps-proxy)(?:\\\/|\/)[A-Za-z0-9_-]+(?:(?:\\u003d|=)[A-Za-z0-9_-]+)?/g
          );
          if (matches) {
            for (const m of matches) {
              recordNetworkPhoto(m);
            }
          }
        }
      } catch {
        // Ignora falhas de leitura de body de rede
      }
    });

    try {
      if (typeof page.setCookie === "function") {
        await page.setCookie(
          { name: "SOCS", value: "CAISNQgDEitnd3NfMjAyNDA2MTAtMF9SQzJfZXVyb3BlX3N0YXR1c19jYTFfMjAyNDA2MTAuMV9wMBoCcHQgAQ", domain: ".google.com", path: "/" },
          { name: "SOCS", value: "CAISNQgDEitnd3NfMjAyNDA2MTAtMF9SQzJfZXVyb3BlX3N0YXR1c19jYTFfMjAyNDA2MTAuMV9wMBoCcHQgAQ", domain: ".google.com.br", path: "/" },
          { name: "CONSENT", value: "PENDING+999", domain: ".google.com", path: "/" },
          { name: "CONSENT", value: "PENDING+999", domain: ".google.com.br", path: "/" }
        );
      }
    } catch {
      // ignora falha de cookie
    }

    const rawMapsUrl = (input.mapsUrl || "").trim();
    const searchQuery = [input.nomeNegocio, input.endereco].filter(Boolean).join(" ").trim();
    let targetUrl = "";
    if (rawMapsUrl && /^https?:\/\//i.test(rawMapsUrl)) {
      targetUrl = rawMapsUrl.includes("hl=")
        ? rawMapsUrl
        : `${rawMapsUrl}${rawMapsUrl.includes("?") ? "&" : "?"}hl=pt-BR`;
    } else if (searchQuery) {
      targetUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery).replace(/%20/g, "+")}?hl=pt-BR`;
    } else {
      return null;
    }

    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => null);
    await page.waitForSelector('[role="feed"], h1.DUwDvf, button[data-item-id="address"]', { timeout: 20000 }).catch(() => null);
    await sleep(1500);

    // Aceita página de consentimento se aparecer
    const hasConsent = await page.evaluate(() => {
      if (window.location.href.includes("consent.google.com")) return true;
      const t = (document.body?.innerText || "").toLowerCase();
      return t.includes("antes de continuar para o google") || t.includes("before you continue to google");
    });
    if (hasConsent) {
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll("button"));
        for (const b of btns) {
          if (/aceitar tudo|accept all|concordo|i agree|aceitar/i.test(b.textContent || "")) {
            (b as HTMLButtonElement).click();
            break;
          }
        }
      });
      await sleep(2500);
    }

    // Se caiu numa lista de resultados ([role="feed"]), abre o primeiro resultado correspondente
    const isPlacePanelOpen = await page.evaluate(() => {
      const h1 = document.querySelector("h1.DUwDvf");
      const hasAddrOrPhone =
        !!document.querySelector('[data-item-id="address"]') ||
        !!document.querySelector('[data-item-id^="phone"]');
      return !!(h1 && (hasAddrOrPhone || window.location.href.includes("/maps/place/")));
    });

    if (!isPlacePanelOpen) {
      const firstPlaceHref = await page.evaluate((expectedName: string) => {
        const cards = Array.from(document.querySelectorAll(".Nv2PK"));
        const target = (expectedName || "")
          .toLowerCase()
          .normalize("NFD")
          .replace(/\p{M}/gu, "")
          .trim();
        if (target && cards.length > 0) {
          for (const c of cards) {
            const title = (c.querySelector(".qBF1Pd")?.textContent || "")
              .toLowerCase()
              .normalize("NFD")
              .replace(/\p{M}/gu, "")
              .trim();
            if (title && (title.includes(target) || target.includes(title))) {
              const matchedLink = c.querySelector('a[href*="/maps/place/"], a.hfpxzc') as HTMLAnchorElement | null;
              if (matchedLink?.href) return matchedLink.href;
            }
          }
          const firstCardLink = cards[0]?.querySelector('a[href*="/maps/place/"], a.hfpxzc') as HTMLAnchorElement | null;
          if (firstCardLink?.href) return firstCardLink.href;
        }
        const anyLink = document.querySelector('a[href*="/maps/place/"], a.hfpxzc') as HTMLAnchorElement | null;
        return anyLink?.href || "";
      }, input.nomeNegocio || "");

      if (firstPlaceHref) {
        // Clica direto no card (SPA) e só usa goto como fallback se o painel não abrir
        const clickedCard = await page.evaluate((hrefTarget: string) => {
          const links = Array.from(document.querySelectorAll('a[href*="/maps/place/"], a.hfpxzc')) as HTMLAnchorElement[];
          const found = links.find((a) => a.href === hrefTarget) || links[0];
          if (found) {
            found.click();
            return true;
          }
          return false;
        }, firstPlaceHref);

        if (clickedCard) {
          await page.waitForSelector('h1.DUwDvf, [data-item-id="address"], [data-item-id^="phone"]', { timeout: 12000 }).catch(() => null);
          await sleep(1800);
        } else {
          const placeUrlWithLang = firstPlaceHref.includes("hl=")
            ? firstPlaceHref
            : `${firstPlaceHref}${firstPlaceHref.includes("?") ? "&" : "?"}hl=pt-BR`;
          await page.goto(placeUrlWithLang, { waitUntil: "domcontentloaded", timeout: 35000 }).catch(() => null);
          await page.waitForSelector('h1.DUwDvf, [data-item-id="address"], [data-item-id^="phone"]', { timeout: 12000 }).catch(() => null);
          await sleep(1800);
        }
      }
    }

    // Expande a tabela de horário de funcionamento (se estiver recolhida)
    await page.evaluate(() => {
      const hoursToggle = document.querySelector(
        '[data-item-id^="oh"], div.t39EBf, div.OMl5r, [aria-label*="horário" i][role="button"]'
      ) as HTMLElement | null;
      hoursToggle?.click();
    });
    await sleep(400);

    // FASE 1: Extração do painel principal (Visão Geral)
    const overviewData: ScrapedMapsKitData = await page.evaluate(() => {
      const seen = new Set<string>();
      const photos: string[] = [];

      for (const img of Array.from(document.querySelectorAll("img[src]"))) {
        let clean = ((img as HTMLImageElement).src || "").replace(/^["']|["']$/g, "").trim();
        if (clean.startsWith("//")) clean = `https:${clean}`;
        if (
          clean.startsWith("http") &&
          (clean.includes("googleusercontent.com") || clean.includes("ggpht.com") || clean.includes("googleapis.com/v1/thumbnail")) &&
          !/\/a-?\//i.test(clean)
        ) {
          const base = clean.includes("googleusercontent.com") || clean.includes("ggpht.com") ? clean.split("=")[0] : clean;
          if (!seen.has(base)) {
            seen.add(base);
            photos.push(clean);
          }
        }
      }

      for (const el of Array.from(document.querySelectorAll('[style*="background-image"]'))) {
        const style = (el as HTMLElement).getAttribute("style") || "";
        const m = style.match(/url\(([^)]+)\)/i);
        if (m && m[1]) {
          let clean = m[1].replace(/^["']|["']$/g, "").trim();
          if (clean.startsWith("//")) clean = `https:${clean}`;
          if (
            clean.startsWith("http") &&
            (clean.includes("googleusercontent.com") || clean.includes("ggpht.com")) &&
            !/\/a-?\//i.test(clean)
          ) {
            const base = clean.split("=")[0];
            if (!seen.has(base)) {
              seen.add(base);
              photos.push(clean);
            }
          }
        }
      }

      // Também varre scripts inline da página em busca de fotos de alta resolução do lugar
      for (const sc of Array.from(document.querySelectorAll("script"))) {
        const content = sc.textContent || "";
        if (!content.includes("googleusercontent.com")) continue;
        const matches = content.match(
          /(?:https?:)?(?:\\\/\\\/|\/\/)(?:lh\d+|geo\d+)\.(?:googleusercontent|ggpht)\.com(?:\\\/|\/)(?:p|gps-cs-s|gps-proxy)(?:\\\/|\/)[A-Za-z0-9_-]+/g
        );
        if (matches) {
          for (const rawMatch of matches) {
            let clean = rawMatch.replace(/\\\//g, "/").split("=")[0];
            if (clean.startsWith("//")) clean = `https:${clean}`;
            if (!seen.has(clean)) {
              seen.add(clean);
              photos.push(clean);
            }
          }
        }
      }

      const detailPanel = document.querySelector("h1")?.closest('[role="main"]') || document.querySelector('[role="main"]') || document.body;
      const bodyTxt = (detailPanel as HTMLElement).innerText || document.body.innerText || "";

      const name =
        (document.querySelector("h1.DUwDvf") as HTMLElement | null)?.innerText?.trim() ||
        (document.querySelector("h1") as HTMLElement | null)?.innerText?.trim() ||
        "";

      const catEls = Array.from(document.querySelectorAll('button[jsaction*="category"], button.DkEaL'));
      const categoriesList: string[] = [];
      for (const el of catEls) {
        const t = (el as HTMLElement).innerText?.trim() || "";
        if (t.length >= 2 && t.length <= 80 && !categoriesList.includes(t)) {
          categoriesList.push(t);
        }
      }
      const categories = categoriesList[0] || "";
      const additionalCategories = categoriesList.slice(1);

      const addrEl = document.querySelector('[data-item-id="address"], button[data-item-id="address"]') as HTMLElement | null;
      const fullAddress = (addrEl?.innerText || addrEl?.getAttribute("aria-label") || "")
        .replace(/^Endere[çc]o:\s*/i, "")
        .replace(/^[\uE000-\uF8FF\s]+/, "")
        .trim();

      let phone = "";
      const phoneEl = document.querySelector(
        '[data-item-id^="phone:tel:"], button[data-item-id^="phone"], a[data-item-id^="phone"], [aria-label*="telefone" i], [aria-label*="Ligar" i]'
      ) as HTMLElement | null;
      if (phoneEl) {
        const rawPhone = phoneEl.innerText || phoneEl.getAttribute("aria-label") || phoneEl.getAttribute("data-item-id") || "";
        phone = rawPhone
          .replace(/^(?:Telefone|Phone|Ligar para|Call|phone:tel)\s*:?\s*/i, "")
          .replace(/^[\uE000-\uF8FF\s]+/, "")
          .trim();
      }

      let website = "";
      let instagram = "";
      let facebook = "";
      const redesAdicionais: Record<string, string> = {};
      const authorityEl = document.querySelector('a[data-item-id="authority"]') as HTMLAnchorElement | null;
      if (authorityEl?.href && !authorityEl.href.includes("google.com")) {
        website = authorityEl.href;
      }

      const allLinks = Array.from(detailPanel.querySelectorAll("a[href^='http']")) as HTMLAnchorElement[];
      for (const a of allLinks) {
        const href = a.href;
        const lower = href.toLowerCase();
        if (lower.includes("instagram.com")) {
          if (!instagram) instagram = href;
        } else if (lower.includes("facebook.com") || lower.includes("fb.com")) {
          if (!facebook) facebook = href;
        } else if (lower.includes("linkedin.com")) {
          if (!redesAdicionais.linkedin) redesAdicionais.linkedin = href;
        } else if (lower.includes("youtube.com") || lower.includes("youtu.be")) {
          if (!redesAdicionais.youtube) redesAdicionais.youtube = href;
        } else if (lower.includes("tiktok.com")) {
          if (!redesAdicionais.tiktok) redesAdicionais.tiktok = href;
        } else if (lower.includes("twitter.com") || lower.includes("x.com")) {
          if (!redesAdicionais.twitter) redesAdicionais.twitter = href;
        } else if (lower.includes("wa.me") || lower.includes("whatsapp.com")) {
          if (!redesAdicionais.whatsapp) redesAdicionais.whatsapp = href;
        }
      }

      const menuEl = document.querySelector('a[data-item-id="menu"], a[aria-label*="cardápio" i], a[aria-label*="menu" i]') as HTMLAnchorElement | null;
      const menuUrl = menuEl?.href || "";
      const reservaEl = document.querySelector('a[data-item-id*="reserv"], a[data-item-id="action_reservations"], a[aria-label*="reserva" i]') as HTMLAnchorElement | null;
      const reservaUrl = reservaEl?.href || "";

      const mapsUrl = window.location.href;
      let placeId = "";
      const pidMatch = mapsUrl.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+|ChIJ[A-Za-z0-9_-]+)/i) || mapsUrl.match(/(ChIJ[A-Za-z0-9_-]+|0x[0-9a-f]+:0x[0-9a-f]+)/i);
      if (pidMatch) placeId = pidMatch[1] || pidMatch[0];

      let lat = "";
      let lng = "";
      const latMatch = mapsUrl.match(/!3d(-?\d{1,3}\.\d+)/);
      const lngMatch = mapsUrl.match(/!4d(-?\d{1,3}\.\d+)/);
      if (latMatch && lngMatch) {
        lat = latMatch[1];
        lng = lngMatch[1];
      } else {
        const atMatch = mapsUrl.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)/);
        if (atMatch) {
          lat = atMatch[1];
          lng = atMatch[2];
        }
      }

      let plusCode = "";
      const plusEl = document.querySelector('[data-item-id="oloc"], [data-item-id="olr"], button[data-item-id*="oloc"]') as HTMLElement | null;
      if (plusEl) {
        plusCode = (plusEl.innerText || plusEl.getAttribute("aria-label") || "")
          .replace(/^Plus Code:\s*/i, "")
          .replace(/^[\uE000-\uF8FF\s]+/, "")
          .trim();
      }

      const cepMatch = (fullAddress + " " + bodyTxt).match(/\b(\d{5}-\d{3})\b/);
      const cep = cepMatch ? cepMatch[1] : "";

      const addressComponents: Record<string, string> = {};
      if (cep) addressComponents.cep = cep;
      if (fullAddress) {
        const cityStateMatch = fullAddress.match(/([^,-]+?)\s*-\s*([A-Z]{2})\b/);
        if (cityStateMatch) {
          addressComponents.cidade = cityStateMatch[1].replace(/^.*,/, "").trim();
          addressComponents.estado = cityStateMatch[2].trim();
        }
        const parts = fullAddress.split(",");
        if (parts[0]) addressComponents.rua = parts[0].trim();
        if (parts[1]) {
          const numBairro = parts[1].split(" - ");
          const firstPart = (numBairro[0] || "").trim();
          if (/^\d+/.test(firstPart)) {
            addressComponents.numero = firstPart;
            if (numBairro[1]) addressComponents.bairro = numBairro[1].trim();
          } else if (firstPart) {
            addressComponents.bairro = firstPart;
          }
        }
      }

      let averageRating = "";
      const ratingSpan = document.querySelector('div.F7nice span[aria-hidden="true"]') as HTMLElement | null;
      if (ratingSpan?.innerText) {
        averageRating = ratingSpan.innerText.trim().replace(",", ".");
      }
      let reviewCount = "";
      const reviewSpan = document.querySelector('div.F7nice span[aria-label*="avalia" i], div.F7nice span[aria-label*="review" i]') as HTMLElement | null;
      if (reviewSpan) {
        const aria = reviewSpan.getAttribute("aria-label") || reviewSpan.innerText || "";
        const m = aria.match(/(\d[\d.,]*)/);
        if (m) reviewCount = m[1].replace(/\D/g, "");
      }

      const openingHours: Record<string, string> = {};
      const tableRows = Array.from(document.querySelectorAll("table.eK4R0e tr, table.WgFkxc tr"));
      for (const tr of tableRows) {
        const cells = tr.querySelectorAll("td");
        if (cells.length >= 2) {
          const day = (cells[0].textContent || "").trim();
          const hours = (cells[1].getAttribute("aria-label") || cells[1].textContent || "").trim();
          if (day && hours) openingHours[day] = hours;
        }
      }
      if (Object.keys(openingHours).length === 0) {
        const hoursEl = document.querySelector('[aria-label*="horário" i], [aria-label*="hours" i], div.t39EBf') as HTMLElement | null;
        const rawHours = hoursEl?.getAttribute("aria-label") || hoursEl?.textContent || "";
        if (rawHours) {
          const rawParts = rawHours
            .replace(/Copiar horário.*$/i, "")
            .replace(/Ocultar horário.*$/i, "")
            .split(";");
          for (const rawPart of rawParts) {
            const part = rawPart.trim();
            if (!part) continue;
            const commaIdx = part.indexOf(",");
            if (commaIdx > 0) {
              const d = part.slice(0, commaIdx).trim();
              const h = part.slice(commaIdx + 1).trim();
              if (d && h) openingHours[d] = h;
            }
          }
          if (Object.keys(openingHours).length === 0) {
            openingHours.raw = rawHours.slice(0, 600);
          }
        }
      }

      const openMatch = bodyTxt.match(/(Aberto agora|Fechado agora|Fechado temporariamente|Aberto 24 horas|Abre às [0-9:]+|Fecha às [0-9:]+)/i);
      const openNow = openMatch ? openMatch[1] : "";

      const priceMatch = bodyTxt.match(/(\bR\$\s*\d+[\s–-]*\d*|\${1,4})\s*·/);
      const priceRange = priceMatch ? priceMatch[1].trim() : "";

      const aboutEl = document.querySelector('.PYvSYb, .WeS02d, [aria-label*="sobre" i]') as HTMLElement | null;
      const about = aboutEl?.innerText?.trim() || "";

      return {
        name,
        categories,
        additionalCategories,
        fullAddress,
        addressComponents,
        cep,
        plusCode,
        lat,
        lng,
        placeId,
        mapsUrl,
        phone,
        website,
        instagram,
        facebook,
        redesAdicionais,
        menuUrl,
        reservaUrl,
        averageRating,
        reviewCount,
        openingHours,
        openNow,
        priceRange,
        about,
        photos,
      };
    });

    // FASE 2: Aba "Sobre" (Atributos detalhados por categoria, comodidades, pagamentos, etc.)
    const clickedAbout = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      for (const t of tabs) {
        const label = (t.textContent || t.getAttribute("aria-label") || "").trim();
        if (/^(?:sobre|about)$/i.test(label)) {
          (t as HTMLElement).click();
          return true;
        }
      }
      return false;
    });

    let aboutTabResult: { about?: string; attributeSections?: Record<string, string[]>; attributes?: string[] } = {};
    if (clickedAbout) {
      await sleep(900);
      aboutTabResult = await page.evaluate(() => {
        const attributeSections: Record<string, string[]> = {};
        const flatAttributes: string[] = [];
        const sectionBlocks = Array.from(document.querySelectorAll("div.iP2t7d, div[role='region']"));
        for (const block of sectionBlocks) {
          const titleEl = block.querySelector("h2, .iL3Qke") as HTMLElement | null;
          const secTitle = titleEl?.innerText?.trim() || "Atributos";
          const items: string[] = [];
          for (const li of Array.from(block.querySelectorAll("li, span[aria-label]"))) {
            const txt = ((li as HTMLElement).getAttribute("aria-label") || (li as HTMLElement).innerText || "").trim();
            if (txt && txt.length >= 2 && txt.length <= 100 && !/^não\s/i.test(txt) && !items.includes(txt)) {
              items.push(txt);
              if (!flatAttributes.includes(txt)) flatAttributes.push(txt);
            }
          }
          if (items.length > 0 && secTitle) {
            attributeSections[secTitle] = items;
          }
        }
        const descEl = document.querySelector(".PbZDve, .PYvSYb, .WeS02d") as HTMLElement | null;
        return {
          about: descEl?.innerText?.trim() || "",
          attributeSections,
          attributes: flatAttributes,
        };
      });
    }

    // FASE 3: Aba "Avaliações" (Depoimentos reais de clientes + distribuição de estrelas)
    const clickedReviews = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      for (const t of tabs) {
        const label = (t.textContent || t.getAttribute("aria-label") || "").trim();
        if (/avalia|review/i.test(label)) {
          (t as HTMLElement).click();
          return true;
        }
      }
      return false;
    });

    let reviewsResult: {
      distribuicaoEstrelas?: Record<string, number>;
      reviewTopics?: Record<string, string>;
      reviews?: MapsKitReview[];
      reviewPhotos?: string[];
    } = {};

    if (clickedReviews) {
      await sleep(1000);
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => {
          for (const btn of Array.from(document.querySelectorAll("button.w8nwRe, button[aria-label*='Ver mais' i]"))) {
            (btn as HTMLElement).click();
          }
          const feed = document.querySelector('div.m6QErb.DxyBCb, [role="feed"], div.m6QErb') as HTMLElement | null;
          feed?.scrollBy(0, 1200);
        });
        await sleep(450);
      }

      reviewsResult = await page.evaluate(() => {
        const distribuicaoEstrelas: Record<string, number> = {};
        for (const el of Array.from(document.querySelectorAll('tr[aria-label*="estrela" i], tr[aria-label*="star" i]'))) {
          const aria = el.getAttribute("aria-label") || el.textContent || "";
          const m = aria.match(/(\d)\s*(?:estrela|star)s?[^0-9]*(\d[\d.,]*)/i);
          if (m) distribuicaoEstrelas[`${m[1]}estrelas`] = parseInt(m[2].replace(/\D/g, ""), 10) || 0;
        }

        const reviews: MapsKitReview[] = [];
        const reviewPhotos: string[] = [];
        const seen = new Set<string>();
        const cards = Array.from(document.querySelectorAll(".jftiEf, div[data-review-id]"));
        for (const card of cards) {
          const el = card as HTMLElement;
          const autor =
            (el.querySelector(".d4r55") as HTMLElement | null)?.innerText?.trim() ||
            (el.getAttribute("aria-label") || "").trim();
          const ratingEl = el.querySelector('[role="img"][aria-label*="estrela" i], [role="img"][aria-label*="star" i]');
          const ratingAria = ratingEl?.getAttribute("aria-label") || "";
          const rm = ratingAria.match(/(\d(?:[.,]\d)?)/);
          const nota = rm ? rm[1] : "";
          const data = (el.querySelector(".rsqaWe") as HTMLElement | null)?.innerText?.trim() || "";
          const texto =
            (el.querySelector(".wiI7pd") as HTMLElement | null)?.innerText?.trim() ||
            el.innerText?.trim() ||
            "";
          if (!texto) continue;
          const sig = texto.slice(0, 80);
          if (seen.has(sig)) continue;
          seen.add(sig);

          const respostaDono = (el.querySelector(".CDe7pd") as HTMLElement | null)?.innerText?.trim() || undefined;
          const fotosCard: string[] = [];
          for (const btn of Array.from(el.querySelectorAll('button.Tya61d[style*="background-image"], img[src*="googleusercontent"]'))) {
            const style = (btn as HTMLElement).getAttribute("style") || "";
            const m = style.match(/url\(([^)]+)\)/i);
            let raw = m ? m[1].replace(/^["']|["']$/g, "").trim() : ((btn as HTMLImageElement).src || "").trim();
            if (raw.startsWith("//")) raw = `https:${raw}`;
            if (raw && !/\/a-?\//i.test(raw)) {
              const base = raw.split("=")[0];
              if (!fotosCard.includes(base)) fotosCard.push(base);
              if (!reviewPhotos.includes(base)) reviewPhotos.push(base);
            }
          }

          reviews.push({
            autor,
            nota,
            data,
            texto,
            fotos: fotosCard.length > 0 ? fotosCard : undefined,
            respostaDono,
          });
          if (reviews.length >= 25) break;
        }

        return { distribuicaoEstrelas, reviews, reviewPhotos };
      });
    }

    // FASE 4: Galeria de Fotos Completa do Estabelecimento
    // 4.1 Consulta direta e paginada ao serviço interno MapsPhotoService.ListEntityPhotos (rpcids=hspqX),
    // que contorna o limite de 10 fotos da "Visualização limitada do Google Maps" e retorna todos os lotes.
    const galleryPhotos: string[] = [];
    let rpcTotalPhotoCount: number | null = null;

    const placeIdentifiers = await page.evaluate((fallbackHex: string, fallbackKg: string) => {
      const u = window.location.href;
      const html = document.documentElement.innerHTML;
      const hm = u.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i) || html.match(/\b(0x[0-9a-f]{8,16}:0x[0-9a-f]{8,16})\b/i);
      const km = u.match(/!16s([^!&?]+)/i) || html.match(/(\/g\/[a-z0-9_]+)/i);
      const hexId = hm ? hm[1] : fallbackHex;
      let kgId = fallbackKg;
      if (km && km[1]) {
        try {
          kgId = decodeURIComponent(km[1]);
          if (kgId.includes("%2F")) kgId = decodeURIComponent(kgId);
        } catch {
          // Mantém fallbackKg
        }
      }
      return { hexId, kgId };
    }, netHexId, netKgId);

    if (placeIdentifiers.hexId) {
      const rpcPhotosResult = await page
        .evaluate(
          async (hexId: string, kgId: string) => {
            const allRpcUrls: string[] = [];
            const seenRpcBase = new Set<string>();
            let totalDeclared: number | null = null;
            let cursor: string | null = null;

            for (let pageIdx = 0; pageIdx < 12; pageIdx++) {
              const kgPart = kgId ? [[null, null, null, kgId]] : null;
              const payload = [
                2,
                null,
                [hexId, null, null, null, null, null, null, null, 0, null, null, null, null, null, kgPart],
                null,
                [
                  null,
                  [203, 100],
                  [null, 20, cursor, null, 1],
                  null,
                  null,
                  null,
                  [[[1, 0, 3], [2, 1, 2], [2, 0, 3], [8, 0, 3], [10, 0, 3], [10, 1, 2], [10, 0, 4], [9, 1, 2]], 1],
                  null,
                  0,
                  null,
                  null,
                  null,
                  null,
                  null,
                  [[[[[[2]]], [195, 195], 20]]],
                ],
                ["S_LjasPVGrWf1sQPr_KN4Aw", null, null, null, null, null, 81, null, null, null, null, null, null, null, 16698],
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                null,
                [null, 1, null, 1],
              ];

              const outer = [[["hspqX", JSON.stringify(payload), null, "generic"]]];
              const body = new URLSearchParams();
              body.set("f.req", JSON.stringify(outer));

              const r = await fetch("https://www.google.com/maps/_/MapsWizUi/data/batchexecute?rpcids=hspqX&hl=pt-BR&rt=c", {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
                body: body.toString(),
              });
              const t = await r.text();
              const lines = t.split("\n");
              let jsonLine = "";
              for (const l of lines) {
                if (l.startsWith('[["wrb.fr"')) {
                  jsonLine = l;
                  break;
                }
              }
              if (!jsonLine) break;

              const parsedOuter = JSON.parse(jsonLine);
              const parsedInner = JSON.parse(parsedOuter[0][2]);
              if (typeof parsedInner?.[1] === "number" && parsedInner[1] > 0 && !totalDeclared) {
                totalDeclared = parsedInner[1];
              }
              const items = Array.isArray(parsedInner?.[0]) ? parsedInner[0] : [];
              const beforeCount = seenRpcBase.size;
              for (const item of items) {
                const rawUrl = item?.[6]?.[0];
                if (typeof rawUrl === "string" && rawUrl.trim()) {
                  const clean = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
                  const base = clean.split("=")[0];
                  if (!seenRpcBase.has(base)) {
                    seenRpcBase.add(base);
                    allRpcUrls.push(clean);
                  }
                }
              }

              const nextCursor = typeof parsedInner?.[5] === "string" ? parsedInner[5] : null;
              if (
                items.length === 0 ||
                seenRpcBase.size === beforeCount ||
                !nextCursor ||
                nextCursor === cursor ||
                seenRpcBase.size >= 120
              ) {
                break;
              }
              cursor = nextCursor;
            }

            return { urls: allRpcUrls, totalDeclared };
          },
          placeIdentifiers.hexId,
          placeIdentifiers.kgId
        )
        .catch(() => ({ urls: [] as string[], totalDeclared: null as number | null }));

      for (const u of rpcPhotosResult.urls) {
        if (!galleryPhotos.includes(u)) galleryPhotos.push(u);
      }
      if (rpcPhotosResult.totalDeclared) {
        rpcTotalPhotoCount = rpcPhotosResult.totalDeclared;
      }
    }

    // 4.2 Volta para a aba "Visão geral" e clica no botão "Ver fotos" via mouse nativo para capturar fotos adicionais do DOM
    await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
      for (const t of tabs) {
        const label = (t.textContent || t.getAttribute("aria-label") || "").trim();
        if (/vis[aã]o geral|overview/i.test(label)) {
          (t as HTMLElement).click();
          break;
        }
      }
      for (const sc of Array.from(document.querySelectorAll("div.m6QErb"))) {
        (sc as HTMLElement).scrollTop = 0;
      }
    });
    await sleep(700);

    const photoBtnBox = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      let target: HTMLElement | null = null;
      for (const b of btns) {
        const txt = (b.innerText || "").trim();
        if (/ver fotos/i.test(txt) || /\d+\s*fotos?/i.test(txt)) {
          target = b;
          break;
        }
      }
      if (!target) {
        target = document.querySelector(
          'button.zEjzpe, button.ofKBgf, button.aoRNLd, button[jsaction*="heroHeaderImage"]'
        ) as HTMLElement | null;
      }
      if (!target) return null;
      target.scrollIntoView({ behavior: "instant", block: "center" });
      const r = target.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return null;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });

    if (photoBtnBox && typeof page.mouse?.click === "function") {
      await page.mouse.click(photoBtnBox.x, photoBtnBox.y).catch(() => null);
      await page.waitForSelector('a.MIgS0d, a.OKAoZd, div.U39Pmb, [data-photo-index]', { timeout: 5000 }).catch(() => null);
      await sleep(1200);

      const domGalleryUrls = await page.evaluate(() => {
        const urls: string[] = [];
        for (const a of Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[]) {
          const m = a.href.match(/!6s(https?[^!]+)/i);
          if (m && m[1]) {
            try {
              urls.push(decodeURIComponent(m[1]));
            } catch {
              // ignora falha de decode
            }
          }
        }
        const uMatch = window.location.href.match(/!6s(https?[^!]+)/i);
        if (uMatch && uMatch[1]) {
          try {
            urls.push(decodeURIComponent(uMatch[1]));
          } catch {
            // ignora falha de decode
          }
        }
        for (const el of Array.from(document.querySelectorAll('[style*="background-image"]'))) {
          const style = (el as HTMLElement).getAttribute("style") || "";
          const m = style.match(/url\(([^)]+)\)/i);
          if (m && m[1]) {
            let clean = m[1].replace(/^["']|["']$/g, "").trim();
            if (clean.startsWith("//")) clean = `https:${clean}`;
            if (
              clean.startsWith("http") &&
              (clean.includes("googleusercontent.com") || clean.includes("ggpht.com")) &&
              !/\/a-?\//i.test(clean)
            ) {
              urls.push(clean);
            }
          }
        }
        for (const img of Array.from(document.querySelectorAll('img[src*="googleusercontent"], img[src*="ggpht"]'))) {
          let clean = ((img as HTMLImageElement).src || "").trim();
          if (clean.startsWith("//")) clean = `https:${clean}`;
          if (clean.startsWith("http") && !/\/a-?\//i.test(clean)) {
            urls.push(clean);
          }
        }
        return urls;
      });

      for (const u of domGalleryUrls) {
        if (!galleryPhotos.includes(u)) galleryPhotos.push(u);
      }
    }

    const combinedPhotos = [
      ...galleryPhotos,
      ...networkPhotoUrls,
      ...(overviewData.photos || []),
      ...(reviewsResult.reviewPhotos || []),
    ];

    return {
      ...overviewData,
      totalPhotoCount: rpcTotalPhotoCount ?? overviewData.totalPhotoCount,
      about: aboutTabResult.about || overviewData.about,
      attributes: aboutTabResult.attributes || overviewData.attributes,
      attributeSections: aboutTabResult.attributeSections,
      distribuicaoEstrelas:
        reviewsResult.distribuicaoEstrelas && Object.keys(reviewsResult.distribuicaoEstrelas).length > 0
          ? reviewsResult.distribuicaoEstrelas
          : overviewData.distribuicaoEstrelas,
      reviews:
        reviewsResult.reviews && reviewsResult.reviews.length > 0
          ? reviewsResult.reviews
          : overviewData.reviews,
      photos: combinedPhotos,
    };
  } catch (err) {
    console.warn("[MAPS-KIT] Aviso na extração ao vivo do Maps (usando fallback do banco):", (err as Error).message);
    return null;
  } finally {
    if (browser) {
      await browser.close().catch(() => { });
    }
  }
}

function extensionFromMime(mimeType: string): string {
  const lower = (mimeType || "").toLowerCase();
  if (lower.includes("png")) return "png";
  if (lower.includes("webp")) return "webp";
  return "jpg";
}

/**
 * Faz o download de uma foto do Google Maps tentando primeiro a versão em alta resolução (`=w1600-h1200-k-no`)
 * e caindo para resoluções menores ou URL original caso necessário.
 */
export async function downloadSingleGooglePhoto(
  rawUrl: string,
  index: number,
  fetchImpl: typeof fetch = fetch
): Promise<DownloadedPhotoInfo | null> {
  const candidates = toHighResGooglePhotoUrls(rawUrl);
  for (const candidateUrl of candidates) {
    try {
      const response = await fetchImpl(candidateUrl, {
        signal: AbortSignal.timeout(12000),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
          Accept: "image/jpeg,image/png,image/webp,image/*,*/*;q=0.8",
          Referer: "https://www.google.com/",
        },
      });
      if (!response.ok) continue;
      const contentType = response.headers.get("content-type") || "image/jpeg";
      if (!contentType.toLowerCase().startsWith("image/")) continue;
      const arrayBuf = await response.arrayBuffer();
      const buf = Buffer.from(arrayBuf);
      // Ignora placeholders minúsculos (< 800 bytes)
      if (buf.byteLength < 800) continue;

      const ext = extensionFromMime(contentType);
      const numStr = String(index + 1).padStart(2, "0");
      return {
        fileName: `foto-${numStr}.${ext}`,
        originalUrl: rawUrl,
        resolvedUrl: candidateUrl,
        mimeType: contentType,
        sizeBytes: buf.byteLength,
        data: buf,
      };
    } catch {
      // Tenta próximo candidato de resolução
    }
  }
  return null;
}

/**
 * Baixa todas as fotos do estabelecimento em lotes paralelos controlados.
 */
export async function downloadAllPlacePhotos(
  photoUrls: string[],
  maxPhotos = 120,
  fetchImpl: typeof fetch = fetch
): Promise<DownloadedPhotoInfo[]> {
  const capped = photoUrls.slice(0, maxPhotos);
  const downloaded: DownloadedPhotoInfo[] = [];
  const CONCURRENCY = 10;

  for (let i = 0; i < capped.length; i += CONCURRENCY) {
    const chunk = capped.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      chunk.map((url, idx) => downloadSingleGooglePhoto(url, i + idx, fetchImpl))
    );
    for (const item of results) {
      if (item) downloaded.push(item);
    }
  }

  // Renumera sequencialmente caso alguma URL tenha falhado
  return downloaded.map((item, idx) => {
    const ext = extensionFromMime(item.mimeType);
    const numStr = String(idx + 1).padStart(2, "0");
    return {
      ...item,
      fileName: `foto-${numStr}.${ext}`,
    };
  });
}

/**
 * Orquestra toda a geração do pacote do Lead (varredura Maps + download de fotos + TXT completo + arquivo compactado).
 */
export async function buildLeadMapsKitArchive(opts: {
  lead: Record<string, unknown>;
  skipLiveScrape?: boolean;
  maxPhotos?: number;
  fetchImpl?: typeof fetch;
}): Promise<BuildLeadMapsKitResult> {
  const { lead, skipLiveScrape = false, maxPhotos = 120, fetchImpl = fetch } = opts;

  let scraped: ScrapedMapsKitData | null = null;
  if (!skipLiveScrape) {
    scraped = await scrapeGoogleMapsPlaceForKit({
      mapsUrl: typeof lead.maps_url === "string" ? lead.maps_url : null,
      nomeNegocio: typeof lead.nome_negocio === "string" ? lead.nome_negocio : null,
      endereco: typeof lead.endereco === "string" ? lead.endereco : null,
      telefone: typeof lead.telefone === "string" ? lead.telefone : null,
    });
  }

  const enrichedData = mergeMapsKitData(lead, scraped);
  const downloadedPhotos = await downloadAllPlacePhotos(
    enrichedData.fotosUrls,
    maxPhotos,
    fetchImpl
  );

  const txtContent = formatLeadKitTxt(enrichedData, downloadedPhotos);

  const zip = new JSZip();
  zip.file("INFORMACOES-DO-NEGOCIO.txt", txtContent);

  const photosFolder = zip.folder("fotos");
  if (photosFolder) {
    for (const photo of downloadedPhotos) {
      photosFolder.file(photo.fileName, photo.data);
    }
  }

  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  const slug = slugifyFileName(enrichedData.nomeNegocio);
  const fileName = `kit-site-${slug}.zip`;

  // Patch para atualizar e enriquecer o registro no banco de dados
  const existingBd =
    lead.business_details && typeof lead.business_details === "object" && !Array.isArray(lead.business_details)
      ? (lead.business_details as Record<string, unknown>)
      : {};
  const dbPatch: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    photos: enrichedData.fotosUrls.length > 0 ? enrichedData.fotosUrls : lead.photos ?? null,
    opening_hours:
      Object.keys(enrichedData.horariosFuncionamento).length > 0
        ? enrichedData.horariosFuncionamento
        : lead.opening_hours ?? null,
    attributes:
      enrichedData.atributos.length > 0 ? enrichedData.atributos : lead.attributes ?? null,
    reviews_detalhes:
      enrichedData.avaliacoesDetalhes.length > 0
        ? enrichedData.avaliacoesDetalhes
        : lead.reviews_detalhes ?? null,
    maps_url: enrichedData.mapsUrl || lead.maps_url || null,
    business_details: {
      ...existingBd,
      ...(enrichedData.sobre ? { about: enrichedData.sobre } : {}),
      ...(enrichedData.descricao ? { descricao: enrichedData.descricao } : {}),
      ...(enrichedData.servicos.length > 0 ? { services: enrichedData.servicos } : {}),
      ...(Object.keys(enrichedData.atributosPorSecao).length > 0
        ? { attributeSections: enrichedData.atributosPorSecao }
        : {}),
      ...(Object.keys(enrichedData.redesAdicionais).length > 0
        ? { redesAdicionais: enrichedData.redesAdicionais }
        : {}),
      ...(enrichedData.menuUrl ? { menuUrl: enrichedData.menuUrl } : {}),
      ...(enrichedData.reservaUrl ? { reservaUrl: enrichedData.reservaUrl } : {}),
    },
  };

  return {
    buffer,
    fileName,
    photoCount: downloadedPhotos.length,
    txtContent,
    enrichedData,
    dbPatch,
  };
}

