-- ============================================================================
-- Migration 008 — Email + redes sociais em leads_extraidos
--
-- Casos de uso:
--   • Cliente veio pelo WhatsApp (não pelo captador) e usuário quer salvar
--     manualmente nome, email, redes sociais, etc — todos vars de template.
--   • Captador Google Maps deve popular email automaticamente quando o
--     site do negócio expõe mailto: ou JSON-LD (fase 2 do scraper).
--   • Convites do Google Calendar (attendees) usam esse email.
--
-- Tudo nullable + IF NOT EXISTS — idempotente.
-- ============================================================================

ALTER TABLE public.leads_extraidos
  ADD COLUMN IF NOT EXISTS email        TEXT,
  ADD COLUMN IF NOT EXISTS observacoes  TEXT;

-- Índice pra lookup por email (futuro: detectar duplicados, busca admin)
CREATE INDEX IF NOT EXISTS idx_leads_extraidos_client_email
  ON public.leads_extraidos (client_id, email)
  WHERE email IS NOT NULL;

COMMENT ON COLUMN public.leads_extraidos.email IS
  'Email do lead (LOWERCASE recomendado). Usado em convites Google Calendar e variável {email} nos templates.';
COMMENT ON COLUMN public.leads_extraidos.observacoes IS
  'Notas livres do dono sobre o lead. Usado como variável {observacoes} nos templates.';

ANALYZE public.leads_extraidos;
