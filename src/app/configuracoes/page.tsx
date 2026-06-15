"use client";

import { useEffect, useRef, useState } from "react";
import { Header } from "@/components/layout/header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Settings2, Key, Save, CheckCircle2, XCircle, Loader2, Info, Database, Copy, ExternalLink, Check, Server, Plug, RefreshCw, Bot, Trash2, Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { ModelOptions } from "@/components/ai-module-shared";

export default function ConfiguracoesPage() {
  const [apiKey, setApiKey] = useState("");
  const [hasKey, setHasKey] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<null | { ok: boolean; message: string; count?: number }>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [sessionLoaded, setSessionLoaded] = useState(false);

  // OpenRouter API Key (provedor alternativo ao Gemini — mesmo modelo de uso:
  // chave compartilhada por todo o sistema, salva em ai_organizer_config).
  const [orKey, setOrKey] = useState("");
  const [hasOrKey, setHasOrKey] = useState(false);
  const [orSaving, setOrSaving] = useState(false);
  const [orTesting, setOrTesting] = useState(false);
  const [orTestResult, setOrTestResult] = useState<null | { ok: boolean; message: string; count?: number }>(null);

  // Gateway de Assinatura — usa CONTAS/assinaturas (Gemini, Claude, ChatGPT) via
  // um proxy local OpenAI-compatível, ao invés de gastar crédito de API. Agora é
  // MULTI-CONTA: dá pra conectar várias ao mesmo tempo (cada uma é uma conexão).
  // As URLs/labels NÃO são segredo; as chaves são. Tudo em ai_organizer_config.
  type GwConn = {
    id: string;          // id salvo, ou "new_*" pra linha ainda não persistida
    label: string;
    baseUrl: string;
    apiKey: string;      // chave DIGITADA (efêmera); "" = manter a já salva
    hasApiKey: boolean;  // o servidor já tem uma chave guardada pra esta conexão
    testing?: boolean;
    testResult?: { ok: boolean; message: string; count?: number } | null;
  };
  const [gwConns, setGwConns] = useState<GwConn[]>([]);
  const [gwFallback, setGwFallback] = useState("");
  const [gwSaving, setGwSaving] = useState(false);
  // Há pelo menos uma conexão com URL preenchida (status "conectado").
  const gwConfigured = gwConns.some((c) => c.baseUrl.trim().length > 0);

  // CONECTOR EMBUTIDO ("1 clique") — o painel instala/liga um CLIProxyAPI local
  // e inicia o login OAuth das contas pela Management API. O usuário só vê a
  // tela de login do provedor; o resto acontece dentro do sistema.
  type PxAccount = { name: string; provider: string; status?: string };
  type PxStatus = {
    installed: boolean;
    running: boolean;
    managementReady: boolean;
    baseUrl: string;
    v1Url: string;
    accounts: PxAccount[];
  };
  const [pxStatus, setPxStatus] = useState<PxStatus | null>(null);
  const [pxBusy, setPxBusy] = useState<string | null>(null); // ação em andamento
  const [pxLogin, setPxLogin] = useState<null | { provider: string; url: string }>(null);
  const [pxError, setPxError] = useState<string | null>(null);
  const [pxCallbackUrl, setPxCallbackUrl] = useState("");
  const pxCancelRef = useRef(false);

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
  // Lista plana com nomes das instâncias do servidor remoto, pra mostrar como
  // chips clicáveis. Atualizada após Test/Save e quando URL+key são editadas.
  const [evoAvailable, setEvoAvailable] = useState<string[]>([]);
  const [evoQrCode, setEvoQrCode] = useState<string | null>(null);
  const [evoPairingCode, setEvoPairingCode] = useState<string | null>(null);
  const [evoCreated, setEvoCreated] = useState(false);

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
        // Se já temos URL+key salvas, lista as instâncias do servidor pra UI
        // mostrar os chips clicáveis sem o user precisar clicar em "Testar".
        if (d.stored?.url && d.stored?.hasKey) {
          fetch("/api/evolution/config?test=1", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
            .then(r => r.json())
            .then(t => {
              if (t.success && Array.isArray(t.instances)) {
                setEvoAvailable(t.instances.map(instanceNameOf).filter(Boolean));
              }
            })
            .catch(() => {});
        }
      }
    } catch {}
  }

  // Extrai o nome da instância de um item bruto vindo da Evolution API.
  function instanceNameOf(i: any): string {
    return i?.instance?.instanceName || i?.instance?.name || i?.instanceName || i?.name || "";
  }

  async function saveEvolution() {
    setEvoSaving(true);
    setEvoTestResult(null);
    setEvoMigration(null);
    setEvoQrCode(null);
    setEvoPairingCode(null);
    setEvoCreated(false);
    try {
      const payload: any = {
        url: evoUrl.trim(),
        instance: evoInstance.trim(),
        // Garante que se a instância informada não existir no servidor, ela
        // será criada com settings padrão + webhook automaticamente. Sem isso,
        // o user precisava ir manualmente na Evolution criar uma instância.
        ensure: true,
        // Manda a URL pública atual da página pra ser usada no webhook (caso
        // o painel esteja servido em domínio diferente do salvo no DB).
        publicUrl: typeof window !== "undefined" && !window.location.origin.includes("localhost")
          ? window.location.origin
          : undefined,
      };
      if (evoApiKey.trim()) payload.apiKey = evoApiKey.trim();
      const r = await fetch("/api/evolution/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || "Falha ao salvar");
      if (d.migration) setEvoMigration(d.migration);
      if (Array.isArray(d.availableInstances)) setEvoAvailable(d.availableInstances);
      if (d.created) {
        setEvoCreated(true);
        if (d.qrCode) setEvoQrCode(d.qrCode);
        if (d.pairingCode) setEvoPairingCode(d.pairingCode);
      }
      if (d.serverError) {
        setEvoTestResult({ ok: false, error: d.serverError });
      }
      setEvoApiKey("");
      await loadEvolutionConfig();
    } catch (e: any) {
      alert("Erro ao salvar: " + e.message);
      setEvoSaving(false);
      return;
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
      if (d.success && Array.isArray(d.instances)) {
        setEvoAvailable(d.instances.map(instanceNameOf).filter(Boolean));
      }
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
  const [customAnonKey, setCustomAnonKey] = useState("");
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

  // Load session to determine admin status
  useEffect(() => {
    fetch("/api/auth/session", { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        if (d.authenticated) {
          setIsAdmin(!!d.isAdmin && !d.impersonating);
        }
      })
      .catch(() => {})
      .finally(() => setSessionLoaded(true));
  }, []);

  // Load current config
  useEffect(() => {
    fetch("/api/ai-organize/config", { cache: "no-store" })
      .then(r => r.json())
      .then(d => {
        if (d.success && d.config) {
          setHasKey(!!d.config.has_api_key);
          setHasOrKey(!!d.config.has_openrouter_key);
          // Conexões do gateway (várias contas). As chaves vêm mascaradas
          // (has_api_key) — o campo de chave fica vazio = "manter a salva".
          const eps = Array.isArray(d.config.gateway_endpoints) ? d.config.gateway_endpoints : [];
          setGwConns(eps.map((e: any) => ({
            id: String(e.id ?? ""),
            label: String(e.label ?? ""),
            baseUrl: String(e.base_url ?? ""),
            apiKey: "",
            hasApiKey: !!e.has_api_key,
            testResult: null,
          })));
          if (typeof d.config.gateway_fallback_model === "string") setGwFallback(d.config.gateway_fallback_model || "");
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleSaveOpenRouter() {
    if (!orKey.trim()) {
      alert("Cole a API Key do OpenRouter antes de salvar.");
      return;
    }
    setOrSaving(true);
    try {
      const r = await fetch("/api/ai-organize/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ openrouter_api_key: orKey.trim() }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || "Falha ao salvar");
      setHasOrKey(true);
      setOrKey("");
      alert("API Key do OpenRouter salva! Agora os seletores de modelo mostram também os modelos do OpenRouter (Claude, GPT, Llama, etc.).");
    } catch (e: any) {
      alert("Erro: " + e.message);
    } finally {
      setOrSaving(false);
    }
  }

  async function handleTestOpenRouter() {
    if (!orKey.trim() && !hasOrKey) {
      setOrTestResult({ ok: false, message: "Cole uma API Key para testar, ou salve primeiro." });
      return;
    }
    setOrTesting(true);
    setOrTestResult(null);
    try {
      if (orKey.trim()) {
        // Testa a chave digitada direto no OpenRouter.
        const r = await fetch("https://openrouter.ai/api/v1/models", {
          headers: { Authorization: `Bearer ${orKey.trim()}` },
        });
        const j = await r.json();
        if (!r.ok) throw new Error(j?.error?.message || "Chave inválida");
        const count = Array.isArray(j?.data) ? j.data.length : 0;
        setOrTestResult({ ok: true, message: "Chave válida!", count });
      } else {
        // Usa a chave central via /api/ai-models (conta só os do OpenRouter).
        const r = await fetch("/api/ai-models", { cache: "no-store" });
        const d = await r.json();
        if (!d.success) throw new Error(d.error || "Falha");
        const count = (d.models || []).filter((m: any) => m.provider === "openrouter").length;
        setOrTestResult({ ok: true, message: "Chave central válida!", count });
      }
    } catch (e: any) {
      setOrTestResult({ ok: false, message: e.message });
    } finally {
      setOrTesting(false);
    }
  }

  // ---- Conexões do gateway (multi-conta) ----
  function addGwConn(preset?: { label?: string; baseUrl?: string }) {
    setGwConns((cs) => [
      ...cs,
      {
        id: `new_${Date.now()}_${cs.length}`,
        label: preset?.label || "",
        baseUrl: preset?.baseUrl || "",
        apiKey: "",
        hasApiKey: false,
        testResult: null,
      },
    ]);
  }
  function updateGwConn(id: string, patch: Partial<GwConn>) {
    setGwConns((cs) => cs.map((c) => (c.id === id ? { ...c, ...patch } : c)));
  }
  function removeGwConn(id: string) {
    setGwConns((cs) => cs.filter((c) => c.id !== id));
  }

  // Re-lê as conexões do servidor (ids reais + has_api_key) após salvar.
  async function refreshGatewayConns() {
    try {
      const r = await fetch("/api/ai-organize/config", { cache: "no-store" });
      const d = await r.json();
      if (d.success && d.config) {
        const eps = Array.isArray(d.config.gateway_endpoints) ? d.config.gateway_endpoints : [];
        setGwConns(eps.map((e: any) => ({
          id: String(e.id ?? ""),
          label: String(e.label ?? ""),
          baseUrl: String(e.base_url ?? ""),
          apiKey: "",
          hasApiKey: !!e.has_api_key,
          testResult: null,
        })));
        if (typeof d.config.gateway_fallback_model === "string") setGwFallback(d.config.gateway_fallback_model || "");
      }
    } catch { /* não-fatal */ }
  }

  // Testa UMA conexão direto no proxy: GET {url}/models (OpenAI-compatível).
  async function testGwConn(id: string) {
    const c = gwConns.find((x) => x.id === id);
    if (!c || !c.baseUrl.trim()) return;
    updateGwConn(id, { testing: true, testResult: null });
    try {
      const base = c.baseUrl.trim().replace(/\/+$/, "");
      const headers: Record<string, string> = {};
      if (c.apiKey.trim()) headers.Authorization = `Bearer ${c.apiKey.trim()}`;
      const r = await fetch(`${base}/models`, { headers });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        if ((r.status === 401 || r.status === 403) && c.hasApiKey && !c.apiKey.trim()) {
          throw new Error("Exige chave. Re-digite a chave pra testar (a já salva continua válida) ou apenas Salve.");
        }
        throw new Error(j?.error?.message || `Proxy respondeu ${r.status}. Está rodando e logado nesta conta?`);
      }
      const arr = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : [];
      updateGwConn(id, { testResult: { ok: true, message: "Conexão respondendo!", count: arr.length } });
    } catch (e: any) {
      updateGwConn(id, { testResult: { ok: false, message: e.message } });
    } finally {
      updateGwConn(id, { testing: false });
    }
  }

  async function handleSaveGateway() {
    const conns = gwConns.filter((c) => c.baseUrl.trim());
    setGwSaving(true);
    try {
      const payload: Record<string, any> = {
        gateway_endpoints: conns.map((c) => {
          // id "new_*" vai vazio → o servidor gera um id estável.
          const o: Record<string, string> = {
            id: c.id.startsWith("new_") ? "" : c.id,
            label: c.label.trim(),
            base_url: c.baseUrl.trim(),
          };
          // Só envia a chave se foi DIGITADA (senão preserva a salva).
          if (c.apiKey.trim()) o.api_key = c.apiKey.trim();
          return o;
        }),
        gateway_fallback_model: gwFallback.trim(),
      };
      const r = await fetch("/api/ai-organize/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || "Falha ao salvar");
      await refreshGatewayConns();
      if (d.warning) {
        alert("⚠ " + d.warning);
      } else if (conns.length === 0) {
        alert("Nenhuma conexão ativa. O sistema usa as API keys (Gemini/OpenRouter).");
      } else {
        alert(`${conns.length} conexão(ões) salva(s)! Em qualquer seletor de modelo, o grupo "Gateway (Assinatura)" lista os modelos das suas contas — sem gastar crédito de API. Se um proxy cair, o sistema usa o modelo de fallback automaticamente.`);
      }
    } catch (e: any) {
      alert("Erro: " + e.message);
    } finally {
      setGwSaving(false);
    }
  }

  async function handleDisconnectGateway() {
    if (!confirm("Desconectar TODAS as contas do Gateway de Assinatura? O sistema volta a usar API key (Gemini/OpenRouter). Você pode reconectar quando quiser.")) {
      return;
    }
    setGwSaving(true);
    try {
      const r = await fetch("/api/ai-organize/config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        // Lista vazia + limpa os campos legados = desconecta tudo.
        body: JSON.stringify({ gateway_endpoints: [], gateway_base_url: "", gateway_api_key: "" }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || "Falha ao desconectar");
      setGwConns([]);
      alert("Todas as conexões desconectadas. O sistema voltou a usar as API keys configuradas.");
    } catch (e: any) {
      alert("Erro: " + e.message);
    } finally {
      setGwSaving(false);
    }
  }

  // ---- Conector embutido (1 clique) ----

  async function pxCall(payload: Record<string, any>) {
    const r = await fetch("/api/gateway-proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!d.success) throw new Error(d.error || "Falha no conector.");
    return d;
  }

  async function refreshProxyStatus() {
    try {
      const d = await pxCall({ action: "status" });
      setPxStatus(d.status);
    } catch {
      /* sem permissão/rota — a seção mostra estado desconhecido */
    }
  }

  useEffect(() => {
    refreshProxyStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handlePxAction(action: "install" | "start" | "stop") {
    setPxError(null);
    setPxBusy(action);
    try {
      const d = await pxCall({ action });
      setPxStatus(d.status);
    } catch (e: any) {
      setPxError(e.message);
    } finally {
      setPxBusy(null);
    }
  }

  /**
   * Garante que existe (e está salva) uma conexão apontando pro conector local.
   * Chamada após um login OAuth dar certo — é o que faz os modelos da conta
   * aparecerem nos seletores sem o usuário preencher nada.
   */
  async function ensureLocalConnSaved(v1Url: string) {
    const norm = (u: string) => u.trim().replace(/\/+$/, "");
    const exists = gwConns.some((c) => norm(c.baseUrl) === norm(v1Url));
    const list = exists
      ? gwConns.filter((c) => c.baseUrl.trim())
      : [
          ...gwConns.filter((c) => c.baseUrl.trim()),
          { id: "", label: "Conector local (painel)", baseUrl: v1Url, apiKey: "", hasApiKey: false } as GwConn,
        ];
    const payload: Record<string, any> = {
      gateway_endpoints: list.map((c) => {
        const o: Record<string, string> = {
          id: c.id.startsWith("new_") ? "" : c.id,
          label: c.label.trim() || "Conector local (painel)",
          base_url: c.baseUrl.trim(),
        };
        if (c.apiKey.trim()) o.api_key = c.apiKey.trim();
        return o;
      }),
    };
    const r = await fetch("/api/ai-organize/config", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const d = await r.json();
    if (!d.success) throw new Error(d.error || "Login ok, mas falhou ao salvar a conexão.");
    await refreshGatewayConns();
  }

  /**
   * Fluxo completo "conectar conta": instala/liga o conector se preciso, pede a
   * URL de login OAuth, abre numa aba e fica esperando a confirmação. No fim,
   * salva a conexão local sozinho. O usuário só faz o login na conta dele.
   */
  async function handleConnectAccount(provider: "gemini" | "claude" | "openai") {
    setPxError(null);
    setPxBusy(`login-${provider}`);
    pxCancelRef.current = false;
    try {
      // 1) Garante conector instalado e ligado (tudo automático).
      let st = pxStatus;
      if (!st?.running) {
        const d = await pxCall({ action: st?.installed ? "start" : "install" });
        st = d.status;
        setPxStatus(d.status);
      }
      // 2) Pede a URL de login e abre pro usuário autenticar na conta.
      const start = await pxCall({ action: "login-start", provider });
      setPxLogin({ provider, url: start.url });
      window.open(start.url, "_blank", "noopener"); // pode ser bloqueado — o banner tem o link
      // 3) Espera o login concluir (até 6 min, checando a cada 2,5s). Dá tempo
      //    inclusive de colar a URL de callback quando o painel roda em VPS.
      const deadline = Date.now() + 6 * 60 * 1000;
      while (Date.now() < deadline && !pxCancelRef.current) {
        await new Promise((r) => setTimeout(r, 2500));
        const s = await pxCall({ action: "login-status", state: start.state });
        if (s.status === "ok") {
          await ensureLocalConnSaved(String(start.v1Url || s.v1Url || "http://127.0.0.1:8317/v1"));
          await refreshProxyStatus();
          alert("Conta conectada! Os modelos dela já aparecem no grupo \"Gateway (Assinatura)\" de todos os seletores — sem gastar API.");
          return;
        }
        if (s.status === "error") throw new Error(s.error || "O login falhou. Tente de novo.");
      }
      if (!pxCancelRef.current) throw new Error("Tempo esgotado esperando o login. Clique de novo pra tentar outra vez.");
    } catch (e: any) {
      setPxError(e.message);
    } finally {
      setPxBusy(null);
      setPxLogin(null);
      setPxCallbackUrl("");
    }
  }

  /**
   * Painel rodando em VPS/Docker: o provedor redireciona pra localhost:PORTA,
   * que só existe NO SERVIDOR — a aba do usuário dá "recusou a conexão" e o
   * código fica na URL. O usuário cola a URL aqui; o servidor a entrega ao
   * conector e o poll do handleConnectAccount detecta o "ok" em seguida.
   */
  async function handlePxCallbackPaste() {
    const url = pxCallbackUrl.trim();
    if (!url) return;
    setPxError(null);
    try {
      await pxCall({ action: "login-callback", url });
      setPxCallbackUrl("");
    } catch (e: any) {
      setPxError(e.message);
    }
  }

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
            {isAdmin
              ? "Credenciais compartilhadas por todo o sistema. Configure aqui uma vez — Agente IA, Disparo em Massa, Follow-up e Organizador usam automaticamente."
              : "Configurações da sua conta."}
          </p>
        </div>

        {!isAdmin && sessionLoaded && (
          <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-4 text-xs text-amber-200">
            <p className="font-bold">⚠ Configurações do sistema estão disponíveis apenas para administradores.</p>
            <p className="text-[10px] text-amber-200/70 mt-1">Contate seu administrador para alterar API Keys, servidor Evolution ou banco de dados.</p>
          </div>
        )}

        {isAdmin && (<>
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

        {/* ========================================================== */}
        {/* OpenRouter API Key — provedor alternativo ao Gemini         */}
        {/* ========================================================== */}
        <Card className="border-purple-500/20 bg-purple-500/[0.03]">
          <CardHeader>
            <CardTitle className="text-sm font-black uppercase tracking-widest flex items-center gap-2">
              <Key className="w-4 h-4 text-purple-400" /> OpenRouter API Key
            </CardTitle>
            <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
              Provedor alternativo ao Gemini. Com essa chave, TODOS os seletores de modelo do sistema
              passam a mostrar também os modelos do OpenRouter (Claude, GPT, Llama, DeepSeek, etc.) — em tempo real.
              Você escolhe, por recurso, usar Gemini OU OpenRouter.
            </p>
          </CardHeader>
          <CardContent className="space-y-5">
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Status:</span>
              {loading ? (
                <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> Verificando…
                </span>
              ) : hasOrKey ? (
                <span className="text-[10px] font-black text-green-400 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> Configurada (salva com segurança no banco)
                </span>
              ) : (
                <span className="text-[10px] font-black text-muted-foreground flex items-center gap-1">
                  <XCircle className="w-3 h-3" /> Não configurada — opcional (sem ela, só os modelos Gemini aparecem)
                </span>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-black uppercase tracking-widest text-purple-400">
                {hasOrKey ? "Substituir chave" : "Cole sua API Key do OpenRouter aqui"}
              </label>
              <Input
                type="password"
                value={orKey}
                onChange={e => setOrKey(e.target.value)}
                placeholder={hasOrKey ? "••••••••••• (cole nova pra substituir)" : "sk-or-v1-..."}
                className="bg-black/40 border-white/10 font-mono text-sm h-11"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-[9px] text-muted-foreground flex items-start gap-1 leading-relaxed">
                <Info className="w-3 h-3 shrink-0 mt-0.5" />
                Obtenha sua chave em{" "}
                <a
                  href="https://openrouter.ai/keys"
                  target="_blank"
                  rel="noreferrer"
                  className="text-purple-400 underline decoration-dotted hover:text-purple-300"
                >
                  openrouter.ai/keys
                </a>
                . Como o Gemini, essa chave é compartilhada por todos os agentes e serviços.
              </p>
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleSaveOpenRouter}
                disabled={orSaving || !orKey.trim()}
                className="bg-purple-500/20 text-purple-100 border border-purple-500/40 hover:bg-purple-500/30 font-bold text-xs uppercase tracking-widest gap-2"
              >
                {orSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Salvar
              </Button>
              <Button
                onClick={handleTestOpenRouter}
                disabled={orTesting || (!orKey.trim() && !hasOrKey)}
                variant="outline"
                className="bg-white/5 border-white/10 text-white hover:bg-white/10 font-bold text-xs uppercase tracking-widest"
              >
                {orTesting ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                Testar chave
              </Button>
            </div>

            {orTestResult && (
              <div
                className={cn(
                  "flex items-start gap-2 p-3 rounded-xl border text-[11px]",
                  orTestResult.ok
                    ? "bg-green-500/10 border-green-500/30 text-green-200"
                    : "bg-red-500/10 border-red-500/30 text-red-200"
                )}
              >
                {orTestResult.ok ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <XCircle className="w-4 h-4 shrink-0" />}
                <div>
                  <p className="font-bold">{orTestResult.message}</p>
                  {typeof orTestResult.count === "number" && (
                    <p className="text-[10px] opacity-70 mt-0.5">{orTestResult.count} modelos OpenRouter disponíveis.</p>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ========================================================== */}
        {/* Gateway de Assinatura — usar CONTAS no lugar de API key     */}
        {/* ========================================================== */}
        <Card className="border-emerald-500/20 bg-emerald-500/[0.03]">
          <CardHeader>
            <CardTitle className="text-sm font-black uppercase tracking-widest flex items-center gap-2">
              <Plug className="w-4 h-4 text-emerald-400" /> Gateway de Assinatura (contas, sem API)
            </CardTitle>
            <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
              Use suas <strong className="text-emerald-200">contas/assinaturas</strong> (Gemini, Claude, ChatGPT) no lugar
              de crédito de API — como se você estivesse usando pelo site. Funciona por meio de um proxy local
              OpenAI-compatível (ex.: <span className="font-mono text-emerald-300/90">CLIProxyAPI</span>) onde você faz login
              nas contas. Depois, em <strong className="text-white">qualquer seletor de modelo</strong> do sistema, escolha um
              modelo do grupo <strong className="text-emerald-300">“Gateway (Assinatura)”</strong> pra usar a assinatura, ou do
              grupo “Google Gemini”/“OpenRouter” pra usar a API. A troca é por recurso, a qualquer momento — nada se perde.
            </p>
          </CardHeader>
          <CardContent className="space-y-5">
            {/* ===== CONECTAR EM 1 CLIQUE (conector embutido) ===== */}
            <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] p-4 space-y-3">
              <p className="text-[11px] font-black uppercase tracking-widest text-emerald-300 flex items-center gap-2">
                <Plug className="w-3.5 h-3.5" /> Conectar conta em 1 clique
              </p>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                Clique no botão da conta que quer usar. O painel <strong className="text-white">instala e liga o conector
                sozinho</strong> e abre a página de login oficial (Google/Anthropic/OpenAI) — você só faz o login. Ao terminar,
                os modelos da sua assinatura aparecem em todos os seletores, <strong className="text-emerald-200">sem gastar API</strong>.
              </p>

              {/* Status do conector */}
              <div className="flex items-center gap-2 flex-wrap text-[10px]">
                <span className="font-black uppercase tracking-widest text-muted-foreground">Conector:</span>
                {!pxStatus ? (
                  <span className="text-muted-foreground flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> verificando…</span>
                ) : pxStatus.running && pxStatus.managementReady ? (
                  <span className="font-black text-green-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> ligado{pxStatus.accounts.length ? ` · ${pxStatus.accounts.length} conta(s) logada(s)` : ""}</span>
                ) : pxStatus.running ? (
                  <span className="font-black text-yellow-400 flex items-center gap-1"><Info className="w-3 h-3" /> há um proxy na porta 8317 fora do controle do painel — use o modo manual abaixo</span>
                ) : pxStatus.installed ? (
                  <span className="font-black text-yellow-400 flex items-center gap-1"><XCircle className="w-3 h-3" /> instalado, desligado</span>
                ) : (
                  <span className="font-black text-muted-foreground flex items-center gap-1"><XCircle className="w-3 h-3" /> não instalado (instala sozinho no 1º clique)</span>
                )}
              </div>

              {/* Botões por conta — fazem TUDO (instala → liga → login) */}
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={() => handleConnectAccount("gemini")}
                  disabled={!!pxBusy}
                  className="bg-blue-500/15 text-blue-100 border border-blue-500/40 hover:bg-blue-500/25 font-bold text-xs gap-2"
                >
                  {pxBusy === "login-gemini" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  Conectar conta Gemini
                </Button>
                <Button
                  onClick={() => handleConnectAccount("claude")}
                  disabled={!!pxBusy}
                  className="bg-orange-500/15 text-orange-100 border border-orange-500/40 hover:bg-orange-500/25 font-bold text-xs gap-2"
                >
                  {pxBusy === "login-claude" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  Conectar conta Claude
                </Button>
                <Button
                  onClick={() => handleConnectAccount("openai")}
                  disabled={!!pxBusy}
                  className="bg-teal-500/15 text-teal-100 border border-teal-500/40 hover:bg-teal-500/25 font-bold text-xs gap-2"
                >
                  {pxBusy === "login-openai" ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  Conectar conta ChatGPT
                </Button>
              </div>

              {/* Login em andamento — link manual caso o popup seja bloqueado */}
              {pxLogin && (
                <div className="flex items-start gap-2 p-3 rounded-xl border border-blue-500/30 bg-blue-500/10 text-blue-100 text-[11px]">
                  <Loader2 className="w-4 h-4 shrink-0 animate-spin mt-0.5" />
                  <div className="space-y-2 flex-1 min-w-0">
                    <p className="font-bold">Esperando você concluir o login na outra aba…</p>
                    <p className="opacity-80">
                      Não abriu? <a href={pxLogin.url} target="_blank" rel="noopener noreferrer" className="underline font-bold text-blue-300">Clique aqui pra abrir a página de login</a>.
                      {" "}Depois de logar, volte aqui — o painel detecta e salva sozinho.
                    </p>
                    <div className="rounded-lg border border-blue-400/30 bg-blue-500/10 p-2 space-y-1.5">
                      <p className="font-bold">
                        A aba terminou em erro “localhost recusou a conexão” (ERR_CONNECTION_REFUSED)? É normal — falta 1 passo:
                      </p>
                      <p className="opacity-80">
                        Copie a <strong>URL inteira</strong> da barra de endereço daquela aba (começa com{" "}
                        <span className="font-mono">http://localhost:…</span> e tem <span className="font-mono">code=</span>) e cole aqui:
                      </p>
                      <div className="flex gap-2">
                        <Input
                          value={pxCallbackUrl}
                          onChange={(e) => setPxCallbackUrl(e.target.value)}
                          placeholder="http://localhost:1455/auth/callback?code=...&state=..."
                          className="h-8 bg-black/30 border-blue-400/30 text-[10px] font-mono text-white placeholder:text-white/30"
                        />
                        <Button
                          onClick={handlePxCallbackPaste}
                          disabled={!pxCallbackUrl.trim()}
                          size="sm"
                          className="h-8 text-[10px] font-bold bg-blue-500/30 text-blue-100 border border-blue-400/40 hover:bg-blue-500/50 shrink-0"
                        >
                          Concluir login
                        </Button>
                      </div>
                    </div>
                    <button
                      onClick={() => { pxCancelRef.current = true; }}
                      className="text-[10px] underline opacity-70 hover:opacity-100"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              )}

              {/* Instalação/ação demorada em andamento */}
              {(pxBusy === "install" || pxBusy === "start" || pxBusy === "stop") && (
                <p className="text-[10px] text-muted-foreground flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {pxBusy === "install" ? "Baixando e instalando o conector (1ª vez demora ~1 min)…" : pxBusy === "start" ? "Ligando o conector…" : "Desligando…"}
                </p>
              )}

              {/* Erro do conector */}
              {pxError && (
                <div className="flex items-start gap-2 p-3 rounded-xl border border-red-500/30 bg-red-500/10 text-red-200 text-[11px]">
                  <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <p className="whitespace-pre-wrap">{pxError}</p>
                </div>
              )}

              {/* Contas logadas no conector */}
              {pxStatus?.managementReady && pxStatus.accounts.length > 0 && (
                <div className="text-[10px] text-muted-foreground leading-relaxed">
                  <span className="font-black uppercase tracking-widest">Contas no conector: </span>
                  {pxStatus.accounts.map((a, i) => (
                    <span key={a.name + i} className="inline-flex items-center gap-1 mr-2">
                      <CheckCircle2 className="w-3 h-3 text-green-400" />
                      {/claude|anthropic/.test(a.provider) ? "Claude" : /gem|google/.test(a.provider) ? "Gemini" : /codex|openai|gpt/.test(a.provider) ? "ChatGPT" : a.provider || a.name}
                    </span>
                  ))}
                </div>
              )}

              {/* Controles do conector (liga/desliga manual) */}
              <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-emerald-500/10">
                {pxStatus?.installed && !pxStatus.running && (
                  <Button onClick={() => handlePxAction("start")} disabled={!!pxBusy} variant="outline" size="sm" className="h-7 text-[10px] bg-white/5 border-white/10 text-white hover:bg-white/10 font-bold">
                    Ligar conector
                  </Button>
                )}
                {pxStatus?.running && pxStatus.managementReady && (
                  <Button onClick={() => handlePxAction("stop")} disabled={!!pxBusy} variant="outline" size="sm" className="h-7 text-[10px] bg-white/5 border-white/10 text-muted-foreground hover:bg-white/10 font-bold">
                    Desligar conector
                  </Button>
                )}
                <Button onClick={() => refreshProxyStatus()} disabled={!!pxBusy} variant="outline" size="sm" className="h-7 text-[10px] bg-white/5 border-white/10 text-muted-foreground hover:bg-white/10 font-bold gap-1">
                  <RefreshCw className="w-3 h-3" /> Atualizar status
                </Button>
                <span className="text-[9px] text-muted-foreground/70">
                  O conector roda no mesmo computador/servidor do painel (porta 8317).
                </span>
              </div>
            </div>

            {/* Modo manual (avançado) — proxy próprio/externo */}
            <details className="rounded-xl border border-white/10 bg-white/[0.02] p-4 group">
              <summary className="text-[11px] font-black uppercase tracking-widest text-muted-foreground cursor-pointer select-none hover:text-white">
                Modo manual (avançado) — usar um proxy que você mesmo roda
              </summary>
              <ol className="text-[11px] text-muted-foreground leading-relaxed list-decimal pl-4 space-y-1 mt-3">
                <li>No seu PC/servidor, rode um <strong className="text-white">proxy OpenAI-compatível</strong> que loga na sua conta — ex.: <span className="font-mono text-emerald-300/90">CLIProxyAPI</span> (serve Gemini, Claude e ChatGPT). Passo a passo em <span className="font-mono text-emerald-300/90">docs/GATEWAY_ASSINATURA.md</span>.</li>
                <li><strong className="text-white">Faça login</strong> na conta dentro do proxy (Google p/ Gemini, Anthropic p/ Claude, OpenAI p/ ChatGPT). É a sua assinatura — <strong className="text-emerald-200">sem API key</strong>.</li>
                <li>Copie a <strong className="text-white">URL local</strong> do proxy (ex.: <span className="font-mono">http://localhost:8317/v1</span>), cole numa conexão abaixo, clique <strong className="text-emerald-200">Testar</strong> e depois <strong className="text-emerald-200">Salvar conexões</strong>.</li>
                <li>Pronto: em qualquer seletor, o grupo <strong className="text-emerald-300">“Gateway (Assinatura)”</strong> lista os modelos das suas contas.</li>
              </ol>
              <p className="text-[10px] text-muted-foreground/80 leading-relaxed pt-2 mt-2 border-t border-white/5">
                <strong className="text-emerald-200">Várias contas ao mesmo tempo?</strong> Sim — adicione uma conexão por conta
                (Gemini + Claude + ChatGPT juntos). Um mesmo proxy pode expor várias contas numa URL só, ou use uma URL por
                conta/proxy. Os dois jeitos funcionam.
              </p>
            </details>

            {/* Status */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Status:</span>
              {loading ? (
                <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Loader2 className="w-3 h-3 animate-spin" /> Verificando…
                </span>
              ) : gwConfigured ? (
                <span className="text-[10px] font-black text-green-400 flex items-center gap-1">
                  <CheckCircle2 className="w-3 h-3" /> {gwConns.filter((c) => c.baseUrl.trim()).length} conta(s) conectada(s) — modelos disponíveis nos seletores
                </span>
              ) : (
                <span className="text-[10px] font-black text-muted-foreground flex items-center gap-1">
                  <XCircle className="w-3 h-3" /> Nenhuma conta — opcional (sem ela, usa API key de Gemini/OpenRouter)
                </span>
              )}
            </div>

            {/* Lista de conexões (uma por conta) */}
            <div className="space-y-3">
              {gwConns.length === 0 && (
                <p className="text-[11px] text-muted-foreground italic">Nenhuma conexão ainda. Adicione uma abaixo (uma por conta).</p>
              )}
              {gwConns.map((c, idx) => (
                <div key={c.id} className="rounded-xl border border-white/10 bg-black/30 p-3 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] font-black uppercase tracking-widest text-emerald-400">
                      Conexão {idx + 1}{c.hasApiKey ? " · 🔑 chave salva" : ""}
                    </span>
                    <Button
                      onClick={() => removeGwConn(c.id)}
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 bg-red-500/5 border-red-500/20 text-red-300 hover:bg-red-500/15"
                      title="Remover conexão (lembre de Salvar)"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  <div className="grid gap-2.5 sm:grid-cols-2">
                    <div className="space-y-1">
                      <label className="text-[9px] font-black uppercase tracking-widest text-muted-foreground">Apelido</label>
                      <Input
                        value={c.label}
                        onChange={(e) => updateGwConn(c.id, { label: e.target.value })}
                        placeholder="ex.: Claude Pro"
                        className="bg-black/40 border-white/10 text-sm h-10"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-[9px] font-black uppercase tracking-widest text-muted-foreground">URL do proxy</label>
                      <Input
                        value={c.baseUrl}
                        onChange={(e) => updateGwConn(c.id, { baseUrl: e.target.value })}
                        placeholder="http://localhost:8317/v1"
                        className="bg-black/40 border-white/10 font-mono text-sm h-10"
                        autoComplete="off"
                        spellCheck={false}
                      />
                    </div>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[9px] font-black uppercase tracking-widest text-muted-foreground">
                      {c.hasApiKey ? "Substituir chave (opcional)" : "Chave do proxy (opcional)"}
                    </label>
                    <Input
                      type="password"
                      value={c.apiKey}
                      onChange={(e) => updateGwConn(c.id, { apiKey: e.target.value })}
                      placeholder={c.hasApiKey ? "••••••••• (cole nova pra trocar)" : "deixe em branco se o proxy não exige"}
                      className="bg-black/40 border-white/10 font-mono text-sm h-10"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      onClick={() => testGwConn(c.id)}
                      disabled={!!c.testing || !c.baseUrl.trim()}
                      variant="outline"
                      size="sm"
                      className="h-8 bg-white/5 border-white/10 text-white hover:bg-white/10 text-[11px] font-bold gap-1.5"
                    >
                      {c.testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                      Testar
                    </Button>
                    {c.testResult && (
                      <span className={cn("text-[10px] font-bold flex items-center gap-1", c.testResult.ok ? "text-green-300" : "text-red-300")}>
                        {c.testResult.ok ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                        {c.testResult.message}{typeof c.testResult.count === "number" ? ` (${c.testResult.count} modelos)` : ""}
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Adicionar conexão — genérica + atalhos por provedor */}
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => addGwConn()}
                variant="outline"
                size="sm"
                className="bg-emerald-500/10 border-emerald-500/30 text-emerald-100 hover:bg-emerald-500/20 text-[11px] font-bold gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" /> Adicionar conexão
              </Button>
              <Button onClick={() => addGwConn({ label: "Gemini (conta)" })} variant="outline" size="sm" className="bg-blue-500/10 border-blue-500/30 text-blue-100 hover:bg-blue-500/20 text-[11px] font-bold">+ Gemini</Button>
              <Button onClick={() => addGwConn({ label: "Claude (assinatura)" })} variant="outline" size="sm" className="bg-orange-500/10 border-orange-500/30 text-orange-100 hover:bg-orange-500/20 text-[11px] font-bold">+ Claude</Button>
              <Button onClick={() => addGwConn({ label: "ChatGPT (conta)" })} variant="outline" size="sm" className="bg-teal-500/10 border-teal-500/30 text-teal-100 hover:bg-teal-500/20 text-[11px] font-bold">+ ChatGPT</Button>
            </div>

            {/* Fallback global (vale pra todas as conexões) */}
            <div className="space-y-2 pt-1 border-t border-white/5">
              <label className="text-[10px] font-black uppercase tracking-widest text-emerald-400">
                Modelo de fallback (nunca quebra)
              </label>
              <Input
                type="text"
                value={gwFallback}
                onChange={(e) => setGwFallback(e.target.value)}
                placeholder="ex.: gemini:gemini-2.5-flash  ou  openrouter:openai/gpt-4o-mini"
                className="bg-black/40 border-white/10 font-mono text-sm h-11"
                autoComplete="off"
                spellCheck={false}
              />
              <p className="text-[9px] text-muted-foreground flex items-start gap-1 leading-relaxed">
                <Info className="w-3 h-3 shrink-0 mt-0.5" />
                Se uma conta/proxy estiver fora do ar, deslogada ou sem cota, o sistema usa este modelo (via API key)
                automaticamente — sem erro pro usuário. Vale pra todas as conexões. Deixe em branco pra desativar.
              </p>
            </div>

            {/* Salvar / Desconectar tudo */}
            <div className="flex gap-2 flex-wrap">
              <Button
                onClick={handleSaveGateway}
                disabled={gwSaving}
                className="bg-emerald-500/20 text-emerald-100 border border-emerald-500/40 hover:bg-emerald-500/30 font-bold text-xs uppercase tracking-widest gap-2"
              >
                {gwSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Salvar conexões
              </Button>
              {gwConfigured && (
                <Button
                  onClick={handleDisconnectGateway}
                  disabled={gwSaving}
                  variant="outline"
                  className="bg-red-500/5 border-red-500/20 text-red-300 hover:bg-red-500/15 font-bold text-xs uppercase tracking-widest"
                >
                  Desconectar todas
                </Button>
              )}
            </div>
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
                  placeholder={evoAvailable.length > 0 ? "Escolha abaixo ou digite um nome novo" : "Digite um nome (ex: minhaempresa)"}
                  className="bg-black/40 border-white/10 font-mono text-sm h-11"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="text-[9px] text-muted-foreground">
                  {evoInstance.trim() && evoAvailable.includes(evoInstance.trim()) ? (
                    <>Vai vincular a uma instância <span className="text-green-300 font-bold">já existente</span> nesse servidor.</>
                  ) : evoInstance.trim() ? (
                    <>Esse nome ainda <span className="text-amber-300 font-bold">não existe</span> no servidor — será criada com QR Code automaticamente ao salvar.</>
                  ) : (
                    <>Cole o nome da instância. Se ela ainda não existir no servidor, será criada com configuração padrão (rejeita ligações, ignora grupos) + webhook automaticamente.</>
                  )}
                </p>
              </div>
            </div>

            {evoAvailable.length > 0 && (
              <div className="rounded-xl border border-white/10 bg-black/30 p-3 space-y-2">
                <p className="text-[9px] uppercase font-black tracking-widest text-muted-foreground">
                  Instâncias detectadas no servidor ({evoAvailable.length})
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {evoAvailable.map(name => (
                    <button
                      key={name}
                      type="button"
                      onClick={() => setEvoInstance(name)}
                      className={cn(
                        "px-2.5 py-1 rounded-md text-[11px] font-mono border transition",
                        evoInstance.trim() === name
                          ? "bg-cyan-500/20 border-cyan-500/60 text-cyan-100"
                          : "bg-white/5 border-white/10 text-white/70 hover:bg-white/10 hover:text-white"
                      )}
                    >
                      {name}
                    </button>
                  ))}
                </div>
                <p className="text-[9px] text-muted-foreground">Clique pra usar uma existente, ou digite um nome novo no campo acima pra criar.</p>
              </div>
            )}

            {evoCreated && (
              <div className="rounded-xl border border-green-500/30 bg-green-500/10 p-3 space-y-3">
                <div className="flex items-start gap-2 text-green-200">
                  <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                  <div className="text-[11px] space-y-1">
                    <p className="font-bold">Instância criada com sucesso!</p>
                    <p className="opacity-80">
                      Settings padrão aplicados (<span className="font-mono">rejectCall</span>, <span className="font-mono">groupsIgnore</span>, <span className="font-mono">alwaysOnline</span>) e webhook registrado. Escaneie o QR Code abaixo no WhatsApp do celular pra finalizar a conexão.
                    </p>
                  </div>
                </div>
                {evoQrCode && (
                  <div className="flex flex-col items-center gap-2">
                    <img
                      src={evoQrCode.startsWith("data:") ? evoQrCode : `data:image/png;base64,${evoQrCode}`}
                      alt="QR Code WhatsApp"
                      className="w-56 h-56 rounded-lg bg-white p-2"
                    />
                    <p className="text-[10px] text-muted-foreground">
                      WhatsApp → Configurações → Aparelhos conectados → Conectar aparelho. O QR expira em ~60s — clique <span className="font-mono">Salvar e conectar</span> de novo se passar.
                    </p>
                  </div>
                )}
                {evoPairingCode && (
                  <p className="text-center text-[11px] font-mono text-cyan-300">
                    Ou use o código de pareamento: <span className="font-bold text-base">{evoPairingCode}</span>
                  </p>
                )}
              </div>
            )}

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

        {/* Modelo de Embeddings — RAG da base de conhecimento (Gemini ou OpenRouter) */}
        <EmbeddingModelSettings />

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

            {/* Formulário para vincular o Supabase definitivamente no .env.local */}
            <details className="rounded-2xl border border-white/10 bg-white/[0.02] overflow-hidden" open>
              <summary className="cursor-pointer px-4 py-3 text-[11px] font-bold text-white/80 hover:text-white">
                Vincular sistema a um novo Supabase (Salvar credenciais)
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
                  <label className="text-[9px] font-black uppercase tracking-widest text-muted-foreground">Anon Key</label>
                  <Input
                    type="password"
                    value={customAnonKey}
                    onChange={e => setCustomAnonKey(e.target.value)}
                    placeholder="eyJ... (role = anon)"
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
                
                <div className="flex gap-2 pt-2">
                  <Button
                    onClick={() => checkDatabase(customUrl, customServiceRole)}
                    disabled={!customUrl || !customServiceRole || dbCheckLoading}
                    variant="outline"
                    className="bg-white/5 border-white/10 text-white hover:bg-white/10 text-[11px] font-bold uppercase tracking-widest gap-2"
                  >
                    {dbCheckLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                    Verificar apenas
                  </Button>
                  <Button
                    onClick={async () => {
                      if (!customUrl || !customAnonKey || !customServiceRole) {
                        alert("Preencha todos os campos");
                        return;
                      }
                      try {
                        const res = await fetch("/api/setup-db", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ url: customUrl, anonKey: customAnonKey, serviceRole: customServiceRole })
                        });
                        const data = await res.json();
                        if (data.success) {
                          alert("✅ CREDENCIAIS SALVAS NO .ENV.LOCAL COM SUCESSO!\n\nPara o sistema passar a usar esse banco de dados agora, você PRECISA:\n1. Parar o terminal atual (Ctrl+C).\n2. Rodar 'npm run dev' novamente.");
                        } else {
                          alert("Erro ao salvar: " + data.error);
                        }
                      } catch (err: any) {
                        alert("Erro ao salvar: " + err.message);
                      }
                    }}
                    disabled={!customUrl || !customAnonKey || !customServiceRole}
                    className="bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-bold uppercase tracking-widest gap-2 flex-1"
                  >
                    Salvar e Sobrescrever .env.local
                  </Button>
                </div>
                <p className="text-[10px] text-muted-foreground leading-relaxed">
                  <Info className="w-3 h-3 inline mr-1 -mt-0.5" />
                  O botão salvar escreve as credenciais no arquivo <span className="font-mono">.env.local</span>. Como o Next.js carrega esse arquivo apenas no momento em que o servidor liga, você <strong>precisará reiniciar o terminal</strong> para que as alterações tenham efeito.
                </p>
              </div>
            </details>
          </CardContent>
        </Card>
        </>)}
      </main>
    </div>
  );
}

// =====================================================================
// LeadIntelligenceSettings — picker de modelo Gemini pra análise de leads.
// Lista carregada real-time da Google API (mesma fonte de /api/ai-models).
// =====================================================================
function LeadIntelligenceSettings() {
  const [model, setModel] = useState<string>("");  // sobrescrito pelo fetch real-time
  const [models, setModels] = useState<Array<{ id: string; rawId?: string; name: string; description?: string; provider?: "gemini" | "openrouter" }>>([]);
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
              <ModelOptions models={models as any} />
            </select>
            <div className="flex items-center justify-between text-[10px]">
              <p className="text-muted-foreground">
                {models.length} modelos disponíveis (Gemini + OpenRouter + Gateway/Assinatura).
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
            <li>• <strong>gemini-2.5-flash</strong>: padrão recomendado. Custo baixo, qualidade alta. ~R$ 0,002/cliente.</li>
            <li>• <strong>gemini-2.5-flash-lite</strong>: mais barato (~50% menos), qualidade ligeiramente menor.</li>
            <li>• <strong>gemini-2.5-pro</strong>: máxima qualidade pra análise estratégica. ~10x mais caro. Use quando o cliente vale o investimento (B2B contratual de alto ticket).</li>
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

// =====================================================================
// EmbeddingModelSettings — modelo de EMBEDDINGS do RAG (base de conhecimento).
// Gemini OU OpenRouter, em tempo real. Sempre 768 dimensões (forçado).
// Trocar o modelo exige RE-INDEXAR a base.
// =====================================================================
function EmbeddingModelSettings() {
  const [model, setModel] = useState<string>("");
  const [models, setModels] = useState<Array<{ id: string; rawId?: string; name: string; provider?: "gemini" | "openrouter" }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reindexing, setReindexing] = useState(false);
  const [reindexResult, setReindexResult] = useState<null | { ok: boolean; msg: string }>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch("/api/settings/embedding-model").then(r => r.json()).catch(() => null),
      fetch("/api/ai-models/embeddings").then(r => r.json()).catch(() => null),
    ]).then(([cur, list]) => {
      if (!alive) return;
      if (cur?.success) setModel(cur.model || "");
      if (list?.success) setModels(list.models || []);
      else if (list?.error) setError(list.error);
    }).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, []);

  const save = async (newModel: string) => {
    setSaving(true); setError(null);
    try {
      const r = await fetch("/api/settings/embedding-model", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: newModel }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error);
      setModel(newModel);
      setSavedAt(Date.now());
      setTimeout(() => setSavedAt(null), 3000);
    } catch (e: any) { setError(e?.message || String(e)); }
    finally { setSaving(false); }
  };

  const reindex = async () => {
    if (!confirm("Re-indexar TODA a base de conhecimento com o modelo de embeddings atual? Pode levar alguns minutos.")) return;
    setReindexing(true); setReindexResult(null);
    try {
      const r = await fetch("/api/agent/reindex-kb", { method: "POST" });
      const d = await r.json();
      if (!d.success) throw new Error(d.error);
      setReindexResult({ ok: true, msg: `${d.reindexed}/${d.total} documentos re-indexados (${d.chunks} trechos)${d.failed ? ` · ${d.failed} falharam` : ""}.` });
    } catch (e: any) {
      setReindexResult({ ok: false, msg: e?.message || String(e) });
    } finally { setReindexing(false); }
  };

  return (
    <Card className="border-purple-500/20 bg-gradient-to-br from-purple-500/5 to-cyan-500/5">
      <CardHeader>
        <CardTitle className="text-sm font-black uppercase tracking-widest flex items-center gap-2">
          <Database className="w-4 h-4 text-purple-400" /> Modelo de Embeddings (Base de Conhecimento)
        </CardTitle>
        <p className="text-[11px] text-muted-foreground mt-2 leading-relaxed">
          Modelo que transforma a base de conhecimento em vetores pra busca semântica do agente (RAG).
          Pode ser Gemini OU OpenRouter — sempre em 768 dimensões. Listado em tempo real.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="text-[11px] text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> Carregando modelos de embedding...
          </p>
        ) : models.length === 0 ? (
          <p className="text-[11px] text-amber-300">
            ⚠ Nenhum modelo de embedding retornado. Configure a API Key do Gemini e/ou OpenRouter acima.
          </p>
        ) : (
          <>
            <label className="text-[10px] uppercase font-bold tracking-widest text-muted-foreground">Modelo ativo</label>
            <select
              value={model}
              onChange={e => save(e.target.value)}
              disabled={saving}
              className="w-full bg-black/40 border border-white/10 rounded-md px-3 h-10 text-sm text-white focus:outline-none focus:border-purple-500/50"
            >
              {model && !models.some(m => m.id === model) && (
                <option value={model} className="bg-neutral-900">{model} (salvo)</option>
              )}
              {(["gemini", "openrouter"] as const)
                .filter(p => models.some(m => (m.provider || "gemini") === p))
                .map(p => (
                  <optgroup key={p} label={p === "openrouter" ? "OpenRouter" : "Google Gemini"} className="bg-neutral-900">
                    {models.filter(m => (m.provider || "gemini") === p).map(m => (
                      <option key={m.id} value={m.id} className="bg-neutral-900">{(m.rawId || m.id)} — {m.name}</option>
                    ))}
                  </optgroup>
                ))}
            </select>
            <div className="flex items-center justify-between text-[10px]">
              <p className="text-muted-foreground">{models.length} modelos de embedding disponíveis.</p>
              {savedAt && <span className="text-emerald-400 font-bold">✓ Salvo</span>}
              {saving && <Loader2 className="w-3 h-3 animate-spin" />}
            </div>
          </>
        )}
        {error && <p className="text-[10px] text-red-300">{error}</p>}

        <div className="rounded-xl bg-amber-500/10 border border-amber-500/30 p-3 space-y-2">
          <p className="text-[10px] text-amber-200 leading-relaxed">
            <strong>⚠ Importante:</strong> ao TROCAR o modelo de embeddings, a base já indexada fica incompatível
            (vetores de modelos diferentes não se comparam). Clique em <strong>Re-indexar</strong> pra recalcular tudo
            com o novo modelo — senão a busca na base perde qualidade.
          </p>
          <div className="flex items-center gap-2">
            <Button
              onClick={reindex}
              disabled={reindexing}
              className="bg-purple-500/20 text-purple-100 border border-purple-500/40 hover:bg-purple-500/30 font-bold text-[11px] uppercase tracking-widest gap-2 h-8"
            >
              {reindexing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
              Re-indexar base agora
            </Button>
            {reindexResult && (
              <span className={cn("text-[10px]", reindexResult.ok ? "text-emerald-400" : "text-red-300")}>
                {reindexResult.ok ? "✓ " : "✗ "}{reindexResult.msg}
              </span>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
