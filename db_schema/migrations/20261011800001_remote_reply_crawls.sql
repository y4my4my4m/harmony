-- Reply crawls of remote posts: when they last ran, and counters that do not deadlock them.
--
-- posts.replies_fetched_at is when the federation backend last walked a remote post's replies
-- collection. A walk is due again after 2 minutes for a post under an hour old, 15 minutes
-- under a day, 6 hours beyond. After a walk that reached the end of the collection, the
-- backend writes the number of replies it listed as remote_replies_count: Mastodon's replies
-- collection carries no totalItems, so without it the counter of a remote post is the
-- replies stored here.
--
-- update_post_reply_count locked the parent FOR UPDATE. Inserting a reply first takes FOR KEY
-- SHARE on the parent for the in_reply_to foreign key; FOR UPDATE conflicts with it, so two
-- replies to one post inserted concurrently each waited for the other's KEY SHARE and one
-- aborted with 40P01. A reply crawl stores sibling replies in parallel. FOR NO KEY UPDATE
-- conflicts with itself and not with FOR KEY SHARE: the second insert waits for the first to
-- commit, as the recount requires. update_profile_posts_count locked a local author's profile
-- the same way and takes the same lock now. The UPDATEs that follow change no key column and
-- take FOR NO KEY UPDATE themselves.
--
-- guard_post_client_write keeps replies_fetched_at fixed on client updates and empty on client
-- inserts.
--
-- Converges by state: CREATE OR REPLACE of the 20261011500001 bodies of
-- update_post_reply_count and guard_post_client_write and the baseline body of
-- update_profile_posts_count, each with the change above.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.posts
    ADD COLUMN IF NOT EXISTS replies_fetched_at timestamp with time zone;

COMMENT ON COLUMN public.posts.replies_fetched_at IS
    'Remote post: when its replies collection was last walked; NULL when never.';

-- ---------------------------------------------------------------------------
-- Counters
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.update_post_reply_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
  affected uuid[] := '{}';
  deltas integer[] := '{}';
  parent record;
  parent_is_local boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.in_reply_to IS NOT NULL AND (NEW.is_deleted IS DISTINCT FROM true) THEN
      affected := ARRAY[NEW.in_reply_to];
      deltas := ARRAY[1];
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.in_reply_to IS DISTINCT FROM NEW.in_reply_to THEN
      -- Covers NULL -> parent (federation resolving in_reply_to late),
      -- parent -> NULL, and parent -> different parent.
      IF OLD.in_reply_to IS NOT NULL AND (OLD.is_deleted IS DISTINCT FROM true) THEN
        affected := affected || OLD.in_reply_to;
        deltas := deltas || -1;
      END IF;
      IF NEW.in_reply_to IS NOT NULL AND (NEW.is_deleted IS DISTINCT FROM true) THEN
        affected := affected || NEW.in_reply_to;
        deltas := deltas || 1;
      END IF;
    ELSIF NEW.in_reply_to IS NOT NULL AND OLD.is_deleted IS DISTINCT FROM NEW.is_deleted THEN
      affected := ARRAY[NEW.in_reply_to];
      deltas := ARRAY[CASE WHEN NEW.is_deleted IS TRUE THEN -1 ELSE 1 END];
    END IF;

  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.in_reply_to IS NOT NULL AND (OLD.is_deleted IS DISTINCT FROM true) THEN
      affected := ARRAY[OLD.in_reply_to];
      deltas := ARRAY[-1];
    END IF;
  END IF;

  -- Ascending id: a re-parent locks two rows, and two moves in opposite
  -- directions take them in the same order.
  FOR parent IN
    SELECT x.id, x.delta FROM unnest(affected, deltas) AS x(id, delta) ORDER BY x.id
  LOOP
    -- Lock the parent first so the recompute below takes its snapshot AFTER any
    -- concurrent sibling reply commits (READ COMMITTED would otherwise let the
    -- count subquery miss a just-inserted row and undercount). FOR NO KEY UPDATE
    -- does not conflict with the FOR KEY SHARE the reply's foreign key check holds.
    SELECT is_local INTO parent_is_local
    FROM public.posts WHERE id = parent.id FOR NO KEY UPDATE;

    IF parent_is_local IS TRUE THEN
      UPDATE public.posts p
      SET replies_count = (
        SELECT count(*) FROM public.posts c
        WHERE c.in_reply_to = parent.id AND c.is_deleted IS DISTINCT FROM true
      )
      WHERE p.id = parent.id;
    ELSE
      UPDATE public.posts p
      SET replies_count = CASE
            WHEN p.remote_replies_count IS NOT NULL
            THEN public.remote_engagement_figure(p.id, 'replies', p.remote_replies_count,
                                                 p.remote_counts_fetched_at)
            ELSE GREATEST(COALESCE(p.replies_count, 0) + parent.delta, 0)
          END
      WHERE p.id = parent.id;
    END IF;
  END LOOP;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_profile_posts_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
  author uuid;
