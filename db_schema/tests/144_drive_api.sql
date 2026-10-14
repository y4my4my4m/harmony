-- Drive operations from 20261015100002_drive_api.sql: usage, listing, folders, trash, keep,
-- shares, links, staff tools and the service calls of the federation-backend sweeps.
--
--   alice  owns server_1, participant in the DM
--   bob    member of server_1, participant in the DM
--   carol  (cccccccc) in no server; made an instance moderator below
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(62);
SELECT set_config('storage.allow_delete_query', 'true', true);

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$ SELECT gen_random_uuid() $fn$;

CREATE FUNCTION tests.id144(p_name text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT id FROM public.drive_files WHERE path LIKE '%/' || p_name
$fn$;
GRANT EXECUTE ON FUNCTION tests.id144(text) TO authenticated, anon;
CREATE FUNCTION tests.state144(p_name text) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT state || coalesce('/' || gone_reason, '') FROM public.drive_files WHERE path LIKE '%/' || p_name
$fn$;
GRANT EXECUTE ON FUNCTION tests.state144(text) TO authenticated, anon;

INSERT INTO storage.buckets (id, name, public)
VALUES ('message_media', 'message_media', false), ('user_media', 'user_media', true)
ON CONFLICT (id) DO NOTHING;
UPDATE public.profiles SET is_moderator = true WHERE id = '33333333-0000-0000-0000-000000000003';

-- Alice's files: two in the channel, one in the DM, one in Drive, one post image.
INSERT INTO storage.objects (bucket_id, name, metadata, user_metadata) VALUES
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/cat.png',
   '{"size": 300, "mimetype": "image/png"}', jsonb_build_object('name', 'cat.png', 'sha256', repeat('11', 32))),
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/song.mp3',
   '{"size": 200, "mimetype": "audio/mpeg"}', '{"name": "song.mp3"}'),
  ('message_media', 'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/plan.pdf',
   '{"size": 100, "mimetype": "application/pdf"}', '{"name": "plan.pdf"}'),
  ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/draft.txt',
   '{"size": 50, "mimetype": "text/plain"}', '{"name": "draft.txt"}'),
  ('user_media', 'aaaaaaaa-0000-0000-0000-000000000001/posts/sunset.jpg',
   '{"size": 400, "mimetype": "image/jpeg"}', '{"name": "sunset.jpg"}');
INSERT INTO public.messages (channel_id, user_id, content) VALUES
  ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type":"file","fileType":"image","url":"","path":"c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/cat.png"},
     {"type":"file","fileType":"audio","url":"","path":"c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/song.mp3"}]');
INSERT INTO public.messages (conversation_id, user_id, content) VALUES
  ('77777777-0000-0000-0000-000000000007', '11111111-0000-0000-0000-000000000001',
   '[{"type":"file","fileType":"file","url":"","path":"d/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/plan.pdf"}]');

-- Usage and listing. ---------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((public.get_my_drive_usage() ->> 'used_bytes')::bigint, 1050::bigint, 'usage sums the account''s files');
SELECT is((public.get_my_drive_usage() ->> 'quota_bytes')::bigint, 102400::bigint * 1048576,
  'an instance admin''s quota is drive_quota_admin_mb');
SELECT is((SELECT count(*)::int FROM public.drive_list_files('all')), 5, 'all lists every file');
SELECT is((SELECT count(*)::int FROM public.drive_list_files('all', NULL, NULL, NULL, 'image')), 2,
  'the kind filter keeps images');
SELECT is((SELECT file ->> 'name' FROM public.drive_list_files('all', NULL, NULL, 'SON')), 'song.mp3',
  'the query matches names case-insensitively');
SELECT is((SELECT count(*)::int FROM public.drive_list_files('server', NULL, '55555555-0000-0000-0000-000000000005')), 2,
  'the server view lists files its channels'' messages name');
SELECT is((SELECT file ->> 'name' FROM public.drive_list_files('dms')), 'plan.pdf',
  'the DM view lists files sent in conversations');
SELECT is((SELECT file ->> 'name' FROM public.drive_list_files('fediverse')), 'sunset.jpg',
  'the fediverse view lists post media');
SELECT is((SELECT file ->> 'name' FROM public.drive_list_files('all', NULL, NULL, NULL, NULL, 'size') LIMIT 1),
  'sunset.jpg', 'sorting by size puts the largest first');
SELECT is(jsonb_array_length(public.drive_context_tree() -> 'servers'), 1, 'the context tree names the server');
SELECT is(jsonb_array_length(public.drive_file_usage(tests.id144('cat.png')) -> 'messages'), 1,
  'file usage lists the message that sends it');
SELECT is((SELECT count(*)::int FROM public.drive_find_by_hash(repeat('11', 32))), 1, 'a hash finds the account''s file');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((public.get_my_drive_usage() ->> 'quota_bytes')::bigint, 1024::bigint * 1048576,
  'an account''s quota is drive_quota_user_mb');
