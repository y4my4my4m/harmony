-- Temporary fix: Disable federation trigger to test post insertion
-- This will allow us to isolate the content insertion issue

BEGIN;

-- Disable the federation trigger temporarily
DROP TRIGGER IF EXISTS trigger_unified_content_federation ON posts;

-- Also disable other post triggers that might interfere
DROP TRIGGER IF EXISTS trigger_unified_notification_posts ON posts;

-- Keep essential triggers but disable federation ones
-- We can re-enable them after fixing the core insertion issue

COMMIT;

-- After running this, try creating a post to see if the JSONB insertion works
-- If it works, the issue is in the federation trigger logic
-- If it still fails, the issue is in the Supabase JSONB handling