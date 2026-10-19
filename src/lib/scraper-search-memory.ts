import { createHash } from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase";
import { parseMinReviews } from "@/lib/scraper-review-count";
import { normRegionName } from "@/lib/geo-regions";

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;
const BOOLEAN_FILTERS = ["filterEmpty", "filterDuplicates", "filterLandlines", "filterWithWebsite", "filterWithInstagram"] as const;

export type SearchOutcome = "exhausted" | "goal_reached" | "stopped" | "timeout" | "error";

type SearchMemory = {
  clientId: string;
  niche: string;
  region: string;
  filters: Record<string, unknown>;
};

function normalizeQuery(value: string): string {
  if (typeof value !== "string") throw new Error("Nicho e região devem ser textos.");
  const normalized = value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/gu, " ").trim();
  if (!normalized) throw new Error("Nicho e região são obrigatórios.");
  return normalized;
}

function eligibilityFilters(filters: Record<string, unknown>): Record<string, unknown> {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) throw new Error("Filtros de busca inválidos.");
  const eligibility: Record<string, unknown> = {};
  for (const key of BOOLEAN_FILTERS) {
    if (filters[key] !== undefined && typeof filters[key] !== "boolean") throw new Error(`Filtro ${key} inválido.`);
    eligibility[key] = filters[key] === true;
  }
  const minReviews = parseMinReviews(filters.minReviews);
  if (minReviews === null) throw new Error("Mínimo de avaliações inválido.");
  eligibility.minReviews = minReviews;
  return eligibility;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Pass effective engine filters, not automation defaults. Runtime/AI/webhook settings do not affect eligibility. */
export function makeSearchKey(niche: string, region: string, filters: Record<string, unknown>): string {
  const normalizedRegion = normRegionName(normalizeQuery(region));
  if (!normalizedRegion) throw new Error("Região obrigatória.");
  return `v1:${hash(JSON.stringify([normalizeQuery(niche), normalizedRegion, eligibilityFilters(filters)]))}`;
}

function tenantScope(clientId: string): { clientId: string; prefix: string } {
  const normalized = typeof clientId === "string" ? clientId.trim() : "";
  if (!normalized) throw new Error("Cliente obrigatório para memória de buscas.");
  // app_settings has no client_id: an exact hashed namespace prevents LIKE wildcards crossing tenants.
  return { clientId: normalized, prefix: `scraper-search-memory:v1:${hash(normalized)}:` };
}

function adminClient(): NonNullable<typeof supabaseAdmin> {
  if (!supabaseAdmin) throw new Error("Supabase admin obrigatório para memória de buscas.");
  return supabaseAdmin;
}

/** Tenant-wide memory for manual and automated runs. Storage failures throw; callers must stop, not replay. */
export async function loadExhaustedSearches(clientId: string, filters?: Record<string, unknown>): Promise<Set<string>> {
  const scope = tenantScope(clientId);
  const filterKey = filters === undefined ? null : JSON.stringify(eligibilityFilters(filters));
  const db = adminClient();
  const now = Date.now();
  const since = now - TTL_MS;
  const exhausted = new Set<string>();
  let afterKey = "";

  // ponytail: existing app_settings avoids migration/CRM rows; TTL limits reads, not physical retention.
  // Dedicated indexed storage can replace this at scale. Start-time bounds keep the paged key set finite.
  while (true) {
    let query = db.from("app_settings")
      .select("key,value,updated_at")
      .like("key", `${scope.prefix}%`)
      .gte("updated_at", new Date(since).toISOString())
      .lte("updated_at", new Date(now).toISOString())
      .order("key", { ascending: true });
    // Keyset pagination: concurrent TTL refreshes cannot shift offsets and skip unvisited routes.
    if (afterKey) query = query.gt("key", afterKey);
    const { data, error } = await query.range(0, PAGE_SIZE - 1);
    if (error) throw new Error(`Falha lendo memória de buscas: ${error.message}`);
    if (!Array.isArray(data)) throw new Error("Leitura da memória de buscas não confirmada.");

    for (const row of data) {
      if (typeof row.key !== "string" || !row.key.startsWith(scope.prefix) || typeof row.value !== "string" || typeof row.updated_at !== "string") {
        throw new Error("Registro inválido na memória de buscas.");
      }
      if (row.key <= afterKey) throw new Error("Cursor da memória de buscas não avançou.");
      afterKey = row.key;
      const updatedAt = Date.parse(row.updated_at);
      if (!Number.isFinite(updatedAt)) throw new Error("Data inválida na memória de buscas.");
      if (updatedAt < since || updatedAt > now) continue;
      const stored: unknown = JSON.parse(row.value);
      if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new Error("Memória de buscas inválida.");
      const memory = stored as SearchMemory;
      if (memory.clientId !== scope.clientId) throw new Error("Cliente incompatível na memória de buscas.");
      const searchKey = makeSearchKey(memory.niche, memory.region, memory.filters);
      if (row.key !== `${scope.prefix}${searchKey}`) throw new Error("Chave incompatível na memória de buscas.");
      if (filterKey === null || JSON.stringify(eligibilityFilters(memory.filters)) === filterKey) exhausted.add(searchKey);
    }
    if (data.length < PAGE_SIZE) return exhausted;
  }
}

/** Call only after the route's end-of-results is confirmed and every candidate succeeded or was safely filtered. */
export async function markSearchExhausted(
  clientId: string,
  niche: string,
  region: string,
  filters: Record<string, unknown>,
  outcome: SearchOutcome,
): Promise<boolean> {
  const scope = tenantScope(clientId);
  if (outcome !== "exhausted") return false;
  const memory: SearchMemory = {
    clientId: scope.clientId,
    niche: normalizeQuery(niche),
    region: normalizeQuery(region),
    filters: eligibilityFilters(filters),
  };
  const key = `${scope.prefix}${makeSearchKey(memory.niche, memory.region, memory.filters)}`;
  const { data, error } = await adminClient().from("app_settings")
    .upsert({ key, value: JSON.stringify(memory), updated_at: new Date().toISOString() }, { onConflict: "key" })
    .select("key").single();
  if (error) throw new Error(`Falha gravando memória de buscas: ${error.message}`);
  if (data?.key !== key) throw new Error("Gravação da memória de buscas não confirmada.");
  return true;
}
