-- Drive file links from 20261026500001_drive_file_links.sql: drive_file_card by id and by
-- token, and drive_share_gap for the composer's share offer.
--
--   alice    owns server_1 and every file below
--   bob      member of server_1, participant in the DM; a share recipient
--   mallory  (cccccccc) in no server and no conversation
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(36);

CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$ SELECT gen_random_uuid() $fn$;

CREATE FUNCTION tests.id175(p_name text) RETURNS uuid
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  SELECT id FROM public.drive_files WHERE path LIKE '%/' || p_name
$fn$;
GRANT EXECUTE ON FUNCTION tests.id175(text) TO authenticated, anon;

INSERT INTO storage.buckets (id, name, public)
VALUES ('message_media', 'message_media', false), ('user_media', 'user_media', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.objects (bucket_id, name, metadata, user_metadata) VALUES
  ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/private.txt',
   '{"size": 11, "mimetype": "text/plain"}', '{"name": "private.txt"}'),
  ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/shared.txt',
   '{"size": 22, "mimetype": "text/plain"}', '{"name": "shared.txt"}'),
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/room.png',
   '{"size": 33, "mimetype": "image/png"}', '{"name": "room.png"}'),
  ('message_media', 'u/aaaaaaaa-0000-0000-0000-000000000001/linked.pdf',
   '{"size": 44, "mimetype": "application/pdf"}', '{"name": "linked.pdf"}'),
  ('user_media', 'aaaaaaaa-0000-0000-0000-000000000001/posts/sunset.jpg',
   '{"size": 55, "mimetype": "image/jpeg"}', '{"name": "sunset.jpg"}');
INSERT INTO public.messages (channel_id, user_id, content) VALUES
  ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type":"file","fileType":"image","url":"","path":"c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/room.png"}]');
INSERT INTO public.drive_shares (file_id, scope, target_id)
VALUES (tests.id175('shared.txt'), 'user', '22222222-0000-0000-0000-000000000002');
UPDATE public.drive_files SET link_token = 'live-token-0123456789abcdef' WHERE id = tests.id175('linked.pdf');
UPDATE public.drive_files SET link_token = 'dead-token-0123456789abcdef' WHERE id = tests.id175('private.txt');
INSERT INTO public.drive_shares (file_id, scope, token, expires_at) VALUES
  (tests.id175('linked.pdf'), 'link', 'live-token-0123456789abcdef', NULL),
  (tests.id175('private.txt'), 'link', 'dead-token-0123456789abcdef', now() - interval '1 minute');

-- By id. ----------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.drive_file_card(tests.id175('private.txt')) ->> 'name', 'private.txt',
  'the owner reads her file''s card');
SELECT ok((public.drive_file_card(tests.id175('private.txt')) ->> 'own')::boolean, 'marked as her own');
SELECT is(public.drive_file_card(tests.id175('private.txt')) ->> 'path',
  'u/aaaaaaaa-0000-0000-0000-000000000001/private.txt', 'with the object name to sign');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.drive_file_card(tests.id175('shared.txt')) ->> 'name', 'shared.txt',
  'a share recipient reads the shared file''s card');
SELECT is(public.drive_file_card(tests.id175('shared.txt')) #>> '{owner,username}', 'alice',
  'with its owner');
SELECT ok(NOT (public.drive_file_card(tests.id175('shared.txt')) ->> 'own')::boolean, 'not as his own');
SELECT is(public.drive_file_card(tests.id175('room.png')) ->> 'kind', 'image',
  'a reader of the channel whose message names the file reads its card');
SELECT is(public.drive_file_card(tests.id175('private.txt')), '{"access": false}'::jsonb,
  'a member reads nothing of a file neither shared nor sent to him');
SELECT ok((SELECT count(*) = 1 FROM storage.objects
            WHERE bucket_id = 'message_media' AND name = 'u/aaaaaaaa-0000-0000-0000-000000000001/shared.txt'),
  'the storage read policy admits the recipient the card admits');
SELECT ok((SELECT count(*) = 0 FROM storage.objects
            WHERE bucket_id = 'message_media' AND name = 'u/aaaaaaaa-0000-0000-0000-000000000001/private.txt'),
  'and refuses the object the card refuses');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.drive_file_card(tests.id175('private.txt')), '{"access": false}'::jsonb,
  'a stranger reads nothing of a private file');
SELECT is(public.drive_file_card(tests.id175('shared.txt')), '{"access": false}'::jsonb,
  'nor of a file shared with someone else');
SELECT is(public.drive_file_card(tests.id175('room.png')), '{"access": false}'::jsonb,
  'nor of a file sent to a channel he cannot view');
