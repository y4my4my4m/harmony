-- @here: a mention of the members who are online and can view the channel, as Discord's.
--
-- Part. A role_mention whose roleId is 'here':
--   {"type":"role_mention","roleId":"here","roleName":"here","roleColor":null}
-- Role ids are UUIDs; 'here' names no role. @everyone stays the role_mention of the server's
-- is_default role. Readers built before this migration show the part as the role pill
-- "@here", skip it as a role that does not resolve (handle_role_mention_notifications reads
-- UUIDs only; bot-gateway's resolveMentionParts turns it into the text "@here") and never
-- read it as @everyone.
--
-- handle_role_mention_notifications, 20261011200001 plus @here. The sender's right is
-- @everyone's: MENTION_EVERYONE in the channel, or check_bot_permission 'mention_everyone' for a
-- bot. Recipients are @everyone's (accepted members but the sender, suppress_everyone left
-- out, then send_notification's policy, VIEW_CHANNEL and viewing checks) that are online, as
-- Discord counts online, idle and do not disturb:
--   user_presence.status 1, 2 or 3 (4 is invisible), and
--   a presence_devices row with last_seen_at within 150 s (PRESENCE_TTL, from which
--   presence_publish derives user_presence.online).
-- user_presence.online is not read: a device that stops without presence_offline stays in it
-- until presence_sweep, once a minute. A member without a user_presence row is offline.
-- One notification per member and message: @everyone reaches every member @here would, so
-- @here beside it notifies no one more; members a mention of the message already reached
-- (trg_handle_message_federation fires first) are left out; holders of a mentioned role whom
-- @here reached are left out of the role mention. channel_message leaves out every member a
-- mention notification of the message reached, @here's included. @here notifications carry
-- is_here and is_everyone: send_notification drops is_everyone for suppress_everyone, which
-- suppresses both as on Discord.
--
-- is_plaintext_mention_part admits roleId 'here', so an end-to-end encrypted channel message
-- can carry @here beside its ciphertext.
--
-- automod_check_message, 20261008900001 with block_everyone_without_permission covering @here.
-- mention_spam counts @here as one role mention, as @everyone.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Encrypted channels: 20261001000001 plus roleId 'here'
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_plaintext_mention_part(p_part jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
    SELECT COALESCE(
        jsonb_typeof(p_part) = 'object'
        AND CASE p_part->>'type'
            WHEN 'mention' THEN
                NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_part) k
                             WHERE k NOT IN ('type', 'userId', 'username', 'domain', 'isLocal'))
                AND jsonb_typeof(p_part->'username') = 'string'
                AND char_length(p_part->>'username') BETWEEN 1 AND 100
                AND COALESCE(jsonb_typeof(p_part->'userId'), 'null') IN ('string', 'null')
                AND COALESCE(char_length(p_part->>'userId'), 0) <= 64
                AND COALESCE(jsonb_typeof(p_part->'domain'), 'null') IN ('string', 'null')
                AND COALESCE(char_length(p_part->>'domain'), 0) <= 253
                AND COALESCE(jsonb_typeof(p_part->'isLocal'), 'null') IN ('boolean', 'null')
            WHEN 'role_mention' THEN
                NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_part) k
                             WHERE k NOT IN ('type', 'roleId'))
                AND jsonb_typeof(p_part->'roleId') = 'string'
                AND ((p_part->>'roleId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     OR p_part->>'roleId' = 'here')
            ELSE false
        END,
        false);
$$;

REVOKE ALL ON FUNCTION public.is_plaintext_mention_part(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_plaintext_mention_part(jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Role mentions: 20261011200001 plus @here
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
    v_here boolean;
    v_here_ids uuid[] := '{}';
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
    -- @here needs MENTION_EVERYONE.
    v_here := COALESCE(v_can_mention_all, false) AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.content) elem
         WHERE elem->>'type' = 'role_mention' AND elem->>'roleId' = 'here');
    IF NOT v_everyone AND NOT v_here AND v_roles IS NULL THEN
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

    -- Online members; members a mention of this message reached are left out.
    IF v_here AND NOT v_everyone THEN
        v_here_ids := ARRAY(
            SELECT us.user_id FROM user_servers us
              JOIN user_presence up ON up.profile_id = us.user_id
              LEFT JOIN notification_servers ns
                ON ns.user_id = us.user_id AND ns.server_id = us.server_id
             WHERE us.server_id = v_server_id
               AND us.status = 'accepted'
               AND us.user_id IS DISTINCT FROM NEW.user_id
               AND up.status IN (1, 2, 3)
               AND NOT COALESCE(ns.suppress_everyone, false)
               AND EXISTS (SELECT 1 FROM presence_devices d
                            WHERE d.profile_id = us.user_id
                              AND d.last_seen_at > now() - interval '150 seconds')
            EXCEPT
            SELECT n.user_id FROM notifications n
             WHERE n.created_at = now() AND n.type = 'mention'
               AND n.data->>'message_id' = NEW.id::text);
        PERFORM send_notification(
            'mention',
            v_here_ids,
            v_data || jsonb_build_object('is_everyone', true, 'is_here', true),
            v_server_id, NEW.channel_id, NULL, NEW.user_id, 'normal'
        );
    END IF;

    -- Holders @everyone or @here reached are left out.
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
                     AND (NOT v_everyone OR COALESCE(ns.suppress_everyone, false))
                     AND ur.user_id <> ALL (v_here_ids)),
            v_data,
            v_server_id, NEW.channel_id, NULL, NEW.user_id, 'normal'
        );
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_role_mention_notifications() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- AutoMod: 20261008900001 with @here in block_everyone_without_permission
-- ---------------------------------------------------------------------------

