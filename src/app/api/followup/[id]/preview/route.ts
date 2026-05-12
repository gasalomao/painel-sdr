import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { renderTemplate } from "@/lib/template-vars";
import {
  getConversationHistory,
  personalizeFollowupWithAI,
} from "@/lib/followup-worker";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Preview: mostra EXATAMENTE o que a IA vai receber e o que ela geraria,
 * sem enviar nada. Útil pra garantir que o contexto está chegando.
 *
 * Body:
 *   - target_id?: string           (preview de um target já cadastrado)
 *   - remote_jid?: string          (ou preview direto por remoteJid)
 *   - step_index?: number          (override do passo; default = current_step)
 *   - force_ai?: boolean           (força rodar IA mesmo que ai_enabled=false)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const { target_id, remote_jid, step_index, force_ai } = body || {};

    const { data: camp } = await supabase
      .from("followup_campaigns")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    if (!camp) {
      return NextResponse.json({ success: false, error: "Campanha não encontrada" }, { status: 404 });
    }

    let target: any = null;
    if (target_id) {
      const { data } = await supabase
        .from("followup_targets")
        .select("*")
        .eq("id", target_id)
        .maybeSingle();
      target = data;
    } else if (remote_jid) {
      const { data: lead } = await supabase
        .from("leads_extraidos")
        .select("id, remoteJid, nome_negocio, ramo_negocio")
        .eq("remoteJid", remote_jid)
        .maybeSingle();
      target = {
        remote_jid,
        nome_negocio: lead?.nome_negocio || null,
        ramo_negocio: lead?.ramo_negocio || null,
        current_step: 0,
      };
    }
    if (!target) {
      return NextResponse.json(
        { success: false, error: "Informe target_id ou remote_jid" },
        { status: 400 }
      );
    }

    const stepIdx = Number.isFinite(step_index) ? step_index : target.current_step || 0;
    const step = (camp.steps || [])[stepIdx];
    if (!step) {
      return NextResponse.json({
        success: true,
        preview: {
          target,
          step_index: stepIdx,
          step: null,
          rendered: null,
          history: await getConversationHistory(target.remote_jid, 20),
          ai_used: false,
          ai_message: null,
          note: "Este target já esgotou todos os passos — nada seria enviado.",
        },
      });
    }

    const rendered = renderTemplate(step.template, {
      remoteJid: target.remote_jid,
      nome_negocio: target.nome_negocio,
      ramo_negocio: target.ramo_negocio,
    });

    const history = await getConversationHistory(target.remote_jid, 20);

    let ai_message: string | null = null;
    let ai_error: string | null = null;
    const should_ai = force_ai === true || (camp.ai_enabled && camp.ai_model);

    if (should_ai) {
      const { data: cfg } = await supabase
        .from("ai_organizer_config")
        .select("api_key")
        .eq("id", 1)
        .maybeSingle();
      const apiKey = cfg?.api_key;
      if (!apiKey) {
        ai_error = "API key Gemini não configurada.";
      } else {
        try {
          ai_message = await personalizeFollowupWithAI({
            baseMessage: rendered,
            customPrompt: camp.ai_prompt || "",
            model: camp.ai_model || "gemini-1.5-flash",
            nome_empresa: target.nome_negocio || "",
            ramo: target.ramo_negocio || "",
            history,
            apiKey,
            stepNumber: stepIdx + 1,
          });
        } catch (e: any) {
          ai_error = e?.message || String(e);
        }
      }
    }

    return NextResponse.json({
      success: true,
      preview: {
        target: {
          remote_jid: target.remote_jid,
          nome_negocio: target.nome_negocio,
          ramo_negocio: target.ramo_negocio,
          current_step: target.current_step,
        },
        step_index: stepIdx,
        step,
        rendered,
        history,
        history_msg_count: history.split("\n").filter(Boolean).length,
        ai_used: should_ai && !!ai_message,
        ai_error,
        ai_message,
        final_message: ai_message || rendered,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
