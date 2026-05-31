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
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "profiles_select_all" ON public.profiles
    FOR SELECT USING (true);

CREATE POLICY "profiles_insert_own" ON public.profiles
    FOR INSERT WITH CHECK (auth_user_id = auth.uid());

CREATE POLICY "profiles_update_own" ON public.profiles
    FOR UPDATE USING (auth_user_id = auth.uid());

CREATE POLICY "profiles_delete_own" ON public.profiles
    FOR DELETE USING (auth_user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- POSTS RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

-- Public posts are visible to everyone, followers-only to followers
-- Also prevents blocked users from seeing posts from users who blocked them
CREATE POLICY "posts_select_public" ON public.posts
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
    );

CREATE POLICY "posts_insert_own" ON public.posts
    FOR INSERT WITH CHECK (author_id = public.get_current_profile_id());

CREATE POLICY "posts_update_own" ON public.posts
    FOR UPDATE USING (author_id = public.get_current_profile_id());

CREATE POLICY "posts_delete_own" ON public.posts
    FOR DELETE USING (author_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- FOLLOWS RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;

CREATE POLICY "follows_select_all" ON public.follows
    FOR SELECT USING (true);

CREATE POLICY "follows_insert_own" ON public.follows
    FOR INSERT WITH CHECK (follower_id = public.get_current_profile_id());

CREATE POLICY "follows_update_involved" ON public.follows
    FOR UPDATE USING (
        follower_id = public.get_current_profile_id()
        OR following_id = public.get_current_profile_id()
    );

CREATE POLICY "follows_delete_own" ON public.follows
    FOR DELETE USING (follower_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- POST INTERACTIONS RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.post_interactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "post_interactions_select_all" ON public.post_interactions
    FOR SELECT USING (true);

-- Prevent reactions on posts from users who blocked you
CREATE POLICY "post_interactions_insert_own" ON public.post_interactions
    FOR INSERT WITH CHECK (
        user_id = public.get_current_profile_id()
        AND NOT public.is_blocked_by((SELECT author_id FROM public.posts WHERE id = post_interactions.post_id))
    );

CREATE POLICY "post_interactions_delete_own" ON public.post_interactions
    FOR DELETE USING (user_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- SERVERS RLS
-- ---------------------------------------------------------------------------
-- Note: servers.owner references profiles.id, not auth.uid() directly.
-- Update/delete policies must join through profiles to verify ownership.
ALTER TABLE public.servers ENABLE ROW LEVEL SECURITY;

-- Allow all users to read servers (visibility is handled at app level)
CREATE POLICY "Enable read access for all users" ON public.servers
    FOR SELECT USING (true);

-- Allow authenticated users to create servers
CREATE POLICY "Enable insert for authenticated users only" ON public.servers
    FOR INSERT TO authenticated WITH CHECK (true);

-- Allow server owners to update their servers (join through profiles)
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

-- Allow server owners to delete their servers
CREATE POLICY "Server owners can delete their servers" ON public.servers
    FOR DELETE TO authenticated 
    USING (EXISTS (
        SELECT 1 FROM public.profiles 
        WHERE profiles.id = servers.owner 
        AND profiles.auth_user_id = auth.uid()
    ));

-- ---------------------------------------------------------------------------
-- CHANNEL CATEGORIES RLS
-- ---------------------------------------------------------------------------
-- Note: 98_enable_rls.sql already enables RLS on this table.
-- Categories are not sensitive - allow all authenticated users to read.

DROP POLICY IF EXISTS "channel_categories_select" ON public.channel_categories;
CREATE POLICY "channel_categories_select" ON public.channel_categories
    FOR SELECT USING (true);

DROP POLICY IF EXISTS "channel_categories_insert" ON public.channel_categories;
CREATE POLICY "channel_categories_insert" ON public.channel_categories
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.servers
            WHERE id = channel_categories.server_id
            AND owner = public.get_current_profile_id()
        )
    );

DROP POLICY IF EXISTS "channel_categories_update" ON public.channel_categories;
CREATE POLICY "channel_categories_update" ON public.channel_categories
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM public.user_servers us
            WHERE us.server_id = channel_categories.server_id
            AND us.user_id = public.get_current_profile_id()
        )
    );

