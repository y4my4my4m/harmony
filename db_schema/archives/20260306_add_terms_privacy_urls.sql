BEGIN;

-- Seed terms_url and privacy_url with empty defaults
INSERT INTO public.instance_config (config_key, config_value, description) VALUES
    ('terms_url', '""', 'URL to the Terms of Service page (shown on registration)'),
    ('privacy_url', '""', 'URL to the Privacy Policy page (shown on registration)')
ON CONFLICT (config_key) DO NOTHING;

-- Update public read policy to include terms_url and privacy_url
-- These must be readable by unauthenticated users on the register page
DROP POLICY IF EXISTS "Public can read federation settings" ON "public"."instance_config";

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
            'oauth_providers'::text,
            'terms_url'::text,
            'privacy_url'::text
        ])
    );

COMMIT;

NOTIFY pgrst, 'reload schema';
