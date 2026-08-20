-- Production has is_active, uses_count and metadata; init/ has none. verify_bot_token
-- filters on is_active and increments uses_count, so on a fresh install every call raises
-- 42703 -- plpgsql resolves column references at first execution rather than at CREATE, so
-- the function installs cleanly.
--
-- Types and defaults are from the production dump. All three are nullable with a constant
-- default, so ADD COLUMN is catalog-only.

BEGIN;

ALTER TABLE public.bot_tokens ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;
ALTER TABLE public.bot_tokens ADD COLUMN IF NOT EXISTS uses_count bigint DEFAULT 0;
ALTER TABLE public.bot_tokens ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;

-- ADD COLUMN with a constant default does not read NULL on existing rows: PG11+ stores it
-- in pg_attribute.attmissingval and answers it without touching the heap, so every
-- pre-existing token reads is_active = true the instant the column appears, revoked ones
-- included. Same transaction as the ALTER, which closes the window where verify_bot_token
-- would accept one.
--
-- Predicating the backfill on `is_active IS NULL` would match zero rows and leave every
-- revoked token live. The predicate is revoked_at, which is the fact that was already
-- recorded.
UPDATE public.bot_tokens
   SET is_active = false
 WHERE revoked_at IS NOT NULL
   AND is_active IS DISTINCT FROM false;

UPDATE public.bot_tokens SET uses_count = 0 WHERE uses_count IS NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'bot_tokens' AND column_name = 'is_active'
    ) THEN
        RAISE EXCEPTION 'bot_tokens.is_active absent after this migration';
    END IF;
    RAISE NOTICE 'bot_tokens carries is_active, uses_count and metadata';
END
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
