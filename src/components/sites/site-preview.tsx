"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SandpackProvider, SandpackPreview, SandpackLayout, useSandpack, type SandpackFiles } from "@codesandbox/sandpack-react";
import { Lock, Maximize2, Minimize2, Monitor, RotateCw, Smartphone, Tablet, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { WebsiteFiles } from "@/lib/sites/types";
import { WEBSITE_FIXED_FILES } from "@/lib/sites/starter";

export const VIEWPORTS = [
  { id: "desktop", label: "Desktop", width: 1440, height: 900, icon: Monitor },
  { id: "tablet", label: "Tablet", width: 768, height: 1024, icon: Tablet },
  { id: "mobile", label: "Mobile", width: 390, height: 844, icon: Smartphone },
] as const;

export const SITE_PREVIEW_SETUP = { environment: "create-react-app", entry: "/index.tsx" } as const;

export function getSitePreviewFiles(files: WebsiteFiles): SandpackFiles {
  const result: SandpackFiles = {};
  for (const [path, code] of Object.entries(files)) {
    const normalized = path.replace(/^\//, "");
    if (typeof code !== "string" || code.includes("\0") || normalized.split("/").some((part) => !part || part === "." || part === "..")) continue;
    if (normalized.startsWith("src/") || normalized.startsWith("public/")) result[`/${normalized}`] = { code };
  }
  const html = files["index.html"] === undefined ? files["/index.html"] ?? "" : files["index.html"];
  if (typeof html !== "string" || html.includes("\0")) throw new Error("HTML inválido para pré-visualização");
  result["/index.html"] = { code: html, hidden: true };
  result["/index.tsx"] = {
    code: `const previewDocument = new DOMParser().parseFromString(${JSON.stringify(html)}, "text/html");
previewDocument.querySelectorAll("script").forEach((node) => node.remove());
document.documentElement.lang = previewDocument.documentElement.lang;
document.title = previewDocument.title;
document.head.append(...Array.from(previewDocument.head.children));
document.body.replaceChildren(...Array.from(previewDocument.body.childNodes));
require("./src/main.tsx");`,
    hidden: true,
  };
  const { dependencies } = JSON.parse(WEBSITE_FIXED_FILES["package.json"]) as { dependencies: Record<string, string> };
  result["/package.json"] = { code: JSON.stringify({ private: true, dependencies, main: "/index.tsx" }), hidden: true };
  return result;
}

function PreviewFrame(): React.JSX.Element {
  const { sandpack } = useSandpack();
  const failed = Boolean(sandpack.error) || sandpack.status === "timeout";
  return (
    <div className="relative h-full w-full">
      <SandpackPreview
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
          className="absolute inset-0 flex flex-col items-center justify-center bg-background/95 p-6 text-center text-sm text-foreground"
        >
          <p className="font-semibold text-destructive">Não foi possível carregar a pré-visualização.</p>
          <p className="mt-1 text-xs text-muted-foreground">Recarregue a página ou peça ao agente para corrigir o site.</p>
        </div>
      )}
    </div>
  );
}

