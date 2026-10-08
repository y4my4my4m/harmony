-- Discord bridge: import a linked Discord server's custom emoji as Harmony server emoji.
--
-- emojis.discord_emoji_id ties a server emoji to the Discord emoji it mirrors, one row per
-- (server, Discord emoji). The bridge maps reactions and message emoji through it in both
-- directions, so a Discord reaction and a Harmony reaction with the same emoji count together.
--
-- bridge_import_server_emoji is the only writer. Only the bot of the server's Discord bridge may
-- call it, through bot-gateway (service_role). Outcomes:
--   existing  the Discord emoji is already imported into this server; the row is returned as is
--   linked    a server emoji with the same name (case-insensitive) and no Discord link now
--             carries this Discord id
--   created   new server emoji row with p_url (bot-gateway has stored the image)
-- Rerunning an import therefore never creates a second row for the same Discord emoji.

ALTER TABLE public.emojis ADD COLUMN IF NOT EXISTS discord_emoji_id text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'emojis_discord_emoji_id_check') THEN
    ALTER TABLE public.emojis ADD CONSTRAINT emojis_discord_emoji_id_check
      CHECK (discord_emoji_id IS NULL OR (discord_emoji_id ~ '^[0-9]{1,20}$' AND server_id IS NOT NULL));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS emojis_server_discord_emoji_key
  ON public.emojis (server_id, discord_emoji_id) WHERE discord_emoji_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.bridge_import_server_emoji(
  p_bot_id uuid,
  p_server_id uuid,
  p_discord_emoji_id text,
  p_name text,
  p_url text
)
RETURNS TABLE(status text, id uuid, name text, url text, discord_emoji_id text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
-- Output columns share names with emojis columns; references mean the table.
#variable_conflict use_column
DECLARE
  v_row public.emojis%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.discord_bridges b WHERE b.server_id = p_server_id AND b.bot_id = p_bot_id
  ) THEN
    RAISE EXCEPTION 'bot is not the Discord bridge of this server' USING ERRCODE = '42501';
  END IF;
  IF p_discord_emoji_id IS NULL OR p_discord_emoji_id !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'invalid Discord emoji id' USING ERRCODE = '22023';
  END IF;
  IF p_name IS NULL OR p_name !~ '^[A-Za-z0-9_]{1,32}$' THEN
    RAISE EXCEPTION 'invalid emoji name' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_row FROM public.emojis e
   WHERE e.server_id = p_server_id AND e.discord_emoji_id = p_discord_emoji_id;
  IF FOUND THEN
    RETURN QUERY SELECT 'existing'::text, v_row.id, v_row.name::text, v_row.url::text, v_row.discord_emoji_id;
    RETURN;
  END IF;

  UPDATE public.emojis e SET discord_emoji_id = p_discord_emoji_id, updated_at = now()
   WHERE e.id = (
     SELECT e2.id FROM public.emojis e2
      WHERE e2.server_id = p_server_id AND e2.discord_emoji_id IS NULL
        AND lower(e2.name::text) = lower(p_name)
      ORDER BY e2.created_at
      LIMIT 1
   )
  RETURNING * INTO v_row;
  IF FOUND THEN
    RETURN QUERY SELECT 'linked'::text, v_row.id, v_row.name::text, v_row.url::text, v_row.discord_emoji_id;
    RETURN;
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
    RETURN QUERY SELECT 'existing'::text, v_row.id, v_row.name::text, v_row.url::text, v_row.discord_emoji_id;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'created'::text, v_row.id, v_row.name::text, v_row.url::text, v_row.discord_emoji_id;
END;
$$;

REVOKE ALL ON FUNCTION public.bridge_import_server_emoji(uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_import_server_emoji(uuid, uuid, text, text, text) TO service_role;
