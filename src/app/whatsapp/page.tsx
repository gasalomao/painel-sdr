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
  WifiOff, User, CheckCircle2, XCircle, Copy, Sparkles, Stethoscope,
  Shield, ShieldCheck, ShieldOff, X, ChevronDown, Settings2,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import styles from "./whatsapp.module.css";
import { cn } from "@/lib/utils";
import { useClientSession } from "@/lib/use-session";

const STATUS_CONFIG: Record<string, { label: string; color: string; bg: string }> = {
  open: { label: "Conectado", color: "text-green-400", bg: "bg-green-500/10 border-green-500/20" },
  close: { label: "Desconectado", color: "text-red-400", bg: "bg-red-500/10 border-red-500/20" },
  connecting: { label: "Conectando", color: "text-yellow-400", bg: "bg-yellow-500/10 border-yellow-500/20" },
  disconnected: { label: "Desconectado", color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/20" },
  error: { label: "Falha na consulta", color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/20" },
  unknown: { label: "Não verificado", color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/20" },
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
  // Ngrok/túnel é config rara — accordion fechado por default. Cliente leigo
  // não precisa pensar nisso pra escanear QR. Só abre se quiser mexer.
  const [ngrokExpanded, setNgrokExpanded] = useState(false);

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

      // Estado igual ao anterior → nem atualiza estado nem bate no banco
      // (o poll roda a cada 15s por instância; sem isso é 1 UPDATE ocioso por tick).
      if (statusMap[instanceName]?.state === state) return;
      setStatusMap(prev => ({ ...prev, [instanceName]: { state, owner, profileName } }));

      // Persiste no banco se o estado for válido - escopado por client_id
      // pra não atualizar instância de outro tenant caso RLS esteja frouxa.
      if (state === "open" || state === "close") {
        let q = supabase
          .from("channel_connections")
          .update({ status: state })
          .eq("instance_name", instanceName);
        if (clientId) q = q.eq("client_id", clientId);
        await q;
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
      // SECURITY: nunca select("*" — provider_config carrega webhook_secret e
      // possíveis API keys que não podem ir pro browser.
      // ponytail: phone_number/owner_phone/updated_at não existem na tabela
      // (owner_phone vive em provider_config->owner_phone) — selecioná-los
      // faz o Postgres errar 42703 e a lista vir vazia.
      const { data: conns, error: connsErr } = await supabase
          .from("channel_connections")
          // provider_config->phone_number_id: extrai SÓ o campo de exibição do
          // JSON — webhook_secret continua fora do browser.
          .select("id, instance_name, client_id, agent_id, status, created_at, provider, provider_config->phone_number_id")
          .eq("client_id", clientId)
          .order("created_at");

      if (connsErr) console.error("[WhatsApp] Falha ao carregar conexões:", connsErr.message);

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
      // Ao conectar, o servidor vincula um Agente de IA automaticamente
      // (auto-link-agent). Recarrega as conexões pra o select "Agente
      // Operando" já mostrar o agente certo sem precisar dar F5.
      setTimeout(() => { loadData(); }, 3500);
    });
  }, [statusMap, loadData]);

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

    // Verifica se ja nao existe PARA ESTE CLIENTE — filtra por tenant pra não
    // colidir com instância de outro cliente que tenha o mesmo nome interno.
    let existQ = supabase
      .from("channel_connections")
      .select("id")
      .eq("instance_name", internalName);
    if (clientId) existQ = existQ.eq("client_id", clientId);
    const { data: existing } = await existQ.maybeSingle();

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
    // PASSO 1: confirmação básica — modo PRESERVAR mensagens é o padrão
    // (recomendado pra quem vai reconectar o mesmo número depois).
    if (!confirm(
      `Apagar a instância "${instanceName}"?\n\n` +
      `MODO PADRÃO (recomendado):\n` +
      `  ✓ Remove a instância da Evolution VPS\n` +
      `  ✓ Remove a instância do sistema\n` +
      `  ✓ PRESERVA todas as mensagens — quando você reconectar\n` +
      `     o mesmo número, o histórico volta a aparecer\n\n` +
      `Confirmar?`
    )) return;

    // PASSO 2: opt-in pra purge total
    const purgeAll = confirm(
      `🔥 Quer ZERAR TUDO?\n\n` +
      `OK = apaga TAMBÉM todas as mensagens dessa instância (irreversível).\n` +
      `CANCELAR = mantém o histórico (recomendado).`
    );

    setActionLoading(prev => ({ ...prev, [instanceName]: true }));
    try {
      const res = await fetch("/api/whatsapp/instance/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instanceName, force: true, purgeMessages: purgeAll }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error || d.message || "Falha ao apagar");
      const dd = d.deleted || {};
      alert(
        `✓ Instância excluída.\n\n` +
        (purgeAll
          ? `Mensagens apagadas: ${dd.chats || 0}\nSessões apagadas: ${dd.sessions || 0}\nLogs apagados: ${dd.logs || 0}`
          : `📦 Mensagens PRESERVADAS: ${dd.preserved_chats || 0}\n` +
            `Sessões preservadas: ${dd.preserved_sessions || 0}\n\n` +
            `Reconecte o mesmo número quando quiser — o histórico volta automaticamente.`) +
        (d.evolution ? "" : "\n\n⚠ Evolution VPS não respondeu, mas o sistema foi atualizado.")
      );
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
    let q = supabase.from("channel_connections").update({ agent_id: Number(agentId) }).eq("instance_name", instanceName);
    if (clientId) q = q.eq("client_id", clientId);
    await q;
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

  const handleSyncPhotos = async (instanceName: string) => {
    setActionLoading(prev => ({ ...prev, [`${instanceName}_sync_photos`]: true }));
    try {
      const res = await fetch("/api/contacts/sync-avatars", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance: instanceName }),
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setToast({
          kind: "ok",
          text: data.updated > 0 ? `✓ ${data.updated} fotos de perfil atualizadas!` : "✓ Fotos sincronizadas com o WhatsApp!",
        });
      } else {
        setToast({ kind: "err", text: `Falha: ${data.error || "Erro ao sincronizar fotos"}` });
      }
    } catch (err: any) {
      setToast({ kind: "err", text: `Erro: ${err?.message || "Falha na rede"}` });
    } finally {
      setActionLoading(prev => ({ ...prev, [`${instanceName}_sync_photos`]: false }));
    }
  };

  const qrConnections = connections.filter(c => !c.provider || c.provider === "evolution" || c.provider === "evolution_go");
  const onlineCount = qrConnections.filter(c => statusMap[c.instance_name]?.state === "open").length;

  const advancedSettings = (
    <div className={styles.integrations}>

        {/* Painel Ngrok / URL Pública — ACCORDION fechado por default.
            Configuração avançada, raramente mexida. Cliente leigo nunca
            precisa abrir. Quando aberto, mostra o editor completo. */}
        <Card className={styles.tunnelPanel}>
          <button
            type="button"
            onClick={() => setNgrokExpanded(v => !v)}
            className={styles.tunnelToggle}
            aria-expanded={ngrokExpanded}
            aria-controls="tunnel-settings"
          >
            <div className="w-9 h-9 rounded-xl bg-purple-500/10 ring-1 ring-purple-500/20 flex items-center justify-center text-purple-300 shrink-0">
              <Settings2 className="w-4 h-4" />
            </div>
            <div className="flex-1 min-w-0">
              <p className={styles.panelTitle}>URL pública e webhooks</p>
              {publicUrl ? (
                <p className="text-[11px] text-muted-foreground truncate flex items-center gap-1.5 mt-0.5">
                  <CheckCircle2 className="w-3 h-3 text-emerald-400 shrink-0" />
                  Túnel configurado: <code className="font-mono text-white/80">{publicUrl.replace(/^https?:\/\//, "")}</code>
                </p>
              ) : (
                <p className="text-xs text-amber-200 mt-1">Confira a URL pública para receber mensagens.</p>
              )}
            </div>
            <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform shrink-0", ngrokExpanded && "rotate-180")} />
          </button>

          {ngrokExpanded && (
            <div id="tunnel-settings" className={styles.tunnelBody}>
              <p className="text-[11px] text-muted-foreground leading-relaxed">
                A URL pública é onde a Evolution envia os webhooks (mensagens chegando). Em produção
                (Easypanel/VPS) já vem configurada. Em dev, use ngrok ou similar.
              </p>

              <div className="flex flex-col md:flex-row gap-3">
                <div className="flex-1 space-y-1.5">
                  <label htmlFor="tunnel-url" className="text-[10px] font-black text-purple-300 uppercase tracking-widest ml-1">URL Base do Túnel</label>
                  <Input id="tunnel-url"
                    value={ngrokInput}
                    onChange={e => setNgrokInput(e.target.value)}
                    placeholder="https://sua-url-aqui.easypanel.host"
                    className="bg-black/40 border-white/10 h-11 font-mono text-sm rounded-xl focus:ring-purple-500/40 transition-all"
                  />
                </div>
                <div className="flex items-end gap-2">
                  <Button
                    onClick={handleDetectNgrok}
                    disabled={ngrokDetecting || ngrokSaving}
                    variant="outline"
                    className="h-11 border-purple-500/30 hover:bg-purple-500/10 text-purple-300 gap-2 font-bold text-[10px] uppercase tracking-widest px-4 rounded-xl"
                  >
                    {ngrokDetecting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
                    Auto-Detectar
                  </Button>
                  <Button
                    onClick={() => handleSaveNgrok()}
                    disabled={ngrokSaving || ngrokDetecting}
                    className="h-11 bg-purple-600 hover:bg-purple-500 text-white gap-2 font-bold text-[10px] uppercase tracking-widest px-5 rounded-xl shadow-lg shadow-purple-600/20"
                  >
                    {ngrokSaving ? (
                      <><Loader2 className="w-3.5 h-3.5 animate-spin" />Sincronizando…</>
                    ) : (
                      <><RefreshCw className="w-3.5 h-3.5" />Salvar e Registrar</>
                    )}
                  </Button>
                </div>
              </div>

              {publicUrl && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div className="flex items-center justify-between p-3 bg-black/30 rounded-xl border border-white/5">
                    <div className="min-w-0">
                      <p className="text-[9px] text-purple-300 uppercase font-black tracking-[0.2em] mb-0.5">URL Pública</p>
                      <code className="text-xs text-white/90 font-mono truncate block">{publicUrl}</code>
                    </div>
                    <Button size="icon" variant="ghost" aria-label="Copiar URL pública" className="h-8 w-8 text-muted-foreground hover:text-white rounded-lg"
                      onClick={() => { navigator.clipboard.writeText(publicUrl); alert("URL copiada!"); }}>
                      <Copy className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-blue-500/5 rounded-xl border border-blue-500/10">
                    <div className="min-w-0">
                      <p className="text-[9px] text-blue-300 uppercase font-black tracking-[0.2em] mb-0.5">Webhook Padrão</p>
                      <code className="text-xs text-blue-200/80 font-mono truncate block">{publicUrl}/api/webhooks/whatsapp</code>
                    </div>
                    <Button size="icon" variant="ghost" aria-label="Copiar URL do webhook" className="h-8 w-8 text-blue-400 hover:bg-blue-400/10 rounded-lg"
                      onClick={() => { navigator.clipboard.writeText(`${publicUrl}/api/webhooks/whatsapp`); alert("Webhook copiado!"); }}>
                      <Copy className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
              )}

              {ngrokResult && (
                <div className="p-3 bg-black/30 rounded-xl border border-white/5 space-y-2">
                  <div className="flex items-center justify-between">
                    <h4 className="text-[10px] font-black text-white/60 uppercase tracking-widest">Resultado da Sincronização</h4>
                    <Badge className={cn("text-[9px] px-2 font-bold", ngrokResult.success ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400")}>
                      {ngrokResult.success ? "SUCESSO" : "ERRO"}
                    </Badge>
                  </div>
                  <div className="space-y-1">
                    {ngrokResult.results?.map((r: any, i: number) => (
                      <div key={i} className="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0">
                        <div className="flex items-center gap-2">
                          {r.success ? (
                            <CheckCircle2 className="w-3.5 h-3.5 text-green-400" />
                          ) : (
                            <XCircle className="w-3.5 h-3.5 text-red-400" />
                          )}
                          <span className="text-xs font-bold text-white/80">{r.instance}</span>
                        </div>
                        {r.success
                          ? <span className="text-[10px] text-green-500/60 font-medium">Vinculado ✓</span>
                          : <span className="text-[10px] text-red-400 font-medium truncate max-w-[200px]">{r.error || "Erro"}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>

        {/* ========================================================== */}
        {/* WHATSAPP CLOUD API (oficial Meta)                            */}
        {/* ========================================================== */}
        <Card className={styles.cloudPanel}>
          <CardHeader className="border-b border-white/5 pb-4">
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center text-emerald-300">
                  <ShieldCheck className="w-5 h-5" />
                </div>
                <div>
                  <CardTitle className={styles.panelTitle}>WhatsApp Oficial · Meta Cloud API</CardTitle>
                  <CardDescription className={styles.panelDescription}>
                    Conecte pela API da Meta, sem escanear QR Code.
                  </CardDescription>
                </div>
              </div>
              <Button
                onClick={() => openCloudDialog()}
                className={styles.secondaryAction}
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
                  Webhook URL para colar no Meta → <code className="text-emerald-200">{publicUrl ? `${publicUrl}/api/webhooks/whatsapp-cloud` : "<defina a URL pública nas configurações>/api/webhooks/whatsapp-cloud"}</code>
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

    </div>
  );

  return (
    <div className={cn(styles.page, "flex flex-col h-[100dvh] max-h-[100dvh]")}>
      <Header />
      <div className={styles.content}>
        <div className={styles.heading}>
          <div>
            <h2>Suas conexões de WhatsApp</h2>
            <p>Conecte seus números e escolha o agente responsável por cada atendimento.</p>
          </div>
          <Button variant="outline" onClick={() => loadData()} disabled={loading} className={styles.secondaryAction}>
            <RefreshCw className={cn("w-4 h-4", loading && "animate-spin")} aria-hidden="true" />
            {loading ? "Atualizando…" : "Atualizar"}
          </Button>
        </div>

        <section className={styles.setup} aria-labelledby="new-connection-title">
          <div className={styles.setupIntro}>
            <h3 id="new-connection-title">Conecte um número</h3>
            <p>Dê um nome à conexão. Depois, escaneie o QR Code com o WhatsApp do celular.</p>
          </div>
          <form className={styles.createForm} onSubmit={e => { e.preventDefault(); handleCreate(); }}>
            <label htmlFor="connection-name">Nome da conexão</label>
            <div className={styles.createRow}>
              <Input id="connection-name" value={novaInstancia} onChange={e => setNovaInstancia(e.target.value)}
                placeholder="Ex.: comercial" aria-describedby="connection-name-help" className={styles.field} />
              <Button type="submit" className={styles.primaryAction}><Plus className="w-4 h-4" aria-hidden="true" /> Criar conexão</Button>
            </div>
            <p id="connection-name-help">Use um nome sem espaços para identificar este número.</p>
          </form>
        </section>

        <div className={styles.listHeading}>
          <h3>Conexões por QR Code <span>{qrConnections.length}</span></h3>
          <p role="status">{loading ? "Consultando conexões…" : `${onlineCount} ${onlineCount === 1 ? "conectada" : "conectadas"} de ${qrConnections.length}`} · atualização automática</p>
        </div>

        {loading ? (
          <div className={styles.empty} role="status"><Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" /> Carregando conexões…</div>
        ) : qrConnections.length === 0 ? (
          <div className={styles.empty}>
            <QrCode className="w-8 h-8" aria-hidden="true" />
            <h3>Seu primeiro número começa aqui</h3>
            <p>Crie uma conexão acima para gerar o QR Code. No celular, abra o WhatsApp e acesse <strong>Aparelhos conectados</strong>.</p>
          </div>
        ) : (
           <div className={styles.connectionGrid}>
             {qrConnections.map(conn => {
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
                 <Card key={conn.id} className={styles.connection}>
                   <CardHeader className={styles.connectionHeader}>
                     <div className={styles.identity}>
                       <Smartphone className="w-5 h-5" aria-hidden="true" />
                       <div>
                         <CardTitle className={styles.connectionName}>
                           {conn.instance_name.includes("_") ? conn.instance_name.split("_").slice(1).join("_") : conn.instance_name}
                         </CardTitle>
                         <p>{owner?.replace("@s.whatsapp.net", "") || (isOnline ? "Número não informado" : "Nenhum número conectado")}</p>
                         {profileName && <p>{profileName}</p>}
                       </div>
                     </div>
                     <span className={styles.status} data-state={connState}>{statusCfg.label}</span>
                   </CardHeader>
                   <CardContent className={styles.connectionBody}>
                     <div className={styles.agentField}>
                       <label htmlFor={`agent-${conn.id}`}><Bot className="w-4 h-4" aria-hidden="true" /> Agente responsável</label>
                       <select id={`agent-${conn.id}`} value={conn.agent_id || 1}
                         onChange={e => updateAgentMapping(conn.instance_name, e.target.value)} className={styles.field}>
                         {agents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                       </select>
                     </div>
                     {isOnline ? (
                       <div className={styles.connectedState} role="status"><CheckCircle2 className="w-5 h-5" aria-hidden="true" /><div><strong>WhatsApp conectado</strong><p>Conexão estabelecida com este número.</p></div></div>
                     ) : (
                       <div className={styles.connectAction}>
                         <p>{hasQR ? "Escaneie o código abaixo para concluir." : "Conecte o celular para começar a receber mensagens."}</p>
                         <Button onClick={() => handleConnect(conn.instance_name)} disabled={isLoadingQR} className={styles.primaryAction}>
                           {isLoadingQR ? <Loader2 className="w-4 h-4 animate-spin" /> : <QrCode className="w-4 h-4" />}
                           {isLoadingQR ? "Gerando QR Code…" : hasQR ? "Gerar novo QR Code" : "Conectar com QR Code"}
                         </Button>
                       </div>
                     )}
                     {hasQR && !isOnline && (
                       <div className={styles.qrPanel}>
                         <strong>Escaneie com o WhatsApp do celular</strong>
                         <div className={styles.qrImage}>
                           <img src={qrCodes[conn.instance_name]?.startsWith("data:image") ? qrCodes[conn.instance_name] : `https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(qrCodes[conn.instance_name])}`}
                             width={200} height={200} alt={`QR Code para conectar ${conn.instance_name}`} />
                         </div>
                         <p>Abra <strong>Aparelhos conectados</strong> no WhatsApp e toque em <strong>Conectar aparelho</strong>.</p>
                       </div>
                     )}
                     <Button onClick={() => checkStatus(conn.instance_name)} variant="ghost" className={styles.statusAction}>
                       <RefreshCw className="w-4 h-4" aria-hidden="true" /> Verificar conexão
                     </Button>
                   </CardContent>
                   <details className={styles.maintenance}>
                     <summary><Settings2 className="w-4 h-4" aria-hidden="true" /> Gerenciar conexão <ChevronDown className="w-4 h-4" aria-hidden="true" /></summary>
                     <div className={styles.maintenanceActions}>
                       <Button onClick={() => handleSyncPhotos(conn.instance_name)} variant="outline" disabled={actionLoading[`${conn.instance_name}_sync_photos`]} className={styles.secondaryAction}>
                         <User className="w-4 h-4" aria-hidden="true" /> {actionLoading[`${conn.instance_name}_sync_photos`] ? "Sincronizando…" : "Sincronizar fotos"}
                       </Button>
                       <Button onClick={() => handleRegisterWebhook(conn.instance_name)} disabled={actionLoading[`${conn.instance_name}_webhook`]} variant="outline" className={styles.secondaryAction}>
                         {actionLoading[`${conn.instance_name}_webhook`] ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />} Sincronizar webhook
                       </Button>
                       <Button onClick={() => handleDiagnose(conn.instance_name)} disabled={actionLoading[`${conn.instance_name}_diagnose`]} variant="outline" className={styles.secondaryAction}>
                         {actionLoading[`${conn.instance_name}_diagnose`] ? <Loader2 className="w-4 h-4 animate-spin" /> : <Stethoscope className="w-4 h-4" />} Diagnosticar webhook
                       </Button>
                       <Button onClick={() => openProxyDialog(conn.instance_name)} variant="outline" className={styles.secondaryAction}>
                         <Shield className="w-4 h-4" aria-hidden="true" /> {proxyMap[conn.instance_name]?.enabled && proxyMap[conn.instance_name]?.host ? "Proxy ativo · Configurar" : "Configurar proxy"}
                       </Button>
                       {!isOnline && (connState === "close" || connState === "disconnected") && (
                         <Button onClick={() => handleRestart(conn.instance_name)} disabled={isLoadingRestart} variant="outline" className={styles.secondaryAction}>
                           <RefreshCw className={cn("w-4 h-4", isLoadingRestart && "animate-spin")} aria-hidden="true" /> Reiniciar instância
                         </Button>
                       )}
                       <Button onClick={() => handleLogout(conn.instance_name)} variant="outline" disabled={actionLoading[conn.instance_name]} className={styles.dangerAction}>
                         <WifiOff className="w-4 h-4" aria-hidden="true" /> Desconectar
                       </Button>
                       <Button onClick={() => handleDelete(conn.instance_name)} variant="ghost" disabled={actionLoading[conn.instance_name]} className={styles.dangerAction}>
                         <Trash2 className="w-4 h-4" aria-hidden="true" /> Excluir conexão
                       </Button>
                     </div>
                   </details>
                 </Card>
                );
             })}
           </div>
        )}

        <p className={styles.syncNote}><CheckCircle2 className="w-4 h-4" aria-hidden="true" /> Ao conectar pelo QR Code, a sincronização das mensagens é configurada automaticamente.</p>
        <section className={styles.advancedSection} aria-labelledby="integrations-title">
          <div className={styles.sectionHeading}>
            <h3 id="integrations-title">Outras formas de conectar e configurações</h3>
            <p>API oficial da Meta e ajustes técnicos. Sua conexão por QR Code continua acima.</p>
          </div>
          {advancedSettings}
        </section>
      </div>

      {/* Toast de auto-sync de webhook */}
      {toast && (
        <div className={styles.toast} data-kind={toast.kind} role={toast.kind === "err" ? "alert" : "status"}>
          {toast.kind === "ok" ? <CheckCircle2 className="w-4 h-4" aria-hidden="true" /> : <XCircle className="w-4 h-4" aria-hidden="true" />}
          <p>{toast.text}</p>
          <button type="button" onClick={() => setToast(null)} aria-label="Fechar aviso"><X className="w-4 h-4" aria-hidden="true" /></button>
        </div>
      )}

      {/* ========================================================== */}
      {/* MODAL: WhatsApp Cloud API (Meta oficial)                     */}
      {/* ========================================================== */}
      <Dialog open={cloudOpen !== null} onOpenChange={(o) => !o && !cloudSaving && setCloudOpen(null)}>
        <DialogContent className={styles.dialog}>
          <div className={styles.dialogHeader}>
            <ShieldCheck className="w-5 h-5" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <DialogTitle>{cloudOpen ? "Editar conexão Cloud" : "Nova conexão WhatsApp Cloud"}</DialogTitle>
              <DialogDescription>Encontre as credenciais em Meta for Developers, no seu app, em WhatsApp e API Setup. Use o Access Token de System User para uma conexão permanente.</DialogDescription>
            </div>
          </div>

          <div className={styles.dialogBody}>
            <div>
              <label htmlFor="cloud-name" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Nome da conexão (instance_name)</label>
              <Input id="cloud-name"
                value={cloudForm.instance_name}
                onChange={e => setCloudForm({ ...cloudForm, instance_name: e.target.value })}
                placeholder="ex: cloud_principal (sem espaços)"
                disabled={!!cloudOpen}
                className="bg-black/40 border-white/10 mt-1 h-10 text-xs"
              />
              <p className="text-[10px] text-muted-foreground/60 mt-1">Usado internamente pra rotear mensagens. Não pode mudar depois.</p>
            </div>

            <div className={styles.formGrid}>
              <div>
                <label htmlFor="cloud-phone" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Phone Number ID *</label>
                <Input id="cloud-phone"
                  value={cloudForm.phone_number_id}
                  onChange={e => setCloudForm({ ...cloudForm, phone_number_id: e.target.value })}
                  placeholder="123456789012345"
                  className="bg-black/40 border-white/10 mt-1 h-10 font-mono text-xs"
                />
              </div>
              <div>
                <label htmlFor="cloud-business" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">WhatsApp Business Account ID</label>
                <Input id="cloud-business"
                  value={cloudForm.business_account_id}
                  onChange={e => setCloudForm({ ...cloudForm, business_account_id: e.target.value })}
                  placeholder="opcional"
                  className="bg-black/40 border-white/10 mt-1 h-10 font-mono text-xs"
                />
              </div>
            </div>

            <div>
              <label htmlFor="cloud-access" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Access Token *</label>
              <Input id="cloud-access"
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

            <div className={styles.formGrid}>
              <div>
                <label htmlFor="cloud-verify" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Verify Token (webhook)</label>
                <Input id="cloud-verify"
                  value={cloudForm.verify_token}
                  onChange={e => setCloudForm({ ...cloudForm, verify_token: e.target.value })}
                  placeholder="qualquer-string-secreta"
                  className="bg-black/40 border-white/10 mt-1 h-10 font-mono text-xs"
                />
              </div>
              <div>
                <label htmlFor="cloud-secret" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">App Secret (opcional)</label>
                <Input id="cloud-secret"
                  value={cloudForm.app_secret}
                  onChange={e => setCloudForm({ ...cloudForm, app_secret: e.target.value })}
                  placeholder="pra validar X-Hub-Signature"
                  type="password"
                  className="bg-black/40 border-white/10 mt-1 h-10 font-mono text-xs"
                />
              </div>
            </div>

            <div className={styles.formGrid}>
              <div>
                <label htmlFor="cloud-version" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Graph API Version</label>
                <Input id="cloud-version"
                  value={cloudForm.graph_version}
                  onChange={e => setCloudForm({ ...cloudForm, graph_version: e.target.value })}
                  placeholder="v21.0"
                  className="bg-black/40 border-white/10 mt-1 h-10 font-mono text-xs"
                />
              </div>
              <div>
                <label htmlFor="cloud-agent" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Agente operando</label>
                <select id="cloud-agent"
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
              <div role="status" className={cn(
                "p-3 rounded-xl border text-[11px] flex items-start gap-2",
                cloudMsg.kind === "ok"
                  ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-200"
                  : "bg-red-500/10 border-red-500/30 text-red-200"
              )}>
                {cloudMsg.kind === "ok" ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0 mt-0.5" /> : <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />}
                <span>{cloudMsg.text}</span>
              </div>
            )}

            <div className={styles.formActions}>
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
        <DialogContent className={styles.dialog}>
          <div className={styles.dialogHeader}>
            <Shield className="w-5 h-5" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <DialogTitle>Configurar proxy · {proxyOpen}</DialogTitle>
              <DialogDescription>Configuração técnica opcional. Altera o endereço IP usado por esta conexão, sem mudar as demais.</DialogDescription>
            </div>
          </div>

          <div className={styles.dialogBody}>
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

            <div className={styles.formGrid}>
              <div>
                <label htmlFor="proxy-protocol" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Protocolo</label>
                <select id="proxy-protocol"
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
                <label htmlFor="proxy-port" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Porta</label>
                <Input id="proxy-port"
                  value={proxyForm.port || ""}
                  onChange={e => setProxyForm({ ...proxyForm, port: e.target.value })}
                  placeholder="3128"
                  className="bg-black/40 border-white/10 mt-1 h-10 font-mono text-xs"
                />
              </div>
            </div>

            <div>
              <label htmlFor="proxy-host" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">Host</label>
              <Input id="proxy-host"
                value={proxyForm.host || ""}
                onChange={e => setProxyForm({ ...proxyForm, host: e.target.value })}
                placeholder="proxy.exemplo.com  ou  189.50.10.20"
                className="bg-black/40 border-white/10 mt-1 h-10 font-mono text-xs"
              />
            </div>

            <div className={styles.formGrid}>
              <div>
                <label htmlFor="proxy-username" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                  Usuário <span className="opacity-50">(opcional)</span>
                </label>
                <Input id="proxy-username"
                  value={proxyForm.username || ""}
                  onChange={e => setProxyForm({ ...proxyForm, username: e.target.value })}
                  className="bg-black/40 border-white/10 mt-1 h-10 font-mono text-xs"
                />
              </div>
              <div>
                <label htmlFor="proxy-password" className="text-[10px] font-black uppercase tracking-widest text-muted-foreground">
                  Senha <span className="opacity-50">(opcional)</span>
                </label>
                <Input id="proxy-password"
                  type="password"
                  value={proxyForm.password || ""}
                  onChange={e => setProxyForm({ ...proxyForm, password: e.target.value })}
                  className="bg-black/40 border-white/10 mt-1 h-10 font-mono text-xs"
                />
              </div>
            </div>

            {proxyMsg && (
              <div role="status" className={cn(
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

            <div className={styles.formActions}>
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
