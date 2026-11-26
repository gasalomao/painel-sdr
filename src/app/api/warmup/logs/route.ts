import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { requireWarmupAdminAccess } from "@/lib/warmup/warmup-admin-guard";
import { supabaseAdmin } from "@/lib/supabase_admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  const denied = requireWarmupAdminAccess(auth);
  if (denied) return denied;

  const clientId = auth.clientId;
  const limit = Math.min(Number(req.nextUrl.searchParams.get("limit") || 50), 100);

  try {
    const { data: logs, error } = await supabaseAdmin
      .from("whatsapp_warmup_logs")
      .select("*")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, logs: logs || [] });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

