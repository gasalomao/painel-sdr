"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Falha ao copiar:", err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      title="Copiar para área de transferência"
      className={cn(
        "flex items-center gap-1.5 px-2 py-1 rounded-lg text-[9px] font-black uppercase tracking-widest transition-all duration-300",
        copied
          ? "bg-green-500/20 text-green-400 border border-green-500/30 scale-105"
          : "bg-white/5 text-muted-foreground hover:bg-white/10 hover:text-white border border-white/5"
      )}
    >
      {copied ? (
        <><Check className="w-2.5 h-2.5" /> Copiado!</>
      ) : (
        <><Copy className="w-2.5 h-2.5" /> {label || "Copiar"}</>
      )}
    </button>
  );
}
