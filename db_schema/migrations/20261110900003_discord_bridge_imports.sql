-- Discord history import jobs. One job row per paired channel (bridge_id, harmony_channel_id),
-- reused across runs; the bridge program drives it through the service-role functions below.
--
-- discord_bridge_imports
--   state            queued | running | paused | done | failed | cancelled
--   phase            messages | threads | replies
--   cancel_requested set while a running job is asked to stop; the bridge then patches the job
--                    to cancelled
--   *_discord_message_id, *_at, thread_*  the cursors the bridge resumes from
--   requested_via    'harmony' (app RPC) or 'discord' (the Discord-side command)
--
-- Importable pair: direction both or to_harmony, and the Harmony channel is not end-to-end
-- encrypted (channel_messages_encrypted).
--
-- Start, per importable pair
--   no row                          insert queued
--   failed, cancelled, paused       queued; cursors kept; error, cancel_requested, finished_at cleared
--   done                            queued; every cursor and counter reset
--   queued, running                 unchanged
--   the pair's Discord channel changed  reset as for done
-- Cancel: queued and paused become cancelled; running gets cancel_requested; finished jobs are
-- untouched. Update: transitions queued->running, running->paused|done|failed, running->cancelled
-- only with cancel_requested, paused->running; running->running is a no-op for the state (other keys still apply).
--
-- Errors (the exception message is the code, so the gateway can map it):
--   pair_not_importable  22023  DETAIL = the Discord channel id
--   invalid_transition   55000  DETAIL = 'from -> to'
--   invalid_patch        22023  DETAIL = the offending key
--   import_not_found     P0002
--   Discord bridge not found  P0002; 42501 caller lacks MANAGE_SERVER or authentication.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.discord_bridge_imports (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    bridge_id uuid NOT NULL REFERENCES public.discord_bridges(id) ON DELETE CASCADE,
    harmony_channel_id uuid NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    discord_channel_id text NOT NULL,
    state text NOT NULL DEFAULT 'queued',
    phase text NOT NULL DEFAULT 'messages',
    cancel_requested boolean NOT NULL DEFAULT false,
    start_discord_message_id text,
    start_at timestamptz,
    reached_discord_message_id text,
    reached_at timestamptz,
    channel_created_at timestamptz,
    threads_total integer,
    threads_done integer NOT NULL DEFAULT 0,
    thread_cursor jsonb,
    imported_count integer NOT NULL DEFAULT 0,
    skipped_count integer NOT NULL DEFAULT 0,
    pins_skipped integer NOT NULL DEFAULT 0,
    error text,
    requested_via text NOT NULL DEFAULT 'harmony',
    requested_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    CONSTRAINT discord_bridge_imports_pair_key UNIQUE (bridge_id, harmony_channel_id),
    CONSTRAINT discord_bridge_imports_state_check
        CHECK (state IN ('queued', 'running', 'paused', 'done', 'failed', 'cancelled')),
    CONSTRAINT discord_bridge_imports_phase_check CHECK (phase IN ('messages', 'threads', 'replies')),
    CONSTRAINT discord_bridge_imports_via_check CHECK (requested_via IN ('harmony', 'discord')),
    CONSTRAINT discord_bridge_imports_discord_id_check CHECK (discord_channel_id ~ '^[0-9]{1,20}$'),
    CONSTRAINT discord_bridge_imports_cursor_check
        CHECK (thread_cursor IS NULL OR jsonb_typeof(thread_cursor) = 'object')
);

CREATE INDEX IF NOT EXISTS discord_bridge_imports_channel_idx
    ON public.discord_bridge_imports (harmony_channel_id);
CREATE INDEX IF NOT EXISTS discord_bridge_imports_requested_by_idx
    ON public.discord_bridge_imports (requested_by) WHERE requested_by IS NOT NULL;

COMMENT ON TABLE public.discord_bridge_imports IS
    'Discord history import job per paired channel, reused across runs. Written through the discord_bridge_import_* functions.';

REVOKE ALL ON public.discord_bridge_imports FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.discord_bridge_imports TO authenticated;
GRANT ALL ON public.discord_bridge_imports TO service_role;

