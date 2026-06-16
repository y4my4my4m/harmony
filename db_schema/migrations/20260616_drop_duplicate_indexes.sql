-- =============================================================================
-- Drop duplicate indexes (perf advisor: duplicate_index 0009)
-- =============================================================================
-- Each entry below is the redundant partner of a byte-identical index pair.
-- We keep the name that db_schema/init/ creates (verified) and drop the other.
--
-- Some of these "indexes" actually BACK a UNIQUE CONSTRAINT (e.g.
-- idx_emoji_usage_unique, megolm_session_shares_room_session_recipient_key),
-- which cannot be removed with DROP INDEX. The DO block inspects pg_constraint
-- and issues ALTER TABLE ... DROP CONSTRAINT for those, DROP INDEX otherwise.
-- Dropping a redundant UNIQUE constraint is safe: the kept partner is an
-- identical UNIQUE index that still enforces the same uniqueness.
--
-- All operations are guarded (IF EXISTS / existence checks), so this is a
-- no-op on environments built fresh from init (which never had the legacy
-- names). None of the dropped names exist in init.
-- =============================================================================

BEGIN;

DO $$
DECLARE
  rec   record;
  is_con boolean;
BEGIN
  FOR rec IN
    SELECT * FROM (VALUES
      ('admin_audit_log',            'idx_audit_log_action'),
      ('admin_audit_log',            'idx_audit_log_admin'),
      ('admin_audit_log',            'idx_audit_log_created'),
      ('emojis',                     'idx_emojis_server_id'),
      ('federation_delivery_queue',  'idx_federation_delivery_queue_next_attempt_pending'),
      ('federation_delivery_queue',  'idx_delivery_queue_target_domain_new'),
      ('federation_endpoint_health', 'federation_endpoint_health_domain_idx'),
      ('megolm_key_requests',        'idx_megolm_requests_user_id'),
      ('post_interactions',          'idx_post_interactions_federation'),
      ('post_interactions',          'idx_post_interactions_unique_non_emoji'),
      ('reports',                    'idx_reports_reporter'),
      ('voice_channel_participants', 'idx_voice_channel_participants_server'),
      ('emoji_usage',                'idx_emoji_usage_unique'),
      ('megolm_session_shares',      'megolm_session_shares_room_session_recipient_key')
    ) AS t(tbl, obj)
  LOOP
    -- Is this name a constraint on the table?
    SELECT EXISTS (
      SELECT 1
      FROM pg_constraint con
      JOIN pg_class c     ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = rec.tbl AND con.conname = rec.obj
    ) INTO is_con;

    IF is_con THEN
      EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I', rec.tbl, rec.obj);
      RAISE NOTICE 'Dropped CONSTRAINT %.%', rec.tbl, rec.obj;
    ELSIF EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = rec.tbl AND indexname = rec.obj
    ) THEN
      EXECUTE format('DROP INDEX IF EXISTS public.%I', rec.obj);
      RAISE NOTICE 'Dropped INDEX %.%', rec.tbl, rec.obj;
    ELSE
      RAISE NOTICE 'Skipped %.% (not present)', rec.tbl, rec.obj;
    END IF;
  END LOOP;
END$$;

COMMIT;
