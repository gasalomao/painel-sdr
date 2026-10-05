import { IMPECCABLE_SKILL_DESCRIPTION, IMPECCABLE_SKILL_INSTRUCTIONS } from "./impeccable";
import { getSitesDb } from "./server";
import type { WebsiteSkill } from "./types";
import { WebsiteInstructionError, assertWebsiteUuid } from "./prompts";

const definitions: Array<[string, string, string, string[], number, WebsiteSkill["trigger_mode"], string, string]> = [
  ["impeccable-design", "Impeccable Design (Anti-AI)", "design", ["impeccable", "design", "anti-ai", "original", "ui", "craft", "layout", "typography"], 100, "always", IMPECCABLE_SKILL_DESCRIPTION, IMPECCABLE_SKILL_INSTRUCTIONS],
];

export const BUILTIN_WEBSITE_SKILLS: readonly WebsiteSkill[] = Object.freeze(definitions.map(([slug, name, category, tags, priority, trigger_mode, description, instructions]) => Object.freeze({
  id: `builtin:${slug}`, client_id: null, slug, name, category, tags: Object.freeze(tags) as unknown as string[], instructions,
  description, priority, trigger_mode, is_enabled: true, is_builtin: true, version: 3,
})));

export type WebsiteSkillInput = Pick<WebsiteSkill, "name" | "slug" | "description" | "instructions" | "category" | "tags" | "priority" | "trigger_mode" | "is_enabled">;
const fields = new Set(["name", "slug", "description", "instructions", "category", "tags", "priority", "trigger_mode", "is_enabled"]);

export function validateSkillInput(value: unknown, partial = false): Partial<WebsiteSkillInput> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WebsiteInstructionError("Skill inválida.");
  const input = value as Record<string, unknown>;
  if (!Object.keys(input).length || Object.keys(input).some((key) => !fields.has(key))) throw new WebsiteInstructionError("Campos de skill inválidos.");
  const result: Record<string, unknown> = {};
  for (const [key, max] of [["name", 100], ["slug", 80], ["description", 500], ["instructions", 12000], ["category", 60]] as const) {
    if (!(key in input)) {
      if (!partial && ["name", "slug", "instructions"].includes(key)) throw new WebsiteInstructionError(`Campo obrigatório: ${key}.`);
      continue;
    }
    if (typeof input[key] !== "string" || input[key].length > max || (key !== "description" && !input[key].trim())) throw new WebsiteInstructionError(`Campo inválido: ${key}.`);
    result[key] = input[key].trim();
  }
  if (typeof result.slug === "string" && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result.slug)) throw new WebsiteInstructionError("Slug inválido.");
  if ("tags" in input) {
    if (!Array.isArray(input.tags) || input.tags.length > 20 || input.tags.some((tag) => typeof tag !== "string" || !tag.trim() || tag.length > 60)) throw new WebsiteInstructionError("Tags inválidas.");
    result.tags = [...new Set(input.tags.map((tag: string) => tag.trim().toLowerCase()))];
  }
  if ("priority" in input) {
    if (!Number.isInteger(input.priority) || (input.priority as number) < 0 || (input.priority as number) > 100) throw new WebsiteInstructionError("Prioridade deve estar entre 0 e 100.");
    result.priority = input.priority;
  }
  if ("trigger_mode" in input) {
    if (!["always", "automatic", "manual"].includes(input.trigger_mode as string)) throw new WebsiteInstructionError("Modo de ativação inválido.");
    result.trigger_mode = input.trigger_mode;
  }
  if ("is_enabled" in input) {
    if (typeof input.is_enabled !== "boolean") throw new WebsiteInstructionError("Estado inválido.");
    result.is_enabled = input.is_enabled;
  }
  return result;
}

export async function getEffectiveSkills(clientId: string): Promise<WebsiteSkill[]> {
  assertWebsiteUuid(clientId);
  const { data, error } = await getSitesDb().from("website_skills").select("*").eq("client_id", clientId).order("version", { ascending: true }).limit(101);
  if (error) throw new WebsiteInstructionError("Não foi possível carregar as skills.", 503);
  if ((data?.length ?? 0) > 100) throw new WebsiteInstructionError("Limite de skills excedido.", 409);
  const privateSkills = (data ?? []) as WebsiteSkill[];
  const overrides = new Map(privateSkills.filter((item) => item.client_id === clientId).map((item) => [item.slug, item]));
  const builtins = BUILTIN_WEBSITE_SKILLS.map((builtin) => {
    const override = overrides.get(builtin.slug);
    if (!override) return builtin;
    // Toggle-only overrides created by older releases copied the obsolete recipe.
    // Rebase that recognizable builtin text, while preserving genuine custom instructions.
    const legacyRecipe = builtin.slug === "impeccable-design" && override.instructions.startsWith("DIRETRIZ MESTRA IMPECCABLE DESIGN (pbakaus/impeccable") && override.instructions.includes("Paleta de Cores Autoral por Nicho");
    return { ...builtin, ...override, ...(legacyRecipe ? { instructions: builtin.instructions, description: builtin.description } : {}), id: builtin.id, client_id: builtin.client_id, slug: builtin.slug, is_builtin: true, priority: builtin.priority, trigger_mode: builtin.trigger_mode, tags: [...(override.tags ?? builtin.tags)] };
  });
  return [...builtins, ...privateSkills.filter((item) => item.client_id === clientId && !BUILTIN_WEBSITE_SKILLS.some((builtin) => builtin.slug === item.slug))];
}

