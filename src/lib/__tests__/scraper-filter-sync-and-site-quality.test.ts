import { describe, expect, it, vi } from "vitest";
import {
  applyScraperFilterChange,
  isNonWebsiteUrl,
  matchesSiteFilterMode,
  normalizeScraperSettingsForBackend,
  resolveQualificationObjective,
  SCRAPER_PRESET_OPTIONS,
  type ScraperFilterSyncState,
} from "@/lib/scraper-lead-filters";
import {
  auditLeadWebsite,
  computeLeadQualificationScore,
} from "@/lib/scraper-lead-enrichment";
import { buildSdrLeadDossierBlock } from "@/lib/agent/sdr-enrichment-dossier";
import { evaluateLeadFilters, type ScraperSettings } from "@/lib/scraper-engine";

function makeSyncState(overrides: Partial<ScraperFilterSyncState> = {}): ScraperFilterSyncState {
  return {
    filterEmpty: true,
    filterDuplicates: true,
    filterLandlines: false,
    filterWithWebsite: false,
    filterWithInstagram: false,
    captureAllReviews: false,
    reviewsAiEnabled: false,
    turboMode: true,
    filterClosedBusinesses: true,
    auditSiteHealth: true,
    siteFilterMode: "any",
    enrichCnpj: true,
    prioritizePartnerPhone: true,
    validateWhatsApp: true,
    excludeMei: false,
    excludeFranchises: false,
    huntPartnerDirectPhone: false,
    expandNeighborhoods: false,
    prioritizeByScore: true,
    minCapitalSocial: "0",
    personalizeWithAi: false,
    antibanMixer: true,
    ...overrides,
  };
}

function makeEngineSettings(overrides: Partial<ScraperSettings> = {}): ScraperSettings {
  return {
    filterEmpty: true,
    filterDuplicates: true,
    filterLandlines: false,
    filterWithWebsite: false,
    filterWithInstagram: false,
    captureAllReviews: false,
    minReviews: 0,
    maxLeads: 50,
    mode: "realtime",
    ...overrides,
  };
}

