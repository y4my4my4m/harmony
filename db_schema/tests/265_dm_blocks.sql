-- Blocks in direct messages after 20261111500001_dm_blocks.sql.
--
--   alice    instance admin, holds the fixture DM with bob
--   bob      blocked by alice
--   mallory  in no server and no conversation
--   carol    c265 account
--   g1       group of carol, alice and bob
--   g2       group of bob and carol that alice left
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(35);
-- Rolled back with the file: assertions run as service_role below.
GRANT USAGE ON SCHEMA tests TO service_role;

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('c2650000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol265@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('c2651000-0000-0000-0000-00000000000c', 'c2650000-0000-0000-0000-00000000000c', 'carol265', 'Carol', true);

INSERT INTO public.conversations (id, type, name, created_by) VALUES
  ('c2652000-0000-0000-0000-000000000001', 'group', 'g1', 'c2651000-0000-0000-0000-00000000000c'),
  ('c2652000-0000-0000-0000-000000000002', 'group', 'g2', '22222222-0000-0000-0000-000000000002');
INSERT INTO public.conversation_participants (conversation_id, user_id, role, left_at) VALUES
  ('c2652000-0000-0000-0000-000000000001', 'c2651000-0000-0000-0000-00000000000c', 'admin', NULL),
  ('c2652000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'member', NULL),
  ('c2652000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', 'member', NULL),
  ('c2652000-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002', 'admin', NULL),
  ('c2652000-0000-0000-0000-000000000002', 'c2651000-0000-0000-0000-00000000000c', 'member', NULL),
  ('c2652000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 'member', now());

CREATE FUNCTION pg_temp.dm(p_sender uuid, p_text text) RETURNS text LANGUAGE sql AS $$
  SELECT format($f$INSERT INTO public.messages (conversation_id, user_id, content)
                   VALUES ('77777777-0000-0000-0000-000000000007', %L, '[{"type":"text","text":%s}]')$f$,
                p_sender, to_json(p_text)::text);
$$;
CREATE FUNCTION pg_temp.group_msg(p_group uuid, p_sender uuid) RETURNS text LANGUAGE sql AS $$
  SELECT format($f$INSERT INTO public.messages (conversation_id, user_id, content)
                   VALUES (%L, %L, '[{"type":"text","text":"g"}]')$f$, p_group, p_sender);
$$;

-- The block ------------------------------------------------------------------------------------------
SELECT ok(NOT public.dm_block_between('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002'),
          'no block is between alice and bob at first');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$INSERT INTO public.user_blocks (blocker_id, blocked_user_id)
                   VALUES ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002')$q$,
                'alice blocks bob');
SELECT tests.clear_authentication();
SELECT ok(public.dm_block_between('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002'),
          'the block is between them from the blocker''s side');
SELECT ok(public.dm_block_between('22222222-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001'),
          'and from the blocked side');
INSERT INTO public.user_blocks (blocker_id, blocked_user_id, expires_at)
VALUES ('33333333-0000-0000-0000-000000000003', 'c2651000-0000-0000-0000-00000000000c', now() - interval '1 hour');
SELECT ok(NOT public.dm_block_between('33333333-0000-0000-0000-000000000003', 'c2651000-0000-0000-0000-00000000000c'),
          'an expired block is none');
SELECT ok(NOT has_function_privilege('authenticated', 'public.dm_block_between(uuid, uuid)', 'EXECUTE'),
          'a client cannot ask whether two accounts are blocked');
SELECT ok(NOT has_function_privilege('authenticated', 'public.dm_conversation_blocked(uuid, uuid)', 'EXECUTE'),
          'or whether a conversation is');

-- Direct messages ------------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(pg_temp.dm('22222222-0000-0000-0000-000000000002', 'to the blocker'),
                 'P0001'::char(5), 'DM_UNDELIVERABLE', 'the blocked account cannot write to the blocker');
SELECT throws_ok($q$SELECT public.start_dm_call_message('77777777-0000-0000-0000-000000000007', 'voice')$q$,
                 'P0001'::char(5), 'DM_UNDELIVERABLE', 'or post a call notice there');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(pg_temp.dm('11111111-0000-0000-0000-000000000001', 'to the blocked'),
                 'P0001'::char(5), 'DM_UNDELIVERABLE', 'the blocker cannot write to the account it blocked');
SELECT throws_ok($q$SELECT public.start_dm_call_message('77777777-0000-0000-0000-000000000007', 'video')$q$,
                 'P0001'::char(5), 'DM_UNDELIVERABLE', 'or post a call notice there');
SELECT is(public.create_or_get_direct_conversation('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002'),
          '77777777-0000-0000-0000-000000000007'::uuid, 'the conversation they hold still opens');
SELECT isnt_empty($q$SELECT 1 FROM public.messages WHERE id = '99999999-0000-0000-0000-000000000009'$q$,
                  'with its history');
RESET ROLE;
SELECT tests.clear_authentication();
SET LOCAL role service_role;
SELECT throws_ok(pg_temp.dm('22222222-0000-0000-0000-000000000002', 'federated'),
                 'P0001'::char(5), 'DM_UNDELIVERABLE', 'a write by the service role is refused the same');
RESET ROLE;
SELECT lives_ok($q$INSERT INTO public.messages (conversation_id, content, is_system, metadata)
                   VALUES ('77777777-0000-0000-0000-000000000007', '[{"type":"text","text":"ended"}]', true,
                           '{"type": "call_ended"}')$q$,
                'an authorless row passes');

-- New conversations ----------------------------------------------------------------------------------
INSERT INTO public.user_blocks (blocker_id, blocked_user_id)
VALUES ('33333333-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000002');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.create_or_get_direct_conversation('22222222-0000-0000-0000-000000000002', '33333333-0000-0000-0000-000000000003')$q$,
                 'P0001'::char(5), 'DM_NOT_ALLOWED', 'the blocked account cannot open a conversation with the blocker');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.create_or_get_direct_conversation('33333333-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000002')$q$,
                 'P0001'::char(5), 'DM_NOT_ALLOWED', 'nor the blocker one with the account it blocked');
