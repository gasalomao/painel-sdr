import { NextRequest, NextResponse } from "next/server";
import { requireSitesContext } from "@/lib/sites/server";
import { createWebsiteSkill, getEffectiveSkills } from "@/lib/sites/skills";
import { readWebsiteJson, websiteInstructionResponse } from "@/lib/sites/prompts";

export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try { return NextResponse.json({ skills: await getEffectiveSkills(ctx.clientId) }, { headers: { "Cache-Control": "private, no-store" } }); }
  catch (error) { return websiteInstructionResponse(error); }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try { return NextResponse.json({ skill: await createWebsiteSkill(ctx.clientId, await readWebsiteJson(req)) }, { status: 201, headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return websiteInstructionResponse(error); }
}