SELECT is((SELECT count(*)::int FROM public.drive_list_files('all')), 0, 'another account lists none of them');
SELECT is((SELECT count(*)::int FROM public.drive_find_by_hash(repeat('11', 32))), 0, 'nor finds them by hash');
SELECT throws_ok($q$SELECT public.drive_file_usage(tests.id144('cat.png'))$q$, 'P0002', NULL,
  'nor reads where they are used');

-- Folders. -------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
CREATE TEMP TABLE f144 AS SELECT (public.drive_create_folder('Pets')).id AS pets;
GRANT SELECT ON f144 TO authenticated;
SELECT throws_ok($q$SELECT public.drive_create_folder('pets')$q$, '23505', NULL,
  'folder names are unique per parent, ignoring case');
SELECT throws_ok($q$SELECT public.drive_create_folder('a/b')$q$, '22023', NULL, 'folder names have no slashes');
INSERT INTO f144 SELECT (public.drive_create_folder('Cats', (SELECT pets FROM f144 LIMIT 1))).id;
SELECT throws_ok(
    $q$SELECT public.drive_move_folder((SELECT pets FROM f144 LIMIT 1), (SELECT pets FROM f144 OFFSET 1 LIMIT 1))$q$,
    '22023', NULL, 'a folder cannot move into its own descendant');
SELECT is(public.drive_move_files(ARRAY[tests.id144('cat.png')], (SELECT pets FROM f144 OFFSET 1 LIMIT 1)), 1,
  'a file moves into a folder');
SELECT is((SELECT file ->> 'name' FROM public.drive_list_files('folder', (SELECT pets FROM f144 OFFSET 1 LIMIT 1))),
  'cat.png', 'the folder view lists it');
SELECT is(public.drive_delete_folder((SELECT pets FROM f144 LIMIT 1)), 1,
  'deleting a folder trashes the files of its subtree');
SELECT is(tests.state144('cat.png'), 'trashed', 'the file is in the trash');
SELECT is((SELECT count(*)::int FROM public.drive_list_folders()), 0, 'the folders are gone');

-- Trash, restore, keep, delete. -----------------------------------------------------------
SELECT is((public.get_my_drive_usage() ->> 'used_bytes')::bigint, 1050::bigint, 'trash still counts toward the quota');
SELECT is(public.drive_restore_files(ARRAY[tests.id144('cat.png')]), 1, 'a trashed file is restored');
SELECT ok(tests.state144('cat.png') = 'drive' AND (SELECT folder_id FROM public.drive_files WHERE id = tests.id144('cat.png')) IS NULL,
  'into the root, its folder deleted');
SELECT tests.clear_authentication();
UPDATE public.drive_files SET state = 'ephemeral', expires_at = now() + interval '30 days'
 WHERE id = tests.id144('song.mp3');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.drive_keep_files(ARRAY[tests.id144('song.mp3')]), 1, 'an ephemeral file that fits is kept');
SELECT tests.clear_authentication();
UPDATE public.drive_files SET state = 'ephemeral', expires_at = now() + interval '30 days'
 WHERE id = tests.id144('song.mp3');
INSERT INTO public.drive_quota_overrides (profile_id, quota_bytes) VALUES ('11111111-0000-0000-0000-000000000001', 900);
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.drive_keep_files(ARRAY[tests.id144('song.mp3')]), 0, 'one that does not fit stays ephemeral');
SELECT is(public.drive_trash_files(ARRAY[tests.id144('song.mp3')]), 1, 'trashing an ephemeral file');
SELECT is(tests.state144('song.mp3'), 'gone/deleted', 'deletes it');
SELECT tests.clear_authentication();
DELETE FROM public.drive_quota_overrides WHERE profile_id = '11111111-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.drive_set_temporary(ARRAY['u/aaaaaaaa-0000-0000-0000-000000000001/draft.txt'], true), 1,
  'the composer marks a file temporary by its object name');
SELECT is(tests.state144('draft.txt'), 'ephemeral', 'it is ephemeral');
SELECT is(public.drive_set_temporary(ARRAY['u/aaaaaaaa-0000-0000-0000-000000000001/draft.txt'], false), 1,
  'and keeps it again');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.drive_set_temporary(ARRAY['u/aaaaaaaa-0000-0000-0000-000000000001/draft.txt'], true), 0,
  'another account changes nothing');
SELECT tests.clear_authentication();

-- Shares and links. ----------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$SELECT public.drive_share_file(tests.id144('draft.txt'), 'server', '00000000-0000-0000-0000-000000000099')$q$,
    '42501', NULL, 'a file is shared only with a server its owner belongs to');
SELECT throws_ok(
    $q$SELECT public.drive_share_file(tests.id144('sunset.jpg'), 'user', '22222222-0000-0000-0000-000000000002')$q$,
    '22023', NULL, 'post media is public and takes no share');
