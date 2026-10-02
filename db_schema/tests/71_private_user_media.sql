-- message_media from 20261006900001_private_user_media.sql: storage policies, the message
-- path guard, federation_media_access, federation_post_access, the cleanup trigger and
-- message_media_deletable. queue_federation_job is replaced for the transaction so queued
-- jobs can be read back.
--
--   alice    owns server_1, participant in the DM
--   bob      member of server_1 without VIEW_CHANNEL on staff71, participant in the DM
--   mallory  in no server and no conversation; instance admin
--   banned   user_servers row with status banned
--   carol    remote member of server_1 on remote71.example, participant in g71
BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(66);
-- Newer storage schemas refuse direct DELETE unless this is set, as storage-api does;
-- RLS still applies.
SELECT set_config('storage.allow_delete_query', 'true', true);

CREATE TABLE tests.jobs71 (name text, data jsonb);
GRANT INSERT, SELECT ON tests.jobs71 TO authenticated, anon;
CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text, p_job_data jsonb, p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5, p_expire_in_seconds integer DEFAULT 3600)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $fn$
BEGIN
  INSERT INTO tests.jobs71 VALUES (p_job_name, p_job_data);
  RETURN gen_random_uuid();
END;
$fn$;

-- Setup, as postgres. -------------------------------------------------------------------
UPDATE public.profiles SET is_admin = true WHERE id = '33333333-0000-0000-0000-000000000003';
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f7100000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'staff71', 0);
-- @everyone loses VIEW_CHANNEL (bit 1) on staff71.
INSERT INTO public.channel_permission_overrides (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
SELECT 'f7100000-0000-0000-0000-000000000001', 'role', r.id, NULL, 0, 2
  FROM public.server_roles r
 WHERE r.server_id = '55555555-0000-0000-0000-000000000005' AND r.is_default;

INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id, inbox_url)
VALUES ('f7110000-0000-0000-0000-000000000001', 'carol', 'Carol', false, 'remote71.example',
        'https://remote71.example/users/carol', 'https://remote71.example/users/carol/inbox');
INSERT INTO public.user_servers (user_id, server_id, status)
VALUES ('f7110000-0000-0000-0000-000000000001', '55555555-0000-0000-0000-000000000005', 'accepted');

INSERT INTO public.conversations (id, type, name)
VALUES ('f7120000-0000-0000-0000-000000000001', 'group', 'G71');
INSERT INTO public.conversation_participants (conversation_id, user_id) VALUES
  ('f7120000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001'),
  ('f7120000-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002'),
  ('f7120000-0000-0000-0000-000000000001', 'f7110000-0000-0000-0000-000000000001');

INSERT INTO public.servers (id, name, owner, is_local_server, federation_inbox_url, ap_id)
VALUES ('f7130000-0000-0000-0000-000000000001', 'Remote71', '11111111-0000-0000-0000-000000000001', false,
        'https://host71.example/servers/abc/inbox', 'https://host71.example/servers/abc');
INSERT INTO public.channels (id, server_id, name, type) VALUES
  ('f7130000-0000-0000-0000-000000000002', 'f7130000-0000-0000-0000-000000000001', 'remote-general', 0);

-- Schema-only clones of live instances carry no bucket rows.
INSERT INTO storage.buckets (id, name, public)
VALUES ('message_media', 'message_media', false)
ON CONFLICT (id) DO NOTHING;

-- Bucket. -------------------------------------------------------------------------------
SELECT is((SELECT public FROM storage.buckets WHERE id = 'message_media'), false,
  'message_media is not a public bucket');
SELECT ok(NOT has_function_privilege('anon', 'public.message_media_in_room(text)', 'EXECUTE')
          AND has_function_privilege('authenticated', 'public.message_media_in_room(text)', 'EXECUTE'),
  'message_media_in_room is callable by authenticated only');
