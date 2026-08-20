-- ---------------------------------------------------------------------------
-- server_settings: drop never-used columns + ensure load-bearing ones exist.
--
-- Audit (grep across src/, federation-backend/, every db_schema/**/*.sql):
--
--   Column                            Read by               Verdict
--   ---------------------------       ------------------    ----------------
--   default_message_notifications     send_notification()   LOAD-BEARING
--   system_channel_id                 join/kick/ban/feder.  LOAD-BEARING
--   auto_mod_enabled (standalone)     NOTHING (*)           dead duplicate
--   auto_mod_rules                    NOTHING               dead
--   explicit_content_filter           NOTHING (+ CHECK)     dead
--   verification_gate_enabled         NOTHING               dead
--   verification_gate_rules           NOTHING               dead
--   afk_channel_id                    NOTHING               dead
--   afk_timeout                       NOTHING               dead
--   rules_channel_id                  NOTHING               dead
--
-- (*) The client reads/writes `moderation_settings.auto_mod_enabled` - a
--     field inside the `moderation_settings` JSONB column. The standalone
--     boolean column is a leftover of an early refactor; the archived
--     `fix_invites_and_server_settings.sql` migration already migrated its
--     values into the JSONB column on most environments. We re-run that
--     migration step here defensively before dropping the column so any
--     never-migrated rows don't silently lose data.
--
-- The dead columns came from an aspirational Discord-feature-parity migration
-- (`archives/20260307_ensure_server_settings.sql`) whose target features
-- (auto-mod, content filter, AFK timeout, verification gate, rules channel)
-- were never implemented. They've been carried as inert NULL columns on every
-- prod DB since. Dropping them now removes 8 always-NULL columns + 1 CHECK
-- constraint and makes the local / prod schemas converge.
--
-- IDEMPOTENT: every step uses IF EXISTS / IF NOT EXISTS so re-running is a
-- no-op. Safe to apply on prod (where columns exist) and local (where they
-- never did).
-- ---------------------------------------------------------------------------
BEGIN;

-- 1. Ensure load-bearing `system_channel_id` exists. Local/older DBs may be
--    missing it (the archived 20260307_ensure_server_settings.sql was never
--    applied to them, and CREATE TABLE IF NOT EXISTS in init doesn't add
--    columns to pre-existing tables). Without this column the
--    handle_member_join_system_message trigger and several RPCs throw
--    `42703: column does not exist` whenever a user joins/leaves a server.
ALTER TABLE public.server_settings
    ADD COLUMN IF NOT EXISTS system_channel_id uuid;

-- 2. Preserve any data from the standalone `auto_mod_enabled` column into
--    the JSONB `moderation_settings.auto_mod_enabled` field before dropping.
--    This mirrors the data-migration step from
--    archives/fix_invites_and_server_settings.sql for environments that
--    never ran it.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'server_settings'
          AND column_name = 'auto_mod_enabled'
    ) THEN
        UPDATE public.server_settings
        SET moderation_settings = jsonb_set(
            COALESCE(moderation_settings, '{}'::jsonb),
            '{auto_mod_enabled}',
            to_jsonb(COALESCE(auto_mod_enabled, false))
        )
        WHERE auto_mod_enabled IS DISTINCT FROM
              COALESCE((moderation_settings->>'auto_mod_enabled')::boolean, false);
    END IF;
END $$;

-- 3. Drop the CHECK constraint that references a column we're about to drop.
--    PostgreSQL won't let us drop the column while the constraint exists,
--    and CASCADE on DROP COLUMN would silently nuke other things we may not
--    expect - explicit constraint drop is safer.
ALTER TABLE public.server_settings DROP CONSTRAINT IF EXISTS server_settings_filter_check;

-- 4. Drop dead columns.
ALTER TABLE public.server_settings DROP COLUMN IF EXISTS auto_mod_enabled;
ALTER TABLE public.server_settings DROP COLUMN IF EXISTS auto_mod_rules;
ALTER TABLE public.server_settings DROP COLUMN IF EXISTS explicit_content_filter;
ALTER TABLE public.server_settings DROP COLUMN IF EXISTS verification_gate_enabled;
ALTER TABLE public.server_settings DROP COLUMN IF EXISTS verification_gate_rules;
ALTER TABLE public.server_settings DROP COLUMN IF EXISTS afk_channel_id;
ALTER TABLE public.server_settings DROP COLUMN IF EXISTS afk_timeout;
ALTER TABLE public.server_settings DROP COLUMN IF EXISTS rules_channel_id;

NOTIFY pgrst, 'reload schema';

COMMIT;