SELECT lives_ok(
    $q$SELECT public.drive_share_file(tests.id144('draft.txt'), 'server', '55555555-0000-0000-0000-000000000005')$q$,
    'the owner shares a Drive file with her server');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT file ->> 'name' FROM public.drive_list_files('shared')), 'draft.txt',
  'a member sees it under Shared with me');
SELECT is((SELECT count(*)::int FROM storage.objects
            WHERE bucket_id = 'message_media' AND name = 'u/aaaaaaaa-0000-0000-0000-000000000001/draft.txt'), 1,
  'and reads its object');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
CREATE TEMP TABLE l144 AS SELECT public.drive_link_create(tests.id144('draft.txt')) ->> 'token' AS token;
GRANT SELECT ON l144 TO anon, authenticated;
SELECT tests.authenticate_as_anon();
SELECT is(public.drive_link_resolve((SELECT token FROM l144)) ->> 'name', 'draft.txt', 'anyone with the link reads its details');
SELECT throws_ok($q$SELECT * FROM public.drive_link_target((SELECT token FROM l144))$q$, '42501', NULL,
  'only the service resolves a link to its object');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = 'false' WHERE config_key = 'drive_link_sharing';
SELECT is(public.drive_link_resolve((SELECT token FROM l144)), NULL, 'with link sharing off links resolve to nothing');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.drive_link_create(tests.id144('cat.png'))$q$, '42501', NULL,
  'and none can be made');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = 'true' WHERE config_key = 'drive_link_sharing';

-- Staff. ---------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok($q$SELECT public.admin_drive_remove_file(tests.id144('cat.png'))$q$, '42501', NULL,
  'a member cannot remove a file');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.admin_set_drive_quota('22222222-0000-0000-0000-000000000002', 10)$q$, '42501', NULL,
  'a moderator cannot set quotas');
-- cat.png's sha256 is the uploader's claim: no block until the server computes the hash.
SELECT is(public.admin_drive_remove_file(tests.id144('cat.png'), true, 'spam'),
  jsonb_build_object('id', tests.id144('cat.png'), 'blocked', false, 'pending', true),
  'a moderator removes a file; the block waits for a server-computed hash');
SELECT is(tests.state144('cat.png'), 'gone/removed', 'the file is gone for everyone');
SELECT is((SELECT count(*)::int FROM public.drive_blocked_hashes), 0, 'the claimed hash is not blocked');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM public.drive_pending_blocks), 0, 'a member does not see pending blocks');

-- Service. -------------------------------------------------------------------------------
SELECT tests.clear_authentication();
SELECT ok(tests.id144('cat.png') IN (SELECT id FROM public.drive_hash_pending()), 'the removed file waits for its hash');
SELECT ok(NOT ARRAY(SELECT path FROM public.drive_objects_to_delete()) @> ARRAY['c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/cat.png'],
  'and keeps its object until hashed');
SELECT is(public.drive_record_hash('message_media', 'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/cat.png', repeat('22', 32)),
  'blocked', 'the server hash of the removed file is blocked');
SELECT is((SELECT reason FROM public.drive_blocked_hashes WHERE sha256 = repeat('22', 32)), 'spam',
  'with the moderator''s reason');
SELECT is(public.drive_record_hash('message_media', 'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/plan.pdf', repeat('11', 32)),
  'ok', 'the uploader''s false claim blocks nothing');
SELECT is(public.drive_record_hash('user_media', 'aaaaaaaa-0000-0000-0000-000000000001/posts/sunset.jpg', repeat('22', 32)),
  'blocked', 'a server hash matching a blocked one removes the file');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.admin_drive_remove_file(tests.id144('plan.pdf'), true) ->> 'blocked', 'true',
  'a verified hash is blocked at once');
SELECT tests.clear_authentication();
SELECT ok(EXISTS (SELECT 1 FROM public.drive_blocked_hashes WHERE sha256 = repeat('11', 32)), 'its hash is blocked');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT ok(public.drive_hash_blocked(repeat('22', 32)), 'a member learns blocked bytes are blocked');
SELECT ok(NOT public.drive_hash_blocked(repeat('33', 32)), 'and other bytes are not');
SELECT tests.clear_authentication();
UPDATE public.drive_files SET state = 'ephemeral', expires_at = now() - interval '1 minute'
 WHERE id = tests.id144('draft.txt');
SELECT is(public.drive_expire_due(), 1, 'an expired ephemeral file becomes gone');
SELECT ok(ARRAY(SELECT path FROM public.drive_objects_to_delete()) @> ARRAY[
    'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/cat.png',
    'u/aaaaaaaa-0000-0000-0000-000000000001/draft.txt'],
  'the objects of gone files are listed for deletion');

SELECT * FROM finish();
ROLLBACK;