BEGIN
  -- Two ids only when a post changes hands, which the trigger sees only if the
  -- same statement also writes is_deleted. Ascending id for the lock order.
  FOR author IN
    SELECT DISTINCT id FROM (VALUES
      (CASE WHEN TG_OP <> 'INSERT' THEN OLD.author_id END),
      (CASE WHEN TG_OP <> 'DELETE' THEN NEW.author_id END)
    ) v(id) WHERE id IS NOT NULL ORDER BY 1
  LOOP
    -- Lock the profile first so the recompute takes its snapshot AFTER any
    -- concurrent post by the same author commits. FOR NO KEY UPDATE for the
    -- reason given in update_post_reply_count: the post's author_id check holds
    -- FOR KEY SHARE on the profile.
    PERFORM 1 FROM public.profiles
     WHERE id = author AND is_local IS TRUE FOR NO KEY UPDATE;

    IF FOUND THEN
      UPDATE public.profiles
      SET posts_count = (
        SELECT count(*) FROM public.posts p
        WHERE p.author_id = author AND p.is_deleted IS DISTINCT FROM true
      )
      WHERE id = author;
    END IF;
  END LOOP;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- ---------------------------------------------------------------------------
-- Client writes
-- ---------------------------------------------------------------------------

-- 20261011500001 body; replies_fetched_at joins v_fixed and is cleared on insert.
CREATE OR REPLACE FUNCTION public.guard_post_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fixed CONSTANT text[] := ARRAY[
        'is_local', 'ap_id', 'ap_type', 'url', 'created_at', 'replies_count',
        'reblogs_count', 'favorites_count', 'remote_replies_count', 'remote_favorites_count',
        'remote_reblogs_count', 'remote_counts_fetched_at', 'replies_fetched_at',
        'federation_status', 'federated_to',
        'last_federated_at', 'reblog', 'reblog_author', 'in_reply_to', 'conversation_id',
        'conversation_root_id', 'edit_history'];
    v_boost_copied CONSTANT text[] := ARRAY[
        'content', 'visibility', 'content_warning', 'is_sensitive', 'media_attachments'];
    v_boost_keys CONSTANT text[] := ARRAY[
        'reblog_of', 'original_author', 'is_quote', 'quote_ap_url', 'in_reply_to_ap_url'];
    v_meta jsonb;
    v_old jsonb;
    v_keep jsonb;
    v_key text;
    v_target uuid;
    v_is_quote boolean;
    v_orig public.posts%ROWTYPE;
    v_parent public.posts%ROWTYPE;
    v_author jsonb;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    v_meta := CASE WHEN jsonb_typeof(NEW.metadata) = 'object' THEN NEW.metadata ELSE '{}'::jsonb END;

    IF TG_OP = 'INSERT' THEN
        IF NEW.is_local IS FALSE THEN
            RAISE EXCEPTION 'remote posts arrive through federation' USING ERRCODE = '42501';
        END IF;
        IF NEW.ap_id IS NOT NULL
           AND NEW.ap_id !~ '^https://[^/]+/activities/[0-9a-fA-F-]{36}$' THEN
            RAISE EXCEPTION 'ap_id is assigned by the server' USING ERRCODE = '42501';
        END IF;
        IF NEW.url IS NOT NULL THEN
            RAISE EXCEPTION 'url is assigned by the server' USING ERRCODE = '42501';
        END IF;

        IF v_meta ? 'reblog_of' THEN
            BEGIN
                v_target := (v_meta ->> 'reblog_of')::uuid;
            EXCEPTION WHEN invalid_text_representation THEN
                v_target := NULL;
            END;
            v_is_quote := COALESCE(v_meta -> 'is_quote' IN ('true'::jsonb, '"true"'::jsonb), false);

            -- Read under the caller's RLS: a post the caller cannot see is absent.
            SELECT p.* INTO v_orig FROM public.posts p WHERE p.id = v_target;
            IF NOT FOUND OR v_orig.is_deleted IS TRUE THEN
                RAISE EXCEPTION 'REBLOG_TARGET_NOT_FOUND: post not found' USING ERRCODE = 'P0002';
            END IF;
            IF v_orig.visibility IS NULL OR v_orig.visibility NOT IN ('public', 'unlisted') THEN
                RAISE EXCEPTION 'REBLOG_NOT_ALLOWED: only public and unlisted posts are boosted or quoted'
                    USING ERRCODE = '42501';
            END IF;
            IF v_orig.metadata ? 'reblog_of'
               AND NOT COALESCE(v_orig.metadata -> 'is_quote' IN ('true'::jsonb, '"true"'::jsonb), false) THEN
                RAISE EXCEPTION 'REBLOG_NOT_ALLOWED: a boost is boosted through its original post'
                    USING ERRCODE = '42501';
            END IF;
            IF NOT v_is_quote AND EXISTS (
                    SELECT 1 FROM public.posts b
                     WHERE b.author_id = NEW.author_id
                       AND b.metadata ->> 'reblog_of' = v_orig.id::text
                       AND b.is_deleted IS NOT TRUE
                       AND NOT COALESCE(b.metadata -> 'is_quote' IN ('true'::jsonb, '"true"'::jsonb), false)) THEN
                RAISE EXCEPTION 'Post already reblogged' USING ERRCODE = '23505';
            END IF;

            SELECT jsonb_build_object(
                       'id', pr.id, 'username', pr.username, 'display_name', pr.display_name,
                       'avatar_url', pr.avatar_url,
                       'domain', COALESCE(pr.domain, current_setting('app.domain', true)),
                       'handle', CASE WHEN COALESCE(pr.is_local, true) THEN '@' || pr.username
                                      ELSE '@' || pr.username || '@' || pr.domain END,
                       'is_local', COALESCE(pr.is_local, true))
              INTO v_author
              FROM public.profiles pr WHERE pr.id = v_orig.author_id;

            NEW.reblog := jsonb_build_object(
                'id', v_orig.id,
                'content', v_orig.content,
                'created_at', v_orig.created_at,
                'author', v_author,
                'visibility', v_orig.visibility,
                'favorites_count', COALESCE(v_orig.favorites_count, 0),
                'reblogs_count', COALESCE(v_orig.reblogs_count, 0),
                'replies_count', COALESCE(v_orig.replies_count, 0),
                'media_attachments', COALESCE(v_orig.media_attachments, '[]'::jsonb),
                'content_warning', v_orig.content_warning,
                'is_sensitive', COALESCE(v_orig.is_sensitive, false),
                'url', v_orig.url,
                'in_reply_to', v_orig.in_reply_to);
            NEW.reblog_author := v_author;
            NEW.ap_type := 'Announce';
            NEW.in_reply_to := NULL;
            NEW.conversation_id := v_orig.conversation_id;
            NEW.conversation_root_id := COALESCE(v_orig.conversation_root_id, v_orig.id);
            NEW.metadata := (v_meta - v_boost_keys)
                || jsonb_build_object('reblog_of', v_orig.id, 'original_author', v_orig.author_id)
                || CASE WHEN v_is_quote THEN '{"is_quote": true}'::jsonb ELSE '{}'::jsonb END;
            IF NOT v_is_quote THEN
                NEW.content := v_orig.content;
                NEW.visibility := v_orig.visibility;
                NEW.content_warning := v_orig.content_warning;
                NEW.is_sensitive := COALESCE(v_orig.is_sensitive, false);
                NEW.media_attachments := '[]'::jsonb;
            END IF;
        ELSE
            IF NEW.reblog IS NOT NULL OR NEW.reblog_author IS NOT NULL
               OR NEW.ap_type = 'Announce' OR v_meta ?| v_boost_keys THEN
                RAISE EXCEPTION 'boost fields are set by the server' USING ERRCODE = '42501';
            END IF;
            NEW.ap_type := 'Note';
            IF NEW.in_reply_to IS NOT NULL THEN
                SELECT p.* INTO v_parent FROM public.posts p WHERE p.id = NEW.in_reply_to;
                IF NOT FOUND OR v_parent.is_deleted IS TRUE THEN
                    RAISE EXCEPTION 'REPLY_TARGET_NOT_FOUND: post not found' USING ERRCODE = 'P0002';
                END IF;
                NEW.conversation_id := v_parent.conversation_id;
                NEW.conversation_root_id := COALESCE(v_parent.conversation_root_id, v_parent.id);
            ELSE
                NEW.conversation_id := NULL;
                NEW.conversation_root_id := NULL;
            END IF;
        END IF;

        NEW.created_at := now();
        NEW.replies_count := 0;
        NEW.reblogs_count := 0;
        NEW.favorites_count := 0;
        NEW.remote_replies_count := NULL;
        NEW.remote_favorites_count := NULL;
        NEW.remote_reblogs_count := NULL;
        NEW.remote_counts_fetched_at := NULL;
        NEW.replies_fetched_at := NULL;
        NEW.federated_to := NULL;
        NEW.last_federated_at := NULL;
        NEW.edit_history := '[]'::jsonb;
        NEW.is_deleted := false;
        NEW.deleted_at := NULL;
        RETURN NEW;
    END IF;

    IF OLD.is_deleted IS TRUE AND NEW.is_deleted IS NOT TRUE THEN
        RAISE EXCEPTION 'a deleted post cannot be restored' USING ERRCODE = '42501';
    END IF;

    v_old := to_jsonb(OLD);
    SELECT jsonb_object_agg(k, v_old -> k) INTO v_keep
      FROM unnest(v_fixed || CASE
                    WHEN OLD.metadata ? 'reblog_of'
                         AND NOT COALESCE(OLD.metadata -> 'is_quote' IN ('true'::jsonb, '"true"'::jsonb), false)
                    THEN v_boost_copied ELSE ARRAY[]::text[] END) k
     WHERE v_old ? k;
    IF v_keep IS NOT NULL THEN
        NEW := jsonb_populate_record(NEW, v_keep);
    END IF;

    v_meta := CASE WHEN jsonb_typeof(NEW.metadata) = 'object' THEN NEW.metadata ELSE '{}'::jsonb END;
    FOREACH v_key IN ARRAY v_boost_keys LOOP
        IF v_meta -> v_key IS DISTINCT FROM OLD.metadata -> v_key THEN
            v_meta := CASE WHEN OLD.metadata ? v_key
                           THEN v_meta || jsonb_build_object(v_key, OLD.metadata -> v_key)
                           ELSE v_meta - v_key END;
        END IF;
    END LOOP;
    IF v_meta IS DISTINCT FROM NEW.metadata THEN
        NEW.metadata := v_meta;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_post_client_write() FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
