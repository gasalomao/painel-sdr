/**
 * LIVE (DB + IA reais, SEM envio de WhatsApp):
 *  - cria campanha sintética com personalize_with_ai
 *  - preGenerateCampaignMessages deve preencher rendered_message dos targets
 *    pending (mesmo fora da janela de horário)
 *  - target que JÁ tem rendered_message não é regerado nem sobrescrito
 *  - mensagem final nunca pode conter {{variavel}} crua
 * Limpa tudo no afterAll (campaign_targets + campaign_logs + campaigns).
 */
import { describe, it, expect, afterAll } from "vitest";
import { supabaseAdmin } from "../supabase_admin";
import { preGenerateCampaignMessages } from "../campaign-worker";

const INSTANCE = "00000_DD_11";
const createdCampaignIds: string[] = [];

async function cleanup(id: string) {
  await supabaseAdmin.from("campaign_targets").delete().eq("campaign_id", id);
  await supabaseAdmin.from("campaign_logs").delete().eq("campaign_id", id);
  await supabaseAdmin.from("campaigns").delete().eq("id", id);
}

describe("Pré-geração de mensagens com IA (live)", () => {
  afterAll(async () => {
    for (const id of createdCampaignIds) await cleanup(id);
  });

  it("pré-gera mensagens para targets pending sem mensagem e não pisa em quem já tem", async () => {
    const { data: camp, error } = await supabaseAdmin.from("campaigns").insert({
      name: "TESTE live pré-geração (auto-limpa)",
      instance_name: INSTANCE,
      message_template: "Olá {{nome_negocio}}! Somos o teste automatizado de pré-geração — esta mensagem nunca será enviada.",
      personalize_with_ai: true,
      ai_model: "gemini-1.5-flash",
      min_interval_seconds: 700,
      max_interval_seconds: 1000,
      allowed_start_hour: 8,
      allowed_end_hour: 18,
      status: "running",
    }).select("id").single();
    expect(error, error?.message).toBeFalsy();
    expect(camp).toBeTruthy();
    if (!camp) throw new Error("Falha criando campanha");
    createdCampaignIds.push(camp.id);

    const { data: targets, error: tErr } = await supabaseAdmin.from("campaign_targets").insert([
      // A: já tem mensagem pré-pronta — NÃO pode ser sobrescrita
      { campaign_id: camp.id, remote_jid: "5531999970001@s.whatsapp.net", nome_negocio: "Pet Fixo Live", ramo_negocio: "Petshop", status: "pending", rendered_message: "MENSAGEM FIXA ORIGINAL" },
      // B e C: sem mensagem — devem ser pré-geradas
      { campaign_id: camp.id, remote_jid: "5531999970002@s.whatsapp.net", nome_negocio: "Pet Teste Um Live", ramo_negocio: "Petshop", status: "pending" },
      { campaign_id: camp.id, remote_jid: "5531999970003@s.whatsapp.net", nome_negocio: "Pet Teste Dois Live", ramo_negocio: "Petshop", status: "pending" },
    ]).select("id, remote_jid, rendered_message");
    expect(tErr, tErr?.message).toBeFalsy();

    const res = await preGenerateCampaignMessages(camp.id);
    expect(res.ok).toBe(true);
    // B e C foram tentados (sucesso ou falha de IA — conta como tentativa)
    expect(res.generated + res.failed).toBeGreaterThanOrEqual(2);

    const { data: rows } = await supabaseAdmin
      .from("campaign_targets")
      .select("remote_jid, rendered_message, ai_input")
      .eq("campaign_id", camp.id);
    const byJid = new Map((rows || []).map(r => [r.remote_jid, r]));

    // A intocada
    expect(byJid.get("5531999970001@s.whatsapp.net")?.rendered_message).toBe("MENSAGEM FIXA ORIGINAL");

    if (res.generated > 0) {
      const preenchidos = (rows || []).filter(r => r.remote_jid !== "5531999970001@s.whatsapp.net" && r.rendered_message);
      expect(preenchidos.length).toBe(res.generated);
      for (const r of preenchidos) {
        expect(r.rendered_message!.length).toBeGreaterThan(10);
        // nenhuma {{variavel}} pode vazar pro texto final
        expect(r.rendered_message!).not.toMatch(/\{\{.*?\}\}/);
      }
    }

    // Rodada 2: quem já foi gerado não é regerado (rendered_message já setado)
    const res2 = await preGenerateCampaignMessages(camp.id);
    expect(res2.generated).toBeLessThanOrEqual(res.failed);
  }, 180_000);
});
