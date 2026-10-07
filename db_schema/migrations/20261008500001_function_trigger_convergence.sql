-- Public functions and triggers of a fresh install, on every instance.
--
-- Staging was built from init/, which never had the trigger functions production carried by
-- hand; the baseline mirrors them from production and is not replayed on live instances.
-- Staging lacks these functions and their triggers:
--
--   update_bot_timestamp                 bots, bot_webhooks                  updated_at
--   update_encryption_timestamp          conversation_encryption_settings,   updated_at
--                                        server_encryption_settings
--   update_megolm_backup_timestamp       megolm_key_backups                  last_updated
--   update_server_folders_updated_at     server_folders                      updated_at
--   update_threads_updated_at            threads                             updated_at
--   update_status_timestamp              profiles, custom_status changes     last_status_update
--   sync_avg_latency                     performance_metrics_hourly          avg_latency := avg
--   sync_recorded_at                     slow_queries                        recorded_at := timestamp
--   log_key_generation                   user_key_pairs inserts              encryption_audit_log row
--   remove_message_from_index            messages deletes                    message_search_index row
--
-- and has these functions without their triggers:
--
--   update_roles_updated_at              server_roles, server_settings       updated_at
--   prevent_protected_role_modification  server_roles                        refuses demoting or
--                                                                            renaming the admin and
--                                                                            @everyone roles
--
-- The admin performance page filters slow_queries on recorded_at and charts avg_latency;
-- record_slow_query and aggregate_hourly_metrics write neither, so without the sync triggers
-- both stay NULL. Existing rows are synced below. message_search_index.message_id cascades on
-- delete, so staging holds no index rows of deleted messages.
--
-- Production lacks promote_first_user_to_admin and its trigger, which make the first local
-- profile the instance admin and do nothing once one exists. Its user_servers has no nickname
-- column, so sanitize_member_nickname_trigger stays absent there, as in 20260530000004.
--
-- Dropped from the repository. Production lacks all of them and carries end_user_session(text)
-- instead; service_role alone executes them and nothing calls them.
--
--   get_livekit_config         superseded by federation-backend's LiveKit routes; reads
--                              instance_webrtc_settings columns production lacks
--   update_session_heartbeat,  raise for any caller without auth.uid(), service_role included;
--   update_session_context,    write user_sessions, which nothing reads since 20261003200001
--   end_user_session
--
-- Overloads the repository does not define, dropped:
--
--   update_federation_health(text, boolean, double precision, text)   production; beside the
--       numeric form PostgREST answers every named call with PGRST203, so no delivery
--       outcome from federation-backend reaches federation_health
--   initialize_user_encryption(uuid, text, text, text, text)          staging; no caller
--
-- Differ in definition only: trigger_role_mention_notifications on both hosts adds
-- `new.is_deleted = false` (no path inserts a deleted message); production's
-- trigger_increment_unread_mentions casts its literals through varchar. Both take the
-- repository's definition.

BEGIN;

SET LOCAL lock_timeout = '3s';

DROP FUNCTION IF EXISTS public.get_livekit_config();
DROP FUNCTION IF EXISTS public.update_session_heartbeat(text, text);
DROP FUNCTION IF EXISTS public.update_session_context(text, uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.end_user_session(uuid, text);
DROP FUNCTION IF EXISTS public.end_user_session(text);
DROP FUNCTION IF EXISTS public.update_federation_health(text, boolean, double precision, text);
DROP FUNCTION IF EXISTS public.initialize_user_encryption(uuid, text, text, text, text);

-- ---------------------------------------------------------------------------
-- Trigger functions, as the baseline defines them.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.promote_first_user_to_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    IF NEW.is_local = true OR NEW.is_local IS NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.profiles
            WHERE is_local = true AND id != NEW.id
        ) THEN
            NEW.is_admin := true;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.promote_first_user_to_admin() IS
    'Sets is_admin=true on the first local profile created on the instance.';

CREATE OR REPLACE FUNCTION public.update_bot_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_encryption_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_megolm_backup_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
    NEW.last_updated = NOW();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_server_folders_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_status_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
    IF OLD.custom_status IS DISTINCT FROM NEW.custom_status THEN
        NEW.last_status_update = NOW();
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_threads_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_avg_latency() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
    NEW.avg_latency := NEW.avg;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sync_recorded_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
    NEW.recorded_at := NEW.timestamp;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.log_key_generation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
    INSERT INTO public.encryption_audit_log (
        user_id,
        event_type,
        severity,
        description,
        metadata
    ) VALUES (
        NEW.user_id,
        'key_generated',
        'info',
        'New identity key pair generated',
        jsonb_build_object(
            'device_id', NEW.device_id,
            'key_version', NEW.key_version
        )
    );

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_message_from_index() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions', 'pg_temp'
    AS $$
