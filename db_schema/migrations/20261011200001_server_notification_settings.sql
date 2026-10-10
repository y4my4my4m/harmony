-- Notification settings per server, category and channel, as Discord's.
--
-- Before this migration:
--   notification_channels.notification_level filtered the notifications other triggers create,
--   and only mentions, reactions and thread replies create any for a channel. "All messages"
--   notified nothing that "Mentions only" did not.
--   Thread replies to thread members were dropped at the default level 'mentions'. Discord
--   notifies joined threads whatever the parent channel's level.
--   send_notification did not read user_servers.muted: reactions, thread replies and newcomer
--   alerts of a muted server still notified.
--   get_user_notifications hid every notification of a muted channel, the mentions
--   send_notification admits included.
--   notification_level defaulted to 'mentions', so a row written to mute a channel fixed its
--   level.
--
-- Resolution, notification_policy():
--   level   channel override > category override > the member's server setting
--           (notification_servers) > the server's default
--           (server_settings.default_message_notifications) > 'mentions'
--   muted   an active mute of the channel, its category or the server (user_servers)
-- A NULL level inherits. send_notification applies the policy to every server-scoped
-- notification:
--   muted               mentions only
--   'none'              nothing from a channel
--   'mentions'          mentions, reactions, thread replies
--   'all'               everything, channel_message included
--   suppress_everyone   no @everyone mentions; suppress_roles: no other role mentions
--   push_notifications  false: the server's notifications queue no push job
--
-- channel_message: one notification per channel message, thread replies excluded, for members
-- at level 'all' whom no mention of the message reached. Candidates are read from partial
-- indexes on 'all' rows; a server whose default is 'all' fans out to every member.
-- handle_role_mention_notifications notifies a member once per message: @everyone first, then
-- holders of the mentioned roles it did not reach.
--
-- A category mute freezes unread counts as a channel mute does (20261005700001):
-- sync_unread_mute reads both, a category row resyncs the channels of the category, and a
-- channel that changes category resyncs its frozen and category-muted members. Lapsed category
-- mutes settle on the next message, as lapsed channel mutes do. get_unread_counts and the
-- unread:change payload report either as muted.
--
-- notification_level defaults to NULL. Channel rows whose level equals the level they inherit
-- become NULL once, while the old default is in place; no row's effective level changes.
--
-- RPCs for the caller's settings in a server they are an accepted member of:
-- get_server_notification_settings, update_server_notification_settings,
-- update_channel_notification_override, update_category_notification_override. Updates send
-- notification_settings:changed to the caller's devices.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- notification_channels: category rows, inheriting level
-- ---------------------------------------------------------------------------

ALTER TABLE public.notification_channels
    ADD COLUMN IF NOT EXISTS category_id uuid REFERENCES public.channel_categories(id) ON DELETE CASCADE;

