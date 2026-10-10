-- Chat message polls after 20261010700001_message_polls.sql.
--
-- Fixture server_1: alice owns it, bob is a member, mallory is not. Channel general; the DM
-- holds alice and bob. Added here: server E (encryption required) with channel enc, a slowmode
-- channel in server_1, and an encrypted DM between alice and bob.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(69);

INSERT INTO public.servers (id, name, owner) VALUES
  ('f0110000-0000-0000-0000-000000000001', 'Encrypted', '11111111-0000-0000-0000-000000000001');
INSERT INTO public.server_encryption_settings (server_id, encryption_mode) VALUES
  ('f0110000-0000-0000-0000-000000000001', 'required');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f0110000-0000-0000-0000-000000000002', 'f0110000-0000-0000-0000-000000000001', 'enc', 0);
INSERT INTO public.channels (id, server_id, name, type, slowmode_seconds) VALUES
  ('f0110000-0000-0000-0000-000000000003', '55555555-0000-0000-0000-000000000005', 'slow', 0, 60);
INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f0110000-0000-0000-0000-000000000001', 'accepted'),
  ('22222222-0000-0000-0000-000000000002', 'f0110000-0000-0000-0000-000000000001', 'accepted');
INSERT INTO public.conversations (id, type) VALUES ('f0110000-0000-0000-0000-000000000004', 'direct');
INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES
  ('f0110000-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000001'),
  ('f0110000-0000-0000-0000-000000000004', '22222222-0000-0000-0000-000000000002');
INSERT INTO public.conversation_encryption_settings (conversation_id, encryption_enabled) VALUES
  ('f0110000-0000-0000-0000-000000000004', true);

-- Grants -----------------------------------------------------------------------------------
SELECT ok(NOT has_table_privilege('authenticated', 'public.message_poll_votes', 'SELECT')
          AND NOT has_table_privilege('authenticated', 'public.message_poll_votes', 'INSERT'),
          'clients neither read nor write votes directly');
