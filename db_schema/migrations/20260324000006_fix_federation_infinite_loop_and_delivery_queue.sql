BEGIN;

-- =========================================================================
-- Fix 1: Infinite federation loop
--
-- Problem: handleChannelCrudJob updates federation_status = 'completed',
-- which fires the BEFORE UPDATE trigger, which re-queues a federation job
-- (type 'update'), creating an infinite cycle that floods remote /inbox.
--
-- Solution: Skip federation queueing when only federation_status changed.
-- =========================================================================

-- Channel CRUD → federate-channel-crud (with loop guard)
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_server_is_local boolean;
    v_federation_enabled boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        SELECT s.is_local_server, s.federation_enabled
        INTO v_server_is_local, v_federation_enabled
        FROM servers s WHERE s.id = OLD.server_id;

        IF v_server_is_local IS NOT TRUE OR v_federation_enabled IS NOT TRUE THEN
            RETURN OLD;
        END IF;

        PERFORM public.queue_federation_job(
            'federate-channel-crud',
            jsonb_build_object('type', 'delete', 'channel_id', OLD.id, 'server_id', OLD.server_id),
            5, 5, 900
        );
        RETURN OLD;
    END IF;

    IF NEW.is_remote THEN
        NEW.federation_status := 'skipped';
        RETURN NEW;
    END IF;

    SELECT s.is_local_server, s.federation_enabled
    INTO v_server_is_local, v_federation_enabled
    FROM servers s WHERE s.id = NEW.server_id;

    IF v_server_is_local IS NOT TRUE OR v_federation_enabled IS NOT TRUE THEN
        NEW.federation_status := 'skipped';
        RETURN NEW;
    END IF;

    -- Guard: skip re-federation when only federation_status changed
    -- (prevents infinite loop from handler updating status after delivery)
    IF TG_OP = 'UPDATE' AND
       OLD.name          IS NOT DISTINCT FROM NEW.name AND
       OLD.description   IS NOT DISTINCT FROM NEW.description AND
       OLD.type          IS NOT DISTINCT FROM NEW.type AND
       OLD.category      IS NOT DISTINCT FROM NEW.category AND
       OLD.server_id     IS NOT DISTINCT FROM NEW.server_id AND
       OLD."order"       IS NOT DISTINCT FROM NEW."order" AND
       OLD.is_private    IS NOT DISTINCT FROM NEW.is_private AND
       OLD.slowmode_seconds IS NOT DISTINCT FROM NEW.slowmode_seconds AND
       OLD.ap_id         IS NOT DISTINCT FROM NEW.ap_id
    THEN
        RETURN NEW;
    END IF;

    NEW.federation_status := 'queued';
    PERFORM public.queue_federation_job(
        'federate-channel-crud',
        jsonb_build_object(
            'type', CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
            'channel_id', NEW.id,
            'server_id', NEW.server_id
        ),
        5, 5, 900
    );
    RETURN NEW;
END;
$$;

-- Category CRUD → federate-category-crud (with loop guard)
CREATE OR REPLACE FUNCTION public.trigger_queue_category_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_server_is_local boolean;
    v_federation_enabled boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        SELECT s.is_local_server, s.federation_enabled
        INTO v_server_is_local, v_federation_enabled
        FROM servers s WHERE s.id = OLD.server_id;

        IF v_server_is_local IS NOT TRUE OR v_federation_enabled IS NOT TRUE THEN
            RETURN OLD;
        END IF;

        PERFORM public.queue_federation_job(
            'federate-category-crud',
            jsonb_build_object('type', 'delete', 'category_id', OLD.id, 'server_id', OLD.server_id),
            5, 5, 900
        );
        RETURN OLD;
    END IF;

    SELECT s.is_local_server, s.federation_enabled
    INTO v_server_is_local, v_federation_enabled
    FROM servers s WHERE s.id = NEW.server_id;

    IF v_server_is_local IS NOT TRUE OR v_federation_enabled IS NOT TRUE THEN
        NEW.federation_status := 'skipped';
        RETURN NEW;
    END IF;

    -- Guard: skip re-federation when only federation_status changed
    IF TG_OP = 'UPDATE' AND
       OLD.name      IS NOT DISTINCT FROM NEW.name AND
       OLD."order"   IS NOT DISTINCT FROM NEW."order" AND
       OLD.server_id IS NOT DISTINCT FROM NEW.server_id
    THEN
        RETURN NEW;
    END IF;

    NEW.federation_status := 'queued';
    PERFORM public.queue_federation_job(
        'federate-category-crud',
        jsonb_build_object(
            'type', CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
            'category_id', NEW.id,
            'server_id', NEW.server_id
        ),
        5, 5, 900
    );
    RETURN NEW;
