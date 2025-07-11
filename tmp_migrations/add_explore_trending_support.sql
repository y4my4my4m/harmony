-- Migration: Add Explore and Trending Support
-- Description: Adds hashtag tracking, trending calculations, and explore functionality
-- Author: Harmony ActivityPub System
-- Date: 2025-01-12

-- ============================================================================
-- HASHTAG AND TRENDING INFRASTRUCTURE
-- ============================================================================

-- Hashtag tracking table
CREATE TABLE IF NOT EXISTS hashtags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Hashtag info
    tag TEXT NOT NULL,
    normalized_tag TEXT NOT NULL UNIQUE, -- Make this unique for ON CONFLICT
    
    -- Usage tracking
    total_uses INTEGER DEFAULT 0,
    daily_uses INTEGER DEFAULT 0,
    weekly_uses INTEGER DEFAULT 0,
    
    -- Peak tracking
    peak_daily_uses INTEGER DEFAULT 0,
    peak_daily_date DATE,
    
    -- Timestamps
    first_used_at TIMESTAMPTZ DEFAULT NOW(),
    last_used_at TIMESTAMPTZ DEFAULT NOW(),
    
    -- Trending metrics
    trending_score DECIMAL DEFAULT 0,
    trending_rank INTEGER,
    last_trending_update TIMESTAMPTZ
);

-- Hashtag usage tracking (many-to-many between posts and hashtags)
CREATE TABLE IF NOT EXISTS post_hashtags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    hashtag_id UUID NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
    
    -- Position in post for relevance scoring
    position_in_content INTEGER DEFAULT 0,
    
    UNIQUE(post_id, hashtag_id)
);

-- Trending posts cache (for performance)
CREATE TABLE IF NOT EXISTS trending_posts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    post_id UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    
    -- Trending metrics
    trending_score DECIMAL NOT NULL DEFAULT 0.0,
    engagement_score DECIMAL NOT NULL DEFAULT 0.0,
    velocity_score DECIMAL NOT NULL DEFAULT 0.0,
    
    -- Time-based metrics
    period_type TEXT NOT NULL DEFAULT 'daily', -- 'hourly', 'daily', 'weekly'
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    
    -- Engagement data
    likes_count INTEGER DEFAULT 0,
    reblogs_count INTEGER DEFAULT 0,
    replies_count INTEGER DEFAULT 0,
    total_engagement INTEGER GENERATED ALWAYS AS (likes_count + reblogs_count + replies_count) STORED,
    
    -- Ranking
    trending_rank INTEGER,
    
    UNIQUE(post_id, period_type, period_start)
);

-- Trending users cache
CREATE TABLE IF NOT EXISTS trending_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    
    user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    
    -- Trending metrics
    trending_score DECIMAL NOT NULL DEFAULT 0.0,
    followers_growth DECIMAL DEFAULT 0.0,
    engagement_rate DECIMAL DEFAULT 0.0,
    
    -- Time period
    period_type TEXT NOT NULL DEFAULT 'daily',
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    
    -- Stats
    new_followers INTEGER DEFAULT 0,
    posts_count INTEGER DEFAULT 0,
    total_engagement INTEGER DEFAULT 0,
    
    -- Ranking
    trending_rank INTEGER,
    
    UNIQUE(user_id, period_type, period_start)
);

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

-- Hashtag indexes
CREATE INDEX IF NOT EXISTS idx_hashtags_normalized_tag ON hashtags(normalized_tag);
CREATE INDEX IF NOT EXISTS idx_hashtags_trending_score ON hashtags(trending_score DESC);
CREATE INDEX IF NOT EXISTS idx_hashtags_trending_rank ON hashtags(trending_rank ASC) WHERE trending_rank IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_hashtags_daily_uses ON hashtags(daily_uses DESC);
CREATE INDEX IF NOT EXISTS idx_hashtags_last_used ON hashtags(last_used_at DESC);

-- Post hashtags indexes
CREATE INDEX IF NOT EXISTS idx_post_hashtags_post_id ON post_hashtags(post_id);
CREATE INDEX IF NOT EXISTS idx_post_hashtags_hashtag_id ON post_hashtags(hashtag_id);
CREATE INDEX IF NOT EXISTS idx_post_hashtags_created_at ON post_hashtags(created_at DESC);

