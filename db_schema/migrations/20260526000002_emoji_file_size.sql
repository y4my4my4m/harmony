BEGIN;

ALTER TABLE public.emojis
  ADD COLUMN IF NOT EXISTS file_size integer;

COMMENT ON COLUMN public.emojis.file_size IS 'Uploaded emoji image size in bytes';

NOTIFY pgrst, 'reload schema';

COMMIT;
