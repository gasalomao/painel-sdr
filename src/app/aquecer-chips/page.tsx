"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  Flame,
  Smartphone,
  ShieldCheck,
  ShieldAlert,
  Play,
  Pause,
  RefreshCw,
  Send,
  Clock,
  Sparkles,
  Bot,
  MessageSquare,
  CheckCircle2,
  ArrowRight,
  ExternalLink,
  Smile,
  Eye,
  CheckCheck,
  Volume2,
  Info,
  Contact,
  Radio,
  Activity,
  Award,
  Snowflake,
  Coffee,
  ChevronDown,
  Settings2,
  Inbox,
  ImageIcon,
  type LucideIcon,
} from "lucide-react";
import { ModelOptions } from "@/components/ai-module-shared";
import type { GroupableModel } from "@/lib/model-grouping";
import { STAGE_DEFAULTS, type WarmupConfig, type WarmupLog, type WarmupStage } from "@/lib/warmup/warmup-types";
import { WARMUP_THEMES } from "@/lib/warmup/warmup-dialogues";
import { toast } from "sonner";

interface InstanceItem {
  instance_name: string;
  connection_status: string;
  phone_number: string | null;
  config: WarmupConfig;
  proxy: {
    enabled: boolean;
    host: string | null;
    port: string | null;
    protocol: string;
  };
}

type GlobalSettings = {
  ai_model: string;
  ai_theme: string;
  allowed_start_hour: number;
  allowed_end_hour: number;
  min_interval_seconds: number;
  max_interval_seconds: number;
  min_typing_seconds: number;
  max_typing_seconds: number;
  enable_typing: boolean;
  enable_blue_ticks: boolean;
  enable_reactions: boolean;
  enable_audio: boolean;
  enable_vcard: boolean;
  enable_status_posts: boolean;
  stage_auto_progress: boolean;
  continuous_warmup: boolean;
  custom_prompt: string;
};

const DEFAULT_GLOBAL_SETTINGS: GlobalSettings = {
  ai_model: "fallback",
  ai_theme: "dia_a_dia",
  allowed_start_hour: 8,
  allowed_end_hour: 21,
  min_interval_seconds: 90,
  max_interval_seconds: 300,
  min_typing_seconds: 3,
  max_typing_seconds: 8,
  enable_typing: true,
  enable_blue_ticks: true,
  enable_reactions: true,
  enable_audio: true,
  enable_vcard: true,
  enable_status_posts: true,
  stage_auto_progress: true,
  continuous_warmup: true,
  custom_prompt: "",
};

const STAGE_UI: Record<
  WarmupStage,
  {
    name: string;
    icon: LucideIcon;
    chip: string;
    activeButton: string;
    text: string;
    bar: string;
  }
> = {
  1: {
    name: "Frio",
    icon: Snowflake,
    chip: "border-sky-500/30 bg-sky-500/10 text-sky-300",
    activeButton: "bg-sky-600 text-white shadow-sm",
    text: "text-sky-300",
    bar: "bg-sky-500",
  },
  2: {
    name: "Morno",
    icon: Coffee,
    chip: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    activeButton: "bg-amber-500 text-neutral-950 shadow-sm",
    text: "text-amber-300",
    bar: "bg-amber-500",
  },
  3: {
    name: "Quente",
    icon: Flame,
    chip: "border-orange-500/30 bg-orange-500/10 text-orange-300",
    activeButton: "bg-orange-600 text-white shadow-sm",
    text: "text-orange-300",
    bar: "bg-orange-500",
  },
  4: {
    name: "Blindado",
    icon: ShieldCheck,
    chip: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    activeButton: "bg-emerald-600 text-white shadow-sm",
    text: "text-emerald-300",
    bar: "bg-emerald-500",
  },
};

const LOG_TYPE_UI: Record<string, { label: string; icon: LucideIcon }> = {
  text: { label: "Mensagem", icon: MessageSquare },
  reaction: { label: "Reação", icon: Smile },
  audio: { label: "Áudio", icon: Volume2 },
  presence: { label: "Digitando", icon: Eye },
  vcard: { label: "Contato", icon: Contact },
  status: { label: "Status", icon: ImageIcon },
  circuit_breaker: { label: "Proteção", icon: ShieldAlert },
  system: { label: "Sistema", icon: Settings2 },
};

const PROTECTIONS: Array<{ key: keyof GlobalSettings; icon: LucideIcon; title: string; description: string }> = [
  {
    key: "enable_vcard",
    icon: Contact,
    title: "Troca de contatos (vCard)",
    description: "Cada chip salva o outro na agenda, como acontece entre pessoas reais.",
  },
  {
    key: "enable_audio",
    icon: Volume2,
    title: "Áudio gravado na hora",
    description: "Envia mensagens de voz curtas para variar o tipo de conversa.",
  },
  {
    key: "enable_status_posts",
    icon: Radio,
    title: "Status / Stories",
    description: "Publica uma frase ou foto no Status a cada 48 horas.",
  },
  {
    key: "enable_blue_ticks",
    icon: CheckCheck,
    title: "Confirmação de leitura",
    description: "Marca as mensagens como lidas depois de alguns segundos.",
  },
  {
    key: "enable_reactions",
    icon: Smile,
    title: "Reações com emoji",
    description: "Reage às mensagens do outro chip com emojis variados.",
  },
  {
    key: "stage_auto_progress",
    icon: Activity,
    title: "Piloto automático de fases",
    description: "Sobe o chip de fase sozinho conforme os dias sem erro.",
  },
];

function healthTone(score: number) {
  if (score >= 80) {
    return {
      label: "Excelente",
      text: "text-emerald-300",
      chip: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
      bar: "bg-emerald-500",
    };
  }
  if (score >= 50) {
    return {
      label: "Atenção",
      text: "text-amber-300",
      chip: "border-amber-500/30 bg-amber-500/10 text-amber-300",
      bar: "bg-amber-500",
    };
  }
  return {
    label: "Crítico",
    text: "text-red-300",
    chip: "border-red-500/30 bg-red-500/10 text-red-300",
    bar: "bg-red-500",
  };
}

