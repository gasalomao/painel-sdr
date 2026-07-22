"use client";

import { useState, useMemo } from "react";
import { cn } from "@/lib/utils";
import type { Message, MessageReaction } from "@/types";
import {
  Clock,
  Check,
  CheckCheck,
  XCircle,
  FileText,
  MapPin,
  ImageOff,
  CornerDownLeft,
  Sparkles,
} from "lucide-react";
import { format } from "date-fns";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";

interface MessageBubbleProps {
  message: Message;
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
}

function StatusIcon({ status }: { status: Message["status"] }) {
  switch (status) {
    case "sending":
      return <Clock className="h-3 w-3 text-muted-foreground" />;
    case "sent":
      return <Check className="h-3 w-3 text-muted-foreground" />;
    case "delivered":
      return <CheckCheck className="h-3 w-3 text-muted-foreground" />;
    case "read":
      return <CheckCheck className="h-3 w-3 text-blue-400 font-bold" />;
    case "failed":
      return <XCircle className="h-3 w-3 text-red-500" />;
    default:
      return null;
  }
}

function MediaUnavailable({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <ImageOff className="h-4 w-4 shrink-0 text-muted-foreground" />
      <span>{label} indisponível</span>
    </div>
  );
}

// Auxiliar para inferir mimetype do arquivo
function inferMimeType(mediaType?: string): string {
  if (!mediaType) return 'application/octet-stream';
  const mt = mediaType.toLowerCase().replace('message', '');
  if (mt.includes('image')) return 'image/jpeg';
  if (mt.includes('audio') || mt.includes('ptt')) return 'audio/ogg; codecs=opus';
  if (mt.includes('video')) return 'video/mp4';
  if (mt.includes('document') || mt.includes('pdf')) return 'application/pdf';
  if (mt.includes('sticker')) return 'image/webp';
  return 'application/octet-stream';
}

// Resolução inteligente da fonte da mídia (URL ou base64) do Painel-SDR
function resolveMediaSrc(msg: any): string | null {
  if (msg.base64_content && msg.base64_content.length > 10) {
    if (msg.base64_content.startsWith('data:')) {
      return msg.base64_content;
    }
    const mime = msg.mimetype || inferMimeType(msg.media_type || msg.content_type);
    return `data:${mime};base64,${msg.base64_content}`;
  }
  // Mapeia o campo media_url (ou direct URL no wacrm message)
  const url = msg.media_url || msg.mediaUrl;
  if (url && url.length > 5) {
    return url;
  }
  return null;
}

