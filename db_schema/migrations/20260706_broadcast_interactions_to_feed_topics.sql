-- Realtime: fan post interactions (favorite / emoji_reaction / reblog) out to
-- the view-bound feed topics, not just the post author's private channel.
--
-- Before: broadcast_post_interaction_event only published to
-- `user:{post_author}`, so a viewer who was NOT the author never saw reaction
-- or reblog counts change live - they only refreshed on remount via the
-- on-demand fetch. This mirrors broadcast_post_event, which already publishes
-- create/update/delete to feed:public / feed:local / feed:user:{author}.
--
-- Cost stays O(active viewers): feed:* topics are ephemeral, subscribed only
-- while the matching tab/profile is open. Bookmarks are private and are never
-- fanned out. The frontend count handler reads authoritative server counts and
-- no-ops for posts not in a visible feed, so re-delivery to the actor is safe.

BEGIN;

CREATE OR REPLACE FUNCTION public.broadcast_post_interaction_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_interaction record;
  v_post_author uuid;
  v_visibility  text;
  v_is_local    boolean;
  v_payload     jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_interaction := OLD;
  ELSE
    v_interaction := NEW;
  END IF;

  SELECT author_id, visibility, COALESCE(is_local, false)
  INTO v_post_author, v_visibility, v_is_local
  FROM posts
  WHERE id = v_interaction.post_id;

  IF v_post_author IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  v_payload := jsonb_build_object(
    'type',             'post:interaction',
    'post_id',          v_interaction.post_id,
    'interaction_type', v_interaction.interaction_type,
    'user_id',          v_interaction.user_id,
    'emoji_id',         v_interaction.emoji_id,
    'op',               TG_OP
  );

  -- Author's private channel (own tabs + interaction counts). Preserved.
  PERFORM realtime.send(v_payload, 'user_event', 'user:' || v_post_author::text, true);

  -- View-bound feed topics so any viewer of the post sees counts live.
  -- Bookmarks are private/local-only; never fan them out.
  IF v_interaction.interaction_type <> 'bookmark' THEN
    PERFORM realtime.send(v_payload, 'feed_event', 'feed:user:' || v_post_author::text, true);
    IF v_visibility = 'public' THEN
      PERFORM realtime.send(v_payload, 'feed_event', 'feed:public', true);
      IF v_is_local THEN
        PERFORM realtime.send(v_payload, 'feed_event', 'feed:local', true);
      END IF;
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
