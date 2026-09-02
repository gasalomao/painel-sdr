/**
 * /api/contacts/avatars
 *
 * GET ?jids=jid1,jid2,...&instance=NAME
 *   → devolve { jid: profilePictureUrl|null } para os JIDs pedidos.
 *   Lê o cache em `contacts.profile_pic_url` (TTL ~24h). Se ausente ou
 *   stale, chama a Evolution em paralelo e atualiza o DB. Resposta sempre
 *   contém o que está em cache no momento (mesmo que stale, pra UI não
 *   esperar). Os fetches remotos rodam em background com timeout.
 *
 * POST (body JSON): { jids: string[], instance?: string, force?: boolean }
 *   → mesmo comportamento mas com lista grande sem limite de URL.
 *
 * O /chat chama esse endpoint depois de loadConversations pra hidratar
 * fotos de até 100 conversas em batch. Falhas individuais não derrubam
 * o batch — JID com foto vazia simplesmente fica null no resultado.
 */

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { getEvolutionConfig } from "@/lib/evolution";
import { fetchProfilePicture } from "@/lib/channel";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

async function resolveInstanceClientId(instanceName: string | null): Promise<string | null> {
  if (!instanceName) return null;
  const { data } = await supabaseAdmin
    .from("channel_connections")
    .select("client_id")
    .eq("instance_name", instanceName)
    .maybeSingle();
  return data?.client_id || null;
}

// Cache TTL — Evolution assina URLs com expiração ~7d, mas a foto em si
// pode mudar antes. 24h é um meio-termo decente.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function getCachedAvatars(jids: string[], clientId: string) {
  if (jids.length === 0) return new Map<string, { url: string | null; fetchedAt: number | null }>();
  const { data } = await supabaseAdmin
    .from("contacts")
    .select("remote_jid, profile_pic_url, profile_pic_fetched_at")
    .eq("client_id", clientId)
    .in("remote_jid", jids);
  const map = new Map<string, { url: string | null; fetchedAt: number | null }>();
  for (const r of data || []) {
    map.set(r.remote_jid, {
      url: r.profile_pic_url,
      fetchedAt: r.profile_pic_fetched_at ? new Date(r.profile_pic_fetched_at).getTime() : null,
    });
  }
  return map;
}

async function refreshOne(jid: string, instance: string, clientId: string): Promise<string | null> {
  try {
    // channel.fetchProfilePicture roteia: Evolution → busca real, Cloud → null.
    const url = await fetchProfilePicture(jid, instance);
    const phone = jid.replace(/@.*$/, "").replace(/\D/g, "");
    await supabaseAdmin
      .from("contacts")
      .upsert(
        {
          client_id: clientId,
          remote_jid: jid,
          phone_number: phone,
          profile_pic_url: url,
          profile_pic_fetched_at: new Date().toISOString(),
        },
        { onConflict: "client_id,remote_jid" },
      );
    return url;
  } catch (err: any) {
    console.warn("[avatars] refresh failed:", jid, err?.message);
    return null;
  }
}

async function handle(jids: string[], instanceParam: string | null, force: boolean, clientId: string) {
  const cleanJids = Array.from(new Set(jids.filter(Boolean))).slice(0, 200); // hard cap pra DoS
  if (cleanJids.length === 0) return { success: true, avatars: {} as Record<string, string | null> };

  const instance = instanceParam || (await getEvolutionConfig()).instance;
  if (!instance) return { success: true, avatars: {} as Record<string, string | null> };
  const cached = await getCachedAvatars(cleanJids, clientId);
  const result: Record<string, string | null> = {};
  const stale: string[] = [];

  for (const jid of cleanJids) {
    const c = cached.get(jid);
    const isStale = !c || !c.fetchedAt || (Date.now() - c.fetchedAt > CACHE_TTL_MS);
    result[jid] = c?.url ?? null;     // entrega o que tem em cache (mesmo stale)
    if (force || isStale) stale.push(jid);
  }

  // Refresh em paralelo MAS limitado em chunks de 10 (evita martelar a Evolution).
  // Processa TODOS os staleJids — antes parava em 16 e o resto nunca era buscado.
  // Como é fire-and-forget pro cliente (devolve cache imediato), o tempo de processamento
  // em background não afeta a experiência do usuário.
  const CHUNK = 10;
  for (let i = 0; i < stale.length; i += CHUNK) {
    const batch = stale.slice(i, i + CHUNK);
    const settled = await Promise.allSettled(batch.map(jid => refreshOne(jid, instance, clientId)));
    settled.forEach((s, idx) => {
      if (s.status === "fulfilled") result[batch[idx]] = s.value;
    });
  }

  return { success: true, avatars: result, refreshed: stale.length, instance };
}

export async function GET(req: NextRequest) {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;
    const jids = (req.nextUrl.searchParams.get("jids") || "").split(",").map(s => s.trim()).filter(Boolean);
    const instance = req.nextUrl.searchParams.get("instance");
    const ownerClientId = await resolveInstanceClientId(instance);
    if (!ownerClientId) {
      return NextResponse.json({ success: false, error: "Instância não encontrada" }, { status: 404 });
    }
    if (ownerClientId !== auth.clientId && !auth.isAdmin) {
      return NextResponse.json({ success: false, error: "Instância não pertence a este cliente" }, { status: 403 });
    }
    const force = req.nextUrl.searchParams.get("force") === "1";
    return NextResponse.json(await handle(jids, instance, force, ownerClientId));
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;
    const body = await req.json().catch(() => ({}));
    const jids = Array.isArray(body.jids) ? body.jids : [];
    const instance = body.instance || null;
    const ownerClientId = await resolveInstanceClientId(instance);
    if (!ownerClientId) {
      return NextResponse.json({ success: false, error: "Instância não encontrada" }, { status: 404 });
    }
    if (ownerClientId !== auth.clientId && !auth.isAdmin) {
      return NextResponse.json({ success: false, error: "Instância não pertence a este cliente" }, { status: 403 });
    }
    return NextResponse.json(await handle(jids, instance, !!body.force, ownerClientId));
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