SELECT ok(NOT has_function_privilege('authenticated', 'public.broadcast_message_poll_event(uuid, text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.get_message_polls(uuid[])', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.create_message_poll(uuid, uuid, text, text[], boolean, integer, uuid)', 'EXECUTE'),
          'the broadcast helper is internal and anon calls no poll RPC');

-- Creation in a channel --------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(
    $q$SELECT set_config('t.msg', public.create_message_poll(
         '66666666-0000-0000-0000-000000000006', NULL, '  Lunch?  ',
         ARRAY[' Pizza ', 'Sushi', 'Tacos'], false, 24) ->> 'id', true)$q$,
    'a member posts a poll in a channel');
SELECT set_config('t.poll', (SELECT content -> 0 ->> 'pollId' FROM public.messages
                              WHERE id = current_setting('t.msg')::uuid), true);
SELECT tests.clear_authentication();

SELECT is(
    (SELECT jsonb_build_object('type', content -> 0 ->> 'type', 'question', content -> 0 ->> 'question',
                               'options', content -> 0 -> 'options', 'allowMultiple', content -> 0 -> 'allowMultiple')
       FROM public.messages WHERE id = current_setting('t.msg')::uuid),
    '{"type": "poll", "question": "Lunch?", "options": ["Pizza", "Sushi", "Tacos"], "allowMultiple": false}'::jsonb,
    'the poll part carries the trimmed question and answers');
SELECT is(
    (SELECT content -> 1 FROM public.messages WHERE id = current_setting('t.msg')::uuid),
    jsonb_build_object('type', 'text', 'text', E'📊 Lunch?\n1. Pizza\n2. Sushi\n3. Tacos'),
    'the text part spells the poll out');
SELECT ok(
    (SELECT m.user_id = '22222222-0000-0000-0000-000000000002'
            AND m.channel_id = '66666666-0000-0000-0000-000000000006'
            AND p.message_id = m.id
            AND p.created_by = m.user_id
            AND p.question = 'Lunch?'
            AND NOT p.allow_multiple
            AND p.expires_at = now() + interval '24 hours'
       FROM public.message_polls p JOIN public.messages m ON m.id = p.message_id
      WHERE p.id = current_setting('t.poll')::uuid),
    'the poll row belongs to the author''s message and ends in 24 hours');
SELECT is(
    (SELECT array_agg(text ORDER BY "position") FROM public.message_poll_options
      WHERE poll_id = current_setting('t.poll')::uuid),
    ARRAY['Pizza', 'Sushi', 'Tacos'], 'the answers are stored in order');
SELECT set_config('t.o1', (SELECT id::text FROM public.message_poll_options
                            WHERE poll_id = current_setting('t.poll')::uuid AND "position" = 0), true);
SELECT set_config('t.o2', (SELECT id::text FROM public.message_poll_options
                            WHERE poll_id = current_setting('t.poll')::uuid AND "position" = 1), true);

-- Visibility -------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(
    (SELECT jsonb_build_object('message', message_id, 'closed', closed, 'voters', total_voters,
                               'answers', jsonb_array_length(options), 'mine', my_option_ids, 'author', is_author)
       FROM public.get_message_polls(ARRAY[current_setting('t.poll')::uuid])),
    jsonb_build_object('message', current_setting('t.msg')::uuid, 'closed', false, 'voters', 0,
                       'answers', 3, 'mine', '{}'::uuid[], 'author', false),
    'a channel member reads the poll');
SELECT is((SELECT count(*)::int FROM public.message_polls WHERE id = current_setting('t.poll')::uuid),
          1, 'a member reads the poll row');
SELECT is((SELECT count(*)::int FROM public.message_poll_options WHERE poll_id = current_setting('t.poll')::uuid),
          3, 'a member reads the answers');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is_empty(
    $q$SELECT 1 FROM public.get_message_polls(ARRAY[current_setting('t.poll')::uuid])$q$,
    'a non-member reads nothing through get_message_polls');
SELECT is_empty(
    $q$SELECT 1 FROM public.message_polls WHERE id = current_setting('t.poll')::uuid
       UNION ALL SELECT 1 FROM public.message_poll_options WHERE poll_id = current_setting('t.poll')::uuid$q$,
    'a non-member reads no poll or answer row');
SELECT throws_like(
    $q$SELECT public.create_message_poll('66666666-0000-0000-0000-000000000006', NULL, 'Q', ARRAY['a', 'b'], false, 1)$q$,
    'new row violates row-level security policy%', 'a non-member cannot post a poll in the channel');
SELECT throws_ok(
    $q$SELECT * FROM public.vote_message_poll(current_setting('t.poll')::uuid, ARRAY[current_setting('t.o1')::uuid])$q$,
    'P0002', NULL, 'a non-member cannot vote');

SELECT tests.authenticate_as_anon();
SELECT throws_ok(
    $q$SELECT public.create_message_poll('66666666-0000-0000-0000-000000000006', NULL, 'Q', ARRAY['a', 'b'], false, 1)$q$,
    '42501', NULL, 'anon cannot post a poll');
SELECT throws_ok(
    $q$SELECT * FROM public.get_message_polls(ARRAY[current_setting('t.poll')::uuid])$q$,
    '42501', NULL, 'anon cannot read polls');
SELECT throws_ok(
    $q$SELECT * FROM public.vote_message_poll(current_setting('t.poll')::uuid, ARRAY[current_setting('t.o1')::uuid])$q$,
    '42501', NULL, 'anon cannot vote');

-- Validation -------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$SELECT public.create_message_poll('66666666-0000-0000-0000-000000000006', NULL, 'Q', ARRAY['only'], false, 1)$q$,
    '22023', NULL, 'one answer is refused');
