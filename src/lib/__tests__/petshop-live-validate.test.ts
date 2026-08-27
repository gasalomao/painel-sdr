import { describe, it, expect } from "vitest";
import { preGenerateCampaignMessages } from "../campaign-worker";
import { supabaseAdmin } from "../supabase_admin";

// Teste live opcional (usa a campanha real "Pet shop BH"): roda só com LIVE_PETSHOP=1
const d = process.env.LIVE_PETSHOP ? describe : describe.skip;

d("Live test automação Pet shop BH", () => {
  it("pré-gera mensagens reais com IA para os leads da campanha Pet shop BH", async () => {
    const campaignId = "55f3e112-48cf-44f0-9fec-63576d96a159";
    const res = await preGenerateCampaignMessages(campaignId);
    console.log("Resultado da pré-geração Pet shop BH:", res);
    expect(res.ok).toBe(true);

    const { data: pendingWithMsg } = await supabaseAdmin
      .from("campaign_targets")
      .select("id, remote_jid, nome_negocio, rendered_message")
      .eq("campaign_id", campaignId)
      .eq("status", "pending")
      .not("rendered_message", "is", null);

    console.log(`Targets pending com mensagem pré-gerada: ${pendingWithMsg?.length}`);
    if (pendingWithMsg && pendingWithMsg.length > 0) {
      console.log("Exemplo de mensagem gerada pela IA:", pendingWithMsg[0].rendered_message);
      // Garante que não sobrou tag não substituída
      expect(pendingWithMsg[0].rendered_message).not.toContain("{{");
    }
  }, 400000);
});
