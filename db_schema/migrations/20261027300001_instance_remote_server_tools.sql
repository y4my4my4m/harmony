-- An instance's tools for chat servers hosted on other instances (copies: servers.is_local_server
-- false). They change what this instance shows and who here takes part, never the server: its
-- host, owner, moderators and members on other instances are untouched (Synapse room block and
-- shutdown, Mastodon domain blocks).
--
--   instance_server_blocks       one row per copy staff have acted on. blocked: no local member,
--                                every join refused, inbound relays dropped by the federation
--                                backend. media_hidden: pictures, videos and files of its messages
--                                render hidden. reason is the block's, read by staff only.
--   instance_server_keepouts     a local profile this instance keeps out of one copy.
--   instance_server_leaves       one row per local member removed by staff or by a block. Job
--                                'federate-instance-leave' sends the member's Leave to the Group
--                                and sets delivered_at; the backend's 60 s sweep requeues rows
--                                undelivered after 5 min.
--   a_user_servers_instance_guard
--                                a local profile does not become a member of a blocked copy or of
--                                one it is kept out of.
--   instance_set_server_blocked, instance_remove_member, instance_lift_keepout,
--   instance_set_server_media_hidden, instance_remote_servers, instance_remote_server_people
--                                instance admins and moderators, copies only; each change is in
--                                admin_audit_log. A moderator does not remove instance staff.
--   instance_media_hidden_servers
--                                copies whose media render hidden, for every signed-in client.
--
-- Notice to a removed member: notifications type 'server_instance_removed', data
-- { server: { id, name, ap_id }, action: 'remove' | 'block', reason }.
--
-- Upgrade (instance_keepouts_from_copy_bans, owner only): server_bans rows and 'banned' memberships
-- of copies were written by the copy's stand-in owner and never reached the host. A banned local
-- profile becomes a keep-out; every such row of a copy is then deleted.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.instance_server_blocks (
    server_id uuid PRIMARY KEY REFERENCES public.servers(id) ON DELETE CASCADE,
    blocked boolean NOT NULL DEFAULT false,
    media_hidden boolean NOT NULL DEFAULT false,
    reason text CONSTRAINT instance_server_blocks_reason_length_check
        CHECK (reason IS NULL OR char_length(reason) <= 500),
    set_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    set_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_instance_server_blocks_set_by ON public.instance_server_blocks (set_by);
COMMENT ON TABLE public.instance_server_blocks IS
    'This instance''s block and media hiding of servers hosted elsewhere; affects only this instance.';

CREATE TABLE IF NOT EXISTS public.instance_server_keepouts (
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    reason text CONSTRAINT instance_server_keepouts_reason_length_check
        CHECK (reason IS NULL OR char_length(reason) <= 512),
    set_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    set_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, profile_id)
);
CREATE INDEX IF NOT EXISTS idx_instance_server_keepouts_profile ON public.instance_server_keepouts (profile_id);
CREATE INDEX IF NOT EXISTS idx_instance_server_keepouts_set_by ON public.instance_server_keepouts (set_by);
COMMENT ON TABLE public.instance_server_keepouts IS
    'Local accounts this instance keeps out of a server hosted elsewhere.';

