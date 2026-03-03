-- =============================================================================
-- MISSING RPC FUNCTIONS - Extracted from supabase_minimal.sql
-- =============================================================================
-- These functions are used by the frontend but missing from the init schema
-- Run this after sync_with_production.sql
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Function: is_user_viewing_context
-- Checks if user is viewing a specific channel/DM. Used by send_notification
-- to suppress notifications at database level (Discord-like behavior).
-- Must be created BEFORE send_notification which depends on it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_user_viewing_context(
    p_user_id uuid,
    p_server_id uuid DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql STABLE
AS $$
DECLARE
    v_view_context RECORD;
BEGIN
    SELECT * INTO v_view_context
    FROM public.user_view_contexts
    WHERE user_id = p_user_id;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- Check if viewing the exact server channel
    IF p_server_id IS NOT NULL AND p_channel_id IS NOT NULL THEN
        IF v_view_context.view_type = 'server_channel' AND
           v_view_context.server_id = p_server_id AND
           v_view_context.channel_id = p_channel_id THEN
            RETURN TRUE;
        END IF;
    END IF;

    -- Check if viewing the exact DM conversation
    IF p_conversation_id IS NOT NULL THEN
        IF v_view_context.view_type = 'dm' AND
           v_view_context.conversation_id = p_conversation_id THEN
            RETURN TRUE;
        END IF;
    END IF;

    RETURN FALSE;
END;
$$;

COMMENT ON FUNCTION public.is_user_viewing_context(uuid, uuid, uuid, uuid)
IS 'Checks if user is viewing a specific channel/DM. Used by send_notification to suppress notifications at database level.';

-- ---------------------------------------------------------------------------
-- Function: sync_view_context_from_presence
-- Syncs ephemeral presence state to the user_view_contexts table so
-- is_user_viewing_context() can check it. Called from frontend on navigation.
-- Resolves auth.uid() to profiles.id since they are different UUIDs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_view_context_from_presence(
    p_view_type text,
    p_server_id uuid DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_auth_id UUID := auth.uid();
    v_profile_id UUID;
BEGIN
    IF v_auth_id IS NULL THEN
        RETURN;
    END IF;

    -- Resolve auth user ID to profile ID (they are different UUIDs)
    SELECT id INTO v_profile_id
    FROM public.profiles
    WHERE auth_user_id = v_auth_id
    LIMIT 1;

    IF v_profile_id IS NULL THEN
        RETURN;
    END IF;

    INSERT INTO public.user_view_contexts (user_id, view_type, server_id, channel_id, conversation_id, last_active_at)
    VALUES (v_profile_id, p_view_type, p_server_id, p_channel_id, p_conversation_id, NOW())
    ON CONFLICT (user_id) DO UPDATE
    SET
        view_type = EXCLUDED.view_type,
        server_id = EXCLUDED.server_id,
        channel_id = EXCLUDED.channel_id,
        conversation_id = EXCLUDED.conversation_id,
        last_active_at = EXCLUDED.last_active_at;
END;
$$;

COMMENT ON FUNCTION public.sync_view_context_from_presence(text, uuid, uuid, uuid)
IS 'Syncs ephemeral presence state to database table for PostgreSQL function access. Resolves auth.uid() to profiles.id before writing. Called from frontend when view context changes.';

GRANT EXECUTE ON FUNCTION public.sync_view_context_from_presence(text, uuid, uuid, uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- Function: send_notification (BASE function - must be created first)
-- Other functions like send_notification_to_user depend on this
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.send_notification(notification_type character varying, to_user_ids uuid[], notification_data jsonb DEFAULT '{}'::jsonb, server_id uuid DEFAULT NULL::uuid, channel_id uuid DEFAULT NULL::uuid, conversation_id uuid DEFAULT NULL::uuid, from_user_id uuid DEFAULT NULL::uuid, priority character varying DEFAULT 'normal'::character varying) RETURNS uuid[]
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    created_notification_ids uuid[] := '{}';
    recipient_id uuid;
    user_prefs record;
    should_send boolean;
    notification_id uuid;
    current_timestamp timestamp with time zone := now();
    enhanced_data jsonb;
    is_blocked boolean;
    is_muted boolean;
    is_channel_muted boolean;
    is_rate_limited boolean;
    p_channel_id uuid;
    p_conversation_id uuid;
    is_activitypub_type boolean;
    v_time_threshold timestamp with time zone := NOW() - INTERVAL '2 minutes';
BEGIN
    -- Validate inputs
    IF notification_type IS NULL OR array_length(to_user_ids, 1) IS NULL THEN
        RETURN '{}';
    END IF;

    -- Determine if this is an ActivityPub notification type
    is_activitypub_type := notification_type LIKE 'activitypub_%';

    -- Process each recipient
    FOREACH recipient_id IN ARRAY to_user_ids LOOP
        -- Skip if sending to self
        IF from_user_id IS NOT NULL AND recipient_id = from_user_id THEN
            CONTINUE;
        END IF;

        -- Check if sender is blocked by recipient
        IF from_user_id IS NOT NULL THEN
            SELECT EXISTS (
                SELECT 1 
                FROM user_blocks ub
                WHERE ub.blocker_id = recipient_id
                AND ub.blocked_user_id = from_user_id
                AND (ub.expires_at IS NULL OR ub.expires_at > NOW())
            ) INTO is_blocked;
            
            IF is_blocked THEN
                CONTINUE;
            END IF;
        END IF;

        -- Check if sender is muted by recipient (for notifications)
        IF from_user_id IS NOT NULL THEN
            SELECT EXISTS (
                SELECT 1 
                FROM user_mutes um
                WHERE um.muter_id = recipient_id
                AND um.muted_user_id = from_user_id
                AND um.mute_type IN ('notifications_only', 'all')
                AND (um.expires_at IS NULL OR um.expires_at > NOW())
            ) INTO is_muted;
            
            IF is_muted THEN
                CONTINUE;
            END IF;
        END IF;

        -- Check if channel/conversation is muted
        p_channel_id := channel_id;
        p_conversation_id := conversation_id;
        
        IF p_channel_id IS NOT NULL OR p_conversation_id IS NOT NULL THEN
            SELECT EXISTS (
                SELECT 1 
                FROM notification_channels nc
                WHERE nc.user_id = recipient_id
                AND nc.muted = true
                AND (
                    (p_channel_id IS NOT NULL AND nc.channel_id = p_channel_id)
                    OR
                    (p_conversation_id IS NOT NULL AND nc.conversation_id = p_conversation_id)
                )
                AND (nc.muted_until IS NULL OR nc.muted_until > NOW())
            ) INTO is_channel_muted;
            
            IF is_channel_muted THEN
                CONTINUE;
            END IF;
        END IF;

        -- Check if user is currently viewing this channel/DM (Discord-like behavior)
        IF (server_id IS NOT NULL AND p_channel_id IS NOT NULL) OR p_conversation_id IS NOT NULL THEN
            IF public.is_user_viewing_context(recipient_id, server_id, p_channel_id, p_conversation_id) THEN
                CONTINUE;
            END IF;
        END IF;

        -- Rate limit reaction-type notifications to prevent spam
        IF from_user_id IS NOT NULL AND notification_type IN ('reaction', 'activitypub_reaction') THEN
            INSERT INTO notification_rate_limits (user_id, notification_type, source_user_id)
            VALUES (recipient_id, notification_type, from_user_id)
            ON CONFLICT (user_id, notification_type, source_user_id)
            DO UPDATE SET
                notification_count = notification_rate_limits.notification_count + 1,
                last_notification_at = NOW();

            SELECT
                (notification_count > 3) OR
                (notification_count > 1 AND last_notification_at > v_time_threshold) OR
                (suppressed_until IS NOT NULL AND suppressed_until > NOW())
            INTO is_rate_limited
            FROM notification_rate_limits
            WHERE user_id = recipient_id
              AND notification_type = notification_type
              AND source_user_id = from_user_id;

            IF is_rate_limited THEN
                UPDATE notification_rate_limits
                SET suppressed_until = NOW() + INTERVAL '2 minutes'
                WHERE user_id = recipient_id
                  AND notification_type = notification_type
                  AND source_user_id = from_user_id;
                CONTINUE;
            END IF;
        END IF;

        -- Get user notification preferences
        user_prefs := NULL;
        BEGIN
            SELECT * INTO user_prefs FROM notification_preferences WHERE user_id = recipient_id;
        EXCEPTION
            WHEN undefined_table THEN
                user_prefs := NULL;
        END;

        -- Default to sending notifications if no preferences found
        should_send := true;

        -- Apply preferences if they exist
        IF user_prefs IS NOT NULL THEN
            -- First check master toggles
            IF is_activitypub_type THEN
                -- Check ActivityPub master toggle first
                IF COALESCE(user_prefs.activitypub_notifications, true) = false THEN
                    should_send := false;
                ELSIF COALESCE(user_prefs.activitypub_desktop_notifications, true) = false THEN
                    should_send := false;
                ELSE
                    -- Check specific ActivityPub notification types
                    CASE notification_type
                        WHEN 'activitypub_follow' THEN
                            should_send := COALESCE(user_prefs.activitypub_follows, true) 
                                       AND COALESCE(user_prefs.activitypub_desktop_follows, true);
                        WHEN 'activitypub_follow_request' THEN
                            should_send := COALESCE(user_prefs.activitypub_follow_requests, true) 
                                       AND COALESCE(user_prefs.activitypub_desktop_follows, true);
                        WHEN 'activitypub_favorite' THEN
                            should_send := COALESCE(user_prefs.activitypub_favorites, true) 
                                       AND COALESCE(user_prefs.activitypub_desktop_favorites, false);
                        WHEN 'activitypub_reblog' THEN
                            should_send := COALESCE(user_prefs.activitypub_reblogs, true) 
                                       AND COALESCE(user_prefs.activitypub_desktop_reblogs, false);
                        WHEN 'activitypub_mention' THEN
                            should_send := COALESCE(user_prefs.activitypub_mentions, true) 
                                       AND COALESCE(user_prefs.activitypub_desktop_mentions, true);
                        WHEN 'activitypub_reply' THEN
                            should_send := COALESCE(user_prefs.activitypub_replies, true) 
                                       AND COALESCE(user_prefs.activitypub_desktop_replies, true);
                        WHEN 'activitypub_reaction' THEN
                            should_send := COALESCE(user_prefs.activitypub_favorites, true) 
                                       AND COALESCE(user_prefs.activitypub_desktop_favorites, false);
                        ELSE
                            should_send := true;
                    END CASE;
                END IF;
            ELSE
                -- Check desktop_notifications master toggle first for non-ActivityPub
                IF COALESCE(user_prefs.desktop_notifications, true) = false THEN
                    -- Master toggle off, but still allow high-priority types
                    IF notification_type NOT IN ('mention', 'dm') THEN
                        should_send := false;
                    END IF;
                END IF;

                -- Check specific non-ActivityPub notification types
                IF should_send THEN
                    CASE notification_type
                        WHEN 'mention' THEN
                            should_send := COALESCE(user_prefs.desktop_mentions, true);
                        WHEN 'reply' THEN
                            should_send := COALESCE(user_prefs.desktop_replies, true);
                        WHEN 'dm' THEN
                            should_send := COALESCE(user_prefs.desktop_dms, true);
                        WHEN 'reaction' THEN
                            should_send := COALESCE(user_prefs.desktop_reactions, false);
                        WHEN 'voice_channel_activity' THEN
                            should_send := COALESCE(user_prefs.sound_voice_activity, true);
                        WHEN 'server_invite' THEN
                            should_send := COALESCE(user_prefs.desktop_notifications, true);
                        WHEN 'friend_request' THEN
                            should_send := COALESCE(user_prefs.desktop_notifications, true);
                        WHEN 'server_update' THEN
                            should_send := COALESCE(user_prefs.desktop_notifications, true);
                        WHEN 'emoji_added' THEN
                            should_send := COALESCE(user_prefs.desktop_notifications, true);
                        ELSE
                            should_send := true;
                    END CASE;
                END IF;
            END IF;

            -- Apply DND restrictions if configured
            IF user_prefs.dnd_enabled IS TRUE AND should_send THEN
                DECLARE
                    current_time_of_day time := current_timestamp::time;
                    dnd_start time := COALESCE(user_prefs.dnd_start_time, '22:00'::time);
                    dnd_end time := COALESCE(user_prefs.dnd_end_time, '08:00'::time);
                BEGIN
                    -- Handle overnight DND (e.g., 22:00 to 08:00)
                    IF dnd_start > dnd_end THEN
                        IF current_time_of_day >= dnd_start OR current_time_of_day <= dnd_end THEN
                            should_send := false;
                        END IF;
                    ELSE
                        IF current_time_of_day >= dnd_start AND current_time_of_day <= dnd_end THEN
                            should_send := false;
                        END IF;
                    END IF;
                END;
            END IF;
        END IF;

        -- Create enhanced notification data with context
        enhanced_data := notification_data;
        
        IF server_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('server_id', server_id);
        END IF;
        
        IF channel_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('channel_id', channel_id);
        END IF;
        
        IF conversation_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('conversation_id', conversation_id);
        END IF;
        
        IF from_user_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('from_user_id', from_user_id);
        END IF;
        
        IF priority IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('priority', priority);
        END IF;

        -- Create notification if should send
        IF should_send THEN
            INSERT INTO notifications (
                type,
                user_id,
                data,
                created_at
            ) VALUES (
                notification_type,
                recipient_id,
                enhanced_data,
                current_timestamp
            ) RETURNING id INTO notification_id;

            created_notification_ids := array_append(created_notification_ids, notification_id);
        END IF;

    END LOOP;

    RETURN created_notification_ids;
END;
$$;

COMMENT ON FUNCTION public.send_notification IS 'Send notifications to multiple users with preference checking';

-- ---------------------------------------------------------------------------
-- Function: check_encryption_policy
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_encryption_policy(p_server_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    v_settings public.server_encryption_settings;
    v_result JSONB;
BEGIN
    SELECT * INTO v_settings
    FROM public.server_encryption_settings
    WHERE server_id = p_server_id;
    
    -- If no settings exist, default to optional
    IF v_settings IS NULL THEN
        v_result := jsonb_build_object(
            'encryption_mode', 'optional',
            'allow_federation', true,
            'require_verified_devices', false,
            'is_encrypted', false
        );
    ELSE
        v_result := jsonb_build_object(
            'encryption_mode', v_settings.encryption_mode,
            'allow_federation', v_settings.allow_federation,
            'require_verified_devices', v_settings.require_verified_devices,
            'is_encrypted', v_settings.encryption_mode IN ('required', 'required_local_only')
        );
    END IF;
    
    RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: claim_session_share
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.claim_session_share(p_share_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    UPDATE public.megolm_session_shares
    SET 
        is_claimed = true,
        claimed_at = NOW()
    WHERE id = p_share_id
    AND recipient_user_id = p_user_id
    AND is_claimed = false;
    
    RETURN FOUND;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: convert_jsonb_to_ap
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.convert_jsonb_to_ap(content jsonb) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    content_part JSONB;
    html_content TEXT := '';
    part_type TEXT;
    part_text TEXT;
    part_url TEXT;
    part_shortcode TEXT;
    -- Variables for mention handling
    mention_username TEXT;
    mention_domain TEXT;
    mention_href TEXT;
    mention_text TEXT;
    current_instance_domain TEXT;
BEGIN
    -- Handle null or empty content
    IF content IS NULL THEN
        RETURN '';
    END IF;
    
    -- Handle string content (legacy format)
    IF jsonb_typeof(content) = 'string' THEN
        RETURN content #>> '{}';
    END IF;
    
    -- Get current instance domain for local mention detection
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    -- Handle array content (your universal format)
    IF jsonb_typeof(content) = 'array' THEN
        FOR content_part IN SELECT jsonb_array_elements(content)
        LOOP
            part_type := content_part->>'type';
            
            CASE part_type
                WHEN 'text' THEN
                    part_text := content_part->>'text';
                    IF part_text IS NOT NULL THEN
                        -- Escape HTML entities in text content for safety
                        part_text := replace(replace(replace(part_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
                        html_content := html_content || part_text;
                    END IF;
                    
                WHEN 'mention' THEN
                    -- Extract mention data from your universal format
                    mention_username := content_part->>'username';
                    mention_domain := content_part->>'domain';
                    
                    IF mention_username IS NOT NULL THEN
                        -- Always build full mention format for federation compatibility
                        IF mention_domain IS NOT NULL THEN
                            -- Use provided domain
                            mention_href := 'https://' || mention_domain || '/@' || mention_username;
                            mention_text := '@' || mention_username || '@' || mention_domain;
                        ELSE
                            -- Fallback to current instance domain for local users
                            mention_href := 'https://' || current_instance_domain || '/@' || mention_username;
                            mention_text := '@' || mention_username || '@' || current_instance_domain;
                        END IF;
                        
                        -- Create the HTML mention link
                        html_content := html_content || format('<a href="%s" class="mention">%s</a>', 
                            mention_href, mention_text);
                    END IF;
                    
                WHEN 'emoji' THEN
                    -- Handle custom emojis - use shortcode format for ActivityPub compatibility
                    part_shortcode := content_part->'emoji'->>'name';
                    
                    IF part_shortcode IS NOT NULL THEN
                        -- Always render as shortcode - emoji metadata goes in ActivityPub tags
                        html_content := html_content || ':' || part_shortcode || ':';
                    END IF;
                    
                WHEN 'file' THEN
                    -- Files should not be inline in ActivityPub content (handled as attachments)
                    CONTINUE;
                    
                WHEN 'url' THEN
                    -- Handle URLs
                    part_url := content_part->>'url';
                    IF part_url IS NOT NULL THEN
                        -- Escape URL for safety and create link
                        part_url := replace(replace(replace(part_url, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
                        html_content := html_content || format('<a href="%s" rel="noopener noreferrer" target="_blank">%s</a>', 
                            part_url, part_url);
                    END IF;
                    
                ELSE
                    -- Unknown type, try to extract text and escape it
                    part_text := content_part->>'text';
                    IF part_text IS NOT NULL THEN
                        part_text := replace(replace(replace(part_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
                        html_content := html_content || part_text;
                    END IF;
            END CASE;
        END LOOP;
        
        RETURN html_content;
    END IF;
    
    -- Fallback: convert to text and escape
    part_text := content::TEXT;
    part_text := replace(replace(replace(part_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
    RETURN part_text;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: create_federated_profile
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Function: get_activitypub_conversation_context
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Function: get_activitypub_conversation_root
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_activitypub_conversation_root(post_id uuid) RETURNS TABLE(root_id uuid)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  current_id uuid := post_id;
  parent_id uuid;
  max_depth int := 100; -- Prevent infinite loops
  depth int := 0;
BEGIN
  LOOP
    -- Get the parent post ID
    SELECT in_reply_to INTO parent_id
    FROM public.posts
    WHERE id = current_id;
    
    -- If no parent, we've found the root
    IF parent_id IS NULL THEN
      RETURN QUERY SELECT current_id;
      RETURN;
    END IF;
    
    -- Move to parent
    current_id := parent_id;
    depth := depth + 1;
    
    -- Safety check
    IF depth >= max_depth THEN
      RETURN QUERY SELECT current_id;
      RETURN;
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_activitypub_conversation_thread
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Function: get_batch_post_emoji_reactions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_batch_post_emoji_reactions(p_post_ids uuid[], p_user_limit integer DEFAULT 5) RETURNS TABLE(post_id uuid, emoji_id uuid, emoji_name text, emoji_url text, custom_emoji_content text, reaction_count bigint, user_reactions jsonb, current_user_reacted boolean)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    current_profile_id uuid;
BEGIN
    -- FIXED: Use get_current_profile_id() instead of auth.uid()
    -- post_interactions.user_id stores PROFILE IDs, not auth user IDs
    current_profile_id := public.get_current_profile_id();
    
    RETURN QUERY
    SELECT 
        pi.post_id,
        pi.emoji_id,
        e.name::text as emoji_name,
        -- Support remote emoji URLs from metadata
        COALESCE(e.url::text, MAX(pi.metadata->>'remote_emoji_url')) as emoji_url,
        pi.custom_emoji_content,
        COUNT(*)::bigint as reaction_count,
        -- Limited user data for tooltips
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'user_id', sub_pi.user_id,
                    'username', sub_p.username,
                    'display_name', sub_p.display_name,
                    'avatar_url', sub_p.avatar_url,
                    'created_at', sub_pi.created_at
                )
                ORDER BY sub_pi.created_at DESC
            )
            FROM post_interactions sub_pi
            LEFT JOIN profiles sub_p ON sub_pi.user_id = sub_p.id
            WHERE sub_pi.post_id = pi.post_id
              AND sub_pi.interaction_type = 'emoji_reaction'
              AND (
                  (pi.emoji_id IS NOT NULL AND sub_pi.emoji_id = pi.emoji_id) OR
                  (pi.custom_emoji_content IS NOT NULL AND sub_pi.custom_emoji_content = pi.custom_emoji_content)
              )
            LIMIT p_user_limit
        ) as user_reactions,
        -- FIXED: Check if current user has reacted using PROFILE ID
        CASE 
            WHEN current_profile_id IS NULL THEN false
            ELSE EXISTS(
                SELECT 1 FROM post_interactions check_pi
                WHERE check_pi.post_id = pi.post_id
                  AND check_pi.user_id = current_profile_id  -- FIXED: was auth.uid()
                  AND check_pi.interaction_type = 'emoji_reaction'
                  AND (
                      (pi.emoji_id IS NOT NULL AND check_pi.emoji_id = pi.emoji_id) OR
                      (pi.custom_emoji_content IS NOT NULL AND check_pi.custom_emoji_content = pi.custom_emoji_content)
                  )
            )
        END as current_user_reacted
    FROM post_interactions pi
    LEFT JOIN emojis e ON pi.emoji_id = e.id
    WHERE pi.post_id = ANY(p_post_ids)
      AND pi.interaction_type = 'emoji_reaction'
    GROUP BY pi.post_id, pi.emoji_id, e.name, e.url, pi.custom_emoji_content
    ORDER BY pi.post_id, reaction_count DESC, MIN(pi.created_at) ASC;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_conversation_encryption_status
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_conversation_encryption_status(p_conversation_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    v_settings public.conversation_encryption_settings;
    v_all_users_encrypted BOOLEAN;
    v_participant_ids UUID[];
    v_result JSONB;
BEGIN
    -- Get conversation encryption settings
    SELECT * INTO v_settings
    FROM public.conversation_encryption_settings
    WHERE conversation_id = p_conversation_id;
    
    -- Get all participant IDs
    SELECT ARRAY_AGG(user_id) INTO v_participant_ids
    FROM public.conversation_participants
    WHERE conversation_id = p_conversation_id;
    
    -- Check if all participants have encryption enabled
    SELECT bool_and(public.user_has_encryption(user_id)) INTO v_all_users_encrypted
    FROM unnest(v_participant_ids) as user_id;
    
    v_result := jsonb_build_object(
        'conversation_id', p_conversation_id,
        'encryption_enabled', COALESCE(v_settings.encryption_enabled, false),
        'verified', COALESCE(v_settings.verified, false),
        'all_users_have_keys', COALESCE(v_all_users_encrypted, false),
        'participant_count', COALESCE(array_length(v_participant_ids, 1), 0),
        'can_enable_encryption', COALESCE(v_all_users_encrypted, false)
    );
    
    RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_conversation_thread
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_conversation_thread(p_conversation_id text, p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  root_post jsonb;
  thread_posts jsonb;
  reply_count integer;
  participant_count integer;
  last_updated timestamptz;
BEGIN
  -- Get the root post (the one that started the conversation)
  SELECT to_jsonb(tp.*) INTO root_post
  FROM timeline_posts tp
  WHERE tp.conversation_id = p_conversation_id
    AND tp.reply_context IS NULL
  ORDER BY tp.created_at ASC
  LIMIT 1;
  
  -- Get all posts in the conversation with user interaction state
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', tp.id,
      'content', tp.content,
      'author', tp.author,
      'created_at', tp.created_at,
      'reply_context', tp.reply_context,
      'replies_count', tp.replies_count,
      'reblogs_count', tp.reblogs_count,
      'favorites_count', tp.favorites_count,
      'is_favorited', COALESCE(fav.user_id IS NOT NULL, false),
      'is_reblogged', COALESCE(reb.user_id IS NOT NULL, false),
      'is_bookmarked', COALESCE(book.user_id IS NOT NULL, false)
    ) ORDER BY tp.created_at ASC
  ) INTO thread_posts
  FROM timeline_posts tp
  LEFT JOIN post_interactions fav ON tp.id = fav.post_id 
    AND fav.user_id = p_user_id AND fav.interaction_type = 'favorite'
  LEFT JOIN post_interactions reb ON tp.id = reb.post_id 
    AND reb.user_id = p_user_id AND reb.interaction_type = 'reblog'
  LEFT JOIN post_interactions book ON tp.id = book.post_id 
    AND book.user_id = p_user_id AND book.interaction_type = 'bookmark'
  WHERE tp.conversation_id = p_conversation_id;
  
  -- Get conversation stats
  SELECT 
    COUNT(*) - 1, -- Subtract 1 for root post
    COUNT(DISTINCT tp.author_id),
    MAX(tp.created_at)
  INTO reply_count, participant_count, last_updated
  FROM timeline_posts tp
  WHERE tp.conversation_id = p_conversation_id;
  
  RETURN jsonb_build_object(
    'root_post', root_post,
    'posts', COALESCE(thread_posts, '[]'::jsonb),
    'reply_count', COALESCE(reply_count, 0),
    'participant_count', COALESCE(participant_count, 0),
    'last_updated', last_updated
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_emoji_usage_analytics
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Function: get_enhanced_timeline_posts
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_enhanced_timeline_posts(p_user_id uuid, p_timeline_type text DEFAULT 'home'::text, p_limit integer DEFAULT 20, p_max_id text DEFAULT NULL::text) RETURNS TABLE(id text, created_at timestamp with time zone, updated_at timestamp with time zone, content jsonb, content_warning text, language text, author_id text, ap_id text, ap_type text, url text, reply_context jsonb, conversation_id text, visibility text, is_local boolean, is_federated boolean, replies_count integer, reblogs_count integer, favorites_count integer, media_attachments jsonb, metadata jsonb, is_sensitive boolean, is_deleted boolean, deleted_at timestamp with time zone, author jsonb, is_favorited boolean, is_reblogged boolean, is_bookmarked boolean, reblog jsonb, reblog_author jsonb)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        tp.id::TEXT,
        tp.created_at,
        tp.updated_at,
        tp.content,
        tp.content_warning,
        'en'::TEXT as language,
        (tp.author->>'id')::TEXT as author_id,
        p.ap_id::TEXT,
        COALESCE(p.ap_type, 'Note')::TEXT as ap_type,
        tp.url,
        tp.reply_context,
        tp.conversation_id::TEXT,
        tp.visibility,
        (tp.author->>'is_local')::BOOLEAN as is_local,
        NOT (tp.author->>'is_local')::BOOLEAN as is_federated,
        tp.replies_count,
        tp.reblogs_count,
        tp.favorites_count,
        tp.media_attachments,
        COALESCE(p.metadata, '{}'::JSONB) as metadata,
        tp.is_sensitive,
        COALESCE(p.is_deleted, false) as is_deleted,
        p.deleted_at,
        tp.author,
        
        -- User interaction states
        COALESCE(fav.user_id IS NOT NULL, false) as is_favorited,
        COALESCE(reb.user_id IS NOT NULL, false) as is_reblogged,
        COALESCE(book.user_id IS NOT NULL, false) as is_bookmarked,
        
        -- Reblog fields
        tp.reblog,
        tp.reblog_author
        
    FROM timeline_posts tp
    JOIN posts p ON tp.id = p.id
    LEFT JOIN post_interactions fav ON tp.id = fav.post_id 
        AND fav.user_id = p_user_id 
        AND fav.interaction_type = 'favorite'
    LEFT JOIN post_interactions reb ON tp.id = reb.post_id 
        AND reb.user_id = p_user_id 
        AND reb.interaction_type = 'reblog'
    LEFT JOIN post_interactions book ON tp.id = book.post_id 
        AND book.user_id = p_user_id 
        AND book.interaction_type = 'bookmark'
    
    WHERE 
        CASE 
            -- HOME: Use timeline_entries for proper following logic
            WHEN p_timeline_type = 'home' THEN 
                EXISTS (
                    SELECT 1 FROM timeline_entries te 
                    WHERE te.user_id = p_user_id 
                      AND te.post_id = tp.id 
                      AND te.timeline_type = 'home'
                )
            
            -- LOCAL: Only public posts from local users
            WHEN p_timeline_type = 'local' THEN 
                tp.visibility = 'public' 
                AND (tp.author->>'is_local')::BOOLEAN = true
            
            -- PUBLIC/FEDERATED: All public posts (local + remote) - standard ActivityPub timeline
            WHEN p_timeline_type IN ('public', 'federated') THEN 
                tp.visibility = 'public'
                
            ELSE tp.visibility = 'public'
        END
        
        -- Pagination
        AND (p_max_id IS NULL OR tp.created_at < (
            SELECT tp2.created_at FROM timeline_posts tp2 WHERE tp2.id = p_max_id::UUID
        ))
    
    ORDER BY tp.created_at DESC
    LIMIT p_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_federated_timeline
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_federated_timeline(p_user_id uuid, p_limit integer DEFAULT 20, p_max_id text DEFAULT NULL::text) RETURNS TABLE(id text, created_at timestamp with time zone, updated_at timestamp with time zone, content jsonb, content_warning text, language text, author_id text, ap_id text, ap_type text, url text, conversation_id text, visibility text, is_local boolean, is_federated boolean, replies_count integer, reblogs_count integer, favorites_count integer, media_attachments jsonb, metadata jsonb, is_sensitive boolean, author jsonb, is_favorited boolean, is_reblogged boolean, is_bookmarked boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id::TEXT,
        p.created_at,
        p.updated_at,
        p.content,
        p.content_warning,
        p.language,
        p.author_id::TEXT,
        p.ap_id,
        p.ap_type,
        p.url,
        p.conversation_id::TEXT,
        p.visibility,
        p.is_local,
        p.is_federated,
        COALESCE(p.replies_count, 0)::INTEGER,
        COALESCE(p.reblogs_count, 0)::INTEGER,
        COALESCE(p.favorites_count, 0)::INTEGER,
        COALESCE(p.media_attachments, '[]'::jsonb),
        COALESCE(p.metadata, '{}'::jsonb),
        COALESCE(p.is_sensitive, false),
        -- Author object
        jsonb_build_object(
            'id', pr.id,
            'username', pr.username,
            'display_name', pr.display_name,
            'avatar_url', pr.avatar_url,
            'domain', COALESCE(pr.domain, 'har.mony.lol'),
            'handle', CASE 
                WHEN COALESCE(pr.is_local, true) THEN '@' || pr.username
                ELSE '@' || pr.username || '@' || pr.domain
            END,
            'is_local', COALESCE(pr.is_local, true),
            'bio', pr.bio,
            'color', pr.color
        ) AS author,
        -- User interaction states
        EXISTS(
            SELECT 1 FROM post_interactions pi 
            WHERE pi.post_id = p.id 
              AND pi.user_id = p_user_id 
              AND pi.interaction_type IN ('favorite', 'emoji_reaction')
        ) AS is_favorited,
        EXISTS(
            SELECT 1 FROM post_interactions pi 
            WHERE pi.post_id = p.id 
              AND pi.user_id = p_user_id 
              AND pi.interaction_type = 'reblog'
        ) AS is_reblogged,
        EXISTS(
            SELECT 1 FROM post_interactions pi 
            WHERE pi.post_id = p.id 
              AND pi.user_id = p_user_id 
              AND pi.interaction_type = 'bookmark'
        ) AS is_bookmarked
        
    FROM posts p
    INNER JOIN profiles pr ON p.author_id = pr.id
    
    WHERE 
        -- Remote posts only (federated content from other instances)
        p.is_local = false
        -- Public visibility only
        AND p.visibility = 'public'
        -- Not deleted (check both fields for safety)
        AND (p.is_deleted = false OR p.is_deleted IS NULL)
        AND p.deleted_at IS NULL
        -- Not from suspended users
        AND (pr.is_suspended = false OR pr.is_suspended IS NULL)
        -- Top-level posts only (not replies)
        AND p.in_reply_to IS NULL
        -- Pagination
        AND (p_max_id IS NULL OR p.created_at < (
            SELECT p2.created_at FROM posts p2 WHERE p2.id::TEXT = p_max_id
        ))
    
    ORDER BY p.created_at DESC
    LIMIT p_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_instance_domain
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_instance_domain() RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    domain_value text;
BEGIN
    -- Get domain from instance_config
    SELECT trim(both '"' from config_value::text) INTO domain_value
    FROM instance_config 
    WHERE config_key = 'domain';
    
    -- Return domain or fallback
    RETURN COALESCE(domain_value, 'localhost');
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_most_used_emojis
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Function: get_post_emoji_reactions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_post_emoji_reactions(p_post_id uuid, p_user_limit integer DEFAULT 5) RETURNS TABLE(emoji_id uuid, emoji_name text, emoji_url text, custom_emoji_content text, reaction_count bigint, user_reactions jsonb, current_user_reacted boolean)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    current_profile_id uuid;
BEGIN
    -- FIXED: Use get_current_profile_id() instead of auth.uid()
    -- post_interactions.user_id stores PROFILE IDs, not auth user IDs
    current_profile_id := public.get_current_profile_id();
    
    RETURN QUERY
    SELECT 
        pi.emoji_id,
        e.name::text as emoji_name,
        -- Support remote emoji URLs from metadata
        COALESCE(e.url::text, MAX(pi.metadata->>'remote_emoji_url')) as emoji_url,
        pi.custom_emoji_content,
        COUNT(*)::bigint as reaction_count,
        -- Only include limited user data for tooltips
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'user_id', sub_pi.user_id,
                    'username', sub_p.username,
                    'display_name', sub_p.display_name,
                    'avatar_url', sub_p.avatar_url,
                    'created_at', sub_pi.created_at
                )
                ORDER BY sub_pi.created_at DESC
            )
            FROM post_interactions sub_pi
            LEFT JOIN profiles sub_p ON sub_pi.user_id = sub_p.id
            WHERE sub_pi.post_id = p_post_id
              AND sub_pi.interaction_type = 'emoji_reaction'
              AND (
                  (pi.emoji_id IS NOT NULL AND sub_pi.emoji_id = pi.emoji_id) OR
                  (pi.custom_emoji_content IS NOT NULL AND sub_pi.custom_emoji_content = pi.custom_emoji_content)
              )
            LIMIT p_user_limit
        ) as user_reactions,
        -- FIXED: Check if current user has reacted using PROFILE ID
        CASE 
            WHEN current_profile_id IS NULL THEN false
            ELSE EXISTS(
                SELECT 1 FROM post_interactions check_pi
                WHERE check_pi.post_id = p_post_id
                  AND check_pi.user_id = current_profile_id  -- FIXED: was auth.uid()
                  AND check_pi.interaction_type = 'emoji_reaction'
                  AND (
                      (pi.emoji_id IS NOT NULL AND check_pi.emoji_id = pi.emoji_id) OR
                      (pi.custom_emoji_content IS NOT NULL AND check_pi.custom_emoji_content = pi.custom_emoji_content)
                  )
            )
        END as current_user_reacted
    FROM post_interactions pi
    LEFT JOIN emojis e ON pi.emoji_id = e.id
    WHERE pi.post_id = p_post_id 
      AND pi.interaction_type = 'emoji_reaction'
    GROUP BY pi.emoji_id, e.name, e.url, pi.custom_emoji_content
    ORDER BY reaction_count DESC, MIN(pi.created_at) ASC;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_post_with_context
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_post_with_context(p_post_id uuid, p_user_id uuid, p_context_type text DEFAULT 'minimal'::text, p_highlight_reply uuid DEFAULT NULL::uuid, p_max_depth integer DEFAULT 10, p_include_interactions boolean DEFAULT true) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_main_post JSONB;
  v_ancestors JSONB := '[]'::jsonb;
  v_descendants JSONB := '[]'::jsonb;
  v_thread_info JSONB;
  v_thread_id UUID;
  v_root_post_id UUID;
  v_total_posts INTEGER := 1;
  v_participant_count INTEGER := 1;
  v_max_depth INTEGER := 0;
  v_last_activity TIMESTAMP WITH TIME ZONE;
BEGIN
  -- Get the main post with all required fields and user interaction states
  SELECT to_jsonb(post_data) INTO v_main_post
  FROM (
    SELECT 
      p.*,
      profiles.id as author_id,
      profiles.username as author_username,
      profiles.display_name as author_display_name,
      profiles.avatar_url as author_avatar_url,
      profiles.domain as author_domain,
      profiles.bio as author_bio,
      profiles.is_local as author_is_local,
      profiles.followers_count as author_followers_count,
      profiles.following_count as author_following_count,
      profiles.posts_count as author_posts_count,
      profiles.created_at as author_created_at,
      profiles.updated_at as author_updated_at,
      -- Generate handle from username and domain
      CASE 
        WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
          '@' || profiles.username || '@' || profiles.domain
        ELSE 
          '@' || profiles.username
      END as author_handle,
      -- User interaction states (only if p_include_interactions is true)
      CASE 
        WHEN p_include_interactions THEN
          EXISTS(SELECT 1 FROM post_interactions WHERE post_id = p.id AND user_id = p_user_id AND interaction_type = 'favorite')
        ELSE false
      END as is_favorited,
      CASE 
        WHEN p_include_interactions THEN
          EXISTS(SELECT 1 FROM post_interactions WHERE post_id = p.id AND user_id = p_user_id AND interaction_type = 'reblog')
        ELSE false
      END as is_reblogged,
      CASE 
        WHEN p_include_interactions THEN
          EXISTS(SELECT 1 FROM post_interactions WHERE post_id = p.id AND user_id = p_user_id AND interaction_type = 'bookmark')
        ELSE false
      END as is_bookmarked,
      -- Author object for nested structure
      jsonb_build_object(
        'id', profiles.id,
        'username', profiles.username,
        'display_name', profiles.display_name,
        'avatar_url', profiles.avatar_url,
        'domain', profiles.domain,
        'bio', profiles.bio,
        'is_local', profiles.is_local,
        'followers_count', profiles.followers_count,
        'following_count', profiles.following_count,
        'posts_count', profiles.posts_count,
        'created_at', profiles.created_at,
        'updated_at', profiles.updated_at,
        'handle', CASE 
          WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
            '@' || profiles.username || '@' || profiles.domain
          ELSE 
            '@' || profiles.username
        END
      ) as author
    FROM posts p
    JOIN profiles ON profiles.id = p.author_id
    WHERE p.id = p_post_id
      AND p.is_deleted = false
  ) as post_data;

  -- If main post not found, return error
  IF v_main_post IS NULL THEN
    RETURN jsonb_build_object('error', 'Post not found');
  END IF;

  -- Get thread_id for thread context (may be null, that's ok)
  SELECT conversation_id INTO v_thread_id 
  FROM posts 
  WHERE id = p_post_id;

  -- For non-minimal contexts, get thread data
  IF p_context_type != 'minimal' THEN
    -- Find root post of the thread by following in_reply_to chain upward
    WITH RECURSIVE thread_root AS (
      -- Base case: start with the current post
      SELECT id, in_reply_to, 0 as depth
      FROM posts 
      WHERE id = p_post_id
      
      UNION ALL
      
      -- Recursive case: follow in_reply_to chain upward
      SELECT p.id, p.in_reply_to, tr.depth + 1
      FROM posts p
      JOIN thread_root tr ON p.id = tr.in_reply_to
      WHERE tr.depth < 50 -- Prevent infinite recursion
    )
    SELECT id INTO v_root_post_id 
    FROM thread_root 
    WHERE in_reply_to IS NULL
    ORDER BY depth DESC 
    LIMIT 1;

    -- If no root found, current post is the root
    IF v_root_post_id IS NULL THEN
      v_root_post_id := p_post_id;
    END IF;

    -- Get thread statistics using the conversation_root_id chain instead of conversation_id
    WITH RECURSIVE all_thread_posts AS (
      -- Start from the root post
      SELECT id, in_reply_to, author_id, created_at, 0 as depth
      FROM posts 
      WHERE id = v_root_post_id
      
      UNION ALL
      
      -- Get all posts that are replies in this thread
      SELECT p.id, p.in_reply_to, p.author_id, p.created_at, atp.depth + 1
      FROM posts p
      JOIN all_thread_posts atp ON p.in_reply_to = atp.id
      WHERE atp.depth < 50 -- Prevent infinite recursion
        AND p.is_deleted = false
    )
    SELECT 
      COUNT(DISTINCT id),
      COUNT(DISTINCT author_id),
      MAX(created_at)
    INTO v_total_posts, v_participant_count, v_last_activity
    FROM all_thread_posts;

    -- Get ancestors (posts this is replying to) if requested
    IF p_context_type IN ('thread', 'ancestors') THEN
      WITH RECURSIVE ancestors AS (
        -- Base case: direct parent
        SELECT p.*, 0 as depth
        FROM posts p
        WHERE p.id = (SELECT in_reply_to FROM posts WHERE id = p_post_id)
          AND p.is_deleted = false
        
        UNION ALL
        
        -- Recursive case: follow the reply chain upward
        SELECT p.*, a.depth + 1
        FROM posts p
        JOIN ancestors a ON p.id = (SELECT in_reply_to FROM posts WHERE id = a.id)
        WHERE a.depth < p_max_depth
          AND p.is_deleted = false
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', a.id,
          'created_at', a.created_at,
          'updated_at', a.updated_at,
          'content', a.content,
          'content_warning', a.content_warning,
          'language', a.language,
          'author_id', a.author_id,
          'ap_id', a.ap_id,
          'ap_type', a.ap_type,
          'url', a.url,
          'conversation_id', a.conversation_id,
          'visibility', a.visibility,
          'is_local', a.is_local,
          'is_federated', a.is_federated,
          'replies_count', a.replies_count,
          'reblogs_count', a.reblogs_count,
          'favorites_count', a.favorites_count,
          'media_attachments', a.media_attachments,
          'metadata', a.metadata,
          'is_sensitive', a.is_sensitive,
          'is_deleted', a.is_deleted,
          'deleted_at', a.deleted_at,
          'is_favorited', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = a.id AND user_id = p_user_id AND interaction_type = 'favorite')
            ELSE false
          END,
          'is_reblogged', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = a.id AND user_id = p_user_id AND interaction_type = 'reblog')
            ELSE false
          END,
          'is_bookmarked', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = a.id AND user_id = p_user_id AND interaction_type = 'bookmark')
            ELSE false
          END,
          'author', jsonb_build_object(
            'id', profiles.id,
            'username', profiles.username,
            'display_name', profiles.display_name,
            'avatar_url', profiles.avatar_url,
            'domain', profiles.domain,
            'bio', profiles.bio,
            'is_local', profiles.is_local,
            'followers_count', profiles.followers_count,
            'following_count', profiles.following_count,
            'posts_count', profiles.posts_count,
            'created_at', profiles.created_at,
            'updated_at', profiles.updated_at,
            'handle', CASE 
              WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
                '@' || profiles.username || '@' || profiles.domain
              ELSE 
                '@' || profiles.username
            END
          )
        ) ORDER BY a.depth DESC -- Oldest ancestor first
      ) INTO v_ancestors
      FROM ancestors a
      JOIN profiles ON profiles.id = a.author_id;
    END IF;

    -- Get descendants (replies to this post) if requested
    IF p_context_type IN ('thread', 'descendants') THEN
      WITH RECURSIVE descendants AS (
        -- Base case: direct replies
        SELECT p.*, 0 as depth, ARRAY[p.created_at::text, p.id::text] as sort_path
        FROM posts p
        WHERE p.in_reply_to = p_post_id
          AND p.is_deleted = false
        
        UNION ALL
        
        -- Recursive case: follow reply chains downward
        SELECT p.*, d.depth + 1, d.sort_path || ARRAY[p.created_at::text, p.id::text]
        FROM posts p
        JOIN descendants d ON p.in_reply_to = d.id
        WHERE d.depth < p_max_depth
          AND p.is_deleted = false
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', d.id,
          'created_at', d.created_at,
          'updated_at', d.updated_at,
          'content', d.content,
          'content_warning', d.content_warning,
          'language', d.language,
          'author_id', d.author_id,
          'ap_id', d.ap_id,
          'ap_type', d.ap_type,
          'url', d.url,
          'conversation_id', d.conversation_id,
          'visibility', d.visibility,
          'is_local', d.is_local,
          'is_federated', d.is_federated,
          'replies_count', d.replies_count,
          'reblogs_count', d.reblogs_count,
          'favorites_count', d.favorites_count,
          'media_attachments', d.media_attachments,
          'metadata', d.metadata,
          'is_sensitive', d.is_sensitive,
          'is_deleted', d.is_deleted,
          'deleted_at', d.deleted_at,
          'depth', d.depth,
          'is_favorited', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = d.id AND user_id = p_user_id AND interaction_type = 'favorite')
            ELSE false
          END,
          'is_reblogged', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = d.id AND user_id = p_user_id AND interaction_type = 'reblog')
            ELSE false
          END,
          'is_bookmarked', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = d.id AND user_id = p_user_id AND interaction_type = 'bookmark')
            ELSE false
          END,
          'author', jsonb_build_object(
            'id', profiles.id,
            'username', profiles.username,
            'display_name', profiles.display_name,
            'avatar_url', profiles.avatar_url,
            'domain', profiles.domain,
            'bio', profiles.bio,
            'is_local', profiles.is_local,
            'followers_count', profiles.followers_count,
            'following_count', profiles.following_count,
            'posts_count', profiles.posts_count,
            'created_at', profiles.created_at,
            'updated_at', profiles.updated_at,
            'handle', CASE 
              WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
                '@' || profiles.username || '@' || profiles.domain
              ELSE 
                '@' || profiles.username
            END
          )
        ) ORDER BY d.sort_path -- Chronological order preserving thread structure
      ) INTO v_descendants
      FROM descendants d
      JOIN profiles ON profiles.id = d.author_id;
    END IF;

    -- Calculate max depth for thread info using reply chain instead of conversation_id
    WITH RECURSIVE depth_calc AS (
      SELECT id, 0 as depth
      FROM posts 
      WHERE id = v_root_post_id
      
      UNION ALL
      
      SELECT p.id, dc.depth + 1
      FROM posts p
      JOIN depth_calc dc ON p.in_reply_to = dc.id
      WHERE dc.depth < 50 -- Prevent infinite recursion
        AND p.is_deleted = false
    )
    SELECT COALESCE(MAX(depth), 0) INTO v_max_depth
    FROM depth_calc;
  END IF;

  -- Build thread info
  v_thread_info := jsonb_build_object(
    'totalPosts', COALESCE(v_total_posts, 1),
    'participantCount', COALESCE(v_participant_count, 1),
    'depth', COALESCE(v_max_depth, 0),
    'rootPostId', COALESCE(v_root_post_id, p_post_id),
    'lastActivity', COALESCE(v_last_activity, (v_main_post->>'created_at')::timestamp with time zone)
  );

  -- Return the complete result
  RETURN jsonb_build_object(
    'mainPost', v_main_post,
    'ancestors', COALESCE(v_ancestors, '[]'::jsonb),
    'descendants', COALESCE(v_descendants, '[]'::jsonb),
    'threadInfo', v_thread_info
  );

EXCEPTION WHEN OTHERS THEN
  -- Log error and return structured error response
  RAISE LOG 'Error in get_post_with_context: %', SQLERRM;
  RETURN jsonb_build_object(
    'error', 'Database error: ' || SQLERRM,
    'mainPost', null,
    'ancestors', '[]'::jsonb,
    'descendants', '[]'::jsonb,
    'threadInfo', jsonb_build_object(
      'totalPosts', 0,
      'participantCount', 0,
      'depth', 0,
      'rootPostId', null,
      'lastActivity', null
    )
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_unclaimed_session_shares
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_unclaimed_session_shares(p_user_id uuid) RETURNS TABLE(share_id uuid, room_id uuid, session_id text, sender_user_id uuid, encrypted_session_key text, first_known_index integer, created_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        s.id as share_id,
        s.room_id,
        s.session_id,
        s.sender_user_id,
        s.encrypted_session_key,
        s.first_known_index,
        s.created_at
    FROM public.megolm_session_shares s
    WHERE s.recipient_user_id = p_user_id
    AND s.is_claimed = false
    ORDER BY s.created_at DESC;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_user_emoji_stats
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Function: get_user_handle
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_user_handle(p_user_id uuid) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  SELECT username || '@' || domain
  FROM profiles
  WHERE id = p_user_id;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_user_notifications
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_user_notifications(p_user_id uuid, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0, p_unread_only boolean DEFAULT false, p_notification_types character varying[] DEFAULT NULL::character varying[]) RETURNS TABLE(id uuid, user_id uuid, type character varying, data jsonb, is_read boolean, is_clicked boolean, created_at timestamp with time zone, updated_at timestamp with time zone, expires_at timestamp with time zone, read_at timestamp with time zone)
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
    AND (NOT p_unread_only OR n.is_read = FALSE)
    AND (p_notification_types IS NULL OR n.type = ANY(p_notification_types))
    
    -- Filter out notifications from blocked users
    -- Extract sender ID from various possible JSONB structures
    AND NOT EXISTS (
        SELECT 1 
        FROM user_blocks ub
        WHERE ub.blocker_id = p_user_id
        AND ub.blocked_user_id = COALESCE(
            NULLIF((n.data->>'from_user_id'), '')::uuid,
            NULLIF((n.data->'sender'->>'user_id'), '')::uuid,
            NULLIF((n.data->>'follower_id'), '')::uuid,
            NULLIF((n.data->'follower'->>'id'), '')::uuid,
            NULLIF((n.data->'actor'->>'id'), '')::uuid,
            NULLIF((n.data->'user'->>'id'), '')::uuid,
            NULLIF((n.data->'author'->>'id'), '')::uuid
        )
        AND (ub.expires_at IS NULL OR ub.expires_at > NOW())
    )
    
    -- Filter out notifications from muted users (notifications_only or all)
    AND NOT EXISTS (
        SELECT 1 
        FROM user_mutes um
        WHERE um.muter_id = p_user_id
        AND um.muted_user_id = COALESCE(
            NULLIF((n.data->>'from_user_id'), '')::uuid,
            NULLIF((n.data->'sender'->>'user_id'), '')::uuid,
            NULLIF((n.data->>'follower_id'), '')::uuid,
            NULLIF((n.data->'follower'->>'id'), '')::uuid,
            NULLIF((n.data->'actor'->>'id'), '')::uuid,
            NULLIF((n.data->'user'->>'id'), '')::uuid,
            NULLIF((n.data->'author'->>'id'), '')::uuid
        )
        AND um.mute_type IN ('notifications_only', 'all')
        AND (um.expires_at IS NULL OR um.expires_at > NOW())
    )
    
    -- Filter out notifications from muted channels/conversations
    AND NOT EXISTS (
        SELECT 1 
        FROM notification_channels nc
        WHERE nc.user_id = p_user_id
        AND nc.muted = true
        AND (
            (nc.channel_id IS NOT NULL AND nc.channel_id = COALESCE(
                NULLIF((n.data->>'channel_id'), '')::uuid,
                NULLIF((n.data->'location'->>'channel_id'), '')::uuid
            ))
            OR
            (nc.conversation_id IS NOT NULL AND nc.conversation_id = COALESCE(
                NULLIF((n.data->>'conversation_id'), '')::uuid,
                NULLIF((n.data->'conversation'->>'id'), '')::uuid
            ))
        )
        AND (nc.muted_until IS NULL OR nc.muted_until > NOW())
    )
    
    ORDER BY n.created_at DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_user_permissions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_user_permissions(p_user_id uuid, p_server_id uuid, p_channel_id uuid DEFAULT NULL::uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    AS $$
DECLARE
    v_is_owner boolean;
    v_base_permissions jsonb := '{}'::jsonb;
    v_channel_allows jsonb := '{}'::jsonb;
    v_channel_denies jsonb := '{}'::jsonb;
    v_final_permissions jsonb;
    v_role record;
    v_override record;
BEGIN
    -- Check if user is server owner
    SELECT (owner = p_user_id) INTO v_is_owner
    FROM "public"."servers"
    WHERE id = p_server_id;
    
    -- Server owner has all permissions
    IF v_is_owner THEN
        RETURN jsonb_build_object(
            'ADMINISTRATOR', true,
            'VIEW_CHANNEL', true,
            'MANAGE_CHANNELS', true,
            'MANAGE_ROLES', true,
            'MANAGE_EMOJIS', true,
            'VIEW_AUDIT_LOG', true,
            'MANAGE_WEBHOOKS', true,
            'MANAGE_SERVER', true,
            'CREATE_INVITE', true,
            'CHANGE_NICKNAME', true,
            'MANAGE_NICKNAMES', true,
            'KICK_MEMBERS', true,
            'BAN_MEMBERS', true,
            'TIMEOUT_MEMBERS', true,
            'SEND_MESSAGES', true,
            'SEND_MESSAGES_IN_THREADS', true,
            'CREATE_PUBLIC_THREADS', true,
            'CREATE_PRIVATE_THREADS', true,
            'EMBED_LINKS', true,
            'ATTACH_FILES', true,
            'ADD_REACTIONS', true,
            'USE_EXTERNAL_EMOJIS', true,
            'MENTION_EVERYONE', true,
            'MANAGE_MESSAGES', true,
            'READ_MESSAGE_HISTORY', true,
            'SEND_TTS_MESSAGES', true,
            'CONNECT', true,
            'SPEAK', true,
            'STREAM', true,
            'USE_VAD', true,
            'PRIORITY_SPEAKER', true,
            'MUTE_MEMBERS', true,
            'DEAFEN_MEMBERS', true,
            'MOVE_MEMBERS', true,
            'PIN_MESSAGES', true
        );
    END IF;
    
    -- Start with @everyone role permissions as base
    SELECT permissions INTO v_base_permissions
    FROM "public"."server_roles"
    WHERE server_id = p_server_id AND is_default = true;
    
    v_base_permissions := COALESCE(v_base_permissions, '{}'::jsonb);
    
    -- Collect permissions from all user's roles (ordered by position)
    -- Merge on top of @everyone (higher position roles can override)
    FOR v_role IN
        SELECT sr.permissions, sr.position
        FROM "public"."user_roles" ur
        JOIN "public"."server_roles" sr ON ur.role_id = sr.id
        WHERE ur.user_id = p_user_id AND ur.server_id = p_server_id
        ORDER BY sr.position ASC
    LOOP
        -- Merge permissions (higher position roles can override)
        v_base_permissions := v_base_permissions || v_role.permissions;
    END LOOP;
    
    -- If ADMINISTRATOR permission is set, grant all permissions
    IF (v_base_permissions->>'ADMINISTRATOR')::boolean = true THEN
        RETURN jsonb_build_object(
            'ADMINISTRATOR', true,
            'VIEW_CHANNEL', true,
            'MANAGE_CHANNELS', true,
            'MANAGE_ROLES', true,
            'MANAGE_EMOJIS', true,
            'VIEW_AUDIT_LOG', true,
            'MANAGE_WEBHOOKS', true,
            'MANAGE_SERVER', true,
            'CREATE_INVITE', true,
            'CHANGE_NICKNAME', true,
            'MANAGE_NICKNAMES', true,
            'KICK_MEMBERS', true,
            'BAN_MEMBERS', true,
            'TIMEOUT_MEMBERS', true,
            'SEND_MESSAGES', true,
            'SEND_MESSAGES_IN_THREADS', true,
            'CREATE_PUBLIC_THREADS', true,
            'CREATE_PRIVATE_THREADS', true,
            'EMBED_LINKS', true,
            'ATTACH_FILES', true,
            'ADD_REACTIONS', true,
            'USE_EXTERNAL_EMOJIS', true,
            'MENTION_EVERYONE', true,
            'MANAGE_MESSAGES', true,
            'READ_MESSAGE_HISTORY', true,
            'SEND_TTS_MESSAGES', true,
            'CONNECT', true,
            'SPEAK', true,
            'STREAM', true,
            'USE_VAD', true,
            'PRIORITY_SPEAKER', true,
            'MUTE_MEMBERS', true,
            'DEAFEN_MEMBERS', true,
            'MOVE_MEMBERS', true,
            'PIN_MESSAGES', true
        );
    END IF;
    
    -- Apply channel-specific overrides if channel_id is provided
    IF p_channel_id IS NOT NULL THEN
        -- Get role-based overrides (collect all allows and denies)
        FOR v_override IN
            SELECT cpo.allow, cpo.deny
            FROM "public"."channel_permission_overrides" cpo
            JOIN "public"."user_roles" ur ON cpo.target_id = ur.role_id AND cpo.target_type = 'role'
            WHERE cpo.channel_id = p_channel_id AND ur.user_id = p_user_id
        LOOP
            v_channel_allows := v_channel_allows || v_override.allow;
            v_channel_denies := v_channel_denies || v_override.deny;
        END LOOP;
        
        -- Get user-specific overrides (highest priority)
        SELECT allow, deny INTO v_override
        FROM "public"."channel_permission_overrides"
        WHERE channel_id = p_channel_id AND target_type = 'user' AND target_id = p_user_id;
        
        IF FOUND THEN
            v_channel_allows := v_channel_allows || v_override.allow;
            v_channel_denies := v_channel_denies || v_override.deny;
        END IF;
        
        -- Apply overrides: base + allows - denies
        v_final_permissions := v_base_permissions || v_channel_allows;
        
        -- Remove denied permissions
        SELECT jsonb_object_agg(key, value)
        INTO v_final_permissions
        FROM jsonb_each(v_final_permissions) 
        WHERE NOT (v_channel_denies ? key AND (v_channel_denies->>key)::boolean = true);
        
        RETURN COALESCE(v_final_permissions, '{}'::jsonb);
    END IF;
    
    RETURN v_base_permissions;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: get_user_prekey_bundle
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_user_prekey_bundle(p_user_id uuid, p_device_id text DEFAULT 'default'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_identity_key TEXT;
    v_signed_prekey JSONB;
    v_one_time_prekey JSONB;
    v_result JSONB;
BEGIN
    -- Get identity public key
    SELECT identity_public_key INTO v_identity_key
    FROM public.user_key_pairs
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_active = true
    ORDER BY key_version DESC
    LIMIT 1;
    
    IF v_identity_key IS NULL THEN
        RAISE EXCEPTION 'No identity key found for user % device %', p_user_id, p_device_id;
    END IF;
    
    -- Get signed prekey
    SELECT jsonb_build_object(
        'id', prekey_id,
        'public_key', public_key,
        'signature', signature
    ) INTO v_signed_prekey
    FROM public.prekeys
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_signed = true
        AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at DESC
    LIMIT 1;
    
    -- Get and mark one-time prekey as used
    SELECT jsonb_build_object(
        'id', prekey_id,
        'public_key', public_key
    ) INTO v_one_time_prekey
    FROM public.prekeys
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_one_time = true
        AND is_used = false
        AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
    
    -- Mark the one-time prekey as used
    IF v_one_time_prekey IS NOT NULL THEN
        UPDATE public.prekeys
        SET 
            is_used = true,
            used_at = NOW(),
            used_by = auth.uid()
        WHERE user_id = p_user_id
            AND device_id = p_device_id
            AND prekey_id = (v_one_time_prekey->>'id')::INTEGER;
    END IF;
    
    -- Build result bundle
    v_result := jsonb_build_object(
        'user_id', p_user_id,
        'device_id', p_device_id,
        'identity_key', v_identity_key,
        'signed_prekey', v_signed_prekey,
        'one_time_prekey', v_one_time_prekey,
        'retrieved_at', NOW()
    );
    
    RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: import_remote_emoji
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.import_remote_emoji(p_remote_emoji_id uuid, p_new_name text DEFAULT NULL::text, p_server_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_remote remote_emojis_cache%ROWTYPE;
  v_new_id uuid;
  v_name text;
BEGIN
  -- Get the remote emoji
  SELECT * INTO v_remote FROM public.remote_emojis_cache WHERE id = p_remote_emoji_id;
  
  IF v_remote.id IS NULL THEN
    RAISE EXCEPTION 'Remote emoji not found';
  END IF;
  
  IF v_remote.imported_as IS NOT NULL THEN
    RAISE EXCEPTION 'Emoji already imported';
  END IF;
  
  -- Use provided name or original shortcode
  v_name := COALESCE(p_new_name, v_remote.shortcode);
  
  -- Check if name already exists locally (where domain is null = local emoji)
  IF EXISTS (SELECT 1 FROM public.emojis WHERE name = v_name AND domain IS NULL) THEN
    RAISE EXCEPTION 'Emoji name already exists locally: %', v_name;
  END IF;
  
  -- Create the local emoji
  INSERT INTO public.emojis (
    name,
    url,
    server_id,
    domain  -- NULL means it's now a local emoji
  ) VALUES (
    v_name,
    v_remote.url,
    p_server_id,
    NULL  -- Imported as local emoji
  ) RETURNING id INTO v_new_id;
  
  -- Update the remote emoji to mark as imported
  UPDATE public.remote_emojis_cache 
  SET imported_as = v_new_id, imported_at = now()
  WHERE id = p_remote_emoji_id;
  
  RETURN v_new_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: mark_all_notifications_read
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_all_notifications_read(p_user_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE notifications 
    SET is_read = true, updated_at = NOW()
    WHERE user_id = p_user_id AND is_read = false;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: moderate_user
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.moderate_user(p_admin_id uuid, p_target_user_id uuid, p_action text, p_reason text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    target_username TEXT;
    admin_profile_id UUID;
BEGIN
    -- Check if admin has permission
    -- p_admin_id is auth.uid(), so we need to check via auth_user_id
    SELECT id INTO admin_profile_id 
    FROM profiles 
    WHERE auth_user_id = p_admin_id AND is_admin = TRUE;
    
    IF admin_profile_id IS NULL THEN
        RAISE EXCEPTION 'Insufficient permissions';
    END IF;
    
    -- Get target username for logging
    -- p_target_user_id is profiles.id, so we use id directly
    SELECT username INTO target_username FROM profiles WHERE id = p_target_user_id;
    
    IF target_username IS NULL THEN
        RAISE EXCEPTION 'User not found';
    END IF;
    
    IF p_action = 'suspend' THEN
        UPDATE profiles 
        SET 
            is_suspended = TRUE,
            suspended_at = NOW(),
            suspension_reason = p_reason
        WHERE id = p_target_user_id;
        
        -- Log the action using admin's profile ID for consistency
        -- Using jsonb_build_object instead of json_build_object
        PERFORM log_admin_action(
            admin_profile_id,
            'user_suspend',
            'user',
            p_target_user_id::TEXT,
            jsonb_build_object('reason', p_reason, 'username', target_username)
        );
        
    ELSIF p_action = 'unsuspend' THEN
        UPDATE profiles 
        SET 
            is_suspended = FALSE,
            suspended_at = NULL,
            suspension_reason = NULL
        WHERE id = p_target_user_id;
        
        -- Log the action using admin's profile ID for consistency
        -- Using jsonb_build_object instead of json_build_object
        PERFORM log_admin_action(
            admin_profile_id,
            'user_unsuspend',
            'user',
            p_target_user_id::TEXT,
            jsonb_build_object('username', target_username)
        );
    ELSE
        RAISE EXCEPTION 'Invalid action: %', p_action;
    END IF;
    
    RETURN TRUE;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: pin_message
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pin_message(p_message_id uuid, p_user_id uuid DEFAULT auth.uid()) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_channel_id uuid;
    v_conversation_id uuid;
    v_server_id uuid;
    v_pin_count integer;
    v_max_pins integer := 50; -- Discord-style limit
BEGIN
    -- Get message details
    SELECT channel_id, conversation_id INTO v_channel_id, v_conversation_id
    FROM "public"."messages"
    WHERE id = p_message_id AND NOT is_deleted;
    
    IF v_channel_id IS NULL AND v_conversation_id IS NULL THEN
        RAISE EXCEPTION 'Message not found or already deleted';
    END IF;
    
    -- Check if already pinned
    IF EXISTS (SELECT 1 FROM "public"."messages" WHERE id = p_message_id AND is_pinned = true) THEN
        RETURN true; -- Already pinned
    END IF;
    
    -- For channel messages, check permission and pin limit
    IF v_channel_id IS NOT NULL THEN
        SELECT server_id INTO v_server_id
        FROM "public"."channels"
        WHERE id = v_channel_id;
        
        -- Check pin count
        SELECT COUNT(*) INTO v_pin_count
        FROM "public"."messages"
        WHERE channel_id = v_channel_id AND is_pinned = true;
        
        IF v_pin_count >= v_max_pins THEN
            RAISE EXCEPTION 'Maximum pin limit (%) reached for this channel', v_max_pins;
        END IF;
        
        -- Check permission (PIN_MESSAGES or MANAGE_MESSAGES)
        IF NOT (
            "public"."has_permission"(p_user_id, v_server_id, 'PIN_MESSAGES', v_channel_id)
            OR
            "public"."has_permission"(p_user_id, v_server_id, 'MANAGE_MESSAGES', v_channel_id)
        ) THEN
            RAISE EXCEPTION 'Permission denied: cannot pin messages';
        END IF;
    END IF;
    
    -- For DM conversations, check if user is participant
    IF v_conversation_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM "public"."conversation_participants"
            WHERE conversation_id = v_conversation_id AND user_id = p_user_id
        ) THEN
            RAISE EXCEPTION 'Permission denied: not a participant in this conversation';
        END IF;
        
        -- Check pin count for DM
        SELECT COUNT(*) INTO v_pin_count
        FROM "public"."messages"
        WHERE conversation_id = v_conversation_id AND is_pinned = true;
        
        IF v_pin_count >= v_max_pins THEN
            RAISE EXCEPTION 'Maximum pin limit (%) reached for this conversation', v_max_pins;
        END IF;
    END IF;
    
    -- Pin the message
    UPDATE "public"."messages"
    SET 
        is_pinned = true,
        pinned_at = NOW(),
        pinned_by = p_user_id
    WHERE id = p_message_id;
    
    RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: record_emoji_usage
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_emoji_usage(p_emoji_id uuid, p_user_id uuid, p_server_id uuid, p_context_type text, p_context_id uuid DEFAULT NULL::uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Insert usage record (ignore if duplicate due to unique constraint)
    INSERT INTO emoji_usage (emoji_id, user_id, server_id, context_type, context_id)
    VALUES (p_emoji_id, p_user_id, p_server_id, p_context_type, p_context_id)
    ON CONFLICT (emoji_id, user_id, context_type, context_id) DO NOTHING;
    
    -- Update emoji global usage count and last_used
    UPDATE emojis 
    SET 
        usage_count = (
            SELECT COUNT(DISTINCT (user_id, context_type, context_id))
            FROM emoji_usage 
            WHERE emoji_id = p_emoji_id
        ),
        last_used = now(),
        updated_at = now()
    WHERE id = p_emoji_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: register_recovery_key
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.register_recovery_key(p_user_id uuid, p_verification_code text, p_word_count integer DEFAULT 12) RETURNS public.recovery_key_metadata
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_result public.recovery_key_metadata;
BEGIN
    INSERT INTO public.recovery_key_metadata (
        user_id,
        verification_code,
        word_count,
        created_at
    ) VALUES (
        p_user_id,
        p_verification_code,
        p_word_count,
        NOW()
    )
    ON CONFLICT (user_id) 
    DO UPDATE SET
        verification_code = EXCLUDED.verification_code,
        word_count = EXCLUDED.word_count,
        key_version = recovery_key_metadata.key_version + 1
    RETURNING * INTO v_result;
    
    RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: remove_group_icon
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.remove_group_icon(conversation_uuid uuid, user_profile_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  is_participant BOOLEAN := false;
  conversation_exists BOOLEAN := false;
BEGIN
  -- Check if user is a participant in the conversation
  SELECT can_manage_group_icon(conversation_uuid, user_profile_id) INTO is_participant;
  
  IF NOT is_participant THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'User is not a participant in this conversation'
    );
  END IF;
  
  -- Check if conversation exists and is a group
  SELECT EXISTS(
    SELECT 1 FROM conversations 
    WHERE id = conversation_uuid AND type = 'group'
  ) INTO conversation_exists;
  
  IF NOT conversation_exists THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Group conversation not found'
    );
  END IF;
  
  -- Remove icon from conversation metadata
  UPDATE conversations 
  SET 
    metadata = COALESCE(metadata, '{}'::jsonb) - 'icon_url',
    updated_at = CURRENT_TIMESTAMP
  WHERE id = conversation_uuid
    AND type = 'group';
  
  RETURN jsonb_build_object(
    'success', true,
    'message', 'Group icon removed successfully'
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: remove_post_emoji_reaction
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.remove_post_emoji_reaction(p_user_id uuid, p_post_id uuid, p_emoji_id uuid DEFAULT NULL::uuid, p_custom_emoji_content text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_deleted_count integer;
BEGIN
    DELETE FROM post_interactions 
    WHERE user_id = p_user_id
      AND post_id = p_post_id 
      AND interaction_type = 'emoji_reaction'
      AND (
          (p_emoji_id IS NOT NULL AND emoji_id = p_emoji_id) OR
          (p_custom_emoji_content IS NOT NULL AND custom_emoji_content = p_custom_emoji_content)
      );
    
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    RETURN v_deleted_count > 0;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: reset_daily_hashtag_counters
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Function: reset_user_encryption
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_user_encryption(p_user_id uuid, p_device_id text DEFAULT 'default'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_deleted_keys INTEGER := 0;
    v_deleted_prekeys INTEGER := 0;
    v_deleted_sessions INTEGER := 0;
    v_result JSONB;
BEGIN
    -- Only allow users to reset their own encryption
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = p_user_id
        AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot reset encryption for another user';
    END IF;
    
    -- Delete all prekeys (both signed and one-time)
    DELETE FROM public.prekeys
    WHERE user_id = p_user_id
    AND device_id = p_device_id;
    GET DIAGNOSTICS v_deleted_prekeys = ROW_COUNT;
    
    -- Delete encryption sessions (where user is either party)
    DELETE FROM public.encryption_sessions
    WHERE local_user_id = p_user_id
    OR remote_user_id = p_user_id;
    GET DIAGNOSTICS v_deleted_sessions = ROW_COUNT;
    
    -- Delete all key pairs (this allows re-initialization)
    DELETE FROM public.user_key_pairs
    WHERE user_id = p_user_id
    AND device_id = p_device_id;
    GET DIAGNOSTICS v_deleted_keys = ROW_COUNT;
    
    -- Log the reset (using 'encryption_disabled' as it's the closest valid event type)
    INSERT INTO public.encryption_audit_log (
        user_id,
        event_type,
        severity,
        description,
        metadata
    ) VALUES (
        p_user_id,
        'encryption_disabled',
        'warning',
        'User encryption keys completely reset',
        jsonb_build_object(
            'device_id', p_device_id,
            'deleted_keys', v_deleted_keys,
            'deleted_prekeys', v_deleted_prekeys,
            'deleted_sessions', v_deleted_sessions,
            'reset_type', 'full_reset',
            'reset_at', NOW()
        )
    );
    
    v_result := jsonb_build_object(
        'success', true,
        'deleted_keys', v_deleted_keys,
        'deleted_prekeys', v_deleted_prekeys,
        'deleted_sessions', v_deleted_sessions,
        'message', 'Encryption has been reset. You can now set up encryption again.'
    );
    
    RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: rotate_prekeys
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rotate_prekeys(p_user_id uuid, p_device_id text DEFAULT 'default'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_deleted_count INTEGER;
    v_remaining_count INTEGER;
    v_result JSONB;
BEGIN
    -- Only allow users to rotate their own prekeys
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = p_user_id
        AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot rotate prekeys for another user';
    END IF;
    
    -- Delete used one-time prekeys older than 30 days
    DELETE FROM public.prekeys
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_one_time = true
        AND is_used = true
        AND used_at < NOW() - INTERVAL '30 days';
    
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    
    -- Mark expired signed prekeys as inactive
    UPDATE public.prekeys
    SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{expired}', 'true')
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_signed = true
        AND expires_at IS NOT NULL
        AND expires_at < NOW();
    
    -- Count remaining unused one-time prekeys
    SELECT COUNT(*) INTO v_remaining_count
    FROM public.prekeys
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_one_time = true
        AND is_used = false;
    
    v_result := jsonb_build_object(
        'deleted_used_prekeys', v_deleted_count,
        'remaining_unused_prekeys', v_remaining_count,
        'rotation_completed_at', NOW()
    );
    
    -- Log the rotation
    INSERT INTO public.encryption_audit_log (
        user_id,
        event_type,
        severity,
        description,
        metadata
    ) VALUES (
        p_user_id,
        'key_rotated',
        'info',
        'Prekey rotation completed',
        v_result
    );
    
    RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: save_recovery_codes
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.save_recovery_codes(p_user_id uuid, p_codes text[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_code TEXT;
  v_code_hash TEXT;
BEGIN
  -- Delete any existing recovery codes for this user
  DELETE FROM public.mfa_recovery_codes WHERE user_id = p_user_id;
  
  -- Insert new recovery codes
  FOREACH v_code IN ARRAY p_codes
  LOOP
    -- Use extensions.digest() to explicitly reference the pgcrypto extension
    v_code_hash := encode(extensions.digest(v_code::bytea, 'sha256'), 'hex');
    INSERT INTO public.mfa_recovery_codes (user_id, code_hash)
    VALUES (p_user_id, v_code_hash);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: search_federated_users
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_federated_users(p_query text, p_limit integer DEFAULT 10) RETURNS TABLE(user_id uuid, username text, display_name text, domain text, avatar_url text, handle text, is_local boolean)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id as user_id,
        p.username,
        p.display_name,
        p.domain,
        p.avatar_url,
        get_user_handle(p.id) as handle,
        p.is_local
    FROM profiles p
    WHERE (
        p.username ILIKE '%' || p_query || '%'
        OR p.display_name ILIKE '%' || p_query || '%'
        OR (p.username || '@' || p.domain) ILIKE '%' || p_query || '%'
    )
    AND p.is_suspended = false  -- Exclude suspended users
    ORDER BY 
        CASE WHEN p.is_local THEN 0 ELSE 1 END,
        p.username
    LIMIT p_limit;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: search_messages
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_messages(p_query text DEFAULT NULL::text, p_channel_id uuid DEFAULT NULL::uuid, p_channel_ids uuid[] DEFAULT NULL::uuid[], p_user_id uuid DEFAULT NULL::uuid, p_conversation_id uuid DEFAULT NULL::uuid, p_server_id uuid DEFAULT NULL::uuid, p_has_media boolean DEFAULT NULL::boolean, p_has_url boolean DEFAULT NULL::boolean, p_from_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0) RETURNS TABLE(message_id uuid, relevance real, content_text text, channel_id uuid, conversation_id uuid, user_id uuid, created_at timestamp with time zone)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  current_user_profile_id uuid;
  search_query text;
  tsquery_val tsquery;
BEGIN
  -- Get current user's profile ID (works for both local and remote users)
  current_user_profile_id := get_current_user_profile_id();
  
  -- If no profile found, return empty (user not authenticated or no profile)
  IF current_user_profile_id IS NULL THEN
    RETURN;
  END IF;
  -- Build search query - handle empty query
  IF p_query IS NULL OR trim(p_query) = '' THEN
    search_query := '';
    tsquery_val := NULL;
  ELSE
    search_query := trim(p_query);
    -- Use plainto_tsquery for natural language search
    tsquery_val := plainto_tsquery('english', search_query);
  END IF;

  RETURN QUERY
  SELECT 
    msi.message_id,
    -- Combine ts_rank (full-text) with similarity (fuzzy) for ranking
    CASE 
      WHEN tsquery_val IS NOT NULL THEN
        (ts_rank(msi.content_tsvector, tsquery_val) * 0.7 +
         extensions.similarity(msi.content_text, search_query) * 0.3)::real
      ELSE
        -- If no query, rank by date
        1.0::real
    END as relevance,
    msi.content_text,
    msi.channel_id,
    msi.conversation_id,
    msi.user_id,
    msi.created_at
  FROM message_search_index msi
  WHERE 
    -- Access control: Only show messages user has access to
    (
      -- For conversations: user must be a participant
      (msi.conversation_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM conversation_participants cp
        WHERE cp.conversation_id = msi.conversation_id
          AND cp.user_id = current_user_profile_id
          AND cp.left_at IS NULL
      ))
      OR
      -- For channels: user must be a member of the server
      (msi.channel_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM channels c
        JOIN user_servers us ON c.server_id = us.server_id
        WHERE c.id = msi.channel_id
          AND us.user_id = current_user_profile_id
      ))
    )
    -- Search conditions (only if query provided)
    AND (tsquery_val IS NULL OR 
         msi.content_tsvector @@ tsquery_val OR 
         extensions.similarity(msi.content_text, search_query) > 0.2)
    -- Filters
    AND (p_channel_id IS NULL OR msi.channel_id = p_channel_id)
    AND (p_channel_ids IS NULL OR msi.channel_id = ANY(p_channel_ids))
    AND (p_user_id IS NULL OR msi.user_id = p_user_id)
    AND (p_conversation_id IS NULL OR msi.conversation_id = p_conversation_id)
    AND (p_server_id IS NULL OR msi.server_id = p_server_id)
    AND (p_has_media IS NULL OR msi.has_media = p_has_media)
    AND (p_has_url IS NULL OR msi.has_url = p_has_url)
    AND (p_from_date IS NULL OR msi.created_at >= p_from_date)
    AND (p_to_date IS NULL OR msi.created_at <= p_to_date)
  ORDER BY 
    CASE 
      WHEN tsquery_val IS NOT NULL THEN
        (ts_rank(msi.content_tsvector, tsquery_val) * 0.7 +
         extensions.similarity(msi.content_text, search_query) * 0.3)
      ELSE
        extract(epoch from msi.created_at) / 1000000.0 -- Convert timestamp to sortable number
    END DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: send_notification_to_user
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.send_notification_to_user(notification_type character varying, to_user_id uuid, notification_data jsonb DEFAULT '{}'::jsonb, server_id uuid DEFAULT NULL::uuid, channel_id uuid DEFAULT NULL::uuid, conversation_id uuid DEFAULT NULL::uuid, from_user_id uuid DEFAULT NULL::uuid, priority character varying DEFAULT 'normal'::character varying) RETURNS uuid
    LANGUAGE sql SECURITY DEFINER
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

-- ---------------------------------------------------------------------------
-- Function: unpin_message
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.unpin_message(p_message_id uuid, p_user_id uuid DEFAULT auth.uid()) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_channel_id uuid;
    v_conversation_id uuid;
    v_server_id uuid;
BEGIN
    -- Get message details
    SELECT channel_id, conversation_id INTO v_channel_id, v_conversation_id
    FROM "public"."messages"
    WHERE id = p_message_id;
    
    IF v_channel_id IS NULL AND v_conversation_id IS NULL THEN
        RAISE EXCEPTION 'Message not found';
    END IF;
    
    -- Check if not pinned
    IF NOT EXISTS (SELECT 1 FROM "public"."messages" WHERE id = p_message_id AND is_pinned = true) THEN
        RETURN true; -- Already unpinned
    END IF;
    
    -- For channel messages, check permission
    IF v_channel_id IS NOT NULL THEN
        SELECT server_id INTO v_server_id
        FROM "public"."channels"
        WHERE id = v_channel_id;
        
        -- Check permission (PIN_MESSAGES or MANAGE_MESSAGES)
        IF NOT (
            "public"."has_permission"(p_user_id, v_server_id, 'PIN_MESSAGES', v_channel_id)
            OR
            "public"."has_permission"(p_user_id, v_server_id, 'MANAGE_MESSAGES', v_channel_id)
        ) THEN
            RAISE EXCEPTION 'Permission denied: cannot unpin messages';
        END IF;
    END IF;
    
    -- For DM conversations, check if user is participant
    IF v_conversation_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM "public"."conversation_participants"
            WHERE conversation_id = v_conversation_id AND user_id = p_user_id
        ) THEN
            RAISE EXCEPTION 'Permission denied: not a participant in this conversation';
        END IF;
    END IF;
    
    -- Unpin the message
    UPDATE "public"."messages"
    SET 
        is_pinned = false,
        pinned_at = NULL,
        pinned_by = NULL
    WHERE id = p_message_id;
    
    RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: update_group_icon
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_group_icon(conversation_uuid uuid, user_profile_id uuid, icon_path text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  is_participant BOOLEAN := false;
  conversation_exists BOOLEAN := false;
BEGIN
  -- Check if user is a participant in the conversation
  SELECT can_manage_group_icon(conversation_uuid, user_profile_id) INTO is_participant;
  
  IF NOT is_participant THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'User is not a participant in this conversation'
    );
  END IF;
  
  -- Check if conversation exists and is a group
  SELECT EXISTS(
    SELECT 1 FROM conversations 
    WHERE id = conversation_uuid AND type = 'group'
  ) INTO conversation_exists;
  
  IF NOT conversation_exists THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Group conversation not found'
    );
  END IF;
  
  -- Update the conversation metadata with the new icon path
  UPDATE conversations 
  SET 
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('icon_url', icon_path),
    updated_at = CURRENT_TIMESTAMP
  WHERE id = conversation_uuid
    AND type = 'group';
  
  RETURN jsonb_build_object(
    'success', true,
    'message', 'Group icon updated successfully'
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: update_group_name
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_group_name(conversation_uuid uuid, user_profile_id uuid, new_name text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  is_participant BOOLEAN := false;
  conversation_exists BOOLEAN := false;
BEGIN
  -- Check if user is a participant in the conversation
  SELECT can_manage_group_icon(conversation_uuid, user_profile_id) INTO is_participant;
  
  IF NOT is_participant THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'User is not a participant in this conversation'
    );
  END IF;
  
  -- Check if conversation exists and is a group
  SELECT EXISTS(
    SELECT 1 FROM conversations 
    WHERE id = conversation_uuid AND type = 'group'
  ) INTO conversation_exists;
  
  IF NOT conversation_exists THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Group conversation not found'
    );
  END IF;
  
  -- Update the conversation name
  UPDATE conversations 
  SET 
    name = new_name,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = conversation_uuid
    AND type = 'group';
  
  RETURN jsonb_build_object(
    'success', true,
    'message', 'Group name updated successfully'
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: update_hashtag_trending_scores
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Function: update_trending_posts
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Function: user_has_encryption
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.user_has_encryption(p_user_id uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.user_key_pairs
        WHERE user_id = p_user_id
        AND is_active = true
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- Function: verify_recovery_code
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.verify_recovery_code(p_user_id uuid, p_code text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_code_hash TEXT;
  v_code_id UUID;
BEGIN
  -- Hash the provided code (using SHA-256)
  -- Use extensions.digest() to explicitly reference the pgcrypto extension
  v_code_hash := encode(extensions.digest(p_code::bytea, 'sha256'), 'hex');
  
  -- Find an unused recovery code matching the hash
  SELECT id INTO v_code_id
  FROM public.mfa_recovery_codes
  WHERE user_id = p_user_id
    AND code_hash = v_code_hash
    AND used_at IS NULL
  LIMIT 1;
  
  IF v_code_id IS NOT NULL THEN
    -- Mark the code as used
    UPDATE public.mfa_recovery_codes
    SET used_at = NOW()
    WHERE id = v_code_id;
    
    RETURN TRUE;
  ELSE
    RETURN FALSE;
  END IF;
END;
$$;

-- =============================================================================
-- STUB FUNCTIONS - Temporary implementations for missing RPC functions
-- =============================================================================
-- These functions are called by the frontend but were never implemented in production.
-- They return empty/default values to prevent errors.
-- TODO: Replace with proper implementations (see TODO_cleanRPC.md)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- DROP existing functions with changed signatures (required before CREATE OR REPLACE)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_thread(text);
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_context(uuid);
DROP FUNCTION IF EXISTS public.get_emoji_usage_analytics(uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.get_user_emoji_stats(uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.get_most_used_emojis(uuid[], integer);

-- ---------------------------------------------------------------------------
-- 1. create_federated_profile - Creates a profile for a remote federated user
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_federated_profile(
    p_username text,
    p_display_name text DEFAULT NULL,
    p_domain text DEFAULT NULL,
    p_avatar_url text DEFAULT NULL,
    p_banner_url text DEFAULT NULL,
    p_bio text DEFAULT NULL,
    p_federated_id text DEFAULT NULL,
    p_inbox_url text DEFAULT NULL,
    p_outbox_url text DEFAULT NULL,
    p_followers_url text DEFAULT NULL,
    p_following_url text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_profile_id uuid;
BEGIN
    -- Check if profile already exists with this federated_id
    IF p_federated_id IS NOT NULL THEN
        SELECT id INTO v_profile_id 
        FROM public.profiles 
        WHERE federated_id = p_federated_id;
        
        IF v_profile_id IS NOT NULL THEN
            -- Update existing profile
            UPDATE public.profiles SET
                display_name = COALESCE(p_display_name, display_name),
                avatar_url = COALESCE(p_avatar_url, avatar_url),
                bio = COALESCE(p_bio, bio),
                inbox_url = COALESCE(p_inbox_url, inbox_url),
                outbox_url = COALESCE(p_outbox_url, outbox_url),
                followers_url = COALESCE(p_followers_url, followers_url),
                following_url = COALESCE(p_following_url, following_url),
                last_synced_at = NOW()
            WHERE id = v_profile_id;
            
            RETURN v_profile_id;
        END IF;
    END IF;
    
    -- Create new federated profile
    INSERT INTO public.profiles (
        username,
        display_name,
        domain,
        avatar_url,
        bio,
        federated_id,
        inbox_url,
        outbox_url,
        followers_url,
        following_url,
        is_local,
        last_synced_at
    ) VALUES (
        p_username,
        p_display_name,
        p_domain,
        p_avatar_url,
        p_bio,
        p_federated_id,
        p_inbox_url,
        p_outbox_url,
        p_followers_url,
        p_following_url,
        false,  -- Not a local user
        NOW()
    )
    RETURNING id INTO v_profile_id;
    
    RETURN v_profile_id;
END;
$$;

COMMENT ON FUNCTION public.create_federated_profile IS 'Creates or updates a profile for a remote federated user discovered via ActivityPub';

-- ---------------------------------------------------------------------------
-- 2. get_activitypub_conversation_context - Get ancestors/descendants of a post
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_activitypub_conversation_context(post_id uuid)
RETURNS TABLE(
    ancestors jsonb,
    descendants jsonb
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        -- Get ancestors (posts this post replies to)
        COALESCE(
            (SELECT jsonb_agg(
                jsonb_build_object(
                    'id', p.id,
                    'content', p.content,
                    'author_id', p.author_id,
                    'created_at', p.created_at
                ) ORDER BY p.created_at ASC
            )
            FROM posts p
            WHERE p.id = (SELECT in_reply_to FROM posts WHERE id = get_activitypub_conversation_context.post_id)
            ), '[]'::jsonb
        ) as ancestors,
        -- Get descendants (replies to this post)
        COALESCE(
            (SELECT jsonb_agg(
                jsonb_build_object(
                    'id', p.id,
                    'content', p.content,
                    'author_id', p.author_id,
                    'created_at', p.created_at
                ) ORDER BY p.created_at ASC
            )
            FROM posts p
            WHERE p.in_reply_to = get_activitypub_conversation_context.post_id
            ), '[]'::jsonb
        ) as descendants;
END;
$$;

COMMENT ON FUNCTION public.get_activitypub_conversation_context IS 'Get conversation context (ancestors and descendants) for a post';

-- ---------------------------------------------------------------------------
-- 3. get_activitypub_conversation_thread - Get all posts in a conversation
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_activitypub_conversation_thread(in_conversation_root_id text)
RETURNS TABLE(
    id uuid,
    content jsonb,
    author_id uuid,
    created_at timestamptz,
    in_reply_to uuid,
    conversation_root_id uuid
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id,
        p.content,
        p.author_id,
        p.created_at,
        p.in_reply_to,
        p.conversation_root_id
    FROM posts p
    WHERE p.conversation_root_id::text = in_conversation_root_id
    ORDER BY p.created_at ASC;
END;
$$;

COMMENT ON FUNCTION public.get_activitypub_conversation_thread IS 'Get all posts in an ActivityPub conversation thread';

-- ---------------------------------------------------------------------------
-- 4. get_emoji_usage_analytics - Get emoji usage analytics for a server
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_emoji_usage_analytics(
    p_server_id uuid,
    p_user_id uuid DEFAULT NULL,
    p_limit integer DEFAULT 10
)
RETURNS TABLE(
    emoji_id uuid,
    emoji_name text,
    emoji_url text,
    usage_count bigint,
    last_used timestamptz
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.id as emoji_id,
        e.name::text as emoji_name,
        e.url::text as emoji_url,
        COUNT(eu.id)::bigint as usage_count,
        MAX(eu.used_at) as last_used
    FROM emojis e
    LEFT JOIN emoji_usage eu ON e.id = eu.emoji_id 
        AND (p_user_id IS NULL OR eu.user_id = p_user_id)
    WHERE e.server_id = p_server_id
    GROUP BY e.id, e.name, e.url
    ORDER BY usage_count DESC
    LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION public.get_emoji_usage_analytics IS 'Get emoji usage analytics for a server';

-- ---------------------------------------------------------------------------
-- 5. get_most_used_emojis - Get most frequently used emojis
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_most_used_emojis(
    server_ids uuid[] DEFAULT NULL,
    "limit" integer DEFAULT 100
)
RETURNS TABLE(
    emoji_id uuid,
    emoji_name text,
    emoji_url text,
    server_id uuid,
    usage_count bigint
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.id as emoji_id,
        e.name::text as emoji_name,
        e.url::text as emoji_url,
        e.server_id,
        COALESCE(e.usage_count, 0)::bigint as usage_count
    FROM emojis e
    WHERE (server_ids IS NULL OR e.server_id = ANY(server_ids))
    ORDER BY e.usage_count DESC NULLS LAST
    LIMIT "limit";
END;
$$;

COMMENT ON FUNCTION public.get_most_used_emojis IS 'Get most frequently used emojis across servers';

-- ---------------------------------------------------------------------------
-- 6. get_user_emoji_stats - Get user emoji usage statistics
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_user_emoji_stats(
    p_user_id uuid,
    p_server_id uuid DEFAULT NULL,
    p_limit integer DEFAULT 20
)
RETURNS TABLE(
    emoji_id uuid,
    emoji_name text,
    emoji_url text,
    usage_count bigint,
    last_used timestamptz
)
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        eu.emoji_id,
        e.name::text as emoji_name,
        e.url::text as emoji_url,
        COUNT(eu.id)::bigint as usage_count,
        MAX(eu.used_at) as last_used
    FROM emoji_usage eu
    JOIN emojis e ON eu.emoji_id = e.id
    WHERE eu.user_id = p_user_id
        AND (p_server_id IS NULL OR eu.server_id = p_server_id)
    GROUP BY eu.emoji_id, e.name, e.url
    ORDER BY usage_count DESC
    LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION public.get_user_emoji_stats IS 'Get emoji usage statistics for a specific user';

-- ---------------------------------------------------------------------------
-- 7. reset_daily_hashtag_counters - Reset daily hashtag counters
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_daily_hashtag_counters()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Reset daily counters in hashtags table
    UPDATE public.hashtags
    SET 
        daily_uses = 0,
        updated_at = NOW()
    WHERE daily_uses > 0;
    
    RAISE NOTICE 'Daily hashtag counters reset';
EXCEPTION WHEN undefined_column THEN
    -- Column doesn't exist, skip
    RAISE NOTICE 'daily_uses column does not exist, skipping reset';
END;
$$;

COMMENT ON FUNCTION public.reset_daily_hashtag_counters IS 'Reset daily hashtag usage counters (called by scheduled job)';

-- ---------------------------------------------------------------------------
-- 8. update_hashtag_trending_scores - Update trending scores for hashtags
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_hashtag_trending_scores()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Update trending scores based on recent usage
    -- Using the actual column names: daily_uses, weekly_uses, total_uses
    -- Note: hashtags table doesn't have a trending_score column, 
    -- so we just update the weekly counter based on daily
    UPDATE public.hashtags
    SET 
        weekly_uses = COALESCE(weekly_uses, 0) + COALESCE(daily_uses, 0),
        updated_at = NOW()
    WHERE daily_uses > 0;
    
    RAISE NOTICE 'Hashtag trending scores updated';
EXCEPTION WHEN undefined_column THEN
    -- Columns don't exist, skip
    RAISE NOTICE 'trending columns do not exist, skipping update';
END;
$$;

COMMENT ON FUNCTION public.update_hashtag_trending_scores IS 'Update trending scores for hashtags based on usage patterns';

-- ---------------------------------------------------------------------------
-- 9. update_trending_posts - Update trending posts rankings
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_trending_posts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_now timestamptz := NOW();
    v_period_start timestamptz := date_trunc('day', NOW());
    v_period_end timestamptz := v_period_start + INTERVAL '1 day';
BEGIN
    -- Delete old trending entries for today's period
    DELETE FROM public.trending_posts 
    WHERE period_start = v_period_start AND period_type = 'daily';
    
    -- Insert new trending posts based on engagement
    -- Using actual columns: trending_score, engagement_score, velocity_score, 
    -- period_type, period_start, period_end, likes_count, reblogs_count, replies_count
    -- Posts table uses favorites_count (not likes_count)
    INSERT INTO public.trending_posts (
        post_id, 
        trending_score, 
        engagement_score, 
        velocity_score,
        period_type,
        period_start, 
        period_end,
        likes_count,
        reblogs_count,
        replies_count
    )
    SELECT 
        p.id,
        -- Trending score with time decay
        (COALESCE(p.favorites_count, 0) + COALESCE(p.reblogs_count, 0) * 2 + COALESCE(p.replies_count, 0) * 1.5) 
        * (1.0 / (EXTRACT(EPOCH FROM (v_now - p.created_at)) / 3600 + 1)) as trending_score,
        -- Total engagement
        (COALESCE(p.favorites_count, 0) + COALESCE(p.reblogs_count, 0) + COALESCE(p.replies_count, 0))::numeric as engagement_score,
        -- Velocity based on recency
        CASE 
            WHEN p.created_at > v_now - INTERVAL '1 hour' THEN 10.0
            WHEN p.created_at > v_now - INTERVAL '6 hours' THEN 5.0
            ELSE 1.0
        END::numeric as velocity_score,
        'daily'::text,
        v_period_start,
        v_period_end,
        COALESCE(p.favorites_count, 0),
        COALESCE(p.reblogs_count, 0),
        COALESCE(p.replies_count, 0)
    FROM posts p
    WHERE p.created_at > v_now - INTERVAL '48 hours'
        AND p.visibility IN ('public', 'unlisted')
    ORDER BY trending_score DESC
    LIMIT 100;
    
    RAISE NOTICE 'Trending posts updated';
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'trending_posts table does not exist, skipping update';
WHEN undefined_column THEN
    RAISE NOTICE 'Required columns do not exist, skipping update';
END;
$$;

COMMENT ON FUNCTION public.update_trending_posts IS 'Update trending posts rankings based on engagement metrics';

-- ---------------------------------------------------------------------------
-- VERIFICATION
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    RAISE NOTICE '✅ Stub functions created successfully!';
    RAISE NOTICE 'These are temporary implementations - see TODO_cleanRPC.md for details';
END $$;


-- ---------------------------------------------------------------------------
-- check_key_consistency - Check for users with inconsistent key state
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.check_key_consistency() 
RETURNS TABLE(user_id uuid, username text, has_public_key boolean, has_private_key boolean)
LANGUAGE plpgsql 
SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id as user_id,
        p.username,
        (p.public_key IS NOT NULL) as has_public_key,
        (upk.id IS NOT NULL) as has_private_key
    FROM profiles p
    LEFT JOIN user_private_keys upk ON upk.user_id = p.id
    WHERE p.is_local = true
    AND (
        -- Has public key but no private key (broken)
        (p.public_key IS NOT NULL AND upk.id IS NULL)
        OR
        -- Has private key but no public key (also broken)
        (p.public_key IS NULL AND upk.id IS NOT NULL)
    );
END;
$$;

COMMENT ON FUNCTION public.check_key_consistency() IS 'Check for local users with inconsistent key state (public key without private key or vice versa)';
