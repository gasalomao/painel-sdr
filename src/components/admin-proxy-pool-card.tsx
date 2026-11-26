"use client";

import { useState, type ChangeEvent } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ShieldCheck,
  Upload,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Loader2,
  AlertTriangle,
  Ban,
  RotateCcw,
  CheckCircle2,
  Activity,
} from "lucide-react";
import { cn } from "@/lib/utils";

type ProxyProtocol = "http" | "https" | "socks4" | "socks5";
type ProxyBlacklistReason = "used" | "failed" | "banned" | "manual";

interface ProxyPoolSnapshot {
  tableReady: boolean;
  settings: {
    defaultProtocol: ProxyProtocol;
    warmupReserveCount: number;
    strikeThreshold: number;
    allowVpsFallback: boolean;
    verifyBeforeAssign: boolean;
    blockSharedVpsDomino?: boolean;
  };
  stats: {
    totalActive: number;
    available: number;
    assigned: number;
    blacklisted: number;
    blacklistBreakdown: Record<ProxyBlacklistReason, number>;
    vpsFallbackCount: number;
    vpsSharedCount?: number;
    datacenterCount?: number;
    nonBrCount?: number;
    brResidentialCount?: number;
    unverifiedCount?: number;
    false428Count?: number;
  };
  assignedList: Array<{
    id: string;
    host: string;
    port: number;
    protocol: ProxyProtocol;
    assignedInstance: string;
    assignedClientId: string | null;
    assignedAt: string | null;
    failCount: number;
    countryCode?: string;
    providerLabel?: string;
    geoWarning?: string | null;
    isVerifiedBrResidential?: boolean;
  }>;
  blacklistList: Array<{
    id: string;
    host: string;
    port: number;
    protocol: ProxyProtocol;
    reason: ProxyBlacklistReason;
    blacklistedAt: string | null;
    failCount: number;
    lastError: string | null;
  }>;
  fallbackInstances: Array<{
    instanceName: string;
    clientId: string | null;
    provider: string;
    lastError: string | null;
    lastFallbackAt: string | null;
  }>;
}

interface ImportBatchSummary {
  totalParsed: number;
  duplicateCount: number;
  invalidCount: number;
  addedCount: number;
  keptAssignedCount: number;
  keptBlacklistedCount: number;
  retiredCount: number;
  migratedInstances: number;
  vpsFallbackInstances: number;
}

const REASON_LABELS: Record<ProxyBlacklistReason, string> = {
  used: "Já usado",
  failed: "Falhou",
  banned: "Ban 401/403",
  manual: "Manual",
};

/**
 * Painel exclusivo do Administrador em /configuracoes → WhatsApp para importar listas `.txt`
 * rotativas (Webshare), gerenciar Lista Negra de proxies usados/falhos e sincronizar chips.
 */
