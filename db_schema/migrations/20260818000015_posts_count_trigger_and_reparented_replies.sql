-- profiles.posts_count has no writer, and a re-parented reply leaves its old parent counted.
--
-- 1. Every local user's post count renders as 0.
--
-- profiles.posts_count carries DEFAULT 0 and nothing in db_schema/ ever writes it: no
-- trigger, no RPC, no cron job. The only writer in the tree is
-- federation-backend/src/activitypub/ActorService.ts, which sets it from the remote actor's
-- outbox totalItems inside a record that also hardcodes is_local: false - so remote profiles
-- show the origin instance's real figure and local profiles keep the default forever. The
-- column is read on the sidebar, the profile posts tab and three cards.
--
-- The trigger added here recomputes it from the rows for LOCAL authors only. What counts is
-- every non-deleted row in posts by that author, replies and boosts included: the same
-- population OutboxHandler reports as the outbox totalItems, which is the number remote
-- instances read back as our users' posts_count, and the same list the profile posts tab
-- renders. Remote authors keep the origin figure - this instance holds only the fraction of
-- their posts that federated here.
--
-- 2. Moving a reply between parents over-counts the one it left.
--
-- update_post_reply_count's UPDATE branch handled NULL -> parent and is_deleted flips. A
-- move from one parent to another matched neither arm, so neither parent was adjusted: the
-- old one kept a reply it no longer has and the new one never counted it. No caller does
-- this today - the defect is latent, and no instance can have drifted from it, which is why
-- only posts_count is backfilled below.
--
-- BACKFILL. posts_count is set for every local profile, including the zeros: a profile with
-- no posts and a profile whose count was never written are indistinguishable, and both are
-- correct at 0.
--
-- The backfill is deliberately outside the DDL transaction. Held inside it, the CREATE
-- TRIGGER above would keep ACCESS EXCLUSIVE on posts for the whole scan.
--
-- Both functions are SECURITY DEFINER with pg_temp named last, and this migration is
-- numbered after 20260818000013, which pins search_path across the schema: CREATE OR REPLACE
-- resets function attributes, so the pin is restated rather than inherited.

BEGIN;

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
      UPDATE public.posts
      SET replies_count = GREATEST(COALESCE(replies_count, 0) + parent.delta, 0)
      WHERE id = parent.id;
    END IF;
  END LOOP;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

-- SECURITY DEFINER: the row written is the author's profile and profiles_update_own admits
-- only its owner, so under invoker rights the counter would track who wrote the post rather
-- than the rows.
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
    -- concurrent post by the same author commits.
    PERFORM 1 FROM public.profiles
     WHERE id = author AND is_local IS TRUE FOR UPDATE;

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

DROP TRIGGER IF EXISTS trg_update_profile_posts_count ON public.posts;
CREATE TRIGGER trg_update_profile_posts_count
    AFTER INSERT OR UPDATE OF is_deleted OR DELETE ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.update_profile_posts_count();

COMMIT;

-- Backfill, outside the DDL transaction above. -------------------------------------------

BEGIN;

UPDATE public.profiles pr
   SET posts_count = c.n
  FROM (SELECT p.author_id AS id, count(*) AS n
          FROM public.posts p
         WHERE p.is_deleted IS DISTINCT FROM true
         GROUP BY 1) c
 WHERE pr.id = c.id
   AND pr.is_local IS TRUE
   AND pr.posts_count IS DISTINCT FROM c.n;

UPDATE public.profiles pr
   SET posts_count = 0
 WHERE pr.is_local IS TRUE
   AND COALESCE(pr.posts_count, -1) <> 0
   AND NOT EXISTS (SELECT 1 FROM public.posts p
                    WHERE p.author_id = pr.id
                      AND p.is_deleted IS DISTINCT FROM true);

COMMIT;

NOTIFY pgrst, 'reload schema';
