"use client";

/**
 * Página /agente — orquestrador.
 *
 * Estrutura:
 *   _components/   Pequenos blocos reutilizados (CopyButton, PromptPreview, WebhookGuide, etc).
 *   _tabs/         Cada aba é um componente próprio (info, ajustes, etapas, testes, logs).
 *
 * Esta page.tsx mantém o STATE central + handlers e só compõe as tabs com props.
 * Sem lógica visual aqui dentro — qualquer mudança de UI deve ir pra _tabs/* ou _components/*.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Header } from "@/components/layout/header";
import { supabase } from "@/lib/supabase";
import { leadRowToTemplateContext, renderTemplate } from "@/lib/template-vars";
import { DEFAULT_SITE_PREVIEW_EVAL_PROMPT, DEFAULT_SITE_PREVIEW_PING_MESSAGE } from "@/lib/sites/agreement-detector-constants";
import { sandboxSuppressionMessage, normalizeSplitIntensity, DEFAULT_SPLIT_INTENSITY, type SplitIntensity } from "@/lib/agent-format";
import { cn } from "@/lib/utils";
import { mergeRealtimeLog } from "@/lib/realtime-logs";
import styles from "./agente.module.css";
import { useClientSession } from "@/lib/use-session";
import { Activity, FlaskConical, Info, ListTree, Settings, type LucideIcon } from "lucide-react";
import type { GroupableModel } from "@/lib/model-grouping";
import type { Stage } from "./_components/sortable-stage";
import { toast } from "sonner";

import { AgentSwitcher } from "./_components/agent-switcher";
import { DEFAULT_PREVIEW_SAMPLE, leadToPreviewSample, type PreviewLead, type PreviewSample } from "./_components/lead-selector";
import dynamic from "next/dynamic";
import { AjustesTab, type ScheduleRow } from "./_tabs/ajustes-tab";
// Tabs pesadas carregam sob demanda — só 1 aba é visível por vez, mas antes
// TODAS vinham no bundle da rota (info-tab sozinha = ~87KB de fonte).
const EtapasTab = dynamic(() => import("./_tabs/etapas-tab").then((m) => m.EtapasTab), { ssr: false });
const InfoTab = dynamic(() => import("./_tabs/info-tab").then((m) => m.InfoTab), { ssr: false });
const LogsTab = dynamic(() => import("./_tabs/logs-tab").then((m) => m.LogsTab), { ssr: false });
const TestesTab = dynamic(() => import("./_tabs/testes-tab").then((m) => m.TestesTab), { ssr: false });

type Tab = "info" | "ajustes" | "etapas" | "testes" | "logs";

const DAYS = [
  "Segunda-feira", "Terça-feira", "Quarta-feira", "Quinta-feira",
  "Sexta-feira", "Sábado", "Domingo",
];

const DEFAULT_SANDBOX_AI_PROMPT = `Você é um SDR experiente fazendo uma primeira abordagem PROFISSIONAL via WhatsApp.

INSTRUÇÕES:
- Reescreva a MENSAGEM-BASE de forma natural, curta (até 3 frases), em PT-BR.
- Mantenha o sentido original do template.
- Personalize SUTILMENTE pra empresa/ramo (sem inventar nada).
- Não use emojis exagerados.
- NÃO invente dados que não tem certeza.`;

export default function AgentePage() {
  const { clientId } = useClientSession();
  // ============= TAB ATIVA =============
  const [activeTab, setActiveTab] = useState<Tab>("info");

  // Modo avançado: revela as abas Etapas e Logs (power-user). Persistido por cliente.
  const [advancedMode, setAdvancedMode] = useState(false);
  useEffect(() => {
    if (!clientId) return;
    try { setAdvancedMode(localStorage.getItem(`sdr_agent_advanced_${clientId}`) === "1"); } catch {}
  }, [clientId]);
  const toggleAdvancedMode = useCallback(() => {
    setAdvancedMode((prev) => {
      const next = !prev;
      if (!next && (activeTab === "etapas" || activeTab === "logs")) setActiveTab("info");
      try { if (clientId) localStorage.setItem(`sdr_agent_advanced_${clientId}`, next ? "1" : "0"); } catch {}
      return next;
    });
  }, [activeTab, clientId]);

  // ============= AGENTES (lista + atual) =============
  const [activeAgentId, setActiveAgentId] = useState<number>(1);
  const [agentsList, setAgentsList] = useState<{ id: number; name: string }[]>([]);

  // ============= IDENTIDADE DO AGENTE =============
  const [isActiveAgente, setIsActiveAgente] = useState(true);
  const [nomeAgente, setNomeAgente] = useState("Sarah SDR");
  const [funcaoAgente, setFuncaoAgente] = useState("");
  const [personalidadeAgente, setPersonalidadeAgente] = useState("");
  const [tomAgente, setTomAgente] = useState("");
  const [targetModel, setTargetModel] = useState("");  // carregado do DB / hook em runtime
  const [fallbackModel, setFallbackModel] = useState(""); // modelo reserva de failover
  const [modelOptions, setModelOptions] = useState<GroupableModel[]>([]);
  const [isAdmin, setIsAdmin] = useState(false);  // só admin altera modelo de IA
  const [defaultAiModel, setDefaultAiModel] = useState<string | null>(null);
  const [appUrl, setAppUrl] = useState("");
  const [savingConfig, setSavingConfig] = useState(false);
  const [, setLoadingConfig] = useState(true);

  // ============= INSTÂNCIA VINCULADA =============
  const [vinculoInstance, setVinculoInstance] = useState("");
  const [savingVinculo, setSavingVinculo] = useState(false);
  const [allInstances, setAllInstances] = useState<string[]>([]);

  // ============= COMPORTAMENTO =============
  const [messageBufferSeconds, setMessageBufferSeconds] = useState(0);
  const [humanizeMessages, setHumanizeMessages] = useState(false);
  // Intensidade do picote: 1 = picota pouco · 3 = padrão · 5 = picota muito.
  const [splitIntensity, setSplitIntensity] = useState<SplitIntensity>(DEFAULT_SPLIT_INTENSITY);
  // Delay de digitação (Evolution API presence / delay)
  const [typingDelayMode, setTypingDelayMode] = useState<"fixed" | "random">("random");
  const [typingDelaySeconds, setTypingDelaySeconds] = useState<number>(10);
  const [typingDelayMinSeconds, setTypingDelayMinSeconds] = useState<number>(5);
  const [typingDelayMaxSeconds, setTypingDelayMaxSeconds] = useState<number>(25);
  const [customGoalEnabled, setCustomGoalEnabled] = useState(false);
  const [customGoalText, setCustomGoalText] = useState("");
  const [customGoalPauseMode, setCustomGoalPauseMode] = useState<"timed" | "indefinite">("timed");
  const [customGoalPauseMinutes, setCustomGoalPauseMinutes] = useState<number>(30);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  // Modo de raciocínio UNIVERSAL: 0=Econômico, 1=Equilibrado, 2=Intenso, 3=Think Máximo.
  // Funciona em todos os modelos (o ai-provider mapeia pro param de cada um).
  const [reasoningMode, setReasoningMode] = useState<0 | 1 | 2 | 3>(0);
  // Controle avançado de tokens e temperatura (vazio = padrão automático do provedor)
  const [maxOutputTokens, setMaxOutputTokens] = useState<string>("");
  const [temperature, setTemperature] = useState<string>("");
  // Lead Intelligence é POR AGENTE — não é mais um flag global da campanha/automação.
  // Cliente quer ativar só nos agentes que precisam de análise profunda do lead.
  const [leadIntelligenceEnabled, setLeadIntelligenceEnabled] = useState(false);

  // ============= PRÉVIAS DE SITES IA =============
  const [sitePreviewAutoDetect, setSitePreviewAutoDetect] = useState(false);
  const [sitePreviewConfirmBeforeLink, setSitePreviewConfirmBeforeLink] = useState(true);
  const [sitePreviewEvalPrompt, setSitePreviewEvalPrompt] = useState(DEFAULT_SITE_PREVIEW_EVAL_PROMPT);
  const [sitePreviewPingMessage, setSitePreviewPingMessage] = useState(DEFAULT_SITE_PREVIEW_PING_MESSAGE);
  const [sitePreviewEvalModel, setSitePreviewEvalModel] = useState("");

  // ============= GOOGLE CALENDAR =============
  const [calendarEnabled, setCalendarEnabled] = useState(false);
  const [googleJson, setGoogleJson] = useState("");
  const [isCalendarConnected, setIsCalendarConnected] = useState(false);
  const [calendarConnectedEmail, setCalendarConnectedEmail] = useState<string | null>(null);
  const [calendarGenerateMeet, setCalendarGenerateMeet] = useState(false);
  const [calendarSendMeetLink, setCalendarSendMeetLink] = useState(false);
  const [calendarDefaultDuration, setCalendarDefaultDuration] = useState<number>(30);
  const [calendarOptionalFields, setCalendarOptionalFields] = useState<Record<string, boolean>>({});
  const [calendarAutoCapture, setCalendarAutoCapture] = useState<{
    telefone: boolean;
    empresa: boolean;
    necessidade: boolean;
    necessidade_label?: string;
  }>({ telefone: true, empresa: true, necessidade: true, necessidade_label: "" });

  // ============= SCHEDULER (lembretes automáticos + auto-promote kanban) =============
  // Gravado em agent_settings.is_scheduler + agent_settings.scheduler_config (migration 006).
  type ReminderSpec = { offset_minutes: number; message: string };
  const [isScheduler, setIsScheduler] = useState(false);
  const [reminders, setReminders] = useState<ReminderSpec[]>([
    { offset_minutes: 1440, message: "Oi {nome}! Lembrete: amanhã às {hora_agendamento} temos seu agendamento de {servico}. Confirma?" },
    { offset_minutes: 60,   message: "Oi {nome}! Em 1h é o seu agendamento ({servico}). Te esperamos!" },
  ]);
  const [autoPromoteAfter, setAutoPromoteAfter] = useState(30);
  const [notifyOwner, setNotifyOwner] = useState(false);
  const [ownerPhone, setOwnerPhone] = useState("");
  // Pausa a IA após agendar com sucesso para um contato (default 2h = 120min).
  // Evita bombardear o cliente logo após marcar e dá janela ao humano. 0 = off.
  const [pauseAfterSchedule, setPauseAfterSchedule] = useState(120);
  // Resumo IA pro dono (agendamento/cancelamento/reagendamento)
  const [ownerSummaryEnabled, setOwnerSummaryEnabled] = useState(false);
  const [ownerSummaryPrompt, setOwnerSummaryPrompt] = useState("");
  const [ownerSummaryModel, setOwnerSummaryModel] = useState(""); // só admin fixa; "" = padrão da conta
  // Auto-mover kanban: De [coluna] → Para [coluna]
  const [autoPromoteFrom, setAutoPromoteFrom] = useState(""); // "" = qualquer coluna
  const [autoPromoteTo, setAutoPromoteTo] = useState("");      // "" = automático (heurística)
  // Desativar auto-mover totalmente (cliente não quer que o sistema mova no kanban sozinho).
  const [autoPromoteDisabled, setAutoPromoteDisabled] = useState(false);
  const [kanbanColumns, setKanbanColumns] = useState<{ status_key: string; label: string }[]>([]);
  useEffect(() => {
    fetch("/api/kanban-columns", { cache: "no-store" })
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok && Array.isArray(j.columns)) {
          setKanbanColumns(j.columns.map((c: { status_key: string; label: string }) => ({ status_key: c.status_key, label: c.label })));
        }
      })
      .catch(() => {});
  }, []);

  // ============= PROMPT =============
  const [prompt, setPrompt] = useState("");
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  // ============= PRÉ-VISUALIZAÇÃO DO PROMPT =============
  const [previewOpen, setPreviewOpen] = useState(true);
  const [previewSample, setPreviewSample] = useState<PreviewSample>(DEFAULT_PREVIEW_SAMPLE);
  const [previewLeads, setPreviewLeads] = useState<PreviewLead[]>([]);
  const [previewLeadsLoading, setPreviewLeadsLoading] = useState(false);
  const [previewSelectedLeadId, setPreviewSelectedLeadId] = useState<number | null>(null);
  const [previewLeadQuery, setPreviewLeadQuery] = useState("");

  // ============= BASE DE CONHECIMENTO =============
  const [knowledge, setKnowledge] = useState<{ id: string; title: string; content?: string }[]>([]);
  const [showNovoK, setShowNovoK] = useState(false);
  const [novoKTitle, setNovoKTitle] = useState("");
  const [novoKContent, setNovoKContent] = useState("");
  const [editKId, setEditKId] = useState<string | null>(null);
  const [editKTitle, setEditKTitle] = useState("");
  const [editKContent, setEditKContent] = useState("");

  // ============= HORÁRIOS (TAB AJUSTES) =============
  const [schedules, setSchedules] = useState<ScheduleRow[]>(
    DAYS.map((day) => ({ day, active: day !== "Domingo", start: "08:00", end: "18:00" }))
  );
  const [is24h, setIs24h] = useState(false);
  const [awayMessage, setAwayMessage] = useState("");
  const [disableGroups, setDisableGroups] = useState(false);
  const [transcriptionMethod, setTranscriptionMethod] = useState<"auto" | "whisper" | "gemini" | "openrouter" | "disabled">("auto");

  // ============= ETAPAS DO FUNIL =============
  const [stages, setStages] = useState<Stage[]>([]);
  const [novoStageTitle, setNovoStageTitle] = useState("");
  const [novoStagePrompt, setNovoStagePrompt] = useState("");
  const [showNovoStage, setShowNovoStage] = useState(false);

  // ============= CUSTOM TOOLS (webhooks N8N/Make por agente) =============
  const [customTools, setCustomTools] = useState<{ name: string; description: string; webhook_url: string }[]>([]);

  // ============= TESTES (SANDBOX) =============
  type SandboxMsg = { role: "user" | "agent" | "tool"; content: string; isError?: boolean };
  const [testMessages, setTestMessages] = useState<SandboxMsg[]>([]);
  const [testInput, setTestInput] = useState("");
  const [testLoading, setTestLoading] = useState(false);
  const [testIsTyping, setTestIsTyping] = useState(false);
  const [testTypingSeconds, setTestTypingSeconds] = useState<number | undefined>(undefined);
  const [testVariables, setTestVariables] = useState<Record<string, string>>({});
  const [testStageIndex, setTestStageIndex] = useState(0);
  const [testSkippedStages, setTestSkippedStages] = useState<number[]>([]);
  const [testCustomGoalPaused, setTestCustomGoalPaused] = useState(false);
  const [testCustomGoalPauseMode, setTestCustomGoalPauseMode] = useState<"timed" | "indefinite" | null>(null);
  const [testCustomGoalPauseMinutes, setTestCustomGoalPauseMinutes] = useState<number | null>(null);
  const [testCustomGoalResumeAt, setTestCustomGoalResumeAt] = useState<string | null>(null);
  const [testPreviaStatus, setTestPreviaStatus] = useState<string | null>(null);
  const [testLinkPrevia, setTestLinkPrevia] = useState<string | null>(null);
  const [testPreviaPingAt, setTestPreviaPingAt] = useState<string | null>(null);
  const [testPreviaLinkAt, setTestPreviaLinkAt] = useState<string | null>(null);
  const testBufferTimerRef = useRef<NodeJS.Timeout | null>(null);
  const testMessageBufferRef = useRef<string[]>([]);
  const testMessagesStateRef = useRef<SandboxMsg[]>([]);

  // ============= TESTES (DISPARO INICIAL) =============
  const [sandboxTemplate, setSandboxTemplate] = useState("Olá {{nome_negocio}}, vi que vocês são do ramo de {{ramo_negocio}}...");
  const [sandboxPersonalizeAI, setSandboxPersonalizeAI] = useState(false);
  const [sandboxAiPrompt, setSandboxAiPrompt] = useState(DEFAULT_SANDBOX_AI_PROMPT);
  const [sandboxUseWebSearch, setSandboxUseWebSearch] = useState(false);
  const [sandboxSimulating, setSandboxSimulating] = useState(false);
  const [sandboxSimulationEnabled, setSandboxSimulationEnabled] = useState(true);

  // ============= LOGS =============
  type WebhookLogRow = { created_at: string; event: string; instance_name: string; payload: unknown; id?: string | number };
  const [webhookLogs, setWebhookLogs] = useState<WebhookLogRow[]>([]);
  const [expandedLogs, setExpandedLogs] = useState<number[]>([]);

  // ============= APP URL DETECTADO NO BROWSER =============
  // Evita hydration mismatch — só popula depois do mount.
  const [browserOrigin, setBrowserOrigin] = useState("");
  useEffect(() => { setBrowserOrigin(window.location.origin); }, []);
  // Carrega sessão pra saber se é admin (só admin altera modelo de IA).
  useEffect(() => {
    fetch("/api/auth/session").then(r => r.json()).then(s => {
      setIsAdmin(!!s?.isAdmin && !s?.impersonating);
      setDefaultAiModel(s?.defaultAiModel || null);
    }).catch(() => {});
  }, []);
  const webhookBase = appUrl || browserOrigin;
  const webhookUrl = useMemo(
    () => webhookBase
      ? `${webhookBase}/api/webhooks/whatsapp?agentId=${activeAgentId || 1}`
      : `/api/webhooks/whatsapp?agentId=${activeAgentId || 1}`,
    [webhookBase, activeAgentId]
  );

  /* ====================================================================
     LOAD AGENTE — via BFF `/api/agent/settings` (sem expor segredos ao browser).
  ==================================================================== */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applyAgentBundle = useCallback((payload: { agent?: any; knowledge?: any[]; stages?: any[]; vinculoInstance?: string }) => {
    const data = payload?.agent;
    if (data) {
      setNomeAgente(data.name || "");
      setFuncaoAgente(data.role || "");
      setPersonalidadeAgente(data.personality || "");
      setTomAgente(data.tone || "");
      setPrompt(data.main_prompt || "");
      // schedules: se DB devolver [] ou null (agente nunca configurou),
      // popula com os 7 dias defaults pra UI não ficar vazia quando o
      // usuário desligar o "24h". Sem isso a tabela some inteira.
      const loaded = Array.isArray(data.schedules) && data.schedules.length === 7
        ? data.schedules
        : DAYS.map((day) => ({ day, active: day !== "Domingo", start: "08:00", end: "18:00" }));
      setSchedules(loaded);
      setTargetModel(data.target_model || "");
      setFallbackModel(String(data.options?.fallback_model || ""));
      setIsActiveAgente(data.is_active ?? true);
      setIs24h(data.is_24h ?? false);
      setAwayMessage(data.away_message || "");
      setDisableGroups(data.disable_groups ?? false);
      setTranscriptionMethod(data.transcription_method || "auto");

      const opts = data.options || {};
      setAppUrl(opts.app_url || "");
      // Segredos não retornam do BFF — campo fica vazio para digitar apenas se quiser substituir.
      setGoogleJson("");
      setIsCalendarConnected(Boolean(opts.google_connected ?? opts.google_tokens?.refresh_token));
      setCalendarConnectedEmail(opts.calendar_connected_email || null);
      setCalendarGenerateMeet(opts.calendar_generate_meet ?? false);
      setCalendarSendMeetLink(opts.calendar_send_meet_link ?? false);
      setCalendarEnabled(opts.calendar_enabled ?? false);
      setCalendarDefaultDuration(Number(opts.calendar_default_duration) || 30);
      setCalendarOptionalFields(opts.calendar_optional_fields || {});
      // Scheduler (lembretes + auto-promote) — vem das colunas novas da migration 006
      const isSched = !!data.is_scheduler;
      const schedCfg = data.scheduler_config || {};
      setIsScheduler(isSched);
      if (Array.isArray(schedCfg.reminders)) setReminders(schedCfg.reminders);
      if (typeof schedCfg.auto_promote_kanban_after_minutes === "number") setAutoPromoteAfter(schedCfg.auto_promote_kanban_after_minutes);
      setNotifyOwner(!!schedCfg.notify_owner);
      if (typeof schedCfg.pause_after_schedule_minutes === "number") setPauseAfterSchedule(schedCfg.pause_after_schedule_minutes);
      setOwnerPhone(schedCfg.owner_phone || "");
      setOwnerSummaryEnabled(!!schedCfg.owner_summary_enabled);
      setOwnerSummaryPrompt(schedCfg.owner_summary_prompt || "");
      setOwnerSummaryModel(schedCfg.owner_summary_model || "");
      setAutoPromoteFrom(schedCfg.auto_promote_from_status || "");
      setAutoPromoteTo(schedCfg.auto_promote_to_status || "");
      setAutoPromoteDisabled(!!schedCfg.auto_promote_disabled);
      setCalendarAutoCapture({
        telefone:          opts.calendar_auto_capture?.telefone    ?? true,
        empresa:           opts.calendar_auto_capture?.empresa     ?? true,
        necessidade:       opts.calendar_auto_capture?.necessidade ?? true,
        necessidade_label: opts.calendar_auto_capture?.necessidade_label || "",
      });
      setCustomTools(Array.isArray(opts.custom_tools) ? opts.custom_tools : []);
      setMessageBufferSeconds(opts.message_buffer_seconds || 0);
      setHumanizeMessages(opts.humanize_messages ?? false);
      setSplitIntensity(normalizeSplitIntensity(opts.split_intensity));
      setTypingDelayMode(opts.typing_delay_mode === "fixed" ? "fixed" : "random");
      setTypingDelaySeconds(Number(opts.typing_delay_seconds) || 10);
      setTypingDelayMinSeconds(Number(opts.typing_delay_min_seconds) || 5);
      setTypingDelayMaxSeconds(Number(opts.typing_delay_max_seconds) || 25);
      setCustomGoalEnabled(Boolean(opts.custom_goal_enabled));
      setCustomGoalText(typeof opts.custom_goal_text === "string" ? opts.custom_goal_text : "");
      setCustomGoalPauseMode(
        opts.custom_goal_pause_mode === "indefinite" || opts.custom_goal_pause_mode === "manual"
          ? "indefinite"
          : "timed"
      );
      setCustomGoalPauseMinutes(Math.max(1, Number(opts.custom_goal_pause_minutes) || 30));
      setWebSearchEnabled(opts.web_search_enabled ?? false);
      // Modo de raciocínio: prefere reasoning_mode (novo); retrocompat thinking_budget.
      if (opts.reasoning_mode === 0 || opts.reasoning_mode === 1 || opts.reasoning_mode === 2 || opts.reasoning_mode === 3) {
        setReasoningMode(opts.reasoning_mode);
      } else if (opts.thinking_budget !== undefined && opts.thinking_budget !== null && opts.thinking_budget !== "") {
        const tb = Number(opts.thinking_budget);
        setReasoningMode(tb === 3 ? 3 : tb < 0 ? 2 : tb > 0 ? 1 : 0);
      } else {
        setReasoningMode(0);
      }
      setMaxOutputTokens(
        opts.max_output_tokens !== undefined && opts.max_output_tokens !== null && Number(opts.max_output_tokens) > 0
          ? String(opts.max_output_tokens)
          : ""
      );
      setTemperature(
        opts.temperature !== undefined && opts.temperature !== null && opts.temperature !== "" && Number.isFinite(Number(opts.temperature))
          ? String(opts.temperature)
          : ""
      );
      // Lead Intelligence vem da coluna dedicada na tabela (não do JSONB options),
      // pra worker/automation conseguirem ler com SELECT simples.
      setLeadIntelligenceEnabled(data.lead_intelligence_enabled ?? false);

      setSitePreviewAutoDetect(opts.site_preview_auto_detect ?? false);
      setSitePreviewConfirmBeforeLink(opts.site_preview_confirm_before_link ?? true);
      setSitePreviewEvalPrompt(opts.site_preview_eval_prompt || DEFAULT_SITE_PREVIEW_EVAL_PROMPT);
      setSitePreviewPingMessage(opts.site_preview_ping_message || DEFAULT_SITE_PREVIEW_PING_MESSAGE);
      setSitePreviewEvalModel(opts.site_preview_eval_model || "");
    }
    if (Array.isArray(payload?.knowledge)) {
      setKnowledge(payload.knowledge);
    }
    setVinculoInstance(payload?.vinculoInstance || "");
    if (Array.isArray(payload?.stages)) {
      setStages(payload.stages);
    }
  }, []);

  const loadAgent = useCallback(async (id: number) => {
    if (!clientId) return;
    setLoadingConfig(true);
    try {
      const res = await fetch(`/api/agent/settings?agent_id=${id}`, { cache: "no-store" });
      if (!res.ok) return;
      const payload = await res.json();
      applyAgentBundle(payload);
    } finally {
      setLoadingConfig(false);
    }
  }, [clientId, applyAgentBundle]);

  /* ====================================================================
     VINCULAR INSTÂNCIA — com checagem de conflito via BFF.
  ==================================================================== */
  const saveVinculoInstant = useCallback(async (instanceName: string) => {
    if (!instanceName || !activeAgentId) return;
    setSavingVinculo(true);
    try {
      const sendBind = (force: boolean) =>
        fetch("/api/agent/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "bind_instance",
            agent_id: activeAgentId,
            instance_name: instanceName,
            force,
          }),
        });

      let res = await sendBind(false);
      let data = await res.json().catch(() => null);

      if (res.status === 409 && data?.conflict) {
        const existingAgentId = Number(data.existing_agent_id);
        const otherAgent = agentsList.find((a) => a.id === existingAgentId);
        const otherName = otherAgent?.name ? `${otherAgent.name} (ID ${existingAgentId})` : `agente ID ${existingAgentId}`;
        const ok = window.confirm(
          `A instância "${instanceName}" já está vinculada ao ${otherName}.\n\n` +
          `Vincular ela a este agente vai TIRAR essa instância do outro agente — ` +
          `o outro agente ficará sem instância e parará de receber mensagens.\n\n` +
          `Quer continuar?`
        );
        if (!ok) {
          const curRes = await fetch(`/api/agent/settings?agent_id=${activeAgentId}`, { cache: "no-store" });
          const curData = await curRes.json().catch(() => null);
          setVinculoInstance(curData?.vinculoInstance || "");
          return;
        }
        res = await sendBind(true);
        data = await res.json().catch(() => null);
      }

      if (!res.ok) {
        throw new Error(data?.error || "Erro ao vincular instância");
      }
    } catch (err) {
      alert("Erro ao vincular instância: " + (err as Error).message);
    } finally {
      setSavingVinculo(false);
    }
  }, [activeAgentId, agentsList]);

  /* ====================================================================
     EFFECTS de boot — corre uma vez no mount.
  ==================================================================== */
  useEffect(() => {
    const saved = clientId ? localStorage.getItem(`sdr_active_agent_id_${clientId}`) : null;
    const savedAgentId = saved ? Number(saved) : activeAgentId;
    if (saved) setActiveAgentId(savedAgentId);

    if (!clientId) return;
    (async () => {
      setLoadingConfig(true);
      try {
        const bootUrl = `/api/agent/settings?include_boot=1&agent_id=${savedAgentId || 1}`;
        const bootRes = await fetch(bootUrl, { cache: "no-store" });
        if (bootRes.ok) {
          const boot = await bootRes.json();
          if (boot.appUrl) setAppUrl(boot.appUrl);
          if (Array.isArray(boot.agents) && boot.agents.length > 0) {
            setAgentsList(boot.agents);
            if (boot.selectedAgentId) setActiveAgentId(boot.selectedAgentId);
            applyAgentBundle(boot);
          }
          if (Array.isArray(boot.instances)) {
            setAllInstances(boot.instances);
          }
          if (Array.isArray(boot.webhookLogs)) {
            setWebhookLogs(boot.webhookLogs);
          }
        }
      } catch (err) {
        console.error("[AGENTE] Erro no boot:", err);
      } finally {
        setLoadingConfig(false);
      }

      // Instâncias da Evolution API (caso tenha alguma que o banco não conhece ainda)
      // O endpoint /api/whatsapp já filtra por client_id no backend.
      fetch("/api/whatsapp")
        .then((r) => r.json())
        .then((data) => {
          if (!data.instances) return;
          const evoNames = data.instances
            .map((i: { instanceName?: string; instance_name?: string }) => i.instanceName || i.instance_name)
            .filter(Boolean) as string[];

          setAllInstances((prev) => {
            const next = Array.from(new Set([...prev, ...evoNames]));
            return next.length === prev.length ? prev : next;
          });
        })
        .catch(console.error);
    })();

    fetch("/api/ai-models").then((r) => r.json()).then((data) => {
      if (data.success && data.models) setModelOptions(data.models);
    });

    const channel = typeof supabase?.channel === "function"
      ? supabase.channel(`webhook_logs_realtime_${clientId}`)
          .on(
            "postgres_changes",
            { event: "INSERT", schema: "public", table: "webhook_logs", filter: `client_id=eq.${clientId}` },
            (payload) => {
              const incoming = payload.new as WebhookLogRow & { client_id?: string | null };
              if (incoming?.client_id !== clientId) return;
              setWebhookLogs((prev) => mergeRealtimeLog(prev, incoming, 20, "prepend"));
            }
          )
          .subscribe()
      : null;

    // Fallback de polling suave caso o canal Realtime caia ou RLS bloqueie webhook_logs.
    const pollLogs = setInterval(() => {
      if (document.hidden) return;
      fetch("/api/agent/settings?logs_only=1", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d?.success && Array.isArray(d.webhookLogs)) {
            setWebhookLogs(d.webhookLogs);
          }
        })
        .catch(() => {});
    }, 12_000);

    return () => {
      clearInterval(pollLogs);
      if (channel) supabase.removeChannel(channel);
      // Sandbox usa um timer pra agrupar mensagens (humanização) — limpa pra evitar
      // que o setTimeout dispare depois que a página foi desmontada.
      if (testBufferTimerRef.current) clearTimeout(testBufferTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadAgent, clientId]);

  // Persiste agente selecionado entre sessões
  useEffect(() => {
    if (activeAgentId && clientId) localStorage.setItem(`sdr_active_agent_id_${clientId}`, activeAgentId.toString());
  }, [activeAgentId, clientId]);

  // Sandbox de testes: persiste histórico por agente no localStorage
  useEffect(() => {
    if (!activeAgentId) return;
    try {
      const raw = localStorage.getItem(`sdr_test_messages_${activeAgentId}`);
      setTestMessages(raw ? JSON.parse(raw) : []);
    } catch { setTestMessages([]); }
  }, [activeAgentId]);

  useEffect(() => {
    if (!activeAgentId) return;
    try {
      localStorage.setItem(`sdr_test_messages_${activeAgentId}`, JSON.stringify(testMessages));
    } catch { /* quota, ignora */ }
    testMessagesStateRef.current = testMessages;
  }, [testMessages, activeAgentId]);

  // URL pública (ngrok ou VPS) — fonte única lida do widget global no header
  useEffect(() => {
    let cancelled = false;
    fetch("/api/config/ngrok", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data?.url) setAppUrl((prev) => prev || data.url);
      })
      .catch(() => {});

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.url) setAppUrl(detail.url);
    };
    window.addEventListener("public-url-changed", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("public-url-changed", handler);
    };
  }, [clientId, loadAgent]);

  /* ====================================================================
     SAVE handlers — todos chamam PATCH /api/agent/settings (BFF seguro).
  ==================================================================== */
  const saveIdentity = async (silent = false) => {
    if (!activeAgentId) return;
    setSavingConfig(true);
    try {
      const res = await fetch("/api/agent/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: activeAgentId,
          section: "identity",
          name: nomeAgente,
          role: funcaoAgente,
          personality: personalidadeAgente,
          tone: tomAgente,
          target_model: targetModel,
          lead_intelligence_enabled: leadIntelligenceEnabled,
          options: {
            app_url: appUrl,
            message_buffer_seconds: messageBufferSeconds,
            humanize_messages: humanizeMessages,
            split_intensity: splitIntensity,
            typing_delay_mode: typingDelayMode,
            typing_delay_seconds: typingDelaySeconds,
            typing_delay_min_seconds: typingDelayMinSeconds,
            typing_delay_max_seconds: typingDelayMaxSeconds,
            custom_goal_enabled: customGoalEnabled,
            custom_goal_text: customGoalText,
            custom_goal_pause_mode: customGoalPauseMode,
            custom_goal_pause_minutes: customGoalPauseMinutes,
            web_search_enabled: webSearchEnabled,
            reasoning_mode: reasoningMode,
            thinking_budget: reasoningMode,
            max_output_tokens: maxOutputTokens.trim() && Number(maxOutputTokens) > 0
              ? Math.min(8192, Math.max(50, Math.floor(Number(maxOutputTokens))))
              : undefined,
            temperature: temperature.trim() !== "" && Number.isFinite(Number(temperature))
              ? Math.min(2, Math.max(0, Number(temperature)))
              : undefined,
            custom_tools: customTools.filter((t) => t.name.trim() && t.webhook_url.trim()),
            site_preview_auto_detect: sitePreviewAutoDetect,
            site_preview_confirm_before_link: sitePreviewConfirmBeforeLink,
            site_preview_eval_prompt: sitePreviewEvalPrompt,
            site_preview_ping_message: sitePreviewPingMessage,
            site_preview_eval_model: sitePreviewEvalModel,
            fallback_model: fallbackModel,
          },
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        if (!silent) alert("Erro: " + (json?.error || "falha ao salvar"));
        return false;
      }
      if (!silent) alert("Identidade salva!");
      return true;
    } finally {
      setSavingConfig(false);
    }
  };

  const savePrompt = async (silent = false) => {
    if (!activeAgentId) return;
    setSavingConfig(true);
    try {
      const res = await fetch("/api/agent/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: activeAgentId,
          section: "prompt",
          main_prompt: prompt,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        if (!silent) alert("Erro: " + (json?.error || "falha ao salvar"));
        return false;
      }
      if (!silent) alert("Prompt salvo!");
      return true;
    } finally {
      setSavingConfig(false);
    }
  };

  const saveSchedules = async () => {
    if (!activeAgentId) return;
    setSavingConfig(true);
    try {
      const res = await fetch("/api/agent/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: activeAgentId,
          section: "schedules",
          schedules,
          is_24h: is24h,
          away_message: awayMessage,
          disable_groups: disableGroups,
          transcription_method: transcriptionMethod,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) alert("Erro: " + (json?.error || "falha ao salvar"));
      else alert("Horários salvos!");
    } finally {
      setSavingConfig(false);
    }
  };

  const saveCalendarConfig = async (silent = false) => {
    if (!activeAgentId) return;
    setSavingConfig(true);
    try {
      const res = await fetch("/api/agent/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: activeAgentId,
          section: "calendar",
          is_scheduler: isScheduler,
          options: {
            ...(googleJson.trim() ? { google_credentials: googleJson } : {}),
            calendar_enabled: calendarEnabled,
            calendar_generate_meet: calendarGenerateMeet,
            calendar_send_meet_link: calendarSendMeetLink,
            calendar_default_duration: calendarDefaultDuration,
            calendar_optional_fields: calendarOptionalFields,
            calendar_auto_capture: calendarAutoCapture,
          },
          scheduler_config: {
            calendar_id: "primary",
            default_duration_minutes: calendarDefaultDuration,
            reminders,
            auto_promote_kanban_after_minutes: autoPromoteAfter,
            notify_owner: notifyOwner,
            owner_phone: ownerPhone || null,
            owner_summary_enabled: ownerSummaryEnabled,
            owner_summary_prompt: ownerSummaryPrompt || "",
            owner_summary_model: ownerSummaryModel || null,
            auto_promote_from_status: autoPromoteFrom || "",
            auto_promote_to_status: autoPromoteTo || "",
            auto_promote_disabled: !!autoPromoteDisabled,
            pause_after_schedule_minutes: Number(pauseAfterSchedule) || 0,
          },
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) {
        if (!silent) alert("Erro: " + (json?.error || "falha ao salvar"));
        return false;
      }
      if (!silent) alert("Agenda salva!");
      return true;
    } finally {
      setSavingConfig(false);
    }
  };

  // Conecta via 1 clique com as credenciais centrais da plataforma,
  // ou salva credenciais customizadas se preenchidas no campo avançado.
  const [testingGoogle, setTestingGoogle] = useState(false);
  const testGoogleConnection = async () => {
    if (!activeAgentId) return;
    setTestingGoogle(true);
    // Abre o popup JÁ no clique (gesto do usuário) pra não ser bloqueado pelo navegador.
    const popup = window.open("about:blank", "google-oauth", "width=520,height=660");
    try {
      // 1) Se houver googleJson customizado, salva; senão conecta via plataforma (1 clique)
      const r = await fetch("/api/calendario/connect-google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: activeAgentId,
          google_credentials_json: googleJson.trim() ? googleJson.trim() : undefined,
        }),
      });
      const d = await r.json();
      if (!d.ok) {
        popup?.close();
        alert("Não foi possível iniciar a conexão: " + (d.error || "erro desconhecido"));
        return;
      }

      // 2) Gera a URL OAuth do Google e navega o popup pra ela
      const u = await fetch(`/api/auth/google/url?agentId=${activeAgentId}`, { cache: "no-store" }).then((x) => x.json());
      if (!u?.url) {
        popup?.close();
        alert("Falha ao gerar URL do Google: " + (u?.error || "desconhecido"));
        return;
      }
      if (popup) popup.location.href = u.url;
      else window.open(u.url, "_blank");
    } catch (e) {
      popup?.close();
      alert("Erro de rede: " + ((e as Error)?.message || e));
    } finally {
      setTestingGoogle(false);
    }
  };

  const disconnectGoogle = async () => {
    if (!activeAgentId) return;
    const ok = confirm("Deseja realmente desconectar a conta do Google Calendar deste agente?");
    if (!ok) return;
    try {
      const r = await fetch("/api/calendario/connect-google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: activeAgentId, action: "disconnect" }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "Erro ao desconectar");
      setIsCalendarConnected(false);
      setCalendarConnectedEmail(null);
      await loadAgent(activeAgentId);
      alert("Conta Google desconectada com sucesso.");
    } catch (e: any) {
      alert("Erro: " + e.message);
    }
  };

  // Recebe o aviso do popup OAuth (postMessage) quando o Google conecta —
  // recarrega o agente (puxa google_tokens) e confirma pro usuário.
  useEffect(() => {
    function onMsg(ev: MessageEvent) {
      if (ev?.data?.type === "google-calendar") {
        if (ev.data.ok) {
          if (activeAgentId) loadAgent(activeAgentId);
          alert("✓ Google Calendar conectado com sucesso! A IA já pode agendar.");
        } else {
          alert("⚠ A conexão com o Google não foi concluída. Tente novamente.");
        }
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [activeAgentId, loadAgent]);

  const toggleAgentActive = async () => {
    const nv = !isActiveAgente;
    setIsActiveAgente(nv);
    const res = await fetch("/api/agent/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agent_id: activeAgentId,
        section: "toggle_active",
        is_active: nv,
      }),
    });
    if (!res.ok) {
      setIsActiveAgente(!nv);
    }
  };

  /* ====================================================================
     KNOWLEDGE BASE CRUD
  ==================================================================== */
  const salvarNovoKnowledge = async () => {
    if (!activeAgentId || !novoKContent.trim()) {
      alert("Por favor, preencha o conteúdo da base de conhecimento.");
      return;
    }
    const titleToUse = novoKTitle.trim() || "Catálogo de Produtos";
    const numAgentId = Number(activeAgentId) || 1;

    try {
      const res = await fetch("/api/agent/knowledge/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create",
          agent_id: numAgentId,
          title: titleToUse,
          content: novoKContent.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success) {
        setNovoKTitle("");
        setNovoKContent("");
        setShowNovoK(false);
        await loadAgent(activeAgentId);
        toast.success("Base de conhecimento salva com sucesso!");
      } else {
        alert("Erro ao salvar base de conhecimento: " + (data.error || "Falha na requisição"));
      }
    } catch (err) {
      alert("Erro de conexão ao salvar: " + (err as Error).message);
    }
  };

  const deletarKnowledge = async (kid: string) => {
    if (!confirm("Excluir base de conhecimento?")) return;
    try {
      const res = await fetch("/api/agent/knowledge/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "delete",
          id: kid,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        await loadAgent(activeAgentId);
        toast.success("Base de conhecimento removida!");
      } else {
        alert("Erro ao excluir: " + (data.error || "Falha"));
      }
    } catch (err) {
      alert("Erro ao excluir: " + (err as Error).message);
    }
  };

  const iniciarEdicaoKnowledge = (k: { id: string; title: string; content?: string }) => {
    setEditKId(k.id);
    setEditKTitle(k.title || "");
    setEditKContent(k.content || "");
  };

  const cancelarEdicaoKnowledge = () => {
    setEditKId(null); setEditKTitle(""); setEditKContent("");
  };

  const salvarEdicaoKnowledge = async () => {
    if (!editKId || !editKContent.trim()) return;
    const titleToUse = editKTitle.trim() || "Catálogo de Produtos";
    const numAgentId = Number(activeAgentId) || 1;

    try {
      const res = await fetch("/api/agent/knowledge/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update",
          id: editKId,
          agent_id: numAgentId,
          title: titleToUse,
          content: editKContent.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (res.ok && data.success) {
        cancelarEdicaoKnowledge();
        await loadAgent(activeAgentId);
        toast.success("Base de conhecimento atualizada!");
      } else {
        alert("Erro ao atualizar: " + (data.error || "Falha"));
      }
    } catch (err) {
      alert("Erro ao atualizar: " + (err as Error).message);
    }
  };

  /* ====================================================================
     STAGES (ETAPAS DO FUNIL)
  ==================================================================== */
  const salvarNovoStage = async () => {
    if (!activeAgentId || !novoStageTitle) return;
    const res = await fetch("/api/agent/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "create_stage",
        agent_id: activeAgentId,
        title: novoStageTitle,
        goal_prompt: novoStagePrompt,
        order_index: stages.length,
      }),
    });
    if (res.ok) {
      setNovoStageTitle(""); setNovoStagePrompt(""); setShowNovoStage(false);
      loadAgent(activeAgentId);
    }
  };

  const deletarStage = async (sid: string) => {
    if (!confirm("Excluir esta etapa?")) return;
    const res = await fetch("/api/agent/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete_stage", stage_id: sid }),
    });
    if (res.ok) loadAgent(activeAgentId);
  };

  const reorderStages = async (newStages: Stage[]) => {
    await fetch("/api/agent/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "reorder_stages",
        agent_id: activeAgentId,
        stage_ids: newStages.map((s) => s.id),
      }),
    });
  };

  const saveStage = async (stage: Stage) => {
    const res = await fetch("/api/agent/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "update_stage",
        stage_id: stage.id,
        goal_prompt: stage.goal_prompt,
        condition_variable: stage.condition_variable,
        condition_operator: stage.condition_operator,
        condition_value: stage.condition_value,
        captured_variables: stage.captured_variables || [],
      }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) alert("Erro ao salvar etapa: " + (json?.error || "erro desconhecido"));
    else alert("Alterações da etapa salvas!");
  };

  /* ====================================================================
     PROMPT EDITOR — chips inserem variáveis na posição do cursor.
  ==================================================================== */
  const insertAtCursor = (snippet: string) => {
    if (!snippet) return;
    const ta = promptRef.current;
    if (!ta) {
      setPrompt((p) => p + (p && !p.endsWith("\n") ? "\n" : "") + snippet);
      return;
    }
    const start = ta.selectionStart ?? prompt.length;
    const end = ta.selectionEnd ?? prompt.length;
    const next = prompt.slice(0, start) + snippet + prompt.slice(end);
    setPrompt(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + snippet.length;
      ta.setSelectionRange(pos, pos);
    });
  };
  const insertVariable   = (key: string)   => insertAtCursor(`{{${key}}}`);
  const insertKbVariable = (title: string) => insertAtCursor(`{{kb:${title}}}`);

  /* ====================================================================
     PREVIEW DO PROMPT — carrega leads sob demanda + aplica selecionado.
  ==================================================================== */
  const loadPreviewLeads = useCallback(async () => {
    setPreviewLeadsLoading(true);
    try {
      const res = await fetch("/api/agent/settings?preview_leads=1", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json().catch(() => null);
      setPreviewLeads((data?.leads || []) as PreviewLead[]);
    } finally {
      setPreviewLeadsLoading(false);
    }
  }, []);

  const applyLeadToSample = (lead: PreviewLead | null) => {
    if (!lead) return;
    setPreviewSelectedLeadId(lead.id);
    setPreviewSample(leadToPreviewSample(lead));
  };

  /* ====================================================================
     WEBHOOK SYNC — registra na Evolution e persiste public_url no DB.
  ==================================================================== */
  const onSyncWebhook = async () => {
    if (!vinculoInstance) return alert("Vincule uma instância primeiro!");
    try {
      const detectedUrl = (typeof window !== "undefined" ? window.location.origin : "") || appUrl;
      const res = await fetch("/api/webhooks/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceName: vinculoInstance, appUrl: detectedUrl, agentId: activeAgentId }),
      });
      const data = await res.json();
      if (data.success) {
        const base: string = data.appUrl || (data.webhookUrl ? data.webhookUrl.split("/api/webhooks/")[0] : "");
        if (base) {
          setAppUrl(base);
          window.dispatchEvent(new CustomEvent("public-url-changed", { detail: { url: base } }));
        }
        alert("Sincronizado e salvo!\nWebhook: " + (data.webhookUrl || "") + "\nApp URL: " + base);
      } else {
        alert("Erro: " + data.error);
      }
    } catch (e) {
      alert("Erro ao sincronizar: " + (e as Error).message);
    }
  };

  /* ====================================================================
     SANDBOX — disparo inicial e chat de testes (com buffer humanizado).
  ==================================================================== */
  const simulateInitialMessage = async () => {
    if (!sandboxTemplate.trim()) return;
    if (!sandboxSimulationEnabled) return;
    setSandboxSimulating(true);
    try {
      const baseMessage = renderTemplate(sandboxTemplate, leadRowToTemplateContext(previewSample as Record<string, unknown>));
      let finalMessage = baseMessage;

      if (sandboxPersonalizeAI) {
        const res = await fetch("/api/agent/rewrite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseMessage, model: targetModel, customPrompt: sandboxAiPrompt,
            nomeEmpresa: previewSample.nome_negocio, ramo: previewSample.ramo_negocio,
            useWebSearch: sandboxUseWebSearch,
          }),
        });
        const data = await res.json();
        if (data.success && data.text) finalMessage = data.text;
        else { alert("Erro na IA: " + data.error); return; }
      }

      const agentMessage: SandboxMsg = { role: "agent", content: finalMessage };
      setTestMessages([agentMessage]);
      setTestVariables({});
      setTestStageIndex(0);
      setTestSkippedStages([]);
      setTestCustomGoalPaused(false);
      setTestCustomGoalPauseMode(null);
      setTestCustomGoalPauseMinutes(null);
      setTestCustomGoalResumeAt(null);
      try { localStorage.setItem(`sdr_test_messages_${activeAgentId}`, JSON.stringify([agentMessage])); } catch {}
    } catch (e) {
      alert("Erro ao simular: " + (e as Error).message);
    } finally {
      setSandboxSimulating(false);
    }
  };

  const processSandboxQueue = async () => {
    if (testMessageBufferRef.current.length === 0) return;

    const consolidatedText = testMessageBufferRef.current.join("\n");
    testMessageBufferRef.current = [];

    setTestLoading(true);
    try {
      const currentHistory = testMessagesStateRef.current
        .filter((m) => m.role === "user" || m.role === "agent")
        .map((m) => ({ role: m.role, content: m.content }));

      const res = await fetch("/api/agent/process", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-test-agent-id": activeAgentId.toString() },
        body: JSON.stringify({
          isTestMode: true,
          remoteJid: "sandbox_teste",
          text: consolidatedText,
          testHistory: currentHistory.slice(0, -1),
          testState: {
            variables: testVariables,
            currentStageIndex: testStageIndex,
            skippedStages: testSkippedStages,
            previa_status: testPreviaStatus,
            link_previa: testLinkPrevia,
            previa_ping_enviado_em: testPreviaPingAt,
            previa_link_enviado_em: testPreviaLinkAt,
            customGoalPaused: testCustomGoalPaused,
            customGoalPauseMode: testCustomGoalPauseMode,
            customGoalPauseMinutes: testCustomGoalPauseMinutes,
            customGoalResumeAt: testCustomGoalResumeAt,
          },
          testLeadData: previewSample,
        }),
      });
      const data = await res.json();

      if (!data.success || data.error) {
        setTestMessages((prev) => [...prev, { role: "agent", isError: true, content: `❌ ${data.error || "Erro desconhecido no servidor."}` }]);
        return;
      }

      if (data.status && data.status !== "agent_active" && !data.text && !data.chunks) {
        const statusMessages: Record<string, string> = {
          agent_inactive: "⚠️ Agente inativo. Ative-o na aba Informações.",
          agent_tenant_mismatch: "⚠️ Agente não pertence ao cliente desta instância WhatsApp. Ajuste a conexão em WhatsApp.",
          ai_paused: `⏸️ IA pausada: ${data.reason || "motivo desconhecido"}.`,
          out_of_office: "🕐 Fora do horário de atendimento configurado.",
          batching_active: "⏳ Agurdando buffer de mensagens (não aplicável em teste).",
          ignored: "ℹ️ Mensagem ignorada (status update).",
        };
        const msg = statusMessages[data.status] || `⚠️ Status inesperado: ${data.status}`;
        setTestMessages((prev) => [...prev, { role: "agent", isError: true, content: msg }]);
        return;
      }

      const suppressionMessage = sandboxSuppressionMessage(data.suppressed);
      if (suppressionMessage) {
        setTestMessages((prev) => [...prev, { role: "tool", content: suppressionMessage }]);
        return;
      }

      const toolLogs = Array.isArray(data.logs) ? [...data.logs] : [];

      if (data.testStateUpdate) {
        if (data.testStateUpdate.variables) setTestVariables(data.testStateUpdate.variables);
        if (data.testStateUpdate.currentStageIndex !== undefined) setTestStageIndex(data.testStateUpdate.currentStageIndex);
        if (data.testStateUpdate.skippedStages) setTestSkippedStages(data.testStateUpdate.skippedStages);
        if (data.testStateUpdate.previa_status !== undefined) setTestPreviaStatus(data.testStateUpdate.previa_status ?? null);
        if (data.testStateUpdate.link_previa !== undefined) setTestLinkPrevia(data.testStateUpdate.link_previa ?? null);
        if (data.testStateUpdate.previa_ping_enviado_em !== undefined) setTestPreviaPingAt(data.testStateUpdate.previa_ping_enviado_em ?? null);
        if (data.testStateUpdate.previa_link_enviado_em !== undefined) setTestPreviaLinkAt(data.testStateUpdate.previa_link_enviado_em ?? null);
        if (data.testStateUpdate.closingAutoPaused) {
          toolLogs.push({
            role: "system",
            content: `[Auto-Pausa Pós-Despedida] Despedida detectada (${data.testStateUpdate.closingAutoPauseReason || "encerramento"}) — em produção a IA pausaria após enviar esta resposta.`,
          });
        }
        if (data.testStateUpdate.customGoalPaused) {
          setTestCustomGoalPaused(true);
          setTestCustomGoalPauseMode(data.testStateUpdate.customGoalPauseMode || "timed");
          setTestCustomGoalPauseMinutes(data.testStateUpdate.customGoalPauseMinutes ?? null);
          setTestCustomGoalResumeAt(data.testStateUpdate.customGoalResumeAt ?? null);
        }
      }

      const chunks: string[] = Array.isArray(data.chunks) && data.chunks.length > 0
        ? data.chunks
        : [data.text || "[Sem retorno]"];

      setTestMessages((prev) => [
        ...prev,
        ...toolLogs.map((l: { content?: string }) => ({ role: "tool" as const, content: String(l.content ?? JSON.stringify(l)) })),
      ]);

      // Simula o tempo de digitação (digitando...) calculado pelo Evolution API delay
      const rawDelay = data.typingDelaySeconds;
      const simulatedDelaySec = typeof rawDelay === "number" && rawDelay > 0
        ? rawDelay
        : (typingDelayMode === "fixed"
            ? typingDelaySeconds
            : Math.floor(Math.random() * (typingDelayMaxSeconds - typingDelayMinSeconds + 1)) + typingDelayMinSeconds);

      setTestTypingSeconds(simulatedDelaySec);
      setTestIsTyping(true);

      // Aguarda o delay com animação de "digitando..."
      await new Promise((r) => setTimeout(r, Math.min(simulatedDelaySec, 30) * 1000));
      setTestIsTyping(false);
      setTestTypingSeconds(undefined);

      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) {
          const chunkTyping = Math.min(Math.max(chunks[i].length / 15, 1.5), 4);
          setTestTypingSeconds(Math.round(chunkTyping));
          setTestIsTyping(true);
          await new Promise((r) => setTimeout(r, chunkTyping * 1000));
          setTestIsTyping(false);
          setTestTypingSeconds(undefined);
        }
        setTestMessages((prev) => [...prev, { role: "agent", content: chunks[i] }]);
      }
    } catch (e) {
      setTestMessages((prev) => [...prev, { role: "agent", isError: true, content: `❌ Falha ao contatar servidor: ${(e as Error).message}` }]);
    } finally {
      setTestLoading(false);
      setTestIsTyping(false);
      setTestTypingSeconds(undefined);
    }
  };

  const handleTestSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!testInput.trim()) return;
    const currentInput = testInput.trim();

    // Visual: agrupa visualmente se está dentro do buffer
    setTestMessages((prev) => {
      if (messageBufferSeconds > 0 && prev.length > 0 && prev[prev.length - 1].role === "user" && testMessageBufferRef.current.length > 0) {
        const newPrev = [...prev];
        newPrev[newPrev.length - 1] = { ...newPrev[newPrev.length - 1], content: newPrev[newPrev.length - 1].content + "\n\n" + currentInput };
        return newPrev;
      }
      return [...prev, { role: "user", content: currentInput }];
    });

    setTestInput("");
    testMessageBufferRef.current.push(currentInput);

    if (testBufferTimerRef.current) clearTimeout(testBufferTimerRef.current);

    if (messageBufferSeconds > 0) {
      setTestLoading(true);
      testBufferTimerRef.current = setTimeout(() => processSandboxQueue(), messageBufferSeconds * 1000);
    } else {
      processSandboxQueue();
    }
  };

  const clearTestSession = () => {
    setTestMessages([]);
    setTestVariables({});
    setTestStageIndex(0);
    setTestSkippedStages([]);
    setTestCustomGoalPaused(false);
    setTestCustomGoalPauseMode(null);
    setTestCustomGoalPauseMinutes(null);
    setTestCustomGoalResumeAt(null);
    setTestPreviaStatus(null);
    setTestLinkPrevia(null);
    setTestPreviaPingAt(null);
    setTestPreviaLinkAt(null);
    try { localStorage.removeItem(`sdr_test_messages_${activeAgentId}`); } catch {}
  };

  const resumeTestAi = () => {
    setTestCustomGoalPaused(false);
    setTestCustomGoalPauseMode(null);
    setTestCustomGoalPauseMinutes(null);
    setTestCustomGoalResumeAt(null);
    setTestMessages((prev) => [
      ...prev,
      {
        role: "tool",
        content: "[Objetivo Personalizado] IA reativada manualmente para este contato de teste.",
      },
    ]);
  };

  /* ====================================================================
     LOGS — toggle de expand individual.
  ==================================================================== */
  const toggleLog = (idx: number) => {
    setExpandedLogs((prev) => prev.includes(idx) ? prev.filter((i) => i !== idx) : [...prev, idx]);
  };

  /* ====================================================================
     RENDER
  ==================================================================== */
  return (
    <div className={cn(styles.agent, "flex flex-col h-[100dvh] max-h-[100dvh] overflow-hidden")}>
      <Header />

      <main className="flex-1 min-h-0 overflow-y-auto w-full" aria-label="Configuração do agente IA">
        <AgentSwitcher
          activeAgentId={activeAgentId}
          agentsList={agentsList}
          setAgentsList={setAgentsList}
          setActiveAgentId={setActiveAgentId}
          loadAgent={loadAgent}
          clientId={clientId}
        />

        <div className={cn(styles.content, "max-w-6xl mx-auto px-4 py-6 sm:px-8 sm:py-8 space-y-6")}>
          {/* Tabs nav */}
          <TabsNav active={activeTab} onChange={setActiveTab} showAdvanced={advancedMode} onToggleAdvanced={toggleAdvancedMode} />

          <div className="min-w-0 space-y-8 pb-4">
            {activeTab === "info" && (
              <InfoTab
                nomeAgente={nomeAgente} setNomeAgente={setNomeAgente}
                funcaoAgente={funcaoAgente} setFuncaoAgente={setFuncaoAgente}
                personalidadeAgente={personalidadeAgente} setPersonalidadeAgente={setPersonalidadeAgente}
                tomAgente={tomAgente} setTomAgente={setTomAgente}
                isActiveAgente={isActiveAgente} setIsActiveAgente={setIsActiveAgente}
                targetModel={targetModel} setTargetModel={setTargetModel}
                fallbackModel={fallbackModel} setFallbackModel={setFallbackModel}
                modelOptions={modelOptions}
                isAdmin={isAdmin}
                defaultAiModel={defaultAiModel}
                appUrl={appUrl} setAppUrl={setAppUrl}
                vinculoInstance={vinculoInstance} setVinculoInstance={setVinculoInstance}
                allInstances={allInstances}
                savingVinculo={savingVinculo}
                onSaveVinculo={saveVinculoInstant}
                messageBufferSeconds={messageBufferSeconds} setMessageBufferSeconds={setMessageBufferSeconds}
                humanizeMessages={humanizeMessages} setHumanizeMessages={setHumanizeMessages}
                splitIntensity={splitIntensity} setSplitIntensity={setSplitIntensity}
                typingDelayMode={typingDelayMode} setTypingDelayMode={setTypingDelayMode}
                typingDelaySeconds={typingDelaySeconds} setTypingDelaySeconds={setTypingDelaySeconds}
                typingDelayMinSeconds={typingDelayMinSeconds} setTypingDelayMinSeconds={setTypingDelayMinSeconds}
                typingDelayMaxSeconds={typingDelayMaxSeconds} setTypingDelayMaxSeconds={setTypingDelayMaxSeconds}
                customGoalEnabled={customGoalEnabled} setCustomGoalEnabled={setCustomGoalEnabled}
                customGoalText={customGoalText} setCustomGoalText={setCustomGoalText}
                customGoalPauseMode={customGoalPauseMode} setCustomGoalPauseMode={setCustomGoalPauseMode}
                customGoalPauseMinutes={customGoalPauseMinutes} setCustomGoalPauseMinutes={setCustomGoalPauseMinutes}
                webSearchEnabled={webSearchEnabled} setWebSearchEnabled={setWebSearchEnabled}
                reasoningMode={reasoningMode} setReasoningMode={setReasoningMode}
                maxOutputTokens={maxOutputTokens} setMaxOutputTokens={setMaxOutputTokens}
                temperature={temperature} setTemperature={setTemperature}
                customTools={customTools} setCustomTools={setCustomTools}
                leadIntelligenceEnabled={leadIntelligenceEnabled} setLeadIntelligenceEnabled={setLeadIntelligenceEnabled}
                saveIdentity={saveIdentity}
                savingConfig={savingConfig}
                toggleAgentActive={toggleAgentActive}

                calendarEnabled={calendarEnabled} setCalendarEnabled={setCalendarEnabled}
                googleJson={googleJson} setGoogleJson={setGoogleJson}
                onTestGoogle={testGoogleConnection} testingGoogle={testingGoogle}
                isCalendarConnected={isCalendarConnected}
                calendarConnectedEmail={calendarConnectedEmail}
                onDisconnectGoogle={disconnectGoogle}
                calendarDefaultDuration={calendarDefaultDuration} setCalendarDefaultDuration={setCalendarDefaultDuration}
                calendarGenerateMeet={calendarGenerateMeet} setCalendarGenerateMeet={setCalendarGenerateMeet}
                calendarSendMeetLink={calendarSendMeetLink} setCalendarSendMeetLink={setCalendarSendMeetLink}
                calendarOptionalFields={calendarOptionalFields} setCalendarOptionalFields={setCalendarOptionalFields}
                calendarAutoCapture={calendarAutoCapture} setCalendarAutoCapture={setCalendarAutoCapture}
                saveCalendarConfig={saveCalendarConfig}
                isScheduler={isScheduler} setIsScheduler={setIsScheduler}
                reminders={reminders} setReminders={setReminders}
                autoPromoteAfter={autoPromoteAfter} setAutoPromoteAfter={setAutoPromoteAfter}
                autoPromoteDisabled={autoPromoteDisabled} setAutoPromoteDisabled={setAutoPromoteDisabled}
                notifyOwner={notifyOwner} setNotifyOwner={setNotifyOwner}
                ownerPhone={ownerPhone} setOwnerPhone={setOwnerPhone}
                ownerSummaryEnabled={ownerSummaryEnabled} setOwnerSummaryEnabled={setOwnerSummaryEnabled}
                ownerSummaryPrompt={ownerSummaryPrompt} setOwnerSummaryPrompt={setOwnerSummaryPrompt}
                ownerSummaryModel={ownerSummaryModel} setOwnerSummaryModel={setOwnerSummaryModel}
                autoPromoteFrom={autoPromoteFrom} setAutoPromoteFrom={setAutoPromoteFrom}
                autoPromoteTo={autoPromoteTo} setAutoPromoteTo={setAutoPromoteTo}
                pauseAfterSchedule={pauseAfterSchedule} setPauseAfterSchedule={setPauseAfterSchedule}
                kanbanColumns={kanbanColumns}

                webhookUrl={webhookUrl}
                onSyncWebhook={onSyncWebhook}

                prompt={prompt} setPrompt={setPrompt}
                promptRef={promptRef}
                insertVariable={insertVariable}
                insertKbVariable={insertKbVariable}
                savePrompt={savePrompt}
                knowledge={knowledge}

                previewSample={previewSample} setPreviewSample={setPreviewSample}
                previewOpen={previewOpen} setPreviewOpen={setPreviewOpen}
                previewLeads={previewLeads} previewLeadsLoading={previewLeadsLoading}
                loadPreviewLeads={loadPreviewLeads}
                previewSelectedLeadId={previewSelectedLeadId}
                applyLeadToSample={applyLeadToSample}
                previewLeadQuery={previewLeadQuery} setPreviewLeadQuery={setPreviewLeadQuery}

                showNovoK={showNovoK} setShowNovoK={setShowNovoK}
                novoKTitle={novoKTitle} setNovoKTitle={setNovoKTitle}
                novoKContent={novoKContent} setNovoKContent={setNovoKContent}
                salvarNovoKnowledge={salvarNovoKnowledge}
                editKId={editKId}
                editKTitle={editKTitle} setEditKTitle={setEditKTitle}
                editKContent={editKContent} setEditKContent={setEditKContent}
                iniciarEdicaoKnowledge={iniciarEdicaoKnowledge}
                cancelarEdicaoKnowledge={cancelarEdicaoKnowledge}
                salvarEdicaoKnowledge={salvarEdicaoKnowledge}
                deletarKnowledge={deletarKnowledge}
                sitePreviewAutoDetect={sitePreviewAutoDetect}
                setSitePreviewAutoDetect={setSitePreviewAutoDetect}
                sitePreviewConfirmBeforeLink={sitePreviewConfirmBeforeLink}
                setSitePreviewConfirmBeforeLink={setSitePreviewConfirmBeforeLink}
                sitePreviewEvalPrompt={sitePreviewEvalPrompt}
                setSitePreviewEvalPrompt={setSitePreviewEvalPrompt}
                sitePreviewPingMessage={sitePreviewPingMessage}
                setSitePreviewPingMessage={setSitePreviewPingMessage}
                sitePreviewEvalModel={sitePreviewEvalModel}
                setSitePreviewEvalModel={setSitePreviewEvalModel}
              />
            )}

            {activeTab === "ajustes" && (
              <AjustesTab
                is24h={is24h} setIs24h={setIs24h}
                schedules={schedules} setSchedules={setSchedules}
                awayMessage={awayMessage} setAwayMessage={setAwayMessage}
                disableGroups={disableGroups} setDisableGroups={setDisableGroups}
                transcriptionMethod={transcriptionMethod} setTranscriptionMethod={setTranscriptionMethod}
                agentId={activeAgentId}
                onSave={saveSchedules}
                saving={savingConfig}
              />
            )}

            {activeTab === "etapas" && (
              <EtapasTab
                stages={stages} setStages={setStages}
                showNovoStage={showNovoStage} setShowNovoStage={setShowNovoStage}
                novoStageTitle={novoStageTitle} setNovoStageTitle={setNovoStageTitle}
                novoStagePrompt={novoStagePrompt} setNovoStagePrompt={setNovoStagePrompt}
                onCreateStage={salvarNovoStage}
                onDeleteStage={deletarStage}
                onReorder={reorderStages}
                onSaveStage={saveStage}
              />
            )}

            {activeTab === "testes" && (
              <TestesTab
                previewSample={previewSample} setPreviewSample={setPreviewSample}
                previewLeads={previewLeads} previewLeadsLoading={previewLeadsLoading}
                loadPreviewLeads={loadPreviewLeads}
                previewSelectedLeadId={previewSelectedLeadId}
                applyLeadToSample={applyLeadToSample}
                previewLeadQuery={previewLeadQuery} setPreviewLeadQuery={setPreviewLeadQuery}

                sandboxTemplate={sandboxTemplate} setSandboxTemplate={setSandboxTemplate}
                sandboxPersonalizeAI={sandboxPersonalizeAI} setSandboxPersonalizeAI={setSandboxPersonalizeAI}
                sandboxAiPrompt={sandboxAiPrompt} setSandboxAiPrompt={setSandboxAiPrompt}
                sandboxUseWebSearch={sandboxUseWebSearch} setSandboxUseWebSearch={setSandboxUseWebSearch}
                sandboxSimulating={sandboxSimulating}
                sandboxSimulationEnabled={sandboxSimulationEnabled} setSandboxSimulationEnabled={setSandboxSimulationEnabled}
                simulateInitialMessage={simulateInitialMessage}
                targetModel={targetModel}

                nomeAgente={nomeAgente}
                humanizeMessages={humanizeMessages}
                messageBufferSeconds={messageBufferSeconds}
                typingDelayMode={typingDelayMode}
                typingDelaySeconds={typingDelaySeconds}
                typingDelayMinSeconds={typingDelayMinSeconds}
                typingDelayMaxSeconds={typingDelayMaxSeconds}
                customGoalEnabled={customGoalEnabled}
                customGoalText={customGoalText}
                testCustomGoalPaused={testCustomGoalPaused}
                onResumeTestAi={resumeTestAi}
                testIsTyping={testIsTyping}
                testTypingSeconds={testTypingSeconds}
                testMessages={testMessages}
                testInput={testInput} setTestInput={setTestInput}
                testLoading={testLoading}
                handleTestSubmit={handleTestSubmit}
                clearTestSession={clearTestSession}

                stages={stages}
                testStageIndex={testStageIndex}
                testSkippedStages={testSkippedStages}
                testVariables={testVariables}
              />
            )}

            {activeTab === "logs" && (
              <LogsTab
                webhookLogs={webhookLogs}
                setWebhookLogs={setWebhookLogs}
                expandedLogs={expandedLogs}
                toggleLog={toggleLog}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

/* ====================================================================
   TabsNav — barra de tabs no topo da área de conteúdo. Pequeno o
   suficiente pra ficar inline, grande o suficiente pra merecer um nome.
==================================================================== */
function TabsNav({ active, onChange, showAdvanced, onToggleAdvanced }: {
  active: Tab;
  onChange: (t: Tab) => void;
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
}) {
  const tabs: Array<{ id: Tab; icon: LucideIcon; label: string; advancedOnly?: boolean }> = [
    { id: "info",    icon: Info,         label: "Informações" },
    { id: "ajustes", icon: Settings,     label: "Ajustes" },
    { id: "etapas",  icon: ListTree,     label: "Etapas", advancedOnly: true },
    { id: "testes",  icon: FlaskConical, label: "Testes" },
    { id: "logs",    icon: Activity,     label: "Logs", advancedOnly: true },
  ];
  const visible = tabs.filter((t) => !t.advancedOnly || showAdvanced);

  return (
    <nav aria-label="Abas de configuração do agente" className="space-y-3">
      <div className="flex items-start sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">Configure seu agente</h2>
          <p className="text-sm text-muted-foreground mt-1 hidden sm:block">Defina o atendimento, ajuste os horários e teste as respostas.</p>
        </div>
        <button
          type="button"
          onClick={onToggleAdvanced}
          aria-pressed={showAdvanced}
          title={showAdvanced ? "Ocultar abas avançadas (Etapas e Logs)" : "Mostrar abas avançadas (Etapas e Logs)"}
          className={cn(
            "inline-flex shrink-0 min-h-11 items-center gap-2 px-3 rounded-lg text-xs font-medium border transition-colors",
            showAdvanced ? "bg-primary/10 border-primary/30 text-primary" : "border-white/10 text-muted-foreground hover:text-foreground hover:bg-white/5"
          )}
        >
          <Settings className="w-3.5 h-3.5" aria-hidden="true" />
          {showAdvanced ? "Ocultar avançado" : "Avançado"}
        </button>
      </div>
      <div className="flex gap-1 overflow-x-auto min-w-0 border-b border-white/10 pb-px">
        {visible.map((t) => {
          const Icon = t.icon;
          const isActive = active === t.id;
          return (
            <button
              key={t.id}
              type="button"
              aria-current={isActive ? "page" : undefined}
              onClick={() => onChange(t.id)}
              className={cn(
                "flex min-h-12 shrink-0 items-center gap-2 px-3 sm:px-4 py-2.5 text-sm font-medium rounded-t-lg whitespace-nowrap transition-colors border-b-2 -mb-px",
                isActive
                  ? "border-primary bg-primary/5 text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:bg-white/[0.03]"
              )}
            >
              <Icon className="w-4 h-4" aria-hidden="true" />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