SELECT ok(NOT has_function_privilege('authenticated', 'public.federation_media_access(text, text)', 'EXECUTE')
          AND NOT has_function_privilege('anon', 'public.federation_media_access(text, text)', 'EXECUTE')
          AND has_function_privilege('service_role', 'public.federation_media_access(text, text)', 'EXECUTE'),
  'federation_media_access is callable by service_role only');

-- Channel uploads. ----------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$INSERT INTO storage.objects (bucket_id, name, owner_id)
       VALUES ('message_media', 'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/a.png',
               'aaaaaaaa-0000-0000-0000-000000000001') RETURNING id$q$,
    'a member uploads into a channel under her own folder');
SELECT lives_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('message_media', 'c/f7100000-0000-0000-0000-000000000001/aaaaaaaa-0000-0000-0000-000000000001/s.png')
       RETURNING id$q$,
    'the owner uploads into a restricted channel');
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('message_media', 'c/66666666-0000-0000-0000-000000000006/bbbbbbbb-0000-0000-0000-000000000002/b.png')$q$,
    '42501'::char(5), NULL, 'an upload under another member''s folder is refused');
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('message_media', 'aaaaaaaa-0000-0000-0000-000000000001/legacy.png')$q$,
    '42501'::char(5), NULL, 'an upload outside a room prefix is refused');
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('message_media', 'x/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/x.png')$q$,
    '42501'::char(5), NULL, 'an unknown room kind is refused');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('message_media', 'c/f7100000-0000-0000-0000-000000000001/bbbbbbbb-0000-0000-0000-000000000002/b.png')$q$,
    '42501'::char(5), NULL, 'a member without VIEW_CHANNEL cannot upload into the channel');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('message_media', 'c/66666666-0000-0000-0000-000000000006/cccccccc-0000-0000-0000-000000000003/m.png')$q$,
    '42501'::char(5), NULL, 'a non-member cannot upload into the channel');

SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('message_media', 'c/66666666-0000-0000-0000-000000000006/dddddddd-0000-0000-0000-000000000004/d.png')$q$,
    '42501'::char(5), NULL, 'a banned member cannot upload into the channel');

-- Channel reads. ------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM storage.objects
            WHERE bucket_id = 'message_media'
              AND name = 'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/a.png'),
  1, 'a member reads a channel attachment');
SELECT is((SELECT count(*)::int FROM storage.objects
            WHERE bucket_id = 'message_media'
              AND name = 'c/f7100000-0000-0000-0000-000000000001/aaaaaaaa-0000-0000-0000-000000000001/s.png'),
  0, 'a member without VIEW_CHANNEL cannot read a restricted channel attachment');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'message_media'),
  0, 'a non-member reads no channel attachment');

SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'message_media'),
  0, 'a banned member reads no channel attachment');

SELECT tests.authenticate_as_anon();
SELECT is((SELECT count(*)::int FROM storage.objects WHERE bucket_id = 'message_media'),
  0, 'anon reads nothing');

-- DM uploads and reads. -----------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('message_media', 'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/dm.png')
       RETURNING id$q$,
    'a DM participant uploads into the conversation');

SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT throws_ok(
    $q$INSERT INTO storage.objects (bucket_id, name)
       VALUES ('message_media', 'd/77777777-0000-0000-0000-000000000007/cccccccc-0000-0000-0000-000000000003/x.png')$q$,
    '42501'::char(5), NULL, 'a non-participant cannot upload into the conversation');
SELECT is((SELECT count(*)::int FROM storage.objects
            WHERE bucket_id = 'message_media' AND name LIKE 'd/77777777-0000-0000-0000-000000000007/%'),
  0, 'a non-participant cannot read DM attachments');

SELECT tests.authenticate_as('dddddddd-0000-0000-0000-000000000004');
SELECT is((SELECT count(*)::int FROM storage.objects
            WHERE bucket_id = 'message_media' AND name LIKE 'd/77777777-0000-0000-0000-000000000007/%'),
  0, 'a server member outside the conversation cannot read DM attachments');

SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM storage.objects
            WHERE bucket_id = 'message_media'
              AND name = 'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/dm.png'),
  1, 'the other DM participant reads the attachment');

-- A participant who left the conversation loses access.
SELECT tests.clear_authentication();
UPDATE public.conversation_participants SET left_at = now()
 WHERE conversation_id = '77777777-0000-0000-0000-000000000007'
   AND user_id = '22222222-0000-0000-0000-000000000002';
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is((SELECT count(*)::int FROM storage.objects
            WHERE bucket_id = 'message_media' AND name LIKE 'd/77777777-0000-0000-0000-000000000007/%'),
  0, 'a participant who left cannot read DM attachments');
SELECT tests.clear_authentication();
UPDATE public.conversation_participants SET left_at = NULL
 WHERE conversation_id = '77777777-0000-0000-0000-000000000007'
   AND user_id = '22222222-0000-0000-0000-000000000002';

-- The uploader keeps her own objects after leaving the room.
UPDATE public.conversation_participants SET left_at = now()
 WHERE conversation_id = '77777777-0000-0000-0000-000000000007'
   AND user_id = '11111111-0000-0000-0000-000000000001';
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT is((SELECT count(*)::int FROM storage.objects
            WHERE bucket_id = 'message_media'
              AND name = 'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/dm.png'),
  1, 'the uploader reads her own object');
SELECT tests.clear_authentication();
UPDATE public.conversation_participants SET left_at = NULL
 WHERE conversation_id = '77777777-0000-0000-0000-000000000007'
   AND user_id = '11111111-0000-0000-0000-000000000001';

-- Reports. ------------------------------------------------------------------------------
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT count(*)::int FROM storage.objects
            WHERE bucket_id = 'message_media'
              AND name = 'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/dm.png'),
  0, 'an instance admin cannot read DM attachments nobody reported');
SELECT tests.clear_authentication();
-- Triggers on reports parse request.jwt.claims, which clear_authentication() leaves empty.
SELECT set_config('request.jwt.claims', '{}', true);
INSERT INTO public.reports (reporter_id, reported_user_id, reported_message_id, reason, report_type, content_snapshot)
VALUES ('22222222-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001',
        '99999999-0000-0000-0000-000000000009', 'spam', 'message',
        jsonb_build_object('message', jsonb_build_object('content', jsonb_build_array(
            jsonb_build_object('type', 'file', 'fileType', 'image',
                'path', 'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/dm.png')))));
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT is((SELECT count(*)::int FROM storage.objects
            WHERE bucket_id = 'message_media'
              AND name = 'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/dm.png'),
  1, 'an instance admin reads an attachment of a reported message');
SELECT is((SELECT count(*)::int FROM storage.objects
            WHERE bucket_id = 'message_media'
              AND name = 'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/a.png'),
  0, 'the report admits only the objects it names');

-- Deletes. ------------------------------------------------------------------------------
SELECT tests.authenticate_as('bbbbbbbb-0000-0000-0000-000000000002');
SELECT is_empty(
    $q$DELETE FROM storage.objects WHERE bucket_id = 'message_media'
        AND name = 'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/a.png' RETURNING id$q$,
    'a member cannot delete another member''s attachment');
SELECT tests.authenticate_as('cccccccc-0000-0000-0000-000000000003');
SELECT isnt_empty(
    $q$DELETE FROM storage.objects WHERE bucket_id = 'message_media'
        AND name = 'd/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/dm.png' RETURNING id$q$,
    'an instance admin deletes a reported attachment');
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT isnt_empty(
    $q$DELETE FROM storage.objects WHERE bucket_id = 'message_media'
        AND name = 'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/a.png' RETURNING id$q$,
    'the uploader deletes her own attachment');

