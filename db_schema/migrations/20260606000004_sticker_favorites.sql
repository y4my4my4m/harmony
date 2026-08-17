-- Stickers: per-type favorites + rename the Klipy "branding" toggle to "watermark".
--
-- 1. gif_favorites.media_type separates GIF favorites from sticker favorites so the
--    sticker picker can show its own favorites list. Existing rows are GIFs.
-- 2. The instance_config key gif_klipy_branding_enabled is renamed to
--    gif_klipy_watermark_enabled. The picker's "Search KLIPY" label is required
--    attribution (always shown); only the on-media watermark is now optional, so
--    the clearer name reflects what the toggle actually controls.
BEGIN;

ALTER TABLE public.gif_favorites
    ADD COLUMN IF NOT EXISTS media_type text NOT NULL DEFAULT 'gif';

COMMENT ON TABLE public.gif_favorites IS 'User favorite GIFs and stickers';

-- Rename the config key if the old one exists and the new one does not yet.
UPDATE public.instance_config
   SET config_key = 'gif_klipy_watermark_enabled',
       description = 'Show the optional (recommended) KLIPY attribution watermark on sent GIFs/stickers'
 WHERE config_key = 'gif_klipy_branding_enabled'
   AND NOT EXISTS (
       SELECT 1 FROM public.instance_config WHERE config_key = 'gif_klipy_watermark_enabled'
   );

-- Ensure the key exists for instances that never had the old one.
INSERT INTO public.instance_config (config_key, config_value, description)
VALUES (
    'gif_klipy_watermark_enabled',
    'true'::jsonb,
    'Show the optional (recommended) KLIPY attribution watermark on sent GIFs/stickers'
)
ON CONFLICT (config_key) DO NOTHING;

-- Drop the old key if both ended up present (e.g. new key was seeded separately).
DELETE FROM public.instance_config WHERE config_key = 'gif_klipy_branding_enabled';

COMMIT;

NOTIFY pgrst, 'reload schema';
