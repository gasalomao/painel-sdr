import { NextRequest, NextResponse } from "next/server";
import { requireSitesContext } from "@/lib/sites/server";
import { getWebsiteIntegrations, getWebsitePromptVersions, getWebsiteSettings, readWebsiteJson, saveWebsiteSettings, websiteInstructionResponse } from "@/lib/sites/prompts";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try {
    const [settings, promptVersions, integrations] = await Promise.all([getWebsiteSettings(), ctx.isAdmin ? getWebsitePromptVersions() : Promise.resolve([]), getWebsiteIntegrations()]);
    return NextResponse.json({ settings: ctx.isAdmin ? settings : { ...settings, creative_prompt: "" }, isAdmin: ctx.isAdmin, integrations, promptVersions }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return websiteInstructionResponse(error); }
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  if (!ctx.isAdmin) return NextResponse.json({ error: "Somente administradores podem alterar configurações globais." }, { status: 403 });
  try { return NextResponse.json({ settings: await saveWebsiteSettings(await readWebsiteJson(req)) }); }
  catch (error) { return websiteInstructionResponse(error); }
}
