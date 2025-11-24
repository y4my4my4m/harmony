-- Update the add_bot_to_server function to properly save permissions
CREATE OR REPLACE FUNCTION public.add_bot_to_server(
    p_bot_id UUID,
    p_server_id UUID,
    p_installed_by UUID,
    p_permissions JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_permission_id UUID;
BEGIN
    -- Check if user is server owner or admin
    IF NOT EXISTS (
        SELECT 1 FROM public.servers
        JOIN public.profiles ON profiles.id = servers.owner
        WHERE servers.id = p_server_id
        AND profiles.auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Only server owners can add bots';
    END IF;
    
    -- Check if bot is public or owned by installer
    IF NOT EXISTS (
        SELECT 1 FROM public.bots
        JOIN public.profiles ON profiles.id = bots.owner_id
        WHERE bots.id = p_bot_id
        AND (bots.is_public = true OR profiles.auth_user_id = auth.uid())
    ) THEN
        RAISE EXCEPTION 'Bot not found or not accessible';
    END IF;
    
    -- Insert permissions with proper values from p_permissions
    INSERT INTO public.bot_server_permissions (
        bot_id,
        server_id,
        installed_by,
        read_messages,
        send_messages,
        manage_messages,
        embed_links,
        attach_files,
        mention_everyone,
        add_reactions,
        manage_channels,
        kick_members,
        ban_members
    ) VALUES (
        p_bot_id,
        p_server_id,
        p_installed_by,
        COALESCE((p_permissions->>'read_messages')::BOOLEAN, true),
        COALESCE((p_permissions->>'send_messages')::BOOLEAN, true),
        COALESCE((p_permissions->>'manage_messages')::BOOLEAN, false),
        COALESCE((p_permissions->>'embed_links')::BOOLEAN, true),
        COALESCE((p_permissions->>'attach_files')::BOOLEAN, true),
        COALESCE((p_permissions->>'mention_everyone')::BOOLEAN, false),
        COALESCE((p_permissions->>'add_reactions')::BOOLEAN, true),
        COALESCE((p_permissions->>'manage_channels')::BOOLEAN, false),
        COALESCE((p_permissions->>'kick_members')::BOOLEAN, false),
        COALESCE((p_permissions->>'ban_members')::BOOLEAN, false)
    )
    ON CONFLICT (bot_id, server_id)
    DO UPDATE SET 
        is_active = true,
        read_messages = COALESCE((p_permissions->>'read_messages')::BOOLEAN, true),
        send_messages = COALESCE((p_permissions->>'send_messages')::BOOLEAN, true),
        manage_messages = COALESCE((p_permissions->>'manage_messages')::BOOLEAN, false),
        embed_links = COALESCE((p_permissions->>'embed_links')::BOOLEAN, true),
        attach_files = COALESCE((p_permissions->>'attach_files')::BOOLEAN, true),
        mention_everyone = COALESCE((p_permissions->>'mention_everyone')::BOOLEAN, false),
        add_reactions = COALESCE((p_permissions->>'add_reactions')::BOOLEAN, true),
        manage_channels = COALESCE((p_permissions->>'manage_channels')::BOOLEAN, false),
        kick_members = COALESCE((p_permissions->>'kick_members')::BOOLEAN, false),
        ban_members = COALESCE((p_permissions->>'ban_members')::BOOLEAN, false),
        installed_by = p_installed_by,
        installed_at = NOW()
    RETURNING id INTO v_permission_id;
    
    -- Update bot server count
    UPDATE public.bots
    SET server_count = (
        SELECT COUNT(*) FROM public.bot_server_permissions
        WHERE bot_id = p_bot_id AND is_active = true
    )
    WHERE id = p_bot_id;
    
    RETURN v_permission_id;
END;
$$;

