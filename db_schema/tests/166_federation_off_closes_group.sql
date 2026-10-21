-- 20261025100002_federation_off_closes_group.sql: a local server with federation off is closed to
-- other instances in the database. federation_group_access reports it private with no member and
-- no readable channel, even for a remote member who joined while it was on;
-- federation_channel_recipients lists nobody; federation_room_media_access refuses every
-- instance and the '*' share. Turning federation back on restores all three.
--
--   off166   public, federation off, rm166 (remote.test) an accepted member, channel c166

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(9);

INSERT INTO public.profiles (id, username, display_name, domain, federated_id, shared_inbox_url, is_local)
VALUES ('f1660000-0000-0000-0000-000000000001', 'rm166', 'rm166', 'remote.test',
        'https://remote.test/users/rm166', 'https://remote.test/inbox', false);

INSERT INTO public.servers (id, name, owner, public, federation_enabled)
VALUES ('f1660000-0000-0000-0000-0000000000a1', 'Closed', '11111111-0000-0000-0000-000000000001', true, false);
DELETE FROM public.channels WHERE server_id = 'f1660000-0000-0000-0000-0000000000a1';
INSERT INTO public.channels (id, server_id, name, type)
VALUES ('f1660000-0000-0000-0000-0000000000c1', 'f1660000-0000-0000-0000-0000000000a1', 'general', 0);
INSERT INTO public.user_servers (server_id, user_id, status)
VALUES ('f1660000-0000-0000-0000-0000000000a1', 'f1660000-0000-0000-0000-000000000001', 'accepted');

SELECT is(
  (SELECT row(is_public, member_id, everyone_channel_ids, member_channel_ids)::text
     FROM public.federation_group_access('f1660000-0000-0000-0000-0000000000a1', 'https://remote.test/users/rm166')),
  row(false, NULL::uuid, '{}'::uuid[], '{}'::uuid[])::text,
  'federation off: private, no member, no channel, for a remote member too');

SELECT is(
  (SELECT count(*)::int FROM public.federation_channel_recipients('f1660000-0000-0000-0000-0000000000c1')),
  0, 'federation off: the channel has no remote recipient');

SELECT is(public.federation_room_media_access('c', 'f1660000-0000-0000-0000-0000000000c1', 'remote.test'),
  false, 'federation off: media is refused to the member''s instance');
SELECT is(public.federation_room_media_access('c', 'f1660000-0000-0000-0000-0000000000c1', '*'),
  false, 'federation off: media is refused to anyone');

UPDATE public.servers SET federation_enabled = true WHERE id = 'f1660000-0000-0000-0000-0000000000a1';

SELECT is(
  (SELECT is_public FROM public.federation_group_access('f1660000-0000-0000-0000-0000000000a1', NULL)),
  true, 'federation on: the public server reads as public');
SELECT is(
  (SELECT member_id FROM public.federation_group_access('f1660000-0000-0000-0000-0000000000a1', 'https://remote.test/users/rm166')),
  'f1660000-0000-0000-0000-000000000001'::uuid, 'federation on: the remote member is named');
SELECT is(
  (SELECT instance FROM public.federation_channel_recipients('f1660000-0000-0000-0000-0000000000c1')),
  'remote.test', 'federation on: the member''s instance receives the channel');

SELECT is(public.federation_room_media_access('c', 'f1660000-0000-0000-0000-0000000000c1', 'remote.test'),
  true, 'federation on: media is served to the member''s instance');
SELECT is(public.federation_room_media_access('c', 'f1660000-0000-0000-0000-0000000000c1', '*'),
  true, 'federation on: an @everyone channel of a public server is public');

SELECT * FROM finish();
ROLLBACK;
