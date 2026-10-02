-- 20261006760001_internal_definer_grants.sql: the definers production and staging served
-- to anon. A fresh install already revokes them; on a migrated live copy this is the
-- convergence.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(5);

CREATE TEMP TABLE drifted_fn AS
SELECT p.oid::regprocedure AS fn, p.proname, p.prosecdef
  FROM pg_proc p
 WHERE p.pronamespace = 'public'::regnamespace
   AND p.proname IN (
                     'add_user_prekeys', 'archive_popular_hashtags',
                     'cleanup_expired_statuses', 'cleanup_inactive_hashtags',
                     'cleanup_stale_user_sessions', 'cleanup_stale_voice_participants',
                     'clear_orphaned_public_keys', 'create_default_notification_preferences',
                     'create_notification_structured',
                     'create_notification_with_spam_prevention', 'disable_federation_triggers',
                     'enable_conversation_encryption', 'enable_federation_triggers',
                     'end_user_session', 'generate_livekit_token', 'get_custom_status',
                     'get_livekit_config', 'get_timeline', 'get_unused_prekey',
                     'get_user_prekey_bundle', 'get_voice_channel_participants', 'has_muted',
                     'is_author_suspended', 'is_muted_by', 'record_metric',
                     'reset_user_encryption', 'rotate_prekeys', 'update_session_context',
                     'update_session_heartbeat');

SELECT is_empty(
    $q$SELECT fn FROM drifted_fn
        WHERE prosecdef
          AND (has_function_privilege('anon', fn, 'EXECUTE')
               OR has_function_privilege('authenticated', fn, 'EXECUTE'))$q$,
    'clients hold no EXECUTE on a definer the repository grants to service_role alone');

SELECT is_empty(
    $q$SELECT fn FROM drifted_fn WHERE prosecdef AND NOT has_function_privilege('service_role', fn, 'EXECUTE')$q$,
    'service_role keeps EXECUTE');

SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.disable_federation_triggers()$q$, '42501', NULL,
                 'anon cannot switch the federation triggers off');
SELECT throws_ok(
    $q$SELECT public.create_notification_structured('11111111-0000-0000-0000-000000000001', 'system', '{}'::jsonb)$q$,
    '42501', NULL, 'anon cannot write a notification');
SELECT throws_ok(
    $q$SELECT public.record_metric('probe', 'probe', 1, NULL, NULL, NULL)$q$,
    '42501', NULL, 'anon cannot write a metric');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
