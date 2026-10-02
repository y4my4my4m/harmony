-- messages.media_paths from 20261007300001_encrypted_message_media.sql: the path guard on the
-- list, the cleanup trigger for encrypted edits and deletes, message_media_deletable keep
-- rules for listed and unlisted encrypted messages, and report snapshots. queue_federation_job
-- is replaced for the transaction so queued jobs can be read back.
--
--   alice  owns server_1, participant in the DM
--   bob    member of server_1, participant in the DM
--   carol  remote profile, participant in the DM
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(29);

CREATE TABLE tests.jobs77 (name text, data jsonb);
GRANT INSERT, SELECT ON tests.jobs77 TO authenticated, anon;
CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.jobs77 VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

CREATE FUNCTION tests.queued77() RETURNS jsonb LANGUAGE sql AS $fn$
  SELECT coalesce(jsonb_agg(p ORDER BY p), '[]'::jsonb)
    FROM tests.jobs77 j, jsonb_array_elements_text(j.data -> 'paths') p
   WHERE j.name = 'delete-message-media';
$fn$;
GRANT EXECUTE ON FUNCTION tests.queued77() TO authenticated;

INSERT INTO storage.buckets (id, name, public)
VALUES ('message_media', 'message_media', false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id)
VALUES ('f7710000-0000-0000-0000-000000000001', 'carol77', 'Carol', false, 'remote77.example',
        'https://remote77.example/users/carol');
INSERT INTO public.conversation_participants (conversation_id, user_id)
VALUES ('77777777-0000-0000-0000-000000000007', 'f7710000-0000-0000-0000-000000000001');

-- d/<dm>/<alice>/ and c/<channel>/<bob>/ objects, two days old.
INSERT INTO storage.objects (bucket_id, name, created_at)
SELECT 'message_media', 'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/' || f,
       now() - interval '2 days'
  FROM unnest(ARRAY['a.png', 'b.png', 'shared.png', 'reported.pdf', 'exported.pdf', 'orphan.png']) f;
INSERT INTO storage.objects (bucket_id, name, created_at) VALUES
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/bbbbbbbb-0000-0000-0000-000000000002/c.png', now() - interval '2 days');

SELECT ok(NOT has_function_privilege('authenticated', 'public.message_media_refs(jsonb, text[])', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.message_media_refs(jsonb, text[])', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.message_media_refs(jsonb, text[])', 'EXECUTE'),
  'message_media_refs is not callable by clients');

-- The sweep before any list. -------------------------------------------------------------
SELECT is(
    ARRAY(SELECT public.message_media_deletable(NULL, interval '1 day') ORDER BY 1),
    ARRAY['c/66666666-0000-0000-0000-000000000006/bbbbbbbb-0000-0000-0000-000000000002/c.png',
          'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/a.png',
          'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/b.png',
          'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/exported.pdf',
          'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/orphan.png',
          'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/reported.pdf',
          'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/shared.png'],
  'with no message naming them every object is a sweep candidate');

-- An encrypted message from a client that sets no list, written after the uploads.
INSERT INTO public.messages (id, conversation_id, user_id, content, encrypted, encryption_metadata)
VALUES ('f7720000-0000-0000-0000-000000000099', '77777777-0000-0000-0000-000000000007',
        '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"Y2lwaGVydGV4dA=="}]', true,
        '{"algorithm":"megolm_v3","session_id":"s77","message_index":0}');
SELECT is(
    ARRAY(SELECT public.message_media_deletable(NULL, interval '1 day') ORDER BY 1),
    ARRAY['c/66666666-0000-0000-0000-000000000006/bbbbbbbb-0000-0000-0000-000000000002/c.png'],
  'an encrypted message with no list holds every older object of its room');
SELECT is(
    ARRAY(SELECT public.message_media_deletable(ARRAY[
        'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/orphan.png'], interval '0')),
    '{}'::text[],
  'the delete job keeps it too');

