"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SandpackProvider, SandpackPreview, SandpackLayout, useSandpack, type SandpackFiles, type SandpackPreviewRef } from "@codesandbox/sandpack-react";
import { Lock, Maximize2, Minimize2, Monitor, RotateCw, Smartphone, Tablet, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiJson } from "./api";
import { resolveWebsitePreviewAssets } from "@/lib/sites/asset-preview";
import type { WebsiteAsset, WebsiteProject, WebsiteFiles } from "@/lib/sites/types";
import { WEBSITE_FIXED_FILES } from "@/lib/sites/starter";

export const VIEWPORTS = [
  { id: "desktop", label: "Desktop", width: 1440, height: 900, icon: Monitor },
  { id: "tablet", label: "Tablet", width: 768, height: 1024, icon: Tablet },
  { id: "mobile", label: "Mobile", width: 390, height: 844, icon: Smartphone },
] as const;

export const SITE_PREVIEW_SETUP = { environment: "create-react-app", entry: "/index.tsx" } as const;

export function getSitePreviewFiles(source: WebsiteFiles, assets: readonly WebsiteAsset[] = [], project?: Pick<WebsiteProject, "id" | "client_id">, candidate?: { id: string; origin: string }): SandpackFiles {
  const files = project ? resolveWebsitePreviewAssets(source, assets, project) : source;
  const result: SandpackFiles = {};
  for (const [path, code] of Object.entries(files)) {
    const normalized = path.replace(/^\//, "");
    if (typeof code !== "string" || code.includes("\0") || normalized.split("/").some((part) => !part || part === "." || part === "..")) continue;
    if (normalized.startsWith("src/") || normalized.startsWith("public/")) {
      let previewCode = code;
      // Auto-sanitize HTML comments in JSX/TSX to prevent fatal Babel SyntaxErrors
      if (/\.(tsx|jsx)$/.test(normalized)) {
        previewCode = previewCode.replace(/<!--([\s\S]*?)-->/g, "{/*$1*/}");
      }
      result[`/${normalized}`] = { code: previewCode };
    }
  }
  const html = files["index.html"] === undefined ? files["/index.html"] ?? "" : files["index.html"];
  if (typeof html !== "string" || html.includes("\0")) throw new Error("HTML inválido para pré-visualização");
  result["/index.html"] = { code: html, hidden: true };
  result["/index.tsx"] = {
    code: `(() => {
const cleanupKey = Symbol.for("site-studio.preview.cleanup");
if (typeof window[cleanupKey] === "function") window[cleanupKey]();
const previewDocument = new DOMParser().parseFromString(${JSON.stringify(html)}, "text/html");
previewDocument.querySelectorAll("script").forEach((node) => node.remove());
document.documentElement.lang = previewDocument.documentElement.lang;
document.title = previewDocument.title;
const headNodes = Array.from(previewDocument.head.children);
document.head.append(...headNodes);
document.body.replaceChildren(...Array.from(previewDocument.body.childNodes));
let active = true;
let host;
let details;
let restoreProbe = () => {};
const candidate = ${JSON.stringify(candidate ?? null)};
const notify = (status, message) => {
  if (active && candidate) window.parent.postMessage({ type: "preview-candidate", id: candidate.id, status, ...(message ? { message } : {}) }, candidate.origin);
};
const showError = (error) => {
  if (!active) return;
  let message = "Falha de execução sem detalhes disponíveis.";
  try {
    const value = error && typeof error.message === "string" ? error.message : error;
    if (value !== null && value !== undefined && String(value).trim()) message = String(value).slice(0, 2000);
  } catch { /* Error objects can have throwing getters or conversions. */ }
  if (!host) {
    host = document.createElement("div");
    host.style.cssText = "position:fixed!important;inset:16px 16px auto!important;z-index:2147483647!important;display:block!important;";
    const shadow = host.attachShadow({ mode: "open" });
    const banner = document.createElement("div");
    banner.style.cssText = "padding:20px;font:14px system-ui,sans-serif;background:#fff1f0;color:#9f1239;border:1px solid #ffa39e;border-radius:8px;max-height:50vh;overflow:auto;";
    banner.setAttribute("role", "alert");
    const title = document.createElement("h3");
    title.textContent = "Erro na execução do site";
    details = document.createElement("pre");
    details.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;";
    banner.append(title, details);
    shadow.append(banner);
    document.body.prepend(host);
  }
  details.textContent = message;
  notify("failed", message);
};
const onError = (event) => showError(event.error ?? event.message);
const onRejection = (event) => showError(event.reason);
const hot = typeof module !== "undefined" ? module.hot : undefined;
const onStatus = (status) => {
  // Sandpack evaluates modules before its per-module apply notifications.
  if (!active || status !== "check") return;
  if (host) host.remove();
  host = undefined;
  details = undefined;
};
const cleanup = () => {
  active = false;
  restoreProbe();
  window.removeEventListener("error", onError);
  window.removeEventListener("unhandledrejection", onRejection);
  if (hot && typeof hot.removeStatusHandler === "function") hot.removeStatusHandler(onStatus);
  if (host) host.remove();
  headNodes.forEach((node) => node.remove());
  if (window[cleanupKey] === cleanup) delete window[cleanupKey];
};
window[cleanupKey] = cleanup;
window.addEventListener("error", onError);
window.addEventListener("unhandledrejection", onRejection);
if (hot) {
  if (typeof hot.addStatusHandler === "function") hot.addStatusHandler(onStatus);
  hot.dispose(cleanup);
}
try {
  if (candidate) {
    const React = require("react");
    const client = require("react-dom/client");
    const original = client.createRoot;
    let timer;
    let firstFrame;
    let secondFrame;
    const Probe = () => {
      React.useEffect(() => {
        timer = setTimeout(() => {
          firstFrame = requestAnimationFrame(() => {
            secondFrame = requestAnimationFrame(() => { if (!host) notify("ready"); });
          });
        }, 0);
        return () => { clearTimeout(timer); cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame); };
      }, []);
      return null;
    };
    const wrapped = (...args) => {
      const options = args[1] || {};
      const report = (name) => (error, info) => { showError(error); if (typeof options[name] === "function") options[name](error, info); };
      const root = original(args[0], { ...options, onUncaughtError: report("onUncaughtError") });
      const render = root.render.bind(root);
      root.render = (element) => render(React.createElement(React.Fragment, null, element, React.createElement(Probe)));
      return root;
    };
    client.createRoot = wrapped;
    if (client.createRoot !== wrapped) throw new Error("Entry React incompatível com a sonda de pré-visualização.");
    restoreProbe = () => {
      if (client.createRoot === wrapped) client.createRoot = original;
      clearTimeout(timer); cancelAnimationFrame(firstFrame); cancelAnimationFrame(secondFrame);
    };
  }
  require("./src/main.tsx");
} catch (error) {
  showError(error);
}
})();`,
    hidden: true,
  };
  const { dependencies } = JSON.parse(WEBSITE_FIXED_FILES["package.json"]) as { dependencies: Record<string, string> };
  result["/package.json"] = { code: JSON.stringify({ private: true, dependencies, main: "/index.tsx" }), hidden: true };
  return result;
}

function PreviewFrame({ candidateId, isPending, onResult }: { candidateId: string; isPending: boolean; onResult: (id: string, status: "ready" | "failed", message?: string) => void }): React.JSX.Element {
  const { sandpack } = useSandpack();
  const previewRef = useRef<SandpackPreviewRef>(null);
  const failed = Boolean(sandpack.error) || sandpack.status === "timeout";
  useEffect(() => {
    if (candidateId && failed) onResult?.(candidateId, "failed", String(sandpack.error?.message ?? "A pré-visualização excedeu o tempo limite.").slice(0, 2000));
  }, [candidateId, failed, sandpack.error, onResult]);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      const client = previewRef.current?.getClient();
      if (!client || event.source !== client.iframe.contentWindow || event.origin !== new URL(client.iframe.src).origin) return;
      const value = event.data;
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      const data = value as Record<string, unknown>;
      if (data.type !== "preview-candidate" || data.id !== candidateId || (data.status !== "ready" && data.status !== "failed")
        || Object.keys(data).some(key => !["type", "id", "status", "message"].includes(key))
        || data.message !== undefined && (typeof data.message !== "string" || data.message.length > 2000)) return;
      onResult(candidateId, data.status as "ready" | "failed", data.message as string | undefined);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [candidateId, onResult]);
  useEffect(() => {
    if (!isPending) return;
    let remaining = 60_000;
    let started = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pause = () => {
      if (timer === undefined) return;
      clearTimeout(timer); timer = undefined;
      remaining = Math.max(0, remaining - (performance.now() - started));
    };
    const resume = () => {
      pause();
      if (document.hidden) return;
      started = performance.now();
      timer = setTimeout(() => onResult(candidateId, "failed", "Não foi possível confirmar a montagem inicial do site. Corrija o entry ou recarregue."), remaining);
    };
    resume();
    document.addEventListener("visibilitychange", resume);
    return () => { pause(); document.removeEventListener("visibilitychange", resume); };
  }, [candidateId, isPending, onResult]);
  return (
    <div className="relative h-full w-full">
      <SandpackPreview
        ref={previewRef}
        style={{ height: "100%", width: "100%", minHeight: "100%", border: 0 }}
        showNavigator={false}
        showOpenInCodeSandbox={false}
        showRefreshButton={false}
        showRestartButton={false}
        showOpenNewtab={false}
        showSandpackErrorOverlay={false}
      />
      {failed && (
        <div
          role="alert"
          className="absolute inset-x-4 top-4 z-50 flex flex-col items-center justify-center rounded-lg border border-destructive/30 bg-background/95 p-4 text-center text-sm shadow-xl backdrop-blur text-foreground"
        >
          <p className="font-semibold text-destructive">Não foi possível carregar a pré-visualização completa.</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {sandpack.error?.message ? String(sandpack.error.message) : "Recarregue a página ou peça ao agente para corrigir o site."}
          </p>
        </div>
      )}
    </div>
  );
}