SELECT throws_ok(
    $q$SELECT public.create_message_poll('66666666-0000-0000-0000-000000000006', NULL, 'Q',
         ARRAY['1','2','3','4','5','6','7','8','9','10','11'], false, 1)$q$,
    '22023', NULL, 'eleven answers are refused');
SELECT throws_ok(
    $q$SELECT public.create_message_poll('66666666-0000-0000-0000-000000000006', NULL, 'Q', ARRAY['a', '   '], false, 1)$q$,
    '22023', NULL, 'a blank answer is refused');
SELECT throws_ok(
    $q$SELECT public.create_message_poll('66666666-0000-0000-0000-000000000006', NULL, 'Q', ARRAY['a', repeat('b', 101)], false, 1)$q$,
    '22023', NULL, 'an answer over 100 characters is refused');
SELECT throws_ok(
    $q$SELECT public.create_message_poll('66666666-0000-0000-0000-000000000006', NULL, 'Q', ARRAY['Yes', ' yes'], false, 1)$q$,
    '22023', NULL, 'duplicate answers are refused');
SELECT throws_ok(
    $q$SELECT public.create_message_poll('66666666-0000-0000-0000-000000000006', NULL, '  ', ARRAY['a', 'b'], false, 1)$q$,
    '22023', NULL, 'a blank question is refused');
SELECT throws_ok(
    $q$SELECT public.create_message_poll('66666666-0000-0000-0000-000000000006', NULL, repeat('q', 301), ARRAY['a', 'b'], false, 1)$q$,
    '22023', NULL, 'a question over 300 characters is refused');
SELECT throws_ok(
    $q$SELECT public.create_message_poll('66666666-0000-0000-0000-000000000006', NULL, 'Q', ARRAY['a', 'b'], false, 169)$q$,
    '22023', NULL, 'a poll longer than 7 days is refused');
SELECT throws_ok(
    $q$SELECT public.create_message_poll('66666666-0000-0000-0000-000000000006', NULL, 'Q', ARRAY['a', 'b'], false, 0)$q$,
    '22023', NULL, 'a poll shorter than an hour is refused');
SELECT throws_ok(
    $q$SELECT public.create_message_poll('66666666-0000-0000-0000-000000000006',
         '77777777-0000-0000-0000-000000000007', 'Q', ARRAY['a', 'b'], false, 1)$q$,
    '22023', NULL, 'a poll names one channel or one conversation');

-- Encryption -------------------------------------------------------------------------------
SELECT throws_ok(
    $q$SELECT public.create_message_poll('f0110000-0000-0000-0000-000000000002', NULL, 'Q', ARRAY['a', 'b'], false, 1)$q$,
    '23514', 'POLL_ENCRYPTED: polls are not available in end-to-end encrypted conversations',
    'an end-to-end encrypted channel refuses polls');
SELECT throws_ok(
    $q$SELECT public.create_message_poll(NULL, 'f0110000-0000-0000-0000-000000000004', 'Q', ARRAY['a', 'b'], false, 1)$q$,
    '23514', 'POLL_ENCRYPTED: polls are not available in end-to-end encrypted conversations',
    'an end-to-end encrypted DM refuses polls');

-- Poll parts enter only through create_message_poll ------------------------------------------
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content) VALUES
         ('66666666-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002',
          jsonb_build_array(jsonb_build_object('type', 'poll', 'pollId', current_setting('t.poll'), 'question', 'Lunch?')))$q$,
    '42501', 'POLL_PART_FORBIDDEN: polls are posted with create_message_poll',
    'a client cannot write a poll part');
SELECT throws_ok(
    $q$INSERT INTO public.message_polls (message_id, question, created_by) VALUES
         ('88888888-0000-0000-0000-000000000008', 'Q', '22222222-0000-0000-0000-000000000002')$q$,
    '42501', NULL, 'a client cannot write a poll row');