-- Written before the uploads, by a remote author, or deleted: it holds nothing.
UPDATE public.messages SET created_at = now() - interval '3 days'
 WHERE id = 'f7720000-0000-0000-0000-000000000099';
UPDATE public.messages SET updated_at = now() - interval '3 days'
 WHERE id = 'f7720000-0000-0000-0000-000000000099';
SELECT ok('d/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/orphan.png'
          IN (SELECT public.message_media_deletable(NULL, interval '1 day')),
  'an encrypted message with no list written before an upload does not hold it');
UPDATE public.messages SET user_id = 'f7710000-0000-0000-0000-000000000001',
                           updated_at = now(), created_at = now()
 WHERE id = 'f7720000-0000-0000-0000-000000000099';
SELECT ok('d/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/orphan.png'
          IN (SELECT public.message_media_deletable(NULL, interval '1 day')),
  'a remote author''s encrypted message holds no local object');
UPDATE public.messages SET user_id = '11111111-0000-0000-0000-000000000001'
 WHERE id = 'f7720000-0000-0000-0000-000000000099';
SELECT is(
    ARRAY(SELECT public.message_media_deletable(NULL, interval '1 day') ORDER BY 1),
    ARRAY['c/66666666-0000-0000-0000-000000000006/bbbbbbbb-0000-0000-0000-000000000002/c.png'],
  'the local author holds them again');
DELETE FROM public.messages WHERE id = 'f7720000-0000-0000-0000-000000000099';
SELECT is(tests.queued77(), '[]'::jsonb,
  'deleting an encrypted message with no list queues nothing');

-- Path guard. ----------------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$INSERT INTO public.messages (id, conversation_id, user_id, content, encrypted, encryption_metadata, media_paths)
       VALUES ('f7720000-0000-0000-0000-000000000001', '77777777-0000-0000-0000-000000000007',
               '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"Y2lwaGVy"}]', true,
               '{"algorithm":"megolm_v3","session_id":"s77","message_index":1}',
               ARRAY['d/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/b.png',
                     'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/a.png',
                     'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/shared.png',
                     'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/a.png'])$q$,
    'an encrypted message lists objects of its room');
SELECT is((SELECT media_paths FROM public.messages WHERE id = 'f7720000-0000-0000-0000-000000000001'),
    ARRAY['d/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/a.png',
          'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/b.png',
          'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/shared.png'],
  'the list is stored sorted and distinct');
SELECT is(tests.queued77(), '[]'::jsonb, 'sending a listed message queues no cleanup');

SELECT throws_ok(
    $q$INSERT INTO public.messages (conversation_id, user_id, content, encrypted, media_paths)
       VALUES ('77777777-0000-0000-0000-000000000007', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"x"}]', true,
               ARRAY['c/66666666-0000-0000-0000-000000000006/bbbbbbbb-0000-0000-0000-000000000002/c.png'])$q$,
    '42501'::char(5), 'An attachment names an object outside this conversation', 'a list naming another room''s object is refused');
SELECT throws_ok(
    $q$INSERT INTO public.messages (conversation_id, user_id, content, encrypted, media_paths)
       VALUES ('77777777-0000-0000-0000-000000000007', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"x"}]', true,
               ARRAY['d/77777777-0000-0000-0000-000000000007/../../c/66666666-0000-0000-0000-000000000006/x.png'])$q$,
    '42501'::char(5), 'An attachment names an object outside this conversation', 'a list entry with dot segments is refused');
SELECT throws_ok(
    $q$INSERT INTO public.messages (conversation_id, user_id, content, encrypted, media_paths)
       VALUES ('77777777-0000-0000-0000-000000000007', '11111111-0000-0000-0000-000000000001',
               '[{"type":"text","text":"x"}]', true,
               ARRAY['d/77777777-0000-0000-0000-000000000007/', NULL])$q$,
    '42501'::char(5), 'An attachment names an object outside this conversation', 'a bare room prefix or a NULL entry is refused');
