/**
 * API do CONECTOR EMBUTIDO de assinaturas (CLIProxyAPI local gerenciado pelo
 * painel). Só ADMIN. Ações via POST {action}:
 *   status        → instalado? rodando? contas logadas?
 *   install       → baixa o release oficial + escreve config + liga
 *   start | stop  → liga/desliga o processo
 *   login-start   → {provider: gemini|claude|openai|antigravity} → URL OAuth + state
 *   login-status  → {state} → wait|ok|error
 *
 * Por que servidor (e não o navegador direto no proxy): evita CORS, e a
 * management key fica só no servidor — o navegador nunca vê o segredo.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";

// Download do release pode demorar; segura a rota aberta por até 5 min.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireClientId(req);
    if (!ctx.ok) return ctx.response;
    if (!ctx.isAdmin) {
      return NextResponse.json(
        { success: false, error: "Apenas admin pode gerenciar o conector de assinaturas." },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    const action = String(body.action || "");
    // Lazy import: módulo usa fs/child_process — só carrega quando precisa.
    const mgr = await import("@/lib/gateway-proxy-manager");

    if (action === "status") {
      return NextResponse.json({ success: true, status: await mgr.getProxyStatus() });
    }

    if (action === "install") {
      const info = await mgr.installProxy();
      const status = await mgr.startProxy();
      return NextResponse.json({ success: true, version: info.version, status });
    }

    if (action === "start") {
      return NextResponse.json({ success: true, status: await mgr.startProxy() });
    }

    if (action === "stop") {
      return NextResponse.json({ success: true, status: await mgr.stopProxy() });
    }

    if (action === "login-start") {
      const provider = String(body.provider || "") as "gemini" | "claude" | "openai" | "antigravity";
      if (!["gemini", "claude", "openai", "antigravity"].includes(provider)) {
        return NextResponse.json({ success: false, error: "provider deve ser gemini, claude, openai ou antigravity." }, { status: 400 });
      }
      const st = await mgr.getProxyStatus();
      if (!st.running) {
        return NextResponse.json({ success: false, error: "Conector desligado. Ligue-o antes de conectar uma conta." }, { status: 409 });
      }
      if (!st.managementReady) {
        return NextResponse.json({
          success: false,
          error: "Há um proxy na porta 8317 que não foi instalado pelo painel (key não confere). Desligue-o e use Instalar, ou cadastre-o no modo manual.",
        }, { status: 409 });
      }
      const login = await mgr.startLogin(provider);
      return NextResponse.json({ success: true, ...login, v1Url: mgr.PROXY_V1_URL });
    }

    if (action === "login-status") {
      const state = String(body.state || "");
      if (!state) return NextResponse.json({ success: false, error: "state obrigatório." }, { status: 400 });
      const r = await mgr.getLoginStatus(state);
      return NextResponse.json({ success: true, ...r, v1Url: mgr.PROXY_V1_URL });
    }

    if (action === "login-callback") {
      // O navegador do usuário não alcança o localhost DO SERVIDOR — ele cola a
      // URL de callback aqui e nós a entregamos à management API do proxy.
      const url = String(body.url || "");
      if (!url) return NextResponse.json({ success: false, error: "url obrigatória." }, { status: 400 });
      const rawProvider = String(body.provider || "");
      const provider = ["gemini", "claude", "openai", "antigravity"].includes(rawProvider)
        ? (rawProvider as "gemini" | "claude" | "openai" | "antigravity")
        : undefined;
      await mgr.completeLoginCallback(url, provider);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: `Ação desconhecida: ${action}` }, { status: 400 });
  } catch (err: any) {
    // Dica específica pra ambiente serverless (sem fs/processo persistente).
    const msg = String(err?.message || err);
    const hint = /EROFS|read-only|ENOENT.*spawn|not (found|implemented)/i.test(msg)
      ? " (O conector embutido precisa que o painel rode em servidor próprio — local ou VPS, não serverless. Use o modo manual nesse caso.)"
      : "";
    return NextResponse.json({ success: false, error: msg + hint }, { status: 500 });
  }
}
