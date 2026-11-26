// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WarmupConfig, WarmupConversation } from "../warmup-types";

type Row = Record<string, any>;

const db = vi.hoisted(() => ({
  channel_connections: [] as Row[],
  whatsapp_warmup_configs: [] as Row[],
  whatsapp_warmup_conversations: [] as Row[],
  whatsapp_warmup_logs: [] as Row[],
  whatsapp_warmup_groups: [] as Row[],
  whatsapp_warmup_group_members: [] as Row[],
  campaigns: [] as Row[],
  app_settings: [] as Row[],
  webhook_logs: [] as Row[],
  agent_settings: [] as Row[],
}));

const mocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  sendTextMessage: vi.fn(),
  sendMedia: vi.fn(),
  sendSticker: vi.fn(),
  sendPoll: vi.fn(),
  sendStatus: vi.fn(),
  sendPresence: vi.fn(),
  markMessageAsRead: vi.fn(),
  sendReaction: vi.fn(),
  sendContact: vi.fn(),
  acceptGroupInvite: vi.fn(),
  getGroupInviteInfo: vi.fn(),
  findProxy: vi.fn(),
  fetchInstances: vi.fn(),
  checkTenantAiQuota: vi.fn(),
  generateText: vi.fn(),
  getAiKeys: vi.fn(),
  isClientActiveCached: vi.fn(),
}));

function makeBuilder(tableName: keyof typeof db) {
  let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
  let payload: any = null;
  let conflictCols = "";
  const filters: Array<(row: Row) => boolean> = [];
  let orderBy: { col: string; asc: boolean } | null = null;
  let limitN: number | null = null;

  const exec = () => {
    const rows = db[tableName];
    if (op === "select") {
      let matched = rows.filter((r) => filters.every((f) => f(r)));
      if (orderBy) {
        const { col, asc } = orderBy;
        matched = [...matched].sort((a, b) => {
          const av = String(a[col] ?? "");
          const bv = String(b[col] ?? "");
          return asc ? av.localeCompare(bv) : bv.localeCompare(av);
        });
      }
      if (limitN !== null) matched = matched.slice(0, limitN);
      return { data: matched.map((r) => ({ ...r })), error: null };
    }

    if (op === "insert") {
      const items = Array.isArray(payload) ? payload : [payload];
      const inserted = items.map((item, idx) => {
        const created = {
          id: item.id || `${tableName}-${rows.length + idx + 1}`,
          created_at: item.created_at || new Date().toISOString(),
          updated_at: item.updated_at || new Date().toISOString(),
          ...item,
        };
        rows.push(created);
        return { ...created };
      });
      return { data: inserted, error: null };
    }

    if (op === "upsert") {
      const items = Array.isArray(payload) ? payload : [payload];
      const cols = conflictCols
        .split(",")
        .map((c) => c.trim())
        .filter(Boolean);
      const out: Row[] = [];
      for (const item of items) {
        const idx =
          cols.length > 0
            ? rows.findIndex((r) => cols.every((c) => String(r[c] ?? "") === String(item[c] ?? "")))
            : -1;
        if (idx >= 0) {
          rows[idx] = { ...rows[idx], ...item };
          out.push({ ...rows[idx] });
        } else {
          const created = {
            id: item.id || `${tableName}-${rows.length + 1}`,
            created_at: item.created_at || new Date().toISOString(),
            ...item,
          };
          rows.push(created);
          out.push({ ...created });
        }
      }
      return { data: out, error: null };
    }

    if (op === "update") {
      const updated: Row[] = [];
      for (let i = 0; i < rows.length; i++) {
        if (filters.every((f) => f(rows[i]))) {
          rows[i] = { ...rows[i], ...payload };
          updated.push({ ...rows[i] });
        }
      }
      return { data: updated, error: null };
    }

    if (op === "delete") {
      const removed: Row[] = [];
      for (let i = rows.length - 1; i >= 0; i--) {
        if (filters.every((f) => f(rows[i]))) {
          removed.push(rows[i]);
          rows.splice(i, 1);
        }
      }
      return { data: removed, error: null };
    }

    return { data: [], error: null };
  };

  const b: any = {
    select: () => {
      if (op === "select") op = "select";
      return b;
    },
    insert: (data: any) => {
      op = "insert";
      payload = data;
      return b;
    },
    upsert: (data: any, opts?: { onConflict?: string }) => {
      op = "upsert";
      payload = data;
      conflictCols = opts?.onConflict || "";
      return b;
    },
    update: (data: any) => {
      op = "update";
      payload = data;
      return b;
    },
    delete: () => {
      op = "delete";
      return b;
    },
    eq: (col: string, val: any) => {
      filters.push((r) => r[col] === val);
      return b;
    },
    in: (col: string, vals: any[]) => {
      filters.push((r) => vals.includes(r[col]));
      return b;
    },
    lte: (col: string, val: string) => {
      filters.push((r) => String(r[col] ?? "") <= String(val));
      return b;
    },
    gte: (col: string, val: string) => {
      filters.push((r) => String(r[col] ?? "") >= String(val));
      return b;
    },
    lt: (col: string, val: string) => {
      filters.push((r) => Boolean(r[col]) && String(r[col]) < String(val));
      return b;
    },
    order: (col: string, opts?: { ascending?: boolean }) => {
      orderBy = { col, asc: opts?.ascending !== false };
      return b;
    },
    limit: (n: number) => {
      limitN = n;
      return b;
    },
    single: async () => {
      const res = exec();
      return { data: res.data[0] || null, error: res.data[0] ? null : { message: "Not found" } };
    },
    maybeSingle: async () => {
      const res = exec();
      return { data: res.data[0] || null, error: null };
    },
    then: (resolve: any, reject: any) => Promise.resolve(exec()).then(resolve, reject),
  };
  return b;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: {
    from: (table: keyof typeof db) => makeBuilder(table),
  },
}));