-- Trending posts indexes
CREATE INDEX IF NOT EXISTS idx_trending_posts_score ON trending_posts(trending_score DESC);
CREATE INDEX IF NOT EXISTS idx_trending_posts_period ON trending_posts(period_type, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_trending_posts_rank ON trending_posts(trending_rank ASC) WHERE trending_rank IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trending_posts_engagement ON trending_posts(total_engagement DESC);

-- Trending users indexes
CREATE INDEX IF NOT EXISTS idx_trending_users_score ON trending_users(trending_score DESC);
CREATE INDEX IF NOT EXISTS idx_trending_users_period ON trending_users(period_type, period_start DESC);
CREATE INDEX IF NOT EXISTS idx_trending_users_rank ON trending_users(trending_rank ASC) WHERE trending_rank IS NOT NULL;

-- ============================================================================
-- HASHTAG EXTRACTION AND TRACKING FUNCTIONS
-- ============================================================================

-- Function to normalize hashtag
CREATE OR REPLACE FUNCTION normalize_hashtag(tag TEXT)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    -- Remove # if present, convert to lowercase, keep only alphanumeric and underscore
    RETURN regexp_replace(lower(ltrim(tag, '#')), '[^a-z0-9_]', '', 'g');
END;
$$;

-- Function to extract hashtags from JSONB content
CREATE OR REPLACE FUNCTION extract_hashtags_from_content(content JSONB)
RETURNS TEXT[]
LANGUAGE plpgsql
AS $$
DECLARE
    text_content TEXT := '';
    hashtags TEXT[];
BEGIN
    -- Handle different content formats safely
    IF content IS NULL THEN
        RETURN ARRAY[]::TEXT[];
    END IF;
    
    -- Check if content is an array (expected format)
    IF jsonb_typeof(content) = 'array' THEN
        -- Extract text from JSONB array elements
        SELECT string_agg(elem->>'text', ' ')
        INTO text_content
        FROM jsonb_array_elements(content) AS elem
        WHERE elem->>'type' = 'text';
    ELSIF jsonb_typeof(content) = 'string' THEN
        -- Handle simple string content
        text_content := content #>> '{}';
    ELSIF jsonb_typeof(content) = 'object' AND content ? 'text' THEN
        -- Handle single object with text field
        text_content := content->>'text';
    ELSE
        -- Try to extract any text value from the JSONB
        text_content := content #>> '{}';
    END IF;
    
    -- Return empty array if no text content found
    IF text_content IS NULL OR text_content = '' THEN
        RETURN ARRAY[]::TEXT[];
    END IF;
    
    -- Extract hashtags using regex
    SELECT array_agg(DISTINCT lower(substring(match, 2)))
    INTO hashtags
    FROM regexp_split_to_table(text_content, '\s+') AS match
    WHERE match ~ '^#[a-zA-Z0-9_]+$'
      AND length(match) > 1
      AND length(match) <= 50; -- Reasonable hashtag length limit
    
    -- Return empty array if no hashtags found
    RETURN COALESCE(hashtags, ARRAY[]::TEXT[]);
END;
$$;

-- Function to upsert hashtag and return ID
CREATE OR REPLACE FUNCTION upsert_hashtag(p_hashtag_text TEXT)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_hashtag_id UUID;
    v_normalized TEXT;
BEGIN
    v_normalized := normalize_hashtag(p_hashtag_text);
    
    -- Insert or update hashtag
    INSERT INTO hashtags (tag, normalized_tag, total_uses, daily_uses, weekly_uses, last_used_at)
    VALUES (p_hashtag_text, v_normalized, 1, 1, 1, NOW())
    ON CONFLICT (normalized_tag) 
    DO UPDATE SET
        total_uses = hashtags.total_uses + 1,
        daily_uses = hashtags.daily_uses + 1,
        weekly_uses = hashtags.weekly_uses + 1,
        last_used_at = NOW(),
        updated_at = NOW()
    RETURNING id INTO v_hashtag_id;
    
    RETURN v_hashtag_id;
END;
$$;

-- Function to process hashtags for a post
CREATE OR REPLACE FUNCTION process_post_hashtags(p_post_id UUID, p_content JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    v_hashtag_array TEXT[];
    v_hashtag_text TEXT;
    v_hashtag_id UUID;
    v_position_counter INTEGER := 0;
    v_processed_count INTEGER := 0;
BEGIN
    -- Extract hashtags from content
    v_hashtag_array := extract_hashtags_from_content(p_content);
    
    -- Process each hashtag
    FOREACH v_hashtag_text IN ARRAY v_hashtag_array LOOP
        v_position_counter := v_position_counter + 1;
        
        -- Upsert hashtag and get ID
        v_hashtag_id := upsert_hashtag(v_hashtag_text);
        
        -- Link post to hashtag
        INSERT INTO post_hashtags (post_id, hashtag_id, position_in_content)
        VALUES (p_post_id, v_hashtag_id, v_position_counter)
        ON CONFLICT (post_id, hashtag_id) DO NOTHING;
        
        v_processed_count := v_processed_count + 1;
    END LOOP;
    
    RETURN v_processed_count;
END;
$$;

-- ============================================================================
-- TRENDING CALCULATION FUNCTIONS
-- ============================================================================

-- Function to calculate hashtag trending score
CREATE OR REPLACE FUNCTION calculate_hashtag_trending_score(
    p_daily_uses INTEGER,
    p_weekly_uses INTEGER,
    p_total_uses INTEGER,
    p_last_used_hours_ago DECIMAL DEFAULT 0
)
RETURNS DECIMAL
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_velocity_score DECIMAL;
    v_popularity_score DECIMAL;
    v_recency_score DECIMAL;
    v_trending_score DECIMAL;
BEGIN
    -- Velocity: daily vs weekly ratio
    v_velocity_score := CASE 
        WHEN p_weekly_uses > 0 THEN (p_daily_uses::DECIMAL / p_weekly_uses::DECIMAL) * 10
        ELSE p_daily_uses::DECIMAL
    END;
    
    -- Popularity: logarithmic scale of daily uses
    v_popularity_score := CASE 
        WHEN p_daily_uses > 0 THEN ln(p_daily_uses + 1) * 2
        ELSE 0
    END;
    
    -- Recency: decay based on time since last use
    v_recency_score := CASE 
        WHEN p_last_used_hours_ago <= 1 THEN 10
        WHEN p_last_used_hours_ago <= 6 THEN 8
        WHEN p_last_used_hours_ago <= 12 THEN 6
        WHEN p_last_used_hours_ago <= 24 THEN 4
        ELSE 1
    END;
    
    -- Combined trending score
    v_trending_score := (v_velocity_score * 0.4) + (v_popularity_score * 0.4) + (v_recency_score * 0.2);
    
    RETURN GREATEST(v_trending_score, 0);
END;
$$;

-- Function to update hashtag trending scores
CREATE OR REPLACE FUNCTION update_hashtag_trending_scores()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    updated_count INTEGER := 0;
BEGIN
    -- Update trending scores for all hashtags
    UPDATE hashtags 
    SET 
        trending_score = calculate_hashtag_trending_score(
            daily_uses,
            weekly_uses,
            total_uses,
            EXTRACT(EPOCH FROM (NOW() - last_used_at)) / 3600
        ),
        last_trending_update = NOW(),
        updated_at = NOW()
    WHERE last_used_at >= NOW() - INTERVAL '7 days'; -- Only update recently used hashtags
    
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    
    -- Update trending ranks
    UPDATE hashtags 
    SET trending_rank = ranked.rank_num
    FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY trending_score DESC) as rank_num
        FROM hashtags 
        WHERE trending_score > 0
        ORDER BY trending_score DESC
        LIMIT 100
    ) ranked
    WHERE hashtags.id = ranked.id;
    
    -- Clear ranks for non-trending hashtags
    UPDATE hashtags 
    SET trending_rank = NULL
    WHERE trending_score <= 0 OR trending_rank > 100;
    
    RETURN updated_count;