-- Message path guard. -------------------------------------------------------------------
SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT lives_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
               '[{"type":"file","fileType":"image","url":"","path":"c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/a.png"}]')$q$,
    'a channel message names an object of its channel');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
               '[{"type":"file","fileType":"image","url":"","path":"d/77777777-0000-0000-0000-000000000007/aaaaaaaa-0000-0000-0000-000000000001/dm.png"}]')$q$,
    '42501'::char(5), NULL, 'a channel message cannot name a DM object');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
               '[{"type":"file","fileType":"image","url":"","path":"c/66666666-0000-0000-0000-000000000006/../f7100000-0000-0000-0000-000000000001/s.png"}]')$q$,
    '42501'::char(5), NULL, 'a path cannot climb out of its room');
SELECT throws_ok(
    $q$INSERT INTO public.messages (conversation_id, user_id, content)
       VALUES ('77777777-0000-0000-0000-000000000007', '11111111-0000-0000-0000-000000000001',
               '[{"type":"file","fileType":"image","url":"","path":"c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/a.png"}]')$q$,
    '42501'::char(5), NULL, 'a DM cannot name a channel object');
SELECT lives_ok(
    $q$INSERT INTO public.messages (conversation_id, user_id, content)
       VALUES ('77777777-0000-0000-0000-000000000007', '11111111-0000-0000-0000-000000000001',
               '[{"type":"file","fileType":"file","url":"https://example.com/legacy.pdf"}]')$q$,
    'a legacy URL part without a path is accepted');
SELECT throws_ok(
    $q$UPDATE public.messages
          SET content = '[{"type":"file","fileType":"image","url":"","path":"c/f7100000-0000-0000-0000-000000000001/aaaaaaaa-0000-0000-0000-000000000001/s.png"}]'
        WHERE id = '88888888-0000-0000-0000-000000000008'$q$,
    '42501'::char(5), NULL, 'an edit cannot point a part at another channel');

-- Service writes follow the same rule.
SELECT tests.clear_authentication();
SELECT lives_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
               '[{"type":"file","fileType":"image","url":"","path":"c/66666666-0000-0000-0000-000000000006/bridge/b/x.png"}]')$q$,
    'a service write names an object of its channel');
SELECT throws_ok(
    $q$INSERT INTO public.messages (channel_id, user_id, content)
       VALUES ('66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
               '[{"type":"file","fileType":"image","url":"","path":"d/77777777-0000-0000-0000-000000000007/bridge/b/x.png"}]')$q$,
    '42501'::char(5), NULL, 'a service write cannot name another room''s object');

-- federation_media_access. --------------------------------------------------------------
SELECT ok(public.federation_media_access(
              'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/a.png', 'remote71.example'),
  'a remote instance with a member reads the channel''s objects');
SELECT ok(public.federation_media_access(
              'c/66666666-0000-0000-0000-000000000006/x/a.png', 'REMOTE71.example '),
  'the domain compares case- and space-insensitively');
SELECT ok(NOT public.federation_media_access(
              'c/66666666-0000-0000-0000-000000000006/x/a.png', 'other71.example'),
  'an instance without a member cannot');
SELECT ok(NOT public.federation_media_access(
              'c/f7100000-0000-0000-0000-000000000001/x/s.png', 'remote71.example'),
  'a remote member without VIEW_CHANNEL gives its instance no access to the channel');
SELECT ok(public.federation_media_access(
              'd/f7120000-0000-0000-0000-000000000001/x/g.png', 'remote71.example')
          AND NOT public.federation_media_access(
              'd/77777777-0000-0000-0000-000000000007/x/dm.png', 'remote71.example'),
  'a remote participant''s instance reads its conversation only');
SELECT ok(public.federation_media_access(
              'c/f7130000-0000-0000-0000-000000000002/x/r.png', 'host71.example')
          AND NOT public.federation_media_access(
              'c/f7130000-0000-0000-0000-000000000002/x/r.png', 'remote71.example'),
  'a remote server''s channel is served to its host');

