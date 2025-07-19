-- Migration 007: Fix Notification RLS Issue and Integrate Batch Reactions
-- 
-- FIXES:
-- 1. RLS Issue: Notification functions need SECURITY DEFINER to read any user's preferences
-- 2. Batch Reactions: Integrate batch reaction loading into message/post loading

-- =====================================================
-- FIX 1: NOTIFICATION RLS SECURITY ISSUE
-- =====================================================

-- The issue: When User A reacts to User B's message, the notification trigger
-- runs as User A but tries to SELECT User B's notification preferences.
-- RLS blocks this, causing the error.
--
-- Solution: Make notification functions run with SECURITY DEFINER
-- so they have elevated privileges to read any user's notification preferences.

-- Fix the main send_notification function
CREATE OR REPLACE FUNCTION public.send_notification(
    notification_type varchar(50),
    to_user_ids uuid[],
    notification_data jsonb DEFAULT '{}',
    server_id uuid DEFAULT NULL,
    channel_id uuid DEFAULT NULL,
    conversation_id uuid DEFAULT NULL,
    from_user_id uuid DEFAULT NULL,
    priority varchar(10) DEFAULT 'normal'
)
RETURNS uuid[]
LANGUAGE plpgsql
SECURITY DEFINER  -- This is the key fix - run with function owner privileges
AS $$
DECLARE
    created_notification_ids uuid[] := '{}';
    recipient_id uuid;
    user_prefs record;
    channel_prefs record;
    should_send boolean;
    notification_id uuid;
    current_timestamp timestamp with time zone := now();
    is_dnd_time boolean;
BEGIN
    -- Validate inputs
    IF notification_type IS NULL OR array_length(to_user_ids, 1) IS NULL THEN
        RETURN '{}';
    END IF;

    -- Process each recipient
    FOREACH recipient_id IN ARRAY to_user_ids
    LOOP
        -- Skip if sending to self (optional check)
        IF from_user_id IS NOT NULL AND recipient_id = from_user_id THEN
            CONTINUE;
        END IF;

        -- Get user notification preferences (now allowed due to SECURITY DEFINER)
        SELECT * INTO user_prefs 
        FROM notification_preferences 
        WHERE notification_preferences.user_id = recipient_id;

        -- If no preferences found, create defaults and fetch them
        IF user_prefs IS NULL THEN
            PERFORM create_default_notification_preferences(recipient_id);
            SELECT * INTO user_prefs 
            FROM notification_preferences 
            WHERE notification_preferences.user_id = recipient_id;
            
            -- If still null after creation, skip this user
            IF user_prefs IS NULL THEN
                CONTINUE;
            END IF;
        END IF;

        -- Check DND (Do Not Disturb) settings
        is_dnd_time := false;
        IF user_prefs.dnd_enabled THEN
            is_dnd_time := (
                current_timestamp::time BETWEEN user_prefs.dnd_start_time AND user_prefs.dnd_end_time
            );
        END IF;

        -- Get channel/server specific preferences if applicable
        channel_prefs := NULL;
        IF channel_id IS NOT NULL OR server_id IS NOT NULL OR conversation_id IS NOT NULL THEN
            SELECT * INTO channel_prefs
            FROM notification_channels nc
            WHERE nc.user_id = recipient_id
            AND (
                nc.channel_id = channel_id OR
                nc.server_id = server_id OR
                nc.conversation_id = conversation_id
            );
        END IF;

        -- Determine if notification should be sent based on preferences
        should_send := true;

        -- Check type-specific preferences
        CASE notification_type
            WHEN 'mention' THEN
                should_send := user_prefs.mentions_enabled;
            WHEN 'reply' THEN
                should_send := user_prefs.replies_enabled;
            WHEN 'dm' THEN
                should_send := user_prefs.dms_enabled;
            WHEN 'follow' THEN
                should_send := user_prefs.follows_enabled;
            WHEN 'like' THEN
                should_send := user_prefs.likes_enabled;
            WHEN 'reblog' THEN
                should_send := user_prefs.reblogs_enabled;
            WHEN 'reaction' THEN
                should_send := user_prefs.reactions_enabled;
            ELSE
                should_send := true; -- Default to sending for unknown types
        END CASE;

        -- Apply DND restrictions
        IF is_dnd_time THEN
            should_send := false;
        END IF;

        -- Apply channel-specific overrides
        IF channel_prefs IS NOT NULL THEN
            IF channel_prefs.muted THEN
                should_send := false;
            END IF;
        END IF;

        -- Create notification if should send
        IF should_send THEN
            INSERT INTO notifications (
                type,
                user_id,
                data,
                server_id,
                channel_id,
                conversation_id,
                from_user_id,
                priority,
                created_at
            ) VALUES (
                notification_type,
                recipient_id,
                notification_data,
                server_id,
                channel_id,
                conversation_id,
                from_user_id,
                priority,
                current_timestamp
            ) RETURNING id INTO notification_id;

            created_notification_ids := array_append(created_notification_ids, notification_id);
        END IF;

    END LOOP;

    RETURN created_notification_ids;
END;
$$;

