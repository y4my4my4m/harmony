-- Adds the prekey and encryption columns production has and init/ lacks, plus the ten
-- foreign-key indexes 99_performance_hardening.sql skips when their column is missing.
--
-- get_user_prekey_bundle and rotate_prekeys read prekeys.is_used and used_by, and
-- get_conversation_encryption_status reads conversation_encryption_settings.verified. All
-- three raise 42703 on a fresh build.
--
-- prekeys_used_by_fkey is recreated with ON DELETE SET NULL. Production declares it with no
-- ON DELETE, so a consumed prekey pins the consumer's auth row and delete_my_account fails
-- 23503 after it has already anonymised the profile. The guard tests confdeltype so the
-- rebuild happens exactly where the constraint is still NO ACTION.

BEGIN;

-- 1 ---------------------------------------------------------------------------------------
-- prekeys.is_used, prekeys.used_by
DO $$
BEGIN
    IF to_regclass('public.prekeys') IS NULL THEN
        RAISE NOTICE 'skip prekeys columns: table absent';
        RETURN;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'public.prekeys'::regclass
          AND attname = 'is_used' AND NOT attisdropped
    ) THEN
        ALTER TABLE public.prekeys ADD COLUMN is_used boolean DEFAULT false;
        UPDATE public.prekeys SET is_used = true WHERE used_at IS NOT NULL;
        RAISE NOTICE 'prekeys.is_used added and backfilled from used_at';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_attribute
        WHERE attrelid = 'public.prekeys'::regclass
          AND attname = 'used_by' AND NOT attisdropped
    ) THEN
        ALTER TABLE public.prekeys ADD COLUMN used_by uuid;
        RAISE NOTICE 'prekeys.used_by added';
    END IF;

    IF to_regclass('auth.users') IS NULL THEN
        RAISE NOTICE 'skip prekeys_used_by_fkey: auth.users absent';
        RETURN;
    END IF;

    -- confdeltype 'n' is ON DELETE SET NULL. Under NO ACTION a consumed prekey
    -- pins the consumer's auth row and delete_my_account fails 23503.
    IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.prekeys'::regclass
          AND conname = 'prekeys_used_by_fkey' AND confdeltype <> 'n'
    ) THEN
        ALTER TABLE public.prekeys DROP CONSTRAINT prekeys_used_by_fkey;
        RAISE NOTICE 'prekeys_used_by_fkey dropped; recreated with ON DELETE SET NULL';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.prekeys'::regclass AND conname = 'prekeys_used_by_fkey'
    ) THEN
        ALTER TABLE public.prekeys
            ADD CONSTRAINT prekeys_used_by_fkey FOREIGN KEY (used_by)
            REFERENCES auth.users(id) ON DELETE SET NULL;
    END IF;
END $$;

-- 2 ---------------------------------------------------------------------------------------
-- The prekey SELECT policy is written conditionally in
-- init/31_rls_policies_extended.sql and in 20260616000012_rls_resync_from_init.sql: it gates
-- on is_used where the column exists and on used_at otherwise. Instances that took the
-- used_at branch are re-gated to is_used.
DO $$
DECLARE
    v_qual text;
BEGIN
    IF to_regclass('public.prekeys') IS NULL THEN
        RETURN;
    END IF;

    SELECT pg_get_expr(polqual, polrelid) INTO v_qual
    FROM pg_policy
    WHERE polrelid = 'public.prekeys'::regclass
      AND polname = 'Users can view others'' unused public prekeys';

    IF v_qual IS NULL THEN
        RAISE NOTICE 'skip prekey select policy: not present';
    ELSIF v_qual LIKE '%is_used%' THEN
        RAISE NOTICE 'skip prekey select policy: already gates on is_used';
    ELSE
        DROP POLICY "Users can view others' unused public prekeys" ON public.prekeys;
        CREATE POLICY "Users can view others' unused public prekeys" ON public.prekeys
            FOR SELECT USING (is_used = false);
        RAISE NOTICE 'prekey select policy re-gated from used_at to is_used';
    END IF;
END $$;

-- 3 ---------------------------------------------------------------------------------------
-- conversation_encryption_settings.verified
DO $$
BEGIN
    IF to_regclass('public.conversation_encryption_settings') IS NULL THEN
        RAISE NOTICE 'skip conversation_encryption_settings.verified: table absent';
        RETURN;
    END IF;

    ALTER TABLE public.conversation_encryption_settings
        ADD COLUMN IF NOT EXISTS verified boolean DEFAULT false;
END $$;

