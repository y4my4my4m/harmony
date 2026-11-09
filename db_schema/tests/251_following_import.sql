-- Following import (migration 20261109700001): starting one, claims and the follow limit, the
-- follow path a worker takes, retries, cancelling, the shared decision in guard_follow_client_write.
--
--   imp251     imports; local, unlocked
--   open251    local, unlocked: followed at once
--   locked251  local, locked: a request
--   blk251     local: imp251 blocks it
--   byblk251   local: it blocks imp251
--   gone251    local, deleted
--   sus251     local, suspended
--   mov251     local, moved
--   have251    local: imp251 follows it
--   req251     local, locked: imp251 has a request waiting
--   rej251     local, locked: it rejected imp251
--   rem251     remote: a request, and a Follow job
--
-- queue_federation_job is replaced for the transaction so queued jobs can be read back.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(71);

GRANT USAGE ON SCHEMA tests TO service_role;
CREATE TABLE tests.jobs251 (name text, data jsonb);
GRANT INSERT, SELECT, DELETE ON tests.jobs251 TO authenticated, anon, service_role;

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.jobs251 VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

CREATE FUNCTION tests.as_service251() RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM tests.clear_authentication();
  PERFORM set_config('role', 'service_role', true);
END;
$fn$;

CREATE FUNCTION tests.import251() RETURNS uuid LANGUAGE sql AS $fn$
  SELECT current_setting('e251.import')::uuid;
$fn$;
CREATE FUNCTION tests.item251(p_handle text) RETURNS bigint LANGUAGE sql SECURITY DEFINER AS $fn$
  SELECT id FROM public.following_import_items
   WHERE import_id = tests.import251() AND handle = p_handle;
$fn$;
CREATE FUNCTION tests.finish251(p_handle text, p_username text) RETURNS text LANGUAGE sql AS $fn$
  SELECT public.finish_following_import_item(tests.item251(p_handle),
    (SELECT id FROM public.profiles WHERE username = p_username), NULL, NULL);
$fn$;

INSERT INTO auth.users (id, instance_id, aud, role, email)
SELECT ('f2510000-0000-0000-0000-0000000000' || lpad(n::text, 2, '0'))::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'u' || n || '@e251.test'
  FROM generate_series(1, 11) n;

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain, manually_approves_followers) VALUES
  ('f2511000-0000-0000-0000-000000000001', 'f2510000-0000-0000-0000-000000000001', 'imp251', 'Importer', true, 'localhost', false),
  ('f2511000-0000-0000-0000-000000000002', 'f2510000-0000-0000-0000-000000000002', 'open251', 'Open', true, 'localhost', false),
  ('f2511000-0000-0000-0000-000000000003', 'f2510000-0000-0000-0000-000000000003', 'locked251', 'Locked', true, 'localhost', true),
  ('f2511000-0000-0000-0000-000000000004', 'f2510000-0000-0000-0000-000000000004', 'blk251', 'Blocked', true, 'localhost', false),
  ('f2511000-0000-0000-0000-000000000005', 'f2510000-0000-0000-0000-000000000005', 'byblk251', 'Blocker', true, 'localhost', false),
  ('f2511000-0000-0000-0000-000000000006', 'f2510000-0000-0000-0000-000000000006', 'gone251', 'Gone', true, 'localhost', false),
  ('f2511000-0000-0000-0000-000000000007', 'f2510000-0000-0000-0000-000000000007', 'sus251', 'Suspended', true, 'localhost', false),
  ('f2511000-0000-0000-0000-000000000008', 'f2510000-0000-0000-0000-000000000008', 'mov251', 'Moved', true, 'localhost', false),
  ('f2511000-0000-0000-0000-000000000009', 'f2510000-0000-0000-0000-000000000009', 'have251', 'Have', true, 'localhost', false),
  ('f2511000-0000-0000-0000-000000000010', 'f2510000-0000-0000-0000-000000000010', 'req251', 'Req', true, 'localhost', true),
  ('f2511000-0000-0000-0000-000000000011', 'f2510000-0000-0000-0000-000000000011', 'rej251', 'Rej', true, 'localhost', true);
INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id, inbox_url) VALUES
  ('f2511000-0000-0000-0000-000000000012', 'rem251', 'Remote', false, 'remote251.test',
   'https://remote251.test/users/rem251', 'https://remote251.test/users/rem251/inbox');

UPDATE public.profiles SET deleted_at = now() WHERE username = 'gone251';
UPDATE public.profiles SET is_suspended = true WHERE username = 'sus251';
UPDATE public.profiles SET moved_to_uri = 'https://elsewhere.test/users/x', moved_at = now() WHERE username = 'mov251';

INSERT INTO public.user_blocks (blocker_id, blocked_user_id) VALUES
  ('f2511000-0000-0000-0000-000000000001', 'f2511000-0000-0000-0000-000000000004'),
  ('f2511000-0000-0000-0000-000000000005', 'f2511000-0000-0000-0000-000000000001');
INSERT INTO public.follows (follower_id, following_id, status) VALUES
  ('f2511000-0000-0000-0000-000000000001', 'f2511000-0000-0000-0000-000000000009', 'accepted'),
  ('f2511000-0000-0000-0000-000000000001', 'f2511000-0000-0000-0000-000000000010', 'pending'),
  ('f2511000-0000-0000-0000-000000000001', 'f2511000-0000-0000-0000-000000000011', 'rejected');

-- Grants ---------------------------------------------------------------------------------

SELECT ok(NOT has_function_privilege('anon', 'public.start_following_import(text[], text)', 'EXECUTE'),
          'anon cannot start an import');
SELECT ok(has_function_privilege('authenticated', 'public.start_following_import(text[], text)', 'EXECUTE'),
          'an account can start an import');
SELECT ok(has_function_privilege('authenticated', 'public.get_my_following_import()', 'EXECUTE'),
          'an account can read its import');
SELECT ok(has_function_privilege('authenticated', 'public.cancel_my_following_import()', 'EXECUTE'),
          'an account can stop its import');
SELECT ok(NOT has_function_privilege('authenticated', 'public.claim_following_import_batch(uuid, integer)', 'EXECUTE'),
          'a client cannot claim a batch');
SELECT ok(NOT has_function_privilege('authenticated', 'public.finish_following_import_item(bigint, uuid, text, integer)', 'EXECUTE'),
          'a client cannot finish an item');
SELECT ok(NOT has_function_privilege('authenticated', 'public.purge_following_imports()', 'EXECUTE'),
          'a client cannot purge imports');
SELECT ok(has_function_privilege('service_role', 'public.claim_following_import_batch(uuid, integer)', 'EXECUTE'),
          'the worker can claim a batch');
SELECT ok(has_function_privilege('service_role', 'public.finish_following_import_item(bigint, uuid, text, integer)', 'EXECUTE'),
          'the worker can finish an item');
SELECT ok(NOT has_table_privilege('authenticated', 'public.following_imports', 'SELECT'),
          'a client cannot read following_imports');
SELECT ok(NOT has_table_privilege('authenticated', 'public.following_import_items', 'SELECT'),
          'a client cannot read following_import_items');

-- Starting -------------------------------------------------------------------------------

SELECT throws_ok($$ SELECT public.start_following_import('{a@b.test}', 'mastodon_csv') $$, '42501', NULL,
                 'an anonymous call is refused');

SELECT tests.authenticate_as('f2510000-0000-0000-0000-000000000001');

SELECT is(public.start_following_import('{a@b.test}', 'something') ->> 'error', 'invalid_source', 'an unknown source is refused');
SELECT is(public.start_following_import('{"", "  "}', 'mastodon_csv') ->> 'error', 'no_accounts', 'an empty list is refused');
SELECT is(public.start_following_import(ARRAY(SELECT 'u' || n || '@b.test' FROM generate_series(1, 20001) n), 'mastodon_csv') ->> 'error',
          'too_many_accounts', 'a list over 20,000 is refused');
SELECT is(public.get_my_following_import(), NULL, 'an account that never imported reads nothing');

