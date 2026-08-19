-- Three 20260528 migrations added, reverted and restored trg_broadcast_home_feed_entry.
-- They shared a date prefix and the runner sorted by filename, so "restore" sorted before
-- "revert" and the trigger ended up absent. Versioned filenames now order by commit, so a
-- replay finishes with the trigger present and this is a no-op there. It applies to
-- instances built before the rename.
--
-- Nothing else emits home_feed:new_post; without the trigger a new post never reaches a
-- follower's open timeline. Body matches init/.

BEGIN;

CREATE OR REPLACE FUNCTION public.broadcast_home_feed_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_author     uuid;
  v_created    timestamptz;
  v_visibility text;
  v_is_deleted boolean;
BEGIN
  IF NEW.timeline_type <> 'home' THEN
    RETURN NEW;
  END IF;

  SELECT author_id,
         created_at,
         visibility,
         COALESCE(is_deleted, false)
    INTO v_author, v_created, v_visibility, v_is_deleted
  FROM public.posts
  WHERE id = NEW.post_id;

  IF v_author IS NULL OR v_is_deleted THEN
    RETURN NEW;
  END IF;

  IF v_visibility NOT IN ('public', 'unlisted', 'followers') THEN
    RETURN NEW;
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type',         'home_feed:new_post',
      'post_id',      NEW.post_id,
      'author_id',    v_author,
      'created_at',   v_created,
      'visibility',   v_visibility,
      'source_table', 'timeline_entries'
    ),
    'user_event',
    'user:' || NEW.user_id::text,
    true
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_home_feed_entry ON public.timeline_entries;
CREATE TRIGGER trg_broadcast_home_feed_entry
    AFTER INSERT ON public.timeline_entries
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_home_feed_entry();

COMMIT;

NOTIFY pgrst, 'reload schema';