DROP POLICY IF EXISTS "channel_categories_delete" ON public.channel_categories;
CREATE POLICY "channel_categories_delete" ON public.channel_categories
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM public.servers
            WHERE id = channel_categories.server_id
            AND owner = public.get_current_profile_id()
        )
    );

-- ---------------------------------------------------------------------------
-- CHANNELS RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "channels_select_member" ON public.channels
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
    );

CREATE POLICY "channels_insert_owner" ON public.channels
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.servers 
            WHERE id = channels.server_id 
            AND owner = public.get_current_profile_id()
        )
    );

CREATE POLICY "channels_update_owner" ON public.channels
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM public.servers 
            WHERE id = channels.server_id 
            AND owner = public.get_current_profile_id()
        )
    );

CREATE POLICY "channels_delete_owner" ON public.channels
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM public.servers 
            WHERE id = channels.server_id 
            AND owner = public.get_current_profile_id()
        )
    );

-- ---------------------------------------------------------------------------
-- MESSAGES RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- Channel messages: members can see
CREATE POLICY "messages_select_channel_member" ON public.messages
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
    );

-- Prevent blocked users from sending DMs to users who blocked them
CREATE POLICY "messages_insert_member" ON public.messages
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
    );

CREATE POLICY "messages_update_authorized" ON public.messages
    FOR UPDATE USING (
        user_id = public.get_current_profile_id()
        OR public.is_current_user_admin()
        OR public.is_current_user_moderator()
        OR public.can_current_user_manage_messages_in_channel(channel_id)
    );

CREATE POLICY "messages_delete_authorized" ON public.messages
    FOR DELETE USING (
        user_id = public.get_current_profile_id()
        OR public.is_current_user_admin()
        OR public.is_current_user_moderator()
        OR public.can_current_user_manage_messages_in_channel(channel_id)
    );

-- ---------------------------------------------------------------------------
-- USER SERVERS RLS
-- ---------------------------------------------------------------------------
-- Note: Using simple policies to avoid infinite recursion issues.
-- Complex membership checks should be done in application logic.
ALTER TABLE public.user_servers ENABLE ROW LEVEL SECURITY;

-- Users can see memberships for servers they belong to (co-members),
-- their own memberships, or all memberships if admin.
CREATE POLICY "user_servers_select_co_members" ON public.user_servers
    FOR SELECT TO authenticated
    USING (
        user_id = public.get_current_profile_id()
        OR public.current_user_is_member_of_server(server_id)
        OR public.is_current_user_admin()
    );

-- Users can join servers (insert themselves)
CREATE POLICY "user_servers_insert_self" ON public.user_servers
    FOR INSERT TO authenticated
    WITH CHECK (user_id = public.get_current_profile_id());

-- Users can update their own membership, server owners can update any member
CREATE POLICY "user_servers_update_own_or_owner" ON public.user_servers
    FOR UPDATE TO authenticated
    USING (
        user_id = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.servers
            WHERE servers.id = user_servers.server_id
            AND owner = public.get_current_profile_id()
        )
        OR public.is_current_user_admin()
    );

-- Allow users to leave servers they're in, or owners to remove members
CREATE POLICY "Users can leave servers" ON public.user_servers
    FOR DELETE TO authenticated USING (
        user_id = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.servers
            WHERE servers.id = user_servers.server_id
            AND owner = public.get_current_profile_id()
        )
    );

-- ---------------------------------------------------------------------------
-- CONVERSATIONS RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "conversations_select_participant" ON public.conversations
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.conversation_participants
            WHERE conversation_id = conversations.id
            AND user_id = public.get_current_profile_id()
        )
    );

CREATE POLICY "conversations_insert_authenticated" ON public.conversations
    FOR INSERT WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- CONVERSATION PARTICIPANTS RLS
-- ---------------------------------------------------------------------------
-- Note: Using simple policies to avoid infinite recursion issues.
-- Complex membership checks should be done in application logic or via helper functions.
ALTER TABLE public.conversation_participants ENABLE ROW LEVEL SECURITY;

-- Read participant rows only for conversations the caller is in. Uses a
-- SECURITY DEFINER helper to avoid recursive RLS on this table. Previously this
-- was USING (true), which let any authenticated user enumerate every DM's
-- members (and, combined with the old permissive INSERT, self-join any DM).
CREATE POLICY "conversation_participants_select_policy" ON public.conversation_participants
    FOR SELECT USING (
        public.is_conversation_participant(conversation_id, public.get_current_profile_id())
    );

