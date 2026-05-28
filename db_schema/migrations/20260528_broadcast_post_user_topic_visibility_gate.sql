-- =============================================================================
-- Follow-up to 20260528_broadcast_post_edits_deletes_and_topics.sql.
--
-- The earlier migration broadcast every post event on
-- `feed:user:{author_id}` regardless of visibility, which leaks metadata
-- (post_id / author_id / visibility / timing) for direct, private and
-- followers-only posts to anyone subscribed to that profile's topic.
--
-- Realtime authorization in this project is `USING (true)` for all
-- authenticated users (see db_schema/init/98_enable_rls.sql), so the
-- topic name itself is the only access check. The topic name is derived
-- from a public profile id, so it's NOT a secret.
--
-- Gate the topic on the post being (or having been) public, matching the
-- gate already used on `feed:public` / `feed:local`. The author's own
-- tabs still receive every post event via the existing private
-- `user:{author_id}` channel, so this restriction does not break the
-- "author's other tabs see their own posts in realtime" use case.
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

  PERFORM realtime.send(
    v_payload,
    'user_event',
    'user:' || v_row.author_id::text,
    true
  );

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
