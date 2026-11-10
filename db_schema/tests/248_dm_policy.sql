-- Who can start a conversation, after 20261109200001_instance_write_limits.sql.
--
--   alice    instance admin, member of server_1 (fixture)
--   bob      member of server_1, holds a DM with alice (fixture)
--   mallory  in no server and no conversation
--   erin     c248 account, new; ivan c248 account, old
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(30);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('c2480000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'erin248@test.local'),
  ('c2480000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'ivan248@test.local'),
  ('c2480000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'nina248@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('c2481000-0000-0000-0000-00000000000a', 'c2480000-0000-0000-0000-00000000000a', 'erin248', 'Erin', true),
  ('c2481000-0000-0000-0000-00000000000b', 'c2480000-0000-0000-0000-00000000000b', 'ivan248', 'Ivan', true),
  ('c2481000-0000-0000-0000-00000000000c', 'c2480000-0000-0000-0000-00000000000c', 'nina248', 'Nina', true);
UPDATE public.profiles SET created_at = now() - interval '30 days' WHERE id = 'c2481000-0000-0000-0000-00000000000b';
INSERT INTO public.profiles (id, username, display_name, is_local, domain) VALUES
  ('c2481000-0000-0000-0000-00000000000d', 'rem248', 'Remote', false, 'remote248.example');

CREATE FUNCTION pg_temp.limits(p jsonb) RETURNS void LANGUAGE sql AS $$
  UPDATE public.instance_config SET config_value = config_value || p WHERE config_key = 'antispam';
$$;
CREATE FUNCTION pg_temp.policy(p_user uuid, p text) RETURNS void LANGUAGE sql AS $$
  UPDATE public.profiles SET dm_policy = p WHERE id = p_user;
$$;

SELECT is((SELECT dm_policy FROM public.profiles WHERE id = '22222222-0000-0000-0000-000000000002'), 'everyone',
          'every account starts at everyone');
SELECT throws_ok($q$UPDATE public.profiles SET dm_policy = 'nobody' WHERE id = '22222222-0000-0000-0000-000000000002'$q$,
                 '23514', NULL, 'an unknown setting is refused');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$UPDATE public.profiles SET dm_policy = 'known' WHERE id = '22222222-0000-0000-0000-000000000002'$q$,
                'an account sets its own');
SELECT is((SELECT dm_policy FROM public.profiles WHERE id = '22222222-0000-0000-0000-000000000002'), 'known', 'and it holds');
UPDATE public.profiles SET dm_policy = 'following' WHERE id = '33333333-0000-0000-0000-000000000003';
RESET ROLE;
SELECT tests.clear_authentication();
SELECT is((SELECT dm_policy FROM public.profiles WHERE id = '33333333-0000-0000-0000-000000000003'), 'everyone',
          'RLS keeps another account''s setting out of reach');
SELECT pg_temp.policy('22222222-0000-0000-0000-000000000002', 'everyone');

-- Relation -------------------------------------------------------------------------------------------
SELECT is(public.dm_relation('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002'), 'conversation',
          'a shared conversation comes first');
SELECT is(public.dm_relation('c2481000-0000-0000-0000-00000000000b', '33333333-0000-0000-0000-000000000003'), 'stranger',
          'nothing in common is a stranger');
INSERT INTO public.follows (follower_id, following_id, status) VALUES
    ('33333333-0000-0000-0000-000000000003', 'c2481000-0000-0000-0000-00000000000b', 'accepted');
SELECT is(public.dm_relation('c2481000-0000-0000-0000-00000000000b', '33333333-0000-0000-0000-000000000003'), 'following',
          'the recipient following the sender');
SELECT is(public.dm_relation('33333333-0000-0000-0000-000000000003', 'c2481000-0000-0000-0000-00000000000b'), 'stranger',
          'the sender following the recipient earns nothing');
INSERT INTO public.user_servers (server_id, user_id, status) VALUES
    ('55555555-0000-0000-0000-000000000005', 'c2481000-0000-0000-0000-00000000000a', 'accepted');
SELECT is(public.dm_relation('c2481000-0000-0000-0000-00000000000a', '22222222-0000-0000-0000-000000000002'), 'server',
          'a shared server');
SELECT is(public.dm_relation('44444444-0000-0000-0000-000000000004', '22222222-0000-0000-0000-000000000002'), 'stranger',
          'a banned member shares no server');

-- Setting --------------------------------------------------------------------------------------------
SELECT pg_temp.policy('22222222-0000-0000-0000-000000000002', 'following');
SELECT tests.authenticate_as('c2480000-0000-0000-0000-00000000000a');
SELECT throws_like($q$SELECT public.create_or_get_direct_conversation('c2481000-0000-0000-0000-00000000000a', '22222222-0000-0000-0000-000000000002')$q$,
                   'DM_NOT_ALLOWED', 'following refuses a server member');
RESET ROLE;
SELECT tests.clear_authentication();
SELECT pg_temp.policy('22222222-0000-0000-0000-000000000002', 'known');
SELECT tests.authenticate_as('c2480000-0000-0000-0000-00000000000a');
SELECT isnt(public.create_or_get_direct_conversation('c2481000-0000-0000-0000-00000000000a', '22222222-0000-0000-0000-000000000002'), NULL,
            'known admits a server member');
RESET ROLE;
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_like($q$SELECT public.create_or_get_direct_conversation('33333333-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000002')$q$,
                   'DM_NOT_ALLOWED', 'known refuses a stranger');
SELECT throws_like($q$SELECT public.create_group_conversation('33333333-0000-0000-0000-000000000003', ARRAY['22222222-0000-0000-0000-000000000002']::uuid[])$q$,
                   'DM_NOT_ALLOWED', 'in a new group as well');
RESET ROLE;
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::integer FROM public.conversations WHERE created_by = '33333333-0000-0000-0000-000000000003'), 0,
          'a refused group leaves nothing behind');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$SELECT public.create_or_get_direct_conversation('22222222-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001')$q$,
                'an existing conversation reopens, whatever the setting');
