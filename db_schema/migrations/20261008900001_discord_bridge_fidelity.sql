-- Discord bridge v2.2 (bridge 2.2.0): AutoMod for relayed Discord authors, bridge bot avatar.
--
-- Relayed author. A row a bridge bot (bots.bot_type = 'bridge') writes with
-- metadata.discord_user.id (1-20 digits) relays the Discord author 'discord:<id>'. Whatever the
-- server's exempt_bots, the author rules apply to it, counting automod_recent_activity rows
-- keyed md5('discord:<id>')::uuid:
--   message_flood, duplicate_spam  as for members.
--   mention_spam                   per-message limit and window; the @everyone check needs a
--                                  member and is skipped.
--   new_member                     only when metadata.discord_user.joined_at parses as a
--                                  timestamp: membership age from it, account age from the
--                                  Discord id's snowflake timestamp.
-- Keyword, preset, invite and link rules apply to relayed rows as to other bot rows: only with
-- exempt_bots off. Rows relaying no Discord author are evaluated as in 20261005100001.
-- A timeout needs a profile and is not applied to a relayed author; block and alert are.
-- A relayed author's events carry details {author_key, author_name} and fold per author; the
-- alert names "<author_name> (Discord)". automod_record_match takes p_author_key and
-- p_author_name; the 11-argument form is dropped.
--
-- Bridge bot avatar. discord_bridge_provision_bot gives new bridge bots avatar_url
-- '/discord-bridge-bot.webp', an image the web app bundles in public/ as it does
-- '/default_avatar.webp'. Bots a discord_bridges row references take it when they carry no
-- avatar or the default one.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- AutoMod
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.automod_record_match(
    uuid, uuid, uuid, uuid, uuid, text, jsonb, text, boolean, jsonb, uuid);

