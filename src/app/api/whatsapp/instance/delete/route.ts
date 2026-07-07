/**
 * POST /api/whatsapp/instance/delete
 *
 * Apaga uma instância de WhatsApp. Dois MODOS:
 *
 *   1. DEFAULT (purgeMessages=false): apaga só a REFERÊNCIA da instância.
 *      Mantém TODAS as mensagens, contatos e leads — vinculados ao número
 *      via remote_jid. Use quando a instância buga e você quer recriar/
 *      reconectar o MESMO número sem perder histórico. Quando reconectar
 *      (mesmo que com outro nome de instância), o /chat agrupa por
 *      remote_jid + owner_phone e o usuário vê a conversa unificada.
 *
 *   2. PURGE TOTAL (purgeMessages=true): cascade delete completo —
 *      apaga instância + mensagens + sessões + logs. Use quando quer
 *      ZERAR de verdade aquele número (cliente foi embora, etc).
 *      Contatos e leads SEGUEM preservados (existem independente).
 *
 * SEMPRE deletado (qualquer modo):
 *   - Instância na Evolution VPS (best-effort)
 *   - channel_connections (row da instância)
 *
 * SEGURANÇA:
 *   - Ownership: cliente comum só apaga instância DELE. Admin apaga qualquer.
 *   - Default REFUSA apagar instância com status="open". UI passa force=true.
 *
 * Body: { instanceName: string, force?: boolean, purgeMessages?: boolean }
 * Resposta: { ok, deleted: { chats, sessions, logs }, evolution, mode }
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId, invalidateInstanceCache } from "@/lib/tenant";
import { evolution } from "@/lib/evolution";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const instanceName: string | undefined = body.instanceName?.trim();
  const force: boolean = !!body.force;
  const purgeMessages: boolean = !!body.purgeMessages; // default false — preserva histórico

  if (!instanceName) {
    return NextResponse.json({ ok: false, error: "instanceName obrigatório" }, { status: 400 });
  }

  // 1) Ownership
  const { data: conn } = await supabaseAdmin
    .from("channel_connections")
    .select("instance_name, client_id, status, provider, provider_config")
    .eq("instance_name", instanceName)
    .maybeSingle();

  if (!conn) {
    return NextResponse.json({ ok: false, error: "Instância não existe no banco" }, { status: 404 });
  }
  if (!auth.isAdmin && conn.client_id !== auth.clientId) {
    return NextResponse.json({ ok: false, error: "Instância não pertence a este cliente" }, { status: 403 });
  }

  // 2) Refusa apagar conectada sem force
  if (conn.status === "open" && !force) {
    return NextResponse.json(
      {
        ok: false,
        error: "INSTANCE_CONNECTED",
        message:
          "Instância está CONECTADA. Desconecte primeiro (botão Desconectar em /whatsapp) ou re-envie com force=true pra forçar.",
      },
      { status: 409 }
    );
  }

  // 3) Conta o que vai ser deletado (pro feedback no front)
  const [chatsCnt, sessionsCnt, logsCnt] = await Promise.all([
    supabaseAdmin.from("chats_dashboard").select("id", { count: "exact", head: true }).eq("instance_name", instanceName),
    supabaseAdmin.from("sessions").select("id", { count: "exact", head: true }).eq("instance_name", instanceName),
    supabaseAdmin.from("webhook_logs").select("id", { count: "exact", head: true }).eq("instance_name", instanceName),
  ]);
  const counts = {
    chats: chatsCnt.count || 0,
    sessions: sessionsCnt.count || 0,
    logs: logsCnt.count || 0,
  };

  // 4) Tenta apagar da Evolution VPS — best-effort. Se falhar (ex: já não
  //    existe lá, ou Evolution offline), prossegue com cleanup do banco.
  let evolutionOk = false;
  let evolutionError: string | null = null;
  if (conn.provider === "evolution") {
    try {
      await evolution.deleteInstance(instanceName);
      evolutionOk = true;
    } catch (e: any) {
      evolutionError = String(e?.message || e).slice(0, 200);
      console.warn(`[delete] Evolution deleteInstance falhou (continuando):`, evolutionError);
    }
  } else {
    // WhatsApp Cloud: não tem "delete" externo — só o registro local.
    evolutionOk = true;
  }

  // 5) Cleanup no banco
  const errors: any[] = [];

  const drop = async (
    table: string,
    column: string,
    label: string
  ) => {
    const { error } = await supabaseAdmin!.from(table).delete().eq(column, instanceName);
    if (error) errors.push({ step: label, error: error.message });
  };

  // PURGE MODE: mata também mensagens/sessões/logs.
  // DEFAULT: preserva tudo isso. Quando o número for reconectado, o
  // /chat agrupa por remote_jid + owner_phone e o histórico aparece junto.
  if (purgeMessages) {
    await drop("chats_dashboard", "instance_name", "chats_dashboard");
    await drop("sessions", "instance_name", "sessions");
    await drop("webhook_logs", "instance_name", "webhook_logs");
  } else {
    // Modo preservação: mapeia o instance_name antigo para o owner_phone (se disponível)
    // para que a reconexão futura do mesmo número resgate o histórico automaticamente.
    const phone = conn.provider_config?.owner_phone || conn.provider_config?.owner_jid?.replace(/\D/g, "");
    if (phone) {
      const phoneInstanceName = `phone:${phone}`;
      console.log(`[delete] Mapeando histórico da instância ${instanceName} para ${phoneInstanceName}`);
      await Promise.all([
        supabaseAdmin.from("chats_dashboard").update({ instance_name: phoneInstanceName }).eq("instance_name", instanceName),
        supabaseAdmin.from("sessions").update({ instance_name: phoneInstanceName }).eq("instance_name", instanceName),
        supabaseAdmin.from("messages").update({ instance_name: phoneInstanceName }).eq("instance_name", instanceName),
      ]);
    }
  }

  // channel_connections: SEMPRE deleta (é o que torna a instância "instância")
  // Filtra por client_id pra blindar contra cross-tenant.
  {
    let q = supabaseAdmin.from("channel_connections").delete().eq("instance_name", instanceName);
    if (!auth.isAdmin) q = q.eq("client_id", auth.clientId);
    const { error } = await q;
    if (error) errors.push({ step: "channel_connections", error: error.message });
  }

  // 6) Invalida cache de instance→client (próximo webhook precisa re-resolver)
  invalidateInstanceCache(instanceName);

  // 7) Audit log do delete (não fatal se falhar)
  await supabaseAdmin.from("webhook_logs").insert({
    client_id: conn.client_id,
    instance_name: "system",
    event: "INSTANCE_DELETED",
    payload: {
      deleted_instance: instanceName,
      deleted_by: auth.claims.email || auth.clientId,
      is_admin: auth.isAdmin,
      mode: purgeMessages ? "purge_all" : "instance_only",
      counts: purgeMessages ? counts : { chats: 0, sessions: 0, logs: 0, preserved_chats: counts.chats, preserved_sessions: counts.sessions },
      evolution_ok: evolutionOk,
      evolution_error: evolutionError,
      force_used: force,
    },
    created_at: new Date().toISOString(),
  }).then(() => {}, () => {});

  const responseDeleted = purgeMessages
    ? counts
    : { chats: 0, sessions: 0, logs: 0, preserved_chats: counts.chats, preserved_sessions: counts.sessions };

  if (errors.length > 0) {
    return NextResponse.json({
      ok: false,
      error: "Cleanup parcial — alguns deletes falharam",
      details: errors,
      deleted: responseDeleted,
      mode: purgeMessages ? "purge_all" : "instance_only",
      evolution: evolutionOk,
    }, { status: 500 });
  }

  return NextResponse.json({
    ok: true,
    mode: purgeMessages ? "purge_all" : "instance_only",
    deleted: responseDeleted,
    evolution: evolutionOk,
    evolution_error: evolutionError,
  });
}
