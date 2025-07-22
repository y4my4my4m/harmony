BEGIN;

-- Migration 052: Fix Content Validation for MessagePart Arrays
-- This migration adds proper validation to catch when raw text is sent instead of MessagePart[]

-- Add a validation trigger to catch content format issues
CREATE OR REPLACE FUNCTION validate_message_content()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    -- Validate that content is proper JSONB array format
    IF NEW.content IS NOT NULL THEN
        -- Check if content is valid JSONB
        BEGIN
            -- Try to access content as JSONB array
            IF jsonb_typeof(NEW.content) != 'array' THEN
                RAISE EXCEPTION 'Content must be a JSONB array of MessagePart objects, got: %', jsonb_typeof(NEW.content);
            END IF;
            
            -- Check if any array element contains raw @ symbols (indicating malformed content)
            IF NEW.content::text LIKE '%"@%' AND NEW.content::text NOT LIKE '%"type":"mention"%' THEN
                RAISE WARNING '⚠️ Content contains raw @ symbols without proper mention structure: %', NEW.content;
                RAISE EXCEPTION 'Content contains raw @ symbols. Use proper MessagePart format with type:"mention" instead of raw text.';
            END IF;
            
        EXCEPTION WHEN invalid_text_representation THEN
            RAISE EXCEPTION 'Content is not valid JSON: %', NEW.content;
        WHEN others THEN
            RAISE EXCEPTION 'Content validation failed: % - Content: %', SQLERRM, NEW.content;
        END;
    END IF;
    
    RETURN NEW;
END;
$function$;

-- Add the validation trigger to messages table
DROP TRIGGER IF EXISTS validate_message_content_trigger ON messages;
CREATE TRIGGER validate_message_content_trigger
    BEFORE INSERT OR UPDATE ON messages
    FOR EACH ROW
    EXECUTE FUNCTION validate_message_content();

COMMIT;