-- Unread badges after 20261011100001_unread_badge_fixes.sql.
--
-- Fixture server_1: alice owns it, bob is a member, mallory is not; alice and bob share the
-- fixture DM. Added: channel #c114 in server_1 and thread t114 on its first message.
-- uc(user, channel, conversation) is get_unread_counts() as that user for one context:
-- 'messages/mentions/muted', or 'none' without a row.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(23);

INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f1140000-0000-0000-0000-0000000000c1', '55555555-0000-0000-0000-000000000005', 'c114', 0);

CREATE TEMP TABLE m114 (label text PRIMARY KEY, id uuid);

CREATE FUNCTION pg_temp.msg(p_author uuid, p_label text, p_thread uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
    v_id uuid;
BEGIN
    INSERT INTO public.messages (channel_id, user_id, content, thread_id)
    VALUES ('f1140000-0000-0000-0000-0000000000c1', p_author, '[{"type":"text","text":"m114"}]', p_thread)
    RETURNING id INTO v_id;
    INSERT INTO m114 VALUES (p_label, v_id);
END;
$fn$;

CREATE FUNCTION pg_temp.uc(p_auth uuid, p_channel uuid, p_conversation uuid) RETURNS text
LANGUAGE plpgsql AS $fn$
DECLARE
    v text;
BEGIN
    PERFORM set_config('request.jwt.claim.sub', p_auth::text, true);
    PERFORM set_config('request.jwt.claims', json_build_object('sub', p_auth)::text, true);
    SELECT format('%s/%s/%s', g.unread_messages, g.unread_mentions, g.muted::text) INTO v
      FROM public.get_unread_counts() g
     WHERE g.channel_id IS NOT DISTINCT FROM p_channel
       AND g.conversation_id IS NOT DISTINCT FROM p_conversation;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '', true);
    RETURN COALESCE(v, 'none');
END;
$fn$;

-- unread:change payloads sent to bob since the last clear.
CREATE FUNCTION pg_temp.sent_to_bob() RETURNS SETOF jsonb LANGUAGE sql AS $fn$
    SELECT m.payload->'count'
      FROM realtime.messages m
     WHERE m.topic = 'user:22222222-0000-0000-0000-000000000002'
       AND m.payload->>'type' = 'unread:change'
$fn$;

-- Thread replies -------------------------------------------------------------------------
SELECT pg_temp.msg('11111111-0000-0000-0000-000000000001', 'first');
INSERT INTO public.threads (id, channel_id, parent_message_id, name, created_by)
SELECT 'f1140000-0000-0000-0000-0000000000d1', 'f1140000-0000-0000-0000-0000000000c1', m.id, 't114',
       '11111111-0000-0000-0000-000000000001'
  FROM m114 m WHERE m.label = 'first';

SELECT pg_temp.msg('11111111-0000-0000-0000-000000000001', 'reply1', 'f1140000-0000-0000-0000-0000000000d1');

SELECT results_eq(
    $q$SELECT message_seq, last_message_id FROM public.message_heads
        WHERE channel_id = 'f1140000-0000-0000-0000-0000000000c1'$q$,
    $q$SELECT 1::bigint, id FROM m114 WHERE label = 'first'$q$,
    'a thread reply leaves the channel''s message_seq and last message');
SELECT is(pg_temp.uc('bbbbbbbb-0000-0000-0000-000000000002', 'f1140000-0000-0000-0000-0000000000c1', NULL),
          '1/0/false', 'a thread reply does not count toward the channel''s unread messages');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.mark_channel_as_read('f1140000-0000-0000-0000-0000000000c1');
SELECT tests.clear_authentication();
DELETE FROM realtime.messages;
SELECT pg_temp.msg('11111111-0000-0000-0000-000000000001', 'reply2', 'f1140000-0000-0000-0000-0000000000d1');
SELECT is(pg_temp.uc('bbbbbbbb-0000-0000-0000-000000000002', 'f1140000-0000-0000-0000-0000000000c1', NULL),
          'none', 'after a read, a thread reply leaves the channel read');
SELECT is_empty('SELECT * FROM pg_temp.sent_to_bob()', 'and sends the reader no unread:change');

