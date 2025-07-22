BEGIN;

-- Temporary Debug Migration 051: Log DM Content Format
-- This will help us see exactly what data is being inserted

CREATE OR REPLACE FUNCTION debug_dm_content_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    -- Only log DM messages
    IF NEW.conversation_id IS NOT NULL THEN
        RAISE WARNING '🔍 DM DEBUG: Message ID: %', NEW.id;
        RAISE WARNING '🔍 DM DEBUG: Content Type: %', pg_typeof(NEW.content);
        RAISE WARNING '🔍 DM DEBUG: Content Raw: %', NEW.content;
        RAISE WARNING '🔍 DM DEBUG: Content as Text: %', NEW.content::text;
        RAISE WARNING '🔍 DM DEBUG: User ID: %', NEW.user_id;
        RAISE WARNING '🔍 DM DEBUG: Conversation ID: %', NEW.conversation_id;
        
        -- Try to parse as JSONB array
        BEGIN
            IF jsonb_typeof(NEW.content) = 'array' THEN
                RAISE WARNING '🔍 DM DEBUG: ✅ Content is valid JSONB array with % elements', jsonb_array_length(NEW.content);
                
                -- Log each element
                FOR i IN 0..(jsonb_array_length(NEW.content) - 1) LOOP
                    RAISE WARNING '🔍 DM DEBUG: Element %: %', i, NEW.content->i;
                END LOOP;
            ELSE
                RAISE WARNING '🔍 DM DEBUG: ❌ Content is not a JSONB array: %', jsonb_typeof(NEW.content);
            END IF;
        EXCEPTION
            WHEN OTHERS THEN
                RAISE WARNING '🔍 DM DEBUG: ❌ JSONB parsing failed: % - %', SQLSTATE, SQLERRM;
        END;
    END IF;
    
    RETURN NEW;
END;
$function$;

-- Add debug trigger
DROP TRIGGER IF EXISTS debug_dm_content_trigger ON messages;
CREATE TRIGGER debug_dm_content_trigger
    BEFORE INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION debug_dm_content_insert();

-- This trigger will be removed once we identify the issue
COMMENT ON FUNCTION debug_dm_content_insert() IS 'Temporary debug function - will be removed once DM content format issue is resolved';

COMMIT;