SELECT is(public.drive_file_card('00000000-0000-0000-0000-0000000000ff'), '{"access": false}'::jsonb,
  'a missing id answers as an unreadable one');
SELECT is(public.drive_file_card(NULL, NULL), '{"access": false}'::jsonb, 'no id and no token: nothing');

-- Post media: public while a public or unlisted post attaches it. -------------------------
SELECT is(public.drive_file_card(tests.id175('sunset.jpg')), '{"access": false}'::jsonb,
  'post media no post attaches is the owner''s');
SELECT tests.clear_authentication();
INSERT INTO public.posts (author_id, content, visibility, is_local, media_attachments)
VALUES ('11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"sunset"}]', 'public', true,
        '[{"type":"image","url":"https://db.test/storage/v1/object/public/user_media/aaaaaaaa-0000-0000-0000-000000000001/posts/sunset.jpg"}]');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.drive_file_card(tests.id175('sunset.jpg')) ->> 'name', 'sunset.jpg',
  'post media a public post attaches is anyone''s to read');

-- Trash. ----------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is(public.drive_trash_files(ARRAY[tests.id175('shared.txt')]), 1, 'the owner trashes the shared file');
SELECT is(public.drive_file_card(tests.id175('shared.txt')) ->> 'state', 'trashed',
  'she still reads it, as trashed');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.drive_file_card(tests.id175('shared.txt')), '{"access": false}'::jsonb,
  'the recipient of a trashed file reads nothing');

-- By token. -------------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.drive_file_card(NULL, 'live-token-0123456789abcdef') ->> 'name', 'linked.pdf',
  'anyone holding a live token reads the linked file''s card');
SELECT is(public.drive_file_card(NULL, 'live-token-0123456789abcdef') ->> 'via', 'link', 'through the link');
SELECT ok(NOT (public.drive_file_card(NULL, 'live-token-0123456789abcdef') ?| ARRAY['id', 'path', 'bucket']),
  'without the file id or its object');
SELECT is(public.drive_file_card(NULL, 'dead-token-0123456789abcdef'), '{"access": false}'::jsonb,
  'an expired token answers nothing');
SELECT is(public.drive_file_card(NULL, 'nope-token-0123456789abcdef'), '{"access": false}'::jsonb,
  'an unknown token answers nothing');
SELECT is(public.drive_file_card(NULL, 'bad token'), '{"access": false}'::jsonb,
  'a malformed token answers nothing');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = 'false' WHERE config_key = 'drive_link_sharing';
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is(public.drive_file_card(NULL, 'live-token-0123456789abcdef'), '{"access": false}'::jsonb,
  'with link sharing off a live token answers nothing');
SELECT tests.clear_authentication();
UPDATE public.instance_config SET config_value = 'true' WHERE config_key = 'drive_link_sharing';

-- Grants. ---------------------------------------------------------------------------------
SELECT tests.authenticate_as_anon();
SELECT throws_ok($q$SELECT public.drive_file_card(NULL, 'live-token-0123456789abcdef')$q$, '42501', NULL,
  'anon cannot call the card');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok($q$SELECT public.drive_file_readable(tests.id175('private.txt'), '33333333-0000-0000-0000-000000000003')$q$,
  '42501', NULL, 'the access test is not callable by clients');

-- Share gap. ------------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT ok((public.drive_share_gap(tests.id175('private.txt'), '66666666-0000-0000-0000-000000000006') ->> 'missing')::boolean,
  'a member of the channel cannot read the owner''s private file');
SELECT ok(NOT (public.drive_share_gap(tests.id175('room.png'), '66666666-0000-0000-0000-000000000006') ->> 'missing')::boolean,
  'a file a live message of the channel names misses nobody');
SELECT is(public.drive_share_gap(tests.id175('private.txt'), NULL, '77777777-0000-0000-0000-000000000007') -> 'targets',
  '["22222222-0000-0000-0000-000000000002"]'::jsonb, 'the DM names the participant without access');
SELECT lives_ok(
    $q$SELECT public.drive_share_file(tests.id175('private.txt'), 'channel', '66666666-0000-0000-0000-000000000006')$q$,
    'the owner shares the file with the channel');
SELECT ok(NOT (public.drive_share_gap(tests.id175('private.txt'), '66666666-0000-0000-0000-000000000006') ->> 'missing')::boolean,
  'after which the channel misses nobody');
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is(public.drive_file_card(tests.id175('private.txt')) ->> 'name', 'private.txt',
  'and the member reads the card');
SELECT is(public.drive_share_gap(tests.id175('private.txt'), '66666666-0000-0000-0000-000000000006'), NULL,
  'someone else''s file has no gap to report');

SELECT * FROM finish();
ROLLBACK;
