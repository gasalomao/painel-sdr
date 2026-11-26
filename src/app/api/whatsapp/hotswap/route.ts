import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { hotswapBannedInstance } from "@/lib/whatsapp-hotswap";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Payload JSON inválido" }, { status: 400 });
  }

  const oldInstanceName = String(body.old_instance_name || "").trim();
  const newInstanceName = String(body.new_instance_name || "").trim();

  const res = await hotswapBannedInstance({
    clientId: auth.clientId,
    oldInstanceName,
    newInstanceName,
  });

  if (!res.ok) {
    return NextResponse.json({ error: res.error || "Falha no hotswap" }, { status: res.status });
  }

  return NextResponse.json({
    success: true,
    migrated_agent_ids: res.migratedAgentIds,
    migrated_campaigns: res.migratedCampaigns,
    migrated_followups: res.migratedFollowups,
    migrated_automations: res.migratedAutomations,
  });
}
