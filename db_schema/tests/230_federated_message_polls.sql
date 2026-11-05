-- Chat message polls over federation after 20261105990001_federated_message_polls.sql.
--
-- Fixture server_1 (alice owns it, bob is a member) is federated here, with remy, an account of
-- another instance, as a member. Added: a copy of a server hosted on peer.example (bob and alice
-- members, channel cc), a direct conversation between alice and remy, and dora, an account of
-- another instance in nothing.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(62);

GRANT USAGE ON SCHEMA tests TO service_role;

INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id) VALUES
  ('f0230000-0000-0000-0000-000000000001', 'remy', 'Remy', false, 'peer.example', 'https://peer.example/users/remy'),
  ('f0230000-0000-0000-0000-000000000002', 'dora', 'Dora', false, 'peer.example', 'https://peer.example/users/dora');
UPDATE public.servers SET federation_enabled = true WHERE id = '55555555-0000-0000-0000-000000000005';
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f0230000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'accepted');

INSERT INTO public.servers (id, name, owner, is_local_server, federation_enabled, ap_id, federation_inbox_url, federation_metadata) VALUES
  ('f0230000-0000-0000-0000-000000000010', 'Peer copy', '11111111-0000-0000-0000-000000000001', false, true,
   'https://peer.example/servers/f0230000-0000-0000-0000-000000000010',
   'https://peer.example/servers/f0230000-0000-0000-0000-000000000010/inbox', '{}'::jsonb);
INSERT INTO public.channels (id, server_id, name, type, is_remote) VALUES
  ('f0230000-0000-0000-0000-000000000011', 'f0230000-0000-0000-0000-000000000010', 'cc', 0, true);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f0230000-0000-0000-0000-000000000010', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'f0230000-0000-0000-0000-000000000010', 'accepted');

INSERT INTO public.conversations (id, type) VALUES ('f0230000-0000-0000-0000-000000000020', 'direct');
INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES
  ('f0230000-0000-0000-0000-000000000020', '11111111-0000-0000-0000-000000000001'),
  ('f0230000-0000-0000-0000-000000000020', 'f0230000-0000-0000-0000-000000000001');

-- Grants -----------------------------------------------------------------------------------
SELECT ok(NOT has_table_privilege('authenticated', 'public.message_poll_outbox', 'SELECT')
          AND NOT has_table_privilege('anon', 'public.message_poll_outbox', 'SELECT')
          AND has_table_privilege('service_role', 'public.message_poll_outbox', 'DELETE'),
          'the outbox is the service role''s alone');
