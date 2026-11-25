import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { getTenantUsageSummary } from "@/lib/saas-limits";

export const dynamic = "force-dynamic";

/**
 * GET /api/account/usage
 * Devolve plano atual, limites configurados e consumo mensal de tokens/USD/recursos
 * estritamente escopado ao tenant autenticado.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;

  const summary = await getTenantUsageSummary(auth.clientId, auth.isAdmin);
  return NextResponse.json({
    ok: true,
    isAdmin: auth.isAdmin,
    ...summary,
  });
}
