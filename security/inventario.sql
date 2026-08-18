-- INVENTARIO COMPLETO — copie DO BLOCO DE NOTAS (nunca do chat/terminal)
-- Rode no SQL Editor. Vao aparecer 2 resultados:

-- RESULTADO 1: todas as tabelas e colunas
SELECT table_name, ordinal_position AS pos, column_name, data_type,
       is_nullable, COALESCE(column_default, chr(45)||chr(45)) AS padrao
FROM information_schema.columns
WHERE table_schema = chr(112)||chr(117)||chr(98)||chr(108)||chr(105)||chr(99)
ORDER BY table_name, ordinal_position;

-- RESULTADO 2: total de linhas por tabela
SELECT relname AS tabela, n_live_tup AS linhas
FROM pg_stat_user_tables
ORDER BY relname;