UPDATE public.servers SET public = true WHERE id = '55555555-0000-0000-0000-000000000005';
SELECT ok(public.federation_media_access('c/66666666-0000-0000-0000-000000000006/x/a.png', '*')
          AND NOT public.federation_media_access('c/f7100000-0000-0000-0000-000000000001/x/s.png', '*')
          AND NOT public.federation_media_access('d/f7120000-0000-0000-0000-000000000001/x/g.png', '*'),
  'the public audience reads open channels of a public server only');
UPDATE public.servers SET public = false WHERE id = '55555555-0000-0000-0000-000000000005';
SELECT ok(NOT public.federation_media_access('c/66666666-0000-0000-0000-000000000006/x/a.png', '*'),
  'a private server has no public audience');

-- A ban flips the membership row; production grants postgres no write on server_bans.
UPDATE public.user_servers SET status = 'banned'
 WHERE server_id = '55555555-0000-0000-0000-000000000005'
   AND user_id = 'f7110000-0000-0000-0000-000000000001';
SELECT ok(NOT public.federation_media_access(
              'c/66666666-0000-0000-0000-000000000006/x/a.png', 'remote71.example'),
  'a banned remote member gives its instance no access');
UPDATE public.conversation_participants SET left_at = now()
 WHERE conversation_id = 'f7120000-0000-0000-0000-000000000001'
   AND user_id = 'f7110000-0000-0000-0000-000000000001';
SELECT ok(NOT public.federation_media_access(
              'd/f7120000-0000-0000-0000-000000000001/x/g.png', 'remote71.example'),
  'a remote participant who left gives its instance no access');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$SELECT public.federation_media_access('c/66666666-0000-0000-0000-000000000006/x/a.png', 'remote71.example')$q$,
    '42501'::char(5), NULL, 'a client cannot call federation_media_access');

-- federation_post_access. --------------------------------------------------------------
SELECT tests.clear_authentication();
UPDATE public.user_servers SET status = 'accepted'
 WHERE server_id = '55555555-0000-0000-0000-000000000005'
   AND user_id = 'f7110000-0000-0000-0000-000000000001';
INSERT INTO public.profiles (id, username, display_name, is_local, domain, federated_id)
VALUES ('f7110000-0000-0000-0000-000000000002', 'dora', 'Dora', false, 'other71.example',
        'https://other71.example/users/dora');
INSERT INTO public.follows (follower_id, following_id, status) VALUES
  ('f7110000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', 'accepted'),
  ('f7110000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', 'pending');
INSERT INTO public.posts (id, author_id, content, visibility, is_deleted) VALUES
  ('f7140000-0000-0000-0000-000000000001', '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"p"}]', 'public', false),
  ('f7140000-0000-0000-0000-000000000002', '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"u"}]', 'unlisted', false),
  ('f7140000-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"f"}]', 'followers', false),
  ('f7140000-0000-0000-0000-000000000004', '11111111-0000-0000-0000-000000000001',
   '[{"type":"mention","userId":"f7110000-0000-0000-0000-000000000002","username":"dora","domain":"other71.example","isLocal":false},{"type":"text","text":" d"}]',
   'direct', false),
  ('f7140000-0000-0000-0000-000000000005', '11111111-0000-0000-0000-000000000001',
   '[{"type":"mention","username":"eve","domain":"third71.example","isLocal":false},{"type":"text","text":" f2"}]',
   'followers', false),
  ('f7140000-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001', '[{"type":"text","text":"gone"}]', 'public', true);

SELECT ok(public.federation_post_access('f7140000-0000-0000-0000-000000000001', NULL)
          AND public.federation_post_access('f7140000-0000-0000-0000-000000000002', NULL),
  'public and unlisted posts are served unsigned');
SELECT ok(NOT public.federation_post_access('f7140000-0000-0000-0000-000000000003', NULL)
          AND NOT public.federation_post_access('f7140000-0000-0000-0000-000000000004', NULL),
  'followers-only and direct posts are not served unsigned');
SELECT ok(public.federation_post_access('f7140000-0000-0000-0000-000000000003', 'Remote71.Example'),
  'a followers-only post is served to an instance with an accepted follower');
