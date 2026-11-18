/**
 * sdr-enrichment-dossier — compila o dossiê tático do Extrator V2.5 para o
 * `<lead_context>` da Sarah SDR / Closer sem quebrar o prefix cache do `promptMaster`.
 */

import type {
  LeadEnrichmentData,
  SiteHealthStatus,
  WhatsAppChannelType,
} from "@/lib/scraper-lead-enrichment";

export interface SdrLeadDossierInput {
  nome_negocio?: string | null;
  ramo_negocio?: string | null;
  categoria?: string | null;
  website?: string | null;
  avaliacao?: number | string | null;
  reviews?: number | string | null;
  owner_name?: string | null;
  business_details?: {
    enrichment?: Partial<LeadEnrichmentData> | null;
    services?: ReadonlyArray<string> | null;
  } | null;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function formatChannelLabel(channelType: WhatsAppChannelType | string): string {
  if (channelType === "socio_direto") return "WhatsApp direto do sócio-decisor";
  if (channelType === "provavel_socio") return "Provável celular direto do sócio";
  if (channelType === "recepcao_comercial") return "Recepção / Secretária (gatekeeper comercial)";
  return "Comercial / indefinido";
}

function resolveSiteHealth(
  enr: Partial<LeadEnrichmentData>,
  website: string,
): SiteHealthStatus {
  const health = enr.siteHealth;
  if (
    health === "broken_site" ||
    health === "weak_site" ||
    health === "no_site" ||
    health === "active_site"
  ) {
    return health;
  }
  return website ? "active_site" : "no_site";
}

/**
 * Gera bloco conciso e acionável de inteligência tática do lead para `<lead_context>`.
 * Retorna string vazia quando não houver sinais úteis suficientes.
 */
export function buildSdrLeadDossierBlock(
  lead: SdrLeadDossierInput | null | undefined,
): string {
  if (!lead) return "";

  const enr = (lead.business_details?.enrichment || {}) as Partial<LeadEnrichmentData>;
  const website = asString(lead.website);
  const nomeEmpresa = asString(enr.empresaCurta) || asString(lead.nome_negocio);
  const especialidade =
    asString(enr.servicoPrincipal) ||
    asString(lead.categoria) ||
    asString(lead.ramo_negocio);

  const socioDecisor = asString(enr.socioDecisor) || asString(lead.owner_name);
  const primeiroNomeSocio =
    asString(enr.primeiroNomeSocio) ||
    (socioDecisor ? socioDecisor.split(/\s+/)[0] || "" : "");

  const channelType = asString(enr.whatsappChannelType) as WhatsAppChannelType | "";
  const score = asNumber(enr.qualificationScore);
  const porte = asString(enr.porte);
  const capital = asNumber(enr.capitalSocial);
  const anosEmpresa = asNumber(enr.anosEmpresa);
  const siteDiagnostico = asString(enr.siteDiagnostico);
  const siteStatusLabel = asString(enr.siteStatusLabel);
  const discoveredRealWebsite = asString(enr.discoveredRealWebsite);
  const abandonedCopyrightYear = asNumber(enr.abandonedCopyrightYear);
  const hasPaidTrafficTag = enr.hasPaidTrafficTag === true;
  const trafficTags = asStringArray(enr.trafficTags);
  const managementTools = asStringArray(enr.managementTools);
  const reviewsCount = asNumber(lead.reviews);
  const rating = asNumber(lead.avaliacao);

  const hasEnrichmentSignals =
    Boolean(enr.siteHealth) ||
    Boolean(socioDecisor) ||
    Boolean(channelType) ||
    score != null ||
    hasPaidTrafficTag ||
    managementTools.length > 0 ||
    Boolean(discoveredRealWebsite) ||
    abandonedCopyrightYear != null ||
    Boolean(website);

  if (!hasEnrichmentSignals) return "";

  const siteHealth = resolveSiteHealth(enr, website);
  const dossierLines: string[] = ["# 📊 DOSSIÊ TÁTICO DO LEAD (EXTRATOR V2.5)"];

  const metaParts: string[] = [];
  if (score != null) metaParts.push(`Score ICP: ${Math.round(score)}/100`);
  if (nomeEmpresa) metaParts.push(`Empresa Curta: ${nomeEmpresa}`);
  if (especialidade) metaParts.push(`Especialidade: ${especialidade}`);
  if (rating != null || reviewsCount != null) {
    const revStr = [
      rating != null ? `Nota ${rating.toFixed(1)}★` : "",
      reviewsCount != null ? `${reviewsCount} avaliações Google` : "",
    ]
      .filter(Boolean)
      .join(" / ");
    if (revStr) metaParts.push(revStr);
  }
  if (metaParts.length > 0) dossierLines.push(`- ${metaParts.join(" | ")}`);

  const socioParts: string[] = [];
  if (socioDecisor) {
    socioParts.push(
      primeiroNomeSocio && primeiroNomeSocio !== socioDecisor
        ? `Sócio-decisor: ${socioDecisor} (1º nome: ${primeiroNomeSocio})`
        : `Sócio-decisor: ${socioDecisor}`,
    );
  }
  if (porte) socioParts.push(`Porte: ${porte}`);
  if (capital != null && capital > 0) {
    socioParts.push(`Capital: R$ ${Math.round(capital).toLocaleString("pt-BR")}`);
  }
  if (anosEmpresa != null && anosEmpresa >= 0) socioParts.push(`${Math.floor(anosEmpresa)} anos de CNPJ`);
  if (socioParts.length > 0) dossierLines.push(`- ${socioParts.join(" | ")}`);

  if (channelType) {
    dossierLines.push(`- Canal WhatsApp identificado: ${formatChannelLabel(channelType)}`);
  }

  const siteParts: string[] = [];
  if (siteHealth === "broken_site") {
    siteParts.push(
      `Site QUEBRADO/COM FALHA (${siteDiagnostico || siteStatusLabel || "erro ao abrir"})`,
    );
  } else if (siteHealth === "weak_site") {
    siteParts.push(
      `Site FRACO/IMPROVISADO (${siteDiagnostico || siteStatusLabel || "estrutura improvisada/lenta"})`,
    );
  } else if (siteHealth === "no_site") {
    siteParts.push(`Sem site próprio (${siteDiagnostico || siteStatusLabel || "apenas Google/redes sociais"})`);
  } else {
    siteParts.push(`Site ativo (${siteStatusLabel || "funcionando"})`);
  }
  if (discoveredRealWebsite) {
    siteParts.push(`Domínio real achado via link-in-bio: ${discoveredRealWebsite}`);
  }
  if (abandonedCopyrightYear) {
    siteParts.push(`Rodapé parado em © ${abandonedCopyrightYear}`);
  }
  dossierLines.push(`- Diagnóstico do site: ${siteParts.join(" | ")}`);

  const investSignals: string[] = [];
  if (hasPaidTrafficTag) {
    investSignals.push(
      trafficTags.length > 0
        ? `Anúncios pagos detectados (${trafficTags.join(", ")})`
        : "Anúncios pagos detectados",
    );
  }
  if (managementTools.length > 0) {
    investSignals.push(`Sistemas de agenda/CRM detectados (${managementTools.join(", ")})`);
  }
  if (investSignals.length > 0) {
    dossierLines.push(`- Sinais de investimento atual: ${investSignals.join(" | ")}`);
  }

  // Diretrizes táticas específicas para este turno (sobrescrevem suposições genéricas de prompt)
  dossierLines.push("");
  dossierLines.push("# 🧭 DIRETRIZ TÁTICA DESTE TURNO (OBRIGATÓRIO RESPEITAR)");

  if (channelType === "recepcao_comercial") {
    const targetName = primeiroNomeSocio || "o responsável";
    dossierLines.push(
      `- GATEKEEPER / RECEPÇÃO DETECTADA: Se quem respondeu ainda parecer ser secretária ou atendimento, NÃO despeje pitch técnico na recepção. Cumprimente com leveza e peça encaminhamento ou contato direto para ${targetName}${nomeEmpresa ? ` (${nomeEmpresa})` : ""}. Caso já tenha sido encaminhada ou ${targetName} responda diretamente, siga o atendimento normalmente.`,
    );
  } else if (
    (channelType === "socio_direto" || channelType === "provavel_socio") &&
    primeiroNomeSocio
  ) {
    dossierLines.push(
      `- CONTATO DIRETO COM DECISOR: Canal identificado como contato direto de ${primeiroNomeSocio}. Trate pelo primeiro nome de forma natural, sem parecer robô.`,
    );
  }

  if (siteHealth === "broken_site") {
    const diagText = siteDiagnostico || siteStatusLabel || "apresentando falha ao abrir";
    dossierLines.push(
      `- ÂNGULO OBRIGATÓRIO (SITE QUEBRADO): PROIBIDO dizer que a empresa "não tem site" ou "está sem site vinculado". Eles JÁ TÊM um endereço vinculado, porém o site está ${diagText}. Use isso com tato consultivo (sem citar siglas técnicas como DNS, SSL ou HTTP): explique que clientes procurando no Google clicam para conhecer e dão de cara com a página fora do ar ou com erro, e ofereça montar uma prévia gratuita de como ficaria um site novo profissional para recuperar esses clientes. Se o cliente disser "Já tenho site", NUNCA diga que o botão do site não apareceu no Maps — confirme que viu o endereço vinculado lá, porém ele falhou ao abrir no celular.`,
    );
  } else if (siteHealth === "weak_site") {
    const diagText = siteDiagnostico || siteStatusLabel || "estrutura improvisada/lenta";
    const adsNote = hasPaidTrafficTag
      ? " — especialmente relevante porque já investem em anúncios pagos e podem estar perdendo cliques"
      : "";
    dossierLines.push(
      `- ÂNGULO OBRIGATÓRIO (SITE FRACO / IMPROVISADO): PROIBIDO dizer que "não têm site". Reconheça que hoje usam estrutura simples/lenta (${diagText})${adsNote}. Ofereça mostrar numa prévia gratuita uma página profissional mais rápida e pensada para transformar visitantes em contatos no WhatsApp. Se o cliente disser "Já tenho site", reconheça o link existente e explique com leveza que dá para comparar com uma página própria mais rápida.`,
    );
  } else if (siteHealth === "no_site") {
    dossierLines.push(
      `- ÂNGULO OBRIGATÓRIO (SEM SITE): A empresa se destaca no Google${nomeEmpresa ? ` (${nomeEmpresa})` : ""}, mas ainda está sem um site profissional próprio vinculado para transformar quem pesquisa em novos atendimentos. Ofereça a prévia gratuita sob medida.`,
    );
  } else {
    dossierLines.push(
      `- ÂNGULO CONSULTIVO (SITE ATIVO): Foque em melhorar a conversão de visitantes no Google para o WhatsApp e ofereça mostrar uma prévia gratuita com nova proposta visual sem compromisso.`,
    );
  }

  if (managementTools.length > 0) {
    dossierLines.push(
      `- SISTEMAS DETECTADOS (${managementTools.join(", ")}): Se fizer sentido na conversa, mencione que o novo site não muda a rotina interna da equipe e conecta diretamente nos botões/agendamento atual (${managementTools.join(", ")}).`,
    );
  }

  return dossierLines.join("\n");
}