-- Direct client INSERTs are limited to adding YOURSELF to a conversation YOU
-- created. All real multi-party flows (1:1, group create, add member) go
-- through SECURITY DEFINER RPCs (create_or_get_direct_conversation,
-- create_group_conversation, add_user_to_conversation) which bypass RLS, so
-- this strict policy does not break any legitimate path. It does block the
-- attack of inserting yourself into a victim's existing conversation.
CREATE POLICY "conversation_participants_insert_self_owned" ON public.conversation_participants
    FOR INSERT WITH CHECK (
        user_id = public.get_current_profile_id()
        AND EXISTS (
            SELECT 1 FROM public.conversations c
            WHERE c.id = conversation_id
              AND c.created_by = public.get_current_profile_id()
        )
    );

-- Allow users to update their own participation
CREATE POLICY "conversation_participants_update_policy" ON public.conversation_participants
    FOR UPDATE TO authenticated USING (user_id = public.get_current_profile_id());

-- Allow users to leave conversations
CREATE POLICY "conversation_participants_delete_policy" ON public.conversation_participants
    FOR DELETE TO authenticated USING (user_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- NOTIFICATIONS RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notifications_select_own" ON public.notifications
    FOR SELECT USING (user_id = public.get_current_profile_id());

-- Notifications are created exclusively by SECURITY DEFINER functions/triggers
-- (send_notification, create_notification_structured, ...) which run as the
-- table owner and bypass RLS. Restricting the INSERT policy to service_role
-- means authenticated clients can no longer forge arbitrary notifications for
-- other users (fake mentions/DMs/admin prompts) via PostgREST.
CREATE POLICY "notifications_insert_system" ON public.notifications
    FOR INSERT TO service_role WITH CHECK (true);

CREATE POLICY "notifications_update_own" ON public.notifications
    FOR UPDATE USING (user_id = public.get_current_profile_id());

CREATE POLICY "notifications_delete_own" ON public.notifications
    FOR DELETE USING (user_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- USER BLOCKS RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_blocks_select_own" ON public.user_blocks
    FOR SELECT USING (blocker_id = public.get_current_profile_id());

CREATE POLICY "user_blocks_check_if_blocked" ON public.user_blocks
    FOR SELECT USING (blocked_user_id = public.get_current_profile_id());

CREATE POLICY "user_blocks_insert_own" ON public.user_blocks
    FOR INSERT WITH CHECK (blocker_id = public.get_current_profile_id());

CREATE POLICY "user_blocks_delete_own" ON public.user_blocks
    FOR DELETE USING (blocker_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- USER MUTES RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_mutes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_mutes_select_own" ON public.user_mutes
    FOR SELECT USING (muter_id = public.get_current_profile_id());

CREATE POLICY "user_mutes_insert_own" ON public.user_mutes
    FOR INSERT WITH CHECK (muter_id = public.get_current_profile_id());

CREATE POLICY "user_mutes_update_own" ON public.user_mutes
    FOR UPDATE USING (muter_id = public.get_current_profile_id());

CREATE POLICY "user_mutes_delete_own" ON public.user_mutes
    FOR DELETE USING (muter_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- REACTIONS RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.reactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "reactions_select_all" ON public.reactions
    FOR SELECT USING (true);

-- Prevent reactions on messages from users who blocked you
-- Note: Post reactions are handled in post_interactions table, not here
CREATE POLICY "reactions_insert_own" ON public.reactions
    FOR INSERT WITH CHECK (
        user_id = public.get_current_profile_id()
        -- Check if message author blocked us
        AND NOT public.is_blocked_by((SELECT user_id FROM public.messages WHERE id = reactions.message_id))
    );

CREATE POLICY "reactions_delete_own" ON public.reactions
    FOR DELETE USING (user_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- Enable RLS on remaining tables (with permissive policies for now)
-- ---------------------------------------------------------------------------
ALTER TABLE public.instance_config ENABLE ROW LEVEL SECURITY;
CREATE POLICY "instance_config_select_all" ON public.instance_config FOR SELECT USING (true);

ALTER TABLE public.emojis ENABLE ROW LEVEL SECURITY;
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

ALTER TABLE public.hashtags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hashtags_select_all" ON public.hashtags FOR SELECT USING (true);

ALTER TABLE public.federated_instances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "federated_instances_select_all" ON public.federated_instances;
CREATE POLICY "federated_instances_select_all" ON public.federated_instances FOR SELECT USING (true);

DROP POLICY IF EXISTS "federated_instances_manage" ON public.federated_instances;
CREATE POLICY "federated_instances_manage" ON public.federated_instances
    FOR ALL USING (public.is_current_user_admin());

DROP POLICY IF EXISTS "federated_instances_service_role" ON public.federated_instances;
CREATE POLICY "federated_instances_service_role" ON public.federated_instances
    TO service_role USING (true);

-- Federation endpoint health
ALTER TABLE public.federation_endpoint_health ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "federation_endpoint_health_select" ON public.federation_endpoint_health;
CREATE POLICY "federation_endpoint_health_select" ON public.federation_endpoint_health
    FOR SELECT USING (true);
DROP POLICY IF EXISTS "federation_endpoint_health_manage" ON public.federation_endpoint_health;
CREATE POLICY "federation_endpoint_health_manage" ON public.federation_endpoint_health
    FOR ALL TO service_role
    USING (true);
DROP POLICY IF EXISTS "federation_endpoint_health_insert_update" ON public.federation_endpoint_health;
CREATE POLICY "federation_endpoint_health_insert_update" ON public.federation_endpoint_health
    FOR INSERT TO authenticated
    WITH CHECK (auth.uid() IS NOT NULL);
DROP POLICY IF EXISTS "Admins can delete dead endpoints" ON public.federation_endpoint_health;
CREATE POLICY "Admins can delete dead endpoints" ON public.federation_endpoint_health
    FOR DELETE TO authenticated
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = public.get_current_profile_id()
            AND is_admin = true
        )
    );

-- Federation health (instance-level)
ALTER TABLE public.federation_health ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "federation_health_select_all" ON public.federation_health;
CREATE POLICY "federation_health_select_all" ON public.federation_health
    FOR SELECT USING (true);
DROP POLICY IF EXISTS "federation_health_manage" ON public.federation_health;
CREATE POLICY "federation_health_manage" ON public.federation_health
    FOR ALL USING (public.is_current_user_admin());

DROP POLICY IF EXISTS "federation_health_service_role" ON public.federation_health;
CREATE POLICY "federation_health_service_role" ON public.federation_health
    TO service_role USING (true);

ALTER TABLE public.oauth_providers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "oauth_providers_select_all" ON public.oauth_providers FOR SELECT USING (true);

ALTER TABLE public.server_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "server_roles_select" ON public.server_roles FOR SELECT USING (true);
CREATE POLICY "server_roles_insert" ON public.server_roles
    FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM public.servers WHERE id = server_id AND owner = public.get_current_profile_id())
        OR public.is_current_user_admin()
    );
CREATE POLICY "server_roles_update" ON public.server_roles
    FOR UPDATE USING (
        NOT is_default AND (
            EXISTS (SELECT 1 FROM public.servers WHERE id = server_id AND owner = public.get_current_profile_id())
            OR public.is_current_user_admin()
        )
    );
CREATE POLICY "server_roles_delete" ON public.server_roles
    FOR DELETE USING (
        NOT is_default AND (
            EXISTS (SELECT 1 FROM public.servers WHERE id = server_id AND owner = public.get_current_profile_id())
            OR public.is_current_user_admin()
        )
    );

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_roles_select" ON public.user_roles FOR SELECT USING (true);
CREATE POLICY "user_roles_insert" ON public.user_roles
    FOR INSERT WITH CHECK (
        EXISTS (SELECT 1 FROM public.servers WHERE id = server_id AND owner = public.get_current_profile_id())
        OR public.is_current_user_admin()
    );
CREATE POLICY "user_roles_delete" ON public.user_roles
    FOR DELETE USING (
        EXISTS (SELECT 1 FROM public.servers WHERE id = server_id AND owner = public.get_current_profile_id())
        OR public.is_current_user_admin()
    );

ALTER TABLE public.threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "threads_select_member" ON public.threads FOR SELECT USING (true);

-- Server members can create threads
DROP POLICY IF EXISTS "threads_insert_member" ON public.threads;
CREATE POLICY "threads_insert_member" ON public.threads
    FOR INSERT WITH CHECK (
        created_by = public.get_current_profile_id()
        AND EXISTS (
            SELECT 1 FROM public.channels c
            JOIN public.user_servers us ON us.server_id = c.server_id
            WHERE c.id = threads.channel_id
            AND us.user_id = public.get_current_profile_id()
            AND us.status = 'accepted'
        )
    );

-- Thread creator or users with MANAGE_CHANNELS can update threads
DROP POLICY IF EXISTS "threads_update_authorized" ON public.threads;
CREATE POLICY "threads_update_authorized" ON public.threads
    FOR UPDATE USING (
        created_by = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.channels c
            JOIN public.servers s ON s.id = c.server_id
            WHERE c.id = threads.channel_id
            AND s.owner = public.get_current_profile_id()
        )
        OR public.is_current_user_admin()
    );

