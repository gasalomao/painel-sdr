"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import { toast } from "sonner";
import { Bot, Image as ImageIcon, Info, Loader2, Paperclip, Send, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { resolveWebsiteUploadPurpose, requestsWebsiteLogo } from "@/lib/sites/asset-intent";
import { assistantText, isModelSelectionLocked, parseSystemEvent, runStatusLabel, safeSiteUrl } from "@/lib/sites/ui-helpers";
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
  const [galleryOpen, setGalleryOpen] = useState(false);
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

  const impeccableSkill = skills?.find((s) => s.slug === "impeccable-design" || s.id === "builtin:impeccable-design");
  const isImpeccableActive = impeccableSkill?.is_enabled ?? false;

  async function toggleImpeccable(): Promise<void> {
    const targetSkill = impeccableSkill ?? { id: "builtin:impeccable-design", name: "Impeccable Design (Anti-AI)", slug: "impeccable-design", is_enabled: true } as WebsiteSkill;
    const nextState = !isImpeccableActive;
    setSkills((prev) => prev ? prev.map((s) => s.id === targetSkill.id ? { ...s, is_enabled: nextState } : s) : [{ ...targetSkill, is_enabled: nextState }]);
    try {
      await apiJson(`/api/sites/skills/${encodeURIComponent(targetSkill.id)}`, jsonBody({ is_enabled: nextState }, "PATCH"));
      if (!nextState && project?.selected_skill_ids?.some((id) => id === targetSkill.id || id === "builtin:impeccable-design" || id === "impeccable-design")) {
        const filtered = (project.selected_skill_ids ?? []).filter((id) => id !== targetSkill.id && id !== "builtin:impeccable-design" && id !== "impeccable-design");
        void apiJson(`/api/sites/${projectId}`, jsonBody({ selected_skill_ids: filtered }, "PATCH")).catch(() => undefined);
      }
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
    if (activeRun) {
      toast.info("Aguarde ou cancele a execução em andamento antes de trocar o modelo.");
      return;
    }
    const prevMode = activeModelMode;
    const prevId = activeModelId;
    if (["auto", "quality", "economy"].includes(val)) {
      setActiveModelMode(val as ModelMode);
      setActiveModelId("");
      try {
        await apiJson(`/api/sites/${projectId}`, jsonBody({ model_mode: val, model_id: null }, "PATCH"));
        void onProjectChanged?.();
        toast.success(`Modelo alterado para ${val === "auto" ? "Automático" : val === "quality" ? "Alta Qualidade" : "Econômico"}. O próximo pedido retomará o último progresso salvo com este modelo.`);
      } catch (err) {
        setActiveModelMode(prevMode);
        setActiveModelId(prevId);
        toast.error(errorMessage(err));
      }
    } else {
      setActiveModelMode("manual");
      setActiveModelId(val);
      const found = models?.find((m) => m.id === val);
      try {
        await apiJson(`/api/sites/${projectId}`, jsonBody({ model_mode: "manual", model_id: val }, "PATCH"));
        void onProjectChanged?.();
        toast.success(`Modelo alterado para ${found?.name ?? val}. O próximo pedido retomará o último progresso salvo com este modelo.`);
      } catch (err) {
        setActiveModelMode(prevMode);
        setActiveModelId(prevId);
        toast.error(errorMessage(err));
      }
    }
  }

  function stageFiles(list: FileList | File[]): void {
    if (blocked || activeRun || uploading || sending) return;
    const room = Math.min(12 - (staged.length + selected.length), 20 - assets.length);
    if (room <= 0) { toast.error("Limite de imagens por pedido atingido (máximo 12)."); return; }
    const incoming = Array.from(list).slice(0, room);
    if (incoming.length === 0) return;
    const promptHasLogo = /\b(?:logo|logotipo|logomarca|marca)\b/i.test(prompt);
    setStaged((prev) => [...prev, ...incoming.map((file) => {
      const isLogo = promptHasLogo || /\b(?:logo|logotipo|logomarca)\b/i.test(file.name);
      return {
        id: `${file.name}:${file.size}:${file.lastModified}:${Math.random().toString(36).slice(2)}`,
        file,
        url: URL.createObjectURL(file),
        problem: stagedFileProblem(file),
        purpose: (isLogo ? "logo" : "content") as WebsiteAsset["purpose"],
      };
    })]);
  }

  function updateStagedPurpose(id: string, nextPurpose: WebsiteAsset["purpose"]): void {
    setStaged((prev) => prev.map((item) => item.id === id ? { ...item, purpose: nextPurpose, purposeExplicit: true } : item));
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const items = event.clipboardData?.items;
    if (!items) return;
    const incomingFiles: File[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith("image/")) {
        const file = items[i].getAsFile();
        if (file) incomingFiles.push(file);
      }
    }
    if (incomingFiles.length > 0) {
      event.preventDefault();
      stageFiles(incomingFiles);
      toast.info(`${incomingFiles.length} imagem(ns) anexada(s) da área de transferência.`);
    }
  }

  function removeStaged(id: string): void {
    setStaged((prev) => {
      const target = prev.find((item) => item.id === id);
      if (target) URL.revokeObjectURL(target.url);
      return prev.filter((item) => item.id !== id);
    });
  }

  async function send(): Promise<void> {
    const trimmedPrompt = prompt.trim();
    if ((!trimmedPrompt && staged.length === 0 && selected.length === 0) || sending || uploading || activeRun || blocked || !onMutationStart()) return;
    setSending(true);
    try {
      const newlyUploadedIds: string[] = [];
      if (staged.length > 0) {
        const ready = staged.filter((item) => !item.problem && !item.uncertain);
        if (ready.length < staged.length) {
          toast.error("Remova as imagens com formato ou tamanho inválido antes de enviar.");
          return;
        }
        setUploading(true);
        uploadingRef.current = true;

        for (const item of ready) {
          const form = new FormData();
          form.append("file", item.file);
          const itemPurpose = resolveWebsiteUploadPurpose(item, trimmedPrompt, ready.length + selected.length);
          form.append("purpose", itemPurpose);
          form.append("license_confirmed", "true");
          try {
            const data = await apiJson<{ asset: WebsiteAsset }>(`/api/sites/${projectId}/assets`, { method: "POST", body: form });
            newlyUploadedIds.push(data.asset.id);
            setAssets((prev) => [data.asset, ...prev]);
            setSelected((prev) => [...new Set([...prev, data.asset.id])]);
            setStaged((prev) => prev.filter((entry) => entry.id !== item.id));
            URL.revokeObjectURL(item.url);
          } catch (err) {
            toast.error(`Falha no envio de ${item.file.name}: ${errorMessage(err)}`);
            throw err;
          }
        }
        setStaged([]);
      }

      const allAssetIds = [...new Set([...selected, ...newlyUploadedIds])];
      if (allAssetIds.length === 1 && requestsWebsiteLogo(trimmedPrompt)) {
        const existingAsset = assets.find((asset) => asset.id === allAssetIds[0]);
        if (existingAsset && existingAsset.purpose !== "logo") {
          const updated = await apiJson<{ asset: WebsiteAsset }>(`/api/sites/${projectId}/assets/${existingAsset.id}`, jsonBody({ purpose: "logo" }, "PATCH"));
          setAssets((prev) => prev.map((asset) => asset.id === updated.asset.id ? updated.asset : asset));
        }
      }
      const hasLogoIntent = allAssetIds.some((id) => assets.find((asset) => asset.id === id)?.purpose === "logo") || staged.some((item) => item.purpose === "logo");
      const finalPrompt = trimmedPrompt || (allAssetIds.length > 0
        ? (hasLogoIntent
            ? "Essa é a logo oficial da empresa. Insira no topo/header e rodapé em src/App.tsx substituindo o texto/ícone provisório e adapte as cores do site (--brand-primary em src/styles.css) para combinar com a identidade visual."
            : "Utilize e adapte a imagem anexada no site (na seção mais adequada, como hero, sobre ou serviços), com design autoral, responsivo e proporções elegantes.")
        : "");

      const data = await apiJson<{ runs: WebsiteRun[] }>(`/api/sites/${projectId}/runs`, jsonBody({
        prompt: finalPrompt,
        ...(allAssetIds.length ? { asset_ids: allAssetIds } : {}),
        ...(activeModelMode === "manual" && activeModelId ? { model_id: activeModelId } : {}),
      }));
      const run = data.runs[0];
      if (!run) throw new Error("Não foi possível iniciar a execução.");
      onQueued(run);
      setPrompt("");
      setSelected([]);
      await loadMessages();
      void onRunsChanged();
      if (allAssetIds.length > 0) {
        toast.success(`Pedido e ${allAssetIds.length} imagem(ns) enviados ao agente!`);
      }
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setSending(false);
      setUploading(false);
      uploadingRef.current = false;
      onMutationEnd();
      if (inputRef.current) inputRef.current.value = "";
    }
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

  return (
    <div className="flex h-full min-h-[560px] min-w-0 flex-col gap-3 p-3">
      {/* Top Header Card - Enquadrado & Sem Cortes */}
      <div className="rounded-xl border border-border/70 bg-card/60 p-2.5 shadow-xs backdrop-blur-xs flex flex-col gap-2">
        {/* Linha Superior: Converse com o agente + Toggle Impeccable */}
        <div className="flex items-center justify-between gap-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 border border-primary/20 text-primary">
              <Bot className="size-4" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 className="text-xs font-semibold text-foreground tracking-tight whitespace-nowrap truncate">
                Converse com o agente
              </h2>
              <p className="text-[10px] text-muted-foreground truncate">
                Assistente de design e código
              </p>
            </div>
          </div>

          {/* Impeccable Design toggle */}
          <div className="relative flex items-center gap-1 shrink-0">
            <button
              type="button"
              id="skills-toggle-btn"
              onClick={() => void toggleImpeccable()}
              className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all shadow-xs cursor-pointer border whitespace-nowrap ${
                isImpeccableActive
                  ? "bg-primary/15 hover:bg-primary/25 border-primary/40 text-primary font-semibold"
                  : "bg-muted/50 hover:bg-muted border-border/80 text-muted-foreground"
              }`}
              title={isImpeccableActive ? "Impeccable Design Ativo (clique para desativar)" : "Impeccable Design Desativado (clique para ativar)"}
            >
              <Sparkles className={`size-3 shrink-0 ${isImpeccableActive ? "text-primary" : "text-muted-foreground"}`} aria-hidden="true" />
              <span>Impeccable: {isImpeccableActive ? "Ativo" : "Off"}</span>
            </button>
            <button
              type="button"
              onClick={() => setSkillsOpen((prev) => !prev)}
              className="p-1 text-muted-foreground hover:text-foreground rounded-md hover:bg-muted/80 cursor-pointer transition-colors"
              title="Ver detalhes da diretriz Impeccable Design"
              aria-label="Ver detalhes da skill"
            >
              <Info className="size-3" aria-hidden="true" />
            </button>

            {skillsOpen && (
              <div
                ref={skillsPopoverRef}
                className="absolute right-0 top-full mt-2 z-50 w-80 sm:w-96 flex flex-col rounded-xl border border-border bg-popover/95 backdrop-blur-md p-3.5 shadow-2xl text-popover-foreground animate-in fade-in-50 zoom-in-95 duration-100"
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
                  Baseada em <strong className="text-foreground">pbakaus/impeccable</strong>: orienta a IA a criar sites com direção de arte premiada, tipografia, cor, composição, imagens, movimento, acessibilidade e revisão visual a partir do briefing. Na criação, carrega os fundamentos oficiais completos; nas edições, preserva a identidade.
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
        </div>

        {/* Linha Inferior: Seletor de Modelo enquadrado e com largura total */}
        <div className="flex items-center gap-2 rounded-lg border border-border/70 bg-[#0b1220]/80 px-2.5 py-1.5 shadow-2xs">
          <span className="text-[11px] font-medium text-muted-foreground shrink-0 flex items-center gap-1.5">
            <Bot className="size-3.5 text-primary" aria-hidden="true" />
            <span>Modelo:</span>
          </span>
          <select
            id="chat-model-select"
            aria-label="Modelo de IA para este pedido"
            style={{ colorScheme: "dark" }}
            className="h-6 flex-1 min-w-0 bg-transparent text-[11px] font-medium text-slate-200 outline-none cursor-pointer truncate pr-1"
            value={activeModelMode === "manual" ? (activeModelId || "") : activeModelMode}
            disabled={sending || Boolean(activeRun) || project?.status === "archived"}
            onChange={(e) => void switchModel(e.target.value)}
          >
            <option className="bg-[#0f172a] text-slate-100" value="auto">Auto (Recomendado)</option>
            <option className="bg-[#0f172a] text-slate-100" value="quality">Alta Qualidade</option>
            <option className="bg-[#0f172a] text-slate-100" value="economy">Econômico</option>
            {activeModelMode === "manual" && activeModelId && !models?.some((m) => m.id === activeModelId) && (
              <option className="bg-[#0f172a] text-slate-100" value={activeModelId}>{activeModelId}</option>
            )}
            {models && models.length > 0 && (
              <>
                {models.some((m) => m.id.startsWith("nvidia:")) && (
                  <optgroup className="bg-[#0f172a] text-emerald-400 font-bold" label="⚡ NVIDIA NIM">
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
                        <option className="bg-[#0f172a] text-slate-100" key={m.id} value={m.id}>
                          {m.name}
                        </option>
                      ))}
                  </optgroup>
                )}
                {models.some((m) => m.isFree && !m.id.startsWith("gemini:") && !m.id.startsWith("gateway:") && !m.id.startsWith("nvidia:")) && (
                  <optgroup className="bg-[#0f172a] text-amber-400 font-bold" label="⭐ OpenRouter (Gratuitos)">
                    {models.filter((m) => m.isFree && !m.id.startsWith("gemini:") && !m.id.startsWith("gateway:") && !m.id.startsWith("nvidia:")).map((m) => (
                      <option className="bg-[#0f172a] text-slate-100" key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {models.some((m) => m.id.startsWith("gateway:")) && (
                  <optgroup className="bg-[#0f172a] text-blue-400 font-bold" label="🔑 Gateway de Assinatura">
                    {models.filter((m) => m.id.startsWith("gateway:")).map((m) => (
                      <option className="bg-[#0f172a] text-slate-100" key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {models.some((m) => m.id.startsWith("gemini:")) && (
                  <optgroup className="bg-[#0f172a] text-cyan-400 font-bold" label="✨ Google Gemini">
                    {models.filter((m) => m.id.startsWith("gemini:")).map((m) => (
                      <option className="bg-[#0f172a] text-slate-100" key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                )}
                {models.some((m) => !m.isFree && !m.id.startsWith("gemini:") && !m.id.startsWith("gateway:") && !m.id.startsWith("nvidia:")) && (
                  <optgroup className="bg-[#0f172a] text-purple-400 font-bold" label="🌐 OpenRouter (Geral)">
                    {models.filter((m) => !m.isFree && !m.id.startsWith("gemini:") && !m.id.startsWith("gateway:") && !m.id.startsWith("nvidia:")).map((m) => (
                      <option className="bg-[#0f172a] text-slate-100" key={m.id} value={m.id}>
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

      <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">{liveStatus}</p>

      {/* Chat History */}
      <div ref={scrollRef} aria-label="Histórico da conversa" className="min-h-40 flex-1 space-y-3 overflow-y-auto break-words pr-1">
        {messageError ? (
          <div role="alert" className="text-sm p-3 rounded-lg border border-destructive/40 bg-destructive/10">
            <p className="mb-2">Não foi possível carregar a conversa.</p>
            <Button size="sm" variant="outline" onClick={() => void loadMessages()}>Tentar novamente</Button>
          </div>
        ) : messages === null ? (
          <p role="status" className="animate-pulse text-sm text-muted-foreground py-6 text-center">Carregando conversa...</p>
        ) : messages.length === 0 ? (
          <div className="py-12 text-center space-y-2">
            <div className="size-10 rounded-full bg-primary/10 text-primary mx-auto flex items-center justify-center">
              <Bot className="size-5" />
            </div>
            <p className="text-sm font-medium text-foreground">Como posso ajudar com seu site?</p>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              Peça alterações, anexe logos ou imagens com 📎 ou cole fotos diretamente com Ctrl+V.
            </p>
          </div>
        ) : null}

        {messages?.map((message) => {
          if (message.role === "system") {
            return (
              <div
                key={message.id}
                className={`rounded-lg border px-3 py-2 text-xs ${
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
                  {(message.content.includes("active_skills") || message.content.includes("skill_analysis")) && (
                    <Sparkles className="size-3 text-primary" aria-hidden="true" />
                  )}
                  {message.content.includes("skill_analysis") ? "Impeccable Design" : message.content.includes("active_skills") ? "Skills do projeto" : "Atividade"}
                </span>
                <p className={message.content.includes("active_skills") || message.content.includes("skill_analysis") ? "font-medium text-foreground/90" : ""}>
                  {parseSystemEvent(message.content)}
                </p>
              </div>
            );
          }

          const isUser = message.role === "user";
          const messageRun = runs.find((r) => r.id === message.run_id);
          const attachedAssets = isUser && messageRun?.asset_ids
            ? (messageRun.asset_ids.map((id) => assets.find((a) => a.id === id)).filter(Boolean) as WebsiteAsset[])
            : [];

          return (
            <div
              key={message.id}
              className={`rounded-2xl p-3 text-sm shadow-2xs transition-all ${
                isUser
                  ? "ml-6 bg-primary/10 border border-primary/20 text-foreground"
                  : "mr-4 bg-secondary/80 border border-border/60 text-foreground"
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] font-semibold text-muted-foreground flex items-center gap-1.5">
                  {isUser ? "Você" : <><Bot className="size-3.5 text-primary" /> Agente</>}
                </span>
                <span className="text-[10px] text-muted-foreground/60">
                  {new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                </span>
              </div>

              {/* Attached images preview inside user message bubble (like Gemini) */}
              {attachedAssets.length > 0 && (
                <div className="flex flex-wrap gap-2 my-2">
                  {attachedAssets.map((asset) => (
                    <div
                      key={asset.id}
                      className="relative group rounded-xl overflow-hidden border border-border/80 bg-background/50 shadow-xs"
                    >
                      {safeSiteUrl(asset.url) ? (
                        <Image
                          unoptimized
                          src={asset.url!}
                          width={60}
                          height={60}
                          alt={asset.name}
                          className="size-14 object-cover"
                        />
                      ) : (
                        <div className="size-14 flex items-center justify-center bg-muted text-muted-foreground">
                          <ImageIcon className="size-5" />
                        </div>
                      )}
                      <span className="absolute bottom-0 inset-x-0 bg-black/75 backdrop-blur-2xs text-[9px] text-center text-white py-0.5 truncate px-1">
                        {asset.purpose === "logo" ? "Logo" : "Imagem"}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <p className="whitespace-pre-wrap leading-relaxed">
                {message.role === "assistant" ? assistantText(message.content) : message.content}
              </p>
            </div>
          );
        })}
      </div>

      {/* Active Run Banner */}
      {activeRun && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-primary/10 border border-primary/25 p-2 px-3">
          <span className="flex min-w-0 flex-1 items-center gap-2 text-xs font-medium">
            <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" aria-hidden="true" />
            <span className="truncate">{liveStatus}</span>
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={cancelling || activeRun.cancel_requested}
            onClick={() => void cancel()}
            className="h-7 text-xs cursor-pointer"
          >
            {activeRun.cancel_requested ? "Cancelando..." : "Cancelar"}
          </Button>
        </div>
      )}

      {/* Existing Project Gallery Drawer */}
      {galleryOpen && (
        <div className="rounded-xl border border-border/80 bg-card/95 p-3 space-y-2 text-xs shadow-lg backdrop-blur-md animate-in fade-in-50 duration-150">
          <div className="flex items-center justify-between border-b border-border/60 pb-2">
            <span className="font-semibold flex items-center gap-1.5 text-foreground">
              <ImageIcon className="size-3.5 text-primary" aria-hidden="true" />
              Galeria do Projeto ({assets.length} imagens)
            </span>
            <button
              type="button"
              onClick={() => setGalleryOpen(false)}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground text-xs cursor-pointer"
              aria-label="Fechar galeria"
            >
              ✕
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Selecione imagens salvas para anexar ao seu próximo pedido. A IA usará o caminho permanente no site.
          </p>
          <div className="max-h-40 space-y-1.5 overflow-y-auto pr-1">
            {assets.map((asset) => (
              <label
                key={asset.id}
                className={`flex items-center gap-2.5 p-2 rounded-lg border cursor-pointer transition-all ${
                  selected.includes(asset.id)
                    ? "bg-primary/10 border-primary/50 text-foreground"
                    : "border-border/50 hover:bg-muted/40 text-muted-foreground"
                }`}
              >
                <input
                  type="checkbox"
                  className="size-4 accent-primary rounded cursor-pointer shrink-0"
                  checked={selected.includes(asset.id)}
                  disabled={!selected.includes(asset.id) && selected.length + staged.length >= 12}
                  onChange={(e) =>
                    setSelected((prev) =>
                      e.target.checked ? [...prev, asset.id] : prev.filter((id) => id !== asset.id)
                    )
                  }
                />
                {safeSiteUrl(asset.url) && (
                  <Image
                    unoptimized
                    src={asset.url!}
                    width={32}
                    height={32}
                    alt=""
                    className="size-8 rounded-md object-cover border border-border/40 shrink-0"
                  />
                )}
                <span className="truncate flex-1 text-[11px] font-medium text-foreground">{asset.name}</span>
                <span className="text-[10px] uppercase font-semibold tracking-wider px-2 py-0.5 rounded bg-secondary text-muted-foreground shrink-0">
                  {asset.purpose === "logo" ? "Logo" : asset.purpose === "content" ? "Conteúdo" : "Referência"}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Unified Gemini-Style Input Container */}
      <form
        className={`relative flex flex-col rounded-2xl border transition-all shadow-md ${
          dragActive
            ? "border-primary bg-primary/10 ring-2 ring-primary/40"
            : "border-slate-800/90 bg-[#0f172a]/90 backdrop-blur-md hover:border-slate-700 focus-within:border-primary/60 focus-within:ring-1 focus-within:ring-primary/40"
        }`}
        onDragOver={(event) => {
          event.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) {
            setDragActive(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragActive(false);
          if (event.dataTransfer.files) stageFiles(event.dataTransfer.files);
        }}
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        {/* Drag and Drop Overlay */}
        {dragActive && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center rounded-2xl bg-slate-950/95 backdrop-blur-xs border-2 border-dashed border-primary pointer-events-none animate-in fade-in-50 duration-150">
            <Paperclip className="size-7 text-primary animate-bounce mb-1.5" />
            <span className="text-xs font-semibold text-primary">Solte as imagens aqui para anexar</span>
            <span className="text-[10px] text-muted-foreground">PNG, JPEG ou WEBP (até 8 MB)</span>
          </div>
        )}

        {/* Floating Preview Cards of Attached Images (Gemini style) */}
        {(staged.length > 0 || selected.length > 0) && (
          <div className="p-2.5 pb-0">
            <div className="flex items-center gap-2 overflow-x-auto pb-1.5 scrollbar-thin">
              {staged.map((item) => (
                <div
                  key={item.id}
                  className={`relative group flex items-center gap-2 rounded-xl bg-slate-900/95 border p-1.5 pr-2.5 shadow-md shrink-0 transition-all ${
                    item.problem ? "border-destructive/70" : "border-slate-800 hover:border-slate-700"
                  }`}
                >
                  <div className="relative size-11 rounded-lg overflow-hidden border border-slate-800 shrink-0 bg-black/40">
                    <Image
                      unoptimized
                      src={item.url}
                      fill
                      alt=""
                      className="object-cover"
                    />
                  </div>
                  <div className="min-w-0 max-w-[120px] sm:max-w-[160px]">
                    <p className="text-xs font-medium text-slate-200 truncate leading-tight" title={item.file.name}>
                      {item.file.name}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <span className="text-[10px] text-slate-400">
                        {(item.file.size / 1024).toFixed(0)} KB
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          const next = item.purpose === "logo" ? "content" : item.purpose === "content" ? "reference" : "logo";
                          updateStagedPurpose(item.id, next);
                        }}
                        className={`text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded cursor-pointer transition-colors ${
                          item.purpose === "logo"
                            ? "bg-amber-500/20 text-amber-300 border border-amber-500/30 hover:bg-amber-500/30"
                            : item.purpose === "reference"
                            ? "bg-purple-500/20 text-purple-300 border border-purple-500/30 hover:bg-purple-500/30"
                            : "bg-primary/20 text-primary border border-primary/30 hover:bg-primary/30"
                        }`}
                        title="Clique para alternar (Logo / Conteúdo / Referência)"
                      >
                        {item.purpose === "logo" ? "Logo" : item.purpose === "reference" ? "Referência" : "Conteúdo"}
                      </button>
                    </div>
                    {item.problem && <p className="text-[10px] text-destructive font-medium mt-0.5 truncate">{item.problem}</p>}
                  </div>
                  <button
                    type="button"
                    onClick={() => removeStaged(item.id)}
                    className="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-slate-800 hover:bg-rose-600 text-slate-300 hover:text-white flex items-center justify-center text-xs shadow-md cursor-pointer transition-colors border border-slate-700/60"
                    title="Remover anexo"
                    aria-label="Remover anexo"
                  >
                    ✕
                  </button>
                </div>
              ))}

              {selected.map((id) => {
                const asset = assets.find((a) => a.id === id);
                if (!asset) return null;
                return (
                  <div
                    key={asset.id}
                    className="relative group flex items-center gap-2 rounded-xl bg-slate-900/95 border border-primary/40 p-1.5 pr-2.5 shadow-md shrink-0 transition-all"
                  >
                    <div className="relative size-11 rounded-lg overflow-hidden border border-slate-800 shrink-0 bg-black/40">
                      {safeSiteUrl(asset.url) && (
                        <Image
                          unoptimized
                          src={asset.url!}
                          fill
                          alt=""
                          className="object-cover"
                        />
                      )}
                    </div>
                    <div className="min-w-0 max-w-[120px] sm:max-w-[160px]">
                      <p className="text-xs font-medium text-slate-200 truncate leading-tight" title={asset.name}>
                        {asset.name}
                      </p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="text-[9px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-primary/20 text-primary border border-primary/30">
                          {asset.purpose} (galeria)
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelected((prev) => prev.filter((item) => item !== asset.id))}
                      className="absolute -top-1.5 -right-1.5 size-5 rounded-full bg-slate-800 hover:bg-rose-600 text-slate-300 hover:text-white flex items-center justify-center text-xs shadow-md cursor-pointer transition-colors border border-slate-700/60"
                      title="Remover do pedido"
                      aria-label="Remover anexo"
                    >
                      ✕
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Hidden File Input */}
        <input
          ref={inputRef}
          type="file"
          className="sr-only"
          accept="image/png,image/jpeg,image/webp"
          multiple
          disabled={uploading || sending || blocked || Boolean(activeRun) || assets.length + staged.length >= 20}
          onChange={(event) => {
            if (event.target.files) stageFiles(event.target.files);
            event.target.value = "";
          }}
        />

        {/* Seamless Textarea */}
        <div className="px-3 pt-2">
          <textarea
            id="site-prompt"
            rows={2}
            maxLength={16000}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onPaste={handlePaste}
            placeholder={
              staged.length > 0 || selected.length > 0
                ? "Descreva o que fazer com a imagem (ex: 'essa é a logo, use no topo e adapte as cores')..."
                : "Descreva o que deseja no site (cole imagens com Ctrl+V ou clique em 📎)..."
            }
            disabled={sending}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            className="w-full bg-transparent text-sm text-slate-100 placeholder:text-slate-400/70 resize-none outline-none focus:outline-none"
          />
        </div>

        {/* Bottom Toolbar */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-2.5 pt-1 border-t border-slate-800/40">
          <div className="flex items-center gap-1.5">
            {/* Attach button */}
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={sending || uploading || blocked || Boolean(activeRun) || assets.length + staged.length >= 20}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-slate-300 hover:text-white bg-slate-800/70 hover:bg-slate-700/80 border border-slate-700/60 transition-all cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed shadow-2xs"
              title="Anexar imagem (PNG, JPEG ou WEBP, até 8 MB)"
            >
              <Paperclip className="size-3.5 text-primary" aria-hidden="true" />
              <span>Anexar</span>
              {staged.length + selected.length > 0 && (
                <span className="rounded-full bg-primary/25 px-1.5 py-0.2 text-[10px] font-bold text-primary">
                  {staged.length + selected.length}
                </span>
              )}
            </button>

            {/* Gallery button */}
            {assets.length > 0 && (
              <button
                type="button"
                onClick={() => setGalleryOpen((prev) => !prev)}
                className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer border ${
                  galleryOpen
                    ? "bg-primary/20 text-primary border-primary/40 font-semibold"
                    : "text-slate-400 hover:text-slate-200 bg-slate-800/40 hover:bg-slate-700/50 border-slate-700/40"
                }`}
                title="Explorar e reutilizar imagens já enviadas neste projeto"
              >
                <ImageIcon className="size-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">Galeria</span> ({assets.length})
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="submit"
              size="sm"
              disabled={sending || uploading || blocked || Boolean(activeRun) || (!prompt.trim() && staged.length === 0 && selected.length === 0)}
              className="rounded-full gap-1.5 font-medium px-4 h-8 cursor-pointer shadow-md"
            >
              {sending || uploading ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                  <span>{uploading ? "Enviando..." : "Gerando..."}</span>
                </>
              ) : (
                <>
                  <span>Enviar</span>
                  <Send className="size-3.5" aria-hidden="true" />
                </>
              )}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
