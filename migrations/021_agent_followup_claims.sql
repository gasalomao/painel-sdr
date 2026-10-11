-- Incremental; aplicação em banco real exige aprovação específica.
BEGIN;
ALTER TABLE public.agent_followups
 ADD COLUMN IF NOT EXISTS instance_name text,
 ADD COLUMN IF NOT EXISTS initial_sent_at timestamptz,
 ADD COLUMN IF NOT EXISTS session_uuid uuid,
 ADD COLUMN IF NOT EXISTS contact_uuid uuid,
 ADD COLUMN IF NOT EXISTS claim_id uuid,
 ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
 ADD COLUMN IF NOT EXISTS attempt_id uuid,
 ADD COLUMN IF NOT EXISTS send_started_at timestamptz,
 ADD COLUMN IF NOT EXISTS send_content text,
 ADD COLUMN IF NOT EXISTS prepared_next_delay_minutes integer,
 ADD COLUMN IF NOT EXISTS provider_message_id text,
 ADD COLUMN IF NOT EXISTS last_attempt_id uuid,
 ADD COLUMN IF NOT EXISTS last_claim_id uuid,
 ADD COLUMN IF NOT EXISTS last_completed_step integer;
ALTER TABLE public.agent_followups DROP CONSTRAINT IF EXISTS agent_followups_status_check;
ALTER TABLE public.agent_followups ADD CONSTRAINT agent_followups_status_check CHECK
 (status IN ('pending','sent','processing','sending','ambiguous','cancelled','completed','failed'));
UPDATE public.agent_followups SET status='ambiguous',error_message='Execução legada exige reconciliação antes de qualquer envio.'
 WHERE status='sent' OR (status IN ('pending','processing') AND (initial_sent_at IS NULL OR instance_name IS NULL OR session_uuid IS NULL));
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.agent_followups WHERE status IN ('pending','processing','sending','ambiguous')
  GROUP BY client_id,agent_id,remote_jid HAVING count(*)>1) THEN
  RAISE EXCEPTION 'duplicate_active_followups: reconcilie duplicatas sem apagar registros';
 END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS agent_followups_one_active_idx ON public.agent_followups(client_id,agent_id,remote_jid)
 WHERE status IN ('pending','processing','sending','ambiguous');
ALTER TABLE public.agent_followups ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_followups FROM PUBLIC,anon,authenticated;
REVOKE ALL ON SEQUENCE public.agent_followups_id_seq FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.agent_followups TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.agent_followups_id_seq TO service_role;

CREATE OR REPLACE FUNCTION public.enqueue_agent_followup(p_client uuid,p_agent integer,p_session uuid,p_jid text,p_instance text,p_initial_sent_at timestamptz,p_contact uuid DEFAULT NULL,p_lead bigint DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE a public.agent_settings%ROWTYPE; f public.agent_followups%ROWTYPE; delay_minutes integer;
BEGIN
 IF p_client IS NULL OR p_agent IS NULL OR p_agent<=0 OR p_jid IS NULL OR p_jid !~ '^[1-9][0-9]{7,19}@s[.]whatsapp[.]net$'
 OR p_instance IS NULL OR btrim(p_instance)='' OR p_initial_sent_at IS NULL OR p_initial_sent_at>clock_timestamp()+interval '1 minute' THEN RAISE EXCEPTION 'followup_invalid_input'; END IF;
 SELECT * INTO a FROM public.agent_settings WHERE id=p_agent AND client_id=p_client;
 IF NOT FOUND OR a.is_active IS DISTINCT FROM true OR a.options->'follow_up'->'enabled' IS DISTINCT FROM 'true'::jsonb THEN RAISE EXCEPTION 'followup_agent_disabled'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.channel_connections WHERE client_id=p_client AND agent_id=p_agent AND instance_name=p_instance) THEN RAISE EXCEPTION 'followup_channel_not_owned'; END IF;
 IF coalesce(a.options->'follow_up'->>'follow_up_1h_delay_minutes','') !~ '^[0-9]{1,6}$' THEN RAISE EXCEPTION 'followup_invalid_delay'; END IF;
 delay_minutes:=(a.options->'follow_up'->>'follow_up_1h_delay_minutes')::integer;
 IF delay_minutes NOT BETWEEN 1 AND 10080 THEN RAISE EXCEPTION 'followup_invalid_delay'; END IF;
 IF NOT EXISTS (SELECT 1 FROM public.sessions s JOIN public.contacts c ON c.id=s.contact_id AND c.client_id=s.client_id
  WHERE s.id=p_session AND s.client_id=p_client AND s.agent_id=p_agent AND s.instance_name=p_instance AND c.remote_jid=p_jid
  AND (p_contact IS NULL OR s.contact_id=p_contact)) THEN RAISE EXCEPTION 'followup_session_not_owned'; END IF;
 INSERT INTO public.agent_followups(client_id,agent_id,session_uuid,remote_jid,instance_name,initial_sent_at,contact_uuid,lead_id,next_send_at)
 VALUES(p_client::text,p_agent,p_session,p_jid,p_instance,p_initial_sent_at,p_contact,p_lead,p_initial_sent_at+make_interval(mins=>delay_minutes))
 ON CONFLICT(client_id,agent_id,remote_jid) WHERE status IN ('pending','processing','sending','ambiguous') DO NOTHING RETURNING * INTO f;
 IF NOT FOUND THEN SELECT * INTO f FROM public.agent_followups WHERE client_id=p_client::text AND agent_id=p_agent AND remote_jid=p_jid AND status IN ('pending','processing','sending','ambiguous'); END IF;
 IF f.id IS NULL THEN RAISE EXCEPTION 'followup_enqueue_not_confirmed'; END IF;
 RETURN to_jsonb(f);
