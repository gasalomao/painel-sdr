-- ============================================================================
-- Migration 007 — Follow-up: coluna source_status (kanban dinâmico)
-- ============================================================================
-- Por quê: o Organizador IA permite o cliente criar kanban customizado pra
-- qualquer nicho (ex: Salão → "agendado / atendido / fidelizado", Médico →
-- "primeira consulta / retorno"). O follow-up antes pegava só leads com
-- status hardcoded "follow-up" — não fazia sentido pra quem renomeou
-- ou criou outras colunas.
--
-- Solução: cada campanha de follow-up declara DE QUAL coluna do kanban
-- do cliente ela puxa os leads. Default "follow-up" pra compat retroativa.
-- ============================================================================

-- Coluna nova: status do kanban usado como pool de leads pra essa campanha.
-- Aceita qualquer status_key — o front mostra dropdown lendo kanban_columns
-- do cliente, então user escolhe entre as colunas reais do kanban dele.
ALTER TABLE public.followup_campaigns
  ADD COLUMN IF NOT EXISTS source_status TEXT NOT NULL DEFAULT 'follow-up';

-- Index pra filtrar campanhas por source_status (workers/relatórios).
CREATE INDEX IF NOT EXISTS idx_followup_campaigns_source
  ON public.followup_campaigns(source_status);

-- Backfill: campanhas existentes ficam com 'follow-up' (mesmo comportamento
-- de antes — zero regressão).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'followup_campaigns'
      AND column_name = 'source_status'
  ) THEN
    RAISE NOTICE '✓ Migration 007 OK — followup_campaigns.source_status pronta.';
  ELSE
    RAISE EXCEPTION 'Falha ao adicionar source_status';
  END IF;
END$$;
