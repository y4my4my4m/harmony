-- Fix Timeline Triggers for Federated Posts
-- Issues:
-- 1. Federated posts not in home timeline (trigger works for local but not remote authors)
-- 2. No public timeline entries being created
-- 3. Following doesn't backfill
-- 4. Unfollowing doesn't remove posts

-- ============================================================================
-- FIX 1: Update create_comprehensive_timeline_entries to handle ALL posts
-- ============================================================================

CREATE OR REPLACE FUNCTION public.create_comprehensive_timeline_entries() 
RETURNS trigger
LANGUAGE plpgsql 
SECURITY DEFINER
AS $$
DECLARE
    follower_record RECORD;
    local_user_record RECORD;
    recipient_count INTEGER := 0;
    public_count INTEGER := 0;
BEGIN
    -- Skip deleted posts
    IF COALESCE(NEW.is_deleted, false) THEN
        RETURN NEW;
    END IF;
    
    -- Add to author's own home timeline (local authors only)
    IF NEW.is_local THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        VALUES (NEW.author_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000)
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END IF;
    
    -- Add to followers' home timelines (for all posts - local and federated)
    IF NEW.visibility IN ('public', 'unlisted') THEN
        FOR follower_record IN 
            SELECT f.follower_id 
            FROM follows f 
            JOIN profiles p ON f.follower_id = p.id
            WHERE f.following_id = NEW.author_id 
              AND f.status = 'accepted'
              AND p.is_local = true  -- Only add to local users' timelines
              AND f.follower_id != NEW.author_id
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (follower_record.follower_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
            
            recipient_count := recipient_count + 1;
        END LOOP;
    END IF;
    
    -- Add to ALL local users' public timeline (for public posts only)
    IF NEW.visibility = 'public' THEN
        FOR local_user_record IN
            SELECT id FROM profiles WHERE is_local = true
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (local_user_record.id, NEW.id, 'public', EXTRACT(epoch FROM NEW.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
            
            public_count := public_count + 1;
        END LOOP;
    END IF;
    
    RAISE NOTICE 'Timeline: Post % added to % home timelines, % public timelines', NEW.id, recipient_count, public_count;
    
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.create_comprehensive_timeline_entries() IS 
'Creates timeline entries for both local and federated posts. Adds to followers home timelines and all users public timelines.';

-- ============================================================================
-- FIX 2: Backfill timeline when following someone
-- ============================================================================

CREATE OR REPLACE FUNCTION public.backfill_timeline_on_follow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    post_record RECORD;
    added_count INTEGER := 0;
BEGIN
    -- Only backfill when follow is accepted
    IF NEW.status != 'accepted' THEN
        RETURN NEW;
    END IF;
    
    -- Only backfill for local followers
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = NEW.follower_id AND is_local = true) THEN
        RETURN NEW;
    END IF;
    
    RAISE NOTICE 'Backfilling timeline for follow: % -> %', NEW.follower_id, NEW.following_id;
    
    -- Add recent posts from followed user to follower's home timeline
    -- Get last 20 public/unlisted posts
    FOR post_record IN
        SELECT id, created_at
        FROM posts
        WHERE author_id = NEW.following_id
          AND visibility IN ('public', 'unlisted')
          AND NOT COALESCE(is_deleted, false)
        ORDER BY created_at DESC
        LIMIT 20
    LOOP
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        VALUES (NEW.follower_id, post_record.id, 'home', EXTRACT(epoch FROM post_record.created_at) * 1000000)
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        
        added_count := added_count + 1;
    END LOOP;
    
    RAISE NOTICE 'Backfilled % posts into home timeline', added_count;
    
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.backfill_timeline_on_follow() IS
'Backfills home timeline with recent posts when accepting a follow';

-- ============================================================================
-- FIX 3: Remove posts from timeline when unfollowing
-- ============================================================================

CREATE OR REPLACE FUNCTION public.remove_timeline_on_unfollow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    removed_count INTEGER;
BEGIN
    -- Remove all posts from unfollowed user from the follower's home timeline
    WITH deleted AS (
        DELETE FROM timeline_entries
        WHERE user_id = OLD.follower_id
          AND timeline_type = 'home'
          AND post_id IN (
              SELECT id FROM posts WHERE author_id = OLD.following_id
          )
        RETURNING *
    )
    SELECT COUNT(*) INTO removed_count FROM deleted;
    
    RAISE NOTICE 'Removed % posts from home timeline on unfollow', removed_count;
    
    RETURN OLD;
END;
$$;

COMMENT ON FUNCTION public.remove_timeline_on_unfollow() IS
'Removes posts from home timeline when unfollowing a user';

-- ============================================================================
-- Apply Triggers
-- ============================================================================

-- Drop existing triggers if they exist
DROP TRIGGER IF EXISTS backfill_timeline_on_follow_trigger ON follows;
DROP TRIGGER IF EXISTS remove_timeline_on_unfollow_trigger ON follows;

-- Create backfill trigger (on INSERT or UPDATE to accepted)
CREATE TRIGGER backfill_timeline_on_follow_trigger
    AFTER INSERT OR UPDATE OF status ON follows
    FOR EACH ROW
    WHEN (NEW.status = 'accepted')
    EXECUTE FUNCTION backfill_timeline_on_follow();

-- Create removal trigger (on DELETE)
CREATE TRIGGER remove_timeline_on_unfollow_trigger
    BEFORE DELETE ON follows
    FOR EACH ROW
    EXECUTE FUNCTION remove_timeline_on_unfollow();

-- ============================================================================
-- Fix existing data (one-time)
-- ============================================================================

-- Backfill missing home timeline entries for existing follows
-- (This is a one-time fix for existing data)
WITH follower_posts AS (
    SELECT 
        f.follower_id,
        p.id as post_id,
        p.created_at,
        ROW_NUMBER() OVER (PARTITION BY f.follower_id, p.author_id ORDER BY p.created_at DESC) as rn
    FROM follows f
    JOIN profiles follower ON f.follower_id = follower.id
    JOIN posts p ON p.author_id = f.following_id
    WHERE f.status = 'accepted'
      AND follower.is_local = true
      AND p.visibility IN ('public', 'unlisted')
      AND NOT COALESCE(p.is_deleted, false)
)
INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
SELECT 
    follower_id as user_id,
    post_id,
    'home' as timeline_type,
    EXTRACT(epoch FROM created_at) * 1000000 as position
FROM follower_posts
WHERE rn <= 20  -- Only last 20 posts per followed user
ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;

-- ============================================================================
-- Verification
-- ============================================================================

-- Show results
SELECT 
    'Timeline trigger fixes applied' as status,
    COUNT(DISTINCT te.user_id) as users_with_timelines,
    COUNT(*) FILTER (WHERE te.timeline_type = 'home') as home_entries,
    COUNT(*) FILTER (WHERE te.timeline_type = 'public') as public_entries
FROM timeline_entries te;

