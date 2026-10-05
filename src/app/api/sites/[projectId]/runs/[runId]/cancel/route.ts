import { NextRequest, NextResponse } from "next/server";
import { cancelRun } from "@/lib/sites/repository";
import { requireSitesContext, sitesErrorResponse } from "@/lib/sites/server";

export async function POST(req: NextRequest, context: { params: Promise<{ projectId: string; runId: string }> }): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try {
    const { projectId, runId } = await context.params;
    return NextResponse.json({ runs: [await cancelRun(ctx.clientId, projectId, runId)] });
  } catch (error) { return sitesErrorResponse(error); }
}
