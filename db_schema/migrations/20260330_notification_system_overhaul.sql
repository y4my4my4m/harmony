BEGIN;

-- =============================================================================
-- Notification System Overhaul Migration
-- Phases 1-8: notification levels, muted unread suppression, auto-clear,
-- DM unread tracking, bulk mark-read, thread notifications, missing types
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Phase 7 prerequisite: Add muted column to thread_members
-- ---------------------------------------------------------------------------
ALTER TABLE public.thread_members ADD COLUMN IF NOT EXISTS muted boolean DEFAULT false;

-- ---------------------------------------------------------------------------
-- Phase 1 + 2: Updated send_notification with notification_level enforcement
-- ---------------------------------------------------------------------------
-- Drop first: PostgreSQL requires DROP when renaming parameters
DROP FUNCTION IF EXISTS public.send_notification_to_user(character varying, uuid, jsonb, uuid, uuid, uuid, uuid, character varying);
DROP FUNCTION IF EXISTS public.send_notification(character varying, uuid[], jsonb, uuid, uuid, uuid, uuid, character varying);

CREATE OR REPLACE FUNCTION public.send_notification(
    p_notification_type character varying,
    to_user_ids uuid[],
    notification_data jsonb DEFAULT '{}'::jsonb,
    p_server_id uuid DEFAULT NULL::uuid,
    p_channel_id uuid DEFAULT NULL::uuid,
    p_conversation_id uuid DEFAULT NULL::uuid,
    p_from_user_id uuid DEFAULT NULL::uuid,
    p_priority character varying DEFAULT 'normal'::character varying
) RETURNS uuid[]
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
    v_muted_until timestamp with time zone;
    is_rate_limited boolean;
    is_activitypub_type boolean;
    v_time_threshold timestamp with time zone := NOW() - INTERVAL '2 minutes';
    v_notification_level varchar(20);
    v_server_default varchar(20);
    v_is_mention_type boolean;
