import { NextRequest, NextResponse } from "next/server";
import { listWebsiteModels } from "@/lib/sites/models";
import { getWebsiteSettings } from "@/lib/sites/prompts";
import { requireSitesContext, sitesErrorResponse } from "@/lib/sites/server";

export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const context = await requireSitesContext(request);
  if (!context.ok) return context.response;
  try {
    const refresh = request.nextUrl.searchParams.get("refresh") === "true";
    const all = context.isAdmin && request.nextUrl.searchParams.get("all") === "true";
    const settings = await getWebsiteSettings();
    const effectiveSettings = all ? { ...settings, model_allowlist: [] } : settings;
    const models = await listWebsiteModels(effectiveSettings, refresh);
    return NextResponse.json({ models, modes: ["auto", "quality", "economy", "manual"], status: models.length ? "ready" : "unconfigured" }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return sitesErrorResponse(error);
  }
}
