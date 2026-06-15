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

type Agent = { id: number; name: string; google_connected?: boolean };

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

  async function connect() {
    setError(null);
    if (!agentId) {
      setError("Selecione um agente");
      return;
    }
    if (!json.trim()) {
      setError("Cole o JSON do OAuth Web Client");
      return;
    }
    setSaving(true);
    try {
      const r = await fetch("/api/calendario/connect-google", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agent_id: Number(agentId),
          google_credentials_json: json.trim(),
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error || "Erro ao salvar credenciais");
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
                  Quem está ✓ pode ter a credencial sobrescrita.
                </p>
              </div>

              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                  OAuth Web Client JSON
                </label>
                <Textarea
                  value={json}
                  onChange={(e) => setJson(e.target.value)}
                  placeholder='{"web": {"client_id": "...", "client_secret": "...", "redirect_uris": ["..."]}}'
                  className="h-24 font-mono text-xs resize-none"
                />
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Pegue em{" "}
                  <a
                    href="https://console.cloud.google.com/apis/credentials"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-primary underline inline-flex items-center gap-0.5"
                  >
                    Google Cloud Console <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                  {" "}→ Credentials → OAuth client → Download JSON
                </p>
              </div>

              {error && (
                <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5">
                  {error}
                </div>
              )}
            </div>

            {/* Rodapé fixo — botões sempre visíveis */}
            <div className="flex justify-end gap-2 px-6 py-3 border-t border-white/5 shrink-0 bg-background/95 backdrop-blur">
              <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancelar</Button>
              <Button onClick={connect} disabled={saving || agents.length === 0}>
                {saving && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
                Salvar e conectar
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
