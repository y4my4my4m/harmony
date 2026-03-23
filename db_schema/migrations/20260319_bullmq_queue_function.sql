BEGIN;

-- =============================================================================
-- Phase 4: Simplify queue_federation_job() for BullMQ
--
-- pg-boss is no longer the job backend.  BullMQ (Redis-backed) handles job
-- lifecycle instead.  The bridge from DB triggers to BullMQ is:
--
--   DB trigger → queue_federation_job() → pg_notify('federation_jobs', payload)
--                                         → NotificationListener → BullMQ queue.add()
--
-- Changes:
--   1. Remove INSERT INTO pgboss.job (no longer needed)
--   2. Include the full job data in the pg_notify payload so the listener
--      can add it to BullMQ without needing to fetch from a table
--   3. Keep federation_delivery_queue fallback for when the worker is down
-- =============================================================================

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text,
    p_job_data jsonb,
    p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5,
    p_expire_in_seconds integer DEFAULT 3600
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_job_id uuid;
    v_target_domain text;
BEGIN
    v_job_id := gen_random_uuid();

    PERFORM pg_notify('federation_jobs', json_build_object(
        'name', p_job_name,
        'id', v_job_id::text,
        'data', p_job_data
    )::text);

    RETURN v_job_id;
EXCEPTION
    WHEN OTHERS THEN
        v_target_domain := p_job_data->>'target_domain';
        IF v_target_domain IS NOT NULL AND v_target_domain != '' THEN
            RAISE LOG 'pg_notify failed, using delivery queue fallback for job % to %', p_job_name, v_target_domain;
            INSERT INTO public.federation_delivery_queue (
                activity_json, inbox_url,
                sender_id, status, scheduled_at
            ) VALUES (
                p_job_data,
                COALESCE(p_job_data->>'target_inbox', 'https://' || v_target_domain || '/inbox'),
                (p_job_data->>'sender_id')::UUID,
                'pending',
                NOW()
            )
            RETURNING id INTO v_job_id;

            PERFORM pg_notify('federation_jobs', json_build_object(
                'name', 'delivery-queue-fallback',
                'id', v_job_id::text
            )::text);

            RETURN v_job_id;
        ELSE
            RAISE LOG 'pg_notify failed, skipping job %', p_job_name;
            RETURN NULL;
        END IF;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
