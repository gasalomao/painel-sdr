"use client";
import { useState, useRef } from "react";

type Props = {
  mediaUrl: string | null;
  mediaType: string | null;
  mediaFileName: string | null;
  mediaMimetype: string | null;
  onChange: (f: {
    mediaUrl: string | null;
    mediaType: string | null;
    mediaFileName: string | null;
    mediaMimetype: string | null;
  }) => void;
};

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB — limite máximo WhatsApp (documentos)

const TYPE_LIMITS: Record<string, number> = {
  image: 16 * 1024 * 1024,    // 16MB — WhatsApp image limit
  video: 64 * 1024 * 1024,    // 64MB — WhatsApp video limit
  audio: 16 * 1024 * 1024,    // 16MB — WhatsApp audio limit
  document: 100 * 1024 * 1024, // 100MB — WhatsApp document limit
};

const TYPE_LABELS: Record<string, string> = {
  image: "16MB (imagem)",
  video: "64MB (vídeo)",
  audio: "16MB (áudio)",
  document: "100MB (documento)",
};

function inferType(mime: string): string | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (
    mime === "application/pdf" ||
    mime.includes("document") ||
    mime.includes("spreadsheet") ||
    mime.includes("word") ||
    mime === "text/plain"
  )
    return "document";
  const extFalls: Record<string, string> = {
    jpg: "image", jpeg: "image", png: "image", gif: "image", webp: "image",
    mp4: "video", mov: "video", avi: "video", webm: "video",
    mp3: "audio", ogg: "audio", wav: "audio", m4a: "audio",
    pdf: "document", doc: "document", docx: "document", xls: "document", xlsx: "document",
  };
  return extFalls[mime.split(".").pop() || ""] || null;
}

export function MediaUploader({ mediaUrl, mediaType, mediaFileName, mediaMimetype, onChange }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const inferredType = inferType(file.type) || "document";
    const limit = TYPE_LIMITS[inferredType] || MAX_FILE_SIZE;
    if (file.size > MAX_FILE_SIZE) {
      setErr(`Arquivo de ${(file.size / 1024 / 1024).toFixed(1)}MB excede o limite máximo de 100MB do WhatsApp.`);
      return;
    }
    if (file.size > limit) {
      setErr(`Arquivo de ${(file.size / 1024 / 1024).toFixed(1)}MB excede o limite para ${inferredType === "image" ? "imagens" : inferredType === "video" ? "vídeos" : inferredType === "audio" ? "áudio" : "documentos"} (${TYPE_LABELS[inferredType]}). Tente como documento se for maior.`);
      return;
    }
    setUploading(true);
    setErr(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/upload-media", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || "Falha");
      onChange({
        mediaUrl: data.url,
        mediaType: inferType(file.type) || "image",
        mediaFileName: file.name,
        mediaMimetype: file.type,
      });
    } catch (e: any) {
      setErr(e.message || "Erro");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-1.5">
      {mediaUrl ? (
        <div className="flex items-center gap-2 bg-zinc-900/70 border border-white/10 rounded px-2 py-1.5">
          {mediaType === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={mediaUrl} alt="" className="w-10 h-10 object-cover rounded" />
          ) : (
            <span className="text-[16px]">{mediaType === "audio" ? "🎵" : mediaType === "video" ? "🎬" : "📄"}</span>
          )}
          <div className="flex-1 truncate">
            <p className="text-[11px] text-zinc-300 truncate">{mediaFileName || "file"}</p>
            <p className="text-[9px] text-zinc-500 uppercase">{mediaType || "file"}</p>
          </div>
          <button
            type="button"
            onClick={() => onChange({ mediaUrl: null, mediaType: null, mediaFileName: null, mediaMimetype: null })}
            className="text-[11px] text-red-400 hover:text-red-300"
          >
            ✕
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="w-full text-[11px] bg-zinc-900/70 border border-dashed border-white/10 hover:border-cyan-400/40 rounded px-2 py-2 text-zinc-400 hover:text-cyan-300 transition-colors"
        >
          {uploading ? "Enviando…" : "+ Escolher arquivo (até 100MB)"}
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.txt"
        onChange={handleFile}
        className="hidden"
      />
      {err && <p className="text-[10px] text-red-400">{err}</p>}
    </div>
  );
}
