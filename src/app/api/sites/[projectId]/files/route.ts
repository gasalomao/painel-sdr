import { NextRequest, NextResponse } from "next/server";
import { getFiles, saveRevision } from "@/lib/sites/repository";
import { expectedRevision, onlyFields, readSitesBody, requireSitesContext, sitesErrorResponse, textField } from "@/lib/sites/server";
import type { WebsiteFiles } from "@/lib/sites/types";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(req: NextRequest, context: Context): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try { return NextResponse.json({ files: await getFiles(ctx.clientId, (await context.params).projectId) }); }
  catch (error) { return sitesErrorResponse(error); }
}

export async function PUT(req: NextRequest, context: Context): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try {
    const body = await readSitesBody(req, 4 * 1024 * 1024);
    onlyFields(body, ["files", "message", "expected_revision_id"]);
    const revision = await saveRevision(ctx.clientId, (await context.params).projectId, body.files as WebsiteFiles,
      body.message === undefined ? "Edição manual" : textField(body.message, 1000, true), ctx.actorId, expectedRevision(body));
    return NextResponse.json({ files: revision.files, revisions: [revision] });
  } catch (error) { return sitesErrorResponse(error); }
}
