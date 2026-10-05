import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireClientId(req);
    if (!ctx.ok) return ctx.response;
    if (!ctx.isAdmin) {
      return NextResponse.json(
        { success: false, error: "Apenas administradores podem testar chaves de IA." },
        { status: 403 }
      );
    }

    const body = await req.json().catch(() => ({}));
    let apiKey = typeof body?.apiKey === "string" ? body.apiKey.trim() : "";

    if (!apiKey) {
      const { getAiKeys } = await import("@/lib/ai-keys");
      const keys = await getAiKeys();
      apiKey = keys.nvidia || "";
    }

    if (!apiKey) {
      return NextResponse.json(
        { success: false, error: "Nenhuma chave da NVIDIA fornecida ou configurada." },
        { status: 400 }
      );
    }

    const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(20000),
    });

    const json = await res.json().catch(() => ({}));

    if (!res.ok) {
      const msg = json?.error?.message || json?.message || `A API da NVIDIA rejeitou a chave (Status ${res.status})`;
      return NextResponse.json({ success: false, error: msg }, { status: 400 });
    }

    const list = Array.isArray(json?.data) ? json.data : [];
    // Filtra modelos utilizáveis
    const chatCount = list.filter((m: any) => {
      const id = String(m?.id || "").toLowerCase();
      return id && !/embed|rerank|ranking|reward|guard|clip|whisper|stt|tts/i.test(id);
    }).length;

    return NextResponse.json({
      success: true,
      count: chatCount || list.length,
      totalCount: list.length,
      message: "Chave NVIDIA válida!",
    });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err?.message || "Falha ao conectar com a API da NVIDIA" },
      { status: 500 }
    );
  }
}
