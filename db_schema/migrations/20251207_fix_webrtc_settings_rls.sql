-- =============================================
-- Fix WebRTC Settings RLS Policies
-- Ensures proper permissions for reading and writing WebRTC settings
-- =============================================

-- Drop ALL existing policies if they exist (to recreate them properly)
-- This ensures we remove any old policies with incorrect column references
DO $$
DECLARE
    r RECORD;
BEGIN
    -- Drop all existing policies on instance_webrtc_settings
    DROP POLICY IF EXISTS "Anyone can read webrtc settings" ON "public"."instance_webrtc_settings";
    DROP POLICY IF EXISTS "Admins can update webrtc settings" ON "public"."instance_webrtc_settings";
    DROP POLICY IF EXISTS "Admins can insert webrtc settings" ON "public"."instance_webrtc_settings";
    DROP POLICY IF EXISTS "Admins can delete webrtc settings" ON "public"."instance_webrtc_settings";
    
    -- Drop any other policies that might exist (catch-all)
    FOR r IN (
        SELECT policyname 
        FROM pg_policies 
        WHERE schemaname = 'public' 
        AND tablename = 'instance_webrtc_settings'
    ) LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON "public"."instance_webrtc_settings"', r.policyname);
    END LOOP;
END
$$;

-- Allow anyone (including unauthenticated) to read WebRTC settings
-- This is safe as WebRTC settings are not sensitive
-- Don't specify TO clause to allow all roles (authenticated and anon)
CREATE POLICY "Anyone can read webrtc settings" 
    ON "public"."instance_webrtc_settings" 
    FOR SELECT 
    USING (true);

-- Allow admins to insert WebRTC settings (for initial setup)
CREATE POLICY "Admins can insert webrtc settings" 
    ON "public"."instance_webrtc_settings" 
    FOR INSERT 
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM "public"."profiles"
            WHERE (
                "profiles"."auth_user_id" = "auth"."uid"() 
                AND "profiles"."is_admin" = true
            )
        )
    );

-- Allow admins to update WebRTC settings
CREATE POLICY "Admins can update webrtc settings" 
    ON "public"."instance_webrtc_settings" 
    FOR UPDATE 
    USING (
        EXISTS (
            SELECT 1
            FROM "public"."profiles"
            WHERE (
                "profiles"."auth_user_id" = "auth"."uid"() 
                AND "profiles"."is_admin" = true
            )
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1
            FROM "public"."profiles"
            WHERE (
                "profiles"."auth_user_id" = "auth"."uid"() 
                AND "profiles"."is_admin" = true
            )
        )
    );

-- Allow admins to delete WebRTC settings (for reset)
CREATE POLICY "Admins can delete webrtc settings" 
    ON "public"."instance_webrtc_settings" 
    FOR DELETE 
    USING (
        EXISTS (
            SELECT 1
            FROM "public"."profiles"
            WHERE (
                "profiles"."auth_user_id" = "auth"."uid"() 
                AND "profiles"."is_admin" = true
            )
        )
    );

-- Ensure RLS is enabled (should already be, but make sure)
ALTER TABLE "public"."instance_webrtc_settings" ENABLE ROW LEVEL SECURITY;

-- Grant table permissions to authenticated users (RLS policies will control access)
GRANT SELECT ON "public"."instance_webrtc_settings" TO "authenticated";
GRANT SELECT ON "public"."instance_webrtc_settings" TO "anon";
GRANT INSERT, UPDATE, DELETE ON "public"."instance_webrtc_settings" TO "authenticated";

