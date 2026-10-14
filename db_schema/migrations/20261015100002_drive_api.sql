-- Drive operations. Every function acts for the caller's profile on its own rows unless
-- named admin_ (instance staff) or service-only (federation-backend).
--
-- Views of drive_list_files (p_view):
--   folder        drive and ephemeral files in p_folder (NULL: the root)
--   all, recent   every drive and ephemeral file
--   ephemeral     temporary files
--   trash         trashed files
--   server        files a live message in a channel of server p_context names
--   channel       files a live message in channel p_context names
--   conversation  files a live message in conversation p_context names
--   dms           files a live message in any conversation names
--   fediverse     post media (user_media)
--   shared        files of other accounts shared with the caller explicitly
-- p_kind filters by MIME family (image, video, audio, document, other); p_query matches the
-- name; p_sort is newest, oldest, name or size.
--
-- Shares: user (a local profile), server (accepted members and the owner), channel (who views
-- it), link (anyone holding the token, through federation-backend; refused while
-- drive_link_sharing is false). Shares of trashed or gone files admit nobody.
--
-- Trash: drive files only. Trashing an ephemeral file deletes it. Trash older than 30 days and
-- expired ephemeral files become gone through drive_expire_due(); drive_objects_to_delete()
-- lists the objects of gone files still in storage.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.drive_caller()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.get_current_profile_id();
BEGIN
    IF v_profile IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
    END IF;
    RETURN v_profile;
END;
$$;

CREATE OR REPLACE FUNCTION public.drive_mime_kind(p_mime text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT CASE
        WHEN p_mime LIKE 'image/%' THEN 'image'
        WHEN p_mime LIKE 'video/%' THEN 'video'
        WHEN p_mime LIKE 'audio/%' THEN 'audio'
        WHEN p_mime IN ('application/pdf', 'text/plain', 'text/markdown', 'text/csv', 'application/msword',
                        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                        'application/vnd.oasis.opendocument.text', 'application/rtf')
          THEN 'document'
        ELSE 'other'
    END;
$$;

CREATE OR REPLACE FUNCTION public.drive_link_sharing_enabled()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT coalesce((SELECT c.config_value #>> '{}' FROM public.instance_config c
                      WHERE c.config_key = 'drive_link_sharing'), 'true') NOT IN ('false', '0');
$$;

-- Display of a file row for clients.
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
        'created_at', f.created_at, 'updated_at', f.updated_at);
$$;

-- ---------------------------------------------------------------------------
-- Usage
-- ---------------------------------------------------------------------------

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