SELECT ok(NOT has_function_privilege('authenticated', 'public.store_federated_message_poll(uuid, uuid, text, text[], boolean, timestamp with time zone, boolean, text, integer[], integer)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.apply_federated_message_poll_state(uuid, integer[], integer, timestamp with time zone)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.record_federated_message_poll_vote(uuid, uuid, text)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.end_federated_message_poll(uuid, uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.message_poll_federation_state(uuid[])', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.queue_message_poll_federation(uuid, text, uuid)', 'EXECUTE'),
          'clients call none of the federated writes');
SELECT ok(has_function_privilege('service_role', 'public.record_federated_message_poll_vote(uuid, uuid, text)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.store_federated_message_poll(uuid, uuid, text, text[], boolean, timestamp with time zone, boolean, text, integer[], integer)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.message_poll_federation_state(uuid[])', 'EXECUTE'),
          'the federation backend calls them');
SELECT ok(has_function_privilege('authenticated', 'public.get_message_polls(uuid[])', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.vote_message_poll(uuid, uuid[])', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.end_message_poll(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.get_message_polls(uuid[])', 'EXECUTE'),
          'members keep reading, voting and ending; anon does not');

-- A poll in a copy -------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_like(
    $q$SELECT public.create_message_poll('f0230000-0000-0000-0000-000000000011', NULL, 'Where?', ARRAY['Here', 'There'])$q$,
    '%POLL_HOST_UNSUPPORTED%',
    'a copy whose host does not federate polls takes none');
SELECT tests.clear_authentication();

UPDATE public.servers SET federation_metadata = '{"message_polls": true}'::jsonb
 WHERE id = 'f0230000-0000-0000-0000-000000000010';

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(
    $q$SELECT set_config('t.copy_msg', public.create_message_poll(
         'f0230000-0000-0000-0000-000000000011', NULL, 'Where?', ARRAY['Here', 'There'], false, 24) ->> 'id', true)$q$,
    'a member posts a poll in a copy whose host federates polls');
SELECT set_config('t.copy_poll', (SELECT content -> 0 ->> 'pollId' FROM public.messages
                                   WHERE id = current_setting('t.copy_msg')::uuid), true);
SELECT tests.clear_authentication();

SELECT ok((SELECT remote AND ap_id IS NULL AND remote_voters = 0 FROM public.message_polls
            WHERE id = current_setting('t.copy_poll')::uuid),
          'the poll is a copy from the start, its host holding the tally');

-- A poll stored from a Note ----------------------------------------------------------------
SELECT set_config('t.in_msg', 'f0230000-0000-0000-0000-000000000030', true);
SELECT set_config('t.in_poll', 'f0230000-0000-0000-0000-000000000031', true);
INSERT INTO public.messages (id, channel_id, user_id, content, metadata) VALUES (
  'f0230000-0000-0000-0000-000000000030', 'f0230000-0000-0000-0000-000000000011', 'f0230000-0000-0000-0000-000000000001',
  jsonb_build_array(
    jsonb_build_object('type', 'poll', 'pollId', 'f0230000-0000-0000-0000-000000000031', 'question', 'Lunch?',
                       'options', jsonb_build_array('Pizza', 'Soup', 'Salad'), 'allowMultiple', false),
    jsonb_build_object('type', 'text', 'text', E'📊 Lunch?\n1. Pizza\n2. Soup\n3. Salad')),
  '{"federated": true, "ap_id": "https://peer.example/messages/f0230000-0000-0000-0000-000000000030"}'::jsonb);
INSERT INTO public.messages (id, channel_id, user_id, content, metadata) VALUES (
  'f0230000-0000-0000-0000-000000000032', 'f0230000-0000-0000-0000-000000000011', 'f0230000-0000-0000-0000-000000000001',
  '[{"type": "text", "text": "no poll here"}]'::jsonb, '{"federated": true}'::jsonb);

SELECT set_config('role', 'service_role', true);
SELECT is(public.store_federated_message_poll(
    'f0230000-0000-0000-0000-000000000032', 'f0230000-0000-0000-0000-000000000033', 'Q?', ARRAY['a', 'b'],
    false, now() + interval '1 day', true, 'https://peer.example/messages/x'),
  NULL, 'a message whose content names no such poll gets none');
SELECT is(public.store_federated_message_poll(
    'f0230000-0000-0000-0000-000000000030', 'f0230000-0000-0000-0000-000000000031', 'Lunch?', ARRAY['Pizza'],
    false, now() + interval '1 day', true, 'https://peer.example/messages/f0230000-0000-0000-0000-000000000030'),
  NULL, 'a poll of one answer is not stored');
SELECT is(public.store_federated_message_poll(
    'f0230000-0000-0000-0000-000000000030', 'f0230000-0000-0000-0000-000000000031', '  Lunch?  ',
    ARRAY['Pizza', 'Soup', repeat('s', 140)], false, now() + interval '1 day', true,
    'https://peer.example/messages/f0230000-0000-0000-0000-000000000030', ARRAY[3, 1, 0], 4),
  'f0230000-0000-0000-0000-000000000031'::uuid, 'a poll arriving in a Note is stored as a copy');
SELECT is(public.store_federated_message_poll(
    'f0230000-0000-0000-0000-000000000030', 'f0230000-0000-0000-0000-000000000034', 'Lunch?', ARRAY['a', 'b'],
    false, now() + interval '1 day', true, 'https://peer.example/messages/other'),
  NULL, 'a second poll for the message is not stored');
SELECT tests.clear_authentication();

SELECT ok((SELECT p.remote AND p.ap_id = 'https://peer.example/messages/f0230000-0000-0000-0000-000000000030'
                  AND p.question = 'Lunch?' AND p.remote_voters = 4
                  AND p.created_by = 'f0230000-0000-0000-0000-000000000001'
             FROM public.message_polls p WHERE p.id = current_setting('t.in_poll')::uuid),
          'the copy names the poll''s id, its author and the holder''s voters');
SELECT is((SELECT array_agg(char_length(text) || ':' || remote_votes ORDER BY "position") FROM public.message_poll_options
            WHERE poll_id = current_setting('t.in_poll')::uuid),
          ARRAY['5:3', '4:1', '100:0'], 'answers are cut to 100 characters and carry the holder''s counts');

-- Reading and voting on a copy -------------------------------------------------------------
SELECT set_config('t.pizza', (SELECT id::text FROM public.message_poll_options
                               WHERE poll_id = current_setting('t.in_poll')::uuid AND "position" = 0), true);
SELECT set_config('t.soup', (SELECT id::text FROM public.message_poll_options
                              WHERE poll_id = current_setting('t.in_poll')::uuid AND "position" = 1), true);

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT jsonb_build_object('remote', remote, 'voters', total_voters,
                                     'votes', (SELECT jsonb_agg(o -> 'votes') FROM jsonb_array_elements(options) o))
             FROM public.get_message_polls(ARRAY[current_setting('t.in_poll')::uuid])),
          '{"remote": true, "voters": 4, "votes": [3, 1, 0]}'::jsonb,
          'a member reads the copy with the holder''s counts');
