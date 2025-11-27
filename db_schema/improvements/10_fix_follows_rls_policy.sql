-- ============================================================================
-- Fix: Allow viewing follows for any user's public profile
-- ============================================================================
-- The previous RLS policy only allowed viewing follows where the current user
-- was the follower or being followed. This prevented viewing other users'
-- follower/following lists.
-- ============================================================================

-- Drop the old restrictive policy
DROP POLICY IF EXISTS "Users can view follows" ON public.follows;

-- Create a new policy that allows:
-- 1. Viewing your own follows (where you are follower or following)
-- 2. Viewing accepted follows for any user (public followers lists)
-- 3. Viewing pending follows where you are involved (for approval UI)
CREATE POLICY "Users can view follows" ON public.follows 
FOR SELECT USING (
    -- Anyone can see accepted follows (public follower lists)
    status = 'accepted'
    OR
    -- Users can see their own pending/rejected follows
    (( SELECT auth.uid() AS uid) = follower_id)
    OR
    -- Users can see pending requests where they are the target (for approval)
    (( SELECT auth.uid() AS uid) = following_id)
);

-- Also ensure the counters are correct for all profiles
-- This recalculates followers_count and following_count based on actual follows
DO $$
DECLARE
    profile_record RECORD;
    actual_followers INTEGER;
    actual_following INTEGER;
BEGIN
    FOR profile_record IN SELECT id FROM profiles LOOP
        -- Count actual accepted followers
        SELECT COUNT(*) INTO actual_followers
        FROM follows 
        WHERE following_id = profile_record.id AND status = 'accepted';
        
        -- Count actual accepted following
        SELECT COUNT(*) INTO actual_following
        FROM follows 
        WHERE follower_id = profile_record.id AND status = 'accepted';
        
        -- Update if different
        UPDATE profiles 
        SET 
            followers_count = actual_followers,
            following_count = actual_following
        WHERE id = profile_record.id
          AND (followers_count != actual_followers OR following_count != actual_following);
    END LOOP;
    
    RAISE NOTICE 'Follow counts recalculated for all profiles';
END;
$$;

COMMENT ON POLICY "Users can view follows" ON public.follows IS 
'Allows viewing accepted follows publicly (for follower lists), and pending follows where the user is involved';

