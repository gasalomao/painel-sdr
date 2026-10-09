import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { WebsiteProject, WebsiteSkill } from "../types";

// Mock da função resolveActiveWebsiteSkills para testar a lógica
function isImpeccableSkill(skill: WebsiteSkill): boolean {
  return /\bimpeccable\b/i.test(skill.name) || /\bimpeccable\b/i.test(skill.id);
}

function mockResolveImpeccable(
  project: WebsiteProject,
  skills: readonly WebsiteSkill[],
): boolean {
  const selectedIds = new Set(project.selected_skill_ids);
  const selected = skills.filter((skill) =>
    skill.is_enabled &&
    (skill.trigger_mode === "always" || selectedIds.has(skill.id))
  );

  const forceImpeccable = process.env.FORCE_IMPECCABLE === "true";
  const impeccable = forceImpeccable || selected.some(isImpeccableSkill);
  return impeccable;
}

describe("Impeccable Toggle Logic", () => {
  const mockProject: WebsiteProject = {
    id: "test-project",
    name: "Test Site",
    client_id: "test-client",
    tenant_id: "test-tenant",
    selected_skill_ids: [],
    client_context: {},
  } as any;

  const impeccableSkill: WebsiteSkill = {
    id: "impeccable-design",
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
    id: "other-skill",
    name: "Other Skill",
    client_id: null,
    tenant_id: "test-tenant",
    is_enabled: true,
    trigger_mode: "manual",
    tags: [],
    priority: 50,
    instructions: "Other instructions",
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

  it("should ENABLE Impeccable when skill is selected by user", () => {
    const projectWithImpeccable: WebsiteProject = {
      ...mockProject,
      selected_skill_ids: ["impeccable-design"],
    };

    const result = mockResolveImpeccable(projectWithImpeccable, [impeccableSkill, otherSkill]);

    expect(result).toBe(true);
  });

  it("should DISABLE Impeccable when skill is NOT selected by user", () => {
    const projectWithoutImpeccable: WebsiteProject = {
      ...mockProject,
      selected_skill_ids: ["other-skill"], // Impeccable não selecionado
    };

    const result = mockResolveImpeccable(projectWithoutImpeccable, [impeccableSkill, otherSkill]);

    expect(result).toBe(false);
  });

  it("should DISABLE Impeccable when NO skills are selected", () => {
    const projectWithoutSkills: WebsiteProject = {
      ...mockProject,
      selected_skill_ids: [], // Nenhuma skill
    };

    const result = mockResolveImpeccable(projectWithoutSkills, [impeccableSkill, otherSkill]);

    expect(result).toBe(false);
  });

  it("should FORCE ENABLE Impeccable when FORCE_IMPECCABLE=true", () => {
    process.env.FORCE_IMPECCABLE = "true";

    const projectWithoutImpeccable: WebsiteProject = {
      ...mockProject,
      selected_skill_ids: [], // Nenhuma skill selecionada
    };

    const result = mockResolveImpeccable(projectWithoutImpeccable, [impeccableSkill, otherSkill]);

    expect(result).toBe(true); // Forçado ativo
  });

  it("should RESPECT user choice when FORCE_IMPECCABLE=false", () => {
    process.env.FORCE_IMPECCABLE = "false";

    const projectWithoutImpeccable: WebsiteProject = {
      ...mockProject,
      selected_skill_ids: [], // Nenhuma skill selecionada
    };

    const result = mockResolveImpeccable(projectWithoutImpeccable, [impeccableSkill, otherSkill]);

    expect(result).toBe(false); // Não ativo
  });

  it("should RESPECT user choice when FORCE_IMPECCABLE is not set (default)", () => {
    // Sem env var (comportamento padrão)
    const projectWithoutImpeccable: WebsiteProject = {
      ...mockProject,
      selected_skill_ids: [], // Nenhuma skill selecionada
    };

    const result = mockResolveImpeccable(projectWithoutImpeccable, [impeccableSkill, otherSkill]);

    expect(result).toBe(false); // Não ativo (respeita escolha do usuário)
  });

  it("should work with always trigger mode", () => {
    const alwaysImpeccableSkill: WebsiteSkill = {
      ...impeccableSkill,
      trigger_mode: "always",
    };

    const projectWithAlways: WebsiteProject = {
      ...mockProject,
      selected_skill_ids: [], // Não selecionado manualmente
    };

    const result = mockResolveImpeccable(projectWithAlways, [alwaysImpeccableSkill, otherSkill]);

    expect(result).toBe(true); // Ativo por trigger_mode="always"
  });

  it("should respect is_enabled=false even with trigger_mode=always", () => {
    const disabledImpeccableSkill: WebsiteSkill = {
      ...impeccableSkill,
      trigger_mode: "always",
      is_enabled: false, // Skill desabilitada
    };

    const projectWithDisabled: WebsiteProject = {
      ...mockProject,
      selected_skill_ids: [],
    };

    const result = mockResolveImpeccable(projectWithDisabled, [disabledImpeccableSkill, otherSkill]);

    expect(result).toBe(false); // Não ativo (is_enabled=false)
  });

  it("should NOT activate when skill is selected but disabled", () => {
    const disabledImpeccableSkill: WebsiteSkill = {
      ...impeccableSkill,
      is_enabled: false,
    };

    const projectWithDisabled: WebsiteProject = {
      ...mockProject,
      selected_skill_ids: ["impeccable-design"], // Selecionado mas desabilitado
    };

    const result = mockResolveImpeccable(projectWithDisabled, [disabledImpeccableSkill, otherSkill]);

    expect(result).toBe(false); // Não ativo
  });

  it("should OVERRIDE disabled skill when FORCE_IMPECCABLE=true", () => {
    process.env.FORCE_IMPECCABLE = "true";

    const disabledImpeccableSkill: WebsiteSkill = {
      ...impeccableSkill,
      is_enabled: false, // Desabilitado
    };

    const projectWithDisabled: WebsiteProject = {
      ...mockProject,
      selected_skill_ids: [],
    };

    const result = mockResolveImpeccable(projectWithDisabled, [disabledImpeccableSkill, otherSkill]);

    expect(result).toBe(true); // Forçado ativo mesmo desabilitado
  });
});
