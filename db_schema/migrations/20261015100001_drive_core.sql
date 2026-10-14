-- Drive: the files a local account stored on this instance.
--
-- Every object a local account uploads to message_media or user_media is a drive_files row,
-- written by a trigger on storage.objects. Avatars, banners, server icons, emoji and
-- soundboard clips are not Drive files.
--
-- message_media object names:
--   c/<channel id>/<uploader>/<file>        uploaded into a channel or thread
--   d/<conversation id>/<uploader>/<file>   uploaded into a direct or group conversation
--   u/<uploader auth uid>/<file>            uploaded in Drive itself
--
-- drive_files.state
--   drive      kept; counts toward the quota
--   ephemeral  over the quota at upload, or sent as temporary; deleted at expires_at
--   trashed    in the owner's trash; counts toward the quota; owner-only
--   gone       object deleted (gone_reason expired | deleted | removed); the row stays so
--              messages can say why the file is missing
--
-- Quota (drive_quota_bytes): an admin override, else instance_config by role: instance admins
-- drive_quota_admin_mb, moderators drive_quota_moderator_mb, others drive_quota_user_mb.
-- Usage (drive_used_bytes): drive + trashed bytes, files with the same verified SHA-256
-- counted once. An upload that would pass the quota, or whose user_metadata asks for
-- ephemeral, is ephemeral for drive_ephemeral_days. Uploads are refused only while the account
-- is over quota and its ephemeral uploads of the last 24 hours reached
-- drive_ephemeral_daily_mb.
--
-- user_metadata the uploader may set (storage-api `metadata` upload option):
--   sha256 (64 hex), name (display name; omitted for encrypted rooms), ephemeral (true),
--   folder (a drive_folders id of the uploader).
--
-- message_media read access (storage.objects SELECT):
--   the uploader; a caller who views a room whose live message names the object (file part
--   `path` or media_paths); a caller an explicit share admits; a moderator of a report naming
--   it. A trashed or gone file admits only its owner. An object no live message names is not
--   readable by the room it was uploaded into: a Drive file outlives its message.
-- The message path guard accepts, besides objects of the message's own room, message_media
-- files the author owns in Drive (reuse without upload).
-- federation_media_access admits a domain for the object's own room and for every room whose
-- live message names it, by the per-room rules of 20261006900001.
--
-- message_media_deletable spares objects whose file is drive or trashed (deleting a message
-- keeps the Drive file), ephemeral files not yet expired that no message ever needed (u/), and
-- objects a live message in any room names.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

INSERT INTO public.instance_config (config_key, config_value, description) VALUES
    ('drive_quota_user_mb', '1024', 'Drive storage per account, MB'),
    ('drive_quota_moderator_mb', '25600', 'Drive storage per instance moderator, MB'),
    ('drive_quota_admin_mb', '102400', 'Drive storage per instance admin, MB'),
    ('drive_ephemeral_days', '30', 'Days a temporary upload is kept'),
    ('drive_ephemeral_daily_mb', '2048', 'Temporary uploads per 24 hours for an account over its Drive quota, MB'),
    ('drive_link_sharing', 'true', 'Whether Drive files can be shared by link')
ON CONFLICT (config_key) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.drive_folders (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    parent_id uuid REFERENCES public.drive_folders(id) ON DELETE CASCADE,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT drive_folders_name_check
        CHECK (char_length(btrim(name)) BETWEEN 1 AND 120 AND name = btrim(name) AND name !~ '[/\\[:cntrl:]]'),
    CONSTRAINT drive_folders_not_own_parent CHECK (parent_id IS DISTINCT FROM id)
);

CREATE UNIQUE INDEX IF NOT EXISTS drive_folders_owner_parent_name
    ON public.drive_folders (owner_id, coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));
CREATE INDEX IF NOT EXISTS drive_folders_parent ON public.drive_folders (parent_id);

