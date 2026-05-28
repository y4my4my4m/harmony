-- =============================================================================
-- Harmony Database Schema - Seed Data
-- =============================================================================
-- Default configuration values for a new instance
-- Run this after tables are created but before going live
-- =============================================================================

-- Instance Configuration Defaults
-- These can be customized via the admin panel after deployment
INSERT INTO public.instance_config (config_key, config_value, description) VALUES
    ('domain', '"localhost"', 'The domain name of this instance'),
    ('instance_name', '"Harmony"', 'The name of this Harmony instance'),
    ('instance_description', '""', 'Description of this instance'),
    ('open_registration', 'true', 'Whether new user registration is open'),
    ('approval_required', 'false', 'Whether new registrations require admin approval'),
    ('max_post_length', '500', 'Maximum length of ActivityPub posts'),
    ('max_message_length', '2000', 'Maximum length of chat messages'),
    ('max_server_size', '1000', 'Maximum number of members per chat server'),
    ('enable_voice_channels', 'true', 'Whether voice channels are enabled'),
    ('allow_file_uploads', 'true', 'Whether file uploads are allowed'),
    ('max_media_attachments_per_post', '20', 'Maximum number of media attachments per post or message'),
    ('enable_inbound_federation', 'true', 'Whether inbound federation is enabled'),
    ('enable_outbound_federation', 'true', 'Whether outbound federation is enabled'),
    ('allow_custom_emojis_in_display_names', 'true', 'Whether users can use custom emojis in display names'),
    ('federation_retry_attempts', '3', 'Number of retry attempts for failed federation deliveries'),
    ('federation_settings', '{"federation_enabled": true, "federation_require_approval": false, "federation_auto_accept_follows": true, "federation_delivery_timeout_ms": 10000, "federation_max_delivery_attempts": 5, "link_preview_backend_url": ""}', 'Federation configuration settings for the instance'),
    ('oauth_providers', '[]', 'Enabled OAuth providers'),
    ('features', '{"voice_enabled": true, "video_enabled": true, "e2e_encryption": true}', 'Feature flags'),
    ('terms_url', '""', 'URL to the Terms of Service page (shown on registration)'),
    ('privacy_url', '""', 'URL to the Privacy Policy page (shown on registration)')
ON CONFLICT (config_key) DO NOTHING;

DO $$
BEGIN
    RAISE NOTICE 'Instance configuration seed data inserted';
END $$;

