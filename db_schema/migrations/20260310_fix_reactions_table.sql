BEGIN;

-- =============================================================================
-- Fix reactions table: may be missing due to FK ordering issue
-- =============================================================================
-- The reactions table in 04_tables_servers.sql references emojis(id), but
-- the emojis table was defined later in 06_tables_misc.sql. This caused the
-- CREATE TABLE to fail on fresh deploys. Fixed by moving emojis before reactions.
-- This migration creates the missing table for existing deployments.
-- =============================================================================

-- Ensure emojis table exists first (it should, but be safe)
CREATE TABLE IF NOT EXISTS public.emojis (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    name character varying,
    url character varying,
    server_id uuid REFERENCES public.servers(id) ON DELETE CASCADE,
    uploader uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    usage_count integer DEFAULT 0,
    last_used timestamp with time zone,
    domain text
);

CREATE INDEX IF NOT EXISTS idx_emojis_server ON public.emojis(server_id);
CREATE INDEX IF NOT EXISTS idx_emojis_name ON public.emojis(lower(name::text));

-- Create reactions table if missing
CREATE TABLE IF NOT EXISTS public.reactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    message_id uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
    user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    bot_id uuid,
    emoji_id uuid REFERENCES public.emojis(id) ON DELETE CASCADE,
    custom_emoji_content text,
    federation_status text DEFAULT 'pending'::text,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT reactions_has_emoji CHECK (emoji_id IS NOT NULL OR custom_emoji_content IS NOT NULL),
    CONSTRAINT reactions_has_author CHECK (user_id IS NOT NULL OR bot_id IS NOT NULL)
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_class WHERE relname = 'reactions' AND relkind = 'r'
        AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
    ) THEN
        RAISE NOTICE 'reactions table was missing and has been created.';
    ELSE
        RAISE NOTICE 'reactions table already exists.';
    END IF;
END $$;

ALTER TABLE public.reactions REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_reactions_message ON public.reactions(message_id);
CREATE INDEX IF NOT EXISTS idx_reactions_user ON public.reactions(user_id);

-- Ensure RLS is enabled with proper policies
ALTER TABLE public.reactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "reactions_select_all" ON public.reactions;
CREATE POLICY "reactions_select_all" ON public.reactions
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "reactions_insert_own" ON public.reactions;
CREATE POLICY "reactions_insert_own" ON public.reactions
    FOR INSERT WITH CHECK (
        user_id = public.get_current_profile_id()
    );

DROP POLICY IF EXISTS "reactions_delete_own" ON public.reactions;
CREATE POLICY "reactions_delete_own" ON public.reactions
    FOR DELETE USING (user_id = public.get_current_profile_id());

-- Ensure realtime is enabled for reactions
DO $$
BEGIN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.reactions;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