describe("applyScraperFilterChange — sincronização bidirecional", () => {
  it("ativa 'Somente sem site' -> define siteFilterMode='no_site' e desliga auditoria HTTP", () => {
    const res = applyScraperFilterChange(
      makeSyncState({ auditSiteHealth: true, enrichCnpj: false, prioritizeByScore: true }),
      { type: "filterWithWebsite", value: true },
      "captador",
    );
    expect(res.state.filterWithWebsite).toBe(true);
    expect(res.state.siteFilterMode).toBe("no_site");
    expect(res.state.auditSiteHealth).toBe(false);
    expect(res.state.prioritizeByScore).toBe(false);
    expect(res.autoNote).toBeTruthy();
  });

  it("escolhe modo dependente de auditoria -> desmarca filterWithWebsite e liga auditSiteHealth", () => {
    const res = applyScraperFilterChange(
      makeSyncState({ filterWithWebsite: true, siteFilterMode: "no_site", auditSiteHealth: false }),
      { type: "siteFilterMode", value: "only_broken_or_weak" },
      "prospeccao-sites",
    );
    expect(res.state.filterWithWebsite).toBe(false);
    expect(res.state.auditSiteHealth).toBe(true);
    expect(res.state.siteFilterMode).toBe("only_broken_or_weak");
    expect(res.autoNote).toContain("Auditoria de site ativada");
  });

  it("liga auditSiteHealth estando em 'no_site' -> ajusta por superfície", () => {
    const prospeccao = applyScraperFilterChange(
      makeSyncState({ filterWithWebsite: true, siteFilterMode: "no_site", auditSiteHealth: false }),
      { type: "auditSiteHealth", value: true },
      "prospeccao-sites",
    );
    expect(prospeccao.state.filterWithWebsite).toBe(false);
    expect(prospeccao.state.siteFilterMode).toBe("broken_or_no_site");

    const captador = applyScraperFilterChange(
      makeSyncState({ filterWithWebsite: true, siteFilterMode: "no_site", auditSiteHealth: false }),
      { type: "auditSiteHealth", value: true },
      "captador",
    );
    expect(captador.state.filterWithWebsite).toBe(false);
    expect(captador.state.siteFilterMode).toBe("any");
  });

  it("desliga auditSiteHealth em modo dependente -> redefine para 'any' e desliga score órfão", () => {
    const res = applyScraperFilterChange(
      makeSyncState({ auditSiteHealth: true, siteFilterMode: "only_active_site", enrichCnpj: false, prioritizeByScore: true }),
      { type: "auditSiteHealth", value: false },
      "automacao",
    );
    expect(res.state.auditSiteHealth).toBe(false);
    expect(res.state.siteFilterMode).toBe("any");
    expect(res.state.prioritizeByScore).toBe(false);
  });

  it("desliga enrichCnpj -> limpa filhos (excludeMei, minCapitalSocial, huntPartnerDirectPhone)", () => {
    const res = applyScraperFilterChange(
      makeSyncState({
        enrichCnpj: true,
        excludeMei: true,
        minCapitalSocial: "50000",
        huntPartnerDirectPhone: true,
        auditSiteHealth: false,
        prioritizeByScore: true,
      }),
      { type: "enrichCnpj", value: false },
      "automacao",
    );
    expect(res.state.enrichCnpj).toBe(false);
    expect(res.state.excludeMei).toBe(false);
    expect(res.state.minCapitalSocial).toBe("0");
    expect(res.state.huntPartnerDirectPhone).toBe(false);
    expect(res.state.prioritizeByScore).toBe(false);
    expect(res.autoNote).toContain("Ignorar MEI");
  });

  it("liga excludeMei ou minCapitalSocial > 0 -> reativa enrichCnpj automaticamente", () => {
    const r1 = applyScraperFilterChange(makeSyncState({ enrichCnpj: false }), { type: "excludeMei", value: true });
    expect(r1.state.enrichCnpj).toBe(true);
    expect(r1.state.excludeMei).toBe(true);

    const r2 = applyScraperFilterChange(makeSyncState({ enrichCnpj: false }), { type: "minCapitalSocial", value: "25000" });
    expect(r2.state.enrichCnpj).toBe(true);
    expect(r2.state.minCapitalSocial).toBe("25000");
  });

  it("Modo Direto no Dono exige CNPJ + prioritizePartnerPhone + validateWhatsApp bidirecionalmente", () => {
    const enabled = applyScraperFilterChange(
      makeSyncState({ enrichCnpj: false, prioritizePartnerPhone: false, validateWhatsApp: false }),
      { type: "huntPartnerDirectPhone", value: true },
    );
    expect(enabled.state.enrichCnpj).toBe(true);
    expect(enabled.state.prioritizePartnerPhone).toBe(true);
    expect(enabled.state.validateWhatsApp).toBe(true);
    expect(enabled.state.huntPartnerDirectPhone).toBe(true);

    const offPhone = applyScraperFilterChange(enabled.state, { type: "prioritizePartnerPhone", value: false });
    expect(offPhone.state.huntPartnerDirectPhone).toBe(false);

    const offWa = applyScraperFilterChange(enabled.state, { type: "validateWhatsApp", value: false });
    expect(offWa.state.huntPartnerDirectPhone).toBe(false);
  });

  it("Modo Turbo <-> Avaliações Completas <-> Resumir Avaliações IA respeitam dependências", () => {
    const reviewsOn = applyScraperFilterChange(makeSyncState({ turboMode: true }), { type: "reviewsAiEnabled", value: true });
    expect(reviewsOn.state.reviewsAiEnabled).toBe(true);
    expect(reviewsOn.state.captureAllReviews).toBe(true);
    expect(reviewsOn.state.turboMode).toBe(false);

    // Desligar reviewsAiEnabled preserva captureAllReviews conforme UX
    const reviewsOff = applyScraperFilterChange(reviewsOn.state, { type: "reviewsAiEnabled", value: false });
    expect(reviewsOff.state.reviewsAiEnabled).toBe(false);
    expect(reviewsOff.state.captureAllReviews).toBe(true);

    // Desligar captureAllReviews desliga reviewsAiEnabled
    const allOff = applyScraperFilterChange(reviewsOn.state, { type: "captureAllReviews", value: false });
    expect(allOff.state.captureAllReviews).toBe(false);
    expect(allOff.state.reviewsAiEnabled).toBe(false);

    // Ligar turboMode desliga reviews completas e IA
    const turboOn = applyScraperFilterChange(reviewsOn.state, { type: "turboMode", value: true });
    expect(turboOn.state.turboMode).toBe(true);
    expect(turboOn.state.captureAllReviews).toBe(false);
    expect(turboOn.state.reviewsAiEnabled).toBe(false);
  });

  it("prioritizeByScore=true com audit/cnpj desligados reativa ambos", () => {
    const res = applyScraperFilterChange(
      makeSyncState({ auditSiteHealth: false, enrichCnpj: false, prioritizeByScore: false }),
      { type: "prioritizeByScore", value: true },
      "automacao",
    );
    expect(res.state.auditSiteHealth).toBe(true);
    expect(res.state.enrichCnpj).toBe(true);
    expect(res.state.prioritizeByScore).toBe(true);
  });

  it("personalizeWithAi e antibanMixer são mutuamente exclusivos", () => {
    const aiOn = applyScraperFilterChange(makeSyncState({ antibanMixer: true, personalizeWithAi: false }), {
      type: "personalizeWithAi",
      value: true,
    });
    expect(aiOn.state.personalizeWithAi).toBe(true);
    expect(aiOn.state.antibanMixer).toBe(false);

    const mixerOn = applyScraperFilterChange(aiOn.state, { type: "antibanMixer", value: true });
    expect(mixerOn.state.antibanMixer).toBe(true);
    expect(mixerOn.state.personalizeWithAi).toBe(false);
  });

  it("aplica todos os 4 presets corretamente", () => {
    expect(SCRAPER_PRESET_OPTIONS).toHaveLength(4);

    const sites = applyScraperFilterChange(makeSyncState(), { type: "preset", preset: "vender_sites" }).state;
    expect(sites.siteFilterMode).toBe("broken_or_no_site");
    expect(sites.auditSiteHealth).toBe(true);
    expect(sites.filterWithWebsite).toBe(false);
    expect(sites.excludeMei).toBe(false);

    const ia = applyScraperFilterChange(makeSyncState(), { type: "preset", preset: "vender_ia" }).state;
    expect(ia.siteFilterMode).toBe("any");
    expect(ia.excludeMei).toBe(true);
    expect(ia.excludeFranchises).toBe(true);
    expect(ia.prioritizeByScore).toBe(true);

    const socio = applyScraperFilterChange(makeSyncState(), { type: "preset", preset: "direto_socio" }).state;
    expect(socio.huntPartnerDirectPhone).toBe(true);
    expect(socio.enrichCnpj).toBe(true);
    expect(socio.prioritizePartnerPhone).toBe(true);
    expect(socio.validateWhatsApp).toBe(true);

    const rapido = applyScraperFilterChange(makeSyncState({ excludeMei: true, minCapitalSocial: "10000" }), {
      type: "preset",
      preset: "volume_rapido",
    }).state;
    expect(rapido.turboMode).toBe(true);
    expect(rapido.auditSiteHealth).toBe(false);
    expect(rapido.enrichCnpj).toBe(false);
    expect(rapido.excludeMei).toBe(false);
    expect(rapido.minCapitalSocial).toBe("0");
    expect(rapido.prioritizeByScore).toBe(false);
  });
});

