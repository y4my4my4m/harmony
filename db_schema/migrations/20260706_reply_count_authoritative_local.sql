-- =============================================================================
-- Make posts.replies_count self-healing for LOCAL parents
-- =============================================================================
-- The prior trigger (20260705_reply_count_trigger.sql) maintained the count
-- with +1/-1 deltas. Deltas are correct arithmetically but fragile: any drift
-- - stale pre-trigger values, the fail-open inbound-idempotency window, or a
-- concurrent double-delivery of the same reply - sticks permanently and shows
-- up as a reply badge that "counts itself" (e.g. 2 for a single reply).
--
-- For a LOCAL parent every reply lives in our DB, so the child row count is
-- authoritative. Recompute it on each relevant change: the count can no longer
-- drift and any pre-existing drift heals on the next reply/delete touching it.
--
-- REMOTE parents keep origin-supplied counts + delta for locally-known replies
-- only (Mastodon semantics) - we don't have their full reply set locally.

BEGIN;

CREATE OR REPLACE FUNCTION public.update_post_reply_count()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected uuid := NULL;
  delta integer := 0;
  parent_is_local boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.in_reply_to IS NOT NULL AND (NEW.is_deleted IS DISTINCT FROM true) THEN
      affected := NEW.in_reply_to;
      delta := 1;
    END IF;

  ELSIF TG_OP = 'UPDATE' THEN
    -- Parent resolved after insert (pending federation lookup)
    IF OLD.in_reply_to IS NULL AND NEW.in_reply_to IS NOT NULL
       AND (NEW.is_deleted IS DISTINCT FROM true) THEN
      affected := NEW.in_reply_to;
      delta := 1;
    -- Soft-delete / undelete of a reply
    ELSIF NEW.in_reply_to IS NOT NULL AND OLD.is_deleted IS DISTINCT FROM NEW.is_deleted THEN
      affected := NEW.in_reply_to;
      delta := CASE WHEN NEW.is_deleted IS TRUE THEN -1 ELSE 1 END;
    END IF;

  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.in_reply_to IS NOT NULL AND (OLD.is_deleted IS DISTINCT FROM true) THEN
      affected := OLD.in_reply_to;
      delta := -1;
    END IF;
  END IF;

  IF affected IS NOT NULL THEN
    -- Lock the parent first so the recompute below takes its snapshot AFTER any
    -- concurrent sibling reply commits (READ COMMITTED would otherwise let the
    -- count subquery miss a just-inserted row and undercount). One row locked
    -- per trigger invocation -> no deadlock.
    SELECT is_local INTO parent_is_local
    FROM public.posts WHERE id = affected FOR UPDATE;

    IF parent_is_local IS TRUE THEN
      -- Authoritative recompute - drift-proof.
      UPDATE public.posts p
      SET replies_count = (
        SELECT count(*) FROM public.posts c
        WHERE c.in_reply_to = affected AND c.is_deleted IS DISTINCT FROM true
      )
      WHERE p.id = affected;
    ELSE
      -- Remote parent: apply delta on top of origin-supplied baseline.
      UPDATE public.posts
      SET replies_count = GREATEST(COALESCE(replies_count, 0) + delta, 0)
      WHERE id = affected;
    END IF;
  END IF;

  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_update_post_reply_count ON public.posts;
CREATE TRIGGER trg_update_post_reply_count
  AFTER INSERT OR UPDATE OF in_reply_to, is_deleted OR DELETE ON public.posts
  FOR EACH ROW EXECUTE FUNCTION public.update_post_reply_count();

-- Full reconcile of LOCAL posts to their actual live reply count. Unlike the
-- earlier backfill this also resets local posts whose stored count is inflated
-- but have no matching reply rows (LEFT JOIN -> COALESCE 0).
UPDATE public.posts p
SET replies_count = COALESCE(sub.c, 0)
FROM public.posts lp
LEFT JOIN (
  SELECT in_reply_to, count(*)::integer AS c
  FROM public.posts
  WHERE in_reply_to IS NOT NULL
    AND (is_deleted IS DISTINCT FROM true)
  GROUP BY in_reply_to
) sub ON sub.in_reply_to = lp.id
WHERE p.id = lp.id
  AND lp.is_local = true
  AND COALESCE(p.replies_count, 0) IS DISTINCT FROM COALESCE(sub.c, 0);

COMMIT;
