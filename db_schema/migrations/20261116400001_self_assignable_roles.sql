-- Self-assignable roles and the join role.
--
-- server_roles.self_assignable, self_assign_group (at most 50 characters) and self_assign_note
-- (at most 200): a role members may give themselves, listed under its group in the role picker and
-- role menu cards. Written with the role, under the existing MANAGE_ROLES policies and guards.
--
-- self_assign_refusal(p_role_id): NULL when a member may give themselves the role, else a code:
--   ROLE_NOT_FOUND      no such role
--   NOT_SELF_ASSIGNABLE the role is not marked self-assignable, or is @everyone
--   SERVER_NOT_LOCAL    the server is a copy of another instance's
--   ROLE_IS_ADMIN       an administrator role
--   ROLE_GRANTS_PERMISSIONS the role's server permissions exceed @everyone's
--   ROLE_RANKS_TOO_HIGH the role sits at or above a role that grants permissions beyond @everyone's
--                       (is_admin, or bits outside @everyone's): picking it would outrank moderators
--   ROLE_OVERRIDE_GRANTS a channel override of the role allows a bit outside @everyone's server
--                       permissions and VIEW_CHANNEL; opening a channel to the role stays allowed
--
-- set_my_self_assignable_role(p_role_id, p_on): the caller, an accepted member of the role's server,
-- gives themselves the role (p_on, every check above) or drops it (the role need only be
-- self-assignable). Returns p_on; a repeat changes nothing. Errors: 28000 not signed in, P0002
-- ROLE_NOT_FOUND, 42501 NOT_A_MEMBER or a self_assign_refusal code.
--
-- Join role. server_settings.default_role_id was stored and audited but applied nowhere.
-- assign_default_role_to_member now also gives it when a membership becomes accepted (insert, or a
-- status change from anything else), on servers this instance hosts, to anyone but the owner,
-- unless it is @everyone or an administrator role. set_server_join_role(p_server_id, p_role_id) sets or clears it: the caller
-- needs MANAGE_ROLES on a local server and the role must rank below their highest role (owner and
-- instance admins pass), as guard_server_settings_default_role requires of direct writes, which now
-- also refuse @everyone and administrator roles.
--
-- server_audit_roles records the three new columns.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.server_roles
    ADD COLUMN IF NOT EXISTS self_assignable boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS self_assign_group text,
    ADD COLUMN IF NOT EXISTS self_assign_note text;

ALTER TABLE public.server_roles DROP CONSTRAINT IF EXISTS server_roles_self_assign_group_length;
ALTER TABLE public.server_roles ADD CONSTRAINT server_roles_self_assign_group_length
    CHECK (self_assign_group IS NULL OR char_length(self_assign_group) BETWEEN 1 AND 50);
ALTER TABLE public.server_roles DROP CONSTRAINT IF EXISTS server_roles_self_assign_note_length;
ALTER TABLE public.server_roles ADD CONSTRAINT server_roles_self_assign_note_length
    CHECK (self_assign_note IS NULL OR char_length(self_assign_note) <= 200);

-- ---------------------------------------------------------------------------
-- Picking a role
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.self_assign_refusal(p_role_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_role public.server_roles;
    v_everyone bigint;
    v_view_channel constant bigint := 2;
BEGIN
    SELECT * INTO v_role FROM public.server_roles WHERE id = p_role_id;
    IF NOT FOUND THEN
        RETURN 'ROLE_NOT_FOUND';
    END IF;
    IF NOT v_role.self_assignable OR v_role.is_default THEN
        RETURN 'NOT_SELF_ASSIGNABLE';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = v_role.server_id AND s.is_local_server) THEN
        RETURN 'SERVER_NOT_LOCAL';
    END IF;
    IF v_role.is_admin THEN
        RETURN 'ROLE_IS_ADMIN';
    END IF;

    SELECT COALESCE(sr.permissions, 0) INTO v_everyone
      FROM public.server_roles sr WHERE sr.server_id = v_role.server_id AND sr.is_default;
    v_everyone := COALESCE(v_everyone, 0);

    IF COALESCE(v_role.permissions, 0) & ~v_everyone <> 0 THEN
        RETURN 'ROLE_GRANTS_PERMISSIONS';
    END IF;
    IF EXISTS (SELECT 1 FROM public.server_roles sr
                WHERE sr.server_id = v_role.server_id
                  AND sr.id <> v_role.id
                  AND NOT sr.is_default
                  AND (sr.is_admin OR COALESCE(sr.permissions, 0) & ~v_everyone <> 0)
                  AND sr.position <= v_role.position) THEN
        RETURN 'ROLE_RANKS_TOO_HIGH';
    END IF;
    IF EXISTS (SELECT 1 FROM public.channel_permission_overrides o
                WHERE o.role_id = v_role.id
                  AND COALESCE(o.allow_permissions, 0) & ~(v_everyone | v_view_channel) <> 0) THEN
        RETURN 'ROLE_OVERRIDE_GRANTS';
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_my_self_assignable_role(p_role_id uuid, p_on boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_server uuid;
    v_self_assignable boolean;
    v_refusal text;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
    END IF;
    SELECT sr.server_id, sr.self_assignable INTO v_server, v_self_assignable
      FROM public.server_roles sr WHERE sr.id = p_role_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ROLE_NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_servers us
                    WHERE us.server_id = v_server AND us.user_id = v_me AND us.status = 'accepted') THEN
        RAISE EXCEPTION 'NOT_A_MEMBER' USING ERRCODE = '42501';
    END IF;

    IF COALESCE(p_on, false) THEN
        v_refusal := public.self_assign_refusal(p_role_id);
        IF v_refusal IS NOT NULL THEN
            RAISE EXCEPTION '%', v_refusal USING ERRCODE = '42501';
        END IF;
        INSERT INTO public.user_roles (user_id, role_id, server_id, assigned_by)
        VALUES (v_me, p_role_id, v_server, v_me)
        ON CONFLICT (user_id, role_id) DO NOTHING;
        RETURN true;
    END IF;

    IF NOT v_self_assignable THEN
        RAISE EXCEPTION 'NOT_SELF_ASSIGNABLE' USING ERRCODE = '42501';
    END IF;
    DELETE FROM public.user_roles WHERE user_id = v_me AND role_id = p_role_id;
    RETURN false;
END;
$$;

-- ---------------------------------------------------------------------------
-- Join role
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assign_default_role_to_member()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    default_role_id uuid;
    v_join_role uuid;
BEGIN
    IF NEW.status = 'accepted' THEN
        SELECT id INTO default_role_id
        FROM server_roles
        WHERE server_id = NEW.server_id AND is_default = true
        LIMIT 1;

        IF default_role_id IS NOT NULL THEN
            INSERT INTO user_roles (user_id, role_id, server_id)
            VALUES (NEW.user_id, default_role_id, NEW.server_id)
            ON CONFLICT (user_id, role_id) DO NOTHING;
        END IF;

        IF TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'accepted' THEN
            SELECT ss.default_role_id INTO v_join_role
              FROM server_settings ss
              JOIN servers s ON s.id = ss.server_id AND s.is_local_server
                            AND s.owner IS DISTINCT FROM NEW.user_id
              JOIN server_roles sr ON sr.id = ss.default_role_id
                                  AND sr.server_id = ss.server_id
                                  AND NOT sr.is_default
                                  AND NOT sr.is_admin
             WHERE ss.server_id = NEW.server_id;
            IF v_join_role IS NOT NULL THEN
                INSERT INTO user_roles (user_id, role_id, server_id)
                VALUES (NEW.user_id, v_join_role, NEW.server_id)
                ON CONFLICT (user_id, role_id) DO NOTHING;
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_server_settings_default_role()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_role_server uuid;
    v_role_position integer;
    v_role_reserved boolean;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1
       OR NEW.default_role_id IS NULL
       OR (TG_OP = 'UPDATE' AND NEW.default_role_id IS NOT DISTINCT FROM OLD.default_role_id) THEN
        RETURN NEW;
    END IF;

    SELECT sr.server_id, sr.position, sr.is_default OR sr.is_admin
      INTO v_role_server, v_role_position, v_role_reserved
      FROM public.server_roles sr WHERE sr.id = NEW.default_role_id;
    IF v_role_server IS DISTINCT FROM NEW.server_id THEN
        RAISE EXCEPTION 'The default role belongs to this server' USING ERRCODE = '42501';
    END IF;
    IF v_role_reserved THEN
        RAISE EXCEPTION 'The join role cannot be @everyone or an administrator role' USING ERRCODE = '42501';
    END IF;

    IF public.caller_outranks_all(NEW.server_id) THEN
        RETURN NEW;
    END IF;
    IF NOT public.has_permission(public.get_current_profile_id(), NEW.server_id, 'MANAGE_ROLES')
       OR v_role_position >= public.get_user_highest_role_position(public.get_current_profile_id(), NEW.server_id) THEN
        RAISE EXCEPTION 'Cannot make a role you cannot assign the default role' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.set_server_join_role(p_server_id uuid, p_role_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_role public.server_roles;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '28000';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.is_local_server) THEN
        RAISE EXCEPTION 'SERVER_NOT_LOCAL' USING ERRCODE = '42501';
    END IF;
    IF NOT public.caller_outranks_all(p_server_id)
       AND NOT public.has_permission(v_me, p_server_id, 'MANAGE_ROLES') THEN
        RAISE EXCEPTION 'Missing permission: MANAGE_ROLES' USING ERRCODE = '42501';
    END IF;

    IF p_role_id IS NOT NULL THEN
        SELECT * INTO v_role FROM public.server_roles WHERE id = p_role_id AND server_id = p_server_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'ROLE_NOT_FOUND' USING ERRCODE = 'P0002';
        END IF;
        IF v_role.is_default OR v_role.is_admin THEN
            RAISE EXCEPTION 'ROLE_RESERVED' USING ERRCODE = '42501';
        END IF;
        IF NOT public.caller_outranks_all(p_server_id)
           AND v_role.position >= public.get_user_highest_role_position(v_me, p_server_id) THEN
            RAISE EXCEPTION 'ROLE_RANKS_TOO_HIGH' USING ERRCODE = '42501';
        END IF;
    END IF;

    INSERT INTO public.server_settings (server_id, default_role_id)
    VALUES (p_server_id, p_role_id)
    ON CONFLICT (server_id) DO UPDATE SET default_role_id = EXCLUDED.default_role_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Audit
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.server_audit_roles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_keys constant text[] := ARRAY['name', 'color', 'permissions', 'mentionable', 'hoist',
                                    'icon_url', 'unicode_emoji', 'is_admin', 'self_assignable',
                                    'self_assign_group', 'self_assign_note'];
    v_changes jsonb;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;

    v_changes := public.server_audit_diff(
        CASE WHEN TG_OP <> 'INSERT' THEN public.server_audit_pick(to_jsonb(OLD), v_keys) END,
        CASE WHEN TG_OP <> 'DELETE' THEN public.server_audit_pick(to_jsonb(NEW), v_keys) END);

    IF TG_OP = 'INSERT' THEN
        PERFORM public.server_audit_write(NEW.server_id, 'role.create', 'role', NEW.id::text, NEW.name, v_changes);
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM public.server_audit_write(OLD.server_id, 'role.delete', 'role', OLD.id::text, OLD.name, v_changes);
    ELSIF v_changes <> '{}'::jsonb THEN
        PERFORM public.server_audit_write(NEW.server_id, 'role.update', 'role', NEW.id::text, NEW.name, v_changes);
    ELSIF NEW.position IS DISTINCT FROM OLD.position THEN
        PERFORM public.server_audit_fold_reorder(NEW.server_id, 'role.reorder', NEW.id::text, NEW.name,
                                                 OLD.position, NEW.position);
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_server_roles_audit_update ON public.server_roles;
CREATE TRIGGER z_server_roles_audit_update
    AFTER UPDATE ON public.server_roles
    FOR EACH ROW
    WHEN ((OLD.name, OLD.color, OLD.permissions, OLD.mentionable, OLD.hoist, OLD.icon_url,
           OLD.unicode_emoji, OLD.is_admin, OLD.position, OLD.self_assignable, OLD.self_assign_group,
           OLD.self_assign_note)
          IS DISTINCT FROM (NEW.name, NEW.color, NEW.permissions, NEW.mentionable, NEW.hoist, NEW.icon_url,
                            NEW.unicode_emoji, NEW.is_admin, NEW.position, NEW.self_assignable,
                            NEW.self_assign_group, NEW.self_assign_note))
    EXECUTE FUNCTION public.server_audit_roles();

REVOKE ALL ON FUNCTION public.self_assign_refusal(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.self_assign_refusal(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.set_my_self_assignable_role(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_my_self_assignable_role(uuid, boolean) TO authenticated;
REVOKE ALL ON FUNCTION public.set_server_join_role(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_server_join_role(uuid, uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.guard_server_settings_default_role() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.assign_default_role_to_member() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.server_audit_roles() FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
