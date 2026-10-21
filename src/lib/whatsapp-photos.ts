import { supabaseAdmin } from "./supabase_admin";
import { getPhotoJid, getPhotoJidAliases, safePhotoUrl } from "./whatsapp-photo-utils";
import { fetchProfilePicture } from "./channel";

export class PhotoError extends Error {
  status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
    this.name = "PhotoError";
    Object.setPrototypeOf(this, PhotoError.prototype);
  }
}

export type PhotoConnection = {
  instance_name: string;
  client_id: string;
  provider: string;
  status: string;
  provider_config?: Record<string, unknown> | null;
};

const POSITIVE_TTL_MS = 24 * 60 * 60 * 1000; // 24 horas
const NEGATIVE_TTL_MS = 60 * 60 * 1000;      // 1 hora

// ponytail: Process-local in-flight guard; if scaling horizontally across multiple Node.js instances without sticky sessions, upgrade to Redis distributed lock.
const inFlightSyncs = new Set<string>();

/**
 * Resolve a conexão WhatsApp de forma estrita para o tenant autenticado.
 * Nunca faz fallback para instâncias globais ou de outros clientes.
 */
export async function resolvePhotoConnection(
  clientId: string,
  instanceName?: string | null
): Promise<PhotoConnection> {
  if (!clientId) {
    throw new PhotoError("Cliente não informado.", 401);
  }

  let query = supabaseAdmin
    .from("channel_connections")
    .select("instance_name, client_id, provider, status, provider_config")
    .eq("client_id", clientId);

  if (instanceName && instanceName.trim()) {
    query = query.eq("instance_name", instanceName.trim());
  } else {
    query = query.in("status", ["connected", "open"])
      .in("provider", ["evolution", "evolution_v2", "evolution_go"])
      .order("created_at", { ascending: false }).limit(1);
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    throw new PhotoError(error.message, 500);
  }

  if (!data) {
    throw new PhotoError("Nenhuma instância conectada encontrada para este cliente.", 404);
  }

  const status = (data.status || "open").toLowerCase();
  if (status !== "connected" && status !== "open") {
    throw new PhotoError(`Instância "${data.instance_name}" está desconectada.`, 409);
  }

  const provider = (data.provider || "evolution").toLowerCase();
  if (!["evolution", "evolution_v2", "evolution_go"].includes(provider)) {
    throw new PhotoError("Provedor configurado não suporta busca de fotos.", 422);
  }

  return {
    instance_name: data.instance_name,
    client_id: data.client_id,
    provider: data.provider || "evolution",
    status: data.status || "open",
    provider_config: (data.provider_config as Record<string, unknown>) || {},
  };
}

type PhotoCacheEntry = { url: string | null; fetchedAt: number | null };

async function loadPhotoCache(
  clientId: string,
  jids: string[]
): Promise<{ cache: Map<string, PhotoCacheEntry>; aliases: Map<string, string[]>; entries: Map<string, PhotoCacheEntry> }> {
  const cache = new Map<string, PhotoCacheEntry>();
  const aliases = new Map<string, string[]>();
  const entries = new Map<string, PhotoCacheEntry>();
  if (!jids.length) return { cache, aliases, entries };

  const uniqueJids = [...new Set(jids)];
  const requested = new Set(uniqueJids.map(getPhotoJid).filter((jid): jid is string => jid !== null));
  const lookupJids = [...new Set(uniqueJids.flatMap((jid) => getPhotoJidAliases(jid))
    .flatMap((jid) => [jid, jid.replace("@s.whatsapp.net", "@c.us"), jid.split("@")[0]]))];

  for (let i = 0; i < lookupJids.length; i += 200) {
    const { data, error } = await supabaseAdmin
      .from("contacts")
      .select("remote_jid, profile_pic_url, profile_pic, profile_pic_fetched_at")
      .eq("client_id", clientId)
      .in("remote_jid", lookupJids.slice(i, i + 200));
    if (error) throw new PhotoError(error.message, 500);

    for (const row of data || []) {
      const jid = getPhotoJid(/^\d+$/.test(row.remote_jid) ? `${row.remote_jid}@s.whatsapp.net` : row.remote_jid);
      if (!jid) continue;
      const url = safePhotoUrl(row.profile_pic_url) ?? safePhotoUrl(row.profile_pic);
      const timestamp = Date.parse(row.profile_pic_fetched_at ?? "");
      // URL inválida/expirada não é uma ausência confirmada e não deve ganhar TTL negativo.
      const fetchedAt = Number.isFinite(timestamp) && (url || !(row.profile_pic_url || row.profile_pic)) ? timestamp : null;
      const previous = entries.get(jid);
      if (!previous || (url && !previous.url) || (!!url === !!previous.url && (fetchedAt ?? 0) > (previous.fetchedAt ?? 0))) {
        entries.set(jid, { url, fetchedAt });
      }
    }
  }

  for (const jid of uniqueJids) {
    const exactJid = getPhotoJid(jid);
    const exact = exactJid ? entries.get(exactJid) : undefined;
    // Variante BR é candidata a fallback, não prova de identidade compartilhada.
    const allowedAliases = getPhotoJidAliases(jid).filter((alias) => alias === exactJid || (
      !requested.has(alias) && !(exact?.url && entries.get(alias)?.url && exact.url !== entries.get(alias)?.url)
    ));
    aliases.set(jid, allowedAliases);
    const matches = allowedAliases.map((alias) => entries.get(alias)).filter((entry) => entry !== undefined);
    matches.sort((a, b) => Number(!!b.url) - Number(!!a.url) || (b.fetchedAt ?? 0) - (a.fetchedAt ?? 0));
    cache.set(jid, exact?.url ? exact : matches[0] ?? { url: null, fetchedAt: null });
  }

  return { cache, aliases, entries };
}

