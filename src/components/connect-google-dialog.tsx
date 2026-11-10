"use client";

/**
 * Modal pra conectar Google Calendar de um agente diretamente da página
 * /calendario (sem precisar ir até /agente/[id]).
 *
 * Fluxo:
 *   1. Carrega agentes do tenant
 *   2. Usuário escolhe agente + cola JSON do OAuth Web Client
 *   3. POST /api/calendario/connect-google salva e retorna next_url
 *   4. Frontend abre next_url em nova aba — usuário autoriza no Google →
 *      callback grava tokens → agente conectado
 */

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, ExternalLink, CheckCircle2, Bot } from "lucide-react";
import { cn } from "@/lib/utils";

type Agent = { id: number; name: string; google_connected?: boolean; google_email?: string | null };

export function ConnectGoogleDialog({
  open,
  onOpenChange,
  agents,
  onConnected,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  agents: Agent[];
  onConnected?: (agentId: number) => void;
}) {
  const [agentId, setAgentId] = useState<string>("");
  const [json, setJson] = useState("");
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<"input" | "redirecting">("input");

  useEffect(() => {
    if (open) {
      setAgentId(agents[0]?.id ? String(agents[0].id) : "");
      setJson("");
      setError(null);
      setStep("input");
    }
  }, [open, agents]);

  const selectedAgent = agents.find((a) => String(a.id) === agentId);

  async function disconnect() {
    if (!agentId) return;
    setError(null);
    setDisconnecting(true);
    try {
      const r = await fetch("/api/calendario/connect-google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: Number(agentId),
          action: "disconnect",
        }),
      });
      const d = await r.json();
      if (!d.ok) throw new Error(d.error || "Erro ao desconectar");
      onConnected?.(Number(agentId));
      onOpenChange(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setDisconnecting(false);
    }
  }

  async function connect() {
    setError(null);
    if (!agentId) {
      setError("Selecione um agente");
      return;
    }
    setSaving(true);
    try {
      const r = await fetch("/api/calendario/connect-google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: Number(agentId),
          google_credentials_json: json.trim() ? json.trim() : undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error || "Erro ao iniciar conexão com o Google");
        return;
      }
      // Step 2: pega a URL OAuth e abre em nova aba
      setStep("redirecting");
      const urlRes = await fetch(d.next_url);
      const urlData = await urlRes.json();
      if (urlData?.url) {
        window.open(urlData.url, "_blank", "noopener,noreferrer");
        onConnected?.(Number(agentId));
      } else {
        setError(urlData?.error || "Não consegui gerar URL OAuth");
        setStep("input");
      }
    } catch (e: any) {
      setError(e.message);
      setStep("input");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* max-h-[90vh] + flex column impede o modal de "explodir" pra fora da
          viewport quando o JSON colado é grande. Os botões ficam fixos no
          rodapé via flex-shrink-0 e a área do meio scrolla. */}
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col p-0 gap-0">
        <DialogTitle className="flex items-center gap-2 px-6 pt-6 pb-3 shrink-0 border-b border-white/5">
          <span className="text-base">🗓️</span> Conectar Google Calendar
        </DialogTitle>

        {step === "redirecting" ? (
          <div className="space-y-3 p-6">
            <div className="flex items-center gap-2 p-3 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
              <div className="text-sm">
                <p className="font-bold text-emerald-300">Credenciais salvas!</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Uma nova aba foi aberta com a tela de autorização do Google. Aprove o acesso e o agente estará conectado.
                </p>
              </div>
            </div>
            <Button onClick={() => onOpenChange(false)} className="w-full">Fechar</Button>
          </div>
        ) : (
          <>
            {/* Área scrollável quando o JSON é grande */}
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-3 min-h-0">
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                  Escolha o agente
                </label>
                {agents.length === 0 ? (
                  <div className="text-xs text-orange-300 bg-orange-500/10 border border-orange-500/30 rounded px-2 py-1.5 mt-1">
                    Nenhum agente nessa conta. Crie um agente em <strong>/agente</strong> antes.
                  </div>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 mt-1">
                    {agents.map((a) => {
                      const selected = agentId === String(a.id);
                      return (
                        <button
                          key={a.id}
                          type="button"
                          onClick={() => setAgentId(String(a.id))}
                          className={cn(
                            "flex items-center gap-2 px-2.5 py-2 rounded-lg border text-left transition",
                            selected
                              ? "bg-primary/15 border-primary/50 text-foreground"
                              : "bg-white/[0.03] border-white/10 text-muted-foreground hover:bg-white/5 hover:border-white/20"
                          )}
                        >
                          <div className={cn(
                            "w-7 h-7 rounded-md flex items-center justify-center shrink-0",
                            selected ? "bg-primary/20" : "bg-white/5"
                          )}>
                            <Bot className={cn("w-3.5 h-3.5", selected ? "text-primary" : "text-muted-foreground")} />
                          </div>
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-bold truncate">{a.name}</div>
                            <div className="text-[10px] flex items-center gap-1">
                              {a.google_connected ? (
                                <span className="text-emerald-400 flex items-center gap-0.5">
                                  <CheckCircle2 className="w-2.5 h-2.5" /> Google conectado
                                </span>
                              ) : (
                                <span className="text-muted-foreground/70">não conectado</span>
                              )}
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground mt-1.5">
                  Quem está ✓ pode reconectar ou desconectar.
                </p>
              </div>

              {selectedAgent?.google_connected && (
                <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-xs font-semibold text-emerald-300 flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5" /> Google conectado
                    </p>
                    <p className="text-[11px] text-muted-foreground truncate">
                      {selectedAgent.google_email ? `Conta: ${selectedAgent.google_email}` : "Pronto para agendamento"}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={disconnect}
                    disabled={disconnecting}
                    className="text-xs text-rose-300 hover:text-rose-200 hover:bg-rose-500/20 h-7 px-2.5 shrink-0"
                  >
                    {disconnecting ? <Loader2 className="w-3 h-3 animate-spin" /> : "Desconectar"}
                  </Button>
                </div>
              )}

              {/* Configuração avançada com JSON */}
              <details className="pt-1 border-t border-white/5 text-[11px]">
                <summary className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer select-none py-1 transition-colors">
                  Configuração avançada (usar JSON próprio do Google Cloud)
                </summary>
                <div className="mt-2 space-y-1.5">
                  <label className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    OAuth Web Client JSON
                  </label>
                  <Textarea
                    value={json}
                    onChange={(e) => setJson(e.target.value)}
                    placeholder='{"web": {"client_id": "...", "client_secret": "...", "redirect_uris": ["..."]}}'
                    className="h-20 font-mono text-xs resize-none bg-black/40 border-white/10"
                  />
                  <p className="text-[10px] text-muted-foreground leading-relaxed">
                    Deixe em branco para conectar com 1 clique usando as credenciais centrais da plataforma.
                  </p>
                </div>
              </details>

              {error && (
                <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5">
                  {error}
                </div>
              )}
            </div>

            {/* Rodapé fixo — botões sempre visíveis */}
            <div className="flex justify-end gap-2 px-6 py-3 border-t border-white/5 shrink-0 bg-background/95 backdrop-blur">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving || disconnecting}>Cancelar</Button>
              <Button onClick={connect} disabled={saving || disconnecting || agents.length === 0}>
                {saving && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
                {json.trim() ? "Salvar e conectar" : (selectedAgent?.google_connected ? "Reconectar conta Google" : "Conectar com Google")}
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
