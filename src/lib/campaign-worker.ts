/**
 * Worker in-process pra disparo em massa.
 *
 * Princípio: pra cada campanha 'running', rodamos um loop que:
 *   1. pega o próximo target pending
 *   2. respeita horário permitido (allowed_start_hour..allowed_end_hour)
 *   3. envia via Evolution API com presence "composing" antes
 *   4. grava em sessions+messages+chats_dashboard pra IA ter contexto
 *   5. agenda o próximo com delay = random(min_interval, max_interval)
 *   6. backoff em erro 429 (até 240s) e parar após 3 falhas seguidas
 *
 * Resilient: cada target tem next_send_at no DB. Se o processo reiniciar,
 * podemos retomar (futuro: tick endpoint).
 */

import { supabaseAdmin as supabase } from "@/lib/supabase_admin";
import { evolution } from "@/lib/evolution";
import * as channel from "@/lib/channel";
import { renderTemplate } from "@/lib/template-vars";
import { webSearch } from "@/lib/web-search";
import { logTokenUsage } from "@/lib/token-usage";
import { DEFAULT_CLIENT_ID, clientIdFromInstance } from "@/lib/tenant";
import { registerAiSend, registerPendingAutomatedSend } from "@/lib/manual-send-registry";

type CampaignRow = {
  id: string;
  name: string;
  instance_name: string;
  agent_id: number | null;
  message_template: string;
  min_interval_seconds: number;
  max_interval_seconds: number;
  allowed_start_hour: number;
  allowed_end_hour: number;
  status: string;
  personalize_with_ai?: boolean;
  use_web_search?: boolean;
  ai_model?: string | null;
  ai_prompt?: string | null;
};

// Estado in-memory: campanhas em execução com timer ativo
const runningTimers = new Map<string, NodeJS.Timeout>();
const consecutiveFailures = new Map<string, number>();

// Cacheia se a tabela existe, pra não martelar o banco com erros 42P01 em loop.
let campaignLogsAvailable: boolean | null = null;

async function addCampaignLog(campaignId: string, message: string, level: "info" | "success" | "warning" | "error" = "info") {
  const timestamp = new Date().toLocaleTimeString();
  console.log(`[CAMPAIGN_LOG][${timestamp}][${level.toUpperCase()}] Campaign: ${campaignId} | Msg: ${message}`);

  // 1) Fallback SEMPRE-disponível: webhook_logs (tabela que já existe no projeto).
  //    Mesmo se campaign_logs falhar, o usuário tem rastro em algum lugar.
  //    Só gravamos níveis !==info pra não poluir.
  if (level !== "info") {
    supabase.from("webhook_logs").insert({
      instance_name: "campaign",
      event: `CAMPAIGN_${level.toUpperCase()}`,
      payload: { campaign_id: campaignId, message, level },
      created_at: new Date().toISOString(),
    }).then(() => {}, () => {});
  }

  // 2) Persistir último erro no próprio campaigns.last_error (garante visibilidade no card)
  if (level === "error") {
    supabase.from("campaigns").update({
      last_error: message.slice(0, 500),
      last_error_at: new Date().toISOString(),
    }).eq("id", campaignId).then(() => {}, () => {});
  }

  // 3) Tabela campaign_logs (detalhes em tempo real pro painel)
  if (campaignLogsAvailable === false) return;

  try {
    const { error } = await supabase.from("campaign_logs").insert({
      campaign_id: campaignId,
      message,
      level
    });
    if (error) {
      if ((error as any).code === "42P01") {
        console.warn("[CAMPAIGN_LOG] Tabela campaign_logs não existe. Rode criar_campaign_logs.sql no Supabase. Logs continuarão só no console + webhook_logs.");
        campaignLogsAvailable = false;
      } else {
        console.error("[CAMPAIGN_LOG_DB_ERROR]", error);
      }
    } else {
      campaignLogsAvailable = true;
    }
  } catch (err) {
    console.error("[CAMPAIGN_LOG_FATAL_ERROR]", err);
  }
}

/**
 * Diagnostica PRÉ-envio: falha cedo e claro se Evolution/instância/API estiver capenga.
 * Chamado por startCampaign antes de agendar o primeiro envio.
 */
async function preflightCheck(campaignId: string): Promise<{ ok: boolean; error?: string }> {
  const { data: c } = await supabase.from("campaigns").select("*").eq("id", campaignId).single();
  if (!c) return { ok: false, error: "Campanha não encontrada no banco." };

  // Checa env
  const evoUrl = process.env.EVOLUTION_API_URL || "";
  if (!evoUrl || evoUrl.includes("url_aqui")) {
    return { ok: false, error: "EVOLUTION_API_URL não configurada em .env.local — impossível disparar." };
  }
  if (!process.env.EVOLUTION_API_KEY) {
    return { ok: false, error: "EVOLUTION_API_KEY não configurada em .env.local." };
  }

  // Checa se tem targets pending
  const { count: pendingCount } = await supabase
    .from("campaign_targets")
    .select("id", { count: "exact", head: true })
    .eq("campaign_id", campaignId)
    .eq("status", "pending");
  if (!pendingCount || pendingCount === 0) {
    return { ok: false, error: "Nenhum target pendente. Cria leads ou reseta a campanha." };
  }

  // Checa se a instância existe e está conectada (apenas pra Evolution; Cloud é sempre "open" se token válido)
  try {
    const ch = await channel.resolveChannel(c.instance_name, { fresh: true });
    if (ch.provider === "whatsapp_cloud") {
      if (!ch.cloud?.access_token || !ch.cloud?.phone_number_id) {
        return { ok: false, error: `Conexão Cloud "${c.instance_name}" sem token/phone_number_id. Configure em /whatsapp.` };
      }
    } else {
      const status = await channel.getStatus(c.instance_name);
      if (status.state === "not_found") {
        return { ok: false, error: `Instância "${c.instance_name}" não existe na Evolution API. Vai em /whatsapp e cria/conecta.` };
      }
      if (status.state !== "open") {
        return { ok: false, error: `Instância "${c.instance_name}" não está conectada (estado: ${status.state}). Escaneia o QR em /whatsapp.` };
      }
    }
  } catch (err: any) {
    return { ok: false, error: `Falha ao consultar canal: ${err.message}.` };
  }

  // Se personalize_with_ai, precisa de pelo menos UMA chave de IA (Gemini ou
  // OpenRouter). O provedor real é definido pelo modelo escolhido na campanha.
  if (c.personalize_with_ai) {
    const { data: cfg } = await supabase.from("ai_organizer_config").select("api_key, openrouter_api_key").eq("id", 1).maybeSingle();
    const hasAny = !!(cfg?.api_key && String(cfg.api_key).trim())
      || !!((cfg as any)?.openrouter_api_key && String((cfg as any).openrouter_api_key).trim());
    if (!hasAny) {
      return { ok: false, error: "personalize_with_ai ligado mas sem API Key de IA. Configure Gemini ou OpenRouter em /configuracoes." };
    }
  }

  return { ok: true };
}

