import { createElement } from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  auditLeadWebsite,
  cleanLeadNameForSearch,
  clearEnrichmentCachesForTest,
  computeLeadQualificationScore,
  discoverCnpjsViaWebSearch,
  discoverCnpjViaWebSearch,
  enrichCapturedLead,
  extractCnpjsFromText,
  extractWhatsAppPhonesFromHtml,
  formatCnpj,
  isCnpjMatchingLead,
  isLikelyAccountingPhone,
  isValidCnpj,
  lookupCnpjFreeCascade,
  lookupRdapBrDomain,
  pickManagingPartner,
  cleanGoogleServicesList,
  detectFranchiseOrChain,
  detectPaidTrafficTags,
  detectReceptionistSignals,
  expandBrPhoneCheckVariants,
  extractShortCompanyName,
  seedTenantPhoneCnpjRoots,
  toTitleCasePtBr,
} from "../scraper-lead-enrichment";
import { getNeighborhoodExpansionQueries } from "../geo-regions";
import { makeSearchKey } from "../scraper-search-memory";
import { matchesSiteFilterMode, parseMinCapitalSocial, parseSiteFilterMode } from "../scraper-lead-filters";
import { renderTemplate } from "../template-vars";

vi.mock("@/components/layout/header", () => ({ Header: () => null }));
vi.mock("@/lib/supabase", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        order: () => ({
          eq: () => Promise.resolve({ data: [], error: null }),
          then: (cb: (v: { data: unknown[]; error: null }) => unknown) => Promise.resolve(cb({ data: [], error: null })),
        }),
        eq: () => ({
          order: () => ({
            limit: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    }),
    channel: () => ({
      on: function () { return this; },
      subscribe: function () { return this; },
    }),
    removeChannel: () => {},
  },
  supabaseAdmin: null,
}));

import CaptadorPage from "@/app/captador/page";
import ProspeccaoSitesPage from "@/app/prospeccao-sites/page";
import AutomacaoPage from "@/app/automacao/page";

const CNPJ_VALIDO_1 = "11222333000181";
const CNPJ_VALIDO_2 = "22333444000181";
const CNPJ_VALIDO_3 = "33444555000181";

describe("scraper-lead-enrichment — utilitários de CNPJ, WhatsApp e sócio", () => {
  beforeEach(() => {
    clearEnrichmentCachesForTest();
  });

  it("valida e formata CNPJs pelo algoritmo Módulo-11 rejeitando dígitos repetidos e inválidos", () => {
    expect(isValidCnpj(CNPJ_VALIDO_1)).toBe(true);
    expect(isValidCnpj("11.222.333/0001-81")).toBe(true);
    expect(isValidCnpj("00000000000000")).toBe(false);
    expect(isValidCnpj("11111111111111")).toBe(false);
    expect(isValidCnpj("11222333000182")).toBe(false);
    expect(isValidCnpj("123")).toBe(false);
    expect(formatCnpj(CNPJ_VALIDO_1)).toBe("11.222.333/0001-81");
  });

  it("extrai apenas CNPJs válidos e links WhatsApp do HTML do site", () => {
    const html = `
      <footer>
        <p>CNPJ: 11.222.333/0001-81 | Fake: 99.999.999/9999-99</p>
        <a href="https://wa.me/5527999887766?text=Oi">Falar</a>
        <a href="https://api.whatsapp.com/send?phone=+55 (27) 98877-6655">Zap 2</a>
        <a href="https://example.com/consultacnpj/${CNPJ_VALIDO_2}">Link</a>
      </footer>
    `;
    expect(extractCnpjsFromText(html)).toEqual([CNPJ_VALIDO_1, CNPJ_VALIDO_2]);
    expect(extractWhatsAppPhonesFromHtml(html)).toEqual(["5527988776655", "5527999887766"]);
  });

  it("normaliza nomes em Title Case PT-BR e prioriza Sócio-Administrador pessoa física", () => {
    expect(toTitleCasePtBr("11222333000181 JOAO CARLOS DA SILVA")).toBe("Joao Carlos da Silva");
    const partner = pickManagingPartner([
      { nome: "EMPRESA HOLDING PARTICIPACOES LTDA", qualificacao: "Sócio-Administrador" },
      { nome: "MARIA APARECIDA DOS SANTOS", qualificacao: "Sócia" },
      { nome: "RODRIGO ALMEIDA DE SOUZA", qualificacao: "Sócio-Administrador" },
    ]);
    expect(partner).toEqual({
      fullName: "Rodrigo Almeida de Souza",
      firstName: "Rodrigo",
    });

    const meiFallback = pickManagingPartner([], "CARLOS EDUARDO PEREIRA 12345678900 MEI", true);
    expect(meiFallback?.firstName).toBe("Carlos");
  });
});

