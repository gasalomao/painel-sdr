"use client";

import styles from "./inbox.module.css";

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  KeyboardEvent,
} from "react";
import {
  Send,
  Paperclip,
  Image as ImageIcon,
  Video,
  FileText,
  Mic,
  Square,
  X,
  Loader2,
  Sparkles,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { ReplyQuote } from "./reply-quote";

export type ComposerMediaKind = "image" | "video" | "document" | "audio";

export interface SendMediaPayload {
  kind: ComposerMediaKind;
  base64: string;
  filename?: string;
  mimetype?: string;
  caption?: string;
  replyToId?: string;
}

interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
}

const PICKER_ACCEPT: Record<ComposerMediaKind, string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
  audio:
    "audio/*,audio/mpeg,audio/mp3,audio/wav,audio/ogg,audio/x-m4a,audio/m4a,audio/aac,audio/webm,audio/opus,audio/flac",
};

interface MediaDraft {
  kind: ComposerMediaKind;
  mediaUrl: string; // Usado para renderizar o preview local (data URL)
  base64: string;   // Dados em base64 puros
  filename: string;
  mimetype?: string;
  caption: string;
}

interface MessageComposerProps {
  conversationId?: string;
  sessionExpired?: boolean;
  onSend: (text: string, replyToId?: string) => void;
  onSendMedia?: (payload: SendMediaPayload) => void;
  sending?: boolean;
  replyTo?: ReplyDraft | null;
  onClearReply?: () => void;
  onCancelReply?: () => void;
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const OPUS_ENCODER_PATH = "/opus/encoderWorker.min.js";
const MAX_RECORDING_SECONDS = 5 * 60; // 5 minutos máximo

export function MessageComposer({
  conversationId,
  sessionExpired,
  onSend,
  onSendMedia,
  sending: externalSending,
  replyTo,
  onClearReply,
  onCancelReply,
}: MessageComposerProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState<MediaDraft | null>(null);
  const [busy, setBusy] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef<MediaDraft | null>(null);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // Limpa o rascunho ao trocar de conversa
  useEffect(() => {
    setDraft(null);
    setText("");
  }, [conversationId]);

  // Redimensiona o textarea automaticamente
  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, []);

