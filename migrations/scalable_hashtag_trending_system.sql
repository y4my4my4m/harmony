-- Scalable Hashtag Trending System
-- Description: Professional implementation that scales to millions of users
-- Uses batch processing, smart triggers, and async updates

-- ============================================================================
-- REMOVE IMMEDIATE TRENDING CALCULATIONS
-- ============================================================================

-- Update the hashtag processing function to NOT calculate trending immediately
CREATE OR REPLACE FUNCTION process_post_hashtags_secure(p_post_id UUID, p_content JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_hashtag_array TEXT[];
    v_hashtag_text TEXT;
    v_hashtag_id UUID;
    v_position_counter INTEGER := 0;
    v_processed_count INTEGER := 0;
    v_normalized TEXT;
BEGIN
    -- Verify the post exists and user has permission
    IF NOT EXISTS (
        SELECT 1 FROM posts 
        WHERE id = p_post_id 
        AND (author_id = auth.uid() OR auth.uid() IS NULL)
    ) THEN
        RAISE EXCEPTION 'Permission denied or post not found';
    END IF;

    -- Extract hashtags from content
    v_hashtag_array := extract_hashtags_from_content(p_content);
    
    -- Process each hashtag
    FOREACH v_hashtag_text IN ARRAY v_hashtag_array LOOP
        v_position_counter := v_position_counter + 1;
        v_normalized := normalize_hashtag(v_hashtag_text);
        
        -- Upsert hashtag with basic counters only (NO trending calculation)
        INSERT INTO hashtags (tag, normalized_tag, total_uses, daily_uses, weekly_uses, last_used_at)
        VALUES (v_hashtag_text, v_normalized, 1, 1, 1, NOW())
        ON CONFLICT (normalized_tag) 
        DO UPDATE SET
            total_uses = hashtags.total_uses + 1,
            daily_uses = hashtags.daily_uses + 1,
            weekly_uses = hashtags.weekly_uses + 1,
            last_used_at = NOW(),
            updated_at = NOW()
        RETURNING id INTO v_hashtag_id;
        
        -- Link post to hashtag
        INSERT INTO post_hashtags (post_id, hashtag_id, position_in_content)
        VALUES (p_post_id, v_hashtag_id, v_position_counter)
        ON CONFLICT (post_id, hashtag_id) DO NOTHING;
        
        v_processed_count := v_processed_count + 1;
    END LOOP;
    
    -- Mark that trending data needs to be refreshed (async)
    -- Only if we processed hashtags and haven't marked recently
    IF v_processed_count > 0 THEN
        INSERT INTO trending_refresh_queue (refresh_type, priority, created_at)
        VALUES ('hashtags', 'normal', NOW())
        ON CONFLICT (refresh_type) 
        DO UPDATE SET 
            updated_at = NOW(),
            priority = CASE 
                WHEN trending_refresh_queue.updated_at < NOW() - INTERVAL '5 minutes' THEN 'high'
                ELSE trending_refresh_queue.priority
            END;
    END IF;
    
    RETURN v_processed_count;
END;
$$;

-- ============================================================================
-- TRENDING REFRESH QUEUE SYSTEM
-- ============================================================================

-- Create a queue for trending calculations
CREATE TABLE IF NOT EXISTS trending_refresh_queue (
    refresh_type TEXT PRIMARY KEY, -- 'hashtags', 'posts', 'users'
    priority TEXT DEFAULT 'normal', -- 'low', 'normal', 'high'
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    last_processed_at TIMESTAMPTZ,
    processing_started_at TIMESTAMPTZ,
    is_processing BOOLEAN DEFAULT false
);

-- Add indexes for the queue
CREATE INDEX IF NOT EXISTS idx_trending_refresh_priority ON trending_refresh_queue(priority, updated_at);

-- ============================================================================
-- SMART TRENDING CALCULATION FUNCTIONS
-- ============================================================================

-- Efficient trending calculation that only processes recently active hashtags
CREATE OR REPLACE FUNCTION update_hashtag_trending_scores_efficient()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    updated_count INTEGER := 0;
    batch_size INTEGER := 1000;
    processing_start TIMESTAMPTZ := NOW();
BEGIN
    -- Mark processing as started
    UPDATE trending_refresh_queue 
    SET is_processing = true, processing_started_at = processing_start
    WHERE refresh_type = 'hashtags';
    
    -- Only update hashtags that have been used recently or have significant activity
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
    WHERE (
        -- Recently used hashtags
        last_used_at >= NOW() - INTERVAL '24 hours'
        -- Or hashtags with significant daily activity
        OR daily_uses >= 5
        -- Or hashtags currently trending that need refresh
        OR trending_rank IS NOT NULL
    );
    
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    
    -- Update trending ranks efficiently
    WITH ranked_hashtags AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY trending_score DESC) as rank_num
        FROM hashtags 
        WHERE trending_score > 0
        ORDER BY trending_score DESC
        LIMIT 100
    )
    UPDATE hashtags 
    SET trending_rank = rh.rank_num
    FROM ranked_hashtags rh
    WHERE hashtags.id = rh.id;
    
    -- Clear ranks for non-trending hashtags (batch operation)
    UPDATE hashtags 
    SET trending_rank = NULL
    WHERE trending_score <= 0 OR id NOT IN (
        SELECT id FROM hashtags 
        WHERE trending_score > 0 
        ORDER BY trending_score DESC 
        LIMIT 100
    );
    
    -- Mark processing as complete
    UPDATE trending_refresh_queue 
    SET 
        is_processing = false, 
        last_processed_at = NOW(),
        processing_started_at = NULL
    WHERE refresh_type = 'hashtags';
    
    RAISE NOTICE 'Efficiently updated trending scores for % hashtags in %ms', 
        updated_count, 
        EXTRACT(EPOCH FROM (NOW() - processing_start)) * 1000;
    
    RETURN updated_count;
