import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { getHumanPauseConfig, setHumanPauseConfig } from "@/lib/bot-status";

export const dynamic = "force-dynamic";

/**
 * /api/agent/pause-config
 *
 * Config GLOBAL da PAUSA AUTOMÁTICA da IA — quando um humano responde o
 * cliente (pelo painel ou pelo celular do número conectado), a IA pausa
 * pra não responderem juntos.
 *
 *   GET  → { enabled, minutes, mode }
 *   POST → grava { enabled?, minutes?, mode? }
 */

export async function GET(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  const cfg = await getHumanPauseConfig();
  return NextResponse.json({ ok: true, ...cfg });
}

export async function POST(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;

  const body = await req.json().catch(() => ({}));
  const patch: { enabled?: boolean; minutes?: number; mode?: "timed" | "manual" } = {};
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
  if (body.minutes !== undefined && body.minutes !== null && !Number.isNaN(Number(body.minutes))) {
    patch.minutes = Math.max(1, Math.min(1440, Number(body.minutes)));
  }
  if (body.mode === "timed" || body.mode === "manual") patch.mode = body.mode;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: "Nada pra salvar" }, { status: 400 });
  }

  await setHumanPauseConfig(patch);
  const cfg = await getHumanPauseConfig();
  return NextResponse.json({ ok: true, ...cfg });
}
