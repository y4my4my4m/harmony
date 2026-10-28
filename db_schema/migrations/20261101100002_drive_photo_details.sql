-- Drive files remember whether their bytes still carry photo details.
--
--   drive_files.photo_details   what the uploading client did with a photo's or video's metadata
--                               (src/utils/stripMetadata.ts), from the object's user_metadata
--                               'details':
--     none                      the file carried none
--     removed                   removed before upload
--     kept                      uploaded with "Keep photo details"
--     NULL                      unknown: uploaded before 1.9.2, by another client, or not media
--   drive_files.photo_location  a kept file carries a GPS position (user_metadata 'location');
--                               false for none/removed, NULL when photo_details is NULL
--
-- Composers read both to offer "Keep photo details" when a Drive file is attached or posted.
-- drive_track_object (latest: 20261015100001_drive_core) writes them on insert and when the
-- bytes change (eTag); drive_file_json (latest: 20261027100001_drive_link_access) returns them.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.drive_files
    ADD COLUMN IF NOT EXISTS photo_details text
        CONSTRAINT drive_files_photo_details_check CHECK (photo_details IN ('none', 'removed', 'kept')),
    ADD COLUMN IF NOT EXISTS photo_location boolean;

CREATE OR REPLACE FUNCTION public.drive_track_object()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_meta jsonb;
    v_sha text;
    v_owner uuid;
    v_size bigint;
    v_folder uuid;
    v_ephemeral boolean;
    v_changed boolean;
    v_details text;
    v_location boolean;
BEGIN
    IF NEW.bucket_id NOT IN ('message_media', 'user_media') THEN
        RETURN NULL;
    END IF;

    v_meta := CASE WHEN jsonb_typeof(NEW.user_metadata) = 'object' THEN NEW.user_metadata ELSE '{}'::jsonb END;
    v_sha := lower(v_meta ->> 'sha256');
    IF v_sha IS NOT NULL AND v_sha !~ '^[0-9a-f]{64}$' THEN
        v_sha := NULL;
    END IF;

    -- A hash the moderators blocked: the upload fails and storage-api removes the bytes.
    IF v_sha IS NOT NULL AND EXISTS (SELECT 1 FROM public.drive_blocked_hashes b WHERE b.sha256 = v_sha) THEN
        RAISE EXCEPTION 'This file was removed by the instance moderators' USING ERRCODE = '42501';
    END IF;

    -- Set by the uploading client (src/utils/stripMetadata.ts); absent from older clients.
    v_details := CASE WHEN v_meta ->> 'details' IN ('none', 'removed', 'kept') THEN v_meta ->> 'details' END;
    v_location := CASE WHEN v_details IS NULL THEN NULL
                       ELSE v_details = 'kept' AND coalesce(v_meta ->> 'location' IN ('true', '1'), false) END;

    BEGIN
        v_size := CASE WHEN NEW.metadata ->> 'size' ~ '^\d{1,18}$' THEN (NEW.metadata ->> 'size')::bigint ELSE 0 END;

        IF TG_OP = 'UPDATE' THEN
            v_changed := OLD.metadata ->> 'eTag' IS DISTINCT FROM NEW.metadata ->> 'eTag';
            UPDATE public.drive_files f
               SET bucket = NEW.bucket_id,
                   path = NEW.name,
                   size_bytes = v_size,
                   mime_type = coalesce(NEW.metadata ->> 'mimetype', f.mime_type),
                   sha256 = CASE WHEN v_changed THEN v_sha ELSE f.sha256 END,
                   sha256_verified = CASE WHEN v_changed THEN false ELSE f.sha256_verified END,
                   photo_details = CASE WHEN v_changed THEN v_details ELSE f.photo_details END,
                   photo_location = CASE WHEN v_changed THEN v_location ELSE f.photo_location END,
                   updated_at = now()
             WHERE f.bucket = OLD.bucket_id AND f.path = OLD.name;
            IF FOUND THEN
                RETURN NULL;
            END IF;
        END IF;

        v_owner := public.drive_object_owner(NEW.bucket_id, NEW.name, NEW.owner);
        IF v_owner IS NULL THEN
            RETURN NULL;
        END IF;

        IF v_meta ->> 'folder' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
            SELECT d.id INTO v_folder FROM public.drive_folders d
             WHERE d.id = (v_meta ->> 'folder')::uuid AND d.owner_id = v_owner;
        END IF;

        v_ephemeral := coalesce(v_meta ->> 'ephemeral' IN ('true', '1'), false)
                    OR public.drive_used_bytes(v_owner) + v_size > public.drive_quota_bytes(v_owner);

        INSERT INTO public.drive_files (
            owner_id, bucket, path, name, mime_type, size_bytes, sha256, folder_id,
            state, ephemeral_at_upload, expires_at, photo_details, photo_location, created_at, updated_at)
        VALUES (
            v_owner, NEW.bucket_id, NEW.name, public.drive_clean_name(v_meta ->> 'name'),
            NEW.metadata ->> 'mimetype', v_size, v_sha, v_folder,
            CASE WHEN v_ephemeral THEN 'ephemeral' ELSE 'drive' END,
            v_ephemeral,
            CASE WHEN v_ephemeral
                 THEN now() + make_interval(days => public.drive_setting('drive_ephemeral_days', 30)::int) END,
            v_details, v_location,
            coalesce(NEW.created_at, now()), now())
        ON CONFLICT (bucket, path) DO NOTHING;

        PERFORM public.queue_federation_job('drive-hash',
            jsonb_build_object('type', 'hash', 'bucket', NEW.bucket_id, 'path', NEW.name));
    EXCEPTION WHEN OTHERS THEN
        -- Tracking never fails an upload; the sweep re-reads objects without a row.
        RAISE WARNING 'drive_track_object % %: %', NEW.bucket_id, NEW.name, SQLERRM;
    END;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.drive_file_json(f public.drive_files)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'id', f.id, 'owner_id', f.owner_id, 'bucket', f.bucket, 'path', f.path, 'name', f.name,
        'mime_type', f.mime_type, 'kind', public.drive_mime_kind(f.mime_type),
        'size_bytes', f.size_bytes, 'sha256', f.sha256, 'folder_id', f.folder_id, 'state', f.state,
        'gone_reason', f.gone_reason, 'expires_at', f.expires_at, 'trashed_at', f.trashed_at,
        'created_at', f.created_at, 'updated_at', f.updated_at, 'link_token', f.link_token,
        'photo_details', f.photo_details, 'photo_location', f.photo_location);
$$;

DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOREACH fn IN ARRAY ARRAY['public.drive_track_object()'::regprocedure,
                              'public.drive_file_json(public.drive_files)'::regprocedure]
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
