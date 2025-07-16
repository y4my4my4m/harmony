-- Manual test to trigger processing of the stuck activity
-- This will simulate what the inbox should have done

UPDATE ap_activities 
SET status = 'processing', 
    updated_at = NOW()
WHERE ap_id = 'https://mastodon.social/users/tester004/statuses/114863520311029883/activity'
  AND status = 'received';

-- Check if the trigger exists and is enabled
SELECT tgname, tgenabled, tgrelid::regclass as table_name
FROM pg_trigger 
WHERE tgname = 'unified_activitypub_processing_trigger';

-- Also check if the remote profile exists for the actor
SELECT id, username, domain, ap_id, federated_id 
FROM profiles 
WHERE ap_id = 'https://mastodon.social/users/tester004' 
   OR federated_id = 'https://mastodon.social/users/tester004';

-- Check if there are any other activities stuck in 'received' status
SELECT ap_id, ap_type, status, actor_ap_id, created_at, error_message
FROM ap_activities 
WHERE status = 'received'
ORDER BY created_at DESC
LIMIT 10;

-- Let's also manually create the remote profile if it doesn't exist
-- This might be why the inbox validation is failing
INSERT INTO profiles (
    username,
    domain, 
    ap_id,
    federated_id,
    is_local,
    display_name,
    created_at,
    updated_at
) VALUES (
    'tester004',
    'mastodon.social',
    'https://mastodon.social/users/tester004',
    'https://mastodon.social/users/tester004',
    false,
    'tester004',
    NOW(),
    NOW()
) ON CONFLICT (ap_id) DO UPDATE SET
    federated_id = EXCLUDED.federated_id,
    updated_at = NOW();

-- Now try updating the activity status again after ensuring profile exists
UPDATE ap_activities 
SET status = 'processing', 
    updated_at = NOW()
WHERE ap_id = 'https://mastodon.social/users/tester004/statuses/114863520311029883/activity'
  AND status = 'received';

-- Check the final status
SELECT ap_id, ap_type, status, error_message, updated_at
FROM ap_activities 
WHERE ap_id = 'https://mastodon.social/users/tester004/statuses/114863520311029883/activity';
