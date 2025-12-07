-- =============================================
-- Server Roles and Permissions System
-- Discord-style role hierarchy with channel overrides
-- Federation-ready with ActivityPub IDs
-- =============================================

-- =============================================
-- 1. Create server_roles table
-- =============================================
CREATE TABLE IF NOT EXISTS "public"."server_roles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "server_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "color" "text" DEFAULT '#99AAB5',
    "hoist" boolean DEFAULT false,
    "mentionable" boolean DEFAULT false,
    "position" integer DEFAULT 0,
    "permissions" "jsonb" DEFAULT '{}'::jsonb NOT NULL,
    "icon_url" "text",
    "unicode_emoji" "text",
    "is_default" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ap_id" "text",
    "federation_metadata" "jsonb" DEFAULT '{}'::jsonb,
    CONSTRAINT "server_roles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "server_roles_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE CASCADE,
    CONSTRAINT "server_roles_name_length" CHECK (char_length(name) >= 1 AND char_length(name) <= 100),
    CONSTRAINT "server_roles_color_format" CHECK (color ~ '^#[0-9A-Fa-f]{6}$')
);

ALTER TABLE "public"."server_roles" OWNER TO "postgres";

COMMENT ON TABLE "public"."server_roles" IS 'Discord-style roles for servers with hierarchical permissions';
COMMENT ON COLUMN "public"."server_roles"."hoist" IS 'Display role members separately in member list';
COMMENT ON COLUMN "public"."server_roles"."mentionable" IS 'Allow anyone to @mention this role';
COMMENT ON COLUMN "public"."server_roles"."position" IS 'Role hierarchy position (higher = more authority)';
COMMENT ON COLUMN "public"."server_roles"."permissions" IS 'JSONB object with permission flags';
COMMENT ON COLUMN "public"."server_roles"."is_default" IS 'True for @everyone role (one per server)';
COMMENT ON COLUMN "public"."server_roles"."ap_id" IS 'ActivityPub ID for federation';

-- Indexes for server_roles
CREATE INDEX IF NOT EXISTS "idx_server_roles_server_id" ON "public"."server_roles"("server_id");
CREATE INDEX IF NOT EXISTS "idx_server_roles_position" ON "public"."server_roles"("server_id", "position" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "idx_server_roles_default" ON "public"."server_roles"("server_id") WHERE "is_default" = true;
CREATE UNIQUE INDEX IF NOT EXISTS "idx_server_roles_ap_id" ON "public"."server_roles"("ap_id") WHERE "ap_id" IS NOT NULL;

-- =============================================
-- 2. Create user_roles junction table
-- NOTE: References profiles.id instead of auth.users.id to support federated users
-- =============================================
CREATE TABLE IF NOT EXISTS "public"."user_roles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "role_id" "uuid" NOT NULL,
    "server_id" "uuid" NOT NULL,
    "assigned_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "assigned_by" "uuid",
    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
    CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "public"."server_roles"("id") ON DELETE CASCADE,
    CONSTRAINT "user_roles_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE CASCADE,
    CONSTRAINT "user_roles_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL,
    CONSTRAINT "user_roles_unique" UNIQUE ("user_id", "role_id")
);

ALTER TABLE "public"."user_roles" OWNER TO "postgres";

COMMENT ON TABLE "public"."user_roles" IS 'Junction table for user-role assignments (references profiles to support federated users)';
COMMENT ON COLUMN "public"."user_roles"."assigned_by" IS 'User who assigned this role (for audit)';

-- Indexes for user_roles
CREATE INDEX IF NOT EXISTS "idx_user_roles_user_id" ON "public"."user_roles"("user_id");
CREATE INDEX IF NOT EXISTS "idx_user_roles_role_id" ON "public"."user_roles"("role_id");
CREATE INDEX IF NOT EXISTS "idx_user_roles_server_id" ON "public"."user_roles"("server_id");
CREATE INDEX IF NOT EXISTS "idx_user_roles_user_server" ON "public"."user_roles"("user_id", "server_id");

-- =============================================
-- 3. Create channel_permission_overrides table
-- =============================================
CREATE TABLE IF NOT EXISTS "public"."channel_permission_overrides" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "channel_id" "uuid" NOT NULL,
    "target_type" "text" NOT NULL,
    "target_id" "uuid" NOT NULL,
    "allow" "jsonb" DEFAULT '{}'::jsonb NOT NULL,
    "deny" "jsonb" DEFAULT '{}'::jsonb NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "channel_permission_overrides_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "channel_permission_overrides_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "public"."channels"("id") ON DELETE CASCADE,
    CONSTRAINT "channel_permission_overrides_target_type_check" CHECK ("target_type" IN ('role', 'user')),
    CONSTRAINT "channel_permission_overrides_unique" UNIQUE ("channel_id", "target_type", "target_id")
);

