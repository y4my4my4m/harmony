-- Welcome server suggestion, server welcome screens and rules acceptance after
-- 20261006300001_welcome_server_and_rules.sql.
--
-- Fixture server_1: alice owns it and is an instance admin, bob is a member who joined a day
-- ago, mallory is not a member, banned holds a banned row. Added here:
--   carol    joins server_1 inside this transaction
--   dave     joins server_1 inside this transaction and holds MANAGE_SERVER there
--   erin     member of nothing, for the onboarding suggestion
--   frank    joins server_1 inside this transaction, for enforcement on and off
--   hall     public local server, the welcome server
--   feat1-4  featured public local servers, featured_order 2, 1, 3, 4
--   featpriv featured, not public
--   remote   featured, public, remote
--   own      local server alice owns with no membership row and no welcome screen

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(83);

UPDATE public.profiles SET is_admin = true WHERE id = '11111111-0000-0000-0000-000000000001';
UPDATE public.profiles SET is_admin = false WHERE id <> '11111111-0000-0000-0000-000000000001';
UPDATE public.user_servers SET created_at = now() - interval '1 day'
 WHERE server_id = '55555555-0000-0000-0000-000000000005';

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('c6300000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol63@test.local'),
  ('c6300000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'dave63@test.local'),
  ('c6300000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'erin63@test.local'),
  ('c6300000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'frank63@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('63000000-0000-0000-0000-0000000000c1', 'c6300000-0000-0000-0000-0000000000a1', 'carol63', 'Carol', true),
  ('63000000-0000-0000-0000-0000000000c2', 'c6300000-0000-0000-0000-0000000000a2', 'dave63', 'Dave', true),
  ('63000000-0000-0000-0000-0000000000c3', 'c6300000-0000-0000-0000-0000000000a3', 'erin63', 'Erin', true),
  ('63000000-0000-0000-0000-0000000000c4', 'c6300000-0000-0000-0000-0000000000a4', 'frank63', 'Frank', true);

INSERT INTO public.servers (id, name, owner, public, is_local_server, is_featured, featured_order) VALUES
  ('63000000-0000-0000-0000-0000000005a1', 'Town Hall', '11111111-0000-0000-0000-000000000001', true, true, false, 0),
  ('63000000-0000-0000-0000-0000000005f1', 'Feat One', '22222222-0000-0000-0000-000000000002', true, true, true, 2),
  ('63000000-0000-0000-0000-0000000005f2', 'Feat Two', '22222222-0000-0000-0000-000000000002', true, true, true, 1),
  ('63000000-0000-0000-0000-0000000005f3', 'Feat Three', '22222222-0000-0000-0000-000000000002', true, true, true, 3),
  ('63000000-0000-0000-0000-0000000005f4', 'Feat Four', '22222222-0000-0000-0000-000000000002', true, true, true, 4),
  ('63000000-0000-0000-0000-0000000005f5', 'Feat Private', '22222222-0000-0000-0000-000000000002', false, true, true, 0),
  ('63000000-0000-0000-0000-0000000005e1', 'Elsewhere', '22222222-0000-0000-0000-000000000002', true, false, true, 0),
  ('63000000-0000-0000-0000-0000000005b1', 'Own', '11111111-0000-0000-0000-000000000001', false, true, false, 0);
UPDATE public.servers SET rules = '["Be kind", "No spam"]' WHERE id = '63000000-0000-0000-0000-0000000005b1';

INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('22222222-0000-0000-0000-000000000002', '63000000-0000-0000-0000-0000000005a1', 'accepted'),
  ('63000000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('63000000-0000-0000-0000-0000000000c2', '55555555-0000-0000-0000-000000000005', 'accepted'),
  ('63000000-0000-0000-0000-0000000000c4', '55555555-0000-0000-0000-000000000005', 'accepted');
-- Production's server_bans belongs to supabase_admin and postgres cannot write it; a banned
-- membership row stands in there.
DO $$
BEGIN
    IF has_table_privilege('public.server_bans', 'INSERT') THEN
        INSERT INTO public.server_bans (server_id, user_id, banned_by)
        VALUES ('63000000-0000-0000-0000-0000000005a1', '33333333-0000-0000-0000-000000000003',
                '11111111-0000-0000-0000-000000000001');
    ELSE
        INSERT INTO public.user_servers (user_id, server_id, status)
        VALUES ('33333333-0000-0000-0000-000000000003', '63000000-0000-0000-0000-0000000005a1', 'banned');
    END IF;
END;
$$;

-- MANAGE_SERVER is bit 7.
INSERT INTO public.server_roles (id, server_id, name, permissions)
VALUES ('63000000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005', 'Managers', 1::bigint << 7);
INSERT INTO public.user_roles (user_id, role_id, server_id)
VALUES ('63000000-0000-0000-0000-0000000000c2', '63000000-0000-0000-0000-0000000000d1', '55555555-0000-0000-0000-000000000005');

INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by)
VALUES ('63000000-0000-0000-0000-0000000000e1', '66666666-0000-0000-0000-000000000006',
        '88888888-0000-0000-0000-000000000008', 'Plans', '11111111-0000-0000-0000-000000000001');

INSERT INTO public.conversations (id, type, created_by)
VALUES ('63000000-0000-0000-0000-0000000000f1', 'direct', '63000000-0000-0000-0000-0000000000c1');
INSERT INTO public.conversation_participants (conversation_id, user_id, joined_at) VALUES
  ('63000000-0000-0000-0000-0000000000f1', '63000000-0000-0000-0000-0000000000c1', now()),
  ('63000000-0000-0000-0000-0000000000f1', '11111111-0000-0000-0000-000000000001', now());

CREATE FUNCTION pg_temp.post_system_definer(p_user uuid) RETURNS void LANGUAGE sql SECURITY DEFINER AS $fn$
  INSERT INTO public.messages (channel_id, user_id, content, is_system, metadata)
  VALUES ('66666666-0000-0000-0000-000000000006', p_user,
          '[{"type":"text","text":"has joined the server"}]', true, '{"type":"member_join"}');
$fn$;
GRANT EXECUTE ON FUNCTION pg_temp.post_system_definer(uuid) TO authenticated;

-- Surface -------------------------------------------------------------------------------
SELECT ok(NOT has_table_privilege('authenticated', 'public.server_welcome_screens', 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.server_welcome_screens', 'INSERT')
          AND NOT has_table_privilege('authenticated', 'public.server_welcome_screens', 'UPDATE')
          AND NOT has_table_privilege('anon', 'public.server_welcome_screens', 'SELECT'),
          'clients hold no privileges on server_welcome_screens');
SELECT is_empty(
    $q$SELECT p.oid::regprocedure FROM pg_proc p
        WHERE p.pronamespace = 'public'::regnamespace
          AND p.proname IN ('guard_user_server_welcome_columns', 'keep_welcome_managed_server_rules',
                            'enforce_server_rules_acceptance')
          AND (has_function_privilege('anon', p.oid, 'EXECUTE')
               OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))$q$,
    'clients hold no EXECUTE on the welcome triggers');
SELECT ok(has_function_privilege('authenticated', 'public.get_server_welcome(uuid)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.set_server_welcome(uuid, boolean, text, jsonb, boolean)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.mark_server_welcome_seen(uuid)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.accept_server_rules(uuid)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.set_welcome_server(uuid)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.get_onboarding_servers()', 'EXECUTE')
          AND has_function_privilege('anon', 'public.get_onboarding_servers()', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.set_welcome_server(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.set_server_welcome(uuid, boolean, text, jsonb, boolean)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.get_server_welcome(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.accept_server_rules(uuid)', 'EXECUTE'),
          'welcome RPCs: authenticated only, except the onboarding read');
SELECT ok('welcome_server_id' = ANY (public.public_instance_config_keys()), 'welcome_server_id is a public instance key');
SELECT ok('instance_rules' = ANY (public.public_instance_config_keys())
          AND 'gif_ai_emoji_generation_enabled' = ANY (public.public_instance_config_keys()),
          'the existing public keys remain');

-- Instance welcome server: who sets it --------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.set_welcome_server('63000000-0000-0000-0000-0000000005a1')$q$,
                 '42501', NULL, 'a non-admin cannot set the welcome server');
SELECT throws_ok(
    $q$INSERT INTO public.instance_config (config_key, config_value)
       VALUES ('welcome_server_id', '"63000000-0000-0000-0000-0000000005f1"')$q$,
    '42501', NULL, 'a client cannot insert the key directly');

SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.set_welcome_server('63000000-0000-0000-0000-0000000005a1')$q$,
                 '42501', NULL, 'anon cannot set the welcome server');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.set_welcome_server('55555555-0000-0000-0000-000000000005')$q$,
                 '22023', NULL, 'a private server cannot be the welcome server');
SELECT throws_ok($q$SELECT public.set_welcome_server('63000000-0000-0000-0000-0000000005e1')$q$,
                 '22023', NULL, 'a remote server cannot be the welcome server');
SELECT lives_ok($q$SELECT public.set_welcome_server('63000000-0000-0000-0000-0000000005a1')$q$,
                'an instance admin sets the welcome server');
SELECT tests.clear_authentication();
SELECT ok(EXISTS (SELECT 1 FROM public.admin_audit_log
                   WHERE action_type = 'set_welcome_server' AND target_id = 'welcome_server_id'),
          'setting the welcome server is audited');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
UPDATE public.instance_config SET config_value = '"63000000-0000-0000-0000-0000000005f1"'
 WHERE config_key = 'welcome_server_id';
SELECT tests.clear_authentication();
SELECT is((SELECT config_value #>> '{}' FROM public.instance_config WHERE config_key = 'welcome_server_id'),
          '63000000-0000-0000-0000-0000000005a1', 'a client UPDATE of the key changes nothing');

-- Instance welcome server: public read and suggestions ----------------------------------
SELECT tests.authenticate_as_anon();
SELECT is((SELECT config_value #>> '{}' FROM public.instance_config WHERE config_key = 'welcome_server_id'),
          '63000000-0000-0000-0000-0000000005a1', 'anon reads welcome_server_id');
SELECT is(public.get_onboarding_servers() #>> '{servers,0,id}', '63000000-0000-0000-0000-0000000005a1',
          'anon is suggested the welcome server');

SELECT tests.authenticate_as('c6300000-0000-0000-0000-0000000000a3');
SELECT is(public.get_onboarding_servers() ->> 'source', 'welcome', 'a newcomer gets the welcome server');
SELECT is(jsonb_array_length(public.get_onboarding_servers() -> 'servers'), 1, 'and only it');
SELECT is((public.get_onboarding_servers() #>> '{servers,0,member_count}')::int, 1,
          'with its accepted member count');
SELECT is(public.get_onboarding_servers() #>> '{servers,0,name}', 'Town Hall', 'and its name');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.get_onboarding_servers(), '{"source": "welcome", "servers": []}'::jsonb,
          'a member of the welcome server is suggested nothing');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.get_onboarding_servers(), '{"source": "welcome", "servers": []}'::jsonb,
          'a user banned from the welcome server is suggested nothing');

SELECT tests.clear_authentication();
UPDATE public.servers SET public = false WHERE id = '63000000-0000-0000-0000-0000000005a1';
SELECT tests.authenticate_as('c6300000-0000-0000-0000-0000000000a3');
SELECT is(public.get_onboarding_servers() ->> 'source', 'featured',
          'a welcome server that is no longer public reads as unset');
SELECT is((SELECT array_agg(e ->> 'id' ORDER BY o) FROM jsonb_array_elements(public.get_onboarding_servers() -> 'servers')
                                                         WITH ORDINALITY AS x(e, o)),
          ARRAY['63000000-0000-0000-0000-0000000005f2', '63000000-0000-0000-0000-0000000005f1',
                '63000000-0000-0000-0000-0000000005f3'],
          'the fallback is the first three featured public local servers by featured_order');

SELECT tests.clear_authentication();
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('63000000-0000-0000-0000-0000000000c3', '63000000-0000-0000-0000-0000000005f2', 'accepted');
SELECT tests.authenticate_as('c6300000-0000-0000-0000-0000000000a3');
SELECT is((SELECT array_agg(e ->> 'id' ORDER BY o) FROM jsonb_array_elements(public.get_onboarding_servers() -> 'servers')
                                                         WITH ORDINALITY AS x(e, o)),
          ARRAY['63000000-0000-0000-0000-0000000005f1', '63000000-0000-0000-0000-0000000005f3',
                '63000000-0000-0000-0000-0000000005f4'],
          'featured servers the caller belongs to are skipped');

SELECT tests.clear_authentication();
DELETE FROM public.servers WHERE id = '63000000-0000-0000-0000-0000000005a1';
SELECT tests.authenticate_as('c6300000-0000-0000-0000-0000000000a3');
SELECT is(public.get_onboarding_servers() ->> 'source', 'featured', 'a deleted welcome server reads as unset');

SELECT tests.clear_authentication();
UPDATE public.servers SET is_featured = false WHERE is_featured;
SELECT tests.authenticate_as('c6300000-0000-0000-0000-0000000000a3');
SELECT is(public.get_onboarding_servers(), '{"source": "none", "servers": []}'::jsonb,
          'nothing is suggested without a welcome server or featured servers');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.set_welcome_server(NULL)$q$, 'an instance admin clears the welcome server');
SELECT tests.authenticate_as_anon();
SELECT is((SELECT jsonb_typeof(config_value) FROM public.instance_config WHERE config_key = 'welcome_server_id'),
          'null', 'a cleared welcome server reads as JSON null');

-- Server welcome screen: who configures it ----------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$SELECT public.set_server_welcome('55555555-0000-0000-0000-000000000005', true, 'hi', '[]', false)$q$,
    '42501', NULL, 'a member without MANAGE_SERVER cannot configure the screen');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.get_server_welcome('55555555-0000-0000-0000-000000000005')$q$,
                 '42501', NULL, 'a non-member cannot read the screen');
SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT throws_ok($q$SELECT public.get_server_welcome('55555555-0000-0000-0000-000000000005')$q$,
                 '42501', NULL, 'a banned user cannot read the screen');
SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.get_server_welcome('55555555-0000-0000-0000-000000000005')$q$,
                 '42501', NULL, 'anon cannot read the screen');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$SELECT public.set_server_welcome('63000000-0000-0000-0000-0000000005e1', true, 'hi', '[]', false)$q$,
    '42501', NULL, 'a remote server is configured on its home instance');