function formatRelativeTime(iso?: string | null) {
  if (!iso) return "sem registro";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "sem registro";

  const diffMinutes = Math.floor((Date.now() - date.getTime()) / 60000);
  if (diffMinutes < 1) return "agora mesmo";
  if (diffMinutes < 60) return `há ${diffMinutes} min`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `há ${diffHours} h`;

  const diffDays = Math.floor(diffHours / 24);
  return diffDays === 1 ? "há 1 dia" : `há ${diffDays} dias`;
}

function formatHour(hour: number) {
  return `${String(hour).padStart(2, "0")}h`;
}

export default function AquecerChipsPage() {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [instances, setInstances] = useState<InstanceItem[]>([]);
  const [savedConfigs, setSavedConfigs] = useState<Record<string, WarmupConfig>>({});
  const [logs, setLogs] = useState<WarmupLog[]>([]);
  const [stats, setStats] = useState({
    totalChips: 0,
    activeWarmup: 0,
    totalSentToday: 0,
    totalReceivedToday: 0,
  });
  const [aiModels, setAiModels] = useState<GroupableModel[]>([]);
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [savingMap, setSavingMap] = useState<Record<string, boolean>>({});
  const [bulkBusy, setBulkBusy] = useState(false);

  // Configurações Gerais de IA & Maturação Avançada
  const [globalSettings, setGlobalSettings] = useState<GlobalSettings>(DEFAULT_GLOBAL_SETTINGS);
  const [savedGlobalSettings, setSavedGlobalSettings] = useState<GlobalSettings>(DEFAULT_GLOBAL_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(true);

  // Modal de teste imediato
  const [testModalOpen, setTestModalOpen] = useState(false);
  const [testSender, setTestSender] = useState("");
  const [testReceiver, setTestReceiver] = useState("");
  const [testLoading, setTestLoading] = useState(false);

  // Auto-refresh de logs a cada 8s
  const [autoRefreshLogs, setAutoRefreshLogs] = useState(true);
  const logsContainerRef = useRef<HTMLDivElement>(null);

  const loadData = useCallback(async (isSilent = false) => {
    if (!isSilent) setRefreshing(true);
    try {
      const res = await fetch("/api/warmup", { cache: "no-store" });
      const data = await res.json();
      if (data.success && data.data) {
        const nextInstances: InstanceItem[] = data.data.instances || [];
        setInstances(nextInstances);
        setSavedConfigs(
          nextInstances.reduce<Record<string, WarmupConfig>>((acc, item) => {
            acc[item.instance_name] = item.config;
            return acc;
          }, {})
        );
        setLogs(data.data.logs || []);

        if (data.data.global_settings) {
          const nextGlobal: GlobalSettings = { ...DEFAULT_GLOBAL_SETTINGS, ...data.data.global_settings };
          setGlobalSettings(nextGlobal);
          setSavedGlobalSettings(nextGlobal);
        }

        setStats(
          data.data.stats || {
            totalChips: 0,
            activeWarmup: 0,
            totalSentToday: 0,
            totalReceivedToday: 0,
          }
        );
      } else {
        if (!isSilent) toast.error(data.error || "Erro ao carregar dados de maturação");
      }
    } catch (err: any) {
      if (!isSilent) toast.error("Falha ao comunicar com o servidor: " + err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  // Busca lista de modelos de IA suportados no sistema
  useEffect(() => {
    fetch("/api/ai-models")
      .then((r) => r.json())
      .then((d) => {
        if (d?.models && Array.isArray(d.models)) {
          setAiModels(d.models);
        }
      })
      .catch(() => {});
    loadData();
  }, [loadData]);

  // Polling automático de logs
  useEffect(() => {
    if (!autoRefreshLogs) return;
    const interval = setInterval(() => {
      fetch("/api/warmup/logs?limit=30")
        .then((r) => r.json())
        .then((d) => {
          if (d?.success && Array.isArray(d.logs)) {
            setLogs(d.logs);
          }
        })
        .catch(() => {});
    }, 8000);
    return () => clearInterval(interval);
  }, [autoRefreshLogs]);

  // Mantém o log rolado no fim, sem tirar o operador de onde ele está lendo
  useEffect(() => {
    const el = logsContainerRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < 120) {
      el.scrollTop = el.scrollHeight;
    }
  }, [logs]);

  const globalDirty = JSON.stringify(globalSettings) !== JSON.stringify(savedGlobalSettings);
  const totalDailyTarget = instances.reduce((acc, item) => acc + (item.config.daily_target || 0), 0);

  const selectedModelLabel =
    globalSettings.ai_model === "fallback"
      ? "Diálogos nativos (grátis)"
      : aiModels.find((m) => m.id === globalSettings.ai_model)?.name ||
        aiModels.find((m) => m.id === globalSettings.ai_model)?.rawId ||
        globalSettings.ai_model;

  const selectedThemeLabel =
    WARMUP_THEMES.find((t) => t.id === globalSettings.ai_theme)?.label || globalSettings.ai_theme;

  const handleSaveGlobalSettings = async () => {
    setSavingGlobal(true);
    try {
      const res = await fetch("/api/warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "global_settings", ...globalSettings }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success("Parâmetros gerais de IA e aquecimento salvos.");
        await loadData(true);
      } else {
        toast.error(`Erro ao salvar: ${data.error}`);
      }
    } catch (err: any) {
      toast.error(`Falha: ${err.message}`);
    } finally {
      setSavingGlobal(false);
    }
  };

  const handleUpdateConfigField = (
    instanceName: string,
    field: keyof WarmupConfig,
    value: any
  ) => {
    setInstances((prev) =>
      prev.map((item) => {
        if (item.instance_name !== instanceName) return item;
        const updatedConfig = { ...item.config, [field]: value };

        if (field === "stage") {
          const stageNum = Number(value) as WarmupStage;
          const defaults = STAGE_DEFAULTS[stageNum];
          if (defaults) {
            updatedConfig.daily_target = defaults.dailyTarget;
            updatedConfig.min_interval_seconds = defaults.minInterval;
            updatedConfig.max_interval_seconds = defaults.maxInterval;
          }
        }

        return { ...item, config: updatedConfig };
      })
    );
  };

  const handleSaveConfig = async (instanceName: string) => {
    const item = instances.find((i) => i.instance_name === instanceName);
    if (!item) return;

    setSavingMap((prev) => ({ ...prev, [instanceName]: true }));
    try {
      const res = await fetch("/api/warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(item.config),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`Configurações de "${instanceName}" salvas.`);
        await loadData(true);
      } else {
        toast.error(`Erro ao salvar: ${data.error}`);
      }
    } catch (err: any) {
      toast.error(`Falha: ${err.message}`);
    } finally {
      setSavingMap((prev) => ({ ...prev, [instanceName]: false }));
    }
  };

  const handleToggleBulk = async (action: "enable_all" | "pause_all") => {
    const isEnable = action === "enable_all";
    setBulkBusy(true);
    try {
      const res = await fetch("/api/warmup", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(isEnable ? "Todos os chips foram ativados para aquecimento." : "Aquecimento pausado em todos os chips.");
        await loadData();
      } else {
        toast.error(`Falha: ${data.error}`);
      }
    } catch (err: any) {
      toast.error(`Erro: ${err.message}`);
    } finally {
      setBulkBusy(false);
    }
  };

  const handleRunTest = async () => {
    if (!testSender || !testReceiver) {
      toast.error("Selecione o chip remetente e o destinatário.");
      return;
    }
    if (testSender === testReceiver) {
      toast.error("O remetente e o destinatário devem ser chips diferentes.");
      return;
    }

    setTestLoading(true);
    try {
      const res = await fetch("/api/warmup/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceA: testSender, instanceB: testReceiver }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message || "Troca de mensagem executada com sucesso!");
        setTestModalOpen(false);
        await loadData(true);
      } else {
        toast.error(data.error || "Falha ao executar o teste.");
      }
    } catch (err: any) {
      toast.error("Erro na execução: " + err.message);
    } finally {
      setTestLoading(false);
    }
  };

  const testBlockedReason =
    instances.length < 2
      ? "Conecte um segundo chip para testar a conversa entre dois números."
      : !testSender || !testReceiver
        ? "Escolha quem envia e quem recebe."
        : testSender === testReceiver
          ? "Escolha chips diferentes para enviar e receber."
          : null;

  return (
    <div className="h-[100dvh] max-h-[100dvh] flex flex-col overflow-hidden bg-[#07090E] text-neutral-200">
      <Header />

      <main className="flex-1 min-h-0 overflow-y-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 sm:py-8 space-y-8 pb-16">
          {/* Cabeçalho da página */}
          <div className="space-y-5">
            <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
              <div className="flex items-start gap-3">
                <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 shrink-0">
                  <Flame className="w-6 h-6" />
                </div>
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="text-2xl font-bold tracking-tight text-white">Aquecer Chips</h1>
                    <Badge
                      variant="outline"
                      className={
                        globalSettings.stage_auto_progress
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300 text-[11px] font-medium"
                          : "border-white/15 bg-white/5 text-neutral-300 text-[11px] font-medium"
                      }
                    >
                      {globalSettings.stage_auto_progress ? "Piloto automático ativo" : "Piloto automático desligado"}
                    </Badge>
                  </div>
                  <p className="text-sm text-neutral-400 max-w-2xl">
                    Seus chips conversam entre si para ganhar reputação no WhatsApp antes de entrar nas campanhas.
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleToggleBulk("enable_all")}
                  disabled={bulkBusy}
                  className="border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10 hover:text-white"
                >
                  <Play className="w-3.5 h-3.5 mr-1.5" />
                  Ativar todos
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleToggleBulk("pause_all")}
                  disabled={bulkBusy}
                  className="border-neutral-700 text-neutral-300 hover:bg-neutral-800 hover:text-white"
                >
                  <Pause className="w-3.5 h-3.5 mr-1.5" />
                  Pausar todos
                </Button>
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => {
                    if (instances.length >= 2) {
                      setTestSender(instances[0].instance_name);
                      setTestReceiver(instances[1].instance_name);
                    } else if (instances.length === 1) {
                      setTestSender(instances[0].instance_name);
                    }
                    setTestModalOpen(true);
                  }}
                  className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
                >
                  <Send className="w-3.5 h-3.5 mr-1.5" />
                  Testar disparo
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => loadData()}
                  disabled={refreshing}
                  className="text-neutral-400 hover:text-white focus-visible:ring-emerald-500/60"
                  title="Atualizar dados"
                  aria-label="Atualizar dados"
                >
                  <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
                </Button>
              </div>
            </div>

            {/* Resumo do dia */}
            <div className="rounded-xl border border-white/10 bg-[#0B0F17] divide-y divide-white/5 sm:divide-y-0 sm:grid sm:grid-cols-2 lg:grid-cols-4 sm:divide-x">
              <div className="p-4">
                <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">Chips conectados</p>
                <p className="mt-1 flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-white tabular-nums">{stats.totalChips}</span>
                  <span className="text-xs text-neutral-400">números no painel</span>
                </p>
              </div>

              <div className="p-4">
                <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">Aquecendo agora</p>
                <p className="mt-1 flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-emerald-300 tabular-nums">{stats.activeWarmup}</span>
                  <span className="text-xs text-neutral-400">de {stats.totalChips} conectados</span>
                </p>
              </div>

              <div className="p-4">
                <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">Enviadas hoje</p>
                <p className="mt-1 flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-white tabular-nums">{stats.totalSentToday}</span>
                  <span className="text-xs text-neutral-400">
                    {totalDailyTarget > 0 ? `de ${totalDailyTarget} previstas` : "mensagens"}
                  </span>
                </p>
              </div>

              <div className="p-4">
                <p className="text-[11px] font-medium uppercase tracking-wide text-neutral-400">Recebidas hoje</p>
                <p className="mt-1 flex items-baseline gap-2">
                  <span className="text-2xl font-bold text-white tabular-nums">{stats.totalReceivedToday}</span>
                  <span className="text-xs text-neutral-400">respostas dos parceiros</span>
                </p>
              </div>
            </div>
          </div>

          {/* ========================================================================= */}
          {/* AJUSTES GERAIS: COMO AS CONVERSAS ACONTECEM */}
          {/* ========================================================================= */}
          <Card className="bg-[#0B0F17] border-white/10 shadow-xl overflow-hidden">
            <div className="border-b border-white/5 bg-gradient-to-r from-emerald-950/30 to-transparent px-5 sm:px-6 py-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="flex items-start gap-2.5">
                  <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 shrink-0">
                    <Bot className="w-5 h-5" />
                  </div>
                  <div>
                    <h2 className="text-base font-bold text-white">Como as conversas acontecem</h2>
                    <p className="text-xs text-neutral-400 mt-0.5">
                      Estes ajustes valem para todos os chips. {selectedModelLabel} · {selectedThemeLabel} · {formatHour(globalSettings.allowed_start_hour)} às {formatHour(globalSettings.allowed_end_hour)}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setSettingsOpen((v) => !v)}
                    aria-expanded={settingsOpen}
                    aria-controls="ajustes-gerais"
                    className="h-8 text-xs text-neutral-300 hover:bg-white/5 hover:text-white"
                  >
                    <ChevronDown className={`w-3.5 h-3.5 mr-1.5 transition-transform ${settingsOpen ? "rotate-180" : ""}`} />
                    {settingsOpen ? "Ocultar ajustes" : "Ajustar"}
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleSaveGlobalSettings}
                    disabled={savingGlobal || !globalDirty}
                    className={
                      globalDirty
                        ? "bg-emerald-600 hover:bg-emerald-500 text-white font-medium text-xs h-8 px-4"
                        : "bg-white/5 text-neutral-400 font-medium text-xs h-8 px-4"
                    }
                  >
                    {savingGlobal ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                        Salvando...
                      </>
                    ) : globalDirty ? (
                      "Salvar alterações"
                    ) : (
                      <>
                        <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
                        Tudo salvo
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </div>

            {settingsOpen && (
              <CardContent id="ajustes-gerais" className="p-5 sm:p-6 space-y-7">
                {/* Conversas */}
                <section className="space-y-3">
                  <div>
                    <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                      <MessageSquare className="w-4 h-4 text-emerald-400" />
                      Conversas
                    </h3>
                    <p className="text-xs text-neutral-400 mt-0.5">
                      Quem escreve as mensagens e sobre o que os chips conversam.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <label htmlFor="ai-model" className="text-xs font-semibold text-white flex items-center gap-1.5">
                          <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
                          Modelo de IA
                        </label>
                        <span className="text-[11px] text-neutral-400">{aiModels.length} disponíveis</span>
                      </div>
                      <select
                        id="ai-model"
                        value={globalSettings.ai_model}
                        onChange={(e) => setGlobalSettings((p) => ({ ...p, ai_model: e.target.value }))}
                        className="w-full bg-neutral-950 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/30"
                      >
                        <option value="fallback" className="bg-neutral-900 text-emerald-400 font-semibold">
                          ★ [GRÁTIS] Diálogos Nativos pt-BR (Zero Consumo de Tokens)
                        </option>
                        <ModelOptions models={aiModels} />
                      </select>
                      <p className="text-[11px] text-neutral-400 leading-relaxed">
                        Funciona com Gemini, OpenRouter, NVIDIA NIM, Gateway de Assinatura e combos. A opção grátis usa frases prontas em português.
                      </p>
                    </div>

                    <div className="space-y-2">
                      <label htmlFor="ai-theme" className="text-xs font-semibold text-white flex items-center gap-1.5">
                        <MessageSquare className="w-3.5 h-3.5 text-emerald-400" />
                        Assunto das conversas
                      </label>
                      <select
                        id="ai-theme"
                        value={globalSettings.ai_theme}
                        onChange={(e) => setGlobalSettings((p) => ({ ...p, ai_theme: e.target.value }))}
                        className="w-full bg-neutral-950 border border-white/10 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/30"
                      >
                        {WARMUP_THEMES.map((t) => (
                          <option key={t.id} value={t.id} className="bg-neutral-900 text-white">
                            {t.label}
                          </option>
                        ))}
                      </select>
                      <p className="text-[11px] text-neutral-400 leading-relaxed">
                        Tema usado para começar e manter conversas que parecem naturais.
                      </p>
                    </div>
                  </div>
                </section>

                {/* Ritmo */}
                <section className="space-y-3 border-t border-white/5 pt-6">
                  <div>
                    <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                      <Clock className="w-4 h-4 text-emerald-400" />
                      Ritmo e horários
                    </h3>
                    <p className="text-xs text-neutral-400 mt-0.5">
                      Fora da janela abaixo os chips ficam em silêncio. Os intervalos evitam envios em sequência.
                    </p>
                  </div>

                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    <div>
                      <label htmlFor="start-hour" className="text-[11px] text-neutral-300 font-medium block mb-1.5">
                        Começa às (hora)
                      </label>
                      <Input
                        id="start-hour"
                        type="number"
                        min={0}
                        max={23}
                        value={globalSettings.allowed_start_hour}
                        onChange={(e) => setGlobalSettings((p) => ({ ...p, allowed_start_hour: Number(e.target.value) }))}
                        className="bg-neutral-950 border-white/10 text-sm h-9 tabular-nums"
                      />
                    </div>

                    <div>
                      <label htmlFor="end-hour" className="text-[11px] text-neutral-300 font-medium block mb-1.5">
                        Termina às (hora)
                      </label>
                      <Input
                        id="end-hour"
                        type="number"
                        min={1}
                        max={24}
                        value={globalSettings.allowed_end_hour}
                        onChange={(e) => setGlobalSettings((p) => ({ ...p, allowed_end_hour: Number(e.target.value) }))}
                        className="bg-neutral-950 border-white/10 text-sm h-9 tabular-nums"
                      />
                    </div>

                    <div>
                      <label htmlFor="min-interval" className="text-[11px] text-neutral-300 font-medium block mb-1.5">
                        Pausa mínima (segundos)
                      </label>
                      <Input
                        id="min-interval"
                        type="number"
                        min={30}
                        value={globalSettings.min_interval_seconds}
                        onChange={(e) => setGlobalSettings((p) => ({ ...p, min_interval_seconds: Number(e.target.value) }))}
                        className="bg-neutral-950 border-white/10 text-sm h-9 tabular-nums"
                      />
                    </div>

                    <div>
                      <label htmlFor="max-interval" className="text-[11px] text-neutral-300 font-medium block mb-1.5">
                        Pausa máxima (segundos)
                      </label>
                      <Input
                        id="max-interval"
                        type="number"
                        min={60}
                        value={globalSettings.max_interval_seconds}
                        onChange={(e) => setGlobalSettings((p) => ({ ...p, max_interval_seconds: Number(e.target.value) }))}
                        className="bg-neutral-950 border-white/10 text-sm h-9 tabular-nums"
                      />
                    </div>
                  </div>
                </section>

                {/* Presença */}
                <section className="space-y-3 border-t border-white/5 pt-6">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                        <Eye className="w-4 h-4 text-emerald-400" />
                        Presença humana
                      </h3>
                      <p className="text-xs text-neutral-400 mt-0.5 max-w-xl">
                        O WhatsApp mostra &quot;digitando...&quot; antes de cada mensagem, como numa conversa de verdade.
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-neutral-400">{globalSettings.enable_typing ? "Ativo" : "Desativado"}</span>
                      <Switch
                        checked={globalSettings.enable_typing}
                        onCheckedChange={(val) => setGlobalSettings((p) => ({ ...p, enable_typing: val }))}
                        aria-label="Ativar presença digitando"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="min-typing" className="text-[11px] text-neutral-300 font-medium block mb-1.5">
                        Tempo mínimo digitando (segundos)
                      </label>
                      <Input
                        id="min-typing"
                        type="number"
                        min={1}
                        max={20}
                        value={globalSettings.min_typing_seconds}
                        onChange={(e) => setGlobalSettings((p) => ({ ...p, min_typing_seconds: Number(e.target.value) }))}
                        className="bg-neutral-950 border-white/10 text-sm h-9 tabular-nums"
                      />
                    </div>

                    <div>
                      <label htmlFor="max-typing" className="text-[11px] text-neutral-300 font-medium block mb-1.5">
                        Tempo máximo digitando (segundos)
                      </label>
                      <Input
                        id="max-typing"
                        type="number"
                        min={2}
                        max={30}
                        value={globalSettings.max_typing_seconds}
                        onChange={(e) => setGlobalSettings((p) => ({ ...p, max_typing_seconds: Number(e.target.value) }))}
                        className="bg-neutral-950 border-white/10 text-sm h-9 tabular-nums"
                      />
                    </div>
                  </div>
                </section>

                {/* Proteções */}
                <section className="space-y-3 border-t border-white/5 pt-6">
                  <div>
                    <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-emerald-400" />
                      Proteções anti-bloqueio
                    </h3>
                    <p className="text-xs text-neutral-400 mt-0.5">
                      Comportamentos extras que deixam o número com cara de uso normal.
                    </p>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                    {PROTECTIONS.map((item) => {
                      const Icon = item.icon;
                      const checked = Boolean(globalSettings[item.key]);
                      return (
                        <div
                          key={item.key}
                          className="flex items-start justify-between gap-3 p-3 rounded-xl bg-neutral-950/60 border border-white/5"
                        >
                          <div className="space-y-0.5 pr-1">
                            <span className="text-xs font-medium text-white flex items-center gap-1.5">
                              <Icon className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                              {item.title}
                            </span>
                            <p className="text-[11px] text-neutral-400 leading-relaxed">{item.description}</p>
                          </div>
                          <Switch
                            checked={checked}
                            onCheckedChange={(val) => setGlobalSettings((p) => ({ ...p, [item.key]: val }))}
                            aria-label={`Ativar ${item.title}`}
                            className="mt-0.5"
                          />
                        </div>
                      );
                    })}
                  </div>
                </section>
              </CardContent>
            )}
          </Card>

          {/* ========================================================================= */}
          {/* LISTA DE CHIPS CONECTADOS */}
          {/* ========================================================================= */}
          <div className="space-y-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                  <Smartphone className="w-4 h-4 text-emerald-400" />
                  Seus chips
                </h2>
                <p className="text-xs text-neutral-400 mt-0.5">
                  Cada chip sobe uma fase quando acumula dias sem erro. A meta diária sobe junto.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-[11px] text-neutral-400">
                {([1, 2, 3, 4] as WarmupStage[]).map((st) => {
                  const Icon = STAGE_UI[st].icon;
                  return (
                    <span key={st} className="inline-flex items-center gap-1.5">
                      <Icon className={`w-3.5 h-3.5 ${STAGE_UI[st].text}`} />
                      {STAGE_UI[st].name}
                    </span>
                  );
                })}
                <span className="text-neutral-500">· {instances.length} detectado(s)</span>
              </div>
            </div>

            {loading ? (
              <div className="space-y-3" aria-busy="true" aria-label="Carregando chips">
                {[0, 1].map((i) => (
                  <div key={i} className="rounded-xl border border-white/10 bg-[#0B0F17] p-5 space-y-4 animate-pulse">
                    <div className="flex items-center justify-between gap-4">
                      <div className="space-y-2">
                        <div className="h-4 w-36 rounded bg-white/10" />
                        <div className="h-3 w-24 rounded bg-white/5" />
                      </div>
                      <div className="h-6 w-24 rounded-full bg-white/5" />
                    </div>
                    <div className="h-2 w-full rounded bg-white/5" />
                    <div className="h-9 w-full rounded bg-white/5" />
                  </div>
                ))}
              </div>
            ) : instances.length === 0 ? (
              <Card className="bg-[#0B0F17] border-white/10 p-8 text-center space-y-3">
                <Smartphone className="w-10 h-10 text-neutral-600 mx-auto" />
                <h3 className="text-base font-medium text-white">Nenhum WhatsApp conectado</h3>
                <p className="text-xs text-neutral-400 max-w-md mx-auto leading-relaxed">
                  Conecte ao menos dois números na área WhatsApp. Eles aparecem aqui automaticamente, já prontos para aquecer.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => (window.location.href = "/whatsapp")}
                  className="border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10"
                >
                  Ir para conexão de WhatsApp
                </Button>
              </Card>
            ) : (
              <div className="space-y-4">
                {instances.length === 1 && (
                  <div className="p-3.5 rounded-xl bg-blue-950/20 border border-blue-500/20 text-blue-200 text-xs flex items-start gap-3">
                    <Info className="w-5 h-5 shrink-0 text-blue-400" />
                    <p className="leading-relaxed">
                      <strong className="text-white">Só 1 chip conectado ({instances[0].instance_name}).</strong> Ele já pode aquecer, mas a conversa automática precisa de dois números. Conecte outro em{" "}
                      <a href="/whatsapp" className="underline text-white font-medium">WhatsApp</a> ou use o botão &quot;Testar disparo&quot;.
                    </p>
                  </div>
                )}

                <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
                  {instances.map((item) => {
                    const instName = item.instance_name;
                    const cfg = item.config;
                    const stage = (cfg.stage || 1) as WarmupStage;
                    const stageInfo = STAGE_DEFAULTS[stage];
                    const stageUI = STAGE_UI[stage];
                    const StageIcon = stageUI.icon;
                    const isConnected = item.connection_status === "open" || item.connection_status === "connected";
                    const isSaving = savingMap[instName];
                    const health = cfg.health_score ?? 100;
                    const healthUI = healthTone(health);
                    const isQuarantined = cfg.is_quarantined;
                    const isDirty = JSON.stringify(savedConfigs[instName]) !== JSON.stringify(cfg);
                    const dailyTarget = cfg.daily_target || 10;
                    const remainingToday = Math.max(0, dailyTarget - (cfg.sent_today || 0));

                    const progressPercent = Math.min(
                      Math.round(((cfg.sent_today || 0) / dailyTarget) * 100),
                      100
                    );

                    return (
                      <Card
                        key={instName}
                        className={`bg-[#0B0F17] border transition-colors ${
                          isQuarantined
                            ? "border-red-500/40 bg-red-950/10"
                            : cfg.enabled
                              ? "border-emerald-500/30"
                              : "border-white/10"
                        }`}
                      >
                        <CardContent className="p-4 sm:p-5 space-y-5">
                          {/* Identificação */}
                          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                            <div className="min-w-0 space-y-1.5">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="font-semibold text-white text-base truncate">{instName}</h3>
                                <Badge
                                  variant="outline"
                                  className={`text-[11px] font-medium ${
                                    isConnected
                                      ? "border-emerald-500/30 text-emerald-300 bg-emerald-500/10"
                                      : "border-red-500/30 text-red-300 bg-red-500/10"
                                  }`}
                                >
                                  {isConnected ? "Conectado" : "Desconectado"}
                                </Badge>
                                <Badge variant="outline" className={`text-[11px] font-medium flex items-center gap-1 ${stageUI.chip}`}>
                                  <StageIcon className="w-3 h-3" />
                                  {stageUI.name}
                                </Badge>
                                {stage === 4 && (
                                  <Badge className="bg-emerald-600/90 text-white text-[11px] flex items-center gap-1 font-semibold">
                                    <Award className="w-3 h-3" /> Pronto para vendas
                                  </Badge>
                                )}
                              </div>
                              <p className="text-xs text-neutral-400 font-mono">
                                {item.phone_number ? `+${item.phone_number}` : "Número ainda não detectado"}
                              </p>
                            </div>

                            <div className="flex items-center justify-between gap-3 sm:justify-end shrink-0 rounded-lg border border-white/5 bg-neutral-900/80 px-3 py-1.5">
                              <span className="text-xs font-medium text-neutral-300">
                                {isQuarantined ? "Em quarentena" : cfg.enabled ? "Aquecendo" : "Pausado"}
                              </span>
                              <Switch
                                checked={cfg.enabled && !isQuarantined}
                                disabled={isQuarantined}
                                onCheckedChange={(val) => handleUpdateConfigField(instName, "enabled", val)}
                                aria-label={`${cfg.enabled ? "Pausar" : "Ativar"} aquecimento de ${instName}`}
                              />
                            </div>
                          </div>

                          {/* Saúde e contexto */}
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
                            <div className="flex items-center gap-2">
                              <span className="text-neutral-400">Saúde:</span>
                              <div className="h-1.5 w-16 rounded-full bg-neutral-800 overflow-hidden">
                                <div className={`h-full rounded-full ${healthUI.bar}`} style={{ width: `${health}%` }} />
                              </div>
                              <span className={`font-medium ${healthUI.text}`}>
                                {health}% · {healthUI.label}
                              </span>
                            </div>

                            <span className="text-neutral-400">
                              Última atividade: <span className="text-neutral-300">{formatRelativeTime(cfg.last_activity_at)}</span>
                            </span>

                            <a
                              href="/whatsapp"
                              className="ml-auto inline-flex items-center gap-1 text-neutral-400 hover:text-emerald-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 rounded"
                            >
                              Configurar proxy <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>

                          {/* Quarentena */}
                          {isQuarantined && (
                            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 space-y-1">
                              <p className="text-xs font-semibold text-red-300 flex items-center gap-1.5">
                                <ShieldAlert className="w-4 h-4" />
                                Aquecimento pausado por segurança
                              </p>
                              <p className="text-[11px] text-red-200/90 leading-relaxed">
                                {cfg.quarantine_reason || "O sistema detectou erros seguidos e colocou este chip em quarentena por 24 horas."}
                                {cfg.quarantine_until ? ` Volta automaticamente em ${new Date(cfg.quarantine_until).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}.` : ""}
                              </p>
                            </div>
                          )}

                          {/* Fase */}
                          <div className="space-y-2.5">
                            <div className="flex flex-wrap items-baseline justify-between gap-2">
                              <span className="text-xs font-medium text-neutral-300">Fase de aquecimento</span>
                              <span className="text-[11px] text-neutral-400">
                                Recomendado: {stageInfo.recommendedDays} · até {stageInfo.dailyTarget} mensagens/dia
                              </span>
                            </div>

                            <div
                              role="group"
                              aria-label={`Fase de aquecimento de ${instName}`}
                              className="grid grid-cols-4 gap-1.5 bg-neutral-950 p-1 rounded-lg border border-white/5"
                            >
                              {([1, 2, 3, 4] as WarmupStage[]).map((st) => {
                                const StIcon = STAGE_UI[st].icon;
                                const isActive = stage === st;
                                return (
                                  <button
                                    key={st}
                                    type="button"
                                    onClick={() => handleUpdateConfigField(instName, "stage", st)}
                                    aria-pressed={isActive}
                                    className={`py-1.5 px-1 rounded text-[11px] sm:text-xs font-medium transition-colors text-center flex items-center justify-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/60 ${
                                      isActive
                                        ? STAGE_UI[st].activeButton
                                        : "text-neutral-400 hover:text-white hover:bg-white/5"
                                    }`}
                                  >
                                    <StIcon className="w-3.5 h-3.5 shrink-0" />
                                    <span className="hidden sm:inline">{STAGE_UI[st].name}</span>
                                    <span className="sm:hidden">{st}</span>
                                  </button>
                                );
                              })}
                            </div>

                            <p className="text-[11px] text-neutral-400 leading-relaxed">{stageInfo.description}</p>
                          </div>

                          {/* Progresso do dia */}
                          <div className="rounded-lg border border-white/5 bg-neutral-950/60 p-3 space-y-2">
                            <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                              <span className="text-neutral-300 font-medium">Hoje</span>
                              <span className="text-neutral-400 tabular-nums">
                                <span className="text-white font-semibold">{cfg.sent_today || 0}</span> de {dailyTarget} enviadas ·{" "}
                                {cfg.received_today || 0} recebidas
                              </span>
                            </div>
                            <div className="w-full bg-neutral-800 rounded-full h-2 overflow-hidden">
                              <div
                                className={`h-2 rounded-full transition-all duration-500 ${
                                  isQuarantined ? "bg-red-500" : progressPercent >= 100 ? "bg-emerald-400" : stageUI.bar
                                }`}
                                style={{ width: `${progressPercent}%` }}
                              />
                            </div>
                            <p className="text-[11px] text-neutral-400">
                              {progressPercent >= 100
                                ? "Meta do dia concluída. O chip volta a conversar amanhã."
                                : `Faltam ${remainingToday} mensagens para bater a meta de hoje.`}
                            </p>
                          </div>

                          {/* Ações */}
                          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => {
                                setTestSender(instName);
                                setTestModalOpen(true);
                              }}
                              className="border-white/10 text-xs text-neutral-300 hover:bg-white/5 hover:text-white"
                            >
                              <Send className="w-3 h-3 mr-1.5" /> Testar este chip
                            </Button>

                            <div className="flex items-center gap-3 sm:justify-end">
                              {isDirty && (
                                <span className="text-[11px] text-amber-300">Alterações não salvas</span>
                              )}
                              <Button
                                size="sm"
                                onClick={() => handleSaveConfig(instName)}
                                disabled={isSaving || !isDirty}
                                className={
                                  isDirty
                                    ? "bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium"
                                    : "bg-white/5 text-neutral-400 text-xs font-medium"
                                }
                              >
                                {isSaving ? (
                                  <>
                                    <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                                    Salvando...
                                  </>
                                ) : isDirty ? (
                                  "Salvar alterações"
                                ) : (
                                  <>
                                    <CheckCircle2 className="w-3.5 h-3.5 mr-1.5" />
                                    Salvo
                                  </>
                                )}
                              </Button>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* ========================================================================= */}
          {/* ATIVIDADE AO VIVO */}
          {/* ========================================================================= */}
          <div className="bg-[#0B0F17] border border-white/10 rounded-xl p-4 sm:p-5 space-y-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-white/5 pb-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${autoRefreshLogs ? "bg-emerald-400 animate-pulse" : "bg-neutral-600"}`} />
                <h3 className="text-sm font-semibold text-white">Atividade ao vivo</h3>
                <Badge variant="outline" className="border-white/10 text-neutral-400 text-[11px]">
                  {logs.length} interações
                </Badge>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-xs text-neutral-400 flex items-center gap-1.5 cursor-pointer">
                  <span>Atualizar sozinho</span>
                  <Switch checked={autoRefreshLogs} onCheckedChange={setAutoRefreshLogs} size="sm" aria-label="Atualizar atividade automaticamente" />
                </label>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => loadData(true)}
                  className="h-7 text-xs text-neutral-400 hover:text-white"
                >
                  <RefreshCw className="w-3 h-3 mr-1" /> Atualizar
                </Button>
              </div>
            </div>

            <div
              ref={logsContainerRef}
              role="log"
              aria-live="polite"
              aria-label="Atividade recente dos chips"
              className="bg-black/60 rounded-lg p-3 font-mono text-xs border border-white/5 max-h-80 overflow-y-auto space-y-2"
            >
              {logs.length === 0 ? (
                <div className="text-center py-8 space-y-2">
                  <Inbox className="w-6 h-6 text-neutral-600 mx-auto" />
                  <p className="text-neutral-400 font-sans">
                    Nada por aqui ainda. Quando dois chips conversarem, as mensagens aparecem nesta lista.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setTestModalOpen(true)}
                    className="border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10 font-sans"
                  >
                    <Send className="w-3 h-3 mr-1.5" /> Ver a primeira conversa
                  </Button>
                </div>
              ) : (
                logs.map((log) => {
                  const time = log.created_at
                    ? new Date(log.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
                    : "--:--:--";
                  const typeUI = LOG_TYPE_UI[log.action_type] || LOG_TYPE_UI.text;
                  const TypeIcon = typeUI.icon;

                  return (
                    <div
                      key={log.id || `${log.created_at}-${log.sender_instance}`}
                      className="p-2 rounded bg-white/[0.02] border border-white/5 flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 sm:gap-3"
                    >
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-emerald-400 font-semibold tabular-nums">{time}</span>
                        <Badge variant="outline" className="text-[11px] border-white/10 text-neutral-300 bg-white/5 flex items-center gap-1">
                          <TypeIcon className="w-3 h-3" />
                          {typeUI.label}
                        </Badge>
                        <span className="text-neutral-200 font-medium">{log.sender_instance}</span>
                        <ArrowRight className="w-3 h-3 text-neutral-600 shrink-0" aria-hidden="true" />
                        <span className="text-neutral-200 font-medium">{log.receiver_instance}</span>
                      </div>

                      <div className="text-neutral-400 text-[11px] font-sans line-clamp-2 sm:truncate sm:max-w-md">
                        {log.message_text}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Dialog de Teste Imediato */}
          <Dialog open={testModalOpen} onOpenChange={setTestModalOpen}>
            <DialogContent className="bg-[#0B0F17] border-white/10 text-white max-w-md">
              <DialogTitle className="text-lg font-bold flex items-center gap-2">
                <Flame className="w-5 h-5 text-emerald-400" />
                Testar uma conversa agora
              </DialogTitle>
              <DialogDescription className="text-xs text-neutral-400">
                O sistema faz uma troca de mensagem imediata entre os chips escolhidos, igual ao aquecimento automático.
              </DialogDescription>

              <div className="space-y-4 pt-3 text-xs">
                <div className="space-y-1.5">
                  <label htmlFor="test-sender" className="text-neutral-300 font-medium">
                    Quem envia
                  </label>
                  <select
                    id="test-sender"
                    value={testSender}
                    onChange={(e) => setTestSender(e.target.value)}
                    className="w-full bg-neutral-900 border border-white/10 rounded-lg p-2 text-white text-xs focus:outline-none focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/30"
                  >
                    <option value="">Selecione o chip remetente</option>
                    {instances.map((i) => (
                      <option key={i.instance_name} value={i.instance_name}>
                        {i.instance_name} {i.phone_number ? `(+${i.phone_number})` : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="test-receiver" className="text-neutral-300 font-medium">
                    Quem recebe
                  </label>
                  <select
                    id="test-receiver"
                    value={testReceiver}
                    onChange={(e) => setTestReceiver(e.target.value)}
                    className="w-full bg-neutral-900 border border-white/10 rounded-lg p-2 text-white text-xs focus:outline-none focus-visible:border-emerald-500 focus-visible:ring-2 focus-visible:ring-emerald-500/30"
                  >
                    <option value="">Selecione o chip destinatário</option>
                    {instances.map((i) => (
                      <option key={i.instance_name} value={i.instance_name}>
                        {i.instance_name} {i.phone_number ? ` (+${i.phone_number})` : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="p-3 rounded-lg bg-emerald-950/20 border border-emerald-500/20 text-neutral-300 text-[11px] space-y-1">
                  <p className="font-semibold text-emerald-300">O que vai acontecer</p>
                  <p>1. O chip remetente fica &quot;digitando...&quot; pelo tempo configurado.</p>
                  <p>2. A mensagem é enviada usando o modelo escolhido ou os diálogos nativos.</p>
                  <p>3. O destinatário confirma a leitura e a conversa aparece em Atividade ao vivo.</p>
                </div>

                {testBlockedReason && (
                  <p className="text-[11px] text-amber-300 flex items-start gap-1.5">
                    <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    {testBlockedReason}
                  </p>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setTestModalOpen(false)}
                    className="border-white/10 text-neutral-300 hover:bg-white/5 hover:text-white"
                  >
                    Cancelar
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleRunTest}
                    disabled={testLoading || Boolean(testBlockedReason)}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white font-medium"
                  >
                    {testLoading ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                        Executando...
                      </>
                    ) : (
                      "Disparar teste agora"
                    )}
                  </Button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </main>
    </div>
  );
}
