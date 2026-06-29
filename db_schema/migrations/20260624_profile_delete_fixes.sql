-- Unified profile-deletion fixes:
--   1. messages.user_id / pinned_by -> ON DELETE SET NULL (orphan as Unknown User)
--   2. Legacy profiles FKs still on NO ACTION -> CASCADE or SET NULL
--   3. servers.owner -> SET NULL (ownerless server on account delete; RLS follow-up)
--   4. SET NULL columns that are still NOT NULL (threads.created_by, reports.reporter_id, …)
--   5. user_servers leave triggers skip inserts when profile already gone
--
-- ---------------------------------------------------------------------------
-- POST-MIGRATION: FKs still blocking delete (expect 0 rows)
-- confdeltype: a=NO ACTION, r=RESTRICT, c=CASCADE, n=SET NULL, d=SET DEFAULT
-- ---------------------------------------------------------------------------
--   SELECT
--       c.conrelid::regclass AS table_name,
--       c.conname,
--       CASE c.confdeltype
--           WHEN 'a' THEN 'NO ACTION'
--           WHEN 'r' THEN 'RESTRICT'
--           WHEN 'c' THEN 'CASCADE'
--           WHEN 'n' THEN 'SET NULL'
--           WHEN 'd' THEN 'SET DEFAULT'
--       END AS on_delete,
--       pg_get_constraintdef(c.oid) AS definition
--   FROM pg_constraint c
--   WHERE c.contype = 'f'
--     AND c.confrelid = 'public.profiles'::regclass
--     AND c.confdeltype IN ('a', 'r')
--   ORDER BY 1::text, 2;
--
-- ---------------------------------------------------------------------------
-- POST-MIGRATION: SET NULL traps (expect 0 rows)
-- ---------------------------------------------------------------------------
--   SELECT c.conrelid::regclass AS tbl, a.attname AS col, c.conname
--   FROM pg_constraint c
--   JOIN pg_attribute a
--     ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
--   WHERE c.contype = 'f'
--     AND c.confrelid = 'public.profiles'::regclass
--     AND c.confdeltype = 'n'
--     AND a.attnotnull;
--
-- ---------------------------------------------------------------------------
-- POST-MIGRATION: membership FK audit (user_servers must CASCADE; events.user_id
-- should be CASCADE or SET NULL+nullable, never NO ACTION)
-- ---------------------------------------------------------------------------
--   SELECT
--       c.conrelid::regclass AS table_name,
--       c.conname,
--       CASE c.confdeltype
--           WHEN 'a' THEN 'NO ACTION'
--           WHEN 'r' THEN 'RESTRICT'
--           WHEN 'c' THEN 'CASCADE'
--           WHEN 'n' THEN 'SET NULL'
--           WHEN 'd' THEN 'SET DEFAULT'
--       END AS on_delete,
--       pg_get_constraintdef(c.oid) AS definition
--   FROM pg_constraint c
--   WHERE c.contype = 'f'
--     AND c.confrelid = 'public.profiles'::regclass
--     AND c.conrelid IN (
--         'public.user_servers'::regclass,
--         'public.server_membership_events'::regclass
--     )
--   ORDER BY 1::text, 2;
--
-- ---------------------------------------------------------------------------
-- Rollback delete test (replace uuid; read NOTICES; must say "would succeed")
-- ---------------------------------------------------------------------------
--   BEGIN;
--   DO $$
--   DECLARE
--       v_id uuid := '00000000-0000-0000-0000-000000000000';
--       v_sqlstate text;
--       v_message text;
--       v_detail text;
--       v_table text;
--       v_constraint text;
--   BEGIN
--       BEGIN
--           DELETE FROM public.profiles WHERE id = v_id;
--           RAISE NOTICE 'DELETE would succeed for profile %', v_id;
--       EXCEPTION WHEN OTHERS THEN
--           GET STACKED DIAGNOSTICS
--               v_sqlstate = RETURNED_SQLSTATE,
--               v_message = MESSAGE_TEXT,
--               v_detail = PG_EXCEPTION_DETAIL,
--               v_table = TABLE_NAME,
--               v_constraint = CONSTRAINT_NAME;
--           RAISE NOTICE 'SQLSTATE: %', v_sqlstate;
--           RAISE NOTICE 'MESSAGE: %', v_message;
--           RAISE NOTICE 'DETAIL: %', v_detail;
--           RAISE NOTICE 'TABLE: %', v_table;
--           RAISE NOTICE 'CONSTRAINT: %', v_constraint;
--       END;
--   END $$;
--   ROLLBACK;
--
-- Account deletion (prefer this over a bare DELETE so leave triggers stay quiet):
--   BEGIN;
--   SET LOCAL harmony.account_delete = '1';
--   DELETE FROM public.profiles WHERE id = '00000000-0000-0000-0000-000000000000';
--   COMMIT;
--
-- Destructive CASCADE side effects (intentional):
--   files.owner, bot_server_permissions.installed_by, user_servers.user_id
-- Orphaned SET NULL (history preserved, author/member becomes unknown):
--   messages, servers.owner, server_membership_events.user_id, reports, threads, …

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '2min';

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
ALTER TABLE public.messages
    ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.messages
    ALTER COLUMN pinned_by DROP NOT NULL;

