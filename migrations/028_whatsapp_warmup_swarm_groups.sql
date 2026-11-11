-- ============================================================
-- MIGRATION 028: AQUECER CHIPS - SWARM N-CHIPS & GRUPOS DE AQUECIMENTO
-- Habilita rede em malha para N números, importação em lote de grupos,
-- heurística zero-token de reações e calibração por finalidade (Contingência, Inbound, Outbound).
-- ============================================================

-- 1. Grupos de Aquecimento do WhatsApp
CREATE TABLE IF NOT EXISTS public.whatsapp_warmup_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  invite_url TEXT NOT NULL,
  invite_code TEXT NOT NULL,
  group_jid TEXT,
  name TEXT,
  description TEXT,
  member_count INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'active', 'invalid', 'full', 'restricted', 'left'
  last_error TEXT,
  total_messages_received INT NOT NULL DEFAULT 0,
  total_reactions_sent INT NOT NULL DEFAULT 0,
  last_activity_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_warmup_groups_client_code UNIQUE (client_id, invite_code)
);

-- 2. Associação de Membros da Colmeia aos Grupos
CREATE TABLE IF NOT EXISTS public.whatsapp_warmup_group_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  group_id UUID NOT NULL REFERENCES public.whatsapp_warmup_groups(id) ON DELETE CASCADE,
  instance_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending', 'joining', 'joined', 'left', 'error'
  joined_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_warmup_group_members UNIQUE (group_id, instance_name)
);

-- 3. Atualização da tabela de configurações com Finalidade e Colmeia
ALTER TABLE public.whatsapp_warmup_configs
  ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'outbound', -- 'contingency', 'inbound', 'outbound'
  ADD COLUMN IF NOT EXISTS profile_hydrated BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS group_auto_join BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS swarm_active BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS max_groups_per_chip INT NOT NULL DEFAULT 10;

-- 4. Índices para consultas de alta performance no Webhook e Workers
CREATE INDEX IF NOT EXISTS idx_warmup_groups_client_status
  ON public.whatsapp_warmup_groups (client_id, status);

CREATE INDEX IF NOT EXISTS idx_warmup_groups_jid
  ON public.whatsapp_warmup_groups (group_jid)
  WHERE group_jid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_warmup_group_members_instance
  ON public.whatsapp_warmup_group_members (instance_name, status);

CREATE INDEX IF NOT EXISTS idx_warmup_configs_swarm
  ON public.whatsapp_warmup_configs (client_id, swarm_active, enabled);

-- 5. RLS (Row Level Security)
ALTER TABLE public.whatsapp_warmup_groups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.whatsapp_warmup_group_members ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'whatsapp_warmup_groups' AND policyname = 'tenant_isolation_warmup_groups'
  ) THEN
    CREATE POLICY tenant_isolation_warmup_groups ON public.whatsapp_warmup_groups
      FOR ALL USING (client_id = (SELECT auth.uid()) OR (SELECT current_setting('role', true)) = 'service_role');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'whatsapp_warmup_group_members' AND policyname = 'tenant_isolation_warmup_group_members'
  ) THEN
    CREATE POLICY tenant_isolation_warmup_group_members ON public.whatsapp_warmup_group_members
      FOR ALL USING (client_id = (SELECT auth.uid()) OR (SELECT current_setting('role', true)) = 'service_role');
  END IF;
END $$;

