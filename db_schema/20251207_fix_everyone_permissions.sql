-- =============================================
-- Fix @everyone Role Default Permissions
-- Add more permissive defaults like Discord
-- =============================================

-- Update the create_default_server_role function with full default permissions
-- This function creates both @everyone and Admin roles for new servers
CREATE OR REPLACE FUNCTION "public"."create_default_server_role"()
RETURNS TRIGGER AS $$
DECLARE
    everyone_role_id uuid;
    admin_role_id uuid;
BEGIN
    -- Create @everyone role with Discord-like default permissions
    INSERT INTO "public"."server_roles" (
        server_id,
        name,
        color,
        position,
        is_default,
        is_admin,
        permissions
    ) VALUES (
        NEW.id,
        '@everyone',
        '#99AAB5',
        0,
        true,
        false,
        jsonb_build_object(
            -- General Permissions
            'VIEW_CHANNEL', true,
            'CREATE_INVITE', true,
            'CHANGE_NICKNAME', true,
            
            -- Text Channel Permissions
            'SEND_MESSAGES', true,
            'SEND_MESSAGES_IN_THREADS', true,
            'CREATE_PUBLIC_THREADS', true,
            'CREATE_PRIVATE_THREADS', true,
            'EMBED_LINKS', true,
            'ATTACH_FILES', true,
            'ADD_REACTIONS', true,
            'USE_EXTERNAL_EMOJIS', true,
            'USE_EXTERNAL_STICKERS', true,
            'READ_MESSAGE_HISTORY', true,
            'USE_APPLICATION_COMMANDS', true,
            
            -- Voice Channel Permissions
            'CONNECT', true,
            'SPEAK', true,
            'STREAM', true,
            'USE_VAD', true,
            'USE_SOUNDBOARD', true,
            'USE_EXTERNAL_SOUNDS', true
        )
    ) RETURNING id INTO everyone_role_id;
    
    -- Create the Admin role for the new server
    INSERT INTO "public"."server_roles" (
        server_id,
        name,
        color,
        position,
        hoist,
        is_default,
        is_admin,
        permissions
    ) VALUES (
        NEW.id,
        'Admin',
        '#E74C3C',
        999,  -- High position for hierarchy
        true, -- Display separately in member list
        false,
        true,
        jsonb_build_object(
            'ADMINISTRATOR', true,
            'VIEW_CHANNEL', true,
            'MANAGE_CHANNELS', true,
            'MANAGE_ROLES', true,
            'MANAGE_EMOJIS', true,
            'VIEW_AUDIT_LOG', true,
            'MANAGE_WEBHOOKS', true,
            'MANAGE_SERVER', true,
            'CREATE_INVITE', true,
            'CHANGE_NICKNAME', true,
            'MANAGE_NICKNAMES', true,
            'KICK_MEMBERS', true,
            'BAN_MEMBERS', true,
            'TIMEOUT_MEMBERS', true,
            'SEND_MESSAGES', true,
            'SEND_MESSAGES_IN_THREADS', true,
            'CREATE_PUBLIC_THREADS', true,
            'CREATE_PRIVATE_THREADS', true,
            'EMBED_LINKS', true,
            'ATTACH_FILES', true,
            'ADD_REACTIONS', true,
            'USE_EXTERNAL_EMOJIS', true,
            'MENTION_EVERYONE', true,
            'MANAGE_MESSAGES', true,
            'READ_MESSAGE_HISTORY', true,
            'SEND_TTS_MESSAGES', true,
            'CONNECT', true,
            'SPEAK', true,
            'STREAM', true,
            'USE_VAD', true,
            'PRIORITY_SPEAKER', true,
            'MUTE_MEMBERS', true,
            'DEAFEN_MEMBERS', true,
            'MOVE_MEMBERS', true,
            'PIN_MESSAGES', true,
            'MANAGE_THREADS', true
        )
    ) RETURNING id INTO admin_role_id;
    
    -- Assign Admin role to server owner
    -- Check if owner exists in profiles first
    IF EXISTS (SELECT 1 FROM "public"."profiles" WHERE id = NEW.owner) THEN
        INSERT INTO "public"."user_roles" (user_id, role_id, server_id)
        VALUES (NEW.owner, admin_role_id, NEW.id)
        ON CONFLICT (user_id, role_id) DO NOTHING;
    END IF;
    
    -- Create server settings with default role
    INSERT INTO "public"."server_settings" (server_id, default_role_id)
    VALUES (NEW.id, everyone_role_id)
    ON CONFLICT (server_id) DO UPDATE SET default_role_id = everyone_role_id;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update existing @everyone roles to have proper permissions
UPDATE "public"."server_roles"
SET permissions = jsonb_build_object(
    -- General Permissions
    'VIEW_CHANNEL', true,
    'CREATE_INVITE', true,
    'CHANGE_NICKNAME', true,
    
    -- Text Channel Permissions
    'SEND_MESSAGES', true,
    'SEND_MESSAGES_IN_THREADS', true,
    'CREATE_PUBLIC_THREADS', true,
    'CREATE_PRIVATE_THREADS', true,
    'EMBED_LINKS', true,
    'ATTACH_FILES', true,
    'ADD_REACTIONS', true,
    'USE_EXTERNAL_EMOJIS', true,
    'USE_EXTERNAL_STICKERS', true,
    'READ_MESSAGE_HISTORY', true,
    'USE_APPLICATION_COMMANDS', true,
    
    -- Voice Channel Permissions
    'CONNECT', true,
    'SPEAK', true,
    'STREAM', true,
    'USE_VAD', true,
    'USE_SOUNDBOARD', true,
    'USE_EXTERNAL_SOUNDS', true
)
WHERE is_default = true;

-- Grant execute on function
GRANT EXECUTE ON FUNCTION "public"."create_default_server_role"() TO authenticated;
GRANT EXECUTE ON FUNCTION "public"."create_default_server_role"() TO service_role;

