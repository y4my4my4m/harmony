BEGIN;

-- =============================================================================
-- Fix emojis RLS: add INSERT/UPDATE/DELETE for server owners
-- =============================================================================

DROP POLICY IF EXISTS "emojis_select_all" ON public.emojis;
CREATE POLICY "emojis_select_all" ON public.emojis FOR SELECT USING (true);

DROP POLICY IF EXISTS "emojis_insert_server_owner" ON public.emojis;
CREATE POLICY "emojis_insert_server_owner" ON public.emojis
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.servers
            WHERE id = emojis.server_id
            AND owner = public.get_current_profile_id()
        )
    );

DROP POLICY IF EXISTS "emojis_update_server_owner" ON public.emojis;
CREATE POLICY "emojis_update_server_owner" ON public.emojis
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM public.servers
            WHERE id = emojis.server_id
            AND owner = public.get_current_profile_id()
        )
    );

DROP POLICY IF EXISTS "emojis_delete_server_owner" ON public.emojis;
CREATE POLICY "emojis_delete_server_owner" ON public.emojis
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM public.servers
            WHERE id = emojis.server_id
            AND owner = public.get_current_profile_id()
        )
    );

-- =============================================================================
-- Fix bots table: add missing columns from production schema
-- =============================================================================
-- The init schema had a minimal bots table. Production has additional columns
-- that the frontend and bot-gateway expect.
-- =============================================================================

DO $$
BEGIN
    -- Rename 'name' to 'username' if old schema
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bots' AND column_name = 'name'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bots' AND column_name = 'username'
    ) THEN
        ALTER TABLE public.bots RENAME COLUMN name TO username;
        RAISE NOTICE 'Renamed bots.name → bots.username';
    END IF;

    -- Rename 'description' to 'bio' if old schema
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bots' AND column_name = 'description'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'bots' AND column_name = 'bio'
    ) THEN
        ALTER TABLE public.bots RENAME COLUMN description TO bio;
        RAISE NOTICE 'Renamed bots.description → bots.bio';
    END IF;
END $$;

-- Add missing columns (idempotent)
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS discriminator text DEFAULT '0000'::text;
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS display_name text;
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS banner_url text;
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS bot_type text DEFAULT 'bot'::text;
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS website_url text;
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS support_server_id uuid;
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS user_count integer DEFAULT 0;
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS command_count bigint DEFAULT 0;
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS last_online_at timestamp with time zone;
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS settings jsonb DEFAULT '{}'::jsonb;

ALTER TABLE public.bots ALTER COLUMN avatar_url SET DEFAULT '/default_avatar.webp';

COMMIT;
