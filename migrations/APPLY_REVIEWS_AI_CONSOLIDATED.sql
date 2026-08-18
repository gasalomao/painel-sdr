-- ================= 009_leads_reviews_detalhes.sql =================
-- ============================================================================
-- Migration 009 — Captura profunda do Google Maps em leads_extraidos
--
-- Caso de uso:
--   O captador hoje só salva name/address/categories/rating/reviewCount/
--   phone/website/instagram/facebook. O usuário pediu pra capturar o MÁXIMO
--   de informação do painel de detalhe do Maps — em especial os textos das
--   REVIEWS/avaliações, mas também horários, faixa de preço, atributos,
--   status "aberto agora" e fotos.
--
-- Tudo nullable + IF NOT EXISTS — idempotente. Todas as colunas novas são
-- JSONB/TEXT pra não restringir formato (Google Maps muda DOM o tempo todo).
-- ============================================================================

ALTER TABLE public.leads_extraidos
  ADD COLUMN IF NOT EXISTS reviews_detalhes  JSONB,
  ADD COLUMN IF NOT EXISTS business_details  JSONB,
  ADD COLUMN IF NOT EXISTS opening_hours     JSONB,
  ADD COLUMN IF NOT EXISTS attributes        JSONB,
  ADD COLUMN IF NOT EXISTS price_range       TEXT,
  ADD COLUMN IF NOT EXISTS open_now          TEXT,
  ADD COLUMN IF NOT EXISTS photos            JSONB,
  ADD COLUMN IF NOT EXISTS maps_url          TEXT;

COMMENT ON COLUMN public.leads_extraidos.reviews_detalhes IS
  'Lista de reviews extraídas do Google Maps (autor, nota, data, texto). Máx ~50 entradas.';
COMMENT ON COLUMN public.leads_extraidos.business_details IS
  'Blob estruturado do painel "Sobre" do Maps (descrição, serviços, atributos).';
COMMENT ON COLUMN public.leads_extraidos.opening_hours IS
  'Horários de funcionamento por dia da semana, quando publicados.';
COMMENT ON COLUMN public.leads_extraidos.attributes IS
  'Atributos do Maps (delivery, acessibilidade, estacionamento, etc.).';
COMMENT ON COLUMN public.leads_extraidos.price_range IS
  'Faixa de preço ($, $$, $$$, $$$$) quando publicada.';
COMMENT ON COLUMN public.leads_extraidos.open_now IS
  'Status "Aberto agora"/"Fechado" no momento da captura.';
COMMENT ON COLUMN public.leads_extraidos.photos IS
  'URLs de fotos públicas destacadas no painel de detalhe (máx ~20).';
COMMENT ON COLUMN public.leads_extraidos.maps_url IS
  'URL canonica do painel de detalhe do Maps (place_id embutido).';

ANALYZE public.leads_extraidos;


-- ================= 011_leads_maps_deepfields.sql =================
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


-- ================= 012_lead_full_capture_consolidated.sql =================
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


-- ================= reviews_ai.sql =================
-- =====================================================================
-- Reviews AI — resumo de avaliações do Google com IA
-- Aplica: colunas de cache em leads_extraidos, config em automations,
--         tabela de log reviews_ai_logs.
-- Idempotente (ADD COLUMN IF NOT EXISTS / CREATE TABLE IF NOT EXISTS).
-- Rode no SQL Editor do Supabase.
-- =====================================================================

ALTER TABLE public.leads_extraidos
  ADD COLUMN IF NOT EXISTS resumo_avaliacoes text,
  ADD COLUMN IF NOT EXISTS resumo_avaliacoes_at timestamptz;

ALTER TABLE public.automations
  ADD COLUMN IF NOT EXISTS reviews_ai_enabled boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS reviews_ai_model text,
  ADD COLUMN IF NOT EXISTS reviews_ai_prompt text;

CREATE TABLE IF NOT EXISTS public.reviews_ai_logs (
  id                BIGSERIAL PRIMARY KEY,
  client_id         uuid DEFAULT '00000000-0000-0000-0000-000000000001'::uuid,
  lead_id           bigint,
  remote_jid        text,
  nome_negocio      text,
  model             text,
  prompt            text,
  response          text,
  cached            boolean DEFAULT false,
  prompt_tokens     integer DEFAULT 0,
  completion_tokens integer DEFAULT 0,
  total_tokens      integer DEFAULT 0,
  source            text DEFAULT 'manual',
  automation_id     uuid,
  created_at        timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_reviews_ai_logs_lead   ON public.reviews_ai_logs USING btree (lead_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reviews_ai_logs_client ON public.reviews_ai_logs USING btree (client_id);
CREATE INDEX IF NOT EXISTS idx_reviews_ai_logs_jid    ON public.reviews_ai_logs USING btree (remote_jid, created_at DESC);

-- Libera leitura/escrita via service_role (PostgREST). Anon não lê.
ALTER TABLE public.reviews_ai_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS reviews_ai_logs_service_all ON public.reviews_ai_logs;
CREATE POLICY reviews_ai_logs_service_all ON public.reviews_ai_logs
  FOR ALL TO service_role USING (true) WITH CHECK (true);
