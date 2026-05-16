import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { verifySession } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const session = await verifySession(req);
  if (!session) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  try {
    const { remoteJid, nome_negocio, status, categoria } = await req.json();

    if (!remoteJid) {
      return NextResponse.json({ error: "remoteJid é obrigatório" }, { status: 400 });
    }

    const payload = { 
      client_id: session.clientId,
      remoteJid, 
      nome_negocio: nome_negocio || "", 
      status: status || "novo", 
      ramo_negocio: categoria || "SDR",
      updated_at: new Date().toISOString()
    };

    const { data: existing } = await supabase
      .from("leads_extraidos")
      .select("id")
      .eq("client_id", session.clientId)
      .eq("remoteJid", remoteJid)
      .maybeSingle();

    let result;
    if (existing) {
      result = await supabase
        .from("leads_extraidos")
        .update(payload)
        .eq("id", existing.id)
        .eq("client_id", session.clientId)
        .select();
    } else {
      result = await supabase
        .from("leads_extraidos")
        .insert({ ...payload })
        .select();
    }

    const { data, error } = result;

    if (error) {
      console.error("[SAVE-LEAD] Erro Supabase:", error.message);
      return NextResponse.json({ error: "Erro ao salvar na base de leads", details: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, data });
  } catch (err: any) {
    console.error("[SAVE-LEAD] Erro crítico:", err.message);
    return NextResponse.json({ error: "Erro interno", details: err.message }, { status: 500 });
  }
}