DO $$
BEGIN
    IF (SELECT column_default FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'notification_channels'
           AND column_name = 'notification_level') IS NOT NULL THEN
        UPDATE public.notification_channels nc
           SET notification_level = NULL
          FROM public.channels c
          LEFT JOIN public.server_settings ss ON ss.server_id = c.server_id
         WHERE nc.channel_id = c.id
           AND nc.notification_level = COALESCE(ss.default_message_notifications, 'mentions');
        ALTER TABLE public.notification_channels ALTER COLUMN notification_level DROP DEFAULT;
    END IF;

    UPDATE public.notification_channels
       SET notification_level = NULL
     WHERE notification_level NOT IN ('all', 'mentions', 'none');

    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.notification_channels'::regclass
                      AND conname = 'notification_channels_level_check') THEN
        ALTER TABLE public.notification_channels ADD CONSTRAINT notification_channels_level_check
            CHECK (notification_level IN ('all', 'mentions', 'none'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.notification_channels'::regclass
                      AND conname = 'notification_channels_category_only') THEN
        ALTER TABLE public.notification_channels ADD CONSTRAINT notification_channels_category_only
            CHECK (category_id IS NULL OR (channel_id IS NULL AND conversation_id IS NULL));
    END IF;
END;
$$;

COMMENT ON COLUMN public.notification_channels.notification_level IS
    'all, mentions or none; NULL inherits (category, then server). Unused for conversations.';
COMMENT ON COLUMN public.notification_channels.category_id IS
    'Set on a category override; channel_id and conversation_id are then NULL.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_channels_user_category
    ON public.notification_channels (user_id, category_id) WHERE category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notification_channels_category
    ON public.notification_channels (category_id) WHERE category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notification_channels_category_mute_end
    ON public.notification_channels (category_id) WHERE muted = true AND muted_until IS NOT NULL;
-- channel_message candidates.
CREATE INDEX IF NOT EXISTS idx_notification_channels_channel_all
    ON public.notification_channels (channel_id) WHERE notification_level = 'all';
CREATE INDEX IF NOT EXISTS idx_notification_channels_category_all
    ON public.notification_channels (category_id) WHERE notification_level = 'all';

-- ---------------------------------------------------------------------------
-- notification_servers
-- ---------------------------------------------------------------------------

-- Not on user_servers: co-members read those rows.
CREATE TABLE IF NOT EXISTS public.notification_servers (
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    notification_level text CHECK (notification_level IN ('all', 'mentions', 'none')),
    suppress_everyone boolean DEFAULT false NOT NULL,
    suppress_roles boolean DEFAULT false NOT NULL,
    push_notifications boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    PRIMARY KEY (user_id, server_id)
);

COMMENT ON TABLE public.notification_servers IS
    'A member''s notification settings for a server. notification_level NULL follows server_settings.default_message_notifications. Server mute stays in user_servers.';

CREATE INDEX IF NOT EXISTS idx_notification_servers_server
    ON public.notification_servers (server_id);
CREATE INDEX IF NOT EXISTS idx_notification_servers_all
    ON public.notification_servers (server_id) WHERE notification_level = 'all';

ALTER TABLE public.notification_servers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.notification_servers FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.notification_servers TO authenticated;
GRANT ALL ON TABLE public.notification_servers TO service_role;

DROP POLICY IF EXISTS "notification_servers_select_own" ON public.notification_servers;
CREATE POLICY "notification_servers_select_own" ON public.notification_servers
    FOR SELECT TO authenticated
    USING (user_id = (SELECT public.get_current_profile_id()));

DROP POLICY IF EXISTS "notification_servers_service_role" ON public.notification_servers;
CREATE POLICY "notification_servers_service_role" ON public.notification_servers
    AS PERMISSIVE FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- Leaving a server clears its settings.
CREATE OR REPLACE FUNCTION public.clear_notification_servers_on_leave()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    DELETE FROM public.notification_servers ns
     WHERE ns.user_id = OLD.user_id AND ns.server_id = OLD.server_id;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.clear_notification_servers_on_leave() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS z_user_servers_clear_notification_settings ON public.user_servers;
CREATE TRIGGER z_user_servers_clear_notification_settings
    AFTER DELETE ON public.user_servers
    FOR EACH ROW
    EXECUTE FUNCTION public.clear_notification_servers_on_leave();

-- ---------------------------------------------------------------------------
-- Resolution
-- ---------------------------------------------------------------------------

-- No row when p_user_id is not an accepted member of p_server_id. A NULL user_servers.status
-- counts as accepted, as send_notification has read it.
CREATE OR REPLACE FUNCTION public.notification_policy(p_user_id uuid, p_server_id uuid, p_channel_id uuid DEFAULT NULL)
RETURNS TABLE(level text, muted boolean, suppress_everyone boolean, suppress_roles boolean,
              push_notifications boolean)
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(ch.notification_level, ca.notification_level, ns.notification_level,
                    ss.default_message_notifications, 'mentions')::text,
           (us.muted IS TRUE AND (us.muted_until IS NULL OR us.muted_until > now()))
           OR (ch.muted IS TRUE AND (ch.muted_until IS NULL OR ch.muted_until > now()))
           OR (ca.muted IS TRUE AND (ca.muted_until IS NULL OR ca.muted_until > now())),
           COALESCE(ns.suppress_everyone, false),
           COALESCE(ns.suppress_roles, false),
           COALESCE(ns.push_notifications, true)
      FROM public.user_servers us
      LEFT JOIN public.notification_servers ns
        ON ns.user_id = us.user_id AND ns.server_id = us.server_id
      LEFT JOIN public.server_settings ss ON ss.server_id = us.server_id
      LEFT JOIN public.channels c ON c.id = p_channel_id AND c.server_id = us.server_id
      LEFT JOIN public.notification_channels ch
        ON ch.user_id = us.user_id AND ch.channel_id = c.id AND ch.conversation_id IS NULL
      LEFT JOIN public.notification_channels ca
        ON ca.user_id = us.user_id AND ca.category_id = c.category
     WHERE us.user_id = p_user_id
       AND us.server_id = p_server_id
       AND COALESCE(us.status, 'accepted') = 'accepted';
$$;

COMMENT ON FUNCTION public.notification_policy(uuid, uuid, uuid) IS
    'Effective notification settings of a member for a server or one of its channels. level: channel > category > member''s server setting > server default > mentions. muted: channel, category or server mute.';

-- An active mute of the channel or of its category. Server mutes do not freeze unread counts.
CREATE OR REPLACE FUNCTION public.channel_mute_active(p_user_id uuid, p_channel_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.notification_channels nc
         WHERE nc.user_id = p_user_id AND nc.channel_id = p_channel_id
           AND nc.muted = true AND (nc.muted_until IS NULL OR nc.muted_until > now()))
        OR EXISTS (
        SELECT 1 FROM public.channels c
          JOIN public.notification_channels nc ON nc.category_id = c.category AND nc.user_id = p_user_id
         WHERE c.id = p_channel_id
           AND nc.muted = true AND (nc.muted_until IS NULL OR nc.muted_until > now()));
$$;

-- ---------------------------------------------------------------------------
-- send_notification: 20261003200001 with notification_policy()
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
-- Role mentions: 20261003400001, one notification per member
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_role_mention_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_server_id uuid;
    v_channel_name text;
    v_server_name text;
    v_sender_profile profiles%ROWTYPE;
    v_sender_json jsonb;
    v_can_mention_all boolean;
    v_everyone boolean;
    v_roles uuid[];
    v_data jsonb;
    content_preview text;
BEGIN
    IF NEW.channel_id IS NULL OR NEW.is_system THEN
        RETURN NEW;
    END IF;

    SELECT c.server_id, c.name INTO v_server_id, v_channel_name
    FROM channels c WHERE c.id = NEW.channel_id;
    IF v_server_id IS NULL THEN RETURN NEW; END IF;

    IF jsonb_typeof(NEW.content) != 'array' THEN RETURN NEW; END IF;

    IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.content) elem
        WHERE elem->>'type' = 'role_mention'
    ) THEN
        RETURN NEW;
    END IF;

    IF NEW.bot_id IS NOT NULL THEN
        v_can_mention_all := check_bot_permission(NEW.bot_id, v_server_id, 'mention_everyone');
    ELSIF NEW.user_id IS NOT NULL THEN
        v_can_mention_all := has_permission(NEW.user_id, v_server_id, 'MENTION_EVERYONE', NEW.channel_id);
    ELSE
        RETURN NEW;
    END IF;

    -- @everyone (the is_default role) needs MENTION_EVERYONE; another role needs to be
    -- mentionable or MENTION_EVERYONE.
    SELECT bool_or(r.is_default), array_agg(r.id) FILTER (WHERE NOT r.is_default)
      INTO v_everyone, v_roles
      FROM server_roles r
     WHERE r.server_id = v_server_id
       AND r.id IN (SELECT (elem->>'roleId')::uuid
                      FROM jsonb_array_elements(NEW.content) elem
                     WHERE elem->>'type' = 'role_mention'
                       AND elem->>'roleId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
       AND CASE WHEN r.is_default THEN v_can_mention_all
                ELSE COALESCE(r.mentionable, true) OR v_can_mention_all END;

    v_everyone := COALESCE(v_everyone, false);
    IF NOT v_everyone AND v_roles IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT s.name INTO v_server_name FROM servers s WHERE s.id = v_server_id;

    SELECT * INTO v_sender_profile FROM profiles WHERE id = NEW.user_id;

    v_sender_json := message_notification_sender_json(
        NEW.user_id, NEW.bot_id, NEW.metadata, v_sender_profile
    );

    content_preview := LEFT(
        (SELECT string_agg(elem->>'text', ' ')
         FROM jsonb_array_elements(NEW.content) elem
         WHERE elem->>'type' = 'text'), 100);

    v_data := jsonb_build_object(
        'sender', v_sender_json,
        'message', jsonb_build_object('id', NEW.id, 'content_preview', content_preview),
        'location', jsonb_build_object(
            'server_id', v_server_id::text,
            'server_name', v_server_name,
            'channel_id', NEW.channel_id::text,
            'channel_name', v_channel_name
        ),
        'message_id', NEW.id,
        'mentioned_by', NEW.user_id,
        'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
        'sender_display_name', COALESCE(
            v_sender_json->>'display_name',
            v_sender_profile.display_name
        ),
        'server_id', v_server_id::text,
        'server_name', v_server_name,
        'channel_id', NEW.channel_id::text,
        'channel_name', v_channel_name,
        'preview', content_preview,
        'is_role_mention', true
    );

    -- Suppressing members are left out here; send_notification applies the same flags.
    IF v_everyone THEN
        PERFORM send_notification(
            'mention',
            ARRAY(SELECT us.user_id FROM user_servers us
                    LEFT JOIN notification_servers ns
                      ON ns.user_id = us.user_id AND ns.server_id = us.server_id
                   WHERE us.server_id = v_server_id
                     AND us.status = 'accepted'
                     AND us.user_id IS DISTINCT FROM NEW.user_id
                     AND NOT COALESCE(ns.suppress_everyone, false)),
            v_data || jsonb_build_object('is_everyone', true),
            v_server_id, NEW.channel_id, NULL, NEW.user_id, 'normal'
        );
    END IF;

    -- Holders @everyone reached are left out.
    IF v_roles IS NOT NULL THEN
        PERFORM send_notification(
            'mention',
            ARRAY(SELECT DISTINCT ur.user_id FROM user_roles ur
                    LEFT JOIN notification_servers ns
                      ON ns.user_id = ur.user_id AND ns.server_id = ur.server_id
                   WHERE ur.server_id = v_server_id
                     AND ur.role_id = ANY (v_roles)
                     AND ur.user_id IS DISTINCT FROM NEW.user_id
                     AND NOT COALESCE(ns.suppress_roles, false)
                     AND (NOT v_everyone OR COALESCE(ns.suppress_everyone, false))),
            v_data,
            v_server_id, NEW.channel_id, NULL, NEW.user_id, 'normal'
        );
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_role_mention_notifications() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- channel_message
-- ---------------------------------------------------------------------------

-- Runs after the mention triggers (AFTER triggers fire in name order). A member a mention of
-- this message reached was notified by it, in this transaction: created_at = now().
CREATE OR REPLACE FUNCTION public.handle_channel_message_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server uuid;
    v_category uuid;
    v_channel_name text;
    v_server_name text;
    v_default text;
    v_candidates uuid[];
    v_sender_profile profiles%ROWTYPE;
    v_sender_json jsonb;
    v_preview text;
BEGIN
    SELECT c.server_id, c.category, c.name INTO v_server, v_category, v_channel_name
      FROM channels c WHERE c.id = NEW.channel_id;
    IF v_server IS NULL THEN
        RETURN NULL;
    END IF;

    SELECT ss.default_message_notifications INTO v_default
      FROM server_settings ss WHERE ss.server_id = v_server;

    v_candidates := ARRAY(
        SELECT nc.user_id FROM notification_channels nc
         WHERE nc.channel_id = NEW.channel_id AND nc.notification_level = 'all'
        UNION
        SELECT nc.user_id FROM notification_channels nc
         WHERE nc.category_id = v_category AND nc.notification_level = 'all'
        UNION
        SELECT ns.user_id FROM notification_servers ns
         WHERE ns.server_id = v_server AND ns.notification_level = 'all'
        UNION
        SELECT us.user_id FROM user_servers us
         WHERE v_default = 'all' AND us.server_id = v_server AND us.status = 'accepted'
        EXCEPT
        SELECT n.user_id FROM notifications n
         WHERE n.created_at = now() AND n.type = 'mention'
           AND n.data->>'message_id' = NEW.id::text
    );
    IF NEW.user_id IS NOT NULL THEN
        v_candidates := array_remove(v_candidates, NEW.user_id);
    END IF;
    IF cardinality(v_candidates) = 0 THEN
        RETURN NULL;
    END IF;

    SELECT s.name INTO v_server_name FROM servers s WHERE s.id = v_server;
    SELECT * INTO v_sender_profile FROM profiles WHERE id = NEW.user_id;
    v_sender_json := message_notification_sender_json(NEW.user_id, NEW.bot_id, NEW.metadata, v_sender_profile);

    v_preview := TRIM(extract_message_text(NEW.content));
    IF LENGTH(v_preview) > 100 THEN
        v_preview := LEFT(v_preview, 100) || '...';
    END IF;
    IF v_preview = '' OR v_preview IS NULL THEN
        v_preview := 'New message';
    END IF;

    PERFORM send_notification(
        'channel_message',
        v_candidates,
        jsonb_build_object(
            'sender', v_sender_json,
            'message', jsonb_build_object('id', NEW.id, 'content_preview', v_preview),
            'location', jsonb_build_object(
                'server_id', v_server::text,
                'server_name', v_server_name,
                'channel_id', NEW.channel_id::text,
                'channel_name', v_channel_name
            ),
            'message_id', NEW.id,
            'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
            'sender_display_name', COALESCE(v_sender_json->>'display_name', v_sender_profile.display_name),
            'server_name', v_server_name,
            'channel_name', v_channel_name,
            'preview', v_preview
        ),
        v_server, NEW.channel_id, NULL, NEW.user_id, 'normal'
    );
    RETURN NULL;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'channel message notifications for % failed: % (%)', NEW.id, SQLERRM, SQLSTATE;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_channel_message_notifications() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS z_messages_channel_message_notifications ON public.messages;
CREATE TRIGGER z_messages_channel_message_notifications
    AFTER INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.channel_id IS NOT NULL AND NEW.thread_id IS NULL
          AND NEW.is_deleted = false AND NEW.is_system = false)
    EXECUTE FUNCTION public.handle_channel_message_notifications();

