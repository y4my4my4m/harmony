-- 20261028400001_group_authored_messages.sql: a message no profile wrote (a bot, a channel
-- webhook, a person a bridge relays) is queued for the Group of a local server; a client cannot
-- pose as a remote bot or name its message after a host's.
--
-- Fixture server_1: alice owns it, bob is a member. Added here:
--   bot192      a bot of alice's
--   copy192     a server reference (is_local_server false) with channel far192

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(10);

INSERT INTO public.bots (id, username, display_name, owner_id, is_public)
VALUES ('f1920000-0000-0000-0000-0000000000b1', 'bot192', 'Bot 192', '11111111-0000-0000-0000-000000000001', false);
INSERT INTO public.servers (id, name, owner, is_local_server, host_domain)
VALUES ('f1920000-0000-0000-0000-0000000000a1', 'Copy 192', '11111111-0000-0000-0000-000000000001', false, 'remote.test');
INSERT INTO public.channels (id, server_id, name, type)
VALUES ('f1920000-0000-0000-0000-0000000000c1', 'f1920000-0000-0000-0000-0000000000a1', 'far192', 0);

-- Queueing. ---------------------------------------------------------------------------------------
INSERT INTO public.messages (id, channel_id, bot_id, content, metadata) VALUES
  ('f1920000-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006',
   'f1920000-0000-0000-0000-0000000000b1', '[{"type":"text","text":"from a bot"}]', '{}'),
  ('f1920000-0000-0000-0000-000000000002', '66666666-0000-0000-0000-000000000006',
   'f1920000-0000-0000-0000-0000000000b1', '[{"type":"text","text":"from a webhook"}]',
   '{"webhook":{"id":"w192","name":"CI","avatar_url":null}}'),
  ('f1920000-0000-0000-0000-000000000003', '66666666-0000-0000-0000-000000000006',
   'f1920000-0000-0000-0000-0000000000b1', '[{"type":"text","text":"from Discord"}]',
   '{"discord_user":{"id":"42","username":"dana"},"bridge_source":"discord"}'),
  ('f1920000-0000-0000-0000-000000000004', 'f1920000-0000-0000-0000-0000000000c1',
   'f1920000-0000-0000-0000-0000000000b1', '[{"type":"text","text":"a bot in a copy"}]', '{}'),
  ('f1920000-0000-0000-0000-000000000005', '66666666-0000-0000-0000-000000000006',
   NULL, '[{"type":"text","text":"no author"}]', '{}'),
  ('f1920000-0000-0000-0000-000000000006', 'f1920000-0000-0000-0000-0000000000c1',
   NULL, '[{"type":"text","text":"a remote webhook"}]',
   '{"federated":true,"ap_id":"https://remote.test/messages/f1920000-0000-0000-0000-000000000006","remote_author":{"kind":"webhook","id":"w1","name":"CI","avatar_url":null}}');

SELECT results_eq(
    $q$SELECT federation_status FROM public.messages
        WHERE id IN ('f1920000-0000-0000-0000-000000000001', 'f1920000-0000-0000-0000-000000000002',
                     'f1920000-0000-0000-0000-000000000003')
        ORDER BY id$q$,
    $q$VALUES ('queued'::text), ('queued'), ('queued')$q$,
    'a bot, webhook or bridged message of a local server is queued for its Group');
SELECT is((SELECT federation_status FROM public.messages WHERE id = 'f1920000-0000-0000-0000-000000000004'),
          'skipped', 'a bot row in a copy is not federated from here');
SELECT is((SELECT federation_status FROM public.messages WHERE id = 'f1920000-0000-0000-0000-000000000005'),
          'skipped', 'a row with neither profile nor bot is not federated');
SELECT is((SELECT federation_status FROM public.messages WHERE id = 'f1920000-0000-0000-0000-000000000006'),
          'skipped', 'a remote bot''s message stored in a copy is not federated again');
SELECT is((SELECT federation_status FROM public.messages WHERE id = '88888888-0000-0000-0000-000000000008'),
          'queued', 'an ordinary message of a local member still is');

-- Reserved keys. ----------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content, metadata)
       VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"x"}]', '{"remote_author":{"kind":"bot","id":"b","name":"Fake"}}')$q$,
    '42501', 'metadata key reserved for the server: remote_author',
    'a client cannot pose as a remote bot');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content, metadata)
       VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"x"}]', '{"host_ap_id":"https://remote.test/messages/x"}')$q$,
    '42501', 'metadata key reserved for the server: host_ap_id',
    'a client cannot name its message after a host''s');
SELECT throws_ok(
    $q$UPDATE public.messages
          SET metadata = metadata || '{"host_ap_id":"https://remote.test/messages/x"}'
        WHERE id = '88888888-0000-0000-0000-000000000008'$q$,
    '42501', 'metadata key reserved for the server: host_ap_id',
    'nor add one to a message it wrote');
SELECT lives_ok(
    $q$UPDATE public.messages SET content = '[{"type":"text","text":"edited"}]'
        WHERE id = '88888888-0000-0000-0000-000000000008'$q$,
    'the author edits the text');
SELECT tests.clear_authentication();

SET LOCAL ROLE service_role;
UPDATE public.messages
   SET metadata = metadata || '{"remote_author":{"kind":"webhook","id":"w1","name":"CI 2","avatar_url":null}}'
 WHERE id = 'f1920000-0000-0000-0000-000000000006';
RESET ROLE;
SELECT is((SELECT metadata -> 'remote_author' ->> 'name' FROM public.messages
            WHERE id = 'f1920000-0000-0000-0000-000000000006'),
          'CI 2', 'the federation backend writes remote_author');

SELECT * FROM finish();
ROLLBACK;
