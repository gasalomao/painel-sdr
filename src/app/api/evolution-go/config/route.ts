/**
 * GET    /api/evolution-go/config    → devolve config atual (key mascarada).
 * PATCH  /api/evolution-go/config    → grava { url, apiKey } em app_settings.
 * POST   /api/evolution-go/config?test=1 → testa a conexão (GET /server/ok).
 *
 * Mesmo padrão da Evolution API legada (/api/evolution/config), mas pra
 * o Evolution GO. Salva em app_settings com chaves evolution_go_*.
 * O lib/providers/evolution-go.ts lê esses valores com cache de 30s.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { invalidateEvolutionGoCache } from "@/lib/providers/evolution-go";

export const dynamic = "force-dynamic";

async function requireAdmin(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!ctx.isAdmin) {
    return NextResponse.json({ success: false, error: "Apenas admin." }, { status: 403 });
  }
  return null;
}

const KEYS = ["evolution_go_url", "evolution_go_key"] as const;

function maskKey(k?: string | null) {
  if (!k) return "";
  if (k.length <= 8) return "•".repeat(k.length);
  return k.slice(0, 4) + "…" + k.slice(-4);
}

async function readSettings() {
  const { data, error } = await supabaseAdmin
    .from("app_settings")
    .select("key,value")
    .in("key", KEYS as unknown as string[]);
  if (error) throw new Error(error.message);
  const map: Record<string, string> = {};
  for (const r of (data ?? [])) map[r.key] = r.value || "";
  return map;
}

async function writeSetting(key: string, value: string) {
  const { error } = await supabaseAdmin
    .from("app_settings")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(error.message);
}

/** GET — devolve config atual. */
export async function GET(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const map = await readSettings();
    return NextResponse.json({
      success: true,
      url: map.evolution_go_url || "",
      apiKey: maskKey(map.evolution_go_key),
      hasKey: !!map.evolution_go_key,
      webhookUrl: `${req.nextUrl.origin}/api/webhooks/evolution-go`,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/** PATCH — salva config. */
export async function PATCH(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const body = await req.json();
    if (typeof body.url === "string") {
      const url = body.url.trim().replace(/\/+$/, "");
      await writeSetting("evolution_go_url", url);
    }
    if (typeof body.apiKey === "string" && body.apiKey.trim()) {
      await writeSetting("evolution_go_key", body.apiKey.trim());
    }
    invalidateEvolutionGoCache();
    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

/** POST ?test=1 — testa a conexão com o servidor Evolution GO. */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;
  try {
    const map = await readSettings();
    const url = (map.evolution_go_url || "").replace(/\/+$/, "");
    const key = map.evolution_go_key || "";
    if (!url) return NextResponse.json({ success: false, error: "URL não configurada." }, { status: 400 });

    // Health check do GO: GET /server/ok (não exige apikey).
    const res = await fetch(`${url}/server/ok`, {
      headers: key ? { apikey: key } : {},
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return NextResponse.json({ success: false, error: `Evolution GO respondeu HTTP ${res.status}` }, { status: 502 });
    }
    const json = await res.json().catch(() => ({}));
    return NextResponse.json({
      success: true,
      message: "Evolution GO respondeu!",
      data: json,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: `Não conectou: ${err.message}` }, { status: 502 });
  }
}
