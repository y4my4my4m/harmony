-- Columns, constraints and indexes of public tables in a fresh install's layout, on every instance.
--
-- Production's tables predate the baseline; staging's were built from init/. Both were compared
-- with a fresh install at 20261009000001: column type, nullability and default, CHECK, UNIQUE,
-- PRIMARY KEY and FOREIGN KEY definitions (ON DELETE included), and index definitions.
--
-- Production
--
--   ap_object_cache, files, bot_webhooks, bot_commands, blocked_instances,
--   server_federation_events, voice_federation_events
--       pre-baseline layouts, no rows, no reader of the legacy columns. Rebuilt in place;
--       a legacy column goes only while its table holds no row.
--   bot_presence, user_view_contexts
--       keyed on bot_id / user_id. The repository keys both on a surrogate id and keeps
--       bot_id / user_id unique.
--   post_hashtags
--       keyed on a surrogate id beside UNIQUE (post_id, hashtag_id); the repository keys on
--       (post_id, hashtag_id). Nothing reads the id.
--   user_servers.id
--       bigint identity, uuid in the repository. No foreign key, function or client keys on it.
--   bot_commands.required_permissions text[], channel_categories.order smallint, invites.code
--       varchar; bigint, integer and text in the repository.
--   Columns absent: user_servers nickname, muted, muted_until, updated_at; servers invite_code,
--       member_count; notification_preferences email_* and push_*; mfa_recovery_codes is_used;
--       conversation_encryption_settings rotation and visibility settings;
--       conversation_participants last_read_message_id; instance_webrtc_settings livekit_* and
--       turn_servers; bot_audit_log, bot_presence and others below. Added nullable or with the
--       repository's constant default; timestamp columns defaulting to now() stay NULL on
--       existing rows, and is_used is set from used_at.
--   Columns holding only defaults or insert timestamps, without a reader, dropped: bot_audit_log
--       description, endpoint, ip_address; bot_presence updated_at; conversation_encryption_settings
--       last_key_rotation, next_rotation_due, metadata; federation_delivery_queue activity_id;
--       instance_webrtc_settings max_stage_speakers; server_roles federation_metadata;
--       thread_members flags; timeline_entries metadata; user_mutes metadata and mute_type.
--   emoji_usage, mfa_recovery_codes and user_timeline_cache reference auth.users; the
--       repository references profiles. No row names an id outside profiles.
--   ON DELETE differs: channels.category, messages.reply_to (NO ACTION, repository SET NULL),
--       messages.thread_id (CASCADE, repository SET NULL), encryption_audit_log.user_id
--       (SET NULL, repository CASCADE); messages.conversation_id adds ON UPDATE CASCADE.
--   server_membership_events_event_type_check admits join, leave, kick and ban;
--       unban_server_member writes 'unban' and raises 23514. Dropped.
--   post_interactions_interaction_type_check restates post_interactions_type_check;
--       conversation_participants_conversation_fkey and _user_fkey duplicate the repository's
--       foreign keys. Dropped.
--   56 indexes and 10 constraints under other names, renamed. Constraints and indexes absent,
--       created; indexes of another definition under the repository's name, replaced.
--   posts_federation_status_check is absent and 38 rows hold 'federated', 'federating' or
--       'received' (newest 2026-03-23); it is added NOT VALID.
--   mfa_recovery_codes.batch_id is NULL on 50 rows; one generation writes its codes in one
--       statement, so codes sharing user_id and created_at form one batch.
--   timeline_entries.position is NULL on 460 rows; the repository's writers set it to the post's
--       created_at in microseconds since the epoch, and so does the backfill.
--
-- Staging
--
--   federation_delivery_queue carries activity_json and inbox_url NOT NULL without a default,
--       plus completed_at, last_error and scheduled_at. federation-backend's retry enqueue
--       writes none of them and raises 23502. No rows; dropped.
--   megolm_session_shares has UNIQUE (session_id, room_id, recipient_user_id,
--       recipient_device_id) instead of the repository's UNIQUE (room_id, session_id,
--       recipient_user_id), so the client's session-share upsert raises 42P10.
--   megolm_key_backups algorithm, auth_data, backup_version, etag, is_current, key_count;
--       megolm_session_shares forwarded_count, shared_at; user_key_pairs identity_key,
--       signed_prekey, signed_prekey_signature, updated_at: no data beyond defaults and
--       timestamps, no reader. Dropped with their indexes.
--   reports.reporter_id, server_membership_events.user_id, servers.owner and
--       threads.created_by cascade on profile deletion; the repository sets NULL.
--   messages_user_or_bot_check states the repository's condition in another form.
--   idx_threads_ap_id is not unique.
--
-- Left in place:
--
--   profiles_username_check: 72 remote profiles carry '.' or '-' in their username.
--   profiles.domain defaults to the instance's domain on production, 'localhost' in the
--       repository. channels.type and profiles.status defaults differ in spelling only.
--   bot_server_permissions flags (view_channels, speak, ...): bot-gateway reads them.
--   server_membership_events.metadata: 12 join rows hold data.
--   threads.federation_metadata: production's active_threads_view reads it.
--   Constraints and indexes production adds beyond the repository's, other than the above.
--
-- A fresh install carries six pairs of identical indexes: idx_channel_permission_overrides_role
-- and _role_id, _user and _user_id, idx_invites_server and _server_id,
-- idx_notification_channels_server and _server_id, idx_timeline_entries_position and
-- _user_type_position, idx_user_mutes_muted and _muted_user_id. Production has the second of
-- each; the first is not built.
--
-- timeline_entries holds 6.3 million rows on production. Its absent index and the NOT NULL on
-- position are not built inside this transaction; the notices print the statements.
--
-- A fresh install already has this layout; every step compares the catalog first.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- pg_get_constraintdef() qualifies a referenced table only when it is off the search_path.
SET LOCAL search_path = public, pg_temp;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Tables this large are not scanned or indexed inside the deploy transaction.
CREATE FUNCTION pg_temp.cc_large(p_rel regclass)
RETURNS boolean
LANGUAGE sql STABLE
AS $fn$
    SELECT c.reltuples > 1000000 FROM pg_catalog.pg_class c WHERE c.oid = p_rel;
$fn$;

-- pg_get_indexdef() without the index name.
CREATE FUNCTION pg_temp.cc_idxdef(p_index oid)
RETURNS text
LANGUAGE sql STABLE
AS $fn$
    SELECT regexp_replace(pg_catalog.pg_get_indexdef(p_index), '^(CREATE (UNIQUE )?INDEX) \S+ ON ', '\1 ON ');
$fn$;

CREATE PROCEDURE pg_temp.cc_not_null(p_table text, p_column text)
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_rel     regclass := ('public.' || quote_ident(p_table))::regclass;
    v_notnull boolean;
    v_nulls   bigint;
BEGIN
    SELECT a.attnotnull INTO v_notnull
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = v_rel AND a.attname = p_column AND a.attnum > 0 AND NOT a.attisdropped;
    IF v_notnull IS NULL OR v_notnull THEN
        RETURN;
    END IF;
    IF pg_temp.cc_large(v_rel) THEN
        RAISE NOTICE '%.%: nullable, not scanned here; run ALTER TABLE public.% ALTER COLUMN % SET NOT NULL',
            p_table, p_column, quote_ident(p_table), quote_ident(p_column);
        RETURN;
    END IF;
    EXECUTE format('SELECT count(*) FROM %s WHERE %I IS NULL', v_rel, p_column) INTO v_nulls;
    IF v_nulls > 0 THEN
        RAISE NOTICE '%.%: % rows NULL, left nullable', p_table, p_column, v_nulls;
        RETURN;
    END IF;
    EXECUTE format('ALTER TABLE %s ALTER COLUMN %I SET NOT NULL', v_rel, p_column);
    RAISE NOTICE '%.%: NOT NULL', p_table, p_column;
END;
$fn$;

CREATE PROCEDURE pg_temp.cc_nullable(p_table text, p_column text)
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_rel regclass := ('public.' || quote_ident(p_table))::regclass;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_attribute a
                WHERE a.attrelid = v_rel AND a.attname = p_column AND a.attnotnull AND NOT a.attisdropped) THEN
        EXECUTE format('ALTER TABLE %s ALTER COLUMN %I DROP NOT NULL', v_rel, p_column);
        RAISE NOTICE '%.%: nullable', p_table, p_column;
    END IF;
END;
$fn$;

-- p_default is the expression as pg_get_expr() renders it; NULL means no default.
CREATE PROCEDURE pg_temp.cc_default(p_table text, p_column text, p_default text)
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_rel  regclass := ('public.' || quote_ident(p_table))::regclass;
    v_have text;
BEGIN
    SELECT pg_catalog.pg_get_expr(d.adbin, d.adrelid) INTO v_have
      FROM pg_catalog.pg_attrdef d JOIN pg_catalog.pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum
     WHERE d.adrelid = v_rel AND a.attname = p_column;
    IF v_have IS NOT DISTINCT FROM p_default THEN
        RETURN;
    END IF;
    IF p_default IS NULL THEN
        EXECUTE format('ALTER TABLE %s ALTER COLUMN %I DROP DEFAULT', v_rel, p_column);
    ELSE
        EXECUTE format('ALTER TABLE %s ALTER COLUMN %I SET DEFAULT %s', v_rel, p_column, p_default);
    END IF;
    RAISE NOTICE '%.%: default %, was %', p_table, p_column, coalesce(p_default, 'none'), coalesce(v_have, 'none');
