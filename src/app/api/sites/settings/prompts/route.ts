import { NextRequest, NextResponse } from "next/server";
import { requireSitesContext } from "@/lib/sites/server";
import { getWebsitePromptVersions, readWebsiteJson, resetWebsitePrompt, restoreWebsitePrompt, saveWebsitePrompt, websiteInstructionResponse, WebsiteInstructionError } from "@/lib/sites/prompts";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  if (!ctx.isAdmin) return NextResponse.json({ error: "Acesso restrito ao administrador." }, { status: 403 });
  try { return NextResponse.json({ promptVersions: await getWebsitePromptVersions() }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return websiteInstructionResponse(error); }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const ctx = await requireSitesContext(req);
  if (!ctx.ok) return ctx.response;
  if (!ctx.isAdmin) return NextResponse.json({ error: "Somente administradores podem alterar o prompt global." }, { status: 403 });
  try {
    const body = await readWebsiteJson(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new WebsiteInstructionError("Corpo inválido.");
    const patch = body as Record<string, unknown>;
    const keys = Object.keys(patch);
    if (keys.length !== 1) throw new WebsiteInstructionError("Informe prompt, reset ou restore_version_id.");
    if (keys[0] === "prompt") return NextResponse.json({ promptVersion: await saveWebsitePrompt(patch.prompt, ctx.actorId) }, { status: 201 });
    if (keys[0] === "reset" && patch.reset === true) return NextResponse.json({ promptVersion: await resetWebsitePrompt(ctx.actorId) }, { status: 201 });
    if (keys[0] === "restore_version_id") return NextResponse.json({ promptVersion: await restoreWebsitePrompt(patch.restore_version_id, ctx.actorId) }, { status: 201 });
    throw new WebsiteInstructionError("Operação inválida.");
  } catch (error) { return websiteInstructionResponse(error); }
}
