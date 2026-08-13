-- ============================================================
-- FIX: Realtime do /chat (conversas + mensagens)
--
-- Sintoma: mensagens novas não aparecem em tempo real no /chat;
-- só aparecem depois que o usuário troca de conversa e volta.
-- O card lateral da conversa também não atualiza "última mensagem".
--
-- Causa: as tabelas `chats_dashboard` e `sessions` não estão na
-- publication `supabase_realtime`, então o Supabase não entrega
-- eventos de INSERT/UPDATE pro hook useRealtime.
--
-- Este script é IDEMPOTENTE: só adiciona o que estiver faltando.
-- Seguro rodar quantas vezes quiser.
-- ============================================================
DO $$
DECLARE
  t text;
  alvo text[] := ARRAY['chats_dashboard', 'sessions'];
BEGIN
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

-- Conferência: deve incluir chats_dashboard e sessions.
SELECT tablename
FROM pg_publication_tables
WHERE pubname = 'supabase_realtime'
ORDER BY tablename;