SELECT is(public.get_server_welcome('63000000-0000-0000-0000-0000000005b1') -> 'rules',
          '[{"title": "Be kind", "description": ""}, {"title": "No spam", "description": ""}]'::jsonb,
          'without a screen the rules are servers.rules');
SELECT throws_ok(
    format($q$SELECT public.set_server_welcome('55555555-0000-0000-0000-000000000005', true, 'hi', %L, false)$q$,
           (SELECT jsonb_agg(jsonb_build_object('title', 'rule ' || g)) FROM generate_series(1, 21) g)),
    '22023', NULL, 'at most 20 rules');
SELECT throws_ok(
    $q$SELECT public.set_server_welcome('55555555-0000-0000-0000-000000000005', true, 'hi', '[{"title": "  "}]', false)$q$,
    '22023', NULL, 'every rule has a title');
SELECT throws_ok(
    format($q$SELECT public.set_server_welcome('55555555-0000-0000-0000-000000000005', true, 'hi', %L, false)$q$,
           jsonb_build_array(jsonb_build_object('title', repeat('x', 101)))),
    '22023', NULL, 'rule titles are limited to 100 characters');
SELECT throws_ok(
    format($q$SELECT public.set_server_welcome('55555555-0000-0000-0000-000000000005', true, %L, '[]', false)$q$,
           repeat('x', 2001)),
    '22023', NULL, 'the message is limited to 2000 characters');