SELECT set_config('e251.import', public.start_following_import(ARRAY[
    'open251@localhost', '@locked251@localhost', ' OPEN251@LOCALHOST ', 'blk251@localhost', 'byblk251@localhost',
    'gone251@localhost', 'sus251@localhost', 'mov251@localhost', 'have251@localhost', 'req251@localhost', 'rej251@localhost',
    'imp251@localhost', 'rem251@remote251.test', 'not a handle', 'bare251'], 'mastodon_csv') ->> 'import_id', true);

SELECT isnt(tests.import251(), NULL, 'a list starts an import');
SELECT is((public.get_my_following_import() ->> 'total')::int, 14, 'handles are distinct without regard to case');
SELECT is((public.get_my_following_import() -> 'counts' ->> 'failed')::int, 2, 'malformed rows fail at the start');
SELECT is((public.get_my_following_import() -> 'failures' -> 0 ->> 'reason'), 'invalid_handle', 'a malformed row names why');
SELECT is((SELECT data ->> 'import_id' FROM tests.jobs251 WHERE name = 'following-import'),
          tests.import251()::text, 'the import queues its job');
SELECT is(public.start_following_import('{a@b.test}', 'mastodon_csv') ->> 'error', 'import_running', 'one import runs at a time');

-- Claims and the limit -------------------------------------------------------------------

SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = config_value || '{"account_follows_per_hour": 5}'::jsonb
 WHERE config_key = 'antispam';

SELECT tests.as_service251();

SELECT set_config('e251.batch', public.claim_following_import_batch(tests.import251(), 25)::text, true);
SELECT is(jsonb_array_length(current_setting('e251.batch')::jsonb -> 'items'), 5, 'a claim takes what the follow limit leaves');
SELECT is(current_setting('e251.batch')::jsonb -> 'items' -> 0 ->> 'handle', 'open251@localhost', 'items run in list order');

SELECT is(public.claim_following_import_batch(tests.import251(), 25) -> 'items', '[]'::jsonb,
          'claims still out use the budget');
SELECT is((public.claim_following_import_batch(tests.import251(), 25) ->> 'retry_after')::int, 60,
          'with only claims out, the next try is a minute away');
SELECT ok((SELECT next_run_at > now() FROM public.following_imports WHERE id = tests.import251()),
          'a waiting import says when it next runs');

-- The worker's follows --------------------------------------------------------------------

SELECT is(tests.finish251('open251@localhost', 'open251'), 'followed', 'an unlocked local account is followed');
SELECT is((SELECT status FROM public.follows WHERE follower_id = 'f2511000-0000-0000-0000-000000000001'
            AND following_id = 'f2511000-0000-0000-0000-000000000002'), 'accepted', 'its follow is accepted');
SELECT is(tests.finish251('locked251@localhost', 'locked251'), 'requested', 'a locked account gets a request');
SELECT is((SELECT status FROM public.follows WHERE follower_id = 'f2511000-0000-0000-0000-000000000001'
            AND following_id = 'f2511000-0000-0000-0000-000000000003'), 'pending', 'its follow is pending');
SELECT is((SELECT count(*)::int FROM public.notifications
            WHERE user_id = 'f2511000-0000-0000-0000-000000000003' AND type = 'activitypub_follow_request'), 1,
          'a locked account is told, as for a follow from the app');
SELECT is(tests.finish251('open251@localhost', 'open251'), 'followed', 'a finished item stays finished');

SELECT is(tests.finish251('blk251@localhost', 'blk251'), 'failed', 'an account the importer blocks is not followed');
SELECT is((SELECT reason FROM public.following_import_items WHERE id = tests.item251('blk251@localhost')), 'blocked',
          'and the result says a block stands');
SELECT is(tests.finish251('byblk251@localhost', 'byblk251'), 'failed', 'an account that blocks the importer is not followed');
SELECT is((SELECT count(*)::int FROM public.follows WHERE follower_id = 'f2511000-0000-0000-0000-000000000001'
            AND following_id IN ('f2511000-0000-0000-0000-000000000004', 'f2511000-0000-0000-0000-000000000005')), 0,
          'no follow row exists for either block');

