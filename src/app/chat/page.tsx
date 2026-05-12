"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { usePathname } from "next/navigation";
import { Header } from "@/components/layout/header";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Bot, User, Send, ShieldCheck, ShieldOff, Search, Clock, MessageSquare, Loader2,
  Smartphone, Wifi, WifiOff, AlertTriangle, ChevronDown, ChevronLeft, Timer, Settings, UserPlus,
  Sparkles, Zap, Paperclip, Mic, Square, Image as ImageIcon, Trash2, BrainCircuit,
  Check, CheckCheck, ExternalLink, Pause, Play, AlertCircle, Key
} from "lucide-react";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

interface ChatMessage {
  id: number;
  message_id?: string;
  remote_jid?: string;
  session_id?: string;
  sender_type: "customer" | "ai" | "human" | "system";
  sender?: "customer" | "ai" | "human" | "system";
  content: string;
  base64_content?: string;
  media_url?: string;
  media_type?: string;
  media_category?: string;
  mimetype?: string;
  file_name?: string;
  quoted_id?: string;
  quoted_msg_id?: string;
  quoted_text?: string;
  status_envio?: "sent" | "delivered" | "read" | "error";
  delivery_status?: string;
  created_at: string;
  instance_name?: string;
}

/**
 * Resolve a fonte de mídia: prioriza base64_content do Supabase,
 * fallback para media_url. Retorna data URI ou URL.
 */
function resolveMediaSrc(msg: ChatMessage): string | null {
  if (msg.base64_content && msg.base64_content.length > 10) {
    // Se já é um data URI completo (começa com data:)
    if (msg.base64_content.startsWith('data:')) {
      return msg.base64_content;
    }
    // Constrói data URI a partir do mimetype
    const mime = msg.mimetype || inferMimeType(msg.media_type);
    return `data:${mime};base64,${msg.base64_content}`;
  }
  if (msg.media_url && msg.media_url.length > 5) {
    return msg.media_url;
  }
  return null;
}

/**
 * Infere o mimetype com base no media_type do Evolution API
 */
function inferMimeType(mediaType?: string): string {
  if (!mediaType) return 'application/octet-stream';
  const mt = mediaType.toLowerCase().replace('message', '');
  if (mt.includes('image')) return 'image/jpeg';
  if (mt.includes('audio') || mt.includes('ptt')) return 'audio/ogg; codecs=opus';
  if (mt.includes('video')) return 'video/mp4';
  if (mt.includes('document') || mt.includes('pdf')) return 'application/pdf';
  if (mt.includes('sticker')) return 'image/webp';
  return 'application/octet-stream';
}

/**
 * Detecta o tipo de mídia real a partir do media_type ou mimetype
 */
function detectMediaCategory(msg: ChatMessage): 'image' | 'audio' | 'video' | 'document' | null {
  const mt = (msg.media_type || '').toLowerCase();
  const mime = (msg.mimetype || '').toLowerCase();
  
  if (mt.includes('image') || mt.includes('sticker') || mime.startsWith('image/')) return 'image';
  if (mt.includes('audio') || mt.includes('ptt') || mime.startsWith('audio/')) return 'audio';
  if (mt.includes('video') || mime.startsWith('video/')) return 'video';
  if (mt.includes('document') || mime.includes('pdf') || mime.includes('spreadsheet') || mime.includes('word') || mime.includes('zip')) return 'document';
  
  // Fallback: tem base64 ou media_url mas sem tipo definido — tenta pelo mimetype
  if (msg.base64_content || msg.media_url) {
    if (mime) {
      if (mime.startsWith('image/')) return 'image';
      if (mime.startsWith('audio/')) return 'audio';
      if (mime.startsWith('video/')) return 'video';
      return 'document';
    }
  }
  
  return null;
}

/**
 * Formata a data para exibir separadores no chat (ex: "HOJE", "ONTEM", "DD/MM/YYYY")
 */
function formatChatDate(dateString: string): string {
  const date = new Date(dateString);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date.toDateString() === today.toDateString()) return "HOJE";
  if (date.toDateString() === yesterday.toDateString()) return "ONTEM";

  return date.toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  });
}

/**
 * Formato relativo tipo WhatsApp para a lista de conversas:
 *   - hoje  → "10:30"
 *   - ontem → "Ontem"
 *   - mesma semana → "Segunda" / "Terça" ...
 *   - mesmo ano   → "20/04"
 *   - outro ano   → "20/04/2024"
 */
function formatRelativeTime(dateString: string): string {
  if (!dateString) return "";
  const d = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const isToday = d.toDateString() === now.toDateString();
  const yest = new Date(now); yest.setDate(now.getDate() - 1);
  const isYesterday = d.toDateString() === yest.toDateString();

  if (isToday) return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (isYesterday) return "Ontem";

  // Mesma semana (até 7 dias atrás): mostra dia da semana
  if (diffMs < 7 * 24 * 60 * 60 * 1000) {
    const dias = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
    return dias[d.getDay()];
  }

  // Mesmo ano: dd/mm
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  }

  // Outro ano: dd/mm/aaaa
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
}

interface Conversation {
  remote_jid: string;
  nome_negocio?: string;
  lastMessage?: string;
  lastTime?: string;
  messageCount: number;
  isBlocked?: boolean;
  /** URL da foto de perfil do WhatsApp (Evolution). null = sem foto OU Cloud API. */
  avatarUrl?: string | null;
}

/**
 * Player de áudio estilo WhatsApp.
 * Play/Pause + progresso clicável + duração + microfone.
 */
