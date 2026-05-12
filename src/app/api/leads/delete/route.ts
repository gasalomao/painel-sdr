import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

function buildFilterQuery(search: string | null, category: string | null) {
  let q = supabase.from("leads_extraidos");
  let sel: any = q.select("id, remoteJid");
  if (search) {
    sel = sel.or(
      `nome_negocio.ilike.%${search}%,ramo_negocio.ilike.%${search}%,telefone.ilike.%${search}%`
    );
  }
  if (category && category !== "all") {
    sel = sel.eq("ramo_negocio", category);
  }
  return sel;
}

export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const idsParam = searchParams.get("ids");
    const id = searchParams.get("id");
    const mode = searchParams.get("mode"); // "lead_only" ou "all"
    const remoteJid = searchParams.get("remoteJid");
    const remoteJidsParam = searchParams.get("remoteJids");
    const allMatching = searchParams.get("allMatching") === "1";
    const search = searchParams.get("search");
    const category = searchParams.get("category");

    let ids: string[] = [];
    let jids: string[] = [];

    if (allMatching) {
      // Busca todos os IDs (e remoteJids) que batem com os filtros atuais.
      // Paginado para não estourar limite default do Supabase (1000 por página).
      const pageSize = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await buildFilterQuery(search, category).range(
          from,
          from + pageSize - 1
        );
        if (error) throw error;
        if (!data || data.length === 0) break;
        for (const row of data) {
          ids.push(String(row.id));
          if (row.remoteJid) jids.push(row.remoteJid);
        }
        if (data.length < pageSize) break;
        from += pageSize;
      }
    } else {
      ids = idsParam
        ? idsParam.split(",").map((v) => v.trim()).filter(Boolean)
        : id
        ? [id]
        : [];
      jids = remoteJidsParam
        ? remoteJidsParam.split(",").map((v) => v.trim()).filter(Boolean)
        : remoteJid
        ? [remoteJid]
        : [];
    }

    if (ids.length === 0) {
      return NextResponse.json(
        { error: "Nenhum lead encontrado para exclusão." },
        { status: 400 }
      );
    }

    // Delete em chunks para evitar URLs/queries gigantes.
    const chunkSize = 500;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const { error: err1 } = await supabase
        .from("leads_extraidos")
        .delete()
        .in("id", chunk);
      if (err1) throw err1;
    }

    if (mode === "all" && jids.length > 0) {
      for (let i = 0; i < jids.length; i += chunkSize) {
        const chunk = jids.slice(i, i + chunkSize);
        await supabase.from("chats_dashboard").delete().in("remote_jid", chunk);
        await supabase
          .from("historico_ia_leads")
          .delete()
          .in("remote_jid", chunk);
      }
    }

    return NextResponse.json({ success: true, deleted: ids.length });
  } catch (err: any) {
    console.error("Erro deletando lead:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
