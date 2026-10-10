-- Account migration (migration 20261010900001): aliases, Move with step-up and cooldown,
-- the client-write guard on the new profile columns, follower migration, inbound Moves,
-- server-membership carry-over and the export additions.
--
-- Fixture roles: bob (password 'bob-password') moves to newbob, a second local account
-- that lists bob as an alias. alice follows bob and keeps him in a list; mallory follows bob
-- but newbob blocks her; frozen is a suspended local follower; banned blocks bob. oldremote
-- moves to newremote, which lists it; alice follows oldremote. oldmember moved to newmember
-- and holds a role and a nickname on server_1. queue_federation_job is replaced for the
-- transaction so queued jobs can be read back.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(63);

-- The backend RPCs run as service_role, which needs the pgTAP schema for the assertions.
GRANT USAGE ON SCHEMA tests TO service_role;
CREATE TABLE tests.jobs112 (name text, data jsonb);
GRANT INSERT, SELECT, DELETE ON tests.jobs112 TO authenticated, anon, service_role;

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.jobs112 VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

-- Claims as PostgREST v13 sets them. amr timestamps are epoch seconds.
CREATE OR REPLACE FUNCTION tests.as_user112(p_uid uuid, p_aal text DEFAULT 'aal1',
                                            p_amr jsonb DEFAULT '[]'::jsonb)
RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM set_config('request.jwt.claims', jsonb_build_object(
      'sub', p_uid, 'role', 'authenticated', 'aal', p_aal, 'amr', p_amr)::text, true);
  PERFORM set_config('request.jwt.claim.sub', p_uid::text, true);
  PERFORM set_config('role', 'authenticated', true);
END;
$fn$;

-- Fixture -------------------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('b0b00112-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'newbob@test.local'),
  ('b0b00112-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'fresh@test.local');
UPDATE auth.users SET encrypted_password = extensions.crypt('bob-password', extensions.gen_salt('bf', 4))
 WHERE id = 'bbbbbbbb-0000-0000-0000-000000000002';
INSERT INTO auth.mfa_factors (id, user_id, factor_type, status, created_at, updated_at) VALUES
  ('b0b00112-0000-0000-0000-0000000000f1', 'aaaaaaaa-0000-0000-0000-000000000001', 'totp', 'unverified', now(), now());
UPDATE auth.mfa_factors SET status = 'verified' WHERE id = 'b0b00112-0000-0000-0000-0000000000f1';

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, is_suspended) VALUES
  ('b0b00112-0000-0000-0000-000000000001', 'b0b00112-0000-0000-0000-0000000000a1', 'newbob', 'New Bob', true, false),
  ('b0b00112-0000-0000-0000-000000000002', NULL, 'frozen', 'Frozen', true, true);

INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id, inbox_url, also_known_as) VALUES
  ('b0b00112-0000-0000-0000-000000000003', 'fan', 'Fan', false, 'remote.test',
   'https://remote.test/users/fan', 'https://remote.test/users/fan/inbox', '{}'),
  ('b0b00112-0000-0000-0000-000000000010', 'oldremote', 'Old', false, 'remote.test',
   'https://remote.test/users/oldremote', 'https://remote.test/users/oldremote/inbox', '{}'),
  ('b0b00112-0000-0000-0000-000000000011', 'newremote', 'New', false, 'other.test',
   'https://other.test/users/newremote', 'https://other.test/users/newremote/inbox',
   '{https://remote.test/users/oldremote}'),
  ('b0b00112-0000-0000-0000-000000000012', 'thirdremote', 'Third', false, 'other.test',
   'https://other.test/users/thirdremote', 'https://other.test/users/thirdremote/inbox',
   '{https://remote.test/users/oldremote}'),
  ('b0b00112-0000-0000-0000-000000000013', 'stranger', 'Stranger', false, 'other.test',
   'https://other.test/users/stranger', 'https://other.test/users/stranger/inbox', '{}'),
  ('b0b00112-0000-0000-0000-000000000014', 'gone', 'Gone', false, 'other.test',
   'https://other.test/users/gone', 'https://other.test/users/gone/inbox',
   '{https://localhost/users/bob}'),
  ('b0b00112-0000-0000-0000-000000000015', 'shut', 'Shut', false, 'other.test',
   'https://other.test/users/shut', 'https://other.test/users/shut/inbox',
   '{https://localhost/users/bob}'),
  ('b0b00112-0000-0000-0000-000000000020', 'oldmember', 'Old Member', false, 'remote.test',
   'https://remote.test/users/oldmember', 'https://remote.test/users/oldmember/inbox', '{}'),
  ('b0b00112-0000-0000-0000-000000000021', 'newmember', 'New Member', false, 'other.test',
   'https://other.test/users/newmember', 'https://other.test/users/newmember/inbox',
   '{https://remote.test/users/oldmember}');