-- ---------------------------------------------------------------------------
-- Listing
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.drive_list_files(
    p_view text DEFAULT 'folder',
    p_folder uuid DEFAULT NULL,
    p_context uuid DEFAULT NULL,
    p_query text DEFAULT NULL,
    p_kind text DEFAULT NULL,
    p_sort text DEFAULT 'newest',
    p_limit integer DEFAULT 100,
    p_offset integer DEFAULT 0
)
RETURNS TABLE (file jsonb, owner jsonb, total_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
    v_query text := nullif(btrim(coalesce(p_query, '')), '');
    v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
    v_offset integer := greatest(coalesce(p_offset, 0), 0);
BEGIN
    IF p_view NOT IN ('folder', 'all', 'recent', 'ephemeral', 'trash', 'server', 'channel',
                      'conversation', 'dms', 'fediverse', 'shared') THEN
        RAISE EXCEPTION 'Unknown view %', p_view USING ERRCODE = '22023';
    END IF;
    IF p_kind IS NOT NULL AND p_kind NOT IN ('image', 'video', 'audio', 'document', 'other') THEN
        RAISE EXCEPTION 'Unknown kind %', p_kind USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH own_paths AS (
        SELECT f.path FROM public.drive_files f
         WHERE f.owner_id = v_profile AND f.bucket = 'message_media' AND f.state IN ('drive', 'ephemeral')
    ),
    named AS (
        -- Owner's message_media files named by live messages, with their room.
        SELECT DISTINCT r.path, m.channel_id, m.conversation_id
          FROM public.messages m
         CROSS JOIN LATERAL unnest(public.message_media_refs(m.content, m.media_paths)) r(path)
         WHERE p_view IN ('server', 'channel', 'conversation', 'dms')
           AND m.is_deleted IS NOT TRUE
           AND public.message_media_refs(m.content, m.media_paths) && ARRAY(SELECT op.path FROM own_paths op)
           AND r.path IN (SELECT op.path FROM own_paths op)
    ),
    picked AS (
        SELECT f.*
          FROM public.drive_files f
         WHERE CASE p_view
                 WHEN 'shared' THEN
                     f.owner_id <> v_profile
                     AND f.state IN ('drive', 'ephemeral')
                     AND EXISTS (SELECT 1 FROM public.drive_shares s
                                  WHERE s.file_id = f.id AND s.scope <> 'link')
                     AND public.drive_file_shared_with(f.id, v_profile)
                 ELSE f.owner_id = v_profile
               END
           AND CASE p_view
                 WHEN 'folder' THEN f.state IN ('drive', 'ephemeral') AND f.folder_id IS NOT DISTINCT FROM p_folder
                 WHEN 'all' THEN f.state IN ('drive', 'ephemeral')
                 WHEN 'recent' THEN f.state IN ('drive', 'ephemeral')
                 WHEN 'ephemeral' THEN f.state = 'ephemeral'
                 WHEN 'trash' THEN f.state = 'trashed'
                 WHEN 'server' THEN f.bucket = 'message_media' AND EXISTS (
                     SELECT 1 FROM named n JOIN public.channels c ON c.id = n.channel_id
                      WHERE n.path = f.path AND c.server_id = p_context)
                 WHEN 'channel' THEN f.bucket = 'message_media' AND EXISTS (
                     SELECT 1 FROM named n WHERE n.path = f.path AND n.channel_id = p_context)
                 WHEN 'conversation' THEN f.bucket = 'message_media' AND EXISTS (
                     SELECT 1 FROM named n WHERE n.path = f.path AND n.conversation_id = p_context)
                 WHEN 'dms' THEN f.bucket = 'message_media' AND EXISTS (
                     SELECT 1 FROM named n WHERE n.path = f.path AND n.conversation_id IS NOT NULL)
                 WHEN 'fediverse' THEN f.bucket = 'user_media' AND f.state IN ('drive', 'ephemeral')
                                      AND f.path ~ '(^|/)posts/'
                 WHEN 'shared' THEN true
               END
           AND (v_query IS NULL OR lower(f.name) LIKE '%' || lower(v_query) || '%')
           AND (p_kind IS NULL OR public.drive_mime_kind(f.mime_type) = p_kind)
    )
    SELECT public.drive_file_json(p),
           CASE WHEN p.owner_id <> v_profile THEN (
               SELECT jsonb_build_object('id', pr.id, 'username', pr.username, 'display_name', pr.display_name,
                                         'avatar_url', pr.avatar_url, 'domain', pr.domain)
                 FROM public.profiles pr WHERE pr.id = p.owner_id) END,
           count(*) OVER ()
      FROM picked p
     ORDER BY
        CASE WHEN p_sort = 'name' THEN lower(coalesce(p.name, p.path)) END ASC,
        CASE WHEN p_sort = 'size' THEN p.size_bytes END DESC,
        CASE WHEN p_sort = 'oldest' THEN p.created_at END ASC,
        CASE WHEN p_view = 'trash' THEN p.trashed_at END DESC,
        p.created_at DESC
     LIMIT v_limit OFFSET v_offset;
END;
$$;

CREATE OR REPLACE FUNCTION public.drive_list_folders()
RETURNS SETOF public.drive_folders
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT d.* FROM public.drive_folders d
     WHERE d.owner_id = public.drive_caller()
     ORDER BY lower(d.name);
$$;

-- Servers, channels and conversations whose live messages name the caller's files, for the
-- Drive sidebar.
CREATE OR REPLACE FUNCTION public.drive_context_tree()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
    v_paths text[];
    v_result jsonb;
BEGIN
    SELECT coalesce(array_agg(f.path), '{}') INTO v_paths
      FROM public.drive_files f
     WHERE f.owner_id = v_profile AND f.bucket = 'message_media' AND f.state IN ('drive', 'ephemeral');

    WITH named AS (
        SELECT DISTINCT r.path, m.channel_id, m.conversation_id
          FROM public.messages m
         CROSS JOIN LATERAL unnest(public.message_media_refs(m.content, m.media_paths)) r(path)
         WHERE m.is_deleted IS NOT TRUE
           AND public.message_media_refs(m.content, m.media_paths) && v_paths
           AND r.path = ANY (v_paths)
    ),
    channel_counts AS (
        SELECT c.server_id, c.id AS channel_id, c.name AS channel_name, count(DISTINCT n.path) AS files
          FROM named n JOIN public.channels c ON c.id = n.channel_id
         GROUP BY c.server_id, c.id, c.name
    ),
    servers_json AS (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
                   'id', s.id, 'name', s.name, 'icon', s.icon,
                   'files', (SELECT count(DISTINCT n.path) FROM named n JOIN public.channels c2 ON c2.id = n.channel_id
                              WHERE c2.server_id = s.id),
                   'channels', (SELECT jsonb_agg(jsonb_build_object('id', cc.channel_id, 'name', cc.channel_name,
                                                                    'files', cc.files) ORDER BY lower(cc.channel_name))
                                  FROM channel_counts cc WHERE cc.server_id = s.id))
                 ORDER BY lower(s.name)), '[]'::jsonb) AS j
          FROM public.servers s
         WHERE s.id IN (SELECT cc.server_id FROM channel_counts cc)
    ),
    conversations_json AS (
        SELECT coalesce(jsonb_agg(jsonb_build_object(
                   'id', cv.id, 'type', cv.type,
                   'name', coalesce(cv.name, (
                       SELECT string_agg(coalesce(p.display_name, p.username), ', ' ORDER BY p.username)
                         FROM public.conversation_participants cp JOIN public.profiles p ON p.id = cp.user_id
                        WHERE cp.conversation_id = cv.id AND cp.user_id <> v_profile)),
                   'files', (SELECT count(DISTINCT n.path) FROM named n WHERE n.conversation_id = cv.id))
                 ORDER BY cv.updated_at DESC NULLS LAST), '[]'::jsonb) AS j
          FROM public.conversations cv
         WHERE cv.id IN (SELECT n.conversation_id FROM named n WHERE n.conversation_id IS NOT NULL)
    )
    SELECT jsonb_build_object(
        'servers', (SELECT j FROM servers_json),
        'conversations', (SELECT j FROM conversations_json),
        'fediverse', (SELECT count(*) FROM public.drive_files f
                       WHERE f.owner_id = v_profile AND f.bucket = 'user_media'
                         AND f.state IN ('drive', 'ephemeral') AND f.path ~ '(^|/)posts/'),
        'shared', (SELECT count(*) FROM public.drive_files f
                    WHERE f.owner_id <> v_profile AND f.state IN ('drive', 'ephemeral')
                      AND EXISTS (SELECT 1 FROM public.drive_shares s WHERE s.file_id = f.id AND s.scope <> 'link')
                      AND public.drive_file_shared_with(f.id, v_profile)))
      INTO v_result;
    RETURN v_result;
