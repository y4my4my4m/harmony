-- ---------------------------------------------------------------------------
-- One-time backfill: heal replies that were threaded under a boost wrapper.
--
-- BACKGROUND
-- ----------
-- Before the 2026-05-21 reply-routing fix, clicking "Reply" on a reblog row
-- in the timeline addressed the boost wrapper (the local Announce post) as
-- the parent instead of the original Note. The Composer set
-- `posts.in_reply_to = wrapper_id` and submitted, so the reply ended up:
--
--   - Showing "Replying to @<the-booster>" in the UI (the timeline view's
--     `reply_context` is JOINed off `posts.in_reply_to`).
--   - Invisible in the original author's thread (the descendants query
--     walks `WHERE in_reply_to = original_id` - and the reply doesn't
--     point there).
--
-- The frontend fix (`src/utils/postReblog.ts` + the call sites that use it)
-- prevents NEW replies from doing this, but doesn't touch already-stored
-- rows. This migration heals those legacy rows.
--
-- WHAT IT DOES
-- ------------
-- For every `posts` row whose `in_reply_to` points at an `Announce` wrapper
-- that has `metadata.reblog_of` set (the wrapper's recorded original-post
-- UUID), we redirect:
--
--     UPDATE posts r
--     SET in_reply_to       = (wrapper.metadata->>'reblog_of')::uuid,
--         conversation_root_id = COALESCE(original.conversation_root_id, original.id)
--     FROM posts wrapper
--     JOIN posts original ON original.id = wrapper.metadata->>'reblog_of'::uuid
--     WHERE r.in_reply_to = wrapper.id
--       AND wrapper.ap_type = 'Announce'
--       AND wrapper.metadata->>'reblog_of' IS NOT NULL;
--
-- After the update, the old "Replying to @booster" rendering disappears
-- (the JOIN now resolves to the original author), the reply shows as a
-- descendant of the original on the original's PostDetail thread, and
-- ConversationService.findConversationRoot walks to the right root.
--
-- IDEMPOTENCY
-- -----------
-- Safe to re-run. The WHERE clause only matches replies still pointing at
-- an Announce wrapper, so a second pass is a no-op.
--
-- ROLLOUT
-- -------
-- Paste into the Supabase SQL editor and click Run. Wrapped in BEGIN/COMMIT
-- so a partial failure rolls back. The expected affected-row count is the
-- number of replies users created against boosts before 2026-05-21.
-- ---------------------------------------------------------------------------

BEGIN;

WITH redirect AS (
  SELECT
    r.id AS reply_id,
    (w.metadata->>'reblog_of')::uuid AS new_parent_id,
    -- Conversation root: prefer the original's existing root, else the
    -- original itself (matches `resolveReplyChain`'s convention in
    -- federation-backend/src/activitypub/ActivityProcessor.ts).
    COALESCE(o.conversation_root_id, o.id) AS new_root_id
  FROM public.posts r
  JOIN public.posts w
    ON r.in_reply_to = w.id
   AND w.ap_type = 'Announce'
   AND w.metadata ? 'reblog_of'
   AND w.metadata->>'reblog_of' IS NOT NULL
  -- Sanity check: the original post must actually exist locally. (Boost
  -- wrappers without a hydrated original are out of scope - we can't
  -- redirect to a row we don't have.)
  JOIN public.posts o
    ON o.id = (w.metadata->>'reblog_of')::uuid
   AND o.is_deleted = false
)
UPDATE public.posts AS reply
SET
  in_reply_to = redirect.new_parent_id,
  conversation_root_id = redirect.new_root_id
FROM redirect
WHERE reply.id = redirect.reply_id;

COMMIT;
