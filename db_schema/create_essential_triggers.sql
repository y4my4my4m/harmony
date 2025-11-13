-- Essential Triggers for Timeline and Federation
-- Run AFTER essential_functions.sql

-- Drop existing triggers to avoid duplicates
DROP TRIGGER IF EXISTS update_post_reply_counter_trigger ON posts;
DROP TRIGGER IF EXISTS backfill_timeline_on_follow_trigger ON follows;
DROP TRIGGER IF EXISTS remove_timeline_on_unfollow_trigger ON follows;

-- Note: ap_id is set by application code (activityPubService.ts), not trigger

-- Update reply counters when posts are created/deleted
CREATE TRIGGER update_post_reply_counter_trigger
    AFTER INSERT OR DELETE ON posts
    FOR EACH ROW
    WHEN (
        (TG_OP = 'INSERT' AND NEW.in_reply_to IS NOT NULL) OR
        (TG_OP = 'DELETE' AND OLD.in_reply_to IS NOT NULL)
    )
    EXECUTE FUNCTION update_post_counters();

-- Backfill timeline when following someone (on INSERT or UPDATE to accepted)
CREATE TRIGGER backfill_timeline_on_follow_trigger
    AFTER INSERT OR UPDATE OF status ON follows
    FOR EACH ROW
    WHEN (NEW.status = 'accepted')
    EXECUTE FUNCTION backfill_timeline_on_follow();

-- Remove posts from timeline when unfollowing (BEFORE DELETE so OLD exists)
CREATE TRIGGER remove_timeline_on_unfollow_trigger
    BEFORE DELETE ON follows
    FOR EACH ROW
    EXECUTE FUNCTION remove_timeline_on_unfollow();

-- Fix old posts missing ap_id (one-time update)
UPDATE posts
SET ap_id = 'https://har.mony.lol/posts/' || id,
    url = 'https://har.mony.lol/posts/' || id
WHERE is_local = true 
  AND ap_id IS NULL;

-- Show what triggers exist now
SELECT 
    tgname as trigger_name,
    tgrelid::regclass as table_name,
    tgenabled as enabled
FROM pg_trigger
WHERE tgname IN (
    'update_post_reply_counter_trigger',
    'backfill_timeline_on_follow_trigger',
    'remove_timeline_on_unfollow_trigger',
    'create_comprehensive_timeline_entries_trigger'
)
ORDER BY table_name, tgname;

