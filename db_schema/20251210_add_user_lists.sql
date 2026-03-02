-- =============================================================================
-- Migration: Add User Lists (Mastodon-compatible Lists feature)
-- Created: 2025-12-10
-- =============================================================================
-- This migration adds support for user-defined lists for organizing followed 
-- accounts, similar to Mastodon's Lists feature.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- USER LISTS TABLE
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_lists (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    
    -- Owner of the list
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- List metadata
    title text NOT NULL,
    description text,
    
    -- Visibility controls
    -- 'followed': Only show replies to other list members
    -- 'list': Only show replies to list members  
    -- 'none': Hide all replies
    replies_policy text DEFAULT 'list'::text,
    
    -- Whether the list is exclusive (members removed from home timeline)
    is_exclusive boolean DEFAULT false,
    
    -- Whether the list can be viewed by others
    is_public boolean DEFAULT false,
    
    -- ActivityPub federation
    federated_id text,
    ap_id text,
    is_local boolean DEFAULT true,
    
    CONSTRAINT user_lists_replies_policy_check 
        CHECK (replies_policy IN ('followed', 'list', 'none'))
);

ALTER TABLE public.user_lists REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_user_lists_user_id ON public.user_lists(user_id);
CREATE INDEX IF NOT EXISTS idx_user_lists_created_at ON public.user_lists(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS user_lists_federated_id_key 
    ON public.user_lists(federated_id) WHERE federated_id IS NOT NULL;

COMMENT ON TABLE public.user_lists IS 'User-created lists for organizing followed accounts (Mastodon-compatible)';
COMMENT ON COLUMN public.user_lists.replies_policy IS 'Controls which replies are shown: followed, list, or none';
COMMENT ON COLUMN public.user_lists.is_exclusive IS 'When true, list members are hidden from home timeline';

-- ---------------------------------------------------------------------------
-- USER LIST MEMBERS TABLE
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.user_list_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    
    -- The list this membership belongs to
    list_id uuid NOT NULL REFERENCES public.user_lists(id) ON DELETE CASCADE,
    
    -- The user being added to the list (must be followed by list owner)
    account_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    
    -- Unique constraint: a user can only be in a list once
    CONSTRAINT user_list_members_unique UNIQUE (list_id, account_id)
);

ALTER TABLE public.user_list_members REPLICA IDENTITY FULL;

CREATE INDEX IF NOT EXISTS idx_user_list_members_list_id ON public.user_list_members(list_id);
CREATE INDEX IF NOT EXISTS idx_user_list_members_account_id ON public.user_list_members(account_id);

COMMENT ON TABLE public.user_list_members IS 'Membership junction table for user lists';

-- ---------------------------------------------------------------------------
-- RLS POLICIES FOR USER LISTS
-- Note: Using DROP IF EXISTS to handle cases where policies already exist
-- (e.g., when migration runs after init scripts or on re-run)
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_lists ENABLE ROW LEVEL SECURITY;

-- Users can view their own lists
DROP POLICY IF EXISTS "user_lists_own_select" ON public.user_lists;
CREATE POLICY "user_lists_own_select" ON public.user_lists
    FOR SELECT USING (user_id = public.get_current_profile_id());

-- Users can view public lists from others
DROP POLICY IF EXISTS "user_lists_public_select" ON public.user_lists;
CREATE POLICY "user_lists_public_select" ON public.user_lists
    FOR SELECT USING (is_public = true);

-- Users can only create their own lists
DROP POLICY IF EXISTS "user_lists_insert" ON public.user_lists;
CREATE POLICY "user_lists_insert" ON public.user_lists
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id());

-- Users can only update their own lists
DROP POLICY IF EXISTS "user_lists_update" ON public.user_lists;
CREATE POLICY "user_lists_update" ON public.user_lists
    FOR UPDATE USING (user_id = public.get_current_profile_id())
    WITH CHECK (user_id = public.get_current_profile_id());

-- Users can only delete their own lists
DROP POLICY IF EXISTS "user_lists_delete" ON public.user_lists;
CREATE POLICY "user_lists_delete" ON public.user_lists
    FOR DELETE USING (user_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- RLS POLICIES FOR USER LIST MEMBERS
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_list_members ENABLE ROW LEVEL SECURITY;

-- Users can view members of their own lists
DROP POLICY IF EXISTS "user_list_members_own_list" ON public.user_list_members;
CREATE POLICY "user_list_members_own_list" ON public.user_list_members
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.user_lists ul
            WHERE ul.id = user_list_members.list_id
            AND ul.user_id = public.get_current_profile_id()
        )
    );

-- Users can view members of public lists
DROP POLICY IF EXISTS "user_list_members_public_list" ON public.user_list_members;
CREATE POLICY "user_list_members_public_list" ON public.user_list_members
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.user_lists ul
            WHERE ul.id = user_list_members.list_id
            AND ul.is_public = true
        )
    );

-- Users can add members to their own lists
DROP POLICY IF EXISTS "user_list_members_insert" ON public.user_list_members;
CREATE POLICY "user_list_members_insert" ON public.user_list_members
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.user_lists ul
            WHERE ul.id = user_list_members.list_id
            AND ul.user_id = public.get_current_profile_id()
        )
    );

-- Users can remove members from their own lists
DROP POLICY IF EXISTS "user_list_members_delete" ON public.user_list_members;
CREATE POLICY "user_list_members_delete" ON public.user_list_members
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM public.user_lists ul
            WHERE ul.id = user_list_members.list_id
            AND ul.user_id = public.get_current_profile_id()
        )
    );

-- ---------------------------------------------------------------------------
-- GRANT PERMISSIONS TO AUTHENTICATED ROLE
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_lists TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.user_list_members TO authenticated;

-- ---------------------------------------------------------------------------
-- ADD TO REALTIME PUBLICATION
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    -- Add user_lists to realtime publication if not already present
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' 
        AND schemaname = 'public' 
        AND tablename = 'user_lists'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.user_lists;
    END IF;
    
    -- Add user_list_members to realtime publication if not already present
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables 
        WHERE pubname = 'supabase_realtime' 
        AND schemaname = 'public' 
        AND tablename = 'user_list_members'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE public.user_list_members;
    END IF;
    
    RAISE NOTICE 'User lists tables and policies created successfully';
END $$;
