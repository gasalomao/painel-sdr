"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabase";
import type { Conversation, Contact, Message, ConversationStatus } from "@/types";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { MessageBubble } from "./message-bubble";
import { MessageComposer, SendMediaPayload } from "./message-composer";
import { AiThreadBanner } from "./ai-thread-banner";
import { ReplyDraft } from "./reply-quote";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  ArrowLeft,
  Phone,
  MoreVertical,
  CheckCircle2,
  Clock,
  XCircle,
  PanelRightOpen,
  PanelRightClose,
  Bot
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface MessageThreadProps {
  conversation: Conversation | null;
  contact: Contact | null;
  messages: Message[];
  onMessagesLoaded: (messages: Message[]) => void;
  onNewMessage: (message: Message) => void;
  onUpdateMessage: (id: string, updates: Partial<Message>) => void;
  onStatusChange: (conversationId: string, status: ConversationStatus) => void;
  onBack?: () => void;
  resyncToken?: number;
  clientId: string | null;
  activeInstance?: string;
  contactPanelOpen?: boolean;
  onToggleContactPanel?: () => void;
}

// Normaliza registros de chats_dashboard para formato Message do wacrm
function normalizeDbMessage(raw: any): Message {
  const isFromMe =
    raw.is_from_me === true ||
    raw.from_me === true ||
    raw.sender_type === "ai" ||
    raw.sender_type === "bot" ||
    raw.sender_type === "human" ||
    raw.sender_type === "agent" ||
    raw.sender === "human" ||
    raw.sender === "ai" ||
    raw.sender === "bot";

  const isAi =
    raw.sender_type === "ai" ||
    raw.sender_type === "bot" ||
    raw.sender === "ai" ||
    raw.sender === "bot" ||
    raw.is_ai === true;

  return {
    id: String(raw.id),
    conversation_id: raw.remote_jid,
    sender_type: isFromMe ? (isAi ? "bot" : "agent") : "customer",
    sender_id: raw.agent_id ? String(raw.agent_id) : undefined,
    content_type: raw.media_type || raw.message_type || "text",
    content_text: raw.content || "",
    media_url: raw.media_url || undefined,
    mimetype: raw.mimetype || undefined,
    file_name: raw.file_name || undefined,
    message_id: raw.message_id,
    status:
      raw.status_envio === "sent"
        ? "sent"
        : raw.status_envio === "delivered"
        ? "delivered"
        : raw.status_envio === "read"
        ? "read"
        : raw.status_envio === "error"
        ? "failed"
        : "sent",
    created_at: raw.created_at,
    base64_content: raw.base64_content,
    media_type: raw.media_type,
    is_ai: isAi,
  } as any;
}

