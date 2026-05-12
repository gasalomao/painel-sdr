"use client";

import { useState, useEffect, useCallback, useRef, useMemo, Fragment } from "react";
import { Header } from "@/components/layout/header";
import { supabase } from "@/lib/supabase";
import { renderTemplate, TEMPLATE_VARIABLES, greetingFor } from "@/lib/template-vars";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NumberInput } from "@/components/ui/number-input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  Info,
  Settings,
  ListTree,
  FlaskConical,
  Save,
  Plus,
  Book,
  Wrench,
  Trash2,
  XCircle,
  Clock,
  Sparkles,
  Send,
  Bot,
  Copy,
  Check,
  Activity,
  Pencil,
  X,
  GripVertical,
  Globe,
  Loader2
} from "lucide-react";

import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  useSortable
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

type Tab = "info" | "ajustes" | "etapas" | "testes" | "logs";

const DAYS = [
  "Segunda-feira",
  "Terça-feira",
  "Quarta-feira",
  "Quinta-feira",
  "Sexta-feira",
  "Sábado",
  "Domingo"
];

// Componente Auxiliar para Cópia de Campos Premium
const CopyButton = ({ text, label }: { text: string, label?: string }) => {
  const [copied, setCopied] = useState(false);
  
  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Falha ao copiar:", err);
    }
  };

  return (
    <button 
      onClick={handleCopy}
      title="Copiar para área de transferência"
      className={cn(
        "flex items-center gap-1.5 px-2 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all duration-300",
        copied 
          ? "bg-green-500/20 text-green-400 border border-green-500/30 scale-105" 
          : "bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-white border border-white/5"
      )}
    >
      {copied ? (
        <><Check className="w-2.5 h-2.5" /> Copiado!</>
      ) : (
        <><Copy className="w-2.5 h-2.5" /> {label || "Copiar"}</>
      )}
    </button>
  );
};

const SortableStage = ({ stage, idx, stages, setStages, deletarStage }: any) => {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: stage.id });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div ref={setNodeRef} style={style} className="glass-card p-6 rounded-[2rem] border-white/10 space-y-4 bg-white/[0.02]">
       <div className="flex items-center justify-between border-b border-white/5 pb-3">
          <div className="flex items-center gap-2">
             <div {...attributes} {...listeners} className="cursor-grab text-white/50 hover:text-white">
                <GripVertical className="w-5 h-5" />
             </div>
             <h4 className="font-bold">{idx + 1}. {stage.title}</h4>
          </div>
          <Button onClick={() => deletarStage(stage.id)} size="icon" variant="ghost" className="text-red-500 hover:bg-red-500/10"><Trash2 className="w-4 h-4" /></Button>
       </div>
       <div className="space-y-2">
          <label className="text-[10px] font-black uppercase tracking-widest text-primary">Instrução / O que o agente deve fazer</label>
          <Textarea value={stage.goal_prompt} onChange={e => setStages(stages.map((s: any) => s.id === stage.id ? {...s, goal_prompt: e.target.value} : s))} className="bg-black/30 h-20 text-xs" />
       </div>
       
       <div className="space-y-3 p-4 bg-yellow-500/5 border border-yellow-500/20 rounded-xl">
          <div className="flex items-center justify-between mb-2">
             <label className="text-[10px] font-black uppercase tracking-widest text-yellow-400">Condição para executar</label>
             <div className="flex items-center gap-2">
                <div onClick={() => {
                    if (stage.condition_variable) {
                        setStages(stages.map((s: any) => s.id === stage.id ? {...s, condition_variable: null, condition_value: null} : s));
                    } else {
                        setStages(stages.map((s: any) => s.id === stage.id ? {...s, condition_variable: "variavel", condition_value: "valor", condition_operator: "equals"} : s));
                    }
                }} className={cn("w-8 h-4 rounded-full relative cursor-pointer", stage.condition_variable ? "bg-yellow-500" : "bg-white/10")}>
                   <div className={cn("absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all shadow-sm", stage.condition_variable ? "translate-x-[18px]" : "translate-x-0.5")}></div>
                </div>
                <span className="text-[10px] uppercase text-white/50">{stage.condition_variable ? "Ativada" : "Desativada"}</span>
             </div>
          </div>
          
          {stage.condition_variable ? (
              <div className="grid grid-cols-3 gap-2">
                 <Input placeholder="Variável (ex: forma_retirada)" value={stage.condition_variable || ""} onChange={e => setStages(stages.map((s: any) => s.id === stage.id ? {...s, condition_variable: e.target.value} : s))} className="bg-black/50 border-white/10 text-xs h-9" />
                 <select value={stage.condition_operator || "equals"} onChange={e => setStages(stages.map((s: any) => s.id === stage.id ? {...s, condition_operator: e.target.value} : s))} className="bg-black/50 border border-white/10 text-white rounded-md text-xs px-2 h-9">
                    <option value="equals">Igual a</option>
                    <option value="not_equals">Diferente de</option>
                    <option value="contains">Contém</option>
                 </select>
                 <Input placeholder="Valor (ex: entrega)" value={stage.condition_value || ""} onChange={e => setStages(stages.map((s: any) => s.id === stage.id ? {...s, condition_value: e.target.value} : s))} className="bg-black/50 border-white/10 text-xs h-9" />
              </div>
          ) : (
              <p className="text-xs text-white/40">Esta etapa será executada obrigatoriamente quando for a vez dela.</p>
          )}
       </div>

       <div className="space-y-3 p-4 bg-blue-500/5 border border-blue-500/20 rounded-xl">
          <div className="flex items-center justify-between">
             <label className="text-[10px] font-black uppercase tracking-widest text-blue-400">Capturar variáveis</label>
             <Button size="sm" variant="ghost" onClick={() => {
                const vars = Array.isArray(stage.captured_variables) ? stage.captured_variables : [];
                setStages(stages.map((s: any) => s.id === stage.id ? {...s, captured_variables: [...vars, { name: "", description: "", type: "fixa" }]} : s));
             }} className="h-6 text-[10px] gap-1 text-blue-400 hover:text-blue-300 hover:bg-blue-400/10"><Plus className="w-3 h-3"/> Adicionar variável</Button>
          </div>
          {(Array.isArray(stage.captured_variables) ? stage.captured_variables : []).map((v: any, vIdx: number) => (
             <div key={vIdx} className="flex gap-2 items-center">
                <Input placeholder="Nome (ex: nome)" value={v.name} onChange={e => {
                   const vars = [...stage.captured_variables];
                   vars[vIdx].name = e.target.value;
                   setStages(stages.map((s: any) => s.id === stage.id ? {...s, captured_variables: vars} : s));
                }} className="bg-black/50 border-white/10 text-xs h-8 flex-1" />
                <Input placeholder="O que captar (ex: nome completo do lead)" value={v.description} onChange={e => {
                   const vars = [...stage.captured_variables];
                   vars[vIdx].description = e.target.value;
                   setStages(stages.map((s: any) => s.id === stage.id ? {...s, captured_variables: vars} : s));
                }} className="bg-black/50 border-white/10 text-xs h-8 flex-1" />
                
                <select value={v.type || "fixa"} onChange={e => {
                   const vars = [...stage.captured_variables];
                   vars[vIdx].type = e.target.value;
                   setStages(stages.map((s: any) => s.id === stage.id ? {...s, captured_variables: vars} : s));
                }} className="bg-black/50 border border-white/10 text-white rounded-md text-[10px] px-2 h-8 w-24">
                   <option value="fixa">Fixa</option>
                   <option value="volatil">Volátil</option>
                   <option value="reconfirmar">Reconfirmar</option>
                </select>

                <Button size="icon" variant="ghost" onClick={() => {
                   const vars = stage.captured_variables.filter((_: any, i: number) => i !== vIdx);
                   setStages(stages.map((s: any) => s.id === stage.id ? {...s, captured_variables: vars} : s));
                }} className="h-8 w-8 text-red-400 hover:bg-red-500/10"><X className="w-4 h-4" /></Button>
             </div>
          ))}
       </div>

       <Button size="sm" onClick={async () => {
          const { error } = await supabase.from("agent_stages").update({ 
             goal_prompt: stage.goal_prompt,
             condition_variable: stage.condition_variable,
             condition_operator: stage.condition_operator,
             condition_value: stage.condition_value,
             captured_variables: stage.captured_variables || []
          }).eq("id", stage.id);
          if (error) {
              alert("Erro ao salvar etapa: " + error.message);
          } else {
              alert("Alterações da etapa salvas!");
          }
       }} className="w-full h-8 text-[10px] bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20">Salvar Alterações da Etapa</Button>
    </div>
  );
};

