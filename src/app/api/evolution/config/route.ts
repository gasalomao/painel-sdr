import { NextRequest, NextResponse } from "next/server";
import axios from "axios";
import https from "https";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { invalidateEvolutionCache, getEvolutionConfig, evolution } from "@/lib/evolution";

export const dynamic = "force-dynamic";

/**
 * GET    /api/evolution/config           → devolve credenciais atuais (apiKey mascarada).
 * PATCH  /api/evolution/config           → grava { url, apiKey?, instance } em app_settings.
 * POST   /api/evolution/config?test=1    → testa { url, apiKey } sem salvar (lista instâncias).
 *
 * Pra trocar de VPS basta colar URL + API Key + nome da instância e clicar Salvar.
 * O lib/evolution.ts lê esses valores do banco com cache de 15s; já passa a usar
 * o servidor novo sem rebuild/restart.
 */

const KEYS = ["evolution_url", "evolution_api_key", "evolution_instance"] as const;

function maskKey(k?: string | null) {
  if (!k) return "";
  if (k.length <= 8) return "•".repeat(k.length);
  return k.slice(0, 4) + "…" + k.slice(-4);
}

async function readSettings() {
  const { data, error } = await supabaseAdmin
    .from("app_settings")
    .select("key,value")
    .in("key", KEYS as unknown as string[]);
  if (error) throw new Error(error.message);
  const map: Record<string, string> = {};
  for (const r of (data ?? [])) map[r.key] = r.value || "";
  return map;
}

async function writeSetting(key: string, value: string) {
  const { error } = await supabaseAdmin
    .from("app_settings")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(error.message);
}

const httpsAgent = new https.Agent({ rejectUnauthorized: false, family: 4 });

async function probe(url: string, apiKey: string): Promise<{ ok: boolean; instances?: any[]; error?: string; status?: number; }> {
  try {
    const base = url.endsWith("/") ? url.slice(0, -1) : url;
    const r = await axios({
      url: `${base}/instance/fetchInstances`,
      method: "GET",
      headers: { "Content-Type": "application/json", apikey: apiKey },
      timeout: 15000,
      httpsAgent,
      transformResponse: [(d) => d],
    });
    let body: any = r.data;
    if (typeof body === "string") {
      const trim = body.trim().toLowerCase();
      if (trim.startsWith("<!doctype") || trim.startsWith("<html")) {
        return { ok: false, error: "O host respondeu com HTML (Evolution offline ou URL apontando pro lugar errado)." };
      }
      try { body = JSON.parse(body); } catch { /* mantém raw */ }
    }
    const list = Array.isArray(body) ? body : (body?.instances || body?.data || []);
    return { ok: true, instances: Array.isArray(list) ? list : [], status: r.status };
  } catch (err: any) {
    if (err.code === "ECONNABORTED") return { ok: false, error: "Timeout — servidor não respondeu em 15s." };
    if (err.code === "ENOTFOUND" || err.code === "ECONNREFUSED") {
      return { ok: false, error: `Inacessível (${err.code}) — confere URL e se o container está rodando.` };
    }
    const status = err.response?.status;
    if (status === 401 || status === 403) return { ok: false, status, error: "API Key recusada (401/403). Confere a global apikey do servidor Evolution." };
    if (status === 404) return { ok: false, status, error: "404 — esse host não tem o endpoint /instance/fetchInstances. URL provavelmente está errada." };
    return { ok: false, status, error: err.response?.data ? String(err.response.data).slice(0, 240) : err.message };
  }
}

