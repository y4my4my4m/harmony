-- Fix ambiguous column reference in get_timeline_posts_with_interactions function

-- Drop existing function first to allow return type changes
DROP FUNCTION IF EXISTS get_timeline_posts_with_interactions(uuid,text,integer,text);

CREATE FUNCTION get_timeline_posts_with_interactions(
  p_user_id uuid,
  p_timeline_type text DEFAULT 'public',
  p_limit integer DEFAULT 20,
  p_max_id text DEFAULT NULL
) RETURNS TABLE (
  id text,
  created_at timestamptz,
  updated_at timestamptz,
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
  deleted_at timestamptz,
  author jsonb,
  is_favorited boolean,
  is_reblogged boolean,
  is_bookmarked boolean
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    tp.id::text,
    tp.created_at,
    tp.updated_at,
    tp.content,
    tp.content_warning,
    tp.language,
    tp.author_id::text,
    tp.ap_id,
    tp.ap_type,
    tp.url,
    tp.reply_context,
    tp.conversation_id::text,
    tp.visibility,
    tp.is_local,
    tp.is_federated,
    tp.replies_count,
    tp.reblogs_count,
    tp.favorites_count,
    tp.media_attachments,
    tp.metadata,
    tp.is_sensitive,
    tp.is_deleted,
    tp.deleted_at,
    tp.author,
    
    -- User interaction states
    COALESCE(fav.user_id IS NOT NULL, false) as is_favorited,
    COALESCE(reb.user_id IS NOT NULL, false) as is_reblogged,
    COALESCE(book.user_id IS NOT NULL, false) as is_bookmarked
    
  FROM timeline_posts tp
  LEFT JOIN post_interactions fav ON tp.id = fav.post_id 
    AND fav.user_id = p_user_id 
    AND fav.interaction_type = 'favorite'
  LEFT JOIN post_interactions reb ON tp.id = reb.post_id 
    AND reb.user_id = p_user_id 
    AND reb.interaction_type = 'reblog'
  LEFT JOIN post_interactions book ON tp.id = book.post_id 
    AND book.user_id = p_user_id 
    AND book.interaction_type = 'bookmark'
  
  WHERE 
    -- Timeline filtering
    CASE 
      WHEN p_timeline_type = 'public' THEN tp.visibility = 'public'
      WHEN p_timeline_type = 'local' THEN tp.visibility = 'public' AND tp.is_local = true
      WHEN p_timeline_type = 'home' THEN (
        tp.visibility = 'public' AND (
          tp.author_id::text = p_user_id::text OR
          EXISTS (
            SELECT 1 FROM follows f 
            WHERE f.follower_id = p_user_id 
            AND f.following_id = tp.author_id::uuid
            AND f.status = 'accepted'
          )
        )
      )
      ELSE tp.visibility = 'public'
    END
    AND (p_max_id IS NULL OR tp.created_at < (
      SELECT posts.created_at FROM posts WHERE posts.id = p_max_id::uuid
    ))
  
  ORDER BY tp.created_at DESC
  LIMIT p_limit;
END;
$$ LANGUAGE plpgsql; 