-- =============================================================================
-- FIX MISSING COLUMNS - Run this after using db_schema/init approach
-- =============================================================================
-- This migration fixes column mismatches between init schema and production:
-- 1. Adds missing columns to servers table
-- 2. Adds missing columns to user_servers table
-- 3. Renames is_public to public (to match frontend expectations)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- SERVERS TABLE FIXES
-- ---------------------------------------------------------------------------

-- Rename is_public to public if it exists (frontend expects 'public')
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_schema = 'public' 
               AND table_name = 'servers' 
               AND column_name = 'is_public') THEN
        -- Check if 'public' column doesn't already exist
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                       WHERE table_schema = 'public' 
                       AND table_name = 'servers' 
                       AND column_name = 'public') THEN
            ALTER TABLE public.servers RENAME COLUMN is_public TO public;
            RAISE NOTICE 'Renamed servers.is_public to servers.public';
        ELSE
            -- Both exist - drop is_public
            ALTER TABLE public.servers DROP COLUMN is_public;
            RAISE NOTICE 'Dropped servers.is_public (servers.public already exists)';
        END IF;
    ELSE
        RAISE NOTICE 'servers.is_public does not exist, checking for public column';
    END IF;
END $$;

-- Add public column if it doesn't exist
ALTER TABLE public.servers 
    ADD COLUMN IF NOT EXISTS public boolean DEFAULT false;

-- Add allow_cross_server_emojis column
ALTER TABLE public.servers 
    ADD COLUMN IF NOT EXISTS allow_cross_server_emojis boolean DEFAULT true;

-- Add federation_domain column
ALTER TABLE public.servers 
    ADD COLUMN IF NOT EXISTS federation_domain text;

-- Add federation_inbox_url column
ALTER TABLE public.servers 
    ADD COLUMN IF NOT EXISTS federation_inbox_url text;

-- Add federation_metadata column
ALTER TABLE public.servers 
    ADD COLUMN IF NOT EXISTS federation_metadata jsonb DEFAULT '{}'::jsonb;

-- Add supported_activities column
ALTER TABLE public.servers 
    ADD COLUMN IF NOT EXISTS supported_activities text[] DEFAULT '{}'::text[];

-- Add host_domain column
ALTER TABLE public.servers 
    ADD COLUMN IF NOT EXISTS host_domain text;

-- Add comments for new columns
COMMENT ON COLUMN public.servers.allow_cross_server_emojis IS 'Whether server emojis can be used in other servers';
COMMENT ON COLUMN public.servers.federation_domain IS 'Domain for ActivityPub federation';
COMMENT ON COLUMN public.servers.federation_inbox_url IS 'ActivityPub inbox URL for this server';
COMMENT ON COLUMN public.servers.host_domain IS 'Domain where this server is hosted (null if local)';

-- ---------------------------------------------------------------------------
-- SERVER_FOLDERS TABLE FIXES
-- ---------------------------------------------------------------------------

-- Fix server_folders table: rename "order" to "position" if needed
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_schema = 'public' 
               AND table_name = 'server_folders' 
               AND column_name = 'order') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                       WHERE table_schema = 'public' 
                       AND table_name = 'server_folders' 
                       AND column_name = 'position') THEN
            ALTER TABLE public.server_folders RENAME COLUMN "order" TO "position";
            RAISE NOTICE 'Renamed server_folders."order" to server_folders."position"';
        ELSE
            ALTER TABLE public.server_folders DROP COLUMN "order";
            RAISE NOTICE 'Dropped server_folders."order" (position already exists)';
        END IF;
    END IF;
END $$;

-- Add position column if it doesn't exist
ALTER TABLE public.server_folders 
    ADD COLUMN IF NOT EXISTS "position" integer DEFAULT 0 NOT NULL;

-- Fix server_folders: rename is_collapsed to is_expanded if needed
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_schema = 'public' 
               AND table_name = 'server_folders' 
               AND column_name = 'is_collapsed') THEN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                       WHERE table_schema = 'public' 
                       AND table_name = 'server_folders' 
                       AND column_name = 'is_expanded') THEN
            -- Add is_expanded as inverse of is_collapsed
            ALTER TABLE public.server_folders ADD COLUMN is_expanded boolean DEFAULT true;
            UPDATE public.server_folders SET is_expanded = NOT is_collapsed;
            ALTER TABLE public.server_folders DROP COLUMN is_collapsed;
            RAISE NOTICE 'Converted server_folders.is_collapsed to is_expanded';
        ELSE
            ALTER TABLE public.server_folders DROP COLUMN is_collapsed;
            RAISE NOTICE 'Dropped server_folders.is_collapsed (is_expanded already exists)';
        END IF;
    END IF;
