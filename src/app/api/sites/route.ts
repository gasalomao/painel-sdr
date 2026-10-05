import { NextRequest, NextResponse } from "next/server";
import { createProject, listProjects } from "@/lib/sites/repository";
import { readSitesBody, requireSitesContext, sitesErrorResponse } from "@/lib/sites/server";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try { return NextResponse.json({ projects: await listProjects(ctx.clientId) }); }
  catch (error) { return sitesErrorResponse(error); }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try {
    const project = await createProject(ctx.clientId, await readSitesBody(req), ctx.actorId);
    return NextResponse.json({ project }, { status: 201 });
  } catch (error) { return sitesErrorResponse(error); }
}
