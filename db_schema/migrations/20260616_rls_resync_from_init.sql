-- ---------------------------------------------------------------------------
-- RLS RESYNC FROM INIT (drift-proof recovery)
--
-- The 20260616 RLS "consolidate/optimize/tighten" batch dropped legacy,
-- descriptively-named policies assuming their canonical snake_case twins (the
-- ones db_schema/init ships) already existed. On drifted DBs they did NOT, so
-- core tables (channels, server_folders, ...) were left with NO usable policy:
-- empty channel lists, server_folders with RLS on + 0 policies, etc.
--
-- This re-asserts EVERY canonical RLS policy from
-- db_schema/init/30_rls_policies.sql + 31_rls_policies_extended.sql.
--
-- DRIFT-PROOF & IDEMPOTENT:
--   * Each ENABLE-RLS, each standalone DROP, and each CREATE POLICY runs in its
--     own block that catches undefined_table / undefined_column /
--     undefined_object / undefined_function and RAISEs a NOTICE instead of
--     aborting. A table present on one env but not another (e.g.
--     public.oauth_providers) is skipped; everything else still applies.
--   * Every CREATE POLICY is preceded by a DROP POLICY IF EXISTS so re-running
--     never hits 42710 "already exists".
--   * Standalone init DROPs are preserved (the conditional DO blocks for
--     prekeys / federated_voice_calls / server_federation_events depend on them).
--   * No wrapping transaction, so partial drift never rolls back what applied.
--
-- GENERATED from init - do not hand-edit; regenerate from the init files.
-- ---------------------------------------------------------------------------


-- ===== from db_schema/init/30_rls_policies.sql =====
-- =============================================================================
-- Harmony Database Schema - Row Level Security Policies
-- =============================================================================
-- RLS ensures users can only access their own data
-- =============================================================================

-- Helper function to get current user's profile ID
CREATE OR REPLACE FUNCTION public.get_current_profile_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT id FROM public.profiles WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

-- ---------------------------------------------------------------------------
-- PROFILES RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.profiles: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "profiles_select_all" ON public.profiles$ddl$;
  EXECUTE $ddl$CREATE POLICY "profiles_select_all" ON public.profiles
    FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"profiles_select_all" ON public.profiles', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "profiles_insert_own" ON public.profiles$ddl$;
  EXECUTE $ddl$CREATE POLICY "profiles_insert_own" ON public.profiles
    FOR INSERT WITH CHECK (auth_user_id = auth.uid())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"profiles_insert_own" ON public.profiles', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "profiles_update_own" ON public.profiles$ddl$;
  EXECUTE $ddl$CREATE POLICY "profiles_update_own" ON public.profiles
    FOR UPDATE USING (auth_user_id = auth.uid())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"profiles_update_own" ON public.profiles', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "profiles_delete_own" ON public.profiles$ddl$;
  EXECUTE $ddl$CREATE POLICY "profiles_delete_own" ON public.profiles
    FOR DELETE USING (auth_user_id = auth.uid())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"profiles_delete_own" ON public.profiles', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- POSTS RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.posts: %', SQLERRM;
END $rls$;

