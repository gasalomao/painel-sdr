"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { formatRelative } from "@/lib/sites/ui-helpers";
import { siteDraftScope, useDraftUnloadWarning, useSiteDraft, useSiteIdentity } from "@/lib/sites/ui";
import type { WebsiteModel, WebsiteSettings } from "@/lib/sites/types";
import type { WebsitePromptVersion } from "@/lib/sites/prompts";
import { apiJson, errorMessage, jsonBody, selectClass } from "./api";

type SettingsResponse = {
  settings: WebsiteSettings; isAdmin: boolean; promptVersions: WebsitePromptVersion[];
  integrations: Record<string, { configured: boolean; settingsUrl: string }>;
};
const LIMITS = [
  ["max_sites", "Sites", 1000], ["max_runs_per_day", "Execuções por dia", 1000],
  ["max_builds_per_day", "Validações por dia", 500], ["max_deploys_per_day", "Publicações por dia", 200],
  ["max_storage_mb", "Armazenamento (MB)", 102400], ["max_images_per_day", "Imagens por dia", 100],
  ["max_tokens_per_month", "Tokens por mês", 100000000],
] as const;
const INTEGRATION_LABELS = { openrouter: "OpenRouter", worker: "Worker", e2b: "Sandbox E2B", cloudflare: "Cloudflare" } as Record<string, string>;

function Integrations({ integrations }: { integrations: Record<string, { configured: boolean; settingsUrl: string }> }): React.JSX.Element {
  return <section className="space-y-3"><h2 className="text-lg font-semibold">Integrações</h2><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{Object.entries(integrations).map(([name, integration]) => <div key={name} className="rounded-lg border border-border p-4"><h3 className="font-medium">{INTEGRATION_LABELS[name] ?? name}</h3><p className="my-2 text-sm text-muted-foreground">{integration.configured ? "Configuração detectada" : "Configuração pendente"}</p><Link href={integration.settingsUrl} className="text-sm text-primary underline">Configurar integração</Link></div>)}</div><p className="text-xs text-muted-foreground">Presença de configuração não garante conectividade. Credenciais permanecem no servidor e não são exibidas aqui.</p></section>;
}

export function SitesSettings(): React.JSX.Element {
  const { identity, failed, retry } = useSiteIdentity();
  const scope = siteDraftScope(identity, "global-settings");
  if (failed) return <div role="alert" className="space-y-2 p-6"><p>Não foi possível confirmar o acesso. Tente novamente.</p><Button variant="outline" onClick={retry}>Tentar novamente</Button></div>;
  if (!scope) return <p role="status">Confirmando acesso às configurações...</p>;
  return <SettingsEditor key={scope} draftScope={scope} />;
}

