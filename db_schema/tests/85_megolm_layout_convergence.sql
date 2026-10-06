-- 20261008200001_megolm_layout_convergence.sql: the repository's layout of megolm_room_sessions
-- and megolm_key_requests. A fresh install already has it; a converged live copy matches.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(12);

SELECT has_column('public', 'megolm_room_sessions', 'encrypted_session_key', 'megolm_room_sessions holds the session key');
SELECT hasnt_column('public', 'megolm_room_sessions', 'current_session_id', 'no pre-baseline megolm_room_sessions column');
SELECT col_type_is('public', 'megolm_room_sessions', 'room_id', 'text', 'room_id is text');

SELECT col_not_null('public', 'megolm_key_requests', 'requester_user_id', 'requester_user_id is required');
SELECT col_is_null('public', 'megolm_key_requests', 'user_id', 'user_id is the optional legacy mirror');
SELECT has_column('public', 'megolm_key_requests', 'updated_at', 'megolm_key_requests has updated_at');
SELECT is_empty(
    $q$SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'megolm_key_requests'
          AND column_name IN ('expires_at', 'requesting_device_id', 'request_id',
                              'responded_by_user_id', 'responded_by_device_id', 'responded_at')$q$,
    'no column outside the repository layout');

SELECT is((SELECT confdeltype::text FROM pg_constraint
            WHERE conrelid = 'public.megolm_key_requests'::regclass
              AND conname = 'megolm_key_requests_sender_user_id_fkey'),
          'n', 'deleting the sender keeps the request');

SELECT policies_are('public', 'megolm_room_sessions',
    ARRAY['megolm_room_sessions_insert_own', 'megolm_room_sessions_select', 'megolm_room_sessions_update_own'],
    'megolm_room_sessions carries the canonical policies');
SELECT policies_are('public', 'megolm_key_requests',
    ARRAY['megolm_key_requests_fulfill', 'megolm_key_requests_own', 'megolm_key_requests_select_for_response'],
    'megolm_key_requests carries the canonical policies');
SELECT ok(EXISTS (SELECT 1 FROM pg_policies
                   WHERE schemaname = 'public' AND tablename = 'megolm_key_requests'
                     AND policyname = 'megolm_key_requests_select_for_response'
                     AND qual LIKE '%megolm_room_sessions%creator_user_id%'),
          'a session creator reads the requests for its session');

SELECT ok(has_table_privilege('authenticated', 'public.megolm_room_sessions', 'SELECT,INSERT,UPDATE')
          AND has_table_privilege('authenticated', 'public.megolm_key_requests', 'SELECT,INSERT,UPDATE'),
          'authenticated reaches both tables, subject to their policies');

SELECT * FROM finish();
ROLLBACK;
