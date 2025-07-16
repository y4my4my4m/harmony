-- Debug why the trigger didn't process the activity

-- Check the current status after the update
SELECT ap_id, ap_type, status, error_message, attempts, last_attempt_at, updated_at
FROM ap_activities 
WHERE ap_id = 'https://mastodon.social/users/tester004/statuses/114863520311029883/activity';

-- Check if there are any recent PostgreSQL logs or notices
-- (This would show the RAISE NOTICE statements from the trigger)

-- Let's manually check if the DM detection is working
SELECT 
    is_activitypub_direct_message(
        activity_data->'object',
        'har.mony.lol'
    ) as is_dm,
    activity_data->'object'->>'content' as content,
    activity_data->'object'->'to' as to_addresses,
    activity_data->'object'->'cc' as cc_addresses
FROM ap_activities 
WHERE ap_id = 'https://mastodon.social/users/tester004/statuses/114863520311029883/activity';

-- Check if the actor profile exists with the correct federated_id
SELECT id, username, domain, federated_id, is_local
FROM profiles 
WHERE federated_id = 'https://mastodon.social/users/tester004';

-- Check if the local recipient (poring) exists
SELECT id, username, domain, is_local
FROM profiles 
WHERE username = 'poring' AND domain = 'har.mony.lol' AND is_local = true;

-- Try to manually run the DM processing function to see what happens
DO $$
DECLARE
    v_activity_record RECORD;
    v_actor_profile RECORD;
BEGIN
    -- Get the activity
    SELECT * INTO v_activity_record
    FROM ap_activities 
    WHERE ap_id = 'https://mastodon.social/users/tester004/statuses/114863520311029883/activity';
    
    -- Get the actor profile
    SELECT * INTO v_actor_profile
    FROM profiles 
    WHERE federated_id = v_activity_record.actor_ap_id;
    
    IF FOUND THEN
        RAISE NOTICE 'Manually calling DM processing...';
        PERFORM process_activitypub_direct_message(
            v_activity_record.id,
            v_activity_record.activity_data,
            v_actor_profile,
            'har.mony.lol'
        );
        RAISE NOTICE 'DM processing completed';
    ELSE
        RAISE NOTICE 'Actor profile not found for: %', v_activity_record.actor_ap_id;
    END IF;
END $$;

-- Check if a message was created after manual processing
SELECT id, conversation_id, user_id, content, created_at, metadata
FROM messages 
WHERE metadata->>'ap_id' = 'https://mastodon.social/users/tester004/statuses/114863520311029883'
ORDER BY created_at DESC;