export async function GET() {
  try {
    const map = await readSettings();
    const cfg = await getEvolutionConfig(true); // valor efetivo (DB > env)
    return NextResponse.json({
      success: true,
      stored: {
        url:      map.evolution_url || "",
        apiKey:   maskKey(map.evolution_api_key),
        hasKey:   !!map.evolution_api_key,
        instance: map.evolution_instance || "",
      },
      effective: {
        url:      cfg.url,
        apiKey:   maskKey(cfg.apiKey),
        instance: cfg.instance,
        source:   cfg.source,
      },
      env: {
        url:      process.env.EVOLUTION_API_URL || "",
        instance: process.env.EVOLUTION_INSTANCE || "",
        hasKey:   !!process.env.EVOLUTION_API_KEY,
      },
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}

// Tabelas que carregam o nome da instância e devem migrar junto quando o
// usuário troca o nome (ex: "sdr" → "minhaempresa"). Sem isso, todo o
// histórico fica órfão (filtros do painel buscam por instance_name e nada
// aparece). Listadas em ordem segura: filhos antes de pais — embora aqui
// nenhuma tem FK por instance_name, então a ordem não importa.
const INSTANCE_TABLES = [
  "sessions",
  "chats_dashboard",
  "leads_extraidos",
  "webhook_logs",
  "chat_buffers",
  "campaigns",
  "followup_campaigns",
];

/**
 * Migra todo o histórico de `oldInstance` para `newInstance`.
 * - Tabelas comuns (INSTANCE_TABLES): UPDATE simples por instance_name.
 * - channel_connections (UNIQUE): garante que existe linha pra newInstance,
 *   migra agent_id/status do antigo, depois apaga a linha antiga.
 *
 * Idempotente: se rodar duas vezes, a segunda não acha nada para mover.
 */
async function migrateInstanceData(oldInstance: string, newInstance: string) {
  const report: Record<string, { ok: boolean; error?: string }> = {};
  if (!oldInstance || !newInstance || oldInstance === newInstance) return report;

  for (const t of INSTANCE_TABLES) {
    const { error } = await supabaseAdmin
      .from(t)
      .update({ instance_name: newInstance })
      .eq("instance_name", oldInstance);
    report[t] = { ok: !error, error: error?.message };
  }

  // channel_connections: tem UNIQUE em instance_name — não dá pra simplesmente
  // renomear se já existe linha com o nome novo. Lógica em 3 passos:
  try {
    const { data: oldRow } = await supabaseAdmin
      .from("channel_connections")
      .select("agent_id, status, provider, provider_config")
      .eq("instance_name", oldInstance)
      .maybeSingle();

    const { data: newRow } = await supabaseAdmin
      .from("channel_connections")
      .select("instance_name")
      .eq("instance_name", newInstance)
      .maybeSingle();

    if (!newRow) {
      // Não tem linha nova: pode ser INSERT puro OU rename. Tenta rename primeiro.
      if (oldRow) {
        const { error } = await supabaseAdmin
          .from("channel_connections")
          .update({ instance_name: newInstance })
          .eq("instance_name", oldInstance);
        report["channel_connections"] = { ok: !error, error: error?.message };
      } else {
        // Nem velha nem nova existe — cria a nova com defaults.
        const { error } = await supabaseAdmin
          .from("channel_connections")
          .insert({
            instance_name: newInstance,
            provider: "evolution",
            agent_id: 1,
            status: "open",
          });
        report["channel_connections"] = { ok: !error, error: error?.message };
      }
    } else if (oldRow) {
      // Ambas existem: copia metadata útil da antiga pra nova (se a nova tiver default)
      // e remove a antiga.
      const merged = {
        agent_id: newRow && (newRow as any).agent_id ? (newRow as any).agent_id : oldRow.agent_id,
        status: oldRow.status || "open",
        provider: oldRow.provider || "evolution",
        provider_config: oldRow.provider_config || {},
      };
      await supabaseAdmin.from("channel_connections").update(merged).eq("instance_name", newInstance);
      const { error: delErr } = await supabaseAdmin
        .from("channel_connections")
        .delete()
        .eq("instance_name", oldInstance);
      report["channel_connections"] = { ok: !delErr, error: delErr?.message };
    } else {
      report["channel_connections"] = { ok: true };
    }
  } catch (e: any) {
    report["channel_connections"] = { ok: false, error: e.message };
  }

  return report;
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const url      = (body.url      ?? "").trim();
    const apiKey   = (body.apiKey   ?? "").trim();
    const instance = (body.instance ?? "").trim();
    // body.migrate === false desliga a migração de histórico (caso o user prefira
    // manter os 2 mundos isolados). Default = true.
    const shouldMigrate = body.migrate !== false;

    // Lê o estado atual ANTES de gravar — pra saber qual era o `instance` antigo.
    const before = await getEvolutionConfig(true);
    const oldInstance = before.instance;

    if (typeof url      === "string") await writeSetting("evolution_url", url);
    if (typeof instance === "string") await writeSetting("evolution_instance", instance);
    // Só sobrescreve a apiKey se o usuário enviou uma nova (string não-vazia).
    // Isso permite editar URL/instance sem precisar redigitar a key.
    if (apiKey) await writeSetting("evolution_api_key", apiKey);

    // Se o nome da instância mudou, migra todo o histórico do nome antigo
    // pro novo. Assim não se perde nada quando o user troca de "sdr" → "minha".
    let migration: Record<string, { ok: boolean; error?: string }> | null = null;
    if (shouldMigrate && instance && instance !== oldInstance) {
      migration = await migrateInstanceData(oldInstance, instance);
    }

    invalidateEvolutionCache();
    const cfg = await getEvolutionConfig({ force: true, resolve: false });

    // Lista instâncias remotas — útil pra UI mostrar o que existe no servidor
    // E também pra decidir se precisamos criar a que o user pediu.
    let availableInstances: string[] = [];
    let serverError: string | undefined;
    try {
      const probeRes = await probe(cfg.url, cfg.apiKey).catch(() => ({ ok: false, instances: [] as any[], error: "probe falhou" }));
      if (probeRes.ok) {
        availableInstances = (probeRes.instances || [])
          .map((i: any) => i?.instance?.instanceName || i?.instance?.name || i?.instanceName || i?.name)
          .filter(Boolean);
      } else if ((probeRes as any).error) {
        serverError = (probeRes as any).error;
      }
    } catch { /* ignore — só é informativo */ }

    // Se o user pediu pra garantir/criar a instância (default true quando passou
    // um nome explícito), e ela ainda não existe no servidor remoto, cria com
    // settings padrão + webhook apontando pra publicAppUrl.
    let created = false;
    let qrCode: string | null = null;
    let pairingCode: string | null = null;
    const wantEnsure = body.ensure !== false; // default true
    const targetInstance = (instance || cfg.instance || "").trim();

    if (wantEnsure && targetInstance && cfg.url && cfg.apiKey) {
      const exists = availableInstances.includes(targetInstance);
      if (!exists) {
        try {
          // Descobre a URL pública pra registrar o webhook junto da criação.
          let publicUrl: string | undefined = (body.publicUrl ?? "").trim() || undefined;
          if (!publicUrl) {
            const { data } = await supabaseAdmin
              .from("app_settings").select("value").eq("key", "public_url").maybeSingle();
            if (data?.value && !data.value.includes("localhost")) publicUrl = data.value;
          }
          if (!publicUrl) {
            const env = process.env.NEXT_PUBLIC_APP_URL;
            if (env && !env.includes("localhost")) publicUrl = env;
          }

          const connectRes = await evolution.ensureInstanceConfigured(targetInstance, publicUrl);
          created = true;
          qrCode = connectRes?.code || connectRes?.base64 || null;
          pairingCode = connectRes?.pairingCode || null;
          availableInstances = [...availableInstances, targetInstance];
        } catch (e: any) {
          // Não trava o save — o user pode ter salvo URL/key sem querer criar
          // ainda. Devolvemos o erro pra UI mostrar.
          serverError = `Falha ao criar instância "${targetInstance}": ${e?.message || e}`;
        }
      }
    }

    return NextResponse.json({
      success: true,
      effective: { url: cfg.url, instance: cfg.instance, hasKey: !!cfg.apiKey, source: cfg.source },
      migration: migration && {
        from: oldInstance,
        to: instance,
        tables: migration,
      },
      availableInstances,
      created,
      qrCode,
      pairingCode,
      serverError,
    });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  // POST /api/evolution/config?test=1  → probe sem salvar.
  // Se body vier vazio, testa as credenciais atuais (DB+env).
  try {
    const test = req.nextUrl.searchParams.get("test");
    const body = await req.json().catch(() => ({}));
    let url     = (body.url    ?? "").trim();
    let apiKey  = (body.apiKey ?? "").trim();

    if (!url || !apiKey) {
      const cfg = await getEvolutionConfig(true);
      url    = url    || cfg.url;
      apiKey = apiKey || cfg.apiKey;
    }
    if (!url)    return NextResponse.json({ success: false, error: "URL não informada e nenhuma URL salva." }, { status: 400 });
    if (!apiKey) return NextResponse.json({ success: false, error: "API Key não informada e nenhuma chave salva." }, { status: 400 });

    const result = await probe(url, apiKey);
    if (!test) {
      // Comportamento padrão = probe (sem salvar). Mantemos POST como atalho de teste.
    }
    return NextResponse.json({
      success: result.ok,
      ...result,
    }, { status: result.ok ? 200 : 200 });
  } catch (e: any) {
    return NextResponse.json({ success: false, error: e.message }, { status: 500 });
  }
}
