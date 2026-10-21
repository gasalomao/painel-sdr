import { NextRequest, NextResponse } from "next/server";
import { requireClientId } from "@/lib/tenant";
import { getPhotoJid } from "@/lib/whatsapp-photo-utils";
import { PhotoError, readPhotoCache, refreshPhotos, resolvePhotoConnection } from "@/lib/whatsapp-photos";

export const dynamic = "force-dynamic";

type AvatarInput = { jids: string[]; instance?: string; force?: boolean; cachedOnly?: boolean };

function parseInput(body: unknown): AvatarInput {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PhotoError("Corpo JSON inválido.", 400);
  const input = body as Record<string, unknown>;
  if (!Array.isArray(input.jids) || input.jids.length > 200 || input.jids.some((jid) => typeof jid !== "string" || jid.length > 100)) {
    throw new PhotoError("Informe até 200 JIDs por lote.", 400);
  }
  if (input.instance !== undefined && (typeof input.instance !== "string" || !input.instance.trim() || input.instance.length > 200)) {
    throw new PhotoError("Instância inválida.", 400);
  }
  if ([input.force, input.cachedOnly].some((flag) => flag !== undefined && typeof flag !== "boolean")) {
    throw new PhotoError("Opção de sincronização inválida.", 400);
  }
  return input as AvatarInput;
}

async function handle(req: NextRequest, body: unknown, clientId: string): Promise<NextResponse> {
  const input = parseInput(body);
  const requested = [...new Set(input.jids)];
  const normalized = new Map(requested.map((jid) => [jid, getPhotoJid(jid)]));
  const jids = [...new Set([...normalized.values()].filter((jid): jid is string => jid !== null))];
  const invalid = [...normalized.values()].filter((jid) => jid === null).length;
  let result: { avatars: Record<string, string | null>; updated: number; noPhoto: number; skipped: number; failed: number; preserved?: number; cancelled?: boolean };
  let instance: string | null = null;
  if (input.cachedOnly || jids.length === 0) {
    const cached = await readPhotoCache(clientId, jids);
    result = { avatars: Object.fromEntries(jids.map((jid) => [jid, cached.get(jid)?.url ?? null])), updated: 0, noPhoto: 0, skipped: jids.length, failed: 0 };
  } else {
    const connection = await resolvePhotoConnection(clientId, input.instance);
    instance = connection.instance_name;
    result = await refreshPhotos(clientId, connection, jids, { force: input.force, signal: req.signal });
  }
  const avatars = { ...result.avatars };
  for (const [original, jid] of normalized) avatars[original] = jid ? result.avatars[jid] ?? null : null;
  return NextResponse.json({ ...result, avatars, skipped: result.skipped + invalid, success: result.failed === 0 && !result.cancelled, partial: result.failed > 0 || !!result.cancelled, refreshed: result.updated + result.noPhoto - (result.preserved ?? 0), instance });
}

function failure(error: unknown): NextResponse {
  return NextResponse.json({ success: false, error: error instanceof PhotoError ? error.message : "Não foi possível carregar as fotos." }, { status: error instanceof PhotoError ? error.status : 500 });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;
    const params = req.nextUrl.searchParams;
    for (const flag of ["force", "cachedOnly"]) {
      if (params.has(flag) && !["0", "1"].includes(params.get(flag)!)) throw new PhotoError("Opção de sincronização inválida.", 400);
    }
    return await handle(req, {
      jids: (params.get("jids") || "").split(",").map((jid) => jid.trim()).filter(Boolean),
      instance: params.get("instance") ?? undefined,
      force: params.get("force") === "1",
      cachedOnly: params.get("cachedOnly") === "1",
    }, auth.clientId);
  } catch (error) {
    return failure(error);
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = await requireClientId(req);
    if (!auth.ok) return auth.response;
    return await handle(req, await req.json().catch(() => null), auth.clientId);
  } catch (error) {
    return failure(error);
  }
}
