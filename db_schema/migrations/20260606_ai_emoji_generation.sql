-- AI Emoji generation (Klipy generation API).
--
-- Members can generate AI emoji from a text prompt. Generation returns raw image
-- bytes (no hosted URL), so the federation backend stores them in the public
-- 'ai-emojis' bucket and records one gif_favorites row per generation with
-- is_generated = true. That row is the user's generation history AND the source
-- of truth for the daily caps (per-user + the shared 20/day Klipy instance cap).
--
-- OFF by default; admins opt in via gif_ai_emoji_generation_enabled.
BEGIN;

-- 1. Generation history / cap-tracking column on gif_favorites.
ALTER TABLE public.gif_favorites
    ADD COLUMN IF NOT EXISTS is_generated boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_gif_favorites_generated
    ON public.gif_favorites(created_at) WHERE is_generated;

COMMENT ON TABLE public.gif_favorites IS 'User favorite GIFs, stickers, and generated AI emoji';

-- 2. Public bucket for hosting generated emoji (service-role writes only).
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'ai-emojis',
    'ai-emojis',
    true,
    3145728, -- 3MB
    ARRAY['image/png', 'image/webp', 'image/gif', 'image/jpeg']
)
ON CONFLICT (id) DO UPDATE SET
    public = EXCLUDED.public,
    file_size_limit = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Public read access for ai-emojis" ON storage.objects;
CREATE POLICY "Public read access for ai-emojis"
    ON storage.objects FOR SELECT
    USING (bucket_id = 'ai-emojis');

-- 3. Admin opt-in toggle.
INSERT INTO public.instance_config (config_key, config_value, description)
VALUES
    ('gif_ai_emoji_generation_enabled', 'false'::jsonb,
        'Allow members to generate AI emoji from text prompts (Klipy generation API). Shared 20/day instance cap plus a per-user daily cap.')
ON CONFLICT (config_key) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
