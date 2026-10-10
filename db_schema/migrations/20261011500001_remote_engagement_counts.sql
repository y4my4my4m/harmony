-- Remote accounts and remote posts carry their origin server's figures beside the local
-- counters.
--
-- profiles.remote_posts_count, remote_followers_count and remote_following_count hold the
-- totalItems of a remote actor's outbox, followers and following collections as the
-- federation backend last read them; remote_counts_fetched_at is when. A NULL count beside a
-- set remote_counts_fetched_at is a total the actor's server withholds: the collection
-- answered 401 or 403, or carries no totalItems. followers_count, following_count and
-- posts_count stay what update_follow_counts and update_profile_posts_count maintain here.
-- Mastodon ActivityPub::ProcessAccountService#set_fetchable_attributes! reads the same three
-- collections.
--
-- posts.remote_replies_count, remote_favorites_count and remote_reblogs_count hold the
-- totalItems of a remote Note's replies, likes and shares collections, read together at
-- remote_counts_fetched_at. With a figure, the displayed counter of a remote post is
--
--     GREATEST(figure + local rows created after remote_counts_fetched_at, rows held here)
--
-- where rows are boosts (posts.metadata.reblog_of), favourites (post_interactions) or replies
-- (posts.in_reply_to), and local means the boost, favourite or reply was made on this
-- instance. Engagement made here after the read is absent from the figure; everything else
-- held here is in it or was never delivered to the origin. Mastodon keeps the figures as
-- status_stats.untrusted_*_count and serves them before its own counts
-- (REST::StatusSerializer#reblogs_count); the local term here keeps a boost or favourite
-- visible between the click and the next read. Without a figure the counters move as
-- before: a reply or favourite by one on the stored value, a boost by recounting the boosts.
--
-- update_post_reblog_count recounted every original from its boost rows, which replaced a
-- remote post's origin figure with the number of boosts that federated here: a post boosted
-- 82 times read 1 once a followee's Announce of it arrived.
--
-- trg_posts_remote_engagement recomputes the displayed counters when a figure is written.
-- guard_profile_client_write and guard_post_client_write keep the new columns fixed on
-- client updates and empty on client inserts.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS remote_posts_count integer,
    ADD COLUMN IF NOT EXISTS remote_followers_count integer,
    ADD COLUMN IF NOT EXISTS remote_following_count integer,
    ADD COLUMN IF NOT EXISTS remote_counts_fetched_at timestamp with time zone;

COMMENT ON COLUMN public.profiles.remote_posts_count IS
    'Remote account: totalItems of its outbox when last read; NULL when withheld or unread.';
COMMENT ON COLUMN public.profiles.remote_followers_count IS
    'Remote account: totalItems of its followers collection when last read; NULL when withheld or unread.';
COMMENT ON COLUMN public.profiles.remote_following_count IS
    'Remote account: totalItems of its following collection when last read; NULL when withheld or unread.';
COMMENT ON COLUMN public.profiles.remote_counts_fetched_at IS
    'When the remote_*_count columns were last read from the origin.';

ALTER TABLE public.posts
    ADD COLUMN IF NOT EXISTS remote_replies_count integer,
    ADD COLUMN IF NOT EXISTS remote_favorites_count integer,
    ADD COLUMN IF NOT EXISTS remote_reblogs_count integer,
    ADD COLUMN IF NOT EXISTS remote_counts_fetched_at timestamp with time zone;

COMMENT ON COLUMN public.posts.remote_replies_count IS
    'Remote post: totalItems of its replies collection when last read; NULL when the origin gives none.';
COMMENT ON COLUMN public.posts.remote_favorites_count IS
    'Remote post: totalItems of its likes collection when last read; NULL when the origin gives none.';
COMMENT ON COLUMN public.posts.remote_reblogs_count IS
    'Remote post: totalItems of its shares collection when last read; NULL when the origin gives none.';
COMMENT ON COLUMN public.posts.remote_counts_fetched_at IS
    'When the remote_*_count columns were last read from the origin.';

-- ---------------------------------------------------------------------------
-- Displayed counters of a remote post
-- ---------------------------------------------------------------------------

-- p_kind: 'replies', 'favorites' or 'reblogs'. The figure term is capped at the integer
-- column's range.
CREATE OR REPLACE FUNCTION public.remote_engagement_figure(
    p_post_id uuid,
    p_kind text,
    p_figure integer,
    p_fetched_at timestamp with time zone)
RETURNS integer
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_rows bigint;
    v_since bigint;
BEGIN
    IF p_kind = 'reblogs' THEN
        SELECT count(*),
               count(*) FILTER (WHERE b.is_local IS TRUE
                                  AND (p_fetched_at IS NULL OR b.created_at > p_fetched_at))
          INTO v_rows, v_since
          FROM public.posts b
         WHERE b.metadata ->> 'reblog_of' = p_post_id::text
           AND b.is_deleted IS DISTINCT FROM true;
    ELSIF p_kind = 'favorites' THEN
        SELECT count(*),
               count(*) FILTER (WHERE f.is_local IS TRUE
                                  AND (p_fetched_at IS NULL OR f.created_at > p_fetched_at))
          INTO v_rows, v_since
          FROM public.post_interactions f
         WHERE f.post_id = p_post_id
           AND f.interaction_type = 'favorite';
    ELSIF p_kind = 'replies' THEN
        SELECT count(*),
               count(*) FILTER (WHERE c.is_local IS TRUE
                                  AND (p_fetched_at IS NULL OR c.created_at > p_fetched_at))
          INTO v_rows, v_since
          FROM public.posts c
         WHERE c.in_reply_to = p_post_id
           AND c.is_deleted IS DISTINCT FROM true;
    ELSE
        RAISE EXCEPTION 'unknown engagement kind %', p_kind USING ERRCODE = '22023';
    END IF;

    IF p_figure IS NULL THEN
        RETURN v_rows::integer;
    END IF;
    RETURN LEAST(GREATEST(GREATEST(p_figure, 0)::bigint + v_since, v_rows), 2147483647)::integer;
END;
$$;

CREATE OR REPLACE FUNCTION public.apply_remote_engagement_counts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.remote_replies_count IS NOT NULL THEN
        NEW.replies_count := public.remote_engagement_figure(
            NEW.id, 'replies', NEW.remote_replies_count, NEW.remote_counts_fetched_at);
    END IF;
    IF NEW.remote_favorites_count IS NOT NULL THEN
        NEW.favorites_count := public.remote_engagement_figure(
            NEW.id, 'favorites', NEW.remote_favorites_count, NEW.remote_counts_fetched_at);
    END IF;
    IF NEW.remote_reblogs_count IS NOT NULL THEN
        NEW.reblogs_count := public.remote_engagement_figure(
            NEW.id, 'reblogs', NEW.remote_reblogs_count, NEW.remote_counts_fetched_at);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_posts_remote_engagement ON public.posts;
CREATE TRIGGER trg_posts_remote_engagement
    BEFORE INSERT OR UPDATE OF remote_replies_count, remote_favorites_count,
                               remote_reblogs_count, remote_counts_fetched_at
    ON public.posts
    FOR EACH ROW
    WHEN (NEW.is_local IS NOT TRUE)
    EXECUTE FUNCTION public.apply_remote_engagement_counts();

-- Boosts. A local original, or a remote one without a figure, recounts its boost rows.
CREATE OR REPLACE FUNCTION public.update_post_reblog_count()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
DECLARE
  original_post_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    original_post_id := (OLD.metadata->>'reblog_of')::uuid;
  ELSE
    original_post_id := (NEW.metadata->>'reblog_of')::uuid;
  END IF;

  IF original_post_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  UPDATE public.posts p
     SET reblogs_count = CASE
           WHEN p.is_local IS NOT TRUE AND p.remote_reblogs_count IS NOT NULL
           THEN public.remote_engagement_figure(p.id, 'reblogs', p.remote_reblogs_count,
                                                p.remote_counts_fetched_at)
           ELSE (SELECT count(*) FROM public.posts b
                  WHERE b.metadata->>'reblog_of' = original_post_id::text
                    AND (b.is_deleted = false OR b.is_deleted IS NULL))
         END
   WHERE p.id = original_post_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Favourites. A local post, or a remote one without a figure, moves by one.
-- SECURITY DEFINER: the row written is a post the caller does not own, and
-- posts_update_own would filter the UPDATE to nothing.
CREATE OR REPLACE FUNCTION public.update_post_reaction_counts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.interaction_type = 'favorite' THEN
      UPDATE posts p
      SET favorites_count = CASE
            WHEN p.is_local IS NOT TRUE AND p.remote_favorites_count IS NOT NULL
            THEN public.remote_engagement_figure(p.id, 'favorites', p.remote_favorites_count,
                                                 p.remote_counts_fetched_at)
            ELSE p.favorites_count + 1
          END
      WHERE p.id = NEW.post_id;
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.interaction_type = 'favorite' THEN
      UPDATE posts p
      SET favorites_count = CASE
            WHEN p.is_local IS NOT TRUE AND p.remote_favorites_count IS NOT NULL
            THEN public.remote_engagement_figure(p.id, 'favorites', p.remote_favorites_count,
                                                 p.remote_counts_fetched_at)
            ELSE GREATEST(p.favorites_count - 1, 0)
          END
      WHERE p.id = OLD.post_id;
    END IF;
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

-- Replies. LOCAL parents recompute from their rows; REMOTE parents with a figure take the
-- figure rule, without one apply +1/-1 on the stored value.
-- A re-parent touches two parents at once, which is why the arms below carry a list rather
-- than one id.
-- SECURITY DEFINER for the same reason as update_post_reaction_counts.
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
    -- count subquery miss a just-inserted row and undercount).
    SELECT is_local INTO parent_is_local
    FROM public.posts WHERE id = parent.id FOR UPDATE;

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

