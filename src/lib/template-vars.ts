/**
 * Variáveis de template — usadas tanto no prompt do agente quanto no template
 * do disparo em massa e follow-up. Resolvidas em runtime.
 *
 * Variáveis estáticas suportadas (incluindo todos os campos do Google Maps e aliases naturais):
 *   {{saudacao}}             → "Bom dia" | "Boa tarde" | "Boa noite" | "Boa madrugada" (hora SP)
 *   {{nome_empresa}}         → nome do negócio do lead (do CRM) — alias: {{nome_negocio}}
 *   {{primeiro_nome}}        → primeira palavra do nome_empresa (heurística simples)
 *   {{nome}}                 → push_name do contato (nome do WhatsApp), com fallback pro nome_empresa
 *   {{telefone}}             → número limpo do remoteJid / telefone
 *   {{ramo}}                 → ramo_negocio do lead (com fallback pra categoria)
 *   {{categoria}}            → categoria do lead (com fallback pro ramo_negocio)
 *   {{endereco}}             → endereço completo do lead
 *   {{cidade}}               → cidade extraída do endereço ou address_components
 *   {{bairro}}               → bairro extraído do endereço ou address_components
 *   {{estado}} / {{uf}}      → UF/estado extraído do endereço ou address_components
 *   {{cep}}                  → CEP do negócio no Maps
 *   {{website}} / {{site}}   → website do lead
 *   {{avaliacao}} / {{nota}} → avaliação (nota 1–5 do Google) — aliases: {{nota_google}}, {{rating}}, {{estrelas}}
 *   {{reviews}} / {{avaliacoes}} → quantidade de avaliações no Google — aliases: {{qtd_avaliacoes}}, {{total_avaliacoes}}
 *   {{resumo_avaliacoes}}    → resumo IA das avaliações do Google (reviews-ai)
 *   {{ano_google}}           → ano no Google Maps ("No Google desde") — aliases: {{desde_ano}}, {{ano_fundacao}}, {{year_established}}
 *   {{instagram}}            → Instagram do lead
 *   {{facebook}}             → Facebook do lead
 *   {{maps_url}} / {{link_maps}} → Link do perfil no Google Maps
 *   {{horario_funcionamento}} / {{horarios}} → Horário de funcionamento do Maps
 *   {{aberto_agora}} / {{status_abertura}}   → Status de abertura no momento da captura
 *   {{faixa_preco}} / {{preco}}              → Faixa de preço no Google Maps
 *   {{atributos}} / {{diferenciais}}         → Atributos do Maps (Delivery, Acessibilidade, etc.)
 *   {{proprietario}} / {{dono}}              → Nome do proprietário (se informado no Maps)
 *   {{reivindicado}} / {{perfil_reivindicado}} → Se o perfil foi reivindicado no Google
 *   {{situacao_empresa}} / {{business_status}} → Situação operacional no Google Maps
 *   {{total_fotos}} / {{qtd_fotos}}          → Total de fotos no perfil do Google Maps
 *   {{topicos_avaliacoes}}                   → Temas mais citados nas avaliações do Google
 *   {{categorias_adicionais}}                → Categorias secundárias do Google Maps
 *   {{avaliacoes_destaque}}                  → Trechos de avaliações em destaque
 *   {{distribuicao_estrelas}}                → Distribuição de notas (5★ a 1★)
 *   {{descricao_google}} / {{sobre_empresa}} → Descrição oficial do negócio no Google Maps
 *   {{servicos_google}}                      → Serviços listados no Google Maps
 *   {{menu_url}} / {{link_cardapio}}         → Link do cardápio/menu no Google Maps
 *   {{reserva_url}} / {{link_reserva}}       → Link de reserva no Google Maps
 *   {{plus_code}}                            → Plus Code de localização no Maps
 *   {{link_previa}} / {{site_previa}}        → Link da prévia de site gerada
 *   {{status}}                               → Status do lead no CRM
 *   {{data}}                                 → "06/11/2026"
 *   {{data_atual}}                           → "sexta-feira, 06/11/2026"
 *   {{dia_semana}}                           → "sexta-feira"
 *   {{hora}} / {{hora_atual}}                → "14:30"
 *   {{ano_atual}}                            → "2026"
 *
 * Variáveis dinâmicas: qualquer chave em ctx.variables é resolvida automaticamente.
 *   Ex: salvou {orcamento: "R$ 5k"} via tool save_variables → {{orcamento}} funciona no prompt.
 */

