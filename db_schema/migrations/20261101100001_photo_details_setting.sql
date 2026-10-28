-- Photo details: whether a new photo or video attachment keeps its metadata by default.
--
--   photo_details_settings   one row per account, absent until first changed
--     keep_by_default        true: the composers' and Drive's "Keep photo details" starts on;
--                            false (and no row): location, camera and other metadata are
--                            removed on the device before upload (src/utils/stripMetadata.ts)
--
-- Keyed by auth.users, as outside_link_settings: delete_my_account deletes the auth user and
-- the cascade takes the row. Readable and writable only by its own account; anon holds nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.photo_details_settings (
    user_id uuid PRIMARY KEY DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    keep_by_default boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.photo_details_settings IS
    'Per-account default of "Keep photo details" for new photo and video uploads.';

REVOKE ALL ON public.photo_details_settings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.photo_details_settings TO authenticated;
GRANT ALL ON public.photo_details_settings TO service_role;

ALTER TABLE public.photo_details_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS photo_details_settings_own ON public.photo_details_settings;
CREATE POLICY photo_details_settings_own ON public.photo_details_settings
    FOR ALL TO authenticated
    USING (user_id = (SELECT auth.uid()))
    WITH CHECK (user_id = (SELECT auth.uid()));

COMMIT;
