"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import { Loader2, MapPin, Zap, Repeat, MessageSquare, AlertTriangle, Activity, Send, ArrowDown } from "lucide-react";

type LogEntry = {
  id: string;
  ts: string;
  kind: "state" | "scrape" | "dispatch" | "followup" | "reply" | "error";
  level: "info" | "success" | "warning" | "error";
  message: string;
  remote_jid?: string | null;
};

const KIND_META: Record<LogEntry["kind"], { icon: any; color: string; label: string }> = {
  state:    { icon: Activity,        color: "text-zinc-300",   label: "estado" },
  scrape:   { icon: MapPin,          color: "text-blue-300",   label: "captação" },
  dispatch: { icon: Zap,             color: "text-cyan-300",   label: "disparo" },
  followup: { icon: Repeat,          color: "text-purple-300", label: "follow-up" },
  reply:    { icon: MessageSquare,   color: "text-emerald-300", label: "resposta" },
  error:    { icon: AlertTriangle,   color: "text-red-400",    label: "erro" },
};

const LEVEL_BG: Record<LogEntry["level"], string> = {
  info:    "bg-white/[0.02] border-white/5",
  success: "bg-emerald-500/[0.05] border-emerald-500/20",
  warning: "bg-amber-500/[0.05] border-amber-500/20",
  error:   "bg-red-500/[0.06] border-red-500/30",
};

/**
 * Painel de logs unificado pra uma automação. Junta 5 fontes:
 *   1. automation_logs (transições + erros)
 *   2. campaign_logs WHERE campaign_id = a.campaign_id   (cada disparo)
 *   3. followup_logs WHERE followup_campaign_id = a.followup_campaign_id
 *   4. leads_extraidos novos durante a fase de scraping
 *   5. chats_dashboard sender_type='customer' nos remote_jids da automação
 *
 * Tudo em realtime via Supabase channel — atualiza ao vivo sem F5.
 */
