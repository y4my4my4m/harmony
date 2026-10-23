-- Drive link access from 20261027100001_drive_link_access.sql: one token per file, general
-- access (restricted or anyone with the link), expiry, reset, the owner on the public page.
--
--   alice    owns every file below and server_1
--   bob      member of server_1; recipient of a people share of report.pdf
--   mallory  (cccccccc) in no server and no conversation
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(66);

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$ SELECT gen_random_uuid() $fn$;

CREATE FUNCTION tests.id179(p_name text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT id FROM public.drive_files WHERE path LIKE '%/' || p_name
$fn$;
GRANT EXECUTE ON FUNCTION tests.id179(text) TO authenticated, anon;
CREATE FUNCTION tests.tok179(p_name text) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT link_token FROM public.drive_files WHERE path LIKE '%/' || p_name
$fn$;
GRANT EXECUTE ON FUNCTION tests.tok179(text) TO authenticated, anon;

-- The migration body, without its BEGIN and COMMIT, from /db_schema/migrations, where
-- scripts/run-db-tests.sh copies db_schema. Absent, the line below prints an ERROR the runner
-- reports.
\! sed -n '/^SET LOCAL lock_timeout/,/^COMMIT;$/p' /db_schema/migrations/20261027100001_drive_link_access.sql | sed '$d' > /tmp/linkaccess179.sql
\! test -s /tmp/linkaccess179.sql || echo 'ERROR: /db_schema/migrations/20261027100001_drive_link_access.sql is not in the container; copy db_schema to /db_schema'

-- A database before the migration: no link_token, no show_owner, a 1.8.11 link share.
ALTER TABLE public.drive_files DROP COLUMN link_token CASCADE;
ALTER TABLE public.drive_shares DROP COLUMN show_owner;

INSERT INTO storage.buckets (id, name, public)
VALUES ('message_media', 'message_media', false), ('user_media', 'user_media', true)
ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.objects (bucket_id, name, metadata, user_metadata) VALUES
  ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/report.pdf',
   '{"size": 11, "mimetype": "application/pdf"}', '{"name": "report.pdf"}'),
  ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/photo.png',
   '{"size": 22, "mimetype": "image/png"}', '{"name": "photo.png"}'),
  ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/legacy.txt',
   '{"size": 33, "mimetype": "text/plain"}', '{"name": "legacy.txt"}');
INSERT INTO public.drive_shares (file_id, scope, target_id)
VALUES (tests.id179('report.pdf'), 'user', '22222222-0000-0000-0000-000000000002');
INSERT INTO public.drive_shares (file_id, scope, token)
VALUES (tests.id179('legacy.txt'), 'link', 'legacy-token-0123456789abcdef');

\i /tmp/linkaccess179.sql

-- Backfill. --------------------------------------------------------------------------------
SELECT is(tests.tok179('legacy.txt'), 'legacy-token-0123456789abcdef',
  'a file with a link share keeps that share''s token');
SELECT is((SELECT count(*)::int FROM public.drive_files WHERE link_token IS NULL), 0, 'every file has a token');
SELECT ok(tests.tok179('report.pdf') ~ '^[A-Za-z0-9_-]{24}$', 'a fresh token is base64url of 18 bytes');
SELECT col_not_null('public', 'drive_files', 'link_token', 'the token is required');
SELECT isnt(tests.tok179('report.pdf'), tests.tok179('photo.png'), 'tokens differ between files');
INSERT INTO storage.objects (bucket_id, name, metadata, user_metadata) VALUES
  ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/later.txt',
   '{"size": 1, "mimetype": "text/plain"}', '{"name": "later.txt"}');
SELECT ok(tests.tok179('later.txt') ~ '^[A-Za-z0-9_-]{24}$', 'a file uploaded later gets a token');
SELECT throws_ok(
    $q$UPDATE public.drive_shares SET token = 'other-token-0123456789abcdef' WHERE scope = 'link'$q$,
    '23503', NULL, 'a link share carries its file''s token');
SELECT tests.authenticate_as_anon();
SELECT is(public.drive_link_resolve('legacy-token-0123456789abcdef') ->> 'name', 'legacy.txt',
  'a link posted before the migration still opens');
