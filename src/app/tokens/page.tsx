"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { Header } from "@/components/layout/header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Coins, RefreshCw, Loader2, Sparkles, Bot, Zap, Repeat, BrainCircuit, AlertCircle,
  DollarSign, TrendingUp, Calculator, Calendar, Cpu, ListChecks,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, Legend, Cell,
} from "recharts";

type Period = "today" | "7d" | "30d" | "all";

type Totals = { prompt: number; completion: number; total: number; cost: number; costBrl: number; calls: number; brlRate: number };
type BySource = { source: string; total: number; cost: number; calls: number; prompt: number; completion: number };
type BySourceLabel = { source: string; label: string; total: number; cost: number; calls: number };
type ByModel = {
  model: string; total: number; cost: number; calls: number; prompt: number; completion: number;
  priceKnown: boolean; input_per_1m: number | null; output_per_1m: number | null;
};
type ByDay = { day: string; total: number; cost: number; calls: number; agent: number; disparo: number; followup: number; organizer: number; other: number };
type RecentRow = {
  id: number; source: string; source_label: string | null; model: string;
  prompt_tokens: number; completion_tokens: number; total_tokens: number;
  cost_usd: number; cost_brl: number; priceKnown: boolean; created_at: string;
};
type PricingState = { source: "remote" | "db" | "fallback" | string; fetchedAt: number; modelCount: number };

const SOURCE_META: Record<string, { label: string; color: string; icon: any; gradient: string }> = {
  agent:     { label: "Agente IA",        color: "#22d3ee", icon: Bot,          gradient: "from-cyan-500/20    to-cyan-500/0" },
  disparo:   { label: "Disparo em Massa", color: "#f59e0b", icon: Zap,          gradient: "from-amber-500/20   to-amber-500/0" },
  followup:  { label: "Follow-up",        color: "#a78bfa", icon: Repeat,       gradient: "from-violet-500/20  to-violet-500/0" },
  organizer: { label: "Organizador IA",   color: "#34d399", icon: BrainCircuit, gradient: "from-emerald-500/20 to-emerald-500/0" },
  other:     { label: "Outros (mídia)",   color: "#94a3b8", icon: Sparkles,     gradient: "from-slate-500/20   to-slate-500/0" },
};

