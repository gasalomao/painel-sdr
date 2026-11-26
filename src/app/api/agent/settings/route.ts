import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase_admin";
import { requireClientId } from "@/lib/tenant";
import { assertTenantCanCreateAgent, assertTenantCanCreateInstance, getTenantSaasLimits } from "@/lib/saas-limits";
import { invalidateAgentConfigCache } from "@/lib/agent-config-cache";

export const dynamic = "force-dynamic";

export const SECRET_OPTION_KEYS = [
  "google_tokens",
  "google_credentials",
  "gemini_api_key",
  "openrouter_api_key",
  "nvidia_api_key",
] as const;

type JsonObject = Record<string, unknown>;

export function sanitizeAgentOptions(
  rawOpts: JsonObject | null | undefined,
): JsonObject {
  const src: JsonObject = rawOpts && typeof rawOpts === "object" ? rawOpts : {};
  const clean: JsonObject = {};
  for (const [k, v] of Object.entries(src)) {
    if ((SECRET_OPTION_KEYS as readonly string[]).includes(k)) continue;
    clean[k] = v;
  }
  const googleTokens = src.google_tokens as { refresh_token?: string } | undefined;
  const googleCreds = typeof src.google_credentials === "string" ? src.google_credentials.trim() : "";
  clean.google_connected = Boolean(googleTokens?.refresh_token);
  clean.has_custom_google_credentials = googleCreds.length > 0;
  clean.calendar_connected_email = src.calendar_connected_email ?? null;
  return clean;
}

export function sanitizeAgentRow(
  row: JsonObject | null | undefined,
): JsonObject | null {
  if (!row) return null;
  return {
    ...row,
    options: sanitizeAgentOptions(row.options as JsonObject | undefined),
  };
}