export async function createWebsiteSkill(clientId: string, input: unknown): Promise<WebsiteSkill> {
  assertWebsiteUuid(clientId);
  const value = validateSkillInput(input);
  if (BUILTIN_WEBSITE_SKILLS.some((item) => item.slug === value.slug)) throw new WebsiteInstructionError("Use PATCH no ID builtin para criar um override privado.", 409);
  const { count, error: countError } = await getSitesDb().from("website_skills").select("id", { count: "exact", head: true }).eq("client_id", clientId);
  if (countError) throw new WebsiteInstructionError("Não foi possível verificar o limite de skills.", 503);
  if (count === null || count >= 100) throw new WebsiteInstructionError("Limite de 100 skills privadas atingido.", 409);
  const { data, error } = await getSitesDb().from("website_skills").insert({ description: "", category: "custom", tags: [], priority: 50, trigger_mode: "manual", is_enabled: true, ...value, client_id: clientId, is_builtin: false, version: 1 }).select("*").single();
  if (error) throw new WebsiteInstructionError("Não foi possível criar a skill. Verifique se o slug já existe.", 409);
  return data as WebsiteSkill;
}

export async function updateWebsiteSkill(clientId: string, id: string, input: unknown): Promise<WebsiteSkill> {
  assertWebsiteUuid(clientId);
  const value = validateSkillInput(input, true);
  const normalizedId = decodeURIComponent(id).trim();
  const builtin = BUILTIN_WEBSITE_SKILLS.find((item) => item.id === id || item.id === normalizedId || item.slug === id || item.slug === normalizedId);
  if (!builtin) assertWebsiteUuid(id);
  if (builtin && value.slug && value.slug !== builtin.slug) throw new WebsiteInstructionError("O slug builtin é imutável.");
  if (!builtin && value.slug && BUILTIN_WEBSITE_SKILLS.some((item) => item.slug === value.slug)) throw new WebsiteInstructionError("Slug reservado.");
  let query = getSitesDb().from("website_skills").select("*").eq("client_id", clientId);
  query = builtin ? query.eq("slug", builtin.slug) : query.eq("id", id);
  const { data: list, error: readError } = await query.order("version", { ascending: false }).limit(1);
  if (readError) throw new WebsiteInstructionError("Não foi possível carregar a skill.", 503);
  const current = list?.[0] ?? null;
  if (!current && !builtin) throw new WebsiteInstructionError("Skill não encontrada.", 404);
  if (!current && builtin) {
    const { id: _id, client_id: _clientId, ...base } = builtin;
    const { data, error } = await getSitesDb().from("website_skills").insert({ ...base, ...value, client_id: clientId, is_builtin: false, version: builtin.version + 1 }).select("*").single();
    if (error) throw new WebsiteInstructionError("Conflito ao criar override privado.", 409);
    return { ...data, id: builtin.id, is_builtin: true } as WebsiteSkill;
  }
  const { data, error } = await getSitesDb().from("website_skills").update({ ...value, version: (current.version ?? 1) + 1, updated_at: new Date().toISOString() }).eq("client_id", clientId).eq("id", current.id).select("*").maybeSingle();
  if (error || !data) throw new WebsiteInstructionError("Skill alterada por outra operação. Recarregue e tente novamente.", 409);
  return { ...data, id: builtin?.id ?? data.id } as WebsiteSkill;
}

export async function deleteWebsiteSkill(clientId: string, id: string): Promise<void> {
  assertWebsiteUuid(clientId);
  const builtin = BUILTIN_WEBSITE_SKILLS.find((item) => item.id === id);
  if (!builtin) assertWebsiteUuid(id);
  let query = getSitesDb().from("website_skills").delete().eq("client_id", clientId);
  query = builtin ? query.eq("slug", builtin.slug) : query.eq("id", id);
  const { error } = await query;
  if (error) throw new WebsiteInstructionError("Não foi possível excluir a skill.", 503);
}
