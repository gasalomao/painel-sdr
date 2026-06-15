-- ============================================================
-- HEAL — Recupera disparos da automação que sumiram do /chat
-- ------------------------------------------------------------
-- Causa: o persistOutgoingMessage do disparo (campaign/followup/
-- appointment) salvava em chats_dashboard SEM client_id. O /chat
-- filtra por client_id → essas mensagens ficavam invisíveis (mas
-- continuavam no banco).
--
-- Solução: preencher o client_id usando o channel_connections
-- (a instância já tem o client_id certo lá).
-- 100% idempotente: pode rodar várias vezes.
-- ============================================================

-- Antes/depois (pra você ver o impacto):
SELECT
  'antes' AS quando,
  COUNT(*) FILTER (WHERE client_id IS NULL) AS sem_client_id,
  COUNT(*) FILTER (WHERE client_id IS NOT NULL) AS com_client_id
FROM public.chats_dashboard;

-- HEAL chats_dashboard
UPDATE public.chats_dashboard cd
SET client_id = cc.client_id
FROM public.channel_connections cc
WHERE cd.instance_name = cc.instance_name
  AND cd.client_id IS NULL
  AND cc.client_id IS NOT NULL;

-- HEAL messages (V2) — mesma lógica, via sessions → channel_connections
UPDATE public.messages m
SET client_id = cc.client_id
FROM public.sessions s
JOIN public.channel_connections cc ON cc.instance_name = s.instance_name
WHERE m.session_id = s.id
  AND m.client_id IS NULL
  AND cc.client_id IS NOT NULL;

-- Resultado:
SELECT
  'depois' AS quando,
  COUNT(*) FILTER (WHERE client_id IS NULL) AS sem_client_id,
  COUNT(*) FILTER (WHERE client_id IS NOT NULL) AS com_client_id
FROM public.chats_dashboard;
