-- Matrix authors: rows a Matrix bridge bot relays for a Matrix user, and the 1.9.7 remote-user
-- privacy for them.
--
-- A relayed message or reaction: bot_id the Matrix bridge bot, user_id NULL,
-- metadata.matrix_user = {id, username, display_name?, avatar_url?} (matrix_user_valid):
--   id            MXID, ^@[^:]+:.+$ without whitespace or control characters, at most 255
--   username      1 to 100 characters, not blank
--   display_name  string or null, at most 100
--   avatar_url    string or null: https://, at most 2048
-- No other key. metadata.bridge_author is never stored: bot-gateway turns a Matrix bridge's
-- bridge_author into matrix_user.
--
--   guard_matrix_author             messages and reactions, BEFORE INSERT and UPDATE OF the author
--                                   columns, WHEN metadata holds matrix_user or bridge_author.
--                                   bridge_author is refused (42501). matrix_user needs bot_id, no
--                                   user_id, no interaction or discord_user key (42501), valid fields
--                                   (22023 invalid_matrix_user), and bridge_channel_platform 'matrix'
--                                   for the bot in the row's channel (42501). An update that keeps
--                                   matrix_user, bot_id and user_id passes: rows of a removed binding
--                                   stay editable and deletable.
--   guard_message_client_write      as 20261115100001, with matrix_user and bridge_author reserved.
--   automod_record_match            as 20261008900001; the alert names a Matrix author "<name> (Matrix)".
--   automod_check_message           as 20261110400001; a Matrix author of a bot whose bridge_platform
--                                   is 'matrix' is judged as a Discord author is: author key
--                                   'matrix:<mxid>', counted as md5 of the key. The new-member rule
--                                   does not apply to it: Matrix carries no account or membership age.
--   message_notification_sender_json  as 20260101000000; a Matrix author as a Discord author, with
--                                   the MXID as the handle. The four notification triggers take the
--                                   sender from it and need no change.
--   broadcast_message_reaction_event  as 20260101000000; names a Matrix reactor as a Discord one.
--
-- Remote-user privacy (20261112600001 and later) for platform 'matrix':
--   bridge_platform_author_key      as 20261112600001; 'matrix' -> matrix_user.
--   bridge_privacy_check_subject    as 20261112600001; an MXID for 'matrix'.
--   guard_bridge_author_optout,     as 20261115920001; the platform is the row's author key.
--   guard_bridge_reaction_optout    Their triggers fire on matrix_user too.
--   bridge_privacy_erase_core       as 20261115900001; every statement on the platform's author key,
--                                   AutoMod events by '<platform>:<id>'. Discord history imports are
--                                   touched for 'discord' only.
--   bridge_privacy_purge_server     as 20261115900001; Discord imports are stopped for 'discord' only.
--   bridge_privacy_purge_instance   as 20261115900001; history import is turned off and imports are
--                                   stopped for 'discord' only.
-- The status, opt-out, erase, restore and pending functions are platform-keyed already and take
-- 'matrix' through bridge_privacy_check_subject. History import is Discord's alone
-- (discord_bridge_imports); bridge_privacy_note_optin records a Matrix opt-in as any other.
-- Indexes on the Matrix author: 20261117900003.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Matrix author guard
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.matrix_user_valid(p_user jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE WHEN jsonb_typeof(p_user) IS DISTINCT FROM 'object' THEN false ELSE COALESCE(
               NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_user) k
                            WHERE k NOT IN ('id', 'username', 'display_name', 'avatar_url'))
           AND jsonb_typeof(p_user -> 'id') = 'string'
           AND char_length(p_user ->> 'id') <= 255
           AND (p_user ->> 'id') ~ '^@[^:[:space:][:cntrl:]]+:[^[:space:][:cntrl:]]+$'
           AND jsonb_typeof(p_user -> 'username') = 'string'
           AND char_length(p_user ->> 'username') BETWEEN 1 AND 100
           AND (p_user ->> 'username') ~ '[^[:space:]]'
           AND COALESCE(jsonb_typeof(p_user -> 'display_name'), 'null') IN ('null', 'string')
           AND COALESCE(char_length(p_user ->> 'display_name'), 0) <= 100
           AND COALESCE(jsonb_typeof(p_user -> 'avatar_url'), 'null') IN ('null', 'string')
           AND (jsonb_typeof(p_user -> 'avatar_url') IS DISTINCT FROM 'string'
                OR (char_length(p_user ->> 'avatar_url') <= 2048
                    AND (p_user ->> 'avatar_url') ~ '^https://[^[:space:][:cntrl:]]+$')),
           false) END;
