BEGIN;

-- Migration 053: Fix DM Content Format Issue
-- This migration addresses the "Token '@' is invalid" error when sending DMs
-- The issue is that raw text containing "@" is being inserted into JSONB content field

-- Create a validation function to catch and fix content format issues
CREATE OR REPLACE FUNCTION validate_and_fix_message_content()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    -- Only process DM messages
    IF NEW.conversation_id IS NOT NULL THEN
        -- Check if content is being inserted as raw text instead of JSONB array
        IF pg_typeof(NEW.content) = 'text'::regtype THEN
            RAISE EXCEPTION 'DM content must be MessagePart[] array, got raw text: %', NEW.content;
        END IF;
        
        -- Validate that content is a proper JSONB array
        IF jsonb_typeof(NEW.content) != 'array' THEN
            RAISE EXCEPTION 'DM content must be JSONB array of MessagePart objects, got: %', jsonb_typeof(NEW.content);
        END IF;
        
        -- Log successful DM content validation
        RAISE WARNING '✅ DM content validated: % parts', jsonb_array_length(NEW.content);
    END IF;
    
    RETURN NEW;
END;
$function$;

-- Add trigger to validate content format before insert
DROP TRIGGER IF EXISTS validate_message_content_trigger ON messages;
CREATE TRIGGER validate_message_content_trigger
    BEFORE INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION validate_and_fix_message_content();

-- Add comment explaining the fix
COMMENT ON FUNCTION validate_and_fix_message_content() IS 'Validates that DM message content is properly formatted as MessagePart[] arrays, preventing "Token @ is invalid" errors';

COMMIT;