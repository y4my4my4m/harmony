-- Soundboard: short clips members play into a voice channel for everyone in it.
--
-- Permissions. USE_SOUNDBOARD is bit 30, appended to the bit map after MOVE_MEMBERS. Managing
-- a server's sounds is MANAGE_EMOJIS, which the client labels Manage Expressions, as Discord
-- folds emojis, stickers and sounds into one permission. New servers' @everyone carries
-- USE_SOUNDBOARD (create_default_server_role: 122646786 -> 1196388610). Existing local servers'
-- @everyone gains it once, when this migration first extends the bit map; a server that
-- removes it afterwards keeps it removed on a rerun.
--
-- get_user_permissions reads its bit order from permission_bit_names() instead of an inline
-- copy, so the two cannot diverge; the layered override logic is unchanged.
--
-- server_sounds: one row per clip of a local server, at most 48 per server.
--   name          1-32 characters, trimmed
--   emoji         optional, at most 16 code points
--   volume        playback gain, 0-1
--   duration_ms   1-5200; measured by the uploading client
--   storage_path  {server_id}/{uuid}.{mp3|ogg|wav} in the soundboard bucket
-- Members of the server (owner and instance admins included) read rows. Owners, instance
-- admins and accepted members holding MANAGE_EMOJIS write them (can_manage_server_sounds).
-- A client insert must name an object already uploaded to the soundboard bucket and no larger
-- than the bucket limit; client updates change name, emoji and volume only.
--
-- soundboard bucket: public read like emojis, 512 KB, audio/mpeg, audio/ogg, audio/wav.
-- Uploads and deletes under {server_id}/ follow can_manage_server_sounds. Clip duration has no
-- server-side check; the client refuses longer files.
--
-- Plays carry no database state: the playing client sends a data message to the call and
-- every client in it plays the clip locally.
--
-- Sound creates, edits and deletes are recorded in server_audit_log as sound.*.
--
-- Converges by state.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Permission bit 30: USE_SOUNDBOARD
-- ---------------------------------------------------------------------------

-- Runs before permission_bit_names() names the bit, so exactly once per instance.
DO $$
BEGIN
    IF 'USE_SOUNDBOARD' = ANY (public.permission_bit_names()) THEN
        RETURN;
    END IF;
    UPDATE public.server_roles r
       SET permissions = COALESCE(r.permissions, 0) | (1::bigint << 30)
      FROM public.servers s
     WHERE s.id = r.server_id
       AND s.is_local_server IS NOT FALSE
       AND r.is_default
       AND (COALESCE(r.permissions, 0) & (1::bigint << 30)) = 0;
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
        'USE_SOUNDBOARD']
$$;

