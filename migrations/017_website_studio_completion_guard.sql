-- Incremental defense: failed agent output must never replace the working revision.
-- Apply after 016. No table/schema changes and no SECURITY DEFINER elevation.
BEGIN;

CREATE OR REPLACE FUNCTION public.website_complete_run(
  p_client_id uuid, p_project_id uuid, p_run_id uuid, p_worker_id uuid,
  p_expected_revision_id uuid, p_files jsonb, p_build jsonb, p_summary text, p_model_used text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  v_run public.website_runs;
  v_revision jsonb;
  v_revision_id uuid;
  v_status text; v_success boolean; v_logs text; v_duration integer;
  v_artifact jsonb; v_errors jsonb; v_warnings jsonb; v_screens jsonb; v_qa jsonb;
BEGIN
  PERFORM public.website_assert_access(p_client_id);
  IF p_summary IS NULL OR length(btrim(p_summary)) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  PERFORM 1 FROM public.website_projects WHERE client_id = p_client_id AND id = p_project_id AND deleted_at IS NULL FOR UPDATE;
  SELECT * INTO v_run FROM public.website_runs WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_run_id
    AND worker_id = p_worker_id AND lease_expires_at > now() AND cancel_requested = false
    AND status IN ('planning','editing','validating') FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'website_lease_lost'; END IF;
  IF v_run.base_revision_id IS DISTINCT FROM p_expected_revision_id THEN RAISE EXCEPTION 'website_lease_lost'; END IF;
  v_revision_id := v_run.base_revision_id;
  IF p_build IS NULL OR jsonb_typeof(p_build) <> 'object' OR octet_length(p_build::text) > 83886080
    OR length(p_model_used) > 160 THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  v_status := coalesce(p_build->>'status', 'failed');
  IF v_status NOT IN ('ready','failed','unconfigured') THEN RAISE EXCEPTION 'website_invalid_input'; END IF;
  v_success := coalesce((p_build->>'success')::boolean, false);
  v_logs := left(coalesce(p_build->>'logs', ''), 100000);
  v_duration := coalesce((p_build->>'duration_ms')::integer, 0);
  v_artifact := coalesce(p_build->'artifact', '{}'::jsonb);
  v_errors := coalesce(p_build->'errors', '[]'::jsonb);
  v_warnings := coalesce(p_build->'warnings', '[]'::jsonb);
  v_screens := coalesce(p_build->'screenshots', '{}'::jsonb);
  v_qa := coalesce(p_build->'qa', '{"passed":false,"errors":[],"warnings":[]}'::jsonb);
  IF jsonb_typeof(v_artifact) <> 'object' OR octet_length(v_artifact::text) > 58720256
    OR jsonb_typeof(v_screens) <> 'object' OR octet_length(v_screens::text) > 25165824
    OR jsonb_typeof(v_qa) <> 'object' OR octet_length(v_qa::text) > 262144
    OR (jsonb_typeof(v_errors) <> 'array' AND v_errors <> '[]'::jsonb)
    OR (jsonb_typeof(v_warnings) <> 'array' AND v_warnings <> '[]'::jsonb)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_errors) = 'array' THEN v_errors ELSE '[]'::jsonb END) e WHERE jsonb_typeof(e) <> 'string' OR length(e #>> '{}') > 1000)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_warnings) = 'array' THEN v_warnings ELSE '[]'::jsonb END) w WHERE jsonb_typeof(w) <> 'string' OR length(w #>> '{}') > 1000)
  THEN RAISE EXCEPTION 'website_invalid_input'; END IF;

  -- Build-only runs retain their report, including a failed QA, without saving files.
  -- An explicit unconfigured result is a deliberate, unvalidated draft, never a ready build.
  IF v_run.kind = 'agent' THEN
    IF p_files IS NULL OR v_status = 'failed'
      OR (v_status = 'unconfigured' AND (p_build->'success' IS DISTINCT FROM 'false'::jsonb
        OR v_qa->'passed' IS DISTINCT FROM 'false'::jsonb))
      OR (v_status = 'ready' AND (p_build->'success' IS DISTINCT FROM 'true'::jsonb
        OR v_errors IS DISTINCT FROM '[]'::jsonb
        OR v_qa->'passed' IS DISTINCT FROM 'true'::jsonb
        OR v_qa->'errors' IS DISTINCT FROM '[]'::jsonb
        OR coalesce(v_screens->>'desktop', '') NOT LIKE 'data:image/png;base64,iVBOR%'
        OR coalesce(v_screens->>'mobile', '') NOT LIKE 'data:image/png;base64,iVBOR%'
        OR NOT (v_artifact ? '/index.html'))) THEN
      RAISE EXCEPTION 'website_invalid_input';
    END IF;
    v_revision := public.website_save_revision(p_client_id, p_project_id, p_files, 'Edição pelo agente',
      v_run.actor_id, p_expected_revision_id, p_run_id, p_worker_id);
    v_revision_id := (v_revision->>'id')::uuid;
  END IF;

  INSERT INTO public.website_builds(client_id, project_id, revision_id, status, success, logs, duration_ms, artifact, errors, warnings, screenshots, qa)
    VALUES (p_client_id, p_project_id, v_revision_id, v_status, v_success, v_logs, GREATEST(v_duration, 0), v_artifact, v_errors, v_warnings, v_screens, v_qa);
  UPDATE public.website_runs SET status = 'completed', model_used = p_model_used, worker_id = NULL, lease_expires_at = NULL, error = NULL, updated_at = now()
    WHERE client_id = p_client_id AND project_id = p_project_id AND id = p_run_id RETURNING * INTO v_run;
  PERFORM public.website_liquidate_run_reservations(p_client_id, p_run_id);
  INSERT INTO public.website_messages(client_id, project_id, run_id, role, content)
    VALUES (p_client_id, p_project_id, p_run_id, 'assistant', p_summary);
  RETURN to_jsonb(v_run);
END $$;

-- CREATE OR REPLACE retains grants on installed databases. Explicitly harden fresh setups too.
REVOKE ALL ON FUNCTION public.website_complete_run(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text,text) FROM PUBLIC;
DO $$
DECLARE v_role text;
BEGIN
  FOR v_role IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION public.website_complete_run(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text,text) FROM %I', v_role);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    GRANT EXECUTE ON FUNCTION public.website_complete_run(uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text,text) TO service_role;
  END IF;
END $$;

COMMIT;
