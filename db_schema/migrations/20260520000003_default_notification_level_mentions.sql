-- ---------------------------------------------------------------------------
-- Default notification level for channels: 'all' → 'mentions'
--
-- Rationale: getting pinged for every message in every channel is Slack-from-2015
-- behavior. Most modern chat apps (Discord, Matrix, Slack today) default new
-- channels/servers to "mentions only" so the bell badge means something.
--
-- This migration changes the effective default in three places:
--   1. `notification_channels.notification_level` column default ('all' → 'mentions')
--   2. `server_settings.default_message_notifications` column default ('all' → 'mentions')
--   3. The hardcoded fallback in `send_notification(...)`
--      (`COALESCE(v_server_default, 'all')` → `COALESCE(v_server_default, 'mentions')`)
--
-- IMPORTANT - what this does NOT do:
--   - Existing rows in `notification_channels` and `server_settings` keep their
--     stored values. A user who already set a channel to "All Messages"
--     deliberately is unaffected.
--   - The CHECK constraints on both columns already accept 'mentions', so no
--     constraint changes are needed.
--   - DMs (conversations) are not affected - the `notification_level` enforcement
--     block in `send_notification` only runs for `p_channel_id IS NOT NULL`.
--
-- Most users have NO row in `notification_channels` at all (rows are only
-- created when they explicitly mute or change a level), so the *function
-- fallback* is the change that actually moves the needle for existing users.
-- ---------------------------------------------------------------------------
BEGIN;

-- 1. Per-channel/server table default for any future row that omits the column.
--    `ADD COLUMN IF NOT EXISTS` guards against older deployments that pre-date
--    the column; `ALTER COLUMN ... SET DEFAULT` updates the default when the
--    column already existed from an older init.
ALTER TABLE public.notification_channels
    ADD COLUMN IF NOT EXISTS notification_level varchar(20) DEFAULT 'mentions'::varchar;
ALTER TABLE public.notification_channels
    ALTER COLUMN notification_level SET DEFAULT 'mentions'::varchar;

-- 2. Per-server default-for-new-members.
--    Some local/older deployments never received the column because the
--    original `20260307_ensure_server_settings.sql` migration was moved to
--    `db_schema/archives/` before all environments had applied it, and
--    `CREATE TABLE IF NOT EXISTS` in the init file does NOT add new columns
--    to an existing table. Recreate it defensively here.
ALTER TABLE public.server_settings
    ADD COLUMN IF NOT EXISTS default_message_notifications text DEFAULT 'mentions'::text;
ALTER TABLE public.server_settings
    ALTER COLUMN default_message_notifications SET DEFAULT 'mentions'::text;

-- 2a. CHECK constraint may or may not exist - add it iff missing.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname = 'server_settings'
          AND c.conname = 'server_settings_notifications_check'
    ) THEN
        ALTER TABLE public.server_settings
            ADD CONSTRAINT server_settings_notifications_check
            CHECK (default_message_notifications IN ('all', 'mentions', 'none'));
    END IF;
END $$;

-- 3. Recreate send_notification with the new fallback. Body is identical to
--    20260321_reaction_notifications_bypass_mentions_only.sql except for the
--    one COALESCE default. We recreate the whole function rather than try to
--    patch it because PL/pgSQL doesn't support partial replacement.
--
--    DROP first: PostgreSQL refuses CREATE OR REPLACE when input parameter
--    names change (42P13). Older environments may have a `send_notification`
--    whose first arg was named `notification_type` instead of
--    `p_notification_type` - drop unconditionally so the rename works.
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
    v_is_content_feedback_type boolean;
BEGIN
    IF p_notification_type IS NULL OR array_length(to_user_ids, 1) IS NULL THEN
        RETURN '{}';
    END IF;

    is_activitypub_type := p_notification_type LIKE 'activitypub_%';
    v_is_mention_type := p_notification_type IN ('mention', 'activitypub_mention');
    v_is_content_feedback_type := p_notification_type IN (
        'reaction', 'activitypub_reaction', 'activitypub_favorite', 'activitypub_reblog'
    );

    FOREACH recipient_id IN ARRAY to_user_ids LOOP
        IF p_from_user_id IS NOT NULL AND recipient_id = p_from_user_id THEN
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
        END IF;

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

            IF COALESCE(is_channel_muted, false) = true
               AND v_muted_until IS NOT NULL
               AND v_muted_until <= NOW() THEN
                is_channel_muted := false;
            END IF;

            IF COALESCE(is_channel_muted, false) = true THEN
                IF NOT v_is_mention_type THEN
                    CONTINUE;
                END IF;
            END IF;

            -- New default: when neither the user nor the server has expressed
            -- a preference, fall back to 'mentions' (was 'all').
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

NOTIFY pgrst, 'reload schema';

COMMIT;