-- p_invoker is current_user of the statement that wrote the row. Returns false to drop
-- the row; raises AUTOMOD_BLOCKED, MEMBER_TIMED_OUT or ANTISPAM_* to reject it.
CREATE OR REPLACE FUNCTION public.automod_check_message(p_msg public.messages, p_op text, p_invoker text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_internal boolean := p_invoker IN ('postgres', 'supabase_admin');
    v_client boolean := p_invoker IN ('authenticated', 'anon');
    v_author uuid := p_msg.user_id;
    v_channel_id uuid;
    v_server_id uuid;
    v_category uuid;
    v_owner uuid;
    v_is_local_server boolean;
    v_enabled boolean;
    v_compiled jsonb;
    v_alert_channel uuid;
    v_timeout_until timestamptz;
    v_mask bigint := 0;
    v_role_ids uuid[] := '{}'::uuid[];
    v_default_role uuid;
    v_encrypted boolean := p_msg.encrypted IS TRUE;
    v_content jsonb := CASE WHEN jsonb_typeof(p_msg.content) = 'array' THEN p_msg.content ELSE '[]'::jsonb END;
    v_raw text;
    v_urls text[];
    v_files integer;
    v_mention_users text[];
    v_mention_roles text[];
    v_norm text;
    v_subject text;
    v_hosts text[];
    v_hosts_done boolean := false;
    v_new_member boolean;
    v_account_created timestamptz;
    v_joined timestamptz;
    v_rule jsonb;
    v_cfg jsonb;
    v_type text;
    v_hit text;
    v_re text;
    v_count integer;
    v_matches jsonb := '[]'::jsonb;
    v_block jsonb;
    v_event_type text := CASE WHEN p_op = 'UPDATE' THEN 'edit' ELSE 'message' END;
    v_mentions integer;
    v_window integer;
    v_limit integer;
    v_host text;
    v_domain text;
    v_listed boolean;
    v_fp bigint;
    v_track_antispam boolean := false;
    v_track_server boolean := false;
    v_bots_exempt boolean;
    -- 'discord:<id>' and its name when a bridge bot relays a Discord author.
    v_relayed text;
    v_relayed_name text;
    -- automod_recent_activity.user_id of the author: the profile, or md5(v_relayed) as a uuid.
    v_counted uuid := p_msg.user_id;
    v_discord_created timestamptz;
    m jsonb;
BEGIN
    IF pg_trigger_depth() < 1 THEN
        RAISE EXCEPTION 'automod_check_message runs only from the messages trigger'
            USING ERRCODE = '42501';
    END IF;

    IF v_internal AND p_msg.is_system IS TRUE THEN
        RETURN true;
    END IF;
    IF v_author IS NULL AND p_msg.bot_id IS NULL THEN
        RETURN true;
    END IF;
    IF p_op = 'UPDATE' THEN
        IF p_msg.is_deleted IS TRUE
           OR current_setting('harmony.silent_content_update', true) = 'true' THEN
            RETURN true;
        END IF;
        -- Moderators editing someone else's row are not evaluated.
        IF v_client AND v_author IS DISTINCT FROM public.get_current_profile_id() THEN
            RETURN true;
        END IF;
    END IF;

    IF v_author IS NOT NULL AND NOT v_internal THEN
        v_track_antispam := public.antispam_check_local_author(v_author, 'message', v_content, p_op);
    END IF;

    -- EXIT evaluation allows the row; the recent-activity row is written after it.
    <<evaluation>>
    BEGIN
        v_channel_id := p_msg.channel_id;
        IF v_channel_id IS NULL AND p_msg.thread_id IS NOT NULL THEN
            SELECT t.channel_id INTO v_channel_id FROM public.threads t WHERE t.id = p_msg.thread_id;
        END IF;
        IF v_channel_id IS NULL THEN
            EXIT evaluation;
        END IF;

        SELECT c.server_id, c.category, s.owner, s.is_local_server,
               st.enabled, st.compiled, st.alert_channel_id, t.until
          INTO v_server_id, v_category, v_owner, v_is_local_server,
               v_enabled, v_compiled, v_alert_channel, v_timeout_until
          FROM public.channels c
          JOIN public.servers s ON s.id = c.server_id
          LEFT JOIN public.server_automod_settings st ON st.server_id = c.server_id
          LEFT JOIN public.server_member_timeouts t
                 ON t.server_id = c.server_id AND t.user_id = v_author AND t.until > now()
         WHERE c.id = v_channel_id;

        IF NOT FOUND OR v_is_local_server IS NOT TRUE THEN
            v_server_id := NULL;
            EXIT evaluation;
        END IF;

        IF v_timeout_until IS NOT NULL
           AND (NOT v_client OR v_author = public.get_current_profile_id()) THEN
            RAISE EXCEPTION 'MEMBER_TIMED_OUT:%', floor(extract(epoch FROM v_timeout_until))::bigint
                USING ERRCODE = 'P0001',
                      HINT = format('You are timed out in this server until %s.', v_timeout_until);
        END IF;

        IF v_enabled IS NOT TRUE OR jsonb_array_length(COALESCE(v_compiled -> 'rules', '[]'::jsonb)) = 0 THEN
            EXIT evaluation;
        END IF;

        IF v_author IS NULL THEN
            v_bots_exempt := COALESCE((v_compiled ->> 'exempt_bots')::boolean, true);
            IF NOT v_internal
               AND jsonb_typeof(p_msg.metadata -> 'discord_user') = 'object'
               AND (p_msg.metadata #>> '{discord_user,id}') ~ '^[0-9]{1,20}$'
               AND EXISTS (SELECT 1 FROM public.bots b WHERE b.id = p_msg.bot_id AND b.bot_type = 'bridge') THEN
                v_relayed := 'discord:' || (p_msg.metadata #>> '{discord_user,id}');
                v_relayed_name := left(regexp_replace(
                    COALESCE(NULLIF(btrim(p_msg.metadata #>> '{discord_user,username}'), ''),
                             NULLIF(btrim(p_msg.metadata #>> '{discord_user,display_name}'), ''),
                             p_msg.metadata #>> '{discord_user,id}'),
                    '[[:cntrl:]]', ' ', 'g'), 100);
                v_counted := md5(v_relayed)::uuid;
            ELSIF v_bots_exempt THEN
                EXIT evaluation;
            END IF;
        ELSE
            IF v_author = v_owner THEN
                EXIT evaluation;
            END IF;
            SELECT COALESCE(bit_or(sr.permissions), 0),
                   COALESCE(array_agg(sr.id), '{}'),
                   (array_agg(sr.id) FILTER (WHERE sr.is_default))[1]
              INTO v_mask, v_role_ids, v_default_role
              FROM public.server_roles sr
             WHERE sr.server_id = v_server_id
               AND (sr.is_default
                    OR sr.id IN (SELECT ur.role_id FROM public.user_roles ur
                                  WHERE ur.user_id = v_author AND ur.server_id = v_server_id));
            -- ADMINISTRATOR (bit 0) or MANAGE_SERVER (bit 7).
            IF (v_mask & 129) <> 0 THEN
                EXIT evaluation;
            END IF;
        END IF;

        v_track_server := p_op = 'INSERT' AND v_counted IS NOT NULL AND NOT v_internal
                          AND COALESCE((v_compiled ->> 'track')::boolean, false);

        SELECT string_agg(e ->> 'text', E'\n') FILTER (WHERE e ->> 'type' = 'text' AND e ->> 'text' IS NOT NULL),
               array_agg(e ->> 'url') FILTER (WHERE e ->> 'type' IN ('url', 'embed') AND e ->> 'url' IS NOT NULL),
               count(*) FILTER (WHERE e ->> 'type' = 'file'),
               array_agg(DISTINCT COALESCE(e ->> 'userId', (e ->> 'username') || '@' || COALESCE(e ->> 'domain', '')))
                   FILTER (WHERE e ->> 'type' = 'mention'),
               array_agg(DISTINCT e ->> 'roleId') FILTER (WHERE e ->> 'type' = 'role_mention' AND e ->> 'roleId' IS NOT NULL)
          INTO v_raw, v_urls, v_files, v_mention_users, v_mention_roles
          FROM jsonb_array_elements(v_content) e;

        v_mentions := COALESCE(cardinality(v_mention_users), 0) + COALESCE(cardinality(v_mention_roles), 0);

        FOR v_rule IN SELECT r FROM jsonb_array_elements(v_compiled -> 'rules') r LOOP
            v_type := v_rule ->> 'type';
            v_cfg := v_rule -> 'c';
            v_hit := NULL;

            IF (v_rule -> 'xc') ? v_channel_id::text
               OR (v_category IS NOT NULL AND (v_rule -> 'xc') ? v_category::text) THEN
                CONTINUE;
            END IF;
            IF v_author IS NOT NULL AND jsonb_array_length(v_rule -> 'xr') > 0
               AND (v_rule -> 'xr') ?| v_role_ids::text[] THEN
                CONTINUE;
            END IF;
            IF v_author IS NULL AND v_relayed IS NULL AND v_type IN ('message_flood', 'duplicate_spam', 'new_member') THEN
                CONTINUE;
            END IF;
            -- Under exempt_bots a relayed author meets the author rules alone.
            IF v_relayed IS NOT NULL AND v_bots_exempt
               AND v_type NOT IN ('mention_spam', 'message_flood', 'duplicate_spam', 'new_member') THEN
                CONTINUE;
            END IF;

            IF v_type IN ('keyword', 'keyword_preset') THEN
                CONTINUE WHEN v_encrypted OR v_raw IS NULL;
                IF v_norm IS NULL THEN
                    v_norm := public.automod_normalize(v_raw);
                END IF;
                v_subject := v_norm;
                IF v_cfg ? 'allow' THEN
                    v_subject := regexp_replace(v_subject, v_cfg ->> 'allow', ' ', 'g');
                END IF;
                IF v_cfg ? 'pattern' AND v_subject ~ (v_cfg ->> 'pattern') THEN
                    v_hit := (regexp_match(v_subject, v_cfg ->> 'pattern'))[1];
                    v_hit := COALESCE(v_hit, 'keyword');
                END IF;
                IF v_hit IS NULL AND v_cfg ? 'regex' THEN
                    FOR v_re IN SELECT jsonb_array_elements_text(v_cfg -> 'regex') LOOP
                        IF v_raw ~* v_re THEN
                            v_hit := COALESCE((regexp_match(v_raw, v_re, 'i'))[1], 'regex');
                        ELSIF v_subject ~* v_re THEN
                            v_hit := COALESCE((regexp_match(v_subject, v_re, 'i'))[1], 'regex');
                        END IF;
                        EXIT WHEN v_hit IS NOT NULL;
                    END LOOP;
                END IF;

            ELSIF v_type = 'mention_spam' THEN
                CONTINUE WHEN v_mentions = 0;
                IF v_mentions > (v_cfg ->> 'max_mentions')::integer THEN
                    v_hit := v_mentions || ' mentions';
                ELSIF (v_cfg ->> 'block_everyone_without_permission')::boolean
                      AND (v_default_role::text = ANY (COALESCE(v_mention_roles, '{}'))
                           OR 'here' = ANY (COALESCE(v_mention_roles, '{}')))
                      AND v_author IS NOT NULL
                      AND NOT public.has_permission(v_author, v_server_id, 'MENTION_EVERYONE', v_channel_id) THEN
                    v_hit := CASE WHEN v_default_role::text = ANY (COALESCE(v_mention_roles, '{}'))
                                  THEN '@everyone' ELSE '@here' END;
                ELSIF p_op = 'INSERT' AND v_counted IS NOT NULL AND NOT v_internal
                      AND (v_cfg ->> 'window_mentions')::integer > 0 THEN
                    v_window := (v_cfg ->> 'window_seconds')::integer;
                    SELECT COALESCE(sum(ra.mentions), 0) INTO v_count
                      FROM public.automod_recent_activity ra
                     WHERE ra.user_id = v_counted
                       AND ra.created_at > now() - make_interval(secs => v_window)
                       AND ra.server_id = v_server_id;
                    IF v_count + v_mentions > (v_cfg ->> 'window_mentions')::integer THEN
                        v_hit := (v_count + v_mentions) || ' mentions in ' || v_window || ' s';
                    END IF;
                END IF;

            ELSIF v_type = 'message_flood' THEN
                CONTINUE WHEN p_op <> 'INSERT' OR v_internal;
                v_limit := (v_cfg ->> 'max_messages')::integer;
                v_window := (v_cfg ->> 'window_seconds')::integer;
                SELECT count(*) INTO v_count
                  FROM (SELECT 1
                          FROM public.automod_recent_activity ra
                         WHERE ra.user_id = v_counted
                           AND ra.created_at > now() - make_interval(secs => v_window)
                           AND ra.server_id = v_server_id
                         LIMIT v_limit) r;
                IF v_count >= v_limit THEN
                    v_hit := v_limit || ' messages in ' || v_window || ' s';
                END IF;

            ELSIF v_type = 'duplicate_spam' THEN
                CONTINUE WHEN p_op <> 'INSERT' OR v_internal OR v_encrypted OR v_raw IS NULL
                           OR char_length(btrim(v_raw)) < (v_cfg ->> 'min_length')::integer;
                IF v_norm IS NULL THEN
                    v_norm := public.automod_normalize(v_raw);
                END IF;
                v_fp := hashtextextended(v_norm, 0);
                SELECT count(DISTINCT f.channel_id) INTO v_count
                  FROM (SELECT ra.channel_id
                          FROM public.automod_recent_activity ra
                         WHERE ra.user_id = v_counted
                           AND ra.created_at > now() - make_interval(secs => (v_cfg ->> 'window_seconds')::integer)
                           AND ra.server_id = v_server_id
                           AND ra.fp = v_fp
                           AND ra.channel_id <> v_channel_id
                         LIMIT 100) f;
                IF v_count >= (v_cfg ->> 'max_channels')::integer THEN
                    v_hit := 'same message in ' || (v_count + 1) || ' channels';
                END IF;

            ELSIF v_type = 'invites' THEN
                CONTINUE WHEN v_encrypted OR (v_raw IS NULL AND v_urls IS NULL);
                v_hit := public.automod_foreign_invite(v_raw, v_urls, v_server_id);

            ELSIF v_type = 'links' THEN
                CONTINUE WHEN v_encrypted OR (v_raw IS NULL AND v_urls IS NULL);
                IF NOT v_hosts_done THEN
                    v_hosts := public.automod_link_hosts(v_raw, v_urls);
                    v_hosts_done := true;
                END IF;
                FOREACH v_host IN ARRAY v_hosts LOOP
                    v_listed := false;
                    FOR v_domain IN SELECT jsonb_array_elements_text(v_cfg -> 'domains') LOOP
                        IF v_host = v_domain OR right(v_host, char_length(v_domain) + 1) = '.' || v_domain THEN
                            v_listed := true;
                            EXIT;
                        END IF;
                    END LOOP;
                    IF (v_cfg ->> 'mode' = 'allow_list' AND NOT v_listed)
                       OR (v_cfg ->> 'mode' = 'block_list' AND v_listed) THEN
                        v_hit := v_host;
                        EXIT;
                    END IF;
                END LOOP;

            ELSIF v_type = 'new_member' THEN
                IF v_new_member IS NULL AND v_relayed IS NOT NULL THEN
                    -- Membership age from discord_user.joined_at; without one the rule does
                    -- not apply. Account age from the Discord id: snowflake bits 63..22 are
                    -- milliseconds since 2015-01-01T00:00:00Z (1420070400000 Unix ms).
                    BEGIN
                        v_joined := (p_msg.metadata #>> '{discord_user,joined_at}')::timestamptz;
                    EXCEPTION WHEN data_exception THEN
                        v_joined := NULL;
                    END;
                    v_discord_created := to_timestamp(((floor(
                        (p_msg.metadata #>> '{discord_user,id}')::numeric / 4194304) + 1420070400000) / 1000)::double precision);
                    v_new_member := COALESCE(v_joined IS NOT NULL AND (
                        ((v_cfg ->> 'min_account_age_minutes')::integer > 0
                         AND v_discord_created > now() - make_interval(mins => (v_cfg ->> 'min_account_age_minutes')::integer))
                        OR ((v_cfg ->> 'min_membership_minutes')::integer > 0
                            AND v_joined > now() - make_interval(mins => (v_cfg ->> 'min_membership_minutes')::integer))), false);
                ELSIF v_new_member IS NULL THEN
                    SELECT p.created_at INTO v_account_created FROM public.profiles p WHERE p.id = v_author;
                    SELECT us.created_at INTO v_joined
                      FROM public.user_servers us
                     WHERE us.user_id = v_author AND us.server_id = v_server_id;
                    v_new_member :=
                        ((v_cfg ->> 'min_account_age_minutes')::integer > 0
                         AND v_account_created > now() - make_interval(mins => (v_cfg ->> 'min_account_age_minutes')::integer))
                        OR ((v_cfg ->> 'min_membership_minutes')::integer > 0
                            AND v_joined > now() - make_interval(mins => (v_cfg ->> 'min_membership_minutes')::integer));
                    v_new_member := COALESCE(v_new_member, false);
                END IF;
                CONTINUE WHEN NOT v_new_member;
                IF (v_cfg ->> 'restrict_attachments')::boolean AND v_files > 0 THEN
                    v_hit := 'attachment';
                ELSIF (v_cfg ->> 'restrict_mentions')::boolean AND v_mentions > 0 THEN
                    v_hit := 'mention';
                ELSIF (v_cfg ->> 'restrict_links')::boolean AND NOT v_encrypted
                      AND (v_raw IS NOT NULL OR v_urls IS NOT NULL) THEN
                    IF NOT v_hosts_done THEN
                        v_hosts := public.automod_link_hosts(v_raw, v_urls);
                        v_hosts_done := true;
                    END IF;
                    IF cardinality(v_hosts) > 0 THEN
                        v_hit := v_hosts[1];
                    END IF;
                END IF;
            END IF;

            CONTINUE WHEN v_hit IS NULL;

            v_matches := v_matches || jsonb_build_array(jsonb_build_object('rule', v_rule, 'hit', v_hit));
            IF COALESCE((v_rule -> 'a' ->> 'block')::boolean, false) THEN
                v_block := v_rule;
                EXIT;
            END IF;
        END LOOP;

        IF jsonb_array_length(v_matches) = 0 THEN
            EXIT evaluation;
        END IF;

        IF v_block IS NOT NULL THEN
            -- The row must pass messages_insert_member before anything persists for it.
            IF v_client THEN
                IF v_author IS NULL OR v_author IS DISTINCT FROM public.get_current_profile_id() THEN
                    RETURN true;
                END IF;
                IF p_op = 'INSERT' AND NOT (
                       p_msg.channel_id IS NOT NULL
                       AND v_channel_id IN (SELECT public.current_user_viewable_channel_ids())
                       AND public.has_permission(v_author, v_server_id,
                               CASE WHEN p_msg.thread_id IS NULL THEN 'SEND_MESSAGES' ELSE 'SEND_MESSAGES_IN_THREADS' END,
                               v_channel_id)) THEN
                    RETURN true;
                END IF;
            END IF;

            IF public.automod_singular_request() THEN
                RAISE EXCEPTION 'AUTOMOD_BLOCKED:%', v_block ->> 'type'
                    USING ERRCODE = 'P0001',
                          DETAIL = jsonb_build_object('rule_type', v_block ->> 'type',
                                                      'rule_name', v_block ->> 'name',
                                                      'message', v_block -> 'a' ->> 'block_message')::text,
                          HINT = COALESCE(v_block -> 'a' ->> 'block_message',
                                          'This message was blocked by the server''s AutoMod.');
            END IF;
        END IF;

        FOR m IN SELECT x FROM jsonb_array_elements(v_matches) x LOOP
            PERFORM public.automod_record_match(
                v_server_id, v_channel_id, v_author, p_msg.bot_id,
                CASE WHEN v_block IS NULL OR p_op = 'UPDATE' THEN p_msg.id END,
                v_event_type, m -> 'rule', m ->> 'hit',
                v_block IS NOT NULL AND (m -> 'rule' ->> 'id') = (v_block ->> 'id'),
                v_content, v_alert_channel, v_relayed, v_relayed_name);
        END LOOP;

        IF v_block IS NOT NULL THEN
            RETURN false;
        END IF;
    END evaluation;

    IF p_op = 'INSERT' AND (v_track_antispam OR v_track_server) THEN
        INSERT INTO public.automod_recent_activity (user_id, kind, server_id, channel_id, fp, mentions)
        VALUES (v_counted, 'message', v_server_id, v_channel_id, v_fp, COALESCE(v_mentions, 0));
    END IF;
    RETURN true;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