END;
$$;

-- Where the caller's files are used: rooms of live messages and posts.
CREATE OR REPLACE FUNCTION public.drive_file_usage(p_file uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
    v_file public.drive_files;
BEGIN
    SELECT * INTO v_file FROM public.drive_files f WHERE f.id = p_file AND f.owner_id = v_profile;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'File not found' USING ERRCODE = 'P0002';
    END IF;

    RETURN jsonb_build_object(
        'messages', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                       'message_id', m.id, 'created_at', m.created_at,
                       'channel_id', m.channel_id, 'channel_name', c.name,
                       'server_id', s.id, 'server_name', s.name,
                       'conversation_id', m.conversation_id,
                       'conversation_name', CASE WHEN m.conversation_id IS NOT NULL THEN coalesce(cv.name, (
                           SELECT string_agg(coalesce(p.display_name, p.username), ', ' ORDER BY p.username)
                             FROM public.conversation_participants cp JOIN public.profiles p ON p.id = cp.user_id
                            WHERE cp.conversation_id = cv.id AND cp.user_id <> v_profile)) END,
                       'thread_id', m.thread_id)
                   ORDER BY m.created_at DESC)
              FROM public.messages m
              LEFT JOIN public.channels c ON c.id = m.channel_id
              LEFT JOIN public.servers s ON s.id = c.server_id
              LEFT JOIN public.conversations cv ON cv.id = m.conversation_id
             WHERE v_file.bucket = 'message_media'
               AND public.message_media_refs(m.content, m.media_paths) @> ARRAY[v_file.path]
               AND m.is_deleted IS NOT TRUE), '[]'::jsonb),
        'posts', coalesce((
            SELECT jsonb_agg(jsonb_build_object('post_id', po.id, 'created_at', po.created_at,
                                                'visibility', po.visibility) ORDER BY po.created_at DESC)
              FROM public.posts po
             WHERE v_file.bucket = 'user_media'
               AND po.author_id = v_profile
               AND po.is_deleted IS NOT TRUE
               AND EXISTS (SELECT 1 FROM jsonb_array_elements(
                                CASE WHEN jsonb_typeof(po.media_attachments) = 'array' THEN po.media_attachments ELSE '[]'::jsonb END) a
                            WHERE a ->> 'url' LIKE '%/user_media/' || v_file.path)), '[]'::jsonb),
        'shares', coalesce((
            SELECT jsonb_agg(jsonb_build_object(
                       'id', sh.id, 'scope', sh.scope, 'target_id', sh.target_id, 'token', sh.token,
                       'expires_at', sh.expires_at, 'created_at', sh.created_at,
                       'target_name', CASE sh.scope
                           WHEN 'user' THEN (SELECT coalesce(p.display_name, p.username) FROM public.profiles p WHERE p.id = sh.target_id)
                           WHEN 'server' THEN (SELECT sv.name FROM public.servers sv WHERE sv.id = sh.target_id)
                           WHEN 'channel' THEN (SELECT ch.name FROM public.channels ch WHERE ch.id = sh.target_id)
                       END)
                   ORDER BY sh.created_at)
              FROM public.drive_shares sh WHERE sh.file_id = v_file.id), '[]'::jsonb));
END;
$$;

-- The caller's drive and ephemeral files with this SHA-256, newest first.
CREATE OR REPLACE FUNCTION public.drive_find_by_hash(p_sha256 text)
RETURNS SETOF jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.drive_file_json(f)
      FROM public.drive_files f
     WHERE f.owner_id = public.drive_caller()
       AND f.sha256 = lower(p_sha256)
       AND f.state IN ('drive', 'ephemeral')
     ORDER BY (f.state = 'drive') DESC, f.created_at DESC
     LIMIT 5;
$$;