/** Lê fotos cacheadas com isolamento por tenant e prioridade da identidade exata. */
export async function readPhotoCache(
  clientId: string,
  jids: string[]
): Promise<Map<string, PhotoCacheEntry>> {
  return (await loadPhotoCache(clientId, jids)).cache;
}

/**
 * Atualiza fotos de uma lista de JIDs em paralelo com controle de concorrência e preservação de cache em falhas.
 */
export async function refreshPhotos(
  clientId: string,
  connection: PhotoConnection,
  jids: string[],
  options?: { force?: boolean; signal?: AbortSignal }
): Promise<{
  avatars: Record<string, string | null>;
  updated: number;
  noPhoto: number;
  skipped: number;
  failed: number;
  preserved: number;
  cancelled?: boolean;
}> {
  if (connection.client_id !== clientId) throw new PhotoError("Conexão não pertence a este cliente.", 404);
  const requested = [...new Set(jids)];
  const uniqueJids = [...new Set(requested.map(getPhotoJid).filter((jid): jid is string => jid !== null))];
  const avatars: Record<string, string | null> = {};
  let updated = 0;
  let noPhoto = 0;
  let skipped = requested.length - uniqueJids.length;
  let failed = 0;
  let preserved = 0;

  if (!uniqueJids.length) {
    return { avatars, updated, noPhoto, skipped, failed, preserved };
  }

  const inFlightKey = `${clientId}:${connection.instance_name}`;
  if (inFlightSyncs.has(inFlightKey)) {
    throw new PhotoError("Já existe uma sincronização de fotos em andamento para esta conexão.", 409);
  }
  inFlightSyncs.add(inFlightKey);

  try {
    const { cache: cached, aliases, entries } = await loadPhotoCache(clientId, uniqueJids);
    const setAvatar = (jid: string, url: string | null): void => {
      for (const alias of aliases.get(jid) ?? [jid]) {
        const aliasUrl = entries.get(alias)?.url;
        if (alias !== jid && aliasUrl && aliasUrl !== url) {
          delete avatars[alias];
          continue;
        }
        avatars[alias] = url;
      }
    };
    const now = Date.now();
    const toFetch: string[] = [];

    for (const jid of uniqueJids) {
      const entry = cached.get(jid);
      if (!options?.force && entry && entry.fetchedAt) {
        const age = now - entry.fetchedAt;
        const ttl = entry.url ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
        if (age < ttl) {
          setAvatar(jid, entry.url);
          skipped++;
          continue;
        }
      }
      setAvatar(jid, entry?.url ?? null);
      toFetch.push(jid);
    }

    if (!toFetch.length) {
      return { avatars, updated, noPhoto, skipped, failed, preserved };
    }

    const CHUNK_SIZE = 5;
    for (let i = 0; i < toFetch.length; i += CHUNK_SIZE) {
      if (options?.signal?.aborted) {
        return {
          avatars,
          updated,
          noPhoto,
          skipped: skipped + (toFetch.length - i),
          failed,
          preserved,
          cancelled: true,
        };
      }

      const chunk = toFetch.slice(i, i + CHUNK_SIZE);
      const results = await Promise.allSettled(
        chunk.map(async (jid) => {
          if (options?.signal?.aborted) {
            throw new Error("Aborted");
          }

          let validatedUrl: string | null = null;
          const existingEntry = cached.get(jid);
          for (const alias of aliases.get(jid) ?? [jid]) {
            if (options?.signal?.aborted) throw new Error("Aborted");
            const rawUrl = await fetchProfilePicture(alias, connection.instance_name, clientId);
            validatedUrl = safePhotoUrl(rawUrl);
            if (rawUrl !== null && !validatedUrl) throw new Error("Provedor retornou foto inválida ou expirada.");
            if (validatedUrl || (alias === jid && entries.get(jid)?.url)) break;
          }
          if (options?.signal?.aborted) throw new Error("Aborted");

          // Ausência confirmada pelo WhatsApp não apaga foto ainda válida do cache.
          if (!validatedUrl && existingEntry?.url) {
            return { jid, url: existingEntry.url, noPhoto: true, preserved: true };
          }

          const phone = jid.replace(/@.*$/, "").replace(/\D/g, "");
          const upsertRes = await supabaseAdmin.from("contacts").upsert(
            {
              client_id: clientId,
              remote_jid: jid,
              phone_number: phone,
              profile_pic_url: validatedUrl,
              profile_pic_fetched_at: new Date().toISOString(),
            },
            { onConflict: "client_id,remote_jid" }
          );

          if (upsertRes.error) {
            throw upsertRes.error;
          }

          return { jid, url: validatedUrl, noPhoto: !validatedUrl, preserved: false };
        })
      );

      for (let j = 0; j < chunk.length; j++) {
        const jid = chunk[j];
        const res = results[j];
        if (res.status === "fulfilled") {
          setAvatar(jid, res.value.url);
          if (res.value.preserved) preserved++;
          if (res.value.noPhoto) noPhoto++;
          else updated++;
        } else {
          if (options?.signal?.aborted) skipped++;
          else failed++;
          setAvatar(jid, cached.get(jid)?.url ?? null);
        }
      }
    }

    return { avatars, updated, noPhoto, skipped, failed, preserved, ...(options?.signal?.aborted ? { cancelled: true } : {}) };
  } finally {
    inFlightSyncs.delete(inFlightKey);
  }
}
