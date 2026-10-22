-- Private categories: category permission templates, synced channels, and category rows only for
-- those who can see a channel in them.
--
-- channel_category_permission_overrides: a category's permission overrides, the shape of
-- channel_permission_overrides keyed by category_id. A template: effective permissions stay on
-- channel overrides alone (get_user_permissions, has_permission, channels RLS unchanged). A row
-- carries a nonzero allow or deny with no bit in both, so a template is a canonical set.
--
-- A channel is synced with its category when its overrides, rows with a zero allow and deny
-- ignored, equal the category's as a set of (target_type, role_id, user_id, allow, deny). Derived,
-- as Discord derives it, never stored: channel overrides have writers besides these functions
-- (the channel editor's direct table writes, create_channel, server templates, the bot API), and
-- a stored flag drifts from what it describes on every one of them.
--   channel_permissions_synced(channel)   true, false, or NULL for a channel in no category
--   set_category_permissions(category, overrides)
--                                         replaces the template; every channel that was synced
--                                         before the call receives the new template
--   sync_channel_permissions(channel)     the channel's overrides become its category's
--   a channel inserted in a category      receives the template (AFTER INSERT on channels), so
--                                         create_channel's p_category copies it; p_private then
--                                         adds the @everyone VIEW_CHANNEL deny and role allows
-- Moving a channel to another category writes no override.
--
-- Client writes go through set_category_permissions and sync_channel_permissions, SECURITY
-- DEFINER, with the checks the channel_permission_overrides policies and guard_override_grants
-- apply to direct writes: the server owner or an instance admin; else MANAGE_ROLES or
-- MANAGE_CHANNELS (on the server for a template, on the channel for every channel written) and
-- no allowed bit the caller lacks there.
-- Permissions are read before anything is written. Remote servers' categories take no template.
--
-- Category rows (channel_categories_select_member) reach the server owner, members holding
-- MANAGE_CHANNELS (ADMINISTRATOR included), instance admins, and members who can view a channel
-- in the category. An empty or all-hidden category's name reaches no one else:
--   broadcast_category_change     a category every member does not see (no channel open to
--                                 every member, deletes included) goes out as ids, flagged
--                                 restricted, as broadcast_channel_change does for channels
--   notification_settings_state   lists the categories the member sees
--   federation_category_recipients
--                                 remote instances whose members view a channel in the category
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.channel_category_permission_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    category_id uuid NOT NULL REFERENCES public.channel_categories(id) ON DELETE CASCADE,
    target_type text NOT NULL,
    role_id uuid REFERENCES public.server_roles(id) ON DELETE CASCADE,
    user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
    allow_permissions bigint DEFAULT 0 NOT NULL,
    deny_permissions bigint DEFAULT 0 NOT NULL,
    CONSTRAINT channel_category_permission_overrides_type_check
        CHECK (target_type IN ('role', 'user')),
    CONSTRAINT channel_category_permission_overrides_target_check CHECK (
        (target_type = 'role' AND role_id IS NOT NULL AND user_id IS NULL) OR
        (target_type = 'user' AND user_id IS NOT NULL AND role_id IS NULL)),
    CONSTRAINT channel_category_permission_overrides_bits_check CHECK (
        allow_permissions >= 0 AND deny_permissions >= 0
        AND (allow_permissions & deny_permissions) = 0
        AND (allow_permissions <> 0 OR deny_permissions <> 0))
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_ccpo_category_role
    ON public.channel_category_permission_overrides (category_id, role_id) WHERE user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ccpo_category_user
    ON public.channel_category_permission_overrides (category_id, user_id) WHERE role_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_ccpo_role ON public.channel_category_permission_overrides (role_id);
CREATE INDEX IF NOT EXISTS idx_ccpo_user ON public.channel_category_permission_overrides (user_id);

COMMENT ON TABLE public.channel_category_permission_overrides IS
    'A category''s permission overrides: the template set_category_permissions syncs onto its synced channels. Effective permissions read channel overrides only.';

ALTER TABLE public.channel_category_permission_overrides ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.channel_category_permission_overrides FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.channel_category_permission_overrides TO authenticated;
GRANT ALL ON public.channel_category_permission_overrides TO service_role;

-- ---------------------------------------------------------------------------
-- Category visibility
-- ---------------------------------------------------------------------------

-- Servers whose categories the caller manages: owned, or an accepted membership whose
-- server-level mask (@everyone OR the member's roles, as get_user_permissions) holds
-- ADMINISTRATOR (bit 0) or MANAGE_CHANNELS (bit 2).
CREATE OR REPLACE FUNCTION public.current_user_channel_manager_server_ids()
RETURNS SETOF uuid
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
    SELECT s.id
      FROM public.servers s
     WHERE s.owner = v_me
    UNION
    SELECT us.server_id
      FROM public.user_servers us
      LEFT JOIN LATERAL (
          SELECT ev.permissions
            FROM public.server_roles ev
           WHERE ev.server_id = us.server_id AND ev.is_default = true
           LIMIT 1
      ) ev ON true
      LEFT JOIN LATERAL (
          SELECT bit_or(sr.permissions) AS mask
            FROM public.user_roles ur
            JOIN public.server_roles sr ON sr.id = ur.role_id
           WHERE ur.user_id = v_me AND ur.server_id = us.server_id
      ) rm ON true
     WHERE us.user_id = v_me
       AND us.status = 'accepted'
       AND ((COALESCE(ev.permissions, 0) | COALESCE(rm.mask, 0)) & 5) <> 0;
END;
$$;

REVOKE ALL ON FUNCTION public.current_user_channel_manager_server_ids() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_channel_manager_server_ids() TO authenticated, service_role;

-- Categories holding a channel the caller can view.
CREATE OR REPLACE FUNCTION public.current_user_visible_category_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT DISTINCT c.category
      FROM public.channels c
     WHERE c.category IS NOT NULL
       AND c.id IN (SELECT public.current_user_viewable_channel_ids());
$$;

REVOKE ALL ON FUNCTION public.current_user_visible_category_ids() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_visible_category_ids() TO authenticated, service_role;

-- Policies replaced below are removed by command, whatever their name on this instance.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT p.tablename, p.policyname
          FROM pg_policies p
         WHERE p.schemaname = 'public'
           AND ((p.tablename = 'channel_categories' AND p.cmd = 'SELECT'
                 AND p.policyname <> 'channel_categories_select_member')
             OR (p.tablename = 'channel_category_permission_overrides'
                 AND p.policyname <> 'channel_category_permission_overrides_select_member'))
    LOOP
        EXECUTE format('DROP POLICY %I ON public.%I', r.policyname, r.tablename);
        RAISE NOTICE 'dropped policy % on %', r.policyname, r.tablename;
    END LOOP;
END;
$$;

-- The manager branch names servers, not categories, so a category inserted by the same statement
-- (INSERT ... RETURNING) passes it.
DROP POLICY IF EXISTS channel_categories_select_member ON public.channel_categories;
CREATE POLICY channel_categories_select_member ON public.channel_categories FOR SELECT TO authenticated
    USING (server_id IN (SELECT public.current_user_channel_manager_server_ids())
           OR id IN (SELECT public.current_user_visible_category_ids())
           OR (SELECT public.is_current_user_admin()));

DROP POLICY IF EXISTS channel_category_permission_overrides_select_member ON public.channel_category_permission_overrides;
CREATE POLICY channel_category_permission_overrides_select_member ON public.channel_category_permission_overrides
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.channel_categories k
                    WHERE k.id = channel_category_permission_overrides.category_id
                      AND (k.server_id IN (SELECT public.current_user_channel_manager_server_ids())
                           OR k.id IN (SELECT public.current_user_visible_category_ids())
                           OR (SELECT public.is_current_user_admin()))));