ALTER TABLE "public"."channel_permission_overrides" OWNER TO "postgres";

COMMENT ON TABLE "public"."channel_permission_overrides" IS 'Channel-specific permission overrides for roles or users';
COMMENT ON COLUMN "public"."channel_permission_overrides"."target_type" IS 'Type of target: role or user';
COMMENT ON COLUMN "public"."channel_permission_overrides"."target_id" IS 'UUID of the role or user';
COMMENT ON COLUMN "public"."channel_permission_overrides"."allow" IS 'Permissions explicitly allowed';
COMMENT ON COLUMN "public"."channel_permission_overrides"."deny" IS 'Permissions explicitly denied';

-- Indexes for channel_permission_overrides
CREATE INDEX IF NOT EXISTS "idx_channel_permission_overrides_channel" ON "public"."channel_permission_overrides"("channel_id");
CREATE INDEX IF NOT EXISTS "idx_channel_permission_overrides_target" ON "public"."channel_permission_overrides"("target_type", "target_id");

-- =============================================
-- 4. Create server_settings table (if not exists)
-- =============================================
CREATE TABLE IF NOT EXISTS "public"."server_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "server_id" "uuid" NOT NULL,
    "default_role_id" "uuid",
    "invite_permissions" "jsonb" DEFAULT '{"who_can_create": "everyone", "default_expiration": 1440, "max_expiration": 0, "allow_temporary": true, "max_uses_limit": 0}'::jsonb,
    "moderation_settings" "jsonb" DEFAULT '{"auto_mod_enabled": false, "spam_filter": false, "link_filter": false}'::jsonb,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "server_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "server_settings_server_id_fkey" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE CASCADE,
    CONSTRAINT "server_settings_server_id_unique" UNIQUE ("server_id")
);

ALTER TABLE "public"."server_settings" OWNER TO "postgres";

COMMENT ON TABLE "public"."server_settings" IS 'Server-wide settings including default permissions';

-- =============================================
-- 5. Function to create default @everyone role
-- =============================================
CREATE OR REPLACE FUNCTION "public"."create_default_server_role"()
RETURNS TRIGGER AS $$
DECLARE
    new_role_id uuid;
BEGIN
    -- Create the @everyone role for the new server
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
    ) RETURNING id INTO new_role_id;
    
    -- Create server settings with default role
    INSERT INTO "public"."server_settings" (server_id, default_role_id)
    VALUES (NEW.id, new_role_id)
    ON CONFLICT (server_id) DO UPDATE SET default_role_id = new_role_id;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to create default role when server is created
DROP TRIGGER IF EXISTS "trigger_create_default_role" ON "public"."servers";
CREATE TRIGGER "trigger_create_default_role"
    AFTER INSERT ON "public"."servers"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."create_default_server_role"();

-- =============================================
-- 6. Function to auto-assign default role to new members
-- =============================================
CREATE OR REPLACE FUNCTION "public"."assign_default_role_to_member"()
RETURNS TRIGGER AS $$
DECLARE
    default_role_id uuid;
    user_exists boolean;
BEGIN
    -- Only assign if status is 'accepted'
    IF NEW.status = 'accepted' THEN
        -- Check if user exists in profiles (required for foreign key)
        SELECT EXISTS(SELECT 1 FROM "public"."profiles" WHERE id = NEW.user_id) INTO user_exists;
        
        IF NOT user_exists THEN
            -- User doesn't exist in profiles (orphaned record or data issue)
            RETURN NEW;
        END IF;
        
        -- Get the default role for this server
        SELECT id INTO default_role_id
        FROM "public"."server_roles"
        WHERE server_id = NEW.server_id AND is_default = true
        LIMIT 1;
        
        -- Assign the default role if found
        IF default_role_id IS NOT NULL THEN
            INSERT INTO "public"."user_roles" (user_id, role_id, server_id)
            VALUES (NEW.user_id, default_role_id, NEW.server_id)
            ON CONFLICT (user_id, role_id) DO NOTHING;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to assign default role when member joins
DROP TRIGGER IF EXISTS "trigger_assign_default_role" ON "public"."user_servers";
CREATE TRIGGER "trigger_assign_default_role"
    AFTER INSERT OR UPDATE OF status ON "public"."user_servers"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."assign_default_role_to_member"();