function parsePositiveAgentId(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function preserveSecretOptions(existingOpts: JsonObject, nextOpts: JsonObject): JsonObject {
  const merged = { ...nextOpts };
  for (const key of SECRET_OPTION_KEYS) {
    if (existingOpts[key] !== undefined) {
      merged[key] = existingOpts[key];
    } else {
      delete merged[key];
    }
  }
  return merged;
}

async function loadAgentBundleForClient(agentId: number, clientId: string) {
  if (!supabaseAdmin) return null;
  const [settingsRes, kbRes, connRes, stagesRes] = await Promise.all([
    supabaseAdmin
      .from("agent_settings")
      .select("*")
      .eq("id", agentId)
      .eq("client_id", clientId)
      .maybeSingle(),
    supabaseAdmin
      .from("agent_knowledge")
      .select("*")
      .eq("agent_id", agentId)
      .or(`client_id.eq.${clientId},client_id.is.null`)
      .order("created_at"),
    supabaseAdmin
      .from("channel_connections")
      .select("instance_name, created_at")
      .eq("agent_id", agentId)
      .eq("client_id", clientId)
      .order("created_at", { ascending: true })
      .limit(1),
    supabaseAdmin
      .from("agent_stages")
      .select("*")
      .eq("agent_id", agentId)
      .eq("client_id", clientId)
      .order("order_index"),
  ]);

  if (settingsRes.error) {
    throw new Error(settingsRes.error.message);
  }
  if (!settingsRes.data) {
    return null;
  }

  return {
    agent: sanitizeAgentRow(settingsRes.data as JsonObject),
    knowledge: (kbRes.data || []) as JsonObject[],
    stages: (stagesRes.data || []) as JsonObject[],
    vinculoInstance:
      ((connRes.data?.[0] as { instance_name?: string } | undefined)?.instance_name) || "",
  };
}

/**
 * GET /api/agent/settings
 * Retorna config sanitizada (sem google_tokens / google_credentials / API keys)
 * para um agente (`?agent_id=X`) e/ou bootstrap da página `/agente` (`?include_boot=1`).
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Banco de dados indisponível" }, { status: 500 });
  }

  const sp = req.nextUrl.searchParams;
  const requestedAgentId = parsePositiveAgentId(sp.get("agent_id"));
  const includeBoot = sp.get("include_boot") === "1" || sp.get("include_boot") === "true";
  const previewLeads = sp.get("preview_leads") === "1" || sp.get("preview_leads") === "true";
  const logsOnly = sp.get("logs_only") === "1" || sp.get("logs_only") === "true";

  try {
    if (logsOnly) {
      const { data: logs, error: logsErr } = await supabaseAdmin
        .from("webhook_logs")
        .select("*")
        .eq("client_id", auth.clientId)
        .order("created_at", { ascending: false })
        .limit(20);
      if (logsErr) {
        return NextResponse.json({ error: logsErr.message }, { status: 500 });
      }
      return NextResponse.json({ success: true, webhookLogs: logs || [] });
    }
    if (previewLeads) {
      const { data: leads, error: leadsErr } = await supabaseAdmin
        .from("leads_extraidos")
        .select("*")
        .eq("client_id", auth.clientId)
        .order("created_at", { ascending: false })
        .limit(500);
      if (leadsErr) {
        return NextResponse.json({ error: leadsErr.message }, { status: 500 });
      }
      return NextResponse.json({ success: true, leads: leads || [] });
    }

    if (!includeBoot) {
      if (!requestedAgentId) {
        const { data: agents, error } = await supabaseAdmin
          .from("agent_settings")
          .select("id, name")
          .eq("client_id", auth.clientId)
          .order("id");
        if (error) {
          return NextResponse.json({ error: error.message }, { status: 500 });
        }
        return NextResponse.json({ success: true, agents: agents || [] });
      }

      const bundle = await loadAgentBundleForClient(requestedAgentId, auth.clientId);
      if (!bundle) {
        return NextResponse.json({ error: "Agente não encontrado" }, { status: 404 });
      }
      return NextResponse.json({ success: true, ...bundle });
    }

    const [agentsRes, instancesRes, appUrlRes, logsRes] = await Promise.all([
      supabaseAdmin
        .from("agent_settings")
        .select("id, name")
        .eq("client_id", auth.clientId)
        .order("id"),
      supabaseAdmin
        .from("channel_connections")
        .select("instance_name")
        .eq("client_id", auth.clientId),
      supabaseAdmin
        .from("ai_organizer_config")
        .select("app_url")
        .eq("id", 1)
        .maybeSingle(),
      supabaseAdmin
        .from("webhook_logs")
        .select("*")
        .eq("client_id", auth.clientId)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

    if (agentsRes.error) {
      return NextResponse.json({ error: agentsRes.error.message }, { status: 500 });
    }

    const agents = (agentsRes.data || []) as Array<{ id: number; name?: string | null }>;
    const instances = Array.from(
      new Set(
        ((instancesRes.data || []) as Array<{ instance_name?: string | null }>)
          .map((i) => i.instance_name)
          .filter((name): name is string => Boolean(name)),
      ),
    );
    const appUrl = (appUrlRes.data as { app_url?: string | null } | null)?.app_url || "";
    const webhookLogs = (logsRes.data || []) as JsonObject[];

    let selectedId: number | null = null;
    if (requestedAgentId && agents.some((a) => a.id === requestedAgentId)) {
      selectedId = requestedAgentId;
    } else if (agents.length > 0) {
      selectedId = agents[0].id;
    }

    const bundle = selectedId ? await loadAgentBundleForClient(selectedId, auth.clientId) : null;

    return NextResponse.json({
      success: true,
      agents,
      selectedAgentId: selectedId,
      instances,
      appUrl,
      webhookLogs,
      agent: bundle?.agent ?? null,
      knowledge: bundle?.knowledge ?? [],
      stages: bundle?.stages ?? [],
      vinculoInstance: bundle?.vinculoInstance ?? "",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro ao carregar agente";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * PATCH /api/agent/settings
 * Atualiza seções permitidas do agente com escopo multi-tenant, preservação
 * de segredos e bloqueio server-side de troca de modelo para não-admins.
 */
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Banco de dados indisponível" }, { status: 500 });
  }

  try {
    const body = (await req.json().catch(() => null)) as JsonObject | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Payload inválido" }, { status: 400 });
    }

    const agentId = parsePositiveAgentId(body.agent_id);
    if (!agentId) {
      return NextResponse.json({ error: "agent_id inválido" }, { status: 400 });
    }

    const section = String(body.section || "");
    const { data: existing, error: findErr } = await supabaseAdmin
      .from("agent_settings")
      .select("id, client_id, target_model, options, scheduler_config")
      .eq("id", agentId)
      .eq("client_id", auth.clientId)
      .maybeSingle();

    if (findErr) {
      return NextResponse.json({ error: findErr.message }, { status: 500 });
    }
    if (!existing) {
      return NextResponse.json({ error: "Agente não encontrado" }, { status: 404 });
    }

    const existingOpts = ((existing.options as JsonObject | null) || {}) as JsonObject;
    const existingSched = ((existing.scheduler_config as JsonObject | null) || {}) as JsonObject;
    let updatePayload: JsonObject;

    if (section === "identity") {
      const limits = await getTenantSaasLimits(auth.clientId, auth.isAdmin);
      const incomingOpts = ((body.options as JsonObject | undefined) || {}) as JsonObject;
      const mergedOpts: JsonObject = preserveSecretOptions(existingOpts, {
        ...existingOpts,
        app_url: incomingOpts.app_url ?? existingOpts.app_url ?? "",
        message_buffer_seconds: Number(incomingOpts.message_buffer_seconds) || 0,
        humanize_messages: Boolean(incomingOpts.humanize_messages),
        split_intensity: incomingOpts.split_intensity ?? existingOpts.split_intensity,
        typing_delay_mode: incomingOpts.typing_delay_mode === "fixed" ? "fixed" : "random",
        typing_delay_seconds: Number(incomingOpts.typing_delay_seconds) || 10,
        typing_delay_min_seconds: Number(incomingOpts.typing_delay_min_seconds) || 5,
        typing_delay_max_seconds: Number(incomingOpts.typing_delay_max_seconds) || 25,
        custom_goal_enabled: Boolean(incomingOpts.custom_goal_enabled),
        custom_goal_text: typeof incomingOpts.custom_goal_text === "string" ? incomingOpts.custom_goal_text : "",
        custom_goal_pause_mode:
          incomingOpts.custom_goal_pause_mode === "indefinite" ? "indefinite" : "timed",
        custom_goal_pause_minutes: Math.max(1, Number(incomingOpts.custom_goal_pause_minutes) || 30),
        web_search_enabled: auth.isAdmin
          ? Boolean(incomingOpts.web_search_enabled)
          : Boolean(existingOpts.web_search_enabled),
        reasoning_mode: auth.isAdmin
          ? (incomingOpts.reasoning_mode === 0 ||
            incomingOpts.reasoning_mode === 1 ||
            incomingOpts.reasoning_mode === 2 ||
            incomingOpts.reasoning_mode === 3
            ? incomingOpts.reasoning_mode
            : 0)
          : (existingOpts.reasoning_mode === 0 || existingOpts.reasoning_mode === 1
            ? existingOpts.reasoning_mode
            : 0),
        thinking_budget: auth.isAdmin
          ? (incomingOpts.thinking_budget === 0 ||
            incomingOpts.thinking_budget === 1 ||
            incomingOpts.thinking_budget === 2 ||
            incomingOpts.thinking_budget === 3
            ? incomingOpts.thinking_budget
            : 0)
          : (typeof existingOpts.thinking_budget === "number" ? Math.min(1, existingOpts.thinking_budget) : 0),
        custom_tools: auth.isAdmin
          ? (Array.isArray(incomingOpts.custom_tools)
            ? incomingOpts.custom_tools.filter((t): t is { name: string; description: string; webhook_url: string } => {
              if (!t || typeof t !== "object") return false;
              const obj = t as Record<string, unknown>;
              return typeof obj.name === "string" && obj.name.trim().length > 0 && typeof obj.webhook_url === "string" && obj.webhook_url.trim().length > 0;
            })
            : [])
          : (Array.isArray(existingOpts.custom_tools) ? existingOpts.custom_tools : []),
        site_preview_auto_detect: auth.isAdmin
          ? Boolean(incomingOpts.site_preview_auto_detect)
          : Boolean(existingOpts.site_preview_auto_detect),
        sdr_enrichment_dossier_enabled: auth.isAdmin
          ? (incomingOpts.sdr_enrichment_dossier_enabled !== undefined
            ? Boolean(incomingOpts.sdr_enrichment_dossier_enabled)
            : Boolean(existingOpts.sdr_enrichment_dossier_enabled))
          : Boolean(existingOpts.sdr_enrichment_dossier_enabled),
        sdr_enrichment_dossier_mode: auth.isAdmin
          ? (incomingOpts.sdr_enrichment_dossier_mode === "strategic" ||
            incomingOpts.sdr_enrichment_dossier_mode === "full" ||
            incomingOpts.sdr_enrichment_dossier_mode === "off"
            ? incomingOpts.sdr_enrichment_dossier_mode
            : existingOpts.sdr_enrichment_dossier_mode === "strategic" ||
              existingOpts.sdr_enrichment_dossier_mode === "full" ||
              existingOpts.sdr_enrichment_dossier_mode === "off"
              ? existingOpts.sdr_enrichment_dossier_mode
              : undefined)
          : existingOpts.sdr_enrichment_dossier_mode,
        site_preview_confirm_before_link: auth.isAdmin
          ? (incomingOpts.site_preview_confirm_before_link !== undefined
            ? Boolean(incomingOpts.site_preview_confirm_before_link)
            : true)
          : (existingOpts.site_preview_confirm_before_link ?? true),
        site_preview_eval_prompt: auth.isAdmin
          ? (typeof incomingOpts.site_preview_eval_prompt === "string"
            ? incomingOpts.site_preview_eval_prompt
            : existingOpts.site_preview_eval_prompt)
          : existingOpts.site_preview_eval_prompt,
        site_preview_ping_message: auth.isAdmin
          ? (typeof incomingOpts.site_preview_ping_message === "string"
            ? incomingOpts.site_preview_ping_message
            : existingOpts.site_preview_ping_message)
          : existingOpts.site_preview_ping_message,
        site_preview_eval_model: auth.isAdmin
          ? (typeof incomingOpts.site_preview_eval_model === "string"
            ? incomingOpts.site_preview_eval_model
            : existingOpts.site_preview_eval_model)
          : existingOpts.site_preview_eval_model,
        // Segurança: apenas admin pode configurar modelo reserva (mesmo controle de custo de target_model).
        fallback_model: auth.isAdmin
          ? (typeof incomingOpts.fallback_model === "string"
            ? incomingOpts.fallback_model.trim()
            : existingOpts.fallback_model || "")
          : existingOpts.fallback_model || "",
      });

      const rawMaxOut = incomingOpts.max_output_tokens;
      if (auth.isAdmin) {
        if (rawMaxOut !== undefined && rawMaxOut !== null && rawMaxOut !== "" && Number(rawMaxOut) > 0) {
          mergedOpts.max_output_tokens = Math.min(8192, Math.max(50, Math.floor(Number(rawMaxOut))));
        } else {
          delete mergedOpts.max_output_tokens;
        }
      } else {
        const cap = limits.max_output_tokens ?? 1024;
        if (rawMaxOut !== undefined && rawMaxOut !== null && rawMaxOut !== "" && Number(rawMaxOut) > 0) {
          mergedOpts.max_output_tokens = Math.min(cap, Math.max(50, Math.floor(Number(rawMaxOut))));
        } else if (typeof existingOpts.max_output_tokens === "number" && existingOpts.max_output_tokens > 0) {
          mergedOpts.max_output_tokens = Math.min(cap, existingOpts.max_output_tokens);
        } else {
          mergedOpts.max_output_tokens = cap;
        }
      }

      const rawTemp = incomingOpts.temperature;
      if (rawTemp !== undefined && rawTemp !== null && rawTemp !== "" && Number.isFinite(Number(rawTemp))) {
        mergedOpts.temperature = Math.min(2, Math.max(0, Number(rawTemp)));
      } else {
        delete mergedOpts.temperature;
      }

      updatePayload = {
        name: String(body.name ?? ""),
        role: String(body.role ?? ""),
        personality: String(body.personality ?? ""),
        tone: String(body.tone ?? ""),
        // Segurança: somente admin (não impersonando) pode alterar modelo do agente.
        target_model: auth.isAdmin
          ? (typeof body.target_model === "string" ? body.target_model : existing.target_model)
          : existing.target_model,
        options: mergedOpts,
        lead_intelligence_enabled: Boolean(body.lead_intelligence_enabled),
      };
    } else if (section === "prompt") {
      const promptText = String(body.main_prompt ?? "");
      if (!auth.isAdmin) {
        const limits = await getTenantSaasLimits(auth.clientId, false);
        if (promptText.length > limits.max_prompt_chars) {
          return NextResponse.json(
            {
              error: `O prompt excede o limite do seu plano (${promptText.length}/${limits.max_prompt_chars} caracteres).`,
            },
            { status: 400 }
          );
        }
      }
      updatePayload = {
        main_prompt: promptText,
      };
    } else if (section === "schedules") {
      updatePayload = {
        schedules: Array.isArray(body.schedules) ? body.schedules : [],
        is_24h: Boolean(body.is_24h),
        away_message: String(body.away_message ?? ""),
        disable_groups: Boolean(body.disable_groups),
        transcription_method: String(body.transcription_method || "auto"),
      };
    } else if (section === "calendar") {
      const incomingOpts = ((body.options as JsonObject | undefined) || {}) as JsonObject;
      const incomingSched = ((body.scheduler_config as JsonObject | undefined) || {}) as JsonObject;
      const rawGoogleCreds =
        typeof incomingOpts.google_credentials === "string" ? incomingOpts.google_credentials.trim() : "";

      const mergedOpts: JsonObject = preserveSecretOptions(existingOpts, {
        ...existingOpts,
        calendar_enabled: Boolean(incomingOpts.calendar_enabled),
        calendar_generate_meet: Boolean(incomingOpts.calendar_generate_meet),
        calendar_send_meet_link: Boolean(incomingOpts.calendar_send_meet_link),
        calendar_default_duration: Number(incomingOpts.calendar_default_duration) || 30,
        calendar_optional_fields:
          incomingOpts.calendar_optional_fields && typeof incomingOpts.calendar_optional_fields === "object"
            ? incomingOpts.calendar_optional_fields
            : {},
        calendar_auto_capture:
          incomingOpts.calendar_auto_capture && typeof incomingOpts.calendar_auto_capture === "object"
            ? incomingOpts.calendar_auto_capture
            : {},
      });

      if (body.clear_google_credentials === true) {
        delete mergedOpts.google_credentials;
      } else if (rawGoogleCreds.length > 0) {
        mergedOpts.google_credentials = incomingOpts.google_credentials;
      }

      const defaultDuration = Number(incomingOpts.calendar_default_duration) || 30;
      const nextSched: JsonObject = {
        ...existingSched,
        calendar_id: (existingSched.calendar_id as string | undefined) || "primary",
        default_duration_minutes: defaultDuration,
        reminders: Array.isArray(incomingSched.reminders) ? incomingSched.reminders : existingSched.reminders,
        auto_promote_kanban_after_minutes:
          typeof incomingSched.auto_promote_kanban_after_minutes === "number"
            ? incomingSched.auto_promote_kanban_after_minutes
            : existingSched.auto_promote_kanban_after_minutes,
        notify_owner: Boolean(incomingSched.notify_owner),
        owner_phone:
          typeof incomingSched.owner_phone === "string" && incomingSched.owner_phone.trim()
            ? incomingSched.owner_phone.trim()
            : null,
        owner_summary_enabled: Boolean(incomingSched.owner_summary_enabled),
        owner_summary_prompt:
          typeof incomingSched.owner_summary_prompt === "string" ? incomingSched.owner_summary_prompt : "",
        // Segurança: apenas admin real altera o modelo de resumo do dono.
        owner_summary_model: auth.isAdmin
          ? (typeof incomingSched.owner_summary_model === "string" && incomingSched.owner_summary_model.trim()
            ? incomingSched.owner_summary_model.trim()
            : null)
          : (existingSched.owner_summary_model ?? null),
        auto_promote_from_status:
          typeof incomingSched.auto_promote_from_status === "string" ? incomingSched.auto_promote_from_status : "",
        auto_promote_to_status:
          typeof incomingSched.auto_promote_to_status === "string" ? incomingSched.auto_promote_to_status : "",
        auto_promote_disabled: Boolean(incomingSched.auto_promote_disabled),
        pause_after_schedule_minutes: Number(incomingSched.pause_after_schedule_minutes) || 0,
      };

      updatePayload = {
        options: mergedOpts,
        is_scheduler: Boolean(body.is_scheduler),
        scheduler_config: nextSched,
      };
    } else if (section === "toggle_active") {
      updatePayload = {
        is_active: Boolean(body.is_active),
      };
    } else if (section === "follow_up") {
      const incomingFollowUp =
        body.follow_up && typeof body.follow_up === "object"
          ? (body.follow_up as JsonObject)
          : {};
      const mergedOpts: JsonObject = preserveSecretOptions(existingOpts, {
        ...existingOpts,
        follow_up: incomingFollowUp,
      });
      updatePayload = {
        options: mergedOpts,
      };
    } else {
      return NextResponse.json({ error: "Seção de atualização desconhecida" }, { status: 400 });
    }

    const { data: updated, error: updateErr } = await supabaseAdmin
      .from("agent_settings")
      .update(updatePayload)
      .eq("id", agentId)
      .eq("client_id", auth.clientId)
      .select("*")
      .single();

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 });
    }

    invalidateAgentConfigCache(agentId);
    return NextResponse.json({
      success: true,
      agent: sanitizeAgentRow(updated as JsonObject),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro ao salvar configurações";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * POST /api/agent/settings
 * Ações estruturais escopadas no tenant: criar agente, vincular instância e CRUD de etapas.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Banco de dados indisponível" }, { status: 500 });
  }

  try {
    const body = (await req.json().catch(() => null)) as JsonObject | null;
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Payload inválido" }, { status: 400 });
    }

    const action = String(body.action || "");

    if (action === "create_agent") {
      const agentDenied = await assertTenantCanCreateAgent(auth.clientId, auth.isAdmin);
      if (agentDenied) return agentDenied;
      const name = String(body.name || "").trim();
      if (!name) {
        return NextResponse.json({ error: "Nome do agente é obrigatório" }, { status: 400 });
      }
      const insertPayload: JsonObject = {
        name,
        role: String(body.role || "Assistente Virtual"),
        personality: String(body.personality || "Educado e direto"),
        tone: String(body.tone || "Profissional"),
        main_prompt: String(
          body.main_prompt || "Seja muito prestativo e use a base de conhecimento para responder dúvidas.",
        ),
        is_active: body.is_active !== undefined ? Boolean(body.is_active) : true,
        is_24h: body.is_24h !== undefined ? Boolean(body.is_24h) : false,
        disable_groups: body.disable_groups !== undefined ? Boolean(body.disable_groups) : true,
        transcription_method: String(body.transcription_method || "auto"),
        client_id: auth.clientId,
        schedules: Array.isArray(body.schedules) ? body.schedules : [],
      };
      if (auth.isAdmin && typeof body.target_model === "string" && body.target_model.trim()) {
        insertPayload.target_model = body.target_model.trim();
      }

      const { data: created, error } = await supabaseAdmin
        .from("agent_settings")
        .insert(insertPayload)
        .select("*")
        .single();
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      invalidateAgentConfigCache((created as { id?: number }).id);
      return NextResponse.json({
        success: true,
        agent: sanitizeAgentRow(created as JsonObject),
      });
    }

    if (action === "bind_instance") {
      const agentId = parsePositiveAgentId(body.agent_id);
      const instanceName = String(body.instance_name || "").trim();
      const force = Boolean(body.force);
      if (!agentId || !instanceName) {
        return NextResponse.json({ error: "agent_id e instance_name são obrigatórios" }, { status: 400 });
      }

      const { data: agentOwned } = await supabaseAdmin
        .from("agent_settings")
        .select("id")
        .eq("id", agentId)
        .eq("client_id", auth.clientId)
        .maybeSingle();
      if (!agentOwned) {
        return NextResponse.json({ error: "Agente não encontrado" }, { status: 404 });
      }

      const { data: existingConn } = await supabaseAdmin
        .from("channel_connections")
        .select("agent_id, instance_name, client_id")
        .eq("instance_name", instanceName)
        .maybeSingle();

      if (existingConn && existingConn.client_id && existingConn.client_id !== auth.clientId) {
        return NextResponse.json(
          { error: "Esta instância pertence a outro cliente." },
          { status: 403 },
        );
      }

      if (!force && existingConn?.agent_id && existingConn.agent_id !== agentId) {
        return NextResponse.json(
          {
            success: false,
            conflict: true,
            existing_agent_id: existingConn.agent_id,
          },
          { status: 409 },
        );
      }

      if (!existingConn) {
        const instDenied = await assertTenantCanCreateInstance(auth.clientId, auth.isAdmin);
        if (instDenied) return instDenied;
      }

      const { error: upsertErr } = await supabaseAdmin
        .from("channel_connections")
        .upsert(
          {
            instance_name: instanceName,
            agent_id: agentId,
            client_id: auth.clientId,
            status: "open",
          },
          { onConflict: "instance_name" },
        );
      if (upsertErr) {
        return NextResponse.json({ error: upsertErr.message }, { status: 500 });
      }

      await supabaseAdmin
        .from("channel_connections")
        .delete()
        .eq("agent_id", agentId)
        .eq("client_id", auth.clientId)
        .neq("instance_name", instanceName);

      invalidateAgentConfigCache(agentId);
      if (existingConn?.agent_id && existingConn.agent_id !== agentId) {
        invalidateAgentConfigCache(Number(existingConn.agent_id));
      }

      return NextResponse.json({ success: true, instance_name: instanceName });
    }

    if (action === "create_stage") {
      const agentId = parsePositiveAgentId(body.agent_id);
      const title = String(body.title || "").trim();
      if (!agentId || !title) {
        return NextResponse.json({ error: "agent_id e title são obrigatórios" }, { status: 400 });
      }
      const { data: agentOwned } = await supabaseAdmin
        .from("agent_settings")
        .select("id")
        .eq("id", agentId)
        .eq("client_id", auth.clientId)
        .maybeSingle();
      if (!agentOwned) {
        return NextResponse.json({ error: "Agente não encontrado" }, { status: 404 });
      }

      const { data: stage, error } = await supabaseAdmin
        .from("agent_stages")
        .insert({
          agent_id: agentId,
          client_id: auth.clientId,
          title,
          goal_prompt: String(body.goal_prompt || ""),
          order_index: Number.isFinite(Number(body.order_index)) ? Number(body.order_index) : 0,
        })
        .select("*")
        .single();
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      invalidateAgentConfigCache(agentId);
      return NextResponse.json({ success: true, stage });
    }

    if (action === "update_stage") {
      const stageId = String(body.stage_id || "").trim();
      if (!stageId) {
        return NextResponse.json({ error: "stage_id obrigatório" }, { status: 400 });
      }
      const { data: updated, error } = await supabaseAdmin
        .from("agent_stages")
        .update({
          goal_prompt: String(body.goal_prompt ?? ""),
          condition_variable: body.condition_variable ?? null,
          condition_operator: body.condition_operator ?? null,
          condition_value: body.condition_value ?? null,
          captured_variables: Array.isArray(body.captured_variables) ? body.captured_variables : [],
        })
        .eq("id", stageId)
        .eq("client_id", auth.clientId)
        .select("*")
        .maybeSingle();
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      if (!updated) {
        return NextResponse.json({ error: "Etapa não encontrada" }, { status: 404 });
      }
      invalidateAgentConfigCache((updated as { agent_id?: number }).agent_id);
      return NextResponse.json({ success: true, stage: updated });
    }

    if (action === "delete_stage") {
      const stageId = String(body.stage_id || "").trim();
      if (!stageId) {
        return NextResponse.json({ error: "stage_id obrigatório" }, { status: 400 });
      }
      const { data: deleted, error } = await supabaseAdmin
        .from("agent_stages")
        .delete()
        .eq("id", stageId)
        .eq("client_id", auth.clientId)
        .select("id, agent_id")
        .maybeSingle();
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 });
      }
      if (!deleted) {
        return NextResponse.json({ error: "Etapa não encontrada" }, { status: 404 });
      }
      invalidateAgentConfigCache((deleted as { agent_id?: number }).agent_id);
      return NextResponse.json({ success: true });
    }

    if (action === "reorder_stages") {
      const agentId = parsePositiveAgentId(body.agent_id);
      const stageIds = Array.isArray(body.stage_ids)
        ? body.stage_ids.map((id) => String(id))
        : [];
      if (!agentId || stageIds.length === 0) {
        return NextResponse.json({ error: "agent_id e stage_ids são obrigatórios" }, { status: 400 });
      }
      const { data: agentOwned } = await supabaseAdmin
        .from("agent_settings")
        .select("id")
        .eq("id", agentId)
        .eq("client_id", auth.clientId)
        .maybeSingle();
      if (!agentOwned) {
        return NextResponse.json({ error: "Agente não encontrado" }, { status: 404 });
      }

      await Promise.all(
        stageIds.map((sid, idx) =>
          supabaseAdmin!
            .from("agent_stages")
            .update({ order_index: idx })
            .eq("id", sid)
            .eq("agent_id", agentId)
            .eq("client_id", auth.clientId),
        ),
      );
      invalidateAgentConfigCache(agentId);
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ error: "Ação desconhecida" }, { status: 400 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro ao processar requisição";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

/**
 * DELETE /api/agent/settings?agent_id=X
 * Remove um agente do cliente autenticado (mantendo ao menos 1 agente).
 */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const auth = await requireClientId(req);
  if (!auth.ok) return auth.response;
  if (!supabaseAdmin) {
    return NextResponse.json({ error: "Banco de dados indisponível" }, { status: 500 });
  }

  let agentId = parsePositiveAgentId(req.nextUrl.searchParams.get("agent_id"));
  if (!agentId) {
    const body = (await req.json().catch(() => null)) as { agent_id?: unknown } | null;
    agentId = parsePositiveAgentId(body?.agent_id);
  }
  if (!agentId) {
    return NextResponse.json({ error: "agent_id inválido" }, { status: 400 });
  }

  try {
    const { data: allClientAgents, error: listErr } = await supabaseAdmin
      .from("agent_settings")
      .select("id")
      .eq("client_id", auth.clientId);
    if (listErr) {
      return NextResponse.json({ error: listErr.message }, { status: 500 });
    }
    const ownAgents = (allClientAgents || []) as Array<{ id: number }>;
    if (!ownAgents.some((a) => a.id === agentId)) {
      return NextResponse.json({ error: "Agente não encontrado" }, { status: 404 });
    }
    if (ownAgents.length <= 1) {
      return NextResponse.json(
        { error: "Não é possível excluir o único agente restante." },
        { status: 400 },
      );
    }

    const { data: deleted, error: delErr } = await supabaseAdmin
      .from("agent_settings")
      .delete()
      .eq("id", agentId)
      .eq("client_id", auth.clientId)
      .select("id")
      .maybeSingle();

    if (delErr) {
      return NextResponse.json({ error: delErr.message }, { status: 500 });
    }
    if (!deleted) {
      return NextResponse.json({ error: "Agente não encontrado" }, { status: 404 });
    }

    invalidateAgentConfigCache(agentId);
    return NextResponse.json({ success: true, deleted_id: agentId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro ao excluir agente";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

