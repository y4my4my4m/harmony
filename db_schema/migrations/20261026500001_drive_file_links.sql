-- Drive file links: the in-app address /drive/file/<file id>, chat cards for it and for
-- /d/<token>, and the composer's offer to share a pasted file with the room.
--
-- drive_file_readable(file, profile) is message_media_readable (20261015100001) keyed by file
-- id: the owner, in any state; anyone else only while the file is drive or ephemeral, through
-- an explicit share (drive_file_shared_with) or a live message in a room they view naming the
-- object (message_media_named_for). user_media (post media) objects are public: they admit
-- anyone while a live public or unlisted post of the owner attaches them. The storage read
-- policy of message_media admits the same readers, so a card that answers access signs.
--
-- drive_file_card(p_file, p_token) is what a card or the file page shows:
--   by id      the file and its owner when the caller reads it
--   by token   what drive_link_resolve shows, under the same rules: a link share, unexpired,
--              of a drive or ephemeral file, while drive_link_sharing is on
-- Anything else answers {"access": false} and nothing more: a missing id, a file the caller
-- cannot read, a trashed or gone file of someone else and a dead token look alike.
--
-- drive_share_gap(p_file, p_channel, p_conversation) tells the owner of a shareable file
-- whether local accounts of a room they view cannot read it: for a channel, whether any viewer
-- of it lacks access; for a conversation, which local participants lack it. NULL when the
-- caller does not own the file, the file cannot take a share, or the caller is outside the
-- room. Remote accounts are left out: they open nothing on this instance.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.drive_file_readable(p_file uuid, p_profile uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT p_profile IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.drive_files f
         WHERE f.id = p_file
           AND (f.owner_id = p_profile
                OR (f.state IN ('drive', 'ephemeral')
                    AND CASE f.bucket
                          WHEN 'message_media' THEN
                              public.drive_file_shared_with(f.id, p_profile)
                              OR public.message_media_named_for(f.path, p_profile)
                          WHEN 'user_media' THEN EXISTS (
                              SELECT 1 FROM public.posts po
                               CROSS JOIN LATERAL jsonb_array_elements(
                                   CASE WHEN jsonb_typeof(po.media_attachments) = 'array'
                                        THEN po.media_attachments ELSE '[]'::jsonb END) a
                               WHERE po.author_id = f.owner_id
                                 AND po.is_deleted IS NOT TRUE
                                 AND po.visibility IN ('public', 'unlisted')
                                 AND jsonb_typeof(a) = 'object'
                                 AND right(a ->> 'url', length(f.path) + 12) = '/user_media/' || f.path)
                          ELSE false
                        END)));
$$;