-- =============================================
-- 7. Function to calculate user permissions
-- =============================================
CREATE OR REPLACE FUNCTION "public"."get_user_permissions"(
    p_user_id uuid,
    p_server_id uuid,
    p_channel_id uuid DEFAULT NULL
)
RETURNS jsonb AS $$
DECLARE
    v_is_owner boolean;
    v_base_permissions jsonb := '{}'::jsonb;
    v_channel_allows jsonb := '{}'::jsonb;
    v_channel_denies jsonb := '{}'::jsonb;
    v_final_permissions jsonb;
    v_role record;
    v_override record;
BEGIN
    -- Check if user is server owner
    SELECT (owner = p_user_id) INTO v_is_owner
    FROM "public"."servers"
    WHERE id = p_server_id;
    
    -- Server owner has all permissions
    IF v_is_owner THEN
        RETURN jsonb_build_object(
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
            'PIN_MESSAGES', true
        );
    END IF;
    
    -- Start with @everyone role permissions as base
    SELECT permissions INTO v_base_permissions
    FROM "public"."server_roles"
    WHERE server_id = p_server_id AND is_default = true;
    
    v_base_permissions := COALESCE(v_base_permissions, '{}'::jsonb);
    
    -- Collect permissions from all user's roles (ordered by position)
    -- Merge on top of @everyone (higher position roles can override)
    FOR v_role IN
        SELECT sr.permissions, sr.position
        FROM "public"."user_roles" ur
        JOIN "public"."server_roles" sr ON ur.role_id = sr.id
        WHERE ur.user_id = p_user_id AND ur.server_id = p_server_id
        ORDER BY sr.position ASC
    LOOP
        -- Merge permissions (higher position roles can override)
        v_base_permissions := v_base_permissions || v_role.permissions;
    END LOOP;
    
    -- If ADMINISTRATOR permission is set, grant all permissions
    IF (v_base_permissions->>'ADMINISTRATOR')::boolean = true THEN
        RETURN jsonb_build_object(
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
            'PIN_MESSAGES', true
        );
    END IF;
    
    -- Apply channel-specific overrides if channel_id is provided
    IF p_channel_id IS NOT NULL THEN
        -- Get role-based overrides (collect all allows and denies)
        FOR v_override IN
            SELECT cpo.allow, cpo.deny
            FROM "public"."channel_permission_overrides" cpo
            JOIN "public"."user_roles" ur ON cpo.target_id = ur.role_id AND cpo.target_type = 'role'
            WHERE cpo.channel_id = p_channel_id AND ur.user_id = p_user_id
        LOOP
            v_channel_allows := v_channel_allows || v_override.allow;
            v_channel_denies := v_channel_denies || v_override.deny;
        END LOOP;
        
        -- Get user-specific overrides (highest priority)
        SELECT allow, deny INTO v_override
        FROM "public"."channel_permission_overrides"
        WHERE channel_id = p_channel_id AND target_type = 'user' AND target_id = p_user_id;
        
        IF FOUND THEN
            v_channel_allows := v_channel_allows || v_override.allow;
            v_channel_denies := v_channel_denies || v_override.deny;
        END IF;
        
        -- Apply overrides: base + allows - denies
        v_final_permissions := v_base_permissions || v_channel_allows;
        
        -- Remove denied permissions
        SELECT jsonb_object_agg(key, value)
        INTO v_final_permissions
        FROM jsonb_each(v_final_permissions) 
        WHERE NOT (v_channel_denies ? key AND (v_channel_denies->>key)::boolean = true);
        
        RETURN COALESCE(v_final_permissions, '{}'::jsonb);
    END IF;
    
    RETURN v_base_permissions;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

COMMENT ON FUNCTION "public"."get_user_permissions"(uuid, uuid, uuid) IS 'Calculate effective permissions for a user in a server/channel';

-- =============================================
-- 8. Function to check specific permission
-- =============================================
CREATE OR REPLACE FUNCTION "public"."has_permission"(
    p_user_id uuid,
    p_server_id uuid,
    p_permission text,
    p_channel_id uuid DEFAULT NULL
)
RETURNS boolean AS $$
DECLARE
    v_permissions jsonb;
BEGIN
    v_permissions := "public"."get_user_permissions"(p_user_id, p_server_id, p_channel_id);
    RETURN COALESCE((v_permissions->>p_permission)::boolean, false);
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER;

COMMENT ON FUNCTION "public"."has_permission"(uuid, uuid, text, uuid) IS 'Check if user has a specific permission';

