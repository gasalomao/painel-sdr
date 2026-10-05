import { NextRequest, NextResponse } from "next/server";
import { listLeads } from "@/lib/sites/repository";
import { requireSitesContext, sitesErrorResponse } from "@/lib/sites/server";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try { return NextResponse.json({ leads: await listLeads(ctx.clientId, req.nextUrl.searchParams.get("q") ?? "") }); }
  catch (error) { return sitesErrorResponse(error); }
}
