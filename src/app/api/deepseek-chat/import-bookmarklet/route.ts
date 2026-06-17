/**
 * POST /api/deepseek-chat/import-bookmarklet
 *
 * Recebe o userToken do chat.deepseek.com vindo de um bookmarklet (cross-
 * origin). Autenticado por `importCode` de uso único e TTL curto (15 min) —
 * é o que substitui o cookie de sessão, já que a request vem da aba do
 * chat.deepseek.com (não compartilha cookies com o painel).
 *
 * CORS: aberto pra qualquer origem. SEGURO porque a request precisa:
 *   1) Conhecer um importCode válido (gerado no painel logado como admin).
 *   2) Antes do TTL expirar.
 *   3) Em uma única tentativa (o code é destruído na PRIMEIRA tentativa).
 *
 * Content-Type: aceita text/plain pra evitar preflight (mode:no-cors do
 * bookmarklet — assim o browser não bloqueia a request por CORS de POST JSON).
 */

import { NextRequest, NextResponse } from "next/server";
import { consumeImportCode, consumeSubscription } from "@/lib/deepseek-chat-manager";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function POST(req: NextRequest) {
  try {
    // Aceita text/plain (sem preflight) OU application/json (alguns clientes).
    let body: any;
    try { body = await req.json(); }
    catch { body = JSON.parse((await req.text()).trim()); }
    const code = String(body?.code || "");
    const subscription = String(body?.subscription || "");
    const token = String(body?.token || "");
    if (!token) {
      return NextResponse.json({ success: false, error: "token obrigatório." }, {
        status: 400, headers: CORS,
      });
    }
    // Subscription tem precedência (userscript Tampermonkey — multi-uso). Code
    // é fallback pro bookmarklet de uso único.
    if (subscription) {
      const r = consumeSubscription(subscription, token);
      return NextResponse.json({ success: true, added: r.added, tokenId: r.tokenId }, { headers: CORS });
    }
    if (!code) {
      return NextResponse.json({ success: false, error: "code ou subscription obrigatório." }, {
        status: 400, headers: CORS,
      });
    }
    const t = consumeImportCode(code, token);
    return NextResponse.json({ success: true, added: true, token: t }, { headers: CORS });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: String(err?.message || err) },
      { status: 400, headers: CORS },
    );
  }
}