SELECT is(public.drive_link_resolve('legacy-token-0123456789abcdef') #> '{owner}', jsonb_build_object('id', NULL, 'username', NULL, 'display_name', NULL, 'avatar_url', NULL, 'domain', NULL, 'emojis', '[]'::jsonb),
  'without its owner');

-- Restricted. ------------------------------------------------------------------------------
SELECT is(public.drive_link_resolve(tests.tok179('report.pdf')), NULL, 'a restricted token resolves to nothing');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.drive_file_card(NULL, tests.tok179('report.pdf')) ->> 'via', 'file',
  'a share recipient opens a restricted token as the file');
SELECT is(public.drive_file_card(NULL, tests.tok179('report.pdf')) ->> 'id', tests.id179('report.pdf')::text,
  'with its id');
SELECT is(public.drive_file_card(tests.id179('report.pdf')) ->> 'token', tests.tok179('report.pdf'),
  'the card by id carries the token, so any reader copies the address');
SELECT ok(NOT (public.drive_file_card(tests.id179('report.pdf')) ->> 'public')::boolean, 'marked not public');
SELECT is(public.drive_file_card(tests.id179('report.pdf')) #>> '{owner,username}', 'alice', 'a reader sees the owner');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.drive_file_card(NULL, tests.tok179('report.pdf')), '{"access": false}'::jsonb,
  'a stranger opens nothing of a restricted token');

-- Anyone with the link. --------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.drive_link_set(tests.id179('photo.png'), true),
  jsonb_build_object('token', tests.tok179('photo.png'), 'public', true, 'link_expires_at', NULL, 'show_owner', false),
  'the owner makes the file public; the token stays');
SELECT is((SELECT token FROM public.drive_shares WHERE file_id = tests.id179('photo.png') AND scope = 'link'),
  tests.tok179('photo.png'), 'the link share carries the file''s token');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.drive_file_card(NULL, tests.tok179('photo.png')) ->> 'via', 'link',
  'a stranger opens a public token as a link');
SELECT is(public.drive_file_card(NULL, tests.tok179('photo.png')) ->> 'token', tests.tok179('photo.png'), 'with its token');
SELECT is(public.drive_file_card(NULL, tests.tok179('photo.png')) -> 'owner', 'null'::jsonb,
  'and no owner while Show my name is off');
SELECT ok(NOT (public.drive_file_card(NULL, tests.tok179('photo.png')) ?| ARRAY['id', 'path', 'bucket']),
  'nor the file id or its object');
SELECT is(public.drive_file_card(tests.id179('photo.png')), '{"access": false}'::jsonb,
  'a public file is still not his by id');
SELECT tests.authenticate_as_anon();
SELECT is(public.drive_link_resolve(tests.tok179('photo.png')) ->> 'name', 'photo.png', 'anyone resolves a public token');
SELECT is(public.drive_link_resolve(tests.tok179('photo.png')) #> '{owner}', jsonb_build_object('id', NULL, 'username', NULL, 'display_name', NULL, 'avatar_url', NULL, 'domain', NULL, 'emojis', '[]'::jsonb), 'without the owner');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.drive_file_card(NULL, tests.tok179('photo.png')) ->> 'via', 'file',
  'the owner opens her public token as the file');
SELECT ok((public.drive_file_card(NULL, tests.tok179('photo.png')) ->> 'public')::boolean, 'marked public');

-- Show my name. ----------------------------------------------------------------------------
SELECT tests.clear_authentication();
UPDATE public.profiles SET display_name = 'Alice :wave: :ghost~1: :nope:' WHERE id = '11111111-0000-0000-0000-000000000001';
INSERT INTO public.emojis (id, name, url, server_id) VALUES
  ('17900000-0000-0000-0000-000000000001', 'wave', 'https://cdn.test/wave.png', '55555555-0000-0000-0000-000000000005'),
  ('17900000-0000-0000-0000-000000000002', 'ghost', 'https://cdn.test/ghost-0.png', '55555555-0000-0000-0000-000000000005'),
  ('17900000-0000-0000-0000-000000000003', 'ghost', 'https://cdn.test/ghost-1.png', '55555555-0000-0000-0000-000000000005');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT ok((public.drive_link_set(tests.id179('photo.png'), true, NULL, true) ->> 'show_owner')::boolean,
  'the owner shows her name on the link');