END;
$$;

-- Function to get trending hashtags
CREATE OR REPLACE FUNCTION get_trending_hashtags(p_limit_count INTEGER DEFAULT 20)
RETURNS TABLE (
    tag TEXT,
    daily_uses INTEGER,
    trending_score DECIMAL,
    trending_rank INTEGER,
    change_percent DECIMAL
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        h.tag,
        h.daily_uses,
        h.trending_score,
        h.trending_rank,
        CASE 
            WHEN h.weekly_uses > 0 THEN 
                ROUND(((h.daily_uses::DECIMAL - (h.weekly_uses::DECIMAL / 7)) / (h.weekly_uses::DECIMAL / 7)) * 100, 1)
            ELSE 0.0
        END as change_percent
    FROM hashtags h
    WHERE h.trending_rank IS NOT NULL 
    ORDER BY h.trending_rank ASC
    LIMIT p_limit_count;
END;
$$;

-- ============================================================================
-- POST PROCESSING TRIGGER
-- ============================================================================

-- Trigger function to process hashtags when posts are created
CREATE OR REPLACE FUNCTION trigger_process_post_hashtags()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    -- Process hashtags for new posts
    PERFORM process_post_hashtags(NEW.id, NEW.content);
    RETURN NEW;
END;
$$;

-- Create trigger for new posts
DROP TRIGGER IF EXISTS process_post_hashtags_trigger ON posts;
CREATE TRIGGER process_post_hashtags_trigger
    AFTER INSERT ON posts
    FOR EACH ROW
    EXECUTE FUNCTION trigger_process_post_hashtags();

-- ============================================================================
-- TRENDING POSTS FUNCTIONS
-- ============================================================================

-- Function to calculate post engagement score
CREATE OR REPLACE FUNCTION calculate_post_engagement_score(
    p_favorites_count INTEGER,
    p_reblogs_count INTEGER,
    p_replies_count INTEGER,
    p_hours_since_creation DECIMAL
)
RETURNS DECIMAL
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_engagement_score DECIMAL;
    v_time_decay DECIMAL;
BEGIN
    -- Base engagement (weighted: favorites=1, reblogs=2, replies=1.5)
    v_engagement_score := (p_favorites_count * 1.0) + (p_reblogs_count * 2.0) + (p_replies_count * 1.5);
    
    -- Time decay factor (fresher content gets higher scores)
    v_time_decay := CASE 
        WHEN p_hours_since_creation <= 1 THEN 1.0
        WHEN p_hours_since_creation <= 6 THEN 0.8
        WHEN p_hours_since_creation <= 24 THEN 0.6
        WHEN p_hours_since_creation <= 72 THEN 0.4
        ELSE 0.2
    END;
    
    RETURN v_engagement_score * v_time_decay;
END;
$$;

-- Function to update trending posts
CREATE OR REPLACE FUNCTION update_trending_posts()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    updated_count INTEGER := 0;
BEGIN
    -- Clear old trending posts data
    DELETE FROM trending_posts 
    WHERE period_start < NOW() - INTERVAL '7 days';
    
    -- Insert/update trending posts for today
    INSERT INTO trending_posts (
        post_id, trending_score, engagement_score, period_type, 
        period_start, period_end, likes_count, reblogs_count, replies_count
    )
    SELECT 
        p.id,
        calculate_post_engagement_score(
            p.favorites_count, 
            p.reblogs_count, 
            p.replies_count,
            EXTRACT(EPOCH FROM (NOW() - p.created_at)) / 3600
        ),
        (p.favorites_count + p.reblogs_count + p.replies_count)::DECIMAL,
        'daily',
        date_trunc('day', NOW()),
        date_trunc('day', NOW()) + INTERVAL '1 day',
        p.favorites_count,
        p.reblogs_count,
        p.replies_count
    FROM posts p
    WHERE 
        p.created_at >= NOW() - INTERVAL '2 days'
        AND p.visibility IN ('public', 'unlisted')
        AND p.is_deleted = false
        AND (p.favorites_count + p.reblogs_count + p.replies_count) > 0
    ON CONFLICT (post_id, period_type, period_start) DO UPDATE SET
        trending_score = EXCLUDED.trending_score,
        engagement_score = EXCLUDED.engagement_score,
        likes_count = EXCLUDED.likes_count,
        reblogs_count = EXCLUDED.reblogs_count,
        replies_count = EXCLUDED.replies_count,
        updated_at = NOW();
    
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    
    -- Update trending ranks
    UPDATE trending_posts 
    SET trending_rank = ranked.rank_num
    FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY trending_score DESC) as rank_num
        FROM trending_posts 
        WHERE period_type = 'daily' 
          AND period_start = date_trunc('day', NOW())
        ORDER BY trending_score DESC
        LIMIT 100
    ) ranked
    WHERE trending_posts.id = ranked.id;
    
    RETURN updated_count;
