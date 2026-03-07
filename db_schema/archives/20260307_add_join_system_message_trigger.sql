BEGIN;

-- Create a trigger function that inserts a system message when a user joins a server.
-- Uses server_settings.system_channel_id, falling back to get_default_channel().

CREATE OR REPLACE FUNCTION public.handle_member_join_system_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_channel_id uuid;
BEGIN
    IF NEW.status IS NOT NULL AND NEW.status != 'accepted' THEN
        RETURN NEW;
    END IF;

    SELECT system_channel_id INTO v_channel_id
    FROM server_settings
    WHERE server_id = NEW.server_id;

    IF v_channel_id IS NULL THEN
        v_channel_id := get_default_channel(NEW.server_id);
    END IF;

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

-- Also update trigger_create_default_server_structure to auto-create server_settings
CREATE OR REPLACE FUNCTION public.trigger_create_default_server_structure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_text_category_id uuid;
    v_voice_category_id uuid;
    v_general_channel_id uuid;
BEGIN
    INSERT INTO channel_categories (server_id, name, "order")
    VALUES (NEW.id, 'Text Channels', 0)
    RETURNING id INTO v_text_category_id;
    
    INSERT INTO channels (server_id, name, type, category, "order")
    VALUES (NEW.id, 'general', 0, v_text_category_id, 0)
    RETURNING id INTO v_general_channel_id;
    
    INSERT INTO channel_categories (server_id, name, "order")
    VALUES (NEW.id, 'Voice Channels', 1)
    RETURNING id INTO v_voice_category_id;
    
    INSERT INTO channels (server_id, name, type, category, "order")
    VALUES (NEW.id, 'General', 1, v_voice_category_id, 0);
    
    INSERT INTO server_settings (server_id, system_channel_id)
    VALUES (NEW.id, v_general_channel_id)
    ON CONFLICT (server_id) DO UPDATE SET system_channel_id = EXCLUDED.system_channel_id;
    
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_member_join_system_message ON public.user_servers;

CREATE TRIGGER trigger_member_join_system_message
    AFTER INSERT ON public.user_servers
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_member_join_system_message();

NOTIFY pgrst, 'reload schema';

COMMIT;