  const handleTextChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setText(e.target.value);
      adjustHeight();
    },
    [adjustHeight]
  );

  // Enviar mensagem de texto
  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || sessionExpired) return;

    setSending(true);
    try {
      await onSend(trimmed, replyTo?.id);
      setText("");
      adjustHeight();
    } catch {
      // FIX: falha de rede/HTTP NÃO limpa o rascunho — operador podia perder
      // um pitch longo. O toast de erro já é mostrado pelo handleSend da thread.
      // Texto preservado pra reenviar/editar.
    } finally {
      setSending(false);
    }
  }, [text, sending, sessionExpired, onSend, replyTo?.id, adjustHeight]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend]
  );

  // ---- Gravação de Mídia para Base64 no Navegador ----

  const stageUpload = useCallback(
    async (kind: ComposerMediaKind, file: File) => {
      const max = 25 * 1024 * 1024; // Limite de 25MB
      if (file.size > max) {
        toast.error(`O arquivo excede o tamanho limite de 25 MB.`);
        return;
      }

      setBusy(true);
      try {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          const base64Data = result.split(",")[1];
          setDraft({
            kind,
            mediaUrl: result,
            base64: base64Data,
            filename: file.name,
            mimetype: file.type || (kind === "audio" ? "audio/mpeg" : undefined),
            caption: "",
          });
        };
        reader.onerror = () => {
          toast.error("Falha ao ler o arquivo.");
        };
        reader.readAsDataURL(file);
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const handlePicked = useCallback(
    (kind: ComposerMediaKind, file: File | undefined) => {
      if (file) void stageUpload(kind, file);
    },
    [stageUpload]
  );

  // ---- Gravação de Áudio via opus-recorder ----

  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const recorderRef = useRef<any | null>(null);
  const recordTimerRef = useRef<NodeJS.Timeout | null>(null);

  const finalizeRecording = useCallback(
    async (bytes: Uint8Array) => {
      const file = new File([bytes as unknown as BlobPart], `voice-${Date.now()}.ogg`, {
        type: "audio/ogg",
      });
      if (file.size === 0) return;

      setBusy(true);
      try {
        const reader = new FileReader();
        reader.onloadend = () => {
          const result = reader.result as string;
          const base64Data = result.split(",")[1];
          setDraft({
            kind: "audio",
            mediaUrl: result,
            base64: base64Data,
            filename: file.name,
            mimetype: "audio/ogg; codecs=opus",
            caption: "",
          });
        };
        reader.onerror = () => {
          toast.error("Falha ao ler gravação de áudio.");
        };
        reader.readAsDataURL(file);
      } finally {
        setBusy(false);
      }
    },
    []
  );

  const startRecording = useCallback(async () => {
    if (sessionExpired || busy || recording) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioContext === "undefined") {
      toast.error("A gravação de áudio não é suportada neste navegador.");
      return;
    }
    try {
      const { default: Recorder } = await import("opus-recorder");
      if (!Recorder.isRecordingSupported()) {
        toast.error("Gravação de áudio não suportada neste navegador.");
        return;
      }

      // ponytail: opus-recorder cria AudioContext + SourceNode internamente quando
      // não recebe `stream`. Passar MediaStream externo faz a lib postar o objeto
      // pro Worker → DataCloneError. Deixar a lib gerenciar o ciclo de vida.
      const recorder = new Recorder({
        encoderPath: OPUS_ENCODER_PATH,
        numberOfChannels: 1,
        encoderSampleRate: 16000,
        encoderApplication: 2048, // voice
        mediaTrackConstraints: { audio: true },
      });

      recorder.ondataavailable = (bytes: Uint8Array) => {
        void finalizeRecording(bytes);
      };

      recorder.onstart = () => {
        setRecording(true);
        setRecordSeconds(0);
        recordTimerRef.current = setInterval(() => {
          setRecordSeconds((s) => s + 1);
        }, 1000);
      };

      recorder.onstop = () => {
        setRecording(false);
        if (recordTimerRef.current) {
          clearInterval(recordTimerRef.current);
          recordTimerRef.current = null;
        }
      };

      recorderRef.current = recorder;
      await recorder.start();
    } catch (err: any) {
      console.error("Falha ao iniciar gravação de áudio:", err);
      toast.error("Permissão de microfone negada ou indisponível.");
    }
  }, [sessionExpired, busy, recording, finalizeRecording]);

  const stopRecording = useCallback(() => {
    if (recorderRef.current && recording) {
      recorderRef.current.stop();
      recorderRef.current = null;
    }
  }, [recording]);

  useEffect(() => {
    if (recording && recordSeconds >= MAX_RECORDING_SECONDS) {
      stopRecording();
    }
  }, [recording, recordSeconds, stopRecording]);

  useEffect(() => {
    return () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      if (recorderRef.current) {
        try { recorderRef.current.close(); } catch { /* ignore */ }
        recorderRef.current = null;
      }
    };
  }, []);

  // ---- Envio e Descarte do Rascunho ----

  const sendDraft = useCallback(() => {
    if (!draft || busy) return;
    onSendMedia?.({
      kind: draft.kind,
      base64: draft.base64,
      mimetype: draft.mimetype,
      filename: draft.filename,
      caption: draft.kind === "audio" ? undefined : draft.caption.trim() || undefined,
      replyToId: replyTo?.id,
    });
    setDraft(null);
    onClearReply?.();
    onCancelReply?.();
  }, [draft, busy, onSendMedia, replyTo?.id, onClearReply, onCancelReply]);

  const discardDraft = useCallback(() => {
    setDraft(null);
  }, []);

  const setCaption = useCallback((caption: string) => {
    setDraft((d) => (d ? { ...d, caption } : d));
  }, []);

  const inputsDisabled = sending || busy || sessionExpired;

  // Renderiza o preview do anexo selecionado
  if (draft) {
    const isAudio = draft.kind === "audio";
    const isDoc = draft.kind === "document";
    const isVideo = draft.kind === "video";
    const isImg = draft.kind === "image";

    return (
      <div className={`${styles.composer} flex flex-col gap-3 bg-card p-4 border-t border-border`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-foreground">
            {isImg && <ImageIcon className="h-4 w-4 text-primary shrink-0" />}
            {isVideo && <Video className="h-4 w-4 text-primary shrink-0" />}
            {isDoc && <FileText className="h-4 w-4 text-primary shrink-0" />}
            {isAudio && <Mic className="h-4 w-4 text-emerald-400 shrink-0" />}
            <span className="truncate max-w-[240px] font-medium">{draft.filename}</span>
            <span className="text-xs text-muted-foreground">Pronto para enviar</span>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={discardDraft}
            aria-label="Descartar anexo"
            className="h-9 w-9 p-0 rounded-lg hover:bg-background/80 cursor-pointer"
          >
            <X className="h-4 w-4 text-muted-foreground" />
          </Button>
        </div>

        {/* Local Preview */}
        {isAudio ? (
          <div className="flex flex-col gap-2.5 rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/[0.08] via-emerald-500/[0.03] to-background p-3.5 shadow-xs">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-400">
                <Mic className="h-3 w-3 text-emerald-400 animate-pulse" />
                Voz Gravada WhatsApp (PTT)
              </span>
              <span className="text-[11px] text-muted-foreground/90">
                Entregue como gravação na hora • Sem etiqueta de encaminhado
              </span>
            </div>

            <div className="flex items-center gap-3 bg-card/90 border border-border/70 rounded-lg p-2.5">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400 shrink-0">
                <Mic className="h-5 w-5" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold text-foreground truncate">{draft.filename}</p>
                <p className="text-[11px] text-muted-foreground">
                  Player nativo do WhatsApp com microfone verde
                </p>
              </div>
            </div>

            <audio
              src={draft.mediaUrl}
              controls
              className="w-full h-9 rounded-md outline-none bg-muted/40"
            />
          </div>
        ) : (
          <div className="flex justify-center bg-background/50 rounded-lg p-2 max-h-48 overflow-hidden relative border border-border/40">
            {isImg && (
              <img
                src={draft.mediaUrl}
                alt={draft.filename}
                className="max-h-44 object-contain rounded-md"
              />
            )}
            {isVideo && (
              <video
                src={draft.mediaUrl}
                controls
                className="max-h-44 object-contain rounded-md"
              />
            )}
            {isDoc && (
              <div className="flex flex-col items-center justify-center p-4 text-center">
                <FileText className="h-10 w-10 text-muted-foreground mb-1" />
                <span className="text-xs font-medium text-foreground truncate max-w-xs">
                  {draft.filename}
                </span>
              </div>
            )}
          </div>
        )}

        {/* Legenda (Opcional - Exceto Áudio) */}
        {!isAudio && (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={draft.caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Adicionar legenda..."
              aria-label="Legenda do anexo"
              className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
            />
          </div>
        )}

        <div className="flex justify-end gap-2 mt-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={discardDraft}
            disabled={busy}
            className="text-xs text-muted-foreground hover:text-foreground cursor-pointer"
          >
            Cancelar
          </Button>
          <Button
            size="sm"
            onClick={sendDraft}
            disabled={busy}
            className={cn(
              "gap-1.5 cursor-pointer font-medium",
              isAudio
                ? "bg-emerald-600 hover:bg-emerald-500 text-white shadow-sm shadow-emerald-950/20"
                : "bg-primary hover:bg-primary/95 text-primary-foreground"
            )}
          >
            {busy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : isAudio ? (
              <Mic className="h-3.5 w-3.5" />
            ) : (
              <Send className="h-3.5 w-3.5" />
            )}
            {isAudio ? "Enviar como Áudio Gravado" : "Enviar Anexo"}
          </Button>
        </div>
      </div>
    );
  }

  // Se estiver gravando áudio
  if (recording) {
    return (
      <div className={`${styles.composer} flex items-center justify-between bg-red-500/10 border-t border-red-500/20 px-4 py-3 text-red-300`}>
        <div className="flex items-center gap-3">
          <span className="flex h-2.5 w-2.5 rounded-full bg-red-600 animate-ping shrink-0" />
          <span className="text-sm font-medium">Gravando Áudio...</span>
          <span className="font-mono text-sm font-bold bg-red-500/15 rounded-md px-1.5 py-0.5">
            {formatDuration(recordSeconds)}
          </span>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={stopRecording}
            className="bg-red-600 hover:bg-red-700 text-white rounded-full h-8 w-8 p-0"
            title="Parar e Salvar"
          >
            <Square className="h-4 w-4 fill-current" />
          </Button>
        </div>
      </div>
    );
  }

  // Interface padrão do compositor
  return (
    <div className={`${styles.composer} flex flex-col border-t border-border bg-card`}>
      {replyTo && (
        <ReplyQuote
          authorLabel={replyTo.authorLabel}
          preview={replyTo.preview}
          onDismiss={onClearReply}
        />
      )}

      <div className={`${styles.composerRow} flex items-end`}>
        {/* Dropdown Anexar */}
        <DropdownMenu>
          <DropdownMenuTrigger
            disabled={inputsDisabled}
            aria-label="Anexar arquivo"
            className="h-9 w-9 rounded-full text-muted-foreground hover:text-foreground shrink-0 outline-none hover:bg-muted flex items-center justify-center cursor-pointer disabled:opacity-50"
          >
            <Paperclip className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="top"
            className={`${styles.portal} border-border bg-popover min-w-[240px] p-1.5`}
          >
            <DropdownMenuItem className="cursor-pointer gap-2.5 py-2 px-2.5 rounded-md focus:bg-accent" onClick={() => triggerFilePicker("audio")}>
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400 shrink-0">
                <Mic className="h-4 w-4" />
              </div>
              <div className="flex flex-col text-left">
                <span className="text-xs font-semibold text-foreground">Áudio de Voz (Gravado)</span>
                <span className="text-[10px] text-muted-foreground">Sai como gravado na hora, sem encaminhado</span>
              </div>
            </DropdownMenuItem>
            <DropdownMenuItem className="cursor-pointer gap-2.5 py-2 px-2.5 rounded-md focus:bg-accent" onClick={() => triggerFilePicker("image")}>
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-primary/15 text-primary shrink-0">
                <ImageIcon className="h-4 w-4" />
              </div>
              <span className="text-xs font-medium text-foreground">Imagens</span>
            </DropdownMenuItem>
            <DropdownMenuItem className="cursor-pointer gap-2.5 py-2 px-2.5 rounded-md focus:bg-accent" onClick={() => triggerFilePicker("video")}>
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-sky-500/15 text-sky-400 shrink-0">
                <Video className="h-4 w-4" />
              </div>
              <span className="text-xs font-medium text-foreground">Vídeos</span>
            </DropdownMenuItem>
            <DropdownMenuItem className="cursor-pointer gap-2.5 py-2 px-2.5 rounded-md focus:bg-accent" onClick={() => triggerFilePicker("document")}>
              <div className="flex h-7 w-7 items-center justify-center rounded-full bg-amber-500/15 text-amber-400 shrink-0">
                <FileText className="h-4 w-4" />
              </div>
              <span className="text-xs font-medium text-foreground">Documentos</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <textarea
          ref={textareaRef}
          aria-label="Mensagem"
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          disabled={inputsDisabled}
          placeholder={
            sessionExpired
              ? "WhatsApp Desconectado. Reconecte nas configurações..."
              : "Escreva uma mensagem..."
          }
          rows={1}
          style={{ resize: "none" }}
          className="flex-1 max-h-44 min-h-[36px] bg-muted border border-border/80 rounded-xl px-3 py-1.5 text-sm text-foreground placeholder-muted-foreground focus:outline-none focus:border-primary/50"
        />

        {text.trim() ? (
          <Button
            onClick={handleSend}
            disabled={inputsDisabled}
            aria-label="Enviar mensagem"
            size="icon"
            className="h-9 w-9 rounded-full bg-primary hover:bg-primary/95 text-primary-foreground shrink-0 cursor-pointer"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4 ml-0.5" />
            )}
          </Button>
        ) : (
          <Button
            onClick={startRecording}
            disabled={inputsDisabled}
            size="icon"
            variant="ghost"
            className="h-9 w-9 rounded-full text-muted-foreground hover:text-foreground shrink-0 cursor-pointer hover:bg-muted"
            title="Gravar áudio"
            aria-label="Gravar áudio"
          >
            <Mic className="h-4 w-4" />
          </Button>
        )}
      </div>

      {/* Inputs File Pickers Escondidos */}
      <input
        id="composer-picker-audio"
        type="file"
        accept={PICKER_ACCEPT.audio}
        className="hidden"
        onChange={(e) => handlePicked("audio", e.target.files?.[0])}
      />
      <input
        id="composer-picker-image"
        type="file"
        accept={PICKER_ACCEPT.image}
        className="hidden"
        onChange={(e) => handlePicked("image", e.target.files?.[0])}
      />
      <input
        id="composer-picker-video"
        type="file"
        accept={PICKER_ACCEPT.video}
        className="hidden"
        onChange={(e) => handlePicked("video", e.target.files?.[0])}
      />
      <input
        id="composer-picker-document"
        type="file"
        accept={PICKER_ACCEPT.document}
        className="hidden"
        onChange={(e) => handlePicked("document", e.target.files?.[0])}
      />
    </div>
  );
}

function triggerFilePicker(kind: ComposerMediaKind) {
  const el = document.getElementById(`composer-picker-${kind}`) as HTMLInputElement | null;
  if (el) {
    el.value = "";
    el.click();
  }
}
