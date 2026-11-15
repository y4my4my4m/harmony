-- Discord bridge sync: what the bridge bot may remove and restore, the emoji import race, and a
-- bound on what its removals leave behind.
--
-- Bridge imports. The bot deletes, removes or retires only rows it imported:
--   sound    discord_sound_id is set. Clients cannot set it (guard_server_sound_discord_link);
--            sounds are never linked by name.
--   sticker  discord_sticker_id is set. Stickers are never linked by name.
--   emoji    emoji_is_bridge_import: discord_emoji_id is set and the image is the object
--            <server>/discord/<snowflake>.<png|gif> bot-gateway stores. A member's upload that
--            bridge_import_server_emoji linked by name keeps its own image and is not one.
-- Any other row of the server raises 42501 with SOUND_NOT_LINKED, EMOJI_NOT_LINKED or
-- STICKER_NOT_LINKED.
--
-- Emoji removed by a person. emojis.bridge_removed_at equals deleted_at exactly when
-- bridge_remove_server_emoji set both. remove_emoji and restore_emoji do not write it, so a
-- later removal by a person has another deleted_at and the mark no longer matches.
-- bridge_import_server_emoji with p_update restores only a row whose mark matches; any other
-- removed row raises 42501 EMOJI_REMOVED. bridge_remove_server_emoji also deletes the emoji's
-- favorites, as remove_emoji does.
--
-- Import race (bridge_import_server_emoji). Two overlapping imports of one new Discord emoji:
-- the second waited on the per-server advisory lock, then met the first's row in the name check
-- and raised 23505. Under the lock the Discord id is read again and the row answered as
-- existing. The name and cap checks now precede 'invalid emoji url', so bot-gateway fetches an
-- image only for an emoji the server can take.
--
-- Eviction. bridge_evict_removed_emojis and bridge_evict_retired_stickers bound the rows the
-- bot's removals keep: per server the 500 most recently bridge-removed emoji and the 60 most
-- recently retired stickers stay (Discord's largest guild holds 250 static + 250 animated emoji
-- and 60 stickers). Called with p_ids NULL they list the rows past the bound as (id, path);
-- called with ids they delete those of the listed rows still past it. bot-gateway removes the
-- files between the two calls, so a failed file removal leaves the row for the next call.
-- Neither takes the per-server advisory lock: the imports lock a row, then take that lock, and
-- an eviction holding it while it waits for the row would deadlock with them.
-- A deleted retired sticker writes no second sticker.delete to the server audit log.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Sounds
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.guard_server_sound_discord_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF COALESCE(current_setting('role', true), '') IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'SOUND_DISCORD_LINK: discord_sound_id is set by the Discord bridge only'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

-- UPDATE needs no guard: the column grant to authenticated omits discord_sound_id.
DROP TRIGGER IF EXISTS guard_server_sound_discord_link ON public.server_sounds;
CREATE TRIGGER guard_server_sound_discord_link
    BEFORE INSERT ON public.server_sounds
    FOR EACH ROW WHEN (NEW.discord_sound_id IS NOT NULL)
    EXECUTE FUNCTION public.guard_server_sound_discord_link();

REVOKE ALL ON FUNCTION public.guard_server_sound_discord_link() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.guard_server_sound_discord_link() TO service_role;

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
  v_row public.server_sounds%ROWTYPE;
BEGIN
  PERFORM public.bridge_require_server_bot(p_bot_id, p_server_id);

  SELECT * INTO v_row FROM public.server_sounds s
   WHERE s.id = p_sound_id AND s.server_id = p_server_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_row.discord_sound_id IS NULL THEN
    RAISE EXCEPTION 'SOUND_NOT_LINKED: the bridge deletes only sounds it imported' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.server_sounds s WHERE s.id = v_row.id;
  RETURN v_row.storage_path;
END;
$$;

-- ---------------------------------------------------------------------------
-- Emoji
-- ---------------------------------------------------------------------------
ALTER TABLE public.emojis ADD COLUMN IF NOT EXISTS bridge_removed_at timestamptz;

