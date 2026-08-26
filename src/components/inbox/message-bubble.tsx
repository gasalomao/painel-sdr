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
  Trash2,
  AudioLines,
} from "lucide-react";
import { format } from "date-fns";
import { ReplyQuote } from "./reply-quote";
import { MessageReactions } from "./message-reactions";
import { transcriptionProviderLabel, extractProviderFromMime } from "@/lib/transcription-label";

interface MessageBubbleProps {
  message: Message;
  reply?: { authorLabel: string; preview: string } | null;
  reactions?: MessageReaction[];
  currentUserId?: string;
  onToggleReaction?: (emoji: string) => void;
  onDelete?: (messageId: string) => void;
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
// FIX: media_url PRIMEIRO — base64 de MBs forçava decode/render pesado a cada
// render mesmo com URL leve disponível.
function resolveMediaSrc(msg: any): string | null {
  const url = msg.media_url || msg.mediaUrl;
  if (url && url.length > 5) {
    return url;
  }
  if (msg.base64_content && msg.base64_content.length > 10) {
    if (msg.base64_content.startsWith('data:')) {
      return msg.base64_content;
    }
    const mime = msg.mimetype || inferMimeType(msg.media_type || msg.content_type);
    return `data:${mime};base64,${msg.base64_content}`;
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
      // A transcrição vem do whisper.cpp (local, grátis), OpenRouter ou Gemini (fallback).
      // Badge discreto abaixo indica QUAL modelo transcreveu — só visual,
      // essa info nunca entra no contexto do agente de IA.
      const rawProvider = (message as any).transcription_provider || extractProviderFromMime((message as any).mimetype);
      const isTranscribed = message.content_text && message.content_text.startsWith("🎤");
      const transcribedWith = transcriptionProviderLabel(rawProvider) || (isTranscribed ? "Áudio transcrito" : null);

      return (
        <div className="py-1 space-y-1.5">
          {mediaSrc ? (
            <audio src={mediaSrc} controls className="max-w-full outline-none" />
          ) : (
            <MediaUnavailable label="Áudio" />
          )}
          {message.content_text && (
            <div className="text-[11px] italic opacity-85 border-l-2 border-primary/40 pl-2.5 py-0.5 whitespace-pre-wrap break-words bg-black/10 rounded-r-md">
              {message.content_text}
            </div>
          )}
          {transcribedWith && (
            <div className="pt-0.5">
              <span
                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-mono tracking-tight text-muted-foreground/80 bg-white/5 border border-white/5 select-none"
                title={`Áudio transcrito com: ${transcribedWith}`}
              >
                <AudioLines className="h-2.5 w-2.5 text-primary/70" aria-hidden />
                {transcribedWith}
              </span>
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
  onDelete,
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
        "group/msg relative flex flex-col max-w-[85%] sm:max-w-[70%]",
        isAgent ? "items-end ml-auto" : "items-start mr-auto",
      )}
    >
      {/* Badge "IA" como HEADER ACIMA do balão (não sobre o texto). */}
      {isAi && (
        <div className={cn(
          "flex items-center gap-1 mb-1 text-[10px] font-semibold",
          isAgent ? "justify-end text-primary dark:text-emerald-400" : "text-primary"
        )}>
          <Sparkles className="h-3 w-3 shrink-0" />
          <span>IA</span>
        </div>
      )}

      <div
        className={cn(
          "relative rounded-2xl px-3.5 py-2 shadow-sm border border-border/40",
          isAgent
            ? "rounded-br-none bg-primary text-primary-foreground border-transparent"
            : "rounded-bl-none bg-card text-foreground",
        )}
      >
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
      {onDelete && (
        <button
          onClick={() => {
            if (window.confirm("Deletar esta mensagem do painel?")) {
              onDelete(message.id);
            }
          }}
          className={cn(
            "absolute top-0 opacity-0 group-hover/msg:opacity-100 focus:opacity-100 transition-opacity p-1 rounded-md bg-card/95 backdrop-blur border border-border shadow-sm text-muted-foreground hover:text-destructive hover:bg-destructive/10 z-10",
            isAgent ? "-left-8" : "-right-8"
          )}
          aria-label="Deletar mensagem"
          title="Deletar mensagem"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