-- Own messages, in the channel and in the thread, keep the seq bookkeeping consistent.
SELECT pg_temp.msg('11111111-0000-0000-0000-000000000001', 'second');
SELECT pg_temp.msg('22222222-0000-0000-0000-000000000002', 'bob_reply', 'f1140000-0000-0000-0000-0000000000d1');
SELECT pg_temp.msg('22222222-0000-0000-0000-000000000002', 'third');
SELECT is((SELECT message_seq FROM public.message_heads WHERE channel_id = 'f1140000-0000-0000-0000-0000000000c1'),
          (SELECT count(*) FROM public.messages
            WHERE channel_id = 'f1140000-0000-0000-0000-0000000000c1' AND thread_id IS NULL
              AND NOT is_system AND NOT is_deleted),
          'message_seq counts the channel''s messages outside threads');
SELECT is(pg_temp.uc('aaaaaaaa-0000-0000-0000-000000000001', 'f1140000-0000-0000-0000-0000000000c1', NULL),
          '1/0/false', 'alice has bob''s channel message unread, not his reply');
SELECT is(pg_temp.uc('bbbbbbbb-0000-0000-0000-000000000002', 'f1140000-0000-0000-0000-0000000000c1', NULL),
          '1/0/false', 'bob has alice''s second message unread; his own messages count for nobody');

-- Muted contexts ---------------------------------------------------------------------------
DELETE FROM realtime.messages;
INSERT INTO public.notification_channels (user_id, server_id, channel_id, muted)
VALUES ('22222222-0000-0000-0000-000000000002', '55555555-0000-0000-0000-000000000005',
        'f1140000-0000-0000-0000-0000000000c1', true);
SELECT is(pg_temp.uc('bbbbbbbb-0000-0000-0000-000000000002', 'f1140000-0000-0000-0000-0000000000c1', NULL),
          '1/0/true', 'a muted channel reports muted with the count frozen at the mute');
SELECT ok((SELECT bool_and((c->>'muted')::boolean) AND count(*) = 1 FROM pg_temp.sent_to_bob() c),
          'muting sends one unread:change carrying muted');

SELECT pg_temp.msg('11111111-0000-0000-0000-000000000001', 'during_mute');
SELECT is(pg_temp.uc('bbbbbbbb-0000-0000-0000-000000000002', 'f1140000-0000-0000-0000-0000000000c1', NULL),
          '1/0/true', 'a message while muted leaves the frozen count');

DELETE FROM realtime.messages;
UPDATE public.notification_channels SET muted = false
 WHERE user_id = '22222222-0000-0000-0000-000000000002' AND channel_id = 'f1140000-0000-0000-0000-0000000000c1';
SELECT is(pg_temp.uc('bbbbbbbb-0000-0000-0000-000000000002', 'f1140000-0000-0000-0000-0000000000c1', NULL),
          '1/0/false', 'unmuting reports the count from before the mute, not muted');
SELECT results_eq(
    $q$SELECT (c->>'muted')::boolean, (c->>'unread_messages')::int FROM pg_temp.sent_to_bob() c$q$,
    $q$VALUES (false, 1)$q$,
    'unmuting sends the settled count, not muted');

-- A mute row whose end has passed is not a mute.
INSERT INTO public.notification_channels (user_id, conversation_id, muted, muted_until)
VALUES ('22222222-0000-0000-0000-000000000002', '77777777-0000-0000-0000-000000000007', true,
        now() - interval '1 minute');
SELECT is(pg_temp.uc('bbbbbbbb-0000-0000-0000-000000000002', NULL, '77777777-0000-0000-0000-000000000007'),
          '1/0/false', 'a lapsed DM mute is not reported muted');
UPDATE public.notification_channels SET muted_until = NULL
 WHERE user_id = '22222222-0000-0000-0000-000000000002' AND conversation_id = '77777777-0000-0000-0000-000000000007';
SELECT is(pg_temp.uc('bbbbbbbb-0000-0000-0000-000000000002', NULL, '77777777-0000-0000-0000-000000000007'),
          '1/0/true', 'an active DM mute is');

