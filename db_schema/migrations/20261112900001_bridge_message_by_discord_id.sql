-- The live message of a channel that holds a Discord message id, by an index scan.
--
-- messages_channel_discord_message_id_unique (20261110900002) is partial on
-- metadata ? 'discord_message_id'. The planner uses it only for a query that states that
-- condition, and PostgREST has no filter for jsonb ?. A select filtered on
-- metadata->>discord_message_id reads every message of the channel; with ORDER BY created_at
-- LIMIT 1, a lookup of an id the channel does not hold walks idx_messages_created to its end.
--
-- Measured on supabase/postgres 15.8.1.060, a channel of 101k messages in a table of 401k, an id
-- the channel does not hold: 121 ms by the select, 0.2 ms by this function.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- At most one row: the index is unique over the rows the WHERE clause admits. NULL when no live
-- message of the channel holds the id.
CREATE OR REPLACE FUNCTION public.bridge_message_by_discord_id(p_channel_id uuid, p_discord_message_id text)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT m.id
      FROM public.messages m
     WHERE m.channel_id = p_channel_id
       AND m.metadata ? 'discord_message_id'
       AND m.metadata ->> 'discord_message_id' = p_discord_message_id
       AND m.is_deleted IS NOT TRUE;
$$;

REVOKE ALL ON FUNCTION public.bridge_message_by_discord_id(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bridge_message_by_discord_id(uuid, text) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