END;
$$;

-- ============================================================================
-- SCHEDULED MAINTENANCE AND CLEANUP
-- ============================================================================

-- Function to reset daily counters (should be called daily)
CREATE OR REPLACE FUNCTION reset_daily_hashtag_counters()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    reset_count INTEGER;
BEGIN
    UPDATE hashtags 
    SET daily_uses = 0
    WHERE daily_uses > 0;
    
    GET DIAGNOSTICS reset_count = ROW_COUNT;
    RETURN reset_count;
END;
$$;

-- Function to reset weekly counters (should be called weekly)
CREATE OR REPLACE FUNCTION reset_weekly_hashtag_counters()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    reset_count INTEGER;
BEGIN
    UPDATE hashtags 
    SET weekly_uses = 0
    WHERE weekly_uses > 0;
    
    GET DIAGNOSTICS reset_count = ROW_COUNT;
    RETURN reset_count;
END;
$$;

-- Function to clean up old and inactive hashtags
CREATE OR REPLACE FUNCTION cleanup_inactive_hashtags()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    deleted_count INTEGER := 0;
    temp_count INTEGER;
BEGIN
    -- Log cleanup start
    RAISE NOTICE 'Starting hashtag cleanup process...';
    
    -- Delete hashtags that meet ALL of these criteria:
    -- 1. Haven't been used in the last 90 days
    -- 2. Have very low total usage (< 5 total uses)
    -- 3. No trending activity (trending_score = 0 or NULL)
    -- 4. Not currently in trending ranks
    DELETE FROM hashtags 
    WHERE last_used_at < NOW() - INTERVAL '90 days'
      AND total_uses < 5
      AND (trending_score <= 0 OR trending_score IS NULL)
      AND trending_rank IS NULL;
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    -- Also clean up hashtags that haven't been used in 6 months regardless of usage
    -- (but keep a minimum threshold for very popular hashtags)
    DELETE FROM hashtags 
    WHERE last_used_at < NOW() - INTERVAL '6 months'
      AND total_uses < 100; -- Keep historically popular hashtags
    
    GET DIAGNOSTICS temp_count = ROW_COUNT;
    deleted_count := deleted_count + temp_count;
    
    -- Clean up orphaned post_hashtags (hashtags that no longer exist)
    DELETE FROM post_hashtags 
    WHERE hashtag_id NOT IN (SELECT id FROM hashtags);
    
    RAISE NOTICE 'Hashtag cleanup completed. Deleted % inactive hashtags.', deleted_count;
    RETURN deleted_count;
