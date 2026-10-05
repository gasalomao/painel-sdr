import { NextRequest, NextResponse } from "next/server";
import { requireSitesContext } from "@/lib/sites/server";
import { deleteWebsiteAsset, getSelectedAssets, updateWebsiteAsset } from "@/lib/sites/assets";
import { assertWebsiteOrigin, readWebsiteJson, websiteInstructionResponse } from "@/lib/sites/prompts";

type RouteContext = { params: Promise<{ projectId: string; assetId: string }> };
export const runtime = "nodejs";

export async function GET(req: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try {
    const { projectId, assetId } = await params;
    const [asset] = await getSelectedAssets(ctx.clientId, projectId, [assetId]);
    return NextResponse.json({ asset }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return websiteInstructionResponse(error); }
}

export async function PATCH(req: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try {
    const { projectId, assetId } = await params;
    return NextResponse.json({ asset: await updateWebsiteAsset(ctx.clientId, projectId, assetId, await readWebsiteJson(req)) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return websiteInstructionResponse(error); }
}

export async function DELETE(req: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try {
    assertWebsiteOrigin(req);
    const { projectId, assetId } = await params;
    await deleteWebsiteAsset(ctx.clientId, projectId, assetId);
    return NextResponse.json({ success: true });
  } catch (error) { return websiteInstructionResponse(error); }
}