export function nowHourBRT(): number {
  return Number(
    new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }).format(new Date())
  );
}

function isWithinAllowedHour(c: CampaignRow): boolean {
  return isWithinHourWindow(c.allowed_start_hour, c.allowed_end_hour);
}

export function isWithinHourWindow(startHour: number, endHour: number): boolean {
  const h = nowHourBRT();
  if (startHour <= endHour) return h >= startHour && h < endHour;
  return h >= startHour || h < endHour;
}

export function jitterMs(min: number, max: number): number {
  const lo = Math.max(5, min);
  const hi = Math.max(lo + 1, max);
  return Math.floor((lo + Math.random() * (hi - lo)) * 1000);
}

function normalizeJid(jid: string): string {
  if (!jid) return jid;
  if (jid.includes("@")) return jid; // já parece um JID
  const digits = jid.replace(/\D/g, "");
  if (!digits) return jid;
  return `${digits}@s.whatsapp.net`;
}

/**
 * @param agentId  Agente que deve "dono" da conversa. Quando vem do disparo
 *                 da automação, é o agente configurado nela — assim, quando o
 *                 lead responder, é esse agente que assume a conversa no /chat.
 *                 Se omitido, cai pro agente da instância (channel_connections).
 */
export async function findOrCreateContactSession(remoteJidRaw: string, instanceName: string, nomeNegocio?: string | null, agentId?: number | null) {
  const remoteJid = normalizeJid(remoteJidRaw);
  const phone = remoteJid.replace(/@.*$/, "").replace(/\D/g, "");

  // Busca as configurações do canal para pegar o client_id e o agent_id
  const { data: chan } = await supabase
    .from("channel_connections")
    .select("agent_id, client_id")
    .eq("instance_name", instanceName)
    .maybeSingle();

  const clientId = chan?.client_id || DEFAULT_CLIENT_ID;

  // 1. contact — race-safe: se o webhook da Evolution criou em paralelo, o
  // INSERT bate em 23505. Re-SELECT pra pegar o id criado pelo outro lado em
  // vez de perder a sessão (esse era o motivo da 1ª msg às vezes não salvar).
  const { data: existingContact } = await supabase
    .from("contacts").select("id, push_name, client_id").eq("remote_jid", remoteJid).maybeSingle();
  let contactId = existingContact?.id;

  // Se o contato existe, mas está com o client_id default ou nulo,
  // fazemos o backfill do client_id correto para unificar o CRM
  if (existingContact && (!existingContact.client_id || existingContact.client_id === DEFAULT_CLIENT_ID)) {
    await supabase.from("contacts").update({ client_id: clientId }).eq("id", contactId);
  }

  if (!contactId) {
    const ins = await supabase.from("contacts").insert({
      client_id: clientId,
      remote_jid: remoteJid, phone_number: phone, push_name: nomeNegocio || null,
    }).select("id").single();
    if (ins.data?.id) {
      contactId = ins.data.id;
    } else if ((ins.error as any)?.code === "23505") {
      const retry = await supabase.from("contacts").select("id, push_name, client_id").eq("remote_jid", remoteJid).maybeSingle();
      contactId = retry.data?.id;

      if (contactId && (!retry.data?.client_id || retry.data?.client_id === DEFAULT_CLIENT_ID)) {
        await supabase.from("contacts").update({ client_id: clientId }).eq("id", contactId);
      }

      // Outro processo criou o contato sem nome → preenche com o do negócio.
      if (contactId && nomeNegocio && !retry.data?.push_name) {
        await supabase.from("contacts").update({ push_name: nomeNegocio }).eq("id", contactId);
      }
    }
  } else if (nomeNegocio && !existingContact?.push_name) {
    // Contato JÁ existe mas sem nome (ex: criado pelo echo do webhook antes
    // do disparo). Preenche com o nome do negócio captado pela automação —
    // sem isto, a conversa aparece no /chat só como número.
    await supabase.from("contacts").update({ push_name: nomeNegocio }).eq("id", contactId);
  }
  if (!contactId) return null;

  // 2. session — mesmo cuidado de race. Se outro worker/webhook criou primeiro,
  // o unique de (contact_id, instance_name) dispara 23505 — recuperamos a
  // sessão existente em vez de devolver sessionId=null.
  const { data: existingSession } = await supabase.from("sessions")
    .select("id, agent_id").eq("contact_id", contactId).eq("instance_name", instanceName).maybeSingle();
  if (existingSession?.id) return { contactId, sessionId: existingSession.id };

  // Prioridade do agente: o explícito (config do disparo/automação) →
  // o da instância → o padrão (1). Garante que a IA certa assuma a conversa.
  const sessionAgentId = agentId || chan?.agent_id || 1;
  const ins = await supabase.from("sessions").insert({
    client_id: clientId,
    contact_id: contactId, instance_name: instanceName, agent_id: sessionAgentId, bot_status: "bot_active",
  }).select("id").single();
  let sessionId = ins.data?.id || null;
  if (!sessionId && (ins.error as any)?.code === "23505") {
    const retry = await supabase.from("sessions").select("id")
      .eq("contact_id", contactId).eq("instance_name", instanceName).maybeSingle();
    sessionId = retry.data?.id || null;
  }
  return { contactId, sessionId };
}

