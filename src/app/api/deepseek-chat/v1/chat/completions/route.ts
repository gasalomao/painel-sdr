/**
 * POST /api/deepseek-chat/v1/chat/completions
 *
 * Camada OpenAI-compatível que o resto do painel usa via `gateway_endpoints`.
 * Pega um token ativo (round-robin entre os logados), chama chat.deepseek.com,
 * e devolve a resposta no formato OpenAI. Suporta streaming (SSE) e
 * non-streaming pelo campo `stream` do body.
 *
 * NÃO exige auth — o discovery e o ai-provider chamam aqui de dentro do mesmo
 * painel. Se quisermos blindar contra abuso externo, adicionar uma sentinel
 * `Authorization: Bearer <localKey>` no futuro.
 */

import { NextRequest, NextResponse } from "next/server";
import { pickToken, getFullToken } from "@/lib/deepseek-chat-manager";
import { chatComplete, DsUpstreamError, messagesToPrompt, DEEPSEEK_CHAT_MODELS } from "@/lib/deepseek-chat-client";
import { verifySession, SESSION_COOKIE } from "@/lib/auth-edge";
import { hasInternalSecret } from "@/lib/internal-auth";

// Streaming pode demorar — afrouxa o timeout.
export const maxDuration = 120;

/**
 * Auth: aceita sessão válida (browser do painel — fetch same-origin manda o
 * cookie) OU X-Internal-Secret (chamadas server-to-server). Bloqueia
 * consumidores externos anônimos — antes era público e qualquer um na
 * internet gastava as contas DeepSeek logadas do painel.
 */
async function authorized(req: NextRequest): Promise<boolean> {
  if (hasInternalSecret(req)) return true;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token && (await verifySession(token))) return true;
  // Bearer com o AUTH_SECRET — permite ferramentas externas apontarem aqui
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  const secret = process.env.AUTH_SECRET || "";
  return !!(bearer && secret && bearer === secret);
}

export async function POST(req: NextRequest) {
  if (!(await authorized(req))) {
    return NextResponse.json({ error: { message: "Não autorizado." } }, { status: 401 });
  }
  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: { message: "Body JSON inválido." } }, { status: 400 });
  }

  const requestedModel = String(body?.model || "").trim();
  // Aceita "deepseek-chat" ou "deepseek-reasoner"; qualquer outro vira chat.
  const model = DEEPSEEK_CHAT_MODELS.some((m) => m.id === requestedModel)
    ? requestedModel
    : "deepseek-chat";
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.length) {
    return NextResponse.json({ error: { message: "messages[] vazio." } }, { status: 400 });
  }
  const prompt = messagesToPrompt(messages);
  if (!prompt.trim()) {
    return NextResponse.json({ error: { message: "Nenhum conteúdo de texto em messages[]." } }, { status: 400 });
  }
  const stream = !!body?.stream;

  const tok = pickToken();
  if (!tok) {
    // Dica de diagnóstico: quem cê chega aqui geralmente é um fallback vindo do
    // gateway (modelo "gateway:..." escolhido no sandbox/agente), e o gateway
    // (CLIProxyAPI na porta 8317) está morto. Sem isso o user vê só
    // "Nenhuma conta DeepSeek ativa" e acha que precisa ir conectar DeepSeek —
    // quando na verdade a causa raiz pode ser o proxy desligado.
    return NextResponse.json({
      error: {
        message:
          "Nenhuma conta DeepSeek ativa pra servir este modelo. " +
          "Se você selecionou um modelo do Gateway (ex: gateway:gemini-...), " +
          "verifique em Configurações → Contas Grátis (Gateway) se o conector está LIGADO — " +
          "o gateway morto faz a IA cair pro DeepSeek como fallback. " +
          "Conecte uma conta DeepSeek em Configurações → DeepSeek Chat (sessão da conta).",
        type: "no_active_account",
      },
    }, { status: 503 });
  }

  // Recupera o token COMPLETO (com fingerprint) — pickToken só devolveu o
  // suficiente pra rotação, mas precisamos da fingerprint estável dele.
  const fullTok = getFullToken(tok.id) || tok;
  let result: { content: string; usage: { promptTokens: number; completionTokens: number; estimated?: boolean } };
  try {
    result = await chatComplete({
      tokenId: tok.id,
      token: tok.token,
      fingerprint: fullTok.fingerprint,
      model,
      prompt,
      signal: req.signal,
    });
  } catch (e: any) {
    const status = e instanceof DsUpstreamError ? e.status : 500;
    return NextResponse.json({
      error: {
        message: e?.message || String(e),
        type: "upstream_error",
        token_paused: e instanceof DsUpstreamError && e.tokenDead,
      },
    }, { status });
  }

  const id = `chatcmpl-ds-${Date.now().toString(36)}`;
  const created = Math.floor(Date.now() / 1000);

  if (stream) {
    // Devolve UM chunk com o conteúdo inteiro + DONE. Não é "true streaming"
    // (já consumimos o SSE do upstream pra montar a resposta), mas mantém o
    // shape esperado por clients que insistem em `stream:true`.
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        const chunk = {
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: { role: "assistant", content: result.content }, finish_reason: null }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        const done = {
          id, object: "chat.completion.chunk", created, model,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(done)}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
      },
    });
  }

  return NextResponse.json({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: result.content },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: result.usage.promptTokens,
      completion_tokens: result.usage.completionTokens,
      total_tokens: result.usage.promptTokens + result.usage.completionTokens,
      estimated: result.usage.estimated === true,
    },
  });
}
