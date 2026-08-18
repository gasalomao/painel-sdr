import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { generateText } from "@/lib/ai-provider";
import { getAiKeys } from "@/lib/ai-keys";
import { resolveComboSteps } from "@/lib/ai-combos";

export async function POST(req: NextRequest) {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;
    if (!auth.isAdmin) {
      return NextResponse.json({ success: false, error: "Apenas administradores podem testar combos de IA." }, { status: 403 });
    }

    const body = await req.json();
    const comboId = String(body?.comboId || "").trim();
    if (!comboId) {
      return NextResponse.json({ success: false, error: "comboId é obrigatório" }, { status: 400 });
    }

    const keys = await getAiKeys(true);
    const steps = resolveComboSteps(comboId, keys.aiCombos);

    if (!steps.length) {
      return NextResponse.json({ success: false, error: "Nenhum modelo ativo encontrado para este combo." }, { status: 400 });
    }

    const logs: Array<{ step: number; modelRef: string; status: "success" | "fail"; error?: string; latencyMs: number }> = [];
    const prompt = "Responda apenas: OK";

    let success = false;
    let finalModelUsed = "";
    let finalResponse = "";

    const startTime = Date.now();

    for (let i = 0; i < steps.length; i++) {
      const stepRef = steps[i];
      const stepStart = Date.now();
      try {
        const res = await generateText({
          modelRef: stepRef,
          prompt,
          geminiApiKey: keys.gemini,
          openrouterApiKey: keys.openrouter,
          gatewayBaseUrl: keys.gatewayBaseUrl,
          gatewayApiKey: keys.gatewayApiKey,
          maxOutputTokens: 20,
          noGatewayFallback: true,
        });
        const latency = Date.now() - stepStart;
        logs.push({ step: i + 1, modelRef: stepRef, status: "success", latencyMs: latency });
        success = true;
        finalModelUsed = res.modelUsed;
        finalResponse = res.text;
        break;
      } catch (err: any) {
        const latency = Date.now() - stepStart;
        logs.push({ step: i + 1, modelRef: stepRef, status: "fail", error: err?.message || "Falhou", latencyMs: latency });
      }
    }

    const totalDuration = Date.now() - startTime;

    return NextResponse.json({
      success,
      finalModelUsed,
      finalResponse,
      totalDurationMs: totalDuration,
      steps: logs,
    });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err?.message || "Erro no teste de cascata." }, { status: 500 });
  }
}
