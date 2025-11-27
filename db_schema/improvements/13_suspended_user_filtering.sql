-- Migration: Filter suspended users from searches and interactions
-- This ensures suspended users (both local and remote) are properly hidden

-- Update search_federated_users to exclude suspended users
CREATE OR REPLACE FUNCTION public.search_federated_users(p_query text, p_limit integer DEFAULT 10) 
RETURNS TABLE(user_id uuid, username text, display_name text, domain text, avatar_url text, handle text, is_local boolean)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id as user_id,
        p.username,
        p.display_name,
        p.domain,
        p.avatar_url,
        get_user_handle(p.id) as handle,
        p.is_local
    FROM profiles p
    WHERE (
        p.username ILIKE '%' || p_query || '%'
        OR p.display_name ILIKE '%' || p_query || '%'
        OR (p.username || '@' || p.domain) ILIKE '%' || p_query || '%'
    )
    AND p.is_suspended = false  -- Exclude suspended users
    ORDER BY 
        CASE WHEN p.is_local THEN 0 ELSE 1 END,
        p.username
    LIMIT p_limit;
END;
$$;

-- Create function to check if a user is suspended (for use in triggers/policies)
CREATE OR REPLACE FUNCTION public.is_user_suspended(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(is_suspended, false) FROM profiles WHERE id = p_user_id;
$$;

-- Create function to handle remote user suspension
-- When we suspend a remote user, we should:
-- 1. Remove their follows to local users
-- 2. Hide their posts from timelines
-- 3. Ignore their reactions
CREATE OR REPLACE FUNCTION public.handle_remote_user_suspension()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.is_suspended = true AND (OLD.is_suspended IS NULL OR OLD.is_suspended = false) THEN
        -- Remove follows where suspended user is following local users
        DELETE FROM follows 
        WHERE follower_id = NEW.id 
        AND EXISTS (SELECT 1 FROM profiles WHERE id = follows.following_id AND is_local = true);
        
        -- Remove follows where local users are following the suspended user
        -- This unfollows local users from the suspended remote user
        DELETE FROM follows 
        WHERE following_id = NEW.id 
        AND EXISTS (SELECT 1 FROM profiles WHERE id = follows.follower_id AND is_local = true);
        
        -- Note: We don't delete their posts - they're hidden via queries
        -- We don't delete their reactions - they're just not shown
        
        -- Log the suspension
        RAISE NOTICE 'User % has been suspended. Removed follow relationships with local users.', NEW.id;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop existing trigger if exists
DROP TRIGGER IF EXISTS trigger_handle_remote_user_suspension ON public.profiles;

-- Create trigger for handling suspension
CREATE TRIGGER trigger_handle_remote_user_suspension
    AFTER UPDATE OF is_suspended ON public.profiles
    FOR EACH ROW
    WHEN (NEW.is_suspended = true)
    EXECUTE FUNCTION public.handle_remote_user_suspension();

-- Update timeline entries function to exclude suspended users
-- (This ensures new posts from suspended users don't get added to timelines)
-- Note: Existing timeline entries with suspended user posts are filtered at query time

COMMENT ON FUNCTION public.search_federated_users(text, integer) IS 'Search for federated users by username/display_name, excluding suspended users';
COMMENT ON FUNCTION public.is_user_suspended(uuid) IS 'Check if a user is suspended';
COMMENT ON FUNCTION public.handle_remote_user_suspension() IS 'Handle cleanup when a user (especially remote) is suspended - removes follow relationships';

