-- =============================================
-- Add oauth_providers to public read policy for instance_config
-- This allows unauthenticated users (on login/register pages) to see which OAuth providers are enabled
-- =============================================

-- Drop the existing policy
DROP POLICY IF EXISTS "Public can read federation settings" ON "public"."instance_config";

-- Recreate the policy with oauth_providers included
CREATE POLICY "Public can read federation settings" 
    ON "public"."instance_config" 
    FOR SELECT 
    USING (
        config_key = ANY (ARRAY[
            'federation_settings'::text,
            'domain'::text,
            'instance_name'::text,
            'instance_description'::text,
            'open_registration'::text,
            'approval_required'::text,
            'oauth_providers'::text
        ])
    );