vi.mock("@/lib/evolution", () => ({
  evolution: {
    getStatus: mocks.getStatus,
    sendTextMessage: mocks.sendTextMessage,
    sendMedia: mocks.sendMedia,
    sendSticker: mocks.sendSticker,
    sendPoll: mocks.sendPoll,
    sendStatus: mocks.sendStatus,
    sendPresence: mocks.sendPresence,
    markMessageAsRead: mocks.markMessageAsRead,
    sendReaction: mocks.sendReaction,
    sendContact: mocks.sendContact,
    acceptGroupInvite: mocks.acceptGroupInvite,
    getGroupInviteInfo: mocks.getGroupInviteInfo,
    findProxy: mocks.findProxy,
    fetchInstances: mocks.fetchInstances,
  },
}));

vi.mock("@/lib/saas-limits", () => ({
  checkTenantAiQuota: mocks.checkTenantAiQuota,
  isClientActiveCached: mocks.isClientActiveCached,
}));

vi.mock("@/lib/ai-provider", () => ({
  generateText: mocks.generateText,
}));

vi.mock("@/lib/ai-keys", () => ({
  getAiKeys: mocks.getAiKeys,
}));

import {
  resetPhoneMemoryRuntimeForTests,
  reconcileWarmupIdentityByPhone,
  markPhoneDisconnected,
  savePhoneMemoryFromConfig,
} from "../warmup-phone-memory";
import {
  ensureWarmupConfigsForTenant,
  readTenantConnections,
} from "../warmup-config-service";
import {
  evaluateDailyAutoProgress,
  executeWarmupTurn,
  generateWarmupMessage,
  getCircadianHourlyCap,
  handleInstanceFailure,
  handleWebhookConnectionClosed,
  resetDisconnectAlertCooldownForTests,
  runIsolatedStatusPost,
} from "../warmup-engine";
import {
  effectiveTargetWithContext,
  resetWarmupWorkerRuntimeState,
  selectAsymmetricWarmupPairs,
  tickWarmupWorker,
  triggerSymbioticWarmupPulse,
} from "../warmup-worker";
import {
  createDynamicWarmupImage,
  createDynamicWarmupSticker,
  pickCasualWarmupPoll,
} from "../warmup-media";
import { pickVariedFallbackTurnText, resolveWarmupSpintax } from "../warmup-dialogues";
import {
  analyzeChipClusterHealth,
  buildClusterVcfContent,
  isWarmupGroupDead,
  processIncomingGroupMessage,
  resetGroupReceiveBufferForTests,
  syncGroupMembershipForChips,
} from "../warmup-groups";

