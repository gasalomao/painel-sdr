"use client";

import { useEffect, useState, useCallback, useMemo, type JSX } from "react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import {
  RefreshCw, Loader2, Sparkles, Bot, Zap, Repeat, BrainCircuit, AlertCircle,
  Calculator, CheckCircle2, ChevronDown, X, type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatBRL, formatUSD, formatTokens, formatPctMoney, SOURCE_META as SOURCE_COLORS } from "@/lib/token-format";
import dynamic from "next/dynamic";
import styles from "./tokens.module.css";

const DailyCostChart = dynamic(
  () => import("./_components/TokensCharts").then((m) => m.DailyCostChart),
  { ssr: false, loading: () => <p className={styles.chartLoading}>Carregando gráfico…</p> }
);
const TopSourcesChart = dynamic(
  () => import("./_components/TokensCharts").then((m) => m.TopSourcesChart),
  { ssr: false, loading: () => <p className={styles.chartLoading}>Carregando gráfico…</p> }
);

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
type PricingState = { source: string; fetchedAt: number; modelCount: number };
type DiagnoseResult = { ok: boolean; checks?: { ok: boolean; step: string; message: string; hint?: string }[] };

const SOURCE_ICONS: Record<string, LucideIcon> = { agent: Bot, disparo: Zap, followup: Repeat, organizer: BrainCircuit, other: Sparkles };
const PERIODS: { value: Period; label: string; description: string }[] = [
  { value: "today", label: "Hoje", description: "hoje" },
  { value: "7d", label: "7 dias", description: "últimos 7 dias" },
  { value: "30d", label: "30 dias", description: "últimos 30 dias" },
  { value: "all", label: "Todo o período", description: "todo o período" },
];

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