-- Public posts are visible to everyone, followers-only to followers
-- Also prevents blocked users from seeing posts from users who blocked them
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "posts_select_public" ON public.posts$ddl$;
  EXECUTE $ddl$CREATE POLICY "posts_select_public" ON public.posts
    FOR SELECT USING (
        -- Author can always see their own posts
        author_id = public.get_current_profile_id()
        OR (
            -- Not blocked by the author AND not blocked by you
            NOT public.is_blocked_by(author_id)
            AND NOT public.has_blocked(author_id)
            AND (
                -- Public/unlisted posts
                visibility IN ('public', 'unlisted')
                -- Followers-only if user follows author
                OR (visibility = 'followers' AND EXISTS (
                    SELECT 1 FROM public.follows 
                    WHERE follower_id = public.get_current_profile_id() 
                    AND following_id = posts.author_id 
                    AND status = 'accepted'
                ))
                -- Direct messages (simplified check)
                OR (visibility = 'direct' AND EXISTS (
                    SELECT 1 WHERE author_id = public.get_current_profile_id()
                ))
            )
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"posts_select_public" ON public.posts', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "posts_insert_own" ON public.posts$ddl$;
  EXECUTE $ddl$CREATE POLICY "posts_insert_own" ON public.posts
    FOR INSERT WITH CHECK (author_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"posts_insert_own" ON public.posts', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "posts_update_own" ON public.posts$ddl$;
  EXECUTE $ddl$CREATE POLICY "posts_update_own" ON public.posts
    FOR UPDATE USING (author_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"posts_update_own" ON public.posts', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "posts_delete_own" ON public.posts$ddl$;
  EXECUTE $ddl$CREATE POLICY "posts_delete_own" ON public.posts
    FOR DELETE USING (author_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"posts_delete_own" ON public.posts', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- FOLLOWS RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.follows: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "follows_select_all" ON public.follows$ddl$;
  EXECUTE $ddl$CREATE POLICY "follows_select_all" ON public.follows
    FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"follows_select_all" ON public.follows', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "follows_insert_own" ON public.follows$ddl$;
  EXECUTE $ddl$CREATE POLICY "follows_insert_own" ON public.follows
    FOR INSERT WITH CHECK (follower_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"follows_insert_own" ON public.follows', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "follows_update_involved" ON public.follows$ddl$;
  EXECUTE $ddl$CREATE POLICY "follows_update_involved" ON public.follows
    FOR UPDATE USING (
        follower_id = public.get_current_profile_id()
        OR following_id = public.get_current_profile_id()
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"follows_update_involved" ON public.follows', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "follows_delete_own" ON public.follows$ddl$;
  EXECUTE $ddl$CREATE POLICY "follows_delete_own" ON public.follows
    FOR DELETE USING (follower_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"follows_delete_own" ON public.follows', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- POST INTERACTIONS RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.post_interactions ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.post_interactions: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "post_interactions_select_all" ON public.post_interactions$ddl$;
  EXECUTE $ddl$CREATE POLICY "post_interactions_select_all" ON public.post_interactions
    FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"post_interactions_select_all" ON public.post_interactions', SQLERRM;
END $rls$;

-- Prevent reactions on posts from users who blocked you
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "post_interactions_insert_own" ON public.post_interactions$ddl$;
  EXECUTE $ddl$CREATE POLICY "post_interactions_insert_own" ON public.post_interactions
    FOR INSERT WITH CHECK (
        user_id = public.get_current_profile_id()
        AND NOT public.is_blocked_by((SELECT author_id FROM public.posts WHERE id = post_interactions.post_id))
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"post_interactions_insert_own" ON public.post_interactions', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "post_interactions_delete_own" ON public.post_interactions$ddl$;
  EXECUTE $ddl$CREATE POLICY "post_interactions_delete_own" ON public.post_interactions
    FOR DELETE USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"post_interactions_delete_own" ON public.post_interactions', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- SERVERS RLS
-- ---------------------------------------------------------------------------
-- Note: servers.owner references profiles.id, not auth.uid() directly.
-- Update/delete policies must join through profiles to verify ownership.
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.servers ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.servers: %', SQLERRM;
END $rls$;

-- Allow all users to read servers (visibility is handled at app level)
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Enable read access for all users" ON public.servers$ddl$;
  EXECUTE $ddl$CREATE POLICY "Enable read access for all users" ON public.servers
    FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Enable read access for all users" ON public.servers', SQLERRM;
END $rls$;

-- Allow authenticated users to create servers they own (mirrors the update
-- policy's ownership check; servers.owner FK -> profiles.id).
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Enable insert for authenticated users only" ON public.servers$ddl$;
  EXECUTE $ddl$CREATE POLICY "Enable insert for authenticated users only" ON public.servers
    FOR INSERT TO authenticated
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = servers.owner
              AND profiles.auth_user_id = (select auth.uid())
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Enable insert for authenticated users only" ON public.servers', SQLERRM;
END $rls$;

-- Allow server owners to update their servers (join through profiles)
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Server owners can update their servers" ON public.servers$ddl$;
  EXECUTE $ddl$CREATE POLICY "Server owners can update their servers" ON public.servers
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
    ))$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Server owners can update their servers" ON public.servers', SQLERRM;
END $rls$;

-- Allow server owners to delete their servers
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Server owners can delete their servers" ON public.servers$ddl$;
  EXECUTE $ddl$CREATE POLICY "Server owners can delete their servers" ON public.servers
    FOR DELETE TO authenticated 
    USING (EXISTS (
        SELECT 1 FROM public.profiles 
        WHERE profiles.id = servers.owner 
        AND profiles.auth_user_id = auth.uid()
    ))$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Server owners can delete their servers" ON public.servers', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- CHANNEL CATEGORIES RLS
-- ---------------------------------------------------------------------------
-- Note: 98_enable_rls.sql already enables RLS on this table.
-- Categories are not sensitive - allow all authenticated users to read.

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "channel_categories_select" ON public.channel_categories$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "channel_categories_select" ON public.channel_categories$ddl$;
  EXECUTE $ddl$CREATE POLICY "channel_categories_select" ON public.channel_categories
    FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"channel_categories_select" ON public.channel_categories', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "channel_categories_insert" ON public.channel_categories$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "channel_categories_insert" ON public.channel_categories$ddl$;
  EXECUTE $ddl$CREATE POLICY "channel_categories_insert" ON public.channel_categories
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.servers
            WHERE id = channel_categories.server_id
            AND owner = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"channel_categories_insert" ON public.channel_categories', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "channel_categories_update" ON public.channel_categories$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "channel_categories_update" ON public.channel_categories$ddl$;
  EXECUTE $ddl$CREATE POLICY "channel_categories_update" ON public.channel_categories
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM public.user_servers us
            WHERE us.server_id = channel_categories.server_id
            AND us.user_id = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"channel_categories_update" ON public.channel_categories', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "channel_categories_delete" ON public.channel_categories$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "channel_categories_delete" ON public.channel_categories$ddl$;
  EXECUTE $ddl$CREATE POLICY "channel_categories_delete" ON public.channel_categories
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM public.servers
            WHERE id = channel_categories.server_id
            AND owner = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"channel_categories_delete" ON public.channel_categories', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- CHANNELS RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.channels: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "channels_select_member" ON public.channels$ddl$;
  EXECUTE $ddl$CREATE POLICY "channels_select_member" ON public.channels
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.user_servers us
            JOIN public.servers s ON s.id = us.server_id
            WHERE us.server_id = channels.server_id
            AND (us.user_id = public.get_current_profile_id() OR s.owner = public.get_current_profile_id())
            AND us.status = 'accepted'
        )
        OR EXISTS (
            SELECT 1 FROM public.servers 
            WHERE id = channels.server_id 
            AND owner = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"channels_select_member" ON public.channels', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "channels_insert_owner" ON public.channels$ddl$;
  EXECUTE $ddl$CREATE POLICY "channels_insert_owner" ON public.channels
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.servers 
            WHERE id = channels.server_id 
            AND owner = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"channels_insert_owner" ON public.channels', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "channels_update_owner" ON public.channels$ddl$;
  EXECUTE $ddl$CREATE POLICY "channels_update_owner" ON public.channels
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM public.servers 
            WHERE id = channels.server_id 
            AND owner = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"channels_update_owner" ON public.channels', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "channels_delete_owner" ON public.channels$ddl$;
  EXECUTE $ddl$CREATE POLICY "channels_delete_owner" ON public.channels
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM public.servers 
            WHERE id = channels.server_id 
            AND owner = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"channels_delete_owner" ON public.channels', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- MESSAGES RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.messages: %', SQLERRM;
END $rls$;

-- Channel messages: members can see
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "messages_select_channel_member" ON public.messages$ddl$;
  EXECUTE $ddl$CREATE POLICY "messages_select_channel_member" ON public.messages
    FOR SELECT USING (
        -- Channel messages
        (channel_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.channels c
            JOIN public.user_servers us ON us.server_id = c.server_id
            WHERE c.id = messages.channel_id
            AND us.user_id = public.get_current_profile_id()
            AND us.status = 'accepted'
        ))
        OR
        -- DM messages
        (conversation_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.conversation_participants cp
            WHERE cp.conversation_id = messages.conversation_id
            AND cp.user_id = public.get_current_profile_id()
            AND cp.left_at IS NULL
        ))
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"messages_select_channel_member" ON public.messages', SQLERRM;
END $rls$;

-- Prevent blocked users from sending DMs to users who blocked them
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "messages_insert_member" ON public.messages$ddl$;
  EXECUTE $ddl$CREATE POLICY "messages_insert_member" ON public.messages
    FOR INSERT WITH CHECK (
        user_id = public.get_current_profile_id()
        AND (
            -- Channel messages: always allowed (server-level moderation handles this)
            (channel_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.channels c
                JOIN public.user_servers us ON us.server_id = c.server_id
                WHERE c.id = messages.channel_id
                AND us.user_id = public.get_current_profile_id()
                AND us.status = 'accepted'
            ))
            OR
            -- DM messages: check if any participant has blocked us
            (conversation_id IS NOT NULL AND EXISTS (
                SELECT 1 FROM public.conversation_participants cp
                WHERE cp.conversation_id = messages.conversation_id
                AND cp.user_id = public.get_current_profile_id()
                AND cp.left_at IS NULL
            ) AND NOT EXISTS (
                -- Prevent sending if any other participant has blocked us
                SELECT 1 FROM public.conversation_participants cp
                WHERE cp.conversation_id = messages.conversation_id
                AND cp.user_id != public.get_current_profile_id()
                AND cp.left_at IS NULL
                AND public.is_blocked_by(cp.user_id)
            ))
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"messages_insert_member" ON public.messages', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "messages_update_authorized" ON public.messages$ddl$;
  EXECUTE $ddl$CREATE POLICY "messages_update_authorized" ON public.messages
    FOR UPDATE USING (
        user_id = public.get_current_profile_id()
        OR public.is_current_user_admin()
        OR public.is_current_user_moderator()
        OR public.can_current_user_manage_messages_in_channel(channel_id)
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"messages_update_authorized" ON public.messages', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "messages_delete_authorized" ON public.messages$ddl$;
  EXECUTE $ddl$CREATE POLICY "messages_delete_authorized" ON public.messages
    FOR DELETE USING (
        user_id = public.get_current_profile_id()
        OR public.is_current_user_admin()
        OR public.is_current_user_moderator()
        OR public.can_current_user_manage_messages_in_channel(channel_id)
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"messages_delete_authorized" ON public.messages', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- USER SERVERS RLS
-- ---------------------------------------------------------------------------
-- Note: Using simple policies to avoid infinite recursion issues.
-- Complex membership checks should be done in application logic.
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.user_servers ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.user_servers: %', SQLERRM;
END $rls$;

-- Users can see memberships for servers they belong to (co-members),
-- their own memberships, or all memberships if admin.
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_servers_select_co_members" ON public.user_servers$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_servers_select_co_members" ON public.user_servers
    FOR SELECT TO authenticated
    USING (
        user_id = public.get_current_profile_id()
        OR public.current_user_is_member_of_server(server_id)
        OR public.is_current_user_admin()
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_servers_select_co_members" ON public.user_servers', SQLERRM;
END $rls$;

-- Users can join servers (insert themselves)
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_servers_insert_self" ON public.user_servers$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_servers_insert_self" ON public.user_servers
    FOR INSERT TO authenticated
    WITH CHECK (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_servers_insert_self" ON public.user_servers', SQLERRM;
END $rls$;

-- Users can update their own membership, server owners can update any member
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_servers_update_own_or_owner" ON public.user_servers$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_servers_update_own_or_owner" ON public.user_servers
    FOR UPDATE TO authenticated
    USING (
        user_id = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.servers
            WHERE servers.id = user_servers.server_id
            AND owner = public.get_current_profile_id()
        )
        OR public.is_current_user_admin()
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_servers_update_own_or_owner" ON public.user_servers', SQLERRM;
END $rls$;

-- Allow users to leave servers they're in, or owners to remove members
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can leave servers" ON public.user_servers$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can leave servers" ON public.user_servers
    FOR DELETE TO authenticated USING (
        user_id = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.servers
            WHERE servers.id = user_servers.server_id
            AND owner = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can leave servers" ON public.user_servers', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- CONVERSATIONS RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.conversations: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "conversations_select_participant" ON public.conversations$ddl$;
  EXECUTE $ddl$CREATE POLICY "conversations_select_participant" ON public.conversations
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.conversation_participants
            WHERE conversation_id = conversations.id
            AND user_id = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"conversations_select_participant" ON public.conversations', SQLERRM;
END $rls$;

-- Direct inserts must set created_by = self. All real conversation creation
-- goes through SECURITY DEFINER RPCs (create_or_get_direct_conversation,
-- create_group_conversation) which bypass RLS, so this strict check is safe.
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "conversations_insert_authenticated" ON public.conversations$ddl$;
  EXECUTE $ddl$CREATE POLICY "conversations_insert_authenticated" ON public.conversations
    FOR INSERT WITH CHECK (created_by = (select public.get_current_profile_id()))$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"conversations_insert_authenticated" ON public.conversations', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- CONVERSATION PARTICIPANTS RLS
-- ---------------------------------------------------------------------------
-- Note: Using simple policies to avoid infinite recursion issues.
-- Complex membership checks should be done in application logic or via helper functions.
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.conversation_participants ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.conversation_participants: %', SQLERRM;
END $rls$;

-- Read participant rows only for conversations the caller is in. Uses a
-- SECURITY DEFINER helper to avoid recursive RLS on this table. Previously this
-- was USING (true), which let any authenticated user enumerate every DM's
-- members (and, combined with the old permissive INSERT, self-join any DM).
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "conversation_participants_select_policy" ON public.conversation_participants$ddl$;
  EXECUTE $ddl$CREATE POLICY "conversation_participants_select_policy" ON public.conversation_participants
    FOR SELECT USING (
        public.is_conversation_participant(conversation_id, public.get_current_profile_id())
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"conversation_participants_select_policy" ON public.conversation_participants', SQLERRM;
END $rls$;

-- Direct client INSERTs are limited to adding YOURSELF to a conversation YOU
-- created. All real multi-party flows (1:1, group create, add member) go
-- through SECURITY DEFINER RPCs (create_or_get_direct_conversation,
-- create_group_conversation, add_user_to_conversation) which bypass RLS, so
-- this strict policy does not break any legitimate path. It does block the
-- attack of inserting yourself into a victim's existing conversation.
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "conversation_participants_insert_self_owned" ON public.conversation_participants$ddl$;
  EXECUTE $ddl$CREATE POLICY "conversation_participants_insert_self_owned" ON public.conversation_participants
    FOR INSERT WITH CHECK (
        user_id = public.get_current_profile_id()
        AND EXISTS (
            SELECT 1 FROM public.conversations c
            WHERE c.id = conversation_id
              AND c.created_by = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"conversation_participants_insert_self_owned" ON public.conversation_participants', SQLERRM;
END $rls$;

-- Allow users to update their own participation
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "conversation_participants_update_policy" ON public.conversation_participants$ddl$;
  EXECUTE $ddl$CREATE POLICY "conversation_participants_update_policy" ON public.conversation_participants
    FOR UPDATE TO authenticated USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"conversation_participants_update_policy" ON public.conversation_participants', SQLERRM;
END $rls$;

-- Allow users to leave conversations
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "conversation_participants_delete_policy" ON public.conversation_participants$ddl$;
  EXECUTE $ddl$CREATE POLICY "conversation_participants_delete_policy" ON public.conversation_participants
    FOR DELETE TO authenticated USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"conversation_participants_delete_policy" ON public.conversation_participants', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- NOTIFICATIONS RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.notifications: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "notifications_select_own" ON public.notifications$ddl$;
  EXECUTE $ddl$CREATE POLICY "notifications_select_own" ON public.notifications
    FOR SELECT USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"notifications_select_own" ON public.notifications', SQLERRM;
END $rls$;

-- Notifications are created exclusively by SECURITY DEFINER functions/triggers
-- (send_notification, create_notification_structured, ...) which run as the
-- table owner and bypass RLS. Restricting the INSERT policy to service_role
-- means authenticated clients can no longer forge arbitrary notifications for
-- other users (fake mentions/DMs/admin prompts) via PostgREST.
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "notifications_insert_system" ON public.notifications$ddl$;
  EXECUTE $ddl$CREATE POLICY "notifications_insert_system" ON public.notifications
    FOR INSERT TO service_role WITH CHECK (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"notifications_insert_system" ON public.notifications', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "notifications_update_own" ON public.notifications$ddl$;
  EXECUTE $ddl$CREATE POLICY "notifications_update_own" ON public.notifications
    FOR UPDATE USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"notifications_update_own" ON public.notifications', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "notifications_delete_own" ON public.notifications$ddl$;
  EXECUTE $ddl$CREATE POLICY "notifications_delete_own" ON public.notifications
    FOR DELETE USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"notifications_delete_own" ON public.notifications', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- USER BLOCKS RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.user_blocks: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_blocks_select_own" ON public.user_blocks$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_blocks_select_own" ON public.user_blocks
    FOR SELECT USING (blocker_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_blocks_select_own" ON public.user_blocks', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_blocks_check_if_blocked" ON public.user_blocks$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_blocks_check_if_blocked" ON public.user_blocks
    FOR SELECT USING (blocked_user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_blocks_check_if_blocked" ON public.user_blocks', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_blocks_insert_own" ON public.user_blocks$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_blocks_insert_own" ON public.user_blocks
    FOR INSERT WITH CHECK (blocker_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_blocks_insert_own" ON public.user_blocks', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_blocks_delete_own" ON public.user_blocks$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_blocks_delete_own" ON public.user_blocks
    FOR DELETE USING (blocker_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_blocks_delete_own" ON public.user_blocks', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- USER MUTES RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.user_mutes ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.user_mutes: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_mutes_select_own" ON public.user_mutes$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_mutes_select_own" ON public.user_mutes
    FOR SELECT USING (muter_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_mutes_select_own" ON public.user_mutes', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_mutes_insert_own" ON public.user_mutes$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_mutes_insert_own" ON public.user_mutes
    FOR INSERT WITH CHECK (muter_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_mutes_insert_own" ON public.user_mutes', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_mutes_update_own" ON public.user_mutes$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_mutes_update_own" ON public.user_mutes
    FOR UPDATE USING (muter_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_mutes_update_own" ON public.user_mutes', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_mutes_delete_own" ON public.user_mutes$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_mutes_delete_own" ON public.user_mutes
    FOR DELETE USING (muter_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_mutes_delete_own" ON public.user_mutes', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- REACTIONS RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.reactions ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.reactions: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "reactions_select_all" ON public.reactions$ddl$;
  EXECUTE $ddl$CREATE POLICY "reactions_select_all" ON public.reactions
    FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"reactions_select_all" ON public.reactions', SQLERRM;
END $rls$;

-- Prevent reactions on messages from users who blocked you
-- Note: Post reactions are handled in post_interactions table, not here
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "reactions_insert_own" ON public.reactions$ddl$;
  EXECUTE $ddl$CREATE POLICY "reactions_insert_own" ON public.reactions
    FOR INSERT WITH CHECK (
        user_id = public.get_current_profile_id()
        -- Check if message author blocked us
        AND NOT public.is_blocked_by((SELECT user_id FROM public.messages WHERE id = reactions.message_id))
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"reactions_insert_own" ON public.reactions', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "reactions_delete_own" ON public.reactions$ddl$;
  EXECUTE $ddl$CREATE POLICY "reactions_delete_own" ON public.reactions
    FOR DELETE USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"reactions_delete_own" ON public.reactions', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- Enable RLS on remaining tables (with permissive policies for now)
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.instance_config ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.instance_config: %', SQLERRM;
END $rls$;
GRANT SELECT ON public.instance_config TO anon, authenticated;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "instance_config_select_all" ON public.instance_config$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Public can read federation settings" ON public.instance_config$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Public can read instance settings" ON public.instance_config$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "instance_config_select_admin" ON public.instance_config$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
-- Curated public keys (see public_instance_config_keys() in 12_functions_rpc.sql).
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Public can read instance settings" ON public.instance_config$ddl$;
  EXECUTE $ddl$CREATE POLICY "Public can read instance settings" ON public.instance_config
    FOR SELECT USING (config_key = ANY (public.public_instance_config_keys()))$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Public can read instance settings" ON public.instance_config', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "instance_config_select_admin" ON public.instance_config$ddl$;
  EXECUTE $ddl$CREATE POLICY "instance_config_select_admin" ON public.instance_config
    FOR SELECT TO authenticated
    USING (public.is_current_user_admin())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"instance_config_select_admin" ON public.instance_config', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.emojis ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.emojis: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emojis_select_all" ON public.emojis$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emojis_select_all" ON public.emojis$ddl$;
  EXECUTE $ddl$CREATE POLICY "emojis_select_all" ON public.emojis FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"emojis_select_all" ON public.emojis', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emojis_insert_server_owner" ON public.emojis$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emojis_insert_server_owner" ON public.emojis$ddl$;
  EXECUTE $ddl$CREATE POLICY "emojis_insert_server_owner" ON public.emojis
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.servers
            WHERE id = emojis.server_id
            AND owner = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"emojis_insert_server_owner" ON public.emojis', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emojis_update_server_owner" ON public.emojis$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emojis_update_server_owner" ON public.emojis$ddl$;
  EXECUTE $ddl$CREATE POLICY "emojis_update_server_owner" ON public.emojis
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM public.servers
            WHERE id = emojis.server_id
            AND owner = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"emojis_update_server_owner" ON public.emojis', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emojis_delete_server_owner" ON public.emojis$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emojis_delete_server_owner" ON public.emojis$ddl$;
  EXECUTE $ddl$CREATE POLICY "emojis_delete_server_owner" ON public.emojis
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM public.servers
            WHERE id = emojis.server_id
            AND owner = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"emojis_delete_server_owner" ON public.emojis', SQLERRM;
END $rls$;

-- User-scoped emoji (personal uploads + AI-generated): owner manages their own.
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emojis_insert_user_scope" ON public.emojis$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emojis_insert_user_scope" ON public.emojis$ddl$;
  EXECUTE $ddl$CREATE POLICY "emojis_insert_user_scope" ON public.emojis
    FOR INSERT WITH CHECK (
        scope = 'user' AND uploader = public.get_current_profile_id()
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"emojis_insert_user_scope" ON public.emojis', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emojis_update_user_scope" ON public.emojis$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emojis_update_user_scope" ON public.emojis$ddl$;
  EXECUTE $ddl$CREATE POLICY "emojis_update_user_scope" ON public.emojis
    FOR UPDATE USING (
        scope = 'user' AND uploader = public.get_current_profile_id()
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"emojis_update_user_scope" ON public.emojis', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emojis_delete_user_scope" ON public.emojis$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emojis_delete_user_scope" ON public.emojis$ddl$;
  EXECUTE $ddl$CREATE POLICY "emojis_delete_user_scope" ON public.emojis
    FOR DELETE USING (
        scope = 'user' AND uploader = public.get_current_profile_id()
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"emojis_delete_user_scope" ON public.emojis', SQLERRM;
END $rls$;

-- Instance-wide emoji: managed by instance admins.
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emojis_insert_instance_admin" ON public.emojis$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emojis_insert_instance_admin" ON public.emojis$ddl$;
  EXECUTE $ddl$CREATE POLICY "emojis_insert_instance_admin" ON public.emojis
    FOR INSERT WITH CHECK (
        scope = 'instance'
        AND (SELECT is_admin FROM public.profiles WHERE auth_user_id = auth.uid())
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"emojis_insert_instance_admin" ON public.emojis', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emojis_update_instance_admin" ON public.emojis$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emojis_update_instance_admin" ON public.emojis$ddl$;
  EXECUTE $ddl$CREATE POLICY "emojis_update_instance_admin" ON public.emojis
    FOR UPDATE USING (
        scope = 'instance'
        AND (SELECT is_admin FROM public.profiles WHERE auth_user_id = auth.uid())
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"emojis_update_instance_admin" ON public.emojis', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emojis_delete_instance_admin" ON public.emojis$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emojis_delete_instance_admin" ON public.emojis$ddl$;
  EXECUTE $ddl$CREATE POLICY "emojis_delete_instance_admin" ON public.emojis
    FOR DELETE USING (
        scope = 'instance'
        AND (SELECT is_admin FROM public.profiles WHERE auth_user_id = auth.uid())
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"emojis_delete_instance_admin" ON public.emojis', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.hashtags ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.hashtags: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "hashtags_select_all" ON public.hashtags$ddl$;
  EXECUTE $ddl$CREATE POLICY "hashtags_select_all" ON public.hashtags FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"hashtags_select_all" ON public.hashtags', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.federated_instances ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.federated_instances: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "federated_instances_select_all" ON public.federated_instances$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "federated_instances_select_all" ON public.federated_instances$ddl$;
  EXECUTE $ddl$CREATE POLICY "federated_instances_select_all" ON public.federated_instances FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"federated_instances_select_all" ON public.federated_instances', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "federated_instances_manage" ON public.federated_instances$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "federated_instances_manage" ON public.federated_instances$ddl$;
  EXECUTE $ddl$CREATE POLICY "federated_instances_manage" ON public.federated_instances
    FOR ALL USING (public.is_current_user_admin())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"federated_instances_manage" ON public.federated_instances', SQLERRM;
END $rls$;

-- Federation endpoint health
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.federation_endpoint_health ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.federation_endpoint_health: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "federation_endpoint_health_select" ON public.federation_endpoint_health$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "federation_endpoint_health_select" ON public.federation_endpoint_health$ddl$;
  EXECUTE $ddl$CREATE POLICY "federation_endpoint_health_select" ON public.federation_endpoint_health
    FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"federation_endpoint_health_select" ON public.federation_endpoint_health', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "federation_endpoint_health_manage" ON public.federation_endpoint_health$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "federation_endpoint_health_manage" ON public.federation_endpoint_health$ddl$;
  EXECUTE $ddl$CREATE POLICY "federation_endpoint_health_manage" ON public.federation_endpoint_health
    FOR ALL TO service_role
    USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"federation_endpoint_health_manage" ON public.federation_endpoint_health', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "federation_endpoint_health_insert_update" ON public.federation_endpoint_health$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "federation_endpoint_health_insert_update" ON public.federation_endpoint_health$ddl$;
  EXECUTE $ddl$CREATE POLICY "federation_endpoint_health_insert_update" ON public.federation_endpoint_health
    FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"federation_endpoint_health_insert_update" ON public.federation_endpoint_health', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Admins can delete dead endpoints" ON public.federation_endpoint_health$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Admins can delete dead endpoints" ON public.federation_endpoint_health$ddl$;
  EXECUTE $ddl$CREATE POLICY "Admins can delete dead endpoints" ON public.federation_endpoint_health
    FOR DELETE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = public.get_current_profile_id()
            AND is_admin = true
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Admins can delete dead endpoints" ON public.federation_endpoint_health', SQLERRM;
END $rls$;

-- Federation health (instance-level)
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.federation_health ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.federation_health: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "federation_health_select_all" ON public.federation_health$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "federation_health_select_all" ON public.federation_health$ddl$;
  EXECUTE $ddl$CREATE POLICY "federation_health_select_all" ON public.federation_health
    FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"federation_health_select_all" ON public.federation_health', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "federation_health_manage" ON public.federation_health$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "federation_health_manage" ON public.federation_health$ddl$;
  EXECUTE $ddl$CREATE POLICY "federation_health_manage" ON public.federation_health
    FOR ALL USING (public.is_current_user_admin())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"federation_health_manage" ON public.federation_health', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.oauth_providers ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.oauth_providers: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "oauth_providers_select_all" ON public.oauth_providers$ddl$;
  EXECUTE $ddl$CREATE POLICY "oauth_providers_select_all" ON public.oauth_providers FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"oauth_providers_select_all" ON public.oauth_providers', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.server_roles ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.server_roles: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "server_roles_select" ON public.server_roles$ddl$;
  EXECUTE $ddl$CREATE POLICY "server_roles_select" ON public.server_roles FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"server_roles_select" ON public.server_roles', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "server_roles_insert" ON public.server_roles$ddl$;
  EXECUTE $ddl$CREATE POLICY "server_roles_insert" ON public.server_roles
    FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM public.servers WHERE id = server_id AND owner = public.get_current_profile_id())
        OR public.is_current_user_admin()
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"server_roles_insert" ON public.server_roles', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "server_roles_update" ON public.server_roles$ddl$;
  EXECUTE $ddl$CREATE POLICY "server_roles_update" ON public.server_roles
    FOR UPDATE USING (
        NOT is_default AND (
            EXISTS (SELECT 1 FROM public.servers WHERE id = server_id AND owner = public.get_current_profile_id())
            OR public.is_current_user_admin()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"server_roles_update" ON public.server_roles', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "server_roles_delete" ON public.server_roles$ddl$;
  EXECUTE $ddl$CREATE POLICY "server_roles_delete" ON public.server_roles
    FOR DELETE USING (
        NOT is_default AND (
            EXISTS (SELECT 1 FROM public.servers WHERE id = server_id AND owner = public.get_current_profile_id())
            OR public.is_current_user_admin()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"server_roles_delete" ON public.server_roles', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.user_roles: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_roles_select" ON public.user_roles$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_roles_select" ON public.user_roles FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_roles_select" ON public.user_roles', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_roles_insert" ON public.user_roles$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_roles_insert" ON public.user_roles
    FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM public.servers WHERE id = server_id AND owner = public.get_current_profile_id())
        OR public.is_current_user_admin()
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_roles_insert" ON public.user_roles', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_roles_delete" ON public.user_roles$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_roles_delete" ON public.user_roles
    FOR DELETE USING (
        EXISTS (SELECT 1 FROM public.servers WHERE id = server_id AND owner = public.get_current_profile_id())
        OR public.is_current_user_admin()
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_roles_delete" ON public.user_roles', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.threads ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.threads: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "threads_select_member" ON public.threads$ddl$;
  EXECUTE $ddl$CREATE POLICY "threads_select_member" ON public.threads FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"threads_select_member" ON public.threads', SQLERRM;
END $rls$;

-- Server members can create threads
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "threads_insert_member" ON public.threads$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "threads_insert_member" ON public.threads$ddl$;
  EXECUTE $ddl$CREATE POLICY "threads_insert_member" ON public.threads
    FOR INSERT WITH CHECK (
        created_by = public.get_current_profile_id()
        AND EXISTS (
            SELECT 1 FROM public.channels c
            JOIN public.user_servers us ON us.server_id = c.server_id
            WHERE c.id = threads.channel_id
            AND us.user_id = public.get_current_profile_id()
            AND us.status = 'accepted'
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"threads_insert_member" ON public.threads', SQLERRM;
END $rls$;

-- Thread creator or users with MANAGE_CHANNELS can update threads
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "threads_update_authorized" ON public.threads$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "threads_update_authorized" ON public.threads$ddl$;
  EXECUTE $ddl$CREATE POLICY "threads_update_authorized" ON public.threads
    FOR UPDATE USING (
        created_by = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.channels c
            JOIN public.servers s ON s.id = c.server_id
            WHERE c.id = threads.channel_id
            AND s.owner = public.get_current_profile_id()
        )
        OR public.is_current_user_admin()
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"threads_update_authorized" ON public.threads', SQLERRM;
END $rls$;

-- Thread creator or server owner can delete threads
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "threads_delete_authorized" ON public.threads$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "threads_delete_authorized" ON public.threads$ddl$;
  EXECUTE $ddl$CREATE POLICY "threads_delete_authorized" ON public.threads
    FOR DELETE USING (
        created_by = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.channels c
            JOIN public.servers s ON s.id = c.server_id
            WHERE c.id = threads.channel_id
            AND s.owner = public.get_current_profile_id()
        )
        OR public.is_current_user_admin()
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"threads_delete_authorized" ON public.threads', SQLERRM;
END $rls$;

-- Service role can do anything on threads (for federation backend)
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "threads_service_role" ON public.threads$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "threads_service_role" ON public.threads$ddl$;
  EXECUTE $ddl$CREATE POLICY "threads_service_role" ON public.threads
    FOR ALL TO service_role USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"threads_service_role" ON public.threads', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.thread_members ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.thread_members: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "thread_members_select_all" ON public.thread_members$ddl$;
  EXECUTE $ddl$CREATE POLICY "thread_members_select_all" ON public.thread_members FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"thread_members_select_all" ON public.thread_members', SQLERRM;
END $rls$;

-- Users can join threads (insert themselves)
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "thread_members_insert_self" ON public.thread_members$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "thread_members_insert_self" ON public.thread_members$ddl$;
  EXECUTE $ddl$CREATE POLICY "thread_members_insert_self" ON public.thread_members
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"thread_members_insert_self" ON public.thread_members', SQLERRM;
END $rls$;

-- Users can update their own thread membership (mute, etc.)
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "thread_members_update_self" ON public.thread_members$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "thread_members_update_self" ON public.thread_members$ddl$;
  EXECUTE $ddl$CREATE POLICY "thread_members_update_self" ON public.thread_members
    FOR UPDATE USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"thread_members_update_self" ON public.thread_members', SQLERRM;
END $rls$;

-- Users can leave threads (delete themselves)
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "thread_members_delete_self" ON public.thread_members$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "thread_members_delete_self" ON public.thread_members$ddl$;
  EXECUTE $ddl$CREATE POLICY "thread_members_delete_self" ON public.thread_members
    FOR DELETE USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"thread_members_delete_self" ON public.thread_members', SQLERRM;
END $rls$;

-- Service role can manage thread members (for triggers/federation)
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "thread_members_service_role" ON public.thread_members$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "thread_members_service_role" ON public.thread_members$ddl$;
  EXECUTE $ddl$CREATE POLICY "thread_members_service_role" ON public.thread_members
    FOR ALL TO service_role USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"thread_members_service_role" ON public.thread_members', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.invites: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "invites_select_all" ON public.invites$ddl$;
  EXECUTE $ddl$CREATE POLICY "invites_select_all" ON public.invites FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"invites_select_all" ON public.invites', SQLERRM;
END $rls$;

-- Server members can create invites
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "invites_insert_members" ON public.invites$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "invites_insert_members" ON public.invites$ddl$;
  EXECUTE $ddl$CREATE POLICY "invites_insert_members" ON public.invites FOR INSERT
    WITH CHECK (
        auth.role() = 'authenticated'
        AND EXISTS (
            SELECT 1 FROM public.user_servers us
            WHERE us.server_id = invites.server_id
              AND us.user_id = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"invites_insert_members" ON public.invites', SQLERRM;
END $rls$;

-- Invite creators can update their own invites (mark used, increment uses)
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "invites_update_creator" ON public.invites$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "invites_update_creator" ON public.invites$ddl$;
  EXECUTE $ddl$CREATE POLICY "invites_update_creator" ON public.invites FOR UPDATE
    USING (created_by = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"invites_update_creator" ON public.invites', SQLERRM;
END $rls$;

-- Invite creators can delete their own invites
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "invites_delete_creator" ON public.invites$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "invites_delete_creator" ON public.invites$ddl$;
  EXECUTE $ddl$CREATE POLICY "invites_delete_creator" ON public.invites FOR DELETE
    USING (created_by = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"invites_delete_creator" ON public.invites', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.voice_channel_participants ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.voice_channel_participants: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "voice_participants_select_all" ON public.voice_channel_participants$ddl$;
  EXECUTE $ddl$CREATE POLICY "voice_participants_select_all" ON public.voice_channel_participants FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"voice_participants_select_all" ON public.voice_channel_participants', SQLERRM;
END $rls$;
-- Local users manage their own presence row directly from the client. Federated
-- participants and cleanup jobs use the service_role key, which bypasses RLS.
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "voice_participants_insert_self" ON public.voice_channel_participants$ddl$;
  EXECUTE $ddl$CREATE POLICY "voice_participants_insert_self" ON public.voice_channel_participants
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"voice_participants_insert_self" ON public.voice_channel_participants', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "voice_participants_update_self" ON public.voice_channel_participants$ddl$;
  EXECUTE $ddl$CREATE POLICY "voice_participants_update_self" ON public.voice_channel_participants
    FOR UPDATE USING (user_id = public.get_current_profile_id())
    WITH CHECK (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"voice_participants_update_self" ON public.voice_channel_participants', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "voice_participants_delete_self" ON public.voice_channel_participants$ddl$;
  EXECUTE $ddl$CREATE POLICY "voice_participants_delete_self" ON public.voice_channel_participants
    FOR DELETE USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"voice_participants_delete_self" ON public.voice_channel_participants', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- INSTANCE WEBRTC SETTINGS RLS
-- SECURITY: This table contains livekit_api_secret which MUST NOT be exposed!
-- Only admins can read the full table. Use get_livekit_config() for safe access.
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.instance_webrtc_settings ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.instance_webrtc_settings: %', SQLERRM;
END $rls$;

-- Only admins can read WebRTC settings (contains API secrets)
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "webrtc_settings_select_admin_only" ON public.instance_webrtc_settings$ddl$;
  EXECUTE $ddl$CREATE POLICY "webrtc_settings_select_admin_only" ON public.instance_webrtc_settings 
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.profiles 
            WHERE auth_user_id = auth.uid() 
            AND is_admin = true
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"webrtc_settings_select_admin_only" ON public.instance_webrtc_settings', SQLERRM;
END $rls$;

-- Only admins can modify WebRTC settings
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "webrtc_settings_update_admin_only" ON public.instance_webrtc_settings$ddl$;
  EXECUTE $ddl$CREATE POLICY "webrtc_settings_update_admin_only" ON public.instance_webrtc_settings 
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM public.profiles 
            WHERE auth_user_id = auth.uid() 
            AND is_admin = true
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"webrtc_settings_update_admin_only" ON public.instance_webrtc_settings', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "webrtc_settings_insert_admin_only" ON public.instance_webrtc_settings$ddl$;
  EXECUTE $ddl$CREATE POLICY "webrtc_settings_insert_admin_only" ON public.instance_webrtc_settings 
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles 
            WHERE auth_user_id = auth.uid() 
            AND is_admin = true
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"webrtc_settings_insert_admin_only" ON public.instance_webrtc_settings', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- NOTIFICATION PREFERENCES RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.notification_preferences: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "notification_preferences_select_own" ON public.notification_preferences$ddl$;
  EXECUTE $ddl$CREATE POLICY "notification_preferences_select_own" ON public.notification_preferences
    FOR SELECT USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"notification_preferences_select_own" ON public.notification_preferences', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "notification_preferences_insert_own" ON public.notification_preferences$ddl$;
  EXECUTE $ddl$CREATE POLICY "notification_preferences_insert_own" ON public.notification_preferences
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"notification_preferences_insert_own" ON public.notification_preferences', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "notification_preferences_update_own" ON public.notification_preferences$ddl$;
  EXECUTE $ddl$CREATE POLICY "notification_preferences_update_own" ON public.notification_preferences
    FOR UPDATE USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"notification_preferences_update_own" ON public.notification_preferences', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "notification_preferences_delete_own" ON public.notification_preferences$ddl$;
  EXECUTE $ddl$CREATE POLICY "notification_preferences_delete_own" ON public.notification_preferences
    FOR DELETE USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"notification_preferences_delete_own" ON public.notification_preferences', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- NOTIFICATION CHANNELS RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.notification_channels ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.notification_channels: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "notification_channels_select_own" ON public.notification_channels$ddl$;
  EXECUTE $ddl$CREATE POLICY "notification_channels_select_own" ON public.notification_channels
    FOR SELECT USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"notification_channels_select_own" ON public.notification_channels', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "notification_channels_insert_own" ON public.notification_channels$ddl$;
  EXECUTE $ddl$CREATE POLICY "notification_channels_insert_own" ON public.notification_channels
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"notification_channels_insert_own" ON public.notification_channels', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "notification_channels_update_own" ON public.notification_channels$ddl$;
  EXECUTE $ddl$CREATE POLICY "notification_channels_update_own" ON public.notification_channels
    FOR UPDATE USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"notification_channels_update_own" ON public.notification_channels', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "notification_channels_delete_own" ON public.notification_channels$ddl$;
  EXECUTE $ddl$CREATE POLICY "notification_channels_delete_own" ON public.notification_channels
    FOR DELETE USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"notification_channels_delete_own" ON public.notification_channels', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- SERVER BANS RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.server_bans ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.server_bans: %', SQLERRM;
END $rls$;

-- All ban mutations go through SECURITY DEFINER RPCs (ban_server_member,
-- unban_server_member) and the list is read via get_server_bans (also definer,
-- with a BAN_MEMBERS/owner check). The table itself must NOT be openly
-- readable/writable: previously any authenticated user could enumerate every
-- server's ban list (reasons included) and insert/delete arbitrary bans.
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "server_bans_select_moderator" ON public.server_bans$ddl$;
  EXECUTE $ddl$CREATE POLICY "server_bans_select_moderator" ON public.server_bans
    FOR SELECT TO authenticated USING (
        public.is_current_user_admin()
        OR public.has_permission(public.get_current_profile_id(), server_id, 'BAN_MEMBERS')
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"server_bans_select_moderator" ON public.server_bans', SQLERRM;
END $rls$;

-- Writes are service_role / SECURITY DEFINER RPC only (definers bypass RLS).
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "server_bans_insert_service" ON public.server_bans$ddl$;
  EXECUTE $ddl$CREATE POLICY "server_bans_insert_service" ON public.server_bans
    FOR INSERT TO service_role WITH CHECK (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"server_bans_insert_service" ON public.server_bans', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "server_bans_delete_service" ON public.server_bans$ddl$;
  EXECUTE $ddl$CREATE POLICY "server_bans_delete_service" ON public.server_bans
    FOR DELETE TO service_role USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"server_bans_delete_service" ON public.server_bans', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- ANNOUNCEMENTS RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.instance_announcements ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.instance_announcements: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.announcement_reads ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.announcement_reads: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "announcements_select_all" ON public.instance_announcements$ddl$;
  EXECUTE $ddl$CREATE POLICY "announcements_select_all" ON public.instance_announcements
    FOR SELECT TO authenticated USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"announcements_select_all" ON public.instance_announcements', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "announcements_insert_admin" ON public.instance_announcements$ddl$;
  EXECUTE $ddl$CREATE POLICY "announcements_insert_admin" ON public.instance_announcements
    FOR INSERT TO authenticated WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"announcements_insert_admin" ON public.instance_announcements', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "announcements_update_admin" ON public.instance_announcements$ddl$;
  EXECUTE $ddl$CREATE POLICY "announcements_update_admin" ON public.instance_announcements
    FOR UPDATE TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"announcements_update_admin" ON public.instance_announcements', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "announcements_delete_admin" ON public.instance_announcements$ddl$;
  EXECUTE $ddl$CREATE POLICY "announcements_delete_admin" ON public.instance_announcements
    FOR DELETE TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"announcements_delete_admin" ON public.instance_announcements', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "announcement_reads_select_own" ON public.announcement_reads$ddl$;
  EXECUTE $ddl$CREATE POLICY "announcement_reads_select_own" ON public.announcement_reads
    FOR SELECT TO authenticated USING (user_id = auth.uid())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"announcement_reads_select_own" ON public.announcement_reads', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "announcement_reads_insert_own" ON public.announcement_reads$ddl$;
  EXECUTE $ddl$CREATE POLICY "announcement_reads_insert_own" ON public.announcement_reads
    FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"announcement_reads_insert_own" ON public.announcement_reads', SQLERRM;
END $rls$;

DO $$
BEGIN
    RAISE NOTICE 'RLS policies created successfully';
END $$;


-- ===== from db_schema/init/31_rls_policies_extended.sql =====
-- =============================================================================
-- Harmony Database Schema - Extended RLS Policies
-- =============================================================================
-- RLS policies for additional tables: trending, bots, encryption
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Helper: Check if user is admin
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_current_user_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT is_admin FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
$$;

-- ---------------------------------------------------------------------------
-- Helper: Check if user is instance moderator
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_current_user_moderator()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT is_moderator FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
$$;

-- ---------------------------------------------------------------------------
-- Helper: Check if user is admin OR moderator
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_current_user_admin_or_mod()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT (is_admin OR is_moderator) FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
$$;

-- ---------------------------------------------------------------------------
-- Helper: Check if current user can manage messages in a given channel
-- Checks server ownership, server admin role, and MANAGE_MESSAGES (bit 21)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.can_current_user_manage_messages_in_channel(p_channel_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profile_id uuid;
    v_server_id uuid;
    v_is_owner boolean;
    v_has_perm boolean;
BEGIN
    v_profile_id := public.get_current_profile_id();
    IF v_profile_id IS NULL THEN RETURN false; END IF;

    SELECT server_id INTO v_server_id FROM public.channels WHERE id = p_channel_id;
    IF v_server_id IS NULL THEN RETURN false; END IF;

    SELECT (owner = v_profile_id) INTO v_is_owner FROM public.servers WHERE id = v_server_id;
    IF v_is_owner THEN RETURN true; END IF;

    -- Check if user has a role with ADMINISTRATOR (bit 0) or MANAGE_MESSAGES (bit 21)
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        JOIN public.server_roles sr ON sr.id = ur.role_id
        WHERE ur.user_id = v_profile_id
          AND sr.server_id = v_server_id
          AND (
              sr.is_admin = true
              OR (sr.permissions & (1::bigint << 0)) != 0
              OR (sr.permissions & (1::bigint << 21)) != 0
          )
    ) INTO v_has_perm;

    RETURN v_has_perm;
END;
$$;

-- ---------------------------------------------------------------------------
-- TRENDING POSTS RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.trending_posts ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.trending_posts: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "trending_posts_select_all" ON public.trending_posts$ddl$;
  EXECUTE $ddl$CREATE POLICY "trending_posts_select_all" ON public.trending_posts
    FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"trending_posts_select_all" ON public.trending_posts', SQLERRM;
END $rls$;

-- Only system/admin can modify trending data
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "trending_posts_admin_modify" ON public.trending_posts$ddl$;
  EXECUTE $ddl$CREATE POLICY "trending_posts_admin_modify" ON public.trending_posts
    FOR ALL USING (public.is_current_user_admin())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"trending_posts_admin_modify" ON public.trending_posts', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- TRENDING USERS RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.trending_users ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.trending_users: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "trending_users_select_all" ON public.trending_users$ddl$;
  EXECUTE $ddl$CREATE POLICY "trending_users_select_all" ON public.trending_users
    FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"trending_users_select_all" ON public.trending_users', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "trending_users_admin_modify" ON public.trending_users$ddl$;
  EXECUTE $ddl$CREATE POLICY "trending_users_admin_modify" ON public.trending_users
    FOR ALL USING (public.is_current_user_admin())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"trending_users_admin_modify" ON public.trending_users', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- TRENDING REFRESH QUEUE RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.trending_refresh_queue ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.trending_refresh_queue: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "trending_refresh_queue_admin_only" ON public.trending_refresh_queue$ddl$;
  EXECUTE $ddl$CREATE POLICY "trending_refresh_queue_admin_only" ON public.trending_refresh_queue
    FOR ALL USING (public.is_current_user_admin())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"trending_refresh_queue_admin_only" ON public.trending_refresh_queue', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- SERVER FOLDERS RLS (user-owned)
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.server_folders ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.server_folders: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "server_folders_select_own" ON public.server_folders$ddl$;
  EXECUTE $ddl$CREATE POLICY "server_folders_select_own" ON public.server_folders
    FOR SELECT USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"server_folders_select_own" ON public.server_folders', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "server_folders_insert_own" ON public.server_folders$ddl$;
  EXECUTE $ddl$CREATE POLICY "server_folders_insert_own" ON public.server_folders
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"server_folders_insert_own" ON public.server_folders', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "server_folders_update_own" ON public.server_folders$ddl$;
  EXECUTE $ddl$CREATE POLICY "server_folders_update_own" ON public.server_folders
    FOR UPDATE USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"server_folders_update_own" ON public.server_folders', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "server_folders_delete_own" ON public.server_folders$ddl$;
  EXECUTE $ddl$CREATE POLICY "server_folders_delete_own" ON public.server_folders
    FOR DELETE USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"server_folders_delete_own" ON public.server_folders', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- SERVER SETTINGS RLS (server owner/admin)
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.server_settings ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.server_settings: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "server_settings_select_member" ON public.server_settings$ddl$;
  EXECUTE $ddl$CREATE POLICY "server_settings_select_member" ON public.server_settings
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.user_servers us
            WHERE us.server_id = server_settings.server_id
            AND us.user_id = public.get_current_profile_id()
            AND us.status = 'accepted'
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"server_settings_select_member" ON public.server_settings', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "server_settings_modify_owner" ON public.server_settings$ddl$;
  EXECUTE $ddl$CREATE POLICY "server_settings_modify_owner" ON public.server_settings
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.servers s
            WHERE s.id = server_settings.server_id
            AND s.owner = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"server_settings_modify_owner" ON public.server_settings', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- CHANNEL PERMISSION OVERRIDES RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.channel_permission_overrides ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.channel_permission_overrides: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "channel_permission_overrides_select" ON public.channel_permission_overrides$ddl$;
  EXECUTE $ddl$CREATE POLICY "channel_permission_overrides_select" ON public.channel_permission_overrides
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.channels c
            JOIN public.user_servers us ON us.server_id = c.server_id
            WHERE c.id = channel_permission_overrides.channel_id
            AND us.user_id = public.get_current_profile_id()
            AND us.status = 'accepted'
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"channel_permission_overrides_select" ON public.channel_permission_overrides', SQLERRM;
END $rls$;

-- Server owners, instance staff (is_admin / is_moderator), and members with
-- MANAGE_CHANNELS, MANAGE_ROLES, or ADMINISTRATOR can manage overrides.
-- See migrations/20260524_channel_overrides_fix.sql for the reasoning.
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "channel_permission_overrides_modify_owner"
    ON public.channel_permission_overrides$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "channel_permission_overrides_modify"
    ON public.channel_permission_overrides$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "channel_permission_overrides_modify" ON public.channel_permission_overrides$ddl$;
  EXECUTE $ddl$CREATE POLICY "channel_permission_overrides_modify" ON public.channel_permission_overrides
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.channels c
            JOIN public.servers s ON s.id = c.server_id
            LEFT JOIN public.profiles p ON p.id = public.get_current_profile_id()
            WHERE c.id = channel_permission_overrides.channel_id
              AND (
                    s.owner = public.get_current_profile_id()
                    OR COALESCE(p.is_admin, false)
                    OR COALESCE(p.is_moderator, false)
                    OR EXISTS (
                        SELECT 1 FROM public.user_roles ur
                        JOIN public.server_roles sr ON sr.id = ur.role_id
                        WHERE ur.user_id = public.get_current_profile_id()
                          AND ur.server_id = s.id
                          AND (
                                (sr.permissions::bigint & (1::bigint << 0)) <> 0
                             OR (sr.permissions::bigint & (1::bigint << 2)) <> 0
                             OR (sr.permissions::bigint & (1::bigint << 3)) <> 0
                          )
                    )
              )
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.channels c
            JOIN public.servers s ON s.id = c.server_id
            LEFT JOIN public.profiles p ON p.id = public.get_current_profile_id()
            WHERE c.id = channel_permission_overrides.channel_id
              AND (
                    s.owner = public.get_current_profile_id()
                    OR COALESCE(p.is_admin, false)
                    OR COALESCE(p.is_moderator, false)
                    OR EXISTS (
                        SELECT 1 FROM public.user_roles ur
                        JOIN public.server_roles sr ON sr.id = ur.role_id
                        WHERE ur.user_id = public.get_current_profile_id()
                          AND ur.server_id = s.id
                          AND (
                                (sr.permissions::bigint & (1::bigint << 0)) <> 0
                             OR (sr.permissions::bigint & (1::bigint << 2)) <> 0
                             OR (sr.permissions::bigint & (1::bigint << 3)) <> 0
                          )
                    )
              )
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"channel_permission_overrides_modify" ON public.channel_permission_overrides', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- USER MUTES RLS (own mutes only)
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.user_mutes ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.user_mutes: %', SQLERRM;
END $rls$;


DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS user_mutes_select_own ON public.user_mutes$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS user_mutes_insert_own on public.user_mutes$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS user_mutes_update_own on public.user_mutes$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS user_mutes_delete_own on public.user_mutes$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_mutes_select_own" ON public.user_mutes$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_mutes_select_own" ON public.user_mutes
    FOR SELECT USING (muter_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_mutes_select_own" ON public.user_mutes', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_mutes_insert_own" ON public.user_mutes$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_mutes_insert_own" ON public.user_mutes
    FOR INSERT WITH CHECK (muter_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_mutes_insert_own" ON public.user_mutes', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_mutes_update_own" ON public.user_mutes$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_mutes_update_own" ON public.user_mutes
    FOR UPDATE USING (muter_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_mutes_update_own" ON public.user_mutes', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_mutes_delete_own" ON public.user_mutes$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_mutes_delete_own" ON public.user_mutes
    FOR DELETE USING (muter_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_mutes_delete_own" ON public.user_mutes', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- BOT TABLES RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.bot_commands ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.bot_commands: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.bot_webhooks ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.bot_webhooks: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.bot_presence ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.bot_presence: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.bot_rate_limits ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.bot_rate_limits: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.bot_audit_log ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.bot_audit_log: %', SQLERRM;
END $rls$;

-- Bot commands: public read, owner modify
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "bot_commands_select_all" ON public.bot_commands$ddl$;
  EXECUTE $ddl$CREATE POLICY "bot_commands_select_all" ON public.bot_commands
    FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"bot_commands_select_all" ON public.bot_commands', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "bot_commands_modify_owner" ON public.bot_commands$ddl$;
  EXECUTE $ddl$CREATE POLICY "bot_commands_modify_owner" ON public.bot_commands
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.bots b
            WHERE b.id = bot_commands.bot_id
            AND b.owner_id = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"bot_commands_modify_owner" ON public.bot_commands', SQLERRM;
END $rls$;

-- Bot webhooks: owner only
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "bot_webhooks_owner_only" ON public.bot_webhooks$ddl$;
  EXECUTE $ddl$CREATE POLICY "bot_webhooks_owner_only" ON public.bot_webhooks
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.bots b
            WHERE b.id = bot_webhooks.bot_id
            AND b.owner_id = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"bot_webhooks_owner_only" ON public.bot_webhooks', SQLERRM;
END $rls$;

-- Bot presence: public read, owner modify
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "bot_presence_select_all" ON public.bot_presence$ddl$;
  EXECUTE $ddl$CREATE POLICY "bot_presence_select_all" ON public.bot_presence
    FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"bot_presence_select_all" ON public.bot_presence', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "bot_presence_modify_owner" ON public.bot_presence$ddl$;
  EXECUTE $ddl$CREATE POLICY "bot_presence_modify_owner" ON public.bot_presence
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.bots b
            WHERE b.id = bot_presence.bot_id
            AND b.owner_id = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"bot_presence_modify_owner" ON public.bot_presence', SQLERRM;
END $rls$;

-- Bot rate limits: owner only
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "bot_rate_limits_owner_only" ON public.bot_rate_limits$ddl$;
  EXECUTE $ddl$CREATE POLICY "bot_rate_limits_owner_only" ON public.bot_rate_limits
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.bots b
            WHERE b.id = bot_rate_limits.bot_id
            AND b.owner_id = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"bot_rate_limits_owner_only" ON public.bot_rate_limits', SQLERRM;
END $rls$;

-- Bot audit log: owner read, system write
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "bot_audit_log_select_owner" ON public.bot_audit_log$ddl$;
  EXECUTE $ddl$CREATE POLICY "bot_audit_log_select_owner" ON public.bot_audit_log
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.bots b
            WHERE b.id = bot_audit_log.bot_id
            AND b.owner_id = public.get_current_profile_id()
        )
        OR public.is_current_user_admin()
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"bot_audit_log_select_owner" ON public.bot_audit_log', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- ENCRYPTION TABLES RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.user_private_keys ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.user_private_keys: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.megolm_room_sessions ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.megolm_room_sessions: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.megolm_session_shares ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.megolm_session_shares: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.megolm_key_requests ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.megolm_key_requests: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.megolm_key_backups ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.megolm_key_backups: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.recovery_key_metadata ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.recovery_key_metadata: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.mfa_recovery_codes ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.mfa_recovery_codes: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.conversation_encryption_settings ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.conversation_encryption_settings: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.server_encryption_settings ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.server_encryption_settings: %', SQLERRM;
END $rls$;

-- User private keys: service_role only (federation backend uses service_role key)
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_private_keys_own_only" ON public.user_private_keys$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Service role only access" ON public.user_private_keys$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Service role only access" ON public.user_private_keys$ddl$;
  EXECUTE $ddl$CREATE POLICY "Service role only access" ON public.user_private_keys
    USING (auth.role() = 'service_role')$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Service role only access" ON public.user_private_keys', SQLERRM;
END $rls$;

-- Megolm room sessions: creator or shared with
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "megolm_room_sessions_select" ON public.megolm_room_sessions$ddl$;
  EXECUTE $ddl$CREATE POLICY "megolm_room_sessions_select" ON public.megolm_room_sessions
    FOR SELECT USING (
        creator_user_id = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.megolm_session_shares
            WHERE session_id = megolm_room_sessions.session_id
            AND room_id = megolm_room_sessions.room_id
            AND recipient_user_id = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"megolm_room_sessions_select" ON public.megolm_room_sessions', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "megolm_room_sessions_insert_own" ON public.megolm_room_sessions$ddl$;
  EXECUTE $ddl$CREATE POLICY "megolm_room_sessions_insert_own" ON public.megolm_room_sessions
    FOR INSERT WITH CHECK (creator_user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"megolm_room_sessions_insert_own" ON public.megolm_room_sessions', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "megolm_room_sessions_update_own" ON public.megolm_room_sessions$ddl$;
  EXECUTE $ddl$CREATE POLICY "megolm_room_sessions_update_own" ON public.megolm_room_sessions
    FOR UPDATE USING (creator_user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"megolm_room_sessions_update_own" ON public.megolm_room_sessions', SQLERRM;
END $rls$;

-- Megolm session shares: sender (the one who wrapped the key) or recipient.
-- The client tracks the outbound session locally and never writes a
-- megolm_room_sessions row, so authorization keys off sender_user_id rather
-- than the (frequently absent) room-session creator.
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "megolm_session_shares_select" ON public.megolm_session_shares$ddl$;
  EXECUTE $ddl$CREATE POLICY "megolm_session_shares_select" ON public.megolm_session_shares
    FOR SELECT USING (
        recipient_user_id = public.get_current_profile_id()
        OR sender_user_id = public.get_current_profile_id()
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"megolm_session_shares_select" ON public.megolm_session_shares', SQLERRM;
END $rls$;

-- Sender must be the caller AND both sender and recipient must belong to the
-- room. Without the membership checks, a malicious member could wrap a room's
-- session key to an arbitrary recipient outside the room, leaking all messages
-- in that Megolm session.
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "megolm_session_shares_insert" ON public.megolm_session_shares$ddl$;
  EXECUTE $ddl$CREATE POLICY "megolm_session_shares_insert" ON public.megolm_session_shares
    FOR INSERT WITH CHECK (
        sender_user_id = public.get_current_profile_id()
        -- room_id::text: is_room_member takes (text, uuid). Cast is a no-op on
        -- text columns and keeps the policy resolvable if room_id is ever uuid.
        AND public.is_room_member(room_id::text, sender_user_id)
        AND public.is_room_member(room_id::text, recipient_user_id)
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"megolm_session_shares_insert" ON public.megolm_session_shares', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "megolm_session_shares_update" ON public.megolm_session_shares$ddl$;
  EXECUTE $ddl$CREATE POLICY "megolm_session_shares_update" ON public.megolm_session_shares
    FOR UPDATE USING (
        sender_user_id = public.get_current_profile_id()
        OR recipient_user_id = public.get_current_profile_id()
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"megolm_session_shares_update" ON public.megolm_session_shares', SQLERRM;
END $rls$;

-- Megolm key requests: own requests
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "megolm_key_requests_own" ON public.megolm_key_requests$ddl$;
  EXECUTE $ddl$CREATE POLICY "megolm_key_requests_own" ON public.megolm_key_requests
    FOR ALL USING (requester_user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"megolm_key_requests_own" ON public.megolm_key_requests', SQLERRM;
END $rls$;

-- Also allow viewing requests addressed to me (I'm the designated fulfiller),
-- or requests for sessions I created.
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "megolm_key_requests_select_for_response" ON public.megolm_key_requests$ddl$;
  EXECUTE $ddl$CREATE POLICY "megolm_key_requests_select_for_response" ON public.megolm_key_requests
    FOR SELECT USING (
        sender_user_id = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.megolm_room_sessions mrs
            WHERE mrs.session_id = megolm_key_requests.session_id
            AND mrs.room_id = megolm_key_requests.room_id
            AND mrs.creator_user_id = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"megolm_key_requests_select_for_response" ON public.megolm_key_requests', SQLERRM;
END $rls$;

-- Allow the designated fulfiller (sender_user_id) to mark a request fulfilled.
-- Without this the auto-fulfill UPDATE in MegolmKeyBackupService silently fails
-- RLS, so requesters never receive the key. Restricted to the addressed user.
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "megolm_key_requests_fulfill" ON public.megolm_key_requests$ddl$;
  EXECUTE $ddl$CREATE POLICY "megolm_key_requests_fulfill" ON public.megolm_key_requests
    FOR UPDATE USING (sender_user_id = public.get_current_profile_id())
    WITH CHECK (sender_user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"megolm_key_requests_fulfill" ON public.megolm_key_requests', SQLERRM;
END $rls$;

-- Megolm key backups: own only
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "megolm_key_backups_own_only" ON public.megolm_key_backups$ddl$;
  EXECUTE $ddl$CREATE POLICY "megolm_key_backups_own_only" ON public.megolm_key_backups
    FOR ALL USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"megolm_key_backups_own_only" ON public.megolm_key_backups', SQLERRM;
END $rls$;

-- User devices: the OWNER reads their own device rows in full (device-management
-- UI); only the owner may write. Other users get NO direct row access - a
-- blanket authenticated SELECT leaked every account's device label / platform /
-- last_seen_at / trust_state to all clients. Cross-user lookups need only the
-- PUBLIC signing-key material and go through the SECURITY DEFINER
-- get_device_signing_key() RPC below.
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.user_devices ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.user_devices: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_devices_select" ON public.user_devices$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_devices_select_own" ON public.user_devices$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_devices_select_own" ON public.user_devices$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_devices_select_own" ON public.user_devices
    FOR SELECT USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_devices_select_own" ON public.user_devices', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_devices_insert_own" ON public.user_devices$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_devices_insert_own" ON public.user_devices
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_devices_insert_own" ON public.user_devices', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_devices_update_own" ON public.user_devices$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_devices_update_own" ON public.user_devices
    FOR UPDATE USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_devices_update_own" ON public.user_devices', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_devices_delete_own" ON public.user_devices$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_devices_delete_own" ON public.user_devices
    FOR DELETE USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_devices_delete_own" ON public.user_devices', SQLERRM;
END $rls$;

-- Narrow cross-user read for v3 signature verification: returns ONLY a device's
-- public signing key + revoked flag, never the rest of the device row.
CREATE OR REPLACE FUNCTION public.get_device_signing_key(p_user_id uuid, p_device_id text)
RETURNS TABLE (device_signing_public_key text, revoked_at timestamptz)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
    AS $$
    SELECT ud.device_signing_public_key, ud.revoked_at
    FROM public.user_devices ud
    WHERE ud.user_id = p_user_id AND ud.device_id = p_device_id
    LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION public.get_device_signing_key(uuid, text) TO authenticated;

-- Device approval requests: account-scoped. A device may SELECT its account's
-- requests and INSERT its own (raising a "new login" prompt), but it may NOT
-- directly UPDATE a request to 'approved'. Approval/denial flow exclusively
-- through the SECURITY DEFINER RPCs approve_device_request / deny_device_request,
-- which verify the approver is an established device. This closes the
-- self-approval hole where any account session could approve its own login.
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.device_approval_requests ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.device_approval_requests: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "device_approval_requests_own" ON public.device_approval_requests$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "device_approval_requests_select_own" ON public.device_approval_requests$ddl$;
  EXECUTE $ddl$CREATE POLICY "device_approval_requests_select_own" ON public.device_approval_requests
    FOR SELECT USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"device_approval_requests_select_own" ON public.device_approval_requests', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "device_approval_requests_insert_own" ON public.device_approval_requests$ddl$;
  EXECUTE $ddl$CREATE POLICY "device_approval_requests_insert_own" ON public.device_approval_requests
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"device_approval_requests_insert_own" ON public.device_approval_requests', SQLERRM;
END $rls$;

-- Room epoch state: readable by any authenticated client (needed to tag the
-- correct epoch on send/decrypt). Writes happen only via SECURITY DEFINER
-- triggers / RPCs, so no write policy is granted here.
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.room_epoch_state ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.room_epoch_state: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "room_epoch_state_select" ON public.room_epoch_state$ddl$;
  EXECUTE $ddl$CREATE POLICY "room_epoch_state_select" ON public.room_epoch_state
    FOR SELECT USING (auth.role() = 'authenticated' OR auth.role() = 'service_role')$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"room_epoch_state_select" ON public.room_epoch_state', SQLERRM;
END $rls$;

-- Recovery key metadata: own only
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "recovery_key_metadata_own_only" ON public.recovery_key_metadata$ddl$;
  EXECUTE $ddl$CREATE POLICY "recovery_key_metadata_own_only" ON public.recovery_key_metadata
    FOR ALL USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"recovery_key_metadata_own_only" ON public.recovery_key_metadata', SQLERRM;
END $rls$;

-- MFA recovery codes: own only
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "mfa_recovery_codes_own_only" ON public.mfa_recovery_codes$ddl$;
  EXECUTE $ddl$CREATE POLICY "mfa_recovery_codes_own_only" ON public.mfa_recovery_codes
    FOR ALL USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"mfa_recovery_codes_own_only" ON public.mfa_recovery_codes', SQLERRM;
END $rls$;

-- Conversation encryption settings: participants only
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "conversation_encryption_settings_select" ON public.conversation_encryption_settings$ddl$;
  EXECUTE $ddl$CREATE POLICY "conversation_encryption_settings_select" ON public.conversation_encryption_settings
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.conversation_participants cp
            WHERE cp.conversation_id = conversation_encryption_settings.conversation_id
            AND cp.user_id = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"conversation_encryption_settings_select" ON public.conversation_encryption_settings', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "conversation_encryption_settings_modify" ON public.conversation_encryption_settings$ddl$;
  EXECUTE $ddl$CREATE POLICY "conversation_encryption_settings_modify" ON public.conversation_encryption_settings
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.conversation_participants cp
            WHERE cp.conversation_id = conversation_encryption_settings.conversation_id
            AND cp.user_id = public.get_current_profile_id()
            AND cp.left_at IS NULL
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"conversation_encryption_settings_modify" ON public.conversation_encryption_settings', SQLERRM;
END $rls$;

-- Server encryption settings: server owner/admin
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "server_encryption_settings_select" ON public.server_encryption_settings$ddl$;
  EXECUTE $ddl$CREATE POLICY "server_encryption_settings_select" ON public.server_encryption_settings
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.user_servers us
            WHERE us.server_id = server_encryption_settings.server_id
            AND us.user_id = public.get_current_profile_id()
            AND us.status = 'accepted'
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"server_encryption_settings_select" ON public.server_encryption_settings', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "server_encryption_settings_modify" ON public.server_encryption_settings$ddl$;
  EXECUTE $ddl$CREATE POLICY "server_encryption_settings_modify" ON public.server_encryption_settings
    FOR ALL USING (
        EXISTS (
            SELECT 1 FROM public.servers s
            WHERE s.id = server_encryption_settings.server_id
            AND s.owner = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"server_encryption_settings_modify" ON public.server_encryption_settings', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- PERFORMANCE/MONITORING TABLES RLS (Admin only)
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.slow_queries ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.slow_queries: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.federation_health ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.federation_health: %', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.performance_metrics_hourly ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.performance_metrics_hourly: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "slow_queries_admin_only" ON public.slow_queries$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "slow_queries_admin_only" ON public.slow_queries$ddl$;
  EXECUTE $ddl$CREATE POLICY "slow_queries_admin_only" ON public.slow_queries
    FOR ALL USING (public.is_current_user_admin())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"slow_queries_admin_only" ON public.slow_queries', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "federation_health_select_all" ON public.federation_health$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "federation_health_select_all" ON public.federation_health$ddl$;
  EXECUTE $ddl$CREATE POLICY "federation_health_select_all" ON public.federation_health
    FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"federation_health_select_all" ON public.federation_health', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "federation_health_modify_admin" ON public.federation_health$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "federation_health_modify_admin" ON public.federation_health$ddl$;
  EXECUTE $ddl$CREATE POLICY "federation_health_modify_admin" ON public.federation_health
    FOR ALL USING (public.is_current_user_admin())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"federation_health_modify_admin" ON public.federation_health', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "performance_metrics_hourly_select_all" ON public.performance_metrics_hourly$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "performance_metrics_hourly_select_all" ON public.performance_metrics_hourly$ddl$;
  EXECUTE $ddl$CREATE POLICY "performance_metrics_hourly_select_all" ON public.performance_metrics_hourly
    FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"performance_metrics_hourly_select_all" ON public.performance_metrics_hourly', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "performance_metrics_hourly_modify_admin" ON public.performance_metrics_hourly$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "performance_metrics_hourly_modify_admin" ON public.performance_metrics_hourly$ddl$;
  EXECUTE $ddl$CREATE POLICY "performance_metrics_hourly_modify_admin" ON public.performance_metrics_hourly
    FOR ALL USING (public.is_current_user_admin())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"performance_metrics_hourly_modify_admin" ON public.performance_metrics_hourly', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- REMOTE EMOJIS CACHE RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.remote_emojis_cache ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.remote_emojis_cache: %', SQLERRM;
END $rls$;

-- Anyone can view cached remote emojis
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "remote_emojis_cache_select_all" ON public.remote_emojis_cache$ddl$;
  EXECUTE $ddl$CREATE POLICY "remote_emojis_cache_select_all" ON public.remote_emojis_cache
    FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"remote_emojis_cache_select_all" ON public.remote_emojis_cache', SQLERRM;
END $rls$;

-- Only system/admin can modify
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "remote_emojis_cache_admin_modify" ON public.remote_emojis_cache$ddl$;
  EXECUTE $ddl$CREATE POLICY "remote_emojis_cache_admin_modify" ON public.remote_emojis_cache
    FOR ALL USING (public.is_current_user_admin())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"remote_emojis_cache_admin_modify" ON public.remote_emojis_cache', SQLERRM;
END $rls$;

-- Service role (federation backend) can manage remote emojis
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Service role can manage remote emojis" ON public.remote_emojis_cache$ddl$;
  EXECUTE $ddl$CREATE POLICY "Service role can manage remote emojis" ON public.remote_emojis_cache
    USING (auth.role() = 'service_role')$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Service role can manage remote emojis" ON public.remote_emojis_cache', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- NOTIFICATION RATE LIMITS RLS (Admin Only)
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.notification_rate_limits ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.notification_rate_limits: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "notification_rate_limits_admin_only" ON public.notification_rate_limits$ddl$;
  EXECUTE $ddl$CREATE POLICY "notification_rate_limits_admin_only" ON public.notification_rate_limits
    FOR ALL USING (public.is_current_user_admin())
    WITH CHECK (public.is_current_user_admin())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"notification_rate_limits_admin_only" ON public.notification_rate_limits', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- USER VIEW CONTEXTS RLS (Own User Only)
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.user_view_contexts ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.user_view_contexts: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_view_contexts_own_user" ON public.user_view_contexts$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_view_contexts_own_user" ON public.user_view_contexts
    FOR ALL USING (user_id = public.get_current_profile_id())
    WITH CHECK (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_view_contexts_own_user" ON public.user_view_contexts', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- MESSAGE SEARCH INDEX RLS (Based on Channel/Conversation Access)
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.message_search_index ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.message_search_index: %', SQLERRM;
END $rls$;

-- Users can search messages in channels they have access to
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "message_search_index_channel_access" ON public.message_search_index$ddl$;
  EXECUTE $ddl$CREATE POLICY "message_search_index_channel_access" ON public.message_search_index
    FOR SELECT USING (
        channel_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.channels c
            JOIN public.user_servers us ON us.server_id = c.server_id
            WHERE c.id = message_search_index.channel_id
            AND us.user_id = public.get_current_profile_id()
            AND us.status = 'accepted'
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"message_search_index_channel_access" ON public.message_search_index', SQLERRM;
END $rls$;

-- Users can search messages in conversations they are part of
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "message_search_index_conversation_access" ON public.message_search_index$ddl$;
  EXECUTE $ddl$CREATE POLICY "message_search_index_conversation_access" ON public.message_search_index
    FOR SELECT USING (
        conversation_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.conversation_participants cp
            WHERE cp.conversation_id = message_search_index.conversation_id
            AND cp.user_id = public.get_current_profile_id()
            AND cp.left_at IS NULL
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"message_search_index_conversation_access" ON public.message_search_index', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- ENCRYPTION SESSIONS RLS (Own User Only)
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.encryption_sessions ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.encryption_sessions: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "encryption_sessions_own_user" ON public.encryption_sessions$ddl$;
  EXECUTE $ddl$CREATE POLICY "encryption_sessions_own_user" ON public.encryption_sessions
    FOR ALL USING (
        local_user_id = public.get_current_profile_id()
        OR remote_user_id = public.get_current_profile_id()
    )
    WITH CHECK (local_user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"encryption_sessions_own_user" ON public.encryption_sessions', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- ENCRYPTION AUDIT LOG RLS (Own User + Admin)
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.encryption_audit_log ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.encryption_audit_log: %', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "encryption_audit_log_own_or_admin" ON public.encryption_audit_log$ddl$;
  EXECUTE $ddl$CREATE POLICY "encryption_audit_log_own_or_admin" ON public.encryption_audit_log
    FOR SELECT USING (
        user_id = public.get_current_profile_id()
        OR public.is_current_user_admin()
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"encryption_audit_log_own_or_admin" ON public.encryption_audit_log', SQLERRM;
END $rls$;

-- Only system can insert (via SECURITY DEFINER functions)
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "encryption_audit_log_insert_system" ON public.encryption_audit_log$ddl$;
  EXECUTE $ddl$CREATE POLICY "encryption_audit_log_insert_system" ON public.encryption_audit_log
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"encryption_audit_log_insert_system" ON public.encryption_audit_log', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- USER LISTS RLS
-- Note: Using DROP IF EXISTS for robustness (handles reruns, migration conflicts)
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.user_lists ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.user_lists: %', SQLERRM;
END $rls$;

-- Users can view their own lists
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_lists_own_select" ON public.user_lists$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_lists_own_select" ON public.user_lists$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_lists_own_select" ON public.user_lists
    FOR SELECT USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_lists_own_select" ON public.user_lists', SQLERRM;
END $rls$;

-- Users can view public lists from others
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_lists_public_select" ON public.user_lists$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_lists_public_select" ON public.user_lists$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_lists_public_select" ON public.user_lists
    FOR SELECT USING (is_public = true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_lists_public_select" ON public.user_lists', SQLERRM;
END $rls$;

-- Users can only create their own lists
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_lists_insert" ON public.user_lists$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_lists_insert" ON public.user_lists$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_lists_insert" ON public.user_lists
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_lists_insert" ON public.user_lists', SQLERRM;
END $rls$;

-- Users can only update their own lists
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_lists_update" ON public.user_lists$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_lists_update" ON public.user_lists$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_lists_update" ON public.user_lists
    FOR UPDATE USING (user_id = public.get_current_profile_id())
    WITH CHECK (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_lists_update" ON public.user_lists', SQLERRM;
END $rls$;

-- Users can only delete their own lists
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_lists_delete" ON public.user_lists$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_lists_delete" ON public.user_lists$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_lists_delete" ON public.user_lists
    FOR DELETE USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_lists_delete" ON public.user_lists', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- USER LIST MEMBERS RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$ALTER TABLE public.user_list_members ENABLE ROW LEVEL SECURITY$ddl$;
EXCEPTION WHEN undefined_table THEN
  RAISE NOTICE 'rls-resync skipped ENABLE RLS on public.user_list_members: %', SQLERRM;
END $rls$;

-- Users can view members of their own lists
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_list_members_own_list" ON public.user_list_members$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_list_members_own_list" ON public.user_list_members$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_list_members_own_list" ON public.user_list_members
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.user_lists ul
            WHERE ul.id = user_list_members.list_id
            AND ul.user_id = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_list_members_own_list" ON public.user_list_members', SQLERRM;
END $rls$;

-- Users can view members of public lists
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_list_members_public_list" ON public.user_list_members$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_list_members_public_list" ON public.user_list_members$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_list_members_public_list" ON public.user_list_members
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.user_lists ul
            WHERE ul.id = user_list_members.list_id
            AND ul.is_public = true
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_list_members_public_list" ON public.user_list_members', SQLERRM;
END $rls$;

-- Users can add members to their own lists
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_list_members_insert" ON public.user_list_members$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_list_members_insert" ON public.user_list_members$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_list_members_insert" ON public.user_list_members
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.user_lists ul
            WHERE ul.id = user_list_members.list_id
            AND ul.user_id = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_list_members_insert" ON public.user_list_members', SQLERRM;
END $rls$;

-- Users can remove members from their own lists
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_list_members_delete" ON public.user_list_members$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "user_list_members_delete" ON public.user_list_members$ddl$;
  EXECUTE $ddl$CREATE POLICY "user_list_members_delete" ON public.user_list_members
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM public.user_lists ul
            WHERE ul.id = user_list_members.list_id
            AND ul.user_id = public.get_current_profile_id()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"user_list_members_delete" ON public.user_list_members', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- REPORTS RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can create reports" ON public.reports$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can create reports" ON public.reports$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can create reports" ON public.reports
    FOR INSERT TO authenticated
    WITH CHECK (reporter_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can create reports" ON public.reports', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can view own reports" ON public.reports$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can view own reports" ON public.reports$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can view own reports" ON public.reports
    FOR SELECT TO authenticated
    USING (reporter_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can view own reports" ON public.reports', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Admins can view all reports" ON public.reports$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Admins can view all reports" ON public.reports$ddl$;
  EXECUTE $ddl$CREATE POLICY "Admins can view all reports" ON public.reports
    FOR SELECT TO authenticated
    USING (public.is_current_user_admin())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Admins can view all reports" ON public.reports', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Admins can update reports" ON public.reports$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Admins can update reports" ON public.reports$ddl$;
  EXECUTE $ddl$CREATE POLICY "Admins can update reports" ON public.reports
    FOR UPDATE TO authenticated
    USING (public.is_current_user_admin())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Admins can update reports" ON public.reports', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- INSTANCE FUNDING RLS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "funding_select_all" ON public.instance_funding$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "funding_select_all" ON public.instance_funding$ddl$;
  EXECUTE $ddl$CREATE POLICY "funding_select_all" ON public.instance_funding
    FOR SELECT TO authenticated USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"funding_select_all" ON public.instance_funding', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "funding_modify_admin" ON public.instance_funding$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "funding_modify_admin" ON public.instance_funding$ddl$;
  EXECUTE $ddl$CREATE POLICY "funding_modify_admin" ON public.instance_funding
    FOR ALL TO authenticated USING (public.is_current_user_admin())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"funding_modify_admin" ON public.instance_funding', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "tiers_select_all" ON public.instance_supporter_tiers$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "tiers_select_all" ON public.instance_supporter_tiers$ddl$;
  EXECUTE $ddl$CREATE POLICY "tiers_select_all" ON public.instance_supporter_tiers
    FOR SELECT TO authenticated USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"tiers_select_all" ON public.instance_supporter_tiers', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "tiers_modify_admin" ON public.instance_supporter_tiers$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "tiers_modify_admin" ON public.instance_supporter_tiers$ddl$;
  EXECUTE $ddl$CREATE POLICY "tiers_modify_admin" ON public.instance_supporter_tiers
    FOR ALL TO authenticated USING (public.is_current_user_admin())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"tiers_modify_admin" ON public.instance_supporter_tiers', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "supporters_select_all" ON public.instance_supporters$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "supporters_select_all" ON public.instance_supporters$ddl$;
  EXECUTE $ddl$CREATE POLICY "supporters_select_all" ON public.instance_supporters
    FOR SELECT TO authenticated USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"supporters_select_all" ON public.instance_supporters', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "supporters_modify_admin" ON public.instance_supporters$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "supporters_modify_admin" ON public.instance_supporters$ddl$;
  EXECUTE $ddl$CREATE POLICY "supporters_modify_admin" ON public.instance_supporters
    FOR ALL TO authenticated USING (public.is_current_user_admin())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"supporters_modify_admin" ON public.instance_supporters', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "donation_history_select_admin" ON public.instance_donation_history$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "donation_history_select_admin" ON public.instance_donation_history$ddl$;
  EXECUTE $ddl$CREATE POLICY "donation_history_select_admin" ON public.instance_donation_history
    FOR SELECT TO authenticated USING (
        public.is_current_user_admin()
        OR user_id = public.get_current_profile_id()
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"donation_history_select_admin" ON public.instance_donation_history', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "donation_history_modify_admin" ON public.instance_donation_history$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "donation_history_modify_admin" ON public.instance_donation_history$ddl$;
  EXECUTE $ddl$CREATE POLICY "donation_history_modify_admin" ON public.instance_donation_history
    FOR ALL TO authenticated USING (public.is_current_user_admin())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"donation_history_modify_admin" ON public.instance_donation_history', SQLERRM;
END $rls$;

-- Pending donations: admin-only (webhooks insert via service_role bypass).
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "pending_donations_admin_all" ON public.instance_pending_donations$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "pending_donations_admin_all" ON public.instance_pending_donations$ddl$;
  EXECUTE $ddl$CREATE POLICY "pending_donations_admin_all" ON public.instance_pending_donations
    FOR ALL TO authenticated USING (public.is_current_user_admin())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"pending_donations_admin_all" ON public.instance_pending_donations', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- AP ACTIVITIES (ActivityPub activity log)
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "System can manage ActivityPub activities" ON public.ap_activities$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "System can manage ActivityPub activities" ON public.ap_activities$ddl$;
  EXECUTE $ddl$CREATE POLICY "System can manage ActivityPub activities" ON public.ap_activities
    TO service_role USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"System can manage ActivityPub activities" ON public.ap_activities', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can view their own activities" ON public.ap_activities$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can view their own activities" ON public.ap_activities$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can view their own activities" ON public.ap_activities
    FOR SELECT USING (actor_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can view their own activities" ON public.ap_activities', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can create their own activities" ON public.ap_activities$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can create their own activities" ON public.ap_activities$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can create their own activities" ON public.ap_activities
    FOR INSERT WITH CHECK (actor_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can create their own activities" ON public.ap_activities', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can update their own activities" ON public.ap_activities$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can update their own activities" ON public.ap_activities$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can update their own activities" ON public.ap_activities
    FOR UPDATE USING (actor_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can update their own activities" ON public.ap_activities', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- AP ACTOR CACHE
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Service role can manage actor cache" ON public.ap_actor_cache$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Service role can manage actor cache" ON public.ap_actor_cache$ddl$;
  EXECUTE $ddl$CREATE POLICY "Service role can manage actor cache" ON public.ap_actor_cache
    USING (auth.role() = 'service_role')$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Service role can manage actor cache" ON public.ap_actor_cache', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- AP OBJECT CACHE
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Service role can manage object cache" ON public.ap_object_cache$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Service role can manage object cache" ON public.ap_object_cache$ddl$;
  EXECUTE $ddl$CREATE POLICY "Service role can manage object cache" ON public.ap_object_cache
    USING (auth.role() = 'service_role')$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Service role can manage object cache" ON public.ap_object_cache', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- ADMIN AUDIT LOG
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Admin audit log admin access" ON public.admin_audit_log$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Admin audit log admin access" ON public.admin_audit_log$ddl$;
  EXECUTE $ddl$CREATE POLICY "Admin audit log admin access" ON public.admin_audit_log
    TO authenticated USING (public.is_current_user_admin())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Admin audit log admin access" ON public.admin_audit_log', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- BLOCKED INSTANCES
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Blocked instances admin access" ON public.blocked_instances$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Blocked instances admin access" ON public.blocked_instances$ddl$;
  EXECUTE $ddl$CREATE POLICY "Blocked instances admin access" ON public.blocked_instances
    TO authenticated USING (public.is_current_user_admin())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Blocked instances admin access" ON public.blocked_instances', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- BOTS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Public bots are viewable by everyone" ON public.bots$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Public bots are viewable by everyone" ON public.bots$ddl$;
  EXECUTE $ddl$CREATE POLICY "Public bots are viewable by everyone" ON public.bots
    FOR SELECT USING (
        is_public = true OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = bots.owner_id AND profiles.auth_user_id = auth.uid()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Public bots are viewable by everyone" ON public.bots', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Bot owners can manage bots" ON public.bots$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Bot owners can manage bots" ON public.bots$ddl$;
  EXECUTE $ddl$CREATE POLICY "Bot owners can manage bots" ON public.bots
    USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = bots.owner_id AND profiles.auth_user_id = auth.uid())
    )
    WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = bots.owner_id AND profiles.auth_user_id = auth.uid())
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Bot owners can manage bots" ON public.bots', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- BOT TOKENS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Bot owners can manage tokens" ON public.bot_tokens$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Bot owners can manage tokens" ON public.bot_tokens$ddl$;
  EXECUTE $ddl$CREATE POLICY "Bot owners can manage tokens" ON public.bot_tokens
    USING (
        EXISTS (
            SELECT 1 FROM public.bots
            JOIN public.profiles ON profiles.id = bots.owner_id
            WHERE bots.id = bot_tokens.bot_id AND profiles.auth_user_id = auth.uid()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Bot owners can manage tokens" ON public.bot_tokens', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- BOT SERVER PERMISSIONS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Server members can view bot permissions" ON public.bot_server_permissions$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Server members can view bot permissions" ON public.bot_server_permissions$ddl$;
  EXECUTE $ddl$CREATE POLICY "Server members can view bot permissions" ON public.bot_server_permissions
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.user_servers
            JOIN public.profiles ON profiles.id = user_servers.user_id
            WHERE user_servers.server_id = bot_server_permissions.server_id AND profiles.auth_user_id = auth.uid()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Server members can view bot permissions" ON public.bot_server_permissions', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Server owners can manage bot permissions" ON public.bot_server_permissions$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Server owners can manage bot permissions" ON public.bot_server_permissions$ddl$;
  EXECUTE $ddl$CREATE POLICY "Server owners can manage bot permissions" ON public.bot_server_permissions
    USING (
        EXISTS (
            SELECT 1 FROM public.servers
            JOIN public.profiles ON profiles.id = servers.owner
            WHERE servers.id = bot_server_permissions.server_id AND profiles.auth_user_id = auth.uid()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Server owners can manage bot permissions" ON public.bot_server_permissions', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- EMOJI USAGE
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emoji_usage_access_policy" ON public.emoji_usage$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "emoji_usage_access_policy" ON public.emoji_usage$ddl$;
  EXECUTE $ddl$CREATE POLICY "emoji_usage_access_policy" ON public.emoji_usage
    TO authenticated USING (
        server_id IN (SELECT us.server_id FROM public.user_servers us WHERE us.user_id = public.get_current_profile_id())
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"emoji_usage_access_policy" ON public.emoji_usage', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- FEDERATION DELIVERY QUEUE
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Service role can manage delivery queue" ON public.federation_delivery_queue$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Service role can manage delivery queue" ON public.federation_delivery_queue$ddl$;
  EXECUTE $ddl$CREATE POLICY "Service role can manage delivery queue" ON public.federation_delivery_queue
    USING (auth.role() = 'service_role')$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Service role can manage delivery queue" ON public.federation_delivery_queue', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Service role can manage federation queue" ON public.federation_delivery_queue$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Service role can manage federation queue" ON public.federation_delivery_queue$ddl$;
  EXECUTE $ddl$CREATE POLICY "Service role can manage federation queue" ON public.federation_delivery_queue
    TO service_role USING (true) WITH CHECK (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Service role can manage federation queue" ON public.federation_delivery_queue', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can view federation delivery queue" ON public.federation_delivery_queue$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can view federation delivery queue" ON public.federation_delivery_queue$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can view federation delivery queue" ON public.federation_delivery_queue
    FOR SELECT TO authenticated USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can view federation delivery queue" ON public.federation_delivery_queue', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Admins can delete federation deliveries" ON public.federation_delivery_queue$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Admins can delete federation deliveries" ON public.federation_delivery_queue$ddl$;
  EXECUTE $ddl$CREATE POLICY "Admins can delete federation deliveries" ON public.federation_delivery_queue
    FOR DELETE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = public.get_current_profile_id()
            AND is_admin = true
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Admins can delete federation deliveries" ON public.federation_delivery_queue', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- FEDERATED VOICE CALLS (schema varies: init vs production)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'federated_voice_calls' AND column_name = 'caller_id'
    ) THEN
        EXECUTE 'DROP POLICY IF EXISTS "System can insert calls" ON public.federated_voice_calls';
        EXECUTE 'CREATE POLICY "System can insert calls" ON public.federated_voice_calls FOR INSERT WITH CHECK (true)';

        EXECUTE 'DROP POLICY IF EXISTS "Recipients can update call status" ON public.federated_voice_calls';
        EXECUTE 'CREATE POLICY "Recipients can update call status" ON public.federated_voice_calls FOR UPDATE USING (public.get_current_profile_id() = recipient_id) WITH CHECK (public.get_current_profile_id() = recipient_id)';

        EXECUTE 'DROP POLICY IF EXISTS "Update own calls" ON public.federated_voice_calls';
        EXECUTE 'CREATE POLICY "Update own calls" ON public.federated_voice_calls FOR UPDATE USING (caller_id = public.get_current_profile_id() OR recipient_id = public.get_current_profile_id())';

        EXECUTE 'DROP POLICY IF EXISTS "Service role full access on calls" ON public.federated_voice_calls';
        EXECUTE 'CREATE POLICY "Service role full access on calls" ON public.federated_voice_calls TO service_role USING (true) WITH CHECK (true)';
    ELSE
        RAISE NOTICE 'federated_voice_calls: caller_id column not found, skipping user-level policies';
        EXECUTE 'DROP POLICY IF EXISTS "Service role full access on calls" ON public.federated_voice_calls';
        EXECUTE 'CREATE POLICY "Service role full access on calls" ON public.federated_voice_calls TO service_role USING (true) WITH CHECK (true)';
    END IF;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'federated_voice_calls table does not exist, skipping';
END $$;

-- ---------------------------------------------------------------------------
-- GIF FAVORITES
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can view own gif favorites" ON public.gif_favorites$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can view own gif favorites" ON public.gif_favorites$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can view own gif favorites" ON public.gif_favorites
    FOR SELECT USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can view own gif favorites" ON public.gif_favorites', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can insert own gif favorites" ON public.gif_favorites$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can insert own gif favorites" ON public.gif_favorites$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can insert own gif favorites" ON public.gif_favorites
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can insert own gif favorites" ON public.gif_favorites', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can delete own gif favorites" ON public.gif_favorites$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can delete own gif favorites" ON public.gif_favorites$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can delete own gif favorites" ON public.gif_favorites
    FOR DELETE USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can delete own gif favorites" ON public.gif_favorites', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- EMOJI FAVORITES
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can view own emoji favorites" ON public.emoji_favorites$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can view own emoji favorites" ON public.emoji_favorites$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can view own emoji favorites" ON public.emoji_favorites
    FOR SELECT USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can view own emoji favorites" ON public.emoji_favorites', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can insert own emoji favorites" ON public.emoji_favorites$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can insert own emoji favorites" ON public.emoji_favorites$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can insert own emoji favorites" ON public.emoji_favorites
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can insert own emoji favorites" ON public.emoji_favorites', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can delete own emoji favorites" ON public.emoji_favorites$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can delete own emoji favorites" ON public.emoji_favorites$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can delete own emoji favorites" ON public.emoji_favorites
    FOR DELETE USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can delete own emoji favorites" ON public.emoji_favorites', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- PERFORMANCE METRICS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Admins can read metrics" ON public.performance_metrics$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Admins can read metrics" ON public.performance_metrics$ddl$;
  EXECUTE $ddl$CREATE POLICY "Admins can read metrics" ON public.performance_metrics
    FOR SELECT USING (public.is_current_user_admin())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Admins can read metrics" ON public.performance_metrics', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- POST HASHTAGS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Anyone can view post hashtags" ON public.post_hashtags$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Anyone can view post hashtags" ON public.post_hashtags$ddl$;
  EXECUTE $ddl$CREATE POLICY "Anyone can view post hashtags" ON public.post_hashtags
    FOR SELECT USING (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Anyone can view post hashtags" ON public.post_hashtags', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Only system can modify post hashtags" ON public.post_hashtags$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Only system can modify post hashtags" ON public.post_hashtags$ddl$;
  EXECUTE $ddl$CREATE POLICY "Only system can modify post hashtags" ON public.post_hashtags
    USING (false) WITH CHECK (false)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Only system can modify post hashtags" ON public.post_hashtags', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- PREKEYS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can insert their own prekeys" ON public.prekeys$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can insert their own prekeys" ON public.prekeys$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can insert their own prekeys" ON public.prekeys
    FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = prekeys.user_id AND profiles.auth_user_id = auth.uid())
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can insert their own prekeys" ON public.prekeys', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can update their own prekeys" ON public.prekeys$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can update their own prekeys" ON public.prekeys$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can update their own prekeys" ON public.prekeys
    FOR UPDATE USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = prekeys.user_id AND profiles.auth_user_id = auth.uid())
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can update their own prekeys" ON public.prekeys', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can view others' unused public prekeys" ON public.prekeys$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'prekeys' AND column_name = 'is_used'
    ) THEN
        EXECUTE 'CREATE POLICY "Users can view others'' unused public prekeys" ON public.prekeys FOR SELECT USING (is_used = false)';
    ELSE
        EXECUTE 'CREATE POLICY "Users can view others'' unused public prekeys" ON public.prekeys FOR SELECT USING (used_at IS NULL)';
    END IF;
END $$;

-- ---------------------------------------------------------------------------
-- PUSH SUBSCRIPTIONS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Service role can manage all push subscriptions" ON public.push_subscriptions$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Service role can manage all push subscriptions" ON public.push_subscriptions$ddl$;
  EXECUTE $ddl$CREATE POLICY "Service role can manage all push subscriptions" ON public.push_subscriptions
    TO service_role USING (true) WITH CHECK (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Service role can manage all push subscriptions" ON public.push_subscriptions', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- SERVER FEDERATION EVENTS (init schema has no user_id column)
-- ---------------------------------------------------------------------------
DO $$ BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'server_federation_events' AND column_name = 'user_id'
    ) THEN
        EXECUTE 'DROP POLICY IF EXISTS "Users can create their own server events" ON public.server_federation_events';
        EXECUTE 'CREATE POLICY "Users can create their own server events" ON public.server_federation_events FOR INSERT WITH CHECK (user_id = public.get_current_profile_id())';

        EXECUTE 'DROP POLICY IF EXISTS "Users can view server events they''re involved in" ON public.server_federation_events';
        EXECUTE 'CREATE POLICY "Users can view server events they''re involved in" ON public.server_federation_events FOR SELECT USING (user_id = public.get_current_profile_id())';
    ELSE
        EXECUTE 'DROP POLICY IF EXISTS "Authenticated users can manage server events" ON public.server_federation_events';
        -- Writes go through SECURITY DEFINER paths / the federation worker
        -- (service_role). The old USING(true) WITH CHECK(true) policy let any
        -- authenticated user read/modify the entire federation event queue.
        EXECUTE 'DROP POLICY IF EXISTS "Service role can manage server events" ON public.server_federation_events';
        EXECUTE 'CREATE POLICY "Service role can manage server events" ON public.server_federation_events TO service_role USING (true) WITH CHECK (true)';
    END IF;
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'server_federation_events table does not exist, skipping';
END $$;

-- ---------------------------------------------------------------------------
-- SERVER MEMBERSHIP EVENTS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Members can view server membership events" ON public.server_membership_events$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Members can view server membership events" ON public.server_membership_events$ddl$;
  EXECUTE $ddl$CREATE POLICY "Members can view server membership events" ON public.server_membership_events
    FOR SELECT TO authenticated USING (
        server_id IN (SELECT us.server_id FROM public.user_servers us WHERE us.user_id = public.get_current_profile_id())
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Members can view server membership events" ON public.server_membership_events', SQLERRM;
END $rls$;

-- No authenticated INSERT policy: every writer is SECURITY DEFINER
-- (route_server_membership / route_server_leave triggers; kick/ban/unban RPCs)
-- and bypasses RLS. An authenticated WITH CHECK (true) policy here would only
-- let users forge membership events, so it is intentionally absent.
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "System can insert membership events" ON public.server_membership_events$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;

-- ---------------------------------------------------------------------------
-- TIMELINE ENTRIES
-- ---------------------------------------------------------------------------
-- Timeline rows are written exclusively by SECURITY DEFINER fan-out triggers
-- (create_comprehensive_timeline_entries / broadcast_home_feed_entry), which
-- bypass RLS. Clients may only READ their OWN timeline; the previous
-- USING(true) WITH CHECK(true) let any user read/insert/delete anyone's feed.
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "System can manage all timeline entries" ON public.timeline_entries$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "timeline_entries_select_own" ON public.timeline_entries$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "timeline_entries_select_own" ON public.timeline_entries$ddl$;
  EXECUTE $ddl$CREATE POLICY "timeline_entries_select_own" ON public.timeline_entries
    FOR SELECT USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"timeline_entries_select_own" ON public.timeline_entries', SQLERRM;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "timeline_entries_service_write" ON public.timeline_entries$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "timeline_entries_service_write" ON public.timeline_entries$ddl$;
  EXECUTE $ddl$CREATE POLICY "timeline_entries_service_write" ON public.timeline_entries
    FOR ALL TO service_role USING (true) WITH CHECK (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"timeline_entries_service_write" ON public.timeline_entries', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- UNREAD COUNTS
-- ---------------------------------------------------------------------------
-- Clients (authenticated) may only read/clear their OWN unread rows. The rows are
-- populated by SECURITY DEFINER triggers/RPCs (which bypass RLS) and service_role
-- (which bypasses RLS), so scoping the client policy to the caller's profile id does
-- not affect server-side writes. unread_counts.user_id is a profiles.id.
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "System can manage unread counts" ON public.unread_counts$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "unread_counts_select_own" ON public.unread_counts$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "unread_counts_select_own" ON public.unread_counts$ddl$;
  EXECUTE $ddl$CREATE POLICY "unread_counts_select_own" ON public.unread_counts
    FOR SELECT TO authenticated
    USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"unread_counts_select_own" ON public.unread_counts', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "unread_counts_update_own" ON public.unread_counts$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "unread_counts_update_own" ON public.unread_counts$ddl$;
  EXECUTE $ddl$CREATE POLICY "unread_counts_update_own" ON public.unread_counts
    FOR UPDATE TO authenticated
    USING (user_id = public.get_current_profile_id())
    WITH CHECK (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"unread_counts_update_own" ON public.unread_counts', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- USER KEY PAIRS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can insert their own key pairs" ON public.user_key_pairs$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can insert their own key pairs" ON public.user_key_pairs$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can insert their own key pairs" ON public.user_key_pairs
    FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = user_key_pairs.user_id AND profiles.auth_user_id = auth.uid())
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can insert their own key pairs" ON public.user_key_pairs', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can update their own key pairs" ON public.user_key_pairs$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can update their own key pairs" ON public.user_key_pairs$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can update their own key pairs" ON public.user_key_pairs
    FOR UPDATE USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE profiles.id = user_key_pairs.user_id AND profiles.auth_user_id = auth.uid())
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can update their own key pairs" ON public.user_key_pairs', SQLERRM;
END $rls$;

-- RLS is row-level, not column-level: a row-wide public SELECT would expose
-- every user's `identity_private_key_encrypted` / signing private columns to
-- all authenticated clients via PostgREST. We split SELECT into:
--   (a) owner can read their FULL row (private columns included)
--   (b) everyone authenticated can read rows, BUT a column-level GRANT below
--       restricts the projection to PUBLIC columns only.
-- The owner fetches their own encrypted private columns through the
-- SECURITY DEFINER RPC get_my_key_pair() (defined below), not via direct SELECT.
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can view others' public keys for encryption" ON public.user_key_pairs$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can view own key pair (full row)" ON public.user_key_pairs$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can view own key pair (full row)" ON public.user_key_pairs$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can view own key pair (full row)" ON public.user_key_pairs
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = user_key_pairs.user_id
              AND profiles.auth_user_id = auth.uid()
        )
    )$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can view own key pair (full row)" ON public.user_key_pairs', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can view active public key columns" ON public.user_key_pairs$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can view active public key columns" ON public.user_key_pairs$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can view active public key columns" ON public.user_key_pairs
    FOR SELECT USING (is_active = true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can view active public key columns" ON public.user_key_pairs', SQLERRM;
END $rls$;

-- Replace the broad row GRANT with a PUBLIC-COLUMNS-ONLY grant.
REVOKE SELECT ON public.user_key_pairs FROM authenticated;
REVOKE SELECT ON public.user_key_pairs FROM anon;
GRANT SELECT (
    id, user_id, device_id, identity_public_key, identity_signing_public_key,
    key_version, is_active, created_at, last_used_at, expires_at, metadata
) ON public.user_key_pairs TO authenticated;

-- Owner-only access to the encrypted PRIVATE columns (used during local unlock).
CREATE OR REPLACE FUNCTION public.get_my_key_pair()
RETURNS TABLE (
    id uuid, user_id uuid, device_id text,
    identity_public_key text, identity_private_key_encrypted text,
    identity_signing_public_key text, identity_signing_private_key_encrypted text,
    key_version integer, is_active boolean, created_at timestamptz,
    last_used_at timestamptz, expires_at timestamptz, metadata jsonb
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT ukp.id, ukp.user_id, ukp.device_id,
           ukp.identity_public_key, ukp.identity_private_key_encrypted,
           ukp.identity_signing_public_key, ukp.identity_signing_private_key_encrypted,
           ukp.key_version, ukp.is_active, ukp.created_at,
           ukp.last_used_at, ukp.expires_at, ukp.metadata
    FROM public.user_key_pairs ukp
    JOIN public.profiles p ON p.id = ukp.user_id
    WHERE p.auth_user_id = auth.uid()
      AND ukp.is_active = true
    ORDER BY ukp.created_at DESC
    LIMIT 1;
$$;

GRANT EXECUTE ON FUNCTION public.get_my_key_pair() TO authenticated;

-- ---------------------------------------------------------------------------
-- USER SESSIONS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Service role can manage all sessions" ON public.user_sessions$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Service role can manage all sessions" ON public.user_sessions$ddl$;
  EXECUTE $ddl$CREATE POLICY "Service role can manage all sessions" ON public.user_sessions
    TO service_role USING (true) WITH CHECK (true)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Service role can manage all sessions" ON public.user_sessions', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can view own sessions" ON public.user_sessions$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can view own sessions" ON public.user_sessions$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can view own sessions" ON public.user_sessions
    FOR SELECT USING (public.get_current_profile_id() = user_id)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can view own sessions" ON public.user_sessions', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can insert own sessions" ON public.user_sessions$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can insert own sessions" ON public.user_sessions$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can insert own sessions" ON public.user_sessions
    FOR INSERT WITH CHECK (public.get_current_profile_id() = user_id)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can insert own sessions" ON public.user_sessions', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can update own sessions" ON public.user_sessions$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can update own sessions" ON public.user_sessions$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can update own sessions" ON public.user_sessions
    FOR UPDATE USING (public.get_current_profile_id() = user_id)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can update own sessions" ON public.user_sessions', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can delete own sessions" ON public.user_sessions$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can delete own sessions" ON public.user_sessions$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can delete own sessions" ON public.user_sessions
    FOR DELETE USING (public.get_current_profile_id() = user_id)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can delete own sessions" ON public.user_sessions', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- USER TIMELINE CACHE
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can access own timeline cache" ON public.user_timeline_cache$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can access own timeline cache" ON public.user_timeline_cache$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can access own timeline cache" ON public.user_timeline_cache
    USING (public.get_current_profile_id() = user_id)$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can access own timeline cache" ON public.user_timeline_cache', SQLERRM;
END $rls$;

-- ---------------------------------------------------------------------------
-- VOICE FEDERATION EVENTS
-- ---------------------------------------------------------------------------
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can create their own voice events" ON public.voice_federation_events$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can create their own voice events" ON public.voice_federation_events$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can create their own voice events" ON public.voice_federation_events
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can create their own voice events" ON public.voice_federation_events', SQLERRM;
END $rls$;

DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can view voice events they're involved in" ON public.voice_federation_events$ddl$;
EXCEPTION WHEN undefined_table OR undefined_object THEN NULL;
END $rls$;
DO $rls$ BEGIN
  EXECUTE $ddl$DROP POLICY IF EXISTS "Users can view voice events they're involved in" ON public.voice_federation_events$ddl$;
  EXECUTE $ddl$CREATE POLICY "Users can view voice events they're involved in" ON public.voice_federation_events
    FOR SELECT USING (user_id = public.get_current_profile_id())$ddl$;
EXCEPTION WHEN undefined_table OR undefined_column OR undefined_object OR undefined_function THEN
  RAISE NOTICE 'rls-resync skipped policy %: %', '"Users can view voice events they''re involved in" ON public.voice_federation_events', SQLERRM;
END $rls$;

DO $$
BEGIN
    RAISE NOTICE 'Extended RLS policies created successfully';
END $$;


NOTIFY pgrst, 'reload schema';
