import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";

export const dynamic = "force-dynamic";

export async function GET() {
  const { data, error } = await supabase
    .from("followup_campaigns")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  return NextResponse.json({ success: true, campaigns: data });
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
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
    } = body || {};

    if (!name || !instance_name) {
      return NextResponse.json(
        { success: false, error: "Faltam campos obrigatórios: name, instance_name" },
        { status: 400 }
      );
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
        status: "draft",
      })
      .select()
      .single();
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    return NextResponse.json({ success: true, campaign: data });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
