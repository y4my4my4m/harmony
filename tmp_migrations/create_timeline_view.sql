-- Create a timeline view that provides posts in final display format
-- This eliminates the need for "database to timeline" transformations

-- Drop existing view first to allow column name changes
DROP VIEW IF EXISTS timeline_posts CASCADE;

CREATE VIEW timeline_posts AS
SELECT 
  p.id,
  p.created_at,
  p.updated_at,
  p.content,
  p.content_warning,
  p.language,
  p.author_id,
  p.ap_id,
  p.ap_type,
  p.url,
  -- Reply context with preview info
  CASE 
    WHEN p.in_reply_to IS NOT NULL THEN (
      SELECT jsonb_build_object(
        'id', rp.id::text,
        'content_preview', 
          CASE 
            WHEN jsonb_typeof(rp.content) = 'array' THEN 
              left(rp.content->0->>'text', 100) || CASE WHEN length(rp.content->0->>'text') > 100 THEN '...' ELSE '' END
            ELSE 
              left(rp.content::text, 100) || CASE WHEN length(rp.content::text) > 100 THEN '...' ELSE '' END
          END,
        'author', jsonb_build_object(
          'id', rp_author.id::text,
          'username', rp_author.username,
          'display_name', COALESCE(rp_author.display_name, rp_author.username),
          'avatar_url', COALESCE(rp_author.avatar_url, '/default_avatar.png'),
          'domain', COALESCE(rp_author.domain, 'har.mony.lol')
        ),
        'created_at', rp.created_at,
        'visibility', rp.visibility
      )
      FROM posts rp 
      LEFT JOIN profiles rp_author ON rp.author_id = rp_author.id
      WHERE rp.id = p.in_reply_to
    )
    ELSE NULL
  END as reply_context,
  p.conversation_id,
  p.visibility,
  p.is_local,
  p.is_federated,
  p.replies_count,
  p.reblogs_count,
  p.favorites_count,
  p.media_attachments,
  p.metadata,
  p.is_sensitive,
  p.is_deleted,
  p.deleted_at,
  
  -- Author information (always included)
  COALESCE(
    jsonb_build_object(
      'id', prof.id,
      'username', prof.username,
      'display_name', COALESCE(prof.display_name, prof.username),
      'avatar_url', COALESCE(prof.avatar_url, '/default_avatar.png'),
      'domain', COALESCE(prof.domain, CASE WHEN p.is_local THEN 'har.mony.lol' ELSE 'unknown' END),
      'bio', prof.bio,
      'is_local', COALESCE(prof.is_local, p.is_local)
    ),
    jsonb_build_object(
      'id', p.author_id,
      'username', 'Unknown',
      'display_name', 'Unknown User',
      'avatar_url', '/default_avatar.png',
      'domain', CASE WHEN p.is_local THEN 'har.mony.lol' ELSE 'unknown' END,
      'is_local', p.is_local
    )
  ) as author

FROM posts p
LEFT JOIN profiles prof ON p.author_id = prof.id
WHERE p.is_deleted = false;

-- Create index for performance
CREATE INDEX IF NOT EXISTS timeline_posts_visibility_created_idx 
ON posts (visibility, created_at DESC) WHERE is_deleted = false;

CREATE INDEX IF NOT EXISTS timeline_posts_local_created_idx 
ON posts (is_local, created_at DESC) WHERE is_deleted = false AND visibility = 'public';

-- Function to get timeline posts with user interaction state
CREATE OR REPLACE FUNCTION get_timeline_posts_with_interactions(
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

COMMIT; 