SELECT throws_ok(
    $q$INSERT INTO public.message_poll_options (poll_id, "position", text) VALUES
         (current_setting('t.poll')::uuid, 5, 'Burgers')$q$,
    '42501', NULL, 'a client cannot add an answer');
SELECT throws_ok(
    $q$UPDATE public.messages SET content = '[{"type": "text", "text": "edited"}]'::jsonb
        WHERE id = current_setting('t.msg')::uuid$q$,
    '42501', 'POLL_MESSAGE_IMMUTABLE: a poll message cannot be edited',
    'the author cannot edit a poll message');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
         ('f0110000-0000-0000-0000-000000000005', '66666666-0000-0000-0000-000000000006',
          '11111111-0000-0000-0000-000000000001', '[{"type": "text", "text": "plain"}]'::jsonb)$q$,
    'a plain message is written');
SELECT throws_ok(
    $q$UPDATE public.messages
          SET content = jsonb_build_array(jsonb_build_object('type', 'poll', 'pollId', current_setting('t.poll'), 'question', 'x'))
        WHERE id = 'f0110000-0000-0000-0000-000000000005'$q$,
    '42501', 'POLL_MESSAGE_IMMUTABLE: a poll message cannot be edited',
    'an edit cannot add a poll part');
SELECT lives_ok(
    $q$UPDATE public.messages SET content = '[{"type": "text", "text": "plain, edited"}]'::jsonb
        WHERE id = 'f0110000-0000-0000-0000-000000000005'$q$,
    'other edits are unaffected');

-- Voting, single choice --------------------------------------------------------------------
SELECT is(
    (SELECT my_option_ids FROM public.vote_message_poll(current_setting('t.poll')::uuid,
                                                       ARRAY[current_setting('t.o1')::uuid])),
    ARRAY[current_setting('t.o1')::uuid], 'a member votes');
SELECT ok(EXISTS (SELECT 1 FROM realtime.messages
                   WHERE topic = 'channel-messages-66666666-0000-0000-0000-000000000006'
                     AND event = 'poll_event'
                     AND payload ->> 'type' = 'poll:vote'
                     AND payload ->> 'poll_id' = current_setting('t.poll')
                     AND (payload ->> 'total_voters')::int = 1
                     AND payload -> 'options' -> 0 ->> 'votes' = '1'
                     AND NOT (payload ? 'user_id')),
          'a vote broadcasts the counts on the channel topic, without the voter');
SELECT throws_ok(
    $q$SELECT * FROM public.vote_message_poll(current_setting('t.poll')::uuid,
         ARRAY[current_setting('t.o1')::uuid, current_setting('t.o2')::uuid])$q$,
    '22023', NULL, 'a single-choice poll takes one answer');
SELECT is(
    (SELECT jsonb_build_object('voters', total_voters, 'first', options -> 0 -> 'votes', 'second', options -> 1 -> 'votes')
       FROM public.vote_message_poll(current_setting('t.poll')::uuid, ARRAY[current_setting('t.o2')::uuid])),
    '{"voters": 1, "first": 0, "second": 1}'::jsonb, 'voting again moves the vote');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(
    (SELECT jsonb_build_object('voters', total_voters, 'second', options -> 1 -> 'votes', 'mine', my_option_ids,
                               'author', is_author)
       FROM public.vote_message_poll(current_setting('t.poll')::uuid, ARRAY[current_setting('t.o2')::uuid])),
    jsonb_build_object('voters', 2, 'second', 2, 'mine', ARRAY[current_setting('t.o2')::uuid], 'author', true),
    'votes from two members add up; the author reads is_author');
SELECT is(
    (SELECT jsonb_build_object('voters', total_voters, 'mine', my_option_ids)
       FROM public.vote_message_poll(current_setting('t.poll')::uuid, '{}')),
    jsonb_build_object('voters', 1, 'mine', '{}'::uuid[]), 'an empty answer list removes the vote');