END;
$$;

-- Function to clean up old trending data
CREATE OR REPLACE FUNCTION cleanup_old_trending_data()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    deleted_count INTEGER := 0;
    temp_count INTEGER;
BEGIN
    -- Clean up trending posts older than 30 days
    DELETE FROM trending_posts 
    WHERE period_start < NOW() - INTERVAL '30 days';
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    -- Clean up trending users older than 30 days
    DELETE FROM trending_users 
    WHERE period_start < NOW() - INTERVAL '30 days';
    
    GET DIAGNOSTICS temp_count = ROW_COUNT;
    deleted_count := deleted_count + temp_count;
    
    RAISE NOTICE 'Trending data cleanup completed. Deleted % old records.', deleted_count;
    RETURN deleted_count;
END;
$$;

-- Function to archive popular hashtags before deletion
CREATE OR REPLACE FUNCTION archive_popular_hashtags()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    archived_count INTEGER := 0;
BEGIN
    -- Create hashtag_archive table if it doesn't exist
    CREATE TABLE IF NOT EXISTS hashtag_archive (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        archived_at TIMESTAMPTZ DEFAULT NOW(),
        original_hashtag_id UUID,
        tag TEXT NOT NULL,
        total_uses INTEGER,
        peak_daily_uses INTEGER,
        peak_daily_date DATE,
        first_used_at TIMESTAMPTZ,
        last_used_at TIMESTAMPTZ,
        archive_reason TEXT
    );
    
    -- Archive hashtags that had significant usage but are now inactive
    INSERT INTO hashtag_archive (
        original_hashtag_id, tag, total_uses, peak_daily_uses, 
        peak_daily_date, first_used_at, last_used_at, archive_reason
    )
    SELECT 
        id, tag, total_uses, peak_daily_uses, 
        peak_daily_date, first_used_at, last_used_at,
        'Archived due to 6+ months inactivity but high historical usage'
    FROM hashtags 
    WHERE last_used_at < NOW() - INTERVAL '6 months'
      AND total_uses >= 100
      AND id NOT IN (SELECT original_hashtag_id FROM hashtag_archive WHERE original_hashtag_id IS NOT NULL);
    
    GET DIAGNOSTICS archived_count = ROW_COUNT;
    
    RAISE NOTICE 'Archived % popular but inactive hashtags.', archived_count;
    RETURN archived_count;
END;
$$;

-- Comprehensive maintenance function
CREATE OR REPLACE FUNCTION run_trending_maintenance()
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
    result JSON;
    hashtags_cleaned INTEGER;
    trending_cleaned INTEGER;
    hashtags_archived INTEGER;
    scores_updated INTEGER;
BEGIN
    -- Archive popular hashtags before cleanup
    hashtags_archived := archive_popular_hashtags();
    
    -- Clean up inactive hashtags
    hashtags_cleaned := cleanup_inactive_hashtags();
    
    -- Clean up old trending data
    trending_cleaned := cleanup_old_trending_data();
    
    -- Update trending scores
    scores_updated := update_hashtag_trending_scores();
    
    -- Update trending posts
    PERFORM update_trending_posts();
    
    -- Build result
    result := json_build_object(
        'maintenance_completed_at', NOW(),
        'hashtags_archived', hashtags_archived,
        'hashtags_cleaned', hashtags_cleaned,
        'trending_data_cleaned', trending_cleaned,
        'trending_scores_updated', scores_updated,
        'status', 'success'
    );
    
    RAISE NOTICE 'Trending system maintenance completed: %', result;
    RETURN result;
END;
$$;

