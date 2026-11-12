-- Server profiles and pronouns.
--
-- profiles.pronouns (account level) and, per server, user_servers.{avatar_url, banner_url, bio,
-- pronouns} beside the existing nickname. A NULL server value means "use the account's".
-- Limits: pronouns 40, bio 500, nickname 64 (unchanged), URLs 2048. Values are trimmed and an empty
-- value is stored as NULL; the length checks reject rather than clamp.
--
-- Writes. Members used to be able to UPDATE their own user_servers row (and the owner any row in
-- their server) through the table's RLS policy; folder, position and mute still are. The five
-- profile columns are now written only by SECURITY DEFINER functions (a client role's direct
-- write is rejected by a trigger, 42501), because a column REVOKE does not narrow the table-level
-- UPDATE privilege this table is granted:
--
--   set_my_server_profile(server, fields)             the member, with CHANGE_NICKNAME
--   moderate_server_profile(server, user, ...)        MANAGE_NICKNAMES over a lower-ranked member;
--                                                     audited
--   service_set_member_server_profile(server, user, fields)
--                                                     service_role, no permission check (the
--                                                     Discord migration)
--
-- profiles.pronouns is written through the existing profiles_update_own policy.
--
-- Storage. The avatars and banners INSERT policies admit a first path segment equal to the
-- caller's profile id, so <profile id>/servers/<server id>/<file> needs no policy change.
--
-- Converges by state: columns, checks, triggers and functions are created only when absent or
-- different, so the instance-level hosted schema and a fresh install end up alike.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Columns and checks
-- ---------------------------------------------------------------------------

ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS pronouns text;

ALTER TABLE public.user_servers
    ADD COLUMN IF NOT EXISTS avatar_url text,
    ADD COLUMN IF NOT EXISTS banner_url text,
    ADD COLUMN IF NOT EXISTS bio text,
    ADD COLUMN IF NOT EXISTS pronouns text;

DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT * FROM (VALUES
            ('profiles', 'profiles_pronouns_length_check',
             'CHECK (pronouns IS NULL OR char_length(pronouns) <= 40)'),
            ('user_servers', 'user_servers_pronouns_length_check',
             'CHECK (pronouns IS NULL OR char_length(pronouns) <= 40)'),
            ('user_servers', 'user_servers_bio_length_check',
             'CHECK (bio IS NULL OR char_length(bio) <= 500)'),
            ('user_servers', 'user_servers_avatar_url_length_check',
             'CHECK (avatar_url IS NULL OR char_length(avatar_url) <= 2048)'),
            ('user_servers', 'user_servers_banner_url_length_check',
             'CHECK (banner_url IS NULL OR char_length(banner_url) <= 2048)')
        ) AS t(tbl, name, def)
    LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint c
                        WHERE c.conrelid = format('public.%I', r.tbl)::regclass AND c.conname = r.name) THEN
            EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s', r.tbl, r.name, r.def);
        END IF;
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Sanitizing triggers
-- ---------------------------------------------------------------------------

-- As the baseline, with the server profile columns: control characters stripped, trimmed, empty
-- to NULL. The caps are the CHECKs' business, so the limits here are well above them.
CREATE OR REPLACE FUNCTION public.sanitize_member_nickname()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    IF NEW.nickname IS NOT NULL THEN
        NEW.nickname := NULLIF(public.sanitize_profile_string(NEW.nickname, 64, false), '');
    END IF;
    IF NEW.pronouns IS NOT NULL THEN
        NEW.pronouns := NULLIF(public.sanitize_profile_string(NEW.pronouns, 1000, false), '');
    END IF;
    IF NEW.bio IS NOT NULL THEN
        NEW.bio := NULLIF(public.sanitize_profile_string(NEW.bio, 10000, true), '');
    END IF;
    IF NEW.avatar_url IS NOT NULL THEN
        NEW.avatar_url := NULLIF(btrim(NEW.avatar_url), '');
    END IF;
    IF NEW.banner_url IS NOT NULL THEN
        NEW.banner_url := NULLIF(btrim(NEW.banner_url), '');
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sanitize_profile_pronouns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    IF NEW.pronouns IS NOT NULL THEN
        NEW.pronouns := NULLIF(public.sanitize_profile_string(NEW.pronouns, 1000, false), '');
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS sanitize_profile_pronouns_trigger ON public.profiles;
CREATE TRIGGER sanitize_profile_pronouns_trigger
    BEFORE INSERT OR UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_profile_pronouns();

-- The trigger itself (20261009200001 creates it where the nickname column was absent).
DROP TRIGGER IF EXISTS sanitize_member_nickname_trigger ON public.user_servers;
CREATE TRIGGER sanitize_member_nickname_trigger
    BEFORE INSERT OR UPDATE ON public.user_servers
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_member_nickname();