SELECT is(
    (SELECT count(*)::int FROM realtime.messages
      WHERE event = 'poll_event' AND payload ->> 'poll_id' = current_setting('t.poll')),
    4, 'every change broadcasts once');
SELECT lives_ok(
    $q$SELECT * FROM public.vote_message_poll(current_setting('t.poll')::uuid, NULL)$q$,
    'removing an absent vote is a no-op');
SELECT is(
    (SELECT count(*)::int FROM realtime.messages
      WHERE event = 'poll_event' AND payload ->> 'poll_id' = current_setting('t.poll')),
    4, 'a no-op broadcasts nothing');

-- Voting, multiple choice ------------------------------------------------------------------
SELECT lives_ok(
    $q$SELECT set_config('t.multi', public.create_message_poll(
         '66666666-0000-0000-0000-000000000006', NULL, 'Games night?',
         ARRAY['Friday', 'Saturday', 'Sunday'], true, 72) -> 'content' -> 0 ->> 'pollId', true)$q$,
    'a multiple-choice poll is posted');
SELECT is(
    (SELECT jsonb_build_object('voters', total_voters, 'mine', cardinality(my_option_ids),
                               'votes', jsonb_path_query_array(options, '$[*].votes'))
       FROM public.vote_message_poll(current_setting('t.multi')::uuid,
              ARRAY(SELECT id FROM public.message_poll_options
                     WHERE poll_id = current_setting('t.multi')::uuid AND "position" IN (0, 2)))),
    '{"voters": 1, "mine": 2, "votes": [1, 0, 1]}'::jsonb,
    'a multiple-choice poll takes several answers from one voter');
SELECT throws_ok(
    $q$SELECT * FROM public.vote_message_poll(current_setting('t.multi')::uuid, ARRAY[current_setting('t.o1')::uuid])$q$,
    '22023', NULL, 'an answer of another poll is refused');

-- Ending -----------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$SELECT * FROM public.end_message_poll(current_setting('t.multi')::uuid)$q$,
    '42501', NULL, 'only the author ends a poll, the server owner included');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(
    (SELECT closed FROM public.end_message_poll(current_setting('t.multi')::uuid)),
    true, 'the author ends the poll');
SELECT ok(EXISTS (SELECT 1 FROM realtime.messages
                   WHERE event = 'poll_event' AND payload ->> 'type' = 'poll:ended'
                     AND payload ->> 'poll_id' = current_setting('t.multi')),
          'ending broadcasts');
SELECT throws_ok(
    $q$SELECT * FROM public.vote_message_poll(current_setting('t.multi')::uuid, '{}')$q$,
    '22023', NULL, 'an ended poll takes no vote');

SELECT tests.clear_authentication();
UPDATE public.message_polls SET expires_at = now() - interval '1 minute'
 WHERE id = current_setting('t.poll')::uuid;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(
    (SELECT closed FROM public.get_message_polls(ARRAY[current_setting('t.poll')::uuid])),
    true, 'a poll past its end reads as closed');
SELECT throws_ok(
    $q$SELECT * FROM public.vote_message_poll(current_setting('t.poll')::uuid, ARRAY[current_setting('t.o1')::uuid])$q$,
    '22023', NULL, 'an expired poll takes no vote');

-- DMs --------------------------------------------------------------------------------------
SELECT lives_ok(
    $q$SELECT set_config('t.dm', public.create_message_poll(
         NULL, '77777777-0000-0000-0000-000000000007', 'Movie?', ARRAY['Yes', 'No'], false, 1,
         '99999999-0000-0000-0000-000000000009') -> 'content' -> 0 ->> 'pollId', true)$q$,
    'a participant posts a poll in a DM, as a reply');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(
    (SELECT total_voters FROM public.vote_message_poll(current_setting('t.dm')::uuid,
       ARRAY(SELECT id FROM public.message_poll_options WHERE poll_id = current_setting('t.dm')::uuid AND "position" = 0))),
    1, 'the other participant votes');
