-- Discord history import, from the 1.9.7 review.
--
-- discord_bridge_imports.replies_cursor
--   {at, id} of the oldest channel row the replies phase has passed; NULL starts from the newest.
--   bridge_import_link_replies_page moves it; any write of phase clears it.
--
-- discord_bridge_deleted_threads (bridge_id, discord_thread_id, deleted_at)
--   Discord threads whose paired Harmony thread a person deleted. Written by the BEFORE DELETE
--   trigger a_threads_bridge_deleted at trigger depth 1: a DELETE issued on threads itself. A
--   channel's or server's deletion, a parent message's hard delete (cascades) and
--   delete_emptied_thread delete one trigger level deeper and record nothing. Removed with the
--   bridge. Service role only.
--
-- discord_bridge_import_start_internal  as 20261117700001; a running job asked to stop is started
--                                       again: cancel_requested is cleared and the run carries on.
--                                       The start answered the job as started and the bridge then
--                                       cancelled it. A reset also clears replies_cursor.
-- discord_bridge_import_update          as 20261112700001; keys other than state and error are
--                                       taken only by a running job or one this patch starts
--                                       (import_not_running 55000, DETAIL = the state): a batch
--                                       that committed before a purge wrote the purged cursors
--                                       back when it reported after it. A phase write clears
--                                       replies_cursor. The stale-job sweep cancels a stale job
--                                       asked to stop, whatever bridge_import_max_running says; it
--                                       still pauses the others only under a cap.
-- discord_bridge_import_cancel_internal as 20261110900003; a running job already asked to stop is
--                                       cancelled at once. A job whose bridge is gone otherwise
--                                       stayed "Cancelling".
-- bridge_import_link_replies_page       new: links the imported replies among the next page of the
--                                       channel's rows, newest first, from replies_cursor ->
--                                       {linked, done} | {not_running, state, error}. Each call is
--                                       one transaction; bot-gateway calls it until done.
--                                       bridge_import_link_replies (one statement over the whole
--                                       channel) stays for gateways before 1.9.8.
-- bridge_import_thread                  as 20261115910001; a Discord thread recorded in
--                                       discord_bridge_deleted_threads and no longer paired raises
--                                       thread_deleted (55000, DETAIL = the Discord thread id).
--                                       The mapping went with the thread, so the next import
--                                       created it again, empty.
-- bridge_privacy_stop_imports           as 20261115900001; also drops the thread pairs of the
--                                       purged servers' bridges and clears replies_cursor. A purge
--                                       keeps a thread's starter as an empty row without its
--                                       Discord id: a kept pair sent the re-imported replies into
--                                       the old thread, apart from their re-imported starter.
--
-- Bodies otherwise, volatility, owners and grants as the migrations named.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.discord_bridge_imports ADD COLUMN IF NOT EXISTS replies_cursor jsonb;

COMMENT ON COLUMN public.discord_bridge_imports.replies_cursor IS
    'Replies phase position: {at, id} of the oldest channel row passed; NULL starts from the newest.';

-- ---------------------------------------------------------------------------
-- Deleted threads
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.discord_bridge_deleted_threads (
    bridge_id uuid NOT NULL REFERENCES public.discord_bridges(id) ON DELETE CASCADE,
    discord_thread_id text NOT NULL,
    deleted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (bridge_id, discord_thread_id),
    CONSTRAINT discord_bridge_deleted_threads_snowflake_check CHECK (discord_thread_id ~ '^[0-9]{1,20}$')
);

COMMENT ON TABLE public.discord_bridge_deleted_threads IS
    'Discord threads whose paired Harmony thread a person deleted; history import leaves them out.';

ALTER TABLE public.discord_bridge_deleted_threads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS discord_bridge_deleted_threads_service_role ON public.discord_bridge_deleted_threads;
CREATE POLICY discord_bridge_deleted_threads_service_role ON public.discord_bridge_deleted_threads
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.discord_bridge_deleted_threads FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.discord_bridge_deleted_threads TO service_role;