-- Function to get maintenance statistics
CREATE OR REPLACE FUNCTION get_trending_maintenance_stats()
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
    result JSON;
    total_hashtags INTEGER;
    active_hashtags INTEGER;
    trending_hashtags INTEGER;
    old_hashtags INTEGER;
    trending_posts_count INTEGER;
    trending_users_count INTEGER;
    archived_hashtags INTEGER;
BEGIN
    -- Get current statistics
    SELECT COUNT(*) INTO total_hashtags FROM hashtags;
    SELECT COUNT(*) INTO active_hashtags FROM hashtags WHERE last_used_at >= NOW() - INTERVAL '30 days';
    SELECT COUNT(*) INTO trending_hashtags FROM hashtags WHERE trending_rank IS NOT NULL;
    SELECT COUNT(*) INTO old_hashtags FROM hashtags WHERE last_used_at < NOW() - INTERVAL '90 days';
    SELECT COUNT(*) INTO trending_posts_count FROM trending_posts;
    SELECT COUNT(*) INTO trending_users_count FROM trending_users;
    
    -- Get archived count if table exists
    SELECT COUNT(*) INTO archived_hashtags 
    FROM hashtag_archive 
    WHERE EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'hashtag_archive');
    
    result := json_build_object(
        'generated_at', NOW(),
        'hashtags', json_build_object(
            'total', total_hashtags,
            'active_last_30_days', active_hashtags,
            'currently_trending', trending_hashtags,
            'older_than_90_days', old_hashtags,
            'archived', COALESCE(archived_hashtags, 0)
        ),
        'trending_data', json_build_object(
            'trending_posts', trending_posts_count,
            'trending_users', trending_users_count
        ),
        'recommendations', json_build_object(
            'should_run_cleanup', old_hashtags > 100,
            'cleanup_benefit_estimate', old_hashtags || ' hashtags could be cleaned',
            'next_recommended_cleanup', CASE 
                WHEN old_hashtags > 500 THEN 'immediately'
                WHEN old_hashtags > 100 THEN 'within a week'
                ELSE 'not needed'
            END
        )
    );
    
    RETURN result;
END;
$$;

-- ============================================================================
-- AUTOMATED CLEANUP JOBS (PostgreSQL Extension Based)
-- ============================================================================

-- Note: These require pg_cron extension to be enabled
-- Enable with: CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Schedule daily hashtag counter reset (runs at 2 AM daily)
-- SELECT cron.schedule('reset-daily-hashtag-counters', '0 2 * * *', 'SELECT reset_daily_hashtag_counters();');

-- Schedule weekly hashtag counter reset (runs at 3 AM every Sunday)  
-- SELECT cron.schedule('reset-weekly-hashtag-counters', '0 3 * * 0', 'SELECT reset_weekly_hashtag_counters();');

-- Schedule weekly maintenance (runs at 4 AM every Sunday)
-- SELECT cron.schedule('trending-maintenance', '0 4 * * 0', 'SELECT run_trending_maintenance();');

-- Manual cleanup commands (uncomment to run immediately)
-- SELECT run_trending_maintenance();

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

-- Enable RLS on new tables
ALTER TABLE hashtags ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_hashtags ENABLE ROW LEVEL SECURITY;
ALTER TABLE trending_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE trending_users ENABLE ROW LEVEL SECURITY;

-- Public read access for hashtags and trending data
CREATE POLICY "Anyone can view hashtags" ON hashtags FOR SELECT USING (true);
CREATE POLICY "Anyone can view post hashtags" ON post_hashtags FOR SELECT USING (true);
CREATE POLICY "Anyone can view trending posts" ON trending_posts FOR SELECT USING (true);
CREATE POLICY "Anyone can view trending users" ON trending_users FOR SELECT USING (true);

-- Only system can write to these tables (triggers and functions)
CREATE POLICY "Only system can modify hashtags" ON hashtags 
    USING (false) -- No direct modifications allowed
    WITH CHECK (false);

CREATE POLICY "Only system can modify post hashtags" ON post_hashtags 
    USING (false) -- No direct modifications allowed  
    WITH CHECK (false);

CREATE POLICY "Only system can modify trending posts" ON trending_posts 
    USING (false) -- No direct modifications allowed
    WITH CHECK (false);

CREATE POLICY "Only system can modify trending users" ON trending_users 
    USING (false) -- No direct modifications allowed
    WITH CHECK (false);

-- ============================================================================
-- INITIAL DATA AND OPTIMIZATION
-- ============================================================================

-- Process hashtags for existing posts (run once)
DO $$
DECLARE
    post_record RECORD;
    processed_count INTEGER := 0;
