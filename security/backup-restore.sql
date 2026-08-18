-- ============================================================================
-- BACKUP COMPLETO + RESTORE — painel-sdr (Supabase SQL Editor)
-- ============================================================================
-- Como usar: cole cada bloco separado no SQL Editor e rode (Run).
--
-- IMPORTANTE: o backup fica DENTRO do mesmo banco (schema backup_full).
-- Se você apagar o BANCO inteiro ou o volume, o backup vai junto.
-- Para o caso "apagar tudo e recriar do zero", faça TAMBÉM o backup externo
-- (bloco 5, no terminal do container db) — é o único à prova de bomba.
-- ============================================================================


-- ============================================================================
-- BLOCO 1 — BACKUP COMPLETO (rode este primeiro)
-- Cria schema backup_full com TODAS as tabelas de public: estrutura
-- (colunas, PKs, FKs, índices, defaults) + TODOS os dados.
-- Pode rodar quantas vezes quiser (recomeça do zero).
-- ============================================================================

DROP SCHEMA IF EXISTS backup_full CASCADE;
CREATE SCHEMA backup_full;

DO $$
DECLARE
  r RECORD;
BEGIN
  -- Desliga checagens de FK durante a cópia (ordem das tabelas deixa de importar)
  PERFORM set_config('session_replication_role', 'replica', false);
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('CREATE TABLE backup_full.%I (LIKE public.%I INCLUDING ALL)', r.tablename, r.tablename);
    EXECUTE format('INSERT INTO backup_full.%I SELECT * FROM public.%I', r.tablename, r.tablename);
  END LOOP;
  PERFORM set_config('session_replication_role', 'default', false);
END $$;


-- ============================================================================
-- BLOCO 2 — CONFERIR BACKUP (rodar depois do bloco 1)
-- Mostra linha a linha: linhas na tabela real vs no backup (devem ser iguais)
-- ============================================================================

SELECT t.tablename AS tabela,
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', t.tablename), false, true, '')))[1]::text::int AS linhas_original,
       (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM backup_full.%I', t.tablename), false, true, '')))[1]::text::int AS linhas_backup
FROM pg_tables t
WHERE t.schemaname = 'public'
ORDER BY t.tablename;


-- ============================================================================
-- BLOCO 3 — RESTORE TOTAL (SÓ EM CASO DE DESASTRE)
-- Limpa TODAS as tabelas de public e devolve tudo do backup_full.
-- Só rode se tiver certeza (apaga dados novos gravados após o backup).
-- ============================================================================

BEGIN;

DO $$
DECLARE
  r RECORD;
BEGIN
  PERFORM set_config('session_replication_role', 'replica', false);
  -- limpa tudo
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
    EXECUTE format('TRUNCATE public.%I CASCADE', r.tablename);
  END LOOP;
  -- devolve tudo
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname = 'backup_full' LOOP
    EXECUTE format('INSERT INTO public.%I SELECT * FROM backup_full.%I', r.tablename, r.tablename);
  END LOOP;
  PERFORM set_config('session_replication_role', 'default', false);
END $$;

-- Re-sincroniza sequências (ids auto-increment) com o maior id de cada tabela,
-- senário o próximo INSERT pode colidir com id existente.
DO $$
DECLARE
  c RECORD;
  mx BIGINT;
BEGIN
  FOR c IN
    SELECT n.nspname AS sch, t.relname AS tbl,
           (SELECT a.attname FROM pg_attribute a
             WHERE a.attrelid = t.oid AND a.atttypid = ANY(string_to_array('20,21,23,26', ',')::oid[])
               AND pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval(%' LIMIT 1) AS col
    FROM pg_class t
    JOIN pg_namespace n ON n.oid = t.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = t.oid
    WHERE n.nspname = 'public' AND t.relkind = 'r'
      AND d.adrelid IS NOT NULL
  LOOP
    CONTINUE WHEN c.col IS NULL;
    EXECUTE format('SELECT COALESCE(max(%I), 0) + 1 FROM public.%I', c.col, c.tbl) INTO mx;
    EXECUTE format("SELECT setval(pg_get_serial_sequence('public.%I', '%I'), %s)", c.tbl, c.col, mx);
  END LOOP;
END $$;

COMMIT;

-- Re-aplica os REVOKEs de segurança (o restore não apaga grants, mas garante):
REVOKE ALL ON TABLE public.clients FROM anon, authenticated;
REVOKE ALL ON TABLE public.auth_sessions FROM anon, authenticated;
REVOKE ALL ON TABLE public.app_settings FROM anon, authenticated;
REVOKE ALL ON TABLE public.messages FROM anon, authenticated;
REVOKE ALL ON TABLE public.ai_token_usage FROM anon, authenticated;
REVOKE ALL ON TABLE public.ai_pricing_cache FROM anon, authenticated;
REVOKE ALL ON TABLE public.agent_knowledge_chunks FROM anon, authenticated;


-- ============================================================================
-- BLOCO 4 — APAGAR O BACKUP (depois que confirmar que está tudo bem)
-- Libera o espaço do schema backup_full.
-- ============================================================================

-- DROP SCHEMA backup_full CASCADE;


-- ============================================================================
-- BLOCO 5 — BACKUP EXTERNO (à prova de banco apagado) — OPCIONAL MAS RECOMENDADO
-- Não é SQL Editor: rode no TERMINAL do container "db" do stack Supabase
-- (Easypanel → sistema-supabase → container db → Terminal).
-- Grava o dump no VOLUME persistente (sobrevive a rebuild/recriar containers).
--
--   pg_dump -U postgres postgres | gzip > /var/lib/postgresql/data/backup_$(date +%F_%H%M).sql.gz
--   ls -lh /var/lib/postgresql/data/backup_*
--
-- Para RESTAURAR esse dump externo (mesmo terminal):
--
--   gunzip -c /var/lib/postgresql/data/backup_YYYY-MM-DD_HHMM.sql.gz | psql -U postgres postgres
--
-- E se for recriar o banco DO ZERO (vazio) antes: rodar o SETUP_SQL do app
-- (src/lib/setup-sql.ts — tabela por tabela) no SQL Editor, e depois o dump.
-- ============================================================================
