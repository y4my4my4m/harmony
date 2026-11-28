-- A blocked account cannot read who blocks it, after 20261123500001_blocks_hidden_from_blocked.sql.
--
--   alice  blocks bob
--   bob    blocked by alice; member of server_1 with her
--   carol  c343 account, member of server_1, outside the block
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(18);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('c3430000-0000-0000-0000-00000000000c', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'carol343@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local) VALUES
  ('c3431000-0000-0000-0000-00000000000c', 'c3430000-0000-0000-0000-00000000000c', 'carol343', 'Carol', true);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('c3431000-0000-0000-0000-00000000000c', '55555555-0000-0000-0000-000000000005', 'accepted');

INSERT INTO public.posts (id, author_id, content, visibility) VALUES
  ('c3432000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
   '[{"type":"text","text":"by alice"}]'::jsonb, 'public'),
  ('c3432000-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002',
   '[{"type":"text","text":"by bob"}]'::jsonb, 'public');

INSERT INTO public.user_blocks (blocker_id, blocked_user_id) VALUES
  ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002');

-- The row ----------------------------------------------------------------------------------------
SELECT policies_are('public', 'user_blocks',
    ARRAY['user_blocks_select_own', 'user_blocks_insert_own', 'user_blocks_delete_own'],
    'user_blocks keeps the blocker''s own policies and no other');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is_empty($q$SELECT 1 FROM public.user_blocks$q$,
    'the blocked account reads no block naming it');
SELECT is_empty(
    $q$SELECT 1 FROM public.user_blocks WHERE blocker_id = '11111111-0000-0000-0000-000000000001'$q$,
    'not even by the blocker''s id');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT array_agg(blocked_user_id) FROM public.user_blocks),
          ARRAY['22222222-0000-0000-0000-000000000002'::uuid], 'the blocker reads its own block');
SELECT tests.clear_authentication();

-- The helpers ------------------------------------------------------------------------------------
SELECT hasnt_function('public', 'is_blocked_by', ARRAY['uuid'], 'no RPC answers is_blocked_by');
SELECT hasnt_function('public', 'current_user_block_peer_ids', ARRAY[]::text[],
    'no RPC answers current_user_block_peer_ids');
SELECT ok(has_function_privilege('authenticated', 'harmony_private.is_blocked_by(uuid)', 'EXECUTE')
          AND has_function_privilege('anon', 'harmony_private.current_user_block_peer_ids()', 'EXECUTE')
          AND has_schema_privilege('anon', 'harmony_private', 'USAGE'),
          'policies, which run as the querying role, still reach both helpers');
SELECT ok(NOT has_schema_privilege('authenticated', 'harmony_private', 'CREATE')
          AND NOT has_function_privilege('public', 'harmony_private.is_blocked_by(uuid)', 'EXECUTE'),
          'the schema takes no objects from API roles and PUBLIC executes nothing in it');
SELECT is((SELECT array_agg(DISTINCT n.nspname::text) FROM pg_policy pol
             JOIN pg_depend d ON d.classid = 'pg_policy'::regclass AND d.objid = pol.oid
             JOIN pg_proc p ON d.refclassid = 'pg_proc'::regclass AND p.oid = d.refobjid
             JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE p.proname IN ('is_blocked_by', 'current_user_block_peer_ids')),
          ARRAY['harmony_private'], 'every policy calling them follows them to harmony_private');

-- What the block still does ----------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is_empty($q$SELECT 1 FROM public.posts WHERE id = 'c3432000-0000-0000-0000-000000000001'$q$,
    'the blocked account does not read the blocker''s post');
SELECT throws_ok(
    $q$INSERT INTO public.reactions (message_id, user_id, custom_emoji_content)
       VALUES ('88888888-0000-0000-0000-000000000008', '22222222-0000-0000-0000-000000000002', '👍')$q$,
    '42501', NULL, 'nor reacts to the blocker''s message');
SELECT throws_ok(
    $q$INSERT INTO public.post_interactions (post_id, user_id, interaction_type)
       VALUES ('c3432000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', 'favorite')$q$,
    '42501', NULL, 'nor likes the blocker''s post');
SELECT lives_ok($q$SELECT public.get_today_summary(NULL)$q$,
    'Today, an invoker of the block set, runs for the blocked account');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is_empty($q$SELECT 1 FROM public.posts WHERE id = 'c3432000-0000-0000-0000-000000000002'$q$,
    'the blocker does not read the blocked account''s post');
SELECT lives_ok($q$SELECT public.get_today_summary(NULL)$q$, 'Today runs for the blocker');

SELECT tests.authenticate_as('c3430000-0000-0000-0000-00000000000c');
SELECT is((SELECT count(*)::int FROM public.posts
            WHERE id IN ('c3432000-0000-0000-0000-000000000001', 'c3432000-0000-0000-0000-000000000002')),
          2, 'an account outside the block reads both posts');
SELECT lives_ok(
    $q$INSERT INTO public.reactions (message_id, user_id, custom_emoji_content)
       VALUES ('88888888-0000-0000-0000-000000000008', 'c3431000-0000-0000-0000-00000000000c', '👍')$q$,
    'and is not refused a reaction by the policy');

SELECT tests.authenticate_as_anon();
SELECT is((SELECT count(*)::int FROM public.posts
            WHERE id IN ('c3432000-0000-0000-0000-000000000001', 'c3432000-0000-0000-0000-000000000002')),
          2, 'anon reads public posts through the helper');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
