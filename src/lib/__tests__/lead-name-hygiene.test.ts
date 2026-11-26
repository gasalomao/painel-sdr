import { describe, expect, it } from "vitest";
import {
  cleanShortCompanyName,
  isPlausibleHumanPersonName,
  sanitizeHumanFirstName,
  sanitizeHumanPersonName,
} from "../lead-name-hygiene";
import { extractPersonNameFromLeadSignals } from "../scraper-lead-enrichment";
import { leadRowToTemplateContext, renderTemplate } from "../template-vars";
import { buildSdrLeadDossierBlock } from "../agent/sdr-enrichment-dossier";

describe("lead-name-hygiene — nomes curtos de empresas e sócios reais", () => {
  it("limpa os 14+ títulos reais de SEO do Google Maps mantendo marcas naturais e preservando casos legados", () => {
    expect(
      cleanShortCompanyName(
        "Ar Condicionado automotivo ,Taboão da Serra Butantã, VILA Sonia- Família Pinguim",
      ),
    ).toBe("Família Pinguim");
    expect(
      cleanShortCompanyName("Instalador de ar condicionado Diego luz em Guarulhos", "Guarulhos"),
    ).toBe("Diego Luz");
    expect(
      cleanShortCompanyName("Piu Piu Ar condicionado Franco da Rocha", "Franco da Rocha"),
    ).toBe("Piu Piu Ar Condicionado");
    expect(
      cleanShortCompanyName("Val Ar condicionado e Radiadores Diadema", "Diadema"),
    ).toBe("Val Ar Condicionado");
    expect(
      cleanShortCompanyName("KS limpeza e higienização de ar condicionado"),
    ).toBe("KS Limpeza");
    expect(
      cleanShortCompanyName("ERS AR CONDICIONADO & ELÉTRICA"),
    ).toBe("ERS Ar Condicionado");
    expect(
      cleanShortCompanyName("LV AR CONDICIONADO E INSTALAÇÕES ELÉTRICAS"),
    ).toBe("LV Ar Condicionado");
    expect(
      cleanShortCompanyName("Minami Ar Condicionado Automotivo - Taboão da Serra - SP", "Taboão da Serra"),
    ).toBe("Minami Ar Condicionado");
    expect(cleanShortCompanyName("ABCD - Ar Condicionado")).toBe("ABCD");
    expect(cleanShortCompanyName("Álarco - Ar Condicionado")).toBe("Álarco");
    expect(cleanShortCompanyName("JR Climatização")).toBe("JR Climatização");
    expect(cleanShortCompanyName("OCEAN Climatização")).toBe("OCEAN Climatização");
    expect(cleanShortCompanyName("R&T Ar Condicionado Automotivo")).toBe("R&T Ar Condicionado");
    expect(cleanShortCompanyName("Era do Gelo Ar Condicionado Automotivo ll")).toBe("Era do Gelo Ar Condicionado");

    // Casos legados preservados
    expect(cleanShortCompanyName("Clínica Sorriso Perfeito LTDA - Campinas", "Campinas")).toBe(
      "Clínica Sorriso Perfeito",
    );
    expect(cleanShortCompanyName("Padaria Centro")).toBe("Padaria Centro");
  });

  it("rejeita cidades, nichos e sufixos como nome de sócio e preserva nomes humanos reais", () => {
    const junkNames = [
      "Franco da Rocha",
      "Ar Condicionado",
      "Radiadores Diadema",
      "Refriar Climatização",
      "Condicionado Automotivo",
      "Rudge Climatização",
      "Praia",
      "Proteses",
      "Família Pinguim",
    ];
    for (const junk of junkNames) {
      expect(isPlausibleHumanPersonName(junk), `Deveria rejeitar "${junk}"`).toBe(false);
      expect(sanitizeHumanPersonName(junk)).toBe("");
      expect(sanitizeHumanFirstName(junk)).toBe("");
    }

    expect(sanitizeHumanPersonName("Dra. Mariana Costa")).toBe("Dra. Mariana Costa");
    expect(sanitizeHumanPersonName("nichelle antunes")).toBe("Nichelle Antunes");
    expect(sanitizeHumanFirstName("Marcos Andrade")).toBe("Marcos");
    expect(isPlausibleHumanPersonName("Daniela Vieira")).toBe(true);
    expect(isPlausibleHumanPersonName("Carla Mendes")).toBe(true);

    // Extrator não deve capturar cidade/serviço via tailMatch
    expect(
      extractPersonNameFromLeadSignals({
        ownerName: "Franco da Rocha",
        leadName: "Piu Piu Ar condicionado Franco da Rocha",
      }),
    ).toBeUndefined();
    expect(
      extractPersonNameFromLeadSignals({
        leadName: "Minami Ar Condicionado Automotivo - Taboão da Serra",
      }),
    ).toBeUndefined();
    expect(
      extractPersonNameFromLeadSignals({
        leadName: "Centro de Saúde - Daniela Vieira",
      }),
    ).toBe("Daniela Vieira");
  });

  it("limpa {{empresa_curta}} e bloqueia {{primeiro_nome_socio}} e dossiê com lixo em leads reais antigos", () => {
    const dirtyLead = {
      nome_negocio: "Piu Piu Ar condicionado Franco da Rocha",
      ramo_negocio: "Serviço de ar condicionado automotivo",
      endereco: "Av. São Paulo, 710 - Franco da Rocha - SP, 07845-000",
      owner_name: "Franco da Rocha",
      avaliacao: 5,
      reviews: 76,
      business_details: {
        enrichment: {
          empresaCurta: "Piu Piu Ar condicionado Franco da Rocha",
          socioDecisor: "Franco da Rocha",
          primeiroNomeSocio: "Franco",
          siteHealth: "no_site" as const,
        },
      },
    };

    const tplCtx = leadRowToTemplateContext(dirtyLead);
    expect(renderTemplate("{{empresa_curta}}", tplCtx)).toBe("Piu Piu Ar Condicionado");
    expect(renderTemplate("{{primeiro_nome_socio}}", tplCtx)).toBe("");
    expect(renderTemplate("{{proprietario}}", tplCtx)).toBe("");

    const dossier = buildSdrLeadDossierBlock(dirtyLead, "strategic");
    expect(dossier).toContain("Empresa Curta: Piu Piu Ar Condicionado");
    expect(dossier).not.toContain("Sócio-decisor: Franco da Rocha");
  });
});