END $$;

-- Add is_expanded column if it doesn't exist
ALTER TABLE public.server_folders 
    ADD COLUMN IF NOT EXISTS is_expanded boolean DEFAULT true;

-- Set default color if not set
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_schema = 'public' 
               AND table_name = 'server_folders' 
               AND column_name = 'color') THEN
        ALTER TABLE public.server_folders ALTER COLUMN color SET DEFAULT '#5865f2'::text;
    END IF;
END $$;

-- Drop unused columns (icon and server_ids are not used in production)
ALTER TABLE public.server_folders DROP COLUMN IF EXISTS icon;
ALTER TABLE public.server_folders DROP COLUMN IF EXISTS server_ids;

-- Update indexes for server_folders
DROP INDEX IF EXISTS idx_server_folders_order;
CREATE INDEX IF NOT EXISTS idx_server_folders_user_position ON public.server_folders(user_id, "position");

-- Add comments
COMMENT ON TABLE public.server_folders IS 'User-created folders for organizing servers in the sidebar';
COMMENT ON COLUMN public.server_folders.color IS 'Hex color code for folder display';
COMMENT ON COLUMN public.server_folders."position" IS 'Sort order position for the folder in the sidebar';

-- ---------------------------------------------------------------------------
-- USER_SERVERS TABLE FIXES
-- ---------------------------------------------------------------------------

-- Add folder_id column for server organization (without FK first, in case server_folders doesn't exist)
ALTER TABLE public.user_servers 
    ADD COLUMN IF NOT EXISTS folder_id uuid;

-- Add position column for ordering
ALTER TABLE public.user_servers 
    ADD COLUMN IF NOT EXISTS position integer DEFAULT 0;

-- Add FK constraint if server_folders table exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.tables 
               WHERE table_schema = 'public' AND table_name = 'server_folders') THEN
        IF NOT EXISTS (
            SELECT 1 FROM information_schema.table_constraints 
            WHERE constraint_name = 'user_servers_folder_id_fkey'
            AND table_name = 'user_servers'
        ) THEN
            ALTER TABLE public.user_servers 
                ADD CONSTRAINT user_servers_folder_id_fkey 
                FOREIGN KEY (folder_id) REFERENCES public.server_folders(id) ON DELETE SET NULL;
            RAISE NOTICE 'Added FK constraint for user_servers.folder_id';
        END IF;
    ELSE
        RAISE NOTICE 'server_folders table does not exist, skipping FK constraint';
    END IF;
END $$;

-- Add indexes for new columns
CREATE INDEX IF NOT EXISTS idx_user_servers_folder_id ON public.user_servers(folder_id);
CREATE INDEX IF NOT EXISTS idx_user_servers_user_position ON public.user_servers(user_id, position);

-- Add indexes for servers federation
CREATE INDEX IF NOT EXISTS idx_servers_federation ON public.servers(federation_enabled, is_local_server);
CREATE INDEX IF NOT EXISTS idx_servers_ap_id ON public.servers(ap_id) WHERE ap_id IS NOT NULL;

-- Add comments
COMMENT ON COLUMN public.user_servers.folder_id IS 'Optional folder this server belongs to (null = root level)';
COMMENT ON COLUMN public.user_servers.position IS 'Sort order position within the folder or at root level';

-- ---------------------------------------------------------------------------
-- FIX RLS POLICY ISSUES
-- ---------------------------------------------------------------------------
-- The init schema has restrictive and self-referencing RLS policies.
-- Replace them with simpler policies that match production.

-- Fix servers policies to match production exactly
-- Note: servers.owner references profiles.id, NOT auth.uid() directly
DROP POLICY IF EXISTS "servers_select_public_or_member" ON public.servers;
DROP POLICY IF EXISTS "servers_insert_authenticated" ON public.servers;
DROP POLICY IF EXISTS "servers_update_owner" ON public.servers;
DROP POLICY IF EXISTS "servers_delete_owner" ON public.servers;

