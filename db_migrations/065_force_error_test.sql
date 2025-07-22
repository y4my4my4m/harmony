-- Force an error test to verify where the "Token '@' is invalid" issue is happening
-- If this exact same error appears, we know it's in the content preview extraction

-- This will deliberately cause the same type of error if it's in the string concatenation
SELECT 
    'Testing string concatenation with @' as test_name,
    '@' || 'testuser' as result;

-- This will test if the issue is in the LEFT() function with @ characters
SELECT 
    'Testing LEFT function with @' as test_name,
    LEFT('@testuser@domain.com some text', 100) as result;

-- This will test the exact string_agg logic from the trigger
SELECT 
    'Testing string_agg with @ concatenation' as test_name,
    LEFT(string_agg(
        CASE 
            WHEN value->>'type' = 'mention' THEN '@' || COALESCE(value->>'username', 'unknown')
            ELSE COALESCE(value->>'text', value::text)
        END, ''
    ), 100) as result
FROM jsonb_array_elements('[{"type": "text", "text": "testest"}]'::jsonb) AS value;