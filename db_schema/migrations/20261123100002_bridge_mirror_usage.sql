-- Bridge attachment mirror: running totals of the mirrored bytes, kept as objects come and go.
--
-- bridge_mirror_usage  one row per channel holding mirrored files: bytes, the sum of the
--                      metadata size (an unreadable size counts 0) of the message_media objects
--                      named c/<channel id>/bridge/..., the lowercase id. Triggers on
--                      storage.objects keep it on every write: an insert adds, a delete
--                      subtracts, an update moves the size between names. Uploads, storage
--                      removals, the message_media sweep and SQL deletes all pass them. The row
--                      goes with its channel (ON DELETE CASCADE): a deleted channel, and every
--                      channel of a deleted server, stops counting at once, as the computed sum
--                      did, and an object named for a channel that does not exist counts
--                      nowhere. Per channel rather than per server so that a channel deleted
--                      while a file uploads into it needs no lock beyond the foreign key's.
--                      Service role reads; only the triggers write.
--
-- A server's usage reads one row per channel holding mirrored files; before, every mirrored
-- object of the server, before each file and in bridge_mirror_status for every server.
-- Measured on supabase/postgres 15.8.1.060, 200k mirrored objects over 100 servers of 10
-- channels each, 100k other message_media objects: one server's usage 1.9 ms -> 0.07 ms,
-- stored_bytes of the status 205 ms -> 0.4 ms.
--
-- The rows are filled in this transaction after the triggers exist. CREATE TRIGGER holds SHARE
-- ROW EXCLUSIVE on storage.objects until COMMIT: reads go on, writes wait for the fill (one
-- index range per channel), and none falls between the count and the first tracked write.
--
--   bridge_mirror_usage_fill()          every channel's row recounted from storage.objects
--                                       under that lock. Owner only.
--   bridge_mirror_track_object()        trigger function of bridge_mirror_track_insert,
--                                       _update and _delete on storage.objects
--   bridge_mirror_server_bytes(server)  of 20261112800001, redefined: the sum of the rows of the
--                                       server's channels
--   bridge_mirror_status()              of 20261112800001, redefined: stored_bytes is the sum of
--                                       the rows of every channel that belongs to a server
--
-- Body otherwise, volatility, owner and grants as 20261112800001.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.bridge_mirror_usage (
    channel_id uuid PRIMARY KEY REFERENCES public.channels(id) ON DELETE CASCADE,
    bytes bigint NOT NULL DEFAULT 0,
    updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.bridge_mirror_usage IS
    'Bytes of mirrored Discord files (message_media c/<channel id>/bridge/...) per channel, kept by triggers on storage.objects. Service role reads.';

ALTER TABLE public.bridge_mirror_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bridge_mirror_usage_service_role ON public.bridge_mirror_usage;
CREATE POLICY bridge_mirror_usage_service_role ON public.bridge_mirror_usage
    AS PERMISSIVE FOR SELECT TO service_role USING (true);
REVOKE ALL ON public.bridge_mirror_usage FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.bridge_mirror_usage TO service_role;

-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bridge_mirror_track_object()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    -- The range of 20261112800001 compared 'c/' || channels.id::text: the lowercase id.
    v_path CONSTANT text := '^c/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/bridge/';
    v_channels uuid[] := ARRAY[]::uuid[];
    v_deltas bigint[] := ARRAY[]::bigint[];
    v_channel uuid;
    i integer;
BEGIN
    IF TG_OP <> 'INSERT' AND OLD.bucket_id = 'message_media' THEN
        v_channel := substring(OLD.name FROM v_path)::uuid;
        IF v_channel IS NOT NULL THEN
            v_channels := v_channels || v_channel;
            v_deltas := v_deltas || -(CASE WHEN OLD.metadata ->> 'size' ~ '^\d{1,18}$'
                                           THEN (OLD.metadata ->> 'size')::bigint ELSE 0 END);
        END IF;
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.bucket_id = 'message_media' THEN
        v_channel := substring(NEW.name FROM v_path)::uuid;
        IF v_channel IS NOT NULL THEN
            v_channels := v_channels || v_channel;
            v_deltas := v_deltas || (CASE WHEN NEW.metadata ->> 'size' ~ '^\d{1,18}$'
                                          THEN (NEW.metadata ->> 'size')::bigint ELSE 0 END);
        END IF;
    END IF;

    FOR i IN 1 .. coalesce(array_length(v_channels, 1), 0) LOOP
        CONTINUE WHEN v_deltas[i] = 0;
        BEGIN
            INSERT INTO public.bridge_mirror_usage AS u (channel_id, bytes)
            VALUES (v_channels[i], v_deltas[i])
            ON CONFLICT (channel_id) DO UPDATE
               SET bytes = u.bytes + EXCLUDED.bytes, updated_at = now();
        EXCEPTION WHEN foreign_key_violation THEN
            -- No such channel: its objects count toward no server.
            NULL;
        END;
    END LOOP;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.bridge_mirror_track_object() FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.bridge_mirror_usage_fill()
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    LOCK TABLE storage.objects IN SHARE ROW EXCLUSIVE MODE;
    DELETE FROM public.bridge_mirror_usage;
    -- storage-api's idx_objects_bucket_id_name (bucket_id, name COLLATE "C") serves each range;
    -- '0' is the character after '/'.
    INSERT INTO public.bridge_mirror_usage (channel_id, bytes)
    SELECT c.id,
           sum(CASE WHEN o.metadata ->> 'size' ~ '^\d{1,18}$' THEN (o.metadata ->> 'size')::bigint ELSE 0 END)
      FROM public.channels c
      JOIN storage.objects o
        ON o.bucket_id = 'message_media'
       AND o.name COLLATE "C" >= 'c/' || c.id::text || '/bridge/'
       AND o.name COLLATE "C" <  'c/' || c.id::text || '/bridge0'
     GROUP BY c.id;
END;
$$;

REVOKE ALL ON FUNCTION public.bridge_mirror_usage_fill() FROM PUBLIC, anon, authenticated, service_role;

DO $$
BEGIN
    IF to_regclass('storage.objects') IS NULL THEN
        RAISE NOTICE 'storage schema absent, bridge mirror usage triggers skipped';
        RETURN;
    END IF;
    -- CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE; DROP TRIGGER would take ACCESS
    -- EXCLUSIVE and stop reads too.
    CREATE OR REPLACE TRIGGER bridge_mirror_track_insert
        AFTER INSERT ON storage.objects
        FOR EACH ROW
        WHEN (NEW.bucket_id = 'message_media' AND NEW.name LIKE 'c/%/bridge/%')
        EXECUTE FUNCTION public.bridge_mirror_track_object();
    CREATE OR REPLACE TRIGGER bridge_mirror_track_update
        AFTER UPDATE ON storage.objects
        FOR EACH ROW
        WHEN (((OLD.bucket_id = 'message_media' AND OLD.name LIKE 'c/%/bridge/%')
               OR (NEW.bucket_id = 'message_media' AND NEW.name LIKE 'c/%/bridge/%'))
              AND (OLD.bucket_id, OLD.name, OLD.metadata ->> 'size')
                  IS DISTINCT FROM (NEW.bucket_id, NEW.name, NEW.metadata ->> 'size'))
        EXECUTE FUNCTION public.bridge_mirror_track_object();
    CREATE OR REPLACE TRIGGER bridge_mirror_track_delete
        AFTER DELETE ON storage.objects
        FOR EACH ROW
        WHEN (OLD.bucket_id = 'message_media' AND OLD.name LIKE 'c/%/bridge/%')
        EXECUTE FUNCTION public.bridge_mirror_track_object();
    PERFORM public.bridge_mirror_usage_fill();
END
$$;

-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bridge_mirror_server_bytes(p_server_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE(sum(u.bytes), 0)::bigint
      FROM public.channels c
      JOIN public.bridge_mirror_usage u ON u.channel_id = c.id
     WHERE c.server_id = p_server_id;
$$;

CREATE OR REPLACE FUNCTION public.bridge_mirror_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Only instance admins can read the mirror queue' USING ERRCODE = '42501';
    END IF;
    RETURN (
        SELECT jsonb_build_object(
            'queued', count(*) FILTER (WHERE q.state = 'queued'),
            'too_large', count(*) FILTER (WHERE q.state = 'too_large'),
            'too_large_bytes', COALESCE(sum(q.largest_bytes) FILTER (WHERE q.state = 'too_large'), 0),
            'failed', count(*) FILTER (WHERE q.state = 'failed'),
            'over_quota', count(*) FILTER (WHERE q.state = 'over_quota'),
            'stored_bytes', (SELECT COALESCE(sum(u.bytes), 0)
                               FROM public.bridge_mirror_usage u
                               JOIN public.channels c ON c.id = u.channel_id
                              WHERE c.server_id IS NOT NULL))
          FROM public.bridge_mirror_queue q);
END;
$$;

DO $$
DECLARE
    fn text;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.bridge_mirror_server_bytes(uuid)',
        'public.bridge_mirror_status()'
    ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END
$$;

GRANT EXECUTE ON FUNCTION public.bridge_mirror_status() TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
