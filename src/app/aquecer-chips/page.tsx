"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  ArrowRightLeft,
  Bot,
  CheckCircle2,
  ChevronDown,
  Clock,
  Contact,
  Download,
  Eye,
  Flame,
  ImageIcon,
  Inbox,
  Info,
  MessageSquare,
  MoreHorizontal,
  Pause,
  Play,
  QrCode,
  Radio,
  RefreshCw,
  Send,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Smile,
  Sparkles,
  Trash2,
  Users,
  Volume2,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Header } from "@/components/layout/header";
import { ModelOptions } from "@/components/ai-module-shared";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ChipAutopilotRow } from "@/components/warmup/chip-autopilot-row";
import { MmzapLiveMonitor } from "@/components/warmup/mmzap-live-monitor";
import { MmzapPairModal } from "@/components/warmup/mmzap-pair-modal";
import type { MmzapWorkerHealth } from "@/lib/warmup/mmzap-browser-client";
import {
  computeFleetColdReadiness,
  hasChipDatacenterWarning,
  isChipMmzapNeedsPairing,
  isChipMmzapQrRequired,
  toMmzapSessionView,
  type ExternalDiagnostic,
  type GlobalSettings,
  type InstanceItem,
  type MmzapWorkerSessionView,
  type SelfHealingActionRecord,
  type WarmupStats,
} from "@/components/warmup/types";
import type { GroupableModel } from "@/lib/model-grouping";
import { useClientSession } from "@/lib/use-session";
import { cn } from "@/lib/utils";
import { WARMUP_THEMES } from "@/lib/warmup/warmup-dialogues";
import {
  DEFAULT_MMZAP_GOVERNOR_SETTINGS,
  STAGE_DEFAULTS,
  type ExternalWarmupMode,
  type MmzapGovernorSettings,
  type WarmupConfig,
  type WarmupLog,
  type WarmupStage,
} from "@/lib/warmup/warmup-types";
import styles from "./aquecer-chips.module.css";

interface WarmupGroupRow {
  id: string;
  name?: string | null;
  invite_code: string;
  member_count: number;
  total_messages_received?: number;
  total_reactions_sent?: number;
  status: string;
  is_dead?: boolean;
  members?: Array<{ instance_name: string }>;
}

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
  auto_warmup_new_chips: true,
  custom_prompt: "",
  daily_owner_summary_enabled: false,
  daily_owner_summary_phone: "",
  default_profile_avatar_urls: "",
};

