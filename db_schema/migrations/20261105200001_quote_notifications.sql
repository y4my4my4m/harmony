-- Quote notifications.
--
-- A post quoting a local user's post, written here (activityPubService.createQuoteReblog) or
-- received from another instance (ActivityProcessor: a Create whose Note carries FEP-044f
-- `quote`, Mastodon 4.5+), is a posts row with metadata.is_quote and metadata.reblog_of naming
-- the quoted post. No trigger notified anyone of it: the quoted author learned of a quote only
-- by finding it.
--
-- handle_post_quote_notifications writes an activitypub_quote notification to the quoted
-- author through send_notification_to_user, so blocks, mutes that hide notifications and the
-- preferences below apply as to every other type. data.post_id is the quoting post: the bell,
-- the toast, the system notification and the push open it. Not notified: a quote of one's own
-- post, a quote that replies to the post it quotes (the reply notification covers it), a quote
-- that mentions the quoted author (the mention covers it), a direct quote, and a followers-only
-- quote the quoted author does not follow.
--
-- notification_preferences gains activitypub_quotes (in the bell), activitypub_desktop_quotes
-- (system notification and push) and activitypub_sound_quotes, true by default as for replies.
-- send_notification is redefined from 20261011200001 with the activitypub_quote gate.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.notification_preferences
    ADD COLUMN IF NOT EXISTS activitypub_quotes boolean DEFAULT true,
    ADD COLUMN IF NOT EXISTS activitypub_desktop_quotes boolean DEFAULT true,
    ADD COLUMN IF NOT EXISTS activitypub_sound_quotes boolean DEFAULT true;

-- ---------------------------------------------------------------------------
-- send_notification: 20261011200001 plus the activitypub_quote gate
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
BEGIN
    IF p_notification_type IS NULL OR array_length(to_user_ids, 1) IS NULL THEN
        RETURN '{}';
    END IF;

    IF v_server_id IS NULL AND p_channel_id IS NOT NULL THEN
        SELECT c.server_id INTO v_server_id FROM channels c WHERE c.id = p_channel_id;
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

-- ---------------------------------------------------------------------------
-- Quote of a local user's post
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_post_quote_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_quoted_id uuid;
    v_quoted record;
    v_quoter record;
    v_preview text;
BEGIN
    IF COALESCE(NEW.metadata->>'is_quote', '') <> 'true' OR COALESCE(NEW.is_deleted, false)
       OR NEW.visibility = 'direct' THEN
        RETURN NEW;
    END IF;

    IF COALESCE(NEW.metadata->>'reblog_of', '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN NEW;
    END IF;
    -- An UPDATE notifies only when it links the quote: a quote stored before its quoted post
    -- resolved, or first stored without reblog_of.
    IF TG_OP = 'UPDATE' AND COALESCE(OLD.metadata->>'is_quote', '') = 'true'
       AND (OLD.metadata->>'reblog_of') IS NOT DISTINCT FROM (NEW.metadata->>'reblog_of') THEN
        RETURN NEW;
    END IF;
    v_quoted_id := (NEW.metadata->>'reblog_of')::uuid;

    SELECT p.id, p.author_id, p.content
      INTO v_quoted
      FROM posts p
      JOIN profiles pr ON pr.id = p.author_id
     WHERE p.id = v_quoted_id
       AND pr.is_local = true
       AND NOT COALESCE(p.is_deleted, false);

    IF NOT FOUND OR v_quoted.author_id = NEW.author_id OR NEW.in_reply_to = v_quoted.id THEN
        RETURN NEW;
    END IF;

    IF NEW.visibility = 'followers' AND NOT EXISTS (
        SELECT 1 FROM follows f
         WHERE f.follower_id = v_quoted.author_id
           AND f.following_id = NEW.author_id
           AND f.status = 'accepted'
    ) THEN
        RETURN NEW;
    END IF;

    -- trigger_handle_post_mention_notifications runs first (triggers fire by name).
    IF EXISTS (
        SELECT 1 FROM notifications n
         WHERE n.user_id = v_quoted.author_id
           AND n.type IN ('activitypub_mention', 'mention')
           AND n.data->>'post_id' = NEW.id::text
    ) THEN
        RETURN NEW;
    END IF;

    SELECT id, username, display_name, avatar_url, domain, is_local
      INTO v_quoter
      FROM profiles
     WHERE id = NEW.author_id;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    v_preview := COALESCE(extract_message_text(NEW.content), '');
    IF LENGTH(v_preview) > 100 THEN
        v_preview := LEFT(v_preview, 100) || '...';
    END IF;

    PERFORM send_notification_to_user(
        'activitypub_quote',
        v_quoted.author_id,
        jsonb_build_object(
            'sender', notification_actor_json(
                v_quoter.id,
                v_quoter.username,
                v_quoter.display_name,
                v_quoter.avatar_url,
                v_quoter.domain,
                v_quoter.is_local
            ),
            'post', jsonb_build_object(
                'id', NEW.id,
                'ap_id', NEW.ap_id,
                'content_preview', v_preview
            ),
            'quoted_post', jsonb_build_object(
                'id', v_quoted.id,
                'content_preview', LEFT(COALESCE(extract_message_text(v_quoted.content), ''), 100)
            ),
            'post_id', NEW.id,
            'quoted_post_id', v_quoted.id,
            'timestamp', NEW.created_at
        ),
        NULL, NULL, NULL,
        NEW.author_id,
        'normal'
    );

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_post_quote_notifications() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trigger_handle_post_quote_notifications ON public.posts;
CREATE TRIGGER trigger_handle_post_quote_notifications
    AFTER INSERT OR UPDATE OF metadata ON public.posts
    FOR EACH ROW
    WHEN ((NEW.metadata ->> 'is_quote') = 'true')
    EXECUTE FUNCTION public.handle_post_quote_notifications();

COMMIT;