UPDATE public.profiles SET moved_to_uri = 'https://elsewhere.test/users/x', moved_at = now()
 WHERE id = 'b0b00112-0000-0000-0000-000000000014';
UPDATE public.profiles SET is_suspended = true WHERE id = 'b0b00112-0000-0000-0000-000000000015';

INSERT INTO public.follows (follower_id, following_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', 'accepted'),
  ('33333333-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000002', 'accepted'),
  ('b0b00112-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002', 'accepted'),
  ('b0b00112-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000002', 'accepted'),
  ('11111111-0000-0000-0000-000000000001', 'b0b00112-0000-0000-0000-000000000010', 'accepted');
INSERT INTO public.user_blocks (blocker_id, blocked_user_id) VALUES
  ('b0b00112-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003'),
  ('44444444-0000-0000-0000-000000000004', '22222222-0000-0000-0000-000000000002');
INSERT INTO public.user_mutes (muter_id, muted_user_id) VALUES
  ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002');
INSERT INTO public.user_lists (id, user_id, title) VALUES
  ('b0b00112-0000-0000-0000-000000000040', '11111111-0000-0000-0000-000000000001', 'Friends');
INSERT INTO public.user_list_members (list_id, account_id) VALUES
  ('b0b00112-0000-0000-0000-000000000040', '22222222-0000-0000-0000-000000000002');

INSERT INTO public.server_roles (id, server_id, name, position) VALUES
  ('b0b00112-0000-0000-0000-000000000030', '55555555-0000-0000-0000-000000000005', 'Veteran', 1);
INSERT INTO public.user_servers (user_id, server_id, status, nickname) VALUES
  ('b0b00112-0000-0000-0000-000000000020', '55555555-0000-0000-0000-000000000005', 'accepted', 'Oldie'),
  ('b0b00112-0000-0000-0000-000000000021', '55555555-0000-0000-0000-000000000005', 'accepted', NULL);
INSERT INTO public.user_roles (user_id, role_id, server_id) VALUES
  ('b0b00112-0000-0000-0000-000000000020', 'b0b00112-0000-0000-0000-000000000030', '55555555-0000-0000-0000-000000000005');
UPDATE public.profiles SET moved_to_id = 'b0b00112-0000-0000-0000-000000000021',
       moved_to_uri = 'https://other.test/users/newmember', moved_at = now()
 WHERE id = 'b0b00112-0000-0000-0000-000000000020';

-- Grants --------------------------------------------------------------------------------
SELECT ok(has_function_privilege('authenticated', 'public.set_my_account_aliases(text[])', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.begin_account_move(uuid, text)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.cancel_my_account_redirect()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.set_my_account_aliases(text[])', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.begin_account_move(uuid, text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.cancel_my_account_redirect()', 'EXECUTE'),
          'account migration RPCs are granted to authenticated, not anon');
SELECT ok(NOT has_function_privilege('authenticated', 'public.record_remote_account_move(uuid, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.migrate_account_followers(uuid, integer)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.carry_over_moved_membership(uuid, uuid, uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.record_remote_account_move(uuid, uuid)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.migrate_account_followers(uuid, integer)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.carry_over_moved_membership(uuid, uuid, uuid)', 'EXECUTE'),
          'backend RPCs are granted to service_role only');
SELECT ok(NOT has_function_privilege('authenticated', 'public.profile_actor_uri(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.profile_id_by_actor_uri(text)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.account_move_refusal(uuid, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.apply_account_move(uuid, uuid)', 'EXECUTE'),
          'internal helpers are not callable by clients');
SELECT ok(NOT has_table_privilege('authenticated', 'public.account_migrations', 'SELECT')
          AND NOT has_table_privilege('anon', 'public.account_migrations', 'SELECT')
          AND has_table_privilege('service_role', 'public.account_migrations', 'UPDATE'),
          'account_migrations is closed to clients');

-- Client writes ---------------------------------------------------------------------------
SELECT tests.as_user112('bbbbbbbb-0000-0000-0000-000000000002');
UPDATE public.profiles SET also_known_as = '{https://evil.test/users/x}',
       moved_to_uri = 'https://evil.test/users/x',
       moved_to_id = '11111111-0000-0000-0000-000000000001', moved_at = now(),
       display_name = 'Bob Edited'
 WHERE id = '22222222-0000-0000-0000-000000000002';
SELECT tests.as_user112('b0b00112-0000-0000-0000-0000000000a2');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, also_known_as, moved_to_uri)
VALUES ('b0b00112-0000-0000-0000-000000000005', 'b0b00112-0000-0000-0000-0000000000a2', 'fresh112', 'Fresh',
        true, '{https://evil.test/users/x}', 'https://evil.test/users/x');
