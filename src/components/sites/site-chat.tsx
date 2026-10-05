"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { toast } from "sonner";
import { Bot, Loader2, Paperclip, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { assistantText, parseSystemEvent, runStatusLabel, safeSiteUrl } from "@/lib/sites/ui-helpers";
import type { ModelMode, WebsiteAsset, WebsiteMessage, WebsiteModel, WebsiteProject, WebsiteRun, WebsiteSkill } from "@/lib/sites/types";
import { apiJson, ApiError, errorMessage, jsonBody, selectClass } from "./api";
import { stagedFileProblem, uploadStagedFiles, useDraftUnloadWarning, useSiteDraft, type StagedUpload } from "@/lib/sites/ui";

export function SiteChat({ draftScope, projectId, project, activeRun, runs, blocked, onQueued, onRunsChanged, onProjectChanged, onMutationStart, onMutationEnd }: {
  draftScope: string; projectId: string; project?: WebsiteProject; activeRun: WebsiteRun | null; runs: WebsiteRun[]; blocked: boolean;
  onQueued: (run: WebsiteRun) => void; onRunsChanged: () => Promise<void>;
  onProjectChanged?: () => Promise<void>;
  onMutationStart: () => boolean; onMutationEnd: () => void;
}): React.JSX.Element {
  const [messages, setMessages] = useState<WebsiteMessage[] | null>(null);
  const [messageError, setMessageError] = useState(false);
  const [chatDraft, setChatDraft] = useSiteDraft(draftScope, "chat");
  const prompt = chatDraft?.prompt ?? "";
  const selected = chatDraft?.selected ?? [];
  function setPrompt(value: string): void { setChatDraft((prev) => ({ ...prev, selected: prev?.selected ?? [], prompt: value })); }
  function setSelected(value: string[] | ((previous: string[]) => string[])): void {
    setChatDraft((prev) => ({ ...prev, prompt: prev?.prompt ?? "", selected: typeof value === "function" ? value(prev?.selected ?? []) : value }));
  }
  const [models, setModels] = useState<WebsiteModel[] | null>(null);
  const [skills, setSkills] = useState<WebsiteSkill[] | null>(null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const skillsPopoverRef = useRef<HTMLDivElement>(null);
  const [activeModelId, setActiveModelId] = useState<string>(project?.model_id ?? "");
  const [activeModelMode, setActiveModelMode] = useState<ModelMode>(project?.model_mode ?? "auto");
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [assets, setAssets] = useState<WebsiteAsset[]>([]);
  const [purpose, setPurpose] = useState<WebsiteAsset["purpose"]>("content");
  const [license, setLicense] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [staged, setStaged] = useState<StagedUpload[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stagedRef = useRef(staged);
  const uploadingRef = useRef(false);
  const runVersion = runs.map((run) => `${run.id}:${run.status}`).join("|");
  const activeRunId = activeRun?.id;
  const latestMessageId = messages?.at(-1)?.id;
  const latestActivity = messages?.filter((message) => message.role === "system" && message.run_id === activeRunId).at(-1);
  const liveStatus = activeRun
    ? activeRun.cancel_requested ? "Cancelamento solicitado. Aguardando o encerramento da execução."
      : `${runStatusLabel(activeRun.status)}${latestActivity ? ` ${parseSystemEvent(latestActivity.content)}` : ""}`
    : "";

  useEffect(() => { stagedRef.current = staged; }, [staged]);
  useEffect(() => () => stagedRef.current.forEach((item) => URL.revokeObjectURL(item.url)), []);
  useDraftUnloadWarning(staged.length > 0);

  const loadMessages = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await apiJson<{ messages: WebsiteMessage[] }>(`/api/sites/${projectId}/messages`, { signal });
      if (!signal?.aborted) { setMessages(data.messages); setMessageError(false); }
    } catch (error) {
      if (!signal?.aborted) { setMessageError(true); toast.error(errorMessage(error), { id: "sites-messages" }); }
    }
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    void loadMessages(controller.signal);
    let timer: ReturnType<typeof setTimeout>;
    async function poll(): Promise<void> {
      await loadMessages(controller.signal);
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), 3000);
    }
    if (activeRunId) timer = setTimeout(() => void poll(), 3000);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [loadMessages, activeRunId, runVersion]);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try { const data = await apiJson<{ assets: WebsiteAsset[] }>(`/api/sites/${projectId}/assets`, { signal: controller.signal }); if (!controller.signal.aborted) setAssets(data.assets); }
      catch (error) { if (!controller.signal.aborted) toast.error(errorMessage(error)); }
    })();
    return () => controller.abort();
  }, [projectId]);

  useEffect(() => {
    const controller = new AbortController();
    apiJson<{ models: WebsiteModel[] }>("/api/sites/models", { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setModels(data.models); })
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  const loadSkills = useCallback(async (signal?: AbortSignal) => {
    try {
      setSkillsLoading(true);
      const data = await apiJson<{ skills: WebsiteSkill[] }>("/api/sites/skills", { signal });
      if (!signal?.aborted) setSkills(data.skills);
    } catch {
      // ignore
    } finally {
      if (!signal?.aborted) setSkillsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadSkills(controller.signal);
    return () => controller.abort();
  }, [loadSkills]);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (skillsPopoverRef.current && !skillsPopoverRef.current.contains(event.target as Node)) {
        setSkillsOpen(false);
      }
    }
    if (skillsOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [skillsOpen]);

  const impeccableSkill = skills?.find((s) => s.slug === "impeccable-design" || s.id === "builtin:impeccable-design") ?? skills?.[0];
  const isImpeccableActive = impeccableSkill ? impeccableSkill.is_enabled : true;

  async function toggleImpeccable(): Promise<void> {
    const targetSkill = impeccableSkill ?? { id: "builtin:impeccable-design", name: "Impeccable Design (Anti-AI)", slug: "impeccable-design", is_enabled: true } as WebsiteSkill;
    const nextState = !isImpeccableActive;
    setSkills((prev) => prev ? prev.map((s) => s.id === targetSkill.id ? { ...s, is_enabled: nextState } : s) : [{ ...targetSkill, is_enabled: nextState }]);
    try {
      await apiJson(`/api/sites/skills/${encodeURIComponent(targetSkill.id)}`, jsonBody({ is_enabled: nextState }, "PATCH"));
      toast.success(
        nextState
          ? "✨ Impeccable Design ativado: todo prompt seguirá regras autorais anti-AI."
          : "Impeccable Design desativado."
      );
      void onProjectChanged?.();
    } catch (err) {
      setSkills((prev) => prev ? prev.map((s) => s.id === targetSkill.id ? { ...s, is_enabled: !nextState } : s) : null);
      toast.error(errorMessage(err));
    }
  }

  useEffect(() => {
    if (project) {
      setActiveModelId(project.model_id ?? "");
      setActiveModelMode(project.model_mode ?? "auto");
    }
  }, [project?.model_mode, project?.model_id]);

  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [latestMessageId]);

  async function switchModel(val: string): Promise<void> {
    if (["auto", "quality", "economy"].includes(val)) {
      setActiveModelMode(val as ModelMode);
      setActiveModelId("");
      try {
        await apiJson(`/api/sites/${projectId}`, jsonBody({ model_mode: val, model_id: null }, "PATCH"));
        void onProjectChanged?.();
        toast.success(`Modelo alterado para ${val === "auto" ? "Automático" : val === "quality" ? "Alta Qualidade" : "Econômico"}. O agente continuará deste ponto.`);
      } catch (err) { toast.error(errorMessage(err)); }
    } else {
      setActiveModelMode("manual");
      setActiveModelId(val);
      const found = models?.find((m) => m.id === val);
      try {
        await apiJson(`/api/sites/${projectId}`, jsonBody({ model_mode: "manual", model_id: val }, "PATCH"));
        void onProjectChanged?.();
        toast.success(`Modelo alterado para ${found?.name ?? val}. O agente continuará deste ponto.`);
      } catch (err) { toast.error(errorMessage(err)); }
    }
  }

  async function send(): Promise<void> {
    if (!prompt.trim() || sending || uploading || activeRun || blocked || !onMutationStart()) return;
    setSending(true);
    try {
      const data = await apiJson<{ runs: WebsiteRun[] }>(`/api/sites/${projectId}/runs`, jsonBody({
        prompt: prompt.trim(),
        ...(selected.length ? { asset_ids: selected } : {}),
        ...(activeModelMode === "manual" && activeModelId ? { model_id: activeModelId } : {}),
      }));
      const run = data.runs[0];
      if (!run) throw new Error();
      onQueued(run); setPrompt(""); setSelected([]);
      await loadMessages();
      void onRunsChanged();
    } catch (error) { toast.error(errorMessage(error)); }
    finally { setSending(false); onMutationEnd(); }
  }

  async function cancel(): Promise<void> {
    if (!activeRun || cancelling) return;
    setCancelling(true);
    try {
      await apiJson<{ runs: WebsiteRun[] }>(`/api/sites/${projectId}/runs/${activeRun.id}/cancel`, { method: "POST" });
      toast.info("Cancelamento solicitado."); await onRunsChanged();
    } catch (error) { toast.error(errorMessage(error)); }
    finally { setCancelling(false); }
  }

  function stageFiles(list: FileList | File[]): void {
    if (blocked || activeRun || uploading) return;
    const room = Math.min(12 - staged.length, 20 - assets.length);
    if (room <= 0) { toast.error("Limite de imagens por pedido atingido."); return; }
    const incoming = Array.from(list).slice(0, room);
    if (incoming.length === 0) return;
    setStaged((prev) => [...prev, ...incoming.map((file) => ({
      id: `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`,
      file, url: URL.createObjectURL(file),
      problem: stagedFileProblem(file),
    }))]);
  }

  function removeStaged(id: string): void {
    setStaged((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((item) => item.id !== id);
    });
  }

  async function uploadStaged(): Promise<void> {
    if (uploadingRef.current || sending || blocked || activeRun || assets.length >= 20) return;
    const ready = staged.filter((item) => !item.problem && !item.uncertain);
    if (ready.length === 0) return;
    if (!license) { toast.error("Confirme que possui autorização de uso das imagens."); return; }
    if (!onMutationStart()) return;
    setUploading(true); uploadingRef.current = true;
    try {
      let uploaded = 0;
      await uploadStagedFiles(stagedRef.current, async (item) => {
        const form = new FormData();
        form.append("file", item.file); form.append("purpose", purpose); form.append("license_confirmed", "true");
        try {
          const data = await apiJson<{ asset: WebsiteAsset }>(`/api/sites/${projectId}/assets`, { method: "POST", body: form });
          return data.asset;
        } catch (error) {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) throw error;
          throw Object.assign(new Error(), { uncertain: true, cause: error });
        }
      }, (item, asset) => {
        uploaded++;
        URL.revokeObjectURL(item.url);
        setAssets((prev) => [asset, ...prev]);
        setSelected((prev) => prev.length < 12 ? [...prev, asset.id] : prev);
        setStaged((prev) => prev.filter((entry) => entry.id !== item.id));
      }, (item, error) => {
        const uncertain = error instanceof ApiError ? false : (error as { uncertain?: boolean }).uncertain === true;
        if (uncertain) { toast.info("Uma imagem ficou sem confirmação de envio. Recarregue a lista antes de tentar novamente."); setStaged((prev) => prev.map((entry) => entry.id === item.id ? { ...entry, uncertain: true } : entry)); }
        else { toast.error(errorMessage(error)); setStaged((prev) => prev.map((entry) => entry.id === item.id ? { ...entry, uploadError: "Falha no envio; tente novamente" } : entry)); }
      });
      if (uploaded > 0) toast.success(uploaded === 1 ? "Imagem enviada. Ela já está anexada ao próximo pedido." : `${uploaded} imagens enviadas. Elas já estão anexadas ao próximo pedido.`);
      else if (stagedRef.current.every((item) => item.problem || item.uploadError)) toast.error("Nenhuma imagem foi enviada.");
    } finally { setUploading(false); uploadingRef.current = false; onMutationEnd(); if (inputRef.current) inputRef.current.value = ""; }
  }

  return <div className="flex h-full min-h-[560px] min-w-0 flex-col gap-3 p-3">
    <h2 className="flex items-center gap-2 text-sm font-semibold"><Bot className="size-4 text-primary" aria-hidden="true" />Converse com o agente</h2>
    <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{liveStatus}</p>
    <div ref={scrollRef} aria-label="Histórico da conversa" className="min-h-40 flex-1 space-y-3 overflow-y-auto break-words">
      {messageError ? <div role="alert" className="text-sm"><p>Não foi possível carregar a conversa.</p><Button variant="outline" onClick={() => void loadMessages()}>Tentar novamente</Button></div> : messages === null ? <p role="status" className="animate-pulse text-sm text-muted-foreground">Carregando conversa...</p> : messages.length === 0 && <p className="py-8 text-sm text-muted-foreground">Descreva o negócio, a direção visual e o que o visitante deve fazer. Use somente informações confirmadas.</p>}
      {messages?.map((message) => message.role === "system" ? (
        <div
          key={message.id}
          className={`rounded border px-2.5 py-2 text-xs ${
            message.content.includes("active_skills") || message.content.includes("skill_analysis")
              ? "border-primary/30 bg-primary/5 text-foreground"
              : "border-border/50 text-muted-foreground"
          }`}
        >
          <span
            className={`mb-1 flex items-center gap-1.5 font-medium ${
              message.content.includes("active_skills") || message.content.includes("skill_analysis") ? "font-semibold text-primary" : ""
            }`}
          >
            {(message.content.includes("active_skills") || message.content.includes("skill_analysis")) && <Sparkles className="size-3 text-primary" aria-hidden="true" />}
            {message.content.includes("active_skills") || message.content.includes("skill_analysis") ? "Diretriz Impeccable Design" : "Atividade"}
          </span>
          <p className={message.content.includes("active_skills") || message.content.includes("skill_analysis") ? "font-medium text-foreground/90" : ""}>
            {parseSystemEvent(message.content)}
          </p>
        </div>
      ) : (
        <div key={message.id} className={`rounded-lg p-3 text-sm ${message.role === "user" ? "ml-5 bg-primary/10" : "mr-3 bg-secondary"}`}>
          <span className="mb-1 block text-xs font-medium text-muted-foreground">{message.role === "user" ? "Você" : "Agente"}</span>
          <p className="whitespace-pre-wrap">{message.role === "assistant" ? assistantText(message.content) : message.content}</p>
        </div>
      ))}
    </div>
    {activeRun && <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-primary/10 p-2"><span className="flex min-w-0 flex-1 items-center gap-2 text-xs"><Loader2 className="size-3 shrink-0 animate-spin" aria-hidden="true" />{liveStatus}</span><Button size="sm" variant="outline" disabled={cancelling || activeRun.cancel_requested} onClick={() => void cancel()}>{activeRun.cancel_requested ? "Cancelamento solicitado" : "Cancelar"}</Button></div>}
    <details className="rounded-lg border border-border p-2" onDragOver={(event) => { event.preventDefault(); setDragActive(true); }} onDragLeave={() => setDragActive(false)} onDrop={(event) => { event.preventDefault(); setDragActive(false); if (!license) toast.error("Confirme a autorização de uso antes de soltar imagens."); else stageFiles(event.dataTransfer.files); }}>
      <summary className="cursor-pointer py-1 text-xs">Imagens e anexos ({selected.length}/12{staged.length > 0 ? ` · ${staged.length} prontas p/ envio` : ""})</summary>
      <div className={`mt-3 space-y-3 rounded-lg border border-dashed p-3 transition-colors ${dragActive ? "border-primary bg-primary/5" : "border-border"}`}>
        <p className="text-xs text-muted-foreground">Arraste imagens para cá (PNG, JPEG ou WEBP, até 8 MB cada) ou use o seletor. Nada é enviado antes de você confirmar o envio. Imagens em preparo ficam somente nesta tela: ao navegar para outra página ou recarregar, elas são descartadas.</p>
        <label className="block text-xs">Finalidade das próximas imagens<select className={selectClass} value={purpose} onChange={(event) => setPurpose(event.target.value as WebsiteAsset["purpose"])}><option value="content">Conteúdo</option><option value="logo">Logo</option><option value="reference">Referência visual</option></select></label>
        <label className="flex items-start gap-2 text-xs"><input className="mt-0.5 size-4 shrink-0 accent-primary" type="checkbox" checked={license} onChange={(event) => setLicense(event.target.checked)} />Confirmo que possuo licença ou autorização para usar {staged.length > 1 ? "estas imagens" : "esta imagem"}.</label>
        <label className="block space-y-2 text-xs">Selecionar arquivo<input ref={inputRef} type="file" className="block w-full text-xs" accept="image/png,image/jpeg,image/webp" multiple disabled={uploading || sending || blocked || Boolean(activeRun) || assets.length >= 20 || !license} onChange={(event) => { if (event.target.files) stageFiles(event.target.files); event.target.value = ""; }} /></label>
        {staged.length > 0 && <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">{staged.map((item) => <li key={item.id} className="space-y-1 rounded-lg border border-border p-2">
          <Image unoptimized src={item.url} width={96} height={96} alt={`Pré-visualização de ${item.file.name}`} className="h-20 w-full rounded bg-secondary/50 object-contain" />
          <p className="break-all text-[11px]">{item.file.name} · {(item.file.size / 1024).toFixed(0)} KB</p>
          {item.problem ? <p role="alert" className="text-[11px] text-destructive">{item.problem}</p> : item.uncertain ? <p role="alert" className="text-[11px] text-destructive">Envio sem confirmação — recarregue a lista de imagens para verificar antes de tentar de novo.</p> : item.uploadError ? <p role="alert" className="text-[11px] text-destructive">{item.uploadError}</p> : <p className="text-[11px] text-muted-foreground">Pré-visualização local</p>}
          <Button type="button" size="sm" variant="outline" className="h-7 w-full" disabled={uploading} onClick={() => removeStaged(item.id)}>Remover</Button>
        </li>)}</ul>}
        {staged.length > 0 && <Button size="sm" disabled={uploading || sending || blocked || Boolean(activeRun) || assets.length >= 20 || !license || staged.every((item) => item.problem || item.uploadError || item.uncertain)} onClick={() => void uploadStaged()}>{uploading ? "Enviando..." : `Enviar ${staged.filter((item) => !item.problem && !item.uploadError && !item.uncertain).length} imagem(ns)`}</Button>}
        {uploading && <p role="status" className="text-xs">Enviando imagens...</p>}
        <div className="max-h-48 space-y-2 overflow-auto">{assets.map((asset) => <label key={asset.id} className="flex min-h-10 items-center gap-2 text-xs"><input type="checkbox" className="size-4 accent-primary" checked={selected.includes(asset.id)} disabled={!selected.includes(asset.id) && selected.length >= 12} onChange={(event) => setSelected((prev) => event.target.checked ? [...prev, asset.id] : prev.filter((id) => id !== asset.id))} />{safeSiteUrl(asset.url) && <Image unoptimized src={asset.url!} width={32} height={32} alt="" className="size-8 rounded object-cover" />}<span className="break-all">{asset.name}</span></label>)}</div>
      </div>
    </details>
    <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label htmlFor="site-prompt" className="text-xs font-medium">Seu pedido</label>
        <div className="flex items-center gap-2">
          <div className="relative flex items-center">
            <button
              type="button"
              id="skills-toggle-btn"
              onClick={() => void toggleImpeccable()}
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium transition-all shadow-xs cursor-pointer border ${
                isImpeccableActive
                  ? "bg-primary/15 hover:bg-primary/25 border-primary/40 text-primary"
                  : "bg-muted/40 hover:bg-muted border-border text-muted-foreground opacity-75"
              }`}
              title={isImpeccableActive ? "Impeccable Design Ativo (clique para desativar)" : "Impeccable Design Desativado (clique para ativar)"}
            >
              <Sparkles className={`size-3 ${isImpeccableActive ? "text-primary" : "text-muted-foreground"}`} aria-hidden="true" />
              <span>{isImpeccableActive ? "✨ Impeccable: Ativo" : "Impeccable: Desativado"}</span>
            </button>
            <button
              type="button"
              onClick={() => setSkillsOpen((prev) => !prev)}
              className="ml-1 p-0.5 text-muted-foreground hover:text-foreground text-[10px] rounded hover:bg-muted cursor-pointer"
              title="Ver detalhes da diretriz Impeccable Design"
              aria-label="Ver detalhes da skill"
            >
              ℹ️
            </button>

            {skillsOpen && (
              <div
                ref={skillsPopoverRef}
                className="absolute right-0 sm:left-0 sm:right-auto bottom-full mb-2 z-50 w-80 sm:w-96 flex flex-col rounded-xl border border-border bg-popover/95 backdrop-blur-md p-3.5 shadow-2xl text-popover-foreground animate-in fade-in-50 zoom-in-95 duration-100"
              >
                <div className="flex items-center justify-between pb-2 border-b border-border/60">
                  <div className="flex items-center gap-1.5">
                    <Sparkles className="size-4 text-primary" />
                    <span className="text-xs font-semibold">Skill Impeccable Design</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSkillsOpen(false)}
                    className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground text-xs cursor-pointer"
                    aria-label="Fechar"
                  >
                    ✕
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
                  Baseada em <strong className="text-foreground">pbakaus/impeccable</strong>: orienta a IA a criar sites com direção de arte premiada, tipografia autoral e sem clichês de IA (sem grids de 3 cards repetitivos e sem templates verdes genéricos).
                </p>
                <div className="mt-3 p-2.5 rounded-lg border border-border/60 bg-accent/20 flex items-center justify-between">
                  <div>
                    <span className="text-xs font-medium block">Status da Diretriz</span>
                    <span className="text-[10px] text-muted-foreground">
                      {isImpeccableActive ? "Obrigatória em todos os prompts" : "Desativada pelo usuário"}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void toggleImpeccable()}
                    className={`text-xs px-2.5 py-1 rounded font-medium transition-colors cursor-pointer ${
                      isImpeccableActive
                        ? "bg-primary text-primary-foreground hover:opacity-90"
                        : "border border-border bg-muted hover:bg-muted/80 text-foreground"
                    }`}
                  >
                    {isImpeccableActive ? "Desativar" : "Ativar"}
                  </button>
                </div>
                <div className="mt-2.5 text-[10px] text-muted-foreground/90 space-y-1 bg-background/50 p-2 rounded border border-border/40">
                  <div>✅ <strong>Criação do Zero:</strong> Substitui qualquer template padrão por design exclusivo.</div>
                  <div>🚫 <strong>Anti-AI Slop:</strong> Proíbe paletas verdes de template, cards repetidos e métricas falsas.</div>
                  <div>📐 <strong>Tipografia & Ritmo:</strong> Escalas contrastantes e espaçamento assimétrico orgânico.</div>
                </div>
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-muted-foreground flex items-center gap-1">
              <Bot className="size-3 text-primary" aria-hidden="true" />
              Modelo:
            </span>
          <select
            id="chat-model-select"
            aria-label="Modelo de IA para este pedido"
            className="h-6 rounded border border-border/80 bg-background px-1.5 text-[11px] text-foreground outline-none transition-colors focus:border-primary max-w-[220px] truncate cursor-pointer"
            value={activeModelMode === "manual" ? (activeModelId || "") : activeModelMode}
            disabled={sending || project?.status === "archived"}
            onChange={(e) => void switchModel(e.target.value)}
          >
            <option value="auto">Automático (Recomendado)</option>
            <option value="quality">Alta Qualidade</option>
            <option value="economy">Econômico</option>
            {activeModelMode === "manual" && activeModelId && !models?.some((m) => m.id === activeModelId) && (
              <option value={activeModelId}>{activeModelId}</option>
            )}
            {models && models.length > 0 && (
              <>
                {models.some((m) => m.id.startsWith("nvidia:")) && (
                  <optgroup label="⚡ NVIDIA NIM">
                    {models
                      .filter((m) => m.id.startsWith("nvidia:"))
                      .sort((a, b) => {
                        const aNemo = a.name.toLowerCase().includes("nemotron");
                        const bNemo = b.name.toLowerCase().includes("nemotron");
                        if (aNemo && !bNemo) return -1;
                        if (!aNemo && bNemo) return 1;
                        return a.name.localeCompare(b.name);
                      })
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                  </optgroup>
                )}
                {models.some((m) => m.isFree && !m.id.startsWith("gemini:") && !m.id.startsWith("gateway:") && !m.id.startsWith("nvidia:")) && (
                  <optgroup label="⭐ OpenRouter (Gratuitos)">
                    {models.filter((m) => m.isFree && !m.id.startsWith("gemini:") && !m.id.startsWith("gateway:") && !m.id.startsWith("nvidia:")).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {models.some((m) => m.id.startsWith("gateway:")) && (
                  <optgroup label="🔑 Gateway de Assinatura">
                    {models.filter((m) => m.id.startsWith("gateway:")).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {models.some((m) => m.id.startsWith("gemini:")) && (
                  <optgroup label="✨ Google Gemini">
                    {models.filter((m) => m.id.startsWith("gemini:")).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {models.some((m) => !m.isFree && !m.id.startsWith("gemini:") && !m.id.startsWith("gateway:") && !m.id.startsWith("nvidia:")) && (
                  <optgroup label="🌐 OpenRouter (Geral)">
                    {models.filter((m) => !m.isFree && !m.id.startsWith("gemini:") && !m.id.startsWith("gateway:") && !m.id.startsWith("nvidia:")).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                )}
              </>
            )}
          </select>
        </div>
        </div>
      </div>
      <Textarea id="site-prompt" rows={3} maxLength={16000} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Crie uma página com serviços e contato por WhatsApp" disabled={sending} onKeyDown={(event) => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
      <div className="flex items-center justify-between gap-2"><span className="flex items-center gap-1 text-xs text-muted-foreground"><Paperclip className="size-3" aria-hidden="true" />{selected.length} anexo(s)</span><Button type="submit" disabled={sending || uploading || blocked || Boolean(activeRun) || !prompt.trim()}><Send aria-hidden="true" />{sending ? "Enviando..." : "Enviar"}</Button></div>
    </form>
  </div>;
}
