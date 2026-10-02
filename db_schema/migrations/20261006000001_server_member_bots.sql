-- Bots installed in a server, for its member list, and one bot's profile card.
--
-- get_server_bots(server) returns each active bot with an active installation in the server:
-- identity, bot_type, and bot_presence status, custom status and activity. A caller with an
-- accepted membership of the server, or an instance admin, gets the rows; anyone else gets none.
--
-- get_bot_profile(bot) returns one active bot as jsonb: identity, banner, bio, verified and
-- public flags, website, support server, presence, and up to 100 commands by name. NULL unless
-- the bot is public, or the caller owns it, is an instance admin, or holds an accepted
-- membership of a server with an active installation of it. support_server is set only for a
-- public server. Commands are bot_commands name and description, the columns production and a
-- fresh install share.
--
-- SECURITY DEFINER: the table policies do not express these reads. bots shows a member public
-- bots and their own only, so a private bot its owner installed is hidden. bot_server_permissions
-- admits any user_servers row, pending and banned included, and nothing to an instance admin
-- outside the server.
--
-- status is bot_presence.status as written, 'offline' without a row. A gateway process that exits
-- without closing the socket leaves 'online' behind; last_heartbeat_at goes to the client, which
-- applies BOT_PRESENCE_STALE_MS (src/utils/botUtils.ts).
--
-- bot_presence.custom_status exists on production and not on a fresh install; it is added where
-- missing.
--
-- Broadcasts on server-structure:<server>, ids only:
--   bot:insert, bot:update, bot:delete   bot_server_permissions rows; an UPDATE only when
--                                         is_active changes
--   bot:presence                         bot_presence status, custom status or activity changes,
--                                         once per server with an active installation of an
--                                         active bot. A heartbeat writes last_heartbeat_at and
--                                         latency_ms only and sends nothing.
--
-- Ownership. get_server_bots and get_bot_profile are owned by postgres, as on a fresh install;
-- applied as supabase_admin, as on production, CREATE leaves them owned by supabase_admin.
-- postgres reads the tables past their policies as owner or with BYPASSRLS, and holds SELECT; a
-- missing SELECT is granted and the migration fails when either does not hold. The broadcast functions stay owned
-- by the applying role, as the other broadcast_* functions on each instance are.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.bot_presence ADD COLUMN IF NOT EXISTS custom_status text;

