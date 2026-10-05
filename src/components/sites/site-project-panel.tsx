"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CLIENT_FIELDS, formatRelative, isOverrideSkill, isPublishableBuild, isSelectableSkill, matchesModelFilters, modelModeLabel, modelPriceLabel, runStatusLabel, safeSiteUrl, skillTriggerLabel, tokenUsage } from "@/lib/sites/ui-helpers";
import type { ModelMode, WebsiteBuild, WebsiteDeployment, WebsiteMessage, WebsiteModel, WebsiteProject, WebsiteRevision, WebsiteRun, WebsiteSkill } from "@/lib/sites/types";
import { apiJson, errorMessage, jsonBody, selectClass } from "./api";
import { useSiteDraft } from "@/lib/sites/ui";

type History = {
  revisions: Omit<WebsiteRevision, "files">[];
  builds: Omit<WebsiteBuild, "artifact">[];
  deployments: WebsiteDeployment[];
  messages: WebsiteMessage[];
};

export function SiteProjectPanel({ draftScope, project, runs, disabled, filesDirty, refresh, onFilesChanged, onDirtyChange, onPublish, onRollback, onMutationStart, onMutationEnd }: {
  draftScope: string; project: WebsiteProject; runs: WebsiteRun[]; disabled: boolean; filesDirty: boolean; refresh: number;
  onFilesChanged: () => Promise<void>;
  onMutationStart: () => boolean; onMutationEnd: () => void;
  onDirtyChange: (dirty: boolean) => void; onPublish: () => void; onRollback: (id: string) => void;
}): React.JSX.Element {
  const [draft, setDraft] = useSiteDraft(draftScope, "project");
  const [saving, setSaving] = useState(false);
  const [models, setModels] = useState<WebsiteModel[] | null>(null);
  const [modelError, setModelError] = useState(false);
  const [toolsOnly, setToolsOnly] = useState(false);
  const [visionOnly, setVisionOnly] = useState(false);
  const [history, setHistory] = useState<History | null>(null);
  const [historyError, setHistoryError] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [skills, setSkills] = useState<WebsiteSkill[] | null>(null);
  const [skillsError, setSkillsError] = useState(false);
  const router = useRouter();
  const [deletingProject, setDeletingProject] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const values = draft ?? project;
  const base = `/api/sites/${project.id}`;
  const lastRun = runs[0];
  const url = safeSiteUrl(project.published_url);
  const busy = disabled || saving || restoring || deletingProject;

  async function handleDeleteProject(): Promise<void> {
    if (!onMutationStart()) return;
    setDeletingProject(true);
    try {
      await apiJson(`/api/sites/${project.id}`, { method: "DELETE" });
      toast.success(`Site "${project.name}" excluído.`);
      router.push("/sites");
    } catch (err) {
      toast.error(errorMessage(err));
      setDeletingProject(false);
      onMutationEnd();
    }
  }

  const loadModels = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const data = await apiJson<{ models: WebsiteModel[] }>("/api/sites/models", { signal });
      if (!signal?.aborted) { setModels(data.models); setModelError(false); }
    } catch (error) { if (!signal?.aborted) { setModelError(true); toast.error(errorMessage(error)); } }
  }, []);

  const loadHistory = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const [revisions, builds, deployments, messages] = await Promise.all([
        apiJson<Pick<History, "revisions">>(`${base}/revisions`, { signal }),
        apiJson<Pick<History, "builds">>(`${base}/builds`, { signal }),
        apiJson<Pick<History, "deployments">>(`${base}/deployments`, { signal }),
        apiJson<Pick<History, "messages">>(`${base}/messages`, { signal }),
      ]);
      if (!signal?.aborted) { setHistory({ ...revisions, ...builds, ...deployments, ...messages }); setHistoryError(false); }
    } catch (error) { if (!signal?.aborted) { setHistoryError(true); toast.error(errorMessage(error), { id: "sites-history" }); } }
  }, [base]);

  const loadSkills = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const data = await apiJson<{ skills: WebsiteSkill[] }>("/api/sites/skills", { signal });
      if (!signal?.aborted) { setSkills(data.skills); setSkillsError(false); }
    } catch (error) { if (!signal?.aborted) { setSkillsError(true); toast.error(errorMessage(error), { id: "sites-skills" }); } }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadModels(controller.signal);
    return () => controller.abort();
  }, [loadModels]);

  useEffect(() => {
    const controller = new AbortController();
    void loadHistory(controller.signal);
    return () => controller.abort();
  }, [loadHistory, refresh, lastRun?.id, lastRun?.status]);

  useEffect(() => {
    const controller = new AbortController();
    void loadSkills(controller.signal);
    return () => controller.abort();
  }, [loadSkills]);

  function change(patch: Partial<WebsiteProject>): void {
    onDirtyChange(true);
    setDraft((prev) => ({ ...(prev ?? project), ...patch }));
  }

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (busy || !draft) return;
    if (draft.model_mode === "manual" && !models?.some((model) => model.id === draft.model_id)) {
      toast.error("Selecione um modelo disponível."); return;
    }
    if (["url", "calendar"].includes(draft.cta.type) && draft.cta.value && !safeSiteUrl(draft.cta.value)) {
      toast.error("Informe uma URL HTTPS válida para o CTA."); return;
    }
    if (["whatsapp", "phone"].includes(draft.cta.type) && draft.cta.value && !/^\+?[\d ()-]{7,30}$/.test(draft.cta.value)) {
      toast.error("Informe um telefone válido com DDD."); return;
    }
    if (!onMutationStart()) return;
    setSaving(true);
    try {
      await apiJson<{ project: WebsiteProject }>(base, jsonBody({
        name: draft.name, slug: draft.slug, client_context: draft.client_context,
        instructions: draft.instructions, model_mode: draft.model_mode,
        model_id: draft.model_mode === "manual" ? draft.model_id : null, cta: draft.cta,
        selected_skill_ids: draft.selected_skill_ids,
      }, "PATCH"));
      await onFilesChanged(); setDraft(null); onDirtyChange(false); toast.success("Ajustes salvos.");
    } catch (error) { toast.error(errorMessage(error)); }
    finally { setSaving(false); onMutationEnd(); }
  }

  async function restore(id: string): Promise<void> {
    if (busy || filesDirty || draft || !window.confirm("Restaurar esta revisão? Uma nova revisão será criada, sem apagar o histórico ou alterar o site publicado.") || !onMutationStart()) return;
    setRestoring(true);
    try {
      await apiJson(`${base}/revisions/${id}/restore`, jsonBody({ expected_revision_id: project.current_revision_id }));
      await onFilesChanged(); toast.success("Revisão restaurada.");
    } catch (error) { toast.error(errorMessage(error)); }
    finally { setRestoring(false); onMutationEnd(); }
  }

  const selectedModel = models?.find((model) => model.id === values.model_id);
  const filteredModels = models?.filter((model) => matchesModelFilters(model, toolsOnly, visionOnly)) ?? [];
  const usage = history?.messages.filter((message) => message.role === "system").reduce((sum, message) => sum + tokenUsage(message.content), 0) ?? 0;
  const selectableSkills = (skills ?? []).filter(isSelectableSkill);
  const automaticSkills = (skills ?? []).filter((skill) => skill.is_enabled && skill.trigger_mode !== "manual");

  return <div className="space-y-5 p-3 text-sm">
    <h2 className="font-semibold">Ajustes do projeto</h2>
    <form className="space-y-3" onSubmit={(event) => void save(event)}>
      <fieldset disabled={busy} className="space-y-3">
        <legend className="sr-only">Informações e comportamento</legend>
        <label className="block space-y-1">Nome<Input required maxLength={120} value={values.name} onChange={(event) => change({ name: event.target.value })} /></label>
        <label className="block space-y-1">Slug<Input required maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={values.slug} onChange={(event) => change({ slug: event.target.value })} /></label>
        <details className="rounded-lg border border-border p-2"><summary className="cursor-pointer py-1 font-medium">Contexto confirmado</summary><p className="my-2 text-xs text-muted-foreground">Salve somente informações verificadas com o cliente.</p>{CLIENT_FIELDS.map(([key, label]) => <label key={key} className="my-2 block space-y-1 text-xs">{label}<Input maxLength={4000} value={values.client_context[key] ?? ""} onChange={(event) => change({ client_context: { ...values.client_context, [key]: event.target.value } })} /></label>)}</details>
        <label className="block space-y-1">Instruções<Textarea rows={4} maxLength={16000} value={values.instructions} onChange={(event) => change({ instructions: event.target.value })} /></label>
        <label className="block space-y-1">Modo do modelo<select className={selectClass} value={values.model_mode} onChange={(event) => change({ model_mode: event.target.value as ModelMode })}>{(["auto", "quality", "economy", "manual"] as const).map((mode) => <option key={mode} value={mode}>{modelModeLabel(mode)}</option>)}</select></label>
        {values.model_mode === "manual" && <div className="space-y-2">
          <fieldset className="flex flex-wrap gap-3 text-xs"><legend className="mb-1">Filtrar modelos</legend><label className="flex min-h-9 items-center gap-2"><input type="checkbox" className="size-4 accent-primary" checked={toolsOnly} onChange={(event) => setToolsOnly(event.target.checked)} />Ferramentas</label><label className="flex min-h-9 items-center gap-2"><input type="checkbox" className="size-4 accent-primary" checked={visionOnly} onChange={(event) => setVisionOnly(event.target.checked)} />Visão</label></fieldset>
          <label className="block space-y-1">Modelo<select required className={selectClass} value={values.model_id ?? ""} onChange={(event) => change({ model_id: event.target.value })}><option value="">Selecione um modelo</option>{values.model_id && !filteredModels.some((model) => model.id === values.model_id) && <option disabled value={values.model_id}>{selectedModel?.name ?? values.model_id} ({selectedModel ? "fora do filtro" : "indisponível"})</option>}{filteredModels.some((m) => m.id.startsWith("nvidia:")) && <optgroup label="⚡ NVIDIA NIM">{filteredModels.filter((m) => m.id.startsWith("nvidia:")).map((model) => <option key={model.id} value={model.id} disabled={model.id.length > 160}>{model.name}</option>)}</optgroup>}{filteredModels.some((m) => m.isFree && !m.id.startsWith("gemini:") && !m.id.startsWith("gateway:") && !m.id.startsWith("nvidia:")) && <optgroup label="⭐ OpenRouter (Gratuitos)">{filteredModels.filter((m) => m.isFree && !m.id.startsWith("gemini:") && !m.id.startsWith("gateway:") && !m.id.startsWith("nvidia:")).map((model) => <option key={model.id} value={model.id} disabled={model.id.length > 160}>{model.name}</option>)}</optgroup>}{filteredModels.some((m) => m.id.startsWith("gateway:")) && <optgroup label="🔑 Gateway de Assinatura (Contas Conectadas)">{filteredModels.filter((m) => m.id.startsWith("gateway:")).map((model) => <option key={model.id} value={model.id} disabled={model.id.length > 160}>{model.name}</option>)}</optgroup>}{filteredModels.some((m) => m.id.startsWith("gemini:")) && <optgroup label="✨ Google Gemini">{filteredModels.filter((m) => m.id.startsWith("gemini:")).map((model) => <option key={model.id} value={model.id} disabled={model.id.length > 160}>{model.name}</option>)}</optgroup>}{filteredModels.some((m) => !m.isFree && !m.id.startsWith("gemini:") && !m.id.startsWith("gateway:") && !m.id.startsWith("nvidia:")) && <optgroup label="🌐 OpenRouter (Geral)">{filteredModels.filter((m) => !m.isFree && !m.id.startsWith("gemini:") && !m.id.startsWith("gateway:") && !m.id.startsWith("nvidia:")).map((model) => <option key={model.id} value={model.id} disabled={model.id.length > 160}>{model.name}</option>)}</optgroup>}</select></label>
          {models !== null && filteredModels.length === 0 && <p role="status" className="text-xs text-muted-foreground">Nenhum modelo corresponde aos filtros.</p>}
        </div>}
        {selectedModel && <p className="text-xs text-muted-foreground">Ferramentas: {selectedModel.supportsTools ? "sim" : "não"} · Visão: {selectedModel.inputModalities?.includes("image") ? "sim" : "não informada"}{selectedModel.contextLength ? ` · Contexto: ${selectedModel.contextLength.toLocaleString("pt-BR")}` : ""}</p>}
        {selectedModel && modelPriceLabel(selectedModel) && <p className="text-xs text-muted-foreground">Preço: {modelPriceLabel(selectedModel)}</p>}
        {modelError ? <Button type="button" variant="outline" onClick={() => void loadModels()}>Recarregar modelos</Button> : models === null ? <p role="status" className="text-xs">Carregando modelos...</p> : models.length === 0 && <p className="text-xs">Nenhum modelo disponível. <Link href="/sites/settings" className="text-primary underline">Ver configurações</Link></p>}
        <label className="block space-y-1">Ação principal (CTA)<select className={selectClass} value={values.cta.type} onChange={(event) => change({ cta: { type: event.target.value as WebsiteProject["cta"]["type"], value: "" } })}><option value="whatsapp">WhatsApp</option><option value="form">Formulário</option><option value="phone">Telefone</option><option value="calendar">Agenda</option><option value="url">Link</option></select></label>
        <label className="block space-y-1">Destino do CTA<Input maxLength={2048} value={values.cta.value} onChange={(event) => change({ cta: { ...values.cta, value: event.target.value } })} /></label>
        <p className="text-xs text-muted-foreground">Alterações de contexto e CTA orientam o próximo pedido ao agente; não reescrevem o site automaticamente.</p>
      </fieldset>
      {draft && <p role="status" className="text-xs text-muted-foreground">Ajustes não salvos.</p>}
      <Button type="submit" className="w-full" disabled={busy || !draft}>{saving ? "Salvando..." : "Salvar ajustes"}</Button>
      {draft && <Button type="button" variant="outline" className="w-full" disabled={busy} onClick={() => { if (window.confirm("Descartar os ajustes não salvos?")) { setDraft(null); onDirtyChange(false); } }}>Descartar ajustes</Button>}
    </form>
    <section className="space-y-2 border-t border-border pt-4"><h3 className="font-medium">Skills aplicadas ao site</h3>
      {skillsError ? <div role="alert" className="space-y-2"><p className="text-xs">Não foi possível carregar as skills.</p><Button size="sm" variant="outline" onClick={() => void loadSkills()}>Tentar novamente</Button></div>
        : skills === null ? <p role="status" className="text-xs">Carregando skills...</p>
        : selectableSkills.length === 0 && automaticSkills.length === 0 ? <p className="text-xs text-muted-foreground">Nenhuma skill ativa disponível. <Link href="/sites/skills" className="text-primary underline">Criar skill na biblioteca</Link></p>
        : <>
          {selectableSkills.length > 0 && <fieldset disabled={busy} className="space-y-1"><legend className="sr-only">Skills manuais</legend>
            {selectableSkills.map((skill) => <label key={skill.id} className="flex items-start gap-2 text-xs"><input className="mt-0.5 size-4 accent-primary" type="checkbox" checked={values.selected_skill_ids.includes(skill.id)} onChange={(event) => change({ selected_skill_ids: event.target.checked ? [...values.selected_skill_ids, skill.id] : values.selected_skill_ids.filter((id) => id !== skill.id) })} /><span><span className="font-medium">{skill.name}</span>{isOverrideSkill(skill) ? " (padrão com override)" : ""}<br /><span className="text-muted-foreground">{skill.description || skill.slug}</span></span></label>)}
          </fieldset>}
          {automaticSkills.length > 0 && <div className="rounded-lg border border-border p-2"><h4 className="text-xs font-medium">Aplicadas automaticamente pelo servidor</h4><ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">{automaticSkills.slice(0, 10).map((skill) => <li key={skill.id}>{skill.name} · {skillTriggerLabel(skill.trigger_mode)}{skill.trigger_mode === "automatic" && skill.tags.length > 0 ? ` (${skill.tags.slice(0, 3).join(", ")})` : ""}</li>)}</ul>{automaticSkills.length > 10 && <p className="mt-1 text-xs text-muted-foreground">+{automaticSkills.length - 10} outras</p>}</div>}
          {automaticSkills.length > 0 && <p className="text-xs text-muted-foreground">Skills padrão são aplicadas automaticamente (sempre ou por tags) e não podem ser marcadas por projeto; para controle manual por projeto, duplique uma skill padrão na biblioteca definindo ativação Manual.</p>}
          <p className="text-xs text-muted-foreground">Skills manuais entram no próximo pedido ao agente após salvar. <Link href="/sites/skills" className="text-primary underline">Gerenciar na biblioteca</Link></p>
          {draft && <p role="status" className="text-xs text-muted-foreground">Skills com alterações não salvas.</p>}
        </>}
    </section>
    <section className="space-y-2 border-t border-border pt-4"><h3 className="font-medium">Publicação</h3>
      {url ? <><a href={url} target="_blank" rel="noopener noreferrer" className="block break-all text-primary underline">{url}</a><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => { void navigator.clipboard.writeText(url).then(() => toast.success("Link copiado.")).catch(() => toast.error("Não foi possível copiar. Selecione o link acima.")); }}>Copiar link</Button><a className="inline-flex min-h-9 items-center rounded-lg border border-border px-3 text-xs" href={`https://wa.me/?text=${encodeURIComponent("Confira seu novo site: " + url)}`} target="_blank" rel="noopener noreferrer">Enviar pelo WhatsApp</a></div></> : <p className="text-xs text-muted-foreground">O site ainda não foi publicado.</p>}
      <Button className="w-full" disabled={busy || filesDirty || Boolean(draft)} onClick={onPublish}>Validar e publicar revisão salva</Button>
    </section>
    {historyError ? <div role="alert"><p>Não foi possível atualizar o histórico.</p><Button variant="outline" onClick={() => void loadHistory()}>Tentar novamente</Button></div> : !history && <p role="status">Carregando histórico...</p>}
    <details className="border-t border-border pt-3"><summary className="cursor-pointer py-1 font-medium">Revisões</summary><ul className="mt-2 space-y-3">{history?.revisions.map((revision) => <li key={revision.id} className="space-y-1"><p className="break-words text-xs">{revision.message}</p><p className="text-xs text-muted-foreground">{formatRelative(revision.created_at)}{revision.id === project.current_revision_id ? " · Atual" : ""}</p><Button size="sm" variant="outline" disabled={busy || filesDirty || Boolean(draft) || revision.id === project.current_revision_id} onClick={() => void restore(revision.id)}>Restaurar revisão</Button></li>)}</ul>{history?.revisions.length === 0 && <p className="text-xs">Nenhuma revisão.</p>}<p className="mt-3 text-xs text-muted-foreground">Para recuperar edições recentes de código, use desfazer/refazer no painel de arquivos. Revisões preservam o histórico completo e a restauração nunca altera o site publicado.</p></details>
    <details className="border-t border-border pt-3"><summary className="cursor-pointer py-1 font-medium">Validações</summary><ul className="mt-2 space-y-2">{history?.builds.map((build) => <li key={build.id} className="text-xs">{isPublishableBuild(build) ? "Pronta para publicar" : build.status === "unconfigured" ? "Configuração pendente" : build.success && build.qa?.passed ? "Aprovada com ressalvas (sem screenshots completos)" : "Requer ajustes"} · {formatRelative(build.created_at)} · {(build.duration_ms / 1000).toFixed(1)}s<p className="text-muted-foreground">{build.errors.length} erro(s), {build.warnings.length} aviso(s){build.qa?.visual_review ? ` · Crítica: ${build.qa.visual_review.slice(0, 140)}` : " · Sem crítica visual registrada"}</p></li>)}</ul>{history?.builds.length === 0 && <p className="text-xs">Nenhuma validação.</p>}</details>
    <details className="border-t border-border pt-3"><summary className="cursor-pointer py-1 font-medium">Histórico de publicações</summary><ul className="mt-2 space-y-3">{history?.deployments.map((deployment) => <li key={deployment.id} className="space-y-1 text-xs"><p>{{ deploying: "Publicando", published: "Publicado", failed: "Falhou" }[deployment.status]} · {formatRelative(deployment.created_at)}{deployment.id === project.published_deployment_id ? " · Atual" : ""}</p>{deployment.status === "failed" && deployment.error && <p className="break-words text-destructive">{deployment.error}</p>}<Button size="sm" variant="outline" disabled={busy || deployment.status !== "published" || deployment.id === project.published_deployment_id} onClick={() => onRollback(deployment.id)}>Voltar para esta publicação</Button></li>)}</ul>{history?.deployments.length === 0 && <p className="text-xs">Nenhuma publicação.</p>}</details>
    <section className="space-y-2 border-t border-border pt-4"><h3 className="font-medium">Uso recente</h3><p className="text-xs">{runs.length} execução(ões) carregada(s) · {usage.toLocaleString("pt-BR")} tokens registrados nas mensagens carregadas.</p><p className="text-xs text-muted-foreground">Histórico limitado; não representa a cota mensal. Custos não informados pela API.</p>{lastRun && <p className="text-xs">Última execução: {runStatusLabel(lastRun.status)}{lastRun.model_id ? ` · ${lastRun.model_id}` : ""}</p>}</section>
    <section className="space-y-2 border-t border-destructive/30 pt-4">
      <h3 className="font-medium text-destructive">Zona de perigo</h3>
      <p className="text-xs text-muted-foreground">Excluir este projeto remove permanentemente o site, histórico de revisões e rascunhos.</p>
      {confirmDelete ? (
        <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <p className="text-xs font-medium text-destructive">Tem certeza de que deseja excluir este site? Esta ação não pode ser desfeita.</p>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" disabled={deletingProject} onClick={() => void handleDeleteProject()}>
              {deletingProject ? "Excluindo..." : "Confirmar exclusão"}
            </Button>
            <Button size="sm" variant="outline" disabled={deletingProject} onClick={() => setConfirmDelete(false)}>
              Cancelar
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="outline" className="text-destructive hover:bg-destructive/10 cursor-pointer" disabled={busy} onClick={() => setConfirmDelete(true)}>
          <Trash2 className="size-3.5 mr-1" aria-hidden="true" />
          Excluir este projeto
        </Button>
      )}
    </section>
  </div>;
}
