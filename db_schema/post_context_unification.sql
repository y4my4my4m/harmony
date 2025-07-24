-- ActivityPub Post Thread Context Unification
-- Single RPC function to handle all post thread context scenarios
-- Replaces separate post detail and thread view functions

CREATE OR REPLACE FUNCTION get_post_with_context(
  p_post_id UUID,
  p_user_id UUID,
  p_context_type TEXT DEFAULT 'minimal',
  p_highlight_reply UUID DEFAULT NULL,
  p_max_depth INTEGER DEFAULT 10,
  p_include_interactions BOOLEAN DEFAULT TRUE
) RETURNS JSONB AS $$
DECLARE
  v_main_post JSONB;
  v_ancestors JSONB := '[]'::jsonb;
  v_descendants JSONB := '[]'::jsonb;
  v_thread_info JSONB;
  v_thread_id UUID;
  v_root_post_id UUID;
  v_total_posts INTEGER := 1;
  v_participant_count INTEGER := 1;
  v_max_depth INTEGER := 0;
  v_last_activity TIMESTAMP WITH TIME ZONE;
BEGIN
  -- Get the main post with all required fields and user interaction states
  SELECT to_jsonb(post_data) INTO v_main_post
  FROM (
    SELECT 
      p.*,
      profiles.id as author_id,
      profiles.username as author_username,
      profiles.display_name as author_display_name,
      profiles.avatar_url as author_avatar_url,
      profiles.domain as author_domain,
      profiles.bio as author_bio,
      profiles.is_local as author_is_local,
      profiles.followers_count as author_followers_count,
      profiles.following_count as author_following_count,
      profiles.posts_count as author_posts_count,
      profiles.created_at as author_created_at,
      profiles.updated_at as author_updated_at,
      -- Generate handle from username and domain
      CASE 
        WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
          '@' || profiles.username || '@' || profiles.domain
        ELSE 
          '@' || profiles.username
      END as author_handle,
      -- User interaction states (only if p_include_interactions is true)
      CASE 
        WHEN p_include_interactions THEN
          EXISTS(SELECT 1 FROM post_interactions WHERE post_id = p.id AND user_id = p_user_id AND interaction_type = 'favorite')
        ELSE false
      END as is_favorited,
      CASE 
        WHEN p_include_interactions THEN
          EXISTS(SELECT 1 FROM post_interactions WHERE post_id = p.id AND user_id = p_user_id AND interaction_type = 'reblog')
        ELSE false
      END as is_reblogged,
      CASE 
        WHEN p_include_interactions THEN
          EXISTS(SELECT 1 FROM post_interactions WHERE post_id = p.id AND user_id = p_user_id AND interaction_type = 'bookmark')
        ELSE false
      END as is_bookmarked,
      -- Author object for nested structure
      jsonb_build_object(
        'id', profiles.id,
        'username', profiles.username,
        'display_name', profiles.display_name,
        'avatar_url', profiles.avatar_url,
        'domain', profiles.domain,
        'bio', profiles.bio,
        'is_local', profiles.is_local,
        'followers_count', profiles.followers_count,
        'following_count', profiles.following_count,
        'posts_count', profiles.posts_count,
        'created_at', profiles.created_at,
        'updated_at', profiles.updated_at,
        'handle', CASE 
          WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
            '@' || profiles.username || '@' || profiles.domain
          ELSE 
            '@' || profiles.username
        END
      ) as author
    FROM posts p
    JOIN profiles ON profiles.id = p.author_id
    WHERE p.id = p_post_id
      AND p.is_deleted = false
  ) as post_data;

  -- If main post not found, return error
  IF v_main_post IS NULL THEN
    RETURN jsonb_build_object('error', 'Post not found');
  END IF;

  -- Get thread_id for thread context (may be null, that's ok)
  SELECT conversation_id INTO v_thread_id 
  FROM posts 
  WHERE id = p_post_id;

  -- For non-minimal contexts, get thread data
  IF p_context_type != 'minimal' THEN
    -- Find root post of the thread by following in_reply_to chain upward
    WITH RECURSIVE thread_root AS (
      -- Base case: start with the current post
      SELECT id, in_reply_to, 0 as depth
      FROM posts 
      WHERE id = p_post_id
      
      UNION ALL
      
      -- Recursive case: follow in_reply_to chain upward
      SELECT p.id, p.in_reply_to, tr.depth + 1
      FROM posts p
      JOIN thread_root tr ON p.id = tr.in_reply_to
      WHERE tr.depth < 50 -- Prevent infinite recursion
    )
    SELECT id INTO v_root_post_id 
    FROM thread_root 
    WHERE in_reply_to IS NULL
    ORDER BY depth DESC 
    LIMIT 1;

    -- If no root found, current post is the root
    IF v_root_post_id IS NULL THEN
      v_root_post_id := p_post_id;
    END IF;

    -- Get thread statistics using the conversation_root_id chain instead of conversation_id
    WITH RECURSIVE all_thread_posts AS (
      -- Start from the root post
      SELECT id, in_reply_to, author_id, created_at, 0 as depth
      FROM posts 
      WHERE id = v_root_post_id
      
      UNION ALL
      
      -- Get all posts that are replies in this thread
      SELECT p.id, p.in_reply_to, p.author_id, p.created_at, atp.depth + 1
      FROM posts p
      JOIN all_thread_posts atp ON p.in_reply_to = atp.id
      WHERE atp.depth < 50 -- Prevent infinite recursion
        AND p.is_deleted = false
    )
    SELECT 
      COUNT(DISTINCT id),
      COUNT(DISTINCT author_id),
      MAX(created_at)
    INTO v_total_posts, v_participant_count, v_last_activity
    FROM all_thread_posts;

    -- Get ancestors (posts this is replying to) if requested
    IF p_context_type IN ('thread', 'ancestors') THEN
      WITH RECURSIVE ancestors AS (
        -- Base case: direct parent
        SELECT p.*, 0 as depth
        FROM posts p
        WHERE p.id = (SELECT in_reply_to FROM posts WHERE id = p_post_id)
          AND p.is_deleted = false
        
        UNION ALL
        
        -- Recursive case: follow the reply chain upward
        SELECT p.*, a.depth + 1
        FROM posts p
        JOIN ancestors a ON p.id = (SELECT in_reply_to FROM posts WHERE id = a.id)
        WHERE a.depth < p_max_depth
          AND p.is_deleted = false
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', a.id,
          'created_at', a.created_at,
          'updated_at', a.updated_at,
          'content', a.content,
          'content_warning', a.content_warning,
          'language', a.language,
          'author_id', a.author_id,
          'ap_id', a.ap_id,
          'ap_type', a.ap_type,
          'url', a.url,
          'conversation_id', a.conversation_id,
          'visibility', a.visibility,
          'is_local', a.is_local,
          'is_federated', a.is_federated,
          'replies_count', a.replies_count,
          'reblogs_count', a.reblogs_count,
          'favorites_count', a.favorites_count,
          'media_attachments', a.media_attachments,
          'metadata', a.metadata,
          'is_sensitive', a.is_sensitive,
          'is_deleted', a.is_deleted,
          'deleted_at', a.deleted_at,
          'is_favorited', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = a.id AND user_id = p_user_id AND interaction_type = 'favorite')
            ELSE false
          END,
          'is_reblogged', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = a.id AND user_id = p_user_id AND interaction_type = 'reblog')
            ELSE false
          END,
          'is_bookmarked', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = a.id AND user_id = p_user_id AND interaction_type = 'bookmark')
            ELSE false
          END,
          'author', jsonb_build_object(
            'id', profiles.id,
            'username', profiles.username,
            'display_name', profiles.display_name,
            'avatar_url', profiles.avatar_url,
            'domain', profiles.domain,
            'bio', profiles.bio,
            'is_local', profiles.is_local,
            'followers_count', profiles.followers_count,
            'following_count', profiles.following_count,
            'posts_count', profiles.posts_count,
            'created_at', profiles.created_at,
            'updated_at', profiles.updated_at,
            'handle', CASE 
              WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
                '@' || profiles.username || '@' || profiles.domain
              ELSE 
                '@' || profiles.username
            END
          )
        ) ORDER BY a.depth DESC -- Oldest ancestor first
      ) INTO v_ancestors
      FROM ancestors a
      JOIN profiles ON profiles.id = a.author_id;
    END IF;

    -- Get descendants (replies to this post) if requested
    IF p_context_type IN ('thread', 'descendants') THEN
      WITH RECURSIVE descendants AS (
        -- Base case: direct replies
        SELECT p.*, 0 as depth, ARRAY[p.created_at::text, p.id::text] as sort_path
        FROM posts p
        WHERE p.in_reply_to = p_post_id
          AND p.is_deleted = false
        
        UNION ALL
        
        -- Recursive case: follow reply chains downward
        SELECT p.*, d.depth + 1, d.sort_path || ARRAY[p.created_at::text, p.id::text]
        FROM posts p
        JOIN descendants d ON p.in_reply_to = d.id
        WHERE d.depth < p_max_depth
          AND p.is_deleted = false
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', d.id,
          'created_at', d.created_at,
          'updated_at', d.updated_at,
          'content', d.content,
          'content_warning', d.content_warning,
          'language', d.language,
          'author_id', d.author_id,
          'ap_id', d.ap_id,
          'ap_type', d.ap_type,
          'url', d.url,
          'conversation_id', d.conversation_id,
          'visibility', d.visibility,
          'is_local', d.is_local,
          'is_federated', d.is_federated,
          'replies_count', d.replies_count,
          'reblogs_count', d.reblogs_count,
          'favorites_count', d.favorites_count,
          'media_attachments', d.media_attachments,
          'metadata', d.metadata,
          'is_sensitive', d.is_sensitive,
          'is_deleted', d.is_deleted,
          'deleted_at', d.deleted_at,
          'depth', d.depth,
          'is_favorited', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = d.id AND user_id = p_user_id AND interaction_type = 'favorite')
            ELSE false
          END,
          'is_reblogged', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = d.id AND user_id = p_user_id AND interaction_type = 'reblog')
            ELSE false
          END,
          'is_bookmarked', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = d.id AND user_id = p_user_id AND interaction_type = 'bookmark')
            ELSE false
          END,
          'author', jsonb_build_object(
            'id', profiles.id,
            'username', profiles.username,
            'display_name', profiles.display_name,
            'avatar_url', profiles.avatar_url,
            'domain', profiles.domain,
            'bio', profiles.bio,
            'is_local', profiles.is_local,
            'followers_count', profiles.followers_count,
            'following_count', profiles.following_count,
            'posts_count', profiles.posts_count,
            'created_at', profiles.created_at,
            'updated_at', profiles.updated_at,
            'handle', CASE 
              WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
                '@' || profiles.username || '@' || profiles.domain
              ELSE 
                '@' || profiles.username
            END
          )
        ) ORDER BY d.sort_path -- Chronological order preserving thread structure
      ) INTO v_descendants
      FROM descendants d
      JOIN profiles ON profiles.id = d.author_id;
    END IF;

    -- Calculate max depth for thread info using reply chain instead of conversation_id
    WITH RECURSIVE depth_calc AS (
      SELECT id, 0 as depth
      FROM posts 
      WHERE id = v_root_post_id
      
      UNION ALL
      
      SELECT p.id, dc.depth + 1
      FROM posts p
      JOIN depth_calc dc ON p.in_reply_to = dc.id
      WHERE dc.depth < 50 -- Prevent infinite recursion
        AND p.is_deleted = false
    )
    SELECT COALESCE(MAX(depth), 0) INTO v_max_depth
    FROM depth_calc;
  END IF;

  -- Build thread info
  v_thread_info := jsonb_build_object(
    'totalPosts', COALESCE(v_total_posts, 1),
    'participantCount', COALESCE(v_participant_count, 1),
    'depth', COALESCE(v_max_depth, 0),
    'rootPostId', COALESCE(v_root_post_id, p_post_id),
    'lastActivity', COALESCE(v_last_activity, (v_main_post->>'created_at')::timestamp with time zone)
  );

  -- Return the complete result
  RETURN jsonb_build_object(
    'mainPost', v_main_post,
    'ancestors', COALESCE(v_ancestors, '[]'::jsonb),
    'descendants', COALESCE(v_descendants, '[]'::jsonb),
    'threadInfo', v_thread_info
  );

EXCEPTION WHEN OTHERS THEN
  -- Log error and return structured error response
  RAISE LOG 'Error in get_post_with_context: %', SQLERRM;
  RETURN jsonb_build_object(
    'error', 'Database error: ' || SQLERRM,
    'mainPost', null,
    'ancestors', '[]'::jsonb,
    'descendants', '[]'::jsonb,
    'threadInfo', jsonb_build_object(
      'totalPosts', 0,
      'participantCount', 0,
      'depth', 0,
      'rootPostId', null,
      'lastActivity', null
    )
  );
END;
$$ LANGUAGE plpgsql;

-- Add comment for documentation
COMMENT ON FUNCTION get_post_with_context IS 'Unified function to get posts with configurable thread context (minimal, thread, ancestors, descendants). Replaces separate post detail and thread view functions.';

-- Create indexes to optimize thread queries if they don't exist
CREATE INDEX IF NOT EXISTS idx_posts_conversation_id ON posts(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_in_reply_to ON posts(in_reply_to) WHERE in_reply_to IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_post_interactions_user_post_type ON post_interactions(user_id, post_id, interaction_type);
