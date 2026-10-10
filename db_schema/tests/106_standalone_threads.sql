-- create_channel_thread after 20261010300001_standalone_threads.sql.
--
-- Fixture server_1: alice owns it, bob is a member, mallory is not. Channel general.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(14);

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');

SELECT lives_ok(
    $q$SELECT set_config('t.thread', public.create_channel_thread(
         '66666666-0000-0000-0000-000000000006', '  Plans for Friday  ')::text, true)$q$,
    'a member starts a thread with no message');

SELECT tests.clear_authentication();

SELECT is(
    (SELECT name FROM public.threads WHERE id = current_setting('t.thread')::uuid),
    'Plans for Friday', 'the name is trimmed');
SELECT is(
    (SELECT created_by FROM public.threads WHERE id = current_setting('t.thread')::uuid),
    '22222222-0000-0000-0000-000000000002'::uuid, 'the caller creates it');
SELECT is(
    (SELECT m.metadata ->> 'type' FROM public.threads t JOIN public.messages m ON m.id = t.parent_message_id
      WHERE t.id = current_setting('t.thread')::uuid),
    'thread_created', 'its parent is the started-a-thread notice');
SELECT ok(
    (SELECT m.is_system AND m.channel_id = '66666666-0000-0000-0000-000000000006'
            AND m.user_id = '22222222-0000-0000-0000-000000000002'
            AND m.metadata ->> 'thread_id' = current_setting('t.thread')
            AND (m.metadata ->> 'standalone')::boolean
       FROM public.threads t JOIN public.messages m ON m.id = t.parent_message_id
      WHERE t.id = current_setting('t.thread')::uuid),
    'the notice is a system message in the channel, by the caller, naming the thread');
SELECT is(
    (SELECT array_agg(user_id) FROM public.thread_members WHERE thread_id = current_setting('t.thread')::uuid),
    ARRAY['22222222-0000-0000-0000-000000000002'::uuid], 'the caller is the only member');
SELECT is(
    (SELECT member_count FROM public.threads WHERE id = current_setting('t.thread')::uuid),
    1, 'member_count counts the caller');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(
    public.post_thread_created_notice(current_setting('t.thread')::uuid),
    (SELECT parent_message_id FROM public.threads WHERE id = current_setting('t.thread')::uuid),
    'post_thread_created_notice returns the existing notice');
SELECT is(
    (SELECT count(*)::int FROM public.messages
      WHERE metadata ->> 'type' = 'thread_created' AND metadata ->> 'thread_id' = current_setting('t.thread')),
    1, 'no second notice');

SELECT throws_ok(
    $q$SELECT public.create_channel_thread('66666666-0000-0000-0000-000000000006', '   ')$q$,
    '22023', NULL, 'a blank name is refused');
SELECT throws_ok(
    $q$SELECT public.create_channel_thread('66666666-0000-0000-0000-000000000006', repeat('x', 101))$q$,
    '22023', NULL, 'a name over 100 characters is refused');
SELECT throws_ok(
    $q$SELECT public.create_channel_thread('6666ffff-0000-0000-0000-000000000006', 'nope')$q$,
    'P0002', NULL, 'an unknown channel reads as absent');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$SELECT public.create_channel_thread('66666666-0000-0000-0000-000000000006', 'intrusion')$q$,
    'P0002', NULL, 'a non-member cannot see the channel');

SELECT tests.authenticate_as_anon();
SELECT throws_ok(
    $q$SELECT public.create_channel_thread('66666666-0000-0000-0000-000000000006', 'anon')$q$,
    '42501', NULL, 'anon cannot call it');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