BEGIN
    IF p_notification_type IS NULL OR array_length(to_user_ids, 1) IS NULL THEN
        RETURN '{}';
    END IF;

    is_activitypub_type := p_notification_type LIKE 'activitypub_%';
    v_is_mention_type := p_notification_type IN ('mention', 'activitypub_mention');

    FOREACH recipient_id IN ARRAY to_user_ids LOOP
        IF p_from_user_id IS NOT NULL AND recipient_id = p_from_user_id THEN
            CONTINUE;
        END IF;

        -- Check if sender is blocked by recipient
        IF p_from_user_id IS NOT NULL THEN
            SELECT EXISTS (
                SELECT 1 FROM user_blocks ub
                WHERE ub.blocker_id = recipient_id
                AND ub.blocked_user_id = p_from_user_id
                AND (ub.expires_at IS NULL OR ub.expires_at > NOW())
            ) INTO is_blocked;
            IF is_blocked THEN CONTINUE; END IF;
        END IF;

        -- Check if sender is muted by recipient
        IF p_from_user_id IS NOT NULL THEN
            SELECT EXISTS (
                SELECT 1 FROM user_mutes um
                WHERE um.muter_id = recipient_id
                AND um.muted_user_id = p_from_user_id
                AND um.hide_notifications = true
                AND (um.expires_at IS NULL OR um.expires_at > NOW())
            ) INTO is_muted;
            IF is_muted THEN CONTINUE; END IF;
        END IF;

        -- Check channel/conversation mute + notification level
        IF p_channel_id IS NOT NULL OR p_conversation_id IS NOT NULL THEN
            SELECT nc.muted, nc.notification_level, nc.muted_until
            INTO is_channel_muted, v_notification_level, v_muted_until
            FROM notification_channels nc
            WHERE nc.user_id = recipient_id
            AND (
                (p_channel_id IS NOT NULL AND nc.channel_id = p_channel_id)
                OR
                (p_conversation_id IS NOT NULL AND nc.conversation_id = p_conversation_id)
            )
            LIMIT 1;

            -- Check if temporary mute has expired
            IF COALESCE(is_channel_muted, false) = true
               AND v_muted_until IS NOT NULL
               AND v_muted_until <= NOW() THEN
                is_channel_muted := false;
            END IF;

            -- Muted channel: skip everything EXCEPT mentions (Discord behavior)
            IF COALESCE(is_channel_muted, false) = true THEN
                IF NOT v_is_mention_type THEN
                    CONTINUE;
                END IF;
            END IF;

            -- Notification level enforcement (only for channel-based, not conversations)
            IF p_channel_id IS NOT NULL AND v_notification_level IS NULL THEN
                SELECT ss.default_message_notifications INTO v_server_default
                FROM server_settings ss
                WHERE ss.server_id = p_server_id;
                v_notification_level := COALESCE(v_server_default, 'all');
            END IF;

            IF v_notification_level = 'none' THEN
                CONTINUE;
            ELSIF v_notification_level = 'mentions' THEN
                IF NOT v_is_mention_type THEN
                    CONTINUE;
                END IF;
            END IF;
        END IF;

        -- View-context suppression
        IF (p_server_id IS NOT NULL AND p_channel_id IS NOT NULL) OR p_conversation_id IS NOT NULL THEN
            IF public.is_user_viewing_context(recipient_id, p_server_id, p_channel_id, p_conversation_id) THEN
                CONTINUE;
            END IF;
        END IF;

        -- Rate limit reaction notifications
        IF p_from_user_id IS NOT NULL AND p_notification_type IN ('reaction', 'activitypub_reaction') THEN
            INSERT INTO notification_rate_limits (user_id, notification_type, source_user_id)
            VALUES (recipient_id, p_notification_type, p_from_user_id)
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
              AND nrl.source_user_id = p_from_user_id;

            IF is_rate_limited THEN
                UPDATE notification_rate_limits nrl
                SET suppressed_until = NOW() + INTERVAL '2 minutes'
                WHERE nrl.user_id = recipient_id
                  AND nrl.notification_type = p_notification_type
                  AND nrl.source_user_id = p_from_user_id;
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

        should_send := true;

        IF user_prefs IS NOT NULL THEN
            IF is_activitypub_type THEN
                IF COALESCE(user_prefs.activitypub_notifications, true) = false THEN
                    should_send := false;
                ELSE
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
                        WHEN 'chat_message' THEN
                            should_send := COALESCE(user_prefs.desktop_chat_messages, true);
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
                        WHEN 'thread_reply' THEN
                            should_send := COALESCE(user_prefs.desktop_replies, true);
                        ELSE
                            should_send := true;
                    END CASE;
                END IF;
            END IF;

            -- DND enforcement
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

        -- Build enhanced data
        enhanced_data := notification_data;
        IF p_server_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('server_id', p_server_id);
        END IF;
        IF p_channel_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('channel_id', p_channel_id);
        END IF;
        IF p_conversation_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('conversation_id', p_conversation_id);
        END IF;
        IF p_from_user_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('from_user_id', p_from_user_id);
        END IF;
        IF p_priority IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('priority', p_priority);
        END IF;

        IF should_send THEN
            INSERT INTO notifications (type, user_id, data, created_at)
            VALUES (p_notification_type, recipient_id, enhanced_data, current_timestamp)
            RETURNING id INTO notification_id;

            created_notification_ids := array_append(created_notification_ids, notification_id);
        END IF;

    END LOOP;

    RETURN created_notification_ids;
END;
$$;

-- ---------------------------------------------------------------------------
-- Phase 2: Updated handle_new_message_unread - skip muted channels
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_message_unread()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_server_id uuid;
BEGIN
    IF NEW.channel_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT server_id INTO v_server_id
    FROM public.channels WHERE id = NEW.channel_id;

    IF v_server_id IS NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.unread_counts (user_id, server_id, channel_id, unread_messages)
    SELECT us.user_id, v_server_id, NEW.channel_id, 1
    FROM public.user_servers us
    WHERE us.server_id = v_server_id
      AND us.status = 'accepted'
      AND us.user_id != NEW.user_id
      AND NOT EXISTS (
          SELECT 1 FROM public.notification_channels nc
          WHERE nc.user_id = us.user_id
            AND nc.channel_id = NEW.channel_id
            AND nc.muted = true
            AND (nc.muted_until IS NULL OR nc.muted_until > NOW())
      )
    ON CONFLICT (user_id, channel_id) WHERE channel_id IS NOT NULL
    DO UPDATE SET
        unread_messages = unread_counts.unread_messages + 1,
        updated_at = now();

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Phase 3: mark_notifications_read_by_context RPC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_notifications_read_by_context(
    p_context_type text,
    p_context_id text
) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_user_id uuid;
    v_count integer;
