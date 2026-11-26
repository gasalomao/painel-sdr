import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { requireWarmupAdminAccess } from "@/lib/warmup/warmup-admin-guard";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { evolution } from "@/lib/evolution";
import {
  cleanupDeadWarmupGroups,
  discoverExistingGroupsForChip,
  importWarmupGroups,
  isWarmupGroupDead,
  runInternalSwarmGroupCycle,
  syncGroupMembershipForChips,
} from "@/lib/warmup/warmup-groups";
import type { WarmupGroupMember } from "@/lib/warmup/warmup-types";

export const dynamic = "force-dynamic";

/**
 * GET /api/warmup/groups
 * Retorna os grupos cadastrados do tenant com seus membros e estatísticas.
 */
export async function GET(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  const denied = requireWarmupAdminAccess(auth);
  if (denied) return denied;
  const clientId = auth.clientId;

  try {
    const { data: groups, error: groupsErr } = await supabaseAdmin
      .from("whatsapp_warmup_groups")
      .select("*")
      .eq("client_id", clientId)
      .order("created_at", { ascending: false });

    if (groupsErr) {
      return NextResponse.json({ success: false, error: groupsErr.message }, { status: 500 });
    }

    const { data: members } = await supabaseAdmin
      .from("whatsapp_warmup_group_members")
      .select("*")
      .eq("client_id", clientId);

    const membersByGroup = new Map<string, WarmupGroupMember[]>();
    for (const m of members || []) {
      const list = membersByGroup.get(m.group_id) || [];
      list.push(m);
      membersByGroup.set(m.group_id, list);
    }

    const enriched = (groups || []).map((g) => ({
      ...g,
      is_dead: isWarmupGroupDead(g),
      members: membersByGroup.get(g.id) || [],
    }));

    return NextResponse.json({ success: true, groups: enriched });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

/**
 * POST /api/warmup/groups
 * Ações:
 * 1. Importação em lote de links: { links: "...", preferredInstance?: "..." }
 * 2. Sincronização / Ingressão escalonada: { action: "sync_members" }
 */
export async function POST(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  const denied = requireWarmupAdminAccess(auth);
  if (denied) return denied;
  const clientId = auth.clientId;

  try {
    const body = await req.json();

    if (body.action === "sync_members") {
      const syncRes = await syncGroupMembershipForChips(clientId);
      return NextResponse.json({
        success: true,
        message: `Sincronização concluída. ${syncRes.joinedCount} conexões realizadas com sucesso.`,
        errors: syncRes.errors,
      });
    }

    if (body.action === "discover_existing") {
      const instanceName = String(body.instance_name || body.preferredInstance || "").trim();
      if (!instanceName) {
        return NextResponse.json({ success: false, error: "instance_name é obrigatório." }, { status: 400 });
      }
      const res = await discoverExistingGroupsForChip(clientId, instanceName);
      return NextResponse.json({
        success: true,
        discovered: res.discovered,
        errors: res.errors,
        message: `${res.discovered} grupo(s) existente(s) importado(s) do chip ${instanceName}.`,
      });
    }

    if (body.action === "create_internal_swarm") {
      const res = await runInternalSwarmGroupCycle(clientId);
      return NextResponse.json({
        success: true,
        created: res.created,
        posted: res.posted,
        message: `Grupos internos da colmeia: ${res.created} criado(s), ${res.posted} interação(ões).`,
      });
    }

    if (body.action === "cleanup_dead") {
      const deadHours = Number(body.dead_hours || 120);
      const res = await cleanupDeadWarmupGroups(clientId, Date.now(), deadHours);
      return NextResponse.json({
        success: true,
        leftGroups: res.leftGroups,
        message: `${res.leftGroups} grupo(s) inativo(s) removido(s) automaticamente.`,
      });
    }

    const rawLinks = body.links || body.invite_url || "";
    if (!rawLinks || typeof rawLinks !== "string" || !rawLinks.trim()) {
      return NextResponse.json(
        { success: false, error: "Envie ao menos um link de grupo de WhatsApp." },
        { status: 400 }
      );
    }

    const preferredInstance = body.preferredInstance || body.instance_name;
    const importRes = await importWarmupGroups(clientId, rawLinks, preferredInstance);

    // Se a opção autoSync foi enviada, tenta sincronizar a entrada dos chips logo em seguida
    let syncRes = null;
    if (body.autoSync && importRes.added > 0) {
      syncRes = await syncGroupMembershipForChips(clientId);
    }

    return NextResponse.json({
      success: true,
      added: importRes.added,
      existing: importRes.existing,
      totalParsed: importRes.totalParsed,
      sync: syncRes,
      errors: importRes.errors,
      message: `${importRes.added} novo(s) grupo(s) adicionado(s) com sucesso.`,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

/**
 * DELETE /api/warmup/groups
 * Exclui o grupo e desconecta os chips do grupo se requisitado.
 */
export async function DELETE(req: NextRequest) {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  const denied = requireWarmupAdminAccess(auth);
  if (denied) return denied;
  const clientId = auth.clientId;

  try {
    const { searchParams } = new URL(req.url);
    const groupId = searchParams.get("id");

    if (!groupId) {
      return NextResponse.json({ success: false, error: "ID do grupo não informado." }, { status: 400 });
    }

    // Busca grupo e membros para sair se tiver JID
    const { data: group } = await supabaseAdmin
      .from("whatsapp_warmup_groups")
      .select("group_jid")
      .eq("id", groupId)
      .eq("client_id", clientId)
      .maybeSingle();

    if (group?.group_jid) {
      const { data: members } = await supabaseAdmin
        .from("whatsapp_warmup_group_members")
        .select("instance_name")
        .eq("group_id", groupId)
        .eq("client_id", clientId);

      for (const m of members || []) {
        evolution.leaveGroup(group.group_jid, m.instance_name).catch(() => {});
      }
    }

    await supabaseAdmin
      .from("whatsapp_warmup_groups")
      .delete()
      .eq("id", groupId)
      .eq("client_id", clientId);

    return NextResponse.json({ success: true, message: "Grupo removido com sucesso." });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
