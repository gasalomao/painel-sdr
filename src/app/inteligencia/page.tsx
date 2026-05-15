"use client";
import { useState, useEffect } from "react";
import { Header } from "@/components/layout/header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BarChart3, Brain, AlertTriangle, Lightbulb, FileText, TrendingUp, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { ModuleHero } from "@/components/ai-module-shared";

interface Insight { id: string; remote_jid: string; nome_negocio: string; insight_type: string; content: string; confidence: number; extracted_from: string; created_at: string; }
interface Stats { objecoes: number; dores: number; oportunidades: number; dados_extraidos: number; }

const typeConfig: Record<string, { label: string; color: string; bg: string; icon: any }> = {
  objecao: { label: "Objeção", color: "text-red-400", bg: "bg-red-400/20", icon: AlertTriangle },
  dor: { label: "Dor", color: "text-amber-400", bg: "bg-amber-400/20", icon: Brain },
  oportunidade: { label: "Oportunidade", color: "text-green-400", bg: "bg-green-400/20", icon: Lightbulb },
  dado_extraido: { label: "Dado Extraído", color: "text-blue-400", bg: "bg-blue-400/20", icon: FileText },
  feedback: { label: "Feedback", color: "text-purple-400", bg: "bg-purple-400/20", icon: TrendingUp },
};

export default function InteligenciaPage() {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [stats, setStats] = useState<Stats>({ objecoes: 0, dores: 0, oportunidades: 0, dados_extraidos: 0 });
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState("week");
  const [typeFilter, setTypeFilter] = useState("all");

  async function fetchData() {
    try {
      const [insRes, statsRes] = await Promise.all([
        fetch(`/api/intelligence?period=${period}${typeFilter !== "all" ? `&type=${typeFilter}` : ""}`),
        fetch(`/api/intelligence?type=stats&period=${period}`),
      ]);
      const [insData, statsData] = await Promise.all([insRes.json(), statsRes.json()]);
      setInsights(insData.insights || []); setStats(statsData);
    } catch {} finally { setLoading(false); }
  }
  useEffect(() => { fetchData(); }, [period, typeFilter]);

  const statCards = [
    { statLabel: "Objeções", value: stats.objecoes, key: "objecao", ...typeConfig.objecao },
    { statLabel: "Dores", value: stats.dores, key: "dor", ...typeConfig.dor },
    { statLabel: "Oportunidades", value: stats.oportunidades, key: "oportunidade", ...typeConfig.oportunidade },
    { statLabel: "Dados Extraídos", value: stats.dados_extraidos, key: "dado_extraido", ...typeConfig.dado_extraido },
  ];

  return (
    <div className="flex flex-col h-[100dvh] overflow-hidden"><Header />
    <div className="flex-1 p-3 sm:p-6 space-y-4 overflow-y-auto w-full max-w-7xl mx-auto mobile-safe-bottom">
      <ModuleHero
        icon={<div className="w-10 h-10 rounded-xl bg-cyan-500/20 border border-cyan-500/30 flex items-center justify-center"><BarChart3 className="w-5 h-5 text-cyan-400" /></div>}
        title="Sales Intelligence"
        description="A IA extrai inteligência comercial automaticamente das conversas do WhatsApp"
        color="from-cyan-500/10 to-blue-500/5 border-cyan-500/20"
        steps={[
          { emoji: "💬", title: "1. Conversas Acontecem", desc: "Quando o Agente IA atende um lead no WhatsApp, a conversa é analisada em tempo real" },
          { emoji: "🔍", title: "2. IA Extrai Insights", desc: "Dores, objeções, dados do cliente (e-mail, faturamento), oportunidades — tudo catalogado automaticamente" },
          { emoji: "📊", title: "3. Dashboard Inteligente", desc: "Veja as top objeções da semana, dores recorrentes, e use isso pra ajustar seu pitch e sua oferta" },
        ]}
        connections={["Agente IA"]}
      />

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {["today", "week", "month"].map(p => (
            <Button key={p} variant={period === p ? "default" : "ghost"} size="sm" className="text-xs h-8" onClick={() => setPeriod(p)}>
              {p === "today" ? "Hoje" : p === "week" ? "Semana" : "Mês"}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {statCards.map(s => {
          const Icon = s.icon;
          return (
            <Card key={s.statLabel} className={cn("glass-card border-none hover-float cursor-pointer transition-all", typeFilter === s.key && "ring-1 ring-primary")} onClick={() => setTypeFilter(typeFilter === s.key ? "all" : s.key)}>
              <CardContent className="p-4 flex items-center gap-3">
                <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center", s.bg)}><Icon className={cn("w-5 h-5", s.color)} /></div>
                <div><p className="text-2xl font-black">{s.value}</p><p className="text-[10px] text-muted-foreground uppercase tracking-wider font-bold">{s.statLabel}</p></div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <Button variant={typeFilter === "all" ? "default" : "ghost"} size="sm" className="text-xs h-8" onClick={() => setTypeFilter("all")}>Todos</Button>
        {Object.entries(typeConfig).map(([key, cfg]) => (
          <Button key={key} variant={typeFilter === key ? "default" : "ghost"} size="sm" className="text-xs h-8" onClick={() => setTypeFilter(key)}>{cfg.label}</Button>
        ))}
      </div>

      {loading ? <p className="text-center py-12 text-muted-foreground text-sm">Carregando...</p> : insights.length === 0 ? (
        <Card className="border-cyan-500/20 bg-card/80"><CardContent className="p-8 text-center space-y-4">
          <Sparkles className="w-16 h-16 mx-auto text-cyan-400/30" />
          <div><h3 className="font-bold text-sm mb-1">Inteligência comercial em tempo real</h3><p className="text-xs text-muted-foreground max-w-md mx-auto">Conforme o Agente IA conversa com leads no WhatsApp, este dashboard vai preencher automaticamente com objeções, dores, dados extraídos e oportunidades detectadas nas conversas.</p></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-lg mx-auto">
            {[{ icon: "🛑", text: "\"Achei caro\" → Objeção catalogada" }, { icon: "😰", text: "\"Não consigo escalar\" → Dor detectada" }, { icon: "📧", text: "\"Meu e-mail é...\" → Dado extraído" }, { icon: "💡", text: "\"Preciso de X\" → Oportunidade" }].map(s => (
              <div key={s.text} className="bg-secondary/30 rounded-lg p-2 text-[10px] text-left">{s.icon} {s.text}</div>
            ))}
          </div>
        </CardContent></Card>
      ) : (
        <div className="space-y-2">
          {insights.map(ins => {
            const cfg = typeConfig[ins.insight_type] || typeConfig.feedback;
            const Icon = cfg.icon;
            return (
              <Card key={ins.id} className="border-border/50 bg-card/80 hover:border-primary/20 transition-all">
                <CardContent className="p-4 flex items-start gap-3">
                  <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5", cfg.bg)}><Icon className={cn("w-4 h-4", cfg.color)} /></div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <Badge variant="secondary" className="text-[9px]">{cfg.label}</Badge>
                      <span className="text-[10px] text-muted-foreground">{ins.nome_negocio || ins.remote_jid}</span>
                      <span className="text-[10px] text-muted-foreground/50 ml-auto">{Math.round(ins.confidence * 100)}%</span>
                    </div>
                    <p className="text-sm text-foreground/90">{ins.content}</p>
                    <p className="text-[10px] text-muted-foreground/50 mt-1">{new Date(ins.created_at).toLocaleDateString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })} · {ins.extracted_from === "chat_ai" ? "Extraído da conversa IA" : "Manual"}</p>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div></div>
  );
}
