-- posts_federation_status_check holds for every row and is validated.
--
-- 20261009200001 added the constraint NOT VALID: production carried 38 posts with the
-- pre-baseline statuses 'federated', 'federating' and 'received' (newest 2026-03-23). A NOT
-- VALID check still applies to every row an UPDATE writes, so any update of those posts
-- failed with 23514: a favourite or reply (update_post_reaction_counts,
-- update_post_reply_count), a soft delete, a moderation action, a federated edit.
--
--   status outside the constraint, is_local      -> 'completed'
--   status outside the constraint, not is_local  -> 'skipped'
--
-- Neither value is picked up by the federation sweep ('pending' only). A federation_status-only
-- UPDATE leaves updated_at alone (handle_posts_updated_at) and queues no job
-- (trigger_queue_post_federation returns early).
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

UPDATE public.posts
   SET federation_status = CASE WHEN is_local IS TRUE THEN 'completed' ELSE 'skipped' END
 WHERE federation_status IS NOT NULL
   AND federation_status <> ALL (ARRAY['pending', 'queued', 'processing', 'completed', 'failed', 'skipped']);

ALTER TABLE public.posts VALIDATE CONSTRAINT posts_federation_status_check;

COMMIT;
