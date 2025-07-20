-- =====================================================
-- Migration 018: Fix Follows Column References
-- =====================================================
-- Issue: Code was using 'followed_id' but database schema uses 'following_id'
-- Root cause: Inconsistent column naming between code and database
-- Solution: Verify schema consistency and document correct column names

BEGIN;

-- =====================================================
-- STEP 1: Verify current follows table schema
-- =====================================================

DO $$
DECLARE
    has_following_id BOOLEAN;
    has_followed_id BOOLEAN;
BEGIN
    -- Check if following_id column exists (correct)
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'follows' 
        AND column_name = 'following_id'
    ) INTO has_following_id;
    
    -- Check if followed_id column exists (incorrect)
    SELECT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'follows' 
        AND column_name = 'followed_id'
    ) INTO has_followed_id;
    
    RAISE NOTICE 'Follows table schema analysis:';
    RAISE NOTICE '- following_id column exists: %', has_following_id;
    RAISE NOTICE '- followed_id column exists: %', has_followed_id;
    
    IF NOT has_following_id THEN
        RAISE EXCEPTION 'CRITICAL: follows table missing following_id column!';
    END IF;
    
    IF has_followed_id THEN
        RAISE NOTICE 'WARNING: follows table has both following_id and followed_id columns';
        RAISE NOTICE 'This suggests an incomplete migration or schema inconsistency';
    ELSE
        RAISE NOTICE 'SUCCESS: follows table uses correct following_id column only';
    END IF;
END
$$;

-- =====================================================
-- STEP 2: Verify foreign key constraints use correct names
-- =====================================================

DO $$
DECLARE
    constraint_name TEXT;
BEGIN
    -- Check for foreign key constraint name
    SELECT conname INTO constraint_name
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(c.conkey)
    WHERE t.relname = 'follows' 
    AND a.attname = 'following_id'
    AND c.contype = 'f';
    
    IF constraint_name IS NOT NULL THEN
        RAISE NOTICE 'Foreign key constraint found: %', constraint_name;
        RAISE NOTICE 'This should typically be: follows_following_id_fkey';
    ELSE
        RAISE NOTICE 'WARNING: No foreign key constraint found for following_id column';
    END IF;
END
$$;

-- =====================================================
-- STEP 3: Verify database functions use correct column names
-- =====================================================

-- Check for any database functions that might use the old 'followed_id' name
DO $$
DECLARE
    func_record RECORD;
    func_count INTEGER := 0;
BEGIN
    -- Search for functions containing 'followed_id' references
    FOR func_record IN 
        SELECT routine_name, routine_definition
        FROM information_schema.routines 
        WHERE routine_type = 'FUNCTION'
        AND routine_definition ILIKE '%followed_id%'
    LOOP
        func_count := func_count + 1;
        RAISE NOTICE 'Function % contains followed_id reference', func_record.routine_name;
    END LOOP;
    
    IF func_count = 0 THEN
        RAISE NOTICE 'SUCCESS: No database functions use old followed_id column name';
    ELSE
        RAISE NOTICE 'WARNING: Found % functions using old followed_id column name', func_count;
        RAISE NOTICE 'These functions may need updating to use following_id';
    END IF;
END
$$;

-- =====================================================
-- STEP 4: Create documentation comment
-- =====================================================

COMMENT ON COLUMN follows.following_id IS 
'ID of the user being followed. 
IMPORTANT: Code should use following_id, NOT followed_id.
This is the target of the follow relationship (follower_id -> following_id)';

COMMENT ON COLUMN follows.follower_id IS 
'ID of the user doing the following.
This is the source of the follow relationship (follower_id -> following_id)';

-- =====================================================
-- STEP 5: Add helpful view for relationship clarity
-- =====================================================

-- Create a view that makes the relationship direction crystal clear
CREATE OR REPLACE VIEW follow_relationships AS
SELECT 
    f.id,
    f.follower_id,
    f.following_id,
    f.status,
    f.created_at,
    f.accepted_at,
    follower.username as follower_username,
    following.username as following_username,
    follower.display_name as follower_display_name,
    following.display_name as following_display_name
FROM follows f
JOIN profiles follower ON f.follower_id = follower.id
JOIN profiles following ON f.following_id = following.id;

COMMENT ON VIEW follow_relationships IS 
'Helper view that clearly shows follow relationships with usernames.
follower_id = user who is following
following_id = user being followed
Use this view for debugging relationship queries.';

-- =====================================================
-- STEP 6: Create helper function for common queries
-- =====================================================

CREATE OR REPLACE FUNCTION get_follow_status(
    current_user_id UUID,
    target_user_id UUID
) RETURNS TABLE (
    is_following BOOLEAN,
    is_followed_by BOOLEAN,
    follow_status TEXT,
    followed_by_status TEXT
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        -- Is current user following target user?
        EXISTS(
            SELECT 1 FROM follows 
            WHERE follower_id = current_user_id 
            AND following_id = target_user_id 
            AND status = 'accepted'
        ) as is_following,
        
        -- Is current user followed by target user?
        EXISTS(
            SELECT 1 FROM follows 
            WHERE follower_id = target_user_id 
            AND following_id = current_user_id 
            AND status = 'accepted'
        ) as is_followed_by,
        
        -- Follow request status (outgoing)
        COALESCE(
            (SELECT status FROM follows 
             WHERE follower_id = current_user_id 
             AND following_id = target_user_id 
             LIMIT 1), 
            'none'
        ) as follow_status,
        
        -- Follow request status (incoming)
        COALESCE(
            (SELECT status FROM follows 
             WHERE follower_id = target_user_id 
             AND following_id = current_user_id 
             LIMIT 1), 
            'none'
        ) as followed_by_status;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION get_follow_status(UUID, UUID) IS 
'Helper function to get complete follow relationship status between two users.
Uses correct following_id column names.
Returns: is_following, is_followed_by, follow_status, followed_by_status';

COMMIT;

-- =====================================================
-- POST-MIGRATION VERIFICATION
-- =====================================================
-- Test the helper function:
-- SELECT * FROM get_follow_status('your-user-id', 'target-user-id');
--
-- View relationship data:
-- SELECT * FROM follow_relationships LIMIT 10;