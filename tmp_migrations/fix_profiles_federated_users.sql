-- Fix profiles table to support federated users without auth.users dependency
-- This allows us to store remote ActivityPub actors without requiring them to have local auth accounts

-- First, check the current constraint
SELECT conname, contype FROM pg_constraint WHERE conrelid = 'profiles'::regclass AND contype = 'f';

-- Option 1: Make the foreign key constraint nullable (recommended approach)
-- This allows local users to have auth.users references, but federated users can have independent IDs

-- Drop the existing foreign key constraint
ALTER TABLE profiles DROP CONSTRAINT IF EXISTS profiles_id_fkey;

-- Add a new column for auth user ID (if it doesn't exist)
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS auth_user_id UUID;

-- Create a new foreign key constraint on the auth_user_id column instead
ALTER TABLE profiles ADD CONSTRAINT profiles_auth_user_id_fkey 
    FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;

-- For existing local users, copy id to auth_user_id
UPDATE profiles SET auth_user_id = id WHERE is_local = true AND auth_user_id IS NULL;

-- Note: We keep the existing IDs for local users to avoid breaking foreign key relationships
-- New local users created after this migration will get separate profile IDs and auth_user_ids
-- Federated users will only have profile IDs (no auth_user_id)

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_profiles_auth_user_id ON profiles(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_profiles_federated_id ON profiles(federated_id);

-- Update RLS policies if needed
-- Allow reading federated profiles
DROP POLICY IF EXISTS "Users can view all profiles" ON profiles;
CREATE POLICY "Users can view all profiles" ON profiles
    FOR SELECT USING (true);

-- Allow system to create federated profiles
DROP POLICY IF EXISTS "System can manage federated profiles" ON profiles;
CREATE POLICY "System can manage federated profiles" ON profiles
    FOR ALL USING (
        -- Allow all operations on federated profiles (is_local = false)
        is_local = false OR
        -- Allow local users to manage their own profiles
        auth_user_id = auth.uid()
    );

-- Create a function to create federated profiles
CREATE OR REPLACE FUNCTION create_federated_profile(
    p_username TEXT,
    p_display_name TEXT DEFAULT NULL,
    p_domain TEXT DEFAULT NULL,
    p_avatar_url TEXT DEFAULT NULL,
    p_bio TEXT DEFAULT NULL,
    p_federated_id TEXT DEFAULT NULL,
    p_inbox_url TEXT DEFAULT NULL,
    p_outbox_url TEXT DEFAULT NULL,
    p_followers_url TEXT DEFAULT NULL,
    p_following_url TEXT DEFAULT NULL,
    p_public_key TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    new_profile_id UUID;
BEGIN
    -- Generate a new UUID for the federated profile
    new_profile_id := gen_random_uuid();
    
    -- Insert the federated profile
    INSERT INTO profiles (
        id,
        username,
        display_name,
        domain,
        avatar_url,
        bio,
        federated_id,
        inbox_url,
        outbox_url,
        followers_url,
        following_url,
        public_key,
        is_local,
        auth_user_id,
        last_synced_at
    ) VALUES (
        new_profile_id,
        p_username,
        COALESCE(p_display_name, p_username),
        COALESCE(p_domain, 'unknown'),
        p_avatar_url,
        p_bio,
        p_federated_id,
        p_inbox_url,
        p_outbox_url,
        p_followers_url,
        p_following_url,
        p_public_key,
        false, -- is_local = false for federated profiles
        NULL,  -- auth_user_id = NULL for federated profiles
        NOW()
    );
    
    RETURN new_profile_id;
END;
$$;

-- Grant execute permission to service role
GRANT EXECUTE ON FUNCTION create_federated_profile TO service_role;

COMMENT ON FUNCTION create_federated_profile IS 'Creates a federated ActivityPub profile without requiring auth.users entry';
