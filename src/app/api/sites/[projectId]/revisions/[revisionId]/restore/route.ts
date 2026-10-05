import { NextRequest, NextResponse } from "next/server";
import { restoreRevision } from "@/lib/sites/repository";
import { expectedRevision, onlyFields, readSitesBody, requireSitesContext, sitesErrorResponse } from "@/lib/sites/server";

export async function POST(req: NextRequest, context: { params: Promise<{ projectId: string; revisionId: string }> }): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try {
    const { projectId, revisionId } = await context.params;
    const body = await readSitesBody(req, 4096);
    onlyFields(body, ["expected_revision_id"]);
    const revision = await restoreRevision(ctx.clientId, projectId, revisionId, ctx.actorId, expectedRevision(body));
    return NextResponse.json({ revisions: [revision], files: revision.files });
  } catch (error) { return sitesErrorResponse(error); }
}
