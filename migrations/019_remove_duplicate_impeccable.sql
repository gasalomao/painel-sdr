-- Migration 019: Remover entrada duplicada da skill Impeccable Design
-- Mantém apenas a entrada builtin com ID fixo

DELETE FROM website_skills
WHERE slug = 'impeccable-design'
  AND id != '00000000-0000-0000-0000-000000000001';

-- Confirmar que sobrou apenas 1
DO $$
DECLARE
  skill_count INT;
BEGIN
  SELECT COUNT(*) INTO skill_count
  FROM website_skills
  WHERE slug = 'impeccable-design';

  IF skill_count != 1 THEN
    RAISE EXCEPTION 'Esperado 1 registro, encontrado %', skill_count;
  END IF;

  RAISE NOTICE 'Duplicata removida com sucesso. Skill única confirmada.';
END $$;
