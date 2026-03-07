-- =============================================
-- Add Admin Role to Servers
-- Creates a non-deletable Admin role and assigns it to server owners
-- =============================================

-- Add is_admin column to server_roles to prevent deletion
ALTER TABLE "public"."server_roles" 
ADD COLUMN IF NOT EXISTS "is_admin" boolean DEFAULT false;

COMMENT ON COLUMN "public"."server_roles"."is_admin" IS 'True for the admin role (non-deletable, one per server)';

-- Create unique index for admin role (one per server)
CREATE UNIQUE INDEX IF NOT EXISTS "idx_server_roles_admin" 
ON "public"."server_roles"("server_id") WHERE "is_admin" = true;

-- =============================================
-- Update create_default_server_role function to also create Admin role
-- =============================================
CREATE OR REPLACE FUNCTION "public"."create_default_server_role"()
RETURNS TRIGGER AS $$
DECLARE
    everyone_role_id uuid;
    admin_role_id uuid;
BEGIN
    -- Create the @everyone role for the new server
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
            'VIEW_CHANNEL', true,
            'SEND_MESSAGES', true,
            'READ_MESSAGE_HISTORY', true,
            'ADD_REACTIONS', true,
            'USE_EXTERNAL_EMOJIS', true,
            'ATTACH_FILES', true,
            'EMBED_LINKS', true,
            'CONNECT', true,
            'SPEAK', true,
            'USE_VAD', true,
            'CREATE_INVITE', true
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

-- =============================================
-- Prevent deletion of admin and default roles
-- =============================================
CREATE OR REPLACE FUNCTION "public"."prevent_protected_role_deletion"()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.is_admin = true THEN
        RAISE EXCEPTION 'Cannot delete the Admin role. This role is protected.';
    END IF;
    
    IF OLD.is_default = true THEN
        RAISE EXCEPTION 'Cannot delete the @everyone role. This role is protected.';
    END IF;
    
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trigger_prevent_protected_role_deletion" ON "public"."server_roles";
CREATE TRIGGER "trigger_prevent_protected_role_deletion"
    BEFORE DELETE ON "public"."server_roles"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."prevent_protected_role_deletion"();

-- =============================================
-- Prevent modification of is_admin and is_default flags
-- =============================================
CREATE OR REPLACE FUNCTION "public"."prevent_protected_role_modification"()
RETURNS TRIGGER AS $$
BEGIN
    -- Prevent changing is_admin flag
    IF OLD.is_admin = true AND NEW.is_admin = false THEN
        RAISE EXCEPTION 'Cannot remove admin status from the Admin role.';
    END IF;
    
    -- Prevent changing is_default flag  
    IF OLD.is_default = true AND NEW.is_default = false THEN
        RAISE EXCEPTION 'Cannot remove default status from the @everyone role.';
    END IF;
    
    -- Prevent renaming protected roles
    IF (OLD.is_admin = true OR OLD.is_default = true) AND OLD.name != NEW.name THEN
        RAISE EXCEPTION 'Cannot rename protected roles.';
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trigger_prevent_protected_role_modification" ON "public"."server_roles";
CREATE TRIGGER "trigger_prevent_protected_role_modification"
    BEFORE UPDATE ON "public"."server_roles"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."prevent_protected_role_modification"();

-- =============================================
-- Create Admin roles for existing servers
-- =============================================
DO $$
DECLARE
    server_record RECORD;
    admin_role_id uuid;
BEGIN
    -- For each existing server without an admin role
    FOR server_record IN 
        SELECT s.id, s.owner
        FROM "public"."servers" s
        WHERE NOT EXISTS (
            SELECT 1 FROM "public"."server_roles" sr 
            WHERE sr.server_id = s.id AND sr.is_admin = true
        )
    LOOP
        -- Create admin role
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
            server_record.id,
            'Admin',
            '#E74C3C',
            999,
            true,
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
        
        -- Assign admin role to server owner (if owner exists in profiles)
        IF EXISTS (SELECT 1 FROM "public"."profiles" WHERE id = server_record.owner) THEN
            INSERT INTO "public"."user_roles" (user_id, role_id, server_id)
            VALUES (server_record.owner, admin_role_id, server_record.id)
            ON CONFLICT (user_id, role_id) DO NOTHING;
        END IF;
        
        RAISE NOTICE 'Created Admin role for server %', server_record.id;
    END LOOP;
END $$;

-- Grant necessary permissions
ALTER FUNCTION "public"."create_default_server_role"() OWNER TO "supabase_admin";
ALTER FUNCTION "public"."prevent_protected_role_deletion"() OWNER TO "supabase_admin";
ALTER FUNCTION "public"."prevent_protected_role_modification"() OWNER TO "supabase_admin";