CREATE OR REPLACE FUNCTION public.discord_bridge_note_thread_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    -- Depth 1: the DELETE named threads. Cascades and delete_emptied_thread run at depth 2 or more.
    IF pg_trigger_depth() = 1 THEN
        INSERT INTO public.discord_bridge_deleted_threads AS d (bridge_id, discord_thread_id)
        SELECT bt.bridge_id, bt.discord_thread_id
          FROM public.discord_bridge_threads bt
         WHERE bt.thread_id = OLD.id
        ON CONFLICT (bridge_id, discord_thread_id) DO UPDATE SET deleted_at = EXCLUDED.deleted_at;
    END IF;
    RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.discord_bridge_note_thread_deleted() FROM PUBLIC, anon, authenticated;

-- BEFORE: the pair cascades with the thread, ahead of any AFTER trigger.
DROP TRIGGER IF EXISTS a_threads_bridge_deleted ON public.threads;
CREATE TRIGGER a_threads_bridge_deleted
    BEFORE DELETE ON public.threads
    FOR EACH ROW EXECUTE FUNCTION public.discord_bridge_note_thread_deleted();

-- ---------------------------------------------------------------------------
-- Jobs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.discord_bridge_import_start_internal(
    p_bridge_id uuid,
    p_discord_channel_ids text[],
    p_via text,
    p_requested_by uuid,
    p_requested_by_remote jsonb DEFAULT NULL,
    p_private_approved boolean DEFAULT false)
RETURNS SETOF public.discord_bridge_imports
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id text;
    v_pair public.discord_bridge_channels;
    v_row public.discord_bridge_imports;
    v_block text;
    v_remote jsonb;
    v_private boolean;
BEGIN
    IF p_via IS NULL OR p_via NOT IN ('harmony', 'discord') THEN
        RAISE EXCEPTION 'invalid_patch' USING ERRCODE = '22023', DETAIL = 'requested_via';
    END IF;
    v_private := p_via = 'harmony' AND p_private_approved IS TRUE;

    PERFORM 1 FROM public.discord_bridges WHERE id = p_bridge_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Discord bridge not found' USING ERRCODE = 'P0002';
    END IF;

    v_block := public.discord_bridge_import_block(p_bridge_id);
    IF v_block IS NOT NULL THEN
        RAISE EXCEPTION 'import_disabled' USING ERRCODE = '0A000', DETAIL = v_block;
    END IF;

    IF jsonb_typeof(p_requested_by_remote) = 'object' AND p_requested_by_remote ->> 'id' ~ '^[0-9]{1,20}$' THEN
        v_remote := jsonb_strip_nulls(jsonb_build_object(
            'id', p_requested_by_remote ->> 'id',
            'username', left(regexp_replace(p_requested_by_remote ->> 'username', '[[:cntrl:]]', ' ', 'g'), 100)));
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
                (bridge_id, harmony_channel_id, discord_channel_id, requested_via, requested_by, requested_by_remote,
                 private_approved)
            VALUES (p_bridge_id, v_pair.harmony_channel_id, v_pair.discord_channel_id, p_via, p_requested_by, v_remote,
                    v_private)
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
                   replies_cursor = NULL,
                   imported_count = 0,
                   skipped_count = 0,
                   pins_skipped = 0,
                   authors_skipped = 0,
                   automod_skipped = 0,
                   error = NULL,
                   requested_via = p_via,
                   requested_by = p_requested_by,
                   requested_by_remote = v_remote,
                   private_approved = v_private,
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
                   requested_by_remote = v_remote,
                   private_approved = v_private,
                   updated_at = now(),
                   finished_at = NULL
             WHERE id = v_row.id
            RETURNING * INTO v_row;
        ELSIF v_row.state = 'running' AND v_row.cancel_requested THEN
            -- Started again before its bridge stopped it: the run carries on. A bridge that read the
            -- request and patches cancelled meets invalid_transition and picks the job up again.
            UPDATE public.discord_bridge_imports
               SET cancel_requested = false,
                   updated_at = now()
             WHERE id = v_row.id
            RETURNING * INTO v_row;
        ELSIF v_row.state = 'queued' AND v_private AND NOT v_row.private_approved THEN
            -- Not yet picked up: the consent applies to the run it is waiting for.
            UPDATE public.discord_bridge_imports
               SET private_approved = true,
                   updated_at = now()
             WHERE id = v_row.id
            RETURNING * INTO v_row;
        END IF;

        RETURN NEXT v_row;
    END LOOP;
    RETURN;
