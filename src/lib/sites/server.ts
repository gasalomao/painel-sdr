import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase";
import { requireClientId } from "@/lib/tenant";
import type { WebsiteProject } from "./types";

export class SitesError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "SitesError";
  }
}

export function getSitesDb(): SupabaseClient {
  if (!supabaseAdmin) throw new SitesError(503, "Site Studio indisponível: configuração pendente.");
  return supabaseAdmin;
}

export function sitesErrorResponse(error: unknown): NextResponse {
  return NextResponse.json(
    { error: error instanceof SitesError ? error.message : "Não foi possível concluir a operação." },
    { status: error instanceof SitesError ? error.status : 500 },
  );
}

export function assertUuid(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new SitesError(400, "Identificador inválido.");
  }
}

export function assertMutationOrigin(req: NextRequest): void {
  const origin = req.headers.get("origin");
  if (!origin || origin !== req.nextUrl.origin || req.headers.get("sec-fetch-site") === "cross-site") {
    throw new SitesError(403, "Origem não permitida.");
  }
}

export type SitesContext =
  | { ok: true; clientId: string; actorId: string; isAdmin: boolean; db: SupabaseClient }
  | { ok: false; response: NextResponse };

export async function requireSitesContext(req: NextRequest): Promise<SitesContext> {
  try {
    const db = getSitesDb();
    const auth = await requireClientId(req);
    if (!auth.ok) return auth;
    assertUuid(auth.clientId);
    assertUuid(auth.claims.actorId);
    const { data: client, error } = await db.from("clients")
      .select("id,is_active,is_admin,features").eq("id", auth.clientId).maybeSingle();
    if (error) throw new SitesError(503, "Não foi possível verificar o acesso.");
    if (!client || client.is_active !== true) throw new SitesError(403, "Acesso não permitido.");
    const isAdmin = client.is_admin === true && !auth.impersonating;
    if (!isAdmin && client.features?.sites !== true) throw new SitesError(403, "Site Studio não habilitado.");
    if (auth.impersonating) {
      const { data: actor, error: actorError } = await db.from("clients")
        .select("id,is_active,is_admin").eq("id", auth.claims.actorId).maybeSingle();
      if (actorError || !actor || actor.is_active !== true || actor.is_admin !== true) {
        throw new SitesError(403, "Acesso não permitido.");
      }
    } else if (auth.claims.actorId !== auth.clientId) {
      throw new SitesError(403, "Acesso não permitido.");
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) assertMutationOrigin(req);
    return { ok: true, clientId: auth.clientId, actorId: auth.claims.actorId, isAdmin, db };
  } catch (error) {
    return { ok: false, response: sitesErrorResponse(error) };
  }
}

export async function requireSitesProject(clientId: string, projectId: string): Promise<WebsiteProject> {
  assertUuid(clientId);
  assertUuid(projectId);
  const { data, error } = await getSitesDb().from("website_projects").select("*")
    .eq("client_id", clientId).eq("id", projectId).is("deleted_at", null).maybeSingle();
  if (error) throw new SitesError(503, "Não foi possível carregar o projeto.");
  if (!data) throw new SitesError(404, "Projeto não encontrado.");
  return data as WebsiteProject;
}

export function objectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SitesError(400, "Objeto JSON inválido.");
  return value as Record<string, unknown>;
}

export function onlyFields(body: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(body).some((key) => !fields.includes(key))) throw new SitesError(400, "Campo não permitido.");
}

export function textField(value: unknown, max: number, required = false): string {
  if (typeof value !== "string" || value.length > max || (required && !value.trim()) || value.includes("\0")) {
    throw new SitesError(400, "Texto inválido ou acima do limite.");
  }
  return value.trim();
}

export function expectedRevision(body: Record<string, unknown>): string | null {
  if (!Object.hasOwn(body, "expected_revision_id")) throw new SitesError(400, "Informe expected_revision_id.");
  if (body.expected_revision_id === null) return null;
  assertUuid(body.expected_revision_id);
  return body.expected_revision_id;
}

export async function readSitesBody(req: NextRequest, maxBytes = 64 * 1024): Promise<Record<string, unknown>> {
  if (req.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new SitesError(415, "Envie application/json.");
  }
  const length = req.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new SitesError(413, "Corpo acima do limite.");
  if (!req.body) throw new SitesError(400, "Corpo JSON obrigatório.");
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new SitesError(413, "Corpo acima do limite.");
      }
      chunks.push(value);
    }
    return objectBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (error) {
    if (error instanceof SitesError) throw error;
    throw new SitesError(400, "JSON inválido.");
  } finally {
    reader.releaseLock();
  }
}