-- =============================================
-- 9. Updated_at trigger for roles tables
-- =============================================
CREATE OR REPLACE FUNCTION "public"."update_roles_updated_at"()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trigger_server_roles_updated_at" ON "public"."server_roles";
CREATE TRIGGER "trigger_server_roles_updated_at"
    BEFORE UPDATE ON "public"."server_roles"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."update_roles_updated_at"();

DROP TRIGGER IF EXISTS "trigger_channel_overrides_updated_at" ON "public"."channel_permission_overrides";
CREATE TRIGGER "trigger_channel_overrides_updated_at"
    BEFORE UPDATE ON "public"."channel_permission_overrides"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."update_roles_updated_at"();

DROP TRIGGER IF EXISTS "trigger_server_settings_updated_at" ON "public"."server_settings";
CREATE TRIGGER "trigger_server_settings_updated_at"
    BEFORE UPDATE ON "public"."server_settings"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."update_roles_updated_at"();

-- =============================================
-- 10. RLS Policies for server_roles
-- =============================================
ALTER TABLE "public"."server_roles" ENABLE ROW LEVEL SECURITY;

-- Anyone can view roles of servers they're a member of
DROP POLICY IF EXISTS "Users can view server roles" ON "public"."server_roles";
CREATE POLICY "Users can view server roles" ON "public"."server_roles"
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM "public"."user_servers" us
            WHERE us.server_id = server_roles.server_id
            AND us.user_id = auth.uid()
            AND us.status = 'accepted'
        )
        OR
        EXISTS (
            SELECT 1 FROM "public"."servers" s
            WHERE s.id = server_roles.server_id AND s.public = true
        )
    );

-- Only users with MANAGE_ROLES can create roles
DROP POLICY IF EXISTS "Users with MANAGE_ROLES can create roles" ON "public"."server_roles";
CREATE POLICY "Users with MANAGE_ROLES can create roles" ON "public"."server_roles"
    FOR INSERT
    WITH CHECK (
        "public"."has_permission"(auth.uid(), server_id, 'MANAGE_ROLES')
    );

-- Only users with MANAGE_ROLES can update roles (respecting hierarchy)
DROP POLICY IF EXISTS "Users with MANAGE_ROLES can update roles" ON "public"."server_roles";
CREATE POLICY "Users with MANAGE_ROLES can update roles" ON "public"."server_roles"
    FOR UPDATE
    USING (
        "public"."has_permission"(auth.uid(), server_id, 'MANAGE_ROLES')
        AND NOT is_default  -- Cannot modify @everyone directly through this
    );

-- Only users with MANAGE_ROLES can delete roles
DROP POLICY IF EXISTS "Users with MANAGE_ROLES can delete roles" ON "public"."server_roles";
CREATE POLICY "Users with MANAGE_ROLES can delete roles" ON "public"."server_roles"
    FOR DELETE
    USING (
        "public"."has_permission"(auth.uid(), server_id, 'MANAGE_ROLES')
        AND NOT is_default  -- Cannot delete @everyone role
    );

-- =============================================
-- 11. RLS Policies for user_roles
-- =============================================
ALTER TABLE "public"."user_roles" ENABLE ROW LEVEL SECURITY;

-- Anyone can view role assignments for servers they're in
DROP POLICY IF EXISTS "Users can view role assignments" ON "public"."user_roles";
CREATE POLICY "Users can view role assignments" ON "public"."user_roles"
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM "public"."user_servers" us
            WHERE us.server_id = user_roles.server_id
            AND us.user_id = auth.uid()
            AND us.status = 'accepted'
        )
    );

-- Only users with MANAGE_ROLES can assign roles
DROP POLICY IF EXISTS "Users with MANAGE_ROLES can assign roles" ON "public"."user_roles";
CREATE POLICY "Users with MANAGE_ROLES can assign roles" ON "public"."user_roles"
    FOR INSERT
    WITH CHECK (
        "public"."has_permission"(auth.uid(), server_id, 'MANAGE_ROLES')
    );

-- Only users with MANAGE_ROLES can remove role assignments
DROP POLICY IF EXISTS "Users with MANAGE_ROLES can remove roles" ON "public"."user_roles";
CREATE POLICY "Users with MANAGE_ROLES can remove roles" ON "public"."user_roles"
    FOR DELETE
    USING (
        "public"."has_permission"(auth.uid(), server_id, 'MANAGE_ROLES')
    );

-- =============================================
-- 12. RLS Policies for channel_permission_overrides
-- =============================================
ALTER TABLE "public"."channel_permission_overrides" ENABLE ROW LEVEL SECURITY;