CREATE OR REPLACE FUNCTION public.drive_file_card(p_file uuid DEFAULT NULL, p_token text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.get_current_profile_id();
    v_none constant jsonb := jsonb_build_object('access', false);
    v_file public.drive_files;
    v_link public.drive_shares;
    v_owner jsonb;
BEGIN
    IF p_token IS NOT NULL THEN
        IF p_token !~ '^[A-Za-z0-9_-]{16,64}$' OR NOT public.drive_link_sharing_enabled() THEN
            RETURN v_none;
        END IF;
        SELECT s.* INTO v_link FROM public.drive_shares s
         WHERE s.scope = 'link'
           AND s.token = p_token
           AND (s.expires_at IS NULL OR s.expires_at > now());
        IF NOT FOUND THEN
            RETURN v_none;
        END IF;
        SELECT f.* INTO v_file FROM public.drive_files f
         WHERE f.id = v_link.file_id AND f.state IN ('drive', 'ephemeral');
        IF NOT FOUND THEN
            RETURN v_none;
        END IF;
        SELECT jsonb_build_object('username', p.username, 'display_name', p.display_name,
                                  'avatar_url', p.avatar_url, 'domain', p.domain)
          INTO v_owner
          FROM public.profiles p WHERE p.id = v_file.owner_id;
        RETURN jsonb_build_object(
            'access', true, 'via', 'link',
            'name', coalesce(v_file.name, 'file'), 'mime_type', v_file.mime_type,
            'kind', public.drive_mime_kind(v_file.mime_type), 'size_bytes', v_file.size_bytes,
            'created_at', v_file.created_at, 'expires_at', v_link.expires_at, 'owner', v_owner);
    END IF;

    IF p_file IS NULL OR NOT public.drive_file_readable(p_file, v_profile) THEN
        RETURN v_none;
    END IF;
    SELECT f.* INTO v_file FROM public.drive_files f WHERE f.id = p_file;
    SELECT jsonb_build_object('id', p.id, 'username', p.username, 'display_name', p.display_name,
                              'avatar_url', p.avatar_url, 'domain', p.domain)
      INTO v_owner
      FROM public.profiles p WHERE p.id = v_file.owner_id;
    RETURN jsonb_build_object(
        'access', true, 'via', 'file',
        'id', v_file.id, 'bucket', v_file.bucket, 'path', v_file.path,
        'name', v_file.name, 'mime_type', v_file.mime_type,
        'kind', public.drive_mime_kind(v_file.mime_type), 'size_bytes', v_file.size_bytes,
        'state', v_file.state, 'gone_reason', v_file.gone_reason,
        'expires_at', v_file.expires_at, 'created_at', v_file.created_at,
        'own', v_file.owner_id = v_profile, 'owner', v_owner);
END;
$$;

CREATE OR REPLACE FUNCTION public.drive_share_gap(
    p_file uuid,
    p_channel uuid DEFAULT NULL,
    p_conversation uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.drive_caller();
    v_file public.drive_files;
    v_server uuid;
    v_missing uuid[];
BEGIN
    SELECT f.* INTO v_file FROM public.drive_files f
     WHERE f.id = p_file
       AND f.owner_id = v_profile
       AND f.bucket = 'message_media'
       AND f.state IN ('drive', 'ephemeral');
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF p_channel IS NOT NULL THEN
        IF NOT public.can_view_channel(v_profile, p_channel) THEN
            RETURN NULL;
        END IF;
        SELECT c.server_id INTO v_server FROM public.channels c WHERE c.id = p_channel;

        -- A channel or server share, or a live message of the channel naming the object,
        -- admits every viewer of the channel.
        IF EXISTS (SELECT 1 FROM public.drive_shares s
                    WHERE s.file_id = p_file
                      AND (s.expires_at IS NULL OR s.expires_at > now())
                      AND ((s.scope = 'channel' AND s.target_id = p_channel)
                           OR (s.scope = 'server' AND s.target_id = v_server)))
           OR EXISTS (SELECT 1 FROM public.messages m
                       WHERE public.message_media_refs(m.content, m.media_paths) @> ARRAY[v_file.path]
                         AND m.is_deleted IS NOT TRUE
                         AND m.channel_id = p_channel) THEN
            RETURN jsonb_build_object('scope', 'channel', 'target', p_channel, 'missing', false);
        END IF;

        RETURN jsonb_build_object('scope', 'channel', 'target', p_channel, 'missing', EXISTS (
            SELECT 1
              FROM (SELECT us.user_id FROM public.user_servers us
                     WHERE us.server_id = v_server AND us.status = 'accepted'
                    UNION
                    SELECT sv.owner FROM public.servers sv WHERE sv.id = v_server) m(id)
              JOIN public.profiles p ON p.id = m.id
             WHERE m.id <> v_profile
               AND p.is_local IS NOT FALSE
               AND p.auth_user_id IS NOT NULL
               AND public.can_view_channel(m.id, p_channel)
               AND NOT public.drive_file_readable(p_file, m.id)));
    END IF;

    IF p_conversation IS NOT NULL THEN
        IF NOT EXISTS (SELECT 1 FROM public.conversation_participants cp
                        WHERE cp.conversation_id = p_conversation
                          AND cp.user_id = v_profile
                          AND cp.left_at IS NULL) THEN
            RETURN NULL;
        END IF;
        SELECT array_agg(cp.user_id ORDER BY cp.user_id) INTO v_missing
          FROM public.conversation_participants cp
          JOIN public.profiles p ON p.id = cp.user_id
         WHERE cp.conversation_id = p_conversation
           AND cp.left_at IS NULL
           AND cp.user_id <> v_profile
           AND p.is_local IS NOT FALSE
           AND p.auth_user_id IS NOT NULL
           AND NOT public.drive_file_readable(p_file, cp.user_id);
        RETURN jsonb_build_object('scope', 'user', 'targets', coalesce(to_jsonb(v_missing), '[]'::jsonb),
                                  'missing', v_missing IS NOT NULL);
    END IF;

    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.drive_file_readable(uuid, uuid) FROM PUBLIC, anon, authenticated;
DO $$
DECLARE
    grantee text;
BEGIN
    FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.drive_file_readable(uuid, uuid) TO %I', grantee);
        END IF;
    END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.drive_file_card(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.drive_file_card(uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.drive_share_gap(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.drive_share_gap(uuid, uuid, uuid) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
