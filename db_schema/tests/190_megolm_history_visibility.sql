-- 20261028200001_megolm_history_visibility.sql: history visibility per channel, the key scope
-- rule, and where it is enforced (fulfil RPC, direct fulfil, listing, broadcast, shares).
--
--   alice    owns server_1 (joined 10 days ago); sent sessions s190old (5 days ago, index 1
--            pinned) and s190new (1 hour ago) in channel 66666666-...-06
--   bob      member of server_1 (joined 10 days ago)
--   carol    joined server_1 and group g190 1 day ago
--   mallory  in no server
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(55);

-- Setup, as postgres. -------------------------------------------------------------------
INSERT INTO auth.users (id, instance_id, aud, role, email)
VALUES ('eeeeeeee-0000-0000-0000-000000000190', '00000000-0000-0000-0000-000000000000',
        'authenticated', 'authenticated', 'carol190@test.local');
INSERT INTO public.profiles (id, auth_user_id, username, display_name, is_local)
VALUES ('19000000-0000-0000-0000-000000000001', 'eeeeeeee-0000-0000-0000-000000000190', 'carol190', 'Carol', true);
UPDATE public.user_servers SET created_at = now() - interval '10 days'
 WHERE server_id = '55555555-0000-0000-0000-000000000005';
INSERT INTO public.user_servers (user_id, server_id, status, created_at)
VALUES ('19000000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'accepted',
        now() - interval '1 day');

CREATE TEMP TABLE m190 (name text PRIMARY KEY, id uuid);
INSERT INTO m190 VALUES
  ('old0', '19010000-0000-0000-0000-000000000000'), ('old1', '19010000-0000-0000-0000-000000000001'),
  ('old2', '19010000-0000-0000-0000-000000000002'), ('new0', '19010000-0000-0000-0000-000000000010'),
  ('bobfake', '19010000-0000-0000-0000-000000000020'),
  ('gold', '19010000-0000-0000-0000-000000000030'), ('gnew', '19010000-0000-0000-0000-000000000031'),
  ('dm', '19010000-0000-0000-0000-000000000040');
GRANT SELECT ON m190 TO authenticated;

INSERT INTO public.messages (id, channel_id, user_id, content, encrypted, encryption_metadata, is_pinned, created_at)
SELECT v.id, '66666666-0000-0000-0000-000000000006', v.author, '[{"type":"text","text":"ct"}]'::jsonb, true,
       jsonb_build_object('algorithm', 'megolm_v3', 'session_id', v.session, 'message_index', v.idx,
                          'sender_user_id', v.author),
       v.pinned, now() - v.age
  FROM (VALUES
        ('19010000-0000-0000-0000-000000000000'::uuid, '11111111-0000-0000-0000-000000000001'::uuid, 's190old', 0, false, interval '5 days'),
        ('19010000-0000-0000-0000-000000000001'::uuid, '11111111-0000-0000-0000-000000000001'::uuid, 's190old', 1, true,  interval '5 days'),
        ('19010000-0000-0000-0000-000000000002'::uuid, '11111111-0000-0000-0000-000000000001'::uuid, 's190old', 2, false, interval '4 days'),
        ('19010000-0000-0000-0000-000000000010'::uuid, '11111111-0000-0000-0000-000000000001'::uuid, 's190new', 0, false, interval '1 hour'),
        ('19010000-0000-0000-0000-000000000020'::uuid, '22222222-0000-0000-0000-000000000002'::uuid, 's190new', 0, false, interval '5 days')
       ) v(id, author, session, idx, pinned, age);

INSERT INTO public.megolm_session_shares (session_id, room_id, sender_user_id, recipient_user_id, encrypted_session_key, created_at)
VALUES ('s190old', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
        '22222222-0000-0000-0000-000000000002', 'k', now() - interval '5 days'),
       ('s190new', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
        '22222222-0000-0000-0000-000000000002', 'k', now() - interval '1 hour');