END;
$$;

-- =========================================================================
-- Fix 2: federation_delivery_queue schema mismatch
--
-- Problem: DeliveryQueue.ts uses activity_data, target_inbox_url,
-- target_domain, error_message, http_status_code, next_attempt_at, etc.
-- but init schema defines activity_json, inbox_url, last_error, scheduled_at.
--
-- Solution: Add missing columns so both old and new column sets work.
-- Make sender_id nullable (code allows null for legacy items).
-- =========================================================================

ALTER TABLE public.federation_delivery_queue
    ADD COLUMN IF NOT EXISTS activity_data jsonb,
    ADD COLUMN IF NOT EXISTS target_inbox_url text,
    ADD COLUMN IF NOT EXISTS target_domain text,
    ADD COLUMN IF NOT EXISTS error_message text,
    ADD COLUMN IF NOT EXISTS http_status_code integer,
    ADD COLUMN IF NOT EXISTS next_attempt_at timestamp with time zone DEFAULT now(),
    ADD COLUMN IF NOT EXISTS priority integer DEFAULT 5,
    ADD COLUMN IF NOT EXISTS actor_username text,
    ADD COLUMN IF NOT EXISTS actor_domain text,
    ADD COLUMN IF NOT EXISTS delivered_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now(),
    ADD COLUMN IF NOT EXISTS response_body text,
    ADD COLUMN IF NOT EXISTS delivery_duration_ms integer;

-- Make sender_id nullable (code handles null with actor_username fallback)
ALTER TABLE public.federation_delivery_queue ALTER COLUMN sender_id DROP NOT NULL;

-- Add priority check constraint if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'federation_delivery_queue_priority_check'
    ) THEN
        ALTER TABLE public.federation_delivery_queue
            ADD CONSTRAINT federation_delivery_queue_priority_check
            CHECK (priority >= 1 AND priority <= 10);
    END IF;
END $$;

-- Ensure the status check allows 'delivered' (the code uses it)
ALTER TABLE public.federation_delivery_queue DROP CONSTRAINT IF EXISTS federation_delivery_queue_status_check;
ALTER TABLE public.federation_delivery_queue
    ADD CONSTRAINT federation_delivery_queue_status_check
    CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'dead', 'delivered', 'cancelled'));

-- Backfill: copy data from old columns to new columns for existing rows
-- (handles DBs created from init that used the old column names)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'federation_delivery_queue'
        AND column_name = 'activity_json'
    ) THEN
        UPDATE public.federation_delivery_queue
        SET activity_data = activity_json
        WHERE activity_data IS NULL AND activity_json IS NOT NULL;

        UPDATE public.federation_delivery_queue
        SET target_inbox_url = inbox_url
        WHERE target_inbox_url IS NULL AND inbox_url IS NOT NULL;

        UPDATE public.federation_delivery_queue
        SET error_message = last_error
        WHERE error_message IS NULL AND last_error IS NOT NULL;

        UPDATE public.federation_delivery_queue
        SET next_attempt_at = scheduled_at
        WHERE next_attempt_at IS NULL AND scheduled_at IS NOT NULL;
    END IF;
END $$;

-- Add useful indexes
CREATE INDEX IF NOT EXISTS idx_fdq_next_attempt
    ON public.federation_delivery_queue(next_attempt_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_fdq_target_domain
    ON public.federation_delivery_queue(target_domain);

-- =========================================================================
-- Fix 3: Update queue_federation_job fallback to use correct column names
-- =========================================================================

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
                activity_data, target_inbox_url, target_domain,
                sender_id, status, next_attempt_at
            ) VALUES (
                p_job_data,
                COALESCE(p_job_data->>'target_inbox', 'https://' || v_target_domain || '/inbox'),
                v_target_domain,
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

NOTIFY pgrst, 'reload schema';

COMMIT;