describe("normalizeScraperSettingsForBackend & resolveQualificationObjective", () => {
  it("sanitiza filtros conflitantes sem mutar o objeto original nem marcadores internos", () => {
    const input = {
      _source: "automacao",
      enrichCnpj: false,
      excludeMei: true,
      minCapitalSocial: 50000,
      huntPartnerDirectPhone: false,
      siteFilterMode: "only_broken_or_weak",
      filterWithWebsite: true,
      auditSiteHealth: false,
      reviews_ai: { enabled: true },
      captureAllReviews: false,
    };
    const snapshot = structuredClone(input);

    const normalized = normalizeScraperSettingsForBackend(input);
    expect(input).toEqual(snapshot);
    expect(normalized._source).toBe("automacao");
    expect(normalized.excludeMei).toBe(false);
    expect(normalized.minCapitalSocial).toBe(0);
    expect(normalized.filterWithWebsite).toBe(false);
    expect(normalized.auditSiteHealth).toBe(true);
    expect(normalized.captureAllReviews).toBe(false);
    expect(normalized.reviews_ai).toEqual({ enabled: false });
  });

  it("infere objetivo de qualificação coerente por origem e filtros", () => {
    expect(resolveQualificationObjective({ source: "prospeccao-sites", siteFilterMode: "any" })).toBe("site_sales");
    expect(resolveQualificationObjective({ isAutomation: true, siteFilterMode: "any" })).toBe("ai_automation");
    expect(resolveQualificationObjective({ isAutomation: true, siteFilterMode: "broken_or_no_site" })).toBe("site_sales");
    expect(resolveQualificationObjective({ source: "captador", siteFilterMode: "any" })).toBe("general");
  });
});

