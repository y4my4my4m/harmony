-- =============================================================================
-- Migration: maintain `profiles.followers_count` and `profiles.following_count`
-- via a trigger, and backfill historical drift.
--
-- The columns existed (with a comment "maintained by triggers") but no
-- trigger ever incremented or decremented them, so the displayed
-- counts have been stuck at zero. This adds the missing trigger and
-- backfills both columns from the authoritative `follows` table.
--
-- Counting rule (mirrors what Mastodon / Pleroma / GoToSocial do): only
-- follows with status = 'accepted' count toward followers/following.
-- 'pending' (awaiting approval) and 'rejected' do not.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.update_follow_counts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_was_accepted boolean := false;
  v_is_accepted  boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_was_accepted := false;
    v_is_accepted  := (NEW.status = 'accepted');
  ELSIF TG_OP = 'UPDATE' THEN
    v_was_accepted := (OLD.status = 'accepted');
    v_is_accepted  := (NEW.status = 'accepted');
    -- If a row's actor pair changed we'd need to rebalance both sides,
    -- but the (follower_id, following_id) is the natural key on
    -- public.follows so it never moves on UPDATE; only status does.
  ELSE -- DELETE
    v_was_accepted := (OLD.status = 'accepted');
    v_is_accepted  := false;
  END IF;

  IF v_was_accepted = v_is_accepted THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_is_accepted AND NOT v_was_accepted THEN
    UPDATE public.profiles
       SET following_count = COALESCE(following_count, 0) + 1
     WHERE id = NEW.follower_id;
    UPDATE public.profiles
       SET followers_count = COALESCE(followers_count, 0) + 1
     WHERE id = NEW.following_id;
  ELSIF v_was_accepted AND NOT v_is_accepted THEN
    -- (follower_id, following_id) is the natural key on public.follows
    -- and never changes on UPDATE, so NEW.* and OLD.* are identical when
    -- both records exist; the COALESCE just papers over the DELETE case
    -- where NEW is NULL.
    UPDATE public.profiles
       SET following_count = GREATEST(COALESCE(following_count, 0) - 1, 0)
     WHERE id = COALESCE(NEW.follower_id, OLD.follower_id);
    UPDATE public.profiles
       SET followers_count = GREATEST(COALESCE(followers_count, 0) - 1, 0)
     WHERE id = COALESCE(NEW.following_id, OLD.following_id);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_update_follow_counts ON public.follows;
CREATE TRIGGER trg_update_follow_counts
  AFTER INSERT OR UPDATE OF status OR DELETE ON public.follows
  FOR EACH ROW
  EXECUTE FUNCTION public.update_follow_counts();

-- Backfill: recompute from the source of truth in one pass.
UPDATE public.profiles p
   SET followers_count = COALESCE(c.cnt, 0)
  FROM (
    SELECT following_id AS profile_id, COUNT(*) AS cnt
      FROM public.follows
     WHERE status = 'accepted'
     GROUP BY following_id
  ) c
 WHERE c.profile_id = p.id
   AND p.followers_count IS DISTINCT FROM c.cnt;

UPDATE public.profiles p
   SET followers_count = 0
 WHERE p.followers_count IS DISTINCT FROM 0
   AND NOT EXISTS (
     SELECT 1 FROM public.follows f
      WHERE f.following_id = p.id AND f.status = 'accepted'
   );

UPDATE public.profiles p
   SET following_count = COALESCE(c.cnt, 0)
  FROM (
    SELECT follower_id AS profile_id, COUNT(*) AS cnt
      FROM public.follows
     WHERE status = 'accepted'
     GROUP BY follower_id
  ) c
 WHERE c.profile_id = p.id
   AND p.following_count IS DISTINCT FROM c.cnt;

UPDATE public.profiles p
   SET following_count = 0
 WHERE p.following_count IS DISTINCT FROM 0
   AND NOT EXISTS (
     SELECT 1 FROM public.follows f
      WHERE f.follower_id = p.id AND f.status = 'accepted'
   );

COMMIT;

NOTIFY pgrst, 'reload schema';