import { resolveLeadGoogleYear } from "./scraper-lead-filters";

export type TemplateContext = {
  remoteJid?: string;
  nome_negocio?: string | null;
  ramo_negocio?: string | null;
  push_name?: string | null;
  telefone?: string | null;
  email?: string | null;
  endereco?: string | null;
  categoria?: string | null;
  website?: string | null;
  avaliacao?: number | string | null;
  nota?: number | string | null;
  reviews?: number | string | null;
  avaliacoes?: number | string | null;
  /** Resumo IA das avaliações do Google (leads_extraidos.resumo_avaliacoes). */
  resumo_avaliacoes?: string | null;
  status?: string | null;
  observacoes?: string | null;
  instagram?: string | null;
  facebook?: string | null;
  /** Link da prévia gerada com OpenCode + Vercel (https://slug.vercel.app) */
  link_previa?: string | null;
  site_previa?: string | null;
  // ---- Campos ricos capturados do Google Maps ----
  year_established?: number | string | null;
  ano_google?: number | string | null;
  maps_url?: string | null;
  cep?: string | null;
  plus_code?: string | null;
  place_id?: string | null;
  cidade?: string | null;
  bairro?: string | null;
  estado?: string | null;
  rua?: string | null;
  address_components?: Record<string, unknown> | null;
  price_range?: string | null;
  faixa_preco?: string | null;
  open_now?: string | null;
  aberto_agora?: string | null;
  opening_hours?: unknown;
  horario_funcionamento?: string | null;
  attributes?: unknown;
  atributos?: string | null;
  business_details?: Record<string, unknown> | null;
  descricao_google?: string | null;
  servicos_google?: string | null;
  menu_url?: string | null;
  reserva_url?: string | null;
  business_status?: string | null;
  situacao_empresa?: string | null;
  claimed?: boolean | string | null;
  reivindicado?: string | null;
  owner_name?: string | null;
  proprietario?: string | null;
  total_photo_count?: number | string | null;
  total_fotos?: number | string | null;
  photos?: unknown;
  review_topics?: unknown;
  topicos_avaliacoes?: string | null;
  featured_reviews?: unknown;
  avaliacoes_destaque?: string | null;
  additional_categories?: unknown;
  categorias_adicionais?: string | null;
  distribuicao_estrelas?: unknown;
  reviews_detalhes?: Array<{ data?: string; texto?: string }> | null;
  // Vars dinâmicas capturadas pelo funil (sessions.variables)
  // — também usado pra injetar dados de agendamento ({hora_agendamento},
  // {data_agendamento}, {servico}, {meet_link}, etc.)
  variables?: Record<string, any> | null;
  // permite override do "agora" (útil em testes)
  now?: Date;
};

/**
 * Saudação baseada no horário local de Brasília (BRT, GMT-3).
 *   00–05 → Boa madrugada
 *   06–11 → Bom dia
 *   12–17 → Boa tarde
 *   18–23 → Boa noite
 */
export function greetingFor(date: Date = new Date()): string {
  const hour = Number(
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      hour12: false,
    }).format(date)
  );
  if (hour >= 0 && hour < 6) return "Boa madrugada";
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}

function cleanPhone(jid?: string | null): string {
  return (jid || "").replace(/@.*$/, "").replace(/\D/g, "");
}

function firstName(name?: string | null): string {
  if (!name) return "";
  // Remove sufixos comuns ("Ltda", "ME", "Advocacia") pra pegar a 1a palavra mais natural
  const cleaned = name.replace(/\b(ltda|me|eireli|s\.?a\.?|advocacia|escritório|escritorio)\b\.?/gi, "").trim();
  return cleaned.split(/\s+/)[0] || "";
}

