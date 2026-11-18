import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  auditLeadWebsite,
  clearEnrichmentCachesForTest,
  detectAbandonedCopyrightYear,
  detectManagementTools,
  discoverCnpjsViaWebSearch,
  enrichCapturedLead,
  extractExternalBusinessUrlFromBioHtml,
  extractPersonNameFromLeadSignals,
  findInternalContactSubpageUrl,
  isCnpjMatchingLead,
} from "../scraper-lead-enrichment";
import { computePriority } from "../prospeccao-priority";
import { leadRowToTemplateContext, renderTemplate } from "../template-vars";
import { buildSdrLeadDossierBlock } from "../agent/sdr-enrichment-dossier";

describe("Extrator V2.5 — Link-in-Bio, Subpágina /contato, Sistemas, Pessoa e Dossiê Sarah", () => {
  beforeEach(() => {
    clearEnrichmentCachesForTest();
  });

  it("extrai URL própria real de HTML de Linktree e __NEXT_DATA__ ignorando redes e agregadores", () => {
    const htmlNext = `
      <html><body>
        <a href="https://instagram.com/clinicamodelo">Instagram</a>
        <a href="https://wa.me/5511999990000">WhatsApp</a>
        <a href="https://www.doctoralia.com.br/clinica">Doctoralia</a>
        <script id="__NEXT_DATA__" type="application/json">
          {"props":{"pageProps":{"links":[{"url":"https:\\/\\/clinicamodelo.com.br\\/agendamento"}]}}}
        </script>
      </body></html>
    `;
    const extracted = extractExternalBusinessUrlFromBioHtml(htmlNext, "https://linktr.ee/clinicamodelo");
    expect(extracted).toBe("https://clinicamodelo.com.br/agendamento");

    const htmlAnchorOnly = `
      <html><body>
        <a href="https://linktr.ee/clinicavida">Linktree</a>
        <a href="https://www.trinks.com/espaco">Agenda</a>
        <a href="https://clinicavida.com.br">Nosso Site</a>
      </body></html>
    `;
    expect(extractExternalBusinessUrlFromBioHtml(htmlAnchorOnly, "https://linktr.ee/clinicavida")).toBe(
      "https://clinicavida.com.br/",
    );
  });

  it("localiza subpágina interna /contato|/sobre e recupera CNPJ e WhatsApp em 1-hop no auditLeadWebsite", async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "https://clinicaexemplo.com.br" || url === "https://clinicaexemplo.com.br/") {
        return new Response(
          `<html><body>
            <h1>Clínica Exemplo</h1>
            <a href="https://outraempresa.com/contato">Externo ignorado</a>
            <a href="/sobre-nos">Sobre nós</a>
            <a href="/contato">Contato</a>
            <footer>© 2018 Clínica Exemplo</footer>
          </body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (url === "https://clinicaexemplo.com.br/contato") {
        return new Response(
          `<html><body>
            <p>CNPJ: 11.222.333/0001-81</p>
            <a href="https://wa.me/5511988887777">Fale Conosco</a>
            <script src="https://d335luupugsy2.cloudfront.net/js/loader-scripts/abc-loader.js"></script>
          </body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    const homeUrl = "https://clinicaexemplo.com.br";
    const subUrl = findInternalContactSubpageUrl(
      '<a href="/sobre">Sobre</a><a href="/contato">Contato</a>',
      homeUrl,
    );
    expect(subUrl).toBe("https://clinicaexemplo.com.br/contato");

    const audit = await auditLeadWebsite(homeUrl, mockFetch as unknown as typeof fetch);
    expect(audit.status).toBe("active_site");
    expect(audit.extractedCnpjs).toContain("11222333000181");
    expect(audit.extractedWhatsApps).toContain("5511988887777");
    expect(audit.managementTools).toContain("RD Station");
    expect(audit.abandonedCopyrightYear).toBe(2018);
  });

  it("resolve 1-hop de Link-in-Bio para domínio próprio quebrado e busca CNPJ na cascata", async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("linktr.ee/estetica")) {
        return new Response(
          `<html><body>
            <a href="https://clinicapremium.com.br">Site Oficial</a>
          </body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (url.startsWith("https://clinicapremium.com.br")) {
        return new Response(
          `<html><body>
            <h1>Erro no banco de dados - error establishing a database connection</h1>
            <p>CNPJ: 11.222.333/0001-81</p>
          </body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (url.includes("rdap.registro.br")) {
        return new Response("{}", { status: 404 });
      }
      if (url.includes("brasilapi.com.br/api/cnpj/v1/11222333000181")) {
        return new Response(
          JSON.stringify({
            cnpj: "11222333000181",
            razao_social: "PREMIUM ESTETICA LTDA",
            descricao_situacao_cadastral: "ATIVA",
            porte: "MICRO EMPRESA",
            capital_social: 50000,
            data_inicio_atividade: "2020-01-10",
            ddd_telefone_1: "11999998888",
            qsa: [{ nome_socio: "ANA PAULA SOUZA", qualificacao_socio: "Sócio-Administrador" }],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 404 });
    });

    const out = await enrichCapturedLead({
      name: "Clínica Premium Estética",
      phone: "1133334444",
      website: "https://linktr.ee/estetica",
      cidade: "São Paulo",
      uf: "SP",
      options: {
        auditSiteHealth: true,
        enrichCnpj: true,
        prioritizePartnerPhone: true,
        validateWhatsApp: false,
      },
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(out.siteAudit.discoveredRealWebsite).toBe("https://clinicapremium.com.br/");
    expect(out.enrichment.discoveredRealWebsite).toBe("https://clinicapremium.com.br/");
    expect(out.enrichment.siteHealth).toBe("broken_site");
    expect(out.enrichment.cnpj).toBe("11222333000181");
    expect(out.enrichment.socioDecisor).toBe("Ana Paula Souza");
  });

  it("detecta ferramentas de gestão, copyright abandonado e resolve {{sistemas_atuais}}", () => {
    const html = `
      <html><body>
        <a href="https://www.doctoralia.com.br/clinica">Agendar</a>
        <script src="https://app.clinicorp.com/widget.js"></script>
        <footer>© 2019 Minha Clínica. Todos os direitos reservados.</footer>
      </body></html>
    `;
    const tools = detectManagementTools(html);
    expect(tools).toEqual(expect.arrayContaining(["Doctoralia", "Clinicorp"]));
    expect(detectAbandonedCopyrightYear(html, 2026)).toBe(2019);
    expect(detectAbandonedCopyrightYear("© 2016 - 2026 Clínica Ativa", 2026)).toBeUndefined();

    const ctx = leadRowToTemplateContext({
      nome_negocio: "Clínica Teste",
      business_details: {
        enrichment: { managementTools: tools },
      },
    });
    expect(renderTemplate("Usa: {{sistemas_atuais}}", ctx)).toBe("Usa: Doctoralia, Clinicorp");
  });

  it("extrai nome de pessoa em títulos profissionais/assinaturas e faz busca reversa de CNPJ", async () => {
    expect(
      extractPersonNameFromLeadSignals({ leadName: "Dra. Nichelle Antunes - Harmonização Facial" }),
    ).toBe("Nichelle Antunes");
    expect(
      extractPersonNameFromLeadSignals({ leadName: "Centro de Saúde - Daniela Vieira" }),
    ).toBe("Daniela Vieira");
    expect(
      extractPersonNameFromLeadSignals({
        leadName: "Clínica Sorriso",
        reviews: [{ texto: "Ótimo", respostaDono: "Obrigado pelo carinho! Att, Dr. Marcos Silva" }],
      }),
    ).toBe("Marcos Silva");
    expect(extractPersonNameFromLeadSignals({ leadName: "Clínica Beleza Viva" })).toBeUndefined();

    const searchCalls: string[] = [];
    const fakeSearch = vi.fn(async (query: string) => {
      searchCalls.push(query);
      if (query.includes('"Nichelle Antunes"')) {
        return [
          {
            title: "Nichelle Antunes - Sócia Clínica Facial SP CNPJ 11222333000181",
            snippet: "CNPJ 11.222.333/0001-81 em São Paulo SP sócia Nichelle Antunes",
            url: "https://casadosdados.com.br/solucao/cnpj/11222333000181",
          },
        ];
      }
      return [];
    });

    const cnpjs = await discoverCnpjsViaWebSearch(
      "Dra. Nichelle Antunes - Harmonização Facial",
      "São Paulo",
      "SP",
      fakeSearch,
      "Nichelle Antunes",
    );
    expect(cnpjs).toEqual(["11222333000181"]);
    expect(searchCalls.some((q) => q.includes('"Nichelle Antunes"'))).toBe(true);

    expect(
      isCnpjMatchingLead(
        {
          cnpj: "11222333000181",
          razaoSocial: "ANTUNES SERVICOS MEDICOS LTDA",
          situacaoCadastral: "ATIVA",
          isAtiva: true,
          isMei: false,
          porte: "MICRO EMPRESA",
          capitalSocial: 20000,
          municipio: "SAO PAULO",
          uf: "SP",
          telefonesReceita: [],
          socios: [{ nome: "NICHELLE ANTUNES", qualificacao: "Sócio-Administrador" }],
          source: "web_search",
        },
        "Consultório XYZ",
        "São Paulo",
        "SP",
        { personName: "Nichelle Antunes" },
      ),
    ).toBe(true);

    expect(
      isCnpjMatchingLead(
        {
          cnpj: "68625457000125",
          razaoSocial: "ANTUNES NUTRICAO LTDA",
          situacaoCadastral: "ATIVA",
          isAtiva: true,
          isMei: false,
          porte: "MICRO EMPRESA",
          capitalSocial: 10000,
          municipio: "RIBEIRAO PRETO",
          uf: "SP",
          telefonesReceita: [],
          socios: [{ nome: "LUCAS MATEUS ANTUNES", qualificacao: "Sócio-Administrador" }],
          source: "web_search",
        },
        "Dra. Nichelle Antunes - Harmonização Facial",
        "Ribeirão Preto",
        "SP",
        { personName: "Nichelle Antunes" },
      ),
    ).toBe(false);

    expect(
      isCnpjMatchingLead(
        {
          cnpj: "31340770000107",
          razaoSocial: "JK ESTETICA AVANCADA LTDA",
          situacaoCadastral: "ATIVA",
          isAtiva: true,
          isMei: false,
          porte: "DEMAIS",
          capitalSocial: 1316782,
          municipio: "RIBEIRAO PRETO",
          uf: "SP",
          telefonesReceita: [],
          socios: [{ nome: "ISABELA SAVORETTI VIEGAS", qualificacao: "Sócio-Administrador" }],
          source: "web_search",
        },
        "Centro de Estética Avançada - Daniela Vieira",
        "Ribeirão Preto",
        "SP",
        { personName: "Daniela Vieira" },
      ),
    ).toBe(false);
  });

  it("ordena Fila Inteligente por Score ICP com desempate para sócio direto, Ads e ferramentas", () => {
    const score60Recepcao = computePriority(
      {
        business_details: {
          enrichment: { qualificationScore: 60, whatsappChannelType: "recepcao_comercial" },
        },
      },
      "qualification",
      "desc",
    );
    const score60SocioAds = computePriority(
      {
        business_details: {
          enrichment: {
            qualificationScore: 60,
            whatsappChannelType: "socio_direto",
            hasPaidTrafficTag: true,
            managementTools: ["Doctoralia"],
          },
        },
      },
      "qualification",
      "desc",
    );
    const score61SemNada = computePriority(
      {
        business_details: {
          enrichment: { qualificationScore: 61, whatsappChannelType: "recepcao_comercial" },
        },
      },
      "qualification",
      "desc",
    );

    expect(score60SocioAds).toBeGreaterThan(score60Recepcao);
    expect(score61SemNada).toBeGreaterThan(score60SocioAds);
  });

  it("compila Dossiê Tático da Sarah com diretrizes de Recepção, Broken Site, Weak Site+Ads e No Site", () => {
    const brokenRecepcao = buildSdrLeadDossierBlock({
      nome_negocio: "Dot Stética LTDA",
      categoria: "Clínica de Estética",
      website: "https://dotstetica.com.br",
      business_details: {
        enrichment: {
          qualificationScore: 84,
          empresaCurta: "Dot Stética",
          socioDecisor: "Carla Mendes",
          primeiroNomeSocio: "Carla",
          whatsappChannelType: "recepcao_comercial",
          siteHealth: "broken_site",
          siteStatusLabel: "Site com erro HTTP 500",
          siteDiagnostico: "retornando página de erro para os visitantes",
          managementTools: ["Trinks"],
        },
      },
    });
    expect(brokenRecepcao).toContain("GATEKEEPER / RECEPÇÃO DETECTADA");
    expect(brokenRecepcao).toContain("Carla");
    expect(brokenRecepcao).toContain("ÂNGULO OBRIGATÓRIO (SITE QUEBRADO)");
    expect(brokenRecepcao).toContain('PROIBIDO dizer que a empresa "não tem site"');
    expect(brokenRecepcao).toContain("NUNCA diga que o botão do site não apareceu");
    expect(brokenRecepcao).toContain("Trinks");

    const weakWithAds = buildSdrLeadDossierBlock({
      nome_negocio: "Clínica Vida",
      website: "https://linktr.ee/clinicavida",
      business_details: {
        enrichment: {
          qualificationScore: 72,
          whatsappChannelType: "socio_direto",
          primeiroNomeSocio: "Rafael",
          siteHealth: "weak_site",
          siteDiagnostico: "usando página improvisada gratuita",
          hasPaidTrafficTag: true,
          trafficTags: ["Meta Pixel"],
        },
      },
    });
    expect(weakWithAds).toContain("CONTATO DIRETO COM DECISOR");
    expect(weakWithAds).toContain("SITE FRACO / IMPROVISADO");
    expect(weakWithAds).toContain("investem em anúncios pagos");

    const noSite = buildSdrLeadDossierBlock({
      nome_negocio: "Barbearia Prime",
      avaliacao: 4.9,
      reviews: 82,
      business_details: {
        enrichment: {
          qualificationScore: 68,
          siteHealth: "no_site",
        },
      },
    });
    expect(noSite).toContain("ÂNGULO OBRIGATÓRIO (SEM SITE)");
    expect(buildSdrLeadDossierBlock(null)).toBe("");
  });
});