SELECT throws_ok(
    $q$INSERT INTO public.messages (conversation_id, user_id, content, encrypted, media_paths)
       SELECT '77777777-0000-0000-0000-000000000007', '11111111-0000-0000-0000-000000000001',
              '[{"type":"text","text":"x"}]', true,
              ARRAY(SELECT 'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/' || g || '.png'
                      FROM generate_series(1, 101) g)$q$,
    '22023'::char(5), NULL, 'a list of more than 100 entries is refused');

-- Shared, reported and exported objects. ---------------------------------------------------
INSERT INTO public.messages (id, conversation_id, user_id, content, encrypted, encryption_metadata, media_paths) VALUES
  ('f7720000-0000-0000-0000-000000000002', '77777777-0000-0000-0000-000000000007',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"Y2lwaGVy"}]', true,
   '{"algorithm":"megolm_v3","session_id":"s77","message_index":2}',
   ARRAY['d/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/shared.png']),
  ('f7720000-0000-0000-0000-000000000003', '77777777-0000-0000-0000-000000000007',
   '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"Y2lwaGVy"}]', true,
   '{"algorithm":"megolm_v3","session_id":"s77","message_index":3}',
   ARRAY['d/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/reported.pdf']);
SELECT tests.clear_authentication();
SELECT is(
    ARRAY(SELECT public.message_media_deletable(NULL, interval '1 day') ORDER BY 1),
    ARRAY['c/66666666-0000-0000-0000-000000000006/bbbbbbbb-0000-0000-0000-000000000002/c.png',
          'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/exported.pdf',
          'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/orphan.png'],
  'the sweep keeps every object a live encrypted message lists');

-- Edits and deletes. -----------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
UPDATE public.messages
   SET content = '[{"type":"text","text":"ZWRpdGVk"}]',
       media_paths = ARRAY['d/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/a.png',
                           'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/shared.png']
 WHERE id = 'f7720000-0000-0000-0000-000000000001';
SELECT is(tests.queued77(),
    '["d/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/b.png"]'::jsonb,
  'an encrypted edit that drops a listed object queues that object only');
UPDATE public.messages SET content = '[{"type":"text","text":"[deleted]"}]', is_deleted = true
 WHERE id = 'f7720000-0000-0000-0000-000000000001';
SELECT is(tests.queued77(),
    '["d/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/a.png",
      "d/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/b.png",
      "d/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/shared.png"]'::jsonb,
  'soft-deleting an encrypted message queues its listed objects');
SELECT throws_ok(
    $q$UPDATE public.messages SET media_paths = '{}' WHERE id = 'f7720000-0000-0000-0000-000000000001'$q$,
    '42501'::char(5), 'only the author changes a live message''s media_paths', 'the list of a deleted message is fixed');

SELECT tests.clear_authentication();
SELECT is(
    ARRAY(SELECT public.message_media_deletable(ARRAY[
        'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/a.png',
        'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/b.png',
        'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/shared.png'], interval '0') ORDER BY 1),
    ARRAY['d/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/a.png',
          'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/b.png'],
  'a queued object another encrypted message lists is kept');

-- A report snapshot carries the list.
SELECT is(public.report_content_snapshot(NULL, NULL, 'f7720000-0000-0000-0000-000000000003', NULL)
            -> 'message' -> 'media_paths',
    '["d/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/reported.pdf"]'::jsonb,
  'a report snapshot of an encrypted message carries its list');
SELECT set_config('request.jwt.claims', '{}', true);
INSERT INTO public.reports (reporter_id, reported_user_id, reason, report_type, content_snapshot)
VALUES ('22222222-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 'spam', 'message',
        public.report_content_snapshot(NULL, NULL, 'f7720000-0000-0000-0000-000000000003', NULL));
