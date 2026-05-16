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
import { renderTemplate } from "@/lib/template-vars";
import { cn } from "@/lib/utils";
import { useClientSession } from "@/lib/use-session";
import { Activity, FlaskConical, Info, ListTree, Settings } from "lucide-react";

import { AgentSwitcher } from "./_components/agent-switcher";
import type { PreviewLead, PreviewSample } from "./_components/lead-selector";
import { AjustesTab, type ScheduleRow } from "./_tabs/ajustes-tab";
import { EtapasTab } from "./_tabs/etapas-tab";
import { InfoTab } from "./_tabs/info-tab";
import { LogsTab } from "./_tabs/logs-tab";
import { TestesTab } from "./_tabs/testes-tab";

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

  // ============= AGENTES (lista + atual) =============
  const [activeAgentId, setActiveAgentId] = useState<number>(1);
  const [agentsList, setAgentsList] = useState<any[]>([]);

  // ============= IDENTIDADE DO AGENTE =============
  const [isActiveAgente, setIsActiveAgente] = useState(true);
  const [nomeAgente, setNomeAgente] = useState("Sarah SDR");
  const [funcaoAgente, setFuncaoAgente] = useState("");
  const [personalidadeAgente, setPersonalidadeAgente] = useState("");
  const [tomAgente, setTomAgente] = useState("");
  const [targetModel, setTargetModel] = useState("gemini-1.5-flash");
  const [modelOptions, setModelOptions] = useState<any[]>([]);
  const [appUrl, setAppUrl] = useState("");
  const [savingConfig, setSavingConfig] = useState(false);
  const [loadingConfig, setLoadingConfig] = useState(true);

  // ============= INSTÂNCIA VINCULADA =============
  const [vinculoInstance, setVinculoInstance] = useState("");
  const [savingVinculo, setSavingVinculo] = useState(false);
  const [allInstances, setAllInstances] = useState<string[]>([]);

  // ============= COMPORTAMENTO =============
  const [messageBufferSeconds, setMessageBufferSeconds] = useState(0);
  const [humanizeMessages, setHumanizeMessages] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  // Lead Intelligence é POR AGENTE — não é mais um flag global da campanha/automação.
  // Cliente quer ativar só nos agentes que precisam de análise profunda do lead.
  const [leadIntelligenceEnabled, setLeadIntelligenceEnabled] = useState(false);

  // ============= GOOGLE CALENDAR =============
  const [calendarEnabled, setCalendarEnabled] = useState(false);
  const [googleJson, setGoogleJson] = useState("");
  const [googleTokens, setGoogleTokens] = useState<any>(null);
  const [calendarGenerateMeet, setCalendarGenerateMeet] = useState(false);
  const [calendarDefaultDuration, setCalendarDefaultDuration] = useState<number>(30);
  const [calendarOptionalFields, setCalendarOptionalFields] = useState<Record<string, boolean>>({});
  const [calendarAutoCapture, setCalendarAutoCapture] = useState({ telefone: true, empresa: true, necessidade: true });

  // ============= PROMPT =============
  const [prompt, setPrompt] = useState("");
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  // ============= PRÉ-VISUALIZAÇÃO DO PROMPT =============
  const [previewOpen, setPreviewOpen] = useState(true);
  const [previewSample, setPreviewSample] = useState<PreviewSample>({
    nome_negocio: "Padaria Centro",
    ramo_negocio: "Alimentação",
    push_name:    "João",
    telefone:     "11999998888",
    endereco:     "Rua A, 123 - Centro",
    categoria:    "Padaria",
    website:      "padariacentro.com.br",
  });
  const [previewLeads, setPreviewLeads] = useState<PreviewLead[]>([]);
  const [previewLeadsLoading, setPreviewLeadsLoading] = useState(false);
  const [previewSelectedLeadId, setPreviewSelectedLeadId] = useState<number | null>(null);
  const [previewLeadQuery, setPreviewLeadQuery] = useState("");

  // ============= BASE DE CONHECIMENTO =============
  const [knowledge, setKnowledge] = useState<any[]>([]);
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

  // ============= ETAPAS DO FUNIL =============
  const [stages, setStages] = useState<any[]>([]);
  const [novoStageTitle, setNovoStageTitle] = useState("");
  const [novoStagePrompt, setNovoStagePrompt] = useState("");
  const [showNovoStage, setShowNovoStage] = useState(false);

  // ============= CUSTOM TOOLS (loaded; UI ainda não exposta nessa refatoração) =============
  const [customTools, setCustomTools] = useState<any[]>([]);

  // ============= TESTES (SANDBOX) =============
  const [testMessages, setTestMessages] = useState<any[]>([]);
  const [testInput, setTestInput] = useState("");
  const [testLoading, setTestLoading] = useState(false);
  const [testVariables, setTestVariables] = useState<Record<string, string>>({});
  const [testStageIndex, setTestStageIndex] = useState(0);
  const [testSkippedStages, setTestSkippedStages] = useState<number[]>([]);
  const testBufferTimerRef = useRef<NodeJS.Timeout | null>(null);
  const testMessageBufferRef = useRef<string[]>([]);
  const testMessagesStateRef = useRef<any[]>([]);

  // ============= TESTES (DISPARO INICIAL) =============
  const [sandboxTemplate, setSandboxTemplate] = useState("Olá {{nome_negocio}}, vi que vocês são do ramo de {{ramo_negocio}}...");
  const [sandboxPersonalizeAI, setSandboxPersonalizeAI] = useState(false);
  const [sandboxAiPrompt, setSandboxAiPrompt] = useState(DEFAULT_SANDBOX_AI_PROMPT);
  const [sandboxUseWebSearch, setSandboxUseWebSearch] = useState(false);
  const [sandboxSimulating, setSandboxSimulating] = useState(false);

  // ============= LOGS =============
  const [webhookLogs, setWebhookLogs] = useState<any[]>([]);
  const [expandedLogs, setExpandedLogs] = useState<number[]>([]);

  // ============= APP URL DETECTADO NO BROWSER =============
  // Evita hydration mismatch — só popula depois do mount.
  const [browserOrigin, setBrowserOrigin] = useState("");
  useEffect(() => { setBrowserOrigin(window.location.origin); }, []);
  const webhookBase = appUrl || browserOrigin;
  const webhookUrl = useMemo(
    () => webhookBase
      ? `${webhookBase}/api/webhooks/whatsapp?agentId=${activeAgentId || 1}`
      : `/api/webhooks/whatsapp?agentId=${activeAgentId || 1}`,
    [webhookBase, activeAgentId]
  );

  /* ====================================================================
     LOAD AGENTE — pega tudo que pertence ao agente atual num só lugar.
  ==================================================================== */
  const loadAgent = useCallback(async (id: number) => {
    setLoadingConfig(true);
    // As 4 queries não dependem entre si — paralelizamos com Promise.all e
    // limpamos o spinner no finally pra não ter race do `setLoadingConfig(false)`
    // disparar antes da última callback (bug do código original).
    if (!clientId) return;
    try {
      const [settings, kb, conn, stagesRes] = await Promise.all([
        supabase.from("agent_settings").select("*").eq("id", id).eq("client_id", clientId).single(),
        supabase.from("agent_knowledge").select("*").eq("agent_id", id).eq("client_id", clientId).order("created_at"),
        supabase.from("channel_connections")
          .select("instance_name, created_at")
          .eq("agent_id", id)
          .eq("client_id", clientId)
          .order("created_at", { ascending: true })
          .limit(1),
        supabase.from("agent_stages").select("*").eq("agent_id", id).eq("client_id", clientId).order("order_index"),
      ]);

      if (settings.data) {
        const data = settings.data;
        setNomeAgente(data.name || "");
        setFuncaoAgente(data.role || "");
        setPersonalidadeAgente(data.personality || "");
        setTomAgente(data.tone || "");
        setPrompt(data.main_prompt || "");
        setSchedules(data.schedules || []);
        setTargetModel(data.target_model || "gemini-1.5-flash");
        setIsActiveAgente(data.is_active ?? true);
        setIs24h(data.is_24h ?? false);
        setAwayMessage(data.away_message || "");

        const opts = data.options || {};
        setAppUrl(opts.app_url || "");
        setGoogleJson(opts.google_credentials || "");
        setGoogleTokens(opts.google_tokens || null);
        setCalendarGenerateMeet(opts.calendar_generate_meet ?? false);
        setCalendarEnabled(opts.calendar_enabled ?? false);
        setCalendarDefaultDuration(Number(opts.calendar_default_duration) || 30);
        setCalendarOptionalFields(opts.calendar_optional_fields || {});
        setCalendarAutoCapture({
          telefone:    opts.calendar_auto_capture?.telefone    ?? true,
          empresa:     opts.calendar_auto_capture?.empresa     ?? true,
          necessidade: opts.calendar_auto_capture?.necessidade ?? true,
        });
        setCustomTools(opts.custom_tools || []);
        setMessageBufferSeconds(opts.message_buffer_seconds || 0);
        setHumanizeMessages(opts.humanize_messages ?? false);
        setWebSearchEnabled(opts.web_search_enabled ?? false);
        // Lead Intelligence vem da coluna dedicada na tabela (não do JSONB options),
        // pra worker/automation conseguirem ler com SELECT simples.
        setLeadIntelligenceEnabled((data as any).lead_intelligence_enabled ?? false);
      }
      if (kb.data) setKnowledge(kb.data);
      setVinculoInstance(conn.data?.[0]?.instance_name || "");
      if (stagesRes.data) setStages(stagesRes.data);
    } finally {
      setLoadingConfig(false);
    }
  }, [clientId]);

  /* ====================================================================
     VINCULAR INSTÂNCIA — com checagem de conflito (instância já vinculada
     a outro agente). Sem isso, um agente novo "rouba" a instância de outro
     silenciosamente.
  ==================================================================== */
  const saveVinculoInstant = useCallback(async (instanceName: string) => {
    if (!instanceName || !activeAgentId) return;
    setSavingVinculo(true);
    try {
      const { data: existing } = await supabase
        .from("channel_connections")
        .select("agent_id, instance_name")
        .eq("instance_name", instanceName)
        .maybeSingle();

      if (existing && existing.agent_id && existing.agent_id !== activeAgentId) {
        const otherAgent = agentsList.find((a) => a.id === existing.agent_id);
        const otherName = otherAgent?.name ? `${otherAgent.name} (ID ${existing.agent_id})` : `agente ID ${existing.agent_id}`;
        const ok = window.confirm(
          `A instância "${instanceName}" já está vinculada ao ${otherName}.\n\n` +
          `Vincular ela a este agente vai TIRAR essa instância do outro agente — ` +
          `o outro agente ficará sem instância e parará de receber mensagens.\n\n` +
          `Quer continuar?`
        );
        if (!ok) {
          // Reverte a UI pro vínculo anterior do agente atual
          const { data: revert } = await supabase
            .from("channel_connections")
            .select("instance_name")
            .eq("agent_id", activeAgentId)
            .order("created_at", { ascending: true })
            .limit(1);
          setVinculoInstance(revert?.[0]?.instance_name || "");
          return;
        }
      }

      // Vincula (upsert) e limpa OUTRAS instâncias antigas do mesmo agente
      const { error: e1 } = await supabase
        .from("channel_connections")
        .upsert({ 
          instance_name: instanceName, 
          agent_id: activeAgentId, 
          client_id: clientId,
          status: "open" 
        }, { onConflict: "instance_name" });
      if (e1) throw e1;

      const { error: e2 } = await supabase
        .from("channel_connections")
        .delete()
        .eq("agent_id", activeAgentId)
        .neq("instance_name", instanceName);
      if (e2) console.warn("[VINCULO] Erro ao limpar instâncias antigas:", e2.message);
    } catch (err: any) {
      alert("Erro ao vincular instância: " + err.message);
    } finally {
      setSavingVinculo(false);
    }
  }, [activeAgentId, agentsList]);

  /* ====================================================================
     EFFECTS de boot — corre uma vez no mount.
  ==================================================================== */
  useEffect(() => {
    if (clientId) {
      const saved = localStorage.getItem(`sdr_active_agent_id_${clientId}`);
      if (saved) setActiveAgentId(Number(saved));
    }

    if (!clientId) return;
    (async () => {
      supabase.from("ai_organizer_config").select("*").eq("id", 1).single().then(({ data }) => {
        if (data?.app_url) setAppUrl(data.app_url);
      });

      supabase.from("agent_settings").select("id, name").eq("client_id", clientId).order("id").then(({ data }) => {
        if (data && data.length > 0) {
          setAgentsList(data);
          const agentExists = data.some((a) => a.id === activeAgentId);
          const idToLoad = agentExists ? activeAgentId : data[0].id;
          if (!agentExists) setActiveAgentId(data[0].id);
          loadAgent(idToLoad);
        }
      });

      supabase.from("channel_connections").select("instance_name").eq("client_id", clientId).then(({ data }) => {
        if (data) {
          const names = Array.from(new Set(data.map((i) => i.instance_name as string))).filter(Boolean);
          setAllInstances(names);
        }
      });

      // Instâncias da Evolution API (caso tenha alguma que o banco não conhece ainda)
      // O endpoint /api/whatsapp já filtra por client_id no backend.
      fetch("/api/whatsapp")
        .then((r) => r.json())
        .then((data) => {
          if (!data.instances) return;
          const evoNames = data.instances
            .map((i: any) => i.instanceName || i.instance_name)
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

    // Multi-tenant: cliente só vê logs das próprias instâncias.
    // Admin (clientId = id do admin) vê apenas os logs do escopo dele.
    {
      let wlQ = supabase.from("webhook_logs").select("*").order("created_at", { ascending: false }).limit(20);
      if (clientId) wlQ = wlQ.eq("client_id", clientId);
      wlQ.then(({ data }) => { if (data) setWebhookLogs(data); });
    }

    const channel = supabase.channel("webhook_logs_realtime")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "webhook_logs" }, (payload) => {
        setWebhookLogs((prev) => {
          // Dedup por id — evita o caso onde o INSERT echo do realtime chega depois
          // do load inicial e duplica o log na UI.
          const incoming = payload.new as any;
          if (incoming?.id && prev.some((l) => l.id === incoming.id)) return prev;
          return [incoming, ...prev].slice(0, 20);
        });
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
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
     SAVE handlers — todos chamam supabase.update com o subset relevante.
  ==================================================================== */
  const saveIdentity = async () => {
    if (!activeAgentId) return;
    setSavingConfig(true);
    const { data: current } = await supabase.from("agent_settings").select("options").eq("id", activeAgentId).single();
    const { error } = await supabase.from("agent_settings").update({
      name: nomeAgente, role: funcaoAgente, personality: personalidadeAgente, tone: tomAgente, target_model: targetModel,
      options: {
        ...current?.options,
        app_url: appUrl,
        message_buffer_seconds: messageBufferSeconds,
        humanize_messages: humanizeMessages,
        web_search_enabled: webSearchEnabled,
      },
      // Coluna dedicada (não JSONB) — workers/backend filtram via WHERE
      lead_intelligence_enabled: leadIntelligenceEnabled,
    }).eq("id", activeAgentId).eq("client_id", clientId);
    setSavingConfig(false);
    if (!error) alert("Identidade salva!"); else alert("Erro: " + error.message);
  };

  const savePrompt = async () => {
    if (!activeAgentId) return;
    setSavingConfig(true);
    const { error } = await supabase.from("agent_settings").update({ main_prompt: prompt }).eq("id", activeAgentId).eq("client_id", clientId);
    setSavingConfig(false);
    if (!error) alert("Prompt salvo!"); else alert("Erro: " + error.message);
  };

  const saveSchedules = async () => {
    if (!activeAgentId) return;
    setSavingConfig(true);
    const { error } = await supabase.from("agent_settings").update({ schedules, is_24h: is24h, away_message: awayMessage }).eq("id", activeAgentId).eq("client_id", clientId);
    setSavingConfig(false);
    if (!error) alert("Horários salvos!"); else alert("Erro: " + error.message);
  };

  const saveCalendarConfig = async () => {
    if (!activeAgentId) return;
    setSavingConfig(true);
    const { data: current } = await supabase.from("agent_settings").select("options").eq("id", activeAgentId).single();
    const { error } = await supabase.from("agent_settings").update({
      options: {
        ...current?.options,
        calendar_enabled: calendarEnabled,
        calendar_generate_meet: calendarGenerateMeet,
        calendar_default_duration: calendarDefaultDuration,
        calendar_optional_fields: calendarOptionalFields,
        calendar_auto_capture: calendarAutoCapture,
      },
    }).eq("id", activeAgentId).eq("client_id", clientId);
    setSavingConfig(false);
    if (!error) alert("Agenda salva!"); else alert("Erro: " + error.message);
  };

  const toggleAgentActive = async () => {
    const nv = !isActiveAgente;
    setIsActiveAgente(nv);
    await supabase.from("agent_settings").update({ is_active: nv }).eq("id", activeAgentId);
  };

  /* ====================================================================
     KNOWLEDGE BASE CRUD
  ==================================================================== */
  const salvarNovoKnowledge = async () => {
    if (!activeAgentId || !novoKTitle || !novoKContent) return;
    const { error } = await supabase.from("agent_knowledge").insert({
      agent_id: activeAgentId, title: novoKTitle, content: novoKContent,
    });
    if (!error) {
      setNovoKTitle(""); setNovoKContent(""); setShowNovoK(false);
      loadAgent(activeAgentId);
    } else alert("Erro: " + error.message);
  };

  const deletarKnowledge = async (kid: string) => {
    if (!confirm("Excluir base de conhecimento?")) return;
    const { error } = await supabase.from("agent_knowledge").delete().eq("id", kid);
    if (!error) loadAgent(activeAgentId);
  };

  const iniciarEdicaoKnowledge = (k: any) => {
    setEditKId(k.id);
    setEditKTitle(k.title || "");
    setEditKContent(k.content || "");
  };

  const cancelarEdicaoKnowledge = () => {
    setEditKId(null); setEditKTitle(""); setEditKContent("");
  };

  const salvarEdicaoKnowledge = async () => {
    if (!editKId || !editKTitle.trim()) return;
    const { error } = await supabase.from("agent_knowledge")
      .update({ title: editKTitle.trim(), content: editKContent })
      .eq("id", editKId);
    if (!error) {
      cancelarEdicaoKnowledge();
      loadAgent(activeAgentId);
    } else alert("Erro: " + error.message);
  };

  /* ====================================================================
     STAGES (ETAPAS DO FUNIL)
  ==================================================================== */
  const salvarNovoStage = async () => {
    if (!activeAgentId || !novoStageTitle) return;
    const { error } = await supabase.from("agent_stages").insert({
      agent_id: activeAgentId, title: novoStageTitle, goal_prompt: novoStagePrompt, order_index: stages.length,
    });
    if (!error) {
      setNovoStageTitle(""); setNovoStagePrompt(""); setShowNovoStage(false);
      loadAgent(activeAgentId);
    }
  };

  const deletarStage = async (sid: string) => {
    if (!confirm("Excluir esta etapa?")) return;
    const { error } = await supabase.from("agent_stages").delete().eq("id", sid);
    if (!error) loadAgent(activeAgentId);
  };

  const reorderStages = async (newStages: any[]) => {
    const updates = newStages.map((s, i) => ({ ...s, order_index: i }));
    await Promise.all(
      updates.map((st) =>
        supabase.from("agent_stages").update({ order_index: st.order_index }).eq("id", st.id)
      )
    );
  };

  const saveStage = async (stage: any) => {
    const { error } = await supabase.from("agent_stages").update({
      goal_prompt: stage.goal_prompt,
      condition_variable: stage.condition_variable,
      condition_operator: stage.condition_operator,
      condition_value: stage.condition_value,
      captured_variables: stage.captured_variables || [],
    }).eq("id", stage.id);
    if (error) alert("Erro ao salvar etapa: " + error.message);
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
      const sessRes = await fetch("/api/auth/session");
      const session = await sessRes.json();
      
      let query = supabase
        .from("leads_extraidos")
        .select('id, "remoteJid", nome_negocio, ramo_negocio, categoria, endereco, website, telefone')
        .order("created_at", { ascending: false })
        .limit(500);
      if (session?.clientId) {
        query = query.eq("client_id", session.clientId);
      }
      const { data } = await query;
      setPreviewLeads((data || []) as any);
    } finally {
      setPreviewLeadsLoading(false);
    }
  }, []);

  const applyLeadToSample = (lead: PreviewLead | null) => {
    if (!lead) return;
    setPreviewSelectedLeadId(lead.id);
    setPreviewSample({
      nome_negocio: lead.nome_negocio || "",
      ramo_negocio: lead.ramo_negocio || "",
      push_name:    "",
      telefone:     lead.telefone || (lead.remoteJid || "").replace(/@.*$/, "").replace(/\D/g, ""),
      endereco:     lead.endereco || "",
      categoria:    lead.categoria || "",
      website:      lead.website || "",
    });
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
    } catch (e: any) {
      alert("Erro ao sincronizar: " + e.message);
    }
  };

  /* ====================================================================
     SANDBOX — disparo inicial e chat de testes (com buffer humanizado).
  ==================================================================== */
  const simulateInitialMessage = async () => {
    if (!sandboxTemplate.trim()) return;
    setSandboxSimulating(true);
    try {
      const baseMessage = renderTemplate(sandboxTemplate, previewSample as any);
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

      const agentMessage = { role: "agent", content: finalMessage };
      setTestMessages([agentMessage]);
      setTestVariables({});
      setTestStageIndex(0);
      setTestSkippedStages([]);
      try { localStorage.setItem(`sdr_test_messages_${activeAgentId}`, JSON.stringify([agentMessage])); } catch {}
    } catch (e: any) {
      alert("Erro ao simular: " + e.message);
    } finally {
      setSandboxSimulating(false);
    }
  };

  const processSandboxQueue = async () => {
    if (testMessageBufferRef.current.length === 0) return;

    const consolidatedText = testMessageBufferRef.current.join("\\n");
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
          testState: { variables: testVariables, currentStageIndex: testStageIndex, skippedStages: testSkippedStages },
          testLeadData: previewSample,
        }),
      });
      const data = await res.json();

      if (!data.success || data.error) {
        setTestMessages((prev) => [...prev, { role: "agent", isError: true, content: `❌ ${data.error || "Erro desconhecido no servidor."}` }]);
        return;
      }

      const toolLogs: any[] = Array.isArray(data.logs) ? data.logs : [];

      if (data.testStateUpdate) {
        if (data.testStateUpdate.variables) setTestVariables(data.testStateUpdate.variables);
        if (data.testStateUpdate.currentStageIndex !== undefined) setTestStageIndex(data.testStateUpdate.currentStageIndex);
        if (data.testStateUpdate.skippedStages) setTestSkippedStages(data.testStateUpdate.skippedStages);
      }

      const chunks: string[] = Array.isArray(data.chunks) && data.chunks.length > 0
        ? data.chunks
        : [data.text || "[Sem retorno]"];

      setTestMessages((prev) => [
        ...prev,
        ...toolLogs.map((l: any) => ({ role: "tool", content: l.content || JSON.stringify(l) })),
      ]);

      for (let i = 0; i < chunks.length; i++) {
        if (i > 0) {
          const typingSeconds = Math.min(Math.max(chunks[i].length / 15, 1.5), 4);
          await new Promise((r) => setTimeout(r, typingSeconds * 1000));
        }
        setTestMessages((prev) => [...prev, { role: "agent", content: chunks[i] }]);
      }
    } catch (e: any) {
      setTestMessages((prev) => [...prev, { role: "agent", isError: true, content: `❌ Falha ao contatar servidor: ${e.message}` }]);
    } finally {
      setTestLoading(false);
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
        newPrev[newPrev.length - 1] = { ...newPrev[newPrev.length - 1], content: newPrev[newPrev.length - 1].content + "\\n\\n" + currentInput };
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
    try { localStorage.removeItem(`sdr_test_messages_${activeAgentId}`); } catch {}
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
    <div className="flex flex-col h-[100dvh] max-h-[100dvh] bg-background overflow-hidden selection:bg-primary/30 text-white">
      <Header />

      <main className="flex-1 overflow-y-auto w-full">
        <AgentSwitcher
          activeAgentId={activeAgentId}
          agentsList={agentsList}
          setAgentsList={setAgentsList}
          setActiveAgentId={setActiveAgentId}
          loadAgent={loadAgent}
          clientId={clientId}
        />

        <div className="max-w-6xl mx-auto p-3 sm:p-8 space-y-4 sm:space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 mobile-safe-bottom">
          {/* Tabs nav */}
          <TabsNav active={activeTab} onChange={setActiveTab} />

          <div className="space-y-12 pb-8 mobile-safe-bottom">
            {activeTab === "info" && (
              <InfoTab
                nomeAgente={nomeAgente} setNomeAgente={setNomeAgente}
                funcaoAgente={funcaoAgente} setFuncaoAgente={setFuncaoAgente}
                personalidadeAgente={personalidadeAgente} setPersonalidadeAgente={setPersonalidadeAgente}
                tomAgente={tomAgente} setTomAgente={setTomAgente}
                isActiveAgente={isActiveAgente} setIsActiveAgente={setIsActiveAgente}
                targetModel={targetModel} setTargetModel={setTargetModel}
                modelOptions={modelOptions}
                appUrl={appUrl} setAppUrl={setAppUrl}
                vinculoInstance={vinculoInstance} setVinculoInstance={setVinculoInstance}
                allInstances={allInstances}
                savingVinculo={savingVinculo}
                onSaveVinculo={saveVinculoInstant}
                messageBufferSeconds={messageBufferSeconds} setMessageBufferSeconds={setMessageBufferSeconds}
                humanizeMessages={humanizeMessages} setHumanizeMessages={setHumanizeMessages}
                webSearchEnabled={webSearchEnabled} setWebSearchEnabled={setWebSearchEnabled}
                leadIntelligenceEnabled={leadIntelligenceEnabled} setLeadIntelligenceEnabled={setLeadIntelligenceEnabled}
                saveIdentity={saveIdentity}
                savingConfig={savingConfig}
                toggleAgentActive={toggleAgentActive}

                calendarEnabled={calendarEnabled} setCalendarEnabled={setCalendarEnabled}
                googleJson={googleJson} setGoogleJson={setGoogleJson}
                calendarDefaultDuration={calendarDefaultDuration} setCalendarDefaultDuration={setCalendarDefaultDuration}
                calendarGenerateMeet={calendarGenerateMeet} setCalendarGenerateMeet={setCalendarGenerateMeet}
                calendarOptionalFields={calendarOptionalFields} setCalendarOptionalFields={setCalendarOptionalFields}
                calendarAutoCapture={calendarAutoCapture} setCalendarAutoCapture={setCalendarAutoCapture}
                saveCalendarConfig={saveCalendarConfig}

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
              />
            )}

            {activeTab === "ajustes" && (
              <AjustesTab
                is24h={is24h} setIs24h={setIs24h}
                schedules={schedules} setSchedules={setSchedules}
                awayMessage={awayMessage} setAwayMessage={setAwayMessage}
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
                simulateInitialMessage={simulateInitialMessage}
                targetModel={targetModel}

                nomeAgente={nomeAgente}
                humanizeMessages={humanizeMessages}
                messageBufferSeconds={messageBufferSeconds}
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
function TabsNav({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  const tabs: Array<{ id: Tab; icon: any; label: string; shortLabel?: string }> = [
    { id: "info",    icon: Info,         label: "Informações", shortLabel: "Info" },
    { id: "ajustes", icon: Settings,     label: "Ajustes" },
    { id: "etapas",  icon: ListTree,     label: "Etapas" },
    { id: "testes",  icon: FlaskConical, label: "Testes" },
    { id: "logs",    icon: Activity,     label: "Logs" },
  ];

  return (
    <div className="flex bg-white/5 border border-white/10 p-1 rounded-2xl mobile-tabs-scroll shadow-inner">
      {tabs.map((t) => {
        const Icon = t.icon;
        const isActive = active === t.id;
        return (
          <button
            key={t.id}
            onClick={() => onChange(t.id)}
            className={cn(
              "flex items-center gap-1.5 sm:gap-2 px-3 sm:px-5 py-2 sm:py-2.5 text-xs sm:text-sm font-bold rounded-xl transition-all whitespace-nowrap",
              isActive ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20" : "text-muted-foreground hover:text-white hover:bg-white/5"
            )}
          >
            <Icon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            {t.shortLabel ? (
              <>
                <span className="hidden sm:inline">{t.label}</span>
                <span className="sm:hidden">{t.shortLabel}</span>
              </>
            ) : (
              <span>{t.label}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
