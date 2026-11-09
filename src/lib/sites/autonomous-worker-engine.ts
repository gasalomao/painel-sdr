import * as fs from "node:fs/promises";
import * as path from "node:path";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { provisionLeadWorkspace } from "./workspace-provisioner";
import { generateSiteWithAutoCorrection } from "./site-generation-loop";
import { deployToVercel } from "./vercel-deployer";
import { inspectAutonomousSitePreview } from "./qa-inspector";
import { renderTemplate } from "@/lib/template-vars";
import { DEFAULT_SITE_PREVIEW_PING_MESSAGE } from "./agreement-detector";

export interface AutonomousWorkerOptions {
  pollIntervalMs?: number;
  maxAttempts?: number;
  signal?: AbortSignal;
}

/**
 * Resolve a melhor instância de WhatsApp conectada para comunicar com o lead.
 */
export async function resolveInstanceForLead(
  remoteJid?: string | null,
  clientId?: string | null,
  supabase = supabaseAdmin
): Promise<string | null> {
  if (!supabase) return null;

  // 1. Tenta a instância do histórico recente desta conversa
  if (remoteJid && clientId) {
    const { data: lastChat } = await supabase
      .from("chats_dashboard")
      .select("instance_name")
      .eq("remote_jid", remoteJid)
      .eq("client_id", clientId)
      .not("instance_name", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastChat?.instance_name) return lastChat.instance_name;
  }

  // 2. Tenta a instância vinculada ao tenant em channel_connections
  if (clientId) {
    const { data: conn } = await supabase
      .from("channel_connections")
      .select("instance_name")
      .eq("client_id", clientId)
      .order("status", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (conn?.instance_name) return conn.instance_name;
  }

  // 3. Fallback para qualquer conexão disponível no sistema
  const { data: fallbackConn } = await supabase
    .from("channel_connections")
    .select("instance_name")
    .limit(1)
    .maybeSingle();

  return (
    fallbackConn?.instance_name ||
    process.env.EVOLUTION_INSTANCE_NAME ||
    process.env.INSTANCE_NAME ||
    null
  );
}

/**
 * Registra eventos em tempo real na tabela `automation_logs` para visualização ao vivo no painel de automação.
 */
export async function logAutonomousSiteEvent(
  lead: Record<string, unknown>,
  message: string,
  level: "info" | "success" | "warning" | "error" = "info",
  extraMeta?: Record<string, any>,
  supabase = supabaseAdmin
): Promise<void> {
  if (!supabase) return;

  const clientId = typeof lead.client_id === "string" ? lead.client_id : null;
  const leadId = lead.id;

  try {
    let autoId: string | null = null;

    // 1. Tenta extrair a automação vinculada diretamente ao lead (verificando existência)
    const directAutoId = (lead.business_details as any)?._automationCapture?.automationId || (lead as any).automation_id;
    if (typeof directAutoId === "string" && directAutoId.length > 10) {
      const { data: check } = await supabase
        .from("automations")
        .select("id")
        .eq("id", directAutoId)
        .maybeSingle();
      if (check?.id) {
        autoId = check.id;
      }
    }

    if (!autoId && clientId) {
      const { data: auto } = await supabase
        .from("automations")
        .select("id")
        .eq("client_id", clientId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (auto?.id) autoId = auto.id;
    }

    if (!autoId) {
      const { data: anyAuto } = await supabase
        .from("automations")
        .select("id, client_id")
        .limit(1)
        .maybeSingle();

      if (anyAuto?.id) autoId = anyAuto.id;
    }

    if (!autoId) {
      console.log(`[autonomous-site-log] [${level.toUpperCase()}] ${message}`);
      return;
    }

    const { error: insErr } = await supabase.from("automation_logs").insert({
      automation_id: autoId,
      client_id: clientId || "00000000-0000-0000-0000-000000000001",
      kind: "previa",
      level,
      message: String(message).slice(0, 1000),
      remote_jid: typeof lead.remoteJid === "string" && lead.remoteJid.includes("@")
        ? lead.remoteJid
        : typeof lead.telefone === "string" && lead.telefone.replace(/\D/g, "").length >= 10
        ? `${lead.telefone.replace(/\D/g, "")}@s.whatsapp.net`
        : null,
      metadata: {
        lead_id: leadId,
        nome_negocio: lead.nome_negocio,
        link_previa: lead.link_previa,
        ...extraMeta,
      },
    });
    if (insErr) console.warn("[autonomous-worker] Erro ao gravar automation_logs:", insErr.message);
  } catch (err: any) {
    console.warn("[autonomous-worker] Falha ao registrar log em automation_logs:", err?.message);
  }
}

/**
 * Envia ativamente a mensagem de "Ping de Atenção" no WhatsApp do lead após o site ficar pronto.
 */
export async function sendPingActiveMessage(
  lead: Record<string, unknown>,
  supabase = supabaseAdmin,
  opts?: { skipWhatsApp?: boolean }
): Promise<boolean> {
  const remoteJid =
    typeof lead.remoteJid === "string" && lead.remoteJid.includes("@")
      ? lead.remoteJid
      : typeof lead.telefone === "string" && lead.telefone.replace(/\D/g, "").length >= 10
      ? `${lead.telefone.replace(/\D/g, "")}@s.whatsapp.net`
      : null;
  const clientId = typeof lead.client_id === "string" ? lead.client_id : null;
  const leadId = lead.id;

  if (!remoteJid || !leadId || !supabase) return false;

  const instanceName = await resolveInstanceForLead(remoteJid, clientId, supabase);
  if (!instanceName) {
    console.warn(`[autonomous-worker] Nenhuma instância de WhatsApp encontrada para enviar Ping ao lead #${leadId}`);
    return false;
  }

  const nome = typeof lead.nome_negocio === "string" && lead.nome_negocio.trim()
    ? lead.nome_negocio.trim()
    : "empresa";

  // Busca opções do agente vinculado para saber se envia pergunta de disponibilidade (duplo vínculo) ou o link direto
  let confirmBeforeLink = true;
  let customPingTemplate: string | null = null;

  try {
    const { data: conn } = await supabase
      .from("channel_connections")
      .select("agent_id")
      .eq("instance_name", instanceName)
      .maybeSingle();

    if (conn?.agent_id) {
      const { data: ag } = await supabase
        .from("agent_settings")
        .select("options")
        .eq("id", conn.agent_id)
        .maybeSingle();

      if (ag?.options) {
        if (typeof ag.options.site_preview_confirm_before_link === "boolean") {
          confirmBeforeLink = ag.options.site_preview_confirm_before_link;
        }
        if (typeof ag.options.site_preview_ping_message === "string" && ag.options.site_preview_ping_message.trim()) {
          customPingTemplate = ag.options.site_preview_ping_message.trim();
        }
      }
    }
  } catch (optErr: any) {
    console.warn(`[autonomous-worker] Aviso ao buscar config do agente para envio de prévia #${leadId}:`, optErr?.message);
  }

  const link = String(lead.link_previa || "").trim();
  const pingText = confirmBeforeLink
    ? renderTemplate(customPingTemplate || DEFAULT_SITE_PREVIEW_PING_MESSAGE, { nome_negocio: nome })
    : `Oi! Tudo bem? Acabei de finalizar aqui no computador a prévia do site da ${nome} e já subi no ar para teste! Segue o link para dar uma olhadinha: ${link}. Me conta o que achou dessa estrutura inicial!`;

  const skipSend = opts?.skipWhatsApp || process.env.SKIP_PREVIEW_PING === "true";

  try {
    if (!skipSend) {
      const { sendMessage } = await import("@/lib/channel");
      await sendMessage(remoteJid, pingText, instanceName);
    } else {
      console.log(`[autonomous-worker] [TEST MODE] WhatsApp real pulado para ${remoteJid}`);
    }

    const nowIso = new Date().toISOString();
    const msgId = `ping-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

    await supabase.from("chats_dashboard").insert({
      message_id: msgId,
      remote_jid: remoteJid,
      sender_type: "assistant",
      content: pingText,
      status_envio: "sent",
      instance_name: instanceName,
      client_id: clientId,
      created_at: nowIso,
    });

    const leadUpdates: Record<string, any> = {
      previa_ping_enviado_em: nowIso,
    };
    if (!confirmBeforeLink && link) {
      leadUpdates.previa_link_enviado_em = nowIso;
    }

    await supabase
      .from("leads_extraidos")
      .update(leadUpdates)
      .eq("id", leadId);

    console.log(`[autonomous-worker] 🚀 #${leadId} Ping de atenção enviado ativamente via "${instanceName}" para ${remoteJid}`);
    await logAutonomousSiteEvent(
      lead,
      `[Site IA] 📱 Ping de atenção enviado via "${instanceName}" para ${remoteJid}: "Acabei de finalizar a prévia do site da ${nome}..."`,
      "success",
      { pingText, instanceName },
      supabase
    );
    return true;
  } catch (err: any) {
    console.error(`[autonomous-worker] Erro ao enviar Ping de atenção para lead #${leadId}:`, err?.message);
    return false;
  }
}

/**
 * Verifica a cadência anti-vácuo de 3 horas e 24 horas após o envio do link.
 */
export async function checkAndSendAutonomousFollowups(supabase = supabaseAdmin): Promise<void> {
  if (!supabase) return;

  const now = Date.now();
  const THREE_HOURS_MS = 3 * 60 * 60 * 1000;
  const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

  // Busca leads onde link da prévia foi enviado mas sem reunião agendada
  const { data: leads, error } = await supabase
    .from("leads_extraidos")
    .select("id, remoteJid, client_id, nome_negocio, link_previa, previa_link_enviado_em, previa_fup_3h_enviado_em, previa_fup_24h_enviado_em, reuniao_agendada_em")
    .eq("previa_status", "PREVIA_PRONTA")
    .not("previa_link_enviado_em", "is", null)
    .is("reuniao_agendada_em", null);

  if (error || !leads || leads.length === 0) return;

  for (const lead of leads) {
    const linkSentAt = lead.previa_link_enviado_em ? new Date(lead.previa_link_enviado_em).getTime() : 0;
    if (!linkSentAt || isNaN(linkSentAt)) continue;

    const elapsed = now - linkSentAt;

    // Checa se o cliente já respondeu após o envio do link
    const { data: clientReplies } = await supabase
      .from("chats_dashboard")
      .select("id")
      .eq("remote_jid", lead.remoteJid)
      .eq("client_id", lead.client_id)
      .gt("created_at", lead.previa_link_enviado_em)
      .or("sender_type.eq.customer,sender_type.eq.client,sender_type.eq.lead")
      .limit(1);

    if (clientReplies && clientReplies.length > 0) {
      // Cliente já respondeu, não precisa de follow-up anti-vácuo
      continue;
    }

    const instanceName = await resolveInstanceForLead(lead.remoteJid, lead.client_id, supabase);
    if (!instanceName) continue;

    const { sendMessage } = await import("@/lib/channel");

    // Follow-up de 24h
    if (elapsed >= TWENTY_FOUR_HOURS_MS && !lead.previa_fup_24h_enviado_em) {
      const fup24hText = "Oi! Passando só pra saber se você conseguiu abrir o modelo do site no celular. Preciso saber se curtiu a ideia pra decidir se mantenho esse link de teste ativo aqui pra vocês!";
      try {
        await sendMessage(lead.remoteJid, fup24hText, instanceName);
        const nowIso = new Date().toISOString();
        const msgId = `fup24h-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        await supabase.from("chats_dashboard").insert({
          message_id: msgId,
          remote_jid: lead.remoteJid,
          sender_type: "assistant",
          content: fup24hText,
          status_envio: "sent",
          instance_name: instanceName,
          client_id: lead.client_id,
          created_at: nowIso,
        });

        await supabase
          .from("leads_extraidos")
          .update({ previa_fup_24h_enviado_em: nowIso })
          .eq("id", lead.id);

        console.log(`[autonomous-worker] ⏰ #${lead.id} Follow-up 24h enviado via "${instanceName}" para ${lead.remoteJid}`);
        await logAutonomousSiteEvent(
          lead,
          `[Site IA] ⏰ Follow-up 24h enviado no WhatsApp via "${instanceName}": "Passando só pra saber se você conseguiu abrir o modelo..."`,
          "warning",
          { fup24hText, instanceName },
          supabase
        );
      } catch (err: any) {
        console.warn(`[autonomous-worker] Falha ao enviar follow-up 24h para #${lead.id}:`, err?.message);
      }
    }
    // Follow-up de 3h
    else if (elapsed >= THREE_HOURS_MS && !lead.previa_fup_3h_enviado_em) {
      const fup3hText = "E aí, conseguiu abrir o link aí no celular ou a correria hoje tá grande?";
      try {
        await sendMessage(lead.remoteJid, fup3hText, instanceName);
        const nowIso = new Date().toISOString();
        const msgId = `fup3h-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        await supabase.from("chats_dashboard").insert({
          message_id: msgId,
          remote_jid: lead.remoteJid,
          sender_type: "assistant",
          content: fup3hText,
          status_envio: "sent",
          instance_name: instanceName,
          client_id: lead.client_id,
          created_at: nowIso,
        });

        await supabase
          .from("leads_extraidos")
          .update({ previa_fup_3h_enviado_em: nowIso })
          .eq("id", lead.id);

        console.log(`[autonomous-worker] ⏰ #${lead.id} Follow-up 3h enviado via "${instanceName}" para ${lead.remoteJid}`);
        await logAutonomousSiteEvent(
          lead,
          `[Site IA] ⏰ Follow-up 3h enviado no WhatsApp via "${instanceName}": "E aí, conseguiu abrir o link aí no celular..."`,
          "info",
          { fup3hText, instanceName },
          supabase
        );
      } catch (err: any) {
        console.warn(`[autonomous-worker] Falha ao enviar follow-up 3h para #${lead.id}:`, err?.message);
      }
    }
  }
}

/**
 * Processa um único lead com status PREVIA_SOLICITADA.
 */
export async function processSingleLeadPreview(lead: Record<string, unknown>): Promise<boolean> {
  const leadId = lead.id;
  if (!leadId) return false;

  const nome = typeof lead.nome_negocio === "string" ? lead.nome_negocio : "Empresa";
  console.log(`[autonomous-worker] Iniciando geração autônoma para lead #${leadId} ("${nome}")`);
  await logAutonomousSiteEvent(lead, `[Site IA] 🚀 Iniciando pipeline autônomo para #${leadId} ("${nome}")`, "info");

  let workspaceDir: string | null = null;

  try {
    // 1. Atualiza status para GERANDO_WORKSPACE
    await supabaseAdmin
      .from("leads_extraidos")
      .update({
        previa_status: "GERANDO_WORKSPACE",
        previa_tentativas: Number(lead.previa_tentativas || 0) + 1,
      })
      .eq("id", leadId);

    await logAutonomousSiteEvent(lead, `[Site IA] 📁 Montando workspace temporário e baixando fotos do Google Maps...`, "info");

    // 2. Monta Workspace (download de fotos Maps + extração WhatsApp + TXT do briefing)
    const workspace = await provisionLeadWorkspace({ lead });
    workspaceDir = workspace.workspaceDir;
    console.log(`[autonomous-worker] #${leadId} Workspace montado: ${workspace.photosCount} fotos em ${workspace.workspaceDir}`);
    await logAutonomousSiteEvent(lead, `[Site IA] 🧠 Briefing pronto: ${workspace.photosCount} foto(s) baixadas + contexto do WhatsApp estruturado`, "info");

    // 3. Executa OpenCode CLI headless com a Skill Impeccable
    await supabaseAdmin
      .from("leads_extraidos")
      .update({ previa_status: "EXECUTANDO_OPENCODE" })
      .eq("id", leadId);

    console.log(`[autonomous-worker] #${leadId} Executando OpenCode CLI headless...`);
    await logAutonomousSiteEvent(lead, `[Site IA] 💻 Executando OpenCode CLI headless com Skill Impeccable + gate de layout (Desktop 1440x900 / Mobile 375x812)...`, "info");
    const generation = await generateSiteWithAutoCorrection({
      workspaceDir: workspace.workspaceDir,
      leadName: nome,
      niche: typeof lead.ramo_negocio === "string" ? lead.ramo_negocio : "Serviços Locais",
      timeoutMs: 1_500_000,
      onLog: (line) => {
        const trimmed = line.trim();
        if (
          trimmed.startsWith("[OpenCode]") ||
          trimmed.startsWith("[Impeccable Detector]") ||
          trimmed.startsWith("[CSS Validator]") ||
          trimmed.startsWith("[Quality Gate]") ||
          trimmed.includes("anti-pattern") ||
          trimmed.includes("clean") ||
          trimmed.includes("error") ||
          trimmed.includes("Error") ||
          trimmed.includes("done") ||
          trimmed.includes("create") ||
          trimmed.includes("write")
        ) {
          console.log(`[opencode-log] #${leadId}:`, trimmed.slice(0, 200));
        }
      },
    });
    const runResult = generation.run;

    if (!runResult.success) {
      throw new Error(`OpenCode falhou: ${runResult.error || "index.html não gerado"}`);
    }

    console.log(`[autonomous-worker] #${leadId} OpenCode concluiu (${generation.attempts} execução(ões), ${runResult.generatedFiles.join(", ")}) em ${Math.round(runResult.durationMs / 1000)}s`);
    await logAutonomousSiteEvent(lead, `[Site IA] 🎨 Código gerado em ${generation.attempts} execução(ões) (${runResult.generatedFiles.join(", ") || "index.html"})`, "success");

    if (!generation.success) {
      const summary = generation.violations.slice(0, 8).map((v) => `[${v.code}] ${v.message}`).join(" | ");
      console.warn(`[autonomous-worker] #${leadId} ❌ Gate de qualidade reprovou o site (deploy bloqueado): ${summary}`);
      await logAutonomousSiteEvent(lead, `[Site IA] ❌ Gate de CSS/layout reprovou após ${generation.attempts} tentativa(s). Deploy bloqueado: ${summary}`, "error");
      throw new Error(`Gate de qualidade reprovou o site: ${generation.violations.map((v) => v.code).join(", ")}`);
    }

    console.log(`[autonomous-worker] #${leadId} ✅ Gate pré-deploy aprovado: CSS válido + geometria Desktop/Mobile + movimento`);
    await logAutonomousSiteEvent(lead, `[Site IA] ✅ Gate pré-deploy aprovado (CSS válido, geometria Desktop/Mobile e animações presentes)`, "success");

    if (generation.detector) {
      if (generation.detector.clean) {
        console.log(`[autonomous-worker] #${leadId} 🛡️ Impeccable Detector: 100% LIMPO (Zero anti-patterns detectados)`);
        await logAutonomousSiteEvent(lead, `[Site IA] 🛡️ Detector Oficial Impeccable: 100% LIMPO (Zero anti-patterns detectados)`, "success");
      } else {
        console.log(`[autonomous-worker] #${leadId} ⚠️ Impeccable Detector: ${generation.detector.issuesCount} anti-patterns (${generation.detector.issues.join(", ")})`);
        await logAutonomousSiteEvent(lead, `[Site IA] ⚠️ Detector Oficial Impeccable: ${generation.detector.issuesCount} anti-patterns (${generation.detector.issues.join(", ")})`, "warning");
      }
    }

    // Preserva cópia local dos artefatos gerados para auditoria
    try {
      const backupDir = path.resolve(process.cwd(), "storage", "previews", String(leadId));
      await fs.mkdir(backupDir, { recursive: true });
      await fs.cp(workspace.workspaceDir, backupDir, { recursive: true });
    } catch {}

    // 4. Deploy na Vercel API
    await supabaseAdmin
      .from("leads_extraidos")
      .update({ previa_status: "FAZENDO_DEPLOY" })
      .eq("id", leadId);

    console.log(`[autonomous-worker] #${leadId} Realizando deploy na Vercel...`);
    await logAutonomousSiteEvent(lead, `[Site IA] ☁️ Publicando site na Vercel...`, "info");
    const deployResult = await deployToVercel({
      workspaceDir: workspace.workspaceDir,
      projectName: typeof lead.nome_negocio === "string" ? lead.nome_negocio : `preview-${leadId}`,
    });

    if (!deployResult.success || !deployResult.url) {
      throw new Error(`Deploy Vercel falhou: ${deployResult.error || "URL não retornada"}`);
    }

    console.log(`[autonomous-worker] #${leadId} Publicado com sucesso na Vercel: ${deployResult.url}`);
    await logAutonomousSiteEvent(lead, `[Site IA] 🌐 Site no ar na Vercel: ${deployResult.url}`, "success", { url: deployResult.url });

    // 5. Auditoria Tripla de Qualidade pós-deploy
    await supabaseAdmin
      .from("leads_extraidos")
      .update({
        previa_status: "INSPECIONANDO_QA",
        link_previa: deployResult.url,
      })
      .eq("id", leadId);

    console.log(`[autonomous-worker] #${leadId} Executando Auditoria Tripla de Qualidade (HTTP + Puppeteer + Vision)...`);
    await logAutonomousSiteEvent(lead, `[Site IA] 🔍 Auditoria Tripla de Qualidade (HTTP + DOM + Puppeteer)...`, "info");
    const qaReport = await inspectAutonomousSitePreview({
      url: deployResult.url,
      leadName: nome,
      niche: typeof lead.ramo_negocio === "string" ? lead.ramo_negocio : "Serviços Locais",
    });

    console.log(`[autonomous-worker] #${leadId} QA Concluído. Score: ${qaReport.score}/100 | Passou: ${qaReport.passed} | Imagens quebradas: ${qaReport.dom.brokenImages.length}`);

    // 6. Conclusão do Pipeline
    if (qaReport.passed) {
      await supabaseAdmin
        .from("leads_extraidos")
        .update({
          previa_status: "PREVIA_PRONTA",
          link_previa: deployResult.url,
          previa_pronta_em: new Date().toISOString(),
          previa_qa_score: qaReport.score,
          previa_qa_report: qaReport,
          previa_error: null,
        })
        .eq("id", leadId);

      if (lead.client_id && lead.remoteJid) {
        try {
          const { promoteLeadBySystemSignal } = await import("@/lib/organizer-realtime");
          await promoteLeadBySystemSignal({
            clientId: String(lead.client_id),
            remoteJid: String(lead.remoteJid),
            signal: "site_preview_sent",
            reason: `Prévia do site aprovada no QA (${qaReport.score}/100) e publicada: ${deployResult.url}`,
            summary: `Prévia publicada no ar (${deployResult.url}) e ping de atenção disparado no WhatsApp.`,
          });
        } catch {}
      }

      console.log(`[autonomous-worker] 🎉 #${leadId} Prévia APROVADA e pronta para o Sarah Closer! Link: ${deployResult.url}`);
      await logAutonomousSiteEvent(
        lead,
        `[Site IA] ✅ Prévia APROVADA no QA (Score: ${qaReport.score}/100)! Link no ar: ${deployResult.url}`,
        "success",
        { score: qaReport.score, url: deployResult.url }
      );

      // Disparo ativo do Ping de Atenção no WhatsApp
      await sendPingActiveMessage(lead, supabaseAdmin);

      return true;
    } else {
      const issues = [
        !qaReport.http.ok ? "HTTP não retornou 200" : null,
        !qaReport.css.valid ? `CSS inválido (${qaReport.css.errors.join("; ")})` : null,
        qaReport.dom.brokenImages.length > 0 ? `${qaReport.dom.brokenImages.length} imagens quebradas` : null,
        qaReport.dom.hasHorizontalOverflow ? "Overflow horizontal no mobile" : null,
        qaReport.geometry.desktop.violations.length > 0
          ? `Desktop: ${qaReport.geometry.desktop.violations.map((v) => v.code).join(", ")}`
          : null,
        qaReport.geometry.mobile.violations.length > 0
          ? `Mobile: ${qaReport.geometry.mobile.violations.map((v) => v.code).join(", ")}`
          : null,
        qaReport.score < 75 ? `Score de qualidade insuficiente (${qaReport.score}/100)` : null,
      ].filter(Boolean).join("; ");

      await supabaseAdmin
        .from("leads_extraidos")
        .update({
          previa_status: "PREVIA_FALHOU",
          previa_qa_score: qaReport.score,
          previa_qa_report: qaReport,
          previa_error: `Reprovado no QA: ${issues}`,
        })
        .eq("id", leadId);

      console.warn(`[autonomous-worker] ❌ #${leadId} Prévia reprovada no QA: ${issues}`);
      await logAutonomousSiteEvent(lead, `[Site IA] ❌ Prévia reprovada no QA: ${issues}`, "error", { score: qaReport.score });
      return false;
    }
  } catch (err: any) {
    console.error(`[autonomous-worker] Erro no processamento do lead #${leadId}:`, err?.message);
    await logAutonomousSiteEvent(lead, `[Site IA] ❌ Erro: ${err?.message || "Erro desconhecido"}`, "error");
    try {
      await supabaseAdmin
        .from("leads_extraidos")
        .update({
          previa_status: "PREVIA_FALHOU",
          previa_error: err?.message || "Erro desconhecido",
        })
        .eq("id", leadId);
    } catch {
      // ignora
    }
    return false;
  } finally {
    // Limpeza de disco do workspace temporário
    if (workspaceDir) {
      try {
        await fs.rm(workspaceDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        console.log(`[autonomous-worker] 🧹 #${leadId} Limpeza de disco concluída: ${workspaceDir}`);
      } catch (cleanErr: any) {
        console.warn(`[autonomous-worker] Aviso ao limpar workspace #${leadId}:`, cleanErr?.message);
      }
    }
  }
}

/**
 * Loop contínuo do worker consumindo a fila de prévias solicitadas e follow-ups.
 */
export async function startAutonomousSiteWorker(signal?: AbortSignal, pollIntervalMs = 5000): Promise<void> {
  console.log("[autonomous-worker] Worker autônomo iniciado na VPS.");

  let lastFollowupCheck = 0;

  while (!signal?.aborted) {
    try {
      // 1. Processa fila de geração de novas prévias
      const { data: leads, error } = await supabaseAdmin
        .from("leads_extraidos")
        .select("*")
        .eq("previa_status", "PREVIA_SOLICITADA")
        .lt("previa_tentativas", 3)
        .order("previa_solicitada_em", { ascending: true })
        .limit(1);

      if (error) {
        console.warn("[autonomous-worker] Erro ao consultar fila:", error.message);
      } else if (leads && leads.length > 0) {
        const lead = leads[0];
        await processSingleLeadPreview(lead);
      }

      // 2. Verifica cadência de follow-ups anti-vácuo (a cada 60s)
      const now = Date.now();
      if (now - lastFollowupCheck >= 60_000) {
        lastFollowupCheck = now;
        await checkAndSendAutonomousFollowups(supabaseAdmin);
      }
    } catch (loopErr: any) {
      console.warn("[autonomous-worker] Exceção no ciclo do worker:", loopErr?.message);
    }

    // Espera antes do próximo poll
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, pollIntervalMs);
      signal?.addEventListener("abort", () => clearTimeout(timer), { once: true });
    });
  }

  console.log("[autonomous-worker] Worker autônomo finalizado.");
}
