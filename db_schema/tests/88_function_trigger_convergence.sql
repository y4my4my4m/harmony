-- 20261008500001_function_trigger_convergence.sql: the public functions and triggers of a fresh
-- install. A fresh install already has them; a converged live copy matches.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(12);

SELECT is_empty(
    $q$SELECT p.oid::regprocedure FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('get_livekit_config', 'update_session_heartbeat',
                            'update_session_context', 'end_user_session')$q$,
    'no dead LiveKit config or user_sessions RPC remains');

SELECT is(ARRAY(SELECT p.oid::regprocedure::text FROM pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'update_federation_health'),
          ARRAY['update_federation_health(text,boolean,numeric,text)'],
          'update_federation_health has one overload, so a named PostgREST call resolves');

SELECT is(ARRAY(SELECT p.oid::regprocedure::text FROM pg_proc p
                 WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'initialize_user_encryption'),
          ARRAY['initialize_user_encryption(uuid,text,text,text)'],
          'initialize_user_encryption has the repository signature alone');

SELECT is_empty(
    $q$SELECT e.name FROM (VALUES
            ('promote_first_user_to_admin', true), ('log_key_generation', true),
            ('remove_message_from_index', true), ('update_bot_timestamp', false),
            ('update_encryption_timestamp', false), ('update_megolm_backup_timestamp', false),
            ('update_server_folders_updated_at', false), ('update_status_timestamp', false),
            ('update_threads_updated_at', false), ('sync_avg_latency', false),
            ('sync_recorded_at', false)) AS e(name, definer)
        WHERE NOT EXISTS (
            SELECT 1 FROM pg_proc p
             WHERE p.pronamespace = 'public'::regnamespace AND p.proname = e.name
               AND p.prorettype = 'trigger'::regtype AND p.prosecdef = e.definer
               AND p.proconfig = ARRAY['search_path=public, extensions, pg_temp'])$q$,
    'every converged trigger function exists with its security and search_path');

-- pg_get_triggerdef() qualifies public names only with public off the search_path.
SET LOCAL search_path = tests, pg_catalog;
SELECT is_empty(
    $q$SELECT e.name FROM (VALUES
            ('bot_webhooks', 'update_bot_webhooks_timestamp', NULL, 'CREATE TRIGGER update_bot_webhooks_timestamp BEFORE UPDATE ON public.bot_webhooks FOR EACH ROW EXECUTE FUNCTION public.update_bot_timestamp()'),
            ('bots', 'update_bots_timestamp', NULL, 'CREATE TRIGGER update_bots_timestamp BEFORE UPDATE ON public.bots FOR EACH ROW EXECUTE FUNCTION public.update_bot_timestamp()'),
            ('conversation_encryption_settings', 'update_conversation_encryption_settings_timestamp', NULL, 'CREATE TRIGGER update_conversation_encryption_settings_timestamp BEFORE UPDATE ON public.conversation_encryption_settings FOR EACH ROW EXECUTE FUNCTION public.update_encryption_timestamp()'),
            ('megolm_key_backups', 'update_megolm_backup_timestamp', NULL, 'CREATE TRIGGER update_megolm_backup_timestamp BEFORE UPDATE ON public.megolm_key_backups FOR EACH ROW EXECUTE FUNCTION public.update_megolm_backup_timestamp()'),
            ('messages', 'trigger_remove_message_index', NULL, 'CREATE TRIGGER trigger_remove_message_index AFTER DELETE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.remove_message_from_index()'),
            ('messages', 'trigger_role_mention_notifications', NULL, 'CREATE TRIGGER trigger_role_mention_notifications AFTER INSERT ON public.messages FOR EACH ROW WHEN (((new.channel_id IS NOT NULL) AND (new.is_system = false))) EXECUTE FUNCTION public.handle_role_mention_notifications()'),
            ('notifications', 'trigger_increment_unread_mentions', NULL, 'CREATE TRIGGER trigger_increment_unread_mentions AFTER INSERT ON public.notifications FOR EACH ROW WHEN (((new.type)::text = ANY (ARRAY[''mention''::text, ''activitypub_mention''::text]))) EXECUTE FUNCTION public.increment_unread_mentions()'),
            ('performance_metrics_hourly', 'trigger_sync_avg_latency', NULL, 'CREATE TRIGGER trigger_sync_avg_latency BEFORE INSERT OR UPDATE ON public.performance_metrics_hourly FOR EACH ROW EXECUTE FUNCTION public.sync_avg_latency()'),
            ('profiles', 'promote_first_user_to_admin_trigger', NULL, 'CREATE TRIGGER promote_first_user_to_admin_trigger BEFORE INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.promote_first_user_to_admin()'),
            ('profiles', 'trigger_status_update_timestamp', NULL, 'CREATE TRIGGER trigger_status_update_timestamp BEFORE UPDATE OF custom_status ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_status_timestamp()'),
            ('server_encryption_settings', 'update_server_encryption_settings_timestamp', NULL, 'CREATE TRIGGER update_server_encryption_settings_timestamp BEFORE UPDATE ON public.server_encryption_settings FOR EACH ROW EXECUTE FUNCTION public.update_encryption_timestamp()'),
            ('server_folders', 'trigger_server_folders_updated_at', NULL, 'CREATE TRIGGER trigger_server_folders_updated_at BEFORE UPDATE ON public.server_folders FOR EACH ROW EXECUTE FUNCTION public.update_server_folders_updated_at()'),
            ('server_roles', 'trigger_prevent_protected_role_modification', NULL, 'CREATE TRIGGER trigger_prevent_protected_role_modification BEFORE UPDATE ON public.server_roles FOR EACH ROW EXECUTE FUNCTION public.prevent_protected_role_modification()'),
            ('server_roles', 'trigger_server_roles_updated_at', NULL, 'CREATE TRIGGER trigger_server_roles_updated_at BEFORE UPDATE ON public.server_roles FOR EACH ROW EXECUTE FUNCTION public.update_roles_updated_at()'),
            ('server_settings', 'trigger_server_settings_updated_at', NULL, 'CREATE TRIGGER trigger_server_settings_updated_at BEFORE UPDATE ON public.server_settings FOR EACH ROW EXECUTE FUNCTION public.update_roles_updated_at()'),
            ('slow_queries', 'trigger_sync_recorded_at', NULL, 'CREATE TRIGGER trigger_sync_recorded_at BEFORE INSERT OR UPDATE ON public.slow_queries FOR EACH ROW EXECUTE FUNCTION public.sync_recorded_at()'),
            ('threads', 'trigger_threads_updated_at', NULL, 'CREATE TRIGGER trigger_threads_updated_at BEFORE UPDATE ON public.threads FOR EACH ROW EXECUTE FUNCTION public.update_threads_updated_at()'),
            ('user_key_pairs', 'audit_key_generation', NULL, 'CREATE TRIGGER audit_key_generation AFTER INSERT ON public.user_key_pairs FOR EACH ROW EXECUTE FUNCTION public.log_key_generation()'),
            ('user_servers', 'sanitize_member_nickname_trigger', 'nickname', 'CREATE TRIGGER sanitize_member_nickname_trigger BEFORE INSERT OR UPDATE ON public.user_servers FOR EACH ROW EXECUTE FUNCTION public.sanitize_member_nickname()')
        ) AS e(tbl, name, needs_column, def)
        WHERE (e.needs_column IS NULL
               OR EXISTS (SELECT 1 FROM pg_attribute a
                           WHERE a.attrelid = ('public.' || e.tbl)::regclass
                             AND a.attname = e.needs_column AND NOT a.attisdropped))
          AND NOT EXISTS (
            SELECT 1 FROM pg_trigger t
             WHERE t.tgrelid = ('public.' || e.tbl)::regclass AND t.tgname = e.name
               AND t.tgenabled = 'O' AND pg_get_triggerdef(t.oid) = e.def)$q$,
    'every converged trigger is enabled with the repository definition');