function WhatsAppAudioPlayer({ src, isMe }: { src: string; isMe: boolean }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [ready, setReady] = useState(false);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) { a.pause(); } else { a.play().catch(() => {}); }
  };

  const onTime = () => {
    const a = audioRef.current;
    if (a) setCurrent(a.currentTime);
  };
  const onMeta = () => {
    const a = audioRef.current;
    if (a) {
      const d = isFinite(a.duration) ? a.duration : 0;
      setDuration(d);
      setReady(true);
    }
  };
  const onEnd = () => { setPlaying(false); setCurrent(0); };

  const fmt = (s: number) => {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, "0")}`;
  };

  const progressPct = duration > 0 ? (current / duration) * 100 : 0;

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = audioRef.current;
    if (!a || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    a.currentTime = (x / rect.width) * duration;
  };

  // 20 "barrinhas" estilo onda sonora — puramente visual
  const bars = 28;

  return (
    <div
      className={cn(
        "flex items-center gap-3 px-3 py-2 rounded-2xl min-w-[240px] max-w-[320px]",
        isMe ? "bg-[#005c4b]/40" : "bg-[#202c33]"
      )}
    >
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={onTime}
        onLoadedMetadata={onMeta}
        onEnded={onEnd}
      />

      <button
        type="button"
        onClick={toggle}
        disabled={!ready}
        className={cn(
          "shrink-0 w-9 h-9 rounded-full flex items-center justify-center transition-all",
          isMe
            ? "bg-[#00a884] text-white hover:bg-[#06cf9c]"
            : "bg-white/10 text-white hover:bg-white/20",
          !ready && "opacity-50 cursor-wait"
        )}
        aria-label={playing ? "Pausar" : "Reproduzir"}
      >
        {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
      </button>

      <div className="flex-1 min-w-0 space-y-1">
        {/* "Waveform" estilizada clicável */}
        <div
          onClick={seek}
          className="h-6 flex items-center gap-[2px] cursor-pointer group"
          title="Clique pra pular"
        >
          {Array.from({ length: bars }).map((_, i) => {
            const active = progressPct >= ((i + 1) / bars) * 100;
            // Altura "aleatória" determinística pra parecer onda
            const h = 4 + ((i * 7) % 14);
            return (
              <div
                key={i}
                className={cn(
                  "flex-1 rounded-sm transition-colors",
                  active
                    ? (isMe ? "bg-white" : "bg-[#53bdeb]")
                    : (isMe ? "bg-white/25" : "bg-white/20")
                )}
                style={{ height: `${h}px` }}
              />
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-2">
          <Mic className={cn("w-3 h-3 shrink-0", isMe ? "text-white/70" : "text-[#53bdeb]")} />
          <span className={cn("text-[10px] font-mono font-bold", isMe ? "text-white/80" : "text-white/60")}>
            {fmt(playing || current > 0 ? current : duration)}
          </span>
        </div>
      </div>
    </div>
  );
}

export default function ChatPage() {

  
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [selectedSession, setSelectedSession] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [inputMessage, setInputMessage] = useState("");
  const [searchConv, setSearchConv] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingConvs, setLoadingConvs] = useState(true);
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [wsStatus, setWsStatus] = useState<"open" | "close" | "unknown">("unknown");
  
  const [showLeadModal, setShowLeadModal] = useState(false);
  const [leadName, setLeadName] = useState("");
  const [leadStatus, setLeadStatus] = useState("novo");
  const [savingLead, setSavingLead] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const ttlIntervalRef = useRef<NodeJS.Timeout|null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const webhookUrlRef = useRef<string>("");
  
  const [isAiPaused, setIsAiPaused] = useState(false);
  const [isAiBlockedTemporal, setIsAiBlockedTemporal] = useState(false);
  const [aiTtlRemaining, setAiTtlRemaining] = useState(0);
  const [instances, setInstances] = useState<any[]>([]);
  const [activeInstance, setActiveInstance] = useState<string>("sdr");
  const [resumeAt, setResumeAt] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<string | null>(null);

  // === PAUSA GLOBAL (todas conversas) ===
  const [globalPaused, setGlobalPaused] = useState(false);
  const [globalPausedUntil, setGlobalPausedUntil] = useState<string | null>(null);

  // === FUNIL DE ETAPAS ===
  const [stages, setStages] = useState<any[]>([]);
  const [currentStageId, setCurrentStageId] = useState<number | null>(null);
  const [sessionVariables, setSessionVariables] = useState<any>({});

  // === ORGANIZADOR IA (análise diária automática) ===
  const [orgOpen, setOrgOpen] = useState(false);
  const [orgLoading, setOrgLoading] = useState(false);
  const [orgSaving, setOrgSaving] = useState(false);
  const [orgRunning, setOrgRunning] = useState(false);
  const [orgEnabled, setOrgEnabled] = useState(false);
  const [orgModel, setOrgModel] = useState<string>("");
  const [orgProvider, setOrgProvider] = useState<string>("Gemini");
  const [orgHour, setOrgHour] = useState<number>(20);
  const [orgLastRun, setOrgLastRun] = useState<string | null>(null);
  const [orgHasApiKey, setOrgHasApiKey] = useState(false);
  const [orgModels, setOrgModels] = useState<Array<{ id: string; name: string }>>([]);
  const [orgMsg, setOrgMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const loadOrganizerConfig = useCallback(async () => {
    setOrgLoading(true);
    setOrgMsg(null);
    try {
      const [cfgRes, modelsRes] = await Promise.all([
        fetch("/api/ai-organize/config").then((r) => r.json()),
        fetch("/api/ai-models").then((r) => r.json()),
      ]);
      if (cfgRes?.success && cfgRes.config) {
        setOrgEnabled(!!cfgRes.config.enabled);
        setOrgModel(cfgRes.config.model || "");
        setOrgProvider(cfgRes.config.provider || "Gemini");
        setOrgHour(typeof cfgRes.config.execution_hour === "number" ? cfgRes.config.execution_hour : 20);
        setOrgLastRun(cfgRes.config.last_run || null);
        setOrgHasApiKey(!!cfgRes.config.has_api_key);
      }
      if (modelsRes?.success && Array.isArray(modelsRes.models)) {
        setOrgModels(modelsRes.models);
      } else {
        setOrgModels([]);
      }
    } catch (err: any) {
      setOrgMsg({ type: "err", text: "Falha ao carregar config: " + (err?.message || err) });
    } finally {
      setOrgLoading(false);
    }
  }, []);

  const saveOrganizerConfig = async () => {
    setOrgSaving(true);
    setOrgMsg(null);
    try {
      const res = await fetch("/api/ai-organize/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled: orgEnabled,
          model: orgModel || null,
          provider: orgProvider || "Gemini",
          execution_hour: orgHour,
        }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Erro ao salvar");
      setOrgMsg({ type: "ok", text: "Configuração salva." });
    } catch (err: any) {
      setOrgMsg({ type: "err", text: err.message || String(err) });
    } finally {
      setOrgSaving(false);
    }
  };

  const runOrganizerNow = async () => {
    setOrgRunning(true);
    setOrgMsg(null);
    try {
      const res = await fetch("/api/ai-organize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: orgModel, provider: orgProvider || "Gemini" }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Falha ao executar");
      setOrgMsg({
        type: "ok",
        text: data.message || `${data.updatedCount || 0} leads movidos.`,
      });
      setOrgLastRun(new Date().toISOString());
    } catch (err: any) {
      setOrgMsg({ type: "err", text: err.message || String(err) });
    } finally {
      setOrgRunning(false);
    }
  };

  useEffect(() => {
    if (orgOpen) loadOrganizerConfig();
  }, [orgOpen, loadOrganizerConfig]);

  // Carrega leve só pra mostrar status no botão da sidebar (enabled + execution_hour)
  useEffect(() => {
    fetch("/api/ai-organize/config")
      .then((r) => r.json())
      .then((d) => {
        if (d?.success && d.config) {
          setOrgEnabled(!!d.config.enabled);
          setOrgHour(typeof d.config.execution_hour === "number" ? d.config.execution_hour : 20);
          setOrgLastRun(d.config.last_run || null);
        }
      })
      .catch(() => {});
  }, []);

  // Quanto tempo ficar pausado quando o operador começa a digitar (default 30 min)
  const TYPING_PAUSE_MINUTES = 30;
  // Marca a sessão pra qual JÁ disparei auto-pause (evita repetir a cada tecla)
  const typingPauseFiredRef = useRef<string | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem('sdr_active_instance');
    if (saved) setActiveInstance(saved);
  }, []);

  // Multimedia States
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [mediaRecorder, setMediaRecorder] = useState<MediaRecorder | null>(null);
  const recorderIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const extractText = (msg: ChatMessage) => msg.content || "[mensagem sem conteúdo]";
  
  const checkAiControl = useCallback(async (jid: string, inst: string) => {
    try {
      const res = await fetch("/api/agent/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "check", remoteJid: jid, instanceName: inst }),
      });
      const data = await res.json();
      setIsAiPaused(data.permanent || data.bot_status !== 'bot_active');
      setResumeAt(data.resume_at || null);
      setIsAiBlockedTemporal(data.blocked && !data.permanent);
      setAiTtlRemaining(data.ttl_remaining || 0);
      if (typeof data.global_paused === "boolean") {
        setGlobalPaused(data.global_paused);
        setGlobalPausedUntil(data.global_paused_until || null);
      }
    } catch (err) {
      console.error("Erro ao checar controle IA:", err);
    }
  }, []);

  // === PAUSA GLOBAL ===
  // Pausa "global" agora é POR INSTÂNCIA. Em modo "__all__" não há instância
  // selecionada, então tratamos como "não pausado" e o botão fica desabilitado.
  const loadGlobalPause = useCallback(async () => {
    if (!activeInstance || activeInstance === "__all__") {
      setGlobalPaused(false);
      setGlobalPausedUntil(null);
      return;
    }
    try {
      const res = await fetch("/api/agent/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "global_check", instanceName: activeInstance }),
      });
      const data = await res.json();
      setGlobalPaused(!!data.paused);
      setGlobalPausedUntil(data.until || null);
    } catch {}
  }, [activeInstance]);

  const toggleGlobalPause = async (durationMinutes?: number) => {
    if (!activeInstance || activeInstance === "__all__") {
      alert("Selecione uma instância específica antes de pausar a IA. A pausa agora é por instância — não afeta as outras.");
      return;
    }
    const action = globalPaused ? "global_resume" : "global_pause";
    try {
      const res = await fetch("/api/agent/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, durationMinutes, instanceName: activeInstance }),
      });
      const data = await res.json();
      if (data.success) {
        setGlobalPaused(!!data.paused);
        setGlobalPausedUntil(data.until || null);
      }
    } catch (e: any) {
      alert("Erro: " + e.message);
    }
  };

  // Auto-pausa por digitação: dispara 1x quando o operador começa a digitar (30min snooze)
  const fireTypingPause = useCallback(async (jid: string, inst: string) => {
    const key = `${inst}|${jid}`;
    if (typingPauseFiredRef.current === key) return;
    typingPauseFiredRef.current = key;
    try {
      const res = await fetch("/api/agent/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "snooze", remoteJid: jid, instanceName: inst, durationMinutes: TYPING_PAUSE_MINUTES }),
      });
      const data = await res.json();
      if (data.success) {
        setIsAiPaused(true);
        setResumeAt(data.resume_at || null);
      }
    } catch {}
  }, []);

  // Reset do flag quando muda de conversa
  useEffect(() => { typingPauseFiredRef.current = null; }, [selectedSession]);

  useEffect(() => { loadGlobalPause(); }, [loadGlobalPause]);

  // Efeito p/ Countdown do Snooze
  useEffect(() => {
    if (!resumeAt) {
      setCountdown(null);
      return;
    }
    const interval = setInterval(() => {
      const now = new Date().getTime();
      const target = new Date(resumeAt).getTime();
      const diff = target - now;

      if (diff <= 0) {
        setCountdown(null);
        setResumeAt(null);
        setIsAiPaused(false);
        checkAiControl(selectedSession || "", activeInstance);
        clearInterval(interval);
      } else {
        const mins = Math.floor(diff / 60000);
        const secs = Math.floor((diff % 60000) / 1000);
        setCountdown(`${mins}:${secs.toString().padStart(2, '0')}`);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [resumeAt, selectedSession, activeInstance, checkAiControl]);

  const toggleAiPause = async () => {
    if (!selectedSession || !activeInstance) return;
    const action = isAiPaused ? "resume" : "pause";
    try {
       const res = await fetch("/api/agent/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, remoteJid: selectedSession, instanceName: activeInstance }),
       });
       if (res.ok) {
          setIsAiPaused(!isAiPaused);
          if (isAiPaused) setIsAiBlockedTemporal(false);
       }
    } catch (err) {
       alert("Erro ao alternar modo da IA");
    }
  };

  useEffect(() => {
    if (aiTtlRemaining > 0) {
      const timer = setInterval(() => {
        setAiTtlRemaining(prev => {
          if (prev <= 1) {
            setIsAiBlockedTemporal(false);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [aiTtlRemaining]);

  // Persistir instância selecionada
  useEffect(() => {
    if (activeInstance) {
      localStorage.setItem('sdr_active_instance', activeInstance);
    }
  }, [activeInstance]);

  const checkWsStatus = useCallback(async () => {
    if (!activeInstance) return;
    try {
      const res = await fetch("/api/whatsapp?t=" + Date.now() + "&instance=" + activeInstance, { cache: 'no-store' });
      const data = await res.json();
      setWsStatus(data.state || data.instance?.state || "close");
    } catch {
      setWsStatus("close");
    }
  }, [activeInstance]);

  // Carregar instâncias disponíveis — mostra TODAS que têm mensagens registradas
  // OU que existem na Evolution. Cada uma vem com a contagem de conversas únicas
  // (msgCount), então o user vê de cara qual instância tem volume.
  useEffect(() => {
    async function fetchInstances() {
      try {
        const [evoRes, dbRes] = await Promise.all([
          fetch("/api/whatsapp?instances=true").then(r => r.json()).catch(() => ({ instances: [] })),
          // Busca instance_name + remote_jid pra contar conversas únicas por instância.
          supabase.from("chats_dashboard").select("instance_name, remote_jid").limit(20000),
        ]);

        // Mapa: instance_name → Set de remote_jids únicos (= número de conversas)
        const conversasPorInstancia = new Map<string, Set<string>>();
        for (const row of (dbRes.data || [])) {
          const inst = row.instance_name as string;
          const rj = row.remote_jid as string;
          if (!inst || !rj) continue;
          if (!conversasPorInstancia.has(inst)) conversasPorInstancia.set(inst, new Set());
          conversasPorInstancia.get(inst)!.add(rj);
        }

        const evoInstances = evoRes.instances || [];
        const evoNames = new Set(evoInstances.map((i: any) => i.instanceName));

        // 1) Começa com TODAS da Evolution (mesmo zeradas) — assim user pode escolher
        //    a instância nova (que ele acabou de criar) sem ter que mandar msg primeiro.
        const merged: any[] = evoInstances.map((i: any) => ({
          ...i,
          msgCount: conversasPorInstancia.get(i.instanceName)?.size || 0,
          offline: false,
        }));

        // 2) Adiciona instâncias órfãs (têm msgs no DB mas sumiram da Evolution).
        for (const [name, set] of conversasPorInstancia) {
          if (!evoNames.has(name)) {
            merged.push({
              instanceName: name,
              profileName: `${name} (offline)`,
              status: "unknown",
              msgCount: set.size,
              offline: true,
            });
          }
        }

        // Ordena: mais conversas primeiro, depois online > offline, depois alfabética.
        merged.sort((a, b) => {
          if (b.msgCount !== a.msgCount) return b.msgCount - a.msgCount;
          if (!!a.offline !== !!b.offline) return a.offline ? 1 : -1;
          return String(a.instanceName).localeCompare(String(b.instanceName));
        });

        setInstances(merged);

        // Se a instância atualmente selecionada não está na lista, troca pela
        // primeira COM mensagens (ou primeira da lista).
        if (merged.length > 0 && activeInstance !== "__all__" && !merged.some(i => i.instanceName === activeInstance)) {
          const fallback = merged.find(i => i.msgCount > 0) || merged[0];
          setActiveInstance(fallback?.instanceName || "sdr");
        }
      } catch (err) {
        console.error("Erro ao carregar instâncias:", err);
      }
    }
    fetchInstances();
  }, [activeInstance]);

  const loadConversations = useCallback(async () => {
    if (!activeInstance) return;
    try {
      const isAll = activeInstance === "__all__";
      const baseQuery = supabase.from("chats_dashboard").select("*").order("id", { ascending: false }).limit(400);
      const { data: messages, error } = isAll
        ? await baseQuery
        : await baseQuery.eq("instance_name", activeInstance);

      if (error) {
        console.error("[CHAT-ERROR] Erro ao carregar conversas:", error);
        return;
      }
      
      console.log(`[CHAT-LOG] Encontradas ${messages?.length || 0} mensagens para a instância ${activeInstance}`);
      if (!messages || messages.length === 0) {
        setConversations([]);
        return;
      }

      const convMap = new Map<string, Conversation>();
      for (const m of messages) {
        if (!convMap.has(m.remote_jid)) {
          let preview = m.content?.slice(0, 80) || "";
          if (!preview && m.media_type) {
            if (m.media_type === "image") preview = "📷 Imagem";
            else if (m.media_type === "audio") preview = "🎤 Áudio";
            else if (m.media_type === "video") preview = "🎥 Vídeo";
            else if (m.media_type === "document") preview = "📄 Arquivo";
          }
          
          convMap.set(m.remote_jid, {
            remote_jid: m.remote_jid,
            lastMessage: preview || "[Sem conteúdo]",
            messageCount: 1,
            lastTime: m.created_at,
          });
        } else {
          convMap.get(m.remote_jid)!.messageCount++;
        }
      }

      const jids = Array.from(convMap.keys());
      if (jids.length > 0) {
        // 1) Nome do negócio dos leads_extraidos
        const { data: leads } = await supabase
          .from("leads_extraidos")
          .select("remoteJid, nome_negocio")
          .in("remoteJid", jids);
        if (leads) {
          for (const lead of leads) {
            const conv = convMap.get(lead.remoteJid);
            if (conv) conv.nome_negocio = lead.nome_negocio;
          }
        }

        // 2) Foto de perfil do WhatsApp — lê do cache em contacts.profile_pic_url.
        //    O cache é populado por /api/contacts/avatars (chamado abaixo)
        //    OU pelo webhook quando recebe pushName + profilePic.
        const { data: contactsData } = await supabase
          .from("contacts")
          .select("remote_jid, profile_pic_url")
          .in("remote_jid", jids);
        if (contactsData) {
          for (const c of contactsData) {
            const conv = convMap.get(c.remote_jid);
            if (conv) conv.avatarUrl = c.profile_pic_url || null;
          }
        }
      }

      setConversations(Array.from(convMap.values()));

      // 3) Dispara fetch de avatars que estejam faltando — em background, sem
      //    bloquear o render. /api/contacts/avatars busca da Evolution e salva
      //    no cache pra próxima vez. Realtime no contacts atualiza o estado.
      //    Limita a 50 por chamada pra não estourar a Evolution.
      const missing = jids.filter(j => {
        const c = convMap.get(j);
        return c && (c.avatarUrl === undefined || c.avatarUrl === null);
      }).slice(0, 50);
      if (missing.length > 0 && activeInstance && activeInstance !== "__all__") {
        fetch("/api/contacts/avatars", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jids: missing, instance: activeInstance }),
        })
          .then(r => r.json())
          .then(d => {
            if (d?.success && d.avatars) {
              setConversations(prev => prev.map(c => {
                const fresh = d.avatars[c.remote_jid];
                if (fresh !== undefined) return { ...c, avatarUrl: fresh };
                return c;
              }));
            }
          })
          .catch(() => {});
      }
    } catch (err) {
      console.error("Erro ao carregar conversas:", err);
    } finally {
      setLoadingConvs(false);
    }
  // IMPORTANTE: activeInstance precisa estar nas deps. Sem isso, o useCallback
  // memoiza a função no primeiro render com o activeInstance INICIAL, e quando
  // o usuário troca de instância no dropdown, o filtro continua aplicando o
  // valor antigo — efeito visível: "selecionei a instância X mas vejo conversas
  // de Y também". Bug ressuscitava sempre que ativava polling de 15s.
  }, [activeInstance]);

  const loadMessages = useCallback(async (sessionId: string) => {
    if (!activeInstance) return;
    try {
      const isAll = activeInstance === "__all__";
      const base = supabase.from("chats_dashboard").select("*").eq("remote_jid", sessionId)
        .order("created_at", { ascending: false }).order("id", { ascending: false }).limit(100);
      const { data, error } = isAll ? await base : await base.eq("instance_name", activeInstance);
      
      const rawMsgs = data || [];
      
      // Smart Sort: Resolve problemas de "corrida" onde a resposta da IA é salva milissegundos antes do gatilho
      const newMsgs = [...rawMsgs].sort((a, b) => {
        const timeA = new Date(a.created_at).getTime();
        const timeB = new Date(b.created_at).getTime();
        const diff = timeA - timeB;

        // Se a diferença for significativa (> 7s), respeita o tempo real estritamente
        if (Math.abs(diff) > 7000) return diff;

        // Se mensagens forem quase simultâneas (< 7s), garante a lógica: Cliente -> Humano -> IA
        const priority: Record<string, number> = { customer: 1, human: 2, ai: 3 };
        const pA = priority[a.sender_type] || 2;
        const pB = priority[b.sender_type] || 2;

        if (pA !== pB) return pA - pB;

        // Empate técnico total: usa o ID como desempate final
        return a.id - b.id;
      });
      
      // Estabilização: Só atualiza se o conteúdo for diferente
      setMessages(prev => {
        if (prev.length === newMsgs.length && 
            prev[prev.length - 1]?.id === newMsgs[newMsgs.length - 1]?.id &&
            prev[prev.length - 1]?.status_envio === newMsgs[newMsgs.length - 1]?.status_envio) {
          return prev;
        }
        return newMsgs;
      });
    } catch (err) {
      console.error("Erro ao carregar mensagens:", err);
    } finally {
      setLoadingMsgs(false);
    }
  // Mesmo motivo de loadConversations: deps vazias travavam o filtro de
  // instância no valor inicial. activeInstance + setMessages (estável) bastam.
  }, [activeInstance]);


  useEffect(() => {
    let active = true;
    const poll = async () => {
        if (!active || !activeInstance) return;
        try {
          await Promise.all([
             loadConversations(),
             checkWsStatus()
          ]);
        } finally {
          if (active) setTimeout(poll, 15000);
        }
    };
    if (activeInstance) poll();
    return () => { active = false; };
  }, [loadConversations, checkWsStatus, activeInstance]);

  // Deep-link: /chat?session=<remoteJid>&instance=<name> abre direto na conversa.
  // Usado pelo botão "Abrir chat interno" do kanban (/leads). Roda 1x quando
  // conversations carregaram, descobre a instância correta do JID e seleciona
  // a sessão automaticamente. Se a instância passada na URL diferir da ativa,
  // troca pra ela primeiro.
  const deepLinkAppliedRef = useRef(false);
  useEffect(() => {
    if (deepLinkAppliedRef.current) return;
    if (typeof window === "undefined") return;
    if (loadingConvs || conversations.length === 0) return;

    const params = new URLSearchParams(window.location.search);
    const wantedJid = params.get("session");
    const wantedInstance = params.get("instance");
    if (!wantedJid) return;

    // Se especificou instância na URL e é diferente da ativa, troca primeiro.
    // O efeito vai re-rodar depois com a instância correta.
    if (wantedInstance && wantedInstance !== activeInstance && wantedInstance !== "__all__") {
      setActiveInstance(wantedInstance);
      return;
    }

    // Procura a conversa na lista. Se não estiver (instância errada), abre __all__.
    const found = conversations.find(c => c.remote_jid === wantedJid);
    if (found) {
      setSelectedSession(wantedJid);
      deepLinkAppliedRef.current = true;
    } else if (activeInstance !== "__all__") {
      // Não achou no filtro atual — tenta vista "Todas" pra descobrir onde está.
      setActiveInstance("__all__");
    } else {
      // Já tava em __all__ e mesmo assim não achou — desiste mas não fica em loop.
      deepLinkAppliedRef.current = true;
    }
  }, [conversations, loadingConvs, activeInstance]);

  useEffect(() => {
    if (!selectedSession || !activeInstance) return;
    setMessages([]);
    setLoadingMsgs(true);
    loadMessages(selectedSession);
    checkAiControl(selectedSession, activeInstance);
    checkWsStatus();

    const loadFunnelData = async () => {
        try {
            const { data: channelData } = await supabase.from("channel_connections").select("agent_id").eq("instance_name", activeInstance).maybeSingle();
            const agentId = channelData?.agent_id;
            
            if (agentId) {
                const { data: stageData } = await supabase.from("agent_stages").select("*").eq("agent_id", agentId).order("order_index", { ascending: true });
                setStages(stageData || []);
            } else {
                setStages([]);
            }

            const { data: contactData } = await supabase.from("contacts").select("id").eq("remote_jid", selectedSession).maybeSingle();
            if (contactData) {
                const { data: sessData } = await supabase.from("sessions").select("id, current_stage_id, variables").eq("contact_id", contactData.id).eq("instance_name", activeInstance).maybeSingle();
                if (sessData) {
                    setCurrentStageId(sessData.current_stage_id);
                    setSessionVariables(sessData.variables || {});
                } else {
                    setCurrentStageId(null);
                    setSessionVariables({});
                }
            }
        } catch (err) {
            console.error("Erro ao carregar dados do funil:", err);
        }
    };
    loadFunnelData();
  }, [selectedSession, activeInstance, loadMessages, checkAiControl, checkWsStatus]);

  useEffect(() => {
    if (selectedSession) {
        const conv = conversations.find(c => c.remote_jid === selectedSession);
        setLeadName(conv?.nome_negocio || formatPhone(selectedSession));
    }
  }, [selectedSession, conversations]);

  useEffect(() => {
    // Subscription única em chats_dashboard com filtro estrito por contato + instância.
    // (A V2 messages não tem remote_jid, então a sub global vazava msgs de outros contatos
    //  no chat aberto e travava o scroll.)
    const channel = supabase
      .channel(`chat-updates-${selectedSession || "none"}-${activeInstance || "none"}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "chats_dashboard" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const newMsg = payload.new as ChatMessage;
            const matchesInstance = activeInstance === "__all__" || newMsg.instance_name === activeInstance;
            if (newMsg.remote_jid === selectedSession && matchesInstance) {
              setMessages((prev) => {
                if (prev.some(m => m.id === newMsg.id || (m.message_id && m.message_id === newMsg.message_id))) return prev;
                return [...prev, newMsg].sort((a, b) => {
                  const ta = new Date(a.created_at).getTime();
                  const tb = new Date(b.created_at).getTime();
                  if (ta !== tb) return ta - tb;
                  return a.id - b.id;
                });
              });
            }
            loadConversations();
          } else if (payload.eventType === "UPDATE") {
            const updatedMsg = payload.new as ChatMessage;
            setMessages((prev) =>
              prev.map(msg => msg.id === updatedMsg.id ? { ...msg, ...updatedMsg } : msg)
            );
          }
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [selectedSession, activeInstance, loadConversations]);

  const lastMsgIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (messages.length === 0) return;
    const lastMsg = messages[messages.length - 1];
    if (lastMsgIdRef.current === lastMsg.id) return;

    const wasNew = lastMsgIdRef.current !== null;
    lastMsgIdRef.current = lastMsg.id;

    // Só auto-rola se o usuário JÁ estava perto do fim (ou se é a primeira carga)
    const scrollEl = messagesEndRef.current?.parentElement?.parentElement as HTMLElement | null;
    if (!scrollEl) return;
    const distToBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight;
    const shouldScroll = !wasNew || distToBottom < 200;
    if (!shouldScroll) return;

    const timer = setTimeout(() => {
      messagesEndRef.current?.scrollIntoView({ behavior: wasNew ? "smooth" : "auto", block: "end" });
    }, 50);
    return () => clearTimeout(timer);
  }, [messages]);

  // Reset do tracker ao trocar de conversa (pra primeira msg da nova conversa rolar)
  useEffect(() => { lastMsgIdRef.current = null; }, [selectedSession]);

  // --- AUDIO RECORDING LOGIC ---
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];

      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: "audio/ogg; codecs=opus" });
        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = () => {
          const base64 = (reader.result as string).split(",")[1];
          handleSend(undefined, { type: "audio", base64, mimetype: "audio/ogg; codecs=opus" });
        };
        stream.getTracks().forEach(track => track.stop());
      };

      recorder.start();
      setMediaRecorder(recorder);
      setIsRecording(true);
      setRecordingTime(0);
      recorderIntervalRef.current = setInterval(() => setRecordingTime(t => t + 1), 1000);
    } catch (err) {
      console.error("Erro ao acessar microfone:", err);
      alert("Não foi possível acessar o microfone.");
    }
  };

  const stopRecording = (cancel = false) => {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      if (cancel) {
        mediaRecorder.onstop = () => {
          mediaRecorder.stream.getTracks().forEach(t => t.stop());
        };
      }
      mediaRecorder.stop();
    }
    setIsRecording(false);
    if (recorderIntervalRef.current) clearInterval(recorderIntervalRef.current);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = (reader.result as string).split(",")[1];
      const type = file.type.startsWith("image/") ? "image" : "document";
      handleSend(undefined, { 
        type: type as any, 
        base64, 
        fileName: file.name,
        mimetype: file.type 
      });
    };
    reader.readAsDataURL(file);
    e.target.value = ""; // Reset
  };

  async function handleSaveLead() {
    if (!selectedSession || !leadName.trim()) return;
    setSavingLead(true);
    try {
      const res = await fetch("/api/leads/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remoteJid: selectedSession, nome_negocio: leadName, status: leadStatus }),
      });
      if (res.ok) {
        setShowLeadModal(false);
        loadConversations();
      }
    } catch (err: any) {
      alert(err.message);
    } finally {
      setSavingLead(false);
    }
  }

  async function handleSend(customText?: string, media?: { type: "image" | "audio" | "document", base64: string, fileName?: string, mimetype?: string }) {
    const msgToUser = customText || inputMessage;
    if (!selectedSession || (!msgToUser.trim() && !media) || sending) return;
    
    // ATUALIZAÇÃO OTIMISTA: Adiciona msg na lista imediatamente
    const tempId = Date.now();
    const optimisticMsg: ChatMessage = {
      id: tempId,
      message_id: `temp-${tempId}`,
      content: msgToUser,
      sender: 'human',
      sender_type: 'human',
      delivery_status: 'pending',
      media_category: (media?.type as any) || 'text',
      media_type: media?.type,
      mimetype: media?.mimetype || (media?.type === "audio" ? "audio/ogg; codecs=opus" : undefined),
      base64_content: media?.base64,
      file_name: media?.fileName,
      created_at: new Date().toISOString(),
      instance_name: activeInstance
    };
    
    setMessages(prev => [...prev, optimisticMsg]);
    if (!media) setInputMessage("");
    setSending(true);

    try {
      const res = await fetch("/api/send-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remoteJid: selectedSession,
          text: msgToUser,
          media,
          instanceName: activeInstance,
        }),
      });

      const data = await res.json();
      if (!data.success) throw new Error(data.error);

      // Troca o message_id "temp-..." pelo real pra evitar duplicata quando o
      // INSERT em realtime chegar (a dedup em chats_dashboard subscription
      // compara message_id).
      if (data.msgId) {
        setMessages(prev => prev.map(m => m.id === tempId
          ? { ...m, message_id: data.msgId, delivery_status: 'sent' }
          : m
        ));
      }

      // Atualiza estado da IA — auto-pause já foi disparado ao começar a digitar
      if (selectedSession && activeInstance) checkAiControl(selectedSession, activeInstance);

    } catch (err: any) {
      console.error("Erro ao enviar:", err);
      // Marcar erro na msg otimista (ficará até o reload trazer a versão persistida do DB)
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, delivery_status: 'error' } : m));

      // Recarrega do DB — o backend agora salva mesmo em falha de envio,
      // então a msg persistida substitui a otimista e NÃO some em reload/troca de aba.
      if (selectedSession) loadMessages(selectedSession);

      // Detecta o erro mais comum (Evolution offline / instância desconectada) e avisa
      const msg = String(err?.message || "");
      const isEvolutionOffline = /evolution api offline|service is not reachable|enotfound|econnrefused/i.test(msg);
      const isConnectionClosed = /connection closed|not connected|connection state/i.test(msg);

      if (isEvolutionOffline) {
        alert(
          `A Evolution API (o servidor que conversa com o WhatsApp) está OFFLINE.\n\n` +
          `Sua mensagem foi salva no histórico com status "erro", mas não saiu.\n\n` +
          `Provavelmente o container parou no Easypanel. Vai lá e reinicia o serviço.`
        );
      } else if (isConnectionClosed) {
        setWsStatus("close");
        alert(
          `A instância "${activeInstance}" está DESCONECTADA do WhatsApp.\n\n` +
          `Sua mensagem foi salva no histórico com status "erro", mas não saiu.\n\n` +
          `Vai em WhatsApp no menu lateral e escaneia o QR de novo.`
        );
      } else {
        alert(`Falha ao enviar (mensagem salva como erro no histórico):\n${msg || "erro desconhecido"}`);
      }
    } finally {
      setSending(false);
    }
  }

  async function toggleAi(action: "pause" | "resume" | "snooze", durationMinutes?: number) {
    if (!selectedSession || !activeInstance) return;
    try {
      const res = await fetch("/api/agent/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          action, 
          remoteJid: selectedSession, 
          instanceName: activeInstance,
          durationMinutes 
        }),
      });
      const data = await res.json();
      if (data.success) {
        setIsAiPaused(data.bot_status !== 'bot_active');
        setResumeAt(data.resume_at || null);
        checkAiControl(selectedSession, activeInstance);
      }
    } catch (err) {
      console.error("Erro ao controlar IA:", err);
    }
  }

  function formatPhone(jid: string) {
    const num = jid?.replace("@s.whatsapp.net", "") || "";
    if (num.length === 13) return `(${num.slice(2, 4)}) ${num.slice(4, 9)}-${num.slice(9)}`;
    return num;
  }

  const filteredConvs = conversations.filter((c) => {
    if (!searchConv) return true;
    const s = searchConv.toLowerCase();
    return c.remote_jid.includes(s) || (c.nome_negocio || "").toLowerCase().includes(s);
  });

  const [clearingMemory, setClearingMemory] = useState(false);

  async function handleClearMemory() {
    if (!selectedSession || !activeInstance) return;
    if (!confirm("Deseja realmente limpar a memória da IA para este contato? Ela esquecerá todo o contexto anterior e começará do zero.")) return;
    
    setClearingMemory(true);
    try {
      const res = await fetch("/api/agent/clear-memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ remoteJid: selectedSession, instanceName: activeInstance }),
      });
      
      if (res.ok) {
        alert("Memória da IA limpa com sucesso!");
        setCurrentStageId(null);
        setSessionVariables({});
        loadMessages(selectedSession); // Recarregar para atualizar a tela
      } else {
        const data = await res.json();
        alert("Erro ao limpar memória: " + data.error);
      }
    } catch (err: any) {
      alert("Erro fatal: " + err.message);
    } finally {
      setClearingMemory(false);
    }
  }

  // Toggle body class to hide bottom nav when chat conversation is open on mobile
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    if (selectedSession) {
      html.classList.add('chat-active');
      body.classList.add('chat-active');
    } else {
      html.classList.remove('chat-active');
      body.classList.remove('chat-active');
    }
    return () => {
      html.classList.remove('chat-active');
      body.classList.remove('chat-active');
    };
  }, [selectedSession]);

  return (
    <div className="flex flex-col h-[100dvh] max-h-[100dvh] bg-background overflow-hidden selection:bg-primary/30">
      <Header />
      <div className="flex-1 flex overflow-hidden">
        
        {/* Sidebar - Modern Glass Sidebar — hidden on mobile when a chat is selected */}
        <aside className={cn(
          "glass border-r border-white/5 flex flex-col shrink-0 z-20 min-h-0",
          "w-full md:w-80 lg:w-96",
          selectedSession ? "hidden md:flex" : "flex"
        )}>
          <div className="p-3 md:p-6 space-y-3 md:space-y-4">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-primary animate-pulse" />
                    <span className="text-[10px] font-black uppercase tracking-[0.2em] text-muted-foreground">Conversas</span>
                </div>
                {wsStatus === "open" ? (
                    <Badge className="bg-green-500/10 text-green-400 border-green-500/20 text-[10px] gap-1.5 px-2 py-0.5">
                        <div className="w-1.5 h-1.5 rounded-full bg-green-500 status-online" /> Online
                    </Badge>
                ) : (
                    <Badge variant="destructive" className="bg-red-500/10 text-red-400 border-red-500/20 text-[10px] gap-1.5 px-2 py-0.5">
                        <WifiOff className="w-3 h-3" /> Offline
                    </Badge>
                )}
            </div>

            {/* Pausa da IA — agora POR INSTÂNCIA. Afeta só a instância selecionada
                no dropdown acima (não silencia outras instâncias). Em modo
                "Todas as instâncias" o controle fica desabilitado e o user é
                guiado a escolher uma específica. */}
            <div className={cn(
              "p-3 rounded-2xl border transition-all",
              activeInstance === "__all__" ? "bg-white/[0.03] border-white/5 opacity-70" :
              globalPaused ? "bg-red-500/10 border-red-500/30" : "bg-white/5 border-white/5"
            )}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 min-w-0">
                  <ShieldOff className={cn("w-4 h-4 shrink-0", globalPaused ? "text-red-400" : "text-muted-foreground")} />
                  <div className="min-w-0">
                    <p className={cn("text-[10px] font-black uppercase tracking-widest truncate", globalPaused ? "text-red-400" : "text-foreground")}>
                      {activeInstance === "__all__"
                        ? "Selecione uma instância"
                        : globalPaused
                          ? `IA pausada em #${activeInstance}`
                          : `IA ativa em #${activeInstance}`}
                    </p>
                    {activeInstance === "__all__" ? (
                      <p className="text-[9px] text-muted-foreground/80 truncate">a pausa é por instância</p>
                    ) : globalPaused && globalPausedUntil ? (
                      <p className="text-[9px] text-red-300/80 truncate">até {new Date(globalPausedUntil).toLocaleString("pt-BR")}</p>
                    ) : globalPaused ? (
                      <p className="text-[9px] text-red-300/80 truncate">indefinidamente · só esta instância</p>
                    ) : (
                      <p className="text-[9px] text-muted-foreground/80 truncate">outras instâncias não são afetadas</p>
                    )}
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  {activeInstance === "__all__" ? (
                    <Button size="sm" variant="ghost" disabled className="h-7 px-2 text-[9px] font-black uppercase text-muted-foreground">
                      Pausar
                    </Button>
                  ) : globalPaused ? (
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-[9px] font-black uppercase text-green-400 hover:bg-green-500/10" onClick={() => toggleGlobalPause()}>
                      <Play className="w-3 h-3 mr-1" /> Ativar
                    </Button>
                  ) : (
                    <Select onValueChange={(v) => { if (v as string === "forever") toggleGlobalPause(); else toggleGlobalPause(Number(v)); }}>
                      <SelectTrigger className="h-7 w-24 bg-transparent border-red-500/30 text-red-400 text-[9px] font-black uppercase rounded-lg shadow-none focus:ring-0">
                        <SelectValue placeholder="Pausar" />
                      </SelectTrigger>
                      <SelectContent className="glass-card border-white/10">
                        <SelectItem value="15" className="text-[10px] font-bold">15 min</SelectItem>
                        <SelectItem value="60" className="text-[10px] font-bold">1 hora</SelectItem>
                        <SelectItem value="240" className="text-[10px] font-bold">4 horas</SelectItem>
                        <SelectItem value="forever" className="text-[10px] font-bold">Indefinido</SelectItem>
                      </SelectContent>
                    </Select>
                  )}
                </div>
              </div>
            </div>

            {/* Organizador IA — análise diária + agendamento */}
            <button
              type="button"
              onClick={() => setOrgOpen(true)}
              className={cn(
                "w-full p-3 rounded-2xl border transition-all text-left flex items-center justify-between gap-3",
                orgEnabled
                  ? "bg-primary/10 border-primary/30 hover:bg-primary/15"
                  : "bg-white/5 border-white/5 hover:bg-white/10"
              )}
            >
              <div className="flex items-center gap-2 min-w-0">
                <BrainCircuit className={cn("w-4 h-4 shrink-0", orgEnabled ? "text-primary" : "text-muted-foreground")} />
                <div className="min-w-0">
                  <p className={cn("text-[10px] font-black uppercase tracking-widest truncate", orgEnabled ? "text-primary" : "text-foreground")}>
                    Organizador IA
                  </p>
                  <p className="text-[9px] truncate text-muted-foreground">
                    {orgEnabled
                      ? `Auto todo dia às ${String(orgHour).padStart(2, "0")}h`
                      : "Desativado — clique para configurar"}
                  </p>
                </div>
              </div>
              <Settings className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
            </button>

            <div className="relative">
              <Select value={activeInstance} onValueChange={(val: any) => { if (val) { setActiveInstance(val); setSelectedSession(null as any); }}}>
                  <SelectTrigger className="w-full bg-white/5 border-white/10 rounded-xl h-10 md:h-11 text-xs font-bold text-foreground focus:ring-primary/40 focus:bg-white/10 transition-all">
                      <SelectValue placeholder="Selecione a instância" />
                  </SelectTrigger>
                  <SelectContent className="glass-card border-white/10 rounded-[1.5rem] overflow-hidden">
                      <SelectItem value="__all__" className="text-xs font-bold">
                        <span className="flex items-center gap-2">
                          📂 Todas as instâncias
                          <span className="text-[9px] font-mono text-muted-foreground bg-white/5 px-1.5 py-0.5 rounded">
                            {instances.reduce((acc, i) => acc + (i.msgCount || 0), 0)}
                          </span>
                        </span>
                      </SelectItem>
                      {instances.length === 0 ? (
                        <SelectItem value="loading" disabled>Carregando instâncias...</SelectItem>
                      ) : (
                        instances.map((inst, i) => (
                          <SelectItem key={`${inst.instanceName}-${i}`} value={inst.instanceName} className="text-xs font-bold">
                            <span className="flex items-center gap-2 w-full">
                              <span className={cn(
                                "w-1.5 h-1.5 rounded-full shrink-0",
                                inst.offline ? "bg-red-500" :
                                inst.status === "open" ? "bg-emerald-500" :
                                inst.status === "connecting" ? "bg-yellow-500" : "bg-zinc-500"
                              )} />
                              <span className="truncate">{inst.profileName || inst.instanceName}</span>
                              <span className={cn(
                                "ml-auto text-[9px] font-mono px-1.5 py-0.5 rounded",
                                inst.msgCount > 0 ? "text-cyan-200 bg-cyan-500/10" : "text-muted-foreground bg-white/5"
                              )}>
                                {inst.msgCount}
                              </span>
                            </span>
                          </SelectItem>
                        ))
                      )}
                  </SelectContent>
              </Select>
            </div>

            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
              <Input
                placeholder="Buscar lead ou telefone..."
                value={searchConv}
                onChange={(e) => setSearchConv(e.target.value)}
                className="pl-10 h-10 md:h-11 text-sm bg-white/5 border-white/10 rounded-xl focus:ring-primary/40 focus:bg-white/10 transition-all font-medium"
              />
            </div>
          </div>
          
          <div className="flex-1 overflow-y-auto px-3 custom-scrollbar min-h-0">
            {loadingConvs ? (
              <div className="p-4 space-y-4">
                {[...Array(8)].map((_, i) => <div key={i} className="h-16 w-full rounded-2xl bg-white/5 animate-pulse" />)}
              </div>
            ) : filteredConvs.length === 0 ? (
              <div className="p-10 text-center space-y-3">
                <MessageSquare className="w-10 h-10 mx-auto text-muted-foreground/10" />
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-widest">Nenhuma conversa</p>
              </div>
            ) : (
              <div className="space-y-1 pb-6 lg:pb-6" style={{ paddingBottom: 'calc(var(--bottom-nav-height) + var(--safe-bottom) + 16px)' }}>
                {filteredConvs.map((conv) => (
                    <button
                        key={conv.remote_jid}
                        onClick={() => setSelectedSession(conv.remote_jid)}
                        className={cn(
                            "w-full text-left p-3 md:p-4 flex items-center gap-3 md:gap-4 rounded-2xl transition-all duration-300 group border border-transparent mb-1",
                            "min-h-[56px]",
                            selectedSession === conv.remote_jid 
                              ? "bg-primary/15 border-primary/20 shadow-lg shadow-primary/5" 
                              : "hover:bg-white/5 active:scale-[0.98]"
                        )}
                    >
                        <div className={cn(
                            "w-12 h-12 rounded-full flex items-center justify-center shrink-0 transition-all duration-300 overflow-hidden",
                            selectedSession === conv.remote_jid
                              ? "bg-primary text-primary-foreground rotate-2 shadow-xl shadow-primary/40 scale-110"
                              : "bg-white/5 border border-white/10 group-hover:bg-white/10"
                        )}>
                            {conv.avatarUrl ? (
                              // Foto WhatsApp. onError = URL expirou (Evolution assina TTL ~7d) → cai pro ícone.
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={conv.avatarUrl}
                                alt=""
                                referrerPolicy="no-referrer"
                                className="w-full h-full object-cover"
                                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                              />
                            ) : (
                              <User className="w-6 h-6" />
                            )}
                        </div>
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between mb-1">
                                <p className={cn(
                                  "text-sm font-bold truncate transition-colors",
                                  selectedSession === conv.remote_jid ? "text-primary-foreground" : "text-foreground group-hover:text-primary"
                                )}>
                                    {conv.nome_negocio || formatPhone(conv.remote_jid)}
                                </p>
                                <span className="text-[9px] font-mono text-muted-foreground/60 shrink-0">
                                    {conv.lastTime ? formatRelativeTime(conv.lastTime) : ""}
                                </span>
                            </div>
                            <p className="text-[11px] text-muted-foreground truncate line-clamp-1 opacity-70 italic group-hover:opacity-100 transition-opacity">
                              {conv.lastMessage || "Sem mensagens"}
                            </p>
                            {/* Pill da instância — só aparece em "Todas as instâncias", pra
                                deixar óbvio de qual canal cada conversa veio. */}
                            {activeInstance === "__all__" && conv.instance_name && (
                              <span className="inline-flex items-center gap-1 mt-1 text-[9px] font-mono px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-200 border border-cyan-500/20">
                                #{conv.instance_name}
                              </span>
                            )}
                        </div>
                    </button>
                ))}
              </div>
            )}
          </div>
        </aside>

        {/* Chat Main Area - Premium Glass View */}
        <main className={cn(
          "flex-1 flex flex-col bg-transparent relative min-w-0",
          selectedSession ? "flex" : "hidden md:flex"
        )}>
          {!selectedSession ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-10 animate-fade-in">
              <div className="w-24 h-24 rounded-[2.5rem] bg-gradient-to-br from-primary/10 to-purple-500/10 flex items-center justify-center mb-6 border border-white/5 animate-float shadow-2xl shadow-primary/5">
                <MessageSquare className="w-10 h-10 text-primary animate-pulse-slow" />
              </div>
              <h3 className="text-2xl font-black tracking-tighter text-gradient mb-2">Selecione uma Conversa</h3>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto font-medium">
                Seus leads captados aparecerão aqui. Selecione um para gerenciar o atendimento AI ou assumir o controle manual.
              </p>
            </div>
          ) : (
            <>
              {/* Banner GORDO quando a instância selecionada está desconectada */}
              {activeInstance !== "__all__" && wsStatus === "close" && (
                <div className="bg-red-500/15 border-b border-red-500/30 px-8 py-3 flex items-center justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <ShieldOff className="w-5 h-5 text-red-400 shrink-0" />
                    <div>
                      <p className="text-[13px] font-black text-red-200">
                        Instância "{activeInstance}" desconectada do WhatsApp
                      </p>
                      <p className="text-[11px] text-red-300/80">
                        Nenhuma mensagem entra nem sai enquanto estiver assim. Mensagens que o cliente manda NÃO aparecem aqui.
                      </p>
                    </div>
                  </div>
                  <a
                    href="/whatsapp"
                    className="px-4 py-2 rounded-xl bg-red-500 hover:bg-red-600 text-white text-[11px] font-black uppercase tracking-widest transition-colors shrink-0"
                  >
                    Reconectar agora →
                  </a>
                </div>
              )}
              {/* Premium Toolbar */}
              <header className="h-14 md:h-20 px-3 md:px-8 border-b border-white/5 flex items-center justify-between bg-background/40 backdrop-blur-2xl z-30 shrink-0">
                <div className="flex items-center gap-2 md:gap-4 min-w-0">
                  {/* Mobile back button */}
                  <button
                    onClick={() => setSelectedSession(null as any)}
                    className="md:hidden flex items-center justify-center w-9 h-9 rounded-xl bg-white/5 text-muted-foreground active:bg-white/10 shrink-0"
                  >
                    <ChevronLeft className="w-5 h-5" />
                  </button>
                  <div className="w-9 h-9 md:w-11 md:h-11 rounded-full bg-gradient-to-tr from-primary to-indigo-600 flex items-center justify-center text-primary-foreground shrink-0 shadow-xl shadow-primary/20 ring-2 ring-white/10 overflow-hidden">
                    {(() => {
                      const av = conversations.find(c => c.remote_jid === selectedSession)?.avatarUrl;
                      if (av) {
                        return (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img
                            src={av}
                            alt=""
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover"
                            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                          />
                        );
                      }
                      return <User className="w-5 h-5 md:w-6 md:h-6" />;
                    })()}
                  </div>
                  <div className="min-w-0 py-1">
                    <h4 className="text-sm md:text-base font-black tracking-tight truncate leading-tight">
                      {conversations.find((c) => c.remote_jid === selectedSession)?.nome_negocio || formatPhone(selectedSession)}
                    </h4>
                    <div className="flex items-center gap-1.5 md:gap-2 mt-0.5">
                        <span className="text-[9px] md:text-[10px] font-mono font-bold text-muted-foreground/60 bg-white/5 px-1.5 md:px-2 py-0.5 rounded-full hidden sm:inline-flex">{formatPhone(selectedSession)}</span>
                        <div 
                           onClick={() => toggleAi(isAiPaused ? "resume" : "pause")}
                           className="cursor-pointer group"
                           title={isAiPaused ? "IA Pausada para este contato. Clique para Retomar." : "IA Ativa. Clique para pausar (Modo Manual)."}
                        >
                           {isAiPaused ? (
                              <Badge className="h-5 px-1.5 md:px-2 bg-neutral-800 text-neutral-400 text-[7px] md:text-[8px] font-black uppercase tracking-widest border border-white/5 hover:bg-neutral-700 transition-colors">
                                 <ShieldOff className="w-2 h-2 mr-0.5 md:mr-1" /> Manual
                              </Badge>
                           ) : isAiBlockedTemporal ? (
                              <Badge className="h-5 px-1.5 md:px-2 bg-orange-500/10 text-orange-500 text-[7px] md:text-[8px] font-black uppercase tracking-widest border border-orange-500/20 animate-pulse">
                                 <Timer className="w-2 h-2 mr-0.5" /> {aiTtlRemaining > 0 ? `${aiTtlRemaining}s` : "Bloq"}
                              </Badge>
                           ) : (
                              <Badge className="h-5 px-1.5 md:px-2 bg-green-500/10 text-green-500 text-[7px] md:text-[8px] font-black uppercase tracking-widest border-none group-hover:bg-green-500/20 transition-colors">
                                 <Zap className="w-2 h-2 mr-0.5 fill-green-500" /> IA Ativa
                              </Badge>
                           )}
                        </div>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-1 md:gap-2">
                   <div className="hidden md:flex items-center gap-1 overflow-hidden rounded-xl border border-white/5 bg-white/5 p-1 mr-2 shadow-inner">
                      {isAiPaused ? (
                        <Button 
                          size="sm" 
                          variant="ghost" 
                          className="h-8 rounded-lg text-green-500 hover:bg-green-500/10 text-[9px] font-black uppercase px-2 transition-all active:scale-95"
                          onClick={() => toggleAi("resume")}
                        >
                          <Play className="w-3 h-3 mr-1" /> Retomar
                        </Button>
                      ) : (
                        <>
                          <Button 
                            size="sm" 
                            variant="ghost" 
                            className="h-8 rounded-lg text-red-500 hover:bg-red-500/10 text-[9px] font-black uppercase px-2 transition-all active:scale-95"
                            onClick={() => toggleAi("pause")}
                          >
                            <Pause className="w-3 h-3 mr-1" /> Pausar
                          </Button>
                          <div className="w-[1px] h-4 bg-white/10 mx-1" />
                          <Select onValueChange={(val) => toggleAi("snooze", parseInt(val as string))}>
                             <SelectTrigger className="h-8 w-24 border-none bg-transparent hover:bg-white/5 text-[9px] font-black uppercase rounded-lg shadow-none focus:ring-0">
                               <SelectValue placeholder="SNOOZE" />
                             </SelectTrigger>
                             <SelectContent className="glass-card border-white/10 rounded-2xl overflow-hidden shadow-2xl">
                               <SelectItem value="15" className="text-[10px] font-bold">15 MINUTOS</SelectItem>
                               <SelectItem value="60" className="text-[10px] font-bold">1 HORA</SelectItem>
                               <SelectItem value="240" className="text-[10px] font-bold">4 HORAS</SelectItem>
                               <SelectItem value="1440" className="text-[10px] font-bold">24 HORAS</SelectItem>
                             </SelectContent>
                          </Select>
                        </>
                      )}
                   </div>

                  <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 md:h-10 md:w-10 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded-xl transition-all"
                      title="Limpar Memória da IA"
                      disabled={clearingMemory}
                      onClick={handleClearMemory}
                  >
                      {clearingMemory ? <Loader2 className="w-4 h-4 md:w-5 md:h-5 animate-spin" /> : <BrainCircuit className="w-4 h-4 md:w-5 md:h-5" />}
                  </Button>
                  <Button
                      size="icon"
                      variant="ghost"
                      className="h-8 w-8 md:h-10 md:w-10 text-muted-foreground hover:text-green-400 hover:bg-green-500/10 rounded-xl transition-all"
                      onClick={() => setShowLeadModal(true)}
                  >
                      <UserPlus className="w-4 h-4 md:w-5 md:h-5" />
                  </Button>
                </div>
              </header>

              {/* Chat Viewport */}
              <div 
                key={selectedSession} 
                className="flex-1 overflow-y-auto bg-transparent animate-fade-in relative scroll-smooth selection:bg-primary/30"
              >
                {/* Background Pattern Layer */}
                <div className="absolute inset-0 opacity-[0.02] pointer-events-none bg-[url('https://w0.peakpx.com/wallpaper/508/606/HD-wallpaper-whatsapp-dark-mode-theme-background.jpg')] bg-repeat" />
                
                <div className="p-4 sm:p-8 md:p-12 max-w-5xl mx-auto space-y-6 relative z-10">
                  {loadingMsgs ? (
                    <div className="space-y-6 py-10">
                      {[...Array(5)].map((_, i) => (
                        <div key={i} className={cn("flex", i % 2 === 0 ? "justify-start" : "justify-end")}>
                            <div className="h-16 w-64 rounded-2xl bg-white/5 animate-pulse" />
                        </div>
                      ))}
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="py-32 text-center space-y-4">
                        <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mx-auto border border-white/5 uppercase font-black text-xl text-muted-foreground/20">?</div>
                        <p className="text-xs text-muted-foreground uppercase tracking-widest font-black">Nenhum histórico encontrado</p>
                    </div>
                  ) : (
                    messages.map((msg, idx) => {
                      const msgType = msg.sender || msg.sender_type || "customer";
                      const text = extractText(msg);
                      
                      const isMe = msgType === "ai" || msgType === "human";
                      const isCustomer = msgType === "customer";
                      
                      if (text.length > 500 && (text.includes("PAPEL") || text.includes("CONTEXTO"))) return null;

                      // === LÓGICA DE AGRUPAMENTO POR DATA ===
                      let showDateSeparator = false;
                      const msgDateStr = formatChatDate(msg.created_at);
                      
                      if (idx === 0) {
                        showDateSeparator = true;
                      } else {
                        const prevMsgDateStr = formatChatDate(messages[idx - 1].created_at);
                        if (msgDateStr !== prevMsgDateStr) {
                          showDateSeparator = true;
                        }
                      }

                      return (
                        <div key={`${msg.id}-${msg.message_id}`}>
                          {showDateSeparator && (
                            <div className="w-full flex justify-center my-6">
                              <span className="bg-background/80 glass-card px-4 py-1.5 rounded-full text-[10px] font-black tracking-widest uppercase text-muted-foreground shadow-sm ring-1 ring-white/10">
                                {msgDateStr}
                              </span>
                            </div>
                          )}
                          <div id={`msg-${msg.message_id}`} className={cn("flex group animate-in slide-in-from-bottom-2 duration-500 mb-6", isMe ? "justify-end" : "justify-start")}>
                          <div className={cn(
                            "relative max-w-[85%] sm:max-w-[75%] px-5 py-4 rounded-[1.5rem] shadow-2xl transition-transform hover:scale-[1.01] overflow-hidden",
                            isMe
                               ? "bg-[#005c4b] text-[#e9edef] rounded-br-none shadow-[0_2px_5px_rgba(0,0,0,0.2)] ring-1 ring-white/5"
                               : "bg-[#202c33] text-[#e9edef] rounded-bl-none ring-1 ring-white/5 shadow-[0_2px_5px_rgba(0,0,0,0.2)]"
                          )}>
                            <div className={cn("flex items-center gap-2 mb-2", isMe ? "justify-end opacity-70" : "justify-start opacity-70")}>
                              {msgType === "ai" && <Bot className="w-3 h-3 text-purple-400" />}
                              {msgType === "human" && <User className="w-3 h-3 text-blue-400" />}
                              {msgType === "customer" && <Smartphone className="w-3 h-3 text-green-400" />}
                              <span className={cn("text-[8px] font-black uppercase tracking-[0.2em]",
                                msgType === "ai" ? "text-purple-400" : msgType === "human" ? "text-blue-400" : "text-green-400"
                              )}>
                                {msgType === "ai" ? "🤖 IA" : msgType === "human" ? "👤 Atendente" : "📱 Cliente"}
                              </span>
                              {msg.delivery_status === 'pending' && <Clock className="w-2.5 h-2.5 animate-pulse text-white/40" />}
                              {msg.delivery_status === 'error' && <AlertCircle className="w-2.5 h-2.5 text-red-500" />}
                            </div>
                            <div className={cn("space-y-3", msg.delivery_status === 'pending' && "opacity-60")}>
                              {/* Quoted Message (Reply) context */}
                              {msg.quoted_text && (
                                <div className="mb-2 p-2 rounded-lg bg-white/10 border-l-4 border-primary/50 text-[11px] opacity-80 cursor-pointer hover:bg-white/20 transition-colors"
                                     onClick={() => {
                                        const quotedEl = document.getElementById(`msg-${msg.quoted_id}`);
                                        quotedEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                                     }}>
                                   <p className="font-black text-[9px] uppercase tracking-widest text-primary/80 mb-0.5">Resposta para:</p>
                                   <p className="italic line-clamp-2">{msg.quoted_text}</p>
                                </div>
                              )}

                              {(() => {
                                const mediaSrc = resolveMediaSrc(msg);
                                const mediaCategory = detectMediaCategory(msg);
                                
                                // === IMAGEM (base64 ou URL) ===
                                if (mediaCategory === 'image' && mediaSrc) {
                                  // Se content começa com "📷 ", é descrição gerada pela IA — mostra abaixo.
                                  // Se for placeholder puro "[📷 Imagem]", esconde (redundante com a imagem).
                                  const isPlaceholder = msg.content === "[📷 Imagem]" || msg.content === "[📷 Imagem — carregando...]";
                                  const captionOrDesc = !isPlaceholder && msg.content
                                    ? msg.content.replace(/^📷\s*/, "")
                                    : null;
                                  const isAiDesc = msg.content?.startsWith("📷 ");

                                  return (
                                    <div className="space-y-2">
                                      <img
                                        src={mediaSrc}
                                        alt="Imagem"
                                        className="rounded-lg max-w-full max-h-[400px] object-contain cursor-pointer hover:opacity-90 transition-opacity ring-1 ring-white/10"
                                        onClick={() => {
                                          const w = window.open();
                                          if (w) { w.document.write(`<img src="${mediaSrc}" style="max-width:100%;height:auto" />`); w.document.title = 'Imagem'; }
                                        }}
                                      />
                                      {captionOrDesc && (
                                        isAiDesc ? (
                                          <div className="px-2 py-1.5 rounded-lg bg-black/20 border-l-2 border-primary/40">
                                            <p className="text-[9px] uppercase tracking-widest font-black text-primary/70 mb-0.5">
                                              Descrição (IA)
                                            </p>
                                            <p className="text-[13px] leading-snug italic opacity-90">{captionOrDesc}</p>
                                          </div>
                                        ) : (
                                          <p className="text-[14px] leading-relaxed font-medium">{captionOrDesc}</p>
                                        )
                                      )}
                                    </div>
                                  );
                                }
                                
                                // === ÁUDIO (estilo WhatsApp) ===
                                if (mediaCategory === 'audio' && mediaSrc) {
                                  const isTranscription = msg.content?.startsWith("🎤");
                                  const transcriptText = isTranscription ? msg.content!.replace(/^🎤\s*/, "") : null;
                                  const isFailed = transcriptText === "[áudio inaudível]" || msg.content?.includes("falha na transcrição");
                                  const isPending = msg.content?.includes("transcrevendo");

                                  return (
                                    <div className="space-y-2">
                                      <WhatsAppAudioPlayer src={mediaSrc} isMe={isMe} />
                                      {transcriptText && !isFailed && (
                                        <div className={cn(
                                          "px-3 py-2 rounded-xl border-l-2",
                                          isMe ? "bg-black/15 border-white/40" : "bg-black/30 border-primary/50"
                                        )}>
                                          <p className={cn(
                                            "text-[9px] uppercase tracking-widest font-black mb-0.5",
                                            isMe ? "text-white/70" : "text-primary/80"
                                          )}>Transcrição</p>
                                          <p className="text-[13px] leading-snug italic opacity-90">{transcriptText}</p>
                                        </div>
                                      )}
                                      {isPending && (
                                        <p className="text-[10px] italic text-muted-foreground flex items-center gap-1">
                                          <Loader2 className="w-3 h-3 animate-spin" /> Transcrevendo áudio...
                                        </p>
                                      )}
                                    </div>
                                  );
                                }
                                
                                // === VÍDEO (base64 ou URL) ===
                                if (mediaCategory === 'video' && mediaSrc) {
                                  return (
                                    <div className="space-y-2">
                                      <video 
                                        controls 
                                        className="rounded-lg max-w-full max-h-[400px]"
                                        src={mediaSrc}
                                      />
                                      {msg.content && (
                                        <p className="text-[14px] leading-relaxed font-medium">{msg.content}</p>
                                      )}
                                    </div>
                                  );
                                }
                                
                                // === DOCUMENTO (base64 ou URL) ===
                                if (mediaCategory === 'document' && mediaSrc) {
                                  const handleDocClick = () => {
                                    if (mediaSrc.startsWith('data:')) {
                                      // Download do base64 como arquivo
                                      const link = document.createElement('a');
                                      link.href = mediaSrc;
                                      link.download = msg.file_name || 'documento';
                                      link.click();
                                    } else {
                                      window.open(mediaSrc, '_blank');
                                    }
                                  };
                                  return (
                                    <div className="space-y-2">
                                      <div className="flex items-center gap-3 p-3 bg-white/5 border border-white/5 rounded-xl hover:bg-white/10 transition-colors cursor-pointer" onClick={handleDocClick}>
                                        <div className="p-2 bg-primary/20 rounded-lg text-primary">
                                          <Paperclip className="w-5 h-5" />
                                        </div>
                                        <div className="flex-1 min-w-0">
                                          <p className="text-xs font-bold truncate">{msg.file_name || "Documento"}</p>
                                          <p className="text-[9px] uppercase text-muted-foreground">{msg.mimetype?.split('/')[1] || 'FILE'}</p>
                                        </div>
                                        <ExternalLink className="w-4 h-4 text-muted-foreground" />
                                      </div>
                                      {msg.content && (
                                        <p className="text-[14px] leading-relaxed font-medium">{msg.content}</p>
                                      )}
                                    </div>
                                  );
                                }
                                
                                // === FALLBACK: tem base64 mas sem tipo detectado ===
                                if (mediaSrc && !mediaCategory) {
                                  const mime = (msg.mimetype || '').toLowerCase();
                                  if (mime.startsWith('image/')) {
                                    return (
                                      <div className="space-y-2">
                                        <img src={mediaSrc} alt="Mídia" className="rounded-lg max-w-full max-h-[400px] object-contain ring-1 ring-white/10" />
                                        {msg.content && <p className="text-[14px] leading-relaxed font-medium">{msg.content}</p>}
                                      </div>
                                    );
                                  }
                                  if (mime.startsWith('audio/')) {
                                    return (
                                      <div className="space-y-2">
                                        <audio controls src={mediaSrc} className={cn("h-8 rounded-full", isMe ? "brightness-110" : "invert opacity-70")} />
                                      </div>
                                    );
                                  }
                                  // Genérico — oferece download
                                  return (
                                    <div className="flex items-center gap-3 p-3 bg-white/5 border border-white/5 rounded-xl hover:bg-white/10 transition-colors cursor-pointer"
                                         onClick={() => { const a = document.createElement('a'); a.href = mediaSrc; a.download = msg.file_name || 'arquivo'; a.click(); }}>
                                      <div className="p-2 bg-primary/20 rounded-lg text-primary"><Paperclip className="w-5 h-5" /></div>
                                      <div className="flex-1 min-w-0">
                                        <p className="text-xs font-bold truncate">{msg.file_name || "Arquivo"}</p>
                                        <p className="text-[9px] uppercase text-muted-foreground">{mime || 'ARQUIVO'}</p>
                                      </div>
                                      <ExternalLink className="w-4 h-4 text-muted-foreground" />
                                    </div>
                                  );
                                }
                                
                                // === FALLBACK LEGADO: detecção por regex no texto ===
                                if (text.includes("[MÍDIA: IMAGE]") || text.match(/\.(jpeg|jpg|gif|png|webp|avif)/i)) {
                                  const imgUrl = text.split(/\s+/).find(w => w.startsWith("http"));
                                  return (
                                    <div className="space-y-2">
                                      {imgUrl ? (
                                        <img src={imgUrl} alt="Imagem" className="rounded-lg max-w-full h-auto cursor-pointer hover:opacity-90 transition-opacity ring-1 ring-white/10" onClick={() => window.open(imgUrl, "_blank")} />
                                      ) : (
                                        <div className="flex items-center gap-2 p-2 bg-white/10 rounded-lg"><ImageIcon className="w-4 h-4" /><span className="text-[10px] font-bold">IMAGEM RECEBIDA</span></div>
                                      )}
                                      {text.replace(/\[MÍDIA: IMAGE\]|http\S+/g, "").trim() && (
                                        <p className="text-[14px] leading-relaxed font-medium">{text.replace(/\[MÍDIA: IMAGE\]|http\S+/g, "").trim()}</p>
                                      )}
                                    </div>
                                  );
                                }
                                
                                if (text.includes("[MÍDIA: AUDIO]") || text.match(/\.(ogg|mp3|wav|m4a)/i)) {
                                  const audioUrl = text.split(/\s+/).find(w => w.startsWith("http"));
                                  return (
                                    <div className="space-y-2">
                                      {audioUrl ? (
                                        <audio controls className={cn("h-8 rounded-full", isMe ? "brightness-110" : "invert opacity-70")} src={audioUrl} />
                                      ) : (
                                        <div className="flex items-center gap-2 p-2 bg-white/10 rounded-lg"><Mic className="w-4 h-4" /><span className="text-[10px] font-bold">MENSAGEM DE VOZ</span></div>
                                      )}
                                    </div>
                                  );
                                }
                                
                                // === TEXTO PURO ===
                                return <p className="text-[14px] lg:text-[15px] leading-relaxed whitespace-pre-wrap font-medium tracking-wide">{text}</p>;
                              })()}
                            </div>
                            <div className={cn("mt-3 flex items-center gap-2", isMe ? "justify-end" : "justify-start")}>
                                <span className={cn("text-[10px] font-mono font-bold", isMe ? "text-white/60" : "text-white/40")}>
                                    {new Date(msg.created_at).toLocaleTimeString("pt-BR", { hour: '2-digit', minute: '2-digit' })}
                                </span>
                                {isMe && (
                                    <div className="flex items-center">
                                        {msg.status_envio === "read" ? (
                                            <CheckCheck className="w-3.5 h-3.5 text-blue-400" />
                                        ) : msg.status_envio === "delivered" ? (
                                            <CheckCheck className="w-3.5 h-3.5 text-white/40" />
                                        ) : (
                                            <Check className="w-3.5 h-3.5 text-white/40" />
                                        )}
                                    </div>
                                )}
                            </div>
                          </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={messagesEndRef} className="h-10" />
                </div>
              </div>

              {/* Fixed Footer Input */}
              <footer className="p-2 sm:p-4 md:p-6 bg-background/90 backdrop-blur-3xl border-t border-white/5 shrink-0 z-40" style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}>
                <div className="max-w-5xl mx-auto space-y-2 md:space-y-4">

                    <div className="flex gap-1.5 sm:gap-3 items-end">
                        <input 
                          type="file" 
                          ref={fileInputRef} 
                          className="hidden" 
                          onChange={handleFileChange}
                          accept="image/*, application/pdf"
                        />
                        
                        <div className="flex gap-1 sm:gap-2 shrink-0 mb-0.5 sm:mb-1">
                          <Button
                            onClick={() => fileInputRef.current?.click()}
                            disabled={sending || isRecording}
                            size="icon"
                            variant="ghost"
                            className="h-10 w-10 md:h-11 md:w-11 rounded-xl hover:bg-white/10 text-muted-foreground transition-all"
                          >
                            <Paperclip className="w-4 h-4 md:w-5 md:h-5" />
                          </Button>
                          
                          {isRecording ? (
                            <div className="flex items-center gap-1.5 sm:gap-2 bg-red-500/10 border border-red-500/20 px-2 sm:px-3 py-1 rounded-xl animate-pulse">
                              <div className="w-2 h-2 rounded-full bg-red-500" />
                              <span className="text-[10px] font-mono font-black text-red-500">
                                {Math.floor(recordingTime/60)}:{String(recordingTime%60).padStart(2,'0')}
                              </span>
                              <Button
                                onClick={() => stopRecording(true)}
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7 rounded-lg hover:bg-red-500/20 text-red-500"
                              >
                                <Trash2 className="w-4 h-4" />
                              </Button>
                            </div>
                          ) : null}
                        </div>

                        <div className="flex-1 relative">
                            <Textarea
                                rows={1}
                                placeholder={isRecording ? "Gravando..." : "Digite sua mensagem..."}
                                value={inputMessage}
                                onChange={(e) => {
                                    const v = e.target.value;
                                    setInputMessage(v);
                                    // Primeira tecla digitada nesta conversa → pausa IA por 30min
                                    if (v.trim().length > 0 && selectedSession && activeInstance && !isAiPaused) {
                                        fireTypingPause(selectedSession, activeInstance);
                                    }
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" && !e.shiftKey) {
                                        e.preventDefault();
                                        handleSend();
                                    }
                                }}
                                disabled={sending || isRecording}
                                className="bg-white/5 border-white/10 min-h-[44px] md:min-h-[56px] max-h-32 md:max-h-48 rounded-xl md:rounded-2xl py-2.5 px-3 md:py-4 md:px-6 focus-visible:ring-primary/40 focus:bg-white/10 transition-all text-sm font-medium resize-none shadow-inner"
                            />
                        </div>

                        <div className="flex gap-1.5 sm:gap-3 shrink-0">
                          {isRecording ? (
                            <Button
                              onClick={() => stopRecording()}
                              size="icon"
                              className="h-[44px] w-[44px] md:h-[56px] md:w-[56px] rounded-xl md:rounded-2xl shrink-0 bg-red-600 hover:bg-red-700 animate-pulse shadow-xl shadow-red-500/20"
                            >
                              <Square className="w-5 h-5 md:w-6 md:h-6 fill-white" />
                            </Button>
                          ) : (
                            <>
                              {!inputMessage.trim() ? (
                                <Button
                                  onClick={startRecording}
                                  disabled={sending || !selectedSession || wsStatus === "close"}
                                  size="icon"
                                  variant="ghost"
                                  className="h-[44px] w-[44px] md:h-[56px] md:w-[56px] rounded-xl md:rounded-2xl shrink-0 border border-white/5 bg-white/5 hover:bg-white/10 text-primary transition-all"
                                  title={wsStatus === "close" ? "Instância desconectada — reconecte em /whatsapp" : ""}
                                >
                                  <Mic className="w-5 h-5 md:w-6 md:h-6" />
                                </Button>
                              ) : (
                                <Button
                                  onClick={() => handleSend()}
                                  disabled={!inputMessage.trim() || sending || !selectedSession || wsStatus === "close"}
                                  size="icon"
                                  className="h-[44px] w-[44px] md:h-[56px] md:w-[56px] rounded-xl md:rounded-2xl shrink-0 glow-primary bg-gradient-to-tr from-primary to-indigo-600 transition-all hover:scale-105 active:scale-95 shadow-2xl shadow-primary/40 disabled:opacity-40"
                                  title={wsStatus === "close" ? "Instância desconectada — reconecte em /whatsapp" : ""}
                                >
                                  {sending ? <Loader2 className="w-5 h-5 md:w-6 md:h-6 animate-spin" /> : <Send className="w-5 h-5 md:w-6 md:h-6" />}
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                    </div>
                </div>
              </footer>
            </>
          )}
        </main>

        {selectedSession && stages.length > 0 && (
            <aside className="w-80 border-l border-white/5 bg-background/20 hidden xl:flex flex-col p-6 shrink-0 z-20 min-h-0 relative animate-fade-in">
               <div className="flex items-center justify-between pb-2">
                  <h4 className="font-bold text-sm text-white">Progresso</h4>
                  <span className="text-[10px] text-blue-400 font-bold bg-blue-500/20 px-2 py-0.5 rounded-full font-mono">
                    {Math.min((stages.findIndex(s => s.id === currentStageId) !== -1 ? stages.findIndex(s => s.id === currentStageId) : 0), stages.length)}/{stages.length}
                  </span>
               </div>
               
               <div className="w-full bg-white/10 h-1 rounded-full mb-6 overflow-hidden">
                 <div 
                   className="bg-blue-500 h-full rounded-full transition-all duration-500" 
                   style={{ width: `${(Math.min((stages.findIndex(s => s.id === currentStageId) !== -1 ? stages.findIndex(s => s.id === currentStageId) : 0), stages.length) / stages.length) * 100}%` }} 
                 />
               </div>

               <div className="flex-1 overflow-y-auto space-y-6 custom-scrollbar pr-2">
                  {stages.map((stage, idx) => {
                     const activeIdx = stages.findIndex(s => s.id === currentStageId);
                     const currentStageIndex = activeIdx !== -1 ? activeIdx : 0;
                     const isCompleted = idx < currentStageIndex;
                     const isActive = idx === currentStageIndex;
                     
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

                             {/* Variáveis coletadas na etapa */}
                             {(isCompleted || isActive) && (
                                <div className="mt-2 flex flex-wrap gap-1">
                                   {(Array.isArray(stage.captured_variables) ? stage.captured_variables : []).map((v: any, vi: number) => {
                                      const val = sessionVariables[v.name];
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
            </aside>
        )}
      </div>

      {/* Modern Save Lead Modal */}
      <Dialog open={showLeadModal} onOpenChange={setShowLeadModal}>
          <DialogContent className="glass-card border-none max-w-sm w-[95vw] rounded-[2rem] md:rounded-[2.5rem] p-5 md:p-8">
              <DialogHeader>
                  <DialogTitle className="flex flex-col items-center gap-4 text-center">
                    <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
                      <UserPlus className="w-8 h-8 text-primary shadow-glow" />
                    </div>
                    <div>
                      <h3 className="text-xl font-black tracking-tight">Qualificar Lead</h3>
                      <p className="text-xs text-muted-foreground uppercase tracking-widest mt-1">Mover para o CRM</p>
                    </div>
                  </DialogTitle>
              </DialogHeader>
              <div className="space-y-6 pt-4">
                  <div className="space-y-2">
                      <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest">Nome do Negócio</label>
                      <Input 
                        value={leadName}
                        onChange={(e) => setLeadName(e.target.value)}
                        className="h-12 bg-white/5 border-white/10 rounded-xl"
                      />
                  </div>
                  <div className="space-y-2">
                      <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest">Status no Funil</label>
                      <Select value={leadStatus} onValueChange={(val) => setLeadStatus(val as string || "novo")}>
                          <SelectTrigger className="h-12 bg-white/5 border-white/10 rounded-xl">
                              <SelectValue />
                          </SelectTrigger>
                          <SelectContent className="glass-card border-white/10 rounded-[1.5rem] overflow-hidden">
                              <SelectItem value="novo">🆕 Lead Extraído</SelectItem>
                              <SelectItem value="interessado">🔥 Interessado</SelectItem>
                              <SelectItem value="follow-up">⏳ Follow-Up</SelectItem>
                              <SelectItem value="agendado">📅 Agendado</SelectItem>
                              <SelectItem value="fechado">💰 Venda Fechada</SelectItem>
                          </SelectContent>
                      </Select>
                  </div>
                  <Button 
                    className="w-full h-14 rounded-2xl font-black uppercase tracking-[0.2em] text-xs glow-primary mt-2 group" 
                    onClick={handleSaveLead}
                    disabled={savingLead || !leadName.trim()}
                  >
                    {savingLead ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <ShieldCheck className="w-4 h-4 mr-2 group-hover:scale-110 transition-transform" />}
                    Confirmar Envio
                  </Button>
              </div>
          </DialogContent>
      </Dialog>

      {/* Organizador IA — Dialog */}
      <Dialog open={orgOpen} onOpenChange={(open) => !orgSaving && !orgRunning && setOrgOpen(open)}>
          <DialogContent className="glass-card border-white/20 max-w-lg w-[95vw] p-0 overflow-hidden">
              <div className="p-6 border-b border-white/10 bg-gradient-to-r from-primary/15 via-purple-500/10 to-transparent">
                  <div className="flex items-center gap-4">
                      <div className="w-12 h-12 rounded-2xl bg-primary/20 border border-primary/30 flex items-center justify-center">
                          <BrainCircuit className="w-6 h-6 text-primary" />
                      </div>
                      <div>
                          <DialogTitle className="text-lg font-black text-white">Organizador IA</DialogTitle>
                          <p className="text-[11px] text-muted-foreground mt-0.5">
                              Analisa apenas os chats de <strong className="text-primary">HOJE</strong> e move os leads no CRM. Economiza tokens.
                          </p>
                      </div>
                  </div>
              </div>

              <div className="p-6 space-y-5 max-h-[70vh] overflow-y-auto custom-scrollbar">
                  {orgLoading ? (
                      <div className="flex items-center justify-center py-10 text-muted-foreground">
                          <Loader2 className="w-5 h-5 animate-spin mr-2" /> Carregando...
                      </div>
                  ) : (
                      <>
                          {/* Status da API Key — gerenciada em Configurações */}
                          <div className={cn(
                              "p-3 rounded-xl border flex items-center gap-3",
                              orgHasApiKey
                                  ? "bg-green-500/5 border-green-500/20"
                                  : "bg-amber-500/5 border-amber-500/30"
                          )}>
                              <Key className={cn("w-4 h-4", orgHasApiKey ? "text-green-400" : "text-amber-400")} />
                              <div className="flex-1 min-w-0">
                                  <p className="text-[11px] font-bold text-white">
                                      API Key Gemini — {orgHasApiKey ? "configurada" : "não configurada"}
                                  </p>
                                  <p className="text-[10px] text-muted-foreground">
                                      Gerenciada em{" "}
                                      <a href="/configuracoes" className="text-primary hover:underline font-bold">
                                          Configurações
                                      </a>
                                      . A mesma chave é usada por Agente, Disparo, Follow-up e Organizador.
                                  </p>
                              </div>
                          </div>

                          {/* Toggle ativar/desativar */}
                          <div className="flex items-center justify-between p-4 rounded-2xl bg-white/5 border border-white/10">
                              <div className="min-w-0 pr-3">
                                  <p className="text-sm font-bold text-white">Organizar automaticamente todo dia</p>
                                  <p className="text-[11px] text-muted-foreground">
                                      Se desligado, a IA só roda quando você clicar em <em>Executar agora</em>.
                                  </p>
                              </div>
                              <Switch checked={orgEnabled} onCheckedChange={setOrgEnabled} />
                          </div>

                          {/* Modelo */}
                          <div className="space-y-2">
                              <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest">Modelo Gemini</label>
                              <Select value={orgModel} onValueChange={(v) => setOrgModel(v as string)}>
                                  <SelectTrigger className="h-11 bg-white/5 border-white/10 rounded-xl">
                                      <SelectValue placeholder={orgModels.length ? "Escolha um modelo" : "Nenhum modelo disponível"} />
                                  </SelectTrigger>
                                  <SelectContent className="glass-card border-white/10 max-h-[50vh]">
                                      {orgModels.length === 0 ? (
                                          <SelectItem value="_none" disabled>
                                              Nenhum modelo (verifique API Key)
                                          </SelectItem>
                                      ) : (
                                          orgModels.map((m) => (
                                              <SelectItem key={m.id} value={m.id} className="text-xs">
                                                  {m.name || m.id}
                                              </SelectItem>
                                          ))
                                      )}
                                  </SelectContent>
                              </Select>
                          </div>

                          {/* Horário */}
                          <div className="space-y-2">
                              <label className="text-[10px] font-black text-muted-foreground uppercase tracking-widest">
                                  Horário de execução diária
                              </label>
                              <div className="flex items-center gap-3">
                                  <Input
                                      type="time"
                                      value={`${String(orgHour).padStart(2, "0")}:00`}
                                      onChange={(e) => {
                                          const h = parseInt(e.target.value.split(":")[0] || "0", 10);
                                          if (Number.isFinite(h) && h >= 0 && h <= 23) setOrgHour(h);
                                      }}
                                      className="h-11 bg-white/5 border-white/10 rounded-xl w-32"
                                      step={3600}
                                  />
                                  <p className="text-[11px] text-muted-foreground">
                                      Executa UMA vez por dia, exatamente nesta hora. Re-agenda após rodar.
                                  </p>
                              </div>
                          </div>

                          {/* Status */}
                          <div className="p-3 rounded-xl bg-black/30 border border-white/5 flex items-center gap-2">
                              <Clock className="w-3.5 h-3.5 text-muted-foreground" />
                              <span className="text-[11px] text-muted-foreground">Última execução:</span>
                              <span className="text-[11px] font-mono text-white">
                                  {orgLastRun ? new Date(orgLastRun).toLocaleString("pt-BR") : "nunca"}
                              </span>
                          </div>

                          {/* Mensagem */}
                          {orgMsg && (
                              <div
                                  className={cn(
                                      "p-3 rounded-xl text-[11px] border",
                                      orgMsg.type === "ok"
                                          ? "bg-green-500/10 border-green-500/30 text-green-300"
                                          : "bg-red-500/10 border-red-500/30 text-red-300"
                                  )}
                              >
                                  {orgMsg.text}
                              </div>
                          )}

                          {/* Ações */}
                          <div className="flex flex-col sm:flex-row gap-3 pt-2">
                              <Button
                                  variant="outline"
                                  className="flex-1 h-11 rounded-xl border-white/10 bg-white/5 hover:bg-white/10 gap-2"
                                  onClick={runOrganizerNow}
                                  disabled={orgRunning || orgSaving || !orgModel || !orgHasApiKey}
                                  title={!orgHasApiKey ? "Configure a API Key em Configurações primeiro" : ""}
                              >
                                  {orgRunning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4 text-amber-400" />}
                                  Executar agora
                              </Button>
                              <Button
                                  className="flex-1 h-11 rounded-xl font-bold gap-2 bg-primary hover:bg-primary/90"
                                  onClick={saveOrganizerConfig}
                                  disabled={orgSaving || orgRunning}
                              >
                                  {orgSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                                  Salvar
                              </Button>
                          </div>
                      </>
                  )}
              </div>
          </DialogContent>
      </Dialog>


  </div>
  );
}