-- Whether instance staff blocked these bytes: an upload refused by the storage policy says
-- why. storage-api reports every refusal of its pre-upload check as a row-level security
-- violation, the trigger's own message included.
CREATE OR REPLACE FUNCTION public.drive_hash_blocked(p_sha256 text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.drive_caller() IS NOT NULL
       AND EXISTS (SELECT 1 FROM public.drive_blocked_hashes b WHERE b.sha256 = lower(p_sha256));
$$;

-- State of message_media objects the caller can see named in a message, for "File expired" /
-- "File removed" placeholders. Paths the caller cannot see are omitted.
CREATE OR REPLACE FUNCTION public.drive_file_status(p_paths text[])
RETURNS TABLE (path text, state text, gone_reason text, expires_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT f.path, f.state, f.gone_reason, f.expires_at
      FROM public.drive_files f
     WHERE f.bucket = 'message_media'
       AND f.path = ANY (p_paths[1:200])
       AND (f.owner_id = public.get_current_profile_id()
            OR EXISTS (
                SELECT 1 FROM public.messages m
                 WHERE public.message_media_refs(m.content, m.media_paths) @> ARRAY[f.path]
                   AND m.is_deleted IS NOT TRUE
                   AND CASE
                         WHEN m.channel_id IS NOT NULL
                           THEN public.can_view_channel(public.get_current_profile_id(), m.channel_id)
                         WHEN m.conversation_id IS NOT NULL THEN EXISTS (
                             SELECT 1 FROM public.conversation_participants cp
                              WHERE cp.conversation_id = m.conversation_id
                                AND cp.user_id = public.get_current_profile_id()
                                AND cp.left_at IS NULL)
                         ELSE false
                       END));
$$;

-- ---------------------------------------------------------------------------
-- Folders
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.drive_create_folder(p_name text, p_parent uuid DEFAULT NULL)
RETURNS public.drive_folders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
    v_row public.drive_folders;
BEGIN
    IF p_parent IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.drive_folders d WHERE d.id = p_parent AND d.owner_id = v_profile) THEN
        RAISE EXCEPTION 'Folder not found' USING ERRCODE = 'P0002';
    END IF;
    IF (SELECT count(*) FROM public.drive_folders d WHERE d.owner_id = v_profile) >= 1000 THEN
        RAISE EXCEPTION 'At most 1000 folders' USING ERRCODE = '54000';
    END IF;
    INSERT INTO public.drive_folders (owner_id, parent_id, name)
    VALUES (v_profile, p_parent, btrim(p_name))
    RETURNING * INTO v_row;
    RETURN v_row;
EXCEPTION
    WHEN unique_violation THEN
        RAISE EXCEPTION 'A folder with that name exists here' USING ERRCODE = '23505';
    WHEN check_violation THEN
        RAISE EXCEPTION 'Folder names are 1 to 120 characters without slashes' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.drive_rename_folder(p_folder uuid, p_name text)
RETURNS public.drive_folders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
    v_row public.drive_folders;
BEGIN
    UPDATE public.drive_folders d SET name = btrim(p_name), updated_at = now()
     WHERE d.id = p_folder AND d.owner_id = v_profile
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Folder not found' USING ERRCODE = 'P0002';
    END IF;
    RETURN v_row;
EXCEPTION
    WHEN unique_violation THEN
        RAISE EXCEPTION 'A folder with that name exists here' USING ERRCODE = '23505';
    WHEN check_violation THEN
        RAISE EXCEPTION 'Folder names are 1 to 120 characters without slashes' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.drive_move_folder(p_folder uuid, p_parent uuid)
RETURNS public.drive_folders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
    v_row public.drive_folders;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.drive_folders d WHERE d.id = p_folder AND d.owner_id = v_profile) THEN
        RAISE EXCEPTION 'Folder not found' USING ERRCODE = 'P0002';
    END IF;
    IF p_parent IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.drive_folders d WHERE d.id = p_parent AND d.owner_id = v_profile) THEN
            RAISE EXCEPTION 'Folder not found' USING ERRCODE = 'P0002';
        END IF;
        -- The new parent must not be the folder or one of its descendants.
        IF EXISTS (
            WITH RECURSIVE up(id, parent_id) AS (
                SELECT d.id, d.parent_id FROM public.drive_folders d WHERE d.id = p_parent
                UNION ALL
                SELECT d.id, d.parent_id FROM public.drive_folders d JOIN up ON d.id = up.parent_id
            )
            SELECT 1 FROM up WHERE up.id = p_folder
        ) THEN
            RAISE EXCEPTION 'A folder cannot move into itself' USING ERRCODE = '22023';
        END IF;
    END IF;
    UPDATE public.drive_folders d SET parent_id = p_parent, updated_at = now()
     WHERE d.id = p_folder
    RETURNING * INTO v_row;
    RETURN v_row;
EXCEPTION
    WHEN unique_violation THEN
        RAISE EXCEPTION 'A folder with that name exists there' USING ERRCODE = '23505';
END;
$$;

-- Trashes the files of the folder and its descendants, then deletes the folders. Returns the
-- number of files trashed.
CREATE OR REPLACE FUNCTION public.drive_delete_folder(p_folder uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
    v_ids uuid[];
    v_trashed integer;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.drive_folders d WHERE d.id = p_folder AND d.owner_id = v_profile) THEN
        RAISE EXCEPTION 'Folder not found' USING ERRCODE = 'P0002';
    END IF;

    WITH RECURSIVE tree(id) AS (
        SELECT p_folder
        UNION ALL
        SELECT d.id FROM public.drive_folders d JOIN tree t ON d.parent_id = t.id
    )
    SELECT array_agg(f.id) INTO v_ids
      FROM public.drive_files f
     WHERE f.folder_id IN (SELECT id FROM tree) AND f.owner_id = v_profile
       AND f.state IN ('drive', 'ephemeral');

    v_trashed := public.drive_trash_files(coalesce(v_ids, '{}'));
    DELETE FROM public.drive_folders d WHERE d.id = p_folder AND d.owner_id = v_profile;
    RETURN v_trashed;
END;
$$;

