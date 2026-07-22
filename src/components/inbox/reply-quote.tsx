"use client";

import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Message } from "@/types";

export interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
}

interface ReplyQuoteProps {
  authorLabel: string;
  preview: string;
  onDismiss?: () => void;
  onPrimary?: boolean;
}

export function ReplyQuote({
  authorLabel,
  preview,
  onDismiss,
  onPrimary = false,
}: ReplyQuoteProps) {
  const isChip = !!onDismiss;
  return (
    <div
      className={cn(
        "flex items-start gap-2 border-l-2 px-2 py-1",
        onPrimary ? "border-primary-foreground/50" : "border-primary",
        isChip
          ? "rounded-md bg-muted/80"
          : onPrimary
            ? "mb-1.5 rounded-md bg-primary-foreground/15"
            : "mb-1.5 rounded-md bg-background/20",
      )}
    >
      <div className="min-w-0 flex-1 overflow-hidden">
        <div
          className={cn(
            "truncate text-[11px] font-medium",
            onPrimary ? "text-primary-foreground" : "text-primary",
          )}
        >
          {authorLabel}
        </div>
        <div className="whitespace-pre-wrap break-words text-xs text-foreground/80">
          {preview}
        </div>
      </div>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Cancelar resposta"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

/** Constrói o texto do rascunho de resposta (quote) */
export function buildReplyPreview(message: Message): string {
  if (message.content_text) return message.content_text;
  switch (message.content_type) {
    case "image":
      return "📷 Foto";
    case "video":
      return "🎥 Vídeo";
    case "audio":
      return "🎤 Áudio";
    case "document":
      return "📄 Documento";
    case "location":
      return "📍 Localização";
    case "template":
      return "Template";
    default:
      return "Mensagem";
  }
}