function parseAddressParts(
  endereco?: string | null,
  addressComponents?: Record<string, unknown> | null,
): { rua: string; bairro: string; cidade: string; estado: string; cep: string } {
  const ac = addressComponents && typeof addressComponents === "object" ? addressComponents : {};
  let rua = typeof ac.rua === "string" ? ac.rua.trim() : typeof ac.street === "string" ? ac.street.trim() : "";
  let bairro = typeof ac.bairro === "string" ? ac.bairro.trim() : typeof ac.neighborhood === "string" ? ac.neighborhood.trim() : "";
  let cidade = typeof ac.cidade === "string" ? ac.cidade.trim() : typeof ac.city === "string" ? ac.city.trim() : "";
  let estado = typeof ac.estado === "string" ? ac.estado.trim() : typeof ac.uf === "string" ? ac.uf.trim() : typeof ac.state === "string" ? ac.state.trim() : "";
  let cep = typeof ac.cep === "string" ? ac.cep.trim() : typeof ac.postalCode === "string" ? ac.postalCode.trim() : "";

  const raw = (endereco || "").trim();
  if (raw) {
    if (!cep) {
      const cepMatch = raw.match(/\b(\d{5}-?\d{3})\b/);
      if (cepMatch) cep = cepMatch[1];
    }
    // Ex: "Rua A, 123 - Centro, São Paulo - SP, 01001-000, Brasil"
    const cityStateMatch = raw.match(/,\s*([^,-]+?)\s*-\s*([A-Z]{2})\b/);
    if (cityStateMatch) {
      if (!cidade) cidade = cityStateMatch[1].trim();
      if (!estado) estado = cityStateMatch[2].trim();
    }
    const beforeCity = cityStateMatch ? raw.slice(0, cityStateMatch.index) : raw;
    const dashParts = beforeCity.split(/\s+-\s+/);
    if (dashParts.length >= 2) {
      if (!rua) rua = dashParts[0].trim();
      if (!bairro) bairro = dashParts[dashParts.length - 1].replace(/,.*$/, "").trim();
    } else if (!rua) {
      rua = beforeCity.trim();
    }
  }

  return { rua, bairro, cidade, estado, cep };
}

function formatOpeningHours(raw: unknown): string {
  if (!raw) return "";
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (item && typeof item === "object") {
          const day = (item as Record<string, unknown>).day || (item as Record<string, unknown>).dia || "";
          const hours = (item as Record<string, unknown>).hours || (item as Record<string, unknown>).horario || "";
          return day && hours ? `${String(day)}: ${String(hours)}` : "";
        }
        return "";
      })
      .filter(Boolean)
      .join(" | ");
  }
  if (typeof raw === "object") {
    const entries = Object.entries(raw as Record<string, unknown>)
      .filter(([k, v]) => !k.startsWith("_") && v != null && String(v).trim() !== "")
      .map(([k, v]) => `${k}: ${String(v).trim()}`);
    return entries.join(" | ");
  }
  return "";
}

function formatStringList(raw: unknown, separator = ", "): string {
  if (!raw) return "";
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .map((item) => (typeof item === "string" ? item.trim() : item != null ? String(item).trim() : ""))
      .filter(Boolean)
      .join(separator);
  }
  return "";
}

function formatReviewTopics(raw: unknown): string {
  if (!raw) return "";
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) return formatStringList(raw);
  if (typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .filter(([k]) => !k.startsWith("_"))
      .map(([k, v]) => (v != null && String(v).trim() !== "" ? `${k} (${String(v).trim()})` : k))
      .join(", ");
  }
  return "";
}

function formatStarDistribution(raw: unknown): string {
  if (!raw) return "";
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return Object.entries(raw as Record<string, unknown>)
      .map(([k, v]) => {
        const star = k.replace(/\D/g, "");
        return star && v != null ? `${star}★: ${String(v)}` : `${k}: ${String(v)}`;
      })
      .join(", ");
  }
  return "";
}

function formatClaimed(claimed: boolean | string | null | undefined, explicit?: string | null): string {
  if (explicit && explicit.trim()) return explicit.trim();
  if (typeof claimed === "string") return claimed.trim();
  if (claimed === true) return "Sim";
  if (claimed === false) return "Não";
  return "";
}

/**
 * Converte uma linha de `leads_extraidos` (ou sample da UI) em `TemplateContext` completo.
 */
