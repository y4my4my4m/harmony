-- Optional Klipy media types: Clips (short video), Memes, and AI Emoji.
--
-- These extend the existing GIF/Sticker picker. They are OFF by default so
-- instances opt in. When enabled they appear as picker tabs and slash commands
-- (/clip, /meme, /aiemoji); when disabled they are hidden everywhere. GIFs and
-- Stickers remain always-on and need no flag.
BEGIN;

INSERT INTO public.instance_config (config_key, config_value, description)
VALUES
    ('gif_clips_enabled', 'false'::jsonb,
        'Enable the Klipy Clips (short video) media type in the picker and the /clip command'),
    ('gif_memes_enabled', 'false'::jsonb,
        'Enable the Klipy Memes media type in the picker and the /meme command'),
    ('gif_ai_emojis_enabled', 'false'::jsonb,
        'Enable the Klipy AI Emoji media type in the picker and the /aiemoji command')
ON CONFLICT (config_key) DO NOTHING;

COMMIT;

NOTIFY pgrst, 'reload schema';