-- Thread creator or server owner can delete threads
DROP POLICY IF EXISTS "threads_delete_authorized" ON public.threads;
CREATE POLICY "threads_delete_authorized" ON public.threads
    FOR DELETE USING (
        created_by = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.channels c
            JOIN public.servers s ON s.id = c.server_id
            WHERE c.id = threads.channel_id
            AND s.owner = public.get_current_profile_id()
        )
        OR public.is_current_user_admin()
    );

-- Service role can do anything on threads (for federation backend)
DROP POLICY IF EXISTS "threads_service_role" ON public.threads;
CREATE POLICY "threads_service_role" ON public.threads
    FOR ALL TO service_role USING (true);

ALTER TABLE public.thread_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "thread_members_select_all" ON public.thread_members FOR SELECT USING (true);

-- Users can join threads (insert themselves)
DROP POLICY IF EXISTS "thread_members_insert_self" ON public.thread_members;
CREATE POLICY "thread_members_insert_self" ON public.thread_members
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id());

-- Users can update their own thread membership (mute, etc.)
DROP POLICY IF EXISTS "thread_members_update_self" ON public.thread_members;
CREATE POLICY "thread_members_update_self" ON public.thread_members
    FOR UPDATE USING (user_id = public.get_current_profile_id());

-- Users can leave threads (delete themselves)
DROP POLICY IF EXISTS "thread_members_delete_self" ON public.thread_members;
CREATE POLICY "thread_members_delete_self" ON public.thread_members
    FOR DELETE USING (user_id = public.get_current_profile_id());