SET LOCAL search_path = tests, public;

-- Fixture order makes alice the first local profile.
SELECT is((SELECT is_admin FROM public.profiles WHERE id = '11111111-0000-0000-0000-000000000001'),
          true, 'the first local profile is the instance admin');

INSERT INTO public.server_folders (id, user_id, name)
VALUES ('f0f0f0f0-0000-0000-0000-000000000088', '11111111-0000-0000-0000-000000000001', 'probe');
UPDATE public.server_folders SET updated_at = '2000-01-01'
 WHERE id = 'f0f0f0f0-0000-0000-0000-000000000088';
SELECT is((SELECT updated_at FROM public.server_folders WHERE id = 'f0f0f0f0-0000-0000-0000-000000000088'),
          now(), 'an update stamps server_folders.updated_at');

UPDATE public.profiles SET custom_status = '{"text": "probe"}'::jsonb, last_status_update = '2000-01-01'
 WHERE id = '11111111-0000-0000-0000-000000000001';
SELECT is((SELECT last_status_update FROM public.profiles WHERE id = '11111111-0000-0000-0000-000000000001'),
          now(), 'a custom status change stamps last_status_update');

INSERT INTO public.slow_queries (id, duration_ms, "timestamp")
VALUES ('f0f0f0f0-0000-0000-0000-000000000188', 1500, '2026-01-02 03:04:05+00');
SELECT is((SELECT recorded_at FROM public.slow_queries WHERE id = 'f0f0f0f0-0000-0000-0000-000000000188'),
          '2026-01-02 03:04:05+00'::timestamptz, 'slow_queries.recorded_at follows timestamp');

INSERT INTO public.performance_metrics_hourly (hour, metric_type, metric_name, avg)
VALUES ('2026-01-02 03:00:00+00', 'probe', 'fn-trigger-convergence', 42.5);
SELECT is((SELECT avg_latency FROM public.performance_metrics_hourly
            WHERE metric_type = 'probe' AND metric_name = 'fn-trigger-convergence'),
          42.5::double precision, 'performance_metrics_hourly.avg_latency follows avg');

INSERT INTO public.user_key_pairs (user_id, device_id, identity_public_key, identity_private_key_encrypted)
VALUES ('22222222-0000-0000-0000-000000000002', 'fn-trigger-convergence', 'probe-public', 'probe-private');
SELECT ok(EXISTS (SELECT 1 FROM public.encryption_audit_log
                   WHERE user_id = '22222222-0000-0000-0000-000000000002' AND event_type = 'key_generated'
                     AND metadata->>'device_id' = 'fn-trigger-convergence'),
          'a generated key pair is audited');

DELETE FROM public.messages WHERE id = '88888888-0000-0000-0000-000000000008';
SELECT is_empty(
    $q$SELECT 1 FROM public.message_search_index WHERE message_id = '88888888-0000-0000-0000-000000000008'$q$,
    'a deleted message leaves no search index row');

SELECT * FROM finish();
ROLLBACK;
