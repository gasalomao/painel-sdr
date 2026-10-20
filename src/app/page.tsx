"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Activity,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  MessageSquare,
  Plus,
  Radio,
  Send,
  Smartphone,
  Target,
  Users,
} from "lucide-react";
import { Header } from "@/components/layout/header";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DashboardCalendarWidget } from "@/components/dashboard-calendar-widget";
import { DashboardRemindersWidget } from "@/components/dashboard-reminders-widget";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import styles from "./dashboard.module.css";

interface Metrics {
  totalLeads: number;
  leadsHoje: number;
  conversasHoje: number;
  agendamentosHoje: number;
  instanciasOnline: number;
  disparosAtivos: number;
  followUpCampanhas: number;
  iaInteracoesHoje: number;
}

interface RecentLead {
  id: number;
  nome_negocio: string;
  ramo_negocio: string;
  created_at: string;
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Bom dia";
  if (hour < 18) return "Boa tarde";
  return "Boa noite";
}

function BlockedFeatureBanner() {
  const [blocked, setBlocked] = useState<string | null>(null);

  useEffect(() => {
    // window.location.search só existe pós-mount (SSR-safe) — não dá pra derivar em render.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBlocked(new URLSearchParams(window.location.search).get("blocked"));
  }, []);

  if (!blocked) return null;

  return (
    <div className="flex items-start gap-3 rounded-xl border border-amber-500/25 bg-amber-500/10 p-4 text-sm text-amber-100">
      <div>
        <p className="font-semibold">Módulo indisponível</p>
        <p className="mt-1 text-amber-100/75">O módulo “{blocked}” não está liberado para esta conta.</p>
      </div>
    </div>
  );
}

