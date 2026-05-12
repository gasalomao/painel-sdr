-- ============================================================
-- chats_dashboard — colunas extras pra mídia + reply quoted
-- Opcional. Sem isso o webhook salva só texto (e áudio/imagem
-- aparecem no chat sem preview, mas sem erro).
-- ============================================================

ALTER TABLE public.chats_dashboard ADD COLUMN IF NOT EXISTS media_url     TEXT;
ALTER TABLE public.chats_dashboard ADD COLUMN IF NOT EXISTS media_type    TEXT;   -- image | audio | video | document
ALTER TABLE public.chats_dashboard ADD COLUMN IF NOT EXISTS mimetype      TEXT;
ALTER TABLE public.chats_dashboard ADD COLUMN IF NOT EXISTS message_type  TEXT;   -- conversation | imageMessage | audioMessage | ...
ALTER TABLE public.chats_dashboard ADD COLUMN IF NOT EXISTS quoted_id     TEXT;
ALTER TABLE public.chats_dashboard ADD COLUMN IF NOT EXISTS quoted_text   TEXT;
