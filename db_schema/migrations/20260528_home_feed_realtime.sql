-- =============================================================================
-- Migration: Broadcast `home_feed:new_post` events to each home-timeline
-- recipient's `user:{profile_id}` channel.
-- =============================================================================
-- Regression context:
--   `20260322_broadcast_post_follow_interaction.sql` replaced an unfiltered
--   `postgres_changes` subscription on `posts` with a `realtime.send()` call
--   that only delivers `post:new` to the AUTHOR's `user:{author_id}` channel.
--   The author still sees their own post update in real time, but followers
--   never receive the event - so their home timeline doesn't refresh until
--   they manually reload. That broke the "I follow Alice, Alice posts, I see
--   Alice's post immediately (with the little sound)" UX the user remembered.
--
-- Why this trigger lives on `timeline_entries` instead of `posts`:
--   `create_comprehensive_timeline_entries()` (in `11_functions_triggers.sql`)
--   already fans out a `posts` INSERT into one `timeline_entries` row per
--   recipient (followers + author for local 'home', plus all local users for
--   the 'public' timeline). Piggybacking on that table means:
--     * we don't repeat the followers SELECT
--     * we automatically pick up the visibility rules the fan-out already
--       enforces (public goes to all followers, unlisted/followers only to
--       accepted followers, etc.)
--     * the user_id column IS the recipient — no per-row UNION needed.
--
-- Realtime architecture compliance (see
-- `.cursor/rules/realtime-architecture.mdc`):
--   * reuses the existing `user:{profile_id}` topic + `user_event` name
--   * no new Supabase channel is opened on the frontend
--   * no postgres_changes (CDC) subscriptions are added
-- =============================================================================

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
  -- Scope: only the 'home' fan-out triggers a realtime push. 'public' and
  -- 'local' timelines are loaded on demand (heavy, paginated); pushing every
  -- public post to every connected user would re-introduce the firehose the
  -- 20260322 migration was trying to eliminate. 'notifications' has its
  -- own dedicated broadcast path via the notifications table.
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

  -- 'direct' / 'private' visibilities are intentionally excluded - they
  -- should not surface on the home timeline. 'followers' IS valid: the
  -- fan-out already restricts those entries to accepted followers, so a
  -- realtime push to that recipient is correct.
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
  -- A broadcast failure must never block the timeline_entries INSERT
  -- (the entry being persisted is the actual source of truth; the
  -- broadcast is a UX nicety on top).
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
