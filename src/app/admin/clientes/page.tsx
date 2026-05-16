"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  Plus, Trash2, Pencil, KeyRound, LogIn, Power, Check, X, Loader2,
  Shield, UserCog, AlertCircle, Bot,
} from "lucide-react";

type Client = {
  id: string;
  name: string;
  email: string;
  is_admin: boolean;
  is_active: boolean;
  default_ai_model: string | null;
  features: Record<string, boolean>;
  organizer_prompt?: string | null;
  organizer_enabled?: boolean;
  notes?: string | null;
  created_at: string;
};

// Mantém em sincronia com migrations/001_multi_tenant.sql:clients.features default
const FEATURE_LIST = [
  { key: "dashboard",     label: "Dashboard" },
  { key: "leads",         label: "Leads / CRM" },
  { key: "chat",          label: "Chat" },
  { key: "agente",        label: "Agente IA" },
  { key: "automacao",     label: "Automação" },
  { key: "disparo",       label: "Disparo em Massa" },
  { key: "followup",      label: "Follow-up" },
  { key: "captador",      label: "Captador Maps" },
  { key: "inteligencia",  label: "Inteligência" },
  { key: "whatsapp",      label: "WhatsApp" },
  { key: "historico",     label: "Histórico IA" },
  { key: "tokens",        label: "Tokens IA" },
  { key: "configuracoes", label: "Configurações" },
];

// AI_MODEL_OPTIONS NÃO é mais hardcoded — vem de /api/ai-models em tempo real,
// que consulta a Google AI usando a API Key salva. Quando a Google lança um
// modelo novo (gemini-4-flash etc), ele aparece aqui automaticamente sem precisar
// de deploy.
const DEFAULT_AI_MODEL = "gemini-3.1-flash-lite-preview";

const DEFAULT_ORGANIZER_PROMPT = `Você é um SDR experiente analisando conversas WhatsApp de leads.

Sua função: ler o histórico recente de cada conversa e decidir o próximo status do lead.

Status possíveis:
- novo: ainda não houve interação
- primeiro_contato: foi enviada mensagem mas cliente não respondeu
- follow-up: cliente respondeu mas precisa de follow-up
- qualificado: lead demonstrou interesse real
- fechado: venda concluída
- perdido: cliente desistiu ou não tem interesse

Para cada conversa, retorne JSON: { status_novo, razao_curta, resumo }.`;

const DEFAULT_FEATURES = Object.fromEntries(FEATURE_LIST.map((f) => [f.key, true]));
const NO_FEATURES = Object.fromEntries(FEATURE_LIST.map((f) => [f.key, false]));

type AiModel = { id: string; name: string; description?: string };

