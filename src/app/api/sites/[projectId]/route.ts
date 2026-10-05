import { NextRequest, NextResponse } from "next/server";
import { deleteProject, getProject, updateProject } from "@/lib/sites/repository";
import { readSitesBody, requireSitesContext, sitesErrorResponse } from "@/lib/sites/server";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(req: NextRequest, context: Context): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try { return NextResponse.json({ project: await getProject(ctx.clientId, (await context.params).projectId) }); }
  catch (error) { return sitesErrorResponse(error); }
}

export async function PATCH(req: NextRequest, context: Context): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try {
    const project = await updateProject(ctx.clientId, (await context.params).projectId, await readSitesBody(req));
    return NextResponse.json({ project });
  } catch (error) { return sitesErrorResponse(error); }
}

export async function DELETE(req: NextRequest, context: Context): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try { return NextResponse.json({ project: await deleteProject(ctx.clientId, (await context.params).projectId) }); }
  catch (error) { return sitesErrorResponse(error); }
}
