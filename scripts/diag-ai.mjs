// Diagnóstico runtime: por que a IA não está respondendo.
// Uso: node scripts/diag-ai.mjs [instance_name]
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
import { resolve } from "path";

// Carrega .env.local manualmente (sem dep extra)
try {
  const envText = readFileSync(resolve(process.cwd(), ".env.local"), "utf8");
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) {
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  }
} catch (e) {
  console.error("Não achei .env.local:", e.message);
  process.exit(1);
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Faltam NEXT_PUBLIC_SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY no .env.local");
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });

const instanceFilter = process.argv[2] || null;

function log(title, obj) {
  console.log("\n=== " + title + " ===");
  console.log(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
}

// 1. Env essencial
log("ENV", {
  has_supabase_url: !!url,
  has_service_role: !!key,
  has_auth_secret: !!process.env.AUTH_SECRET,
  internal_secret_resolved: !!(process.env.AUTH_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY),
  port: process.env.PORT || "(default 3000)",
});

// 2. Instances
const { data: conns, error: connErr } = await sb
  .from("channel_connections")
  .select("instance_name, provider, status, agent_id, client_id, provider_config")
  .order("instance_name");
if (connErr) {
  log("channel_connections ERRO", connErr.message);
} else {
  log("INSTANCES", (conns || []).map((c) => ({
    instance: c.instance_name,
    status: c.status,
    provider: c.provider,
    agent_id: c.agent_id,
    has_webhook_secret: !!(c.provider_config?.webhook_secret),
    webhook_strict: !!(c.provider_config?.webhook_strict),
  })));
}

// 3. Filtra a instância alvo
const targets = instanceFilter
  ? (conns || []).filter((c) => c.instance_name === instanceFilter)
  : (conns || []);
if (targets.length === 0) {
  console.warn("Nenhuma instância encontrada" + (instanceFilter ? ` com nome "${instanceFilter}"` : ""));
}

for (const conn of targets) {
  log(`>>> DIAGNÓSTICO: ${conn.instance_name}`, "");

  // Agent
  let agent = null;
  if (conn.agent_id) {
    const { data: a } = await sb
      .from("agent_settings")
      .select("id, name, is_active, target_model, main_prompt, options")
      .eq("id", conn.agent_id)
      .maybeSingle();
    agent = a;
  }
  log("AGENT", agent ? {
    id: agent.id,
    name: agent.name,
    is_active: agent.is_active,
    target_model: agent.target_model,
    has_prompt: !!agent.main_prompt?.trim(),
    has_per_agent_api_key: !!agent.options?.gemini_api_key,
  } : "(sem agente vinculado)");

  // Org config (API key Gemini global)
  const { data: org } = await sb.from("ai_organizer_config").select("api_key, model").eq("id", 1).maybeSingle();
  log("ORG_CONFIG", {
    has_api_key: !!org?.api_key,
    model: org?.model || "(vazio)",
  });

  // Última msg do cliente recebida
  const { data: recentMsgs } = await sb
    .from("chats_dashboard")
    .select("message_id, remote_jid, sender_type, content, created_at")
    .eq("instance_name", conn.instance_name)
    .order("created_at", { ascending: false })
    .limit(10);
  log("ÚLTIMAS 10 MSGS chats_dashboard", (recentMsgs || []).map((m) => ({
    when: m.created_at,
    sender: m.sender_type,
    jid: m.remote_jid,
    content: (m.content || "").slice(0, 60),
  })));

  // Logs de falha últimas 24h
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const FAILURE_EVENTS = [
    "WEBHOOK_SECRET_REJECTED","WEBHOOK_SECRET_MISMATCH",
    "AGENT_INACTIVE","AGENT_NO_API_KEY","AGENT_NO_MODEL",
    "AGENT_DISPATCH_NO_SECRET","AGENT_DISPATCH_FETCH_FAIL",
    "AGENT_SKIP_PAUSED","AGENT_CRITICAL_ERROR","AGENT_SEND_ERROR",
    "WEBHOOK_SESSION_FAIL","AGENT_DASH_INSERT_FAIL","AGENT_STOP_HOURS",
  ];
  const { data: failLogs } = await sb
    .from("webhook_logs")
    .select("event, payload, created_at")
    .eq("instance_name", conn.instance_name)
    .in("event", FAILURE_EVENTS)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(20);
  log("LOGS DE FALHA (24h)", (failLogs || []).map((l) => ({
    when: l.created_at,
    event: l.event,
    payload: l.payload,
  })));

  // Eventos AGENT_PROCESS_START — se webhook chegou e agente FOI disparado
  const { data: startLogs } = await sb
    .from("webhook_logs")
    .select("event, payload, created_at")
    .eq("instance_name", conn.instance_name)
    .in("event", ["AGENT_PROCESS_START", "AGENT_SEND_SUCCESS"])
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(20);
  log("DISPARO/SUCESSO IA (24h)", (startLogs || []).map((l) => ({
    when: l.created_at,
    event: l.event,
    preview: l.payload,
  })));

  // Eventos raw recentes — mostra se a Evolution está mandando webhook
  const { data: rawLogs } = await sb
    .from("webhook_logs")
    .select("event, created_at")
    .eq("instance_name", conn.instance_name)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(15);
  log("ÚLTIMOS 15 EVENTOS RAW (24h)", (rawLogs || []).map((l) => ({
    when: l.created_at,
    event: l.event,
  })));

  // Sessões recentes desta instância (bot_status)
  const { data: sess } = await sb
    .from("sessions")
    .select("id, contact_id, bot_status, paused_by, resume_at, last_message_at")
    .eq("instance_name", conn.instance_name)
    .order("last_message_at", { ascending: false, nullsFirst: false })
    .limit(5);
  log("ÚLTIMAS 5 SESSÕES", (sess || []).map((s) => ({
    id: s.id?.slice?.(0, 8),
    contact_id: s.contact_id?.slice?.(0, 8),
    bot_status: s.bot_status,
    paused_by: s.paused_by,
    resume_at: s.resume_at,
    last_msg: s.last_message_at,
  })));

  // Pausa global
  const { data: gp } = await sb
    .from("app_settings")
    .select("value")
    .eq("key", `global_ai_paused_until:${conn.instance_name}`)
    .maybeSingle();
  log("PAUSA GLOBAL", gp?.value || "(sem pausa global)");

  // Veredito
  let verdict = "Tudo parece OK do lado banco. Se ainda não responde, suspeito do dispatch fetch interno (porta/host) ou da API key Gemini real (key configurada mas inválida)."
  if (!agent) verdict = `❌ Instância "${conn.instance_name}" não tem agent vinculado (channel_connections.agent_id=${conn.agent_id}).`;
  else if (!agent.is_active) verdict = `❌ Agente "${agent.name}" está DESATIVADO. Vá em /agente e ative.`;
  else if (!org?.api_key && !agent.options?.gemini_api_key) verdict = "❌ API Key Gemini NÃO configurada (nem global em /configuracoes nem por agente).";
  else if (!org?.model && !agent.target_model) verdict = "❌ Nenhum modelo IA configurado (nem por agente nem global).";
  else if (conn.status !== "open") verdict = `❌ Instância está com status="${conn.status}" — Evolution não está conectada.`;
  log("VEREDITO", verdict);
}

process.exit(0);
