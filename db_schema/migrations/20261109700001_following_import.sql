-- Following import: a list of accounts, from Mastodon's following_accounts.csv or Harmony's
-- export, followed by the importing account in a queued job. Mirrors Mastodon's BulkImportService
-- and FollowService.
--
-- start_following_import(p_handles, p_source) stores one following_import_items row per distinct
-- handle and queues 'following-import' { import_id }. Malformed rows are stored failed, so the
-- result names them. Errors: account_suspended, account_moved, invalid_source, no_accounts,
-- too_many_accounts { max }, import_running. Raises PT429 import_rate_limited (DETAIL
-- retry_after=<seconds>) past five imports in 24 hours.
--
-- The worker repeats claim_following_import_batch, resolves each handle (WebFinger and an actor
-- fetch for a remote account) and answers with finish_following_import_item.
--
-- A follow takes the status a client insert gets (follow_initial_status, shared with
-- guard_follow_client_write): accepted for an unlocked local account, pending for a locked or
-- remote one, refused when a block stands either way. As FollowService, a deleted, suspended or
-- moved target is refused. The follows triggers send the Follow and notify, as for a client insert.
--
-- antispam_write_guard exempts a service_role write. An import follows at the importer's
-- account_follows_per_hour instead (following_import_budget), counted apart from follows the
-- account makes itself so an import never refuses those. Instance limit exemptions apply.
--
-- Stale claims: a claim older than ten minutes returns to the queue. A retried item waits ten
-- minutes per attempt. The third failure is final.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.following_imports (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    profile_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    source text NOT NULL CHECK (source IN ('mastodon_csv', 'harmony_export')),
    total integer NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    next_run_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    cancelled_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS following_imports_one_running
    ON public.following_imports (profile_id) WHERE finished_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_following_imports_profile
    ON public.following_imports (profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_following_imports_next_run
    ON public.following_imports (next_run_at) WHERE finished_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_following_imports_finished
    ON public.following_imports (finished_at) WHERE finished_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.following_import_items (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    import_id uuid NOT NULL REFERENCES public.following_imports(id) ON DELETE CASCADE,
    handle text NOT NULL,
    state text NOT NULL DEFAULT 'queued'
        CHECK (state IN ('queued', 'claimed', 'followed', 'requested', 'already_following',
                         'already_requested', 'failed', 'cancelled')),
    reason text,
    attempts smallint NOT NULL DEFAULT 0,
    not_before timestamptz,
    claimed_at timestamptz,
    finished_at timestamptz,
    UNIQUE (import_id, handle)
);
CREATE INDEX IF NOT EXISTS idx_following_import_items_open
    ON public.following_import_items (import_id, id) WHERE state IN ('queued', 'claimed');
CREATE INDEX IF NOT EXISTS idx_following_import_items_counted
    ON public.following_import_items (import_id, finished_at) WHERE state IN ('followed', 'requested');

ALTER TABLE public.following_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.following_import_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS following_imports_service_role ON public.following_imports;
CREATE POLICY following_imports_service_role ON public.following_imports
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS following_import_items_service_role ON public.following_import_items;
CREATE POLICY following_import_items_service_role ON public.following_import_items
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.following_imports FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.following_import_items FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.following_imports TO service_role;
GRANT ALL ON public.following_import_items TO service_role;

COMMENT ON TABLE public.following_imports IS
    'One row per following import; next_run_at is when the worker should next run it.';
COMMENT ON TABLE public.following_import_items IS
    'One handle of a following import and how it ended; reason names a failure.';

-- ---------------------------------------------------------------------------
-- The follow path
-- ---------------------------------------------------------------------------

-- Status a follow starts with; NULL when a block stands between the accounts.
-- Mirrors Mastodon's FollowService.
CREATE OR REPLACE FUNCTION public.follow_initial_status(p_follower uuid, p_following uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_manual boolean;
    v_target_local boolean;
BEGIN
    IF EXISTS (SELECT 1 FROM public.user_blocks b
                WHERE (b.blocker_id = p_following AND b.blocked_user_id = p_follower)
                   OR (b.blocker_id = p_follower AND b.blocked_user_id = p_following)) THEN
        RETURN NULL;
    END IF;

    SELECT p.manually_approves_followers, p.is_local
      INTO v_manual, v_target_local
      FROM public.profiles p
     WHERE p.id = p_following;

    RETURN CASE WHEN v_target_local IS TRUE AND v_manual IS NOT TRUE THEN 'accepted' ELSE 'pending' END;
END;
$$;

REVOKE ALL ON FUNCTION public.follow_initial_status(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- As 20261011900001_follow_approval.sql, the insert's decision in follow_initial_status.
-- Sorts before trigger_federate_follow and trigger_federate_follow_response, which copy
-- NEW.status into the federation job.
CREATE OR REPLACE FUNCTION public.guard_follow_client_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid;
    v_status text;
BEGIN
    IF COALESCE(current_setting('role', true), '') NOT IN ('anon', 'authenticated')
       OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        v_status := public.follow_initial_status(NEW.follower_id, NEW.following_id);
        IF v_status IS NULL THEN
            RAISE EXCEPTION 'a block stands between these accounts'
                USING ERRCODE = '42501';
        END IF;

        NEW.status := v_status;
        NEW.accepted_at := CASE WHEN NEW.status = 'accepted' THEN now() END;
        NEW.ap_id := NULL;
        NEW.is_local := true;
        NEW.federation_status := 'pending';
        NEW.created_at := now();
        NEW.updated_at := now();
        RETURN NEW;
    END IF;

    IF NEW.follower_id IS DISTINCT FROM OLD.follower_id
       OR NEW.following_id IS DISTINCT FROM OLD.following_id
       OR NEW.ap_id IS DISTINCT FROM OLD.ap_id
       OR NEW.is_local IS DISTINCT FROM OLD.is_local
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.federation_status IS DISTINCT FROM OLD.federation_status
       OR NEW.metadata IS DISTINCT FROM OLD.metadata THEN
        RAISE EXCEPTION 'follow participants and federation fields are fixed'
            USING ERRCODE = '42501';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        v_caller := public.get_current_profile_id();
        IF v_caller IS NULL OR OLD.following_id IS DISTINCT FROM v_caller THEN
            RAISE EXCEPTION 'only the followed account answers a follow request'
                USING ERRCODE = '42501';
        END IF;
        IF OLD.status IS DISTINCT FROM 'pending'
           OR COALESCE(NEW.status, '') NOT IN ('accepted', 'rejected') THEN
            RAISE EXCEPTION 'a pending follow request is answered with accepted or rejected'
                USING ERRCODE = '42501';
        END IF;
        NEW.accepted_at := CASE WHEN NEW.status = 'accepted' THEN now() END;
    ELSE
        NEW.accepted_at := OLD.accepted_at;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_follow_client_write() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Follows the account may still import this hour (NULL: no limit) and, at none, the seconds until
-- the oldest counted one leaves the window. A claimed item counts as a follow made.
CREATE OR REPLACE FUNCTION public.following_import_budget(p_profile uuid, OUT remaining integer, OUT retry_after integer)
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_limit integer;
    v_used integer;
    v_oldest timestamptz;
BEGIN
    v_limit := public.antispam_int(public.antispam_settings() -> 'account_follows_per_hour', 0);
    IF v_limit <= 0 OR public.antispam_account_exempt(p_profile) THEN
        RETURN;
    END IF;

    SELECT count(*), min(i.finished_at)
      INTO v_used, v_oldest
      FROM public.following_import_items i
      JOIN public.following_imports fi ON fi.id = i.import_id
     WHERE fi.profile_id = p_profile
       AND ((i.state IN ('followed', 'requested') AND i.finished_at > now() - interval '1 hour')
            OR i.state = 'claimed');

    remaining := greatest(v_limit - v_used, 0);
    IF remaining = 0 THEN
        -- No finished follow in the window: the budget is out on claims, which end within minutes.
        retry_after := CASE WHEN v_oldest IS NULL THEN 60
                            ELSE greatest(1, ceil(extract(epoch FROM v_oldest + interval '1 hour' - now())))::integer END;
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.following_import_budget(uuid) FROM PUBLIC, anon, authenticated;

-- Ends an import: items not yet followed are cancelled.
CREATE OR REPLACE FUNCTION public.close_following_import(p_import_id uuid, p_cancelled boolean)
RETURNS void
LANGUAGE sql
SET search_path = public, pg_temp
AS $$
    UPDATE public.following_import_items
       SET state = 'cancelled', finished_at = now()
     WHERE import_id = p_import_id AND state IN ('queued', 'claimed');
    UPDATE public.following_imports
       SET finished_at = now(),
           cancelled_at = CASE WHEN p_cancelled THEN now() END
     WHERE id = p_import_id AND finished_at IS NULL;
$$;

REVOKE ALL ON FUNCTION public.close_following_import(uuid, boolean) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Client RPCs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.start_following_import(p_handles text[], p_source text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    -- Mastodon's Form::Import ROWS_PROCESSING_LIMIT.
    v_max CONSTANT integer := 20000;
    v_profile public.profiles%ROWTYPE;
    v_handles text[];
    v_recent integer;
    v_oldest timestamptz;
    v_import uuid;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    SELECT p.* INTO v_profile FROM public.profiles p WHERE p.id = public.get_current_profile_id();
    IF v_profile.id IS NULL OR v_profile.is_local IS NOT TRUE OR v_profile.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF coalesce(v_profile.is_suspended, false) THEN
        RETURN jsonb_build_object('error', 'account_suspended');
    END IF;
    IF v_profile.moved_to_id IS NOT NULL OR v_profile.moved_to_uri IS NOT NULL THEN
        RETURN jsonb_build_object('error', 'account_moved');
    END IF;
    IF p_source IS NULL OR p_source NOT IN ('mastodon_csv', 'harmony_export') THEN
        RETURN jsonb_build_object('error', 'invalid_source');
    END IF;

    -- Distinct without regard to case.
    SELECT coalesce(array_agg(d.handle ORDER BY d.ord), '{}') INTO v_handles
      FROM (SELECT DISTINCT ON (lower(n.handle)) n.handle, n.ord
              FROM (SELECT left(regexp_replace(btrim(t.raw), '^@', ''), 320) AS handle, t.ord
                      FROM unnest(coalesce(p_handles, '{}'::text[])) WITH ORDINALITY AS t(raw, ord)) n
             WHERE n.handle <> ''
             ORDER BY lower(n.handle), n.ord) d;
    IF cardinality(v_handles) = 0 THEN
        RETURN jsonb_build_object('error', 'no_accounts');
    END IF;
    IF cardinality(v_handles) > v_max THEN
        RETURN jsonb_build_object('error', 'too_many_accounts', 'max', v_max);
    END IF;

    IF EXISTS (SELECT 1 FROM public.following_imports fi
                WHERE fi.profile_id = v_profile.id AND fi.finished_at IS NULL) THEN
        RETURN jsonb_build_object('error', 'import_running');
    END IF;

    SELECT count(*), min(fi.created_at) INTO v_recent, v_oldest
      FROM public.following_imports fi
     WHERE fi.profile_id = v_profile.id AND fi.created_at > now() - interval '1 day';
    IF v_recent >= 5 THEN
        RAISE SQLSTATE 'PT429' USING MESSAGE = 'import_rate_limited',
            DETAIL = 'retry_after=' || ceil(extract(epoch FROM v_oldest + interval '1 day' - now()))::bigint;
    END IF;

    INSERT INTO public.following_imports (profile_id, source, total)
    VALUES (v_profile.id, p_source, cardinality(v_handles))
    RETURNING id INTO v_import;

    -- Matches parseAccountHandle in the federation backend, with the domain required.
    INSERT INTO public.following_import_items (import_id, handle, state, reason, finished_at)
    SELECT v_import, h,
           CASE WHEN h ~ '^[A-Za-z0-9_.-]{1,64}@[A-Za-z0-9.-]+(:[0-9]+)?$' THEN 'queued' ELSE 'failed' END,
           CASE WHEN h ~ '^[A-Za-z0-9_.-]{1,64}@[A-Za-z0-9.-]+(:[0-9]+)?$' THEN NULL ELSE 'invalid_handle' END,
           CASE WHEN h ~ '^[A-Za-z0-9_.-]{1,64}@[A-Za-z0-9.-]+(:[0-9]+)?$' THEN NULL ELSE now() END
      FROM unnest(v_handles) h;

    PERFORM public.queue_federation_job('following-import',
        jsonb_build_object('import_id', v_import), 7, 5, 86400);

    RETURN jsonb_build_object('success', true, 'import_id', v_import, 'total', cardinality(v_handles));
EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('error', 'import_running');
END;
$$;

-- The caller's latest import, or NULL: its counts, up to 200 failures, and the seconds until the
-- follow limit lets it continue when it is waiting on that limit.
CREATE OR REPLACE FUNCTION public.get_my_following_import()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.get_current_profile_id();
    v_import public.following_imports%ROWTYPE;
    v_retry integer;
BEGIN
    IF auth.uid() IS NULL OR v_profile IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    SELECT fi.* INTO v_import
      FROM public.following_imports fi
     WHERE fi.profile_id = v_profile
     ORDER BY fi.created_at DESC
     LIMIT 1;
    IF v_import.id IS NULL THEN
        RETURN NULL;
    END IF;

    IF v_import.finished_at IS NULL THEN
        SELECT b.retry_after INTO v_retry FROM public.following_import_budget(v_profile) b;
    END IF;

    RETURN jsonb_build_object(
        'id', v_import.id,
        'source', v_import.source,
        'total', v_import.total,
        'created_at', v_import.created_at,
        'finished_at', v_import.finished_at,
        'cancelled', v_import.cancelled_at IS NOT NULL,
        'retry_after', v_retry,
        'counts', (SELECT jsonb_build_object(
                       'followed', count(*) FILTER (WHERE i.state = 'followed'),
                       'requested', count(*) FILTER (WHERE i.state = 'requested'),
                       'already_following', count(*) FILTER (WHERE i.state = 'already_following'),
                       'already_requested', count(*) FILTER (WHERE i.state = 'already_requested'),
                       'failed', count(*) FILTER (WHERE i.state = 'failed'),
                       'cancelled', count(*) FILTER (WHERE i.state = 'cancelled'))
                     FROM public.following_import_items i
                    WHERE i.import_id = v_import.id),
        'failures', (SELECT coalesce(jsonb_agg(jsonb_build_object('handle', f.handle, 'reason', f.reason)
                                               ORDER BY f.id), '[]'::jsonb)
                       FROM (SELECT i.id, i.handle, i.reason
                               FROM public.following_import_items i
                              WHERE i.import_id = v_import.id AND i.state = 'failed'
                              ORDER BY i.id
                              LIMIT 200) f));
END;
$$;

-- Errors: not_running. Follows already made stay.
CREATE OR REPLACE FUNCTION public.cancel_my_following_import()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.get_current_profile_id();
    v_import uuid;
BEGIN
    IF auth.uid() IS NULL OR v_profile IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    SELECT fi.id INTO v_import
      FROM public.following_imports fi
     WHERE fi.profile_id = v_profile AND fi.finished_at IS NULL
       FOR UPDATE;
    IF v_import IS NULL THEN
        RETURN jsonb_build_object('error', 'not_running');
    END IF;
    PERFORM public.close_following_import(v_import, true);
    RETURN jsonb_build_object('success', true);
END;
$$;

REVOKE ALL ON FUNCTION public.start_following_import(text[], text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_my_following_import() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cancel_my_following_import() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.start_following_import(text[], text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_following_import() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_my_following_import() TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Worker RPCs
-- ---------------------------------------------------------------------------

-- Returns { finished } and, unfinished, { items: [{ id, handle }], retry_after }: retry_after is
-- the seconds to wait when nothing can be claimed yet. An importer deleted, suspended or moved
-- since the start closes the import.
CREATE OR REPLACE FUNCTION public.claim_following_import_batch(p_import_id uuid, p_limit integer DEFAULT 25)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_import public.following_imports%ROWTYPE;
    v_profile public.profiles%ROWTYPE;
    v_limit integer := least(greatest(coalesce(p_limit, 25), 1), 100);
    v_remaining integer;
    v_retry integer;
    v_items jsonb;
    v_next timestamptz;
BEGIN
    SELECT fi.* INTO v_import FROM public.following_imports fi WHERE fi.id = p_import_id FOR UPDATE;
    IF v_import.id IS NULL OR v_import.finished_at IS NOT NULL THEN
        RETURN jsonb_build_object('finished', true);
    END IF;

    SELECT p.* INTO v_profile FROM public.profiles p WHERE p.id = v_import.profile_id;
    IF v_profile.id IS NULL OR v_profile.deleted_at IS NOT NULL
       OR coalesce(v_profile.is_suspended, false)
       OR v_profile.moved_to_id IS NOT NULL OR v_profile.moved_to_uri IS NOT NULL THEN
        PERFORM public.close_following_import(p_import_id, true);
        RETURN jsonb_build_object('finished', true);
    END IF;

    UPDATE public.following_import_items i
       SET state = CASE WHEN i.attempts >= 2 THEN 'failed' ELSE 'queued' END,
           reason = CASE WHEN i.attempts >= 2 THEN 'unreachable' END,
           attempts = i.attempts + 1,
           finished_at = CASE WHEN i.attempts >= 2 THEN now() END,
           claimed_at = NULL
     WHERE i.import_id = p_import_id
       AND i.state = 'claimed'
       AND i.claimed_at < now() - interval '10 minutes';

    SELECT b.remaining, b.retry_after INTO v_remaining, v_retry
      FROM public.following_import_budget(v_import.profile_id) b;

    IF v_remaining IS NOT NULL THEN
        v_limit := least(v_limit, v_remaining);
    END IF;

    IF v_limit > 0 THEN
        WITH claimed AS (
            UPDATE public.following_import_items i
               SET state = 'claimed', claimed_at = now()
             WHERE i.id IN (SELECT q.id
                              FROM public.following_import_items q
                             WHERE q.import_id = p_import_id
                               AND q.state = 'queued'
                               AND (q.not_before IS NULL OR q.not_before <= now())
                             ORDER BY q.id
                             LIMIT v_limit
                               FOR UPDATE SKIP LOCKED)
            RETURNING i.id, i.handle
        )
        SELECT jsonb_agg(jsonb_build_object('id', c.id, 'handle', c.handle) ORDER BY c.id) INTO v_items
          FROM claimed c;
    END IF;

    IF v_items IS NOT NULL THEN
        UPDATE public.following_imports SET next_run_at = now() WHERE id = p_import_id;
        RETURN jsonb_build_object('finished', false, 'items', v_items);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.following_import_items i
                    WHERE i.import_id = p_import_id AND i.state IN ('queued', 'claimed')) THEN
        UPDATE public.following_imports SET finished_at = now(), next_run_at = now() WHERE id = p_import_id;
        RETURN jsonb_build_object('finished', true);
    END IF;

    -- Budget spent, every queued item waiting on a retry, or claims still out.
    SELECT min(i.not_before) INTO v_next
      FROM public.following_import_items i
     WHERE i.import_id = p_import_id AND i.state = 'queued' AND i.not_before > now();
    v_retry := coalesce(v_retry,
                        CASE WHEN v_next IS NOT NULL
                             THEN greatest(1, ceil(extract(epoch FROM v_next - now())))::integer END,
                        60);
    UPDATE public.following_imports
       SET next_run_at = now() + make_interval(secs => v_retry)
     WHERE id = p_import_id;
    RETURN jsonb_build_object('finished', false, 'items', '[]'::jsonb, 'retry_after', v_retry);
END;
$$;

-- p_failure NULL: follow p_target_profile_id. Otherwise the item failed with that reason; with
-- p_retry_seconds it waits that long per attempt and runs again, up to three attempts. Returns the
-- item's state. Failure reasons from here: unavailable, self, moved, blocked, declined.
CREATE OR REPLACE FUNCTION public.finish_following_import_item(
    p_item_id bigint, p_target_profile_id uuid, p_failure text DEFAULT NULL, p_retry_seconds integer DEFAULT NULL)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_item public.following_import_items%ROWTYPE;
    v_import public.following_imports%ROWTYPE;
    v_target public.profiles%ROWTYPE;
    v_existing text;
    v_status text;
    v_state text;
    v_reason text := p_failure;
BEGIN
    SELECT i.* INTO v_item FROM public.following_import_items i WHERE i.id = p_item_id FOR UPDATE;
    IF v_item.id IS NULL THEN
        RETURN NULL;
    END IF;
    IF v_item.state <> 'claimed' THEN
        RETURN v_item.state;
    END IF;
    SELECT fi.* INTO v_import FROM public.following_imports fi WHERE fi.id = v_item.import_id;

    IF p_failure IS NOT NULL AND p_retry_seconds IS NOT NULL AND v_item.attempts < 2 THEN
        UPDATE public.following_import_items
           SET state = 'queued', attempts = attempts + 1, claimed_at = NULL,
               not_before = now() + make_interval(secs => p_retry_seconds * (attempts + 1))
         WHERE id = p_item_id;
        UPDATE public.following_imports
           SET next_run_at = greatest(next_run_at, now())
         WHERE id = v_item.import_id;
        RETURN 'queued';
    END IF;

    IF p_failure IS NULL THEN
        SELECT p.* INTO v_target FROM public.profiles p WHERE p.id = p_target_profile_id;
        IF v_target.id IS NULL OR v_target.deleted_at IS NOT NULL OR coalesce(v_target.is_suspended, false) THEN
            v_reason := 'unavailable';
        ELSIF v_target.id = v_import.profile_id THEN
            v_reason := 'self';
        ELSE
            SELECT f.status INTO v_existing FROM public.follows f
             WHERE f.follower_id = v_import.profile_id AND f.following_id = v_target.id;
            IF v_existing = 'accepted' THEN
                v_state := 'already_following';
            ELSIF v_existing = 'pending' THEN
                v_state := 'already_requested';
            ELSIF v_existing IS NOT NULL THEN
                v_reason := 'declined';
            ELSIF v_target.moved_to_id IS NOT NULL OR v_target.moved_to_uri IS NOT NULL THEN
                v_reason := 'moved';
            ELSE
                v_status := public.follow_initial_status(v_import.profile_id, v_target.id);
                IF v_status IS NULL THEN
                    v_reason := 'blocked';
                ELSE
                    INSERT INTO public.follows (follower_id, following_id, status, accepted_at, is_local)
                    VALUES (v_import.profile_id, v_target.id, v_status,
                            CASE WHEN v_status = 'accepted' THEN now() END, true)
                    ON CONFLICT (follower_id, following_id) DO NOTHING;
                    v_state := CASE WHEN NOT FOUND THEN 'already_following'
                                    WHEN v_status = 'accepted' THEN 'followed'
                                    ELSE 'requested' END;
                END IF;
            END IF;
        END IF;
    END IF;

    v_state := coalesce(v_state, 'failed');
    UPDATE public.following_import_items
       SET state = v_state,
           reason = CASE WHEN v_state = 'failed' THEN v_reason END,
           finished_at = now()
     WHERE id = p_item_id;
    UPDATE public.following_imports
       SET next_run_at = greatest(next_run_at, now())
     WHERE id = v_item.import_id;
    RETURN v_state;
END;
$$;

-- Results are kept 30 days. A deleted account's go with its 'account-deleted' job.
CREATE OR REPLACE FUNCTION public.purge_following_imports()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    v_removed integer;
BEGIN
    DELETE FROM public.following_imports fi
     WHERE fi.finished_at < now() - interval '30 days';
    GET DIAGNOSTICS v_removed = ROW_COUNT;
    RETURN v_removed;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_following_import_batch(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_following_import_item(bigint, uuid, text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.purge_following_imports() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_following_import_batch(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_following_import_item(bigint, uuid, text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.purge_following_imports() TO service_role;

-- ---------------------------------------------------------------------------
-- Ownership
-- ---------------------------------------------------------------------------

-- As in 20261005400001_account_security.sql: a definer created by supabase_admin would call
-- postgres-owned helpers whose PUBLIC grant is revoked.
DO $$
DECLARE
    fn regprocedure;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'postgres') THEN
        RAISE NOTICE 'postgres role absent, ownership left with %', current_user;
        RETURN;
    END IF;
    FOR fn IN
        SELECT p.oid::regprocedure
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN (
               'follow_initial_status', 'guard_follow_client_write', 'following_import_budget',
               'close_following_import', 'start_following_import', 'get_my_following_import',
               'cancel_my_following_import', 'claim_following_import_batch',
               'finish_following_import_item', 'purge_following_imports')
           AND pg_get_userbyid(p.proowner) <> 'postgres'
    LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', fn);
    END LOOP;
    ALTER TABLE public.following_imports OWNER TO postgres;
    ALTER TABLE public.following_import_items OWNER TO postgres;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