SELECT throws_ok(
    $q$SELECT public.set_server_welcome('55555555-0000-0000-0000-000000000005', true, 'hi', '[]', true)$q$,
    '22023', NULL, 'requiring acceptance needs a rule');

SELECT tests.authenticate_as('c6300000-0000-0000-0000-0000000000a2');
SELECT lives_ok(
    $q$SELECT public.set_server_welcome('55555555-0000-0000-0000-000000000005', true, '  Welcome to **Test**!  ',
           '[{"title": "Be kind", "description": "No personal attacks."}, "No spam"]', false)$q$,
    'a MANAGE_SERVER holder configures the screen');
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT enabled, message, rules, require_acceptance, enabled_at IS NOT NULL, acceptance_required_at IS NULL
         FROM public.server_welcome_screens WHERE server_id = '55555555-0000-0000-0000-000000000005'$q$,
    $q$VALUES (true, 'Welcome to **Test**!',
               '[{"title": "Be kind", "description": "No personal attacks."}, {"title": "No spam", "description": ""}]'::jsonb,
               false, true, true)$q$,
    'the screen is stored trimmed and normalized');
SELECT is((SELECT rules FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005'),
          '["Be kind", "No spam"]'::jsonb, 'rule titles are copied to servers.rules');

-- Owner requires acceptance.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$SELECT public.set_server_welcome('55555555-0000-0000-0000-000000000005', true, 'Welcome to **Test**!',
           '[{"title": "Be kind", "description": "No personal attacks."}, {"title": "No spam"}]', true)$q$,
    'the owner requires acceptance');
