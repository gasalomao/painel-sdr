import { NextRequest, NextResponse } from "next/server";
import { publishSite } from "@/lib/sites/deployment-provider";
import { getWebsiteSettings } from "@/lib/sites/prompts";
import { requireSitesContext, sitesErrorResponse } from "@/lib/sites/server";

type Context = { params: Promise<{ projectId: string; deploymentId: string }> };
export const runtime = "nodejs";

export async function POST(req: NextRequest, context: Context): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  try {
    const { projectId, deploymentId } = await context.params;
    const settings = await getWebsiteSettings();
    const deployment = await publishSite({ clientId: ctx.clientId, projectId, rollbackId: deploymentId, idempotencyKey: req.headers.get("idempotency-key") ?? "", baseDomain: settings.base_domain });
    return NextResponse.json({ deployment }, { status: deployment.status === "deploying" ? 202 : deployment.status === "failed" ? 409 : 200 });
  } catch (error) { return sitesErrorResponse(error); }
}
