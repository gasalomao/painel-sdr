"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Header } from "@/components/layout/header";
import { Card } from "@/components/ui/card";
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
  ArrowRightLeft,
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
  Users,
  Trash2,
  Zap,
  Target,
  type LucideIcon,
} from "lucide-react";
import { ModelOptions } from "@/components/ai-module-shared";
import type { GroupableModel } from "@/lib/model-grouping";
import {
  STAGE_DEFAULTS,
  PURPOSE_METADATA,
  type WarmupConfig,
  type WarmupLog,
  type WarmupStage,
  type WarmupPurpose,
} from "@/lib/warmup/warmup-types";
import { WARMUP_THEMES } from "@/lib/warmup/warmup-dialogues";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import styles from "./aquecer-chips.module.css";

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
    text: string;
    bar: string;
  }
> = {
  1: {
    name: "Frio",
    icon: Snowflake,
    chip: "border-sky-500/30 bg-sky-500/10 text-sky-300",
    text: "text-sky-300",
    bar: "bg-sky-500",
  },
  2: {
    name: "Morno",
    icon: Coffee,
    chip: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    text: "text-amber-300",
    bar: "bg-amber-500",
  },
  3: {
    name: "Quente",
    icon: Flame,
    chip: "border-orange-500/30 bg-orange-500/10 text-orange-300",
    text: "text-orange-300",
    bar: "bg-orange-500",
  },
  4: {
    name: "Blindado",
    icon: ShieldCheck,
    chip: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    text: "text-emerald-300",
    bar: "bg-emerald-500",
  },
};

const LOG_TYPE_UI: Record<string, { label: string; icon: LucideIcon; chip: string }> = {
  text: { label: "Mensagem", icon: MessageSquare, chip: "border-white/10 bg-white/5 text-neutral-300" },
  reaction: { label: "Reação", icon: Smile, chip: "border-white/10 bg-white/5 text-neutral-300" },
  audio: { label: "Áudio", icon: Volume2, chip: "border-white/10 bg-white/5 text-neutral-300" },
  presence: { label: "Digitando", icon: Eye, chip: "border-white/10 bg-white/5 text-neutral-300" },
  vcard: { label: "Contato", icon: Contact, chip: "border-white/10 bg-white/5 text-neutral-300" },
  status: { label: "Status", icon: ImageIcon, chip: "border-white/10 bg-white/5 text-neutral-300" },
  circuit_breaker: { label: "Proteção", icon: ShieldAlert, chip: "border-red-500/30 bg-red-500/10 text-red-300" },
  system: { label: "Sistema", icon: Settings2, chip: "border-white/10 bg-white/5 text-neutral-300" },
};

const PROTECTIONS: Array<{ key: keyof GlobalSettings; icon: LucideIcon; title: string; description: string }> = [  {
    key: "enable_vcard",
    icon: Contact,
    title: "Troca de contatos (vCard)",
    description: "Cada chip salva o outro na agenda, como acontece entre pessoas reais.",
  },
  {
    key: "enable_audio",
    icon: Volume2,
    title: "Áudio gravado na hora",
    description: "Envia mensagens de voz curtas para variar as conversas.",
  },
  {
    key: "enable_status_posts",
    icon: Radio,
    title: "Status / Stories",
    description: "Publica frases e atualizações nos Stories para simular uso social ativo.",
  },
  {
    key: "enable_blue_ticks",
    icon: CheckCheck,
    title: "Confirmação de leitura",
    description: "Marca as mensagens recebidas como lidas (tiques azuis) com atraso humano.",
  },
  {
    key: "enable_reactions",
    icon: Smile,
    title: "Reações com emoji",
    description: "Reage casualmente às mensagens do parceiro com emojis contextuais.",
  },
  {
    key: "stage_auto_progress",
    icon: Activity,
    title: "Piloto automático de fases",
    description: "Evolui o chip de fase sozinho conforme acumula dias sem qualquer erro.",
  },
];

const STAGE_HINT: Record<WarmupStage, string> = {
  1: "Número novo: recebe mais do que envia e conversa devagar.",
  2: "Já tem histórico: começa a mandar áudios e a reagir às mensagens.",
  3: "Mais confiança: pode enviar até 50 mensagens por dia.",
  4: "Blindado: pronto para campanhas e disparos em escala.",
};

