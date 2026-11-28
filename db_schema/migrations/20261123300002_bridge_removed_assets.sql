-- Bridge sync: what a person deletes stays deleted.
--
-- A sticker a manager deletes (delete_sticker), a sound a manager deletes (a client DELETE under
-- server_sounds_delete_manager) and an emoji an instance admin purges (admin_purge_emoji) are hard
-- deletes: the next sync found no row for the Discord item and downloaded it again. Emoji a
-- moderator removes keep their row and bridge_removed_at (20261112500001) and were not affected.
--
--   bridge_removed_assets          one row per (server, kind, platform, remote id) a person deleted.
--                                  kind emoji | sticker | sound; platform 'discord'. name is the
--                                  item's name when deleted. Service role only.
--   bridge_note_removed_sound      AFTER DELETE trigger on server_sounds, for a row with a Discord
--                                  link deleted by a client (role anon or authenticated). The
--                                  bridge's own deletes (bridge_delete_server_sound, service role)
--                                  write none; a cascade from the server's deletion runs after the
--                                  server row is gone and writes none.
--   admin_purge_emoji              as 20261107100001_emoji_lifecycle.sql; records a server emoji
--                                  with a Discord link.
--   delete_sticker                 as 20261031200001_custom_stickers.sql; records a server sticker
--                                  with a Discord link.
--   bridge_import_server_emoji     as 20261115920001_bridge_restore_and_relinks.sql; a Discord emoji
--                                  with no row and a record raises 42501 EMOJI_REMOVED before it is
--                                  linked by name or its image is fetched.
--   bridge_import_server_sticker   as 20261112300001_bridge_sticker_sync.sql; likewise 42501
--                                  STICKER_REMOVED, before 'invalid sticker file'.
--   bridge_import_server_sound     as 20261111900001_bridge_server_sounds.sql; likewise 42501
--                                  SOUND_REMOVED, before 'invalid sound file'.
-- Bridge evictions, retirements and removals write no record: an item the bridge removed comes
-- back when Discord offers it again. Discord ids are not reused, so a record outlives its item
-- harmlessly; it goes with the server.
-- Bodies otherwise, volatility, owners and grants as the migrations named above.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.bridge_removed_assets (
    id uuid NOT NULL DEFAULT gen_random_uuid(),
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    kind text NOT NULL,
    platform text NOT NULL,
    remote_id text NOT NULL,
    name text,
    removed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, kind, platform, remote_id),
    CONSTRAINT bridge_removed_assets_id_key UNIQUE (id),
    CONSTRAINT bridge_removed_assets_kind_check CHECK (kind IN ('emoji', 'sticker', 'sound')),
    CONSTRAINT bridge_removed_assets_platform_check CHECK (platform ~ '^[a-z][a-z0-9_]{1,31}$'),
    CONSTRAINT bridge_removed_assets_remote_id_check
        CHECK (char_length(remote_id) BETWEEN 1 AND 255 AND remote_id !~ '[[:cntrl:]]')
);

COMMENT ON TABLE public.bridge_removed_assets IS
    'Bridged emoji, stickers and sounds a person deleted on Harmony. A bridge sync does not copy them again.';

REVOKE ALL ON public.bridge_removed_assets FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.bridge_removed_assets TO service_role;

ALTER TABLE public.bridge_removed_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bridge_removed_assets_service_role ON public.bridge_removed_assets;
CREATE POLICY bridge_removed_assets_service_role ON public.bridge_removed_assets
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE OR REPLACE FUNCTION public.bridge_note_removed_sound()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF COALESCE(current_setting('role', true), '') IN ('anon', 'authenticated')
       AND EXISTS (SELECT 1 FROM public.servers s WHERE s.id = OLD.server_id) THEN
        INSERT INTO public.bridge_removed_assets (server_id, kind, platform, remote_id, name)
        VALUES (OLD.server_id, 'sound', 'discord', OLD.discord_sound_id, OLD.name)
        ON CONFLICT (server_id, kind, platform, remote_id)
            DO UPDATE SET name = EXCLUDED.name, removed_at = now();
    END IF;
    RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.bridge_note_removed_sound() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS z_server_sounds_note_removed ON public.server_sounds;
