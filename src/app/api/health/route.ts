import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/health
 *
 * Endpoint leve de liveness para Docker HEALTHCHECK, EasyPanel, Traefik e balanceadores.
 * Não executa queries pesadas nem expõe variáveis de ambiente ou dados de tenants.
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    {
      ok: true,
      status: "ok",
      timestamp: new Date().toISOString(),
    },
    {
      status: 200,
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    },
  );
}