function formatTokens(n: number) {
  if (!isFinite(n) || n === 0) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return String(Math.round(n));
}
function formatUSD(c: number) {
  if (!isFinite(c)) return "$0.00";
  if (c === 0) return "$0.00";
  if (c < 0.01) return `$${c.toFixed(6)}`;
  if (c < 1) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(2)}`;
}
function formatBRL(c: number) {
  if (!isFinite(c) || c === 0) return "R$ 0,00";
  return c.toLocaleString("pt-BR", { style: "currency", currency: "BRL", minimumFractionDigits: c < 0.10 ? 4 : 2 });
}
function formatPctMoney(part: number, total: number) {
  if (!total) return "0%";
  return ((part / total) * 100).toFixed(part / total < 0.05 ? 1 : 0) + "%";
}
function periodToRange(p: Period): { from?: string; to?: string } {
  const now = new Date();
  const to = now.toISOString();
  if (p === "all") return {};
  if (p === "today") {
    const start = new Date(now); start.setHours(0, 0, 0, 0);
    return { from: start.toISOString(), to };
  }
  if (p === "7d") {
    const start = new Date(now); start.setDate(start.getDate() - 7);
    return { from: start.toISOString(), to };
  }
  const start = new Date(now); start.setDate(start.getDate() - 30);
  return { from: start.toISOString(), to };
}

export default function TokensPage() {
  const [period, setPeriod] = useState<Period>("7d");
  const [loading, setLoading] = useState(true);
  const [notReady, setNotReady] = useState(false);
  const [totals, setTotals] = useState<Totals>({ prompt: 0, completion: 0, total: 0, cost: 0, costBrl: 0, calls: 0, brlRate: 5.10 });
  const [bySource, setBySource] = useState<BySource[]>([]);
  const [bySourceLabel, setBySourceLabel] = useState<BySourceLabel[]>([]);
  const [byModel, setByModel] = useState<ByModel[]>([]);
  const [byDayStacked, setByDayStacked] = useState<ByDay[]>([]);
  const [recent, setRecent] = useState<RecentRow[]>([]);
  const [pricingState, setPricingState] = useState<PricingState>({ source: "fallback", fetchedAt: 0, modelCount: 0 });

  const [diagLoading, setDiagLoading] = useState(false);
  const [diagResult, setDiagResult] = useState<any>(null);
  const [refreshingPrices, setRefreshingPrices] = useState(false);
  const [recalcing, setRecalcing] = useState(false);
  const [recalcResult, setRecalcResult] = useState<{ updated: number; scanned: number; unknownModels: string[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const range = periodToRange(period);
      const params = new URLSearchParams();
      if (range.from) params.set("from", range.from);
      if (range.to) params.set("to", range.to);
      const r = await fetch(`/api/tokens?${params.toString()}`, { cache: "no-store" });
      const d = await r.json();
      if (d.success) {
        setNotReady(!!d.notReady);
        setTotals(d.totals || totals);
        setBySource(d.bySource || []);
        setBySourceLabel(d.bySourceLabel || []);
        setByModel(d.byModel || []);
        setByDayStacked(d.byDayStacked || []);
        setRecent(d.recent || []);
        setPricingState(d.pricingState || pricingState);
      }
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period]);

  useEffect(() => { load(); }, [load]);

  const refreshPrices = async () => {
    setRefreshingPrices(true);
    try {
      const r = await fetch("/api/tokens/pricing", { method: "POST", cache: "no-store" });
      const d = await r.json();
      if (d.success) {
        setPricingState({ source: d.source, fetchedAt: d.fetchedAt, modelCount: d.modelCount });
        await load(); // recalcula tudo na UI com o preço novo
      }
    } finally {
      setRefreshingPrices(false);
    }
  };

  const recalcAll = async () => {
    setRecalcing(true);
    setRecalcResult(null);
    try {
      const r = await fetch("/api/tokens/recalc", { method: "POST" });
      const d = await r.json();
      if (d.success) {
        setRecalcResult({ updated: d.updated, scanned: d.scanned, unknownModels: d.unknownModels || [] });
        await load();
      } else {
        alert("Erro ao recalcular: " + (d.error || "?"));
      }
    } finally {
      setRecalcing(false);
    }
  };

  async function runDiagnose() {
    setDiagLoading(true);
    setDiagResult(null);
    try {
      const r = await fetch("/api/tokens/diagnose", { cache: "no-store" });
      setDiagResult(await r.json());
      await load();
    } catch (e: any) {
      setDiagResult({ ok: false, checks: [{ ok: false, step: "Conexão", message: e?.message }] });
    } finally {
      setDiagLoading(false);
    }
  }

  // Custo de hoje (mesmo período em recorte de UI)
  const today = new Date().toISOString().slice(0, 10);
  const todayRow = byDayStacked.find(d => d.day === today);
  const costToday = todayRow?.cost || 0;

  // Custo médio por chamada (USD)
  const avgPerCall = totals.calls > 0 ? totals.cost / totals.calls : 0;

  // Top feature por custo (pra hero card)
  const topFeature = bySource[0];

  const PeriodButton = ({ value, label }: { value: Period; label: string }) => (
    <button
      onClick={() => setPeriod(value)}
      className={cn(
        "px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition",
        period === value
          ? "bg-primary text-primary-foreground shadow-lg shadow-primary/20"
          : "bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-white"
      )}
    >{label}</button>
  );

  const pricingAge = useMemo(() => {
    if (!pricingState.fetchedAt) return "—";
    const ms = Date.now() - pricingState.fetchedAt;
    const h = Math.floor(ms / 3_600_000);
    if (h < 1) return "agora há pouco";
    if (h < 24) return `há ${h}h`;
    return `há ${Math.floor(h / 24)}d`;
  }, [pricingState.fetchedAt]);

  const sourceLabel = pricingState.source === "remote"
    ? "ao vivo (LiteLLM)"
    : pricingState.source === "db" ? "cache do banco" : "fallback estático";

  return (
    <div className="flex flex-col h-[100dvh] max-h-[100dvh] bg-background overflow-hidden text-white">
      <Header />
      <main className="flex-1 overflow-y-auto p-3 sm:p-6 md:p-10 max-w-7xl mx-auto w-full space-y-4 sm:space-y-6 mobile-safe-bottom">
        {/* Cabeçalho */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-black tracking-tight flex items-center gap-3">
              <Coins className="w-6 h-6 text-amber-400" /> Quanto sua IA está custando
            </h1>
            <p className="text-xs text-muted-foreground mt-1 max-w-2xl">
              Cada chamada de IA é registrada no banco e o custo é calculado com preço atualizado de
              <span className="text-emerald-300 font-bold"> LiteLLM</span> (fonte pública crowd-sourced) — automaticamente refrescado a cada 6h.
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex bg-white/5 border border-white/10 p-1 rounded-xl">
              <PeriodButton value="today" label="Hoje" />
              <PeriodButton value="7d"    label="7 dias" />
              <PeriodButton value="30d"   label="30 dias" />
              <PeriodButton value="all"   label="Tudo" />
            </div>
            <Button onClick={load} variant="outline" size="sm" disabled={loading} className="bg-white/5 border-white/10 hover:bg-white/10 gap-1.5">
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Atualizar
            </Button>
          </div>
        </div>

        {notReady && (
          <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-200 text-xs flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <p><strong>Tabela de tokens ainda não existe no banco.</strong> Rode SETUP_COMPLETO.sql + MIGRATION_WHATSAPP_OFICIAL.sql.</p>
          </div>
        )}

        {/* HERO — quanto você gastou */}
        <Card className="border-white/10 bg-gradient-to-br from-amber-500/15 via-amber-500/5 to-transparent overflow-hidden relative">
          <div className="absolute top-0 right-0 w-64 h-64 bg-amber-500/10 rounded-full blur-3xl" />
          <CardContent className="p-6 md:p-8 relative">
            <div className="flex flex-col md:flex-row md:items-end justify-between gap-6">
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-[0.3em] text-amber-300/70 font-black">
                  Custo total · {period === "today" ? "hoje" : period === "7d" ? "últimos 7 dias" : period === "30d" ? "últimos 30 dias" : "histórico inteiro"}
                </p>
                <div className="flex items-baseline gap-3 flex-wrap">
                  <span className="text-5xl md:text-6xl font-black text-white leading-none">{formatBRL(totals.costBrl)}</span>
                  <span className="text-xl md:text-2xl font-bold text-amber-300/80">{formatUSD(totals.cost)}</span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Convertido a USD/BRL = <strong>{totals.brlRate.toFixed(4)}</strong> · cotação em tempo real via AwesomeAPI (atualiza a cada 6h, fallback no banco). Pra travar manualmente, passe <code>?brl=5.20</code> na URL.
                </p>
              </div>

              <div className="grid grid-cols-3 gap-3 min-w-[280px]">
                <MiniStat label="Hoje"          value={formatBRL(costToday * totals.brlRate)} hint={formatUSD(costToday)} />
                <MiniStat label="Por chamada"   value={formatBRL(avgPerCall * totals.brlRate)} hint={`${formatTokens(totals.total / Math.max(totals.calls, 1))} tok média`} />
                <MiniStat label="Top feature"   value={topFeature ? (SOURCE_META[topFeature.source]?.label || topFeature.source) : "—"} hint={topFeature ? formatBRL(topFeature.cost * totals.brlRate) : ""} />
              </div>
            </div>

            <div className="mt-5 flex flex-wrap items-center gap-2 text-[10px] text-amber-300/70">
              <Calendar className="w-3 h-3" />
              <span>{totals.calls} chamadas no período</span>
              <span className="opacity-50">·</span>
              <span>{formatTokens(totals.total)} tokens no total</span>
              <span className="opacity-50">·</span>
              <span>preços {sourceLabel} · atualizado {pricingAge} · {pricingState.modelCount} modelos no cache</span>
            </div>
          </CardContent>
        </Card>

        {/* Onde está indo o dinheiro */}
        <Card className="border-white/10 bg-white/[0.02]">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-black uppercase tracking-widest flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-emerald-400" /> Onde está indo seu dinheiro
            </CardTitle>
            <p className="text-[11px] text-muted-foreground mt-1">
              Custo por feature do sistema — barra mostra quanto cada uma representa.
            </p>
          </CardHeader>
          <CardContent className="space-y-3 pt-2">
            {bySource.length === 0 ? (
              <p className="text-xs text-muted-foreground italic py-6 text-center">Sem dados no período. Use a IA pra começar a coletar.</p>
            ) : bySource.map(s => {
              const meta = SOURCE_META[s.source] || SOURCE_META.other;
              const Icon = meta.icon;
              const pct = totals.cost > 0 ? (s.cost / totals.cost) * 100 : 0;
              return (
                <div key={s.source} className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: meta.color + "20", border: `1px solid ${meta.color}50` }}>
                        <Icon className="w-4 h-4" style={{ color: meta.color }} />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-bold text-white truncate">{meta.label}</p>
                        <p className="text-[10px] text-muted-foreground">{s.calls} chamadas · {formatTokens(s.total)} tokens · {formatPctMoney(s.cost, totals.cost)} do total</p>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-base font-black" style={{ color: meta.color }}>{formatBRL(s.cost * totals.brlRate)}</p>
                      <p className="text-[9px] text-muted-foreground font-mono">{formatUSD(s.cost)}</p>
                    </div>
                  </div>
                  <div className="h-2 rounded-full bg-white/5 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${pct}%`, background: meta.color }}
                    />
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>

        {/* Gráfico stacked por dia */}
        <Card className="border-white/10 bg-white/[0.02]">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-black uppercase tracking-widest flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-cyan-400" /> Custo diário (R$) — empilhado por feature
            </CardTitle>
            <p className="text-[11px] text-muted-foreground mt-1">
              Cada barra é o custo de um dia. As cores mostram qual feature consumiu mais — passe o mouse pra ver o detalhe.
            </p>
          </CardHeader>
          <CardContent className="h-80 pt-2">
            {byDayStacked.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-muted-foreground italic">Sem dados no período.</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byDayStacked.map(d => ({
                  ...d,
                  agent_brl:     d.agent     * totals.brlRate,
                  disparo_brl:   d.disparo   * totals.brlRate,
                  followup_brl:  d.followup  * totals.brlRate,
                  organizer_brl: d.organizer * totals.brlRate,
                  other_brl:     d.other     * totals.brlRate,
                }))}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                  <XAxis dataKey="day" stroke="#ffffff60" fontSize={10} tickFormatter={d => d.slice(5)} />
                  <YAxis stroke="#ffffff60" fontSize={10} tickFormatter={(v) => `R$ ${Number(v).toFixed(2)}`} width={60} />
                  <Tooltip
                    contentStyle={{ background: "#0a0a0a", border: "1px solid #ffffff20", borderRadius: 8, fontSize: 11 }}
                    formatter={(v: any, name: any) => {
                      const key = String(name).replace("_brl", "");
                      const meta = SOURCE_META[key] || SOURCE_META.other;
                      return [formatBRL(Number(v)), meta.label];
                    }}
                    labelFormatter={(d) => `📅 ${d}`}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 10 }}
                    formatter={(v) => {
                      const key = String(v).replace("_brl", "");
                      return SOURCE_META[key]?.label || key;
                    }}
                  />
                  <Bar dataKey="agent_brl"     stackId="a" fill={SOURCE_META.agent.color} />
                  <Bar dataKey="disparo_brl"   stackId="a" fill={SOURCE_META.disparo.color} />
                  <Bar dataKey="followup_brl"  stackId="a" fill={SOURCE_META.followup.color} />
                  <Bar dataKey="organizer_brl" stackId="a" fill={SOURCE_META.organizer.color} />
                  <Bar dataKey="other_brl"     stackId="a" fill={SOURCE_META.other.color} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Modelos com preço */}
        <Card className="border-white/10 bg-white/[0.02]">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-black uppercase tracking-widest flex items-center gap-2">
              <Cpu className="w-4 h-4 text-violet-400" /> Modelos usados e preços atuais
            </CardTitle>
            <p className="text-[11px] text-muted-foreground mt-1">
              Quanto cada modelo Gemini está custando, com o preço unitário <strong>online</strong> de hoje.
              Modelos sem preço listado caem como zero — clique em Atualizar preços pra puxar do LiteLLM.
            </p>
          </CardHeader>
          <CardContent className="pt-2 space-y-2">
            <div className="flex flex-wrap gap-2 mb-3">
              <Button onClick={refreshPrices} disabled={refreshingPrices} variant="outline" size="sm"
                      className="bg-emerald-500/10 border-emerald-500/30 hover:bg-emerald-500/20 text-emerald-200 gap-1.5">
                {refreshingPrices ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                Atualizar preços (LiteLLM)
              </Button>
              <Button onClick={recalcAll} disabled={recalcing} variant="outline" size="sm"
                      className="bg-cyan-500/10 border-cyan-500/30 hover:bg-cyan-500/20 text-cyan-200 gap-1.5">
                {recalcing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Calculator className="w-3.5 h-3.5" />}
                Recalcular custo das chamadas antigas
              </Button>
              <Button onClick={runDiagnose} disabled={diagLoading} variant="outline" size="sm"
                      className="bg-amber-500/10 border-amber-500/30 hover:bg-amber-500/20 text-amber-200 gap-1.5"
                      title="Verifica se a tabela existe e se há permissão de leitura">
                {diagLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <AlertCircle className="w-3.5 h-3.5" />}
                Diagnosticar
              </Button>
            </div>

            {recalcResult && (
              <div className="p-3 rounded-lg bg-cyan-500/5 border border-cyan-500/20 text-[11px] text-cyan-100 mb-2">
                ✓ Recalculado. Atualizei <strong>{recalcResult.updated}</strong> de <strong>{recalcResult.scanned}</strong> chamadas.
                {recalcResult.unknownModels.length > 0 && (
                  <p className="opacity-80 mt-1">Modelos sem preço no cache: <span className="font-mono">{recalcResult.unknownModels.join(", ")}</span></p>
                )}
              </div>
            )}

            {byModel.length === 0 ? (
              <p className="text-xs text-muted-foreground italic py-4 text-center">Sem chamadas no período.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="text-[9px] uppercase tracking-widest text-muted-foreground border-b border-white/5">
                      <th className="text-left p-2">Modelo</th>
                      <th className="text-right p-2">Preço entrada<br/><span className="opacity-60 font-normal">/1M tok</span></th>
                      <th className="text-right p-2">Preço saída<br/><span className="opacity-60 font-normal">/1M tok</span></th>
                      <th className="text-right p-2">Chamadas</th>
                      <th className="text-right p-2">Tokens</th>
                      <th className="text-right p-2">Custo (R$)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byModel.map(m => (
                      <tr key={m.model} className="border-b border-white/[0.03]">
                        <td className="p-2">
                          <p className="font-mono text-white text-[11px]">{m.model}</p>
                          {!m.priceKnown && <p className="text-[9px] text-amber-400">⚠ preço desconhecido — atualize os preços</p>}
                        </td>
                        <td className="p-2 text-right font-mono text-cyan-300">
                          {m.input_per_1m != null ? `$${m.input_per_1m.toFixed(3)}` : "—"}
                        </td>
                        <td className="p-2 text-right font-mono text-violet-300">
                          {m.output_per_1m != null ? `$${m.output_per_1m.toFixed(3)}` : "—"}
                        </td>
                        <td className="p-2 text-right font-mono">{m.calls}</td>
                        <td className="p-2 text-right font-mono text-amber-300">{formatTokens(m.total)}</td>
                        <td className="p-2 text-right font-black text-emerald-300">{formatBRL(m.cost * totals.brlRate)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Top agentes / campanhas */}
        <Card className="border-white/10 bg-white/[0.02]">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-black uppercase tracking-widest flex items-center gap-2">
              <ListChecks className="w-4 h-4 text-amber-400" /> Top agentes / campanhas (por custo)
            </CardTitle>
          </CardHeader>
          <CardContent className="h-80 pt-2">
            {bySourceLabel.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-muted-foreground italic">Sem dados.</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={bySourceLabel.slice(0, 10).map(s => ({
                    ...s,
                    cost_brl: s.cost * totals.brlRate,
                  }))}
                  layout="vertical"
                  margin={{ left: 110, right: 20 }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#ffffff10" />
                  <XAxis type="number" stroke="#ffffff60" fontSize={10} tickFormatter={(v) => `R$ ${Number(v).toFixed(2)}`} />
                  <YAxis type="category" dataKey="label" stroke="#ffffff60" fontSize={10} width={140} />
                  <Tooltip
                    contentStyle={{ background: "#0a0a0a", border: "1px solid #ffffff20", borderRadius: 8, fontSize: 11 }}
                    formatter={(v: any) => formatBRL(Number(v))}
                  />
                  <Bar dataKey="cost_brl" radius={[0, 4, 4, 0]}>
                    {bySourceLabel.slice(0, 10).map((s, i) => (
                      <Cell key={i} fill={SOURCE_META[s.source]?.color || "#94a3b8"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        {/* Diagnóstico */}
        {diagResult && (
          <Card className={cn("border-2", diagResult.ok ? "border-emerald-500/30 bg-emerald-500/5" : "border-red-500/30 bg-red-500/5")}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-black uppercase tracking-widest flex items-center gap-2">
                {diagResult.ok
                  ? <span className="text-emerald-300">✓ Diagnóstico — Tudo OK</span>
                  : <span className="text-red-300">✗ Diagnóstico — Problemas encontrados</span>}
                <button onClick={() => setDiagResult(null)} className="ml-auto text-xs text-muted-foreground hover:text-white normal-case font-normal tracking-normal">fechar</button>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {diagResult.checks?.map((c: any, i: number) => (
                <div key={i} className={cn("p-3 rounded-lg border text-[11px]",
                  c.ok ? "bg-emerald-500/5 border-emerald-500/20 text-emerald-100"
                       : "bg-red-500/5 border-red-500/20 text-red-100")}>
                  <p className="font-bold">{c.ok ? "✓" : "✗"} {c.step}</p>
                  <p className="opacity-80 mt-1 break-words">{c.message}</p>
                  {c.hint && <p className="opacity-60 mt-1 italic">💡 {c.hint}</p>}
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Tabela de chamadas recentes */}
        <Card className="border-white/10 bg-white/[0.02]">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-black uppercase tracking-widest">Últimas chamadas</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="text-[9px] uppercase tracking-widest text-muted-foreground border-b border-white/5">
                    <th className="text-left p-2">Quando</th>
                    <th className="text-left p-2">Feature</th>
                    <th className="text-left p-2">Origem</th>
                    <th className="text-left p-2">Modelo</th>
                    <th className="text-right p-2">Prompt</th>
                    <th className="text-right p-2">Resposta</th>
                    <th className="text-right p-2">Total</th>
                    <th className="text-right p-2">Custo</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.length === 0 ? (
                    <tr><td colSpan={8} className="p-6 text-center text-muted-foreground italic">Sem chamadas no período.</td></tr>
                  ) : recent.map((r) => {
                    const meta = SOURCE_META[r.source] || SOURCE_META.other;
                    return (
                      <tr key={r.id} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                        <td className="p-2 font-mono text-muted-foreground whitespace-nowrap">{new Date(r.created_at).toLocaleString("pt-BR")}</td>
                        <td className="p-2">
                          <span className="px-1.5 py-0.5 rounded text-[9px] font-black uppercase whitespace-nowrap"
                                style={{ background: meta.color + "20", color: meta.color, border: `1px solid ${meta.color}40` }}>
                            {meta.label}
                          </span>
                        </td>
                        <td className="p-2 text-white truncate max-w-[180px]">{r.source_label || "—"}</td>
                        <td className="p-2 font-mono text-muted-foreground text-[10px]">
                          {r.model}
                          {!r.priceKnown && <span className="ml-1 text-amber-400" title="Preço desconhecido">⚠</span>}
                        </td>
                        <td className="p-2 text-right font-mono">{formatTokens(r.prompt_tokens)}</td>
                        <td className="p-2 text-right font-mono">{formatTokens(r.completion_tokens)}</td>
                        <td className="p-2 text-right font-mono font-black text-amber-300">{formatTokens(r.total_tokens)}</td>
                        <td className="p-2 text-right font-mono text-emerald-300">{formatBRL(r.cost_brl)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {recent.length === 50 && (
              <p className="text-[10px] text-muted-foreground text-center mt-3 italic">Mostrando últimas 50 chamadas. Filtre por período pra ver mais.</p>
            )}
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

function MiniStat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-black/30 rounded-lg p-3 border border-white/5">
      <p className="text-[9px] uppercase tracking-widest text-muted-foreground font-black">{label}</p>
      <p className="text-sm font-black text-white mt-1 truncate">{value}</p>
      {hint && <p className="text-[9px] text-muted-foreground mt-0.5 truncate">{hint}</p>}
    </div>
  );
}
