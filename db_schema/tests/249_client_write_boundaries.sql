-- 20261109600001_client_write_boundaries.sql: client writes that name another entity, and
-- permission lookups about other people.
--
--   alice    owns server_1
--   bob      member of server_1
--   mallory  member of nothing; owns server M and a thread in it
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(42);

INSERT INTO public.servers (id, name, owner)
VALUES ('f2490000-0000-0000-0000-000000000001', 'Mallory''s', '33333333-0000-0000-0000-000000000003');
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('33333333-0000-0000-0000-000000000003', 'f2490000-0000-0000-0000-000000000001', 'accepted');
INSERT INTO public.channels (id, server_id, name, type)
VALUES ('f2490000-0000-0000-0000-000000000002', 'f2490000-0000-0000-0000-000000000001', 'hers', 0);
INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('f2490000-0000-0000-0000-000000000003', 'f2490000-0000-0000-0000-000000000002',
   '33333333-0000-0000-0000-000000000003', '[{"type":"text","text":"hers"}]'),
  ('f2490000-0000-0000-0000-000000000004', '66666666-0000-0000-0000-000000000006',
   '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"bob"}]'),
  ('f2490000-0000-0000-0000-000000000005', '66666666-0000-0000-0000-000000000006',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"alice two"}]');
INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by) VALUES
  ('f2491000-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006',
   '88888888-0000-0000-0000-000000000008', 'bob''s', '22222222-0000-0000-0000-000000000002'),
  ('f2491000-0000-0000-0000-000000000002', 'f2490000-0000-0000-0000-000000000002',
   'f2490000-0000-0000-0000-000000000003', 'hers', '33333333-0000-0000-0000-000000000003');
INSERT INTO public.conversations (id, type)
VALUES ('f2492000-0000-0000-0000-000000000001', 'group');
INSERT INTO public.conversation_participants (conversation_id, user_id)
VALUES ('f2492000-0000-0000-0000-000000000001', '33333333-0000-0000-0000-000000000003');
INSERT INTO public.bots (id, username, owner_id)
VALUES ('f2493000-0000-0000-0000-000000000001', 'bot249', '22222222-0000-0000-0000-000000000002');

-- Threads: what a channel manager and a creator may change. ---------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$UPDATE public.threads SET created_by = '11111111-0000-0000-0000-000000000001'
                     WHERE id = 'f2491000-0000-0000-0000-000000000001'$q$,
  '42501', NULL, 'the server owner cannot reassign a thread''s creator');
SELECT throws_ok($q$UPDATE public.threads SET ap_id = 'https://evil.example/threads/1'
                     WHERE id = 'f2491000-0000-0000-0000-000000000001'$q$,
  '42501', NULL, 'nor its federation id');
SELECT throws_ok($q$UPDATE public.threads SET federation_status = 'completed'
                     WHERE id = 'f2491000-0000-0000-0000-000000000001'$q$,
  '42501', NULL, 'nor its federation status');
SELECT throws_ok($q$UPDATE public.threads SET message_count = 999
                     WHERE id = 'f2491000-0000-0000-0000-000000000001'$q$,
  '42501', NULL, 'nor its counts');
SELECT throws_ok($q$UPDATE public.threads SET parent_message_id = 'f2490000-0000-0000-0000-000000000005'
                     WHERE id = 'f2491000-0000-0000-0000-000000000001'$q$,
  '42501', NULL, 'nor its parent message');
SELECT lives_ok($q$UPDATE public.threads
                      SET name = 'renamed', locked = true, archived = true, archived_at = now(), auto_archive_duration = 60
                    WHERE id = 'f2491000-0000-0000-0000-000000000001'$q$,
  'the owner changes name, lock, archive state and duration');
SELECT is((SELECT name FROM public.threads WHERE id = 'f2491000-0000-0000-0000-000000000001'),
  'renamed', 'and the row takes them');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$UPDATE public.threads SET name = 'mine again', locked = false
                    WHERE id = 'f2491000-0000-0000-0000-000000000001'$q$,
  'the creator changes the same columns');
SELECT throws_ok($q$UPDATE public.threads SET channel_id = 'f2490000-0000-0000-0000-000000000002'
                     WHERE id = 'f2491000-0000-0000-0000-000000000001'$q$,
  '42501', NULL, 'the creator cannot move a thread to another channel');
SELECT throws_ok($q$INSERT INTO public.threads (channel_id, parent_message_id, name, created_by)
                    VALUES ('66666666-0000-0000-0000-000000000006', 'f2490000-0000-0000-0000-000000000003',
                            'x', '22222222-0000-0000-0000-000000000002')$q$,
  '42501', NULL, 'a thread starts from a message of its channel');