export function SitePreview({
  files,
  revisionId,
  projectSlug,
}: {
  files: WebsiteFiles;
  revisionId: string | null;
  projectSlug?: string;
  projectName?: string;
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

  const sandpackFiles = useMemo(() => getSitePreviewFiles(files), [files]);
  const available = ["index.html", "src/main.tsx", "src/App.tsx"].every((path) => files[path]?.trim());

  const filesVersion = useMemo(() => {
    let hash = revisionId ?? "init";
    for (const [path, code] of Object.entries(files)) {
      hash += `|${path}:${typeof code === "string" ? code.length : 0}`;
    }
    return hash;
  }, [files, revisionId]);

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
  }, [isFullscreen]);

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
    const scaleW = availableWidth / 414;
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
              <span>Site atualizado!</span>
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
      {!available ? (
        <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          Peça ao agente para criar o site
        </div>
      ) : (
        <div
          ref={canvasRef}
          className="relative flex-1 min-h-0 min-w-0 overflow-auto rounded-xl border border-border/60 bg-muted/20 p-4 flex flex-col"
          style={{
            backgroundImage: "radial-gradient(circle, rgba(140, 140, 140, 0.15) 1px, transparent 1px)",
            backgroundSize: "20px 20px",
          }}
        >
          {/* Desktop Frame */}
          {currentViewport.id === "desktop" && (
            <div
              className="flex flex-col rounded-xl border border-border/80 bg-card shadow-xl overflow-hidden transition-[width,height] duration-150 shrink-0"
              style={{
                width: `${Math.min(availableWidth, Math.round(1440 * effectiveScale))}px`,
                height: scaleMode === "fit" ? "100%" : `${Math.round(900 * effectiveScale + 38)}px`,
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
                    <span>Atualizado</span>
                  </div>
                ) : (
                  <div className="text-[10px] font-mono text-muted-foreground/80">1440 × 900</div>
                )}
              </div>

              {/* Viewport Screen */}
              <div ref={screenRef} className="relative flex-1 min-h-0 w-full overflow-hidden bg-white">
                <div
                  style={{
                    width: "1440px",
                    height: `${Math.round(screenHeight / effectiveScale)}px`,
                    transform: `scale(${effectiveScale})`,
                    transformOrigin: "top left",
                  }}
                >
                  <SandpackProvider
                    key={`${filesVersion}:${reload}`}
                    theme="dark"
                    files={sandpackFiles}
                    customSetup={SITE_PREVIEW_SETUP}
                    options={{
                      activeFile: "/src/App.tsx",
                      classes: {
                        "sp-wrapper": "!h-full !w-full !border-0 !bg-transparent",
                        "sp-layout": "!h-full !w-full !border-0 !bg-transparent",
                        "sp-preview": "!h-full !w-full !border-0 !bg-transparent",
                        "sp-preview-container": "!h-full !w-full !border-0 !bg-transparent",
                      },
                    }}
                  >
                    <SandpackLayout style={{ height: "100%", width: "100%", border: 0, background: "transparent" }}>
                      <PreviewFrame />
                    </SandpackLayout>
                  </SandpackProvider>
                </div>
              </div>
            </div>
          )}

          {/* Tablet Frame */}
          {currentViewport.id === "tablet" && (
            <div
              className="relative overflow-hidden transition-[width,height] duration-150 shrink-0"
              style={{
                width: `${Math.round(800 * effectiveScale)}px`,
                height: `${Math.round(1080 * effectiveScale)}px`,
                borderRadius: `${Math.round(28 * effectiveScale)}px`,
                margin: "auto",
              }}
            >
              <div
                className="absolute top-0 left-0 flex flex-col rounded-[28px] border-[12px] border-slate-800 bg-slate-900 shadow-2xl p-1"
                style={{
                  width: "800px",
                  height: "1080px",
                  transform: `scale(${effectiveScale})`,
                  transformOrigin: "top left",
                }}
              >
                {/* Camera dot */}
                <div className="flex items-center justify-center py-1">
                  <span className="size-2 rounded-full bg-slate-700" />
                </div>
                {/* Screen */}
                <div className="relative flex-1 rounded-[16px] bg-white overflow-hidden">
                  <SandpackProvider
                    key={`${filesVersion}:${reload}`}
                    theme="dark"
                    files={sandpackFiles}
                    customSetup={SITE_PREVIEW_SETUP}
                    options={{
                      activeFile: "/src/App.tsx",
                      classes: {
                        "sp-wrapper": "!h-full !w-full !border-0 !bg-transparent",
                        "sp-layout": "!h-full !w-full !border-0 !bg-transparent",
                        "sp-preview": "!h-full !w-full !border-0 !bg-transparent",
                        "sp-preview-container": "!h-full !w-full !border-0 !bg-transparent",
                      },
                    }}
                  >
                    <SandpackLayout style={{ height: "100%", width: "100%", border: 0, background: "transparent" }}>
                      <PreviewFrame />
                    </SandpackLayout>
                  </SandpackProvider>
                </div>
              </div>
            </div>
          )}

          {/* Mobile Frame */}
          {currentViewport.id === "mobile" && (
            <div
              className="relative overflow-hidden transition-[width,height] duration-150 shrink-0"
              style={{
                width: `${Math.round(414 * effectiveScale)}px`,
                height: `${Math.round(892 * effectiveScale)}px`,
                borderRadius: `${Math.round(44 * effectiveScale)}px`,
                margin: "auto",
              }}
            >
              <div
                className="absolute top-0 left-0 flex flex-col rounded-[44px] border-[12px] border-slate-800 bg-slate-900 shadow-2xl p-2"
                style={{
                  width: "414px",
                  height: "892px",
                  transform: `scale(${effectiveScale})`,
                  transformOrigin: "top left",
                }}
              >
                {/* Dynamic Island */}
                <div className="flex items-center justify-center pt-0.5 pb-2">
                  <div className="h-4 w-24 rounded-full bg-slate-950 flex items-center justify-end px-2">
                    <span className="size-2 rounded-full bg-slate-800" />
                  </div>
                </div>
                {/* Screen */}
                <div className="relative flex-1 rounded-[28px] bg-white overflow-hidden">
                  <SandpackProvider
                    key={`${filesVersion}:${reload}`}
                    theme="dark"
                    files={sandpackFiles}
                    customSetup={SITE_PREVIEW_SETUP}
                    options={{
                      activeFile: "/src/App.tsx",
                      classes: {
                        "sp-wrapper": "!h-full !w-full !border-0 !bg-transparent",
                        "sp-layout": "!h-full !w-full !border-0 !bg-transparent",
                        "sp-preview": "!h-full !w-full !border-0 !bg-transparent",
                        "sp-preview-container": "!h-full !w-full !border-0 !bg-transparent",
                      },
                    }}
                  >
                    <SandpackLayout style={{ height: "100%", width: "100%", border: 0, background: "transparent" }}>
                      <PreviewFrame />
                    </SandpackLayout>
                  </SandpackProvider>
                </div>
                {/* Home Indicator */}
                <div className="flex items-center justify-center pt-2 pb-0.5">
                  <div className="h-1 w-28 rounded-full bg-slate-600/80" />
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
