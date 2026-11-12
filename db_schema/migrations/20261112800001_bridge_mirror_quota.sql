-- Bridge attachment mirror: a cap on the bytes of mirrored Discord files one server holds, and a
-- queue that holds only the messages with work left.
--
-- instance_config
--   bridge_mirror_server_limit_mb  5120  megabytes (1048576 bytes each) of mirrored files per
--                                        server. 0 is no limit; absent or unreadable reads 5120
--                                        (instance_count_cap).
--
-- Usage is computed, not counted: the sizes storage.objects records for the message_media objects
-- named c/<channel id>/bridge/... over the server's channels, one name range per channel. The
-- range is compared in C collation, where '0' is the character after '/'; storage-api's
-- idx_objects_bucket_id_name (bucket_id, name COLLATE "C") serves it. The check and the upload
-- are separate steps: uploads in flight at once each see the usage without the others.
--
-- bridge_mirror_queue  loses bot_id and channel_id: the message row has both.
--                      loses the done state: a row whose files are all stored is deleted. Its
--                      message holds no Discord CDN link any more, so the walk passes it.
--                      state gains over_quota: the cap refused a file of the message
-- bridge_mirror_state  gains last_limit_mb, the cap bridge_mirror_observe last saw
--
-- Functions (SECURITY DEFINER, service_role only unless noted):
--   bridge_mirror_server_bytes(server)    bytes of mirrored files in the server's channels
--   bridge_mirror_allows(channel, bytes)  the channel's server holds `bytes` more within the cap.
--                                         False for a channel that is unknown or has no server.
--   bridge_mirror_enqueue(ids)            of 20261112200001, redefined: stores the message id alone
--   bridge_mirror_claim(lease)            of 20261112200001, replaced: returns message_id, attempts
--   bridge_mirror_backfill(limit)         of 20261112200001, redefined: stores the message id alone
--                                         and passes a message only while its row is queued
--   bridge_mirror_observe(mode, ceiling)  of 20261112200001, redefined: a raised or removed cap
--                                         requeues the over_quota rows; the state row is written
--                                         only when mode, ceiling or cap differ from the last seen
--   bridge_mirror_finish(...)             of 20261112200001, redefined: done deletes the row. A row
--                                         sent back to the queue whose bot runs no bridge any more
--                                         ends failed, error 'bridge removed'. The worker requeues
--                                         a row whose links need the bridge every 15 minutes
--                                         without counting an attempt; without a bridge that
--                                         never ends.
--   bridge_mirror_status()                of 20261112200001, redefined: no done count; gains
--                                         over_quota (rows) and stored_bytes (mirrored files of
--                                         every server). authenticated, 42501 unless an instance
--                                         admin.

BEGIN;

SET LOCAL lock_timeout = '3s';

INSERT INTO public.instance_config (config_key, config_value, description)
VALUES ('bridge_mirror_server_limit_mb', '5120'::jsonb,
        'Megabytes of mirrored Discord files one server may hold. 0 is no limit.')
ON CONFLICT (config_key) DO NOTHING;

ALTER TABLE public.bridge_mirror_state ADD COLUMN IF NOT EXISTS last_limit_mb integer;

COMMENT ON TABLE public.bridge_mirror_state IS
    'Singleton: the attachment mirror worker''s backfill cursor and last seen mode, upload ceiling and server cap. Service role only.';

ALTER TABLE public.bridge_mirror_queue
    DROP COLUMN IF EXISTS bot_id,
    DROP COLUMN IF EXISTS channel_id;

DELETE FROM public.bridge_mirror_queue q WHERE q.state = 'done';

-- The state check of 20261112200001, found by its definition, gives way to one with over_quota
-- and without done. Adding it reads the queue once under the table lock; every stored state is
-- in the new set.
DO $$
DECLARE
    v_name text;
BEGIN
    FOR v_name IN
        SELECT con.conname
          FROM pg_constraint con
         WHERE con.conrelid = 'public.bridge_mirror_queue'::regclass
           AND con.contype = 'c'
           AND pg_get_constraintdef(con.oid) LIKE '%too_large%'
           AND (pg_get_constraintdef(con.oid) NOT LIKE '%over_quota%'
                OR pg_get_constraintdef(con.oid) LIKE '%''done''%')
    LOOP
        EXECUTE format('ALTER TABLE public.bridge_mirror_queue DROP CONSTRAINT %I', v_name);
    END LOOP;

    IF NOT EXISTS (SELECT 1
                     FROM pg_constraint con
                    WHERE con.conrelid = 'public.bridge_mirror_queue'::regclass
                      AND con.contype = 'c'
                      AND pg_get_constraintdef(con.oid) LIKE '%over_quota%') THEN
        ALTER TABLE public.bridge_mirror_queue
            ADD CONSTRAINT bridge_mirror_queue_state_check
            CHECK (state IN ('queued', 'too_large', 'failed', 'over_quota'));
    END IF;
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
    SELECT COALESCE(sum(CASE WHEN o.metadata ->> 'size' ~ '^\d{1,18}$'
                             THEN (o.metadata ->> 'size')::bigint ELSE 0 END), 0)::bigint
      FROM public.channels c
      JOIN storage.objects o
        ON o.bucket_id = 'message_media'
       AND o.name COLLATE "C" >= 'c/' || c.id::text || '/bridge/'
       AND o.name COLLATE "C" <  'c/' || c.id::text || '/bridge0'
     WHERE c.server_id = p_server_id;
