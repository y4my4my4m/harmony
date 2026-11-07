-- repair_inbound_emoji_origins() from 20261107400001_emoji_origin_domain.sql: federated emoji
-- rows stored with their image host as the domain take their instance.
--
--   remy  a member of har.example, whose emoji are served from db.har.example
--   misa  a member of misskey.example (a known instance)
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(14);

INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id) VALUES
  ('e2390000-0000-0000-0000-000000000001', 'remy', 'Remy', false, 'har.example', 'https://har.example/users/remy'),
  ('e2390000-0000-0000-0000-000000000002', 'misa', 'Misa', false, 'misskey.example', 'https://misskey.example/users/misa');
INSERT INTO public.federated_instances (domain) VALUES ('misskey.example') ON CONFLICT DO NOTHING;

INSERT INTO public.emojis (id, name, url, server_id, uploader, domain) VALUES
  -- Qualified by the sender, stored on the storage host.
  ('e2391000-0000-0000-0000-000000000001', 'eyes@har.example', 'https://db.har.example/e/eyes.png', NULL,
   'e2390000-0000-0000-0000-000000000001', 'db.har.example'),
  -- Unqualified, stored on the storage host.
  ('e2391000-0000-0000-0000-000000000002', 'wave', 'https://db.har.example/e/wave.png', NULL,
   'e2390000-0000-0000-0000-000000000001', 'db.har.example'),
  -- A third instance's emoji used by misa, qualified: its own origin stands.
  ('e2391000-0000-0000-0000-000000000003', 'blob@third.example', 'https://cdn.third.example/blob.png', NULL,
   'e2390000-0000-0000-0000-000000000002', 'cdn.third.example'),
  -- Already right: a known instance's own host.
  ('e2391000-0000-0000-0000-000000000004', 'party', 'https://misskey.example/e/party.png', NULL,
   'e2390000-0000-0000-0000-000000000001', 'misskey.example'),
  -- An @ that names no host stays in the name.
  ('e2391000-0000-0000-0000-000000000005', 'a@b', 'https://db.har.example/e/ab.png', NULL,
   'e2390000-0000-0000-0000-000000000001', 'db.har.example');

INSERT INTO public.remote_emojis_cache (shortcode, origin_domain, full_code, url, usage_count) VALUES
  ('eyes@har.example', 'db.har.example', ':eyes@har.example@db.har.example:', 'https://db.har.example/e/eyes.png', 3),
  ('eyes', 'har.example', ':eyes@har.example:', 'https://har.example/older/eyes.png', 2),
  ('wave', 'db.har.example', ':wave@db.har.example:', 'https://db.har.example/e/wave.png', 1);

SELECT ok(public.repair_inbound_emoji_origins() > 0, 'the repair reports rows changed');

SELECT is((SELECT name::text FROM public.emojis WHERE id = 'e2391000-0000-0000-0000-000000000001'), 'eyes',
          'a qualified name loses its suffix');
SELECT is((SELECT domain FROM public.emojis WHERE id = 'e2391000-0000-0000-0000-000000000001'), 'har.example',
          'and takes the instance it names');
SELECT is((SELECT domain FROM public.emojis WHERE id = 'e2391000-0000-0000-0000-000000000002'), 'har.example',
          'an unqualified row on its image host takes its uploader''s instance');
SELECT is((SELECT name::text || ' ' || domain FROM public.emojis WHERE id = 'e2391000-0000-0000-0000-000000000003'),
          'blob third.example', 'a third instance named in the shortcode stands over the uploader''s');
SELECT is((SELECT domain FROM public.emojis WHERE id = 'e2391000-0000-0000-0000-000000000004'), 'misskey.example',
          'a known instance host is left alone');
SELECT is((SELECT name::text || ' ' || domain FROM public.emojis WHERE id = 'e2391000-0000-0000-0000-000000000005'),
          'a@b har.example', 'an @ naming no host stays in the name');

SELECT is((SELECT count(*)::int FROM public.remote_emojis_cache WHERE shortcode = 'eyes' AND origin_domain = 'har.example'), 1,
          'the qualified cache row folds into the existing eyes@har.example');
SELECT is((SELECT usage_count FROM public.remote_emojis_cache WHERE shortcode = 'eyes' AND origin_domain = 'har.example'), 5,
          'with its usage added');
SELECT is((SELECT count(*)::int FROM public.remote_emojis_cache WHERE shortcode LIKE '%@%'), 0,
          'no cache shortcode keeps a suffix');
SELECT is((SELECT origin_domain FROM public.remote_emojis_cache WHERE shortcode = 'wave'), 'har.example',
          'an unqualified cache row takes the domain of its emojis row');
SELECT is((SELECT full_code FROM public.remote_emojis_cache WHERE shortcode = 'wave'), ':wave@har.example:',
          'and its full code is rebuilt');

SELECT is(public.repair_inbound_emoji_origins(), 0, 'a second run changes nothing');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok('SELECT public.repair_inbound_emoji_origins()', '42501', NULL, 'members cannot run the repair');
SELECT tests.clear_authentication();

SELECT * FROM finish();
ROLLBACK;