BEGIN
  DELETE FROM message_search_index WHERE message_id = OLD.id;
  RETURN OLD;
END;
$$;

-- A fresh install leaves these at PUBLIC's default EXECUTE plus Supabase's default privileges,
-- so there is nothing to revoke. A direct call raises; firing checks no EXECUTE.
GRANT EXECUTE ON FUNCTION
    public.promote_first_user_to_admin(),
    public.update_bot_timestamp(),
    public.update_encryption_timestamp(),
    public.update_megolm_backup_timestamp(),
    public.update_server_folders_updated_at(),
    public.update_status_timestamp(),
    public.update_threads_updated_at(),
    public.sync_avg_latency(),
    public.sync_recorded_at(),
    public.log_key_generation(),
    public.remove_message_from_index()
TO anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Triggers. Each definition is pg_get_triggerdef() of a fresh install, which executes back to
-- itself; a trigger already matching and enabled is left alone.
-- ---------------------------------------------------------------------------

-- pg_get_triggerdef() qualifies a function only when its schema is off the search_path.
SET LOCAL search_path = pg_catalog, pg_temp;

DO $$
DECLARE
    r record;
    v_rel regclass;
    v_def text;
    v_enabled "char";
BEGIN
    FOR r IN
        SELECT * FROM (VALUES
            ('bot_webhooks', 'update_bot_webhooks_timestamp', NULL,
             $d$CREATE TRIGGER update_bot_webhooks_timestamp BEFORE UPDATE ON public.bot_webhooks FOR EACH ROW EXECUTE FUNCTION public.update_bot_timestamp()$d$),
            ('bots', 'update_bots_timestamp', NULL,
             $d$CREATE TRIGGER update_bots_timestamp BEFORE UPDATE ON public.bots FOR EACH ROW EXECUTE FUNCTION public.update_bot_timestamp()$d$),
            ('conversation_encryption_settings', 'update_conversation_encryption_settings_timestamp', NULL,
             $d$CREATE TRIGGER update_conversation_encryption_settings_timestamp BEFORE UPDATE ON public.conversation_encryption_settings FOR EACH ROW EXECUTE FUNCTION public.update_encryption_timestamp()$d$),
            ('megolm_key_backups', 'update_megolm_backup_timestamp', NULL,
             $d$CREATE TRIGGER update_megolm_backup_timestamp BEFORE UPDATE ON public.megolm_key_backups FOR EACH ROW EXECUTE FUNCTION public.update_megolm_backup_timestamp()$d$),
            ('messages', 'trigger_remove_message_index', NULL,
             $d$CREATE TRIGGER trigger_remove_message_index AFTER DELETE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.remove_message_from_index()$d$),
            ('messages', 'trigger_role_mention_notifications', NULL,
             $d$CREATE TRIGGER trigger_role_mention_notifications AFTER INSERT ON public.messages FOR EACH ROW WHEN (((new.channel_id IS NOT NULL) AND (new.is_system = false))) EXECUTE FUNCTION public.handle_role_mention_notifications()$d$),
            ('notifications', 'trigger_increment_unread_mentions', NULL,
             $d$CREATE TRIGGER trigger_increment_unread_mentions AFTER INSERT ON public.notifications FOR EACH ROW WHEN (((new.type)::text = ANY (ARRAY['mention'::text, 'activitypub_mention'::text]))) EXECUTE FUNCTION public.increment_unread_mentions()$d$),
            ('performance_metrics_hourly', 'trigger_sync_avg_latency', NULL,
             $d$CREATE TRIGGER trigger_sync_avg_latency BEFORE INSERT OR UPDATE ON public.performance_metrics_hourly FOR EACH ROW EXECUTE FUNCTION public.sync_avg_latency()$d$),
            ('profiles', 'promote_first_user_to_admin_trigger', NULL,
             $d$CREATE TRIGGER promote_first_user_to_admin_trigger BEFORE INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.promote_first_user_to_admin()$d$),
            ('profiles', 'trigger_status_update_timestamp', NULL,
             $d$CREATE TRIGGER trigger_status_update_timestamp BEFORE UPDATE OF custom_status ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_status_timestamp()$d$),
            ('server_encryption_settings', 'update_server_encryption_settings_timestamp', NULL,
             $d$CREATE TRIGGER update_server_encryption_settings_timestamp BEFORE UPDATE ON public.server_encryption_settings FOR EACH ROW EXECUTE FUNCTION public.update_encryption_timestamp()$d$),
            ('server_folders', 'trigger_server_folders_updated_at', NULL,
             $d$CREATE TRIGGER trigger_server_folders_updated_at BEFORE UPDATE ON public.server_folders FOR EACH ROW EXECUTE FUNCTION public.update_server_folders_updated_at()$d$),
            ('server_roles', 'trigger_prevent_protected_role_modification', NULL,
             $d$CREATE TRIGGER trigger_prevent_protected_role_modification BEFORE UPDATE ON public.server_roles FOR EACH ROW EXECUTE FUNCTION public.prevent_protected_role_modification()$d$),
            ('server_roles', 'trigger_server_roles_updated_at', NULL,
             $d$CREATE TRIGGER trigger_server_roles_updated_at BEFORE UPDATE ON public.server_roles FOR EACH ROW EXECUTE FUNCTION public.update_roles_updated_at()$d$),
            ('server_settings', 'trigger_server_settings_updated_at', NULL,
             $d$CREATE TRIGGER trigger_server_settings_updated_at BEFORE UPDATE ON public.server_settings FOR EACH ROW EXECUTE FUNCTION public.update_roles_updated_at()$d$),
            ('slow_queries', 'trigger_sync_recorded_at', NULL,
             $d$CREATE TRIGGER trigger_sync_recorded_at BEFORE INSERT OR UPDATE ON public.slow_queries FOR EACH ROW EXECUTE FUNCTION public.sync_recorded_at()$d$),
            ('threads', 'trigger_threads_updated_at', NULL,
             $d$CREATE TRIGGER trigger_threads_updated_at BEFORE UPDATE ON public.threads FOR EACH ROW EXECUTE FUNCTION public.update_threads_updated_at()$d$),
            ('user_key_pairs', 'audit_key_generation', NULL,
             $d$CREATE TRIGGER audit_key_generation AFTER INSERT ON public.user_key_pairs FOR EACH ROW EXECUTE FUNCTION public.log_key_generation()$d$),
            ('user_servers', 'sanitize_member_nickname_trigger', 'nickname',
             $d$CREATE TRIGGER sanitize_member_nickname_trigger BEFORE INSERT OR UPDATE ON public.user_servers FOR EACH ROW EXECUTE FUNCTION public.sanitize_member_nickname()$d$)
        ) AS t(tbl, name, needs_column, def)
    LOOP
        v_rel := to_regclass('public.' || quote_ident(r.tbl));
        IF v_rel IS NULL THEN
            RAISE NOTICE '%: no table public.%, skipped', r.name, r.tbl;
            CONTINUE;
        END IF;
        IF r.needs_column IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM pg_attribute
             WHERE attrelid = v_rel AND attname = r.needs_column AND attnum > 0 AND NOT attisdropped
        ) THEN
            RAISE NOTICE '%: public.% has no column %, skipped', r.name, r.tbl, r.needs_column;
            CONTINUE;
        END IF;

        v_def := NULL;
        SELECT pg_get_triggerdef(t.oid), t.tgenabled INTO v_def, v_enabled
          FROM pg_trigger t
         WHERE t.tgrelid = v_rel AND t.tgname = r.name AND NOT t.tgisinternal;
        CONTINUE WHEN v_def = r.def AND v_enabled = 'O';

        IF v_def IS NOT NULL THEN
            EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.%I', r.name, r.tbl);
        END IF;
        EXECUTE r.def;
        RAISE NOTICE '%: % on public.%', r.name, CASE WHEN v_def IS NULL THEN 'created' ELSE 'replaced' END, r.tbl;
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Rows written while the sync triggers were absent.
-- ---------------------------------------------------------------------------

UPDATE public.slow_queries SET recorded_at = "timestamp" WHERE recorded_at IS DISTINCT FROM "timestamp";
UPDATE public.performance_metrics_hourly SET avg_latency = avg WHERE avg_latency IS DISTINCT FROM avg;

COMMIT;

NOTIFY pgrst, 'reload schema';
