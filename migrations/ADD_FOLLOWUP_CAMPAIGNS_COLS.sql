-- Fix: criação de follow-up pela automação quebrava — followup-worker LÊ
-- humanize_messages e media_* (linhas ~503/547) mas as colunas não existiam.
alter table followup_campaigns add column if not exists humanize_messages boolean default false;
alter table followup_campaigns add column if not exists media_url text;
alter table followup_campaigns add column if not exists media_type text;
alter table followup_campaigns add column if not exists media_caption text;
alter table followup_campaigns add column if not exists media_file_name text;
alter table followup_campaigns add column if not exists media_mimetype text;
