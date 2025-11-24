-- =====================================================
-- Fix Discord Bridge Bot Permissions
-- Grant send_messages and other necessary permissions
-- =====================================================

-- First, let's find the bot and the channel/server we're working with
DO $$
DECLARE
    v_bot_id UUID;
    v_channel_id UUID := '2015a5fc-4b53-4e83-90aa-f6caee35fa05';
    v_server_id UUID;
    v_owner_id UUID;
    v_existing_perms UUID;
BEGIN
    -- Get the Discord Bridge bot ID
    SELECT id INTO v_bot_id 
    FROM public.bots 
    WHERE username = 'discord-bridge'
    LIMIT 1;
    
    IF v_bot_id IS NULL THEN
        RAISE EXCEPTION 'Discord Bridge bot not found! Please create the bot first in the Harmony UI.';
    END IF;
    
    RAISE NOTICE 'Found Discord Bridge bot: %', v_bot_id;
    
    -- Get the server ID from the channel
    SELECT server_id INTO v_server_id 
    FROM public.channels 
    WHERE id = v_channel_id;
    
    IF v_server_id IS NULL THEN
        RAISE EXCEPTION 'Channel % not found!', v_channel_id;
    END IF;
    
    RAISE NOTICE 'Channel is in server: %', v_server_id;
    
    -- Get the server owner for the installed_by field
    SELECT owner INTO v_owner_id 
    FROM public.servers 
    WHERE id = v_server_id;
    
    RAISE NOTICE 'Server owner: %', v_owner_id;
    
    -- Check if bot already has permissions entry for this server
    SELECT id INTO v_existing_perms
    FROM public.bot_server_permissions
    WHERE bot_id = v_bot_id 
    AND server_id = v_server_id;
    
    IF v_existing_perms IS NOT NULL THEN
        -- Update existing permissions
        RAISE NOTICE 'Updating existing permissions entry: %', v_existing_perms;
        
        UPDATE public.bot_server_permissions
        SET 
            -- Message Permissions
            read_messages = true,
            send_messages = true,
            send_tts_messages = false,
            manage_messages = true,
            embed_links = true,
            attach_files = true,
            read_message_history = true,
            mention_everyone = false,
            use_external_emojis = true,
            add_reactions = true,
            
            -- Channel Permissions
            view_channels = true,
            manage_channels = false,
            manage_webhooks = false,
            
            -- Status
            is_active = true
        WHERE id = v_existing_perms;
        
        RAISE NOTICE '✅ Updated bot permissions for server %', v_server_id;
    ELSE
        -- Create new permissions entry
        RAISE NOTICE 'Creating new permissions entry for server %', v_server_id;
        
        INSERT INTO public.bot_server_permissions (
            bot_id,
            server_id,
            installed_by,
            installed_at,
            
            -- Message Permissions (set defaults for bridge bot)
            read_messages,
            send_messages,
            send_tts_messages,
            manage_messages,
            embed_links,
            attach_files,
            read_message_history,
            mention_everyone,
            use_external_emojis,
            add_reactions,
            
            -- Channel Permissions
            view_channels,
            manage_channels,
            manage_webhooks,
            
            -- Status
            is_active
        ) VALUES (
            v_bot_id,
            v_server_id,
            v_owner_id,
            NOW(),
            
            -- Message Permissions
            true,  -- read_messages
            true,  -- send_messages *** THIS IS THE KEY ONE ***
            false, -- send_tts_messages
            true,  -- manage_messages (for edits/deletes)
            true,  -- embed_links
            true,  -- attach_files
            true,  -- read_message_history
            false, -- mention_everyone
            true,  -- use_external_emojis
            true,  -- add_reactions
            
            -- Channel Permissions
            true,  -- view_channels
            false, -- manage_channels
            false, -- manage_webhooks
            
            -- Status
            true   -- is_active
        );
        
        RAISE NOTICE '✅ Created bot permissions for server %', v_server_id;
    END IF;
    
    -- Verify the permission was set
    PERFORM public.check_bot_permission(v_bot_id, v_server_id, 'send_messages');
    
    IF FOUND THEN
        RAISE NOTICE '✅ Verification: Bot has send_messages permission!';
    ELSE
        RAISE WARNING '⚠️  Verification failed: Bot does not have send_messages permission!';
    END IF;
    
END $$;

-- Show the current permissions for the bot
SELECT 
    b.username AS bot_name,
    s.name AS server_name,
    bsp.read_messages,
    bsp.send_messages,
    bsp.manage_messages,
    bsp.add_reactions,
    bsp.is_active
FROM public.bot_server_permissions bsp
JOIN public.bots b ON b.id = bsp.bot_id
JOIN public.servers s ON s.id = bsp.server_id
WHERE b.username = 'discord-bridge';

