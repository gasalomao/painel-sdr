/**
 * E2E AO VIVO — automação de follow-up + integrações.
 *
 * SEGURANÇA: o envio de WhatsApp (lib/channel) é STUBADO — nenhuma mensagem
 * real sai. Tudo o mais é real: banco, IA free do OpenRouter, janelas,
 * steps, logs. Rows de teste usam marcador "__e2e__" e são removidas no fim.
 *
 * OPT-IN: só roda com LIVE_E2E=1 — `npm test` normal pula este arquivo.
 *   PowerShell:  $env:LIVE_E2E="1"; npx vitest run src/lib/__tests__/live-e2e-automacao.test.ts
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { listAvailableOpenRouterModels } from "@/lib/openrouter-model-discovery";
import { getEvolutionConfig } from "@/lib/evolution";
import { embedTexts } from "@/lib/rag";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { DEFAULT_CLIENT_ID } from "@/lib/tenant";

// ============================================================
// STUB DE ENVIO — grava as chamadas, não envia nada de verdade.
// É a ÚNICA fronteira mockada; todo o resto do pipeline é real.
// ============================================================
const sentCalls: Array<{ remoteJid: string; text: string; instance: string }> = [];
vi.mock("@/lib/channel", () => ({
  sendMessage: async (remoteJid: string, text: string, instanceName: string) => {
    sentCalls.push({ remoteJid, text, instance: instanceName });
    return { ok: true, messageId: `e2e-stub-${sentCalls.length}` };
  },
  sendMedia: async (remoteJid: string, caption: string, _media: any, instanceName: string) => {
    sentCalls.push({ remoteJid, text: `[MEDIA] ${caption}`, instance: instanceName });
    return { ok: true, messageId: `e2e-stub-media-${sentCalls.length}` };
  },
}));

const LIVE = process.env.LIVE_E2E === "1";
const MARK = "__e2e__";
const db = () => supabaseAdmin!;
let campaignId = "";

afterAll(async () => {
  if (!campaignId || !db()) return;
  await db().from("followup_targets").delete().eq("followup_campaign_id", campaignId);
  await db().from("followup_logs").delete().eq("followup_campaign_id", campaignId);
  await db().from("followup_campaigns").delete().eq("id", campaignId);
  console.log(`[E2E] cleanup: campanha ${campaignId} e rows ${MARK} removidas`);
});

describe.skipIf(!LIVE)("E2E ao vivo — automação (envio stubado)", () => {
  it("Evolution API configurada e alcançável (leitura)", async () => {
    const cfg = await getEvolutionConfig();
    console.log(`[E2E] Evolution: url=${cfg.url ? "ok" : "FALTA"} instancia=${cfg.instance || "?"} key=${cfg.apiKey ? "ok" : "FALTA"}`);
    expect(cfg.url).toBeTruthy();
  });

  it("embeddings funcionam (1 vetor real)", async () => {
    const vecs = await embedTexts(["teste e2e de embedding"]);
    expect(vecs.length).toBe(1);
    expect(vecs[0].length).toBeGreaterThan(100);
    console.log(`[E2E] embedding OK — dimensão ${vecs[0].length}`);
  });

  it(
    "pipeline de follow-up completo: enroll → tick → IA free → envio stubado",
    async () => {
      // Escolhe modelo free que responde (mesma preferência do E2E de reviews)
      const models = await listAvailableOpenRouterModels(true);
      const free = models.filter((m) => m.id.endsWith(":free"));
      const prefRe = /dots-3-note|laguna|gemma|glm/i;
      const pick =
        free.find((m) => m.supportsTools && prefRe.test(m.id)) ||
        free.find((m) => m.supportsTools) ||
        free[0];
      expect(pick).toBeTruthy();
      const modelRef = `openrouter:${pick.id}`;
      console.log(`[E2E] modelo free da campanha: ${modelRef}`);

      // 1. Campanha de teste — auto_execute FALSE pra ticker global NUNCA pegar
      const { data: camp, error: campErr } = await db()
        .from("followup_campaigns")
        .insert({
          client_id: DEFAULT_CLIENT_ID,
          name: `${MARK} Follow-up Live`,
          instance_name: "e2e-test-instance",
          ai_enabled: true,
          ai_model: modelRef,
          ai_prompt: null,
          steps: [{ day_offset: 0, template: "Olá {{nome_negocio}}! Passando pra saber se ficou alguma dúvida." }],
          min_interval_seconds: 0,
          max_interval_seconds: 0,
          allowed_start_hour: 0,
          allowed_end_hour: 23,
          auto_execute: false,
          status: "active",
        })
        .select("id")
        .single();
      expect(campErr || !camp).toBeFalsy();
      campaignId = camp!.id;

      // 2. Target com jid FALHO explícito (nunca existe no WhatsApp)
      const fakeJid = "55119000000000@s.whatsapp.net";
      const { error: tgtErr } = await db()
        .from("followup_targets")
        .insert({
          followup_campaign_id: campaignId,
          client_id: DEFAULT_CLIENT_ID,
          lead_id: null,
          remote_jid: fakeJid,
          nome_negocio: `${MARK} Lead Fantasma`,
          ramo_negocio: "Teste",
          current_step: 0,
          next_send_at: null,
          status: "pending",
        });
      expect(tgtErr).toBeFalsy();

      // 3. Tick da campanha ISOLADA — pipeline real inteiro
      const { tickCampaign } = await import("@/lib/followup-worker");
      const r = await tickCampaign(campaignId, DEFAULT_CLIENT_ID);
      console.log(`[E2E] tickCampaign → ${JSON.stringify(r)}`);
      expect(r.ok).toBe(true);
      expect(r.processed).toBe(1);

      // 4. Envio passou pelo stub com o texto personalizado pela IA
      expect(sentCalls.length).toBe(1);
      expect(sentCalls[0].remoteJid).toBe(fakeJid);
      console.log(`[E2E] mensagem gerada pela IA: "${sentCalls[0].text.slice(0, 160)}"`);
      expect(sentCalls[0].text.length).toBeGreaterThan(10);
      // IA deve ter adaptado o template (não copiado literal)
      expect(sentCalls[0].text).not.toContain("{{nome_negocio}}");

      // 5. Estado do target avançou (step 1, aguardando próximo ciclo)
      const { data: tgt } = await db()
        .from("followup_targets")
        .select("status, current_step, last_sent_at")
        .eq("followup_campaign_id", campaignId)
        .maybeSingle();
      console.log(`[E2E] target final: ${JSON.stringify(tgt)}`);
      expect(tgt?.current_step).toBe(1);
      expect(tgt?.last_sent_at).toBeTruthy();
    },
    180000,
  );
});
