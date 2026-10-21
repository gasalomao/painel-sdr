"use client";

import { useEffect, useState, type FormEvent, type JSX } from "react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  Plus, Trash2, Pencil, LogIn, Power, X, Loader2,
  Shield, Users, AlertCircle, Copy, ClipboardCheck, Search, MoreHorizontal, RefreshCw,
} from "lucide-react";
import styles from "./clientes.module.css";

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
// + migration 006 (campo "calendario" do módulo de agendamentos).
// Cada cliente tem o próprio JSONB features na row de public.clients — mudar
// uma flag aqui afeta SÓ o cliente sendo editado, nunca os outros tenants.
const FEATURE_LIST = [
  { key: "dashboard",     label: "Dashboard" },
  { key: "leads",         label: "Leads / CRM" },
  { key: "chat",          label: "Chat" },
  { key: "calendario",    label: "Calendário" },
  { key: "agente",        label: "Agente IA" },
  { key: "automacao",     label: "Automação" },
  { key: "disparo",       label: "Disparo em Massa" },
  { key: "followup",      label: "Follow-up" },
  { key: "captador",      label: "Captador Maps" },
  { key: "whatsapp",      label: "WhatsApp" },
  { key: "historico",     label: "Histórico IA" },
  { key: "tokens",        label: "Tokens IA" },
  { key: "organizador",   label: "Organizador IA" },
  { key: "sites",         label: "Sites IA" },
  { key: "configuracoes", label: "Configurações" },
];

// Modelos vêm 100% em tempo real de /api/ai-models. Sem default hardcoded —
// quando o admin cria um cliente novo, o modelo arranca vazio e o componente
// preenche com o primeiro da lista vinda da Google (que é o mais novo).
// NÃO reintroduzir constante DEFAULT_AI_MODEL aqui — o usuário pediu
// explicitamente "nada hardcoded, tudo via API".

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

