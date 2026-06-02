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
    p_creator_user_id uuid,
    p_participant_ids uuid[] DEFAULT '{}',
    p_conversation_name text DEFAULT NULL,
    p_is_private boolean DEFAULT true
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_conversation_id uuid;
    v_participant_id uuid;
BEGIN
    -- SECURITY: Verify the caller is the creator
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = p_creator_user_id AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: You can only create conversations as yourself';
    END IF;

    INSERT INTO conversations (type, name, created_by, metadata)
    VALUES (
        'group',
        p_conversation_name,
        p_creator_user_id,
        jsonb_build_object('is_private', p_is_private)
    )
    RETURNING id INTO v_conversation_id;

    -- Add creator as admin
    INSERT INTO conversation_participants (conversation_id, user_id, role)
    VALUES (v_conversation_id, p_creator_user_id, 'admin');

    -- Add other participants
    IF p_participant_ids IS NOT NULL THEN
        FOREACH v_participant_id IN ARRAY p_participant_ids
        LOOP
            IF v_participant_id != p_creator_user_id THEN
                INSERT INTO conversation_participants (conversation_id, user_id, role)
                VALUES (v_conversation_id, v_participant_id, 'member')
                ON CONFLICT (conversation_id, user_id) DO NOTHING;
            END IF;
        END LOOP;
    END IF;

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
SET search_path = public
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
-- Trending hashtags over an arbitrary hours window, with rising/falling trend
-- computed against the immediately-preceding window of equal length. The
-- frontend passes the selected time range (1h/6h/24h/7d/30d) as hours so the
-- "Last X" filter is honored at hashtag granularity.
CREATE OR REPLACE FUNCTION public.get_trending_hashtags(
    p_hours integer DEFAULT 168,
    p_limit integer DEFAULT 20
)
RETURNS TABLE(
    tag text,
    uses_count bigint,
    unique_users bigint,
    change_percent numeric,
    trend text
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_current_start timestamptz;
    v_previous_start timestamptz;
BEGIN
    v_current_start := NOW() - (p_hours || ' hours')::INTERVAL;
    v_previous_start := NOW() - (p_hours * 2 || ' hours')::INTERVAL;

    RETURN QUERY
    WITH current_period AS (
        SELECT
            h.tag AS htag,
            COUNT(*) AS current_uses,
            COUNT(DISTINCT p.author_id) AS current_unique_users
        FROM post_hashtags ph
        JOIN hashtags h ON ph.hashtag_id = h.id
        JOIN posts p ON ph.post_id = p.id
        WHERE ph.created_at > v_current_start
        GROUP BY h.tag
    ),
    previous_period AS (
        SELECT
            h.tag AS htag,
            COUNT(*) AS previous_uses
        FROM post_hashtags ph
        JOIN hashtags h ON ph.hashtag_id = h.id
        JOIN posts p ON ph.post_id = p.id
        WHERE ph.created_at > v_previous_start
          AND ph.created_at <= v_current_start
        GROUP BY h.tag
    )
    SELECT
        cp.htag AS tag,
        cp.current_uses AS uses_count,
        cp.current_unique_users AS unique_users,
        CASE
            WHEN COALESCE(pp.previous_uses, 0) = 0 THEN
                CASE WHEN cp.current_uses > 0 THEN 100.0 ELSE 0.0 END
            ELSE
                ROUND(((cp.current_uses::numeric - pp.previous_uses::numeric) / pp.previous_uses::numeric) * 100, 1)
        END AS change_percent,
        CASE
            WHEN COALESCE(pp.previous_uses, 0) = 0 AND cp.current_uses > 0 THEN 'rising'
            WHEN cp.current_uses > COALESCE(pp.previous_uses, 0) * 1.05 THEN 'rising'
            WHEN cp.current_uses < COALESCE(pp.previous_uses, 0) * 0.95 THEN 'falling'
            ELSE 'stable'
        END AS trend
    FROM current_period cp
    LEFT JOIN previous_period pp ON cp.htag = pp.htag
    ORDER BY cp.current_uses DESC
    LIMIT p_limit;
END;
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
SET search_path = public
AS $$
DECLARE
    v_interaction_id uuid;
    v_resolved_content text;
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

    -- Auto-populate custom_emoji_content from emoji table when missing
    v_resolved_content := p_custom_emoji_content;
    IF p_emoji_id IS NOT NULL AND v_resolved_content IS NULL THEN
        SELECT CASE
            WHEN e.url IS NOT NULL THEN ':' || e.name || ':'
            ELSE e.name
        END INTO v_resolved_content
        FROM emojis e WHERE e.id = p_emoji_id;
    END IF;

    INSERT INTO post_interactions (
        user_id, post_id, interaction_type,
        emoji_id, custom_emoji_content, is_local
    ) VALUES (
        p_user_id, p_post_id, 'emoji_reaction',
        p_emoji_id, v_resolved_content, true
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

-- Get batch message reactions (matching production)
CREATE OR REPLACE FUNCTION public.get_batch_message_reactions(message_ids uuid[])
RETURNS TABLE(
    message_id uuid,
    emoji_id uuid,
    emoji_name character varying,
    emoji_url character varying,
    custom_emoji_content text,
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
        COALESCE(e.name, r.custom_emoji_content)::varchar as emoji_name,
        e.url::varchar as emoji_url,
        r.custom_emoji_content,
        COUNT(r.id)::bigint as reaction_count,
        jsonb_agg(
            jsonb_build_object(
                'user_id', r.user_id,
                'bot_id', r.bot_id,
                'metadata', r.metadata
            )
        ) as users
    FROM reactions r
    LEFT JOIN emojis e ON r.emoji_id = e.id
    WHERE r.message_id = ANY(get_batch_message_reactions.message_ids)
    GROUP BY r.message_id, r.emoji_id, e.name, e.url, r.custom_emoji_content
    ORDER BY r.message_id, MIN(r.created_at) ASC;
END;
$$;

COMMENT ON FUNCTION public.get_batch_message_reactions(message_ids uuid[]) IS 'Batch fetch reactions for multiple messages including metadata for bridged users';

-- Get reactions for a single message (singular version)
CREATE OR REPLACE FUNCTION public.get_message_reactions(message_id uuid) 
RETURNS TABLE(count bigint, emoji jsonb, reactions jsonb, message_id_of_reactions uuid)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(r.id)::bigint as count,
        CASE 
            WHEN r.emoji_id IS NOT NULL THEN
                -- Custom server emoji - use emoji table data
                jsonb_build_object(
                    'id', e.id,
                    'name', e.name,
                    'url', e.url,
                    'is_native', false
                )
            ELSE
                -- Native unicode emoji - use custom_emoji_content
                jsonb_build_object(
                    'id', r.custom_emoji_content,
                    'name', r.custom_emoji_content,
                    'url', NULL,
                    'content', r.custom_emoji_content,
                    'is_native', true
                )
        END as emoji,
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'user_id', r2.user_id,
                    'bot_id', r2.bot_id,
                    'metadata', r2.metadata,
                    'username', p.username,
                    'display_name', p.display_name,
                    'avatar_url', p.avatar_url
                )
            )
            FROM reactions r2
            LEFT JOIN profiles p ON r2.user_id = p.id
            WHERE r2.message_id = get_message_reactions.message_id
            AND (
                (r2.emoji_id IS NOT DISTINCT FROM r.emoji_id)
                AND (r2.custom_emoji_content IS NOT DISTINCT FROM r.custom_emoji_content)
            )
        ) as reactions,
        r.message_id as message_id_of_reactions
    FROM reactions r
    LEFT JOIN emojis e ON r.emoji_id = e.id
    WHERE r.message_id = get_message_reactions.message_id
    GROUP BY r.message_id, r.emoji_id, e.id, e.name, e.url, r.custom_emoji_content
    ORDER BY MIN(r.created_at) ASC;