function MessageContent({ message }: { message: Message }) {
  const mediaSrc = useMemo(() => resolveMediaSrc(message), [message]);

  switch (message.content_type) {
    case "text":
      return (
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
          {message.content_text}
        </p>
      );

    case "image":
      return (
        <div className="space-y-1">
          {mediaSrc ? (
            <img
              src={mediaSrc}
              alt="Imagem"
              className="max-h-64 max-w-full rounded-lg object-contain bg-black/5"
              loading="lazy"
            />
          ) : (
            <MediaUnavailable label="Imagem" />
          )}
          {message.content_text && (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "video":
      return (
        <div className="space-y-1">
          {mediaSrc ? (
            <video
              src={mediaSrc}
              controls
              className="max-h-64 max-w-full rounded-lg bg-black/5"
            />
          ) : (
            <MediaUnavailable label="Vídeo" />
          )}
          {message.content_text && (
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "audio":
      // Mostra o player do áudio E a transcrição (quando disponível no content_text).
      // A transcrição vem do whisper.cpp (local, grátis) ou Gemini (fallback).
      // Sem isso, o usuário não vê o que o cliente falou no áudio.
      return (
        <div className="py-1 space-y-1">
          {mediaSrc ? (
            <audio src={mediaSrc} controls className="max-w-full outline-none" />
          ) : (
            <MediaUnavailable label="Áudio" />
          )}
          {message.content_text && (
            <div className="text-[11px] italic opacity-80 border-l-2 border-current/30 pl-2 whitespace-pre-wrap break-words">
              {message.content_text}
            </div>
          )}
        </div>
      );

    case "document":
      if (!mediaSrc) {
        return <MediaUnavailable label="Documento" />;
      }
      return (
        <a
          href={mediaSrc}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-2 rounded-lg bg-muted/50 border border-border/40 px-3 py-2 text-sm hover:bg-muted transition-colors"
        >
          <FileText className="h-5 w-5 shrink-0 text-muted-foreground" />
          <span className="truncate max-w-[200px] font-medium text-xs">
            {message.filename || message.content_text || "Documento"}
          </span>
        </a>
      );

    case "template":
      return (
        <div>
          <span className="mb-1 inline-flex items-center gap-1 rounded bg-primary/20 px-1.5 py-0.5 text-[10px] font-medium text-primary">
            Template
          </span>
          {message.content_text && (
            <p className="mt-1 whitespace-pre-wrap break-words text-sm">
              {message.content_text}
            </p>
          )}
        </div>
      );

    case "location":
      return (
        <div className="flex items-center gap-2 text-sm">
          <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>{message.content_text || "Localização compartilhada"}</span>
        </div>
      );

    case "interactive": {
      if (message.sender_type === "customer") {
        return (
          <div className="flex flex-col gap-0.5">
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              <CornerDownLeft className="h-3 w-3" />
              Resposta de Botão
            </span>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed font-medium">
              {message.content_text || "Opção selecionada"}
            </p>
          </div>
        );
      }
      return (
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
          {message.content_text}
        </p>
      );
    }

    default:
      return (
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">
          {message.content_text || "Tipo de mensagem não suportado"}
        </p>
      );
  }
}

export function MessageBubble({
  message,
  reply,
  reactions,
  currentUserId,
  onToggleReaction,
}: MessageBubbleProps) {
  const isAgent = message.sender_type === "agent" || message.sender_type === "bot";
  
  const time = useMemo(() => {
    try {
      return format(new Date(message.created_at), "HH:mm");
    } catch {
      return "";
    }
  }, [message.created_at]);

  const isAi = message.sender_type === "bot" || (message as any).is_ai;

  return (
    <div
      className={cn(
        "flex flex-col max-w-[85%] sm:max-w-[70%]",
        isAgent ? "items-end ml-auto" : "items-start mr-auto",
      )}
    >
      <div
        className={cn(
          "relative rounded-2xl px-3.5 py-2 shadow-sm border border-border/40",
          isAgent
            ? "rounded-br-none bg-primary text-primary-foreground border-transparent"
            : "rounded-bl-none bg-card text-foreground",
        )}
      >
        {isAi && (
          <div className="absolute -top-3 right-0 flex items-center gap-0.5 bg-primary/25 dark:bg-primary/30 text-[9px] font-bold text-primary dark:text-emerald-400 rounded-full px-2 py-0.5 shadow-sm">
            <Sparkles className="h-2.5 w-2.5 shrink-0" />
            IA SDR
          </div>
        )}

        {reply && (
          <ReplyQuote
            authorLabel={reply.authorLabel}
            preview={reply.preview}
            onPrimary={isAgent}
          />
        )}
        
        <MessageContent message={message} />
        
        <div
          className={cn(
            "mt-1 flex items-center gap-1.5 justify-end text-[9px]",
            isAgent ? "text-primary-foreground/75" : "text-muted-foreground"
          )}
        >
          <span>{time}</span>
          {isAgent && <StatusIcon status={message.status} />}
        </div>

        {reactions && reactions.length > 0 && (
          <div className="absolute -bottom-2 right-2">
            <MessageReactions
              reactions={reactions}
              currentUserId={currentUserId}
              onToggle={onToggleReaction || (() => {})}
            />
          </div>
        )}
      </div>
    </div>
  );
}
