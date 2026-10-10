-- External sounds: members play the sounds of other servers they belong to, as Discord's Use
-- External Sounds.
--
-- Permission. USE_EXTERNAL_SOUNDS is bit 31, appended to the bit map after USE_SOUNDBOARD;
-- server_roles.permissions and channel_permission_overrides allow/deny are bigint. Playing
-- another server's sound in a channel needs USE_SOUNDBOARD, SPEAK and USE_EXTERNAL_SOUNDS
-- there, through roles and channel overrides like every other bit. New servers' @everyone
-- carries it (create_default_server_role: 1196388610 -> 3343872258). Existing local servers'
-- @everyone gains it once, when this migration first extends the bit map, and only where
-- @everyone holds USE_SOUNDBOARD: a server that withheld the soundboard from @everyone
-- withholds external sounds too, and a server that removes the bit afterwards keeps it removed
-- on a rerun. Other roles are unchanged.
--
-- Sharing. server_settings.allow_cross_server_sounds, default true: the server's sounds may be
-- played in other servers. Sound managers (can_manage_server_sounds) set it through
-- set_server_sound_sharing; changes are audited as settings.update.
--
-- list_soundboard_library()
--   Sounds of every local server the caller owns or is an accepted member of, whose sounds are
--   shared, with the server's name and icon. The caller's own server list for the soundboard.
--
-- resolve_soundboard_sound(sound, server)
--   One sound, for a listener of a play in `server`. A shared server's sound resolves for any
--   signed-in caller: a sound played into a channel is no secret, and its file is public in the
--   soundboard bucket already. An unshared server's sound resolves only for a play in its own
--   server, and only to its owner, accepted members and instance admins, as RLS on
--   server_sounds. A deleted sound resolves to nothing.
--
-- Plays stay client to client. The sender's right to play an external sound in the channel
-- travels in its LiveKit token (metadata.soundboardExternal), which each listener checks.
--
-- Converges by state.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Permission bit 31: USE_EXTERNAL_SOUNDS
-- ---------------------------------------------------------------------------

-- Existing @everyone roles
-- Runs before permission_bit_names() names the bit, so exactly once per instance.
DO $$
BEGIN
    IF 'USE_EXTERNAL_SOUNDS' = ANY (public.permission_bit_names()) THEN
        RETURN;
    END IF;
    UPDATE public.server_roles r
       SET permissions = r.permissions | (1::bigint << 31)
      FROM public.servers s
     WHERE s.id = r.server_id
       AND s.is_local_server IS NOT FALSE
       AND r.is_default
       AND (COALESCE(r.permissions, 0) & (1::bigint << 30)) <> 0
       AND (r.permissions & (1::bigint << 31)) = 0;
END;
$$;

-- Bit order of server_roles.permissions and channel_permission_overrides allow/deny. Index 1
-- is bit 0.
CREATE OR REPLACE FUNCTION public.permission_bit_names()
RETURNS text[]
LANGUAGE sql IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT ARRAY[
        'ADMINISTRATOR','VIEW_CHANNEL','MANAGE_CHANNELS','MANAGE_ROLES',
        'MANAGE_EMOJIS','VIEW_AUDIT_LOG','MANAGE_WEBHOOKS','MANAGE_SERVER',
        'CREATE_INVITE','KICK_MEMBERS','BAN_MEMBERS','TIMEOUT_MEMBERS',
        'SEND_MESSAGES','SEND_MESSAGES_IN_THREADS','CREATE_PUBLIC_THREADS','CREATE_PRIVATE_THREADS',
        'EMBED_LINKS','ATTACH_FILES','ADD_REACTIONS','USE_EXTERNAL_EMOJIS',
        'MENTION_EVERYONE','MANAGE_MESSAGES','READ_MESSAGE_HISTORY','PIN_MESSAGES',
        'CONNECT','SPEAK','STREAM','MUTE_MEMBERS','DEAFEN_MEMBERS','MOVE_MEMBERS',
        'USE_SOUNDBOARD','USE_EXTERNAL_SOUNDS']
$$;

-- Default @everyone mask: VIEW_CHANNEL, CREATE_INVITE, SEND_MESSAGES, SEND_MESSAGES_IN_THREADS,
-- CREATE_PUBLIC_THREADS, EMBED_LINKS, ATTACH_FILES, ADD_REACTIONS, USE_EXTERNAL_EMOJIS,
-- READ_MESSAGE_HISTORY, CONNECT, SPEAK, STREAM, USE_SOUNDBOARD, USE_EXTERNAL_SOUNDS.
CREATE OR REPLACE FUNCTION public.create_default_server_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    everyone_role_id uuid;
    admin_role_id uuid;
BEGIN
    INSERT INTO server_roles (
        server_id,
        name,
        color,
        position,
        is_default,
        is_admin,
        permissions
    ) VALUES (
        NEW.id,
        'everyone',
        '#99AAB5',
        0,
        true,
        false,
        3343872258
    ) RETURNING id INTO everyone_role_id;

    INSERT INTO server_roles (
        server_id,
        name,
        color,
        position,
        is_default,
        is_admin,
        permissions
    ) VALUES (
        NEW.id,
        'Admin',
        '#e74c3c',
        999,
        false,
        true,
        2199023255551
    ) RETURNING id INTO admin_role_id;

    INSERT INTO user_roles (user_id, role_id, server_id)
    VALUES (NEW.owner, admin_role_id, NEW.id)
    ON CONFLICT (user_id, role_id) DO NOTHING;

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Sharing
-- ---------------------------------------------------------------------------

