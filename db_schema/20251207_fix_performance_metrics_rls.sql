-- =============================================
-- Fix Performance Metrics RLS Policies
-- Updates policies to properly restrict access to admins only
-- (Fixes security issue where USING (true) allowed any authenticated user)
-- =============================================

-- Drop existing overly permissive policies
DROP POLICY IF EXISTS "Admins can read metrics" ON "public"."performance_metrics";
DROP POLICY IF EXISTS "Admins can read hourly metrics" ON "public"."performance_metrics_hourly";
DROP POLICY IF EXISTS "Admins can read slow queries" ON "public"."slow_queries";
DROP POLICY IF EXISTS "Admins can read federation health" ON "public"."federation_health";

-- Recreate with proper admin-only access
CREATE POLICY "Admins can read metrics" ON "public"."performance_metrics"
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM "public"."profiles"
            WHERE "profiles"."auth_user_id" = auth.uid()
            AND "profiles"."is_admin" = true
        )
    );

CREATE POLICY "Admins can read hourly metrics" ON "public"."performance_metrics_hourly"
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM "public"."profiles"
            WHERE "profiles"."auth_user_id" = auth.uid()
            AND "profiles"."is_admin" = true
        )
    );

CREATE POLICY "Admins can read slow queries" ON "public"."slow_queries"
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM "public"."profiles"
            WHERE "profiles"."auth_user_id" = auth.uid()
            AND "profiles"."is_admin" = true
        )
    );

CREATE POLICY "Admins can read federation health" ON "public"."federation_health"
    FOR SELECT USING (
        EXISTS (
            SELECT 1 FROM "public"."profiles"
            WHERE "profiles"."auth_user_id" = auth.uid()
            AND "profiles"."is_admin" = true
        )
    );

