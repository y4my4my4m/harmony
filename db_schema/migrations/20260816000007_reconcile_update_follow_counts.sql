-- Only status = 'accepted' counts toward followers/following. follows.status is nullable
-- and its CHECK admits NULL, because a CHECK rejects only FALSE.
--
-- Both prior bodies let NULL reach the branch test and corrupt in opposite directions:
-- init/ takes the ELSE arm, so an INSERT carrying NULL decrements both profiles;
-- 20260528's second arm is NULL when v_is is NULL, so an UPDATE from 'accepted' to NULL
-- leaves both counts raised. COALESCE(..., false) keeps both flags two-valued. Behaviour
-- for non-NULL status is unchanged.
--
-- No backfill: every application write passes a literal status, so the defect is latent
-- and production counts have not drifted through it.

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
