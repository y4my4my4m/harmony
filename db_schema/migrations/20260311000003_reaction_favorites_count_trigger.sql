BEGIN;

-- ============================================================================
-- 1. Create trigger function: emoji_reactions + favorites both update
--    posts.favorites_count (and reblogs update reblogs_count)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.update_post_reaction_counts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.interaction_type = 'emoji_reaction' OR NEW.interaction_type = 'favorite' THEN
      UPDATE posts
      SET favorites_count = favorites_count + 1
      WHERE id = NEW.post_id;
    ELSIF NEW.interaction_type = 'reblog' THEN
      UPDATE posts
      SET reblogs_count = reblogs_count + 1
      WHERE id = NEW.post_id;
    END IF;
    RETURN NEW;

  ELSIF TG_OP = 'DELETE' THEN
    IF OLD.interaction_type = 'emoji_reaction' OR OLD.interaction_type = 'favorite' THEN
      UPDATE posts
      SET favorites_count = GREATEST(favorites_count - 1, 0)
      WHERE id = OLD.post_id;
    ELSIF OLD.interaction_type = 'reblog' THEN
      UPDATE posts
      SET reblogs_count = GREATEST(reblogs_count - 1, 0)
      WHERE id = OLD.post_id;
    END IF;
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

-- Create trigger (drop first for idempotency)
DROP TRIGGER IF EXISTS trigger_update_post_reaction_counts ON post_interactions;
CREATE TRIGGER trigger_update_post_reaction_counts
  AFTER INSERT OR DELETE ON post_interactions
  FOR EACH ROW
  EXECUTE FUNCTION update_post_reaction_counts();

-- ============================================================================
-- 2. Fix is_favorited in get_enhanced_timeline_posts:
--    include emoji_reaction alongside favorite
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_enhanced_timeline_posts(
  p_user_id uuid,
  p_timeline_type text DEFAULT 'home'::text,
  p_limit integer DEFAULT 20,
  p_max_id text DEFAULT NULL::text
)
RETURNS TABLE(
  id text,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  content jsonb,
  content_warning text,
  language text,
  author_id text,
  ap_id text,
  ap_type text,
  url text,
  reply_context jsonb,
  conversation_id text,
  visibility text,
  is_local boolean,
  is_federated boolean,
  replies_count integer,
  reblogs_count integer,
  favorites_count integer,
  media_attachments jsonb,
  metadata jsonb,
  is_sensitive boolean,
  is_deleted boolean,
  deleted_at timestamp with time zone,
  author jsonb,
  is_favorited boolean,
  is_reblogged boolean,
  is_bookmarked boolean,
  reblog jsonb,
  reblog_author jsonb
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT
        tp.id::TEXT,
        tp.created_at,
        tp.updated_at,
        tp.content,
        tp.content_warning,
        'en'::TEXT as language,
        (tp.author->>'id')::TEXT as author_id,
        p.ap_id::TEXT,
        COALESCE(p.ap_type, 'Note')::TEXT as ap_type,
        tp.url,
        tp.reply_context,
        tp.conversation_id::TEXT,
        tp.visibility,
        (tp.author->>'is_local')::BOOLEAN as is_local,
        NOT (tp.author->>'is_local')::BOOLEAN as is_federated,
        tp.replies_count,
        tp.reblogs_count,
        tp.favorites_count,
        tp.media_attachments,
        COALESCE(p.metadata, '{}'::JSONB) as metadata,
        tp.is_sensitive,
        COALESCE(p.is_deleted, false) as is_deleted,
        p.deleted_at,
        tp.author,

        -- is_favorited: true if the user has a favorite OR emoji_reaction
        COALESCE(fav.user_id IS NOT NULL, false) as is_favorited,
        COALESCE(reb.user_id IS NOT NULL, false) as is_reblogged,
        COALESCE(book.user_id IS NOT NULL, false) as is_bookmarked,

        tp.reblog,
        tp.reblog_author

    FROM timeline_posts tp
    JOIN posts p ON tp.id = p.id
    LEFT JOIN post_interactions fav ON tp.id = fav.post_id
        AND fav.user_id = p_user_id
        AND fav.interaction_type IN ('favorite', 'emoji_reaction')
    LEFT JOIN post_interactions reb ON tp.id = reb.post_id
        AND reb.user_id = p_user_id
        AND reb.interaction_type = 'reblog'
    LEFT JOIN post_interactions book ON tp.id = book.post_id
        AND book.user_id = p_user_id
        AND book.interaction_type = 'bookmark'

    WHERE
        CASE
            WHEN p_timeline_type = 'home' THEN
                EXISTS (
                    SELECT 1 FROM timeline_entries te
                    WHERE te.user_id = p_user_id
                      AND te.post_id = tp.id
                      AND te.timeline_type = 'home'
                )
            WHEN p_timeline_type = 'local' THEN
                tp.visibility = 'public'
                AND (tp.author->>'is_local')::BOOLEAN = true
            WHEN p_timeline_type IN ('public', 'federated') THEN
                tp.visibility = 'public'
            ELSE tp.visibility = 'public'
        END

        AND (p_max_id IS NULL OR tp.created_at < (
            SELECT tp2.created_at FROM timeline_posts tp2 WHERE tp2.id = p_max_id::UUID
        ))

    ORDER BY tp.created_at DESC
    LIMIT p_limit;
END;
$$;

-- ============================================================================
-- 3. Backfill: recalculate favorites_count from actual interactions
-- ============================================================================
UPDATE posts p
SET favorites_count = sub.cnt
FROM (
  SELECT post_id, COUNT(*) AS cnt
  FROM post_interactions
  WHERE interaction_type IN ('favorite', 'emoji_reaction')
  GROUP BY post_id
) sub
WHERE p.id = sub.post_id
  AND p.favorites_count IS DISTINCT FROM sub.cnt;

COMMIT;
