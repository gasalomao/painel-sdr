// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), send: vi.fn(), rows: [] as unknown[], render: vi.fn((text: string) => text), feedback: vi.fn(async () => ({ triggered: false, cleared: false, recentErrors: 0 })) }));
vi.mock("@/lib/supabase_admin", () => ({ supabaseAdmin: { rpc: state.rpc, from: state.from } }));
vi.mock("@/lib/evolution", () => ({ getEvolutionConfig: async () => ({ url: "https://provider.example.test", apiKey: "fixture-only" }) }));
vi.mock("@/lib/template-vars", () => ({ renderTemplate: state.render }));
vi.mock("@/lib/warmup/warmup-engine", () => ({ recordWebhookDeliveryFeedback: state.feedback }));
import { runFollowUpWorker } from "@/workers/agent-followup-worker";
const row = { id: 1, client_id: "11111111-1111-4111-8111-111111111111", agent_id: 1, session_id: 1, remote_jid: "5511999990000@s.whatsapp.net", instance_name: "fixture", current_step: 1, max_step: 4, claim_id: "22222222-2222-4222-8222-222222222222", initial_sent_at: "2026-10-11T00:00:00Z" };
beforeEach(() => {
  state.render.mockClear();
  state.feedback.mockClear();
  vi.stubEnv("AGENT_FOLLOWUP_WORKER_ENABLED", "true");
  state.rows = [row];
  state.rpc.mockImplementation(async (name, args) => {
    if (name === "claim_agent_followup") { const next = state.rows.shift(); return { data: next ? [{ ...next as object, claim_id: args.p_claim }] : [], error: null }; }
    if (name === "prepare_agent_followup") return { data: { action: "send", followup: row }, error: null };
    return { data: row, error: null };
  });
  const config = { enabled: true, follow_up_1h_enabled: true, follow_up_1h_template: "Fixture message", follow_up_4h_enabled: true, follow_up_4h_template: "second", follow_up_24h_enabled: true, follow_up_24h_template: "third", follow_up_48h_enabled: true, follow_up_48h_template: "last" };
  state.from.mockImplementation((table: string) => {
    const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: table === "agent_settings" ? { options: { follow_up: config } } : null, error: null }) };
    return chain;
  });
  vi.stubGlobal("fetch", state.send);
  state.send.mockResolvedValue(Response.json({ key: { id: "provider-fixture" } }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
describe("claimed agent followup worker", () => {
  it("does nothing until explicitly enabled", async () => {
    vi.stubEnv("AGENT_FOLLOWUP_WORKER_ENABLED", "false");
    await runFollowUpWorker();
    expect(state.rpc).not.toHaveBeenCalled(); expect(state.send).not.toHaveBeenCalled();
  });
  it("requires durable preparation before one external send and finalizes the provider ID", async () => {
    await runFollowUpWorker();
    expect(state.send).toHaveBeenCalledOnce();
    expect(String(state.send.mock.calls[0][0])).toBe("https://provider.example.test/message/sendText/fixture");
    expect(JSON.parse(state.send.mock.calls[0][1].body)).toEqual({ number: row.remote_jid, text: "Fixture message" });
    expect(state.rpc).toHaveBeenCalledWith("prepare_agent_followup", expect.objectContaining({ p_client: row.client_id, p_agent: 1, p_step: 1, p_content: "Fixture message", p_attempt: expect.any(String) }));
    expect(state.rpc).toHaveBeenCalledWith("finish_agent_followup", expect.objectContaining({ p_provider_id: "provider-fixture", p_client: row.client_id }));
    expect(state.rpc.mock.invocationCallOrder[state.rpc.mock.calls.findIndex(([name]) => name === "prepare_agent_followup")]).toBeLessThan(state.send.mock.invocationCallOrder[0]);
  });
  it.each(["cancelled", "skipped"])("does not send when preparation returns %s", async action => {
    const original = state.rpc.getMockImplementation()!;
    state.rpc.mockImplementation((name, args) => name === "prepare_agent_followup" ? Promise.resolve({ data: { action }, error: null }) : original(name, args));
    await runFollowUpWorker(); expect(state.send).not.toHaveBeenCalled();
  });
  it("does not send on a database preparation error", async () => {
    const original = state.rpc.getMockImplementation()!;
    state.rpc.mockImplementation((name, args) => name === "prepare_agent_followup" ? Promise.resolve({ data: null, error: { message: "private-secret" } }) : original(name, args));
    await runFollowUpWorker(); expect(state.send).not.toHaveBeenCalled();
  });
  it.each(["timeout", "no-id", "finalize-failure"])("blocks replay for %s after intent", async failure => {
    if (failure === "timeout") state.send.mockRejectedValue(new Error("private-secret"));
    if (failure === "no-id") state.send.mockResolvedValue(Response.json({}));
    if (failure === "finalize-failure") {
      const original = state.rpc.getMockImplementation()!;
      state.rpc.mockImplementation((name, args) => name === "finish_agent_followup" ? Promise.resolve({ data: null, error: { message: "private-secret" } }) : original(name, args));
    }
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runFollowUpWorker();
    expect(state.send).toHaveBeenCalledOnce();
    expect(state.rpc).toHaveBeenCalledWith("release_agent_followup", expect.objectContaining({ p_status: "ambiguous" }));
    expect(JSON.stringify(log.mock.calls)).not.toContain("private-secret");
  });
  it.each(["bad-jid", "bad-instance", "bad-template", "agent-read", "lead-read", "prepare-shape", "http-error", "empty-finalize", "claim-error", "release-error"])("fails closed at %s", async failure => {
    const original = state.rpc.getMockImplementation()!;
    const modified = { ...row, lead_id: failure === "lead-read" ? 1 : null, remote_jid: failure === "bad-jid" ? "invalid" : row.remote_jid, instance_name: failure === "bad-instance" ? "" : row.instance_name };
    state.rows = [modified];
    if (["bad-template", "agent-read", "lead-read"].includes(failure)) state.from.mockImplementation((table: string) => {
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: failure === "bad-template" ? { options: { follow_up: { follow_up_1h_template: "" } } } : null, error: failure === "bad-template" ? null : { message: "private" } }) };
      return chain;
    });
    state.rpc.mockImplementation((name, args) => {
      if (failure === "claim-error" && name === "claim_agent_followup") return Promise.resolve({ data: null, error: { message: "private" } });
      if (failure === "prepare-shape" && name === "prepare_agent_followup") return Promise.resolve({ data: null, error: null });
      if (failure === "empty-finalize" && name === "finish_agent_followup") return Promise.resolve({ data: null, error: null });
      if (failure === "release-error" && name === "release_agent_followup") return Promise.resolve({ data: null, error: { message: "private" } });
      return original(name, args);
    });
    if (failure === "http-error") state.send.mockResolvedValue(new Response(null, { status: 503 }));
    if (failure === "release-error") state.send.mockRejectedValue(new Error("private"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runFollowUpWorker();
    expect(state.send.mock.calls.length).toBe(["http-error", "empty-finalize", "release-error"].includes(failure) ? 1 : 0);
  });
  it("renders real lead fields and skips disabled templates without sending", async () => {
    state.rows = [{ ...row, lead_id: 1 }];
    state.from.mockImplementation((table: string) => {
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: table === "agent_settings" ? { options: { follow_up: { follow_up_1h_template: "fixture", follow_up_1h_enabled: true } } } : { nome_negocio: "Fixture", ramo_negocio: "Ramo", categoria: "Categoria", endereco: "Rua", telefone: "fixture" }, error: null }) };
      return chain;
    });
    await runFollowUpWorker(); expect(state.send).toHaveBeenCalledOnce();
    state.send.mockClear(); state.rows = [row];
    state.from.mockImplementation(() => {
      const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: { options: { follow_up: { follow_up_1h_enabled: false } } }, error: null }) };
      return chain;
    });
    state.rpc.mockImplementation((name, args) => name === "claim_agent_followup" ? Promise.resolve({ data: state.rows.length ? [{ ...state.rows.shift() as object, claim_id: args.p_claim }] : [], error: null }) : Promise.resolve({ data: { action: "skipped" }, error: null }));
    await runFollowUpWorker(); expect(state.send).not.toHaveBeenCalled();
  });
  it("cancels and does not send when lead has opt_out = true", async () => {
    state.rows = [{ ...row, lead_id: 1 }];
    state.from.mockImplementation((table: string) => {
      const chain = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({
          data:
            table === "agent_settings"
              ? { options: { follow_up: { follow_up_1h_template: "fixture", follow_up_1h_enabled: true } } }
              : { nome_negocio: "Fixture", opt_out: true },
          error: null,
        }),
      };
      return chain;
    });
    await runFollowUpWorker();
    expect(state.send).not.toHaveBeenCalled();
    expect(state.rpc).not.toHaveBeenCalledWith("prepare_agent_followup", expect.anything());
    expect(state.rpc).toHaveBeenCalledWith(
      "release_agent_followup",
      expect.objectContaining({ p_status: "cancelled", p_error: "Lead solicitou opt-out." })
    );
  });
  it("two concurrent ticks cannot both send the same claimed row", async () => {
    await Promise.all([runFollowUpWorker(), runFollowUpWorker()]);
    expect(state.send).toHaveBeenCalledOnce();
  });
  it("habilita Spintax na renderização e reporta sucesso/falha ao disjuntor sem quebrar contrato de envio", async () => {
    await runFollowUpWorker();
    expect(state.render).toHaveBeenCalledWith("Fixture message", expect.any(Object), { spintax: true });
    await vi.waitFor(() => expect(state.feedback).toHaveBeenCalledWith({
      clientId: row.client_id,
      instanceName: row.instance_name,
      statusText: "delivered",
    }));

    state.feedback.mockClear();
    state.rows = [row];
    state.send.mockResolvedValueOnce(new Response(null, { status: 503 }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await runFollowUpWorker();
    await vi.waitFor(() => expect(state.feedback).toHaveBeenCalledWith({
      clientId: row.client_id,
      instanceName: row.instance_name,
      statusText: "error",
    }));
  });

  it("adia follow-up para pending quando fora do horário comercial do agente e cancela opt-out sem lead_id", async () => {
    vi.useFakeTimers();
    try {
      // 2026-11-16T03:00:00Z = 00:00 BRT (Segunda-feira fora do expediente 08:00-18:00)
      vi.setSystemTime(new Date("2026-11-16T03:00:00Z"));
      state.rows = [{ ...row, lead_id: null }];
      state.from.mockImplementation((table: string) => {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          maybeSingle: async () => ({
            data: table === "agent_settings"
              ? {
                  is_24h: false,
                  schedules: [
                    { day: "Segunda-feira", active: true, start: "08:00", end: "18:00" },
                  ],
                  options: {
                    follow_up: { enabled: true, follow_up_1h_enabled: true, follow_up_1h_template: "Oi!" },
                  },
                }
              : null,
            error: null,
          }),
          then: (resolve: (r: { data: unknown[]; error: null }) => void) => resolve({ data: [], error: null }),
        };
        return chain;
      });
      await runFollowUpWorker();
      expect(state.send).not.toHaveBeenCalled();
      expect(state.rpc).toHaveBeenCalledWith(
        "reschedule_agent_followup",
        expect.objectContaining({
          p_client: row.client_id,
          p_next_send_at: "2026-11-16T11:00:00.000Z",
        }),
      );

      // Fallback automático para release_agent_followup se a migration 029 não existir no banco
      state.rpc.mockClear();
      state.rows = [{ ...row, lead_id: null }];
      const prevRpcImpl = state.rpc.getMockImplementation()!;
      state.rpc.mockImplementation(async (name, args) => {
        if (name === "reschedule_agent_followup") return { data: null, error: { message: "function not found" } };
        return prevRpcImpl(name, args);
      });
      await runFollowUpWorker();
      expect(state.rpc).toHaveBeenCalledWith(
        "release_agent_followup",
        expect.objectContaining({ p_status: "pending", p_error: "Fora do horário comercial do agente." }),
      );
      state.rpc.mockImplementation(prevRpcImpl);

      // Segundo caso: sem lead_id, mas leads_extraidos retorna opt_out=true pelo JID
      state.rpc.mockClear();
      state.rows = [{ ...row, lead_id: null }];
      state.from.mockImplementation((table: string) => {
        const chain: Record<string, unknown> = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          maybeSingle: async () => ({
            data: table === "agent_settings"
              ? {
                  is_24h: true,
                  schedules: [],
                  options: {
                    follow_up: { enabled: true, follow_up_1h_enabled: true, follow_up_1h_template: "Oi!" },
                  },
                }
              : null,
            error: null,
          }),
          then: (resolve: (r: { data: unknown[]; error: null }) => void) =>
            resolve({
              data: table === "leads_extraidos" ? [{ id: 99, opt_out: true }] : [],
              error: null,
            }),
        };
        return chain;
      });
      await runFollowUpWorker();
      expect(state.send).not.toHaveBeenCalled();
      expect(state.rpc).toHaveBeenCalledWith(
        "release_agent_followup",
        expect.objectContaining({ p_status: "cancelled", p_error: "Lead solicitou opt-out." }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
