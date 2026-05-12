"use client";

import { useEffect, useState } from "react";
import { Globe, Loader2, RefreshCw, Sparkles, CheckCircle2, XCircle, AlertTriangle, Server, Laptop } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type SyncResult = {
  success: boolean;
  webhookUrl?: string;
  url?: string;
  results?: { instance: string; success: boolean; error?: string }[];
};

type Mode = "local" | "prod";

const PROD_KEY = "sdr_prod_url";

function detectMode(url: string): Mode {
  if (!url) return "local";
  return /ngrok|loca?lhost|127\.0\.0\.1/i.test(url) ? "local" : "prod";
}

export function NgrokQuickConnect() {
  const [open, setOpen] = useState(false);
  const [publicUrl, setPublicUrl] = useState("");
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<Mode>("local");
  const [prodUrl, setProdUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [result, setResult] = useState<SyncResult | null>(null);

  async function loadCurrent() {
    try {
      const res = await fetch("/api/config/ngrok", { cache: "no-store" });
      const data = await res.json();
      const url = data?.url || "";
      setPublicUrl(url);
      setInput(url);
      const m = detectMode(url);
      setMode(m);
      if (url) checkReachable(url);
    } catch {
      setPublicUrl("");
    }
    if (typeof window !== "undefined") {
      const saved = window.localStorage.getItem(PROD_KEY) || "";
      setProdUrl(saved);
    }
  }

  async function checkReachable(url: string) {
    try {
      await fetch(url, { method: "HEAD", mode: "no-cors", cache: "no-store" });
      setReachable(true);
    } catch {
      setReachable(false);
    }
  }

  useEffect(() => {
    loadCurrent();
  }, []);

  async function handleDetect() {
    setDetecting(true);
    try {
      const res = await fetch("/api/config/ngrok?detect=true", { cache: "no-store" });
      const data = await res.json();
      if (data?.success && data?.detected && data.url) {
        setMode("local");
        setInput(data.url);
        await handleSave(data.url);
      } else {
        alert("Não detectei nenhum túnel ngrok rodando localmente. Abra o ngrok com 'ngrok http 3000' e tente de novo.");
      }
    } catch (err: any) {
      alert("Erro ao detectar ngrok: " + err.message);
    } finally {
      setDetecting(false);
    }
  }

  async function handleSave(forced?: string) {
    const target = (forced || input).trim();
    if (!target.startsWith("http")) {
      alert("URL inválida — precisa começar com https://");
      return;
    }
    setSaving(true);
    setResult(null);
    try {
      const res = await fetch("/api/config/ngrok", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: target }),
      });
      const data = await res.json();
      if (data?.success) {
        setPublicUrl(data.url);
        setInput(data.url);
        const m = detectMode(data.url);
        setMode(m);
        if (m === "prod" && typeof window !== "undefined") {
          window.localStorage.setItem(PROD_KEY, data.url);
          setProdUrl(data.url);
        }
        setResult({ success: true, url: data.url, webhookUrl: data.webhookUrl, results: data.webhookResults });
        checkReachable(data.url);
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("public-url-changed", { detail: { url: data.url } }));
        }
      } else {
        setResult({ success: false });
        alert("Falha ao salvar: " + (data?.error || "erro desconhecido"));
      }
    } catch (err: any) {
      alert("Erro: " + err.message);
    } finally {
      setSaving(false);
    }
  }

  const statusBadge = !publicUrl
    ? { label: "Não configurado", color: "bg-red-500/10 text-red-400 border-red-500/20", icon: <XCircle className="w-3 h-3" /> }
    : reachable === false
    ? { label: "Fora do ar", color: "bg-orange-500/10 text-orange-400 border-orange-500/20", icon: <AlertTriangle className="w-3 h-3" /> }
    : reachable === true
    ? { label: "Online", color: "bg-green-500/10 text-green-400 border-green-500/20", icon: <CheckCircle2 className="w-3 h-3" /> }
    : { label: "Verificando…", color: "bg-white/5 text-muted-foreground border-white/10", icon: <Loader2 className="w-3 h-3 animate-spin" /> };

  const modeLabel = mode === "local" ? "Local (ngrok)" : "Produção (VPS)";
  const ModeIcon = mode === "local" ? Laptop : Server;

  return (
    <>
      <button
        onClick={() => { setOpen(true); loadCurrent(); }}
        className={cn(
          "flex items-center gap-1 sm:gap-2 px-2 sm:px-3 py-1.5 rounded-lg border transition-all hover:scale-[1.02]",
          statusBadge.color
        )}
        title="Configurar URL pública (ngrok local ou produção VPS)"
      >
        <Globe className="w-3.5 h-3.5" />
        <span className="text-[10px] font-black uppercase tracking-widest hidden min-[450px]:inline">Webhook</span>
        <span className="flex items-center gap-1 text-[9px] font-bold opacity-90 hidden sm:flex">
          {statusBadge.icon}
          {statusBadge.label}
        </span>
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Globe className="w-5 h-5 text-purple-400" />
              URL pública / Webhook
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4 pt-2">
            <p className="text-xs text-muted-foreground leading-relaxed">
              Define a URL base que a Evolution API e os agentes usam para encontrar este sistema.
              Use <strong>ngrok</strong> em desenvolvimento e a <strong>URL da VPS</strong> em produção.
              Ao salvar, o webhook é re-registrado em <strong>todas as instâncias</strong> e a URL fica disponível para todas as rotas internas.
            </p>

            {/* Toggle de modo */}
            <div className="flex gap-2 p-1 rounded-xl bg-black/30 border border-white/5">
              <button
                onClick={() => { setMode("local"); setInput(detectMode(publicUrl) === "local" ? publicUrl : ""); }}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all",
                  mode === "local" ? "bg-purple-600 text-white shadow-lg" : "text-muted-foreground hover:bg-white/5"
                )}
              >
                <Laptop className="w-3.5 h-3.5" /> Local (ngrok)
              </button>
              <button
                onClick={() => { setMode("prod"); setInput(prodUrl || (detectMode(publicUrl) === "prod" ? publicUrl : "")); }}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all",
                  mode === "prod" ? "bg-purple-600 text-white shadow-lg" : "text-muted-foreground hover:bg-white/5"
                )}
              >
                <Server className="w-3.5 h-3.5" /> Produção (VPS)
              </button>
            </div>

            {/* URL input */}
            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-purple-400">
                {mode === "local" ? "URL do ngrok" : "URL pública da VPS"}
              </label>
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={mode === "local" ? "https://abc-123.ngrok-free.app" : "https://meu-painel.easypanel.host"}
                className="font-mono text-sm h-11"
                onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
              />
            </div>

            <div className="flex gap-2">
              {mode === "local" && (
                <Button
                  onClick={handleDetect}
                  disabled={detecting || saving}
                  variant="outline"
                  className="flex-1 gap-2 h-11"
                  title="Lê http://127.0.0.1:4040/api/tunnels — só funciona com o ngrok rodando local"
                >
                  {detecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  Auto-detectar
                </Button>
              )}
              <Button
                onClick={() => handleSave()}
                disabled={saving || detecting || !input.trim()}
                className="flex-1 gap-2 h-11 bg-purple-600 hover:bg-purple-700"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
                Salvar e sincronizar tudo
              </Button>
            </div>

            {/* Status atual */}
            {publicUrl && (
              <div className="p-3 rounded-xl bg-black/30 border border-white/5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[9px] uppercase font-black tracking-widest text-purple-400">URL ativa agora</span>
                  <Badge className={cn("text-[9px] font-bold flex items-center gap-1", statusBadge.color)}>
                    <ModeIcon className="w-2.5 h-2.5" />
                    {modeLabel}
                  </Badge>
                </div>
                <code className="text-[11px] text-white/90 font-mono break-all block">{publicUrl}</code>
                <div className="border-t border-white/5 pt-2">
                  <p className="text-[9px] uppercase font-black tracking-widest text-blue-400 mb-1">Webhook que a Evolution chama</p>
                  <code className="text-[11px] text-blue-200/90 font-mono break-all block">{publicUrl}/api/webhooks/whatsapp</code>
                </div>
              </div>
            )}

            {/* Resultado da sincronização */}
            {result && (
              <div className="p-3 rounded-xl bg-black/30 border border-white/5 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-black uppercase tracking-widest text-white/60">
                    Sincronização
                  </span>
                  <Badge className={cn("text-[9px] font-bold", result.success ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400")}>
                    {result.success ? "OK" : "FALHA"}
                  </Badge>
                </div>
                <div className="space-y-1">
                  {(result.results || []).map((r, i) => (
                    <div key={i} className="flex items-center justify-between text-[11px] py-1 border-b border-white/5 last:border-0">
                      <span className="font-mono text-white/70">{r.instance}</span>
                      {r.success ? (
                        <span className="text-green-400 flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> webhook registrado
                        </span>
                      ) : (
                        <span className="text-red-400 flex items-center gap-1" title={r.error}>
                          <XCircle className="w-3 h-3" /> {r.error?.slice(0, 40) || "erro"}
                        </span>
                      )}
                    </div>
                  ))}
                  {(result.results || []).length === 0 && (
                    <p className="text-[11px] text-muted-foreground italic">Nenhuma instância em channel_connections — registre uma instância primeiro.</p>
                  )}
                </div>
                <p className="text-[10px] text-muted-foreground pt-1 border-t border-white/5 mt-2">
                  Também atualizado: <code className="text-purple-300">app_settings.public_url</code> (lido por todas as rotas internas).
                </p>
              </div>
            )}

            {mode === "prod" && prodUrl && prodUrl !== publicUrl && (
              <div className="p-2 rounded-lg bg-blue-500/5 border border-blue-500/20 text-[10px] text-blue-200/80">
                Última URL de produção lembrada neste navegador: <code className="text-blue-300">{prodUrl}</code>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
