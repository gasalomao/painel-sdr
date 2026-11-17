"use client";

import { useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase"; // Import do supabase do painel-sdr
import type { RealtimeChannel } from "@supabase/supabase-js";

interface RealtimeEvent<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: Partial<T>;
}

interface UseRealtimeOptions {
  channelName: string;
  clientId?: string | null;
  onMessageEvent?: (event: RealtimeEvent<any>) => void;
  onConversationEvent?: (event: RealtimeEvent<any>) => void;
  enabled?: boolean;
}

export function useRealtime({
  channelName,
  clientId,
  onMessageEvent,
  onConversationEvent,
  enabled = true,
}: UseRealtimeOptions) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  const onMessageRef = useRef(onMessageEvent);
  const onConversationRef = useRef(onConversationEvent);
  useEffect(() => {
    onMessageRef.current = onMessageEvent;
    onConversationRef.current = onConversationEvent;
  });

  useEffect(() => {
    if (!enabled) return;

    const filterClause = clientId ? { filter: `client_id=eq.${clientId}` } : {};

    // Escuta a tabela chats_dashboard para mensagens e sessions para conversas
    const channel = supabase
      .channel(clientId ? `${channelName}-${clientId}` : channelName)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "chats_dashboard", ...filterClause },
        (payload) => {
          // Normaliza o payload para o formato esperado pelo frontend
          const raw = payload.new as any;
          if (!raw || !raw.id) return;
          if (clientId && raw.client_id !== clientId) return;

          const mappedMsg = {
            id: String(raw.id),
            // Salvamos remote_jid no payload para ajudar o inbox a identificar a conversa do contato
            remote_jid: raw.remote_jid, 
            conversation_id: raw.remote_jid, // Mapeado para remote_jid para unificação de instâncias
            // FIX multi-tenant: RLS está desligada — sem client_id o inbox de um
            // cliente recebia mensagens de OUTRO cliente com o mesmo telefone.
            client_id: raw.client_id,
            sender_type: raw.sender_type === "ai" || raw.sender_type === "bot" ? "bot" : (raw.sender_type === "customer" ? "customer" : "agent"),
            sender_id: raw.agent_id ? String(raw.agent_id) : undefined,
            content_type: raw.media_type || "text",
            content_text: raw.content || "",
            media_url: raw.media_url || undefined,
            mimetype: raw.mimetype || undefined,
            file_name: raw.file_name || undefined,
            message_id: raw.message_id,
            // Preserva status desconhecido (antes UPDATE de mídia rebaixava
            // "read" de volta pra "sent" apagando o ✓✓ azul).
            status: raw.status_envio === "sent" ? "sent" : (raw.status_envio === "delivered" ? "delivered" : (raw.status_envio === "read" ? "read" : (raw.status_envio === "error" ? "failed" : raw.status_envio ? String(raw.status_envio) : undefined))),
            created_at: raw.created_at,
          };

          onMessageRef.current?.({
            eventType: payload.eventType as RealtimeEvent<any>["eventType"],
            new: mappedMsg,
            old: payload.old,
          });
        }
      )
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "sessions", ...filterClause },
        (payload) => {
          // Normaliza o payload de sessions para Conversation
          const raw = payload.new as any;
          if (!raw || !raw.id) return;
          if (clientId && raw.client_id !== clientId) return;

          onConversationRef.current?.({
            eventType: payload.eventType as RealtimeEvent<any>["eventType"],
            new: raw, // Deixamos a página do inbox fazer a normalização completa usando normalizeConversation
            old: payload.old,
          });
        }
      )
      .subscribe((status) => {
        setIsConnected(status === "SUBSCRIBED");
      });

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
      setIsConnected(false);
    };
  }, [channelName, clientId, enabled]);

  return { isConnected };
}
