BEGIN;

-- Create a trigger function that inserts a system message when a user joins a server.
-- Uses the server's system_channel_id (from server_settings) or falls back to
-- get_default_channel() to find the appropriate channel.

CREATE OR REPLACE FUNCTION public.handle_member_join_system_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_channel_id uuid;
BEGIN
    -- Only fire for accepted members (skip pending invites)
    IF NEW.status IS NOT NULL AND NEW.status != 'accepted' THEN
        RETURN NEW;
    END IF;

    v_channel_id := get_default_channel(NEW.server_id);

    IF v_channel_id IS NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO messages (channel_id, user_id, content, is_system, metadata)
    VALUES (
        v_channel_id,
        NEW.user_id,
        jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'has joined the server')),
        true,
        jsonb_build_object('type', 'member_join')
    );

    RETURN NEW;
END;
$$;

-- Drop existing trigger if present (idempotent)
DROP TRIGGER IF EXISTS trigger_member_join_system_message ON public.user_servers;

CREATE TRIGGER trigger_member_join_system_message
    AFTER INSERT ON public.user_servers
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_member_join_system_message();

NOTIFY pgrst, 'reload schema';

COMMIT;