-- Service role can manage thread members (for triggers/federation)
DROP POLICY IF EXISTS "thread_members_service_role" ON public.thread_members;
CREATE POLICY "thread_members_service_role" ON public.thread_members
    FOR ALL TO service_role USING (true);

ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "invites_select_all" ON public.invites FOR SELECT USING (true);

-- Server members can create invites
DROP POLICY IF EXISTS "invites_insert_members" ON public.invites;
CREATE POLICY "invites_insert_members" ON public.invites FOR INSERT
    WITH CHECK (
        auth.role() = 'authenticated'
        AND EXISTS (
            SELECT 1 FROM public.user_servers us
            WHERE us.server_id = invites.server_id
              AND us.user_id = public.get_current_profile_id()
        )
    );

-- Invite creators can update their own invites (mark used, increment uses)
DROP POLICY IF EXISTS "invites_update_creator" ON public.invites;
CREATE POLICY "invites_update_creator" ON public.invites FOR UPDATE
    USING (created_by = public.get_current_profile_id());

-- Invite creators can delete their own invites
DROP POLICY IF EXISTS "invites_delete_creator" ON public.invites;
CREATE POLICY "invites_delete_creator" ON public.invites FOR DELETE
    USING (created_by = public.get_current_profile_id());

ALTER TABLE public.voice_channel_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "voice_participants_select_all" ON public.voice_channel_participants FOR SELECT USING (true);
-- Local users manage their own presence row directly from the client. Federated
-- participants and cleanup jobs use the service_role key, which bypasses RLS.
CREATE POLICY "voice_participants_insert_self" ON public.voice_channel_participants
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id());
CREATE POLICY "voice_participants_update_self" ON public.voice_channel_participants
    FOR UPDATE USING (user_id = public.get_current_profile_id())
    WITH CHECK (user_id = public.get_current_profile_id());
