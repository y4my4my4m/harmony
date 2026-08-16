-- Brings the storage schema to the shape a running storage-api produces.
--
-- supabase/postgres ships storage.buckets with only (id, name, owner,
-- created_at, updated_at). The remaining columns are added by storage-api's
-- own migrations at service start, which a bare Postgres container never runs.
-- Without them 97_storage_buckets.sql fails on every bucket insert.
-- Column set matches storage-api as deployed (verified against prod).
ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS public boolean DEFAULT false;
ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS avif_autodetection boolean DEFAULT false;
ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS file_size_limit bigint;
ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS allowed_mime_types text[];
ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS owner_id text;
ALTER TABLE storage.buckets ADD COLUMN IF NOT EXISTS type text;

ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS owner_id text;
ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS user_metadata jsonb;
ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS version text;
ALTER TABLE storage.objects ADD COLUMN IF NOT EXISTS level integer;