SELECT ok(EXISTS (SELECT 1 FROM realtime.messages
                   WHERE topic = 'dm-conversation-77777777-0000-0000-0000-000000000007'
                     AND event = 'poll_event' AND payload ->> 'poll_id' = current_setting('t.dm')),
          'a DM vote broadcasts on the conversation topic');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is_empty(
    $q$SELECT 1 FROM public.get_message_polls(ARRAY[current_setting('t.dm')::uuid])$q$,
    'a non-participant reads nothing');

-- Message guards still apply ---------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok(
    $q$SELECT public.create_message_poll('f0110000-0000-0000-0000-000000000003', NULL, 'One', ARRAY['a', 'b'], false, 1)$q$,
    'a poll is posted in a slowmode channel');
SELECT throws_like(
    $q$SELECT public.create_message_poll('f0110000-0000-0000-0000-000000000003', NULL, 'Two', ARRAY['a', 'b'], false, 1)$q$,
    'SLOWMODE_ACTIVE:%', 'slowmode refuses a second poll');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$SELECT public.upsert_server_automod_rule('55555555-0000-0000-0000-000000000005',
         '{"name": "Words", "rule_type": "keyword", "config": {"keywords": ["badword"]},
           "actions": {"block": true}}'::jsonb)$q$,
    'the owner adds a keyword rule');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(
    public.create_message_poll('66666666-0000-0000-0000-000000000006', NULL, 'Best badword?', ARRAY['a', 'b'], false, 1),
    NULL, 'AutoMod drops a poll whose question it blocks');
SELECT is(
    public.create_message_poll('66666666-0000-0000-0000-000000000006', NULL, 'Fine?', ARRAY['yes', 'badword'], false, 1),
    NULL, 'AutoMod reads the answers');
SELECT is_empty(
    $q$SELECT 1 FROM public.messages WHERE content -> 0 ->> 'question' IN ('Best badword?', 'Fine?')
       UNION ALL SELECT 1 FROM public.message_polls WHERE question IN ('Best badword?', 'Fine?')$q$,
    'a dropped poll leaves no message or poll row');

SELECT tests.clear_authentication();
INSERT INTO public.server_member_timeouts (server_id, user_id, until)
VALUES ('55555555-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002', now() + interval '1 hour');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_like(
    $q$SELECT public.create_message_poll('66666666-0000-0000-0000-000000000006', NULL, 'Q', ARRAY['a', 'b'], false, 1)$q$,
    'MEMBER_TIMED_OUT:%', 'a timed-out member cannot post a poll');

-- Deletion ---------------------------------------------------------------------------------
SELECT lives_ok(
    $q$UPDATE public.messages SET content = '[{"type": "text", "text": "[deleted]"}]'::jsonb, is_deleted = true
        WHERE id = current_setting('t.msg')::uuid$q$,
    'the author soft-deletes a poll message');
SELECT is_empty(
    $q$SELECT 1 FROM public.get_message_polls(ARRAY[current_setting('t.poll')::uuid])$q$,
    'a deleted message''s poll reads as absent');
SELECT throws_ok(
    $q$SELECT * FROM public.vote_message_poll(current_setting('t.poll')::uuid, '{}')$q$,
    'P0002', NULL, 'a deleted message''s poll takes no vote');

SELECT tests.clear_authentication();
DELETE FROM public.messages WHERE id = current_setting('t.msg')::uuid;
SELECT is(
    (SELECT count(*)::int FROM public.message_poll_votes WHERE poll_id = current_setting('t.poll')::uuid)
    + (SELECT count(*)::int FROM public.message_poll_options WHERE poll_id = current_setting('t.poll')::uuid)
    + (SELECT count(*)::int FROM public.message_polls WHERE id = current_setting('t.poll')::uuid),
    0, 'removing the message removes the poll, its answers and votes');

SELECT * FROM finish();
ROLLBACK;
