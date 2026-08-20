-- =============================================================================
-- Cleanup: remove unicode characters wrongly stored as instance custom emoji
-- =============================================================================
-- Root cause: the federated post-reaction path (ActivityProcessor.processLike)
-- previously called resolveInboundEmojiId() for EVERY inbound reaction, which
-- created an `emojis` row (name = <unicode char>, url = NULL, server_id = NULL)
-- for plain unicode reactions. A trigger marks server_id-less rows scope
-- 'instance', so these polluted the instance/"HARMONY EMOJI" picker as url-less
-- broken boxes (e.g. name '🩵', '😥', '❤️', '🎉', ...).
--
-- The code path is fixed so unicode reactions are stored only via
-- `custom_emoji_content` (no `emojis` row). This migration removes the existing
-- junk. A url-less + server_id-less row can only be one of these unicode
-- artifacts: a real custom emoji always carries a URL, and server emoji always
-- carry a server_id.
--
-- FK handling before deletion:
--   reactions.emoji_id        -> ON DELETE CASCADE  (must re-point first or the
--                                reaction itself is deleted)
--   post_interactions.emoji_id-> ON DELETE SET NULL (re-point so the unicode is
--                                retained for grouping)
--   emoji_usage.emoji_id      -> ON DELETE CASCADE  (analytics rows; fine to drop)
--   *.imported_as             -> ON DELETE SET NULL  (fine)
--
-- Collision handling: re-pointing a junk reaction to (emoji_id=NULL,
-- custom_emoji_content=<char>) can collide with a reaction the same user already
-- has on the same target in native form (unique index
-- reactions_message_user_emoji_unique). Such junk rows are dropped first, keeping
-- the canonical row (an existing native reaction, else the lowest-id junk row).
-- Idempotent and safe to re-run.
-- =============================================================================

BEGIN;

-- 1a. Drop junk MESSAGE reactions whose converted form would duplicate another
--     reaction by the same user on the same message. "e2.id IS NOT NULL" means
--     the comparison row is itself junk (kept only if it has the lower id);
--     a native reaction (emoji_id IS NULL) is always the canonical keeper.
DELETE FROM public.reactions r
USING public.emojis e
WHERE r.emoji_id = e.id
  AND e.url IS NULL
  AND e.server_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM public.reactions r2
    LEFT JOIN public.emojis e2
      ON e2.id = r2.emoji_id AND e2.url IS NULL AND e2.server_id IS NULL
    WHERE r2.message_id = r.message_id
      AND r2.user_id = r.user_id
      AND r2.id <> r.id
      AND COALESCE(r2.custom_emoji_content, e2.name) = COALESCE(r.custom_emoji_content, e.name)
      AND (r2.emoji_id IS NULL OR (e2.id IS NOT NULL AND r2.id < r.id))
  );

-- 1b. Re-point the surviving junk message reactions to native unicode form.
UPDATE public.reactions r
SET custom_emoji_content = COALESCE(r.custom_emoji_content, e.name),
    emoji_id = NULL
FROM public.emojis e
WHERE r.emoji_id = e.id
  AND e.url IS NULL
  AND e.server_id IS NULL;

-- 2a. Same dedupe for federated POST reactions (avoids double-counting; the
--     emoji_reaction rows have no unique index so this is correctness, not a
--     hard constraint).
DELETE FROM public.post_interactions pi
USING public.emojis e
WHERE pi.emoji_id = e.id
  AND e.url IS NULL
  AND e.server_id IS NULL
  AND pi.interaction_type = 'emoji_reaction'
  AND EXISTS (
    SELECT 1
    FROM public.post_interactions p2
    LEFT JOIN public.emojis e2
      ON e2.id = p2.emoji_id AND e2.url IS NULL AND e2.server_id IS NULL
    WHERE p2.post_id = pi.post_id
      AND p2.user_id = pi.user_id
      AND p2.interaction_type = 'emoji_reaction'
      AND p2.id <> pi.id
      AND COALESCE(p2.custom_emoji_content, e2.name) = COALESCE(pi.custom_emoji_content, e.name)
      AND (p2.emoji_id IS NULL OR (e2.id IS NOT NULL AND p2.id < pi.id))
  );

-- 2b. Re-point surviving junk post reactions so grouping by custom_emoji_content holds.
UPDATE public.post_interactions pi
SET custom_emoji_content = COALESCE(pi.custom_emoji_content, e.name),
    emoji_id = NULL
FROM public.emojis e
WHERE pi.emoji_id = e.id
  AND e.url IS NULL
  AND e.server_id IS NULL;

-- 3. Remove the junk. emoji_usage / imported_as cascade or null out automatically.
DELETE FROM public.emojis
WHERE url IS NULL
  AND server_id IS NULL;

COMMIT;