function SettingsEditor({ draftScope }: { draftScope: string }): React.JSX.Element {
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState("");
  const [settingsDraft, setSettingsDraft] = useSiteDraft(draftScope, "settings");
  const draft = settingsDraft?.values ?? null;
  const prompt = settingsDraft?.prompt ?? null;
  const allowlist = settingsDraft?.allowlist ?? null;
  function setDraft(values: WebsiteSettings | null): void { setSettingsDraft((prev) => ({ prompt: prev?.prompt ?? null, allowlist: prev?.allowlist ?? null, values })); }
  function setPrompt(value: string | null): void { setSettingsDraft((prev) => ({ values: prev?.values ?? null, allowlist: prev?.allowlist ?? null, prompt: value })); }
  function setAllowlist(value: string | null): void { setSettingsDraft((prev) => ({ values: prev?.values ?? null, prompt: prev?.prompt ?? null, allowlist: value })); }
  const [models, setModels] = useState<WebsiteModel[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const dirty = Boolean(draft || prompt !== null || allowlist !== null);
  useDraftUnloadWarning(dirty);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    try {
      const response = await apiJson<SettingsResponse>("/api/sites/settings", { signal });
      if (signal?.aborted) return;
      setData(response); setError("");
      if (!response.isAdmin) return;
      setModelsLoading(true);
      try {
        const catalogue = await apiJson<{ models: WebsiteModel[] }>("/api/sites/models?refresh=true&all=true", { signal });
        if (!signal?.aborted) setModels(catalogue.models);
      } finally {
        if (!signal?.aborted) setModelsLoading(false);
      }
    } catch (err) { if (!signal?.aborted) { setError(errorMessage(err)); toast.error(errorMessage(err)); } }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!data?.isAdmin || busy) return;
    const values = draft ?? data.settings;
    const ids = (allowlist ?? values.model_allowlist.join("\n")).split(/[\n,]/).map((id) => id.trim()).filter(Boolean);
    if (ids.length > 100 || ids.some((id) => !/^[a-zA-Z0-9][a-zA-Z0-9/_.:+-]{0,199}$/.test(id))) {
      toast.error("Informe até 100 IDs de modelos válidos, separados por linha."); return;
    }
    setBusy(true);
    try {
      const { creative_prompt: creativePrompt, ...settings } = values;
      const response = await apiJson<{ settings: WebsiteSettings }>("/api/sites/settings", jsonBody({ ...settings, model_allowlist: ids }, "PATCH"));
      setData((prev) => prev ? { ...prev, settings: { ...response.settings, creative_prompt: response.settings.creative_prompt ?? creativePrompt } } : prev);
      setDraft(null); setAllowlist(null); toast.success("Configurações salvas.");
      await load();
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  }

  async function promptOperation(body: Record<string, unknown>, successMessage: string): Promise<void> {
    if (!data?.isAdmin || busy) return;
    setBusy(true);
    try {
      const { promptVersion } = await apiJson<{ promptVersion: WebsitePromptVersion }>("/api/sites/settings/prompts", jsonBody(body));
      setData((prev) => prev ? { ...prev, settings: { ...prev.settings, creative_prompt: promptVersion.prompt }, promptVersions: [promptVersion, ...prev.promptVersions] } : prev);
      setPrompt(null); toast.success(successMessage);
    } catch (err) { toast.error(errorMessage(err)); }
    finally { setBusy(false); }
  }

  if (!data) return <div role={error ? "alert" : "status"} className="space-y-3">{error || "Carregando configurações..."}{error && <Button variant="outline" onClick={() => void load()}>Tentar novamente</Button>}</div>;
  if (!data.isAdmin) return <div className="space-y-8">
    <section className="space-y-3 rounded-xl border border-border p-6"><h2 className="font-semibold">Configurações globais são exclusivas do administrador</h2><p className="text-sm text-muted-foreground">Limites globais, prompt criativo e integrações são administrados pelo administrador da plataforma. As configurações de cada site (contexto, modelo, CTA e skills) ficam no painel do projeto, disponíveis para você.</p><Link href="/sites" className="text-primary underline">Ir para Meus Sites e abrir os ajustes de um projeto</Link></section>
    <Integrations integrations={data.integrations} />
  </div>;
  const values = draft ?? data.settings;
  const promptValue = prompt ?? data.settings.creative_prompt;
  function change(patch: Partial<WebsiteSettings>): void { setDraft({ ...(draft ?? values), ...patch }); }

  return <div className="space-y-8">
    {error && <div role="alert" className="flex flex-wrap items-center gap-3 text-sm"><p>{error}</p><Button variant="outline" disabled={busy} onClick={() => void load()}>Atualizar integrações e modelos</Button></div>}
    <Integrations integrations={data.integrations} />
    <form onSubmit={(event) => void save(event)} className="space-y-5 rounded-xl border border-border p-4 sm:p-6">
      <h2 className="text-lg font-semibold">Limites e modelos globais</h2>
      <fieldset disabled={busy} className="space-y-5">
        <legend className="sr-only">Configuração global do Site Studio</legend>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{LIMITS.map(([key, label, max]) => <label key={key} className="block space-y-1 text-sm">{label}<Input type="number" required min={0} max={max} step={1} value={Number.isNaN(values[key]) ? "" : values[key]} onChange={(event) => change({ [key]: event.target.valueAsNumber })} /></label>)}</div>
        <div className="grid gap-4 sm:grid-cols-2">
          {(["quality_model", "economy_model"] as const).map((key) => {
            const openRouterFree = models.filter((m) => m.supportsTools && m.isFree && (!m.provider || m.provider === "openrouter"));
            const gatewayModels = models.filter((m) => m.supportsTools && (m.provider === "gateway" || m.id.startsWith("gateway:")));
            const geminiModels = models.filter((m) => m.supportsTools && (m.provider === "gemini" || m.id.startsWith("gemini:")));
            const openRouterPaid = models.filter((m) => m.supportsTools && !m.isFree && !m.id.startsWith("gateway:") && !m.id.startsWith("gemini:"));

            return (
              <label key={key} className="space-y-1 text-sm">
                <span className="flex items-center justify-between">
                  <span>{key === "quality_model" ? "Modelo de qualidade" : "Modelo econômico"}</span>
                  {modelsLoading && <span className="text-xs text-muted-foreground animate-pulse">Sincronizando modelos...</span>}
                </span>
                <select className={selectClass} value={values[key]} onChange={(event) => change({ [key]: event.target.value })}>
                  <option value="">Seleção automática do servidor</option>
                  {values[key] && !models.some((model) => model.id === values[key]) && (
                    <option value={values[key]}>{values[key]} (fora do catálogo atual)</option>
                  )}
                  {openRouterFree.length > 0 && (
                    <optgroup label="⭐ OpenRouter (Gratuitos)">
                      {openRouterFree.map((model) => (
                        <option key={model.id} value={model.id}>{model.name}</option>
                      ))}
                    </optgroup>
                  )}
                  {gatewayModels.length > 0 && (
                    <optgroup label="🔑 Gateway de Assinatura (Contas Conectadas)">
                      {gatewayModels.map((model) => (
                        <option key={model.id} value={model.id}>{model.name}</option>
                      ))}
                    </optgroup>
                  )}
                  {geminiModels.length > 0 && (
                    <optgroup label="✨ Google Gemini">
                      {geminiModels.map((model) => (
                        <option key={model.id} value={model.id}>{model.name}</option>
                      ))}
                    </optgroup>
                  )}
                  {openRouterPaid.length > 0 && (
                    <optgroup label="🌐 OpenRouter (Geral)">
                      {openRouterPaid.map((model) => (
                        <option key={model.id} value={model.id}>{model.name}</option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">Catálogo atualizado em tempo real: modelos gratuitos do OpenRouter no topo, Gateway de assinatura e Google Gemini.</p>
        <label className="block space-y-1 text-sm">Modelos permitidos (um ID por linha)<Textarea rows={4} value={allowlist ?? values.model_allowlist.join("\n")} onChange={(event) => setAllowlist(event.target.value)} /><span className="text-xs text-muted-foreground">Vazio mantém a política padrão do servidor. O catálogo atual já é filtrado por esta lista.</span></label>
        <label className="flex items-center gap-2 text-sm"><input className="size-4 accent-primary" type="checkbox" checked={values.image_generation_enabled} onChange={(event) => change({ image_generation_enabled: event.target.checked })} />Permitir geração de imagens</label>
        <label className="block space-y-1 text-sm">ID do modelo de imagens<Input maxLength={200} pattern="[a-zA-Z0-9][a-zA-Z0-9\/_.:+\-]{0,199}" value={values.image_model} onChange={(event) => change({ image_model: event.target.value })} /><span className="text-xs text-muted-foreground">O catálogo de código não informa modelos de geração de imagens. Use um ID confirmado pelo provedor.</span></label>
        <label className="block space-y-1 text-sm">Domínio base<Input maxLength={253} value={values.base_domain} onChange={(event) => change({ base_domain: event.target.value.trim() })} placeholder="sites.suaempresa.com.br" /><span className="text-xs text-muted-foreground">Somente o domínio, sem protocolo ou caminho.</span></label>
      </fieldset>
      <Button type="submit" disabled={busy || (!draft && allowlist === null)}>{busy ? "Salvando..." : "Salvar configurações"}</Button>
    </form>
    <section className="space-y-4 rounded-xl border border-border p-4 sm:p-6"><h2 className="text-lg font-semibold">Prompt criativo global</h2><p className="text-sm text-muted-foreground">A direção criativa não substitui as regras de segurança do agente. Cada salvamento cria uma versão nova.</p>
      <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void promptOperation({ prompt: promptValue }, "Nova versão do prompt salva."); }}>
        <label className="block space-y-1 text-sm">Instruções criativas<Textarea required maxLength={12000} rows={10} disabled={busy} value={promptValue} onChange={(event) => setPrompt(event.target.value)} /></label>
        <div className="flex flex-wrap gap-2"><Button type="submit" disabled={busy || !promptValue.trim() || promptValue === data.settings.creative_prompt}>Salvar nova versão</Button><Button type="button" variant="outline" disabled={busy || prompt === null} onClick={() => setPrompt(null)}>Descartar edições</Button><Button type="button" variant="outline" disabled={busy} onClick={() => { if (window.confirm("Criar uma nova versão com o prompt padrão do servidor? O histórico será preservado.")) void promptOperation({ reset: true }, "Prompt restaurado ao padrão do servidor."); }}>Restaurar padrão</Button></div>
      </form>
      <h3 className="font-medium">Histórico do prompt</h3>{data.promptVersions.length === 0 ? <p className="text-sm text-muted-foreground">Nenhuma versão personalizada salva.</p> : <ul className="space-y-3">{data.promptVersions.map((version) => <li key={version.id} className="rounded-lg border border-border p-3"><details><summary className="cursor-pointer text-sm">Versão {version.version} · {formatRelative(version.created_at)}</summary><p className="mt-3 whitespace-pre-wrap break-words text-sm text-muted-foreground">{version.prompt}</p></details><Button className="mt-3" size="sm" variant="outline" disabled={busy || version.prompt === data.settings.creative_prompt} onClick={() => { if (window.confirm("Restaurar esta versão como a versão atual? Uma nova versão será criada e o histórico será preservado.")) void promptOperation({ restore_version_id: version.id }, "Versão restaurada como nova."); }}>Restaurar esta versão</Button></li>)}</ul>}
    </section>
  </div>;
}