-- ---------------------------------------------------------------------------
-- get_server_bots
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_server_bots(p_server_id uuid)
RETURNS TABLE (
    id uuid,
    username text,
    display_name text,
    avatar_url text,
    bot_type text,
    status text,
    custom_status text,
    activity_type text,
    activity_name text,
    last_heartbeat_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT b.id, b.username, b.display_name, b.avatar_url, b.bot_type,
           COALESCE(bp.status, 'offline'), bp.custom_status, bp.activity_type, bp.activity_name,
           bp.last_heartbeat_at
      FROM public.bot_server_permissions i
      JOIN public.bots b ON b.id = i.bot_id
      LEFT JOIN public.bot_presence bp ON bp.bot_id = b.id
     WHERE i.server_id = p_server_id
       AND i.is_active IS TRUE
       AND b.is_active IS TRUE
       AND (EXISTS (SELECT 1 FROM public.user_servers us
                     WHERE us.server_id = p_server_id
                       AND us.user_id = public.get_current_profile_id()
                       AND us.status = 'accepted')
            OR public.is_current_user_admin())
     ORDER BY lower(COALESCE(b.display_name, b.username)), b.id;
$$;

COMMENT ON FUNCTION public.get_server_bots(uuid) IS
    'Active bots installed in a server, with presence; rows for accepted members and instance admins only.';

-- ---------------------------------------------------------------------------
-- get_bot_profile
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_bot_profile(p_bot_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'id', b.id,
        'username', b.username,
        'display_name', b.display_name,
        'avatar_url', b.avatar_url,
        'banner_url', b.banner_url,
        'bio', b.bio,
        'bot_type', b.bot_type,
        'is_verified', COALESCE(b.is_verified, false),
        'is_public', COALESCE(b.is_public, false),
        'website_url', b.website_url,
        'created_at', b.created_at,
        'support_server', (SELECT jsonb_build_object('id', s.id, 'name', s.name, 'icon', s.icon)
                             FROM public.servers s
                            WHERE s.id = b.support_server_id AND s.public IS TRUE),
        'presence', (SELECT jsonb_build_object('status', bp.status,
                                               'custom_status', bp.custom_status,
                                               'activity_type', bp.activity_type,
                                               'activity_name', bp.activity_name,
                                               'last_heartbeat_at', bp.last_heartbeat_at)
                       FROM public.bot_presence bp
                      WHERE bp.bot_id = b.id),
        'commands', COALESCE((SELECT jsonb_agg(jsonb_build_object('name', c.name, 'description', c.description)
                                               ORDER BY lower(c.name), c.name)
                                FROM (SELECT bc.name, bc.description
                                        FROM public.bot_commands bc
                                       WHERE bc.bot_id = b.id
                                       ORDER BY lower(bc.name), bc.name
                                       LIMIT 100) c), '[]'::jsonb)
    )
      FROM public.bots b
     WHERE b.id = p_bot_id
       AND b.is_active IS TRUE
       AND (b.is_public IS TRUE
            OR b.owner_id = public.get_current_profile_id()
            OR public.is_current_user_admin()
            OR EXISTS (SELECT 1
                         FROM public.bot_server_permissions i
                         JOIN public.user_servers us ON us.server_id = i.server_id
                        WHERE i.bot_id = b.id
                          AND i.is_active IS TRUE
                          AND us.user_id = public.get_current_profile_id()
                          AND us.status = 'accepted'));
$$;

COMMENT ON FUNCTION public.get_bot_profile(uuid) IS
    'One active bot for its profile card; NULL unless public, owned, read by an instance admin, or installed in a server the caller belongs to.';

DO $$
DECLARE
    v_tbl text;
    v_fn text;
    v_bypass boolean;
    v_missing text[] := '{}';
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
        RAISE NOTICE 'postgres role absent, get_server_bots and get_bot_profile left with %', current_user;
        RETURN;
    END IF;

    FOREACH v_fn IN ARRAY ARRAY['public.get_server_bots(uuid)', 'public.get_bot_profile(uuid)'] LOOP
        IF (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
             WHERE p.oid = v_fn::regprocedure) <> 'postgres' THEN
            EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', v_fn);
            RAISE NOTICE '% now owned by postgres', v_fn;
        END IF;
    END LOOP;

    SELECT r.rolbypassrls INTO v_bypass FROM pg_roles r WHERE r.rolname = 'postgres';

    FOREACH v_tbl IN ARRAY ARRAY['public.bots', 'public.bot_server_permissions',
                                 'public.bot_presence', 'public.user_servers',
                                 'public.bot_commands', 'public.servers'] LOOP
        IF NOT has_table_privilege('postgres', v_tbl, 'SELECT') THEN
            BEGIN
                EXECUTE format('GRANT SELECT ON %s TO postgres', v_tbl);
                RAISE NOTICE 'granted SELECT on % to postgres', v_tbl;
            EXCEPTION WHEN insufficient_privilege THEN
                NULL;
            END;
        END IF;
        IF NOT has_table_privilege('postgres', v_tbl, 'SELECT') THEN
            v_missing := v_missing || format('SELECT on %s', v_tbl);
        END IF;
        IF NOT v_bypass
           AND (SELECT pg_get_userbyid(c.relowner) FROM pg_class c WHERE c.oid = v_tbl::regclass) <> 'postgres' THEN
            v_missing := v_missing || format('owner or BYPASSRLS for %s', v_tbl);
        END IF;
    END LOOP;

    FOREACH v_fn IN ARRAY ARRAY['public.get_current_profile_id()', 'public.is_current_user_admin()'] LOOP
        IF NOT has_function_privilege('postgres', v_fn, 'EXECUTE') THEN
            BEGIN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO postgres', v_fn);
                RAISE NOTICE 'granted EXECUTE on % to postgres', v_fn;
            EXCEPTION WHEN insufficient_privilege THEN
                NULL;
            END;
        END IF;
        IF NOT has_function_privilege('postgres', v_fn, 'EXECUTE') THEN
            v_missing := v_missing || format('EXECUTE on %s', v_fn);
        END IF;
    END LOOP;

    IF cardinality(v_missing) > 0 THEN
        RAISE EXCEPTION 'postgres lacks what get_server_bots and get_bot_profile read with: %',
            array_to_string(v_missing, ', ')
            USING HINT = 'Apply this migration as supabase_admin.';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.get_server_bots(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_server_bots(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.get_bot_profile(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_bot_profile(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Broadcasts
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.broadcast_bot_installation_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server uuid;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.is_active IS NOT DISTINCT FROM NEW.is_active THEN
        RETURN NULL;
    END IF;

    v_server := COALESCE(NEW.server_id, OLD.server_id);
    PERFORM realtime.send(
        jsonb_build_object(
            'type', 'bot:' || lower(TG_OP),
            'server_id', v_server,
            'bot_id', COALESCE(NEW.bot_id, OLD.bot_id)
        ),
        'server_event',
        'server-structure:' || v_server::text,
        true
    );
    RETURN NULL;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'broadcast_bot_installation_change failed: %', SQLERRM;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.broadcast_bot_presence_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server uuid;
BEGIN
    IF TG_OP = 'UPDATE'
       AND OLD.status IS NOT DISTINCT FROM NEW.status
       AND OLD.custom_status IS NOT DISTINCT FROM NEW.custom_status
       AND OLD.activity_type IS NOT DISTINCT FROM NEW.activity_type
       AND OLD.activity_name IS NOT DISTINCT FROM NEW.activity_name THEN
        RETURN NULL;
    END IF;

    FOR v_server IN
        SELECT i.server_id
          FROM public.bot_server_permissions i
          JOIN public.bots b ON b.id = i.bot_id
         WHERE i.bot_id = NEW.bot_id
           AND i.is_active IS TRUE
           AND b.is_active IS TRUE
    LOOP
        PERFORM realtime.send(
            jsonb_build_object('type', 'bot:presence', 'server_id', v_server, 'bot_id', NEW.bot_id),
            'server_event',
            'server-structure:' || v_server::text,
            true
        );
    END LOOP;
    RETURN NULL;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'broadcast_bot_presence_change failed: %', SQLERRM;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS broadcast_bot_installation_change ON public.bot_server_permissions;
CREATE TRIGGER broadcast_bot_installation_change
    AFTER INSERT OR DELETE OR UPDATE OF is_active ON public.bot_server_permissions
    FOR EACH ROW EXECUTE FUNCTION public.broadcast_bot_installation_change();

DROP TRIGGER IF EXISTS broadcast_bot_presence_change ON public.bot_presence;
CREATE TRIGGER broadcast_bot_presence_change
    AFTER INSERT OR UPDATE OF status, custom_status, activity_type, activity_name ON public.bot_presence
    FOR EACH ROW EXECUTE FUNCTION public.broadcast_bot_presence_change();

DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOREACH fn IN ARRAY ARRAY['public.broadcast_bot_installation_change()'::regprocedure,
                              'public.broadcast_bot_presence_change()'::regprocedure] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
