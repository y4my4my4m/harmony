-- Reconciles update_follow_counts between init/ and migrations/.
--
-- Only status = 'accepted' counts toward followers/following. follows.status is
-- nullable and its CHECK admits NULL, because a CHECK rejects only FALSE, so
-- `status = 'accepted'` evaluates to NULL rather than false.
--
-- Both existing bodies let that NULL reach the branch test, and because they
-- spell the branch differently they corrupt in opposite directions:
--
--   init/           IF v_is_accepted THEN increment ELSE decrement
--                   NULL takes the ELSE arm, so an INSERT carrying a NULL
--                   status decrements both profiles.
--
--   20260528        IF v_is AND NOT v_was ... ELSIF v_was AND NOT v_is
--                   the second arm is NULL when v_is is NULL, so an UPDATE
--                   from 'accepted' to NULL leaves both counts raised.
--
-- Neither is safe; this is not a case of carrying one side over. COALESCE(...,
-- false) keeps both flags two-valued, which makes the two bodies agree and
-- fixes both cases. Behaviour for non-NULL status is unchanged, and the two
-- bodies already agreed there.
--
-- No backfill. NULL is not reachable from application code: every write to
-- follows.status passes a literal 'pending', 'accepted' or 'rejected', and the
-- single computed one (CoreInteractionService.ts, `requiresApproval ?
-- 'pending' : 'accepted'`) cannot yield null. The defect is latent, so counts
-- in production have not drifted through it and recomputing them here would
-- change data this migration has no reason to touch.
--
-- Pinned by db_schema/tests/30_reconciled_functions.sql, whose two NULL cases
-- fail against init/ and against 20260528 respectively.

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
  -- follows.status is nullable and its CHECK admits NULL, so `status =
  -- 'accepted'` yields NULL rather than false. COALESCE keeps both flags
  -- two-valued. Without it NULL reaches the branch test below: an INSERT
  -- carrying a NULL status decrements both profiles, and an UPDATE from
  -- 'accepted' to NULL leaves the counts untouched.
  IF TG_OP = 'INSERT' THEN
    v_is_accepted  := COALESCE(NEW.status = 'accepted', false);
  ELSIF TG_OP = 'UPDATE' THEN
    v_was_accepted := COALESCE(OLD.status = 'accepted', false);
    v_is_accepted  := COALESCE(NEW.status = 'accepted', false);
  ELSE -- DELETE
    v_was_accepted := COALESCE(OLD.status = 'accepted', false);
  END IF;

  IF v_was_accepted = v_is_accepted THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_is_accepted THEN
    UPDATE public.profiles
       SET following_count = COALESCE(following_count, 0) + 1
     WHERE id = NEW.follower_id;
    UPDATE public.profiles
       SET followers_count = COALESCE(followers_count, 0) + 1
     WHERE id = NEW.following_id;
  ELSE
    -- (follower_id, following_id) is the natural key on public.follows and
    -- never moves on UPDATE, so NEW and OLD agree wherever both exist; the
    -- COALESCE covers DELETE, where NEW is NULL.
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

COMMIT;
