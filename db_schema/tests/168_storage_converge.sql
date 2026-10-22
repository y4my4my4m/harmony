-- 20261025100004_storage_converge.sql: with every storage-guarded block skipped, or one of
-- drive_core's redefinitions missing, the converge restores the policies, buckets and triggers
-- the chain leaves; a second run changes nothing.

BEGIN;
SET LOCAL search_path = tests, public;
SELECT plan(15);

CREATE TEMP TABLE storage_shape_want ON COMMIT DROP AS
SELECT 'policy' AS kind, p.polrelid::regclass::text || ' ' || p.polname AS name,
       concat_ws('|', p.polcmd, p.polpermissive, ARRAY(SELECT o FROM unnest(p.polroles) o ORDER BY o)::text,
                 pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)) AS shape
  FROM pg_policy p
 WHERE p.polrelid IN ('storage.objects'::regclass, 'storage.buckets'::regclass)
UNION ALL
SELECT 'bucket', b.id, concat_ws('|', b.public, b.file_size_limit, b.allowed_mime_types::text)
  FROM storage.buckets b
UNION ALL
SELECT 'trigger', t.tgname, pg_get_triggerdef(t.oid)
  FROM pg_trigger t
 WHERE t.tgrelid = 'storage.objects'::regclass AND NOT t.tgisinternal;

CREATE TEMP VIEW storage_shape_have AS
SELECT 'policy' AS kind, p.polrelid::regclass::text || ' ' || p.polname AS name,
       concat_ws('|', p.polcmd, p.polpermissive, ARRAY(SELECT o FROM unnest(p.polroles) o ORDER BY o)::text,
                 pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)) AS shape
  FROM pg_policy p
 WHERE p.polrelid IN ('storage.objects'::regclass, 'storage.buckets'::regclass)
UNION ALL
SELECT 'bucket', b.id, concat_ws('|', b.public, b.file_size_limit, b.allowed_mime_types::text)
  FROM storage.buckets b
UNION ALL
SELECT 'trigger', t.tgname, pg_get_triggerdef(t.oid)
  FROM pg_trigger t
 WHERE t.tgrelid = 'storage.objects'::regclass AND NOT t.tgisinternal;

SELECT ok((SELECT count(*) FROM storage_shape_want WHERE kind = 'policy'
            AND name IN ('storage.objects storage_objects_session_aal',
                         'storage.objects Server owners can delete server banners',
                         'storage.objects Bot owners can upload bot avatars',
                         'storage.objects Writers read soundboard',
                         'storage.objects Soundboard managers can upload sounds',
                         'storage.objects Soundboard managers can delete sounds',
                         'storage.objects Room members can read message media',
                         'storage.objects Room members can upload message media',
                         'storage.objects Uploaders and admins can delete message media',
                         'storage.objects Authenticated users can upload user_media',
                         'storage.objects Users can upload personal emojis',
                         'storage.objects Users can delete personal emojis',
                         'storage.buckets Authenticated users read the message_media bucket')) = 13,
          'the chain leaves the thirteen storage-guarded policies');
SELECT bag_eq($$SELECT name FROM storage_shape_want WHERE kind <> 'policy'
                 AND name IN ('message_media', 'soundboard', 'drive_track_object', 'drive_forget_object')$$,
              ARRAY['message_media', 'soundboard', 'drive_track_object', 'drive_forget_object'],
              'and the message_media and soundboard buckets and the Drive triggers');

-- The migration body, without its BEGIN and COMMIT, from /db_schema/migrations, where
-- scripts/run-db-tests.sh copies db_schema. Absent, the line below prints an ERROR the runner
-- reports.
\! sed -n '/^SET LOCAL lock_timeout/,/^COMMIT;$/p' /db_schema/migrations/20261025100004_storage_converge.sql | sed '$d' > /tmp/converge168.sql
\! test -s /tmp/converge168.sql || echo 'ERROR: /db_schema/migrations/20261025100004_storage_converge.sql is not in the container; copy db_schema to /db_schema'