RESET ROLE;
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.create_or_get_direct_conversation('11111111-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003')$q$,
                'instance staff pass an everyone account');
SELECT pg_temp.policy('33333333-0000-0000-0000-000000000003', 'following');
RESET ROLE;
SELECT tests.clear_authentication();
UPDATE public.profiles SET dm_policy = 'following' WHERE id = 'c2481000-0000-0000-0000-00000000000c';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.create_or_get_direct_conversation('11111111-0000-0000-0000-000000000001', 'c2481000-0000-0000-0000-00000000000c')$q$,
                'and pass the strictest setting');
RESET ROLE;
SELECT tests.clear_authentication();

-- Adding to a group ----------------------------------------------------------------------------------
INSERT INTO public.conversations (id, type, created_by) VALUES
    ('c2482000-0000-0000-0000-000000000001', 'group', 'c2481000-0000-0000-0000-00000000000a');
INSERT INTO public.conversation_participants (conversation_id, user_id, role) VALUES
    ('c2482000-0000-0000-0000-000000000001', 'c2481000-0000-0000-0000-00000000000a', 'admin');
UPDATE public.profiles SET dm_policy = 'following' WHERE id = 'c2481000-0000-0000-0000-00000000000b';
SELECT tests.authenticate_as('c2480000-0000-0000-0000-00000000000a');
SELECT throws_like($q$SELECT public.add_user_to_conversation('c2482000-0000-0000-0000-000000000001', 'c2481000-0000-0000-0000-00000000000b')$q$,
                   'DM_NOT_ALLOWED', 'a group member cannot add someone whose setting refuses them');
RESET ROLE;
SELECT tests.clear_authentication();
UPDATE public.profiles SET dm_policy = 'everyone' WHERE id = 'c2481000-0000-0000-0000-00000000000b';

