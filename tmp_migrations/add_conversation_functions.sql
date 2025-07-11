-- Add conversation management functions for complete thread support
-- Professional conversation threading like Twitter/Mastodon

-- Function to get conversation context (ancestors and descendants)
CREATE OR REPLACE FUNCTION get_conversation_context(
  p_post_id uuid,
  p_user_id uuid
) RETURNS jsonb AS $$
DECLARE
  conversation_id text;
  ancestors jsonb DEFAULT '[]'::jsonb;
  descendants jsonb DEFAULT '[]'::jsonb;
BEGIN
  -- Get the conversation ID for this post
  SELECT posts.conversation_id INTO conversation_id
  FROM posts WHERE posts.id = p_post_id;
  
  IF conversation_id IS NULL THEN
    RETURN jsonb_build_object(
      'ancestors', '[]'::jsonb,
      'descendants', '[]'::jsonb
    );
  END IF;
  
  -- Get ancestors (posts this is replying to, going up the chain)
  WITH RECURSIVE ancestor_chain AS (
    -- Start with the current post
    SELECT tp.*, 0 as depth
    FROM timeline_posts tp
    WHERE tp.id::text = p_post_id::text
    
    UNION ALL
    
    -- Recursively find parent posts
    SELECT tp.*, ac.depth + 1
    FROM timeline_posts tp
    JOIN ancestor_chain ac ON tp.id::text = (ac.reply_context->>'id')
    WHERE ac.depth < 10 -- Prevent infinite recursion
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', id,
      'content', content,
      'author', author,
      'created_at', created_at,
      'reply_context', reply_context,
      'replies_count', replies_count,
      'reblogs_count', reblogs_count,
      'favorites_count', favorites_count,
      'is_favorited', COALESCE(fav.user_id IS NOT NULL, false),
      'is_reblogged', COALESCE(reb.user_id IS NOT NULL, false),
      'is_bookmarked', COALESCE(book.user_id IS NOT NULL, false)
    ) ORDER BY depth DESC
  ) INTO ancestors
  FROM ancestor_chain ac
  LEFT JOIN post_interactions fav ON ac.id = fav.post_id 
    AND fav.user_id = p_user_id AND fav.interaction_type = 'favorite'
  LEFT JOIN post_interactions reb ON ac.id = reb.post_id 
    AND reb.user_id = p_user_id AND reb.interaction_type = 'reblog'
  LEFT JOIN post_interactions book ON ac.id = book.post_id 
    AND book.user_id = p_user_id AND book.interaction_type = 'bookmark'
  WHERE ac.depth > 0; -- Exclude the current post from ancestors
  
  -- Get descendants (replies to this post, going down the chain)
  WITH RECURSIVE descendant_chain AS (
    -- Start with direct replies to this post
    SELECT tp.*, 0 as depth
    FROM timeline_posts tp
    WHERE tp.reply_context->>'id' = p_post_id::text
    
    UNION ALL
    
    -- Recursively find replies to replies
    SELECT tp.*, dc.depth + 1
    FROM timeline_posts tp
    JOIN descendant_chain dc ON tp.reply_context->>'id' = dc.id::text
    WHERE dc.depth < 10 -- Prevent infinite recursion
  )
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', id,
      'content', content,
      'author', author,
      'created_at', created_at,
      'reply_context', reply_context,
      'replies_count', replies_count,
      'reblogs_count', reblogs_count,
      'favorites_count', favorites_count,
      'is_favorited', COALESCE(fav.user_id IS NOT NULL, false),
      'is_reblogged', COALESCE(reb.user_id IS NOT NULL, false),
      'is_bookmarked', COALESCE(book.user_id IS NOT NULL, false)
    ) ORDER BY created_at ASC
  ) INTO descendants
  FROM descendant_chain dc
  LEFT JOIN post_interactions fav ON dc.id = fav.post_id 
    AND fav.user_id = p_user_id AND fav.interaction_type = 'favorite'
  LEFT JOIN post_interactions reb ON dc.id = reb.post_id 
    AND reb.user_id = p_user_id AND reb.interaction_type = 'reblog'
  LEFT JOIN post_interactions book ON dc.id = book.post_id 
    AND book.user_id = p_user_id AND book.interaction_type = 'bookmark';
  
  RETURN jsonb_build_object(
    'ancestors', COALESCE(ancestors, '[]'::jsonb),
    'descendants', COALESCE(descendants, '[]'::jsonb)
  );
END;
$$ LANGUAGE plpgsql;

