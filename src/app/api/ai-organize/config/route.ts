import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";

export async function GET() {
  try {
    const { data } = await supabase
      .from("ai_organizer_config")
      .select("enabled, model, provider, execution_hour, last_run, api_key")
      .eq("id", 1)
      .maybeSingle();

    return NextResponse.json({
      success: true,
      config: {
        enabled: !!data?.enabled,
        model: data?.model || null,
        provider: data?.provider || "Gemini",
        execution_hour: typeof data?.execution_hour === "number" ? data.execution_hour : 20,
        last_run: data?.last_run || null,
        has_api_key: !!(data?.api_key && String(data.api_key).trim().length > 0),
      },
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const update: Record<string, any> = { id: 1, updated_at: new Date().toISOString() };

    if (typeof body.enabled === "boolean") update.enabled = body.enabled;
    if (typeof body.model === "string" && body.model.trim()) update.model = body.model.trim();
    if (typeof body.provider === "string" && body.provider.trim()) update.provider = body.provider.trim();
    if (typeof body.api_key === "string" && body.api_key.trim()) update.api_key = body.api_key.trim();
    if (body.execution_hour !== undefined) {
      const h = Number(body.execution_hour);
      if (!Number.isInteger(h) || h < 0 || h > 23) {
        return NextResponse.json(
          { success: false, error: "execution_hour deve ser inteiro entre 0 e 23." },
          { status: 400 }
        );
      }
      update.execution_hour = h;
    }

    const { error } = await supabase
      .from("ai_organizer_config")
      .upsert(update, { onConflict: "id" });
    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
