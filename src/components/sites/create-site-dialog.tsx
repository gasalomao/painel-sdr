"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Bot, Sparkles } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { CLIENT_FIELDS, matchesModelFilters, modelPriceLabel } from "@/lib/sites/ui-helpers";
import type { WebsiteLead } from "@/lib/sites/repository";
import type { ModelMode, WebsiteClientContext, WebsiteModel, WebsiteProject } from "@/lib/sites/types";
import { apiJson, errorMessage, jsonBody, selectClass } from "./api";

export function CreateSiteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }): React.JSX.Element {
  const router = useRouter();
  const [mode, setMode] = useState("blank");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [briefing, setBriefing] = useState("");
  const [query, setQuery] = useState("");
  const [leads, setLeads] = useState<WebsiteLead[] | null>(null);
  const [leadId, setLeadId] = useState("");
  const [context, setContext] = useState<WebsiteClientContext>({});
  const [confirmed, setConfirmed] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  const [leadError, setLeadError] = useState(false);

  // Model selection state
  const [modelMode, setModelMode] = useState<ModelMode>("auto");
  const [modelId, setModelId] = useState<string>("");
  const [models, setModels] = useState<WebsiteModel[] | null>(null);
  const [modelError, setModelError] = useState(false);
  const [toolsOnly, setToolsOnly] = useState(false);
  const [visionOnly, setVisionOnly] = useState(false);

  const loadModels = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const data = await apiJson<{ models: WebsiteModel[] }>("/api/sites/models", { signal });
      if (!signal?.aborted) {
        setModels(data.models);
        setModelError(false);
      }
    } catch (error) {
      if (!signal?.aborted) {
        setModelError(true);
        toast.error(errorMessage(error));
      }
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void loadModels(controller.signal);
    return () => controller.abort();
  }, [open, loadModels]);

  useEffect(() => {
    if (mode !== "lead" || !open) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setLeads(null);
      setLeadError(false);
      try {
        const data = await apiJson<{ leads: WebsiteLead[] }>(`/api/sites/leads?q=${encodeURIComponent(query)}`, { signal: controller.signal });
        if (!controller.signal.aborted) setLeads(data.leads);
      } catch (error) {
        if (!controller.signal.aborted) { setLeads([]); setLeadError(true); toast.error(errorMessage(error)); }
      }
    }, 300);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [mode, query, open]);

  function chooseLead(id: string): void {
    const lead = leads?.find((item) => String(item.id) === id);
    setLeadId(id);
    setConfirmed([]);
    setContext(lead ? {
      name: lead.nome_negocio ?? "", segment: lead.ramo_negocio || lead.categoria || "",
      phone: lead.telefone ?? "", website: lead.website ?? "", address: lead.endereco ?? "",
    } : {});
  }

  const selectedModel = models?.find((model) => model.id === modelId);
  const filteredModels = models?.filter((model) => matchesModelFilters(model, toolsOnly, visionOnly)) ?? [];

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (creating || !name.trim() || !briefing.trim()) return;

    if (modelMode === "manual" && !models?.some((m) => m.id === modelId)) {
      toast.error("Selecione um modelo disponível.");
      return;
    }

    setCreating(true);
    try {
      const clientContext = Object.fromEntries(Object.entries(context).filter(([key, value]) => confirmed.includes(key) && value?.trim()));
      const data = await apiJson<{ project: WebsiteProject }>("/api/sites", jsonBody({
        name: name.trim(),
        ...(slug.trim() ? { slug: slug.trim() } : {}),
        client_context: clientContext,
        ...(mode === "lead" ? { lead_id: Number(leadId) } : {}),
        model_mode: modelMode,
        ...(modelMode === "manual" && modelId ? { model_id: modelId } : {}),
      }));
      try {
        await apiJson(`/api/sites/${data.project.id}/runs`, jsonBody({
          prompt: briefing.trim(),
          ...(modelMode === "manual" && modelId ? { model_id: modelId } : {}),
          asset_ids: [],
        }));
      } catch {
        toast.error("Rascunho criado, mas a geração falhou. Tente novamente pelo chat deste projeto.");
      }
      onOpenChange(false);
      router.push(`/sites/${data.project.id}`);
    } catch (error) { toast.error(errorMessage(error)); }
    finally { setCreating(false); }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!creating) onOpenChange(next); }}>
      <DialogContent showCloseButton={false} className="max-h-[85vh] sm:max-w-xl flex flex-col p-0 gap-0 overflow-hidden shadow-2xl">
        <DialogHeader className="px-6 pt-5 pb-3 border-b border-border/40 shrink-0">
          <DialogTitle className="text-lg font-semibold">Criar novo site</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            Configure as informações iniciais e o modelo de IA que construirá o site.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col flex-1 min-h-0 overflow-hidden">
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4 min-h-0">
            <fieldset disabled={creating} className="space-y-4">
              <legend className="sr-only">Dados do novo site</legend>

              {/* Origem */}
              <label className="block space-y-1 text-sm font-medium">Origem
                <select className={selectClass} value={mode} onChange={(event) => { setMode(event.target.value); setLeadId(""); setContext({}); setConfirmed([]); }}>
                  <option value="blank">Do zero</option>
                  <option value="lead">A partir de um cliente/lead</option>
                </select>
              </label>

              {/* Busca de Lead (quando aplicável) */}
              {mode === "lead" && (
                <div className="space-y-2 rounded-lg border border-border/50 bg-secondary/20 p-3">
                  <label className="block space-y-1 text-sm">Buscar cliente/lead
                    <Input value={query} maxLength={120} onChange={(event) => { setQuery(event.target.value); chooseLead(""); }} placeholder="Nome do negócio" />
                  </label>
                  <label className="block space-y-1 text-sm">Cliente/lead
                    <select required className={selectClass} value={leadId} onChange={(event) => chooseLead(event.target.value)} disabled={!leads}>
                      <option value="">{leads === null ? "Carregando..." : "Selecione um cliente/lead"}</option>
                      {leads?.map((lead) => <option key={lead.id} value={lead.id}>{lead.nome_negocio || `Lead ${lead.id}`}</option>)}
                    </select>
                  </label>
                  {leadError ? <p role="alert" className="text-sm text-destructive">Não foi possível buscar os clientes. Tente novamente.</p> : leads?.length === 0 && <p className="text-sm text-muted-foreground">Nenhum cliente encontrado.</p>}
                </div>
              )}

              {/* Nome e Slug */}
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="space-y-1 text-sm font-medium">Nome do projeto
                  <Input required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="Ex: Padaria Central" />
                </label>
                <label className="space-y-1 text-sm font-medium">Slug (opcional)
                  <Input maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={slug} onChange={(event) => setSlug(event.target.value)} placeholder="padaria-central" />
                  <span className="text-[11px] text-muted-foreground block">Letras minúsculas, números e hífens.</span>
                </label>
              </div>

              <div className="space-y-1">
                <label htmlFor="create-site-briefing" className="text-sm font-medium">Descreva o site (obrigatório)</label>
                <Textarea
                  id="create-site-briefing"
                  required
                  aria-required="true"
                  aria-describedby="create-site-briefing-help"
                  rows={4}
                  maxLength={16000}
                  value={briefing}
                  onChange={(event) => setBriefing(event.target.value)}
                  placeholder="Descreva o negócio, as páginas, o estilo visual e o que o visitante deve fazer."
                />
                <div className="flex flex-wrap items-center justify-between gap-1 text-xs text-muted-foreground">
                  <p id="create-site-briefing-help">A geração começa após criar o projeto. Use somente informações confirmadas.</p>
                  <span className="inline-flex items-center gap-1 text-[11px] text-primary font-medium" title="Sites construídos do zero com direção de arte exclusiva (pbakaus/impeccable)">
                    <Sparkles className="size-3 text-primary" aria-hidden="true" />
                    Impeccable Design Ativo
                  </span>
                </div>
              </div>

              {/* Modelo de Inteligência Artificial */}
              <div className="space-y-3 rounded-lg border border-border/70 bg-card/60 p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <label htmlFor="create-site-model-select" className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                    <Bot className="size-4 text-primary" aria-hidden="true" />
                    Modelo de Inteligência Artificial
                  </label>
                  <div className="flex items-center gap-3 text-xs">
                    <span className="text-[11px] text-muted-foreground">Filtros:</span>
                    <label className="flex items-center gap-1 cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
                      <input
                        type="checkbox"
                        className="size-3 rounded accent-primary"
                        checked={toolsOnly}
                        onChange={(e) => setToolsOnly(e.target.checked)}
                      />
                      <span>Ferramentas</span>
                    </label>
                    <label className="flex items-center gap-1 cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
                      <input
                        type="checkbox"
                        className="size-3 rounded accent-primary"
                        checked={visionOnly}
                        onChange={(e) => setVisionOnly(e.target.checked)}
                      />
                      <span>Visão</span>
                    </label>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <select
                    id="create-site-model-select"
                    style={{ colorScheme: "dark" }}
                    className={selectClass}
                    value={modelMode === "manual" ? (modelId || "") : modelMode}
                    onChange={(event) => {
                      const val = event.target.value;
                      if (val === "auto" || val === "quality" || val === "economy") {
                        setModelMode(val as ModelMode);
                        setModelId("");
                      } else {
                        setModelMode("manual");
                        setModelId(val);
                      }
                    }}
                  >
                    <optgroup className="bg-[#0f172a] text-primary font-bold" label="Modos Automáticos">
                      <option className="bg-[#0f172a] text-slate-100" value="auto">Automático (Recomendado — IA seleciona o melhor modelo)</option>
                      <option className="bg-[#0f172a] text-slate-100" value="quality">Alta Qualidade (Prioriza modelos premium e maior contexto)</option>
                      <option className="bg-[#0f172a] text-slate-100" value="economy">Econômico (Prioriza menor consumo de tokens)</option>
                    </optgroup>

                    {modelId && modelMode === "manual" && !filteredModels.some((m) => m.id === modelId) && (
                      <option className="bg-[#0f172a] text-slate-100" disabled value={modelId}>
                        {selectedModel?.name ?? modelId} ({selectedModel ? "fora do filtro" : "indisponível"})
                      </option>
                    )}

                    {filteredModels.some((m) => m.id.startsWith("nvidia:")) && (
                      <optgroup className="bg-[#0f172a] text-emerald-400 font-bold" label="⚡ NVIDIA NIM">
                        {filteredModels
                          .filter((m) => m.id.startsWith("nvidia:"))
                          .sort((a, b) => {
                            const aNemo = a.name.toLowerCase().includes("nemotron");
                            const bNemo = b.name.toLowerCase().includes("nemotron");
                            if (aNemo && !bNemo) return -1;
                            if (!aNemo && bNemo) return 1;
                            return a.name.localeCompare(b.name);
                          })
                          .map((model) => (
                            <option className="bg-[#0f172a] text-slate-100" key={model.id} value={model.id} disabled={model.id.length > 160}>
                              {model.name}
                            </option>
                          ))}
                      </optgroup>
                    )}

                    {filteredModels.some((m) => m.isFree && !m.id.startsWith("gemini:") && !m.id.startsWith("gateway:") && !m.id.startsWith("nvidia:")) && (
                      <optgroup className="bg-[#0f172a] text-amber-400 font-bold" label="⭐ OpenRouter (Gratuitos)">
                        {filteredModels
                          .filter((m) => m.isFree && !m.id.startsWith("gemini:") && !m.id.startsWith("gateway:") && !m.id.startsWith("nvidia:"))
                          .sort((a, b) => a.name.localeCompare(b.name))
                          .map((model) => (
                            <option className="bg-[#0f172a] text-slate-100" key={model.id} value={model.id} disabled={model.id.length > 160}>
                              {model.name}
                            </option>
                          ))}
                      </optgroup>
                    )}

                    {filteredModels.some((m) => m.id.startsWith("gateway:")) && (
                      <optgroup className="bg-[#0f172a] text-blue-400 font-bold" label="🔑 Gateway de Assinatura (Contas Conectadas)">
                        {filteredModels
                          .filter((m) => m.id.startsWith("gateway:"))
                          .sort((a, b) => a.name.localeCompare(b.name))
                          .map((model) => (
                            <option className="bg-[#0f172a] text-slate-100" key={model.id} value={model.id} disabled={model.id.length > 160}>
                              {model.name}
                            </option>
                          ))}
                      </optgroup>
                    )}

                    {filteredModels.some((m) => m.id.startsWith("gemini:")) && (
                      <optgroup className="bg-[#0f172a] text-cyan-400 font-bold" label="✨ Google Gemini">
                        {filteredModels
                          .filter((m) => m.id.startsWith("gemini:"))
                          .sort((a, b) => a.name.localeCompare(b.name))
                          .map((model) => (
                            <option className="bg-[#0f172a] text-slate-100" key={model.id} value={model.id} disabled={model.id.length > 160}>
                              {model.name}
                            </option>
                          ))}
                      </optgroup>
                    )}

                    {filteredModels.some((m) => !m.isFree && !m.id.startsWith("gemini:") && !m.id.startsWith("gateway:") && !m.id.startsWith("nvidia:")) && (
                      <optgroup className="bg-[#0f172a] text-purple-400 font-bold" label="🌐 OpenRouter (Geral)">
                        {filteredModels
                          .filter((m) => !m.isFree && !m.id.startsWith("gemini:") && !m.id.startsWith("gateway:") && !m.id.startsWith("nvidia:"))
                          .sort((a, b) => a.name.localeCompare(b.name))
                          .map((model) => (
                            <option className="bg-[#0f172a] text-slate-100" key={model.id} value={model.id} disabled={model.id.length > 160}>
                              {model.name}
                            </option>
                          ))}
                      </optgroup>
                    )}
                  </select>

                  {modelMode !== "manual" ? (
                    <p className="text-[11px] text-muted-foreground pt-1">
                      {modelMode === "auto" && "O sistema seleciona o melhor modelo disponível com suporte a ferramentas, aplicando fallbacks automáticos se necessário."}
                      {modelMode === "quality" && "Usa o modelo configurado para máxima precisão técnica, estruturação de layout e fidelidade de conteúdo."}
                      {modelMode === "economy" && "Usa o modelo configurado para respostas rápidas e consumo ultra-eficiente de créditos."}
                    </p>
                  ) : selectedModel ? (
                    <div className="rounded-md bg-secondary/50 p-2.5 space-y-1 text-xs text-muted-foreground mt-2">
                      <div className="flex items-center justify-between font-medium text-foreground">
                        <span>{selectedModel.name}</span>
                        {selectedModel.contextLength && (
                          <span>Contexto: {selectedModel.contextLength.toLocaleString("pt-BR")} tokens</span>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                        <span>Ferramentas: {selectedModel.supportsTools ? "✓ Suportado" : "✗ Indisponível"}</span>
                        <span>Visão: {selectedModel.inputModalities?.includes("image") ? "✓ Suportado" : "Não informada"}</span>
                      </div>
                      {modelPriceLabel(selectedModel) && (
                        <p className="text-[11px] text-primary/90 font-medium">
                          Preço: {modelPriceLabel(selectedModel)}
                        </p>
                      )}
                    </div>
                  ) : null}

                  {modelError && (
                    <div className="flex items-center justify-between gap-2 text-xs text-destructive pt-1">
                      <span>Não foi possível carregar os modelos.</span>
                      <Button type="button" size="sm" variant="outline" onClick={() => void loadModels()}>
                        Recarregar
                      </Button>
                    </div>
                  )}
                  {models !== null && filteredModels.length === 0 && (
                    <p role="status" className="text-xs text-muted-foreground pt-1">
                      Nenhum modelo corresponde aos filtros ativos.
                    </p>
                  )}
                </div>
              </div>

              {/* Contexto confirmado */}
              {(mode === "blank" || leadId) && (
                <details
                  open={Boolean(leadId)}
                  className="rounded-lg border border-border/70 p-3 space-y-3 group"
                >
                  <summary className="cursor-pointer font-medium text-xs text-foreground flex items-center justify-between select-none">
                    <span>
                      Contexto confirmado {confirmed.length > 0 && <span className="text-primary font-semibold">({confirmed.length} confirmado{confirmed.length > 1 ? "s" : ""})</span>}
                    </span>
                    <span className="text-[11px] text-muted-foreground group-open:hidden">Clique para expandir</span>
                  </summary>
                  <p className="text-xs text-muted-foreground">
                    Confira os valores e marque cada dado autorizado. Dados ausentes podem ser preenchidos; telefone não é presumido como WhatsApp.
                  </p>
                  <div className="space-y-2.5 pt-1">
                    {CLIENT_FIELDS.map(([key, label]) => (
                      <div key={key} className="flex items-center gap-3">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary shrink-0"
                          aria-label={`Confirmar ${label}`}
                          checked={confirmed.includes(key)}
                          disabled={!context[key]?.trim()}
                          onChange={(event) => setConfirmed((prev) => event.target.checked ? [...prev, key] : prev.filter((item) => item !== key))}
                        />
                        <label className="flex-1 space-y-1 text-xs">
                          {label}
                          <Input
                            maxLength={4000}
                            value={context[key] ?? ""}
                            onChange={(event) => {
                              setContext((prev) => ({ ...prev, [key]: event.target.value }));
                              setConfirmed((prev) => prev.filter((item) => item !== key));
                            }}
                          />
                        </label>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </fieldset>
          </div>

          <DialogFooter className="m-0 px-6 py-3 border-t border-border/40 bg-muted/30 flex flex-row items-center justify-end gap-2 shrink-0 rounded-b-xl">
            <Button type="button" variant="outline" disabled={creating} onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button
              type="submit"
              disabled={creating || !name.trim() || !briefing.trim() || (mode === "lead" && !leadId) || (modelMode === "manual" && !modelId)}
            >
              {creating ? "Criando e enfileirando..." : "Criar e gerar site"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
