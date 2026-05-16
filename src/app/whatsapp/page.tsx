"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Header } from "@/components/layout/header";
import { supabase } from "@/lib/supabase";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Smartphone, QrCode, RefreshCw, Plus, Bot, Trash2, Link2, Loader2,
  Wifi, WifiOff, Hash, Eye, User, Globe, CheckCircle2, XCircle, Copy, Sparkles, Stethoscope,
  Shield, ShieldCheck, ShieldOff, X
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useClientSession } from "@/lib/use-session";

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  open: { label: "Online", color: "text-green-400", bg: "bg-green-500/10 border-green-500/20" },
  close: { label: "Offline", color: "text-red-400", bg: "bg-red-500/10 border-red-500/20" },
  connecting: { label: "Conectando", color: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/20" },
  disconnected: { label: "Desconectado", color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/20" },
};

type InstanceData = {
  id: string;
  instance_name: string;
  agent_id: number;
  status: string;
  provider?: string;
  provider_config?: any;
};

type CloudForm = {
  instance_name: string;
  phone_number_id: string;
  access_token: string;
  business_account_id: string;
  verify_token: string;
  app_secret: string;
  graph_version: string;
  agent_id: number;
};

export default function WhatsAppPage() {
  const { clientId } = useClientSession();
  const [connections, setConnections] = useState<InstanceData[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<Record<string, boolean>>({});
  const [qrCodes, setQrCodes] = useState<Record<string, string>>({});
  const [statusMap, setStatusMap] = useState<Record<string, { state: string; owner?: string; profileName?: string }>>({});
  const [novaInstancia, setNovaInstancia] = useState("");
  const connectionsRef = useRef(connections);

  // === WHATSAPP CLOUD API (Meta oficial) ===
  const [cloudOpen, setCloudOpen] = useState<null | string>(null); // null=fechado, ""=criar, "<name>"=editar
  const [cloudSaving, setCloudSaving] = useState(false);
  const [cloudTesting, setCloudTesting] = useState(false);
  const [cloudMsg, setCloudMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [cloudForm, setCloudForm] = useState<CloudForm>({
    instance_name: "",
    phone_number_id: "",
    access_token: "",
    business_account_id: "",
    verify_token: "",
    app_secret: "",
    graph_version: "v21.0",
    agent_id: 1,
  });

  const openCloudDialog = async (instanceName?: string) => {
    setCloudMsg(null);
    if (!instanceName) {
      setCloudForm({
        instance_name: "",
        phone_number_id: "",
        access_token: "",
        business_account_id: "",
        verify_token: "",
        app_secret: "",
        graph_version: "v21.0",
        agent_id: 1,
      });
      setCloudOpen("");
      return;
    }
    try {
      const r = await fetch(`/api/whatsapp/cloud?instance=${encodeURIComponent(instanceName)}`);
      const d = await r.json();
      if (d.success) {
        const c = d.connection.config || {};
        setCloudForm({
          instance_name: d.connection.instance_name,
          phone_number_id: c.phone_number_id || "",
          access_token: c.access_token_preview || "",
          business_account_id: c.business_account_id || "",
          verify_token: c.verify_token || "",
          app_secret: c.app_secret_preview || "",
          graph_version: c.graph_version || "v21.0",
          agent_id: d.connection.agent_id || 1,
        });
        setCloudOpen(instanceName);
      } else {
        alert(d.error || "Erro ao carregar configuração");
      }
    } catch (e: any) {
      alert("Erro: " + e.message);
    }
  };

  const saveCloud = async () => {
    if (!cloudForm.instance_name.trim() || !cloudForm.phone_number_id.trim() || !cloudForm.access_token.trim()) {
      setCloudMsg({ kind: "err", text: "Nome da conexão, phone_number_id e access_token são obrigatórios." });
      return;
    }
    setCloudSaving(true);
    setCloudMsg(null);
    try {
      const r = await fetch("/api/whatsapp/cloud", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "save",
          instanceName: cloudForm.instance_name.trim(),
          agent_id: Number(cloudForm.agent_id) || 1,
          config: {
            phone_number_id: cloudForm.phone_number_id.trim(),
            access_token: cloudForm.access_token.trim(),
            business_account_id: cloudForm.business_account_id.trim(),
            verify_token: cloudForm.verify_token.trim(),
            app_secret: cloudForm.app_secret.trim(),
            graph_version: cloudForm.graph_version.trim() || "v21.0",
          },
        }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || "Falha ao salvar");
      setCloudMsg({ kind: "ok", text: "Conexão Cloud salva. Agora clique em Testar pra validar o token." });
      await loadData();
    } catch (e: any) {
      setCloudMsg({ kind: "err", text: e.message });
    } finally {
      setCloudSaving(false);
    }
  };

  const testCloud = async () => {
    if (!cloudForm.instance_name.trim()) return;
    setCloudTesting(true);
    setCloudMsg(null);
    try {
      const r = await fetch("/api/whatsapp/cloud", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test", instanceName: cloudForm.instance_name.trim() }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || "Falha no teste");
      setCloudMsg({
        kind: "ok",
        text: `✓ Token válido. Número: ${d.info?.display_phone_number || "?"} · Verified: ${d.info?.verified_name || "—"} · Tier: ${d.info?.messaging_limit_tier || "—"}`,
      });
    } catch (e: any) {
      setCloudMsg({ kind: "err", text: "Falha: " + e.message });
    } finally {
      setCloudTesting(false);
    }
  };

  const deleteCloud = async () => {
    if (!cloudForm.instance_name.trim()) return;
    if (!confirm(`Apagar a conexão Cloud "${cloudForm.instance_name}"?`)) return;
    setCloudSaving(true);
    try {
      await fetch("/api/whatsapp/cloud", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", instanceName: cloudForm.instance_name.trim() }),
      });
      setCloudOpen(null);
      await loadData();
    } finally {
      setCloudSaving(false);
    }
  };

  // === NGROK / URL PÚBLICA ===
  const [publicUrl, setPublicUrl] = useState("");
  const [ngrokInput, setNgrokInput] = useState("");
  const [ngrokSaving, setNgrokSaving] = useState(false);
  const [ngrokDetecting, setNgrokDetecting] = useState(false);
  const [ngrokResult, setNgrokResult] = useState<{ success: boolean; webhookUrl?: string; results?: any[] } | null>(null);

  useEffect(() => { connectionsRef.current = connections; }, [connections]);

  // ============================================================
  // PROXY (anti-ban) — por instância
  // ============================================================
  type ProxyConfig = {
    enabled: boolean;
    host?: string;
    port?: string;
    protocol?: "http" | "https" | "socks4" | "socks5";
    username?: string;
    password?: string;
  };
  const [proxyMap, setProxyMap] = useState<Record<string, ProxyConfig>>({});
  const [proxyOpen, setProxyOpen] = useState<string | null>(null); // instanceName
  const [proxyForm, setProxyForm] = useState<ProxyConfig>({ enabled: true, protocol: "http" });
  const [proxySaving, setProxySaving] = useState(false);
  const [proxyMsg, setProxyMsg] = useState<{ type: "ok" | "err"; text: string } | null>(null);

  const loadProxy = async (instanceName: string) => {
    try {
      const r = await fetch(`/api/whatsapp/proxy?instance=${encodeURIComponent(instanceName)}`, { cache: "no-store" });
      const d = await r.json();
      if (d.success) {
        // Evolution v2 retorna `{ enabled, host, port, protocol, username, password }`
        // OU às vezes embrulha em `proxy: {...}`. Cobre os dois.
        const cfg: ProxyConfig = d.proxy?.proxy || d.proxy || { enabled: false };
        setProxyMap(prev => ({ ...prev, [instanceName]: cfg }));
      }
    } catch {}
  };

  const openProxyDialog = async (instanceName: string) => {
    setProxyOpen(instanceName);
    setProxyMsg(null);
    await loadProxy(instanceName);
    const cur = proxyMap[instanceName];
    setProxyForm({
      enabled: true,
      host: cur?.host || "",
      port: cur?.port ? String(cur.port) : "",
      protocol: cur?.protocol || "http",
      username: cur?.username || "",
      password: cur?.password || "",
    });
  };

  const saveProxy = async () => {
    if (!proxyOpen) return;
    if (!proxyForm.host?.trim() || !proxyForm.port?.toString().trim()) {
      setProxyMsg({ type: "err", text: "Host e porta são obrigatórios." });
      return;
    }
    setProxySaving(true);
    setProxyMsg(null);
    try {
      const r = await fetch("/api/whatsapp/proxy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instanceName: proxyOpen,
          host: proxyForm.host.trim(),
          port: String(proxyForm.port).trim(),
          protocol: proxyForm.protocol || "http",
          username: proxyForm.username || "",
          password: proxyForm.password || "",
        }),
      });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || "Falha ao aplicar proxy");
      setProxyMsg({ type: "ok", text: "Proxy aplicado com sucesso! A instância vai sair pela rota configurada." });
      await loadProxy(proxyOpen);
    } catch (err: any) {
      setProxyMsg({ type: "err", text: err.message });
    } finally {
      setProxySaving(false);
    }
  };

  const removeProxy = async () => {
    if (!proxyOpen) return;
    if (!confirm("Remover o proxy desta instância? Ela vai voltar a sair pelo IP do servidor.")) return;
    setProxySaving(true);
    setProxyMsg(null);
    try {
      const r = await fetch(`/api/whatsapp/proxy?instance=${encodeURIComponent(proxyOpen)}`, { method: "DELETE" });
      const d = await r.json();
      if (!d.success) throw new Error(d.error || "Falha ao remover");
      setProxyForm({ enabled: false, protocol: "http", host: "", port: "", username: "", password: "" });
      setProxyMap(prev => ({ ...prev, [proxyOpen]: { enabled: false } }));
      setProxyMsg({ type: "ok", text: "Proxy removido. A instância voltou a usar o IP padrão." });
    } catch (err: any) {
      setProxyMsg({ type: "err", text: err.message });
    } finally {
      setProxySaving(false);
    }
  };

  // Carrega o status de proxy de TODAS as instâncias na primeira renderização
  useEffect(() => {
    connections.forEach(c => loadProxy(c.instance_name));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connections.length]);

  // Check status de uma instancia na Evolution API
  const checkStatus = async (instanceName: string) => {
    try {
      const res = await fetch(`/api/whatsapp?instance=${instanceName}`);
      const data = await res.json();
      let state = (data.state || data.instance?.state || "unknown").toLowerCase();
      
      // Normalização
      if (state === "connected") state = "open";
      if (state === "disconnected") state = "close";

      const owner = data.data?.instance?.owner || data.data?.owner || null;
      const profileName = data.data?.instance?.profileName || data.data?.profileName || null;
      setStatusMap(prev => ({ ...prev, [instanceName]: { state, owner, profileName } }));

      // Persiste no banco se o estado for válido
      if (state === "open" || state === "close") {
        await supabase
          .from("channel_connections")
          .update({ status: state })
          .eq("instance_name", instanceName);
      }
    } catch {
      setStatusMap(prev => ({ ...prev, [instanceName]: { state: "error" } }));
    }
  };

  // Load URL pública salva
  const loadPublicUrl = async () => {
    try {
      const res = await fetch("/api/config/ngrok");
      const data = await res.json();
      if (data.url) {
        setPublicUrl(data.url);
        setNgrokInput(data.url);
      }
    } catch {}
  };

  // Salvar URL + Registrar webhooks
  const handleSaveNgrok = async (forcedUrl?: string) => {
    const targetUrl = forcedUrl || ngrokInput.trim();
    if (!targetUrl) return alert("Digite uma URL válida");
    
    setNgrokSaving(true);
    setNgrokResult(null);
    try {
      const res = await fetch("/api/config/ngrok", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: targetUrl }),
      });
      const data = await res.json();
      if (data.success) {
        setPublicUrl(data.url);
        setNgrokInput(data.url);
        setNgrokResult({
          success: true,
          webhookUrl: data.webhookUrl,
          results: data.webhookResults,
        });
      } else {
        setNgrokResult({ success: false });
        alert("Erro: " + data.error);
      }
    } catch (err: any) {
      alert("Erro: " + err.message);
    } finally {
      setNgrokSaving(false);
    }
  };

  // Auto-detectar via API local
  const handleDetectNgrok = async () => {
    setNgrokDetecting(true);
    try {
      const res = await fetch("/api/config/ngrok?detect=true");
      const data = await res.json();
      if (data.success && data.detected) {
        setNgrokInput(data.url);
        // Já salva automaticamente para facilitar
        handleSaveNgrok(data.url);
      } else {
        alert("Não foi possível detectar um túnel Ngrok rodando localmente. Certifique-se de que o Ngrok está aberto.");
      }
    } catch (err: any) {
      alert("Erro na detecção: " + err.message);
    } finally {
      setNgrokDetecting(false);
    }
  };

  // Load tudo (connections + agents + status)
  const loadData = useCallback(async () => {
    if (!clientId) return;
    try {
      setLoading(true);
      const { data: conns } = await supabase
        .from("channel_connections")
        .select("*")
        .eq("client_id", clientId)
        .order("created_at");

      if (conns) {
        setConnections(conns);
        conns.forEach(c => checkStatus(c.instance_name));
      } else {
        setConnections([]);
      }

      const { data: agentsData } = await supabase
        .from("agent_settings")
        .select("id, name")
        .eq("client_id", clientId);
      
      if (agentsData) setAgents(agentsData);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [clientId]);

  // Roda apenas uma vez no mount (e quando clientId muda)
  useEffect(() => {
    loadData();
    loadPublicUrl();
  }, [loadData]);

  // Polling de status: checa a cada 15s usando ref
  useEffect(() => {
    const timer = setInterval(() => {
      connectionsRef.current.forEach(c => checkStatus(c.instance_name));
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  // ============================================================
  // AUTO-SYNC do webhook: assim que a instância fica "open"
  // (depois do QR escaneado), registramos o webhook automaticamente
  // pra não precisar clicar em nada. Cada instância só auto-sincroniza
  // UMA vez por sessão (memória) — o usuário pode forçar re-sync com
  // o botão manual.
  // ============================================================
  const autoSyncedRef = useRef<Set<string>>(new Set());
  // Toast leve no rodapé pra dar feedback do auto-sync (sem interromper o fluxo)
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    Object.entries(statusMap).forEach(async ([instanceName, info]) => {
      if (info?.state !== "open") return;
      if (autoSyncedRef.current.has(instanceName)) return;
      autoSyncedRef.current.add(instanceName);
      try {
        const res = await fetch("/api/webhooks/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ instanceName, appUrl: window.location.origin }),
        });
        const data = await res.json();
        if (data.success) {
          setToast({ kind: "ok", text: `🔗 Webhook sincronizado automaticamente em "${instanceName}"` });
          setTimeout(() => setToast(null), 5000);
        } else {
          setToast({ kind: "err", text: `Auto-sync falhou em "${instanceName}": ${data.error}` });
          setTimeout(() => setToast(null), 8000);
          autoSyncedRef.current.delete(instanceName); // permite tentar de novo
        }
      } catch (err: any) {
        autoSyncedRef.current.delete(instanceName);
      }
    });
  }, [statusMap]);

  const handleCreate = async () => {
    if (!novaInstancia || novaInstancia.includes(" ")) {
      return alert("Digite um nome para a instancia (sem espacos)");
    }

    const sessRes = await fetch("/api/auth/session");
    const session = await sessRes.json();
    const clientId = session?.clientId;
    if (!clientId) return alert("Sessão inválida");

    // Nome interno único para a Evolution/DB: prefixo_nome
    // Isso permite que múltiplos clientes usem o mesmo nome amigável (ex: "vendas")
    const internalName = `${clientId.substring(0, 5)}_${novaInstancia}`;

    // Verifica se ja nao existe PARA ESTE CLIENTE (ou globalmente se preferir manter UNIQUE no DB)
    const { data: existing } = await supabase
      .from("channel_connections")
      .select("id")
      .eq("instance_name", internalName)
      .single();

    if (existing) {
      return alert("Você já tem uma instancia com esse nome!");
    }

    let targetAgentId = agents.length > 0 ? agents[0].id : null;

    // Se o cliente não tem nenhum agente, cria um padrão agora pra não dar erro de vínculo
    if (!targetAgentId && clientId) {
      const { data: newAg, error: agErr } = await supabase
        .from("agent_settings")
        .insert({ 
          client_id: clientId, 
          name: "Agente Principal", 
          main_prompt: "Você é o assistente virtual oficial da empresa. Seu objetivo é qualificar leads e agendar reuniões.",
          is_active: true 
        })
        .select("id")
        .single();
      if (!agErr && newAg) targetAgentId = newAg.id;
    }

    const { error } = await supabase.from("channel_connections").insert({
      instance_name: internalName,
      agent_id: targetAgentId, 
      client_id: clientId
    });
    if (error) return alert(error.message);

    setNovaInstancia("");
    loadData();
  };

  const handleConnect = async (instanceName: string) => {
    setActionLoading(prev => ({ ...prev, [instanceName]: true }));
    try {
      const res = await fetch("/api/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "connect", instanceName })
      });
      const data = await res.json();

      if (data.success) {
        // Evolution v2 retorna code (QR raw string) ou pairingCode
        if (data.qrCode) {
          setQrCodes(prev => ({ ...prev, [instanceName]: data.qrCode }));
        } else if (data.fullData?.code) {
          setQrCodes(prev => ({ ...prev, [instanceName]: data.fullData.code }));
        }
        setStatusMap(prev => ({ ...prev, [instanceName]: { state: "connecting" } }));
        // Recarrega conexoes caso a instancia tenha sido criada
        loadData();
      } else {
        alert("Erro ao conectar: " + (data.error || "Desconhecido"));
      }
    } catch (err) {
      console.error(err);
      alert("Erro de conexao: " + (err as Error).message);
    } finally {
      setActionLoading(prev => ({ ...prev, [instanceName]: false }));
    }
  };

  const handleRestart = async (instanceName: string) => {
    setActionLoading(prev => ({ ...prev, [`${instanceName}_restart`]: true }));
    try {
      const res = await fetch("/api/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restart", instanceName })
      });
      const data = await res.json();

      if (data.success) {
        // Se reiniciou, gerar novo QR para reconectar
        if (data.qrCode) {
          setQrCodes(prev => ({ ...prev, [instanceName]: data.qrCode }));
        }
        setStatusMap(prev => ({ ...prev, [instanceName]: { state: "connecting" } }));
      } else {
        alert("Erro ao reiniciar: " + (data.error || "Desconhecido"));
      }
    } catch (err) {
      console.error(err);
      alert("Erro ao reiniciar: " + (err as Error).message);
    } finally {
      setActionLoading(prev => ({ ...prev, [`${instanceName}_restart`]: false }));
    }
  };

  const handleLogout = async (instanceName: string) => {
    setActionLoading(prev => ({ ...prev, [instanceName]: true }));
    try {
      await fetch("/api/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "logout", instanceName }),
      });
      setStatusMap(prev => ({ ...prev, [instanceName]: { state: "close" } }));
      setQrCodes(prev => ({ ...prev, [instanceName]: "" }));
    } catch (err) {
      console.error(err);
    } finally {
      setActionLoading(prev => ({ ...prev, [instanceName]: false }));
    }
  };

  const handleDelete = async (instanceName: string) => {
    if (!confirm(`Apagar a instancia "${instanceName}"? Isso remove da VPS e do sistema.`)) return;

    setActionLoading(prev => ({ ...prev, [instanceName]: true }));
    try {
      await fetch("/api/whatsapp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "delete", instanceName }),
      });
      const { error } = await supabase.from("channel_connections").delete().eq("instance_name", instanceName);
      if (error) throw error;
      alert("Instancia excluida!");
      setQrCodes(prev => {
        const copy = { ...prev };
        delete copy[instanceName];
        return copy;
      });
      loadData();
    } catch (err: any) {
      alert("Erro ao excluir: " + err.message);
    } finally {
      setActionLoading(prev => ({ ...prev, [instanceName]: false }));
    }
  };

  const updateAgentMapping = async (instanceName: string, agentId: string) => {
    await supabase.from("channel_connections").update({ agent_id: Number(agentId) }).eq("instance_name", instanceName);
    loadData();
  };

  const handleRegisterWebhook = async (instanceName: string) => {
    setActionLoading(prev => ({ ...prev, [`${instanceName}_webhook`]: true }));
    try {
      // Pega a URL atual do navegador como fallback, mas o backend prioriza o banco
      const currentOrigin = window.location.origin;

      const res = await fetch("/api/webhooks/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceName, appUrl: currentOrigin })
      });
      const data = await res.json();
      if (data.success) {
        // Marca como já sincronizada pra não disparar auto-sync de novo na mesma sessão
        autoSyncedRef.current.add(instanceName);
        setToast({ kind: "ok", text: `🔗 Webhook sincronizado em "${instanceName}" — todos os 5 eventos certos + Base64 ON.` });
        setTimeout(() => setToast(null), 6000);
      } else {
        setToast({ kind: "err", text: `Erro ao sincronizar webhook: ${data.error}` });
        setTimeout(() => setToast(null), 8000);
      }
    } catch (err: any) {
      setToast({ kind: "err", text: `Erro: ${err.message}` });
      setTimeout(() => setToast(null), 8000);
    } finally {
      setActionLoading(prev => ({ ...prev, [`${instanceName}_webhook`]: false }));
    }
  };

  const handleDiagnose = async (instanceName: string) => {
    setActionLoading(prev => ({ ...prev, [`${instanceName}_diagnose`]: true }));
    try {
      const res = await fetch(`/api/webhooks/diagnose?instance=${encodeURIComponent(instanceName)}`);
      const data = await res.json();

      const checks = (data.checks || []).map((c: any) =>
        `${c.ok ? "✓" : "✗"} [${c.step}] ${c.message}`
      ).join("\n");

      const body =
        `DIAGNÓSTICO — instância "${instanceName}"\n\n` +
        `${checks}\n\n` +
        `═══════════════════════════════════\n` +
        `VEREDITO: ${data.verdict}\n\n` +
        (data.action ? `AÇÃO: ${data.action}` : "");

      alert(body);
      console.log("[DIAGNOSE]", data);
    } catch (err: any) {
      alert("Erro no diagnóstico: " + err.message);
    } finally {
      setActionLoading(prev => ({ ...prev, [`${instanceName}_diagnose`]: false }));
    }
  };

  return (
    <div className="flex flex-col h-[100dvh] max-h-[100dvh] bg-background selection:bg-primary/30">
      <Header />
      <div className="flex-1 p-3 sm:p-6 md:p-10 space-y-4 sm:space-y-8 overflow-y-auto w-full max-w-7xl mx-auto mobile-safe-bottom">

        {/* Painel Ngrok / URL Pública (Premium) */}
        <Card className="border-white/10 bg-gradient-to-br from-purple-500/10 to-indigo-500/10 shadow-2xl glass-card overflow-hidden">
          <CardHeader className="border-b border-white/5 pb-4">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-purple-500/20 flex items-center justify-center text-purple-400">
                <Globe className="w-5 h-5" />
              </div>
              <div>
                <CardTitle className="text-base font-black text-white uppercase tracking-tighter">Configuração de Túnel (Ngrok)</CardTitle>
                <CardDescription className="text-[10px] text-muted-foreground font-medium uppercase tracking-widest">
                  Cole sua URL pública para vincular os webhooks automaticamente
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-6 space-y-6">
            <div className="flex flex-col md:flex-row gap-4">
              <div className="flex-1 space-y-2">
                 <label className="text-[10px] font-black text-purple-400 uppercase tracking-widest ml-1">URL Base do Túnel</label>
                 <Input
                   value={ngrokInput}
                   onChange={e => setNgrokInput(e.target.value)}
                   placeholder="https://sua-url-aqui.ngrok-free.app"
                   className="bg-black/40 border-white/10 h-12 font-mono text-sm rounded-xl focus:ring-purple-500/50 transition-all shadow-inner"
                 />
              </div>
              <div className="flex items-end gap-2">
                <Button
                  onClick={handleDetectNgrok}
                  disabled={ngrokDetecting || ngrokSaving}
                  variant="outline"
                  className="h-12 border-purple-500/30 hover:bg-purple-500/10 text-purple-400 gap-2 font-black text-[10px] uppercase tracking-widest px-4 rounded-xl transition-all"
                >
                  {ngrokDetecting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                  Auto-Detectar
                </Button>
                <Button
                  onClick={() => handleSaveNgrok()}
                  disabled={ngrokSaving || ngrokDetecting}
                  className="h-12 bg-purple-600 hover:bg-purple-700 text-white gap-2 font-black text-[10px] uppercase tracking-widest px-8 rounded-xl shadow-xl shadow-purple-600/20 transition-all active:scale-95 disabled:opacity-50"
                >
                  {ngrokSaving ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Sincronizando...
                    </>
                  ) : (
                    <>
                      <RefreshCw className="w-4 h-4" />
                      Salvar e Registrar Tudo
                    </>
                  )}
                </Button>
              </div>
            </div>

            {/* URL atual e Webhook para Copiar */}
            {publicUrl && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 animate-in fade-in slide-in-from-top-2 duration-500">
                <div className="flex items-center justify-between p-4 bg-black/40 rounded-2xl border border-white/5 group hover:border-purple-500/30 transition-all">
                  <div className="min-w-0">
                    <p className="text-[9px] text-purple-400 uppercase font-black tracking-[0.2em] mb-1">URL Pública Atual</p>
                    <code className="text-xs text-white/90 font-mono truncate block">{publicUrl}</code>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-9 w-9 text-muted-foreground hover:text-white rounded-xl hover:bg-white/5"
                    onClick={() => { navigator.clipboard.writeText(publicUrl); alert("URL copiada!"); }}
                  >
                    <Copy className="w-4 h-4" />
                  </Button>
                </div>

                <div className="flex items-center justify-between p-4 bg-blue-500/5 rounded-2xl border border-blue-500/10 group hover:border-blue-500/30 transition-all">
                  <div className="min-w-0">
                    <p className="text-[9px] text-blue-400 uppercase font-black tracking-[0.2em] mb-1">Webhook Padrão Gerado</p>
                    <code className="text-[xs] text-blue-200/80 font-mono truncate block">{publicUrl}/api/webhooks/whatsapp</code>
                  </div>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-9 w-9 text-blue-400 hover:bg-blue-400/10 rounded-xl"
                    onClick={() => { navigator.clipboard.writeText(`${publicUrl}/api/webhooks/whatsapp`); alert("Webhook copiado!"); }}
                  >
                    <Copy className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            )}

            {/* Resultado do registro de webhooks */}
            {ngrokResult && (
              <div className="p-4 bg-black/40 rounded-2xl border border-white/5 space-y-3 animate-in zoom-in-95 duration-300">
                <div className="flex items-center justify-between">
                   <h4 className="text-[10px] font-black text-white/60 uppercase tracking-widest">Relatório de Sincronização</h4>
                   <Badge className={cn("text-[9px] px-2 font-bold", ngrokResult.success ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400")}>
                      {ngrokResult.success ? "SUCESSO" : "ERRO"}
                   </Badge>
                </div>
                <div className="space-y-2">
                  {ngrokResult.results?.map((r: any, i: number) => (
                    <div key={i} className="flex items-center justify-between py-2 border-b border-white/5 last:border-0">
                      <div className="flex items-center gap-2">
                        {r.success ? (
                          <div className="w-5 h-5 rounded-full bg-green-500/20 flex items-center justify-center"><CheckCircle2 className="w-3 h-3 text-green-400" /></div>
                        ) : (
                          <div className="w-5 h-5 rounded-full bg-red-500/20 flex items-center justify-center"><XCircle className="w-3 h-3 text-red-400" /></div>
                        )}
                        <span className="text-xs font-bold text-white/80">{r.instance}</span>
                      </div>
                      {r.success ? (
                         <span className="text-[10px] text-green-500/60 font-medium">Webhook Vinculado</span>
                      ) : (
                         <span className="text-[10px] text-red-400 font-medium truncate max-w-[200px]">{r.error || "Erro na API"}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* ========================================================== */}
        {/* WHATSAPP CLOUD API (oficial Meta)                            */}
        {/* ========================================================== */}
        <Card className="border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 to-teal-500/5 shadow-2xl glass-card overflow-hidden">
          <CardHeader className="border-b border-white/5 pb-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center text-emerald-300">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <CardTitle className="text-base font-black text-white uppercase tracking-tighter">WhatsApp Oficial (Meta Cloud API)</CardTitle>
                  <CardDescription className="text-[10px] text-muted-foreground font-medium uppercase tracking-widest">
                    Conexão sem QR · Token permanente · Sem risco de ban · Templates HSM
                  </CardDescription>
                </div>
              </div>
              <Button
                onClick={() => openCloudDialog()}
                className="h-10 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 border border-emerald-500/30 gap-2 font-black text-xs px-4"
              >
                <Plus className="w-4 h-4" /> Nova conexão Cloud
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-6 space-y-3">
            {connections.filter(c => c.provider === "whatsapp_cloud").length === 0 ? (
              <div className="text-[12px] text-muted-foreground leading-relaxed">
                Use o WhatsApp Business Cloud quando precisar de conexão estável (sem QR), templates aprovados, ou disparo em volume.
                Você precisa de: <strong className="text-emerald-300">Phone Number ID</strong>, <strong className="text-emerald-300">Access Token</strong> (System User permanente) e um <strong className="text-emerald-300">Verify Token</strong> qualquer.
                <div className="mt-2 text-[11px] text-emerald-200/70">
                  Webhook URL para colar no Meta → <code className="text-emerald-200">{publicUrl ? `${publicUrl}/api/webhooks/whatsapp-cloud` : "<defina a URL pública acima>/api/webhooks/whatsapp-cloud"}</code>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {connections.filter(c => c.provider === "whatsapp_cloud").map(c => (
                  <div key={c.id} className="flex items-center justify-between gap-2 p-3 rounded-xl bg-black/30 border border-emerald-500/10">
                    <div className="min-w-0">
                      <div className="text-xs font-bold text-white truncate">{c.instance_name}</div>
                      <div className="text-[10px] text-emerald-300/80 font-mono truncate">PNID: {c.provider_config?.phone_number_id || "—"}</div>
                    </div>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => openCloudDialog(c.instance_name)} className="h-8 text-[11px]">Editar</Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
           <div>
             <h2 className="text-3xl font-black text-white">Conexoes WhatsApp</h2>
             <p className="text-muted-foreground mt-1">Conecte e gerencie suas instancias (Evolution API v2 e WhatsApp Cloud).</p>
           </div>

           <div className="flex bg-white/5 border border-white/10 p-2 rounded-2xl items-center gap-2">
              <Input
                value={novaInstancia}
                onChange={e => setNovaInstancia(e.target.value)}
                placeholder="nome_instancia"
                className="bg-black/50 border-white/10 h-10 w-40"
              />
              <Button onClick={handleCreate} className="h-10 glow-primary gap-2 font-bold text-xs">
                 <Plus className="w-4 h-4" /> Nova Instancia
              </Button>
           </div>
        </div>

        {/* Banner: explicar o auto-sync de webhook */}
        {connections.length > 0 && (
          <div className="mb-6 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4 flex items-start gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 shrink-0">
              <Sparkles className="w-4 h-4 text-emerald-300" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-bold text-white">Webhook sincroniza sozinho ao escanear o QR ✨</p>
              <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                Assim que a instância ficar <span className="text-emerald-300 font-bold">"open"</span> (depois do QR), o sistema configura o webhook automaticamente
                — URL pública + os 5 eventos certos + Base64 ON. Você não precisa entrar no painel da Evolution.
                O botão <strong className="text-purple-300">"Sincronizar webhook"</strong> em cada card é só pra <em>forçar</em> uma re-sincronização manual.
              </p>
            </div>
          </div>
        )}

        {loading ? (
           <div className="flex justify-center p-12 text-muted-foreground">Carregando conexoes...</div>
        ) : connections.filter(c => (c.provider || "evolution") === "evolution").length === 0 ? (
          <Card className="col-span-2 border-dashed border-2 border-white/10 bg-transparent">
            <CardContent className="p-12 text-center">
              <Smartphone className="w-12 h-12 text-muted-foreground/30 mx-auto mb-4" />
              <p className="text-muted-foreground font-medium">Nenhuma instancia cadastrada</p>
              <p className="text-sm text-muted-foreground/60 mt-1">Crie uma nova instancia para comecar.</p>
            </CardContent>
          </Card>
        ) : (
           <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
             {connections.filter(c => (c.provider || "evolution") === "evolution").map(conn => {
                let connState = (statusMap[conn.instance_name]?.state || "close").toLowerCase();
                if (connState === "connected") connState = "open";
                if (connState === "disconnected") connState = "close";
                if (connState === "connecting" || connState === "pairing") connState = "connecting";

                const statusCfg = STATUS_CONFIG[connState] || STATUS_CONFIG["close"];
                const owner = statusMap[conn.instance_name]?.owner;
                const profileName = statusMap[conn.instance_name]?.profileName;
                const hasQR = !!qrCodes[conn.instance_name];
                const isLoadingQR = actionLoading[conn.instance_name];
                const isLoadingRestart = actionLoading[`${conn.instance_name}_restart`];

                // So mostra QR se nao esta online
                const isOnline = connState === "open";

                return (
                 <Card key={conn.id} className="border-white/10 bg-white/5 shadow-xl glass-card overflow-hidden">
                   <CardHeader className="border-b border-white/5 bg-black/20 pb-4">
                     <div className="flex items-center justify-between">
                       <div className="flex items-center gap-3">
                         <div className={cn("w-10 h-10 rounded-xl flex items-center justify-center shadow-inner", isOnline ? "bg-green-500/20 text-green-400" : "bg-white/10 text-muted-foreground")}>
                            <Smartphone className="w-5 h-5" />
                         </div>
                         <div>
                            <CardTitle className="text-sm font-bold text-white flex items-center gap-2">
                               {conn.instance_name.includes("_") ? conn.instance_name.split("_").slice(1).join("_") : conn.instance_name}
                               <Badge variant="outline" className={cn("text-[9px] uppercase tracking-wider", isOnline ? "border-green-500/30 text-green-400" : "border-white/10 text-muted-foreground")}>
                                  {statusCfg.label}
                               </Badge>
                            </CardTitle>
                            {owner && <p className="text-[10px] text-muted-foreground mt-0.5 font-mono">{owner.replace("@s.whatsapp.net", "")}</p>}
                            {profileName && <p className="text-[10px] text-white/60">{profileName}</p>}
                         </div>
                       </div>

                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => handleDelete(conn.instance_name)}
                          className="text-red-500 hover:bg-red-500/10 hover:text-red-400"
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                     </div>
                   </CardHeader>
                   <CardContent className="p-6 space-y-4">

                     {/* Agente Operando */}
                     <div className="flex items-center justify-between p-4 bg-black/40 rounded-2xl border border-white/5">
                        <div className="flex items-center gap-3">
                           <Bot className="w-5 h-5 text-primary" />
                           <div className="flex flex-col">
                              <span className="text-xs font-bold text-white/80">Agente Operando</span>
                              <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-widest">Responsavel por responder</span>
                           </div>
                        </div>
                        <select
                           value={conn.agent_id || 1}
                           onChange={e => updateAgentMapping(conn.instance_name, e.target.value)}
                           className="bg-white/10 text-white text-xs font-bold px-3 py-2 border-none rounded-xl focus:ring-1 focus:ring-primary outline-none"
                        >
                           {agents.map(a => <option key={a.id} value={a.id} className="bg-neutral-900">{a.name}</option>)}
                        </select>
                     </div>

                     {/* Acoes de conexao */}
                     <div className="flex flex-col gap-2">
                        {!isOnline && (
                          <Button onClick={() => handleConnect(conn.instance_name)} disabled={isLoadingQR} className="w-full bg-primary/20 hover:bg-primary/30 text-primary border border-primary/30 gap-2 h-11 rounded-xl font-bold">
                            {isLoadingQR ? <Loader2 className="w-4 h-4 animate-spin" /> : <QrCode className="w-4 h-4" />}
                            {hasQR ? "Gerar QR Novamente" : "Gerar QR Code"}
                          </Button>
                        )}

                        {!isOnline && (connState === "close" || connState === "disconnected") && (
                          <Button onClick={() => handleRestart(conn.instance_name)} disabled={isLoadingRestart} variant="outline" className="w-full bg-orange-500/10 hover:bg-orange-500/20 text-orange-400 border border-orange-500/20 gap-2 h-10 rounded-xl font-bold text-xs">
                            <RefreshCw className="w-4 h-4" /> Reiniciar Instancia
                          </Button>
                        )}

                        {isOnline && (
                          <div className="text-center bg-green-500/10 border border-green-500/20 text-green-400 p-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2">
                             <User className="w-4 h-4" /> Conectado ({owner?.replace("@s.whatsapp.net", "") || "N/A"})
                          </div>
                        )}

                        <Button onClick={() => checkStatus(conn.instance_name)} variant="ghost" className="w-full h-9 rounded-xl text-xs font-bold text-muted-foreground hover:text-white gap-2">
                          <RefreshCw className="w-3 h-3" /> Atualizar Status
                        </Button>
                     </div>

                     {/* QR Code */}
                     {hasQR && !isOnline && (
                        <div className="flex flex-col items-center bg-black/40 p-4 rounded-2xl border border-white/5 space-y-3">
                          <div className="text-[10px] font-bold text-muted-foreground uppercase tracking-widest">Escaneie o QR Code</div>
                          <div className="bg-white p-3 rounded-xl">
                             {qrCodes[conn.instance_name]?.startsWith("data:image") ? (
                               <img
                                 src={qrCodes[conn.instance_name]}
                                 className="w-40 h-40"
                                 alt="QR Code para conectar"
                               />
                             ) : (
                               <img
                                 src={`https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(qrCodes[conn.instance_name])}`}
                                 className="w-40 h-40"
                                 alt="QR Code para conectar"
                               />
                             )}
                          </div>
                          <p className="text-[10px] text-yellow-500/70 text-center">
                            Abra o WhatsApp no celular → Aparelhos conectados → Conectar com QR Code
                          </p>
                        </div>
                     )}

                     {/* Botoes secundarios */}
                     <div className="flex gap-2">
                        <Button onClick={() => handleLogout(conn.instance_name)} variant="outline" disabled={actionLoading[conn.instance_name]} className="flex-1 h-10 rounded-xl text-xs font-bold text-red-400 border-red-500/20 hover:bg-red-500/10 gap-2">
                          <WifiOff className="w-3 h-3" /> Desconectar
                        </Button>
                        <Button
                          onClick={() => handleRegisterWebhook(conn.instance_name)}
                          disabled={actionLoading[`${conn.instance_name}_webhook`]}
                          className="flex-1 h-10 rounded-xl text-xs font-bold text-purple-400 bg-purple-500/10 hover:bg-purple-500/20 border border-purple-500/20 gap-2"
                          title="Re-registra o webhook na Evolution API (URL + 5 eventos + Base64). Acontece automático ao escanear o QR — esse botão é pra forçar."
                        >
                          {actionLoading[`${conn.instance_name}_webhook`] ? <Loader2 className="w-3 h-3 animate-spin" /> : <Link2 className="w-3 h-3" />}
                          Sincronizar webhook
                        </Button>
                     </div>
                     <Button
                        onClick={() => handleDiagnose(conn.instance_name)}
                        disabled={actionLoading[`${conn.instance_name}_diagnose`]}
                        className="w-full h-10 rounded-xl text-xs font-bold text-cyan-300 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/20 gap-2"
                        title="Descobre por que as mensagens do cliente não aparecem no chat"
                     >
                        {actionLoading[`${conn.instance_name}_diagnose`] ? <Loader2 className="w-3 h-3 animate-spin" /> : <Stethoscope className="w-3 h-3" />}
                        Diagnosticar webhook
                     </Button>

                     {/* Proxy anti-ban — por instância */}
                     {(() => {
                       const proxy = proxyMap[conn.instance_name];
                       const hasProxy = !!proxy?.enabled && !!proxy?.host;
                       return (
                         <Button
                           onClick={() => openProxyDialog(conn.instance_name)}
                           className={cn(
                             "w-full h-10 rounded-xl text-xs font-bold gap-2 border",
                             hasProxy
                               ? "text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 border-emerald-500/20"
                               : "text-amber-300 bg-amber-500/10 hover:bg-amber-500/20 border-amber-500/20"
                           )}
                           title={hasProxy ? `Sair via ${proxy?.host}:${proxy?.port}` : "Adicionar proxy pra evitar ban"}
                         >
                           {hasProxy
                             ? <><ShieldCheck className="w-3.5 h-3.5" /> Proxy ativo · {proxy?.host}:{proxy?.port}</>
                             : <><Shield className="w-3.5 h-3.5" /> Adicionar proxy (anti-ban)</>}
                         </Button>
                       );
                     })()}

                   </CardContent>
                 </Card>
                );
             })}
           </div>
        )}
      </div>

      {/* Toast de auto-sync de webhook */}
      {toast && (
        <div className={cn(
          "fixed bottom-20 lg:bottom-6 right-3 sm:right-6 z-50 max-w-sm rounded-xl px-4 py-3 shadow-2xl border backdrop-blur-md",
          "animate-in slide-in-from-bottom-2 fade-in duration-300",
          toast.kind === "ok"
            ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-100"
            : "bg-red-500/15 border-red-500/40 text-red-100"
        )}>
          <div className="flex items-start gap-2">
            {toast.kind === "ok" ? <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" /> : <XCircle className="w-4 h-4 mt-0.5 shrink-0" />}
            <p className="text-xs font-bold leading-relaxed">{toast.text}</p>
            <button onClick={() => setToast(null)} className="text-white/50 hover:text-white shrink-0"><X className="w-3.5 h-3.5" /></button>
          </div>
        </div>
      )}

      {/* ========================================================== */}
      {/* MODAL: WhatsApp Cloud API (Meta oficial)                     */}
      {/* ========================================================== */}
      <Dialog open={cloudOpen !== null} onOpenChange={(o) => !o && !cloudSaving && setCloudOpen(null)}>
        <DialogContent className="glass-card border-white/20 max-w-2xl p-0 overflow-hidden">
          <div className="p-5 border-b border-white/10 bg-gradient-to-r from-emerald-500/10 to-teal-500/5 flex items-start gap-3">
            <div className="p-2 rounded-xl bg-emerald-500/15 border border-emerald-500/30">
              <ShieldCheck className="w-5 h-5 text-emerald-300" />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base font-black text-white">
                {cloudOpen ? "Editar conexão Cloud" : "Nova conexão WhatsApp Cloud"}
              </DialogTitle>
              <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                Estes dados vêm do <strong>Meta for Developers</strong> → seu App → WhatsApp → API Setup.
                O Access Token recomendado é de <strong className="text-emerald-300">System User</strong> (permanente).
              </p>
            </div>
          </div>

          <div className="p-5 space-y-3 max-h-[70vh] overflow-y-auto">
            <div>
              <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Nome da conexão (instance_name)</label>
              <Input
                value={cloudForm.instance_name}
                onChange={e => setCloudForm({ ...cloudForm, instance_name: e.target.value })}
                placeholder="ex: cloud_principal (sem espaços)"
                disabled={!!cloudOpen}
                className="bg-black/40 border-white/10 mt-1 h-10 text-xs"
              />
              <p className="text-[10px] text-muted-foreground/60 mt-1">Usado internamente pra rotear mensagens. Não pode mudar depois.</p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Phone Number ID *</label>
                <Input
                  value={cloudForm.phone_number_id}
                  onChange={e => setCloudForm({ ...cloudForm, phone_number_id: e.target.value })}
                  placeholder="123456789012345"
                  className="bg-black/40 border-white/10 mt-1 h-10 font-mono text-xs"
                />
              </div>
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">WhatsApp Business Account ID</label>
                <Input
                  value={cloudForm.business_account_id}
                  onChange={e => setCloudForm({ ...cloudForm, business_account_id: e.target.value })}
                  placeholder="opcional"
                  className="bg-black/40 border-white/10 mt-1 h-10 font-mono text-xs"
                />
              </div>
            </div>

            <div>
              <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Access Token *</label>
              <Input
                value={cloudForm.access_token}
                onChange={e => setCloudForm({ ...cloudForm, access_token: e.target.value })}
                placeholder="EAAG..."
                type="password"
                className="bg-black/40 border-white/10 mt-1 h-10 font-mono text-xs"
              />
              <p className="text-[10px] text-muted-foreground/60 mt-1">
                Use System User Token (permanente). Tokens temporários do API Setup expiram em 24h.
              </p>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Verify Token (webhook)</label>
                <Input
                  value={cloudForm.verify_token}
                  onChange={e => setCloudForm({ ...cloudForm, verify_token: e.target.value })}
                  placeholder="qualquer-string-secreta"
                  className="bg-black/40 border-white/10 mt-1 h-10 font-mono text-xs"
                />
              </div>
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">App Secret (opcional)</label>
                <Input
                  value={cloudForm.app_secret}
                  onChange={e => setCloudForm({ ...cloudForm, app_secret: e.target.value })}
                  placeholder="pra validar X-Hub-Signature"
                  type="password"
                  className="bg-black/40 border-white/10 mt-1 h-10 font-mono text-xs"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Graph API Version</label>
                <Input
                  value={cloudForm.graph_version}
                  onChange={e => setCloudForm({ ...cloudForm, graph_version: e.target.value })}
                  placeholder="v21.0"
                  className="bg-black/40 border-white/10 mt-1 h-10 font-mono text-xs"
                />
              </div>
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Agente operando</label>
                <select
                  value={cloudForm.agent_id}
                  onChange={e => setCloudForm({ ...cloudForm, agent_id: Number(e.target.value) })}
                  className="w-full mt-1 bg-black/40 border border-white/10 text-white h-10 rounded-md text-xs px-2"
                >
                  {agents.map(a => <option key={a.id} value={a.id} className="bg-neutral-900">{a.name}</option>)}
                </select>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/20 text-[11px] text-emerald-200/90 leading-relaxed space-y-1">
              <p className="font-bold text-emerald-300">URL do webhook (cole no Meta App):</p>
              <code className="block font-mono text-[10px] break-all bg-black/30 p-2 rounded">
                {publicUrl ? `${publicUrl}/api/webhooks/whatsapp-cloud` : "<sua URL pública>/api/webhooks/whatsapp-cloud"}
              </code>
              <p>
                No painel do Meta → WhatsApp → Configuration → Webhook → cole essa URL e o <strong>Verify Token</strong> que você definir aqui.
                Inscreva nos campos: <strong>messages</strong>.
              </p>
            </div>

            {cloudMsg && (
              <div className={cn(
                "p-3 rounded-xl border text-[11px] flex items-start gap-2",
                cloudMsg.kind === "ok"
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-200"
                  : "bg-red-500/10 border-red-500/30 text-red-200"
              )}>
                {cloudMsg.kind === "ok" ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" /> : <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
                <span>{cloudMsg.text}</span>
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-2 border-t border-white/5">
              <Button onClick={saveCloud} disabled={cloudSaving} className="flex-1 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 border border-emerald-500/40 gap-2">
                {cloudSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                Salvar
              </Button>
              <Button onClick={testCloud} disabled={cloudTesting || cloudSaving} variant="outline" className="bg-blue-500/10 hover:bg-blue-500/20 text-blue-200 border-blue-500/30 gap-2">
                {cloudTesting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Stethoscope className="w-4 h-4" />}
                Testar token
              </Button>
              {cloudOpen && (
                <Button onClick={deleteCloud} disabled={cloudSaving} variant="outline" className="bg-red-500/10 hover:bg-red-500/20 text-red-300 border-red-500/30 gap-2">
                  <Trash2 className="w-4 h-4" /> Excluir
                </Button>
              )}
              <Button onClick={() => setCloudOpen(null)} variant="ghost" disabled={cloudSaving} className="text-muted-foreground gap-2">
                <X className="w-4 h-4" /> Fechar
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ========================================================== */}
      {/* MODAL: Configurar Proxy (anti-ban) por instância             */}
      {/* ========================================================== */}
      <Dialog open={!!proxyOpen} onOpenChange={(o) => !o && !proxySaving && setProxyOpen(null)}>
        <DialogContent className="glass-card border-white/20 max-w-lg p-0 overflow-hidden">
          <div className="p-5 border-b border-white/10 bg-gradient-to-r from-emerald-500/10 to-amber-500/5 flex items-start gap-3">
            <div className="p-2 rounded-xl bg-emerald-500/15 border border-emerald-500/30">
              <Shield className="w-5 h-5 text-emerald-300" />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base font-black text-white flex items-center gap-2">
                Proxy da instância <span className="font-mono text-emerald-300 text-sm">{proxyOpen}</span>
              </DialogTitle>
              <p className="text-[11px] text-muted-foreground mt-1 leading-relaxed">
                Configurar um proxy faz o WhatsApp dessa instância sair pela internet por um IP diferente do servidor.
                Reduz risco de ban quando você roda <strong>várias contas</strong> no mesmo VPS.
              </p>
            </div>
          </div>

          <div className="p-5 space-y-4">
            {proxyMap[proxyOpen || ""]?.enabled && proxyMap[proxyOpen || ""]?.host && (
              <div className="p-3 rounded-xl bg-emerald-500/5 border border-emerald-500/20 text-[11px] text-emerald-200 flex items-start gap-2">
                <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <div>
                  <p className="font-bold">Proxy atualmente ATIVO</p>
                  <p className="opacity-80 font-mono mt-0.5">
                    {proxyMap[proxyOpen || ""]?.protocol}://{proxyMap[proxyOpen || ""]?.host}:{proxyMap[proxyOpen || ""]?.port}
                  </p>
                </div>
              </div>
            )}

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Protocolo</label>
                <select
                  value={proxyForm.protocol || "http"}
                  onChange={e => setProxyForm({ ...proxyForm, protocol: e.target.value as any })}
                  className="w-full mt-1 bg-black/40 border border-white/10 text-white h-10 rounded-xl text-xs px-2"
                >
                  <option value="http">HTTP</option>
                  <option value="https">HTTPS</option>
                  <option value="socks4">SOCKS4</option>
                  <option value="socks5">SOCKS5</option>
                </select>
              </div>
              <div className="col-span-1">
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Porta</label>
                <Input
                  value={proxyForm.port || ""}
                  onChange={e => setProxyForm({ ...proxyForm, port: e.target.value })}
                  placeholder="3128"
                  className="bg-black/40 border-white/10 mt-1 h-10 font-mono text-xs"
                />
              </div>
              <div className="col-span-1">
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">&nbsp;</label>
                <div className="h-10 mt-1 flex items-center text-[10px] text-muted-foreground italic">
                  ex: 80, 443, 1080
                </div>
              </div>
            </div>

            <div>
              <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Host</label>
              <Input
                value={proxyForm.host || ""}
                onChange={e => setProxyForm({ ...proxyForm, host: e.target.value })}
                placeholder="proxy.exemplo.com  ou  189.50.10.20"
                className="bg-black/40 border-white/10 mt-1 h-10 font-mono text-xs"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                  Usuário <span className="opacity-50">(opcional)</span>
                </label>
                <Input
                  value={proxyForm.username || ""}
                  onChange={e => setProxyForm({ ...proxyForm, username: e.target.value })}
                  className="bg-black/40 border-white/10 mt-1 h-10 font-mono text-xs"
                />
              </div>
              <div>
                <label className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                  Senha <span className="opacity-50">(opcional)</span>
                </label>
                <Input
                  type="password"
                  value={proxyForm.password || ""}
                  onChange={e => setProxyForm({ ...proxyForm, password: e.target.value })}
                  className="bg-black/40 border-white/10 mt-1 h-10 font-mono text-xs"
                />
              </div>
            </div>

            {proxyMsg && (
              <div className={cn(
                "p-3 rounded-xl border text-[11px] flex items-start gap-2",
                proxyMsg.type === "ok"
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-200"
                  : "bg-red-500/10 border-red-500/30 text-red-200"
              )}>
                {proxyMsg.type === "ok" ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" /> : <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
                <span>{proxyMsg.text}</span>
              </div>
            )}

            {/* Dica visual */}
            <div className="p-3 rounded-xl bg-white/[0.02] border border-white/5 text-[10px] text-muted-foreground leading-relaxed space-y-1">
              <p className="flex items-center gap-1.5 text-amber-300/80 font-bold uppercase tracking-widest text-[9px]">
                <Sparkles className="w-3 h-3" /> Boas práticas anti-ban
              </p>
              <p>• Use proxy <strong className="text-white">residencial</strong> ou <strong className="text-white">móvel</strong> — datacenter (AWS, OVH) é facilmente detectado pelo WhatsApp.</p>
              <p>• Ideal: <strong className="text-white">1 proxy diferente por instância</strong>. Mesmo IP em várias contas = ban em massa.</p>
              <p>• Provedores: BrightData, Smartproxy, IPRoyal, Soax. Custa ~$5-15/mês por IP residencial.</p>
              <p>• Depois de aplicar, a Evolution testa o proxy automaticamente. Se a conexão cair, o proxy está bloqueado.</p>
            </div>

            <div className="flex flex-wrap gap-2 pt-2 border-t border-white/5">
              <Button
                onClick={saveProxy}
                disabled={proxySaving}
                className="flex-1 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 border border-emerald-500/40 gap-2"
              >
                {proxySaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                {proxyMap[proxyOpen || ""]?.enabled ? "Atualizar proxy" : "Aplicar proxy"}
              </Button>
              {proxyMap[proxyOpen || ""]?.enabled && (
                <Button
                  onClick={removeProxy}
                  disabled={proxySaving}
                  variant="outline"
                  className="bg-red-500/10 hover:bg-red-500/20 text-red-300 border-red-500/30 gap-2"
                >
                  <ShieldOff className="w-4 h-4" /> Remover
                </Button>
              )}
              <Button
                onClick={() => setProxyOpen(null)}
                variant="ghost"
                disabled={proxySaving}
                className="text-muted-foreground gap-2"
              >
                <X className="w-4 h-4" /> Fechar
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