UPDATE public.following_import_items SET state = 'claimed', claimed_at = now()
 WHERE import_id = tests.import251() AND state = 'queued'
   AND handle <> 'rem251@remote251.test';

SELECT is(tests.finish251('gone251@localhost', 'gone251'), 'failed', 'a deleted account is not followed');
SELECT is((SELECT reason FROM public.following_import_items WHERE id = tests.item251('gone251@localhost')), 'unavailable', 'it is unavailable');
SELECT is(tests.finish251('sus251@localhost', 'sus251'), 'failed', 'a suspended account is not followed');
SELECT is(tests.finish251('mov251@localhost', 'mov251'), 'failed', 'a moved account is not followed, as FollowService');
SELECT is((SELECT reason FROM public.following_import_items WHERE id = tests.item251('mov251@localhost')), 'moved', 'it has moved');
SELECT is(tests.finish251('have251@localhost', 'have251'), 'already_following', 'an account already followed is counted so');
SELECT is(tests.finish251('req251@localhost', 'req251'), 'already_requested', 'a waiting request is counted so');
SELECT is(tests.finish251('rej251@localhost', 'rej251'), 'failed', 'a rejected follow is not requested again');
SELECT is((SELECT reason FROM public.following_import_items WHERE id = tests.item251('rej251@localhost')), 'declined', 'it declined');
SELECT is(tests.finish251('imp251@localhost', 'imp251'), 'failed', 'the importer does not follow itself');

-- Retries and the remote follow ----------------------------------------------------------

UPDATE public.following_import_items SET state = 'claimed', claimed_at = now()
 WHERE id = tests.item251('rem251@remote251.test');
SELECT is(public.finish_following_import_item(tests.item251('rem251@remote251.test'), NULL, 'unreachable', 600), 'queued',
          'an unreachable host is tried again');
SELECT ok((SELECT not_before > now() + interval '9 minutes' FROM public.following_import_items
            WHERE id = tests.item251('rem251@remote251.test')), 'after a wait');

UPDATE public.following_import_items SET not_before = NULL, state = 'claimed', claimed_at = now() - interval '11 minutes'
 WHERE id = tests.item251('rem251@remote251.test');
UPDATE public.following_import_items
   SET finished_at = now() - interval '2 hours'
 WHERE import_id = tests.import251() AND state IN ('followed', 'requested');
SELECT is(public.claim_following_import_batch(tests.import251(), 25) -> 'items' -> 0 ->> 'handle',
          'rem251@remote251.test', 'a stale claim returns to the queue');
SELECT is((SELECT attempts FROM public.following_import_items WHERE id = tests.item251('rem251@remote251.test'))::int, 2,
          'and counts as an attempt');

DELETE FROM tests.jobs251;
SELECT is(tests.finish251('rem251@remote251.test', 'rem251'), 'requested', 'a remote account gets a request');
SELECT is((SELECT data ->> 'following_id' FROM tests.jobs251 WHERE name = 'federate-follow'),
          'f2511000-0000-0000-0000-000000000012', 'the follow triggers queue the Follow');

SELECT is(public.claim_following_import_batch(tests.import251(), 25) ->> 'finished', 'true',
          'an import with nothing left finishes');
SELECT isnt((SELECT finished_at FROM public.following_imports WHERE id = tests.import251()), NULL,
            'and records when');

-- The result, then a stopped import ------------------------------------------------------

SELECT tests.authenticate_as('f2510000-0000-0000-0000-000000000001');
SELECT is((public.get_my_following_import() -> 'counts'),
          '{"followed": 1, "requested": 2, "already_following": 1, "already_requested": 1, "failed": 9, "cancelled": 0}'::jsonb,
          'the result counts each outcome');
SELECT is(public.cancel_my_following_import() ->> 'error', 'not_running', 'nothing to stop');

-- now() is one value in a transaction; the latest import is the one created last.
SELECT tests.clear_authentication();
UPDATE public.following_imports SET created_at = now() - interval '1 hour' WHERE id = tests.import251();
SELECT tests.authenticate_as('f2510000-0000-0000-0000-000000000001');

