-- Custom emoji on soundboard sounds.
--
-- server_sounds.emoji_id references public.emojis; ON DELETE SET NULL. A sound carries a
-- unicode emoji (emoji), a custom emoji (emoji_id), or neither, never both
-- (server_sounds_emoji_choice_check).
--
-- Client writes. emoji_id joins name, emoji and volume as a column clients update. A client
-- insert, or an update that changes emoji_id, must name an emoji the caller's picker offers:
-- instance scope, the caller's own user scope, or server scope of a server the caller owns or
-- is an accepted member of; anything else is a 22023 SOUNDBOARD_EMOJI_UNAVAILABLE. An
-- unchanged emoji_id passes, so any manager edits a sound whose emoji came from a server they
-- are not in.
--
-- Audit. sound.create, sound.update and sound.delete diff emoji_id with name, emoji and
-- volume. Clearing by the foreign key on emoji deletion is audited as a sound.update by the
-- deleter.
--
-- list_soundboard_library() and resolve_soundboard_sound(uuid, uuid) return emoji_id,
-- emoji_name and emoji_url (the emoji's full public URL) after emoji. The return types change,
-- so both are dropped and recreated; bodies, volatility, SECURITY DEFINER and grants are
-- otherwise those of 20261012300001_soundboard_external_sounds.sql.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.server_sounds
    ADD COLUMN IF NOT EXISTS emoji_id uuid
        CONSTRAINT server_sounds_emoji_id_fkey REFERENCES public.emojis(id) ON DELETE SET NULL;

ALTER TABLE public.server_sounds DROP CONSTRAINT IF EXISTS server_sounds_emoji_choice_check;
ALTER TABLE public.server_sounds
    ADD CONSTRAINT server_sounds_emoji_choice_check CHECK (emoji IS NULL OR emoji_id IS NULL);

-- Emoji deletion looks referencing sounds up by emoji_id.
CREATE INDEX IF NOT EXISTS idx_server_sounds_emoji ON public.server_sounds (emoji_id) WHERE emoji_id IS NOT NULL;

GRANT INSERT ON public.server_sounds TO authenticated;
GRANT UPDATE (name, emoji, emoji_id, volume) ON public.server_sounds TO authenticated;

-- Client inserts: created_by and created_at are the caller's and now; the file must exist in
-- the soundboard bucket within its 512 KB limit. Client updates: name, emoji, emoji_id and
-- volume only. A newly set emoji_id must be an emoji the caller may use.
CREATE OR REPLACE FUNCTION public.guard_server_sound_client_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_size bigint;
    v_me uuid;
BEGIN
    IF COALESCE(current_setting('role', true), '') NOT IN ('anon', 'authenticated')
       OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    v_me := public.get_current_profile_id();

    IF NEW.emoji_id IS NOT NULL
       AND (TG_OP = 'INSERT' OR NEW.emoji_id IS DISTINCT FROM OLD.emoji_id)
       AND NOT EXISTS (
           SELECT 1 FROM public.emojis e
            WHERE e.id = NEW.emoji_id
              AND (e.scope = 'instance'
                   OR (e.scope = 'user' AND e.uploader = v_me)
                   OR (e.scope = 'server'
                       AND (EXISTS (SELECT 1 FROM public.user_servers us
                                     WHERE us.server_id = e.server_id
                                       AND us.user_id = v_me
                                       AND us.status = 'accepted')
                            OR EXISTS (SELECT 1 FROM public.servers s
                                        WHERE s.id = e.server_id AND s.owner = v_me))))) THEN
        RAISE EXCEPTION 'SOUNDBOARD_EMOJI_UNAVAILABLE: emoji % is not one the caller may use', NEW.emoji_id
            USING ERRCODE = '22023';
    END IF;

    IF TG_OP = 'INSERT' THEN
        NEW.created_by := v_me;
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

CREATE OR REPLACE FUNCTION public.server_audit_sounds()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_keys constant text[] := ARRAY['name', 'emoji', 'emoji_id', 'volume'];
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

DROP TRIGGER IF EXISTS z_server_sounds_audit_update ON public.server_sounds;
CREATE TRIGGER z_server_sounds_audit_update
    AFTER UPDATE ON public.server_sounds
    FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name
                       OR OLD.emoji IS DISTINCT FROM NEW.emoji
                       OR OLD.emoji_id IS DISTINCT FROM NEW.emoji_id
                       OR OLD.volume IS DISTINCT FROM NEW.volume)
    EXECUTE FUNCTION public.server_audit_sounds();

-- ---------------------------------------------------------------------------
-- Library and resolver
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.list_soundboard_library();
CREATE FUNCTION public.list_soundboard_library()
RETURNS TABLE (
    id uuid,
    server_id uuid,
    server_name text,
    server_icon text,
    name text,
    emoji text,
    emoji_id uuid,
    emoji_name text,
    emoji_url text,
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
    SELECT ss.id, ss.server_id, s.name, s.icon, ss.name, ss.emoji, e.id, e.name::text, e.url::text,
           ss.volume, ss.duration_ms, ss.storage_path, ss.created_at
      FROM mine
      JOIN public.servers s ON s.id = mine.server_id AND s.is_local_server IS NOT FALSE
      JOIN public.server_sounds ss ON ss.server_id = s.id
      LEFT JOIN public.emojis e ON e.id = ss.emoji_id
      LEFT JOIN public.server_settings st ON st.server_id = s.id
     WHERE COALESCE(st.allow_cross_server_sounds, true)
     ORDER BY lower(s.name), s.id, ss.created_at, ss.id
$$;

DROP FUNCTION IF EXISTS public.resolve_soundboard_sound(uuid, uuid);
CREATE FUNCTION public.resolve_soundboard_sound(p_sound_id uuid, p_server_id uuid)
RETURNS TABLE (
    id uuid,
    server_id uuid,
    name text,
    emoji text,
    emoji_id uuid,
    emoji_name text,
    emoji_url text,
    volume numeric,
    duration_ms integer,
    storage_path text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT ss.id, ss.server_id, ss.name, ss.emoji, e.id, e.name::text, e.url::text,
           ss.volume, ss.duration_ms, ss.storage_path
      FROM public.server_sounds ss
      JOIN public.servers s ON s.id = ss.server_id
      LEFT JOIN public.emojis e ON e.id = ss.emoji_id
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

REVOKE ALL ON FUNCTION public.list_soundboard_library() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_soundboard_library() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.resolve_soundboard_sound(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_soundboard_sound(uuid, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.guard_server_sound_client_write() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_server_sound_client_write() TO service_role;

REVOKE ALL ON FUNCTION public.server_audit_sounds() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_audit_sounds() TO service_role;

COMMIT;