CREATE TABLE IF NOT EXISTS public.instance_server_leaves (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    reason text NOT NULL CONSTRAINT instance_server_leaves_reason_check
        CHECK (reason IN ('removed', 'blocked')),
    created_at timestamptz NOT NULL DEFAULT now(),
    delivered_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_instance_server_leaves_undelivered
    ON public.instance_server_leaves (created_at) WHERE delivered_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_instance_server_leaves_server ON public.instance_server_leaves (server_id);
CREATE INDEX IF NOT EXISTS idx_instance_server_leaves_profile ON public.instance_server_leaves (profile_id);
COMMENT ON TABLE public.instance_server_leaves IS
    'Local members removed from a server hosted elsewhere by this instance''s staff; their Leave to the Group is delivered from here.';

ALTER TABLE public.instance_server_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instance_server_keepouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instance_server_leaves ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instance_server_blocks_select_staff ON public.instance_server_blocks;
CREATE POLICY instance_server_blocks_select_staff ON public.instance_server_blocks
    FOR SELECT TO authenticated
    USING ((SELECT public.is_current_user_admin_or_mod()));
DROP POLICY IF EXISTS instance_server_blocks_service_role ON public.instance_server_blocks;
CREATE POLICY instance_server_blocks_service_role ON public.instance_server_blocks
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS instance_server_keepouts_select_staff_or_own ON public.instance_server_keepouts;
CREATE POLICY instance_server_keepouts_select_staff_or_own ON public.instance_server_keepouts
    FOR SELECT TO authenticated
    USING (profile_id = (SELECT public.get_current_profile_id())
           OR (SELECT public.is_current_user_admin_or_mod()));
DROP POLICY IF EXISTS instance_server_keepouts_service_role ON public.instance_server_keepouts;
CREATE POLICY instance_server_keepouts_service_role ON public.instance_server_keepouts
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS instance_server_leaves_service_role ON public.instance_server_leaves;
CREATE POLICY instance_server_leaves_service_role ON public.instance_server_leaves
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

REVOKE ALL ON public.instance_server_blocks FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.instance_server_keepouts FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.instance_server_leaves FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.instance_server_blocks TO authenticated;
GRANT SELECT ON public.instance_server_keepouts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instance_server_blocks TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instance_server_keepouts TO service_role;
GRANT SELECT, UPDATE ON public.instance_server_leaves TO service_role;

-- ---------------------------------------------------------------------------
-- Membership guard
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.refuse_instance_kept_out_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = NEW.server_id AND s.is_local_server IS FALSE)
       OR NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = NEW.user_id AND p.is_local IS TRUE) THEN
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM public.instance_server_blocks b
                WHERE b.server_id = NEW.server_id AND b.blocked) THEN
        RAISE EXCEPTION 'SERVER_BLOCKED_HERE: this instance blocked the server'
            USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM public.instance_server_keepouts k
                WHERE k.server_id = NEW.server_id AND k.profile_id = NEW.user_id) THEN
        RAISE EXCEPTION 'KEPT_OUT_HERE: this instance keeps the account out of the server'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.refuse_instance_kept_out_membership() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_user_servers_instance_guard ON public.user_servers;
CREATE TRIGGER a_user_servers_instance_guard
    BEFORE INSERT OR UPDATE OF status, user_id, server_id ON public.user_servers
    FOR EACH ROW EXECUTE FUNCTION public.refuse_instance_kept_out_membership();

-- ---------------------------------------------------------------------------
-- Removal of one local member: membership, notice, Leave
-- ---------------------------------------------------------------------------

