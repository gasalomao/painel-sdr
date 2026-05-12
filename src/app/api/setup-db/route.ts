import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { SETUP_SQL } from "@/lib/setup-sql";
import fs from "fs";
import path from "path";

export const dynamic = "force-dynamic";

/**
 * GET  /api/setup-db           → retorna o SQL master + status do banco atual
 * GET  /api/setup-db?check=1&url=...&serviceRole=...
 *      → valida se as tabelas essenciais existem num Supabase alvo
 * POST /api/setup-db           → { url, anonKey, serviceRole } — grava no .env.local
 *      (apenas pra dev local — em produção a troca de DB é via Easypanel env vars)
 */

const ESSENTIAL_TABLES = [
  "contacts", "sessions", "messages",
  "chats_dashboard", "leads_extraidos",
  "agent_settings", "agent_stages", "agent_knowledge",
  "agent_batch_locks", "chat_buffers",
  "channel_connections", "webhook_logs",
  "historico_ia_leads", "ai_organizer_config", "ai_organizer_runs",
  "campaigns", "campaign_targets", "campaign_logs",
  "followup_campaigns", "followup_targets", "followup_logs",
  "app_settings", "ai_token_usage", "ai_pricing_cache",
];

function readMasterSql(): string {
  return SETUP_SQL;
}

async function checkTables(url: string, serviceRole: string): Promise<{ ok: boolean; present: string[]; missing: string[]; error?: string }> {
  try {
    const client = createClient(url, serviceRole, { auth: { persistSession: false } });
    const present: string[] = [];
    const missing: string[] = [];

    // Promise.all para ser muito mais rápido + Timeout global
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10s max

    try {
      const promises = ESSENTIAL_TABLES.map(async (t) => {
        const { error } = await client.from(t).select("*", { count: "exact", head: true, abortSignal: controller.signal } as any);
        if (error && (error as any).code === "42P01") missing.push(t);
        else if (error && /does not exist/i.test(error.message)) missing.push(t);
        else present.push(t);
      });
      await Promise.all(promises);
    } finally {
      clearTimeout(timeoutId);
    }

    return { ok: missing.length === 0, present, missing };
  } catch (err: any) {
    if (err.name === 'AbortError' || err.message?.includes('aborted')) {
      return { ok: false, present: [], missing: ESSENTIAL_TABLES, error: "Tempo esgotado. A URL fornecida não respondeu em 10 segundos. Verifique se a URL está correta e se o servidor está online." };
    }
    return { ok: false, present: [], missing: ESSENTIAL_TABLES, error: err?.message || String(err) };
  }
}

export async function GET(req: NextRequest) {
  const check = req.nextUrl.searchParams.get("check");
  const url = req.nextUrl.searchParams.get("url") || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const serviceRole = req.nextUrl.searchParams.get("serviceRole") || process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  if (check === "1") {
    if (!url || !serviceRole) {
      return NextResponse.json({ success: false, error: "Forneça url e serviceRole." }, { status: 400 });
    }
    const result = await checkTables(url, serviceRole);
    return NextResponse.json({ success: result.ok, ...result });
  }

  return NextResponse.json({
    success: true,
    sql: readMasterSql(),
    currentUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || null,
    // Extrai o "ref" do projeto Supabase pra montar o link do SQL Editor
    sqlEditorUrl: (() => {
      const u = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
      const m = u.match(/https:\/\/([a-z0-9]+)\.supabase\.co/i);
      return m ? `https://supabase.com/dashboard/project/${m[1]}/sql/new` : null;
    })(),
  });
}

export async function POST(req: NextRequest) {
  try {
    const { url, anonKey, serviceRole } = await req.json();

    if (!url || !anonKey || !serviceRole) {
      return NextResponse.json({ success: false, error: "Preencha todos os campos." }, { status: 400 });
    }

    const envPath = path.join(process.cwd(), '.env.local');
    
    // Se o arquivo não existir, cria vazio
    if (!fs.existsSync(envPath)) {
      fs.writeFileSync(envPath, '', 'utf8');
    }

    let envContent = fs.readFileSync(envPath, 'utf8');

    // Substitui as variáveis (ou adiciona se não existirem)
    const updateOrAdd = (key: string, value: string) => {
      const regex = new RegExp(`^${key}=.*`, 'm');
      if (regex.test(envContent)) {
        envContent = envContent.replace(regex, `${key}=${value}`);
      } else {
        envContent += `\n${key}=${value}`;
      }
    };

    updateOrAdd('NEXT_PUBLIC_SUPABASE_URL', url);
    updateOrAdd('NEXT_PUBLIC_SUPABASE_ANON_KEY', anonKey);
    updateOrAdd('SUPABASE_SERVICE_ROLE_KEY', serviceRole);

    fs.writeFileSync(envPath, envContent, 'utf8');

    return NextResponse.json({ success: true, message: "Variáveis de ambiente atualizadas com sucesso no .env.local" });
  } catch (err: any) {
    return NextResponse.json({ success: false, error: err.message }, { status: 500 });
  }
}
