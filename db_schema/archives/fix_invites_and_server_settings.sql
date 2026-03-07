-- Migration: Fix invites and server_settings table schemas
-- This migration adds missing columns expected by the frontend

-- =============================================
-- 1. FIX INVITES TABLE
-- =============================================
-- Add 'used' column (boolean) - indicates if single-use invite was used
ALTER TABLE public.invites ADD COLUMN IF NOT EXISTS used boolean DEFAULT false;

-- Add 'uses' column (integer) - tracks number of times invite was used
ALTER TABLE public.invites ADD COLUMN IF NOT EXISTS uses integer DEFAULT 0;

-- Add 'temporary' column (boolean) - for temporary invites
ALTER TABLE public.invites ADD COLUMN IF NOT EXISTS temporary boolean DEFAULT false;

-- Migrate data from old columns if they exist
DO $$
BEGIN
    -- If use_count exists, copy to uses
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_schema = 'public' 
               AND table_name = 'invites' 
               AND column_name = 'use_count') THEN
        UPDATE public.invites SET uses = COALESCE(use_count, 0) WHERE uses = 0;
    END IF;
    
    -- If is_active exists and is false, mark as used
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_schema = 'public' 
               AND table_name = 'invites' 
               AND column_name = 'is_active') THEN
        UPDATE public.invites SET used = true WHERE is_active = false AND used = false;
    END IF;
END $$;

-- =============================================
-- 2. FIX SERVER_SETTINGS TABLE
-- =============================================
-- Add 'default_role_id' column
ALTER TABLE public.server_settings ADD COLUMN IF NOT EXISTS default_role_id uuid REFERENCES public.server_roles(id) ON DELETE SET NULL;

-- Add 'invite_permissions' column (jsonb)
ALTER TABLE public.server_settings ADD COLUMN IF NOT EXISTS invite_permissions jsonb 
    DEFAULT '{"who_can_create": "everyone", "default_expiration": 1440, "max_expiration": 0, "allow_temporary": true, "max_uses_limit": 0}'::jsonb;

-- Add 'moderation_settings' column (jsonb)
ALTER TABLE public.server_settings ADD COLUMN IF NOT EXISTS moderation_settings jsonb 
    DEFAULT '{"auto_mod_enabled": false, "spam_filter": false, "link_filter": false}'::jsonb;

-- Migrate auto_mod_enabled to moderation_settings if it exists
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns 
               WHERE table_schema = 'public' 
               AND table_name = 'server_settings' 
               AND column_name = 'auto_mod_enabled') THEN
        UPDATE public.server_settings 
        SET moderation_settings = jsonb_set(
            COALESCE(moderation_settings, '{}'::jsonb),
            '{auto_mod_enabled}',
            to_jsonb(COALESCE(auto_mod_enabled, false))
        )
        WHERE auto_mod_enabled IS NOT NULL;
    END IF;
END $$;

-- =============================================
-- 3. ENSURE RLS POLICIES EXIST FOR INVITES
-- =============================================
-- Drop and recreate policies to ensure they're correct
DROP POLICY IF EXISTS "invites_select_all" ON public.invites;
DROP POLICY IF EXISTS "Enable read access for all users" ON public.invites;
DROP POLICY IF EXISTS "Authenticated users can create invites" ON public.invites;
DROP POLICY IF EXISTS "FIXME: Enable insert for authenticated users only" ON public.invites;
DROP POLICY IF EXISTS "Invite creators can delete" ON public.invites;
DROP POLICY IF EXISTS "FIXME: update" ON public.invites;
DROP POLICY IF EXISTS "Invite creators can update" ON public.invites;

-- Enable RLS
ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;

-- Anyone can view invites (needed for invite link validation)
CREATE POLICY "Enable read access for all users" ON public.invites 
    FOR SELECT USING (true);

-- Authenticated users can create invites
CREATE POLICY "Authenticated users can create invites" ON public.invites 
    FOR INSERT TO authenticated WITH CHECK (true);

-- Invite creators can update their own invites
CREATE POLICY "Invite creators can update" ON public.invites 
    FOR UPDATE TO authenticated USING (created_by = auth.uid()) WITH CHECK (created_by = auth.uid());

-- Invite creators can delete their own invites
CREATE POLICY "Invite creators can delete" ON public.invites 
    FOR DELETE TO authenticated USING (created_by = auth.uid());

-- =============================================
-- 4. GRANT PERMISSIONS
-- =============================================
GRANT SELECT ON public.invites TO authenticated;
GRANT INSERT ON public.invites TO authenticated;
GRANT UPDATE ON public.invites TO authenticated;
GRANT DELETE ON public.invites TO authenticated;
GRANT ALL ON public.invites TO service_role;

GRANT SELECT ON public.server_settings TO authenticated;
GRANT INSERT ON public.server_settings TO authenticated;
GRANT UPDATE ON public.server_settings TO authenticated;
GRANT DELETE ON public.server_settings TO authenticated;
GRANT ALL ON public.server_settings TO service_role;

