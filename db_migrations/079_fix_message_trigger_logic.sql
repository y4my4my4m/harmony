-- Drop any broken triggers from my mistakes
DROP TRIGGER IF EXISTS trg_handle_messages ON messages;
DROP TRIGGER IF EXISTS trg_handle_message_federation ON messages;
DROP TRIGGER IF EXISTS trg_handle_outgoing_messages ON messages;

-- Drop the broken handle_messages function that tries to call trigger functions
DROP FUNCTION IF EXISTS handle_messages();



BEGIN;

-- =================================================================
-- CREATE: Central Message Dispatcher (Enterprise Pattern)
-- =================================================================

CREATE OR REPLACE FUNCTION public.handle_messages()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public
AS $function$
DECLARE
    v_is_federated BOOLEAN;
BEGIN
    -- Check if this is a federated (incoming) message
    v_is_federated := (NEW.metadata->>'federated' = 'true');
    
    IF v_is_federated THEN
        -- This is an incoming federated message
        RETURN handle_incoming_messages();
    ELSE
        -- This is an outgoing local message
        RETURN handle_outgoing_messages();
    END IF;
END;
$function$;

-- =================================================================
-- UPDATE: Trigger to use dispatcher
-- =================================================================

-- Create new trigger using dispatcher
CREATE TRIGGER trg_handle_messages
    AFTER INSERT ON messages
    FOR EACH ROW
    EXECUTE FUNCTION handle_messages();

-- Log completion
DO $$
BEGIN
    RAISE WARNING '✅ Migration 079: Created handle_messages() dispatcher - keeps existing functions unchanged';
END $$;

COMMIT; 