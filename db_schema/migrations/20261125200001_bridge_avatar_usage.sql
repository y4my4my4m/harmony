-- Matrix bridge avatars: counted per bot and server toward the server's cap on files bridges and
-- bots store (bridge_mirror_server_limit_mb), and listed for removal once the bot's bridge is gone
-- from the server.
--
-- bridge_avatar_usage  one row per (bot, server) holding avatars: objects and bytes of the avatars
--                      objects named bridges/<bot id>/<server id>/..., lowercase ids (an unreadable
--                      size counts 0 bytes). Triggers on storage.objects keep both on every write;
--                      the row goes with its last object. No foreign keys: the row outlives the bot,
--                      the server and the channels until its objects are removed. unbound_at: when
--                      bridge_avatar_unbound first found the bot without a bridge_channels row in
--                      the server. Service role reads; only the definers write.
--
--   bridge_avatar_track_object()        trigger function of bridge_avatar_track_insert, _update and
--                                       _delete on storage.objects
--   bridge_avatar_unbound(limit)        service role: the (bot, server) pairs, oldest first, whose
--                                       avatars the gateway removes: no bridge_channels row of the
--                                       bot in the server for an hour. Unconfiguring the bridge and
--                                       deleting the bot, the server or its paired channels all end
--                                       there. A bridge configured again within the hour keeps them.
--   bridge_mirror_server_bytes(server)  of 20261123100002, redefined: the avatars of the server count
--   bridge_mirror_status()              of 20261123100002, redefined: stored_bytes counts the avatars
--                                       of every server that exists, as the caps do
--
-- Body otherwise, volatility, owner and grants as 20261123100002. No object of these names exists
-- before this migration: 1.9.8 is the first release with the Matrix bridge.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.bridge_avatar_usage (
    bot_id uuid NOT NULL,
    server_id uuid NOT NULL,
    objects integer NOT NULL DEFAULT 0,
    bytes bigint NOT NULL DEFAULT 0,
    unbound_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (bot_id, server_id)
);

CREATE INDEX IF NOT EXISTS bridge_avatar_usage_server_idx ON public.bridge_avatar_usage (server_id);

COMMENT ON TABLE public.bridge_avatar_usage IS
    'Objects and bytes of Matrix bridge avatars (avatars bridges/<bot id>/<server id>/...) per bot and server, kept by triggers on storage.objects. Service role reads.';

ALTER TABLE public.bridge_avatar_usage ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS bridge_avatar_usage_service_role ON public.bridge_avatar_usage;
CREATE POLICY bridge_avatar_usage_service_role ON public.bridge_avatar_usage
    AS PERMISSIVE FOR SELECT TO service_role USING (true);
REVOKE ALL ON public.bridge_avatar_usage FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.bridge_avatar_usage TO service_role;

-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bridge_avatar_track_object()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_uuid CONSTANT text := '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    v_ids text[];
BEGIN
    IF TG_OP <> 'INSERT' AND OLD.bucket_id = 'avatars' THEN
        v_ids := regexp_match(OLD.name, '^bridges/(' || v_uuid || ')/(' || v_uuid || ')/');
        IF v_ids IS NOT NULL THEN
            UPDATE public.bridge_avatar_usage u
               SET objects = u.objects - 1,
                   bytes = u.bytes - (CASE WHEN OLD.metadata ->> 'size' ~ '^\d{1,18}$'
                                           THEN (OLD.metadata ->> 'size')::bigint ELSE 0 END),
                   updated_at = now()
             WHERE u.bot_id = v_ids[1]::uuid AND u.server_id = v_ids[2]::uuid;
            DELETE FROM public.bridge_avatar_usage u
             WHERE u.bot_id = v_ids[1]::uuid AND u.server_id = v_ids[2]::uuid AND u.objects <= 0;
        END IF;
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.bucket_id = 'avatars' THEN
        v_ids := regexp_match(NEW.name, '^bridges/(' || v_uuid || ')/(' || v_uuid || ')/');
        IF v_ids IS NOT NULL THEN
            INSERT INTO public.bridge_avatar_usage AS u (bot_id, server_id, objects, bytes)
            VALUES (v_ids[1]::uuid, v_ids[2]::uuid, 1,
                    CASE WHEN NEW.metadata ->> 'size' ~ '^\d{1,18}$' THEN (NEW.metadata ->> 'size')::bigint ELSE 0 END)
            ON CONFLICT (bot_id, server_id) DO UPDATE
               SET objects = u.objects + 1, bytes = u.bytes + EXCLUDED.bytes, updated_at = now();
        END IF;
    END IF;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.bridge_avatar_track_object() FROM PUBLIC, anon, authenticated, service_role;

