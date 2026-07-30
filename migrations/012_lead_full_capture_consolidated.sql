-- 012_lead_full_capture_consolidated.sql
-- ============================================================================
-- MIGRATION CONSOLIDADA — Garante que TODAS as colunas da captura profunda
-- do Google Maps existam no banco. Idempotente (pode rodar quantas vezes quiser).
--
-- Por que existe: o scraper-engine.ts captura MUITA coisa (reviews detalhadas
-- com foto/resposta do dono, distribuição de estrelas, horários populares,
-- geolocalização, plus code, redes sociais adicionais, etc.), mas essas
-- colunas foram adicionadas em migrations separadas (009, 010, 011) que
-- talvez não foram rodadas em todos os ambientes. Esta migration garante
-- TUDO numa execução só.
--
-- Rodar via: Supabase Studio → SQL Editor → colar → Run.
-- ============================================================================

-- ============================================================================
-- 1) COLUNAS DA CAPTURA PROFUNDA DO GOOGLE MAPS (reviews, business, photos)
-- ============================================================================
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS reviews_detalhes      jsonb;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS business_details      jsonb;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS opening_hours         jsonb;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS attributes            jsonb;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS price_range           text;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS open_now              text;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS photos                jsonb;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS maps_url              text;

-- ============================================================================
-- 2) COLUNAS DE GEOLOCALIZAÇÃO E IDENTIFICAÇÃO ÚNICA
-- ============================================================================
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS place_id              text;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS plus_code             text;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS lat                   numeric;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS lng                   numeric;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS cep                   text;

-- ============================================================================
-- 3) DISTRIBUIÇÃO DE ESTRELAS (5★, 4★, 3★, 2★, 1★)
-- ============================================================================
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS distribuicao_estrelas jsonb;

-- ============================================================================
-- 4) CAPTURA ESTENDIDA — campos avançados do Maps (status, owner, topics, etc.)
-- ============================================================================
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS business_status       text;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS claimed               boolean;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS owner_name            text;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS year_established      text;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS total_photo_count     integer;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS review_topics         jsonb;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS featured_reviews      jsonb;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS additional_categories jsonb;
ALTER TABLE public.leads_extraidos ADD COLUMN IF NOT EXISTS address_components    jsonb;

-- ============================================================================
-- 4) ÍNDICES pra acelerar queries comuns (busca por status, geolocalização,
--    place_id único pra dedupe cross-source, etc.)
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_leads_extraidos_place_id  ON public.leads_extraidos USING btree (place_id) WHERE (place_id IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_leads_extraidos_lat_lng   ON public.leads_extraidos USING btree (lat, lng) WHERE (lat IS NOT NULL AND lng IS NOT NULL);
CREATE INDEX IF NOT EXISTS idx_leads_extraidos_cep       ON public.leads_extraidos USING btree (cep) WHERE (cep IS NOT NULL);

-- ============================================================================
-- 5) SANITY CHECK — confirma que as colunas foram criadas
-- ============================================================================
DO $$
DECLARE
  missing_cols text[];
  expected_cols text[] := ARRAY[
    'reviews_detalhes', 'business_details', 'opening_hours', 'attributes',
    'price_range', 'open_now', 'photos', 'maps_url',
    'place_id', 'plus_code', 'lat', 'lng', 'cep', 'distribuicao_estrelas',
    'business_status', 'claimed', 'owner_name', 'year_established',
    'total_photo_count', 'review_topics', 'featured_reviews',
    'additional_categories', 'address_components'
  ];
  col_name text;
BEGIN
  missing_cols := ARRAY[]::text[];
  FOREACH col_name IN ARRAY expected_cols LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'leads_extraidos'
        AND column_name = col_name
    ) THEN
      missing_cols := array_append(missing_cols, col_name);
    END IF;
  END LOOP;

  IF array_length(missing_cols, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'Colunas ainda faltando em leads_extraidos: %', missing_cols;
  ELSE
    RAISE NOTICE '✓ Todas as 23 colunas de captura profunda estão presentes em leads_extraidos.';
  END IF;
END $$;