SELECT tests.clear_authentication();
SELECT ok((SELECT acceptance_required_at = now() FROM public.server_welcome_screens
            WHERE server_id = '55555555-0000-0000-0000-000000000005'),
          'acceptance_required_at is the moment acceptance was turned on');

-- servers.rules follows the screen.
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
UPDATE public.servers SET rules = '["stale"]', description = 'edited'
 WHERE id = '55555555-0000-0000-0000-000000000005';
UPDATE public.servers SET rules = '["Be nice"]' WHERE id = '63000000-0000-0000-0000-0000000005b1';
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT rules, description FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005'$q$,
    $q$VALUES ('["Be kind", "No spam"]'::jsonb, 'edited'::text)$q$,
    'a client UPDATE keeps the screen''s rules and applies the rest');
SELECT is((SELECT rules FROM public.servers WHERE id = '63000000-0000-0000-0000-0000000005b1'),
          '["Be nice"]'::jsonb, 'a server without a screen keeps client-edited rules');

-- What members see -----------------------------------------------------------------------
SELECT tests.authenticate_as('c6300000-0000-0000-0000-0000000000a1');
SELECT results_eq(
    $q$SELECT (w ->> 'enabled')::boolean, w ->> 'message', jsonb_array_length(w -> 'rules'),
              (w ->> 'must_accept')::boolean, (w ->> 'should_show')::boolean, (w ->> 'can_manage')::boolean
         FROM public.get_server_welcome('55555555-0000-0000-0000-000000000005') w$q$,
    $q$VALUES (true, 'Welcome to **Test**!', 2, true, true, false)$q$,
    'a member who joined after acceptance was required must accept and is shown the screen');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT results_eq(
    $q$SELECT (w ->> 'must_accept')::boolean, (w ->> 'should_show')::boolean
         FROM public.get_server_welcome('55555555-0000-0000-0000-000000000005') w$q$,
    $q$VALUES (false, false)$q$,
    'a member who joined before is grandfathered and not shown the screen');

