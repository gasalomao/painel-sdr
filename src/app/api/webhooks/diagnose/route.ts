import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { getEvolutionConfig } from "@/lib/evolution";

export const dynamic = "force-dynamic";

/**
 * Diagnóstico completo do webhook pra uma instância.
 * Responde a pergunta: "Por que mensagens do cliente não aparecem no chat?"
 *
 * GET /api/webhooks/diagnose?instance=sdr
 */
export async function GET(req: NextRequest) {
  const cfg = await getEvolutionConfig();
  const instance = req.nextUrl.searchParams.get("instance") || cfg.instance;
  if (!instance) {
    return NextResponse.json({ error: "Sem instância configurada e nenhuma encontrada na Evolution. Crie uma em Configurações." }, { status: 400 });
  }
  const diagnosis: any = {
    instance,
    checks: [] as any[],
    verdict: "",
    action: "",
  };

  const EVO_URL = cfg.url || process.env.EVOLUTION_API_URL;
  const EVO_KEY = cfg.apiKey || process.env.EVOLUTION_API_KEY;

  // ===== 1. Checa env =====
  if (!EVO_URL || !EVO_KEY || EVO_URL.includes("url_aqui")) {
    diagnosis.checks.push({ step: "env", ok: false, message: "EVOLUTION_API_URL/KEY não configurados em .env.local" });
    diagnosis.verdict = "Evolution não configurada";
    return NextResponse.json(diagnosis);
  }
  diagnosis.checks.push({ step: "env", ok: true, message: `Evolution API: ${EVO_URL}` });

  // ===== 2. Checa webhook registrado na Evolution =====
  let registeredUrl: string | null = null;
  let registeredEvents: string[] = [];
  try {
    const r = await fetch(`${EVO_URL.replace(/\/$/, "")}/webhook/find/${instance}`, {
      headers: { apikey: EVO_KEY },
    });
    const text = await r.text();
    // Detecta HTML (Evolution offline)
    if (text.trim().toLowerCase().startsWith("<!doctype") || text.trim().toLowerCase().startsWith("<html")) {
      diagnosis.checks.push({ step: "webhook_lookup", ok: false, message: "Evolution respondeu HTML (container offline no Easypanel)." });
      diagnosis.verdict = "Evolution API está OFFLINE.";
      diagnosis.action = "Reinicia o container no Easypanel.";
      return NextResponse.json(diagnosis);
    }
    const j = JSON.parse(text);
    // Evolution v2 retorna o objeto direto ou dentro de { webhook: ... }
    const w = j?.webhook || j;
    registeredUrl = w?.url || w?.enabled === false ? null : (w?.url || null);
    registeredEvents = w?.events || [];

    if (!registeredUrl) {
      diagnosis.checks.push({ step: "webhook_lookup", ok: false, message: "Nenhum webhook registrado nesta instância." });
      diagnosis.verdict = "O webhook NÃO está registrado. Evolution não tem onde mandar as mensagens do cliente.";
      diagnosis.action = `Vai em /whatsapp, acha a instância "${instance}" e clica em "Registrar Webhook".`;
    } else {
      diagnosis.checks.push({
        step: "webhook_lookup",
        ok: true,
        message: `Webhook registrado: ${registeredUrl}`,
        events: registeredEvents,
      });
    }
  } catch (err: any) {
    diagnosis.checks.push({ step: "webhook_lookup", ok: false, message: `Falha ao consultar webhook: ${err.message}` });
    diagnosis.verdict = "Não consegui consultar a Evolution. Provavelmente offline.";
    return NextResponse.json(diagnosis);
  }

  // ===== 3. Checa public_url no banco (nossa config) =====
  const { data: setting } = await supabase.from("app_settings").select("value").eq("key", "public_url").maybeSingle();
  const publicUrl = setting?.value;
  const expectedWebhook = publicUrl ? `${String(publicUrl).replace(/\/$/, "")}/api/webhooks/whatsapp` : null;
  diagnosis.checks.push({
    step: "public_url",
    ok: !!publicUrl,
    message: publicUrl
      ? `URL pública no banco: ${publicUrl}`
      : "Sem public_url configurada em app_settings. Configure em /whatsapp → URL Pública.",
  });

  // ===== 4. Compara URL registrada vs. esperada =====
  if (registeredUrl && expectedWebhook) {
    // Tira querystring (?agentId=...) pra comparar
    const regNoQuery = registeredUrl.split("?")[0];
    const expNoQuery = expectedWebhook.split("?")[0];
    if (regNoQuery !== expNoQuery) {
      diagnosis.checks.push({
        step: "url_match",
        ok: false,
        message: `URL registrada está diferente da atual.\n  Registrada: ${regNoQuery}\n  Esperada:   ${expNoQuery}`,
      });
      if (!diagnosis.verdict) {
        diagnosis.verdict = "O webhook aponta pra uma URL antiga (provavelmente ngrok que expirou).";
        diagnosis.action = `Vai em /whatsapp e clica em "Registrar Webhook" pra atualizar pra ${expNoQuery}.`;
      }
    } else {
      diagnosis.checks.push({ step: "url_match", ok: true, message: "URL registrada bate com a atual." });
    }
  }

  // ===== 5. Checa se MESSAGES_UPSERT está nos eventos =====
  const hasUpsert = registeredEvents.some((e: string) =>
    /messages[._-]?upsert/i.test(e) || e === "MESSAGES_UPSERT"
  );
  if (registeredUrl && !hasUpsert && registeredEvents.length > 0) {
    diagnosis.checks.push({
      step: "events",
      ok: false,
      message: `MESSAGES_UPSERT NÃO está na lista de eventos. Evolution não vai te avisar de mensagens novas. Eventos inscritos: ${registeredEvents.join(", ")}`,
    });
    if (!diagnosis.verdict) {
      diagnosis.verdict = "Webhook registrado mas SEM o evento de mensagens novas.";
      diagnosis.action = "Re-registrar o webhook em /whatsapp vai corrigir (o código registra MESSAGES_UPSERT).";
    }
  } else if (registeredUrl) {
    diagnosis.checks.push({
      step: "events",
      ok: true,
      message: `MESSAGES_UPSERT ${hasUpsert ? "presente" : "assumido (lista vazia = todos)"}.`,
    });
  }

  // ===== 6. Checa atividade recente do webhook (últimos 10 min) =====
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const { data: recentLogs } = await supabase
    .from("webhook_logs")
    .select("event, payload, created_at")
    .eq("instance_name", instance)
    .gte("created_at", tenMinAgo)
    .order("created_at", { ascending: false })
    .limit(50);

  const totalEvents = recentLogs?.length || 0;
  const upsertEvents = (recentLogs || []).filter((l: any) =>
    /upsert/i.test(l.event || "")
  );
  const customerMsgs = upsertEvents.filter((l: any) => {
    const raw = l.payload?.raw || l.payload;
    return raw?.data?.key?.fromMe === false || raw?.key?.fromMe === false;
  });
  const fromMeEvents = upsertEvents.filter((l: any) => {
    const raw = l.payload?.raw || l.payload;
    return raw?.data?.key?.fromMe === true || raw?.key?.fromMe === true;
  });

  diagnosis.checks.push({
    step: "recent_activity",
    ok: totalEvents > 0,
    message: `Últimos 10min: ${totalEvents} eventos totais · ${upsertEvents.length} MESSAGES_UPSERT (${customerMsgs.length} do cliente, ${fromMeEvents.length} nossos).`,
  });

  // ===== 7. Checa erros recentes =====
  const { data: recentFails } = await supabase
    .from("webhook_logs")
    .select("event, payload, created_at")
    .in("event", ["WEBHOOK_DASH_INSERT_FAIL", "WEBHOOK_V2_INSERT_FAIL", "WEBHOOK_SESSION_FAIL"])
    .gte("created_at", tenMinAgo)
    .order("created_at", { ascending: false })
    .limit(10);

  if (recentFails && recentFails.length > 0) {
    diagnosis.checks.push({
      step: "persistence_errors",
      ok: false,
      message: `${recentFails.length} erro(s) ao salvar no banco nos últimos 10 min. Última: ${recentFails[0].payload?.error || "ver logs"}`,
      sample: recentFails[0],
    });
    if (!diagnosis.verdict) {
      diagnosis.verdict = "Webhook chega mas falha ao gravar no Supabase.";
      diagnosis.action = `Código do erro Postgres: ${recentFails[0].payload?.code || "desconhecido"}. Provavelmente constraint/RLS na chats_dashboard.`;
    }
  }

  // ===== Veredito final =====
  if (!diagnosis.verdict) {
    if (totalEvents === 0) {
      diagnosis.verdict = "Webhook registrado OK, mas NENHUM evento chegou nos últimos 10 min. Evolution pode estar offline OU instância desconectada OU ninguém mandou msg ainda.";
      diagnosis.action = "Manda uma msg pro número do WhatsApp dessa instância do seu celular e roda este diagnóstico de novo.";
    } else if (customerMsgs.length === 0 && fromMeEvents.length > 0) {
      diagnosis.verdict = "Só chegam eventos de msgs NOSSAS (fromMe=true). Nenhuma msg do cliente chegou — estranho mas pode ser que ninguém mandou.";
      diagnosis.action = "Manda uma msg pro WhatsApp dessa instância do seu celular e veja se ela aparece aqui.";
    } else {
      diagnosis.verdict = "Tudo parece OK. Webhook chega, mensagens do cliente chegam, gravação sem erro.";
      diagnosis.action = "Se ainda não aparece no chat, confere o filtro de instância no /chat.";
    }
  }

  return NextResponse.json(diagnosis);
}