-- ---------------------------------------------------------------------------
-- Files
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.drive_rename_file(p_file uuid, p_name text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
    v_row public.drive_files;
    v_name text := public.drive_clean_name(p_name);
BEGIN
    IF v_name IS NULL THEN
        RAISE EXCEPTION 'A file needs a name' USING ERRCODE = '22023';
    END IF;
    UPDATE public.drive_files f SET name = v_name, updated_at = now()
     WHERE f.id = p_file AND f.owner_id = v_profile AND f.state <> 'gone'
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'File not found' USING ERRCODE = 'P0002';
    END IF;
    RETURN public.drive_file_json(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION public.drive_move_files(p_files uuid[], p_folder uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
    v_count integer;
BEGIN
    IF p_folder IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.drive_folders d WHERE d.id = p_folder AND d.owner_id = v_profile) THEN
        RAISE EXCEPTION 'Folder not found' USING ERRCODE = 'P0002';
    END IF;
    UPDATE public.drive_files f SET folder_id = p_folder, updated_at = now()
     WHERE f.id = ANY (p_files) AND f.owner_id = v_profile AND f.state IN ('drive', 'ephemeral');
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- Drive files go to the trash; ephemeral files are deleted. Returns the number of files.
CREATE OR REPLACE FUNCTION public.drive_trash_files(p_files uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
    v_trashed integer;
    v_deleted integer;
BEGIN
    UPDATE public.drive_files f SET state = 'trashed', trashed_at = now(), updated_at = now()
     WHERE f.id = ANY (p_files) AND f.owner_id = v_profile AND f.state = 'drive';
    GET DIAGNOSTICS v_trashed = ROW_COUNT;

    UPDATE public.drive_files f
       SET state = 'gone', gone_reason = 'deleted', expires_at = NULL, updated_at = now()
     WHERE f.id = ANY (p_files) AND f.owner_id = v_profile AND f.state = 'ephemeral';
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    IF v_deleted > 0 THEN
        PERFORM public.queue_federation_job('drive-purge', jsonb_build_object('type', 'purge'));
    END IF;
    RETURN v_trashed + v_deleted;
END;
$$;

CREATE OR REPLACE FUNCTION public.drive_restore_files(p_files uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
    v_count integer;
BEGIN
    UPDATE public.drive_files f SET state = 'drive', trashed_at = NULL, updated_at = now()
     WHERE f.id = ANY (p_files) AND f.owner_id = v_profile AND f.state = 'trashed';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- Deletes files now, wherever they are used. Messages naming them show the file as removed.
CREATE OR REPLACE FUNCTION public.drive_delete_files(p_files uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
    v_count integer;
BEGIN
    UPDATE public.drive_files f
       SET state = 'gone', gone_reason = 'deleted', expires_at = NULL, trashed_at = NULL,
           updated_at = now()
     WHERE f.id = ANY (p_files) AND f.owner_id = v_profile AND f.state <> 'gone';
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count > 0 THEN
        PERFORM public.queue_federation_job('drive-purge', jsonb_build_object('type', 'purge'));
    END IF;
    RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.drive_empty_trash()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
BEGIN
    RETURN public.drive_delete_files(ARRAY(
        SELECT f.id FROM public.drive_files f
         WHERE f.owner_id = v_profile AND f.state = 'trashed'));
END;
$$;

-- Moves ephemeral files into Drive while they fit the quota, oldest expiry first. Returns the
-- number kept.
CREATE OR REPLACE FUNCTION public.drive_keep_files(p_files uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
    v_quota bigint := public.drive_quota_bytes(v_profile);
    v_file record;
    v_kept integer := 0;
BEGIN
    FOR v_file IN
        SELECT f.id, f.size_bytes FROM public.drive_files f
         WHERE f.id = ANY (p_files) AND f.owner_id = v_profile AND f.state = 'ephemeral'
         ORDER BY f.expires_at
    LOOP
        EXIT WHEN public.drive_used_bytes(v_profile) + v_file.size_bytes > v_quota;
        UPDATE public.drive_files SET state = 'drive', expires_at = NULL, updated_at = now()
         WHERE id = v_file.id;
        v_kept := v_kept + 1;
    END LOOP;
    RETURN v_kept;
END;
$$;

-- Marks the caller's message_media files temporary (p_temporary) or keeps them in Drive while
-- they fit, by object name, for the composer. Returns the number changed.
CREATE OR REPLACE FUNCTION public.drive_set_temporary(p_paths text[], p_temporary boolean)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
    v_count integer;
BEGIN
    IF p_temporary THEN
        UPDATE public.drive_files f
           SET state = 'ephemeral',
               expires_at = now() + make_interval(days => public.drive_setting('drive_ephemeral_days', 30)::int),
               updated_at = now()
         WHERE f.owner_id = v_profile AND f.bucket = 'message_media'
           AND f.path = ANY (p_paths[1:100]) AND f.state = 'drive';
        GET DIAGNOSTICS v_count = ROW_COUNT;
        RETURN v_count;
    END IF;
    RETURN public.drive_keep_files(ARRAY(
        SELECT f.id FROM public.drive_files f
         WHERE f.owner_id = v_profile AND f.bucket = 'message_media'
           AND f.path = ANY (p_paths[1:100]) AND f.state = 'ephemeral'));
END;
$$;

-- ---------------------------------------------------------------------------
-- Shares and links
-- ---------------------------------------------------------------------------

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

CREATE OR REPLACE FUNCTION public.drive_unshare(p_share uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
BEGIN
    DELETE FROM public.drive_shares s
     USING public.drive_files f
     WHERE s.id = p_share AND f.id = s.file_id AND f.owner_id = v_profile;
    RETURN FOUND;
END;
$$;

-- One link per file; a new call replaces the token and expiry.
CREATE OR REPLACE FUNCTION public.drive_link_create(p_file uuid, p_expires_at timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
    v_share public.drive_shares;
BEGIN
    IF NOT public.drive_link_sharing_enabled() THEN
        RAISE EXCEPTION 'Link sharing is turned off on this instance' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.drive_files f
                    WHERE f.id = p_file AND f.owner_id = v_profile AND f.state IN ('drive', 'ephemeral')) THEN
        RAISE EXCEPTION 'File not found' USING ERRCODE = 'P0002';
    END IF;
    IF p_expires_at IS NOT NULL AND p_expires_at <= now() THEN
        RAISE EXCEPTION 'The expiry is in the past' USING ERRCODE = '22023';
    END IF;

    DELETE FROM public.drive_shares s WHERE s.file_id = p_file AND s.scope = 'link';
    INSERT INTO public.drive_shares (file_id, scope, token, expires_at)
    VALUES (p_file, 'link',
            translate(encode(extensions.gen_random_bytes(18), 'base64'), '+/', '-_'),
            p_expires_at)
    RETURNING * INTO v_share;
    RETURN to_jsonb(v_share);
END;
$$;

-- What a link page shows. Anyone holding the token.
CREATE OR REPLACE FUNCTION public.drive_link_resolve(p_token text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'name', coalesce(f.name, 'file'), 'mime_type', f.mime_type, 'kind', public.drive_mime_kind(f.mime_type),
        'size_bytes', f.size_bytes, 'created_at', f.created_at, 'expires_at', s.expires_at,
        'owner', jsonb_build_object('username', p.username, 'display_name', p.display_name,
                                    'avatar_url', p.avatar_url, 'domain', p.domain))
      FROM public.drive_shares s
      JOIN public.drive_files f ON f.id = s.file_id
      JOIN public.profiles p ON p.id = f.owner_id
     WHERE s.scope = 'link'
       AND s.token = p_token
       AND (s.expires_at IS NULL OR s.expires_at > now())
       AND f.state IN ('drive', 'ephemeral')
       AND public.drive_link_sharing_enabled();
$$;

-- Object behind a link, for the federation-backend link route. Service callers only.
CREATE OR REPLACE FUNCTION public.drive_link_target(p_token text)
RETURNS TABLE (bucket text, path text, name text, mime_type text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'drive_link_target is for service callers' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT f.bucket, f.path, f.name, f.mime_type
      FROM public.drive_shares s
      JOIN public.drive_files f ON f.id = s.file_id
     WHERE s.scope = 'link'
       AND s.token = p_token
       AND (s.expires_at IS NULL OR s.expires_at > now())
       AND f.state IN ('drive', 'ephemeral')
       AND public.drive_link_sharing_enabled();
END;
$$;

-- ---------------------------------------------------------------------------
-- Instance staff
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_drive_usage(p_limit integer DEFAULT 50, p_profile uuid DEFAULT NULL)
RETURNS TABLE (profile_id uuid, username text, display_name text, used_bytes bigint, quota_bytes bigint,
               ephemeral_bytes bigint, file_count bigint, quota_override bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT p.id, p.username, p.display_name,
           public.drive_used_bytes(p.id), public.drive_quota_bytes(p.id),
           coalesce((SELECT sum(f.size_bytes) FROM public.drive_files f
                      WHERE f.owner_id = p.id AND f.state = 'ephemeral'), 0)::bigint,
           (SELECT count(*) FROM public.drive_files f WHERE f.owner_id = p.id AND f.state IN ('drive', 'ephemeral')),
           (SELECT o.quota_bytes FROM public.drive_quota_overrides o WHERE o.profile_id = p.id)
      FROM public.profiles p
     WHERE (p_profile IS NULL AND EXISTS (SELECT 1 FROM public.drive_files f WHERE f.owner_id = p.id))
        OR p.id = p_profile
     ORDER BY 4 DESC
     LIMIT least(greatest(coalesce(p_limit, 50), 1), 500);
END;
$$;

-- NULL clears the override.
CREATE OR REPLACE FUNCTION public.admin_set_drive_quota(p_profile uuid, p_quota_bytes bigint)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    IF p_quota_bytes IS NULL THEN
        DELETE FROM public.drive_quota_overrides WHERE profile_id = p_profile;
    ELSE
        IF p_quota_bytes < 0 THEN
            RAISE EXCEPTION 'A quota is not negative' USING ERRCODE = '22023';
        END IF;
        INSERT INTO public.drive_quota_overrides (profile_id, quota_bytes, set_by, updated_at)
        VALUES (p_profile, p_quota_bytes, public.get_current_profile_id(), now())
        ON CONFLICT (profile_id) DO UPDATE
           SET quota_bytes = EXCLUDED.quota_bytes, set_by = EXCLUDED.set_by, updated_at = now();
    END IF;
    PERFORM public.log_admin_action(public.get_current_profile_id(), 'drive_quota', 'profile', p_profile::text,
                                    jsonb_build_object('quota_bytes', p_quota_bytes));
    RETURN public.drive_quota_bytes(p_profile);
END;
$$;

-- Blocks a server-computed SHA-256: later uploads claiming it are refused, and verified copies
-- of the same bytes are gone.
CREATE OR REPLACE FUNCTION public.drive_block_hash(p_sha256 text, p_reason text, p_by uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    INSERT INTO public.drive_blocked_hashes (sha256, reason, created_by)
    VALUES (p_sha256, nullif(btrim(coalesce(p_reason, '')), ''),
            (SELECT p.id FROM public.profiles p WHERE p.id = p_by))
    ON CONFLICT (sha256) DO NOTHING;
    UPDATE public.drive_files f
       SET state = 'gone', gone_reason = 'removed', expires_at = NULL, trashed_at = NULL, updated_at = now()
     WHERE f.sha256 = p_sha256 AND f.sha256_verified AND f.state <> 'gone';
END;
$$;

-- Removes a file for every viewer; with p_block, re-uploads of the same bytes are refused.
-- Takes a file id or a bucket and path (as a report shows it). Only a server-computed hash is
-- blocked: an unverified sha256 is the uploader's claim, and blocking it would let an uploader
-- name another file's bytes. Such a file keeps its object until the hash job computes the real
-- hash, which drive_record_hash then blocks.
CREATE OR REPLACE FUNCTION public.admin_drive_remove_file(
    p_file uuid,
    p_block boolean DEFAULT false,
    p_reason text DEFAULT NULL,
    p_bucket text DEFAULT NULL,
    p_path text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_file public.drive_files;
    v_pending boolean;
BEGIN
    IF NOT public.is_current_user_admin_or_mod() THEN
        RAISE EXCEPTION 'Instance staff only' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_file FROM public.drive_files f
     WHERE (p_file IS NOT NULL AND f.id = p_file)
        OR (p_file IS NULL AND f.bucket = p_bucket AND f.path = p_path);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'File not found' USING ERRCODE = 'P0002';
    END IF;

    v_pending := p_block AND NOT v_file.sha256_verified;
    UPDATE public.drive_files f
       SET state = 'gone', gone_reason = 'removed', expires_at = NULL, trashed_at = NULL, updated_at = now()
     WHERE f.id = v_file.id;
    IF v_pending THEN
        INSERT INTO public.drive_pending_blocks (file_id, reason, created_by)
        VALUES (v_file.id, nullif(btrim(coalesce(p_reason, '')), ''), public.get_current_profile_id())
        ON CONFLICT (file_id) DO NOTHING;
    END IF;

    IF p_block AND v_file.sha256_verified THEN
        PERFORM public.drive_block_hash(v_file.sha256, p_reason, public.get_current_profile_id());
    END IF;

    IF v_pending THEN
        PERFORM public.queue_federation_job('drive-hash',
            jsonb_build_object('type', 'hash', 'bucket', v_file.bucket, 'path', v_file.path));
    END IF;
    PERFORM public.queue_federation_job('drive-purge', jsonb_build_object('type', 'purge'));
    PERFORM public.log_admin_action(public.get_current_profile_id(), 'drive_remove_file', 'drive_file', v_file.id::text,
                                    jsonb_build_object('block', p_block, 'reason', p_reason,
                                                       'owner_id', v_file.owner_id, 'path', v_file.path));
    RETURN jsonb_build_object('id', v_file.id, 'blocked', p_block AND v_file.sha256_verified, 'pending', v_pending);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_drive_unblock_hash(p_sha256 text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.is_current_user_admin_or_mod() THEN
        RAISE EXCEPTION 'Instance staff only' USING ERRCODE = '42501';
    END IF;
    DELETE FROM public.drive_blocked_hashes WHERE sha256 = lower(p_sha256);
    RETURN FOUND;
END;
$$;

-- ---------------------------------------------------------------------------
-- Service (federation-backend)
-- ---------------------------------------------------------------------------

-- Expired ephemeral files and trash older than 30 days become gone. Returns how many.
CREATE OR REPLACE FUNCTION public.drive_expire_due()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_expired integer;
    v_trash integer;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'drive_expire_due is for service callers' USING ERRCODE = '42501';
    END IF;
    UPDATE public.drive_files f
       SET state = 'gone', gone_reason = 'expired', updated_at = now()
     WHERE f.state = 'ephemeral' AND f.expires_at <= now();
    GET DIAGNOSTICS v_expired = ROW_COUNT;

    UPDATE public.drive_files f
       SET state = 'gone', gone_reason = 'deleted', trashed_at = NULL, updated_at = now()
     WHERE f.state = 'trashed' AND f.trashed_at <= now() - interval '30 days';
    GET DIAGNOSTICS v_trash = ROW_COUNT;
    RETURN v_expired + v_trash;
END;
$$;

-- Objects of gone files that storage still holds.
CREATE OR REPLACE FUNCTION public.drive_objects_to_delete(p_limit integer DEFAULT 200)
RETURNS TABLE (bucket text, path text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'drive_objects_to_delete is for service callers' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT f.bucket, f.path
      FROM public.drive_files f
     WHERE f.state = 'gone'
       AND NOT EXISTS (SELECT 1 FROM public.drive_pending_blocks pb WHERE pb.file_id = f.id)
       AND EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = f.bucket AND o.name = f.path)
     ORDER BY f.updated_at
     LIMIT least(greatest(coalesce(p_limit, 200), 1), 1000);
END;
$$;

-- Files whose SHA-256 the server has not computed yet, and removed files awaiting a block on it.
CREATE OR REPLACE FUNCTION public.drive_hash_pending(p_limit integer DEFAULT 50)
RETURNS TABLE (id uuid, bucket text, path text, size_bytes bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'drive_hash_pending is for service callers' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    SELECT q.id, q.bucket, q.path, q.size_bytes
      FROM (
        SELECT f.id, f.bucket, f.path, f.size_bytes, f.created_at
          FROM public.drive_files f
         WHERE NOT f.sha256_verified AND f.state IN ('drive', 'ephemeral', 'trashed')
        UNION ALL
        SELECT f.id, f.bucket, f.path, f.size_bytes, f.created_at
          FROM public.drive_pending_blocks pb
          JOIN public.drive_files f ON f.id = pb.file_id
         WHERE EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = f.bucket AND o.name = f.path)
      ) q
     ORDER BY q.created_at
     LIMIT least(greatest(coalesce(p_limit, 50), 1), 500);
END;
$$;

-- Records the server-computed SHA-256 of a file. Returns 'blocked' when the hash is blocked or
-- staff asked for a block while it was unverified (the file is now gone and its object is to
-- be deleted), else 'ok'.
CREATE OR REPLACE FUNCTION public.drive_record_hash(p_bucket text, p_path text, p_sha256 text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_sha text := lower(p_sha256);
    v_pending public.drive_pending_blocks;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'drive_record_hash is for service callers' USING ERRCODE = '42501';
    END IF;
    IF v_sha !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'Not a SHA-256' USING ERRCODE = '22023';
    END IF;

    DELETE FROM public.drive_pending_blocks pb
     USING public.drive_files f
     WHERE pb.file_id = f.id AND f.bucket = p_bucket AND f.path = p_path
    RETURNING pb.* INTO v_pending;
    IF v_pending.file_id IS NOT NULL THEN
        UPDATE public.drive_files f
           SET sha256 = v_sha, sha256_verified = true, updated_at = now()
         WHERE f.id = v_pending.file_id;
        PERFORM public.drive_block_hash(v_sha, v_pending.reason, v_pending.created_by);
        RETURN 'blocked';
    END IF;

    IF EXISTS (SELECT 1 FROM public.drive_blocked_hashes b WHERE b.sha256 = v_sha) THEN
        UPDATE public.drive_files f
           SET sha256 = v_sha, sha256_verified = true, state = 'gone', gone_reason = 'removed',
               expires_at = NULL, trashed_at = NULL, updated_at = now()
         WHERE f.bucket = p_bucket AND f.path = p_path;
        RETURN 'blocked';
    END IF;

    UPDATE public.drive_files f
       SET sha256 = v_sha, sha256_verified = true, updated_at = now()
     WHERE f.bucket = p_bucket AND f.path = p_path;
    RETURN 'ok';
END;
$$;

-- Gone rows older than 90 days that no live message names: nothing shows their reason.
CREATE OR REPLACE FUNCTION public.drive_prune_gone(p_limit integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count integer;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'drive_prune_gone is for service callers' USING ERRCODE = '42501';
    END IF;
    DELETE FROM public.drive_files f
     WHERE f.id IN (
        SELECT g.id FROM public.drive_files g
         WHERE g.state = 'gone'
           AND g.updated_at < now() - interval '90 days'
           AND NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = g.bucket AND o.name = g.path)
           AND NOT EXISTS (SELECT 1 FROM public.messages m
                            WHERE public.message_media_refs(m.content, m.media_paths) @> ARRAY[g.path]
                              AND m.is_deleted IS NOT TRUE)
         LIMIT least(greatest(coalesce(p_limit, 500), 1), 5000));
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
END;
$$;

-- Objects of local accounts without a drive_files row (tracking failed), tracked now.
CREATE OR REPLACE FUNCTION public.drive_track_missing(p_limit integer DEFAULT 500)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count integer;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'drive_track_missing is for service callers' USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.drive_files (owner_id, bucket, path, mime_type, size_bytes, state, created_at, updated_at)
    SELECT o.owner_profile, o.bucket_id, o.name, o.metadata ->> 'mimetype',
           CASE WHEN o.metadata ->> 'size' ~ '^\d{1,18}$' THEN (o.metadata ->> 'size')::bigint ELSE 0 END,
           'drive', coalesce(o.created_at, now()), now()
      FROM (
        SELECT so.*, public.drive_object_owner(so.bucket_id, so.name, so.owner) AS owner_profile
          FROM storage.objects so
         WHERE so.bucket_id IN ('message_media', 'user_media')
           AND so.created_at < now() - interval '10 minutes'
           AND NOT EXISTS (SELECT 1 FROM public.drive_files f WHERE f.bucket = so.bucket_id AND f.path = so.name)
         LIMIT least(greatest(coalesce(p_limit, 500), 1), 5000)
      ) o
     WHERE o.owner_profile IS NOT NULL
    ON CONFLICT (bucket, path) DO NOTHING;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    RETURN v_count;
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
    FOREACH fn IN ARRAY ARRAY[
        'public.drive_caller()'::regprocedure,
        'public.get_my_drive_usage()'::regprocedure,
        'public.drive_list_files(text, uuid, uuid, text, text, text, integer, integer)'::regprocedure,
        'public.drive_list_folders()'::regprocedure,
        'public.drive_context_tree()'::regprocedure,
        'public.drive_file_usage(uuid)'::regprocedure,
        'public.drive_find_by_hash(text)'::regprocedure,
        'public.drive_hash_blocked(text)'::regprocedure,
        'public.drive_file_status(text[])'::regprocedure,
        'public.drive_create_folder(text, uuid)'::regprocedure,
        'public.drive_rename_folder(uuid, text)'::regprocedure,
        'public.drive_move_folder(uuid, uuid)'::regprocedure,
        'public.drive_delete_folder(uuid)'::regprocedure,
        'public.drive_rename_file(uuid, text)'::regprocedure,
        'public.drive_move_files(uuid[], uuid)'::regprocedure,
        'public.drive_trash_files(uuid[])'::regprocedure,
        'public.drive_restore_files(uuid[])'::regprocedure,
        'public.drive_delete_files(uuid[])'::regprocedure,
        'public.drive_empty_trash()'::regprocedure,
        'public.drive_keep_files(uuid[])'::regprocedure,
        'public.drive_set_temporary(text[], boolean)'::regprocedure,
        'public.drive_share_file(uuid, text, uuid, timestamptz)'::regprocedure,
        'public.drive_unshare(uuid)'::regprocedure,
        'public.drive_link_create(uuid, timestamptz)'::regprocedure,
        'public.admin_drive_usage(integer, uuid)'::regprocedure,
        'public.admin_set_drive_quota(uuid, bigint)'::regprocedure,
        'public.admin_drive_remove_file(uuid, boolean, text, text, text)'::regprocedure,
        'public.admin_drive_unblock_hash(text)'::regprocedure]
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', fn);
    END LOOP;

    FOREACH fn IN ARRAY ARRAY[
        'public.drive_link_target(text)'::regprocedure,
        'public.drive_expire_due()'::regprocedure,
        'public.drive_objects_to_delete(integer)'::regprocedure,
        'public.drive_hash_pending(integer)'::regprocedure,
        'public.drive_record_hash(text, text, text)'::regprocedure,
        'public.drive_block_hash(text, text, uuid)'::regprocedure,
        'public.drive_track_missing(integer)'::regprocedure,
        'public.drive_prune_gone(integer)'::regprocedure,
        'public.drive_file_json(public.drive_files)'::regprocedure,
        'public.drive_link_sharing_enabled()'::regprocedure]
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

REVOKE ALL ON FUNCTION public.drive_mime_kind(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.drive_mime_kind(text) TO anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.drive_link_resolve(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.drive_link_resolve(text) TO anon, authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
