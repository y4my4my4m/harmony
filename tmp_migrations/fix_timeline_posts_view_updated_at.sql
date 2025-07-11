-- Fix timeline_posts view to include updated_at column
-- This column is expected by get_timeline_posts_with_interactions function

DROP VIEW IF EXISTS timeline_posts CASCADE;
CREATE VIEW timeline_posts AS
SELECT 
    p.id,
    p.content,
    p.created_at,
    p.updated_at, -- Missing column added here
    p.conversation_root_id,
    
    -- Author information with real counters
    jsonb_build_object(
        'id', pr.id,
        'username', pr.username,
        'display_name', pr.display_name,
        'avatar_url', pr.avatar_url,
        'domain', COALESCE(pr.domain, 'har.mony.lol'),
        'handle', CASE 
            WHEN COALESCE(pr.domain, 'har.mony.lol') = 'har.mony.lol'
            THEN '@' || pr.username
            ELSE '@' || pr.username || '@' || pr.domain
        END,
        'is_local', CASE WHEN COALESCE(pr.domain, 'har.mony.lol') = 'har.mony.lol' THEN true ELSE false END,
        'bio', pr.bio,
        'followers_count', pr.followers_count,
        'following_count', pr.following_count,
        'posts_count', pr.posts_count
    ) as author,
    
    p.visibility,
    COALESCE(p.favorites_count, 0) as favorites_count,
    COALESCE(p.reblogs_count, 0) as reblogs_count,
    COALESCE(p.replies_count, 0) as replies_count,
    COALESCE(p.is_favorited, false) as is_favorited,
    COALESCE(p.is_reblogged, false) as is_reblogged,
    COALESCE(p.is_bookmarked, false) as is_bookmarked,
    COALESCE(p.media_attachments, '[]'::jsonb) as media_attachments,
    
    -- Rich reply context with author info and content preview
    CASE 
        WHEN p.in_reply_to IS NOT NULL THEN
            jsonb_build_object(
                'id', rp.id,
                'author', jsonb_build_object(
                    'id', rpr.id,
                    'username', rpr.username,
                    'display_name', rpr.display_name,
                    'avatar_url', rpr.avatar_url,
                    'domain', COALESCE(rpr.domain, 'har.mony.lol'),
                    'handle', CASE 
                        WHEN COALESCE(rpr.domain, 'har.mony.lol') = 'har.mony.lol'
                        THEN '@' || rpr.username
                        ELSE '@' || rpr.username || '@' || rpr.domain
                    END
                ),
                'created_at', rp.created_at,
                'visibility', rp.visibility,
                'content_preview', LEFT(rp.content::text, 100)
            )
        ELSE NULL
    END as reply_context,
    
    p.content_warning,
    COALESCE(p.is_sensitive, false) as is_sensitive,
    p.reblog,
    p.reblog_author,
    p.url
FROM posts p
LEFT JOIN profiles pr ON p.author_id = pr.id
LEFT JOIN posts rp ON p.in_reply_to = rp.id
LEFT JOIN profiles rpr ON rp.author_id = rpr.id
WHERE p.deleted_at IS NULL;

-- Recreate any dependent functions that may have been dropped
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
    'en'::text as language, -- Default language
    (tp.author->>'id')::text as author_id,
    ''::text as ap_id, -- Default empty ap_id
    'Note'::text as ap_type, -- Default ActivityPub type
    tp.url,
    tp.reply_context,
    tp.conversation_root_id::text as conversation_id,
    tp.visibility,
    (tp.author->>'is_local')::boolean as is_local,
    NOT (tp.author->>'is_local')::boolean as is_federated,
    tp.replies_count,
    tp.reblogs_count,
    tp.favorites_count,
    tp.media_attachments,
    '{}'::jsonb as metadata,
    tp.is_sensitive,
    false as is_deleted,
    null::timestamptz as deleted_at,
    tp.author,
    
    -- User interaction states
    COALESCE(fav.user_id IS NOT NULL, false) as is_favorited,
    COALESCE(reb.user_id IS NOT NULL, false) as is_reblogged,
    COALESCE(book.user_id IS NOT NULL, false) as is_bookmarked
    
  FROM timeline_posts tp
  LEFT JOIN post_interactions fav ON tp.id::uuid = fav.post_id 
    AND fav.user_id = p_user_id 
    AND fav.interaction_type = 'favorite'
  LEFT JOIN post_interactions reb ON tp.id::uuid = reb.post_id 
    AND reb.user_id = p_user_id 
    AND reb.interaction_type = 'reblog'
  LEFT JOIN post_interactions book ON tp.id::uuid = book.post_id 
    AND book.user_id = p_user_id 
    AND book.interaction_type = 'bookmark'
  
  WHERE 
    -- Timeline filtering
    CASE 
      WHEN p_timeline_type = 'public' THEN tp.visibility = 'public'
      WHEN p_timeline_type = 'local' THEN tp.visibility = 'public' AND (tp.author->>'is_local')::boolean = true
      WHEN p_timeline_type = 'home' THEN (
        tp.visibility = 'public' AND (
          (tp.author->>'id')::text = p_user_id::text OR
          EXISTS (
            SELECT 1 FROM follows f 
            WHERE f.follower_id = p_user_id 
            AND f.following_id = (tp.author->>'id')::uuid
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

-- Grant permissions
GRANT EXECUTE ON FUNCTION get_timeline_posts_with_interactions(uuid, text, integer, text) TO authenticated; 