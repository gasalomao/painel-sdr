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
  onMessageEvent?: (event: RealtimeEvent<any>) => void;
  onConversationEvent?: (event: RealtimeEvent<any>) => void;
  enabled?: boolean;
}

export function useRealtime({
  channelName,
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

    // Escuta a tabela chats_dashboard para mensagens e sessions para conversas
    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "chats_dashboard" },
        (payload) => {
          // Normaliza o payload para o formato esperado pelo frontend
          const raw = payload.new as any;
          if (!raw || !raw.id) return;

          const mappedMsg = {
            id: String(raw.id),
            // Salvamos remote_jid no payload para ajudar o inbox a identificar a conversa do contato
            remote_jid: raw.remote_jid, 
            conversation_id: raw.remote_jid, // Mapeado para remote_jid para unificação de instâncias
            sender_type: raw.sender_type === "ai" || raw.sender_type === "bot" ? "bot" : (raw.sender_type === "customer" ? "customer" : "agent"),
            sender_id: raw.agent_id ? String(raw.agent_id) : undefined,
            content_type: raw.media_type || "text",
            content_text: raw.content || "",
            media_url: raw.media_url || undefined,
            mimetype: raw.mimetype || undefined,
            file_name: raw.file_name || undefined,
            message_id: raw.message_id,
            status: raw.status_envio === "sent" ? "sent" : (raw.status_envio === "delivered" ? "delivered" : (raw.status_envio === "read" ? "read" : (raw.status_envio === "error" ? "failed" : "sent"))),
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
        { event: "*", schema: "public", table: "sessions" },
        (payload) => {
          // Normaliza o payload de sessions para Conversation
          const raw = payload.new as any;
          if (!raw || !raw.id) return;

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
  }, [channelName, enabled]);

  return { isConnected };
}