END;
$$;

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
        'threads_done', 'thread_cursor', 'error', 'authors_skipped'];
    c_stale constant interval := interval '10 minutes';
    v_bad text;
    v_row public.discord_bridge_imports;
    v_state text;
    v_cursor jsonb;
    v_block text;
    v_max integer;
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

    -- Progress and counts belong to a run: a job a purge failed and reset, or one paused, cancelled
    -- or done meanwhile, keeps its own.
    IF v_row.state <> 'running' AND (p_patch ->> 'state') IS DISTINCT FROM 'running'
       AND EXISTS (SELECT 1 FROM jsonb_object_keys(p_patch) k WHERE k NOT IN ('state', 'error')) THEN
        RAISE EXCEPTION 'import_not_running' USING ERRCODE = '55000', DETAIL = v_row.state;
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

        IF v_state = 'running' AND v_row.state <> 'running' THEN
            v_block := public.discord_bridge_import_block(p_bridge_id);
            IF v_block IS NOT NULL THEN
                RAISE EXCEPTION 'import_disabled' USING ERRCODE = '0A000', DETAIL = v_block;
            END IF;

            -- A job asked to stop whose bridge went silent is over.
            UPDATE public.discord_bridge_imports i
               SET state = 'cancelled', updated_at = now(), finished_at = now()
             WHERE i.state = 'running' AND i.cancel_requested AND i.id <> v_row.id
               AND i.updated_at < now() - c_stale;

            v_max := public.instance_count_cap('bridge_import_max_running', 1);
            IF v_max > 0 THEN
                -- One job at a time decides: two bridges asking at once would both see a free slot.
                PERFORM pg_advisory_xact_lock(hashtext('bridge_import_running'));
                UPDATE public.discord_bridge_imports i
                   SET state = 'paused', updated_at = now()
                 WHERE i.state = 'running' AND i.id <> v_row.id AND i.updated_at < now() - c_stale;
                IF (SELECT count(*) FROM public.discord_bridge_imports i
                     WHERE i.state = 'running' AND i.id <> v_row.id) >= v_max THEN
                    RAISE EXCEPTION 'import_busy' USING ERRCODE = '53400', DETAIL = '30';
                END IF;
            END IF;
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
           replies_cursor = CASE WHEN p_patch ? 'phase' THEN NULL ELSE i.replies_cursor END,
           error = CASE WHEN p_patch ? 'error' THEN left(p_patch ->> 'error', 200) ELSE i.error END,
           authors_skipped = CASE WHEN p_patch ? 'authors_skipped'
               THEN GREATEST((p_patch ->> 'authors_skipped')::integer, 0) ELSE i.authors_skipped END,
           updated_at = now(),
           finished_at = CASE WHEN v_state IN ('done', 'failed', 'cancelled') THEN now()
                              ELSE i.finished_at END
     WHERE i.id = v_row.id
    RETURNING * INTO v_row;
    RETURN v_row;
END;
$$;

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

    -- A running job is first asked to stop, for its bridge to finish the step it is on; asked
    -- again, it ends here.
    RETURN QUERY
    UPDATE public.discord_bridge_imports i
       SET state = CASE WHEN i.state IN ('queued', 'paused') OR (i.state = 'running' AND i.cancel_requested)
                        THEN 'cancelled' ELSE i.state END,
           cancel_requested = CASE WHEN i.state = 'running' THEN true ELSE i.cancel_requested END,
           finished_at = CASE WHEN i.state IN ('queued', 'paused') OR (i.state = 'running' AND i.cancel_requested)
                              THEN now() ELSE i.finished_at END,
           updated_at = now()
     WHERE i.bridge_id = p_bridge_id
       AND (p_import_id IS NULL OR i.id = p_import_id)
       AND i.state IN ('queued', 'paused', 'running')
    RETURNING i.*;
