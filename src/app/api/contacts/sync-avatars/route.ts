/**
 * /api/contacts/sync-avatars
 *
 * POST { instance?: string }
 *   → Sincroniza TODAS as fotos de perfil de uma instância em bulk.
 *   Usa os endpoints de contatos da Evolution API/GO (muito mais eficiente
 *   que buscar foto por foto).
 *
 * Retorna { success, updated, instance }.
 */

import { NextRequest, NextResponse } from "next/server";
import { bulkSyncProfilePics } from "@/lib/channel";
import { getEvolutionConfig } from "@/lib/evolution";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;
    const body = await req.json().catch(() => ({}));
    const instance = body.instance || (await getEvolutionConfig()).instance;
    if (!instance) {
      return NextResponse.json(
        { success: false, error: "Nenhuma instância configurada." },
        { status: 400 }
      );
    }
    const updated = await bulkSyncProfilePics(instance);
    return NextResponse.json({ success: true, updated, instance });
  } catch (e: any) {
    return NextResponse.json(
      { success: false, error: e?.message || String(e) },
      { status: 500 }
    );
  }
}
