-- Broadcasts for the federation round trip. Realtime is absent; realtime.send
-- (scripts/test-db/supabase-compat.sql) leaves each one in realtime.messages,
-- and roundtrip.ts reads a topic's payloads back through this function.
--
-- Loaded by stack.sh after the schema, as supabase_admin: realtime belongs to
-- that role.

CREATE OR REPLACE FUNCTION public.hmfed_broadcasts(p_topic text)
RETURNS SETOF jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = realtime, pg_temp
AS $$
    SELECT payload FROM realtime.messages WHERE topic = p_topic ORDER BY inserted_at, id;
$$;

REVOKE ALL ON FUNCTION public.hmfed_broadcasts(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.hmfed_broadcasts(text) TO service_role;
