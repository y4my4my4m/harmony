-- Debug: Check if check_bot_permission function is working correctly
-- Run this with your bot's actual values

DO $$
DECLARE
    v_bot_id UUID;
    v_server_id UUID;
    v_has_permission BOOLEAN;
BEGIN
    -- Get bot ID
    SELECT id INTO v_bot_id 
    FROM public.bots 
    WHERE username = 'discord-bridge';
    
    -- Get server ID
    SELECT id INTO v_server_id 
    FROM public.servers 
    WHERE name = 'Harmony Local Playground';
    
    RAISE NOTICE 'Bot ID: %', v_bot_id;
    RAISE NOTICE 'Server ID: %', v_server_id;
    
    -- Test the function
    SELECT public.check_bot_permission(v_bot_id, v_server_id, 'send_messages')
    INTO v_has_permission;
    
    RAISE NOTICE 'Has send_messages permission: %', v_has_permission;
    
    -- Also check what the direct query returns
    SELECT send_messages INTO v_has_permission
    FROM public.bot_server_permissions
    WHERE bot_id = v_bot_id 
    AND server_id = v_server_id 
    AND is_active = true;
    
    RAISE NOTICE 'Direct query send_messages: %', v_has_permission;
END $$;

