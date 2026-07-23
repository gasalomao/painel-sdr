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
