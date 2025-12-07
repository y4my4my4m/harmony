-- =============================================
-- FIX: Update user_roles foreign key to reference profiles instead of auth.users
-- This allows federated users (who exist in profiles but not auth.users) to have roles
-- Run this AFTER the initial migration failed
-- =============================================

-- 1. Drop the existing user_roles table (if it exists)
DROP TABLE IF EXISTS "public"."user_roles" CASCADE;

-- 2. Recreate with correct foreign key to profiles.id
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

-- 3. RLS Policies for user_roles
ALTER TABLE "public"."user_roles" ENABLE ROW LEVEL SECURITY;

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

DROP POLICY IF EXISTS "Users with MANAGE_ROLES can assign roles" ON "public"."user_roles";
CREATE POLICY "Users with MANAGE_ROLES can assign roles" ON "public"."user_roles"
    FOR INSERT
    WITH CHECK (
        "public"."has_permission"(auth.uid(), server_id, 'MANAGE_ROLES')
    );

DROP POLICY IF EXISTS "Users with MANAGE_ROLES can remove roles" ON "public"."user_roles";
CREATE POLICY "Users with MANAGE_ROLES can remove roles" ON "public"."user_roles"
    FOR DELETE
    USING (
        "public"."has_permission"(auth.uid(), server_id, 'MANAGE_ROLES')
    );

-- 4. Grant permissions
GRANT ALL ON "public"."user_roles" TO "authenticated";
GRANT ALL ON "public"."user_roles" TO "service_role";

-- 5. Fix the trigger function to check for profile existence
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

-- 6. Assign default role to existing members (only those with valid profile records)
DO $$
DECLARE
    v_server record;
    v_role record;
BEGIN
    -- Loop through all servers that have a default role
    FOR v_server IN
        SELECT s.id as server_id, sr.id as role_id
        FROM "public"."servers" s
        JOIN "public"."server_roles" sr ON sr.server_id = s.id AND sr.is_default = true
    LOOP
        -- Assign default role to all existing members (only those with valid profile records)
        INSERT INTO "public"."user_roles" (user_id, role_id, server_id)
        SELECT us.user_id, v_server.role_id, us.server_id
        FROM "public"."user_servers" us
        JOIN "public"."profiles" p ON p.id = us.user_id
        WHERE us.server_id = v_server.server_id AND us.status = 'accepted'
        ON CONFLICT (user_id, role_id) DO NOTHING;
    END LOOP;
END $$;

-- 7. Add to realtime publications
ALTER PUBLICATION supabase_realtime ADD TABLE "public"."user_roles";

