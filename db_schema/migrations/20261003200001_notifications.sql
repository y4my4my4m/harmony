-- Notifications: per-device view context, push pipeline convergence, quiet hours that
-- silence instead of drop, bulk read without a table lock, and a deletion broadcast.
--
-- View context. user_view_contexts held one row per user with no freshness check: the last
-- channel or DM a device showed stayed "viewed" after the tab closed or the phone went to
-- the background, and send_notification skipped every notification for it indefinitely.
-- device_view_contexts keys the context on (user, device); the client writes 'away' when
-- hidden or idle and rewrites its context every 60 s while visible. A row counts for
-- 150 s after its last write. user_view_contexts is left in place and no longer read.
-- Its primary key differs between instances (prod: user_id; fresh installs: id), which is
-- why the context moves to a new table instead of altering that one.
--
-- sync_view_context_from_presence gains p_device_id DEFAULT ''. The four-argument form is
-- dropped: two overloads matching the same named call are ambiguous to PostgREST. Clients
-- predating p_device_id share device '' per user.
--
-- has_active_session and is_user_viewing_push_context read user_sessions, which nothing
-- writes (SessionHeartbeat is disabled), so push_offline_only never took effect. Both now
-- read device_view_contexts.
--
-- Push pipeline. Staging lacks the (user_id, endpoint) unique key the backend upserts on
-- (every subscribe raised 42P10), the queue trigger, and the functions the push worker
-- calls. They are asserted by state here. delete_push_subscription_by_endpoint and
-- is_user_viewing_context were executable by anon; both are service-side only.
--
-- Quiet hours. send_notification dropped notifications during DND, so a mention overnight
-- never reached the inbox. The row is now created; the client suppresses toast, sound and
-- system notification, and the push worker suppresses push.
--
-- Bulk read. mark_all_notifications_read toggled trg_broadcast_notification with ALTER
-- TABLE, an ACCESS EXCLUSIVE lock on notifications for every caller. A transaction-local
-- setting now suppresses the per-row broadcast instead.
--
-- Deletion. Deleting a notification broadcast nothing, so other devices kept it and its
-- unread count. A statement-level trigger sends one notification:deleted per user; ids is
-- null above 500 rows, which clients treat as a refetch.

BEGIN;

-- ---------------------------------------------------------------------------
-- View context
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.device_view_contexts (
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    device_id text NOT NULL CHECK (length(device_id) <= 64),
    view_type text NOT NULL,
    server_id uuid,
    channel_id uuid,
    conversation_id uuid,
    last_active_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (user_id, device_id)
);

COMMENT ON TABLE public.device_view_contexts IS
    'Where each device of a user is looking. Written by sync_view_context_from_presence; a row is current for 150 s.';

ALTER TABLE public.device_view_contexts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.device_view_contexts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.device_view_contexts TO service_role;

DROP POLICY IF EXISTS "Service role manages device view contexts" ON public.device_view_contexts;
CREATE POLICY "Service role manages device view contexts" ON public.device_view_contexts
    AS PERMISSIVE FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

DROP FUNCTION IF EXISTS public.sync_view_context_from_presence(text, uuid, uuid, uuid);