ALTER TABLE public.messages
    DROP CONSTRAINT IF EXISTS messages_user_or_bot_check;

ALTER TABLE public.messages
    ADD CONSTRAINT messages_user_or_bot_check
    CHECK (user_id IS NULL OR bot_id IS NULL)
    NOT VALID;

ALTER TABLE public.messages
    DROP CONSTRAINT IF EXISTS messages_user_id_fkey;

ALTER TABLE public.messages
    ADD CONSTRAINT messages_user_id_fkey
    FOREIGN KEY (user_id)
    REFERENCES public.profiles(id)
    ON DELETE SET NULL
    NOT VALID;

ALTER TABLE public.messages
    DROP CONSTRAINT IF EXISTS messages_pinned_by_fkey;

ALTER TABLE public.messages
    ADD CONSTRAINT messages_pinned_by_fkey
    FOREIGN KEY (pinned_by)
    REFERENCES public.profiles(id)
    ON DELETE SET NULL
    NOT VALID;

-- ---------------------------------------------------------------------------
-- profiles FK helper
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pg_temp.replace_profiles_fk(
    p_table regclass,
    p_column text,
    p_on_delete text,
    p_make_nullable boolean DEFAULT false,
    p_new_conname text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
    v_con record;
    v_conname text;
    v_relname text;
    v_col_attnum int2;
    v_profiles_id_attnum int2;
BEGIN
    IF p_on_delete NOT IN ('CASCADE', 'SET NULL') THEN
        RAISE EXCEPTION 'Unsupported ON DELETE action: %', p_on_delete;
    END IF;

    SELECT relname INTO v_relname FROM pg_class WHERE oid = p_table;

    SELECT attnum INTO v_col_attnum
    FROM pg_attribute
    WHERE attrelid = p_table AND attname = p_column AND NOT attisdropped;

    -- Schema-lineage drift: some columns differ between the init.sql lineage and
    -- the migration lineage (e.g. files.owner_id vs files.owner). A column that
    -- doesn't exist here has no profiles FK to convert, so skip it rather than
    -- aborting the whole migration. The init schema already defines the correct
    -- ON DELETE behaviour for fresh-deploy lineages.
    IF v_col_attnum IS NULL THEN
        RAISE NOTICE 'replace_profiles_fk: skipping %.% (column absent on this schema lineage)', p_table, p_column;
        RETURN;
    END IF;

    SELECT attnum INTO v_profiles_id_attnum
    FROM pg_attribute
    WHERE attrelid = 'public.profiles'::regclass
      AND attname = 'id' AND NOT attisdropped;

    FOR v_con IN
        SELECT c.conname
        FROM pg_constraint c
        WHERE c.contype = 'f'
          AND c.conrelid = p_table
          AND c.confrelid = 'public.profiles'::regclass
          AND c.conkey = ARRAY[v_col_attnum]::int2[]
          AND c.confkey = ARRAY[v_profiles_id_attnum]::int2[]
    LOOP
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', p_table, v_con.conname);
    END LOOP;

    IF p_make_nullable THEN
        EXECUTE format('ALTER TABLE %s ALTER COLUMN %I DROP NOT NULL', p_table, p_column);
    END IF;

    v_conname := COALESCE(p_new_conname, v_relname || '_' || p_column || '_fkey');

    EXECUTE format(
        'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.profiles(id) ON DELETE %s NOT VALID',
        p_table, v_conname, p_column, p_on_delete
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- profiles FKs (legacy NO ACTION + explicit targets)
-- ---------------------------------------------------------------------------
SELECT pg_temp.replace_profiles_fk('public.servers'::regclass, 'owner', 'SET NULL', true, 'servers_owner_fkey');
SELECT pg_temp.replace_profiles_fk('public.files'::regclass, 'owner', 'CASCADE', false, 'files_owner_fkey');
SELECT pg_temp.replace_profiles_fk('public.bot_server_permissions'::regclass, 'installed_by', 'CASCADE', false, 'bot_server_permissions_installed_by_fkey');
SELECT pg_temp.replace_profiles_fk('public.emojis'::regclass, 'uploader', 'SET NULL', true, 'emojis_uploader_fkey');
SELECT pg_temp.replace_profiles_fk('public.blocked_instances'::regclass, 'blocked_by', 'SET NULL', true, 'blocked_instances_blocked_by_fkey');
SELECT pg_temp.replace_profiles_fk('public.instance_config'::regclass, 'updated_by', 'SET NULL', true, 'instance_config_updated_by_fkey');
SELECT pg_temp.replace_profiles_fk('public.server_encryption_settings'::regclass, 'updated_by', 'SET NULL', true, 'server_encryption_settings_updated_by_fkey');
SELECT pg_temp.replace_profiles_fk('public.server_membership_events'::regclass, 'initiated_by', 'SET NULL', true, 'server_membership_events_initiated_by_fkey');
SELECT pg_temp.replace_profiles_fk('public.server_membership_events'::regclass, 'user_id', 'SET NULL', true, 'server_membership_events_user_id_fkey');
SELECT pg_temp.replace_profiles_fk('public.user_servers'::regclass, 'user_id', 'CASCADE', false, 'user_servers_user_id_fkey');
SELECT pg_temp.replace_profiles_fk('public.server_bans'::regclass, 'banned_by', 'SET NULL', true, 'server_bans_banned_by_fkey');

DO $$
BEGIN
    IF to_regclass('public.reports') IS NOT NULL THEN
        PERFORM pg_temp.replace_profiles_fk(
            'public.reports'::regclass, 'reporter_id', 'SET NULL', true, 'reports_reporter_id_fkey'
        );
    END IF;

    IF to_regclass('public.threads') IS NOT NULL THEN
        PERFORM pg_temp.replace_profiles_fk(
            'public.threads'::regclass, 'created_by', 'SET NULL', true, 'threads_created_by_fkey'
        );
    END IF;

    -- discord_bridge_pairings.created_by is audit-only; the pairing belongs to
    -- the server. CASCADE here would wipe a working bridge when the creator's
    -- account is deleted, so convert to SET NULL + nullable.
    IF to_regclass('public.discord_bridge_pairings') IS NOT NULL THEN
        PERFORM pg_temp.replace_profiles_fk(
            'public.discord_bridge_pairings'::regclass, 'created_by', 'SET NULL', true,
            'discord_bridge_pairings_created_by_fkey'
        );
    END IF;
END $$;

-- Catch any other SET NULL + NOT NULL traps not listed above.
DO $$
DECLARE
    v_col record;
BEGIN
    FOR v_col IN
        SELECT
            nsp.nspname AS schema_name,
            cls.relname AS table_name,
            att.attname AS column_name
        FROM pg_constraint c
        JOIN pg_class cls ON cls.oid = c.conrelid
        JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
        JOIN pg_attribute att
          ON att.attrelid = c.conrelid
         AND att.attnum = c.conkey[1]
        WHERE c.contype = 'f'
          AND c.confrelid = 'public.profiles'::regclass
          AND cardinality(c.conkey) = 1
          AND c.confdeltype = 'n'
          AND att.attnotnull
          AND nsp.nspname = 'public'
    LOOP
        EXECUTE format(
            'ALTER TABLE %I.%I ALTER COLUMN %I DROP NOT NULL',
            v_col.schema_name, v_col.table_name, v_col.column_name
        );
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- user_servers leave triggers (account deletion cascade)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.route_server_leave()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_setting('harmony.skip_leave_message', true) = '1' THEN
        RETURN OLD;
    END IF;

    IF current_setting('harmony.account_delete', true) = '1' THEN
        RETURN OLD;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = OLD.user_id) THEN
        RETURN OLD;
    END IF;

    IF EXISTS (SELECT 1 FROM servers WHERE id = OLD.server_id) THEN
        INSERT INTO server_membership_events (server_id, user_id, event_type, payload)
        VALUES (OLD.server_id, OLD.user_id, 'leave', '{}'::jsonb);
    END IF;
    RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.handle_member_leave_system_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel_id uuid;
    v_is_local boolean;
BEGIN
    IF current_setting('harmony.skip_leave_message', true) = '1' THEN
        RETURN OLD;
    END IF;

    IF current_setting('harmony.account_delete', true) = '1' THEN
        RETURN OLD;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = OLD.user_id) THEN
        RETURN OLD;
    END IF;

    SELECT is_local_server INTO v_is_local
    FROM servers
    WHERE id = OLD.server_id;

    IF NOT FOUND OR v_is_local IS NOT TRUE THEN
        RETURN OLD;
    END IF;

    SELECT system_channel_id INTO v_channel_id
    FROM server_settings
    WHERE server_id = OLD.server_id;

    IF v_channel_id IS NULL THEN
        v_channel_id := get_default_channel(OLD.server_id);
    END IF;

    IF v_channel_id IS NULL THEN
        RETURN OLD;
    END IF;

    INSERT INTO messages (channel_id, user_id, content, is_system, metadata)
    VALUES (
        v_channel_id,
        OLD.user_id,
        jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'has left the server')),
        true,
        jsonb_build_object('type', 'member_leave')
    );

    RETURN OLD;