-- ---------------------------------------------------------------------------
-- Push: 20261003200001 with the member's push setting for the server
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trigger_queue_push_notification() RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_server text;
BEGIN
    IF TG_OP = 'INSERT' AND NEW.is_read = false THEN
        v_server := COALESCE(NULLIF(NEW.data->>'server_id', ''), NULLIF(NEW.data->'location'->>'server_id', ''));
        IF v_server ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           AND EXISTS (SELECT 1 FROM public.notification_servers ns
                        WHERE ns.user_id = NEW.user_id AND ns.server_id = v_server::uuid
                          AND NOT ns.push_notifications) THEN
            RETURN NEW;
        END IF;

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

-- ---------------------------------------------------------------------------
-- get_user_notifications: 20261009100001; a mute hides non-mention notifications only
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_user_notifications(p_user_id uuid, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0, p_unread_only boolean DEFAULT false, p_notification_types character varying[] DEFAULT NULL::character varying[]) RETURNS TABLE(id uuid, user_id uuid, type character varying, data jsonb, is_read boolean, is_clicked boolean, created_at timestamp with time zone, updated_at timestamp with time zone, expires_at timestamp with time zone, read_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY INVOKER
    SET search_path = public, extensions, pg_temp
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
            NULLIF((n.data->'sender'->>'id'), '')::uuid,
            NULLIF((n.data->'sender'->>'user_id'), '')::uuid,
            NULLIF((n.data->>'follower_id'), '')::uuid,
            NULLIF((n.data->'follower'->>'id'), '')::uuid,
            NULLIF((n.data->'actor'->>'id'), '')::uuid,
            NULLIF((n.data->'user'->>'id'), '')::uuid,
            NULLIF((n.data->'author'->>'id'), '')::uuid
        )
        AND (ub.expires_at IS NULL OR ub.expires_at > NOW())
    )

    -- Filter out notifications from muted users (hide_notifications)
    AND NOT EXISTS (
        SELECT 1
        FROM user_mutes um
        WHERE um.muter_id = p_user_id
        AND um.muted_user_id = COALESCE(
            NULLIF((n.data->>'from_user_id'), '')::uuid,
            NULLIF((n.data->'sender'->>'id'), '')::uuid,
            NULLIF((n.data->'sender'->>'user_id'), '')::uuid,
            NULLIF((n.data->>'follower_id'), '')::uuid,
            NULLIF((n.data->'follower'->>'id'), '')::uuid,
            NULLIF((n.data->'actor'->>'id'), '')::uuid,
            NULLIF((n.data->'user'->>'id'), '')::uuid,
            NULLIF((n.data->'author'->>'id'), '')::uuid
        )
        AND um.hide_notifications = true
        AND (um.expires_at IS NULL OR um.expires_at > NOW())
    )

    -- A muted channel, category or conversation hides all but mentions, as send_notification
    -- admits them.
    AND (n.type IN ('mention', 'activitypub_mention') OR NOT EXISTS (
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
            (nc.category_id IS NOT NULL AND nc.category_id = (
                SELECT c.category FROM channels c
                 WHERE c.id = COALESCE(
                     NULLIF((n.data->>'channel_id'), '')::uuid,
                     NULLIF((n.data->'location'->>'channel_id'), '')::uuid)
            ))
            OR
            (nc.conversation_id IS NOT NULL AND nc.conversation_id = COALESCE(
                NULLIF((n.data->>'conversation_id'), '')::uuid,
                NULLIF((n.data->'conversation'->>'id'), '')::uuid
            ))
        )
        AND (nc.muted_until IS NULL OR nc.muted_until > NOW())
    ))

    ORDER BY n.created_at DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

