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
    v_username text;
BEGIN
    -- Only fire for accepted members (skip pending invites)
    IF NEW.status IS NOT NULL AND NEW.status != 'accepted' THEN
        RETURN NEW;
    END IF;

    -- Try server_settings.system_channel_id first, fall back to default channel
    SELECT system_channel_id INTO v_channel_id
    FROM server_settings
    WHERE server_id = NEW.server_id;

    IF v_channel_id IS NULL THEN
        v_channel_id := get_default_channel(NEW.server_id);
    END IF;

    IF v_channel_id IS NULL THEN
        RETURN NEW;
    END IF;

    -- Get the joining user's username for the message text
    SELECT COALESCE(display_name, username) INTO v_username
    FROM profiles
    WHERE id = NEW.user_id;

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
