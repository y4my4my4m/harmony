-- =============================================================================
-- Enforce UNIQUE posts.ap_id + de-duplicate existing rows
-- =============================================================================
-- posts.ap_id had only a plain index (03_tables_social.sql), unlike
-- threads.ap_id and ap_activities.ap_id which are UNIQUE. The federated-post
-- insert path (ActivityProcessor) is a check-then-insert: SELECT by ap_id, then
-- INSERT if absent. With inbound activity idempotency now failing OPEN (commit
-- 4cc7eb3), two concurrent deliveries of the same activity can both pass the
-- existence check and insert duplicate rows -> inflated reply/reblog counts and
-- duplicated timeline entries. The unique index makes the insert race-proof.
--
-- Duplicates must be collapsed before the index can be built. Keeper = earliest
-- row per ap_id; references are re-pointed to it, then dupes are deleted (their
-- derived cache rows cascade away and rebuild identically), then counts on the
-- affected LOCAL posts are reconciled from source rows.

BEGIN;

-- 1. Canonical keeper (earliest) per ap_id; list only the rows to be removed.
--    Keep each dupe's own parent so we can reconcile exactly the posts a merge
--    can affect (the keepers, and the parents of deleted dupes) instead of
--    rewriting every local post. When there are no dupes this table is empty
--    and steps 2-4 are all no-ops - only the index in step 5 is built.
CREATE TEMP TABLE _post_ap_id_dupes ON COMMIT DROP AS
WITH ranked AS (
  SELECT
    id,
    in_reply_to,
    first_value(id) OVER (
      PARTITION BY ap_id
      ORDER BY created_at ASC, id ASC
    ) AS keeper
  FROM public.posts
  WHERE ap_id IS NOT NULL
)
SELECT id AS dup, keeper, in_reply_to AS dup_in_reply_to
FROM ranked
WHERE id <> keeper;

-- 2. Re-point references from duplicates to the keeper BEFORE deleting, so
--    threading and user data survive (in_reply_to is ON DELETE SET NULL, which
--    would otherwise orphan child replies).
UPDATE public.posts p
SET in_reply_to = d.keeper
FROM _post_ap_id_dupes d
WHERE p.in_reply_to = d.dup;

UPDATE public.posts p
SET conversation_root_id = d.keeper
FROM _post_ap_id_dupes d
WHERE p.conversation_root_id = d.dup;

UPDATE public.reports r
SET reported_post_id = d.keeper
FROM _post_ap_id_dupes d
WHERE r.reported_post_id = d.dup;

-- post_interactions is real user data (favourites / reblogs / reactions).
-- Emoji reactions have no unique key -> re-point unconditionally.
UPDATE public.post_interactions pi
SET post_id = d.keeper
FROM _post_ap_id_dupes d
WHERE pi.post_id = d.dup
  AND pi.interaction_type = 'emoji_reaction';

-- Non-emoji interactions are unique on (user_id, post_id, interaction_type):
-- re-point only when the keeper has no equivalent row yet.
UPDATE public.post_interactions pi
SET post_id = d.keeper
FROM _post_ap_id_dupes d
WHERE pi.post_id = d.dup
  AND pi.interaction_type <> 'emoji_reaction'
  AND NOT EXISTS (
    SELECT 1 FROM public.post_interactions k
    WHERE k.post_id = d.keeper
      AND k.user_id = pi.user_id
      AND k.interaction_type = pi.interaction_type
  );

-- Whatever still points at a dupe is a collision already present on the keeper.
DELETE FROM public.post_interactions pi
USING _post_ap_id_dupes d
WHERE pi.post_id = d.dup;

-- 3. Remove the duplicate posts. CASCADE clears their derived cache rows
--    (post_hashtags, timeline_entries, trending_posts) - all rebuildable and
--    identical to the keeper's, since it is the same note.
DELETE FROM public.posts p
USING _post_ap_id_dupes d
WHERE p.id = d.dup;

-- 4. Reconcile counts only on the LOCAL posts a merge can have skewed: the
--    keepers (which absorbed re-pointed replies/interactions) and the parents
--    of the deleted dupes. Their rows are the source of truth; remote posts
--    keep origin-supplied counts. The IS DISTINCT FROM guard means only rows
--    that actually drifted are written (no needless realtime churn / WAL).
UPDATE public.posts p
SET
  replies_count = COALESCE((
    SELECT count(*) FROM public.posts c
    WHERE c.in_reply_to = p.id AND c.is_deleted IS DISTINCT FROM true
  ), 0),
  favorites_count = COALESCE((
    SELECT count(*) FROM public.post_interactions pi
    WHERE pi.post_id = p.id
      AND pi.interaction_type IN ('favorite', 'emoji_reaction')
  ), 0),
  reblogs_count = COALESCE((
    SELECT count(*) FROM public.post_interactions pi
    WHERE pi.post_id = p.id AND pi.interaction_type = 'reblog'
  ), 0)
WHERE p.is_local = true
  AND p.id IN (
    SELECT keeper FROM _post_ap_id_dupes
    UNION
    SELECT dup_in_reply_to FROM _post_ap_id_dupes WHERE dup_in_reply_to IS NOT NULL
  )
  AND (
    p.replies_count IS DISTINCT FROM COALESCE((
      SELECT count(*) FROM public.posts c
      WHERE c.in_reply_to = p.id AND c.is_deleted IS DISTINCT FROM true
    ), 0)
    OR p.favorites_count IS DISTINCT FROM COALESCE((
      SELECT count(*) FROM public.post_interactions pi
      WHERE pi.post_id = p.id
        AND pi.interaction_type IN ('favorite', 'emoji_reaction')
    ), 0)
    OR p.reblogs_count IS DISTINCT FROM COALESCE((
      SELECT count(*) FROM public.post_interactions pi
      WHERE pi.post_id = p.id AND pi.interaction_type = 'reblog'
    ), 0)
  );

-- 5. Replace the plain index with a UNIQUE one. Same name is reused, so init
--    and migrated schemas converge; IF NOT EXISTS on a UNIQUE create would keep
--    the old non-unique index, so drop explicitly first.
DROP INDEX IF EXISTS public.idx_posts_ap_id;
CREATE UNIQUE INDEX idx_posts_ap_id
  ON public.posts(ap_id) WHERE ap_id IS NOT NULL;

COMMIT;
