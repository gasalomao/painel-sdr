"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { Header } from "@/components/layout/header";
import { supabase } from "@/lib/supabase";
import { useClientSession } from "@/lib/use-session";
import { useRealtime } from "@/hooks/use-realtime";
import { normalizeConversation } from "@/lib/inbox/conversations";
import { ConversationList } from "@/components/inbox/conversation-list";
import { MessageThread } from "@/components/inbox/message-thread";
import { ContactSidebar } from "@/components/inbox/contact-sidebar";
import type { Conversation, Message, Contact, ConversationStatus } from "@/types";
import { cn } from "@/lib/utils";
import { Wifi, WifiOff, RefreshCw, Layers, Bot } from "lucide-react";
import { useSearchParams, useRouter } from "next/navigation";

export default function ChatPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const deepLinkConvId = searchParams.get("c");

  const { clientId, loading: sessionLoading } = useClientSession();

  // Estados de conexão/instâncias e Agentes de IA
  const [instances, setInstances] = useState<any[]>([]);
  const [activeInstance, setActiveInstance] = useState<string>("__all__");
  const [aiAgents, setAiAgents] = useState<{ id: number | string; name: string }[]>([]);
  const [activeAgentId, setActiveAgentId] = useState<string>("__all__");
  const [whatsappConnected, setWhatsappConnected] = useState<boolean | null>(null);

  // Estados do Chat Inbox
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] = useState<Conversation | null>(null);
  const [activeContact, setActiveContact] = useState<Contact | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [resyncToken, setResyncToken] = useState(0);

  // Configurações do layout desktop/mobile
  const [contactPanelOpen, setContactPanelOpen] = useState(true);

  const handleToggleContactPanel = useCallback(() => {
    setContactPanelOpen((prev) => !prev);
  }, []);

  const autoSelectedForDeepLinkRef = useRef<string | null>(null);
  const activeConvRef = useRef<Conversation | null>(null);
  const visibilityDebounceRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    activeConvRef.current = activeConversation;
  }, [activeConversation]);

  // 1. Carrega as instâncias (channel_connections) e Agentes de IA (agent_settings) do SDR
  // Roda uma ÚNICA vez por clientId — agentes/instâncias raramente mudam durante
  // a sessão. O botão manual de refresh (resyncToken) dispara só o reload de
  // conversas/mensagens, evitando travamento do chat a cada troca de aba.
  const instancesLoadedRef = useRef(false);
  useEffect(() => {
    if (!clientId) return;
    if (instancesLoadedRef.current) return;
    instancesLoadedRef.current = true;
    
    async function loadChannelConnectionsAndAgents() {
      // Busca conexões do WhatsApp no Painel-SDR
      const { data: conns } = await supabase
        .from("channel_connections")
        .select("*")
        .eq("client_id", clientId)
        .order("created_at", { ascending: true });

      if (conns) {
        setInstances(conns);

        // Auto-rebind de conversas salvas por número de telefone (phone:NUMERO).
        // Disparado uma única vez quando as conexões carregam — antes rodava a
        // cada resyncToken (3-4x por minuto quando o usuário troca de aba).
        for (const inst of conns) {
          const rawPhone = inst.phone_number || inst.owner_phone || inst.instance_name;
          const cleanPhone = rawPhone ? String(rawPhone).replace(/\D/g, "") : "";
          if (cleanPhone.length >= 8) {
            try {
              await supabase
                .from("sessions")
                .update({ instance_name: inst.instance_name })
                .eq("client_id", clientId)
                .eq("instance_name", `phone:${cleanPhone}`);
            } catch { /* não-fatal — auto-rebind é best-effort */ }
          }
        }

        const hasConnected = conns.some(
          (inst) => inst.status === "open" || inst.status === "CONNECTED" || inst.status === "connected"
        );
        setWhatsappConnected(hasConnected || conns.length > 0);
      }

      // Busca Agentes de IA configurados
      const { data: agents } = await supabase
        .from("agent_settings")
        .select("id, name")
        .eq("client_id", clientId);

      if (agents) {
        setAiAgents(agents);
      }
    }
    loadChannelConnectionsAndAgents();
  }, [clientId]);

  // 2. Realtime Event Handlers
  // Observação: o hook use-realtime.ts já normaliza o sender_type pra
  // "bot" | "customer" | "agent". Não duplicar a lógica aqui.
  const handleMessageEvent = useCallback(
    (event: any) => {
      const msg = event.new;
      if (!msg) return;

      const currentActive = activeConvRef.current;

      // Sender final: prioriza o que veio do realtime mapeado; cai pra "customer".
      const senderType: "bot" | "customer" | "agent" =
        msg.sender_type === "bot" ? "bot"
        : msg.sender_type === "agent" ? "agent"
        : msg.sender_type === "human" ? "agent"
        : "customer";

      if (event.eventType === "INSERT") {
        if (currentActive && msg.remote_jid === currentActive.id) {
          setMessages((prev) => {
            // Deduplicação: otimista + webhook podem chegar na mesma msg.
            if (prev.some((m) =>
              m.id === String(msg.id) ||
              (m.message_id && msg.message_id && m.message_id === msg.message_id)
            )) return prev;
            return [...prev, {
              id: String(msg.id),
              conversation_id: msg.remote_jid,
              sender_type: senderType,
              content_type: msg.media_type || msg.message_type || "text",
              content_text: msg.content || msg.content_text || "",
              media_url: msg.media_url,
              status: msg.status_envio || msg.status || "sent",
              created_at: msg.created_at,
              is_ai: senderType === "bot"
            } as any];
          });
        }

        // Atualiza a última mensagem da conversa no card lateral.
        setConversations((prev) =>
          prev.map((c) => {
            if (c.id !== msg.remote_jid) return c;
            const isCurrent = currentActive?.id === msg.remote_jid;
            return {
              ...c,
              last_message_text: msg.content || msg.content_text || c.last_message_text,
              last_message_at: msg.created_at || c.last_message_at,
              unread_count: isCurrent ? 0 : c.unread_count + (senderType === "customer" ? 1 : 0),
            };
          })
        );
      } else if (event.eventType === "UPDATE") {
        // Update de status (sent → delivered → read) ou enriquecimento de mídia.
        if (currentActive && msg.remote_jid === currentActive.id) {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== String(msg.id) && (!m.message_id || !msg.message_id || m.message_id !== msg.message_id)) return m;
              return {
                ...m,
                status: msg.status_envio || msg.status || m.status,
                content_text: msg.content || m.content_text,
                media_url: msg.media_url || m.media_url,
                content_type: msg.media_type || msg.message_type || m.content_type,
              };
            })
          );
        }
      }
    },
    []
  );

  const handleConversationEvent = useCallback(
    (event: any) => {
      const rawSession = event.new;
      if (!rawSession) return;

      const updated = normalizeConversation(rawSession);
      const currentActive = activeConvRef.current;

      setConversations((prev: Conversation[]) => {
        const exists = prev.some((c) => c.id === updated.id);
        if (exists) {
          return prev.map((c) =>
            c.id === updated.id
              ? {
                  ...c,
                  ...updated,
                  last_message_text: updated.last_message_text || c.last_message_text,
                  unread_count: currentActive?.id === updated.id ? 0 : updated.unread_count,
                }
              : c
          );
        } else {
          if (rawSession.client_id === clientId) {
            return [updated, ...prev];
          }
          return prev;
        }
      });

      // CORREÇÃO CRÍTICA DO PISCA-PISCA: Apenas atualiza a conversa ativa se a sessão pertencer exatamente a ela!
      if (currentActive && updated.id === currentActive.id) {
        setActiveConversation((prev: Conversation | null) => (prev ? { ...prev, ...updated } : prev));
      }
    },
    [clientId]
  );

  const { isConnected } = useRealtime({
    channelName: "painel-sdr-inbox-realtime",
    onMessageEvent: handleMessageEvent,
    onConversationEvent: handleConversationEvent,
    enabled: !!clientId,
  });

  // ANTES: visibilitychange disparava resyncToken a cada foco na aba → recarregava
  // TODAS as queries (instances, agents, sessions, msgs) → chat piscava / travava.
  // AGORA: debounce de 800ms + só dispara se a aba ficou fora por >30s.
  // Realtime (Supabase) já entrega novidades instantaneamente — refresh manual
  // via botão continua disponível para o usuário.
  const lastBlurRef = useRef<number | null>(null);
  useEffect(() => {
    const handleVisibility = () => {
      const now = Date.now();
      if (document.visibilityState === "hidden") {
        lastBlurRef.current = now;
        return;
      }
      // Visível de novo: só refresh se ficou fora por >30s (evita microflickers
      // quando o usuário só dá alt-tab rapidamente).
      const wasAway = lastBlurRef.current && now - lastBlurRef.current > 30_000;
      lastBlurRef.current = null;
      if (!wasAway) return;

      // Debounce: se o usuário trocar de aba rapidamente, só dispara 1x.
      if (visibilityDebounceRef.current) clearTimeout(visibilityDebounceRef.current);
      visibilityDebounceRef.current = setTimeout(() => {
        setResyncToken((n) => n + 1);
      }, 800);
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibility);
      if (visibilityDebounceRef.current) clearTimeout(visibilityDebounceRef.current);
    };
  }, []);

  const handleConversationsLoaded = useCallback(
    (loaded: Conversation[]) => {
      setConversations(loaded);
      
      if (deepLinkConvId && autoSelectedForDeepLinkRef.current !== deepLinkConvId && loaded.length > 0) {
        autoSelectedForDeepLinkRef.current = deepLinkConvId;
        if (activeConversation?.id === deepLinkConvId) return;
        
        const match = loaded.find((c) => c.id === deepLinkConvId);
        if (match) {
          setActiveConversation(match);
          setActiveContact(match.contact ?? null);
          setMessages([]);
        }
      }
    },
    [deepLinkConvId, activeConversation?.id]
  );

  const handleSelectConversation = useCallback(
    (conv: Conversation) => {
      if (activeConversation?.id === conv.id) return;
      setActiveConversation(conv);
      setActiveContact(conv.contact ?? null);
      setMessages([]);

      setConversations((prev) =>
        prev.map((c) => (c.id === conv.id ? { ...c, unread_count: 0 } : c))
      );

      autoSelectedForDeepLinkRef.current = conv.id;
      router.replace(`/chat?c=${conv.id}`, { scroll: false });
    },
    [activeConversation?.id, router]
  );

  const handleCloseConversation = useCallback(() => {
    setActiveConversation(null);
    setActiveContact(null);
    setMessages([]);
    autoSelectedForDeepLinkRef.current = null;
    router.replace("/chat", { scroll: false });
  }, [router]);

  const handleMessagesLoaded = useCallback((loaded: Message[]) => {
    setMessages(loaded);
  }, []);

  const handleNewMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });

    // Atualiza o texto da última mensagem no card do contato
    setConversations((prev) =>
      prev.map((c) =>
        c.id === msg.conversation_id
          ? {
              ...c,
              last_message_text: msg.content_text || c.last_message_text,
              last_message_at: msg.created_at,
            }
          : c
      )
    );
  }, []);

  const handleUpdateMessage = useCallback((id: string, updates: Partial<Message>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...updates } : m)));
  }, []);

  const handleStatusChange = useCallback(
    (conversationId: string, status: ConversationStatus, extra?: { bot_status?: string; resume_at?: string | null }) => {
      const patch = {
        status,
        ...(extra?.bot_status ? { bot_status: extra.bot_status } : {}),
        ...(extra?.resume_at !== undefined ? { resume_at: extra.resume_at } : {}),
      };
      setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, ...patch } : c)));
      if (activeConversation?.id === conversationId) {
        setActiveConversation((prev: Conversation | null) => (prev ? { ...prev, ...patch } : prev));
      }
    },
    [activeConversation]
  );

  const handleContactUpdate = useCallback(
    (updatedContact: Contact) => {
      setActiveContact(updatedContact);
      setConversations((prev) =>
        prev.map((c) => (c.contact?.id === updatedContact.id ? { ...c, contact: updatedContact } : c))
      );
    },
    []
  );

  const hasActiveConv = !!activeConversation;

  if (sessionLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-2">
          <RefreshCw className="h-8 w-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground font-medium">Carregando painel de conversas...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <Header />

      {/* Seletor Global de Instâncias e Agentes de IA no Topo do Chat */}
      <div className="flex items-center justify-between border-b border-border bg-card px-4 py-2 shrink-0 flex-wrap gap-3">
        <div className="flex items-center gap-4 flex-wrap">
          {/* Filtro de Conexão WhatsApp */}
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <Layers className="h-4 w-4 text-primary shrink-0" />
            <span>Conexão WhatsApp:</span>
            <select
              value={activeInstance}
              onChange={(e) => setActiveInstance(e.target.value)}
              className="text-xs bg-muted border border-border/80 rounded-md px-2 py-1 outline-none text-foreground cursor-pointer focus:border-primary/50"
            >
              <option value="__all__">Todas as conexões</option>
              {instances.map((inst) => (
                <option key={inst.id} value={inst.instance_name}>
                  {inst.instance_name} {inst.status === "open" || inst.status === "CONNECTED" || inst.status === "connected" ? "🟢" : "🔴"}
                </option>
              ))}
            </select>
          </div>

          {/* Filtro por Agente de IA */}
          <div className="flex items-center gap-2 text-xs font-semibold text-foreground">
            <Bot className="h-4 w-4 text-primary shrink-0" />
            <span>Agente de IA:</span>
            <select
              value={activeAgentId}
              onChange={(e) => setActiveAgentId(e.target.value)}
              className="text-xs bg-muted border border-border/80 rounded-md px-2 py-1 outline-none text-foreground cursor-pointer focus:border-primary/50"
            >
              <option value="__all__">Todos os Agentes de IA</option>
              {aiAgents.map((ag) => (
                <option key={ag.id} value={String(ag.id)}>
                  {ag.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Status de Conexão Geral */}
        <div className="flex items-center gap-2">
          {whatsappConnected ? (
            <div className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
              <Wifi className="h-3 w-3" />
              WhatsApp Conectado
            </div>
          ) : (
            <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-2.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              <WifiOff className="h-3 w-3" />
              WhatsApp Desconectado
            </div>
          )}
          
          <button
            onClick={() => setResyncToken((n) => n + 1)}
            className="inline-flex items-center justify-center h-7 w-7 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground cursor-pointer"
            title="Sincronizar conversas"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Área Principal de Layout Grid Inbox */}
      <div className="flex flex-1 overflow-hidden relative">
        {/* Painel Esquerdo: Lista de Conversas */}
        <div
          className={cn(
            "h-full flex-1 lg:flex-none border-r border-border",
            hasActiveConv ? "hidden lg:flex" : "flex"
          )}
        >
          <ConversationList
            activeConversationId={activeConversation?.id ?? null}
            onSelect={handleSelectConversation}
            conversations={conversations}
            onConversationsLoaded={handleConversationsLoaded}
            resyncToken={resyncToken}
            clientId={clientId}
            activeInstance={activeInstance}
            activeAgentId={activeAgentId}
            instances={instances}
          />
        </div>

        {/* Painel Central: Thread do Chat */}
        <div
          className={cn(
            "h-full min-w-0 flex-1 lg:flex",
            hasActiveConv ? "flex" : "hidden lg:flex"
          )}
        >
          <MessageThread
            conversation={activeConversation}
            contact={activeContact}
            messages={messages}
            onMessagesLoaded={handleMessagesLoaded}
            onNewMessage={handleNewMessage}
            onUpdateMessage={handleUpdateMessage}
            onStatusChange={handleStatusChange}
            onBack={handleCloseConversation}
            resyncToken={resyncToken}
            clientId={clientId}
            activeInstance={activeInstance}
            contactPanelOpen={contactPanelOpen}
            onToggleContactPanel={handleToggleContactPanel}
          />
        </div>

        {/* Painel Direito: Detalhes CRM do Contato */}
        {contactPanelOpen && activeConversation && (
          <div className="hidden lg:block h-full">
            <ContactSidebar
              contact={activeContact}
              clientId={clientId}
              aiAgents={aiAgents}
              onContactUpdate={handleContactUpdate}
            />
          </div>
        )}
      </div>
    </div>
  );
}
