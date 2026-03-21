-- =============================================================================
-- Migration: Fix user_key_pairs table schema
-- =============================================================================
-- The init schema had old Signal Protocol columns (identity_key, signed_prekey,
-- signed_prekey_signature) but the frontend and RPC functions expect the Megolm
-- columns (identity_public_key, identity_private_key_encrypted, key_version,
-- is_active, etc.). This migration adds the missing columns.
-- =============================================================================

BEGIN;

-- Add new columns if they don't exist
ALTER TABLE public.user_key_pairs ADD COLUMN IF NOT EXISTS identity_public_key text;
ALTER TABLE public.user_key_pairs ADD COLUMN IF NOT EXISTS identity_private_key_encrypted text;
ALTER TABLE public.user_key_pairs ADD COLUMN IF NOT EXISTS key_version integer DEFAULT 1 NOT NULL;
ALTER TABLE public.user_key_pairs ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
ALTER TABLE public.user_key_pairs ADD COLUMN IF NOT EXISTS last_used_at timestamp with time zone DEFAULT now();
ALTER TABLE public.user_key_pairs ADD COLUMN IF NOT EXISTS expires_at timestamp with time zone;
ALTER TABLE public.user_key_pairs ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

-- Migrate data from old columns to new ones (if old columns exist and new ones are empty)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'user_key_pairs' AND column_name = 'identity_key'
    ) THEN
        UPDATE public.user_key_pairs
        SET identity_public_key = identity_key
        WHERE identity_public_key IS NULL AND identity_key IS NOT NULL;
    END IF;
END $$;

-- Make device_id optional with default
ALTER TABLE public.user_key_pairs ALTER COLUMN device_id SET DEFAULT 'default';

-- Add constraint if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.constraint_column_usage
        WHERE table_name = 'user_key_pairs' AND constraint_name = 'valid_device_id'
    ) THEN
        ALTER TABLE public.user_key_pairs ADD CONSTRAINT valid_device_id CHECK (char_length(device_id) <= 255);
    END IF;
EXCEPTION WHEN duplicate_object THEN
    NULL;
END $$;

-- Add index on active keys
CREATE INDEX IF NOT EXISTS idx_user_key_pairs_active ON public.user_key_pairs(user_id, is_active) WHERE is_active = true;

-- Update the initialize_user_encryption function to use new columns
CREATE OR REPLACE FUNCTION public.initialize_user_encryption(
    p_user_id uuid,
    p_identity_public_key text,
    p_identity_private_key_encrypted text,
    p_device_id text DEFAULT 'default'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_key_pair_id UUID;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = p_user_id AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot initialize encryption for another user';
    END IF;
    
    IF EXISTS (SELECT 1 FROM user_key_pairs WHERE user_id = p_user_id AND device_id = p_device_id) THEN
        RAISE EXCEPTION 'Encryption already initialized for this device';
    END IF;
    
    INSERT INTO user_key_pairs (
        user_id, device_id, identity_public_key, identity_private_key_encrypted, key_version, is_active
    ) VALUES (
        p_user_id, p_device_id, p_identity_public_key, p_identity_private_key_encrypted, 1, true
    ) RETURNING id INTO v_key_pair_id;
    
    RETURN jsonb_build_object('success', true, 'key_pair_id', v_key_pair_id, 'device_id', p_device_id);
END;
$$;

-- Update grant for new function signature (drop old, grant new)
DO $$
BEGIN
    -- Revoke from old signature if it exists
    BEGIN
        EXECUTE 'REVOKE EXECUTE ON FUNCTION public.initialize_user_encryption(uuid, text, text, text, text) FROM authenticated';
    EXCEPTION WHEN undefined_function THEN NULL;
    END;
END $$;

GRANT EXECUTE ON FUNCTION public.initialize_user_encryption(uuid, text, text, text) TO authenticated;

-- Fix RLS policy for is_active (now that column exists)
DROP POLICY IF EXISTS "Users can view others' public keys for encryption" ON public.user_key_pairs;
CREATE POLICY "Users can view others' public keys for encryption" ON public.user_key_pairs
    FOR SELECT USING (is_active = true);

NOTIFY pgrst, 'reload schema';

COMMIT;