END;
$fn$;

-- Drops a column unless a row matches p_keep, or a view or policy reads it. p_keep NULL drops
-- unconditionally. Dropping a column drops the indexes and constraints that include it.
CREATE PROCEDURE pg_temp.cc_drop_column(p_table text, p_column text, p_keep text)
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_rel  regclass := to_regclass('public.' || quote_ident(p_table));
    v_num  smallint;
    v_rows bigint := 0;
BEGIN
    SELECT a.attnum INTO v_num
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid = v_rel AND a.attname = p_column AND a.attnum > 0 AND NOT a.attisdropped;
    IF v_num IS NULL THEN
        RETURN;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                WHERE d.refobjid = v_rel AND d.refobjsubid = v_num AND d.deptype = 'n'
                  AND d.classid IN ('pg_catalog.pg_rewrite'::regclass, 'pg_catalog.pg_policy'::regclass)) THEN
        RAISE NOTICE '%.%: a view or policy reads it, kept', p_table, p_column;
        RETURN;
    END IF;
    IF p_keep IS NOT NULL THEN
        EXECUTE format('SELECT count(*) FROM %s WHERE %s', v_rel, p_keep) INTO v_rows;
    END IF;
    IF v_rows > 0 THEN
        RAISE NOTICE '%.%: % rows hold data, kept', p_table, p_column, v_rows;
        RETURN;
    END IF;
    EXECUTE format('ALTER TABLE %s DROP COLUMN %I', v_rel, p_column);
    RAISE NOTICE '%.%: dropped', p_table, p_column;
END;
$fn$;

CREATE PROCEDURE pg_temp.cc_validate(p_rel regclass, p_name text)
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_expr text;
    v_rows bigint;
BEGIN
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', p_rel, p_name);
EXCEPTION WHEN check_violation OR foreign_key_violation THEN
    SELECT pg_catalog.pg_get_expr(k.conbin, k.conrelid) INTO v_expr
      FROM pg_catalog.pg_constraint k WHERE k.conrelid = p_rel AND k.conname = p_name AND k.contype = 'c';
    IF v_expr IS NOT NULL THEN
        EXECUTE format('SELECT count(*) FROM %s WHERE (%s) IS FALSE', p_rel, v_expr) INTO v_rows;
        RAISE NOTICE '%.%: left NOT VALID, % rows violate it', p_rel, p_name, v_rows;
    ELSE
        RAISE NOTICE '%.%: left NOT VALID, %', p_rel, p_name, SQLERRM;
    END IF;
END;
$fn$;

-- Asserts one constraint as pg_get_constraintdef() renders it. A constraint of the same
-- definition under another name is renamed; a plain unique index of the same definition
-- becomes the index of a UNIQUE or PRIMARY KEY; a constraint of the name with another
-- definition is replaced. CHECK and FOREIGN KEY are added NOT VALID and then validated.
CREATE PROCEDURE pg_temp.cc_constraint(p_table text, p_name text, p_def text)
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_rel   regclass := ('public.' || quote_ident(p_table))::regclass;
    v_type  "char" := CASE split_part(p_def, ' ', 1)
                          WHEN 'CHECK' THEN 'c' WHEN 'FOREIGN' THEN 'f'
                          WHEN 'UNIQUE' THEN 'u' WHEN 'PRIMARY' THEN 'p' END;
    v_have  record;
    v_twin  record;
    v_index text;
BEGIN
    SELECT k.oid, pg_catalog.pg_get_constraintdef(k.oid) AS def, k.convalidated INTO v_have
      FROM pg_catalog.pg_constraint k
     WHERE k.conrelid = v_rel AND k.conname = p_name;
    IF v_have.def = p_def THEN
        IF NOT v_have.convalidated THEN
            CALL pg_temp.cc_validate(v_rel, p_name);
        END IF;
        RETURN;
    END IF;

    SELECT k.conname, k.convalidated INTO v_twin
      FROM pg_catalog.pg_constraint k
     WHERE k.conrelid = v_rel AND k.conname <> p_name AND k.contype = v_type
       AND pg_catalog.pg_get_constraintdef(k.oid) = p_def
     ORDER BY k.conname
     LIMIT 1;

    IF v_twin.conname IS NOT NULL THEN
        IF v_have.oid IS NOT NULL THEN
            EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_rel, p_name);
            RAISE NOTICE '%.%: dropped, was %', p_table, p_name, v_have.def;
        END IF;
        EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', v_rel, v_twin.conname, p_name);
        RAISE NOTICE '%.%: renamed from %', p_table, p_name, v_twin.conname;
        IF NOT v_twin.convalidated THEN
            CALL pg_temp.cc_validate(v_rel, p_name);
        END IF;
        RETURN;
    END IF;

    IF v_type IN ('u', 'p') THEN
        SELECT i.relname INTO v_index
          FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
         WHERE x.indrelid = v_rel AND x.indisunique AND x.indisvalid
           AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint k WHERE k.conindid = x.indexrelid)
           AND pg_temp.cc_idxdef(x.indexrelid) = format('CREATE UNIQUE INDEX ON public.%I USING btree %s',
                                                        p_table, substring(p_def FROM '\(.*\)$'))
         ORDER BY i.relname
         LIMIT 1;
        -- A failed replacement keeps the constraint it would replace.
        BEGIN
            IF v_have.oid IS NOT NULL THEN
                EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_rel, p_name);
                RAISE NOTICE '%.%: dropped, was %', p_table, p_name, v_have.def;
            END IF;
            IF v_index IS NOT NULL THEN
                EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s USING INDEX %I', v_rel, p_name,
                               CASE v_type WHEN 'u' THEN 'UNIQUE' ELSE 'PRIMARY KEY' END, v_index);
                RAISE NOTICE '%.%: index % attached', p_table, p_name, v_index;
            ELSE
                EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s', v_rel, p_name, p_def);
                RAISE NOTICE '%.%: added', p_table, p_name;
            END IF;
        EXCEPTION WHEN unique_violation OR not_null_violation THEN
            RAISE NOTICE '%.%: not added, %', p_table, p_name, SQLERRM;
        END;
        RETURN;
    END IF;

    IF v_have.oid IS NOT NULL THEN
        EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', v_rel, p_name);
        RAISE NOTICE '%.%: dropped, was %', p_table, p_name, v_have.def;
    END IF;
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I %s NOT VALID', v_rel, p_name, p_def);
    RAISE NOTICE '%.%: added', p_table, p_name;
    CALL pg_temp.cc_validate(v_rel, p_name);
END;
$fn$;

-- Asserts one index as pg_get_indexdef() renders it. An index of the same definition under
-- another name is renamed, with its constraint when it backs one; an index of the name with
-- another definition is replaced unless it backs a constraint.
CREATE PROCEDURE pg_temp.cc_index(p_ddl text)
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_name text := (regexp_match(p_ddl, '^CREATE (?:UNIQUE )?INDEX (\S+) ON '))[1];
    v_rel  regclass := (regexp_match(p_ddl, ' ON (\S+) USING '))[1]::regclass;
    v_want text := regexp_replace(p_ddl, '^(CREATE (UNIQUE )?INDEX) \S+ ON ', '\1 ON ');
    v_have record;
    v_twin record;
BEGIN
    SELECT i.oid, pg_temp.cc_idxdef(i.oid) AS def, k.conname INTO v_have
      FROM pg_catalog.pg_class i
      JOIN pg_catalog.pg_index x ON x.indexrelid = i.oid
      LEFT JOIN pg_catalog.pg_constraint k ON k.conindid = i.oid AND k.conrelid = x.indrelid
     WHERE i.relnamespace = 'public'::regnamespace AND i.relname = v_name;
    IF v_have.def = v_want THEN
        RETURN;
    END IF;

    SELECT i.relname, k.conname INTO v_twin
      FROM pg_catalog.pg_index x
      JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid
      LEFT JOIN pg_catalog.pg_constraint k ON k.conindid = i.oid AND k.conrelid = x.indrelid
     WHERE x.indrelid = v_rel AND i.relname <> v_name AND pg_temp.cc_idxdef(i.oid) = v_want
     ORDER BY k.conname IS NOT NULL, i.relname
     LIMIT 1;

    IF v_have.oid IS NOT NULL THEN
        IF v_have.conname IS NOT NULL THEN
            RAISE NOTICE '%: backs constraint %, left as %', v_name, v_have.conname, v_have.def;
            RETURN;
        END IF;
        IF v_twin.relname IS NULL AND pg_temp.cc_large(v_rel) THEN
            RAISE NOTICE '%: is %; run DROP INDEX CONCURRENTLY public.%; %',
                v_name, v_have.def, quote_ident(v_name), replace(p_ddl, 'INDEX ', 'INDEX CONCURRENTLY ');
            RETURN;
        END IF;
        EXECUTE format('DROP INDEX public.%I', v_name);
        RAISE NOTICE '%: dropped, was %', v_name, v_have.def;
    END IF;

    IF v_twin.relname IS NOT NULL THEN
        IF v_twin.conname IS NOT NULL THEN
            EXECUTE format('ALTER TABLE %s RENAME CONSTRAINT %I TO %I', v_rel, v_twin.conname, v_name);
        ELSE
            EXECUTE format('ALTER INDEX public.%I RENAME TO %I', v_twin.relname, v_name);
        END IF;
        RAISE NOTICE '%: renamed from %', v_name, v_twin.relname;
        RETURN;
    END IF;

    IF pg_temp.cc_large(v_rel) THEN
        RAISE NOTICE '%: absent, not built here; run %', v_name, replace(p_ddl, 'INDEX ', 'INDEX CONCURRENTLY ');
        RETURN;
    END IF;
    BEGIN
        EXECUTE p_ddl;
        RAISE NOTICE '%: created', v_name;
    EXCEPTION WHEN unique_violation THEN
        RAISE NOTICE '%: not created, %', v_name, SQLERRM;
    END;