-- Records one rule match: folds repeats within 30 s into the latest event, posts an
-- alert for a new event, applies the rule's timeout. p_author_key ('discord:<id>') and
-- p_author_name name a relayed author of the bot p_bot_id; the event keeps them in details
-- and folds per author.
CREATE OR REPLACE FUNCTION public.automod_record_match(
    p_server_id uuid, p_channel_id uuid, p_user_id uuid, p_bot_id uuid, p_message_id uuid,
    p_event_type text, p_rule jsonb, p_hit text, p_blocked boolean, p_content jsonb,
    p_alert_channel uuid, p_author_key text, p_author_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_rule_id uuid := (p_rule ->> 'id')::uuid;
    v_timeout integer := COALESCE((p_rule -> 'a' ->> 'timeout_seconds')::integer, 0);
    v_alert boolean := COALESCE((p_rule -> 'a' ->> 'alert')::boolean, false);
    v_actions text[] := '{}'::text[];
    v_excerpt text := left(public.automod_message_text(p_content), 1000);
    v_event uuid;
    v_author text;
    v_relayed jsonb := CASE WHEN p_author_key IS NOT NULL
                            THEN jsonb_build_object('author_key', p_author_key, 'author_name', p_author_name)
                            ELSE '{}'::jsonb END;
    v_channel_name text;
    v_verb text;
BEGIN
    IF p_blocked THEN v_actions := v_actions || 'block'::text; END IF;
    IF v_alert THEN v_actions := v_actions || 'alert'::text; END IF;
    IF v_timeout > 0 AND p_user_id IS NOT NULL THEN v_actions := v_actions || 'timeout'::text; END IF;

    IF p_user_id IS NOT NULL THEN
        SELECT e.id INTO v_event
          FROM public.automod_events e
         WHERE e.user_id = p_user_id
           AND e.last_hit_at > now() - interval '30 seconds'
           AND e.server_id = p_server_id
           AND e.rule_id = v_rule_id
           AND e.event_type = p_event_type
         ORDER BY e.last_hit_at DESC
         LIMIT 1
         FOR UPDATE;
    ELSE
        SELECT e.id INTO v_event
          FROM public.automod_events e
         WHERE e.server_id = p_server_id
           AND e.created_at > now() - interval '1 day'
           AND e.last_hit_at > now() - interval '30 seconds'
           AND e.user_id IS NULL
           AND e.bot_id IS NOT DISTINCT FROM p_bot_id
           AND (e.details ->> 'author_key') IS NOT DISTINCT FROM p_author_key
           AND e.rule_id = v_rule_id
           AND e.event_type = p_event_type
         ORDER BY e.last_hit_at DESC
         LIMIT 1
         FOR UPDATE;
    END IF;

    IF v_event IS NOT NULL THEN
        UPDATE public.automod_events e
           SET hits = e.hits + 1,
               last_hit_at = now(),
               channel_id = p_channel_id,
               message_id = p_message_id,
               matched = left(p_hit, 200),
               content_excerpt = v_excerpt,
               actions = ARRAY(SELECT DISTINCT x FROM unnest(e.actions || v_actions) x ORDER BY 1)
         WHERE e.id = v_event;
    ELSE
        INSERT INTO public.automod_events (
            server_id, channel_id, user_id, bot_id, message_id, rule_id, rule_name, rule_type,
            event_type, actions, matched, content_excerpt, details)
        VALUES (
            p_server_id, p_channel_id, p_user_id, p_bot_id, p_message_id, v_rule_id,
            p_rule ->> 'name', p_rule ->> 'type', p_event_type,
            ARRAY(SELECT x FROM unnest(v_actions) x ORDER BY 1), left(p_hit, 200), v_excerpt,
            v_relayed)
        RETURNING id INTO v_event;

        IF v_alert AND p_alert_channel IS NOT NULL THEN
            SELECT COALESCE(p.username, 'unknown') INTO v_author FROM public.profiles p WHERE p.id = p_user_id;
            IF p_user_id IS NULL AND p_author_key IS NOT NULL THEN
                v_author := COALESCE(p_author_name, p_author_key) || ' (Discord)';
            ELSIF p_user_id IS NULL THEN
                SELECT COALESCE(b.display_name, b.username, 'a bot') INTO v_author FROM public.bots b WHERE b.id = p_bot_id;
            END IF;
            SELECT c.name INTO v_channel_name FROM public.channels c WHERE c.id = p_channel_id;
            v_verb := CASE WHEN p_blocked THEN 'blocked' ELSE 'flagged' END;
            PERFORM public.automod_post_alert(
                p_alert_channel, v_event,
                format('AutoMod %s %s from @%s in #%s (%s)%s',
                       v_verb,
                       CASE WHEN p_event_type = 'edit' THEN 'an edit' ELSE 'a message' END,
                       COALESCE(v_author, 'unknown'), COALESCE(v_channel_name, 'unknown'),
                       p_rule ->> 'name',
                       CASE WHEN v_excerpt IS NOT NULL THEN E'\n> ' || left(replace(v_excerpt, E'\n', ' '), 300) ELSE '' END),
                jsonb_build_object(
                    'event_type', p_event_type, 'rule_id', v_rule_id, 'rule_name', p_rule ->> 'name',
                    'rule_type', p_rule ->> 'type', 'user_id', p_user_id, 'bot_id', p_bot_id,
                    'channel_id', p_channel_id, 'message_id', p_message_id, 'actions', to_jsonb(v_actions),
                    'matched', left(p_hit, 200), 'excerpt', left(v_excerpt, 300)) || v_relayed);
        END IF;
    END IF;

    IF v_timeout > 0 AND p_user_id IS NOT NULL THEN
        INSERT INTO public.server_member_timeouts (server_id, user_id, until, reason, source)
        VALUES (p_server_id, p_user_id, now() + make_interval(secs => v_timeout),
                left('AutoMod: ' || (p_rule ->> 'name'), 512), 'automod')
        ON CONFLICT (server_id, user_id) DO UPDATE
           SET until = GREATEST(
                   CASE WHEN public.server_member_timeouts.until > now() THEN public.server_member_timeouts.until END,
                   EXCLUDED.until),
               reason = EXCLUDED.reason,
               source = EXCLUDED.source,
               created_by = NULL,
               created_at = now();
    END IF;
END;
$$;

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
                      AND v_default_role IS NOT NULL
                      AND v_default_role::text = ANY (COALESCE(v_mention_roles, '{}'))
                      AND v_author IS NOT NULL
                      AND NOT public.has_permission(v_author, v_server_id, 'MENTION_EVERYONE', v_channel_id) THEN
                    v_hit := '@everyone';
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

-- ---------------------------------------------------------------------------
-- Bridge bot avatar
-- ---------------------------------------------------------------------------

-- New bridge bot owned by p_owner, installed on the bridge's server; returns its id.
CREATE OR REPLACE FUNCTION public.discord_bridge_provision_bot(p_bridge_id uuid, p_owner uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_server uuid;
    v_bot uuid;
BEGIN
    SELECT server_id INTO v_server FROM public.discord_bridges WHERE id = p_bridge_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Discord bridge not found' USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO public.bots (username, display_name, bio, avatar_url, bot_type, is_public, owner_id)
    VALUES ('discord-bridge-' || encode(extensions.gen_random_bytes(6), 'hex'),
            'Discord Bridge',
            'Relays messages between this server and Discord.',
            '/discord-bridge-bot.webp',
            'bridge',
            false,
            p_owner)
    RETURNING id INTO v_bot;

    INSERT INTO public.bot_server_permissions
        (bot_id, server_id, installed_by, is_active, read_messages, send_messages, manage_channels)
    VALUES (v_bot, v_server, p_owner, true, true, true, true);

    UPDATE public.discord_bridges SET bot_id = v_bot WHERE id = p_bridge_id;
    RETURN v_bot;
END;
$$;

-- '/default_avatar.png' is the legacy column default; clients show it as the .webp.
UPDATE public.bots b
   SET avatar_url = '/discord-bridge-bot.webp'
 WHERE b.id IN (SELECT db.bot_id FROM public.discord_bridges db WHERE db.bot_id IS NOT NULL)
   AND (b.avatar_url IS NULL OR b.avatar_url IN ('/default_avatar.webp', '/default_avatar.png'));

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    grantee text;
BEGIN
    -- As 20261005100001: automod_check_message runs as the writing role and refuses at
    -- trigger depth 0; automod_record_match is internal.
    REVOKE ALL ON FUNCTION public.automod_check_message(public.messages, text, text) FROM PUBLIC, anon, authenticated;
    REVOKE ALL ON FUNCTION public.automod_record_match(
        uuid, uuid, uuid, uuid, uuid, text, jsonb, text, boolean, jsonb, uuid, text, text)
        FROM PUBLIC, anon, authenticated;
    FOREACH grantee IN ARRAY ARRAY['authenticated', 'postgres', 'supabase_admin', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.automod_check_message(public.messages, text, text) TO %I',
                           grantee);
        END IF;
    END LOOP;
    FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.automod_record_match('
                           'uuid, uuid, uuid, uuid, uuid, text, jsonb, text, boolean, jsonb, uuid, text, text) TO %I',
                           grantee);
        END IF;
    END LOOP;

    -- As 20261008300001: reached only from definers, which run as the owner.
    REVOKE ALL ON FUNCTION public.discord_bridge_provision_bot(uuid, uuid)
        FROM PUBLIC, anon, authenticated, service_role;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