INSERT INTO public.conversations (id, type, name) VALUES ('19020000-0000-0000-0000-000000000001', 'group', 'G190');
INSERT INTO public.conversation_participants (conversation_id, user_id, joined_at) VALUES
  ('19020000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', now() - interval '10 days'),
  ('19020000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', now() - interval '10 days'),
  ('19020000-0000-0000-0000-000000000001', '19000000-0000-0000-0000-000000000001', now() - interval '1 day');
INSERT INTO public.messages (id, conversation_id, user_id, content, encrypted, encryption_metadata, created_at)
SELECT v.id, v.room, '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"ct"}]'::jsonb, true,
       jsonb_build_object('algorithm', 'megolm_v3', 'session_id', v.session, 'message_index', 0,
                          'sender_user_id', '11111111-0000-0000-0000-000000000001'),
       now() - v.age
  FROM (VALUES
        ('19010000-0000-0000-0000-000000000030'::uuid, '19020000-0000-0000-0000-000000000001'::uuid, 's190gold', interval '5 days'),
        ('19010000-0000-0000-0000-000000000031'::uuid, '19020000-0000-0000-0000-000000000001'::uuid, 's190gnew', interval '1 hour'),
        ('19010000-0000-0000-0000-000000000040'::uuid, '77777777-0000-0000-0000-000000000007'::uuid, 's190dm',   interval '30 days')
       ) v(id, room, session, age);

CREATE OR REPLACE FUNCTION pg_temp.scope(p_room text, p_session text, p_user uuid, p_message text DEFAULT NULL)
RETURNS text LANGUAGE sql AS $fn$
  SELECT public.megolm_key_scope_allowed(p_room, p_session, '11111111-0000-0000-0000-000000000001', p_user,
                                         (SELECT id FROM m190 WHERE name = p_message))
$fn$;

-- Setting. ------------------------------------------------------------------------------
SELECT is(public.room_history_visibility('66666666-0000-0000-0000-000000000006'), 'all',
  'a channel shows all history by default');