END $$;

CREATE OR REPLACE FUNCTION public.claim_agent_followup(p_claim uuid,p_lease_seconds integer DEFAULT 120)
RETURNS SETOF public.agent_followups LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE selected bigint;
BEGIN
 IF p_claim IS NULL OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 30 AND 300 THEN RAISE EXCEPTION 'followup_invalid_claim'; END IF;
 SELECT id INTO selected FROM public.agent_followups WHERE (status='pending' AND next_send_at<=clock_timestamp())
 OR (status='processing' AND lease_expires_at<=clock_timestamp() AND send_started_at IS NULL)
 ORDER BY next_send_at,id LIMIT 1 FOR UPDATE SKIP LOCKED;
 IF selected IS NOT NULL THEN RETURN QUERY UPDATE public.agent_followups SET status='processing',claim_id=p_claim,
 lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),attempt_id=NULL,send_started_at=NULL,send_content=NULL,prepared_next_delay_minutes=NULL,updated_at=clock_timestamp()
 WHERE id=selected RETURNING *; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.prepare_agent_followup(p_id bigint,p_client uuid,p_agent integer,p_step integer,p_claim uuid,p_attempt uuid,p_content text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE f public.agent_followups%ROWTYPE; a public.agent_settings%ROWTYPE; cfg jsonb; step_name text; next_name text; next_delay integer:=0;
BEGIN
 SELECT * INTO f FROM public.agent_followups WHERE id=p_id AND client_id=p_client::text AND agent_id=p_agent AND current_step=p_step AND claim_id=p_claim AND status='processing' AND lease_expires_at>clock_timestamp() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'followup_claim_lost'; END IF;
 IF p_attempt IS NULL OR p_step NOT BETWEEN 1 AND 4 OR f.max_step NOT BETWEEN p_step AND 4 OR f.initial_sent_at IS NULL OR f.instance_name IS NULL
 OR f.remote_jid !~ '^[1-9][0-9]{7,19}@s[.]whatsapp[.]net$' THEN RAISE EXCEPTION 'followup_invalid_input'; END IF;
 SELECT * INTO a FROM public.agent_settings WHERE id=p_agent AND client_id=p_client FOR SHARE;
 IF NOT FOUND OR a.is_active IS DISTINCT FROM true OR a.options->'follow_up'->'enabled' IS DISTINCT FROM 'true'::jsonb
 OR NOT EXISTS (SELECT 1 FROM public.channel_connections WHERE client_id=p_client AND agent_id=p_agent AND instance_name=f.instance_name)
 OR EXISTS (SELECT 1 FROM public.chats_dashboard WHERE client_id=p_client AND remote_jid=f.remote_jid AND instance_name=f.instance_name AND is_from_me IS FALSE AND created_at>=f.initial_sent_at)
 OR NOT EXISTS (SELECT 1 FROM public.sessions s JOIN public.contacts c ON c.id=s.contact_id AND c.client_id=s.client_id
  WHERE s.id=f.session_uuid AND s.client_id=p_client AND s.agent_id=p_agent AND c.remote_jid=f.remote_jid AND s.instance_name=f.instance_name
  AND (s.bot_status='bot_active' OR (s.bot_status='human_takeover' AND s.resume_at<=clock_timestamp())))
 OR EXISTS (SELECT 1 FROM public.app_settings WHERE key IN ('global_ai_paused_until','global_ai_paused_until:'||f.instance_name)
  AND value IS NOT NULL AND value<>'' AND CASE WHEN value='forever' THEN true ELSE value::timestamptz>clock_timestamp() END)
 OR EXISTS (SELECT 1 FROM public.ai_control WHERE remote_jid=f.remote_jid AND is_paused IS TRUE AND (paused_until IS NULL OR paused_until>clock_timestamp())) THEN
  UPDATE public.agent_followups SET status='cancelled',claim_id=NULL,lease_expires_at=NULL,error_message=NULL,updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO f;
  RETURN jsonb_build_object('action','cancelled','followup',to_jsonb(f));
 END IF;
 cfg:=a.options->'follow_up';
 step_name:=CASE p_step WHEN 1 THEN '1h' WHEN 2 THEN '4h' WHEN 3 THEN '24h' WHEN 4 THEN '48h' END;
 IF p_step<f.max_step THEN
  next_name:=CASE p_step WHEN 1 THEN '4h' WHEN 2 THEN '24h' WHEN 3 THEN '48h' END;
  IF coalesce(cfg->>('follow_up_'||next_name||'_delay_minutes'),'') !~ '^[0-9]{1,6}$' THEN RAISE EXCEPTION 'followup_invalid_delay'; END IF;
  next_delay:=(cfg->>('follow_up_'||next_name||'_delay_minutes'))::integer;
  IF next_delay NOT BETWEEN 1 AND 10080 THEN RAISE EXCEPTION 'followup_invalid_delay'; END IF;
 END IF;
 IF cfg->('follow_up_'||step_name||'_enabled') IS DISTINCT FROM 'true'::jsonb THEN
  UPDATE public.agent_followups SET status=CASE WHEN p_step<max_step THEN 'pending' ELSE 'completed' END,
   current_step=CASE WHEN p_step<max_step THEN p_step+1 ELSE p_step END,next_send_at=clock_timestamp()+make_interval(mins=>next_delay),
   claim_id=NULL,lease_expires_at=NULL,error_message=NULL,updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO f;
  RETURN jsonb_build_object('action','skipped','followup',to_jsonb(f));
 END IF;
 IF jsonb_typeof(cfg->('follow_up_'||step_name||'_template')) IS DISTINCT FROM 'string'
 OR btrim(coalesce(cfg->>('follow_up_'||step_name||'_template'),''))='' OR p_content IS NULL OR btrim(p_content)='' OR length(p_content)>4000 THEN RAISE EXCEPTION 'followup_invalid_content'; END IF;
 UPDATE public.agent_followups SET status='sending',attempt_id=p_attempt,send_started_at=clock_timestamp(),send_content=p_content,prepared_next_delay_minutes=next_delay,error_message=NULL,updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO f;
 RETURN jsonb_build_object('action','send','followup',to_jsonb(f));
END $$;

CREATE OR REPLACE FUNCTION public.finish_agent_followup(p_id bigint,p_client uuid,p_agent integer,p_step integer,p_claim uuid,p_attempt uuid,p_provider_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE f public.agent_followups%ROWTYPE; h public.chats_dashboard%ROWTYPE; sent_at timestamptz;
BEGIN
 IF p_claim IS NULL OR p_attempt IS NULL OR p_provider_id IS NULL OR btrim(p_provider_id)='' OR length(p_provider_id)>300 THEN RAISE EXCEPTION 'followup_invalid_result'; END IF;
 SELECT * INTO f FROM public.agent_followups WHERE id=p_id AND client_id=p_client::text AND agent_id=p_agent FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'followup_claim_lost'; END IF;
 IF f.last_attempt_id=p_attempt THEN
  IF f.last_claim_id IS DISTINCT FROM p_claim OR f.last_completed_step IS DISTINCT FROM p_step OR f.provider_message_id IS DISTINCT FROM p_provider_id THEN RAISE EXCEPTION 'followup_attempt_mismatch'; END IF;
  RETURN to_jsonb(f);
 END IF;
 IF f.status NOT IN ('sending','ambiguous') OR f.claim_id IS DISTINCT FROM p_claim OR f.attempt_id IS DISTINCT FROM p_attempt OR f.current_step IS DISTINCT FROM p_step OR f.send_started_at IS NULL OR f.send_content IS NULL THEN RAISE EXCEPTION 'followup_claim_lost'; END IF;
 sent_at:=f.send_started_at;
 -- Uma intenção persistida nunca é substituída; confirmação tardia pode concluir.
 INSERT INTO public.chats_dashboard(client_id,remote_jid,instance_name,message_id,content,sender_type,is_from_me,message_type,created_at)
 VALUES(p_client,f.remote_jid,f.instance_name,p_provider_id,f.send_content,'ai',true,'text',sent_at) ON CONFLICT(client_id,message_id) DO NOTHING;
 SELECT * INTO h FROM public.chats_dashboard WHERE client_id=p_client AND message_id=p_provider_id;
 IF NOT FOUND OR h.remote_jid IS DISTINCT FROM f.remote_jid OR h.instance_name IS DISTINCT FROM f.instance_name OR h.content IS DISTINCT FROM f.send_content OR h.is_from_me IS DISTINCT FROM true THEN RAISE EXCEPTION 'followup_history_conflict'; END IF;
 UPDATE public.agent_followups SET status=CASE WHEN p_step<max_step THEN 'pending' ELSE 'completed' END,
 current_step=CASE WHEN p_step<max_step THEN p_step+1 ELSE p_step END,last_sent_at=sent_at,next_send_at=sent_at+make_interval(mins=>coalesce(prepared_next_delay_minutes,0)),
 provider_message_id=p_provider_id,last_attempt_id=p_attempt,last_claim_id=p_claim,last_completed_step=p_step,
 claim_id=NULL,lease_expires_at=NULL,attempt_id=NULL,send_started_at=NULL,send_content=NULL,prepared_next_delay_minutes=NULL,error_message=NULL,updated_at=sent_at WHERE id=p_id RETURNING * INTO f;
 RETURN to_jsonb(f);
END $$;

CREATE OR REPLACE FUNCTION public.release_agent_followup(p_id bigint,p_client uuid,p_agent integer,p_step integer,p_claim uuid,p_status text,p_error text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE f public.agent_followups%ROWTYPE;
BEGIN
 SELECT * INTO f FROM public.agent_followups WHERE id=p_id AND client_id=p_client::text AND agent_id=p_agent AND current_step=p_step AND claim_id=p_claim FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'followup_claim_lost'; END IF;
 IF f.status IN ('sending','ambiguous') THEN
  IF p_status IS DISTINCT FROM 'ambiguous' THEN RAISE EXCEPTION 'followup_replay_blocked'; END IF;
  UPDATE public.agent_followups SET status='ambiguous',error_message='Resultado do envio desconhecido. Reconciliação obrigatória; reenvio automático bloqueado.',updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO f;
 ELSE
  IF f.status IS DISTINCT FROM 'processing' OR f.lease_expires_at IS NULL OR f.lease_expires_at<=clock_timestamp() OR p_status IS NULL OR p_status NOT IN ('pending','cancelled','failed') THEN RAISE EXCEPTION 'followup_claim_lost'; END IF;
  UPDATE public.agent_followups SET status=p_status,claim_id=NULL,lease_expires_at=NULL,
  error_message=CASE WHEN p_status='failed' THEN 'Preparação do follow-up falhou; nenhum envio foi confirmado.' ELSE NULL END,updated_at=clock_timestamp() WHERE id=p_id RETURNING * INTO f;
 END IF;
 RETURN to_jsonb(f);
END $$;

DO $$ DECLARE signature text;
BEGIN
 FOREACH signature IN ARRAY ARRAY[
  'enqueue_agent_followup(uuid,integer,uuid,text,text,timestamptz,uuid,bigint)',
  'claim_agent_followup(uuid,integer)',
  'prepare_agent_followup(bigint,uuid,integer,integer,uuid,uuid,text)',
  'finish_agent_followup(bigint,uuid,integer,integer,uuid,uuid,text)',
  'release_agent_followup(bigint,uuid,integer,integer,uuid,text,text)'
 ] LOOP
  EXECUTE 'REVOKE ALL ON FUNCTION public.'||signature||' FROM PUBLIC,anon,authenticated';
  EXECUTE 'GRANT EXECUTE ON FUNCTION public.'||signature||' TO service_role';
 END LOOP;
END $$;
COMMIT;
