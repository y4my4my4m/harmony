-- Masked links: a url part's `label` ({type:'url', url, preview, label}, typed as [label](url))
-- is message text. Previews, notifications, push and search read it, and AutoMod's text rules
-- (keywords, patterns, invites in text) see it.
--
--   extract_message_text   text parts, @mentions, and url labels in order. Feeds every
--                          content_preview / message_preview and index_message_row (search).
--   automod_message_text   text parts and url labels, one per line (the alert excerpt).
--   automod_check_message  the text keyword, regex and invite rules match: labels added.
--   jsonb_text_content_length
--                          text parts and url labels: max_message_length and max_post_length
--                          (enforce_message_length, enforce_post_length) and the 50000
--                          character CHECKs count a label as text.
--
-- Each is redefined from its latest definition (baseline; 20261005100001_server_automod;
-- 20261011600001_here_mention) with the label added and nothing else changed. Rows already
-- stored hold no label; nothing to backfill, and no stored row fails the CHECKs.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.extract_message_text(content_parts jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    result text := '';
    part jsonb;
BEGIN
    IF content_parts IS NULL OR jsonb_typeof(content_parts) != 'array' THEN
        RETURN '';
    END IF;

    FOR part IN SELECT jsonb_array_elements(content_parts)
    LOOP
        IF part->>'type' = 'text' THEN
            result := result || COALESCE(part->>'text', '');
        ELSIF part->>'type' = 'mention' THEN
            result := result || '@' || COALESCE(part->>'username', '');
        ELSIF part->>'type' = 'url' AND jsonb_typeof(part->'label') = 'string' THEN
            result := result || btrim(part->>'label');
        END IF;
    END LOOP;

    RETURN trim(result);
END;
$$;

-- As the baseline, plus string labels of url parts. src/utils/messageContentUtils.ts
-- messageTextLength counts the same.
CREATE OR REPLACE FUNCTION public.jsonb_text_content_length(content jsonb)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    total integer := 0;
    n integer;
    i integer;
    part jsonb;
BEGIN
    IF content IS NULL OR jsonb_typeof(content) <> 'array' THEN
        RETURN 0;
    END IF;

    n := jsonb_array_length(content);
    IF n = 0 THEN
        RETURN 0;
    END IF;

    FOR i IN 0..(n - 1) LOOP
        part := content -> i;
        IF jsonb_typeof(part) <> 'object' THEN
            CONTINUE;
        END IF;
        IF (part ->> 'type') = 'text' THEN
            total := total + COALESCE(char_length(part ->> 'text'), 0);
        ELSIF (part ->> 'type') = 'url' AND jsonb_typeof(part -> 'label') = 'string' THEN
            total := total + char_length(part ->> 'label');
        END IF;
    END LOOP;

    RETURN total;
END;
$$;

COMMENT ON FUNCTION public.jsonb_text_content_length(jsonb) IS
'Total character count across the text parts and url labels of a MessagePart[] jsonb. IMMUTABLE so it can be used from CHECK constraints. Keep MAX_MESSAGE_TEXT_LENGTH / MAX_POST_TEXT_LENGTH in src/utils/messageContentUtils.ts in sync with the constraint limits.';

CREATE OR REPLACE FUNCTION public.automod_message_text(p_content jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
    SELECT string_agg(CASE WHEN e ->> 'type' = 'text' THEN e ->> 'text' ELSE e ->> 'label' END, E'\n' ORDER BY ord)
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_content) = 'array' THEN p_content ELSE '[]'::jsonb END)
           WITH ORDINALITY AS t(e, ord)
     WHERE (e ->> 'type' = 'text' AND e ->> 'text' IS NOT NULL)
        OR (e ->> 'type' = 'url' AND jsonb_typeof(e -> 'label') = 'string')
$$;

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

        -- A masked link's label is text (20261030900001).
        SELECT string_agg(CASE WHEN e ->> 'type' = 'text' THEN e ->> 'text' ELSE e ->> 'label' END, E'\n')
                   FILTER (WHERE (e ->> 'type' = 'text' AND e ->> 'text' IS NOT NULL)
                              OR (e ->> 'type' = 'url' AND jsonb_typeof(e -> 'label') = 'string')),
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

-- Grants as SURFACE.tsv records them: extract_message_text callable by every role,
-- automod_message_text by service_role only.
REVOKE ALL ON FUNCTION public.extract_message_text(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.extract_message_text(jsonb) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.automod_message_text(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.automod_message_text(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.automod_check_message(public.messages, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.automod_check_message(public.messages, text, text) TO authenticated, service_role;

COMMIT;