export async function persistOutgoingMessage(opts: {
  sessionId: string | null;
  remoteJid: string;
  instanceName: string;
  msgId: string;
  text: string;
}) {
  // Registra que este envio é automático/AI para que o webhook não auto-pause a IA!
  registerAiSend(opts.msgId);

  const now = new Date().toISOString();
  const remoteJid = normalizeJid(opts.remoteJid);

  // CRÍTICO: resolve o client_id da instância. Sem isto, o INSERT em
  // chats_dashboard ficava com client_id=NULL → o /chat (que filtra por
  // client_id) NÃO mostrava esses disparos. Esse era o motivo dos disparos
  // sumirem da lista de conversas mesmo estando salvos no banco.
  let resolvedClientId: string | null = null;
  try {
    const { data: chConn } = await supabase
      .from("channel_connections")
      .select("client_id")
      .eq("instance_name", opts.instanceName)
      .maybeSingle();
    resolvedClientId = chConn?.client_id || null;
  } catch { /* não-fatal */ }

  // V2 messages — upsert por message_id pra blindar race com webhook outgoing.
  if (opts.sessionId) {
    try {
      const msgPayload: Record<string, any> = {
        session_id: opts.sessionId,
        message_id: opts.msgId,
        sender: "ai",
        content: opts.text,
        media_category: "text",
        delivery_status: "sent",
        created_at: now,
      };
      if (resolvedClientId) msgPayload.client_id = resolvedClientId;
      let { error: msgErr } = await supabase.from("messages").upsert(msgPayload, { onConflict: "message_id" });
      // Fallback: se a coluna client_id não existir (DB antigo), tenta sem ela.
      if (msgErr && (msgErr as any).code === "PGRST204") {
        delete msgPayload.client_id;
        const retry = await supabase.from("messages").upsert(msgPayload, { onConflict: "message_id" });
        msgErr = retry.error;
      }
      if (msgErr) throw msgErr;
      await supabase.from("sessions").update({ last_message_at: now }).eq("id", opts.sessionId);
    } catch (e: any) {
      console.warn("[persist] messages upsert falhou:", e?.message);
    }
  }

  // chats_dashboard — onde o /chat lê.
  try {
    const dashPayload: Record<string, any> = {
      instance_name: opts.instanceName,
      message_id: opts.msgId,
      remote_jid: remoteJid,
      sender_type: "ai",
      content: opts.text,
      status_envio: "sent",
      created_at: now,
    };
    if (resolvedClientId) dashPayload.client_id = resolvedClientId;
    let { error } = await supabase
      .from("chats_dashboard")
      .upsert(dashPayload, { onConflict: "message_id" });
    // Fallback se a coluna client_id não existir.
    if (error && (error as any).code === "PGRST204") {
      delete dashPayload.client_id;
      const retry = await supabase
        .from("chats_dashboard")
        .upsert(dashPayload, { onConflict: "message_id" });
      error = retry.error;
    }
    if (error) throw error;
  } catch (e: any) {
    console.error("[persist] chats_dashboard error:", e.message);
  }
}
async function processNextTarget(campaignId: string): Promise<"continue" | "done" | "stopped" | "out_of_hours" | "too_soon"> {
  // Re-fetch campaign (status pode ter mudado)
  const { data: c } = await supabase.from("campaigns").select("*").eq("id", campaignId).single();
  if (!c) return "stopped";
  if (c.status !== "running") return "stopped";

  if (!isWithinAllowedHour(c as any)) {
    const msg = `⏰ Fora do horário permitido — agora são ${nowHourBRT()}h, a janela é ${c.allowed_start_hour}h-${c.allowed_end_hour}h. O disparo retoma sozinho quando a janela abrir.`;
    console.log(`[CAMPAIGN ${c.name}] ${msg}`);
    await addCampaignLog(campaignId, msg, "warning");
    return "out_of_hours";
  }

  // ───────── GATE ATÔMICO DE INTERVALO (anti-burst) ─────────
  // Vários loops/timers concorrentes pro MESMO disparo (deploy sobrepondo
  // containers, re-trigger, múltiplas instâncias do módulo no Next) faziam
  // 2-3 envios no mesmo minuto, furando o intervalo configurado.
  // Solução: "reservar o slot" com um UPDATE condicional ATÔMICO —
  //   UPDATE campaigns SET updated_at=now() WHERE id=X AND updated_at<=cutoff
  // O Postgres serializa o UPDATE: só UM loop consegue mover a linha; os
  // concorrentes recebem 0 linhas e abortam o ciclo. No máximo 1 envio por
  // intervalo, não importa quantos loops existam ou em quantos processos.
  // No fluxo normal (1 loop só) o gate NUNCA bloqueia: o jitter do loop
  // (min..max) é sempre >= min_interval, então o slot já está liberado.
  const minGapMs = Math.max(5, Number(c.min_interval_seconds) || 30) * 1000;
  const cutoffIso = new Date(Date.now() - minGapMs).toISOString();
  const { data: slot } = await supabase
    .from("campaigns")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", campaignId)
    .eq("status", "running")
    .lte("updated_at", cutoffIso)
    .select("id")
    .maybeSingle();
  if (!slot) {
    // Outro loop já disparou agora há pouco — este está adiantado.
    console.log(`[CAMPAIGN ${c.name}] gate de intervalo: envio adiantado bloqueado.`);
    return "too_soon";
  }

  // CLAIM ATÔMICO: pega o próximo pending E marca como "processing" no MESMO
  // UPDATE. Se outro worker (timer paralelo, recover do boot) tentar pegar o
  // mesmo, vai falhar a condição `status=pending` → 0 rows → pula. Resolve a
  // duplicação de envio (cliente recebia 2 mensagens iguais).
  const { data: candidate } = await supabase
    .from("campaign_targets")
    .select("id")
    .eq("campaign_id", campaignId)
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!candidate) {
    // Sem pending — termina.
    await supabase.from("campaigns").update({ status: "done", finished_at: new Date().toISOString() }).eq("id", campaignId);
    await addCampaignLog(campaignId, "Campanha finalizada. Todos os leads foram processados.", "success");
    console.log(`[CAMPAIGN ${c.name}] Concluída.`);
    return "done";
  }

  // Tenta claim. Só prossegue se ESTE chamador conseguiu mover pending→processing.
  // Não atualiza `updated_at` porque a tabela campaign_targets não tem essa coluna.
  const { data: claimed } = await supabase
    .from("campaign_targets")
    .update({ status: "processing" })
    .eq("id", candidate.id)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  if (!claimed) {
    // Outro worker pegou primeiro. Tenta de novo no próximo loop.
    return "continue";
  }
  const target = claimed;

  await addCampaignLog(campaignId, `Processando lead: ${target.nome_negocio || target.remote_jid}`, "info");

  // Validação prévia + resolução do JID canônico. Grupos (@g.us) pulam.
  // sendJid = pra ONDE enviar E sob qual JID salvar no chat. O WhatsApp pode
  // usar um JID diferente do número captado (9º dígito no Brasil) — usar o
  // canônico mantém o disparo e a resposta do cliente NO MESMO chat (era o
  // motivo da mensagem de disparo "sumir" da conversa).
  let sendJid = target.remote_jid;
  if (!target.remote_jid.includes("@g.us")) {
    const phone = target.remote_jid.replace(/@.*$/, "").replace(/\D/g, "");
    if (phone) {
      const check = await channel.checkWhatsAppNumbersDetailed([phone], c.instance_name);
      // A chave do retorno pode vir como número limpo OU canônico — pega a 1ª entrada.
      const entry = check[phone] || Object.values(check)[0] || null;
      if (entry && entry.exists === false) {
        await supabase.from("campaign_targets").update({
          status: "skipped",
          error_message: "Número não existe no WhatsApp (pré-check)",
          attempts: (target.attempts || 0) + 1,
        }).eq("id", target.id);
        await supabase.from("campaigns").update({
          skipped_count: (c.skipped_count || 0) + 1,
          updated_at: new Date().toISOString(),
        }).eq("id", campaignId);
        await addCampaignLog(campaignId, `⊘ Pulado ${target.remote_jid} — número não tem WhatsApp`, "warning");
        return "continue";
      }
      if (entry && entry.jid) {
        sendJid = entry.jid;
        if (sendJid !== target.remote_jid) {
          console.log(`[CAMPAIGN ${c.name}] JID divergente detectado. Original: ${target.remote_jid} · Canônico: ${sendJid}. Unificando...`);

          // 1. Atualiza campaign_targets
          try {
            await supabase
              .from("campaign_targets")
              .update({ remote_jid: sendJid })
              .eq("id", target.id);
          } catch (err) {
            console.error(`[CAMPAIGN ${c.name}] Erro ao atualizar campaign_targets para o JID canônico:`, err);
          }

          // 2. Atualiza leads_extraidos de forma resiliente
          try {
            const { error: updErr } = await supabase
              .from("leads_extraidos")
              .update({ remoteJid: sendJid })
              .eq("remoteJid", target.remote_jid);

            if (updErr) {
              if (updErr.code === "23505" || updErr.message?.includes("unique")) {
                console.log(`[CAMPAIGN ${c.name}] JID canônico ${sendJid} já existe em leads_extraidos. Iniciando merge de inteligência e dados.`);
                const { data: oldLead } = await supabase
                  .from("leads_extraidos")
                  .select("*")
                  .eq("remoteJid", target.remote_jid)
                  .maybeSingle();

                if (oldLead) {
                  const mergePayload: Record<string, any> = {};
                  const fieldsToMerge = [
                    "nome_negocio", "ramo_negocio", "categoria", "endereco", "website",
                    "instagram", "facebook", "avaliacao", "reviews", "status",
                    "intelligence", "intelligence_at", "icp_score", "lead_type",
                    "justificativa_ia", "resumo_ia", "ia_last_analyzed_at"
                  ];

                  for (const field of fieldsToMerge) {
                    if (oldLead[field] !== undefined && oldLead[field] !== null) {
                      mergePayload[field] = oldLead[field];
                    }
                  }

                  await supabase
                    .from("leads_extraidos")
                    .update(mergePayload)
                    .eq("remoteJid", sendJid);

                  await supabase
                    .from("leads_extraidos")
                    .delete()
                    .eq("id", oldLead.id);

                  console.log(`[CAMPAIGN ${c.name}] Merge e deleção do lead duplicado ${target.remote_jid} concluídos.`);
                }
              } else {
                throw updErr;
              }
            }
          } catch (err) {
            console.error(`[CAMPAIGN ${c.name}] Erro na unificação/merge de leads_extraidos:`, err);
          }

          target.remote_jid = sendJid;
        }
      }
    }
  }

  // Busca o lead completo no CRM pra abastecer TODAS as variáveis do template
  // ({{endereco}}, {{website}}, {{avaliacao}}, {{ramo}}, etc) — não só o nome.
  const { data: leadFull } = await supabase
    .from("leads_extraidos")
    .select("nome_negocio, ramo_negocio, telefone, endereco, website, instagram, facebook, avaliacao, reviews, status")
    .eq("remoteJid", target.remote_jid)
    .maybeSingle();

  // Contexto de render — usado no template AGORA e DE NOVO depois da IA
  // (rede de segurança: nenhuma {{variavel}} pode chegar ao cliente).
  const renderCtx = {
    remoteJid:    sendJid,
    nome_negocio: leadFull?.nome_negocio || target.nome_negocio,
    ramo_negocio: leadFull?.ramo_negocio || target.ramo_negocio,
    telefone:     leadFull?.telefone || null,
    endereco:     leadFull?.endereco || null,
    website:      leadFull?.website || null,
    instagram:    leadFull?.instagram || null,
    facebook:     leadFull?.facebook || null,
    avaliacao:    leadFull?.avaliacao ?? null,
    reviews:      leadFull?.reviews ?? null,
    status:       leadFull?.status || null,
  };

  // Renderiza msg base substituindo variáveis ({{saudacao}}, {{nome_empresa}}, etc)
  let text = renderTemplate(c.message_template, renderCtx);

  // Guarda o texto ANTES da IA — é o que foi enviado pro Gemini. Permite comparar
  // "template" vs "resposta da IA" depois no painel de histórico.
  let aiInputText: string | null = null;

  // Se "Personalizar com IA" estiver ativo, passa pelo Gemini ANTES de enviar
  if (c.personalize_with_ai) {
    aiInputText = text;
    try {
      await addCampaignLog(campaignId, `Personalizando mensagem com IA para ${target.nome_negocio}...`, "info");
      text = await personalizeWithAI({
        baseMessage: text,
        model: c.ai_model || "gemini-1.5-flash",
        customPrompt: c.ai_prompt || null,
        nomeEmpresa: target.nome_negocio || "",
        ramo: target.ramo_negocio || "",
        useWebSearch: !!c.use_web_search,
        campaignId: c.id,
        campaignName: c.name,
        remoteJid: target.remote_jid,  // ← injeta briefing cacheado
        instanceName: c.instance_name,  // ← resolve clientId dono do gasto
      });
      await addCampaignLog(campaignId, `IA gerou: "${text.slice(0, 140)}${text.length > 140 ? "…" : ""}"`, "success");
    } catch (e: any) {
      const errMsg = `Falha ao personalizar com IA, usando template direto: ${e.message}`;
      console.warn(`[CAMPAIGN ${c.name}] ${errMsg}`);
      await addCampaignLog(campaignId, errMsg, "warning");
      // Continua com `text` original (renderTemplate)
    }
  }

  // REDE DE SEGURANÇA — render final. Se a IA deixou/reintroduziu qualquer
  // {{variavel}} ou {variavel}, resolve agora. O cliente NUNCA pode receber chaves cruas.
  text = renderTemplate(text, renderCtx);
  // BLINDAGEM FINAL — a IA, ao reescrever, às vezes "generaliza" o texto e
  // RE-INTRODUZ {{saudacao}}/{{nome_empresa}} como se montasse um template.
  // Aqui, qualquer {{...}} ou {...} que ainda reste (variável inventada ou desconhecida)
  // é REMOVIDA. O cliente JAMAIS pode receber chaves cruas no WhatsApp.
  if (/\{\{.*?\}\}|\{.*?\}/.test(text)) {
    await addCampaignLog(campaignId,
      `⚠️ A IA devolveu variável {{...}} ou {...} não preenchida — removida automaticamente da mensagem antes do envio.`, "warning");
    text = text
      .replace(/\{\{\s*[\w-]+\s*\}\}/g, "")  // remove {{var}} ou {{var-name}}
      .replace(/\{\s*[\w-]+\s*\}/g, "")    // remove {var} ou {var-name}
      .replace(/[ \t]{2,}/g, " ")            // colapsa espaços duplos
      .replace(/\s+([.,!?])/g, "$1")         // tira espaço antes de pontuação
      .trim();
  }

  try {
    // Registra o envio pendente antes de disparar o sendMessage para evitar race conditions com o webhook echo
    registerPendingAutomatedSend(c.instance_name, sendJid, text);

    // Envia (sendMessage já faz "composing" presence antes)
    const result = await channel.sendMessage(sendJid, text, c.instance_name);
    // Sufixo aleatório no fallback evita colisão quando vários disparos saem
    // no mesmo ms (Date.now era duplicável → unique violation no insert).
    const msgId = (result as any)?.messageId || (result as any)?.key?.id || (result as any)?.data?.key?.id || `bulk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Persiste no chat (sessions/messages/chats_dashboard) pra IA ter contexto.
    // Esse passo é "best-effort" — se falhar, não queremos marcar o envio como erro,
    // porque a mensagem já saiu no WhatsApp. Apenas logamos.
    try {
      const sess = await findOrCreateContactSession(sendJid, c.instance_name, renderCtx.nome_negocio, c.agent_id);
      await persistOutgoingMessage({
        sessionId: sess?.sessionId || null,
        remoteJid: sendJid,
        instanceName: c.instance_name,
        msgId,
        text,
      });
    } catch (persistErr: any) {
      const m = `⚠ Mensagem foi enviada no WhatsApp mas falhou ao salvar no chats_dashboard: ${persistErr?.message || persistErr}. Vai precisar refresh no /chat pra aparecer.`;
      console.warn(`[CAMPAIGN ${c.name}] ${m}`);
      await addCampaignLog(campaignId, m, "warning");
    }

    const targetUpdate: Record<string, any> = {
      status: "sent",
      message_id: msgId,
      rendered_message: text,
      sent_at: new Date().toISOString(),
      attempts: (target.attempts || 0) + 1,
    };
    if (aiInputText) targetUpdate.ai_input = aiInputText;
    let tgtUpd = await supabase.from("campaign_targets").update(targetUpdate).eq("id", target.id);
    // Fallback: se a coluna ai_input ainda não foi migrada, tenta sem ela
    if (tgtUpd.error && (tgtUpd.error as any).code === "PGRST204" && "ai_input" in targetUpdate) {
      delete targetUpdate.ai_input;
      tgtUpd = await supabase.from("campaign_targets").update(targetUpdate).eq("id", target.id);
      console.warn("[CAMPAIGN] coluna ai_input não existe. Rode criar_campaign_logs.sql pra habilitar histórico do input da IA.");
    }

    await supabase.from("campaigns").update({
      sent_count: (c.sent_count || 0) + 1,
      updated_at: new Date().toISOString(),
    }).eq("id", campaignId);

    // Disparo enviado com sucesso → move o lead para "primeiro_contato" no Kanban.
    // Regra: move quando o status atual está ANTES de primeiro_contato na hierarquia.
    // Preserva leads já mais avançados (interessado/follow-up/agendado/fechado).
    try {
      const { data: existingLead } = await supabase
        .from("leads_extraidos")
        .select("id, status")
        .eq("remoteJid", target.remote_jid)
        .maybeSingle();

      const nowIso = new Date().toISOString();
      // Mesma hierarquia usada em /api/ai-organize
      const STATUS_RANK: Record<string, number> = {
        "": 0, "novo": 0,
        "primeiro_contato": 1,
        "interessado": 2,
        "follow-up": 3,
        "agendado": 4,
        "fechado": 5,
      };
      const PRIMEIRO_RANK = 1;

      if (existingLead) {
        const currentRank = STATUS_RANK[existingLead.status || ""] ?? 0;
        if (currentRank < PRIMEIRO_RANK) {
          const { error: updErr } = await supabase
            .from("leads_extraidos")
            .update({
              status: "primeiro_contato",
              primeiro_contato_at: nowIso,
              primeiro_contato_source: "disparo",
              updated_at: nowIso,
            })
            .eq("id", existingLead.id);
          if (updErr) {
            // Fallback: algumas colunas podem não existir ainda
            if ((updErr as any).code === "PGRST204") {
              await supabase.from("leads_extraidos")
                .update({ status: "primeiro_contato" })
                .eq("id", existingLead.id);
              console.warn(`[CAMPAIGN ${c.name}] leads_extraidos sem colunas primeiro_contato_at/source. Rode a migração correspondente.`);
            } else {
              throw updErr;
            }
          }
          await addCampaignLog(campaignId, `Lead ${target.nome_negocio || target.remote_jid} movido p/ primeiro_contato`, "info");
        } else {
          await addCampaignLog(campaignId, `Lead ${target.nome_negocio || target.remote_jid} mantido no status "${existingLead.status}" (mais avançado que primeiro_contato)`, "info");
        }
      } else {
        // Sem lead — cria no estágio primeiro_contato direto
        const { error: insErr } = await supabase.from("leads_extraidos").insert({
          remoteJid: target.remote_jid,
          nome_negocio: target.nome_negocio || `Lead Disparo (${target.remote_jid.split("@")[0]})`,
          ramo_negocio: target.ramo_negocio || null,
          status: "primeiro_contato",
          primeiro_contato_at: nowIso,
          primeiro_contato_source: "disparo",
        });
        if (insErr && (insErr as any).code === "PGRST204") {
          await supabase.from("leads_extraidos").insert({
            remoteJid: target.remote_jid,
            nome_negocio: target.nome_negocio || `Lead Disparo (${target.remote_jid.split("@")[0]})`,
            ramo_negocio: target.ramo_negocio || null,
            status: "primeiro_contato",
          });
        } else if (insErr) {
          throw insErr;
        }
        await addCampaignLog(campaignId, `Lead criado p/ ${target.remote_jid} em primeiro_contato`, "info");
      }
    } catch (leadErr: any) {
      const msg = `⚠ Falha ao mover lead para primeiro_contato: ${leadErr?.message || leadErr}`;
      console.warn(`[CAMPAIGN ${c.name}] ${msg}`);
      await addCampaignLog(campaignId, msg, "warning");
    }

    consecutiveFailures.set(campaignId, 0);
    // Log com a MENSAGEM REAL enviada (truncada pra 240 chars). Operador
    // precisa ver o que foi enviado pra cada lead, não só "OK".
    const preview = String(text || "").replace(/\s+/g, " ").slice(0, 240);
    const successMsg = `✓ Enviada → ${target.nome_negocio || target.remote_jid}\n📨 "${preview}${(text || "").length > 240 ? "…" : ""}"`;
    console.log(`[CAMPAIGN ${c.name}] ${successMsg}`);
    await addCampaignLog(campaignId, successMsg, "success");
    return "continue";
  } catch (err: any) {
    const msg = err?.message || String(err);
    const is429 = /429|rate|too many/i.test(msg);

    // Evolution retorna 400 com payload { exists: false } quando o número não tem WhatsApp.
    // Isso NÃO é erro nosso — é dado ruim no lead. Pula, não conta como "consecutive failure",
    // e marca como skipped pra o operador saber que o número é inválido.
    const numberDoesNotExist = /"exists"\s*:\s*false/i.test(msg) || /number does not exist|not exists/i.test(msg);

    if (numberDoesNotExist) {
      await supabase.from("campaign_targets").update({
        status: "skipped",
        error_message: "Número não existe no WhatsApp",
        attempts: (target.attempts || 0) + 1,
      }).eq("id", target.id);

      await supabase.from("campaigns").update({
        skipped_count: (c.skipped_count || 0) + 1,
        updated_at: new Date().toISOString(),
      }).eq("id", campaignId);

      consecutiveFailures.set(campaignId, 0); // reseta — não é falha real
      const skipMsg = `⊘ Pulado ${target.remote_jid} — número não existe no WhatsApp`;
      console.log(`[CAMPAIGN ${c.name}] ${skipMsg}`);
      await addCampaignLog(campaignId, skipMsg, "warning");
      return "continue";
    }

    const fails = (consecutiveFailures.get(campaignId) || 0) + 1;
    consecutiveFailures.set(campaignId, fails);

    await supabase.from("campaign_targets").update({
      status: is429 && (target.attempts || 0) < 3 ? "pending" : "failed",
      error_message: msg.slice(0, 300),
      attempts: (target.attempts || 0) + 1,
    }).eq("id", target.id);

    if (!is429) {
      await supabase.from("campaigns").update({
        failed_count: (c.failed_count || 0) + 1,
        updated_at: new Date().toISOString(),
      }).eq("id", campaignId);
    }

    const errorMsg = `✗ Falha em ${target.remote_jid}: ${msg}`;
    console.error(`[CAMPAIGN ${c.name}] ${errorMsg}`);
    await addCampaignLog(campaignId, errorMsg, "error");

    // Após 5 falhas REAIS seguidas → pausa automática
    if (fails >= 5) {
      await supabase.from("campaigns").update({ status: "paused", updated_at: new Date().toISOString() }).eq("id", campaignId);
      const pauseMsg = `5 falhas seguidas — Campanha PAUSADA automaticamente por segurança.`;
      console.warn(`[CAMPAIGN ${c.name}] ${pauseMsg}`);
      await addCampaignLog(campaignId, pauseMsg, "error");
      return "stopped";
    }
    return "continue";
  }
}

function scheduleNext(campaignId: string, delayMs: number) {
  // Limpa timer anterior se existir
  const old = runningTimers.get(campaignId);
  if (old) clearTimeout(old);
  const t = setTimeout(() => loop(campaignId).catch(e => console.error("[CAMPAIGN loop error]", e)), delayMs);
  runningTimers.set(campaignId, t);
}

async function loop(campaignId: string) {
  try {
    const result = await processNextTarget(campaignId);
    if (result === "done" || result === "stopped") {
      runningTimers.delete(campaignId);
      return;
    }
    if (result === "out_of_hours") {
      await addCampaignLog(campaignId, "Fora da janela permitida. Aguardando 5 min para rechecar...", "info");
      scheduleNext(campaignId, 5 * 60 * 1000); // tenta em 5 min
      return;
    }
    // Próximo envio com jitter
    const { data: c } = await supabase.from("campaigns").select("min_interval_seconds, max_interval_seconds").eq("id", campaignId).single();
    if (result === "too_soon") {
      // Loop concorrente adiantado — o gate de intervalo barrou o envio.
      // Reagenda no ritmo normal; o loop "dono" segue enviando sozinho.
      const wait = jitterMs(Number(c?.min_interval_seconds || 30), Number(c?.max_interval_seconds || 60));
      scheduleNext(campaignId, wait);
      return;
    }
    const wait = jitterMs(Number(c?.min_interval_seconds || 30), Number(c?.max_interval_seconds || 60));
    const secs = Math.round(wait / 1000);
    console.log(`[CAMPAIGN ${campaignId}] Próximo envio em ${secs}s`);
    await addCampaignLog(campaignId, `Aguardando ${secs}s até o próximo envio...`, "info");
    scheduleNext(campaignId, wait);
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`[CAMPAIGN ${campaignId}] Erro inesperado no loop:`, msg);
    await addCampaignLog(campaignId, `Erro inesperado no loop: ${msg}. Tentando de novo em 30s.`, "error");
    // Não deixa a campanha morrer por um erro pontual — reagenda em 30s.
    scheduleNext(campaignId, 30_000);
  }
}

export async function startCampaign(campaignId: string): Promise<{ ok: boolean; error?: string }> {
  // Preflight — falha cedo com mensagem clara, em vez de deixar a campanha sofrer em silêncio.
  const check = await preflightCheck(campaignId);
  if (!check.ok) {
    await addCampaignLog(campaignId, `Preflight falhou: ${check.error}`, "error");
    await supabase.from("campaigns").update({
      status: "draft", // volta pra draft — a campanha não chegou a rodar
      last_error: check.error!.slice(0, 500),
      last_error_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", campaignId);
    return { ok: false, error: check.error };
  }

  await supabase.from("campaigns").update({
    status: "running",
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_error: null,
    last_error_at: null,
  }).eq("id", campaignId);
  consecutiveFailures.set(campaignId, 0);

  // Primeiro envio respeita o INTERVALO CONFIGURADO da campanha — não um
  // "burst" de 1-3s. O cliente definiu o ritmo do disparo (anti-ban); a 1ª
  // mensagem também o segue.
  const { data: cfgRow } = await supabase
    .from("campaigns")
    .select("min_interval_seconds, max_interval_seconds")
    .eq("id", campaignId)
    .maybeSingle();
  const firstDelay = jitterMs(
    Number(cfgRow?.min_interval_seconds || 30),
    Number(cfgRow?.max_interval_seconds || 60),
  );
  await addCampaignLog(campaignId,
    `Preflight OK. 1º disparo em ~${Math.round(firstDelay / 1000)}s (ritmo configurado da campanha).`, "success");
  scheduleNext(campaignId, firstDelay);
  return { ok: true };
}

/**
 * Recupera campanhas marcadas como "running" no banco mas sem timer em memória.
 * Chamado no boot do servidor (instrumentation.ts).
 */
export async function recoverRunningCampaigns(): Promise<number> {
  // Antes de retomar: reseta targets em "processing" → "pending".
  // Se o servidor crashou enquanto um target estava sendo enviado, fica
  // travado em "processing". Sem reset, o claim atômico nunca pegaria mais
  // ele e a campanha pararia de avançar.
  // CUIDADO: só faz isso na recuperação, no boot. Em runtime normal, "processing"
  // significa "outro worker está enviando agora — não toca".
  try {
    const { data: stuck } = await supabase
      .from("campaign_targets")
      .update({ status: "pending" })
      .eq("status", "processing")
      .select("id");
    if (stuck && stuck.length > 0) {
      console.log(`[CAMPAIGN RECOVER] ${stuck.length} target(s) destravado(s) de 'processing' → 'pending'.`);
    }
  } catch (e) {
    console.warn("[CAMPAIGN RECOVER] reset de processing falhou:", (e as Error).message);
  }

  const { data: running } = await supabase
    .from("campaigns")
    .select("id, name")
    .eq("status", "running");
  let recovered = 0;
  for (const c of running || []) {
    if (runningTimers.has(c.id)) continue;
    console.log(`[CAMPAIGN RECOVER] Retomando "${c.name}" (${c.id}) após restart do servidor.`);
    await addCampaignLog(c.id, "Servidor reiniciou — retomando a campanha automaticamente.", "warning");
    consecutiveFailures.set(c.id, 0);
    scheduleNext(c.id, 2000 + Math.floor(Math.random() * 3000));
    recovered++;
  }
  return recovered;
}

/**
 * REDE DE SEGURANÇA do disparo. Chamada por um ticker periódico
 * (instrumentation.ts). Procura campanhas `running` no banco que NÃO têm
 * timer ativo na memória do processo e as reativa.
 *
 * Por que isto existe: o avanço do disparo depende de uma corrente de
 * `setTimeout` em memória. Qualquer coisa que quebre essa corrente —
 * restart do servidor, deploy, processo dormindo, o timer de "fora de
 * horário" morrendo de madrugada — deixava a campanha `running` parada
 * PRA SEMPRE, sem ninguém pra retomar (o `recoverRunningCampaigns` só roda
 * no boot). Este tick roda a cada ~90s e ressuscita qualquer campanha órfã.
 *
 * Idempotente: se a campanha já tem timer, é ignorada. Só age em órfãs.
 */
export async function tickRunningCampaigns(): Promise<number> {
  const { data: running } = await supabase
    .from("campaigns")
    .select("id, name, max_interval_seconds, updated_at")
    .eq("status", "running");
  let revived = 0;
  for (const c of running || []) {
    if (runningTimers.has(c.id)) continue; // já tem timer — tudo certo

    // Só revive se a campanha está REALMENTE parada: última atividade
    // (updated_at) há mais que o intervalo máximo + 5min de folga. Uma
    // campanha saudável, apenas esperando entre um envio e outro, NÃO é
    // tocada — reativá-la criaria um loop concorrente e, com ele, o burst
    // de envios em rajada. O gate de intervalo ainda protege como 2ª linha.
    const maxGapMs = (Number(c.max_interval_seconds) || 60) * 1000 + 5 * 60_000;
    const idleMs = Date.now() - new Date(c.updated_at || 0).getTime();
    if (idleMs < maxGapMs) continue;

    // Campanha `running` sem timer = ninguém disparando. Targets presos em
    // "processing" são de um envio que morreu junto com o timer — destrava.
    try {
      const { data: stuck } = await supabase
        .from("campaign_targets")
        .update({ status: "pending" })
        .eq("campaign_id", c.id)
        .eq("status", "processing")
        .select("id");
      if (stuck && stuck.length > 0) {
        console.log(`[CAMPAIGN TICK] "${c.name}": ${stuck.length} target(s) destravado(s).`);
      }
    } catch (e) {
      console.warn("[CAMPAIGN TICK] reset de processing falhou:", (e as Error).message);
    }

    console.log(`[CAMPAIGN TICK] "${c.name}" (${c.id}) está running mas sem timer — reativando.`);
    await addCampaignLog(c.id, "🔄 Disparo reativado automaticamente (auto-recuperação — o timer havia sido perdido).", "warning");
    consecutiveFailures.set(c.id, 0);
    scheduleNext(c.id, 1500 + Math.floor(Math.random() * 2500));
    revived++;
  }
  return revived;
}

export async function pauseCampaign(campaignId: string): Promise<void> {
  const t = runningTimers.get(campaignId);
  if (t) { clearTimeout(t); runningTimers.delete(campaignId); }
  await supabase.from("campaigns").update({ status: "paused", updated_at: new Date().toISOString() }).eq("id", campaignId);
}

export async function cancelCampaign(campaignId: string): Promise<void> {
  const t = runningTimers.get(campaignId);
  if (t) { clearTimeout(t); runningTimers.delete(campaignId); }
  await supabase.from("campaigns").update({ status: "cancelled", finished_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", campaignId);
}

export function isCampaignActive(campaignId: string): boolean {
  return runningTimers.has(campaignId);
}

/* ============================================================
   PERSONALIZAÇÃO COM IA (opcional, com web_search opcional)
   ============================================================ */

async function personalizeWithAI(opts: {
  baseMessage: string;
  model: string;
  customPrompt?: string | null;
  nomeEmpresa: string;
  ramo: string;
  useWebSearch: boolean;
  campaignId?: string;
  campaignName?: string;
  /** remoteJid pra puxar o briefing cacheado de lead-intelligence (se houver). */
  remoteJid?: string;
  /** instance_name da campanha — pra resolver o client_id dono do gasto de IA. */
  instanceName?: string;
}): Promise<string> {
  // API keys centrais — mesmas que o resto do sistema usa (Configurações).
  const { getAiKeys } = await import("@/lib/ai-keys");
  const { startAiChat, providerOf, providerDisplayName } = await import("@/lib/ai-provider");
  const { resolveModel } = await import("@/lib/ai-default-model");
  const keys = await getAiKeys();

  const modelId = (await resolveModel(opts.model)) || opts.model;
  const provider = providerOf(modelId);
  if (provider === "gemini" && !keys.gemini) throw new Error("Sem API key Gemini configurada. Salve em Configurações.");
  if (provider === "openrouter" && !keys.openrouter) throw new Error("Sem API key OpenRouter configurada. Salve em Configurações.");

  // Ferramenta web_search (opcional) — declaração neutra (JSON Schema), funciona
  // tanto no Gemini quanto no OpenRouter.
  const tools = opts.useWebSearch ? [{
    name: "web_search",
    description: "Busca rápida na internet. Use pra descobrir algo específico sobre a empresa do cliente que tornaria a mensagem mais relevante.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "O que buscar — frase curta" } },
      required: ["query"],
    },
  }] : [];

  // Se há briefing IA cacheado pra esse lead, injeta como contexto.
  // Esse pedaço entra ANTES das instruções — IA vê o ICP, dores, ângulo
  // recomendado, e personaliza muito melhor sem gastar tokens chamando outra
  // análise. O contexto é compacto (~50-100 tokens).
  let intelContext = "";
  if (opts.remoteJid) {
    try {
      const { getCachedIntelligence, intelligenceToPromptContext } = await import("@/lib/lead-intelligence");
      const intel = await getCachedIntelligence(opts.remoteJid);
      if (intel) intelContext = intelligenceToPromptContext(intel) + "\n\n";
    } catch (e) {
      // Não-fatal — segue sem briefing.
    }
  }

  // Se a campanha tem um prompt custom salvo, usa ele. Senão usa o padrão.
  const customInstructions = opts.customPrompt?.trim();
  const sys = customInstructions
    ? `${customInstructions}

${intelContext}DADOS DO LEAD:
- Empresa: ${opts.nomeEmpresa || "(não informada)"}
- Ramo: ${opts.ramo || "(não informado)"}

MENSAGEM-BASE (template do operador):
"""
${opts.baseMessage}
"""

${opts.useWebSearch ? "Ferramenta web_search disponível: use no máximo 1x pra pegar UM detalhe relevante da empresa." : ""}

Devolva APENAS a mensagem final, em PT-BR, sem aspas, sem explicação.`
    : `Você é um SDR experiente fazendo uma primeira abordagem PROFISSIONAL via WhatsApp.

${intelContext}DADOS DO LEAD:
- Empresa: ${opts.nomeEmpresa || "(não informada)"}
- Ramo: ${opts.ramo || "(não informado)"}

MENSAGEM-BASE (template do operador):
"""
${opts.baseMessage}
"""

INSTRUÇÕES:
- Reescreva a MENSAGEM-BASE de forma natural, curta (até 3 frases), em PT-BR.
- Mantenha o sentido original do template.
- Personalize SUTILMENTE pra empresa/ramo (sem inventar nada).
${opts.useWebSearch ? "- Se útil, use a tool web_search pra confirmar UM detalhe da empresa (1 chamada no máximo). NÃO repita pesquisas." : ""}
- Não use emojis exagerados.
- NÃO invente dados que não tem certeza.
- Devolva APENAS a mensagem final, sem aspas e sem explicação.`;

  // thinkingBudget=0: geração one-shot de mensagem de disparo não precisa de
  // raciocínio em cadeia (cobrado como saída, caro). Economiza sem perder nada.
  const session = await startAiChat({
    modelRef: modelId,
    systemInstruction: sys,
    history: [],
    tools,
    thinkingBudget: 0,
    geminiApiKey: keys.gemini,
    openrouterApiKey: keys.openrouter,
  });

  let turn = await session.sendUser(
    "Gere a mensagem final agora. IMPORTANTE: escreva o texto REAL e " +
    "completo, já preenchido com o nome da empresa e a saudação — " +
    "NUNCA use variáveis, chaves {{ }} nem colchetes na resposta."
  );

  // Acumula tokens
  let tp = turn.usage.promptTokens, tc = turn.usage.completionTokens, tt = turn.usage.totalTokens;
  let finalText = turn.text.replace(/^["']|["']$/g, "");

  // Trata 1 chamada de tool (web_search) se houver
  const call = turn.toolCalls[0];
  if (call && opts.useWebSearch && call.name === "web_search") {
    const q = String((call.args as any)?.query || "");
    try {
      const results = await webSearch(q, 3);
      const summary = results.length > 0
        ? results.map(r => `${r.title}: ${r.snippet}`).join("\n")
        : "Nenhum resultado.";
      turn = await session.sendToolResults([{ name: "web_search", id: call.id, response: { results: summary } }]);
      tp += turn.usage.promptTokens; tc += turn.usage.completionTokens; tt += turn.usage.totalTokens;
      finalText = turn.text.replace(/^["']|["']$/g, "");
    } catch {
      // mantém finalText anterior
    }
  }

  // Resolve client_id dono da campanha pela instância — sem isso, o gasto
  // cai no Default client e o /tokens do tenant fica sem custo de disparo.
  let clientIdForLog: string | undefined;
  if (opts.instanceName) {
    try {
      const resolved = await clientIdFromInstance(opts.instanceName);
      if (resolved) clientIdForLog = resolved;
    } catch { /* não-fatal, loga como default */ }
  }

  logTokenUsage({
    source: "disparo",
    sourceId: opts.campaignId || null,
    sourceLabel: opts.campaignName || "Disparo em Massa",
    model: session.modelUsed(),
    provider: providerDisplayName(provider),
    promptTokens: tp,
    completionTokens: tc,
    totalTokens: tt,
    clientId: clientIdForLog,
    metadata: { useWebSearch: opts.useWebSearch, nomeEmpresa: opts.nomeEmpresa },
  });

  return finalText;
}