SELECT throws_like(
    format('SELECT * FROM public.vote_message_poll(%L, ARRAY[%L, %L]::uuid[])',
           current_setting('t.in_poll'), current_setting('t.pizza'), current_setting('t.soup')),
    '%POLL_SINGLE_CHOICE%', 'a single-choice copy takes one answer');
SELECT is((SELECT jsonb_build_object('voters', total_voters, 'mine', my_option_ids = ARRAY[current_setting('t.soup')::uuid],
                                     'votes', (SELECT jsonb_agg(o -> 'votes') FROM jsonb_array_elements(options) o))
             FROM public.vote_message_poll(current_setting('t.in_poll')::uuid, ARRAY[current_setting('t.soup')::uuid])),
          '{"voters": 5, "mine": true, "votes": [3, 2, 0]}'::jsonb,
          'a vote on a copy counts at once and is the voter''s');
SELECT throws_like(
    format('SELECT * FROM public.vote_message_poll(%L, ARRAY[%L]::uuid[])', current_setting('t.in_poll'), current_setting('t.pizza')),
    '%POLL_ALREADY_VOTED%', 'a vote on a copy is final');
SELECT throws_like(
    format('SELECT * FROM public.vote_message_poll(%L, ARRAY[]::uuid[])', current_setting('t.in_poll')),
    '%POLL_ALREADY_VOTED%', 'and is not removed');
SELECT tests.clear_authentication();

SELECT is((SELECT array_agg(kind || ':' || COALESCE(user_id::text, '-')) FROM public.message_poll_outbox
            WHERE poll_id = current_setting('t.in_poll')::uuid),
          ARRAY['vote:11111111-0000-0000-0000-000000000001'], 'the vote is queued for the holder');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT jsonb_build_object('voters', total_voters, 'mine', cardinality(my_option_ids))
             FROM public.vote_message_poll(current_setting('t.in_poll')::uuid, ARRAY[]::uuid[])),
          '{"voters": 5, "mine": 0}'::jsonb, 'an empty vote on a copy changes nothing');
SELECT throws_like(
    format('SELECT * FROM public.end_message_poll(%L)', current_setting('t.in_poll')),
    '%Only the author ends a poll%', 'a copy written on another instance is not ended here');
SELECT tests.clear_authentication();

-- The holder's counts ----------------------------------------------------------------------
SELECT set_config('role', 'service_role', true);
SELECT ok(public.apply_federated_message_poll_state(current_setting('t.in_poll')::uuid, ARRAY[4, 2, 1], 6, NULL),
          'the holder''s counts apply to the copy');
SELECT ok(public.apply_federated_message_poll_state(current_setting('t.in_poll')::uuid, ARRAY[9, 9], 7, NULL),
          'counts naming another number of answers are taken for the voters only');
SELECT is(public.apply_federated_message_poll_state(current_setting('t.poll_none', true)::uuid, ARRAY[1, 1], 1, NULL),
          false, 'no copy, nothing applied');
SELECT tests.clear_authentication();

SELECT is((SELECT array_agg(remote_votes ORDER BY "position") FROM public.message_poll_options
            WHERE poll_id = current_setting('t.in_poll')::uuid), ARRAY[4, 2, 1], 'the answers carry the holder''s counts');
