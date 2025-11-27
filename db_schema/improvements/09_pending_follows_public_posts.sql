-- ============================================================================
-- Fix: Show public posts from pending follows in home timeline
-- ============================================================================
-- When you follow someone, their PUBLIC posts should appear in your home 
-- timeline immediately, even if the follow is still pending (for locked accounts).
-- Only followers-only posts should require accepted follow status.
-- ============================================================================

-- Update the trigger that adds posts to timeline when a new follow is created
CREATE OR REPLACE FUNCTION public.add_existing_posts_to_new_follower_timeline()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    post_record RECORD;
    added_count INTEGER := 0;
BEGIN
    -- For pending follows: Only add PUBLIC posts
    -- For accepted follows: Add PUBLIC and UNLISTED posts
    -- Followers-only posts always require accepted status
    
    IF NEW.status = 'pending' THEN
        -- Pending follow: Add only public posts (they're public anyway!)
        FOR post_record IN 
            SELECT id, created_at
            FROM posts 
            WHERE author_id = NEW.following_id
              AND visibility = 'public'  -- Only public for pending
              AND NOT COALESCE(is_deleted, false)
              AND created_at > NOW() - INTERVAL '7 days'
            ORDER BY created_at DESC
            LIMIT 50
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
        
        RAISE NOTICE 'Added % public posts to pending follower timeline', added_count;
        
    ELSIF NEW.status = 'accepted' THEN
        -- Accepted follow: Add public and unlisted posts
        FOR post_record IN 
            SELECT id, created_at
            FROM posts 
            WHERE author_id = NEW.following_id
              AND visibility IN ('public', 'unlisted')
              AND NOT COALESCE(is_deleted, false)
              AND created_at > NOW() - INTERVAL '7 days'
            ORDER BY created_at DESC
            LIMIT 50
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
        
        RAISE NOTICE 'Added % posts to accepted follower timeline', added_count;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Update the backfill trigger to also handle status transitions
CREATE OR REPLACE FUNCTION public.backfill_timeline_on_follow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    post_record RECORD;
BEGIN
    -- Only backfill for local followers
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = NEW.follower_id AND is_local = true) THEN
        RETURN NEW;
    END IF;
    
    -- Handle status transitions (pending -> accepted)
    -- When a follow becomes accepted, add any unlisted posts that weren't added before
    IF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status = 'accepted' THEN
        -- Add unlisted posts (public ones were already added when follow was created)
        FOR post_record IN
            SELECT id, created_at
            FROM posts
            WHERE author_id = NEW.following_id
              AND visibility = 'unlisted'
              AND NOT COALESCE(is_deleted, false)
              AND created_at > NOW() - INTERVAL '7 days'
            ORDER BY created_at DESC
            LIMIT 20
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (NEW.follower_id, post_record.id, 'home', EXTRACT(epoch FROM post_record.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        END LOOP;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Update the trigger that creates timeline entries for new posts
CREATE OR REPLACE FUNCTION public.create_comprehensive_timeline_entries()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    follower_record RECORD;
    local_user_record RECORD;
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
    
    -- Add to followers' home timelines based on visibility and follow status
    IF NEW.visibility = 'public' THEN
        -- PUBLIC posts go to ALL followers (accepted AND pending)
        FOR follower_record IN 
            SELECT f.follower_id 
            FROM follows f 
            JOIN profiles p ON f.follower_id = p.id
            WHERE f.following_id = NEW.author_id 
              AND f.status IN ('accepted', 'pending')  -- Both accepted and pending!
              AND p.is_local = true
              AND f.follower_id != NEW.author_id
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (follower_record.follower_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        END LOOP;
    ELSIF NEW.visibility = 'unlisted' THEN
        -- UNLISTED posts go only to accepted followers
        FOR follower_record IN 
            SELECT f.follower_id 
            FROM follows f 
            JOIN profiles p ON f.follower_id = p.id
            WHERE f.following_id = NEW.author_id 
              AND f.status = 'accepted'  -- Only accepted for unlisted
              AND p.is_local = true
              AND f.follower_id != NEW.author_id
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (follower_record.follower_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        END LOOP;
    ELSIF NEW.visibility = 'followers' THEN
        -- FOLLOWERS-ONLY posts go only to accepted followers
        FOR follower_record IN 
            SELECT f.follower_id 
            FROM follows f 
            JOIN profiles p ON f.follower_id = p.id
            WHERE f.following_id = NEW.author_id 
              AND f.status = 'accepted'  -- Only accepted for followers-only
              AND p.is_local = true
              AND f.follower_id != NEW.author_id
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (follower_record.follower_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        END LOOP;
    END IF;
    -- Note: 'direct' visibility posts don't go to timeline at all
    
    -- Add to ALL local users' public timeline (for public posts only)
    IF NEW.visibility = 'public' THEN
        FOR local_user_record IN
            SELECT id FROM profiles WHERE is_local = true
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (local_user_record.id, NEW.id, 'public', EXTRACT(epoch FROM NEW.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        END LOOP;
    END IF;
    
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.add_existing_posts_to_new_follower_timeline() IS 'When a follow is created, add public posts immediately even if pending. Add unlisted posts only when accepted.';
COMMENT ON FUNCTION public.backfill_timeline_on_follow() IS 'Backfills home timeline with unlisted posts when a pending follow becomes accepted.';
COMMENT ON FUNCTION public.create_comprehensive_timeline_entries() IS 'Creates timeline entries for posts. Public posts go to all followers (including pending). Unlisted/followers-only require accepted status.';

