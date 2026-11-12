-- 20261112100003_server_profile_broadcast.sql: user_servers changes broadcast to
-- server-presence:<server> as presence_event: member:join, member:leave and member:update (the
-- five server profile fields, only when one changes); account pronouns in profile:updated.
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(10);

INSERT INTO public.servers (id, name, owner) VALUES
  ('f2480000-0000-0000-0000-000000000001', 'Broadcast248', '33333333-0000-0000-0000-000000000003');

DELETE FROM realtime.messages WHERE topic = 'server-presence:f2480000-0000-0000-0000-000000000001';

INSERT INTO public.user_servers (user_id, server_id, status) VALUES
  ('11111111-0000-0000-0000-000000000001', 'f2480000-0000-0000-0000-000000000001', 'accepted')
ON CONFLICT (user_id, server_id) DO NOTHING;

SELECT is(
  (SELECT count(*)::int FROM realtime.messages
    WHERE topic = 'server-presence:f2480000-0000-0000-0000-000000000001'
      AND event = 'presence_event' AND payload ->> 'type' = 'member:join'
      AND payload ->> 'user_id' = '11111111-0000-0000-0000-000000000001'),
  1, 'insert still broadcasts member:join');

UPDATE public.user_servers
   SET nickname = 'Ally', pronouns = 'she/her', bio = 'hi'
 WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2480000-0000-0000-0000-000000000001';

SELECT is(
  (SELECT count(*)::int FROM realtime.messages
    WHERE topic = 'server-presence:f2480000-0000-0000-0000-000000000001'
      AND payload ->> 'type' = 'member:update'),
  1, 'a profile column update broadcasts one member:update');
SELECT is(
  (SELECT payload ->> 'nickname' FROM realtime.messages
    WHERE payload ->> 'type' = 'member:update'
      AND topic = 'server-presence:f2480000-0000-0000-0000-000000000001'),
  'Ally', 'member:update carries the new nickname');
SELECT is(
  (SELECT payload - 'id' - 'type' - 'user_id' - 'server_id' FROM realtime.messages
    WHERE payload ->> 'type' = 'member:update'
      AND topic = 'server-presence:f2480000-0000-0000-0000-000000000001'),
  '{"nickname":"Ally","avatar_url":null,"banner_url":null,"bio":"hi","pronouns":"she/her"}'::jsonb,
  'member:update carries all five fields');
SELECT is(
  (SELECT payload ->> 'server_id' FROM realtime.messages
    WHERE payload ->> 'type' = 'member:update'
      AND topic = 'server-presence:f2480000-0000-0000-0000-000000000001'),
  'f2480000-0000-0000-0000-000000000001', 'member:update names the server');

UPDATE public.user_servers
   SET position = 7, muted = true
 WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2480000-0000-0000-0000-000000000001';

SELECT is(
  (SELECT count(*)::int FROM realtime.messages
    WHERE topic = 'server-presence:f2480000-0000-0000-0000-000000000001'
      AND payload ->> 'type' = 'member:update'),
  1, 'updating position and muted broadcasts nothing');

UPDATE public.user_servers
   SET nickname = 'Ally', bio = 'hi'
 WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2480000-0000-0000-0000-000000000001';

SELECT is(
  (SELECT count(*)::int FROM realtime.messages
    WHERE topic = 'server-presence:f2480000-0000-0000-0000-000000000001'
      AND payload ->> 'type' = 'member:update'),
  1, 'writing the same values broadcasts nothing');

-- Account pronouns (20261112100006): profile:updated on each of the member's servers.
UPDATE public.profiles SET pronouns = 'they/them' WHERE id = '11111111-0000-0000-0000-000000000001';

SELECT is(
  (SELECT count(*)::int FROM realtime.messages
    WHERE topic = 'server-presence:f2480000-0000-0000-0000-000000000001'
      AND payload ->> 'type' = 'profile:updated'
      AND payload ->> 'user_id' = '11111111-0000-0000-0000-000000000001'),
  1, 'a change to account pronouns alone broadcasts profile:updated');
SELECT is(
  (SELECT payload ->> 'pronouns' FROM realtime.messages
    WHERE topic = 'server-presence:f2480000-0000-0000-0000-000000000001'
      AND payload ->> 'type' = 'profile:updated'),
  'they/them', 'profile:updated carries the pronouns');

DELETE FROM public.user_servers
 WHERE user_id = '11111111-0000-0000-0000-000000000001' AND server_id = 'f2480000-0000-0000-0000-000000000001';

SELECT is(
  (SELECT count(*)::int FROM realtime.messages
    WHERE topic = 'server-presence:f2480000-0000-0000-0000-000000000001'
      AND payload ->> 'type' = 'member:leave'),
  1, 'delete still broadcasts member:leave');

SELECT * FROM finish();
ROLLBACK;