SELECT is((SELECT remote_voters FROM public.message_polls WHERE id = current_setting('t.in_poll')::uuid), 7,
          'and the poll its voters');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT jsonb_build_object('voters', total_voters, 'mine', my_option_ids = ARRAY[current_setting('t.soup')::uuid], 'closed', closed)
             FROM public.get_message_polls(ARRAY[current_setting('t.in_poll')::uuid])),
          '{"voters": 7, "mine": true, "closed": false}'::jsonb, 'the voter keeps their own answer beside the holder''s counts');
SELECT tests.clear_authentication();

SELECT set_config('role', 'service_role', true);
SELECT ok(public.apply_federated_message_poll_state(current_setting('t.in_poll')::uuid, ARRAY[4, 2, 1], 7, now() - interval '1 second'),
          'the holder''s close applies');
SELECT tests.clear_authentication();
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT closed FROM public.get_message_polls(ARRAY[current_setting('t.in_poll')::uuid])), true, 'the copy reads closed');
SELECT throws_like(
    format('SELECT * FROM public.vote_message_poll(%L, ARRAY[%L]::uuid[])', current_setting('t.in_poll'), current_setting('t.pizza')),
    '%POLL_CLOSED%', 'and takes no vote');
SELECT tests.clear_authentication();

-- Ending a copy written here ---------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT closed FROM public.end_message_poll(current_setting('t.copy_poll')::uuid)), true,
          'the author ends their poll in a copy');
SELECT tests.clear_authentication();
SELECT is((SELECT array_agg(kind) FROM public.message_poll_outbox WHERE poll_id = current_setting('t.copy_poll')::uuid),
          ARRAY['end'], 'and the end is queued for the host');

-- A poll held here: votes from other instances ---------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT set_config('t.held_msg', public.create_message_poll(
         '66666666-0000-0000-0000-000000000006', NULL, 'Meet when?', ARRAY['Monday', 'Friday'], false, 24) ->> 'id', true);
SELECT set_config('t.held_poll', (SELECT content -> 0 ->> 'pollId' FROM public.messages
                                   WHERE id = current_setting('t.held_msg')::uuid), true);
SELECT set_config('t.multi_msg', public.create_message_poll(
         '66666666-0000-0000-0000-000000000006', NULL, 'Bring what?', ARRAY['Tea', 'Cake', 'Fruit'], true, 24) ->> 'id', true);
SELECT set_config('t.multi_poll', (SELECT content -> 0 ->> 'pollId' FROM public.messages
                                    WHERE id = current_setting('t.multi_msg')::uuid), true);
SELECT tests.clear_authentication();

SELECT ok((SELECT NOT remote FROM public.message_polls WHERE id = current_setting('t.held_poll')::uuid),
          'a poll in a channel of a server hosted here is held here');

SELECT set_config('role', 'service_role', true);
SELECT is(public.record_federated_message_poll_vote(current_setting('t.held_poll')::uuid, 'f0230000-0000-0000-0000-000000000001', 'Friday'),
          'recorded', 'a member from another instance votes');
SELECT is(public.record_federated_message_poll_vote(current_setting('t.held_poll')::uuid, 'f0230000-0000-0000-0000-000000000001', 'Monday'),
          'duplicate', 'once on a single-choice poll');
SELECT is(public.record_federated_message_poll_vote(current_setting('t.held_poll')::uuid, 'f0230000-0000-0000-0000-000000000002', 'Friday'),
          'forbidden', 'an account that is no member does not vote');
SELECT is(public.record_federated_message_poll_vote(current_setting('t.multi_poll')::uuid, 'f0230000-0000-0000-0000-000000000001', 'Sandwich'),
          'invalid', 'an answer the poll lacks is refused');
SELECT is(public.record_federated_message_poll_vote(current_setting('t.multi_poll')::uuid, 'f0230000-0000-0000-0000-000000000001', 'Tea'),
          'recorded', 'a multiple-choice poll takes an answer');
SELECT is(public.record_federated_message_poll_vote(current_setting('t.multi_poll')::uuid, 'f0230000-0000-0000-0000-000000000001', 'Cake'),
          'recorded', 'and another');
SELECT is(public.record_federated_message_poll_vote(current_setting('t.multi_poll')::uuid, 'f0230000-0000-0000-0000-000000000001', 'Tea'),
          'duplicate', 'each answer once');
SELECT is(public.record_federated_message_poll_vote(current_setting('t.in_poll')::uuid, 'f0230000-0000-0000-0000-000000000001', 'Pizza'),
          'not_found', 'a copy takes no votes from other instances');
