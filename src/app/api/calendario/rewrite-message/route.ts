/**
 * /api/calendario/rewrite-message  POST
 *
 * Reescreve uma mensagem com Gemini pra ficar mais personalizada/humana,
 * preservando as variáveis ({nome}, {hora_agendamento}, etc) intactas.
 *
 * Body:
 *   - message (obrigatório)   — texto base a reescrever
 *   - appointment_id?         — pra dar contexto da reunião (nome lead, serviço, hora)
 *   - model?                  — APENAS admin pode definir modelo específico em runtime
 *                                (cliente comum sempre usa o modelo do organizer config)
 *
 * Retorna { ok, rewritten } com a nova versão. Não envia nada — só sugere.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { resolveModel } from "@/lib/ai-default-model";
import { logTokenUsage } from "@/lib/token-usage";
import { generateText, providerOf, providerDisplayName } from "@/lib/ai-provider";
import { getAiKeys } from "@/lib/ai-keys";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const { message, appointment_id, model: modelInBody } = body || {};
  if (!message || !String(message).trim()) {
    return NextResponse.json({ ok: false, error: "message obrigatório" }, { status: 400 });
  }

  // SEGURANÇA: cliente comum NÃO pode escolher modelo arbitrário (gasta tokens
  // num modelo caro à revelia). Só admin define modelo em runtime — o resto
  // usa o modelo padrão dele ou global.
  const model = await resolveModel(auth.isAdmin ? modelInBody : null, auth.clientId);
  if (!model) {
    return NextResponse.json({ ok: false, error: "Nenhum modelo de IA configurado. Admin precisa setar em Configurações → Organizador IA." }, { status: 400 });
  }

  // API keys centrais (Gemini + OpenRouter). O provedor é definido pelo modelo.
  const keys = await getAiKeys();
  const provider = providerOf(model);
  if (provider === "gemini" && !keys.gemini) {
    return NextResponse.json({ ok: false, error: "API Key Gemini não configurada no painel." }, { status: 400 });
  }
  if (provider === "openrouter" && !keys.openrouter) {
    return NextResponse.json({ ok: false, error: "API Key OpenRouter não configurada no painel." }, { status: 400 });
  }

  // Carrega contexto do appointment (se passado) pra IA escrever melhor
  let context = "";
  if (appointment_id) {
    let q = supabaseAdmin
      .from("appointments")
      .select("id, client_id, lead_id, remote_jid, title, service_name, start_at")
      .eq("id", appointment_id);
    if (!auth.isAdmin) q = q.eq("client_id", auth.clientId);
    const { data: appt } = await q.maybeSingle();
    if (appt) {
      const dt = new Date(appt.start_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" });
      context += `\nContexto do agendamento:\n  - Título: ${appt.title}\n  - Serviço: ${appt.service_name || "(não informado)"}\n  - Data/Hora: ${dt}\n`;
      if (appt.lead_id) {
        const { data: lead } = await supabaseAdmin
          .from("leads_extraidos")
          .select("nome_negocio, ramo_negocio")
          .eq("id", appt.lead_id)
          .maybeSingle();
        if (lead) {
          context += `  - Lead: ${lead.nome_negocio || "(sem nome)"}\n  - Ramo: ${lead.ramo_negocio || "(não informado)"}\n`;
        }
      }
    }
  }

  const systemPrompt = `Você é um copywriter especialista em mensagens WhatsApp pra negócios brasileiros.
Sua tarefa: reescrever uma mensagem mantendo o significado mas adicionando personalidade e tom mais humano/cordial.

REGRAS ABSOLUTAS:
1. NÃO mude nem remova nenhuma variável do tipo {nome}, {hora_agendamento}, {data_agendamento}, {servico}, etc. Elas DEVEM aparecer EXATAMENTE como estão.
2. NÃO adicione novas variáveis que não estavam na mensagem original.
3. NÃO mude o objetivo da mensagem (se é lembrete, mantém como lembrete; se é confirmação, mantém).
4. MANTENHA conciso — WhatsApp não é e-mail. Idealmente 1-3 linhas.
5. Use tom natural brasileiro, sem ser robótico nem formal demais.
6. NÃO use emojis exageradamente — no máx 1 ou 2.
7. Devolva APENAS a mensagem reescrita, sem aspas, sem comentários, sem "Aqui está:".`;

  const userPrompt = `Mensagem original:\n${message}\n${context ? `\n${context}` : ""}\nReescreva agora:`;

  try {
    const out = await generateText({
      modelRef: model,
      system: systemPrompt,
      prompt: userPrompt,
      geminiApiKey: keys.gemini,
      openrouterApiKey: keys.openrouter,
    });
    const rewritten = out.text;

    // Token tracking (admin gosta de saber quanto custou)
    try {
      await logTokenUsage({
        source: "other",
        sourceLabel: "calendario-rewrite",
        model: out.modelUsed,
        provider: providerDisplayName(provider),
        promptTokens: out.usage.promptTokens,
        completionTokens: out.usage.completionTokens,
        totalTokens: out.usage.totalTokens,
        // clientId NO TOP-LEVEL — antes ia só em metadata e helper caía
        // no client default "00000000-...-001". Custo aparecia no tenant
        // errado no painel /tokens.
        clientId: auth.clientId,
        metadata: { appointment_id: appointment_id || null },
      });
    } catch (logErr) {
      console.warn("[calendario/rewrite] token log falhou:", (logErr as Error).message);
    }

    if (!rewritten) {
      return NextResponse.json({ ok: false, error: "IA não retornou texto" }, { status: 500 });
    }
    return NextResponse.json({ ok: true, rewritten, model_used: model });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
  }
}