CREATE OR REPLACE FUNCTION public.sync_view_context_from_presence(
    p_view_type text,
    p_server_id uuid DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL,
    p_device_id text DEFAULT ''
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
        (user_id, device_id, view_type, server_id, channel_id, conversation_id, last_active_at)
    VALUES
        (v_profile_id, v_device_id, COALESCE(p_view_type, 'home'),
         p_server_id, p_channel_id, p_conversation_id, now())
    ON CONFLICT (user_id, device_id) DO UPDATE
    SET view_type = EXCLUDED.view_type,
        server_id = EXCLUDED.server_id,
        channel_id = EXCLUDED.channel_id,
        conversation_id = EXCLUDED.conversation_id,
        last_active_at = EXCLUDED.last_active_at;

    -- Device ids are per tab; rows of closed tabs are pruned on the owner's next write.
    DELETE FROM public.device_view_contexts
     WHERE user_id = v_profile_id
       AND last_active_at < now() - interval '1 day';
END;
$$;

COMMENT ON FUNCTION public.sync_view_context_from_presence(text, uuid, uuid, uuid, text) IS
    'Records the calling device''s view. view_type ''away'' marks a hidden or idle device.';

REVOKE ALL ON FUNCTION public.sync_view_context_from_presence(text, uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sync_view_context_from_presence(text, uuid, uuid, uuid, text) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.is_user_viewing_context(
    p_user_id uuid,
    p_server_id uuid DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
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
           AND (
               (p_server_id IS NOT NULL AND p_channel_id IS NOT NULL
                AND d.view_type = 'server_channel'
                AND d.server_id = p_server_id AND d.channel_id = p_channel_id)
            OR (p_conversation_id IS NOT NULL
                AND d.view_type = 'dm'
                AND d.conversation_id = p_conversation_id)
           )
    );
$$;

REVOKE ALL ON FUNCTION public.is_user_viewing_context(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_user_viewing_context(uuid, uuid, uuid, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.has_active_session(p_user_id uuid) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.device_view_contexts d
         WHERE d.user_id = p_user_id
           AND d.view_type <> 'away'
           AND d.last_active_at > now() - interval '150 seconds'
    );
$$;

REVOKE ALL ON FUNCTION public.has_active_session(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.has_active_session(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.is_user_viewing_push_context(
    p_user_id uuid,
    p_server_id uuid DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    SELECT public.is_user_viewing_context(p_user_id, p_server_id, p_channel_id, p_conversation_id);
$$;

REVOKE ALL ON FUNCTION public.is_user_viewing_push_context(uuid, uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_user_viewing_push_context(uuid, uuid, uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- Push pipeline
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_has_key boolean;
    v_removed integer;
BEGIN
    SELECT EXISTS (
        SELECT 1
          FROM pg_index i
         WHERE i.indrelid = 'public.push_subscriptions'::regclass
           AND i.indisunique
           AND i.indnkeyatts = 2
           AND (SELECT array_agg(a.attname::text ORDER BY a.attname)
                  FROM pg_attribute a
                 WHERE a.attrelid = i.indrelid
                   AND a.attnum = ANY (i.indkey)) = ARRAY['endpoint', 'user_id']
    ) INTO v_has_key;

    IF v_has_key THEN
        RAISE NOTICE 'push_subscriptions: unique (user_id, endpoint) present, skipped';
    ELSE
        DELETE FROM public.push_subscriptions a
         USING public.push_subscriptions b
         WHERE a.user_id = b.user_id
           AND a.endpoint = b.endpoint
           AND (a.updated_at, a.id) < (b.updated_at, b.id);
        GET DIAGNOSTICS v_removed = ROW_COUNT;
        ALTER TABLE public.push_subscriptions
            ADD CONSTRAINT push_subscriptions_user_endpoint_unique UNIQUE (user_id, endpoint);
        RAISE NOTICE 'push_subscriptions: added unique (user_id, endpoint), % duplicate row(s) removed', v_removed;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_user_push_subscriptions(p_user_id uuid)
RETURNS TABLE(subscription_id uuid, endpoint text, p256dh text, auth text, push_enabled boolean, push_offline_only boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    RETURN QUERY
    SELECT ps.id,
           ps.endpoint,
           ps.p256dh,
           ps.auth,
           COALESCE(np.push_notifications, true),
           COALESCE(np.push_offline_only, true)
      FROM public.push_subscriptions ps
      LEFT JOIN public.notification_preferences np ON np.user_id = ps.user_id
     WHERE ps.user_id = p_user_id
       AND COALESCE(ps.failure_count, 0) < 5;
END;
$$;

REVOKE ALL ON FUNCTION public.get_user_push_subscriptions(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_user_push_subscriptions(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.record_push_failure(p_subscription_id uuid, p_reason text DEFAULT NULL)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    UPDATE public.push_subscriptions
       SET failure_count = COALESCE(failure_count, 0) + 1,
           last_failure_at = now(),
           last_failure_reason = p_reason
     WHERE id = p_subscription_id;
$$;

REVOKE ALL ON FUNCTION public.record_push_failure(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_push_failure(uuid, text) TO service_role;

CREATE OR REPLACE FUNCTION public.record_push_success(p_subscription_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    UPDATE public.push_subscriptions
       SET last_successful_push = now(),
           failure_count = 0,
           last_failure_at = NULL,
           last_failure_reason = NULL
     WHERE id = p_subscription_id;
$$;

REVOKE ALL ON FUNCTION public.record_push_success(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_push_success(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.delete_push_subscription_by_endpoint(p_endpoint text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    DELETE FROM public.push_subscriptions WHERE endpoint = p_endpoint;
$$;

REVOKE ALL ON FUNCTION public.delete_push_subscription_by_endpoint(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_push_subscription_by_endpoint(text) TO service_role;

REVOKE ALL ON FUNCTION public.cleanup_stale_push_subscriptions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_stale_push_subscriptions() TO service_role;

CREATE OR REPLACE FUNCTION public.trigger_queue_push_notification() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.is_read = false THEN
        PERFORM public.queue_federation_job(
            'send-push-notification',
            jsonb_build_object(
                'notification_id', NEW.id,
                'user_id', NEW.user_id,
                'type', NEW.type,
                'data', COALESCE(NEW.data, '{}'::jsonb)
            ),
            5,
            3,
            300
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_send_push_notification ON public.notifications;
CREATE TRIGGER trigger_send_push_notification
    AFTER INSERT ON public.notifications
    FOR EACH ROW EXECUTE FUNCTION public.trigger_queue_push_notification();

-- ---------------------------------------------------------------------------
-- Broadcasts
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.broadcast_notification_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type', 'notification:new',
        'notification', jsonb_build_object(
          'id', NEW.id,
          'type', NEW.type,
          'data', NEW.data,
          'is_read', NEW.is_read,
          'is_clicked', NEW.is_clicked,
          'created_at', NEW.created_at,
          'updated_at', NEW.updated_at,
          'user_id', NEW.user_id,
          'expires_at', NEW.expires_at
        )
      ),
      'user_event',
      'user:' || NEW.user_id::text,
      true
    );
  ELSIF TG_OP = 'UPDATE' THEN
    -- mark_all_notifications_read sends one notification:bulk_read instead.
    IF OLD.is_read IS DISTINCT FROM NEW.is_read
       AND COALESCE(current_setting('harmony.notification_bulk_read', true), '') <> 'on' THEN
      PERFORM realtime.send(
        jsonb_build_object(
          'type', 'notification:update',
          'id', NEW.id,
          'is_read', NEW.is_read
        ),
        'user_event',
        'user:' || NEW.user_id::text,
        true
      );
    END IF;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_all_notifications_read(p_user_id uuid) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_count integer;
    v_profile_id uuid;
BEGIN
    v_profile_id := public.get_current_profile_id();
    IF v_profile_id IS NULL OR v_profile_id != p_user_id THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    PERFORM set_config('harmony.notification_bulk_read', 'on', true);

    UPDATE public.notifications
       SET is_read = true, read_at = now(), updated_at = now()
     WHERE user_id = p_user_id AND is_read = false;

    GET DIAGNOSTICS v_count = ROW_COUNT;

    PERFORM set_config('harmony.notification_bulk_read', 'off', true);

    IF v_count > 0 THEN
        BEGIN
            PERFORM realtime.send(
                jsonb_build_object('type', 'notification:bulk_read', 'count', v_count),
                'user_event',
                'user:' || p_user_id::text,
                true
            );
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.broadcast_notification_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT d.user_id, array_agg(d.id) AS ids, count(*) AS n
          FROM deleted_notifications d
         GROUP BY d.user_id
    LOOP
        BEGIN
            PERFORM realtime.send(
                jsonb_build_object(
                    'type', 'notification:deleted',
                    'ids', CASE WHEN r.n <= 500 THEN to_jsonb(r.ids) ELSE 'null'::jsonb END
                ),
                'user_event',
                'user:' || r.user_id::text,
                true
            );
        EXCEPTION WHEN OTHERS THEN
            NULL;
        END;
    END LOOP;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.broadcast_notification_delete() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_broadcast_notification_delete ON public.notifications;
CREATE TRIGGER trg_broadcast_notification_delete
    AFTER DELETE ON public.notifications
    REFERENCING OLD TABLE AS deleted_notifications
    FOR EACH STATEMENT EXECUTE FUNCTION public.broadcast_notification_delete();

-- ---------------------------------------------------------------------------
-- send_notification: 20261001200002 without the quiet-hours drop
-- ---------------------------------------------------------------------------

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
    v_is_content_feedback_type boolean;
BEGIN
    IF p_notification_type IS NULL OR array_length(to_user_ids, 1) IS NULL THEN
        RETURN '{}';
    END IF;

    is_activitypub_type := p_notification_type LIKE 'activitypub_%';
    v_is_mention_type := p_notification_type IN ('mention', 'activitypub_mention');
    -- Reactions / favorites / reblogs are about the recipient's own message or post;
    -- allow them when a channel is set to "mentions only" (general chat noise stays off).
    v_is_content_feedback_type := p_notification_type IN (
        'reaction', 'activitypub_reaction', 'activitypub_favorite', 'activitypub_reblog'
    );

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

        -- Server-scoped notifications require current membership: users who left
        -- (or are pending/banned) get nothing for reactions/replies/mentions there
        IF p_server_id IS NOT NULL THEN
            IF NOT EXISTS (
                SELECT 1 FROM user_servers us
                WHERE us.server_id = p_server_id
                AND us.user_id = recipient_id
                AND COALESCE(us.status, 'accepted') = 'accepted'
            ) THEN
                CONTINUE;
            END IF;
        END IF;

        -- Channel-scoped notifications carry channel content: VIEW_CHANNEL.
        IF p_channel_id IS NOT NULL AND NOT public.can_view_channel(recipient_id, p_channel_id) THEN
            CONTINUE;
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

            -- Notification level enforcement (only for channels, not conversations).
            -- Fallback is 'mentions' (was 'all') so new channels notify only on
            -- @mentions by default. See 20260520_default_notification_level_mentions.sql.
            IF p_channel_id IS NOT NULL AND v_notification_level IS NULL THEN
                SELECT ss.default_message_notifications INTO v_server_default
                FROM server_settings ss
                WHERE ss.server_id = p_server_id;
                v_notification_level := COALESCE(v_server_default, 'mentions');
            END IF;

            IF v_notification_level = 'none' THEN
                CONTINUE;
            ELSIF v_notification_level = 'mentions' THEN
                IF NOT v_is_mention_type AND NOT v_is_content_feedback_type THEN
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
$function$;

COMMIT;

NOTIFY pgrst, 'reload schema';