END;
$$;

COMMIT;

BEGIN;

SET LOCAL lock_timeout = '30s';
SET LOCAL statement_timeout = '10min';

ALTER TABLE public.messages VALIDATE CONSTRAINT messages_user_or_bot_check;
ALTER TABLE public.messages VALIDATE CONSTRAINT messages_user_id_fkey;
ALTER TABLE public.messages VALIDATE CONSTRAINT messages_pinned_by_fkey;

DO $$
DECLARE
    v_con record;
BEGIN
    FOR v_con IN
        SELECT c.conrelid::regclass AS tbl, c.conname
        FROM pg_constraint c
        JOIN pg_class cls ON cls.oid = c.conrelid
        JOIN pg_namespace nsp ON nsp.oid = cls.relnamespace
        WHERE c.contype = 'f'
          AND c.confrelid = 'public.profiles'::regclass
          AND nsp.nspname = 'public'
          AND cls.relname = ANY(ARRAY[
              'servers', 'files', 'bot_server_permissions', 'emojis',
              'blocked_instances', 'instance_config', 'server_encryption_settings',
              'server_membership_events', 'user_servers', 'server_bans',
              'reports', 'threads', 'discord_bridge_pairings'
          ])
          AND NOT c.convalidated
    LOOP
        EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', v_con.tbl, v_con.conname);
    END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
