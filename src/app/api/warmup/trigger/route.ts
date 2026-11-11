import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import {
  triggerManualWarmup,
  triggerMutualWarmup,
  enablePairAutopilot,
  enableSwarmAutopilot,
  triggerSwarmCycle,
} from "@/lib/warmup/warmup-worker";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;

  const clientId = auth.clientId;

  try {
    const body = await req.json();
    const {
      instanceA,
      instanceB,
      instanceNames,
      testStatusPost,
      mutual,
      autopilot,
      swarmAutopilot,
      swarmCycle,
    } = body;

    // 1. Ativação da Colmeia Autônoma para N Chips (One-Click)
    if (swarmAutopilot) {
      const result = await enableSwarmAutopilot(clientId, instanceNames);
      if (!result.success) {
        return NextResponse.json({ success: false, error: result.error || result.message }, { status: 400 });
      }
      return NextResponse.json({
        success: true,
        message: result.message,
        chipsActivated: result.chipsActivated,
      });
    }

    // 2. Disparo de Rodada Completa na Colmeia (Swarm Cycle)
    if (swarmCycle) {
      const result = await triggerSwarmCycle(clientId, instanceNames);
      if (!result.success) {
        return NextResponse.json({ success: false, error: result.error || result.message }, { status: 400 });
      }
      return NextResponse.json({
        success: true,
        message: result.message,
        roundsExecuted: result.roundsExecuted,
      });
    }

    // 3. Validação para operações em pares específicos
    if (!instanceA || !instanceB) {
      return NextResponse.json(
        { success: false, error: "Selecione duas instâncias para a operação de maturação." },
        { status: 400 }
      );
    }

    if (instanceA === instanceB) {
      return NextResponse.json(
        { success: false, error: "As instâncias remetente e destinatária devem ser chips diferentes." },
        { status: 400 }
      );
    }

    // Se a solicitação for ativar piloto automático para o par
    if (autopilot) {
      const result = await enablePairAutopilot(clientId, instanceA, instanceB);
      if (!result.success) {
        return NextResponse.json({ success: false, error: result.error || result.message }, { status: 400 });
      }
      return NextResponse.json({ success: true, message: result.message });
    }

    // Se for aquecimento mútuo simultâneo
    if (mutual) {
      const result = await triggerMutualWarmup(clientId, instanceA, instanceB, Boolean(testStatusPost));
      if (!result.success) {
        return NextResponse.json({ success: false, error: result.error || result.message }, { status: 400 });
      }
      return NextResponse.json({ success: true, message: result.message, details: result.details });
    }

    // Disparo pontual padrão
    const result = await triggerManualWarmup(clientId, instanceA, instanceB, Boolean(testStatusPost));

    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error || result.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, message: result.message });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}


