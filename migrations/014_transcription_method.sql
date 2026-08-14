-- 014: Método de transcrição de áudio por agente
-- Valores: 'auto' (whisper→gemini), 'whisper' (local grátis), 'gemini' (cloud), 'disabled' (sem transcrição)
ALTER TABLE public.agent_settings
  ADD COLUMN IF NOT EXISTS transcription_method text DEFAULT 'auto';
