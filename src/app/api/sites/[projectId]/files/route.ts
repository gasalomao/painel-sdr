import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { loadRunCheckpoint } from "@/lib/sites/run-checkpoint";
import { databaseError, getFiles, saveRevision } from "@/lib/sites/repository";
import { assertUuid, expectedRevision, onlyFields, readSitesBody, requireSitesContext, requireSitesProject, SitesError, sitesErrorResponse, textField } from "@/lib/sites/server";
import type { WebsiteFiles, WebsiteRun } from "@/lib/sites/types";

type Context = { params: Promise<{ projectId: string }> };

export async function GET(req: NextRequest, context: Context): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try {
    const { projectId } = await context.params;
    const runId = req.nextUrl.searchParams.get("run_id");
    const headers = { "Cache-Control": "private, no-store", Vary: "Cookie" };
    if (!runId) return NextResponse.json({ files: await getFiles(ctx.clientId, projectId) }, { headers });
    assertUuid(runId);
    const project = await requireSitesProject(ctx.clientId, projectId);
    const result = await ctx.db.from("website_runs").select("*").eq("client_id", ctx.clientId).eq("project_id", projectId).eq("id", runId).maybeSingle();
    databaseError(result.error);
    if (!result.data) throw new SitesError(404, "Execução não encontrada.");
    const run = result.data as WebsiteRun;
    if (run.kind === "build" || run.base_revision_id !== project.current_revision_id) return NextResponse.json({ checkpoint: null }, { headers });
    const checkpoint = await loadRunCheckpoint(ctx.db, run, true);
    if (!checkpoint) return NextResponse.json({ checkpoint: null }, { headers });
    const latest = await requireSitesProject(ctx.clientId, projectId);
    if (latest.current_revision_id !== run.base_revision_id) return NextResponse.json({ checkpoint: null }, { headers });
    const version = createHash("sha256").update(JSON.stringify(checkpoint.files)).digest("hex");
    const etag = `"${runId}:${version}"`;
    if (req.headers.get("If-None-Match") === etag) return new NextResponse(null, { status: 304, headers: { ...headers, ETag: etag } });
    return NextResponse.json({ checkpoint: { version, run_id: runId, base_revision_id: run.base_revision_id, files: checkpoint.files } }, { headers: { ...headers, ETag: etag } });
  } catch (error) { return sitesErrorResponse(error); }
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
