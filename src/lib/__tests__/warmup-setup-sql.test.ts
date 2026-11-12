import { describe, expect, it } from "vitest";
import { SETUP_SQL } from "../setup-sql";

describe("SETUP_SQL — módulo de aquecimento", () => {
  it("inclui todas as tabelas do warmup", () => {
    for (const table of [
      "whatsapp_warmup_configs",
      "whatsapp_warmup_logs",
      "whatsapp_warmup_conversations",
      "whatsapp_warmup_groups",
      "whatsapp_warmup_group_members",
    ]) {
      expect(SETUP_SQL).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
    }
  });

  it("inclui as colunas avançadas das migrations 027 e 028", () => {
    for (const column of [
      "stage_auto_progress",
      "days_active",
      "consecutive_successful_days",
      "health_score",
      "is_quarantined",
      "quarantine_until",
      "error_count_today",
      "vcard_exchanged_peers",
      "continuous_warmup",
      "purpose",
      "profile_hydrated",
      "group_auto_join",
      "swarm_active",
      "max_groups_per_chip",
    ]) {
      expect(SETUP_SQL).toContain(column);
    }
  });

  it("mantém idempotência para reaplicação em banco existente", () => {
    expect(SETUP_SQL).toContain("ALTER TABLE public.whatsapp_warmup_configs");
    expect(SETUP_SQL).toContain("ADD COLUMN IF NOT EXISTS stage_auto_progress");
    expect(SETUP_SQL).toContain("CREATE INDEX IF NOT EXISTS idx_warmup_groups_jid");
  });
});
