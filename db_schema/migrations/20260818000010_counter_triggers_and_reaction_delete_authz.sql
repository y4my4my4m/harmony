-- Two defects that share a root: a SECURITY DEFINER attribute in the wrong place.
--
-- 1. favorites_count and replies_count move for nobody but the post's own author.
--
-- update_post_reaction_counts and update_post_reply_count are trigger functions that UPDATE
-- public.posts, and neither was declared SECURITY DEFINER. Under invoker rights the UPDATE
-- runs as `authenticated`, which holds UPDATE on posts but is filtered by the only UPDATE
-- policy on the table:
--
--   posts_update_own  USING (author_id = ( SELECT get_current_profile_id() ))
--
-- Favouriting or replying to somebody else's post therefore matches ZERO rows. An UPDATE
-- that matches nothing is not an error, so the interaction row commits, the counter does
-- not move, and neither the client nor the logs see anything wrong.
--
-- Their siblings update_post_reblog_count and update_follow_counts ARE SECURITY DEFINER,
-- which is exactly why boosts and follows count correctly. The federation backend connects
-- as service_role, which bypasses RLS, so engagement arriving from remote instances counted
-- while local engagement did not - leaving a plausible-looking number that is the sum of
-- remote activity and the author's own.
--
-- db_schema/tests/33_trigger_behaviour.sql asserts both counters and passes, because the
-- pgTAP harness runs as postgres with RLS bypassed. A counter assertion that never adopts a
-- non-owner role cannot see this. 33_trigger_behaviour.sql gains that arm alongside this
-- migration.
--
-- 2. remove_post_emoji_reaction deletes by a caller-supplied user_id with no ownership check.
--
-- It is SECURITY DEFINER, so it bypasses post_interactions_delete_own, and
-- db_schema/SURFACE.tsv records EXECUTE granted to anon. The only thing selecting rows was
-- the p_user_id argument, so any caller holding the public anon key could delete any user's
-- reactions on any post - silently, with the counter dropping and no audit trail.
-- add_post_emoji_reaction has carried the correct check all along; this is an omission in
-- one of the pair, not a design.
--
-- BACKFILL. favorites_count is maintained as +1/-1 with no recompute path anywhere - not in
-- a cron job, and timeline_posts serves the stored column verbatim - so every existing row
-- is permanently wrong by the amount of local engagement it received. Both columns are
-- recomputed here from the rows they summarise. replies_count is recomputed only for LOCAL
-- parents: a remote parent's count is the origin instance's number plus deltas this instance
-- has seen, and this instance does not hold the rows to recompute it.
--
-- Numbered ahead of 20260818000013, which names pg_temp in every search_path: CREATE OR
-- REPLACE resets function attributes, so landing after it would strip the pin.
--
-- The backfill is deliberately outside the DDL transaction. Held inside it, the
-- CREATE OR REPLACE above would keep ACCESS EXCLUSIVE on posts for the whole scan.

BEGIN;

CREATE OR REPLACE FUNCTION public.update_post_reaction_counts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.interaction_type = 'emoji_reaction' OR NEW.interaction_type = 'favorite' THEN
      UPDATE posts
      SET favorites_count = favorites_count + 1
      WHERE id = NEW.post_id;
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.interaction_type = 'emoji_reaction' OR OLD.interaction_type = 'favorite' THEN
      UPDATE posts
      SET favorites_count = GREATEST(favorites_count - 1, 0)
      WHERE id = OLD.post_id;
    END IF;
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

-- Only the attribute changes; the body is whatever init/ already carries. Restated here
-- rather than ALTERed because ALTER FUNCTION cannot set SECURITY DEFINER without the body.
COMMIT;

-- update_post_reply_count is longer and its body is unchanged, so it is switched with
-- ALTER, which does not require restating it and cannot drift from init/.
ALTER FUNCTION public.update_post_reply_count() SECURITY DEFINER;
ALTER FUNCTION public.update_post_reply_count()
    SET search_path TO 'public', 'extensions', 'pg_temp';

BEGIN;

CREATE OR REPLACE FUNCTION public.remove_post_emoji_reaction(p_user_id uuid, p_post_id uuid, p_emoji_id uuid DEFAULT NULL::uuid, p_custom_emoji_content text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
DECLARE
    v_deleted_count integer;
BEGIN
    -- SECURITY: Verify the caller owns this profile. SECURITY DEFINER bypasses
    -- post_interactions_delete_own, so without this the caller-supplied p_user_id is the
    -- only thing selecting rows and any caller can delete anyone's reactions. anon holds
    -- EXECUTE. add_post_emoji_reaction carries the identical check.
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = p_user_id AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot remove reactions as another user';
    END IF;

    DELETE FROM post_interactions
    WHERE user_id = p_user_id
      AND post_id = p_post_id
      AND interaction_type = 'emoji_reaction'
      AND (
          (p_emoji_id IS NOT NULL AND emoji_id = p_emoji_id) OR
          (p_custom_emoji_content IS NOT NULL AND custom_emoji_content = p_custom_emoji_content)
      );

    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    RETURN v_deleted_count > 0;
END;
$$;

COMMIT;

-- Backfill, outside the DDL transactions above. -----------------------------------------

BEGIN;

UPDATE public.posts p
   SET favorites_count = c.n
  FROM (SELECT post_id AS id, count(*) AS n
          FROM public.post_interactions
         WHERE interaction_type IN ('emoji_reaction', 'favorite')
         GROUP BY 1) c
 WHERE p.id = c.id AND p.favorites_count IS DISTINCT FROM c.n;

UPDATE public.posts p
   SET favorites_count = 0
 WHERE p.favorites_count <> 0
   AND NOT EXISTS (SELECT 1 FROM public.post_interactions i
                    WHERE i.post_id = p.id
                      AND i.interaction_type IN ('emoji_reaction', 'favorite'));

-- Local parents only. A remote parent's replies_count is the origin's figure plus whatever
-- this instance has seen; recomputing it from local rows would replace a larger true number
-- with the fraction that happens to have federated here.
UPDATE public.posts p
   SET replies_count = c.n
  FROM (SELECT r.in_reply_to AS id, count(*) AS n
          FROM public.posts r
         WHERE r.in_reply_to IS NOT NULL
           AND (r.is_deleted IS DISTINCT FROM true)
         GROUP BY 1) c
 WHERE p.id = c.id
   AND p.replies_count IS DISTINCT FROM c.n
   AND EXISTS (SELECT 1 FROM public.profiles a
                WHERE a.id = p.author_id AND a.is_local = true);

UPDATE public.posts p
   SET replies_count = 0
 WHERE p.replies_count <> 0
   AND EXISTS (SELECT 1 FROM public.profiles a
                WHERE a.id = p.author_id AND a.is_local = true)
   AND NOT EXISTS (SELECT 1 FROM public.posts r
                    WHERE r.in_reply_to = p.id
                      AND (r.is_deleted IS DISTINCT FROM true));

COMMIT;

NOTIFY pgrst, 'reload schema';
