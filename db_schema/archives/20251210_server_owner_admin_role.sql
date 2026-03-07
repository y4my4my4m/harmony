-- =============================================================================
-- Migration: Server Owner Admin Role
-- Date: 2025-12-10
-- Description: 
--   1. Update trigger to auto-create Admin role for server owners
--   2. Create Admin roles for existing servers where missing
--   3. Assign Admin role to existing server owners
-- =============================================================================

-- ---------------------------------------------------------------------------
-- UPDATE TRIGGER FUNCTION
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_default_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    everyone_role_id uuid;
    admin_role_id uuid;
BEGIN
    -- Create @everyone role (default for all members)
    INSERT INTO server_roles (
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
        104324161  -- Default Discord-like permissions
    ) RETURNING id INTO everyone_role_id;
    
    -- Create Admin role for the owner (highest position, all permissions)
    INSERT INTO server_roles (
        server_id,
        name,
        color,
        position,
        is_default,
        is_admin,
        permissions
    ) VALUES (
        NEW.id,
        'Admin',
        '#e74c3c',  -- Red color for admin
        999,        -- High position (owner is always above)
        false,
        true,       -- Mark as admin role
        2199023255551  -- All permissions (ADMINISTRATOR)
    ) RETURNING id INTO admin_role_id;
    
    -- Assign the Admin role to the server owner
    INSERT INTO user_roles (user_id, role_id, server_id)
    VALUES (NEW.owner, admin_role_id, NEW.id)
    ON CONFLICT (user_id, role_id) DO NOTHING;
    
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- CREATE ADMIN ROLES FOR EXISTING SERVERS
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    server_record RECORD;
    new_admin_role_id uuid;
BEGIN
    -- Loop through all servers that don't have an Admin role
    -- Only process servers that have a non-null owner
    FOR server_record IN 
        SELECT s.id, s.owner 
        FROM servers s 
        WHERE s.owner IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM server_roles sr 
            WHERE sr.server_id = s.id AND sr.is_admin = true
        )
    LOOP
        -- Create Admin role for this server
        INSERT INTO server_roles (
            server_id,
            name,
            color,
            position,
            is_default,
            is_admin,
            permissions
        ) VALUES (
            server_record.id,
            'Admin',
            '#e74c3c',
            999,
            false,
            true,
            2199023255551
        ) RETURNING id INTO new_admin_role_id;
        
        -- Assign to owner
        INSERT INTO user_roles (user_id, role_id, server_id)
        VALUES (server_record.owner, new_admin_role_id, server_record.id)
        ON CONFLICT (user_id, role_id) DO NOTHING;
        
        RAISE NOTICE 'Created Admin role for server % and assigned to owner %', 
            server_record.id, server_record.owner;
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- ENSURE EXISTING OWNERS HAVE THEIR ADMIN ROLE
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    server_record RECORD;
    admin_role_id uuid;
BEGIN
    -- For servers that already have an Admin role, ensure owner is assigned
    -- Only process servers that have a non-null owner
    FOR server_record IN 
        SELECT s.id, s.owner, sr.id as admin_role_id
        FROM servers s 
        JOIN server_roles sr ON sr.server_id = s.id AND sr.is_admin = true
        WHERE s.owner IS NOT NULL
    LOOP
        -- Assign admin role to owner if not already assigned
        INSERT INTO user_roles (user_id, role_id, server_id)
        VALUES (server_record.owner, server_record.admin_role_id, server_record.id)
        ON CONFLICT (user_id, role_id) DO NOTHING;
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- LOG SERVERS WITH NULL OWNERS (data quality issue)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    orphan_server RECORD;
BEGIN
    FOR orphan_server IN 
        SELECT id, name FROM servers WHERE owner IS NULL
    LOOP
        RAISE WARNING 'Server % (id: %) has NULL owner - skipped admin role assignment', 
            orphan_server.name, orphan_server.id;
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- NOTIFY COMPLETION
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    RAISE NOTICE 'Server owner Admin role migration completed successfully';
END $$;