RESET ROLE;
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.conversation_participants WHERE user_id = '33333333-0000-0000-0000-000000000003'), 0,
          'and no conversation is left behind');
INSERT INTO public.user_blocks (blocker_id, blocked_user_id)
VALUES ('c2651000-0000-0000-0000-00000000000c', '11111111-0000-0000-0000-000000000001');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.create_or_get_direct_conversation('11111111-0000-0000-0000-000000000001', 'c2651000-0000-0000-0000-00000000000c')$q$,
                 'P0001'::char(5), 'DM_NOT_ALLOWED', 'a block holds for an instance admin');
RESET ROLE;
SELECT tests.clear_authentication();
DELETE FROM public.user_blocks WHERE blocker_id = 'c2651000-0000-0000-0000-00000000000c';

-- Groups ---------------------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.create_group_conversation('22222222-0000-0000-0000-000000000002',
                        ARRAY['11111111-0000-0000-0000-000000000001', 'c2651000-0000-0000-0000-00000000000c']::uuid[], 'g', true)$q$,
                 'P0001'::char(5), 'DM_NOT_ALLOWED', 'the blocked account cannot put the blocker in a new group');
SELECT throws_ok($q$SELECT public.add_user_to_conversation('c2652000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001')$q$,
                 'P0001'::char(5), 'DM_NOT_ALLOWED', 'or back into a group the blocker left');
SELECT lives_ok(pg_temp.group_msg('c2652000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002'),
                'the blocked account writes in a group the blocker is in');
SELECT lives_ok($q$SELECT public.start_dm_call_message('c2652000-0000-0000-0000-000000000001', 'voice')$q$,
                'and posts a call notice there');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.create_group_conversation('11111111-0000-0000-0000-000000000001',
                        ARRAY['22222222-0000-0000-0000-000000000002']::uuid[], 'g', true)$q$,
                 'P0001'::char(5), 'DM_NOT_ALLOWED', 'the blocker cannot put the account it blocked in a new group');
SELECT lives_ok(pg_temp.group_msg('c2652000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001'),
                'the blocker writes in the group they share');
SELECT tests.authenticate_as('c2650000-0000-0000-0000-00000000000c');
SELECT lives_ok($q$SELECT public.add_user_to_conversation('c2652000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001')$q$,
                'a third member adds the blocker back');
RESET ROLE;
SELECT tests.clear_authentication();

-- Federation -----------------------------------------------------------------------------------------
SET LOCAL role service_role;
SELECT is(public.dm_recipients_allowing('22222222-0000-0000-0000-000000000002',
              ARRAY['11111111-0000-0000-0000-000000000001', 'c2651000-0000-0000-0000-00000000000c']::uuid[]),
          ARRAY['c2651000-0000-0000-0000-00000000000c']::uuid[], 'a sender reaches no recipient that blocks it');
SELECT is(public.dm_recipients_allowing('11111111-0000-0000-0000-000000000001', ARRAY['22222222-0000-0000-0000-000000000002']::uuid[]),
          '{}'::uuid[], 'nor one it blocks');
RESET ROLE;

-- Unblock --------------------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$DELETE FROM public.user_blocks
                    WHERE blocker_id = '11111111-0000-0000-0000-000000000001' AND blocked_user_id = '22222222-0000-0000-0000-000000000002'$q$,
                'alice unblocks bob');
SELECT lives_ok(pg_temp.dm('11111111-0000-0000-0000-000000000001', 'hello again'), 'alice writes to bob');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(pg_temp.dm('22222222-0000-0000-0000-000000000002', 'hello back'), 'bob writes to alice');
SELECT lives_ok($q$SELECT public.start_dm_call_message('77777777-0000-0000-0000-000000000007', 'voice')$q$,
                'and calls her');
RESET ROLE;
SELECT tests.clear_authentication();
SET LOCAL role service_role;
SELECT is(public.dm_recipients_allowing('22222222-0000-0000-0000-000000000002', ARRAY['11111111-0000-0000-0000-000000000001']::uuid[]),
          ARRAY['11111111-0000-0000-0000-000000000001']::uuid[], 'a federated DM reaches alice again');
RESET ROLE;
INSERT INTO public.user_blocks (blocker_id, blocked_user_id, expires_at)
VALUES ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', now() - interval '1 minute');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(pg_temp.dm('22222222-0000-0000-0000-000000000002', 'after expiry'), 'an expired block refuses nothing');
RESET ROLE;
SELECT tests.clear_authentication();

SELECT is((SELECT count(*)::int FROM public.messages
            WHERE conversation_id = '77777777-0000-0000-0000-000000000007'
              AND content::text LIKE '%to the block%'), 0, 'no refused message was stored');

SELECT * FROM finish();
ROLLBACK;