describe("isNonWebsiteUrl, evaluateLeadFilters e matchesSiteFilterMode", () => {
  it("preserva autoridade Maps no modo raw no_site e aceita links sociais/plataformas em broken_or_no_site", async () => {
    expect(isNonWebsiteUrl("https://instagram.com/clinica.vida")).toBe(true);
    expect(isNonWebsiteUrl("https://www.ifood.com.br/delivery/sao-paulo")).toBe(true);
    expect(isNonWebsiteUrl("https://www.doctoralia.com.br/medico/joao")).toBe(true);
    expect(isNonWebsiteUrl("https://clinicavida.com.br")).toBe(false);

    const settings = makeEngineSettings({ filterWithWebsite: true, siteFilterMode: "no_site" });
    expect(evaluateLeadFilters("11999887766", "https://instagram.com/pizzaria", settings, [])).toEqual({
      pass: false,
      reason: "Com site",
    });
    expect(evaluateLeadFilters("11999887766", "", settings, [])).toEqual({
      pass: true,
      reason: "",
    });

    const igAudit = await auditLeadWebsite("https://instagram.com/clinica.vida");
    const ifoodAudit = await auditLeadWebsite("https://www.ifood.com.br/delivery/sao-paulo");
    expect(igAudit.status).toBe("no_site");
    expect(ifoodAudit.status).toBe("no_site");
    expect(matchesSiteFilterMode(igAudit.status, "broken_or_no_site")).toEqual({ pass: true, reason: "" });
    expect(matchesSiteFilterMode(ifoodAudit.status, "only_active_site")).toEqual({ pass: false, reason: "Sem site" });
  });

  it("matchesSiteFilterMode('weak_site', 'only_active_site') rejeita sites fracos ou improvisados", () => {
    expect(matchesSiteFilterMode("weak_site", "only_active_site")).toEqual({
      pass: false,
      reason: "Site fraco ou improvisado",
    });
    expect(matchesSiteFilterMode("active_site", "only_active_site")).toEqual({
      pass: true,
      reason: "",
    });
  });
});

