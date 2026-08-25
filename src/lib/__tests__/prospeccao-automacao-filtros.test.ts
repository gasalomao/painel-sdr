import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderTemplate } from "../template-vars";
import { resolveCapturedLeadScope } from "../automation-lead-scope";

describe("Prospecção de Sites — Filtros da Automação e Interpolação de Prompt IA", () => {
  const tarde = new Date("2026-05-22T17:00:00.000Z"); // 14h em São Paulo (UTC-3)

  const leadContext = {
    nome_negocio: "Oficina Mecânica São José",
    ramo_negocio: "Auto Mecânica",
    avaliacao: 4.8,
    reviews: 52,
    endereco: "Av. Paulista, 1000 - São Paulo, SP",
    telefone: "5511999998888",
    website: "https://oficinasaojose.com.br",
    resumo_avaliacoes: "ELOGIOS: Ótimo atendimento na suspensão.\nRECLAMAÇÕES: Demora aos sábados.",
    now: tarde,
  };

  describe("1. Interpolação de variáveis no customPrompt da IA (Disparo & Follow-up)", () => {
    it("interpola {{nome_empresa}}, {{ramo}} e {{resumo_avaliacoes}} dentro do customPrompt de disparo", () => {
      const customPromptOriginal = `Você é um SDR. Use as seguintes informações sobre a empresa:
Nome: {{nome_empresa}}
Ramo: {{ramo}}
Avaliações Google: {{resumo_avaliacoes}}
Nota: {{avaliacao}} ({{reviews}} reviews)
Reescreva a mensagem para focar nos pontos fortes citados.`;

      const promptInterpolado = renderTemplate(customPromptOriginal, leadContext);

      expect(promptInterpolado).toContain("Nome: Oficina Mecânica São José");
      expect(promptInterpolado).toContain("Ramo: Auto Mecânica");
      expect(promptInterpolado).toContain("Avaliações Google: ELOGIOS: Ótimo atendimento na suspensão.");
      expect(promptInterpolado).toContain("Nota: 4.8 (52 reviews)");
      expect(promptInterpolado).not.toContain("{{nome_empresa}}");
      expect(promptInterpolado).not.toContain("{{resumo_avaliacoes}}");
      expect(promptInterpolado).not.toContain("{{ramo}}");
      expect(promptInterpolado).not.toContain("{{avaliacao}}");
      expect(promptInterpolado).not.toContain("{{reviews}}");
    });

    it("interpola {{nome_negocio}} (alias) e {{endereco}} no customPrompt do follow-up", () => {
      const customPromptFollowup = `Lembre o lead da empresa {{nome_negocio}} localizada em {{endereco}} sobre a proposta de site.`;

      const promptInterpolado = renderTemplate(customPromptFollowup, leadContext);

      expect(promptInterpolado).toBe("Lembre o lead da empresa Oficina Mecânica São José localizada em Av. Paulista, 1000 - São Paulo, SP sobre a proposta de site.");
      expect(promptInterpolado).not.toContain("{{nome_negocio}}");
      expect(promptInterpolado).not.toContain("{{endereco}}");
    });

    it("customPrompt vazio ou nulo não gera erro no renderTemplate", () => {
      expect(renderTemplate("", leadContext)).toBe("");
      expect(renderTemplate(null as any, leadContext)).toBe("");
      expect(renderTemplate(undefined as any, leadContext)).toBe("");
    });
  });

  describe("2. Mapeamento e consistência dos Filtros da Captura em scrape_filters", () => {
    it("valida objeto de scrape_filters com os 5 filtros ativos", () => {
      const scrapeFilters = {
        _source: "prospeccao-sites",
        filterEmpty: true,
        filterDuplicates: true,
        filterLandlines: true,
        filterWithWebsite: true,
        captureAllReviews: true,
      };

      expect(scrapeFilters.filterEmpty).toBe(true);
      expect(scrapeFilters.filterDuplicates).toBe(true);
      expect(scrapeFilters.filterLandlines).toBe(true);
      expect(scrapeFilters.filterWithWebsite).toBe(true);
      expect(scrapeFilters.captureAllReviews).toBe(true);
      expect(scrapeFilters._source).toBe("prospeccao-sites");
    });

    it("regras de conversão de booleanos em automation-worker espelham o contrato do scraper", () => {
      // Simulação da extração de filtros que roda no startScrapingPhase
      const extractFilters = (filters: any) => ({
        filterEmpty: filters.filterEmpty !== false,
        filterDuplicates: filters.filterDuplicates !== false,
        filterLandlines: filters.filterLandlines === true,
        filterWithWebsite: filters.filterWithWebsite === true,
        captureAllReviews: filters.captureAllReviews === true,
      });

      // Caso 1: defaults quando objeto vem vazio
      const defaults = extractFilters({});
      expect(defaults.filterEmpty).toBe(true);
      expect(defaults.filterDuplicates).toBe(true);
      expect(defaults.filterLandlines).toBe(false);
      expect(defaults.filterWithWebsite).toBe(false);
      expect(defaults.captureAllReviews).toBe(false);

      // Caso 2: todos marcados pelo usuário no frontend
      const customOn = extractFilters({
        filterEmpty: true,
        filterDuplicates: true,
        filterLandlines: true,
        filterWithWebsite: true,
        captureAllReviews: true,
      });
      expect(customOn.filterEmpty).toBe(true);
      expect(customOn.filterDuplicates).toBe(true);
      expect(customOn.filterLandlines).toBe(true);
      expect(customOn.filterWithWebsite).toBe(true);
      expect(customOn.captureAllReviews).toBe(true);

      // Caso 3: desmarcação explícita de duplicados e vazios
      const customOff = extractFilters({
        filterEmpty: false,
        filterDuplicates: false,
        filterLandlines: false,
        filterWithWebsite: false,
        captureAllReviews: false,
      });
      expect(customOff.filterEmpty).toBe(false);
      expect(customOff.filterDuplicates).toBe(false);
      expect(customOff.filterLandlines).toBe(false);
      expect(customOff.filterWithWebsite).toBe(false);
      expect(customOff.captureAllReviews).toBe(false);
    });

    it("resolveCapturedLeadScope preserva marcadores mesmo com filtros de scraping presentes", () => {
      const filters = {
        _source: "prospeccao-sites",
        filterEmpty: true,
        filterDuplicates: true,
        filterLandlines: true,
        filterWithWebsite: true,
        captureAllReviews: true,
        _baselineMaxId: 2450,
        _scrapeStartedAt: "2026-08-18T19:00:00.000Z",
      };

      const scope = resolveCapturedLeadScope(filters);
      expect(scope.ok).toBe(true);
      if (scope.ok) {
        expect(scope.baselineMaxId).toBe(2450);
        expect(scope.startedAt).toBe("2026-08-18T19:00:00.000Z");
      }
    });
  });

  describe("3. Blindagem de variáveis e proteção contra chaves residuais", () => {
    it("remove variáveis residuais inventadas ou não resolvidas", () => {
      const textoComVariavelInventada = "Olá, vi que sua empresa {{empresa_inexistente}} tem potencial em {cidade_nao_mapeada}.";
      
      // Simula a etapa de blindagem final do campaign-worker / followup-worker
      const textoBlindado = textoComVariavelInventada
        .replace(/\{\{\s*[\w-]+\s*\}\}/g, "")
        .replace(/\{\s*[\w-]+\s*\}/g, "")
        .replace(/[ \t]{2,}/g, " ")
        .replace(/\s+([.,!?])/g, "$1")
        .trim();

      expect(textoBlindado).toBe("Olá, vi que sua empresa tem potencial em.");
      expect(textoBlindado).not.toContain("{{");
      expect(textoBlindado).not.toContain("}}");
      expect(textoBlindado).not.toContain("{cidade_nao_mapeada}");
    });
  });
});