export function AutomationLogs({
  automationId,
  campaignId,
  followupCampaignId,
  startedAt,
  scraping,
}: {
  automationId: string;
  campaignId: string | null;
  followupCampaignId: string | null;
  startedAt: string | null;
  scraping: boolean;
}) {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [scrapeFeed, setScrapeFeed] = useState<{ id: number; nome_negocio: string | null; created_at: string }[]>([]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const merged: LogEntry[] = [];

    // 1) automation_logs
    const { data: alogs } = await supabase
      .from("automation_logs")
      .select("id, kind, level, message, remote_jid, created_at")
      .eq("automation_id", automationId)
      .order("created_at", { ascending: false })
      .limit(500);
    for (const r of alogs || []) {
      merged.push({
        id: `a:${r.id}`,
        ts: r.created_at,
        kind: r.kind as LogEntry["kind"],
        level: r.level as LogEntry["level"],
        message: r.message,
        remote_jid: r.remote_jid,
      });
    }

    // 2) campaign_logs (disparos)
    if (campaignId) {
      const { data: clogs } = await supabase
        .from("campaign_logs")
        .select("id, message, level, created_at")
        .eq("campaign_id", campaignId)
        .order("created_at", { ascending: false })
        .limit(500);
      for (const r of clogs || []) {
        merged.push({
          id: `c:${r.id}`,
          ts: r.created_at,
          kind: "dispatch",
          level: (r.level as LogEntry["level"]) || "info",
          message: r.message,
        });
      }
    }

    // 3) followup_logs
    if (followupCampaignId) {
      const { data: flogs } = await supabase
        .from("followup_logs")
        .select("id, message, level, created_at")
        .eq("followup_campaign_id", followupCampaignId)
        .order("created_at", { ascending: false })
        .limit(500);
      for (const r of flogs || []) {
        merged.push({
          id: `f:${r.id}`,
          ts: r.created_at,
          kind: "followup",
          level: (r.level as LogEntry["level"]) || "info",
          message: r.message,
        });
      }
    }

    // 4) Leads colhidos durante o scrape (mostra os mais recentes)
    if (startedAt) {
      const { data: leads } = await supabase
        .from("leads_extraidos")
        .select("id, nome_negocio, created_at")
        .gte("created_at", startedAt)
        .order("created_at", { ascending: false })
        .limit(50);
      setScrapeFeed(leads || []);
      // We no longer push fake 'scrape' logs here because the scraper-engine 
      // already logs real events (e.g., "[CRM] Lead salvo") to automation_logs.
    }

    // 5) Respostas dos clientes nos remote_jids dos targets desta automação
    if (campaignId) {
      const { data: tgts } = await supabase
        .from("campaign_targets")
        .select("remote_jid")
        .eq("campaign_id", campaignId);
      const jids = (tgts || []).map((t: any) => t.remote_jid).filter(Boolean);
      if (jids.length > 0) {
        const { data: replies } = await supabase
          .from("chats_dashboard")
          .select("id, remote_jid, content, created_at")
          .in("remote_jid", jids)
          .eq("sender_type", "customer")
          .order("created_at", { ascending: false })
          .limit(100);
        for (const r of replies || []) {
          merged.push({
            id: `r:${r.id}`,
            ts: r.created_at,
            kind: "reply",
            level: "success",
            message: `💬 Cliente respondeu: "${(r.content || "").slice(0, 100)}${(r.content || "").length > 100 ? "…" : ""}"`,
            remote_jid: r.remote_jid,
          });
        }
      }
    }

    // Ordena ASC (mais antigo no topo, mais novo embaixo) — formato chat.
    // Antes era DESC e novos logs surgiam no topo, "empurrando" a lista pra
    // baixo a cada evento — sensação de "pulando". Agora é estável.
    merged.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    setEntries(merged.slice(-800));  // mantém últimos 800
    setLoading(false);
  }, [automationId, campaignId, followupCampaignId, startedAt]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // Auto-scroll inteligente (padrão chat/terminal):
  //   - wasAtBottomRef é atualizada SÓ quando o usuário rola (handleScroll).
  //     Assim sabemos se ele estava colado no fim ANTES do log novo chegar.
  //   - useLayoutEffect roda ANTES do paint: se estava no fim, ajusta scrollTop
  //     pro novo scrollHeight no mesmo frame — sem flicker, sem o bug antigo
  //     onde o effect pós-render lia o scrollHeight já crescido e concluía
  //     erradamente que o usuário "saiu do fim".
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const wasAtBottomRef = useRef(true); // começa true → auto-stick no primeiro render
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    wasAtBottomRef.current = dist < 40; // 40px de tolerância
    setShowJumpToBottom(dist > 80);
  }, []);

  useLayoutEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    if (wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setShowJumpToBottom(false);
    } else {
      // Usuário leu histórico — só mostra o botão pra ele voltar quando quiser.
      setShowJumpToBottom(true);
    }
  }, [entries.length]);

  function jumpToBottom() {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setShowJumpToBottom(false);
  }

  // Realtime: assina cada fonte. Qualquer evento → re-fetch (debounce simples).
  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    const debouncedFetch = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fetchAll(), 600);
    };
    const ch = supabase
      .channel(`auto-logs-${automationId}`)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "automation_logs", filter: `automation_id=eq.${automationId}` },
        debouncedFetch)
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "campaign_logs" },
        (p: any) => { if (p.new?.campaign_id === campaignId) debouncedFetch(); })
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "followup_logs" },
        (p: any) => { if (p.new?.followup_campaign_id === followupCampaignId) debouncedFetch(); })
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "leads_extraidos" },
        () => { if (scraping) debouncedFetch(); })
      .on("postgres_changes",
        { event: "INSERT", schema: "public", table: "chats_dashboard" },
        (p: any) => { if (p.new?.sender_type === "customer") debouncedFetch(); })
      .subscribe();
    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(ch);
    };
  }, [automationId, campaignId, followupCampaignId, scraping, fetchAll]);

  return (
    <div className="rounded-xl bg-black/40 border border-white/5 overflow-hidden relative">
      {showJumpToBottom && (
        <button
          type="button"
          onClick={jumpToBottom}
          className="absolute right-3 bottom-3 z-10 px-2.5 py-1.5 rounded-full bg-emerald-500/20 hover:bg-emerald-500/40 border border-emerald-500/40 text-emerald-100 text-[10px] font-bold flex items-center gap-1.5 backdrop-blur shadow-lg transition"
          title="Ir para o último log (e seguir novos)"
        >
          <ArrowDown className="w-3 h-3" /> Novos logs
        </button>
      )}
      <div className="px-3 py-2 border-b border-white/5 flex items-center justify-between bg-white/[0.02]">
        <p className="text-[10px] uppercase font-black tracking-widest text-white/70 flex items-center gap-1.5">
          <Activity className="w-3 h-3 text-emerald-400" /> Log ao vivo
          {scraping && <Loader2 className="w-3 h-3 animate-spin text-blue-300" />}
        </p>
        <div className="flex items-center gap-2 text-[9px] font-mono text-muted-foreground">
          <span><span className="text-blue-300">{scrapeFeed.length}</span> captados</span>
          <span>·</span>
          <span><span className="text-emerald-300">{entries.filter(e => e.kind === "reply").length}</span> respostas</span>
        </div>
      </div>
      <div ref={scrollContainerRef} onScroll={handleScroll} className="max-h-80 overflow-y-auto custom-scrollbar p-2 space-y-1 relative">
        {loading ? (
          <div className="py-6 text-center text-[10px] text-muted-foreground flex items-center justify-center gap-2">
            <Loader2 className="w-3 h-3 animate-spin" /> Carregando histórico…
          </div>
        ) : entries.length === 0 ? (
          <div className="py-6 text-center text-[10px] text-muted-foreground flex flex-col items-center gap-1.5">
            <Send className="w-4 h-4 opacity-30" />
            <span>Nada por aqui ainda. Quando a automação rodar, eventos aparecem ao vivo.</span>
          </div>
        ) : (
          entries.map(e => {
            const meta = KIND_META[e.kind];
            const Icon = meta.icon;
            return (
              <div key={e.id} className={cn("flex items-start gap-2 p-2 rounded-md border text-[11px]", LEVEL_BG[e.level])}>
                <Icon className={cn("w-3 h-3 shrink-0 mt-0.5", meta.color)} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 text-[9px] font-mono text-muted-foreground">
                    <span>{new Date(e.ts).toLocaleTimeString("pt-BR")}</span>
                    <span className={cn("uppercase font-bold", meta.color)}>{meta.label}</span>
                    {e.remote_jid && (
                      <span className="text-cyan-400/70">· {(e.remote_jid || "").replace(/@.*$/, "")}</span>
                    )}
                  </div>
                  <p className="text-white/85 break-words whitespace-pre-wrap leading-snug">{e.message}</p>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