-- ---------------------------------------------------------------------------
-- Unread state under category mutes
-- ---------------------------------------------------------------------------

-- 20261005700001 with channel_mute_active() for a channel.
CREATE OR REPLACE FUNCTION public.sync_unread_mute(p_user_id uuid, p_channel_id uuid, p_conversation_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_muted  boolean;
    v_seq    bigint;
    v_server uuid;
BEGIN
    IF p_channel_id IS NOT NULL THEN
        SELECT c.server_id INTO v_server FROM public.channels c WHERE c.id = p_channel_id;
        IF NOT FOUND THEN
            RETURN;
        END IF;
        v_muted := public.channel_mute_active(p_user_id, p_channel_id);
        SELECT h.message_seq INTO v_seq
          FROM public.message_heads h WHERE h.channel_id = p_channel_id FOR SHARE;
        v_seq := COALESCE(v_seq, 0);

        IF v_muted THEN
            INSERT INTO public.unread_counts AS u (user_id, server_id, channel_id, muted_at_seq)
            VALUES (p_user_id, v_server, p_channel_id, v_seq)
            ON CONFLICT (user_id, channel_id) WHERE channel_id IS NOT NULL
            DO UPDATE SET muted_at_seq = COALESCE(u.muted_at_seq, EXCLUDED.muted_at_seq);
        ELSE
            UPDATE public.unread_counts u
               SET read_seq = CASE WHEN u.muted_at_seq - u.read_seq - u.skipped = 0 THEN v_seq ELSE u.read_seq END,
                   skipped = CASE WHEN u.muted_at_seq - u.read_seq - u.skipped = 0 THEN 0
                                  ELSE u.skipped + v_seq - u.muted_at_seq END,
                   muted_at_seq = NULL
             WHERE u.user_id = p_user_id AND u.channel_id = p_channel_id
               AND u.muted_at_seq IS NOT NULL;
        END IF;
    ELSIF p_conversation_id IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.conversations cv WHERE cv.id = p_conversation_id) THEN
            RETURN;
        END IF;
        v_muted := EXISTS (
            SELECT 1 FROM public.notification_channels nc
             WHERE nc.user_id = p_user_id AND nc.conversation_id = p_conversation_id
               AND nc.muted = true AND (nc.muted_until IS NULL OR nc.muted_until > now()));
        SELECT h.message_seq INTO v_seq
          FROM public.message_heads h WHERE h.conversation_id = p_conversation_id FOR SHARE;
        v_seq := COALESCE(v_seq, 0);

        IF v_muted THEN
            INSERT INTO public.unread_counts AS u (user_id, conversation_id, muted_at_seq)
            VALUES (p_user_id, p_conversation_id, v_seq)
            ON CONFLICT (user_id, conversation_id) WHERE conversation_id IS NOT NULL
            DO UPDATE SET muted_at_seq = COALESCE(u.muted_at_seq, EXCLUDED.muted_at_seq);
        ELSE
            UPDATE public.unread_counts u
               SET read_seq = CASE WHEN u.muted_at_seq - u.read_seq - u.skipped = 0 THEN v_seq ELSE u.read_seq END,
                   skipped = CASE WHEN u.muted_at_seq - u.read_seq - u.skipped = 0 THEN 0
                                  ELSE u.skipped + v_seq - u.muted_at_seq END,
                   muted_at_seq = NULL
             WHERE u.user_id = p_user_id AND u.conversation_id = p_conversation_id
               AND u.muted_at_seq IS NOT NULL;
        END IF;
    END IF;
END;
$$;

