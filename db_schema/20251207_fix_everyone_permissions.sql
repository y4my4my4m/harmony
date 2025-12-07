-- =============================================
-- Fix @everyone Role Default Permissions
-- Add more permissive defaults like Discord
-- =============================================

-- Update the create_default_server_role function with full default permissions
CREATE OR REPLACE FUNCTION "public"."create_default_server_role"()
RETURNS TRIGGER AS $$
DECLARE
    new_role_id uuid;
BEGIN
    -- Create @everyone role with Discord-like default permissions
    INSERT INTO "public"."server_roles" (
        server_id,
        name,
        color,
        position,
        is_default,
        permissions
    ) VALUES (
        NEW.id,
        '@everyone',
        '#99AAB5',
        0,
        true,
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
    ) RETURNING id INTO new_role_id;
    
    -- Create server settings with default role
    INSERT INTO "public"."server_settings" (server_id, default_role_id)
    VALUES (NEW.id, new_role_id)
    ON CONFLICT (server_id) DO UPDATE SET default_role_id = new_role_id;
    
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

