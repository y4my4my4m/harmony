-- harmony:no-transaction
--
-- A history import leaves a Discord message alone when its Harmony copy was deleted.
--
-- Deleting a message keeps the row (is_deleted). The import counted only live rows as present
-- (bridge_import_present_ids) and inserted under the conflict target of
-- messages_channel_discord_message_id_unique, which is partial on is_deleted IS NOT TRUE: a relayed
-- message a moderator deleted, whose Discord original stayed (a to_harmony pair, or a bot without
-- Manage Messages), came back as a live row with every import, and its deletion was never told to
-- the bridge (the dispatcher skips history_import rows).
--
--   messages_channel_discord_message_id_deleted
--       the deleted rows that hold a Discord message id, per channel. Built CONCURRENTLY, as
--       20261110900002; an interrupted build leaves an invalid index, dropped before the next.
--   bridge_import_present_ids
--       as 20261110900005; a deleted row counts as present.
--   skip_deleted_discord_import (BEFORE INSERT ON messages, history_import rows with a Discord id)
--       an imported row whose Discord id has a deleted row in the channel is not inserted. The
--       import functions count a row not inserted as skipped. Clients cannot set history_import
--       (20261110900007).

SET lock_timeout = '5s';

DO $$
BEGIN
    IF EXISTS (SELECT 1
                 FROM pg_index x
                 JOIN pg_class c ON c.oid = x.indexrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relname = 'messages_channel_discord_message_id_deleted'
                  AND NOT x.indisvalid) THEN
        DROP INDEX public.messages_channel_discord_message_id_deleted;
    END IF;
END
$$;

-- A concurrent build waits for transactions open before it; lock_timeout bounds each wait.
SET lock_timeout = '10min';

CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_channel_discord_message_id_deleted
    ON public.messages (channel_id, (metadata->>'discord_message_id'))
    WHERE channel_id IS NOT NULL AND metadata ? 'discord_message_id' AND is_deleted IS TRUE;

RESET lock_timeout;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1
                     FROM pg_index x
                    WHERE x.indexrelid = to_regclass('public.messages_channel_discord_message_id_deleted')
                      AND x.indisvalid) THEN
        RAISE EXCEPTION 'messages_channel_discord_message_id_deleted is not valid; run 20261115200001 again';
    END IF;
END
$$;

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.bridge_import_present_ids(p_bot_id uuid, p_import_id uuid, p_ids text[])
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel uuid;
BEGIN
    SELECT i.harmony_channel_id INTO v_channel
      FROM public.discord_bridge_imports i
      JOIN public.discord_bridges b ON b.id = i.bridge_id
     WHERE i.id = p_import_id AND b.bot_id = p_bot_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'import_not_found' USING ERRCODE = 'P0002';
    END IF;

    -- Live rows, then deleted ones: each predicate is that of one partial index.
    RETURN COALESCE((
        SELECT array_agg(DISTINCT d.id)
          FROM (SELECT m.metadata ->> 'discord_message_id' AS id
                  FROM public.messages m
                 WHERE m.channel_id = v_channel
                   AND m.metadata ? 'discord_message_id'
                   AND m.metadata ->> 'discord_message_id' = ANY (p_ids)
                   AND m.is_deleted IS NOT TRUE
                UNION ALL
                SELECT m.metadata ->> 'discord_message_id'
                  FROM public.messages m
                 WHERE m.channel_id = v_channel
                   AND m.metadata ? 'discord_message_id'
                   AND m.metadata ->> 'discord_message_id' = ANY (p_ids)
                   AND m.is_deleted IS TRUE) d
    ), ARRAY[]::text[]);
END;
$$;


CREATE OR REPLACE FUNCTION public.skip_deleted_discord_import()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF EXISTS (SELECT 1
                 FROM public.messages m
                WHERE m.channel_id = NEW.channel_id
                  AND m.metadata ? 'discord_message_id'
                  AND m.metadata ->> 'discord_message_id' = NEW.metadata ->> 'discord_message_id'
                  AND m.is_deleted IS TRUE) THEN
        RETURN NULL;
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.skip_deleted_discord_import() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_messages_skip_deleted_discord_import ON public.messages;
CREATE TRIGGER a_messages_skip_deleted_discord_import
    BEFORE INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.channel_id IS NOT NULL AND NEW.metadata ? 'history_import' AND NEW.metadata ? 'discord_message_id')
    EXECUTE FUNCTION public.skip_deleted_discord_import();

COMMIT;

NOTIFY pgrst, 'reload schema';
