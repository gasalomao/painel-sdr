import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { loadMentorFunnelMetricsForClient } from "@/lib/mentor-metrics";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;

  const summary = await loadMentorFunnelMetricsForClient(auth.clientId);
  return NextResponse.json({ ok: true, metrics: summary });
}
