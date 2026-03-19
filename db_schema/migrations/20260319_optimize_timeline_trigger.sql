BEGIN;

-- =============================================================================
-- Optimize create_comprehensive_timeline_entries()
-- 
-- PROBLEM: The old trigger uses FOR ... LOOP to insert one row at a time for
-- each follower AND each local user (public timeline). With N local users,
-- one public post causes ~N individual INSERTs — a massive bottleneck.
--
-- FIX: Replace all loops with bulk INSERT ... SELECT statements.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.create_comprehensive_timeline_entries()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF COALESCE(NEW.is_deleted, false) THEN
        RETURN NEW;
    END IF;
    
    -- Add to author's own home timeline (local authors only)
    IF NEW.is_local THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        VALUES (NEW.author_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000)
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END IF;
    
    -- Add to followers' home timelines based on visibility (bulk)
    IF NEW.visibility = 'public' THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT f.follower_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000
        FROM follows f
        JOIN profiles p ON f.follower_id = p.id
        WHERE f.following_id = NEW.author_id
          AND f.status IN ('accepted', 'pending')
          AND p.is_local = true
          AND f.follower_id != NEW.author_id
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    ELSIF NEW.visibility IN ('unlisted', 'followers') THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT f.follower_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000
        FROM follows f
        JOIN profiles p ON f.follower_id = p.id
        WHERE f.following_id = NEW.author_id
          AND f.status = 'accepted'
          AND p.is_local = true
          AND f.follower_id != NEW.author_id
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END IF;
    
    -- Add public posts to public timeline for all local users (bulk)
    IF NEW.visibility = 'public' THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT p.id, NEW.id, 'public', EXTRACT(epoch FROM NEW.created_at) * 1000000
        FROM profiles p
        WHERE p.is_local = true
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Also optimize the follower backfill trigger
CREATE OR REPLACE FUNCTION public.add_existing_posts_to_new_follower_timeline()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NEW.status = 'pending' THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT NEW.follower_id, p.id, 'home', EXTRACT(epoch FROM p.created_at) * 1000000
        FROM posts p
        WHERE p.author_id = NEW.following_id
          AND p.visibility = 'public'
          AND NOT COALESCE(p.is_deleted, false)
          AND p.created_at > NOW() - INTERVAL '7 days'
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    ELSIF NEW.status = 'accepted' THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT NEW.follower_id, p.id, 'home', EXTRACT(epoch FROM p.created_at) * 1000000
        FROM posts p
        WHERE p.author_id = NEW.following_id
          AND p.visibility IN ('public', 'unlisted')
          AND NOT COALESCE(p.is_deleted, false)
          AND p.created_at > NOW() - INTERVAL '7 days'
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