-- Discord's layered precedence (https://discord.com/developers/docs/topics/permissions):
--   1) base: @everyone's mask OR every role of the member
--   2) @everyone channel override: clear deny, then set allow
--   3) all other role overrides combined: clear deny, then set allow
--   4) member override: clear deny, then set allow
-- The server owner and ADMINISTRATOR holders get every bit.
CREATE OR REPLACE FUNCTION public.get_user_permissions(
    p_user_id uuid,
    p_server_id uuid,
    p_channel_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_names text[] := public.permission_bit_names();
    v_is_owner boolean;
    v_base_mask bigint := 0;
    v_final_mask bigint;
    v_role record;
    v_override record;
    v_result jsonb := '{}'::jsonb;
    v_i int;
BEGIN
    SELECT (owner = p_user_id) INTO v_is_owner
    FROM public.servers WHERE id = p_server_id;

    IF v_is_owner THEN
        FOR v_i IN 1..array_length(v_names, 1) LOOP
            v_result := v_result || jsonb_build_object(v_names[v_i], true);
        END LOOP;
        RETURN v_result;
    END IF;

    SELECT COALESCE(permissions, 0) INTO v_base_mask
    FROM public.server_roles
    WHERE server_id = p_server_id AND is_default = true;

    v_base_mask := COALESCE(v_base_mask, 0);

    FOR v_role IN
        SELECT sr.permissions
        FROM public.user_roles ur
        JOIN public.server_roles sr ON ur.role_id = sr.id
        WHERE ur.user_id = p_user_id AND ur.server_id = p_server_id
    LOOP
        v_base_mask := v_base_mask | COALESCE(v_role.permissions, 0);
    END LOOP;

    IF (v_base_mask & 1) != 0 THEN
        FOR v_i IN 1..array_length(v_names, 1) LOOP
            v_result := v_result || jsonb_build_object(v_names[v_i], true);
        END LOOP;
        RETURN v_result;
    END IF;

    v_final_mask := v_base_mask;

    IF p_channel_id IS NOT NULL THEN
        DECLARE
            v_everyone_role_id uuid;
            v_everyone_allow bigint := 0;
            v_everyone_deny  bigint := 0;
            v_role_allow     bigint := 0;
            v_role_deny      bigint := 0;
            v_user_allow     bigint := 0;
            v_user_deny      bigint := 0;
        BEGIN
            SELECT id INTO v_everyone_role_id
              FROM public.server_roles
             WHERE server_id = p_server_id AND is_default = true
             LIMIT 1;

            FOR v_override IN
                SELECT role_id, user_id,
                       COALESCE(allow_permissions, 0) AS allow_p,
                       COALESCE(deny_permissions, 0)  AS deny_p
                  FROM public.channel_permission_overrides
                 WHERE channel_id = p_channel_id
                   AND (
                        role_id = v_everyone_role_id
                     OR role_id IN (
                            SELECT ur.role_id
                              FROM public.user_roles ur
                             WHERE ur.user_id = p_user_id
                               AND ur.server_id = p_server_id
                        )
                     OR user_id = p_user_id
                   )
            LOOP
                IF v_override.user_id = p_user_id THEN
                    v_user_allow := v_user_allow | v_override.allow_p;
                    v_user_deny  := v_user_deny  | v_override.deny_p;
                ELSIF v_override.role_id = v_everyone_role_id THEN
                    v_everyone_allow := v_everyone_allow | v_override.allow_p;
                    v_everyone_deny  := v_everyone_deny  | v_override.deny_p;
                ELSIF v_override.role_id IS NOT NULL THEN
                    v_role_allow := v_role_allow | v_override.allow_p;
                    v_role_deny  := v_role_deny  | v_override.deny_p;
                END IF;
            END LOOP;

            v_final_mask := (v_final_mask & ~v_everyone_deny) | v_everyone_allow;
            v_final_mask := (v_final_mask & ~v_role_deny) | v_role_allow;
            v_final_mask := (v_final_mask & ~v_user_deny) | v_user_allow;
        END;
    END IF;

    FOR v_i IN 1..array_length(v_names, 1) LOOP
        v_result := v_result || jsonb_build_object(
            v_names[v_i],
            (v_final_mask & (1::bigint << (v_i - 1))) != 0
        );
    END LOOP;

    RETURN v_result;
END;
$$;

-- Default @everyone mask: VIEW_CHANNEL, CREATE_INVITE, SEND_MESSAGES, SEND_MESSAGES_IN_THREADS,
-- CREATE_PUBLIC_THREADS, EMBED_LINKS, ATTACH_FILES, ADD_REACTIONS, USE_EXTERNAL_EMOJIS,
-- READ_MESSAGE_HISTORY, CONNECT, SPEAK, STREAM, USE_SOUNDBOARD.
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
        1196388610
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
-- server_sounds
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.server_sounds (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    name text NOT NULL,
    emoji text,
    volume numeric(3,2) NOT NULL DEFAULT 1,
    duration_ms integer NOT NULL,
    storage_path text NOT NULL,
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT server_sounds_name_check CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 32),
    CONSTRAINT server_sounds_emoji_check CHECK (emoji IS NULL OR (emoji = btrim(emoji) AND char_length(emoji) BETWEEN 1 AND 16)),
    CONSTRAINT server_sounds_volume_check CHECK (volume >= 0 AND volume <= 1),
    CONSTRAINT server_sounds_duration_check CHECK (duration_ms BETWEEN 1 AND 5200),
    CONSTRAINT server_sounds_path_check CHECK (
        storage_path ~ ('^' || server_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp3|ogg|wav)$'))
);

CREATE INDEX IF NOT EXISTS idx_server_sounds_server ON public.server_sounds (server_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_server_sounds_storage_path ON public.server_sounds (storage_path);

COMMENT ON TABLE public.server_sounds IS
    'Soundboard clips of a local server; files in the soundboard storage bucket. At most 48 per server.';

-- Path shape {server_id}/{uuid}.{mp3|ogg|wav}; the server id, or NULL for any other name.
CREATE OR REPLACE FUNCTION public.soundboard_object_server(p_name text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp3|ogg|wav)$'
        THEN split_part(p_name, '/', 1)::uuid
    END
$$;

-- The caller may add, edit and remove the server's sounds: a local server's owner, an
-- instance admin, or an accepted member holding MANAGE_EMOJIS.
CREATE OR REPLACE FUNCTION public.can_manage_server_sounds(p_server_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT v.me IS NOT NULL
       AND EXISTS (
           SELECT 1 FROM public.servers s
            WHERE s.id = p_server_id
              AND s.is_local_server IS NOT FALSE
              AND (s.owner = v.me
                   OR public.is_current_user_admin()
                   OR (EXISTS (SELECT 1 FROM public.user_servers us
                                WHERE us.server_id = s.id
                                  AND us.user_id = v.me
                                  AND us.status = 'accepted')
                       AND public.has_permission(v.me, s.id, 'MANAGE_EMOJIS'))))
      FROM (SELECT public.get_current_profile_id() AS me) v;
$$;

-- Client inserts: created_by and created_at are the caller's and now; the file must exist in
-- the soundboard bucket within its 512 KB limit. Client updates: name, emoji and volume only.
CREATE OR REPLACE FUNCTION public.guard_server_sound_client_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_size bigint;
BEGIN
    IF COALESCE(current_setting('role', true), '') NOT IN ('anon', 'authenticated')
       OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        NEW.created_by := public.get_current_profile_id();
        NEW.created_at := now();
        IF to_regclass('storage.objects') IS NOT NULL THEN
            SELECT COALESCE((o.metadata ->> 'size')::bigint, 0) INTO v_size
              FROM storage.objects o
             WHERE o.bucket_id = 'soundboard'
               AND o.name = NEW.storage_path;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'SOUNDBOARD_FILE_MISSING: % is not in the soundboard bucket', NEW.storage_path
                    USING ERRCODE = '22023';
            END IF;
            IF v_size > 524288 THEN
                RAISE EXCEPTION 'SOUNDBOARD_FILE_TOO_LARGE: % bytes, at most 524288', v_size
                    USING ERRCODE = '22023';
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.server_id IS DISTINCT FROM OLD.server_id
       OR NEW.storage_path IS DISTINCT FROM OLD.storage_path
       OR NEW.duration_ms IS DISTINCT FROM OLD.duration_ms
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'a sound''s server and file are fixed' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS guard_server_sound_client_write ON public.server_sounds;
CREATE TRIGGER guard_server_sound_client_write
    BEFORE INSERT OR UPDATE ON public.server_sounds
    FOR EACH ROW EXECUTE FUNCTION public.guard_server_sound_client_write();

-- At most 48 sounds per server, for every writer. Concurrent inserts for one server serialize
-- on a transaction advisory lock.
CREATE OR REPLACE FUNCTION public.enforce_server_sound_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('server_sounds:' || NEW.server_id::text, 0));
    IF (SELECT count(*) FROM public.server_sounds WHERE server_id = NEW.server_id) >= 48 THEN
        RAISE EXCEPTION 'SOUNDBOARD_FULL: a server holds at most 48 sounds' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_server_sound_limit ON public.server_sounds;
CREATE TRIGGER enforce_server_sound_limit
    BEFORE INSERT ON public.server_sounds
    FOR EACH ROW EXECUTE FUNCTION public.enforce_server_sound_limit();

ALTER TABLE public.server_sounds ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS server_sounds_service_role ON public.server_sounds;
CREATE POLICY server_sounds_service_role ON public.server_sounds
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS server_sounds_select_member ON public.server_sounds;
CREATE POLICY server_sounds_select_member ON public.server_sounds
    FOR SELECT TO authenticated
    USING (server_id IN (SELECT public.current_user_server_ids())
           OR EXISTS (SELECT 1 FROM public.servers s
                       WHERE s.id = server_sounds.server_id
                         AND s.owner = (SELECT public.get_current_profile_id()))
           OR (SELECT public.is_current_user_admin()));

DROP POLICY IF EXISTS server_sounds_insert_manager ON public.server_sounds;
CREATE POLICY server_sounds_insert_manager ON public.server_sounds
    FOR INSERT TO authenticated
    WITH CHECK (public.can_manage_server_sounds(server_id));

DROP POLICY IF EXISTS server_sounds_update_manager ON public.server_sounds;
CREATE POLICY server_sounds_update_manager ON public.server_sounds
    FOR UPDATE TO authenticated
    USING (public.can_manage_server_sounds(server_id))
    WITH CHECK (public.can_manage_server_sounds(server_id));

DROP POLICY IF EXISTS server_sounds_delete_manager ON public.server_sounds;
CREATE POLICY server_sounds_delete_manager ON public.server_sounds
    FOR DELETE TO authenticated
    USING (public.can_manage_server_sounds(server_id));

REVOKE ALL ON public.server_sounds FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, DELETE ON public.server_sounds TO authenticated;
GRANT UPDATE (name, emoji, volume) ON public.server_sounds TO authenticated;
GRANT ALL ON public.server_sounds TO service_role;

-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.server_audit_sounds()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_keys constant text[] := ARRAY['name', 'emoji', 'volume'];
    v_row public.server_sounds := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;

    PERFORM public.server_audit_write(
        v_row.server_id,
        CASE TG_OP WHEN 'INSERT' THEN 'sound.create' WHEN 'UPDATE' THEN 'sound.update' ELSE 'sound.delete' END,
        'sound', v_row.id::text, v_row.name,
        public.server_audit_diff(
            CASE WHEN TG_OP <> 'INSERT' THEN public.server_audit_pick(to_jsonb(OLD), v_keys) END,
            CASE WHEN TG_OP <> 'DELETE' THEN public.server_audit_pick(to_jsonb(NEW), v_keys) END));
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_server_sounds_audit ON public.server_sounds;
CREATE TRIGGER z_server_sounds_audit
    AFTER INSERT OR DELETE ON public.server_sounds
    FOR EACH ROW EXECUTE FUNCTION public.server_audit_sounds();
DROP TRIGGER IF EXISTS z_server_sounds_audit_update ON public.server_sounds;
CREATE TRIGGER z_server_sounds_audit_update
    AFTER UPDATE ON public.server_sounds
    FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name
                       OR OLD.emoji IS DISTINCT FROM NEW.emoji
                       OR OLD.volume IS DISTINCT FROM NEW.volume)
    EXECUTE FUNCTION public.server_audit_sounds();

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.can_manage_server_sounds(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_server_sounds(uuid) TO authenticated, service_role;

-- Storage policies evaluate it as the uploading role.
REVOKE ALL ON FUNCTION public.soundboard_object_server(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.soundboard_object_server(text) TO authenticated, service_role;

DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('guard_server_sound_client_write', 'enforce_server_sound_limit', 'server_audit_sounds')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Bucket and storage policies
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF to_regclass('storage.objects') IS NULL OR to_regclass('storage.buckets') IS NULL THEN
        RAISE NOTICE 'storage schema absent, soundboard bucket and policies skipped';
        RETURN;
    END IF;

    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('soundboard', 'soundboard', true, 524288, ARRAY['audio/mpeg', 'audio/ogg', 'audio/wav'])
    ON CONFLICT (id) DO UPDATE SET
        public = true,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

    DROP POLICY IF EXISTS "Public read access for soundboard" ON storage.objects;
    CREATE POLICY "Public read access for soundboard" ON storage.objects
        AS PERMISSIVE FOR SELECT TO public
        USING (bucket_id = 'soundboard');

    DROP POLICY IF EXISTS "Soundboard managers can upload sounds" ON storage.objects;
    CREATE POLICY "Soundboard managers can upload sounds" ON storage.objects
        AS PERMISSIVE FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'soundboard'
                    AND public.can_manage_server_sounds(public.soundboard_object_server(name)));

    DROP POLICY IF EXISTS "Soundboard managers can delete sounds" ON storage.objects;
    CREATE POLICY "Soundboard managers can delete sounds" ON storage.objects
        AS PERMISSIVE FOR DELETE TO authenticated
        USING (bucket_id = 'soundboard'
               AND public.can_manage_server_sounds(public.soundboard_object_server(name)));
END;
$$;

COMMIT;
