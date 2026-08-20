BEGIN;

ALTER TABLE public.servers ADD COLUMN IF NOT EXISTS banner text;

NOTIFY pgrst, 'reload schema';

COMMIT;