CREATE TABLE IF NOT EXISTS public.drive_files (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    owner_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    bucket text NOT NULL,
    path text NOT NULL,
    name text,
    mime_type text,
    size_bytes bigint DEFAULT 0 NOT NULL,
    sha256 text,
    sha256_verified boolean DEFAULT false NOT NULL,
    folder_id uuid REFERENCES public.drive_folders(id) ON DELETE SET NULL,
    state text DEFAULT 'drive' NOT NULL,
    gone_reason text,
    ephemeral_at_upload boolean DEFAULT false NOT NULL,
    expires_at timestamp with time zone,
    trashed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT drive_files_bucket_check CHECK (bucket IN ('message_media', 'user_media')),
    CONSTRAINT drive_files_bucket_path_key UNIQUE (bucket, path),
    CONSTRAINT drive_files_name_check CHECK (name IS NULL OR char_length(name) BETWEEN 1 AND 255),
    CONSTRAINT drive_files_size_check CHECK (size_bytes >= 0),
    CONSTRAINT drive_files_sha256_check CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT drive_files_state_check CHECK (state IN ('drive', 'ephemeral', 'trashed', 'gone')),
    CONSTRAINT drive_files_gone_reason_check
        CHECK ((state = 'gone') = (gone_reason IS NOT NULL)
               AND (gone_reason IS NULL OR gone_reason IN ('expired', 'deleted', 'removed'))),
    CONSTRAINT drive_files_ephemeral_expiry CHECK (state <> 'ephemeral' OR expires_at IS NOT NULL),
    CONSTRAINT drive_files_trashed_at CHECK (state <> 'trashed' OR trashed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS drive_files_owner_state ON public.drive_files (owner_id, state);
CREATE INDEX IF NOT EXISTS drive_files_owner_sha256 ON public.drive_files (owner_id, sha256) WHERE sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS drive_files_folder ON public.drive_files (folder_id) WHERE folder_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS drive_files_expiry ON public.drive_files (expires_at) WHERE state = 'ephemeral';
CREATE INDEX IF NOT EXISTS drive_files_trash ON public.drive_files (trashed_at) WHERE state = 'trashed';
CREATE INDEX IF NOT EXISTS drive_files_unverified ON public.drive_files (created_at)
    WHERE NOT sha256_verified AND state IN ('drive', 'ephemeral', 'trashed');
CREATE INDEX IF NOT EXISTS drive_files_name_trgm ON public.drive_files USING gin (lower(name) extensions.gin_trgm_ops);

CREATE TABLE IF NOT EXISTS public.drive_shares (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    file_id uuid NOT NULL REFERENCES public.drive_files(id) ON DELETE CASCADE,
    scope text NOT NULL,
    target_id uuid,
    token text,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT drive_shares_scope_check CHECK (scope IN ('user', 'server', 'channel', 'link')),
    CONSTRAINT drive_shares_target_check CHECK ((scope = 'link') = (target_id IS NULL)),
    CONSTRAINT drive_shares_token_check CHECK ((scope = 'link') = (token IS NOT NULL)),
    CONSTRAINT drive_shares_token_key UNIQUE (token)
);

CREATE UNIQUE INDEX IF NOT EXISTS drive_shares_target_key
    ON public.drive_shares (file_id, scope, target_id) WHERE scope <> 'link';
CREATE UNIQUE INDEX IF NOT EXISTS drive_shares_link_key ON public.drive_shares (file_id) WHERE scope = 'link';
CREATE INDEX IF NOT EXISTS drive_shares_target ON public.drive_shares (scope, target_id) WHERE target_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.drive_quota_overrides (
    profile_id uuid NOT NULL PRIMARY KEY REFERENCES public.profiles(id) ON DELETE CASCADE,
    quota_bytes bigint NOT NULL,
    set_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT drive_quota_overrides_bytes_check CHECK (quota_bytes >= 0)
);

CREATE TABLE IF NOT EXISTS public.drive_blocked_hashes (
    sha256 text NOT NULL PRIMARY KEY,
    reason text,
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT drive_blocked_hashes_sha256_check CHECK (sha256 ~ '^[0-9a-f]{64}$')
);

-- A block staff asked for while the file's sha256 was the uploader's unverified claim. The
-- object stays until the hash job computes the real hash; drive_record_hash blocks that and
-- drops the row. Kept apart from drive_files: its owner reads that row.
CREATE TABLE IF NOT EXISTS public.drive_pending_blocks (
    file_id uuid NOT NULL PRIMARY KEY REFERENCES public.drive_files(id) ON DELETE CASCADE,
    reason text,
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE public.drive_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drive_files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drive_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drive_quota_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drive_blocked_hashes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.drive_pending_blocks ENABLE ROW LEVEL SECURITY;

-- Owners read their own rows; every write goes through the drive_* functions.
DROP POLICY IF EXISTS drive_folders_select_owner ON public.drive_folders;
CREATE POLICY drive_folders_select_owner ON public.drive_folders
    FOR SELECT TO authenticated
    USING (owner_id = (SELECT public.get_current_profile_id()));

DROP POLICY IF EXISTS drive_files_select_owner ON public.drive_files;
CREATE POLICY drive_files_select_owner ON public.drive_files
    FOR SELECT TO authenticated
    USING (owner_id = (SELECT public.get_current_profile_id()));

DROP POLICY IF EXISTS drive_shares_select_owner ON public.drive_shares;
CREATE POLICY drive_shares_select_owner ON public.drive_shares
    FOR SELECT TO authenticated
    USING (EXISTS (SELECT 1 FROM public.drive_files f
                    WHERE f.id = drive_shares.file_id
                      AND f.owner_id = (SELECT public.get_current_profile_id())));

DROP POLICY IF EXISTS drive_quota_overrides_select_admin ON public.drive_quota_overrides;
CREATE POLICY drive_quota_overrides_select_admin ON public.drive_quota_overrides
    FOR SELECT TO authenticated
    USING ((SELECT public.is_current_user_admin()));

DROP POLICY IF EXISTS drive_blocked_hashes_select_staff ON public.drive_blocked_hashes;
CREATE POLICY drive_blocked_hashes_select_staff ON public.drive_blocked_hashes
    FOR SELECT TO authenticated
    USING ((SELECT public.is_current_user_admin_or_mod()));

DROP POLICY IF EXISTS drive_pending_blocks_select_staff ON public.drive_pending_blocks;
CREATE POLICY drive_pending_blocks_select_staff ON public.drive_pending_blocks
    FOR SELECT TO authenticated
    USING ((SELECT public.is_current_user_admin_or_mod()));

REVOKE ALL ON public.drive_folders, public.drive_files, public.drive_shares,
              public.drive_quota_overrides, public.drive_blocked_hashes,
              public.drive_pending_blocks FROM anon, authenticated;
GRANT SELECT ON public.drive_folders, public.drive_files, public.drive_shares,
                public.drive_quota_overrides, public.drive_blocked_hashes,
                public.drive_pending_blocks TO authenticated;
GRANT ALL ON public.drive_folders, public.drive_files, public.drive_shares,
             public.drive_quota_overrides, public.drive_blocked_hashes,
             public.drive_pending_blocks TO service_role;

-- ---------------------------------------------------------------------------
-- Limits and usage
-- ---------------------------------------------------------------------------

-- A numeric instance_config value; p_default when absent or not a number.
CREATE OR REPLACE FUNCTION public.drive_setting(p_key text, p_default numeric)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT coalesce((
        SELECT CASE
                 WHEN jsonb_typeof(c.config_value) = 'number' THEN (c.config_value #>> '{}')::numeric
                 WHEN jsonb_typeof(c.config_value) = 'string' AND (c.config_value #>> '{}') ~ '^\d+(\.\d+)?$'
                   THEN (c.config_value #>> '{}')::numeric
               END
          FROM public.instance_config c
         WHERE c.config_key = p_key), p_default);
$$;

CREATE OR REPLACE FUNCTION public.drive_quota_bytes(p_profile uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT coalesce(
        (SELECT o.quota_bytes FROM public.drive_quota_overrides o WHERE o.profile_id = p_profile),
        (SELECT (CASE
                   WHEN p.is_admin THEN public.drive_setting('drive_quota_admin_mb', 102400)
                   WHEN p.is_moderator THEN public.drive_setting('drive_quota_moderator_mb', 25600)
                   ELSE public.drive_setting('drive_quota_user_mb', 1024)
                 END * 1048576)::bigint
           FROM public.profiles p
          WHERE p.id = p_profile),
        0);
$$;

-- Bytes of drive and trashed files; files sharing a verified SHA-256 count once.
CREATE OR REPLACE FUNCTION public.drive_used_bytes(p_profile uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT coalesce(sum(u.size_bytes), 0)::bigint
      FROM (
        SELECT DISTINCT ON (CASE WHEN f.sha256_verified THEN f.sha256 ELSE f.id::text END) f.size_bytes
          FROM public.drive_files f
         WHERE f.owner_id = p_profile
           AND f.state IN ('drive', 'trashed')
         ORDER BY CASE WHEN f.sha256_verified THEN f.sha256 ELSE f.id::text END, f.size_bytes DESC
      ) u;
$$;

-- Bytes uploaded as ephemeral in the last 24 hours, whatever became of them.
CREATE OR REPLACE FUNCTION public.drive_ephemeral_recent_bytes(p_profile uuid)
RETURNS bigint
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT coalesce(sum(f.size_bytes), 0)::bigint
      FROM public.drive_files f
     WHERE f.owner_id = p_profile
       AND f.ephemeral_at_upload
       AND f.created_at > now() - interval '24 hours';
$$;

-- False when the caller is over quota and its ephemeral allowance for the day is used.
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
    IF v_profile IS NULL THEN
        RETURN true;
    END IF;
    IF public.drive_used_bytes(v_profile) < public.drive_quota_bytes(v_profile) THEN
        RETURN true;
    END IF;
    RETURN public.drive_ephemeral_recent_bytes(v_profile)
         < (public.drive_setting('drive_ephemeral_daily_mb', 2048) * 1048576)::bigint;
END;
$$;

-- Display name from user_metadata or a file part: trimmed, no control characters or
-- slashes, at most 255 characters; NULL when nothing is left.
CREATE OR REPLACE FUNCTION public.drive_clean_name(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT nullif(left(btrim(regexp_replace(coalesce(p_name, ''), '[[:cntrl:]/\\]+', ' ', 'g')), 255), '');
$$;

-- ---------------------------------------------------------------------------
-- storage.objects -> drive_files
-- ---------------------------------------------------------------------------

-- Profile of the local account that uploaded an object: the storage owner, else the uploader
-- segment of the name (auth uid or profile id).
CREATE OR REPLACE FUNCTION public.drive_object_owner(p_bucket text, p_name text, p_owner uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_seg text[] := string_to_array(p_name, '/');
    v_candidate text;
    v_profile uuid;
BEGIN
    IF p_owner IS NOT NULL THEN
        SELECT p.id INTO v_profile FROM public.profiles p
         WHERE p.auth_user_id = p_owner AND p.is_local IS NOT FALSE;
        IF v_profile IS NOT NULL THEN
            RETURN v_profile;
        END IF;
    END IF;

    v_candidate := CASE
        WHEN p_bucket = 'message_media' AND v_seg[1] IN ('c', 'd') THEN v_seg[3]
        WHEN p_bucket = 'message_media' AND v_seg[1] = 'u' THEN v_seg[2]
        WHEN p_bucket = 'user_media' THEN v_seg[1]
    END;
    IF v_candidate IS NULL
       OR v_candidate !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN NULL;
    END IF;

    SELECT p.id INTO v_profile FROM public.profiles p
     WHERE (p.auth_user_id = v_candidate::uuid OR p.id = v_candidate::uuid)
       AND p.is_local IS NOT FALSE
     ORDER BY (p.auth_user_id = v_candidate::uuid) DESC
     LIMIT 1;
    RETURN v_profile;
END;
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
            state, ephemeral_at_upload, expires_at, created_at, updated_at)
        VALUES (
            v_owner, NEW.bucket_id, NEW.name, public.drive_clean_name(v_meta ->> 'name'),
            NEW.metadata ->> 'mimetype', v_size, v_sha, v_folder,
            CASE WHEN v_ephemeral THEN 'ephemeral' ELSE 'drive' END,
            v_ephemeral,
            CASE WHEN v_ephemeral
                 THEN now() + make_interval(days => public.drive_setting('drive_ephemeral_days', 30)::int) END,
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

-- An object deleted outside Drive (a discarded upload, an admin delete) leaves a gone row.
CREATE OR REPLACE FUNCTION public.drive_forget_object()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.bucket_id IN ('message_media', 'user_media') THEN
        UPDATE public.drive_files f
           SET state = 'gone', gone_reason = 'deleted', expires_at = NULL, trashed_at = NULL,
               updated_at = now()
         WHERE f.bucket = OLD.bucket_id AND f.path = OLD.name AND f.state <> 'gone';
    END IF;
    RETURN NULL;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

DO $$
BEGIN
    IF to_regclass('storage.objects') IS NULL THEN
        RAISE NOTICE 'storage schema absent, drive tracking trigger skipped';
        RETURN;
    END IF;
    DROP TRIGGER IF EXISTS drive_track_object ON storage.objects;
    CREATE TRIGGER drive_track_object
        AFTER INSERT OR UPDATE ON storage.objects
        FOR EACH ROW EXECUTE FUNCTION public.drive_track_object();
    DROP TRIGGER IF EXISTS drive_forget_object ON storage.objects;
    CREATE TRIGGER drive_forget_object
        AFTER DELETE ON storage.objects
        FOR EACH ROW EXECUTE FUNCTION public.drive_forget_object();
END;
$$;

-- ---------------------------------------------------------------------------
-- Which messages name an object
-- ---------------------------------------------------------------------------

-- Expression index for "a live message names this object". It depends on
-- message_media_refs(jsonb, text[]); a new definition of that function needs a REINDEX.
CREATE INDEX IF NOT EXISTS idx_messages_media_refs
    ON public.messages USING gin (public.message_media_refs(content, media_paths))
    WHERE is_deleted IS NOT TRUE;

-- An explicit share of the file admits the profile.
CREATE OR REPLACE FUNCTION public.drive_file_shared_with(p_file uuid, p_profile uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
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

-- A live message in a room the profile views names the object.
CREATE OR REPLACE FUNCTION public.message_media_named_for(p_name text, p_profile uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.messages m
         WHERE public.message_media_refs(m.content, m.media_paths) @> ARRAY[p_name]
           AND m.is_deleted IS NOT TRUE
           AND CASE
                 WHEN m.channel_id IS NOT NULL THEN public.can_view_channel(p_profile, m.channel_id)
                 WHEN m.conversation_id IS NOT NULL THEN EXISTS (
                     SELECT 1 FROM public.conversation_participants cp
                      WHERE cp.conversation_id = m.conversation_id
                        AND cp.user_id = p_profile
                        AND cp.left_at IS NULL)
                 ELSE false
               END);
$$;

-- message_media read access for the caller, apart from the uploader-by-name and report rules
-- of the SELECT policy.
CREATE OR REPLACE FUNCTION public.message_media_readable(p_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.get_current_profile_id();
    v_file record;
BEGIN
    IF v_profile IS NULL THEN
        RETURN false;
    END IF;

    SELECT f.id, f.owner_id, f.state INTO v_file
      FROM public.drive_files f
     WHERE f.bucket = 'message_media' AND f.path = p_name;
    IF FOUND THEN
        IF v_file.owner_id = v_profile THEN
            RETURN true;
        END IF;
        IF v_file.state NOT IN ('drive', 'ephemeral') THEN
            RETURN false;
        END IF;
        IF public.drive_file_shared_with(v_file.id, v_profile) THEN
            RETURN true;
        END IF;
    END IF;

    RETURN public.message_media_named_for(p_name, v_profile);
END;
$$;

-- The author owns this message_media file in Drive and has not trashed or lost it.
CREATE OR REPLACE FUNCTION public.drive_file_owned_by(p_path text, p_profile uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT p_profile IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.drive_files f
         WHERE f.bucket = 'message_media'
           AND f.path = p_path
           AND f.owner_id = p_profile
           AND f.state IN ('drive', 'ephemeral'));
$$;

-- ---------------------------------------------------------------------------
-- Message path guard: own room, or the author's Drive files
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_message_media_paths()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_prefix text;
BEGIN
    v_prefix := CASE
        WHEN NEW.channel_id IS NOT NULL THEN 'c/' || NEW.channel_id::text || '/'
        WHEN NEW.conversation_id IS NOT NULL THEN 'd/' || NEW.conversation_id::text || '/'
    END;

    IF jsonb_typeof(NEW.content) = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.content) e
         WHERE jsonb_typeof(e) = 'object'
           AND e ->> 'type' = 'file'
           AND e ? 'path'
           AND (v_prefix IS NULL
                OR jsonb_typeof(e -> 'path') IS DISTINCT FROM 'string'
                OR e ->> 'path' ~ '(^|/)\.\.?(/|$)'
                OR (left(e ->> 'path', length(v_prefix)) <> v_prefix
                    AND NOT public.drive_file_owned_by(e ->> 'path', NEW.user_id)))
    ) THEN
        RAISE EXCEPTION 'An attachment names an object outside this conversation'
            USING ERRCODE = '42501';
    END IF;

    IF TG_OP = 'UPDATE'
       AND NEW.media_paths IS DISTINCT FROM OLD.media_paths
       AND current_user IN ('authenticated', 'anon')
       AND (OLD.is_deleted IS TRUE
            OR OLD.is_system IS TRUE
            OR OLD.user_id IS DISTINCT FROM public.get_current_profile_id()) THEN
        RAISE EXCEPTION 'only the author changes a live message''s media_paths'
            USING ERRCODE = '42501';
    END IF;

    IF NEW.media_paths IS NOT NULL THEN
        IF coalesce(array_ndims(NEW.media_paths), 1) <> 1 OR cardinality(NEW.media_paths) > 100 THEN
            RAISE EXCEPTION 'media_paths is a list of at most 100 object names'
                USING ERRCODE = '22023';
        END IF;
        IF EXISTS (
            SELECT 1 FROM unnest(NEW.media_paths) p
             WHERE p IS NULL
                OR v_prefix IS NULL
                OR p ~ '(^|/)\.\.?(/|$)'
                OR ((left(p, length(v_prefix)) <> v_prefix OR length(p) = length(v_prefix))
                    AND NOT public.drive_file_owned_by(p, NEW.user_id))
        ) THEN
            RAISE EXCEPTION 'An attachment names an object outside this conversation'
                USING ERRCODE = '42501';
        END IF;
        NEW.media_paths := ARRAY(SELECT DISTINCT p FROM unnest(NEW.media_paths) p ORDER BY p);
    END IF;
    RETURN NEW;
END;
$$;

-- Names a file in Drive from the first unencrypted message of its owner that attaches it.
CREATE OR REPLACE FUNCTION public.drive_name_from_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.encrypted IS TRUE OR NEW.user_id IS NULL OR jsonb_typeof(NEW.content) IS DISTINCT FROM 'array' THEN
        RETURN NULL;
    END IF;
    UPDATE public.drive_files f
       SET name = public.drive_clean_name(e.value ->> 'fileName'),
           updated_at = now()
      FROM jsonb_array_elements(NEW.content) e
     WHERE jsonb_typeof(e.value) = 'object'
       AND e.value ->> 'type' = 'file'
       AND jsonb_typeof(e.value -> 'path') = 'string'
       AND public.drive_clean_name(e.value ->> 'fileName') IS NOT NULL
       AND f.bucket = 'message_media'
       AND f.path = e.value ->> 'path'
       AND f.owner_id = NEW.user_id
       AND f.name IS NULL;
    RETURN NULL;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_messages_drive_name ON public.messages;
CREATE TRIGGER z_messages_drive_name
    AFTER INSERT OR UPDATE OF content ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.drive_name_from_message();

-- ---------------------------------------------------------------------------
-- Remote instance access
-- ---------------------------------------------------------------------------

-- The per-room rule of federation_media_access (20261006900001) for one room.
CREATE OR REPLACE FUNCTION public.federation_room_media_access(p_kind text, p_room uuid, p_domain text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_domain text := lower(btrim(p_domain));
    v_server uuid;
    v_local boolean;
    v_host text;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'federation_room_media_access is for service callers' USING ERRCODE = '42501';
    END IF;
    IF v_domain IS NULL OR v_domain = '' OR p_room IS NULL THEN
        RETURN false;
    END IF;

    IF p_kind = 'c' THEN
        SELECT s.id, s.is_local_server,
               lower(substring(COALESCE(s.federation_inbox_url, s.ap_id) FROM '^https?://([^/:?#]+)'))
          INTO v_server, v_local, v_host
          FROM public.channels c
          JOIN public.servers s ON s.id = c.server_id
         WHERE c.id = p_room;

        IF v_server IS NULL THEN
            RETURN false;
        END IF;
        IF v_local IS FALSE THEN
            RETURN COALESCE(v_domain <> '*' AND v_host = v_domain, false);
        END IF;
        IF v_domain = '*' THEN
            RETURN EXISTS (
                SELECT 1 FROM public.federation_group_access(v_server, NULL) g
                 WHERE g.is_public AND p_room = ANY (g.everyone_channel_ids)
            );
        END IF;
        RETURN EXISTS (
            SELECT 1 FROM public.federation_channel_recipients(p_room) r
             WHERE r.instance = v_domain
        );
    ELSIF p_kind = 'd' AND v_domain <> '*' THEN
        RETURN public.federation_conversation_access(p_room, v_domain);
    END IF;
    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.federation_media_access(p_name text, p_domain text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_kind text := split_part(p_name, '/', 1);
    v_room text := split_part(p_name, '/', 2);
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'federation_media_access is for service callers' USING ERRCODE = '42501';
    END IF;
    IF p_domain IS NULL OR btrim(p_domain) = '' THEN
        RETURN false;
    END IF;

    IF EXISTS (SELECT 1 FROM public.drive_files f
                WHERE f.bucket = 'message_media' AND f.path = p_name
                  AND f.state NOT IN ('drive', 'ephemeral')) THEN
        RETURN false;
    END IF;

    IF v_kind IN ('c', 'd')
       AND v_room ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       AND public.federation_room_media_access(v_kind, v_room::uuid, p_domain) THEN
        RETURN true;
    END IF;

    RETURN EXISTS (
        SELECT 1 FROM public.messages m
         WHERE public.message_media_refs(m.content, m.media_paths) @> ARRAY[p_name]
           AND m.is_deleted IS NOT TRUE
           AND public.federation_room_media_access(
                   CASE WHEN m.channel_id IS NOT NULL THEN 'c' ELSE 'd' END,
                   coalesce(m.channel_id, m.conversation_id),
                   p_domain));
END;
$$;

-- ---------------------------------------------------------------------------
-- Deletable objects
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.message_media_deletable(
    p_paths text[] DEFAULT NULL,
    p_min_age interval DEFAULT interval '24 hours',
    p_limit integer DEFAULT 500
)
RETURNS SETOF text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'message_media_deletable is for service callers' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    WITH candidates AS (
        SELECT o.name,
               o.created_at,
               split_part(o.name, '/', 1) AS kind,
               CASE WHEN split_part(o.name, '/', 2) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    THEN split_part(o.name, '/', 2)::uuid END AS room,
               split_part(o.name, '/', 3) AS uploader
          FROM storage.objects o
         WHERE o.bucket_id = 'message_media'
           AND (p_paths IS NULL OR o.name = ANY (p_paths))
           AND o.created_at < now() - coalesce(p_min_age, interval '0')
    ),
    room_messages AS (
        SELECT 'c'::text AS kind, m.channel_id AS room, m.content, m.media_paths, m.encrypted,
               m.user_id, coalesce(m.updated_at, m.created_at) AS written_at
          FROM public.messages m
         WHERE m.is_deleted IS NOT TRUE
           AND m.channel_id IN (SELECT c.room FROM candidates c WHERE c.kind = 'c' AND c.room IS NOT NULL)
        UNION ALL
        SELECT 'd'::text, m.conversation_id, m.content, m.media_paths, m.encrypted,
               m.user_id, coalesce(m.updated_at, m.created_at)
          FROM public.messages m
         WHERE m.is_deleted IS NOT TRUE
           AND m.conversation_id IN (SELECT c.room FROM candidates c WHERE c.kind = 'd' AND c.room IS NOT NULL)
    ),
    snapshots AS (
        SELECT r.content_snapshot -> 'message' AS msg
          FROM public.reports r
         WHERE r.content_snapshot -> 'message' IS NOT NULL
    ),
    referenced AS (
        SELECT unnest(public.message_media_refs(rm.content, rm.media_paths)) AS name FROM room_messages rm
        UNION
        SELECT unnest(public.message_media_refs(
                   s.msg -> 'content',
                   CASE WHEN jsonb_typeof(s.msg -> 'media_paths') = 'array'
                        THEN ARRAY(SELECT jsonb_array_elements_text(s.msg -> 'media_paths')) END))
          FROM snapshots s
    ),
    unlisted AS (
        SELECT rm.kind, rm.room, max(coalesce(rm.written_at, 'infinity'::timestamptz)) AS written_at
          FROM room_messages rm
          LEFT JOIN public.profiles p ON p.id = rm.user_id
         WHERE rm.encrypted IS TRUE
           AND rm.media_paths IS NULL
           AND p.is_local IS DISTINCT FROM false
         GROUP BY rm.kind, rm.room
        UNION ALL
        SELECT CASE WHEN s.msg ->> 'conversation_id' IS NOT NULL THEN 'd' ELSE 'c' END,
               coalesce(s.msg ->> 'conversation_id', s.msg ->> 'channel_id')::uuid,
               coalesce((s.msg ->> 'updated_at')::timestamptz, (s.msg ->> 'created_at')::timestamptz,
                        'infinity'::timestamptz)
          FROM snapshots s
          LEFT JOIN public.profiles p
                 ON p.id = CASE WHEN s.msg ->> 'user_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                THEN (s.msg ->> 'user_id')::uuid END
         WHERE s.msg ->> 'encrypted' = 'true'
           AND NOT (s.msg ? 'media_paths')
           AND coalesce(s.msg ->> 'conversation_id', s.msg ->> 'channel_id')
               ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           AND p.is_local IS DISTINCT FROM false
    ),
    exporting AS (
        SELECT p.id::text AS profile_id, p.auth_user_id::text AS auth_user_id
          FROM public.account_data_exports x
          JOIN public.profiles p ON p.id = x.profile_id
         WHERE x.expires_at > now()
    )
    SELECT c.name
      FROM candidates c
     WHERE NOT EXISTS (SELECT 1 FROM referenced r WHERE r.name = c.name)
       AND NOT EXISTS (SELECT 1 FROM unlisted u
                        WHERE u.kind = c.kind AND u.room = c.room AND u.written_at >= c.created_at)
       AND NOT EXISTS (SELECT 1 FROM exporting x WHERE c.uploader IN (x.profile_id, x.auth_user_id))
       AND NOT EXISTS (SELECT 1 FROM public.messages m
                        WHERE public.message_media_refs(m.content, m.media_paths) @> ARRAY[c.name]
                          AND m.is_deleted IS NOT TRUE)
       AND NOT EXISTS (SELECT 1 FROM public.drive_files f
                        WHERE f.bucket = 'message_media'
                          AND f.path = c.name
                          AND (f.state IN ('drive', 'trashed')
                               OR (f.state = 'ephemeral' AND c.kind = 'u' AND f.expires_at > now())))
     ORDER BY c.created_at
     LIMIT least(greatest(coalesce(p_limit, 500), 1), 1000);
END;
$$;

-- ---------------------------------------------------------------------------
-- Existing objects
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF to_regclass('storage.objects') IS NULL THEN
        RETURN;
    END IF;

    INSERT INTO public.drive_files (owner_id, bucket, path, mime_type, size_bytes, state, created_at, updated_at)
    SELECT o.owner_profile, o.bucket_id, o.name, o.metadata ->> 'mimetype',
           CASE WHEN o.metadata ->> 'size' ~ '^\d{1,18}$' THEN (o.metadata ->> 'size')::bigint ELSE 0 END,
           'drive', coalesce(o.created_at, now()), coalesce(o.updated_at, o.created_at, now())
      FROM (
        SELECT so.*, public.drive_object_owner(so.bucket_id, so.name, so.owner) AS owner_profile
          FROM storage.objects so
         WHERE so.bucket_id IN ('message_media', 'user_media')
      ) o
     WHERE o.owner_profile IS NOT NULL
    ON CONFLICT (bucket, path) DO NOTHING;
END;
$$;

-- Names from the unencrypted messages that attach them.
UPDATE public.drive_files f
   SET name = s.file_name
  FROM (
    SELECT DISTINCT ON (e ->> 'path') e ->> 'path' AS path, public.drive_clean_name(e ->> 'fileName') AS file_name
      FROM public.messages m
     CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m.content) = 'array' THEN m.content ELSE '[]'::jsonb END) e
     WHERE m.encrypted IS NOT TRUE
       AND jsonb_typeof(e) = 'object'
       AND e ->> 'type' = 'file'
       AND jsonb_typeof(e -> 'path') = 'string'
       AND public.drive_clean_name(e ->> 'fileName') IS NOT NULL
     ORDER BY e ->> 'path', m.created_at
  ) s
 WHERE f.bucket = 'message_media' AND f.path = s.path AND f.name IS NULL;

-- Legacy chat files and post media in user_media, named from the parts and attachments that
-- link them by public URL.
UPDATE public.drive_files f
   SET name = s.file_name
  FROM (
    SELECT DISTINCT ON (u.path) u.path, u.file_name
      FROM (
        SELECT substring(e ->> 'url' FROM '/storage/v1/object/public/user_media/([^?#]+)') AS path,
               public.drive_clean_name(e ->> 'fileName') AS file_name, m.created_at
          FROM public.messages m
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(m.content) = 'array' THEN m.content ELSE '[]'::jsonb END) e
         WHERE m.encrypted IS NOT TRUE
           AND jsonb_typeof(e) = 'object'
           AND e ->> 'type' = 'file'
        UNION ALL
        SELECT substring(a ->> 'url' FROM '/storage/v1/object/public/user_media/([^?#]+)'),
               public.drive_clean_name(a ->> 'name'), po.created_at
          FROM public.posts po
         CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(po.media_attachments) = 'array' THEN po.media_attachments ELSE '[]'::jsonb END) a
         WHERE jsonb_typeof(a) = 'object'
      ) u
     WHERE u.path IS NOT NULL AND u.file_name IS NOT NULL
     ORDER BY u.path, u.created_at
  ) s
 WHERE f.bucket = 'user_media' AND f.path = s.path AND f.name IS NULL;

-- ---------------------------------------------------------------------------
-- Storage policies
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF to_regclass('storage.objects') IS NULL THEN
        RAISE NOTICE 'storage schema absent, Drive storage policies skipped';
        RETURN;
    END IF;

    DROP POLICY IF EXISTS "Room members can read message media" ON storage.objects;
    CREATE POLICY "Room members can read message media" ON storage.objects
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
        );

    DROP POLICY IF EXISTS "Room members can upload message media" ON storage.objects;
    CREATE POLICY "Room members can upload message media" ON storage.objects
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
        );

    DROP POLICY IF EXISTS "Uploaders and admins can delete message media" ON storage.objects;
    CREATE POLICY "Uploaders and admins can delete message media" ON storage.objects
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
        );

    DROP POLICY IF EXISTS "Authenticated users can upload user_media" ON storage.objects;
    CREATE POLICY "Authenticated users can upload user_media" ON storage.objects
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
        );
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOREACH fn IN ARRAY ARRAY['public.drive_setting(text, numeric)'::regprocedure,
                              'public.drive_quota_bytes(uuid)'::regprocedure,
                              'public.drive_used_bytes(uuid)'::regprocedure,
                              'public.drive_ephemeral_recent_bytes(uuid)'::regprocedure,
                              'public.drive_object_owner(text, text, uuid)'::regprocedure,
                              'public.drive_track_object()'::regprocedure,
                              'public.drive_forget_object()'::regprocedure,
                              'public.drive_file_shared_with(uuid, uuid)'::regprocedure,
                              'public.message_media_named_for(text, uuid)'::regprocedure,
                              'public.drive_file_owned_by(text, uuid)'::regprocedure,
                              'public.guard_message_media_paths()'::regprocedure,
                              'public.drive_name_from_message()'::regprocedure,
                              'public.federation_room_media_access(text, uuid, text)'::regprocedure,
                              'public.federation_media_access(text, text)'::regprocedure,
                              'public.message_media_deletable(text[], interval, integer)'::regprocedure]
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

-- Called with the caller's role: from storage policies, from the message path guard
-- (SECURITY INVOKER), and from idx_messages_media_refs, whose expression is evaluated with the
-- inserting role's EXECUTE privilege.
GRANT EXECUTE ON FUNCTION public.drive_file_owned_by(text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.message_media_refs(jsonb, text[]) TO authenticated;
REVOKE ALL ON FUNCTION public.drive_can_upload() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.drive_can_upload() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.message_media_readable(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.message_media_readable(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.drive_clean_name(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.drive_clean_name(text) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
