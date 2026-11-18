/**
 * sdr-enrichment-dossier — compila o dossiê tático do Extrator V2.5 + edições do CRM
 * para o `<lead_context>` da Sarah SDR / Closer sem quebrar o prefix cache do `promptMaster`.
 */

import {
  sanitizePromptSignal,
  type AgentAiDossierMode,
  type LeadCrmOverrides,
} from "@/lib/crm-lead-profile";
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
  year_established?: number | string | null;
  review_topics?: unknown;
  business_details?: {
    enrichment?: Partial<LeadEnrichmentData> | null;
    crm_overrides?: Partial<LeadCrmOverrides> | null;
    services?: ReadonlyArray<string> | null;
  } | null;
}

function asString(v: unknown, maxLen = 160): string {
  return sanitizePromptSignal(v, maxLen);
}

function asNumber(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function asStringArray(v: unknown, maxItems = 6): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    const clean = sanitizePromptSignal(item, 80);
    if (clean) {
      out.push(clean);
      if (out.length >= maxItems) break;
    }
  }
  return out;
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
 * Suporta 3 modos: `"strategic"` (bastidores discretos), `"full"` (personalização rica) e `"off"`.
 */
export function buildSdrLeadDossierBlock(
  lead: SdrLeadDossierInput | null | undefined,
  mode: AgentAiDossierMode = "strategic",
): string {
  if (!lead || mode === "off") return "";

  const enr = (lead.business_details?.enrichment || {}) as Partial<LeadEnrichmentData>;
  const overrides = (lead.business_details?.crm_overrides || {}) as Partial<LeadCrmOverrides>;

  const website = asString(lead.website, 220);
  const nomeEmpresa = asString(enr.empresaCurta, 120) || asString(lead.nome_negocio, 120);
  const hasOverrideServico = Object.prototype.hasOwnProperty.call(overrides, "servicoPrincipal");
  const especialidade =
    (hasOverrideServico ? asString(overrides.servicoPrincipal, 120) : "") ||
    asString(enr.servicoPrincipal, 120) ||
    asString(lead.categoria, 120) ||
    asString(lead.ramo_negocio, 120);

  const hasOverrideSocio = Object.prototype.hasOwnProperty.call(overrides, "socioDecisor");
  const socioDecisor = hasOverrideSocio
    ? asString(overrides.socioDecisor, 120)
    : asString(enr.socioDecisor, 120) || asString(lead.owner_name, 120);

  const primeiroNomeSocio =
    (hasOverrideSocio ? asString(overrides.primeiroNomeSocio, 60) : asString(enr.primeiroNomeSocio, 60)) ||
    (socioDecisor ? socioDecisor.split(/\s+/)[0] || "" : "");

  const rawChannel = Object.prototype.hasOwnProperty.call(overrides, "canalWhatsapp")
    ? overrides.canalWhatsapp
    : enr.whatsappChannelType;
  const channelType = asString(rawChannel, 40) as WhatsAppChannelType | "";

  const score = asNumber(enr.qualificationScore);
  const hasOverridePorte = Object.prototype.hasOwnProperty.call(overrides, "porte");
  const porte = hasOverridePorte ? asString(overrides.porte, 60) : asString(enr.porte, 60);
  const capital = asNumber(enr.capitalSocial);
  const anosEmpresa = asNumber(enr.anosEmpresa);
  const siteDiagnostico = asString(enr.siteDiagnostico, 160);
  const siteStatusLabel = asString(enr.siteStatusLabel, 100);
  const discoveredRealWebsite = asString(enr.discoveredRealWebsite, 200);
  const abandonedCopyrightYear = asNumber(enr.abandonedCopyrightYear);
  const hasPaidTrafficTag = enr.hasPaidTrafficTag === true;
  const trafficTags = asStringArray(enr.trafficTags);
  const managementTools = asStringArray(enr.managementTools);
  const reviewsCount = asNumber(lead.reviews);
  const rating = asNumber(lead.avaliacao);
  const cnaeDescricao = asString(enr.cnaeDescricao, 140);
  const faixaEtaria = asString(enr.faixaEtariaSocio, 50);
  const anoGoogle = asString(lead.year_established, 20);
  const topicosAvaliacoes = Array.isArray(lead.review_topics)
    ? asStringArray(lead.review_topics, 5)
    : [];

  const hasEnrichmentSignals =
    Boolean(enr.siteHealth) ||
    Boolean(socioDecisor) ||
    Boolean(channelType) ||
    score != null ||
    hasPaidTrafficTag ||
    managementTools.length > 0 ||
    Boolean(discoveredRealWebsite) ||
    abandonedCopyrightYear != null ||
    Boolean(website) ||
    Boolean(especialidade && hasOverrideServico);

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
  if (porte && porte !== "Não informado") socioParts.push(`Porte: ${porte}`);
  if (mode === "strategic" && capital != null && capital > 0) {
    socioParts.push(`Capital (uso interno): R$ ${Math.round(capital).toLocaleString("pt-BR")}`);
  } else if (mode === "full" && capital != null && capital > 0) {
    socioParts.push(`Capital (uso interno): R$ ${Math.round(capital).toLocaleString("pt-BR")}`);
  }
  if (anosEmpresa != null && anosEmpresa >= 0) socioParts.push(`${Math.floor(anosEmpresa)} anos de CNPJ`);
  if (mode === "full" && anoGoogle) socioParts.push(`No Google desde ${anoGoogle}`);
  if (mode === "full" && faixaEtaria) socioParts.push(`Perfil etário decisor (interno): ${faixaEtaria}`);
  if (socioParts.length > 0) dossierLines.push(`- ${socioParts.join(" | ")}`);

  if (mode === "full" && cnaeDescricao) {
    dossierLines.push(`- Atividade principal registrada: ${cnaeDescricao}`);
  }
  if (mode === "full" && topicosAvaliacoes.length > 0) {
    dossierLines.push(`- Temas mais elogiados/citados no Google: ${topicosAvaliacoes.join(", ")}`);
  }

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

  dossierLines.push("");
  dossierLines.push("# 🧭 DIRETRIZ TÁTICA DESTE TURNO (OBRIGATÓRIO RESPEITAR)");
  dossierLines.push(
    "- SIGILO E ÉTICA COMERCIAL (LGPD): Use porte, tempo de CNPJ, quadro societário e perfil etário APENAS nos bastidores para calibrar tom e qualificação. NUNCA mencione número de CNPJ, Receita Federal, capital social ou faixa etária na conversa.",
  );

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
      mode === "full"
        ? `- CONTATO DIRETO COM DECISOR: Canal identificado como contato direto de ${primeiroNomeSocio}. Trate pelo primeiro nome com naturalidade consultiva e conecte o argumento à especialidade (${especialidade || "negócio"}).`
        : `- CONTATO DIRETO COM DECISOR: Canal identificado como contato direto de ${primeiroNomeSocio}. Trate pelo primeiro nome de forma natural, sem parecer robô.`,
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