function makeWarmupConfig(overrides: Partial<WarmupConfig> = {}): WarmupConfig {
  const nowIso = new Date().toISOString();
  return {
    client_id: "tenant-auto",
    instance_name: "chip-1",
    phone_number: "5511961607625",
    enabled: true,
    stage: 2,
    stage_auto_progress: true,
    days_active: 5,
    consecutive_successful_days: 3,
    health_score: 100,
    is_quarantined: false,
    purpose: "inbound",
    daily_target: 25,
    sent_today: 0,
    received_today: 0,
    error_count_today: 0,
    min_interval_seconds: 120,
    max_interval_seconds: 240,
    min_typing_seconds: 1,
    max_typing_seconds: 1,
    allowed_start_hour: 0,
    allowed_end_hour: 24,
    ai_model: "fallback",
    ai_theme: "dia_a_dia",
    enable_typing: false,
    enable_blue_ticks: false,
    enable_reactions: false,
    enable_audio: false,
    enable_vcard: false,
    enable_status_posts: true,
    continuous_warmup: true,
    profile_hydrated: true,
    last_activity_at: nowIso,
    ...overrides,
  };
}

describe("Aquecedor Autônomo 2026 — Passaporte por Telefone, Anti-Ban e Escala N-Chips", () => {
  beforeEach(() => {
    db.channel_connections.length = 0;
    db.whatsapp_warmup_configs.length = 0;
    db.whatsapp_warmup_conversations.length = 0;
    db.whatsapp_warmup_logs.length = 0;
    db.whatsapp_warmup_groups.length = 0;
    db.whatsapp_warmup_group_members.length = 0;
    db.campaigns.length = 0;
    db.app_settings.length = 0;
    db.webhook_logs.length = 0;
    db.agent_settings.length = 0;

    resetPhoneMemoryRuntimeForTests();
    resetDisconnectAlertCooldownForTests();
    resetWarmupWorkerRuntimeState();
    resetGroupReceiveBufferForTests();

    mocks.getStatus.mockReset().mockResolvedValue({ state: "close", data: {} });
    mocks.sendTextMessage.mockReset().mockResolvedValue({ key: { id: "msg-txt-1" } });
    mocks.sendMedia.mockReset().mockResolvedValue({ key: { id: "msg-med-1" } });
    mocks.sendSticker.mockReset().mockResolvedValue({ key: { id: "msg-stk-1" } });
    mocks.sendPoll.mockReset().mockResolvedValue({ key: { id: "msg-pol-1" } });
    mocks.sendStatus.mockReset().mockResolvedValue({ key: { id: "msg-st-1" } });
    mocks.sendPresence.mockReset().mockResolvedValue(true);
    mocks.markMessageAsRead.mockReset().mockResolvedValue(true);
    mocks.sendReaction.mockReset().mockResolvedValue(true);
    mocks.sendContact.mockReset().mockResolvedValue({ key: { id: "msg-vc-1" } });
    mocks.acceptGroupInvite.mockReset().mockResolvedValue({ success: true, groupJid: "120363001@g.us" });
    mocks.getGroupInviteInfo.mockReset().mockResolvedValue({ id: "120363001@g.us", subject: "Grupo", size: 50 });
    mocks.findProxy.mockReset().mockResolvedValue(null);
    mocks.fetchInstances.mockReset().mockResolvedValue([]);
    mocks.checkTenantAiQuota.mockReset().mockResolvedValue({ allowed: true });
    mocks.generateText.mockReset().mockResolvedValue({ text: "E aí beleza?", provider: "openrouter", modelUsed: "free" });
    mocks.getAiKeys.mockReset().mockResolvedValue({ gemini: "", openrouter: "or-key", openrouterKeys: ["or-key"], nvidia: "" });
    mocks.isClientActiveCached.mockReset().mockResolvedValue(true);
  });

  it("1. Passaporte por telefone restaura estágio/dias em novo instance_name e ativa Retomada Suave pós >=48h offline", async () => {
    const clientId = "tenant-passport";
    const createdTenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();

    db.channel_connections.push({
      client_id: clientId,
      instance_name: "instancia_antiga",
      status: "open",
      provider_config: { owner_phone: "5511961607625" },
    });

    await ensureWarmupConfigsForTenant(clientId);
    // Simula evolução orgânica feita pelo worker/motor no banco e gravada no passaporte
    db.whatsapp_warmup_configs[0] = {
      ...db.whatsapp_warmup_configs[0],
      phone_number: "5511961607625",
      stage: 3,
      days_active: 10,
      consecutive_successful_days: 7,
      purpose: "outbound",
      daily_target: 50,
      vcard_exchanged_peers: ["chip_parceiro_x"],
      created_at: createdTenDaysAgo,
    };
    await savePhoneMemoryFromConfig(clientId, db.whatsapp_warmup_configs[0] as WarmupConfig);

    // Simula queda há 3 dias (>= 48h) e exclusão da instância antiga antes de criar com OUTRO nome + variante sem 9º dígito
    const threeDaysAgo = Date.now() - 72 * 60 * 60 * 1000;
    markPhoneDisconnected(clientId, "instancia_antiga", "401 loggedOut", threeDaysAgo);
    await new Promise((r) => setTimeout(r, 25));

    db.channel_connections.length = 0;
    db.whatsapp_warmup_configs.length = 0;

    // 1A) ensureWarmupConfigsForTenant já restaura automaticamente o passaporte quando owner_phone existe na conexão
    db.channel_connections.push({
      client_id: clientId,
      instance_name: "nova_instancia_reciclada",
      status: "open",
      provider_config: { owner_phone: "551161607625" },
    });

    const ensured = await ensureWarmupConfigsForTenant(clientId);
    expect(ensured.created).toContain("nova_instancia_reciclada");
    expect(db.whatsapp_warmup_configs[0].stage).toBe(3);
    expect(db.whatsapp_warmup_configs[0].days_active).toBe(10);
    expect(db.whatsapp_warmup_configs[0].purpose).toBe("outbound");
    expect(db.whatsapp_warmup_configs[0].vcard_exchanged_peers).toContain("chip_parceiro_x");
    expect(db.whatsapp_warmup_configs[0].created_at).toBe(createdTenDaysAgo);

    // 1B) Mesmo quando a linha foi criada crua sem telefone e o número só é descoberto no webhook posterior,
    // reconcileWarmupIdentityByPhone promove estágio/dias e marca softRecovery=true
    db.whatsapp_warmup_configs.push(
      makeWarmupConfig({
        client_id: clientId,
        instance_name: "instancia_webhook_tardio",
        phone_number: null,
        stage: 1,
        days_active: 1,
        purpose: "contingency",
        sent_today: 0,
      })
    );
    const reconciled = await reconcileWarmupIdentityByPhone({
      clientId,
      instanceName: "instancia_webhook_tardio",
      phone: "5511961607625",
    });

    expect(reconciled.restored).toBe(true);
    expect(reconciled.softRecovery).toBe(true);
    expect(reconciled.stage).toBe(3);
    expect(reconciled.daysActive).toBe(10);

    const lateRow = db.whatsapp_warmup_configs.find((r) => r.instance_name === "instancia_webhook_tardio") as WarmupConfig;
    expect(lateRow.stage).toBe(3);
    expect(lateRow.days_active).toBe(10);
    expect(lateRow.purpose).toBe("outbound");
    expect(lateRow.vcard_exchanged_peers).toContain("chip_parceiro_x");
    expect(lateRow.created_at).toBe(createdTenDaysAgo);

    // Durante 24h de Retomada Suave, o teto diário efetivo cai pela metade
    const normalCap = effectiveTargetWithContext(lateRow, new Date("2026-11-25T14:00:00Z"), false);
    const softCap = effectiveTargetWithContext(lateRow, new Date("2026-11-25T14:00:00Z"), true);
    expect(softCap).toBeLessThanOrEqual(Math.ceil(normalCap * 0.5));
  });

  it("2. Auto-cura em readTenantConnections recupera instância marcada como close que já voltou open na Evolution", async () => {
    const clientId = "tenant-heal";
    db.channel_connections.push({
      client_id: clientId,
      instance_name: "chip-oscilante",
      status: "close",
      provider: "evolution",
      provider_config: {},
    });

    mocks.getStatus.mockResolvedValueOnce({
      state: "open",
      data: { instance: { owner: "557391810230@s.whatsapp.net" } },
    });

    const conns = await readTenantConnections(clientId);
    expect(conns).toHaveLength(1);
    expect(conns[0].status).toBe("open");
    expect(conns[0].phone_number).toBe("557391810230");
    expect(db.channel_connections[0].status).toBe("open");
  });

  it("3. Status desacoplado, erro transitório não zera streak, 428 não dá falso-ban e 401 dá quarentena no 1º golpe", async () => {
    const clientId = "tenant-bugs";
    const chipA = makeWarmupConfig({
      client_id: clientId,
      instance_name: "chip-a",
      phone_number: "5511961607625",
      consecutive_successful_days: 4,
      error_count_today: 0,
      last_status_post_at: null,
    });
    const chipB = makeWarmupConfig({
      client_id: clientId,
      instance_name: "chip-b",
      phone_number: "557391810230",
    });
    db.whatsapp_warmup_configs.push({ ...chipA }, { ...chipB });

    // A) Turno automático NUNCA chama sendStatus inline
    const conv: WarmupConversation = {
      id: "conv-no-status",
      client_id: clientId,
      instance_a: "chip-a",
      instance_b: "chip-b",
      topic: "dia_a_dia",
      history: [{ sender: "chip-b", text: "opa", sent_at: new Date().toISOString(), message_id: "prev-1" }],
      turn_count: 1,
      max_turns: 4,
      status: "active",
      next_turn_at: new Date().toISOString(),
    };
    const origRand = Math.random;
    Math.random = () => 0.99; // força turno texto
    await executeWarmupTurn({
      clientId,
      senderConfig: chipA,
      receiverConfig: chipB,
      conversation: conv,
      isManualTrigger: false,
    });
    Math.random = origRand;
    expect(mocks.sendStatus).not.toHaveBeenCalled();

    // B) Rotina isolada só grava last_status_post_at quando sendStatus retorna verdadeiramente
    mocks.sendStatus.mockResolvedValueOnce(null);
    const stFail = await runIsolatedStatusPost({ clientId, senderConfig: chipA });
    expect(stFail.posted).toBe(false);
    expect(db.whatsapp_warmup_configs[0].last_status_post_at).toBeNull();

    mocks.sendStatus.mockResolvedValueOnce({ key: { id: "st-ok-1" } });
    const stOk = await runIsolatedStatusPost({ clientId, senderConfig: chipA });
    expect(stOk.posted).toBe(true);
    expect(db.whatsapp_warmup_configs[0].last_status_post_at).toBeTruthy();

    // C) Timeout transitório da Evolution reduz só 5 pts de saúde e NÃO incrementa error_count_today
    await handleInstanceFailure(clientId, db.whatsapp_warmup_configs[0] as WarmupConfig, "signal is aborted due to timeout", {
      isTransientInfra: true,
    });
    expect(db.whatsapp_warmup_configs[0].error_count_today).toBe(0);
    expect(db.whatsapp_warmup_configs[0].is_quarantined).toBe(false);

    // D1) Queda transitória 428 (connectionClosed) NÃO é ban: nunca dá quarentena nem pausa campanha
    db.campaigns.push({ client_id: clientId, instance_name: "chip-a", status: "running" });
    const transientRes = await handleWebhookConnectionClosed({
      clientId,
      instanceName: "chip-a",
      statusReason: 428,
    });
    expect(transientRes.severe).toBe(false);
    expect(transientRes.pausedCampaigns).toBe(0);
    expect(db.whatsapp_warmup_configs[0].is_quarantined).toBe(false);
    expect(db.campaigns[0].status).toBe("running");

    // D2) Erro severo 401 no webhook coloca em quarentena imediata no 1º strike e pausa campanha
    const closedRes = await handleWebhookConnectionClosed({
      clientId,
      instanceName: "chip-a",
      statusReason: 401,
    });
    expect(closedRes.severe).toBe(true);
    expect(closedRes.pausedCampaigns).toBe(1);
    expect(db.whatsapp_warmup_configs[0].is_quarantined).toBe(true);
    expect(db.campaigns[0].status).toBe("paused");
  });

  it("4. evaluateDailyAutoProgress congela days_active em dias offline e retoma +1 após hiato", () => {
    const idleCfg = makeWarmupConfig({
      stage: 1,
      days_active: 2,
      created_at: "2026-11-01T12:00:00Z",
      last_activity_at: "2026-11-09T12:00:00Z",
      sent_today: 0,
      received_today: 0,
      consecutive_successful_days: 2,
    });
    const offlineDay = evaluateDailyAutoProgress(idleCfg, "2026-11-10T12:00:00Z", "2026-11-09");
    expect(offlineDay.newDaysActive).toBe(2); // NÃO conta dia sem tráfego
    expect(offlineDay.stagePromoted).toBe(false);

    const returningAfterGap = makeWarmupConfig({
      stage: 1,
      days_active: 2,
      created_at: "2026-11-01T12:00:00Z",
      last_activity_at: "2026-11-05T12:00:00Z", // hiato >= 48h
      sent_today: 5,
      received_today: 3,
      consecutive_successful_days: 1,
    });
    const gapReturn = evaluateDailyAutoProgress(returningAfterGap, "2026-11-10T12:00:00Z", "2026-11-09");
    expect(gapReturn.newDaysActive).toBe(3); // avança apenas +1 dia real ao voltar, sem pular pro dia 10
  });

  it("5. Escudo Simbiótico nunca seleciona par em quarentena e dispara turno único assíncrono não-manual", async () => {
    const clientId = "tenant-symbiotic";
    const futureIso = new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString();

    db.channel_connections.push(
      { client_id: clientId, instance_name: "cold-prospector", status: "open", provider_config: { owner_phone: "5511961607625" } },
      { client_id: clientId, instance_name: "peer-quarantined", status: "open", provider_config: { owner_phone: "557391810230" } }
    );
    db.whatsapp_warmup_configs.push(
      makeWarmupConfig({ client_id: clientId, instance_name: "cold-prospector", phone_number: "5511961607625", is_quarantined: false }),
      makeWarmupConfig({
        client_id: clientId,
        instance_name: "peer-quarantined",
        phone_number: "557391810230",
        is_quarantined: true,
        quarantine_until: futureIso,
      })
    );

    const blocked = await triggerSymbioticWarmupPulse(clientId, "cold-prospector");
    expect(blocked.triggered).toBe(false);
    expect(blocked.reason).toBe("no_peer_available");
    expect(mocks.sendTextMessage).not.toHaveBeenCalled();

    // Quando existe par saudável, envia 1 único turno assíncrono (não dispara rajada mútua de 2 mensagens na hora)
    db.whatsapp_warmup_configs[1].is_quarantined = false;
    db.whatsapp_warmup_configs[1].quarantine_until = null;
    const origRand = Math.random;
    Math.random = () => 0.99;
    const ok = await triggerSymbioticWarmupPulse(clientId, "cold-prospector", Date.now() + 60_000);
    Math.random = origRand;

    expect(ok.triggered).toBe(true);
    expect(ok.peerInstance).toBe("peer-quarantined");
    expect(mocks.sendTextMessage).toHaveBeenCalledTimes(1);
    expect(db.whatsapp_warmup_conversations).toHaveLength(1);
  });

  it("6. Mídia única por hash (PNG + WebP VP8L + Poll), Spintax por horário BRT, coerência e curva circadiana", () => {
    const img1 = createDynamicWarmupImage("chipA");
    const img2 = createDynamicWarmupImage("chipA");
    expect(img1.sha256).not.toBe(img2.sha256);
    const pngBytes = Buffer.from(img1.base64, "base64");
    expect(Array.from(pngBytes.subarray(0, 4))).toEqual([137, 80, 78, 71]);

    const stk1 = createDynamicWarmupSticker("chipA");
    const stk2 = createDynamicWarmupSticker("chipA");
    expect(stk1.sha256).not.toBe(stk2.sha256);
    const webpBytes = Buffer.from(stk1.base64, "base64");
    expect(webpBytes.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(webpBytes.subarray(8, 12).toString("ascii")).toBe("WEBP");
    expect(webpBytes.subarray(12, 16).toString("ascii")).toBe("VP8L");

    const poll = pickCasualWarmupPoll("seed");
    expect(poll.values.length).toBeGreaterThanOrEqual(2);

    // Spintax + horário Brasília
    const morning = resolveWarmupSpintax("{saudacao} {mano|cara}", new Date("2026-11-25T12:00:00Z")); // 09h BRT
    expect(morning.toLowerCase()).toContain("bom dia");
    const night = resolveWarmupSpintax("{saudacao} {mano|cara}", new Date("2026-11-25T23:30:00Z")); // 20:30 BRT
    expect(night.toLowerCase()).toContain("boa noite");

    // Coerência travada por conversationId
    const t0 = pickVariedFallbackTurnText({ theme: "trabalho", stepIndex: 0, conversationId: "thread-xyz-1" });
    const t1 = pickVariedFallbackTurnText({ theme: "trabalho", stepIndex: 1, usedTexts: [t0], conversationId: "thread-xyz-1" });
    expect(t0).toBeTruthy();
    expect(t1).toBeTruthy();
    expect(t0).not.toBe(t1);

    // Curva circadiana + fim de semana
    const cfg = makeWarmupConfig({ stage: 4, daily_target: 70 });
    const peakWed = getCircadianHourlyCap(cfg, 70, new Date("2026-11-25T18:00:00Z")); // Qua 15h BRT
    const lateWed = getCircadianHourlyCap(cfg, 70, new Date("2026-11-25T23:30:00Z")); // Qua 20:30 BRT
    const sunAfternoon = getCircadianHourlyCap(cfg, 70, new Date("2026-11-29T18:00:00Z")); // Dom 15h BRT
    expect(peakWed).toBeGreaterThan(lateWed);
    expect(peakWed).toBeGreaterThan(sunAfternoon);
  });

  it("7. Auto-Free IA respeita cota do tenant e escala perfeitamente com 20 chips simultâneos em pares disjuntos", async () => {
    const clientId = "tenant-swarm-20";
    mocks.checkTenantAiQuota.mockResolvedValueOnce({ allowed: false });

    const quotaBlockedMsg = await generateWarmupMessage({
      theme: "dia_a_dia",
      speakerRole: "A",
      history: [],
      aiModel: "auto:free",
      clientId,
      conversationId: "conv-q",
    });
    expect(quotaBlockedMsg.provider).toBe("native_fallback");
    expect(mocks.generateText).not.toHaveBeenCalled();

    // Cluster com 20 chips conectados e ociosos -> forma 10 pares disjuntos no mesmo tick
    const chips: WarmupConfig[] = [];
    for (let i = 1; i <= 20; i++) {
      const name = `chip_${String(i).padStart(2, "0")}`;
      const phone = `551198888${String(1000 + i)}`;
      db.channel_connections.push({
        client_id: clientId,
        instance_name: name,
        status: "open",
        provider_config: { owner_phone: phone },
      });
      const c = makeWarmupConfig({
        client_id: clientId,
        instance_name: name,
        phone_number: phone,
        stage: i % 2 === 0 ? 3 : 2,
        days_active: 8,
        enable_status_posts: false,
      });
      db.whatsapp_warmup_configs.push(c);
      chips.push(c);
    }

    const pairs = selectAsymmetricWarmupPairs(chips, new Set(), 10);
    expect(pairs).toHaveLength(10);
    const uniqueNames = new Set(pairs.flatMap((p) => [p.initiator.instance_name, p.partner.instance_name]));
    expect(uniqueNames.size).toBe(20);

    const origRand = Math.random;
    Math.random = () => 0.99;
    const tickRes = await tickWarmupWorker();
    Math.random = origRand;

    expect(tickRes.processedTenants).toBe(1);
    expect(tickRes.exchangesCount).toBe(10);
    expect(mocks.sendTextMessage).toHaveBeenCalledTimes(10);
  });

  it("8. Grupos respeitam carência de 72h, radar detecta colisão/datacenter/flapping e gera .vcf válido", async () => {
    const clientId = "tenant-groups-net";
    const groupJid = "1203637777@g.us";
    db.whatsapp_warmup_groups.push({
      id: "grp-grace",
      client_id: clientId,
      group_jid: groupJid,
      invite_code: "GRACE123456789",
      status: "active",
      total_messages_received: 5,
      total_reactions_sent: 1,
    });
    // Chip recém-entrou no grupo há 12 horas -> deve APENAS ler passivamente, ZERO reação!
    db.whatsapp_warmup_group_members.push({
      client_id: clientId,
      group_id: "grp-grace",
      instance_name: "chip-new-in-group",
      status: "joined",
      joined_at: new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString(),
    });

    const origRand = Math.random;
    Math.random = () => 0.01;
    const passiveRes = await processIncomingGroupMessage({
      clientId,
      instanceName: "chip-new-in-group",
      groupJid,
      messageId: "m-grace-1",
      messageText: "Bom dia grupo!",
    });
    Math.random = origRand;
    expect(passiveRes).toEqual({ handled: true, action: "read_passive" });

    // Após 80h de grupo, passa a reagir normalmente
    db.whatsapp_warmup_group_members[0].joined_at = new Date(Date.now() - 80 * 60 * 60 * 1000).toISOString();
    Math.random = () => 0.01;
    const reactRes = await processIncomingGroupMessage({
      clientId,
      instanceName: "chip-new-in-group",
      groupJid,
      messageId: "m-grace-2",
      messageText: "Bom dia grupo!",
    });
    Math.random = origRand;
    expect(reactRes.action).toBe("reacted");

    // Grupo silencioso há > 72h sinalizado como morto
    expect(
      isWarmupGroupDead({
        status: "active",
        last_activity_at: new Date(Date.now() - 80 * 60 * 60 * 1000).toISOString(),
        created_at: new Date(Date.now() - 120 * 60 * 60 * 1000).toISOString(),
        total_messages_received: 4,
      })
    ).toBe(true);

    // Sync respeita teto máximo de 6 entradas por rodada mesmo com vários chips e grupos
    for (let i = 1; i <= 5; i++) {
      db.whatsapp_warmup_configs.push(makeWarmupConfig({ client_id: clientId, instance_name: `joiner-${i}`, group_auto_join: true }));
    }
    for (let g = 1; g <= 3; g++) {
      db.whatsapp_warmup_groups.push({
        id: `grp-batch-${g}`,
        client_id: clientId,
        invite_code: `CODEBATCH${g}123456`,
        status: "pending",
      });
    }
    const syncRes = await syncGroupMembershipForChips(clientId);
    expect(syncRes.joinedCount).toBe(6);

    // Radar de Rede / Proxy / Flaps (> 8 quedas em 24h + IP compartilhado + datacenter estrangeiro)
    for (let k = 0; k < 10; k++) {
      markPhoneDisconnected(clientId, "chip-risco", "connection close", Date.now() - k * 60_000);
    }
    const proxyByInstance = new Map([
      ["chip-risco", { enabled: true, host: "23.129.254.193" }],
      ["chip-irma", { enabled: true, host: "23.129.254.193" }],
    ]);
    const proxyIntelByHost = new Map([
      ["23.129.254.193", { countryCode: "US", country: "United States", hosting: true, isp: "Webhosting Holdings", checkedAt: Date.now() }],
    ]);
    const netHealth = analyzeChipClusterHealth({
      clientId,
      instanceName: "chip-risco",
      config: makeWarmupConfig({ client_id: clientId, instance_name: "chip-risco" }),
      proxyByInstance,
      proxyIntelByHost,
    });
    expect(netHealth.flaps24h).toBe(10);
    expect(netHealth.sharedProxyPeers).toEqual(["chip-irma"]);
    expect(netHealth.proxyHosting).toBe(true);
    expect(netHealth.proxyForeign).toBe(true);
    expect(netHealth.warnings.length).toBeGreaterThanOrEqual(4);

    // Exportador .vcf
    const vcf = buildClusterVcfContent([
      { instanceName: "chip-1", phoneNumber: "5511961607625" },
      { instanceName: "chip-2", phoneNumber: "557391810230" },
    ]);
    expect(vcf).toContain("BEGIN:VCARD");
    expect(vcf).toContain("TEL;TYPE=CELL:+5511961607625");
  });
});