-- ---------------------------------------------------------------------------
-- Client writes
-- ---------------------------------------------------------------------------

-- 20261010900001 body; the remote_* columns join v_fixed and are cleared on insert.
CREATE OR REPLACE FUNCTION public.guard_profile_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fixed CONSTANT text[] := ARRAY[
        'federated_id', 'inbox_url', 'outbox_url', 'followers_url', 'following_url',
        'featured_url', 'shared_inbox_url', 'public_key', 'domain', 'is_local',
        'followers_count', 'following_count', 'posts_count',
        'remote_posts_count', 'remote_followers_count', 'remote_following_count',
        'remote_counts_fetched_at',
        'message_count', 'voice_minutes', 'created_at', 'suspended_at', 'suspension_reason',
        'silenced_at', 'silenced_reason', 'last_synced_at', 'last_federation_sync',
        'supported_activities', 'also_known_as', 'moved_to_id', 'moved_to_uri', 'moved_at'];
    v_domain text;
    v_actor text;
    v_old jsonb;
    v_keep jsonb;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.is_local IS FALSE THEN
            RAISE EXCEPTION 'remote profiles arrive through federation' USING ERRCODE = '42501';
        END IF;
        IF NEW.public_key IS NOT NULL OR NEW.featured_url IS NOT NULL OR NEW.shared_inbox_url IS NOT NULL
           OR NEW.suspended_at IS NOT NULL OR NEW.suspension_reason IS NOT NULL
           OR NEW.silenced_at IS NOT NULL OR NEW.silenced_reason IS NOT NULL THEN
            RAISE EXCEPTION 'keys and moderation details are set by the server' USING ERRCODE = '42501';
        END IF;

        SELECT lower(btrim(replace(c.config_value #>> '{}', '"', ''))) INTO v_domain
          FROM public.instance_config c
         WHERE c.config_key = 'domain';
        IF NEW.domain IS NOT NULL AND v_domain IS NOT NULL AND v_domain <> ''
           AND lower(NEW.domain) <> v_domain THEN
            RAISE EXCEPTION 'a local profile is on this instance''s domain' USING ERRCODE = '42501';
        END IF;

        v_actor := 'https://' || NEW.domain || '/users/' || NEW.username;
        IF (NEW.federated_id IS NOT NULL OR NEW.inbox_url IS NOT NULL OR NEW.outbox_url IS NOT NULL
            OR NEW.followers_url IS NOT NULL OR NEW.following_url IS NOT NULL)
           AND (v_actor IS NULL
                OR NEW.federated_id IS DISTINCT FROM v_actor
                OR (NEW.inbox_url IS NOT NULL AND NEW.inbox_url <> v_actor || '/inbox')
                OR (NEW.outbox_url IS NOT NULL AND NEW.outbox_url <> v_actor || '/outbox')
                OR (NEW.followers_url IS NOT NULL AND NEW.followers_url <> v_actor || '/followers')
                OR (NEW.following_url IS NOT NULL AND NEW.following_url <> v_actor || '/following')) THEN
            RAISE EXCEPTION 'actor URLs derive from https://<domain>/users/<username>' USING ERRCODE = '42501';
        END IF;

        NEW.created_at := now();
        NEW.followers_count := 0;
        NEW.following_count := 0;
        NEW.posts_count := 0;
        NEW.remote_posts_count := NULL;
        NEW.remote_followers_count := NULL;
        NEW.remote_following_count := NULL;
        NEW.remote_counts_fetched_at := NULL;
        NEW.message_count := 0;
        NEW.voice_minutes := 0;
        NEW.also_known_as := '{}';
        NEW.moved_to_id := NULL;
        NEW.moved_to_uri := NULL;
        NEW.moved_at := NULL;
        RETURN NEW;
    END IF;

    v_old := to_jsonb(OLD);
    SELECT jsonb_object_agg(k, v_old -> k) INTO v_keep
      FROM unnest(v_fixed) k
     WHERE v_old ? k;
    IF v_keep IS NOT NULL THEN
        NEW := jsonb_populate_record(NEW, v_keep);
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_profile_client_write() FROM PUBLIC, anon, authenticated;

-- 20261005650001 body; the remote_* columns join v_fixed and are cleared on insert.
CREATE OR REPLACE FUNCTION public.guard_post_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_fixed CONSTANT text[] := ARRAY[
        'is_local', 'ap_id', 'ap_type', 'url', 'created_at', 'replies_count',
        'reblogs_count', 'favorites_count', 'remote_replies_count', 'remote_favorites_count',
        'remote_reblogs_count', 'remote_counts_fetched_at', 'federation_status', 'federated_to',
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

-- ---------------------------------------------------------------------------
-- Privileges and ownership
-- ---------------------------------------------------------------------------

-- Internal. As in 20261006760001_internal_definer_grants.sql: the definers calling
-- remote_engagement_figure may be owned by postgres or supabase_admin.
DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure
          FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('remote_engagement_figure', 'apply_remote_engagement_counts')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

-- As in 20261005400001_account_security.sql: a definer created by supabase_admin would
-- call postgres-owned helpers whose PUBLIC grant is revoked.
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
           AND p.proname IN ('remote_engagement_figure', 'apply_remote_engagement_counts')
           AND pg_get_userbyid(p.proowner) <> 'postgres'
    LOOP
        EXECUTE format('ALTER FUNCTION %s OWNER TO postgres', fn);
        RAISE NOTICE '% now owned by postgres', fn;
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