export function leadRowToTemplateContext(
  lead: Record<string, any> | null | undefined,
  extra: Partial<TemplateContext> = {},
): TemplateContext {
  const l = lead || {};
  return {
    remoteJid: l.remoteJid || l.remote_jid || extra.remoteJid,
    nome_negocio: l.nome_negocio ?? extra.nome_negocio ?? null,
    ramo_negocio: l.ramo_negocio ?? extra.ramo_negocio ?? null,
    push_name: l.push_name ?? extra.push_name ?? null,
    telefone: l.telefone ?? extra.telefone ?? null,
    email: l.email ?? extra.email ?? null,
    endereco: l.endereco ?? extra.endereco ?? null,
    categoria: l.categoria ?? extra.categoria ?? null,
    website: l.website ?? extra.website ?? null,
    avaliacao: l.avaliacao ?? l.nota ?? extra.avaliacao ?? extra.nota ?? null,
    reviews: l.reviews ?? l.avaliacoes ?? extra.reviews ?? extra.avaliacoes ?? null,
    resumo_avaliacoes: l.resumo_avaliacoes ?? extra.resumo_avaliacoes ?? null,
    status: l.status ?? extra.status ?? null,
    observacoes: l.observacoes ?? extra.observacoes ?? null,
    instagram: l.instagram ?? extra.instagram ?? null,
    facebook: l.facebook ?? extra.facebook ?? null,
    link_previa: l.link_previa ?? l.site_previa ?? extra.link_previa ?? extra.site_previa ?? null,
    site_previa: l.site_previa ?? l.link_previa ?? extra.site_previa ?? extra.link_previa ?? null,
    year_established: l.year_established ?? l.ano_google ?? extra.year_established ?? extra.ano_google ?? null,
    ano_google: l.ano_google ?? l.year_established ?? extra.ano_google ?? extra.year_established ?? null,
    maps_url: l.maps_url ?? extra.maps_url ?? null,
    cep: l.cep ?? extra.cep ?? null,
    plus_code: l.plus_code ?? extra.plus_code ?? null,
    place_id: l.place_id ?? extra.place_id ?? null,
    cidade: l.cidade ?? extra.cidade ?? null,
    bairro: l.bairro ?? extra.bairro ?? null,
    estado: l.estado ?? extra.estado ?? null,
    rua: l.rua ?? extra.rua ?? null,
    address_components: l.address_components ?? extra.address_components ?? null,
    price_range: l.price_range ?? l.faixa_preco ?? extra.price_range ?? extra.faixa_preco ?? null,
    faixa_preco: l.faixa_preco ?? l.price_range ?? extra.faixa_preco ?? extra.price_range ?? null,
    open_now: l.open_now ?? l.aberto_agora ?? extra.open_now ?? extra.aberto_agora ?? null,
    aberto_agora: l.aberto_agora ?? l.open_now ?? extra.aberto_agora ?? extra.open_now ?? null,
    opening_hours: l.opening_hours ?? l.horario_funcionamento ?? extra.opening_hours ?? extra.horario_funcionamento ?? null,
    horario_funcionamento: l.horario_funcionamento ?? extra.horario_funcionamento ?? null,
    attributes: l.attributes ?? l.atributos ?? extra.attributes ?? extra.atributos ?? null,
    atributos: l.atributos ?? extra.atributos ?? null,
    business_details: l.business_details ?? extra.business_details ?? null,
    descricao_google: l.descricao_google ?? extra.descricao_google ?? null,
    servicos_google: l.servicos_google ?? extra.servicos_google ?? null,
    menu_url: l.menu_url ?? extra.menu_url ?? null,
    reserva_url: l.reserva_url ?? extra.reserva_url ?? null,
    business_status: l.business_status ?? l.situacao_empresa ?? extra.business_status ?? extra.situacao_empresa ?? null,
    situacao_empresa: l.situacao_empresa ?? l.business_status ?? extra.situacao_empresa ?? extra.business_status ?? null,
    claimed: l.claimed ?? extra.claimed ?? null,
    reivindicado: l.reivindicado ?? extra.reivindicado ?? null,
    owner_name: l.owner_name ?? l.proprietario ?? extra.owner_name ?? extra.proprietario ?? null,
    proprietario: l.proprietario ?? l.owner_name ?? extra.proprietario ?? extra.owner_name ?? null,
    total_photo_count: l.total_photo_count ?? l.total_fotos ?? extra.total_photo_count ?? extra.total_fotos ?? null,
    total_fotos: l.total_fotos ?? l.total_photo_count ?? extra.total_fotos ?? extra.total_photo_count ?? null,
    photos: l.photos ?? extra.photos ?? null,
    review_topics: l.review_topics ?? l.topicos_avaliacoes ?? extra.review_topics ?? extra.topicos_avaliacoes ?? null,
    topicos_avaliacoes: l.topicos_avaliacoes ?? extra.topicos_avaliacoes ?? null,
    featured_reviews: l.featured_reviews ?? l.avaliacoes_destaque ?? extra.featured_reviews ?? extra.avaliacoes_destaque ?? null,
    avaliacoes_destaque: l.avaliacoes_destaque ?? extra.avaliacoes_destaque ?? null,
    additional_categories: l.additional_categories ?? l.categorias_adicionais ?? extra.additional_categories ?? extra.categorias_adicionais ?? null,
    categorias_adicionais: l.categorias_adicionais ?? extra.categorias_adicionais ?? null,
    distribuicao_estrelas: l.distribuicao_estrelas ?? extra.distribuicao_estrelas ?? null,
    reviews_detalhes: l.reviews_detalhes ?? extra.reviews_detalhes ?? null,
    variables: extra.variables ?? l.variables ?? null,
    now: extra.now ?? l.now,
  };
}