$$;
REVOKE ALL ON FUNCTION public.matrix_user_valid(jsonb) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.guard_matrix_author()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel uuid;
BEGIN
    IF NEW.metadata ? 'bridge_author' THEN
        RAISE EXCEPTION 'metadata key reserved for the server: bridge_author' USING ERRCODE = '42501';
    END IF;
    IF TG_OP = 'UPDATE'
       AND NEW.metadata -> 'matrix_user' IS NOT DISTINCT FROM OLD.metadata -> 'matrix_user'
       AND NEW.bot_id IS NOT DISTINCT FROM OLD.bot_id
       AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
       AND NOT (NEW.metadata ?| ARRAY['interaction', 'discord_user']) THEN
        RETURN NEW;
    END IF;
    IF NEW.bot_id IS NULL OR NEW.user_id IS NOT NULL
       OR NEW.metadata ?| ARRAY['interaction', 'discord_user'] THEN
        RAISE EXCEPTION 'metadata key reserved for the server: matrix_user' USING ERRCODE = '42501';
    END IF;
    IF NOT public.matrix_user_valid(NEW.metadata -> 'matrix_user') THEN
        RAISE EXCEPTION 'invalid_matrix_user' USING ERRCODE = '22023';
    END IF;
    -- A reaction's channel_id is filled by a later trigger (populate_reaction_context).
    IF TG_TABLE_NAME = 'messages' THEN
        v_channel := COALESCE(NEW.channel_id,
                              (SELECT t.channel_id FROM public.threads t WHERE t.id = NEW.thread_id));
    ELSE
        SELECT COALESCE(m.channel_id, t.channel_id) INTO v_channel
          FROM public.messages m
          LEFT JOIN public.threads t ON t.id = m.thread_id
         WHERE m.id = NEW.message_id;
    END IF;
    IF public.bridge_channel_platform(NEW.bot_id, v_channel) IS DISTINCT FROM 'matrix' THEN
        RAISE EXCEPTION 'matrix_user is written by the Matrix bridge of the channel' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_matrix_author() FROM PUBLIC, anon, authenticated;