INSERT INTO public.account_data_exports (profile_id) VALUES ('11111111-0000-0000-0000-000000000001');
DELETE FROM public.messages WHERE id = 'f7720000-0000-0000-0000-000000000003';
SELECT ok(tests.queued77() ? 'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/reported.pdf',
  'hard-deleting an encrypted message queues its listed objects');
SELECT is(
    ARRAY(SELECT public.message_media_deletable(NULL, interval '1 day') ORDER BY 1),
    ARRAY['c/66666666-0000-0000-0000-000000000006/bbbbbbbb-0000-0000-0000-000000000002/c.png'],
  'reported and exported objects stay; the export holds the uploader''s other objects');
UPDATE public.account_data_exports SET expires_at = now() - interval '1 minute'
 WHERE profile_id = '11111111-0000-0000-0000-000000000001';
SELECT is(
    ARRAY(SELECT public.message_media_deletable(NULL, interval '1 day') ORDER BY 1),
    ARRAY['c/66666666-0000-0000-0000-000000000006/bbbbbbbb-0000-0000-0000-000000000002/c.png',
          'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/a.png',
          'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/b.png',
          'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/exported.pdf',
          'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/orphan.png'],
  'after the export expires only the reported and still-listed objects stay');

-- A report snapshot of an encrypted message with no list holds older objects of its room.
INSERT INTO public.reports (reporter_id, reported_user_id, reason, report_type, content_snapshot)
VALUES ('22222222-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 'spam', 'message',
        jsonb_build_object('message', jsonb_build_object(
            'id', gen_random_uuid(), 'user_id', '11111111-0000-0000-0000-000000000001',
            'conversation_id', '77777777-0000-0000-0000-000000000007',
            'content', '[{"type":"text","text":"Y2lwaGVy"}]'::jsonb, 'encrypted', true,
            'created_at', now(), 'updated_at', now())));
SELECT is(
    ARRAY(SELECT public.message_media_deletable(NULL, interval '1 day') ORDER BY 1),
    ARRAY['c/66666666-0000-0000-0000-000000000006/bbbbbbbb-0000-0000-0000-000000000002/c.png'],
  'a report of an encrypted message with no list holds the room''s older objects');

-- Channel: a moderator's soft delete. -------------------------------------------------------
INSERT INTO public.messages (id, channel_id, user_id, content, encrypted, encryption_metadata, media_paths)
VALUES ('f7720000-0000-0000-0000-000000000004', '66666666-0000-0000-0000-000000000006',
        '22222222-0000-0000-0000-000000000002', '[{"type":"text","text":"Y2lwaGVy"}]', true,
        '{"algorithm":"megolm_v3","session_id":"s77c","message_index":0}',
        ARRAY['c/66666666-0000-0000-0000-000000000006/bbbbbbbb-0000-0000-0000-000000000002/c.png']);
SELECT ok('c/66666666-0000-0000-0000-000000000006/bbbbbbbb-0000-0000-0000-000000000002/c.png'
          NOT IN (SELECT public.message_media_deletable(NULL, interval '1 day')),
  'a listed channel object is kept');
DELETE FROM tests.jobs77 WHERE name = 'delete-message-media';

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$UPDATE public.messages SET is_deleted = true, media_paths = '{}'
        WHERE id = 'f7720000-0000-0000-0000-000000000004'$q$,
    '42501'::char(5), 'only the author changes a live message''s media_paths', 'a moderator cannot change another author''s list');
SELECT lives_ok(
    $q$UPDATE public.messages SET is_deleted = true WHERE id = 'f7720000-0000-0000-0000-000000000004'$q$,
    'a moderator soft-deletes another author''s encrypted message');
SELECT is(tests.queued77(),
    '["c/66666666-0000-0000-0000-000000000006/bbbbbbbb-0000-0000-0000-000000000002/c.png"]'::jsonb,
  'the moderator''s delete queues the listed object');

SELECT * FROM finish();
ROLLBACK;