function RetainedPreview({ files, preparationError, reload }: { files: SandpackFiles | null; preparationError: string; reload: number }): React.JSX.Element {
  type Attempt = { id: string; version: string; files: SandpackFiles };
  const [state, setState] = useState<{ accepted: Attempt | null; pending: Attempt | null; requested: string; error: string }>({ accepted: null, pending: null, requested: "", error: "" });
  const version = JSON.stringify([files, reload]);
  const currentVersion = useRef(version);
  useLayoutEffect(() => { currentVersion.current = version; }, [version]);
  useEffect(() => {
    // Coalesce checkpoint updates at the next browser paint; never mutate the accepted runtime.
    const frame = requestAnimationFrame(() => setState(previous => {
      if (!files) return { ...previous, pending: null, requested: version, error: preparationError };
      if (previous.requested === version) return previous;
      if (previous.accepted?.version === version) return { ...previous, pending: null, requested: version, error: "" };
      const id = crypto.randomUUID();
      const entry = files["/index.tsx"];
      const code = typeof entry === "string" ? entry : entry.code;
      const marker = "const candidate = null;";
      const position = code.lastIndexOf(marker);
      if (position < 0) return { ...previous, pending: null, requested: version, error: "Bootstrap de pré-visualização incompatível." };
      const instrumented = code.slice(0, position) + `const candidate = ${JSON.stringify({ id, origin: window.location.origin })};` + code.slice(position + marker.length);
      return { ...previous, pending: { id, version, files: { ...files, "/index.tsx": { code: instrumented, hidden: true } } }, requested: version, error: "" };
    }));
    return () => cancelAnimationFrame(frame);
  }, [files, version, preparationError]);
  const onResult = useCallback((id: string, status: "ready" | "failed", message?: string) => {
    setState(previous => {
      if (previous.pending?.id !== id) {
        return status === "failed" && previous.accepted?.id === id ? { ...previous, error: message ?? "Falha após a montagem inicial do site." } : previous;
      }
      if (previous.pending.version !== currentVersion.current) return previous;
      if (status === "failed") return { ...previous, pending: null, error: message ?? "Falha na execução do site." };
      return { ...previous, accepted: previous.pending, pending: null, error: "" };
    });
  }, []);
  return <div className="relative h-full w-full">
    {[state.accepted, state.pending].filter((attempt): attempt is Attempt => Boolean(attempt)).map(attempt => {
      const pending = attempt.id === state.pending?.id;
      return <div key={attempt.id} data-preview-state={pending ? "pending" : "accepted"} aria-hidden={pending && Boolean(state.accepted)} inert={pending && Boolean(state.accepted)} className="absolute inset-0" style={{ opacity: pending && state.accepted ? 0 : 1, pointerEvents: pending ? "none" : "auto" }}>
        <SandpackProvider theme="dark" files={attempt.files} customSetup={SITE_PREVIEW_SETUP} options={{ initMode: "immediate", activeFile: "/src/App.tsx", classes: { "sp-wrapper": "!h-full !w-full !border-0 !bg-transparent", "sp-layout": "!h-full !w-full !border-0 !bg-transparent", "sp-preview": "!h-full !w-full !border-0 !bg-transparent", "sp-preview-container": "!h-full !w-full !border-0 !bg-transparent" } }}>
          <SandpackLayout style={{ height: "100%", width: "100%", border: 0, background: "transparent" }}>
            <PreviewFrame candidateId={attempt.id} isPending={pending} onResult={onResult} />
          </SandpackLayout>
        </SandpackProvider>
      </div>;
    })}
    {state.error && <div role="alert" className="absolute inset-x-4 top-4 z-50 rounded-lg border border-destructive/30 bg-background p-4 text-sm"><p className="font-semibold">Não foi possível carregar a pré-visualização completa.</p><p>{state.error}</p></div>}
    {state.pending && <p role="status" className="absolute bottom-2 left-2 rounded bg-background p-2 text-xs">Verificando montagem inicial do rascunho...</p>}
  </div>;
}