END;
$$;

-- ============================================================================
-- BATCH PROCESSING FOR DAILY/WEEKLY RESETS
-- ============================================================================

-- Reset daily counts (run daily via cron)
CREATE OR REPLACE FUNCTION reset_daily_hashtag_counts()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    reset_count INTEGER := 0;
BEGIN
    -- Reset daily counts and update peaks
    UPDATE hashtags 
    SET 
        daily_uses = 0,
        peak_daily_uses = GREATEST(peak_daily_uses, daily_uses),
        peak_daily_date = CASE 
            WHEN daily_uses > peak_daily_uses THEN CURRENT_DATE - 1
            ELSE peak_daily_date
        END,
        updated_at = NOW()
    WHERE daily_uses > 0;
    
    GET DIAGNOSTICS reset_count = ROW_COUNT;
    
    -- Queue trending recalculation
    INSERT INTO trending_refresh_queue (refresh_type, priority)
    VALUES ('hashtags', 'high')
    ON CONFLICT (refresh_type) 
    DO UPDATE SET priority = 'high', updated_at = NOW();
    
    RAISE NOTICE 'Reset daily counts for % hashtags', reset_count;
    RETURN reset_count;
END;
$$;

-- Reset weekly counts (run weekly via cron)
CREATE OR REPLACE FUNCTION reset_weekly_hashtag_counts()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    reset_count INTEGER := 0;
BEGIN
    UPDATE hashtags 
    SET weekly_uses = 0, updated_at = NOW()
    WHERE weekly_uses > 0;
    
    GET DIAGNOSTICS reset_count = ROW_COUNT;
    
    -- Queue trending recalculation
    INSERT INTO trending_refresh_queue (refresh_type, priority)
    VALUES ('hashtags', 'high')
    ON CONFLICT (refresh_type) 
    DO UPDATE SET priority = 'high', updated_at = NOW();
    
    RAISE NOTICE 'Reset weekly counts for % hashtags', reset_count;
    RETURN reset_count;
END;
$$;

-- ============================================================================
-- ASYNC PROCESSING FUNCTIONS
-- ============================================================================

