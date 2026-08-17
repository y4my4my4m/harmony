-- =============================================================================
-- Migration: Forbid blank/whitespace-only `profiles.display_name`
-- =============================================================================
-- A blank display name was allowed by the original schema (`display_name
-- text` with no CHECK). Users who cleared their display name in the
-- settings UI ended up persisted with `""`, then appeared as
-- `Unknown User` everywhere via the `getUserDisplayName` fallback chain -
-- confusing UX, and a passive impersonation surface (multiple users all
-- show as `Unknown User`, so you can't tell them apart in member lists).
--
-- The application now refuses to save an empty display name (see
-- `UserAccountSettings.vue` and `CoreProfileService.validateProfileData`).
-- This migration adds the same rule at the storage layer so the same
-- invariant binds on federation imports, bot inserts, and any other
-- code path that bypasses the application validation.
--
-- Existing rows with blank display names are normalised to NULL up-front
-- so the constraint can be added without breaking the table. NULL is
-- explicitly allowed (some federated profiles legitimately don't carry
-- a display name); the display layer falls back to the username.
-- =============================================================================

BEGIN;

-- 1. Heal existing data so the constraint can be added cleanly. Anything
--    that's whitespace-only becomes NULL.
UPDATE public.profiles
SET display_name = NULL
WHERE display_name IS NOT NULL
  AND length(btrim(display_name)) = 0;

-- 2. Add the constraint idempotently.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'profiles_display_name_not_blank'
          AND conrelid = 'public.profiles'::regclass
    ) THEN
        ALTER TABLE public.profiles
            ADD CONSTRAINT profiles_display_name_not_blank
            CHECK (display_name IS NULL OR length(btrim(display_name)) > 0);
    END IF;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