SELECT ok(NOT public.federation_post_access('f7140000-0000-0000-0000-000000000003', 'other71.example'),
  'a pending follower gives its instance no access');
SELECT ok(public.federation_post_access('f7140000-0000-0000-0000-000000000005', 'third71.example')
          AND NOT public.federation_post_access('f7140000-0000-0000-0000-000000000005', 'other71.example'),
  'a followers-only post is served to a mentioned recipient''s instance');
SELECT ok(public.federation_post_access('f7140000-0000-0000-0000-000000000004', 'other71.example')
          AND NOT public.federation_post_access('f7140000-0000-0000-0000-000000000004', 'remote71.example'),
  'a direct post is served to its recipient''s instance only, followers excepted');
SELECT ok(NOT public.federation_post_access('f7140000-0000-0000-0000-000000000006', 'remote71.example')
          AND NOT public.federation_post_access('f7140000-0000-0000-0000-000000000099', NULL),
  'deleted and unknown posts are served to nobody');
SELECT ok(public.federation_conversation_access('f7120000-0000-0000-0000-000000000001', 'remote71.example') IS FALSE
          AND public.federation_conversation_access('77777777-0000-0000-0000-000000000007', 'remote71.example') IS FALSE,
  'a conversation is served only while a participant of the instance is in it');
UPDATE public.conversation_participants SET left_at = NULL
 WHERE conversation_id = 'f7120000-0000-0000-0000-000000000001'
   AND user_id = 'f7110000-0000-0000-0000-000000000001';
SELECT ok(public.federation_conversation_access('f7120000-0000-0000-0000-000000000001', 'remote71.example'),
  'a remote participant''s instance reads its conversation');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok(
    $q$SELECT public.federation_post_access('f7140000-0000-0000-0000-000000000003', 'remote71.example')$q$,
    '42501'::char(5), NULL, 'a client cannot call federation_post_access');

-- Object cleanup. -----------------------------------------------------------------------
SELECT tests.clear_authentication();
INSERT INTO storage.objects (bucket_id, name, created_at) VALUES
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/keep.png', now() - interval '2 days'),
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/drop.png', now() - interval '2 days'),
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/twice.png', now() - interval '2 days'),
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/orphan.png', now() - interval '2 days'),
  ('message_media', 'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/fresh.png', now()),
  ('message_media', 'd/77777777-0000-0000-0000-000000000007/bbbbbbbb-0000-0000-0000-000000000002/reported.pdf', now() - interval '2 days'),
  ('message_media', 'd/77777777-0000-0000-0000-000000000007/bbbbbbbb-0000-0000-0000-000000000002/exported.pdf', now() - interval '2 days');
