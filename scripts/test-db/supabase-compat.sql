-- supabase/postgres ships storage.buckets with (id, name, owner, created_at, updated_at).
-- storage-api adds the rest through its own migrations at service start, which a bare
-- Postgres container never runs. Column set matches storage-api as deployed.
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
-- The realtime schema is owned by supabase_admin and postgres is not superuser
-- in this image, so this file must be applied as supabase_admin; pg_hba trusts
-- that role over 127.0.0.1. Run as postgres the whole block raises
-- "permission denied for schema realtime", the handler below swallows it, and
-- neither stub is created.
DO $compat$
BEGIN
  -- id is uuid, not a sequence: realtime.send generates it and reuses the same
  -- value inside the payload. Real deployments partition this table by
  -- inserted_at; a single table is enough here and keeps the PK simple.
  CREATE TABLE IF NOT EXISTS realtime.messages (
      id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
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

  -- realtime.send ships with the Realtime service, not the Postgres image.
  -- Every broadcast trigger calls it, so without it any INSERT on a table
  -- carrying one aborts with "function realtime.send(...) does not exist" and
  -- the test reads as a schema failure rather than a missing service.
  -- Mirrors supabase/realtime's own definition, from
  -- lib/realtime/tenants/repo/migrations/20251103001201_broadcast_send_include_payload_id.ex.
  -- Three properties of that definition are load-bearing and must not be
  -- "simplified" here:
  --
  --   private DEFAULT true    a 3-argument call broadcasts privately. init/ and
  --                           the migrations disagree on whether to pass the
  --                           flag explicitly; with this default the two are
  --                           the same call.
  --   EXCEPTION WHEN OTHERS   realtime.send never propagates. A trigger cannot
  --                           fail because a broadcast failed, so a trigger's
  --                           own EXCEPTION block only ever catches its other
  --                           statements.
  --   id injected into payload  callers read payload->>'id'.
  EXECUTE $fn$
    CREATE OR REPLACE FUNCTION realtime.send(
        payload jsonb, event text, topic text, private boolean DEFAULT true)
    RETURNS void LANGUAGE plpgsql AS $body$
    DECLARE
      generated_id uuid;
      final_payload jsonb;
    BEGIN
      BEGIN
        generated_id := gen_random_uuid();
        IF payload ? 'id' THEN
          final_payload := payload;
        ELSE
          final_payload := jsonb_set(payload, '{id}', to_jsonb(generated_id));
        END IF;
        EXECUTE format('SET LOCAL realtime.topic TO %L', topic);
        INSERT INTO realtime.messages (id, payload, event, topic, private, extension)
        VALUES (generated_id, final_payload, event, topic, private, 'broadcast');
      EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'ErrorSendingBroadcastMessage: %', SQLERRM;
      END;
    END;
    $body$;
  $fn$;
  GRANT EXECUTE ON FUNCTION realtime.send(jsonb, text, text, boolean) TO authenticated, anon;
EXCEPTION WHEN insufficient_privilege OR undefined_table OR undefined_object THEN
  RAISE NOTICE 'realtime stub skipped: %', SQLERRM;
END
$compat$;