const PURPOSE_SHORT: Record<WarmupPurpose, string> = {
  contingency: "Reserva",
  inbound: "Receber leads",
  outbound: "Prospecção",
};

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
    totalGroups: 0,
  });
  const [aiModels, setAiModels] = useState<GroupableModel[]>([]);
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [savingMap, setSavingMap] = useState<Record<string, boolean>>({});
  const [bulkBusy, setBulkBusy] = useState(false);

  // Tabs do Módulo
  const [activeTab, setActiveTab] = useState<"chips" | "groups" | "logs">("chips");

  // Grupos e Swarm
  const [groups, setGroups] = useState<any[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [importLinksInput, setImportLinksInput] = useState("");
  const [importingGroups, setImportingGroups] = useState(false);
  const [syncingGroups, setSyncingGroups] = useState(false);
  const [swarmActivating, setSwarmActivating] = useState(false);
  const [swarmCycleLoading, setSwarmCycleLoading] = useState(false);

  // Configurações Gerais
  const [globalSettings, setGlobalSettings] = useState<GlobalSettings>(DEFAULT_GLOBAL_SETTINGS);
  const [savedGlobalSettings, setSavedGlobalSettings] = useState<GlobalSettings>(DEFAULT_GLOBAL_SETTINGS);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Modal de teste imediato
  const [testModalOpen, setTestModalOpen] = useState(false);
  const [testSender, setTestSender] = useState("");
  const [testReceiver, setTestReceiver] = useState("");
  const [testLoading, setTestLoading] = useState(false);
  const [testStatusPost, setTestStatusPost] = useState(false);

  // Modal de Aquecimento Mútuo Automático (Dois Chips)
  const [mutualModalOpen, setMutualModalOpen] = useState(false);
  const [pairChipA, setPairChipA] = useState("");
  const [pairChipB, setPairChipB] = useState("");
  const [mutualLoading, setMutualLoading] = useState(false);
  const [autopilotLoading, setAutopilotLoading] = useState(false);
  const [mutualStatusPost, setMutualStatusPost] = useState(true);

  // Guia explicativo de funcionamento
  const [explainerOpen, setExplainerOpen] = useState(false);

  // Ações avançadas (colmeia, rodada manual, teste)
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Auto-refresh de logs
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
      }
    } catch {
      toast.error("Falha ao carregar dados do aquecedor de chips.");
    } finally {
      setLoading(false);
      if (!isSilent) setRefreshing(false);
    }
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const res = await fetch("/api/ai/models");
      const data = await res.json();
      if (Array.isArray(data)) {
        setAiModels(data);
      }
    } catch {
      // Ignora falhas nos modelos de IA
    }
  }, []);

  const loadGroups = useCallback(async () => {
    setGroupsLoading(true);
    try {
      const res = await fetch("/api/warmup/groups", { cache: "no-store" });
      const data = await res.json();
      if (data.success && Array.isArray(data.groups)) {
        setGroups(data.groups);
      }
    } catch {
      // silencioso
    } finally {
      setGroupsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
    loadModels();
    loadGroups();
  }, [loadData, loadModels, loadGroups]);

  const handleImportGroups = async () => {
    if (!importLinksInput.trim()) {
      toast.error("Cole ao menos um link de grupo do WhatsApp.");
      return;
    }
    setImportingGroups(true);
    try {
      const activeInstance = instances.find((i) => i.connection_status === "open")?.instance_name;
      const res = await fetch("/api/warmup/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          links: importLinksInput,
          preferredInstance: activeInstance,
          autoSync: true,
        }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message || `${data.added} grupo(s) adicionado(s) com sucesso!`);
        setImportLinksInput("");
        await loadGroups();
        await loadData(true);
      } else {
        toast.error(data.error || "Falha ao importar grupos.");
      }
    } catch (err: any) {
      toast.error("Erro na importação: " + err.message);
    } finally {
      setImportingGroups(false);
    }
  };

  const handleSyncGroupMembers = async () => {
    setSyncingGroups(true);
    try {
      const res = await fetch("/api/warmup/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "sync_members" }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message || "Chips sincronizados nos grupos!");
        await loadGroups();
      } else {
        toast.error(data.error || "Falha na sincronização.");
      }
    } catch (err: any) {
      toast.error("Erro: " + err.message);
    } finally {
      setSyncingGroups(false);
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    try {
      const res = await fetch(`/api/warmup/groups?id=${groupId}`, { method: "DELETE" });
      const data = await res.json();
      if (data.success) {
        toast.success("Grupo removido.");
        setGroups((prev) => prev.filter((g) => g.id !== groupId));
      } else {
        toast.error(data.error || "Falha ao remover grupo.");
      }
    } catch (err: any) {
      toast.error("Erro: " + err.message);
    }
  };

  const handleActivateSwarm = async () => {
    setSwarmActivating(true);
    try {
      const res = await fetch("/api/warmup/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ swarmAutopilot: true }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message || "Colmeia Autônoma ativada para todos os chips!");
        await loadData();
        await loadGroups();
      } else {
        toast.error(data.error || "Falha ao ativar colmeia.");
      }
    } catch (err: any) {
      toast.error("Erro: " + err.message);
    } finally {
      setSwarmActivating(false);
    }
  };

  const handleTriggerSwarmCycle = async () => {
    setSwarmCycleLoading(true);
    try {
      const res = await fetch("/api/warmup/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ swarmCycle: true }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message || "Rodada da colmeia executada com sucesso!");
        await loadData(true);
        await loadGroups();
      } else {
        toast.error(data.error || "Falha ao executar rodada da colmeia.");
      }
    } catch (err: any) {
      toast.error("Erro: " + err.message);
    } finally {
      setSwarmCycleLoading(false);
    }
  };

  useEffect(() => {
    if (!autoRefreshLogs) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/warmup/logs?limit=30");
        const data = await res.json();
        if (data.success && Array.isArray(data.logs)) {
          setLogs(data.logs);
        }
      } catch {
        // silencioso
      }
    }, 8000);
    return () => clearInterval(interval);
  }, [autoRefreshLogs]);

  const globalDirty = JSON.stringify(globalSettings) !== JSON.stringify(savedGlobalSettings);

  const totalDailyTarget = instances.reduce((acc, i) => acc + (i.config?.daily_target || 0), 0);

  const selectedModelLabel =
    globalSettings.ai_model === "fallback"
      ? "Diálogos Nativos pt-BR"
      : aiModels.find((m) => m.id === globalSettings.ai_model)?.name ||
        globalSettings.ai_model.split("/").pop() ||
        globalSettings.ai_model;

  const selectedThemeLabel =
    WARMUP_THEMES.find((t) => t.id === globalSettings.ai_theme)?.label || globalSettings.ai_theme;

  const handleUpdateConfigField = (instanceName: string, field: keyof WarmupConfig, value: any) => {
    setInstances((prev) =>
      prev.map((item) => {
        if (item.instance_name !== instanceName) return item;
        const nextCfg = { ...item.config, [field]: value };
        if (field === "stage") {
          const stNum = Number(value) as WarmupStage;
          if (STAGE_DEFAULTS[stNum]) {
            nextCfg.daily_target = STAGE_DEFAULTS[stNum].dailyTarget;
          }
        }
        return { ...item, config: nextCfg };
      })
    );
  };

  const handleSaveConfig = async (instanceName: string) => {
    const target = instances.find((i) => i.instance_name === instanceName);
    if (!target) return;

    setSavingMap((prev) => ({ ...prev, [instanceName]: true }));
    try {
      const res = await fetch("/api/warmup", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(target.config),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`Configurações de ${instanceName} salvas com sucesso.`);
        setSavedConfigs((prev) => ({ ...prev, [instanceName]: target.config }));
      } else {
        toast.error(`Falha ao salvar: ${data.error}`);
      }
    } catch (err: any) {
      toast.error(`Erro ao salvar: ${err.message}`);
    } finally {
      setSavingMap((prev) => ({ ...prev, [instanceName]: false }));
    }
  };

  const handleSaveGlobalSettings = async () => {
    setSavingGlobal(true);
    try {
      const res = await fetch("/api/warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "global_settings",
          ...globalSettings,
        }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success("Ajustes gerais do aquecedor atualizados.");
        setSavedGlobalSettings(globalSettings);
      } else {
        toast.error(`Falha ao salvar: ${data.error}`);
      }
    } catch (err: any) {
      toast.error(`Erro ao salvar: ${err.message}`);
    } finally {
      setSavingGlobal(false);
    }
  };

  const handleToggleBulk = async (action: "enable_all" | "pause_all") => {
    setBulkBusy(true);
    const isEnable = action === "enable_all";
    try {
      const res = await fetch("/api/warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
        }),
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
        body: JSON.stringify({
          instanceA: testSender,
          instanceB: testReceiver,
          testStatusPost,
        }),
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

  const openPairModal = (chipA?: string, chipB?: string) => {
    if (chipA) {
      setPairChipA(chipA);
      if (chipB) {
        setPairChipB(chipB);
      } else {
        const other = instances.find((i) => i.instance_name !== chipA);
        if (other) setPairChipB(other.instance_name);
      }
    } else if (instances.length >= 2) {
      setPairChipA(instances[0].instance_name);
      setPairChipB(instances[1].instance_name);
    } else if (instances.length === 1) {
      setPairChipA(instances[0].instance_name);
    }
    setMutualModalOpen(true);
  };

  const handleRunMutualWarmup = async () => {
    if (!pairChipA || !pairChipB) {
      toast.error("Selecione os dois chips para o aquecimento mútuo.");
      return;
    }
    if (pairChipA === pairChipB) {
      toast.error("Escolha dois chips diferentes para a troca mútua.");
      return;
    }

    setMutualLoading(true);
    try {
      const res = await fetch("/api/warmup/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instanceA: pairChipA,
          instanceB: pairChipB,
          mutual: true,
          testStatusPost: mutualStatusPost,
        }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message || "Aquecimento mútuo executado com sucesso!");
        await loadData(true);
      } else {
        toast.error(data.error || "Falha ao executar aquecimento mútuo.");
      }
    } catch (err: any) {
      toast.error("Erro na execução: " + err.message);
    } finally {
      setMutualLoading(false);
    }
  };

  const handleEnablePairAutopilot = async () => {
    if (!pairChipA || !pairChipB) {
      toast.error("Selecione os dois chips para ativar o piloto automático.");
      return;
    }
    if (pairChipA === pairChipB) {
      toast.error("Escolha dois chips diferentes.");
      return;
    }

    setAutopilotLoading(true);
    try {
      const res = await fetch("/api/warmup/trigger", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instanceA: pairChipA,
          instanceB: pairChipB,
          autopilot: true,
        }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message || "Piloto Automático ativado com sucesso para o par!");
        setMutualModalOpen(false);
        await loadData(true);
      } else {
        toast.error(data.error || "Falha ao ativar piloto automático.");
      }
    } catch (err: any) {
      toast.error("Erro: " + err.message);
    } finally {
      setAutopilotLoading(false);
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

  const connectedCount = instances.filter(
    (i) => i.connection_status === "open" || i.connection_status === "connected"
  ).length;
  const quarantinedCount = instances.filter((i) => i.config?.is_quarantined).length;
  const activeChipCount = instances.filter(
    (i) => i.config?.enabled && !i.config?.is_quarantined
  ).length;
  const hasActiveChips = activeChipCount > 0;

  const statusPrimary =
    instances.length === 0
      ? "Nenhum número conectado ainda"
      : !hasActiveChips
        ? `Aquecimento pausado nos ${instances.length} números`
        : `Aquecendo ${activeChipCount} de ${instances.length} números`;

  const statusDetail = [
    instances.length === 0
      ? "Conecte dois para começar"
      : totalDailyTarget > 0
        ? `${stats.totalSentToday} de ${totalDailyTarget} mensagens hoje`
        : null,
    instances.length === 0
      ? null
      : `janela ${formatHour(globalSettings.allowed_start_hour)} às ${formatHour(globalSettings.allowed_end_hour)}`,
    quarantinedCount > 0 ? `${quarantinedCount} em quarentena` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className={cn("h-[100dvh] max-h-[100dvh] flex flex-col overflow-hidden", styles.page)}>
      <Header />

      <div className={styles.content}>
        <div className="max-w-7xl mx-auto space-y-7 pb-16">
          {/* Cabeçalho da página */}
          <div className={styles.heading}>
            <div className={styles.statusBlock}>
              <p className={styles.statusLine} aria-live="polite">
                <span className={styles.statusDot} aria-hidden="true" />
                <span className={styles.statusPrimary}>{statusPrimary}</span>
                {statusDetail && <span className={styles.statusDetail}>{statusDetail}</span>}
              </p>
              <p className={styles.headingDescription}>
                Seus números conversam entre si sozinhos para ganhar confiança no WhatsApp antes de entrar nas campanhas.
              </p>
            </div>

            <div className={styles.headingActions}>
              <button
                type="button"
                onClick={() => openPairModal()}
                disabled={instances.length === 0}
                className={cn(styles.primaryAction, "bg-emerald-400 hover:bg-emerald-300 text-neutral-950 font-semibold shadow-sm flex items-center gap-2")}
                title={instances.length === 0 ? "Conecte um número primeiro" : "Escolhe dois números e deixa o sistema cuidar do resto"}
              >
                <Flame className="w-4 h-4 text-neutral-950" />
                Aquecer dois chips
              </button>
              <button
                type="button"
                onClick={() => handleToggleBulk(hasActiveChips ? "pause_all" : "enable_all")}
                disabled={bulkBusy || instances.length === 0}
                className={styles.secondaryAction}
                title={hasActiveChips ? "Pausa o aquecimento em todos os números" : "Liga o aquecimento em todos os números"}
              >
                {hasActiveChips ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                {bulkBusy ? "Aplicando..." : hasActiveChips ? "Pausar tudo" : "Ativar tudo"}
              </button>
              <button
                type="button"
                onClick={() => setAdvancedOpen((v) => !v)}
                aria-expanded={advancedOpen}
                aria-controls="acoes-avancadas"
                className={styles.secondaryAction}
              >
                <Settings2 className="w-3.5 h-3.5" />
                Mais ações
                <ChevronDown className={`w-3.5 h-3.5 transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
              </button>
              <button
                type="button"
                onClick={() => {
                  loadData();
                  loadGroups();
                }}
                disabled={refreshing || groupsLoading}
                className={styles.iconAction}
                title="Atualizar dados"
                aria-label="Atualizar dados"
              >
                <RefreshCw className={`w-4 h-4 ${refreshing || groupsLoading ? "animate-spin" : ""}`} />
              </button>
            </div>
          </div>

          {/* Ações avançadas */}
          {advancedOpen && (
            <div id="acoes-avancadas" className={styles.advancedPanel}>
              <div className={styles.advancedRow}>
                <div>
                  <p className={styles.advancedTitle}>Ativar colmeia autônoma</p>
                  <p className={styles.advancedDesc}>Liga o piloto automático em todos os números e sincroniza os grupos de uma vez.</p>
                </div>
                <button
                  type="button"
                  onClick={handleActivateSwarm}
                  disabled={swarmActivating || instances.length === 0}
                  className={styles.secondaryAction}
                >
                  <Zap className="w-3.5 h-3.5 text-emerald-400" />
                  {swarmActivating ? "Ativando..." : "Ativar colmeia"}
                </button>
              </div>

              <div className={styles.advancedRow}>
                <div>
                  <p className={styles.advancedTitle}>Rodada manual agora</p>
                  <p className={styles.advancedDesc}>Dispara uma rodada de conversa em todos os números neste instante, sem esperar o próximo horário.</p>
                </div>
                <button
                  type="button"
                  onClick={handleTriggerSwarmCycle}
                  disabled={swarmCycleLoading || instances.length === 0}
                  className={styles.secondaryAction}
                >
                  <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
                  {swarmCycleLoading ? "Executando..." : "Rodar agora"}
                </button>
              </div>

              <div className={styles.advancedRow}>
                <div>
                  <p className={styles.advancedTitle}>Testar uma conversa</p>
                  <p className={styles.advancedDesc}>Escolhe dois números e envia uma mensagem de teste, igual ao aquecimento automático.</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (instances.length >= 2) {
                      setTestSender(instances[0].instance_name);
                      setTestReceiver(instances[1].instance_name);
                    } else if (instances.length === 1) {
                      setTestSender(instances[0].instance_name);
                    }
                    setTestModalOpen(true);
                  }}
                  disabled={instances.length === 0}
                  className={styles.secondaryAction}
                >
                  <Send className="w-3.5 h-3.5" />
                  Abrir teste
                </button>
              </div>
            </div>
          )}

          {/* ========================================================================= */}
          {/* GUIA EXPLICATIVO: COMO FUNCIONA O AQUECIMENTO AUTOMÁTICO */}
          {/* ========================================================================= */}
          <div className={styles.explainerBanner}>
            <div className={styles.explainerHeader}>
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 shrink-0">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-sm font-semibold text-white flex items-center gap-2">
                    Como funciona, em 4 passos
                  </h2>
                  <p className="text-xs text-neutral-400 mt-0.5 leading-relaxed">
                    O sistema age como duas pessoas que se conhecem. Você não precisa fazer nada depois de ligar.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setExplainerOpen((v) => !v)}
                  aria-expanded={explainerOpen}
                  aria-controls="explicacao-aquecimento"
                  className={styles.secondaryAction}
                >
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${explainerOpen ? "rotate-180" : ""}`} />
                  <span className="text-xs">{explainerOpen ? "Ocultar" : "Ver passos"}</span>
                </button>
              </div>
            </div>

            {explainerOpen && (
              <ol id="explicacao-aquecimento" className={styles.stepsList}>
                <li className={styles.stepItem}>
                  <span className={styles.stepNumber} aria-hidden="true">1</span>
                  <div>
                    <p className={styles.stepTitle}>Salvam o contato um do outro</p>
                    <p className={styles.stepDesc}>Antes de conversar, os números trocam contato. O WhatsApp entende que são pessoas que se conhecem.</p>
                  </div>
                </li>
                <li className={styles.stepItem}>
                  <span className={styles.stepNumber} aria-hidden="true">2</span>
                  <div>
                    <p className={styles.stepTitle}>Conversam como gente</p>
                    <p className={styles.stepDesc}>Mensagens curtas, áudios, reações e o &quot;digitando...&quot; antes de responder.</p>
                  </div>
                </li>
                <li className={styles.stepItem}>
                  <span className={styles.stepNumber} aria-hidden="true">3</span>
                  <div>
                    <p className={styles.stepTitle}>Ganham confiança aos poucos</p>
                    <p className={styles.stepDesc}>Começam com poucas mensagens por dia e sobem de fase sozinhos conforme os dias passam sem erro.</p>
                  </div>
                </li>
                <li className={styles.stepItem}>
                  <span className={styles.stepNumber} aria-hidden="true">4</span>
                  <div>
                    <p className={styles.stepTitle}>Param sozinhos se algo der errado</p>
                    <p className={styles.stepDesc}>Ao primeiro sinal de instabilidade o número entra em quarentena por 24 horas, em vez de arriscar o bloqueio.</p>
                  </div>
                </li>
              </ol>
            )}
          </div>

          {/* Resumo do dia / Métricas Rápidas */}
          <div className={styles.overviewGrid}>
            <div className={styles.overviewCard}>
              <span className={styles.overviewLabel}>
                <Flame className="w-3.5 h-3.5 text-emerald-400" />
                Aquecendo agora
              </span>
              <span className={cn(styles.overviewValue, "text-emerald-300")}>
                {activeChipCount}
                <span className="text-base font-medium text-neutral-500"> de {instances.length}</span>
              </span>
              <span className={styles.overviewSubtext}>
                {quarantinedCount > 0
                  ? `${quarantinedCount} em quarentena`
                  : `${connectedCount} conectado(s) ao WhatsApp`}
              </span>
            </div>

            <div className={styles.overviewCard}>
              <span className={styles.overviewLabel}>
                <Send className="w-3.5 h-3.5 text-neutral-400" />
                Mensagens hoje
              </span>
              <span className={styles.overviewValue}>
                {stats.totalSentToday}
                {totalDailyTarget > 0 && (
                  <span className="text-base font-medium text-neutral-500"> de {totalDailyTarget}</span>
                )}
              </span>
              <span className={styles.overviewSubtext}>
                {totalDailyTarget > 0
                  ? stats.totalSentToday >= totalDailyTarget
                    ? "meta do dia concluída"
                    : `faltam ${totalDailyTarget - stats.totalSentToday} para a meta`
                  : "enviadas pelos números"}
              </span>
            </div>

            <div className={styles.overviewCard}>
              <span className={styles.overviewLabel}>
                <MessageSquare className="w-3.5 h-3.5 text-neutral-400" />
                Respostas recebidas
              </span>
              <span className={styles.overviewValue}>{stats.totalReceivedToday}</span>
              <span className={styles.overviewSubtext}>mensagens que os parceiros devolveram</span>
            </div>

            <div className={styles.overviewCard}>
              <span className={styles.overviewLabel}>
                <Users className="w-3.5 h-3.5 text-blue-400" />
                Grupos de aquecimento
              </span>
              <span className={cn(styles.overviewValue, "text-blue-300")}>{groups.length}</span>
              <span className={styles.overviewSubtext}>
                {groups.length === 0 ? "nenhum grupo adicionado" : "onde os números ganham atividade"}
              </span>
            </div>
          </div>

          {/* ========================================================================= */}
          {/* TABS DE NAVEGAÇÃO DA COLMEIA */}
          {/* ========================================================================= */}
          <div className={styles.tabsBar}>
            <button
              type="button"
              onClick={() => setActiveTab("chips")}
              className={cn(styles.tabButton, activeTab === "chips" && styles.tabButtonActive)}
            >
              <Smartphone className="w-4 h-4" />
              <span>Meus chips</span>
              <span className={cn(styles.tabBadge, activeTab === "chips" && styles.tabBadgeActive)}>
                {instances.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("groups")}
              className={cn(styles.tabButton, activeTab === "groups" && styles.tabButtonActive)}
            >
              <Users className="w-4 h-4" />
              <span>Grupos</span>
              <span className={cn(styles.tabBadge, activeTab === "groups" && styles.tabBadgeActive)}>
                {groups.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("logs")}
              className={cn(styles.tabButton, activeTab === "logs" && styles.tabButtonActive)}
            >
              <Clock className="w-4 h-4" />
              <span>Atividade</span>
              <span className={cn(styles.tabBadge, activeTab === "logs" && styles.tabBadgeActive)}>
                {logs.length}
              </span>
            </button>
          </div>

          {/* ========================================================================= */}
          {/* ABA 1: MEUS CHIPS & COLMEIA */}
          {/* ========================================================================= */}
          {activeTab === "chips" && (
            <div className="space-y-6">
              {/* AJUSTES GERAIS: COMO AS CONVERSAS ACONTECEM */}
              <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 shrink-0">
                  <Bot className="w-5 h-5" />
                </div>
                <div>
                  <h2 className={styles.panelTitle}>Como as conversas acontecem</h2>
                  <p className={styles.panelDescription}>
                    Modelo: <strong className="text-neutral-200">{selectedModelLabel}</strong> · Assunto: <strong className="text-neutral-200">{selectedThemeLabel}</strong> · Horário: <strong className="text-neutral-200">{formatHour(globalSettings.allowed_start_hour)} às {formatHour(globalSettings.allowed_end_hour)}</strong>
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setSettingsOpen((v) => !v)}
                  aria-expanded={settingsOpen}
                  aria-controls="ajustes-gerais"
                  className={styles.secondaryAction}
                >
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${settingsOpen ? "rotate-180" : ""}`} />
                  {settingsOpen ? "Ocultar ajustes" : "Ajustar"}
                </button>
                <button
                  type="button"
                  onClick={handleSaveGlobalSettings}
                  disabled={savingGlobal || !globalDirty}
                  className={globalDirty ? styles.primaryAction : styles.secondaryAction}
                >
                  {savingGlobal ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      Salvando...
                    </>
                  ) : globalDirty ? (
                    "Salvar alterações"
                  ) : (
                    <>
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                      Tudo salvo
                    </>
                  )}
                </button>
              </div>
            </div>

            {settingsOpen && (
              <div id="ajustes-gerais" className={styles.panelBody}>
                <div className="space-y-6">
                  {/* Conversas */}
                  <section className="space-y-3">
                    <div className="flex items-center gap-2">
                      <MessageSquare className="w-4 h-4 text-emerald-400" />
                      <h3 className="text-sm font-semibold text-white">Conversas & Diálogos</h3>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div className={styles.fieldGroup}>
                        <label htmlFor="ai-model" className={styles.fieldLabel}>
                          <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
                          Modelo de IA
                        </label>
                        <select
                          id="ai-model"
                          value={globalSettings.ai_model}
                          onChange={(e) => setGlobalSettings((p) => ({ ...p, ai_model: e.target.value }))}
                          className={styles.fieldSelect}
                        >
                          <option value="fallback" className="bg-[#181d19] text-emerald-400 font-semibold">
                            ★ [GRÁTIS] Diálogos Nativos pt-BR (Zero Consumo de Tokens)
                          </option>
                          <ModelOptions models={aiModels} />
                        </select>
                        <p className={styles.fieldHint}>
                          Assunto que as conversas automáticas vão usar. A opção grátis usa frases prontas em português ({aiModels.length} modelos disponíveis).
                        </p>
                      </div>

                      <div className={styles.fieldGroup}>
                        <label htmlFor="ai-theme" className={styles.fieldLabel}>
                          <MessageSquare className="w-3.5 h-3.5 text-emerald-400" />
                          Assunto das conversas
                        </label>
                        <select
                          id="ai-theme"
                          value={globalSettings.ai_theme}
                          onChange={(e) => setGlobalSettings((p) => ({ ...p, ai_theme: e.target.value }))}
                          className={styles.fieldSelect}
                        >
                          {WARMUP_THEMES.map((t) => (
                            <option key={t.id} value={t.id} className="bg-[#181d19] text-white">
                              {t.label}
                            </option>
                          ))}
                        </select>
                        <p className={styles.fieldHint}>
                          Tema usado para criar diálogos realistas entre os números.
                        </p>
                      </div>
                    </div>
                  </section>

                  {/* Ritmo */}
                  <section className="space-y-3 border-t border-[#2a352c] pt-5">
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-emerald-400" />
                      <h3 className="text-sm font-semibold text-white">Ritmo e Janela de Horários</h3>
                    </div>

                    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                      <div className={styles.fieldGroup}>
                        <label htmlFor="start-hour" className={styles.fieldLabel}>
                          Começa às (hora)
                        </label>
                        <Input
                          id="start-hour"
                          type="number"
                          min={0}
                          max={23}
                          value={globalSettings.allowed_start_hour}
                          onChange={(e) => setGlobalSettings((p) => ({ ...p, allowed_start_hour: Number(e.target.value) }))}
                          className={styles.fieldInput}
                        />
                      </div>

                      <div className={styles.fieldGroup}>
                        <label htmlFor="end-hour" className={styles.fieldLabel}>
                          Termina às (hora)
                        </label>
                        <Input
                          id="end-hour"
                          type="number"
                          min={1}
                          max={24}
                          value={globalSettings.allowed_end_hour}
                          onChange={(e) => setGlobalSettings((p) => ({ ...p, allowed_end_hour: Number(e.target.value) }))}
                          className={styles.fieldInput}
                        />
                      </div>

                      <div className={styles.fieldGroup}>
                        <label htmlFor="min-interval" className={styles.fieldLabel}>
                          Pausa mínima (segundos)
                        </label>
                        <Input
                          id="min-interval"
                          type="number"
                          min={30}
                          value={globalSettings.min_interval_seconds}
                          onChange={(e) => setGlobalSettings((p) => ({ ...p, min_interval_seconds: Number(e.target.value) }))}
                          className={styles.fieldInput}
                        />
                      </div>

                      <div className={styles.fieldGroup}>
                        <label htmlFor="max-interval" className={styles.fieldLabel}>
                          Pausa máxima (segundos)
                        </label>
                        <Input
                          id="max-interval"
                          type="number"
                          min={60}
                          value={globalSettings.max_interval_seconds}
                          onChange={(e) => setGlobalSettings((p) => ({ ...p, max_interval_seconds: Number(e.target.value) }))}
                          className={styles.fieldInput}
                        />
                      </div>
                    </div>
                  </section>

                  {/* Presença */}
                  <section className="space-y-3 border-t border-[#2a352c] pt-5">
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex items-center gap-2">
                        <Eye className="w-4 h-4 text-emerald-400" />
                        <h3 className="text-sm font-semibold text-white">Presença Humana (Digitando...)</h3>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-neutral-400">{globalSettings.enable_typing ? "Ativo" : "Desativado"}</span>
                        <Switch
                          checked={globalSettings.enable_typing}
                          onCheckedChange={(val) => setGlobalSettings((p) => ({ ...p, enable_typing: val }))}
                          aria-label="Ativar presença digitando"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      <div className={styles.fieldGroup}>
                        <label htmlFor="min-typing" className={styles.fieldLabel}>
                          Tempo mínimo digitando (segundos)
                        </label>
                        <Input
                          id="min-typing"
                          type="number"
                          min={1}
                          max={20}
                          value={globalSettings.min_typing_seconds}
                          onChange={(e) => setGlobalSettings((p) => ({ ...p, min_typing_seconds: Number(e.target.value) }))}
                          className={styles.fieldInput}
                        />
                      </div>

                      <div className={styles.fieldGroup}>
                        <label htmlFor="max-typing" className={styles.fieldLabel}>
                          Tempo máximo digitando (segundos)
                        </label>
                        <Input
                          id="max-typing"
                          type="number"
                          min={2}
                          max={30}
                          value={globalSettings.max_typing_seconds}
                          onChange={(e) => setGlobalSettings((p) => ({ ...p, max_typing_seconds: Number(e.target.value) }))}
                          className={styles.fieldInput}
                        />
                      </div>
                    </div>
                  </section>

                  {/* Proteções */}
                  <section className="space-y-3 border-t border-[#2a352c] pt-5">
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-emerald-400" />
                      <h3 className="text-sm font-semibold text-white">Proteções contra bloqueio</h3>
                    </div>

                    <div className={styles.protectionsGrid}>
                      {PROTECTIONS.map((item) => {
                        const Icon = item.icon;
                        const checked = Boolean(globalSettings[item.key]);
                        return (
                          <div key={item.key} className={styles.protectionItem}>
                            <div>
                              <span className={styles.protectionTitle}>
                                <Icon className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                                {item.title}
                              </span>
                              <p className={styles.protectionDesc}>{item.description}</p>
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
                </div>
              </div>
            )}
          </div>

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
                  Cada número sobe de fase sozinho. Quanto mais dias sem erro, mais mensagens ele envia por dia.
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
                <span className="text-neutral-500">· {instances.length} números</span>
              </div>
            </div>

            {loading ? (
              <div className="space-y-3" aria-busy="true" aria-label="Carregando chips">
                {[0, 1].map((i) => (
                  <div key={i} className="rounded-xl border border-[#303a32] bg-[#181d19] p-5 space-y-4 animate-pulse">
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
              <Card className="bg-[#181d19] border-[#303a32] p-8 text-center space-y-3">
                <Smartphone className="w-10 h-10 text-neutral-600 mx-auto" />
                <h3 className="text-base font-medium text-white">Nenhum número conectado ainda</h3>
                <p className="text-xs text-neutral-400 max-w-md mx-auto leading-relaxed">
                  Conecte dois números do WhatsApp. Eles aparecem aqui automaticamente, prontos para aquecer.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => (window.location.href = "/whatsapp")}
                  className="border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10"
                >
                  Conectar um número
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

                <div className={styles.chipsGrid}>
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
                    const purposeKey = (cfg.purpose || "outbound") as WarmupPurpose;
                    const purposeMeta = PURPOSE_METADATA[purposeKey];

                    const progressPercent = Math.min(
                      Math.round(((cfg.sent_today || 0) / dailyTarget) * 100),
                      100
                    );

                    return (
                      <div
                        key={instName}
                        data-quarantined={isQuarantined ? "true" : "false"}
                        data-active={cfg.enabled && !isQuarantined ? "true" : "false"}
                        className={styles.chipCard}
                      >
                        {/* Identificação */}
                        <div className={styles.chipCardHeader}>
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className={styles.chipName}>{instName}</h3>
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
                            <p className={styles.chipPhone}>
                              {item.phone_number ? `+${item.phone_number}` : "Número ainda não detectado"}
                            </p>
                          </div>

                          <div className="flex items-center gap-2.5 shrink-0 rounded-lg border border-[#2a352c] bg-[#111a14] px-3 py-1.5">
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

                        <div className={styles.chipCardBody}>
                          {/* Quarentena */}
                          {isQuarantined && (
                            <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 space-y-1">
                              <p className="text-xs font-semibold text-red-300 flex items-center gap-1.5">
                                <ShieldAlert className="w-4 h-4" />
                                Aquecimento pausado por segurança
                              </p>
                              <p className="text-[11px] text-red-200/90 leading-relaxed">
                                {cfg.quarantine_reason || "O sistema detectou erros seguidos e pausou este número por 24 horas."}
                                {cfg.quarantine_until ? ` Volta automaticamente em ${new Date(cfg.quarantine_until).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}.` : ""}
                              </p>
                            </div>
                          )}

                          {/* O que está acontecendo agora */}
                          <div className={styles.progressContainer}>
                            <div className="flex flex-wrap items-baseline justify-between gap-2 text-xs">
                              <span className="text-neutral-300 font-medium">
                                {isQuarantined ? "Pausado por segurança" : !cfg.enabled ? "Aquecimento pausado" : "Mensagens de hoje"}
                              </span>
                              <span className="text-neutral-400 tabular-nums">
                                <strong className="text-white font-semibold">{cfg.sent_today || 0}</strong> de {dailyTarget} enviadas
                              </span>
                            </div>
                            <div
                              className={styles.progressTrack}
                              role="progressbar"
                              aria-valuemin={0}
                              aria-valuemax={100}
                              aria-valuenow={progressPercent}
                              aria-label={`Meta de mensagens de ${instName}`}
                            >
                              <div
                                className={cn(
                                  styles.progressBar,
                                  isQuarantined ? "bg-red-500" : progressPercent >= 100 ? "bg-emerald-400" : stageUI.bar
                                )}
                                style={{ width: `${progressPercent}%` }}
                              />
                            </div>
                            <p className="text-[11px] text-neutral-400">
                              {isQuarantined
                                ? "Nada é enviado até a quarentena terminar."
                                : !cfg.enabled
                                  ? "Ligue o aquecimento para este número voltar a conversar."
                                  : progressPercent >= 100
                                    ? `Meta de hoje concluída · ${cfg.received_today || 0} respostas recebidas.`
                                    : `Faltam ${remainingToday} mensagens hoje · ${cfg.received_today || 0} respostas recebidas.`}
                            </p>
                          </div>

                          {/* Fase */}
                          <div className="space-y-2">
                            <div className="flex flex-wrap items-baseline justify-between gap-2">
                              <span className="text-xs font-medium text-neutral-300">Fase de aquecimento</span>
                              <span className="text-[11px] text-neutral-400">
                                {stageInfo.recommendedDays} · até {stageInfo.dailyTarget} mensagens por dia
                              </span>
                            </div>

                            <div
                              role="group"
                              aria-label={`Fase de aquecimento de ${instName}`}
                              className={styles.stageSegmented}
                            >
                              {([1, 2, 3, 4] as WarmupStage[]).map((st) => {
                                const StIcon = STAGE_UI[st].icon;
                                const isActive = stage === st;
                                return (
                                  <button
                                    key={st}
                                    type="button"
                                    data-stage={st}
                                    onClick={() => handleUpdateConfigField(instName, "stage", st)}
                                    aria-pressed={isActive}
                                    aria-label={`Fase ${st} · ${STAGE_UI[st].name}`}
                                    className={styles.stageButton}
                                  >
                                    <StIcon className="w-3.5 h-3.5 shrink-0" />
                                    <span>{STAGE_UI[st].name}</span>
                                  </button>
                                );
                              })}
                            </div>

                            <p className="text-[11px] text-neutral-400 leading-relaxed">{STAGE_HINT[stage]}</p>
                          </div>

                          {/* Para que serve */}
                          <div className="space-y-1.5">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                              <span className="font-medium text-neutral-300 flex items-center gap-1.5">
                                <Target className="w-3.5 h-3.5 text-emerald-400" />
                                Para que este número vai servir
                              </span>
                              <span className="text-[11px] text-neutral-400">Preparo: {purposeMeta.recommendedDays}</span>
                            </div>

                            <div className={styles.purposeGrid}>
                              {(["contingency", "inbound", "outbound"] as WarmupPurpose[]).map((pKey) => {
                                const meta = PURPOSE_METADATA[pKey];
                                const isSelected = purposeKey === pKey;
                                return (
                                  <button
                                    key={pKey}
                                    type="button"
                                    onClick={() => handleUpdateConfigField(instName, "purpose", pKey)}
                                    aria-pressed={isSelected}
                                    className={cn(styles.purposeOption, isSelected && styles.purposeOptionActive)}
                                  >
                                    <span className={styles.purposeTitle}>{PURPOSE_SHORT[pKey]}</span>
                                    <span className={styles.purposeDesc}>{meta.recommendedDays}</span>
                                  </button>
                                );
                              })}
                            </div>

                            <p className="text-[11px] text-neutral-400 leading-relaxed">{purposeMeta.targetUse}</p>
                          </div>

                          {/* Saúde e contexto */}
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
                            <div className="flex items-center gap-2">
                              <span className="text-neutral-400">Saúde do número:</span>
                              <div className="h-1.5 w-16 rounded-full bg-[#202b23] overflow-hidden">
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
                              className="ml-auto inline-flex items-center gap-1 text-neutral-400 hover:text-emerald-300 transition-colors rounded"
                            >
                              Configurar proxy <ExternalLink className="w-3 h-3" />
                            </a>
                          </div>

                          {/* Ações */}
                          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => openPairModal(instName)}
                                className={cn(styles.secondaryAction, "border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/10")}
                                title="Aquecer em par com outro chip de forma simultânea"
                              >
                                <ArrowRightLeft className="w-3 h-3 text-emerald-400" /> Aquecer em par
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setTestSender(instName);
                                  setTestModalOpen(true);
                                }}
                                className={styles.secondaryAction}
                              >
                                <Send className="w-3 h-3" /> Testar conversa
                              </button>
                            </div>

                            <div className="flex items-center gap-3 w-full sm:w-auto justify-between sm:justify-end">
                              {isDirty && (
                                <span className="text-[11px] text-amber-300">Alterações não salvas</span>
                              )}
                              <button
                                type="button"
                                onClick={() => handleSaveConfig(instName)}
                                disabled={isSaving || !isDirty}
                                className={isDirty ? styles.primaryAction : styles.secondaryAction}
                              >
                                {isSaving ? (
                                  <>
                                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                                    Salvando...
                                  </>
                                ) : isDirty ? (
                                  "Salvar alterações"
                                ) : (
                                  <>
                                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                                    Salvo
                                  </>
                                )}
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* ABA 2: GRUPOS DE AQUECIMENTO DA COLMEIA */}
      {/* ========================================================================= */}
      {activeTab === "groups" && (
        <div className="space-y-6">
          {/* Card de Importação em Lote */}
          <div className={styles.panel}>
            <div className={styles.panelHeader}>
              <div className="flex items-start gap-3">
                <div className="p-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 shrink-0">
                  <Users className="w-5 h-5" />
                </div>
                <div>
                  <h2 className={styles.panelTitle}>Grupos de aquecimento</h2>
                  <p className={styles.panelDescription}>
                    Cole os links dos grupos do WhatsApp, um por linha. Seus números entram aos poucos e reagem às conversas para parecerem pessoas ativas.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSyncGroupMembers}
                  disabled={syncingGroups || groups.length === 0}
                  className={styles.secondaryAction}
                >
                  <RefreshCw className={cn("w-3.5 h-3.5", syncingGroups && "animate-spin")} />
                  {syncingGroups ? "Sincronizando..." : "Colocar números nos grupos"}
                </button>
              </div>
            </div>

            <div className={styles.panelBody}>
              <div className="space-y-3">
                <div className="space-y-1.5">
                  <label htmlFor="group-links-input" className="text-xs font-semibold text-neutral-300">
                    Links dos grupos (um por linha)
                  </label>
                  <textarea
                    id="group-links-input"
                    rows={4}
                    value={importLinksInput}
                    onChange={(e) => setImportLinksInput(e.target.value)}
                    placeholder="https://chat.whatsapp.com/G34A1B2C3D4E5F&#10;https://chat.whatsapp.com/L99Z8Y7X6W5V4U&#10;chat.whatsapp.com/M55P4Q3R2S1T0U"
                    className={cn(
                      styles.fieldInput,
                      "h-auto font-mono text-xs leading-relaxed py-2.5 resize-y"
                    )}
                  />
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-1">
                  <div className="flex items-center gap-2 text-xs text-neutral-400">
                    <Sparkles className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>
                      As reações são escolhidas por regras simples (👍, ❤️, 😂), sem gastar créditos de IA.
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={handleImportGroups}
                    disabled={importingGroups || !importLinksInput.trim()}
                    className={cn(styles.primaryAction, "bg-emerald-400 hover:bg-emerald-300 text-neutral-950 font-semibold")}
                  >
                    {importingGroups ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        Entrando nos grupos...
                      </>
                    ) : (
                      <>
                        <Users className="w-3.5 h-3.5" />
                        Adicionar grupos
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Tabela de Grupos Monitorados */}
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <h3 className="text-base font-semibold text-white flex items-center gap-2">
                <Users className="w-4 h-4 text-blue-400" />
                Grupos cadastrados ({groups.length})
              </h3>
              <span className="text-xs text-neutral-400">
                As mensagens destes grupos não entram no seu atendimento.
              </span>
            </div>

            {groupsLoading ? (
              <div className="p-8 text-center text-xs text-neutral-400">Carregando grupos...</div>
            ) : groups.length === 0 ? (
              <Card className="bg-[#181d19] border-[#303a32] p-8 text-center space-y-3">
                <Users className="w-10 h-10 text-neutral-600 mx-auto" />
                <h4 className="text-base font-medium text-white">Nenhum grupo cadastrado ainda</h4>
                <p className="text-xs text-neutral-400 max-w-md mx-auto leading-relaxed">
                  Adicione links de grupos acima. Seus números entram sozinhos e passam a interagir com as conversas.
                </p>
              </Card>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-[#303a32] bg-[#181d19]">
                <table className={styles.groupsTable}>
                  <thead>
                    <tr>
                      <th>Grupo</th>
                      <th>Código / Link</th>
                      <th>Membros</th>
                      <th>Números no grupo</th>
                      <th>Mensagens lidas</th>
                      <th>Reações</th>
                      <th>Status</th>
                      <th className="text-right">Ação</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => {
                      const membersList = g.members || [];
                      return (
                        <tr key={g.id}>
                          <td className="font-medium text-white max-w-[200px] truncate">
                            {g.name || "Grupo sem título"}
                          </td>
                          <td className="font-mono text-[11px] text-neutral-400 max-w-[140px] truncate">
                            {g.invite_code}
                          </td>
                          <td className="text-neutral-300">
                            {g.member_count > 0 ? `${g.member_count} membros` : "Não detectado"}
                          </td>
                          <td>
                            <div className="flex flex-wrap gap-1 max-w-[180px]">
                              {membersList.length === 0 ? (
                                <span className="text-neutral-500 text-[11px]">Nenhum chip</span>
                              ) : (
                                membersList.map((m: any) => (
                                  <Badge
                                    key={m.instance_name}
                                    variant="outline"
                                    className="text-[10px] border-emerald-500/30 bg-emerald-500/10 text-emerald-300 py-0"
                                  >
                                    {m.instance_name}
                                  </Badge>
                                ))
                              )}
                            </div>
                          </td>
                          <td className="text-neutral-300 tabular-nums font-mono text-[11px]">
                            {g.total_messages_received || 0}
                          </td>
                          <td className="text-neutral-300 tabular-nums font-mono text-[11px]">
                            {g.total_reactions_sent || 0}
                          </td>
                          <td>
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[10px] font-semibold",
                                g.status === "active"
                                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300"
                                  : g.status === "full"
                                  ? "border-amber-500/30 bg-amber-500/10 text-amber-300"
                                  : "border-neutral-500/30 bg-neutral-500/10 text-neutral-300"
                              )}
                            >
                              {g.status === "active" ? "Ativo" : g.status === "full" ? "Lotado" : g.status}
                            </Badge>
                          </td>
                          <td className="text-right">
                            <button
                              type="button"
                              onClick={() => handleDeleteGroup(g.id)}
                              className="text-neutral-500 hover:text-red-400 p-1 rounded transition-colors"
                              title="Remover grupo"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ========================================================================= */}
      {/* ABA 3: ATIVIDADE AO VIVO & LOGS */}
      {/* ========================================================================= */}
      {activeTab === "logs" && (
        <div className={styles.panel}>
          <div className={styles.panelHeader}>
            <div className="flex items-center gap-2.5">
              <span className={`w-2 h-2 rounded-full ${autoRefreshLogs ? "bg-emerald-400 animate-pulse motion-reduce:animate-none" : "bg-neutral-600"}`} />
              <h3 className={styles.panelTitle}>Atividade ao vivo</h3>
              <Badge variant="outline" className="border-white/10 text-neutral-400 text-[11px]">
                {logs.length} interações
              </Badge>
            </div>

            <div className="flex items-center gap-2">
              <label className="text-xs text-neutral-400 flex items-center gap-1.5 cursor-pointer">
                <span>Atualizar sozinho</span>
                <Switch checked={autoRefreshLogs} onCheckedChange={setAutoRefreshLogs} size="sm" aria-label="Atualizar atividade automaticamente" />
              </label>
              <button
                type="button"
                onClick={() => loadData(true)}
                className={styles.secondaryAction}
              >
                <RefreshCw className="w-3 h-3" /> Atualizar
              </button>
            </div>
          </div>

          <div className={styles.panelBody}>
            <div
              ref={logsContainerRef}
              role="log"
              aria-live="polite"
              aria-label="Atividade recente dos chips"
              className={styles.terminalContainer}
            >
              {logs.length === 0 ? (
                <div className="text-center py-8 space-y-2">
                  <Inbox className="w-6 h-6 text-neutral-600 mx-auto" />
                  <p className="text-neutral-400 font-sans">
                    Nada por aqui ainda. Quando dois números conversarem, cada mensagem aparece nesta lista.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      if (instances.length >= 2) {
                        setTestSender(instances[0].instance_name);
                        setTestReceiver(instances[1].instance_name);
                      } else if (instances.length === 1) {
                        setTestSender(instances[0].instance_name);
                      }
                      setTestModalOpen(true);
                    }}
                    disabled={instances.length === 0}
                    className={cn(styles.secondaryAction, "mx-auto font-sans")}
                  >
                    <Send className="w-3 h-3 mr-1.5" /> Ver a primeira conversa
                  </button>
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
                      className={styles.terminalItem}
                    >
                      <span className={styles.terminalTime}>{time}</span>
                      <div className={styles.terminalBadges}>
                        <Badge variant="outline" className={`text-[11px] flex items-center gap-1 ${typeUI.chip}`}>
                          <TypeIcon className="w-3 h-3" />
                          {typeUI.label}
                        </Badge>
                        <span className="flex items-center gap-1.5 text-xs text-neutral-200">
                          <span className="font-medium">{log.sender_instance}</span>
                          <ArrowRight className="w-3 h-3 text-neutral-600 shrink-0" aria-hidden="true" />
                          <span className="font-medium">{log.receiver_instance}</span>
                        </span>
                      </div>

                      <div className={styles.terminalText}>
                        {log.message_text}
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}

          {/* Dialog de Teste Imediato */}
          <Dialog open={testModalOpen} onOpenChange={setTestModalOpen}>
            <DialogContent className={styles.dialog}>
              <div className={styles.dialogHeader}>
                <Flame className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <DialogTitle className="text-lg font-bold text-white">
                    Testar uma conversa
                  </DialogTitle>
                  <DialogDescription className="text-xs text-neutral-400 mt-1">
                    Escolha quem envia e quem recebe. A mensagem sai igual ao aquecimento automático, mas agora.
                  </DialogDescription>
                </div>
              </div>

              <div className={styles.dialogBody}>
                <div className={styles.fieldGroup}>
                  <label htmlFor="test-sender" className={styles.fieldLabel}>
                    Número que envia
                  </label>
                  <select
                    id="test-sender"
                    value={testSender}
                    onChange={(e) => setTestSender(e.target.value)}
                    className={styles.fieldSelect}
                  >
                    <option value="">Selecione o número</option>
                    {instances.map((i) => (
                      <option key={i.instance_name} value={i.instance_name}>
                        {i.instance_name} {i.phone_number ? `(+${i.phone_number})` : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <div className={styles.fieldGroup}>
                  <label htmlFor="test-receiver" className={styles.fieldLabel}>
                    Número que recebe
                  </label>
                  <select
                    id="test-receiver"
                    value={testReceiver}
                    onChange={(e) => setTestReceiver(e.target.value)}
                    className={styles.fieldSelect}
                  >
                    <option value="">Selecione o número</option>
                    {instances.map((i) => (
                      <option key={i.instance_name} value={i.instance_name}>
                        {i.instance_name} {i.phone_number ? ` (+${i.phone_number})` : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center justify-between p-3 rounded-lg border border-[#2a352c] bg-[#141b16]">
                  <div>
                    <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                      <Radio className="w-3.5 h-3.5 text-emerald-400" />
                      Postar um Story também
                    </span>
                    <p className="text-[11px] text-neutral-400">O número que envia publica um status no WhatsApp.</p>
                  </div>
                  <Switch
                    checked={testStatusPost}
                    onCheckedChange={setTestStatusPost}
                    aria-label="Testar postagem de status"
                  />
                </div>

                <div className="p-3.5 rounded-lg bg-emerald-950/20 border border-emerald-500/20 text-neutral-300 text-[11px] space-y-1">
                  <p className="font-semibold text-emerald-300">O que vai acontecer:</p>
                  <p>1. O número que envia fica &quot;digitando...&quot; pelo tempo configurado.</p>
                  <p>2. A mensagem é escrita pelo modelo escolhido ou pelas frases prontas.</p>
                  <p>3. O número que recebe lê e responde, como uma pessoa faria.</p>
                  {testStatusPost && <p>4. Um Story é publicado no Status do número que envia.</p>}
                </div>

                {testBlockedReason && (
                  <p className="text-[11px] text-amber-300 flex items-start gap-1.5">
                    <Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    {testBlockedReason}
                  </p>
                )}

                <div className={styles.dialogActions}>
                  <button
                    type="button"
                    onClick={() => setTestModalOpen(false)}
                    className={styles.secondaryAction}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={handleRunTest}
                    disabled={testLoading || Boolean(testBlockedReason)}
                    className={styles.primaryAction}
                  >
                    {testLoading ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        Executando...
                      </>
                    ) : (
                      "Enviar teste agora"
                    )}
                  </button>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          {/* Modal de Aquecimento Mútuo Automático (Dois Chips Simultâneos) */}
          <Dialog open={mutualModalOpen} onOpenChange={setMutualModalOpen}>
            <DialogContent className={styles.dialog}>
              <div className={styles.dialogHeader}>
                <div className="p-2 rounded-lg bg-emerald-500/15 border border-emerald-500/25 text-emerald-300 shrink-0">
                  <Sparkles className="w-5 h-5" />
                </div>
                <div>
                  <DialogTitle className="text-base font-bold text-white">
                    Aquecer dois chips
                  </DialogTitle>
                  <DialogDescription className="text-xs text-neutral-400 mt-1">
                    Escolha dois números. Eles vão conversar entre si e o sistema cuida do resto.
                  </DialogDescription>
                </div>
              </div>

              <div className={styles.dialogBody}>
                {/* Seletor dos Chips */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className={styles.fieldGroup}>
                    <label htmlFor="pair-chip-a" className={styles.fieldLabel}>
                      Primeiro número
                    </label>
                    <select
                      id="pair-chip-a"
                      value={pairChipA}
                      onChange={(e) => setPairChipA(e.target.value)}
                      className={styles.fieldSelect}
                    >
                      <option value="">Selecione o primeiro número</option>
                      {instances.map((i) => (
                        <option key={i.instance_name} value={i.instance_name}>
                          {i.instance_name} {i.phone_number ? `(+${i.phone_number})` : ""} · {STAGE_UI[i.config?.stage as WarmupStage || 1]?.name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className={styles.fieldGroup}>
                    <label htmlFor="pair-chip-b" className={styles.fieldLabel}>
                      Segundo número
                    </label>
                    <select
                      id="pair-chip-b"
                      value={pairChipB}
                      onChange={(e) => setPairChipB(e.target.value)}
                      className={styles.fieldSelect}
                    >
                      <option value="">Selecione o segundo número</option>
                      {instances.map((i) => (
                        <option key={i.instance_name} value={i.instance_name}>
                          {i.instance_name} {i.phone_number ? `(+${i.phone_number})` : ""} · {STAGE_UI[i.config?.stage as WarmupStage || 1]?.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {/* Diagrama de Conexão Mútua */}
                {pairChipA && pairChipB && pairChipA !== pairChipB && (
                  <div className={styles.pairDiagram}>
                    {/* Node A */}
                    {(() => {
                      const instA = instances.find((i) => i.instance_name === pairChipA);
                      const stA = (instA?.config?.stage || 1) as WarmupStage;
                      const isConnA = instA?.connection_status === "open" || instA?.connection_status === "connected";
                      return (
                        <div className={styles.pairNode}>
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-xs font-semibold text-white truncate">{pairChipA}</span>
                            <span className={`w-2 h-2 rounded-full ${isConnA ? "bg-emerald-400" : "bg-red-400"}`} />
                          </div>
                          <span className="text-[11px] text-neutral-400 truncate">
                            {instA?.phone_number ? `+${instA.phone_number}` : "Sem telefone"}
                          </span>
                          <span className={`text-[10px] font-medium mt-1 ${STAGE_UI[stA]?.text}`}>
                            Fase {stA} · {STAGE_UI[stA]?.name}
                          </span>
                        </div>
                      );
                    })()}

                    {/* Conector Central */}
                    <div className={styles.pairConnector}>
                      <div className="p-2 rounded-full bg-emerald-500/10 border border-emerald-500/25 text-emerald-300">
                        <ArrowRightLeft className="w-4 h-4" />
                      </div>
                      <span className="text-[10px] font-semibold text-emerald-400 uppercase tracking-wider text-center">
                        Conversa nos dois sentidos
                      </span>
                    </div>

                    {/* Node B */}
                    {(() => {
                      const instB = instances.find((i) => i.instance_name === pairChipB);
                      const stB = (instB?.config?.stage || 1) as WarmupStage;
                      const isConnB = instB?.connection_status === "open" || instB?.connection_status === "connected";
                      return (
                        <div className={styles.pairNode}>
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-xs font-semibold text-white truncate">{pairChipB}</span>
                            <span className={`w-2 h-2 rounded-full ${isConnB ? "bg-emerald-400" : "bg-red-400"}`} />
                          </div>
                          <span className="text-[11px] text-neutral-400 truncate">
                            {instB?.phone_number ? `+${instB.phone_number}` : "Sem telefone"}
                          </span>
                          <span className={`text-[10px] font-medium mt-1 ${STAGE_UI[stB]?.text}`}>
                            Fase {stB} · {STAGE_UI[stB]?.name}
                          </span>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* Lista de Recursos Ativados */}
                <div className="space-y-2">
                  <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    O que acontece sozinho neste par:
                  </span>
                  <div className={styles.pairFeaturesList}>
                    <div className={styles.pairFeatureItem}>
                      <Contact className={styles.pairFeatureIcon} />
                      <span>Salvam o contato um do outro</span>
                    </div>
                    <div className={styles.pairFeatureItem}>
                      <Volume2 className={styles.pairFeatureIcon} />
                      <span>Mandam áudios curtos de voz</span>
                    </div>
                    <div className={styles.pairFeatureItem}>
                      <CheckCheck className={styles.pairFeatureIcon} />
                      <span>Leem e respondem com atraso humano</span>
                    </div>
                    <div className={styles.pairFeatureItem}>
                      <Eye className={styles.pairFeatureIcon} />
                      <span>Ficam &quot;digitando...&quot; antes de enviar</span>
                    </div>
                    <div className={styles.pairFeatureItem}>
                      <Activity className={styles.pairFeatureIcon} />
                      <span>Sobem de fase automaticamente</span>
                    </div>
                    <div className={styles.pairFeatureItem}>
                      <ShieldAlert className={styles.pairFeatureIcon} />
                      <span>Pausam sozinhos se algo falhar</span>
                    </div>
                  </div>
                </div>

                {/* Opções extras */}
                <div className="flex items-center justify-between p-3 rounded-lg border border-[#2a352c] bg-[#141b16]">
                  <div>
                    <span className="text-xs font-semibold text-white flex items-center gap-1.5">
                      <Radio className="w-3.5 h-3.5 text-emerald-400" />
                      Postar Stories no Status
                    </span>
                    <p className="text-[11px] text-neutral-400">
                      Os dois números publicam status para parecerem ativos no dia a dia.
                    </p>
                  </div>
                  <Switch
                    checked={mutualStatusPost}
                    onCheckedChange={setMutualStatusPost}
                    aria-label="Ativar postagem de status"
                  />
                </div>

                {/* Validação de Bloqueio */}
                {instances.length < 2 ? (
                  <p className="text-[11px] text-amber-300 flex items-start gap-1.5 p-2 rounded bg-amber-500/10 border border-amber-500/20">
                    <Info className="w-4 h-4 shrink-0 mt-0.5" />
                    Conecte dois números na área WhatsApp para aquecer em par.
                  </p>
                ) : pairChipA === pairChipB && pairChipA ? (
                  <p className="text-[11px] text-amber-300 flex items-start gap-1.5 p-2 rounded bg-amber-500/10 border border-amber-500/20">
                    <Info className="w-4 h-4 shrink-0 mt-0.5" />
                    Escolha dois números diferentes.
                  </p>
                ) : null}

                {/* Ações do Modal */}
                <div className="pt-2 flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-end border-t border-[#2a352c]">
                  <button
                    type="button"
                    onClick={() => setMutualModalOpen(false)}
                    className={styles.secondaryAction}
                  >
                    Fechar
                  </button>

                  <button
                    type="button"
                    onClick={handleRunMutualWarmup}
                    disabled={mutualLoading || autopilotLoading || !pairChipA || !pairChipB || pairChipA === pairChipB}
                    className={styles.secondaryAction}
                    title="Dispara uma troca imediata nos dois sentidos para ver o resultado"
                  >
                    {mutualLoading ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        Aquecendo agora...
                      </>
                    ) : (
                      <>
                        <Send className="w-3.5 h-3.5 text-emerald-400" />
                        Aquecer agora, uma vez
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={handleEnablePairAutopilot}
                    disabled={mutualLoading || autopilotLoading || !pairChipA || !pairChipB || pairChipA === pairChipB}
                    className={cn(styles.primaryAction, "bg-emerald-400 hover:bg-emerald-300 text-neutral-950 font-semibold")}
                    title="Configura tudo e deixa os dois chips se aquecendo sozinhos em segundo plano"
                  >
                    {autopilotLoading ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        Ativando...
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-3.5 h-3.5 text-neutral-950" />
                        Deixar aquecendo sozinho (24/7)
                      </>
                    )}
                  </button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </div>
    </div>
  );
}