SELECT tests.clear_authentication();

SELECT is((SELECT row(display_name, also_known_as, moved_to_uri, moved_to_id, moved_at)::text
             FROM public.profiles WHERE id = '22222222-0000-0000-0000-000000000002'),
          row('Bob Edited', '{}'::text[], NULL::text, NULL::uuid, NULL::timestamptz)::text,
          'a client update keeps aliases and the move target as they were');
SELECT is((SELECT row(also_known_as, moved_to_uri)::text
             FROM public.profiles WHERE id = 'b0b00112-0000-0000-0000-000000000005'),
          row('{}'::text[], NULL::text)::text,
          'a client insert starts without aliases or a move target');

-- Aliases ---------------------------------------------------------------------------------
DELETE FROM tests.jobs112;
SELECT tests.as_user112('b0b00112-0000-0000-0000-0000000000a1');
SELECT is(public.set_my_account_aliases(ARRAY[' https://localhost/users/bob ', 'https://localhost/users/bob',
                                              'https://remote.test/users/oldremote']) -> 'aliases',
          '["https://localhost/users/bob", "https://remote.test/users/oldremote"]'::jsonb,
          'aliases are trimmed and deduplicated in order');
SELECT is(public.set_my_account_aliases(ARRAY['https://localhost/users/newbob']) ->> 'error', 'alias_is_self',
          'an account is not its own alias');
SELECT is(public.set_my_account_aliases(ARRAY['https://nowhere.test/users/ghost']) -> 'uris',
          '["https://nowhere.test/users/ghost"]'::jsonb,
          'an alias names a stored account');
SELECT is(public.set_my_account_aliases(ARRAY['ftp://remote.test/users/fan']) ->> 'error', 'invalid_alias',
          'an alias is an http(s) URI');
SELECT is(public.set_my_account_aliases(ARRAY(SELECT 'https://many.test/users/u' || g FROM generate_series(1, 11) g))
            ->> 'error', 'too_many_aliases',
          'at most ten aliases');
SELECT tests.clear_authentication();
SELECT is((SELECT also_known_as FROM public.profiles WHERE id = 'b0b00112-0000-0000-0000-000000000001'),
          '{https://localhost/users/bob,https://remote.test/users/oldremote}'::text[],
          'refused alias lists leave the stored list as it was');
SELECT ok(EXISTS (SELECT 1 FROM tests.jobs112 WHERE name = 'federate-profile'
                     AND data ->> 'profile_id' = 'b0b00112-0000-0000-0000-000000000001'),
          'an alias change federates an Update');
SELECT tests.as_user112('b0b00112-0000-0000-0000-0000000000a1');
SELECT is(public.set_my_account_aliases(ARRAY['https://localhost/users/bob', 'https://localhost/users/alice',
                                              'https://localhost/users/mallory']) ->> 'success', 'true',
          'local accounts are aliases by their derived actor URI');
SELECT tests.clear_authentication();
UPDATE public.profiles SET also_known_as = also_known_as || '{https://gone.test/users/x}'
 WHERE id = 'b0b00112-0000-0000-0000-000000000001';
SELECT tests.as_user112('b0b00112-0000-0000-0000-0000000000a1');
SELECT is(public.set_my_account_aliases(ARRAY['https://localhost/users/bob', 'https://localhost/users/alice',
                                              'https://localhost/users/mallory', 'https://gone.test/users/x'])
            ->> 'success', 'true',
          'an alias already listed stays when its account is no longer stored');
SELECT tests.clear_authentication();

-- Move refusals ---------------------------------------------------------------------------
SELECT tests.as_user112('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.begin_account_move('22222222-0000-0000-0000-000000000002', 'bob-password') ->> 'error',
          'target_is_self', 'an account cannot move to itself');
