-- message_media objects of encrypted messages.
--
-- An encrypted message's content is ciphertext: its file parts and their `path` are not
-- visible to the server, and encryption_metadata carries no attachment marker
-- (content_type is application/json for every message). message_media_deletable() therefore
-- found no reference to such an object and its hourly sweep removed it a day after upload.
--
-- messages.media_paths lists the message_media objects the message names. The client fills it
-- on every encrypted insert and edit ('{}' without attachments); the server already sees each
-- object name in storage, so the list discloses nothing new. NULL is an unknown list: an
-- encrypted message written before this column, or by a client that does not set it.
--
-- a_messages_media_path_guard checks the list as it checks file parts: each entry names an
-- object of the message's own room (c/<channel_id>/ or d/<conversation_id>/), no dot
-- segments, at most 100 entries; stored sorted and distinct. A client changes the list only
-- on its own live message.
--
-- The objects a message names are the paths of its file parts plus media_paths
-- (message_media_refs). The cleanup trigger queues what an edit or delete drops from that
-- set; message_media_deletable() keeps what a live message or a report snapshot names, and
-- report snapshots carry media_paths.
--
-- Unknown lists. An object is kept while its room holds a live encrypted message with no
-- list whose last content write (updated_at, server-set) is no earlier than the object's
-- creation, or a report snapshot of such a message. Uploads precede the send, so a message
-- written before an upload cannot name it. Messages of remote authors name no local object
-- and are ignored. Encrypted messages from clients before 1.6.6 name user_media URLs only.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS media_paths text[];

-- ---------------------------------------------------------------------------
-- Objects a message names
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.message_media_refs(p_content jsonb, p_media_paths text[])
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT coalesce(array_agg(DISTINCT p), '{}'::text[])
      FROM (
        SELECT e ->> 'path' AS p
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_content) = 'array' THEN p_content ELSE '[]'::jsonb END) e
         WHERE jsonb_typeof(e) = 'object'
           AND e ->> 'type' = 'file'
           AND jsonb_typeof(e -> 'path') = 'string'
        UNION ALL
        SELECT u FROM unnest(coalesce(p_media_paths, '{}'::text[])) u WHERE u IS NOT NULL
      ) s;
$$;

-- ---------------------------------------------------------------------------
-- Path guard: file parts and media_paths
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
                OR left(e ->> 'path', length(v_prefix)) <> v_prefix
                OR e ->> 'path' ~ '(^|/)\.\.?(/|$)')
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
                OR left(p, length(v_prefix)) <> v_prefix
                OR length(p) = length(v_prefix)
                OR p ~ '(^|/)\.\.?(/|$)'
        ) THEN
            RAISE EXCEPTION 'An attachment names an object outside this conversation'
                USING ERRCODE = '42501';
        END IF;
        NEW.media_paths := ARRAY(SELECT DISTINCT p FROM unnest(NEW.media_paths) p ORDER BY p);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_messages_media_path_guard ON public.messages;
CREATE TRIGGER a_messages_media_path_guard
    BEFORE INSERT OR UPDATE OF content, media_paths, channel_id, conversation_id ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.guard_message_media_paths();

-- ---------------------------------------------------------------------------
-- Cleanup trigger
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.queue_message_media_cleanup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_dropped text[];
BEGIN
    SELECT coalesce(array_agg(p), '{}'::text[]) INTO v_dropped
      FROM unnest(public.message_media_refs(OLD.content, OLD.media_paths)) p
     WHERE TG_OP = 'DELETE'
        OR NEW.is_deleted IS TRUE
        OR p <> ALL (public.message_media_refs(NEW.content, NEW.media_paths));

    IF cardinality(v_dropped) > 0 THEN
        PERFORM public.queue_federation_job('delete-message-media',
            jsonb_build_object('type', 'delete', 'paths', to_jsonb(v_dropped)));
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_messages_media_cleanup ON public.messages;
CREATE TRIGGER z_messages_media_cleanup
    AFTER UPDATE OF content, media_paths, is_deleted OR DELETE ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.queue_message_media_cleanup();

-- ---------------------------------------------------------------------------
-- Report snapshots carry media_paths
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.report_content_snapshot(
    p_user_id uuid,
    p_post_ids uuid[],
    p_message_id uuid,
    p_server_id uuid
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_strip_nulls(jsonb_build_object(
        'taken_at', now(),
        'account', (
            SELECT jsonb_build_object(
                'id', p.id, 'username', p.username, 'display_name', p.display_name,
                'domain', p.domain, 'is_local', p.is_local, 'federated_id', p.federated_id,
                'avatar_url', p.avatar_url, 'bio', p.bio)
              FROM public.profiles p
             WHERE p.id = p_user_id),
        'posts', (
            SELECT jsonb_agg(jsonb_build_object(
                'id', po.id, 'ap_id', po.ap_id, 'url', po.url, 'author_id', po.author_id,
                'content', po.content, 'content_warning', po.content_warning,
                'is_sensitive', po.is_sensitive, 'visibility', po.visibility,
                'media_attachments', po.media_attachments, 'is_local', po.is_local,
                'is_deleted', po.is_deleted, 'created_at', po.created_at,
                'updated_at', po.updated_at) ORDER BY po.created_at)
              FROM public.posts po
             WHERE po.id = ANY (COALESCE(p_post_ids, '{}'::uuid[]))),
        'message', (
            SELECT jsonb_build_object(
                'id', m.id, 'user_id', m.user_id, 'bot_id', m.bot_id, 'channel_id', m.channel_id,
                'server_id', c.server_id, 'conversation_id', m.conversation_id,
                'content', m.content, 'media_paths', to_jsonb(m.media_paths),
                'encrypted', m.encrypted, 'is_deleted', m.is_deleted,
                'created_at', m.created_at, 'updated_at', m.updated_at)
              FROM public.messages m
              LEFT JOIN public.channels c ON c.id = m.channel_id
             WHERE m.id = p_message_id),
        'server', (
            SELECT jsonb_build_object(
                'id', s.id, 'name', s.name, 'description', s.description, 'owner', s.owner)
              FROM public.servers s
             WHERE s.id = p_server_id)
    ));
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
    -- Last content write of an encrypted message with no list, per room.
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
     ORDER BY c.created_at
     LIMIT least(greatest(coalesce(p_limit, 500), 1), 1000);
END;
$$;

-- message_media_refs replaces it.
DROP FUNCTION IF EXISTS public.message_media_paths(jsonb);

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOREACH fn IN ARRAY ARRAY['public.message_media_refs(jsonb, text[])'::regprocedure,
                              'public.guard_message_media_paths()'::regprocedure,
                              'public.queue_message_media_cleanup()'::regprocedure,
                              'public.report_content_snapshot(uuid, uuid[], uuid, uuid)'::regprocedure,
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

COMMIT;

NOTIFY pgrst, 'reload schema';