END;
$$;

-- ---------------------------------------------------------------------------
-- Replies phase
-- ---------------------------------------------------------------------------

-- The next p_limit rows of the job's channel below replies_cursor, newest first: the imported
-- replies among them are linked to their targets (bridge_import_link_replies_core). done: the page
-- was the channel's last. The created_at bound is the index range of the channel's
-- (channel_id, created_at DESC) index; the row comparison orders ties.
CREATE OR REPLACE FUNCTION public.bridge_import_link_replies_page(
    p_bot_id uuid,
    p_import_id uuid,
    p_limit integer DEFAULT 2000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_job public.discord_bridge_imports;
    v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 2000), 1), 10000);
    v_at timestamptz;
    v_id uuid;
    v_ids uuid[];
    v_rows integer;
    v_last_at timestamptz;
    v_last_id uuid;
    v_linked integer := 0;
BEGIN
    v_job := public.bridge_import_guard(p_bot_id, p_import_id);
    IF v_job.state <> 'running' THEN
        RETURN jsonb_build_object('not_running', true, 'state', v_job.state, 'error', v_job.error);
    END IF;

    IF jsonb_typeof(v_job.replies_cursor) = 'object' THEN
        v_at := (v_job.replies_cursor ->> 'at')::timestamptz;
        v_id := (v_job.replies_cursor ->> 'id')::uuid;
    END IF;

    SELECT COALESCE(array_agg(s.id) FILTER (WHERE s.unlinked), ARRAY[]::uuid[]),
           count(*),
           (array_agg(s.created_at ORDER BY s.created_at, s.id))[1],
           (array_agg(s.id ORDER BY s.created_at, s.id))[1]
      INTO v_ids, v_rows, v_last_at, v_last_id
      FROM (SELECT m.id, m.created_at,
                   (m.reply_to IS NULL AND m.metadata ? 'discord_reply_to'
                    AND m.metadata ->> 'history_import' = 'true') AS unlinked
              FROM public.messages m
             WHERE m.channel_id = v_job.harmony_channel_id
               AND m.created_at <= COALESCE(v_at, 'infinity'::timestamptz)
               AND (v_at IS NULL OR (m.created_at, m.id) < (v_at, v_id))
             ORDER BY m.created_at DESC, m.id DESC
             LIMIT v_limit) s;

    IF cardinality(v_ids) > 0 THEN
        PERFORM set_config('harmony.history_import', 'true', true);
        v_linked := public.bridge_import_link_replies_core(v_job.harmony_channel_id, v_ids);
    END IF;

    UPDATE public.discord_bridge_imports i
       SET replies_cursor = CASE WHEN v_rows >= v_limit
                                 THEN jsonb_build_object('at', v_last_at, 'id', v_last_id) END,
           updated_at = now()
     WHERE i.id = v_job.id;

    RETURN jsonb_build_object('linked', v_linked, 'done', v_rows < v_limit);
END;
$$;

-- ---------------------------------------------------------------------------
-- Threads
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.bridge_import_thread(p_bot_id uuid, p_import_id uuid, p_thread jsonb)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_job public.discord_bridge_imports;
    v_did text := p_thread ->> 'discord_thread_id';
    v_name text := left(btrim(COALESCE(p_thread ->> 'name', '')), 100);
    v_created timestamptz;
    v_starter text := NULLIF(p_thread ->> 'starter_discord_message_id', '');
    v_user jsonb := p_thread -> 'discord_user';
    v_archived boolean := COALESCE((p_thread ->> 'archived')::boolean, false);
    v_locked boolean := COALESCE((p_thread ->> 'locked')::boolean, false);
    v_parent uuid;
    v_thread_id uuid;
    v_notice_id uuid;
    v_notice jsonb;
    v_opted boolean;