$$;

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
    RETURN public.bridge_mirror_server_bytes(v_server) + GREATEST(COALESCE(p_bytes, 0), 0)
           <= v_limit_mb::bigint * 1048576;
END;
$$;

-- A message of a bridge bot is queued; a row already there goes back to queued with no attempts.
CREATE OR REPLACE FUNCTION public.bridge_mirror_enqueue(p_message_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count integer;
BEGIN
    WITH up AS (
        INSERT INTO public.bridge_mirror_queue AS q (message_id)
        SELECT m.id
          FROM public.messages m
         WHERE m.id = ANY (COALESCE(p_message_ids, ARRAY[]::uuid[]))
           AND m.bot_id IN (SELECT b.bot_id FROM public.discord_bridges b)
        ON CONFLICT (message_id) DO UPDATE
           SET state = 'queued', attempts = 0, next_attempt_at = now(), updated_at = now()
        RETURNING 1
    )
    SELECT count(*) INTO v_count FROM up;
    RETURN v_count;
END;
$$;

-- The row type changes, which CREATE OR REPLACE refuses.
DROP FUNCTION IF EXISTS public.bridge_mirror_claim(integer);

-- One due queued row, leased by pushing next_attempt_at.
CREATE FUNCTION public.bridge_mirror_claim(p_lease_seconds integer)
RETURNS TABLE (message_id uuid, attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN QUERY
    WITH due AS (
        SELECT q.message_id
          FROM public.bridge_mirror_queue q
         WHERE q.state = 'queued' AND q.next_attempt_at <= now()
         ORDER BY q.next_attempt_at
         LIMIT 1
         FOR UPDATE SKIP LOCKED
    )
    UPDATE public.bridge_mirror_queue q
       SET next_attempt_at = now() + make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 0), 0)),
           updated_at = now()
      FROM due
     WHERE q.message_id = due.message_id
    RETURNING q.message_id, q.attempts;
END;
$$;

-- Walks the messages of bridge bots in (created_at, id) order, p_limit per call, from the stored
-- cursor. Those with a Discord-CDN file or url part and no queued row are enqueued: a too_large,
-- failed or over_quota row gets another go.
CREATE OR REPLACE FUNCTION public.bridge_mirror_backfill(p_limit integer)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_at timestamptz;
    v_id uuid;
    v_read integer;
    v_last_at timestamptz;
    v_last_id uuid;
    v_enqueued integer;
BEGIN
    IF p_limit IS NULL OR p_limit < 1 THEN
        RAISE EXCEPTION 'p_limit must be positive' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.bridge_mirror_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
    SELECT s.cursor_created_at, s.cursor_id INTO v_at, v_id
      FROM public.bridge_mirror_state s WHERE s.id FOR UPDATE;

    WITH batch AS (
        SELECT m.id, m.created_at, m.content
          FROM public.messages m
         WHERE m.bot_id IN (SELECT b.bot_id FROM public.discord_bridges b)
           AND m.is_deleted IS NOT TRUE
           AND (v_at IS NULL OR (m.created_at, m.id) > (v_at, v_id))
         ORDER BY m.created_at, m.id
         LIMIT p_limit
    ),
    ins AS (
        INSERT INTO public.bridge_mirror_queue AS q (message_id)
        SELECT b.id
          FROM batch b
         WHERE jsonb_typeof(b.content) = 'array'
           AND jsonb_path_exists(b.content,
               '$[*] ? ((@.type == "file" || @.type == "url") && @.url like_regex "^https?://([a-z0-9-]+\\.)*discordapp\\.(com|net)/" flag "i")')
           AND NOT EXISTS (SELECT 1 FROM public.bridge_mirror_queue e
                            WHERE e.message_id = b.id AND e.state = 'queued')
        ON CONFLICT (message_id) DO UPDATE
           SET state = 'queued', attempts = 0, next_attempt_at = now(), updated_at = now()
        RETURNING 1
    )
    SELECT (SELECT count(*) FROM batch),
           (SELECT b.created_at FROM batch b ORDER BY b.created_at DESC, b.id DESC LIMIT 1),
           (SELECT b.id FROM batch b ORDER BY b.created_at DESC, b.id DESC LIMIT 1),
           (SELECT count(*) FROM ins)
      INTO v_read, v_last_at, v_last_id, v_enqueued;

    UPDATE public.bridge_mirror_state s
       SET cursor_created_at = COALESCE(v_last_at, s.cursor_created_at),
           cursor_id = COALESCE(v_last_id, s.cursor_id),
           walk_done = (v_read < p_limit),
           updated_at = now()
     WHERE s.id;

    RETURN v_enqueued;