SELECT tests.authenticate_as('c6300000-0000-0000-0000-0000000000a2');
SELECT results_eq(
    $q$SELECT (w ->> 'must_accept')::boolean, (w ->> 'can_manage')::boolean
         FROM public.get_server_welcome('55555555-0000-0000-0000-000000000005') w$q$,
    $q$VALUES (false, true)$q$,
    'a MANAGE_SERVER holder need not accept');

-- Enforcement ----------------------------------------------------------------------------
SELECT tests.authenticate_as('c6300000-0000-0000-0000-0000000000a1');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006', '63000000-0000-0000-0000-0000000000c1',
               '[{"type":"text","text":"hello"}]')$q$,
    'P0001', 'RULES_NOT_ACCEPTED:55555555-0000-0000-0000-000000000005',
    'a member who has not accepted cannot post');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, thread_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006', '63000000-0000-0000-0000-0000000000e1',
               '63000000-0000-0000-0000-0000000000c1', '[{"type":"text","text":"hello thread"}]')$q$,
    'P0001', 'RULES_NOT_ACCEPTED:55555555-0000-0000-0000-000000000005',
    'nor in a thread');
SELECT lives_ok(
    $q$INSERT INTO public.messages (conversation_id, user_id, content)
       VALUES ('63000000-0000-0000-0000-0000000000f1', '63000000-0000-0000-0000-0000000000c1',
               '[{"type":"text","text":"dm"}]')$q$,
    'direct messages are outside the check');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002',
               '[{"type":"text","text":"grandfathered"}]')$q$,
    'a grandfathered member posts');
SELECT tests.authenticate_as('c6300000-0000-0000-0000-0000000000a2');
SELECT lives_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006', '63000000-0000-0000-0000-0000000000c2',
               '[{"type":"text","text":"manager"}]')$q$,
    'a MANAGE_SERVER holder posts without accepting');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"owner"}]')$q$,
    'the owner posts');

SELECT tests.authenticate_as('c6300000-0000-0000-0000-0000000000a1');
SELECT lives_ok($q$SELECT pg_temp.post_system_definer('63000000-0000-0000-0000-0000000000c1')$q$,
                'a system row written by a definer function is not checked');
