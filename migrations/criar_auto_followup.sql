-- Rastreia QUANDO e de ONDE o lead entrou em "primeiro_contato".
-- Usado para promoção automática: leads vindos do disparo em massa
-- que ficam mais de 1 dia em primeiro_contato → vão pra follow-up sozinhos.

ALTER TABLE leads_extraidos
  ADD COLUMN IF NOT EXISTS primeiro_contato_at TIMESTAMPTZ;

ALTER TABLE leads_extraidos
  ADD COLUMN IF NOT EXISTS primeiro_contato_source TEXT;

-- Valores esperados em primeiro_contato_source:
--   'disparo'   → veio do disparo em massa (campaign-worker)
--   'ia'        → veio da classificação da IA (organizador)
--   'manual'    → definido manualmente no CRM
--   NULL        → desconhecido (leads anteriores à migração)

CREATE INDEX IF NOT EXISTS idx_leads_primeiro_contato_source
  ON leads_extraidos (status, primeiro_contato_source, primeiro_contato_at)
  WHERE status = 'primeiro_contato';
