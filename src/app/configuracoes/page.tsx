"use client";

import { useEffect, useState } from "react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Settings2, Key, Save, CheckCircle2, XCircle, Loader2, Info, Database, Copy, ExternalLink, Check, Server, Plug, RefreshCw, Bot } from "lucide-react";
import { cn } from "@/lib/utils";

export default function ConfiguracoesPage() {
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<null | { ok: boolean; message: string; count?: number }>(null);

  // Evolution API (troca de VPS sem rebuild — credenciais persistidas em app_settings)
  const [evoUrl, setEvoUrl]             = useState("");
  const [evoApiKey, setEvoApiKey]       = useState("");
  const [evoInstance, setEvoInstance]   = useState("");
  const [evoEffective, setEvoEffective] = useState<{ url: string; instance: string; apiKey: string; source: string } | null>(null);
  const [evoStored, setEvoStored]       = useState<{ url: string; instance: string; apiKey: string; hasKey: boolean } | null>(null);
  const [evoSaving, setEvoSaving]       = useState(false);
  const [evoTesting, setEvoTesting]     = useState(false);
  const [evoTestResult, setEvoTestResult] = useState<null | { ok: boolean; instances?: any[]; error?: string }>(null);
  const [evoMigration, setEvoMigration] = useState<null | { from: string; to: string; tables: Record<string, { ok: boolean; error?: string }> }>(null);

  async function loadEvolutionConfig() {
    try {
      const r = await fetch("/api/evolution/config", { cache: "no-store" });
      const d = await r.json();
      if (d.success) {
        setEvoStored(d.stored);
        setEvoEffective(d.effective);
        setEvoUrl(d.stored?.url || "");
        setEvoInstance(d.stored?.instance || "");
        // Não pré-preenchemos a key (vem mascarada do servidor); deixamos em branco para não substituir sem querer.
      }
    } catch {}
  }

  async function saveEvolution() {
    setEvoSaving(true);
    setEvoTestResult(null);
    setEvoMigration(null);
    try {
      const payload: any = { url: evoUrl.trim(), instance: evoInstance.trim() };
      if (evoApiKey.trim()) payload.apiKey = evoApiKey.trim();
      const r = await fetch("/api/evolution/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || "Falha ao salvar");
      if (d.migration) setEvoMigration(d.migration);
      setEvoApiKey("");
      await loadEvolutionConfig();
    } catch (e: any) {
      alert("Erro ao salvar: " + e.message);
      setEvoSaving(false);
      return;
    }
    // Após salvar, dispara um teste automático separado (não bloqueia o save).
    try {
      await testEvolution(true);
    } catch {
      // Se o teste falhar, o save já foi feito — não mostra como erro de save.
    }
    setEvoSaving(false);
  }

  async function testEvolution(useStored = false) {
    setEvoTesting(true);
    setEvoTestResult(null);
    try {
      const body: any = {};
      if (!useStored && evoUrl.trim())    body.url = evoUrl.trim();
      if (!useStored && evoApiKey.trim()) body.apiKey = evoApiKey.trim();
      const r = await fetch("/api/evolution/config?test=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      setEvoTestResult({ ok: !!d.success, instances: d.instances, error: d.error });
    } catch (e: any) {
      setEvoTestResult({ ok: false, error: e.message });
    } finally {
      setEvoTesting(false);
    }
  }

  useEffect(() => { loadEvolutionConfig(); }, []);

  // Setup do Banco (Supabase)
  const [dbSql, setDbSql] = useState<string>("");
  const [dbSqlEditorUrl, setDbSqlEditorUrl] = useState<string | null>(null);
  const [dbCurrentUrl, setDbCurrentUrl] = useState<string | null>(null);
  const [dbCheckLoading, setDbCheckLoading] = useState(false);
  const [dbCheckResult, setDbCheckResult] = useState<null | { ok: boolean; present: string[]; missing: string[]; error?: string }>(null);
  const [dbCopied, setDbCopied] = useState(false);
  // Alvo customizado (pra checar outro Supabase sem trocar o .env)
  const [customUrl, setCustomUrl] = useState("");
  const [customServiceRole, setCustomServiceRole] = useState("");

  useEffect(() => {
    fetch("/api/setup-db", { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        if (d.success) {
          setDbSql(d.sql || "");
          setDbSqlEditorUrl(d.sqlEditorUrl || null);
          setDbCurrentUrl(d.currentUrl || null);
        }
      })
      .catch(() => {});
  }, []);

  async function checkDatabase(targetUrl?: string, targetRole?: string) {
    setDbCheckLoading(true);
    setDbCheckResult(null);
    try {
      const params = new URLSearchParams({ check: "1" });
      if (targetUrl) params.set("url", targetUrl);
      if (targetRole) params.set("serviceRole", targetRole);
      const r = await fetch(`/api/setup-db?${params.toString()}`, { cache: "no-store" });
      const d = await r.json();
      setDbCheckResult({
        ok: !!d.success,
        present: d.present || [],
        missing: d.missing || [],
        error: d.error,
      });
    } catch (e: any) {
      setDbCheckResult({ ok: false, present: [], missing: [], error: e.message });
    } finally {
      setDbCheckLoading(false);
    }
  }

  async function copySql() {
    try {
      await navigator.clipboard.writeText(dbSql);
      setDbCopied(true);
      setTimeout(() => setDbCopied(false), 2500);
    } catch {
      alert("Não consegui copiar. Selecione o texto manualmente e copie com Ctrl+C.");
    }
  }

  // Load current config
  useEffect(() => {
    fetch("/api/ai-organize/config", { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        if (d.success && d.config) {
          setHasKey(!!d.config.has_api_key);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    if (!apiKey.trim()) {
      alert("Cole a API Key antes de salvar.");
      return;
    }
    setSaving(true);
    try {
      const r = await fetch("/api/ai-organize/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey.trim() }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || "Falha ao salvar");
      setHasKey(true);
      setApiKey("");
      alert("API Key salva! Todos os serviços (Agente IA, Disparo, Follow-up, Organizador) já estão usando essa chave.");
    } catch (e: any) {
      alert("Erro: " + e.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    if (!apiKey.trim() && !hasKey) {
      setTestResult({ ok: false, message: "Cole uma API Key para testar, ou salve primeiro." });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      // Se o usuário digitou uma key nova, testa ela direto no Google.
      // Se não, usa a central (via /api/ai-models que lê do ai_organizer_config).
      if (apiKey.trim()) {
        const r = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey.trim())}`
        );
        const j = await r.json();
        if (!r.ok) throw new Error(j.error?.message || "Chave inválida");
        const geminiModels = (j.models || []).filter((m: any) => m.name?.includes("gemini"));
        setTestResult({ ok: true, message: "Chave válida!", count: geminiModels.length });
      } else {
        const r = await fetch("/api/ai-models");
        const d = await r.json();
        if (!d.success) throw new Error(d.error || "Falha");
        setTestResult({ ok: true, message: "Chave central válida!", count: d.models?.length || 0 });
      }
    } catch (e: any) {
      setTestResult({ ok: false, message: e.message });
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex flex-col h-[100dvh] max-h-[100dvh] bg-background overflow-hidden text-white">
      <Header />
      <main className="flex-1 overflow-y-auto p-3 sm:p-6 md:p-10 max-w-4xl mx-auto w-full space-y-4 sm:space-y-6 mobile-safe-bottom">
        <div>
          <h1 className="text-2xl font-black tracking-tight flex items-center gap-3">
            <Settings2 className="w-6 h-6 text-primary" /> Configurações
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Credenciais compartilhadas por todo o sistema. Configure aqui uma vez — Agente IA, Disparo em Massa, Follow-up e Organizador usam automaticamente.
          </p>
        </div>

        <Card className="border-white/10 bg-white/[0.02]">
          <CardHeader>
            <CardTitle className="text-sm font-black uppercase tracking-widest flex items-center gap-2">
              <Key className="w-4 h-4 text-primary" /> Google Gemini API Key
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Status:</span>
              {loading ? (
                <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> Verificando…
                </span>
              ) : hasKey ? (
                <span className="text-[10px] font-black text-green-400 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> Configurada (salva com segurança no banco)
                </span>
              ) : (
                <span className="text-[10px] font-black text-red-400 flex items-center gap-1">
                  <XCircle className="w-3 h-3" /> Não configurada — nenhum serviço de IA vai funcionar
                </span>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-primary">
                {hasKey ? "Substituir chave" : "Cole sua API Key aqui"}
              </label>
              <Input
                type="password"
                value={apiKey}
                onChange={e => setApiKey(e.target.value)}
                placeholder={hasKey ? "••••••••••• (cole nova pra substituir)" : "AIzaSy..."}
                className="bg-black/40 border-white/10 font-mono text-sm h-11"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-[9px] text-muted-foreground flex items-start gap-1 leading-relaxed">
                <Info className="w-3 h-3 shrink-0 mt-0.5" />
                Obtenha sua chave em{" "}
                <a
                  href="https://aistudio.google.com/app/apikey"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline decoration-dotted hover:text-primary/80"
                >
                  aistudio.google.com/app/apikey
                </a>
                . Essa chave é compartilhada por todos os agentes e serviços — você não precisa colar em cada tela.
              </p>
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleSave}
                disabled={saving || !apiKey.trim()}
                className="bg-primary text-primary-foreground font-bold text-xs uppercase tracking-widest gap-2"
              >
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Salvar
              </Button>
              <Button
                onClick={handleTest}
                disabled={testing || (!apiKey.trim() && !hasKey)}
                variant="outline"
                className="bg-white/5 border-white/10 text-white hover:bg-white/10 font-bold text-xs uppercase tracking-widest"
              >
                {testing ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Testar chave
              </Button>
            </div>

            {testResult && (
              <div
                className={cn(
                  "flex items-start gap-2 p-3 rounded-xl border text-[11px]",
                  testResult.ok
                    ? "bg-green-500/10 border-green-500/30 text-green-200"
                    : "bg-red-500/10 border-red-500/30 text-red-200"
                )}
              >
                {testResult.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
                <div>
                  <p className="font-bold">{testResult.message}</p>
                  {typeof testResult.count === "number" && (
                    <p className="text-[10px] opacity-70 mt-0.5">{testResult.count} modelos Gemini disponíveis.</p>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="border-white/10 bg-white/[0.02]">
          <CardHeader>
            <CardTitle className="text-sm font-black uppercase tracking-widest">Onde essa chave é usada</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-[11px] text-muted-foreground">
              <li className="flex items-start gap-2">
                <span className="text-primary">•</span>
                <span>
                  <strong className="text-white">Agente IA (sandbox + WhatsApp)</strong> — conversas em tempo real. Cada agente escolhe o modelo Gemini que quer, mas todos compartilham essa chave.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary">•</span>
                <span>
                  <strong className="text-white">Disparo em Massa</strong> — personalização da mensagem com IA (opcional por campanha).
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary">•</span>
                <span>
                  <strong className="text-white">Follow-up automático</strong> — geração das mensagens de follow-up.
                </span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-primary">•</span>
                <span>
                  <strong className="text-white">Organizador IA</strong> — classificação diária dos leads do Kanban.
                </span>
              </li>
            </ul>
          </CardContent>
        </Card>

        {/* ========================================================== */}
        {/* Evolution API — credenciais (troca de VPS sem rebuild)      */}
        {/* ========================================================== */}
        <Card className="border-white/10 bg-white/[0.02]">
          <CardHeader>
            <CardTitle className="text-sm font-black uppercase tracking-widest flex items-center gap-2">
              <Server className="w-4 h-4 text-cyan-400" /> Evolution API (servidor WhatsApp)
            </CardTitle>
            <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
              Trocou de VPS? Cole aqui a URL nova, a global apikey e o nome da instância. O sistema passa
              a usar este servidor imediatamente — sem rebuild, sem mexer em <span className="font-mono">.env.local</span>.
              As credenciais ficam em <span className="font-mono">app_settings</span> (DB) e têm precedência sobre as variáveis de ambiente.
            </p>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Status atual */}
            {evoEffective && (
              <div className="rounded-xl bg-black/30 border border-white/10 p-3 space-y-1">
                <p className="text-[9px] uppercase font-black tracking-widest text-muted-foreground">Conectado agora</p>
                <p className="text-[11px] font-mono text-cyan-300 break-all">
                  {evoEffective.url || <span className="text-amber-300">(nenhum servidor configurado)</span>}
                </p>
                <p className="text-[10px] text-muted-foreground">
                  instância: <span className="font-mono text-white">{evoEffective.instance || "—"}</span> ·
                  apikey: <span className="font-mono text-white">{evoEffective.apiKey || "—"}</span> ·
                  origem: <span className="font-mono text-white">{evoEffective.source}</span>
                </p>
              </div>
            )}

            {/* Form */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1 md:col-span-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-cyan-400">URL do servidor Evolution</label>
                <Input
                  value={evoUrl}
                  onChange={e => setEvoUrl(e.target.value)}
                  placeholder="https://evolution.seudominio.com"
                  className="bg-black/40 border-white/10 font-mono text-sm h-11"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="text-[9px] text-muted-foreground">
                  URL pública sem barra no fim. Ex.: a que você acessa o painel da Evolution. Aceita http(s).
                </p>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-black uppercase tracking-widest text-cyan-400">Global API Key</label>
                <Input
                  type="password"
                  value={evoApiKey}
                  onChange={e => setEvoApiKey(e.target.value)}
                  placeholder={evoStored?.hasKey ? "••••••• (deixe em branco pra manter a atual)" : "AUTHENTICATION_API_KEY do servidor"}
                  className="bg-black/40 border-white/10 font-mono text-sm h-11"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="text-[9px] text-muted-foreground">
                  Variável <span className="font-mono">AUTHENTICATION_API_KEY</span> do <span className="font-mono">.env</span> da Evolution
                  (header <span className="font-mono">apikey:</span> em todas as chamadas).
                </p>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-black uppercase tracking-widest text-cyan-400">Nome da instância</label>
                <Input
                  value={evoInstance}
                  onChange={e => setEvoInstance(e.target.value)}
                  placeholder="sdr"
                  className="bg-black/40 border-white/10 font-mono text-sm h-11"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="text-[9px] text-muted-foreground">
                  Nome da instância WhatsApp na Evolution. Default <span className="font-mono">sdr</span>.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                onClick={saveEvolution}
                disabled={evoSaving || (!evoUrl.trim() && !evoApiKey.trim() && !evoInstance.trim())}
                className="bg-cyan-500/20 text-cyan-100 border border-cyan-500/40 hover:bg-cyan-500/30 font-bold text-xs uppercase tracking-widest gap-2"
              >
                {evoSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Salvar e conectar
              </Button>
              <Button
                onClick={() => testEvolution(false)}
                disabled={evoTesting || (!evoUrl.trim() && !evoStored?.url)}
                variant="outline"
                className="bg-white/5 border-white/10 text-white hover:bg-white/10 font-bold text-xs uppercase tracking-widest gap-2"
              >
                {evoTesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plug className="w-4 h-4" />}
                Testar conexão
              </Button>
              <Button
                onClick={loadEvolutionConfig}
                variant="ghost"
                className="text-[11px] font-bold uppercase tracking-widest gap-2 text-muted-foreground hover:text-white"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Recarregar
              </Button>
            </div>

            {evoMigration && (
              <div className="flex items-start gap-2 p-3 rounded-xl border text-[11px] bg-blue-500/10 border-blue-500/30 text-blue-100">
                <RefreshCw className="w-4 h-4 shrink-0 mt-0.5" />
                <div className="space-y-1">
                  <p className="font-bold">
                    Histórico migrado: instância <span className="font-mono">{evoMigration.from || "(vazia)"}</span> → <span className="font-mono">{evoMigration.to}</span>
                  </p>
                  <p className="text-[10px] opacity-80">
                    {Object.entries(evoMigration.tables).filter(([, v]) => v.ok).length}/{Object.keys(evoMigration.tables).length} tabelas migradas com sucesso. Mensagens, leads, sessões, campanhas e follow-ups antigos agora aparecem sob o novo nome.
                  </p>
                  {Object.entries(evoMigration.tables).filter(([, v]) => !v.ok).map(([t, v]) => (
                    <p key={t} className="text-[10px] text-red-300 font-mono">⚠ {t}: {v.error}</p>
                  ))}
                </div>
              </div>
            )}

            {evoTestResult && (
              <div
                className={cn(
                  "flex items-start gap-2 p-3 rounded-xl border text-[11px]",
                  evoTestResult.ok
                    ? "bg-green-500/10 border-green-500/30 text-green-200"
                    : "bg-red-500/10 border-red-500/30 text-red-200"
                )}
              >
                {evoTestResult.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
                <div className="space-y-1">
                  {evoTestResult.ok ? (
                    <>
                      <p className="font-bold">Conectou! Servidor respondeu corretamente.</p>
                      <p className="text-[10px] opacity-80">
                        {evoTestResult.instances?.length || 0} instância(s) disponível(is) nesse servidor.
                        {evoTestResult.instances && evoTestResult.instances.length > 0 && (
                          <span className="block mt-1 font-mono">
                            {evoTestResult.instances.slice(0, 6).map((i: any) => i.name || i.instanceName || i.instance?.instanceName || "?").join(", ")}
                            {evoTestResult.instances.length > 6 && ` (+${evoTestResult.instances.length - 6})`}
                          </span>
                        )}
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="font-bold">Falha ao conectar</p>
                      <p className="text-[10px] opacity-80 break-all">{evoTestResult.error}</p>
                    </>
                  )}
                </div>
              </div>
            )}

            <details className="rounded-xl border border-white/5 bg-black/20 overflow-hidden text-[11px]">
              <summary className="cursor-pointer px-3 py-2 font-bold text-white/70 hover:text-white">
                Como funciona / o que cada campo faz
              </summary>
              <div className="px-3 pb-3 space-y-2 text-muted-foreground leading-relaxed">
                <p>
                  <strong className="text-white">URL</strong>: endpoint HTTP da Evolution v2 — todas as chamadas batem em
                  <span className="font-mono"> {`{URL}`}/instance/...</span>, <span className="font-mono">/message/sendText/{`{instance}`}</span>, etc.
                </p>
                <p>
                  <strong className="text-white">API Key</strong>: a chave global da Evolution
                  (<span className="font-mono">AUTHENTICATION_API_KEY</span> no <span className="font-mono">docker-compose</span>).
                  Vai no header <span className="font-mono">apikey</span> de TODA requisição.
                </p>
                <p>
                  <strong className="text-white">Instância</strong>: o nome do WhatsApp já criado nesse servidor (a Evolution
                  permite múltiplas instâncias por servidor). O painel usa essa instância como default no envio
                  e nas chamadas que não recebem instância explícita.
                </p>
                <p>
                  <strong className="text-white">Como o painel troca de VPS sem rebuild:</strong> ao salvar, gravamos os 3 valores em
                  <span className="font-mono"> public.app_settings</span>. O <span className="font-mono">src/lib/evolution.ts</span> lê esses
                  valores em cache de 15 segundos (DB &gt; env). Após salvar, qualquer rota do painel já passa a usar o servidor novo.
                </p>
              </div>
            </details>
          </CardContent>
        </Card>

        {/* Lead Intelligence — modelo Gemini para análise estratégica de leads */}
        <LeadIntelligenceSettings />

        {/* ========================================================== */}
        {/* Setup do Banco (Supabase) — SQL completo + atalho pro editor */}
        {/* ========================================================== */}
        <Card className="border-white/10 bg-white/[0.02]">
          <CardHeader>
            <CardTitle className="text-sm font-black uppercase tracking-widest flex items-center gap-2">
              <Database className="w-4 h-4 text-emerald-400" /> Setup do Banco de Dados
            </CardTitle>
            <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
              Usa um Supabase novo? Roda o SQL abaixo uma única vez. Cria todas as tabelas,
              índices, permissões e realtime. Pode rodar de novo sem quebrar nada (idempotente).
            </p>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* Supabase atual */}
            {dbCurrentUrl && (
              <div className="p-3 rounded-xl bg-white/5 border border-white/10 space-y-1">
                <p className="text-[9px] uppercase font-black tracking-widest text-muted-foreground">Banco conectado atualmente</p>
                <p className="text-[11px] font-mono text-emerald-300 break-all">{dbCurrentUrl}</p>
              </div>
            )}

            {/* Verificar se o banco está pronto */}
            <div className="space-y-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <p className="text-xs font-bold text-white">Verificar se o banco está pronto</p>
                  <p className="text-[10px] text-muted-foreground">Checa se todas as tabelas essenciais existem.</p>
                </div>
                <Button
                  onClick={() => checkDatabase()}
                  disabled={dbCheckLoading}
                  variant="outline"
                  className="bg-white/5 border-white/10 text-white hover:bg-white/10 text-[11px] font-bold uppercase tracking-widest gap-2"
                >
                  {dbCheckLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  Verificar agora
                </Button>
              </div>

              {dbCheckResult && (
                <div className={cn(
                  "p-3 rounded-xl border text-[11px] space-y-1.5",
                  dbCheckResult.ok
                    ? "bg-green-500/10 border-green-500/30 text-green-200"
                    : dbCheckResult.error
                    ? "bg-red-500/10 border-red-500/30 text-red-200"
                    : "bg-amber-500/10 border-amber-500/30 text-amber-200"
                )}>
                  {dbCheckResult.ok ? (
                    <p className="font-bold flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4" /> Banco pronto — todas as {dbCheckResult.present.length} tabelas existem.</p>
                  ) : dbCheckResult.error ? (
                    <p className="font-bold flex items-start gap-1.5"><XCircle className="w-4 h-4 shrink-0 mt-0.5" /> {dbCheckResult.error}</p>
                  ) : (
                    <>
                      <p className="font-bold flex items-center gap-1.5"><XCircle className="w-4 h-4" /> Faltam {dbCheckResult.missing.length} tabela(s)</p>
                      <p className="font-mono text-[10px] opacity-80 break-all">{dbCheckResult.missing.join(", ")}</p>
                      <p className="text-[10px] opacity-80">Role o SQL abaixo no SQL Editor do Supabase pra criar as que faltam.</p>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Passo 1: abrir o SQL Editor */}
            <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-3">
              <div className="flex items-start gap-3">
                <div className="w-7 h-7 rounded-full bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-black text-xs flex items-center justify-center shrink-0">1</div>
                <div className="flex-1">
                  <p className="text-[12px] font-bold text-white">Abra o SQL Editor do Supabase</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Atalho abaixo abre direto no projeto conectado. Se quiser rodar em outro projeto, abra manualmente em <span className="font-mono">supabase.com/dashboard/project/SEU_PROJETO/sql/new</span>.
                  </p>
                  {dbSqlEditorUrl && (
                    <a href={dbSqlEditorUrl} target="_blank" rel="noreferrer"
                       className="inline-flex mt-2 items-center gap-1.5 text-[11px] font-bold text-emerald-300 hover:text-emerald-200 bg-emerald-500/10 border border-emerald-500/30 px-3 py-1.5 rounded-lg">
                      <ExternalLink className="w-3 h-3" /> Abrir SQL Editor
                    </a>
                  )}
                </div>
              </div>
            </div>

            {/* Passo 2: copiar o SQL */}
            <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 space-y-3">
              <div className="flex items-start gap-3">
                <div className="w-7 h-7 rounded-full bg-blue-500/20 border border-blue-500/40 text-blue-300 font-black text-xs flex items-center justify-center shrink-0">2</div>
                <div className="flex-1">
                  <p className="text-[12px] font-bold text-white">Copie o SQL abaixo e cole no editor</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Depois é só clicar <strong>Run</strong> no Supabase. Aparece "Success. No rows returned." quando terminar.
                  </p>
                  <Button
                    onClick={copySql}
                    className={cn(
                      "mt-2 gap-1.5 text-[11px] font-bold uppercase tracking-widest h-8",
                      dbCopied ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40" : "bg-blue-500/20 text-blue-200 border border-blue-500/40 hover:bg-blue-500/30"
                    )}
                  >
                    {dbCopied ? <><Check className="w-3.5 h-3.5" /> Copiado!</> : <><Copy className="w-3.5 h-3.5" /> Copiar SQL completo</>}
                  </Button>
                </div>
              </div>
              <details className="mt-2">
                <summary className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground cursor-pointer hover:text-white">Ver o SQL ({Math.round(dbSql.length / 1024)} KB)</summary>
                <textarea
                  readOnly
                  value={dbSql}
                  className="mt-2 w-full h-80 bg-black/60 border border-white/5 rounded-lg p-3 font-mono text-[10px] text-white/70 leading-relaxed custom-scrollbar"
                />
              </details>
            </div>

            {/* Opcional: checar outro Supabase (sem trocar o .env) */}
            <details className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden">
              <summary className="cursor-pointer px-4 py-3 text-[11px] font-bold text-white/80 hover:text-white">
                Vou trocar de Supabase — verificar outro projeto antes de apontar o app
              </summary>
              <div className="p-4 pt-2 space-y-3">
                <div className="space-y-1">
                  <label className="text-[9px] font-black uppercase tracking-widest text-muted-foreground">URL do novo Supabase</label>
                  <Input
                    value={customUrl}
                    onChange={e => setCustomUrl(e.target.value)}
                    placeholder="https://xxxxxx.supabase.co"
                    className="bg-black/40 border-white/10 font-mono text-xs h-9"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[9px] font-black uppercase tracking-widest text-muted-foreground">Service Role Key</label>
                  <Input
                    type="password"
                    value={customServiceRole}
                    onChange={e => setCustomServiceRole(e.target.value)}
                    placeholder="eyJ... (role = service_role)"
                    className="bg-black/40 border-white/10 font-mono text-xs h-9"
                    autoComplete="off"
                  />
                  <p className="text-[9px] text-muted-foreground">Dashboard → Project Settings → API → <strong>service_role secret</strong>.</p>
                </div>
                <Button
                  onClick={() => checkDatabase(customUrl, customServiceRole)}
                  disabled={!customUrl || !customServiceRole || dbCheckLoading}
                  variant="outline"
                  className="bg-white/5 border-white/10 text-white hover:bg-white/10 text-[11px] font-bold uppercase tracking-widest gap-2"
                >
                  {dbCheckLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                  Verificar este projeto
                </Button>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  <Info className="w-3 h-3 inline mr-1 -mt-0.5" />
                  Essa verificação apenas LÊ o schema remoto (não altera nada). Pra <em>apontar</em> o app pra esse Supabase, troque <span className="font-mono">NEXT_PUBLIC_SUPABASE_URL</span>, <span className="font-mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</span> e <span className="font-mono">SUPABASE_SERVICE_ROLE_KEY</span> no Easypanel (aba Environment) e rebuilde.
                </p>
              </div>
            </details>
          </CardContent>
        </Card>
      </main>
    </div>
  );
}

// =====================================================================
// LeadIntelligenceSettings — picker de modelo Gemini pra análise de leads.
// Lista carregada real-time da Google API (mesma fonte de /api/ai-models).
// =====================================================================
function LeadIntelligenceSettings() {
  const [model, setModel] = useState<string>("gemini-2.5-flash");
  const [models, setModels] = useState<Array<{ id: string; name: string; description?: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch("/api/settings/lead-intelligence")
      .then(r => r.json())
      .then(d => {
        if (!alive) return;
        if (d.success) {
          setModel(d.model);
          setModels(d.models || []);
        } else {
          setError(d.error || "Falha ao carregar modelos");
        }
      })
      .catch(e => alive && setError(String(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  const save = async (newModel: string) => {
    setSaving(true);
    setError(null);
    try {
      const r = await fetch("/api/settings/lead-intelligence", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: newModel }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error);
      setModel(newModel);
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 3000);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="border-cyan-500/20 bg-gradient-to-br from-cyan-500/5 to-purple-500/5">
      <CardHeader>
        <CardTitle className="text-sm font-black uppercase tracking-widest flex items-center gap-2">
          <Bot className="w-4 h-4 text-cyan-400" /> Lead Intelligence — Modelo de IA
        </CardTitle>
        <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
          Modelo Gemini usado pra analisar cada lead (lê site, busca web, gera briefing estratégico). O briefing é injetado automaticamente em <strong>disparo</strong>, <strong>follow-up</strong> e <strong>agente principal</strong>.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="text-[11px] text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Carregando modelos disponíveis...
          </p>
        ) : models.length === 0 ? (
          <p className="text-[11px] text-amber-300">
            ⚠ Nenhum modelo retornado. Salve sua API Key Gemini no card "Organizador IA" acima primeiro.
          </p>
        ) : (
          <>
            <label className="text-[10px] uppercase font-bold tracking-widest text-muted-foreground">Modelo ativo</label>
            <select
              value={model}
              onChange={e => save(e.target.value)}
              disabled={saving}
              className="w-full bg-black/40 border border-white/10 rounded-md px-3 h-10 text-sm text-white focus:outline-none focus:border-cyan-500/50"
            >
              {models.map(m => (
                <option key={m.id} value={m.id} className="bg-neutral-900">
                  {m.id} — {m.name}
                </option>
              ))}
            </select>
            <div className="flex items-center justify-between text-[10px]">
              <p className="text-muted-foreground">
                {models.length} modelos Gemini disponíveis na sua chave.
              </p>
              {savedAt && (
                <span className="text-emerald-400 font-bold animate-in fade-in">✓ Salvo</span>
              )}
              {saving && <Loader2 className="w-3 h-3 animate-spin" />}
            </div>
          </>
        )}
        {error && <p className="text-[10px] text-red-300">{error}</p>}

        <div className="text-[10px] text-cyan-100/70 leading-relaxed space-y-1 pt-2 border-t border-white/5">
          <p className="font-bold text-cyan-300/90">Recomendações por uso:</p>
          <ul className="space-y-0.5">
            <li>• <strong>gemini-2.5-flash</strong>: padrão recomendado. Custo baixo, qualidade alta. ~R$ 0,002/lead.</li>
            <li>• <strong>gemini-2.5-flash-lite</strong>: mais barato (~50% menos), qualidade ligeiramente menor.</li>
            <li>• <strong>gemini-2.5-pro</strong>: máxima qualidade pra análise estratégica. ~10x mais caro. Use quando o lead vale o investimento (B2B contratual de alto ticket).</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
