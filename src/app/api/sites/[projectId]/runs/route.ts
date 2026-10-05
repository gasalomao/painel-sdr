import { NextRequest, NextResponse } from "next/server";
import { listRuns, queueRun } from "@/lib/sites/repository";
import { readSitesBody, requireSitesContext, sitesErrorResponse } from "@/lib/sites/server";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(req: NextRequest, context: Context): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try { return NextResponse.json({ runs: await listRuns(ctx.clientId, (await context.params).projectId) }); }
  catch (error) { return sitesErrorResponse(error); }
}

export async function POST(req: NextRequest, context: Context): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try {
    const run = await queueRun(ctx.clientId, (await context.params).projectId, await readSitesBody(req), ctx.actorId);
    return NextResponse.json({ runs: [run] }, { status: 202 });
  } catch (error) { return sitesErrorResponse(error); }
}
