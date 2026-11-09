import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase_admin";
import {
  DEFAULT_GOAL_TASK_CONFIG,
  normalizeGoalTaskConfig,
  type GoalTaskTriggerConfig,
} from "@/lib/goal-task-generator";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;

    if (!supabaseAdmin) {
      return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });
    }

    const { data: client, error } = await supabaseAdmin
      .from("clients")
      .select("features, default_ai_model")
      .eq("id", auth.clientId)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    const rawFeatures = (client?.features ?? {}) as Record<string, unknown>;
    const config = normalizeGoalTaskConfig(rawFeatures.goal_task_trigger);

    // Se o modelo configurado estiver vazio, podemos retornar o default_ai_model como sugestão
    const effectiveModel = config.model || client?.default_ai_model || "";

    return NextResponse.json({
      ok: true,
      config: {
        ...config,
        suggested_model: effectiveModel,
      },
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Erro interno";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  return handleSave(req);
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  return handleSave(req);
}

async function handleSave(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;

    if (!supabaseAdmin) {
      return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });
    }

    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ ok: false, error: "Corpo JSON inválido" }, { status: 400 });
    }

    // Busca features atuais do cliente
    const { data: client, error: fetchErr } = await supabaseAdmin
      .from("clients")
      .select("features")
      .eq("id", auth.clientId)
      .maybeSingle();

    if (fetchErr) {
      return NextResponse.json({ ok: false, error: fetchErr.message }, { status: 500 });
    }

    const currentFeatures = (client?.features ?? {}) as Record<string, unknown>;
    const normalizedConfig: GoalTaskTriggerConfig = normalizeGoalTaskConfig({
      ...(currentFeatures.goal_task_trigger as Record<string, unknown> || {}),
      ...body,
    });

    const updatedFeatures = {
      ...currentFeatures,
      goal_task_trigger: normalizedConfig,
    };

    const { error: updateErr } = await supabaseAdmin
      .from("clients")
      .update({
        features: updatedFeatures,
        updated_at: new Date().toISOString(),
      })
      .eq("id", auth.clientId);

    if (updateErr) {
      return NextResponse.json({ ok: false, error: updateErr.message }, { status: 500 });
    }

    return NextResponse.json({
      ok: true,
      config: normalizedConfig,
      message: "Configuração do gatilho salva com sucesso.",
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Erro interno";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