export default function TokensPage(): JSX.Element {
  const [period, setPeriod] = useState<Period>("7d");
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notReady, setNotReady] = useState(false);
  const [totals, setTotals] = useState<Totals>({ prompt: 0, completion: 0, total: 0, cost: 0, costBrl: 0, calls: 0, brlRate: 5.10 });
  const [bySource, setBySource] = useState<BySource[]>([]);
  const [bySourceLabel, setBySourceLabel] = useState<BySourceLabel[]>([]);
  const [byModel, setByModel] = useState<ByModel[]>([]);
  const [byDayStacked, setByDayStacked] = useState<ByDay[]>([]);
  const [recent, setRecent] = useState<RecentRow[]>([]);
  const [pricingState, setPricingState] = useState<PricingState>({ source: "fallback", fetchedAt: 0, modelCount: 0 });
  // O backend só retorna o detalhamento por cliente para administradores.
  const [byClient, setByClient] = useState<Array<{
    client_id: string | null; name: string; total: number; cost: number;
    costBrl: number; calls: number; prompt: number; completion: number;
  }> | null>(null);
  const [isAdminView, setIsAdminView] = useState(false);
  const [diagLoading, setDiagLoading] = useState(false);
  const [diagResult, setDiagResult] = useState<DiagnoseResult | null>(null);
  const [refreshingPrices, setRefreshingPrices] = useState(false);
  const [recalcing, setRecalcing] = useState(false);
  const [recalcResult, setRecalcResult] = useState<{ updated: number; scanned: number; unknownModels: string[] } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const range = periodToRange(period);
      const params = new URLSearchParams();
      if (range.from) params.set("from", range.from);
      if (range.to) params.set("to", range.to);
      const r = await fetch(`/api/tokens?${params.toString()}`, { cache: "no-store" });
      const d = await r.json();
      if (!r.ok || !d.success) throw new Error("Não foi possível carregar o consumo. Tente atualizar os dados novamente.");
      setNotReady(!!d.notReady);
      setTotals(previous => d.totals || previous);
      setBySource(d.bySource || []);
      setBySourceLabel(d.bySourceLabel || []);
      setByModel(d.byModel || []);
      setByDayStacked(d.byDayStacked || []);
      setRecent(d.recent || []);
      setPricingState(previous => d.pricingState || previous);
      setByClient(d.byClient || null);
      setIsAdminView(!!d.isAdminView);
      setHasLoaded(true);
    } catch {
      setError("Não foi possível carregar o consumo. Tente atualizar os dados novamente.");
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => { void load(); }, [load]);

  const refreshPrices = async () => {
    setRefreshingPrices(true);
    setError(null);
    try {
      const r = await fetch("/api/tokens/pricing", { method: "POST", cache: "no-store" });
      const d = await r.json();
      if (!r.ok || !d.success) throw new Error();
      setPricingState({ source: d.source, fetchedAt: d.fetchedAt, modelCount: d.modelCount });
      await load();
    } catch {
      setError("Não foi possível atualizar os preços. Os valores anteriores foram mantidos. Tente novamente.");
    } finally {
      setRefreshingPrices(false);
    }
  };

  const recalcAll = async () => {
    setRecalcing(true);
    setRecalcResult(null);
    setError(null);
    try {
      const r = await fetch("/api/tokens/recalc", { method: "POST" });
      const d = await r.json();
      if (!r.ok || !d.success) throw new Error();
      setRecalcResult({ updated: d.updated, scanned: d.scanned, unknownModels: d.unknownModels || [] });
      await load();
    } catch {
      setError("Não foi possível recalcular o histórico. Tente novamente ou execute o diagnóstico.");
    } finally {
      setRecalcing(false);
    }
  };

  async function runDiagnose(): Promise<void> {
    setDiagLoading(true);
    setDiagResult(null);
    try {
      const r = await fetch("/api/tokens/diagnose", { cache: "no-store" });
      if (!r.ok) throw new Error(r.status === 403 ? "Diagnóstico disponível apenas para administradores." : "Não foi possível executar o diagnóstico. Tente novamente.");
      setDiagResult(await r.json());
      await load();
    } catch (e: unknown) {
      setDiagResult({ ok: false, checks: [{ ok: false, step: "Conexão", message: e instanceof Error ? e.message : "Não foi possível conectar. Tente novamente." }] });
    } finally {
      setDiagLoading(false);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const costToday = byDayStacked.find(d => d.day === today)?.cost || 0;
  const avgPerCall = totals.calls > 0 ? totals.cost / totals.calls : 0;
  const topFeature = bySource[0];
  const periodDescription = PERIODS.find(p => p.value === period)?.description;
  const busy = loading || refreshingPrices || recalcing || diagLoading;
  const unavailable = !hasLoaded || notReady;
  const unknownPriceCount = byModel.filter(m => !m.priceKnown).length;
  const pricingAge = useMemo(() => {
    if (!pricingState.fetchedAt) return "sem atualização registrada";
    const h = Math.floor((Date.now() - pricingState.fetchedAt) / 3_600_000);
    if (h < 1) return "agora há pouco";
    if (h < 24) return `há ${h}h`;
    return `há ${Math.floor(h / 24)}d`;
  }, [pricingState.fetchedAt]);
  const sourceLabel = pricingState.source === "remote" ? "LiteLLM" : pricingState.source === "db" ? "Cache do banco" : "Tabela de referência";

  return (
    <div className={styles.page}>
      <Header />
      <section className={styles.content} aria-label="Consumo de IA" aria-busy={busy}>
        <div className={styles.heading}>
          <div>
            <h2>Tokens IA</h2>
            <p>Acompanhe o consumo de inteligência artificial e o custo de cada recurso.</p>
          </div>
          <Button onClick={load} variant="outline" disabled={busy} className={styles.secondaryAction}>
            {loading ? <Loader2 aria-hidden="true" className="animate-spin" /> : <RefreshCw aria-hidden="true" />}
            Atualizar dados
          </Button>
        </div>

        <div className={styles.toolbar}>
          <div className={styles.periodButtons} role="group" aria-label="Período do consumo">
            {PERIODS.map(p => (
              <button key={p.value} type="button" onClick={() => setPeriod(p.value)} disabled={busy} aria-pressed={period === p.value}>
                {p.label}
              </button>
            ))}
          </div>
          <span className={styles.loadStatus} role="status">
            {loading ? "Carregando consumo…" : error ? "Dados não atualizados" : "Consumo registrado no período"}
          </span>
        </div>

        {error && <div className={styles.notice} data-tone="error" role="alert"><AlertCircle aria-hidden="true" /><p>{error}</p></div>}
        {notReady && (
          <div className={styles.notice} data-tone="warning" role="status">
            <AlertCircle aria-hidden="true" />
            <div><strong>Registro de tokens indisponível</strong><p>A tabela de tokens ainda não existe no banco. Solicite ao administrador a configuração com SETUP_COMPLETO.sql e MIGRATION_WHATSAPP_OFICIAL.sql.</p></div>
          </div>
        )}

        <section className={styles.summary} aria-labelledby="consumption-title">
          <div className={styles.total}>
            <h3 id="consumption-title">Custo no período <span>· {periodDescription}</span></h3>
            <p className={styles.totalValue}>{unavailable ? "—" : formatBRL(totals.costBrl)}</p>
            <p className={styles.exchange}>{unavailable ? "Aguardando dados de consumo" : <>{formatUSD(totals.cost)} USD <span>·</span> USD/BRL {totals.brlRate.toFixed(4)}</>}</p>
          </div>
          <dl className={styles.metrics}>
            <div><dt>Tokens consumidos</dt><dd><strong>{unavailable ? "—" : formatTokens(totals.total)}</strong><span>{unavailable ? "Aguardando registro" : `${formatTokens(totals.prompt)} entrada · ${formatTokens(totals.completion)} saída`}</span></dd></div>
            <div><dt>Chamadas de IA</dt><dd><strong>{unavailable ? "—" : totals.calls.toLocaleString("pt-BR")}</strong><span>{unavailable ? "Aguardando registro" : `${formatTokens(totals.total / Math.max(totals.calls, 1))} tokens por chamada`}</span></dd></div>
            <div><dt>Custo por chamada</dt><dd><strong>{unavailable ? "—" : formatBRL(avgPerCall * totals.brlRate)}</strong><span>Média no período selecionado</span></dd></div>
          </dl>
          <div className={styles.summaryFoot}>
            <span>Hoje <strong>{unavailable ? "—" : formatBRL(costToday * totals.brlRate)}</strong></span>
            <span>Maior consumo <strong>{topFeature ? (SOURCE_COLORS[topFeature.source]?.label || topFeature.source) : "—"}</strong>{topFeature && <span> · {formatBRL(topFeature.cost * totals.brlRate)}</span>}</span>
          </div>
        </section>

        <div className={styles.analysis}>
          <section className={styles.panel} aria-labelledby="daily-title">
            <div className={styles.sectionHeading}><div><h3 id="daily-title">Evolução do custo</h3><p>Custo diário em reais, distribuído por recurso.</p></div><span className={styles.unit}>BRL</span></div>
            <figure className={styles.dailyChart} aria-label="Gráfico de custo diário por recurso">
              {unavailable ? <p className={styles.chartLoading}>{loading ? "Carregando consumo…" : "Consumo indisponível. Atualize os dados."}</p> : <DailyCostChart byDayStacked={byDayStacked} brlRate={totals.brlRate} />}
            </figure>
          </section>
          <section className={styles.panel} aria-labelledby="sources-title">
            <div className={styles.sectionHeading}><div><h3 id="sources-title">Consumo por recurso</h3><p>Participação no custo do período.</p></div></div>
            <div className={styles.sourceList}>
              {bySource.length === 0 ? <p className={styles.empty}>{unavailable ? "Aguardando dados de consumo." : "Sem consumo por recurso neste período."}</p> : bySource.map(s => {
                const meta = SOURCE_COLORS[s.source] || SOURCE_COLORS.other;
                const Icon = SOURCE_ICONS[s.source] || Sparkles;
                const pct = totals.cost > 0 ? (s.cost / totals.cost) * 100 : 0;
                return (
                  <div key={s.source} className={styles.sourceRow}>
                    <div className={styles.sourceInfo}><Icon aria-hidden="true" style={{ color: meta.color }} /><span>{meta.label}</span><strong>{formatBRL(s.cost * totals.brlRate)}</strong></div>
                    <div className={styles.sourceTrack} aria-hidden="true"><div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, backgroundColor: meta.color }} /></div>
                    <p><span>{s.calls.toLocaleString("pt-BR")} chamadas · {formatTokens(s.total)} tokens</span><span>{formatPctMoney(s.cost, totals.cost)}</span></p>
                  </div>
                );
              })}
            </div>
          </section>
        </div>

        <section className={styles.panel} aria-labelledby="models-title">
          <div className={styles.sectionHeading}><div><h3 id="models-title">Modelos e preços</h3><p>Preços de entrada e saída em USD por 1 milhão de tokens.</p></div><span className={styles.count}>{byModel.length} modelos</span></div>
          <div className={styles.pricingBar}>
            <p><span className={styles.priceSource}>{sourceLabel}</span><span>Atualizado {pricingAge} · {pricingState.modelCount.toLocaleString("pt-BR")} modelos no cache</span></p>
            <Button onClick={refreshPrices} disabled={busy} variant="outline" className={styles.secondaryAction}>
              {refreshingPrices ? <Loader2 aria-hidden="true" className="animate-spin" /> : <RefreshCw aria-hidden="true" />} Atualizar preços
            </Button>
          </div>
          {unknownPriceCount > 0 && <div className={styles.priceWarning}><AlertCircle aria-hidden="true" /><p>{unknownPriceCount === 1 ? "1 modelo sem preço conhecido." : `${unknownPriceCount} modelos sem preço conhecido.`} Custos sem preço são registrados como zero e podem subestimar o total.</p></div>}
          <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Modelos e preços: tabela com rolagem horizontal">
            <table className={styles.table}>
              <caption className="sr-only">Consumo dos modelos e preços unitários em dólares</caption>
              <thead><tr><th scope="col">Modelo</th><th scope="col">Entrada / 1M</th><th scope="col">Saída / 1M</th><th scope="col">Chamadas</th><th scope="col">Tokens</th><th scope="col">Custo (R$)</th></tr></thead>
              <tbody>{byModel.length === 0 ? <tr><td colSpan={6} className={styles.empty}>{unavailable ? "Aguardando dados de consumo." : "Nenhum modelo utilizado neste período."}</td></tr> : byModel.map(m => (
                <tr key={m.model}><td><span className={styles.modelName}>{m.model}</span>{!m.priceKnown && <span className={styles.unknownPrice}>Preço desconhecido</span>}</td><td>{m.input_per_1m != null ? `$${m.input_per_1m.toFixed(3)}` : "—"}</td><td>{m.output_per_1m != null ? `$${m.output_per_1m.toFixed(3)}` : "—"}</td><td>{m.calls.toLocaleString("pt-BR")}</td><td>{formatTokens(m.total)}</td><td className={styles.cost}>{formatBRL(m.cost * totals.brlRate)}</td></tr>
              ))}</tbody>
            </table>
          </div>
          <div className={styles.tools}>
            <div><h4>Manutenção do registro</h4><p>Recalcule chamadas antigas com os preços atuais ou verifique o acesso aos dados.</p></div>
            <div className={styles.toolActions}>
              <Button onClick={recalcAll} disabled={busy} variant="outline" className={styles.secondaryAction}>{recalcing ? <Loader2 aria-hidden="true" className="animate-spin" /> : <Calculator aria-hidden="true" />}Recalcular histórico</Button>
              <Button onClick={runDiagnose} disabled={busy} variant="outline" className={styles.secondaryAction}>{diagLoading ? <Loader2 aria-hidden="true" className="animate-spin" /> : <AlertCircle aria-hidden="true" />}Diagnosticar</Button>
            </div>
          </div>
          {recalcResult && <div className={styles.notice} data-tone="success" role="status"><CheckCircle2 aria-hidden="true" /><div><p>Histórico recalculado: <strong>{recalcResult.updated} de {recalcResult.scanned} chamadas</strong> atualizadas.</p>{recalcResult.unknownModels.length > 0 && <p>Modelos sem preço no cache: {recalcResult.unknownModels.join(", ")}</p>}</div></div>}
          {diagResult && (
            <div className={styles.diagnosis} role="status">
              <div className={styles.diagnosisHeading}><h4>{diagResult.ok ? "Diagnóstico: tudo certo" : "Diagnóstico: verifique os registros"}</h4><button type="button" onClick={() => setDiagResult(null)} aria-label="Fechar diagnóstico"><X aria-hidden="true" /></button></div>
              {diagResult.checks?.map((check, i) => <div key={i} className={styles.diagnosticCheck} data-ok={check.ok}>{check.ok ? <CheckCircle2 aria-hidden="true" /> : <AlertCircle aria-hidden="true" />}<div><strong>{check.step}</strong><p>{check.message}</p>{check.hint && <p>{check.hint}</p>}</div></div>)}
            </div>
          )}
          <details className={styles.methodology}>
            <summary>Como os custos são calculados <ChevronDown aria-hidden="true" /></summary>
            <p>Os preços são consultados no catálogo público LiteLLM, com atualização automática a cada 6 horas e fallback no banco ou na tabela de referência. A conversão USD/BRL usa a AwesomeAPI, também com cache de 6 horas e fallback no banco.</p>
            <p>Para informar uma cotação manual nas consultas à API, use <code>?brl=5.20</code>. Chamadas sem preço conhecido aparecem com custo zero até a atualização dos preços e o recálculo do histórico.</p>
          </details>
        </section>

        <section className={styles.panel} aria-labelledby="origins-title">
          <div className={styles.sectionHeading}><div><h3 id="origins-title">Agentes e campanhas</h3><p>As 10 origens com maior custo no período, em reais.</p></div></div>
          <figure className={styles.originsChart} aria-label="Gráfico de custo por agente ou campanha">
            {unavailable ? <p className={styles.chartLoading}>Aguardando dados de consumo.</p> : <TopSourcesChart bySourceLabel={bySourceLabel} brlRate={totals.brlRate} />}
          </figure>
        </section>

        {isAdminView && byClient && byClient.length > 0 && (
          <section className={styles.panel} aria-labelledby="clients-title">
            <div className={styles.sectionHeading}><div><h3 id="clients-title">Custos por cliente</h3><p>Distribuição do consumo entre as contas.</p></div><span className={styles.adminLabel}>Administrador</span></div>
            <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Custos por cliente: tabela com rolagem horizontal">
              <table className={styles.table}>
                <caption className="sr-only">Custos por cliente, disponível apenas para administradores</caption>
                <thead><tr><th scope="col">Cliente</th><th scope="col">Chamadas</th><th scope="col">Tokens</th><th scope="col">Custo (USD)</th><th scope="col">Custo (R$)</th></tr></thead>
                <tbody>{byClient.map(c => <tr key={c.client_id || "_none"}><td><strong>{c.name}</strong>{c.client_id && <span className={styles.clientId}>{c.client_id}</span>}</td><td>{c.calls.toLocaleString("pt-BR")}</td><td>{formatTokens(c.total)}</td><td>${c.cost.toFixed(4)}</td><td className={styles.cost}>{formatBRL(c.costBrl)}</td></tr>)}</tbody>
                <tfoot><tr><th scope="row">Total</th><td>{byClient.reduce((a, c) => a + c.calls, 0).toLocaleString("pt-BR")}</td><td>{formatTokens(byClient.reduce((a, c) => a + c.total, 0))}</td><td>${byClient.reduce((a, c) => a + c.cost, 0).toFixed(4)}</td><td>{formatBRL(byClient.reduce((a, c) => a + c.costBrl, 0))}</td></tr></tfoot>
              </table>
            </div>
          </section>
        )}

        <section className={styles.panel} aria-labelledby="recent-title">
          <div className={styles.sectionHeading}><div><h3 id="recent-title">Últimas chamadas</h3><p>Registro de entrada, saída e custo de cada chamada no período.</p></div><span className={styles.count}>{recent.length} registros</span></div>
          <p className={styles.scrollHint}>Deslize a tabela para consultar todos os campos.</p>
          <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Últimas chamadas: tabela com rolagem horizontal">
            <table className={cn(styles.table, styles.recentTable)}>
              <caption className="sr-only">Últimas chamadas de inteligência artificial</caption>
              <thead><tr><th scope="col">Quando</th><th scope="col">Recurso</th><th scope="col">Origem</th><th scope="col">Modelo</th><th scope="col">Entrada</th><th scope="col">Saída</th><th scope="col">Total</th><th scope="col">Custo (R$)</th></tr></thead>
              <tbody>{recent.length === 0 ? <tr><td colSpan={8} className={styles.empty}>{unavailable ? "Aguardando dados de consumo." : "Nenhuma chamada neste período."}</td></tr> : recent.map(r => {
                const meta = SOURCE_COLORS[r.source] || SOURCE_COLORS.other;
                return <tr key={r.id}><td><time dateTime={r.created_at}>{new Date(r.created_at).toLocaleString("pt-BR")}</time></td><td><span className={styles.resourceLabel}><span style={{ backgroundColor: meta.color }} aria-hidden="true" />{meta.label}</span></td><td className={styles.originName}>{r.source_label || "—"}</td><td><span className={styles.modelName}>{r.model}</span>{!r.priceKnown && <span className={styles.unknownPrice}>Preço desconhecido</span>}</td><td>{formatTokens(r.prompt_tokens)}</td><td>{formatTokens(r.completion_tokens)}</td><td>{formatTokens(r.total_tokens)}</td><td className={styles.cost}>{formatBRL(r.cost_brl)}</td></tr>;
              })}</tbody>
            </table>
          </div>
          {recent.length === 50 && <p className={styles.tableFoot}>Mostrando as últimas 50 chamadas. Selecione um período menor para consultar registros específicos.</p>}
        </section>
      </section>
    </div>
  );
}
