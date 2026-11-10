-- A thread shown full page is a viewed context, as a channel or a DM is.
--
-- device_view_contexts.thread_id
--   The thread a device shows, with view_type 'thread'. Written by
--   sync_view_context_from_presence(..., p_thread_id); a client without the argument writes NULL.
-- is_user_viewing_thread(user, thread)
--   A current row (150 s, as is_user_viewing_context) of that user shows that thread.
-- send_notification
--   20261105200001 plus the thread: a channel notification's thread is data.thread_id or
--   data.thread.id, else the thread of data.message_id. A recipient with a device showing that
--   thread gets no row. The row carries thread_id, so a mention in a thread opens and is read
--   there (src/utils/notificationRoute.ts, ViewContextTracker).
-- mark_notifications_read_by_context('thread', id)
--   Reads the caller's notifications of that thread.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.device_view_contexts ADD COLUMN IF NOT EXISTS thread_id uuid;

DROP FUNCTION IF EXISTS public.sync_view_context_from_presence(text, uuid, uuid, uuid, text);

CREATE OR REPLACE FUNCTION public.sync_view_context_from_presence(
    p_view_type text,
    p_server_id uuid DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL,
    p_device_id text DEFAULT '',
    p_thread_id uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile_id uuid := public.get_current_profile_id();
    v_device_id text := left(COALESCE(p_device_id, ''), 64);
BEGIN
    IF v_profile_id IS NULL THEN
        RETURN;
    END IF;

    INSERT INTO public.device_view_contexts
        (user_id, device_id, view_type, server_id, channel_id, conversation_id, thread_id, last_active_at)
    VALUES
        (v_profile_id, v_device_id, COALESCE(p_view_type, 'home'),
         p_server_id, p_channel_id, p_conversation_id, p_thread_id, now())
    ON CONFLICT (user_id, device_id) DO UPDATE
    SET view_type = EXCLUDED.view_type,
        server_id = EXCLUDED.server_id,
        channel_id = EXCLUDED.channel_id,
        conversation_id = EXCLUDED.conversation_id,
        thread_id = EXCLUDED.thread_id,
        last_active_at = EXCLUDED.last_active_at;

    -- Device ids are per tab; rows of closed tabs are pruned on the owner's next write.
    DELETE FROM public.device_view_contexts
     WHERE user_id = v_profile_id
       AND last_active_at < now() - interval '1 day';
END;
$$;

COMMENT ON FUNCTION public.sync_view_context_from_presence(text, uuid, uuid, uuid, text, uuid) IS
    'Records the calling device''s view. view_type ''away'' marks a hidden or idle device; ''thread'' with p_thread_id a thread shown full page.';

REVOKE ALL ON FUNCTION public.sync_view_context_from_presence(text, uuid, uuid, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_view_context_from_presence(text, uuid, uuid, uuid, text, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_user_viewing_thread(
    p_user_id uuid,
    p_thread_id uuid
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.device_view_contexts d
         WHERE d.user_id = p_user_id
           AND d.last_active_at > now() - interval '150 seconds'
           AND d.view_type = 'thread'
           AND d.thread_id = p_thread_id
    );
$$;

REVOKE ALL ON FUNCTION public.is_user_viewing_thread(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_user_viewing_thread(uuid, uuid) TO service_role;

-- Prod definers have mixed owners, postgres and supabase_admin, and CREATE OR REPLACE keeps
-- send_notification's. A non-superuser owner has no EXECUTE on a helper with PUBLIC revoked.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT DISTINCT pg_get_userbyid(p.proowner) AS owner
          FROM pg_proc p
         WHERE p.proname = 'send_notification' AND p.pronamespace = 'public'::regnamespace
    LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.is_user_viewing_thread(uuid, uuid) TO %I', r.owner);
    END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION public.send_notification(p_notification_type character varying, to_user_ids uuid[], notification_data jsonb DEFAULT '{}'::jsonb, p_server_id uuid DEFAULT NULL::uuid, p_channel_id uuid DEFAULT NULL::uuid, p_conversation_id uuid DEFAULT NULL::uuid, p_from_user_id uuid DEFAULT NULL::uuid, p_priority character varying DEFAULT 'normal'::character varying)
 RETURNS uuid[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    created_notification_ids uuid[] := '{}';
    recipient_id uuid;
    user_prefs record;
    should_send boolean;
    notification_id uuid;
    v_now timestamp with time zone := now();
    enhanced_data jsonb;
    is_blocked boolean;
    is_muted boolean;
    is_rate_limited boolean;
    is_activitypub_type boolean;
    v_time_threshold timestamp with time zone := NOW() - INTERVAL '2 minutes';
    v_server_id uuid := p_server_id;
    v_policy record;
    v_is_mention_type boolean;
    v_is_everyone boolean;
    v_is_role_mention boolean;
    v_passes_mentions boolean;
    v_thread_ref text;
    v_thread_id uuid;
BEGIN
    IF p_notification_type IS NULL OR array_length(to_user_ids, 1) IS NULL THEN
        RETURN '{}';
    END IF;

    IF v_server_id IS NULL AND p_channel_id IS NOT NULL THEN
        SELECT c.server_id INTO v_server_id FROM channels c WHERE c.id = p_channel_id;
    END IF;

    -- A channel message in a thread: the thread named in the data, else the message's thread.
    IF p_channel_id IS NOT NULL THEN
        v_thread_ref := COALESCE(notification_data->>'thread_id', notification_data->'thread'->>'id');
        IF v_thread_ref ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            v_thread_id := v_thread_ref::uuid;
        ELSIF (notification_data->>'message_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            SELECT m.thread_id INTO v_thread_id
              FROM messages m
             WHERE m.id = (notification_data->>'message_id')::uuid;
        END IF;
    END IF;

    is_activitypub_type := p_notification_type LIKE 'activitypub_%';
    v_is_mention_type := p_notification_type IN ('mention', 'activitypub_mention');
    v_is_everyone := v_is_mention_type AND COALESCE(notification_data->>'is_everyone' = 'true', false);
    v_is_role_mention := v_is_mention_type AND NOT v_is_everyone
                         AND COALESCE(notification_data->>'is_role_mention' = 'true', false);
    -- Admitted at level 'mentions': mentions, and activity on the recipient's own message,
    -- post or joined thread.
    v_passes_mentions := v_is_mention_type OR p_notification_type IN (
        'reaction', 'activitypub_reaction', 'activitypub_favorite', 'activitypub_reblog', 'thread_reply'
    );

    FOREACH recipient_id IN ARRAY to_user_ids LOOP
        IF recipient_id IS NULL OR (p_from_user_id IS NOT NULL AND recipient_id = p_from_user_id) THEN
            CONTINUE;
        END IF;

        IF p_from_user_id IS NOT NULL THEN
            SELECT EXISTS (
                SELECT 1 FROM user_blocks ub
                WHERE ub.blocker_id = recipient_id
                AND ub.blocked_user_id = p_from_user_id
                AND (ub.expires_at IS NULL OR ub.expires_at > NOW())
            ) INTO is_blocked;
            IF is_blocked THEN CONTINUE; END IF;

            SELECT EXISTS (
                SELECT 1 FROM user_mutes um
                WHERE um.muter_id = recipient_id
                AND um.muted_user_id = p_from_user_id
                AND um.hide_notifications = true
                AND (um.expires_at IS NULL OR um.expires_at > NOW())
            ) INTO is_muted;
            IF is_muted THEN CONTINUE; END IF;
        END IF;

        -- Server-scoped: accepted members only, under their settings for the server.
        IF v_server_id IS NOT NULL THEN
            SELECT * INTO v_policy FROM public.notification_policy(recipient_id, v_server_id, p_channel_id);
            IF NOT FOUND THEN
                CONTINUE;
            END IF;
            IF v_policy.muted AND NOT v_is_mention_type THEN
                CONTINUE;
            END IF;
            IF (v_is_everyone AND v_policy.suppress_everyone)
               OR (v_is_role_mention AND v_policy.suppress_roles) THEN
                CONTINUE;
            END IF;
            IF p_channel_id IS NOT NULL
               AND (v_policy.level = 'none' OR (v_policy.level = 'mentions' AND NOT v_passes_mentions)) THEN
                CONTINUE;
            END IF;
        END IF;

        -- Channel-scoped notifications carry channel content: VIEW_CHANNEL.
        IF p_channel_id IS NOT NULL AND NOT public.can_view_channel(recipient_id, p_channel_id) THEN
            CONTINUE;
        END IF;

        -- A muted conversation admits mentions only; levels apply to channels.
        IF p_conversation_id IS NOT NULL AND NOT v_is_mention_type AND EXISTS (
            SELECT 1 FROM notification_channels nc
             WHERE nc.user_id = recipient_id
               AND nc.conversation_id = p_conversation_id
               AND nc.muted = true
               AND (nc.muted_until IS NULL OR nc.muted_until > NOW())
        ) THEN
            CONTINUE;
        END IF;

        -- View-context suppression
        IF (v_server_id IS NOT NULL AND p_channel_id IS NOT NULL) OR p_conversation_id IS NOT NULL THEN
            IF public.is_user_viewing_context(recipient_id, v_server_id, p_channel_id, p_conversation_id) THEN
                CONTINUE;
            END IF;
        END IF;
        IF v_thread_id IS NOT NULL AND public.is_user_viewing_thread(recipient_id, v_thread_id) THEN
            CONTINUE;
        END IF;

        -- Rate limit reaction notifications (sliding window: resets after 2 min of quiet)
        IF p_from_user_id IS NOT NULL AND p_notification_type IN ('reaction', 'activitypub_reaction') THEN
            INSERT INTO notification_rate_limits (user_id, notification_type, source_user_id,
                                                  notification_count, last_notification_at, suppressed_until)
            VALUES (recipient_id, p_notification_type, p_from_user_id, 1, NOW(), NULL)
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
                END;

            SELECT
                nrl.notification_count > 3 OR
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
                        WHEN 'activitypub_quote' THEN
                            should_send := COALESCE(user_prefs.activitypub_quotes, true);
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
                        WHEN 'channel_message' THEN
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
        END IF;

        enhanced_data := notification_data;
        IF v_server_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('server_id', v_server_id);
        END IF;
        IF p_channel_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('channel_id', p_channel_id);
        END IF;
        IF p_conversation_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('conversation_id', p_conversation_id);
        END IF;
        IF v_thread_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('thread_id', v_thread_id);
        END IF;
        IF p_from_user_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('from_user_id', p_from_user_id);
        END IF;
        IF p_priority IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('priority', p_priority);
        END IF;

        IF should_send THEN
            INSERT INTO notifications (type, user_id, data, created_at)
            VALUES (p_notification_type, recipient_id, enhanced_data, v_now)
            RETURNING id INTO notification_id;

            created_notification_ids := array_append(created_notification_ids, notification_id);
        END IF;

    END LOOP;

    RETURN created_notification_ids;
END;
$function$;

CREATE OR REPLACE FUNCTION public.mark_notifications_read_by_context(
    p_context_type text,
    p_context_id text
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
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
                  WHEN 'thread' THEN
                      data->>'thread_id' = p_context_id
                      OR data->'thread'->>'id' = p_context_id
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

COMMIT;

NOTIFY pgrst, 'reload schema';