-- A database whose storage-guarded blocks all skipped: none of their objects, and the
-- user_media upload policy as 20261001200001 left it, without drive_core's quota check.
DROP POLICY storage_objects_session_aal ON storage.objects;
DROP POLICY "Server owners can delete server banners" ON storage.objects;
DROP POLICY "Bot owners can upload bot avatars" ON storage.objects;
DROP POLICY "Soundboard managers can upload sounds" ON storage.objects;
DROP POLICY "Soundboard managers can delete sounds" ON storage.objects;
DROP POLICY "Room members can read message media" ON storage.objects;
DROP POLICY "Room members can upload message media" ON storage.objects;
DROP POLICY "Uploaders and admins can delete message media" ON storage.objects;
DROP POLICY "Users can upload personal emojis" ON storage.objects;
DROP POLICY "Users can delete personal emojis" ON storage.objects;
DROP POLICY "Authenticated users read the message_media bucket" ON storage.buckets;
DROP POLICY "Authenticated users can upload user_media" ON storage.objects;
CREATE POLICY "Authenticated users can upload user_media" ON storage.objects
    AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (((bucket_id = 'user_media'::text) AND (auth.role() = 'authenticated'::text) AND
        (((storage.foldername(name))[1] = (auth.uid())::text) OR ((public.get_current_profile_id() IS
        NOT NULL) AND ((storage.foldername(name))[1] = (public.get_current_profile_id())::text)))));
DELETE FROM storage.buckets WHERE id IN ('message_media', 'soundboard');
DROP TRIGGER drive_track_object ON storage.objects;
DROP TRIGGER drive_forget_object ON storage.objects;
-- 20261023100001 applied, 20261024100001 skipped.
CREATE POLICY "Public read access for link preview images" ON storage.objects
    AS PERMISSIVE FOR SELECT TO public
    USING (bucket_id = 'link-preview-images');

SELECT ok(NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'storage.objects'::regclass
                                                AND polname = 'Room members can read message media'),
          'the simulated skip removed the message media policies');

\i /tmp/converge168.sql

SELECT is_empty($$SELECT kind, name, shape FROM storage_shape_want
                  EXCEPT SELECT kind, name, shape FROM storage_shape_have$$,
                'every policy, bucket and trigger of the chain is back, as the chain defines it');
SELECT is_empty($$SELECT kind, name, shape FROM storage_shape_have
                  EXCEPT SELECT kind, name, shape FROM storage_shape_want$$,
                'and nothing else is left: no probe, no superseded definition, no link preview policy');
SELECT policy_cmd_is('storage', 'objects', 'storage_objects_session_aal', 'ALL',
                     'the session AAL policy covers every command');
SELECT is((SELECT polpermissive FROM pg_policy
            WHERE polrelid = 'storage.objects'::regclass AND polname = 'storage_objects_session_aal'),
          false, 'and is restrictive');
SELECT matches((SELECT pg_get_expr(polwithcheck, polrelid) FROM pg_policy
                 WHERE polrelid = 'storage.objects'::regclass
                   AND polname = 'Authenticated users can upload user_media'),
               'drive_can_upload', 'the superseded user_media upload policy carries the Drive quota check');
SELECT results_eq($$SELECT public, file_size_limit FROM storage.buckets WHERE id = 'message_media'$$,
                  $$VALUES (false, 52428800::bigint)$$, 'message_media is private, 50 MB');
SELECT results_eq($$SELECT public, file_size_limit, allowed_mime_types FROM storage.buckets WHERE id = 'soundboard'$$,
                  $$VALUES (true, 524288::bigint, ARRAY['audio/mpeg', 'audio/ogg', 'audio/wav'])$$,
                  'soundboard is public, 512 KB, three audio types');
SELECT has_trigger('storage', 'objects', 'drive_track_object', 'uploads are tracked in Drive');
SELECT has_trigger('storage', 'objects', 'drive_forget_object', 'deleted objects leave a gone row');

-- A second run keeps every policy as it is and an operator's bucket limits.
CREATE TEMP TABLE storage_policy_oids ON COMMIT DROP AS
SELECT oid, polname FROM pg_policy WHERE polrelid IN ('storage.objects'::regclass, 'storage.buckets'::regclass);
UPDATE storage.buckets SET file_size_limit = 1048576 WHERE id = 'soundboard';

\i /tmp/converge168.sql

SELECT set_eq($$SELECT oid, polname FROM pg_policy
                 WHERE polrelid IN ('storage.objects'::regclass, 'storage.buckets'::regclass)$$,
              $$SELECT oid, polname FROM storage_policy_oids$$,
              'a second run replaces no policy');
SELECT is((SELECT file_size_limit FROM storage.buckets WHERE id = 'soundboard'), 1048576::bigint,
          'a present bucket keeps its configured limit');

-- The applying role may not create policies on storage.objects: nothing changes, nothing raises.
DROP POLICY "Users can delete personal emojis" ON storage.objects;
SET LOCAL ROLE authenticated;
\i /tmp/converge168.sql
RESET ROLE;
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'storage.objects'::regclass
                                                AND polname = 'Users can delete personal emojis'),
          'without the privilege the converge skips');

SELECT * FROM finish();
ROLLBACK;
