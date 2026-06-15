/**
 * /api/leads/create  POST
 *
 * Cria um lead novo manualmente — usado pelo botão "+ Adicionar Lead" no
 * kanban (/leads) e pelo "Salvar como lead" no chat (quando o número não
 * está em leads_extraidos).
 *
 * Body:
 *   - nome_negocio       (obrigatório)
 *   - telefone OU remoteJid (pelo menos um — se telefone, vira <num>@s.whatsapp.net)
 *   - ramo_negocio?      (opcional)
 *   - endereco?, status?, instance_name?, lead_type?, notas?
 *
 * Multi-tenant: lead fica vinculado ao client_id do solicitante. Se já existe
 * lead com mesmo remoteJid+client_id, retorna 409 (caller decide se UPDATE).
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/** Normaliza telefone (só dígitos) → JID WhatsApp. Aceita "+", "(", ")", "-", " ". */
function toRemoteJid(input: string): string | null {
  if (!input) return null;
  if (input.includes("@")) return input.trim(); // já é JID
  const digits = input.replace(/\D/g, "");
  if (digits.length < 10) return null; // muito curto pra ser válido
  return `${digits}@s.whatsapp.net`;
}

export async function POST(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const {
    nome_negocio,
    telefone,
    remoteJid: jidIn,
    ramo_negocio,
    endereco,
    status,
    instance_name,
    lead_type,
    notas,
    // Variáveis avançadas (preenchidas no AddLeadDialog quando lead veio do
    // WhatsApp espontâneo) — alimentam {website}, {email}, {avaliacao}, etc.
    website,
    email,
    avaliacao,
    reviews,
    categoria,
  } = body || {};

  if (!nome_negocio || !String(nome_negocio).trim()) {
    return NextResponse.json({ ok: false, error: "nome_negocio é obrigatório" }, { status: 400 });
  }

  const jid = toRemoteJid(jidIn || telefone || "");
  if (!jid) {
    return NextResponse.json(
      { ok: false, error: "Informe telefone (com DDD) ou remoteJid válido" },
      { status: 400 }
    );
  }

  // Verifica se já existe lead pra esse JID nesse cliente.
  const { data: existing } = await supabaseAdmin
    .from("leads_extraidos")
    .select("id, status, nome_negocio")
    .eq("client_id", auth.clientId)
    .eq("remoteJid", jid)
    .maybeSingle();

  if (existing) {
    return NextResponse.json(
      {
        ok: false,
        error: `Já existe lead pra esse número (${existing.nome_negocio || "sem nome"}, status: ${existing.status})`,
        existing,
      },
      { status: 409 }
    );
  }

  // Parse robusto pra avaliacao (Número decimal) e reviews (inteiro) — vêm
  // como string do form. NaN → null.
  const parsedAvaliacao = (() => {
    if (!avaliacao) return null;
    const n = Number(String(avaliacao).replace(",", "."));
    return Number.isFinite(n) ? n : null;
  })();
  const parsedReviews = (() => {
    if (!reviews) return null;
    const n = Number(String(reviews).replace(/\D/g, ""));
    return Number.isFinite(n) ? n : null;
  })();

  const insertPayload: Record<string, any> = {
    client_id: auth.clientId,
    remoteJid: jid,
    nome_negocio: String(nome_negocio).trim(),
    telefone: telefone ? String(telefone).trim() : jid.replace("@s.whatsapp.net", "").replace("@g.us", ""),
    ramo_negocio: ramo_negocio ? String(ramo_negocio).trim() : null,
    endereco: endereco ? String(endereco).trim() : null,
    status: status || "novo",
    instance_name: instance_name || null,
    lead_type: lead_type || null,
    primeiro_contato_source: "manual",
    primeiro_contato_at: new Date().toISOString(),
    notas: notas ? String(notas).trim() : null,
  };
  if (website && String(website).trim()) insertPayload.website = String(website).trim();
  if (email && String(email).trim()) insertPayload.email = String(email).trim();
  if (parsedAvaliacao !== null) insertPayload.avaliacao = parsedAvaliacao;
  if (parsedReviews !== null) insertPayload.reviews = parsedReviews;
  if (categoria && String(categoria).trim()) insertPayload.categoria = String(categoria).trim();

  const { data, error } = await supabaseAdmin
    .from("leads_extraidos")
    .insert(insertPayload)
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ ok: false, error: "Lead duplicado" }, { status: 409 });
    }
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ok: true, lead: data });
}
