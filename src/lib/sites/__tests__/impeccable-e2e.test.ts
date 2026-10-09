import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { composeWebsitePrompt } from "../prompts";
import type { WebsiteProject, WebsiteSkill } from "../types";

describe("Impeccable E2E Integration", () => {
  const mockProject: WebsiteProject = {
    id: "test-project",
    name: "Test Site",
    client_id: "test-client",
    tenant_id: "test-tenant",
    instructions: "Build a professional website",
    cta: "Contact Us",
    selected_skill_ids: [],
    client_context: {
      name: "Test Company",
      segment: "Technology",
    },
  } as any;

  const impeccableSkill: WebsiteSkill = {
    id: "builtin:impeccable-design",
    slug: "impeccable-design",
    name: "Impeccable Design",
    client_id: null,
    tenant_id: "test-tenant",
    is_enabled: true,
    trigger_mode: "manual",
    tags: [],
    priority: 100,
    instructions: "Apply Impeccable design principles",
  } as any;

  const otherSkill: WebsiteSkill = {
    id: "restaurant-menu",
    name: "Restaurant Menu",
    client_id: null,
    tenant_id: "test-tenant",
    is_enabled: true,
    trigger_mode: "manual",
    tags: ["restaurant"],
    priority: 50,
    instructions: "Create a restaurant menu",
  } as any;

  let originalEnv: string | undefined;

  beforeEach(() => {
    originalEnv = process.env.FORCE_IMPECCABLE;
    delete process.env.FORCE_IMPECCABLE;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.FORCE_IMPECCABLE = originalEnv;
    } else {
      delete process.env.FORCE_IMPECCABLE;
    }
  });

  describe("User Selection Controls Impeccable", () => {
    it("includes Impeccable guidance when skill is selected", () => {
      const projectWithImpeccable: WebsiteProject = {
        ...mockProject,
        selected_skill_ids: ["builtin:impeccable-design"],
      };

      const prompt = composeWebsitePrompt(
        projectWithImpeccable,
        [impeccableSkill, otherSkill],
        "Build a stunning landing page",
        "Create a landing page for tech startup",
      );

      // Deve incluir guidance do Impeccable
      expect(prompt).toContain("REFERÊNCIA OFICIAL INTEGRAL");
      expect(prompt).not.toContain("a diretriz Impeccable Design está DESATIVADA");
    });

    it("excludes Impeccable guidance when skill is NOT selected", () => {
      const projectWithoutImpeccable: WebsiteProject = {
        ...mockProject,
        selected_skill_ids: ["restaurant-menu"], // Outra skill
      };

      const prompt = composeWebsitePrompt(
        projectWithoutImpeccable,
        [impeccableSkill, otherSkill],
        "Build a stunning landing page",
        "Create a landing page",
      );

      // NÃO deve incluir guidance do Impeccable
      expect(prompt).not.toContain("craft-floor");
      expect(prompt).toContain("a diretriz Impeccable Design está DESATIVADA pelo usuário");
    });

    it("excludes Impeccable when no skills are selected", () => {
      const projectNoSkills: WebsiteProject = {
        ...mockProject,
        selected_skill_ids: [],
      };

      const prompt = composeWebsitePrompt(
        projectNoSkills,
        [impeccableSkill, otherSkill],
        "Build a landing page",
        "Create a simple landing page",
      );

      // NÃO deve incluir guidance
      expect(prompt).not.toContain("craft-floor");
      expect(prompt).toContain("a diretriz Impeccable Design está DESATIVADA");
    });
  });

  describe("FORCE_IMPECCABLE Environment Variable", () => {
    it("forces Impeccable even when user did not select it", () => {
      process.env.FORCE_IMPECCABLE = "true";

      const projectNoSkills: WebsiteProject = {
        ...mockProject,
        selected_skill_ids: [],
      };

      const prompt = composeWebsitePrompt(
        projectNoSkills,
        [impeccableSkill, otherSkill],
        "Build a landing page",
        "Create a landing page",
      );

      // DEVE forçar guidance mesmo sem seleção
      expect(prompt).toContain("craft-floor");
      expect(prompt).not.toContain("a diretriz Impeccable Design está DESATIVADA");
    });

    it("respects user choice when FORCE_IMPECCABLE=false", () => {
      process.env.FORCE_IMPECCABLE = "false";

      const projectNoSkills: WebsiteProject = {
        ...mockProject,
        selected_skill_ids: [],
      };

      const prompt = composeWebsitePrompt(
        projectNoSkills,
        [impeccableSkill, otherSkill],
        "Build a landing page",
        "Create a landing page",
      );

      // NÃO deve forçar
      expect(prompt).not.toContain("craft-floor");
      expect(prompt).toContain("a diretriz Impeccable Design está DESATIVADA");
    });
  });

  describe("Trigger Modes", () => {
    it("activates with trigger_mode=always", () => {
      const alwaysSkill: WebsiteSkill = {
        ...impeccableSkill,
        trigger_mode: "always",
      };

      const projectNoSelection: WebsiteProject = {
        ...mockProject,
        selected_skill_ids: [],
      };

      const prompt = composeWebsitePrompt(
        projectNoSelection,
        [alwaysSkill, otherSkill],
        "Build a page",
        "Create a page",
      );

      // Deve ativar automaticamente
      expect(prompt).toContain("craft-floor");
    });

    it("respects is_enabled=false even with trigger_mode=always", () => {
      const disabledAlwaysSkill: WebsiteSkill = {
        ...impeccableSkill,
        trigger_mode: "always",
        is_enabled: false,
      };

      const projectNoSelection: WebsiteProject = {
        ...mockProject,
        selected_skill_ids: [],
      };

      const prompt = composeWebsitePrompt(
        projectNoSelection,
        [disabledAlwaysSkill, otherSkill],
        "Build a page",
        "Create a page",
      );

      // NÃO deve ativar (desabilitada)
      expect(prompt).not.toContain("craft-floor");
      expect(prompt).toContain("a diretriz Impeccable Design está DESATIVADA");
    });
  });
});
