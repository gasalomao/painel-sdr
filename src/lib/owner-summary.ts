/**
 * owner-summary — gera, com IA, um RESUMO do agendamento a partir da conversa
 * com o cliente e envia pro DONO no WhatsApp, em tempo real.
 *
 * Dispara em 3 momentos do ciclo do agendamento:
 *   - agendamento   (a IA marcou uma reunião)
 *   - cancelamento  (a IA cancelou)
 *   - reagendamento (a IA cancelou e remarcou)
 *
 * O PROMPT do resumo é configurável por agente
 * (`scheduler_config.owner_summary_prompt`) — porque o que o dono precisa
 * saber muda por nicho: um COMERCIAL quer objeções e orçamento; um SALÃO
 * quer serviço e profissional. Por isso o dono escreve o próprio prompt.
 *
 * O MODELO de IA: só o ADMIN pode fixar um (`owner_summary_model`). Cliente
 * comum sempre usa o modelo padrão da conta — isso é garantido pelo próprio
 * `resolveModel()`, que ignora o override quando o cliente não é admin.
 */

import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { sendMessage } from "@/lib/channel";
import { resolveModel } from "@/lib/ai-default-model";
import { logTokenUsage } from "@/lib/token-usage";
import { generateText, providerOf, providerDisplayName } from "@/lib/ai-provider";
import { getAiKeys } from "@/lib/ai-keys";

export type SummaryKind = "agendamento" | "cancelamento" | "reagendamento";

const KIND_HEADER: Record<SummaryKind, string> = {
  agendamento:   "✅ NOVO AGENDAMENTO — resumo do atendimento",
  cancelamento:  "❌ AGENDAMENTO CANCELADO — resumo do atendimento",
  reagendamento: "🔄 AGENDAMENTO REMARCADO — resumo do atendimento",
};

const DEFAULT_PROMPT =
  "Você resume, para o DONO do negócio, o atendimento que a IA fez com o " +
  "cliente e que terminou neste agendamento. Leia a conversa e escreva um " +
  "resumo CURTO e direto (até 6 linhas): quem é o cliente, o que ele quer/" +
  "precisa, observações ou objeções relevantes, e o que ficou combinado. " +
  "Tom profissional, em português, sem enrolação.";

/**
 * Gera o resumo via IA e envia pro dono. NUNCA lança — falha aqui não pode
 * derrubar o fluxo do agendamento. Idempotência fica a cargo do chamador.
 */
export async function sendOwnerAppointmentSummary(opts: {
  kind: SummaryKind;
  /** agent_settings do agente — precisa ter scheduler_config. */
  agentConfig: any;
  clientId: string;
  remoteJid: string;
  instanceName: string;
  appointment: { title?: string | null; service_name?: string | null; start_at?: string | null };
}): Promise<void> {
  try {
    const sched = (opts.agentConfig?.scheduler_config || {}) as any;
    if (!sched.owner_summary_enabled) return; // recurso desligado
    const ownerPhone = String(sched.owner_phone || "").replace(/\D/g, "");
    if (!ownerPhone) {
      console.warn("[OWNER-SUMMARY] resumo ligado mas sem owner_phone — pulando.");
      return;
    }
    if (!opts.instanceName) return;

    // API keys centrais — as mesmas do resto do sistema (Configurações).
    const keys = await getAiKeys();

    // Modelo: resolveModel já garante a regra — admin pode fixar
    // owner_summary_model, cliente comum cai no default da conta.
    const model =
      (await resolveModel(sched.owner_summary_model || null, opts.clientId)) ||
      "gemini-2.5-flash";

    const provider = providerOf(model);
    if (provider === "gemini" && !keys.gemini) {
      console.warn("[OWNER-SUMMARY] sem API key Gemini configurada — pulando.");
      return;
    }
    if (provider === "openrouter" && !keys.openrouter) {
      console.warn("[OWNER-SUMMARY] sem API key OpenRouter configurada — pulando.");
      return;
    }

    // Conversa recente com o cliente — fonte do resumo.
    let convQuery = supabase
      .from("chats_dashboard")
      .select("sender_type, content, created_at")
      .eq("remote_jid", opts.remoteJid)
      .order("created_at", { ascending: false })
      .limit(40);
    if (opts.instanceName) convQuery = convQuery.eq("instance_name", opts.instanceName);
    const { data: msgs } = await convQuery;
    const conversa = (msgs || [])
      .slice()
      .reverse()
      .map((m: any) => `${m.sender_type === "customer" ? "CLIENTE" : "AGENTE"}: ${(m.content || "").slice(0, 500)}`)
      .join("\n");

    const customPrompt = String(sched.owner_summary_prompt || "").trim() || DEFAULT_PROMPT;
    const apptInfo = [
      opts.appointment.title && `Título: ${opts.appointment.title}`,
      opts.appointment.service_name && `Serviço: ${opts.appointment.service_name}`,
      opts.appointment.start_at &&
        `Horário: ${new Date(opts.appointment.start_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`,
    ].filter(Boolean).join("\n");

    const sys = `${customPrompt}

CONTEXTO: este resumo é sobre um ${opts.kind.toUpperCase()}.

DADOS DO AGENDAMENTO:
${apptInfo || "(sem dados estruturados)"}

CONVERSA COM O CLIENTE (mais antiga em cima):
"""
${conversa || "(sem histórico de conversa registrado)"}
"""

Escreva APENAS o resumo final, em PT-BR, pronto pra mandar no WhatsApp do dono.
Sem aspas, sem títulos, sem markdown.`;

    // thinkingBudget=0: resumo curto pro dono não precisa de raciocínio em
    // cadeia (cobrado como saída). Economiza tokens sem perder qualidade.
    const out = await generateText({
      modelRef: model,
      prompt: sys,
      thinkingBudget: 0,
      geminiApiKey: keys.gemini,
      openrouterApiKey: keys.openrouter,
    });
    const summary = out.text.replace(/^["']|["']$/g, "");

    // Telemetria de tokens — best-effort.
    try {
      logTokenUsage({
        source: "other",
        sourceId: null,
        sourceLabel: "Resumo de agendamento p/ dono",
        model: out.modelUsed,
        provider: providerDisplayName(provider),
        promptTokens: out.usage.promptTokens,
        completionTokens: out.usage.completionTokens,
        totalTokens: out.usage.totalTokens,
        metadata: { kind: opts.kind },
      });
    } catch { /* não-fatal */ }

    if (!summary) {
      console.warn("[OWNER-SUMMARY] IA devolveu resumo vazio — pulando envio.");
      return;
    }

    const ownerJid = `${ownerPhone}@s.whatsapp.net`;
    const finalMsg = `${KIND_HEADER[opts.kind]}\n\n${summary}`;
    await sendMessage(ownerJid, finalMsg, opts.instanceName);
    console.log(`[OWNER-SUMMARY] resumo "${opts.kind}" enviado pro dono ${ownerPhone}.`);
  } catch (e: any) {
    console.warn("[OWNER-SUMMARY] falhou (não-fatal):", e?.message || e);
  }
}
