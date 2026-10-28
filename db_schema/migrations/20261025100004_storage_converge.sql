-- The storage objects that migrations create inside blocks guarded on storage.objects or
-- storage.buckets, as the latest migration defines each:
--   storage.objects policies
--     storage_objects_session_aal                      RESTRICTIVE ALL  (20261005400001_account_security)
--     "Server owners can delete server banners"        DELETE  (20261025100005_server_media_uuid_guard)
--     "Bot owners can upload bot avatars"              INSERT  (20261006500001_server_media_delete_policies)
--     "Soundboard managers can upload sounds"          INSERT  (20261011300001_soundboard)
--     "Soundboard managers can delete sounds"          DELETE  (20261011300001_soundboard)
--     "Room members can read message media"            SELECT  (20261015100001_drive_core)
--     "Room members can upload message media"          INSERT  (20261015100001_drive_core)
--     "Uploaders and admins can delete message media"  DELETE  (20261015100001_drive_core)
--     "Authenticated users can upload user_media"      INSERT  (20261015100001_drive_core)
--     "Users can upload personal emojis"               INSERT  (20261016100004_personal_emoji_uploads)
--     "Users can delete personal emojis"               DELETE  (20261016100004_personal_emoji_uploads)
--   storage.buckets policy
--     "Authenticated users read the message_media bucket"  SELECT  (20261006900001_private_user_media)
--   buckets message_media (20261006900001_private_user_media), soundboard (20261011300001_soundboard)
--   triggers drive_track_object, drive_forget_object on storage.objects (20261015100001_drive_core)
--   "Public read access for link preview images" absent (20261024100001_drop_link_preview_images)
-- Soundboard reads are 20261026700001's "Writers read soundboard", outside this converge.
--
-- Those blocks skip when the storage tables are absent, and the account_security block also
-- when the applying role may not create policies on storage.objects; the migration is recorded
-- as applied either way. supabase/postgres 15.8.1.060 ships both tables, owned by
-- supabase_storage_admin with postgres a member, so the pinned stack takes every block; a
-- database built another way may not.
--
-- A policy is compared by shape (command, permissive, roles, deparsed USING and WITH CHECK)
-- against a probe created from the latest definition: absent, the probe takes its name;
-- identical, the probe is dropped; different, it replaces the policy and the old shape is
-- printed. drive_core redefines four policies that earlier migrations create, "Authenticated
-- users can upload user_media" in an unguarded block, so a name check alone keeps a superseded
-- definition: that one without the Drive quota check.
--
-- Bucket rows are inserted where absent; a present row keeps its limits and MIME list, and a
-- difference is printed. Present triggers are left alone. CREATE POLICY takes an ACCESS
-- EXCLUSIVE lock on storage.objects; lock_timeout keeps a long transaction from stalling
-- uploads.

BEGIN;
SET LOCAL lock_timeout = '5s';

DO $$
DECLARE
    v_objects regclass;
    v_buckets regclass;
    v_probe   constant text := 'storage_converge_probe';
    r         record;
    v_old     record;
    v_new     record;
