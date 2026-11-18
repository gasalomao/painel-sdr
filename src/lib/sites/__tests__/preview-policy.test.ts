import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const tables = vi.hoisted(() => ({
  campaign_targets: [] as Row[],
  campaigns: [] as Row[],
  automations: [] as Row[],
  app_settings: [] as Row[],
}));

function buildQuery(table: string) {
  const filters: Array<(row: Row) => boolean> = [];

  const chain: any = {
    select() {
      return chain;
    },
    eq(column: string, value: any) {
      filters.push((row) => row[column] === value);
      return chain;
    },
    in(column: string, values: any[]) {
      const set = new Set(values);
      filters.push((row) => set.has(row[column]));
      return chain;
    },
    then(resolve: any) {
      const list = ((tables as any)[table] || []).filter((r: Row) => filters.every((f) => f(r)));
      return Promise.resolve({ data: list, error: null }).then(resolve);
    },
  };
  return chain;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: { from: (t: string) => buildQuery(t) },
}));

import {
  __resetSitePreviewPolicyCacheForTests,
  isSitePreviewAllowedForLead,
  resolveSitePreviewPolicyForLeads,
} from "../preview-policy";

const CLIENT = "00000000-0000-0000-0000-00000000c001";

describe("Política de prévia de site (Prospecção de Sites = somente disparo)", () => {
  beforeEach(() => {
    __resetSitePreviewPolicyCacheForTests();
    tables.campaign_targets.length = 0;
    tables.campaigns.length = 0;
    tables.automations.length = 0;
    tables.app_settings.length = 0;
  });

  it("libera lead sem campanha/automação vinculada (não quebra fluxo manual)", async () => {
    expect(await isSitePreviewAllowedForLead(CLIENT, "5511999990001@s.whatsapp.net")).toBe(true);
  });

  it("bloqueia lead em campanha de prospecção de sites", async () => {
    tables.campaigns.push({ id: "camp-1", client_id: CLIENT, campaign_type: "prospeccao_sites", automation_id: null });
    tables.campaign_targets.push({ client_id: CLIENT, campaign_id: "camp-1", remote_jid: "5511999990002@s.whatsapp.net" });

    expect(await isSitePreviewAllowedForLead(CLIENT, "5511999990002@s.whatsapp.net")).toBe(false);
  });

  it("bloqueia lead de automação com scrape_filters._source = prospeccao-sites", async () => {
    tables.campaigns.push({ id: "camp-2", client_id: CLIENT, campaign_type: null, automation_id: "auto-1" });
    tables.automations.push({ id: "auto-1", site_generation_enabled: true, scrape_filters: { _source: "prospeccao-sites" } });
    tables.campaign_targets.push({ client_id: CLIENT, campaign_id: "camp-2", remote_jid: "5511999990003@s.whatsapp.net" });

    expect(await isSitePreviewAllowedForLead(CLIENT, "5511999990003@s.whatsapp.net")).toBe(false);
  });

  it("bloqueia automação com site_generation_enabled = false", async () => {
    tables.campaigns.push({ id: "camp-3", client_id: CLIENT, campaign_type: null, automation_id: "auto-2" });
    tables.automations.push({ id: "auto-2", site_generation_enabled: false, scrape_filters: {} });
    tables.campaign_targets.push({ client_id: CLIENT, campaign_id: "camp-3", remote_jid: "5511999990004@s.whatsapp.net" });

    expect(await isSitePreviewAllowedForLead(CLIENT, "5511999990004@s.whatsapp.net")).toBe(false);
  });

  it("mantém liberado para automação comum (sem origem de prospecção)", async () => {
    tables.campaigns.push({ id: "camp-4", client_id: CLIENT, campaign_type: null, automation_id: "auto-3" });
    tables.automations.push({ id: "auto-3", site_generation_enabled: true, scrape_filters: { _source: "automacao" } });
    tables.campaign_targets.push({ client_id: CLIENT, campaign_id: "camp-4", remote_jid: "5511999990005@s.whatsapp.net" });

    expect(await isSitePreviewAllowedForLead(CLIENT, "5511999990005@s.whatsapp.net")).toBe(true);
  });

  it("override explícito em app_settings tem precedência sobre a origem", async () => {
    tables.campaigns.push({ id: "camp-5", client_id: CLIENT, campaign_type: "prospeccao_sites", automation_id: "auto-4" });
    tables.automations.push({ id: "auto-4", site_generation_enabled: false, scrape_filters: { _source: "prospeccao-sites" } });
    tables.campaign_targets.push({ client_id: CLIENT, campaign_id: "camp-5", remote_jid: "5511999990006@s.whatsapp.net" });
    tables.app_settings.push({ key: "site_preview_enabled:auto-4", value: "true" });

    // Campanha de prospecção bloqueia independentemente do override da automação.
    expect(await isSitePreviewAllowedForLead(CLIENT, "5511999990006@s.whatsapp.net")).toBe(false);

    __resetSitePreviewPolicyCacheForTests();
    tables.campaigns.length = 0;
    tables.campaigns.push({ id: "camp-6", client_id: CLIENT, campaign_type: null, automation_id: "auto-4" });
    tables.campaign_targets.length = 0;
    tables.campaign_targets.push({ client_id: CLIENT, campaign_id: "camp-6", remote_jid: "5511999990006@s.whatsapp.net" });

    expect(await isSitePreviewAllowedForLead(CLIENT, "5511999990006@s.whatsapp.net")).toBe(true);
  });

  it("resolve em lote com decisões por lead", async () => {
    tables.campaigns.push({ id: "camp-a", client_id: CLIENT, campaign_type: "prospeccao_sites", automation_id: null });
    tables.campaign_targets.push(
      { client_id: CLIENT, campaign_id: "camp-a", remote_jid: "5511999990010@s.whatsapp.net" },
    );

    const policy = await resolveSitePreviewPolicyForLeads(CLIENT, [
      "5511999990010@s.whatsapp.net",
      "5511999990011@s.whatsapp.net",
    ]);
    expect(policy.get("5511999990010@s.whatsapp.net")).toBe(false);
    expect(policy.get("5511999990011@s.whatsapp.net")).toBe(true);
  });

  it("isola tenants: campanha de outro cliente não bloqueia", async () => {
    tables.campaigns.push({ id: "camp-x", client_id: "outro-cliente", campaign_type: "prospeccao_sites", automation_id: null });
    tables.campaign_targets.push({ client_id: "outro-cliente", campaign_id: "camp-x", remote_jid: "5511999990020@s.whatsapp.net" });

    expect(await isSitePreviewAllowedForLead(CLIENT, "5511999990020@s.whatsapp.net")).toBe(true);
  });
});
