-- Makes reblogs_count authoritative and corrects the counts already recorded.
--
-- A reblog is a row in public.posts carrying metadata.reblog_of.
-- src/services/activityPubService.ts creates one that way and writes no
-- post_interactions row; federation-backend's ActivityProcessor writes both for
-- an incoming Announce.
--
-- Two mechanisms existed:
--   update_post_reaction_counts  +1/-1 on a post_interactions row of type
--                                'reblog'
--   update_post_reblog_count     recount of posts carrying metadata.reblog_of,
--                                present only in production
--
-- A fresh init/ build had only the first, so it counted federated reblogs and
-- missed every local one. Production has both, so it counts a federated reblog
-- twice. Measured on a fresh build: one local plus one federated reblog gives 1
-- with only the first mechanism and 3 with both, against a true count of 2.
--
-- Keeping the recount and dropping the reblog arm of the interaction trigger
-- gives 2 in that scenario, 1 for a lone local reblog, and 1 again after one is
-- soft-deleted.
--
-- The recount is authoritative rather than incremental, so the backfill at the
-- end repairs whatever the double counting left behind, and re-running this
-- migration cannot drift.

BEGIN;

CREATE OR REPLACE FUNCTION public.update_post_reblog_count() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
DECLARE
  original_post_id uuid;
BEGIN
  -- Get the original post ID from the reblog
  IF TG_OP = 'DELETE' THEN
    original_post_id := (OLD.metadata->>'reblog_of')::uuid;
  ELSE
    original_post_id := (NEW.metadata->>'reblog_of')::uuid;
  END IF;
  
  -- If no original post, nothing to update
  IF original_post_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  
  -- Update the original post's reblog count (excluding deleted reblogs)
  UPDATE public.posts 
  SET reblogs_count = (
    SELECT COUNT(*) FROM public.posts 
    WHERE metadata->>'reblog_of' = original_post_id::text
    AND (is_deleted = false OR is_deleted IS NULL)
  )
  WHERE id = original_post_id;
  
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.update_post_reaction_counts()
RETURNS trigger
LANGUAGE plpgsql
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

DROP TRIGGER IF EXISTS update_reblog_count_on_post_delete ON public.posts;
CREATE TRIGGER update_reblog_count_on_post_delete AFTER DELETE ON public.posts FOR EACH ROW WHEN (((old.metadata ->> 'reblog_of'::text) IS NOT NULL)) EXECUTE FUNCTION public.update_post_reblog_count();
DROP TRIGGER IF EXISTS update_reblog_count_on_post_insert ON public.posts;
CREATE TRIGGER update_reblog_count_on_post_insert AFTER INSERT ON public.posts FOR EACH ROW WHEN (((new.metadata ->> 'reblog_of'::text) IS NOT NULL)) EXECUTE FUNCTION public.update_post_reblog_count();
DROP TRIGGER IF EXISTS update_reblog_count_on_post_update ON public.posts;
CREATE TRIGGER update_reblog_count_on_post_update AFTER UPDATE OF is_deleted ON public.posts FOR EACH ROW WHEN ((((new.metadata ->> 'reblog_of'::text) IS NOT NULL) OR ((old.metadata ->> 'reblog_of'::text) IS NOT NULL))) EXECUTE FUNCTION public.update_post_reblog_count();

-- Repair counts recorded under the old arrangement. Restricted to posts that
-- are actually the target of a reblog, so this is not a full-table rewrite.
UPDATE public.posts p
   SET reblogs_count = c.n
  FROM (
    SELECT (r.metadata ->> 'reblog_of')::uuid AS post_id, count(*) AS n
      FROM public.posts r
     WHERE r.metadata ->> 'reblog_of' IS NOT NULL
       AND (r.is_deleted = false OR r.is_deleted IS NULL)
     GROUP BY 1
  ) c
 WHERE p.id = c.post_id
   AND p.reblogs_count IS DISTINCT FROM c.n;

-- Posts whose every reblog is gone still hold a stale positive count.
UPDATE public.posts p
   SET reblogs_count = 0
 WHERE p.reblogs_count <> 0
   AND NOT EXISTS (
     SELECT 1 FROM public.posts r
      WHERE r.metadata ->> 'reblog_of' = p.id::text
        AND (r.is_deleted = false OR r.is_deleted IS NULL)
   );

-- CREATE OR REPLACE resets a function's attributes to what the statement says.
-- update_post_reaction_counts carries no SET search_path in init/; it is pinned
-- afterwards by the loop in 99_performance_hardening.sql, and on a migrated
-- database by 20260616_performance_advisor_fixes.sql. Restated here so
-- replacing the body does not silently drop the pin.
ALTER FUNCTION public.update_post_reaction_counts() SET search_path = public, extensions, pg_temp;

COMMIT;
