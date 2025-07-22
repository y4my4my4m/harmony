BEGIN;

-- Migration 049: Debug JSON Syntax Error in Messages
-- This migration adds debugging to understand what's causing the JSON error

-- Create a debug function to log the exact data being inserted
CREATE OR REPLACE FUNCTION debug_message_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    -- Log the exact data being inserted
    RAISE WARNING '🔍 DEBUG: Inserting message with data:';
    RAISE WARNING '  ID: %', NEW.id;
    RAISE WARNING '  User ID: %', NEW.user_id;
    RAISE WARNING '  Content type: %', pg_typeof(NEW.content);
    RAISE WARNING '  Content value: %', NEW.content;
    RAISE WARNING '  Content as text: %', NEW.content::text;
    RAISE WARNING '  Metadata type: %', pg_typeof(NEW.metadata);
    RAISE WARNING '  Metadata value: %', NEW.metadata;
    
    -- Try to validate the content as JSON
    BEGIN
        -- Test if content is valid JSON
        PERFORM NEW.content::jsonb;
        RAISE WARNING '  ✅ Content is valid JSONB';
    EXCEPTION
        WHEN OTHERS THEN
            RAISE WARNING '  ❌ Content is INVALID JSON: % - %', SQLSTATE, SQLERRM;
    END;
    
    -- Try to validate the metadata as JSON
    IF NEW.metadata IS NOT NULL THEN
        BEGIN
            -- Test if metadata is valid JSON
            PERFORM NEW.metadata::jsonb;
            RAISE WARNING '  ✅ Metadata is valid JSONB';
        EXCEPTION
            WHEN OTHERS THEN
                RAISE WARNING '  ❌ Metadata is INVALID JSON: % - %', SQLSTATE, SQLERRM;
        END;
    END IF;
    
    RETURN NEW;
END;
$function$;

-- Add debug trigger BEFORE the insert to catch the error
DROP TRIGGER IF EXISTS debug_message_insert_trigger ON messages;
CREATE TRIGGER debug_message_insert_trigger
    BEFORE INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION debug_message_insert();

-- Test the debug function
DO $$
BEGIN
    RAISE NOTICE '🔍 Debug trigger added to messages table';
    RAISE NOTICE 'This will log all message insertions with detailed JSON validation';
END $$;

COMMIT;