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

/**
 * POST /api/evolution-go/config
 *
 * Actions:
 *   ?test=1       → testa a conexão (health check GET /server/ok).
 *   ?connect=1    → cria instância + conecta + devolve QR Code.
 *   ?status=1     → status da instância.
 *   (default)     → teste.
 */
export async function POST(req: NextRequest) {
  const guard = await requireAdmin(req);
  if (guard) return guard;

  const action = req.nextUrl.searchParams.get("connect")
    ? "connect"
    : req.nextUrl.searchParams.get("status")
    ? "status"
    : "test";

  try {
    const map = await readSettings();
    const url = (map.evolution_go_url || "").replace(/\/+$/, "");
    const key = map.evolution_go_key || "";
    if (!url) return NextResponse.json({ success: false, error: "URL não configurada." }, { status: 400 });

    const headers: Record<string, string> = { "Content-Type": "application/json", apikey: key, token: key };

    // ===== HEALTH CHECK =====
    if (action === "test") {
      const res = await fetch(`${url}/server/ok`, { headers, signal: AbortSignal.timeout(10000) });
      if (!res.ok) return NextResponse.json({ success: false, error: `Evolution GO HTTP ${res.status}` }, { status: 502 });
      const json = await res.json().catch(() => ({}));
      return NextResponse.json({ success: true, message: "Evolution GO respondeu!", data: json });
    }

    // ===== STATUS =====
    if (action === "status") {
      const body = await req.json().catch(() => ({}));
      const inst = body.instance || "sdr";
      const res = await fetch(`${url}/instance/status`, { headers, method: "GET", signal: AbortSignal.timeout(10000) });
      const json = await res.json().catch(() => ({}));
      const data = json?.data || {};
      let state = String(data.Connected ? "open" : data.LoggedIn ? "open" : "close").toLowerCase();
      return NextResponse.json({ success: true, state, data: json });
    }

    // ===== CONNECT (cria instância + gera QR) =====
    if (action === "connect") {
      const body = await req.json().catch(() => ({}));
      const inst = body.instance || "sdr";

      // 1. Cria instância (se não existir).
      try {
        await fetch(`${url}/instance/create`, {
          method: "POST",
          headers,
          body: JSON.stringify({ name: inst, token: key }),
          signal: AbortSignal.timeout(15000),
        });
      } catch {}

      // 2. Conecta (gera QR code).
      const connRes = await fetch(`${url}/instance/connect`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(30000),
      });
      const connJson = await connRes.json().catch(() => ({}));
      if (!connRes.ok) {
        return NextResponse.json({ success: false, error: connJson?.error || `Connect HTTP ${connRes.status}` }, { status: 502 });
      }

      // 3. Aguarda QR code (pode demorar 1-2s pra gerar).
      let qrCode: string | null = null;
      let pairingCode: string | null = null;
      for (let i = 0; i < 5; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const qrRes = await fetch(`${url}/instance/qr`, { headers, signal: AbortSignal.timeout(10000) });
        const qrJson = await qrRes.json().catch(() => ({}));
        const qrData = qrJson?.data || {};
        const qr = qrData.qrcode || qrData.qr;
        if (qr && qr !== "") {
          qrCode = qr.startsWith("data:") ? qr : `data:image/png;base64,${qr}`;
          break;
        }
      }

      // 4. Configura advanced settings (always online, read messages, etc).
      try {
        // Pega o instance ID da lista.
        const allRes = await fetch(`${url}/instance/all`, { headers, signal: AbortSignal.timeout(10000) });
        const allJson = await allRes.json().catch(() => ({}));
        const list = allJson?.data || [];
        const match = list.find((x: any) => x.name === inst);
        if (match?.id) {
          await fetch(`${url}/instance/${match.id}/advanced-settings`, {
            method: "PUT",
            headers,
            body: JSON.stringify({ alwaysOnline: true, readMessages: true, rejectCall: true, ignoreGroups: true, ignoreStatus: true }),
            signal: AbortSignal.timeout(10000),
          });
        }
      } catch {}

      return NextResponse.json({
        success: true,
        message: qrCode ? "QR Code gerado! Escaneie no WhatsApp." : "Instância conectada (sem QR — pode já estar logada).",
        qrCode,
        pairingCode,
      });
    }

    return NextResponse.json({ success: false, error: "Ação desconhecida" }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: `Erro: ${err.message}` }, { status: 502 });
  }
}
