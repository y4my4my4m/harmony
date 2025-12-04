-- Migration: Add server folders support
-- Description: Create server_folders table and add folder_id/position to user_servers for Discord-like folder grouping

-- =============================================
-- 1. Create server_folders table
-- =============================================
CREATE TABLE IF NOT EXISTS "public"."server_folders" (
    "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL REFERENCES "public"."profiles"("id") ON DELETE CASCADE,
    "name" TEXT NOT NULL,
    "color" TEXT DEFAULT '#5865f2',
    "position" INTEGER NOT NULL DEFAULT 0,
    "is_expanded" BOOLEAN DEFAULT true,
    "created_at" TIMESTAMPTZ DEFAULT now(),
    "updated_at" TIMESTAMPTZ DEFAULT now()
);

-- Add index for faster lookups by user
CREATE INDEX IF NOT EXISTS "idx_server_folders_user_id" ON "public"."server_folders"("user_id");

-- Add index for position ordering
CREATE INDEX IF NOT EXISTS "idx_server_folders_user_position" ON "public"."server_folders"("user_id", "position");

-- Set table ownership
ALTER TABLE "public"."server_folders" OWNER TO "postgres";

-- Add table comment
COMMENT ON TABLE "public"."server_folders" IS 'User-created folders for organizing servers in the sidebar';

-- Add column comments
COMMENT ON COLUMN "public"."server_folders"."color" IS 'Hex color code for folder display';
COMMENT ON COLUMN "public"."server_folders"."position" IS 'Sort order position for the folder in the sidebar';
COMMENT ON COLUMN "public"."server_folders"."is_expanded" IS 'Whether the folder is expanded to show servers';

-- =============================================
-- 2. Add folder_id and position to user_servers
-- =============================================
ALTER TABLE "public"."user_servers" 
ADD COLUMN IF NOT EXISTS "folder_id" UUID REFERENCES "public"."server_folders"("id") ON DELETE SET NULL;

ALTER TABLE "public"."user_servers" 
ADD COLUMN IF NOT EXISTS "position" INTEGER DEFAULT 0;

-- Add index for folder lookups
CREATE INDEX IF NOT EXISTS "idx_user_servers_folder_id" ON "public"."user_servers"("folder_id");

-- Add index for position ordering within user's servers
CREATE INDEX IF NOT EXISTS "idx_user_servers_user_position" ON "public"."user_servers"("user_id", "position");

-- Add column comments
COMMENT ON COLUMN "public"."user_servers"."folder_id" IS 'Optional folder this server belongs to (null = root level)';
COMMENT ON COLUMN "public"."user_servers"."position" IS 'Sort order position within the folder or at root level';

-- =============================================
-- 3. Create updated_at trigger for server_folders
-- =============================================
CREATE OR REPLACE FUNCTION "public"."update_server_folders_updated_at"()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "trigger_server_folders_updated_at" ON "public"."server_folders";
CREATE TRIGGER "trigger_server_folders_updated_at"
    BEFORE UPDATE ON "public"."server_folders"
    FOR EACH ROW
    EXECUTE FUNCTION "public"."update_server_folders_updated_at"();

-- =============================================
-- 4. Grant permissions to authenticated users
-- =============================================
GRANT ALL ON "public"."server_folders" TO "authenticated";
GRANT ALL ON "public"."server_folders" TO "service_role";

-- =============================================
-- 5. RLS Policies for server_folders
-- =============================================
ALTER TABLE "public"."server_folders" ENABLE ROW LEVEL SECURITY;

-- Policy: Users can view their own folders
DROP POLICY IF EXISTS "Users can view own folders" ON "public"."server_folders";
CREATE POLICY "Users can view own folders" ON "public"."server_folders"
    FOR SELECT
    USING (auth.uid() = user_id);

-- Policy: Users can create their own folders
DROP POLICY IF EXISTS "Users can create own folders" ON "public"."server_folders";
CREATE POLICY "Users can create own folders" ON "public"."server_folders"
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Policy: Users can update their own folders
DROP POLICY IF EXISTS "Users can update own folders" ON "public"."server_folders";
CREATE POLICY "Users can update own folders" ON "public"."server_folders"
    FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);

-- Policy: Users can delete their own folders
DROP POLICY IF EXISTS "Users can delete own folders" ON "public"."server_folders";
CREATE POLICY "Users can delete own folders" ON "public"."server_folders"
    FOR DELETE
    USING (auth.uid() = user_id);

-- =============================================
-- 6. Helper function to get next folder position
-- =============================================
CREATE OR REPLACE FUNCTION "public"."get_next_folder_position"(p_user_id UUID)
RETURNS INTEGER AS $$
DECLARE
    max_position INTEGER;
BEGIN
    SELECT COALESCE(MAX(position), -1) + 1 INTO max_position
    FROM server_folders
    WHERE user_id = p_user_id;
    
    RETURN max_position;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION "public"."get_next_folder_position"(UUID) IS 'Get the next available position for a new folder';

-- =============================================
-- 7. Helper function to get next server position
-- =============================================
CREATE OR REPLACE FUNCTION "public"."get_next_server_position"(p_user_id UUID, p_folder_id UUID DEFAULT NULL)
RETURNS INTEGER AS $$
DECLARE
    max_position INTEGER;
BEGIN
    IF p_folder_id IS NULL THEN
        -- Get max position for root-level servers
        SELECT COALESCE(MAX(position), -1) + 1 INTO max_position
        FROM user_servers
        WHERE user_id = p_user_id AND folder_id IS NULL;
    ELSE
        -- Get max position within the folder
        SELECT COALESCE(MAX(position), -1) + 1 INTO max_position
        FROM user_servers
        WHERE user_id = p_user_id AND folder_id = p_folder_id;
    END IF;
    
    RETURN max_position;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION "public"."get_next_server_position"(UUID, UUID) IS 'Get the next available position for a server in a folder or at root level';