BEGIN
    -- Process hashtags for recent posts only to avoid timeout
    FOR post_record IN 
        SELECT id, content 
        FROM posts 
        WHERE created_at >= NOW() - INTERVAL '30 days'
        AND content IS NOT NULL
        ORDER BY created_at DESC
        LIMIT 1000
    LOOP
        PERFORM process_post_hashtags(post_record.id, post_record.content);
        processed_count := processed_count + 1;
        
        -- Commit every 100 posts to avoid long transactions
        IF processed_count % 100 = 0 THEN
            COMMIT;
        END IF;
    END LOOP;
    
    RAISE NOTICE 'Processed hashtags for % posts', processed_count;
END;
$$;

-- Initial trending score calculation
SELECT update_hashtag_trending_scores();
SELECT update_trending_posts();

-- ============================================================================
-- DATA MIGRATION AND SETUP (OPTIONAL)
-- ============================================================================

-- OPTION 1: Full data migration (processes existing posts)
-- Uncomment the block below if you want to process existing posts immediately

/*
DO $$
DECLARE
    post_record RECORD;
    processed_count INTEGER := 0;
    error_count INTEGER := 0;
    total_posts INTEGER;
BEGIN
    -- Get total count for progress tracking
    SELECT COUNT(*) INTO total_posts FROM posts WHERE content IS NOT NULL;
    
    RAISE NOTICE 'Starting hashtag processing for % existing posts...', total_posts;
    
    -- Process existing posts in batches
    FOR post_record IN 
        SELECT id, content 
        FROM posts 
        WHERE content IS NOT NULL 
          AND is_deleted = FALSE
        ORDER BY created_at DESC
        LIMIT 1000 -- Process first 1000 posts, adjust as needed
    LOOP
        BEGIN
            -- Safely process hashtags for this post
            PERFORM process_post_hashtags(post_record.id, post_record.content);
            processed_count := processed_count + 1;
            
            -- Log progress every 100 posts
            IF processed_count % 100 = 0 THEN
                RAISE NOTICE 'Processed % of % posts...', processed_count, total_posts;
            END IF;
            
        EXCEPTION WHEN OTHERS THEN
            error_count := error_count + 1;
            RAISE WARNING 'Error processing post %: %', post_record.id, SQLERRM;
            CONTINUE;
        END;
    END LOOP;
    
    RAISE NOTICE 'Hashtag processing completed: % posts processed, % errors', processed_count, error_count;
    
    -- Update trending scores after initial processing
    RAISE NOTICE 'Calculating initial trending scores...';
    PERFORM update_hashtag_trending_scores();
    
    RAISE NOTICE 'Initial hashtag and trending setup completed successfully!';
    
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Error during hashtag processing setup: %', SQLERRM;
    RAISE NOTICE 'You can manually run hashtag processing later with: SELECT process_post_hashtags(id, content) FROM posts WHERE content IS NOT NULL;';
END $$;
*/

-- OPTION 2: Minimal setup (recommended for production)
-- Just run basic setup without processing existing posts
DO $$
BEGIN
    RAISE NOTICE '🚀 Hashtag and trending system initialized successfully!';
    RAISE NOTICE '📝 New posts will automatically have hashtags processed.';
    RAISE NOTICE '🔧 To process existing posts later, run: SELECT process_post_hashtags(id, content) FROM posts WHERE content IS NOT NULL LIMIT 100;';
    RAISE NOTICE '📊 To update trending scores, run: SELECT update_hashtag_trending_scores();';
    RAISE NOTICE '🧹 For maintenance, run: SELECT run_trending_maintenance();';
END $$;

-- ============================================================================
-- CONSTRAINT FIXES (for existing installations)
-- ============================================================================

-- Ensure unique constraint exists on normalized_tag
-- This handles cases where the table might already exist without the constraint
DO $$
BEGIN
    -- Check if the unique constraint already exists
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        JOIN pg_namespace n ON t.relnamespace = n.oid
        WHERE n.nspname = 'public'
          AND t.relname = 'hashtags'
          AND c.conname = 'hashtags_normalized_tag_key'
    ) THEN
        -- Add unique constraint if it doesn't exist
        RAISE NOTICE 'Adding unique constraint on hashtags.normalized_tag...';
        ALTER TABLE hashtags ADD CONSTRAINT hashtags_normalized_tag_key UNIQUE (normalized_tag);
    ELSE
        RAISE NOTICE 'Unique constraint on hashtags.normalized_tag already exists.';
    END IF;
EXCEPTION
    WHEN duplicate_table THEN
        RAISE NOTICE 'Table hashtags does not exist yet, constraint will be created with table.';
    WHEN OTHERS THEN
        RAISE WARNING 'Could not add unique constraint: %', SQLERRM;
