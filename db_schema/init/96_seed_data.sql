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
    ('instance_rules', '[]', 'Instance-wide rules (jsonb string array) shown to joining users'),
    ('open_registration', 'true', 'Whether new user registration is open'),
    ('approval_required', 'false', 'Whether new registrations require admin approval'),
    ('max_post_length', '500', 'Maximum length of ActivityPub posts'),
    ('max_message_length', '2000', 'Maximum length of chat messages'),
    ('max_server_size', '1000', 'Maximum number of members per chat server'),
    ('enable_voice_channels', 'true', 'Whether voice channels are enabled'),
    ('allow_file_uploads', 'true', 'Whether file uploads are allowed'),
    ('bridge_attachment_mode', '"refresh"', 'How bridged external attachments are handled: link (external CDN URLs may expire), refresh (re-sign expired URLs on demand when viewed; silent content update), mirror (copy into user_media — uses disk).'),
    ('max_media_attachments_per_post', '20', 'Maximum number of media attachments per post or message'),
    ('enable_inbound_federation', 'true', 'Whether inbound federation is enabled'),
    ('enable_outbound_federation', 'true', 'Whether outbound federation is enabled'),
    ('allow_custom_emojis_in_display_names', 'true', 'Whether users can use custom emojis in display names'),
    ('federation_retry_attempts', '3', 'Number of retry attempts for failed federation deliveries'),
    ('federation_settings', '{"federation_enabled": true, "federation_require_approval": false, "federation_auto_accept_follows": true, "federation_delivery_timeout_ms": 10000, "federation_max_delivery_attempts": 5, "link_preview_backend_url": ""}', 'Federation configuration settings for the instance'),
    ('oauth_providers', '[]', 'Enabled OAuth providers'),
    ('features', '{"voice_enabled": true, "video_enabled": true, "e2e_encryption": true}', 'Feature flags'),
    ('terms_url', '""', 'URL to the Terms of Service page (shown on registration)'),
    ('privacy_url', '""', 'URL to the Privacy Policy page (shown on registration)'),
    ('gif_ads_enabled', 'true', 'Whether the GIF picker (Klipy) may serve ads to non-supporters'),
    ('gif_klipy_watermark_enabled', 'true', 'Show the optional (recommended) KLIPY attribution watermark on sent GIFs/stickers. The required "Search KLIPY" picker label is always shown regardless.'),
    ('gif_clips_enabled', 'false', 'Enable the Klipy Clips (short video) media type in the picker and the /clip command'),
    ('gif_memes_enabled', 'false', 'Enable the Klipy Memes media type in the picker and the /meme command'),
    ('gif_ai_emojis_enabled', 'false', 'Enable the Klipy AI Emoji media type in the picker and the /aiemoji command'),
    ('gif_ai_emoji_generation_enabled', 'false', 'Allow members to generate AI emoji from text prompts (Klipy generation API). Shared 20/day instance cap plus a per-user daily cap.')
ON CONFLICT (config_key) DO NOTHING;

DO $$
BEGIN
    RAISE NOTICE 'Instance configuration seed data inserted';
END $$;

