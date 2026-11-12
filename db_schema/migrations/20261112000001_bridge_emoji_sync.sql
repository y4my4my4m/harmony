-- Discord bridge: rename, restore and soft removal of bridged server emoji.
--
-- Extends bridge_import_server_emoji (20261009400001_bridge_server_emojis.sql) with p_update and
-- a removed flag, and adds bridge_remove_server_emoji. Only the bot of the server's Discord
-- bridge may call them, through bot-gateway (service_role).
--
-- bridge_import_server_emoji(p_bot_id, p_server_id, p_discord_emoji_id, p_name, p_url, p_update)
-- Outcomes (status):
--   existing  the Discord emoji is already imported into this server and nothing changed; the
--             row is returned as is, removed telling whether it is soft-removed. Without
--             p_update a linked row is never touched, removed or not.
--   updated   p_update: the linked row was renamed (a case-only change counts) and/or restored
--             from removal (deleted_at and deleted_by cleared).
--   linked    an active server emoji with the same name (case-insensitive) and no Discord link
--             now carries this Discord id; a removed one is ignored
--   created   new server emoji row with p_url (bot-gateway has stored the image)
-- Errors: 42501 the bot does not bridge the server; 22023 invalid Discord id, name or url;
-- 23505 another active emoji of the server holds the name (rename, restore or create);
-- 23514 SERVER_EMOJI_LIMIT, the cap max_custom_emojis_per_server (0 is no limit) counts active
-- emoji and is checked on restore and create, under the same per-server advisory lock as
-- create_server_emoji and restore_emoji.
--
-- bridge_remove_server_emoji(p_bot_id, p_server_id, p_emoji_id)
-- Soft-removes the emoji like remove_emoji does: deleted_at = now(), deleted_by NULL (the bot
-- is no profile). Returns removed, or existing when it already was removed. 42501 as above;
-- P0002 when the emoji is not an emoji of this server.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- The return type changes, so the 5-argument form cannot be replaced in place.
DROP FUNCTION IF EXISTS public.bridge_import_server_emoji(uuid, uuid, text, text, text);

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
       SET name = p_name, deleted_at = NULL, deleted_by = NULL, updated_at = now()
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

  IF p_url IS NULL OR p_url !~ '^https?://' THEN
    RAISE EXCEPTION 'invalid emoji url' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('server_emojis:' || p_server_id::text, 0));
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
BEGIN
  PERFORM public.bridge_require_server_bot(p_bot_id, p_server_id);

  SELECT * INTO v_row FROM public.emojis e
   WHERE e.id = p_emoji_id AND e.server_id = p_server_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'emoji not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_row.deleted_at IS NOT NULL THEN
    RETURN 'existing';
  END IF;

  UPDATE public.emojis e
     SET deleted_at = now(), deleted_by = NULL, updated_at = now()
   WHERE e.id = v_row.id;
  RETURN 'removed';
END;
$$;

REVOKE ALL ON FUNCTION public.bridge_import_server_emoji(uuid, uuid, text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_import_server_emoji(uuid, uuid, text, text, text, boolean) TO service_role;
REVOKE ALL ON FUNCTION public.bridge_remove_server_emoji(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_remove_server_emoji(uuid, uuid, uuid) TO service_role;

-- server_audit_attribute_bot and its trigger attribute emoji.create, emoji.update and emoji.delete
-- to the bot in 20261112300001.

COMMIT;
