-- ============================================================================
-- Migration 011 — Campos extras do painel de detalhe do Google Maps
--
-- Caso de uso:
--   009 já tinha reviews_detalhes, business_details, opening_hours,
--   attributes, price_range, open_now, photos, maps_url.
--   Esta 011 adiciona campos ATÔMICOS em leads_extraidos que vêm do MESMO
--   painel de detalhe do Maps, mas ficam como colunas próprias para:
--   - query/filtro fácil (ex: SELECT WHERE cep = '29000-000')
--   - ordenação por distância (lat/lng)
--   - dedupe por place_id (ID único do Google, evita duplicar mesmo lugar
--     quando o nome muda ou quando é re-escrapeado)
--   - distribuição de estrelas para análise de reputação
--
-- Idempotente (IF NOT EXISTS em tudo). Colunas TEXT/NUMERIC/JSONB pra
-- não restringir formato.
-- ============================================================================

ALTER TABLE public.leads_extraidos
  ADD COLUMN IF NOT EXISTS place_id              TEXT,
  ADD COLUMN IF NOT EXISTS plus_code             TEXT,
  ADD COLUMN IF NOT EXISTS lat                   NUMERIC,
  ADD COLUMN IF NOT EXISTS lng                   NUMERIC,
  ADD COLUMN IF NOT EXISTS cep                   TEXT,
  ADD COLUMN IF NOT EXISTS distribuicao_estrelas JSONB;

COMMENT ON COLUMN public.leads_extraidos.place_id IS
  'Place ID Google (ChIJ... ou 0x...:0x...). Identificador único do lugar.';
COMMENT ON COLUMN public.leads_extraidos.plus_code IS
  'Plus Code (Open Location Code) — referência única geográfica.';
COMMENT ON COLUMN public.leads_extraidos.lat IS
  'Latitude decimal do lugar.';
COMMENT ON COLUMN public.leads_extraidos.lng IS
  'Longitude decimal do lugar.';
COMMENT ON COLUMN public.leads_extraidos.cep IS
  'CEP extraído do endereço/painel de detalhe (formato 00000-000).';
COMMENT ON COLUMN public.leads_extraidos.distribuicao_estrelas IS
  'Distribuição de avaliações por estrela: { "5estrelas": 120, "4estrelas": 30, "3estrelas": 5, ... }.';

-- Índice p/ dedupe por place_id (identificador único do Google).
CREATE INDEX IF NOT EXISTS idx_leads_extraidos_place_id
  ON public.leads_extraidos (place_id)
  WHERE place_id IS NOT NULL;

-- Índice p/ filtro por CEP.
CREATE INDEX IF NOT EXISTS idx_leads_extraidos_cep
  ON public.leads_extraidos (cep)
  WHERE cep IS NOT NULL;

ANALYZE public.leads_extraidos;
