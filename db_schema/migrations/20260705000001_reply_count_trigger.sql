-- =============================================================================
-- Maintain posts.replies_count
-- =============================================================================
-- Nothing ever updated replies_count: local replies never incremented their
-- parent, so counts only reflected whatever federation delivered for remote
-- posts and stayed 0/stale for local ones.
--
-- The trigger covers: insert of a reply, late in_reply_to resolution
-- (federation resolves the parent after insert), soft-delete flips
-- (is_deleted), and hard deletes. Backfill recomputes LOCAL posts only -
-- remote posts keep their origin-supplied counts, plus increments for local
-- replies from here on (same semantics Mastodon uses).

BEGIN;

CREATE OR REPLACE FUNCTION public.update_post_reply_count()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.in_reply_to IS NOT NULL AND (NEW.is_deleted IS DISTINCT FROM true) THEN
      UPDATE public.posts
      SET replies_count = COALESCE(replies_count, 0) + 1
      WHERE id = NEW.in_reply_to;
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'UPDATE' THEN
    -- Parent resolved after insert (pending federation lookup)
    IF OLD.in_reply_to IS NULL AND NEW.in_reply_to IS NOT NULL
       AND (NEW.is_deleted IS DISTINCT FROM true) THEN
      UPDATE public.posts
      SET replies_count = COALESCE(replies_count, 0) + 1
      WHERE id = NEW.in_reply_to;
    END IF;

    -- Soft-delete / undelete of a reply
    IF NEW.in_reply_to IS NOT NULL AND OLD.is_deleted IS DISTINCT FROM NEW.is_deleted THEN
      IF NEW.is_deleted IS TRUE THEN
        UPDATE public.posts
        SET replies_count = GREATEST(COALESCE(replies_count, 0) - 1, 0)
        WHERE id = NEW.in_reply_to;
      ELSE
        UPDATE public.posts
        SET replies_count = COALESCE(replies_count, 0) + 1
        WHERE id = NEW.in_reply_to;
      END IF;
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.in_reply_to IS NOT NULL AND (OLD.is_deleted IS DISTINCT FROM true) THEN
      UPDATE public.posts
      SET replies_count = GREATEST(COALESCE(replies_count, 0) - 1, 0)
      WHERE id = OLD.in_reply_to;
    END IF;
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_update_post_reply_count ON public.posts;
CREATE TRIGGER trg_update_post_reply_count
  AFTER INSERT OR UPDATE OF in_reply_to, is_deleted OR DELETE ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.update_post_reply_count();

-- Backfill LOCAL posts from actual reply rows
UPDATE public.posts p
SET replies_count = sub.c
FROM (
  SELECT in_reply_to, count(*)::integer AS c
  FROM public.posts
  WHERE in_reply_to IS NOT NULL
    AND (is_deleted IS DISTINCT FROM true)
  GROUP BY in_reply_to
) sub
WHERE p.id = sub.in_reply_to
  AND p.is_local = true
  AND COALESCE(p.replies_count, 0) IS DISTINCT FROM sub.c;

COMMIT;