BEGIN
    v_user_id := public.get_current_profile_id();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    WITH updated AS (
        UPDATE notifications
        SET is_read = true, read_at = NOW(), updated_at = NOW()
        WHERE user_id = v_user_id
          AND is_read = false
          AND (
              CASE p_context_type
                  WHEN 'channel' THEN
                      data->>'channel_id' = p_context_id
                      OR data->'location'->>'channel_id' = p_context_id
                  WHEN 'conversation' THEN
                      data->>'conversation_id' = p_context_id
                      OR data->'conversation'->>'id' = p_context_id
                  WHEN 'post' THEN
                      data->>'post_id' = p_context_id
                      OR data->'post'->>'id' = p_context_id
                  WHEN 'server' THEN
                      data->>'server_id' = p_context_id
                      OR data->'location'->>'server_id' = p_context_id
                  ELSE false
              END
          )
        RETURNING id
    )
    SELECT count(*) INTO v_count FROM updated;

    RETURN v_count;
END;
$$;

-- ---------------------------------------------------------------------------
-- Phase 4: DM unread tracking trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_dm_unread()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    IF NEW.conversation_id IS NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.unread_counts (user_id, server_id, channel_id, conversation_id, unread_messages)
    SELECT cp.user_id, NULL, NULL, NEW.conversation_id, 1
    FROM public.conversation_participants cp
    WHERE cp.conversation_id = NEW.conversation_id
      AND cp.user_id != NEW.user_id
      AND cp.left_at IS NULL
      AND NOT EXISTS (
          SELECT 1 FROM public.notification_channels nc
          WHERE nc.user_id = cp.user_id
            AND nc.conversation_id = NEW.conversation_id
            AND nc.muted = true
            AND (nc.muted_until IS NULL OR nc.muted_until > NOW())
      )
    ON CONFLICT (user_id, conversation_id) WHERE conversation_id IS NOT NULL
    DO UPDATE SET
        unread_messages = unread_counts.unread_messages + 1,
        updated_at = now();

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_new_dm_unread ON public.messages;
CREATE TRIGGER trigger_new_dm_unread
    AFTER INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.conversation_id IS NOT NULL AND NEW.is_deleted = false AND NEW.is_system = false)
    EXECUTE FUNCTION public.handle_new_dm_unread();