BEGIN
    v_job := public.bridge_import_guard(p_bot_id, p_import_id);
    IF v_job.state <> 'running' THEN
        RETURN NULL;
    END IF;
    IF p_thread IS NULL OR jsonb_typeof(p_thread) <> 'object' OR v_did IS NULL OR v_did !~ '^[0-9]{1,20}$'
       OR (p_thread ->> 'created_at') IS NULL THEN
        RAISE EXCEPTION 'invalid_thread' USING ERRCODE = '22023', DETAIL = COALESCE(v_did, '');
    END IF;
    IF v_name = '' THEN
        RAISE EXCEPTION 'Thread name must be 1 to 100 characters' USING ERRCODE = '22023';
    END IF;
    v_created := LEAST((p_thread ->> 'created_at')::timestamptz, now());

    PERFORM set_config('harmony.history_import', 'true', true);

    PERFORM pg_advisory_xact_lock(hashtext('bridge_thread:' || v_job.bridge_id::text || ':' || v_did));
    SELECT bt.thread_id INTO v_thread_id
      FROM public.discord_bridge_threads bt
     WHERE bt.bridge_id = v_job.bridge_id AND bt.discord_thread_id = v_did;
    IF v_thread_id IS NOT NULL THEN
        RETURN v_thread_id;
    END IF;

    -- A person deleted the Harmony thread: it stays deleted.
    IF EXISTS (SELECT 1 FROM public.discord_bridge_deleted_threads d
                WHERE d.bridge_id = v_job.bridge_id AND d.discord_thread_id = v_did) THEN
        RAISE EXCEPTION 'thread_deleted' USING ERRCODE = '55000', DETAIL = v_did;
    END IF;

    -- The title is the author's text: the thread of an opted-out author, or one started before its
    -- author's last opt-in, is imported under a plain name.
    v_opted := jsonb_typeof(v_user) = 'object' AND (EXISTS (
        SELECT 1
          FROM public.bridge_remote_optouts o
          JOIN public.discord_bridges b ON b.server_id = o.server_id
         WHERE b.id = v_job.bridge_id AND o.platform = 'discord' AND o.remote_user_id = v_user ->> 'id')
        OR EXISTS (
        SELECT 1
          FROM public.bridge_remote_optins i
          JOIN public.discord_bridges b ON b.server_id = i.server_id
         WHERE b.id = v_job.bridge_id AND i.platform = 'discord' AND i.remote_user_id = v_user ->> 'id'
           AND i.opted_in_at > v_created));
    IF v_opted THEN
        v_name := 'Thread';
    END IF;

    v_notice := jsonb_build_object('type', 'thread_created', 'actor_bot_id', p_bot_id, 'thread_name', v_name,
                                   'bridge_source', 'discord', 'history_import', true, 'created_via', 'history_import');
    IF jsonb_typeof(v_user) = 'object' AND v_user ->> 'id' ~ '^[0-9]{1,20}$' AND NOT v_opted THEN
        v_notice := v_notice || jsonb_build_object('discord_user', jsonb_strip_nulls(jsonb_build_object(
            'id', v_user ->> 'id',
            'username', left(v_user ->> 'username', 100),
            'display_name', left(v_user ->> 'display_name', 100),
            'avatar_url', CASE WHEN v_user ->> 'avatar_url' ~ '^https://' THEN left(v_user ->> 'avatar_url', 2048) END)));
    END IF;

    IF v_starter IS NOT NULL THEN
        SELECT m.id INTO v_parent
          FROM public.messages m
         WHERE m.channel_id = v_job.harmony_channel_id
           AND m.metadata ? 'discord_message_id'
           AND m.metadata ->> 'discord_message_id' = v_starter
           AND m.is_deleted IS NOT TRUE
           AND m.thread_id IS NULL;
    END IF;

    IF v_parent IS NOT NULL THEN
        -- One thread per message; an existing one is paired and returned.
        PERFORM pg_advisory_xact_lock(hashtext('create_thread:' || v_parent::text));
        SELECT t.id INTO v_thread_id FROM public.threads t WHERE t.parent_message_id = v_parent;

        IF v_thread_id IS NULL THEN
            INSERT INTO public.threads (channel_id, parent_message_id, name, created_by, auto_archive_duration,
                                        created_at, updated_at, archived, archived_at, locked)
            VALUES (v_job.harmony_channel_id, v_parent, v_name, NULL, 1440, v_created, v_created,
                    v_archived, CASE WHEN v_archived THEN v_created END, v_locked)
            RETURNING id INTO v_thread_id;

            -- A system row has no author (messages_system_authorless); the bot is in metadata.
            INSERT INTO public.messages (created_at, channel_id, content, is_system, metadata)
            VALUES (v_created, v_job.harmony_channel_id,
                    '[{"type": "text", "text": "started a thread"}]'::jsonb, true,
                    v_notice || jsonb_build_object('thread_id', v_thread_id));
        END IF;
    ELSE
        v_thread_id := gen_random_uuid();
        INSERT INTO public.messages (created_at, channel_id, content, is_system, metadata)
        VALUES (v_created, v_job.harmony_channel_id,
                '[{"type": "text", "text": "started a thread"}]'::jsonb, true,
                v_notice || jsonb_build_object('thread_id', v_thread_id, 'standalone', true))
        RETURNING id INTO v_notice_id;

        INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by, auto_archive_duration,
                                    created_at, updated_at, archived, archived_at, locked)
        VALUES (v_thread_id, v_job.harmony_channel_id, v_notice_id, v_name, NULL, 1440, v_created, v_created,
                v_archived, CASE WHEN v_archived THEN v_created END, v_locked);
    END IF;

    INSERT INTO public.discord_bridge_threads (thread_id, bridge_id, discord_thread_id)
    VALUES (v_thread_id, v_job.bridge_id, v_did)
    ON CONFLICT (thread_id) DO NOTHING;

    RETURN v_thread_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Purge