CREATE OR REPLACE FUNCTION public.emoji_is_bridge_import(p_row public.emojis)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
  SELECT p_row.discord_emoji_id IS NOT NULL
     AND p_row.server_id IS NOT NULL
     AND COALESCE(p_row.url::text ~ ('/emojis/' || p_row.server_id::text || '/discord/'
                                     || p_row.discord_emoji_id || '\.(png|gif)$'), false);
$$;

REVOKE ALL ON FUNCTION public.emoji_is_bridge_import(public.emojis) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.emoji_is_bridge_import(public.emojis) TO service_role;

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
       SET name = p_name, deleted_at = NULL, deleted_by = NULL, bridge_removed_at = NULL, updated_at = now()
     WHERE e.id = v_row.id
    RETURNING * INTO v_row;
    RETURN QUERY SELECT 'updated'::text, v_row.id, v_row.name::text, v_row.url::text,
                        v_row.discord_emoji_id, false;
    RETURN;
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

CREATE OR REPLACE FUNCTION public.bridge_remove_server_emoji(
  p_bot_id uuid,
  p_server_id uuid,
  p_emoji_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_row public.emojis%ROWTYPE;
  v_now timestamptz := now();
BEGIN
  PERFORM public.bridge_require_server_bot(p_bot_id, p_server_id);

  SELECT * INTO v_row FROM public.emojis e
   WHERE e.id = p_emoji_id AND e.server_id = p_server_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'emoji not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.emoji_is_bridge_import(v_row) THEN
    RAISE EXCEPTION 'EMOJI_NOT_LINKED: the bridge removes only emoji it imported' USING ERRCODE = '42501';
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    RETURN 'existing';
  END IF;

  UPDATE public.emojis e
     SET deleted_at = v_now, deleted_by = NULL, bridge_removed_at = v_now, updated_at = v_now
   WHERE e.id = v_row.id;
  DELETE FROM public.emoji_favorites f WHERE f.emoji_id = v_row.id::text;
  RETURN 'removed';
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_evict_removed_emojis(
  p_bot_id uuid,
  p_server_id uuid,
  p_ids uuid[] DEFAULT NULL
)
RETURNS TABLE(id uuid, path text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
  -- Discord's largest guild: 250 static and 250 animated emoji.
  c_keep CONSTANT integer := 500;
BEGIN
  PERFORM public.bridge_require_server_bot(p_bot_id, p_server_id);

  IF p_ids IS NULL THEN
    RETURN QUERY
      SELECT e.id, substring(e.url::text FROM '/emojis/(.+)$')
        FROM public.emojis e
       WHERE e.server_id = p_server_id AND e.deleted_at IS NOT NULL
         AND e.bridge_removed_at = e.deleted_at AND public.emoji_is_bridge_import(e)
       ORDER BY e.deleted_at DESC, e.id
      OFFSET c_keep;
    RETURN;
  END IF;

  RETURN QUERY
    WITH past AS (
      SELECT e.id
        FROM public.emojis e
       WHERE e.server_id = p_server_id AND e.deleted_at IS NOT NULL
         AND e.bridge_removed_at = e.deleted_at AND public.emoji_is_bridge_import(e)
       ORDER BY e.deleted_at DESC, e.id
      OFFSET c_keep
    ), gone AS (
      DELETE FROM public.emojis e
       USING past
       WHERE e.id = past.id AND e.id = ANY (p_ids)
      RETURNING e.id, e.url
    ), favorites AS (
      DELETE FROM public.emoji_favorites f USING gone WHERE f.emoji_id = gone.id::text
    )
    SELECT gone.id, substring(gone.url::text FROM '/emojis/(.+)$') FROM gone;
END;
$$;

REVOKE ALL ON FUNCTION public.bridge_evict_removed_emojis(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_evict_removed_emojis(uuid, uuid, uuid[]) TO service_role;

-- ---------------------------------------------------------------------------
-- Stickers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.bridge_retire_server_sticker(
    p_bot_id uuid,
    p_server_id uuid,
    p_sticker_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.stickers%ROWTYPE;
BEGIN
    PERFORM public.bridge_require_server_bot(p_bot_id, p_server_id);

    SELECT * INTO v_row FROM public.stickers s
     WHERE s.id = p_sticker_id AND s.server_id = p_server_id AND s.scope = 'server'
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'sticker not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_row.discord_sticker_id IS NULL THEN
        RAISE EXCEPTION 'STICKER_NOT_LINKED: the bridge retires only stickers it imported' USING ERRCODE = '42501';
    END IF;
    IF v_row.removed_at IS NOT NULL THEN
        RETURN 'existing';
    END IF;

    UPDATE public.stickers s
       SET removed_at = now(), updated_at = now()
     WHERE s.id = v_row.id;
    RETURN 'removed';
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_evict_retired_stickers(
    p_bot_id uuid,
    p_server_id uuid,
    p_ids uuid[] DEFAULT NULL
)
RETURNS TABLE(id uuid, path text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
DECLARE
    -- Discord's largest guild: 60 stickers.
    c_keep CONSTANT integer := 60;
BEGIN
    PERFORM public.bridge_require_server_bot(p_bot_id, p_server_id);

    IF p_ids IS NULL THEN
        RETURN QUERY
          SELECT s.id, s.path
            FROM public.stickers s
           WHERE s.scope = 'server' AND s.server_id = p_server_id
             AND s.removed_at IS NOT NULL AND s.discord_sticker_id IS NOT NULL
           ORDER BY s.removed_at DESC, s.id
          OFFSET c_keep;
        RETURN;
    END IF;

    RETURN QUERY
      WITH past AS (
        SELECT s.id
          FROM public.stickers s
         WHERE s.scope = 'server' AND s.server_id = p_server_id
           AND s.removed_at IS NOT NULL AND s.discord_sticker_id IS NOT NULL
         ORDER BY s.removed_at DESC, s.id
        OFFSET c_keep
      ), gone AS (
        DELETE FROM public.stickers s
         USING past
         WHERE s.id = past.id AND s.id = ANY (p_ids)
        RETURNING s.id, s.path
      )
      SELECT gone.id, gone.path FROM gone;
END;
$$;

REVOKE ALL ON FUNCTION public.bridge_evict_retired_stickers(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_evict_retired_stickers(uuid, uuid, uuid[]) TO service_role;

-- The retirement already wrote sticker.delete; deleting the retired row writes nothing.
CREATE OR REPLACE FUNCTION public.server_audit_stickers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_keys constant text[] := ARRAY['name', 'description'];
    v_row public.stickers := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    v_action text;
    v_has_old boolean := TG_OP <> 'INSERT';
    v_has_new boolean := TG_OP <> 'DELETE';
BEGIN
    IF pg_trigger_depth() > 1 OR v_row.scope <> 'server' THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'DELETE' AND OLD.removed_at IS NOT NULL THEN
        RETURN NULL;
    END IF;

    v_action := CASE
        WHEN TG_OP = 'INSERT' THEN 'sticker.create'
        WHEN TG_OP = 'DELETE' THEN 'sticker.delete'
        WHEN OLD.removed_at IS NULL AND NEW.removed_at IS NOT NULL THEN 'sticker.delete'
        WHEN OLD.removed_at IS NOT NULL AND NEW.removed_at IS NULL THEN 'sticker.create'
        WHEN OLD.name IS DISTINCT FROM NEW.name OR OLD.description IS DISTINCT FROM NEW.description
            THEN 'sticker.update'
    END;
    IF v_action IS NULL THEN
        RETURN NULL;
    END IF;

    -- A retirement reads as a delete and a restore as a create.
    IF TG_OP = 'UPDATE' AND v_action = 'sticker.delete' THEN
        v_has_new := false;
    ELSIF TG_OP = 'UPDATE' AND v_action = 'sticker.create' THEN
        v_has_old := false;
    END IF;

    PERFORM public.server_audit_write(
        v_row.server_id, v_action, 'sticker', v_row.id::text, v_row.name,
        public.server_audit_diff(
            CASE WHEN v_has_old THEN public.server_audit_pick(to_jsonb(OLD), v_keys) END,
            CASE WHEN v_has_new THEN public.server_audit_pick(to_jsonb(NEW), v_keys) END));
    RETURN NULL;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
