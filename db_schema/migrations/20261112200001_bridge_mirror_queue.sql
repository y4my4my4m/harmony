-- Bridge attachment mirror queue. With bridge_attachment_mode = 'mirror' the gateway stores Discord
-- files in Harmony storage; files that are large, failed, or sit on messages that predate the mode
-- go through this queue, drained by one gateway worker.
--
-- bridge_mirror_queue  one row per message, state queued | done | too_large | failed
-- bridge_mirror_state  singleton: the worker's backfill walk over existing messages
--                      (last_mode, cursor_created_at/cursor_id, walk_done) and the upload
--                      ceiling it last saw (last_ceiling). A table of its own rather than
--                      instance_config keys: no operator-key guard, no public config reads.
--
-- Both tables are service-role only. Functions (SECURITY DEFINER, service_role only unless noted):
--   bridge_mirror_enqueue(ids)           queue messages of bridge bots; existing rows are reset
--   bridge_mirror_claim(lease)           one due queued row, leased by pushing next_attempt_at
--   bridge_mirror_finish(...)            record the outcome; no-op when the row is gone
--   bridge_mirror_backfill(limit)        continue the walk over existing bridge bot messages
--   bridge_mirror_observe(mode, ceiling) per poll: restart the walk on entering mirror, requeue
--                                        too_large rows a raised ceiling now admits
--   bridge_mirror_restart_walk()         restart the walk (gateway start)
--   bridge_mirror_status()               counts for the admin UI; authenticated, raises 42501
--                                        unless the caller is an instance admin

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.bridge_mirror_queue (
    message_id uuid PRIMARY KEY REFERENCES public.messages(id) ON DELETE CASCADE,
    bot_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'done', 'too_large', 'failed')),
    attempts integer NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    largest_bytes bigint,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bridge_mirror_queue_due_idx
    ON public.bridge_mirror_queue (next_attempt_at) WHERE state = 'queued';

