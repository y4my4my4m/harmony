BEGIN;

-- Fix: send_notification() was ANDing content toggles (e.g. activitypub_favorites)
-- with desktop toggles (e.g. activitypub_desktop_favorites) to decide whether to
-- CREATE the notification record. Desktop toggles for favorites/reblogs/reactions
-- default to false, so the notification was never created - neither in-app nor push.
--
-- The fix: only check the content toggle for notification record creation.
-- Desktop/push delivery preferences are enforced separately by PushNotificationService.

CREATE OR REPLACE FUNCTION public.send_notification(p_notification_type character varying, to_user_ids uuid[], notification_data jsonb DEFAULT '{}'::jsonb, server_id uuid DEFAULT NULL::uuid, channel_id uuid DEFAULT NULL::uuid, conversation_id uuid DEFAULT NULL::uuid, from_user_id uuid DEFAULT NULL::uuid, priority character varying DEFAULT 'normal'::character varying) RETURNS uuid[]
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
    IF p_notification_type IS NULL OR array_length(to_user_ids, 1) IS NULL THEN
        RETURN '{}';
    END IF;

    -- Determine if this is an ActivityPub notification type
    is_activitypub_type := p_notification_type LIKE 'activitypub_%';

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
                AND um.hide_notifications = true
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
        IF from_user_id IS NOT NULL AND p_notification_type IN ('reaction', 'activitypub_reaction') THEN
            INSERT INTO notification_rate_limits (user_id, notification_type, source_user_id)
            VALUES (recipient_id, p_notification_type, from_user_id)
            ON CONFLICT (user_id, notification_type, source_user_id)
            DO UPDATE SET
                notification_count = notification_rate_limits.notification_count + 1,
                last_notification_at = NOW();

            SELECT
                (nrl.notification_count > 3) OR
                (nrl.notification_count > 1 AND nrl.last_notification_at > v_time_threshold) OR
                (nrl.suppressed_until IS NOT NULL AND nrl.suppressed_until > NOW())
            INTO is_rate_limited
            FROM notification_rate_limits nrl
            WHERE nrl.user_id = recipient_id
              AND nrl.notification_type = p_notification_type
              AND nrl.source_user_id = from_user_id;

            IF is_rate_limited THEN
                UPDATE notification_rate_limits nrl
                SET suppressed_until = NOW() + INTERVAL '2 minutes'
                WHERE nrl.user_id = recipient_id
                  AND nrl.notification_type = p_notification_type
                  AND nrl.source_user_id = from_user_id;
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
                ELSE
                    -- Only check the content toggle for notification creation.
                    -- Desktop/push toggles are enforced by PushNotificationService.
                    CASE p_notification_type
                        WHEN 'activitypub_follow' THEN
                            should_send := COALESCE(user_prefs.activitypub_follows, true);
                        WHEN 'activitypub_follow_request' THEN
                            should_send := COALESCE(user_prefs.activitypub_follow_requests, true);
                        WHEN 'activitypub_favorite' THEN
                            should_send := COALESCE(user_prefs.activitypub_favorites, true);
                        WHEN 'activitypub_reblog' THEN
                            should_send := COALESCE(user_prefs.activitypub_reblogs, true);
                        WHEN 'activitypub_mention' THEN
                            should_send := COALESCE(user_prefs.activitypub_mentions, true);
                        WHEN 'activitypub_reply' THEN
                            should_send := COALESCE(user_prefs.activitypub_replies, true);
                        WHEN 'activitypub_reaction' THEN
                            should_send := COALESCE(user_prefs.activitypub_favorites, true);
                        ELSE
                            should_send := true;
                    END CASE;
                END IF;
            ELSE
                -- Check desktop_notifications master toggle first for non-ActivityPub
                IF COALESCE(user_prefs.desktop_notifications, true) = false THEN
                    IF p_notification_type NOT IN ('mention', 'dm') THEN
                        should_send := false;
                    END IF;
                END IF;

                IF should_send THEN
                    CASE p_notification_type
                        WHEN 'mention' THEN
                            should_send := COALESCE(user_prefs.desktop_mentions, true);
                        WHEN 'reply' THEN
                            should_send := COALESCE(user_prefs.desktop_replies, true);
                        WHEN 'dm' THEN
                            should_send := COALESCE(user_prefs.desktop_dms, true);
                        WHEN 'reaction' THEN
                            should_send := COALESCE(user_prefs.desktop_reactions, true);
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
                p_notification_type,
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

NOTIFY pgrst, 'reload schema';

COMMIT;