ALTER TABLE public.discord_bridge_imports ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS discord_bridge_imports_service_role ON public.discord_bridge_imports;
CREATE POLICY discord_bridge_imports_service_role ON public.discord_bridge_imports
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS discord_bridge_imports_select_manager ON public.discord_bridge_imports;
CREATE POLICY discord_bridge_imports_select_manager ON public.discord_bridge_imports
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.discord_bridges b
                    WHERE b.id = discord_bridge_imports.bridge_id
                      AND public.can_manage_discord_bridge(b.server_id)));

-- ---------------------------------------------------------------------------
-- Service-role functions
-- ---------------------------------------------------------------------------

-- Queues a job for each importable pair of the bridge (all, or those named by Discord channel
-- id) and returns the jobs, whatever their state. A named pair that is not importable raises.
CREATE OR REPLACE FUNCTION public.discord_bridge_import_start_internal(
    p_bridge_id uuid,
    p_discord_channel_ids text[],
    p_via text,
    p_requested_by uuid)
RETURNS SETOF public.discord_bridge_imports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id text;
    v_pair public.discord_bridge_channels;
    v_row public.discord_bridge_imports;
BEGIN
    IF p_via IS NULL OR p_via NOT IN ('harmony', 'discord') THEN
        RAISE EXCEPTION 'invalid_patch' USING ERRCODE = '22023', DETAIL = 'requested_via';
    END IF;

    PERFORM 1 FROM public.discord_bridges WHERE id = p_bridge_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Discord bridge not found' USING ERRCODE = 'P0002';
    END IF;

    IF p_discord_channel_ids IS NOT NULL THEN
        FOREACH v_id IN ARRAY p_discord_channel_ids LOOP
            IF v_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM public.discord_bridge_channels p
                 WHERE p.bridge_id = p_bridge_id
                   AND p.discord_channel_id = v_id
                   AND p.direction IN ('both', 'to_harmony')
                   AND NOT public.channel_messages_encrypted(p.harmony_channel_id)) THEN
                RAISE EXCEPTION 'pair_not_importable' USING ERRCODE = '22023', DETAIL = COALESCE(v_id, '');
            END IF;
        END LOOP;
    END IF;

    FOR v_pair IN
        SELECT p.*
          FROM public.discord_bridge_channels p
         WHERE p.bridge_id = p_bridge_id
           AND p.direction IN ('both', 'to_harmony')
           AND NOT public.channel_messages_encrypted(p.harmony_channel_id)
           AND (p_discord_channel_ids IS NULL OR p.discord_channel_id = ANY (p_discord_channel_ids))
         ORDER BY p.created_at, p.id
    LOOP
        SELECT * INTO v_row
          FROM public.discord_bridge_imports i
         WHERE i.bridge_id = p_bridge_id AND i.harmony_channel_id = v_pair.harmony_channel_id
           FOR UPDATE;

        IF NOT FOUND THEN
            INSERT INTO public.discord_bridge_imports
                (bridge_id, harmony_channel_id, discord_channel_id, requested_via, requested_by)
            VALUES (p_bridge_id, v_pair.harmony_channel_id, v_pair.discord_channel_id, p_via, p_requested_by)
            RETURNING * INTO v_row;
        ELSIF v_row.discord_channel_id <> v_pair.discord_channel_id OR v_row.state = 'done' THEN
            UPDATE public.discord_bridge_imports
               SET discord_channel_id = v_pair.discord_channel_id,
                   state = 'queued',
                   phase = 'messages',
                   cancel_requested = false,
                   start_discord_message_id = NULL,
                   start_at = NULL,
                   reached_discord_message_id = NULL,
                   reached_at = NULL,
                   channel_created_at = NULL,
                   threads_total = NULL,
                   threads_done = 0,
                   thread_cursor = NULL,
                   imported_count = 0,
                   skipped_count = 0,
                   pins_skipped = 0,
                   error = NULL,
                   requested_via = p_via,
                   requested_by = p_requested_by,
                   updated_at = now(),
                   finished_at = NULL
             WHERE id = v_row.id
            RETURNING * INTO v_row;
        ELSIF v_row.state IN ('failed', 'cancelled', 'paused') THEN
            UPDATE public.discord_bridge_imports
               SET state = 'queued',
                   cancel_requested = false,
                   error = NULL,
                   requested_via = p_via,
                   requested_by = p_requested_by,
                   updated_at = now(),
                   finished_at = NULL
             WHERE id = v_row.id
            RETURNING * INTO v_row;
        END IF;

        RETURN NEXT v_row;
    END LOOP;
    RETURN;
