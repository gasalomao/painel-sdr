/**
 * Cache em memória pra ai_organizer_config (id=1).
 *
 * Antes: scheduler + agent/process + webhook liam essa tabela em CADA execução
 * (centenas de queries/min em conta ativa). Config muda raramente — TTL de 60s
 * é seguro e elimina 99% das queries.
 *
 * invalidateOrganizerConfigCache() é chamado quando admin altera modelo/global.
 */

import { supabaseAdmin } from "@/lib/supabase_admin";

export type OrganizerConfig = {
  api_key: string | null;
  model: string | null;
  provider: string | null;
  enabled: boolean;
  execution_hour: number;
  last_run: string | null;
};

let cache: { value: OrganizerConfig | null; at: number } | null = null;
const TTL_MS = 60_000;

export async function getOrganizerConfig(): Promise<OrganizerConfig | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;

  if (!supabaseAdmin) {
    cache = { value: null, at: Date.now() };
    return null;
  }
  const { data, error } = await supabaseAdmin
    .from("ai_organizer_config")
    .select("api_key, model, provider, enabled, execution_hour, last_run")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    console.warn("[ORGANIZER-CONFIG] erro lendo cache:", error.message);
    // não cacheia erro — tenta de novo na próxima
    return null;
  }
  cache = {
    value: data
      ? {
          api_key: data.api_key || null,
          model: data.model || null,
          provider: data.provider || null,
          enabled: data.enabled !== false,
          execution_hour: typeof data.execution_hour === "number" ? data.execution_hour : 20,
          last_run: data.last_run || null,
        }
      : null,
    at: Date.now(),
  };
  return cache.value;
}

export function invalidateOrganizerConfigCache() {
  cache = null;
}
