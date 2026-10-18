import { supabaseAdmin } from "./supabase_admin";
import { safePhotoUrl } from "./whatsapp-photo-utils";
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
    query = query.order("created_at", { ascending: false }).limit(1);
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

/**
 * Lê fotos cacheadas na tabela contacts com isolamento estrito por tenant.
 */
export async function readPhotoCache(
  clientId: string,
  jids: string[]
): Promise<Map<string, { url: string | null; fetchedAt: number | null }>> {
  const result = new Map<string, { url: string | null; fetchedAt: number | null }>();
  if (!jids.length) return result;

  const uniqueJids = [...new Set(jids)];

  const { data, error } = await supabaseAdmin
    .from("contacts")
    .select("remote_jid, profile_pic_url, profile_pic, profile_pic_fetched_at")
    .eq("client_id", clientId)
    .in("remote_jid", uniqueJids);

  if (error) {
    throw new PhotoError(error.message, 500);
  }

  for (const row of data || []) {
    const rawUrl = row.profile_pic_url || row.profile_pic || null;
    const safeUrl = safePhotoUrl(rawUrl);
    const fetchedAt = row.profile_pic_fetched_at ? new Date(row.profile_pic_fetched_at).getTime() : null;
    result.set(row.remote_jid, { url: safeUrl, fetchedAt: Number.isFinite(fetchedAt) ? fetchedAt : null });
  }

  // Preenche entradas vazias para JIDs não encontrados no banco
  for (const jid of uniqueJids) {
    if (!result.has(jid)) {
      result.set(jid, { url: null, fetchedAt: null });
    }
  }

  return result;
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
  cancelled?: boolean;
}> {
  const uniqueJids = [...new Set(jids.filter((j) => typeof j === "string" && j.trim().length > 0))];
  const avatars: Record<string, string | null> = {};
  let updated = 0;
  let noPhoto = 0;
  let skipped = 0;
  let failed = 0;

  if (!uniqueJids.length) {
    return { avatars, updated, noPhoto, skipped, failed };
  }

  const inFlightKey = `${clientId}:${connection.instance_name}`;
  if (inFlightSyncs.has(inFlightKey)) {
    throw new PhotoError("Já existe uma sincronização de fotos em andamento para esta conexão.", 409);
  }
  inFlightSyncs.add(inFlightKey);

  try {
    const cached = await readPhotoCache(clientId, uniqueJids);
    const now = Date.now();
    const toFetch: string[] = [];

    for (const jid of uniqueJids) {
      const entry = cached.get(jid);
      if (!options?.force && entry && entry.fetchedAt) {
        const age = now - entry.fetchedAt;
        const ttl = entry.url ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
        if (age < ttl) {
          avatars[jid] = entry.url;
          skipped++;
          continue;
        }
      }
      avatars[jid] = entry?.url ?? null;
      toFetch.push(jid);
    }

    if (!toFetch.length) {
      return { avatars, updated, noPhoto, skipped, failed };
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
          cancelled: true,
        };
      }

      const chunk = toFetch.slice(i, i + CHUNK_SIZE);
      const results = await Promise.allSettled(
        chunk.map(async (jid) => {
          if (options?.signal?.aborted) {
            throw new Error("Aborted");
          }

          let rawUrl: string | null = null;
          try {
            rawUrl = await fetchProfilePicture(jid, connection.instance_name);
          } catch (err: unknown) {
            throw err;
          }

          const validatedUrl = safePhotoUrl(rawUrl);
          const existingEntry = cached.get(jid);

          // Se já havia uma foto válida em cache e a busca retornou null/vazio, preserva a foto existente
          if (!validatedUrl && existingEntry?.url) {
            return { jid, url: existingEntry.url, preserved: true };
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

          return { jid, url: validatedUrl, preserved: false };
        })
      );

      for (let j = 0; j < chunk.length; j++) {
        const jid = chunk[j];
        const res = results[j];
        if (res.status === "fulfilled") {
          avatars[jid] = res.value.url;
          if (res.value.preserved) {
            // Preservada sem alteração
          } else if (res.value.url) {
            updated++;
          } else {
            noPhoto++;
          }
        } else {
          failed++;
          avatars[jid] = cached.get(jid)?.url ?? null;
          console.warn(`[whatsapp-photos] Erro ao atualizar foto de ${jid}:`, res.reason?.message || res.reason);
        }
      }
    }

    return { avatars, updated, noPhoto, skipped, failed };
  } finally {
    inFlightSyncs.delete(inFlightKey);
  }
}
