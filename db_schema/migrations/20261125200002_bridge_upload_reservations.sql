-- Bot uploads, mirrored files and bridge avatars claim their bytes of the server's cap before they
-- are read and stored. bridge_mirror_allows read the stored bytes alone: files in flight at once
-- each saw the usage without the others and overshot the cap together.
--
-- bridge_upload_reservations  one row per file in flight: the server it is stored for and its bytes
--                             so far as known; avatar_bot_id for a bridge avatar. Dropped when the
--                             file is stored (storage.objects counts it from then on) or given up.
--                             expires_at, 1800 s after the last claim (the mirror worker's lease),
--                             ends a claim whose gateway died. Service role reads.
--
--   bridge_upload_reserve(reservation, channel, bytes, avatar bot, max avatars) -> boolean
--       Claims `bytes` in all for the channel's server under the caller's reservation id, whatever
--       the id claimed before. false, and no reservation, when the cap has no room, the channel is
--       unknown or has no server, or the avatar bot already holds `max avatars` avatars, the ones
--       in flight included. One claim at a time per server (and per avatar bot), so each reads the
--       claims before it.
--   bridge_upload_release(reservation)
--   bridge_mirror_allows(channel, bytes)
--       of 20261112800001, redefined: bytes in flight count as stored ones
--
-- Until a reservation of a stored file is released both count: the server reads fuller than it is
-- for that long. Service role only. Grants of bridge_mirror_allows as 20261112800001.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.bridge_upload_reservations (
    id uuid PRIMARY KEY,
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    avatar_bot_id uuid,
    bytes bigint NOT NULL,
    expires_at timestamptz NOT NULL,
    CONSTRAINT bridge_upload_reservations_bytes_check CHECK (bytes >= 0)
);

CREATE INDEX IF NOT EXISTS bridge_upload_reservations_server_idx ON public.bridge_upload_reservations (server_id);
CREATE INDEX IF NOT EXISTS bridge_upload_reservations_avatar_bot_idx
    ON public.bridge_upload_reservations (avatar_bot_id) WHERE avatar_bot_id IS NOT NULL;

COMMENT ON TABLE public.bridge_upload_reservations IS
    'Bytes of files bots and bridges are storing at the moment, per server. Written through bridge_upload_reserve and bridge_upload_release. Service role reads.';

ALTER TABLE public.bridge_upload_reservations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bridge_upload_reservations_service_role ON public.bridge_upload_reservations;
CREATE POLICY bridge_upload_reservations_service_role ON public.bridge_upload_reservations
    AS PERMISSIVE FOR SELECT TO service_role USING (true);
REVOKE ALL ON public.bridge_upload_reservations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.bridge_upload_reservations TO service_role;

-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bridge_mirror_allows(p_channel_id uuid, p_bytes bigint)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_limit_mb integer := public.instance_count_cap('bridge_mirror_server_limit_mb', 5120);
    v_server uuid;
BEGIN
    SELECT c.server_id INTO v_server FROM public.channels c WHERE c.id = p_channel_id;
    IF v_server IS NULL THEN
        RETURN false;
    END IF;
    IF v_limit_mb = 0 THEN
        RETURN true;
    END IF;
    RETURN public.bridge_mirror_server_bytes(v_server)
           + COALESCE((SELECT sum(r.bytes)
                         FROM public.bridge_upload_reservations r
                        WHERE r.server_id = v_server AND r.expires_at > now()), 0)
           + GREATEST(COALESCE(p_bytes, 0), 0)
           <= v_limit_mb::bigint * 1048576;
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_upload_reserve(
    p_reservation_id uuid,
    p_channel_id uuid,
    p_bytes bigint,
    p_avatar_bot_id uuid DEFAULT NULL,
    p_max_avatars integer DEFAULT NULL)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server uuid;
BEGIN
    SELECT c.server_id INTO v_server FROM public.channels c WHERE c.id = p_channel_id;
    IF p_reservation_id IS NULL OR v_server IS NULL THEN
        RETURN false;
    END IF;

    IF p_avatar_bot_id IS NOT NULL THEN
        PERFORM pg_advisory_xact_lock(hashtextextended('bridge_avatars:' || p_avatar_bot_id::text, 0));
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('bridge_upload:' || v_server::text, 0));

    DELETE FROM public.bridge_upload_reservations r
     WHERE r.id = p_reservation_id
        OR (r.server_id = v_server AND r.expires_at <= now());

    IF p_avatar_bot_id IS NOT NULL
       AND (SELECT COALESCE(sum(a.objects), 0) FROM public.bridge_avatar_usage a WHERE a.bot_id = p_avatar_bot_id)
         + (SELECT count(*) FROM public.bridge_upload_reservations r
             WHERE r.avatar_bot_id = p_avatar_bot_id AND r.expires_at > now())
           >= COALESCE(p_max_avatars, 0) THEN
        RETURN false;
    END IF;
    IF NOT public.bridge_mirror_allows(p_channel_id, p_bytes) THEN
        RETURN false;
    END IF;

    INSERT INTO public.bridge_upload_reservations (id, server_id, avatar_bot_id, bytes, expires_at)
    VALUES (p_reservation_id, v_server, p_avatar_bot_id, GREATEST(COALESCE(p_bytes, 0), 0),
            now() + interval '1800 seconds');
    RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_upload_release(p_reservation_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    DELETE FROM public.bridge_upload_reservations r WHERE r.id = p_reservation_id;
$$;

DO $$
DECLARE
    fn text;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.bridge_mirror_allows(uuid, bigint)',
        'public.bridge_upload_reserve(uuid, uuid, bigint, uuid, integer)',
        'public.bridge_upload_release(uuid)'
    ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
