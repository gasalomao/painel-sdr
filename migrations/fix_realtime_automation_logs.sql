-- ============================================================
-- FIX: Realtime do painel de log da Automação
--
-- Sintoma: o "Log ao vivo" da Automação congela (ex: para em
-- "Rolando para capturar cartões...") enquanto o terminal continua
-- mostrando tudo. Causa: as tabelas de log não estão na publication
-- `supabase_realtime`, então o painel nunca recebe os eventos novos.
--
-- Este script é IDEMPOTENTE: só adiciona o que estiver faltando.
-- Seguro rodar quantas vezes quiser.
-- ============================================================
DO $$
DECLARE
  t text;
  alvo text[] := ARRAY[
    'automation_logs',
    'automations',
    'campaign_logs',
    'followup_logs',
    'leads_extraidos',
    'chats_dashboard'
  ];
BEGIN
  -- Garante que a publication existe (não recria — preserva o que já tem)
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;

  FOREACH t IN ARRAY alvo LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema = 'public' AND table_name = t)
       AND NOT EXISTS (SELECT 1 FROM pg_publication_tables
                       WHERE pubname = 'supabase_realtime' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
      RAISE NOTICE 'Adicionada à supabase_realtime: %', t;
    END IF;
  END LOOP;
END$$;

-- Conferência: lista o que está publicado (deve incluir automation_logs).
SELECT tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
ORDER BY tablename;
