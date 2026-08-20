-- =============================================================================
-- instance_config RLS: complete public whitelist + admin full read
-- =============================================================================
-- Regular users were stuck on an 8-key whitelist ("Public can read federation
-- settings") that predated gif_clips_enabled and friends, so Clips/Memes/AI
-- Emoji never appeared even when enabled. Admins saw everything because they
-- still had (or gained) a broader SELECT path.
--
-- Fix: one curated public key list (RLS row filter) + admins read all rows.
-- No RPC — PostgREST table reads are fine; RLS enforces the boundary.
--
-- Public (everyone): branding, registration, oauth, federation flags, limits,
--   feature toggles (voice, uploads, gif/clips/memes/ai-emoji, emojis in names)
-- Admin-only: maintainer_email/name, federation_retry_attempts,
--   federation_cron_migration_completed, instance_banner, theme_color, …
-- =============================================================================

BEGIN;

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

ALTER TABLE public.instance_config ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON public.instance_config TO anon, authenticated;

DROP POLICY IF EXISTS "instance_config_select_all" ON public.instance_config;
DROP POLICY IF EXISTS "Public can read federation settings" ON public.instance_config;
DROP POLICY IF EXISTS "Public can read instance settings" ON public.instance_config;
DROP POLICY IF EXISTS "instance_config_select_admin" ON public.instance_config;

CREATE POLICY "Public can read instance settings"
    ON public.instance_config
    FOR SELECT
    USING (config_key = ANY (public.public_instance_config_keys()));

-- Uses existing SECURITY DEFINER helper (see 10_functions_core.sql) so the check
-- still works if profiles RLS is tightened later.
CREATE POLICY "instance_config_select_admin"
    ON public.instance_config
    FOR SELECT
    TO authenticated
    USING (public.is_current_user_admin());

-- Remove RPC if an earlier draft of this migration was applied.
DROP FUNCTION IF EXISTS public.get_public_instance_settings();

COMMIT;

NOTIFY pgrst, 'reload schema';
