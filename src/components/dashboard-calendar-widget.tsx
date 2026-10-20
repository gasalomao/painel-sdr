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
import { CalendarDays, ChevronRight, Loader2 } from "lucide-react";
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

export function DashboardCalendarWidget(): React.JSX.Element | null {
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
    <Card className="overflow-hidden border border-border bg-card py-0 shadow-none ring-0">
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <div className="min-w-0">
            <h2 className="text-base font-semibold">Próximos agendamentos</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">30 dias adiante</p>
          </div>
          <Link
            href="/calendario"
            className="flex min-h-11 shrink-0 items-center gap-1 text-xs font-medium text-primary underline-offset-4 hover:underline"
          >
            Ver tudo <ChevronRight className="size-3.5" aria-hidden="true" />
          </Link>
        </div>

        {/* Stats — 3 contadores */}
        <div className="grid grid-cols-3 divide-x divide-border border-y border-border py-3">
          <Stat label="Hoje" value={stats.hoje} loading={loading} />
          <Stat label="7 dias" value={stats.semana} loading={loading} />
          <Stat label="30 dias" value={stats.mes} loading={loading} />
        </div>

        {/* Lista dos 5 próximos */}
        {loading ? (
          <div role="status" className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            <span className="text-xs">Carregando…</span>
          </div>
        ) : appts.length === 0 ? (
          <div className="px-2 py-5 text-center">
            <CalendarDays className="mx-auto mb-3 size-6 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground">Nenhum agendamento nos próximos 30 dias.</p>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">A IA agendará automaticamente quando o lead pedir.</p>
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
                  <div className="flex w-14 shrink-0 flex-col items-center gap-1 text-xs tabular-nums">
                    <span className="text-xs text-muted-foreground">{fmtDay(a.start_at)}</span>
                    <span className="font-semibold text-foreground">{fmtTime(a.start_at)}</span>
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold truncate">{a.title}</p>
                    {a.service_name && (
                      <p className="mt-1 truncate text-xs text-muted-foreground">{a.service_name}</p>
                    )}
                  </div>
                  {badge && (
                    <Badge className={cn("mt-0.5 shrink-0 border-0 text-[11px] font-medium", badge.color)}>
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

function Stat({ label, value, loading }: { label: string; value: number; loading: boolean }): React.JSX.Element {
  return (
    <div className="px-2 text-center">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{loading ? "—" : value}</p>
    </div>
  );
}