export function MessageThread({
  conversation,
  contact,
  messages,
  onMessagesLoaded,
  onNewMessage,
  onUpdateMessage,
  onStatusChange,
  onBack,
  resyncToken = 0,
  clientId,
  activeInstance = "__all__",
  contactPanelOpen = true,
  onToggleContactPanel,
}: MessageThreadProps) {
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);

  const onMessagesLoadedRef = useRef(onMessagesLoaded);
  useEffect(() => {
    onMessagesLoadedRef.current = onMessagesLoaded;
  });

  const conversationId = conversation?.id; // remoteJid
  const hasUnread = (conversation?.unread_count ?? 0) > 0;

  // Resolve o instanceName de envio da mensagem
  const getSendInstanceName = useCallback(() => {
    if (activeInstance && activeInstance !== "__all__") return activeInstance;
    if (conversation?.last_instance) return conversation.last_instance;
    if ((conversation as any)?.instance_name) return (conversation as any).instance_name;
    return "sdr";
  }, [activeInstance, conversation]);

  // Carrega mensagens do chats_dashboard
  useEffect(() => {
    if (!conversationId || !clientId) return;
    let cancelled = false;

    (async () => {
      setLoading(true);
      const { data, error } = await supabase
        .from("chats_dashboard")
        .select("*")
        .eq("client_id", clientId)
        .eq("remote_jid", conversationId)
        .order("created_at", { ascending: false })
        .limit(100);

      if (cancelled) return;

      if (error) {
        console.error("Erro ao carregar mensagens do chat:", error);
        setLoading(false);
        return;
      }

      const normalized = (data ?? []).reverse().map(normalizeDbMessage);
      onMessagesLoadedRef.current(normalized);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationId, clientId, resyncToken]);

  // Marca como lido no banco ao abrir a conversa.
  // ANTES: rodava mesmo quando contact_id era vazio → update em todas sessions
  // sem contact_id (catastrófico em clientes grandes).
  const contactId = conversation?.contact_id;
  useEffect(() => {
    if (!clientId || !contactId || !hasUnread) return;

    (async () => {
      await supabase
        .from("sessions")
        .update({ unread_count: 0 })
        .eq("client_id", clientId)
        .eq("contact_id", contactId);
    })();
  }, [clientId, contactId, hasUnread]);

  // Scroll automático para a última mensagem.
  //
  // BUG HISTÓRICO RESOLVIDO: o `ref` estava sendo passado para o componente
  // <ScrollArea> (Root do Base UI), mas o scroll acontece num elemento INTERNO
  // (Viewport, marcado com `data-slot="scroll-area-viewport"`). Por isso
  // `scrollRef.current.scrollTop` não fazia nada → o chat abria no meio.
  //
  // Solução: usar callback ref que captura o Viewport real. Além disso,
  // aguardamos o próximo paint (requestAnimationFrame + setTimeout duplo)
  // para garantir que o DOM está totalmente renderizado antes de scrollar.
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = scrollViewportRef.current;
    if (!el) return;
    // scrollTop alvo: final do conteúdo.
    const target = el.scrollHeight;
    // Aplica 2x com rAF — alguns navegadores precisam de 2 frames pra recalcular
    // a altura após imagens/mídias carregarem.
    requestAnimationFrame(() => {
      if (!scrollViewportRef.current) return;
      scrollViewportRef.current.scrollTo({ top: target, behavior });
      requestAnimationFrame(() => {
        if (!scrollViewportRef.current) return;
        scrollViewportRef.current.scrollTo({ top: scrollViewportRef.current.scrollHeight, behavior });
      });
    });
  }, []);

  // Callback ref: busca o elemento Viewport dentro do ScrollArea.
  const scrollAreaRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      scrollViewportRef.current = null;
      return;
    }
    // O Viewport é o elemento com `data-slot="scroll-area-viewport"`.
    const viewport = node.querySelector('[data-slot="scroll-area-viewport"]') as HTMLDivElement | null;
    scrollViewportRef.current = viewport || node;
    // Scroll imediato ao montar/trocar de conversa.
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  }, []);

  // Quando carrega mensagens OU troca de conversa → scroll pro fim.
  useEffect(() => {
    scrollToBottom("auto");
  }, [messages, conversationId, loading, scrollToBottom]);

  // Envio de mensagem de texto simples pelo compositor
  const handleSend = useCallback(
    async (text: string) => {
      if (!conversationId || !clientId || !text.trim()) return;

      const instName = getSendInstanceName();
      setSending(true);

      try {
        const res = await fetch("/api/send-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            remoteJid: conversationId,
            text,
            instanceName: instName,
          }),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error || "Falha ao enviar mensagem via WhatsApp.");
          return;
        }

        const now = new Date().toISOString();
        const optimisticMsg: Message = {
          id: data.msgId || `temp-${Date.now()}`,
          conversation_id: conversationId,
          sender_type: "agent",
          content_type: "text",
          content_text: text,
          status: "sent",
          created_at: now,
          message_id: data.msgId,
        };

        onNewMessage(optimisticMsg);
        setReplyTo(null);
        // Scroll suave pro fim pra ver a mensagem que acabou de ser enviada.
        scrollToBottom("smooth");

        // Ao responder manualmente, silencia o robô por 60 min para atendimento humano
        void fetch("/api/agent/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "snooze",
            durationMinutes: 60,
            remoteJid: conversationId,
            instanceName: instName,
          }),
        }).catch(() => {});
      } catch (err: any) {
        toast.error("Erro de conexão ao enviar mensagem: " + err.message);
      } finally {
        setSending(false);
      }
    },
    [conversationId, clientId, getSendInstanceName, onNewMessage, scrollToBottom]
  );

  // Envio de mensagens com mídia (Imagem, Áudio, Vídeo, Documentos)
  const handleSendMedia = useCallback(
    async (payload: SendMediaPayload) => {
      if (!conversationId || !clientId) return;

      const instName = getSendInstanceName();
      setSending(true);

      try {
        const type = payload.kind === "document" ? "document" : payload.kind;
        const res = await fetch("/api/send-message", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            remoteJid: conversationId,
            text: payload.caption || "",
            instanceName: instName,
            media: {
              type,
              base64: payload.base64,
              fileName: payload.filename,
              mimetype: payload.mimetype,
            },
          }),
        });

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          toast.error(data.error || "Falha ao enviar arquivo via WhatsApp.");
          return;
        }

        const now = new Date().toISOString();
        const optimisticMsg: Message = {
          id: data.msgId || `temp-${Date.now()}`,
          conversation_id: conversationId,
          sender_type: "agent",
          content_type: type as any,
          content_text: payload.caption || payload.filename || "Arquivo",
          status: "sent",
          created_at: now,
          message_id: data.msgId,
          media_url: payload.base64,
          base64_content: payload.base64,
        } as any;

        onNewMessage(optimisticMsg);
        toast.success("Arquivo enviado!");
        scrollToBottom("smooth");
      } catch (err: any) {
        toast.error("Erro ao processar mídia: " + err.message);
      } finally {
        setSending(false);
      }
    },
    [conversationId, clientId, getSendInstanceName, onNewMessage, scrollToBottom]
  );

  const handleUpdateStatus = useCallback(
    async (newStatus: ConversationStatus) => {
      if (!conversation || !clientId) return;
      try {
        // Mapeia novo status do wacrm para bot_status do painel-sdr:
        // open -> bot_paused (humano atende)
        // pending -> bot_active (ia atende)
        // closed -> closed
        const botStatus = newStatus === "open" ? "bot_paused" : (newStatus === "pending" ? "bot_active" : "closed");

        const { error } = await supabase
          .from("sessions")
          .update({ bot_status: botStatus })
          .eq("client_id", clientId)
          .eq("contact_id", conversation.contact_id);

        if (error) throw error;

        onStatusChange(conversation.id, newStatus);
        toast.success(`Status da conversa alterado para: ${newStatus === "open" ? "Humano (Aberto)" : (newStatus === "pending" ? "Robô (Aguardando)" : "Fechado")}`);

        // Atualiza na API de controle do agente
        const instName = getSendInstanceName();
        const action = botStatus === "bot_active" ? "resume" : "pause";
        await fetch("/api/agent/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action,
            remoteJid: conversationId,
            instanceName: instName,
          }),
        }).catch(() => {});
      } catch (err: any) {
        toast.error("Erro ao alterar status: " + err.message);
      }
    },
    [conversation, clientId, onStatusChange, getSendInstanceName, conversationId]
  );

  if (!conversation) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center bg-card p-8 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted text-muted-foreground mb-4 border border-border">
          <Bot className="h-8 w-8 text-primary" />
        </div>
        <h3 className="text-lg font-semibold text-foreground">Nenhuma conversa selecionada</h3>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm">
          Selecione um contato na lista à esquerda para visualizar o histórico de mensagens, controlar o robô de IA e gerenciar oportunidades.
        </p>
      </div>
    );
  }

  const displayName = contact?.name || contact?.phone || "Desconhecido";
  const initials = displayName.charAt(0).toUpperCase();

  return (
    <div className="flex h-full w-full flex-col bg-background min-w-0">
      {/* Cabeçalho do Chat */}
      <div className="flex h-14 items-center justify-between border-b border-border bg-card px-4 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          {onBack && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 lg:hidden text-muted-foreground"
              onClick={onBack}
            >
              <ArrowLeft className="h-4 w-4" />
            </Button>
          )}

          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium text-foreground relative">
            {contact?.avatar_url ? (
              <img
                src={contact.avatar_url}
                alt={displayName}
                className="h-9 w-9 rounded-full object-cover"
              />
            ) : (
              initials
            )}
          </div>

          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-semibold text-foreground">
              {displayName}
            </h2>
            <p className="text-[10px] text-muted-foreground truncate font-mono">
              Conexão: {conversation.last_instance || "Padrão"}
            </p>
          </div>
        </div>

        {/* Menu de Ações e Troca de Status */}
        <div className="flex items-center gap-1.5 shrink-0">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-center h-8 px-2.5 gap-1.5 text-xs font-medium rounded-md bg-muted text-foreground hover:bg-muted/80 transition-colors outline-none cursor-pointer">
              {conversation.status === "open" ? (
                <>
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
                  <span>Humano (Aberto)</span>
                </>
              ) : conversation.status === "pending" ? (
                <>
                  <Clock className="h-3.5 w-3.5 text-amber-500" />
                  <span>Aguardando Robô</span>
                </>
              ) : (
                <>
                  <XCircle className="h-3.5 w-3.5 text-muted-foreground" />
                  <span>Fechado</span>
                </>
              )}
            </DropdownMenuTrigger>

            <DropdownMenuContent align="end" className="border-border bg-popover">
              <DropdownMenuItem
                onClick={() => handleUpdateStatus("open")}
                className="text-xs text-popover-foreground cursor-pointer"
              >
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 mr-2" />
                Marcar como Humano (Aberto)
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => handleUpdateStatus("pending")}
                className="text-xs text-popover-foreground cursor-pointer"
              >
                <Clock className="h-3.5 w-3.5 text-amber-500 mr-2" />
                Marcar como Aguardando Robô
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => handleUpdateStatus("closed")}
                className="text-xs text-popover-foreground cursor-pointer"
              >
                <XCircle className="h-3.5 w-3.5 text-muted-foreground mr-2" />
                Marcar como Fechado
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {onToggleContactPanel && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-foreground hidden lg:flex"
              onClick={onToggleContactPanel}
              title={contactPanelOpen ? "Ocultar Painel Lateral" : "Exibir Painel Lateral"}
            >
              {contactPanelOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </Button>
          )}
        </div>
      </div>

      {/* Banner de Controle de IA */}
      <AiThreadBanner
        conversationId={conversation.id}
        botStatus={conversation.bot_status || (conversation.status === "pending" ? "bot_active" : "bot_paused")}
        resumeAt={conversation.resume_at || null}
        instanceName={getSendInstanceName()}
        onChange={(patch) => {
          onStatusChange(
            conversation.id,
            patch.bot_status === "bot_active" ? "pending" : "open",
            { bot_status: patch.bot_status, resume_at: patch.resume_at }
          );
        }}
      />

      {/* Área de Histórico das Mensagens */}
      <div className="flex-1 overflow-hidden relative bg-muted/20">
        <ScrollArea ref={scrollAreaRef} className="h-full p-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          ) : messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-xs text-muted-foreground">Nenhuma mensagem neste chat.</p>
              <p className="text-[11px] text-muted-foreground/70 mt-1">Envie uma mensagem abaixo para iniciar a conversa.</p>
            </div>
          ) : (
            <div className="flex flex-col space-y-3 max-w-4xl mx-auto w-full">
              {messages.map((msg) => (
                <MessageBubble
                  key={msg.id}
                  message={msg}
                  currentUserId={clientId || undefined}
                />
              ))}
            </div>
          )}
        </ScrollArea>
      </div>

      {/* Compositor de Mensagens */}
      <MessageComposer
        onSend={handleSend}
        onSendMedia={handleSendMedia}
        sending={sending}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
      />
    </div>
  );
}