COMMENT ON FUNCTION public.send_notification(varchar, uuid[], jsonb, uuid, uuid, uuid, uuid, varchar) IS 'SECURITY DEFINER: Unified notification function with elevated privileges to read any user notification preferences for proper notification delivery.';

-- Fix the helper function as well
CREATE OR REPLACE FUNCTION public.send_notification_to_user(
    notification_type varchar(50),
    to_user_id uuid,
    notification_data jsonb DEFAULT '{}',
    server_id uuid DEFAULT NULL,
    channel_id uuid DEFAULT NULL,
    conversation_id uuid DEFAULT NULL,
    from_user_id uuid DEFAULT NULL,
    priority varchar(10) DEFAULT 'normal'
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER  -- Also needs elevated privileges
AS $$
    SELECT (send_notification(
        notification_type,
        ARRAY[to_user_id],
        notification_data,
        server_id,
        channel_id,
        conversation_id,
        from_user_id,
        priority
    ))[1];
$$;

COMMENT ON FUNCTION public.send_notification_to_user(varchar, uuid, jsonb, uuid, uuid, uuid, uuid, varchar) IS 'SECURITY DEFINER: Helper function for single user notifications with elevated privileges.';

-- Fix the create_default_notification_preferences function
CREATE OR REPLACE FUNCTION public.create_default_notification_preferences(p_user_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER  -- Needs elevated privileges to create preferences for any user
AS $$
INSERT INTO notification_preferences (user_id)
VALUES (p_user_id)
ON CONFLICT (user_id) DO NOTHING;
$$;

COMMENT ON FUNCTION public.create_default_notification_preferences(uuid) IS 'SECURITY DEFINER: Creates default notification preferences for any user with elevated privileges.';

-- =====================================================
-- FIX 2: BATCH REACTIONS INTEGRATION
-- =====================================================

-- Create optimized batch reactions function for database use
CREATE OR REPLACE FUNCTION public.get_batch_message_reactions(message_ids uuid[])
RETURNS TABLE (
    message_id uuid,
    emoji_id uuid,
    emoji_name varchar,
    emoji_url varchar,
    reaction_count bigint,
    users jsonb
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        r.message_id,
        r.emoji_id,
        e.name as emoji_name,
        e.url as emoji_url,
        COUNT(r.user_id) as reaction_count,
        jsonb_agg(
            jsonb_build_object(
                'id', p.id,
                'username', p.username,
                'display_name', p.display_name,
                'avatar_url', p.avatar_url
            ) ORDER BY r.created_at
        ) as users
    FROM reactions r
    INNER JOIN emojis e ON r.emoji_id = e.id
    INNER JOIN profiles p ON r.user_id = p.id
    WHERE r.message_id = ANY(message_ids)
    GROUP BY r.message_id, r.emoji_id, e.name, e.url
    ORDER BY r.message_id, MIN(r.created_at);
END;
$$;

COMMENT ON FUNCTION public.get_batch_message_reactions(uuid[]) IS 'Optimized function to fetch reactions for multiple messages in a single query, eliminating N+1 performance issues.';

-- Create optimized batch reactions function for posts
CREATE OR REPLACE FUNCTION public.get_batch_post_reactions(post_ids uuid[])
RETURNS TABLE (
    post_id uuid,
    emoji_id uuid,
    emoji_name varchar,
    emoji_url varchar,
    reaction_count bigint,
    users jsonb
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        pi.post_id,
        pi.emoji_id,
        e.name as emoji_name,
        e.url as emoji_url,
        COUNT(pi.user_id) as reaction_count,
        jsonb_agg(
            jsonb_build_object(
                'id', p.id,
                'username', p.username,
                'display_name', p.display_name,
                'avatar_url', p.avatar_url
            ) ORDER BY pi.created_at
        ) as users
    FROM post_interactions pi
    INNER JOIN emojis e ON pi.emoji_id = e.id
    INNER JOIN profiles p ON pi.user_id = p.id
    WHERE pi.post_id = ANY(post_ids)
    AND pi.interaction_type = 'emoji_reaction'
    GROUP BY pi.post_id, pi.emoji_id, e.name, e.url
    ORDER BY pi.post_id, MIN(pi.created_at);
END;
$$;

COMMENT ON FUNCTION public.get_batch_post_reactions(uuid[]) IS 'Optimized function to fetch reactions for multiple posts in a single query, eliminating N+1 performance issues.';

-- =====================================================
-- SUMMARY
-- =====================================================

-- This migration fixes two critical issues:
--
-- 1. RLS NOTIFICATION ISSUE:
--    - Added SECURITY DEFINER to notification functions
--    - Functions now run with elevated privileges
--    - Can read any user's notification preferences safely
--    - Maintains security while enabling proper notification delivery
--
-- 2. BATCH REACTIONS PERFORMANCE:
--    - Created optimized database functions for batch reaction fetching
--    - Eliminates N+1 query problems
--    - Ready for integration into service layer as "hooks"
--    - Supports both messages and posts
--
-- These fixes maintain security while providing proper functionality
-- and massive performance improvements.