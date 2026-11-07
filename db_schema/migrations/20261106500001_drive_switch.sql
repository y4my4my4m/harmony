-- Drive switch: instance_config.drive_enabled, true by default. Off, Drive is no feature of
-- the instance and every upload is kept:
--
--   drive_track_object     no upload is temporary: user_metadata 'ephemeral' and the quota are
--                          ignored (latest before: 20261101100002_drive_photo_details)
--   drive_can_upload       no upload is refused for storage; the upload limits
--                          (storage_upload_limit, 20261031100001_upload_limits) still apply
--   drive_expire_due       temporary files do not expire; trash past 30 days is still deleted.
--                          Turned on again, files whose expiry passed expire on the next run
--   drive_file_shared_with shares admit nobody; a file a live message names stays readable to
--                          the room (message_media_named_for)
--   drive_share_file       refused, 42501
--   drive_link_sharing_enabled  false: links neither open nor are created
--   get_my_drive_usage     carries 'enabled'; clients hide Drive while it is false
--
-- drive_files rows are still written: attachments keep their gone state, hash reuse and
-- moderation (drive_blocked_hashes). Files and folders stay as they are and return with Drive.

BEGIN;

SET LOCAL lock_timeout = '5s';

INSERT INTO public.instance_config (config_key, config_value, description)
VALUES ('drive_enabled', 'true', 'Whether Drive is a feature of this instance; off, uploads are never temporary and have no storage limit')
ON CONFLICT (config_key) DO NOTHING;

-- Absent or anything but false/0: on.
CREATE OR REPLACE FUNCTION public.drive_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT coalesce((SELECT c.config_value #>> '{}' FROM public.instance_config c
                      WHERE c.config_key = 'drive_enabled'), 'true') NOT IN ('false', '0');
$$;

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

        v_ephemeral := public.drive_enabled()
                   AND (coalesce(v_meta ->> 'ephemeral' IN ('true', '1'), false)
                        OR public.drive_used_bytes(v_owner) + v_size > public.drive_quota_bytes(v_owner));

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


CREATE OR REPLACE FUNCTION public.drive_can_upload()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.get_current_profile_id();
BEGIN
    IF v_profile IS NULL OR NOT public.drive_enabled() THEN
        RETURN true;
    END IF;
    IF public.drive_used_bytes(v_profile) < public.drive_quota_bytes(v_profile) THEN
        RETURN true;
    END IF;
    RETURN public.drive_ephemeral_recent_bytes(v_profile)
         < (public.drive_setting('drive_ephemeral_daily_mb', 2048) * 1048576)::bigint;
END;
$$;

CREATE OR REPLACE FUNCTION public.drive_expire_due()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_expired integer := 0;
    v_trash integer;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'drive_expire_due is for service callers' USING ERRCODE = '42501';
    END IF;
    IF public.drive_enabled() THEN
        UPDATE public.drive_files f
           SET state = 'gone', gone_reason = 'expired', updated_at = now()
         WHERE f.state = 'ephemeral' AND f.expires_at <= now();
        GET DIAGNOSTICS v_expired = ROW_COUNT;
    END IF;

    UPDATE public.drive_files f
       SET state = 'gone', gone_reason = 'deleted', trashed_at = NULL, updated_at = now()
     WHERE f.state = 'trashed' AND f.trashed_at <= now() - interval '30 days';
    GET DIAGNOSTICS v_trash = ROW_COUNT;
    RETURN v_expired + v_trash;
END;
$$;