SELECT is(public.begin_account_move('11111111-0000-0000-0000-000000000001', 'bob-password') ->> 'error',
          'alias_missing', 'the target must list the account as an alias');
SELECT is(public.begin_account_move('b0b00112-0000-0000-0000-000000000014', 'bob-password') ->> 'error',
          'target_moved', 'a target that moved itself is refused');
SELECT is(public.begin_account_move('b0b00112-0000-0000-0000-000000000015', 'bob-password') ->> 'error',
          'target_suspended', 'a suspended target is refused');
SELECT is(public.begin_account_move('b0b00112-0000-0000-0000-000000000099', 'bob-password') ->> 'error',
          'target_not_found', 'an unknown target is refused');
SELECT is(public.begin_account_move('b0b00112-0000-0000-0000-000000000001') ->> 'error',
          'password_required', 'a password account re-enters it');
SELECT is(public.begin_account_move('b0b00112-0000-0000-0000-000000000001', 'wrong') ->> 'error',
          'invalid_password', 'a wrong password is refused');
SELECT tests.as_user112('aaaaaaaa-0000-0000-0000-000000000001', 'aal1');
SELECT is(public.begin_account_move('b0b00112-0000-0000-0000-000000000001') ->> 'error',
          'mfa_required', 'a 2FA account needs a fresh TOTP verify');
SELECT tests.as_user112('cccccccc-0000-0000-0000-000000000003', 'aal1',
                        jsonb_build_array(jsonb_build_object('method', 'password',
                            'timestamp', extract(epoch FROM now() - interval '1 hour')::bigint)));
SELECT is(public.begin_account_move('b0b00112-0000-0000-0000-000000000001') ->> 'error',
          'reauthentication_required', 'an account without a password needs a recent sign-in');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.account_migrations), 0, 'refused moves record nothing');

-- Move ------------------------------------------------------------------------------------
DELETE FROM tests.jobs112;
SELECT tests.as_user112('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.begin_account_move('b0b00112-0000-0000-0000-000000000001', 'bob-password') ->> 'target_uri',
          'https://localhost/users/newbob', 'bob moves to newbob');
SELECT tests.clear_authentication();
SELECT is((SELECT row(moved_to_id, moved_to_uri, moved_at IS NOT NULL)::text
             FROM public.profiles WHERE id = '22222222-0000-0000-0000-000000000002'),
          row('b0b00112-0000-0000-0000-000000000001'::uuid, 'https://localhost/users/newbob', true)::text,
          'the profile points at the target');
SELECT is((SELECT row(target_profile_id, target_uri, followers_count, delivered_at, cancelled_at)::text
             FROM public.account_migrations WHERE profile_id = '22222222-0000-0000-0000-000000000002'),
          row('b0b00112-0000-0000-0000-000000000001'::uuid, 'https://localhost/users/newbob', 4,
              NULL::timestamptz, NULL::timestamptz)::text,
          'the migration is recorded with the follower count');
SELECT is((SELECT data ->> 'migration_id' FROM tests.jobs112 WHERE name = 'account-moved'),
          (SELECT id::text FROM public.account_migrations WHERE profile_id = '22222222-0000-0000-0000-000000000002'),
          'delivery is queued for the migration');
SELECT ok(EXISTS (SELECT 1 FROM tests.jobs112 WHERE name = 'federate-profile'
                     AND data ->> 'profile_id' = '22222222-0000-0000-0000-000000000002'),
          'the move federates an Update carrying movedTo');
SELECT tests.as_user112('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.begin_account_move('b0b00112-0000-0000-0000-000000000001', 'bob-password') ->> 'error',
          'already_moved', 'a moved account does not move again');
SELECT tests.clear_authentication();

-- Follower migration ----------------------------------------------------------------------
DELETE FROM tests.jobs112;
SELECT set_config('role', 'service_role', true);
SELECT is(public.migrate_account_followers(
              (SELECT id FROM public.account_migrations WHERE profile_id = '22222222-0000-0000-0000-000000000002')),
          1, 'one local follower is eligible');
SELECT is(public.migrate_account_followers(
              (SELECT id FROM public.account_migrations WHERE profile_id = '22222222-0000-0000-0000-000000000002')),
          0, 'a second batch finds none');
