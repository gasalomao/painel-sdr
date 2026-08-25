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
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { DashboardCalendarWidget } from "@/components/dashboard-calendar-widget";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";

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

export default function DashboardPage() {
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
    { label: "Novos leads", value: metrics.leadsHoje, description: "captados hoje", icon: Users, href: "/leads", feature: "leads", accent: "text-blue-300 bg-blue-500/10 border-blue-400/15" },
    { label: "Conversas", value: metrics.conversasHoje, description: "movimentadas hoje", icon: MessageSquare, href: "/chat", feature: "chat", accent: "text-violet-300 bg-violet-500/10 border-violet-400/15" },
    { label: "Agenda", value: metrics.agendamentosHoje, description: "agendamentos hoje", icon: CalendarDays, href: "/calendario", feature: "calendario", accent: "text-emerald-300 bg-emerald-500/10 border-emerald-400/15" },
    { label: "WhatsApp", value: metrics.instanciasOnline, description: "números conectados", icon: Smartphone, href: "/whatsapp", feature: "whatsapp", accent: "text-cyan-300 bg-cyan-500/10 border-cyan-400/15" },
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
    <div className="flex h-[100dvh] flex-col overflow-y-auto">
      <Header />
      <main className="mobile-safe-bottom mx-auto w-full max-w-[1440px] flex-1 space-y-6 p-4 sm:p-6 lg:p-8">
        <BlockedFeatureBanner />

        <section className="flex flex-col gap-5 border-b border-white/[0.07] pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{greeting()}{userName ? `, ${userName}` : ""}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight sm:text-3xl">Visão geral da operação</h1>
            <p className="mt-2 text-sm text-muted-foreground">Acompanhe o que precisa de atenção hoje.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {hasFeature("captador") && (
              <Link href="/captador"><Button variant="outline" className="gap-2"><Target className="size-4" /> Captar leads</Button></Link>
            )}
            {hasFeature("leads") && (
              <Link href="/leads"><Button className="gap-2"><Plus className="size-4" /> Novo lead</Button></Link>
            )}
          </div>
        </section>

        {isFirstTime && (
          <Card className="border-primary/20 bg-primary/[0.06] shadow-none">
            <CardContent className="flex flex-col gap-4 py-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-semibold">Comece conectando seu canal de atendimento</p>
                <p className="mt-1 text-sm text-muted-foreground">Depois configure o agente e comece a captar seus primeiros leads.</p>
              </div>
              {hasFeature("whatsapp") && <Link href="/whatsapp"><Button className="gap-2">Conectar WhatsApp <ArrowRight className="size-4" /></Button></Link>}
            </CardContent>
          </Card>
        )}

        {primaryMetrics.length > 0 && (
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {primaryMetrics.map((metric) => {
              const Icon = metric.icon;
              return (
                <Link key={metric.label} href={metric.href} className="group">
                  <Card className="h-full border-white/[0.08] bg-card/80 py-0 shadow-none transition-colors hover:border-white/15 hover:bg-card">
                    <CardContent className="p-4 sm:p-5">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-xs font-medium text-muted-foreground">{metric.label}</p>
                          <p className="mt-2 text-3xl font-semibold tracking-tight">{loading ? "—" : metric.value.toLocaleString("pt-BR")}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{metric.description}</p>
                        </div>
                        <div className={cn("flex size-9 items-center justify-center rounded-lg border", metric.accent)}><Icon className="size-4" /></div>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </section>
        )}

        <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
          <Card className="border-white/[0.08] bg-card/80 py-0 shadow-none">
            <CardContent className="p-0">
              <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4 sm:px-6">
                <div>
                  <h2 className="font-semibold">Prioridades</h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">Ações que merecem sua atenção agora.</p>
                </div>
              </div>
              {loading ? (
                <div className="space-y-3 p-5 sm:p-6"><div className="h-16 animate-pulse rounded-lg bg-white/[0.04]" /><div className="h-16 animate-pulse rounded-lg bg-white/[0.04]" /></div>
              ) : attentionItems.length === 0 ? (
                <div className="flex flex-col items-center justify-center px-5 py-12 text-center">
                  <div className="flex size-10 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-300"><CheckCircle2 className="size-5" /></div>
                  <p className="mt-3 font-medium">Nenhuma ação urgente</p>
                  <p className="mt-1 text-sm text-muted-foreground">Sua operação está em dia neste momento.</p>
                </div>
              ) : (
                <div className="divide-y divide-white/[0.06]">
                  {attentionItems.map((item) => {
                    const Icon = item.icon;
                    return <Link key={item.title} href={item.href} className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-white/[0.03] sm:px-6"><div className={cn("flex size-9 shrink-0 items-center justify-center rounded-lg", item.tone)}><Icon className="size-4" /></div><div className="min-w-0 flex-1"><p className="font-medium">{item.title}</p><p className="mt-0.5 truncate text-sm text-muted-foreground">{item.description}</p></div><span className="hidden text-sm font-medium text-primary sm:inline">{item.action}</span><ChevronRight className="size-4 text-muted-foreground" /></Link>;
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <div className="space-y-6">
            {hasFeature("calendario") && <DashboardCalendarWidget />}
            <Card className="border-white/[0.08] bg-card/80 py-0 shadow-none">
              <CardContent className="p-5">
                <div className="flex items-center gap-2"><Radio className="size-4 text-primary" /><h2 className="font-semibold">Operação agora</h2></div>
                <div className="mt-4 space-y-3 text-sm">
                  <div className="flex items-center justify-between"><span className="text-muted-foreground">Leads na base</span><span className="font-medium">{loading ? "—" : metrics.totalLeads.toLocaleString("pt-BR")}</span></div>
                  <div className="flex items-center justify-between"><span className="text-muted-foreground">Respostas da IA hoje</span><span className="font-medium">{loading ? "—" : metrics.iaInteracoesHoje.toLocaleString("pt-BR")}</span></div>
                  <div className="flex items-center justify-between"><span className="text-muted-foreground">Campanhas ativas</span><span className="font-medium">{loading ? "—" : (metrics.disparosAtivos + metrics.followUpCampanhas).toLocaleString("pt-BR")}</span></div>
                </div>
              </CardContent>
            </Card>
          </div>
        </section>

        <Card className="border-white/[0.08] bg-card/80 py-0 shadow-none">
          <CardContent className="p-0">
            <div className="flex items-center justify-between border-b border-white/[0.07] px-5 py-4 sm:px-6">
              <div><h2 className="font-semibold">Leads recentes</h2><p className="mt-0.5 text-xs text-muted-foreground">Últimos contatos adicionados à sua base.</p></div>
              {hasFeature("leads") && <Link href="/leads"><Button variant="ghost" size="sm" className="gap-1">Ver todos <ArrowRight className="size-3.5" /></Button></Link>}
            </div>
            {loading ? (
              <div className="space-y-3 p-5 sm:p-6">{[1, 2, 3].map((item) => <div key={item} className="h-11 animate-pulse rounded-lg bg-white/[0.04]" />)}</div>
            ) : recentLeads.length === 0 ? (
              <div className="px-5 py-12 text-center"><p className="font-medium">Nenhum lead cadastrado</p><p className="mt-1 text-sm text-muted-foreground">Capte pelo Maps ou adicione um contato manualmente.</p></div>
            ) : (
              <div className="divide-y divide-white/[0.06]">
                {recentLeads.map((lead) => <Link key={lead.id} href="/leads" className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-white/[0.03] sm:px-6"><div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">{(lead.nome_negocio || "?")[0].toUpperCase()}</div><div className="min-w-0 flex-1"><p className="truncate font-medium">{lead.nome_negocio || "Sem nome"}</p><p className="mt-0.5 truncate text-xs text-muted-foreground">{lead.ramo_negocio || "Sem categoria"}</p></div><Badge variant="secondary" className="hidden border-0 bg-white/[0.05] text-muted-foreground sm:inline-flex">{new Date(lead.created_at).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}</Badge><ChevronRight className="size-4 text-muted-foreground" /></Link>)}
              </div>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}