-- The channels of a category the member can view, and those they hold frozen.
CREATE OR REPLACE FUNCTION public.sync_unread_category_mute(p_user_id uuid, p_category_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel uuid;
BEGIN
    FOR v_channel IN
        SELECT c.id FROM public.channels c
         WHERE c.category = p_category_id
           AND (EXISTS (SELECT 1 FROM public.unread_counts u
                         WHERE u.user_id = p_user_id AND u.channel_id = c.id
                           AND u.muted_at_seq IS NOT NULL)
                OR public.can_view_channel(p_user_id, c.id))
    LOOP
        PERFORM public.sync_unread_mute(p_user_id, v_channel, NULL);
    END LOOP;
END;
$$;

-- 20261005700001 plus category rows. A category row resyncs its channels when its mute
-- changes and was or is set.
CREATE OR REPLACE FUNCTION public.track_unread_mute()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_mute_changed boolean := true;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        v_mute_changed := OLD.muted IS DISTINCT FROM NEW.muted
                       OR OLD.muted_until IS DISTINCT FROM NEW.muted_until
                       OR OLD.category_id IS DISTINCT FROM NEW.category_id
                       OR OLD.user_id IS DISTINCT FROM NEW.user_id;
    END IF;
    IF TG_OP <> 'INSERT' THEN
        IF OLD.channel_id IS NOT NULL THEN
            PERFORM public.sync_unread_mute(OLD.user_id, OLD.channel_id, NULL);
        END IF;
        IF OLD.conversation_id IS NOT NULL THEN
            PERFORM public.sync_unread_mute(OLD.user_id, NULL, OLD.conversation_id);
        END IF;
        IF OLD.category_id IS NOT NULL AND OLD.muted IS TRUE AND v_mute_changed THEN
            PERFORM public.sync_unread_category_mute(OLD.user_id, OLD.category_id);
        END IF;
    END IF;
    IF TG_OP <> 'DELETE' THEN
        IF NEW.channel_id IS NOT NULL
           AND (TG_OP = 'INSERT' OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
                OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
            PERFORM public.sync_unread_mute(NEW.user_id, NEW.channel_id, NULL);
        END IF;
        IF NEW.conversation_id IS NOT NULL
           AND (TG_OP = 'INSERT' OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
                OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
            PERFORM public.sync_unread_mute(NEW.user_id, NULL, NEW.conversation_id);
        END IF;
        IF NEW.category_id IS NOT NULL AND NEW.muted IS TRUE AND v_mute_changed THEN
            PERFORM public.sync_unread_category_mute(NEW.user_id, NEW.category_id);
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_track_unread_mute ON public.notification_channels;
CREATE TRIGGER trg_track_unread_mute
    AFTER INSERT OR UPDATE OF muted, muted_until, channel_id, conversation_id, category_id, user_id OR DELETE
    ON public.notification_channels
    FOR EACH ROW
    EXECUTE FUNCTION public.track_unread_mute();

-- A channel that changes category: members holding it frozen, and members muting the new
-- category.
CREATE OR REPLACE FUNCTION public.track_channel_category_mute()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user uuid;
BEGIN
    FOR v_user IN
        SELECT u.user_id FROM public.unread_counts u
         WHERE u.channel_id = NEW.id AND u.muted_at_seq IS NOT NULL
        UNION
        SELECT nc.user_id FROM public.notification_channels nc
         WHERE nc.category_id = NEW.category AND nc.muted = true
    LOOP
        PERFORM public.sync_unread_mute(v_user, NEW.id, NULL);
    END LOOP;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_channels_category_mute ON public.channels;
CREATE TRIGGER z_channels_category_mute
    AFTER UPDATE OF category ON public.channels
    FOR EACH ROW
    WHEN (OLD.category IS DISTINCT FROM NEW.category)
    EXECUTE FUNCTION public.track_channel_category_mute();

-- 20261005700001 with lapsed category mutes.
CREATE OR REPLACE FUNCTION public.handle_new_message_unread()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server   uuid;
    v_category uuid;
    v_created  timestamptz;
    v_prev     bigint;
    v_seq      bigint;
    v_origin   timestamptz;
BEGIN
    SELECT c.server_id, c.category, c.created_at INTO v_server, v_category, v_created
      FROM public.channels c WHERE c.id = NEW.channel_id;
    IF v_server IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT h.message_seq, h.origin_at INTO v_prev, v_origin
      FROM public.message_heads h WHERE h.channel_id = NEW.channel_id
       FOR UPDATE;
    IF FOUND THEN
        UPDATE public.message_heads
           SET message_seq = v_prev + 1, last_message_id = NEW.id, last_message_at = NEW.created_at
         WHERE channel_id = NEW.channel_id;
    ELSE
        INSERT INTO public.message_heads AS h (channel_id, message_seq, last_message_id, last_message_at, origin_at)
        VALUES (NEW.channel_id, 1, NEW.id, NEW.created_at, v_created)
        ON CONFLICT (channel_id) WHERE channel_id IS NOT NULL DO UPDATE
           SET message_seq = h.message_seq + 1,
               last_message_id = EXCLUDED.last_message_id,
               last_message_at = EXCLUDED.last_message_at
        RETURNING h.message_seq - 1, h.origin_at INTO v_prev, v_origin;
    END IF;
    v_seq := v_prev + 1;

    -- Mutes that lapsed by muted_until end at v_prev: nothing was posted since.
    UPDATE public.unread_counts u
       SET read_seq = CASE WHEN u.muted_at_seq - u.read_seq - u.skipped = 0 THEN v_prev ELSE u.read_seq END,
           skipped = CASE WHEN u.muted_at_seq - u.read_seq - u.skipped = 0 THEN 0
                          ELSE u.skipped + v_prev - u.muted_at_seq END,
           muted_at_seq = NULL
      FROM (SELECT nc.user_id FROM public.notification_channels nc
             WHERE nc.channel_id = NEW.channel_id
               AND nc.muted = true AND nc.muted_until IS NOT NULL AND nc.muted_until <= now()
            UNION
            SELECT nc.user_id FROM public.notification_channels nc
             WHERE nc.category_id = v_category
               AND nc.muted = true AND nc.muted_until IS NOT NULL AND nc.muted_until <= now()) l
     WHERE u.user_id = l.user_id AND u.channel_id = NEW.channel_id
       AND u.muted_at_seq IS NOT NULL
       AND NOT public.channel_mute_active(l.user_id, NEW.channel_id);

    IF NEW.user_id IS NOT NULL THEN
        INSERT INTO public.unread_counts AS u (user_id, server_id, channel_id, read_seq, skipped)
        VALUES (NEW.user_id, v_server, NEW.channel_id,
                CASE WHEN v_prev = 0 THEN v_seq ELSE 0 END,
                CASE WHEN v_prev = 0 THEN 0 ELSE 1 END)
        ON CONFLICT (user_id, channel_id) WHERE channel_id IS NOT NULL DO UPDATE SET
            read_seq = CASE WHEN u.muted_at_seq IS NULL AND u.read_seq + u.skipped = v_prev
                            THEN v_seq ELSE u.read_seq END,
            skipped = CASE WHEN u.muted_at_seq IS NOT NULL THEN u.skipped
                           WHEN u.read_seq + u.skipped = v_prev THEN 0
                           ELSE u.skipped + 1 END;
    END IF;

    -- Members whose count goes from 0 to 1. channel_is_restricted() runs as an InitPlan, only
    -- once a candidate exists.
    BEGIN
        IF v_prev = 0 THEN
            PERFORM realtime.send(
                public.unread_change_payload('upsert', t.id, t.user_id, v_server, NEW.channel_id, NULL,
                                             1, t.unread_mentions, t.last_read_message_id,
                                             COALESCE(t.last_read_at, GREATEST(t.member_since, v_origin))),
                'user_event', 'user:' || t.user_id::text, true)
              FROM (
                  SELECT us.user_id, us.created_at AS member_since, u.id, u.unread_mentions,
                         u.last_read_message_id, u.last_read_at
                    FROM public.user_servers us
                    LEFT JOIN public.unread_counts u
                      ON u.user_id = us.user_id AND u.channel_id = NEW.channel_id
                   WHERE us.server_id = v_server
                     AND us.status = 'accepted'
                     AND us.user_id IS DISTINCT FROM NEW.user_id
                     AND (u.id IS NULL OR (u.read_seq = 0 AND u.skipped = 0 AND u.muted_at_seq IS NULL))
              ) t
             WHERE NOT (SELECT public.channel_is_restricted(NEW.channel_id))
                OR t.user_id IN (SELECT public.channel_viewer_ids(NEW.channel_id));
        ELSE
            PERFORM realtime.send(
                public.unread_change_payload('upsert', t.id, t.user_id, v_server, NEW.channel_id, NULL,
                                             1, t.unread_mentions, t.last_read_message_id,
                                             COALESCE(t.last_read_at, GREATEST(t.member_since, v_origin))),
                'user_event', 'user:' || t.user_id::text, true)
              FROM (
                  SELECT u.user_id, us.created_at AS member_since, u.id, u.unread_mentions,
                         u.last_read_message_id, u.last_read_at
                    FROM public.unread_counts u
                   -- LIMIT keeps this a probe per candidate; a join hashes every member.
                   CROSS JOIN LATERAL (
                       SELECT m.created_at
                         FROM public.user_servers m
                        WHERE m.user_id = u.user_id AND m.server_id = v_server AND m.status = 'accepted'
                        LIMIT 1
                   ) us
                   WHERE u.channel_id = NEW.channel_id
                     AND u.read_seq = v_prev
                     AND u.skipped = 0
                     AND u.muted_at_seq IS NULL
                     AND u.user_id IS DISTINCT FROM NEW.user_id
              ) t
             WHERE NOT (SELECT public.channel_is_restricted(NEW.channel_id))
                OR public.can_view_channel(t.user_id, NEW.channel_id);
        END IF;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'handle_new_message_unread broadcast failed: %', SQLERRM;
    END;

    RETURN NEW;
END;
$$;

-- 20261011100001 with category mutes.
CREATE OR REPLACE FUNCTION public.get_unread_counts()
RETURNS TABLE(id uuid, user_id uuid, server_id uuid, channel_id uuid, conversation_id uuid,
              unread_messages integer, unread_mentions integer, last_read_message_id uuid,
              last_read_at timestamp with time zone, last_message_at timestamp with time zone,
              muted boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    WITH ch AS (
        SELECT c.id, c.server_id, c.category, us.created_at AS since
          FROM public.user_servers us
          JOIN public.channels c ON c.server_id = us.server_id
         WHERE us.user_id = v_me AND us.status = 'accepted'
           AND c.id IN (SELECT public.current_user_viewable_channel_ids())
    ),
    cv AS (
        SELECT cp.conversation_id, min(cp.joined_at) AS since
          FROM public.conversation_participants cp
         WHERE cp.user_id = v_me AND cp.left_at IS NULL
         GROUP BY cp.conversation_id
    ),
    mu AS (
        SELECT nc.channel_id AS mch, nc.conversation_id AS mcv, nc.category_id AS mca
          FROM public.notification_channels nc
         WHERE nc.user_id = v_me AND nc.muted = true
           AND (nc.muted_until IS NULL OR nc.muted_until > now())
    ),
    st AS (
        SELECT u.id AS row_id, ch.server_id AS sid, ch.id AS cid, NULL::uuid AS vid,
               COALESCE(u.muted_at_seq, h.message_seq, 0) - COALESCE(u.read_seq, 0) - COALESCE(u.skipped, 0) AS n,
               COALESCE(u.unread_mentions, 0) AS mentions, u.last_read_message_id AS lrm,
               COALESCE(u.last_read_at, GREATEST(ch.since, h.origin_at)) AS read_at, h.last_message_at AS lma,
               EXISTS (SELECT 1 FROM mu WHERE mu.mch = ch.id OR mu.mca = ch.category) AS is_muted
          FROM ch
          LEFT JOIN public.message_heads h ON h.channel_id = ch.id
          LEFT JOIN public.unread_counts u ON u.user_id = v_me AND u.channel_id = ch.id
        UNION ALL
        SELECT u.id, NULL::uuid, NULL::uuid, cv.conversation_id,
               COALESCE(u.muted_at_seq, h.message_seq, 0) - COALESCE(u.read_seq, 0) - COALESCE(u.skipped, 0),
               COALESCE(u.unread_mentions, 0), u.last_read_message_id,
               COALESCE(u.last_read_at, GREATEST(cv.since, h.origin_at)), h.last_message_at,
               EXISTS (SELECT 1 FROM mu WHERE mu.mcv = cv.conversation_id)
          FROM cv
          LEFT JOIN public.message_heads h ON h.conversation_id = cv.conversation_id
          LEFT JOIN public.unread_counts u ON u.user_id = v_me AND u.conversation_id = cv.conversation_id
    )
    SELECT st.row_id, v_me, st.sid, st.cid, st.vid,
           LEAST(GREATEST(st.n, 0), 2147483647)::integer, st.mentions, st.lrm, st.read_at, st.lma,
           st.is_muted
      FROM st
     WHERE st.n > 0 OR st.mentions > 0;
END;
$$;

COMMENT ON FUNCTION public.get_unread_counts() IS
'The caller''s channels and conversations with unread messages or mentions. muted: an active mute of the channel, its category or the conversation; unread_messages is then the count frozen when it began. Caller resolved via get_current_profile_id().';

REVOKE ALL ON FUNCTION public.get_unread_counts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_unread_counts() TO authenticated, service_role;

-- 20261011100001 with channel_mute_active() for a channel.
CREATE OR REPLACE FUNCTION public.broadcast_unread_count_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_seq    bigint;
    v_origin timestamptz;
    v_since  timestamptz;
    v_muted  boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        PERFORM realtime.send(
            public.unread_change_payload('delete', OLD.id, OLD.user_id, OLD.server_id, OLD.channel_id,
                                         OLD.conversation_id, 0, OLD.unread_mentions,
                                         OLD.last_read_message_id, OLD.last_read_at),
            'user_event', 'user:' || OLD.user_id::text, true);
        RETURN OLD;
    END IF;

    IF NEW.channel_id IS NOT NULL THEN
        SELECT h.message_seq, h.origin_at INTO v_seq, v_origin
          FROM public.message_heads h WHERE h.channel_id = NEW.channel_id;
        SELECT us.created_at INTO v_since
          FROM public.user_servers us
         WHERE us.user_id = NEW.user_id AND us.server_id = NEW.server_id;
        v_muted := public.channel_mute_active(NEW.user_id, NEW.channel_id);
    ELSE
        SELECT h.message_seq, h.origin_at INTO v_seq, v_origin
          FROM public.message_heads h WHERE h.conversation_id = NEW.conversation_id;
        SELECT min(cp.joined_at) INTO v_since
          FROM public.conversation_participants cp
         WHERE cp.user_id = NEW.user_id AND cp.conversation_id = NEW.conversation_id;
        v_muted := EXISTS (
            SELECT 1 FROM public.notification_channels nc
             WHERE nc.user_id = NEW.user_id AND nc.conversation_id = NEW.conversation_id
               AND nc.muted = true AND (nc.muted_until IS NULL OR nc.muted_until > now()));
    END IF;

    PERFORM realtime.send(
        jsonb_set(
            public.unread_change_payload('upsert', NEW.id, NEW.user_id, NEW.server_id, NEW.channel_id,
                                         NEW.conversation_id,
                                         COALESCE(NEW.muted_at_seq, v_seq, 0) - NEW.read_seq - NEW.skipped,
                                         NEW.unread_mentions, NEW.last_read_message_id,
                                         COALESCE(NEW.last_read_at, GREATEST(v_since, v_origin))),
            '{count,muted}', to_jsonb(v_muted)),
        'user_event', 'user:' || NEW.user_id::text, true);
    RETURN NEW;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'broadcast_unread_count_event failed: %', SQLERRM;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- RPCs
-- ---------------------------------------------------------------------------

-- The modal's state. Overrides list rows with a level or an active mute. channels and
-- categories are those the member can view, for the override picker.
CREATE OR REPLACE FUNCTION public.notification_settings_state(p_user_id uuid, p_server_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    WITH vis AS (
        SELECT c.id, c.name, c.type, c.category, c."order"
          FROM public.channels c
         WHERE c.server_id = p_server_id
           AND public.can_view_channel(p_user_id, c.id)
    )
    SELECT jsonb_build_object(
        'server_id', p_server_id,
        'muted', us.muted IS TRUE AND (us.muted_until IS NULL OR us.muted_until > now()),
        'muted_until', CASE WHEN us.muted IS TRUE AND us.muted_until > now() THEN us.muted_until END,
        'level', ns.notification_level,
        'server_default', COALESCE(ss.default_message_notifications, 'mentions'),
        'suppress_everyone', COALESCE(ns.suppress_everyone, false),
        'suppress_roles', COALESCE(ns.suppress_roles, false),
        'push_notifications', COALESCE(ns.push_notifications, true),
        'overrides', COALESCE((
            SELECT jsonb_agg(o.row ORDER BY o.kind, o.name)
              FROM (
                  SELECT 'channel' AS kind, v.name,
                         jsonb_build_object(
                             'channel_id', v.id, 'category_id', NULL,
                             'level', nc.notification_level,
                             'muted', nc.muted IS TRUE AND (nc.muted_until IS NULL OR nc.muted_until > now()),
                             'muted_until', CASE WHEN nc.muted IS TRUE AND nc.muted_until > now() THEN nc.muted_until END
                         ) AS row
                    FROM public.notification_channels nc
                    JOIN vis v ON v.id = nc.channel_id
                   WHERE nc.user_id = p_user_id AND nc.conversation_id IS NULL
                     AND (nc.notification_level IS NOT NULL
                          OR (nc.muted IS TRUE AND (nc.muted_until IS NULL OR nc.muted_until > now())))
                  UNION ALL
                  SELECT 'category', k.name,
                         jsonb_build_object(
                             'channel_id', NULL, 'category_id', k.id,
                             'level', nc.notification_level,
                             'muted', nc.muted IS TRUE AND (nc.muted_until IS NULL OR nc.muted_until > now()),
                             'muted_until', CASE WHEN nc.muted IS TRUE AND nc.muted_until > now() THEN nc.muted_until END
                         )
                    FROM public.notification_channels nc
                    JOIN public.channel_categories k ON k.id = nc.category_id
                   WHERE nc.user_id = p_user_id AND k.server_id = p_server_id
                     AND (nc.notification_level IS NOT NULL
                          OR (nc.muted IS TRUE AND (nc.muted_until IS NULL OR nc.muted_until > now())))
              ) o
        ), '[]'::jsonb),
        'channels', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('id', v.id, 'name', v.name, 'type', v.type,
                                                'category_id', v.category, 'position', v."order")
                             ORDER BY v."order", v.name)
              FROM vis v
        ), '[]'::jsonb),
        'categories', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('id', k.id, 'name', k.name, 'position', k."order")
                             ORDER BY k."order", k.name)
              FROM public.channel_categories k
             WHERE k.server_id = p_server_id
        ), '[]'::jsonb)
    )
      FROM public.user_servers us
      LEFT JOIN public.notification_servers ns ON ns.user_id = us.user_id AND ns.server_id = us.server_id
      LEFT JOIN public.server_settings ss ON ss.server_id = us.server_id
     WHERE us.user_id = p_user_id AND us.server_id = p_server_id;