SELECT tests.clear_authentication();
GRANT USAGE ON SCHEMA tests TO service_role;
SET LOCAL role service_role;
SELECT lives_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006', '63000000-0000-0000-0000-0000000000c1',
               '[{"type":"text","text":"via federation"}]')$q$,
    'service_role writes (federation, bot-gateway) are not checked');
RESET role;

-- Clients cannot write the acknowledgements ------------------------------------------------
SELECT tests.authenticate_as('c6300000-0000-0000-0000-0000000000a1');
SELECT throws_ok(
    $q$UPDATE public.user_servers SET rules_accepted_at = now()
        WHERE user_id = '63000000-0000-0000-0000-0000000000c1'
          AND server_id = '55555555-0000-0000-0000-000000000005'$q$,
    '42501', NULL, 'a member cannot accept the rules by UPDATE');
SELECT throws_ok(
    $q$UPDATE public.user_servers SET welcome_seen_at = now()
        WHERE user_id = '63000000-0000-0000-0000-0000000000c1'
          AND server_id = '55555555-0000-0000-0000-000000000005'$q$,
    '42501', NULL, 'a member cannot mark the screen seen by UPDATE');
SELECT lives_ok(
    $q$UPDATE public.user_servers SET position = 3
        WHERE user_id = '63000000-0000-0000-0000-0000000000c1'
          AND server_id = '55555555-0000-0000-0000-000000000005'$q$,
    'other membership columns stay writable');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$UPDATE public.user_servers SET rules_accepted_at = now()
        WHERE user_id = '63000000-0000-0000-0000-0000000000c1'
          AND server_id = '55555555-0000-0000-0000-000000000005'$q$,
    '42501', NULL, 'the owner cannot accept for a member');
INSERT INTO public.user_servers (user_id, server_id, status, welcome_seen_at, rules_accepted_at)
VALUES ('11111111-0000-0000-0000-000000000001', '63000000-0000-0000-0000-0000000005b1', 'accepted', now(), now());
SELECT tests.clear_authentication();
SELECT results_eq(
    $q$SELECT welcome_seen_at, rules_accepted_at FROM public.user_servers
        WHERE user_id = '11111111-0000-0000-0000-000000000001'
          AND server_id = '63000000-0000-0000-0000-0000000005b1'$q$,
    $q$VALUES (NULL::timestamptz, NULL::timestamptz)$q$,
    'a client INSERT clears the acknowledgements');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT * FROM public.server_welcome_screens$q$, '42501', NULL,
                 'a client cannot read server_welcome_screens');
SELECT throws_ok(
    $q$UPDATE public.server_welcome_screens SET require_acceptance = false$q$,
    '42501', NULL, 'a client cannot write server_welcome_screens');

-- Seen and accepted ------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.accept_server_rules('55555555-0000-0000-0000-000000000005')$q$,
                 '42501', NULL, 'a non-member cannot accept');
SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT throws_ok($q$SELECT public.mark_server_welcome_seen('55555555-0000-0000-0000-000000000005')$q$,
                 '42501', NULL, 'a banned user cannot mark the screen seen');

SELECT tests.authenticate_as('c6300000-0000-0000-0000-0000000000a1');
SELECT results_eq(
    $q$SELECT w ->> 'welcome_seen_at' IS NOT NULL, (w ->> 'should_show')::boolean, (w ->> 'must_accept')::boolean
         FROM public.mark_server_welcome_seen('55555555-0000-0000-0000-000000000005') w$q$,
    $q$VALUES (true, false, true)$q$,
    'marking the screen seen stops it showing and leaves acceptance pending');
SELECT results_eq(
    $q$SELECT w ->> 'rules_accepted_at' IS NOT NULL, (w ->> 'must_accept')::boolean
         FROM public.accept_server_rules('55555555-0000-0000-0000-000000000005') w$q$,
    $q$VALUES (true, false)$q$,
    'accepting records rules_accepted_at');
SELECT lives_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006', '63000000-0000-0000-0000-0000000000c1',
               '[{"type":"text","text":"accepted"}]')$q$,
    'a member who accepted posts');
SELECT tests.clear_authentication();
SELECT ok((SELECT rules_accepted_at IS NOT NULL AND welcome_seen_at IS NOT NULL FROM public.user_servers
            WHERE user_id = '63000000-0000-0000-0000-0000000000c1'
              AND server_id = '55555555-0000-0000-0000-000000000005'),
          'both acknowledgements are stored on the membership');