export default function AdminClientesPage(): JSX.Element {
  const [clients, setClients] = useState<Client[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Client | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Cliente alvo do "copiar credenciais" — abre modal mini pra definir senha + copiar
  const [credsClient, setCredsClient] = useState<Client | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const filteredClients = clients.filter((client) => {
    const search = query.trim().toLocaleLowerCase("pt-BR");
    return `${client.name} ${client.email}`.toLocaleLowerCase("pt-BR").includes(search)
      && (statusFilter === "all" || client.is_active === (statusFilter === "active"))
      && (typeFilter === "all" || client.is_admin === (typeFilter === "admin"));
  });
  const hasFilters = !!query || statusFilter !== "all" || typeFilter !== "all";
  const clearFilters = () => { setQuery(""); setStatusFilter("all"); setTypeFilter("all"); };

  const reload = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/admin/clients", { cache: "no-store" });
      const d = await r.json();
      if (!r.ok || !d.ok || !Array.isArray(d.clients)) throw new Error(d.error || "Não foi possível carregar os clientes.");
      setClients(d.clients);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Não foi possível carregar os clientes.");
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
      default_ai_model: "", // vazio = ClientEditor preenche com models[0] vindo da API
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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Não foi possível acessar o painel do cliente. Tente novamente.");
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
      else setError(d.error || "Não foi possível concluir a ação. Tente novamente.");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Não foi possível concluir a ação. Tente novamente.");
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
      else setError(d.error || "Não foi possível concluir a ação. Tente novamente.");
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Não foi possível concluir a ação. Tente novamente.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={cn(styles.theme, styles.page)}>
      <Header />
      <div className={styles.scrollArea}>
        <section className={styles.content} aria-labelledby="clients-title">
          <div className={styles.heading}>
            <div>
              <h2 id="clients-title">Clientes</h2>
              <p>Gerencie contas, acessos e os módulos de cada cliente.</p>
            </div>
            <Button onClick={handleCreate} className={styles.primaryAction}>
              <Plus aria-hidden="true" /> Novo cliente
            </Button>
          </div>

          <div className={styles.overview} aria-label="Resumo das contas">
            <span><strong>{loading ? "—" : clients.length}</strong> contas cadastradas</span>
            <span><i className={styles.activeDot} aria-hidden="true" /><strong>{loading ? "—" : clients.filter((c) => c.is_active).length}</strong> ativas</span>
            <span><strong>{loading ? "—" : clients.filter((c) => !c.is_active).length}</strong> inativas</span>
            <span className={styles.isolationNote}><Shield aria-hidden="true" /> Dados isolados por cliente</span>
          </div>

          {error && (
            <div className={styles.error} role="alert">
              <AlertCircle aria-hidden="true" /><span>{error}</span>
              <Button variant="ghost" onClick={reload} className={styles.textAction}>Tentar novamente</Button>
            </div>
          )}

          <div className={styles.listPanel}>
            <div className={styles.toolbar}>
              <div className={styles.search}>
                <label htmlFor="client-search" className="sr-only">Buscar clientes</label>
                <Search aria-hidden="true" />
                <Input id="client-search" type="search" placeholder="Buscar por nome ou usuário..." value={query} onChange={(e) => setQuery(e.target.value)} className={styles.searchInput} />
              </div>
              <div className={styles.filters}>
                <label className={styles.filter}>
                  <span>Status</span>
                  <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
                    <option value="all">Todos os status</option><option value="active">Ativos</option><option value="inactive">Inativos</option>
                  </select>
                </label>
                <label className={styles.filter}>
                  <span>Tipo de conta</span>
                  <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
                    <option value="all">Todos os tipos</option><option value="client">Clientes</option><option value="admin">Administradores</option>
                  </select>
                </label>
              </div>
            </div>
            <div className={styles.listMeta}>
              <p role="status">{loading ? "Carregando contas..." : `${filteredClients.length} de ${clients.length} contas`}</p>
              {hasFilters ? <Button variant="ghost" onClick={clearFilters} className={styles.textAction}><X aria-hidden="true" /> Limpar filtros</Button>
                : <Button variant="ghost" onClick={reload} disabled={loading || busy} className={styles.textAction}><RefreshCw aria-hidden="true" /> Atualizar</Button>}
            </div>

            {loading ? (
              <div className={styles.empty} role="status"><Loader2 className={styles.spinner} aria-hidden="true" /><h3>Carregando clientes</h3><p>Aguarde enquanto buscamos as contas.</p></div>
            ) : error && clients.length === 0 ? (
              <div className={styles.empty}><AlertCircle aria-hidden="true" /><h3>Lista indisponível</h3><p>Tente carregar novamente para consultar os clientes.</p></div>
            ) : filteredClients.length === 0 ? (
              <div className={styles.empty}>
                {hasFilters ? <Search aria-hidden="true" /> : <Users aria-hidden="true" />}
                <h3>{hasFilters ? "Nenhum resultado encontrado" : "Nenhum cliente cadastrado"}</h3>
                <p>{hasFilters ? "Ajuste a busca ou os filtros para encontrar uma conta." : "Crie a primeira conta e escolha os módulos disponíveis para ela."}</p>
                <Button variant="outline" onClick={hasFilters ? clearFilters : handleCreate} className={styles.secondaryAction}>{hasFilters ? "Mostrar todas as contas" : "Criar primeiro cliente"}</Button>
              </div>
            ) : (
              <table className={styles.table}>
                <caption className="sr-only">Contas de clientes, permissões, status e ações</caption>
                <thead><tr>
                  <th scope="col">Cliente</th><th scope="col">Tipo</th><th scope="col">Status</th><th scope="col">Modelo de IA</th><th scope="col">Módulos</th><th scope="col" className={styles.actionsHeading}>Ações</th>
                </tr></thead>
                <tbody>
                  {filteredClients.map((c) => {
                    const activeFeatures = FEATURE_LIST.filter((feature) => c.features?.[feature.key]).length;
                    const isDefault = c.id === "00000000-0000-0000-0000-000000000001";
                    return (
                      <tr key={c.id}>
                        <th scope="row" className={styles.identityCell}>
                          <div className={styles.identity}>
                            <span className={styles.avatar} aria-hidden="true">{c.name.trim().split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toLocaleUpperCase("pt-BR")}</span>
                            <div><span className={styles.clientName}>{c.name}</span><span className={styles.email}>{c.email}</span></div>
                          </div>
                        </th>
                        <td data-label="Tipo"><span className={cn(styles.badge, c.is_admin && styles.adminBadge)}>{c.is_admin && <Shield aria-hidden="true" />}{c.is_admin ? "Admin" : "Cliente"}</span></td>
                        <td data-label="Status"><span className={cn(styles.status, !c.is_active && styles.inactive)}><i aria-hidden="true" />{c.is_active ? "Ativo" : "Inativo"}</span></td>
                        <td data-label="Modelo de IA" className={styles.modelCell}><span className={styles.model}>{c.default_ai_model || "Padrão global"}</span></td>
                        <td data-label="Módulos"><div className={styles.modules}><span>{activeFeatures}<span> / {FEATURE_LIST.length}</span></span><meter min={0} max={FEATURE_LIST.length} value={activeFeatures} aria-label={`${activeFeatures} de ${FEATURE_LIST.length} módulos liberados`} /></div></td>
                        <td className={styles.actionsCell}>
                          <div className={styles.rowActions}>
                            <Button variant="ghost" onClick={() => { setEditing(c); setCreating(false); }} disabled={busy} aria-label={`Editar ${c.name}`} className={styles.editAction}><Pencil aria-hidden="true" /> Editar</Button>
                            <DropdownMenu>
                              <DropdownMenuTrigger render={<Button variant="ghost" size="icon" className={styles.menuTrigger} />} aria-label={`Mais ações de ${c.name}`} disabled={busy}><MoreHorizontal aria-hidden="true" /></DropdownMenuTrigger>
                              <DropdownMenuContent align="end" className={cn(styles.theme, styles.menu)}>
                                {!c.is_admin && <DropdownMenuItem disabled={!c.is_active} onClick={() => handleImpersonate(c)}><LogIn aria-hidden="true" /> Entrar como cliente</DropdownMenuItem>}
                                <DropdownMenuItem onClick={() => setCredsClient(c)}><Copy aria-hidden="true" /> Enviar credenciais</DropdownMenuItem>
                                <DropdownMenuItem onClick={() => toggleActive(c)}><Power aria-hidden="true" /> {c.is_active ? "Desativar cliente" : "Ativar cliente"}</DropdownMenuItem>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem className={styles.deleteAction} disabled={isDefault} title={isDefault ? "Cliente Default não pode ser apagado" : undefined} onClick={() => handleDelete(c)}><Trash2 aria-hidden="true" /> Excluir cliente{isDefault && " (protegido)"}</DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <p className={styles.footnote}><Shield aria-hidden="true" /> As alterações de acesso e módulos se aplicam somente à conta selecionada.</p>
        </section>
      </div>

      {/* Modal editar/criar */}
      {editing && (
        <ClientEditor
          client={editing}
          isNew={creating}
          onClose={() => { setEditing(null); setCreating(false); }}
          onSaved={() => { setEditing(null); setCreating(false); reload(); }}
        />
      )}

      {/* Modal copiar credenciais */}
      {credsClient && (
        <CredentialsModal client={credsClient} onClose={() => setCredsClient(null)} />
      )}
    </div>
  );
}

/* ====================================================================
   CREDENCIAIS — modal mini que reseta a senha e copia bloco formatado
   pra mandar pro cliente (WhatsApp/email). A senha do DB é hash, então
   o admin SEMPRE define uma nova quando quer enviar.
==================================================================== */
function CredentialsModal({ client, onClose }: { client: Client; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // URL do painel — usa o domínio que o admin está acessando agora.
  // Em prod fica no domínio configurado no Easypanel, em dev localhost:3000.
  const panelUrl = typeof window !== "undefined" ? window.location.origin : "";

  // Gera uma senha forte aleatória pra agilizar (admin pode trocar).
  const generatePassword = () => {
    const charset = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
    let pwd = "";
    const arr = new Uint8Array(12);
    crypto.getRandomValues(arr);
    for (let i = 0; i < 12; i++) pwd += charset[arr[i] % charset.length];
    setPassword(pwd);
  };

  const credsText = `🔐 Acesso ao Salomão AI

🌐 Link: ${panelUrl}
👤 Usuário: ${client.email}
🔑 Senha: ${password || "(defina uma senha primeiro)"}

Acesse com essas credenciais e troque a senha no primeiro login.`;

  const handleCopy = async () => {
    if (!password || password.length < 8) {
      setError("Defina uma senha de pelo menos 8 caracteres antes de copiar.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      // 1. Reseta a senha do cliente no DB (rota admin: cria hash novo + revoga sessões antigas)
      const r = await fetch(`/api/admin/clients/${client.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const d = await r.json();
      if (!d.ok) {
        setError("Falha ao resetar senha: " + (d.error || "desconhecido"));
        return;
      }
      // 2. Copia o bloco formatado pra clipboard
      await navigator.clipboard.writeText(credsText);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Não foi possível copiar as credenciais. A senha pode já ter sido alterada; tente copiar novamente.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <DialogContent showCloseButton={false} className={cn(styles.theme, styles.dialog, styles.credentialsDialog)}>
        <div className={styles.dialogHeader}>
          <div><DialogTitle>Credenciais de acesso</DialogTitle><DialogDescription>Prepare o acesso de {client.name} para compartilhar.</DialogDescription></div>
          <Button onClick={onClose} disabled={busy} size="icon" variant="ghost" aria-label="Fechar credenciais" className={styles.menuTrigger}><X aria-hidden="true" /></Button>
        </div>
        <div className={styles.dialogBody}>
          <div className={styles.notice}><AlertCircle aria-hidden="true" /><p>A senha atual não pode ser recuperada. Ao aplicar uma nova senha, <strong>as sessões anteriores serão encerradas</strong>. O acesso será copiado para você compartilhar.</p></div>
          <div className={styles.field}><label htmlFor="creds-url">Painel (URL)</label><Input id="creds-url" readOnly value={panelUrl} className={styles.input} /></div>
          <div className={styles.field}><label htmlFor="creds-user">Usuário</label><Input id="creds-user" readOnly value={client.email} className={styles.input} /></div>
          <div className={styles.field}>
            <div className={styles.fieldHeading}><label htmlFor="creds-password">Nova senha</label><button type="button" disabled={busy} onClick={generatePassword} className={styles.inlineAction}>Gerar senha forte</button></div>
            <Input id="creds-password" type="text" autoComplete="new-password" value={password} disabled={busy} onChange={(e) => { setPassword(e.target.value); setCopied(false); }} placeholder="Mínimo de 8 caracteres" className={styles.input} aria-describedby="creds-password-hint" />
            <p id="creds-password-hint" className={styles.hint}>Será aplicada ao cliente ao confirmar abaixo.</p>
          </div>
          <div className={styles.field}><p id="creds-preview-label" className={styles.fieldLabel}>Mensagem para compartilhar</p><pre aria-labelledby="creds-preview-label" className={styles.preview}>{credsText}</pre></div>
          {error && <div className={styles.error} role="alert"><AlertCircle aria-hidden="true" /><span>{error}</span></div>}
          {copied && <p role="status" className={styles.success}>Senha aplicada e credenciais copiadas.</p>}
        </div>
        <div className={styles.dialogFooter}>
          <Button onClick={onClose} disabled={busy} variant="outline" className={styles.secondaryAction}>Cancelar</Button>
          <Button onClick={handleCopy} disabled={busy || password.length < 8} className={styles.primaryAction}>
            {busy ? <><Loader2 className={styles.spinner} aria-hidden="true" /> Aplicando...</> : copied ? <><ClipboardCheck aria-hidden="true" /> Copiado!</> : <><Copy aria-hidden="true" /> Aplicar senha e copiar</>}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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
  const [model, setModel] = useState(client.default_ai_model || "");
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
      } catch (e: unknown) {
        if (!cancelled) setModelsError(e instanceof Error ? e.message : "Falha ao listar modelos");
      } finally {
        if (!cancelled) setModelsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Quando os modelos chegam da API e o cliente ainda não tem um escolhido,
  // pré-seleciona o primeiro da lista (geralmente o mais recente). Evita
  // hardcoded e garante que admin nunca salve string vazia por engano.
  useEffect(() => {
    if (!model && models.length > 0) {
      setModel(models[0].id);
    }
  }, [models, model]);

  const toggleFeature = (key: string) => setFeatures((f) => ({ ...f, [key]: !f[key] }));

  const handleSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (!name.trim() || !email.trim()) { setError("Preencha o nome e o usuário do cliente."); return; }
    if (password && password.length < 8) { setError("A senha deve ter pelo menos 8 caracteres."); return; }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Não foi possível salvar o cliente. Tente novamente.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent showCloseButton={false} className={cn(styles.theme, styles.dialog)}>
        <div className={styles.dialogHeader}>
          <div><DialogTitle>{isNew ? "Novo cliente" : "Editar cliente"}</DialogTitle><DialogDescription>{isNew ? "Defina o acesso e os módulos da nova conta." : `Configurações de acesso de ${client.name}.`}</DialogDescription></div>
          <Button onClick={onClose} disabled={saving} size="icon" variant="ghost" aria-label="Fechar edição" className={styles.menuTrigger}><X aria-hidden="true" /></Button>
        </div>
        <form className={styles.editorForm} onSubmit={handleSave}>
          <div className={styles.dialogBody}>
            <fieldset disabled={saving} className={styles.fieldset}>
              <legend>Dados e acesso</legend>
              <div className={styles.formGrid}>
                <div className={styles.field}><label htmlFor="client-name">Nome</label><Input id="client-name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Nome do cliente" className={styles.input} /></div>
                <div className={styles.field}><label htmlFor="client-email">Usuário ou e-mail</label><Input id="client-email" required type="text" autoComplete="off" spellCheck={false} value={email} onChange={(e) => setEmail(e.target.value)} placeholder="Usado para entrar no painel" className={styles.input} /></div>
              </div>
              <div className={styles.field}>
                <label htmlFor="client-password">{isNew ? "Senha inicial" : "Nova senha"}</label>
                <Input id="client-password" type="password" autoComplete="new-password" required={isNew} minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder={isNew ? "Mínimo de 8 caracteres" : "Deixe em branco para manter a atual"} className={styles.input} aria-describedby="client-password-hint" />
                <p id="client-password-hint" className={cn(styles.hint, !isNew && password && styles.warning)}>{!isNew && password ? "Ao salvar a nova senha, todas as sessões deste cliente serão encerradas." : "Use pelo menos 8 caracteres para proteger o acesso."}</p>
              </div>
              <label className={styles.toggleRow}>
                <span><span className={styles.fieldLabel}>Administrador</span><span className={styles.hint}>Permite gerenciar todas as contas de clientes.</span></span>
                <input type="checkbox" role="switch" checked={isAdmin} onChange={(e) => setIsAdmin(e.target.checked)} aria-label="Administrador" className={styles.switch} />
              </label>
            </fieldset>

            <fieldset disabled={saving} className={styles.fieldset}>
              <legend>Inteligência artificial</legend>
              <div className={styles.field}>
                <label htmlFor="client-model">Modelo de IA padrão</label>
                <select id="client-model" value={model} onChange={(e) => setModel(e.target.value)} className={styles.input} aria-describedby="client-model-hint">
                  {model && !models.some((m) => m.id === model) && <option value={model}>{model} (salvo)</option>}
                  {!model && !models.length && <option value="">{modelsLoading ? "Carregando modelos..." : "Padrão global"}</option>}
                  {models.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.id})</option>)}
                </select>
                <p id="client-model-hint" className={cn(styles.hint, modelsError && styles.warning)}>{modelsLoading ? "Buscando modelos disponíveis..." : modelsError || `${models.length} modelo(s) disponíveis`}</p>
              </div>
              <label className={styles.toggleRow}>
                <span><span className={styles.fieldLabel}>Organizador IA</span><span className={styles.hint}>Reorganiza os leads uma vez por dia, no horário definido em Configurações.{!organizerEnabled && " Desativado para este cliente."}</span></span>
                <input type="checkbox" role="switch" aria-label="Organizador IA" checked={organizerEnabled} onChange={(e) => setOrganizerEnabled(e.target.checked)} className={styles.switch} />
              </label>
              {organizerEnabled && <div className={styles.field}>
                <div className={styles.fieldHeading}><label htmlFor="client-prompt">Prompt personalizado</label><button type="button" className={styles.inlineAction} onClick={() => setOrganizerPrompt(organizerPrompt ? "" : DEFAULT_ORGANIZER_PROMPT)}>{organizerPrompt ? "Usar padrão global" : "Carregar modelo padrão"}</button></div>
                <Textarea id="client-prompt" value={organizerPrompt} onChange={(e) => setOrganizerPrompt(e.target.value)} placeholder="Descreva o negócio, os status e as regras de classificação..." className={cn(styles.input, styles.prompt)} aria-describedby="client-prompt-hint" />
                <p id="client-prompt-hint" className={styles.hint}>Em branco, usa o prompt global. Personalize para o negócio deste cliente.</p>
              </div>}
            </fieldset>

            <fieldset disabled={saving} className={styles.fieldset}>
              <legend>Módulos liberados</legend>
              <div className={styles.fieldHeading}>
                <span className={styles.hint}>{FEATURE_LIST.filter((f) => features[f.key]).length} de {FEATURE_LIST.length} selecionados</span>
                <div className={styles.bulkActions}><button type="button" className={styles.inlineAction} onClick={() => setFeatures(DEFAULT_FEATURES)}>Selecionar todos</button><button type="button" className={styles.inlineAction} onClick={() => setFeatures(NO_FEATURES)}>Limpar seleção</button></div>
              </div>
              <div className={styles.featureGrid}>{FEATURE_LIST.map((f) => <label key={f.key} className={styles.feature}><input type="checkbox" checked={!!features[f.key]} onChange={() => toggleFeature(f.key)} /><span>{f.label}</span></label>)}</div>
            </fieldset>

            <div className={styles.field}><label htmlFor="client-notes">Notas internas</label><Textarea id="client-notes" value={notes} disabled={saving} onChange={(e) => setNotes(e.target.value)} placeholder="Anotações sobre este cliente" className={cn(styles.input, styles.notes)} /></div>
          </div>
          <div className={styles.dialogFooter}>
            {error && <div className={styles.error} role="alert"><AlertCircle aria-hidden="true" /><span>{error}</span></div>}
            <Button type="button" onClick={onClose} disabled={saving} variant="outline" className={styles.secondaryAction}>Cancelar</Button>
            <Button type="submit" disabled={saving || !name.trim() || !email.trim()} className={styles.primaryAction}>{saving ? <><Loader2 className={styles.spinner} aria-hidden="true" /> Salvando...</> : isNew ? "Criar cliente" : "Salvar alterações"}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
