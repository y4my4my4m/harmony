-- Discord bridge: import, update and delete a linked Discord server's soundboard sounds.
--
-- server_sounds.discord_sound_id ties a server sound to the Discord sound it mirrors, one row per
-- (server, Discord sound). Discord sounds never change their audio, so an imported row keeps its
-- file for good; only name, emoji and volume follow Discord.
--
-- bridge_import_server_sound and bridge_delete_server_sound are the only bridge writers. Only the
-- bot of the server's Discord bridge may call them, through bot-gateway (service_role).
-- bridge_import_server_sound outcomes:
--   existing  the Discord sound is already imported into this server (or p_update found nothing
--             to change); the row is returned as is
--   updated   p_update is true and name, emoji, emoji_id or volume differed; they now match
--   created   new row; p_storage_path and p_duration_ms describe the clip bot-gateway has stored
-- A Discord sound not yet imported needs a valid p_storage_path and p_duration_ms, otherwise the
-- call raises 22023 'invalid sound file', which tells bot-gateway to download the clip first.
-- Sounds are never linked by name; the bridge plans replacements itself. created_by stays NULL.
-- The 48 sounds per server cap (enforce_server_sound_limit) still applies and raises
-- 23514 SOUNDBOARD_FULL on insert.
--
-- bridge_delete_server_sound removes one sound of the server and returns its storage_path, so
-- bot-gateway can delete the stored object; NULL when the server has no such sound.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.server_sounds ADD COLUMN IF NOT EXISTS discord_sound_id text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'server_sounds_discord_sound_id_check') THEN
    ALTER TABLE public.server_sounds ADD CONSTRAINT server_sounds_discord_sound_id_check
      CHECK (discord_sound_id IS NULL OR discord_sound_id ~ '^[0-9]{1,20}$');
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS server_sounds_server_discord_sound_key
  ON public.server_sounds (server_id, discord_sound_id) WHERE discord_sound_id IS NOT NULL;

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
  IF NOT EXISTS (
    SELECT 1 FROM public.discord_bridges b WHERE b.server_id = p_server_id AND b.bot_id = p_bot_id
  ) THEN
    RAISE EXCEPTION 'bot is not the Discord bridge of this server' USING ERRCODE = '42501';
  END IF;

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

  IF p_storage_path IS NULL
     OR p_storage_path !~ ('^' || p_server_id::text || '/[0-9a-f-]{36}\.(mp3|ogg)$')
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

CREATE OR REPLACE FUNCTION public.bridge_delete_server_sound(
  p_bot_id uuid,
  p_server_id uuid,
  p_sound_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_path text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.discord_bridges b WHERE b.server_id = p_server_id AND b.bot_id = p_bot_id
  ) THEN
    RAISE EXCEPTION 'bot is not the Discord bridge of this server' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.server_sounds s
   WHERE s.id = p_sound_id AND s.server_id = p_server_id
  RETURNING s.storage_path INTO v_path;
  RETURN v_path;
END;
$$;

REVOKE ALL ON FUNCTION public.bridge_import_server_sound(uuid, uuid, text, text, text, uuid, numeric, boolean, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_import_server_sound(uuid, uuid, text, text, text, uuid, numeric, boolean, text, integer) TO service_role;

REVOKE ALL ON FUNCTION public.bridge_delete_server_sound(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_delete_server_sound(uuid, uuid, uuid) TO service_role;

COMMIT;
