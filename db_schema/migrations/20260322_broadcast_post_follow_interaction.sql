BEGIN;

-- ============================================================================
-- Step 1b+1d: Replace global CDC on posts, post_interactions, follows
-- with targeted user:{id} broadcast triggers.
--
-- This eliminates 3 unfiltered postgres_changes channels that previously
-- sent EVERY row change to EVERY connected client.
-- ============================================================================

-- 1. posts → broadcast to author's user:{id} channel
--    Covers: author seeing own post confirmed, soft-delete propagation,
--    content edits reflected in the author's feed.
CREATE OR REPLACE FUNCTION public.broadcast_post_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_event text;
  v_row  record;
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

  PERFORM realtime.send(
    jsonb_build_object(
      'type',       v_event,
      'post_id',    v_row.id,
      'author_id',  v_row.author_id,
      'visibility', v_row.visibility,
      'is_deleted', COALESCE(v_row.is_deleted, false),
      'ap_type',    v_row.ap_type
    ),
    'user_event',
    'user:' || v_row.author_id::text,
    true
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_post_event ON posts;
CREATE TRIGGER trg_broadcast_post_event
  AFTER INSERT OR UPDATE OR DELETE ON posts
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_post_event();


-- 2. post_interactions → broadcast to post author's user:{id} channel
--    Covers: favorite/reblog/bookmark/emoji_reaction counts and state
--    for the post author. Non-author viewers refresh on demand.
CREATE OR REPLACE FUNCTION public.broadcast_post_interaction_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_interaction record;
  v_post_author uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_interaction := OLD;
  ELSE
    v_interaction := NEW;
  END IF;

  SELECT author_id INTO v_post_author
  FROM posts
  WHERE id = v_interaction.post_id;

  IF v_post_author IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type',             'post:interaction',
      'post_id',          v_interaction.post_id,
      'interaction_type', v_interaction.interaction_type,
      'user_id',          v_interaction.user_id,
      'emoji_id',         v_interaction.emoji_id,
      'op',               TG_OP
    ),
    'user_event',
    'user:' || v_post_author::text,
    true
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_post_interaction ON post_interactions;
CREATE TRIGGER trg_broadcast_post_interaction
  AFTER INSERT OR DELETE ON post_interactions
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_post_interaction_event();


-- 3. follows → broadcast to both follower and followed user
--    Covers: follow counts, followedUsers set, accept/reject status
CREATE OR REPLACE FUNCTION public.broadcast_follow_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row     record;
  v_payload jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
  ELSE
    v_row := NEW;
  END IF;

  v_payload := jsonb_build_object(
    'type',         'follow:change',
    'follower_id',  v_row.follower_id,
    'following_id', v_row.following_id,
    'status',       v_row.status,
    'op',           TG_OP
  );

  PERFORM realtime.send(v_payload, 'user_event', 'user:' || v_row.follower_id::text, true);
  PERFORM realtime.send(v_payload, 'user_event', 'user:' || v_row.following_id::text, true);

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_follow_event ON follows;
CREATE TRIGGER trg_broadcast_follow_event
  AFTER INSERT OR UPDATE OR DELETE ON follows
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_follow_event();

COMMIT;
