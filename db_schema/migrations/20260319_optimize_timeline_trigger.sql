BEGIN;

-- =============================================================================
-- Optimize create_comprehensive_timeline_entries()
-- 
-- PROBLEM: The old trigger uses FOR ... LOOP to insert one row at a time for
-- each follower AND each local user (public timeline). With N local users,
-- one public post causes ~N individual INSERTs - a massive bottleneck.
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

-- Also optimize the follower backfill trigger (capped at 50 most recent posts)
CREATE OR REPLACE FUNCTION public.add_existing_posts_to_new_follower_timeline()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NEW.status = 'pending' THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT NEW.follower_id, sub.id, 'home', EXTRACT(epoch FROM sub.created_at) * 1000000
        FROM (
            SELECT p.id, p.created_at
            FROM posts p
            WHERE p.author_id = NEW.following_id
              AND p.visibility = 'public'
              AND NOT COALESCE(p.is_deleted, false)
              AND p.created_at > NOW() - INTERVAL '7 days'
            ORDER BY p.created_at DESC
            LIMIT 50
        ) sub
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    ELSIF NEW.status = 'accepted' THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT NEW.follower_id, sub.id, 'home', EXTRACT(epoch FROM sub.created_at) * 1000000
        FROM (
            SELECT p.id, p.created_at
            FROM posts p
            WHERE p.author_id = NEW.following_id
              AND p.visibility IN ('public', 'unlisted')
              AND NOT COALESCE(p.is_deleted, false)
              AND p.created_at > NOW() - INTERVAL '7 days'
            ORDER BY p.created_at DESC
            LIMIT 50
        ) sub
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

-- Also cap backfill_timeline_on_follow (same unbounded issue)
CREATE OR REPLACE FUNCTION public.backfill_timeline_on_follow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = NEW.follower_id AND is_local = true) THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status = 'accepted' THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT NEW.follower_id, sub.id, 'home', EXTRACT(epoch FROM sub.created_at) * 1000000
        FROM (
            SELECT p.id, p.created_at
            FROM posts p
            WHERE p.author_id = NEW.following_id
              AND p.visibility = 'unlisted'
              AND NOT COALESCE(p.is_deleted, false)
              AND p.created_at > NOW() - INTERVAL '7 days'
            ORDER BY p.created_at DESC
            LIMIT 50
        ) sub
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