SELECT is((SELECT column_default FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'channel_encryption_settings'
              AND column_name = 'history_visibility'), '''all''::text',
  'new settings rows default to all');
SELECT is(public.room_history_visibility('19020000-0000-0000-0000-000000000001'), 'none',
  'a group conversation shows no earlier history');
SELECT is(public.room_history_visibility('77777777-0000-0000-0000-000000000007'), 'none',
  'a direct conversation has the same rule');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.set_channel_history_visibility('66666666-0000-0000-0000-000000000006', 'none')$q$,
  '42501', NULL, 'a member without MANAGE_CHANNELS cannot change it');
SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000190');
SELECT throws_ok($q$SELECT public.set_channel_history_visibility('66666666-0000-0000-0000-000000000006', 'all')$q$,
  '42501', NULL, 'nor can a newcomer');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.set_channel_history_visibility('66666666-0000-0000-0000-000000000006', 'everyone')$q$,
  '22023', 'Unknown history visibility: everyone', 'an unknown value is refused');
SELECT is(public.set_channel_encryption('66666666-0000-0000-0000-000000000006', NULL, NULL, 'shared')->>'history_visibility',
  'all', 'the legacy argument shared is stored as all');
SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.set_channel_history_visibility('66666666-0000-0000-0000-000000000006', 'none')$q$,
  '42501', NULL, 'anon cannot change it');

-- all. ----------------------------------------------------------------------------------
SELECT tests.clear_authentication();
SELECT is(pg_temp.scope('66666666-0000-0000-0000-000000000006', 's190old', '19000000-0000-0000-0000-000000000001'),
  'session', 'all: a newcomer receives a session that began before they joined');

-- pinned. -------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.set_channel_history_visibility('66666666-0000-0000-0000-000000000006', 'pinned')->>'history_visibility',
  'pinned', 'the owner sets pinned only');
SELECT tests.clear_authentication();
SELECT is(pg_temp.scope('66666666-0000-0000-0000-000000000006', 's190old', '19000000-0000-0000-0000-000000000001'),
  NULL, 'pinned: no session key of an earlier session');
SELECT is(pg_temp.scope('66666666-0000-0000-0000-000000000006', 's190old', '19000000-0000-0000-0000-000000000001', 'old1'),
  'message', 'pinned: the key of its pinned message');
SELECT is(pg_temp.scope('66666666-0000-0000-0000-000000000006', 's190old', '19000000-0000-0000-0000-000000000001', 'old0'),
  NULL, 'pinned: nothing for an unpinned neighbour');
SELECT is(pg_temp.scope('66666666-0000-0000-0000-000000000006', 's190new', '19000000-0000-0000-0000-000000000001'),
  'session', 'a session that began after the member joined is theirs');
SELECT is(pg_temp.scope('66666666-0000-0000-0000-000000000006', 's190old', '22222222-0000-0000-0000-000000000002'),
  'session', 'a member present when the session began receives it');
SELECT is(pg_temp.scope('66666666-0000-0000-0000-000000000006', 's190unseen', '19000000-0000-0000-0000-000000000001'),
  'session', 'a session with no message or share yet begins now');
SELECT is(pg_temp.scope('66666666-0000-0000-0000-000000000006', 's190old', '33333333-0000-0000-0000-000000000003', 'old1'),
  NULL, 'a user outside the server receives nothing');
SELECT ok(public.megolm_session_began_before('66666666-0000-0000-0000-000000000006', 's190new', NULL, now() - interval '2 days'),
  'any author''s message counts when no sender is named');
SELECT ok(NOT public.megolm_session_began_before('66666666-0000-0000-0000-000000000006', 's190new',
                                                 '11111111-0000-0000-0000-000000000001', now() - interval '2 days'),
  'another member''s message naming the session does not move its sender''s start');

-- none. ---------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.set_channel_history_visibility('66666666-0000-0000-0000-000000000006', 'none')->>'history_visibility',
  'none', 'the owner sets none');
SELECT tests.clear_authentication();
SELECT is(pg_temp.scope('66666666-0000-0000-0000-000000000006', 's190old', '19000000-0000-0000-0000-000000000001', 'old1'),
  NULL, 'none: not even a pinned message');
SELECT is(pg_temp.scope('66666666-0000-0000-0000-000000000006', 's190new', '19000000-0000-0000-0000-000000000001'),
  'session', 'none: a later session is still theirs');

-- Conversations. ------------------------------------------------------------------------
SELECT is(pg_temp.scope('19020000-0000-0000-0000-000000000001', 's190gold', '19000000-0000-0000-0000-000000000001'),
  NULL, 'group conversation: no session that began before the member was added');
SELECT is(pg_temp.scope('19020000-0000-0000-0000-000000000001', 's190gnew', '19000000-0000-0000-0000-000000000001'),
  'session', 'group conversation: a later session is theirs');
SELECT is(pg_temp.scope('19020000-0000-0000-0000-000000000001', 's190gold', '22222222-0000-0000-0000-000000000002'),
  'session', 'group conversation: an original member receives it');
SELECT is(pg_temp.scope('77777777-0000-0000-0000-000000000007', 's190dm', '22222222-0000-0000-0000-000000000002'),
  'session', 'direct conversation: a session older than the participant row is still theirs');

-- Key requests under none, then pinned. --------------------------------------------------
DELETE FROM realtime.messages;
SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000190');
INSERT INTO public.megolm_key_requests (id, requester_user_id, sender_user_id, room_id, session_id, accepts_relay, message_id, message_index, key_scope)
VALUES ('19030000-0000-0000-0000-000000000001', '19000000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
        '66666666-0000-0000-0000-000000000006', 's190old', true, (SELECT id FROM m190 WHERE name = 'old0'), 99, 'session'),
       ('19030000-0000-0000-0000-000000000002', '19000000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
        '66666666-0000-0000-0000-000000000006', 's190old', true, (SELECT id FROM m190 WHERE name = 'old1'), 99, NULL),
       ('19030000-0000-0000-0000-000000000003', '19000000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
        '66666666-0000-0000-0000-000000000006', 's190old', true, (SELECT id FROM m190 WHERE name = 'new0'), NULL, NULL),
       ('19030000-0000-0000-0000-000000000004', '19000000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
        '66666666-0000-0000-0000-000000000006', 's190new', true, (SELECT id FROM m190 WHERE name = 'new0'), NULL, NULL);
SELECT tests.clear_authentication();

SELECT is((SELECT message_index::text || ' ' || coalesce(key_scope, '-') FROM public.megolm_key_requests
            WHERE id = '19030000-0000-0000-0000-000000000002'),
  '1 -', 'the message index comes from the message row; a client index or scope is dropped');
SELECT ok((SELECT message_id IS NULL AND message_index IS NULL FROM public.megolm_key_requests
            WHERE id = '19030000-0000-0000-0000-000000000003'),
  'a message of another session is not named');
SELECT is((SELECT string_agg(DISTINCT payload->>'id', ',') FROM realtime.messages
            WHERE payload->>'type' = 'encryption:key_request'),
  '19030000-0000-0000-0000-000000000004', 'none: only the request for a later session is broadcast');
SELECT is((SELECT payload->>'key_scope' FROM realtime.messages
            WHERE payload->>'id' = '19030000-0000-0000-0000-000000000004' LIMIT 1),
  'session', 'the broadcast names the scope');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT array_agg(id::text || ':' || key_scope ORDER BY id)::text FROM public.get_relayable_key_requests()),
  '{19030000-0000-0000-0000-000000000004:session}', 'none: a relay lists only the later session');
SELECT throws_ok($q$SELECT public.fulfill_megolm_key_request('19030000-0000-0000-0000-000000000002', 'v2:k', 'message')$q$,
  '42501', 'the requester may not receive this key', 'none: a pinned message key is refused');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$UPDATE public.megolm_key_requests SET status = 'fulfilled', encrypted_key = 'v2:k'
                    WHERE id = '19030000-0000-0000-0000-000000000001'$q$,
  '42501', 'the requester may not receive this key',
  'the sender''s direct update (older apps) cannot hand over an earlier session');
SELECT lives_ok($q$UPDATE public.megolm_key_requests SET status = 'fulfilled', encrypted_key = 'v2:k'
                   WHERE id = '19030000-0000-0000-0000-000000000004'$q$,
  'the sender''s direct update hands over a later session');
SELECT is(public.set_channel_history_visibility('66666666-0000-0000-0000-000000000006', 'pinned')->>'history_visibility',
  'pinned', 'back to pinned only');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT array_agg(id::text || ':' || key_scope || ':' || message_index ORDER BY id)::text
             FROM public.get_relayable_key_requests()),
  '{19030000-0000-0000-0000-000000000002:message:1}', 'pinned: a relay lists the pinned message with its index');
SELECT throws_ok($q$SELECT public.fulfill_megolm_key_request('19030000-0000-0000-0000-000000000002', 'v2:k', 'session')$q$,
  '42501', 'the requester may not receive this key', 'pinned: the session key is refused');
SELECT throws_ok($q$SELECT public.fulfill_megolm_key_request('19030000-0000-0000-0000-000000000001', 'v2:k', 'message')$q$,
  '42501', 'the requester may not receive this key', 'pinned: an unpinned message key is refused');
SELECT throws_ok($q$SELECT public.fulfill_megolm_key_request('19030000-0000-0000-0000-000000000003', 'v2:k', 'message')$q$,
  '22023', 'the request names no message', 'a message key needs a named message');
SELECT throws_ok($q$SELECT public.fulfill_megolm_key_request('19030000-0000-0000-0000-000000000002', 'v2:k', 'any')$q$,
  '22023', 'invalid key scope', 'an unknown scope is refused');
SELECT ok(public.fulfill_megolm_key_request('19030000-0000-0000-0000-000000000002', 'v2:k', 'message'),
  'pinned: a relay hands over the pinned message key');
SELECT tests.clear_authentication();
SELECT is((SELECT status || ' ' || key_scope FROM public.megolm_key_requests WHERE id = '19030000-0000-0000-0000-000000000002'),
  'fulfilled message', 'the answer records its scope');

SELECT tests.authenticate_as('eeeeeeee-0000-0000-0000-000000000190');
SELECT throws_ok($q$UPDATE public.megolm_key_requests SET message_id = (SELECT id FROM m190 WHERE name = 'old2')
                    WHERE id = '19030000-0000-0000-0000-000000000001'$q$,
  '42501', NULL, 'a requester cannot repoint a request at another message');
SELECT lives_ok($q$UPDATE public.megolm_key_requests SET status = 'cancelled'
                   WHERE id = '19030000-0000-0000-0000-000000000001'$q$,
  'a requester still cancels their request');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.set_channel_history_visibility('66666666-0000-0000-0000-000000000006', 'all')->>'history_visibility',
  'all', 'switched to all');
SELECT tests.clear_authentication();
UPDATE public.megolm_key_requests SET status = 'pending' WHERE id = '19030000-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT key_scope FROM public.get_relayable_key_requests() WHERE id = '19030000-0000-0000-0000-000000000001'),
  'session', 'after a switch to all a waiting request is answerable with the session key');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.set_channel_history_visibility('66666666-0000-0000-0000-000000000006', 'none')->>'history_visibility',
  'none', 'switched to none');

-- Session shares. -----------------------------------------------------------------------
SELECT is_empty($q$INSERT INTO public.megolm_session_shares (session_id, room_id, sender_user_id, recipient_user_id, encrypted_session_key)
                   VALUES ('s190old', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
                           '19000000-0000-0000-0000-000000000001', 'k') RETURNING id$q$,
  'none: the sender''s share of an earlier session to a newcomer is skipped');
SELECT isnt_empty($q$INSERT INTO public.megolm_session_shares (session_id, room_id, sender_user_id, recipient_user_id, encrypted_session_key)
                     VALUES ('s190new', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
                             '19000000-0000-0000-0000-000000000001', 'k') RETURNING id$q$,
  'none: a later session is shared');
SELECT isnt_empty($q$INSERT INTO public.megolm_session_shares (session_id, room_id, sender_user_id, recipient_user_id, encrypted_session_key)
                     VALUES ('s190fresh', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
                             '19000000-0000-0000-0000-000000000001', 'k') RETURNING id$q$,
  'none: a brand-new session is shared');
SELECT is_empty($q$INSERT INTO public.megolm_session_shares (session_id, room_id, sender_user_id, recipient_user_id, encrypted_session_key)
                   VALUES ('s190gold', '19020000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001',
                           '19000000-0000-0000-0000-000000000001', 'k') RETURNING id$q$,
  'group conversation: an earlier session is not shared with an added member');
SELECT is(public.set_channel_history_visibility('66666666-0000-0000-0000-000000000006', 'all')->>'history_visibility',
  'all', 'switched to all again');
SELECT isnt_empty($q$INSERT INTO public.megolm_session_shares (session_id, room_id, sender_user_id, recipient_user_id, encrypted_session_key)
                     VALUES ('s190old', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
                             '19000000-0000-0000-0000-000000000001', 'k') RETURNING id$q$,
  'all: an earlier session is shared');
SELECT tests.clear_authentication();

SELECT throws_ok($q$UPDATE public.megolm_key_requests SET key_scope = 'everything'
                    WHERE id = '19030000-0000-0000-0000-000000000002'$q$,
  '23514', NULL, 'key_scope is session or message');

SELECT * FROM finish();
ROLLBACK;
