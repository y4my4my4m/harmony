-- Add FK from reactions.emoji_id to emojis(id) if missing.
-- Required for PostgREST embeds like messages->reactions->emojis.
-- emoji_id is nullable (custom_emoji_content can be used instead), so ON DELETE SET NULL.
BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'reactions_emoji_id_fkey'
          AND conrelid = 'public.reactions'::regclass
    ) THEN
        ALTER TABLE public.reactions
            ADD CONSTRAINT reactions_emoji_id_fkey
            FOREIGN KEY (emoji_id) REFERENCES public.emojis(id) ON DELETE CASCADE;
    END IF;
END $$;

COMMIT;