CREATE TABLE IF NOT EXISTS public.bridge_mirror_state (
    id boolean PRIMARY KEY DEFAULT true CHECK (id),
    last_mode text,
    cursor_created_at timestamptz,
    cursor_id uuid,
    walk_done boolean NOT NULL DEFAULT false,
    last_ceiling bigint,
    updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.bridge_mirror_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.bridge_mirror_queue IS
    'Discord attachments still to be stored in Harmony storage, per message. Service role only.';
COMMENT ON TABLE public.bridge_mirror_state IS
    'Singleton: the attachment mirror worker''s backfill cursor and last seen mode and upload ceiling. Service role only.';

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['bridge_mirror_queue', 'bridge_mirror_state'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_role', t);
        EXECUTE format('CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true)',
                       t || '_service_role', t);
        EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
        EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    END LOOP;
END
$$;

-- ---------------------------------------------------------------------------

-- A message of a bridge bot is queued; rows already there go back to queued with a clean slate
-- (done too: a later edit may have added links).
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
        INSERT INTO public.bridge_mirror_queue AS q (message_id, bot_id, channel_id)
        SELECT m.id, m.bot_id, m.channel_id
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

CREATE OR REPLACE FUNCTION public.bridge_mirror_claim(p_lease_seconds integer)
RETURNS TABLE (message_id uuid, bot_id uuid, channel_id uuid, attempts integer)
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
    RETURNING q.message_id, q.bot_id, q.channel_id, q.attempts;
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
BEGIN
    UPDATE public.bridge_mirror_queue q
       SET state = p_state,
           attempts = p_attempts,
           next_attempt_at = CASE WHEN p_state = 'queued'
                                  THEN now() + make_interval(secs => GREATEST(COALESCE(p_retry_seconds, 0), 0))
                                  ELSE q.next_attempt_at END,
           largest_bytes = p_largest_bytes,
           last_error = p_error,
           updated_at = now()
     WHERE q.message_id = p_message_id;
END;
$$;

-- Walks the messages of bridge bots in (created_at, id) order, p_limit per call, from the stored
-- cursor. Those with a Discord-CDN file or url part and not already done or queued are enqueued.
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
        SELECT m.id, m.created_at, m.bot_id, m.channel_id, m.content
          FROM public.messages m
         WHERE m.bot_id IN (SELECT b.bot_id FROM public.discord_bridges b)
           AND m.is_deleted IS NOT TRUE
           AND (v_at IS NULL OR (m.created_at, m.id) > (v_at, v_id))
         ORDER BY m.created_at, m.id
         LIMIT p_limit
    ),
    ins AS (
        INSERT INTO public.bridge_mirror_queue AS q (message_id, bot_id, channel_id)
        SELECT b.id, b.bot_id, b.channel_id
          FROM batch b
         WHERE jsonb_typeof(b.content) = 'array'
           AND jsonb_path_exists(b.content,
               '$[*] ? ((@.type == "file" || @.type == "url") && @.url like_regex "^https?://([a-z0-9-]+\\.)*discordapp\\.(com|net)/" flag "i")')
           AND NOT EXISTS (SELECT 1 FROM public.bridge_mirror_queue e
                            WHERE e.message_id = b.id AND e.state IN ('done', 'queued'))
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

-- Called by the worker on every poll. Entering mirror mode restarts the walk; a raised upload
-- ceiling gives the too_large rows that now fit another go.
CREATE OR REPLACE FUNCTION public.bridge_mirror_observe(p_mode text, p_ceiling bigint)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_s public.bridge_mirror_state%ROWTYPE;
    v_enter boolean;
BEGIN
    INSERT INTO public.bridge_mirror_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
    SELECT * INTO v_s FROM public.bridge_mirror_state s WHERE s.id FOR UPDATE;

    v_enter := p_mode = 'mirror' AND v_s.last_mode IS DISTINCT FROM 'mirror';

    IF p_ceiling IS NOT NULL AND (v_s.last_ceiling IS NULL OR p_ceiling > v_s.last_ceiling) THEN
        UPDATE public.bridge_mirror_queue q
           SET state = 'queued', attempts = 0, next_attempt_at = now(), updated_at = now()
         WHERE q.state = 'too_large' AND q.largest_bytes <= p_ceiling;
    END IF;

    UPDATE public.bridge_mirror_state s
       SET last_mode = p_mode,
           last_ceiling = COALESCE(p_ceiling, s.last_ceiling),
           cursor_created_at = CASE WHEN v_enter THEN NULL ELSE s.cursor_created_at END,
           cursor_id = CASE WHEN v_enter THEN NULL ELSE s.cursor_id END,
           walk_done = CASE WHEN v_enter THEN false ELSE s.walk_done END,
           updated_at = now()
     WHERE s.id
    RETURNING s.walk_done INTO v_s.walk_done;

    RETURN jsonb_build_object('walk_done', v_s.walk_done);
END;
$$;

CREATE OR REPLACE FUNCTION public.bridge_mirror_restart_walk()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO public.bridge_mirror_state (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
    UPDATE public.bridge_mirror_state s
       SET cursor_created_at = NULL, cursor_id = NULL, walk_done = false, updated_at = now()
     WHERE s.id;
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
            'done', count(*) FILTER (WHERE q.state = 'done'),
            'too_large', count(*) FILTER (WHERE q.state = 'too_large'),
            'too_large_bytes', COALESCE(sum(q.largest_bytes) FILTER (WHERE q.state = 'too_large'), 0),
            'failed', count(*) FILTER (WHERE q.state = 'failed'))
          FROM public.bridge_mirror_queue q);
END;
$$;

DO $$
DECLARE
    fn text;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.bridge_mirror_enqueue(uuid[])',
        'public.bridge_mirror_claim(integer)',
        'public.bridge_mirror_finish(uuid, text, integer, integer, bigint, text)',
        'public.bridge_mirror_backfill(integer)',
        'public.bridge_mirror_observe(text, bigint)',
        'public.bridge_mirror_restart_walk()',
        'public.bridge_mirror_status()'
    ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END
$$;

GRANT EXECUTE ON FUNCTION public.bridge_mirror_status() TO authenticated;

COMMIT;
