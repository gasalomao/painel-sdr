"use client";

/**
 * Widget de "Próximos agendamentos" pro Dashboard.
 *
 * Aparece SOMENTE se o cliente tem a feature `calendario` liberada
 * (admin sempre tem). Em conta sem a feature, retorna null silenciosamente.
 *
 * Mostra:
 *   - Stats da semana (total / próximos 7 dias / hoje)
 *   - Próximos 5 agendamentos confirmados/tentativos, com badge de
 *     "AMANHÃ" / "EM N DIAS" pra dar urgência visual.
 *   - Link pra /calendario.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CalendarDays, ChevronRight, Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useClientSession } from "@/lib/use-session";
import { supabase } from "@/lib/supabase";

interface Appointment {
  id: string;
  title: string;
  start_at: string;
  end_at: string;
  status: string;
  remote_jid: string;
  service_name?: string | null;
}

function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function fmtDay(iso: string) {
  return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

export function DashboardCalendarWidget() {
  const { session, loading: sessionLoading } = useClientSession();
  const [appts, setAppts] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState({ semana: 0, hoje: 0, mes: 0 });

  // Feature gate — calendário precisa estar liberado pro cliente. Admin
  // (não-impersonando) bypassa. Default = true se feature não setada.
  const isAdmin = !!session?.isAdmin && !session?.impersonating;
  const featureOn = isAdmin || (session?.features?.calendario !== false);

  useEffect(() => {
    if (sessionLoading) return;
    if (!featureOn || !session?.clientId) {
      setLoading(false);
      return;
    }

    async function load() {
      try {
        const today = startOfDay(new Date());
        const in30 = new Date(today);
        in30.setDate(in30.getDate() + 30);
        const in7 = new Date(today);
        in7.setDate(in7.getDate() + 7);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Query: próximos 30 dias, status confirmed/tentative
        let q = supabase
          .from("appointments")
          .select("id, title, start_at, end_at, status, remote_jid, service_name")
          .gte("start_at", today.toISOString())
          .lt("start_at", in30.toISOString())
          .in("status", ["confirmed", "tentative"])
          .order("start_at", { ascending: true });
        if (session && session.clientId) q = q.eq("client_id", session.clientId);

        const { data } = await q;
        const list = (data || []) as Appointment[];

        const hojeCount = list.filter((a) => new Date(a.start_at) < tomorrow).length;
        const semanaCount = list.filter((a) => new Date(a.start_at) < in7).length;
        setStats({ hoje: hojeCount, semana: semanaCount, mes: list.length });
        setAppts(list.slice(0, 5));
      } catch (e) {
        console.warn("[DashboardCalendarWidget] erro:", e);
      } finally {
        setLoading(false);
      }
    }
    load();
  // session pode mudar (logout etc), refetch
  }, [sessionLoading, featureOn, session?.clientId, session?.isAdmin, session?.impersonating]);

  if (sessionLoading) return null;
  if (!featureOn) return null; // cliente sem feature: widget some

  const today = startOfDay(new Date()).getTime();

  return (
    <Card className="glass-card border-none hover-float transition-all duration-500 overflow-hidden">
      <CardContent className="p-5 sm:p-6 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/15 ring-1 ring-emerald-500/20 flex items-center justify-center shrink-0">
              <CalendarDays className="w-5 h-5 text-emerald-300" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-black tracking-tight">Próximos agendamentos</h3>
              <p className="text-[10px] uppercase tracking-widest text-muted-foreground font-bold">
                30 dias adiante
              </p>
            </div>
          </div>
          <Link
            href="/calendario"
            className="text-[10px] font-bold uppercase tracking-wider text-emerald-300 hover:text-emerald-200 flex items-center gap-1 shrink-0"
          >
            Ver tudo <ChevronRight className="w-3 h-3" />
          </Link>
        </div>

        {/* Stats — 3 contadores */}
        <div className="grid grid-cols-3 gap-2">
          <Stat label="Hoje" value={stats.hoje} accent="primary" />
          <Stat label="7 dias" value={stats.semana} accent="emerald" />
          <Stat label="30 dias" value={stats.mes} accent="cyan" />
        </div>

        {/* Lista dos 5 próximos */}
        {loading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground gap-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-xs">Carregando…</span>
          </div>
        ) : appts.length === 0 ? (
          <div className="text-center py-6 px-4 border border-dashed border-white/10 rounded-xl">
            <Sparkles className="w-6 h-6 mx-auto mb-2 text-muted-foreground/40" />
            <p className="text-xs text-muted-foreground">Nenhum agendamento nos próximos 30 dias.</p>
            <p className="text-[10px] text-muted-foreground/60 mt-1">A IA agendará automaticamente quando o lead pedir.</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {appts.map((a) => {
              const d = startOfDay(new Date(a.start_at)).getTime();
              const daysAhead = Math.round((d - today) / (1000 * 60 * 60 * 24));
              let badge: { label: string; color: string } | null = null;
              if (daysAhead === 0) badge = { label: "HOJE", color: "bg-primary/15 text-primary ring-1 ring-primary/20" };
              else if (daysAhead === 1) badge = { label: "AMANHÃ", color: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/20" };
              else if (daysAhead <= 3) badge = { label: `${daysAhead}d`, color: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/20" };
              else if (daysAhead <= 7) badge = { label: `${daysAhead}d`, color: "bg-cyan-500/15 text-cyan-300 ring-1 ring-cyan-500/20" };
              else badge = { label: `${daysAhead}d`, color: "bg-white/5 text-muted-foreground ring-1 ring-white/10" };

              return (
                <li
                  key={a.id}
                  className={cn(
                    "flex items-start gap-3 p-2.5 rounded-lg transition-colors",
                    "hover:bg-white/5 border border-transparent",
                    daysAhead <= 3 && "bg-emerald-500/[0.03] border-emerald-500/15",
                    daysAhead === 0 && "bg-primary/[0.05] border-primary/20"
                  )}
                >
                  <div className="flex flex-col items-center w-12 shrink-0 text-xs font-mono">
                    <span className="text-[10px] text-muted-foreground uppercase">{fmtDay(a.start_at)}</span>
                    <span className="font-bold text-foreground">{fmtTime(a.start_at)}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate">{a.title}</p>
                    {a.service_name && (
                      <p className="text-[10px] text-muted-foreground truncate">{a.service_name}</p>
                    )}
                  </div>
                  {badge && (
                    <Badge className={cn("text-[9px] font-bold border-0 shrink-0 mt-0.5", badge.color)}>
                      {badge.label}
                    </Badge>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent: "primary" | "emerald" | "cyan" }) {
  const colors = {
    primary: "bg-primary/10 text-primary ring-1 ring-primary/20",
    emerald: "bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/20",
    cyan: "bg-cyan-500/10 text-cyan-300 ring-1 ring-cyan-500/20",
  };
  return (
    <div className={cn("rounded-xl px-3 py-2 text-center", colors[accent])}>
      <p className="text-[9px] uppercase font-bold tracking-widest opacity-80">{label}</p>
      <p className="text-xl font-black tracking-tight mt-0.5">{value}</p>
    </div>
  );
}
