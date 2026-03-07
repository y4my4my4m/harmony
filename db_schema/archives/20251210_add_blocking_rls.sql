-- =============================================================================
-- Migration: Add comprehensive blocking and muting protection via RLS
-- Date: 2025-12-10
-- Description: 
--   Blocking prevents blocked users from:
--     1. Seeing posts from users who blocked them
--     2. Reacting to messages/posts from users who blocked them
--     3. Sending DMs to users who blocked them
--   Muting adds:
--     1. RLS policies for user_mutes table
--     2. Helper functions for mute checks
-- =============================================================================

-- ---------------------------------------------------------------------------
-- HELPER FUNCTION: Check if current user is blocked by a specific user
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_blocked_by(target_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_blocks
        WHERE blocker_id = target_user_id
        AND blocked_user_id = public.get_current_profile_id()
    );
$$;

COMMENT ON FUNCTION public.is_blocked_by IS 'Check if the current user is blocked by the target user';

-- ---------------------------------------------------------------------------
-- HELPER FUNCTION: Check if current user has blocked a specific user
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_blocked(target_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_blocks
        WHERE blocker_id = public.get_current_profile_id()
        AND blocked_user_id = target_user_id
    );
$$;

COMMENT ON FUNCTION public.has_blocked IS 'Check if the current user has blocked the target user';

-- ---------------------------------------------------------------------------
-- HELPER FUNCTION: Check if current user is muted by a specific user
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_muted_by(target_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_mutes
        WHERE muter_id = target_user_id
        AND muted_user_id = public.get_current_profile_id()
    );
$$;

COMMENT ON FUNCTION public.is_muted_by IS 'Check if the current user is muted by the target user';

-- ---------------------------------------------------------------------------
-- HELPER FUNCTION: Check if current user has muted a specific user
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.has_muted(target_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_mutes
        WHERE muter_id = public.get_current_profile_id()
        AND muted_user_id = target_user_id
    );
$$;

COMMENT ON FUNCTION public.has_muted IS 'Check if the current user has muted the target user';

-- ---------------------------------------------------------------------------
-- USER MUTES RLS
-- ---------------------------------------------------------------------------
ALTER TABLE public.user_mutes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_mutes_select_own" ON public.user_mutes;
CREATE POLICY "user_mutes_select_own" ON public.user_mutes
    FOR SELECT USING (muter_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "user_mutes_insert_own" ON public.user_mutes;
CREATE POLICY "user_mutes_insert_own" ON public.user_mutes
    FOR INSERT WITH CHECK (muter_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "user_mutes_update_own" ON public.user_mutes;
CREATE POLICY "user_mutes_update_own" ON public.user_mutes
    FOR UPDATE USING (muter_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "user_mutes_delete_own" ON public.user_mutes;
CREATE POLICY "user_mutes_delete_own" ON public.user_mutes
    FOR DELETE USING (muter_id = public.get_current_profile_id());

-- ---------------------------------------------------------------------------
-- UPDATE POSTS RLS: Hide posts from users who blocked the current user
-- ---------------------------------------------------------------------------

-- Drop existing policy and recreate with blocking check
DROP POLICY IF EXISTS "posts_select_public" ON public.posts;

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

-- ---------------------------------------------------------------------------
-- UPDATE POST_INTERACTIONS RLS: Prevent reactions on posts from users who blocked you
-- ---------------------------------------------------------------------------

-- Drop existing insert policy and recreate with blocking check
DROP POLICY IF EXISTS "post_interactions_insert_own" ON public.post_interactions;

CREATE POLICY "post_interactions_insert_own" ON public.post_interactions
    FOR INSERT WITH CHECK (
        user_id = public.get_current_profile_id()
        AND NOT public.is_blocked_by((SELECT author_id FROM public.posts WHERE id = post_interactions.post_id))
    );

-- ---------------------------------------------------------------------------
-- UPDATE REACTIONS RLS: Prevent reactions on messages from users who blocked you
-- Note: This table is for message reactions only. Post reactions are in post_interactions.
-- ---------------------------------------------------------------------------

-- Drop existing insert policy and recreate with blocking check  
DROP POLICY IF EXISTS "reactions_insert_own" ON public.reactions;

CREATE POLICY "reactions_insert_own" ON public.reactions
    FOR INSERT WITH CHECK (
        user_id = public.get_current_profile_id()
        -- Check if message author blocked us
        AND NOT public.is_blocked_by((SELECT user_id FROM public.messages WHERE id = reactions.message_id))
    );

-- ---------------------------------------------------------------------------
-- UPDATE MESSAGES RLS: Hide DMs from blocked users (client-side filtering is also done)
-- Note: We don't completely hide DMs as that could break conversation history,
-- but we prevent new messages from blocked users in conversations
-- ---------------------------------------------------------------------------

-- Prevent blocked users from sending new messages to users who blocked them
DROP POLICY IF EXISTS "messages_insert_own" ON public.messages;

CREATE POLICY "messages_insert_own" ON public.messages
    FOR INSERT WITH CHECK (
        user_id = public.get_current_profile_id()
        AND (
            -- Channel messages: always allowed (server-level moderation handles this)
            channel_id IS NOT NULL
            -- DM messages: check if any participant blocked us
            OR conversation_id IS NULL
            OR NOT EXISTS (
                SELECT 1 FROM public.conversation_participants cp
                WHERE cp.conversation_id = messages.conversation_id
                AND cp.user_id != public.get_current_profile_id()
                AND cp.left_at IS NULL
                AND public.is_blocked_by(cp.user_id)
            )
        )
    );

-- ---------------------------------------------------------------------------
-- GRANT EXECUTE ON HELPER FUNCTIONS
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.is_blocked_by(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_blocked(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_muted_by(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_muted(uuid) TO authenticated;

-- Notify completion
DO $$
BEGIN
    RAISE NOTICE 'Added comprehensive blocking and muting RLS policies';
END $$;

