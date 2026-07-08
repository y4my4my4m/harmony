-- Server + instance rules shown in the invite accept flow.
-- servers.rules: owner-set list displayed before a user joins via invite.
-- instance_rules: instance-wide list; locals ack once, federated joiners see it
-- via the invite resolve endpoint. Both are jsonb arrays of strings.

ALTER TABLE public.servers
  ADD COLUMN IF NOT EXISTS rules jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.servers
  DROP CONSTRAINT IF EXISTS servers_rules_shape_check;
ALTER TABLE public.servers
  ADD CONSTRAINT servers_rules_shape_check
  CHECK (jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) <= 25);

COMMENT ON COLUMN public.servers.rules IS
  'Owner-set rules (jsonb string array, max 25) agreed to in the invite accept flow.';

INSERT INTO public.instance_config (config_key, config_value, description)
VALUES ('instance_rules', '[]'::jsonb, 'Instance-wide rules (jsonb string array) shown to joining users')
ON CONFLICT (config_key) DO NOTHING;

-- instance_rules must be publicly readable (instance_config RLS filters by this list)
CREATE OR REPLACE FUNCTION public.public_instance_config_keys()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT ARRAY[
        'domain',
        'instance_name',
        'instance_description',
        'instance_icon',
        'instance_rules',
        'terms_url',
        'privacy_url',
        'open_registration',
        'approval_required',
        'oauth_providers',
        'enable_inbound_federation',
        'enable_outbound_federation',
        'federation_settings',
        'features',
        'max_post_length',
        'max_message_length',
        'max_server_size',
        'max_media_attachments_per_post',
        'max_custom_emojis_per_server',
        'custom_emoji_transform_quality',
        'enable_voice_channels',
        'allow_file_uploads',
        'allow_custom_emojis_in_display_names',
        'default_theme_json',
        'gif_ads_enabled',
        'gif_klipy_watermark_enabled',
        'gif_clips_enabled',
        'gif_memes_enabled',
        'gif_ai_emojis_enabled',
        'gif_ai_emoji_generation_enabled'
    ]::text[];
$$;
