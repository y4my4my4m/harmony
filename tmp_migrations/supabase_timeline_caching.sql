-- Supabase-Native Timeline Caching
-- Uses PostgreSQL JSONB instead of Redis for timeline storage

-- Timeline cache table using JSONB for fast access
CREATE TABLE IF NOT EXISTS user_timeline_cache (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  timeline_type text NOT NULL CHECK (timeline_type IN ('home', 'local', 'public')),
  posts_data jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_updated timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  
  UNIQUE(user_id, timeline_type)
);

-- Index for fast timeline lookups
CREATE INDEX IF NOT EXISTS idx_user_timeline_cache_lookup 
ON user_timeline_cache(user_id, timeline_type);

-- Index for efficient JSON operations
CREATE INDEX IF NOT EXISTS idx_user_timeline_cache_posts 
ON user_timeline_cache USING GIN(posts_data);

-- Function to get user timeline from cache (super fast)
CREATE OR REPLACE FUNCTION get_cached_timeline(
  p_user_id uuid,
  p_timeline_type text DEFAULT 'home',
  p_limit integer DEFAULT 20
) RETURNS jsonb AS $$
DECLARE
  cached_posts jsonb;
BEGIN
  -- Get from cache
  SELECT posts_data 
  INTO cached_posts
  FROM user_timeline_cache 
  WHERE user_id = p_user_id 
    AND timeline_type = p_timeline_type;
  
  -- Return limited posts
  IF cached_posts IS NOT NULL THEN
    RETURN jsonb_build_object(
      'posts', (
        SELECT jsonb_agg(post_data)
        FROM (
          SELECT value as post_data
          FROM jsonb_array_elements(cached_posts) 
          LIMIT p_limit
        ) limited_posts
      ),
      'cached', true,
      'count', jsonb_array_length(cached_posts)
    );
  END IF;
  
  -- Return empty if no cache
  RETURN jsonb_build_object('posts', '[]'::jsonb, 'cached', false);
END;
$$ LANGUAGE plpgsql;

-- Function to update timeline cache (called by triggers/Edge Functions)
CREATE OR REPLACE FUNCTION update_timeline_cache(
  p_user_id uuid,
  p_timeline_type text,
  p_action text, -- 'add', 'remove', 'rebuild'
  p_post_data jsonb DEFAULT NULL
) RETURNS boolean AS $$
DECLARE
  current_posts jsonb;
  new_posts jsonb;
BEGIN
  -- Get current cache
  SELECT posts_data INTO current_posts
  FROM user_timeline_cache 
  WHERE user_id = p_user_id AND timeline_type = p_timeline_type;
  
  -- Initialize if not exists
  IF current_posts IS NULL THEN
    current_posts := '[]'::jsonb;
  END IF;
  
  -- Perform action
  CASE p_action
    WHEN 'add' THEN
      -- Add new post to beginning, keep max 100 posts
      new_posts := jsonb_build_array(p_post_data) || current_posts;
      new_posts := (
        SELECT jsonb_agg(post_data)
        FROM (
          SELECT value as post_data
          FROM jsonb_array_elements(new_posts) 
          LIMIT 100
        ) limited
      );
      
    WHEN 'remove' THEN
      -- Remove post by ID
      new_posts := (
        SELECT COALESCE(jsonb_agg(post_data), '[]'::jsonb)
        FROM (
          SELECT value as post_data
          FROM jsonb_array_elements(current_posts)
          WHERE value->>'id' != p_post_data->>'id'
        ) filtered
      );
      
    WHEN 'rebuild' THEN
      -- Full rebuild from timeline view
      SELECT jsonb_agg(
        to_jsonb(tp.*) ORDER BY tp.created_at DESC
      ) INTO new_posts
      FROM timeline_posts tp
      WHERE 
        CASE p_timeline_type
          WHEN 'home' THEN 
            tp.author_id = p_user_id OR 
            tp.author_id IN (
              SELECT following_id FROM follows 
              WHERE follower_id = p_user_id
            )
          WHEN 'local' THEN tp.is_local = true AND tp.visibility = 'public'
          WHEN 'public' THEN tp.visibility = 'public'
        END
      LIMIT 100;
      
    ELSE
      RETURN false;
  END CASE;
  
  -- Upsert cache
  INSERT INTO user_timeline_cache (user_id, timeline_type, posts_data)
  VALUES (p_user_id, p_timeline_type, COALESCE(new_posts, '[]'::jsonb))
  ON CONFLICT (user_id, timeline_type) 
  DO UPDATE SET 
    posts_data = EXCLUDED.posts_data,
    last_updated = now();
    
  RETURN true;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update home timelines when new posts are created
CREATE OR REPLACE FUNCTION update_follower_timelines() 
RETURNS trigger AS $$
BEGIN
  -- Update home timelines for all followers
  INSERT INTO pg_background_job (
    job_type,
    payload
  ) VALUES (
    'update_follower_timelines',
    jsonb_build_object(
      'post_id', NEW.id,
      'author_id', NEW.author_id,
      'post_data', to_jsonb(NEW)
    )
  );
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger
DROP TRIGGER IF EXISTS trigger_update_follower_timelines ON posts;
CREATE TRIGGER trigger_update_follower_timelines
  AFTER INSERT ON posts
  FOR EACH ROW
  EXECUTE FUNCTION update_follower_timelines();

-- Background job queue table (simpler than Redis)
CREATE TABLE IF NOT EXISTS pg_background_job (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  job_type text NOT NULL,
  payload jsonb NOT NULL,
  status text DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  created_at timestamptz DEFAULT now(),
  processed_at timestamptz,
  error_message text
);

-- Index for job processing
CREATE INDEX IF NOT EXISTS idx_background_job_queue 
ON pg_background_job(status, created_at) 
WHERE status = 'pending';

-- RLS Policies
ALTER TABLE user_timeline_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE pg_background_job ENABLE ROW LEVEL SECURITY;

-- Users can only access their own timeline cache
CREATE POLICY "Users can access own timeline cache" ON user_timeline_cache
  FOR ALL USING (auth.uid() = user_id);

-- Only service role can manage background jobs
CREATE POLICY "Service role manages background jobs" ON pg_background_job
  FOR ALL USING (auth.role() = 'service_role'); 