-- Rate -----------------------------------------------------------------------------------------------
SELECT pg_temp.limits('{"account_stranger_dms_per_hour": 2, "new_account_stranger_dms_per_hour": 1}');
DELETE FROM public.automod_recent_activity WHERE user_id = 'c2481000-0000-0000-0000-00000000000a';
UPDATE public.profiles SET dm_policy = 'everyone' WHERE id IN ('33333333-0000-0000-0000-000000000003', 'c2481000-0000-0000-0000-00000000000c');
SELECT tests.authenticate_as('c2480000-0000-0000-0000-00000000000a');
SELECT lives_ok($q$SELECT public.create_or_get_direct_conversation('c2481000-0000-0000-0000-00000000000a', '33333333-0000-0000-0000-000000000003')$q$,
                'a new account starts a conversation with a stranger');
SELECT throws_like($q$SELECT public.create_or_get_direct_conversation('c2481000-0000-0000-0000-00000000000a', 'c2481000-0000-0000-0000-00000000000c')$q$,
                   'ANTISPAM_RATE_LIMITED:%', 'the next stranger within the hour is refused');
SELECT throws_like($q$SELECT public.create_or_get_direct_conversation('c2481000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001')$q$,
                   'ANTISPAM_RATE_LIMITED:%', 'a new account counts someone sharing only a server');
RESET ROLE;
SELECT tests.clear_authentication();
UPDATE public.profiles SET created_at = now() - interval '30 days' WHERE id = 'c2481000-0000-0000-0000-00000000000a';
SELECT tests.authenticate_as('c2480000-0000-0000-0000-00000000000a');
SELECT lives_ok($q$SELECT public.create_or_get_direct_conversation('c2481000-0000-0000-0000-00000000000a', '11111111-0000-0000-0000-000000000001')$q$,
                'an established account does not count someone sharing a server');
RESET ROLE;
SELECT tests.clear_authentication();
UPDATE public.profiles SET created_at = now() WHERE id = 'c2481000-0000-0000-0000-00000000000a';
SELECT tests.authenticate_as('c2480000-0000-0000-0000-00000000000b');
SELECT lives_ok($q$SELECT public.create_or_get_direct_conversation('c2481000-0000-0000-0000-00000000000b', 'c2481000-0000-0000-0000-00000000000c'),
                          public.create_or_get_direct_conversation('c2481000-0000-0000-0000-00000000000b', '44444444-0000-0000-0000-000000000004')$q$,
                'an established account has the larger limit');
SELECT throws_like($q$SELECT public.create_or_get_direct_conversation('c2481000-0000-0000-0000-00000000000b', 'c2481000-0000-0000-0000-00000000000a')$q$,
                   'ANTISPAM_RATE_LIMITED:%', 'and reaches it too');
RESET ROLE;
SELECT tests.clear_authentication();

-- Federation -----------------------------------------------------------------------------------------
UPDATE public.profiles SET dm_policy = 'following' WHERE id = '33333333-0000-0000-0000-000000000003';
SELECT is(public.dm_recipients_allowing('c2481000-0000-0000-0000-00000000000d',
              ARRAY['33333333-0000-0000-0000-000000000003', 'c2481000-0000-0000-0000-00000000000c']::uuid[]),
          ARRAY['c2481000-0000-0000-0000-00000000000c']::uuid[],
          'a remote stranger reaches only those whose setting admits them');
INSERT INTO public.follows (follower_id, following_id, status) VALUES
    ('33333333-0000-0000-0000-000000000003', 'c2481000-0000-0000-0000-00000000000d', 'accepted');
SELECT cmp_ok(cardinality(public.dm_recipients_allowing('c2481000-0000-0000-0000-00000000000d',
              ARRAY['33333333-0000-0000-0000-000000000003']::uuid[])), '=', 1,
              'someone the recipient follows is admitted');
SELECT ok(has_function_privilege('service_role', 'public.dm_recipients_allowing(uuid, uuid[])', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.dm_recipients_allowing(uuid, uuid[])', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.dm_recipients_allowing(uuid, uuid[])', 'EXECUTE'),
          'only the service role asks');
SELECT ok(NOT has_function_privilege('authenticated', 'public.dm_relation(uuid, uuid)', 'EXECUTE'),
          'a client cannot read relations');

SELECT * FROM finish();
ROLLBACK;