SELECT lives_ok($q$INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by, ap_id, message_count)
                   VALUES ('f2491000-0000-0000-0000-000000000003', '66666666-0000-0000-0000-000000000006',
                           'f2490000-0000-0000-0000-000000000004', 'direct', '22222222-0000-0000-0000-000000000002',
                           'https://evil.example/threads/2', 50)$q$,
  'a direct insert from a message of the channel works');
SELECT tests.clear_authentication();
SELECT is((SELECT row(ap_id, message_count)::text FROM public.threads WHERE id = 'f2491000-0000-0000-0000-000000000003'),
  '(,0)', 'and takes no federation id or counts from the client');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$UPDATE public.threads SET channel_id = '66666666-0000-0000-0000-000000000006'
                     WHERE id = 'f2491000-0000-0000-0000-000000000002'$q$,
  '42501', NULL, 'a thread is not moved into a channel of another server');
SELECT tests.clear_authentication();

SELECT lives_ok($q$UPDATE public.threads SET message_count = 3, ap_id = 'https://harmony.test/threads/9'
                    WHERE id = 'f2491000-0000-0000-0000-000000000003'$q$,
  'the service path writes those columns');

-- Conversation membership. -------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$UPDATE public.conversation_participants SET conversation_id = '77777777-0000-0000-0000-000000000007'$q$,
  '42501', NULL, 'a participant row does not move into another conversation');
SELECT throws_ok($q$UPDATE public.conversation_participants SET user_id = '11111111-0000-0000-0000-000000000001'$q$,
  '42501', NULL, 'nor to another user');
SELECT lives_ok($q$UPDATE public.conversation_participants SET left_at = now()$q$, 'leaving still works');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM public.conversation_participants
            WHERE conversation_id = '77777777-0000-0000-0000-000000000007'),
  2, 'the direct conversation keeps its two participants');

-- Inbound dedupe ledger. ----------------------------------------------------------------------
SELECT ok(NOT has_table_privilege('authenticated', 'public.ap_activities', 'INSERT')
          AND NOT has_table_privilege('authenticated', 'public.ap_activities', 'UPDATE')
          AND NOT has_table_privilege('anon', 'public.ap_activities', 'INSERT'),
  'clients do not write ap_activities');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$INSERT INTO public.ap_activities (ap_id, ap_type, actor_id, actor_ap_id, status)
                    VALUES ('https://remote.test/a/planted', 'Follow', '33333333-0000-0000-0000-000000000003',
                            'https://remote.test/users/x', 'completed')$q$,
  '42501', NULL, 'an activity id cannot be planted');
SELECT tests.clear_authentication();
SELECT ok(NOT EXISTS (
  SELECT 1 FROM pg_proc p
   WHERE p.pronamespace = 'public'::regnamespace
     AND p.proname IN ('insert_ap_activity_outbound', 'get_default_channel', 'create_federated_profile',
                       'caller_reads_member_standing', 'current_user_reads_post')
     AND (has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
  'no client executes the functions closed here');
SELECT ok(EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ap_activities' AND cmd = 'SELECT'),
  'a user still reads their own activities');

-- Permission lookups. --------------------------------------------------------------------------
SELECT tests.authenticate_as_anon();
SELECT is(public.get_user_permissions('11111111-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005'),
  '{}'::jsonb, 'anon reads nobody''s permissions');
SELECT is(public.has_permission('11111111-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'VIEW_CHANNEL'),
  false, 'has_permission answers no to anon');
SELECT is(public.get_user_highest_role_position('11111111-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005'),
  0, 'nor can anon read the owner''s rank');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.get_user_permissions('11111111-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005'),
  '{}'::jsonb, 'a non-member reads no member''s permissions');
SELECT is(public.get_user_highest_role_position('11111111-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005'),
  0, 'nor their rank');
SELECT is(public.get_user_permissions('33333333-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005')->>'VIEW_CHANNEL',
  'false', 'a non-member reads their own, which is nothing');
SELECT is(public.get_user_permissions('33333333-0000-0000-0000-000000000003', 'f2490000-0000-0000-0000-000000000001',
                                      '66666666-0000-0000-0000-000000000006'),
  '{}'::jsonb, 'a channel of another server answers nothing');
SELECT is(public.has_permission('33333333-0000-0000-0000-000000000003', 'f2490000-0000-0000-0000-000000000001',
                                'VIEW_CHANNEL', 'f2490000-0000-0000-0000-000000000002'),
  true, 'an owner holds a channel of their server');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.get_user_permissions('11111111-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005')->>'VIEW_CHANNEL',
  'true', 'a member reads another member''s');
SELECT tests.clear_authentication();

UPDATE public.profiles SET is_moderator = true WHERE id = '33333333-0000-0000-0000-000000000003';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.get_user_permissions('11111111-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005')->>'VIEW_CHANNEL',
  'true', 'instance staff read a member''s');
