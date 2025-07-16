-- Fix the stuck activity and test the flow
-- Remove the non-existent processed_at column references

-- First, let's check the current status
SELECT ap_id, ap_type, status, error_message, actor_ap_id, created_at
FROM ap_activities 
WHERE ap_id = 'https://mastodon.social/users/tester004/statuses/114863520311029883/activity';

-- Check if the remote profile exists for the actor
SELECT id, username, domain, federated_id, is_local
FROM profiles 
WHERE federated_id = 'https://mastodon.social/users/tester004';

-- Create the remote profile if it doesn't exist
INSERT INTO profiles (
    username,
    domain, 
    federated_id,
    is_local,
    display_name,
    created_at,
    updated_at
) 
SELECT 
    'tester004',
    'mastodon.social',
    'https://mastodon.social/users/tester004',
    false,
    'tester004',
    NOW(),
    NOW()
WHERE NOT EXISTS (
    SELECT 1 FROM profiles 
    WHERE federated_id = 'https://mastodon.social/users/tester004'
);

-- Now manually trigger processing of the stuck activity
UPDATE ap_activities 
SET status = 'processing'
WHERE ap_id = 'https://mastodon.social/users/tester004/statuses/114863520311029883/activity'
  AND status = 'received';

-- Check if processing worked
SELECT ap_id, ap_type, status, error_message, updated_at
FROM ap_activities 
WHERE ap_id = 'https://mastodon.social/users/tester004/statuses/114863520311029883/activity';

-- Check if a message was created
SELECT id, conversation_id, user_id, content, created_at, metadata
FROM messages 
WHERE metadata->>'ap_id' = 'https://mastodon.social/users/tester004/statuses/114863520311029883'
ORDER BY created_at DESC;

-- Check if a conversation was created
SELECT c.id, c.created_at, 
       p1.username as user1_username, p1.domain as user1_domain,
       p2.username as user2_username, p2.domain as user2_domain
FROM conversations c
JOIN profiles p1 ON c.user1 = p1.id
JOIN profiles p2 ON c.user2 = p2.id
ORDER BY c.created_at DESC
LIMIT 5;
