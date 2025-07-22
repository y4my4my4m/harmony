-- Test extract_activitypub_mention_tags function directly to isolate the issue
-- This will help us see exactly where the "Token '@' is invalid" error is coming from

DO $$
DECLARE
    test_content JSONB := '[{"type": "text", "text": "testest"}]';
    test_recipient_urls TEXT[] := ARRAY['https://misskey.io/users/aa9hh3eoz0kz0apv'];
    test_instance_domain TEXT := 'har.mony.lol';
    result JSONB;
BEGIN
    RAISE WARNING '🧪 Testing extract_activitypub_mention_tags directly...';
    RAISE WARNING '🧪 Input content: %', test_content;
    RAISE WARNING '🧪 Input recipient_urls: %', test_recipient_urls;
    RAISE WARNING '🧪 Input instance_domain: %', test_instance_domain;
    
    BEGIN
        -- Call the function directly with test data
        SELECT extract_activitypub_mention_tags(test_content, test_recipient_urls, test_instance_domain) INTO result;
        RAISE WARNING '🧪 SUCCESS: Function returned: %', result;
    EXCEPTION
        WHEN OTHERS THEN
            RAISE WARNING '🧪 ERROR: SQLSTATE=%, Message=%', SQLSTATE, SQLERRM;
            
            -- Try with empty recipient URLs to see if that's the issue
            BEGIN
                RAISE WARNING '🧪 Testing with empty recipient URLs...';
                SELECT extract_activitypub_mention_tags(test_content, ARRAY[]::TEXT[], test_instance_domain) INTO result;
                RAISE WARNING '🧪 Empty URLs SUCCESS: %', result;
            EXCEPTION 
                WHEN OTHERS THEN
                    RAISE WARNING '🧪 Empty URLs ERROR: SQLSTATE=%, Message=%', SQLSTATE, SQLERRM;
            END;
            
            -- Try with NULL recipient URLs to see if that's the issue
            BEGIN
                RAISE WARNING '🧪 Testing with NULL recipient URLs...';
                SELECT extract_activitypub_mention_tags(test_content, NULL, test_instance_domain) INTO result;
                RAISE WARNING '🧪 NULL URLs SUCCESS: %', result;
            EXCEPTION 
                WHEN OTHERS THEN
                    RAISE WARNING '🧪 NULL URLs ERROR: SQLSTATE=%, Message=%', SQLSTATE, SQLERRM;
            END;
    END;
END;
$$;