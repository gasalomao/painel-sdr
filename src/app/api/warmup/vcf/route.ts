import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { requireFeatureAccess } from "@/lib/saas-limits";
import {
  ensureWarmupConfigsForTenant,
  readTenantWarmupConfigs,
} from "@/lib/warmup/warmup-config-service";
import { buildClusterVcfContent } from "@/lib/warmup/warmup-groups";

export const dynamic = "force-dynamic";

/**
 * Exporta um arquivo vCard (.vcf) único contendo todos os números conectados da conta
 * para importação com 1 clique na agenda do celular e elevação imediata do Score de Confiança.
 */
export async function GET(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  const denied = requireFeatureAccess(auth, "aquecer_chips");
  if (denied) return denied;

  try {
    const [{ connections }, { configs }] = await Promise.all([
      ensureWarmupConfigsForTenant(auth.clientId),
      readTenantWarmupConfigs(auth.clientId),
    ]);

    const chips = connections.map((conn) => {
      const cfg = configs[conn.instance_name];
      return {
        instanceName: conn.instance_name,
        phoneNumber: cfg?.phone_number || conn.phone_number || null,
      };
    });

    const vcf = buildClusterVcfContent(chips);
    if (!vcf) {
      return NextResponse.json(
        { success: false, error: "Nenhum número conectado com telefone identificado para exportar." },
        { status: 404 }
      );
    }

    return new NextResponse(vcf, {
      status: 200,
      headers: {
        "Content-Type": "text/vcard; charset=utf-8",
        "Content-Disposition": 'attachment; filename="agenda-chips-colmeia.vcf"',
        "Cache-Control": "no-store",
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : "Erro ao gerar agenda .vcf";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