INSERT INTO public.messages (id, channel_id, user_id, content) VALUES
  ('f7150000-0000-0000-0000-000000000001', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type":"file","fileType":"image","url":"","path":"c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/keep.png"},
     {"type":"file","fileType":"image","url":"","path":"c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/drop.png"}]'),
  ('f7150000-0000-0000-0000-000000000002', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type":"file","fileType":"image","url":"","path":"c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/twice.png"}]'),
  ('f7150000-0000-0000-0000-000000000003', '66666666-0000-0000-0000-000000000006', '11111111-0000-0000-0000-000000000001',
   '[{"type":"file","fileType":"image","url":"","path":"c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/twice.png"}]');
INSERT INTO public.messages (id, conversation_id, user_id, content) VALUES
  ('f7150000-0000-0000-0000-000000000004', '77777777-0000-0000-0000-000000000007', '22222222-0000-0000-0000-000000000002',
   '[{"type":"file","fileType":"file","url":"","path":"d/77777777-0000-0000-0000-000000000007/bbbbbbbb-0000-0000-0000-000000000002/reported.pdf"}]'),
  ('f7150000-0000-0000-0000-000000000005', '77777777-0000-0000-0000-000000000007', '22222222-0000-0000-0000-000000000002',
   '[{"type":"file","fileType":"file","url":"","path":"d/77777777-0000-0000-0000-000000000007/bbbbbbbb-0000-0000-0000-000000000002/exported.pdf"}]');
SELECT is((SELECT count(*)::int FROM tests.jobs71 WHERE name = 'delete-message-media'), 0,
  'sending attachments queues no cleanup');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
UPDATE public.messages
   SET content = '[{"type":"file","fileType":"image","url":"","path":"c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/keep.png"},{"type":"text","text":"edited"}]'
 WHERE id = 'f7150000-0000-0000-0000-000000000001';
SELECT is((SELECT data -> 'paths' FROM tests.jobs71 WHERE name = 'delete-message-media'),
  '["c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/drop.png"]'::jsonb,
  'an edit that drops an attachment queues that object only');
UPDATE public.messages SET content = '[{"type":"text","text":"[deleted]"}]', is_deleted = true
 WHERE id = 'f7150000-0000-0000-0000-000000000002';
SELECT is((SELECT count(*)::int FROM tests.jobs71
            WHERE data -> 'paths' ? 'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/twice.png'), 1,
  'a soft delete queues the message''s objects');
SELECT tests.clear_authentication();
DELETE FROM public.messages WHERE id = 'f7150000-0000-0000-0000-000000000004';
SELECT is((SELECT count(*)::int FROM tests.jobs71
            WHERE data -> 'paths' ? 'd/77777777-0000-0000-0000-000000000007/bbbbbbbb-0000-0000-0000-000000000002/reported.pdf'), 1,
  'a hard delete queues the message''s objects');

SELECT set_config('request.jwt.claims', '{}', true);
INSERT INTO public.reports (reporter_id, reported_user_id, reason, report_type, content_snapshot)
VALUES ('11111111-0000-0000-0000-000000000001', '22222222-0000-0000-0000-000000000002', 'spam', 'message',
        jsonb_build_object('message', jsonb_build_object('content', jsonb_build_array(jsonb_build_object(
            'type', 'file', 'path', 'd/77777777-0000-0000-0000-000000000007/bbbbbbbb-0000-0000-0000-000000000002/reported.pdf')))));
INSERT INTO public.account_data_exports (profile_id) VALUES ('22222222-0000-0000-0000-000000000002');
UPDATE public.messages SET content = '[{"type":"text","text":"[deleted]"}]', is_deleted = true
 WHERE id = 'f7150000-0000-0000-0000-000000000005';

SELECT is(
    ARRAY(SELECT public.message_media_deletable(ARRAY[
        'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/drop.png',
        'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/twice.png',
        'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/keep.png'], interval '0') ORDER BY 1),
    ARRAY['c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/drop.png'],
  'a queued object another message still names is kept');
SELECT is(
    ARRAY(SELECT public.message_media_deletable(NULL, interval '1 day') ORDER BY 1),
    ARRAY['c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/drop.png',
          'c/66666666-0000-0000-0000-000000000006/aaaaaaaa-0000-0000-0000-000000000001/orphan.png'],
  'the sweep finds unreferenced objects older than a day; reported, exported and fresh objects stay');
UPDATE public.account_data_exports SET expires_at = now() - interval '1 minute'
 WHERE profile_id = '22222222-0000-0000-0000-000000000002';
SELECT ok('d/77777777-0000-0000-0000-000000000007/bbbbbbbb-0000-0000-0000-000000000002/exported.pdf'
          IN (SELECT public.message_media_deletable(NULL, interval '1 day')),
  'an expired export no longer holds the uploader''s objects');

SELECT tests.authenticate_as('aaaaaaaa-0000-0000-0000-000000000001');
SELECT throws_ok($q$SELECT public.message_media_deletable(NULL)$q$,
    '42501'::char(5), NULL, 'a client cannot list deletable objects');

SELECT * FROM finish();
ROLLBACK;
