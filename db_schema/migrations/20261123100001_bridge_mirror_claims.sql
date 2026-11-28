-- Bridge attachment mirror: an outcome applies only to the claim that produced it.
--
-- bridge_mirror_queue  gains claim_id: a new uuid on each claim, cleared when the message is
--                      queued again (an edit that leaves a Discord link to store).
--
--   bridge_mirror_claim(lease)  of 20261112800001, replaced: also returns claim_id
--   bridge_mirror_enqueue(ids)  of 20261112800001, redefined: a row queued again loses its claim_id
--   bridge_mirror_finish(...)   of 20261112800001, replaced: gains p_claim_id, default NULL. A row
--                               whose claim_id is not p_claim_id is left as it stands: the message
--                               was queued again, or claimed again past its lease, while that claim
--                               downloaded, and the outcome describes links the message may no
--                               longer hold. Without p_claim_id (a gateway before 1.9.8) the outcome
--                               applies as before.
--
-- Body otherwise, volatility, owner and grants as 20261112800001.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.bridge_mirror_queue ADD COLUMN IF NOT EXISTS claim_id uuid;

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
           SET state = 'queued', attempts = 0, next_attempt_at = now(), claim_id = NULL, updated_at = now()
        RETURNING 1
    )
    SELECT count(*) INTO v_count FROM up;
    RETURN v_count;
END;
$$;

-- DROP and CREATE make the applying role the owner; the owners before the drop are put back below.
CREATE TEMP TABLE bridge_mirror_owners ON COMMIT DROP AS
SELECT p.proname::text AS name, pg_get_userbyid(p.proowner) AS owner
  FROM pg_proc p
 WHERE p.oid IN (to_regprocedure('public.bridge_mirror_claim(integer)'),
                 to_regprocedure('public.bridge_mirror_finish(uuid, text, integer, integer, bigint, text)'));

-- The row type changes, which CREATE OR REPLACE refuses.
DROP FUNCTION IF EXISTS public.bridge_mirror_claim(integer);

CREATE FUNCTION public.bridge_mirror_claim(p_lease_seconds integer)
RETURNS TABLE (message_id uuid, attempts integer, claim_id uuid)
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
           claim_id = gen_random_uuid(),
           updated_at = now()
      FROM due
     WHERE q.message_id = due.message_id
    RETURNING q.message_id, q.attempts, q.claim_id;
END;
$$;

-- With one more parameter, CREATE OR REPLACE makes a second function beside the first.
DROP FUNCTION IF EXISTS public.bridge_mirror_finish(uuid, text, integer, integer, bigint, text);

CREATE OR REPLACE FUNCTION public.bridge_mirror_finish(
    p_message_id uuid,
    p_state text,
    p_attempts integer,
    p_retry_seconds integer,
    p_largest_bytes bigint,
    p_error text,
    p_claim_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_orphan boolean;
BEGIN
    -- The row lock orders this against bridge_mirror_enqueue: a requeue committed first is seen
    -- here, one that comes later waits for this transaction.
    IF p_claim_id IS NOT NULL THEN
        PERFORM 1
           FROM public.bridge_mirror_queue q
          WHERE q.message_id = p_message_id AND q.claim_id = p_claim_id
            FOR UPDATE;
        IF NOT FOUND THEN
            RETURN;
        END IF;
    END IF;

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

DO $$
DECLARE
    r record;
BEGIN
    FOR r IN SELECT o.name, o.owner FROM bridge_mirror_owners o LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO %I',
                       CASE r.name
                           WHEN 'bridge_mirror_claim' THEN 'public.bridge_mirror_claim(integer)'
                           ELSE 'public.bridge_mirror_finish(uuid, text, integer, integer, bigint, text, uuid)'
                       END,
                       r.owner);
    END LOOP;
END
$$;

DO $$
DECLARE
    fn text;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.bridge_mirror_enqueue(uuid[])',
        'public.bridge_mirror_claim(integer)',
        'public.bridge_mirror_finish(uuid, text, integer, integer, bigint, text, uuid)'
    ] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