SELECT tests.authenticate_as_anon();
SELECT is(public.drive_link_resolve(tests.tok179('photo.png')) #>> '{owner,id}', '11111111-0000-0000-0000-000000000001',
  'the public page names the owner');
SELECT is(public.drive_link_resolve(tests.tok179('photo.png')) #>> '{owner,username}', 'alice', 'by username');
SELECT is(public.drive_link_resolve(tests.tok179('photo.png')) #> '{owner,emojis}',
  '[{"name": "wave", "url": "https://cdn.test/wave.png"}, {"name": "ghost~1", "url": "https://cdn.test/ghost-1.png"}]'::jsonb,
  'with the custom emoji of her display name, name~N picking the Nth row');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.drive_file_card(NULL, tests.tok179('photo.png')) #>> '{owner,display_name}', 'Alice :wave: :ghost~1: :nope:',
  'the link card names the owner');
SELECT tests.clear_authentication();
UPDATE public.profiles SET display_name = 'Alice :ghost~99999999999:' WHERE id = '11111111-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.drive_file_card(NULL, tests.tok179('photo.png')) #>> '{owner,display_name}', 'Alice :ghost~99999999999:',
  'an emoji suffix past integer range does not fail the card');
SELECT tests.clear_authentication();
UPDATE public.profiles SET display_name = 'Alice :wave: :ghost~1: :nope:' WHERE id = '11111111-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT tests.clear_authentication();
UPDATE public.profiles SET federation_metadata = '{"display_name_emojis": [{"name": ":wave:", "url": "https://pinned.test/wave.png"}]}'
 WHERE id = '11111111-0000-0000-0000-000000000001';
SELECT is(public.drive_owner_json('11111111-0000-0000-0000-000000000001') -> 'emojis',
  '[{"name": "wave", "url": "https://pinned.test/wave.png"}, {"name": "ghost~1", "url": "https://cdn.test/ghost-1.png"}]'::jsonb,
  'display_name_emojis come first and cover their names');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT ok(NOT (public.drive_link_set(tests.id179('photo.png'), true) ->> 'show_owner')::boolean,
  'Show my name is off unless asked for');
SELECT tests.authenticate_as_anon();
SELECT is(public.drive_link_resolve(tests.tok179('photo.png')) #> '{owner}', jsonb_build_object('id', NULL, 'username', NULL, 'display_name', NULL, 'avatar_url', NULL, 'domain', NULL, 'emojis', '[]'::jsonb), 'and the name is gone again');

-- 1.8.11 drive_link_create. -----------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
CREATE TEMP TABLE tok179_before AS SELECT tests.tok179('photo.png') AS token;
CREATE TEMP TABLE tok179_created AS SELECT public.drive_link_create(tests.id179('photo.png')) ->> 'token' AS token;
SELECT isnt((SELECT token FROM tok179_created), (SELECT token FROM tok179_before),
  'drive_link_create gives the file a new token, as 1.8.11 did');
SELECT is((SELECT token FROM tok179_created), tests.tok179('photo.png'),
  'which is the file''s token');
SELECT isnt(public.drive_link_create(tests.id179('photo.png')) ->> 'token', (SELECT token FROM tok179_created),
  'and every call rotates it: off and on revokes a leaked link from a 1.8.11 client');

-- Expiry. ----------------------------------------------------------------------------------
SELECT throws_ok($q$SELECT public.drive_link_set(tests.id179('photo.png'), true, now() - interval '1 minute')$q$,
  '22023', NULL, 'an expiry in the past is refused');
SELECT ok((public.drive_link_set(tests.id179('photo.png'), true, now() + interval '1 day') ->> 'link_expires_at') IS NOT NULL,
  'the owner sets an expiry');
SELECT lives_ok($q$SELECT public.drive_share_file(tests.id179('photo.png'), 'user', '22222222-0000-0000-0000-000000000002')$q$,
  'and shares the file with bob');
SELECT tests.clear_authentication();
UPDATE public.drive_shares SET expires_at = now() - interval '1 minute'
 WHERE file_id = tests.id179('photo.png') AND scope = 'link';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.drive_file_card(NULL, tests.tok179('photo.png')), '{"access": false}'::jsonb,
  'once expired the link opens nothing for a stranger');