-- Users can view overrides for channels in servers they're in
DROP POLICY IF EXISTS "Users can view channel overrides" ON "public"."channel_permission_overrides";
CREATE POLICY "Users can view channel overrides" ON "public"."channel_permission_overrides"
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM "public"."channels" c
            JOIN "public"."user_servers" us ON us.server_id = c.server_id
            WHERE c.id = channel_permission_overrides.channel_id
            AND us.user_id = auth.uid()
            AND us.status = 'accepted'
        )
    );

-- Only users with MANAGE_CHANNELS can modify overrides
DROP POLICY IF EXISTS "Users with MANAGE_CHANNELS can manage overrides" ON "public"."channel_permission_overrides";
CREATE POLICY "Users with MANAGE_CHANNELS can manage overrides" ON "public"."channel_permission_overrides"
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM "public"."channels" c
            WHERE c.id = channel_permission_overrides.channel_id
            AND "public"."has_permission"(auth.uid(), c.server_id, 'MANAGE_CHANNELS')
        )
    );

-- =============================================
-- 13. RLS Policies for server_settings
-- =============================================
ALTER TABLE "public"."server_settings" ENABLE ROW LEVEL SECURITY;

-- Anyone in the server can view settings
DROP POLICY IF EXISTS "Users can view server settings" ON "public"."server_settings";
CREATE POLICY "Users can view server settings" ON "public"."server_settings"
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM "public"."user_servers" us
            WHERE us.server_id = server_settings.server_id
            AND us.user_id = auth.uid()
            AND us.status = 'accepted'
        )
    );

-- Only users with MANAGE_SERVER can modify settings
DROP POLICY IF EXISTS "Users with MANAGE_SERVER can manage settings" ON "public"."server_settings";
CREATE POLICY "Users with MANAGE_SERVER can manage settings" ON "public"."server_settings"
    FOR ALL
    USING (
        "public"."has_permission"(auth.uid(), server_id, 'MANAGE_SERVER')
    );

-- =============================================
-- 14. Grant permissions
-- =============================================
GRANT ALL ON "public"."server_roles" TO "authenticated";
GRANT ALL ON "public"."server_roles" TO "service_role";
GRANT ALL ON "public"."user_roles" TO "authenticated";
GRANT ALL ON "public"."user_roles" TO "service_role";
GRANT ALL ON "public"."channel_permission_overrides" TO "authenticated";
GRANT ALL ON "public"."channel_permission_overrides" TO "service_role";
GRANT ALL ON "public"."server_settings" TO "authenticated";
GRANT ALL ON "public"."server_settings" TO "service_role";

-- =============================================
-- 15. Create default roles for existing servers
-- =============================================
DO $$
DECLARE
    v_server record;
    v_role_id uuid;
BEGIN
    -- Loop through all servers that don't have a default role
    FOR v_server IN
        SELECT s.id
        FROM "public"."servers" s
        WHERE NOT EXISTS (
            SELECT 1 FROM "public"."server_roles" sr
            WHERE sr.server_id = s.id AND sr.is_default = true
        )
    LOOP
        -- Create default @everyone role
        INSERT INTO "public"."server_roles" (
            server_id, name, color, position, is_default, permissions
        ) VALUES (
            v_server.id,
            '@everyone',
            '#99AAB5',
            0,
            true,
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
        ) RETURNING id INTO v_role_id;
        
        -- Create or update server settings
        INSERT INTO "public"."server_settings" (server_id, default_role_id)
        VALUES (v_server.id, v_role_id)
        ON CONFLICT (server_id) DO UPDATE SET default_role_id = v_role_id;
        
        -- Assign default role to all existing members (only those with valid profile records)
        INSERT INTO "public"."user_roles" (user_id, role_id, server_id)
        SELECT us.user_id, v_role_id, us.server_id
        FROM "public"."user_servers" us
        JOIN "public"."profiles" p ON p.id = us.user_id
        WHERE us.server_id = v_server.id AND us.status = 'accepted'
        ON CONFLICT (user_id, role_id) DO NOTHING;
    END LOOP;
END $$;

-- =============================================
-- 16. Realtime subscriptions
-- =============================================
-- Add tables to realtime publication if not already present
DO $$
BEGIN
    -- Add server_roles if not already in publication
    IF NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'server_roles'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE "public"."server_roles";
    END IF;
    
    -- Add user_roles if not already in publication
    IF NOT EXISTS (
        SELECT 1
        FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = 'user_roles'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE "public"."user_roles";
    END IF;
END $$;

