-- Restores the home-feed realtime broadcast trigger on databases that applied
-- the 20260528 migrations in filename order.
--
-- 20260528_home_feed_realtime.sql added trg_broadcast_home_feed_entry.
-- 20260528_revert_home_feed_realtime_trigger.sql dropped it, stating it was
-- "Replaced by an out-of-transaction BullMQ-driven broadcast in postHandler.ts".
-- 20260528_restore_home_feed_realtime_trigger.sql then recreated it.
--
-- All three carried the same date prefix and the runner applied migrations in
-- sort order -- scripts/install.sh did `find db_schema/migrations -name '*.sql'
-- | sort`. "restore" sorts before "revert", so the revert landed last and the
-- trigger ended up absent, while a fresh init/ build had it.
--
-- Filenames now carry a YYYYMMDDNNNNNN version ordered by the commit that
-- introduced each file, so a replay applies revert then restore -- the order
-- they were written -- and finishes with the trigger present. Verified by
-- replaying every pre-20260816 migration onto a fresh init build.
--
-- This migration is therefore a no-op on anything replayed from the current
-- filenames, and is kept for the databases that were not: any instance built
-- before the rename applied the pair alphabetically and is missing the trigger.
--
-- init/ is the correct side. The replacement the revert describes does not
-- exist: federation-backend/src/queue/handlers/postHandler.ts reads
-- "Home-feed realtime fan-out is handled by the `trg_broadcast_home_feed_entry`
-- DB trigger for all posts", and src/services/UserEventChannel.ts and
-- src/stores/useActivityPub.ts both name the function as the source of the
-- home-timeline broadcast. Without the trigger a new post never reaches a
-- follower's open timeline; nothing else emits home_feed:new_post.
--
-- The body below is identical to the one in
-- 20260528_restore_home_feed_realtime_trigger.sql and to init/.
--
-- Idempotent: CREATE OR REPLACE plus DROP TRIGGER IF EXISTS, so this is a
-- no-op on an instance that already carries the trigger.

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