export function renderTemplate(template: string, ctx: TemplateContext = {}): string {
  if (!template) return "";
  const now = ctx.now || new Date();

  // Nome preferencial: push_name do WhatsApp (mais humano), depois primeiro nome da empresa.
  const pushFirst = firstName(ctx.push_name);
  const empresaFirst = firstName(ctx.nome_negocio);
  const nomeFinal = pushFirst || empresaFirst || "";

  const phone = ctx.telefone || cleanPhone(ctx.remoteJid);

  // Nota / Avaliação e Reviews / Avaliações com aliases naturais
  const avaliacaoVal =
    ctx.avaliacao != null && String(ctx.avaliacao).trim() !== ""
      ? String(ctx.avaliacao).trim()
      : ctx.nota != null && String(ctx.nota).trim() !== ""
        ? String(ctx.nota).trim()
        : "";
  const reviewsVal =
    ctx.reviews != null && String(ctx.reviews).trim() !== ""
      ? String(ctx.reviews).trim()
      : ctx.avaliacoes != null && String(ctx.avaliacoes).trim() !== ""
        ? String(ctx.avaliacoes).trim()
        : "";

  // Ano no Google ("No Google desde"): coluna explícita ou inferida das reviews
  const resolvedYear = resolveLeadGoogleYear({
    yearEstablished: ctx.year_established ?? ctx.ano_google ?? null,
    reviews: Array.isArray(ctx.reviews_detalhes) ? ctx.reviews_detalhes : null,
    refDate: now,
  });
  const anoGoogleVal =
    resolvedYear != null
      ? String(resolvedYear)
      : ctx.year_established != null && String(ctx.year_established).trim() !== ""
        ? String(ctx.year_established).trim()
        : ctx.ano_google != null && String(ctx.ano_google).trim() !== ""
          ? String(ctx.ano_google).trim()
          : "";

  // Endereço decomposto (address_components ou parse do texto)
  const parsedAddr = parseAddressParts(ctx.endereco, ctx.address_components);
  const cidadeVal = (ctx.cidade || parsedAddr.cidade || "").trim();
  const bairroVal = (ctx.bairro || parsedAddr.bairro || "").trim();
  const estadoVal = (ctx.estado || parsedAddr.estado || "").trim();
  const ruaVal = (ctx.rua || parsedAddr.rua || "").trim();
  const cepVal = (ctx.cep || parsedAddr.cep || "").trim();

  // Funcionamento, faixa de preço e atributos
  const horarioVal = (ctx.horario_funcionamento || formatOpeningHours(ctx.opening_hours)).trim();
  const faixaPrecoVal = (ctx.faixa_preco || ctx.price_range || "").trim();
  const abertoAgoraVal = (ctx.aberto_agora || ctx.open_now || "").trim();
  const atributosVal = (ctx.atributos || formatStringList(ctx.attributes)).trim();

  // Detalhes extras de business_details
  const bd = ctx.business_details && typeof ctx.business_details === "object" ? ctx.business_details : {};
  const descricaoGoogleVal = (
    ctx.descricao_google ||
    (typeof bd.descricao === "string" ? bd.descricao : "") ||
    (typeof bd.about === "string" ? bd.about : "")
  ).trim();
  const servicosGoogleVal = (
    ctx.servicos_google ||
    formatStringList(bd.services || bd.servicos)
  ).trim();
  const subcategoriasVal = formatStringList(bd.subcategorias);
  const menuUrlVal = (ctx.menu_url || (typeof bd.menuUrl === "string" ? bd.menuUrl : "")).trim();
  const reservaUrlVal = (ctx.reserva_url || (typeof bd.reservaUrl === "string" ? bd.reservaUrl : "")).trim();

  // Proprietário, reivindicação, status e fotos
  const proprietarioVal = (ctx.proprietario || ctx.owner_name || "").trim();
  const reivindicadoVal = formatClaimed(ctx.claimed, ctx.reivindicado);
  const situacaoEmpresaVal = (ctx.situacao_empresa || ctx.business_status || "").trim();
  const totalFotosVal =
    ctx.total_photo_count != null && String(ctx.total_photo_count).trim() !== ""
      ? String(ctx.total_photo_count).trim()
      : ctx.total_fotos != null && String(ctx.total_fotos).trim() !== ""
        ? String(ctx.total_fotos).trim()
        : Array.isArray(ctx.photos) && ctx.photos.length > 0
          ? String(ctx.photos.length)
          : "";

  const topicosAvaliacoesVal = (ctx.topicos_avaliacoes || formatReviewTopics(ctx.review_topics)).trim();
  const categoriasAdicionaisVal = (ctx.categorias_adicionais || formatStringList(ctx.additional_categories)).trim();
  const avaliacoesDestaqueVal = (ctx.avaliacoes_destaque || formatStringList(ctx.featured_reviews, " | ")).trim();
  const distribuicaoEstrelasVal = formatStarDistribution(ctx.distribuicao_estrelas);

  const linkPreviaVal = (ctx.link_previa || ctx.site_previa || "").trim();
  const mapsUrlVal = (ctx.maps_url || "").trim();

  // Datas e horários (fuso de Brasília)
  const dataFormatada = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo" }).format(now);
  const horaFormatada = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
  const diaSemanaFormatado = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    weekday: "long",
  }).format(now);
  const anoAtualFormatado = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
  }).format(now);
  const dataAtualCompleta = `${diaSemanaFormatado}, ${dataFormatada}`;

  const baseMap: Record<string, string> = {
    saudacao: greetingFor(now),
    nome_empresa: ctx.nome_negocio || "",
    // Alias natural: usuário escreve {{nome_negocio}} (nome da coluna do CRM)
    // mesmo o token oficial sendo {{nome_empresa}}.
    nome_negocio: ctx.nome_negocio || "",
    primeiro_nome: empresaFirst,
    nome: nomeFinal,
    push_name: ctx.push_name || "",
    telefone: phone,
    email: ctx.email || "",
    ramo: ctx.ramo_negocio || ctx.categoria || "",
    ramo_negocio: ctx.ramo_negocio || ctx.categoria || "",
    categoria: ctx.categoria || ctx.ramo_negocio || "",
    endereco: ctx.endereco || "",
    cidade: cidadeVal,
    bairro: bairroVal,
    estado: estadoVal,
    uf: estadoVal,
    rua: ruaVal,
    cep: cepVal,
    plus_code: ctx.plus_code || "",
    place_id: ctx.place_id || "",
    website: ctx.website || "",
    site: ctx.website || "",
    // Avaliações / Nota do Google Maps + aliases naturais
    avaliacao: avaliacaoVal,
    nota: avaliacaoVal,
    nota_google: avaliacaoVal,
    rating: avaliacaoVal,
    estrelas: avaliacaoVal,
    reviews: reviewsVal,
    avaliacoes: reviewsVal,
    qtd_avaliacoes: reviewsVal,
    total_avaliacoes: reviewsVal,
    quantidade_avaliacoes: reviewsVal,
    resumo_avaliacoes: ctx.resumo_avaliacoes || "",
    resumo_google: ctx.resumo_avaliacoes || "",
    // Ano no Google ("No Google desde")
    ano_google: anoGoogleVal,
    desde_ano: anoGoogleVal,
    ano_fundacao: anoGoogleVal,
    year_established: anoGoogleVal,
    // Redes sociais e links
    instagram: ctx.instagram || "",
    facebook: ctx.facebook || "",
    maps_url: mapsUrlVal,
    link_maps: mapsUrlVal,
    google_maps: mapsUrlVal,
    link_previa: linkPreviaVal,
    site_previa: linkPreviaVal,
    // Funcionamento e atributos do Google Maps
    horario_funcionamento: horarioVal,
    horarios_funcionamento: horarioVal,
    horarios: horarioVal,
    opening_hours: horarioVal,
    aberto_agora: abertoAgoraVal,
    status_abertura: abertoAgoraVal,
    open_now: abertoAgoraVal,
    faixa_preco: faixaPrecoVal,
    preco: faixaPrecoVal,
    price_range: faixaPrecoVal,
    atributos: atributosVal,
    diferenciais: atributosVal,
    attributes: atributosVal,
    // Detalhes extras do Google Maps
    proprietario: proprietarioVal,
    dono: proprietarioVal,
    owner_name: proprietarioVal,
    reivindicado: reivindicadoVal,
    perfil_reivindicado: reivindicadoVal,
    claimed: reivindicadoVal,
    situacao_empresa: situacaoEmpresaVal,
    business_status: situacaoEmpresaVal,
    total_fotos: totalFotosVal,
    qtd_fotos: totalFotosVal,
    total_photo_count: totalFotosVal,
    topicos_avaliacoes: topicosAvaliacoesVal,
    temas_avaliacoes: topicosAvaliacoesVal,
    review_topics: topicosAvaliacoesVal,
    categorias_adicionais: categoriasAdicionaisVal,
    additional_categories: categoriasAdicionaisVal,
    avaliacoes_destaque: avaliacoesDestaqueVal,
    featured_reviews: avaliacoesDestaqueVal,
    distribuicao_estrelas: distribuicaoEstrelasVal,
    descricao_google: descricaoGoogleVal,
    sobre_empresa: descricaoGoogleVal,
    servicos_google: servicosGoogleVal,
    subcategorias: subcategoriasVal,
    menu_url: menuUrlVal,
    link_cardapio: menuUrlVal,
    reserva_url: reservaUrlVal,
    link_reserva: reservaUrlVal,
    // Status e notas do CRM
    status: ctx.status || "",
    observacoes: ctx.observacoes || "",
    // Data e hora
    data: dataFormatada,
    data_atual: dataAtualCompleta,
    dia_semana: diaSemanaFormatado,
    hora: horaFormatada,
    hora_atual: horaFormatada,
    ano_atual: anoAtualFormatado,
  };

  // Variáveis dinâmicas do funil têm prioridade quando presentes (ex: orcamento, cargo).
  // Não sobrescrevem variáveis-base se forem null/vazias — preserva fallback do CRM.
  const dynamicMap: Record<string, string> = {};
  if (ctx.variables && typeof ctx.variables === "object") {
    for (const [k, v] of Object.entries(ctx.variables)) {
      if (v == null) continue;
      const s = typeof v === "string" ? v : String(v);
      if (s.trim()) dynamicMap[k.toLowerCase()] = s;
    }
  }

  // Aceita AMBOS os formatos: `{var}` (uma chave — usado no calendário e
  // lembretes do scheduler) E `{{var}}` (Mustache — usado no disparo em massa).
  // Antes só `{{var}}` funcionava: os lembretes dos agendamentos saíam com a
  // string literal `{nome}` no WhatsApp do cliente. Bug crítico de UX.
  const replacer = (full: string, key: string) => {
    const k = String(key).toLowerCase();
    if (dynamicMap[k] !== undefined) return dynamicMap[k];
    if (baseMap[k] !== undefined) return baseMap[k];
    return full;
  };
  return template
    .replace(/\{\{\s*([a-z_][\w]*)\s*\}\}/gi, replacer)
    .replace(/\{\s*([a-z_][\w]*)\s*\}/gi, replacer);
}