-- Enforcement on and off -------------------------------------------------------------------
SELECT tests.authenticate_as('c6300000-0000-0000-0000-0000000000a4');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006', '63000000-0000-0000-0000-0000000000c4',
               '[{"type":"text","text":"before"}]')$q$,
    'P0001', 'RULES_NOT_ACCEPTED:55555555-0000-0000-0000-000000000005',
    'frank must accept while acceptance is required');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$SELECT public.set_server_welcome('55555555-0000-0000-0000-000000000005', false, 'Welcome to **Test**!',
           '[{"title": "Be kind"}, {"title": "No spam"}]', false)$q$,
    'the owner turns acceptance and the screen off');
SELECT tests.clear_authentication();
SELECT ok((SELECT enabled_at IS NULL AND acceptance_required_at IS NULL FROM public.server_welcome_screens
            WHERE server_id = '55555555-0000-0000-0000-000000000005'),
          'turning the flags off clears their timestamps');
SELECT tests.authenticate_as('c6300000-0000-0000-0000-0000000000a4');
SELECT lives_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006', '63000000-0000-0000-0000-0000000000c4',
               '[{"type":"text","text":"after"}]')$q$,
    'with acceptance off, frank posts');
SELECT results_eq(
    $q$SELECT (w ->> 'enabled')::boolean, w ->> 'message', (w ->> 'should_show')::boolean, (w ->> 'must_accept')::boolean
         FROM public.get_server_welcome('55555555-0000-0000-0000-000000000005') w$q$,
    $q$VALUES (false, '', false, false)$q$,
    'a disabled screen is not shown and its message is hidden from members');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.get_server_welcome('55555555-0000-0000-0000-000000000005') ->> 'message', 'Welcome to **Test**!',
          'managers still read a disabled screen''s message');

-- Grandfathering follows the latest time acceptance was turned on.
SELECT lives_ok(
    $q$SELECT public.set_server_welcome('55555555-0000-0000-0000-000000000005', true, 'Welcome',
           '[{"title": "Be kind"}]', true)$q$,
    'the owner turns acceptance back on');
SELECT tests.clear_authentication();
UPDATE public.server_welcome_screens SET acceptance_required_at = now() - interval '2 hours'
 WHERE server_id = '55555555-0000-0000-0000-000000000005';
UPDATE public.user_servers SET created_at = now() - interval '3 hours'
 WHERE user_id = '63000000-0000-0000-0000-0000000000c4' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT tests.authenticate_as('c6300000-0000-0000-0000-0000000000a4');
SELECT lives_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006', '63000000-0000-0000-0000-0000000000c4',
               '[{"type":"text","text":"joined before"}]')$q$,
    'a member who joined before acceptance was turned on is grandfathered');
SELECT tests.clear_authentication();
UPDATE public.user_servers SET created_at = now() - interval '1 hour'
 WHERE user_id = '63000000-0000-0000-0000-0000000000c4' AND server_id = '55555555-0000-0000-0000-000000000005';
SELECT tests.authenticate_as('c6300000-0000-0000-0000-0000000000a4');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006', '63000000-0000-0000-0000-0000000000c4',
               '[{"type":"text","text":"joined after"}]')$q$,
    'P0001', 'RULES_NOT_ACCEPTED:55555555-0000-0000-0000-000000000005',
    'a member who joined after it is not');
SELECT is((public.get_server_welcome('55555555-0000-0000-0000-000000000005') ->> 'should_show')::boolean, true,
          'and is shown the screen while acceptance is pending');

-- Leaving and rejoining starts over.
SELECT tests.clear_authentication();
DELETE FROM public.user_servers
 WHERE user_id = '63000000-0000-0000-0000-0000000000c1' AND server_id = '55555555-0000-0000-0000-000000000005';
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('63000000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'accepted');
SELECT tests.authenticate_as('c6300000-0000-0000-0000-0000000000a1');
SELECT is((public.get_server_welcome('55555555-0000-0000-0000-000000000005') ->> 'must_accept')::boolean, true,
          'a member who left and rejoined accepts again');

SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.server_welcome_screens), 1, 'one screen was configured');
DELETE FROM public.servers WHERE id = '55555555-0000-0000-0000-000000000005';
SELECT is((SELECT count(*)::int FROM public.server_welcome_screens), 0, 'deleting the server deletes its screen');

SELECT * FROM finish();
ROLLBACK;
