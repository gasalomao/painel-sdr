import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";

export const dynamic = "force-dynamic";

/**
 * GET   /api/organizer   → estado do organizador do cliente atual
 *                          { enabled, prompt, defaultPrompt, lastRun }
 * PATCH /api/organizer   → atualiza { enabled?, prompt? }
 *
 * Multi-tenant: cliente só vê/edita o próprio (clients.organizer_*).
 * Admin (não-impersonando) edita o próprio escopo também — pra mexer no de
 * outro cliente vai em /admin/clientes → editar.
 */

const DEFAULT_ORGANIZER_PROMPT = `Você é um SDR experiente analisando conversas WhatsApp de leads.

Sua função: ler o histórico recente de cada conversa e decidir o próximo status do lead.

Para cada conversa, retorne JSON: { status_novo, razao_curta, resumo }.

Use só os status disponíveis no Kanban deste cliente (passados como contexto).`;

export async function GET(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const { data: client } = await supabaseAdmin
    .from("clients")
    .select("organizer_enabled, organizer_prompt")
    .eq("id", ctx.clientId)
    .maybeSingle();

  // ai_organizer_config (id=1) é GLOBAL — só admin altera. Carrega o modelo
  // em uso pra mostrar pro cliente, mesmo que ele não possa mudar.
  const { data: cfg } = await supabaseAdmin
    .from("ai_organizer_config")
    .select("last_run, execution_hour, enabled, model, provider")
    .eq("id", 1)
    .maybeSingle();

  // Prompt EFETIVO que está sendo usado (custom do cliente OU default global)
  const effectivePrompt = (client?.organizer_prompt && client.organizer_prompt.trim())
    ? client.organizer_prompt
    : DEFAULT_ORGANIZER_PROMPT;

  return NextResponse.json({
    ok: true,
    enabled: client?.organizer_enabled !== false,
    prompt: client?.organizer_prompt || "",
    defaultPrompt: DEFAULT_ORGANIZER_PROMPT,
    effectivePrompt,                                  // o que a IA realmente recebe
    globalEnabled: cfg?.enabled !== false,
    lastRun: cfg?.last_run || null,
    executionHour: cfg?.execution_hour ?? 20,
    model: cfg?.model || "gemini-2.5-flash",          // modelo em uso (global)
    provider: cfg?.provider || "Gemini",
    isAdmin: ctx.isAdmin,                             // pra UI mostrar/esconder controles
  });
}

export async function PATCH(req: NextRequest) {
  const ctx = await requireClientId(req);
  if (!ctx.ok) return ctx.response;
  if (!supabaseAdmin) return NextResponse.json({ ok: false, error: "DB indisponível" }, { status: 500 });

  const body = await req.json().catch(() => ({}));
  const patch: Record<string, any> = { updated_at: new Date().toISOString() };
  if (typeof body.enabled === "boolean") patch.organizer_enabled = body.enabled;
  if (typeof body.prompt === "string")   patch.organizer_prompt = body.prompt || null;

  if (Object.keys(patch).length === 1) {
    return NextResponse.json({ ok: false, error: "Nada pra atualizar" }, { status: 400 });
  }

  const { error } = await supabaseAdmin.from("clients").update(patch).eq("id", ctx.clientId);
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
