-- Fix: automations de disparo com mídia quebravam na criação da campanha.
-- automation-worker insere e campaign-worker lê (envio de imagem/vídeo/documento),
-- mas as colunas nunca existiram em campaigns.
alter table campaigns add column if not exists media_url text;
alter table campaigns add column if not exists media_type text;
alter table campaigns add column if not exists media_caption text;
alter table campaigns add column if not exists media_file_name text;
alter table campaigns add column if not exists media_mimetype text;
