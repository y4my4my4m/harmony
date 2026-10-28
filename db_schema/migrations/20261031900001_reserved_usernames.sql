-- Reserved local usernames. A new local username is none of the names that read as a mass
-- mention, the instance or its staff (src/utils/usernameRules.ts RESERVED_USERNAMES,
-- self-host/admin.sh reserved_username), compared case-insensitively, and none of the labels of
-- the instance's domain before its last (har.mony.lol: har, mony; localhost: localhost). Checked
-- where 20261027600001 checks the shape: a local row inserted, a local username changed, a row
-- turned local. Rows written before this migration keep their names. Remote usernames are
-- unaffected: `@everyone@other.host` names one account. SECURITY DEFINER: the onboarding insert
-- runs as authenticated, and the domain read does not depend on that role's grants. A NULL
-- is_local reads as local (the column default is true), and a client insert is made local.
--
-- Role mention parts of a channel message, as bot-gateway BotRestAPI.resolveMentionParts leaves
-- a bot's: @here (roleId 'here') and @everyone (the server's is_default role) stay parts only
-- for an author holding MENTION_EVERYONE in the channel, as handle_role_mention_notifications
-- reads it; another role of the server stays as written; a roleId naming no role of the server,
-- and a mass mention without the right, becomes the text `@here`, `@everyone` (the role's name)
-- or `@<roleName>`. In an encrypted message such a part is dropped: the text is in the
-- ciphertext, and only mention parts may follow it. An edit checks only the role ids its stored
-- row lacks. Client writes are checked in every server; other writes (bots, federation) in
-- servers of this instance, a copy of a remote server keeping what its origin sent.
-- Conversations have no roles. Rows written before this migration keep their parts.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- 20261011500001 body; a client insert is local.
CREATE OR REPLACE FUNCTION public.guard_profile_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fixed CONSTANT text[] := ARRAY[
        'federated_id', 'inbox_url', 'outbox_url', 'followers_url', 'following_url',
        'featured_url', 'shared_inbox_url', 'public_key', 'domain', 'is_local',
        'followers_count', 'following_count', 'posts_count',
        'remote_posts_count', 'remote_followers_count', 'remote_following_count',
        'remote_counts_fetched_at',
        'message_count', 'voice_minutes', 'created_at', 'suspended_at', 'suspension_reason',
        'silenced_at', 'silenced_reason', 'last_synced_at', 'last_federation_sync',
        'supported_activities', 'also_known_as', 'moved_to_id', 'moved_to_uri', 'moved_at'];
    v_domain text;
    v_actor text;
    v_old jsonb;
    v_keep jsonb;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.is_local IS FALSE THEN
            RAISE EXCEPTION 'remote profiles arrive through federation' USING ERRCODE = '42501';
        END IF;
        NEW.is_local := true;
        IF NEW.public_key IS NOT NULL OR NEW.featured_url IS NOT NULL OR NEW.shared_inbox_url IS NOT NULL
           OR NEW.suspended_at IS NOT NULL OR NEW.suspension_reason IS NOT NULL
           OR NEW.silenced_at IS NOT NULL OR NEW.silenced_reason IS NOT NULL THEN
            RAISE EXCEPTION 'keys and moderation details are set by the server' USING ERRCODE = '42501';
        END IF;

        SELECT lower(btrim(replace(c.config_value #>> '{}', '"', ''))) INTO v_domain
          FROM public.instance_config c
         WHERE c.config_key = 'domain';
        IF NEW.domain IS NOT NULL AND v_domain IS NOT NULL AND v_domain <> ''
           AND lower(NEW.domain) <> v_domain THEN
            RAISE EXCEPTION 'a local profile is on this instance''s domain' USING ERRCODE = '42501';
        END IF;

        v_actor := 'https://' || NEW.domain || '/users/' || NEW.username;
        IF (NEW.federated_id IS NOT NULL OR NEW.inbox_url IS NOT NULL OR NEW.outbox_url IS NOT NULL
            OR NEW.followers_url IS NOT NULL OR NEW.following_url IS NOT NULL)
           AND (v_actor IS NULL
                OR NEW.federated_id IS DISTINCT FROM v_actor
                OR (NEW.inbox_url IS NOT NULL AND NEW.inbox_url <> v_actor || '/inbox')
                OR (NEW.outbox_url IS NOT NULL AND NEW.outbox_url <> v_actor || '/outbox')
                OR (NEW.followers_url IS NOT NULL AND NEW.followers_url <> v_actor || '/followers')
                OR (NEW.following_url IS NOT NULL AND NEW.following_url <> v_actor || '/following')) THEN
            RAISE EXCEPTION 'actor URLs derive from https://<domain>/users/<username>' USING ERRCODE = '42501';
        END IF;

        NEW.created_at := now();
        NEW.followers_count := 0;
        NEW.following_count := 0;
        NEW.posts_count := 0;
        NEW.remote_posts_count := NULL;
        NEW.remote_followers_count := NULL;
        NEW.remote_following_count := NULL;
        NEW.remote_counts_fetched_at := NULL;
        NEW.message_count := 0;
        NEW.voice_minutes := 0;
        NEW.also_known_as := '{}';
        NEW.moved_to_id := NULL;
        NEW.moved_to_uri := NULL;
        NEW.moved_at := NULL;
        RETURN NEW;
    END IF;

    v_old := to_jsonb(OLD);
    SELECT jsonb_object_agg(k, v_old -> k) INTO v_keep
      FROM unnest(v_fixed) k
     WHERE v_old ? k;
    IF v_keep IS NOT NULL THEN
        NEW := jsonb_populate_record(NEW, v_keep);
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_profile_client_write() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.guard_local_username()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_labels text[];
BEGIN
    IF NEW.is_local IS FALSE OR NEW.username IS NULL THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE'
       AND NEW.username IS NOT DISTINCT FROM OLD.username
       AND OLD.is_local IS NOT FALSE THEN
        RETURN NEW;
    END IF;
    IF NEW.username !~ '^[a-z0-9_]{3,24}$' THEN
        RAISE EXCEPTION 'Usernames are 3 to 24 characters: lowercase letters, digits and _'
            USING ERRCODE = '23514';
    END IF;
    IF lower(NEW.username) = ANY (ARRAY[
        'everyone', 'here', 'system', 'harmony',
        'admin', 'admins', 'administrator',
        'mod', 'mods', 'moderator', 'moderators',
        'staff', 'root'
    ]) THEN
        RAISE EXCEPTION 'The username % is reserved', NEW.username
            USING ERRCODE = '23514';
    END IF;
    -- Host without port, split into labels; the last label is the top-level domain unless it is
    -- the only one.
    v_labels := string_to_array(lower(split_part(public.get_instance_domain(), ':', 1)), '.');
    IF cardinality(v_labels) > 1 THEN
        v_labels := v_labels[1:cardinality(v_labels) - 1];
    END IF;
    IF lower(NEW.username) = ANY (v_labels) THEN
        RAISE EXCEPTION 'The username % is reserved', NEW.username
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_local_username() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_local_username() TO service_role;

DROP TRIGGER IF EXISTS guard_local_username ON public.profiles;
CREATE TRIGGER guard_local_username
    BEFORE INSERT OR UPDATE OF username, is_local ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.guard_local_username();

-- current_setting('role') is the writer's role; current_user here is the definer.
CREATE OR REPLACE FUNCTION public.enforce_message_role_mentions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uuid CONSTANT text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
    v_channel uuid := NEW.channel_id;
    v_server uuid;
    v_local boolean;
    v_stored text[] := '{}';
    v_roles jsonb;
    v_allowed boolean;
    v_out jsonb := '[]'::jsonb;
    v_part jsonb;
    v_id text;
    v_role jsonb;
    v_text text;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.content IS NOT DISTINCT FROM OLD.content THEN
        RETURN NEW;
    END IF;
    IF v_channel IS NULL AND NEW.thread_id IS NOT NULL THEN
        SELECT t.channel_id INTO v_channel FROM public.threads t WHERE t.id = NEW.thread_id;
    END IF;
    SELECT c.server_id, s.is_local_server IS NOT FALSE INTO v_server, v_local
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = v_channel;
    IF v_server IS NULL
       OR (NOT v_local AND current_setting('role', true) NOT IN ('authenticated', 'anon')) THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND jsonb_typeof(OLD.content) = 'array' THEN
        v_stored := ARRAY(SELECT e->>'roleId' FROM jsonb_array_elements(OLD.content) e
                           WHERE e->>'type' = 'role_mention' AND e->>'roleId' IS NOT NULL);
    END IF;

    SELECT COALESCE(jsonb_object_agg(r.id::text, jsonb_build_object('is_default', r.is_default, 'name', r.name)), '{}')
      INTO v_roles
      FROM public.server_roles r
     WHERE r.server_id = v_server
       AND r.id IN (SELECT (e->>'roleId')::uuid
                      FROM jsonb_array_elements(NEW.content) e
                     WHERE e->>'type' = 'role_mention' AND e->>'roleId' ~* v_uuid);

    FOR v_part IN
        SELECT e.part FROM jsonb_array_elements(NEW.content) WITH ORDINALITY AS e(part, idx) ORDER BY e.idx
    LOOP
        v_id := v_part->>'roleId';
        IF v_part->>'type' IS DISTINCT FROM 'role_mention' OR v_id = ANY (v_stored) THEN
            v_out := v_out || jsonb_build_array(v_part);
            CONTINUE;
        END IF;
        v_role := CASE WHEN v_id ~* v_uuid THEN v_roles -> lower(v_id) END;
        IF v_id = 'here' OR (v_role->>'is_default')::boolean THEN
            IF v_allowed IS NULL THEN
                v_allowed := COALESCE(CASE
                    WHEN NEW.bot_id IS NOT NULL
                        THEN public.check_bot_permission(NEW.bot_id, v_server, 'mention_everyone')
                    WHEN NEW.user_id IS NOT NULL
                        THEN public.has_permission(NEW.user_id, v_server, 'MENTION_EVERYONE', v_channel)
                END, false);
            END IF;
            IF v_allowed THEN
                v_out := v_out || jsonb_build_array(v_part);
                CONTINUE;
            END IF;
            v_text := CASE WHEN v_id = 'here' THEN '@here'
                           ELSE '@' || regexp_replace(v_role->>'name', '^@', '') END;
        ELSIF v_role IS NOT NULL THEN
            v_out := v_out || jsonb_build_array(v_part);
            CONTINUE;
        ELSE
            v_text := '@' || COALESCE(NULLIF(btrim(regexp_replace(
                          CASE WHEN jsonb_typeof(v_part->'roleName') = 'string' THEN v_part->>'roleName' END,
                          '^@', '')), ''), 'role');
        END IF;
        IF NEW.encrypted IS NOT TRUE THEN
            v_out := v_out || jsonb_build_array(jsonb_build_object('type', 'text', 'text', v_text));
        END IF;
    END LOOP;

    IF v_out IS DISTINCT FROM NEW.content THEN
        NEW.content := v_out;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_message_role_mentions() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_message_role_mentions() TO service_role;

-- BEFORE triggers fire in name order: after trg_moderate_message, whose
-- block_everyone_without_permission reads the parts as sent, and before
-- trigger_federate_channel_message.
DROP TRIGGER IF EXISTS trg_role_mention_permission ON public.messages;
CREATE TRIGGER trg_role_mention_permission
    BEFORE INSERT OR UPDATE OF content ON public.messages
    FOR EACH ROW
    WHEN (jsonb_typeof(NEW.content) = 'array'
          AND NEW.content @> '[{"type": "role_mention"}]'::jsonb
          AND NEW.is_system IS NOT TRUE)
    EXECUTE FUNCTION public.enforce_message_role_mentions();

COMMIT;
