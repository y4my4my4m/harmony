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

-- realtime.messages is created by the Realtime service at start, not by the
-- Postgres image. Without it 98_enable_rls.sql skips the policies on it, and
-- can_subscribe_to_topic - whose only caller is that policy - reads as
-- unreachable. Column set matches what realtime.send() writes.
-- Best effort: the realtime schema is owned by supabase_admin and a bare
-- container has no way to write to it. Reachability roots are read from
-- db_schema/ instead, so this stub is a convenience, not a requirement.
DO $compat$
BEGIN
  CREATE TABLE IF NOT EXISTS realtime.messages (
      id          bigserial PRIMARY KEY,
      topic       text,
      extension   text,
      payload     jsonb,
      event       text,
      private     boolean DEFAULT false,
      inserted_at timestamptz DEFAULT now(),
      updated_at  timestamptz DEFAULT now()
  );
  GRANT USAGE ON SCHEMA realtime TO authenticated;
  GRANT SELECT, INSERT ON realtime.messages TO authenticated;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA realtime TO authenticated;
EXCEPTION WHEN insufficient_privilege OR undefined_table THEN
  RAISE NOTICE 'realtime stub skipped: %', SQLERRM;
END
$compat$;