-- Sorts after a_*_client_write_guard (a client's reaction metadata is reset there) and before
-- trg_moderate_message.
DROP TRIGGER IF EXISTS a_messages_matrix_author_guard ON public.messages;
CREATE TRIGGER a_messages_matrix_author_guard
    BEFORE INSERT OR UPDATE OF metadata, bot_id, user_id, channel_id, thread_id ON public.messages
    FOR EACH ROW
    WHEN (NEW.metadata ? 'matrix_user' OR NEW.metadata ? 'bridge_author')
    EXECUTE FUNCTION public.guard_matrix_author();

DROP TRIGGER IF EXISTS a_reactions_matrix_author_guard ON public.reactions;
CREATE TRIGGER a_reactions_matrix_author_guard
    BEFORE INSERT OR UPDATE OF metadata, bot_id, user_id, message_id ON public.reactions
    FOR EACH ROW
    WHEN (NEW.metadata ? 'matrix_user' OR NEW.metadata ? 'bridge_author')
    EXECUTE FUNCTION public.guard_matrix_author();

-- ---------------------------------------------------------------------------
-- Client writes
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_message_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_reserved CONSTANT text[] := ARRAY[
        'type', 'federated', 'ap_id', 'from_domain', 'original_url', 'published',
        'conversation', 'in_reply_to_ap', 'pending_thread_ap_id', 'federated_at',
        'federated_to', 'embeds', 'bot', 'discord_user', 'discord_message_id', 'automod',
        'suppress_embeds', 'webhook', 'remote_author', 'host_ap_id', 'interaction',
        'history_import', 'discord_reply_to', 'bridge_erased', 'matrix_user', 'bridge_author'];
    v_new_meta jsonb;
    v_old_meta jsonb;
    v_key text;
    v_caller uuid;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    v_new_meta := CASE WHEN jsonb_typeof(NEW.metadata) = 'object' THEN NEW.metadata ELSE '{}'::jsonb END;

    IF TG_OP = 'INSERT' THEN
        IF NEW.is_system IS TRUE THEN
            RAISE EXCEPTION 'SYSTEM_MESSAGE_FORBIDDEN: system messages are server-generated'
                USING ERRCODE = '42501';
        END IF;
        IF NEW.bot_id IS NOT NULL THEN
            RAISE EXCEPTION 'bot_id is set by the bot API' USING ERRCODE = '42501';
        END IF;
        IF NEW.is_pinned IS TRUE OR NEW.pinned_at IS NOT NULL OR NEW.pinned_by IS NOT NULL THEN
            RAISE EXCEPTION 'pin fields are set by the server' USING ERRCODE = '42501';
        END IF;
        IF NEW.federation_status IS NOT NULL AND NEW.federation_status <> 'pending' THEN
            RAISE EXCEPTION 'federation_status is set by the server' USING ERRCODE = '42501';
        END IF;
        IF v_new_meta ?| v_reserved THEN
            RAISE EXCEPTION 'metadata key reserved for the server: %',
                (SELECT string_agg(k, ', ') FROM unnest(v_reserved) k WHERE v_new_meta ? k)
                USING ERRCODE = '42501';
        END IF;
        IF v_new_meta ? 'created_via' AND v_new_meta -> 'created_via' IS DISTINCT FROM '"harmony_client"'::jsonb THEN
            RAISE EXCEPTION 'metadata key reserved for the server: created_via' USING ERRCODE = '42501';
        END IF;
        NEW.created_at := now();
        RETURN NEW;
    END IF;

    IF NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.bot_id IS DISTINCT FROM OLD.bot_id
       OR NEW.channel_id IS DISTINCT FROM OLD.channel_id
       OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id
       OR NEW.thread_id IS DISTINCT FROM OLD.thread_id
       OR NEW.reply_to IS DISTINCT FROM OLD.reply_to
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.is_system IS DISTINCT FROM OLD.is_system
       OR NEW.federation_status IS DISTINCT FROM OLD.federation_status
       OR NEW.is_pinned IS DISTINCT FROM OLD.is_pinned
       OR NEW.pinned_at IS DISTINCT FROM OLD.pinned_at
       OR NEW.pinned_by IS DISTINCT FROM OLD.pinned_by THEN
        RAISE EXCEPTION 'message author, placement, system, pin and federation fields are fixed'
            USING ERRCODE = '42501';
    END IF;

    v_old_meta := CASE WHEN jsonb_typeof(OLD.metadata) = 'object' THEN OLD.metadata ELSE '{}'::jsonb END;
    FOREACH v_key IN ARRAY v_reserved LOOP
        IF v_new_meta -> v_key IS DISTINCT FROM v_old_meta -> v_key THEN
            RAISE EXCEPTION 'metadata key reserved for the server: %', v_key USING ERRCODE = '42501';
        END IF;
    END LOOP;

    -- An edit may rebuild the metadata without created_via, but not add or change it.
    IF v_new_meta ? 'created_via' AND v_new_meta -> 'created_via' IS DISTINCT FROM v_old_meta -> 'created_via' THEN
        RAISE EXCEPTION 'metadata key reserved for the server: created_via' USING ERRCODE = '42501';
    END IF;

    IF OLD.is_deleted IS TRUE
       AND (NEW.is_deleted IS NOT TRUE OR NEW.content IS DISTINCT FROM OLD.content) THEN
        RAISE EXCEPTION 'MESSAGE_DELETED: a deleted message cannot be restored or edited'
            USING ERRCODE = '42501';
    END IF;

    v_caller := public.get_current_profile_id();
    IF OLD.is_system IS TRUE OR OLD.user_id IS DISTINCT FROM v_caller THEN
        IF NOT (OLD.is_deleted IS NOT TRUE AND NEW.is_deleted IS TRUE)
           OR NEW.metadata IS DISTINCT FROM OLD.metadata
           OR NEW.encrypted IS DISTINCT FROM OLD.encrypted
           OR NEW.encryption_metadata IS DISTINCT FROM OLD.encryption_metadata
           OR NEW.megolm_session_id IS DISTINCT FROM OLD.megolm_session_id
           OR NEW.megolm_message_index IS DISTINCT FROM OLD.megolm_message_index THEN
            RAISE EXCEPTION 'only the author edits a message; others may soft-delete it'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    IF NEW.content IS NOT DISTINCT FROM OLD.content THEN
        NEW.updated_at := OLD.updated_at;
    END IF;

    RETURN NEW;
END;
$$;


REVOKE ALL ON FUNCTION public.guard_message_client_write() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- AutoMod
-- ---------------------------------------------------------------------------

-- Records one rule match: folds repeats within 30 s into the latest event, posts an
-- alert for a new event, applies the rule's timeout. p_author_key ('discord:<id>' or
-- 'matrix:<mxid>') and p_author_name name a relayed author of the bot p_bot_id; the event keeps
-- them in details and folds per author.
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
                v_author := COALESCE(p_author_name, p_author_key)
                            || CASE WHEN p_author_key LIKE 'matrix:%' THEN ' (Matrix)' ELSE ' (Discord)' END;
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
    -- 'discord:<id>' or 'matrix:<mxid>', and its name, when a bridge bot relays a remote author.
    v_relayed text;
    v_relayed_name text;
    -- automod_recent_activity.user_id of the author: the profile, or md5(v_relayed) as a uuid.
    v_counted uuid := p_msg.user_id;
    -- A slash command follow-up: judged as the invoker's, not counted as a new message of theirs.
    v_followup boolean := false;
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

    -- A bot's answer to a slash command is the invoker's message (20261110400001).
    IF v_author IS NULL AND p_msg.bot_id IS NOT NULL AND NOT v_internal
       AND (p_msg.metadata #>> '{interaction,user_id}')
           ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT p.id INTO v_author
          FROM public.profiles p
         WHERE p.id = (p_msg.metadata #>> '{interaction,user_id}')::uuid;
        v_counted := v_author;
        v_followup := (p_msg.metadata #>> '{interaction,followup}') IS NOT DISTINCT FROM 'true';
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
            -- A Matrix author of a Matrix bridge bot (20261117900002).
            ELSIF NOT v_internal
               AND jsonb_typeof(p_msg.metadata -> 'matrix_user') = 'object'
               AND (p_msg.metadata #>> '{matrix_user,id}') ~ '^@[^:[:space:][:cntrl:]]+:[^[:space:][:cntrl:]]+$'
               AND EXISTS (SELECT 1 FROM public.bots b WHERE b.id = p_msg.bot_id AND b.bridge_platform = 'matrix') THEN
                v_relayed := 'matrix:' || (p_msg.metadata #>> '{matrix_user,id}');
                v_relayed_name := left(regexp_replace(
                    COALESCE(NULLIF(btrim(p_msg.metadata #>> '{matrix_user,username}'), ''),
                             NULLIF(btrim(p_msg.metadata #>> '{matrix_user,display_name}'), ''),
                             p_msg.metadata #>> '{matrix_user,id}'),
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

        v_track_server := p_op = 'INSERT' AND v_counted IS NOT NULL AND NOT v_internal AND NOT v_followup
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
                CONTINUE WHEN p_op <> 'INSERT' OR v_internal OR v_followup;
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
                CONTINUE WHEN p_op <> 'INSERT' OR v_internal OR v_followup OR v_encrypted OR v_raw IS NULL
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
                IF v_new_member IS NULL AND v_relayed LIKE 'matrix:%' THEN
                    -- Matrix carries no account or membership age: the rule does not apply.
                    v_new_member := false;
                ELSIF v_new_member IS NULL AND v_relayed IS NOT NULL THEN
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

REVOKE ALL ON FUNCTION public.automod_check_message(public.messages, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.automod_check_message(public.messages, text, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Display of a relayed author
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.message_notification_sender_json(
  p_user_id uuid,
  p_bot_id uuid,
  p_metadata jsonb,
  p_sender_profile profiles
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  v_bot bots%ROWTYPE;
BEGIN
  IF p_user_id IS NOT NULL THEN
    RETURN notification_actor_json(p_sender_profile);
  END IF;

  IF p_metadata IS NOT NULL AND p_metadata ? 'discord_user' THEN
    RETURN jsonb_build_object(
      'username', p_metadata->'discord_user'->>'username',
      'display_name', COALESCE(
        p_metadata->'discord_user'->>'display_name',
        p_metadata->'discord_user'->>'username'
      ),
      'avatar_url', p_metadata->'discord_user'->>'avatar_url',
      'is_local', false,
      'handle', '@' || COALESCE(p_metadata->'discord_user'->>'username', 'discord')
    );
  END IF;

  IF p_metadata IS NOT NULL AND p_metadata ? 'matrix_user' THEN
    RETURN jsonb_build_object(
      'username', p_metadata->'matrix_user'->>'username',
      'display_name', COALESCE(
        p_metadata->'matrix_user'->>'display_name',
        p_metadata->'matrix_user'->>'username'
      ),
      'avatar_url', p_metadata->'matrix_user'->>'avatar_url',
      'is_local', false,
      'handle', p_metadata->'matrix_user'->>'id'
    );
  END IF;

  IF p_bot_id IS NOT NULL THEN
    SELECT * INTO v_bot FROM bots WHERE id = p_bot_id;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'username', v_bot.username,
        'display_name', COALESCE(v_bot.display_name, v_bot.username),
        'avatar_url', v_bot.avatar_url,
        'is_local', false,
        'handle', '@' || v_bot.username
      );
    END IF;
  END IF;

  RETURN '{}'::jsonb;
END;
$$;

CREATE OR REPLACE FUNCTION public.broadcast_message_reaction_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rec             record;
  v_channel_id      uuid;
  v_conversation_id uuid;
  v_topic           text;
  v_actor           record;
  v_emoji_name      text;
  v_emoji_url       text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_rec := OLD;
  ELSE
    v_rec := NEW;
  END IF;

  v_channel_id := v_rec.channel_id;
  v_conversation_id := v_rec.conversation_id;

  IF v_channel_id IS NULL AND v_conversation_id IS NULL THEN
    SELECT channel_id, conversation_id
      INTO v_channel_id, v_conversation_id
    FROM public.messages WHERE id = v_rec.message_id;
  END IF;

  IF v_conversation_id IS NOT NULL THEN
    v_topic := 'dm-conversation-' || v_conversation_id::text;
  ELSIF v_channel_id IS NOT NULL THEN
    v_topic := 'channel-messages-' || v_channel_id::text;
  ELSE
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT username, display_name, avatar_url
    INTO v_actor
  FROM public.profiles WHERE id = v_rec.user_id;

  -- Custom emoji name/url so a new chip renders correctly even when the
  -- receiver hasn't cached this emoji (e.g. cross-server / federated / bridged).
  IF v_rec.emoji_id IS NOT NULL THEN
    SELECT name, url INTO v_emoji_name, v_emoji_url
    FROM public.emojis WHERE id = v_rec.emoji_id;
  ELSE
    v_emoji_name := COALESCE(v_rec.metadata->>'remote_emoji_name', v_rec.custom_emoji_content);
    v_emoji_url := v_rec.metadata->>'remote_emoji_url';
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type',                 'reaction:' || lower(TG_OP),
      'op',                   TG_OP,
      'reaction_id',          v_rec.id,
      'message_id',           v_rec.message_id,
      'emoji_id',             v_rec.emoji_id,
      'emoji_name',           v_emoji_name,
      'emoji_url',            v_emoji_url,
      'custom_emoji_content', v_rec.custom_emoji_content,
      'user_id',              v_rec.user_id,
      'bot_id',               v_rec.bot_id,
      'metadata',             COALESCE(v_rec.metadata, '{}'::jsonb),
      'username',             COALESCE(
                                v_rec.metadata->'discord_user'->>'username',
                                v_rec.metadata->'matrix_user'->>'username',
                                v_actor.username
                              ),
      'display_name',         COALESCE(
                                v_rec.metadata->'discord_user'->>'display_name',
                                v_rec.metadata->'discord_user'->>'username',
                                v_rec.metadata->'matrix_user'->>'display_name',
                                v_rec.metadata->'matrix_user'->>'username',
                                v_actor.display_name
                              ),
      'avatar_url',           COALESCE(
                                v_rec.metadata->'discord_user'->>'avatar_url',
                                v_rec.metadata->'matrix_user'->>'avatar_url',
                                v_actor.avatar_url
                              )
    ),
    'reaction_event',
    v_topic,
    true
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'broadcast_message_reaction_event failed: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- ---------------------------------------------------------------------------
-- Remote-user privacy
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bridge_platform_author_key(p_platform text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE p_platform WHEN 'discord' THEN 'discord_user' WHEN 'matrix' THEN 'matrix_user' END;
$$;

-- Raises unless the platform is known and the id has the platform's shape.
CREATE OR REPLACE FUNCTION public.bridge_privacy_check_subject(p_platform text, p_remote_user_id text)
RETURNS void
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
BEGIN
    IF public.bridge_platform_author_key(p_platform) IS NULL THEN
        RAISE EXCEPTION 'unsupported_platform' USING ERRCODE = '0A000', DETAIL = COALESCE(p_platform, '');
    END IF;
    IF p_remote_user_id IS NOT NULL AND NOT (
           (p_platform = 'discord' AND p_remote_user_id ~ '^[0-9]{1,20}$')
           OR (p_platform = 'matrix' AND char_length(p_remote_user_id) <= 255
               AND p_remote_user_id ~ '^@[^:[:space:][:cntrl:]]+:[^[:space:][:cntrl:]]+$')) THEN
        RAISE EXCEPTION 'invalid_remote_user' USING ERRCODE = '22023';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_bridge_author_optout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_platform text := CASE WHEN NEW.metadata ? 'discord_user' THEN 'discord' ELSE 'matrix' END;
    v_remote text := CASE WHEN NEW.metadata ? 'discord_user' THEN NEW.metadata #>> '{discord_user,id}'
                          ELSE NEW.metadata #>> '{matrix_user,id}' END;
    v_server uuid;
BEGIN
    IF v_remote IS NULL THEN
        RETURN NEW;
    END IF;
    -- A link refresh or a mirror swap keeps the author's words.
    IF TG_OP = 'UPDATE'
       AND current_setting('harmony.silent_content_update', true) = 'true'
       AND public.message_parts_relinked(OLD.content, NEW.content) THEN
        RETURN NEW;
    END IF;
    SELECT c.server_id INTO v_server
      FROM public.channels c
     WHERE c.id = COALESCE(NEW.channel_id,
                           (SELECT t.channel_id FROM public.threads t WHERE t.id = NEW.thread_id));
    IF v_server IS NULL THEN
        RETURN NEW;
    END IF;
    PERFORM pg_advisory_xact_lock_shared(public.bridge_author_lock_key(v_server, v_platform, v_remote));
    IF EXISTS (
        SELECT 1 FROM public.bridge_remote_optouts o
         WHERE o.server_id = v_server AND o.platform = v_platform AND o.remote_user_id = v_remote) THEN
        RAISE EXCEPTION 'BRIDGE_AUTHOR_OPTED_OUT' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_bridge_author_optout() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_bridge_reaction_optout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_platform text := CASE WHEN NEW.metadata ? 'discord_user' THEN 'discord' ELSE 'matrix' END;
    v_remote text := CASE WHEN NEW.metadata ? 'discord_user' THEN NEW.metadata #>> '{discord_user,id}'
                          ELSE NEW.metadata #>> '{matrix_user,id}' END;
    v_server uuid;
BEGIN
    IF v_remote IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT c.server_id INTO v_server
      FROM public.channels c
     WHERE c.id = COALESCE(NEW.channel_id,
                           (SELECT m.channel_id FROM public.messages m WHERE m.id = NEW.message_id));
    IF v_server IS NULL THEN
        RETURN NEW;
    END IF;
    PERFORM pg_advisory_xact_lock_shared(public.bridge_author_lock_key(v_server, v_platform, v_remote));
    IF EXISTS (
        SELECT 1 FROM public.bridge_remote_optouts o
         WHERE o.server_id = v_server AND o.platform = v_platform AND o.remote_user_id = v_remote) THEN
        RAISE EXCEPTION 'BRIDGE_AUTHOR_OPTED_OUT' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_bridge_reaction_optout() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_messages_bridge_optout_guard ON public.messages;
CREATE TRIGGER a_messages_bridge_optout_guard
    BEFORE INSERT OR UPDATE OF content ON public.messages
    FOR EACH ROW
    WHEN ((NEW.metadata ? 'discord_user' OR NEW.metadata ? 'matrix_user') AND NEW.is_deleted IS NOT TRUE)
    EXECUTE FUNCTION public.guard_bridge_author_optout();

DROP TRIGGER IF EXISTS a_reactions_bridge_optout_guard ON public.reactions;
CREATE TRIGGER a_reactions_bridge_optout_guard
    BEFORE INSERT ON public.reactions
    FOR EACH ROW
    WHEN (NEW.metadata ? 'discord_user' OR NEW.metadata ? 'matrix_user')
    EXECUTE FUNCTION public.guard_bridge_reaction_optout();

CREATE OR REPLACE FUNCTION public.bridge_privacy_erase_core(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text,
    p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
-- A custom plan folds v_key into each statement, which proves the predicate of the platform's
-- partial indexes; a generic plan uses none of them.
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
    v_key text := public.bridge_platform_author_key(p_platform);
    v_path text[] := ARRAY[public.bridge_platform_author_key(p_platform), 'id'];
    v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
    v_channels uuid[];
    v_ids uuid[];
    v_notices uuid[];
    v_parents uuid[];
    v_renamed uuid[];
    v_renamed_more uuid[];
    v_federated uuid[];
    v_found integer;
    v_more boolean;
    v_reactions integer := 0;
    v_events integer := 0;
    v_event_ids uuid[];
    v_alerts integer := 0;
    v_alerts_deleted integer := 0;
    v_prev text := current_setting('harmony.silent_content_update', true);
BEGIN
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);

    IF p_server_id IS NOT NULL THEN
        SELECT COALESCE(array_agg(c.id), ARRAY[]::uuid[]) INTO v_channels
          FROM public.channels c WHERE c.server_id = p_server_id;
    END IF;

    -- One statement per scope, each stating its index's predicate: messages_discord_author_idx
    -- (20261112600002) or messages_matrix_author_idx (20261117900003) for one author,
    -- messages_discord_relayed_channel (20261115800001) or messages_matrix_relayed_channel
    -- (20261117900003) for a server's relayed rows.
    IF p_remote_user_id IS NOT NULL THEN
        SELECT COALESCE(array_agg(s.id), ARRAY[]::uuid[]) INTO v_ids
          FROM (SELECT m.id
                  FROM public.messages m
                 WHERE m.metadata ? v_key
                   AND m.metadata #>> v_path = p_remote_user_id
                   AND (p_server_id IS NULL OR m.channel_id = ANY (v_channels))
                 LIMIT v_limit
                   FOR UPDATE SKIP LOCKED) s;
    ELSIF p_server_id IS NOT NULL THEN
        SELECT COALESCE(array_agg(s.id), ARRAY[]::uuid[]) INTO v_ids
          FROM (SELECT m.id
                  FROM public.messages m
                 WHERE m.metadata ? v_key
                   AND m.channel_id = ANY (v_channels)
                 LIMIT v_limit
                   FOR UPDATE SKIP LOCKED) s;
    ELSE
        SELECT COALESCE(array_agg(s.id), ARRAY[]::uuid[]) INTO v_ids
          FROM (SELECT m.id
                  FROM public.messages m
                 WHERE m.metadata ? v_key
                 LIMIT v_limit
                   FOR UPDATE SKIP LOCKED) s;
    END IF;
    v_found := cardinality(v_ids);

    IF v_found > 0 THEN
        SELECT COALESCE(array_agg(m.id) FILTER (WHERE m.is_system IS TRUE), ARRAY[]::uuid[]),
               COALESCE(array_agg(m.id) FILTER (WHERE m.is_system IS NOT TRUE AND EXISTS (
                            SELECT 1 FROM public.threads t WHERE t.parent_message_id = m.id)), ARRAY[]::uuid[]),
               COALESCE(array_agg(m.id) FILTER (WHERE m.is_system IS NOT TRUE
                            AND m.is_deleted IS NOT TRUE
                            AND m.federation_status IS DISTINCT FROM 'skipped'
                            AND COALESCE(m.metadata ->> 'history_import', '') <> 'true'), ARRAY[]::uuid[])
          INTO v_notices, v_parents, v_federated
          FROM public.messages m
         WHERE m.id = ANY (v_ids);

        -- A thread's title may be the author's text: the threads they started, and the threads on
        -- their messages, whose title the platform fills from the message, are renamed. Two statements,
        -- each on an index (threads.parent_message_id, the primary key); under one OR the planner
        -- read every thread.
        WITH r AS (
            UPDATE public.threads t
               SET name = 'Thread'
             WHERE t.parent_message_id = ANY (v_parents)
            RETURNING t.id)
        SELECT COALESCE(array_agg(r.id), ARRAY[]::uuid[]) INTO v_renamed FROM r;
        WITH r AS (
            UPDATE public.threads t
               SET name = 'Thread'
             WHERE t.id IN (SELECT CASE WHEN m.metadata ->> 'thread_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                        THEN (m.metadata ->> 'thread_id')::uuid END
                              FROM public.messages m
                             WHERE m.id = ANY (v_notices) AND m.metadata ->> 'type' = 'thread_created')
            RETURNING t.id)
        SELECT COALESCE(array_agg(r.id), ARRAY[]::uuid[]) INTO v_renamed_more FROM r;
        v_renamed := v_renamed || v_renamed_more;

        PERFORM set_config('harmony.silent_content_update', 'true', true);
        UPDATE public.messages m
           SET metadata = (m.metadata - v_key)
                          || CASE WHEN m.metadata ->> 'type' = 'thread_created'
                                  THEN jsonb_build_object('thread_name', 'Thread') ELSE '{}'::jsonb END
         WHERE m.id = ANY (v_notices);
        -- The notices of the renamed threads others started repeat the title
        -- (messages_thread_created_notice).
        IF cardinality(v_renamed) > 0 THEN
            UPDATE public.messages m
               SET metadata = m.metadata || jsonb_build_object('thread_name', 'Thread')
             WHERE m.metadata ->> 'type' = 'thread_created'
               AND m.metadata ->> 'thread_id' = ANY (SELECT x::text FROM unnest(v_renamed) x)
               AND m.metadata ->> 'thread_name' IS DISTINCT FROM 'Thread';
        END IF;
        PERFORM set_config('harmony.silent_content_update', COALESCE(v_prev, ''), true);

        -- Notifications quoting an erased message carry its text and its author's name and picture
        -- (idx_notifications_message_id).
        DELETE FROM public.notifications n
         WHERE n.data ? 'message_id'
           AND n.data ->> 'message_id' = ANY (
                   SELECT x::text FROM unnest(v_ids) x WHERE NOT (x = ANY (v_notices)));

        -- Queues the federated Delete of each row that federated.
        UPDATE public.messages m
           SET is_deleted = true
         WHERE m.id = ANY (v_federated);

        UPDATE public.messages m
           SET is_deleted = true,
               content = '[{"type": "text", "text": ""}]'::jsonb,
               metadata = jsonb_build_object('bridge_erased', true)
                          || jsonb_strip_nulls(jsonb_build_object(
                                 'bot', m.metadata -> 'bot',
                                 'created_via', m.metadata -> 'created_via',
                                 'history_import', m.metadata -> 'history_import'))
         WHERE m.id = ANY (v_parents);

        DELETE FROM public.messages m
         WHERE m.id = ANY (v_ids)
           AND NOT (m.id = ANY (v_notices))
           AND NOT (m.id = ANY (v_parents));
    END IF;

    -- SKIP LOCKED passes over a row another transaction holds: a short batch is the last only
    -- when no row of the author is left.
    v_more := v_found >= v_limit;
    IF NOT v_more THEN
        IF p_remote_user_id IS NOT NULL THEN
            v_more := EXISTS (SELECT 1 FROM public.messages m
                               WHERE m.metadata ? v_key
                                 AND m.metadata #>> v_path = p_remote_user_id
                                 AND (p_server_id IS NULL OR m.channel_id = ANY (v_channels)));
        ELSIF p_server_id IS NOT NULL THEN
            v_more := EXISTS (SELECT 1 FROM public.messages m
                               WHERE m.metadata ? v_key AND m.channel_id = ANY (v_channels));
        ELSE
            v_more := EXISTS (SELECT 1 FROM public.messages m WHERE m.metadata ? v_key);
        END IF;
    END IF;

    -- Reactions and AutoMod events once the messages are gone, `limit` of each per call. Each
    -- statement states the predicate of idx_reactions_discord_author (20261115600001) or
    -- idx_reactions_matrix_author (20261117900003), or of idx_automod_events_author_key
    -- (20261115600001), so a batch reads the author's rows only.
    IF NOT v_more THEN
        IF p_remote_user_id IS NOT NULL AND p_server_id IS NOT NULL THEN
            DELETE FROM public.reactions r
             WHERE r.id IN (SELECT r2.id FROM public.reactions r2
                             WHERE r2.metadata ? v_key
                               AND r2.channel_id = ANY (v_channels)
                               AND r2.metadata #>> v_path = p_remote_user_id
                             LIMIT v_limit);
        ELSIF p_remote_user_id IS NOT NULL THEN
            DELETE FROM public.reactions r
             WHERE r.id IN (SELECT r2.id FROM public.reactions r2
                             WHERE r2.metadata ? v_key
                               AND r2.metadata #>> v_path = p_remote_user_id
                             LIMIT v_limit);
        ELSIF p_server_id IS NOT NULL THEN
            DELETE FROM public.reactions r
             WHERE r.id IN (SELECT r2.id FROM public.reactions r2
                             WHERE r2.metadata ? v_key
                               AND r2.channel_id = ANY (v_channels)
                             LIMIT v_limit);
        ELSE
            DELETE FROM public.reactions r
             WHERE r.id IN (SELECT r2.id FROM public.reactions r2
                             WHERE r2.metadata ? v_key
                             LIMIT v_limit);
        END IF;
        GET DIAGNOSTICS v_reactions = ROW_COUNT;

        IF p_remote_user_id IS NOT NULL THEN
            WITH gone AS (
                DELETE FROM public.automod_events e
                 WHERE e.id IN (SELECT e2.id FROM public.automod_events e2
                                 WHERE e2.details ? 'author_key'
                                   AND (p_server_id IS NULL OR e2.server_id = p_server_id)
                                   AND e2.details ->> 'author_key' = p_platform || ':' || p_remote_user_id
                                 LIMIT v_limit)
                RETURNING e.id)
            SELECT COALESCE(array_agg(gone.id), ARRAY[]::uuid[]) INTO v_event_ids FROM gone;
        ELSE
            WITH gone AS (
                DELETE FROM public.automod_events e
                 WHERE e.id IN (SELECT e2.id FROM public.automod_events e2
                                 WHERE e2.details ? 'author_key'
                                   AND (p_server_id IS NULL OR e2.server_id = p_server_id)
                                   AND e2.details ->> 'author_key' LIKE p_platform || ':%'
                                 LIMIT v_limit)
                RETURNING e.id)
            SELECT COALESCE(array_agg(gone.id), ARRAY[]::uuid[]) INTO v_event_ids FROM gone;
        END IF;
        v_events := cardinality(v_event_ids);
        -- The alerts AutoMod posted for these events quote the author's name and text
        -- (automod_post_alert; messages_automod_alert_event). An alert a thread starts on stays as
        -- an empty deleted row, so the thread and its replies stay; the others go.
        IF v_events > 0 THEN
            UPDATE public.messages m
               SET is_deleted = true,
                   content = '[{"type": "text", "text": ""}]'::jsonb,
                   metadata = jsonb_build_object('bridge_erased', true)
             WHERE m.metadata ->> 'type' = 'automod_alert'
               AND m.metadata #>> '{automod,event_id}' = ANY (SELECT x::text FROM unnest(v_event_ids) x)
               AND EXISTS (SELECT 1 FROM public.threads t WHERE t.parent_message_id = m.id);
            GET DIAGNOSTICS v_alerts = ROW_COUNT;
            DELETE FROM public.messages m
             WHERE m.metadata ->> 'type' = 'automod_alert'
               AND m.metadata #>> '{automod,event_id}' = ANY (SELECT x::text FROM unnest(v_event_ids) x);
            GET DIAGNOSTICS v_alerts_deleted = ROW_COUNT;
            v_alerts := v_alerts + v_alerts_deleted;
        END IF;
        v_more := v_reactions >= v_limit OR v_events >= v_limit;

        IF NOT v_more AND p_platform = 'discord' THEN
            UPDATE public.discord_bridge_imports i
               SET requested_by_remote = NULL
             WHERE i.requested_by_remote IS NOT NULL
               AND (p_remote_user_id IS NULL OR i.requested_by_remote ->> 'id' = p_remote_user_id)
               AND (p_server_id IS NULL OR i.bridge_id IN (
                        SELECT b.id FROM public.discord_bridges b WHERE b.server_id = p_server_id));
        END IF;
    END IF;

    -- erased: messages; removed: every row deleted or emptied, reactions, events and alerts too.
    RETURN jsonb_build_object('erased', v_found, 'more', v_more,
                              'removed', v_found + v_reactions + v_events + v_alerts);
END;
$$;


REVOKE ALL ON FUNCTION public.bridge_privacy_erase_core(uuid, text, text, integer)
    FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.bridge_privacy_purge_server(p_server_id uuid, p_platform text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_server_id IS NULL
       OR NOT (public.is_current_user_admin() OR public.can_manage_discord_bridge(p_server_id)) THEN
        RAISE EXCEPTION 'Only a manager of the server can remove its bridged messages' USING ERRCODE = '42501';
    END IF;
    IF p_platform = 'discord' THEN
        PERFORM public.bridge_privacy_stop_imports(p_server_id, 'server_purged');
    END IF;
    RETURN public.bridge_privacy_erase_core(p_server_id, p_platform, NULL, 200);
END;
$$;


CREATE OR REPLACE FUNCTION public.bridge_privacy_purge_instance(p_platform text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Only instance admins can remove every bridged message' USING ERRCODE = '42501';
    END IF;
    -- The instance stops holding Discord content: history import goes off and every unfinished
    -- import fails, or it would bring the content back.
    IF p_platform = 'discord' THEN
        UPDATE public.instance_config c
           SET config_value = '"off"'::jsonb
         WHERE c.config_key = 'bridge_history_import' AND c.config_value IS DISTINCT FROM '"off"'::jsonb;
        PERFORM public.bridge_privacy_stop_imports(NULL, 'instance_purged');
    END IF;
    RETURN public.bridge_privacy_erase_core(NULL, p_platform, NULL, 200);
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
