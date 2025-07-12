-- =============================================
-- FIX SERVER DELETION TRIGGER ISSUE
-- =============================================
-- 
-- Problem: When deleting a server, the cascade deletion of user_servers records
-- triggers handle_user_leave() which tries to insert into server_membership_events
-- but the server no longer exists, causing a foreign key constraint violation.
--
-- Solution: 
-- 1. Modify handle_user_leave() to check if the server still exists
-- 2. Create a proper server deletion function that handles cleanup in the right order

-- Fix the trigger function to handle server deletion cascades
CREATE OR REPLACE FUNCTION public.handle_user_leave() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$DECLARE
    default_channel_id UUID;
    event_id UUID;
    user_profile RECORD;
    server_exists BOOLEAN;
BEGIN
    -- Check if the server still exists (might have been deleted)
    SELECT EXISTS(SELECT 1 FROM servers WHERE id = OLD.server_id) INTO server_exists;
    
    -- If server doesn't exist, this is part of server deletion cascade
    -- Don't create membership events or system messages
    IF NOT server_exists THEN
        RETURN OLD;
    END IF;

    -- Get user profile for system message
    SELECT username, display_name, avatar_url 
    INTO user_profile 
    FROM profiles 
    WHERE id = OLD.user_id;

    -- Log the membership event (only if server still exists)
    INSERT INTO server_membership_events (server_id, user_id, event_type, metadata)
    VALUES (OLD.server_id, OLD.user_id, 'leave', jsonb_build_object(
        'left_at', NOW(),
        'username', user_profile.username,
        'display_name', user_profile.display_name
    ))
    RETURNING id INTO event_id;
    
    -- Get default channel for system message
    SELECT get_default_channel(OLD.server_id) INTO default_channel_id;
    
    -- Create system message if default channel exists
    IF default_channel_id IS NOT NULL THEN
        PERFORM create_system_message(default_channel_id, OLD.user_id, 'leave');
    END IF;
    
    RETURN OLD;
END;$$;

-- Create a proper server deletion function
CREATE OR REPLACE FUNCTION public.delete_server_with_cleanup(
    p_server_id UUID,
    p_owner_id UUID
) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    -- Verify ownership
    IF NOT EXISTS(SELECT 1 FROM servers WHERE id = p_server_id AND owner = p_owner_id) THEN
        RAISE EXCEPTION 'Server not found or you are not the owner';
    END IF;
    
    -- Delete in proper order to avoid foreign key issues
    -- The CASCADE constraints will handle most cleanup, but we'll be explicit about the order
    
    -- 1. Delete server membership events first (to avoid trigger issues)
    DELETE FROM server_membership_events WHERE server_id = p_server_id;
    
    -- 2. Delete the server (CASCADE will handle the rest)
    DELETE FROM servers WHERE id = p_server_id AND owner = p_owner_id;
    
    -- If we get here, everything succeeded
END;$$;
