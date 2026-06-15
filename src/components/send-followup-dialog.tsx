"use client";

/**
 * Modal pra mandar follow-up WhatsApp adhoc de um agendamento.
 *
 * Features:
 *   - Texto editável (sugestão default baseada no agendamento)
 *   - Chips de variáveis disponíveis (clicáveis pra inserir)
 *   - "Reescrever com IA" personaliza preservando as variáveis
 *   - Seleção de instância (filtrada pelo tenant — só vê as próprias)
 *   - Modelo IA: só admin pode trocar em runtime; cliente comum usa o
 *     central configurado pelo admin
 *
 * UI redesenhada: layout vertical limpo, sem cruzar elementos, modal com
 * altura máxima + scroll interno (evita botões saindo da viewport com
 * mensagens grandes).
 */

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Loader2, Sparkles, Send, Smartphone, ShieldAlert, X, CheckCircle2 } from "lucide-react";

const TEMPLATE_VARS = [
  "{nome}", "{nome_negocio}", "{ramo_negocio}", "{telefone}",
  "{hora_agendamento}", "{data_agendamento}", "{servico}", "{titulo}",
  "{endereco}", "{saudacao}",
];

type Appointment = {
  id: string;
  remote_jid: string;
  instance_name: string | null;
  title: string;
  service_name: string | null;
  start_at: string;
};

type Instance = { instance_name: string; provider?: string; status?: string };
type ModelOpt = { id: string; name?: string };