-- ---------------------------------------------------------------------------

-- After a purge (p_server_id NULL: every server): unfinished imports fail with p_error, or they
-- would bring the content back, and every import that is not done starts over at its next start:
-- its cursors marked the purged history as imported. A done import starts over anyway
-- (discord_bridge_import_start_internal). The thread pairs go: the purge erased the Discord ids
-- of the threads' starters, and a re-import builds each thread again on its re-imported starter.
CREATE OR REPLACE FUNCTION public.bridge_privacy_stop_imports(p_server_id uuid, p_error text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    UPDATE public.discord_bridge_imports i
       SET state = CASE WHEN i.state IN ('queued', 'running', 'paused') THEN 'failed' ELSE i.state END,
           error = CASE WHEN i.state IN ('queued', 'running', 'paused') THEN p_error ELSE i.error END,
           finished_at = CASE WHEN i.state IN ('queued', 'running', 'paused') THEN now() ELSE i.finished_at END,
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
           replies_cursor = NULL,
           imported_count = 0,
           skipped_count = 0,
           pins_skipped = 0,
           authors_skipped = 0,
           automod_skipped = 0,
           updated_at = now()
     WHERE i.state <> 'done'
       AND (p_server_id IS NULL
            OR i.bridge_id IN (SELECT b.id FROM public.discord_bridges b WHERE b.server_id = p_server_id))
       AND (i.state IN ('queued', 'running', 'paused') OR i.phase <> 'messages'
            OR i.reached_discord_message_id IS NOT NULL OR i.start_discord_message_id IS NOT NULL
            OR i.thread_cursor IS NOT NULL OR i.replies_cursor IS NOT NULL OR i.imported_count <> 0);

    DELETE FROM public.discord_bridge_threads bt
     WHERE p_server_id IS NULL
        OR bt.bridge_id IN (SELECT b.id FROM public.discord_bridges b WHERE b.server_id = p_server_id);
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.discord_bridge_import_start_internal(uuid, text[], text, uuid, jsonb, boolean)',
        'public.discord_bridge_import_update(uuid, uuid, jsonb)',
        'public.discord_bridge_import_cancel_internal(uuid, uuid)',
        'public.bridge_import_link_replies_page(uuid, uuid, integer)',
        'public.bridge_import_thread(uuid, uuid, jsonb)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.bridge_privacy_stop_imports(uuid, text) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