-- Function to get full conversation thread
CREATE OR REPLACE FUNCTION get_conversation_thread(
  p_conversation_id text,
  p_user_id uuid
) RETURNS jsonb AS $$
DECLARE
  root_post jsonb;
  thread_posts jsonb;
  reply_count integer;
  participant_count integer;
  last_updated timestamptz;
BEGIN
  -- Get the root post (the one that started the conversation)
  SELECT to_jsonb(tp.*) INTO root_post
  FROM timeline_posts tp
  WHERE tp.conversation_id = p_conversation_id
    AND tp.reply_context IS NULL
  ORDER BY tp.created_at ASC
  LIMIT 1;
  
  -- Get all posts in the conversation with user interaction state
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', tp.id,
      'content', tp.content,
      'author', tp.author,
      'created_at', tp.created_at,
      'reply_context', tp.reply_context,
      'replies_count', tp.replies_count,
      'reblogs_count', tp.reblogs_count,
      'favorites_count', tp.favorites_count,
      'is_favorited', COALESCE(fav.user_id IS NOT NULL, false),
      'is_reblogged', COALESCE(reb.user_id IS NOT NULL, false),
      'is_bookmarked', COALESCE(book.user_id IS NOT NULL, false)
    ) ORDER BY tp.created_at ASC
  ) INTO thread_posts
  FROM timeline_posts tp
  LEFT JOIN post_interactions fav ON tp.id = fav.post_id 
    AND fav.user_id = p_user_id AND fav.interaction_type = 'favorite'
  LEFT JOIN post_interactions reb ON tp.id = reb.post_id 
    AND reb.user_id = p_user_id AND reb.interaction_type = 'reblog'
  LEFT JOIN post_interactions book ON tp.id = book.post_id 
    AND book.user_id = p_user_id AND book.interaction_type = 'bookmark'
  WHERE tp.conversation_id = p_conversation_id;
  
  -- Get conversation stats
  SELECT 
    COUNT(*) - 1, -- Subtract 1 for root post
    COUNT(DISTINCT tp.author_id),
    MAX(tp.created_at)
  INTO reply_count, participant_count, last_updated
  FROM timeline_posts tp
  WHERE tp.conversation_id = p_conversation_id;
  
  RETURN jsonb_build_object(
    'root_post', root_post,
    'posts', COALESCE(thread_posts, '[]'::jsonb),
    'reply_count', COALESCE(reply_count, 0),
    'participant_count', COALESCE(participant_count, 0),
    'last_updated', last_updated
  );
END;
$$ LANGUAGE plpgsql;

-- Function to get replies to a specific post
CREATE OR REPLACE FUNCTION get_post_replies(
  p_post_id uuid,
  p_user_id uuid,
  p_limit integer DEFAULT 20,
  p_max_id text DEFAULT NULL
) RETURNS jsonb AS $$
DECLARE
  result jsonb;
BEGIN
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', tp.id,
      'created_at', tp.created_at,
      'content', tp.content,
      'author', tp.author,
      'reply_context', tp.reply_context,
      'conversation_id', tp.conversation_id,
      'visibility', tp.visibility,
      'replies_count', tp.replies_count,
      'reblogs_count', tp.reblogs_count,
      'favorites_count', tp.favorites_count,
      'media_attachments', tp.media_attachments,
      'is_sensitive', tp.is_sensitive,
      'content_warning', tp.content_warning,
      'is_favorited', COALESCE(fav.user_id IS NOT NULL, false),
      'is_reblogged', COALESCE(reb.user_id IS NOT NULL, false),
      'is_bookmarked', COALESCE(book.user_id IS NOT NULL, false)
    ) ORDER BY tp.created_at ASC
  ) INTO result
  FROM timeline_posts tp
  LEFT JOIN post_interactions fav ON tp.id = fav.post_id 
    AND fav.user_id = p_user_id AND fav.interaction_type = 'favorite'
  LEFT JOIN post_interactions reb ON tp.id = reb.post_id 
    AND reb.user_id = p_user_id AND reb.interaction_type = 'reblog'
  LEFT JOIN post_interactions book ON tp.id = book.post_id 
    AND book.user_id = p_user_id AND book.interaction_type = 'bookmark'
  WHERE tp.reply_context->>'id' = p_post_id::text
    AND (p_max_id IS NULL OR tp.created_at > p_max_id::timestamptz)
  ORDER BY tp.created_at ASC
  LIMIT p_limit;
  
  RETURN COALESCE(result, '[]'::jsonb);
END;
$$ LANGUAGE plpgsql;

-- Index for efficient conversation queries
CREATE INDEX IF NOT EXISTS idx_posts_conversation_id ON posts(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_in_reply_to ON posts(in_reply_to) WHERE in_reply_to IS NOT NULL; 