import { NextRequest, NextResponse } from "next/server";
import { bulkSyncProfilePics } from "@/lib/channel";
import { requireClientId } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { getPhotoJid } from "@/lib/whatsapp-photo-utils";
import { PhotoError, refreshPhotos, resolvePhotoConnection } from "@/lib/whatsapp-photos";

export const dynamic = "force-dynamic";
const BATCH_SIZE = 40;

type SyncInput = { instance?: string; scope?: "leads" | "contacts"; cursor?: number; upperId?: number };

function parseInput(body: unknown): SyncInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PhotoError("Corpo JSON inválido.", 400);
  const input = body as Record<string, unknown>;
  if (input.instance !== undefined && (typeof input.instance !== "string" || !input.instance.trim() || input.instance.length > 200)) throw new PhotoError("Instância inválida.", 400);
  if (input.scope !== undefined && input.scope !== "leads" && input.scope !== "contacts") throw new PhotoError("Escopo inválido.", 400);
  for (const key of ["cursor", "upperId"]) {
    if (input[key] !== undefined && (!Number.isSafeInteger(input[key]) || (input[key] as number) < 0 || (input[key] as number) > 2147483647)) throw new PhotoError("Cursor inválido.", 400);
  }
  if (typeof input.cursor === "number" && typeof input.upperId === "number" && input.cursor > input.upperId) throw new PhotoError("Cursor inválido.", 400);
  return input as SyncInput;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;
    const input = parseInput(await req.json().catch(() => null));
    const connection = await resolvePhotoConnection(auth.clientId, input.instance);
    if (input.scope !== "leads") {
      const updated = await bulkSyncProfilePics(connection.instance_name, auth.clientId);
      return NextResponse.json({ success: true, updated, instance: connection.instance_name });
    }

    let upperId = input.upperId;
    if (upperId === undefined) {
      const latest = await supabaseAdmin.from("leads_extraidos").select("id")
        .eq("client_id", auth.clientId).order("id", { ascending: false }).limit(1).maybeSingle();
      if (latest.error) throw latest.error;
      upperId = latest.data?.id ?? 0;
    }
    const totalQuery = await supabaseAdmin.from("leads_extraidos").select("id", { count: "exact", head: true })
      .eq("client_id", auth.clientId).lte("id", upperId);
    if (totalQuery.error) throw totalQuery.error;
    const page = await supabaseAdmin.from("leads_extraidos").select('id, telefone, "remoteJid"')
      .eq("client_id", auth.clientId).gt("id", input.cursor ?? 0).lte("id", upperId)
      .order("id", { ascending: true }).limit(BATCH_SIZE + 1);
    if (page.error) throw page.error;
    const leads = (page.data ?? []).slice(0, BATCH_SIZE);
    const jids = [...new Set(leads.map((lead) => getPhotoJid(lead.remoteJid) ?? getPhotoJid(lead.telefone)).filter((jid): jid is string => jid !== null))];
    const result = await refreshPhotos(auth.clientId, connection, jids, { signal: req.signal });
    // Progresso conta registros de leads; duplicados e números inválidos são ignorados.
    return NextResponse.json({
      ...result, success: result.failed === 0, partial: result.failed > 0,
      processed: leads.length, skipped: result.skipped + leads.length - jids.length,
      total: totalQuery.count ?? 0, upperId,
      nextCursor: !result.cancelled && (page.data?.length ?? 0) > BATCH_SIZE ? leads[leads.length - 1].id : null,
      instance: connection.instance_name,
    });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof PhotoError ? error.message : "Não foi possível sincronizar as fotos." }, { status: error instanceof PhotoError ? error.status : 500 });
  }
}
