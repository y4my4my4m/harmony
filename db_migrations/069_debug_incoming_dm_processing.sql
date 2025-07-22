-- Debug incoming DM processing
-- Check recent ActivityPub activities and how they're being processed

-- Check recent AP activities
SELECT 
    'Recent ActivityPub activities' as info,
    ap.id,
    ap.ap_type,
    ap.actor_ap_id,
    ap.status,
    ap.created_at,
    ap.activity_data->'object'->>'type' as object_type,
    ap.activity_data->'object'->'to' as object_to,
    ap.activity_data->'object'->'cc' as object_cc
FROM ap_activities ap
WHERE ap.created_at > NOW() - INTERVAL '1 hour'
  AND ap.ap_type = 'Create'
ORDER BY ap.created_at DESC
LIMIT 10;

-- Test the DM detection function with a sample ActivityPub object
-- This simulates what an incoming private mention would look like
DO $$
DECLARE
    test_dm_object JSONB := jsonb_build_object(
        'type', 'Note',
        'to', jsonb_build_array('https://har.mony.lol/users/testuser'),
        'cc', jsonb_build_array(),
        'content', 'Test DM content'
    );
    test_public_object JSONB := jsonb_build_object(
        'type', 'Note', 
        'to', jsonb_build_array('https://www.w3.org/ns/activitystreams#Public'),
        'cc', jsonb_build_array('https://har.mony.lol/users/testuser'),
        'content', 'Test public content'
    );
    is_dm_result BOOLEAN;
    is_public_result BOOLEAN;
BEGIN
    -- Test DM detection
    SELECT is_activitypub_direct_message(test_dm_object, 'har.mony.lol') INTO is_dm_result;
    RAISE WARNING '🧪 DM Detection Test - Private object detected as DM: %', is_dm_result;
    
    SELECT is_activitypub_direct_message(test_public_object, 'har.mony.lol') INTO is_public_result;
    RAISE WARNING '🧪 DM Detection Test - Public object detected as DM: %', is_public_result;
    
    -- Test with a more realistic private mention object
    test_dm_object := jsonb_build_object(
        'type', 'Note',
        'to', jsonb_build_array('https://har.mony.lol/users/testuser'),
        'cc', jsonb_build_array(),
        'tag', jsonb_build_array(
            jsonb_build_object(
                'type', 'Mention',
                'href', 'https://har.mony.lol/users/testuser',
                'name', '@testuser@har.mony.lol'
            )
        ),
        'content', '<p><span class="h-card"><a href="https://har.mony.lol/users/testuser" class="u-url mention">@<span>testuser</span></a></span> Hello this is a private mention</p>'
    );
    
    SELECT is_activitypub_direct_message(test_dm_object, 'har.mony.lol') INTO is_dm_result;
    RAISE WARNING '🧪 DM Detection Test - Realistic private mention detected as DM: %', is_dm_result;
END;
$$;