-- ---------------------------------------------------------------------------
-- Direct client writes to the profile columns
-- ---------------------------------------------------------------------------

-- A client role's INSERT or UPDATE may not set or change them. The SECURITY DEFINER functions
-- below (and the join and leave paths) run as the function owner and pass.
CREATE OR REPLACE FUNCTION public.guard_user_server_profile_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.nickname IS NOT NULL OR NEW.avatar_url IS NOT NULL OR NEW.banner_url IS NOT NULL
           OR NEW.bio IS NOT NULL OR NEW.pronouns IS NOT NULL THEN
            RAISE EXCEPTION 'A server profile is set with set_my_server_profile' USING ERRCODE = '42501';
        END IF;
    ELSIF NEW.nickname IS DISTINCT FROM OLD.nickname OR NEW.avatar_url IS DISTINCT FROM OLD.avatar_url
          OR NEW.banner_url IS DISTINCT FROM OLD.banner_url OR NEW.bio IS DISTINCT FROM OLD.bio
          OR NEW.pronouns IS DISTINCT FROM OLD.pronouns THEN
        RAISE EXCEPTION 'A server profile is set with set_my_server_profile' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_user_servers_profile_guard ON public.user_servers;
CREATE TRIGGER a_user_servers_profile_guard
    BEFORE INSERT OR UPDATE ON public.user_servers
    FOR EACH ROW EXECUTE FUNCTION public.guard_user_server_profile_columns();

REVOKE ALL ON FUNCTION public.guard_user_server_profile_columns() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- service_set_member_server_profile
-- ---------------------------------------------------------------------------

-- Present keys are set, JSON null clears; keys left out are untouched. Returns the five fields.
CREATE OR REPLACE FUNCTION public.service_set_member_server_profile(
    p_server_id uuid,
    p_user_id uuid,
    p_fields jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_keys constant text[] := ARRAY['nickname', 'avatar_url', 'banner_url', 'bio', 'pronouns'];
    v_key text;
    v_result jsonb;
BEGIN
    IF p_fields IS NULL OR jsonb_typeof(p_fields) <> 'object' THEN
        RAISE EXCEPTION 'p_fields must be a JSON object' USING ERRCODE = '22023';
    END IF;
    FOR v_key IN SELECT k FROM jsonb_object_keys(p_fields) AS k LOOP
        IF NOT (v_key = ANY (v_keys)) THEN
            RAISE EXCEPTION 'unknown server profile field %', v_key USING ERRCODE = '22023';
        END IF;
        IF jsonb_typeof(p_fields -> v_key) NOT IN ('string', 'null') THEN
            RAISE EXCEPTION 'server profile field % must be a string or null', v_key USING ERRCODE = '22023';
        END IF;
    END LOOP;

    UPDATE public.user_servers us
       SET nickname   = CASE WHEN p_fields ? 'nickname'   THEN p_fields ->> 'nickname'   ELSE us.nickname   END,
           avatar_url = CASE WHEN p_fields ? 'avatar_url' THEN p_fields ->> 'avatar_url' ELSE us.avatar_url END,
           banner_url = CASE WHEN p_fields ? 'banner_url' THEN p_fields ->> 'banner_url' ELSE us.banner_url END,
           bio        = CASE WHEN p_fields ? 'bio'        THEN p_fields ->> 'bio'        ELSE us.bio        END,
           pronouns   = CASE WHEN p_fields ? 'pronouns'   THEN p_fields ->> 'pronouns'   ELSE us.pronouns   END
     WHERE us.server_id = p_server_id AND us.user_id = p_user_id AND us.status = 'accepted'
    RETURNING jsonb_build_object('nickname', us.nickname, 'avatar_url', us.avatar_url,
                                 'banner_url', us.banner_url, 'bio', us.bio, 'pronouns', us.pronouns)
      INTO v_result;
    IF v_result IS NULL THEN
        RAISE EXCEPTION 'not an accepted member of this server' USING ERRCODE = 'P0002';
    END IF;
    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.service_set_member_server_profile(uuid, uuid, jsonb) IS
    'Set a member''s server profile fields (nickname, avatar_url, banner_url, bio, pronouns); service_role, no permission check.';

-- ---------------------------------------------------------------------------
-- set_my_server_profile
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.set_my_server_profile(
    p_server_id uuid,
    p_fields jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.is_local_server IS NOT FALSE) THEN
        RAISE EXCEPTION 'Server profiles are kept by the instance that hosts the server' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_servers us
                    WHERE us.server_id = p_server_id AND us.user_id = v_me AND us.status = 'accepted') THEN
        RAISE EXCEPTION 'not a member of this server' USING ERRCODE = '42501';
    END IF;
    IF NOT public.has_permission(v_me, p_server_id, 'CHANGE_NICKNAME') THEN
        RAISE EXCEPTION 'Missing CHANGE_NICKNAME permission' USING ERRCODE = '42501';
    END IF;
    RETURN public.service_set_member_server_profile(p_server_id, v_me, p_fields);