-- Create policies matching production exactly
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'servers' AND policyname = 'Enable read access for all users'
    ) THEN
        CREATE POLICY "Enable read access for all users" ON public.servers 
            FOR SELECT USING (true);
        RAISE NOTICE 'Created read access policy on servers';
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'servers' AND policyname = 'Enable insert for authenticated users only'
    ) THEN
        CREATE POLICY "Enable insert for authenticated users only" ON public.servers 
            FOR INSERT TO authenticated WITH CHECK (true);
        RAISE NOTICE 'Created insert policy on servers';
    END IF;
    
    -- Update policy: owner is profiles.id, so join through profiles to check auth_user_id
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'servers' AND policyname = 'Server owners can update their servers'
    ) THEN
        CREATE POLICY "Server owners can update their servers" ON public.servers 
            FOR UPDATE TO authenticated 
            USING (EXISTS (
                SELECT 1 FROM public.profiles 
                WHERE profiles.id = servers.owner 
                AND profiles.auth_user_id = auth.uid()
            ))
            WITH CHECK (EXISTS (
                SELECT 1 FROM public.profiles 
                WHERE profiles.id = servers.owner 
                AND profiles.auth_user_id = auth.uid()
            ));
        RAISE NOTICE 'Created update policy on servers';
    END IF;
    
    -- Delete policy: same pattern
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'servers' AND policyname = 'Server owners can delete their servers'
    ) THEN
        CREATE POLICY "Server owners can delete their servers" ON public.servers 
            FOR DELETE TO authenticated 
            USING (EXISTS (
                SELECT 1 FROM public.profiles 
                WHERE profiles.id = servers.owner 
                AND profiles.auth_user_id = auth.uid()
            ));
        RAISE NOTICE 'Created delete policy on servers';
    END IF;
END $$;

-- Fix user_servers policies (drop the recursive one and create simple ones)
DROP POLICY IF EXISTS "user_servers_select_member" ON public.user_servers;
DROP POLICY IF EXISTS "user_servers_insert_self_or_owner" ON public.user_servers;
DROP POLICY IF EXISTS "user_servers_update_self_or_owner" ON public.user_servers;
DROP POLICY IF EXISTS "user_servers_delete_self_or_owner" ON public.user_servers;

-- Create simple "allow all authenticated" policies like production
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'user_servers' AND policyname = 'Allow all'
    ) THEN
        CREATE POLICY "Allow all" ON public.user_servers 
            TO authenticated USING (true) WITH CHECK (true);
        RAISE NOTICE 'Created "Allow all" policy on user_servers';
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'user_servers' AND policyname = 'Enable read access for all users'
    ) THEN
        CREATE POLICY "Enable read access for all users" ON public.user_servers 
            FOR SELECT USING (true);
        RAISE NOTICE 'Created read access policy on user_servers';
    END IF;
END $$;

-- Fix conversation_participants policies (drop the recursive one and create simple ones)
DROP POLICY IF EXISTS "conversation_participants_select" ON public.conversation_participants;
DROP POLICY IF EXISTS "conversation_participants_insert" ON public.conversation_participants;

-- Create simple policies like production
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'conversation_participants' AND policyname = 'conversation_participants_select_policy'
    ) THEN
        CREATE POLICY "conversation_participants_select_policy" ON public.conversation_participants 
            FOR SELECT USING (true);
        RAISE NOTICE 'Created select policy on conversation_participants';
    END IF;
    
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies 
        WHERE tablename = 'conversation_participants' AND policyname = 'Authenticated users can manage participants'
    ) THEN
        CREATE POLICY "Authenticated users can manage participants" ON public.conversation_participants 
            FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
        RAISE NOTICE 'Created insert policy on conversation_participants';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- VERIFICATION
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    missing_cols text := '';
BEGIN
    -- Check servers columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' AND table_name = 'servers' AND column_name = 'public') THEN
        missing_cols := missing_cols || 'servers.public, ';
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' AND table_name = 'servers' AND column_name = 'allow_cross_server_emojis') THEN
        missing_cols := missing_cols || 'servers.allow_cross_server_emojis, ';
    END IF;
    
    -- Check user_servers columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' AND table_name = 'user_servers' AND column_name = 'folder_id') THEN
        missing_cols := missing_cols || 'user_servers.folder_id, ';
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' AND table_name = 'user_servers' AND column_name = 'position') THEN
        missing_cols := missing_cols || 'user_servers.position, ';
    END IF;
    
    -- Check server_folders columns
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' AND table_name = 'server_folders' AND column_name = 'position') THEN
        missing_cols := missing_cols || 'server_folders.position, ';
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_schema = 'public' AND table_name = 'server_folders' AND column_name = 'is_expanded') THEN
        missing_cols := missing_cols || 'server_folders.is_expanded, ';
    END IF;
    
    IF missing_cols = '' THEN
        RAISE NOTICE '✅ All required columns exist!';
        RAISE NOTICE 'Migration completed successfully!';
    ELSE
        RAISE WARNING '❌ Missing columns: %', rtrim(missing_cols, ', ');
    END IF;
END $$;

