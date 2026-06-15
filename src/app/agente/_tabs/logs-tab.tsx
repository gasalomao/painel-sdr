"use client";

import { Fragment } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Activity, Info, Trash2, XCircle } from "lucide-react";
import { CopyButton } from "../_components/copy-button";

type WebhookLog = {
  created_at: string;
  event: string;
  instance_name: string;
  payload: any;
};

function eventStyle(event: string) {
  if (event?.includes("error")) return "bg-red-500/10 text-red-500 border-red-500/20";
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
    <section className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-black tracking-tight">Logs de Webhook</h3>
          <p className="text-xs text-muted-foreground mt-1">Monitore os eventos em tempo real.</p>
        </div>
        <Button
          onClick={() => setWebhookLogs([])}
          variant="ghost"
          className="text-red-500 hover:bg-red-500/10 gap-2 font-bold text-[10px] uppercase tracking-widest"
        >
          <Trash2 className="w-3 h-3" /> Limpar Visualização
        </Button>
      </div>

      {/* Tabela */}
      <div className="glass-card rounded-[2rem] border-white/10 overflow-hidden bg-white/[0.02]">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="bg-white/5 text-muted-foreground font-black uppercase tracking-widest text-[9px]">
                <th className="px-6 py-4">Data/Hora</th>
                <th className="px-6 py-4">Evento</th>
                <th className="px-6 py-4">Instância</th>
                <th className="px-6 py-4">Resumo</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5">
              {webhookLogs.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-6 py-12 text-center text-muted-foreground italic">
                    Nenhum log recebido nesta sessão...
                  </td>
                </tr>
              )}
              {webhookLogs.map((log, i) => (
                <Fragment key={i}>
                  <tr className="hover:bg-white/[0.02] transition-colors group">
                    <td className="px-6 py-4 whitespace-nowrap text-white/50">
                      {new Date(log.created_at).toLocaleTimeString()}
                    </td>
                    <td className="px-6 py-4">
                      <span className={cn("px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-tighter border", eventStyle(log.event))}>
                        {log.event}
                      </span>
                    </td>
                    <td className="px-6 py-4 font-mono text-white/70">{log.instance_name}</td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="max-w-[150px] truncate text-muted-foreground group-hover:text-white transition-colors">
                          {JSON.stringify(log.payload)}
                        </div>
                        <div className="flex items-center gap-1 ml-auto opacity-0 group-hover:opacity-100 transition-opacity text-white">
                          <Button onClick={() => toggleLog(i)} size="icon" variant="ghost" className="h-7 w-7 text-primary hover:bg-primary/10 rounded-md">
                            <Info className="w-3.5 h-3.5" />
                          </Button>
                          <CopyButton text={JSON.stringify(log.payload, null, 2)} label="" />
                        </div>
                      </div>
                    </td>
                  </tr>

                  {expandedLogs.includes(i) && (
                    <tr className="bg-black/40 animate-in slide-in-from-top-2 duration-300">
                      <td colSpan={4} className="px-8 py-6">
                        <div className="space-y-4 border-l-2 border-primary/30 pl-6">
                          <div className="flex items-center justify-between">
                            <h5 className="text-[10px] font-black uppercase tracking-widest text-primary flex items-center gap-2">
                              <Activity className="w-3 h-3" /> Conteúdo Completo do Evento
                            </h5>
                            <Button onClick={() => toggleLog(i)} size="icon" variant="ghost" className="h-6 w-6 text-muted-foreground hover:text-white">
                              <XCircle className="w-4 h-4" />
                            </Button>
                          </div>
                          <pre className="bg-[#050505] border border-white/5 p-6 rounded-2xl text-[11px] font-mono leading-relaxed overflow-x-auto text-blue-100/80 custom-scrollbar shadow-inner">
                            {JSON.stringify(log.payload, null, 2)}
                          </pre>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
