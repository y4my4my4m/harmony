-- =============================================================================
-- Migration: Add max_media_attachments_per_post instance config
-- =============================================================================
-- Limits the number of media attachments per post or message.
-- Admin-configurable via instance settings. Default: 20.
-- Also extends public read policy so frontend can enforce the limit.
-- =============================================================================

BEGIN;

INSERT INTO instance_config (config_key, config_value, description, updated_at)
VALUES ('max_media_attachments_per_post', '20', 'Maximum number of media attachments per post or message.', now())
ON CONFLICT (config_key) DO NOTHING;

-- Extend public read policy so authenticated users can read the limit (for Composer/MessageInput)
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
            'max_media_attachments_per_post'::text
        ])
    );

COMMIT;