export function SendFollowupDialog({
  open,
  onOpenChange,
  appointment,
  isAdmin,
  onSent,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  appointment: Appointment | null;
  isAdmin: boolean;
  onSent?: () => void;
}) {
  const [message, setMessage] = useState("");
  const [instance, setInstance] = useState<string>("");
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loadingInstances, setLoadingInstances] = useState(false);
  const [model, setModel] = useState<string>("");
  const [modelOptions, setModelOptions] = useState<ModelOpt[]>([]);
  const [rewriting, setRewriting] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Inicialização ao abrir o dialog
  useEffect(() => {
    if (open && appointment) {
      setMessage(
        `Oi {nome}! Passando pra confirmar seu agendamento de {servico} em {data_agendamento} às {hora_agendamento}. Posso confirmar sua presença?`
      );
      setInstance(appointment.instance_name || "");
      setError(null);
      setFeedback(null);
    }
  }, [open, appointment]);

  // Carrega instâncias DO TENANT (não vaza outras contas)
  useEffect(() => {
    if (!open) return;
    setLoadingInstances(true);
    fetch("/api/instances", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok) setInstances(d.instances || []);
        else setInstances([]);
      })
      .catch(() => setInstances([]))
      .finally(() => setLoadingInstances(false));
  }, [open]);

  // Carrega modelos só pra admin
  useEffect(() => {
    if (!open || !isAdmin) return;
    fetch("/api/ai-models", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (d?.success && Array.isArray(d.models)) setModelOptions(d.models);
      })
      .catch(() => setModelOptions([]));
  }, [open, isAdmin]);

  function insertVar(v: string) {
    setMessage((prev) => prev + (prev.endsWith(" ") || !prev ? "" : " ") + v);
  }

  async function rewrite() {
    if (!appointment || !message.trim()) return;
    setRewriting(true);
    setError(null);
    try {
      const r = await fetch("/api/calendario/rewrite-message", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          appointment_id: appointment.id,
          model: isAdmin && model ? model : undefined,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error || "Erro ao reescrever");
        return;
      }
      setMessage(d.rewritten);
      setFeedback(`✓ Reescrito por ${d.model_used}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRewriting(false);
    }
  }

  async function send() {
    if (!appointment || !message.trim()) return;
    if (!instance) {
      setError("Selecione a instância de WhatsApp pra envio");
      return;
    }
    setSending(true);
    setError(null);
    try {
      const r = await fetch("/api/calendario/send-followup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          appointment_id: appointment.id,
          message,
          instance_name: instance,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error || "Erro ao enviar");
        return;
      }
      setFeedback(`✓ Enviado pra ${d.sent_to} via ${d.via}`);
      onSent?.();
      setTimeout(() => onOpenChange(false), 1200);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  }

  const phone = appointment?.remote_jid.replace(/@.*$/, "") || "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] flex flex-col p-0 gap-0">
        {/* Header fixo */}
        <DialogTitle className="flex items-center gap-2 px-6 pt-5 pb-3 shrink-0 border-b border-white/5">
          <Send className="w-4 h-4 text-primary" />
          <span>Enviar follow-up</span>
        </DialogTitle>

        {/* Card de contexto do agendamento */}
        {appointment && (
          <div className="px-6 pt-3 shrink-0">
            <div className="bg-secondary/40 rounded-lg p-2.5 text-xs space-y-0.5 border border-white/5">
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">Pra:</span>
                <span className="font-mono text-foreground">{phone}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-muted-foreground">Agendamento:</span>
                <span className="text-foreground truncate">{appointment.title}</span>
              </div>
            </div>
          </div>
        )}

        {/* Área scrollável */}
        <div className="flex-1 overflow-y-auto px-6 py-3 space-y-4 min-h-0">
          {/* Mensagem */}
          <div>
            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
              Mensagem
            </label>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={4}
              className="text-sm mt-1 resize-none"
              placeholder="Oi {nome}!..."
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              Clique numa variável abaixo pra inserir no fim:
            </p>
            <div className="flex flex-wrap gap-1 mt-1">
              {TEMPLATE_VARS.map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => insertVar(v)}
                  className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-white/5 border border-white/10 hover:bg-primary/10 hover:border-primary/30 text-primary transition"
                  title={`Inserir ${v}`}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>

          {/* Instância — sempre visível */}
          <div>
            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-1">
              <Smartphone className="w-3 h-3" /> Instância de envio
            </label>
            {loadingInstances ? (
              <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2">
                <Loader2 className="w-3 h-3 animate-spin" /> Carregando…
              </div>
            ) : instances.length === 0 ? (
              <div className="text-xs text-orange-300 bg-orange-500/10 border border-orange-500/30 rounded px-2 py-1.5 mt-1">
                Nenhuma instância de WhatsApp conectada nessa conta. Vá em /whatsapp e conecte primeiro.
              </div>
            ) : (
              <Select value={instance} onValueChange={(v) => setInstance(v || "")}>
                <SelectTrigger className="text-sm mt-1">
                  <SelectValue placeholder="Selecionar instância" />
                </SelectTrigger>
                <SelectContent>
                  {instances.map((i) => (
                    <SelectItem key={i.instance_name} value={i.instance_name}>
                      <span className="flex items-center gap-2">
                        <span className="font-mono">{i.instance_name}</span>
                        {i.status === "open" && (
                          <span className="text-[9px] text-emerald-400">● online</span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {/* Modelo IA — só admin. Card destacado em purple. Trigger maior
              (h-11) com font-mono pro ID do modelo ser legível. Sem `value=""`
              porque o Radix Select esconde texto quando value é string vazia. */}
          {isAdmin && (
            <div className="rounded-lg bg-purple-500/[0.06] border border-purple-500/20 p-2.5 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <ShieldAlert className="w-3.5 h-3.5 text-purple-300" />
                <label className="text-[10px] font-black uppercase tracking-widest text-purple-200">
                  Modelo IA · admin
                </label>
              </div>
              {modelOptions.length === 0 ? (
                <div className="text-[11px] text-orange-300 bg-orange-500/10 border border-orange-500/30 rounded px-2 py-1.5">
                  Sem modelos disponíveis. Configure a API key Gemini em <strong>Configurações</strong>.
                </div>
              ) : (
                <Select value={model || "_default"} onValueChange={(v) => setModel(v === "_default" ? "" : (v || ""))}>
                  <SelectTrigger className="text-sm h-11 bg-white/5 border-purple-500/20 hover:bg-white/[0.07] font-mono">
                    <SelectValue placeholder="Default do organizer" />
                  </SelectTrigger>
                  <SelectContent className="max-h-[40vh]">
                    <SelectItem value="_default" className="text-xs">
                      <span className="text-muted-foreground italic">Default do organizer (não trocar)</span>
                    </SelectItem>
                    {modelOptions.map((m) => (
                      <SelectItem key={m.id} value={m.id} className="text-xs">
                        <div className="flex flex-col">
                          <span className="font-mono font-bold">{m.id}</span>
                          {m.name && m.name !== m.id && (
                            <span className="text-[9px] text-muted-foreground">{m.name}</span>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <p className="text-[10px] text-purple-200/60 leading-relaxed">
                Cliente comum sempre usa o modelo central. Você troca em runtime — útil quando Google lança modelo novo.
              </p>
            </div>
          )}

          {/* Feedback / erro */}
          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5 flex items-start gap-2">
              <X className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {feedback && (
            <div className="text-xs text-emerald-300 bg-emerald-500/10 border border-emerald-500/30 rounded px-2 py-1.5 flex items-start gap-2">
              <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{feedback}</span>
            </div>
          )}
        </div>

        {/* Rodapé fixo com ações */}
        <div className="flex flex-col sm:flex-row sm:justify-between sm:items-center gap-2 px-6 py-3 border-t border-white/5 shrink-0 bg-background/95 backdrop-blur">
          <Button
            variant="outline"
            onClick={rewrite}
            disabled={rewriting || sending || !message.trim()}
            className="w-full sm:w-auto"
          >
            {rewriting ? (
              <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5 mr-1 text-primary" />
            )}
            Reescrever com IA
          </Button>
          <div className="flex gap-2 w-full sm:w-auto">
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={sending}
              className="flex-1 sm:flex-none"
            >
              Cancelar
            </Button>
            <Button
              onClick={send}
              disabled={sending || !message.trim() || !instance || instances.length === 0}
              className="flex-1 sm:flex-none"
            >
              {sending && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
              <Send className="w-3.5 h-3.5 mr-1" /> Enviar agora
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
