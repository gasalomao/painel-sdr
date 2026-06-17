/**
 * POST /api/deepseek-chat/manage  (admin)
 *
 * CRUD dos tokens da conta DeepSeek (userToken capturado do chat.deepseek.com).
 * Tudo aqui é ISOLADO do conector OAuth — se essa rota cair, nada mais
 * quebra.
 *
 * Ações: list | add | update | delete
 */

import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import {
  listTokens, addToken, updateToken, deleteToken,
  generateImportCode,
  generateSubscriptionCode, listSubscriptions, revokeSubscription,
} from "@/lib/deepseek-chat-manager";

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireClientId(req);
    if (!ctx.ok) return ctx.response;
    if (!ctx.isAdmin) {
      return NextResponse.json({ success: false, error: "Apenas admin." }, { status: 403 });
    }

    const body = await req.json().catch(() => ({} as any));
    const action = String(body.action || "");

    if (action === "list") {
      return NextResponse.json({ success: true, tokens: listTokens() });
    }

    if (action === "add") {
      const token = String(body.token || "");
      const label = String(body.label || "");
      const t = addToken({ token, label });
      return NextResponse.json({ success: true, token: t, tokens: listTokens() });
    }

    if (action === "update") {
      const id = String(body.id || "");
      if (!id) return NextResponse.json({ success: false, error: "id obrigatório." }, { status: 400 });
      const patch: { label?: string; paused?: boolean } = {};
      if (typeof body.label === "string") patch.label = body.label;
      if (typeof body.paused === "boolean") patch.paused = body.paused;
      const t = updateToken(id, patch);
      return NextResponse.json({ success: true, token: t, tokens: listTokens() });
    }

    if (action === "delete") {
      const id = String(body.id || "");
      if (!id) return NextResponse.json({ success: false, error: "id obrigatório." }, { status: 400 });
      deleteToken(id);
      return NextResponse.json({ success: true, tokens: listTokens() });
    }

    if (action === "generate-import-code") {
      // Gera um código de uso único pro bookmarklet. A UI usa pra montar o
      // <a> arrastável com a URL javascript: do bookmarklet.
      const labelHint = typeof body.labelHint === "string" ? body.labelHint : undefined;
      const c = generateImportCode(labelHint);
      return NextResponse.json({ success: true, ...c });
    }

    if (action === "generate-subscription") {
      // Gera uma subscription long-lived pro userscript Tampermonkey. Long-lived
      // porque o script roda toda visita ao chat.deepseek.com — não é uso único.
      const s = generateSubscriptionCode();
      return NextResponse.json({ success: true, subscription: s });
    }

    if (action === "list-subscriptions") {
      return NextResponse.json({ success: true, subscriptions: listSubscriptions() });
    }

    if (action === "revoke-subscription") {
      const code = String(body.code || "");
      if (!code) return NextResponse.json({ success: false, error: "code obrigatório." }, { status: 400 });
      revokeSubscription(code);
      return NextResponse.json({ success: true, subscriptions: listSubscriptions() });
    }

    return NextResponse.json({ success: false, error: `Ação desconhecida: ${action}` }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: String(err?.message || err) }, { status: 500 });
  }
}
