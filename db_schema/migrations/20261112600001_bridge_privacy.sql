-- Bridge privacy: a remote user opts out of a server's bridge, and their relayed rows are erased.
--
-- One table for every bridge platform, keyed (server_id, platform, remote_user_id). platform is
-- 'discord' today; the relayed author of a platform sits in message metadata under
-- bridge_platform_author_key(platform) ('discord' -> discord_user).
--
-- bridge_remote_optouts            source self (the user, through the bridge) | manager | admin.
--                                  Managers of the server and instance admins read its rows.
-- guard_bridge_author_optout()     messages trigger. A relayed row of an opted-out author is refused
--                                  on insert and on a content edit: 23514 BRIDGE_AUTHOR_OPTED_OUT.
--                                  Deletes pass.
-- bridge_privacy_erase_core(server, platform, remote_user, limit) -> {erased, more}
--                                  Up to `limit` rows per call; callers repeat while more is true.
--                                  server NULL is every server, remote_user NULL every remote user.
--                                  No role can call it; the wrappers below run as the owner.
--
-- Erase, per relayed message of the author:
--   a thread's parent      kept as a tombstone: is_deleted, content one empty text part, metadata
--                          reduced to {bridge_erased, bot, created_via, history_import}. Deleting
--                          the row would delete the thread (threads.parent_message_id CASCADE).
--   a system notice        metadata loses the author key; the notice stays.
--   any other row          deleted. A row that federated is soft-deleted first, in the same
--                          transaction, which queues its federated Delete.
-- Plus the author's relayed reactions and their AutoMod events (details.author_key).
-- The delete commits with the row gone, so the gateway's change feed never reads it and no bot is
-- told: the bridge does not delete the original on the remote platform. The tombstone carries
-- metadata.bridge_erased, which the gateway's dispatcher skips.
--
-- Service role (gateway):
--   bridge_privacy_set_optout(server, platform, remote_user, opted_out) -> {opted_out, since, source}
--                                  Opting in removes a self row only; a manager's or admin's stays.
--   bridge_privacy_status(server, platform, remote_user)                -> {opted_out, since, source}
--   bridge_privacy_optout_ids(server, platform)                         -> {version, remote_user_ids}
--   bridge_privacy_erase(server, platform, remote_user, limit)          -> {opted_out, erased, more}
-- Managers (can_manage_discord_bridge) and instance admins:
--   bridge_privacy_remove_remote_user(server, platform, remote_user)    opt out, then erase a batch
--   bridge_privacy_restore_remote_user(server, platform, remote_user)   removes a manager or admin row
--   bridge_privacy_purge_server(server, platform)                       every remote user of the server
-- Instance admins:
--   bridge_privacy_purge_instance(platform)                             every server
--
-- A change of a server's opt-outs moves discord_bridges.updated_at of its bridge: the gateway then
-- pushes BRIDGE_CONFIG_UPDATE, which carries the list's version (bridge_privacy_changed).
--
-- Errors: unsupported_platform 0A000, invalid_remote_user 22023, 42501 for a caller without the right.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.bridge_remote_optouts (
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    platform text NOT NULL,
    remote_user_id text NOT NULL,
    source text NOT NULL DEFAULT 'self',
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, platform, remote_user_id),
    CONSTRAINT bridge_remote_optouts_platform_check CHECK (platform ~ '^[a-z][a-z0-9_]{1,31}$'),
    CONSTRAINT bridge_remote_optouts_remote_user_check
        CHECK (char_length(remote_user_id) BETWEEN 1 AND 255 AND remote_user_id !~ '[[:cntrl:]]'),
    CONSTRAINT bridge_remote_optouts_source_check CHECK (source IN ('self', 'manager', 'admin'))
);

CREATE INDEX IF NOT EXISTS bridge_remote_optouts_created_by_idx
    ON public.bridge_remote_optouts (created_by) WHERE created_by IS NOT NULL;

COMMENT ON TABLE public.bridge_remote_optouts IS
    'Remote users (Discord, ...) whose messages a server''s bridge does not bring in. Written through the bridge_privacy_* functions.';

REVOKE ALL ON public.bridge_remote_optouts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.bridge_remote_optouts TO authenticated;
GRANT ALL ON public.bridge_remote_optouts TO service_role;

ALTER TABLE public.bridge_remote_optouts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bridge_remote_optouts_service_role ON public.bridge_remote_optouts;
CREATE POLICY bridge_remote_optouts_service_role ON public.bridge_remote_optouts
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS bridge_remote_optouts_select_manager ON public.bridge_remote_optouts;
CREATE POLICY bridge_remote_optouts_select_manager ON public.bridge_remote_optouts
    FOR SELECT TO authenticated
    USING ((SELECT public.can_manage_discord_bridge(server_id)) OR (SELECT public.is_current_user_admin()));

