-- =============================================
-- FIX TIMELINE ENTRIES TRIGGER
-- =============================================
-- Remove the problematic public timeline insertion that causes SQL errors

-- Drop the existing trigger and function
DROP TRIGGER IF EXISTS create_timeline_entries_trigger ON posts;
DROP FUNCTION IF EXISTS create_timeline_entries();

-- Create the fixed function without the problematic public timeline insertion
CREATE OR REPLACE FUNCTION create_timeline_entries()
RETURNS TRIGGER AS $$
BEGIN
    -- Add to author's own timeline
    INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
    VALUES (NEW.author_id, NEW.id, 'home', extract(epoch from NEW.created_at) * 1000000);
    
    -- Add to followers' home timelines if public/unlisted
    IF NEW.visibility IN ('public', 'unlisted') THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT f.follower_id, NEW.id, 'home', extract(epoch from NEW.created_at) * 1000000
        FROM follows f
        WHERE f.following_id = NEW.author_id AND f.status = 'accepted';
    END IF;
    
    -- NOTE: Public timeline entries are now generated on-demand via queries
    -- rather than pre-populated for all users (which was inefficient and buggy)
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Recreate the trigger
CREATE TRIGGER create_timeline_entries_trigger
    AFTER INSERT ON posts
    FOR EACH ROW EXECUTE FUNCTION create_timeline_entries();

-- Add comment for documentation
COMMENT ON FUNCTION create_timeline_entries() IS 'Creates timeline entries for new posts. Public timeline is generated on-demand via queries.';
COMMENT ON TRIGGER create_timeline_entries_trigger ON posts IS 'Automatically creates timeline entries when new posts are created';

-- Verify the trigger was created
SELECT 
    trigger_name, 
    event_object_table, 
    action_timing, 
    event_manipulation
FROM information_schema.triggers 
WHERE trigger_name = 'create_timeline_entries_trigger'; 