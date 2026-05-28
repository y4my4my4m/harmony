BEGIN;

-- Emoji delete failed when post_interactions.emoji_id referenced the row (409 /
-- post_interactions_emoji_id_fkey). Reactions must keep a stable display key via
-- custom_emoji_content; emoji_id can be cleared on delete.

-- 1) Idempotent backfill (same rules as 20260311_fix_reaction_grouping.sql)
UPDATE public.post_interactions pi
SET custom_emoji_content = CASE
    WHEN e.url IS NOT NULL THEN ':' || e.name || ':'
    ELSE e.name
END
FROM public.emojis e
WHERE pi.emoji_id = e.id
  AND pi.interaction_type = 'emoji_reaction'
  AND pi.custom_emoji_content IS NULL;

-- 2) Orphan emoji_id values would block ADD CONSTRAINT
UPDATE public.post_interactions pi
SET emoji_id = NULL
WHERE pi.emoji_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.emojis e WHERE e.id = pi.emoji_id);

-- 3) Last-chance snapshot for legacy rows (FK SET NULL does not populate content)
CREATE OR REPLACE FUNCTION public.prepare_emoji_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.post_interactions pi
  SET custom_emoji_content = CASE
      WHEN OLD.url IS NOT NULL THEN ':' || OLD.name || ':'
      ELSE OLD.name
    END
  WHERE pi.emoji_id = OLD.id
    AND pi.custom_emoji_content IS NULL;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_prepare_emoji_deletion ON public.emojis;
CREATE TRIGGER trg_prepare_emoji_deletion
  BEFORE DELETE ON public.emojis
  FOR EACH ROW
  EXECUTE FUNCTION public.prepare_emoji_deletion();

-- 4) Referential integrity: clear emoji_id when the emoji row is deleted
ALTER TABLE public.post_interactions
  DROP CONSTRAINT IF EXISTS post_interactions_emoji_id_fkey;

ALTER TABLE public.post_interactions
  ADD CONSTRAINT post_interactions_emoji_id_fkey
  FOREIGN KEY (emoji_id) REFERENCES public.emojis(id) ON DELETE SET NULL;

COMMIT;
