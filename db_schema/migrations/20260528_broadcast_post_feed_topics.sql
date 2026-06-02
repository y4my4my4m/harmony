-- =============================================================================
-- Migration: extend `broadcast_post_event` so it ALSO publishes new public
-- posts to view-bound ephemeral feed topics (`feed:public`, `feed:local`).
-- =============================================================================
-- Context:
--   The home feed already has a dedicated trigger
--   (`broadcast_home_feed_entry` on `timeline_entries`) that pushes to each
--   recipient's `user:{id}` channel. Public and local timelines did not have
--   any realtime path, so viewers of those tabs only saw new posts after a
--   manual reload.
--
--   We deliberately do NOT broadcast every public post to every connected
--   client (that was the firehose `20260322_broadcast_post_follow_interaction`
--   killed). Instead we publish to two ephemeral topics; the frontend
--   subscribes only while the user is actively viewing the matching tab,
--   so cost is O(active viewers) per post, not O(connected users).
--
-- DRY choice:
--   We extend the existing `broadcast_post_event` function (one trigger on
--   `posts`) rather than adding a second trigger. The function decides
--   which topics each event belongs on, so adding hashtag / profile feeds
--   later is one PERFORM call, not a new trigger.
--
-- Realtime architecture compliance:
--   * Reuses `realtime.send()` (no new infra, no CDC).
--   * Topics `feed:public` / `feed:local` are ephemeral - the frontend
--     `useFeedRealtime` composable subscribes/unsubscribes as the user
--     switches tabs (same pattern as `typing:{ctx}`, `view-context:{id}`).
--   * Author's own `user:{author_id}` push is preserved; client dedup via
--     `_inFlightPostIds` handles the (rare) case where author is also
--     viewing the public tab.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.broadcast_post_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event   text;
  v_row     record;
  v_payload jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_event := 'post:deleted';
    v_row   := OLD;
  ELSIF TG_OP = 'INSERT' THEN
    v_event := 'post:new';
    v_row   := NEW;
  ELSE
    v_event := 'post:updated';
    v_row   := NEW;
  END IF;

  v_payload := jsonb_build_object(
    'type',       v_event,
    'post_id',    v_row.id,
    'author_id',  v_row.author_id,
    'visibility', v_row.visibility,
    'is_deleted', COALESCE(v_row.is_deleted, false),
    'is_local',   COALESCE(v_row.is_local, false),
    'ap_type',    v_row.ap_type
  );

  -- (1) Author's own channel - existing behaviour, kept verbatim so the
  -- author still sees their own create/edit/delete reflected across tabs.
  PERFORM realtime.send(
    v_payload,
    'user_event',
    'user:' || v_row.author_id::text,
    true
  );

  -- (2) View-bound feed topics. Only fire for fresh public INSERTs:
  --     * updates/deletes are reconciled via the author channel above and
  --       `removePostFromAllFeeds` on the frontend;
  --     * non-public posts (`unlisted`, `followers`, `direct`, `private`)
  --       must not appear on public/local timelines by visibility rules.
  IF TG_OP = 'INSERT'
     AND COALESCE(v_row.is_deleted, false) = false
     AND v_row.visibility = 'public' THEN
    PERFORM realtime.send(v_payload, 'feed_event', 'feed:public', true);
    IF COALESCE(v_row.is_local, false) THEN
      PERFORM realtime.send(v_payload, 'feed_event', 'feed:local', true);
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
