import { beforeEach, describe, expect, it, vi } from "vitest";

type TableName =
  | "whatsapp_warmup_configs"
  | "contacts"
  | "campaign_targets"
  | "warmup_external_quarantine"
  | "app_settings"
  | "whatsapp_phone_passports";

const state: Record<TableName, Array<Record<string, unknown>>> = {
  whatsapp_warmup_configs: [],
  contacts: [],
  campaign_targets: [],
  warmup_external_quarantine: [],
  app_settings: [],
  whatsapp_phone_passports: [],
};

const pendingActionsEnqueued: Array<Record<string, unknown>> = [];

vi.mock("@/lib/warmup/warmup-pending-actions", () => ({
  enqueuePendingWarmupAction: vi.fn(async (_clientId: string, action: Record<string, unknown>) => {
    pendingActionsEnqueued.push(action);
  }),
}));

vi.mock("@/lib/manual-send-registry", () => ({
  isAiSend: vi.fn((id: string) => id.startsWith("ai-")),
  isWarmupSend: vi.fn((id: string) => id.startsWith("wu-")),
  isManualSend: vi.fn((id: string) => id.startsWith("man-")),
  isPendingAutomatedSend: vi.fn(() => false),
}));

vi.mock("@/lib/supabase_admin", () => {
  function applyFilters(rows: Array<Record<string, unknown>>, filters: Array<(r: Record<string, unknown>) => boolean>) {
    return rows.filter((r) => filters.every((fn) => fn(r)));
  }

  function makeBuilder(table: TableName) {
    const filters: Array<(r: Record<string, unknown>) => boolean> = [];
    let pendingOp: "select" | "insert" | "upsert" | "update" = "select";
    let payload: Record<string, unknown> | Array<Record<string, unknown>> | null = null;
    let onConflictCols: string[] = [];
    let limitNum: number | null = null;

    const execute = async () => {
      if (pendingOp === "insert" && payload) {
        const items = Array.isArray(payload) ? payload : [payload];
        for (const item of items) {
          state[table].push({
            id: (item.id as string) || `${table}-${state[table].length + 1}`,
            ...item,
          });
        }
        return { data: items, error: null };
      }

      if (pendingOp === "upsert" && payload) {
        const items = Array.isArray(payload) ? payload : [payload];
        for (const item of items) {
          const existingIdx = state[table].findIndex((r) =>
            onConflictCols.length > 0 && onConflictCols.every((c) => r[c] === item[c])
          );
          if (existingIdx >= 0) {
            state[table][existingIdx] = { ...state[table][existingIdx], ...item };
          } else {
            state[table].push({
              id: (item.id as string) || `${table}-${state[table].length + 1}`,
              ...item,
            });
          }
        }
        return { data: items, error: null };
      }

      if (pendingOp === "update" && payload && !Array.isArray(payload)) {
        const matches = applyFilters(state[table], filters);
        for (const row of matches) {
          Object.assign(row, payload);
        }
        return { data: matches, error: null };
      }

      let rows = applyFilters(state[table], filters);
      if (limitNum !== null) rows = rows.slice(0, limitNum);
      return { data: rows, error: null };
    };

    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: (data: Record<string, unknown>) => {
        pendingOp = "insert";
        payload = data;
        return builder;
      },
      upsert: (data: Record<string, unknown>, opts?: { onConflict?: string }) => {
        pendingOp = "upsert";
        payload = data;
        onConflictCols = String(opts?.onConflict || "").split(",").map((s) => s.trim()).filter(Boolean);
        return builder;
      },
      update: (data: Record<string, unknown>) => {
        pendingOp = "update";
        payload = data;
        return builder;
      },
      eq: (col: string, val: unknown) => {
        filters.push((r) => r[col] === val);
        return builder;
      },
      in: (col: string, vals: unknown[]) => {
        filters.push((r) => vals.includes(r[col]));
        return builder;
      },
      order: () => builder,
      limit: (n: number) => {
        limitNum = n;
        return builder;
      },
      maybeSingle: async () => {
        const res = await execute();
        return { data: res.data?.[0] ?? null, error: res.error };
      },
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
        execute().then(resolve, reject),
    };
    return builder;
  }

  return {
    supabaseAdmin: {
      from: (table: TableName) => makeBuilder(table),
    },
  };
});