END;
$$;

-- Entering mirror mode restarts the walk; a raised upload ceiling requeues the too_large rows it
-- admits, a raised or removed cap the over_quota rows. A call that finds mode, ceiling and cap
-- as last seen reads the state row and writes nothing.
CREATE OR REPLACE FUNCTION public.bridge_mirror_observe(p_mode text, p_ceiling bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_s public.bridge_mirror_state%ROWTYPE;
    v_limit_mb integer := public.instance_count_cap('bridge_mirror_server_limit_mb', 5120);
    v_enter boolean;
BEGIN
    SELECT * INTO v_s FROM public.bridge_mirror_state s WHERE s.id;
    IF FOUND
       AND v_s.last_mode IS NOT DISTINCT FROM p_mode
       AND (p_ceiling IS NULL OR v_s.last_ceiling IS NOT DISTINCT FROM p_ceiling)
       AND v_s.last_limit_mb IS NOT DISTINCT FROM v_limit_mb THEN
        RETURN jsonb_build_object('walk_done', v_s.walk_done);
    END IF;

    INSERT INTO public.bridge_mirror_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
    SELECT * INTO v_s FROM public.bridge_mirror_state s WHERE s.id FOR UPDATE;

    v_enter := p_mode = 'mirror' AND v_s.last_mode IS DISTINCT FROM 'mirror';

    IF p_ceiling IS NOT NULL AND (v_s.last_ceiling IS NULL OR p_ceiling > v_s.last_ceiling) THEN
        UPDATE public.bridge_mirror_queue q
           SET state = 'queued', attempts = 0, next_attempt_at = now(), updated_at = now()
         WHERE q.state = 'too_large' AND q.largest_bytes <= p_ceiling;
    END IF;

    -- last_limit_mb 0 is no cap: nothing was refused under it.
    IF v_s.last_limit_mb IS NULL
       OR (v_s.last_limit_mb > 0 AND (v_limit_mb = 0 OR v_limit_mb > v_s.last_limit_mb)) THEN
        UPDATE public.bridge_mirror_queue q
           SET state = 'queued', attempts = 0, next_attempt_at = now(), updated_at = now()
         WHERE q.state = 'over_quota';
    END IF;

    UPDATE public.bridge_mirror_state s
       SET last_mode = p_mode,
           last_ceiling = COALESCE(p_ceiling, s.last_ceiling),
           last_limit_mb = v_limit_mb,
           cursor_created_at = CASE WHEN v_enter THEN NULL ELSE s.cursor_created_at END,
           cursor_id = CASE WHEN v_enter THEN NULL ELSE s.cursor_id END,
           walk_done = CASE WHEN v_enter THEN false ELSE s.walk_done END,
           updated_at = now()
     WHERE s.id
    RETURNING s.walk_done INTO v_s.walk_done;

    RETURN jsonb_build_object('walk_done', v_s.walk_done);
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_mirror_finish(
    p_message_id uuid,
    p_state text,
    p_attempts integer,
    p_retry_seconds integer,
    p_largest_bytes bigint,
    p_error text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_orphan boolean;
BEGIN
    IF p_state = 'done' THEN
        DELETE FROM public.bridge_mirror_queue q WHERE q.message_id = p_message_id;
        RETURN;
    END IF;

    v_orphan := p_state = 'queued' AND NOT EXISTS (
        SELECT 1
          FROM public.messages m
          JOIN public.discord_bridges b ON b.bot_id = m.bot_id
         WHERE m.id = p_message_id);

    UPDATE public.bridge_mirror_queue q
       SET state = CASE WHEN v_orphan THEN 'failed' ELSE p_state END,
           attempts = p_attempts,
           next_attempt_at = CASE WHEN p_state = 'queued' AND NOT v_orphan
                                  THEN now() + make_interval(secs => GREATEST(COALESCE(p_retry_seconds, 0), 0))
                                  ELSE q.next_attempt_at END,
           largest_bytes = p_largest_bytes,
           last_error = CASE WHEN v_orphan THEN 'bridge removed' ELSE p_error END,
           updated_at = now()
     WHERE q.message_id = p_message_id;
END;
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
            'stored_bytes', (SELECT COALESCE(sum(public.bridge_mirror_server_bytes(s.id)), 0)
                               FROM public.servers s))
          FROM public.bridge_mirror_queue q);
END;
$$;

DO $$
DECLARE
    fn text;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.bridge_mirror_server_bytes(uuid)',
        'public.bridge_mirror_allows(uuid, bigint)',
        'public.bridge_mirror_enqueue(uuid[])',
        'public.bridge_mirror_claim(integer)',
        'public.bridge_mirror_backfill(integer)',
        'public.bridge_mirror_observe(text, bigint)',
        'public.bridge_mirror_finish(uuid, text, integer, integer, bigint, text)',
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
