-- ============================================================================
-- Migration 005 — Indexes de performance
--
-- Sem esses índices, hot paths (chat, ai-organize, historico) viram seq-scan
-- em tenants com 50k+ mensagens. Esperado: queries que demoravam 1-5s caem
-- pra 50-200ms.
--
-- Todos usam IF NOT EXISTS — idempotente, seguro rodar várias vezes.
-- CONCURRENTLY evita lock da tabela durante o build.
-- ============================================================================

-- chats_dashboard: lookup por (client_id, created_at) — usado em todo /chat
-- e em ai-organize (mensagens do dia, histórico antes de hoje).
CREATE INDEX IF NOT EXISTS idx_chats_dashboard_client_created
  ON public.chats_dashboard (client_id, created_at DESC);

-- chats_dashboard: lookup por (client_id, instance_name, remote_jid) — usado em
-- /chat conversation list e em joins de session lookup.
CREATE INDEX IF NOT EXISTS idx_chats_dashboard_client_inst_jid
  ON public.chats_dashboard (client_id, instance_name, remote_jid);

-- chats_dashboard: lookup por (remote_jid, created_at) — usado em ai-organize
-- (histórico de chats por jid).
CREATE INDEX IF NOT EXISTS idx_chats_dashboard_jid_created
  ON public.chats_dashboard (remote_jid, created_at DESC);

-- leads_extraidos: lookup por (client_id, status) — usado em CRM, kanban,
-- followup enroll, auto-promoter.
CREATE INDEX IF NOT EXISTS idx_leads_extraidos_client_status
  ON public.leads_extraidos (client_id, status);

-- leads_extraidos: lookup por (client_id, created_at) — listagens recentes.
CREATE INDEX IF NOT EXISTS idx_leads_extraidos_client_created
  ON public.leads_extraidos (client_id, created_at DESC);

-- historico_ia_leads: lookup por (remote_jid, created_at) — anti-bouncing
-- do ai-organize lê últimas 24h por jid.
CREATE INDEX IF NOT EXISTS idx_historico_ia_jid_created
  ON public.historico_ia_leads (remote_jid, created_at DESC);

-- followup_targets: lookup por (followup_campaign_id, status) — tick lê
-- targets elegíveis dessa campanha.
CREATE INDEX IF NOT EXISTS idx_followup_targets_camp_status
  ON public.followup_targets (followup_campaign_id, status);

-- ai_token_usage: lookup por (created_at) — dashboard de tokens agrega por dia.
CREATE INDEX IF NOT EXISTS idx_ai_token_usage_created
  ON public.ai_token_usage (created_at DESC);

-- messages: lookup por (session_id, created_at) — IA lê histórico por sessão.
CREATE INDEX IF NOT EXISTS idx_messages_session_created
  ON public.messages (session_id, created_at);

-- sessions: lookup por (contact_id, instance_name) — webhook resolve sessão
-- (sessions NÃO tem remote_jid; o JID vem via JOIN com contacts.remote_jid).
CREATE INDEX IF NOT EXISTS idx_sessions_contact_inst
  ON public.sessions (contact_id, instance_name);

-- webhook_logs: lookup por (created_at) — debug recente.
CREATE INDEX IF NOT EXISTS idx_webhook_logs_created
  ON public.webhook_logs (created_at DESC);

ANALYZE public.chats_dashboard;
ANALYZE public.leads_extraidos;
ANALYZE public.historico_ia_leads;
ANALYZE public.followup_targets;
