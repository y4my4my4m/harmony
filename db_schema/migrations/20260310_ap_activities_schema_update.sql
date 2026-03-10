BEGIN;

-- =============================================================================
-- Migrate ap_activities from old init schema to production schema
-- =============================================================================
-- Old schema had: activity_type, actor_id (text), activity_json, is_inbound, retry_count, processed_at
-- New schema has:  ap_id, ap_type, actor_ap_id, activity_data, to/cc/bto/bcc_addresses, is_local, origin_domain, etc.
-- =============================================================================

-- Only run the migration if the table has the old column layout
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'ap_activities' AND column_name = 'activity_type'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'ap_activities' AND column_name = 'ap_id'
    ) THEN
        RAISE NOTICE 'Migrating ap_activities from old schema to new schema...';

        -- Drop old constraints
        ALTER TABLE public.ap_activities DROP CONSTRAINT IF EXISTS ap_activities_status_check;

        -- Rename old columns
        ALTER TABLE public.ap_activities RENAME COLUMN activity_type TO ap_type;
        ALTER TABLE public.ap_activities RENAME COLUMN activity_json TO activity_data;

        -- Alter existing columns
        ALTER TABLE public.ap_activities ALTER COLUMN activity_data SET DEFAULT '{}'::jsonb;

        -- The old actor_id was text (AP URL); rename to actor_ap_id
        ALTER TABLE public.ap_activities RENAME COLUMN actor_id TO actor_ap_id;

        -- Add new columns
        ALTER TABLE public.ap_activities ADD COLUMN IF NOT EXISTS ap_id text;
        ALTER TABLE public.ap_activities ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();
        ALTER TABLE public.ap_activities ADD COLUMN IF NOT EXISTS actor_id uuid;
        ALTER TABLE public.ap_activities ADD COLUMN IF NOT EXISTS target_type text;
        ALTER TABLE public.ap_activities ADD COLUMN IF NOT EXISTS to_addresses text[] DEFAULT '{}'::text[];
        ALTER TABLE public.ap_activities ADD COLUMN IF NOT EXISTS cc_addresses text[] DEFAULT '{}'::text[];
        ALTER TABLE public.ap_activities ADD COLUMN IF NOT EXISTS bto_addresses text[] DEFAULT '{}'::text[];
        ALTER TABLE public.ap_activities ADD COLUMN IF NOT EXISTS bcc_addresses text[] DEFAULT '{}'::text[];
        ALTER TABLE public.ap_activities ADD COLUMN IF NOT EXISTS attempts integer DEFAULT 0;
        ALTER TABLE public.ap_activities ADD COLUMN IF NOT EXISTS last_attempt_at timestamp with time zone;
        ALTER TABLE public.ap_activities ADD COLUMN IF NOT EXISTS next_attempt_at timestamp with time zone;
        ALTER TABLE public.ap_activities ADD COLUMN IF NOT EXISTS is_local boolean DEFAULT true;
        ALTER TABLE public.ap_activities ADD COLUMN IF NOT EXISTS source_domain text;
        ALTER TABLE public.ap_activities ADD COLUMN IF NOT EXISTS origin_domain text;

        -- Drop old columns
        ALTER TABLE public.ap_activities DROP COLUMN IF EXISTS is_inbound;
        ALTER TABLE public.ap_activities DROP COLUMN IF EXISTS retry_count;
        ALTER TABLE public.ap_activities DROP COLUMN IF EXISTS processed_at;

        -- Backfill ap_id from id for existing rows (use the UUID as a fallback AP ID)
        UPDATE public.ap_activities SET ap_id = id::text WHERE ap_id IS NULL;
        ALTER TABLE public.ap_activities ALTER COLUMN ap_id SET NOT NULL;

        -- Add new constraints
        ALTER TABLE public.ap_activities ADD CONSTRAINT ap_activities_status_check
            CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'received', 'processed'));

        RAISE NOTICE 'ap_activities migration complete.';
    ELSE
        RAISE NOTICE 'ap_activities already has new schema or does not exist, skipping migration.';
    END IF;
END $$;

-- Ensure unique index on ap_id exists
CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_activities_ap_id ON public.ap_activities(ap_id);

-- Ensure the upsert function exists
CREATE OR REPLACE FUNCTION public.upsert_ap_activity(
    p_ap_id text,
    p_ap_type text,
    p_actor_ap_id text,
    p_activity_data jsonb,
    p_origin_domain text DEFAULT NULL,
    p_to_addresses text[] DEFAULT '{}'::text[],
    p_cc_addresses text[] DEFAULT '{}'::text[],
    p_bto_addresses text[] DEFAULT '{}'::text[],
    p_bcc_addresses text[] DEFAULT '{}'::text[],
    p_is_local boolean DEFAULT false
)
RETURNS TABLE(activity_id uuid, was_updated boolean)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_activity_id UUID;
    v_was_updated BOOLEAN := FALSE;
    v_existing_status TEXT;
BEGIN
    SELECT id, status INTO v_activity_id, v_existing_status
    FROM ap_activities
    WHERE ap_id = p_ap_id;

    IF v_activity_id IS NOT NULL THEN
        CASE v_existing_status
            WHEN 'completed', 'processed' THEN
                v_was_updated := FALSE;
            WHEN 'failed', 'pending' THEN
                UPDATE ap_activities
                SET
                    activity_data = p_activity_data,
                    status = 'received',
                    to_addresses = p_to_addresses,
                    cc_addresses = p_cc_addresses,
                    bto_addresses = p_bto_addresses,
                    bcc_addresses = p_bcc_addresses,
                    updated_at = NOW(),
                    error_message = NULL,
                    next_attempt_at = NULL,
                    attempts = 0
                WHERE ap_id = p_ap_id;
                v_was_updated := TRUE;
            WHEN 'processing', 'received' THEN
                UPDATE ap_activities
                SET
                    activity_data = p_activity_data,
                    to_addresses = p_to_addresses,
                    cc_addresses = p_cc_addresses,
                    bto_addresses = p_bto_addresses,
                    bcc_addresses = p_bcc_addresses,
                    updated_at = NOW()
                WHERE ap_id = p_ap_id;
                v_was_updated := TRUE;
        END CASE;
    ELSE
        INSERT INTO ap_activities (
            ap_id, ap_type, actor_ap_id, activity_data,
            origin_domain, status, is_local,
            to_addresses, cc_addresses, bto_addresses, bcc_addresses
        ) VALUES (
            p_ap_id, p_ap_type, p_actor_ap_id, p_activity_data,
            p_origin_domain, 'received', p_is_local,
            p_to_addresses, p_cc_addresses, p_bto_addresses, p_bcc_addresses
        )
        RETURNING id INTO v_activity_id;
        v_was_updated := FALSE;
    END IF;

    RETURN QUERY SELECT v_activity_id, v_was_updated;
END;
$$;

COMMENT ON FUNCTION public.upsert_ap_activity IS
'Idempotent insert/update for ActivityPub activities. Returns activity_id and whether it was updated.';

COMMIT;