SELECT tests.clear_authentication();
SELECT is((SELECT status FROM public.follows
            WHERE follower_id = '11111111-0000-0000-0000-000000000001'
              AND following_id = 'b0b00112-0000-0000-0000-000000000001'),
          'accepted', 'alice follows the local target, accepted');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.follows
                       WHERE follower_id = '11111111-0000-0000-0000-000000000001'
                         AND following_id = '22222222-0000-0000-0000-000000000002'),
          'alice no longer follows bob');
SELECT is((SELECT array_agg(follower_id ORDER BY follower_id) FROM public.follows
            WHERE following_id = '22222222-0000-0000-0000-000000000002'),
          ARRAY['33333333-0000-0000-0000-000000000003', 'b0b00112-0000-0000-0000-000000000002',
                'b0b00112-0000-0000-0000-000000000003']::uuid[],
          'blocked, suspended and remote followers stay');
SELECT is((SELECT array_agg(account_id) FROM public.user_list_members
            WHERE list_id = 'b0b00112-0000-0000-0000-000000000040'),
          ARRAY['b0b00112-0000-0000-0000-000000000001']::uuid[],
          'the list entry moves to the target');
SELECT ok(EXISTS (SELECT 1 FROM public.user_blocks
                   WHERE blocker_id = '44444444-0000-0000-0000-000000000004'
                     AND blocked_user_id = 'b0b00112-0000-0000-0000-000000000001')
          AND EXISTS (SELECT 1 FROM public.user_mutes
                       WHERE muter_id = '11111111-0000-0000-0000-000000000001'
                         AND muted_user_id = 'b0b00112-0000-0000-0000-000000000001'),
          'blocks and mutes of the origin carry over');
SELECT is((SELECT data #>> '{target,id}' FROM public.notifications
            WHERE user_id = '11111111-0000-0000-0000-000000000001' AND type = 'move'),
          'b0b00112-0000-0000-0000-000000000001', 'the migrated follower is notified');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.notifications
                       WHERE user_id = '33333333-0000-0000-0000-000000000003' AND type = 'move'),
          'a follower left in place is not notified');