-- ---------------------------------------------------------------------------
-- Phase 6: Updated mark_all_notifications_read - suppress per-row broadcasts
-- Uses a single bulk broadcast instead of triggering per-row events
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_all_notifications_read(p_user_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_count integer;
    v_profile_id uuid;
BEGIN
    -- Verify the caller is acting on their own notifications
    v_profile_id := get_current_profile_id();
    IF v_profile_id IS NULL OR v_profile_id != p_user_id THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    -- Temporarily disable the broadcast trigger to prevent per-row storms
    ALTER TABLE notifications DISABLE TRIGGER trg_broadcast_notification;

    UPDATE notifications
    SET is_read = true, read_at = NOW(), updated_at = NOW()
    WHERE user_id = p_user_id AND is_read = false;

    GET DIAGNOSTICS v_count = ROW_COUNT;

    -- Re-enable the trigger
    ALTER TABLE notifications ENABLE TRIGGER trg_broadcast_notification;

    -- Send a single bulk broadcast event
    IF v_count > 0 THEN
        BEGIN
            PERFORM realtime.send(
                jsonb_build_object(
                    'type', 'notification:bulk_read',
                    'count', v_count
                ),
                'user_event',
                'user:' || p_user_id::text,
                true
            );
        EXCEPTION WHEN OTHERS THEN
            NULL; -- Broadcast is best-effort
        END;
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Phase 7: Thread reply notification trigger
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_thread_reply_notification()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_thread record;
    v_sender record;
    v_channel_id uuid;
    v_server_id uuid;
    v_channel_name text;
    v_server_name text;
    content_preview text;
    v_member record;
BEGIN
    IF NEW.thread_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT t.id, t.parent_message_id, t.channel_id, t.created_by
    INTO v_thread
    FROM threads t WHERE t.id = NEW.thread_id;

    IF NOT FOUND THEN RETURN NEW; END IF;

    v_channel_id := v_thread.channel_id;

    SELECT c.server_id, c.name INTO v_server_id, v_channel_name
    FROM channels c WHERE c.id = v_channel_id;

    IF v_server_id IS NOT NULL THEN
        SELECT s.name INTO v_server_name FROM servers s WHERE s.id = v_server_id;
    END IF;

    SELECT p.id, p.username, p.display_name, p.avatar_url
    INTO v_sender FROM profiles p WHERE p.id = NEW.user_id;

    content_preview := extract_message_text(NEW.content);
    content_preview := TRIM(content_preview);
    IF LENGTH(content_preview) > 100 THEN
        content_preview := LEFT(content_preview, 100) || '...';
    END IF;
    IF content_preview = '' OR content_preview IS NULL THEN
        content_preview := 'New thread reply';
    END IF;

    -- Notify all thread members (except sender) who haven't muted the thread
    FOR v_member IN
        SELECT tm.user_id
        FROM thread_members tm
        WHERE tm.thread_id = NEW.thread_id
          AND tm.user_id != NEW.user_id
          AND COALESCE(tm.muted, false) = false
    LOOP
        PERFORM send_notification_to_user(
            'thread_reply',
            v_member.user_id,
            jsonb_build_object(
                'sender', jsonb_build_object(
                    'user_id', v_sender.id,
                    'username', v_sender.username,
                    'display_name', v_sender.display_name,
                    'avatar_url', v_sender.avatar_url
                ),
                'message', jsonb_build_object(
                    'id', NEW.id,
                    'content_preview', content_preview
                ),
                'thread', jsonb_build_object(
                    'id', NEW.thread_id,
                    'parent_message_id', v_thread.parent_message_id
                ),
                'location', jsonb_build_object(
                    'server_id', v_server_id::text,
                    'server_name', v_server_name,
                    'channel_id', v_channel_id::text,
                    'channel_name', v_channel_name
                ),
                'message_id', NEW.id,
                'thread_id', NEW.thread_id,
                'server_id', v_server_id::text,
                'channel_id', v_channel_id::text,
                'preview', content_preview
            ),
            v_server_id,
            v_channel_id,
            NULL,
            NEW.user_id,
            'normal'
        );
    END LOOP;

    -- Also notify the thread creator if not already a member and not the sender
    IF v_thread.created_by IS NOT NULL
       AND v_thread.created_by != NEW.user_id
       AND NOT EXISTS (
           SELECT 1 FROM thread_members
           WHERE thread_id = NEW.thread_id AND user_id = v_thread.created_by
       )
    THEN
        PERFORM send_notification_to_user(
            'thread_reply',
            v_thread.created_by,
            jsonb_build_object(
                'sender', jsonb_build_object(
                    'user_id', v_sender.id,
                    'username', v_sender.username,
                    'display_name', v_sender.display_name,
                    'avatar_url', v_sender.avatar_url
                ),
                'message', jsonb_build_object(
                    'id', NEW.id,
                    'content_preview', content_preview
                ),
                'thread', jsonb_build_object(
                    'id', NEW.thread_id,
                    'parent_message_id', v_thread.parent_message_id
                ),
                'location', jsonb_build_object(
                    'server_id', v_server_id::text,
                    'server_name', v_server_name,
                    'channel_id', v_channel_id::text,
                    'channel_name', v_channel_name
                ),
                'message_id', NEW.id,
                'thread_id', NEW.thread_id,
                'server_id', v_server_id::text,
                'channel_id', v_channel_id::text,
                'preview', content_preview
            ),
            v_server_id,
            v_channel_id,
            NULL,
            NEW.user_id,
            'normal'
        );
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_thread_reply_notification ON public.messages;
CREATE TRIGGER trigger_thread_reply_notification
    AFTER INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.thread_id IS NOT NULL AND NEW.is_deleted = false AND NEW.is_system = false)
    EXECUTE FUNCTION public.handle_thread_reply_notification();

-- ---------------------------------------------------------------------------
-- Phase 8: mark_server_as_read RPC
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_server_as_read(p_server_id uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_user_id uuid;
BEGIN
    v_user_id := public.get_current_profile_id();
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    UPDATE public.unread_counts
    SET unread_messages = 0, unread_mentions = 0,
        last_read_at = NOW(), updated_at = NOW()
    WHERE user_id = v_user_id AND server_id = p_server_id;

    -- Also mark channel-scoped notifications as read for this server
    UPDATE notifications
    SET is_read = true, read_at = NOW(), updated_at = NOW()
    WHERE user_id = v_user_id
      AND is_read = false
      AND (
          data->>'server_id' = p_server_id::text
          OR data->'location'->>'server_id' = p_server_id::text
      );
END;
$$;

-- ---------------------------------------------------------------------------
-- Phase 8b: Add chat_message preference columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.notification_preferences
    ADD COLUMN IF NOT EXISTS desktop_chat_messages boolean DEFAULT true,
    ADD COLUMN IF NOT EXISTS sound_chat_messages boolean DEFAULT true,
    ADD COLUMN IF NOT EXISTS sound_reactions boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS sound_replies boolean DEFAULT true;

COMMIT;

NOTIFY pgrst, 'reload schema';
