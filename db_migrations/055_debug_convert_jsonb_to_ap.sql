-- Debug Migration: Catch convert_jsonb_to_ap errors in handle_outgoing_messages

CREATE OR REPLACE FUNCTION debug_convert_jsonb_to_ap(content jsonb)
RETURNS text
LANGUAGE plpgsql
AS $function$
DECLARE
    result text;
BEGIN
    -- Log the input content
    RAISE WARNING '🔍 convert_jsonb_to_ap INPUT - Type: %, Content: %', 
        pg_typeof(content), content;
    
    -- Call the actual function and catch any errors
    BEGIN
        result := convert_jsonb_to_ap(content);
        RAISE WARNING '🔍 convert_jsonb_to_ap SUCCESS - Result: %', result;
        RETURN result;
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING '🔍 convert_jsonb_to_ap ERROR - SQLSTATE: %, Message: %, Content was: %', 
            SQLSTATE, SQLERRM, content;
        -- Return a safe fallback
        RETURN 'Content conversion failed';
    END;
END;
$function$;

-- Temporarily replace the convert_jsonb_to_ap call in handle_outgoing_messages
-- This will help us see exactly where the "@" error occurs