CREATE TRIGGER z_server_sounds_note_removed
    AFTER DELETE ON public.server_sounds
    FOR EACH ROW
    WHEN (OLD.discord_sound_id IS NOT NULL)
    EXECUTE FUNCTION public.bridge_note_removed_sound();

CREATE OR REPLACE FUNCTION public.admin_purge_emoji(p_emoji_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_row public.emojis;
    v_path text;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND (v_me IS NULL OR NOT public.is_current_user_admin()) THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_row FROM public.emojis e WHERE e.id = p_emoji_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Emoji not found' USING ERRCODE = 'P0002';
    END IF;

    v_path := public.emoji_object_path(v_row.url);
    IF v_path IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.emojis e
         WHERE e.id <> v_row.id
           AND right(e.url::text, char_length('/storage/v1/object/public/emojis/' || v_path))
               = '/storage/v1/object/public/emojis/' || v_path) THEN
        v_path := NULL;
    END IF;

    DELETE FROM public.emojis e WHERE e.id = p_emoji_id;
    DELETE FROM public.emoji_favorites f WHERE f.emoji_id = p_emoji_id::text;
    IF v_row.server_id IS NOT NULL AND v_row.discord_emoji_id IS NOT NULL THEN
        INSERT INTO public.bridge_removed_assets (server_id, kind, platform, remote_id, name)
        VALUES (v_row.server_id, 'emoji', 'discord', v_row.discord_emoji_id, v_row.name::text)
        ON CONFLICT (server_id, kind, platform, remote_id)
            DO UPDATE SET name = EXCLUDED.name, removed_at = now();
    END IF;

    IF v_me IS NOT NULL THEN
        PERFORM public.log_admin_action(v_me, 'emoji_purge', 'emoji', v_row.id::text,
                                        jsonb_build_object('name', v_row.name, 'url', v_row.url,
                                                           'scope', v_row.scope, 'server_id', v_row.server_id));
    END IF;
    RETURN v_path;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_sticker(p_sticker_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.stickers;
BEGIN
    IF public.get_current_profile_id() IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_row FROM public.stickers s WHERE s.id = p_sticker_id FOR UPDATE;
    IF NOT FOUND OR NOT (public.can_manage_sticker(v_row) OR public.is_current_user_admin_or_mod()) THEN
        RAISE EXCEPTION 'Sticker not found' USING ERRCODE = 'P0002';
    END IF;

    DELETE FROM public.stickers s WHERE s.id = p_sticker_id;
    IF v_row.server_id IS NOT NULL AND v_row.discord_sticker_id IS NOT NULL THEN
        INSERT INTO public.bridge_removed_assets (server_id, kind, platform, remote_id, name)
        VALUES (v_row.server_id, 'sticker', 'discord', v_row.discord_sticker_id, v_row.name)
        ON CONFLICT (server_id, kind, platform, remote_id)
            DO UPDATE SET name = EXCLUDED.name, removed_at = now();
    END IF;
    RETURN v_row.path;
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_import_server_emoji(
  p_bot_id uuid,
  p_server_id uuid,
  p_discord_emoji_id text,
  p_name text,
  p_url text,
  p_update boolean DEFAULT false
)
RETURNS TABLE(status text, id uuid, name text, url text, discord_emoji_id text, removed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
-- Output columns share names with emojis columns; references mean the table.
#variable_conflict use_column
DECLARE
  v_row public.emojis%ROWTYPE;
  v_cap integer;
BEGIN
  PERFORM public.bridge_require_server_bot(p_bot_id, p_server_id);
  IF p_discord_emoji_id IS NULL OR p_discord_emoji_id !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'invalid Discord emoji id' USING ERRCODE = '22023';
  END IF;
  IF p_name IS NULL OR p_name !~ '^[A-Za-z0-9_]{1,32}$' THEN
    RAISE EXCEPTION 'invalid emoji name' USING ERRCODE = '22023';
  END IF;

  v_cap := public.server_emoji_limit();

  SELECT * INTO v_row FROM public.emojis e
   WHERE e.server_id = p_server_id AND e.discord_emoji_id = p_discord_emoji_id
     FOR UPDATE;
  IF FOUND THEN
    IF NOT p_update
       OR (v_row.deleted_at IS NULL AND v_row.name::text = p_name) THEN
      RETURN QUERY SELECT 'existing'::text, v_row.id, v_row.name::text, v_row.url::text,
                          v_row.discord_emoji_id, (v_row.deleted_at IS NOT NULL);
      RETURN;
    END IF;
    IF v_row.deleted_at IS NOT NULL AND v_row.bridge_removed_at IS DISTINCT FROM v_row.deleted_at THEN
      RAISE EXCEPTION 'EMOJI_REMOVED: the bridge restores only emoji it removed' USING ERRCODE = '42501';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('server_emojis:' || p_server_id::text, 0));
    IF EXISTS (
      SELECT 1 FROM public.emojis e2
       WHERE e2.server_id = p_server_id AND e2.id <> v_row.id AND e2.deleted_at IS NULL
         AND lower(e2.name::text) = lower(p_name)
    ) THEN
      RAISE EXCEPTION 'An emoji named % exists', p_name USING ERRCODE = '23505';
    END IF;
    IF v_row.deleted_at IS NOT NULL AND v_cap > 0
       AND (SELECT count(*) FROM public.emojis e3
             WHERE e3.server_id = p_server_id AND e3.deleted_at IS NULL) >= v_cap THEN
      RAISE EXCEPTION 'SERVER_EMOJI_LIMIT: at most % emojis per server', v_cap USING ERRCODE = '23514';
    END IF;

    UPDATE public.emojis e
       SET name = p_name, deleted_at = NULL, deleted_by = NULL,
           -- A rename of a live row keeps the mark of a person's restore.
           bridge_removed_at = CASE WHEN e.deleted_at IS NULL THEN e.bridge_removed_at END,
           updated_at = now()
     WHERE e.id = v_row.id
    RETURNING * INTO v_row;
    RETURN QUERY SELECT 'updated'::text, v_row.id, v_row.name::text, v_row.url::text,
                        v_row.discord_emoji_id, false;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.bridge_removed_assets r
              WHERE r.server_id = p_server_id AND r.kind = 'emoji' AND r.platform = 'discord'
                AND r.remote_id = p_discord_emoji_id) THEN
    RAISE EXCEPTION 'EMOJI_REMOVED: an instance admin purged this emoji; the bridge does not copy it again'
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.emojis e SET discord_emoji_id = p_discord_emoji_id, updated_at = now()
   WHERE e.id = (
     SELECT e2.id FROM public.emojis e2
      WHERE e2.server_id = p_server_id AND e2.discord_emoji_id IS NULL AND e2.deleted_at IS NULL
        AND lower(e2.name::text) = lower(p_name)
      ORDER BY e2.created_at
      LIMIT 1
   )
  RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN QUERY SELECT 'linked'::text, v_row.id, v_row.name::text, v_row.url::text,
                        v_row.discord_emoji_id, false;
    RETURN;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('server_emojis:' || p_server_id::text, 0));
  -- An import of the same Discord emoji that held the lock has committed its row by now.
  SELECT * INTO v_row FROM public.emojis e
   WHERE e.server_id = p_server_id AND e.discord_emoji_id = p_discord_emoji_id;
  IF FOUND THEN
    RETURN QUERY SELECT 'existing'::text, v_row.id, v_row.name::text, v_row.url::text,
                        v_row.discord_emoji_id, (v_row.deleted_at IS NOT NULL);
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.emojis e2
     WHERE e2.server_id = p_server_id AND e2.deleted_at IS NULL
       AND lower(e2.name::text) = lower(p_name)
  ) THEN
    RAISE EXCEPTION 'An emoji named % exists', p_name USING ERRCODE = '23505';
  END IF;
  IF v_cap > 0 AND (SELECT count(*) FROM public.emojis e3
                     WHERE e3.server_id = p_server_id AND e3.deleted_at IS NULL) >= v_cap THEN
    RAISE EXCEPTION 'SERVER_EMOJI_LIMIT: at most % emojis per server', v_cap USING ERRCODE = '23514';
  END IF;

  IF p_url IS NULL OR p_url !~ '^https?://' THEN
    RAISE EXCEPTION 'invalid emoji url' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.emojis (name, url, server_id, scope, discord_emoji_id)
  VALUES (p_name, p_url, p_server_id, 'server', p_discord_emoji_id)
  ON CONFLICT (server_id, discord_emoji_id) WHERE discord_emoji_id IS NOT NULL DO NOTHING
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    SELECT * INTO v_row FROM public.emojis e
     WHERE e.server_id = p_server_id AND e.discord_emoji_id = p_discord_emoji_id;
    RETURN QUERY SELECT 'existing'::text, v_row.id, v_row.name::text, v_row.url::text,
                        v_row.discord_emoji_id, (v_row.deleted_at IS NOT NULL);
    RETURN;
  END IF;
  RETURN QUERY SELECT 'created'::text, v_row.id, v_row.name::text, v_row.url::text,
                      v_row.discord_emoji_id, false;
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_import_server_sticker(
    p_bot_id uuid,
    p_server_id uuid,
    p_discord_sticker_id text,
    p_name text,
    p_description text,
    p_update boolean DEFAULT false,
    p_path text DEFAULT NULL,
    p_url text DEFAULT NULL,
    p_width integer DEFAULT NULL,
    p_height integer DEFAULT NULL,
    p_duration_ms integer DEFAULT NULL
)
RETURNS TABLE(status text, id uuid, name text, description text, url text, discord_sticker_id text, removed boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
-- Output columns share names with stickers columns; references mean the table.
#variable_conflict use_column
DECLARE
    v_name text;
    v_description text;
    v_row public.stickers%ROWTYPE;
    v_prefix text := 'server/' || p_server_id::text || '/';
    v_limit integer;
    v_meta jsonb;
    v_size text;
    v_mime text;
    v_ext text;
    v_constraint text;
BEGIN
    PERFORM public.bridge_require_server_bot(p_bot_id, p_server_id);
    IF p_discord_sticker_id IS NULL OR p_discord_sticker_id !~ '^[0-9]{1,20}$' THEN
        RAISE EXCEPTION 'invalid Discord sticker id' USING ERRCODE = '22023';
    END IF;
    v_name := btrim(p_name);
    v_description := btrim(p_description);
    PERFORM public.sticker_check_text(v_name, v_description);

    SELECT * INTO v_row FROM public.stickers s
     WHERE s.server_id = p_server_id AND s.discord_sticker_id = p_discord_sticker_id AND s.scope = 'server'
       FOR UPDATE;
    IF FOUND THEN
        IF NOT p_update
           OR (v_row.removed_at IS NULL AND v_row.name = v_name AND v_row.description = v_description) THEN
            RETURN QUERY SELECT 'existing'::text, v_row.id, v_row.name, v_row.description, v_row.url,
                                v_row.discord_sticker_id, (v_row.removed_at IS NOT NULL);
            RETURN;
        END IF;

        PERFORM pg_advisory_xact_lock(hashtextextended('stickers:server:' || p_server_id::text, 0));
        IF EXISTS (
            SELECT 1 FROM public.stickers s2
             WHERE s2.scope = 'server' AND s2.server_id = p_server_id AND s2.id <> v_row.id
               AND s2.removed_at IS NULL AND lower(s2.name) = lower(v_name)
        ) THEN
            RAISE EXCEPTION 'STICKER_NAME_TAKEN: % is taken', v_name USING ERRCODE = '23505';
        END IF;
        IF v_row.removed_at IS NOT NULL THEN
            v_limit := public.sticker_limit('server');
            IF (SELECT count(*) FROM public.stickers s3
                 WHERE s3.scope = 'server' AND s3.server_id = p_server_id AND s3.removed_at IS NULL) >= v_limit THEN
                RAISE EXCEPTION 'STICKER_LIMIT: at most % server stickers', v_limit USING ERRCODE = '23514';
            END IF;
        END IF;

        UPDATE public.stickers s
           SET name = v_name, description = v_description, removed_at = NULL, updated_at = now()
         WHERE s.id = v_row.id
        RETURNING * INTO v_row;
        RETURN QUERY SELECT 'updated'::text, v_row.id, v_row.name, v_row.description, v_row.url,
                            v_row.discord_sticker_id, false;
        RETURN;
    END IF;

    IF EXISTS (SELECT 1 FROM public.bridge_removed_assets r
                WHERE r.server_id = p_server_id AND r.kind = 'sticker' AND r.platform = 'discord'
                  AND r.remote_id = p_discord_sticker_id) THEN
        RAISE EXCEPTION 'STICKER_REMOVED: a person deleted this sticker on Harmony; the bridge does not copy it again'
            USING ERRCODE = '42501';
    END IF;
    IF p_path IS NULL THEN
        RAISE EXCEPTION 'invalid sticker file' USING ERRCODE = '22023';
    END IF;

    -- The file checks of create_sticker for scope server.
    IF p_path !~ ('^' || v_prefix
        || '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|apng|webp|gif)$') THEN
        RAISE EXCEPTION 'STICKER_PATH: a sticker file is %<uuid>.<png|apng|webp|gif>', v_prefix
            USING ERRCODE = '22023';
    END IF;
    IF NOT public.is_storage_public_url(p_url, 'stickers', p_path) THEN
        RAISE EXCEPTION 'STICKER_URL: the url is not the public URL of %', p_path USING ERRCODE = '22023';
    END IF;
    IF p_width IS NULL OR p_height IS NULL OR p_width NOT BETWEEN 1 AND 320 OR p_height NOT BETWEEN 1 AND 320 THEN
        RAISE EXCEPTION 'STICKER_DIMENSIONS: a sticker is at most 320x320 pixels' USING ERRCODE = '22023';
    END IF;
    IF p_duration_ms IS NOT NULL AND p_duration_ms NOT BETWEEN 1 AND 5000 THEN
        RAISE EXCEPTION 'STICKER_DURATION: an animated sticker runs at most 5 seconds' USING ERRCODE = '22023';
    END IF;

    SELECT o.metadata INTO v_meta
      FROM storage.objects o
     WHERE o.bucket_id = 'stickers'
       AND o.name = p_path;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'STICKER_FILE_MISSING: % is not in the stickers bucket', p_path USING ERRCODE = '22023';
    END IF;
    v_size := v_meta ->> 'size';
    IF v_size IS NULL OR v_size !~ '^[0-9]{1,12}$' OR v_size::bigint NOT BETWEEN 1 AND 524288 THEN
        RAISE EXCEPTION 'STICKER_FILE_SIZE: a sticker file is at most 512 KB' USING ERRCODE = '22023';
    END IF;
    v_mime := lower(v_meta ->> 'mimetype');
    v_ext := substring(p_path from '\.([a-z]+)$');
    IF NOT ((v_ext IN ('png', 'apng') AND v_mime IN ('image/png', 'image/apng'))
            OR (v_ext = 'webp' AND v_mime = 'image/webp')
            OR (v_ext = 'gif' AND v_mime = 'image/gif')) THEN
        RAISE EXCEPTION 'STICKER_FILE_TYPE: a sticker is PNG, APNG, WebP or GIF' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.stickers (scope, server_id, uploader, name, description, path, url, mime_type,
                                 file_size, width, height, duration_ms, discord_sticker_id)
    VALUES ('server', p_server_id, NULL, v_name, v_description, p_path, p_url, v_mime, v_size::integer,
            p_width, p_height, p_duration_ms, p_discord_sticker_id)
    ON CONFLICT (server_id, discord_sticker_id) WHERE discord_sticker_id IS NOT NULL DO NOTHING
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
        SELECT * INTO v_row FROM public.stickers s
         WHERE s.server_id = p_server_id AND s.discord_sticker_id = p_discord_sticker_id;
        RETURN QUERY SELECT 'existing'::text, v_row.id, v_row.name, v_row.description, v_row.url,
                            v_row.discord_sticker_id, (v_row.removed_at IS NOT NULL);
        RETURN;
    END IF;
    RETURN QUERY SELECT 'created'::text, v_row.id, v_row.name, v_row.description, v_row.url,
                        v_row.discord_sticker_id, false;
EXCEPTION
    WHEN unique_violation THEN
        GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
        IF v_constraint = 'stickers_path_key' THEN
            RAISE EXCEPTION 'STICKER_FILE_TAKEN: % is another sticker''s file', p_path USING ERRCODE = '23505';
        END IF;
        RAISE EXCEPTION 'STICKER_NAME_TAKEN: % is taken', v_name USING ERRCODE = '23505';
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_import_server_sound(
  p_bot_id uuid,
  p_server_id uuid,
  p_discord_sound_id text,
  p_name text,
  p_emoji text,
  p_emoji_id uuid,
  p_volume numeric,
  p_update boolean,
  p_storage_path text,
  p_duration_ms integer
)
RETURNS TABLE(status text, id uuid, name text, emoji text, emoji_id uuid, volume numeric, discord_sound_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
-- Output columns share names with server_sounds columns; references mean the table.
#variable_conflict use_column
DECLARE
  v_row public.server_sounds%ROWTYPE;
BEGIN
  PERFORM public.bridge_require_server_bot(p_bot_id, p_server_id);

  IF p_discord_sound_id IS NULL OR p_discord_sound_id !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'invalid Discord sound id' USING ERRCODE = '22023';
  END IF;
  IF p_name IS NULL OR p_name <> btrim(p_name) OR char_length(p_name) NOT BETWEEN 1 AND 32 THEN
    RAISE EXCEPTION 'invalid sound name' USING ERRCODE = '22023';
  END IF;
  IF p_emoji IS NOT NULL AND p_emoji_id IS NOT NULL THEN
    RAISE EXCEPTION 'invalid sound emoji' USING ERRCODE = '22023';
  END IF;
  IF p_emoji IS NOT NULL AND (p_emoji <> btrim(p_emoji) OR char_length(p_emoji) NOT BETWEEN 1 AND 16) THEN
    RAISE EXCEPTION 'invalid sound emoji' USING ERRCODE = '22023';
  END IF;
  IF p_emoji_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.emojis e
     WHERE e.id = p_emoji_id AND (e.server_id = p_server_id OR e.scope = 'instance')
  ) THEN
    RAISE EXCEPTION 'invalid sound emoji' USING ERRCODE = '22023';
  END IF;
  IF p_volume IS NULL OR p_volume < 0 OR p_volume > 1 THEN
    RAISE EXCEPTION 'invalid sound volume' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM public.server_sounds s
   WHERE s.server_id = p_server_id AND s.discord_sound_id = p_discord_sound_id;
  IF FOUND THEN
    IF p_update AND (v_row.name IS DISTINCT FROM p_name
                     OR v_row.emoji IS DISTINCT FROM p_emoji
                     OR v_row.emoji_id IS DISTINCT FROM p_emoji_id
                     OR v_row.volume IS DISTINCT FROM round(p_volume, 2)) THEN
      UPDATE public.server_sounds s
         SET name = p_name, emoji = p_emoji, emoji_id = p_emoji_id, volume = p_volume
       WHERE s.id = v_row.id
      RETURNING * INTO v_row;
      RETURN QUERY SELECT 'updated'::text, v_row.id, v_row.name, v_row.emoji, v_row.emoji_id,
                          v_row.volume::numeric, v_row.discord_sound_id;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'existing'::text, v_row.id, v_row.name, v_row.emoji, v_row.emoji_id,
                        v_row.volume::numeric, v_row.discord_sound_id;
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM public.bridge_removed_assets r
              WHERE r.server_id = p_server_id AND r.kind = 'sound' AND r.platform = 'discord'
                AND r.remote_id = p_discord_sound_id) THEN
    RAISE EXCEPTION 'SOUND_REMOVED: a person deleted this sound on Harmony; the bridge does not copy it again'
      USING ERRCODE = '42501';
  END IF;

  IF p_storage_path IS NULL
     OR p_storage_path !~ ('^' || p_server_id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp3|ogg)$')
     OR p_duration_ms IS NULL OR p_duration_ms NOT BETWEEN 1 AND 5200 THEN
    RAISE EXCEPTION 'invalid sound file' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.server_sounds (server_id, name, emoji, emoji_id, volume, duration_ms, storage_path, discord_sound_id)
  VALUES (p_server_id, p_name, p_emoji, p_emoji_id, p_volume, p_duration_ms, p_storage_path, p_discord_sound_id)
  ON CONFLICT (server_id, discord_sound_id) WHERE discord_sound_id IS NOT NULL DO NOTHING
  RETURNING * INTO v_row;
  IF NOT FOUND THEN
    SELECT * INTO v_row FROM public.server_sounds s
     WHERE s.server_id = p_server_id AND s.discord_sound_id = p_discord_sound_id;
    RETURN QUERY SELECT 'existing'::text, v_row.id, v_row.name, v_row.emoji, v_row.emoji_id,
                        v_row.volume::numeric, v_row.discord_sound_id;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'created'::text, v_row.id, v_row.name, v_row.emoji, v_row.emoji_id,
                      v_row.volume::numeric, v_row.discord_sound_id;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
