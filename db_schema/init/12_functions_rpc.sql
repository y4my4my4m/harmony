-- =============================================================================
-- Harmony Database Schema - RPC Functions
-- =============================================================================
-- Functions called via supabase.rpc() from frontend/backend
-- =============================================================================

-- ---------------------------------------------------------------------------
-- CONVERSATION RPC FUNCTIONS
-- ---------------------------------------------------------------------------

-- Create group conversation
CREATE OR REPLACE FUNCTION public.create_group_conversation(
    creator_user_id uuid,
    participant_ids uuid[] DEFAULT '{}',
    conversation_name text DEFAULT NULL,
    initial_metadata jsonb DEFAULT '{}'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    new_conversation_id uuid;
    participant_id uuid;
BEGIN
    -- SECURITY: Verify the caller is the creator
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = creator_user_id AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: You can only create conversations as yourself';
    END IF;

    INSERT INTO conversations (is_group, name, owner_id, metadata)
    VALUES (true, conversation_name, creator_user_id, initial_metadata)
    RETURNING id INTO new_conversation_id;
    
    -- Add creator as admin
    INSERT INTO conversation_participants (conversation_id, user_id, role)
    VALUES (new_conversation_id, creator_user_id, 'admin');
    
    -- Add other participants
    IF participant_ids IS NOT NULL THEN
        FOREACH participant_id IN ARRAY participant_ids
        LOOP
            IF participant_id != creator_user_id THEN
                INSERT INTO conversation_participants (conversation_id, user_id, role)
                VALUES (new_conversation_id, participant_id, 'member')
                ON CONFLICT (conversation_id, user_id) DO NOTHING;
            END IF;
        END LOOP;
    END IF;
    
    RETURN new_conversation_id;
END;
$$;

-- Get or create multi-participant conversation
CREATE OR REPLACE FUNCTION public.create_or_get_multi_conversation(
    participant_ids uuid[],
    conversation_type text DEFAULT 'direct',
    conversation_name text DEFAULT NULL,
    created_by_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_conversation_id uuid;
    v_participant_id uuid;
    v_caller_profile_id uuid;
BEGIN
    -- SECURITY: Get caller's profile ID
    SELECT id INTO v_caller_profile_id FROM profiles WHERE auth_user_id = auth.uid();
    
    IF v_caller_profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required';
    END IF;
    
    -- SECURITY: Caller must be one of the participants
    IF NOT (v_caller_profile_id = ANY(participant_ids)) THEN
        RAISE EXCEPTION 'Unauthorized: You must be a participant in the conversation';
    END IF;

    -- For direct conversations with 2 participants, try to find existing
    IF array_length(participant_ids, 1) = 2 AND conversation_type = 'direct' THEN
        SELECT c.id INTO v_conversation_id
        FROM conversations c
        WHERE c.is_group = false
          AND EXISTS (SELECT 1 FROM conversation_participants WHERE conversation_id = c.id AND user_id = participant_ids[1])
          AND EXISTS (SELECT 1 FROM conversation_participants WHERE conversation_id = c.id AND user_id = participant_ids[2]);
        
        IF v_conversation_id IS NOT NULL THEN
            RETURN v_conversation_id;
        END IF;
    END IF;
    
    -- Create new conversation (use caller as owner if not specified)
    INSERT INTO conversations (is_group, name, owner_id)
    VALUES (
        array_length(participant_ids, 1) > 2,
        conversation_name,
        COALESCE(created_by_id, v_caller_profile_id)
    )
    RETURNING id INTO v_conversation_id;
    
    -- Add participants
    FOREACH v_participant_id IN ARRAY participant_ids
    LOOP
        INSERT INTO conversation_participants (conversation_id, user_id, role)
        VALUES (v_conversation_id, v_participant_id, 'member')
        ON CONFLICT (conversation_id, user_id) DO NOTHING;
    END LOOP;
    
    RETURN v_conversation_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- TIMELINE RPC FUNCTIONS
-- ---------------------------------------------------------------------------

-- Get timeline posts (home feed)
-- Note: This returns posts from people the caller follows
-- For security, we verify p_user_id matches the caller
CREATE OR REPLACE FUNCTION public.get_timeline(
    p_user_id uuid,
    p_limit integer DEFAULT 50,
    p_before timestamp DEFAULT NOW()
)
RETURNS SETOF posts
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
BEGIN
    -- SECURITY: Verify the caller owns this profile (only view your own timeline)
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = p_user_id AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot view another user''s home timeline';
    END IF;

    RETURN QUERY
    SELECT p.*
    FROM posts p
    WHERE p.author_id IN (
        SELECT following_id 
        FROM follows 
        WHERE follower_id = p_user_id AND status = 'accepted'
    )
    AND p.created_at < p_before
    AND p.is_deleted = false
    ORDER BY p.created_at DESC
    LIMIT p_limit;
END;
$$;

-- Get trending hashtags
CREATE OR REPLACE FUNCTION public.get_trending_hashtags(
    p_days integer DEFAULT 7,
    p_limit integer DEFAULT 20
)
RETURNS TABLE(tag text, uses_count bigint, unique_users bigint)
LANGUAGE sql
STABLE
AS $$
    SELECT 
        h.tag,
        COUNT(*) as uses_count,
        COUNT(DISTINCT p.author_id) as unique_users
    FROM post_hashtags ph
    JOIN hashtags h ON ph.hashtag_id = h.id
    JOIN posts p ON ph.post_id = p.id
    WHERE ph.created_at > NOW() - (p_days || ' days')::INTERVAL
    GROUP BY h.tag
    ORDER BY uses_count DESC
    LIMIT p_limit;
$$;

-- Backfill timeline entries (admin)
CREATE OR REPLACE FUNCTION public.backfill_timeline_entries()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    processed_count INTEGER := 0;
    post_record RECORD;
    follower_record RECORD;
BEGIN
    FOR post_record IN 
        SELECT id, author_id, created_at
        FROM posts 
        WHERE visibility = 'public' 
          AND NOT COALESCE(is_deleted, false)
          AND created_at > NOW() - INTERVAL '30 days'
        ORDER BY created_at DESC
    LOOP
        FOR follower_record IN 
            SELECT f.follower_id 
            FROM follows f 
            WHERE f.following_id = post_record.author_id 
              AND f.status = 'accepted'
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (follower_record.follower_id, post_record.id, 'home', 
                    EXTRACT(epoch FROM post_record.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        END LOOP;
        
        processed_count := processed_count + 1;
    END LOOP;
    
    RETURN processed_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- POST INTERACTION RPC FUNCTIONS
-- ---------------------------------------------------------------------------

-- Add emoji reaction to post
CREATE OR REPLACE FUNCTION public.add_post_emoji_reaction(
    p_user_id uuid,
    p_post_id uuid,
    p_emoji_id uuid DEFAULT NULL,
    p_custom_emoji_content text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_interaction_id uuid;
BEGIN
    -- SECURITY: Verify the caller owns this profile
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = p_user_id AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot create reactions as another user';
    END IF;

    IF p_emoji_id IS NULL AND p_custom_emoji_content IS NULL THEN
        RAISE EXCEPTION 'Must provide either emoji_id or custom_emoji_content';
    END IF;
    
    INSERT INTO post_interactions (
        user_id, post_id, interaction_type,
        emoji_id, custom_emoji_content, is_local
    ) VALUES (
        p_user_id, p_post_id, 'emoji_reaction',
        p_emoji_id, p_custom_emoji_content, true
    ) RETURNING id INTO v_interaction_id;
    
    RETURN v_interaction_id;
END;
$$;

-- Get batch post reactions
CREATE OR REPLACE FUNCTION public.get_batch_post_reactions(post_ids uuid[])
RETURNS TABLE(
    post_id uuid,
    emoji_id uuid,
    emoji_name varchar,
    emoji_url varchar,
    reaction_count bigint,
    users jsonb
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        pi.post_id,
        pi.emoji_id,
        e.name as emoji_name,
        e.url as emoji_url,
        COUNT(*) as reaction_count,
        jsonb_agg(jsonb_build_object(
            'id', p.id,
            'username', p.username,
            'avatar_url', p.avatar_url
        )) as users
    FROM post_interactions pi
    LEFT JOIN emojis e ON pi.emoji_id = e.id
    JOIN profiles p ON pi.user_id = p.id
    WHERE pi.post_id = ANY(post_ids)
      AND pi.interaction_type = 'emoji_reaction'
    GROUP BY pi.post_id, pi.emoji_id, e.name, e.url;
END;
$$;

-- Get batch message reactions
CREATE OR REPLACE FUNCTION public.get_batch_message_reactions(message_ids uuid[])
RETURNS TABLE(
    message_id uuid,
    emoji_id uuid,
    emoji_name varchar,
    emoji_url varchar,
    custom_emoji_content text,
    reaction_count bigint,
    users jsonb
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        r.message_id,
        r.emoji_id,
        e.name as emoji_name,
        e.url as emoji_url,
        r.custom_emoji_content,
        COUNT(*) as reaction_count,
        jsonb_agg(jsonb_build_object(
            'id', p.id,
            'username', p.username,
            'avatar_url', p.avatar_url
        )) as users
    FROM reactions r
    LEFT JOIN emojis e ON r.emoji_id = e.id
    JOIN profiles p ON r.user_id = p.id
    WHERE r.message_id = ANY(message_ids)
    GROUP BY r.message_id, r.emoji_id, e.name, e.url, r.custom_emoji_content;
END;
$$;

-- ---------------------------------------------------------------------------
-- SERVER RPC FUNCTIONS
-- ---------------------------------------------------------------------------

-- Add bot to server
CREATE OR REPLACE FUNCTION public.add_bot_to_server(
    p_bot_id uuid,
    p_server_id uuid,
    p_installed_by uuid,
    p_permissions jsonb DEFAULT '{}'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_permission_id uuid;
    v_caller_profile_id uuid;
BEGIN
    -- SECURITY: Get caller's profile ID
    SELECT id INTO v_caller_profile_id FROM profiles WHERE auth_user_id = auth.uid();
    
    IF v_caller_profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required';
    END IF;
    
    -- SECURITY: Verify caller is server owner or has manage permissions
    IF NOT EXISTS (
        SELECT 1 FROM servers WHERE id = p_server_id AND owner = v_caller_profile_id
    ) AND NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = v_caller_profile_id AND is_admin = true
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Only server owners can add bots';
    END IF;
    
    -- SECURITY: The installer must be the caller
    IF p_installed_by != v_caller_profile_id THEN
        RAISE EXCEPTION 'Unauthorized: Cannot claim installation by another user';
    END IF;

    INSERT INTO bot_server_permissions (
        bot_id, server_id, installed_by, is_active
    ) VALUES (
        p_bot_id, p_server_id, p_installed_by, true
    ) RETURNING id INTO v_permission_id;
    
    RETURN v_permission_id;
END;
$$;

-- Delete server with cleanup
CREATE OR REPLACE FUNCTION public.delete_server_with_cleanup(p_server_id uuid, p_owner_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_caller_profile_id uuid;
BEGIN
    -- SECURITY: Get caller's profile ID
    SELECT id INTO v_caller_profile_id FROM profiles WHERE auth_user_id = auth.uid();
    
    IF v_caller_profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required';
    END IF;
    
    -- SECURITY: Verify p_owner_id matches the caller
    IF v_caller_profile_id != p_owner_id THEN
        RAISE EXCEPTION 'Unauthorized: Cannot delete server as another user';
    END IF;
    
    -- Verify caller is actually the owner
    IF NOT EXISTS (SELECT 1 FROM servers WHERE id = p_server_id AND owner = v_caller_profile_id) THEN
        RAISE EXCEPTION 'Not authorized to delete this server';
    END IF;
    
    -- Delete all related data (cascades handle most)
    DELETE FROM servers WHERE id = p_server_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- THREAD RPC FUNCTIONS
-- ---------------------------------------------------------------------------

-- Create thread from message
CREATE OR REPLACE FUNCTION public.create_thread(
    p_message_id uuid,
    p_name text,
    p_auto_archive_duration integer DEFAULT 1440
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_thread_id uuid;
    v_channel_id uuid;
    v_server_id uuid;
    v_caller_profile_id uuid;
BEGIN
    -- SECURITY: Get caller's profile ID
    SELECT id INTO v_caller_profile_id FROM profiles WHERE auth_user_id = auth.uid();
    
    IF v_caller_profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required';
    END IF;

    SELECT channel_id INTO v_channel_id
    FROM messages WHERE id = p_message_id;
    
    IF v_channel_id IS NULL THEN
        RAISE EXCEPTION 'Message not found or not in a channel';
    END IF;
    
    -- SECURITY: Verify caller is a member of the server containing this channel
    SELECT server_id INTO v_server_id FROM channels WHERE id = v_channel_id;
    
    IF NOT EXISTS (
        SELECT 1 FROM user_servers 
        WHERE server_id = v_server_id 
          AND user_id = v_caller_profile_id 
          AND status = 'accepted'
    ) THEN
        RAISE EXCEPTION 'Unauthorized: You must be a server member to create threads';
    END IF;
    
    INSERT INTO threads (
        channel_id, parent_message_id, name, created_by, auto_archive_duration
    ) VALUES (
        v_channel_id, p_message_id, p_name, v_caller_profile_id, p_auto_archive_duration
    ) RETURNING id INTO v_thread_id;
    
    -- Add caller as thread member
    INSERT INTO thread_members (thread_id, user_id)
    VALUES (v_thread_id, v_caller_profile_id);
    
    RETURN v_thread_id;
END;
$$;

-- Auto-archive inactive threads
CREATE OR REPLACE FUNCTION public.auto_archive_threads()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE threads
    SET archived = true, archived_at = NOW()
    WHERE NOT archived
      AND NOT locked
      AND last_message_at < NOW() - (auto_archive_duration || ' minutes')::interval;
END;
$$;

-- ---------------------------------------------------------------------------
-- ENCRYPTION RPC FUNCTIONS
-- ---------------------------------------------------------------------------

-- Initialize user encryption
-- Note: Parameters named for clarity, but map to table columns:
--   p_identity_key -> identity_key
--   p_signed_prekey -> signed_prekey  
--   p_signed_prekey_signature -> signed_prekey_signature
CREATE OR REPLACE FUNCTION public.initialize_user_encryption(
    p_user_id uuid,
    p_identity_key text,
    p_signed_prekey text,
    p_signed_prekey_signature text,
    p_device_id text DEFAULT 'default'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_key_pair_id UUID;
BEGIN
    -- SECURITY: Verify the caller owns this profile
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = p_user_id AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot initialize encryption for another user';
    END IF;
    
    IF EXISTS (SELECT 1 FROM user_key_pairs WHERE user_id = p_user_id AND device_id = p_device_id) THEN
        RAISE EXCEPTION 'Encryption already initialized for this device';
    END IF;
    
    INSERT INTO user_key_pairs (
        user_id, device_id, identity_key, signed_prekey, signed_prekey_signature
    ) VALUES (
        p_user_id, p_device_id, p_identity_key, p_signed_prekey, p_signed_prekey_signature
    ) RETURNING id INTO v_key_pair_id;
    
    RETURN jsonb_build_object('success', true, 'key_pair_id', v_key_pair_id, 'device_id', p_device_id);
END;
$$;

-- Add user prekeys
CREATE OR REPLACE FUNCTION public.add_user_prekeys(
    p_user_id uuid,
    p_device_id text,
    p_prekeys jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_prekey JSONB;
    v_inserted_count INTEGER := 0;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = p_user_id AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized';
    END IF;
    
    FOR v_prekey IN SELECT * FROM jsonb_array_elements(p_prekeys)
    LOOP
        INSERT INTO prekeys (user_id, device_id, prekey_id, public_key, is_signed, signature, is_one_time)
        VALUES (
            p_user_id, p_device_id,
            (v_prekey->>'prekey_id')::integer,
            v_prekey->>'public_key',
            COALESCE((v_prekey->>'is_signed')::boolean, false),
            v_prekey->>'signature',
            COALESCE((v_prekey->>'is_one_time')::boolean, true)
        )
        ON CONFLICT (user_id, device_id, prekey_id) DO UPDATE
        SET public_key = EXCLUDED.public_key, signature = EXCLUDED.signature;
        
        v_inserted_count := v_inserted_count + 1;
    END LOOP;
    
    RETURN v_inserted_count;
END;
$$;

-- Get unused prekey
-- Note: Table uses used_at timestamp instead of is_used boolean
CREATE OR REPLACE FUNCTION public.get_unused_prekey(p_user_id uuid, p_device_id text DEFAULT 'default')
RETURNS prekeys
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_prekey prekeys;
BEGIN
    -- Get an unused one-time prekey (used_at IS NULL means unused)
    SELECT * INTO v_prekey
    FROM prekeys
    WHERE user_id = p_user_id
      AND device_id = p_device_id
      AND is_one_time = true
      AND used_at IS NULL
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
    
    -- Mark as used
    IF v_prekey IS NOT NULL THEN
        UPDATE prekeys
        SET used_at = NOW()
        WHERE id = v_prekey.id;
    END IF;
    
    RETURN v_prekey;
END;
$$;

-- Enable conversation encryption
CREATE OR REPLACE FUNCTION public.enable_conversation_encryption(p_conversation_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_caller_profile_id uuid;
BEGIN
    -- SECURITY: Get caller's profile ID
    SELECT id INTO v_caller_profile_id FROM profiles WHERE auth_user_id = auth.uid();
    
    IF v_caller_profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required';
    END IF;
    
    -- SECURITY: Verify caller is a participant in the conversation
    IF NOT EXISTS (
        SELECT 1 FROM conversation_participants 
        WHERE conversation_id = p_conversation_id 
          AND user_id = v_caller_profile_id
          AND left_at IS NULL
    ) THEN
        RAISE EXCEPTION 'Unauthorized: You must be a participant to modify encryption settings';
    END IF;

    INSERT INTO conversation_encryption_settings (conversation_id, encryption_enabled)
    VALUES (p_conversation_id, true)
    ON CONFLICT (conversation_id) DO UPDATE SET encryption_enabled = true, updated_at = NOW();
    
    RETURN jsonb_build_object('success', true, 'conversation_id', p_conversation_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- NOTIFICATION RPC FUNCTIONS
-- ---------------------------------------------------------------------------

-- Create notification with spam prevention
-- SECURITY: Only callable by authenticated users where source_user is themselves
-- This prevents users from creating fake notifications from other users
CREATE OR REPLACE FUNCTION public.create_notification_with_spam_prevention(
    p_user_id uuid,
    p_type text,
    p_source_user_id uuid,
    p_title text DEFAULT NULL,
    p_message text DEFAULT NULL,
    p_data jsonb DEFAULT '{}',
    p_server_id uuid DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_notification_id uuid;
    v_caller_profile_id uuid;
BEGIN
    -- SECURITY: Get caller's profile ID
    SELECT id INTO v_caller_profile_id FROM profiles WHERE auth_user_id = auth.uid();
    
    IF v_caller_profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required';
    END IF;
    
    -- SECURITY: Source user must be the caller (prevent impersonation)
    IF p_source_user_id != v_caller_profile_id THEN
        RAISE EXCEPTION 'Unauthorized: Cannot create notifications from another user';
    END IF;
    
    INSERT INTO notifications (user_id, type, title, message, data, metadata)
    VALUES (
        p_user_id, p_type, p_title, p_message, p_data,
        jsonb_build_object(
            'source_user_id', p_source_user_id,
            'server_id', p_server_id,
            'channel_id', p_channel_id,
            'conversation_id', p_conversation_id
        )
    ) RETURNING id INTO v_notification_id;
    
    RETURN v_notification_id;
END;
$$;

-- Create structured notification
-- SECURITY: This function is for internal/trigger use only
-- Regular users should use create_notification_with_spam_prevention instead
-- Revoke authenticated grant - only service_role can call this directly
CREATE OR REPLACE FUNCTION public.create_notification_structured(
    p_user_id uuid,
    p_type varchar,
    p_data jsonb DEFAULT '{}'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    notification_id UUID;
    v_caller_profile_id uuid;
BEGIN
    -- SECURITY: Get caller's profile - if authenticated user, verify they're admin or the notification is for them
    SELECT id INTO v_caller_profile_id FROM profiles WHERE auth_user_id = auth.uid();
    
    -- Allow if: caller is admin, or notification target is the caller (self-notification)
    IF v_caller_profile_id IS NOT NULL THEN
        IF v_caller_profile_id != p_user_id AND NOT EXISTS (
            SELECT 1 FROM profiles WHERE id = v_caller_profile_id AND is_admin = true
        ) THEN
            RAISE EXCEPTION 'Unauthorized: Cannot create notifications for other users';
        END IF;
    END IF;
    -- Note: service_role calls will have auth.uid() = NULL which is allowed

    INSERT INTO notifications (user_id, type, data)
    VALUES (p_user_id, p_type, p_data)
    RETURNING id INTO notification_id;
    
    RETURN notification_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- PINNED MESSAGES RPC
-- ---------------------------------------------------------------------------

-- Count pinned messages
CREATE OR REPLACE FUNCTION public.count_pinned_messages(
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
)
RETURNS integer
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN (
        SELECT COUNT(*)::integer
        FROM messages
        WHERE is_pinned = true
          AND is_deleted = false
          AND (p_channel_id IS NULL OR channel_id = p_channel_id)
          AND (p_conversation_id IS NULL OR conversation_id = p_conversation_id)
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- PUSH SUBSCRIPTION RPC
-- ---------------------------------------------------------------------------

-- Delete push subscription by endpoint
CREATE OR REPLACE FUNCTION public.delete_push_subscription_by_endpoint(p_endpoint text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
    DELETE FROM push_subscriptions WHERE endpoint = p_endpoint;
$$;

-- ---------------------------------------------------------------------------
-- SESSION RPC FUNCTIONS
-- ---------------------------------------------------------------------------

-- End user session
CREATE OR REPLACE FUNCTION public.end_user_session(p_session_token text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
    UPDATE user_sessions 
    SET ended_at = NOW(), is_active = false 
    WHERE session_token = p_session_token;
$$;

-- Cleanup stale sessions
CREATE OR REPLACE FUNCTION public.cleanup_stale_user_sessions()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    deleted_count integer;
BEGIN
    DELETE FROM user_sessions
    WHERE is_active = true
      AND last_active_at < NOW() - INTERVAL '30 days'
    RETURNING 1 INTO deleted_count;
    
    RETURN COALESCE(deleted_count, 0);
END;
$$;

-- ---------------------------------------------------------------------------
-- CLEANUP RPC FUNCTIONS
-- ---------------------------------------------------------------------------

-- Cleanup old notifications
CREATE OR REPLACE FUNCTION public.cleanup_old_notifications()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    deleted_count integer;
BEGIN
    DELETE FROM notifications
    WHERE created_at < NOW() - INTERVAL '90 days'
      AND read = true;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

-- Cleanup expired voice calls
CREATE OR REPLACE FUNCTION public.cleanup_expired_voice_calls()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE federated_voice_calls
    SET status = 'ended', ended_at = NOW()
    WHERE status = 'active'
      AND created_at < NOW() - INTERVAL '4 hours';
END;
$$;

-- Cleanup stale voice participants
CREATE OR REPLACE FUNCTION public.cleanup_stale_voice_participants()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    DELETE FROM voice_channel_participants
    WHERE joined_at < NOW() - INTERVAL '24 hours';
END;
$$;

-- Cleanup old trending data
CREATE OR REPLACE FUNCTION public.cleanup_old_trending_data()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    deleted_count integer := 0;
BEGIN
    DELETE FROM trending_posts WHERE period_end < NOW() - INTERVAL '30 days';
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    DELETE FROM trending_users WHERE period_end < NOW() - INTERVAL '30 days';
    
    RETURN deleted_count;
END;
$$;

-- Cleanup expired statuses
CREATE OR REPLACE FUNCTION public.cleanup_expired_statuses()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    cleared_count integer;
BEGIN
    UPDATE profiles
    SET custom_status = NULL
    WHERE custom_status IS NOT NULL
      AND (custom_status->>'expires_at')::timestamptz < NOW();
    
    GET DIAGNOSTICS cleared_count = ROW_COUNT;
    RETURN cleared_count;
END;
$$;

-- Cleanup stale push subscriptions
CREATE OR REPLACE FUNCTION public.cleanup_stale_push_subscriptions()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    deleted_count integer;
BEGIN
    DELETE FROM push_subscriptions
    WHERE updated_at < NOW() - INTERVAL '90 days';
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- EMOJI RPC FUNCTIONS
-- ---------------------------------------------------------------------------

-- Get emoji metadata bulk
CREATE OR REPLACE FUNCTION public.get_emoji_metadata_bulk(server_ids uuid[])
RETURNS TABLE(server_id uuid, last_modified timestamptz, emoji_count integer)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.server_id,
        COALESCE(MAX(e.updated_at), MAX(e.created_at)) as last_modified,
        COUNT(e.id)::integer as emoji_count
    FROM emojis e
    WHERE e.server_id = ANY(server_ids)
    GROUP BY e.server_id;
END;
$$;

-- Create federated emoji
CREATE OR REPLACE FUNCTION public.create_federated_emoji(
    p_name text,
    p_url text,
    p_uploader uuid,
    p_domain text DEFAULT NULL
)
RETURNS TABLE(id uuid, created_at timestamptz, name varchar, url varchar, server_id uuid, uploader uuid, updated_at timestamptz, usage_count integer, last_used timestamptz, domain text)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    INSERT INTO emojis (name, url, uploader, domain)
    VALUES (p_name, p_url, p_uploader, p_domain)
    RETURNING emojis.id, emojis.created_at, emojis.name, emojis.url, emojis.server_id, 
              emojis.uploader, emojis.updated_at, emojis.usage_count, emojis.last_used, emojis.domain;
END;
$$;

-- ---------------------------------------------------------------------------
-- ADMIN RPC FUNCTIONS
-- ---------------------------------------------------------------------------

-- Log admin action
CREATE OR REPLACE FUNCTION public.log_admin_action(
    p_admin_id uuid,
    p_action_type text,
    p_target_type text,
    p_target_id text,
    p_details jsonb DEFAULT '{}'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_log_id uuid;
BEGIN
    INSERT INTO admin_audit_log (admin_id, action_type, target_type, target_id, details)
    VALUES (p_admin_id, p_action_type, p_target_type, p_target_id, p_details)
    RETURNING id INTO v_log_id;
    
    RETURN v_log_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- GRANTS
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.create_group_conversation(uuid, uuid[], text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_or_get_multi_conversation(uuid[], text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_timeline(uuid, integer, timestamp) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_trending_hashtags(integer, integer) TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.add_post_emoji_reaction(uuid, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_batch_post_reactions(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_batch_message_reactions(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_bot_to_server(uuid, uuid, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_thread(uuid, text, integer) TO authenticated;
-- Updated signature: (user_id, identity_key, signed_prekey, signed_prekey_signature, device_id)
GRANT EXECUTE ON FUNCTION public.initialize_user_encryption(uuid, text, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_user_prekeys(uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_unused_prekey(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.enable_conversation_encryption(uuid) TO authenticated;
-- Notification functions - create_notification_structured has security checks, service_role can always call
GRANT EXECUTE ON FUNCTION public.create_notification_structured(uuid, varchar, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_notification_with_spam_prevention(uuid, text, uuid, text, text, jsonb, uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.count_pinned_messages(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_emoji_metadata_bulk(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_federated_emoji(text, text, uuid, text) TO authenticated;

DO $$
BEGIN
    RAISE NOTICE 'RPC functions created successfully';
END $$;