SELECT tests.authenticate_as_anon();
SELECT is(public.drive_link_resolve(tests.tok179('photo.png')), NULL, 'nor resolves');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.drive_file_card(NULL, tests.tok179('photo.png')) ->> 'via', 'file',
  'the same address still opens for a reader');
SELECT ok(NOT (public.drive_file_card(NULL, tests.tok179('photo.png')) ->> 'public')::boolean,
  'as a restricted file');

-- Reset. -----------------------------------------------------------------------------------
CREATE TEMP TABLE old179 AS SELECT tests.tok179('photo.png') AS token;
GRANT SELECT ON old179 TO anon, authenticated;
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok($q$SELECT public.drive_link_set(tests.id179('photo.png'), true)$q$, 'the owner makes it public again');
SELECT isnt(public.drive_link_reset(tests.id179('photo.png')) ->> 'token', (SELECT token FROM old179),
  'Reset link answers a new token');
SELECT is((SELECT token FROM public.drive_shares WHERE file_id = tests.id179('photo.png') AND scope = 'link'),
  tests.tok179('photo.png'), 'the link share follows the new token');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.drive_file_card(NULL, (SELECT token FROM old179)), '{"access": false}'::jsonb,
  'the old address opens nothing, for a reader too');
SELECT tests.authenticate_as_anon();
SELECT is(public.drive_link_resolve((SELECT token FROM old179)), NULL, 'nor for anyone');
SELECT is(public.drive_link_resolve(tests.tok179('photo.png')) ->> 'name', 'photo.png', 'the new address is public');

-- Restricted again. ------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.drive_link_set(tests.id179('photo.png'), false) ->> 'token', tests.tok179('photo.png'),
  'turning public off keeps the token');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.drive_file_card(NULL, tests.tok179('photo.png')), '{"access": false}'::jsonb,
  'a stranger opens nothing');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.drive_file_card(NULL, tests.tok179('photo.png')) ->> 'via', 'file', 'a reader still opens it');

-- Instance switch, ownership, grants. ------------------------------------------------------
SELECT throws_ok($q$SELECT public.drive_link_set(tests.id179('report.pdf'), true)$q$, 'P0002', NULL,
  'only the owner changes general access');
SELECT throws_ok($q$SELECT public.drive_link_reset(tests.id179('report.pdf'))$q$, 'P0002', NULL,
  'only the owner resets the link');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = 'false' WHERE config_key = 'drive_link_sharing';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.drive_link_set(tests.id179('report.pdf'), true)$q$, '42501', NULL,
  'with link sharing off nothing becomes public');
SELECT lives_ok($q$SELECT public.drive_link_set(tests.id179('report.pdf'), false)$q$, 'restricting still works');
SELECT tests.authenticate_as_anon();
SELECT is(public.drive_link_resolve('legacy-token-0123456789abcdef'), NULL, 'and public links resolve to nothing');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = 'true' WHERE config_key = 'drive_link_sharing';

SELECT is((SELECT count(*)::int FROM public.drive_link_target('legacy-token-0123456789abcdef')), 1,
  'the service resolves a public token to its object');
SELECT is((SELECT count(*)::int FROM public.drive_link_target(tests.tok179('report.pdf'))), 0,
  'and a restricted one to nothing');

SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.drive_link_set(tests.id179('photo.png'), true)$q$, '42501', NULL,
  'anon cannot change general access');
SELECT throws_ok($q$SELECT public.drive_link_reset(tests.id179('photo.png'))$q$, '42501', NULL,
  'nor reset a link');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.drive_owner_json('11111111-0000-0000-0000-000000000001')$q$, '42501', NULL,
  'the owner object is not callable by clients');
SELECT throws_ok($q$SELECT * FROM public.drive_link_target(tests.tok179('photo.png'))$q$, '42501', NULL,
  'nor the object behind a link');

SELECT * FROM finish();
ROLLBACK;