END;
$fn$;

-- ---------------------------------------------------------------------------
-- Rows the repository's writers would have filled
-- ---------------------------------------------------------------------------

UPDATE public.timeline_entries te
   SET position = EXTRACT(epoch FROM p.created_at) * 1000000
  FROM public.posts p
 WHERE te.position IS NULL AND p.id = te.post_id;

UPDATE public.mfa_recovery_codes r
   SET batch_id = b.batch_id
  FROM (SELECT user_id, created_at, gen_random_uuid() AS batch_id
          FROM public.mfa_recovery_codes
         WHERE batch_id IS NULL
         GROUP BY user_id, created_at) b
 WHERE r.batch_id IS NULL
   AND r.user_id IS NOT DISTINCT FROM b.user_id
   AND r.created_at IS NOT DISTINCT FROM b.created_at;

-- is_used mirrors used_at where the column is new.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute
                    WHERE attrelid = 'public.mfa_recovery_codes'::regclass AND attname = 'is_used' AND NOT attisdropped) THEN
        ALTER TABLE public.mfa_recovery_codes ADD COLUMN is_used boolean DEFAULT false;
        UPDATE public.mfa_recovery_codes SET is_used = true WHERE used_at IS NOT NULL;
        RAISE NOTICE 'mfa_recovery_codes.is_used: added';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Pre-baseline tables. A legacy column goes only while its table holds no row.
-- ---------------------------------------------------------------------------

ALTER TABLE public.ap_object_cache
    ADD COLUMN IF NOT EXISTS object_url text,
    ADD COLUMN IF NOT EXISTS object_json jsonb,
    ADD COLUMN IF NOT EXISTS fetched_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS expires_at timestamp with time zone;
CALL pg_temp.cc_default('ap_object_cache', 'fetched_at', 'now()');
CALL pg_temp.cc_default('ap_object_cache', 'expires_at', '(now() + ''01:00:00''::interval)');
CALL pg_temp.cc_not_null('ap_object_cache', 'object_url');
CALL pg_temp.cc_not_null('ap_object_cache', 'object_json');
CALL pg_temp.cc_drop_column('ap_object_cache', 'ap_id', 'true');
CALL pg_temp.cc_drop_column('ap_object_cache', 'object_data', 'true');
CALL pg_temp.cc_drop_column('ap_object_cache', 'cache_expires_at', 'true');
CALL pg_temp.cc_drop_column('ap_object_cache', 'created_at', 'true');
CALL pg_temp.cc_drop_column('ap_object_cache', 'updated_at', 'true');
CALL pg_temp.cc_drop_column('ap_object_cache', 'fetch_attempts', 'true');
CALL pg_temp.cc_drop_column('ap_object_cache', 'is_reachable', 'true');
CALL pg_temp.cc_drop_column('ap_object_cache', 'last_error', 'true');
CALL pg_temp.cc_drop_column('ap_object_cache', 'last_fetched_at', 'true');

ALTER TABLE public.files
    ADD COLUMN IF NOT EXISTS owner_id uuid,
    ADD COLUMN IF NOT EXISTS filename text,
    ADD COLUMN IF NOT EXISTS content_type text,
    ADD COLUMN IF NOT EXISTS size_bytes bigint,
    ADD COLUMN IF NOT EXISTS storage_path text,
    ADD COLUMN IF NOT EXISTS public_url text,
    ADD COLUMN IF NOT EXISTS width integer,
    ADD COLUMN IF NOT EXISTS height integer,
    ADD COLUMN IF NOT EXISTS blurhash text,
    ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;
CALL pg_temp.cc_not_null('files', 'owner_id');
CALL pg_temp.cc_not_null('files', 'filename');
CALL pg_temp.cc_not_null('files', 'content_type');
CALL pg_temp.cc_not_null('files', 'size_bytes');
CALL pg_temp.cc_not_null('files', 'storage_path');
CALL pg_temp.cc_drop_column('files', 'owner', 'true');
CALL pg_temp.cc_drop_column('files', 'name', 'true');
CALL pg_temp.cc_drop_column('files', 'type', 'true');
CALL pg_temp.cc_drop_column('files', 'size', 'true');
CALL pg_temp.cc_drop_column('files', 'url', 'true');
CALL pg_temp.cc_drop_column('files', 'description', 'true');
CALL pg_temp.cc_drop_column('files', 'updated_at', 'true');

ALTER TABLE public.bot_webhooks
    ADD COLUMN IF NOT EXISTS name text,
    ADD COLUMN IF NOT EXISTS channel_id uuid,
    ADD COLUMN IF NOT EXISTS server_id uuid,
    ADD COLUMN IF NOT EXISTS failure_count integer DEFAULT 0,
    ADD COLUMN IF NOT EXISTS trigger_count integer DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_triggered_at timestamp with time zone;
