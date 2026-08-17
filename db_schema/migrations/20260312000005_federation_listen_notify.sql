BEGIN;

-- Add pg_notify to queue_federation_job for instant job pickup via LISTEN/NOTIFY.
-- This allows the federation worker to process jobs immediately instead of waiting
-- for the pg-boss polling interval (was 1s, now 10s safety net).

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text,
    p_job_data jsonb,
    p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5,
    p_expire_in_seconds integer DEFAULT 3600
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_job_id uuid;
    v_target_domain text;
BEGIN
    INSERT INTO pgboss.job (
        id, name, data, priority, retry_limit,
        expire_in, created_on, state
    ) VALUES (
        gen_random_uuid(), p_job_name, p_job_data, p_priority, p_retry_limit,
        make_interval(secs => p_expire_in_seconds), now(), 'created'
    )
    RETURNING id INTO v_job_id;

    -- Notify the worker process so it can fetch the job instantly
    -- instead of waiting for the next pg-boss poll cycle
    PERFORM pg_notify('federation_jobs', json_build_object(
        'name', p_job_name,
        'id', v_job_id::text
    )::text);

    RETURN v_job_id;
EXCEPTION
    WHEN undefined_table OR insufficient_privilege THEN
        v_target_domain := p_job_data->>'target_domain';
        IF v_target_domain IS NOT NULL AND v_target_domain != '' THEN
            RAISE LOG 'pg-boss not available, using fallback for job % to %', p_job_name, v_target_domain;
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
            RAISE LOG 'pg-boss not available, skipping job %', p_job_name;
            RETURN NULL;
        END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