CREATE POLICY "voice_participants_delete_self" ON public.voice_channel_participants
    FOR DELETE USING (user_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- INSTANCE WEBRTC SETTINGS RLS
-- SECURITY: This table contains livekit_api_secret which MUST NOT be exposed!
-- Only admins can read the full table. Use get_livekit_config() for safe access.
-- ---------------------------------------------------------------------------
ALTER TABLE public.instance_webrtc_settings ENABLE ROW LEVEL SECURITY;

-- Only admins can read WebRTC settings (contains API secrets)
CREATE POLICY "webrtc_settings_select_admin_only" ON public.instance_webrtc_settings 
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM public.profiles 
            WHERE auth_user_id = auth.uid() 
            AND is_admin = true
        )
    );

-- Only admins can modify WebRTC settings
CREATE POLICY "webrtc_settings_update_admin_only" ON public.instance_webrtc_settings 
    FOR UPDATE USING (
        EXISTS (
            SELECT 1 FROM public.profiles 
            WHERE auth_user_id = auth.uid() 
            AND is_admin = true
        )
    );

CREATE POLICY "webrtc_settings_insert_admin_only" ON public.instance_webrtc_settings 
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles 
            WHERE auth_user_id = auth.uid() 
            AND is_admin = true
        )
    );

-- ---------------------------------------------------------------------------
-- NOTIFICATION PREFERENCES RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notification_preferences_select_own" ON public.notification_preferences
    FOR SELECT USING (user_id = public.get_current_profile_id());

CREATE POLICY "notification_preferences_insert_own" ON public.notification_preferences
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id());

CREATE POLICY "notification_preferences_update_own" ON public.notification_preferences
    FOR UPDATE USING (user_id = public.get_current_profile_id());

CREATE POLICY "notification_preferences_delete_own" ON public.notification_preferences
    FOR DELETE USING (user_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- NOTIFICATION CHANNELS RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.notification_channels ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notification_channels_select_own" ON public.notification_channels
    FOR SELECT USING (user_id = public.get_current_profile_id());

CREATE POLICY "notification_channels_insert_own" ON public.notification_channels
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id());

CREATE POLICY "notification_channels_update_own" ON public.notification_channels
    FOR UPDATE USING (user_id = public.get_current_profile_id());

CREATE POLICY "notification_channels_delete_own" ON public.notification_channels
    FOR DELETE USING (user_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- SERVER BANS RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.server_bans ENABLE ROW LEVEL SECURITY;

-- All ban mutations go through SECURITY DEFINER RPCs (ban_server_member,
-- unban_server_member) and the list is read via get_server_bans (also definer,
-- with a BAN_MEMBERS/owner check). The table itself must NOT be openly
-- readable/writable: previously any authenticated user could enumerate every
-- server's ban list (reasons included) and insert/delete arbitrary bans.
CREATE POLICY "server_bans_select_moderator" ON public.server_bans
    FOR SELECT TO authenticated USING (
        public.is_current_user_admin()
        OR public.has_permission(public.get_current_profile_id(), server_id, 'BAN_MEMBERS')
    );

-- Writes are service_role / SECURITY DEFINER RPC only (definers bypass RLS).
CREATE POLICY "server_bans_insert_service" ON public.server_bans
    FOR INSERT TO service_role WITH CHECK (true);

CREATE POLICY "server_bans_delete_service" ON public.server_bans
    FOR DELETE TO service_role USING (true);

-- ---------------------------------------------------------------------------
-- ANNOUNCEMENTS RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.instance_announcements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcement_reads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "announcements_select_all" ON public.instance_announcements
    FOR SELECT TO authenticated USING (true);

CREATE POLICY "announcements_insert_admin" ON public.instance_announcements
    FOR INSERT TO authenticated WITH CHECK (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
    );

CREATE POLICY "announcements_update_admin" ON public.instance_announcements
    FOR UPDATE TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
    );

CREATE POLICY "announcements_delete_admin" ON public.instance_announcements
    FOR DELETE TO authenticated USING (
        EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND is_admin = true)
    );

CREATE POLICY "announcement_reads_select_own" ON public.announcement_reads
    FOR SELECT TO authenticated USING (user_id = auth.uid());

CREATE POLICY "announcement_reads_insert_own" ON public.announcement_reads
    FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());

DO $$
BEGIN
    RAISE NOTICE 'RLS policies created successfully';
END $$;

