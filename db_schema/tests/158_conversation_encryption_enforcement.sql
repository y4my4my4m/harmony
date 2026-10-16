-- 20261018100001_conversation_encryption_enforcement.sql: encrypted conversations refuse
-- plaintext, and participants are told of a change.
--
--   d1 sender     participant of c_enc (encrypted) and c_plain (no settings row)
--   d2 partner    participant of both
--   d3 left       left c_enc
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(13);

-- 40 bytes of base64: one ciphertext part.
CREATE OR REPLACE FUNCTION pg_temp.enc() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $fn$
  SELECT jsonb_build_array(jsonb_build_object(
           'type', 'text', 'text', 'Q2lwaGVydGV4dENpcGhlcnRleHRDaXBoZXJ0ZXh0Q2lwaGVydGV4dA=='));
$fn$;

INSERT INTO auth.users (id, instance_id, aud, role, email)
SELECT ('f1580000-0000-0000-0000-0000000000' || k)::uuid,
       '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
       'enc158-' || k || '@test.local'
  FROM unnest(ARRAY['d1','d2','d3']) k;

INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
SELECT ('f1581000-0000-0000-0000-0000000000' || k)::uuid,
       ('f1580000-0000-0000-0000-0000000000' || k)::uuid, n, n, true
  FROM (VALUES ('d1', 'dm158_sender'), ('d2', 'dm158_partner'), ('d3', 'dm158_left')) v(k, n);

INSERT INTO public.conversations (id, type, created_by) VALUES
  ('f1582000-0000-0000-0000-000000000001', 'direct', 'f1581000-0000-0000-0000-0000000000d1'),
  ('f1582000-0000-0000-0000-000000000002', 'direct', 'f1581000-0000-0000-0000-0000000000d1');

INSERT INTO public.conversation_participants (conversation_id, user_id, left_at) VALUES
  ('f1582000-0000-0000-0000-000000000001', 'f1581000-0000-0000-0000-0000000000d1', NULL),
  ('f1582000-0000-0000-0000-000000000001', 'f1581000-0000-0000-0000-0000000000d2', NULL),
  ('f1582000-0000-0000-0000-000000000001', 'f1581000-0000-0000-0000-0000000000d3', now()),
  ('f1582000-0000-0000-0000-000000000002', 'f1581000-0000-0000-0000-0000000000d1', NULL),
  ('f1582000-0000-0000-0000-000000000002', 'f1581000-0000-0000-0000-0000000000d2', NULL);

-- Change notice. ------------------------------------------------------------------------
DELETE FROM realtime.messages;
INSERT INTO public.conversation_encryption_settings (conversation_id, encryption_enabled)
VALUES ('f1582000-0000-0000-0000-000000000001', true);

SELECT is((SELECT string_agg(topic, ',' ORDER BY topic) FROM realtime.messages
            WHERE payload->>'type' = 'conversation:encryption'),
  'user:f1581000-0000-0000-0000-0000000000d1,user:f1581000-0000-0000-0000-0000000000d2',
  'turning encryption on tells each active participant, not one who left, on their user channel');
SELECT ok((SELECT bool_and(payload->>'conversation_id' = 'f1582000-0000-0000-0000-000000000001'
                           AND (payload->>'encryption_enabled')::boolean AND private AND event = 'user_event')
             FROM realtime.messages WHERE payload->>'type' = 'conversation:encryption'),
  'the notice names the conversation and its new state, privately');

DELETE FROM realtime.messages;
UPDATE public.conversation_encryption_settings SET updated_at = now()
 WHERE conversation_id = 'f1582000-0000-0000-0000-000000000001';
SELECT is((SELECT count(*)::int FROM realtime.messages WHERE payload->>'type' = 'conversation:encryption'), 0,
  'an update that leaves encryption_enabled alone sends no notice');

-- Plaintext guard, as a client. ---------------------------------------------------------
SELECT tests.authenticate_as('f1580000-0000-0000-0000-0000000000d1');

