"use client";

/**
 * Dialog compartilhado pra criar lead manualmente.
 *
 * Usado em:
 *   - /leads (kanban) — botão "+ Adicionar Lead" na barra do topo
 *   - /chat — botão "Salvar como lead" no header da conversa quando o número
 *     não está no banco (campos vêm pré-preenchidos com remoteJid + push_name)
 *
 * Chama POST /api/leads/create. Em sucesso, dispara onCreated com o lead novo.
 */

import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Loader2, UserPlus, ChevronDown, ChevronUp } from "lucide-react";

export type LeadCreated = {
  id: number;
  remoteJid: string;
  nome_negocio: string;
  status: string;
};

export type AddLeadDialogProps = {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** Pré-preenche o JID/telefone (ex: vindo do /chat) */
  defaultRemoteJid?: string;
  /** Pré-preenche o nome (ex: push_name do WhatsApp) */
  defaultName?: string;
  /** Lista de status disponíveis no kanban (status_key do kanban_columns). Se vazio, mostra default. */
  statusOptions?: { key: string; label: string }[];
  /** Status inicial sugerido */
  defaultStatus?: string;
  /** Callback quando lead é criado com sucesso */
  onCreated?: (lead: LeadCreated) => void;
};

const FALLBACK_STATUS = [
  { key: "novo", label: "Novo" },
  { key: "primeiro_contato", label: "Primeiro contato" },
  { key: "interessado", label: "Interessado" },
  { key: "follow-up", label: "Follow-up" },
];

export function AddLeadDialog({
  open,
  onOpenChange,
  defaultRemoteJid,
  defaultName,
  statusOptions,
  defaultStatus,
  onCreated,
}: AddLeadDialogProps) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [ramo, setRamo] = useState("");
  const [endereco, setEndereco] = useState("");
  const [status, setStatus] = useState(defaultStatus || "novo");
  const [notas, setNotas] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Variáveis "avançadas" — colapsadas por default. Quando o lead veio do
  // WhatsApp espontâneo (sem captador), o usuário preenche aqui pra que a
  // IA e os templates de follow-up tenham contexto rico.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [website, setWebsite] = useState("");
  const [email, setEmail] = useState("");
  const [avaliacao, setAvaliacao] = useState("");
  const [reviews, setReviews] = useState("");
  const [categoria, setCategoria] = useState("");

  // Reseta os campos quando abre / muda defaults.
  useEffect(() => {
    if (open) {
      setName(defaultName || "");
      setPhone(defaultRemoteJid || "");
      setRamo("");
      setEndereco("");
      setStatus(defaultStatus || "novo");
      setNotas("");
      setWebsite("");
      setEmail("");
      setAvaliacao("");
      setReviews("");
      setCategoria("");
      setAdvancedOpen(false);
      setError(null);
    }
  }, [open, defaultRemoteJid, defaultName, defaultStatus]);

  const options = (statusOptions && statusOptions.length > 0) ? statusOptions : FALLBACK_STATUS;

  async function save() {
    setError(null);
    if (!name.trim()) {
      setError("Nome é obrigatório");
      return;
    }
    if (!phone.trim()) {
      setError("Telefone (ou JID) é obrigatório");
      return;
    }
    setSaving(true);
    try {
      const r = await fetch("/api/leads/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome_negocio: name.trim(),
          telefone: phone.includes("@") ? null : phone.trim(),
          remoteJid: phone.includes("@") ? phone.trim() : null,
          ramo_negocio: ramo.trim() || null,
          endereco: endereco.trim() || null,
          status,
          notas: notas.trim() || null,
          website: website.trim() || null,
          email: email.trim() || null,
          avaliacao: avaliacao.trim() || null,
          reviews: reviews.trim() || null,
          categoria: categoria.trim() || null,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        setError(d.error || "Erro ao salvar");
        return;
      }
      onCreated?.(d.lead);
      onOpenChange(false);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogTitle className="flex items-center gap-2">
          <UserPlus className="w-4 h-4 text-primary" /> Adicionar lead manualmente
        </DialogTitle>

        <div className="space-y-3">
          <div>
            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Nome (negócio ou pessoa) *</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Maria Silva — Salão da Maria" autoFocus />
          </div>
          <div>
            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Telefone (com DDD) *</label>
            <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="11999998888 ou JID completo" />
            <p className="text-[10px] text-muted-foreground mt-0.5">Cole DDD+número (só dígitos) ou o JID se já souber</p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Ramo / Categoria</label>
              <Input value={ramo} onChange={(e) => setRamo(e.target.value)} placeholder="Ex: salão de beleza" />
            </div>
            <div>
              <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Status inicial</label>
              <Select value={status} onValueChange={(v) => setStatus(v || "novo")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {options.map(o => <SelectItem key={o.key} value={o.key}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Endereço (opcional)</label>
            <Input value={endereco} onChange={(e) => setEndereco(e.target.value)} placeholder="..." />
          </div>
          <div>
            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Notas (opcional)</label>
            <Textarea value={notas} onChange={(e) => setNotas(e.target.value)} rows={2} placeholder="Como conheceu, o que conversou..." />
          </div>

          {/* Variáveis avançadas — colapsável. Útil pra lead vindo do WhatsApp
              espontâneo: preenche aqui o que a IA/templates precisam saber. */}
          <button
            type="button"
            onClick={() => setAdvancedOpen(!advancedOpen)}
            className="w-full flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-muted-foreground hover:text-foreground transition px-2 py-1.5 rounded bg-white/5 border border-white/10"
          >
            <span>Mais informações do lead (opcional)</span>
            {advancedOpen ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
          {advancedOpen && (
            <div className="space-y-2 p-3 rounded-lg bg-black/30 border border-white/5">
              <p className="text-[10px] text-muted-foreground -mt-1">Esses dados alimentam variáveis do sistema (ex: <code className="font-mono text-primary">{"{website}"}</code>, <code className="font-mono text-primary">{"{email}"}</code>) usadas pela IA e nos lembretes.</p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">Website</label>
                  <Input value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://..." />
                </div>
                <div>
                  <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">E-mail</label>
                  <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="cliente@exemplo.com" />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">Avaliação</label>
                  <Input value={avaliacao} onChange={(e) => setAvaliacao(e.target.value)} placeholder="4.5" />
                </div>
                <div>
                  <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">Reviews</label>
                  <Input value={reviews} onChange={(e) => setReviews(e.target.value)} placeholder="120" />
                </div>
                <div>
                  <label className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground">Categoria</label>
                  <Input value={categoria} onChange={(e) => setCategoria(e.target.value)} placeholder="Ex: hair_salon" />
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="text-xs text-red-400 bg-red-500/10 border border-red-500/30 rounded px-2 py-1.5">
              {error}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancelar</Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
            Adicionar lead
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