export default function AdminClientesPage() {
  const router = useRouter();
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Client | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/clients", { cache: "no-store" });
      const d = await r.json();
      if (d.ok) setClients(d.clients);
    } catch (err: any) {
      setError(err?.message || "Falha ao carregar");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { reload(); }, []);

  // ============= CREATE =============
  const handleCreate = () => {
    setEditing({
      id: "",
      name: "",
      email: "",
      is_admin: false,
      is_active: true,
      default_ai_model: "gemini-3.1-flash-lite-preview",
      features: DEFAULT_FEATURES as Record<string, boolean>,
      organizer_prompt: "",
      notes: "",
      created_at: new Date().toISOString(),
    });
    setCreating(true);
  };

  // ============= IMPERSONATE =============
  const handleImpersonate = async (c: Client) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/clients/${c.id}/impersonate`, { method: "POST" });
      const d = await r.json();
      if (!d.ok) { alert("Erro: " + d.error); return; }
      // Navega pro painel do cliente — usa window.location pra garantir
      // que todos os componentes (banner, sidebar, dados) reinicializem
      // com a nova sessão de impersonação.
      window.location.href = "/";
    } finally {
      setBusy(false);
    }
  };

  // ============= TOGGLE ACTIVE =============
  const toggleActive = async (c: Client) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/clients/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_active: !c.is_active }),
      });
      const d = await r.json();
      if (d.ok) await reload();
      else alert("Erro: " + d.error);
    } finally {
      setBusy(false);
    }
  };

  // ============= DELETE =============
  const handleDelete = async (c: Client) => {
    if (!confirm(
      `APAGAR "${c.name}"?\n\nIsso REMOVE todos os dados do cliente:\n` +
      `- Leads, conversas, mensagens, automações, follow-ups, tokens.\n\n` +
      `Esta ação é IRREVERSÍVEL. Continuar?`
    )) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/admin/clients/${c.id}`, { method: "DELETE" });
      const d = await r.json();
      if (d.ok) await reload();
      else alert("Erro: " + d.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-[100dvh] max-h-[100dvh] bg-background overflow-hidden text-white">
      <Header />

      <main className="flex-1 overflow-y-auto w-full">
        <div className="max-w-6xl mx-auto p-4 sm:p-8 space-y-6">
          {/* Title */}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h1 className="text-2xl font-black tracking-tight flex items-center gap-3">
                <UserCog className="w-7 h-7 text-primary" /> Clientes
              </h1>
              <p className="text-xs text-muted-foreground mt-1">
                Crie, edite, ative ou apague clientes. Cada cliente tem dados isolados e features customizáveis.
              </p>
            </div>
            <Button onClick={handleCreate} className="glow-primary gap-2 h-11 font-bold text-xs uppercase tracking-widest">
              <Plus className="w-4 h-4" /> Novo Cliente
            </Button>
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-200 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* List */}
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm"><Loader2 className="w-4 h-4 animate-spin" /> Carregando...</div>
          ) : (
            <div className="glass-card rounded-2xl border-white/10 bg-white/[0.02] overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-white/5">
                  <tr className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                    <th className="px-4 py-3 text-left">Nome / Email</th>
                    <th className="px-4 py-3 text-left">Tipo</th>
                    <th className="px-4 py-3 text-left">Status</th>
                    <th className="px-4 py-3 text-left">Modelo IA</th>
                    <th className="px-4 py-3 text-left">Features</th>
                    <th className="px-4 py-3 text-right">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {clients.map((c) => {
                    const activeFeatures = Object.entries(c.features || {}).filter(([, v]) => v).length;
                    const totalFeatures = FEATURE_LIST.length;
                    return (
                      <tr key={c.id} className="hover:bg-white/[0.02] transition-colors">
                        <td className="px-4 py-3">
                          <div className="font-bold">{c.name}</div>
                          <div className="text-[10px] text-muted-foreground font-mono">{c.email}</div>
                        </td>
                        <td className="px-4 py-3">
                          {c.is_admin ? (
                            <span className="text-[10px] font-black uppercase tracking-widest text-purple-300 bg-purple-500/10 px-2 py-1 rounded-md border border-purple-500/30 inline-flex items-center gap-1">
                              <Shield className="w-3 h-3" /> Admin
                            </span>
                          ) : (
                            <span className="text-[10px] font-black uppercase tracking-widest text-cyan-300 bg-cyan-500/10 px-2 py-1 rounded-md border border-cyan-500/30">
                              Cliente
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <span className={cn(
                            "text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-md border",
                            c.is_active
                              ? "text-green-300 bg-green-500/10 border-green-500/30"
                              : "text-red-300 bg-red-500/10 border-red-500/30"
                          )}>
                            {c.is_active ? "Ativo" : "Inativo"}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-mono text-[10px] text-muted-foreground">
                          {c.default_ai_model || "(default global)"}
                        </td>
                        <td className="px-4 py-3 text-[11px]">
                          <span className="font-mono">{activeFeatures}/{totalFeatures}</span>
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            {!c.is_admin && (
                              <Button
                                onClick={() => handleImpersonate(c)}
                                disabled={busy || !c.is_active}
                                size="icon" variant="ghost"
                                className="h-8 w-8 text-cyan-400 hover:bg-cyan-400/10 rounded-lg"
                                title="Entrar como este cliente"
                              ><LogIn className="w-4 h-4" /></Button>
                            )}
                            <Button
                              onClick={() => { setEditing(c); setCreating(false); }}
                              disabled={busy}
                              size="icon" variant="ghost"
                              className="h-8 w-8 text-blue-400 hover:bg-blue-400/10 rounded-lg"
                              title="Editar"
                            ><Pencil className="w-4 h-4" /></Button>
                            <Button
                              onClick={() => toggleActive(c)}
                              disabled={busy}
                              size="icon" variant="ghost"
                              className={cn(
                                "h-8 w-8 rounded-lg",
                                c.is_active ? "text-yellow-400 hover:bg-yellow-400/10" : "text-green-400 hover:bg-green-400/10"
                              )}
                              title={c.is_active ? "Desativar" : "Ativar"}
                            ><Power className="w-4 h-4" /></Button>
                            <Button
                              onClick={() => handleDelete(c)}
                              disabled={busy || c.id === "00000000-0000-0000-0000-000000000001"}
                              size="icon" variant="ghost"
                              className="h-8 w-8 text-red-400 hover:bg-red-400/10 rounded-lg"
                              title={c.id === "00000000-0000-0000-0000-000000000001" ? "Cliente Default não pode ser apagado" : "Apagar"}
                            ><Trash2 className="w-4 h-4" /></Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                  {clients.length === 0 && (
                    <tr><td colSpan={6} className="px-4 py-12 text-center text-muted-foreground italic">Nenhum cliente cadastrado.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>

      {/* Modal editar/criar */}
      {editing && (
        <ClientEditor
          client={editing}
          isNew={creating}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSaved={() => { setEditing(null); setCreating(false); reload(); }}
        />
      )}
    </div>
  );
}

/* ====================================================================
   EDITOR (modal) — criar/editar cliente. UI única pros 2 casos pra
   evitar duplicar form. `isNew` ativa o campo Senha como obrigatório.
==================================================================== */
function ClientEditor({
  client, isNew, onClose, onSaved,
}: {
  client: Client; isNew: boolean;
  onClose: () => void; onSaved: () => void;
}) {
  const [name, setName] = useState(client.name);
  const [email, setEmail] = useState(client.email);
  const [password, setPassword] = useState("");
  const [isAdmin, setIsAdmin] = useState(client.is_admin);
  const [model, setModel] = useState(client.default_ai_model || DEFAULT_AI_MODEL);
  const [features, setFeatures] = useState<Record<string, boolean>>(client.features || DEFAULT_FEATURES);
  // Organizador IA: por padrão TRUE (admin pode desativar quando quiser)
  const [organizerEnabled, setOrganizerEnabled] = useState<boolean>(client.organizer_enabled !== false);
  const [organizerPrompt, setOrganizerPrompt] = useState(client.organizer_prompt || "");
  const [notes, setNotes] = useState(client.notes || "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Modelos em tempo real da Google AI — atualiza automaticamente quando
  // Google lança um modelo novo (gemini-4-flash etc). Sem hardcode.
  const [models, setModels] = useState<AiModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/ai-models", { cache: "no-store" });
        const d = await r.json();
        if (cancelled) return;
        if (d.success && Array.isArray(d.models) && d.models.length > 0) {
          setModels(d.models);
          setModelsError(null);
        } else {
          // API key não configurada ou erro — mostra mensagem útil
          setModelsError(d.error || "Configure a API Key do Gemini em Configurações pra ver os modelos disponíveis.");
        }
      } catch (e: any) {
        if (!cancelled) setModelsError(e?.message || "Falha ao listar modelos");
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const toggleFeature = (key: string) => setFeatures((f) => ({ ...f, [key]: !f[key] }));

  const handleSave = async () => {
    setError(null);
    setSaving(true);
    try {
      const payload: any = {
        name: name.trim(),
        email: email.trim().toLowerCase(),
        is_admin: isAdmin,
        default_ai_model: model,
        features,
        organizer_enabled: organizerEnabled,
        organizer_prompt: organizerPrompt || null,
        notes: notes || null,
      };
      if (password) payload.password = password;

      let r: Response;
      if (isNew) {
        if (!password || password.length < 8) {
          setError("Senha inicial é obrigatória (mín. 8 caracteres).");
          setSaving(false); return;
        }
        r = await fetch("/api/admin/clients", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        r = await fetch(`/api/admin/clients/${client.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }
      const d = await r.json();
      if (!d.ok) { setError(d.error || "Falha ao salvar"); return; }
      onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4 overflow-y-auto">
      <div className="w-full max-w-2xl glass-card rounded-3xl border-white/10 bg-neutral-950 shadow-2xl my-8">
        <div className="px-6 py-5 border-b border-white/10 flex items-center justify-between">
          <h2 className="text-lg font-black">{isNew ? "Novo Cliente" : "Editar Cliente"}</h2>
          <Button onClick={onClose} size="icon" variant="ghost" className="h-8 w-8"><X className="w-4 h-4" /></Button>
        </div>

        <div className="p-6 space-y-5">
          {/* Nome + Email */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Nome</label>
              <Input value={name} onChange={(e) => setName(e.target.value)} className="bg-white/5 border-white/10 h-11" />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Usuário ou Email (login)</label>
              <Input type="text" value={email} onChange={(e) => setEmail(e.target.value)} className="bg-white/5 border-white/10 h-11 font-mono text-xs" />
            </div>
          </div>

          {/* Senha */}
          <div className="space-y-1">
            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground flex items-center gap-1">
              <KeyRound className="w-3 h-3" /> {isNew ? "Senha inicial" : "Nova senha (deixe vazio pra não trocar)"}
            </label>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={isNew ? "Mínimo 8 caracteres" : "•••••••• (manter atual)"}
              className="bg-white/5 border-white/10 h-11 font-mono"
            />
            {!isNew && password && (
              <p className="text-[10px] text-amber-300">⚠ Ao salvar, todas as sessões deste cliente serão revogadas.</p>
            )}
          </div>

          {/* Admin toggle */}
          <label className="flex items-center justify-between gap-3 p-3 bg-purple-500/5 border border-purple-500/15 rounded-xl cursor-pointer">
            <div>
              <p className="text-xs font-bold text-white flex items-center gap-2"><Shield className="w-4 h-4 text-purple-400" /> Administrador</p>
              <p className="text-[10px] text-muted-foreground">Pode acessar /admin/clientes e gerenciar outros clientes.</p>
            </div>
            <div
              onClick={() => setIsAdmin(!isAdmin)}
              className={cn("w-12 h-6 rounded-full p-1 cursor-pointer transition", isAdmin ? "bg-purple-500" : "bg-white/10")}
            >
              <div className={cn("w-4 h-4 rounded-full bg-white transition-all", isAdmin && "translate-x-6")} />
            </div>
          </label>

          {/* Modelo IA — em tempo real via /api/ai-models */}
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Modelo de IA padrão</label>
              {modelsLoading && (
                <span className="text-[9px] text-muted-foreground flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> buscando modelos disponíveis...
                </span>
              )}
              {!modelsLoading && !modelsError && models.length > 0 && (
                <span className="text-[9px] text-emerald-400">{models.length} modelo(s) disponíveis (Gemini ao vivo)</span>
              )}
            </div>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full bg-white/5 border border-white/10 h-11 rounded-xl text-sm px-3 font-mono"
            >
              {/* Garante que o valor salvo SEMPRE aparece, mesmo se não veio na lista da API */}
              {model && !models.some((m) => m.id === model) && (
                <option value={model} className="bg-neutral-900">{model} (salvo)</option>
              )}
              {modelsLoading && !models.length && (
                <option value="" className="bg-neutral-900 text-muted-foreground">Carregando...</option>
              )}
              {models.map((m) => (
                <option key={m.id} value={m.id} className="bg-neutral-900">
                  {m.name} ({m.id})
                </option>
              ))}
            </select>
            {modelsError && (
              <p className="text-[10px] text-amber-400 flex items-start gap-1 mt-1">
                <AlertCircle className="w-3 h-3 shrink-0 mt-0.5" /> {modelsError}
              </p>
            )}
          </div>

          {/* ========== ORGANIZADOR IA (toggle + prompt) ========== */}
          <div className="rounded-xl bg-purple-500/[0.04] border border-purple-500/20 p-3 space-y-3">
            <label className="flex items-center justify-between gap-3 cursor-pointer">
              <div>
                <p className="text-xs font-bold text-white flex items-center gap-2">
                  <Bot className="w-4 h-4 text-purple-400" /> Organizador IA
                  <span className={cn(
                    "text-[9px] font-black uppercase tracking-widest px-1.5 py-0.5 rounded",
                    organizerEnabled ? "bg-emerald-500/20 text-emerald-300" : "bg-white/10 text-muted-foreground"
                  )}>
                    {organizerEnabled ? "Ativo" : "Desligado"}
                  </span>
                </p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  Reorganiza o status dos leads automaticamente 1x/dia (hora definida em Configurações).
                  {!organizerEnabled && <span className="text-amber-300"> Desligado: não roda pra este cliente.</span>}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOrganizerEnabled(!organizerEnabled)}
                className={cn("w-12 h-6 rounded-full p-1 cursor-pointer transition shrink-0", organizerEnabled ? "bg-purple-500" : "bg-white/10")}
              >
                <div className={cn("w-4 h-4 rounded-full bg-white transition-all", organizerEnabled && "translate-x-6")} />
              </button>
            </label>

            {organizerEnabled && (
              <div className="space-y-1.5 pt-2 border-t border-purple-500/10">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] font-black uppercase tracking-widest text-purple-300">Prompt customizado</label>
                  {organizerPrompt && (
                    <button
                      type="button"
                      onClick={() => setOrganizerPrompt("")}
                      className="text-[10px] text-muted-foreground hover:text-red-400"
                    >Limpar (usar padrão)</button>
                  )}
                  {!organizerPrompt && (
                    <button
                      type="button"
                      onClick={() => setOrganizerPrompt(DEFAULT_ORGANIZER_PROMPT)}
                      className="text-[10px] text-purple-300 hover:underline"
                    >Carregar template padrão</button>
                  )}
                </div>
                <Textarea
                  value={organizerPrompt}
                  onChange={(e) => setOrganizerPrompt(e.target.value)}
                  placeholder="Vazio = usa o prompt global. Personalize aqui pra adaptar a IA ao negócio do cliente: vendas, atendimento, agendamento, suporte, etc."
                  className="bg-black/40 border-white/10 h-40 text-xs font-mono"
                />
                <p className="text-[9px] text-muted-foreground italic">
                  Dica: descreva o tipo de negócio, os status possíveis e a lógica de classificação. A IA usa isso pra decidir o próximo status de cada lead.
                </p>
              </div>
            )}
          </div>

          {/* Features */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Módulos liberados</label>
              <div className="flex gap-1">
                <button type="button" onClick={() => setFeatures(DEFAULT_FEATURES)} className="text-[10px] text-cyan-400 hover:underline">Todos</button>
                <span className="text-muted-foreground text-[10px]">·</span>
                <button type="button" onClick={() => setFeatures(NO_FEATURES)} className="text-[10px] text-red-400 hover:underline">Nenhum</button>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              {FEATURE_LIST.map((f) => {
                const on = !!features[f.key];
                return (
                  <button
                    key={f.key}
                    type="button"
                    onClick={() => toggleFeature(f.key)}
                    className={cn(
                      "flex items-center gap-2 p-2 rounded-lg border text-left transition",
                      on
                        ? "bg-primary/10 border-primary/40 text-primary"
                        : "bg-white/[0.02] border-white/10 text-muted-foreground hover:bg-white/5"
                    )}
                  >
                    <div className={cn("w-3.5 h-3.5 rounded border-2 flex items-center justify-center shrink-0",
                      on ? "bg-primary border-primary" : "border-white/20")}
                    >
                      {on && <Check className="w-2 h-2 text-white" />}
                    </div>
                    <span className="text-[11px] font-medium truncate">{f.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Notes */}
          <div className="space-y-1">
            <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Notas internas</label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Anotações sobre o cliente" className="bg-white/5 border-white/10 h-10 text-xs" />
          </div>

          {/* Error */}
          {error && (
            <div className="flex items-start gap-2 p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-red-200 text-xs">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> <span>{error}</span>
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-white/10 flex justify-end gap-2">
          <Button onClick={onClose} variant="outline" className="text-xs">Cancelar</Button>
          <Button onClick={handleSave} disabled={saving || !name || !email} className="glow-primary text-xs gap-2">
            {saving ? <><Loader2 className="w-4 h-4 animate-spin" /> Salvando...</> : "Salvar"}
          </Button>
        </div>
      </div>
    </div>
  );
}
