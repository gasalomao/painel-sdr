"use client";

import { useEffect, useState } from "react";
import { Header } from "@/components/layout/header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Users, MessageSquare, Zap, Target, BarChart3, Sparkles,
  ArrowUpRight, Bot, Repeat, Send, Smartphone, Workflow,
  Coins, TrendingUp, Radio, BrainCircuit, Rocket, CheckCircle2,
} from "lucide-react";
import { supabase } from "@/lib/supabase";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { DashboardCalendarWidget } from "@/components/dashboard-calendar-widget";

interface Metrics {
  totalLeads: number;
  leadsHoje: number;
  conversasAtivas: number;
  followUpsPendentes: number;
  // Automações
  disparosAtivos: number;
  disparosEnviados: number;
  followUpCampanhas: number;
  followUpEnviados: number;
  automacoesAtivas: number;
  tokensHoje: number;
  instanciasOnline: number;
  iaInteracoesHoje: number;
}

interface RecentLead {
  id: number;
  nome_negocio: string;
  ramo_negocio: string;
  created_at: string;
}

/** Saudação por horário de SP (0-5 = madrugada; 6-11 = manhã; 12-17 = tarde; 18-23 = noite). */
function greeting(): string {
  const h = new Date().getHours();
  if (h < 6) return "Boa madrugada";
  if (h < 12) return "Bom dia";
  if (h < 18) return "Boa tarde";
  return "Boa noite";
}