CALL pg_temp.cc_not_null('bot_webhooks', 'name');
CALL pg_temp.cc_default('bot_webhooks', 'events', '''{}''::text[]');
CALL pg_temp.cc_drop_column('bot_webhooks', 'failed_deliveries', 'true');
CALL pg_temp.cc_drop_column('bot_webhooks', 'is_verified', 'true');
CALL pg_temp.cc_drop_column('bot_webhooks', 'last_failure_at', 'true');
CALL pg_temp.cc_drop_column('bot_webhooks', 'last_success_at', 'true');
CALL pg_temp.cc_drop_column('bot_webhooks', 'max_retries', 'true');
CALL pg_temp.cc_drop_column('bot_webhooks', 'metadata', 'true');
CALL pg_temp.cc_drop_column('bot_webhooks', 'retry_delay_seconds', 'true');

ALTER TABLE public.bot_commands
    ADD COLUMN IF NOT EXISTS command_type text DEFAULT 'prefix'::text,
    ADD COLUMN IF NOT EXISTS usage text,
    ADD COLUMN IF NOT EXISTS cooldown_seconds integer DEFAULT 0,
    ADD COLUMN IF NOT EXISTS is_guild_command boolean DEFAULT true,
    ADD COLUMN IF NOT EXISTS enabled_guild_ids uuid[] DEFAULT '{}'::uuid[],
    ADD COLUMN IF NOT EXISTS usage_count integer DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_used_at timestamp with time zone;
DO $$
BEGIN
    IF (SELECT atttypid FROM pg_catalog.pg_attribute
         WHERE attrelid = 'public.bot_commands'::regclass AND attname = 'required_permissions') <> 'bigint'::regtype THEN
        IF EXISTS (SELECT 1 FROM public.bot_commands) THEN
            RAISE NOTICE 'bot_commands.required_permissions: not bigint, table holds rows, kept';
        ELSE
            ALTER TABLE public.bot_commands
                ALTER COLUMN required_permissions DROP DEFAULT,
                ALTER COLUMN required_permissions TYPE bigint USING NULL;
            RAISE NOTICE 'bot_commands.required_permissions: bigint';
        END IF;
    END IF;
END;
$$;
CALL pg_temp.cc_default('bot_commands', 'required_permissions', '0');
CALL pg_temp.cc_nullable('bot_commands', 'description');
CALL pg_temp.cc_drop_column('bot_commands', 'category', 'true');
CALL pg_temp.cc_drop_column('bot_commands', 'default_permission', 'true');
CALL pg_temp.cc_drop_column('bot_commands', 'display_order', 'true');
CALL pg_temp.cc_drop_column('bot_commands', 'dm_enabled', 'true');
CALL pg_temp.cc_drop_column('bot_commands', 'server_enabled', 'true');

ALTER TABLE public.blocked_instances
    ADD COLUMN IF NOT EXISTS severity text DEFAULT 'suspend'::text,
    ADD COLUMN IF NOT EXISTS created_by uuid;
CALL pg_temp.cc_nullable('blocked_instances', 'reason');
CALL pg_temp.cc_drop_column('blocked_instances', 'block_type', 'true');
CALL pg_temp.cc_drop_column('blocked_instances', 'expires_at', 'true');
CALL pg_temp.cc_drop_column('blocked_instances', 'metadata', 'true');

ALTER TABLE public.server_federation_events ADD COLUMN IF NOT EXISTS payload jsonb;
CALL pg_temp.cc_not_null('server_federation_events', 'payload');
CALL pg_temp.cc_not_null('server_federation_events', 'server_id');
CALL pg_temp.cc_drop_column('server_federation_events', 'event_data', 'true');
CALL pg_temp.cc_drop_column('server_federation_events', 'federated_to', 'true');
CALL pg_temp.cc_drop_column('server_federation_events', 'metadata', 'true');
CALL pg_temp.cc_drop_column('server_federation_events', 'server_domain', 'true');
CALL pg_temp.cc_drop_column('server_federation_events', 'user_id', 'true');

ALTER TABLE public.voice_federation_events ADD COLUMN IF NOT EXISTS payload jsonb DEFAULT '{}'::jsonb;
CALL pg_temp.cc_not_null('voice_federation_events', 'channel_id');
CALL pg_temp.cc_not_null('voice_federation_events', 'user_id');
CALL pg_temp.cc_drop_column('voice_federation_events', 'federated_to', 'true');
CALL pg_temp.cc_drop_column('voice_federation_events', 'metadata', 'true');
CALL pg_temp.cc_drop_column('voice_federation_events', 'server_id', 'true');
CALL pg_temp.cc_drop_column('voice_federation_events', 'session_id', 'true');
CALL pg_temp.cc_drop_column('voice_federation_events', 'voice_state', 'true');

-- Staging. No reader; federation-backend's enqueue writes none of them.
CALL pg_temp.cc_drop_column('federation_delivery_queue', 'activity_json', 'activity_json IS NOT NULL');
CALL pg_temp.cc_drop_column('federation_delivery_queue', 'inbox_url', 'inbox_url IS NOT NULL');
CALL pg_temp.cc_drop_column('federation_delivery_queue', 'completed_at', 'completed_at IS NOT NULL');
CALL pg_temp.cc_drop_column('federation_delivery_queue', 'last_error', 'last_error IS NOT NULL');
CALL pg_temp.cc_drop_column('federation_delivery_queue', 'scheduled_at', 'true');
-- Production.
CALL pg_temp.cc_drop_column('federation_delivery_queue', 'activity_id', 'activity_id IS NOT NULL');
CALL pg_temp.cc_nullable('federation_delivery_queue', 'created_at');
CALL pg_temp.cc_not_null('federation_delivery_queue', 'target_domain');
CALL pg_temp.cc_not_null('federation_delivery_queue', 'target_inbox_url');

-- ---------------------------------------------------------------------------
-- Columns absent, columns without data or reader, types, nullability, defaults
-- ---------------------------------------------------------------------------

ALTER TABLE public.bot_audit_log
    ADD COLUMN IF NOT EXISTS target_type text,
    ADD COLUMN IF NOT EXISTS target_id text,
    ADD COLUMN IF NOT EXISTS request_data jsonb DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS response_data jsonb DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS duration_ms integer;
CALL pg_temp.cc_drop_column('bot_audit_log', 'description', 'description IS NOT NULL');
CALL pg_temp.cc_drop_column('bot_audit_log', 'endpoint', 'endpoint IS NOT NULL');
CALL pg_temp.cc_drop_column('bot_audit_log', 'ip_address', 'ip_address IS NOT NULL');

ALTER TABLE public.bot_presence
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS gateway_version text,
    ADD COLUMN IF NOT EXISTS shard_id integer,
    ADD COLUMN IF NOT EXISTS total_shards integer;
-- Set at insert; nothing reads it.
CALL pg_temp.cc_drop_column('bot_presence', 'updated_at', NULL);

ALTER TABLE public.user_view_contexts
    ADD COLUMN IF NOT EXISTS id uuid DEFAULT gen_random_uuid() NOT NULL,
    ADD COLUMN IF NOT EXISTS created_at timestamp with time zone;
CALL pg_temp.cc_default('user_view_contexts', 'created_at', 'now()');
CALL pg_temp.cc_default('user_view_contexts', 'view_type', NULL);

ALTER TABLE public.conversation_encryption_settings
    ADD COLUMN IF NOT EXISTS encryption_algorithm text DEFAULT 'm.megolm.v1.aes-sha2'::text,
    ADD COLUMN IF NOT EXISTS rotation_period_ms bigint DEFAULT 604800000,
    ADD COLUMN IF NOT EXISTS rotation_message_count integer DEFAULT 100,
    ADD COLUMN IF NOT EXISTS history_visibility text DEFAULT 'shared'::text,
    ADD COLUMN IF NOT EXISTS current_session_id text,
    ADD COLUMN IF NOT EXISTS last_rotation_at timestamp with time zone;
CALL pg_temp.cc_nullable('conversation_encryption_settings', 'created_at');
CALL pg_temp.cc_drop_column('conversation_encryption_settings', 'last_key_rotation', 'last_key_rotation IS NOT NULL');
CALL pg_temp.cc_drop_column('conversation_encryption_settings', 'next_rotation_due', 'next_rotation_due IS NOT NULL');
CALL pg_temp.cc_drop_column('conversation_encryption_settings', 'metadata', 'metadata IS DISTINCT FROM ''{}''::jsonb');

ALTER TABLE public.conversation_participants ADD COLUMN IF NOT EXISTS last_read_message_id uuid;

ALTER TABLE public.instance_webrtc_settings
    ADD COLUMN IF NOT EXISTS livekit_api_key text,
    ADD COLUMN IF NOT EXISTS livekit_api_secret text,
    ADD COLUMN IF NOT EXISTS livekit_public_url text,
    ADD COLUMN IF NOT EXISTS turn_servers jsonb DEFAULT '[]'::jsonb;
CALL pg_temp.cc_nullable('instance_webrtc_settings', 'webrtc_mode');
CALL pg_temp.cc_nullable('instance_webrtc_settings', 'allow_federated_voice');
CALL pg_temp.cc_nullable('instance_webrtc_settings', 'created_at');
CALL pg_temp.cc_nullable('instance_webrtc_settings', 'updated_at');
CALL pg_temp.cc_drop_column('instance_webrtc_settings', 'max_stage_speakers', 'max_stage_speakers IS DISTINCT FROM 10');

ALTER TABLE public.megolm_key_backups ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone;
CALL pg_temp.cc_default('megolm_key_backups', 'updated_at', 'now()');
CALL pg_temp.cc_nullable('megolm_key_backups', 'version');
CALL pg_temp.cc_nullable('megolm_key_backups', 'encrypted_data');
CALL pg_temp.cc_nullable('megolm_key_backups', 'backup_hash');
CALL pg_temp.cc_nullable('megolm_key_backups', 'last_updated');
CALL pg_temp.cc_drop_column('megolm_key_backups', 'algorithm', 'algorithm IS DISTINCT FROM ''m.megolm_backup.v1.curve25519-aes-sha2''');
CALL pg_temp.cc_drop_column('megolm_key_backups', 'auth_data', 'auth_data IS NOT NULL');
CALL pg_temp.cc_drop_column('megolm_key_backups', 'backup_version', 'backup_version IS NOT NULL');
CALL pg_temp.cc_drop_column('megolm_key_backups', 'etag', 'etag IS NOT NULL');
CALL pg_temp.cc_drop_column('megolm_key_backups', 'is_current', 'is_current IS DISTINCT FROM true');
CALL pg_temp.cc_drop_column('megolm_key_backups', 'key_count', 'key_count IS DISTINCT FROM 0');

-- shared_at equals created_at on every row.
CALL pg_temp.cc_nullable('megolm_session_shares', 'sender_user_id');
CALL pg_temp.cc_drop_column('megolm_session_shares', 'forwarded_count', 'forwarded_count IS DISTINCT FROM 0');
CALL pg_temp.cc_drop_column('megolm_session_shares', 'shared_at', NULL);

-- updated_at equals created_at on every row; nothing writes it.
CALL pg_temp.cc_nullable('user_key_pairs', 'device_id');
CALL pg_temp.cc_not_null('user_key_pairs', 'created_at');
CALL pg_temp.cc_not_null('user_key_pairs', 'identity_public_key');
CALL pg_temp.cc_not_null('user_key_pairs', 'identity_private_key_encrypted');
CALL pg_temp.cc_drop_column('user_key_pairs', 'identity_key', 'identity_key IS NOT NULL');
CALL pg_temp.cc_drop_column('user_key_pairs', 'signed_prekey', 'signed_prekey IS NOT NULL');
CALL pg_temp.cc_drop_column('user_key_pairs', 'signed_prekey_signature', 'signed_prekey_signature IS NOT NULL');
CALL pg_temp.cc_drop_column('user_key_pairs', 'updated_at', NULL);

CALL pg_temp.cc_not_null('mfa_recovery_codes', 'batch_id');
CALL pg_temp.cc_default('mfa_recovery_codes', 'id', 'gen_random_uuid()');