export default function AgentePage() {
  const [activeTab, setActiveTab] = useState<Tab>("info");
  const [activeAgentId, setActiveAgentId] = useState<number>(1);
  const [agentsList, setAgentsList] = useState<any[]>([]);
  const [isActiveAgente, setIsActiveAgente] = useState(true);
  const [vinculoInstance, setVinculoInstance] = useState("sdr");
  const [savingVinculo, setSavingVinculo] = useState(false);
  const [allInstances, setAllInstances] = useState<string[]>([]);
  const [appUrl, setAppUrl] = useState("");
  const [loadingConfig, setLoadingConfig] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);
  const vinculoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  const testBufferTimerRef = useRef<NodeJS.Timeout | null>(null);
  const testMessageBufferRef = useRef<string[]>([]);
  const testMessagesStateRef = useRef<any[]>([]);

  const [knowledge, setKnowledge] = useState<any[]>([]);
  const [showNovoK, setShowNovoK] = useState(false);
  const [novoKTitle, setNovoKTitle] = useState("");
  const [novoKContent, setNovoKContent] = useState("");
  const [editKId, setEditKId] = useState<string | null>(null);
  const [editKTitle, setEditKTitle] = useState("");
  const [editKContent, setEditKContent] = useState("");

  const [prompt, setPrompt] = useState("");
  const promptRef = useRef<HTMLTextAreaElement | null>(null);

  // Pré-visualização do prompt — mostra o que vai chegar na IA depois das substituições
  const [previewOpen, setPreviewOpen] = useState(true);
  const [previewSample, setPreviewSample] = useState({
    nome_negocio: "Padaria Centro",
    ramo_negocio: "Alimentação",
    push_name:    "João",
    telefone:     "11999998888",
    endereco:     "Rua A, 123 - Centro",
    categoria:    "Padaria",
    website:      "padariacentro.com.br",
  });

  // Lista de leads disponíveis para escolha + busca
  type LeadRow = {
    id: number;
    remoteJid: string;
    nome_negocio: string | null;
    ramo_negocio: string | null;
    categoria: string | null;
    endereco: string | null;
    website: string | null;
    telefone: string | null;
  };
  const [previewLeads, setPreviewLeads] = useState<LeadRow[]>([]);
  const [previewLeadsLoading, setPreviewLeadsLoading] = useState(false);
  const [previewSelectedLeadId, setPreviewSelectedLeadId] = useState<number | null>(null);
  const [previewLeadQuery, setPreviewLeadQuery] = useState("");

  // Carrega lista de leads (para o seletor da pré-visualização)
  const loadPreviewLeads = useCallback(async () => {
    setPreviewLeadsLoading(true);
    try {
      const { data } = await supabase
        .from("leads_extraidos")
        .select('id, "remoteJid", nome_negocio, ramo_negocio, categoria, endereco, website, telefone')
        .order("created_at", { ascending: false })
        .limit(500);
      setPreviewLeads((data || []) as any);
    } finally {
      setPreviewLeadsLoading(false);
    }
  }, []);

  // Aplica um lead específico no sample
  const applyLeadToSample = (lead: LeadRow | null) => {
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

  // Insere um snippet (variável dinâmica ou {{kb:Título}}) na posição do cursor.
  const insertAtCursor = (snippet: string) => {
    if (!snippet) return;
    const ta = promptRef.current;
    if (!ta) {
      setPrompt(p => p + (p && !p.endsWith("\n") ? "\n" : "") + snippet);
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
  // Wrappers semânticos
  const insertVariable   = (key: string)   => insertAtCursor(`{{${key}}}`);
  const insertKbVariable = (title: string) => insertAtCursor(`{{kb:${title}}}`);
  const [nomeAgente, setNomeAgente] = useState("Sarah SDR");
  const [funcaoAgente, setFuncaoAgente] = useState("");
  const [personalidadeAgente, setPersonalidadeAgente] = useState("");
  const [tomAgente, setTomAgente] = useState("");
  const [targetModel, setTargetModel] = useState("gemini-1.5-flash");
  const [calendarEnabled, setCalendarEnabled] = useState(false);
  const [modelOptions, setModelOptions] = useState<any[]>([]);
  const [googleJson, setGoogleJson] = useState("");
  const [googleTokens, setGoogleTokens] = useState<any>(null);
  const [calendarAskFields, setCalendarAskFields] = useState("");
  const [calendarGenerateMeet, setCalendarGenerateMeet] = useState(false);
  const [calendarDefaultDuration, setCalendarDefaultDuration] = useState<number>(30);
  // Apenas perguntas diretas que a IA precisa fazer ao cliente.
  // Telefone vem do JID, empresa/necessidade são inferidas pela IA sem perguntar.
  const CALENDAR_FIELDS = [
    { key: "nome",  label: "Nome completo", hint: "IA pergunta ao cliente antes de agendar" },
    { key: "email", label: "E-mail",        hint: "IA pergunta. Cliente vira convidado oficial do evento (recebe convite)" },
  ] as const;
  const [calendarOptionalFields, setCalendarOptionalFields] = useState<Record<string, boolean>>({});
  // Captura automática (sem perguntar) — pode desativar caso não queira capturar
  const [calendarAutoCapture, setCalendarAutoCapture] = useState<{ telefone: boolean; empresa: boolean; necessidade: boolean }>({
    telefone: true, empresa: true, necessidade: true,
  });
  const [messageBufferSeconds, setMessageBufferSeconds] = useState(0);
  const [humanizeMessages, setHumanizeMessages] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  
  const [customTools, setCustomTools] = useState<any[]>([]);
  const [showToolModal, setShowToolModal] = useState(false);
  const [newTool, setNewTool] = useState({ name: "", description: "", webhook_url: "" });
  const [webhookLogs, setWebhookLogs] = useState<any[]>([]);

  const [schedules, setSchedules] = useState(DAYS.map(day => ({ day, active: day !== "Domingo", start: "08:00", end: "18:00" })));
  const [is24h, setIs24h] = useState(false);
  const [awayMessage, setAwayMessage] = useState("");
  const [stages, setStages] = useState<any[]>([]);
  const [horarioTab, setHorarioTab] = useState<'commercial' | 'away'>('commercial');
  const [novoStageTitle, setNovoStageTitle] = useState("");
  const [novoStagePrompt, setNovoStagePrompt] = useState("");
  const [showNovoStage, setShowNovoStage] = useState(false);

  const [testMessages, setTestMessages] = useState<any[]>([]);
  const [testInput, setTestInput] = useState("");
  const [testLoading, setTestLoading] = useState(false);
  const [expandedLogs, setExpandedLogs] = useState<number[]>([]);

  // NOVO: Estado de Sessão de Teste (Sandbox)
  const [testVariables, setTestVariables] = useState<Record<string, string>>({});
  const [testStageIndex, setTestStageIndex] = useState(0);
  const [testSkippedStages, setTestSkippedStages] = useState<number[]>([]);

  // NOVO: Estado para Simulação de Disparo Inicial
  const [sandboxTemplate, setSandboxTemplate] = useState("Olá {{nome_negocio}}, vi que vocês são do ramo de {{ramo_negocio}}...");
  const [sandboxPersonalizeAI, setSandboxPersonalizeAI] = useState(false);
  const [sandboxAiPrompt, setSandboxAiPrompt] = useState(`Você é um SDR experiente fazendo uma primeira abordagem PROFISSIONAL via WhatsApp.\n\nINSTRUÇÕES:\n- Reescreva a MENSAGEM-BASE de forma natural, curta (até 3 frases), em PT-BR.\n- Mantenha o sentido original do template.\n- Personalize SUTILMENTE pra empresa/ramo (sem inventar nada).\n- Não use emojis exagerados.\n- NÃO invente dados que não tem certeza.`);
  const [sandboxUseWebSearch, setSandboxUseWebSearch] = useState(false);
  const [sandboxSimulating, setSandboxSimulating] = useState(false);

  const previewSandboxMessage = useMemo(() => {
    return renderTemplate(sandboxTemplate, previewSample as any);
  }, [sandboxTemplate, previewSample]);

  const toggleLog = (idx: number) => {
    if (expandedLogs.includes(idx)) {
       setExpandedLogs(expandedLogs.filter(i => i !== idx));
    } else {
       setExpandedLogs([...expandedLogs, idx]);
    }
  };

  // browserOrigin só é populado depois do mount, evita hydration mismatch.
  const [browserOrigin, setBrowserOrigin] = useState("");
  useEffect(() => { setBrowserOrigin(window.location.origin); }, []);
  const webhookBase = appUrl || browserOrigin;
  const webhookUrl = webhookBase
    ? `${webhookBase}/api/webhooks/whatsapp?agentId=${activeAgentId || 1}`
    : `/api/webhooks/whatsapp?agentId=${activeAgentId || 1}`;

  const loadAgent = useCallback((id: number) => {
    setLoadingConfig(true);
    supabase.from("agent_settings").select("*").eq("id", id).single().then(({ data }) => {
      if (data) {
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
        // API Key do Gemini agora é central (ai_organizer_config.api_key) — não carregamos mais por agente
        setAppUrl(opts.app_url || "");
        setGoogleJson(opts.google_credentials || "");
        setGoogleTokens(opts.google_tokens || null);
        setCalendarAskFields(opts.calendar_ask_fields || "");
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
      }
    });

    supabase.from("agent_knowledge").select("*").eq("agent_id", id).order("created_at").then(({ data }) => { if (data) setKnowledge(data); });
    
    // Buscar vínculo da instância atual.
    // Pode haver múltiplas channel_connections com mesmo agent_id (legacy);
    // pegamos a primeira por created_at, ignorando o erro de "Multiple rows" do .single().
    supabase.from("channel_connections")
       .select("instance_name, created_at")
       .eq("agent_id", id)
       .order("created_at", { ascending: true })
       .limit(1)
       .then(({ data }) => {
          const inst = data?.[0]?.instance_name || "";
          setVinculoInstance(inst);
          console.log(`[LOAD] Agente ${id} → instância: ${inst || "(nenhuma)"}`);
       });

    supabase.from("agent_stages").select("*").eq("agent_id", id).order("order_index").then(({ data }) => { if (data) setStages(data); setLoadingConfig(false); });
  }, []);

  const saveVinculoInstant = async (instanceName: string, agentId: number) => {
    if (!instanceName || !agentId) return;
    setSavingVinculo(true);
    try {
      // 0. Conflito: a instância já está vinculada a OUTRO agente?
      //    Suporte multi-agente: cada instância pertence a UM agente — então
      //    aqui a gente DETECTA o conflito e pede confirmação explícita ao user.
      //    Sem isso, um agente novo "rouba" silenciosamente a instância de outro
      //    agente e a vinculação anterior some.
      const { data: existing } = await supabase
        .from("channel_connections")
        .select("agent_id, instance_name")
        .eq("instance_name", instanceName)
        .maybeSingle();

      if (existing && existing.agent_id && existing.agent_id !== agentId) {
        const otherAgent = agentsList.find(a => a.id === existing.agent_id);
        const otherName = otherAgent?.name ? `${otherAgent.name} (ID ${existing.agent_id})` : `agente ID ${existing.agent_id}`;
        const ok = window.confirm(
          `A instância "${instanceName}" já está vinculada ao ${otherName}.\n\n` +
          `Vincular ela a este agente vai TIRAR essa instância do outro agente — ` +
          `o outro agente ficará sem instância e parará de receber mensagens.\n\n` +
          `Quer continuar?`
        );
        if (!ok) {
          // Reverte a UI pro vínculo anterior do agente atual.
          const { data: revert } = await supabase
            .from("channel_connections")
            .select("instance_name")
            .eq("agent_id", agentId)
            .order("created_at", { ascending: true })
            .limit(1);
          setVinculoInstance(revert?.[0]?.instance_name || "");
          return;
        }
      }

      // 1. Vincula a instância escolhida ao agente (instance_name é UNIQUE no banco)
      const { error: e1 } = await supabase
        .from("channel_connections")
        .upsert({ instance_name: instanceName, agent_id: agentId, status: 'open' }, { onConflict: 'instance_name' });
      if (e1) throw e1;

      // 2. Limpa OUTRAS instâncias que estavam apontando pra esse agente
      //    (cada agente fica com UMA instância — exatamente a que foi escolhida)
      const { error: e2 } = await supabase
        .from("channel_connections")
        .delete()
        .eq("agent_id", agentId)
        .neq("instance_name", instanceName);
      if (e2) console.warn("[VINCULO] Erro ao limpar instâncias antigas:", e2.message);
    } catch (err: any) {
      console.error("[VINCULO] Erro ao salvar:", err.message);
      alert("Erro ao vincular instância: " + err.message);
    } finally {
      setSavingVinculo(false);
    }
  };

  useEffect(() => {
    const saved = localStorage.getItem('sdr_active_agent_id');
    if (saved) setActiveAgentId(Number(saved));

    supabase.from("ai_organizer_config").select("*").eq("id", 1).single().then(({ data }) => {
       if (data) {
         // api_key é central e lida server-side; não precisamos no cliente
         if (data.app_url) setAppUrl(data.app_url);
       }
    });

    supabase.from("agent_settings").select("id, name").order("id").then(({ data }) => {
       if (data && data.length > 0) {
           setAgentsList(data);
           const agentExists = data.some(a => a.id === activeAgentId);
           const idToLoad = agentExists ? activeAgentId : data[0].id;
           loadAgent(idToLoad);
       }
    });

    // Buscar TODAS as instâncias do banco local
    supabase.from("channel_connections").select("instance_name").then(({ data }) => {
       if (data) {
          const names = Array.from(new Set(data.map(i => i.instance_name as string))).filter(Boolean);
          setAllInstances(names);
       }
    });

    // Buscar instâncias da Evolution API (caso existam que ainda não estão no banco)
    fetch("/api/whatsapp").then(r => r.json()).then(data => {
       if (data.instances) {
          const names = data.instances.map((i: any) => i.instanceName || i.instance_name).filter(Boolean) as string[];
          setAllInstances(prev => Array.from(new Set([...prev, ...names])));
       }
    }).catch(console.error);

    fetch("/api/ai-models").then(r => r.json()).then((data) => { if (data.success && data.models) setModelOptions(data.models); });
    supabase.from("webhook_logs").select("*").order("created_at", { ascending: false }).limit(20).then(({ data }) => { if (data) setWebhookLogs(data); });

    const channel = supabase.channel('webhook_logs_realtime').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'webhook_logs' }, (payload) => {
       setWebhookLogs(prev => [payload.new, ...prev].slice(0, 20));
    }).subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [loadAgent]);

  useEffect(() => {
    if (activeAgentId) localStorage.setItem('sdr_active_agent_id', activeAgentId.toString());
  }, [activeAgentId]);

  // Sandbox de testes: persiste histórico por agente no localStorage pra não perder
  // ao trocar de aba / navegar / recarregar.
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
      .then(r => r.json())
      .then(data => {
        if (!cancelled && data?.url) setAppUrl(prev => prev || data.url);
      })
      .catch(() => { /* ignore */ });

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.url) setAppUrl(detail.url);
    };
    window.addEventListener("public-url-changed", handler);
    return () => {
      cancelled = true;
      window.removeEventListener("public-url-changed", handler);
    };
  }, []);

  const saveIdentity = async () => {
    if (!activeAgentId) return;
    setSavingConfig(true);
    const { data: current } = await supabase.from("agent_settings").select("options").eq("id", activeAgentId).single();
    const { error } = await supabase.from("agent_settings").update({
      name: nomeAgente, role: funcaoAgente, personality: personalidadeAgente, tone: tomAgente, target_model: targetModel,
      options: {
        ...current?.options,
        // gemini_api_key não é mais salvo por agente — é central em ai_organizer_config.api_key
        app_url: appUrl,
        message_buffer_seconds: messageBufferSeconds,
        humanize_messages: humanizeMessages,
        web_search_enabled: webSearchEnabled,
      }
    }).eq("id", activeAgentId);
    setSavingConfig(false);
    if (!error) alert("Identidade salva!"); else alert("Erro: " + error.message);
  };

  const savePrompt = async () => {
    if (!activeAgentId) return;
    setSavingConfig(true);
    const { error } = await supabase.from("agent_settings").update({ main_prompt: prompt }).eq("id", activeAgentId);
    setSavingConfig(false);
    if (!error) alert("Prompt salvo!"); else alert("Erro: " + error.message);
  };

  const saveSchedules = async () => {
    if (!activeAgentId) return;
    setSavingConfig(true);
    const { error } = await supabase.from("agent_settings").update({ schedules, is_24h: is24h, away_message: awayMessage }).eq("id", activeAgentId);
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
        // mantém compatibilidade pra leituras antigas
        calendar_ask_fields: Object.entries(calendarOptionalFields).filter(([, v]) => v).map(([k]) => k).join(", "),
      }
    }).eq("id", activeAgentId);
    setSavingConfig(false);
    if (!error) alert("Agenda salva!"); else alert("Erro: " + error.message);
  };

  const salvarNovoKnowledge = async () => {
    if (!activeAgentId || !novoKTitle || !novoKContent) return;
    const { error } = await supabase.from("agent_knowledge").insert({
      agent_id: activeAgentId,
      title: novoKTitle,
      content: novoKContent
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
    setEditKId(null);
    setEditKTitle("");
    setEditKContent("");
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

  const salvarNovoStage = async () => {
    if (!activeAgentId || !novoStageTitle) return;
    const { error } = await supabase.from("agent_stages").insert({
      agent_id: activeAgentId, title: novoStageTitle, goal_prompt: novoStagePrompt, order_index: stages.length
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

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleDragEnd = async (event: any) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = stages.findIndex((s) => s.id === active.id);
      const newIndex = stages.findIndex((s) => s.id === over.id);
      
      const newStages = arrayMove(stages, oldIndex, newIndex);
      setStages(newStages);

      const updates = newStages.map((s, i) => ({ ...s, order_index: i }));
      for (const st of updates) {
         await supabase.from("agent_stages").update({ order_index: st.order_index }).eq("id", st.id);
      }
    }
  };

  const handlesubmit = (e: any) => e.preventDefault();

  const renderTemplateString = (template: string, leadData: Record<string, string>) => {
    let result = template;
    for (const [key, value] of Object.entries(leadData)) {
      result = result.replace(new RegExp(`{{${key}}}`, "g"), value || "");
    }
    return result;
  };

  const simulateInitialMessage = async () => {
    if (!sandboxTemplate.trim()) return;
    setSandboxSimulating(true);

    try {
      const baseMessage = renderTemplateString(sandboxTemplate, previewSample as any);
      let finalMessage = baseMessage;

      if (sandboxPersonalizeAI) {
        const res = await fetch("/api/agent/rewrite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseMessage,
            model: targetModel,
            customPrompt: sandboxAiPrompt,
            nomeEmpresa: previewSample.nome_negocio,
            ramo: previewSample.ramo_negocio,
            useWebSearch: sandboxUseWebSearch
          })
        });
        const data = await res.json();
        if (data.success && data.text) {
          finalMessage = data.text;
        } else {
          alert("Erro na IA: " + data.error);
          setSandboxSimulating(false);
          return;
        }
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
     
     // Consolidar as mensagens
     const consolidatedText = testMessageBufferRef.current.join("\\n");
     testMessageBufferRef.current = []; // Limpar buffer

     setTestLoading(true);
     try {
        // Obter o histórico atualizado
        const currentHistory = testMessagesStateRef.current
          .filter(m => m.role === 'user' || m.role === 'agent')
          .map(m => ({ role: m.role, content: m.content }));

        // A última mensagem do usuário (que agrupamos no buffer visualmente) já está em currentHistory
        // Mas a API processará 'consolidatedText'
        
        const res = await fetch("/api/agent/process", {
            method: "POST", headers: { "Content-Type" : "application/json", "x-test-agent-id": activeAgentId.toString() },
            body: JSON.stringify({ 
                isTestMode: true, 
                remoteJid: "sandbox_teste", 
                text: consolidatedText, 
                testHistory: currentHistory.slice(0, -1), // Enviamos até a penúltima, pois a última a API processará como a mensagem atual (agrupada)
                testState: {
                    variables: testVariables,
                    currentStageIndex: testStageIndex,
                    skippedStages: testSkippedStages
                },
                testLeadData: previewSample
            })
        });
        const data = await res.json();

        if (!data.success || data.error) {
           setTestMessages(prev => [...prev, {
              role: 'agent',
              isError: true,
              content: `❌ ${data.error || "Erro desconhecido no servidor."}`
           }]);
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

        setTestMessages(prev => [
          ...prev,
          ...toolLogs.map((l: any) => ({ role: 'tool', content: l.content || JSON.stringify(l) })),
        ]);

        for (let i = 0; i < chunks.length; i++) {
           if (i > 0) {
              const typingSeconds = Math.min(Math.max(chunks[i].length / 15, 1.5), 4);
              await new Promise(r => setTimeout(r, typingSeconds * 1000));
           }
           setTestMessages(prev => [...prev, { role: 'agent', content: chunks[i] }]);
        }

     } catch (e: any) {
        setTestMessages(prev => [...prev, { role: 'agent', isError: true, content: `❌ Falha ao contatar servidor: ${e.message}` }]);
     } finally {
        setTestLoading(false);
     }
  };

  const handleTestSubmit = async (e: React.FormEvent) => {
     e.preventDefault();
     if (!testInput.trim()) return;
     
     const currentInput = testInput.trim();
     
     // Adicionar visualmente no histórico
     setTestMessages(prev => {
         // Se a última for do usuário e tiver buffer ativo, apenas anexamos (humanização visual no chat)
         if (messageBufferSeconds > 0 && prev.length > 0 && prev[prev.length - 1].role === 'user' && testMessageBufferRef.current.length > 0) {
             const newPrev = [...prev];
             newPrev[newPrev.length - 1] = { ...newPrev[newPrev.length - 1], content: newPrev[newPrev.length - 1].content + "\\n\\n" + currentInput };
             return newPrev;
         }
         return [...prev, { role: 'user', content: currentInput }];
     });
     
     setTestInput("");
     
     // Colocar no buffer interno para processamento
     testMessageBufferRef.current.push(currentInput);

     // Debounce via timer
     if (testBufferTimerRef.current) {
         clearTimeout(testBufferTimerRef.current);
     }

     if (messageBufferSeconds > 0) {
         setTestLoading(true); // Fica loading mas não processa ainda
         testBufferTimerRef.current = setTimeout(() => {
             processSandboxQueue();
         }, messageBufferSeconds * 1000);
     } else {
         processSandboxQueue();
     }
  };


  // Detecta o tipo de tool a partir do conteúdo do log
  const toolMeta = (content: string): { label: string; color: string; icon: string } => {
    if (/RAG|search_knowledge_base/i.test(content)) return { label: "Base de conhecimento", color: "purple", icon: "📚" };
    if (/Google Calendar|calendar/i.test(content))  return { label: "Google Calendar (MCP)", color: "blue", icon: "📅" };
    if (/Webhook Custom/i.test(content))            return { label: "Tool customizada", color: "amber", icon: "🔌" };
    return { label: "Tool", color: "gray", icon: "⚙️" };
  };

  return (
    <div className="flex flex-col h-[100dvh] max-h-[100dvh] bg-background overflow-hidden selection:bg-primary/30 text-white">
      <Header />
      
      <main className="flex-1 overflow-y-auto w-full">
        {/* Banner Premium Header */}
        <div className="bg-gradient-to-r from-purple-800 via-primary/80 to-blue-900 border-b border-white/10 px-3 sm:px-8 py-2 sm:py-3 flex items-center justify-between gap-2 shadow-lg shadow-primary/5">
          <div className="flex bg-black/40 border border-white/20 p-1 rounded-xl">
             <select value={activeAgentId} onChange={(e) => { const id = Number(e.target.value); setActiveAgentId(id); loadAgent(id); }} className="bg-transparent text-white font-bold text-xs uppercase tracking-widest pl-3 pr-8 focus:outline-none">
                {agentsList.map(a => <option key={a.id} value={a.id} className="bg-neutral-900">{a.name} (ID: {a.id})</option>)}
             </select>
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={async () => { const randomId = Math.floor(Math.random() * 90000) + 1000; const { data } = await supabase.from("agent_settings").insert({ id: randomId, name: "Novo Agente" }).select(); if(data) { setAgentsList([...agentsList, data[0]]); setActiveAgentId(data[0].id); loadAgent(data[0].id); }}} variant="secondary" className="h-8 rounded-lg text-xs font-bold gap-2 px-4 shadow-sm hover:scale-105 transition-transform bg-white/10 text-white border border-white/20 hover:bg-white/20"><Plus className="w-3 h-3" /> Criar Novo</Button>
            <Button onClick={async () => { if(confirm("Deletar agente?")) { await supabase.from("agent_settings").delete().eq("id", activeAgentId); const filtered = agentsList.filter(a => a.id !== activeAgentId); setAgentsList(filtered); if(filtered.length > 0) { setActiveAgentId(filtered[0].id); loadAgent(filtered[0].id); }}}} variant="ghost" size="icon" className="h-8 w-8 text-red-500 hover:text-red-400 hover:bg-red-500/20 rounded-lg"><Trash2 className="w-4 h-4" /></Button>
          </div>
        </div>

        <div className="max-w-6xl mx-auto p-3 sm:p-8 space-y-4 sm:space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500 mobile-safe-bottom">
          <div className="flex bg-white/5 border border-white/10 p-1 rounded-2xl mobile-tabs-scroll shadow-inner">
            <button onClick={() => setActiveTab("info")} className={cn("flex items-center gap-1.5 sm:gap-2 px-3 sm:px-5 py-2 sm:py-2.5 text-xs sm:text-sm font-bold rounded-xl transition-all whitespace-nowrap", activeTab === "info" ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20" : "text-muted-foreground hover:text-white hover:bg-white/5")}><Info className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> <span className="hidden sm:inline">Informações</span><span className="sm:hidden">Info</span></button>
            <button onClick={() => setActiveTab("ajustes")} className={cn("flex items-center gap-1.5 sm:gap-2 px-3 sm:px-5 py-2 sm:py-2.5 text-xs sm:text-sm font-bold rounded-xl transition-all whitespace-nowrap", activeTab === "ajustes" ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20" : "text-muted-foreground hover:text-white hover:bg-white/5")}><Settings className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> Ajustes</button>
            <button onClick={() => setActiveTab("etapas")} className={cn("flex items-center gap-1.5 sm:gap-2 px-3 sm:px-5 py-2 sm:py-2.5 text-xs sm:text-sm font-bold rounded-xl transition-all whitespace-nowrap", activeTab === "etapas" ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20" : "text-muted-foreground hover:text-white hover:bg-white/5")}><ListTree className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> Etapas</button>
            <button onClick={() => setActiveTab("testes")} className={cn("flex items-center gap-1.5 sm:gap-2 px-3 sm:px-5 py-2 sm:py-2.5 text-xs sm:text-sm font-bold rounded-xl transition-all whitespace-nowrap", activeTab === "testes" ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20" : "text-muted-foreground hover:text-white hover:bg-white/5")}><FlaskConical className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> Testes</button>
            <button onClick={() => setActiveTab("logs")} className={cn("flex items-center gap-1.5 sm:gap-2 px-3 sm:px-5 py-2 sm:py-2.5 text-xs sm:text-sm font-bold rounded-xl transition-all whitespace-nowrap", activeTab === "logs" ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20" : "text-muted-foreground hover:text-white hover:bg-white/5")}><Activity className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> Logs</button>
          </div>

          <div className="space-y-12 pb-8 mobile-safe-bottom">
            {activeTab === "info" && (
              <div className="space-y-12 animate-in fade-in duration-500">
                <section className="glass-card p-4 sm:p-8 rounded-2xl sm:rounded-[2rem] border-white/10 space-y-4 sm:space-y-6 bg-white/[0.02]">
                  <div className="flex items-center justify-between border-b border-white/10 pb-4">
                    <h3 className="text-lg font-black tracking-tight flex items-center gap-2">Identidade do Agente</h3>
                    <div className="flex items-center gap-2">
                       <span className={cn("text-[9px] font-bold", isActiveAgente ? "text-green-400" : "text-red-400")}>{isActiveAgente ? "ATIVO" : "DESLIGADO"}</span>
                       <div onClick={async () => { const nv = !isActiveAgente; setIsActiveAgente(nv); await supabase.from("agent_settings").update({ is_active: nv }).eq("id", activeAgentId); }} className={cn("w-12 h-6 rounded-full cursor-pointer transition-all duration-300 p-1 flex items-center relative", isActiveAgente ? "bg-green-500 shadow-glow" : "bg-white/10")}>
                         <div className={cn("w-4 h-4 rounded-full bg-white transition-all", isActiveAgente ? "translate-x-6" : "")} />
                       </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                           <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Nome do Agente</label>
                           <CopyButton text={nomeAgente} />
                        </div>
                        <Input value={nomeAgente} onChange={e => setNomeAgente(e.target.value)} className="bg-white/5 border-white/10 h-12 rounded-xl text-sm" />
                      </div>
                      <div className="space-y-2">
                         <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Modelo Gemini (LLM)</label>
                         <select value={targetModel} onChange={e => setTargetModel(e.target.value)} className="w-full bg-white/5 border-white/10 text-white h-12 rounded-xl text-sm px-3 focus:outline-none">
                            {/* Sempre mostra o valor salvo, mesmo que a lista da API ainda não tenha chegado */}
                            {targetModel && !modelOptions.some(m => m.id === targetModel) && (
                               <option key={targetModel} value={targetModel} className="bg-neutral-900">
                                  {targetModel} (salvo)
                               </option>
                            )}
                            {modelOptions.length === 0 && !targetModel && (
                               <option value="" className="bg-neutral-900 text-muted-foreground">
                                  Configure a API Key em Configurações primeiro…
                               </option>
                            )}
                            {modelOptions.map(m => <option key={m.id} value={m.id} className="bg-neutral-900">{m.name}</option>)}
                         </select>
                         <p className="text-[9px] text-muted-foreground mt-1 px-1">
                            {modelOptions.length > 0
                              ? `${modelOptions.length} modelos Gemini disponíveis · chave central configurada.`
                              : <>⚠ Lista de modelos vazia. Configure a chave do Gemini em <a href="/configuracoes" className="text-primary underline decoration-dotted">Configurações</a>.</>}
                         </p>
                       </div>

                       <div className="pt-4 border-t border-white/5 mt-4 space-y-4">
                          <div className="space-y-2">
                             <div className="flex items-center justify-between gap-2">
                                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">App URL</label>
                                <CopyButton text={appUrl} label="URL" />
                             </div>
                             <Input value={appUrl} onChange={e => setAppUrl(e.target.value)} placeholder="..." className="bg-white/5 border-white/10 h-10 rounded-xl text-xs" />
                          </div>
                          <div className="flex items-start gap-2 p-2.5 rounded-lg bg-primary/5 border border-primary/20">
                             <Info className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
                             <p className="text-[10px] text-primary/90 leading-relaxed">
                                A <strong>API Key do Gemini</strong> é agora uma só pra todo o sistema. Configure em{" "}
                                <a href="/configuracoes" className="underline decoration-dotted font-bold hover:text-primary">Configurações</a>.
                             </p>
                          </div>
                       </div>
                    </div>
                    <div className="space-y-4">
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <label className="text-[10px] font-black uppercase tracking-widest text-primary">Instância WhatsApp Vinculada</label>
                          {savingVinculo ? (
                            <span className="text-[9px] font-black uppercase tracking-widest text-yellow-400 flex items-center gap-1">
                              <span className="w-1.5 h-1.5 rounded-full bg-yellow-400 animate-pulse" /> Salvando…
                            </span>
                          ) : vinculoInstance ? (
                            <span className="text-[9px] font-black uppercase tracking-widest text-green-400 flex items-center gap-1">
                              <Check className="w-2.5 h-2.5" /> Vinculada
                            </span>
                          ) : null}
                        </div>
                        <select
                          value={allInstances.includes(vinculoInstance) ? vinculoInstance : ""}
                          onChange={e => {
                             const v = e.target.value;
                             setVinculoInstance(v);
                             if (v && activeAgentId) saveVinculoInstant(v, activeAgentId);
                          }}
                          className="w-full bg-white/5 border-primary/20 text-white h-12 rounded-xl text-sm px-3 focus:outline-none focus:ring-1 focus:ring-primary/50"
                        >
                           <option value="" className="bg-neutral-900 text-muted-foreground">
                             {allInstances.length === 0 ? "Carregando instâncias…" : "Selecione uma instância…"}
                           </option>
                           {allInstances.map(inst => (
                              <option key={inst} value={inst} className="bg-neutral-900">{inst}</option>
                           ))}
                        </select>
                        {vinculoInstance && !allInstances.includes(vinculoInstance) && (
                          <p className="text-[9px] text-orange-400 mt-1 px-1">
                            ⚠ Instância salva (<code>{vinculoInstance}</code>) ainda não apareceu na lista — aguarde ou crie em /whatsapp.
                          </p>
                        )}
                        <p className="text-[9px] text-muted-foreground mt-1 px-1">
                           Cada agente usa <strong>uma</strong> instância. Trocar aqui transfere o vínculo.
                        </p>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                           <label className="text-[10px] font-black uppercase tracking-widest text-primary">Agrupamento de Mensagens</label>
                           <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">{messageBufferSeconds}s</span>
                        </div>
                        <NumberInput
                           min={0}
                           max={30}
                           fallback={0}
                           value={messageBufferSeconds}
                           onChange={n => setMessageBufferSeconds(n)}
                           className="w-full bg-white/5 border-primary/20 text-white h-12 rounded-xl text-sm px-3 focus:outline-none focus:ring-1 focus:ring-primary/50"
                           placeholder="Ex: 5"
                        />
                        <p className="text-[9px] text-muted-foreground mt-1 px-1">
                           Tempo em segundos que a Sarah aguarda novas mensagens do mesmo contato antes de responder tudo de uma vez. Use 0 para desativar.
                        </p>
                      </div>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                           <label className="text-[10px] font-black uppercase tracking-widest text-[#00ffcc]">Humanizar Respostas (Picotar)</label>
                           <div onClick={() => setHumanizeMessages(!humanizeMessages)} className={cn("w-12 h-6 rounded-full cursor-pointer transition-all duration-300 p-1 flex items-center relative", humanizeMessages ? "bg-[#00ffcc]" : "bg-white/10")}>
                             <div className={cn("w-4 h-4 rounded-full bg-white transition-all shadow-md", humanizeMessages ? "translate-x-6" : "")} />
                           </div>
                        </div>
                        <p className="text-[9px] text-muted-foreground mt-1 px-1">
                           Divide respostas longas em várias mensagens menores e simula tempo de digitação entre elas.
                        </p>
                      </div>

                      {/* Web Search MCP — opt-in, funciona em qualquer modelo */}
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                           <label className="text-[10px] font-black uppercase tracking-widest text-cyan-400">Pesquisar na internet (MCP)</label>
                           <div onClick={() => setWebSearchEnabled(!webSearchEnabled)} className={cn("w-12 h-6 rounded-full cursor-pointer transition-all duration-300 p-1 flex items-center relative", webSearchEnabled ? "bg-cyan-500" : "bg-white/10")}>
                             <div className={cn("w-4 h-4 rounded-full bg-white transition-all shadow-md", webSearchEnabled ? "translate-x-6" : "")} />
                           </div>
                        </div>
                        <p className="text-[9px] text-muted-foreground mt-1 px-1">
                           Habilita a tool <code className="text-cyan-300">web_search</code> (DuckDuckGo, sem chave). Funciona em qualquer modelo. Use quando precisar de fato/dado atualizado.
                        </p>
                      </div>
                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                           <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Função Principal</label>
                           <CopyButton text={funcaoAgente} />
                        </div>
                        <Textarea value={funcaoAgente} onChange={e => setFuncaoAgente(e.target.value)} className="bg-white/5 border-white/10 h-[100px] resize-none rounded-xl text-sm" />
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                         <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Personalidade</label>
                         <CopyButton text={personalidadeAgente} />
                      </div>
                      <Textarea value={personalidadeAgente} onChange={e => setPersonalidadeAgente(e.target.value)} className="bg-white/5 border-white/10 resize-none h-24 rounded-xl text-sm p-4" />
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                         <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Tom de Voz</label>
                         <CopyButton text={tomAgente} />
                      </div>
                      <Textarea value={tomAgente} onChange={e => setTomAgente(e.target.value)} className="bg-white/5 border-white/10 resize-none h-24 rounded-xl text-sm p-4" />
                    </div>
                  </div>

                  <Button onClick={saveIdentity} disabled={savingConfig} className="w-full h-11 rounded-xl glow-primary font-bold text-xs uppercase tracking-widest mt-4">Salvar Identidade</Button>
                  
                  <div className="pt-4 border-t border-white/5 space-y-4">
                     <div className="flex justify-between items-center bg-black/20 p-4 border border-white/5 rounded-2xl">
                        <div className="flex items-center gap-3">
                           <div className="p-2 bg-blue-500/10 text-blue-400 rounded-xl"><Settings className="w-4 h-4" /></div>
                           <div><h4 className="font-bold text-sm text-white">Google Calendar (MCP Tool)</h4><p className="text-xs text-muted-foreground mt-0.5">Permite a IA agendar reuniões ativamente.</p></div>
                        </div>
                        <div onClick={() => setCalendarEnabled(!calendarEnabled)} className={cn("w-12 h-6 rounded-full cursor-pointer transition-all duration-300 p-1 flex items-center relative", calendarEnabled ? "bg-blue-500" : "bg-white/10")}>
                           <div className={cn("w-4 h-4 rounded-full bg-white transition-all", calendarEnabled ? "translate-x-6" : "")} />
                        </div>
                     </div>

                     {calendarEnabled && (
                        <div className="bg-white/5 p-4 rounded-xl border border-white/10 animate-in fade-in duration-300 space-y-4">
                           <div>
                              <div className="flex items-center justify-between gap-2 mb-2">
                                 <label className="text-[10px] font-black uppercase tracking-widest text-blue-400">OAuth Web Client JSON</label>
                                 <CopyButton text={googleJson} />
                              </div>
                              <Textarea value={googleJson} onChange={e => setGoogleJson(e.target.value)} placeholder='{"web": {"client_id": "...", "client_secret": "..."}}' className="h-24 bg-black/40 border-white/10 text-xs font-mono text-white/70" />
                           </div>

                           {/* DURAÇÃO PADRÃO */}
                           <div className="space-y-2 pt-4 border-t border-white/5">
                              <label className="text-[10px] font-black uppercase tracking-widest text-blue-400">Duração padrão da reunião</label>
                              <div className="flex gap-2 items-center">
                                <NumberInput
                                  min={5}
                                  max={480}
                                  fallback={30}
                                  value={calendarDefaultDuration}
                                  onChange={n => setCalendarDefaultDuration(n)}
                                  className="bg-black/40 border-white/10 text-sm h-10 w-28 font-mono"
                                />
                                <span className="text-[10px] text-muted-foreground uppercase font-bold">minutos por evento</span>
                              </div>
                              <p className="text-[9px] text-muted-foreground">A IA usa esse valor por padrão. Cliente pode pedir outra duração na conversa.</p>
                           </div>

                           {/* GERAR MEET */}
                           <div className="flex items-center justify-between gap-3 p-2 bg-black/30 rounded-lg border border-white/5">
                              <div>
                                 <p className="text-[11px] font-bold text-white">Gerar link do Google Meet</p>
                                 <p className="text-[9px] text-muted-foreground">Cria sala virtual automaticamente em todo evento</p>
                              </div>
                              <div onClick={() => setCalendarGenerateMeet(!calendarGenerateMeet)} className={cn("w-10 h-5 rounded-full cursor-pointer p-0.5 flex items-center transition-all", calendarGenerateMeet ? "bg-blue-500" : "bg-white/10")}>
                                 <div className={cn("w-4 h-4 rounded-full bg-white transition-all", calendarGenerateMeet ? "translate-x-5" : "")} />
                              </div>
                           </div>

                           {/* CAMPOS OPCIONAIS COMO CHECKBOXES */}
                           <div className="space-y-2 pt-4 border-t border-white/5">
                              <label className="text-[10px] font-black uppercase tracking-widest text-blue-400">Perguntas diretas ao cliente</label>
                              <p className="text-[9px] text-muted-foreground -mt-1">Marque quais informações a IA deve <strong>perguntar diretamente</strong> ao cliente antes de agendar.</p>
                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                                {CALENDAR_FIELDS.map(f => {
                                   const checked = !!calendarOptionalFields[f.key];
                                   return (
                                     <label
                                       key={f.key}
                                       onClick={() => setCalendarOptionalFields(prev => ({ ...prev, [f.key]: !checked }))}
                                       className={cn(
                                         "flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all",
                                         checked ? "bg-blue-500/10 border-blue-500/30" : "bg-black/20 border-white/5 hover:border-white/20"
                                       )}
                                     >
                                       <div className={cn("w-4 h-4 rounded border-2 flex items-center justify-center shrink-0 mt-0.5", checked ? "bg-blue-500 border-blue-500" : "border-white/20")}>
                                         {checked && <Check className="w-3 h-3 text-white" />}
                                       </div>
                                       <div className="min-w-0">
                                         <p className={cn("text-[11px] font-bold", checked ? "text-blue-200" : "text-white/80")}>{f.label}</p>
                                         <p className="text-[9px] text-muted-foreground">{f.hint}</p>
                                       </div>
                                     </label>
                                   );
                                })}
                              </div>

                              {/* Captura automática (toggleable) */}
                              <div className="mt-3 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/15 space-y-2">
                                <p className="text-[10px] font-black uppercase tracking-widest text-emerald-400">Captura automática (sem perguntar)</p>
                                {[
                                  { key: "telefone" as const,    label: "Telefone",          desc: "Número do WhatsApp da conversa vai pra descrição do evento" },
                                  { key: "empresa" as const,     label: "Empresa",           desc: "IA infere da conversa se for mencionada" },
                                  { key: "necessidade" as const, label: "Dor / Necessidade", desc: "IA resume o motivo do contato com base no histórico" },
                                ].map(item => {
                                  const on = calendarAutoCapture[item.key];
                                  return (
                                    <div key={item.key} className="flex items-center justify-between gap-3 py-1">
                                      <div className="min-w-0">
                                        <p className={cn("text-[11px] font-bold", on ? "text-emerald-200" : "text-muted-foreground")}>{item.label}</p>
                                        <p className="text-[9px] text-emerald-100/50">{item.desc}</p>
                                      </div>
                                      <div
                                        onClick={() => setCalendarAutoCapture(p => ({ ...p, [item.key]: !on }))}
                                        className={cn(
                                          "w-9 h-5 rounded-full cursor-pointer p-0.5 flex items-center transition-all shrink-0",
                                          on ? "bg-emerald-500" : "bg-white/10"
                                        )}
                                      >
                                        <div className={cn("w-4 h-4 rounded-full bg-white transition-all", on ? "translate-x-4" : "")} />
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                           </div>

                           {/* PREVIEW DO QUE VAI PRO PROMPT */}
                           <div className="space-y-2 pt-4 border-t border-white/5">
                              <label className="text-[10px] font-black uppercase tracking-widest text-purple-400">Regras auto-injetadas no prompt</label>
                              <div className="bg-black/40 rounded-lg p-3 border border-purple-500/20 space-y-1.5">
                                 <p className="text-[10px] text-purple-200/80 font-mono leading-relaxed">
                                   • Quando o cliente quiser marcar/agendar, SEMPRE chame <code className="text-purple-300">check_google_calendar_availability</code> antes de sugerir horários.
                                   {Object.values(calendarOptionalFields).some(Boolean) && (
                                     <> Antes de agendar, OBTENHA: {Object.entries(calendarOptionalFields).filter(([, v]) => v).map(([k]) => k).join(", ")}.</>
                                   )}
                                 </p>
                                 <p className="text-[10px] text-purple-200/80 font-mono leading-relaxed">
                                   • Para CRIAR o evento, chame <code className="text-purple-300">schedule_google_calendar</code> com duração padrão de <strong>{calendarDefaultDuration} min</strong>.
                                   {calendarGenerateMeet && " Link do Meet será gerado automaticamente."}
                                 </p>
                              </div>
                              <p className="text-[9px] text-muted-foreground italic">Você não precisa escrever isso no prompt — o sistema injeta automaticamente.</p>
                           </div>

                           <Button onClick={saveCalendarConfig} className="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs h-10 rounded-lg">Salvar Configurações de Agenda</Button>
                        </div>
                     )}
                  </div>

                  <div className="pt-4 border-t border-white/5 space-y-6">
                     <div className="flex items-center justify-between gap-2">
                        <label className="text-[10px] font-black uppercase tracking-widest text-[#00ffcc]">Webhook do Agente (Cole na Evolution API v2)</label>
                        <div className="flex gap-2">
                           <Button
                              onClick={async () => {
                                 if (!vinculoInstance) return alert("Vincule uma instância primeiro!");
                                 try {
                                    // 1) Determina a URL pública a salvar — prioriza o que o user
                                    //    está acessando AGORA (window.location.origin) sobre tudo,
                                    //    porque é o único valor garantido de estar correto.
                                    const detectedUrl = (typeof window !== "undefined" ? window.location.origin : "") || appUrl;

                                    // 2) Chama o endpoint que registra o webhook na Evolution E
                                    //    persiste app_settings.public_url + agent_settings.options.app_url
                                    //    no mesmo request (sem precisar clicar Salvar em outro lugar).
                                    const res = await fetch("/api/webhooks/register", {
                                       method: "POST",
                                       headers: { "Content-Type": "application/json" },
                                       body: JSON.stringify({
                                          instanceName: vinculoInstance,
                                          appUrl: detectedUrl,
                                          agentId: activeAgentId
                                       })
                                    });
                                    const data = await res.json();
                                    if (data.success) {
                                       // Atualiza UI imediatamente com a URL persistida.
                                       const base: string = data.appUrl || (data.webhookUrl ? data.webhookUrl.split("/api/webhooks/")[0] : "");
                                       if (base) {
                                          setAppUrl(base);
                                          if (typeof window !== "undefined") {
                                             window.dispatchEvent(new CustomEvent("public-url-changed", { detail: { url: base } }));
                                          }
                                       }
                                       alert("Sincronizado e salvo!\nWebhook: " + (data.webhookUrl || "") + "\nApp URL: " + base);
                                    } else {
                                       alert("Erro: " + data.error);
                                    }
                                 } catch (e: any) {
                                    alert("Erro ao sincronizar: " + e.message);
                                 }
                              }}
                              className="h-7 px-3 bg-primary/10 text-primary border border-primary/20 hover:bg-primary/20 text-[9px] font-black uppercase tracking-widest"
                           >
                              Sincronizar Agora
                           </Button>
                           <CopyButton text={webhookUrl} label="Copiar" />
                        </div>
                     </div>
                     <div className="relative group">
                        <Input readOnly value={webhookUrl} className="bg-black/40 border-white/10 text-xs font-mono h-12 pr-12 w-full" />
                     </div>

                     {/* Guia visual: como configurar no painel da Evolution */}
                     <div className="rounded-2xl border border-white/10 bg-gradient-to-br from-[#00ffcc]/5 via-transparent to-purple-500/5 overflow-hidden">
                        <div className="px-5 py-4 border-b border-white/5 bg-black/30">
                           <div className="flex items-center gap-3">
                              <div className="p-2 rounded-lg bg-[#00ffcc]/10 border border-[#00ffcc]/20">
                                 <Wrench className="w-4 h-4 text-[#00ffcc]" />
                              </div>
                              <div>
                                 <p className="text-xs font-black uppercase tracking-widest text-white">Como ligar o Webhook na Evolution API</p>
                                 <p className="text-[10px] text-muted-foreground mt-0.5">Passo a passo. Se clicar em <strong>Sincronizar Agora</strong> o sistema já faz tudo isso automaticamente — este guia é só caso queira conferir manualmente no painel.</p>
                              </div>
                           </div>
                        </div>

                        <div className="p-5 space-y-4">
                           {/* Passo 1 */}
                           <div className="flex gap-3">
                              <div className="w-7 h-7 rounded-full bg-[#00ffcc]/10 border border-[#00ffcc]/30 text-[#00ffcc] font-black text-xs flex items-center justify-center shrink-0">1</div>
                              <div className="space-y-1">
                                 <p className="text-[11px] font-bold text-white">Abra sua instância no painel da Evolution e vá em <span className="text-[#00ffcc]">Webhook</span></p>
                                 <p className="text-[10px] text-muted-foreground">Dentro de cada instância existe uma aba "Webhook". É lá que a gente cola a URL do painel.</p>
                              </div>
                           </div>

                           {/* Passo 2 — Enabled */}
                           <div className="flex gap-3">
                              <div className="w-7 h-7 rounded-full bg-[#00ffcc]/10 border border-[#00ffcc]/30 text-[#00ffcc] font-black text-xs flex items-center justify-center shrink-0">2</div>
                              <div className="space-y-1.5">
                                 <p className="text-[11px] font-bold text-white">Ative <span className="text-emerald-400">Enabled</span> (liga o webhook)</p>
                                 <div className="flex items-center gap-2 text-[10px] bg-black/30 rounded-lg px-3 py-2 border border-white/5">
                                    <span className="inline-block w-8 h-4 rounded-full bg-emerald-500/70 relative"><span className="absolute right-0.5 top-0.5 w-3 h-3 rounded-full bg-white" /></span>
                                    <span className="font-mono text-emerald-300">Webhook Enabled: ON</span>
                                 </div>
                              </div>
                           </div>

                           {/* Passo 3 — URL */}
                           <div className="flex gap-3">
                              <div className="w-7 h-7 rounded-full bg-[#00ffcc]/10 border border-[#00ffcc]/30 text-[#00ffcc] font-black text-xs flex items-center justify-center shrink-0">3</div>
                              <div className="space-y-1.5 flex-1 min-w-0">
                                 <p className="text-[11px] font-bold text-white">Cole a URL exata que está no campo acima ⬆️</p>
                                 <div className="text-[10px] bg-black/30 rounded-lg px-3 py-2 border border-white/5 font-mono text-[#00ffcc] truncate">{webhookUrl}</div>
                              </div>
                           </div>

                           {/* Passo 4 — Webhook by Events */}
                           <div className="flex gap-3">
                              <div className="w-7 h-7 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 font-black text-xs flex items-center justify-center shrink-0">4</div>
                              <div className="space-y-1.5">
                                 <p className="text-[11px] font-bold text-white">Deixe <span className="text-red-400">Webhook by Events: OFF</span> — <span className="text-muted-foreground font-normal">IMPORTANTE</span></p>
                                 <div className="flex items-center gap-2 text-[10px] bg-black/30 rounded-lg px-3 py-2 border border-red-500/20">
                                    <span className="inline-block w-8 h-4 rounded-full bg-white/10 relative"><span className="absolute left-0.5 top-0.5 w-3 h-3 rounded-full bg-white/70" /></span>
                                    <span className="font-mono text-red-300">Webhook by Events: OFF</span>
                                 </div>
                                 <p className="text-[10px] text-muted-foreground">Se ligar, a Evolution cria uma URL diferente pra cada evento (ex: /api/webhooks/whatsapp/messages-upsert) e o painel não consegue receber. Deixe OFF.</p>
                              </div>
                           </div>

                           {/* Passo 5 — Base64 */}
                           <div className="flex gap-3">
                              <div className="w-7 h-7 rounded-full bg-purple-500/10 border border-purple-500/30 text-purple-400 font-black text-xs flex items-center justify-center shrink-0">5</div>
                              <div className="space-y-1.5">
                                 <p className="text-[11px] font-bold text-white">Ative <span className="text-emerald-400">Webhook Base64: ON</span> — <span className="text-muted-foreground font-normal">recomendado</span></p>
                                 <div className="flex items-center gap-2 text-[10px] bg-black/30 rounded-lg px-3 py-2 border border-white/5">
                                    <span className="inline-block w-8 h-4 rounded-full bg-emerald-500/70 relative"><span className="absolute right-0.5 top-0.5 w-3 h-3 rounded-full bg-white" /></span>
                                    <span className="font-mono text-emerald-300">Webhook Base64: ON</span>
                                 </div>
                                 <p className="text-[10px] text-muted-foreground">Envia imagens, áudios e documentos já decodificados no webhook. Sem isso, o painel precisa fazer uma segunda chamada pra baixar cada mídia (mais lento e pode falhar).</p>
                              </div>
                           </div>

                           {/* Passo 6 — Events */}
                           <div className="flex gap-3">
                              <div className="w-7 h-7 rounded-full bg-blue-500/10 border border-blue-500/30 text-blue-400 font-black text-xs flex items-center justify-center shrink-0">6</div>
                              <div className="space-y-2 flex-1">
                                 <p className="text-[11px] font-bold text-white">Marque APENAS estes <span className="text-blue-400">5 eventos</span> (o resto deixe desmarcado)</p>
                                 <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                                    {[
                                       { name: "MESSAGES_UPSERT", why: "Chega msg nova → IA responde" },
                                       { name: "MESSAGES_UPDATE", why: "Status entregue/lido" },
                                       { name: "MESSAGES_DELETE", why: "Msg apagada aparece no chat" },
                                       { name: "SEND_MESSAGE", why: "Rastrear o que o operador enviou" },
                                       { name: "CONNECTION_UPDATE", why: "Banner de reconectar no painel" },
                                    ].map(ev => (
                                       <div key={ev.name} className="flex items-center gap-2 bg-black/30 rounded-lg px-2.5 py-1.5 border border-blue-500/10">
                                          <span className="w-3 h-3 rounded border border-blue-500/60 bg-blue-500/20 flex items-center justify-center shrink-0">
                                             <Check className="w-2 h-2 text-blue-300" />
                                          </span>
                                          <div className="min-w-0">
                                             <p className="text-[10px] font-mono text-blue-200 truncate">{ev.name}</p>
                                             <p className="text-[9px] text-muted-foreground truncate">{ev.why}</p>
                                          </div>
                                       </div>
                                    ))}
                                 </div>
                                 <p className="text-[10px] text-muted-foreground italic">
                                    Deixe <strong>desmarcados</strong>: CHATS_*, CONTACTS_*, GROUPS_*, LABELS_*, PRESENCE_UPDATE, QRCODE_UPDATED, TYPEBOT_*, CALL, APPLICATION_STARTUP, LOGOUT/REMOVE_INSTANCE. Se marcar esses o webhook recebe eventos demais e o sistema fica lento sem ganho.
                                 </p>
                              </div>
                           </div>

                           {/* Passo 7 — Salvar */}
                           <div className="flex gap-3">
                              <div className="w-7 h-7 rounded-full bg-[#00ffcc]/10 border border-[#00ffcc]/30 text-[#00ffcc] font-black text-xs flex items-center justify-center shrink-0">7</div>
                              <div className="space-y-1">
                                 <p className="text-[11px] font-bold text-white">Clique em <span className="text-emerald-400">Save</span> na Evolution</p>
                                 <p className="text-[10px] text-muted-foreground">Pronto. A Evolution agora vai mandar cada mensagem recebida pra este painel em tempo real. Pode testar enviando uma mensagem pro WhatsApp dessa instância.</p>
                              </div>
                           </div>

                           {/* Atalho */}
                           <div className="mt-3 p-3 rounded-xl bg-[#00ffcc]/5 border border-[#00ffcc]/20 flex items-start gap-2">
                              <Sparkles className="w-4 h-4 text-[#00ffcc] shrink-0 mt-0.5" />
                              <p className="text-[10px] text-[#00ffcc]/90 leading-relaxed">
                                 <strong className="text-[#00ffcc]">Atalho:</strong> clique em <strong>Sincronizar Agora</strong> acima. O painel chama a API da Evolution e configura tudo (URL, Events, Base64) automaticamente. Só use este guia se quiser conferir manualmente.
                              </p>
                           </div>
                        </div>
                     </div>
                  </div>
                </section>

                <section className="glass-card p-6 md:p-8 rounded-[2rem] border-white/10 space-y-5 bg-white/[0.02]">
                  {/* === Toolbar do prompt: título + métricas + ações === */}
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                     <div className="flex items-center gap-3">
                       <h3 className="text-lg font-black tracking-tight">Prompt Principal</h3>
                       <span className="text-[10px] font-mono text-muted-foreground bg-white/5 border border-white/10 rounded-md px-2 py-0.5">
                         {prompt.length.toLocaleString("pt-BR")} chars · {prompt.split(/\s+/).filter(Boolean).length} palavras
                       </span>
                     </div>
                     <div className="flex items-center gap-2">
                       <CopyButton text={prompt} label="Copiar" />
                       <Button onClick={savePrompt} disabled={savingConfig} variant="ghost" className="h-9 rounded-xl px-3 text-primary hover:bg-primary/10 font-bold text-xs uppercase tracking-widest gap-2"><Save className="w-4 h-4" /> Salvar</Button>
                     </div>
                  </div>

                  <p className="text-[11px] text-muted-foreground -mt-2">
                    Clique ou arraste qualquer chip pra dentro do editor. As variáveis são substituídas em runtime.
                  </p>

                  {/* === Chips: variáveis dinâmicas (collapsible) === */}
                  <details open className="group rounded-xl bg-cyan-500/5 border border-cyan-500/15 overflow-hidden">
                     <summary className="flex items-center justify-between gap-2 px-3 py-2 cursor-pointer hover:bg-cyan-500/[0.08] transition list-none">
                        <div className="flex items-center gap-2">
                           <span className="text-cyan-400 transition-transform group-open:rotate-90 inline-block w-3 text-center">▶</span>
                           <p className="text-[10px] font-black uppercase tracking-widest text-cyan-400">Variáveis dinâmicas</p>
                           <span className="text-[9px] font-mono text-cyan-300/70 bg-cyan-500/10 px-1.5 py-0.5 rounded">11</span>
                        </div>
                        <p className="text-[9px] text-muted-foreground italic hidden md:block">Trocadas em runtime — saudação muda com a hora</p>
                     </summary>
                     <div className="flex flex-wrap gap-2 p-3 pt-0">
                        {[
                          { key: "saudacao",      label: "Saudação",     hint: "Bom dia/Boa tarde/Boa noite/Boa madrugada (hora SP)" },
                          { key: "nome",          label: "Nome",         hint: "Push name do WhatsApp (com fallback pra empresa)" },
                          { key: "nome_empresa",  label: "Nome empresa", hint: "Do CRM (leads_extraidos.nome_negocio)" },
                          { key: "primeiro_nome", label: "1ª palavra",   hint: "Primeira palavra do nome da empresa" },
                          { key: "ramo",          label: "Ramo",         hint: "Ramo de negócio do CRM" },
                          { key: "categoria",     label: "Categoria",    hint: "Categoria do lead (Google)" },
                          { key: "endereco",      label: "Endereço",     hint: "Endereço do lead" },
                          { key: "website",       label: "Website",      hint: "Site do lead" },
                          { key: "telefone",      label: "Telefone",     hint: "Número limpo do WhatsApp" },
                          { key: "data",          label: "Data",         hint: "Data atual" },
                          { key: "hora",          label: "Hora",         hint: "Hora atual" },
                        ].map(v => (
                          <button
                            key={v.key}
                            type="button"
                            onClick={() => insertVariable(v.key)}
                            draggable
                            onDragStart={(e) => e.dataTransfer.setData("text/plain", `{{${v.key}}}`)}
                            className="group/chip flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 hover:bg-cyan-500/20 hover:scale-[1.03] active:scale-95 transition-all cursor-grab active:cursor-grabbing"
                            title={v.hint}
                          >
                            <span className="text-[11px] font-bold text-cyan-100">{v.label}</span>
                            <code className="text-[9px] font-mono text-cyan-300/70">{`{{${v.key}}}`}</code>
                          </button>
                        ))}
                     </div>
                  </details>

                  {/* === Chips: KB (collapsible) === */}
                  {knowledge.length > 0 && (
                    <details open className="group rounded-xl bg-purple-500/5 border border-purple-500/15 overflow-hidden">
                       <summary className="flex items-center justify-between gap-2 px-3 py-2 cursor-pointer hover:bg-purple-500/[0.08] transition list-none">
                          <div className="flex items-center gap-2">
                             <span className="text-purple-400 transition-transform group-open:rotate-90 inline-block w-3 text-center">▶</span>
                             <p className="text-[10px] font-black uppercase tracking-widest text-purple-400">Variáveis de conhecimento</p>
                             <span className="text-[9px] font-mono text-purple-300/70 bg-purple-500/10 px-1.5 py-0.5 rounded">{knowledge.length}</span>
                          </div>
                          <p className="text-[9px] text-muted-foreground italic hidden md:block">Clique pra inserir no cursor (ou arraste)</p>
                       </summary>
                       <div className="px-3 pb-3 space-y-2">
                          <div className="flex flex-wrap gap-2">
                             {knowledge.map(k => (
                               <button
                                 key={k.id}
                                 type="button"
                                 onClick={() => insertKbVariable(k.title)}
                                 draggable
                                 onDragStart={(e) => e.dataTransfer.setData("text/plain", `{{kb:${k.title}}}`)}
                                 className="group/chip flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-500/10 border border-purple-500/30 hover:bg-purple-500/20 hover:scale-[1.03] active:scale-95 transition-all cursor-grab active:cursor-grabbing"
                                 title={`Insere {{kb:${k.title}}} no prompt`}
                               >
                                 <Book className="w-3 h-3 text-purple-300" />
                                 <span className="text-[11px] font-bold text-purple-100">{k.title}</span>
                                 <code className="text-[9px] font-mono text-purple-300/70 group-hover/chip:text-purple-300">{`{{kb}}`}</code>
                               </button>
                             ))}
                          </div>
                          <p className="text-[9px] text-purple-200/60 leading-relaxed">
                            Onde aparecer <code className="bg-black/30 px-1 rounded text-purple-300">{`{{kb:Título}}`}</code>, o sistema substitui por uma regra que faz a IA chamar
                            <span className="font-mono text-purple-300"> search_knowledge_base</span>. KBs que você não inserir manualmente continuam ativas (auto-injetadas no topo).
                          </p>
                       </div>
                    </details>
                  )}

                  {/* === Editor (textarea) === */}
                  <div className="rounded-2xl bg-[#0a0a0a] border border-white/10 overflow-hidden shadow-inner">
                    <div className="flex items-center justify-between gap-2 px-4 py-2 border-b border-white/5 bg-white/[0.02]">
                      <p className="text-[10px] font-black uppercase tracking-widest text-white/60">Editor — prompt cru</p>
                      <p className="text-[9px] text-muted-foreground font-mono">
                        arraste chips ou digite • redimensione pelo canto
                      </p>
                    </div>
                    {/* Drop NATIVO do navegador: a variável cai exatamente na posição do mouse. */}
                    <Textarea
                      ref={promptRef}
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      className="min-h-[200px] sm:min-h-[320px] max-h-[60vh] font-mono text-sm bg-transparent border-0 rounded-none p-5 leading-relaxed resize-y focus:ring-0 focus:border-0 focus-visible:ring-0"
                    />
                  </div>

                  {/* ========================================================
                       PRÉ-VISUALIZAÇÃO: como o prompt chega na IA depois das
                       substituições. Mostra com lead de exemplo + KBs já
                       referenciadas. Resolve {{...}} e {{kb:...}}.
                  ======================================================== */}
                  <PromptPreview
                    rawPrompt={prompt}
                    sample={previewSample}
                    setSample={setPreviewSample}
                    knowledge={knowledge}
                    open={previewOpen}
                    setOpen={setPreviewOpen}
                    leads={previewLeads}
                    leadsLoading={previewLeadsLoading}
                    onOpenLeadPicker={() => { if (previewLeads.length === 0) loadPreviewLeads(); }}
                    selectedLeadId={previewSelectedLeadId}
                    onSelectLead={applyLeadToSample}
                    leadQuery={previewLeadQuery}
                    setLeadQuery={setPreviewLeadQuery}
                  />
                </section>

                <section className="space-y-6">
                  <div className="flex items-center justify-between">
                    <div>
                      <h3 className="text-lg font-black tracking-tight">Base de Conhecimento</h3>
                      <p className="text-xs text-muted-foreground mt-1">
                        Funciona como uma <strong>tool</strong>: a IA consulta só quando o cliente perguntar sobre o tópico — não sobrecarrega o prompt.
                      </p>
                    </div>
                    <Button onClick={() => setShowNovoK(!showNovoK)} variant="outline" className="h-11 bg-primary/10 border-primary/20 text-primary hover:bg-primary/20 rounded-xl px-6 font-bold text-xs uppercase tracking-widest"><Plus className="w-4 h-4 mr-2" /> Nova Base</Button>
                  </div>

                  {/* Bloco explicativo de como funciona */}
                  {knowledge.length > 0 && (
                    <div className="p-4 rounded-2xl bg-purple-500/5 border border-purple-500/15 space-y-2">
                      <div className="flex items-center gap-2">
                        <Wrench className="w-3.5 h-3.5 text-purple-400" />
                        <p className="text-[10px] font-black uppercase tracking-widest text-purple-400">Como a IA usa essa base</p>
                      </div>
                      <p className="text-[11px] text-purple-100/70 leading-relaxed">
                        Cada item abaixo vira um <strong>tópico-gatilho</strong>. Quando o cliente perguntar sobre ele, a IA chama
                        a tool <code className="text-purple-300 bg-black/30 px-1 rounded">search_knowledge_base</code> com a query
                        do tópico — assim ela só lê o conteúdo na hora certa, sem gastar tokens à toa.
                      </p>
                    </div>
                  )}

                  {showNovoK && (
                     <div className="p-6 bg-white/5 border border-white/10 rounded-2xl space-y-4">
                        <div className="space-y-1">
                          <label className="text-[10px] font-black uppercase tracking-widest text-primary">Título (vira o gatilho)</label>
                          <Input value={novoKTitle} onChange={e => setNovoKTitle(e.target.value)} placeholder="Ex: Preço, Garantia, Horário de Atendimento..." className="bg-black/50 border-white/10" />
                          <p className="text-[9px] text-muted-foreground">Use 1-2 palavras. Quando o cliente mencionar isso, a IA consulta o conteúdo abaixo.</p>
                        </div>
                        <div className="space-y-1">
                          <label className="text-[10px] font-black uppercase tracking-widest text-primary">Conteúdo</label>
                          <Textarea value={novoKContent} onChange={e => setNovoKContent(e.target.value)} placeholder="Resposta detalhada que a IA verá quando consultar esse tópico..." className="bg-black/50 border-white/10 h-32 resize-none" />
                        </div>
                        <Button onClick={salvarNovoKnowledge} className="glow-primary w-full">Adicionar ao Conhecimento</Button>
                     </div>
                  )}
                  <div className="space-y-3">
                    {knowledge.map(k => (
                       <div key={k.id} className="glass-panel border-white/10 rounded-2xl p-4 hover:bg-white/5 transition-colors group bg-white/[0.01]">
                          {editKId === k.id ? (
                            <div className="space-y-3">
                              <div className="space-y-1">
                                <label className="text-[10px] font-black uppercase tracking-widest text-primary">Título</label>
                                <Input value={editKTitle} onChange={e => setEditKTitle(e.target.value)} className="bg-black/50 border-white/10" />
                              </div>
                              <div className="space-y-1">
                                <label className="text-[10px] font-black uppercase tracking-widest text-primary">Conteúdo</label>
                                <Textarea value={editKContent} onChange={e => setEditKContent(e.target.value)} className="bg-black/50 border-white/10 h-32 resize-none" />
                              </div>
                              <div className="flex gap-2">
                                <Button onClick={salvarEdicaoKnowledge} className="flex-1 gap-2"><Save className="w-4 h-4" /> Salvar alterações</Button>
                                <Button onClick={cancelarEdicaoKnowledge} variant="outline" className="gap-2"><X className="w-4 h-4" /> Cancelar</Button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="flex items-center justify-between gap-3">
                                <div className="flex items-start gap-4 min-w-0">
                                  <div className="p-3 bg-blue-500/10 text-blue-400 rounded-xl shrink-0"><Book className="w-5 h-5" /></div>
                                  <div className="min-w-0">
                                    <h4 className="font-bold text-sm truncate">{k.title}</h4>
                                    <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{(k.content || "").substring(0, 80)}...</p>
                                  </div>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  <Button onClick={() => iniciarEdicaoKnowledge(k)} size="icon" variant="ghost" className="h-8 w-8 text-blue-400 hover:text-blue-300 hover:bg-blue-500/10 rounded-lg" title="Editar"><Pencil className="w-4 h-4" /></Button>
                                  <Button onClick={() => deletarKnowledge(k.id)} size="icon" variant="ghost" className="h-8 w-8 text-red-500 hover:text-red-400 hover:bg-red-500/10 rounded-lg" title="Excluir"><Trash2 className="w-4 h-4" /></Button>
                                </div>
                              </div>
                              {/* Preview da regra auto-injetada */}
                              <div className="mt-3 pt-3 border-t border-white/5">
                                <p className="text-[9px] font-black uppercase tracking-widest text-purple-400 mb-1">Como é usada</p>
                                <code className="block text-[10px] text-purple-200/80 font-mono bg-black/30 p-2 rounded leading-relaxed">
                                  Disponível como tool <span className="text-purple-300">search_knowledge_base</span>(query=&quot;{k.title}&quot;). A IA consulta sob demanda — sem gastar tokens no prompt.
                                </code>
                              </div>
                            </>
                          )}
                       </div>
                    ))}
                  </div>
                </section>
              </div>
            )}

            {activeTab === "ajustes" && (
                <section className="glass-card p-8 rounded-[2rem] border-white/10 space-y-6 bg-white/[0.02]">
                    <div className="flex items-center gap-3 border-b border-white/10 pb-6 mb-6">
                       <div className="p-3 bg-primary/20 text-primary rounded-xl shrink-0"><Clock className="w-6 h-6" /></div>
                       <div><h3 className="text-lg font-black tracking-tight">Modo de atendimento</h3><p className="text-xs text-muted-foreground mt-1">Defina quando a IA deve responder.</p></div>
                    </div>
                    <div className="flex items-center justify-between border-b border-white/5 pb-4">
                        <div onClick={() => setIs24h(!is24h)} className="flex items-center gap-3 cursor-pointer group bg-white/5 px-4 py-2 rounded-2xl border border-white/5 hover:border-white/10 transition-all">
                           <div className={cn("w-2 h-2 rounded-full", is24h ? "bg-green-500" : "bg-red-500")}></div>
                           <span className={cn("text-[10px] font-black uppercase tracking-widest", is24h ? "text-green-500" : "text-red-500")}>{is24h ? "Ativado 24h" : "Horário Comercial"}</span>
                           <div className={cn("w-10 h-5 rounded-full relative transition-all", is24h ? "bg-green-500/20" : "bg-red-500/20")}>
                              <div className={cn("absolute top-0.5 w-4 h-4 rounded-full transition-all bg-white", is24h ? "left-[22px]" : "left-0.5")} />
                           </div>
                        </div>
                    </div>
                    {!is24h && (
                        <div className="space-y-2 border border-white/10 rounded-[1.5rem] bg-black/20 overflow-hidden">
                           {schedules.map((row, idx) => (
                             <div key={row.day} className="grid grid-cols-12 gap-4 px-6 py-4 items-center border-b border-white/5 last:border-0 hover:bg-white/[0.02] transition-colors">
                                <div className="col-span-4 font-bold text-sm text-white/90">{row.day}</div>
                                <div className="col-span-8 flex items-center gap-6">
                                   <div onClick={() => { const ns = [...schedules]; ns[idx].active = !ns[idx].active; setSchedules(ns); }} className={cn("w-10 h-5 rounded-full relative cursor-pointer", row.active ? "bg-green-500" : "bg-white/10")}>
                                      <div className={cn("absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all shadow-sm", row.active ? "translate-x-[22px]" : "")}></div>
                                   </div>
                                   <div className="flex-1 flex gap-2">
                                      <Input type="time" disabled={!row.active} className="bg-white/5 border-white/10 h-10 w-full text-sm rounded-xl focus:bg-white/10" value={row.start} onChange={e => { const ns = [...schedules]; ns[idx].start = e.target.value; setSchedules(ns); }} />
                                      <Input type="time" disabled={!row.active} className="bg-white/5 border-white/10 h-10 w-full text-sm rounded-xl focus:bg-white/10" value={row.end} onChange={e => { const ns = [...schedules]; ns[idx].end = e.target.value; setSchedules(ns); }} />
                                   </div>
                                </div>
                             </div>
                           ))}
                        </div>
                    )}
                    <div className="mt-6 space-y-2 text-xs">
                        <label className="text-[10px] font-black uppercase tracking-widest text-primary">Mensagem de Ausência</label>
                        <Textarea value={awayMessage} onChange={e => setAwayMessage(e.target.value)} className="bg-black/40 border-white/10 rounded-2xl h-24 text-sm" />
                    </div>
                    <Button onClick={saveSchedules} disabled={savingConfig} className="w-full h-11 rounded-xl bg-primary text-black font-bold">Salvar Configurações</Button>
                </section>
            )}

            {activeTab === "etapas" && (
              <div className="space-y-6">
                <div className="flex items-center justify-between">
                  <div><h3 className="text-2xl font-black text-white">Etapas do Funil</h3></div>
                  <Button onClick={() => setShowNovoStage(!showNovoStage)} className="glow-primary h-11 px-6 font-bold text-xs">Nova Etapa</Button>
                </div>
                {showNovoStage && (
                   <div className="p-6 bg-white/5 border border-white/10 rounded-[2rem] space-y-4">
                      <Input value={novoStageTitle} onChange={e => setNovoStageTitle(e.target.value)} placeholder="Título da Etapa" className="bg-black/50 border-white/10" />
                      <Textarea value={novoStagePrompt} onChange={e => setNovoStagePrompt(e.target.value)} placeholder="Instrução..." className="bg-black/50 border-white/10 h-24" />
                      <Button onClick={salvarNovoStage} className="glow-primary w-full">Salvar Etapa</Button>
                   </div>
                )}
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                  <SortableContext items={stages.map(s => s.id)} strategy={verticalListSortingStrategy}>
                    <div className="grid grid-cols-1 gap-6">
                      {stages.map((stage, idx) => (
                         <SortableStage key={stage.id} stage={stage} idx={idx} stages={stages} setStages={setStages} deletarStage={deletarStage} />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              </div>
            )}

            {activeTab === "testes" && (
                <div className="flex flex-col gap-6">
                    <div className="bg-[#0b141a] border border-white/10 rounded-[2.5rem] p-6 shadow-2xl relative overflow-hidden">
                        <div className="absolute inset-0 bg-gradient-to-br from-cyan-500/[0.02] to-transparent pointer-events-none" />
                        <div className="relative z-10 space-y-4">
                            <div className="flex items-center justify-between gap-4 flex-wrap">
                               <div>
                                   <h4 className="font-bold text-white flex items-center gap-2"><FlaskConical className="w-5 h-5 text-cyan-400" /> Simulação de Lead / Disparo</h4>
                                   <p className="text-[10px] text-muted-foreground mt-1">Escolha um lead para preencher as variáveis e simular a primeira mensagem (Disparo Inicial).</p>
                               </div>
                           </div>
                           <LeadSelectorUI
                               sample={previewSample} setSample={setPreviewSample}
                               leads={previewLeads} leadsLoading={previewLeadsLoading}
                               selectedLeadId={previewSelectedLeadId} onSelectLead={applyLeadToSample}
                               leadQuery={previewLeadQuery} setLeadQuery={setPreviewLeadQuery}
                           />
                           {previewLeads.length === 0 ? (
                              <div className="text-center">
                                <Button onClick={loadPreviewLeads} className="bg-cyan-500 hover:bg-cyan-600 text-white font-bold text-[10px] h-7 px-4 rounded-full">Carregar Leads</Button>
                              </div>
                           ) : (
                              <div className="bg-black/30 p-4 rounded-xl border border-white/5 space-y-4 mt-4">
                                 <div>
                                    <label className="text-[10px] font-bold uppercase text-cyan-400 tracking-widest block mb-2">Template da Mensagem Inicial</label>
                                    
                                    <div className="flex flex-wrap gap-1.5 mb-2">
                                      {TEMPLATE_VARIABLES.map(v => (
                                        <button
                                          key={v.key}
                                          type="button"
                                          onClick={() => {
                                             setSandboxTemplate(prev => prev + `{{${v.key}}}`);
                                          }}
                                          draggable
                                          onDragStart={e => e.dataTransfer.setData("text/plain", `{{${v.key}}}`)}
                                          className="text-[10px] font-mono px-2 py-1 rounded-md bg-purple-500/10 border border-purple-500/30 text-purple-200 hover:bg-purple-500/20 transition-colors"
                                          title={v.hint}
                                        >
                                          {`{{${v.key}}}`}
                                        </button>
                                      ))}
                                    </div>

                                    <textarea
                                       value={sandboxTemplate}
                                       onChange={e => setSandboxTemplate(e.target.value)}
                                       onDragOver={e => e.preventDefault()}
                                       onDrop={e => {
                                         e.preventDefault();
                                         const v = e.dataTransfer.getData("text/plain");
                                         if (!v) return;
                                         const ta = e.currentTarget;
                                         const start = ta.selectionStart ?? sandboxTemplate.length;
                                         const end = ta.selectionEnd ?? sandboxTemplate.length;
                                         setSandboxTemplate(sandboxTemplate.slice(0, start) + v + sandboxTemplate.slice(end));
                                       }}
                                       className="w-full bg-[#202c33] border border-white/10 text-white font-mono text-xs p-3 rounded-xl min-h-[60px] focus:outline-none focus:border-cyan-500/50"
                                    />

                                    <div className="mt-2 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/15">
                                      <p className="text-[9px] uppercase font-black tracking-widest text-emerald-400 mb-1">Pré-visualização do Template Base</p>
                                      <p className="text-[11px] text-emerald-100/90 whitespace-pre-wrap font-mono">{previewSandboxMessage}</p>
                                      <p className="text-[9px] text-emerald-100/50 mt-2 italic">Saudação atual: <strong>{greetingFor()}</strong></p>
                                    </div>
                                 </div>
                                 
                                 <div className="flex items-center justify-between bg-[#202c33] p-3 rounded-xl border border-white/5">
                                    <div>
                                       <div className="text-xs font-bold text-white flex items-center gap-2">
                                          <Sparkles className="w-4 h-4 text-purple-400" /> Personalizar com IA
                                       </div>
                                       <div className="text-[10px] text-muted-foreground mt-1">
                                          Reescreve a mensagem usando o modelo definido (<span className="text-purple-300 font-mono">{targetModel}</span>)
                                       </div>
                                    </div>
                                    <label className="relative inline-flex items-center cursor-pointer">
                                      <input type="checkbox" className="sr-only peer" checked={sandboxPersonalizeAI} onChange={e => setSandboxPersonalizeAI(e.target.checked)} />
                                      <div className="w-9 h-5 bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-white/30 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-purple-500"></div>
                                    </label>
                                 </div>

                                 {sandboxPersonalizeAI && (
                                    <div className="space-y-4 animate-in fade-in slide-in-from-top-2 p-3 bg-purple-500/5 rounded-xl border border-purple-500/20">
                                       <div>
                                          <label className="text-[10px] font-bold uppercase text-purple-400 tracking-widest block mb-2">Prompt da IA</label>
                                          <textarea
                                             value={sandboxAiPrompt}
                                             onChange={e => setSandboxAiPrompt(e.target.value)}
                                             className="w-full bg-[#202c33] border border-purple-500/20 text-white text-xs p-3 rounded-xl min-h-[100px] focus:outline-none focus:border-purple-500/50"
                                          />
                                       </div>
                                       <div className="flex items-center justify-between bg-[#202c33] p-3 rounded-xl border border-purple-500/20">
                                          <div>
                                             <div className="text-[10px] font-bold text-white flex items-center gap-1"><Globe className="w-3 h-3 text-purple-400" /> Usar Web Search</div>
                                             <div className="text-[9px] text-muted-foreground mt-0.5">Permite à IA pesquisar na web informações da empresa do lead.</div>
                                          </div>
                                          <label className="relative inline-flex items-center cursor-pointer">
                                            <input type="checkbox" className="sr-only peer" checked={sandboxUseWebSearch} onChange={e => setSandboxUseWebSearch(e.target.checked)} />
                                            <div className="w-7 h-4 bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-white/30 after:border after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:bg-purple-500"></div>
                                          </label>
                                       </div>
                                    </div>
                                 )}

                                 <div className="flex justify-end pt-2">
                                    <Button
                                       onClick={simulateInitialMessage}
                                       disabled={sandboxSimulating || !previewSample.telefone}
                                       className="bg-cyan-500 hover:bg-cyan-600 text-white font-bold h-10 px-6 rounded-xl shadow-lg shadow-cyan-500/20"
                                    >
                                       {sandboxSimulating ? (
                                          <span className="flex items-center"><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Gerando Mensagem...</span>
                                       ) : (
                                          <span className="flex items-center"><Send className="w-4 h-4 mr-2" /> Disparar Primeira Mensagem</span>
                                       )}
                                    </Button>
                                 </div>
                              </div>
                           )}
                        </div>
                    </div>

                    <div className="flex flex-col md:flex-row gap-6 h-[550px]">
                        <div className="flex-1 bg-[#0b141a] border border-white/10 rounded-[2.5rem] overflow-hidden flex flex-col relative shadow-2xl">
                        <div className="bg-[#202c33] p-4 flex items-center justify-between border-b border-white/5">
                           <div className="flex items-center gap-3">
                              <Bot className="w-5 h-5 text-primary" />
                              <div>
                                 <h4 className="text-white font-medium text-sm">{nomeAgente} (Sandbox)</h4>
                                 <p className="text-[9px] text-white/40">
                                    Modelo: <span className="text-white/70 font-mono">{targetModel || "—"}</span>
                                    {" · "}
                                    {humanizeMessages
                                       ? <span className="text-[#00ffcc]">Picote ON (msgs quebradas)</span>
                                       : <span className="text-white/40">Picote OFF</span>}
                                    {messageBufferSeconds > 0 && (
                                       <span className="text-white/40"> · Buffer {messageBufferSeconds}s</span>
                                    )}
                                 </p>
                              </div>
                           </div>
                           <Button
                              onClick={() => {
                                 setTestMessages([]);
                                 setTestVariables({});
                                 setTestStageIndex(0);
                                 setTestSkippedStages([]);
                                 try { localStorage.removeItem(`sdr_test_messages_${activeAgentId}`); } catch {}
                              }}
                              variant="ghost" size="icon" className="text-white/40"
                              title="Limpar conversa de teste"
                           ><Trash2 className="w-4 h-4" /></Button>
                        </div>
                        <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
                           {testMessages.map((msg, i) => {
                              if (msg.role === 'tool') {
                                const meta = toolMeta(msg.content);
                                const colorMap: Record<string, string> = {
                                  purple: "bg-purple-500/10 border-purple-500/30 text-purple-200",
                                  blue:   "bg-blue-500/10 border-blue-500/30 text-blue-200",
                                  amber:  "bg-amber-500/10 border-amber-500/30 text-amber-200",
                                  gray:   "bg-white/5 border-white/10 text-white/80",
                                };
                                return (
                                  <div key={i} className="flex justify-center">
                                    <div className={cn("max-w-[90%] rounded-xl p-2.5 border text-[11px] font-mono leading-relaxed", colorMap[meta.color])}>
                                      <div className="flex items-center gap-2 mb-1">
                                        <span className="text-base">{meta.icon}</span>
                                        <span className="text-[9px] font-black uppercase tracking-widest opacity-80">Tool · {meta.label}</span>
                                      </div>
                                      <div className="opacity-90">{msg.content}</div>
                                    </div>
                                  </div>
                                );
                              }
                              return (
                                <div key={i} className={cn("flex", msg.role === 'user' ? "justify-end" : "justify-start")}>
                                   <div
                                     className={cn(
                                       "max-w-[85%] text-sm p-3 rounded-2xl whitespace-pre-wrap",
                                       msg.role === 'user' ? "bg-[#005c4b] text-white"
                                         : msg.isError ? "bg-red-500/15 border border-red-500/40 text-red-200"
                                         : "bg-[#202c33] text-[#e9edef]"
                                     )}
                                   >
                                     {msg.content}
                                   </div>
                                </div>
                              );
                           })}
                           {testLoading && <div className="text-[10px] text-muted-foreground animate-pulse pl-4">Digitando...</div>}
                        </div>
                        <form onSubmit={handleTestSubmit} className="bg-[#2a3942] p-3 flex gap-2">
                           <Input value={testInput} onChange={e => setTestInput(e.target.value)} placeholder="Envie uma mensagem..." className="bg-transparent border-none text-white h-10 flex-1 px-4" />
                           <Button type="submit" disabled={testLoading} className="bg-[#00a884] h-10 w-10 p-0 rounded-full shrink-0"><Send className="w-4 h-4" /></Button>
                        </form>
                    </div>
                    {/* TIMELINE SIDEBAR */}
                    <div className="w-full md:w-80 bg-white/5 border border-white/10 rounded-[2.5rem] overflow-hidden flex flex-col p-6 shadow-xl">
                       <div className="flex items-center justify-between pb-2">
                          <h4 className="font-bold text-sm text-white">Progresso</h4>
                          <span className="text-[10px] font-bold text-blue-400 bg-blue-500/20 px-2 py-0.5 rounded-full font-mono">{Math.min(testStageIndex, stages.length || 0)}/{stages.length || 0}</span>
                       </div>
                       
                       {/* Barra de Progresso Horizontal */}
                       <div className="w-full bg-white/10 h-1 rounded-full mb-6 overflow-hidden">
                         <div 
                           className="bg-blue-500 h-full rounded-full transition-all duration-500" 
                           style={{ width: `${stages.length > 0 ? (Math.min(testStageIndex, stages.length) / stages.length) * 100 : 0}%` }} 
                         />
                       </div>

                       <div className="flex-1 overflow-y-auto space-y-6 custom-scrollbar pr-2">
                          {stages.length === 0 && (
                              <p className="text-xs text-muted-foreground italic text-center mt-4">Nenhuma etapa cadastrada.</p>
                          )}
                          {stages.map((stage, idx) => {
                             const isCompleted = testStageIndex > idx;
                             const isActive = testStageIndex === idx;
                             const isSkipped = testSkippedStages.includes(idx);
                             
                             return (
                               <div key={stage.id} className="relative flex gap-4">
                                  {idx !== stages.length - 1 && (
                                     <div className={cn("absolute left-3.5 top-8 bottom-[-24px] w-0.5", isCompleted ? "bg-green-500" : "bg-white/10")} />
                                  )}
                                  
                                  <div className={cn(
                                    "w-7 h-7 rounded-full flex items-center justify-center shrink-0 z-10 border-2 transition-all duration-300", 
                                    isCompleted 
                                      ? "bg-green-500 border-green-500 text-white shadow-[0_0_10px_rgba(34,197,94,0.3)]" 
                                      : isActive 
                                        ? "bg-blue-500 border-blue-500 text-white shadow-[0_0_10px_rgba(59,130,246,0.3)]" 
                                        : "bg-black border-white/20 text-muted-foreground"
                                  )}>
                                     {isCompleted ? (
                                       <Check className="w-3.5 h-3.5" />
                                     ) : isActive ? (
                                       <div className="w-1.5 h-1.5 bg-white rounded-full" />
                                     ) : (
                                       <span className="text-[10px] font-bold">{idx + 1}</span>
                                     )}
                                  </div>

                                  <div className={cn(
                                    "min-w-0 pb-2 flex-1 rounded-2xl p-3.5 transition-all duration-300",
                                    isActive ? "bg-blue-500/10 border border-blue-500/30" : "bg-transparent"
                                  )}>
                                     <h5 className={cn(
                                       "text-xs font-bold", 
                                       isCompleted ? "text-green-500" : isActive ? "text-blue-400" : "text-white/40"
                                     )}>
                                       {stage.title}
                                     </h5>

                                     {isCompleted && (
                                        <p className="text-[10px] text-green-500/70 mt-0.5">Concluída</p>
                                     )}

                                     {isActive && (
                                        <>
                                          <p className="text-[10px] text-muted-foreground mt-1 line-clamp-2 italic">{stage.goal_prompt}</p>
                                          <p className="text-[10px] text-blue-400 font-bold mt-2 flex items-center gap-1 animate-pulse">
                                            <span className="w-1 h-1 bg-blue-400 rounded-full inline-block"></span> Em andamento...
                                          </p>
                                        </>
                                     )}

                                     {isSkipped && <p className="text-[9px] text-muted-foreground mt-0.5">Pulada (condição não atendida)</p>}

                                     {/* Variáveis coletadas na etapa */}
                                     {(isCompleted || isActive) && !isSkipped && (
                                        <div className="mt-2 flex flex-wrap gap-1">
                                           {(Array.isArray(stage.captured_variables) ? stage.captured_variables : []).map((v: any, vi: number) => {
                                              const val = testVariables[v.name];
                                              if (!val) return null;
                                              return (
                                                 <div key={vi} className="text-[9px] bg-blue-500/20 text-blue-300 px-2 py-0.5 rounded-full border border-blue-500/30 flex items-center gap-1">
                                                    <span className="opacity-70">{v.name}:</span>
                                                    <span className="font-bold truncate">{val}</span>
                                                 </div>
                                              );
                                           })}
                                        </div>
                                     )}
                                  </div>
                               </div>
                             );
                          })}
                       </div>
                    </div>
                </div>
            </div>
        )}

            {activeTab === "logs" && (
              <section className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-lg font-black tracking-tight">Logs de Webhook</h3>
                    <p className="text-xs text-muted-foreground mt-1">Monitore os eventos em tempo real.</p>
                  </div>
                  <Button onClick={() => setWebhookLogs([])} variant="ghost" className="text-red-500 hover:bg-red-500/10 gap-2 font-bold text-[10px] uppercase tracking-widest"><Trash2 className="w-3 h-3" /> Limpar Visualização</Button>
                </div>

                <div className="glass-card rounded-[2rem] border-white/10 overflow-hidden bg-white/[0.02]">
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead>
                        <tr className="bg-white/5 text-muted-foreground font-black uppercase tracking-widest text-[9px]">
                          <th className="px-6 py-4">Data/Hora</th>
                          <th className="px-6 py-4">Evento</th>
                          <th className="px-6 py-4">Instância</th>
                          <th className="px-6 py-4">Resumo</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {webhookLogs.length === 0 && (
                          <tr><td colSpan={4} className="px-6 py-12 text-center text-muted-foreground italic">Nenhum log recebido nesta sessão...</td></tr>
                        )}
                        {webhookLogs.map((log, i) => (
                          <Fragment key={i}>
                            <tr className="hover:bg-white/[0.02] transition-colors group">
                              <td className="px-6 py-4 whitespace-nowrap text-white/50">{new Date(log.created_at).toLocaleTimeString()}</td>
                              <td className="px-6 py-4">
                                <span className={cn(
                                  "px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-tighter border",
                                  log.event?.includes('error') ? "bg-red-500/10 text-red-500 border-red-500/20" : 
                                  log.event?.includes('AGENT') ? "bg-primary/10 text-primary border-primary/20" :
                                  "bg-blue-500/10 text-blue-400 border-blue-500/20"
                                )}>
                                  {log.event}
                                </span>
                              </td>
                              <td className="px-6 py-4 font-mono text-white/70">{log.instance_name}</td>
                              <td className="px-6 py-4">
                                <div className="flex items-center gap-3">
                                   <div className="max-w-[150px] truncate text-muted-foreground group-hover:text-white transition-colors">
                                     {JSON.stringify(log.payload)}
                                   </div>
                                   <div className="flex items-center gap-1 ml-auto opacity-0 group-hover:opacity-100 transition-opacity text-white">
                                      <Button onClick={() => toggleLog(i)} size="icon" variant="ghost" className="h-7 w-7 text-primary hover:bg-primary/10 rounded-md">
                                         <Info className="w-3.5 h-3.5" />
                                      </Button>
                                      <Button onClick={() => navigator.clipboard.writeText(JSON.stringify(log.payload, null, 2))} size="icon" variant="ghost" className="h-7 w-7 text-blue-400 hover:bg-blue-400/10 rounded-md">
                                         <Copy className="w-3.5 h-3.5" />
                                      </Button>
                                   </div>
                                </div>
                              </td>
                            </tr>
                            {expandedLogs.includes(i) && (
                              <tr className="bg-black/40 animate-in slide-in-from-top-2 duration-300">
                                <td colSpan={4} className="px-8 py-6">
                                   <div className="space-y-4 border-l-2 border-primary/30 pl-6">
                                      <div className="flex items-center justify-between">
                                         <h5 className="text-[10px] font-black uppercase tracking-widest text-primary flex items-center gap-2">
                                            <Activity className="w-3 h-3" /> Conteúdo Completo do Evento
                                         </h5>
                                         <Button onClick={() => toggleLog(i)} size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground hover:text-white">
                                            <XCircle className="w-4 h-4" />
                                         </Button>
                                      </div>
                                      <pre className="bg-[#050505] border border-white/5 p-6 rounded-2xl text-[11px] font-mono leading-relaxed overflow-x-auto text-blue-100/80 custom-scrollbar shadow-inner">
                                         {JSON.stringify(log.payload, null, 2)}
                                      </pre>
                                   </div>
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </section>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

/* ========================================================
   PromptPreview — mostra como o prompt fica DEPOIS das
   substituições, do jeito que a IA recebe.
   - Resolve {{vars}} usando o sample do lead.
   - Expande {{kb:Título}} no mesmo texto que o backend injeta.
   - Destaca em verde tudo que foi resolvido e em vermelho o
     que ficou sem valor (var inexistente).
   - Mostra contadores de variáveis usadas e KBs referenciadas.
======================================================== */
type PreviewLead = {
  id: number;
  remoteJid: string;
  nome_negocio: string | null;
  ramo_negocio: string | null;
  categoria: string | null;
  endereco: string | null;
  website: string | null;
  telefone: string | null;
};

function LeadSelectorUI({
  sample, setSample, leads, leadsLoading,
  selectedLeadId, onSelectLead, leadQuery, setLeadQuery
}: {
  sample: any; setSample: (s: any) => void;
  leads: PreviewLead[]; leadsLoading: boolean;
  selectedLeadId: number | null; onSelectLead: (lead: PreviewLead) => void;
  leadQuery: string; setLeadQuery: (v: string) => void;
}) {
  const [leadPickerOpen, setLeadPickerOpen] = useState(false);
  const filteredLeads = useMemo(() => {
    const q = leadQuery.trim().toLowerCase();
    if (!q) return leads.slice(0, 50);
    return leads.filter(l =>
      (l.nome_negocio || "").toLowerCase().includes(q) ||
      (l.telefone     || "").toLowerCase().includes(q) ||
      (l.remoteJid    || "").toLowerCase().includes(q) ||
      (l.categoria    || "").toLowerCase().includes(q) ||
      (l.ramo_negocio || "").toLowerCase().includes(q)
    ).slice(0, 50);
  }, [leads, leadQuery]);

  const selectedLead = leads.find(l => l.id === selectedLeadId) || null;

  return (
    <div className="rounded-xl bg-black/30 border border-white/5 p-3 space-y-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-[10px] font-black uppercase tracking-widest text-cyan-300">Simular com qual lead?</p>
        {selectedLead && (
          <span className="text-[10px] text-emerald-300 font-mono">
            ✓ usando: {selectedLead.nome_negocio || selectedLead.telefone || selectedLead.remoteJid?.replace(/@.*$/, "")}
          </span>
        )}
      </div>

      <div className="relative">
        <button
          type="button"
          onClick={() => setLeadPickerOpen(!leadPickerOpen)}
          className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-black/40 border border-white/10 hover:border-cyan-500/40 transition text-left"
        >
          <span className="text-[12px] text-white truncate">
            {selectedLead
              ? <>
                  <span className="font-bold">{selectedLead.nome_negocio || "(sem nome)"}</span>
                  <span className="text-muted-foreground ml-2 text-[10px]">{selectedLead.telefone || selectedLead.remoteJid?.replace(/@.*$/, "")}</span>
                  {selectedLead.ramo_negocio && <span className="text-muted-foreground ml-2 text-[10px]">· {selectedLead.ramo_negocio}</span>}
                </>
              : <span className="text-muted-foreground italic">Clique pra escolher um lead da sua base… ({leads.length} disponíveis)</span>}
          </span>
          <span className="text-[10px] text-muted-foreground font-mono shrink-0">{leadPickerOpen ? "▲" : "▼"}</span>
        </button>

        {leadPickerOpen && (
          <div className="absolute z-20 left-0 right-0 mt-1 rounded-xl bg-[#0a0a0a] border border-cyan-500/20 shadow-2xl overflow-hidden">
            <div className="p-2 border-b border-white/5">
              <input
                autoFocus
                value={leadQuery}
                onChange={(e) => setLeadQuery(e.target.value)}
                placeholder="Buscar por nome, telefone, ramo, categoria..."
                className="w-full bg-black/40 border border-white/10 rounded-md px-3 py-1.5 text-[12px] text-white focus:border-cyan-500/50 outline-none"
              />
            </div>
            <div className="max-h-72 overflow-y-auto custom-scrollbar">
              {leadsLoading ? (
                <div className="p-3 text-[11px] text-muted-foreground italic">Carregando leads...</div>
              ) : filteredLeads.length === 0 ? (
                <div className="p-3 text-[11px] text-muted-foreground italic">
                  {leads.length === 0 ? "Nenhum lead cadastrado em leads_extraidos." : "Nenhum lead bate com a busca."}
                </div>
              ) : (
                filteredLeads.map(l => (
                  <button
                    key={l.id}
                    type="button"
                    onClick={() => {
                      onSelectLead(l);
                      setLeadPickerOpen(false);
                      setLeadQuery("");
                    }}
                    className={cn(
                      "w-full text-left px-3 py-2 hover:bg-cyan-500/10 transition border-b border-white/[0.03] last:border-0",
                      selectedLeadId === l.id && "bg-cyan-500/10"
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-[12px] font-bold text-white truncate">
                          {l.nome_negocio || <span className="italic text-muted-foreground">(sem nome)</span>}
                        </p>
                        <p className="text-[10px] text-muted-foreground font-mono truncate">
                          {l.telefone || (l.remoteJid || "").replace(/@.*$/, "")}
                          {l.ramo_negocio && <span className="ml-2">· {l.ramo_negocio}</span>}
                          {l.categoria   && <span className="ml-2">· {l.categoria}</span>}
                        </p>
                      </div>
                      {selectedLeadId === l.id && <span className="text-cyan-300 text-[10px] font-bold shrink-0">✓ atual</span>}
                    </div>
                  </button>
                ))
              )}
            </div>
            {leads.length > filteredLeads.length && (
              <div className="p-2 text-[9px] text-muted-foreground text-center border-t border-white/5">
                Mostrando {filteredLeads.length} de {leads.length}. Refine a busca pra ver mais.
              </div>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 pt-2 border-t border-white/5">
        {([
          ["nome_negocio", "Nome empresa"],
          ["ramo_negocio", "Ramo"],
          ["push_name",    "Nome WhatsApp"],
          ["telefone",     "Telefone"],
          ["categoria",    "Categoria"],
          ["endereco",     "Endereço"],
          ["website",      "Website"],
        ] as const).map(([k, label]) => (
          <div key={k}>
            <label className="text-[9px] uppercase tracking-widest text-muted-foreground font-black">{label}</label>
            <input
              value={(sample as any)[k] || ""}
              onChange={(e) => setSample({ ...sample, [k]: e.target.value })}
              className="w-full mt-0.5 bg-black/40 border border-white/10 rounded-md px-2 py-1 text-[11px] font-mono text-white focus:border-cyan-500/50 outline-none"
            />
          </div>
        ))}
      </div>
      <p className="text-[9px] text-muted-foreground italic">
        Os campos são preenchidos automaticamente ao escolher um lead. Você ainda pode editar manualmente pra simular cenários hipotéticos.
      </p>
    </div>
  );
}

function PromptPreview({
  rawPrompt, sample, setSample, knowledge, open, setOpen,
  leads, leadsLoading, onOpenLeadPicker, selectedLeadId, onSelectLead,
  leadQuery, setLeadQuery,
}: {
  rawPrompt: string;
  sample: { nome_negocio: string; ramo_negocio: string; push_name: string; telefone: string; endereco: string; categoria: string; website: string };
  setSample: (s: any) => void;
  knowledge: any[];
  open: boolean;
  setOpen: (v: boolean) => void;
  leads: PreviewLead[];
  leadsLoading: boolean;
  onOpenLeadPicker: () => void;
  selectedLeadId: number | null;
  onSelectLead: (lead: PreviewLead) => void;
  leadQuery: string;
  setLeadQuery: (v: string) => void;
}) {
  // Carrega leads ao abrir a pré-visualização pela primeira vez
  useEffect(() => {
    if (open) onOpenLeadPicker();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // Extrai vars usadas (incluindo kb:) — pra UI mostrar contadores
  const used = useMemo(() => {
    const set = new Set<string>();
    const kbs = new Set<string>();
    const re = /\{\{\s*(kb:)?([a-z_][\w]*|[^}]+?)\s*\}\}/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rawPrompt))) {
      if (m[1]) kbs.add(m[2].trim()); else set.add(m[2].trim().toLowerCase());
    }
    return { vars: Array.from(set), kbs: Array.from(kbs) };
  }, [rawPrompt]);

  // 1) Expande {{kb:Título}} pro mesmo texto que o backend usa
  const expandedKb = useMemo(() => {
    return rawPrompt.replace(/\{\{kb:([^}]+)\}\}/g, (_match, rawTitle) => {
      const title = String(rawTitle).trim();
      const exists = knowledge.find(k => k.title?.toLowerCase() === title.toLowerCase());
      if (!exists) return `__KBMISSING:${title}__`;
      // Mesmo texto que o agent/process injeta
      return `Quando o cliente perguntar sobre **${exists.title}** (ou tópico relacionado), VOCÊ DEVE chamar a tool \`search_knowledge_base\` com query="${exists.title}" ANTES de responder. Não invente — sempre consulte.`;
    });
  }, [rawPrompt, knowledge]);

  // 2) Resolve as variáveis dinâmicas com o sample
  const rendered = useMemo(() => {
    return renderTemplate(expandedKb, {
      remoteJid:    sample.telefone ? `${sample.telefone}@s.whatsapp.net` : undefined,
      nome_negocio: sample.nome_negocio || null,
      ramo_negocio: sample.ramo_negocio || null,
      push_name:    sample.push_name || null,
      telefone:     sample.telefone || null,
      endereco:     sample.endereco || null,
      categoria:    sample.categoria || null,
      website:      sample.website || null,
    });
  }, [expandedKb, sample]);

  // 3) Constrói segmentos a partir do prompt cru, marcando cada {{var}} / {{kb:...}}
  //    com seu tipo (resolvido ou não) — assim conseguimos destacar visualmente
  //    as variáveis resolvidas dentro do preview.
  const segments = useMemo(() => {
    const parts: Array<{
      kind: "text" | "missing-var" | "missing-kb" | "kb" | "var";
      text: string;
      original?: string;
    }> = [];
    const ctx: any = {
      remoteJid:    sample.telefone ? `${sample.telefone}@s.whatsapp.net` : undefined,
      nome_negocio: sample.nome_negocio || null,
      ramo_negocio: sample.ramo_negocio || null,
      push_name:    sample.push_name || null,
      telefone:     sample.telefone || null,
      endereco:     sample.endereco || null,
      categoria:    sample.categoria || null,
      website:      sample.website || null,
    };
    const re = /\{\{\s*(kb:)?([^}]+?)\s*\}\}/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(rawPrompt))) {
      if (m.index > last) parts.push({ kind: "text", text: rawPrompt.slice(last, m.index) });
      const isKb = !!m[1];
      const key  = m[2].trim();
      if (isKb) {
        const exists = knowledge.find(k => k.title?.toLowerCase() === key.toLowerCase());
        if (exists) {
          const injected = `Quando o cliente perguntar sobre **${exists.title}** (ou tópico relacionado), VOCÊ DEVE chamar a tool \`search_knowledge_base\` com query="${exists.title}" ANTES de responder. Não invente — sempre consulte.`;
          parts.push({ kind: "kb", text: injected, original: key });
        } else {
          parts.push({ kind: "missing-kb", text: key, original: key });
        }
      } else {
        const resolvedVal = renderTemplate(`{{${key}}}`, ctx);
        if (resolvedVal === `{{${key}}}` || resolvedVal === "" || resolvedVal == null) {
          parts.push({ kind: "missing-var", text: m[0], original: key });
        } else {
          parts.push({ kind: "var", text: resolvedVal, original: key });
        }
      }
      last = m.index + m[0].length;
    }
    if (last < rawPrompt.length) parts.push({ kind: "text", text: rawPrompt.slice(last) });
    return parts;
  }, [rawPrompt, sample, knowledge]);

  const missingVars = segments.filter(s => s.kind === "missing-var").length;
  const missingKbs  = segments.filter(s => s.kind === "missing-kb").length;
  const resolvedKbs = segments.filter(s => s.kind === "kb").length;
  const charDiff = rendered.length - rawPrompt.length;

  return (
    <div className="rounded-2xl border border-emerald-500/20 bg-gradient-to-br from-emerald-500/[0.04] to-transparent overflow-hidden">
      <div className="w-full flex items-center justify-between gap-3 p-3">
        <div className="flex items-center gap-2 min-w-0">
          <Sparkles className="w-4 h-4 text-emerald-300 shrink-0" />
          <div className="min-w-0">
            <p className="text-[11px] font-black uppercase tracking-widest text-emerald-300">
              Pré-visualização — como a IA vai receber
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5 truncate">
              {used.vars.length} variável{used.vars.length !== 1 ? "is" : ""} dinâmica{used.vars.length !== 1 ? "s" : ""} ·{" "}
              {used.kbs.length} ref. KB · {rendered.length.toLocaleString("pt-BR")} caracteres
              {charDiff !== 0 && <span className="text-emerald-400/70"> ({charDiff > 0 ? "+" : ""}{charDiff} vs prompt cru)</span>}
              {missingVars > 0 && <span className="text-red-400 ml-2">⚠ {missingVars} variável{missingVars !== 1 ? "is" : ""} sem valor</span>}
              {missingKbs > 0 && <span className="text-red-400 ml-2">⚠ {missingKbs} KB inexistente{missingKbs !== 1 ? "s" : ""}</span>}
            </p>
          </div>
        </div>
      </div>

      {true && (
        <div className="border-t border-white/5 p-4 space-y-4">
          <LeadSelectorUI
            sample={sample} setSample={setSample}
            leads={leads} leadsLoading={leadsLoading}
            selectedLeadId={selectedLeadId} onSelectLead={onSelectLead}
            leadQuery={leadQuery} setLeadQuery={setLeadQuery}
          />

          {/* Render visual */}
          <div className="rounded-xl bg-[#050505] border border-white/10 p-4 max-h-[70vh] overflow-y-auto custom-scrollbar">
            <pre className="text-[12px] leading-relaxed font-mono whitespace-pre-wrap break-words">
              {segments.length === 0 ? (
                <span className="text-muted-foreground italic">Prompt vazio.</span>
              ) : segments.map((seg, i) => {
                if (seg.kind === "missing-var") {
                  return (
                    <span key={i} className="bg-red-500/20 text-red-300 px-1 rounded border border-red-500/40" title="Esta variável não tem valor — vai aparecer literalmente assim no prompt da IA">
                      {seg.text}
                    </span>
                  );
                }
                if (seg.kind === "missing-kb") {
                  return (
                    <span key={i} className="bg-red-500/20 text-red-300 px-1 rounded border border-red-500/40" title="Esta KB não existe">
                      [KB &quot;{seg.text}&quot; não encontrada]
                    </span>
                  );
                }
                if (seg.kind === "var") {
                  return (
                    <span
                      key={i}
                      className="px-0.5 rounded font-semibold text-yellow-200 underline decoration-emerald-400 decoration-2 underline-offset-[3px]"
                      title={`Variável dinâmica {{${seg.original}}} resolvida para: "${seg.text}"`}
                    >
                      {seg.text}
                    </span>
                  );
                }
                if (seg.kind === "kb") {
                  return (
                    <span
                      key={i}
                      className="bg-purple-500/15 text-fuchsia-100 px-1 rounded border border-purple-500/30 underline decoration-emerald-400 decoration-2 underline-offset-[3px]"
                      title={`Variável de conhecimento {{kb:${seg.original}}} expandida`}
                    >
                      {seg.text}
                    </span>
                  );
                }
                return <span key={i} className="text-white/85">{seg.text}</span>;
              })}
            </pre>
          </div>

          {/* Legenda */}
          <div className="flex flex-wrap items-center gap-3 text-[10px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="font-semibold text-yellow-200 underline decoration-emerald-400 decoration-2 underline-offset-[3px] px-0.5">valor</span>
              <span>variável dinâmica resolvida</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="bg-purple-500/15 text-fuchsia-100 px-1 rounded border border-purple-500/30 underline decoration-emerald-400 decoration-2 underline-offset-[3px]">regra</span>
              <span>KB expandida</span>
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded bg-red-500/20 border border-red-500/40" /> variável/KB sem valor — vai aparecer literal
            </span>
          </div>

          {/* Variáveis usadas */}
          {used.vars.length > 0 && (
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-cyan-300 mb-1">Variáveis dinâmicas detectadas</p>
              <div className="flex flex-wrap gap-1.5">
                {used.vars.map(v => {
                  const ctx: any = {
                    remoteJid: sample.telefone ? `${sample.telefone}@s.whatsapp.net` : undefined,
                    nome_negocio: sample.nome_negocio || null,
                    ramo_negocio: sample.ramo_negocio || null,
                    push_name: sample.push_name || null,
                    telefone: sample.telefone || null,
                    endereco: sample.endereco || null,
                    categoria: sample.categoria || null,
                    website: sample.website || null,
                  };
                  const resolvedVal = renderTemplate(`{{${v}}}`, ctx);
                  const isUnresolved = resolvedVal === `{{${v}}}`;
                  return (
                    <span
                      key={v}
                      className={cn(
                        "px-2 py-0.5 rounded font-mono text-[10px] border",
                        isUnresolved
                          ? "bg-red-500/10 border-red-500/30 text-red-300"
                          : "bg-cyan-500/10 border-cyan-500/30 text-cyan-200"
                      )}
                      title={isUnresolved ? "Variável sem valor no sample" : `Será substituída por: "${resolvedVal}"`}
                    >
                      {`{{${v}}}`} {!isUnresolved && <span className="opacity-70">→ {resolvedVal.slice(0, 40)}{resolvedVal.length > 40 ? "…" : ""}</span>}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* KBs referenciadas */}
          {used.kbs.length > 0 && (
            <div>
              <p className="text-[10px] font-black uppercase tracking-widest text-purple-300 mb-1">Bases de conhecimento referenciadas</p>
              <div className="flex flex-wrap gap-1.5">
                {used.kbs.map(t => {
                  const exists = knowledge.find(k => k.title?.toLowerCase() === t.toLowerCase());
                  return (
                    <span
                      key={t}
                      className={cn(
                        "px-2 py-0.5 rounded font-mono text-[10px] border",
                        exists
                          ? "bg-purple-500/10 border-purple-500/30 text-purple-200"
                          : "bg-red-500/10 border-red-500/30 text-red-300"
                      )}
                      title={exists ? "KB encontrada — IA vai consultar via tool" : "KB não cadastrada"}
                    >
                      {`{{kb:${t}}}`} {!exists && "⚠"}
                    </span>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