END $$;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE hashtags IS 'Tracks hashtag usage and trending metrics';
COMMENT ON TABLE post_hashtags IS 'Links posts to their hashtags';
COMMENT ON TABLE trending_posts IS 'Cached trending posts data for performance';
COMMENT ON TABLE trending_users IS 'Cached trending users data for performance';

COMMENT ON FUNCTION extract_hashtags_from_content(JSONB) IS 'Extracts hashtags from post content JSONB';
COMMENT ON FUNCTION calculate_hashtag_trending_score(INTEGER, INTEGER, INTEGER, DECIMAL) IS 'Calculates trending score for hashtags based on velocity, popularity and recency';
COMMENT ON FUNCTION update_hashtag_trending_scores() IS 'Updates trending scores and ranks for all hashtags';
COMMENT ON FUNCTION get_trending_hashtags(INTEGER) IS 'Returns trending hashtags with metrics'; 

COMMENT ON FUNCTION cleanup_inactive_hashtags() IS 'Removes hashtags with minimal usage that have been inactive for 90+ days, or any hashtag inactive for 6+ months (except very popular ones)';
COMMENT ON FUNCTION archive_popular_hashtags() IS 'Archives hashtags with significant historical usage before deletion to preserve data';
COMMENT ON FUNCTION cleanup_old_trending_data() IS 'Removes trending posts and users data older than 30 days';
COMMENT ON FUNCTION run_trending_maintenance() IS 'Comprehensive maintenance function that runs all cleanup and update operations';
COMMENT ON FUNCTION get_trending_maintenance_stats() IS 'Returns current statistics and recommendations for trending system maintenance';
COMMENT ON FUNCTION reset_daily_hashtag_counters() IS 'Resets daily usage counters for all hashtags (should be called daily)';
COMMENT ON FUNCTION reset_weekly_hashtag_counters() IS 'Resets weekly usage counters for all hashtags (should be called weekly)'; 

-- ============================================================================
-- MIGRATION VALIDATION TEST
-- ============================================================================

-- Test function to validate the migration worked correctly
CREATE OR REPLACE FUNCTION test_trending_system()
RETURNS JSON
LANGUAGE plpgsql
AS $$
DECLARE
    v_result JSON;
    v_test_post_id UUID;
    v_hashtag_count INTEGER;
    v_trending_count INTEGER;
    v_errors TEXT[] := ARRAY[]::TEXT[];
BEGIN
    RAISE NOTICE '🧪 Testing trending system functionality...';
    
    BEGIN
        -- Test 1: Hashtag extraction from simple content
        SELECT COUNT(*) INTO v_hashtag_count
        FROM unnest(extract_hashtags_from_content('["{"type": "text", "text": "Testing #harmony and #activitypub hashtags!"}"]'::jsonb));
        
        IF v_hashtag_count != 2 THEN
            v_errors := array_append(v_errors, 'Hashtag extraction failed: expected 2, got ' || v_hashtag_count);
        END IF;
        
    EXCEPTION WHEN OTHERS THEN
        v_errors := array_append(v_errors, 'Hashtag extraction test failed: ' || SQLERRM);
    END;
    
    BEGIN
        -- Test 2: Trending score calculation
        IF calculate_hashtag_trending_score(10, 20, 100, 1) <= 0 THEN
            v_errors := array_append(v_errors, 'Trending score calculation returned non-positive value');
        END IF;
        
    EXCEPTION WHEN OTHERS THEN
        v_errors := array_append(v_errors, 'Trending score calculation failed: ' || SQLERRM);
    END;
    
    BEGIN
        -- Test 3: Get trending hashtags (should not error even if empty)
        SELECT COUNT(*) INTO v_trending_count FROM get_trending_hashtags(5);
        
    EXCEPTION WHEN OTHERS THEN
        v_errors := array_append(v_errors, 'Get trending hashtags failed: ' || SQLERRM);
    END;
    
    -- Build result
    v_result := json_build_object(
        'test_completed_at', NOW(),
        'errors', v_errors,
        'tests_passed', array_length(v_errors, 1) IS NULL,
        'hashtag_extraction_count', v_hashtag_count,
        'trending_hashtags_available', v_trending_count,
        'status', CASE 
            WHEN array_length(v_errors, 1) IS NULL THEN 'success'
            ELSE 'failed'
        END
    );
    
    IF array_length(v_errors, 1) IS NULL THEN
        RAISE NOTICE '✅ All trending system tests passed successfully!';
    ELSE
        RAISE WARNING '❌ Some tests failed: %', array_to_string(v_errors, ', ');
    END IF;
    
    RETURN v_result;
END;
$$;

-- Run the test as part of migration
SELECT test_trending_system(); 