-- =============================================================================
-- Migration: extend `broadcast_post_event` so that
--
--   1. edits and deletes (not just new posts) propagate to public/local
--      feed viewers — matches Mastodon / Misskey UX where a post update or
--      delete is reflected on every visible timeline in real time;
--
--   2. every post event also lands on the author's ephemeral profile
--      timeline topic `feed:user:{author_id}`, so anyone currently viewing
--      that profile sees new posts, edits and deletes immediately;
--
--   3. new public posts additionally fan out to `feed:hashtag:{tag}` for
--      every hashtag they contain (extracted by the existing
--      `extract_hashtags_on_post_insert` trigger, which runs alphabetically
--      before this one so the `post_hashtags` rows are visible here).
--
-- DRY: still a single trigger function — it decides which topics each event
-- belongs on. No new triggers. Adding the next feed kind (e.g. lists, group
-- feeds) is one more `PERFORM realtime.send(...)` block inside this function.
--
-- Scope notes:
--   - Hashtag-feed *deletes* are intentionally skipped. The cascade on
--     `post_hashtags(post_id)` removes those rows before this AFTER DELETE
--     trigger can read them, so we'd need a BEFORE-DELETE snapshot or a
--     side table. Users viewing a hashtag while a post elsewhere is being
--     deleted is rare enough that a brief stale entry (cleared on
--     refresh) is the right trade-off; revisit if real users complain.
--   - Hashtag-feed *edits* would require diffing OLD vs NEW post_hashtags,
--     which requires re-running the hashtag extractor on UPDATE. Out of
--     scope here; covered by `feed:public`/`feed:local` updates which
--     hashtag viewers usually have alongside.
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.broadcast_post_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event          text;
  v_row            record;
  v_payload        jsonb;
  v_publish_public boolean := false;
  v_publish_local  boolean := false;
  v_tag            text;
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

  -- (1) Author's personal user channel.
  PERFORM realtime.send(
    v_payload,
    'user_event',
    'user:' || v_row.author_id::text,
    true
  );

  -- (2) Author's profile timeline ephemeral topic. Anyone currently viewing
  -- that profile (subscribed via useFeedRealtime with kind 'user:<id>')
  -- receives the create / update / delete and reconciles their view.
  --
  -- IMPORTANT: gated on the post being (or having been) public. Direct,
  -- followers-only and private posts must NOT broadcast their metadata
  -- on this topic because realtime authorization is `USING (true)` for
  -- all authenticated users, so the topic name alone is the only access
  -- check (it's not a secret — it's literally derived from a public
  -- profile id). The author themselves still receives every event via
  -- their private `user:{author_id}` channel, so this restriction does
  -- not break the "author's other tabs see their own posts in realtime"
  -- use case.
  IF (TG_OP = 'INSERT' AND NEW.visibility = 'public')
     OR (TG_OP = 'UPDATE' AND (NEW.visibility = 'public' OR OLD.visibility = 'public'))
     OR (TG_OP = 'DELETE' AND OLD.visibility = 'public') THEN
    PERFORM realtime.send(
      v_payload,
      'feed_event',
      'feed:user:' || v_row.author_id::text,
      true
    );
  END IF;

  -- (3) Public / local view-bound topics. Publishing rules:
  --     INSERT: visibility = 'public' and not deleted
  --     UPDATE: OLD or NEW visibility was 'public' (covers "edited from
  --             public to private" which the receiver treats as a remove)
  --     DELETE: OLD visibility was 'public'
  --   feed:local additionally requires is_local on the same row.
  IF TG_OP = 'INSERT' THEN
    v_publish_public := (NEW.visibility = 'public' AND COALESCE(NEW.is_deleted, false) = false);
    v_publish_local  := v_publish_public AND COALESCE(NEW.is_local, false);
  ELSIF TG_OP = 'UPDATE' THEN
    v_publish_public := (NEW.visibility = 'public' OR OLD.visibility = 'public');
    v_publish_local  := v_publish_public
                       AND (COALESCE(NEW.is_local, false) OR COALESCE(OLD.is_local, false));
  ELSIF TG_OP = 'DELETE' THEN
    v_publish_public := (OLD.visibility = 'public');
    v_publish_local  := v_publish_public AND COALESCE(OLD.is_local, false);
  END IF;

  IF v_publish_public THEN
    PERFORM realtime.send(v_payload, 'feed_event', 'feed:public', true);
  END IF;
  IF v_publish_local THEN
    PERFORM realtime.send(v_payload, 'feed_event', 'feed:local', true);
  END IF;

  -- (4) Hashtag fan-out for new public posts only. See header notes about
  -- the deliberate edit/delete scoping.
  IF TG_OP = 'INSERT'
     AND NEW.visibility = 'public'
     AND COALESCE(NEW.is_deleted, false) = false THEN
    FOR v_tag IN
      SELECT h.normalized_tag
      FROM public.post_hashtags ph
      JOIN public.hashtags h ON h.id = ph.hashtag_id
      WHERE ph.post_id = NEW.id
    LOOP
      PERFORM realtime.send(v_payload, 'feed_event', 'feed:hashtag:' || v_tag, true);
    END LOOP;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