import {
  checkExternalWarmupInbound,
  invalidateExternalShieldCache,
  listExternalQuarantineEntries,
  looksLikeExternalWarmupText,
  promoteQuarantineEntryToCrm,
} from "../warmup-external-shield";

const CLIENT_ID = "11111111-1111-4111-8111-111111111111";

describe("MMZap External Warmup Shield (receive_only & hybrid_quarantine)", () => {
  beforeEach(() => {
    for (const k of Object.keys(state) as TableName[]) {
      state[k] = [];
    }
    pendingActionsEnqueued.length = 0;
    invalidateExternalShieldCache();
  });

  it("classifica corretamente textos casuais do MMZap vs intenção comercial real", () => {
    expect(looksLikeExternalWarmupText("Bom dia! Tudo bem?")).toBe(true);
    expect(looksLikeExternalWarmupText("Segue notícia de hoje: previsão do tempo e dólar")).toBe(true);
    expect(looksLikeExternalWarmupText("Oi, quanto custa um site para minha clínica?")).toBe(false);
    expect(looksLikeExternalWarmupText("Sim, pode mandar a prévia por favor!")).toBe(false);
  });

  it("no modo receive_only: intercepta MMZap sem criar CRM/responder, contabiliza inbound e agenda apenas leitura", async () => {
    state.whatsapp_warmup_configs.push({
      client_id: CLIENT_ID,
      instance_name: "chip_mmzap_01",
      phone_number: "5511999990001",
      external_warmup_mode: "receive_only",
      enable_blue_ticks: true,
      received_today: 2,
      external_warmup_inbound_today: 0,
      external_warmup_inbound_total: 5,
    });

    const res = await checkExternalWarmupInbound({
      clientId: CLIENT_ID,
      instanceName: "chip_mmzap_01",
      remoteJid: "5521988887777@s.whatsapp.net",
      senderName: "Rede MMZap 42",
      messageId: "MSG-EXT-1",
      messageText: "Bom dia! Ótima terça-feira pra vocês 🙏",
    });

    expect(res.blocked).toBe(true);
    expect(res.classification).toBe("external_warmup_inbound");
    expect(res.reason).toBe("external_warmup_receive_only");

    // Não poluí CRM e registrou na quarentena para auditoria
    expect(state.contacts).toHaveLength(0);
    expect(state.warmup_external_quarantine).toHaveLength(1);
    expect(state.warmup_external_quarantine[0].source_tag).toBe("mmzap");

    // Agendou APENAS tick azul de leitura passiva — zero envio de volta!
    expect(pendingActionsEnqueued).toHaveLength(1);
    expect(pendingActionsEnqueued[0].type).toBe("read");
    expect(pendingActionsEnqueued[0].peerInstance).toBe("external_mmzap");

    // Contabilizou recebimento real no chip e no passaporte
    const cfg = state.whatsapp_warmup_configs[0];
    expect(cfg.received_today).toBe(3);
    expect(cfg.external_warmup_inbound_today).toBe(1);
    expect(cfg.external_warmup_inbound_total).toBe(6);
    expect(state.whatsapp_phone_passports).toHaveLength(1);
    expect(state.whatsapp_phone_passports[0].external_warmup_inbound_total).toBe(6);
  });

  it("no modo receive_only: intercepta eco fromMe=true quando MMZap está ativo como self_echo e libera envio manual quando inativo", async () => {
    state.whatsapp_warmup_configs.push({
      client_id: CLIENT_ID,
      instance_name: "chip_mmzap_01",
      phone_number: "5511999990001",
      external_warmup_mode: "receive_only",
      mmzap_browser_status: "running",
      enable_blue_ticks: true,
      received_today: 0,
      external_warmup_inbound_today: 0,
      external_warmup_inbound_total: 0,
    });

    const res = await checkExternalWarmupInbound({
      clientId: CLIENT_ID,
      instanceName: "chip_mmzap_01",
      remoteJid: "5521977776666@s.whatsapp.net",
      messageId: "CHROME-MMZAP-ECHO-1",
      messageText: "Boa tarde! Tudo certo por aí?",
      fromMe: true,
    });

    expect(res.blocked).toBe(true);
    expect(res.classification).toBe("self_echo");
    expect(res.reason).toBe("external_warmup_self_echo");
    // Self-echo não soma inbound de terceiros nem agenda leitura
    expect(state.whatsapp_warmup_configs[0].received_today).toBe(0);
    expect(pendingActionsEnqueued).toHaveLength(0);

    // Quando MMZap NÃO está rodando (ex: idle/unpaired), envio manual do operador no celular passa livremente
    state.whatsapp_warmup_configs[0].mmzap_browser_status = "idle";
    invalidateExternalShieldCache();
    const manualRes = await checkExternalWarmupInbound({
      clientId: CLIENT_ID,
      instanceName: "chip_mmzap_01",
      remoteJid: "5521977778888@s.whatsapp.net",
      messageId: "PHONE-MANUAL-1",
      messageText: "Oi! Tudo bem?",
      fromMe: true,
    });
    expect(manualRes.blocked).toBe(false);
    expect(manualRes.classification).toBe("none");
  });

  it("NUNCA bloqueia um lead real do CRM ou alvo de campanha mesmo com receive_only ativo", async () => {
    state.whatsapp_warmup_configs.push({
      client_id: CLIENT_ID,
      instance_name: "chip_mmzap_01",
      phone_number: "5511999990001",
      external_warmup_mode: "receive_only",
      enable_blue_ticks: true,
    });

    state.campaign_targets.push({
      client_id: CLIENT_ID,
      remote_jid: "5511966665555@s.whatsapp.net",
      status: "sent",
    });

    const resLead = await checkExternalWarmupInbound({
      clientId: CLIENT_ID,
      instanceName: "chip_mmzap_01",
      remoteJid: "5511966665555@s.whatsapp.net",
      messageId: "LEAD-MSG-1",
      messageText: "Oi, sim!",
    });

    expect(resLead.blocked).toBe(false);
    expect(resLead.classification).toBe("none");
  });

  it("no modo hybrid_quarantine: libera intenção comercial na hora e permite promover contato quarentenado para CRM", async () => {
    state.whatsapp_warmup_configs.push({
      client_id: CLIENT_ID,
      instance_name: "chip_hybrid_01",
      phone_number: "5511999990002",
      external_warmup_mode: "hybrid_quarantine",
      enable_blue_ticks: true,
      received_today: 0,
      external_warmup_inbound_today: 0,
      external_warmup_inbound_total: 0,
    });

    // 1. Pergunta comercial direta passa mesmo sendo desconhecido
    const commercial = await checkExternalWarmupInbound({
      clientId: CLIENT_ID,
      instanceName: "chip_hybrid_01",
      remoteJid: "5511955554444@s.whatsapp.net",
      messageId: "MSG-COM-1",
      messageText: "Oi, vi o anúncio e quero um site pra minha clínica",
    });
    expect(commercial.blocked).toBe(false);

    // 2. Mensagem ambígua curta vai para quarentena revisável
    const ambiguous = await checkExternalWarmupInbound({
      clientId: CLIENT_ID,
      instanceName: "chip_hybrid_01",
      remoteJid: "5511944443333@s.whatsapp.net",
      messageId: "MSG-AMB-1",
      messageText: "Olá!",
    });
    expect(ambiguous.blocked).toBe(true);

    const list = await listExternalQuarantineEntries(CLIENT_ID, { instanceName: "chip_hybrid_01" });
    expect(list).toHaveLength(1);
    expect(list[0].canonical_sender_phone).toBe("5511944443333");

    // 3. Operador promove o número para o CRM em 1 clique
    const promoted = await promoteQuarantineEntryToCrm(CLIENT_ID, "5511944443333", "chip_hybrid_01");
    expect(promoted.ok).toBe(true);

    // 4. Próxima mensagem desse número passa direto para CRM/Sarah
    const afterPromote = await checkExternalWarmupInbound({
      clientId: CLIENT_ID,
      instanceName: "chip_hybrid_01",
      remoteJid: "5511944443333@s.whatsapp.net",
      messageId: "MSG-AMB-2",
      messageText: "Opa",
    });
    expect(afterPromote.blocked).toBe(false);
  });
});
