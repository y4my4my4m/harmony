-- Test extract_activitypub_mention_tags function with SELECT output
-- This returns results directly so we can see them without checking logs

-- Test 1: Normal case with recipient URL
SELECT 
    'Test 1: Normal case' as test_name,
    extract_activitypub_mention_tags(
        '[{"type": "text", "text": "testest"}]'::jsonb,
        ARRAY['https://misskey.io/users/aa9hh3eoz0kz0apv'],
        'har.mony.lol'
    ) as result;

-- Test 2: Empty recipient URLs
SELECT 
    'Test 2: Empty URLs' as test_name,
    extract_activitypub_mention_tags(
        '[{"type": "text", "text": "testest"}]'::jsonb,
        ARRAY[]::TEXT[],
        'har.mony.lol'
    ) as result;

-- Test 3: NULL recipient URLs  
SELECT 
    'Test 3: NULL URLs' as test_name,
    extract_activitypub_mention_tags(
        '[{"type": "text", "text": "testest"}]'::jsonb,
        NULL,
        'har.mony.lol'
    ) as result;