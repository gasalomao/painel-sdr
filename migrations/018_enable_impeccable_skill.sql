-- Migration: Ativar Impeccable Design como skill global
-- Este módulo força design autoral e anti-template em todos os projetos

BEGIN;

-- Inserir a skill Impeccable Design como global (client_id = NULL)
-- Usando um UUID fixo determinístico derivado do slug
INSERT INTO public.website_skills (
  id,
  client_id,
  name,
  slug,
  description,
  instructions,
  category,
  tags,
  priority,
  trigger_mode,
  is_enabled,
  is_builtin,
  version
) VALUES (
  '00000000-0000-0000-0000-000000000001'::uuid, -- UUID fixo para builtin
  NULL,
  'Impeccable Design (Anti-AI)',
  'impeccable-design',
  'Sistema de design profissional anti-template com 15 módulos de referência: briefing, direção visual, tipografia, layout, cor, imagens, movimento, interação, responsividade, acessibilidade, conteúdo e revisão visual. Força design autoral único para cada projeto.',
  'Sistema ativo. Referências especializadas injetadas automaticamente pelo runtime conforme o contexto. Não repita as instruções completas aqui; o agent.ts já carrega composeImpeccableGuidance() com todos os 15 módulos oficiais.',
  'design',
  ARRAY['design', 'visual', 'autoral', 'profissional', 'anti-template', 'ui', 'ux', 'tipografia', 'cor', 'layout', 'responsivo', 'acessibilidade'],
  100, -- Prioridade máxima
  'always', -- Sempre ativo
  true,
  true, -- É builtin
  1
) ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  trigger_mode = EXCLUDED.trigger_mode,
  is_enabled = EXCLUDED.is_enabled,
  priority = EXCLUDED.priority,
  tags = EXCLUDED.tags,
  updated_at = now();

COMMIT;
