BEGIN;

-- Ensure server_settings has all columns from the canonical init schema.
-- Dev databases created before 07_tables_trending.sql was updated may be missing these.

ALTER TABLE public.server_settings ADD COLUMN IF NOT EXISTS auto_mod_enabled boolean DEFAULT false;
ALTER TABLE public.server_settings ADD COLUMN IF NOT EXISTS auto_mod_rules jsonb DEFAULT '{}'::jsonb;
ALTER TABLE public.server_settings ADD COLUMN IF NOT EXISTS default_message_notifications text DEFAULT 'all'::text;
ALTER TABLE public.server_settings ADD COLUMN IF NOT EXISTS explicit_content_filter text DEFAULT 'disabled'::text;
ALTER TABLE public.server_settings ADD COLUMN IF NOT EXISTS verification_gate_enabled boolean DEFAULT false;
ALTER TABLE public.server_settings ADD COLUMN IF NOT EXISTS verification_gate_rules jsonb DEFAULT '{}'::jsonb;
ALTER TABLE public.server_settings ADD COLUMN IF NOT EXISTS afk_channel_id uuid;
ALTER TABLE public.server_settings ADD COLUMN IF NOT EXISTS afk_timeout integer DEFAULT 300;
ALTER TABLE public.server_settings ADD COLUMN IF NOT EXISTS system_channel_id uuid;
ALTER TABLE public.server_settings ADD COLUMN IF NOT EXISTS rules_channel_id uuid;

-- Add constraints if missing (ignore errors if they already exist)
DO $$
BEGIN
    ALTER TABLE public.server_settings
        ADD CONSTRAINT server_settings_notifications_check
        CHECK (default_message_notifications IN ('all', 'mentions', 'none'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE public.server_settings
        ADD CONSTRAINT server_settings_filter_check
        CHECK (explicit_content_filter IN ('disabled', 'members_without_roles', 'all_members'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Backfill: create a server_settings row for every server that doesn't have one
INSERT INTO public.server_settings (server_id)
SELECT s.id FROM public.servers s
WHERE NOT EXISTS (
    SELECT 1 FROM public.server_settings ss WHERE ss.server_id = s.id
);

-- Set system_channel_id to the default channel for rows where it is NULL
UPDATE public.server_settings
SET system_channel_id = public.get_default_channel(server_id)
WHERE system_channel_id IS NULL;

-- Drop dead overlapping columns from servers table (never read by frontend)
ALTER TABLE public.servers DROP COLUMN IF EXISTS verification_level;
ALTER TABLE public.servers DROP COLUMN IF EXISTS default_notification_level;

NOTIFY pgrst, 'reload schema';

COMMIT;
