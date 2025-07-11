-- =============================================
-- Comprehensive ActivityPub System
-- Professional social counters + conversation threading + missing columns
-- Single migration to avoid cross-dependencies
-- =============================================

-- Step 1: Add missing columns to posts table
ALTER TABLE posts 
ADD COLUMN IF NOT EXISTS conversation_root_id UUID,
ADD COLUMN IF NOT EXISTS is_favorited BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS is_reblogged BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS is_bookmarked BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS reblog JSONB,
ADD COLUMN IF NOT EXISTS reblog_author JSONB;

-- Step 2: Add social counter columns to profiles table
ALTER TABLE profiles 
ADD COLUMN IF NOT EXISTS followers_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS following_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS posts_count INTEGER DEFAULT 0;

-- Step 3: Create indexes for performance
-- Conversation indexes
CREATE INDEX IF NOT EXISTS idx_posts_conversation_root_id 
ON posts (conversation_root_id);

CREATE INDEX IF NOT EXISTS idx_posts_conversation_performance 
ON posts (conversation_root_id, created_at) 
WHERE conversation_root_id IS NOT NULL;

-- Social counter indexes
CREATE INDEX IF NOT EXISTS idx_follows_follower_count ON follows (following_id) 
WHERE status = 'accepted';

CREATE INDEX IF NOT EXISTS idx_follows_following_count ON follows (follower_id) 
WHERE status = 'accepted';

CREATE INDEX IF NOT EXISTS idx_posts_author_count ON posts (author_id) 
WHERE deleted_at IS NULL;

-- Step 4: Initialize conversation_root_id for existing posts
DO $$
DECLARE
    post_record RECORD;
    root_id UUID;
BEGIN
    -- Process all posts that don't have conversation_root_id set
    FOR post_record IN 
        SELECT id, in_reply_to 
        FROM posts 
        WHERE conversation_root_id IS NULL
        ORDER BY created_at ASC
    LOOP
        IF post_record.in_reply_to IS NULL THEN
            -- This is a root post, conversation_root_id = post_id
            UPDATE posts 
            SET conversation_root_id = post_record.id 
            WHERE id = post_record.id;
            
            RAISE NOTICE 'Set root post % conversation_root_id to %', post_record.id, post_record.id;
        ELSE
            -- This is a reply, find its conversation_root_id from parent
            WITH RECURSIVE find_root AS (
                -- Base case: start with the reply
                SELECT id, in_reply_to, id as original_id, 0 as depth
                FROM posts 
                WHERE id = post_record.in_reply_to
                
                UNION ALL
                
                -- Recursive case: traverse up to parent posts
                SELECT p.id, p.in_reply_to, fr.original_id, fr.depth + 1
                FROM posts p
                INNER JOIN find_root fr ON p.id = fr.in_reply_to
                WHERE fr.depth < 50 -- Prevent infinite recursion
            )
            SELECT COALESCE(
                (SELECT id FROM find_root WHERE in_reply_to IS NULL ORDER BY depth DESC LIMIT 1),
                post_record.in_reply_to
            ) INTO root_id;
            
            -- Set conversation_root_id to the root post ID (UUID)
            UPDATE posts 
            SET conversation_root_id = root_id 
            WHERE id = post_record.id;
            
            RAISE NOTICE 'Set reply post % conversation_root_id to %', post_record.id, root_id;
        END IF;
    END LOOP;
END $$;

-- Step 5: Initialize social counters for existing data
UPDATE profiles SET 
    followers_count = (
        SELECT COUNT(*) 
        FROM follows 
        WHERE following_id = profiles.id 
        AND status = 'accepted'
    ),
    following_count = (
        SELECT COUNT(*) 
        FROM follows 
        WHERE follower_id = profiles.id 
        AND status = 'accepted'
    ),
    posts_count = (
        SELECT COUNT(*) 
        FROM posts 
        WHERE author_id = profiles.id 
        AND deleted_at IS NULL
    );

-- Step 6: Create trigger functions

