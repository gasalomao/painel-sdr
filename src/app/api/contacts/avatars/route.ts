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

export const dynamic = "force-dynamic";

// Cache TTL — Evolution assina URLs com expiração ~7d, mas a foto em si
// pode mudar antes. 24h é um meio-termo decente.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

async function getCachedAvatars(jids: string[]) {
  if (jids.length === 0) return new Map<string, { url: string | null; fetchedAt: number | null }>();
  const { data } = await supabaseAdmin
    .from("contacts")
    .select("remote_jid, profile_pic_url, profile_pic_fetched_at")
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

async function refreshOne(jid: string, instance: string): Promise<string | null> {
  try {
    // channel.fetchProfilePicture roteia: Evolution → busca real, Cloud → null.
    const url = await fetchProfilePicture(jid, instance);
    // Upsert no contacts (cria se não existir). UNIQUE(remote_jid) cuida.
    const phone = jid.replace(/@.*$/, "").replace(/\D/g, "");
    await supabaseAdmin
      .from("contacts")
      .upsert(
        {
          remote_jid: jid,
          phone_number: phone,
          profile_pic_url: url,
          profile_pic_fetched_at: new Date().toISOString(),
        },
        { onConflict: "remote_jid" },
      );
    return url;
  } catch (err: any) {
    console.warn("[avatars] refresh failed:", jid, err?.message);
    return null;
  }
}

async function handle(jids: string[], instanceParam: string | null, force: boolean) {
  const cleanJids = Array.from(new Set(jids.filter(Boolean))).slice(0, 200); // hard cap pra DoS
  if (cleanJids.length === 0) return { success: true, avatars: {} as Record<string, string | null> };

  const instance = instanceParam || (await getEvolutionConfig()).instance;
  if (!instance) return { success: true, avatars: {} as Record<string, string | null> };
  const cached = await getCachedAvatars(cleanJids);
  const result: Record<string, string | null> = {};
  const stale: string[] = [];

  for (const jid of cleanJids) {
    const c = cached.get(jid);
    const isStale = !c || !c.fetchedAt || (Date.now() - c.fetchedAt > CACHE_TTL_MS);
    result[jid] = c?.url ?? null;     // entrega o que tem em cache (mesmo stale)
    if (force || isStale) stale.push(jid);
  }

  // Refresh em paralelo MAS limitado em chunks de 8 (evita martelar a Evolution).
  // Espera o primeiro chunk pra retornar dados frescos; chunks restantes ficam
  // best-effort em background se houver tempo da função.
  const CHUNK = 8;
  for (let i = 0; i < stale.length; i += CHUNK) {
    const batch = stale.slice(i, i + CHUNK);
    const settled = await Promise.allSettled(batch.map(jid => refreshOne(jid, instance)));
    settled.forEach((s, idx) => {
      if (s.status === "fulfilled") result[batch[idx]] = s.value;
    });
    // Limita o tempo total do request: depois do 1º batch, se já demoramos
    // muito, pára e devolve o que tem (resto re-tenta no próximo request).
    if (i + CHUNK < stale.length && i >= CHUNK) break;
  }

  return { success: true, avatars: result, refreshed: stale.length, instance };
}

export async function GET(req: NextRequest) {
  try {
    const jids = (req.nextUrl.searchParams.get("jids") || "").split(",").map(s => s.trim()).filter(Boolean);
    const instance = req.nextUrl.searchParams.get("instance");
    const force = req.nextUrl.searchParams.get("force") === "1";
    return NextResponse.json(await handle(jids, instance, force));
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const jids = Array.isArray(body.jids) ? body.jids : [];
    return NextResponse.json(await handle(jids, body.instance || null, !!body.force));
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e?.message || String(e) }, { status: 500 });
  }
}