END;
$$;

-- Patches a job of the bridge with the keys the bridge may write. A state in the patch must be a
-- permitted transition.
CREATE OR REPLACE FUNCTION public.discord_bridge_import_update(
    p_bridge_id uuid,
    p_import_id uuid,
    p_patch jsonb)
RETURNS public.discord_bridge_imports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    c_keys constant text[] := ARRAY['state', 'phase', 'start_discord_message_id', 'start_at',
        'reached_discord_message_id', 'reached_at', 'channel_created_at', 'threads_total',
        'threads_done', 'thread_cursor', 'error'];
    v_bad text;
    v_row public.discord_bridge_imports;
    v_state text;
    v_cursor jsonb;
BEGIN
    IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
        RAISE EXCEPTION 'invalid_patch' USING ERRCODE = '22023', DETAIL = 'patch';
    END IF;
    SELECT k INTO v_bad FROM jsonb_object_keys(p_patch) k WHERE k <> ALL (c_keys) LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'invalid_patch' USING ERRCODE = '22023', DETAIL = v_bad;
    END IF;

    SELECT * INTO v_row
      FROM public.discord_bridge_imports i
     WHERE i.id = p_import_id AND i.bridge_id = p_bridge_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'import_not_found' USING ERRCODE = 'P0002';
    END IF;

    IF p_patch ? 'state' THEN
        v_state := p_patch ->> 'state';
        -- running -> running is an idempotent no-op: a restarted bridge resumes a job left running
        -- and begins by patching that state. Every other same-state write is invalid.
        IF NOT (   (v_row.state = 'running' AND v_state = 'running')
                OR (v_row.state = 'queued' AND v_state = 'running')
                OR (v_row.state = 'running' AND v_state IN ('paused', 'done', 'failed'))
                OR (v_row.state = 'running' AND v_state = 'cancelled' AND v_row.cancel_requested)
                OR (v_row.state = 'paused' AND v_state = 'running')) THEN
            RAISE EXCEPTION 'invalid_transition'
                USING ERRCODE = '55000', DETAIL = v_row.state || ' -> ' || COALESCE(v_state, 'null');
        END IF;
    END IF;

    v_cursor := p_patch -> 'thread_cursor';
    IF jsonb_typeof(v_cursor) = 'null' THEN
        v_cursor := NULL;
    END IF;

    UPDATE public.discord_bridge_imports i
       SET state = COALESCE(v_state, i.state),
           phase = CASE WHEN p_patch ? 'phase' THEN p_patch ->> 'phase' ELSE i.phase END,
           start_discord_message_id = CASE WHEN p_patch ? 'start_discord_message_id'
               THEN p_patch ->> 'start_discord_message_id' ELSE i.start_discord_message_id END,
           start_at = CASE WHEN p_patch ? 'start_at'
               THEN (p_patch ->> 'start_at')::timestamptz ELSE i.start_at END,
           reached_discord_message_id = CASE WHEN p_patch ? 'reached_discord_message_id'
               THEN p_patch ->> 'reached_discord_message_id' ELSE i.reached_discord_message_id END,
           reached_at = CASE WHEN p_patch ? 'reached_at'
               THEN (p_patch ->> 'reached_at')::timestamptz ELSE i.reached_at END,
           channel_created_at = CASE WHEN p_patch ? 'channel_created_at'
               THEN (p_patch ->> 'channel_created_at')::timestamptz ELSE i.channel_created_at END,
           threads_total = CASE WHEN p_patch ? 'threads_total'
               THEN (p_patch ->> 'threads_total')::integer ELSE i.threads_total END,
           threads_done = CASE WHEN p_patch ? 'threads_done'
               THEN (p_patch ->> 'threads_done')::integer ELSE i.threads_done END,
           thread_cursor = CASE WHEN p_patch ? 'thread_cursor' THEN v_cursor ELSE i.thread_cursor END,
           error = CASE WHEN p_patch ? 'error' THEN p_patch ->> 'error' ELSE i.error END,
           updated_at = now(),
           finished_at = CASE WHEN v_state IN ('done', 'failed', 'cancelled') THEN now()
                              ELSE i.finished_at END
     WHERE i.id = v_row.id
    RETURNING * INTO v_row;
    RETURN v_row;