END;
$$;

COMMENT ON FUNCTION public.set_my_server_profile(uuid, jsonb) IS
    'Set the caller''s server profile (nickname, avatar_url, banner_url, bio, pronouns); needs CHANGE_NICKNAME. JSON null clears a field.';

-- ---------------------------------------------------------------------------
-- moderate_server_profile
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.moderate_server_profile(
    p_server_id uuid,
    p_user_id uuid,
    p_nickname text DEFAULT NULL,
    p_set_nickname boolean DEFAULT false,
    p_reset_profile boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_owner uuid;
    v_local boolean;
    v_old public.user_servers%ROWTYPE;
    v_new public.user_servers%ROWTYPE;
    v_name text;
    v_changes jsonb;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'not authenticated' USING ERRCODE = '42501';
    END IF;

    IF NOT p_set_nickname AND NOT p_reset_profile THEN
        RAISE EXCEPTION 'nothing to change: set p_set_nickname or p_reset_profile' USING ERRCODE = '22023';
    END IF;

    SELECT s.owner, s.is_local_server IS NOT FALSE INTO v_owner, v_local FROM public.servers s WHERE s.id = p_server_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'no such server' USING ERRCODE = 'P0002';
    END IF;
    IF NOT v_local THEN
        RAISE EXCEPTION 'Server profiles are kept by the instance that hosts the server' USING ERRCODE = '42501';
    END IF;

    IF v_me IS DISTINCT FROM v_owner THEN
        IF NOT EXISTS (SELECT 1 FROM public.user_servers us
                        WHERE us.server_id = p_server_id AND us.user_id = v_me AND us.status = 'accepted')
           OR NOT public.has_permission(v_me, p_server_id, 'MANAGE_NICKNAMES') THEN
            RAISE EXCEPTION 'Missing MANAGE_NICKNAMES permission' USING ERRCODE = '42501';
        END IF;
        IF p_user_id IS NOT DISTINCT FROM v_owner THEN
            RAISE EXCEPTION 'Only the server owner changes the owner''s server profile' USING ERRCODE = '42501';
        END IF;
        IF public.get_user_highest_role_position(v_me, p_server_id)
           <= public.get_user_highest_role_position(p_user_id, p_server_id) THEN
            RAISE EXCEPTION 'Cannot change the server profile of a member with an equal or higher role'
                USING ERRCODE = '42501';
        END IF;
    END IF;

    SELECT * INTO v_old FROM public.user_servers us
     WHERE us.server_id = p_server_id AND us.user_id = p_user_id AND us.status = 'accepted'
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'not an accepted member of this server' USING ERRCODE = 'P0002';
    END IF;

    UPDATE public.user_servers us
       SET nickname   = CASE WHEN p_set_nickname THEN p_nickname ELSE us.nickname END,
           avatar_url = CASE WHEN p_reset_profile THEN NULL ELSE us.avatar_url END,
           banner_url = CASE WHEN p_reset_profile THEN NULL ELSE us.banner_url END,
           bio        = CASE WHEN p_reset_profile THEN NULL ELSE us.bio END,
           pronouns   = CASE WHEN p_reset_profile THEN NULL ELSE us.pronouns END
     WHERE us.server_id = p_server_id AND us.user_id = p_user_id
    RETURNING us.* INTO v_new;

    SELECT p.username INTO v_name FROM public.profiles p WHERE p.id = p_user_id;

    IF p_set_nickname AND v_new.nickname IS DISTINCT FROM v_old.nickname THEN
        v_changes := jsonb_build_object('nickname', jsonb_build_object('old', v_old.nickname, 'new', v_new.nickname));
        PERFORM public.server_audit_write(p_server_id, 'member_nickname_changed', 'user', p_user_id::text, v_name, v_changes);
    END IF;
    IF p_reset_profile THEN
        PERFORM public.server_audit_write(p_server_id, 'member_server_profile_reset', 'user', p_user_id::text, v_name);
    END IF;

    RETURN jsonb_build_object('nickname', v_new.nickname, 'avatar_url', v_new.avatar_url,
                              'banner_url', v_new.banner_url, 'bio', v_new.bio, 'pronouns', v_new.pronouns);
END;
$$;

COMMENT ON FUNCTION public.moderate_server_profile(uuid, uuid, text, boolean, boolean) IS
    'Change (p_set_nickname) or reset (p_reset_profile) a member''s server profile; needs MANAGE_NICKNAMES and a role above the member''s. Audited.';

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.service_set_member_server_profile(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.service_set_member_server_profile(uuid, uuid, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.set_my_server_profile(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_my_server_profile(uuid, jsonb) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.moderate_server_profile(uuid, uuid, text, boolean, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.moderate_server_profile(uuid, uuid, text, boolean, boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
