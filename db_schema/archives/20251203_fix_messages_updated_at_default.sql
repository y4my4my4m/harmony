-- Migration: Add default value for messages.updated_at
-- This ensures federated messages don't fail when updated_at is not provided

-- Set default to use created_at via a trigger (since we can't reference another column in DEFAULT)
-- Actually, let's just allow NULL and use COALESCE in the smart trigger

-- Option 1: Allow NULL (simpler, but changes behavior)
-- ALTER TABLE messages ALTER COLUMN updated_at DROP NOT NULL;

-- Option 2: Set a default value of NOW() for new inserts
ALTER TABLE messages ALTER COLUMN updated_at SET DEFAULT NOW();

-- Also, update the handle_messages_updated_at trigger to handle INSERT
-- This ensures updated_at is set to created_at for new messages
CREATE OR REPLACE FUNCTION public.handle_messages_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- For INSERT, set updated_at to created_at if not provided
    IF TG_OP = 'INSERT' THEN
        IF NEW.updated_at IS NULL THEN
            NEW.updated_at := COALESCE(NEW.created_at, NOW());
        END IF;
        RETURN NEW;
    END IF;
    
    -- For UPDATE: Only update updated_at if content-related fields changed, NOT federation_status
    -- This prevents messages from appearing "edited" when only federation_status changes
    IF (
        OLD.content IS DISTINCT FROM NEW.content OR
        OLD.is_deleted IS DISTINCT FROM NEW.is_deleted OR
        OLD.reply_to IS DISTINCT FROM NEW.reply_to
    ) THEN
        NEW.updated_at = NOW();
    ELSE
        -- Preserve the old updated_at for federation-only updates
        NEW.updated_at = OLD.updated_at;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Make sure trigger handles both INSERT and UPDATE
DROP TRIGGER IF EXISTS handle_updated_at ON public.messages;

CREATE TRIGGER handle_updated_at
    BEFORE INSERT OR UPDATE ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_messages_updated_at();

COMMENT ON FUNCTION public.handle_messages_updated_at() IS 
'Handles updated_at for messages: sets default on INSERT, preserves on federation-only UPDATEs.';