export default function DashboardPage(): React.JSX.Element {
  const [metrics, setMetrics] = useState<Metrics>({
    totalLeads: 0,
    leadsHoje: 0,
    conversasHoje: 0,
    agendamentosHoje: 0,
    instanciasOnline: 0,
    disparosAtivos: 0,
    followUpCampanhas: 0,
    iaInteracoesHoje: 0,
  });
  const [recentLeads, setRecentLeads] = useState<RecentLead[]>([]);
  const [loading, setLoading] = useState(true);
  const [userName, setUserName] = useState("");
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [isAdminView, setIsAdminView] = useState(false);

  useEffect(() => {
    async function loadDashboard() {
      try {
        const sessionResponse = await fetch("/api/auth/session");
        const session = await sessionResponse.json();
        if (!session?.authenticated) return;

        setUserName(session.name ? String(session.name).split(" ")[0] || "" : "");
        setFeatures(session.features || {});
        const isAdmin = !!session.isAdmin && !session.impersonating;
        setIsAdminView(isAdmin);

        const clientId = session.clientId;
        if (!isAdmin && !clientId) return;

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        let totalLeadsQuery = supabase.from("leads_extraidos").select("*", { count: "exact", head: true });
        let leadsTodayQuery = supabase.from("leads_extraidos").select("*", { count: "exact", head: true }).gte("created_at", today.toISOString());
        let conversationsTodayQuery = supabase.from("chats_dashboard").select("remote_jid").gte("created_at", today.toISOString()).limit(2000);
        let appointmentsTodayQuery = supabase.from("appointments").select("*", { count: "exact", head: true }).gte("start_at", today.toISOString()).lt("start_at", tomorrow.toISOString()).in("status", ["confirmed", "tentative"]);
        let onlineInstancesQuery = supabase.from("channel_connections").select("*", { count: "exact", head: true }).eq("status", "open");
        let campaignsQuery = supabase.from("campaigns").select("*", { count: "exact", head: true }).in("status", ["running", "sending"]);
        let followUpsQuery = supabase.from("followup_campaigns").select("*", { count: "exact", head: true }).in("status", ["running", "sending"]);
        let aiTodayQuery = supabase.from("chats_dashboard").select("*", { count: "exact", head: true }).eq("sender_type", "ai").gte("created_at", today.toISOString());
        let recentLeadsQuery = supabase.from("leads_extraidos").select("id, nome_negocio, ramo_negocio, created_at").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(6);

        if (clientId) {
          totalLeadsQuery = totalLeadsQuery.eq("client_id", clientId);
          leadsTodayQuery = leadsTodayQuery.eq("client_id", clientId);
          conversationsTodayQuery = conversationsTodayQuery.eq("client_id", clientId);
          appointmentsTodayQuery = appointmentsTodayQuery.eq("client_id", clientId);
          onlineInstancesQuery = onlineInstancesQuery.eq("client_id", clientId);
          campaignsQuery = campaignsQuery.eq("client_id", clientId);
          followUpsQuery = followUpsQuery.eq("client_id", clientId);
          aiTodayQuery = aiTodayQuery.eq("client_id", clientId);
          recentLeadsQuery = recentLeadsQuery.eq("client_id", clientId);
        }

        const [
          { count: totalLeads },
          { count: leadsHoje },
          { data: conversations },
          { count: agendamentosHoje },
          { count: instanciasOnline },
          { count: disparosAtivos },
          { count: followUpCampanhas },
          { count: iaInteracoesHoje },
          { data: recentLeadsData },
        ] = await Promise.all([
          totalLeadsQuery,
          leadsTodayQuery,
          conversationsTodayQuery,
          appointmentsTodayQuery,
          onlineInstancesQuery,
          campaignsQuery,
          followUpsQuery,
          aiTodayQuery,
          recentLeadsQuery,
        ]);

        setMetrics({
          totalLeads: totalLeads || 0,
          leadsHoje: leadsHoje || 0,
          conversasHoje: new Set((conversations || []).map((conversation: { remote_jid: string }) => conversation.remote_jid)).size,
          agendamentosHoje: agendamentosHoje || 0,
          instanciasOnline: instanciasOnline || 0,
          disparosAtivos: disparosAtivos || 0,
          followUpCampanhas: followUpCampanhas || 0,
          iaInteracoesHoje: iaInteracoesHoje || 0,
        });
        setRecentLeads(recentLeadsData || []);
      } catch (error) {
        console.error("Erro ao carregar dashboard:", error);
      } finally {
        setLoading(false);
      }
    }

    loadDashboard();
    const interval = window.setInterval(loadDashboard, 30000);
    return () => window.clearInterval(interval);
  }, []);

  const hasFeature = (key: string) => isAdminView || features[key] !== false;
  const isFirstTime = !loading && metrics.totalLeads === 0 && metrics.instanciasOnline === 0 && metrics.iaInteracoesHoje === 0;

  const primaryMetrics = [
    { label: "Novos leads", value: metrics.leadsHoje, description: "captados hoje", icon: Users, href: "/leads", feature: "leads" },
    { label: "Conversas", value: metrics.conversasHoje, description: "movimentadas hoje", icon: MessageSquare, href: "/chat", feature: "chat" },
    { label: "Agenda", value: metrics.agendamentosHoje, description: "agendamentos hoje", icon: CalendarDays, href: "/calendario", feature: "calendario" },
    { label: "WhatsApp", value: metrics.instanciasOnline, description: "números conectados", icon: Smartphone, href: "/whatsapp", feature: "whatsapp" },
  ].filter((metric) => hasFeature(metric.feature));

  const attentionItems = [
    metrics.instanciasOnline === 0 && hasFeature("whatsapp")
      ? { title: "Conecte seu WhatsApp", description: "Nenhum número está conectado para atender os contatos.", href: "/whatsapp", action: "Conectar", icon: Smartphone, tone: "text-amber-300 bg-amber-500/10" }
      : null,
    metrics.agendamentosHoje > 0 && hasFeature("calendario")
      ? { title: `${metrics.agendamentosHoje} agendamento${metrics.agendamentosHoje > 1 ? "s" : ""} hoje`, description: "Revise os horários e prepare o atendimento.", href: "/calendario", action: "Ver agenda", icon: CalendarDays, tone: "text-emerald-300 bg-emerald-500/10" }
      : null,
    metrics.followUpCampanhas > 0 && hasFeature("followup")
      ? { title: `${metrics.followUpCampanhas} follow-up${metrics.followUpCampanhas > 1 ? "s" : ""} em execução`, description: "Acompanhe as campanhas ativas.", href: "/follow-up", action: "Acompanhar", icon: Activity, tone: "text-violet-300 bg-violet-500/10" }
      : null,
    metrics.disparosAtivos > 0 && hasFeature("disparo")
      ? { title: `${metrics.disparosAtivos} disparo${metrics.disparosAtivos > 1 ? "s" : ""} em andamento`, description: "Confira o andamento das campanhas.", href: "/disparo", action: "Ver disparos", icon: Send, tone: "text-cyan-300 bg-cyan-500/10" }
      : null,
  ].filter(Boolean) as Array<{ title: string; description: string; href: string; action: string; icon: typeof Activity; tone: string }>;

  return (
    <div className={cn(styles.dashboard, "flex h-[100dvh] flex-col overflow-y-auto")}>
      <Header />
      <main className={cn(styles.content, "mx-auto w-full max-w-[1440px] flex-1 space-y-6 p-4 sm:p-6 lg:p-8")}>
        <BlockedFeatureBanner />

        <section className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Visão geral da operação</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{greeting()}{userName ? `, ${userName}` : ""}. Acompanhe o que precisa de atenção hoje.</p>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {hasFeature("captador") && (
              <Link href="/captador" className={cn(buttonVariants({ variant: "outline" }), "min-h-11 gap-2 px-4")}><Target className="size-4" aria-hidden="true" /> Captar leads</Link>
            )}
            {hasFeature("leads") && (
              <Link href="/leads" className={cn(buttonVariants(), "min-h-11 gap-2 px-4")}><Plus className="size-4" aria-hidden="true" /> Novo lead</Link>
            )}
          </div>
        </section>

        {isFirstTime && (
          <Card className="border border-primary/20 bg-primary/[0.06] shadow-none ring-0">
            <CardContent className="flex flex-col gap-4 py-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-semibold">Comece conectando seu canal de atendimento</p>
                <p className="mt-1 text-sm text-muted-foreground">Depois configure o agente e comece a captar seus primeiros leads.</p>
              </div>
              {hasFeature("whatsapp") && <Link href="/whatsapp" className={cn(buttonVariants(), "min-h-11 gap-2 px-4")}>Conectar WhatsApp <ArrowRight className="size-4" aria-hidden="true" /></Link>}
            </CardContent>
          </Card>
        )}

        {primaryMetrics.length > 0 && (
          <section aria-label="Resumo da operação" aria-busy={loading} className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border lg:grid-cols-4">
            {primaryMetrics.map((metric) => {
              const Icon = metric.icon;
              return (
                <Link key={metric.label} href={metric.href} className="group min-w-0 bg-card p-4 transition-colors hover:bg-secondary focus-visible:relative focus-visible:z-10 focus-visible:-outline-offset-4 sm:p-5">
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    <p className="text-xs font-medium sm:text-sm">{metric.label}</p>
                    <ChevronRight className="ml-auto hidden size-3.5 text-muted-foreground group-hover:text-foreground sm:block" aria-hidden="true" />
                  </div>
                  <p className="mt-4 text-3xl font-semibold tabular-nums tracking-tight">{loading ? "—" : metric.value.toLocaleString("pt-BR")}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{metric.description}</p>
                </Link>
              );
            })}
          </section>
        )}

        <section className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.7fr)]">
          <div className="min-w-0 space-y-6">
            <DashboardRemindersWidget />

            <Card className="border border-border bg-card py-0 shadow-none ring-0">
              <CardContent className="p-0">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 sm:px-6">
                  <div><h2 className="text-base font-semibold">Leads recentes</h2><p className="mt-1 text-xs leading-relaxed text-muted-foreground">Últimos contatos adicionados à sua base.</p></div>
                  {hasFeature("leads") && <Link href="/leads" className={cn(buttonVariants({ variant: "ghost", size: "sm" }), "min-h-11 gap-2")}>Ver todos <ArrowRight className="size-3.5" aria-hidden="true" /></Link>}
                </div>
                {loading ? (
                  <div className="space-y-3 p-5 sm:p-6">{[1, 2, 3].map((item) => <div key={item} className="h-11 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" />)}</div>
                ) : recentLeads.length === 0 ? (
                  <div className="px-5 py-10 text-center"><Users className="mx-auto mb-3 size-6 text-muted-foreground" aria-hidden="true" /><p className="font-medium">Nenhum lead cadastrado</p><p className="mt-1 text-sm text-muted-foreground">Capte pelo Maps ou adicione um contato manualmente.</p></div>
                ) : (
                  <div className="divide-y divide-border">
                    {recentLeads.map((lead) => (
                      <Link key={lead.id} href={`/leads?openLeadId=${lead.id}`} className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-muted/50 focus-visible:-outline-offset-4 sm:px-6">
                        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-sm font-semibold text-muted-foreground" aria-hidden="true">{(lead.nome_negocio || "?")[0].toUpperCase()}</div>
                        <div className="min-w-0 flex-1"><p className="truncate font-medium">{lead.nome_negocio || "Sem nome"}</p><p className="mt-0.5 truncate text-xs text-muted-foreground">{lead.ramo_negocio || "Sem categoria"}</p></div>
                        <Badge variant="secondary" className="hidden border-0 bg-transparent font-normal tabular-nums text-muted-foreground sm:inline-flex">{new Date(lead.created_at).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}</Badge>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      </Link>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="min-w-0 space-y-6">
            <Card className="border border-border bg-card py-0 shadow-none ring-0">
              <CardContent className="p-0">
                <div className="border-b border-border px-5 py-4">
                  <h2 className="text-base font-semibold">Prioridades</h2>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Ações que merecem sua atenção agora.</p>
                </div>
                {loading ? (
                  <div className="space-y-3 p-5"><div className="h-16 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" /><div className="h-16 animate-pulse rounded-lg bg-muted motion-reduce:animate-none" /></div>
                ) : attentionItems.length === 0 ? (
                  <div className="flex flex-col items-center justify-center px-5 py-8 text-center">
                    <CheckCircle2 className="size-7 text-emerald-300" aria-hidden="true" />
                    <p className="mt-3 font-medium">Nenhuma ação urgente</p>
                    <p className="mt-1 text-sm leading-relaxed text-muted-foreground">Sua operação está em dia neste momento.</p>
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {attentionItems.map((item) => {
                      const Icon = item.icon;
                      return (
                        <Link key={item.title} href={item.href} className="group flex items-start gap-3 px-5 py-4 transition-colors hover:bg-muted/50 focus-visible:-outline-offset-4">
                          <div className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", item.tone)}><Icon className="size-4" aria-hidden="true" /></div>
                          <div className="min-w-0 flex-1"><p className="font-medium leading-snug">{item.title}</p><p className="mt-1 text-xs leading-relaxed text-muted-foreground">{item.description}</p><span className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-primary">{item.action}<ChevronRight className="size-3.5" aria-hidden="true" /></span></div>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </CardContent>
            </Card>
            {hasFeature("calendario") && <DashboardCalendarWidget />}
            <Card className="border border-border bg-card py-0 shadow-none ring-0">
              <CardContent className="p-5">
                <div className="flex items-center gap-2"><Radio className="size-4 text-primary" aria-hidden="true" /><h2 className="text-base font-semibold">Operação agora</h2></div>
                <dl className="mt-4 divide-y divide-border text-sm">
                  <div className="flex items-center justify-between gap-3 py-3"><dt className="text-muted-foreground">Leads na base</dt><dd className="font-medium tabular-nums">{loading ? "—" : metrics.totalLeads.toLocaleString("pt-BR")}</dd></div>
                  <div className="flex items-center justify-between gap-3 py-3"><dt className="text-muted-foreground">Respostas da IA hoje</dt><dd className="font-medium tabular-nums">{loading ? "—" : metrics.iaInteracoesHoje.toLocaleString("pt-BR")}</dd></div>
                  <div className="flex items-center justify-between gap-3 pt-3"><dt className="text-muted-foreground">Campanhas ativas</dt><dd className="font-medium tabular-nums">{loading ? "—" : (metrics.disparosAtivos + metrics.followUpCampanhas).toLocaleString("pt-BR")}</dd></div>
                </dl>
              </CardContent>
            </Card>
          </div>
        </section>
      </main>
    </div>
  );
}
