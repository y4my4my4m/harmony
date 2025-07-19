-- =====================================================
-- HARMONY DATABASE REFACTOR - PHASE 2
-- Unified Notification System
-- =====================================================

-- This migration implements Phase 2 of the database refactor:
-- 1. Create unified send_notification() function
-- 2. Consolidate all notification creation into single entry point
-- 3. Respect user notification preferences automatically
-- 4. Support local and federated notification delivery
-- 5. Handle DND and channel/server muting

BEGIN;

-- =====================================================
-- STEP 0: ADD MISSING COLUMNS TO NOTIFICATIONS TABLE
-- =====================================================

-- Add read_at column for tracking read status (if it doesn't exist)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at timestamp with time zone;

-- Add is_read column if it doesn't exist (keeping as regular boolean since it may already exist)
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS is_read boolean DEFAULT false;

-- Sync is_read with read_at for existing records
UPDATE notifications SET is_read = (read_at IS NOT NULL) WHERE is_read != (read_at IS NOT NULL);

COMMENT ON COLUMN notifications.read_at IS 'Timestamp when notification was marked as read';
COMMENT ON COLUMN notifications.is_read IS 'Boolean field indicating if notification has been read';

-- =====================================================
-- STEP 1: CORE UNIFIED NOTIFICATION FUNCTION
-- =====================================================

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
AS $$
DECLARE
    created_notification_ids uuid[] := '{}';
    recipient_id uuid;
    user_prefs record;
    channel_prefs record;
    should_send boolean;
    notification_id uuid;
    current_time timestamp with time zone := now();
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

        -- Get user notification preferences
        SELECT * INTO user_prefs 
        FROM notification_preferences 
        WHERE notification_preferences.user_id = recipient_id;

        -- If no preferences found, skip (user might have disabled notifications)
        IF user_prefs IS NULL THEN
            CONTINUE;
        END IF;

        -- Check DND (Do Not Disturb) settings
        is_dnd_time := false;
        IF user_prefs.dnd_enabled THEN
            is_dnd_time := (
                current_time::time BETWEEN user_prefs.dnd_start_time AND user_prefs.dnd_end_time
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

        -- Check if channel/conversation is muted
        IF channel_prefs IS NOT NULL THEN
            IF channel_prefs.muted = true THEN
                CONTINUE;
            END IF;
            IF channel_prefs.muted_until IS NOT NULL AND channel_prefs.muted_until > current_time THEN
                CONTINUE;
            END IF;
        END IF;

        -- Determine if we should send this notification based on type and preferences
        should_send := false;

        CASE notification_type
            WHEN 'mention' THEN
                should_send := (
                    user_prefs.desktop_mentions AND
                    user_prefs.push_mentions AND
                    (NOT is_dnd_time OR priority = 'high')
                );
            WHEN 'dm' THEN
                should_send := (
                    user_prefs.desktop_dms AND
                    user_prefs.push_dms AND
                    (NOT is_dnd_time OR priority = 'high')
                );
            WHEN 'direct_message' THEN
                should_send := (
                    user_prefs.desktop_dms AND
                    user_prefs.push_dms AND
                    (NOT is_dnd_time OR priority = 'high')
                );
            WHEN 'reply' THEN
                should_send := (
                    user_prefs.desktop_replies AND
                    user_prefs.activitypub_replies AND
                    (NOT is_dnd_time OR priority = 'high')
                );
            WHEN 'follow' THEN
                should_send := (
                    user_prefs.activitypub_follows AND
                    (NOT is_dnd_time OR priority = 'high')
                );
            WHEN 'like' THEN
                should_send := (
                    user_prefs.activitypub_favorites AND
                    (NOT is_dnd_time OR priority = 'high')
                );
            WHEN 'favorite' THEN
                should_send := (
                    user_prefs.activitypub_favorites AND
                    (NOT is_dnd_time OR priority = 'high')
                );
            WHEN 'reblog' THEN
                should_send := (
                    user_prefs.activitypub_reblogs AND
                    (NOT is_dnd_time OR priority = 'high')
                );
            WHEN 'boost' THEN
                should_send := (
                    user_prefs.activitypub_reblogs AND
                    (NOT is_dnd_time OR priority = 'high')
                );
            WHEN 'reaction' THEN
                should_send := (
                    user_prefs.desktop_reactions AND
                    user_prefs.sound_reactions AND
                    (NOT is_dnd_time OR priority = 'high')
                );
            WHEN 'voice_activity' THEN
                should_send := (
                    user_prefs.sound_voice_activity AND
                    (NOT is_dnd_time OR priority = 'high')
                );
            WHEN 'activitypub_mention' THEN
                should_send := (
                    user_prefs.activitypub_mentions AND
                    user_prefs.activitypub_notifications AND
                    (NOT is_dnd_time OR priority = 'high')
                );
            ELSE
                -- Default notification types
                should_send := (
                    user_prefs.desktop_notifications AND
                    (NOT is_dnd_time OR priority = 'high')
                );
        END CASE;

        -- Skip if notification should not be sent
        IF NOT should_send THEN
            CONTINUE;
        END IF;

        -- Create the notification (using JSONB data field)
        INSERT INTO notifications (
            user_id,
            type,
            data,
            is_read,
            is_clicked,
            created_at,
            updated_at,
            expires_at,
            read_at
        ) VALUES (
            recipient_id,
            notification_type,
            notification_data,
            false,
            false,
            current_time,
            current_time,
            current_time + INTERVAL '30 days',
            NULL
        ) RETURNING id INTO notification_id;

        -- Add to result array
        created_notification_ids := created_notification_ids || notification_id;

        -- Log notification creation (for debugging/analytics)
        INSERT INTO activity_processing_logs (
            activity_id,
            ap_id,
            ap_type,
            status,
            error_message,
            created_at
        ) VALUES (
            notification_id,
            'notification-' || notification_id::text,
            'Notification',
            'completed',
            format('Sent %s notification to user %s', notification_type, recipient_id),
            current_time
        );
    END LOOP;

    RETURN created_notification_ids;
END;
$$;

COMMENT ON FUNCTION public.send_notification(varchar, uuid[], jsonb, uuid, uuid, uuid, uuid, varchar) IS 'Unified notification function that respects all user preferences, DND settings, and channel muting. Handles both local and federated notifications.';

-- =====================================================
-- STEP 2: BULK NOTIFICATION HELPER FUNCTIONS
-- =====================================================

-- Helper function for single user notifications
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

COMMENT ON FUNCTION public.send_notification_to_user(varchar, uuid, jsonb, uuid, uuid, uuid, uuid, varchar) IS 'Convenience function for sending notifications to a single user.';

-- Helper function for server member notifications
CREATE OR REPLACE FUNCTION public.send_notification_to_server_members(
    notification_type varchar(50),
    target_server_id uuid,
    notification_data jsonb DEFAULT '{}',
    channel_id uuid DEFAULT NULL,
    from_user_id uuid DEFAULT NULL,
    exclude_user_ids uuid[] DEFAULT '{}',
    priority varchar(10) DEFAULT 'normal'
)
RETURNS uuid[]
LANGUAGE plpgsql
AS $$
DECLARE
    server_member_ids uuid[];
BEGIN
    -- Get all server members
    SELECT array_agg(user_id)
    INTO server_member_ids
    FROM user_servers us
    WHERE us.server_id = target_server_id
    AND (exclude_user_ids IS NULL OR NOT (us.user_id = ANY(exclude_user_ids)));

    -- Send notifications to all members
    RETURN send_notification(
        notification_type,
        server_member_ids,
        notification_data,
        target_server_id,
        channel_id,
        NULL,
        from_user_id,
        priority
    );
END;
$$;

COMMENT ON FUNCTION public.send_notification_to_server_members(varchar, uuid, jsonb, uuid, uuid, uuid[], varchar) IS 'Send notifications to all members of a server, with optional exclusions.';

-- Helper function for follower notifications
CREATE OR REPLACE FUNCTION public.send_notification_to_followers(
    notification_type varchar(50),
    target_user_id uuid,
    notification_data jsonb DEFAULT '{}',
    from_user_id uuid DEFAULT NULL,
    priority varchar(10) DEFAULT 'normal'
)
RETURNS uuid[]
LANGUAGE plpgsql
AS $$
DECLARE
    follower_ids uuid[];
BEGIN
    -- Get all followers
    SELECT array_agg(follower_id)
    INTO follower_ids
    FROM follows f
    WHERE f.following_id = target_user_id
    AND f.status = 'accepted';

    -- Send notifications to all followers
    RETURN send_notification(
        notification_type,
        follower_ids,
        notification_data,
        NULL,
        NULL,
        NULL,
        from_user_id,
        priority
    );
END;
$$;

COMMENT ON FUNCTION public.send_notification_to_followers(varchar, uuid, jsonb, uuid, varchar) IS 'Send notifications to all followers of a user.';

-- =====================================================
-- STEP 3: MIGRATION WRAPPER FUNCTIONS
-- =====================================================

-- Migrate existing notification functions to use the new unified system
-- These will replace the old functions but maintain the same interface for compatibility

CREATE OR REPLACE FUNCTION public.create_notification(
    p_user_id uuid, 
    p_type varchar, 
    p_title varchar, 
    p_message text DEFAULT NULL, 
    p_data jsonb DEFAULT '{}'
)
RETURNS uuid
LANGUAGE sql
AS $$
    SELECT send_notification_to_user(
        p_type,
        p_user_id,
        p_data || jsonb_build_object('title', p_title, 'custom_message', p_message),
        NULL,
        NULL,
        NULL,
        NULL,
        'normal'
    );
$$;

COMMENT ON FUNCTION public.create_notification(uuid, varchar, varchar, text, jsonb) IS 'COMPATIBILITY: Migrated to use send_notification_to_user(). Consider using send_notification_to_user() directly.';

CREATE OR REPLACE FUNCTION public.create_notification_structured(
    p_user_id uuid, 
    p_type varchar, 
    p_data jsonb DEFAULT '{}', 
    p_server_id uuid DEFAULT NULL, 
    p_channel_id uuid DEFAULT NULL, 
    p_conversation_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE sql
AS $$
    SELECT send_notification_to_user(
        p_type,
        p_user_id,
        p_data,
        p_server_id,
        p_channel_id,
        p_conversation_id,
        NULL,
        'normal'
    );
$$;

COMMENT ON FUNCTION public.create_notification_structured(uuid, varchar, jsonb, uuid, uuid, uuid) IS 'COMPATIBILITY: Migrated to use send_notification_to_user(). Consider using send_notification_to_user() directly.';

CREATE OR REPLACE FUNCTION public.create_simple_activitypub_notification(
    p_user_id uuid, 
    p_type varchar, 
    p_data jsonb
)
RETURNS uuid
LANGUAGE sql
AS $$
    SELECT send_notification_to_user(
        'activitypub_' || p_type,
        p_user_id,
        p_data,
        NULL,
        NULL,
        NULL,
        NULL,
        'normal'
    );
$$;

COMMENT ON FUNCTION public.create_simple_activitypub_notification(uuid, varchar, jsonb) IS 'COMPATIBILITY: Migrated to use send_notification_to_user() for ActivityPub notifications.';

-- =====================================================
-- STEP 4: ENHANCED NOTIFICATION QUERY FUNCTIONS
-- =====================================================

-- Get unread notification count with improved performance
CREATE OR REPLACE FUNCTION public.get_unread_notification_count(p_user_id uuid)
RETURNS integer
LANGUAGE sql STABLE
AS $$
    SELECT COUNT(*)::integer
    FROM notifications n
    WHERE n.user_id = p_user_id
    AND n.read_at IS NULL;
$$;

-- Get notifications with better filtering (matches actual table structure)
CREATE OR REPLACE FUNCTION public.get_user_notifications(
    p_user_id uuid,
    p_limit integer DEFAULT 20,
    p_offset integer DEFAULT 0,
    p_unread_only boolean DEFAULT false,
    p_notification_types varchar[] DEFAULT NULL
)
RETURNS TABLE(
    id uuid,
    user_id uuid,
    type varchar,
    data jsonb,
    is_read boolean,
    is_clicked boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    expires_at timestamp with time zone,
    read_at timestamp with time zone
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        n.id,
        n.user_id,
        n.type,
        n.data,
        n.is_read,
        n.is_clicked,
        n.created_at,
        n.updated_at,
        n.expires_at,
        n.read_at
    FROM notifications n
    WHERE n.user_id = p_user_id
    AND (NOT p_unread_only OR n.read_at IS NULL)
    AND (p_notification_types IS NULL OR n.type = ANY(p_notification_types))
    ORDER BY n.created_at DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

COMMENT ON FUNCTION public.get_user_notifications(uuid, integer, integer, boolean, varchar[]) IS 'Get user notifications with filtering. Supports pagination and type filtering. Returns actual table structure with JSONB data field.';

-- Mark notifications as read
CREATE OR REPLACE FUNCTION public.mark_notifications_read(
    p_user_id uuid,
    p_notification_ids uuid[] DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    updated_count integer;
BEGIN
    IF p_notification_ids IS NULL THEN
        -- Mark all unread notifications as read
        UPDATE notifications 
        SET read_at = now(), is_read = true, updated_at = now()
        WHERE user_id = p_user_id 
        AND read_at IS NULL;
    ELSE
        -- Mark specific notifications as read
        UPDATE notifications 
        SET read_at = now(), is_read = true, updated_at = now()
        WHERE user_id = p_user_id 
        AND id = ANY(p_notification_ids)
        AND read_at IS NULL;
    END IF;
    
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$;

COMMENT ON FUNCTION public.mark_notifications_read(uuid, uuid[]) IS 'Mark notifications as read. If no notification IDs provided, marks all unread notifications as read.';

COMMIT;

-- =====================================================
-- VALIDATION QUERIES
-- =====================================================

-- Test the unified notification system
DO $$
DECLARE
    test_user_id uuid;
    test_notification_ids uuid[];
    test_count integer;
BEGIN
    -- Create a test user (assumes profiles table exists)
    SELECT id INTO test_user_id FROM profiles LIMIT 1;
    
    IF test_user_id IS NOT NULL THEN
        -- Test sending a notification
        test_notification_ids := send_notification(
            'mention',
            ARRAY[test_user_id],
            '{"test": true}',
            NULL,
            NULL,
            NULL,
            NULL,
            'normal'
        );
        
        RAISE NOTICE 'Created test notification IDs: %', test_notification_ids;
        
        -- Test getting unread count
        SELECT get_unread_notification_count(test_user_id) INTO test_count;
        RAISE NOTICE 'Unread notification count: %', test_count;
        
        -- Clean up test notification
        DELETE FROM notifications WHERE id = ANY(test_notification_ids);
        RAISE NOTICE 'Cleaned up test notifications';
    ELSE
        RAISE NOTICE 'No test user found, skipping notification tests';
    END IF;
END;
$$;