/**
 * Variáveis dinâmicas exibidas como chips clicáveis/arrastáveis no editor de
 * prompt do Agente IA (/agente) e nos editores de template (/disparo, /follow-up, etc.).
 */
export const PROMPT_VARIABLES = [
  { key: "saudacao",              label: "Saudação",            hint: "Bom dia / Boa tarde / Boa noite / Boa madrugada (hora SP)" },
  { key: "nome",                  label: "Nome",                hint: "Nome do contato no WhatsApp (push_name) com fallback pra empresa" },
  { key: "nome_empresa",          label: "Nome empresa",        hint: "Nome do negócio no CRM / Google Maps (alias: {{nome_negocio}})" },
  { key: "primeiro_nome",         label: "1ª palavra",          hint: "Primeira palavra do nome da empresa" },
  { key: "ramo",                  label: "Ramo",                hint: "Ramo de negócio do CRM / Maps" },
  { key: "categoria",             label: "Categoria",           hint: "Categoria principal do negócio no Google Maps" },
  { key: "nota",                  label: "Nota Google",         hint: "Nota média no Google Maps de 1 a 5 (alias: {{avaliacao}})" },
  { key: "avaliacao",             label: "Avaliação",           hint: "Nota média no Google Maps de 1 a 5 (alias: {{nota}})" },
  { key: "avaliacoes",            label: "Avaliações (qtd)",    hint: "Quantidade total de avaliações no Google (alias: {{reviews}})" },
  { key: "reviews",               label: "Reviews",             hint: "Quantidade total de avaliações no Google (alias: {{avaliacoes}})" },
  { key: "resumo_avaliacoes",     label: "Resumo avaliações",   hint: "Resumo IA das avaliações do Google (elogios, reclamações e gancho)" },
  { key: "ano_google",            label: "No Google desde",     hint: "Ano em que a empresa está no Google Maps (alias: {{year_established}})" },
  { key: "endereco",              label: "Endereço",            hint: "Endereço completo do negócio no Google Maps" },
  { key: "cidade",                label: "Cidade",              hint: "Cidade do negócio (extraída do Google Maps)" },
  { key: "bairro",                label: "Bairro",              hint: "Bairro do negócio (extraído do Google Maps)" },
  { key: "estado",                label: "Estado (UF)",         hint: "Estado/UF do negócio (alias: {{uf}})" },
  { key: "cep",                   label: "CEP",                 hint: "CEP capturado do Google Maps" },
  { key: "website",               label: "Website",             hint: "Site do negócio (alias: {{site}})" },
  { key: "instagram",             label: "Instagram",           hint: "@ ou URL do Instagram capturado" },
  { key: "facebook",              label: "Facebook",            hint: "URL do Facebook capturado" },
  { key: "telefone",              label: "Telefone",            hint: "Número de telefone / WhatsApp limpo" },
  { key: "maps_url",              label: "Link Google Maps",    hint: "URL da ficha do negócio no Google Maps (alias: {{link_maps}})" },
  { key: "horario_funcionamento", label: "Horário func.",       hint: "Horários de funcionamento no Google Maps (alias: {{horarios}})" },
  { key: "aberto_agora",          label: "Aberto agora",        hint: "Status de abertura no Google Maps" },
  { key: "faixa_preco",           label: "Faixa de preço",      hint: "Faixa de preço informada no Google Maps (alias: {{preco}})" },
  { key: "atributos",             label: "Atributos Maps",      hint: "Diferenciais do negócio no Maps (Entrega, Acessibilidade, etc.)" },
  { key: "proprietario",          label: "Proprietário",        hint: "Nome do dono/proprietário no Google Maps (alias: {{dono}})" },
  { key: "reivindicado",          label: "Perfil reivindicado", hint: "Se a empresa reivindicou o perfil no Google (Sim/Não)" },
  { key: "total_fotos",           label: "Total de fotos",      hint: "Quantidade de fotos no Google Maps" },
  { key: "topicos_avaliacoes",    label: "Tópicos avaliações",  hint: "Temas mais mencionados nas avaliações do Google" },
  { key: "categorias_adicionais", label: "Categorias extras",   hint: "Subcategorias adicionais do negócio no Google Maps" },
  { key: "descricao_google",      label: "Descrição Maps",      hint: "Descrição oficial 'Sobre' da empresa no Google Maps" },
  { key: "link_previa",           label: "Link prévia site",    hint: "URL da prévia de site gerada para o lead (alias: {{site_previa}})" },
  { key: "email",                 label: "Email",               hint: "Email do lead (se cadastrado)" },
  { key: "observacoes",           label: "Observações",         hint: "Notas livres do CRM" },
  { key: "data_atual",            label: "Data e dia atual",    hint: "Dia da semana + data atual (ex: sexta-feira, 06/11/2026)" },
  { key: "dia_semana",            label: "Dia da semana",       hint: "Dia da semana atual por extenso (hora SP)" },
  { key: "data",                  label: "Data",                hint: "Data atual DD/MM/AAAA" },
  { key: "hora",                  label: "Hora",                hint: "Hora atual HH:MM" },
] as const;

/** Lista completa de variáveis pra mostrar como chips na UI (inclui agendamento). */
export const TEMPLATE_VARIABLES = [
  ...PROMPT_VARIABLES,
  // Variáveis injetadas em contexto de AGENDAMENTO (via ctx.variables)
  { key: "hora_agendamento", label: "Hora ag.",  hint: "Hora do agendamento (HH:MM)" },
  { key: "data_agendamento", label: "Data ag.",  hint: "Data do agendamento (DD/MM)" },
  { key: "servico",          label: "Serviço",   hint: "Nome do serviço agendado" },
  { key: "titulo",           label: "Título ag.", hint: "Título completo do agendamento" },
  { key: "meet_link",        label: "Link Meet", hint: "URL do Google Meet quando o agendamento tiver" },
  { key: "local",            label: "Local",     hint: "Endereço do agendamento (location do Google)" },
] as const;