DO $$
BEGIN
    IF to_regclass('storage.objects') IS NULL THEN
        RAISE NOTICE 'storage schema absent, bridge avatar usage triggers skipped';
        RETURN;
    END IF;
    -- CREATE OR REPLACE TRIGGER takes SHARE ROW EXCLUSIVE; DROP TRIGGER would take ACCESS
    -- EXCLUSIVE and stop reads too.
    CREATE OR REPLACE TRIGGER bridge_avatar_track_insert
        AFTER INSERT ON storage.objects
        FOR EACH ROW
        WHEN (NEW.bucket_id = 'avatars' AND NEW.name LIKE 'bridges/%')
        EXECUTE FUNCTION public.bridge_avatar_track_object();
    CREATE OR REPLACE TRIGGER bridge_avatar_track_update
        AFTER UPDATE ON storage.objects
        FOR EACH ROW
        WHEN (((OLD.bucket_id = 'avatars' AND OLD.name LIKE 'bridges/%')
               OR (NEW.bucket_id = 'avatars' AND NEW.name LIKE 'bridges/%'))
              AND (OLD.bucket_id, OLD.name, OLD.metadata ->> 'size')
                  IS DISTINCT FROM (NEW.bucket_id, NEW.name, NEW.metadata ->> 'size'))
        EXECUTE FUNCTION public.bridge_avatar_track_object();
    CREATE OR REPLACE TRIGGER bridge_avatar_track_delete
        AFTER DELETE ON storage.objects
        FOR EACH ROW
        WHEN (OLD.bucket_id = 'avatars' AND OLD.name LIKE 'bridges/%')
        EXECUTE FUNCTION public.bridge_avatar_track_object();
END
$$;

-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bridge_avatar_unbound(p_limit integer)
RETURNS TABLE (bot_id uuid, server_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
#variable_conflict use_column
BEGIN
    UPDATE public.bridge_avatar_usage u
       SET unbound_at = CASE WHEN b.bound THEN NULL ELSE now() END
      FROM (SELECT a.bot_id, a.server_id,
                   EXISTS (SELECT 1
                             FROM public.bridge_channels bc
                             JOIN public.channels c ON c.id = bc.channel_id
                            WHERE bc.bot_id = a.bot_id AND c.server_id = a.server_id) AS bound
              FROM public.bridge_avatar_usage a) b
     WHERE u.bot_id = b.bot_id AND u.server_id = b.server_id
       AND b.bound = (u.unbound_at IS NOT NULL);

    RETURN QUERY
    SELECT u.bot_id, u.server_id
      FROM public.bridge_avatar_usage u
     WHERE u.unbound_at <= now() - interval '1 hour'
     ORDER BY u.unbound_at, u.bot_id, u.server_id
     LIMIT LEAST(GREATEST(COALESCE(p_limit, 50), 1), 500);
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_mirror_server_bytes(p_server_id uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT (COALESCE((SELECT sum(u.bytes)
                        FROM public.channels c
                        JOIN public.bridge_mirror_usage u ON u.channel_id = c.id
                       WHERE c.server_id = p_server_id), 0)
          + COALESCE((SELECT sum(a.bytes)
                        FROM public.bridge_avatar_usage a
                       WHERE a.server_id = p_server_id), 0))::bigint;
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
                              WHERE c.server_id IS NOT NULL)
                          + (SELECT COALESCE(sum(a.bytes), 0)
                               FROM public.bridge_avatar_usage a
                               JOIN public.servers s ON s.id = a.server_id))
          FROM public.bridge_mirror_queue q);
END;
$$;

DO $$
DECLARE
    fn text;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.bridge_avatar_unbound(integer)',
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