ALTER TABLE public.notification_preferences
    ADD COLUMN IF NOT EXISTS email_mentions boolean DEFAULT true,
    ADD COLUMN IF NOT EXISTS email_follows boolean DEFAULT true,
    ADD COLUMN IF NOT EXISTS email_replies boolean DEFAULT true,
    ADD COLUMN IF NOT EXISTS email_reblogs boolean DEFAULT true,
    ADD COLUMN IF NOT EXISTS email_favorites boolean DEFAULT true,
    ADD COLUMN IF NOT EXISTS push_follows boolean DEFAULT true,
    ADD COLUMN IF NOT EXISTS push_replies boolean DEFAULT true,
    ADD COLUMN IF NOT EXISTS push_reblogs boolean DEFAULT true,
    ADD COLUMN IF NOT EXISTS push_favorites boolean DEFAULT true;

ALTER TABLE public.notification_rate_limits ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone;
CALL pg_temp.cc_default('notification_rate_limits', 'updated_at', 'now()');

-- Nothing maintains member_count; guard_server_client_write holds it at 0.
ALTER TABLE public.servers
    ADD COLUMN IF NOT EXISTS invite_code text,
    ADD COLUMN IF NOT EXISTS member_count integer DEFAULT 0;
CALL pg_temp.cc_not_null('servers', 'name');
CALL pg_temp.cc_nullable('servers', 'owner');

ALTER TABLE public.user_servers
    ADD COLUMN IF NOT EXISTS nickname text,
    ADD COLUMN IF NOT EXISTS muted boolean DEFAULT false,
    ADD COLUMN IF NOT EXISTS muted_until timestamp with time zone,
    ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone;
CALL pg_temp.cc_default('user_servers', 'updated_at', 'now()');

DO $$
BEGIN
    IF (SELECT atttypid FROM pg_catalog.pg_attribute
         WHERE attrelid = 'public.user_servers'::regclass AND attname = 'id') <> 'uuid'::regtype THEN
        ALTER TABLE public.user_servers ALTER COLUMN id DROP IDENTITY IF EXISTS;
        ALTER TABLE public.user_servers
            ALTER COLUMN id DROP DEFAULT,
            ALTER COLUMN id TYPE uuid USING gen_random_uuid();
        RAISE NOTICE 'user_servers.id: uuid';
    END IF;
END;
$$;
CALL pg_temp.cc_default('user_servers', 'id', 'gen_random_uuid()');

-- post_hashtags.id goes once the constraint section keys the table on (post_id, hashtag_id).

DO $$
BEGIN
    IF (SELECT atttypid FROM pg_catalog.pg_attribute
         WHERE attrelid = 'public.channel_categories'::regclass AND attname = 'order') = 'smallint'::regtype THEN
        ALTER TABLE public.channel_categories ALTER COLUMN "order" TYPE integer;
        RAISE NOTICE 'channel_categories.order: integer';
    END IF;
    IF (SELECT atttypid FROM pg_catalog.pg_attribute
         WHERE attrelid = 'public.invites'::regclass AND attname = 'code') = 'character varying'::regtype THEN
        ALTER TABLE public.invites ALTER COLUMN code TYPE text;
        RAISE NOTICE 'invites.code: text';
    END IF;
END;
$$;
CALL pg_temp.cc_default('channel_categories', 'order', '0');
CALL pg_temp.cc_not_null('channel_categories', 'name');
CALL pg_temp.cc_not_null('channel_categories', 'server_id');
CALL pg_temp.cc_default('invites', 'uses', '0');
CALL pg_temp.cc_not_null('invites', 'code');
CALL pg_temp.cc_not_null('invites', 'server_id');
CALL pg_temp.cc_not_null('invites', 'created_by');
CALL pg_temp.cc_nullable('invites', 'created_at');

CALL pg_temp.cc_drop_column('server_roles', 'federation_metadata', 'federation_metadata IS DISTINCT FROM ''{}''::jsonb');
CALL pg_temp.cc_default('server_roles', 'color', NULL);
CALL pg_temp.cc_default('server_roles', 'mentionable', 'true');
CALL pg_temp.cc_nullable('server_roles', 'updated_at');

CALL pg_temp.cc_drop_column('thread_members', 'flags', 'flags IS DISTINCT FROM 0');
CALL pg_temp.cc_drop_column('user_mutes', 'metadata', 'metadata IS DISTINCT FROM ''{}''::jsonb');
-- Production. get_user_notifications reads hide_notifications instead.
CALL pg_temp.cc_drop_column('user_mutes', 'mute_type', 'mute_type IS DISTINCT FROM ''posts_and_boosts''');
CALL pg_temp.cc_not_null('user_mutes', 'created_at');

