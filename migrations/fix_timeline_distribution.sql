-- Fix timeline distribution for proper home and federated timelines
-- This addresses the issues where:
-- 1. Home timeline only shows posts from authors, not from people you follow
-- 2. Federated posts aren't properly distributed to follower timelines

-- ===================================================================
-- 1. Enhanced Timeline Entry Creation Function
-- ===================================================================

-- Drop the old simple function and create a comprehensive one
DROP FUNCTION IF EXISTS create_simple_timeline_entries() CASCADE;

CREATE OR REPLACE FUNCTION create_comprehensive_timeline_entries() 
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    follower_record RECORD;
    recipient_count INTEGER := 0;
BEGIN
    -- Always add to author's own timeline first
    INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
    VALUES (NEW.author_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000)
    ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    
    -- For public posts, add to all followers' home timelines
    IF NEW.visibility = 'public' AND NOT COALESCE(NEW.is_deleted, false) THEN
        
        -- Add to home timelines of all followers
        FOR follower_record IN 
            SELECT f.follower_id 
            FROM follows f 
            WHERE f.following_id = NEW.author_id 
              AND f.status = 'accepted'
              AND f.follower_id != NEW.author_id  -- Don't duplicate author's own timeline
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (follower_record.follower_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
            
            recipient_count := recipient_count + 1;
        END LOOP;
        
        RAISE NOTICE 'Timeline: Added post % to % follower home timelines', NEW.id, recipient_count;
    END IF;
    
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION create_comprehensive_timeline_entries() IS 
'Creates timeline entries for posts: adds to author timeline and all followers home timelines for public posts';

-- ===================================================================
-- 2. Backfill Timeline Entries for Existing Posts
-- ===================================================================

CREATE OR REPLACE FUNCTION backfill_timeline_entries()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
    processed_count INTEGER := 0;
    post_record RECORD;
    follower_record RECORD;
BEGIN
    RAISE NOTICE 'Starting timeline backfill for existing posts...';
    
    -- Process all public posts that might be missing from follower timelines
    FOR post_record IN 
        SELECT id, author_id, created_at
        FROM posts 
        WHERE visibility = 'public' 
          AND NOT COALESCE(is_deleted, false)
          AND created_at > NOW() - INTERVAL '30 days'  -- Only last 30 days to avoid overwhelming
        ORDER BY created_at DESC
    LOOP
        -- Add to all current followers' home timelines
        FOR follower_record IN 
            SELECT f.follower_id 
            FROM follows f 
            WHERE f.following_id = post_record.author_id 
              AND f.status = 'accepted'
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (
                follower_record.follower_id, 
                post_record.id, 
                'home', 
                EXTRACT(epoch FROM post_record.created_at) * 1000000
            )
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        END LOOP;
        
        processed_count := processed_count + 1;
        
        -- Progress logging every 100 posts
        IF processed_count % 100 = 0 THEN
            RAISE NOTICE 'Processed % posts...', processed_count;
        END IF;
    END LOOP;
    
    RAISE NOTICE 'Timeline backfill completed. Processed % posts.', processed_count;
    RETURN processed_count;
END;
$$;

-- ===================================================================
-- 3. Enhanced Timeline Query Function
-- ===================================================================

-- Enhanced version that properly handles different timeline types
CREATE OR REPLACE FUNCTION get_enhanced_timeline_posts(
    p_user_id UUID, 
    p_timeline_type TEXT DEFAULT 'home',
    p_limit INTEGER DEFAULT 20, 
    p_max_id TEXT DEFAULT NULL
) 
RETURNS TABLE(
    id TEXT,
    created_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ,
    content JSONB,
    content_warning TEXT,
    language TEXT,
    author_id TEXT,
    ap_id TEXT,
    ap_type TEXT,
    url TEXT,
    reply_context JSONB,
    conversation_id TEXT,
    visibility TEXT,
    is_local BOOLEAN,
    is_federated BOOLEAN,
    replies_count INTEGER,
    reblogs_count INTEGER,
    favorites_count INTEGER,
    media_attachments JSONB,
    metadata JSONB,
    is_sensitive BOOLEAN,
    is_deleted BOOLEAN,
    deleted_at TIMESTAMPTZ,
    author JSONB,
    is_favorited BOOLEAN,
    is_reblogged BOOLEAN,
    is_bookmarked BOOLEAN,
    reblog JSONB,
    reblog_author JSONB
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
        CASE 
            -- HOME: Use timeline_entries for proper following logic
            WHEN p_timeline_type = 'home' THEN 
                EXISTS (
                    SELECT 1 FROM timeline_entries te 
                    WHERE te.user_id = p_user_id 
                      AND te.post_id = tp.id 
                      AND te.timeline_type = 'home'
                )
            
            -- LOCAL: Only public posts from local users
            WHEN p_timeline_type = 'local' THEN 
                tp.visibility = 'public' 
                AND (tp.author->>'is_local')::BOOLEAN = true
            
            -- PUBLIC/FEDERATED: All public posts (local + remote) - standard ActivityPub timeline
            WHEN p_timeline_type IN ('public', 'federated') THEN 
                tp.visibility = 'public'
                
            ELSE tp.visibility = 'public'
        END
        
        -- Pagination
        AND (p_max_id IS NULL OR tp.created_at < (
            SELECT tp2.created_at FROM timeline_posts tp2 WHERE tp2.id = p_max_id::UUID
        ))
    
    ORDER BY tp.created_at DESC
    LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION get_enhanced_timeline_posts(UUID, TEXT, INTEGER, TEXT) IS 
'Enhanced timeline function with proper home timeline support using timeline_entries and separate federated timeline';

-- ===================================================================
-- 4. Handle New Follows - Add Existing Posts to Timeline
-- ===================================================================

CREATE OR REPLACE FUNCTION add_existing_posts_to_new_follower_timeline()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    post_record RECORD;
    added_count INTEGER := 0;
BEGIN
    -- Only process accepted follows
    IF NEW.status = 'accepted' THEN
        -- Add recent public posts from the followed user to follower's home timeline
        FOR post_record IN 
            SELECT id, created_at
            FROM posts 
            WHERE author_id = NEW.following_id
              AND visibility = 'public'
              AND NOT COALESCE(is_deleted, false)
              AND created_at > NOW() - INTERVAL '7 days'  -- Only last 7 days for new follows
            ORDER BY created_at DESC
            LIMIT 50  -- Reasonable limit to avoid overwhelming
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (
                NEW.follower_id,
                post_record.id,
                'home',
                EXTRACT(epoch FROM post_record.created_at) * 1000000
            )
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
            
            added_count := added_count + 1;
        END LOOP;
        
        RAISE NOTICE 'Added % recent posts to new follower timeline', added_count;
    END IF;
    
    RETURN NEW;
END;
$$;

-- ===================================================================
-- 5. Apply New Triggers
-- ===================================================================

-- Drop old trigger and create new one
DROP TRIGGER IF EXISTS create_simple_timeline_entries_trigger ON posts;
DROP TRIGGER IF EXISTS create_comprehensive_timeline_entries_trigger ON posts;

CREATE TRIGGER create_comprehensive_timeline_entries_trigger
    AFTER INSERT ON posts
    FOR EACH ROW
    EXECUTE FUNCTION create_comprehensive_timeline_entries();

-- Add trigger for new follows
DROP TRIGGER IF EXISTS add_posts_to_new_follower_timeline ON follows;

CREATE TRIGGER add_posts_to_new_follower_timeline
    AFTER INSERT OR UPDATE ON follows
    FOR EACH ROW
    WHEN (NEW.status = 'accepted')
    EXECUTE FUNCTION add_existing_posts_to_new_follower_timeline();

-- ===================================================================
-- 6. Optimize Timeline Queries with Better Indexes
-- ===================================================================

-- Ensure we have proper indexes for timeline queries
CREATE INDEX IF NOT EXISTS idx_timeline_entries_user_home_position 
ON timeline_entries (user_id, timeline_type, position DESC) 
WHERE timeline_type = 'home';

CREATE INDEX IF NOT EXISTS idx_posts_public_created_at 
ON posts (created_at DESC) 
WHERE visibility = 'public' AND NOT COALESCE(is_deleted, false);

CREATE INDEX IF NOT EXISTS idx_posts_local_public_created_at 
ON posts (is_local, created_at DESC) 
WHERE visibility = 'public' AND NOT COALESCE(is_deleted, false);

-- ===================================================================
-- 7. Function to Check Timeline Health
-- ===================================================================

CREATE OR REPLACE FUNCTION check_timeline_health(p_user_id UUID)
RETURNS TABLE(
    timeline_type TEXT,
    total_entries INTEGER,
    recent_entries INTEGER,
    following_count INTEGER,
    recommendations TEXT
)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    WITH timeline_stats AS (
        SELECT 
            'home' as timeline_type,
            COUNT(*)::INTEGER as total_entries,
            COUNT(*) FILTER (WHERE te.created_at > NOW() - INTERVAL '7 days')::INTEGER as recent_entries
        FROM timeline_entries te
        WHERE te.user_id = p_user_id AND te.timeline_type = 'home'
    ),
    follow_stats AS (
        SELECT COUNT(*)::INTEGER as following_count
        FROM follows f
        WHERE f.follower_id = p_user_id AND f.status = 'accepted'
    )
    SELECT 
        ts.timeline_type,
        ts.total_entries,
        ts.recent_entries,
        fs.following_count,
        CASE 
            WHEN ts.total_entries = 0 THEN 'No timeline entries found - run backfill'
            WHEN ts.recent_entries < fs.following_count / 2 THEN 'Low recent activity - check if followed users are posting'
            ELSE 'Timeline looks healthy'
        END as recommendations
    FROM timeline_stats ts, follow_stats fs;
END;
$$;

COMMENT ON FUNCTION check_timeline_health(UUID) IS 
'Checks the health of a users timeline and provides recommendations';

-- Run the backfill function to fix existing data
-- Note: Comment out in production if you want to run this manually
-- SELECT backfill_timeline_entries();

COMMIT;
