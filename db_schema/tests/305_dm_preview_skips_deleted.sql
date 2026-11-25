-- Deleted direct messages leave the conversation list's preview after 20261118100001.
--
-- Fixture DM 77777777: alice and bob, with alice's 'dm message' 99999999. Added: alice's 'first'
-- and 'second', one and two minutes later; mallory, who left the conversation; and a remote
-- participant. preview() is last_message of the fixture DM in get_user_conversations() as alice.
-- sent() is every conversation:message_deleted event, as topic and payload; realtime.send adds
-- the payload's id key.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(15);

INSERT INTO auth.users (id, instance_id, aud, role, email) VALUES
  ('c3050000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'remote@c305.test');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local, domain) VALUES
  ('c3051000-0000-0000-0000-000000000001', 'c3050000-0000-0000-0000-000000000001', 'remote305', 'Remote', false, 'remote.c305.test');
INSERT INTO public.conversation_participants (conversation_id, user_id, left_at) VALUES
  ('77777777-0000-0000-0000-000000000007', '33333333-0000-0000-0000-000000000003', now()),
  ('77777777-0000-0000-0000-000000000007', 'c3051000-0000-0000-0000-000000000001', NULL);

INSERT INTO public.messages (id, conversation_id, user_id, content, created_at) VALUES
  ('c3052000-0000-0000-0000-000000000001', '77777777-0000-0000-0000-000000000007',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"first"}]', now() + interval '1 minute'),
  ('c3052000-0000-0000-0000-000000000002', '77777777-0000-0000-0000-000000000007',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"second"}]', now() + interval '2 minutes');

CREATE FUNCTION pg_temp.preview() RETURNS jsonb LANGUAGE plpgsql AS $fn$
DECLARE
    v jsonb;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-0000-0000-000000000001', true);
    PERFORM set_config('request.jwt.claims', '{"sub": "aaaaaaaa-0000-0000-0000-000000000001"}', true);
    SELECT e->'last_message' INTO v
      FROM jsonb_array_elements(public.get_user_conversations()) e
     WHERE e->>'conversation_id' = '77777777-0000-0000-0000-000000000007';
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '', true);
    RETURN v;
END;
$fn$;

CREATE FUNCTION pg_temp.sent() RETURNS TABLE (topic text, payload jsonb) LANGUAGE sql AS $fn$
    SELECT m.topic, m.payload
      FROM realtime.messages m
     WHERE m.payload->>'type' = 'conversation:message_deleted'
     ORDER BY m.topic
$fn$;

-- Preview ---------------------------------------------------------------------------------------
SELECT is(pg_temp.preview()->>'id', 'c3052000-0000-0000-0000-000000000002', 'the newest message is the preview');

DELETE FROM realtime.messages;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
-- Same write as CoreMessageService.deleteMessage.
UPDATE public.messages
   SET content = '[{"type":"text","text":"[deleted]"}]', is_deleted = true
 WHERE id = 'c3052000-0000-0000-0000-000000000002';
RESET ROLE;
SELECT tests.clear_authentication();

SELECT is(pg_temp.preview()->>'id', 'c3052000-0000-0000-0000-000000000001',
          'a deleted newest message gives way to the one before it');
SELECT is(pg_temp.preview()->'content'->0->>'text', 'first', 'whose content is shown');

-- Events ----------------------------------------------------------------------------------------
SELECT results_eq(
    'SELECT topic FROM pg_temp.sent()',
    ARRAY['user:11111111-0000-0000-0000-000000000001', 'user:22222222-0000-0000-0000-000000000002'],
    'the delete reaches each active local participant, the author included, once');
SELECT is_empty(
    $q$SELECT 1 FROM pg_temp.sent()
        WHERE payload - 'id' <> jsonb_build_object('type', 'conversation:message_deleted',
                                            'conversation_id', '77777777-0000-0000-0000-000000000007',
                                            'message_id', 'c3052000-0000-0000-0000-000000000002')$q$,
    'the event carries the conversation and message ids and nothing else');

-- A federated Delete sets is_deleted alone and keeps the content (ActivityProcessor.processDelete).
DELETE FROM realtime.messages;
UPDATE public.messages SET is_deleted = true WHERE id = 'c3052000-0000-0000-0000-000000000001';
SELECT is(pg_temp.preview()->>'id', '99999999-0000-0000-0000-000000000009',
          'a row deleted with its content kept is not the preview either');
SELECT is((SELECT count(*)::int FROM pg_temp.sent()), 2, 'and sends the same two events');

DELETE FROM realtime.messages;
UPDATE public.messages SET is_deleted = true WHERE id = 'c3052000-0000-0000-0000-000000000001';
SELECT is_empty('SELECT 1 FROM pg_temp.sent()', 'deleting a deleted row again sends nothing');

UPDATE public.messages SET content = '[{"type":"text","text":"edited"}]'
 WHERE id = '99999999-0000-0000-0000-000000000009';
SELECT is_empty('SELECT 1 FROM pg_temp.sent()', 'an edit sends nothing');

UPDATE public.messages SET is_deleted = true WHERE id = '88888888-0000-0000-0000-000000000008';
SELECT is_empty('SELECT 1 FROM pg_temp.sent()', 'a channel message delete sends nothing');

UPDATE public.messages SET is_deleted = false WHERE id = 'c3052000-0000-0000-0000-000000000001';
SELECT is_empty('SELECT 1 FROM pg_temp.sent()', 'restoring a row sends nothing');
SELECT is(pg_temp.preview()->>'id', 'c3052000-0000-0000-0000-000000000001', 'and makes it the preview again');

-- Nothing left ----------------------------------------------------------------------------------
UPDATE public.messages SET is_deleted = true
 WHERE conversation_id = '77777777-0000-0000-0000-000000000007';
SELECT is(pg_temp.preview(), 'null'::jsonb, 'a conversation with every message deleted has no preview');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT ok(EXISTS (SELECT 1 FROM jsonb_array_elements(public.get_user_conversations()) e
                   WHERE e->>'conversation_id' = '77777777-0000-0000-0000-000000000007'),
          'and stays in the list');
RESET ROLE;
SELECT tests.clear_authentication();

-- The preview lookup is the partial index's predicate.
SELECT ok(pg_get_functiondef('public.get_user_conversations()'::regprocedure)
            ~ 'AND m\.thread_id IS NULL\s+AND \(m\.is_deleted IS NULL OR m\.is_deleted = false\)',
          'last_message reads rows under the predicate of idx_messages_conversation_created');

SELECT * FROM finish();
ROLLBACK;