BEGIN
    v_objects := to_regclass('storage.objects');
    v_buckets := to_regclass('storage.buckets');
    IF v_objects IS NULL OR v_buckets IS NULL THEN
        RAISE NOTICE 'storage.objects or storage.buckets absent, storage converge skipped';
        RETURN;
    END IF;

    FOR r IN
        SELECT p.tbl::regclass AS rel, p.name, p.ddl FROM (VALUES
        ('storage.objects', 'storage_objects_session_aal', $ddl$
            CREATE POLICY __POLICY__ ON storage.objects
                AS RESTRICTIVE FOR ALL TO authenticated
                USING ((SELECT public.session_meets_aal()))
                WITH CHECK ((SELECT public.session_meets_aal()))
        $ddl$),
        ('storage.objects', 'Server owners can delete server banners', $ddl$
            CREATE POLICY __POLICY__ ON storage.objects
                AS PERMISSIVE FOR DELETE TO public
                USING ((bucket_id = 'server_banners'::text) AND public.has_permission(public.get_current_profile_id(),
                    CASE WHEN (storage.foldername(name))[1] ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
                         THEN ((storage.foldername(name))[1])::uuid END, 'MANAGE_SERVER'::text))
        $ddl$),
        ('storage.objects', 'Bot owners can upload bot avatars', $ddl$
            CREATE POLICY __POLICY__ ON storage.objects
                AS PERMISSIVE FOR INSERT TO authenticated
                WITH CHECK (((bucket_id = 'avatars'::text) AND ((storage.foldername(objects.name))[1] = 'bots'::text)
                    AND (EXISTS (SELECT 1 FROM public.bots b
                                  WHERE (b.id)::text = (storage.foldername(objects.name))[2]
                                    AND b.owner_id = (SELECT public.get_current_profile_id())))))
        $ddl$),
        ('storage.objects', 'Soundboard managers can upload sounds', $ddl$
            CREATE POLICY __POLICY__ ON storage.objects
                AS PERMISSIVE FOR INSERT TO authenticated
                WITH CHECK (bucket_id = 'soundboard'
                            AND public.can_manage_server_sounds(public.soundboard_object_server(name)))
        $ddl$),
        ('storage.objects', 'Soundboard managers can delete sounds', $ddl$
            CREATE POLICY __POLICY__ ON storage.objects
                AS PERMISSIVE FOR DELETE TO authenticated
                USING (bucket_id = 'soundboard'
                       AND public.can_manage_server_sounds(public.soundboard_object_server(name)))
        $ddl$),
        ('storage.objects', 'Room members can read message media', $ddl$
            CREATE POLICY __POLICY__ ON storage.objects
                AS PERMISSIVE FOR SELECT TO authenticated
                USING (
                    bucket_id = 'message_media'
                    AND (
                        (storage.foldername(name))[3] = (SELECT auth.uid())::text
                        OR (storage.foldername(name))[3] = (SELECT public.get_current_profile_id())::text
                        OR ((storage.foldername(name))[1] = 'u'
                            AND (storage.foldername(name))[2] = (SELECT auth.uid())::text)
                        OR public.message_media_readable(name)
                        OR public.message_media_reported(name)
                    )
                )
        $ddl$),
        ('storage.objects', 'Room members can upload message media', $ddl$
            CREATE POLICY __POLICY__ ON storage.objects
                AS PERMISSIVE FOR INSERT TO authenticated
                WITH CHECK (
                    bucket_id = 'message_media'
                    AND (SELECT public.drive_can_upload())
                    AND (
                        ((storage.foldername(name))[3] = (SELECT auth.uid())::text
                         AND public.message_media_in_room(name))
                        OR ((storage.foldername(name))[1] = 'u'
                            AND (storage.foldername(name))[2] = (SELECT auth.uid())::text
                            AND cardinality(storage.foldername(name)) = 2)
                    )
                )
        $ddl$),
        ('storage.objects', 'Uploaders and admins can delete message media', $ddl$
            CREATE POLICY __POLICY__ ON storage.objects
                AS PERMISSIVE FOR DELETE TO authenticated
                USING (
                    bucket_id = 'message_media'
                    AND (
                        (storage.foldername(name))[3] = (SELECT auth.uid())::text
                        OR (storage.foldername(name))[3] = (SELECT public.get_current_profile_id())::text
                        OR ((storage.foldername(name))[1] = 'u'
                            AND (storage.foldername(name))[2] = (SELECT auth.uid())::text)
                        OR (SELECT public.is_current_user_admin())
                    )
                )
        $ddl$),
        ('storage.objects', 'Authenticated users can upload user_media', $ddl$
            CREATE POLICY __POLICY__ ON storage.objects
                AS PERMISSIVE FOR INSERT TO public
                WITH CHECK (
                    bucket_id = 'user_media'
                    AND auth.role() = 'authenticated'
                    AND (SELECT public.drive_can_upload())
                    AND (
                        (storage.foldername(name))[1] = (auth.uid())::text
                        OR (public.get_current_profile_id() IS NOT NULL
                            AND (storage.foldername(name))[1] = (public.get_current_profile_id())::text)
                    )
                )
        $ddl$),
        ('storage.objects', 'Users can upload personal emojis', $ddl$
            CREATE POLICY __POLICY__ ON storage.objects
                AS PERMISSIVE FOR INSERT TO authenticated
                WITH CHECK (bucket_id = 'emojis'
                            AND array_length(storage.foldername(name), 1) = 1
                            AND (storage.foldername(name))[1] = (SELECT public.get_current_profile_id())::text)
        $ddl$),
        ('storage.objects', 'Users can delete personal emojis', $ddl$
            CREATE POLICY __POLICY__ ON storage.objects
                AS PERMISSIVE FOR DELETE TO authenticated
                USING (bucket_id = 'emojis'
                       AND array_length(storage.foldername(name), 1) = 1
                       AND (storage.foldername(name))[1] = (SELECT public.get_current_profile_id())::text)
        $ddl$),
        ('storage.buckets', 'Authenticated users read the message_media bucket', $ddl$
            CREATE POLICY __POLICY__ ON storage.buckets
                AS PERMISSIVE FOR SELECT TO authenticated
                USING (id = 'message_media')
        $ddl$)
        ) AS p(tbl, name, ddl)
    LOOP
        EXECUTE replace(r.ddl, '__POLICY__', quote_ident(v_probe));
        SELECT p.polcmd AS cmd, p.polpermissive AS permissive,
               ARRAY(SELECT o FROM unnest(p.polroles) o ORDER BY o) AS roles,
               pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS chk
          INTO v_new
          FROM pg_policy p WHERE p.polrelid = r.rel AND p.polname = v_probe;
        SELECT p.polcmd AS cmd, p.polpermissive AS permissive,
               ARRAY(SELECT o FROM unnest(p.polroles) o ORDER BY o) AS roles,
               pg_get_expr(p.polqual, p.polrelid) AS qual, pg_get_expr(p.polwithcheck, p.polrelid) AS chk
          INTO v_old
          FROM pg_policy p WHERE p.polrelid = r.rel AND p.polname = r.name;

        IF NOT FOUND THEN
            EXECUTE format('ALTER POLICY %I ON %s RENAME TO %I', v_probe, r.rel, r.name);
            RAISE NOTICE '% policy % installed', r.rel, quote_ident(r.name);
        ELSIF (v_old.cmd, v_old.permissive, v_old.roles, v_old.qual, v_old.chk)
              IS NOT DISTINCT FROM (v_new.cmd, v_new.permissive, v_new.roles, v_new.qual, v_new.chk) THEN
            EXECUTE format('DROP POLICY %I ON %s', v_probe, r.rel);
        ELSE
            EXECUTE format('DROP POLICY %I ON %s', r.name, r.rel);
            EXECUTE format('ALTER POLICY %I ON %s RENAME TO %I', v_probe, r.rel, r.name);
            RAISE NOTICE '% policy % replaced, was cmd=% permissive=% roles=% using=% check=%',
                r.rel, quote_ident(r.name), v_old.cmd, v_old.permissive, v_old.roles,
                coalesce(v_old.qual, '-'), coalesce(v_old.chk, '-');
        END IF;
    END LOOP;

    IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = v_objects
                                         AND polname = 'Public read access for link preview images') THEN
        DROP POLICY "Public read access for link preview images" ON storage.objects;
        RAISE NOTICE 'storage.objects policy "Public read access for link preview images" dropped';
    END IF;
    IF EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'link-preview-images') THEN
        RAISE NOTICE 'bucket link-preview-images left in place: 20261024100001 removes it with its objects';
    END IF;

    -- message_media has no bucket limit: per-account upload limits (20261031100001).
    FOR r IN
        WITH want (id, public, file_size_limit, allowed_mime_types) AS (VALUES
            ('message_media', false, NULL::bigint, ARRAY[
                'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/avif',
                'image/apng', 'image/bmp', 'image/heic', 'image/heif', 'image/tiff',
                'video/*', 'audio/*',
                'application/pdf', 'text/plain',
                'application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'application/vnd.oasis.opendocument.text',
                'application/zip', 'application/x-zip-compressed',
                'application/vnd.rar', 'application/x-rar-compressed',
                'application/x-7z-compressed', 'application/gzip', 'application/x-tar',
                'application/octet-stream']),
            ('soundboard', true, 524288::bigint, ARRAY['audio/mpeg', 'audio/ogg', 'audio/wav'])
        ),
        added AS (
            INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
            SELECT id, id, public, file_size_limit, allowed_mime_types FROM want
            ON CONFLICT (id) DO NOTHING
            RETURNING id
        )
        SELECT w.id, a.id IS NOT NULL AS added,
               b.public, w.public AS want_public,
               b.file_size_limit, w.file_size_limit AS want_limit,
               b.allowed_mime_types IS DISTINCT FROM w.allowed_mime_types AS mime_differs
          FROM want w
          LEFT JOIN added a ON a.id = w.id
          LEFT JOIN storage.buckets b ON b.id = w.id
    LOOP
        IF r.added THEN
            RAISE NOTICE 'bucket % installed', r.id;
        ELSIF (r.public, r.file_size_limit, r.mime_differs)
              IS DISTINCT FROM (r.want_public, r.want_limit, false) THEN
            RAISE NOTICE 'bucket % kept as configured: public=% (migrations: %), file_size_limit=% (migrations: %), MIME list differs: %',
                r.id, r.public, r.want_public, r.file_size_limit, r.want_limit, r.mime_differs;
        END IF;
    END LOOP;

    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = v_objects AND tgname = 'drive_track_object') THEN
        CREATE TRIGGER drive_track_object
            AFTER INSERT OR UPDATE ON storage.objects
            FOR EACH ROW EXECUTE FUNCTION public.drive_track_object();
        RAISE NOTICE 'storage.objects trigger drive_track_object installed';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = v_objects AND tgname = 'drive_forget_object') THEN
        CREATE TRIGGER drive_forget_object
            AFTER DELETE ON storage.objects
            FOR EACH ROW EXECUTE FUNCTION public.drive_forget_object();
        RAISE NOTICE 'storage.objects trigger drive_forget_object installed';
    END IF;
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'storage converge skipped: %', SQLERRM;
END;
$$;

COMMIT;