ALTER TABLE public.server_settings
    ADD COLUMN IF NOT EXISTS allow_cross_server_sounds boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.server_settings.allow_cross_server_sounds IS
    'Members may play this server''s soundboard sounds in other servers. A server without a row shares.';

CREATE OR REPLACE FUNCTION public.set_server_sound_sharing(p_server_id uuid, p_allow boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_allow IS NULL THEN
        RAISE EXCEPTION 'p_allow is true or false' USING ERRCODE = '22023';
    END IF;
    IF NOT COALESCE(public.can_manage_server_sounds(p_server_id), false) THEN
        RAISE EXCEPTION 'Missing permission: MANAGE_EMOJIS' USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.server_settings (server_id, allow_cross_server_sounds)
    VALUES (p_server_id, p_allow)
    ON CONFLICT (server_id) DO UPDATE
    SET allow_cross_server_sounds = EXCLUDED.allow_cross_server_sounds,
        updated_at = now();

    RETURN p_allow;
END;
$$;

-- As 20261010600001, plus allow_cross_server_sounds.
CREATE OR REPLACE FUNCTION public.server_audit_settings()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_keys constant text[] := ARRAY['invite_permissions', 'moderation_settings', 'default_message_notifications',
                                    'newcomer_alerts', 'system_messages_enabled', 'allow_cross_server_sounds'];
    v_old jsonb;
    v_changes jsonb;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        v_old := public.server_audit_pick(to_jsonb(OLD), v_keys)
              || jsonb_build_object(
                     'default_role', (SELECT sr.name FROM public.server_roles sr WHERE sr.id = OLD.default_role_id),
                     'system_channel', (SELECT c.name FROM public.channels c WHERE c.id = OLD.system_channel_id));
    END IF;
    v_changes := public.server_audit_diff(v_old,
        public.server_audit_pick(to_jsonb(NEW), v_keys)
            || jsonb_build_object(
                   'default_role', (SELECT sr.name FROM public.server_roles sr WHERE sr.id = NEW.default_role_id),
                   'system_channel', (SELECT c.name FROM public.channels c WHERE c.id = NEW.system_channel_id)));
    IF v_changes <> '{}'::jsonb THEN
        PERFORM public.server_audit_write(NEW.server_id, 'settings.update', 'server', NEW.server_id::text,
                                          (SELECT s.name FROM public.servers s WHERE s.id = NEW.server_id), v_changes);
    END IF;
    RETURN NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- Library and resolver
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.list_soundboard_library()
RETURNS TABLE (
    id uuid,
    server_id uuid,
    server_name text,
    server_icon text,
    name text,
    emoji text,
    volume numeric,
    duration_ms integer,
    storage_path text,
    created_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH me AS (
        SELECT public.get_current_profile_id() AS id
    ), mine AS (
        SELECT us.server_id
          FROM public.user_servers us, me
         WHERE us.user_id = me.id AND us.status = 'accepted'
        UNION
        SELECT s.id
          FROM public.servers s, me
         WHERE s.owner = me.id
    )
    SELECT ss.id, ss.server_id, s.name, s.icon, ss.name, ss.emoji, ss.volume, ss.duration_ms,
           ss.storage_path, ss.created_at
      FROM mine
      JOIN public.servers s ON s.id = mine.server_id AND s.is_local_server IS NOT FALSE
      JOIN public.server_sounds ss ON ss.server_id = s.id
      LEFT JOIN public.server_settings st ON st.server_id = s.id
     WHERE COALESCE(st.allow_cross_server_sounds, true)
     ORDER BY lower(s.name), s.id, ss.created_at, ss.id
$$;

CREATE OR REPLACE FUNCTION public.resolve_soundboard_sound(p_sound_id uuid, p_server_id uuid)
RETURNS TABLE (
    id uuid,
    server_id uuid,
    name text,
    emoji text,
    volume numeric,
    duration_ms integer,
    storage_path text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT ss.id, ss.server_id, ss.name, ss.emoji, ss.volume, ss.duration_ms, ss.storage_path
      FROM public.server_sounds ss
      JOIN public.servers s ON s.id = ss.server_id
      LEFT JOIN public.server_settings st ON st.server_id = ss.server_id
     CROSS JOIN (SELECT public.get_current_profile_id() AS me) v
     WHERE ss.id = p_sound_id
       AND v.me IS NOT NULL
       AND s.is_local_server IS NOT FALSE
       AND (COALESCE(st.allow_cross_server_sounds, true)
            OR (ss.server_id = p_server_id
                AND (s.owner = v.me
                     OR public.is_current_user_admin()
                     OR EXISTS (SELECT 1 FROM public.user_servers us
                                 WHERE us.server_id = ss.server_id
                                   AND us.user_id = v.me
                                   AND us.status = 'accepted'))))
$$;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.set_server_sound_sharing(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_server_sound_sharing(uuid, boolean) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.list_soundboard_library() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_soundboard_library() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.resolve_soundboard_sound(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_soundboard_sound(uuid, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.server_audit_settings() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_audit_settings() TO service_role;

COMMIT;