describe("auditLeadWebsite — qualidade profunda, 256KB e detecção de plataformas", () => {
  it("classifica iFood/Doctoralia sem executar fetch", async () => {
    const fetchMock = vi.fn();
    const res = await auditLeadWebsite("https://www.ifood.com.br/delivery/sp/hamburgueria", fetchMock as unknown as typeof fetch);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe("no_site");
    expect(res.issueCode).toBe("third_party_platform");
  });

  it("detecta domínio próprio que redireciona 302 para Instagram como redirects_to_social", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { location: "https://www.instagram.com/clinica_sorriso_sp/" },
      }),
    );

    const res = await auditLeadWebsite("https://clinicasorriso.com.br", fetchMock as unknown as typeof fetch);
    expect(res.status).toBe("weak_site");
    expect(res.issueCode).toBe("redirects_to_social");
    expect(res.extractedInstagram).toBe("https://www.instagram.com/clinica_sorriso_sp/");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("lê rodapé além de 100KB (<256KB) e extrai WhatsApp, CNPJ e Instagram", async () => {
    const padding = " ".repeat(110 * 1024);
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Clínica</title></head><body><h1>Clínica Odontológica Premium</h1><p>Atendimento especializado em implantes e estética dental em São Paulo com equipe experiente há mais de 15 anos no mercado.</p><a href="https://wa.me/5511999887766">Agendar pelo WhatsApp</a><form action="/contato"><button type="submit">Solicitar orçamento</button></form>${padding}<footer>CNPJ: 11.222.333/0001-81 | <a href="https://instagram.com/odontopremium_sp">Instagram</a></footer></body></html>`;

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    );

    const res = await auditLeadWebsite("https://odontopremium.com.br", fetchMock as unknown as typeof fetch);
    expect(res.status).toBe("active_site");
    expect(res.extractedWhatsApps).toContain("5511999887766");
    expect(res.extractedCnpjs).toContain("11222333000181");
    expect(res.extractedInstagram).toBe("https://www.instagram.com/odontopremium_sp/");
    expect(res.hasMobileViewport).toBe(true);
    expect(res.hasSsl).toBe(true);
    expect(res.hasClearCta).toBe(true);
    expect((res.siteQualityScore ?? 0)).toBeGreaterThanOrEqual(75);
  });

  it("diferencia Cloudflare 521/522 (servidor offline) de WAF 403 challenge", async () => {
    const cfDownFetch = vi.fn().mockResolvedValueOnce(
      new Response("<html><title>522: Connection timed out</title></html>", {
        status: 522,
        headers: { "content-type": "text/html", server: "cloudflare" },
      }),
    );
    const downRes = await auditLeadWebsite("https://cliente522.com.br", cfDownFetch as unknown as typeof fetch);
    expect(downRes.status).toBe("broken_site");
    expect(downRes.issueCode).toBe("http_522");

    const wafFetch = vi.fn().mockResolvedValueOnce(
      new Response("Just a moment... Enable JavaScript and cookies to continue", {
        status: 403,
        headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
      }),
    );
    const wafRes = await auditLeadWebsite("https://clientewaf.com.br", wafFetch as unknown as typeof fetch);
    expect(wafRes.status).toBe("active_site");
    expect(wafRes.issueCode).toBe("waf_protected");
  });

  it("marca site sem meta viewport como not_mobile_friendly (weak_site)", async () => {
    const html = `<!doctype html><html><head><title>Advocacia</title></head><body><h1>Escritório Central</h1><p>Atuação em direito empresarial, trabalhista e tributário desde 2010.</p><a href="https://wa.me/5511988887777">Fale conosco</a><footer>© 2025 Escritório Central</footer></body></html>`;
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const res = await auditLeadWebsite("https://advocaciacentral.com.br", fetchMock as unknown as typeof fetch);
    expect(res.status).toBe("weak_site");
    expect(res.issueCode).toBe("not_mobile_friendly");
    expect(res.hasMobileViewport).toBe(false);
  });

  it("marca página em construção / WordPress padrão como placeholder (weak_site)", async () => {
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Meu Negócio</title></head><body><h1>Site em construção</h1><p>Em breve novidades aqui. Just another WordPress site.</p></body></html>`;
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(html, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    const res = await auditLeadWebsite("https://lojinhaemconstrucao.com.br", fetchMock as unknown as typeof fetch);
    expect(res.status).toBe("weak_site");
    expect(res.issueCode).toBe("under_construction");
    expect((res.siteQualityScore ?? 100)).toBeLessThanOrEqual(25);
  });

  it("trata HTTP 403/429 WAF genérico como active_site (auditUncertain) mas mantém 403 de conta suspensa como broken_site", async () => {
    const litespeed403 = vi.fn().mockResolvedValueOnce(
      new Response("<html><body>Forbidden by security policy</body></html>", {
        status: 403,
        headers: { "content-type": "text/html", server: "LiteSpeed" },
      }),
    );
    const lsOut = await auditLeadWebsite("https://clinicasegura.com.br", litespeed403 as unknown as typeof fetch);
    expect(lsOut.status).toBe("active_site");
    expect(lsOut.issueCode).toBe("waf_protected");
    expect(lsOut.auditUncertain).toBe(true);

    const plain429 = vi.fn().mockResolvedValueOnce(
      new Response("Too Many Requests", { status: 429, headers: { "content-type": "text/plain" } }),
    );
    const rateOut = await auditLeadWebsite("https://lojasegura.com.br", plain429 as unknown as typeof fetch);
    expect(rateOut.status).toBe("active_site");
    expect(rateOut.issueCode).toBe("waf_protected");
    expect(rateOut.auditUncertain).toBe(true);

    const suspended403 = vi.fn().mockResolvedValueOnce(
      new Response("<html><body><h1>Conta suspensa</h1></body></html>", {
        status: 403,
        headers: { "content-type": "text/html" },
      }),
    );
    const suspOut = await auditLeadWebsite("https://contasuspensa.com.br", suspended403 as unknown as typeof fetch);
    expect(suspOut.status).toBe("broken_site");
    expect(suspOut.issueCode).toBe("account_suspended");
  });

  it("tenta retry com www em timeout transitório e marca falha por timeout persistente como active_site não verificado", async () => {
    const retryWorks = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("timed out"), { name: "TimeoutError" }))
      .mockResolvedValueOnce(
        new Response(
          `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Clinica Moderna</title></head><body><h1>Clínica Moderna</h1><a href="https://wa.me/5511999990000">WhatsApp</a></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        ),
      );
    const recovered = await auditLeadWebsite("https://clinicamoderna.com.br", retryWorks as unknown as typeof fetch);
    expect(retryWorks).toHaveBeenCalledTimes(2);
    expect(recovered.status).toBe("active_site");
    expect(recovered.finalUrl).toContain("www.clinicamoderna.com.br");

    const alwaysTimeout = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    const unverified = await auditLeadWebsite("https://sitelento.com.br", alwaysTimeout as unknown as typeof fetch);
    expect(unverified.status).toBe("active_site");
    expect(unverified.issueCode).toBe("audit_timeout_unverified");
    expect(unverified.auditUncertain).toBe(true);
    expect(unverified.diagnosticoComercial).toBe("");
  });

  it("não marca sites Wix / Webflow / Framer / Elementor / Shopify com viewport e HTTPS como weak_site", async () => {
    const htmlSamples = [
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><script src="https://static.wixstatic.com/app.js"></script><title>Home</title></head><body><div id="SITE_CONTAINER"></div></body></html>`,
      `<!doctype html><html data-wf-site="abc"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Studio</title></head><body><div>Carregando...</div></body></html>`,
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><script src="https://framerusercontent.com/bundle.js"></script><title>Framer</title></head><body><div></div></body></html>`,
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/wp-content/plugins/elementor/assets/css/frontend.min.css"><title>Clínica</title></head><body class="elementor-page"></body></html>`,
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><script src="https://cdn.shopify.com/s/files/theme.js"></script><title>Loja</title></head><body><div></div></body></html>`,
    ];

    for (const html of htmlSamples) {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(html, { status: 200, headers: { "content-type": "text/html" } }),
      );
      const res = await auditLeadWebsite("https://sitemoderno.com.br", fetchMock as unknown as typeof fetch);
      expect(res.status).toBe("active_site");
    }
  });

  it("dossiê da Sarah orienta a NÃO afirmar que o site está quebrado quando auditUncertain = true", () => {
    const dossier = buildSdrLeadDossierBlock(
      {
        nome_negocio: "Clínica Protegida",
        website: "https://clinicaprotegida.com.br",
        business_details: {
          enrichment: {
            siteHealth: "active_site",
            siteStatusLabel: "Site ativo (protegido)",
            siteIssueCode: "waf_protected",
            auditUncertain: true,
          },
        },
      },
      "strategic",
    );
    expect(dossier).toContain("PROIBIDO dizer ou insinuar que o site está fora do ar, quebrado ou com erro");
  });
});

describe("computeLeadQualificationScore — alinhado por objetivo", () => {
  it("prioriza site quebrado em site_sales e site estruturado + tráfego pago em ai_automation", () => {
    const brokenAudit = {
      status: "broken_site" as const,
      statusLabel: "Site com erro HTTP 500",
      diagnosticoComercial: "retornando erro 500",
      extractedWhatsApps: [],
      extractedCnpjs: [],
      siteQualityScore: 0,
    };
    const strongAudit = {
      status: "active_site" as const,
      statusLabel: "Site ativo",
      diagnosticoComercial: "site profissional",
      extractedWhatsApps: ["5511999887766"],
      extractedCnpjs: [],
      hasPaidTrafficTag: true,
      trafficTags: ["Meta Pixel", "Google Tag Manager"],
      siteQualityScore: 88,
    };

    const salesBroken = computeLeadQualificationScore({ siteAudit: brokenAudit, cnpjResult: null, objective: "site_sales" });
    const salesStrong = computeLeadQualificationScore({ siteAudit: strongAudit, cnpjResult: null, objective: "site_sales" });
    expect(salesBroken.score).toBeGreaterThan(salesStrong.score);

    const aiStrong = computeLeadQualificationScore({ siteAudit: strongAudit, cnpjResult: null, objective: "ai_automation" });
    const aiNoSite = computeLeadQualificationScore({
      siteAudit: {
        status: "no_site",
        statusLabel: "Sem site",
        diagnosticoComercial: "sem site",
        extractedWhatsApps: [],
        extractedCnpjs: [],
        siteQualityScore: 0,
      },
      cnpjResult: null,
      objective: "ai_automation",
    });
    expect(aiStrong.score).toBeGreaterThan(aiNoSite.score);
  });
});