SELECT tests.clear_authentication();

SELECT is((SELECT array_agg(kind) FROM public.message_poll_outbox WHERE poll_id = current_setting('t.held_poll')::uuid),
          ARRAY['state'], 'the counts are queued for the instances with a copy');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT jsonb_build_object('remote', remote, 'voters', total_voters,
                                     'votes', (SELECT jsonb_agg(o -> 'votes') FROM jsonb_array_elements(options) o))
             FROM public.get_message_polls(ARRAY[current_setting('t.multi_poll')::uuid])),
          '{"remote": false, "voters": 1, "votes": [1, 1, 0]}'::jsonb, 'the votes count here, by voter');
SELECT tests.clear_authentication();

INSERT INTO public.user_blocks (blocker_id, blocked_user_id) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f0230000-0000-0000-0000-000000000001');
SELECT set_config('role', 'service_role', true);
SELECT is(public.record_federated_message_poll_vote(current_setting('t.multi_poll')::uuid, 'f0230000-0000-0000-0000-000000000001', 'Fruit'),
          'forbidden', 'an account the author blocks does not vote');
SELECT tests.clear_authentication();
DELETE FROM public.user_blocks WHERE blocker_id = '11111111-0000-0000-0000-000000000001';

UPDATE public.profiles SET is_suspended = true WHERE id = 'f0230000-0000-0000-0000-000000000001';
SELECT set_config('role', 'service_role', true);
SELECT is(public.record_federated_message_poll_vote(current_setting('t.multi_poll')::uuid, 'f0230000-0000-0000-0000-000000000001', 'Fruit'),
          'forbidden', 'nor does a suspended one');
SELECT tests.clear_authentication();
UPDATE public.profiles SET is_suspended = false WHERE id = 'f0230000-0000-0000-0000-000000000001';
-- Suspension ends the account's memberships; remy joins again.
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('f0230000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'accepted')
ON CONFLICT (user_id, server_id) DO UPDATE SET status = 'accepted';

-- A local vote on a held poll queues the counts; ending it, its end.
DELETE FROM public.message_poll_outbox;
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(
    format('SELECT * FROM public.vote_message_poll(%L, ARRAY[(SELECT id FROM public.message_poll_options WHERE poll_id = %L AND "position" = 0)])',
           current_setting('t.held_poll'), current_setting('t.held_poll')),
    'a member here votes on the held poll');
SELECT lives_ok(
    format('SELECT * FROM public.vote_message_poll(%L, ARRAY[]::uuid[])', current_setting('t.held_poll')),
    'and takes the vote back, as votes here allow');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::integer FROM public.message_poll_outbox WHERE poll_id = current_setting('t.held_poll')::uuid AND kind = 'state'),
          1, 'one state row per poll, however many changes');

SELECT set_config('role', 'service_role', true);
SELECT is(public.end_federated_message_poll(current_setting('t.held_poll')::uuid, 'f0230000-0000-0000-0000-000000000001'),
          false, 'an account that did not write the poll does not end it');
SELECT tests.clear_authentication();

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT closed FROM public.end_message_poll(current_setting('t.held_poll')::uuid)), true, 'the author ends the held poll');
SELECT tests.clear_authentication();
SELECT set_config('role', 'service_role', true);
SELECT is(public.record_federated_message_poll_vote(current_setting('t.held_poll')::uuid, 'f0230000-0000-0000-0000-000000000001', 'Monday'),
          'closed', 'an ended poll takes no vote from another instance');
SELECT tests.clear_authentication();

-- A server with no member from another instance queues nothing.
UPDATE public.user_servers SET status = 'banned'
 WHERE user_id = 'f0230000-0000-0000-0000-000000000001' AND server_id = '55555555-0000-0000-0000-000000000005';
DELETE FROM public.message_poll_outbox;
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(
    format('SELECT * FROM public.vote_message_poll(%L, ARRAY[(SELECT id FROM public.message_poll_options WHERE poll_id = %L AND "position" = 2)])',
           current_setting('t.multi_poll'), current_setting('t.multi_poll')),
    'a member votes where no other instance has a member');
SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::integer FROM public.message_poll_outbox), 0, 'nothing is queued');

