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
    
    IF missing_cols = '' THEN
        RAISE NOTICE '✅ All required columns exist!';
        RAISE NOTICE 'Migration completed successfully!';
    ELSE
        RAISE WARNING '❌ Missing columns: %', rtrim(missing_cols, ', ');
    END IF;
END $$;

