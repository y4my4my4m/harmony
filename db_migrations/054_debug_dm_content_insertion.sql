-- Debug Migration: Log DM content format being inserted

CREATE OR REPLACE FUNCTION debug_dm_content_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    -- Only log DM messages
    IF NEW.conversation_id IS NOT NULL THEN
        RAISE WARNING '🔍 DM Content Debug - Message ID: %, Content Type: %, Content Value: %', 
            NEW.id, 
            pg_typeof(NEW.content),
            NEW.content;
            
        -- Check if content is text (which shouldn't happen)
        IF pg_typeof(NEW.content) = 'text'::regtype THEN
            RAISE WARNING '❌ DM Content is TEXT instead of JSONB! Raw value: %', NEW.content;
        END IF;
        
        -- Check if content is valid JSONB array
        IF jsonb_typeof(NEW.content) != 'array' THEN
            RAISE WARNING '❌ DM Content is not JSONB array! Type: %, Value: %', 
                jsonb_typeof(NEW.content), NEW.content;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$function$;

-- Create trigger to debug content insertion
DROP TRIGGER IF EXISTS trigger_debug_dm_content_insert ON messages;
CREATE TRIGGER trigger_debug_dm_content_insert
    BEFORE INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION debug_dm_content_insert();

-- This trigger will log exactly what content format is being inserted
-- Run this and try sending a DM to see the debug output