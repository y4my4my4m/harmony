-- Test convert_jsonb_to_ap function with the exact content from the failing DM
-- This is the most likely place where the "Token '@' is invalid" error is happening

-- Test with the exact content that's failing
SELECT 
    'Test convert_jsonb_to_ap with DM content' as test_name,
    convert_jsonb_to_ap('[{"type": "text", "text": "testest"}]'::jsonb) as result;

-- Test extract_activitypub_attachments too
SELECT 
    'Test extract_activitypub_attachments' as test_name,
    extract_activitypub_attachments('[{"type": "text", "text": "testest"}]'::jsonb) as result;

-- Test a simple JSONB build with @ character to see if that's the issue
SELECT 
    'Test jsonb_build_object with @ character' as test_name,
    jsonb_build_object(
        'name', '@aa9hh3eoz0kz0apv@misskey.io',
        'type', 'Mention'
    ) as result;