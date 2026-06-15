-- Adicione colunas pra personalização com IA + busca web nas campanhas
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS personalize_with_ai BOOLEAN DEFAULT false;
ALTER TABLE public.campaigns ADD COLUMN IF NOT EXISTS use_web_search      BOOLEAN DEFAULT false;