$$;

-- Caller's profile when they are an accepted member of p_server_id; raises otherwise.
CREATE OR REPLACE FUNCTION public.notification_settings_member(p_server_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF p_server_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.user_servers us
         WHERE us.user_id = v_me AND us.server_id = p_server_id AND us.status = 'accepted'
    ) THEN
        RAISE EXCEPTION 'Not a member of this server' USING ERRCODE = '42501';
    END IF;
    RETURN v_me;
END;
$$;

CREATE OR REPLACE FUNCTION public.notification_settings_changed(p_user_id uuid, p_server_id uuid)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    PERFORM realtime.send(
        jsonb_build_object('type', 'notification_settings:changed', 'server_id', p_server_id),
        'user_event', 'user:' || p_user_id::text, true);
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'notification_settings:changed broadcast failed: %', SQLERRM;
END;
$$;

-- Validates an override or server patch value. Returns the level, NULL for inherit.
CREATE OR REPLACE FUNCTION public.notification_level_value(p_value jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_value IS NULL OR jsonb_typeof(p_value) = 'null' THEN
        RETURN NULL;
    END IF;
    IF jsonb_typeof(p_value) <> 'string' OR p_value #>> '{}' NOT IN ('all', 'mentions', 'none') THEN
        RAISE EXCEPTION 'level is all, mentions, none or null' USING ERRCODE = '22023';
    END IF;
    RETURN p_value #>> '{}';
END;
$$;

-- muted (boolean) and muted_until (timestamp or null) of a patch. muted_until without
-- muted = true, or in the past, is refused.
CREATE OR REPLACE FUNCTION public.notification_mute_value(p_changes jsonb, OUT muted boolean, OUT muted_until timestamptz)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF jsonb_typeof(p_changes->'muted') IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION 'muted is true or false' USING ERRCODE = '22023';
    END IF;
    muted := (p_changes->>'muted')::boolean;
    IF p_changes ? 'muted_until' AND jsonb_typeof(p_changes->'muted_until') <> 'null' THEN
        IF NOT muted OR jsonb_typeof(p_changes->'muted_until') <> 'string' THEN
            RAISE EXCEPTION 'muted_until is a timestamp of a mute, or null' USING ERRCODE = '22023';
        END IF;
        BEGIN
            muted_until := (p_changes->>'muted_until')::timestamptz;
        EXCEPTION WHEN OTHERS THEN
            RAISE EXCEPTION 'muted_until is a timestamp of a mute, or null' USING ERRCODE = '22023';
        END;
        IF muted_until <= now() THEN
            RAISE EXCEPTION 'muted_until is in the past' USING ERRCODE = '22023';
        END IF;
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_server_notification_settings(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.notification_settings_member(p_server_id);
BEGIN
    RETURN public.notification_settings_state(v_me, p_server_id);
END;
$$;

COMMENT ON FUNCTION public.get_server_notification_settings(uuid) IS
    'The caller''s notification settings for a server they are an accepted member of: mute, level (null follows server_default), suppress flags, push, channel and category overrides, and the channels and categories they can view.';

-- p_changes keys, each optional: muted, muted_until, level, suppress_everyone, suppress_roles,
-- push_notifications. Returns the new state.
CREATE OR REPLACE FUNCTION public.update_server_notification_settings(p_server_id uuid, p_changes jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.notification_settings_member(p_server_id);
    v_key text;
    v_muted boolean;
    v_until timestamptz;
    v_level text;
BEGIN
    IF jsonb_typeof(p_changes) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'changes is an object' USING ERRCODE = '22023';
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(p_changes) LOOP
        IF v_key NOT IN ('muted', 'muted_until', 'level', 'suppress_everyone', 'suppress_roles',
                         'push_notifications') THEN
            RAISE EXCEPTION 'unknown setting %', v_key USING ERRCODE = '22023';
        END IF;
        IF v_key IN ('suppress_everyone', 'suppress_roles', 'push_notifications')
           AND jsonb_typeof(p_changes->v_key) <> 'boolean' THEN
            RAISE EXCEPTION '% is true or false', v_key USING ERRCODE = '22023';
        END IF;
    END LOOP;
    IF p_changes ? 'muted_until' AND NOT p_changes ? 'muted' THEN
        RAISE EXCEPTION 'muted_until is set with muted' USING ERRCODE = '22023';
    END IF;

    IF p_changes ? 'muted' THEN
        SELECT m.muted, m.muted_until INTO v_muted, v_until FROM public.notification_mute_value(p_changes) m;
        UPDATE public.user_servers
           SET muted = v_muted, muted_until = v_until
         WHERE user_id = v_me AND server_id = p_server_id;
    END IF;

    IF p_changes ?| ARRAY['level', 'suppress_everyone', 'suppress_roles', 'push_notifications'] THEN
        v_level := public.notification_level_value(p_changes->'level');
        INSERT INTO public.notification_servers AS ns
            (user_id, server_id, notification_level, suppress_everyone, suppress_roles, push_notifications)
        VALUES (v_me, p_server_id, v_level,
                COALESCE((p_changes->>'suppress_everyone')::boolean, false),
                COALESCE((p_changes->>'suppress_roles')::boolean, false),
                COALESCE((p_changes->>'push_notifications')::boolean, true))
        ON CONFLICT (user_id, server_id) DO UPDATE SET
            notification_level = CASE WHEN p_changes ? 'level' THEN EXCLUDED.notification_level
                                      ELSE ns.notification_level END,
            suppress_everyone = CASE WHEN p_changes ? 'suppress_everyone' THEN EXCLUDED.suppress_everyone
                                     ELSE ns.suppress_everyone END,
            suppress_roles = CASE WHEN p_changes ? 'suppress_roles' THEN EXCLUDED.suppress_roles
                                  ELSE ns.suppress_roles END,
            push_notifications = CASE WHEN p_changes ? 'push_notifications' THEN EXCLUDED.push_notifications
                                      ELSE ns.push_notifications END,
            updated_at = now();
    END IF;

    PERFORM public.notification_settings_changed(v_me, p_server_id);
    RETURN public.notification_settings_state(v_me, p_server_id);
END;
$$;

-- Writes the caller's override row for a channel or a category: p_changes keys level,
-- muted, muted_until, each optional. A row left with neither a level nor a mute is deleted.
CREATE OR REPLACE FUNCTION public.apply_notification_override(
    p_user_id uuid, p_server_id uuid, p_channel_id uuid, p_category_id uuid, p_changes jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_key text;
    v_level text;
    v_muted boolean := false;
    v_until timestamptz;
    v_id uuid;
BEGIN
    IF jsonb_typeof(p_changes) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'changes is an object' USING ERRCODE = '22023';
    END IF;
    FOR v_key IN SELECT jsonb_object_keys(p_changes) LOOP
        IF v_key NOT IN ('level', 'muted', 'muted_until') THEN
            RAISE EXCEPTION 'unknown setting %', v_key USING ERRCODE = '22023';
        END IF;
    END LOOP;
    IF p_changes ? 'muted_until' AND NOT p_changes ? 'muted' THEN
        RAISE EXCEPTION 'muted_until is set with muted' USING ERRCODE = '22023';
    END IF;

    v_level := public.notification_level_value(p_changes->'level');
    IF p_changes ? 'muted' THEN
        SELECT m.muted, m.muted_until INTO v_muted, v_until FROM public.notification_mute_value(p_changes) m;
    END IF;

    IF p_channel_id IS NOT NULL THEN
        INSERT INTO public.notification_channels AS nc
            (user_id, server_id, channel_id, notification_level, muted, muted_until, updated_at)
        VALUES (p_user_id, p_server_id, p_channel_id, v_level,
                v_muted, v_until, now())
        ON CONFLICT (user_id, channel_id) WHERE channel_id IS NOT NULL AND conversation_id IS NULL
        DO UPDATE SET
            server_id = EXCLUDED.server_id,
            notification_level = CASE WHEN p_changes ? 'level' THEN EXCLUDED.notification_level
                                      ELSE nc.notification_level END,
            muted = CASE WHEN p_changes ? 'muted' THEN EXCLUDED.muted ELSE nc.muted END,
            muted_until = CASE WHEN p_changes ? 'muted' THEN EXCLUDED.muted_until ELSE nc.muted_until END,
            updated_at = now()
        RETURNING nc.id INTO v_id;
    ELSE
        INSERT INTO public.notification_channels AS nc
            (user_id, server_id, category_id, notification_level, muted, muted_until, updated_at)
        VALUES (p_user_id, p_server_id, p_category_id, v_level,
                v_muted, v_until, now())
        ON CONFLICT (user_id, category_id) WHERE category_id IS NOT NULL
        DO UPDATE SET
            server_id = EXCLUDED.server_id,
            notification_level = CASE WHEN p_changes ? 'level' THEN EXCLUDED.notification_level
                                      ELSE nc.notification_level END,
            muted = CASE WHEN p_changes ? 'muted' THEN EXCLUDED.muted ELSE nc.muted END,
            muted_until = CASE WHEN p_changes ? 'muted' THEN EXCLUDED.muted_until ELSE nc.muted_until END,
            updated_at = now()
        RETURNING nc.id INTO v_id;
    END IF;

    DELETE FROM public.notification_channels nc
     WHERE nc.id = v_id AND nc.notification_level IS NULL
       AND NOT (nc.muted IS TRUE AND (nc.muted_until IS NULL OR nc.muted_until > now()));

    PERFORM public.notification_settings_changed(p_user_id, p_server_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_channel_notification_override(p_channel_id uuid, p_changes jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server uuid;
    v_me uuid;
BEGIN
    SELECT c.server_id INTO v_server FROM public.channels c WHERE c.id = p_channel_id;
    v_me := public.notification_settings_member(v_server);
    IF NOT public.can_view_channel(v_me, p_channel_id) THEN
        RAISE EXCEPTION 'Channel not found' USING ERRCODE = '42501';
    END IF;
    PERFORM public.apply_notification_override(v_me, v_server, p_channel_id, NULL, p_changes);
    RETURN public.notification_settings_state(v_me, v_server);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_category_notification_override(p_category_id uuid, p_changes jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server uuid;
    v_me uuid;
BEGIN
    SELECT k.server_id INTO v_server FROM public.channel_categories k WHERE k.id = p_category_id;
    v_me := public.notification_settings_member(v_server);
    PERFORM public.apply_notification_override(v_me, v_server, NULL, p_category_id, p_changes);
    RETURN public.notification_settings_state(v_me, v_server);
END;
$$;

COMMENT ON FUNCTION public.update_server_notification_settings(uuid, jsonb) IS
    'Patches the caller''s settings for a server: muted, muted_until, level (null follows the server default), suppress_everyone, suppress_roles, push_notifications. Returns get_server_notification_settings.';
COMMENT ON FUNCTION public.update_channel_notification_override(uuid, jsonb) IS
    'Patches the caller''s override of a channel: level (null inherits), muted, muted_until. A row with neither level nor mute is removed. Returns get_server_notification_settings.';
COMMENT ON FUNCTION public.update_category_notification_override(uuid, jsonb) IS
    'Patches the caller''s override of a category: level (null inherits), muted, muted_until. A row with neither level nor mute is removed. Returns get_server_notification_settings.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.get_server_notification_settings(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_server_notification_settings(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_channel_notification_override(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_category_notification_override(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_server_notification_settings(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_server_notification_settings(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_channel_notification_override(uuid, jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_category_notification_override(uuid, jsonb) TO authenticated, service_role;

-- Internal. Owners of SECURITY DEFINER callers keep EXECUTE on them: production's callers
-- belong to postgres, functions created here to the migrating role.
DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.notification_policy(uuid, uuid, uuid)',
        'public.channel_mute_active(uuid, uuid)',
        'public.sync_unread_category_mute(uuid, uuid)',
        'public.track_channel_category_mute()',
        'public.notification_settings_state(uuid, uuid)',
        'public.notification_settings_member(uuid)',
        'public.notification_settings_changed(uuid, uuid)',
        'public.notification_level_value(jsonb)',
        'public.notification_mute_value(jsonb)',
        'public.apply_notification_override(uuid, uuid, uuid, uuid, jsonb)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
        FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_channel_message_notifications() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.track_unread_mute() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sync_unread_mute(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
