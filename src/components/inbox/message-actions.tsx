"use client";

import { useState, type ReactNode } from "react";
import { CornerUpLeft, Copy, SmilePlus } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { Message } from "@/types";

const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

interface MessageActionsProps {
  message: Message;
  onReply: () => void;
  onReact: (emoji: string) => void;
  children: ReactNode;
}

export function MessageActions({
  message,
  onReply,
  onReact,
  children,
}: MessageActionsProps) {
  const [touchOpen, setTouchOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const isAgent =
    message.sender_type === "agent" || message.sender_type === "bot";

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setTouchOpen(true);
  };

  const handleCopy = async () => {
    const text = message.content_text ?? "";
    if (!text) {
      toast.error("Não há texto para copiar.");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Texto copiado!");
    } catch {
      toast.error("Falha ao copiar texto.");
    }
    setTouchOpen(false);
  };

  const handlePickEmoji = (emoji: string) => {
    onReact(emoji);
    setPickerOpen(false);
    setTouchOpen(false);
  };

  const handleReply = () => {
    onReply();
    setTouchOpen(false);
  };

  return (
    <div
      className={cn(
        "flex w-full",
        isAgent ? "justify-end" : "justify-start",
      )}
      onContextMenu={handleContextMenu}
      onBlur={() => setTouchOpen(false)}
    >
      <div className="group/actions relative min-w-0 max-w-[75%]">
        {children}
        <div
          data-touch-open={touchOpen || pickerOpen ? "true" : undefined}
          className={cn(
            "absolute -top-3 z-10 flex h-7 items-center gap-0.5 rounded-full border border-border bg-popover/95 px-1 shadow-md backdrop-blur-sm transition-opacity outline-none",
            "opacity-0 group-hover/actions:opacity-100 group-focus-within/actions:opacity-100",
            "data-[touch-open=true]:opacity-100",
            isAgent ? "right-3" : "left-3",
          )}
        >
          <DropdownMenu open={pickerOpen} onOpenChange={setPickerOpen}>
            <DropdownMenuTrigger
              className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground hover:bg-muted hover:text-foreground cursor-pointer outline-none"
              aria-label="Reagir"
            >
              <SmilePlus className="h-3.5 w-3.5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              className="flex w-auto flex-row gap-1 p-1.5 border-border bg-popover"
              sideOffset={6}
              align="start"
            >
              {QUICK_EMOJIS.map((e) => (
                <button
                  key={e}
                  type="button"
                  onClick={() => handlePickEmoji(e)}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none transition-transform hover:scale-125 hover:bg-muted cursor-pointer"
                  aria-label={`Reagir com ${e}`}
                >
                  {e}
                </button>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            onClick={handleReply}
            className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground hover:bg-muted hover:text-foreground cursor-pointer"
            aria-label="Responder"
          >
            <CornerUpLeft className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={handleCopy}
            className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground hover:bg-muted hover:text-foreground cursor-pointer"
            aria-label="Copiar texto"
          >
            <Copy className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