-- Function to automatically set conversation_root_id for new posts
CREATE OR REPLACE FUNCTION set_activitypub_conversation_root_id()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.in_reply_to IS NULL THEN
        -- Root post: conversation_root_id = post_id
        NEW.conversation_root_id = NEW.id;
    ELSE
        -- Reply: get conversation_root_id from parent post
        SELECT conversation_root_id INTO NEW.conversation_root_id
        FROM posts 
        WHERE id = NEW.in_reply_to;
        
        -- Fallback: if parent doesn't have conversation_root_id, set to parent's id
        IF NEW.conversation_root_id IS NULL THEN
            NEW.conversation_root_id = NEW.in_reply_to;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Function to update follower/following counts
CREATE OR REPLACE FUNCTION update_follow_counters()
RETURNS TRIGGER AS $$
BEGIN
    -- Handle different trigger events
    IF TG_OP = 'INSERT' THEN
        -- New follow relationship
        IF NEW.status = 'accepted' THEN
            -- Increment follower count for the followed user
            UPDATE profiles 
            SET followers_count = followers_count + 1 
            WHERE id = NEW.following_id;
            
            -- Increment following count for the follower
            UPDATE profiles 
            SET following_count = following_count + 1 
            WHERE id = NEW.follower_id;
        END IF;
        RETURN NEW;
        
    ELSIF TG_OP = 'UPDATE' THEN
        -- Follow status changed
        IF OLD.status != NEW.status THEN
            IF OLD.status = 'accepted' AND NEW.status != 'accepted' THEN
                -- Follow was accepted, now it's not (unfriend/reject)
                UPDATE profiles 
                SET followers_count = followers_count - 1 
                WHERE id = NEW.following_id;
                
                UPDATE profiles 
                SET following_count = following_count - 1 
                WHERE id = NEW.follower_id;
                
            ELSIF OLD.status != 'accepted' AND NEW.status = 'accepted' THEN
                -- Follow was not accepted, now it is
                UPDATE profiles 
                SET followers_count = followers_count + 1 
                WHERE id = NEW.following_id;
                
                UPDATE profiles 
                SET following_count = following_count + 1 
                WHERE id = NEW.follower_id;
            END IF;
        END IF;
        RETURN NEW;
        
    ELSIF TG_OP = 'DELETE' THEN
        -- Follow relationship deleted
        IF OLD.status = 'accepted' THEN
            UPDATE profiles 
            SET followers_count = followers_count - 1 
            WHERE id = OLD.following_id;
            
            UPDATE profiles 
            SET following_count = following_count - 1 
            WHERE id = OLD.follower_id;
        END IF;
        RETURN OLD;
    END IF;
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Function to update post counts
CREATE OR REPLACE FUNCTION update_post_counters()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- New post created
        UPDATE profiles 
        SET posts_count = posts_count + 1 
        WHERE id = NEW.author_id;
        RETURN NEW;
        
    ELSIF TG_OP = 'UPDATE' THEN
        -- Post updated (might be soft delete)
        IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
            -- Post was soft deleted
            UPDATE profiles 
            SET posts_count = posts_count - 1 
            WHERE id = NEW.author_id;
        ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
            -- Post was restored
            UPDATE profiles 
            SET posts_count = posts_count + 1 
            WHERE id = NEW.author_id;
        END IF;
        RETURN NEW;
        
    ELSIF TG_OP = 'DELETE' THEN
        -- Post hard deleted
        IF OLD.deleted_at IS NULL THEN
            UPDATE profiles 
            SET posts_count = posts_count - 1 
            WHERE id = OLD.author_id;
        END IF;
        RETURN OLD;
    END IF;
    
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Step 7: Create triggers
DROP TRIGGER IF EXISTS trigger_set_activitypub_conversation_root_id ON posts;
CREATE TRIGGER trigger_set_activitypub_conversation_root_id
    BEFORE INSERT ON posts
    FOR EACH ROW
    EXECUTE FUNCTION set_activitypub_conversation_root_id();

DROP TRIGGER IF EXISTS trigger_update_follow_counters ON follows;
CREATE TRIGGER trigger_update_follow_counters
    AFTER INSERT OR UPDATE OR DELETE ON follows
    FOR EACH ROW
    EXECUTE FUNCTION update_follow_counters();