-- ---------------------------------------------------------------------------
-- Sync
-- ---------------------------------------------------------------------------

-- Runs as the caller: a member compares the rows their RLS shows them, which for a channel they
-- view and its category is every row.
CREATE OR REPLACE FUNCTION public.channel_permissions_synced(p_channel_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
    SELECT CASE WHEN c.category IS NULL THEN NULL ELSE NOT EXISTS (
        (SELECT o.target_type, o.role_id, o.user_id,
                COALESCE(o.allow_permissions, 0), COALESCE(o.deny_permissions, 0)
           FROM public.channel_permission_overrides o
          WHERE o.channel_id = c.id
            AND (COALESCE(o.allow_permissions, 0) <> 0 OR COALESCE(o.deny_permissions, 0) <> 0)
         EXCEPT
         SELECT t.target_type, t.role_id, t.user_id, t.allow_permissions, t.deny_permissions
           FROM public.channel_category_permission_overrides t
          WHERE t.category_id = c.category)
        UNION ALL
        (SELECT t.target_type, t.role_id, t.user_id, t.allow_permissions, t.deny_permissions
           FROM public.channel_category_permission_overrides t
          WHERE t.category_id = c.category
         EXCEPT
         SELECT o.target_type, o.role_id, o.user_id,
                COALESCE(o.allow_permissions, 0), COALESCE(o.deny_permissions, 0)
           FROM public.channel_permission_overrides o
          WHERE o.channel_id = c.id)
    ) END
      FROM public.channels c
     WHERE c.id = p_channel_id;
$$;

COMMENT ON FUNCTION public.channel_permissions_synced(uuid) IS
    'Whether a channel''s overrides equal its category''s (rows with zero allow and deny ignored); NULL for a channel in no category.';

REVOKE ALL ON FUNCTION public.channel_permissions_synced(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.channel_permissions_synced(uuid) TO authenticated, service_role;

-- Writes p_category_id's template onto p_channel_id: rows for targets absent from the template
-- are deleted, changed rows updated, missing rows inserted. No check; callers check.
CREATE OR REPLACE FUNCTION public.apply_category_permissions(p_channel_id uuid, p_category_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    DELETE FROM public.channel_permission_overrides o
     WHERE o.channel_id = p_channel_id
       AND NOT EXISTS (
            SELECT 1 FROM public.channel_category_permission_overrides t
             WHERE t.category_id = p_category_id
               AND t.role_id IS NOT DISTINCT FROM o.role_id
               AND t.user_id IS NOT DISTINCT FROM o.user_id);

    UPDATE public.channel_permission_overrides o
       SET allow_permissions = t.allow_permissions,
           deny_permissions = t.deny_permissions,
           updated_at = now()
      FROM public.channel_category_permission_overrides t
     WHERE o.channel_id = p_channel_id
       AND t.category_id = p_category_id
       AND t.role_id IS NOT DISTINCT FROM o.role_id
       AND t.user_id IS NOT DISTINCT FROM o.user_id
       AND (COALESCE(o.allow_permissions, 0), COALESCE(o.deny_permissions, 0))
           IS DISTINCT FROM (t.allow_permissions, t.deny_permissions);

    INSERT INTO public.channel_permission_overrides
           (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
    SELECT p_channel_id, t.target_type, t.role_id, t.user_id, t.allow_permissions, t.deny_permissions
      FROM public.channel_category_permission_overrides t
     WHERE t.category_id = p_category_id
       AND NOT EXISTS (
            SELECT 1 FROM public.channel_permission_overrides o
             WHERE o.channel_id = p_channel_id
               AND o.role_id IS NOT DISTINCT FROM t.role_id
               AND o.user_id IS NOT DISTINCT FROM t.user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.apply_category_permissions(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_category_permissions(uuid, uuid) TO service_role;

-- Raises 42501 unless the caller may write p_channel_id's overrides and grant every bit the
-- template allows that the channel's row for the same target does not. The caller's permissions
-- in the channel are read now, before any write.
CREATE OR REPLACE FUNCTION public.assert_category_template_writable(p_channel_id uuid, p_category_id uuid,
                                                                    p_template jsonb DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_server uuid;
    v_name text;
    v_perms jsonb;
    v_bits bigint;
BEGIN
    SELECT c.server_id, c.name INTO v_server, v_name FROM public.channels c WHERE c.id = p_channel_id;
    IF v_server IS NULL OR public.caller_outranks_all(v_server) THEN
        RETURN;
    END IF;
    IF NOT public.has_permission(v_me, v_server, 'MANAGE_ROLES', p_channel_id)
       AND NOT public.has_permission(v_me, v_server, 'MANAGE_CHANNELS', p_channel_id) THEN
        RAISE EXCEPTION 'CHANNEL_NOT_MANAGEABLE: you cannot change the permissions of #%', v_name
            USING ERRCODE = '42501';
    END IF;

    v_perms := public.get_user_permissions(v_me, v_server, p_channel_id);
    SELECT COALESCE(bit_or(t.allow & ~COALESCE(o.allow_permissions, 0)), 0) INTO v_bits
      FROM (
          SELECT x.role_id, x.user_id, x.allow_permissions AS allow
            FROM jsonb_to_recordset(p_template) AS x(role_id uuid, user_id uuid, allow_permissions bigint)
           WHERE p_template IS NOT NULL
          UNION ALL
          SELECT t.role_id, t.user_id, t.allow_permissions
            FROM public.channel_category_permission_overrides t
           WHERE p_template IS NULL AND t.category_id = p_category_id
      ) t
      LEFT JOIN public.channel_permission_overrides o
        ON o.channel_id = p_channel_id
       AND o.role_id IS NOT DISTINCT FROM t.role_id
       AND o.user_id IS NOT DISTINCT FROM t.user_id;
    PERFORM public.assert_grantable_bits(v_perms, v_bits);
END;
$$;

REVOKE ALL ON FUNCTION public.assert_category_template_writable(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_category_template_writable(uuid, uuid, jsonb) TO service_role;

-- A channel inserted in a category receives the category's template. As definer, the rows pass
-- the client-write grant guard: the template was written under the checks above.
CREATE OR REPLACE FUNCTION public.channel_inherits_category_permissions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.channel_category_permission_overrides t
                WHERE t.category_id = NEW.category) THEN
        PERFORM public.apply_category_permissions(NEW.id, NEW.category);
    END IF;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.channel_inherits_category_permissions() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_channels_inherit_category_permissions ON public.channels;
CREATE TRIGGER a_channels_inherit_category_permissions
    AFTER INSERT ON public.channels
    FOR EACH ROW
    WHEN (NEW.category IS NOT NULL)
    EXECUTE FUNCTION public.channel_inherits_category_permissions();

-- p_overrides: [{target_type 'role'|'user', role_id | user_id, allow_permissions, deny_permissions}],
-- bit masks as numbers or decimal strings. Replaces the category's template; returns
-- {category_id, synced_channel_ids}: the channels synced before the call, now carrying the new
-- template.
CREATE OR REPLACE FUNCTION public.set_category_permissions(p_category_id uuid, p_overrides jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_server uuid;
    v_local boolean;
    v_outranks boolean;
    v_rows jsonb := '[]'::jsonb;
    v_seen text[] := '{}';
    v_el jsonb;
    v_type text;
    v_role uuid;
    v_user uuid;
    v_allow bigint;
    v_deny bigint;
    v_key text;
    v_bits bigint;
    v_synced uuid[];
    v_channel uuid;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT k.server_id, s.is_local_server INTO v_server, v_local
      FROM public.channel_categories k
      JOIN public.servers s ON s.id = k.server_id
     WHERE k.id = p_category_id;
    IF v_server IS NULL THEN
        RAISE EXCEPTION 'CATEGORY_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF v_local IS FALSE THEN
        RAISE EXCEPTION 'CATEGORY_REMOTE: a remote server''s category takes no permissions here'
            USING ERRCODE = '22023';
    END IF;

    v_outranks := public.caller_outranks_all(v_server);
    IF NOT v_outranks
       AND NOT public.has_permission(v_me, v_server, 'MANAGE_ROLES')
       AND NOT public.has_permission(v_me, v_server, 'MANAGE_CHANNELS') THEN
        RAISE EXCEPTION 'CATEGORY_NOT_MANAGEABLE: MANAGE_CHANNELS or MANAGE_ROLES required'
            USING ERRCODE = '42501';
    END IF;

    IF jsonb_typeof(p_overrides) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'overrides is an array' USING ERRCODE = '22023';
    END IF;

    FOR v_el IN SELECT e.value FROM jsonb_array_elements(p_overrides) e LOOP
        IF jsonb_typeof(v_el) IS DISTINCT FROM 'object' THEN
            RAISE EXCEPTION 'an override is an object' USING ERRCODE = '22023';
        END IF;
        v_type := v_el->>'target_type';
        BEGIN
            v_role := NULLIF(v_el->>'role_id', '')::uuid;
            v_user := NULLIF(v_el->>'user_id', '')::uuid;
            v_allow := COALESCE(NULLIF(v_el->>'allow_permissions', ''), '0')::bigint;
            v_deny := COALESCE(NULLIF(v_el->>'deny_permissions', ''), '0')::bigint;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            RAISE EXCEPTION 'an override names a uuid target and integer masks' USING ERRCODE = '22023';
        END;

        IF v_type = 'role' THEN
            IF v_role IS NULL OR v_user IS NOT NULL THEN
                RAISE EXCEPTION 'a role override names role_id alone' USING ERRCODE = '22023';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM public.server_roles r
                            WHERE r.id = v_role AND r.server_id = v_server) THEN
                RAISE EXCEPTION 'Role % is not a role of this server', v_role USING ERRCODE = '22023';
            END IF;
            v_key := 'role:' || v_role;
        ELSIF v_type = 'user' THEN
            IF v_user IS NULL OR v_role IS NOT NULL THEN
                RAISE EXCEPTION 'a member override names user_id alone' USING ERRCODE = '22023';
            END IF;
            IF NOT EXISTS (SELECT 1 FROM public.user_servers us
                            WHERE us.user_id = v_user AND us.server_id = v_server AND us.status = 'accepted')
               AND NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = v_server AND s.owner = v_user) THEN
                RAISE EXCEPTION 'User % is not a member of this server', v_user USING ERRCODE = '22023';
            END IF;
            v_key := 'user:' || v_user;
        ELSE
            RAISE EXCEPTION 'target_type is role or user' USING ERRCODE = '22023';
        END IF;

        IF v_allow < 0 OR v_deny < 0 OR (v_allow & v_deny) <> 0 THEN
            RAISE EXCEPTION 'allow and deny are non-negative masks with no bit in both' USING ERRCODE = '22023';
        END IF;
        IF v_key = ANY (v_seen) THEN
            RAISE EXCEPTION 'one override per role or member' USING ERRCODE = '22023';
        END IF;
        v_seen := v_seen || v_key;
        CONTINUE WHEN v_allow = 0 AND v_deny = 0;

        v_rows := v_rows || jsonb_build_object(
            'target_type', v_type, 'role_id', v_role, 'user_id', v_user,
            'allow_permissions', v_allow, 'deny_permissions', v_deny);
    END LOOP;

    -- Allowed bits new to the template, against the caller's server permissions.
    IF NOT v_outranks THEN
        SELECT COALESCE(bit_or(x.allow_permissions & ~COALESCE(t.allow_permissions, 0)), 0) INTO v_bits
          FROM jsonb_to_recordset(v_rows) AS x(role_id uuid, user_id uuid, allow_permissions bigint)
          LEFT JOIN public.channel_category_permission_overrides t
            ON t.category_id = p_category_id
           AND t.role_id IS NOT DISTINCT FROM x.role_id
           AND t.user_id IS NOT DISTINCT FROM x.user_id;
        PERFORM public.assert_grantable_bits(public.get_user_permissions(v_me, v_server), v_bits);
    END IF;

    SELECT COALESCE(array_agg(c.id ORDER BY c."order", c.id), '{}'::uuid[]) INTO v_synced
      FROM public.channels c
     WHERE c.category = p_category_id
       AND public.channel_permissions_synced(c.id) IS TRUE;

    FOREACH v_channel IN ARRAY v_synced LOOP
        PERFORM public.assert_category_template_writable(v_channel, p_category_id, v_rows);
    END LOOP;

    DELETE FROM public.channel_category_permission_overrides t
     WHERE t.category_id = p_category_id
       AND NOT EXISTS (
            SELECT 1 FROM jsonb_to_recordset(v_rows) AS x(role_id uuid, user_id uuid)
             WHERE x.role_id IS NOT DISTINCT FROM t.role_id
               AND x.user_id IS NOT DISTINCT FROM t.user_id);

    UPDATE public.channel_category_permission_overrides t
       SET allow_permissions = x.allow_permissions,
           deny_permissions = x.deny_permissions,
           updated_at = now()
      FROM jsonb_to_recordset(v_rows) AS x(role_id uuid, user_id uuid, allow_permissions bigint, deny_permissions bigint)
     WHERE t.category_id = p_category_id
       AND x.role_id IS NOT DISTINCT FROM t.role_id
       AND x.user_id IS NOT DISTINCT FROM t.user_id
       AND (t.allow_permissions, t.deny_permissions) IS DISTINCT FROM (x.allow_permissions, x.deny_permissions);

    INSERT INTO public.channel_category_permission_overrides
           (category_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
    SELECT p_category_id, x.target_type, x.role_id, x.user_id, x.allow_permissions, x.deny_permissions
      FROM jsonb_to_recordset(v_rows)
           AS x(target_type text, role_id uuid, user_id uuid, allow_permissions bigint, deny_permissions bigint)
     WHERE NOT EXISTS (
            SELECT 1 FROM public.channel_category_permission_overrides t
             WHERE t.category_id = p_category_id
               AND t.role_id IS NOT DISTINCT FROM x.role_id
               AND t.user_id IS NOT DISTINCT FROM x.user_id);

    FOREACH v_channel IN ARRAY v_synced LOOP
        PERFORM public.apply_category_permissions(v_channel, p_category_id);
    END LOOP;

    RETURN jsonb_build_object('category_id', p_category_id, 'synced_channel_ids', to_jsonb(v_synced));
END;
$$;

COMMENT ON FUNCTION public.set_category_permissions(uuid, jsonb) IS
    'Replace a category''s permission template; channels synced with it before the call receive the new template. MANAGE_CHANNELS or MANAGE_ROLES, no bit the caller lacks.';

REVOKE ALL ON FUNCTION public.set_category_permissions(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_category_permissions(uuid, jsonb) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.sync_channel_permissions(p_channel_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_category uuid;
    v_local boolean;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT c.category, s.is_local_server INTO v_category, v_local
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = p_channel_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'CHANNEL_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF v_local IS FALSE THEN
        RAISE EXCEPTION 'CHANNEL_REMOTE: a remote server''s channel is not synced here' USING ERRCODE = '22023';
    END IF;
    IF v_category IS NULL THEN
        RAISE EXCEPTION 'CHANNEL_HAS_NO_CATEGORY' USING ERRCODE = '22023';
    END IF;

    PERFORM public.assert_category_template_writable(p_channel_id, v_category);
    PERFORM public.apply_category_permissions(p_channel_id, v_category);
    RETURN true;
END;
$$;

COMMENT ON FUNCTION public.sync_channel_permissions(uuid) IS
    'Replace a channel''s overrides with its category''s template. MANAGE_CHANNELS or MANAGE_ROLES in the channel, no bit the caller lacks there.';

REVOKE ALL ON FUNCTION public.sync_channel_permissions(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_channel_permissions(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- create_channel: as 20261013000001; the private overrides merge into the category template the
-- insert trigger wrote.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.create_channel(
    p_server_id uuid,
    p_name text,
    p_type integer DEFAULT 0,
    p_category uuid DEFAULT NULL,
    p_private boolean DEFAULT false,
    p_allowed_role_ids uuid[] DEFAULT '{}'::uuid[])
RETURNS public.channels
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id uuid := gen_random_uuid();
    v_channel public.channels%ROWTYPE;
    v_everyone uuid;
    v_role uuid;
BEGIN
    INSERT INTO public.channels (id, name, server_id, type, category)
    VALUES (v_id, p_name, p_server_id, COALESCE(p_type, 0), p_category);

    IF p_private IS TRUE THEN
        SELECT id INTO v_everyone
          FROM public.server_roles
         WHERE server_id = p_server_id AND is_default = true;
        IF v_everyone IS NULL THEN
            RAISE EXCEPTION 'Server has no @everyone role' USING ERRCODE = 'P0002';
        END IF;

        -- VIEW_CHANNEL is bit 1. The role allows go first: the grant guard requires the caller
        -- to hold VIEW_CHANNEL in the channel, which the @everyone deny takes from a manager
        -- without ADMINISTRATOR.
        FOREACH v_role IN ARRAY COALESCE(p_allowed_role_ids, '{}'::uuid[]) LOOP
            CONTINUE WHEN v_role = v_everyone;
            IF NOT EXISTS (SELECT 1 FROM public.server_roles
                            WHERE id = v_role AND server_id = p_server_id) THEN
                RAISE EXCEPTION 'Role % is not a role of this server', v_role USING ERRCODE = '22023';
            END IF;
            INSERT INTO public.channel_permission_overrides AS cpo
                   (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
            VALUES (v_id, 'role', v_role, NULL, 2, 0)
            ON CONFLICT (channel_id, role_id) WHERE user_id IS NULL DO UPDATE
               SET allow_permissions = COALESCE(cpo.allow_permissions, 0) | 2,
                   deny_permissions = COALESCE(cpo.deny_permissions, 0) & ~2::bigint,
                   updated_at = now();
        END LOOP;

        INSERT INTO public.channel_permission_overrides AS cpo
               (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
        VALUES (v_id, 'role', v_everyone, NULL, 0, 2)
        ON CONFLICT (channel_id, role_id) WHERE user_id IS NULL DO UPDATE
           SET allow_permissions = COALESCE(cpo.allow_permissions, 0) & ~2::bigint,
               deny_permissions = COALESCE(cpo.deny_permissions, 0) | 2,
               updated_at = now();
    END IF;

    SELECT * INTO v_channel FROM public.channels WHERE id = v_id;
    IF NOT FOUND THEN
        v_channel.id := v_id;
        v_channel.server_id := p_server_id;
        v_channel.name := p_name;
        v_channel.type := COALESCE(p_type, 0);
        v_channel.category := p_category;
    END IF;
    RETURN v_channel;
END;
$$;

COMMENT ON FUNCTION public.create_channel(uuid, text, integer, uuid, boolean, uuid[]) IS
    'Create a channel as the caller (RLS applies); in a category it receives the category''s permissions; private: @everyone VIEW_CHANNEL denied, listed roles allowed, in one transaction.';

REVOKE ALL ON FUNCTION public.create_channel(uuid, text, integer, uuid, boolean, uuid[])
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_channel(uuid, text, integer, uuid, boolean, uuid[])
    TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Broadcasts
-- ---------------------------------------------------------------------------

-- A category every member sees holds a channel every member sees (channel_is_restricted false).
-- Any other category, and every delete, goes out as ids, flagged restricted; clients read the row
-- back through channel_categories RLS.
CREATE OR REPLACE FUNCTION public.broadcast_category_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_server     uuid;
  v_restricted boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_server := OLD.server_id;
    v_restricted := true;
  ELSE
    v_server := NEW.server_id;
    v_restricted := NOT EXISTS (
        SELECT 1 FROM public.channels c
         WHERE c.category = NEW.id
           AND NOT public.channel_is_restricted(c.id));
  END IF;

  IF v_restricted THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type', 'category:' || lower(TG_OP),
        'restricted', true,
        'new', CASE WHEN TG_OP != 'DELETE' THEN jsonb_build_object(
                 'id', NEW.id, 'server_id', NEW.server_id, 'order', NEW."order") ELSE NULL END,
        'old', CASE WHEN TG_OP != 'INSERT' THEN jsonb_build_object(
                 'id', OLD.id, 'server_id', OLD.server_id, 'order', OLD."order") ELSE NULL END
      ),
      'server_event',
      'server-structure:' || v_server::text,
      true
    );
  ELSE
    PERFORM realtime.send(
      jsonb_build_object(
        'type', 'category:' || lower(TG_OP),
        'new', to_jsonb(NEW),
        'old', CASE WHEN TG_OP != 'INSERT' THEN to_jsonb(OLD) ELSE NULL END
      ),
      'server_event',
      'server-structure:' || v_server::text,
      true
    );
  END IF;

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'broadcast_category_change failed: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

-- Ids only: a template change moves no member's view until it reaches channel overrides, which
-- broadcast on their own.
CREATE OR REPLACE FUNCTION public.broadcast_category_permission_override_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_category uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.category_id ELSE NEW.category_id END;
  v_server   uuid;
BEGIN
  SELECT k.server_id INTO v_server FROM public.channel_categories k WHERE k.id = v_category;
  IF v_server IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  PERFORM realtime.send(
    jsonb_build_object('type', 'category_permission_override:' || lower(TG_OP), 'category_id', v_category),
    'server_event',
    'server-structure:' || v_server::text,
    true
  );
  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'broadcast_category_permission_override_change failed: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

REVOKE ALL ON FUNCTION public.broadcast_category_permission_override_change() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_broadcast_category_permission_override ON public.channel_category_permission_overrides;
CREATE TRIGGER trg_broadcast_category_permission_override
    AFTER INSERT OR UPDATE OR DELETE ON public.channel_category_permission_overrides
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_category_permission_override_change();

-- ---------------------------------------------------------------------------
-- notification_settings_state: as 20261011200001; categories, and category overrides, are those
-- holding a channel the member views, or every category for a member with MANAGE_CHANNELS.
-- ---------------------------------------------------------------------------

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
    ),
    cats AS (
        SELECT k.id, k.name, k."order"
          FROM public.channel_categories k
         WHERE k.server_id = p_server_id
           AND (EXISTS (SELECT 1 FROM vis v WHERE v.category = k.id)
                OR public.has_permission(p_user_id, p_server_id, 'MANAGE_CHANNELS'))
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
                    JOIN cats k ON k.id = nc.category_id
                   WHERE nc.user_id = p_user_id
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
              FROM cats k
        ), '[]'::jsonb)
    )
      FROM public.user_servers us
      LEFT JOIN public.notification_servers ns ON ns.user_id = us.user_id AND ns.server_id = us.server_id
      LEFT JOIN public.server_settings ss ON ss.server_id = us.server_id
     WHERE us.user_id = p_user_id AND us.server_id = p_server_id;
$$;

-- ---------------------------------------------------------------------------
-- Federation
-- ---------------------------------------------------------------------------

-- Remote instances that receive a channel of the category (federation_channel_recipients: every
-- member the instance hosts views it). A category with no such channel reaches no instance; a
-- server with federation off reaches none. Rows are those of federation_channel_recipients, one
-- per instance; its member columns do not depend on the channel.
CREATE OR REPLACE FUNCTION public.federation_category_recipients(p_category_id uuid)
RETURNS TABLE (
    instance text,
    member_ap_ids text[],
    member_count integer,
    shared_inbox text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    SELECT DISTINCT ON (r.instance) r.instance, r.member_ap_ids, r.member_count, r.shared_inbox
      FROM public.channels c
     CROSS JOIN LATERAL public.federation_channel_recipients(c.id) r
     WHERE c.category = p_category_id
       AND c.is_remote IS NOT TRUE
     ORDER BY r.instance;
$$;

REVOKE ALL ON FUNCTION public.federation_category_recipients(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.federation_category_recipients(uuid) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