SELECT is(public.start_following_import('{zz251@localhost}', 'harmony_export') ->> 'success', 'true', 'a finished import allows another');
SELECT is(public.cancel_my_following_import() ->> 'success', 'true', 'a running import stops');
SELECT is((public.get_my_following_import() -> 'counts' ->> 'cancelled')::int, 1, 'its items are cancelled');
SELECT is((public.get_my_following_import() ->> 'cancelled'), 'true', 'and the result says stopped');

-- A moved importer ------------------------------------------------------------------------

SELECT is(public.start_following_import('{zz252@localhost}', 'harmony_export') ->> 'success', 'true', 'another start');
SELECT tests.clear_authentication();
UPDATE public.profiles SET moved_to_uri = 'https://elsewhere.test/users/imp', moved_at = now()
 WHERE id = 'f2511000-0000-0000-0000-000000000001';
SELECT tests.as_service251();
SELECT is(public.claim_following_import_batch(
            (SELECT id FROM public.following_imports WHERE profile_id = 'f2511000-0000-0000-0000-000000000001' AND finished_at IS NULL), 25) ->> 'finished',
          'true', 'an importer that moved closes the import');

SELECT tests.authenticate_as('f2510000-0000-0000-0000-000000000001');
SELECT is(public.start_following_import('{a@b.test}', 'mastodon_csv') ->> 'error', 'account_moved', 'a moved account does not import');

-- Limits and retention ---------------------------------------------------------------------

SELECT tests.clear_authentication();
INSERT INTO public.following_imports (profile_id, source, total, finished_at)
SELECT 'f2511000-0000-0000-0000-000000000009', 'mastodon_csv', 0, now() FROM generate_series(1, 5);
INSERT INTO public.following_imports (profile_id, source, total, created_at, finished_at)
VALUES ('f2511000-0000-0000-0000-000000000010', 'mastodon_csv', 0, now() - interval '40 days', now() - interval '31 days');
UPDATE public.profiles SET is_suspended = true WHERE id = 'f2511000-0000-0000-0000-000000000011';

SELECT tests.authenticate_as('f2510000-0000-0000-0000-000000000009');
SELECT throws_ok($$ SELECT public.start_following_import('{a@b.test}', 'mastodon_csv') $$, 'PT429', 'import_rate_limited',
                 'five imports in a day is the limit');
SELECT tests.authenticate_as('f2510000-0000-0000-0000-000000000011');
SELECT is(public.start_following_import('{a@b.test}', 'mastodon_csv') ->> 'error', 'account_suspended', 'a suspended account does not import');

SELECT tests.as_service251();
SELECT is(public.purge_following_imports(), 1, 'results over 30 days old are purged');
SELECT is((SELECT count(*)::int FROM public.following_imports WHERE profile_id = 'f2511000-0000-0000-0000-000000000010'), 0,
          'and only those');

-- The client path stays the same -----------------------------------------------------------

SELECT tests.authenticate_as('f2510000-0000-0000-0000-000000000002');
SELECT lives_ok($$ INSERT INTO public.follows (follower_id, following_id, status)
                   VALUES ('f2511000-0000-0000-0000-000000000002', 'f2511000-0000-0000-0000-000000000003', 'accepted') $$,
                'a client follows a locked account');
SELECT is((SELECT status FROM public.follows WHERE follower_id = 'f2511000-0000-0000-0000-000000000002'
            AND following_id = 'f2511000-0000-0000-0000-000000000003'), 'pending',
          'and the guard makes it a request');
SELECT tests.authenticate_as('f2510000-0000-0000-0000-000000000005');
SELECT throws_ok($$ INSERT INTO public.follows (follower_id, following_id)
                    VALUES ('f2511000-0000-0000-0000-000000000005', 'f2511000-0000-0000-0000-000000000001') $$,
                 '42501', NULL, 'a client follow across a block is refused');

SELECT * FROM finish();
ROLLBACK;