-- Process trending queue (called by background workers)
CREATE OR REPLACE FUNCTION process_trending_queue()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    queue_item RECORD;
    processed_count INTEGER := 0;
BEGIN
    -- Process high priority items first
    FOR queue_item IN 
        SELECT * FROM trending_refresh_queue 
        WHERE NOT is_processing 
        AND (processing_started_at IS NULL OR processing_started_at < NOW() - INTERVAL '10 minutes')
        ORDER BY 
            CASE priority 
                WHEN 'high' THEN 1 
                WHEN 'normal' THEN 2 
                ELSE 3 
            END,
            updated_at ASC
        LIMIT 3 -- Process max 3 items per run
    LOOP
        CASE queue_item.refresh_type
            WHEN 'hashtags' THEN
                PERFORM update_hashtag_trending_scores_efficient();
            WHEN 'posts' THEN
                PERFORM update_trending_posts();
            WHEN 'users' THEN
                PERFORM update_trending_users();
        END CASE;
        
        processed_count := processed_count + 1;
    END LOOP;
    
    RETURN processed_count;
END;
$$;

-- ============================================================================
-- MANUAL TRIGGER FOR IMMEDIATE UPDATES
-- ============================================================================

-- For cases where we need immediate trending updates (admin panel, etc.)
CREATE OR REPLACE FUNCTION trigger_trending_update_now()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Only allow if user is admin or system
    IF NOT EXISTS (
        SELECT 1 FROM profiles 
        WHERE id = auth.uid() 
        AND (is_admin = true OR username = 'system')
    ) THEN
        RAISE EXCEPTION 'Insufficient privileges';
    END IF;
    
    RETURN update_hashtag_trending_scores_efficient();
END;
$$;

-- ============================================================================
-- CLEANUP AND OPTIMIZATION
-- ============================================================================

-- Clean up old queue items
CREATE OR REPLACE FUNCTION cleanup_trending_queue()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    cleaned_count INTEGER := 0;
BEGIN
    -- Reset stuck processing items
    UPDATE trending_refresh_queue 
    SET 
        is_processing = false,
        processing_started_at = NULL
    WHERE is_processing = true 
    AND processing_started_at < NOW() - INTERVAL '30 minutes';
    
    GET DIAGNOSTICS cleaned_count = ROW_COUNT;
    
    RETURN cleaned_count;
END;
$$;

-- ============================================================================
-- GRANTS AND PERMISSIONS
-- ============================================================================

-- Grant necessary permissions
GRANT EXECUTE ON FUNCTION process_trending_queue() TO authenticated;
GRANT EXECUTE ON FUNCTION update_hashtag_trending_scores_efficient() TO authenticated;
GRANT EXECUTE ON FUNCTION trigger_trending_update_now() TO authenticated;

-- ============================================================================
-- INITIAL SETUP
-- ============================================================================

-- Add the queue table and trigger an initial calculation
INSERT INTO trending_refresh_queue (refresh_type, priority)
VALUES ('hashtags', 'high')
ON CONFLICT (refresh_type) DO NOTHING;

-- Run the efficient update once to get current hashtags trending
SELECT update_hashtag_trending_scores_efficient();

-- ============================================================================
-- USAGE NOTES
-- ============================================================================

/*
PRODUCTION USAGE:

1. Set up cron jobs:
   - Every 15-30 minutes: SELECT process_trending_queue();
   - Daily at midnight: SELECT reset_daily_hashtag_counts();
   - Weekly on Sunday: SELECT reset_weekly_hashtag_counts();
   - Daily: SELECT cleanup_trending_queue();

2. For immediate updates (admin panel):
   - SELECT trigger_trending_update_now();

3. Monitor queue status:
   - SELECT * FROM trending_refresh_queue;

4. This system scales because:
   - Only processes recently active hashtags
   - Batch operations instead of per-hashtag calculations
   - Async processing doesn't block user interactions
   - Smart queuing prevents duplicate work
   - Configurable priority system
*/
