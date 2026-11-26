"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ArrowRightLeft,
  ArrowUpRight,
  CheckCircle2,
  FlaskConical,
  RefreshCw,
  ShieldCheck,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { ExternalWarmupMode } from "@/lib/warmup/warmup-types";
import type {
  ExternalDiagnostic,
  InstanceItem,
  QuarantineEntry,
  SelfHealingActionRecord,
} from "./types";

const MODE_LABEL: Record<ExternalWarmupMode, string> = {
  off: "Desligado",
  receive_only: "Só receber (MMZap)",
  hybrid_quarantine: "Quarentena híbrida",
};

function formatShortDateTime(iso?: string | null): string {
  if (!iso) return "sem registro";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "sem registro";
  return d.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export interface MmzapLiveMonitorProps {
  chips: InstanceItem[];
  diagnostics: ExternalDiagnostic[];
  selfHealingLog: SelfHealingActionRecord[];
  styles: Record<string, string>;
  selfHealingBusy: boolean;
  onRunSelfHealing: () => Promise<void>;
  onRefreshAll: () => Promise<void>;
}

export function MmzapLiveMonitor({
  chips,
  diagnostics,
  selfHealingLog,
  styles,
  selfHealingBusy,
  onRunSelfHealing,
  onRefreshAll,
}: MmzapLiveMonitorProps) {
  const [quarantine, setQuarantine] = useState<QuarantineEntry[]>([]);
  const [loadingQuarantine, setLoadingQuarantine] = useState(false);
  const [simulatingChip, setSimulatingChip] = useState<string | null>(null);
  const [lastSimulation, setLastSimulation] = useState<{
    instance_name: string;
    intercepted: boolean;
    reason: string;
    mode: string;
  } | null>(null);

  const [hotswapOld, setHotswapOld] = useState<string>("");
  const [hotswapNew, setHotswapNew] = useState<string>("");
  const [swapping, setSwapping] = useState(false);

  const loadQuarantine = useCallback(async () => {
    setLoadingQuarantine(true);
    try {
      const res = await fetch("/api/warmup/external-shield?limit=40", {
        cache: "no-store",
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        entries?: QuarantineEntry[];
      } | null;
      if (json?.ok && Array.isArray(json.entries)) {
        setQuarantine(json.entries);
      }
    } catch {
      /* ignore */
    } finally {
      setLoadingQuarantine(false);
    }
  }, []);

  useEffect(() => {
    void loadQuarantine();
  }, [loadQuarantine]);

  const handleSimulateMmzap = async (instanceName: string) => {
    setSimulatingChip(instanceName);
    try {
      const res = await fetch("/api/warmup/external-shield", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "simulate_mmzap_inbound",
          instance_name: instanceName,
        }),
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        intercepted?: boolean;
        reason?: string;
        mode?: string;
        error?: string;
      } | null;

      if (!res.ok || !json?.ok) {
        toast.error(json?.error || "Falha ao simular recepção MMZap.");
        return;
      }

      setLastSimulation({
        instance_name: instanceName,
        intercepted: Boolean(json.intercepted),
        reason: String(json.reason || ""),
        mode: String(json.mode || "off"),
      });

      if (json.intercepted) {
        toast.success(
          `MMZap validado em ${instanceName}: mensagem interceptada sem tocar no CRM.`
        );
      } else {
        toast.warning(
          `Modo MMZap em ${instanceName} está desligado (${json.reason}). Ative "Só receber".`
        );
      }
      await Promise.all([loadQuarantine(), onRefreshAll()]);
    } finally {
      setSimulatingChip(null);
    }
  };

  const handlePromote = async (entry: QuarantineEntry) => {
    const res = await fetch("/api/warmup/external-shield", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "promote",
        entry_id: entry.id || entry.canonical_sender_phone,
        instance_name: entry.instance_name,
      }),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean } | null;
    if (res.ok && json?.ok) {
      toast.success(`Contato ${entry.canonical_sender_phone} liberado para o CRM.`);
      await loadQuarantine();
    } else {
      toast.error("Não foi possível promover o contato.");
    }
  };

  const handleHotswap = async () => {
    if (!hotswapOld || !hotswapNew || hotswapOld === hotswapNew) {
      toast.error("Selecione o chip com problema e um chip estepe diferente.");
      return;
    }
    setSwapping(true);
    try {
      const res = await fetch("/api/whatsapp/hotswap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          old_instance_name: hotswapOld,
          new_instance_name: hotswapNew,
        }),
      });
      const json = (await res.json().catch(() => null)) as {
        success?: boolean;
        error?: string;
        migrated_agent_ids?: string[];
        migrated_campaigns?: number;
      } | null;

      if (!res.ok || !json?.success) {
        toast.error(json?.error || "Falha na troca rápida.");
        return;
      }

      toast.success(
        `Troca concluída: ${json.migrated_agent_ids?.length || 0} agente(s) e ${json.migrated_campaigns || 0} campanha(s) transferidos.`
      );
      setHotswapOld("");
      setHotswapNew("");
      await onRefreshAll();
    } finally {
      setSwapping(false);
    }
  };

  const connectedStepes = chips.filter(
    (c) =>
      (c.connection_status === "open" || c.connection_status === "connected") &&
      !c.config?.is_quarantined
  );

  return (
    <div className={styles.panel}>
      <div className="divide-y divide-[#303a32]">
        {/* Seção 1: Diagnóstico ao vivo de Webhook & MMZap */}
        <section className="p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-[#edf2ee] flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                Escudo MMZap e Webhook ao vivo
              </h2>
              <p className="text-xs text-[#a5b1a8] mt-1">
                Confirma se a extensão MMZap está entrando pelo webhook e sendo barrada antes do CRM/Sarah.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void Promise.all([loadQuarantine(), onRefreshAll()])}
              className={styles.secondaryAction}
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Atualizar diagnóstico
            </button>
          </div>

          {lastSimulation && (
            <div
              role="status"
              className={cn(
                "rounded-lg border px-3.5 py-2.5 text-xs flex items-center gap-2",
                lastSimulation.intercepted
                  ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-100"
                  : "border-amber-500/35 bg-amber-500/10 text-amber-100"
              )}
            >
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>
                Teste em <strong>{lastSimulation.instance_name}</strong> (modo{" "}
                <code>{lastSimulation.mode}</code>):{" "}
                {lastSimulation.intercepted
                  ? "interceptação confirmada — CRM e agente IA blindados."
                  : `não interceptado (${lastSimulation.reason}). Ative o modo "Só receber".`}
              </span>
            </div>
          )}

          <div className="overflow-x-auto">
            <table className={styles.groupsTable}>
              <thead>
                <tr>
                  <th>Chip ADM</th>
                  <th>Webhook Evolution</th>
                  <th>Último evento</th>
                  <th>Modo MMZap</th>
                  <th>Recebidas MMZap</th>
                  <th className="text-right">Teste real</th>
                </tr>
              </thead>
              <tbody>
                {chips.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="text-center text-xs text-[#a5b1a8] py-6">
                      Nenhum chip administrador conectado ainda.
                    </td>
                  </tr>
                ) : (
                  chips.map((chip) => {
                    const diag = diagnostics.find(
                      (d) => d.instance_name === chip.instance_name
                    );
                    const mode = (diag?.shield_mode ||
                      chip.config?.external_warmup_mode ||
                      "off") as ExternalWarmupMode;
                    const today =
                      diag?.inbound_today ??
                      chip.config?.external_warmup_inbound_today ??
                      0;
                    const total =
                      diag?.inbound_total ??
                      chip.config?.external_warmup_inbound_total ??
                      0;
                    const busy = simulatingChip === chip.instance_name;

                    return (
                      <tr key={chip.instance_name}>
                        <td className="font-medium text-[#edf2ee]">
                          {chip.instance_name}
                        </td>
                        <td>
                          <span
                            className={cn(
                              "inline-flex items-center rounded-md border px-2 py-0.5 text-[11px]",
                              diag?.webhook_ok
                                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                                : "border-amber-500/30 bg-amber-500/10 text-amber-200"
                            )}
                          >
                            {diag?.webhook_ok ? "Ativo" : "Pendente"}
                          </span>
                        </td>
                        <td className="text-xs text-[#a5b1a8] tabular-nums">
                          {formatShortDateTime(diag?.recent_webhook_upsert_at)}
                        </td>
                        <td className="text-xs text-[#d3ded6]">{MODE_LABEL[mode]}</td>
                        <td className="text-xs font-mono tabular-nums text-[#edf2ee]">
                          {today} hoje · {total} total
                        </td>
                        <td className="text-right">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void handleSimulateMmzap(chip.instance_name)}
                            className={styles.secondaryAction}
                          >
                            <FlaskConical className="w-3.5 h-3.5 text-emerald-400" />
                            {busy ? "Testando..." : "Testar recepção"}
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Seção 2: Quarentena MMZap */}
        <section className="p-5 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-[#edf2ee]">
              Números externos barrados pelo escudo ({quarantine.length})
            </h3>
            {loadingQuarantine && (
              <span className="text-xs text-[#a5b1a8]">Atualizando...</span>
            )}
          </div>

          {quarantine.length === 0 ? (
            <p className="text-xs text-[#a5b1a8]">
              Nenhuma mensagem externa em quarentena ainda. Quando o MMZap enviar mensagens para um chip em modo &quot;Só receber&quot;, elas ficam registradas aqui sem entrar no CRM.
            </p>
          ) : (
            <div className="divide-y divide-[#303a32] border border-[#303a32] rounded-lg">
              {quarantine.slice(0, 12).map((q) => (
                <div
                  key={q.id || `${q.instance_name}-${q.canonical_sender_phone}`}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3.5 py-2.5 text-xs"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono tabular-nums text-[#edf2ee] font-medium">
                        +{q.canonical_sender_phone}
                      </span>
                      <span className="text-[#a5b1a8]">via {q.instance_name}</span>
                      <span className="text-[#a5b1a8] tabular-nums">
                        · {q.seen_count}x · {formatShortDateTime(q.last_seen_at)}
                      </span>
                    </div>
                    {q.message_preview && (
                      <p className="text-[#a5b1a8] truncate">{q.message_preview}</p>
                    )}
                  </div>
                  {!q.promoted_to_crm_at ? (
                    <button
                      type="button"
                      onClick={() => void handlePromote(q)}
                      className="inline-flex items-center gap-1 rounded-md border border-[#303a32] bg-[#141a15] px-2.5 py-1.5 text-[11px] font-medium text-[#d3ded6] hover:text-white shrink-0"
                    >
                      <ArrowUpRight className="w-3.5 h-3.5 text-emerald-400" />
                      Promover p/ CRM
                    </button>
                  ) : (
                    <span className="text-[11px] text-emerald-300 shrink-0">
                      Liberado no CRM
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Seção 3: Histórico de Auto-Cura */}
        <section className="p-5 space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-[#edf2ee] flex items-center gap-2">
                <Wrench className="w-4 h-4 text-emerald-400" />
                Registro da Auto-Cura Autônoma
              </h3>
              <p className="text-xs text-[#a5b1a8] mt-0.5">
                Reparos feitos sozinhos em webhook, proxy, sessão travada, perfil e grupos.
              </p>
            </div>
            <button
              type="button"
              disabled={selfHealingBusy}
              onClick={() => void onRunSelfHealing()}
              className={styles.secondaryAction}
            >
              <RefreshCw
                className={cn("w-3.5 h-3.5", selfHealingBusy && "animate-spin")}
              />
              {selfHealingBusy ? "Verificando..." : "Auto-curar agora"}
            </button>
          </div>

          {selfHealingLog.length === 0 ? (
            <p className="text-xs text-[#a5b1a8]">
              Nenhuma correção necessária até o momento. O sistema verifica tudo automaticamente a cada ciclo ou ao conectar um chip.
            </p>
          ) : (
            <div className="divide-y divide-[#303a32] border border-[#303a32] rounded-lg">
              {selfHealingLog.slice(0, 15).map((item) => (
                <div
                  key={item.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3.5 py-2.5 text-xs"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-[#edf2ee]">
                        {item.instance_name}
                      </span>
                      <span className="text-[#c2cfc6]">{item.issue}</span>
                    </div>
                    <p className="text-[#a5b1a8]">{item.resolution}</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={cn(
                        "rounded-md border px-2 py-0.5 text-[11px]",
                        item.status === "fixed"
                          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                          : "border-amber-500/35 bg-amber-500/10 text-amber-200"
                      )}
                    >
                      {item.status === "fixed" ? "Corrigido" : "Requer ação"}
                    </span>
                    <span className="text-[11px] font-mono tabular-nums text-[#a5b1a8]">
                      {formatShortDateTime(item.created_at)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Seção 4: Hotswap (Troca rápida de chip) */}
        <section className="p-5 space-y-3">
          <div>
            <h3 className="text-sm font-semibold text-[#edf2ee] flex items-center gap-2">
              <ArrowRightLeft className="w-4 h-4 text-emerald-400" />
              Troca rápida de chip (Hotswap)
            </h3>
            <p className="text-xs text-[#a5b1a8] mt-0.5">
              Transfere agentes de IA, campanhas e automações de um chip caído para um estepe conectado sem perder contexto.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
            <div className={styles.fieldGroup}>
              <label htmlFor="hs-old" className={styles.fieldLabel}>
                Chip com problema
              </label>
              <select
                id="hs-old"
                value={hotswapOld}
                onChange={(e) => setHotswapOld(e.target.value)}
                className={styles.fieldSelect}
              >
                <option value="">Selecione...</option>
                {chips.map((c) => (
                  <option key={c.instance_name} value={c.instance_name}>
                    {c.instance_name} ({c.connection_status})
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.fieldGroup}>
              <label htmlFor="hs-new" className={styles.fieldLabel}>
                Chip estepe pronto
              </label>
              <select
                id="hs-new"
                value={hotswapNew}
                onChange={(e) => setHotswapNew(e.target.value)}
                className={styles.fieldSelect}
              >
                <option value="">Selecione...</option>
                {connectedStepes
                  .filter((c) => c.instance_name !== hotswapOld)
                  .map((c) => (
                    <option key={c.instance_name} value={c.instance_name}>
                      {c.instance_name} (Fase {c.config?.stage || 1} ·{" "}
                      {c.config?.health_score ?? 100}%)
                    </option>
                  ))}
              </select>
            </div>

            <button
              type="button"
              disabled={swapping || !hotswapOld || !hotswapNew}
              onClick={() => void handleHotswap()}
              className={styles.primaryAction}
            >
              <ArrowRightLeft className="w-3.5 h-3.5" />
              {swapping ? "Transferindo..." : "Transferir agora"}
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}
