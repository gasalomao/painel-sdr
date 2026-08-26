-- ============================================================================
-- OTIMIZACAO: contatos multi-tenant — mesmo número pode pertencer a N clientes
-- ============================================================================
-- Rodar UMA VEZ no Supabase (SQL Editor). Idempotente.
--
-- HOJE: contacts.remote_jid é UNIQUE GLOBAL → quando o MESMO número fala com
-- 2 empresas diferentes do SaaS, as duas brigam pela MESMA linha de contato
-- (dono troca, sessões cruzam). Esta migração:
--   1) Derruba a unique global;
--   2) Cria uma cópia de contato para cada tenant que conversa com o número
--      (via sessions e via chats_dashboard);
--   3) Reaponta sessions para o contato do tenant correto;
--   4) Instala UNIQUE (client_id, remote_jid).
--
-- Seguro rodar em produção: não apaga nada, só separa.

-- 1) Derruba a unique global (nome pode variar entre installs)
ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS contacts_remote_jid_key;

-- 2a) Cópias para tenants que já têm sessão vinculada ao contato de outro
INSERT INTO public.contacts (client_id, remote_jid, phone_number, push_name)
SELECT DISTINCT s.client_id, c.remote_jid, c.phone_number, c.push_name
FROM public.sessions s
JOIN public.contacts c ON c.id = s.contact_id
WHERE s.client_id <> c.client_id
ON CONFLICT DO NOTHING;

-- 2b) Contatos para jids que só existem em chats_dashboard sem contato do tenant
INSERT INTO public.contacts (client_id, remote_jid, phone_number)
SELECT DISTINCT ch.client_id, ch.remote_jid,
       COALESCE(NULLIF(SPLIT_PART(ch.remote_jid, '@', 1), ''), ch.remote_jid)
FROM public.chats_dashboard ch
WHERE ch.remote_jid IS NOT NULL AND ch.remote_jid <> ''
  AND NOT EXISTS (
    SELECT 1 FROM public.contacts c
    WHERE c.client_id = ch.client_id AND c.remote_jid = ch.remote_jid
  );

-- 3) Reaponta sessões presas ao contato de outro tenant
UPDATE public.sessions s
SET contact_id = nc.id
FROM public.contacts oc
JOIN public.contacts nc
  ON nc.remote_jid = oc.remote_jid
 AND nc.client_id  = s.client_id
WHERE s.contact_id = oc.id
  AND oc.client_id <> s.client_id;

-- 4) Nova regra: um contato POR (cliente, número)
ALTER TABLE public.contacts
  DROP CONSTRAINT IF EXISTS contacts_client_remote_jid_key;
ALTER TABLE public.contacts
  ADD CONSTRAINT contacts_client_remote_jid_key UNIQUE (client_id, remote_jid);
