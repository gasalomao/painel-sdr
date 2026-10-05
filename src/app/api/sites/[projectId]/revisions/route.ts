import { NextRequest, NextResponse } from "next/server";
import { listRevisions } from "@/lib/sites/repository";
import { requireSitesContext, sitesErrorResponse } from "@/lib/sites/server";

export async function GET(req: NextRequest, context: { params: Promise<{ projectId: string }> }): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try { return NextResponse.json({ revisions: await listRevisions(ctx.clientId, (await context.params).projectId) }); }
  catch (error) { return sitesErrorResponse(error); }
}