-- A poll the author ends on another instance.
SELECT set_config('role', 'service_role', true);
SELECT set_config('t.adopted_msg', 'f0230000-0000-0000-0000-000000000040', true);
INSERT INTO public.messages (id, channel_id, user_id, content, metadata) VALUES (
  'f0230000-0000-0000-0000-000000000040', '66666666-0000-0000-0000-000000000006', 'f0230000-0000-0000-0000-000000000001',
  jsonb_build_array(
    jsonb_build_object('type', 'poll', 'pollId', 'f0230000-0000-0000-0000-000000000041', 'question', 'Sing?',
                       'options', jsonb_build_array('Yes', 'No'), 'allowMultiple', false),
    jsonb_build_object('type', 'text', 'text', E'📊 Sing?\n1. Yes\n2. No')),
  '{"federated": true, "ap_id": "https://peer.example/messages/f0230000-0000-0000-0000-000000000040"}'::jsonb);
SELECT is(public.store_federated_message_poll(
    'f0230000-0000-0000-0000-000000000040', 'f0230000-0000-0000-0000-000000000041', 'Sing?', ARRAY['Yes', 'No'],
    false, now() + interval '1 day', false, 'https://peer.example/messages/f0230000-0000-0000-0000-000000000040', ARRAY[5, 5], 9),
  'f0230000-0000-0000-0000-000000000041'::uuid, 'a member''s poll from another instance is held here');
SELECT ok((SELECT NOT p.remote AND p.remote_voters = 0
                  AND (SELECT sum(remote_votes) FROM public.message_poll_options WHERE poll_id = p.id) = 0
             FROM public.message_polls p WHERE p.id = 'f0230000-0000-0000-0000-000000000041'),
          'starting from no votes whatever the Note claims');
SELECT is(public.end_federated_message_poll('f0230000-0000-0000-0000-000000000041', 'f0230000-0000-0000-0000-000000000001'),
          true, 'its author ends it from their instance');
SELECT is((SELECT jsonb_agg(jsonb_build_object('voters', voters, 'remote', remote, 'ended', expires_at <= now(),
                                               'options', options))
             FROM public.message_poll_federation_state(ARRAY['f0230000-0000-0000-0000-000000000040'::uuid])),
          '[{"voters": 0, "remote": false, "ended": true, "options": [{"position": 0, "text": "Yes", "votes": 0}, {"position": 1, "text": "No", "votes": 0}]}]'::jsonb,
          'the poll as sent: answers by position with their counts');
SELECT tests.clear_authentication();

-- Direct messages --------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT set_config('t.dm_msg', public.create_message_poll(
         NULL, 'f0230000-0000-0000-0000-000000000020', 'Call later?', ARRAY['Yes', 'No'], false, 24) ->> 'id', true);
SELECT set_config('t.dm_poll', (SELECT content -> 0 ->> 'pollId' FROM public.messages
                                 WHERE id = current_setting('t.dm_msg')::uuid), true);
SELECT tests.clear_authentication();
SELECT ok((SELECT NOT remote FROM public.message_polls WHERE id = current_setting('t.dm_poll')::uuid),
          'a poll in a direct message is held by its author''s instance');

SELECT set_config('role', 'service_role', true);
SELECT is(public.record_federated_message_poll_vote(current_setting('t.dm_poll')::uuid, 'f0230000-0000-0000-0000-000000000002', 'Yes'),
          'forbidden', 'an account outside the conversation does not vote');
SELECT is(public.record_federated_message_poll_vote(current_setting('t.dm_poll')::uuid, 'f0230000-0000-0000-0000-000000000001', 'Yes'),
          'recorded', 'its participant from another instance does');
SELECT tests.clear_authentication();
SELECT is((SELECT array_agg(kind) FROM public.message_poll_outbox WHERE poll_id = current_setting('t.dm_poll')::uuid),
          ARRAY['state'], 'the counts are queued for the participant''s instance');

-- The broadcast of a copy carries the holder's counts.
SELECT ok(EXISTS (SELECT 1 FROM realtime.messages
                   WHERE topic = 'channel-messages-f0230000-0000-0000-0000-000000000011' AND event = 'poll_event'
                     AND payload ->> 'poll_id' = current_setting('t.in_poll')
                     AND (payload ->> 'total_voters')::integer = 7
                     AND payload -> 'options' -> 0 ->> 'votes' = '4'),
          'a copy''s broadcast carries the holder''s counts');

SELECT * FROM finish();
ROLLBACK;