-- trigger_queue_thread_federation sets federation_status on every insert.
CALL pg_temp.cc_default('threads', 'federation_status', '''pending''::text');
CALL pg_temp.cc_nullable('threads', 'created_by');

CALL pg_temp.cc_default('admin_audit_log', 'action_details', '''{}''::jsonb');
CALL pg_temp.cc_not_null('admin_audit_log', 'created_at');
CALL pg_temp.cc_default('bot_rate_limits', 'resets_at', '(now() + ''00:01:00''::interval)');
CALL pg_temp.cc_nullable('bot_server_permissions', 'installed_at');
-- issue_bot_token writes scopes.
CALL pg_temp.cc_default('bot_tokens', 'scopes', '''{}''::text[]');
CALL pg_temp.cc_nullable('bot_tokens', 'created_at');
CALL pg_temp.cc_nullable('channel_permission_overrides', 'updated_at');
CALL pg_temp.cc_not_null('encryption_audit_log', 'user_id');
CALL pg_temp.cc_nullable('gif_favorites', 'preview_url');
CALL pg_temp.cc_default('message_search_index', 'created_at', 'now()');
CALL pg_temp.cc_nullable('message_search_index', 'created_at');
CALL pg_temp.cc_nullable('message_search_index', 'content_text');
CALL pg_temp.cc_not_null('messages', 'content');
CALL pg_temp.cc_default('performance_metrics', 'source', NULL);
CALL pg_temp.cc_default('performance_metrics', 'unit', NULL);
CALL pg_temp.cc_not_null('post_interactions', 'created_at');
CALL pg_temp.cc_not_null('posts', 'created_at');
-- add_user_prekeys writes device_id and is_one_time.
CALL pg_temp.cc_default('prekeys', 'device_id', NULL);
CALL pg_temp.cc_not_null('prekeys', 'device_id');
CALL pg_temp.cc_default('prekeys', 'is_one_time', 'true');
CALL pg_temp.cc_nullable('prekeys', 'created_at');
CALL pg_temp.cc_default('reactions', 'metadata', '''{}''::jsonb');
CALL pg_temp.cc_not_null('reactions', 'created_at');
CALL pg_temp.cc_nullable('server_bans', 'banned_by');
CALL pg_temp.cc_nullable('server_membership_events', 'created_at');
CALL pg_temp.cc_nullable('server_membership_events', 'user_id');
CALL pg_temp.cc_nullable('server_settings', 'created_at');
CALL pg_temp.cc_nullable('server_settings', 'updated_at');
CALL pg_temp.cc_nullable('user_roles', 'assigned_at');

CALL pg_temp.cc_drop_column('timeline_entries', 'metadata', 'metadata IS DISTINCT FROM ''{}''::jsonb');
CALL pg_temp.cc_nullable('timeline_entries', 'timeline_type');
CALL pg_temp.cc_default('timeline_entries', 'timeline_type', '''home''::text');
CALL pg_temp.cc_not_null('timeline_entries', 'position');

-- ---------------------------------------------------------------------------
-- CHECK, UNIQUE and PRIMARY KEY constraints
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT * FROM (VALUES
        ('ap_object_cache', 'ap_object_cache_object_url_key',
         $d$UNIQUE (object_url)$d$),
        ('blocked_instances', 'blocked_instances_severity_check',
         $d$CHECK ((severity = ANY (ARRAY['silence'::text, 'suspend'::text])))$d$),
        ('bot_commands', 'bot_commands_type_check',
         $d$CHECK ((command_type = ANY (ARRAY['prefix'::text, 'slash'::text, 'context_menu'::text])))$d$),
        ('bot_presence', 'bot_presence_bot_id_key',
         $d$UNIQUE (bot_id)$d$),
        ('bot_presence', 'bot_presence_pkey',
         $d$PRIMARY KEY (id)$d$),
        ('bot_webhooks', 'bot_webhooks_bot_id_channel_id_name_key',
         $d$UNIQUE (bot_id, channel_id, name)$d$),
        ('channel_permission_overrides', 'channel_permission_overrides_channel_id_role_id_user_id_key',
         $d$UNIQUE (channel_id, role_id, user_id)$d$),
        ('channel_permission_overrides', 'channel_permission_overrides_target_check',
         $d$CHECK ((((target_type = 'role'::text) AND (role_id IS NOT NULL) AND (user_id IS NULL)) OR ((target_type = 'user'::text) AND (user_id IS NOT NULL) AND (role_id IS NULL))))$d$),
        ('channel_permission_overrides', 'channel_permission_overrides_type_check',
         $d$CHECK ((target_type = ANY (ARRAY['role'::text, 'user'::text])))$d$),
        ('conversation_encryption_settings', 'conversation_encryption_visibility_check',
         $d$CHECK ((history_visibility = ANY (ARRAY['shared'::text, 'invited'::text, 'joined'::text])))$d$),
        ('conversation_participants', 'conversation_participants_conversation_id_user_id_key',
         $d$UNIQUE (conversation_id, user_id)$d$),
        ('federation_health', 'federation_health_instance_domain_key',
         $d$UNIQUE (instance_domain)$d$),
        ('follows', 'follows_follower_id_following_id_key',
         $d$UNIQUE (follower_id, following_id)$d$),
        ('gif_favorites', 'gif_favorites_user_id_gif_url_key',
         $d$UNIQUE (user_id, gif_url)$d$),
        ('instance_webrtc_settings', 'instance_webrtc_settings_mode_check',
         $d$CHECK ((webrtc_mode = ANY (ARRAY['sfu'::text, 'p2p'::text, 'hybrid'::text])))$d$),
        ('invites', 'invites_code_format_check',
         $d$CHECK ((code ~ '^[A-Za-z0-9_-]{1,64}$'::text))$d$),
        ('invites', 'invites_code_key',
         $d$UNIQUE (code)$d$),
        ('megolm_session_shares', 'megolm_session_shares_room_id_session_id_recipient_user_id_key',
         $d$UNIQUE (room_id, session_id, recipient_user_id)$d$),
        ('messages', 'messages_user_or_bot_check',
         $d$CHECK (((user_id IS NULL) OR (bot_id IS NULL)))$d$),
        ('performance_metrics_hourly', 'performance_metrics_hourly_hour_metric_type_metric_name_sou_key',
         $d$UNIQUE (hour, metric_type, metric_name, source)$d$),
        ('post_hashtags', 'post_hashtags_pkey',
         $d$PRIMARY KEY (post_id, hashtag_id)$d$),
        ('post_interactions', 'post_interactions_type_check',
         $d$CHECK ((interaction_type = ANY (ARRAY['favorite'::text, 'reblog'::text, 'emoji_reaction'::text, 'bookmark'::text])))$d$),
        ('posts', 'posts_federation_status_check',
         $d$CHECK ((federation_status = ANY (ARRAY['pending'::text, 'queued'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'skipped'::text])))$d$),
        ('reactions', 'reactions_has_author',
         $d$CHECK (((user_id IS NOT NULL) OR (bot_id IS NOT NULL)))$d$),
        ('reactions', 'reactions_has_emoji',
         $d$CHECK (((emoji_id IS NOT NULL) OR (custom_emoji_content IS NOT NULL)))$d$),
        ('server_settings', 'server_settings_server_id_key',
         $d$UNIQUE (server_id)$d$),
        ('servers', 'servers_invite_code_key',
         $d$UNIQUE (invite_code)$d$),
        ('thread_members', 'thread_members_thread_id_user_id_key',
         $d$UNIQUE (thread_id, user_id)$d$),
        ('timeline_entries', 'timeline_entries_user_id_post_id_timeline_type_key',
         $d$UNIQUE (user_id, post_id, timeline_type)$d$),
        ('trending_posts', 'trending_posts_period_type_check',
         $d$CHECK ((period_type = ANY (ARRAY['hourly'::text, 'daily'::text, 'weekly'::text])))$d$),
        ('trending_refresh_queue', 'trending_refresh_queue_pkey',
         $d$PRIMARY KEY (refresh_type)$d$),
        ('trending_refresh_queue', 'trending_refresh_queue_priority_check',
         $d$CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text])))$d$),
        ('trending_users', 'trending_users_period_type_check',
         $d$CHECK ((period_type = ANY (ARRAY['hourly'::text, 'daily'::text, 'weekly'::text])))$d$),
        ('user_blocks', 'user_blocks_no_self_block',
         $d$CHECK ((blocker_id <> blocked_user_id))$d$),
        ('user_roles', 'user_roles_user_id_role_id_key',
         $d$UNIQUE (user_id, role_id)$d$),
        ('user_servers', 'user_servers_nickname_length_check',
         $d$CHECK (((nickname IS NULL) OR (char_length(nickname) <= 64)))$d$),
        ('user_servers', 'user_servers_status_check',
         $d$CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'banned'::text])))$d$),
        ('user_servers', 'user_servers_user_id_server_id_key',
         $d$UNIQUE (user_id, server_id)$d$),
        ('user_sessions', 'user_sessions_user_id_session_token_key',
         $d$UNIQUE (user_id, session_token)$d$),
        ('user_view_contexts', 'user_view_contexts_user_id_key',
         $d$UNIQUE (user_id)$d$),
        ('user_view_contexts', 'user_view_contexts_pkey',
         $d$PRIMARY KEY (id)$d$)
        ) AS t(tbl, name, def)
    LOOP
        CALL pg_temp.cc_constraint(r.tbl, r.name, r.def);
    END LOOP;
END;
$$;

CALL pg_temp.cc_drop_column('post_hashtags', 'id', NULL);

-- Leftovers the repository's constraints replace or restate. Each goes only once the
-- constraint of the given definition is in place.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT * FROM (VALUES
            -- Admits join, leave, kick and ban; unban_server_member writes 'unban'.
            ('server_membership_events', 'server_membership_events_event_type_check', NULL),
            ('post_interactions', 'post_interactions_interaction_type_check',
             $d$CHECK ((interaction_type = ANY (ARRAY['favorite'::text, 'reblog'::text, 'emoji_reaction'::text, 'bookmark'::text])))$d$),
            ('post_hashtags', 'post_hashtags_post_id_hashtag_id_key', $d$PRIMARY KEY (post_id, hashtag_id)$d$),
            ('megolm_session_shares', 'megolm_session_shares_session_id_room_id_recipient_user_id__key',
             $d$UNIQUE (room_id, session_id, recipient_user_id)$d$)
        ) AS t(tbl, name, replaced_by)
    LOOP
        CONTINUE WHEN NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_constraint
             WHERE conrelid = ('public.' || quote_ident(r.tbl))::regclass AND conname = r.name);
        CONTINUE WHEN r.replaced_by IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_constraint
             WHERE conrelid = ('public.' || quote_ident(r.tbl))::regclass AND conname <> r.name AND convalidated
               AND pg_catalog.pg_get_constraintdef(oid) = r.replaced_by);
        EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', r.tbl, r.name);
        RAISE NOTICE '%.%: dropped', r.tbl, r.name;
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT * FROM (VALUES
        ($d$CREATE INDEX idx_activity_processing_logs_activity ON public.activity_processing_logs USING btree (activity_id)$d$),
        ($d$CREATE INDEX idx_activity_processing_logs_status ON public.activity_processing_logs USING btree (status)$d$),
        ($d$CREATE INDEX idx_admin_audit_log_admin ON public.admin_audit_log USING btree (admin_id)$d$),
        ($d$CREATE INDEX idx_admin_audit_log_created ON public.admin_audit_log USING btree (created_at DESC)$d$),
        ($d$CREATE INDEX idx_ap_activities_actor ON public.ap_activities USING btree (actor_ap_id)$d$),
        ($d$CREATE UNIQUE INDEX idx_ap_activities_ap_id ON public.ap_activities USING btree (ap_id)$d$),
        ($d$CREATE INDEX idx_ap_activities_created ON public.ap_activities USING btree (created_at DESC)$d$),
        ($d$CREATE INDEX idx_ap_actor_cache_ap_id ON public.ap_actor_cache USING btree (ap_id)$d$),
        ($d$CREATE INDEX idx_ap_object_cache_url ON public.ap_object_cache USING btree (object_url)$d$),
        ($d$CREATE INDEX idx_blocked_instances_created_by ON public.blocked_instances USING btree (created_by)$d$),
        ($d$CREATE INDEX idx_blocked_instances_domain ON public.blocked_instances USING btree (domain)$d$),
        ($d$CREATE INDEX idx_bot_audit_log_bot ON public.bot_audit_log USING btree (bot_id)$d$),
        ($d$CREATE INDEX idx_bot_audit_log_created ON public.bot_audit_log USING btree (created_at DESC)$d$),
        ($d$CREATE INDEX idx_bot_audit_log_server ON public.bot_audit_log USING btree (server_id)$d$),
        ($d$CREATE INDEX idx_bot_commands_bot ON public.bot_commands USING btree (bot_id)$d$),
        ($d$CREATE INDEX idx_bot_commands_name ON public.bot_commands USING btree (name)$d$),
        ($d$CREATE INDEX idx_bot_presence_status ON public.bot_presence USING btree (status)$d$),
        ($d$CREATE INDEX idx_bot_rate_limits_bot ON public.bot_rate_limits USING btree (bot_id)$d$),
        ($d$CREATE INDEX idx_bot_server_permissions_bot ON public.bot_server_permissions USING btree (bot_id)$d$),
        ($d$CREATE INDEX idx_bot_server_permissions_server ON public.bot_server_permissions USING btree (server_id)$d$),
        ($d$CREATE INDEX idx_bot_tokens_bot ON public.bot_tokens USING btree (bot_id)$d$),
        ($d$CREATE INDEX idx_bot_webhooks_bot ON public.bot_webhooks USING btree (bot_id)$d$),
        ($d$CREATE INDEX idx_bot_webhooks_channel ON public.bot_webhooks USING btree (channel_id)$d$),
        ($d$CREATE INDEX idx_bot_webhooks_server_id ON public.bot_webhooks USING btree (server_id)$d$),
        ($d$CREATE INDEX idx_bots_owner ON public.bots USING btree (owner_id)$d$),
        ($d$CREATE INDEX idx_bots_public ON public.bots USING btree (is_public) WHERE (is_public = true)$d$),
        ($d$CREATE INDEX idx_channel_categories_server ON public.channel_categories USING btree (server_id)$d$),
        ($d$CREATE UNIQUE INDEX idx_channels_ap_id ON public.channels USING btree (ap_id)$d$),
        ($d$CREATE INDEX idx_channels_category ON public.channels USING btree (category)$d$),
        ($d$CREATE INDEX idx_channels_server ON public.channels USING btree (server_id)$d$),
        ($d$CREATE INDEX idx_conversation_encryption_conv ON public.conversation_encryption_settings USING btree (conversation_id)$d$),
        ($d$CREATE INDEX idx_conversation_participants_conversation ON public.conversation_participants USING btree (conversation_id)$d$),
        ($d$CREATE INDEX idx_conversation_participants_user ON public.conversation_participants USING btree (user_id)$d$),
        ($d$CREATE INDEX idx_emoji_usage_emoji ON public.emoji_usage USING btree (emoji_id)$d$),
        ($d$CREATE INDEX idx_emoji_usage_server ON public.emoji_usage USING btree (server_id)$d$),
        ($d$CREATE INDEX idx_emoji_usage_user ON public.emoji_usage USING btree (user_id)$d$),
        ($d$CREATE INDEX idx_emojis_name ON public.emojis USING btree (lower((name)::text))$d$),
        ($d$CREATE INDEX idx_encryption_audit_created ON public.encryption_audit_log USING btree (created_at DESC)$d$),
        ($d$CREATE INDEX idx_encryption_audit_type ON public.encryption_audit_log USING btree (event_type)$d$),
        ($d$CREATE INDEX idx_encryption_audit_user ON public.encryption_audit_log USING btree (user_id)$d$),
        ($d$CREATE INDEX idx_federation_delivery_queue_status ON public.federation_delivery_queue USING btree (status)$d$),
        ($d$CREATE INDEX idx_federation_endpoint_health_dead ON public.federation_endpoint_health USING btree (is_dead) WHERE (is_dead = true)$d$),
        ($d$CREATE INDEX idx_federation_endpoint_health_url ON public.federation_endpoint_health USING btree (endpoint_url)$d$),
        ($d$CREATE INDEX idx_files_owner ON public.files USING btree (owner_id)$d$),
        ($d$CREATE INDEX idx_gif_favorites_user ON public.gif_favorites USING btree (user_id)$d$),
        ($d$CREATE INDEX idx_hashtags_normalized ON public.hashtags USING btree (normalized_tag)$d$),
        ($d$CREATE INDEX idx_hashtags_tag ON public.hashtags USING btree (tag)$d$),
        ($d$CREATE INDEX idx_hashtags_trending ON public.hashtags USING btree (trending_score DESC)$d$),
        ($d$CREATE INDEX idx_invites_code ON public.invites USING btree (code)$d$),
        ($d$CREATE INDEX idx_megolm_key_backups_user ON public.megolm_key_backups USING btree (user_id)$d$),
        ($d$CREATE INDEX idx_megolm_session_shares_recipient ON public.megolm_session_shares USING btree (recipient_user_id, recipient_device_id)$d$),
        ($d$CREATE INDEX idx_megolm_session_shares_session ON public.megolm_session_shares USING btree (session_id, room_id)$d$),
        ($d$CREATE INDEX idx_message_search_channel ON public.message_search_index USING btree (channel_id)$d$),
        ($d$CREATE INDEX idx_message_search_conversation ON public.message_search_index USING btree (conversation_id)$d$),
        ($d$CREATE INDEX idx_messages_channel ON public.messages USING btree (channel_id)$d$),
        ($d$CREATE INDEX idx_messages_conversation ON public.messages USING btree (conversation_id)$d$),
        ($d$CREATE INDEX idx_messages_created ON public.messages USING btree (created_at DESC)$d$),
        ($d$CREATE INDEX idx_messages_thread ON public.messages USING btree (thread_id) WHERE (thread_id IS NOT NULL)$d$),
        ($d$CREATE INDEX idx_messages_user ON public.messages USING btree (user_id)$d$),
        ($d$CREATE INDEX idx_mfa_recovery_codes_available ON public.mfa_recovery_codes USING btree (user_id, is_used) WHERE (is_used = false)$d$),
        ($d$CREATE INDEX idx_mfa_recovery_codes_user ON public.mfa_recovery_codes USING btree (user_id)$d$),
        ($d$CREATE INDEX idx_notification_channels_user ON public.notification_channels USING btree (user_id)$d$),
        ($d$CREATE INDEX idx_notification_rate_limits_user ON public.notification_rate_limits USING btree (user_id)$d$),
        ($d$CREATE INDEX idx_notifications_created ON public.notifications USING btree (created_at DESC)$d$),
        ($d$CREATE INDEX idx_notifications_user ON public.notifications USING btree (user_id)$d$),
        ($d$CREATE INDEX idx_performance_metrics_timestamp ON public.performance_metrics USING btree ("timestamp" DESC)$d$),
        ($d$CREATE INDEX idx_performance_metrics_type ON public.performance_metrics USING btree (metric_type, metric_name)$d$),
        ($d$CREATE INDEX idx_perf_metrics_hourly_hour ON public.performance_metrics_hourly USING btree (hour DESC)$d$),
        ($d$CREATE INDEX idx_perf_metrics_hourly_type ON public.performance_metrics_hourly USING btree (metric_type, metric_name)$d$),
        ($d$CREATE INDEX idx_post_hashtags_created ON public.post_hashtags USING btree (created_at DESC)$d$),
        ($d$CREATE INDEX idx_post_hashtags_hashtag ON public.post_hashtags USING btree (hashtag_id)$d$),
        ($d$CREATE UNIQUE INDEX idx_post_interactions_emoji_unique ON public.post_interactions USING btree (user_id, post_id, emoji_id, custom_emoji_content) NULLS NOT DISTINCT WHERE (interaction_type = 'emoji_reaction'::text)$d$),
        ($d$CREATE UNIQUE INDEX idx_post_interactions_unique ON public.post_interactions USING btree (user_id, post_id, interaction_type) WHERE (interaction_type <> 'emoji_reaction'::text)$d$),
        ($d$CREATE INDEX idx_posts_conversation_root ON public.posts USING btree (conversation_root_id) WHERE (conversation_root_id IS NOT NULL)$d$),
        ($d$CREATE INDEX idx_posts_not_deleted ON public.posts USING btree (created_at DESC) WHERE (is_deleted = false)$d$),
        ($d$CREATE INDEX idx_prekeys_available ON public.prekeys USING btree (user_id, device_id) WHERE (used_at IS NULL)$d$),
        ($d$CREATE INDEX idx_profiles_is_local ON public.profiles USING btree (is_local)$d$),
        ($d$CREATE INDEX idx_profiles_username ON public.profiles USING btree (username)$d$),
        ($d$CREATE INDEX idx_push_subscriptions_user ON public.push_subscriptions USING btree (user_id)$d$),
        ($d$CREATE INDEX idx_recovery_key_metadata_user ON public.recovery_key_metadata USING btree (user_id)$d$),
        ($d$CREATE INDEX idx_remote_emojis_cache_domain ON public.remote_emojis_cache USING btree (origin_domain)$d$),
        ($d$CREATE INDEX idx_remote_emojis_cache_usage ON public.remote_emojis_cache USING btree (usage_count DESC)$d$),
        ($d$CREATE INDEX idx_server_encryption_server ON public.server_encryption_settings USING btree (server_id)$d$),
        ($d$CREATE INDEX idx_server_federation_events_server ON public.server_federation_events USING btree (server_id)$d$),
        ($d$CREATE INDEX idx_server_folders_user ON public.server_folders USING btree (user_id)$d$),
        ($d$CREATE INDEX idx_server_membership_events_server ON public.server_membership_events USING btree (server_id)$d$),
        ($d$CREATE UNIQUE INDEX idx_server_roles_ap_id ON public.server_roles USING btree (ap_id)$d$),
        ($d$CREATE INDEX idx_server_roles_server ON public.server_roles USING btree (server_id)$d$),
        ($d$CREATE INDEX idx_server_settings_server ON public.server_settings USING btree (server_id)$d$),
        ($d$CREATE INDEX idx_servers_invite_code ON public.servers USING btree (invite_code) WHERE (invite_code IS NOT NULL)$d$),
        ($d$CREATE INDEX idx_slow_queries_table ON public.slow_queries USING btree (table_name)$d$),
        ($d$CREATE INDEX idx_thread_members_thread ON public.thread_members USING btree (thread_id)$d$),
        ($d$CREATE INDEX idx_thread_members_user ON public.thread_members USING btree (user_id)$d$),
        ($d$CREATE UNIQUE INDEX idx_threads_ap_id ON public.threads USING btree (ap_id) WHERE (ap_id IS NOT NULL)$d$),
        ($d$CREATE INDEX idx_threads_channel ON public.threads USING btree (channel_id)$d$),
        ($d$CREATE INDEX idx_timeline_entries_user_type ON public.timeline_entries USING btree (user_id, timeline_type)$d$),
        ($d$CREATE INDEX idx_trending_posts_period ON public.trending_posts USING btree (period_type, period_start)$d$),
        ($d$CREATE INDEX idx_trending_posts_post_id ON public.trending_posts USING btree (post_id)$d$),
        ($d$CREATE UNIQUE INDEX idx_trending_posts_unique ON public.trending_posts USING btree (post_id, period_type, period_start)$d$),
        ($d$CREATE INDEX idx_trending_users_period ON public.trending_users USING btree (period_type, period_start)$d$),
        ($d$CREATE UNIQUE INDEX idx_trending_users_unique ON public.trending_users USING btree (user_id, period_type, period_start)$d$),
        ($d$CREATE INDEX idx_trending_users_user_id ON public.trending_users USING btree (user_id)$d$),
        ($d$CREATE INDEX idx_unread_counts_conversation ON public.unread_counts USING btree (conversation_id)$d$),
        ($d$CREATE INDEX idx_unread_counts_user ON public.unread_counts USING btree (user_id)$d$),
        ($d$CREATE INDEX idx_user_blocks_blocked ON public.user_blocks USING btree (blocked_user_id)$d$),
        ($d$CREATE INDEX idx_user_blocks_blocker ON public.user_blocks USING btree (blocker_id)$d$),
        ($d$CREATE INDEX idx_user_key_pairs_user ON public.user_key_pairs USING btree (user_id)$d$),
        ($d$CREATE INDEX idx_user_mutes_muter ON public.user_mutes USING btree (muter_id)$d$),
        ($d$CREATE INDEX idx_user_private_keys_user ON public.user_private_keys USING btree (user_id)$d$),
        ($d$CREATE INDEX idx_user_roles_server ON public.user_roles USING btree (server_id)$d$),
        ($d$CREATE INDEX idx_user_roles_user ON public.user_roles USING btree (user_id)$d$),
        ($d$CREATE INDEX idx_user_servers_server ON public.user_servers USING btree (server_id)$d$),
        ($d$CREATE INDEX idx_user_servers_user ON public.user_servers USING btree (user_id)$d$),
        ($d$CREATE INDEX idx_user_sessions_active ON public.user_sessions USING btree (is_active) WHERE (is_active = true)$d$),
        ($d$CREATE INDEX idx_user_timeline_cache_user ON public.user_timeline_cache USING btree (user_id)$d$),
        ($d$CREATE UNIQUE INDEX idx_user_timeline_cache_user_type ON public.user_timeline_cache USING btree (user_id, timeline_type)$d$),
        ($d$CREATE INDEX idx_user_view_contexts_channel ON public.user_view_contexts USING btree (channel_id) WHERE (channel_id IS NOT NULL)$d$),
        ($d$CREATE INDEX idx_user_view_contexts_user ON public.user_view_contexts USING btree (user_id)$d$),
        ($d$CREATE INDEX idx_voice_participants_channel ON public.voice_channel_participants USING btree (channel_id)$d$),
        ($d$CREATE INDEX idx_voice_participants_user ON public.voice_channel_participants USING btree (user_id)$d$),
        ($d$CREATE INDEX idx_voice_federation_events_channel ON public.voice_federation_events USING btree (channel_id)$d$)
        ) AS t(ddl)
    LOOP
        CALL pg_temp.cc_index(r.ddl);
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Triggers gated on columns added above
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_def text;
    v_want constant text :=
        'CREATE TRIGGER sanitize_member_nickname_trigger BEFORE INSERT OR UPDATE ON public.user_servers '
        'FOR EACH ROW EXECUTE FUNCTION sanitize_member_nickname()';
BEGIN
    SELECT pg_catalog.pg_get_triggerdef(t.oid) INTO v_def
      FROM pg_catalog.pg_trigger t
     WHERE t.tgrelid = 'public.user_servers'::regclass AND t.tgname = 'sanitize_member_nickname_trigger';
    IF v_def = v_want THEN
        RETURN;
    END IF;
    IF to_regprocedure('public.sanitize_member_nickname()') IS NULL THEN
        RAISE NOTICE 'sanitize_member_nickname_trigger: no function public.sanitize_member_nickname(), skipped';
        RETURN;
    END IF;
    DROP TRIGGER IF EXISTS sanitize_member_nickname_trigger ON public.user_servers;
    CREATE TRIGGER sanitize_member_nickname_trigger BEFORE INSERT OR UPDATE ON public.user_servers
        FOR EACH ROW EXECUTE FUNCTION public.sanitize_member_nickname();
    RAISE NOTICE 'sanitize_member_nickname_trigger: %', CASE WHEN v_def IS NULL THEN 'created' ELSE 'replaced' END;
END;
$$;

-- ---------------------------------------------------------------------------
-- Foreign keys. Last: replacing one locks the referenced table until COMMIT.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    r record;
BEGIN
    -- Duplicates of conversation_participants_conversation_id_fkey and _user_id_fkey.
    FOR r IN
        SELECT k.conname
          FROM pg_catalog.pg_constraint k
         WHERE k.conrelid = 'public.conversation_participants'::regclass
           AND k.conname IN ('conversation_participants_conversation_fkey', 'conversation_participants_user_fkey')
           AND EXISTS (SELECT 1 FROM pg_catalog.pg_constraint d
                        WHERE d.conrelid = k.conrelid AND d.oid <> k.oid AND d.contype = 'f'
                          AND pg_catalog.pg_get_constraintdef(d.oid) = pg_catalog.pg_get_constraintdef(k.oid))
    LOOP
        EXECUTE format('ALTER TABLE public.conversation_participants DROP CONSTRAINT %I', r.conname);
        RAISE NOTICE 'conversation_participants.%: dropped, duplicates another', r.conname;
    END LOOP;

    FOR r IN
        SELECT * FROM (VALUES
        ('blocked_instances', 'blocked_instances_created_by_fkey',
         $d$FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL$d$),
        ('bot_webhooks', 'bot_webhooks_channel_id_fkey',
         $d$FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE SET NULL$d$),
        ('bot_webhooks', 'bot_webhooks_server_id_fkey',
         $d$FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE$d$),
        ('channels', 'channels_category_fkey',
         $d$FOREIGN KEY (category) REFERENCES channel_categories(id) ON DELETE SET NULL$d$),
        ('emoji_usage', 'emoji_usage_user_id_fkey',
         $d$FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE$d$),
        ('encryption_audit_log', 'encryption_audit_log_user_id_fkey',
         $d$FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE$d$),
        ('federation_delivery_queue', 'federation_delivery_queue_sender_id_fkey',
         $d$FOREIGN KEY (sender_id) REFERENCES profiles(id) ON DELETE CASCADE$d$),
        ('files', 'files_owner_id_fkey',
         $d$FOREIGN KEY (owner_id) REFERENCES profiles(id) ON DELETE CASCADE$d$),
        ('message_search_index', 'message_search_index_server_id_fkey',
         $d$FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE$d$),
        ('messages', 'messages_conversation_id_fkey',
         $d$FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE$d$),
        ('messages', 'messages_reply_to_fkey',
         $d$FOREIGN KEY (reply_to) REFERENCES messages(id) ON DELETE SET NULL$d$),
        ('messages', 'messages_thread_id_fkey',
         $d$FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE SET NULL$d$),
        ('mfa_recovery_codes', 'mfa_recovery_codes_user_id_fkey',
         $d$FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE$d$),
        ('reports', 'reports_reporter_id_fkey',
         $d$FOREIGN KEY (reporter_id) REFERENCES profiles(id) ON DELETE SET NULL$d$),
        ('server_federation_events', 'server_federation_events_server_id_fkey',
         $d$FOREIGN KEY (server_id) REFERENCES servers(id) ON DELETE CASCADE$d$),
        ('server_membership_events', 'server_membership_events_user_id_fkey',
         $d$FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE SET NULL$d$),
        ('server_settings', 'server_settings_default_role_id_fkey',
         $d$FOREIGN KEY (default_role_id) REFERENCES server_roles(id) ON DELETE SET NULL$d$),
        ('servers', 'servers_owner_fkey',
         $d$FOREIGN KEY (owner) REFERENCES profiles(id) ON DELETE SET NULL$d$),
        ('threads', 'threads_created_by_fkey',
         $d$FOREIGN KEY (created_by) REFERENCES profiles(id) ON DELETE SET NULL$d$),
        ('user_timeline_cache', 'user_timeline_cache_user_id_fkey',
         $d$FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE$d$),
        ('voice_federation_events', 'voice_federation_events_channel_id_fkey',
         $d$FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE$d$)
        ) AS t(tbl, name, def)
    LOOP
        CALL pg_temp.cc_constraint(r.tbl, r.name, r.def);
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