export function AdminProxyPoolCard() {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<ProxyPoolSnapshot | null>(null);
  const [rawText, setRawText] = useState("");
  const [protocol, setProtocol] = useState<ProxyProtocol>("http");
  const [clearUsedBlacklist, setClearUsedBlacklist] = useState(false);
  const [applyToInstances, setApplyToInstances] = useState(true);
  const [reserveCount, setReserveCount] = useState("0");
  const [strikeThreshold, setStrikeThreshold] = useState("3");
  const [blockSharedVpsDomino, setBlockSharedVpsDomino] = useState(false);
  const [subTab, setSubTab] = useState<"assigned" | "blacklist" | "fallback">("assigned");
  const [feedback, setFeedback] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [lastImport, setLastImport] = useState<ImportBatchSummary | null>(null);

  async function loadSnapshot() {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/proxies", { cache: "no-store" });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Falha ao carregar pool de proxies");
      setSnapshot(data);
      if (data.settings) {
        setProtocol(data.settings.defaultProtocol || "http");
        setReserveCount(String(data.settings.warmupReserveCount ?? 0));
        setStrikeThreshold(String(data.settings.strikeThreshold ?? 3));
        setBlockSharedVpsDomino(Boolean(data.settings.blockSharedVpsDomino));
      }
    } catch (err: unknown) {
      setFeedback({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoading(false);
    }
  }

  function handleToggle() {
    const next = !open;
    setOpen(next);
    if (next && !snapshot) {
      void loadSnapshot();
    }
  }

  async function handleFileSelected(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      setRawText(text);
      setFeedback({ kind: "ok", text: `Arquivo "${file.name}" carregado (${text.split(/\r?\n/).filter((l) => l.trim()).length} linhas). Clique em Importar .txt para aplicar.` });
    } catch {
      setFeedback({ kind: "err", text: "Não foi possível ler o arquivo .txt selecionado." });
    }
  }

  async function runAction(actionName: string, payload: Record<string, unknown>, successMsg: string) {
    setBusyAction(actionName);
    setFeedback(null);
    try {
      const res = await fetch("/api/admin/proxies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: actionName, ...payload }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Operação falhou");
      setSnapshot(data);
      if (data.importResult) setLastImport(data.importResult);
      setFeedback({ kind: "ok", text: successMsg });
      if (actionName === "import_txt") {
        setRawText("");
      }
    } catch (err: unknown) {
      setFeedback({ kind: "err", text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <Card className="border-emerald-500/20 bg-emerald-500/[0.02] overflow-hidden transition-all duration-300 shadow-md">
      <button
        type="button"
        data-slot="card-header"
        aria-expanded={open}
        aria-controls={open ? "settings-proxy-pool" : undefined}
        onClick={handleToggle}
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-emerald-500/10 flex items-center justify-center text-emerald-400 border border-emerald-500/20">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div className="flex flex-col gap-0.5 text-left">
            <CardTitle className="text-sm font-bold uppercase tracking-wider">
              Pool de Proxies Rotativos (Webshare .txt)
            </CardTitle>
            <p className="text-xs text-muted-foreground font-medium">
              {snapshot
                ? `${snapshot.stats.available} livres · ${snapshot.stats.assigned} em uso · ${snapshot.stats.blacklisted} na lista negra`
                : "Anexe o .txt mensal (Admin) para vincular 1 IP BR exclusivo por chip e gerenciar lista negra"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {snapshot && snapshot.stats.vpsFallbackCount > 0 && (
            <span className="text-xs bg-amber-500/10 text-amber-300 border border-amber-500/30 px-2 py-0.5 rounded-full font-black uppercase">
              {snapshot.stats.vpsFallbackCount} em fallback VPS
            </span>
          )}
          {open ? (
            <ChevronDown className="w-4 h-4 text-muted-foreground transition-transform duration-300" />
          ) : (
            <ChevronRight className="w-4 h-4 text-muted-foreground transition-transform duration-300" />
          )}
        </div>
      </button>

      {open && (
        <CardContent id="settings-proxy-pool" className="space-y-5 p-5 border-t border-white/5">
          {loading && !snapshot ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
              <Loader2 className="w-4 h-4 animate-spin" /> Carregando pool de proxies…
            </div>
          ) : (
            <>
              {snapshot && !snapshot.tableReady && (
                <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    A tabela <code className="font-mono">proxy_pool</code> ainda não foi aplicada no Supabase. Execute a migration{" "}
                    <code className="font-mono">030_proxy_pool.sql</code> (ou clique em Configurar Banco) antes de importar o .txt.
                  </span>
                </div>
              )}

              {snapshot && (
                <div className="grid grid-cols-2 md:grid-cols-5 gap-2.5">
                  <div className="rounded-xl bg-black/30 border border-white/10 p-3">
                    <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Livres</p>
                    <p className="text-xl font-black text-emerald-400 mt-0.5">{snapshot.stats.available}</p>
                  </div>
                  <div className="rounded-xl bg-black/30 border border-white/10 p-3">
                    <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Em uso (1:1)</p>
                    <p className="text-xl font-black text-cyan-300 mt-0.5">{snapshot.stats.assigned}</p>
                  </div>
                  <div className="rounded-xl bg-black/30 border border-white/10 p-3">
                    <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Lista Negra</p>
                    <p className="text-xl font-black text-rose-300 mt-0.5">{snapshot.stats.blacklisted}</p>
                  </div>
                  <div className="rounded-xl bg-black/30 border border-white/10 p-3">
                    <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Ban / Falhos</p>
                    <p className="text-sm font-bold text-white mt-1.5">
                      {(snapshot.stats.blacklistBreakdown.banned || 0) + (snapshot.stats.blacklistBreakdown.failed || 0)} falha ·{" "}
                      {snapshot.stats.blacklistBreakdown.used || 0} usados
                    </p>
                  </div>
                  <div className="rounded-xl bg-black/30 border border-white/10 p-3">
                    <p className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Fallback VPS</p>
                    <p className={cn("text-xl font-black mt-0.5", snapshot.stats.vpsFallbackCount > 0 ? "text-amber-300" : "text-white/70")}>
                      {snapshot.stats.vpsFallbackCount}
                    </p>
                  </div>
                </div>
              )}

              {/* Upload / Import .txt */}
              <div className="rounded-xl bg-black/30 border border-white/10 p-4 space-y-3">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-black uppercase tracking-widest text-emerald-300">
                      Atualizar Lista Mensal (.txt Webshare)
                    </p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Aceita linhas <code className="font-mono">IP:PORTA:USUARIO:SENHA</code>. Proxies usados ou falhos permanecem na Lista Negra automaticamente.
                    </p>
                  </div>
                  <label className="inline-flex items-center gap-2 px-3 py-2 rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-xs font-bold text-emerald-200 cursor-pointer shrink-0">
                    <Upload className="w-3.5 h-3.5" />
                    Anexar .txt
                    <input type="file" accept=".txt,text/plain" onChange={handleFileSelected} className="hidden" />
                  </label>
                </div>

                <textarea
                  value={rawText}
                  onChange={(e) => setRawText(e.target.value)}
                  rows={5}
                  placeholder={"23.129.254.10:5992:usuario:senha\n108.165.53.101:6840:usuario:senha"}
                  className="w-full rounded-xl bg-black/50 border border-white/10 p-3 font-mono text-xs text-white placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-emerald-500/40"
                />

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                  <div>
                    <label htmlFor="pool-protocol" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                      Protocolo padrão
                    </label>
                    <select
                      id="pool-protocol"
                      value={protocol}
                      onChange={(e) => setProtocol(e.target.value as ProxyProtocol)}
                      className="w-full mt-1 h-9 rounded-lg bg-black/50 border border-white/10 text-xs text-white px-2.5"
                    >
                      <option value="http">HTTP (recomendado Evolution)</option>
                      <option value="socks5">SOCKS5</option>
                      <option value="https">HTTPS</option>
                    </select>
                  </div>

                  <div>
                    <label htmlFor="pool-reserve" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                      Reserva Aquecedor
                    </label>
                    <Input
                      id="pool-reserve"
                      type="number"
                      min={0}
                      max={500}
                      value={reserveCount}
                      onChange={(e) => setReserveCount(e.target.value)}
                      className="mt-1 h-9 bg-black/50 border-white/10 text-xs"
                    />
                  </div>

                  <div>
                    <label htmlFor="pool-strikes" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                      Strikes antes de trocar
                    </label>
                    <Input
                      id="pool-strikes"
                      type="number"
                      min={1}
                      max={10}
                      value={strikeThreshold}
                      onChange={(e) => setStrikeThreshold(e.target.value)}
                      className="mt-1 h-9 bg-black/50 border-white/10 text-xs"
                    />
                  </div>
                </div>

                <div className="flex flex-col gap-2 text-xs text-muted-foreground">
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={applyToInstances}
                      onChange={(e) => setApplyToInstances(e.target.checked)}
                    />
                    Reaplicar nas instâncias Evolution e resgatar fallback VPS automaticamente após upload
                  </label>
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={clearUsedBlacklist}
                      onChange={(e) => setClearUsedBlacklist(e.target.checked)}
                    />
                    Virada mensal: liberar IPs que estavam apenas como &quot;usados&quot;
                  </label>
                  <label className="inline-flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={blockSharedVpsDomino}
                      onChange={(e) => setBlockSharedVpsDomino(e.target.checked)}
                    />
                    Bloquear fallback VPS compartilhado (anti-dominó: impede colocar 2+ chips no IP da VPS se o pool acabar)
                  </label>
                </div>

                {snapshot && (
                  <div className="rounded-lg bg-black/25 border border-white/10 px-3 py-2 text-[11px] text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                    <span>
                      BR Residencial/4G: <strong className="text-emerald-300">{snapshot.stats.brResidentialCount ?? 0}</strong>
                    </span>
                    <span>
                      Datacenter/ASN: <strong className="text-amber-300">{snapshot.stats.datacenterCount ?? 0}</strong>
                    </span>
                    <span>
                      Estrangeiro: <strong className="text-rose-300">{snapshot.stats.nonBrCount ?? 0}</strong>
                    </span>
                    <span>
                      Não auditado: <strong className="text-white/80">{snapshot.stats.unverifiedCount ?? 0}</strong>
                    </span>
                  </div>
                )}

                <div className="flex flex-wrap gap-2 pt-1">
                  <Button
                    size="sm"
                    disabled={!!busyAction || !rawText.trim()}
                    onClick={() =>
                      void runAction(
                        "import_txt",
                        { rawText, protocol, clearUsedBlacklist, applyToInstances },
                        "Lista importada e proxies atualizados nas instâncias!",
                      )
                    }
                    className="bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 border border-emerald-500/40 gap-1.5"
                  >
                    {busyAction === "import_txt" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Upload className="w-3.5 h-3.5" />}
                    Importar lista e aplicar
                  </Button>

                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!busyAction}
                    onClick={() =>
                      void runAction(
                        "update_settings",
                        {
                          protocol,
                          warmupReserveCount: Number(reserveCount || 0),
                          strikeThreshold: Number(strikeThreshold || 3),
                          blockSharedVpsDomino,
                        },
                        "Regras do pool atualizadas.",
                      )
                    }
                    className="gap-1.5"
                  >
                    Salvar regras
                  </Button>

                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!busyAction}
                    onClick={() =>
                      void runAction("test_available", {}, "Teste de conectividade dos proxies livres concluído.")
                    }
                    className="gap-1.5"
                  >
                    {busyAction === "test_available" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Activity className="w-3.5 h-3.5" />}
                    Testar livres
                  </Button>

                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!busyAction}
                    onClick={() =>
                      void runAction("audit_geo_asn", { limit: 40 }, "Auditoria Geo/ASN concluída para até 40 proxies ativos.")
                    }
                    className="gap-1.5"
                  >
                    {busyAction === "audit_geo_asn" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                    Auditar Geo/ASN do Pool
                  </Button>

                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!!busyAction}
                    onClick={() =>
                      void runAction("sync_all", {}, "Sincronização de instâncias pendentes/fallback concluída.")
                    }
                    className="gap-1.5"
                  >
                    {busyAction === "sync_all" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
                    Sincronizar instâncias
                  </Button>
                </div>
              </div>

              {feedback && (
                <div
                  role="status"
                  className={cn(
                    "p-3 rounded-xl border text-xs flex items-start gap-2",
                    feedback.kind === "ok"
                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-200"
                      : "bg-red-500/10 border-red-500/30 text-red-200",
                  )}
                >
                  {feedback.kind === "ok" ? <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" /> : <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />}
                  <span>{feedback.text}</span>
                </div>
              )}

              {lastImport && (
                <div className="rounded-xl bg-black/25 border border-white/10 p-3 text-xs text-muted-foreground">
                  <span className="font-bold text-white">Última importação:</span>{" "}
                  {lastImport.totalParsed} válidos · {lastImport.addedCount} novos · {lastImport.keptAssignedCount} mantidos em uso ·{" "}
                  {lastImport.keptBlacklistedCount} bloqueados na Lista Negra · {lastImport.retiredCount} expirados ·{" "}
                  {lastImport.migratedInstances} chips atualizados · {lastImport.vpsFallbackInstances} em fallback VPS.
                </div>
              )}

              {/* Sub-navegação: Vinculados / Lista Negra / Fallback VPS */}
              {snapshot && (
                <div className="space-y-3">
                  <div className="flex flex-wrap gap-2 border-b border-white/10 pb-2">
                    <Button
                      size="sm"
                      variant={subTab === "assigned" ? "default" : "ghost"}
                      onClick={() => setSubTab("assigned")}
                      className="text-xs h-8"
                    >
                      Vinculados ({snapshot.assignedList.length})
                    </Button>
                    <Button
                      size="sm"
                      variant={subTab === "blacklist" ? "default" : "ghost"}
                      onClick={() => setSubTab("blacklist")}
                      className="text-xs h-8"
                    >
                      Lista Negra ({snapshot.blacklistList.length})
                    </Button>
                    <Button
                      size="sm"
                      variant={subTab === "fallback" ? "default" : "ghost"}
                      onClick={() => setSubTab("fallback")}
                      className="text-xs h-8"
                    >
                      Fallback VPS ({snapshot.fallbackInstances.length})
                    </Button>
                  </div>

                  {subTab === "assigned" && (
                    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                      {snapshot.assignedList.length === 0 ? (
                        <p className="text-xs text-muted-foreground">Nenhuma instância vinculada no momento.</p>
                      ) : (
                        snapshot.assignedList.map((item) => (
                          <div
                            key={item.id}
                            className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-black/30 border border-white/10 text-xs"
                          >
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <p className="font-bold text-white truncate">{item.assignedInstance}</p>
                                {item.isVerifiedBrResidential ? (
                                  <span className="px-1.5 py-0.5 rounded bg-emerald-500/15 text-emerald-300 text-[10px] font-bold">
                                    BR Residencial
                                  </span>
                                ) : item.providerLabel?.includes("datacenter") ? (
                                  <span className="px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 text-[10px] font-bold">
                                    Datacenter{item.countryCode && item.countryCode !== "UNVERIFIED" ? ` (${item.countryCode})` : ""}
                                  </span>
                                ) : item.countryCode && item.countryCode !== "BR" && item.countryCode !== "UNVERIFIED" ? (
                                  <span className="px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 text-[10px] font-bold">
                                    Estrangeiro ({item.countryCode})
                                  </span>
                                ) : (
                                  <span className="px-1.5 py-0.5 rounded bg-white/10 text-white/70 text-[10px]">
                                    Não auditado
                                  </span>
                                )}
                              </div>
                              <p className="font-mono text-[11px] text-cyan-300">
                                {item.protocol}://{item.host}:{item.port} {item.failCount > 0 ? `· ${item.failCount} falha(s)` : ""}
                              </p>
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={!!busyAction}
                              onClick={() =>
                                void runAction(
                                  "rotate_instance",
                                  { instanceName: item.assignedInstance },
                                  `Proxy da instância "${item.assignedInstance}" trocado.`,
                                )
                              }
                              className="h-7 text-[11px] gap-1 shrink-0"
                            >
                              <RotateCcw className="w-3 h-3" /> Trocar IP
                            </Button>
                          </div>
                        ))
                      )}
                    </div>
                  )}

                  {subTab === "blacklist" && (
                    <div className="space-y-2">
                      {snapshot.blacklistList.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!!busyAction}
                            onClick={() => void runAction("clear_used", {}, "Proxies marcados como 'Já usado' removidos da Lista Negra.")}
                            className="h-7 text-[11px]"
                          >
                            Limpar &quot;Já usados&quot;
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!!busyAction}
                            onClick={() => void runAction("clear_failed", {}, "Proxies marcados como falha/ban removidos da Lista Negra.")}
                            className="h-7 text-[11px]"
                          >
                            Limpar &quot;Falhos/Ban&quot;
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!!busyAction}
                            onClick={() =>
                              void runAction(
                                "clear_false_428",
                                {},
                                "Proxies bloqueados por erro transitório 428 foram reativados no pool.",
                              )
                            }
                            className="h-7 text-[11px] border-emerald-500/40 text-emerald-200"
                          >
                            Reativar falsos 428{typeof snapshot.stats.false428Count === "number" ? ` (${snapshot.stats.false428Count})` : ""}
                          </Button>
                        </div>
                      )}
                      <div className="space-y-1.5 max-h-64 overflow-y-auto pr-1">
                        {snapshot.blacklistList.length === 0 ? (
                          <p className="text-xs text-muted-foreground">Nenhum proxy na Lista Negra.</p>
                        ) : (
                          snapshot.blacklistList.map((item) => (
                            <div
                              key={item.id}
                              className="flex items-center justify-between gap-2 p-2.5 rounded-lg bg-black/30 border border-rose-500/20 text-xs"
                            >
                              <div className="min-w-0">
                                <p className="font-mono text-white">
                                  {item.protocol}://{item.host}:{item.port}{" "}
                                  <span className="inline-flex items-center gap-1 ml-1 px-1.5 py-0.5 rounded bg-rose-500/15 text-rose-300 text-[10px] font-sans font-bold">
                                    <Ban className="w-2.5 h-2.5" /> {REASON_LABELS[item.reason] || item.reason}
                                  </span>
                                </p>
                                {item.lastError && (
                                  <p className="text-[11px] text-muted-foreground truncate mt-0.5">{item.lastError}</p>
                                )}
                              </div>
                              <Button
                                size="sm"
                                variant="ghost"
                                disabled={!!busyAction}
                                onClick={() =>
                                  void runAction(
                                    "unblacklist",
                                    { proxyId: item.id },
                                    `Proxy ${item.host}:${item.port} reativado no pool.`,
                                  )
                                }
                                className="h-7 text-[11px] text-emerald-300 shrink-0"
                              >
                                Reativar
                              </Button>
                            </div>
                          ))
                        )}
                      </div>
                    </div>
                  )}

                  {subTab === "fallback" && (
                    <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
                      {snapshot.fallbackInstances.length === 0 ? (
                        <p className="text-xs text-muted-foreground">Nenhuma instância aguardando proxy (fallback VPS).</p>
                      ) : (
                        snapshot.fallbackInstances.map((item) => (
                          <div
                            key={item.instanceName}
                            className="p-2.5 rounded-lg bg-black/30 border border-amber-500/20 text-xs space-y-0.5"
                          >
                            <p className="font-bold text-amber-200">{item.instanceName}</p>
                            <p className="text-[11px] text-muted-foreground">
                              Operando no IP padrão da VPS · {item.lastError || "Aguardando nova lista de proxies."}
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}