END;
$$;

COMMENT ON FUNCTION public.get_message_reactions(message_id uuid) IS 'Returns reaction groups for a message including metadata for bridged users (Discord, etc.)';

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
SET search_path = public
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
SET search_path = public
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
SET search_path = public
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
SET search_path = public
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

-- Initialize user encryption (Megolm-style key pairs)
CREATE OR REPLACE FUNCTION public.initialize_user_encryption(
    p_user_id uuid,
    p_identity_public_key text,
    p_identity_private_key_encrypted text,
    p_device_id text DEFAULT 'default'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
        user_id, device_id, identity_public_key, identity_private_key_encrypted, key_version, is_active
    ) VALUES (
        p_user_id, p_device_id, p_identity_public_key, p_identity_private_key_encrypted, 1, true
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
SET search_path = public
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
SET search_path = public
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
SET search_path = public
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
-- SECURITY: Validates caller identity - p_source_user_id must match the authenticated user.
-- Uses rate limiting for reaction notifications to avoid spam.
-- Delegates to send_notification_to_user for the actual insert.
CREATE OR REPLACE FUNCTION public.create_notification_with_spam_prevention(
    p_user_id uuid,
    p_type text,
    p_source_user_id uuid,
    p_title text DEFAULT NULL,
    p_message text DEFAULT NULL,
    p_data jsonb DEFAULT '{}'::jsonb,
    p_server_id uuid DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_notification_id uuid;
    v_caller_profile_id uuid;
    v_rate_limit RECORD;
    v_should_suppress boolean := false;
    v_time_threshold timestamp with time zone := NOW() - INTERVAL '2 minutes';
BEGIN
    -- SECURITY: Verify caller identity
    SELECT id INTO v_caller_profile_id FROM profiles WHERE auth_user_id = auth.uid();

    IF v_caller_profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required';
    END IF;

    IF p_source_user_id != v_caller_profile_id THEN
        RAISE EXCEPTION 'Unauthorized: Cannot create notifications from another user';
    END IF;

    IF p_type = 'reaction' AND p_source_user_id IS NOT NULL THEN
        INSERT INTO notification_rate_limits (user_id, notification_type, source_user_id,
                                              notification_count, last_notification_at, suppressed_until)
        VALUES (p_user_id, p_type, p_source_user_id, 1, NOW(), NULL)
        ON CONFLICT (user_id, notification_type, source_user_id)
        DO UPDATE SET
            notification_count = CASE
                WHEN notification_rate_limits.last_notification_at < v_time_threshold
                THEN 1
                ELSE notification_rate_limits.notification_count + 1
            END,
            last_notification_at = NOW(),
            suppressed_until = CASE
                WHEN notification_rate_limits.last_notification_at < v_time_threshold
                THEN NULL
                ELSE notification_rate_limits.suppressed_until
            END
        RETURNING * INTO v_rate_limit;

        SELECT
            notification_count > 3 OR
            (suppressed_until IS NOT NULL AND suppressed_until > NOW())
        INTO v_should_suppress
        FROM notification_rate_limits
        WHERE user_id = p_user_id AND notification_type = p_type AND source_user_id = p_source_user_id;

        IF v_should_suppress THEN
            UPDATE notification_rate_limits
            SET suppressed_until = NOW() + INTERVAL '2 minutes'
            WHERE user_id = p_user_id AND notification_type = p_type AND source_user_id = p_source_user_id;
            RETURN NULL;
        END IF;
    END IF;

    SELECT send_notification_to_user(
        p_type,
        p_user_id,
        p_data,
        p_server_id,
        p_channel_id,
        p_conversation_id,
        p_source_user_id,
        'normal'
    ) INTO v_notification_id;

    RETURN v_notification_id;
END;
$$;

COMMENT ON FUNCTION public.create_notification_with_spam_prevention IS
'Creates notifications with spam prevention. Suppresses repeated notifications from same source within time windows.';

-- Create structured notification
-- SECURITY: Caller must be the target user, an admin, or service_role.
CREATE OR REPLACE FUNCTION public.create_notification_structured(
    p_user_id uuid,
    p_type varchar,
    p_data jsonb DEFAULT '{}'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    notification_id UUID;
    v_caller_profile_id uuid;
BEGIN
    SELECT id INTO v_caller_profile_id FROM profiles WHERE auth_user_id = auth.uid();

    -- Allow service_role (auth.uid() IS NULL) or self-notification or admin
    IF v_caller_profile_id IS NOT NULL THEN
        IF v_caller_profile_id != p_user_id AND NOT EXISTS (
            SELECT 1 FROM profiles WHERE id = v_caller_profile_id AND is_admin = true
        ) THEN
            RAISE EXCEPTION 'Unauthorized: Cannot create notifications for other users';
        END IF;
    END IF;

    INSERT INTO notifications (user_id, type, data, created_at, is_read)
    VALUES (p_user_id, p_type, p_data, NOW(), false)
    RETURNING id INTO notification_id;

    RETURN notification_id;
END;
$$;

COMMENT ON FUNCTION public.create_notification_structured IS 'Create notification with structured data';

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
SET search_path = public
AS $$
    DELETE FROM push_subscriptions WHERE endpoint = p_endpoint;
$$;

-- ---------------------------------------------------------------------------
-- SESSION RPC FUNCTIONS
-- ---------------------------------------------------------------------------

-- End user session
-- Uses session_token for identification
CREATE OR REPLACE FUNCTION public.end_user_session(p_user_id uuid, p_session_token text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller_profile_id uuid;
BEGIN
    -- SECURITY: Get caller's profile ID
    SELECT id INTO v_caller_profile_id FROM profiles WHERE auth_user_id = auth.uid();
    
    -- Only allow ending your own sessions
    IF v_caller_profile_id IS NULL OR v_caller_profile_id != p_user_id THEN
        RAISE EXCEPTION 'Unauthorized: Cannot end another user''s session';
    END IF;

    UPDATE user_sessions 
    SET is_active = false, status = 'offline'
    WHERE user_id = p_user_id AND session_token = p_session_token;
END;
$$;

-- Update session heartbeat (keep session alive)
CREATE OR REPLACE FUNCTION public.update_session_heartbeat(
    p_session_token text,
    p_status text DEFAULT 'online'
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller_profile_id uuid;
BEGIN
    SELECT id INTO v_caller_profile_id FROM profiles WHERE auth_user_id = auth.uid();
    
    IF v_caller_profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required';
    END IF;

    UPDATE user_sessions 
    SET last_heartbeat = NOW(), 
        status = p_status,
        is_active = true
    WHERE user_id = v_caller_profile_id AND session_token = p_session_token;
END;
$$;

-- Update session context (what user is viewing)
CREATE OR REPLACE FUNCTION public.update_session_context(
    p_session_token text,
    p_server_id uuid DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_caller_profile_id uuid;
BEGIN
    SELECT id INTO v_caller_profile_id FROM profiles WHERE auth_user_id = auth.uid();
    
    IF v_caller_profile_id IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required';
    END IF;

    UPDATE user_sessions 
    SET current_server_id = p_server_id,
        current_channel_id = p_channel_id,
        current_conversation_id = p_conversation_id,
        last_activity = NOW()
    WHERE user_id = v_caller_profile_id AND session_token = p_session_token;
END;
$$;

-- Cleanup stale sessions
-- Uses last_activity for determining staleness
CREATE OR REPLACE FUNCTION public.cleanup_stale_user_sessions()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    deleted_count integer;
BEGIN
    -- Mark old sessions as inactive first
    UPDATE user_sessions
    SET is_active = false, status = 'offline'
    WHERE is_active = true
      AND last_activity < NOW() - INTERVAL '30 days';
    
    -- Delete very old sessions
    DELETE FROM user_sessions
    WHERE last_activity < NOW() - INTERVAL '90 days';
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
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
      AND is_read = true;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;

-- Cleanup expired voice calls
-- Note: federated_voice_calls uses started_at and ended_at, no status column
CREATE OR REPLACE FUNCTION public.cleanup_expired_voice_calls()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Mark calls as ended if started more than 4 hours ago and not already ended
    UPDATE federated_voice_calls
    SET ended_at = NOW()
    WHERE ended_at IS NULL
      AND started_at < NOW() - INTERVAL '4 hours';
END;
$$;

-- Cleanup stale voice participants
CREATE OR REPLACE FUNCTION public.cleanup_stale_voice_participants()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
SET search_path = public
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
-- Note: emojis table only has created_at, not updated_at
CREATE OR REPLACE FUNCTION public.get_emoji_metadata_bulk(server_ids uuid[])
RETURNS TABLE(server_id uuid, last_modified timestamptz, emoji_count integer)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.server_id,
        MAX(e.created_at) as last_modified,
        COUNT(e.id)::integer as emoji_count
    FROM emojis e
    WHERE e.server_id = ANY(server_ids)
    GROUP BY e.server_id;
END;
$$;

-- Create federated emoji
-- Note: emojis table uses created_by (not uploader), and doesn't have updated_at, usage_count, last_used
CREATE OR REPLACE FUNCTION public.create_federated_emoji(
    p_name text,
    p_url text,
    p_created_by uuid,
    p_domain text DEFAULT NULL
)
RETURNS TABLE(id uuid, created_at timestamptz, name text, url text, server_id uuid, created_by uuid, domain text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    INSERT INTO emojis (name, url, created_by, domain)
    VALUES (p_name, p_url, p_created_by, p_domain)
    RETURNING emojis.id, emojis.created_at, emojis.name, emojis.url, emojis.server_id, 
              emojis.created_by, emojis.domain;
END;
$$;

-- ---------------------------------------------------------------------------
-- ADMIN RPC FUNCTIONS
-- ---------------------------------------------------------------------------

-- Log admin action (single canonical signature - must match production)
CREATE OR REPLACE FUNCTION public.log_admin_action(
    p_admin_id uuid,
    p_action_type text,
    p_target_type text DEFAULT NULL::text,
    p_target_id text DEFAULT NULL::text,
    p_action_details jsonb DEFAULT NULL::jsonb,
    p_ip_address inet DEFAULT NULL::inet,
    p_user_agent text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_log_id uuid;
BEGIN
    INSERT INTO admin_audit_log (admin_id, action_type, target_type, target_id, action_details, ip_address, user_agent)
    VALUES (p_admin_id, p_action_type, p_target_type, p_target_id, p_action_details, p_ip_address, p_user_agent)
    RETURNING id INTO v_log_id;

    RETURN v_log_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- GRANTS
-- ---------------------------------------------------------------------------
-- Conversation functions
GRANT EXECUTE ON FUNCTION public.create_group_conversation(uuid, uuid[], text, boolean) TO authenticated;
-- Timeline functions
GRANT EXECUTE ON FUNCTION public.get_timeline(uuid, integer, timestamp) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_trending_hashtags(integer, integer) TO authenticated, anon; -- get_trending_hashtags(p_hours, p_limit)
-- Post interaction functions
GRANT EXECUTE ON FUNCTION public.add_post_emoji_reaction(uuid, uuid, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_batch_post_reactions(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_batch_message_reactions(uuid[]) TO authenticated;
-- Server/bot functions
GRANT EXECUTE ON FUNCTION public.add_bot_to_server(uuid, uuid, uuid, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_thread(uuid, text, integer) TO authenticated;
-- Encryption functions
GRANT EXECUTE ON FUNCTION public.initialize_user_encryption(uuid, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.add_user_prekeys(uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_unused_prekey(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.enable_conversation_encryption(uuid) TO authenticated;
-- Notification functions (updated signatures to match table columns)
GRANT EXECUTE ON FUNCTION public.create_notification_structured(uuid, varchar, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_notification_with_spam_prevention(uuid, text, uuid, text, text, jsonb, uuid, uuid, uuid) TO authenticated;
-- Other functions
GRANT EXECUTE ON FUNCTION public.count_pinned_messages(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_emoji_metadata_bulk(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_federated_emoji(text, text, uuid, text) TO authenticated;
-- Session functions
GRANT EXECUTE ON FUNCTION public.end_user_session(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_session_heartbeat(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_session_context(text, uuid, uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- REPORTS RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_pending_reports_count()
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Moderation queue is admin/moderator-only. The table RLS already blocks
    -- direct SELECT; this SECURITY DEFINER RPC must enforce the same gate or it
    -- leaks the full report queue to any authenticated user.
    IF NOT public.is_current_user_admin_or_mod() THEN
        RAISE EXCEPTION 'Permission denied: moderator access required'
            USING ERRCODE = '42501';
    END IF;
    RETURN (SELECT COUNT(*)::integer FROM public.reports WHERE status = 'pending');
END;
$$;

CREATE OR REPLACE FUNCTION public.get_reports_with_details(
    p_status text DEFAULT NULL,
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0
)
RETURNS TABLE(
    id uuid,
    reporter_id uuid,
    reported_user_id uuid,
    reported_message_id uuid,
    reported_post_id uuid,
    reporter_username text,
    reporter_display_name text,
    reporter_avatar_url text,
    reporter_domain text,
    reporter_is_local boolean,
    reported_user_username text,
    reported_user_display_name text,
    reported_user_avatar_url text,
    reported_user_domain text,
    reported_user_is_local boolean,
    reported_post_preview text,
    reported_post_ap_id text,
    reported_post_url text,
    reported_post_is_sensitive boolean,
    reported_post_content_warning text,
    reported_message_preview text,
    reason text,
    comment text,
    report_type text,
    source text,
    source_instance text,
    status text,
    resolution_note text,
    created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Moderation queue is admin/moderator-only (mirrors reports table RLS).
    IF NOT public.is_current_user_admin_or_mod() THEN
        RAISE EXCEPTION 'Permission denied: moderator access required'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        r.id,
        r.reporter_id,
        r.reported_user_id,
        r.reported_message_id,
        r.reported_post_id,
        reporter.username::text,
        reporter.display_name::text,
        reporter.avatar_url::text,
        reporter.domain::text,
        COALESCE(reporter.is_local, true),
        reported_user.username::text,
        reported_user.display_name::text,
        reported_user.avatar_url::text,
        reported_user.domain::text,
        COALESCE(reported_user.is_local, true),
        CASE
            WHEN r.reported_post_id IS NOT NULL THEN
                LEFT(
                    COALESCE(
                        (SELECT string_agg(
                            CASE
                                WHEN part->>'type' = 'text' THEN COALESCE(part->>'text', '')
                                WHEN part->>'type' = 'url' THEN COALESCE(part->>'url', '[link]')
                                WHEN part->>'type' = 'mention' THEN '@' || COALESCE(part->>'username', 'user')
                                WHEN part->>'type' = 'hashtag' THEN '#' || COALESCE(part->>'name', 'tag')
                                WHEN part->>'type' = 'emoji' THEN ':' || COALESCE(part->'emoji'->>'name', 'emoji') || ':'
                                ELSE ''
                            END, ' '
                        )
                        FROM public.posts p, jsonb_array_elements(p.content) AS part
                        WHERE p.id = r.reported_post_id),
                        '[Post content unavailable]'
                    ),
                    500
                )
            ELSE NULL
        END::text,
        CASE WHEN r.reported_post_id IS NOT NULL THEN
            (SELECT p.ap_id FROM public.posts p WHERE p.id = r.reported_post_id)
        ELSE NULL END::text,
        CASE WHEN r.reported_post_id IS NOT NULL THEN
            (SELECT p.url FROM public.posts p WHERE p.id = r.reported_post_id)
        ELSE NULL END::text,
        CASE WHEN r.reported_post_id IS NOT NULL THEN
            (SELECT p.is_sensitive FROM public.posts p WHERE p.id = r.reported_post_id)
        ELSE NULL END,
        CASE WHEN r.reported_post_id IS NOT NULL THEN
            (SELECT p.content_warning FROM public.posts p WHERE p.id = r.reported_post_id)
        ELSE NULL END::text,
        CASE
            WHEN r.reported_message_id IS NOT NULL THEN
                LEFT(
                    COALESCE(
                        (SELECT string_agg(
                            CASE
                                WHEN part->>'type' = 'text' THEN COALESCE(part->>'text', '')
                                WHEN part->>'type' = 'file' THEN '[' || COALESCE(part->>'fileType', 'file') || ': ' || COALESCE(part->>'filename', part->>'url', 'attachment') || ']'
                                WHEN part->>'type' = 'url' THEN COALESCE(part->>'url', '[link]')
                                WHEN part->>'type' = 'emoji' THEN COALESCE(part->'emoji'->>'name', ':emoji:')
                                WHEN part->>'type' = 'mention' THEN COALESCE(part->>'mention', '@user')
                                ELSE '[' || COALESCE(part->>'type', 'unknown') || ']'
                            END, ' '
                        )
                        FROM public.messages m, jsonb_array_elements(m.content) AS part
                        WHERE m.id = r.reported_message_id),
                        '[Message content unavailable]'
                    ),
                    300
                )
            ELSE NULL
        END::text,
        r.reason,
        r.comment,
        r.report_type,
        r.source,
        r.source_instance,
        r.status,
        r.resolution_note,
        r.created_at
    FROM public.reports r
    LEFT JOIN public.profiles reporter ON reporter.id = r.reporter_id
    LEFT JOIN public.profiles reported_user ON reported_user.id = r.reported_user_id
    WHERE (p_status IS NULL OR r.status = p_status)
    ORDER BY r.created_at DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

-- Admin post moderation (mark_sensitive, set_cw, delete)
CREATE OR REPLACE FUNCTION public.admin_moderate_post(
    p_post_id uuid,
    p_action text,
    p_value text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_admin_id uuid;
BEGIN
    SELECT id INTO v_admin_id
    FROM public.profiles
    WHERE auth_user_id = auth.uid()
      AND (is_admin = true OR is_moderator = true);

    IF v_admin_id IS NULL THEN
        RAISE EXCEPTION 'Insufficient permissions: admin or moderator role required';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.posts WHERE id = p_post_id) THEN
        RAISE EXCEPTION 'Post not found';
    END IF;

    IF p_action = 'mark_sensitive' THEN
        UPDATE public.posts SET is_sensitive = true WHERE id = p_post_id;
    ELSIF p_action = 'unmark_sensitive' THEN
        UPDATE public.posts SET is_sensitive = false WHERE id = p_post_id;
    ELSIF p_action = 'set_cw' THEN
        UPDATE public.posts SET content_warning = p_value WHERE id = p_post_id;
    ELSIF p_action = 'remove_cw' THEN
        UPDATE public.posts SET content_warning = NULL WHERE id = p_post_id;
    ELSIF p_action = 'delete' THEN
        UPDATE public.posts SET is_deleted = true, deleted_at = now() WHERE id = p_post_id;
    ELSE
        RAISE EXCEPTION 'Invalid action: %', p_action;
    END IF;

    PERFORM log_admin_action(
        v_admin_id,
        ('post_' || p_action)::text,
        'post'::text,
        p_post_id::text,
        jsonb_build_object('action', p_action, 'value', p_value)
    );

    RETURN true;
END;
$$;

-- Supporter badge RPC. INNER JOIN on tier (not LEFT) so users without a
-- qualifying tier_id get no badge at all (prevents the default-star bug
-- where a small donation rendered a generic supporter icon).
CREATE OR REPLACE FUNCTION public.get_supporter_badge(p_user_id uuid)
RETURNS TABLE(
    tier_name text,
    badge_icon text,
    badge_color text,
    is_active boolean
)
LANGUAGE sql STABLE
AS $$
    SELECT
        t.name AS tier_name,
        t.badge_icon,
        t.badge_color,
        s.is_active
    FROM public.instance_supporters s
    JOIN public.instance_supporter_tiers t ON t.id = s.tier_id
    WHERE s.user_id = p_user_id
      AND s.is_active = true
      AND s.tier_id IS NOT NULL
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
    LIMIT 1;
$$;

-- GIF ad decision. TRUE when the user should be shown GIF (Klipy) ads. The
-- federation backend calls this (service_role) to pick the ad-enabled vs
-- ad-free Klipy key; clients may call it to reflect ad-free status in the UI.
-- Ads are on unless the instance disabled them or the user holds an active
-- supporter tier flagged removes_ads.
CREATE OR REPLACE FUNCTION public.should_show_gif_ads(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT
        COALESCE((SELECT config_value::text = 'true'
                  FROM public.instance_config
                  WHERE config_key = 'gif_ads_enabled'), true)
        AND NOT EXISTS (
            SELECT 1
            FROM public.instance_supporters s
            JOIN public.instance_supporter_tiers t ON t.id = s.tier_id
            WHERE s.user_id = p_user_id
              AND s.is_active = true
              AND t.removes_ads = true
              AND (s.expires_at IS NULL OR s.expires_at > now())
        );
$$;

GRANT EXECUTE ON FUNCTION public.should_show_gif_ads(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.should_show_gif_ads(uuid) TO service_role;

-- Batched supporter badge RPC. Returns one row per user that actually has a
-- qualifying badge, keyed by user_id, so the client can resolve badges for an
-- entire chat view (every distinct author) in a single round-trip instead of
-- firing one get_supporter_badge call per user (the N+1 storm).
CREATE OR REPLACE FUNCTION public.get_supporter_badges(p_user_ids uuid[])
RETURNS TABLE(
    user_id uuid,
    tier_name text,
    badge_icon text,
    badge_color text,
    is_active boolean
)
LANGUAGE sql STABLE
AS $$
    SELECT DISTINCT ON (s.user_id)
        s.user_id,
        t.name AS tier_name,
        t.badge_icon,
        t.badge_color,
        s.is_active
    FROM public.instance_supporters s
    JOIN public.instance_supporter_tiers t ON t.id = s.tier_id
    WHERE s.user_id = ANY(p_user_ids)
      AND s.is_active = true
      AND s.tier_id IS NOT NULL
      AND (s.expires_at IS NULL OR s.expires_at > NOW())
    ORDER BY s.user_id, t.min_amount DESC NULLS LAST, s.started_at DESC;
$$;

GRANT EXECUTE ON FUNCTION public.get_supporter_badges(uuid[]) TO authenticated;

-- Funding total from donations (SECURITY DEFINER so any user can see aggregate)
CREATE OR REPLACE FUNCTION public.get_funding_current_total(p_period text DEFAULT 'monthly')
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(SUM(dh.amount), 0)::numeric
  FROM public.instance_donation_history dh
  WHERE
    (p_period = 'all')
    OR (p_period = 'monthly' AND dh.donated_at >= date_trunc('month', now())::timestamptz);
$$;

-- Report/funding grants
GRANT EXECUTE ON FUNCTION public.get_pending_reports_count() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_reports_with_details(text, integer, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_supporter_badge(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_funding_current_total(text) TO authenticated;

-- ---------------------------------------------------------------------------
-- Hide/dismiss a DM conversation for the current user (non-destructive).
-- Sets or clears `conversation_participants.hidden_at` for the caller.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_conversation_hidden(
    p_conversation_id uuid,
    p_hidden boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_profile_id uuid;
BEGIN
    v_profile_id := public.get_current_profile_id();
    IF v_profile_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    UPDATE public.conversation_participants
    SET hidden_at = CASE WHEN p_hidden THEN NOW() ELSE NULL END
    WHERE conversation_id = p_conversation_id
      AND user_id = v_profile_id
      AND left_at IS NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION public.set_conversation_hidden(uuid, boolean) TO authenticated;

DO $$
BEGIN
    RAISE NOTICE 'RPC functions created successfully';
END $$;