CREATE OR REPLACE FUNCTION public.drive_file_shared_with(p_file uuid, p_profile uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.drive_enabled() AND EXISTS (
        SELECT 1 FROM public.drive_shares s
         WHERE s.file_id = p_file
           AND (s.expires_at IS NULL OR s.expires_at > now())
           AND CASE s.scope
                 WHEN 'user' THEN s.target_id = p_profile
                 WHEN 'channel' THEN public.can_view_channel(p_profile, s.target_id)
                 WHEN 'server' THEN EXISTS (
                     SELECT 1 FROM public.user_servers us
                      WHERE us.server_id = s.target_id AND us.user_id = p_profile AND us.status = 'accepted'
                     UNION ALL
                     SELECT 1 FROM public.servers sv WHERE sv.id = s.target_id AND sv.owner = p_profile)
                 ELSE false
               END);
$$;

CREATE OR REPLACE FUNCTION public.drive_share_file(
    p_file uuid,
    p_scope text,
    p_target uuid,
    p_expires_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
    v_share public.drive_shares;
BEGIN
    IF NOT public.drive_enabled() THEN
        RAISE EXCEPTION 'Drive is turned off on this instance' USING ERRCODE = '42501';
    END IF;
    IF p_scope NOT IN ('user', 'server', 'channel') THEN
        RAISE EXCEPTION 'Unknown share scope %', p_scope USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.drive_files f
                    WHERE f.id = p_file AND f.owner_id = v_profile AND f.state IN ('drive', 'ephemeral')) THEN
        RAISE EXCEPTION 'File not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.drive_files f WHERE f.id = p_file AND f.bucket = 'message_media') THEN
        RAISE EXCEPTION 'Post media is public already' USING ERRCODE = '22023';
    END IF;
    IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
        RAISE EXCEPTION 'The expiry is in the past' USING ERRCODE = '22023';
    END IF;

    IF p_scope = 'user' AND NOT EXISTS (
        SELECT 1 FROM public.profiles p
         WHERE p.id = p_target AND p.is_local IS NOT FALSE AND p.auth_user_id IS NOT NULL AND p.id <> v_profile) THEN
        RAISE EXCEPTION 'Files can be shared with accounts on this instance' USING ERRCODE = '22023';
    ELSIF p_scope = 'server' AND NOT EXISTS (
        SELECT 1 FROM public.user_servers us
         WHERE us.server_id = p_target AND us.user_id = v_profile AND us.status = 'accepted'
        UNION ALL
        SELECT 1 FROM public.servers sv WHERE sv.id = p_target AND sv.owner = v_profile) THEN
        RAISE EXCEPTION 'You are not a member of that server' USING ERRCODE = '42501';
    ELSIF p_scope = 'channel' AND NOT public.can_view_channel(v_profile, p_target) THEN
        RAISE EXCEPTION 'You cannot view that channel' USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.drive_shares (file_id, scope, target_id, expires_at)
    VALUES (p_file, p_scope, p_target, p_expires_at)
    ON CONFLICT (file_id, scope, target_id) WHERE scope <> 'link'
    DO UPDATE SET expires_at = EXCLUDED.expires_at
    RETURNING * INTO v_share;
    RETURN to_jsonb(v_share);
END;
$$;


CREATE OR REPLACE FUNCTION public.drive_link_sharing_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.drive_enabled()
       AND coalesce((SELECT c.config_value #>> '{}' FROM public.instance_config c
                      WHERE c.config_key = 'drive_link_sharing'), 'true') NOT IN ('false', '0');
$$;

CREATE OR REPLACE FUNCTION public.get_my_drive_usage()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
BEGIN
    RETURN jsonb_build_object(
        'enabled', public.drive_enabled(),
        'used_bytes', public.drive_used_bytes(v_profile),
        'quota_bytes', public.drive_quota_bytes(v_profile),
        'ephemeral_bytes', (SELECT coalesce(sum(f.size_bytes), 0) FROM public.drive_files f
                             WHERE f.owner_id = v_profile AND f.state = 'ephemeral'),
        'ephemeral_recent_bytes', public.drive_ephemeral_recent_bytes(v_profile),
        'ephemeral_daily_bytes', (public.drive_setting('drive_ephemeral_daily_mb', 2048) * 1048576)::bigint,
        'ephemeral_days', public.drive_setting('drive_ephemeral_days', 30)::int,
        'trash_bytes', (SELECT coalesce(sum(f.size_bytes), 0) FROM public.drive_files f
                         WHERE f.owner_id = v_profile AND f.state = 'trashed'),
        'file_count', (SELECT count(*) FROM public.drive_files f
                        WHERE f.owner_id = v_profile AND f.state IN ('drive', 'ephemeral')),
        'link_sharing', public.drive_link_sharing_enabled());
END;
$$;

-- Grants as a fresh install has them (db_schema/SURFACE.tsv); live databases lack default
-- privileges, so a replaced function is granted again.
DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOREACH fn IN ARRAY ARRAY['public.drive_enabled()'::regprocedure,
                              'public.drive_track_object()'::regprocedure,
                              'public.drive_can_upload()'::regprocedure,
                              'public.drive_expire_due()'::regprocedure,
                              'public.drive_file_shared_with(uuid, uuid)'::regprocedure,
                              'public.drive_share_file(uuid, text, uuid, timestamptz)'::regprocedure,
                              'public.drive_link_sharing_enabled()'::regprocedure,
                              'public.get_my_drive_usage()'::regprocedure]
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
            END IF;
        END LOOP;
    END LOOP;
    -- drive_can_upload runs in storage.objects policies as the uploader.
    FOREACH fn IN ARRAY ARRAY['public.drive_can_upload()'::regprocedure,
                              'public.drive_share_file(uuid, text, uuid, timestamptz)'::regprocedure,
                              'public.get_my_drive_usage()'::regprocedure]
    LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    END LOOP;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
