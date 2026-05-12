import { NextRequest, NextResponse } from "next/server";
import { supabase, supabaseAdmin } from "@/lib/supabase";
import { logTokenUsage } from "@/lib/token-usage";

export const dynamic = "force-dynamic";
const adminClient = supabaseAdmin || supabase;

/**
 * Diagnóstico do sistema de tokens. Acesse:
 *   GET /api/tokens/diagnose
 *
 * Verifica em ordem:
 *   1) tabela ai_token_usage existe?
 *   2) consigo SELECT count?
 *   3) consigo INSERT um teste manual?
 *   4) o INSERT volta no SELECT?
 */
export async function GET(_req: NextRequest) {
  const checks: any[] = [];

  // 1) Existência + count
  try {
    const { count, error } = await adminClient
      .from("ai_token_usage")
      .select("*", { count: "exact", head: true });
    if (error) {
      checks.push({
        ok: false,
        step: "1. SELECT count",
        message: `${error.message} (code=${(error as any).code})`,
        hint: (error as any).code === "42P01"
          ? "Tabela não existe. Vai em Configurações → Setup do Banco e roda o SQL."
          : "Possível RLS ou permissão. Confere se SUPABASE_SERVICE_ROLE_KEY está setada no Easypanel.",
      });
      return NextResponse.json({ ok: false, checks });
    } else {
      checks.push({ ok: true, step: "1. SELECT count", message: `Tabela existe. ${count} linha(s) registradas.` });
    }
  } catch (err: any) {
    checks.push({ ok: false, step: "1. SELECT count", message: err?.message });
    return NextResponse.json({ ok: false, checks });
  }

  // 2) INSERT manual via helper (testa logTokenUsage)
  try {
    await logTokenUsage({
      source: "other",
      sourceLabel: "DIAGNÓSTICO MANUAL",
      model: "diagnose-test",
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      metadata: { test: true, ts: Date.now() },
    });
    checks.push({ ok: true, step: "2. logTokenUsage()", message: "Helper executou sem exceção (vê o console pra ver o log de gravação)." });
  } catch (err: any) {
    checks.push({ ok: false, step: "2. logTokenUsage()", message: err?.message });
  }

  // 3) Confirma que o teste apareceu
  try {
    const { data, error } = await adminClient
      .from("ai_token_usage")
      .select("*")
      .eq("source_label", "DIAGNÓSTICO MANUAL")
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) {
      checks.push({ ok: false, step: "3. Verificar gravação", message: error.message });
    } else if (!data || data.length === 0) {
      checks.push({
        ok: false,
        step: "3. Verificar gravação",
        message: "INSERT não apareceu na consulta. RLS pode estar bloqueando o anon e o service_role não está setado.",
        hint: "Confere SUPABASE_SERVICE_ROLE_KEY no Easypanel → Environment.",
      });
    } else {
      const row = data[0] as any;
      checks.push({
        ok: true,
        step: "3. Verificar gravação",
        message: `INSERT confirmado. Linha id=${row.id}, criada às ${new Date(row.created_at).toLocaleString("pt-BR")}.`,
      });
    }
  } catch (err: any) {
    checks.push({ ok: false, step: "3. Verificar gravação", message: err?.message });
  }

  // 4) Verifica se o service role está realmente carregado
  const usingService = !!supabaseAdmin;
  checks.push({
    ok: usingService,
    step: "4. SUPABASE_SERVICE_ROLE_KEY",
    message: usingService
      ? "Service role carregado — escritas ignoram RLS."
      : "⚠ Service role NÃO setado. Está usando o anon key, então RLS pode bloquear inserts. Configure SUPABASE_SERVICE_ROLE_KEY.",
  });

  const allOk = checks.every(c => c.ok);
  return NextResponse.json({ ok: allOk, checks });
}
