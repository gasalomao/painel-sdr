import { NextRequest, NextResponse } from "next/server";
import { requireSitesContext } from "@/lib/sites/server";
import { listWebsiteAssets, parseWebsiteUpload, uploadWebsiteAsset } from "@/lib/sites/assets";
import { getProject } from "@/lib/sites/repository";
import { websiteInstructionResponse } from "@/lib/sites/prompts";

type RouteContext = { params: Promise<{ projectId: string }> };
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try { return NextResponse.json({ assets: await listWebsiteAssets(ctx.clientId, (await params).projectId) }, { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return websiteInstructionResponse(error); }
}

export async function POST(req: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try {
    const { projectId } = await params;
    await getProject(ctx.clientId, projectId);
    const upload = await parseWebsiteUpload(req);
    return NextResponse.json({ asset: await uploadWebsiteAsset(ctx.clientId, projectId, upload, ctx.actorId) }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return websiteInstructionResponse(error); }
}
