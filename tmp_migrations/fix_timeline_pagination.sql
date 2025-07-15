-- Fix pagination in get_timeline_posts_with_interactions function
-- The issue is that pagination was looking in the wrong table for the max_id timestamp

DROP FUNCTION IF EXISTS get_timeline_posts_with_interactions(uuid,text,integer,text);

CREATE OR REPLACE FUNCTION public.get_timeline_posts_with_interactions(
    p_user_id uuid, 
    p_timeline_type text DEFAULT 'public'::text, 
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
    tp.id::text,
    tp.created_at,
    tp.updated_at,
    tp.content,
    tp.content_warning,
    'en'::text as language,
    (tp.author->>'id')::text as author_id,
    p.ap_id::text,
    COALESCE(p.ap_type, 'Note')::text as ap_type,
    tp.url,
    tp.reply_context,
    tp.conversation_id::text,
    tp.visibility,
    (tp.author->>'is_local')::boolean as is_local,
    NOT (tp.author->>'is_local')::boolean as is_federated,
    tp.replies_count,
    tp.reblogs_count,
    tp.favorites_count,
    tp.media_attachments,
    COALESCE(p.metadata, '{}'::jsonb) as metadata,
    tp.is_sensitive,
    COALESCE(p.is_deleted, false) as is_deleted,
    p.deleted_at,
    tp.author,
    
    -- User interaction states
    COALESCE(fav.user_id IS NOT NULL, false) as is_favorited,
    COALESCE(reb.user_id IS NOT NULL, false) as is_reblogged,
    COALESCE(book.user_id IS NOT NULL, false) as is_bookmarked,
    
    -- Reblog fields
    tp.reblog,
    tp.reblog_author
    
  FROM timeline_posts tp
  JOIN posts p ON tp.id = p.id
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
    -- FIX: Use timeline_posts.created_at instead of posts.created_at for pagination
    AND (p_max_id IS NULL OR tp.created_at < (
      SELECT tp2.created_at FROM timeline_posts tp2 WHERE tp2.id = p_max_id::uuid
    ))
  
  ORDER BY tp.created_at DESC
  LIMIT p_limit;
END;
$$;

-- Grant permissions
GRANT EXECUTE ON FUNCTION public.get_timeline_posts_with_interactions TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_timeline_posts_with_interactions TO anon;

COMMENT ON FUNCTION public.get_timeline_posts_with_interactions IS 
'Fixed pagination: Get timeline posts with user interaction states and proper pagination using timeline_posts view';
