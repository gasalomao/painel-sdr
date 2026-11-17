-- Reagendamento seguro de follow-up pendente fora do horário comercial.
-- Evita re-claim a cada 2 minutos enquanto aguarda abertura do expediente.
CREATE OR REPLACE FUNCTION public.reschedule_agent_followup(
  p_id bigint,
  p_client uuid,
  p_agent integer,
  p_step integer,
  p_claim uuid,
  p_next_send_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f public.agent_followups%ROWTYPE;
BEGIN
  IF p_claim IS NULL OR p_next_send_at IS NULL OR p_next_send_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'followup_invalid_reschedule';
  END IF;

  SELECT * INTO f
  FROM public.agent_followups
  WHERE id = p_id
    AND client_id = p_client::text
    AND agent_id = p_agent
    AND current_step = p_step
    AND claim_id = p_claim
    AND status = 'processing'
    AND lease_expires_at > clock_timestamp()
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'followup_claim_lost';
  END IF;

  UPDATE public.agent_followups
  SET status = 'pending',
      next_send_at = p_next_send_at,
      claim_id = NULL,
      lease_expires_at = NULL,
      error_message = NULL,
      updated_at = clock_timestamp()
  WHERE id = p_id
  RETURNING * INTO f;

  RETURN to_jsonb(f);
END $$;

REVOKE ALL ON FUNCTION public.reschedule_agent_followup(bigint, uuid, integer, integer, uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reschedule_agent_followup(bigint, uuid, integer, integer, uuid, timestamptz) TO service_role;

