-- server_icons / server_banners policies from 20261025100005_server_media_uuid_guard.sql
-- (issue 142). Instance branding lives under instance/; server media under <server id>/.
-- A folder that is not a uuid reaches no server owner policy's cast: the write is decided by
-- the instance admin policies, and refused with 42501, not 22P02, for everyone else.
--
--   alice    owns server_1
--   bob      member of server_1 without MANAGE_SERVER
--   mallory  instance admin, in no server
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(14);

SELECT set_config('storage.allow_delete_query', 'true', true);

UPDATE public.profiles SET is_admin = true WHERE id = '33333333-0000-0000-0000-000000000003';
-- Schema-only clones of live instances carry no bucket rows.
INSERT INTO storage.buckets (id, name, public) VALUES
  ('server_icons', 'server_icons', true),
  ('server_banners', 'server_banners', true)
ON CONFLICT (id) DO NOTHING;

-- Instance branding. --------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT lives_ok(
    $q$INSERT INTO storage.objects (bucket_id, name) VALUES ('server_icons', 'instance/icon-170.png')$q$,
    'an instance admin uploads the instance icon');
SELECT lives_ok(
    $q$INSERT INTO storage.objects (bucket_id, name) VALUES ('server_banners', 'instance/banner-170.png')$q$,
    'an instance admin uploads the instance banner');
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('server_icons', '55555555-0000-0000-0000-000000000005/icon-mallory.png')$q$,
    '42501'::char(5), NULL, 'an instance admin without MANAGE_SERVER cannot upload a server''s icon');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name) VALUES ('server_icons', 'instance/icon-bob.png')$q$,
    '42501'::char(5), NULL, 'a non-admin''s instance icon upload is refused by policy, not by a uuid cast');
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name) VALUES ('server_banners', 'instance/banner-bob.png')$q$,
    '42501'::char(5), NULL, 'a non-admin''s instance banner upload is refused by policy, not by a uuid cast');
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name) VALUES ('server_icons', 'not-a-uuid/icon.png')$q$,
    '42501'::char(5), NULL, 'any other non-uuid folder is refused by policy');
SELECT lives_ok(
    $q$UPDATE storage.objects SET metadata = '{"x":1}'::jsonb
        WHERE bucket_id = 'server_icons' AND name = 'instance/icon-170.png'$q$,
    'a non-admin''s update of instance branding matches nothing instead of raising');
SELECT lives_ok(
    $q$DELETE FROM storage.objects WHERE bucket_id IN ('server_icons', 'server_banners') AND name LIKE 'instance/%'$q$,
    'a non-admin''s delete of instance branding matches nothing instead of raising');

-- Server media. -------------------------------------------------------------------------
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('server_icons', '55555555-0000-0000-0000-000000000005/icon-bob.png')$q$,
    '42501'::char(5), NULL, 'a member without MANAGE_SERVER cannot upload the server icon');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('server_icons', '55555555-0000-0000-0000-000000000005/icon-170.png')$q$,
    'the owner uploads the server icon');
SELECT lives_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('server_banners', '55555555-0000-0000-0000-000000000005/banner-170.png')$q$,
    'the owner uploads the server banner');
SELECT lives_ok(
    $q$DELETE FROM storage.objects
        WHERE bucket_id = 'server_banners' AND name = '55555555-0000-0000-0000-000000000005/banner-170.png'$q$,
    'the owner deletes the server banner');

SELECT tests.clear_authentication();
SELECT is((SELECT count(*)::int FROM storage.objects
            WHERE bucket_id IN ('server_icons', 'server_banners') AND name LIKE 'instance/%-170.png'),
  2, 'instance branding survives the non-admin''s update and delete');
SELECT is((SELECT count(*)::int FROM storage.objects
            WHERE bucket_id = 'server_banners' AND name = '55555555-0000-0000-0000-000000000005/banner-170.png'),
  0, 'the owner''s banner delete removed the object');

SELECT * FROM finish();
ROLLBACK;
