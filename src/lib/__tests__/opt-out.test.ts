import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, any>;

const tables = vi.hoisted(() => ({
  leads_extraidos: [] as Row[],
  campaign_targets: [] as Row[],
  followup_targets: [] as Row[],
  sessions: [] as Row[],
}));

function buildQuery(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  let updateData: Row | null = null;

  const chain: any = {
    select() {
      return chain;
    },
    update(patch: Row) {
      updateData = patch;
      return chain;
    },
    eq(col: string, val: any) {
      filters.push((row) => row[col] === val);
      return chain;
    },
    in(col: string, vals: any[]) {
      filters.push((row) => vals.includes(row[col]));
      return chain;
    },
    then(resolve: any) {
      const list = ((tables as any)[table] || []).filter((r: Row) => filters.every((f) => f(r)));
      if (updateData) {
        for (const r of list) Object.assign(r, updateData);
      }
      return Promise.resolve({ data: list, error: null }).then(resolve);
    },
  };
  return chain;
}

vi.mock("@/lib/supabase_admin", () => ({
  supabaseAdmin: { from: (t: string) => buildQuery(t) },
}));

import { isExplicitOptOutRequest } from "../agent-guards";
import { handleIncomingOptOutIfDetected, isLeadOptedOut } from "../opt-out";

describe("Auto Opt-Out Guard (Anti-Denúncia + LGPD)", () => {
  beforeEach(() => {
    tables.leads_extraidos.length = 0;
    tables.campaign_targets.length = 0;
    tables.followup_targets.length = 0;
    tables.sessions.length = 0;
  });

  it("identifica pedidos explícitos de saída sem gerar falso positivo em objeções brandas", () => {
    expect(isExplicitOptOutRequest("Pare de mandar mensagem por favor")).toBe(true);
    expect(isExplicitOptOutRequest("Tira meu número da sua lista")).toBe(true);
    expect(isExplicitOptOutRequest("Não me mande mais nada, vou bloquear")).toBe(true);
    expect(isExplicitOptOutRequest("Quero descadastrar")).toBe(true);

    // Objeções normais/brandas NÃO devem queimar o lead permanentemente
    expect(isExplicitOptOutRequest("Bom dia, agora não consigo falar")).toBe(false);
    expect(isExplicitOptOutRequest("Ainda não temos site, quanto custa?")).toBe(false);
    expect(isExplicitOptOutRequest("Oi, tudo bem")).toBe(false);
  });

  it("marca opt_out = true no lead e cancela targets pendentes em campanhas e follow-ups", async () => {
    const clientId = "00000000-0000-0000-0000-00000000a001";
    const remoteJid = "5511999998888@s.whatsapp.net";

    tables.leads_extraidos.push({
      id: 42,
      client_id: clientId,
      remoteJid,
      opt_out: false,
    });
    tables.campaign_targets.push({
      id: "ct-1",
      client_id: clientId,
      remote_jid: remoteJid,
      status: "pending",
    });
    tables.followup_targets.push({
      id: "ft-1",
      client_id: clientId,
      remote_jid: remoteJid,
      status: "waiting",
    });
    tables.sessions.push({
      id: "sess-1",
      client_id: clientId,
      bot_status: "bot_active",
      paused_by: null,
      resume_at: "2026-12-01T00:00:00Z",
    });

    const detected = await handleIncomingOptOutIfDetected({
      clientId,
      remoteJid,
      messageText: "Por favor, pare de enviar mensagens aqui!",
      sessionId: "sess-1",
    });

    expect(detected).toBe(true);
    expect(tables.leads_extraidos[0].opt_out).toBe(true);
    expect(tables.campaign_targets[0].status).toBe("skipped");
    expect(tables.followup_targets[0].status).toBe("skipped");
    expect(tables.sessions[0].bot_status).toBe("bot_paused");
    expect(tables.sessions[0].paused_by).toBe("opt_out");
    expect(tables.sessions[0].resume_at).toBeNull();
    expect(await isLeadOptedOut(clientId, "551199998888@s.whatsapp.net")).toBe(true);
  });
});

