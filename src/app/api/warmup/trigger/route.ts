import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { triggerManualWarmup } from "@/lib/warmup/warmup-worker";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;

  const clientId = auth.clientId;

  try {
    const { instanceA, instanceB } = await req.json();

    if (!instanceA || !instanceB) {
      return NextResponse.json(
        { success: false, error: "Selecione duas instâncias para o teste de maturação." },
        { status: 400 }
      );
    }

    if (instanceA === instanceB) {
      return NextResponse.json(
        { success: false, error: "As instâncias remetente e destinatária devem ser diferentes." },
        { status: 400 }
      );
    }

    const result = await triggerManualWarmup(clientId, instanceA, instanceB);

    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error || result.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, message: result.message });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}

