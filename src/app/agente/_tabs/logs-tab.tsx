"use client";

import { Fragment } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Activity, ChevronDown, ChevronUp, Info, Trash2 } from "lucide-react";
import { CopyButton } from "../_components/copy-button";

type WebhookLog = {
  created_at: string;
  event: string;
  instance_name: string;
  payload: any;
};

type WebhookLogWithId = WebhookLog & { id?: string | number };

function eventStyle(event: string) {
  if (event?.includes("error")) return "bg-red-500/10 text-red-400 border-red-500/20";
  if (event?.includes("AGENT")) return "bg-primary/10 text-primary border-primary/20";
  return "bg-blue-500/10 text-blue-400 border-blue-500/20";
}

export function LogsTab({
  webhookLogs,
  setWebhookLogs,
  expandedLogs,
  toggleLog,
}: {
  webhookLogs: WebhookLog[];
  setWebhookLogs: (v: WebhookLog[]) => void;
  expandedLogs: number[];
  toggleLog: (idx: number) => void;
}) {
  return (
    <section className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-blue-500/15 text-blue-300 shrink-0">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">Logs de webhook</h3>
            <p className="text-xs text-muted-foreground mt-0.5">Monitore os eventos recebidos em tempo real.</p>
          </div>
        </div>
        <Button
          onClick={() => setWebhookLogs([])}
          variant="ghost"
          className="text-red-400 hover:bg-red-500/10 gap-2 font-medium text-xs"
        >
          <Trash2 className="w-3.5 h-3.5" /> Limpar
        </Button>
      </div>

      {/* Lista de logs */}
      <div className="border border-white/[0.08] bg-card/80 rounded-xl shadow-none overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="bg-white/[0.02] text-muted-foreground font-medium uppercase tracking-wide text-[10px]">
                <th className="px-4 py-3 w-28">Horário</th>
                <th className="px-4 py-3 w-40">Evento</th>
                <th className="px-4 py-3 w-36">Instância</th>
                <th className="px-4 py-3 min-w-[200px]">Resumo</th>
                <th className="px-4 py-3 w-12"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {webhookLogs.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground italic">
                    Nenhum log recebido nesta sessão.
                  </td>
                </tr>
              )}
              {(webhookLogs as WebhookLogWithId[]).map((log, i) => {
                const isExpanded = expandedLogs.includes(i);
                return (
                  <Fragment key={log.id ?? i}>
                    <tr className="hover:bg-white/[0.02] transition-colors">
                      <td className="px-4 py-3 whitespace-nowrap text-muted-foreground tabular-nums">
                        {new Date(log.created_at).toLocaleTimeString()}
                      </td>
                      <td className="px-4 py-3">
                        <span className={cn("px-2 py-0.5 rounded-md text-[10px] font-medium uppercase tracking-wide border", eventStyle(log.event))}>
                          {log.event}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-foreground/70">{log.instance_name || "—"}</td>
                      <td className="px-4 py-3">
                        <div className="max-w-[280px] truncate text-muted-foreground">
                          {JSON.stringify(log.payload)}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <Button
                            onClick={() => toggleLog(i)}
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground hover:bg-white/[0.05] rounded-md"
                            title={isExpanded ? "Recolher" : "Expandir"}
                          >
                            {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                          </Button>
                          <CopyButton text={JSON.stringify(log.payload, null, 2)} label="" />
                        </div>
                      </td>
                    </tr>

                    {isExpanded && (
                      <tr className="bg-black/30">
                        <td colSpan={5} className="px-6 py-5">
                          <div className="space-y-3">
                            <div className="flex items-center justify-between">
                              <h5 className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                                <Info className="w-3 h-3" /> Detalhes do evento
                              </h5>
                              <Button
                                onClick={() => toggleLog(i)}
                                size="icon"
                                variant="ghost"
                                className="h-6 w-6 text-muted-foreground hover:text-foreground"
                              >
                                <ChevronUp className="w-4 h-4" />
                              </Button>
                            </div>
                            <pre className="bg-black/40 border border-white/[0.06] p-4 rounded-lg text-[11px] font-mono leading-relaxed overflow-x-auto text-foreground/80">
                              {JSON.stringify(log.payload, null, 2)}
                            </pre>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}