const STAGE_UI: Record<WarmupStage, { name: string; text: string }> = {
  1: { name: "Frio", text: "text-sky-300" },
  2: { name: "Morno", text: "text-amber-300" },
  3: { name: "Quente", text: "text-orange-300" },
  4: { name: "Blindado", text: "text-emerald-300" },
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

const PROTECTIONS: Array<{
  key: keyof GlobalSettings;
  title: string;
  description: string;
}> = [
  {
    key: "enable_vcard",
    title: "Troca de contatos (vCard)",
    description: "Cada chip salva o outro na agenda automaticamente.",
  },
  {
    key: "enable_audio",
    title: "Áudio gravado na hora",
    description: "Envia mensagens de voz curtas para variar interações.",
  },
  {
    key: "enable_status_posts",
    title: "Status / Stories",
    description: "Publica atualizações periódicas no Status do WhatsApp.",
  },
  {
    key: "enable_blue_ticks",
    title: "Confirmação de leitura",
    description: "Marca mensagens recebidas como lidas com atraso humano.",
  },
  {
    key: "enable_reactions",
    title: "Reações em mensagens",
    description: "Reage casualmente às mensagens do parceiro.",
  },
  {
    key: "stage_auto_progress",
    title: "Evolução automática de fase",
    description: "Avança de fase sozinho conforme acumula dias sem erro.",
  },
  {
    key: "auto_warmup_new_chips",
    title: "Incluir chip ADM novo sozinho",
    description: "Todo chip ADM conectado entra na colmeia com escudo MMZap ativo.",
  },
];

function formatHour(hour: number): string {
  return `${String(hour).padStart(2, "0")}h`;
}

export default function AquecerChipsPage() {
  const { session, loading: sessionLoading } = useClientSession();
  const isAdmin = Boolean(session?.isAdmin && !session?.impersonating);

  const [instances, setInstances] = useState<InstanceItem[]>([]);
  const [savedConfigs, setSavedConfigs] = useState<Record<string, WarmupConfig>>({});
  const [logs, setLogs] = useState<WarmupLog[]>([]);
  const [diagnostics, setDiagnostics] = useState<ExternalDiagnostic[]>([]);
  const [selfHealingLog, setSelfHealingLog] = useState<SelfHealingActionRecord[]>([]);
  const [stats, setStats] = useState<WarmupStats>({
    totalChips: 0,
    activeWarmup: 0,
    totalSentToday: 0,
    totalReceivedToday: 0,
    mmzapInboundToday: 0,
  });

  const [globalSettings, setGlobalSettings] = useState<GlobalSettings>(DEFAULT_GLOBAL_SETTINGS);
  const [savedGlobalSettings, setSavedGlobalSettings] = useState<GlobalSettings>(DEFAULT_GLOBAL_SETTINGS);
  const [applyGlobalToAll, setApplyGlobalToAll] = useState(false);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingMap, setSavingMap] = useState<Record<string, boolean>>({});
  const [reauditLoadingMap, setReauditLoadingMap] = useState<Record<string, boolean>>({});
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selfHealingBusy, setSelfHealingBusy] = useState(false);

  const [aiModels, setAiModels] = useState<GroupableModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);

  const [activeTab, setActiveTab] = useState<"chips" | "autonomy" | "groups" | "logs">("chips");
  const [groups, setGroups] = useState<WarmupGroupRow[]>([]);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [importLinksInput, setImportLinksInput] = useState("");
  const [importingGroups, setImportingGroups] = useState(false);
  const [syncingGroups, setSyncingGroups] = useState(false);
  const [groupBulkActionBusy, setGroupBulkActionBusy] = useState(false);

  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [globalModalOpen, setGlobalModalOpen] = useState(false);
  const [autoRefreshLogs, setAutoRefreshLogs] = useState(false);
  const logsContainerRef = useRef<HTMLDivElement>(null);

  // Modais de Teste Manual e Aquecimento em Par
  const [testModalOpen, setTestModalOpen] = useState(false);
  const [testSender, setTestSender] = useState("");
  const [testReceiver, setTestReceiver] = useState("");
  const [testStatusPost, setTestStatusPost] = useState(false);
  const [testLoading, setTestLoading] = useState(false);

  const [mutualModalOpen, setMutualModalOpen] = useState(false);
  const [pairChipA, setPairChipA] = useState("");
  const [pairChipB, setPairChipB] = useState("");
  const [mutualStatusPost, setMutualStatusPost] = useState(true);
  const [mutualLoading, setMutualLoading] = useState(false);
  const [autopilotLoading, setAutopilotLoading] = useState(false);

  const [mmzapWorkerHealth, setMmzapWorkerHealth] = useState<MmzapWorkerHealth | null>(null);
  const [mmzapGovernor, setMmzapGovernor] = useState<MmzapGovernorSettings>(
    DEFAULT_MMZAP_GOVERNOR_SETTINGS
  );
  const [mmzapModalOpen, setMmzapModalOpen] = useState(false);
  const [mmzapModalInstance, setMmzapModalInstance] = useState<string | null>(null);
  const [mmzapModalMode, setMmzapModalMode] = useState<"pair" | "setup">("pair");

  const [hotswapModalOpen, setHotswapModalOpen] = useState(false);
  const [hotswapOldChip, setHotswapOldChip] = useState("");
  const [hotswapNewChip, setHotswapNewChip] = useState("");
  const [hotswapBusy, setHotswapBusy] = useState(false);

  const loadMmzapWorkerState = useCallback(async () => {
    try {
      const res = await fetch("/api/warmup/mmzap-browser", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json().catch(() => null)) as {
        success?: boolean;
        data?: {
          worker?: MmzapWorkerHealth;
          governor?: MmzapGovernorSettings;
        };
      } | null;
      if (json?.success && json.data) {
        if (json.data.worker) setMmzapWorkerHealth(json.data.worker);
        if (json.data.governor) setMmzapGovernor(json.data.governor);
      }
    } catch {
      /* silencioso */
    }
  }, []);

  const loadDiagnostics = useCallback(async () => {
    try {
      const res = await fetch("/api/warmup/external-shield?limit=40", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.ok) {
        if (Array.isArray(data.diagnostics)) setDiagnostics(data.diagnostics);
        if (Array.isArray(data.self_healing_log)) setSelfHealingLog(data.self_healing_log);
      }
    } catch {
      /* silencioso */
    }
  }, []);

  const loadData = useCallback(async (isSilent = false) => {
    if (!isSilent) setRefreshing(true);
    try {
      const res = await fetch("/api/warmup", { cache: "no-store" });
      if (res.status === 403) {
        setInstances([]);
        return;
      }
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
        if (Array.isArray(data.data.self_healing_log)) {
          setSelfHealingLog(data.data.self_healing_log);
        }
        if (data.data.global_settings) {
          const nextGlobal: GlobalSettings = {
            ...DEFAULT_GLOBAL_SETTINGS,
            ...data.data.global_settings,
          };
          setGlobalSettings(nextGlobal);
          setSavedGlobalSettings(nextGlobal);
        }
        if (data.data.stats) setStats(data.data.stats);
      }
    } catch {
      toast.error("Falha ao carregar dados do aquecedor de chips.");
    } finally {
      setLoading(false);
      if (!isSilent) setRefreshing(false);
    }
  }, []);

  const loadModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const res = await fetch("/api/ai-models", { cache: "no-store" });
      const data = await res.json();
      if (data?.success && Array.isArray(data.models)) {
        setAiModels(data.models);
      }
    } catch {
      /* silencioso */
    } finally {
      setModelsLoading(false);
    }
  }, []);

  const loadGroups = useCallback(async () => {
    setGroupsLoading(true);
    try {
      const res = await fetch("/api/warmup/groups", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && Array.isArray(data.groups)) {
        setGroups(data.groups);
      }
    } catch {
      /* silencioso */
    } finally {
      setGroupsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (sessionLoading) return;
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    void Promise.all([
      loadData(),
      loadDiagnostics(),
      loadModels(),
      loadGroups(),
      loadMmzapWorkerState(),
    ]);
  }, [sessionLoading, isAdmin, loadData, loadDiagnostics, loadModels, loadGroups, loadMmzapWorkerState]);

  useEffect(() => {
    if (!autoRefreshLogs || !isAdmin) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch("/api/warmup/logs?limit=30");
        const data = await res.json();
        if (data.success && Array.isArray(data.logs)) setLogs(data.logs);
      } catch {
        /* silencioso */
      }
    }, 8000);
    return () => clearInterval(interval);
  }, [autoRefreshLogs, isAdmin]);

  const handleRefreshAll = useCallback(async () => {
    await Promise.all([loadData(true), loadDiagnostics(), loadGroups(), loadMmzapWorkerState()]);
  }, [loadData, loadDiagnostics, loadGroups, loadMmzapWorkerState]);

  const handleOpenMmzapPairModal = (instanceName: string, mode: "pair" | "setup" = "pair") => {
    setMmzapModalInstance(instanceName);
    setMmzapModalMode(mode);
    setMmzapModalOpen(true);
  };

  const handleMmzapBrowserAction = async (
    instanceName: string,
    action: "start_shift" | "stop_shift" | "toggle_enabled" | "reset_profile" | "logout",
    extra?: Record<string, unknown>
  ) => {
    const res = await fetch("/api/warmup/mmzap-browser", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, instance_name: instanceName, ...extra }),
    });
    const json = (await res.json().catch(() => null)) as {
      success?: boolean;
      error?: string;
    } | null;
    if (!res.ok || !json?.success) {
      toast.error(json?.error || "Falha ao acionar navegador MMZap.");
      await handleRefreshAll();
      return;
    }
    if (action === "logout" || action === "reset_profile") {
      toast.success(`Sessão MMZap de ${instanceName} desconectada e perfil apagado.`);
    } else {
      toast.success("Estado MMZap atualizado.");
    }
    await handleRefreshAll();
  };

  const handleReleaseQuarantine = async (instanceName: string) => {
    const res = await fetch("/api/warmup/mmzap-browser", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "release_quarantine", instance_name: instanceName }),
    });
    const json = (await res.json().catch(() => null)) as {
      success?: boolean;
      error?: string;
    } | null;
    if (!res.ok || !json?.success) {
      toast.error(json?.error || "Falha ao liberar quarentena.");
      return;
    }
    toast.success(`Quarentena liberada para ${instanceName}.`);
    await handleRefreshAll();
  };

  const handleRunSelfHealing = async () => {
    setSelfHealingBusy(true);
    try {
      const res = await fetch("/api/warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "run_self_healing" }),
      });
      const data = await res.json();
      if (data.success) {
        const fixed = data.report?.fixedCount || 0;
        const attention = data.report?.needsAttentionCount || 0;
        toast.success(
          fixed > 0 || attention > 0
            ? `Auto-cura concluída: ${fixed} corrigido(s) · ${attention} pendente(s).`
            : "Verificação concluída: todos os chips ADM estão saudáveis."
        );
        await handleRefreshAll();
      } else {
        toast.error(data.error || "Falha ao executar auto-cura.");
      }
    } catch {
      toast.error("Erro ao acionar auto-cura.");
    } finally {
      setSelfHealingBusy(false);
    }
  };

  const handleToggleChipEnabled = async (instanceName: string, nextEnabled: boolean) => {
    const prevInstances = instances;
    setInstances((prev) =>
      prev.map((item) =>
        item.instance_name === instanceName
          ? { ...item, config: { ...item.config, enabled: nextEnabled } }
          : item
      )
    );
    try {
      const res = await fetch("/api/warmup", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance_name: instanceName, enabled: nextEnabled }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(
          nextEnabled
            ? `${instanceName} ativado no aquecimento.`
            : `${instanceName} pausado.`
        );
        await loadData(true);
      } else {
        setInstances(prevInstances);
        toast.error(data.error || "Não foi possível alterar o status.");
      }
    } catch {
      setInstances(prevInstances);
      toast.error("Erro ao atualizar status do chip.");
    }
  };

  const handleUpdateConfigField = (
    instanceName: string,
    field: keyof WarmupConfig,
    value: WarmupConfig[keyof WarmupConfig]
  ) => {
    setInstances((prev) =>
      prev.map((item) => {
        if (item.instance_name !== instanceName) return item;
        const nextCfg: WarmupConfig = { ...item.config, [field]: value };
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
        toast.success(`Ajustes de ${instanceName} salvos.`);
        setSavedConfigs((prev) => ({ ...prev, [instanceName]: target.config }));
      } else {
        toast.error(`Falha ao salvar: ${data.error}`);
      }
    } catch {
      toast.error("Erro ao salvar ajustes do chip.");
    } finally {
      setSavingMap((prev) => ({ ...prev, [instanceName]: false }));
    }
  };

  const handleChangeMmzapMode = async (
    instanceName: string,
    mode: ExternalWarmupMode
  ) => {
    const res = await fetch("/api/warmup/external-shield", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "set_mode",
        instance_name: instanceName,
        mode,
      }),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || !json?.ok) {
      toast.error(json?.error || "Falha ao alterar modo MMZap.");
      return;
    }
    toast.success(`Modo MMZap de ${instanceName} atualizado.`);
    await Promise.all([loadData(true), loadDiagnostics()]);
  };

  const handleReauditDay0 = async (instanceName: string) => {
    setReauditLoadingMap((prev) => ({ ...prev, [instanceName]: true }));
    try {
      const res = await fetch("/api/warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reaudit_day0", instance_name: instanceName }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.ok) {
          toast.success(`Auditoria OK em ${instanceName}.`);
        } else {
          toast.warning(`Ainda há pendências na auditoria de ${instanceName}.`);
        }
        await loadData(true);
      } else {
        toast.error(data.error || "Falha ao reauditar.");
      }
    } finally {
      setReauditLoadingMap((prev) => ({ ...prev, [instanceName]: false }));
    }
  };

  const handleToggleBulk = async (action: "enable_all" | "pause_all") => {
    setBulkBusy(true);
    try {
      const res = await fetch("/api/warmup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(
          action === "enable_all"
            ? "Todos os chips ADM ativados."
            : "Aquecimento pausado nos chips ADM."
        );
        await loadData(true);
      } else {
        toast.error(data.error || "Falha na ação em lote.");
      }
    } finally {
      setBulkBusy(false);
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
          applyToAll: applyGlobalToAll,
          ...globalSettings,
        }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success("Ajustes gerais atualizados.");
        setSavedGlobalSettings(globalSettings);
        setApplyGlobalToAll(false);
        setGlobalModalOpen(false);
        await loadData(true);
      } else {
        toast.error(`Falha ao salvar: ${data.error}`);
      }
    } finally {
      setSavingGlobal(false);
    }
  };

  const handleGroupAction = async (
    action: "discover_existing" | "create_internal_swarm" | "cleanup_dead"
  ) => {
    setGroupBulkActionBusy(true);
    try {
      const res = await fetch("/api/warmup/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.success) {
        toast.error(json?.error || "Falha na ação de grupos.");
        return;
      }
      toast.success(json.message || "Grupos atualizados.");
      await loadGroups();
    } finally {
      setGroupBulkActionBusy(false);
    }
  };

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
        toast.success(data.message || `${data.added} grupo(s) adicionados.`);
        setImportLinksInput("");
        await Promise.all([loadGroups(), loadData(true)]);
      } else {
        toast.error(data.error || "Falha ao importar grupos.");
      }
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
        toast.success(data.message || "Chips sincronizados nos grupos.");
        await loadGroups();
      } else {
        toast.error(data.error || "Falha na sincronização.");
      }
    } finally {
      setSyncingGroups(false);
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    const res = await fetch(`/api/warmup/groups?id=${groupId}`, { method: "DELETE" });
    const data = await res.json();
    if (data.success) {
      toast.success("Grupo removido.");
      setGroups((prev) => prev.filter((g) => g.id !== groupId));
    } else {
      toast.error(data.error || "Falha ao remover grupo.");
    }
  };

  const openPairModal = (chipA?: string) => {
    if (chipA) {
      setPairChipA(chipA);
      const other = instances.find((i) => i.instance_name !== chipA);
      if (other) setPairChipB(other.instance_name);
    } else if (instances.length >= 2) {
      setPairChipA(instances[0].instance_name);
      setPairChipB(instances[1].instance_name);
    } else if (instances.length === 1) {
      setPairChipA(instances[0].instance_name);
    }
    setMutualModalOpen(true);
  };

  const openTestModal = (chipA?: string) => {
    if (chipA) setTestSender(chipA);
    else if (instances.length > 0) setTestSender(instances[0].instance_name);
    const other = instances.find((i) => i.instance_name !== (chipA || instances[0]?.instance_name));
    if (other) setTestReceiver(other.instance_name);
    setTestModalOpen(true);
  };

  const openHotswapModal = (oldInst: string) => {
    setHotswapOldChip(oldInst);
    const cand = instances.find(
      (i) =>
        !i.orphan &&
        i.instance_name !== oldInst &&
        (i.connection_status === "open" || i.connection_status === "connected") &&
        !i.config?.is_quarantined
    );
    setHotswapNewChip(cand?.instance_name || "");
    setHotswapModalOpen(true);
  };

  const handleConfirmHotswap = async () => {
    if (!hotswapOldChip || !hotswapNewChip || hotswapOldChip === hotswapNewChip) {
      toast.error("Escolha um chip substituto conectado diferente.");
      return;
    }
    setHotswapBusy(true);
    try {
      const res = await fetch("/api/whatsapp/hotswap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          old_instance_name: hotswapOldChip,
          new_instance_name: hotswapNewChip,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        toast.error(json?.error || "Falha ao executar Hotswap.");
        return;
      }
      toast.success(
        `Hotswap concluído: ${json.movedCampaigns || 0} campanha(s), ${json.movedFollowups || 0} follow-up(s) e ${json.movedLeads || 0} lead(s) migrados para ${hotswapNewChip}.`
      );
      setHotswapModalOpen(false);
      await loadData(true);
    } finally {
      setHotswapBusy(false);
    }
  };

  const handleRunTest = async () => {
    if (!testSender || !testReceiver || testSender === testReceiver) {
      toast.error("Escolha dois chips diferentes.");
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
        toast.success(data.message || "Troca executada.");
        setTestModalOpen(false);
        await loadData(true);
      } else {
        toast.error(data.error || "Falha ao executar teste.");
      }
    } finally {
      setTestLoading(false);
    }
  };

  const handleRunMutualWarmup = async () => {
    if (!pairChipA || !pairChipB || pairChipA === pairChipB) return;
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
        toast.success(data.message || "Troca mútua executada.");
        await loadData(true);
      } else {
        toast.error(data.error || "Falha ao aquecer par.");
      }
    } finally {
      setMutualLoading(false);
    }
  };

  const handleEnablePairAutopilot = async () => {
    if (!pairChipA || !pairChipB || pairChipA === pairChipB) return;
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
        toast.success(data.message || "Piloto automático ativado para o par.");
        setMutualModalOpen(false);
        await loadData(true);
      } else {
        toast.error(data.error || "Falha ao ativar piloto.");
      }
    } finally {
      setAutopilotLoading(false);
    }
  };

  if (!sessionLoading && !isAdmin) {
    return (
      <div className={cn("h-[100dvh] max-h-[100dvh] flex flex-col overflow-hidden", styles.page)}>
        <Header />
        <main className={styles.content}>
          <div className="max-w-2xl mx-auto mt-12 border border-[#303a32] rounded-xl bg-[#181d19] p-6 space-y-3">
            <h1 className="text-xl font-semibold text-[#edf2ee]">
              Aquecedor de Chips restrito ao Administrador
            </h1>
            <p className="text-sm text-[#a5b1a8] leading-relaxed">
              Por segurança, somente números vinculados à conta Administradora principal (fora do modo de personificação) participam do aquecimento automático e do escudo MMZap. Números de clientes não são incluídos.
            </p>
            <div className="pt-2">
              <a href="/whatsapp" className={styles.secondaryAction}>
                Ir para conexões WhatsApp
              </a>
            </div>
          </div>
        </main>
      </div>
    );
  }

  const connectedCount = instances.filter(
    (i) => i.connection_status === "open" || i.connection_status === "connected"
  ).length;
  const quarantinedCount = instances.filter((i) => i.config?.is_quarantined).length;
  const activeChipCount = instances.filter(
    (i) => i.config?.enabled && !i.config?.is_quarantined
  ).length;
  const workerSessions: MmzapWorkerSessionView[] = (mmzapWorkerHealth?.sessions || [])
    .map((s) => toMmzapSessionView(s))
    .filter((s): s is MmzapWorkerSessionView => s !== null);
  const fleetReadiness = computeFleetColdReadiness(instances);
  const readyCount = fleetReadiness.readyChipsCount;
  const capacityProgressPct = Math.min(
    100,
    Math.round((fleetReadiness.totalSafeDailyCold / fleetReadiness.benchmarkMax) * 100)
  );
  const mmzapOnboardingChips = mmzapWorkerHealth?.configured
    ? instances.filter((item) => {
        const sess =
          workerSessions.find((s) => s.instanceName === item.instance_name) ?? null;
        return isChipMmzapNeedsPairing(item, sess);
      })
    : [];
  const mmzapLoggedOutChips = mmzapOnboardingChips.filter((item) => {
    const sess =
      workerSessions.find((s) => s.instanceName === item.instance_name) ?? null;
    return isChipMmzapQrRequired(item.config, sess);
  });
  const mmzapWatchdogRecoveries = workerSessions.reduce(
    (acc, s) => acc + Number(s.mmzapWatchdogRecoveries || 0),
    0
  );
  const datacenterWarningChips = instances.filter(
    (item) => !item.orphan && hasChipDatacenterWarning(item)
  );
  const mmzapModalWorkerSession = mmzapModalInstance
    ? workerSessions.find((s) => s.instanceName === mmzapModalInstance) ?? null
    : null;
  const mmzapModalChipStatus = mmzapModalInstance
    ? instances.find((i) => i.instance_name === mmzapModalInstance)?.config?.mmzap_browser_status ??
      null
    : null;
  const mmzapInboundToday =
    stats.mmzapInboundToday ??
    instances.reduce((acc, i) => acc + (i.config?.external_warmup_inbound_today || 0), 0);
  const mmzapSentToday =
    stats.mmzapSentToday ??
    instances.reduce((acc, i) => acc + (i.config?.external_mmzap_sent_today || 0), 0);
  const totalDailyTarget = instances.reduce((acc, i) => acc + (i.config?.daily_target || 0), 0);
  const fixedSelfHealCount = selfHealingLog.filter((a) => a.status === "fixed").length;
  const attentionSelfHealCount = selfHealingLog.filter((a) => a.status === "needs_attention").length;
  const hasActiveChips = activeChipCount > 0;
  const disconnectedChips = instances.filter(
    (i) => i.connection_status !== "open" && i.connection_status !== "connected"
  );
  const testBlockedReason =
    instances.length < 2
      ? "Conecte pelo menos dois chips ADM para testar uma conversa."
      : testSender === testReceiver
        ? "Escolha chips diferentes."
        : null;
  const globalDirty = JSON.stringify(globalSettings) !== JSON.stringify(savedGlobalSettings);
  const selectedThemeLabel =
    WARMUP_THEMES.find((t) => t.id === globalSettings.ai_theme)?.label || globalSettings.ai_theme;

  return (
    <div className={cn("h-[100dvh] max-h-[100dvh] flex flex-col overflow-hidden", styles.page)}>
      <Header />

      <main className={styles.content}>
        <div className="max-w-7xl mx-auto pb-16">
          {/* Cabeçalho limpo sem eyebrow */}
          <div className={styles.heading}>
            <div className={styles.statusBlock}>
              <h1 className="text-2xl font-semibold tracking-tight text-[#edf2ee]">
                Aquecedor de Chips
              </h1>
              <p className={styles.headingDescription}>
                Somente números ADM · auto-cura contínua, escudo MMZap ativo e janela {formatHour(globalSettings.allowed_start_hour)}–{formatHour(globalSettings.allowed_end_hour)} ({selectedThemeLabel}).
              </p>
            </div>

            <div className={styles.headingActions}>
              <button
                type="button"
                onClick={() =>
                  void handleToggleBulk(hasActiveChips ? "pause_all" : "enable_all")
                }
                disabled={bulkBusy || instances.length === 0}
                className={styles.primaryAction}
              >
                {hasActiveChips ? (
                  <Pause className="w-4 h-4" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
                {bulkBusy
                  ? "Aplicando..."
                  : hasActiveChips
                    ? "Pausar todos"
                    : "Ativar todos"}
              </button>

              <button
                type="button"
                onClick={() => void handleRunSelfHealing()}
                disabled={selfHealingBusy}
                className={styles.secondaryAction}
              >
                <Wrench
                  className={cn("w-4 h-4 text-emerald-400", selfHealingBusy && "animate-spin")}
                />
                {selfHealingBusy ? "Verificando..." : "Auto-curar agora"}
              </button>

              <div className={styles.moreMenu}>
                <button
                  type="button"
                  onClick={() => setMoreMenuOpen((v) => !v)}
                  aria-expanded={moreMenuOpen}
                  aria-haspopup="menu"
                  className={styles.secondaryAction}
                >
                  <MoreHorizontal className="w-4 h-4" />
                  Mais ações
                  <ChevronDown
                    className={cn("w-3.5 h-3.5 transition-transform", moreMenuOpen && "rotate-180")}
                  />
                </button>

                {moreMenuOpen && (
                  <div role="menu" className={styles.moreDropdown}>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={instances.length < 2}
                      onClick={() => {
                        setMoreMenuOpen(false);
                        openPairModal();
                      }}
                      className={styles.moreMenuItem}
                    >
                      <ArrowRightLeft className="w-4 h-4 text-emerald-400" />
                      Aquecer dois chips em par
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      disabled={instances.length < 2}
                      onClick={() => {
                        setMoreMenuOpen(false);
                        openTestModal();
                      }}
                      className={styles.moreMenuItem}
                    >
                      <Send className="w-4 h-4 text-emerald-400" />
                      Testar conversa agora
                    </button>
                    <a
                      role="menuitem"
                      href="/api/warmup/vcf"
                      download="agenda-chips-adm.vcf"
                      onClick={() => setMoreMenuOpen(false)}
                      className={styles.moreMenuItem}
                    >
                      <Download className="w-4 h-4 text-emerald-400" />
                      Baixar agenda (.vcf)
                    </a>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMoreMenuOpen(false);
                        setGlobalModalOpen(true);
                      }}
                      className={styles.moreMenuItem}
                    >
                      <Settings2 className="w-4 h-4 text-emerald-400" />
                      Ajustes gerais do motor
                    </button>
                  </div>
                )}
              </div>

              <button
                type="button"
                onClick={() => void handleRefreshAll()}
                disabled={refreshing || groupsLoading}
                className={styles.iconAction}
                aria-label="Atualizar dados do aquecedor"
                title="Atualizar"
              >
                <RefreshCw className={cn("w-4 h-4", refreshing && "animate-spin")} />
              </button>
            </div>
          </div>

          {/* Alerta condicional apenas quando exige ação humana */}
          {disconnectedChips.length > 0 && (
            <div
              role="alert"
              className="mb-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-xs text-amber-100"
            >
              <div className="flex items-start gap-2.5">
                <ShieldAlert className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
                <p>
                  <strong>{disconnectedChips.map((c) => c.instance_name).join(", ")}</strong>{" "}
                  aguardando conexão WhatsApp. Escaneie o QR Code para a auto-cura religar webhook, escudo MMZap e aquecimento sozinha.
                </p>
              </div>
              <a
                href="/whatsapp"
                className="inline-flex items-center justify-center rounded-lg border border-amber-400/40 bg-[#1a1811] px-3 py-1.5 font-medium text-amber-200 hover:bg-amber-500/20 shrink-0"
              >
                Conectar QR Code
              </a>
            </div>
          )}

          {/* Banner 2-em-1 de Onboarding MMZap (pareamento inicial ou re-scan após logout) */}
          {mmzapOnboardingChips.length > 0 && (
            <section
              aria-label="Pareamento MMZap pendente"
              className={cn(
                "mb-5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-xl border px-4 py-3 text-xs",
                mmzapLoggedOutChips.length > 0
                  ? "border-amber-500/40 bg-amber-500/10 text-amber-100"
                  : "border-emerald-500/35 bg-[#152019] text-[#edf2ee]"
              )}
            >
              <div className="flex items-start gap-2.5 min-w-0">
                <QrCode
                  className={cn(
                    "w-4 h-4 shrink-0 mt-0.5",
                    mmzapLoggedOutChips.length > 0 ? "text-amber-300" : "text-emerald-400"
                  )}
                />
                <div className="space-y-0.5 min-w-0">
                  <p className="font-semibold text-[#edf2ee]">
                    {mmzapLoggedOutChips.length === mmzapOnboardingChips.length
                      ? `Sessão MMZap deslogada em ${mmzapLoggedOutChips.length} chip(s) · re-escanear QR`
                      : `Passo final: parear MMZap em ${mmzapOnboardingChips.length} chip(s)`}
                  </p>
                  <p className="text-[#a5b1a8]">
                    {mmzapLoggedOutChips.length > 0 &&
                    mmzapLoggedOutChips.length < mmzapOnboardingChips.length
                      ? `${mmzapLoggedOutChips.length} com sessão deslogada e ${mmzapOnboardingChips.length - mmzapLoggedOutChips.length} aguardando 1º pareamento no navegador isolado.`
                      : "Escaneie o QR no navegador isolado (mesmo proxy exclusivo) para ativar os turnos automáticos do MMZap."}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 shrink-0">
                {mmzapOnboardingChips.slice(0, 3).map((chip) => {
                  const sess =
                    workerSessions.find((s) => s.instanceName === chip.instance_name) ?? null;
                  const needsRescan = isChipMmzapQrRequired(chip.config, sess);
                  return (
                    <button
                      key={chip.instance_name}
                      type="button"
                      onClick={() => handleOpenMmzapPairModal(chip.instance_name, "pair")}
                      className={
                        mmzapOnboardingChips.length === 1
                          ? styles.primaryAction
                          : styles.secondaryAction
                      }
                    >
                      <QrCode
                        className={cn(
                          "w-3.5 h-3.5",
                          mmzapOnboardingChips.length === 1
                            ? "text-[#10251b]"
                            : needsRescan
                              ? "text-amber-300"
                              : "text-emerald-400"
                        )}
                      />
                      {needsRescan ? "Re-escanear QR" : "Parear MMZap"}
                      {mmzapOnboardingChips.length > 1 ? ` · ${chip.instance_name}` : ""}
                    </button>
                  );
                })}
                {mmzapOnboardingChips.length > 3 && (
                  <span className="text-[11px] text-[#a5b1a8] tabular-nums">
                    +{mmzapOnboardingChips.length - 3} na lista
                  </span>
                )}
              </div>
            </section>
          )}

          {/* Barra operacional de Capacidade Segura de Prospecção Hoje */}
          {instances.length > 0 && (
            <section
              aria-label="Capacidade segura de prospecção hoje"
              className="mb-4 rounded-xl border border-[#303a32] bg-[#181d19] px-5 py-3.5 space-y-3"
            >
              <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <span className="text-xs font-medium text-[#a5b1a8]">
                    Capacidade Segura de Prospecção Hoje
                  </span>
                  <span
                    className={cn(
                      "text-xl font-semibold tracking-tight tabular-nums",
                      fleetReadiness.totalSafeDailyCold >= fleetReadiness.benchmarkMin
                        ? "text-emerald-300"
                        : "text-[#edf2ee]"
                    )}
                  >
                    {fleetReadiness.totalSafeDailyCold} frios/dia
                  </span>
                  <span
                    className={cn(
                      "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium tabular-nums",
                      fleetReadiness.totalSafeDailyCold >= fleetReadiness.benchmarkMin
                        ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-200"
                        : "border-[#303a32] bg-[#131914] text-[#a5b1a8]"
                    )}
                  >
                    Meta {fleetReadiness.benchmarkMin}–{fleetReadiness.benchmarkMax}/dia
                  </span>
                </div>

                <div className="flex flex-col sm:flex-row sm:items-center gap-3 lg:gap-5 flex-1 lg:max-w-xl">
                  <div className="flex-1 min-w-[140px] space-y-1">
                    <div
                      role="progressbar"
                      aria-label="Progresso em relação à meta diária de prospecção segura"
                      aria-valuenow={fleetReadiness.totalSafeDailyCold}
                      aria-valuemin={0}
                      aria-valuemax={fleetReadiness.benchmarkMax}
                      className="h-1.5 w-full rounded-full bg-[#222a24] overflow-hidden"
                    >
                      <div
                        className={cn(
                          "h-full rounded-full transition-all",
                          fleetReadiness.totalSafeDailyCold >= fleetReadiness.benchmarkMin
                            ? "bg-emerald-400"
                            : fleetReadiness.totalSafeDailyCold > 0
                              ? "bg-amber-400"
                              : "bg-[#3b483e]"
                        )}
                        style={{ width: `${capacityProgressPct}%` }}
                      />
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs tabular-nums text-[#a5b1a8] shrink-0">
                    <span>
                      <strong className="text-emerald-300 font-medium">
                        {fleetReadiness.readyChipsCount}
                      </strong>{" "}
                      pronto(s)
                      {fleetReadiness.veteranChipsCount > 0
                        ? ` (${fleetReadiness.veteranChipsCount} vet.)`
                        : ""}
                    </span>
                    <span>
                      <strong className="text-sky-300 font-medium">
                        {fleetReadiness.maturingChipsCount}
                      </strong>{" "}
                      no berçário
                    </span>
                    {fleetReadiness.blockedChipsCount > 0 && (
                      <span>
                        <strong className="text-amber-300 font-medium">
                          {fleetReadiness.blockedChipsCount}
                        </strong>{" "}
                        bloqueado(s)
                      </span>
                    )}
                    {fleetReadiness.offlineChipsCount > 0 && (
                      <span>
                        <strong className="text-[#c2cfc6] font-medium">
                          {fleetReadiness.offlineChipsCount}
                        </strong>{" "}
                        offline
                      </span>
                    )}
                  </div>
                </div>
              </div>

              {datacenterWarningChips.length > 0 && (
                <div
                  role="alert"
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-t border-[#303a32] pt-2.5 text-xs text-amber-200"
                >
                  <div className="flex items-start gap-2">
                    <ShieldAlert className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
                    <p>
                      <strong>
                        {datacenterWarningChips.length} chip(s) em proxy de Datacenter/ASN
                      </strong>{" "}
                      ({datacenterWarningChips.map((c) => c.instance_name).join(", ")}). Prefira proxy BR Residencial/ISP ou 4G dedicado antes de escalar acima de 40 envios/dia por chip.
                    </p>
                  </div>
                  <a
                    href="/whatsapp"
                    className="inline-flex items-center justify-center rounded-md border border-amber-400/40 bg-[#1a1811] px-2.5 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/20 shrink-0"
                  >
                    Revisar proxies
                  </a>
                </div>
              )}
            </section>
          )}

          {/* Faixa única de resumo operacional (sem 4 cards separados) */}
          <div className={styles.summaryStrip}>
            <div className={styles.summaryCell}>
              <span className={styles.summaryLabel}>Chips ADM online</span>
              <span className={styles.summaryValue}>
                {connectedCount}/{instances.length}
              </span>
              <span className={styles.summarySubtext}>
                {activeChipCount} aquecendo · {stats.totalSentToday}/{totalDailyTarget || 0} envios hoje
              </span>
            </div>

            <div className={styles.summaryCell}>
              <span className={styles.summaryLabel}>Prontos p/ prospecção</span>
              <span className={cn(styles.summaryValue, readyCount > 0 && "text-emerald-300")}>
                {readyCount}
              </span>
              <span className={styles.summarySubtext}>
                {quarantinedCount > 0
                  ? `${quarantinedCount} em quarentena preventiva`
                  : `${fleetReadiness.maturingChipsCount} em maturação (Dias 1–6)`}
              </span>
            </div>

            <div className={styles.summaryCell}>
              <span className={styles.summaryLabel}>MMZap recebido hoje</span>
              <span className={styles.summaryValue}>{mmzapInboundToday}</span>
              <span className={styles.summarySubtext}>
                {mmzapSentToday} enviadas ·{" "}
                {mmzapLoggedOutChips.length > 0
                  ? `${mmzapLoggedOutChips.length} sessão(ões) deslogada(s)`
                  : mmzapWatchdogRecoveries > 0
                    ? `watchdog ${mmzapWatchdogRecoveries}x · CRM blindado`
                    : "blindagem CRM ativa"}
              </span>
            </div>

            <div className={styles.summaryCell}>
              <span className={styles.summaryLabel}>Auto-cura do sistema</span>
              <span className={styles.summaryValue}>{fixedSelfHealCount}</span>
              <span className={styles.summarySubtext}>
                {attentionSelfHealCount > 0
                  ? `${attentionSelfHealCount} item(ns) pedem sua ação`
                  : "nenhuma pendência crítica"}
              </span>
            </div>
          </div>

          {/* Navegação em 4 abas */}
          <div className={styles.tabsBar} role="tablist" aria-label="Visões do aquecedor">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "chips"}
              onClick={() => setActiveTab("chips")}
              className={cn(styles.tabButton, activeTab === "chips" && styles.tabButtonActive)}
            >
              <Smartphone className="w-4 h-4" />
              <span>Chips ADM</span>
              <span className={cn(styles.tabBadge, activeTab === "chips" && styles.tabBadgeActive)}>
                {instances.length}
              </span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "autonomy"}
              onClick={() => setActiveTab("autonomy")}
              className={cn(
                styles.tabButton,
                activeTab === "autonomy" && styles.tabButtonActive
              )}
            >
              <ShieldCheck className="w-4 h-4" />
              <span>Auto-Cura &amp; MMZap</span>
              <span
                className={cn(
                  styles.tabBadge,
                  activeTab === "autonomy" && styles.tabBadgeActive
                )}
              >
                {mmzapInboundToday}
              </span>
            </button>

            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "groups"}
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
              role="tab"
              aria-selected={activeTab === "logs"}
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

          {/* ABA 1: CHIPS ADM */}
          {activeTab === "chips" && (
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <div>
                  <h2 className={styles.panelTitle}>Chips Administradores em operação</h2>
                  <p className={styles.panelDescription}>
                    Conecte um chip ADM em WhatsApp e escaneie o QR Code. Proxy, webhook, escudo MMZap &quot;Só receber&quot; e progressão de fase são gerenciados sozinhos.
                  </p>
                </div>
              </div>

              {loading ? (
                <div className="p-6 text-xs text-[#a5b1a8]">Carregando chips ADM...</div>
              ) : instances.length === 0 ? (
                <div className="p-8 text-center space-y-3">
                  <Smartphone className="w-9 h-9 text-[#718175] mx-auto" />
                  <h3 className="text-base font-medium text-[#edf2ee]">
                    Nenhum número ADM conectado ainda
                  </h3>
                  <p className="text-xs text-[#a5b1a8] max-w-md mx-auto leading-relaxed">
                    Adicione suas instâncias na área de WhatsApp. Assim que o QR Code for escaneado, o chip aparece aqui automaticamente com o escudo MMZap ligado.
                  </p>
                  <div className="pt-1">
                    <a href="/whatsapp" className={styles.primaryAction}>
                      Conectar chip ADM
                    </a>
                  </div>
                </div>
              ) : (
                <div className="divide-y divide-[#303a32]">
                  {instances.map((item) => {
                    const instName = item.instance_name;
                    const diag = diagnostics.find((d) => d.instance_name === instName);
                    const isDirty =
                      JSON.stringify(item.config) !==
                      JSON.stringify(savedConfigs[instName]);
                    return (
                      <ChipAutopilotRow
                        key={instName}
                        item={item}
                        diagnostic={diag}
                        isDirty={isDirty}
                        isSaving={Boolean(savingMap[instName])}
                        isReauditing={Boolean(reauditLoadingMap[instName])}
                        workerConfigured={Boolean(mmzapWorkerHealth?.configured)}
                        workerSession={
                          workerSessions.find((s) => s.instanceName === instName) ?? null
                        }
                        styles={styles}
                        onToggleEnabled={(name, next) =>
                          void handleToggleChipEnabled(name, next)
                        }
                        onChangeField={handleUpdateConfigField}
                        onSaveConfig={(name) => void handleSaveConfig(name)}
                        onChangeMmzapMode={handleChangeMmzapMode}
                        onOpenMmzapPairModal={handleOpenMmzapPairModal}
                        onMmzapBrowserAction={handleMmzapBrowserAction}
                        onReleaseQuarantine={handleReleaseQuarantine}
                        onOpenHotswap={openHotswapModal}
                        onReauditDay0={(name) => void handleReauditDay0(name)}
                        onOpenPairModal={openPairModal}
                        onOpenTestModal={openTestModal}
                      />
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ABA 2: AUTO-CURA & MMZAP */}
          {activeTab === "autonomy" && (
            <MmzapLiveMonitor
              chips={instances.filter((i) => !i.orphan)}
              diagnostics={diagnostics}
              selfHealingLog={selfHealingLog}
              workerHealth={mmzapWorkerHealth}
              governorSettings={mmzapGovernor}
              styles={styles}
              selfHealingBusy={selfHealingBusy}
              onRunSelfHealing={handleRunSelfHealing}
              onRefreshAll={handleRefreshAll}
              onOpenMmzapPairModal={handleOpenMmzapPairModal}
              onMmzapBrowserAction={handleMmzapBrowserAction}
            />
          )}

          {/* ABA 3: GRUPOS */}
          {activeTab === "groups" && (
            <div className={styles.panel}>
              <div className="divide-y divide-[#303a32]">
                <section className="p-5 space-y-4">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <h2 className={styles.panelTitle}>Grupos de aquecimento</h2>
                      <p className={styles.panelDescription}>
                        Seus chips entram aos poucos e reagem às mensagens para construir histórico natural, sem jogar conversas de grupo no atendimento.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        disabled={groupBulkActionBusy}
                        onClick={() => void handleGroupAction("discover_existing")}
                        className={styles.secondaryAction}
                      >
                        <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
                        Descobrir existentes
                      </button>
                      <button
                        type="button"
                        disabled={groupBulkActionBusy}
                        onClick={() => void handleGroupAction("create_internal_swarm")}
                        className={styles.secondaryAction}
                      >
                        <Users className="w-3.5 h-3.5 text-emerald-400" />
                        Criar enxame interno
                      </button>
                      <button
                        type="button"
                        disabled={groupBulkActionBusy}
                        onClick={() => void handleGroupAction("cleanup_dead")}
                        className={styles.secondaryAction}
                      >
                        <Trash2 className="w-3.5 h-3.5 text-amber-400" />
                        Limpar mortos
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleSyncGroupMembers()}
                        disabled={syncingGroups || groups.length === 0}
                        className={styles.secondaryAction}
                      >
                        <RefreshCw
                          className={cn("w-3.5 h-3.5", syncingGroups && "animate-spin")}
                        />
                        Sincronizar chips
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2.5">
                    <label htmlFor="group-links-input" className={styles.fieldLabel}>
                      Importar novos links de grupos (um por linha)
                    </label>
                    <textarea
                      id="group-links-input"
                      rows={3}
                      value={importLinksInput}
                      onChange={(e) => setImportLinksInput(e.target.value)}
                      placeholder={"https://chat.whatsapp.com/G34A1B2C3D4E5F\nhttps://chat.whatsapp.com/L99Z8Y7X6W5V4U"}
                      className={cn(styles.fieldInput, "h-auto font-mono text-xs py-2.5 resize-y")}
                    />
                    <div className="flex items-center justify-end">
                      <button
                        type="button"
                        onClick={() => void handleImportGroups()}
                        disabled={importingGroups || !importLinksInput.trim()}
                        className={styles.primaryAction}
                      >
                        <Users className="w-4 h-4" />
                        {importingGroups ? "Importando..." : "Adicionar grupos"}
                      </button>
                    </div>
                  </div>
                </section>

                <section className="p-5 space-y-3">
                  <h3 className="text-sm font-semibold text-[#edf2ee]">
                    Grupos cadastrados ({groups.length})
                  </h3>

                  {groupsLoading ? (
                    <p className="text-xs text-[#a5b1a8]">Carregando grupos...</p>
                  ) : groups.length === 0 ? (
                    <p className="text-xs text-[#a5b1a8]">
                      Nenhum grupo cadastrado ainda. Cole links acima ou clique em &quot;Descobrir existentes&quot;.
                    </p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className={styles.groupsTable}>
                        <thead>
                          <tr>
                            <th>Grupo</th>
                            <th>Código</th>
                            <th>Chips no grupo</th>
                            <th>Lidas</th>
                            <th>Reações</th>
                            <th>Status</th>
                            <th className="text-right">Ação</th>
                          </tr>
                        </thead>
                        <tbody>
                          {groups.map((g) => (
                            <tr key={g.id}>
                              <td className="font-medium text-[#edf2ee] max-w-[200px] truncate">
                                {g.name || "Grupo sem título"}
                              </td>
                              <td className="font-mono text-[11px] text-[#a5b1a8] max-w-[140px] truncate">
                                {g.invite_code}
                              </td>
                              <td>
                                <div className="flex flex-wrap gap-1 max-w-[200px]">
                                  {(g.members || []).length === 0 ? (
                                    <span className="text-[#95a499] text-[11px]">Nenhum</span>
                                  ) : (
                                    (g.members || []).map((m) => (
                                      <Badge
                                        key={m.instance_name}
                                        variant="outline"
                                        className="text-[10px] border-emerald-500/30 bg-emerald-500/10 text-emerald-200 py-0"
                                      >
                                        {m.instance_name}
                                      </Badge>
                                    ))
                                  )}
                                </div>
                              </td>
                              <td className="tabular-nums font-mono text-[11px] text-[#d3ded6]">
                                {g.total_messages_received || 0}
                              </td>
                              <td className="tabular-nums font-mono text-[11px] text-[#d3ded6]">
                                {g.total_reactions_sent || 0}
                              </td>
                              <td>
                                <Badge
                                  variant="outline"
                                  className={cn(
                                    "text-[10px]",
                                    g.status === "active"
                                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                                      : "border-amber-500/30 bg-amber-500/10 text-amber-200"
                                  )}
                                >
                                  {g.is_dead ? "Silencioso >72h" : g.status === "active" ? "Ativo" : g.status}
                                </Badge>
                              </td>
                              <td className="text-right">
                                <button
                                  type="button"
                                  onClick={() => void handleDeleteGroup(g.id)}
                                  className="text-[#a5b1a8] hover:text-red-300 p-1.5 rounded"
                                  aria-label={`Remover grupo ${g.name || g.invite_code}`}
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>
              </div>
            </div>
          )}

          {/* ABA 4: ATIVIDADE */}
          {activeTab === "logs" && (
            <div className={styles.panel}>
              <div className={styles.panelHeader}>
                <div className="flex items-center gap-2.5">
                  <span
                    className={cn(
                      "w-2 h-2 rounded-full",
                      autoRefreshLogs ? "bg-emerald-400" : "bg-neutral-600"
                    )}
                    aria-hidden="true"
                  />
                  <h2 className={styles.panelTitle}>Atividade recente ({logs.length})</h2>
                </div>
                <div className="flex items-center gap-3">
                  <label className="text-xs text-[#a5b1a8] flex items-center gap-2 cursor-pointer">
                    <span>Atualizar sozinho</span>
                    <Switch
                      checked={autoRefreshLogs}
                      onCheckedChange={setAutoRefreshLogs}
                      aria-label="Atualizar atividade automaticamente"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void loadData(true)}
                    className={styles.secondaryAction}
                  >
                    <RefreshCw className="w-3.5 h-3.5" />
                    Atualizar
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
                      <Inbox className="w-6 h-6 text-[#718175] mx-auto" />
                      <p className="text-xs text-[#a5b1a8]">
                        Quando dois chips conversarem entre si, cada evento aparece aqui.
                      </p>
                    </div>
                  ) : (
                    logs.map((log) => {
                      const time = log.created_at
                        ? new Date(log.created_at).toLocaleTimeString("pt-BR", {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })
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
                            <Badge
                              variant="outline"
                              className={`text-[11px] flex items-center gap-1 ${typeUI.chip}`}
                            >
                              <TypeIcon className="w-3 h-3" />
                              {typeUI.label}
                            </Badge>
                            <span className="flex items-center gap-1.5 text-xs text-[#edf2ee]">
                              <span className="font-medium">{log.sender_instance}</span>
                              <ArrowRight className="w-3 h-3 text-[#718175]" aria-hidden="true" />
                              <span className="font-medium">{log.receiver_instance}</span>
                            </span>
                          </div>
                          <div className={styles.terminalText}>{log.message_text}</div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </div>
          )}

          {/* DIALOG: Ajustes Gerais do Motor */}
          <Dialog open={globalModalOpen} onOpenChange={setGlobalModalOpen}>
            <DialogContent className={cn(styles.dialog, "max-w-3xl max-h-[85dvh] overflow-y-auto")}>
              <div className={styles.dialogHeader}>
                <Bot className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <DialogTitle className="text-base font-semibold text-[#edf2ee]">
                    Ajustes gerais do motor de aquecimento
                  </DialogTitle>
                  <DialogDescription className="text-xs text-[#a5b1a8] mt-1">
                    Define padrões globais de diálogos, janela de horário e proteções anti-bloqueio para novos chips ADM.
                  </DialogDescription>
                </div>
              </div>

              <div className={styles.dialogBody}>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className={styles.fieldGroup}>
                    <label htmlFor="ai-model" className={styles.fieldLabel}>
                      Modelo de IA ({modelsLoading ? "carregando..." : `${aiModels.length} disponíveis`})
                    </label>
                    <select
                      id="ai-model"
                      value={globalSettings.ai_model}
                      onChange={(e) =>
                        setGlobalSettings((p) => ({ ...p, ai_model: e.target.value }))
                      }
                      className={styles.fieldSelect}
                    >
                      <option value="fallback">
                        [GRÁTIS] Diálogos Nativos pt-BR (Zero Tokens)
                      </option>
                      <option value="auto:free-fast">
                        [AUTO GRÁTIS] OpenRouter/Gemini + Fallback Nativo
                      </option>
                      <ModelOptions models={aiModels} />
                    </select>
                  </div>

                  <div className={styles.fieldGroup}>
                    <label htmlFor="ai-theme" className={styles.fieldLabel}>
                      Assunto das conversas
                    </label>
                    <select
                      id="ai-theme"
                      value={globalSettings.ai_theme}
                      onChange={(e) =>
                        setGlobalSettings((p) => ({ ...p, ai_theme: e.target.value }))
                      }
                      className={styles.fieldSelect}
                    >
                      {WARMUP_THEMES.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className={styles.fieldGroup}>
                    <label htmlFor="g-start" className={styles.fieldLabel}>
                      Início (h)
                    </label>
                    <Input
                      id="g-start"
                      type="number"
                      min={0}
                      max={23}
                      value={globalSettings.allowed_start_hour}
                      onChange={(e) =>
                        setGlobalSettings((p) => ({
                          ...p,
                          allowed_start_hour: Number(e.target.value),
                        }))
                      }
                      className={styles.fieldInput}
                    />
                  </div>
                  <div className={styles.fieldGroup}>
                    <label htmlFor="g-end" className={styles.fieldLabel}>
                      Fim (h)
                    </label>
                    <Input
                      id="g-end"
                      type="number"
                      min={1}
                      max={24}
                      value={globalSettings.allowed_end_hour}
                      onChange={(e) =>
                        setGlobalSettings((p) => ({
                          ...p,
                          allowed_end_hour: Number(e.target.value),
                        }))
                      }
                      className={styles.fieldInput}
                    />
                  </div>
                  <div className={styles.fieldGroup}>
                    <label htmlFor="g-min-int" className={styles.fieldLabel}>
                      Pausa mín (s)
                    </label>
                    <Input
                      id="g-min-int"
                      type="number"
                      min={30}
                      value={globalSettings.min_interval_seconds}
                      onChange={(e) =>
                        setGlobalSettings((p) => ({
                          ...p,
                          min_interval_seconds: Number(e.target.value),
                        }))
                      }
                      className={styles.fieldInput}
                    />
                  </div>
                  <div className={styles.fieldGroup}>
                    <label htmlFor="g-max-int" className={styles.fieldLabel}>
                      Pausa máx (s)
                    </label>
                    <Input
                      id="g-max-int"
                      type="number"
                      min={60}
                      value={globalSettings.max_interval_seconds}
                      onChange={(e) =>
                        setGlobalSettings((p) => ({
                          ...p,
                          max_interval_seconds: Number(e.target.value),
                        }))
                      }
                      className={styles.fieldInput}
                    />
                  </div>
                </div>

                <div className="divide-y divide-[#303a32] border border-[#303a32] rounded-lg">
                  {PROTECTIONS.map((item) => (
                    <div
                      key={item.key}
                      className="flex items-center justify-between gap-3 px-3.5 py-2.5"
                    >
                      <div>
                        <p className="text-xs font-medium text-[#edf2ee]">{item.title}</p>
                        <p className="text-[11px] text-[#a5b1a8]">{item.description}</p>
                      </div>
                      <Switch
                        checked={Boolean(globalSettings[item.key])}
                        onCheckedChange={(val) =>
                          setGlobalSettings((p) => ({ ...p, [item.key]: val }))
                        }
                        aria-label={`Ativar ${item.title}`}
                      />
                    </div>
                  ))}
                </div>

                <label className="flex items-center justify-between gap-3 rounded-lg border border-[#303a32] px-3.5 py-2.5 text-xs text-[#d3ded6] cursor-pointer">
                  <div>
                    <p className="font-medium text-[#edf2ee]">Resumo diário às 20h no WhatsApp</p>
                    <p className="text-[11px] text-[#a5b1a8]">
                      Envia relatório automático às 20h BRT (disparos, respostas, prévias aceitas e alertas). Zero tokens de IA.
                    </p>
                  </div>
                  <Switch
                    checked={Boolean(globalSettings.daily_owner_summary_enabled)}
                    onCheckedChange={(val) =>
                      setGlobalSettings((p) => ({ ...p, daily_owner_summary_enabled: val }))
                    }
                    aria-label="Ativar resumo diário às 20h"
                  />
                </label>

                {globalSettings.daily_owner_summary_enabled && (
                  <div className={styles.fieldGroup}>
                    <label htmlFor="g-owner-phone" className={styles.fieldLabel}>
                      WhatsApp do gestor para o resumo 20h (opcional — usa o do Agente se vazio)
                    </label>
                    <Input
                      id="g-owner-phone"
                      value={globalSettings.daily_owner_summary_phone || ""}
                      onChange={(e) =>
                        setGlobalSettings((p) => ({
                          ...p,
                          daily_owner_summary_phone: e.target.value,
                        }))
                      }
                      placeholder="Ex: 5511999999999"
                      className={styles.fieldInput}
                    />
                  </div>
                )}

                <div className={styles.fieldGroup}>
                  <label htmlFor="g-avatar-pool" className={styles.fieldLabel}>
                    Pool de fotos de perfil Dia-0 (opcional, 1 URL https:// por linha)
                  </label>
                  <textarea
                    id="g-avatar-pool"
                    rows={2}
                    value={globalSettings.default_profile_avatar_urls || ""}
                    onChange={(e) =>
                      setGlobalSettings((p) => ({
                        ...p,
                        default_profile_avatar_urls: e.target.value,
                      }))
                    }
                    placeholder="https://exemplo.com/foto-atendimento.jpg"
                    className={styles.fieldInput}
                  />
                </div>

                <label className="flex items-center justify-between gap-3 rounded-lg border border-[#303a32] px-3.5 py-2.5 text-xs text-[#d3ded6] cursor-pointer">
                  <span>Aplicar também aos chips ADM já configurados</span>
                  <Switch
                    checked={applyGlobalToAll}
                    onCheckedChange={setApplyGlobalToAll}
                    aria-label="Aplicar proteções aos chips já configurados"
                  />
                </label>

                <div className={styles.dialogActions}>
                  <button
                    type="button"
                    onClick={() => setGlobalModalOpen(false)}
                    className={styles.secondaryAction}
                  >
                    Fechar
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSaveGlobalSettings()}
                    disabled={savingGlobal || (!globalDirty && !applyGlobalToAll)}
                    className={styles.primaryAction}
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    {savingGlobal ? "Salvando..." : "Salvar ajustes gerais"}
                  </button>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          {/* DIALOG: Teste manual 1-on-1 */}
          <Dialog open={testModalOpen} onOpenChange={setTestModalOpen}>
            <DialogContent className={styles.dialog}>
              <div className={styles.dialogHeader}>
                <Flame className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <DialogTitle className="text-base font-semibold text-[#edf2ee]">
                    Testar conversa entre dois chips ADM
                  </DialogTitle>
                  <DialogDescription className="text-xs text-[#a5b1a8] mt-1">
                    Dispara uma troca imediata usando os mesmos atrasos e leitura natural do aquecimento.
                  </DialogDescription>
                </div>
              </div>

              <div className={styles.dialogBody}>
                <div className={styles.fieldGroup}>
                  <label htmlFor="test-sender" className={styles.fieldLabel}>
                    Chip que envia
                  </label>
                  <select
                    id="test-sender"
                    value={testSender}
                    onChange={(e) => setTestSender(e.target.value)}
                    className={styles.fieldSelect}
                  >
                    <option value="">Selecione</option>
                    {instances.map((i) => (
                      <option key={i.instance_name} value={i.instance_name}>
                        {i.instance_name} {i.phone_number ? `(+${i.phone_number})` : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <div className={styles.fieldGroup}>
                  <label htmlFor="test-receiver" className={styles.fieldLabel}>
                    Chip que recebe
                  </label>
                  <select
                    id="test-receiver"
                    value={testReceiver}
                    onChange={(e) => setTestReceiver(e.target.value)}
                    className={styles.fieldSelect}
                  >
                    <option value="">Selecione</option>
                    {instances.map((i) => (
                      <option key={i.instance_name} value={i.instance_name}>
                        {i.instance_name} {i.phone_number ? `(+${i.phone_number})` : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <label className="flex items-center justify-between gap-3 rounded-lg border border-[#303a32] px-3.5 py-2.5 text-xs text-[#d3ded6] cursor-pointer">
                  <span className="flex items-center gap-2">
                    <Radio className="w-4 h-4 text-emerald-400" />
                    Publicar também um Status / Story no remetente
                  </span>
                  <Switch
                    checked={testStatusPost}
                    onCheckedChange={setTestStatusPost}
                    aria-label="Testar postagem de status"
                  />
                </label>

                {testBlockedReason && (
                  <p className="text-xs text-amber-300 flex items-center gap-1.5">
                    <Info className="w-4 h-4 shrink-0" />
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
                    onClick={() => void handleRunTest()}
                    disabled={testLoading || Boolean(testBlockedReason)}
                    className={styles.primaryAction}
                  >
                    {testLoading ? "Executando..." : "Enviar teste agora"}
                  </button>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          {/* DIALOG: Aquecer dois chips em par */}
          <Dialog open={mutualModalOpen} onOpenChange={setMutualModalOpen}>
            <DialogContent className={styles.dialog}>
              <div className={styles.dialogHeader}>
                <Sparkles className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                <div>
                  <DialogTitle className="text-base font-semibold text-[#edf2ee]">
                    Aquecer dois chips ADM em par
                  </DialogTitle>
                  <DialogDescription className="text-xs text-[#a5b1a8] mt-1">
                    Eles salvam o contato um do outro e trocam mensagens naturais nos dois sentidos.
                  </DialogDescription>
                </div>
              </div>

              <div className={styles.dialogBody}>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className={styles.fieldGroup}>
                    <label htmlFor="pair-chip-a" className={styles.fieldLabel}>
                      Primeiro chip
                    </label>
                    <select
                      id="pair-chip-a"
                      value={pairChipA}
                      onChange={(e) => setPairChipA(e.target.value)}
                      className={styles.fieldSelect}
                    >
                      <option value="">Selecione</option>
                      {instances.map((i) => (
                        <option key={i.instance_name} value={i.instance_name}>
                          {i.instance_name} · {STAGE_UI[(i.config?.stage || 1) as WarmupStage].name}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div className={styles.fieldGroup}>
                    <label htmlFor="pair-chip-b" className={styles.fieldLabel}>
                      Segundo chip
                    </label>
                    <select
                      id="pair-chip-b"
                      value={pairChipB}
                      onChange={(e) => setPairChipB(e.target.value)}
                      className={styles.fieldSelect}
                    >
                      <option value="">Selecione</option>
                      {instances.map((i) => (
                        <option key={i.instance_name} value={i.instance_name}>
                          {i.instance_name} · {STAGE_UI[(i.config?.stage || 1) as WarmupStage].name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                <label className="flex items-center justify-between gap-3 rounded-lg border border-[#303a32] px-3.5 py-2.5 text-xs text-[#d3ded6] cursor-pointer">
                  <span>Postar Status / Stories durante o aquecimento do par</span>
                  <Switch
                    checked={mutualStatusPost}
                    onCheckedChange={setMutualStatusPost}
                    aria-label="Ativar postagem de status"
                  />
                </label>

                <div className={styles.dialogActions}>
                  <button
                    type="button"
                    onClick={() => setMutualModalOpen(false)}
                    className={styles.secondaryAction}
                  >
                    Fechar
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRunMutualWarmup()}
                    disabled={
                      mutualLoading || autopilotLoading || !pairChipA || !pairChipB || pairChipA === pairChipB
                    }
                    className={styles.secondaryAction}
                  >
                    {mutualLoading ? "Aquecendo..." : "Aquecer uma vez"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleEnablePairAutopilot()}
                    disabled={
                      mutualLoading || autopilotLoading || !pairChipA || !pairChipB || pairChipA === pairChipB
                    }
                    className={styles.primaryAction}
                  >
                    {autopilotLoading ? "Ativando..." : "Deixar no automático"}
                  </button>
                </div>
              </div>
            </DialogContent>
          </Dialog>

          <MmzapPairModal
            open={mmzapModalOpen}
            instanceName={mmzapModalInstance}
            initialMode={mmzapModalMode}
            mmzapBrowserStatus={mmzapModalChipStatus}
            workerSession={mmzapModalWorkerSession}
            styles={styles}
            onOpenChange={setMmzapModalOpen}
            onCompleted={handleRefreshAll}
          />

          {/* DIALOG: Substituição rápida (Hotswap) */}
          <Dialog open={hotswapModalOpen} onOpenChange={(o) => !hotswapBusy && setHotswapModalOpen(o)}>
            <DialogContent className={styles.dialog}>
              <div className={styles.dialogHeader}>
                <ArrowRightLeft className="w-5 h-5 text-cyan-400 shrink-0 mt-0.5" />
                <div>
                  <DialogTitle className="text-base font-semibold text-[#edf2ee]">
                    Substituir chip (Hotswap)
                  </DialogTitle>
                  <DialogDescription className="text-xs text-[#a5b1a8] mt-1">
                    Migra campanhas, follow-ups e leads de <strong>{hotswapOldChip}</strong> para um chip estepe saudável.
                  </DialogDescription>
                </div>
              </div>
              <div className={styles.dialogBody}>
                <div className={styles.fieldGroup}>
                  <label htmlFor="hotswap-target-chip" className={styles.fieldLabel}>
                    Chip reserva conectado (destino)
                  </label>
                  <select
                    id="hotswap-target-chip"
                    value={hotswapNewChip}
                    onChange={(e) => setHotswapNewChip(e.target.value)}
                    className={styles.fieldSelect}
                  >
                    <option value="">Selecione um chip saudável</option>
                    {instances
                      .filter(
                        (i) =>
                          !i.orphan &&
                          i.instance_name !== hotswapOldChip &&
                          (i.connection_status === "open" || i.connection_status === "connected") &&
                          !i.config?.is_quarantined
                      )
                      .map((i) => (
                        <option key={i.instance_name} value={i.instance_name}>
                          {i.instance_name} · Dia {i.config?.days_active || 1} · Saúde {i.config?.health_score ?? 100}%
                        </option>
                      ))}
                  </select>
                </div>
                <div className={styles.dialogActions}>
                  <button
                    type="button"
                    disabled={hotswapBusy}
                    onClick={() => setHotswapModalOpen(false)}
                    className={styles.secondaryAction}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    disabled={hotswapBusy || !hotswapNewChip}
                    onClick={() => void handleConfirmHotswap()}
                    className={styles.primaryAction}
                  >
                    {hotswapBusy ? "Migrando..." : "Confirmar Hotswap"}
                  </button>
                </div>
              </div>
            </DialogContent>
          </Dialog>
        </div>
      </main>
    </div>
  );
}
