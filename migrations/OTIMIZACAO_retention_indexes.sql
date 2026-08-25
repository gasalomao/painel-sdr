-- ============================================================================
-- OTIMIZAÇÃO: retenção de tabelas append-only + remoção de índices duplicados
-- ============================================================================
-- Rodar UMA VEZ no Supabase (SQL Editor). Idempotente — pode rodar de novo.
--
-- PARTE 1 — RETENÇÃO
-- Tabelas append-only crescem sem limite e degradam o Postgres (bloat de
-- índice, seq-scans lentos). pg_cron remove o excedente diariamente.
-- Se pg_cron não estiver habilitado no projeto:
--   CREATE EXTENSION IF NOT EXISTS pg_cron;
--   (No Supabase: Dashboard → Database → Extensions → pg_cron.)
-- Sem pg_cron, execute os DELETEs manualmente ou via cron externo.

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Logs de webhook: só diagnóstico recente importa. Payloads antigos são puro custo.
SELECT cron.schedule(
  'retention-webhook-logs', '17 4 * * *',
  $$DELETE FROM webhook_logs WHERE created_at < now() - interval '14 days'$$
);

-- Uso de tokens: mantém 1 ano (dados financeiros/relatório).
SELECT cron.schedule(
  'retention-token-usage', '23 4 * * *',
  $$DELETE FROM ai_token_usage WHERE created_at < now() - interval '365 days'$$
);

-- Histórico de IA por lead: mantém 6 meses.
SELECT cron.schedule(
  'retention-historico-ia', '31 4 * * *',
  $$DELETE FROM historico_ia_leads WHERE created_at < now() - interval '180 days'$$
);

-- Logs de campanha/follow-up/automação: 90 dias.
SELECT cron.schedule(
  'retention-campaign-logs', '37 4 * * *',
  $$DELETE FROM campaign_logs WHERE created_at < now() - interval '90 days'$$
);
SELECT cron.schedule(
  'retention-followup-logs', '41 4 * * *',
  $$DELETE FROM followup_logs WHERE created_at < now() - interval '90 days'$$
);
SELECT cron.schedule(
  'retention-automation-logs', '43 4 * * *',
  $$DELETE FROM automation_logs WHERE created_at < now() - interval '90 days'$$
);

-- NOTA: chats_dashboard e messages NÃO têm retenção automática aqui — são o
-- histórico do cliente. Definir política com o dono do produto antes.

-- PARTE 2 — ÍNDICES DUPLICADOS (mesma definição; um dos pares é morto)
-- Cada índice a mais = write amplification em INSERT/UPDATE nas tabelas mais quentes.
-- ⚠ DROP INDEX pega lock exclusivo breve — rodar fora do horário de pico.
DROP INDEX IF EXISTS idx_chats_remote_jid;      -- ≡ idx_chats_dashboard_jid_created
DROP INDEX IF EXISTS idx_messages_session;      -- ≡ idx_messages_session_created
DROP INDEX IF EXISTS idx_leads_extraidos_remotejid; -- ≡ idx_leads_remotejid