-- Cancel and cooldown ---------------------------------------------------------------------
DELETE FROM tests.jobs112;
SELECT tests.as_user112('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.cancel_my_account_redirect() ->> 'success', 'true', 'the redirect is cancelled');
SELECT is(public.cancel_my_account_redirect() ->> 'error', 'not_moved', 'cancelling twice answers not_moved');
SELECT throws_ok($$SELECT public.begin_account_move('b0b00112-0000-0000-0000-000000000001', 'bob-password')$$,
                 'PT429', 'move_cooldown', 'another move waits 30 days, cancelled or not');
SELECT tests.clear_authentication();
SELECT is((SELECT row(moved_to_id, moved_to_uri, moved_at)::text
             FROM public.profiles WHERE id = '22222222-0000-0000-0000-000000000002'),
          row(NULL::uuid, NULL::text, NULL::timestamptz)::text, 'cancel clears the target');
SELECT ok((SELECT cancelled_at IS NOT NULL FROM public.account_migrations
            WHERE profile_id = '22222222-0000-0000-0000-000000000002'),
          'the migration is marked cancelled');
SELECT ok(EXISTS (SELECT 1 FROM tests.jobs112 WHERE name = 'federate-profile'
                     AND data ->> 'profile_id' = '22222222-0000-0000-0000-000000000002'),
          'cancelling federates an Update without movedTo');
SELECT set_config('role', 'service_role', true);
SELECT is(public.migrate_account_followers(
              (SELECT id FROM public.account_migrations WHERE profile_id = '22222222-0000-0000-0000-000000000002')),
          0, 'a cancelled migration moves nobody');

-- Inbound Move ----------------------------------------------------------------------------
DELETE FROM tests.jobs112;
SELECT is(public.record_remote_account_move('22222222-0000-0000-0000-000000000002',
                                            'b0b00112-0000-0000-0000-000000000001') ->> 'error',
          'origin_not_remote', 'a local origin moves through begin_account_move only');
SELECT is(public.record_remote_account_move('b0b00112-0000-0000-0000-000000000010',
                                            'b0b00112-0000-0000-0000-000000000013') ->> 'error',
          'alias_missing', 'an inbound Move needs the alias on the target');
SELECT is(public.record_remote_account_move('b0b00112-0000-0000-0000-000000000010',
                                            'b0b00112-0000-0000-0000-000000000011') ->> 'created',
          'true', 'oldremote moves to newremote');
SELECT is(public.record_remote_account_move('b0b00112-0000-0000-0000-000000000010',
                                            'b0b00112-0000-0000-0000-000000000011') ->> 'migration_id',
          (SELECT id::text FROM public.account_migrations WHERE profile_id = 'b0b00112-0000-0000-0000-000000000010'),
          'a repeated Move returns the same migration');
SELECT is((SELECT count(*)::int FROM tests.jobs112 WHERE name = 'account-moved'), 1,
          'a repeated Move queues nothing more');
SELECT is(public.record_remote_account_move('b0b00112-0000-0000-0000-000000000010',
                                            'b0b00112-0000-0000-0000-000000000012') ->> 'error',
          'recently_moved', 'a Move elsewhere inside 30 days is ignored');
SELECT is(public.migrate_account_followers(
              (SELECT id FROM public.account_migrations WHERE profile_id = 'b0b00112-0000-0000-0000-000000000010')),
          1, 'the local follower of the remote origin moves');
SELECT tests.clear_authentication();
SELECT is((SELECT status FROM public.follows
            WHERE follower_id = '11111111-0000-0000-0000-000000000001'
              AND following_id = 'b0b00112-0000-0000-0000-000000000011'),
          'pending', 'a follow of a remote target waits for its Accept');
SELECT ok(EXISTS (SELECT 1 FROM tests.jobs112 WHERE name = 'federate-follow' AND data ->> 'type' = 'create'
                     AND data ->> 'following_id' = 'b0b00112-0000-0000-0000-000000000011')
          AND EXISTS (SELECT 1 FROM tests.jobs112 WHERE name = 'federate-follow' AND data ->> 'type' = 'delete'
                         AND data ->> 'following_id' = 'b0b00112-0000-0000-0000-000000000010'),
          'the Follow and the Undo are queued');

-- Server membership -----------------------------------------------------------------------
SELECT set_config('role', 'service_role', true);
SELECT is(public.carry_over_moved_membership('55555555-0000-0000-0000-000000000005',
                                             'b0b00112-0000-0000-0000-000000000011',
                                             'b0b00112-0000-0000-0000-000000000020'),
          'not_alias', 'only the account an alias moved to carries its membership');
SELECT is(public.carry_over_moved_membership('55555555-0000-0000-0000-000000000005',
                                             'b0b00112-0000-0000-0000-000000000021',
                                             'b0b00112-0000-0000-0000-000000000020'),
          'carried', 'newmember takes over oldmember''s membership');
SELECT tests.clear_authentication();
SELECT is((SELECT row(us.nickname, EXISTS (SELECT 1 FROM public.user_roles ur
                                            WHERE ur.user_id = us.user_id
                                              AND ur.role_id = 'b0b00112-0000-0000-0000-000000000030'))::text
             FROM public.user_servers us
            WHERE us.user_id = 'b0b00112-0000-0000-0000-000000000021'
              AND us.server_id = '55555555-0000-0000-0000-000000000005'),
          row('Oldie', true)::text, 'nickname and roles carry over');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.user_servers
                       WHERE user_id = 'b0b00112-0000-0000-0000-000000000020'
                         AND server_id = '55555555-0000-0000-0000-000000000005'),
          'the old membership is removed');
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('b0b00112-0000-0000-0000-000000000020', '55555555-0000-0000-0000-000000000005', 'accepted');
INSERT INTO public.server_bans (server_id, user_id) VALUES
  ('55555555-0000-0000-0000-000000000005', 'b0b00112-0000-0000-0000-000000000020');
SELECT is(public.carry_over_moved_membership('55555555-0000-0000-0000-000000000005',
                                             'b0b00112-0000-0000-0000-000000000021',
                                             'b0b00112-0000-0000-0000-000000000020'),
          'alias_banned', 'a banned alias carries nothing');

-- Export ----------------------------------------------------------------------------------
SELECT is(public.profile_handle('22222222-0000-0000-0000-000000000002') ->> 'federated_id',
          'https://localhost/users/bob', 'export handles carry the actor URI');
SELECT tests.as_user112('aaaaaaaa-0000-0000-0000-000000000001', 'aal2');
SELECT ok((SELECT bool_and(s ? 'is_local_server' AND s ? 'ap_id' AND s ? 'host_domain')
             FROM jsonb_array_elements(public.request_my_data_export() -> 'servers') s),
          'exported servers carry their federation identity');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
