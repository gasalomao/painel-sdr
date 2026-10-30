import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { buildLeadMapsKitArchive } from "@/lib/lead-maps-kit";
import { getPhotoJid } from "@/lib/whatsapp-photo-utils";
import { readPhotoCache } from "@/lib/whatsapp-photos";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;

    const { id } = await context.params;
    if (!id) {
      return NextResponse.json({ error: "ID do lead é obrigatório" }, { status: 400 });
    }

    const { data: lead, error } = await supabaseAdmin
      .from("leads_extraidos")
      .select("*")
      .eq("id", id)
      .eq("client_id", auth.clientId)
      .maybeSingle();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (!lead) {
      return NextResponse.json({ error: "Lead não encontrado" }, { status: 404 });
    }

    let profilePicUrl: string | null = null;
    const jid = getPhotoJid(lead.remoteJid) ?? getPhotoJid(lead.telefone);
    if (jid) {
      try {
        profilePicUrl = (await readPhotoCache(auth.clientId, [jid])).get(jid)?.url ?? null;
      } catch {
        // Ignora erro de leitura de cache de foto
      }
    }

    const skipLiveScrape = req.nextUrl.searchParams.get("skipLiveScrape") === "1";

    const kit = await buildLeadMapsKitArchive({
      lead: {
        ...lead,
        profilePicUrl,
      },
      skipLiveScrape,
    });

    // Persiste de forma assíncrona (best-effort) os dados enriquecidos do Maps no banco
    try {
      await supabaseAdmin
        .from("leads_extraidos")
        .update(kit.dbPatch)
        .eq("id", id)
        .eq("client_id", auth.clientId);
    } catch {
      // Ignora erro caso banco antigo não tenha alguma coluna JSONB
    }

    return new NextResponse(new Uint8Array(kit.buffer), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${kit.fileName}"`,
        "Content-Length": String(kit.buffer.byteLength),
        "X-Photo-Count": String(kit.photoCount),
        "X-File-Name": kit.fileName,
        "Cache-Control": "no-store",
      },
    });
  } catch (err: unknown) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Erro ao gerar pacote do Google Maps" },
      { status: 500 }
    );
  }
}