SELECT tests.clear_authentication();
UPDATE public.profiles SET is_moderator = false WHERE id = '33333333-0000-0000-0000-000000000003';

-- Bot installs. -------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
INSERT INTO public.bot_server_permissions (bot_id, server_id, installed_by)
VALUES ('f2493000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002');
SELECT throws_ok($q$UPDATE public.bot_server_permissions SET installed_by = '22222222-0000-0000-0000-000000000002'
                     WHERE bot_id = 'f2493000-0000-0000-0000-000000000001'$q$,
  '42501', NULL, 'an installation keeps its installer');
SELECT tests.clear_authentication();
SELECT is((SELECT installed_by FROM public.bot_server_permissions WHERE bot_id = 'f2493000-0000-0000-0000-000000000001'),
  '11111111-0000-0000-0000-000000000001'::uuid, 'the installer is the caller, not the row''s claim');

-- Reactions. ----------------------------------------------------------------------------------
INSERT INTO public.posts (id, author_id, visibility, is_local, content) VALUES
  ('f2494000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'direct', true, '[{"type":"text","text":"direct"}]'),
  ('f2494000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 'public', true, '[{"type":"text","text":"public"}]'),
  ('f2494000-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000001', 'followers', true, '[{"type":"text","text":"followers"}]');
INSERT INTO public.follows (follower_id, following_id, status)
VALUES ('22222222-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 'accepted');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.add_post_emoji_reaction('33333333-0000-0000-0000-000000000003',
                      'f2494000-0000-0000-0000-000000000001', NULL, '🔥')$q$,
  'P0002', NULL, 'no reaction on a post the caller cannot read');
SELECT throws_ok($q$INSERT INTO public.post_interactions (user_id, post_id, interaction_type)
                    VALUES ('33333333-0000-0000-0000-000000000003', 'f2494000-0000-0000-0000-000000000003', 'favorite')$q$,
  '42501', NULL, 'nor a favourite');
SELECT isnt(public.add_post_emoji_reaction('33333333-0000-0000-0000-000000000003',
              'f2494000-0000-0000-0000-000000000002', NULL, '🔥'),
  NULL, 'a public post takes a reaction');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT isnt(public.add_post_emoji_reaction('22222222-0000-0000-0000-000000000002',
              'f2494000-0000-0000-0000-000000000003', NULL, '🔥'),
  NULL, 'a follower reacts to a followers-only post');
SELECT tests.clear_authentication();

-- current_user_reads_post mirrors posts_select_public, for every caller and post above.
GRANT EXECUTE ON FUNCTION public.current_user_reads_post(uuid) TO authenticated;
CREATE TEMP TABLE reads249 (ok boolean) ON COMMIT DROP;
GRANT ALL ON reads249 TO authenticated;
DO $do$
DECLARE
    a uuid;
    p uuid;
BEGIN
    FOREACH a IN ARRAY ARRAY['aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002',
                             'cccccccc-0000-0000-0000-000000000003']::uuid[] LOOP
        PERFORM tests.authenticate_as(a);
        FOREACH p IN ARRAY ARRAY['f2494000-0000-0000-0000-000000000001', 'f2494000-0000-0000-0000-000000000002',
                                 'f2494000-0000-0000-0000-000000000003']::uuid[] LOOP
            INSERT INTO reads249
            SELECT public.current_user_reads_post(p) = EXISTS (SELECT 1 FROM public.posts WHERE id = p);
        END LOOP;
        PERFORM tests.clear_authentication();
    END LOOP;
END;
$do$;
SELECT is((SELECT count(*)::int FROM reads249 WHERE ok), 9, 'current_user_reads_post agrees with RLS on the posts');

SELECT ok(bool_and(has_function_privilege(pg_get_userbyid(p.proowner), h.helper, 'EXECUTE')), 'the owner of ' || h.caller || ' executes ' || h.helper)
  FROM (VALUES
          ('get_user_permissions', 'public.caller_reads_member_standing(uuid, uuid)'),
          ('get_user_highest_role_position', 'public.caller_reads_member_standing(uuid, uuid)'),
          ('add_post_emoji_reaction', 'public.current_user_reads_post(uuid)')
       ) AS h(caller, helper)
  JOIN pg_proc p ON p.proname = h.caller AND p.pronamespace = 'public'::regnamespace
 GROUP BY h.caller, h.helper
 ORDER BY h.caller;

SELECT * FROM finish();
ROLLBACK;