describe("auditLeadWebsite — detecção precisa sem falso-positivo Cloudflare", () => {
  it("classifica ausência de site ou apenas link social como no_site", async () => {
    const empty = await auditLeadWebsite("");
    expect(empty.status).toBe("no_site");

    const insta = await auditLeadWebsite("https://instagram.com/minhaclinica");
    expect(insta.status).toBe("no_site");
    expect(insta.issueCode).toBe("social_link_only");
  });

  it("detecta DNS morto, SSL vencido, HTTP 500 e erro de banco WordPress como broken_site", async () => {
    const dnsErrFetch = vi.fn().mockRejectedValue(Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }));
    const dnsOut = await auditLeadWebsite("https://siteinexistente.com.br", dnsErrFetch as any);
    expect(dnsOut.status).toBe("broken_site");
    expect(dnsOut.issueCode).toBe("dns_error");

    const sslErrFetch = vi.fn().mockRejectedValue(Object.assign(new Error("certificate has expired"), { code: "CERT_HAS_EXPIRED" }));
    const sslOut = await auditLeadWebsite("https://sslvencido.com.br", sslErrFetch as any);
    expect(sslOut.status).toBe("broken_site");
    expect(sslOut.issueCode).toBe("ssl_expired");

    const http500Fetch = vi.fn().mockResolvedValue(new Response("Internal Server Error", { status: 500 }));
    const http500Out = await auditLeadWebsite("https://erro500.com.br", http500Fetch as any);
    expect(http500Out.status).toBe("broken_site");
    expect(http500Out.issueCode).toBe("http_500");

    const wpDbFetch = vi.fn().mockResolvedValue(
      new Response("<html><body><h1>Error establishing a database connection</h1></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );
    const wpOut = await auditLeadWebsite("https://wpquebrado.com.br", wpDbFetch as any);
    expect(wpOut.status).toBe("broken_site");
    expect(wpOut.issueCode).toBe("db_error");
  });

  it("evita falso positivo quando o site usa desafio anti-bot Cloudflare (403 com cf-ray)", async () => {
    const cfFetch = vi.fn().mockResolvedValue(
      new Response("Just a moment...", {
        status: 403,
        headers: { "cf-ray": "8abc123-GRU", server: "cloudflare" },
      }),
    );
    const out = await auditLeadWebsite("https://clienteprotegido.com.br", cfFetch as any);
    expect(out.status).toBe("active_site");
    expect(out.issueCode).toBe("waf_protected");
  });

  it("classifica Linktree ou HTTP sem SSL como weak_site e site saudável extraindo wa.me e CNPJ", async () => {
    const linktreeFetch = vi.fn().mockResolvedValue(new Response("<html><body>Links</body></html>", { status: 200 }));
    const linktreeOut = await auditLeadWebsite("https://linktr.ee/clinica", linktreeFetch as any);
    expect(linktreeOut.status).toBe("weak_site");
    expect(linktreeOut.issueCode).toBe("improvised_host");

    const httpNoSslFetch = vi.fn().mockResolvedValue(new Response("<html><body>Site OK</body></html>", { status: 200 }));
    const httpOut = await auditLeadWebsite("http://semcadeado.com.br", httpNoSslFetch as any);
    expect(httpOut.status).toBe("weak_site");
    expect(httpOut.issueCode).toBe("no_https");

    const healthyFetch = vi.fn().mockResolvedValue(
      new Response(
        `<html><body>CNPJ 11.222.333/0001-81 <a href="https://wa.me/5527999112233">Zap</a></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      ),
    );
    const healthyOut = await auditLeadWebsite("https://saudavel.com.br", healthyFetch as any);
    expect(healthyOut.status).toBe("active_site");
    expect(healthyOut.extractedCnpjs).toEqual([CNPJ_VALIDO_1]);
    expect(healthyOut.extractedWhatsApps).toEqual(["5527999112233"]);
  });
});

describe("RDAP Registro.br + Cascata Receita Gratuita + Anti-Homônimo + Anti-Contador", () => {
  beforeEach(() => {
    clearEnrichmentCachesForTest();
  });

  it("extrai CNPJ titular do RDAP oficial do Registro.br e detecta domínio congelado (hold)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      Response.json({
        status: ["clientTransferProhibited", "server hold"],
        entities: [{ publicIds: [{ type: "cnpj", identifier: "11.222.333/0001-81" }] }],
      }),
    );
    const rdap = await lookupRdapBrDomain("https://sub.escritorioramos.com.br/contato", mockFetch as any);
    expect(rdap).toEqual({ cnpj: CNPJ_VALIDO_1, frozen: true });
    expect(mockFetch).toHaveBeenCalledWith(
      "https://rdap.registro.br/domain/escritorioramos.com.br",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("executa failover gratuito BrasilAPI (429) -> OpenCNPJ (200) -> MinhaReceita normalizando sócio e telefones", async () => {
    const mockFetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("brasilapi.com.br")) {
        return new Response("rate limited", { status: 429 });
      }
      if (url.includes("api.opencnpj.org")) {
        return Response.json({
          razao_social: "ODONTO PREMIUM VITORIA LTDA",
          situacao_cadastral: "ATIVA",
          porte_empresa: "EPP",
          opcao_mei: "N",
          capital_social: "150000,00",
          data_inicio_atividade: "2018-03-10",
          municipio: "VITORIA",
          uf: "ES",
          QSA: [{ nome_socio: "FERNANDO COSTA", qualificacao_socio: "Sócio-Administrador" }],
          telefones: [{ ddd: "27", numero: "999887766" }],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const data = await lookupCnpjFreeCascade(CNPJ_VALIDO_1, "rdap_br", mockFetch as any);
    expect(data).not.toBeNull();
    expect(data?.isAtiva).toBe(true);
    expect(data?.isMei).toBe(false);
    expect(data?.porte).toBe("EPP");
    expect(data?.capitalSocial).toBe(150000);
    expect(data?.socioDecisor).toBe("Fernando Costa");
    expect(data?.primeiroNomeSocio).toBe("Fernando");
    expect(data?.telefonesReceita).toEqual(["5527999887766"]);
  });

  it("rejeita homônimo de outro estado/município vindo de Web Search e marca telefone compartilhado por contadores", async () => {
    const webCnpj = await discoverCnpjViaWebSearch(
      "Clínica Sorriso",
      "Vitória",
      "ES",
      async () => [
        {
          title: "Clínica Sorriso LTDA - Vitória ES",
          snippet: "CNPJ 22.333.444/0001-81 localizado em Vitória ES",
          url: "https://casadosdados.com.br/clinica-sorriso",
        },
      ],
    );
    expect(webCnpj).toBe(CNPJ_VALIDO_2);

    const mismatched = isCnpjMatchingLead(
      {
        cnpj: CNPJ_VALIDO_2,
        razaoSocial: "PADARIA BOM PAO LTDA",
        situacaoCadastral: "ATIVA",
        isAtiva: true,
        isMei: false,
        porte: "ME",
        capitalSocial: 50000,
        municipio: "MANAUS",
        uf: "AM",
        telefonesReceita: [],
        socios: [],
        source: "web_search",
      },
      "Clínica Sorriso",
      "Vitória",
      "ES",
    );
    expect(mismatched).toBe(false);

    // Mesmo telefone em 2 CNPJs distintos -> detectado como telefone de contabilidade
    const accountingPhonePayload = (razao: string) => ({
      razao_social: razao,
      descricao_situacao_cadastral: "ATIVA",
      porte: "ME",
      capital_social: 20000,
      ddd_telefone_1: "2733221100",
      qsa: [],
    });
    const fetchShared = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes(CNPJ_VALIDO_1)) return Response.json(accountingPhonePayload("EMPRESA A LTDA"));
      if (url.includes(CNPJ_VALIDO_3)) return Response.json(accountingPhonePayload("EMPRESA B LTDA"));
      return new Response("not found", { status: 404 });
    });

    await lookupCnpjFreeCascade(CNPJ_VALIDO_1, "site_html", fetchShared as any);
    await lookupCnpjFreeCascade(CNPJ_VALIDO_3, "site_html", fetchShared as any);
    expect(isLikelyAccountingPhone("2733221100")).toBe(true);
  });

  it("limpa sufixos de SEO do Maps e faz failover de homônimo para o 2º candidato CNPJ válido", async () => {
    expect(cleanLeadNameForSearch("Andrade Costa | Advocacia e Consultoria - Santo André-SP")).toBe("Andrade Costa");
    expect(cleanLeadNameForSearch("Dr. João Silva - Implantodontia (Campinas)")).toBe("Dr. João Silva");

    let capturedQuery = "";
    const candidates = await discoverCnpjsViaWebSearch(
      "Clínica Sorriso | Implantes e Estética - Campinas/SP",
      "Campinas",
      "SP",
      async (q) => {
        capturedQuery = q;
        return [
          {
            title: "Clínica Sorriso - Goiânia GO",
            snippet: "CNPJ 11.222.333/0001-81 em Campinas",
            url: "https://casadosdados.com.br/sorriso_go_11222333000181",
          },
          {
            title: "Clínica Sorriso Campinas SP",
            snippet: "CNPJ 22.333.444/0001-81 em Campinas SP",
            url: "https://casadosdados.com.br/sorriso_22333444000181",
          },
        ];
      },
    );
    expect(capturedQuery).toBe("Clínica Sorriso Campinas SP CNPJ");
    expect(candidates).toEqual([CNPJ_VALIDO_2, CNPJ_VALIDO_1]);

    const fetchMulti = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes(CNPJ_VALIDO_1)) {
        return Response.json({
          razao_social: "SORRISO HOMONIMO GO LTDA",
          descricao_situacao_cadastral: "ATIVA",
          porte: "ME",
          capital_social: 10000,
          municipio: "GOIANIA",
          uf: "GO",
          cep: "74000000",
          qsa: [{ nome_socio: "OUTRO SOCIO", qualificacao_socio: "Sócio-Administrador" }],
        });
      }
      if (url.includes(CNPJ_VALIDO_2)) {
        return Response.json({
          razao_social: "DRA ANA CLARA ODONTOLOGIA LTDA",
          descricao_situacao_cadastral: "ATIVA",
          porte: "EPP",
          capital_social: 120000,
          municipio: "CAMPINAS",
          uf: "SP",
          cep: "13010111",
          qsa: [{ nome_socio: "ANA CLARA RIBEIRO", qualificacao_socio: "Sócio-Administrador" }],
        });
      }
      return new Response("not found", { status: 404 });
    });

    const out = await enrichCapturedLead({
      name: "Clínica Sorriso | Implantes - Campinas",
      phone: "19999887766",
      cep: "13010-200",
      cidade: "Campinas",
      uf: "SP",
      options: {
        auditSiteHealth: false,
        enrichCnpj: true,
        prioritizePartnerPhone: true,
        validateWhatsApp: false,
      },
      fetchImpl: fetchMulti as any,
      searchFn: async () => [
        {
          title: "Sorriso 1",
          snippet: "Campinas SP CNPJ 11.222.333/0001-81",
          url: "https://cnpj.biz/11222333000181",
        },
        {
          title: "Sorriso Campinas",
          snippet: "CNPJ 22.333.444/0001-81",
          url: "https://cnpj.biz/22333444000181",
        },
      ],
    });

    expect(out.cnpjResult?.cnpj).toBe(CNPJ_VALIDO_2);
    expect(out.enrichment.socioDecisor).toBe("Ana Clara Ribeiro");
  });
});

describe("enrichCapturedLead + WhatsApp Business fixo + Template Vars + Filtros", () => {
  beforeEach(() => {
    clearEnrichmentCachesForTest();
  });

  it("recupera telefone fixo que possui WhatsApp Business validado na Evolution API", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("brasilapi.com.br")) {
        return Response.json({
          razao_social: "CLINICA ODONTO CENTRO LTDA",
          descricao_situacao_cadastral: "ATIVA",
          porte: "EPP",
          capital_social: 200000,
          data_inicio_atividade: "2016-01-15",
          ddd_telefone_1: "2733334444",
          qsa: [{ nome_socio: "ANA PAULA MENDES", qualificacao_socio: "Sócio-Administrador" }],
        });
      }
      if (url.includes("rdap.registro.br")) {
        return Response.json({
          status: ["published"],
          entities: [{ publicIds: [{ type: "cnpj", identifier: "11.222.333/0001-81" }] }],
        });
      }
      return new Response("Internal Server Error", { status: 500 });
    });

    const checkWaFn = vi.fn().mockResolvedValue({
      "552733334444": { exists: true, jid: "552733334444@s.whatsapp.net" },
    });

    const out = await enrichCapturedLead({
      name: "Clínica Odonto Centro",
      phone: "2733334444",
      website: "https://odontocentro.com.br",
      cidade: "Vitória",
      uf: "ES",
      reviewCount: "95",
      averageRating: "4.8",
      claimed: true,
      options: {
        auditSiteHealth: true,
        enrichCnpj: true,
        prioritizePartnerPhone: true,
        validateWhatsApp: true,
      },
      fetchImpl: fetchMock as any,
      searchFn: async () => [],
      checkWhatsAppFn: checkWaFn,
    });

    expect(out.usedLandlineWithWhatsApp).toBe(true);
    expect(out.noActiveWhatsApp).toBe(false);
    expect(out.bestPhone).toBe("552733334444");
    expect(out.enrichment.siteHealth).toBe("broken_site");
    expect(out.enrichment.socioDecisor).toBe("Ana Paula Mendes");
    expect(out.enrichment.primeiroNomeSocio).toBe("Ana");
    expect(out.enrichment.whatsappVerified).toBe(true);
    expect(out.enrichment.qualificationScore).toBeGreaterThanOrEqual(80);
  });

  it("prioriza celular direto do sócio ou wa.me do site quando fixo do Maps não tem WhatsApp", async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes("rdap.registro.br")) {
        return Response.json({
          status: ["published"],
          entities: [{ publicIds: [{ type: "cnpj", identifier: "22.333.444/0001-81" }] }],
        });
      }
      if (url.includes("brasilapi.com.br")) {
        return Response.json({
          razao_social: "INSTITUTO BELEZA REAL LTDA",
          descricao_situacao_cadastral: "ATIVA",
          porte: "ME",
          capital_social: 80000,
          ddd_telefone_1: "27999554433",
          qsa: [{ nome_socio: "MARCOS OLIVEIRA", qualificacao_socio: "Sócio-Administrador" }],
        });
      }
      return new Response("<html><body>Site OK</body></html>", { status: 200 });
    });

    const checkWaFn = vi.fn().mockResolvedValue({
      "5527999554433": { exists: true, jid: "5527999554433@s.whatsapp.net" },
      "552732220000": { exists: false, jid: null },
    });

    const out = await enrichCapturedLead({
      name: "Instituto Beleza Real",
      phone: "2732220000",
      website: "https://belezareal.com.br",
      options: {
        auditSiteHealth: true,
        enrichCnpj: true,
        prioritizePartnerPhone: true,
        validateWhatsApp: true,
      },
      fetchImpl: fetchMock as any,
      searchFn: async () => [],
      checkWhatsAppFn: checkWaFn,
    });

    expect(out.bestPhone).toBe("5527999554433");
    expect(out.partnerWhatsAppFound).toBe("5527999554433");
    expect(out.enrichment.whatsappSource).toBe("cnpj_socio");
    expect(out.enrichment.telefoneMapsOriginal).toBe("552732220000");
  });

  it("respeita todas as flags desligadas sem fazer chamadas externas", async () => {
    const fetchSpy = vi.fn();
    const searchSpy = vi.fn();
    const checkSpy = vi.fn();

    const out = await enrichCapturedLead({
      name: "Empresa Offline Teste",
      phone: "27999990000",
      website: "https://exemplo.com.br",
      options: {
        auditSiteHealth: false,
        enrichCnpj: false,
        prioritizePartnerPhone: false,
        validateWhatsApp: false,
      },
      fetchImpl: fetchSpy as any,
      searchFn: searchSpy,
      checkWhatsAppFn: checkSpy,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(searchSpy).not.toHaveBeenCalled();
    expect(checkSpy).not.toHaveBeenCalled();
    expect(out.enrichment.cnpj).toBeUndefined();
    expect(out.bestPhone).toBe("5527999990000");
  });

  it("valida todos os 5 modos de matchesSiteFilterMode e renderTemplate com variáveis de sócio e site", () => {
    expect(parseSiteFilterMode("broken_or_no_site")).toBe("broken_or_no_site");
    expect(parseSiteFilterMode("invalido")).toBeNull();
    expect(parseMinCapitalSocial("50000")).toBe(50000);
    expect(parseMinCapitalSocial("-10")).toBeNull();

    expect(matchesSiteFilterMode("broken_site", "any").pass).toBe(true);
    expect(matchesSiteFilterMode("broken_site", "no_site").pass).toBe(false);
    expect(matchesSiteFilterMode("broken_site", "broken_or_no_site").pass).toBe(true);
    expect(matchesSiteFilterMode("no_site", "broken_or_no_site").pass).toBe(true);
    expect(matchesSiteFilterMode("active_site", "broken_or_no_site").pass).toBe(false);
    expect(matchesSiteFilterMode("weak_site", "only_broken_or_weak").pass).toBe(true);
    expect(matchesSiteFilterMode("no_site", "only_broken_or_weak").pass).toBe(false);
    expect(matchesSiteFilterMode("active_site", "only_active_site").pass).toBe(true);
    expect(matchesSiteFilterMode("broken_site", "only_active_site").pass).toBe(false);

    const rendered = renderTemplate(
      "Oi {{primeiro_nome_socio}} ({{nome_socio}} / {{proprietario}})! Vi que o site da {{nome_empresa}} está {{diagnostico_site}}. CNPJ {{cnpj}}, {{porte_receita}}, capital {{capital_social}}, {{anos_empresa}}, score {{score_qualificacao}}.",
      {
        nome_negocio: "Clínica Modelo",
        business_details: {
          enrichment: {
            siteHealth: "broken_site",
            siteStatusLabel: "Erro 500",
            siteDiagnostico: "fora do ar (HTTP 500)",
            cnpj: "11222333000181",
            porte: "EPP",
            capitalSocial: 150000,
            anosEmpresa: 8,
            socioDecisor: "Fernando Costa",
            primeiroNomeSocio: "Fernando",
            qualificationScore: 91,
            qualificationReasons: [],
            enrichedAt: "2026-11-17T00:00:00Z",
          },
        },
      },
    );

    expect(rendered).toContain("Oi Fernando (Fernando Costa / Fernando Costa)!");
    expect(rendered).toContain("fora do ar (HTTP 500)");
    expect(rendered).toContain("11.222.333/0001-81");
    expect(rendered).toContain("EPP");
    expect(rendered).toContain("150.000");
    expect(rendered).toContain("8 anos");
    expect(rendered).toContain("score 91");

    const { score } = computeLeadQualificationScore({
      siteAudit: { status: "broken_site", statusLabel: "Erro 500", diagnosticoComercial: "", extractedWhatsApps: [], extractedCnpjs: [] },
      cnpjResult: null,
    });
    expect(score).toBe(58);
  });
});

describe("UI toggles — ativação e desativação individual em Captador Maps e Prospecção Sites", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset().mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/auth/session")) return Response.json({ authenticated: true, clientId: "tenant-1" });
      if (url.includes("/api/instances")) return Response.json({ instances: [{ instance_name: "inst-1" }] });
      if (url.includes("/api/agents")) return Response.json({ agents: [] });
      return Response.json({ success: true, ok: true, leads: [], total: 0, campaigns: [], automations: [], models: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", class { close() {} });
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("permite desligar individualmente todos os novos recursos no Captador Maps e escolher modo de site", async () => {
    render(createElement(CaptadorPage));
    fireEvent.change(screen.getByLabelText("Nichos (um por linha)"), { target: { value: "dentista" } });
    fireEvent.change(screen.getByLabelText("Regiões (uma por linha)"), { target: { value: "Vitória/ES" } });

    fireEvent.click(screen.getByRole("switch", { name: "Modo Turbo VPS (alta velocidade e economia de RAM)" }));
    fireEvent.click(screen.getByRole("switch", { name: "Descartar empresas fechadas ou CNPJ baixado/inapto" }));
    fireEvent.click(screen.getByRole("switch", { name: "Auditar saúde do site (detectar fora do ar, SSL vencido, erro 500 ou fraco)" }));
    fireEvent.click(screen.getByRole("radio", { name: "Só Site Quebrado/Fraco" }));
    fireEvent.click(screen.getByRole("switch", { name: "Enriquecer CNPJ e Sócio-Administrador gratuitamente (Receita + RDAP)" }));
    fireEvent.click(screen.getByRole("switch", { name: "Priorizar WhatsApp oculto do site ou celular direto do sócio" }));
    fireEvent.click(screen.getByRole("switch", { name: "Validar WhatsApp ativo na Evolution (recupera fixos com WhatsApp Business)" }));

    fireEvent.click(screen.getByRole("button", { name: "Iniciar Captação" }));

    await waitFor(() => {
      const starts = fetchMock.mock.calls
        .filter(([u, init]) => u === "/api/scraper" && init?.body)
        .map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>)
        .filter((b) => b.action === "start");
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        turboMode: false,
        filterClosedBusinesses: false,
        auditSiteHealth: false,
        siteFilterMode: "only_broken_or_weak",
        enrichCnpj: false,
        prioritizePartnerPhone: false,
        validateWhatsApp: false,
      });
    });
  });

  it("permite alternar modo de site e filtros CNPJ na Captura de Prospecção Sites", async () => {
    render(createElement(ProspeccaoSitesPage));
    fireEvent.change(screen.getByLabelText("Nichos (1 por linha)"), { target: { value: "advocacia" } });
    fireEvent.change(screen.getByLabelText("Regiões (1 por linha)"), { target: { value: "São Paulo SP" } });

    fireEvent.click(screen.getByRole("radio", { name: "Sem site + Quebrado" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Ignorar MEI (focar ME, EPP e Ltda)" }));
    fireEvent.change(screen.getByLabelText("Capital mínimo (R$)"), { target: { value: "50000" } });
    fireEvent.click(screen.getByRole("switch", { name: /Modo Turbo VPS/ }));

    fireEvent.click(screen.getByRole("button", { name: "Iniciar captura" }));

    await waitFor(() => {
      const starts = fetchMock.mock.calls
        .filter(([u, init]) => u === "/api/scraper" && init?.body)
        .map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>)
        .filter((b) => b.action === "start");
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        turboMode: false,
        siteFilterMode: "broken_or_no_site",
        excludeMei: true,
        minCapitalSocial: 50000,
      });
    });
  });

  it("ativa os novos toggles V2 (Modo Direto no Dono, Sem Franquias, Bairros) em Captador, Prospecção Sites e Automação", async () => {
    render(createElement(CaptadorPage));
    fireEvent.change(screen.getByLabelText("Nichos (um por linha)"), { target: { value: "odontologia" } });
    fireEvent.change(screen.getByLabelText("Regiões (uma por linha)"), { target: { value: "Campinas - SP" } });

    fireEvent.click(screen.getByRole("switch", { name: /Modo Direto no Dono/i }));
    fireEvent.click(screen.getByRole("switch", { name: /Ignorar grandes redes e franquias/i }));
    fireEvent.click(screen.getByRole("switch", { name: /Busca profunda por bairros/i }));
    fireEvent.click(screen.getByRole("button", { name: "Iniciar Captação" }));

    await waitFor(() => {
      const starts = fetchMock.mock.calls
        .filter(([u, init]) => u === "/api/scraper" && init?.body)
        .map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>)
        .filter((b) => b.action === "start");
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        huntPartnerDirectPhone: true,
        excludeFranchises: true,
        expandNeighborhoods: true,
      });
    });

    cleanup();
    fetchMock.mockClear();

    render(createElement(ProspeccaoSitesPage));
    fireEvent.change(screen.getByLabelText("Nichos (1 por linha)"), { target: { value: "estética" } });
    fireEvent.change(screen.getByLabelText("Regiões (1 por linha)"), { target: { value: "Campinas - SP" } });

    fireEvent.click(screen.getByRole("switch", { name: /Modo Direto no Dono/i }));
    fireEvent.click(screen.getByRole("switch", { name: /Ignorar grandes redes e franquias/i }));
    fireEvent.click(screen.getByRole("switch", { name: /Busca profunda por bairros/i }));
    fireEvent.click(screen.getByRole("button", { name: "Iniciar captura" }));

    await waitFor(() => {
      const starts = fetchMock.mock.calls
        .filter(([u, init]) => u === "/api/scraper" && init?.body)
        .map(([, init]) => JSON.parse(String(init!.body)) as Record<string, unknown>)
        .filter((b) => b.action === "start");
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        huntPartnerDirectPhone: true,
        excludeFranchises: true,
        expandNeighborhoods: true,
      });
    });

    cleanup();
    render(createElement(AutomacaoPage));
    const newBtn = await screen.findByRole("button", { name: /Nova Automa/i });
    fireEvent.click(newBtn);
    fireEvent.click(await screen.findByRole("button", { name: /Capta/i }));

    expect(await screen.findByRole("switch", { name: /Modo Direto no Dono/i })).toBeTruthy();
    expect(screen.getByRole("switch", { name: /Ignorar grandes redes e franquias/i })).toBeTruthy();
    expect(screen.getByRole("switch", { name: /Busca profunda por bairros/i })).toBeTruthy();
  });
});

describe("Extrator V2 — Anatel 9º dígito, Direto no Dono, Pixel/Ads, Franquias e Expansão Bairros", () => {
  beforeEach(() => {
    clearEnrichmentCachesForTest();
  });

  it("expande celulares 12 dígitos da Receita com 9º dígito sem alterar 13 dígitos nem fixos", () => {
    expect(expandBrPhoneCheckVariants("551982320707")).toEqual(["5519982320707", "551982320707"]);
    expect(expandBrPhoneCheckVariants("551995224082")).toEqual(["5519995224082", "551995224082"]);
    expect(expandBrPhoneCheckVariants("5519996537758")).toEqual(["5519996537758"]);
    expect(expandBrPhoneCheckVariants("551932321000")).toEqual(["551932321000"]);
  });

  it("isola contador de telefone de contabilidade estritamente por tenantId", () => {
    seedTenantPhoneCnpjRoots("tenant-A", [
      { phone: "1932320001", cnpj: CNPJ_VALIDO_1 },
      { phone: "1932320001", cnpj: CNPJ_VALIDO_2 },
      { phone: "1932320001", cnpj: CNPJ_VALIDO_3 },
    ]);
    expect(isLikelyAccountingPhone("551932320001", "tenant-A")).toBe(true);
    expect(isLikelyAccountingPhone("551932320001", "tenant-B")).toBe(false);
  });

  it("detecta Google Ads e Meta Pixel no HTML e soma bônus de qualificação sem quebrar base broken_site=58", async () => {
    const htmlWithAds = `<html><head><title>Clínica</title>
      <script src="https://www.googletagmanager.com/gtag/js?id=AW-123456"></script>
      <script>fbq('init', '998877'); // fbevents.js</script>
      <meta name="viewport" content="width=device-width, initial-scale=1">
    </head><body><h1>Serviços médicos especializados com equipe própria e atendimento humanizado para toda sua família na cidade.</h1></body></html>`;
    expect(detectPaidTrafficTags(htmlWithAds)).toEqual(["Google Ads/GTM", "Meta Pixel"]);

    const fetchMock: typeof fetch = async () =>
      new Response(htmlWithAds, { status: 200, headers: { "content-type": "text/html" } });
    const audit = await auditLeadWebsite("https://clinica-ads.com.br", fetchMock);
    expect(audit.hasPaidTrafficTag).toBe(true);
    expect(audit.trafficTags).toEqual(["Google Ads/GTM", "Meta Pixel"]);

    const { score: pureBroken } = computeLeadQualificationScore({
      siteAudit: { status: "broken_site", statusLabel: "Fora do ar", diagnosticoComercial: "", extractedWhatsApps: [], extractedCnpjs: [] },
      cnpjResult: null,
    });
    expect(pureBroken).toBe(58);

    const { score: brokenWithAds } = computeLeadQualificationScore({
      siteAudit: {
        status: "broken_site",
        statusLabel: "Fora do ar",
        diagnosticoComercial: "",
        extractedWhatsApps: [],
        extractedCnpjs: [],
        hasPaidTrafficTag: true,
        trafficTags: ["Meta Pixel"],
      },
      cnpjResult: null,
    });
    expect(brokenWithAds).toBe(65);
  });

  it("filtra grandes redes/franquias e limpa serviços PUA e nomes curtos", () => {
    expect(detectFranchiseOrChain({ name: "Smart Fit - Cambuí" }).isFranchise).toBe(true);
    expect(detectFranchiseOrChain({ name: "OdontoCompany Centro" }).isFranchise).toBe(true);
    expect(detectFranchiseOrChain({ name: "Rede Local", razaoSocial: "REDE BRASIL S/A" }).isFranchise).toBe(true);
    expect(detectFranchiseOrChain({ name: "Clínica Odontológica Dr. Marcos" }).isFranchise).toBe(false);

    const cleaned = cleanGoogleServicesList(["\ue5ca Implantes", "\ue88e Clareamento Dental", "Implantes"]);
    expect(cleaned.cleanList).toEqual(["Implantes", "Clareamento Dental"]);
    expect(cleaned.mainService).toBe("Implantes");
    expect(extractShortCompanyName("Clínica Sorriso Perfeito LTDA - Campinas", "Campinas")).toBe("Clínica Sorriso Perfeito");
  });

  it("prioriza WhatsApp pessoal do sócio (com 9º dígito recuperado) sobre Business da recepção e salva backup", async () => {
    const partner12 = "551982320707";
    const partner13 = "5519982320707";
    const reception = "5519996537758";

    const fakeFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("brasilapi.com.br/api/cnpj")) {
        return Response.json({
          cnpj: CNPJ_VALIDO_1,
          razao_social: "CLINICA ODONTO JULIANO LTDA",
          nome_fantasia: "Odonto Juliano",
          descricao_situacao_cadastral: "ATIVA",
          porte: "EPP",
          capital_social: 100000,
          data_inicio_atividade: "2018-04-10",
          ddd_telefone_1: "1982320707",
          qsa: [{ nome_socio: "JULIANO ALMEIDA", qualificacao_socio: "Sócio-Administrador" }],
        });
      }
      return new Response("<html><head><title>Odonto Juliano</title><meta name='viewport' content='width=device-width'></head><body><p>CNPJ 11.222.333/0001-81 atendimento personalizado em Campinas para sua família.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };

    const out = await enrichCapturedLead({
      name: "Odonto Juliano",
      phone: reception,
      website: "https://odontojuliano.com.br",
      categories: "Dentista",
      reviews: [{ texto: "A secretária Fernanda marcou super rápido na recepção!" }],
      options: {
        auditSiteHealth: true,
        enrichCnpj: true,
        prioritizePartnerPhone: true,
        huntPartnerDirectPhone: true,
        validateWhatsApp: true,
      },
      fetchImpl: fakeFetch,
      checkWhatsAppFn: async (phones) => {
        const res: Record<string, { exists: boolean; jid?: string }> = {};
        for (const p of phones) {
          if (p === partner13) res[p] = { exists: true, jid: `${partner13}@s.whatsapp.net` };
          else if (p === partner12) res[p] = { exists: false };
          else if (p === reception) res[p] = { exists: true, jid: `${reception}@s.whatsapp.net` };
        }
        return res;
      },
      checkBusinessProfileFn: async (num) => {
        if (num.includes("982320707")) return { isBusiness: false };
        return { isBusiness: true, description: "Recepção e agendamentos" };
      },
    });

    expect(out.bestPhone).toBe(partner13);
    expect(out.enrichment.whatsappChannelType).toBe("socio_direto");
    expect(out.enrichment.telefoneSocio).toBe(partner13);
    expect(out.enrichment.telefoneRecepcao).toBe(reception);
    expect(out.enrichment.hasReceptionist).toBe(true);

    const recSig = detectReceptionistSignals({
      categories: "Clínica médica",
      isBusinessWhatsApp: true,
      whatsappSource: "google_maps",
      reviews: [{ texto: "Recepcionista atenciosa", respostaDono: "Obrigado pelo feedback!" }],
      hasIdentifiedSocio: true,
    });
    expect(recSig.hasReceptionist).toBe(true);
    expect(recSig.ownerActiveOnMaps).toBe(true);
    expect(recSig.channelType).toBe("recepcao_comercial");
  });

  it("gera subconsultas de bairros para furar teto de 120 e mantém hash legado em search-memory quando excludeFranchises=false", () => {
    const bairros = getNeighborhoodExpansionQueries("Campinas - SP", new Map([["Nova Campinas", 4]]));
    expect(bairros.some((b) => b.includes("Cambuí") && b.includes("Campinas - SP"))).toBe(true);
    expect(bairros.some((b) => b.includes("Nova Campinas"))).toBe(true);

    const legacyHash = makeSearchKey("dentista", "Campinas - SP", {
      filterEmpty: true,
      excludeMei: false,
    });
    const sameWithStrategyFlags = makeSearchKey("dentista", "Campinas - SP", {
      filterEmpty: true,
      excludeMei: false,
      excludeFranchises: false,
      huntPartnerDirectPhone: true,
      expandNeighborhoods: true,
    });
    const alteredWithFranchiseFilter = makeSearchKey("dentista", "Campinas - SP", {
      filterEmpty: true,
      excludeMei: false,
      excludeFranchises: true,
    });
    expect(sameWithStrategyFlags).toBe(legacyHash);
    expect(alteredWithFranchiseFilter).not.toBe(legacyHash);
  });
});