SELECT throws_ok($q$INSERT INTO public.messages (conversation_id, user_id, content)
  VALUES ('f1582000-0000-0000-0000-000000000001', 'f1581000-0000-0000-0000-0000000000d1',
          '[{"type":"text","text":"in the clear"}]')$q$,
  '23514', 'CONVERSATION_ENCRYPTED: this conversation is end-to-end encrypted and rejects plaintext messages',
  'a plaintext message into an encrypted conversation is refused');

SELECT throws_ok($q$INSERT INTO public.messages (conversation_id, user_id, content, encrypted)
  VALUES ('f1582000-0000-0000-0000-000000000001', 'f1581000-0000-0000-0000-0000000000d1',
          '[{"type":"text","text":"claims to be encrypted"}]', true)$q$,
  '23514', NULL, 'plaintext flagged encrypted without ciphertext and metadata is refused');

SELECT throws_ok($q$INSERT INTO public.messages (conversation_id, user_id, content, metadata)
  VALUES ('f1582000-0000-0000-0000-000000000001', 'f1581000-0000-0000-0000-0000000000d1',
          '[{"type":"text","text":"no consent"}]', '{"plaintext_override":{"authorized":false}}')$q$,
  '23514', NULL, 'an override that is not authorized is refused');

SELECT lives_ok($q$INSERT INTO public.messages (conversation_id, user_id, content, encrypted, encryption_metadata)
  VALUES ('f1582000-0000-0000-0000-000000000001', 'f1581000-0000-0000-0000-0000000000d1',
          pg_temp.enc(), true, '{"algorithm":"megolm_v3","session_id":"s-158","message_index":0}')$q$,
  'an encrypted message is accepted');

SELECT lives_ok($q$INSERT INTO public.messages (conversation_id, user_id, content, metadata)
  VALUES ('f1582000-0000-0000-0000-000000000001', 'f1581000-0000-0000-0000-0000000000d1',
          '[{"type":"text","text":"consented"}]',
          '{"plaintext_override":{"authorized":true,"reason":"dm_encryption_locked"}}')$q$,
  'plaintext the sender consented to (allowPlaintextFallback) is accepted');

SELECT lives_ok($q$INSERT INTO public.messages (conversation_id, user_id, content)
  VALUES ('f1582000-0000-0000-0000-000000000002', 'f1581000-0000-0000-0000-0000000000d1',
          '[{"type":"text","text":"plain conversation"}]')$q$,
  'a conversation without encryption takes plaintext');

SELECT lives_ok($q$UPDATE public.messages SET content = '[{"type":"text","text":"edited consented"}]'
  WHERE conversation_id = 'f1582000-0000-0000-0000-000000000001' AND encrypted IS NOT TRUE$q$,
  'an edit is not checked');

SELECT tests.clear_authentication();

SELECT lives_ok($q$INSERT INTO public.messages (conversation_id, user_id, content)
  VALUES ('f1582000-0000-0000-0000-000000000001', 'f1581000-0000-0000-0000-0000000000d2',
          '[{"type":"text","text":"from a remote server"}]')$q$,
  'a server-side writer (federation backend, bot gateway) is exempt');

-- pgTAP lives in tests, which service_role cannot use: the insert runs bare, checked after.
SET LOCAL ROLE service_role;
INSERT INTO public.messages (conversation_id, user_id, content)
VALUES ('f1582000-0000-0000-0000-000000000001', 'f1581000-0000-0000-0000-0000000000d2',
        '[{"type":"text","text":"service role"}]');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.messages
            WHERE conversation_id = 'f1582000-0000-0000-0000-000000000001'
              AND content = '[{"type":"text","text":"service role"}]'::jsonb), 1,
  'service_role is exempt');

SELECT ok(has_function_privilege('authenticated', 'public.conversation_messages_encrypted(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.conversation_messages_encrypted(uuid)', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.enforce_conversation_message_encryption()', 'EXECUTE')
          AND NOT has_function_privilege('authenticated', 'public.broadcast_conversation_encryption_change()', 'EXECUTE'),
  'grants: the state reader to authenticated, the trigger functions to nobody');

SELECT * FROM finish();
ROLLBACK;
