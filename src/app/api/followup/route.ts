import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { requireFeatureAccess } from "@/lib/saas-limits";
import { enforceClientDefaultModel } from "@/lib/enforce-model";
import { validateCampaignInstanceAccess } from "@/lib/campaign-instance-access";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  const denied = requireFeatureAccess(ctx, "followup");
  if (denied) return denied;

  let q = supabase.from("followup_campaigns").select("*").order("created_at", { ascending: false });
  if (!ctx.isAdmin) q = q.eq("client_id", ctx.clientId);
  const { data, error } = await q;
  if (error) {
    console.error("[followup/GET] Erro:", error.message);
    return NextResponse.json({ success: false, error: "Falha ao listar campanhas de follow-up" }, { status: 500 });
  }
  // Mescla os switches anti-ban gravados em app_settings, senão reabrir a
  // campanha para edição mostraria os valores errados.
  const campaigns = (data || []) as Array<Record<string, any>>;
  const ids = campaigns.map((c) => c?.id).filter(Boolean);
  const flagMap = new Map<string, string>();
  if (ids.length > 0) {
    try {
      const keys = ids.flatMap((id: string) => [
        `followup_weekend_guard:${id}`,
        `followup_cold_shield:${id}`,
      ]);
      const { data: cfgRows } = await supabase
        .from("app_settings")
        .select("key, value")
        .in("key", keys);
      for (const row of cfgRows || []) {
        if (row?.key) flagMap.set(String(row.key), String(row.value ?? ""));
      }
    } catch {}
  }
  const readFlag = (id: string, key: string, fallback: boolean): boolean => {
    const raw = flagMap.get(`${key}:${id}`);
    if (raw === undefined) return fallback;
    return raw === "true" || raw === "1";
  };
  for (const c of campaigns) {
    if (!c?.id) continue;
    c.weekend_guard = readFlag(c.id, "followup_weekend_guard", false);
    c.cold_shield = readFlag(c.id, "followup_cold_shield", true);
  }
  return NextResponse.json({ success: true, campaigns });
}

export async function POST(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  const denied = requireFeatureAccess(ctx, "followup");
  if (denied) return denied;

  try {
    const body = await req.json();
    // SaaS guard: cliente comum não pode escolher modelo arbitrário.
    await enforceClientDefaultModel(body, ctx, ["ai_model"]);
    const {
      name,
      instance_name,
      ai_enabled = false,
      ai_model = null,
      ai_prompt = null,
      steps = [],
      min_interval_seconds = 40,
      max_interval_seconds = 90,
      allowed_start_hour = 9,
      allowed_end_hour = 20,
      auto_execute = false,
      weekend_guard = false,
      cold_shield = true,
      // Coluna do kanban que abastece essa campanha — default "follow-up" pra
      // manter retrocompatibilidade com clientes/kanbans antigos.
      source_status = "follow-up",
    } = body || {};

    if (!name || !instance_name) {
      return NextResponse.json(
        { success: false, error: "Faltam campos obrigatórios: name, instance_name" },
        { status: 400 }
      );
    }
    const access = await validateCampaignInstanceAccess(ctx.clientId, String(instance_name));
    if (!access.ok) {
      return NextResponse.json({ success: false, error: access.error }, { status: access.status });
    }
    if (!Array.isArray(steps) || steps.length === 0) {
      return NextResponse.json(
        { success: false, error: "Inclua pelo menos 1 passo de follow-up." },
        { status: 400 }
      );
    }
    for (const s of steps) {
      if (typeof s?.day_offset !== "number" || s.day_offset < 1) {
        return NextResponse.json(
          { success: false, error: "Cada passo precisa de day_offset >= 1." },
          { status: 400 }
        );
      }
      if (typeof s?.template !== "string" || !s.template.trim()) {
        return NextResponse.json(
          { success: false, error: "Cada passo precisa de template não vazio." },
          { status: 400 }
        );
      }
    }
    if (!ctx.isAdmin && Number(min_interval_seconds) < 15) {
      return NextResponse.json(
        { success: false, error: "Intervalo mínimo entre envios: 15 s." },
        { status: 400 }
      );
    }
    if (Number(min_interval_seconds) < 5 || Number(max_interval_seconds) < 5) {
      return NextResponse.json(
        { success: false, error: "Intervalo mínimo entre envios: 5 s." },
        { status: 400 }
      );
    }
    if (Number(min_interval_seconds) > Number(max_interval_seconds)) {
      return NextResponse.json(
        { success: false, error: "min_interval > max_interval" },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from("followup_campaigns")
      .insert({
        client_id: ctx.clientId,
        name,
        instance_name,
        ai_enabled,
        ai_model,
        ai_prompt,
        steps,
        min_interval_seconds,
        max_interval_seconds,
        allowed_start_hour,
        allowed_end_hour,
        auto_execute,
        source_status,
        status: "draft",
      })
      .select()
      .single();
    if (error) {
      console.error("[followup/POST] Erro:", error.message);
      return NextResponse.json({ success: false, error: "Falha ao criar campanha de follow-up" }, { status: 500 });
    }
    try {
      await supabase
        .from("app_settings")
        .upsert([
          { key: `followup_weekend_guard:${data.id}`, value: String(Boolean(weekend_guard)) },
          { key: `followup_cold_shield:${data.id}`, value: String(cold_shield !== false) },
        ], { onConflict: "key" });
    } catch {}
    return NextResponse.json({ success: true, campaign: data });
  } catch (err: unknown) {
    console.error("[followup/POST] Erro inesperado:", err instanceof Error ? err.message : err);
    return NextResponse.json({ success: false, error: "Erro interno ao criar follow-up" }, { status: 500 });
  }
}
