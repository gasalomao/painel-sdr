import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { verifySession } from "@/lib/auth";

/**
 * POST /api/leads/save
 *
 * Cria ou atualiza um lead. Aceita todos os campos das variáveis de template
 * (renderTemplate em /lib/template-vars) pra cobrir o caso de uso real:
 * cliente veio pelo WhatsApp (não pelo captador), só tem telefone — usuário
 * preenche manualmente nome, ramo, endereço, etc. depois.
 *
 * Status é OPCIONAL: se não vier, mantém o status atual (pra cliente comum
 * só editar dados sem ter que "mover no kanban").
 *
 * Body:
 *   - remoteJid (obrigatório)
 *   - nome_negocio?, ramo_negocio?, telefone?, endereco?, website?,
 *     avaliacao?, reviews?, categoria? (alias de ramo_negocio)
 *   - status?               — só passa se quiser mover no funil
 *   - skip_status_change?   — se true, NUNCA mexe no status mesmo se vier valor
 */
export async function POST(req: NextRequest) {
  const session = await verifySession(req);
  if (!session) {
    return NextResponse.json({ error: "Não autorizado" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const {
      remoteJid,
      nome_negocio,
      ramo_negocio,
      categoria, // alias antigo de ramo_negocio
      telefone,
      email,
      endereco,
      website,
      avaliacao,
      reviews,
      observacoes,
      instagram,
      facebook,
      status,
      skip_status_change,
    } = body || {};

    if (!remoteJid) {
      return NextResponse.json({ error: "remoteJid é obrigatório" }, { status: 400 });
    }

    // Procura lead existente
    const { data: existing } = await supabase
      .from("leads_extraidos")
      .select("id, status, ramo_negocio, nome_negocio, telefone, endereco, website")
      .eq("client_id", session.clientId)
      .eq("remoteJid", remoteJid)
      .maybeSingle();

    // Monta patch: só inclui o campo se ele veio no body (undefined = não mexer)
    const patch: Record<string, any> = {
      updated_at: new Date().toISOString(),
    };

    if (typeof nome_negocio === "string")            patch.nome_negocio = nome_negocio;
    const finalRamo = ramo_negocio ?? categoria;
    if (typeof finalRamo === "string")               patch.ramo_negocio = finalRamo;
    if (typeof telefone === "string")                patch.telefone = telefone;
    if (typeof email === "string")                   patch.email = email.trim().toLowerCase() || null;
    if (typeof endereco === "string")                patch.endereco = endereco;
    if (typeof website === "string")                 patch.website = website;
    if (typeof avaliacao !== "undefined")            patch.avaliacao = avaliacao;
    if (typeof reviews !== "undefined")              patch.reviews = reviews;
    if (typeof observacoes === "string")             patch.observacoes = observacoes;
    if (typeof instagram === "string")               patch.instagram = instagram;
    if (typeof facebook === "string")                patch.facebook = facebook;

    // Status só muda se: 1) veio no body 2) skip_status_change não é true.
    // Pra criar lead novo precisa de status (default "novo").
    const shouldChangeStatus = !skip_status_change && typeof status === "string";
    if (shouldChangeStatus) patch.status = status;

    // Helper de retry — se a migration 008 ainda não rodou, remove email/
    // observacoes do payload e tenta de novo. App nunca quebra por isso.
    const isMissingCol = (err: any) =>
      err?.code === "PGRST204" ||
      /column .* of 'leads_extraidos'/i.test(String(err?.message || "")) ||
      /Could not find the .* column/i.test(String(err?.message || ""));
    const stripNew = (p: Record<string, any>) => {
      const x = { ...p };
      for (const k of ["email", "observacoes"]) delete x[k];
      return x;
    };

    let result;
    if (existing) {
      const r1 = await supabase
        .from("leads_extraidos")
        .update(patch)
        .eq("id", existing.id)
        .eq("client_id", session.clientId)
        .select()
        .single();
      if (r1.error && isMissingCol(r1.error)) {
        console.warn("[SAVE-LEAD] Migration 008 não aplicada — gravando sem email/observacoes");
        result = await supabase
          .from("leads_extraidos")
          .update(stripNew(patch))
          .eq("id", existing.id)
          .eq("client_id", session.clientId)
          .select()
          .single();
      } else {
        result = r1;
      }
    } else {
      // Nunca grava nome vazio (vira lead "sem nome", identificável só pelo
      // telefone). Sem nome explícito, usa o push_name do contato; por fim, um
      // rótulo legível com o telefone. O webhook depois auto-cura com o nome
      // real do WhatsApp quando a pessoa interage.
      let fallbackName = (patch.nome_negocio ?? "").trim();
      if (!fallbackName) {
        const { data: ct } = await supabase
          .from("contacts")
          .select("push_name")
          .eq("remote_jid", remoteJid)
          .maybeSingle();
        const phone = String(remoteJid).replace(/@.*$/, "").replace(/\D/g, "");
        fallbackName = (ct?.push_name || "").trim() || `Lead WhatsApp (${phone})`;
      }
      const insertPayload: Record<string, any> = {
        client_id: session.clientId,
        remoteJid,
        nome_negocio: fallbackName,
        status: patch.status ?? "novo",
        ramo_negocio: patch.ramo_negocio ?? "SDR",
        telefone: patch.telefone ?? null,
        email: patch.email ?? null,
        endereco: patch.endereco ?? null,
        website: patch.website ?? null,
        avaliacao: patch.avaliacao ?? null,
        reviews: patch.reviews ?? null,
        observacoes: patch.observacoes ?? null,
        instagram: patch.instagram ?? null,
        facebook: patch.facebook ?? null,
        updated_at: patch.updated_at,
      };
      const r1 = await supabase
        .from("leads_extraidos")
        .insert(insertPayload)
        .select()
        .single();
      if (r1.error && isMissingCol(r1.error)) {
        console.warn("[SAVE-LEAD] Migration 008 não aplicada — INSERT sem email/observacoes");
        result = await supabase
          .from("leads_extraidos")
          .insert(stripNew(insertPayload))
          .select()
          .single();
      } else {
        result = r1;
      }
    }

    const { data, error } = result;

    if (error) {
      console.error("[SAVE-LEAD] Erro Supabase:", error.message);
      return NextResponse.json({ error: "Erro ao salvar na base de leads", details: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true, data, moved: shouldChangeStatus });
  } catch (err: any) {
    console.error("[SAVE-LEAD] Erro crítico:", err.message);
    return NextResponse.json({ error: "Erro interno", details: err.message }, { status: 500 });
  }
}