-- Reads clear the context's notifications --------------------------------------------------
INSERT INTO public.notifications (id, user_id, type, data) VALUES
  ('f1145000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', 'mention',
   '{"channel_id":"f1140000-0000-0000-0000-0000000000c1","server_id":"55555555-0000-0000-0000-000000000005"}'),
  ('f1145000-0000-0000-0000-000000000002', '22222222-0000-0000-0000-000000000002', 'mention',
   '{"location":{"channel_id":"f1140000-0000-0000-0000-0000000000c1","server_id":"55555555-0000-0000-0000-000000000005"}}'),
  ('f1145000-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000002', 'mention',
   '{"channel_id":"66666666-0000-0000-0000-000000000006","server_id":"55555555-0000-0000-0000-000000000005"}'),
  ('f1145000-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000001', 'mention',
   '{"channel_id":"f1140000-0000-0000-0000-0000000000c1","server_id":"55555555-0000-0000-0000-000000000005"}'),
  ('f1145000-0000-0000-0000-000000000005', '22222222-0000-0000-0000-000000000002', 'dm',
   '{"conversation_id":"77777777-0000-0000-0000-000000000007"}'),
  ('f1145000-0000-0000-0000-000000000006', '22222222-0000-0000-0000-000000000002', 'dm',
   '{"conversation":{"id":"77777777-0000-0000-0000-000000000007"}}'),
  ('f1145000-0000-0000-0000-000000000007', '22222222-0000-0000-0000-000000000002', 'dm',
   '{"conversation_id":"f1140000-0000-0000-0000-0000000000e1"}'),
  ('f1145000-0000-0000-0000-000000000008', '33333333-0000-0000-0000-000000000003', 'mention',
   '{"channel_id":"f1140000-0000-0000-0000-0000000000c1","server_id":"55555555-0000-0000-0000-000000000005"}');

SELECT is(pg_temp.uc('bbbbbbbb-0000-0000-0000-000000000002', 'f1140000-0000-0000-0000-0000000000c1', NULL),
          '1/2/false', 'mentions in the channel count');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT lives_ok($q$SELECT public.mark_channel_as_read('f1140000-0000-0000-0000-0000000000c1')$q$,
                'a member marks the channel read');
SELECT tests.clear_authentication();
SELECT set_eq(
    $q$SELECT id FROM public.notifications WHERE id::text LIKE 'f1145000-%' AND is_read$q$,
    $q$VALUES ('f1145000-0000-0000-0000-000000000001'::uuid), ('f1145000-0000-0000-0000-000000000002'::uuid)$q$,
    'reading a channel marks the reader''s notifications of that channel read, in either data shape');
SELECT ok((SELECT bool_and(read_at IS NOT NULL) FROM public.notifications
            WHERE id IN ('f1145000-0000-0000-0000-000000000001', 'f1145000-0000-0000-0000-000000000002')),
          'with read_at');
SELECT is(pg_temp.uc('bbbbbbbb-0000-0000-0000-000000000002', 'f1140000-0000-0000-0000-0000000000c1', NULL),
          'none', 'and clears the channel''s messages and mentions');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT public.mark_conversation_as_read('77777777-0000-0000-0000-000000000007');
SELECT tests.clear_authentication();
SELECT set_eq(
    $q$SELECT id FROM public.notifications WHERE id::text LIKE 'f1145000-%' AND is_read$q$,
    $q$VALUES ('f1145000-0000-0000-0000-000000000001'::uuid), ('f1145000-0000-0000-0000-000000000002'::uuid),
              ('f1145000-0000-0000-0000-000000000005'::uuid), ('f1145000-0000-0000-0000-000000000006'::uuid)$q$,
    'reading a conversation marks its notifications read and leaves other conversations''');
SELECT is(pg_temp.uc('bbbbbbbb-0000-0000-0000-000000000002', NULL, '77777777-0000-0000-0000-000000000007'),
          'none', 'and clears the conversation');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT public.mark_channel_as_read('f1140000-0000-0000-0000-0000000000c1');
SELECT tests.clear_authentication();
SELECT ok((SELECT NOT is_read FROM public.notifications WHERE id = 'f1145000-0000-0000-0000-000000000008'),
          'reading a channel the caller cannot view marks nothing read');

SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT * FROM public.get_unread_counts()$q$, '42501', NULL,
                 'anon cannot read unread counts');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