-- p_action 'remove' | 'block'. False when the profile held no membership.
CREATE OR REPLACE FUNCTION public.instance_server_member_leaves(
    p_server_id uuid, p_profile_id uuid, p_action text, p_reason text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server record;
    v_leave_id uuid;
BEGIN
    SELECT s.id, s.name, s.ap_id INTO v_server FROM public.servers s WHERE s.id = p_server_id;

    -- A leave of a copy records no membership event: the host records the member's Leave.
    PERFORM set_config('harmony.skip_leave_message', '1', true);
    DELETE FROM public.user_servers WHERE server_id = p_server_id AND user_id = p_profile_id;
    IF NOT FOUND THEN
        RETURN false;
    END IF;

    INSERT INTO public.instance_server_leaves (server_id, profile_id, reason)
    VALUES (p_server_id, p_profile_id, CASE p_action WHEN 'block' THEN 'blocked' ELSE 'removed' END)
    RETURNING id INTO v_leave_id;
    PERFORM public.queue_federation_job(
        'federate-instance-leave', jsonb_build_object('type', 'delete', 'leave_id', v_leave_id));

    INSERT INTO public.notifications (user_id, type, data)
    VALUES (p_profile_id, 'server_instance_removed', jsonb_build_object(
        'server', jsonb_build_object('id', v_server.id, 'name', v_server.name, 'ap_id', v_server.ap_id),
        'action', p_action,
        'reason', p_reason));
    RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- Staff RPCs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.instance_set_server_blocked(
    p_server_id uuid, p_blocked boolean, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor uuid;
    v_is_local boolean;
    v_name text;
    v_was_blocked boolean;
    v_reason text := left(nullif(btrim(p_reason), ''), 500);
    v_member record;
    v_removed integer := 0;
BEGIN
    SELECT p.id INTO v_actor FROM public.profiles p
     WHERE p.id = public.get_current_profile_id()
       AND (p.is_admin IS TRUE OR p.is_moderator IS TRUE) AND p.is_suspended IS NOT TRUE;
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'Instance staff only' USING ERRCODE = '42501';
    END IF;
    IF p_blocked IS NULL THEN
        RAISE EXCEPTION 'p_blocked is required' USING ERRCODE = '22023';
    END IF;

    SELECT s.is_local_server, s.name INTO v_is_local, v_name FROM public.servers s WHERE s.id = p_server_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Server not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_is_local IS NOT FALSE THEN
        RAISE EXCEPTION 'Only a server hosted on another instance is blocked here' USING ERRCODE = '22023';
    END IF;

    SELECT b.blocked INTO v_was_blocked FROM public.instance_server_blocks b
     WHERE b.server_id = p_server_id FOR UPDATE;
    v_was_blocked := COALESCE(v_was_blocked, false);

    INSERT INTO public.instance_server_blocks (server_id, blocked, reason, set_by, set_at)
    VALUES (p_server_id, p_blocked, CASE WHEN p_blocked THEN v_reason END, v_actor, now())
    ON CONFLICT (server_id) DO UPDATE
       SET blocked = EXCLUDED.blocked,
           reason = CASE WHEN EXCLUDED.blocked
                         THEN COALESCE(EXCLUDED.reason, CASE WHEN v_was_blocked THEN instance_server_blocks.reason END)
                    END,
           set_by = EXCLUDED.set_by,
           set_at = EXCLUDED.set_at;

    IF p_blocked THEN
        FOR v_member IN
            SELECT us.user_id
              FROM public.user_servers us
              JOIN public.profiles p ON p.id = us.user_id
             WHERE us.server_id = p_server_id AND p.is_local IS TRUE
        LOOP
            IF public.instance_server_member_leaves(p_server_id, v_member.user_id, 'block', NULL) THEN
                v_removed := v_removed + 1;
            END IF;
        END LOOP;
    END IF;

    IF p_blocked IS DISTINCT FROM v_was_blocked OR v_removed > 0 THEN
        PERFORM public.log_admin_action(v_actor,
            CASE WHEN p_blocked THEN 'instance_server_blocked' ELSE 'instance_server_unblocked' END,
            'server', p_server_id::text,
            jsonb_build_object('name', v_name, 'reason', v_reason, 'members_removed', v_removed));
    END IF;

    RETURN jsonb_build_object('blocked', p_blocked, 'members_removed', v_removed);
END;
$$;

CREATE OR REPLACE FUNCTION public.instance_remove_member(
    p_server_id uuid, p_profile_id uuid, p_keep_out boolean DEFAULT false, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor uuid;
    v_actor_admin boolean;
    v_is_local_server boolean;
    v_name text;
    v_target_local boolean;
    v_target_staff boolean;
    v_target_username text;
    v_reason text := left(nullif(btrim(p_reason), ''), 512);
    v_removed boolean;
    v_kept_out boolean := COALESCE(p_keep_out, false);
BEGIN
    SELECT p.id, p.is_admin IS TRUE INTO v_actor, v_actor_admin FROM public.profiles p
     WHERE p.id = public.get_current_profile_id()
       AND (p.is_admin IS TRUE OR p.is_moderator IS TRUE) AND p.is_suspended IS NOT TRUE;
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'Instance staff only' USING ERRCODE = '42501';
    END IF;

    SELECT s.is_local_server, s.name INTO v_is_local_server, v_name FROM public.servers s WHERE s.id = p_server_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Server not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_is_local_server IS NOT FALSE THEN
        RAISE EXCEPTION 'Only a server hosted on another instance is managed here' USING ERRCODE = '22023';
    END IF;

    SELECT p.is_local IS TRUE, (p.is_admin IS TRUE OR p.is_moderator IS TRUE), p.username
      INTO v_target_local, v_target_staff, v_target_username
      FROM public.profiles p WHERE p.id = p_profile_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT v_target_local THEN
        RAISE EXCEPTION 'Only an account on this instance is removed here' USING ERRCODE = '22023';
    END IF;
    IF p_profile_id = v_actor THEN
        RAISE EXCEPTION 'Cannot remove yourself; leave the server instead' USING ERRCODE = '22023';
    END IF;
    IF v_target_staff AND NOT v_actor_admin THEN
        RAISE EXCEPTION 'Moderators cannot act on instance staff' USING ERRCODE = '42501';
    END IF;

    v_removed := public.instance_server_member_leaves(p_server_id, p_profile_id, 'remove', v_reason);

    IF v_kept_out THEN
        INSERT INTO public.instance_server_keepouts (server_id, profile_id, reason, set_by, set_at)
        VALUES (p_server_id, p_profile_id, v_reason, v_actor, now())
        ON CONFLICT (server_id, profile_id) DO UPDATE
           SET reason = COALESCE(EXCLUDED.reason, instance_server_keepouts.reason),
               set_by = EXCLUDED.set_by,
               set_at = EXCLUDED.set_at;
    END IF;

    IF v_removed OR v_kept_out THEN
        PERFORM public.log_admin_action(v_actor, 'instance_server_member_removed', 'user', p_profile_id::text,
            jsonb_build_object('username', v_target_username, 'server_id', p_server_id, 'server_name', v_name,
                               'reason', v_reason, 'removed', v_removed, 'kept_out', v_kept_out));
    END IF;

    RETURN jsonb_build_object('removed', v_removed, 'kept_out', v_kept_out);
END;
$$;

CREATE OR REPLACE FUNCTION public.instance_lift_keepout(p_server_id uuid, p_profile_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor uuid;
BEGIN
    SELECT p.id INTO v_actor FROM public.profiles p
     WHERE p.id = public.get_current_profile_id()
       AND (p.is_admin IS TRUE OR p.is_moderator IS TRUE) AND p.is_suspended IS NOT TRUE;
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'Instance staff only' USING ERRCODE = '42501';
    END IF;

    DELETE FROM public.instance_server_keepouts WHERE server_id = p_server_id AND profile_id = p_profile_id;
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    PERFORM public.log_admin_action(v_actor, 'instance_server_keepout_lifted', 'user', p_profile_id::text,
        jsonb_build_object('server_id', p_server_id));
    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.instance_set_server_media_hidden(p_server_id uuid, p_hidden boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_actor uuid;
    v_is_local boolean;
    v_name text;
    v_was boolean;
BEGIN
    SELECT p.id INTO v_actor FROM public.profiles p
     WHERE p.id = public.get_current_profile_id()
       AND (p.is_admin IS TRUE OR p.is_moderator IS TRUE) AND p.is_suspended IS NOT TRUE;
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'Instance staff only' USING ERRCODE = '42501';
    END IF;
    IF p_hidden IS NULL THEN
        RAISE EXCEPTION 'p_hidden is required' USING ERRCODE = '22023';
    END IF;

    SELECT s.is_local_server, s.name INTO v_is_local, v_name FROM public.servers s WHERE s.id = p_server_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Server not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_is_local IS NOT FALSE THEN
        RAISE EXCEPTION 'Only a server hosted on another instance is managed here' USING ERRCODE = '22023';
    END IF;

    SELECT b.media_hidden INTO v_was FROM public.instance_server_blocks b WHERE b.server_id = p_server_id FOR UPDATE;
    INSERT INTO public.instance_server_blocks (server_id, media_hidden, set_by, set_at)
    VALUES (p_server_id, p_hidden, v_actor, now())
    ON CONFLICT (server_id) DO UPDATE
       SET media_hidden = EXCLUDED.media_hidden, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at;

    IF p_hidden IS DISTINCT FROM COALESCE(v_was, false) THEN
        PERFORM public.log_admin_action(v_actor,
            CASE WHEN p_hidden THEN 'instance_server_media_hidden' ELSE 'instance_server_media_shown' END,
            'server', p_server_id::text, jsonb_build_object('name', v_name));
    END IF;
    RETURN p_hidden;
END;
$$;

-- Copies with their local member count (accepted local profiles) and this instance's state for
-- them; one copy when p_server_id is given.
CREATE OR REPLACE FUNCTION public.instance_remote_servers(p_server_id uuid DEFAULT NULL)
RETURNS TABLE (
    server_id uuid,
    name text,
    icon text,
    host text,
    ap_id text,
    local_members integer,
    blocked boolean,
    media_hidden boolean,
    reason text,
    set_by uuid,
    set_at timestamptz,
    kept_out integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.is_current_user_admin_or_mod() THEN
        RAISE EXCEPTION 'Instance staff only' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT s.id,
           s.name,
           s.icon,
           COALESCE(nullif(s.host_domain, ''), nullif(s.federation_domain, ''),
                    substring(s.ap_id FROM '^https?://([^/]+)')),
           s.ap_id,
           (SELECT count(*)::integer FROM public.user_servers us
              JOIN public.profiles p ON p.id = us.user_id
             WHERE us.server_id = s.id AND us.status = 'accepted' AND p.is_local IS TRUE),
           COALESCE(b.blocked, false),
           COALESCE(b.media_hidden, false),
           b.reason,
           b.set_by,
           b.set_at,
           (SELECT count(*)::integer FROM public.instance_server_keepouts k WHERE k.server_id = s.id)
      FROM public.servers s
      LEFT JOIN public.instance_server_blocks b ON b.server_id = s.id
     WHERE s.is_local_server IS FALSE
       AND (p_server_id IS NULL OR s.id = p_server_id)
     ORDER BY 6 DESC, lower(s.name);
END;
$$;

-- Local accounts of one copy: members ('accepted', 'pending') and kept-out profiles ('kept_out').
CREATE OR REPLACE FUNCTION public.instance_remote_server_people(p_server_id uuid)
RETURNS TABLE (
    profile_id uuid,
    username text,
    display_name text,
    avatar_url text,
    standing text,
    reason text,
    set_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.is_current_user_admin_or_mod() THEN
        RAISE EXCEPTION 'Instance staff only' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT p.id, p.username, p.display_name, p.avatar_url, us.status, NULL::text, us.created_at
      FROM public.user_servers us
      JOIN public.profiles p ON p.id = us.user_id
     WHERE us.server_id = p_server_id AND p.is_local IS TRUE
       AND us.status IN ('accepted', 'pending')
    UNION ALL
    SELECT p.id, p.username, p.display_name, p.avatar_url, 'kept_out'::text, k.reason, k.set_at
      FROM public.instance_server_keepouts k
      JOIN public.profiles p ON p.id = k.profile_id
     WHERE k.server_id = p_server_id
     ORDER BY 5, 2;
END;
$$;

CREATE OR REPLACE FUNCTION public.instance_media_hidden_servers()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT b.server_id FROM public.instance_server_blocks b WHERE b.media_hidden;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.instance_set_server_blocked(uuid, boolean, text)'::regprocedure,
        'public.instance_remove_member(uuid, uuid, boolean, text)'::regprocedure,
        'public.instance_lift_keepout(uuid, uuid)'::regprocedure,
        'public.instance_set_server_media_hidden(uuid, boolean)'::regprocedure,
        'public.instance_remote_servers(uuid)'::regprocedure,
        'public.instance_remote_server_people(uuid)'::regprocedure,
        'public.instance_media_hidden_servers()'::regprocedure]
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
    END LOOP;

    EXECUTE 'REVOKE ALL ON FUNCTION public.instance_server_member_leaves(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated';
    FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.instance_server_member_leaves(uuid, uuid, text, text) TO %I', grantee);
        END IF;
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Upgrade: bans made on copies
-- ---------------------------------------------------------------------------

-- Keep-outs made; a second run makes none.
CREATE OR REPLACE FUNCTION public.instance_keepouts_from_copy_bans()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_from_bans integer;
    v_from_rows integer;
BEGIN
    PERFORM set_config('harmony.skip_leave_message', '1', true);

    INSERT INTO public.instance_server_keepouts (server_id, profile_id, reason, set_by, set_at)
    SELECT b.server_id, b.user_id, left(b.reason, 512), b.banned_by, b.created_at
      FROM public.server_bans b
      JOIN public.servers s ON s.id = b.server_id AND s.is_local_server IS FALSE
      JOIN public.profiles p ON p.id = b.user_id AND p.is_local IS TRUE
    ON CONFLICT (server_id, profile_id) DO NOTHING;
    GET DIAGNOSTICS v_from_bans = ROW_COUNT;

    INSERT INTO public.instance_server_keepouts (server_id, profile_id, set_at)
    SELECT us.server_id, us.user_id, COALESCE(us.updated_at, us.created_at)
      FROM public.user_servers us
      JOIN public.servers s ON s.id = us.server_id AND s.is_local_server IS FALSE
      JOIN public.profiles p ON p.id = us.user_id AND p.is_local IS TRUE
     WHERE us.status = 'banned'
    ON CONFLICT (server_id, profile_id) DO NOTHING;
    GET DIAGNOSTICS v_from_rows = ROW_COUNT;

    DELETE FROM public.server_bans b
     USING public.servers s
     WHERE s.id = b.server_id AND s.is_local_server IS FALSE;

    DELETE FROM public.user_servers us
     USING public.servers s
     WHERE s.id = us.server_id AND s.is_local_server IS FALSE AND us.status = 'banned';

    RETURN v_from_bans + v_from_rows;
END;
$$;

REVOKE ALL ON FUNCTION public.instance_keepouts_from_copy_bans() FROM PUBLIC, anon, authenticated, service_role;

SELECT public.instance_keepouts_from_copy_bans();

COMMIT;

NOTIFY pgrst, 'reload schema';