END;
$$;

-- Cancels one job of the bridge, or all of them when p_import_id is NULL. Returns the jobs that
-- changed.
CREATE OR REPLACE FUNCTION public.discord_bridge_import_cancel_internal(
    p_bridge_id uuid,
    p_import_id uuid)
RETURNS SETOF public.discord_bridge_imports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF p_import_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.discord_bridge_imports i
         WHERE i.id = p_import_id AND i.bridge_id = p_bridge_id) THEN
        RAISE EXCEPTION 'import_not_found' USING ERRCODE = 'P0002';
    END IF;

    RETURN QUERY
    UPDATE public.discord_bridge_imports i
       SET state = CASE WHEN i.state IN ('queued', 'paused') THEN 'cancelled' ELSE i.state END,
           cancel_requested = CASE WHEN i.state = 'running' THEN true ELSE i.cancel_requested END,
           finished_at = CASE WHEN i.state IN ('queued', 'paused') THEN now() ELSE i.finished_at END,
           updated_at = now()
     WHERE i.bridge_id = p_bridge_id
       AND (p_import_id IS NULL OR i.id = p_import_id)
       AND i.state IN ('queued', 'paused', 'running')
    RETURNING i.*;
END;
$$;

-- ---------------------------------------------------------------------------
-- Client RPCs
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.discord_bridge_import_start(
    p_bridge_id uuid,
    p_harmony_channel_ids uuid[] DEFAULT NULL)
RETURNS SETOF public.discord_bridge_imports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bridge public.discord_bridges := public.discord_bridge_for_manager(p_bridge_id);
    v_discord_ids text[];
    v_missing uuid;
BEGIN
    IF p_harmony_channel_ids IS NOT NULL THEN
        SELECT array_agg(p.discord_channel_id) INTO v_discord_ids
          FROM public.discord_bridge_channels p
         WHERE p.bridge_id = v_bridge.id AND p.harmony_channel_id = ANY (p_harmony_channel_ids);
        -- array_agg over no rows is NULL, which the internal start reads as "every pair".
        v_discord_ids := COALESCE(v_discord_ids, ARRAY[]::text[]);

        -- A channel with no pair cannot be imported either.
        SELECT h INTO v_missing
          FROM unnest(p_harmony_channel_ids) h
         WHERE NOT EXISTS (SELECT 1 FROM public.discord_bridge_channels p
                            WHERE p.bridge_id = v_bridge.id AND p.harmony_channel_id = h)
         LIMIT 1;
        IF FOUND THEN
            RAISE EXCEPTION 'pair_not_importable' USING ERRCODE = '22023', DETAIL = v_missing::text;
        END IF;
    END IF;

    RETURN QUERY
    SELECT * FROM public.discord_bridge_import_start_internal(
        v_bridge.id, v_discord_ids, 'harmony', public.get_current_profile_id());
END;
$$;

CREATE OR REPLACE FUNCTION public.discord_bridge_import_cancel(
    p_bridge_id uuid,
    p_import_id uuid DEFAULT NULL)
RETURNS SETOF public.discord_bridge_imports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_bridge public.discord_bridges := public.discord_bridge_for_manager(p_bridge_id);
BEGIN
    RETURN QUERY
    SELECT * FROM public.discord_bridge_import_cancel_internal(v_bridge.id, p_import_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.discord_bridge_import_start(uuid, uuid[])',
        'public.discord_bridge_import_cancel(uuid, uuid)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    END LOOP;

    FOREACH fn IN ARRAY ARRAY[
        'public.discord_bridge_import_start_internal(uuid, text[], text, uuid)',
        'public.discord_bridge_import_update(uuid, uuid, jsonb)',
        'public.discord_bridge_import_cancel_internal(uuid, uuid)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