-- 4 ---------------------------------------------------------------------------------------
-- Foreign-key columns. Each pairs an ADD COLUMN with the constraint production
-- names, so a later dump diff sees the same constraint name on both sides.
-- Constraint creation is skipped where the referenced table is absent.
DO $$
DECLARE
    v_skipped  text[] := '{}';
    targets    constant text[][] := ARRAY[
        -- table, column, referenced table, constraint name
        ARRAY['blocked_instances',        'blocked_by',              'profiles',      'blocked_instances_blocked_by_fkey'],
        ARRAY['bot_audit_log',            'user_id',                 'profiles',      'bot_audit_log_user_id_fkey'],
        ARRAY['encryption_audit_log',     'related_conversation_id', 'conversations', 'encryption_audit_log_related_conversation_id_fkey'],
        ARRAY['encryption_audit_log',     'related_server_id',       'servers',       'encryption_audit_log_related_server_id_fkey'],
        ARRAY['encryption_audit_log',     'related_user_id',         'profiles',      'encryption_audit_log_related_user_id_fkey'],
        ARRAY['instance_config',          'updated_by',              'profiles',      'instance_config_updated_by_fkey'],
        ARRAY['server_federation_events', 'ap_activity_id',          'ap_activities', 'server_federation_events_ap_activity_id_fkey'],
        ARRAY['server_membership_events', 'initiated_by',            'profiles',      'server_membership_events_initiated_by_fkey'],
        ARRAY['voice_federation_events',  'ap_activity_id',          'ap_activities', 'voice_federation_events_ap_activity_id_fkey']
    ];
    i int;
BEGIN
    FOR i IN 1 .. array_length(targets, 1) LOOP
        DECLARE
            v_tbl  text := targets[i][1];
            v_col  text := targets[i][2];
            v_ref  text := targets[i][3];
            v_name text := targets[i][4];
        BEGIN
            IF to_regclass('public.' || quote_ident(v_tbl)) IS NULL THEN
                v_skipped := v_skipped || (v_tbl || '.' || v_col || ' (no table)');
                CONTINUE;
            END IF;

            EXECUTE format('ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS %I uuid', v_tbl, v_col);

            IF to_regclass('public.' || quote_ident(v_ref)) IS NULL THEN
                v_skipped := v_skipped || (v_tbl || '.' || v_col || ' FK (no ' || v_ref || ')');
                CONTINUE;
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conrelid = ('public.' || quote_ident(v_tbl))::regclass
                  AND conname = v_name
            ) THEN
                EXECUTE format(
                    'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(id) ON DELETE SET NULL',
                    v_tbl, v_name, v_col, v_ref
                );
            END IF;
        END;
    END LOOP;

    IF array_length(v_skipped, 1) IS NOT NULL THEN
        RAISE NOTICE 'foreign-key columns skipped: %', array_to_string(v_skipped, ', ');
    END IF;
END $$;

-- 5 ---------------------------------------------------------------------------------------
-- The ten indexes 99_performance_hardening skips when the column is missing.
-- Names and definitions are copied from that file so a fresh install and a
-- migrated instance end with the same index.
DO $$
DECLARE
    stmt text;
    stmts text[] := ARRAY[
        'CREATE INDEX IF NOT EXISTS idx_blocked_instances_blocked_by ON public.blocked_instances(blocked_by)',
        'CREATE INDEX IF NOT EXISTS idx_bot_audit_log_user_id ON public.bot_audit_log(user_id)',
        'CREATE INDEX IF NOT EXISTS idx_encryption_audit_log_related_conversation ON public.encryption_audit_log(related_conversation_id)',
        'CREATE INDEX IF NOT EXISTS idx_encryption_audit_log_related_server ON public.encryption_audit_log(related_server_id)',
        'CREATE INDEX IF NOT EXISTS idx_encryption_audit_log_related_user ON public.encryption_audit_log(related_user_id)',
        'CREATE INDEX IF NOT EXISTS idx_instance_config_updated_by ON public.instance_config(updated_by)',
        'CREATE INDEX IF NOT EXISTS idx_prekeys_used_by ON public.prekeys(used_by)',
        'CREATE INDEX IF NOT EXISTS idx_server_federation_events_ap_activity ON public.server_federation_events(ap_activity_id)',
        'CREATE INDEX IF NOT EXISTS idx_server_membership_events_initiated_by ON public.server_membership_events(initiated_by)',
        'CREATE INDEX IF NOT EXISTS idx_voice_federation_events_ap_activity ON public.voice_federation_events(ap_activity_id)'
    ];
BEGIN
    FOREACH stmt IN ARRAY stmts LOOP
        BEGIN
            EXECUTE stmt;
        EXCEPTION
            WHEN undefined_table OR undefined_column THEN
                RAISE NOTICE 'Skipping (missing table/column): %', stmt;
        END;
    END LOOP;
END $$;

COMMIT;