DROP TRIGGER IF EXISTS trigger_update_post_counters ON posts;
CREATE TRIGGER trigger_update_post_counters
    AFTER INSERT OR UPDATE OR DELETE ON posts
    FOR EACH ROW
    EXECUTE FUNCTION update_post_counters();

-- Step 8: Create professional ActivityPub conversation functions
CREATE OR REPLACE FUNCTION get_activitypub_conversation_root(post_id UUID)
RETURNS TABLE(root_id UUID)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- O(1) lookup using conversation_root_id
    RETURN QUERY
    SELECT tp.conversation_root_id as root_id
    FROM timeline_posts tp
    WHERE tp.id = post_id;
END;
$$;

CREATE OR REPLACE FUNCTION get_activitypub_conversation_thread(conversation_root_id UUID)
RETURNS TABLE(
    id UUID,
    content TEXT,
    created_at TIMESTAMPTZ,
    author JSONB,
    visibility TEXT,
    favorites_count INTEGER,
    reblogs_count INTEGER,
    replies_count INTEGER,
    is_favorited BOOLEAN,
    is_reblogged BOOLEAN,
    is_bookmarked BOOLEAN,
    media_attachments JSONB,
    reply_context JSONB,
    content_warning TEXT,
    is_sensitive BOOLEAN,
    reblog JSONB,
    reblog_author JSONB,
    url TEXT,
    thread_depth INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- O(log n) lookup with simple ordering
    RETURN QUERY
    WITH conversation_posts AS (
        SELECT 
            tp.id,
            tp.content::text,
            tp.created_at,
            tp.author,
            tp.visibility,
            tp.favorites_count,
            tp.reblogs_count,
            tp.replies_count,
            tp.is_favorited,
            tp.is_reblogged,
            tp.is_bookmarked,
            tp.media_attachments,
            tp.reply_context,
            tp.content_warning,
            tp.is_sensitive,
            tp.reblog,
            tp.reblog_author,
            tp.url,
            -- Calculate thread depth - simplified for now
            CASE 
                WHEN tp.reply_context IS NULL THEN 0
                ELSE 1
            END as calculated_depth
        FROM timeline_posts tp
        WHERE tp.conversation_root_id = get_activitypub_conversation_thread.conversation_root_id
    )
    SELECT 
        cp.id,
        cp.content,
        cp.created_at,
        cp.author,
        cp.visibility,
        cp.favorites_count,
        cp.reblogs_count,
        cp.replies_count,
        cp.is_favorited,
        cp.is_reblogged,
        cp.is_bookmarked,
        cp.media_attachments,
        cp.reply_context,
        cp.content_warning,
        cp.is_sensitive,
        cp.reblog,
        cp.reblog_author,
        cp.url,
        cp.calculated_depth
    FROM conversation_posts cp
    ORDER BY 
        cp.calculated_depth ASC,
        cp.created_at ASC;
END;
$$;

CREATE OR REPLACE FUNCTION get_activitypub_conversation_context(post_id UUID)
RETURNS TABLE(
    conversation_root_id UUID,
    total_posts INTEGER,
    participant_count INTEGER,
    created_at TIMESTAMPTZ,
    last_activity TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    conv_root_id UUID;
BEGIN
    -- Get conversation_root_id for the post
    SELECT tp.conversation_root_id INTO conv_root_id
    FROM timeline_posts tp
    WHERE tp.id = post_id;
    
    -- Get conversation statistics
    RETURN QUERY
    SELECT 
        conv_root_id as conversation_root_id,
        COUNT(*)::INTEGER as total_posts,
        COUNT(DISTINCT tp.author->>'id')::INTEGER as participant_count,
        MIN(tp.created_at) as created_at,
        MAX(tp.created_at) as last_activity
    FROM timeline_posts tp
    WHERE tp.conversation_root_id = conv_root_id;
END;
$$;

-- Function for background reconciliation
CREATE OR REPLACE FUNCTION reconcile_social_counters(
    p_profile_id UUID DEFAULT NULL
)
RETURNS TABLE(
    profile_id UUID,
    old_followers_count INTEGER,
    new_followers_count INTEGER,
    old_following_count INTEGER,
    new_following_count INTEGER,
    old_posts_count INTEGER,
    new_posts_count INTEGER,
    was_corrected BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
    profile_record RECORD;
    actual_followers INTEGER;
    actual_following INTEGER;
    actual_posts INTEGER;
    correction_made BOOLEAN := FALSE;
BEGIN
    -- If specific profile provided, only check that one
    FOR profile_record IN 
        SELECT p.id, p.followers_count, p.following_count, p.posts_count
        FROM profiles p
        WHERE (p_profile_id IS NULL OR p.id = p_profile_id)
    LOOP
        -- Calculate actual counts
        SELECT COUNT(*) INTO actual_followers
        FROM follows 
        WHERE following_id = profile_record.id 
        AND status = 'accepted';
        
        SELECT COUNT(*) INTO actual_following
        FROM follows 
        WHERE follower_id = profile_record.id 
        AND status = 'accepted';
        
        SELECT COUNT(*) INTO actual_posts
        FROM posts 
        WHERE author_id = profile_record.id 
        AND deleted_at IS NULL;
        
        -- Check if correction needed
        correction_made := (
            profile_record.followers_count != actual_followers OR
            profile_record.following_count != actual_following OR
            profile_record.posts_count != actual_posts
        );
        
        -- Update if needed
        IF correction_made THEN
            UPDATE profiles SET
                followers_count = actual_followers,
                following_count = actual_following,
                posts_count = actual_posts
            WHERE id = profile_record.id;
        END IF;
        
        -- Return the results
        RETURN QUERY SELECT
            profile_record.id as profile_id,
            profile_record.followers_count as old_followers_count,
            actual_followers as new_followers_count,
            profile_record.following_count as old_following_count,
            actual_following as new_following_count,
            profile_record.posts_count as old_posts_count,
            actual_posts as new_posts_count,
            correction_made as was_corrected;
    END LOOP;
END;
$$;

-- Step 9: Create comprehensive timeline_posts view
DROP VIEW IF EXISTS timeline_posts CASCADE;
CREATE VIEW timeline_posts AS
SELECT 
    p.id,
    p.content,
    p.created_at,
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

-- Step 10: Grant permissions
GRANT EXECUTE ON FUNCTION get_activitypub_conversation_root(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_activitypub_conversation_thread(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION get_activitypub_conversation_context(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION reconcile_social_counters(UUID) TO authenticated;

-- Drop old functions if they exist
DROP FUNCTION IF EXISTS find_conversation_root(TEXT);
DROP FUNCTION IF EXISTS get_conversation_thread(TEXT);
DROP FUNCTION IF EXISTS get_conversation_context(TEXT);
DROP FUNCTION IF EXISTS get_conversation_root_fast(TEXT);
DROP FUNCTION IF EXISTS get_conversation_thread_fast(TEXT);
DROP FUNCTION IF EXISTS get_conversation_context_fast(TEXT);

-- Comments
COMMENT ON COLUMN posts.conversation_root_id IS 'UUID of the root post in this ActivityPub conversation thread. Enables O(1) conversation lookups.';
COMMENT ON COLUMN posts.is_favorited IS 'Whether the current user has favorited this post';
COMMENT ON COLUMN posts.is_reblogged IS 'Whether the current user has reblogged this post';
COMMENT ON COLUMN posts.is_bookmarked IS 'Whether the current user has bookmarked this post';
COMMENT ON COLUMN profiles.followers_count IS 'Denormalized count of followers for O(1) lookups. Maintained by triggers.';
COMMENT ON COLUMN profiles.following_count IS 'Denormalized count of following for O(1) lookups. Maintained by triggers.';
COMMENT ON COLUMN profiles.posts_count IS 'Denormalized count of posts for O(1) lookups. Maintained by triggers.';

-- Success message
DO $$ 
BEGIN 
    RAISE NOTICE '✅ Comprehensive ActivityPub system implemented successfully!';
    RAISE NOTICE '🚀 Social counters: O(1) with real-time triggers';
    RAISE NOTICE '🧵 Conversations: O(1) root lookups + O(log n) threading';
    RAISE NOTICE '📊 Timeline: Rich JSONB data with all features';
    RAISE NOTICE '🔧 Reconciliation: Use reconcile_social_counters() for cleanup';
    RAISE NOTICE '💬 Separate from DM conversations - no conflicts!';
END $$; 