export function SitePreview({
  files,
  revisionId,
  projectSlug,
  projectScope,
}: {
  files: WebsiteFiles;
  revisionId: string | null;
  projectSlug?: string;
  projectName?: string;
  projectScope?: Pick<WebsiteProject, "id" | "client_id">;
}): React.JSX.Element {
  const [viewportId, setViewportId] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const [scaleMode, setScaleMode] = useState<"fit" | "100" | "custom">("fit");
  const [customZoom, setCustomZoom] = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isReloading, setIsReloading] = useState(false);
  const [reload, setReload] = useState(0);
  const [justUpdated, setJustUpdated] = useState(false);
  const firstRender = useRef(true);

  const canvasRef = useRef<HTMLDivElement>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [screenHeight, setScreenHeight] = useState(600);

  const [assetState, setAssetState] = useState<{ scope: string; assets: WebsiteAsset[] } | null>(null);
  const projectId = projectScope?.id;
  const clientId = projectScope?.client_id;
  const assetScope = JSON.stringify([clientId, projectId]);
  useEffect(() => {
    if (!projectId || !clientId) return;
    const controller = new AbortController();
    let pending = false;
    const refresh = async () => {
      if (pending || controller.signal.aborted) return;
      pending = true;
      try {
        const data = await apiJson<{ assets: WebsiteAsset[] }>(`/api/sites/${projectId}/assets`, { signal: controller.signal });
        if (!controller.signal.aborted) setAssetState({ scope: assetScope, assets: data.assets });
      } catch { /* Preserve last valid URLs; next interval/focus retries. */ }
      finally { pending = false; }
    };
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 240_000);
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("focus", onFocus); };
  }, [projectId, clientId, assetScope, revisionId, reload]);
  const prepared = useMemo((): { files: SandpackFiles | null; error: string } => {
    if (!["index.html", "src/main.tsx", "src/App.tsx"].every(path => files[path]?.trim())) return { files: null, error: "Rascunho incompleto. Crie ou corrija os arquivos de entrada." };
    try { return { files: getSitePreviewFiles(files, assetState?.scope === assetScope ? assetState.assets : [], projectScope), error: "" }; }
    catch { return { files: null, error: "Fontes inválidas para pré-visualização. O último resultado aceito foi preservado." }; }
  }, [files, assetState, assetScope, projectScope]);
  const available = ["index.html", "src/main.tsx", "src/App.tsx"].every((path) => files[path]?.trim());

  const filesVersion = useMemo(() => JSON.stringify(files), [files]);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const showTimer = setTimeout(() => setJustUpdated(true), 10);
    const hideTimer = setTimeout(() => setJustUpdated(false), 4500);
    return () => {
      clearTimeout(showTimer);
      clearTimeout(hideTimer);
    };
  }, [filesVersion]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      setCanvasSize({ width: rect.width, height: rect.height });
    };
    update();
    const observer = new ResizeObserver(() => update());
    observer.observe(el);
    return () => observer.disconnect();
  }, [isFullscreen, available]);

  useEffect(() => {
    const screenEl = screenRef.current;
    if (!screenEl) return;
    const update = () => {
      const rect = screenEl.getBoundingClientRect();
      if (rect.height > 50) setScreenHeight(rect.height);
    };
    update();
    const observer = new ResizeObserver(() => update());
    observer.observe(screenEl);
    return () => observer.disconnect();
  }, [canvasSize, viewportId, isFullscreen]);

  useEffect(() => {
    if (!isFullscreen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFullscreen]);

  const currentViewport = VIEWPORTS.find((item) => item.id === viewportId) ?? VIEWPORTS[0];

  const availableWidth = Math.max(100, canvasSize.width - 32);
  const availableHeight = Math.max(100, canvasSize.height - 32);

  const fitScale = useMemo(() => {
    if (!canvasSize.width || !canvasSize.height) return 1;
    if (currentViewport.id === "desktop") {
      return Math.min(1, Math.max(0.2, availableWidth / currentViewport.width));
    }
    if (currentViewport.id === "tablet") {
      const scaleW = availableWidth / 800;
      const scaleH = availableHeight / 1080;
      return Math.min(1, Math.max(0.2, Math.min(scaleW, scaleH)));
    }
    const scaleW = availableWidth / 430;
    const scaleH = availableHeight / 892;
    return Math.min(1, Math.max(0.2, Math.min(scaleW, scaleH)));
  }, [availableWidth, availableHeight, canvasSize.width, canvasSize.height, currentViewport]);

  const effectiveScale = scaleMode === "fit" ? fitScale : scaleMode === "100" ? 1 : customZoom;

  const displayUrl = projectSlug ? `https://${projectSlug}.site` : "http://localhost:3000";

  const handleReload = () => {
    setIsReloading(true);
    setReload((val) => val + 1);
    setTimeout(() => setIsReloading(false), 500);
  };

  const content = (
    <div className={`flex flex-col min-h-0 min-w-0 ${isFullscreen ? "fixed inset-0 z-50 bg-background/95 backdrop-blur-md p-4 animate-in fade-in-0" : "h-full flex-1 gap-2.5 p-3 overflow-hidden"}`}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 shrink-0 border-b border-border/50 pb-2.5">
        {/* Viewport Selectors */}
        <div className="flex items-center gap-1 rounded-lg border border-border/60 bg-muted/40 p-1" role="group" aria-label="Dispositivo de visualização">
          {VIEWPORTS.map(({ id, label, width: size, icon: Icon }) => (
            <Button
              key={id}
              variant={viewportId === id ? "default" : "ghost"}
              size="sm"
              className="h-8 px-2.5 text-xs font-medium gap-1.5 min-h-8"
              aria-label={`${label} ${size} pixels`}
              aria-pressed={viewportId === id}
              onClick={() => setViewportId(id)}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              <span className="hidden sm:inline">{label}</span>
              <span className="text-[10px] font-mono opacity-80">{size}</span>
            </Button>
          ))}
        </div>

        {/* Zoom Controls */}
        <div className="flex items-center gap-1 rounded-lg border border-border/60 bg-muted/40 p-1">
          <Button
            variant={scaleMode === "fit" ? "secondary" : "ghost"}
            size="sm"
            className="h-8 px-2 text-xs font-medium min-h-8"
            onClick={() => setScaleMode("fit")}
            title="Ajustar automaticamente ao espaço da tela"
          >
            Ajustar
          </Button>
          <Button
            variant={scaleMode === "100" ? "secondary" : "ghost"}
            size="sm"
            className="h-8 px-2 text-xs font-medium min-h-8"
            onClick={() => setScaleMode("100")}
            title="Visualizar em tamanho real (100%)"
          >
            100%
          </Button>
          <div className="h-4 w-px bg-border/60 mx-0.5" />
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={effectiveScale <= 0.25}
            onClick={() => {
              setScaleMode("custom");
              setCustomZoom(Math.max(0.25, Number((effectiveScale - 0.1).toFixed(2))));
            }}
            aria-label="Diminuir zoom"
            title="Diminuir zoom"
          >
            <ZoomOut className="size-3.5" />
          </Button>
          <span className="min-w-10 text-center font-mono text-[11px] text-muted-foreground select-none">
            {Math.round(effectiveScale * 100)}%
          </span>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            disabled={effectiveScale >= 2}
            onClick={() => {
              setScaleMode("custom");
              setCustomZoom(Math.min(2, Number((effectiveScale + 0.1).toFixed(2))));
            }}
            aria-label="Aumentar zoom"
            title="Aumentar zoom"
          >
            <ZoomIn className="size-3.5" />
          </Button>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1.5">
          {justUpdated && (
            <div className="hidden sm:flex items-center gap-1.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2.5 py-1 text-xs font-medium text-emerald-600 dark:text-emerald-400 animate-in fade-in duration-300">
              <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>Rascunho recebido</span>
            </div>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-8 px-2.5 text-xs gap-1.5 min-h-8"
            disabled={isReloading}
            onClick={handleReload}
            title="Recarregar pré-visualização"
          >
            <RotateCw className={`size-3.5 ${isReloading ? "animate-spin text-primary" : ""}`} aria-hidden="true" />
            <span className="hidden sm:inline">Recarregar</span>
          </Button>
          <Button
            size="sm"
            variant={isFullscreen ? "secondary" : "outline"}
            className="h-8 px-2.5 text-xs gap-1.5 min-h-8"
            onClick={() => setIsFullscreen((prev) => !prev)}
            title={isFullscreen ? "Sair da tela cheia (Esc)" : "Expandir para tela cheia"}
          >
            {isFullscreen ? (
              <>
                <Minimize2 className="size-3.5" aria-hidden="true" />
                <span>Sair</span>
              </>
            ) : (
              <>
                <Maximize2 className="size-3.5" aria-hidden="true" />
                <span className="hidden sm:inline">Tela cheia</span>
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Canvas Area */}
      {(
        <div
          ref={canvasRef}
          className="relative flex-1 min-h-0 min-w-0 overflow-auto rounded-xl border border-border/60 bg-muted/20 p-4 flex flex-col"
          style={{
            backgroundImage: "radial-gradient(circle, rgba(140, 140, 140, 0.15) 1px, transparent 1px)",
            backgroundSize: "20px 20px",
          }}
        >
          {/* Desktop Frame */}
          {(
            <div
              className="flex flex-col rounded-xl border border-border/80 bg-card shadow-xl overflow-hidden shrink-0"
              style={{
                width: `${Math.round(currentViewport.width * effectiveScale) + 2}px`,
                height: currentViewport.id === "desktop" && scaleMode === "fit" ? "100%" : `${Math.round(currentViewport.height * effectiveScale + 38)}px`,
                margin: "auto",
              }}
            >
              {/* Browser Window Bar */}
              <div className="flex items-center justify-between border-b border-border/80 bg-muted/60 px-3 py-1.5 text-xs select-none shrink-0 h-[38px]">
                <div className="flex items-center gap-1.5">
                  <span className="size-2.5 rounded-full bg-rose-500/90 shadow-sm" />
                  <span className="size-2.5 rounded-full bg-amber-500/90 shadow-sm" />
                  <span className="size-2.5 rounded-full bg-emerald-500/90 shadow-sm" />
                </div>
                <div className="mx-auto flex h-6 max-w-sm flex-1 items-center justify-center gap-1.5 rounded-md border border-border/60 bg-background/80 px-3 text-[11px] text-muted-foreground font-mono">
                  <Lock className="size-3 text-emerald-500 shrink-0" />
                  <span className="truncate">{displayUrl}</span>
                </div>
                {justUpdated ? (
                  <div className="flex items-center gap-1 text-[10px] font-medium text-emerald-500 animate-in fade-in">
                    <span className="size-1.5 rounded-full bg-emerald-500 animate-ping" />
                    <span>Rascunho</span>
                  </div>
                ) : (
                  <div className="text-[10px] font-mono text-muted-foreground/80">{currentViewport.width} × {currentViewport.height}</div>
                )}
              </div>

              {/* Viewport Screen */}
              <div ref={screenRef} className="relative flex-1 min-h-0 w-full overflow-hidden bg-white">
                <div
                  style={{
                    width: `${currentViewport.width}px`,
                    height: `${currentViewport.id === "desktop" ? Math.round(screenHeight / effectiveScale) : currentViewport.height}px`,
                    transform: `scale(${effectiveScale})`,
                    transformOrigin: "top left",
                  }}
                >
                  <RetainedPreview key={assetScope} files={prepared.files} preparationError={prepared.error} reload={reload} />
                </div>
              </div>
            </div>
          )}

        </div>
      )}

      {/* Footer Info */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border/40 pt-1.5 text-[11px] text-muted-foreground select-none">
        <div className="flex items-center gap-2">
          <span>
            Viewport: <strong className="font-mono text-foreground font-medium">{currentViewport.width}px</strong>
          </span>
          <span>·</span>
          <span>
            Escala: <strong className="font-mono text-foreground font-medium">{Math.round(effectiveScale * 100)}%</strong> (
            {scaleMode === "fit" ? "Ajuste automático à tela" : scaleMode === "100" ? "Tamanho real 1:1" : "Zoom manual"})
          </span>
        </div>
        <div className="text-[10px] text-muted-foreground/80">
          A pré-visualização não substitui a validação antes da publicação
        </div>
      </div>
    </div>
  );

  return content;
}
