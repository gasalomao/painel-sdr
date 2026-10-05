import { NextRequest, NextResponse } from "next/server";
import { requireSitesContext } from "@/lib/sites/server";
import { deleteWebsiteSkill, getEffectiveSkills, updateWebsiteSkill } from "@/lib/sites/skills";
import { readWebsiteJson, websiteInstructionResponse } from "@/lib/sites/prompts";

type RouteContext = { params: Promise<{ skillId: string }> };
export const runtime = "nodejs";

export async function PATCH(req: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try {
    const skill = await updateWebsiteSkill(ctx.clientId, (await params).skillId, await readWebsiteJson(req));
    return NextResponse.json({ skill }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return websiteInstructionResponse(error); }
}

export async function DELETE(req: NextRequest, { params }: RouteContext): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try {
    await deleteWebsiteSkill(ctx.clientId, (await params).skillId);
    const skills = await getEffectiveSkills(ctx.clientId);
    return NextResponse.json({ skills }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return websiteInstructionResponse(error); }
}