-- ---------------------------------------------------------------------------
-- Platform helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bridge_platform_author_key(p_platform text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE p_platform WHEN 'discord' THEN 'discord_user' END;
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
    IF p_remote_user_id IS NOT NULL AND NOT (p_platform = 'discord' AND p_remote_user_id ~ '^[0-9]{1,20}$') THEN
        RAISE EXCEPTION 'invalid_remote_user' USING ERRCODE = '22023';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_privacy_changed(p_server_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    UPDATE public.discord_bridges SET updated_at = now() WHERE server_id = p_server_id;
$$;

REVOKE ALL ON FUNCTION public.bridge_privacy_changed(uuid) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Guard
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_bridge_author_optout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_remote text := NEW.metadata #>> '{discord_user,id}';
    v_server uuid;
BEGIN
    IF v_remote IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT c.server_id INTO v_server
      FROM public.channels c
     WHERE c.id = COALESCE(NEW.channel_id,
                           (SELECT t.channel_id FROM public.threads t WHERE t.id = NEW.thread_id));
    IF v_server IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.bridge_remote_optouts o
         WHERE o.server_id = v_server AND o.platform = 'discord' AND o.remote_user_id = v_remote) THEN
        RAISE EXCEPTION 'BRIDGE_AUTHOR_OPTED_OUT' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_bridge_author_optout() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_messages_bridge_optout_guard ON public.messages;
CREATE TRIGGER a_messages_bridge_optout_guard
    BEFORE INSERT OR UPDATE OF content ON public.messages
    FOR EACH ROW
    WHEN (NEW.metadata ? 'discord_user' AND NEW.is_deleted IS NOT TRUE)
    EXECUTE FUNCTION public.guard_bridge_author_optout();

-- ---------------------------------------------------------------------------
-- Erase
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bridge_privacy_erase_core(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text,
    p_limit integer)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
    v_channels uuid[];
    v_ids uuid[];
    v_notices uuid[];
    v_parents uuid[];
    v_federated uuid[];
    v_found integer;
    v_prev text := current_setting('harmony.silent_content_update', true);
BEGIN
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);

    IF p_server_id IS NOT NULL THEN
        SELECT COALESCE(array_agg(c.id), ARRAY[]::uuid[]) INTO v_channels
          FROM public.channels c WHERE c.server_id = p_server_id;
    END IF;

    -- The expressions repeat messages_discord_author_idx (20261112600002).
    SELECT COALESCE(array_agg(s.id), ARRAY[]::uuid[]) INTO v_ids
      FROM (SELECT m.id
              FROM public.messages m
             WHERE m.metadata ? 'discord_user'
               AND (p_remote_user_id IS NULL OR m.metadata #>> '{discord_user,id}' = p_remote_user_id)
               AND (p_server_id IS NULL OR m.channel_id = ANY (v_channels))
             LIMIT v_limit
               FOR UPDATE SKIP LOCKED) s;
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

        PERFORM set_config('harmony.silent_content_update', 'true', true);
        UPDATE public.messages m
           SET metadata = m.metadata - 'discord_user'
         WHERE m.id = ANY (v_notices);
        PERFORM set_config('harmony.silent_content_update', COALESCE(v_prev, ''), true);

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

    -- Reactions and AutoMod events once the messages are gone: neither has an index on the author.
    IF v_found < v_limit THEN
        DELETE FROM public.reactions r
         WHERE r.metadata ? 'discord_user'
           AND (p_remote_user_id IS NULL OR r.metadata #>> '{discord_user,id}' = p_remote_user_id)
           AND (p_server_id IS NULL OR r.channel_id = ANY (v_channels));

        DELETE FROM public.automod_events e
         WHERE (p_server_id IS NULL OR e.server_id = p_server_id)
           AND CASE WHEN p_remote_user_id IS NULL THEN e.details ->> 'author_key' LIKE 'discord:%'
                    ELSE e.details ->> 'author_key' = 'discord:' || p_remote_user_id END;

        IF p_remote_user_id IS NULL THEN
            UPDATE public.discord_bridge_imports i
               SET requested_by_remote = NULL
             WHERE i.requested_by_remote IS NOT NULL
               AND (p_server_id IS NULL OR i.bridge_id IN (
                        SELECT b.id FROM public.discord_bridges b WHERE b.server_id = p_server_id));
        END IF;
    END IF;

    RETURN jsonb_build_object('erased', v_found, 'more', v_found >= v_limit);
END;
$$;

REVOKE ALL ON FUNCTION public.bridge_privacy_erase_core(uuid, text, text, integer)
    FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Service role
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bridge_privacy_status(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.bridge_remote_optouts;
BEGIN
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);
    SELECT * INTO v_row
      FROM public.bridge_remote_optouts o
     WHERE o.server_id = p_server_id AND o.platform = p_platform AND o.remote_user_id = p_remote_user_id;
    RETURN jsonb_build_object('opted_out', FOUND, 'since', v_row.created_at, 'source', v_row.source);
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_privacy_set_optout(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text,
    p_opted_out boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);
    IF p_remote_user_id IS NULL OR p_opted_out IS NULL THEN
        RAISE EXCEPTION 'invalid_remote_user' USING ERRCODE = '22023';
    END IF;
    IF p_opted_out THEN
        INSERT INTO public.bridge_remote_optouts (server_id, platform, remote_user_id, source)
        VALUES (p_server_id, p_platform, p_remote_user_id, 'self')
        ON CONFLICT (server_id, platform, remote_user_id) DO NOTHING;
    ELSE
        DELETE FROM public.bridge_remote_optouts o
         WHERE o.server_id = p_server_id AND o.platform = p_platform
           AND o.remote_user_id = p_remote_user_id AND o.source = 'self';
    END IF;
    IF FOUND THEN
        PERFORM public.bridge_privacy_changed(p_server_id);
    END IF;
    RETURN public.bridge_privacy_status(p_server_id, p_platform, p_remote_user_id);
END;
$$;

-- version changes with every insert and delete: the row count and the newest created_at.
CREATE OR REPLACE FUNCTION public.bridge_privacy_optout_ids(p_server_id uuid, p_platform text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
               'version', count(*)::text || ':' || COALESCE(floor(extract(epoch FROM max(o.created_at)) * 1000)::bigint, 0)::text,
               'remote_user_ids', COALESCE(jsonb_agg(o.remote_user_id ORDER BY o.remote_user_id), '[]'::jsonb))
      FROM public.bridge_remote_optouts o
     WHERE o.server_id = p_server_id AND o.platform = p_platform;
$$;

CREATE OR REPLACE FUNCTION public.bridge_privacy_erase(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text,
    p_limit integer DEFAULT 200)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);
    IF p_server_id IS NULL OR p_remote_user_id IS NULL THEN
        RAISE EXCEPTION 'invalid_remote_user' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.bridge_remote_optouts (server_id, platform, remote_user_id, source)
    VALUES (p_server_id, p_platform, p_remote_user_id, 'self')
    ON CONFLICT (server_id, platform, remote_user_id) DO NOTHING;
    IF FOUND THEN
        PERFORM public.bridge_privacy_changed(p_server_id);
    END IF;
    RETURN jsonb_build_object('opted_out', true)
           || public.bridge_privacy_erase_core(p_server_id, p_platform, p_remote_user_id, p_limit);
END;
$$;

-- ---------------------------------------------------------------------------
-- Managers and instance admins
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bridge_privacy_remove_remote_user(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_admin boolean := public.is_current_user_admin();
BEGIN
    IF NOT (v_admin OR public.can_manage_discord_bridge(p_server_id)) THEN
        RAISE EXCEPTION 'Only a manager of the server can remove a bridged user' USING ERRCODE = '42501';
    END IF;
    PERFORM public.bridge_privacy_check_subject(p_platform, p_remote_user_id);
    IF p_remote_user_id IS NULL THEN
        RAISE EXCEPTION 'invalid_remote_user' USING ERRCODE = '22023';
    END IF;
    -- A self row keeps its source: the user's own choice outlives the manager's.
    INSERT INTO public.bridge_remote_optouts (server_id, platform, remote_user_id, source, created_by)
    VALUES (p_server_id, p_platform, p_remote_user_id,
            CASE WHEN public.can_manage_discord_bridge(p_server_id) THEN 'manager' ELSE 'admin' END,
            public.get_current_profile_id())
    ON CONFLICT (server_id, platform, remote_user_id) DO NOTHING;
    IF FOUND THEN
        PERFORM public.bridge_privacy_changed(p_server_id);
    END IF;
    RETURN public.bridge_privacy_erase_core(p_server_id, p_platform, p_remote_user_id, 200);
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_privacy_restore_remote_user(
    p_server_id uuid,
    p_platform text,
    p_remote_user_id text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count integer;
BEGIN
    IF NOT (public.is_current_user_admin() OR public.can_manage_discord_bridge(p_server_id)) THEN
        RAISE EXCEPTION 'Only a manager of the server can restore a bridged user' USING ERRCODE = '42501';
    END IF;
    DELETE FROM public.bridge_remote_optouts o
     WHERE o.server_id = p_server_id AND o.platform = p_platform
       AND o.remote_user_id = p_remote_user_id AND o.source <> 'self';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count > 0 THEN
        PERFORM public.bridge_privacy_changed(p_server_id);
    END IF;
    RETURN v_count > 0;
END;
$$;

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
    RETURN public.bridge_privacy_erase_core(NULL, p_platform, NULL, 200);
END;
$$;

DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.bridge_privacy_status(uuid, text, text)',
        'public.bridge_privacy_set_optout(uuid, text, text, boolean)',
        'public.bridge_privacy_optout_ids(uuid, text)',
        'public.bridge_privacy_erase(uuid, text, text, integer)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;

    FOREACH fn IN ARRAY ARRAY[
        'public.bridge_privacy_remove_remote_user(uuid, text, text)',
        'public.bridge_privacy_restore_remote_user(uuid, text, text)',
        'public.bridge_privacy_purge_server(uuid, text)',
        'public.bridge_privacy_purge_instance(text)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    END LOOP;

    FOREACH fn IN ARRAY ARRAY[
        'public.bridge_platform_author_key(text)',
        'public.bridge_privacy_check_subject(text, text)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