function BlockedFeatureBanner() {
  const [blocked, setBlocked] = useState<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    setBlocked(sp.get("blocked"));
  }, []);
  if (!blocked) return null;
  return (
    <div className="p-4 rounded-2xl border border-amber-500/30 bg-amber-500/10 text-amber-200 text-sm flex items-start gap-3">
      <div className="text-2xl">🔒</div>
      <div>
        <p className="font-bold">Módulo "{blocked}" não está liberado pra sua conta.</p>
        <p className="text-xs text-amber-200/80 mt-1">
          Fale com o administrador pra liberar esse módulo. Você foi redirecionado pra cá automaticamente.
        </p>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [metrics, setMetrics] = useState<Metrics>({
    totalLeads: 0, leadsHoje: 0, conversasAtivas: 0, followUpsPendentes: 0,
    disparosAtivos: 0, disparosEnviados: 0, followUpCampanhas: 0, followUpEnviados: 0,
    automacoesAtivas: 0, tokensHoje: 0, instanciasOnline: 0, iaInteracoesHoje: 0,
  });
  const [recentLeads, setRecentLeads] = useState<RecentLead[]>([]);
  const [loading, setLoading] = useState(true);
  // Nome do usuário pra saudação personalizada no hero. Pega só o primeiro
  // nome ("Gabriel Salomão" → "Gabriel"). Vem da sessão JWT que já é
  // buscada abaixo — não adiciona request nova.
  const [userName, setUserName] = useState<string>("");
  // Features liberadas pro cliente — usado pra esconder cards/widgets de
  // módulos não-liberados. Admin (não-impersonando) ignora o filtro:
  // sempre vê tudo. Cliente comum só vê seções dos módulos ativos.
  const [features, setFeatures] = useState<Record<string, boolean>>({});
  const [isAdminView, setIsAdminView] = useState(false);

  useEffect(() => {
    async function fetchData() {
      try {
        const sessRes = await fetch("/api/auth/session");
        const session = await sessRes.json();
        if (!session?.authenticated) return;

        // Captura primeiro nome pra saudação no hero
        if (session.name) {
          setUserName(String(session.name).split(" ")[0] || "");
        }
        // Features liberadas + se é admin não-impersonando.
        setFeatures(session.features || {});
        setIsAdminView(!!session.isAdmin && !session.impersonating);

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayISO = today.toISOString();

        const cid = session.clientId;
        const isAdmin = !!session.isAdmin && !session.impersonating;

        // Defesa em profundidade: cliente comum SEM clientId é estado inválido
        // — evita vazar agregado global ("vê dados de todos os clientes").
        // Admin não-impersonando: continua agregando tudo (intencional).
        if (!isAdmin && !cid) {
          console.warn("[Dashboard] cliente sem clientId — bloqueando carregamento pra evitar leak cross-tenant");
          return;
        }

        // === Core metrics ===
        let totalLeadsQ = supabase.from("leads_extraidos").select("*", { count: "exact", head: true });
        let leadsHojeQ = supabase.from("leads_extraidos").select("*", { count: "exact", head: true }).gte("created_at", todayISO);
        let activeConvQ = supabase.from("chats_dashboard").select("remote_jid").limit(2000);

        if (cid) {
          totalLeadsQ = totalLeadsQ.eq("client_id", cid);
          leadsHojeQ = leadsHojeQ.eq("client_id", cid);
          activeConvQ = activeConvQ.eq("client_id", cid);
        }

        const [
          { count: totalLeads },
          { count: leadsHoje },
          { data: activeConversations },
        ] = await Promise.all([totalLeadsQ, leadsHojeQ, activeConvQ]);
        const uniqueSessions = new Set(activeConversations?.map((s: { remote_jid: string }) => s.remote_jid) || []);

        // === Automation metrics ===
        let disparosAtivosQ = supabase.from("campaigns").select("*", { count: "exact", head: true }).in("status", ["running", "sending"]);
        let disparosSentQ = supabase.from("campaigns").select("sent_count");
        let followUpCampanhasQ = supabase.from("followup_campaigns").select("*", { count: "exact", head: true }).in("status", ["running", "sending"]);
        let followUpSentQ = supabase.from("followup_campaigns").select("total_sent");
        let automacoesAtivasQ = supabase.from("automations").select("*", { count: "exact", head: true }).in("status", ["running"]);
        let tokensDataQ = supabase.from("ai_token_usage").select("total_tokens").gte("created_at", todayISO);
        let instanciasOnlineQ = supabase.from("channel_connections").select("*", { count: "exact", head: true }).eq("status", "open");
        let iaInteracoesHojeQ = supabase.from("chats_dashboard").select("*", { count: "exact", head: true }).eq("sender_type", "ai").gte("created_at", todayISO);

        if (cid) {
          disparosAtivosQ = disparosAtivosQ.eq("client_id", cid);
          disparosSentQ = disparosSentQ.eq("client_id", cid);
          followUpCampanhasQ = followUpCampanhasQ.eq("client_id", cid);
          followUpSentQ = followUpSentQ.eq("client_id", cid);
          automacoesAtivasQ = automacoesAtivasQ.eq("client_id", cid);
          tokensDataQ = tokensDataQ.eq("client_id", cid);
          instanciasOnlineQ = instanciasOnlineQ.eq("client_id", cid);
          iaInteracoesHojeQ = iaInteracoesHojeQ.eq("client_id", cid);
        }

        const [
          { count: disparosAtivos },
          { data: disparosSent },
          { count: followUpCampanhas },
          { data: followUpSent },
          { count: automacoesAtivas },
          { data: tokensData },
          { count: instanciasOnline },
          { count: iaInteracoesHoje },
        ] = await Promise.all([
          disparosAtivosQ, disparosSentQ, followUpCampanhasQ, followUpSentQ,
          automacoesAtivasQ, tokensDataQ, instanciasOnlineQ, iaInteracoesHojeQ,
        ]);

        const totalDisparosEnviados = (disparosSent || []).reduce((acc: number, c: any) => acc + (c.sent_count || 0), 0);
        const totalFollowUpEnviados = (followUpSent || []).reduce((acc: number, c: any) => acc + (c.total_sent || 0), 0);
        const totalTokensHoje = (tokensData || []).reduce((acc: number, t: any) => acc + (t.total_tokens || 0), 0);

        setMetrics({
          totalLeads: totalLeads || 0,
          leadsHoje: leadsHoje || 0,
          conversasAtivas: uniqueSessions.size,
          followUpsPendentes: followUpCampanhas || 0,
          disparosAtivos: disparosAtivos || 0,
          disparosEnviados: totalDisparosEnviados,
          followUpCampanhas: followUpCampanhas || 0,
          followUpEnviados: totalFollowUpEnviados,
          automacoesAtivas: automacoesAtivas || 0,
          tokensHoje: totalTokensHoje,
          instanciasOnline: instanciasOnline || 0,
          iaInteracoesHoje: iaInteracoesHoje || 0,
        });

        let recentQ = supabase
          .from("leads_extraidos")
          .select("id, nome_negocio, ramo_negocio, created_at")
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(8);
        if (cid) recentQ = recentQ.eq("client_id", cid);

        const { data: recent } = await recentQ;
        setRecentLeads(recent || []);
      } catch (err) {
        console.error("Erro ao carregar dashboard:", err);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
    const interval = setInterval(fetchData, 30000);
    return () => clearInterval(interval);
  }, []);

  // Helper: cliente vê a métrica se a feature está liberada.
  // Admin (não-impersonando) ignora — sempre vê tudo.
  // Default = true: se a feature não está setada, considera liberada
  // (compat com clientes antigos antes do sistema de features).
  const hasFeature = (key: string) => isAdminView || features[key] !== false;

  // === Primary Metric Cards (row 1) ===
  // hint: tooltip + microcopia abaixo do número pra usuário 1ª vez entender O QUE é.
  // href: ao clicar, drilla pra página relacionada (drill-down natural).
  // feature: chave em clients.features que controla se o card aparece pro cliente.
  const primaryCards = [
    { label: "Total de Clientes", value: metrics.totalLeads, icon: Users, color: "text-blue-400", bg: "bg-blue-400/20", border: "border-blue-400/20", hint: "leads e contatos cadastrados", href: "/leads", feature: "leads" },
    { label: "Clientes Hoje", value: metrics.leadsHoje, icon: Zap, color: "text-yellow-400", bg: "bg-yellow-400/20", border: "border-yellow-400/20", hint: "novos nas últimas 24h", href: "/leads", feature: "leads" },
    { label: "Sessões Ativas", value: metrics.conversasAtivas, icon: MessageSquare, color: "text-purple-400", bg: "bg-purple-400/20", border: "border-purple-400/20", hint: "conversas em andamento", href: "/chat", feature: "chat" },
    { label: "Instâncias On", value: metrics.instanciasOnline, icon: Smartphone, color: "text-emerald-400", bg: "bg-emerald-400/20", border: "border-emerald-400/20", hint: "números de WhatsApp conectados", href: "/whatsapp", feature: "whatsapp" },
  ].filter((c) => hasFeature(c.feature));

  // === Automation Metric Cards (row 2) ===
  const automationCards = [
    { label: "Disparos Ativos", value: metrics.disparosAtivos, icon: Send, color: "text-cyan-400", bg: "bg-cyan-400/20", border: "border-cyan-400/20", sub: `${metrics.disparosEnviados.toLocaleString("pt-BR")} enviados`, href: "/disparo", feature: "disparo" },
    { label: "Follow-ups", value: metrics.followUpCampanhas, icon: Repeat, color: "text-amber-400", bg: "bg-amber-400/20", border: "border-amber-400/20", sub: `${metrics.followUpEnviados.toLocaleString("pt-BR")} enviados`, href: "/follow-up", feature: "followup" },
    { label: "Automações", value: metrics.automacoesAtivas, icon: Workflow, color: "text-rose-400", bg: "bg-rose-400/20", border: "border-rose-400/20", sub: "rodando agora", href: "/automacao", feature: "automacao" },
    { label: "IA Hoje", value: metrics.iaInteracoesHoje, icon: BrainCircuit, color: "text-violet-400", bg: "bg-violet-400/20", border: "border-violet-400/20", sub: `${(metrics.tokensHoje / 1000).toFixed(0)}K tokens`, href: "/tokens", feature: "agente" },
  ].filter((c) => hasFeature(c.feature));

  // Detecta conta nova / sem dados — mostra card de onboarding em vez do hero
  // genérico de "está voando". Se TUDO está em zero, é primeira sessão.
  const isFirstTime = !loading
    && metrics.totalLeads === 0
    && metrics.instanciasOnline === 0
    && metrics.iaInteracoesHoje === 0;

  return (
    <div className="flex flex-col h-[100dvh] bg-transparent relative overflow-y-auto">
      <div className="absolute inset-0 pointer-events-none z-[-1]" />
      
      <Header />
      <main className="flex-1 p-3 sm:p-6 lg:p-10 space-y-4 sm:space-y-8 max-w-[1600px] mx-auto w-full z-10 relative mobile-safe-bottom">

        <BlockedFeatureBanner />

        {/* Hero — saudação humana adaptada ao horário + nome do usuário.
            Em vez de "Bem-vindo de volta" genérico, fica "Boa tarde, Gabriel".
            Subtítulo muda conforme tem dados ou não — usuário novo recebe
            convite pra começar, usuário ativo vê resumo. */}
        <section className="relative overflow-hidden p-5 sm:p-10 rounded-2xl sm:rounded-[2rem] glass-card animate-slide-up hover-float">
          <div className="absolute top-0 right-0 p-4 sm:p-8 opacity-20 pointer-events-none">
            <Sparkles className="w-12 sm:w-24 h-12 sm:h-24 text-primary animate-pulse-slow" />
          </div>
          <div className="relative z-10 space-y-3">
            <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 mb-2 px-3 py-1 text-[10px] sm:text-xs">
              ✨ {greeting()}{userName ? `, ${userName}` : ""}
            </Badge>
            <h1 className="text-2xl sm:text-4xl lg:text-5xl font-black tracking-tight text-gradient">
              {isFirstTime ? "Vamos começar?" : `${greeting()}${userName ? `, ${userName}` : ""}!`}
            </h1>
            <p className="text-muted-foreground text-sm sm:text-lg max-w-2xl font-medium">
              {isFirstTime
                ? "Em 3 passos você coloca sua IA pra atender no WhatsApp. Siga o roteiro abaixo."
                : "Aqui está o resumo da sua operação. Tudo rodando enquanto você cuida do que importa."}
            </p>
          </div>
        </section>

        {/* Onboarding em 3 passos — só pra conta zerada (primeira vez).
            Cada passo só aparece se a feature do destino está liberada. */}
        {isFirstTime && (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 sm:gap-4 animate-slide-up delay-100">
            {[
              { n: 1, label: "Conecte o WhatsApp", desc: "Crie ou conecte uma instância da Evolution.", href: "/whatsapp", icon: Smartphone, color: "emerald", feature: "whatsapp" },
              { n: 2, label: "Configure o agente IA", desc: "Defina personalidade, tom e base de conhecimento.", href: "/agente", icon: Bot, color: "primary", feature: "agente" },
              { n: 3, label: "Capte seus primeiros clientes", desc: "Use o captador Maps ou cadastre manual.", href: "/captador", icon: Rocket, color: "amber", feature: "captador" },
            ].filter((s) => hasFeature(s.feature)).map((s) => {
              const Icon = s.icon;
              const colorCls = s.color === "emerald"
                ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/20"
                : s.color === "amber"
                ? "bg-amber-500/10 text-amber-300 ring-amber-500/20"
                : "bg-primary/10 text-primary ring-primary/20";
              return (
                <Link href={s.href} key={s.n} className="group">
                  <Card className="glass-card border-none hover-float transition-all duration-300 h-full">
                    <CardContent className="p-5 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center ring-1", colorCls)}>
                          <Icon className="w-5 h-5" />
                        </div>
                        <span className="text-[10px] font-mono font-bold text-muted-foreground/60">PASSO {s.n}</span>
                      </div>
                      <div>
                        <p className="text-sm font-black tracking-tight text-foreground group-hover:text-primary transition-colors">{s.label}</p>
                        <p className="text-xs text-muted-foreground leading-relaxed mt-1">{s.desc}</p>
                      </div>
                      <p className="text-[10px] font-bold uppercase tracking-wider text-primary opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1">
                        Começar <ArrowUpRight className="w-3 h-3" />
                      </p>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        )}

        {/* Primary Metrics — cards CLICÁVEIS com hint pra usuário entender o que é.
            A seção inteira some se nenhum card sobrou (cliente sem nenhuma feature
            das 4 — caso muito raro mas possível). */}
        {primaryCards.length > 0 && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-6">
          {primaryCards.map((card, idx) => {
            const Icon = card.icon;
            return (
              <Link href={card.href} key={card.label} title={card.hint}>
                <Card
                  className={cn(
                    "glass-card border-none hover-float transition-all duration-500 group overflow-hidden relative animate-slide-up cursor-pointer",
                    "hover:border-white/15",
                    `delay-${(idx + 1) * 100}`
                  )}
                >
                  <div className={cn("absolute inset-0 opacity-0 group-hover:opacity-10 transition-opacity duration-500", card.bg)} />
                  {/* Setinha de drill-down — aparece no hover */}
                  <ArrowUpRight className="absolute top-3 right-3 w-3.5 h-3.5 text-muted-foreground/30 group-hover:text-primary group-hover:scale-110 transition-all" />
                  <CardContent className="p-3.5 sm:p-6">
                    <div className="flex items-center justify-between">
                      <div className="space-y-1.5">
                        <p className="text-[9px] sm:text-[11px] font-black uppercase tracking-[0.15em] text-muted-foreground">
                          {card.label}
                        </p>
                        {loading ? (
                          <div className="h-8 w-20 bg-white/5 animate-pulse rounded-lg" />
                        ) : (
                          <h2 className="text-2xl sm:text-3xl font-black tracking-tighter text-transparent bg-clip-text bg-gradient-to-br from-white to-white/60">
                            {card.value.toLocaleString("pt-BR")}
                          </h2>
                        )}
                        <p className="text-[9px] sm:text-[10px] text-muted-foreground/60 font-medium hidden sm:block">
                          {card.hint}
                        </p>
                      </div>
                      <div className={cn(
                        "w-10 h-10 sm:w-14 sm:h-14 rounded-xl sm:rounded-2xl flex items-center justify-center group-hover:scale-110 transition-transform",
                        card.bg, card.border, "border backdrop-blur-md"
                      )}>
                        <Icon className={cn("w-5 h-5 sm:w-7 sm:h-7", card.color)} />
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            );
          })}
        </div>
        )}

        {/* Automation Metrics — esconde a seção inteira (header + grid) se o
            cliente não tem NENHUMA das 4 features (disparo, followup, automacao,
            agente). Sem isso, ficaria um header solto com lista vazia. */}
        {automationCards.length > 0 && (
        <div>
          <div className="flex items-center gap-2 mb-3 sm:mb-4">
            <Workflow className="w-4 h-4 text-primary" />
            <h2 className="text-xs sm:text-sm font-black uppercase tracking-widest text-muted-foreground">Automações</h2>
          </div>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-6">
            {automationCards.map((card) => {
              const Icon = card.icon;
              return (
                <Link href={card.href} key={card.label}>
                  <Card
                    className="glass-card border-none hover-float transition-all duration-500 group overflow-hidden relative animate-slide-up delay-300 cursor-pointer hover:border-white/15"
                  >
                    <div className={cn("absolute inset-0 opacity-0 group-hover:opacity-10 transition-opacity duration-500", card.bg)} />
                    <ArrowUpRight className="absolute top-2.5 right-2.5 w-3 h-3 text-muted-foreground/30 group-hover:text-primary group-hover:scale-110 transition-all" />
                    <CardContent className="p-3.5 sm:p-6">
                      <div className="flex items-center gap-3">
                        <div className={cn(
                          "w-9 h-9 sm:w-12 sm:h-12 rounded-xl flex items-center justify-center shrink-0 group-hover:scale-110 transition-transform",
                          card.bg, card.border, "border"
                        )}>
                          <Icon className={cn("w-4 h-4 sm:w-6 sm:h-6", card.color)} />
                        </div>
                        <div className="min-w-0">
                          <p className="text-[9px] sm:text-[10px] font-black uppercase tracking-wider text-muted-foreground truncate">
                            {card.label}
                          </p>
                          {loading ? (
                            <div className="h-6 w-12 bg-white/5 animate-pulse rounded mt-1" />
                          ) : (
                            <>
                              <p className="text-xl sm:text-2xl font-black tracking-tighter text-white">
                                {card.value.toLocaleString("pt-BR")}
                              </p>
                              <p className="text-[9px] sm:text-[10px] text-muted-foreground truncate">{card.sub}</p>
                            </>
                          )}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        </div>
        )}

        {/* Activity Feed + Sidebar */}
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-4 sm:gap-8 animate-slide-up delay-400">
          {/* Recent Leads */}
          <Card className="xl:col-span-2 glass-card border-none overflow-hidden hover-float">
            <CardHeader className="p-4 sm:p-8 pb-3 sm:pb-4 border-b border-white/5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 sm:gap-4">
                  <div className="p-2 sm:p-2.5 rounded-lg sm:rounded-xl bg-primary/10">
                    <BarChart3 className="w-4 h-4 sm:w-5 sm:h-5 text-primary" />
                  </div>
                  <CardTitle className="text-base sm:text-xl font-bold">Últimos Clientes</CardTitle>
                </div>
                <Link href="/leads">
                  <Button variant="ghost" size="sm" className="text-primary hover:bg-primary/10 text-xs hidden sm:flex">
                    Ver todos <ArrowUpRight className="ml-2 w-4 h-4" />
                  </Button>
                </Link>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {loading ? (
                <div className="p-4 sm:p-8 space-y-4">
                  {[...Array(5)].map((_, i) => (
                    <div key={i} className="flex items-center gap-4">
                      <div className="w-10 h-10 rounded-lg bg-white/5 animate-pulse" />
                      <div className="flex-1 space-y-2">
                        <div className="h-4 w-1/3 bg-white/5 animate-pulse rounded" />
                        <div className="h-3 w-1/4 bg-white/5 animate-pulse rounded" />
                      </div>
                    </div>
                  ))}
                </div>
              ) : recentLeads.length === 0 ? (
                <div className="p-10 sm:p-16 text-center">
                  <div className="w-16 h-16 mx-auto rounded-2xl bg-primary/10 ring-1 ring-primary/20 flex items-center justify-center mb-4">
                    <Users className="w-7 h-7 text-primary" />
                  </div>
                  <p className="text-foreground font-bold text-sm mb-1">Nenhum cliente cadastrado ainda</p>
                  <p className="text-muted-foreground text-xs max-w-sm mx-auto mb-5 leading-relaxed">
                    Comece extraindo do Google Maps, cadastrando manual ou esperando a IA capturar das conversas.
                  </p>
                  <div className="flex items-center gap-2 justify-center flex-wrap">
                    <Link href="/captador">
                      <Button size="sm" className="glow-primary h-9 text-xs font-bold uppercase tracking-wider gap-2">
                        <Target className="w-3.5 h-3.5" /> Captar do Maps
                      </Button>
                    </Link>
                    <Link href="/leads">
                      <Button size="sm" variant="outline" className="h-9 text-xs font-bold uppercase tracking-wider gap-2 border-white/10 hover:bg-white/5">
                        <Users className="w-3.5 h-3.5" /> Adicionar manual
                      </Button>
                    </Link>
                  </div>
                </div>
              ) : (
                <div className="overflow-hidden">
                  {/* Desktop table */}
                  <table className="w-full text-left border-collapse hidden sm:table">
                    <thead>
                      <tr className="bg-transparent">
                        <th className="px-8 py-5 text-[11px] font-black uppercase tracking-[0.15em] text-muted-foreground">Lead / Negócio</th>
                        <th className="px-8 py-5 text-[11px] font-black uppercase tracking-[0.15em] text-muted-foreground">Categoria</th>
                        <th className="px-8 py-5 text-[11px] font-black uppercase tracking-[0.15em] text-muted-foreground text-right">Captado em</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.03]">
                      {recentLeads.map((lead, idx) => (
                        <tr 
                          key={lead.id} 
                          className="group hover:bg-white/[0.04] transition-all duration-300 cursor-pointer animate-slide-up"
                          style={{ animationDelay: `${idx * 50}ms` }}
                        >
                          <td className="px-8 py-4">
                            <div className="flex items-center gap-4">
                              <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-primary/20 to-purple-500/20 border border-white/10 flex items-center justify-center text-primary font-black shadow-inner group-hover:scale-105 transition-transform">
                                {(lead.nome_negocio || "?")[0].toUpperCase()}
                              </div>
                              <span className="font-bold text-[15px] tracking-tight group-hover:text-primary transition-colors">
                                {lead.nome_negocio || "Sem nome"}
                              </span>
                            </div>
                          </td>
                          <td className="px-8 py-4">
                            <Badge variant="secondary" className="bg-white/[0.04] text-muted-foreground border border-white/5 font-semibold px-3 py-1.5">
                              {lead.ramo_negocio || "Geral"}
                            </Badge>
                          </td>
                          <td className="px-8 py-4 text-right">
                            <span className="text-xs font-mono text-muted-foreground/70">
                              {new Date(lead.created_at).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {/* Mobile card list */}
                  <div className="sm:hidden divide-y divide-white/[0.03]">
                    {recentLeads.map((lead, idx) => (
                      <div 
                        key={lead.id} 
                        className="flex items-center gap-3 p-3 active:bg-white/[0.04] transition-colors animate-slide-up"
                        style={{ animationDelay: `${idx * 50}ms` }}
                      >
                        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary/20 to-purple-500/20 border border-white/10 flex items-center justify-center text-primary font-black text-sm shrink-0">
                          {(lead.nome_negocio || "?")[0].toUpperCase()}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-bold text-sm truncate">{lead.nome_negocio || "Sem nome"}</p>
                          <p className="text-[10px] text-muted-foreground truncate">
                            {lead.ramo_negocio || "Geral"} · {new Date(lead.created_at).toLocaleDateString("pt-BR", { day: "2-digit", month: "short" })}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Quick Stats Sidebar */}
          <div className="space-y-4 sm:space-y-6">
            {/* Calendar Widget — só renderiza se cliente tem feature calendário
                habilitada (admin sempre tem). Em conta sem o módulo, o componente
                retorna null silenciosamente — não polui o dashboard. */}
            <DashboardCalendarWidget />

            {/* System Status */}
            <Card className="glass-card border-none p-4 sm:p-6 space-y-3 sm:space-y-4 hover-float animate-slide-up delay-300">
              <h3 className="font-black uppercase tracking-[0.2em] text-[11px] text-primary flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse-dot" /> Status do Sistema
              </h3>
              <div className="space-y-2.5">
                <div className="flex items-center justify-between p-3 rounded-xl bg-white/[0.03] border border-white/5">
                  <div className="flex items-center gap-2.5">
                    <div className="w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
                    <span className="text-xs sm:text-sm font-bold">WhatsApp</span>
                  </div>
                  <Badge className="bg-green-500/10 text-green-500 border-none text-[10px]">
                    {loading ? "..." : `${metrics.instanciasOnline} on`}
                  </Badge>
                </div>
                <div className="flex items-center justify-between p-3 rounded-xl bg-white/[0.03] border border-white/5">
                  <div className="flex items-center gap-2.5">
                    <div className="w-2 h-2 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]" />
                    <span className="text-xs sm:text-sm font-bold">Supabase</span>
                  </div>
                  <Badge className="bg-blue-500/10 text-blue-500 border-none text-[10px]">Online</Badge>
                </div>
                <div className="flex items-center justify-between p-3 rounded-xl bg-white/[0.03] border border-white/5">
                  <div className="flex items-center gap-2.5">
                    <Bot className="w-3.5 h-3.5 text-violet-400" />
                    <span className="text-xs sm:text-sm font-bold">Agente IA</span>
                  </div>
                  <Badge className="bg-violet-500/10 text-violet-400 border-none text-[10px]">
                    {loading ? "..." : `${metrics.iaInteracoesHoje} msgs`}
                  </Badge>
                </div>
              </div>
            </Card>

            {/* Tokens Summary */}
            <Card className="glass-card border-none p-4 sm:p-6 overflow-hidden relative group hover-float">
              <div className="absolute inset-0 bg-gradient-to-br from-primary/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="relative z-10 space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="font-black uppercase tracking-widest text-[10px] text-primary flex items-center gap-1.5">
                    <Coins className="w-3.5 h-3.5" /> Tokens IA Hoje
                  </h3>
                  <Link href="/tokens">
                    <Button variant="ghost" size="sm" className="h-6 px-2 text-[10px] text-primary hover:bg-primary/10">
                      Ver <ArrowUpRight className="w-3 h-3 ml-1" />
                    </Button>
                  </Link>
                </div>
                <p className="text-2xl sm:text-3xl font-black tracking-tighter text-white">
                  {loading ? "..." : `${(metrics.tokensHoje / 1000).toFixed(1)}K`}
                </p>
                <div className="w-full h-1.5 bg-white/5 rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-primary via-purple-500 to-indigo-500 rounded-full transition-all duration-1000" style={{ width: loading ? '0%' : '60%' }} />
                </div>
              </div>
            </Card>

            {/* Quick Links */}
            <Card className="glass-card border-none p-4 sm:p-6 space-y-2 hover-float">
              <h3 className="font-black uppercase tracking-widest text-[10px] text-muted-foreground mb-2">Atalhos</h3>
              {[
                { href: "/disparo", label: "Novo Disparo", icon: Send, color: "text-cyan-400" },
                { href: "/follow-up", label: "Follow-ups", icon: Repeat, color: "text-amber-400" },
                { href: "/captador", label: "Captar Leads", icon: Target, color: "text-green-400" },
              ].map((link) => (
                <Link key={link.href} href={link.href}>
                  <div className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-white/5 active:bg-white/10 transition-colors cursor-pointer group min-h-[40px]">
                    <div className="w-8 h-8 rounded-lg bg-white/5 flex items-center justify-center group-hover:bg-white/10 transition-colors">
                      <link.icon className={cn("w-4 h-4", link.color)} />
                    </div>
                    <span className="text-xs sm:text-sm font-bold group-hover:text-primary transition-colors">{link.label}</span>
                    <ArrowUpRight className="w-3 h-3 text-muted-foreground ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </Link>
              ))}
            </Card>
          </div>
        </div>

      </main>
    </div>
  );
}
