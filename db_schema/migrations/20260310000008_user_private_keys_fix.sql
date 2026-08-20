BEGIN;

-- =============================================================================
-- Fix user_private_keys table: rename encrypted_private_key → private_key
-- =============================================================================
-- The init schema had encrypted_private_key (with salt/iterations for client-side
-- encryption), but the federation backend uses a simple private_key column.
-- =============================================================================

DO $$
BEGIN
    -- Only migrate if the old column exists and the new one doesn't
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'user_private_keys'
        AND column_name = 'encrypted_private_key'
    ) AND NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'user_private_keys'
        AND column_name = 'private_key'
    ) THEN
        RAISE NOTICE 'Migrating user_private_keys: encrypted_private_key → private_key';

        ALTER TABLE public.user_private_keys RENAME COLUMN encrypted_private_key TO private_key;
        ALTER TABLE public.user_private_keys DROP COLUMN IF EXISTS salt;
        ALTER TABLE public.user_private_keys DROP COLUMN IF EXISTS iterations;

        RAISE NOTICE 'user_private_keys migration complete.';
    ELSE
        RAISE NOTICE 'user_private_keys already has correct schema, skipping.';
    END IF;
END $$;

-- Fix RLS policy: federation backend uses service_role, not user's own profile
DROP POLICY IF EXISTS "user_private_keys_own_only" ON public.user_private_keys;
DROP POLICY IF EXISTS "Service role only access" ON public.user_private_keys;
CREATE POLICY "Service role only access" ON public.user_private_keys
    USING (auth.role() = 'service_role');

COMMIT;
