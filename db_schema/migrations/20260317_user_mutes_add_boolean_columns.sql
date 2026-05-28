BEGIN;

-- The init schema (07_tables_trending.sql) defines user_mutes with boolean columns
-- (hide_notifications, hide_from_timeline), but the production table uses a
-- mute_type text column instead. Functions like send_notification() and
-- get_user_notifications() reference um.hide_notifications, which doesn't exist
-- in production, causing "column um.hide_notifications does not exist" errors.
--
-- This migration adds the missing boolean columns and backfills them from mute_type.

-- Step 1: Add boolean columns if they don't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'user_mutes'
        AND column_name = 'hide_notifications'
    ) THEN
        ALTER TABLE public.user_mutes
            ADD COLUMN hide_notifications boolean DEFAULT true;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'user_mutes'
        AND column_name = 'hide_from_timeline'
    ) THEN
        ALTER TABLE public.user_mutes
            ADD COLUMN hide_from_timeline boolean DEFAULT true;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'user_mutes'
        AND column_name = 'is_federated'
    ) THEN
        ALTER TABLE public.user_mutes
            ADD COLUMN is_federated boolean DEFAULT false;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'user_mutes'
        AND column_name = 'ap_id'
    ) THEN
        ALTER TABLE public.user_mutes ADD COLUMN ap_id text;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'user_mutes'
        AND column_name = 'federation_status'
    ) THEN
        ALTER TABLE public.user_mutes
            ADD COLUMN federation_status text DEFAULT 'pending'::text;
    END IF;
END $$;

-- Step 2: Backfill boolean values from mute_type (if mute_type column exists)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
        AND table_name = 'user_mutes'
        AND column_name = 'mute_type'
    ) THEN
        UPDATE public.user_mutes
        SET hide_notifications = CASE
                WHEN mute_type = 'notifications_only' THEN true
                ELSE false
            END,
            hide_from_timeline = CASE
                WHEN mute_type = 'notifications_only' THEN false
                ELSE true
            END
        WHERE hide_notifications IS NULL
           OR hide_from_timeline IS NULL;
    END IF;
END $$;

-- Step 3: Add the no-self-mute constraint if it doesn't exist
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'user_mutes_no_self_mute'
        AND conrelid = 'public.user_mutes'::regclass
    ) THEN
        ALTER TABLE public.user_mutes
            ADD CONSTRAINT user_mutes_no_self_mute CHECK (muter_id != muted_user_id);
    END IF;
END $$;

COMMIT;
