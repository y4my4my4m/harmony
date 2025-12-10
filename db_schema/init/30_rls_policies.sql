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
            -- Not blocked by the author
            NOT public.is_blocked_by(author_id)
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
ALTER TABLE public.servers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "servers_select_public_or_member" ON public.servers
    FOR SELECT USING (
        is_public = true
        OR owner = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.user_servers 
            WHERE server_id = servers.id 
            AND user_id = public.get_current_profile_id()
            AND status = 'accepted'
        )
    );

CREATE POLICY "servers_insert_authenticated" ON public.servers
    FOR INSERT WITH CHECK (owner = public.get_current_profile_id());

CREATE POLICY "servers_update_owner" ON public.servers
    FOR UPDATE USING (owner = public.get_current_profile_id());

CREATE POLICY "servers_delete_owner" ON public.servers
    FOR DELETE USING (owner = public.get_current_profile_id());

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

CREATE POLICY "messages_update_own" ON public.messages
    FOR UPDATE USING (user_id = public.get_current_profile_id());

CREATE POLICY "messages_delete_own" ON public.messages
    FOR DELETE USING (user_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- USER SERVERS RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_servers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_servers_select_member" ON public.user_servers
    FOR SELECT USING (
        user_id = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.user_servers us2
            WHERE us2.server_id = user_servers.server_id
            AND us2.user_id = public.get_current_profile_id()
            AND us2.status = 'accepted'
        )
    );

CREATE POLICY "user_servers_insert_self_or_owner" ON public.user_servers
    FOR INSERT WITH CHECK (
        user_id = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.servers 
            WHERE id = user_servers.server_id 
            AND owner = public.get_current_profile_id()
        )
    );

CREATE POLICY "user_servers_update_self_or_owner" ON public.user_servers
    FOR UPDATE USING (
        user_id = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.servers 
            WHERE id = user_servers.server_id 
            AND owner = public.get_current_profile_id()
        )
    );

CREATE POLICY "user_servers_delete_self_or_owner" ON public.user_servers
    FOR DELETE USING (
        user_id = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.servers 
            WHERE id = user_servers.server_id 
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
ALTER TABLE public.conversation_participants ENABLE ROW LEVEL SECURITY;

CREATE POLICY "conversation_participants_select" ON public.conversation_participants
    FOR SELECT USING (
        user_id = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.conversation_participants cp2
            WHERE cp2.conversation_id = conversation_participants.conversation_id
            AND cp2.user_id = public.get_current_profile_id()
        )
    );

CREATE POLICY "conversation_participants_insert" ON public.conversation_participants
    FOR INSERT WITH CHECK (
        user_id = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.conversation_participants
            WHERE conversation_id = conversation_participants.conversation_id
            AND user_id = public.get_current_profile_id()
        )
    );

-- ---------------------------------------------------------------------------
-- NOTIFICATIONS RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

CREATE POLICY "notifications_select_own" ON public.notifications
    FOR SELECT USING (user_id = public.get_current_profile_id());

CREATE POLICY "notifications_insert_system" ON public.notifications
    FOR INSERT WITH CHECK (true);

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
CREATE POLICY "emojis_select_all" ON public.emojis FOR SELECT USING (true);

ALTER TABLE public.hashtags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "hashtags_select_all" ON public.hashtags FOR SELECT USING (true);

ALTER TABLE public.federated_instances ENABLE ROW LEVEL SECURITY;
CREATE POLICY "federated_instances_select_all" ON public.federated_instances FOR SELECT USING (true);

ALTER TABLE public.oauth_providers ENABLE ROW LEVEL SECURITY;
CREATE POLICY "oauth_providers_select_all" ON public.oauth_providers FOR SELECT USING (true);

ALTER TABLE public.server_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "server_roles_select_member" ON public.server_roles FOR SELECT USING (true);

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_roles_select_all" ON public.user_roles FOR SELECT USING (true);

ALTER TABLE public.threads ENABLE ROW LEVEL SECURITY;
CREATE POLICY "threads_select_member" ON public.threads FOR SELECT USING (true);

ALTER TABLE public.thread_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "thread_members_select_all" ON public.thread_members FOR SELECT USING (true);

ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "invites_select_all" ON public.invites FOR SELECT USING (true);

ALTER TABLE public.voice_channel_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "voice_participants_select_all" ON public.voice_channel_participants FOR SELECT USING (true);

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

DO $$
BEGIN
    RAISE NOTICE 'RLS policies created successfully';
END $$;

