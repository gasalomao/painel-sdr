import { NextRequest, NextResponse } from "next/server";
import { startAutomation } from "@/lib/automation-worker";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = await startAutomation(id);
  return NextResponse.json(r);
}
