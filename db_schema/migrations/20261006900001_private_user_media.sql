-- Chat attachments live in the private message_media bucket.
--
-- user_media stays public. It holds post media, which ActivityPub delivers by URL: remote
-- servers download it on receipt and re-fetch it from that URL, and Misskey can serve it by
-- proxy on every view. Chat attachments uploaded before this migration stay in user_media
-- until the data migration copies them here; clients before 1.6.6 keep uploading there.
--
-- Object names in message_media:
--   c/<channel id>/<uploader auth uid>/<file>        channel and thread messages (a thread
--                                                    reply names its thread's channel)
--   d/<conversation id>/<uploader auth uid>/<file>   direct and group conversations
-- A message file part names its object in `path`. Clients sign paths with createSignedUrls.
--
-- storage.objects, bucket message_media, authenticated only:
--   SELECT  the uploader (third segment is the caller's auth uid or profile id); a caller in
--           the room; a moderator of a report whose message snapshot has a file part naming
--           the object. INSERT and DELETE RETURNING read the uploader's row through it.
--   INSERT  third segment is the caller's auth uid, and the caller is in the room.
--   DELETE  the uploader; instance admins.
-- No UPDATE policy: objects are immutable and clients upload with upsert off.
-- storage.buckets: authenticated callers read the message_media row (limits, MIME types).
--
-- message_media_in_room(name): c -> can_view_channel() for the caller (accepted member or
-- owner, VIEW_CHANNEL on a restricted channel; banned and pending rows fail). d -> an active
-- participant row (left_at IS NULL).
--
-- federation_media_access(name, domain), service callers only. The federation media route
-- serves an object to a remote instance while that instance still receives the room:
--   c, local server    a federation_channel_recipients() row for the domain
--   c, remote server   the domain is the host of the server's inbox (or ap_id)
--   d                  an active participant whose profile is on the domain
--   domain '*'         c in a public local server where @everyone views the channel; the
--                      Group outbox serves those messages to anyone
--
-- messages: a file part that carries `path` names an object of the message's own room
-- (c/<channel_id>/ or d/<conversation_id>/), whoever writes it. Service callers sign paths
-- with service_role (bot-gateway, the federation media route); the room of the message is
-- what they hand out. Encrypted content has no visible parts.
--
-- Object cleanup. A message whose update or delete drops paths (deletion drops all of them)
-- queues a delete-message-media job with those paths; federation-backend deletes them through
-- storage-api, which owns the bytes. message_media_deletable(paths, min_age, limit) returns
-- the objects among `paths` (every object when NULL) older than min_age that nothing still
-- needs: a file part of a message that is not deleted, a report's message snapshot, or an
-- uploader whose data export is open (it signs links to the uploader's attachments). The
-- federation backend's periodic sweep calls it with paths NULL and a day's age, which spares
-- uploads not sent yet and catches jobs that were never delivered.
--
-- federation_post_access(post, domain), service callers only. Public and unlisted posts:
-- anyone. Others: an instance an addressed (mentioned) recipient is on; for followers-only
-- posts also an instance with an accepted follower of the author. Deleted posts: nobody.
-- federation_conversation_access(conversation, domain): an instance with an active,
-- unsuspended participant.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Room membership for an object name
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.message_media_in_room(p_name text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile uuid := public.get_current_profile_id();
    v_kind text := split_part(p_name, '/', 1);
    v_room text := split_part(p_name, '/', 2);
BEGIN
    IF v_profile IS NULL
       OR v_room !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN false;
    END IF;

    IF v_kind = 'c' THEN
        RETURN public.can_view_channel(v_profile, v_room::uuid);
    ELSIF v_kind = 'd' THEN
        RETURN EXISTS (
            SELECT 1 FROM public.conversation_participants cp
             WHERE cp.conversation_id = v_room::uuid
               AND cp.user_id = v_profile
               AND cp.left_at IS NULL
        );
    END IF;
    RETURN false;
END;
$$;

-- An object a report's message snapshot names, for a caller who moderates that report: the
-- rule of the reports SELECT policy "Moderators can view reports they moderate". Clients hold
-- no privilege on reports.content_snapshot.
CREATE OR REPLACE FUNCTION public.message_media_reported(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.reports r
         WHERE r.reported_message_id IS NOT NULL
           AND r.content_snapshot -> 'message' -> 'content'
               @> jsonb_build_array(jsonb_build_object('path', p_name))
           AND (public.is_current_user_admin_or_mod()
                OR (r.scope_server_id IS NOT NULL
                    AND public.can_current_user_moderate_server_reports(r.scope_server_id)))
    );
$$;

-- ---------------------------------------------------------------------------
-- Remote instance access for the federation media route
-- ---------------------------------------------------------------------------

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
    v_domain text := lower(btrim(p_domain));
    v_server uuid;
    v_local boolean;
    v_host text;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'federation_media_access is for service callers' USING ERRCODE = '42501';
    END IF;

    IF v_domain IS NULL OR v_domain = ''
       OR v_room !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        RETURN false;
    END IF;

    IF v_kind = 'c' THEN
        SELECT s.id, s.is_local_server,
               lower(substring(COALESCE(s.federation_inbox_url, s.ap_id) FROM '^https?://([^/:?#]+)'))
          INTO v_server, v_local, v_host
          FROM public.channels c
          JOIN public.servers s ON s.id = c.server_id
         WHERE c.id = v_room::uuid;

        IF v_server IS NULL THEN
            RETURN false;
        END IF;

        IF v_local IS FALSE THEN
            RETURN COALESCE(v_domain <> '*' AND v_host = v_domain, false);
        END IF;

        IF v_domain = '*' THEN
            RETURN EXISTS (
                SELECT 1 FROM public.federation_group_access(v_server, NULL) g
                 WHERE g.is_public AND v_room::uuid = ANY (g.everyone_channel_ids)
            );
        END IF;

        RETURN EXISTS (
            SELECT 1 FROM public.federation_channel_recipients(v_room::uuid) r
             WHERE r.instance = v_domain
        );
    ELSIF v_kind = 'd' AND v_domain <> '*' THEN
        RETURN public.federation_conversation_access(v_room::uuid, v_domain);
    END IF;
    RETURN false;
END;
$$;

-- ---------------------------------------------------------------------------
-- Remote instance access to conversations and posts
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.federation_post_access(p_post_id uuid, p_domain text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_domain text := lower(btrim(p_domain));
    v_visibility text;
    v_author uuid;
    v_content jsonb;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'federation_post_access is for service callers' USING ERRCODE = '42501';
    END IF;

    SELECT coalesce(po.visibility, 'public'), po.author_id, po.content
      INTO v_visibility, v_author, v_content
      FROM public.posts po
     WHERE po.id = p_post_id AND po.is_deleted IS NOT TRUE;

    IF NOT FOUND THEN
        RETURN false;
    END IF;
    IF v_visibility IN ('public', 'unlisted') THEN
        RETURN true;
    END IF;
    IF v_domain IS NULL OR v_domain = '' OR v_domain = '*' THEN
        RETURN false;
    END IF;

    IF EXISTS (
        SELECT 1
          FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_content) = 'array' THEN v_content ELSE '[]'::jsonb END) e
          LEFT JOIN public.profiles mp
                 ON mp.id = CASE WHEN e ->> 'userId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                                 THEN (e ->> 'userId')::uuid END
         WHERE jsonb_typeof(e) = 'object'
           AND e ->> 'type' = 'mention'
           AND CASE WHEN mp.id IS NOT NULL
                    THEN mp.is_local IS FALSE AND lower(mp.domain) = v_domain
                    ELSE lower(e ->> 'domain') = v_domain AND coalesce(e ->> 'isLocal', 'false') <> 'true'
               END
    ) THEN
        RETURN true;
    END IF;

    IF v_visibility IN ('followers', 'private') THEN
        RETURN EXISTS (
            SELECT 1
              FROM public.follows f
              JOIN public.profiles fp ON fp.id = f.follower_id
             WHERE f.following_id = v_author
               AND f.status = 'accepted'
               AND fp.is_local IS FALSE
               AND lower(fp.domain) = v_domain
        );
    END IF;
    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION public.federation_conversation_access(p_conversation_id uuid, p_domain text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'federation_conversation_access is for service callers' USING ERRCODE = '42501';
    END IF;

    RETURN EXISTS (
        SELECT 1
          FROM public.conversation_participants cp
          JOIN public.profiles p ON p.id = cp.user_id
         WHERE cp.conversation_id = p_conversation_id
           AND cp.left_at IS NULL
           AND p.is_local IS FALSE
           AND p.is_suspended IS NOT TRUE
           AND lower(p.domain) = lower(btrim(p_domain))
    );
END;
$$;

-- ---------------------------------------------------------------------------
-- Message parts name objects of their own room
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_message_media_paths()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_prefix text;
BEGIN
    IF jsonb_typeof(NEW.content) IS DISTINCT FROM 'array' THEN
        RETURN NEW;
    END IF;

    v_prefix := CASE
        WHEN NEW.channel_id IS NOT NULL THEN 'c/' || NEW.channel_id::text || '/'
        WHEN NEW.conversation_id IS NOT NULL THEN 'd/' || NEW.conversation_id::text || '/'
    END;

    IF EXISTS (
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
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_messages_media_path_guard ON public.messages;
CREATE TRIGGER a_messages_media_path_guard
    BEFORE INSERT OR UPDATE OF content, channel_id, conversation_id ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.guard_message_media_paths();

-- ---------------------------------------------------------------------------
-- Object cleanup
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.message_media_paths(p_content jsonb)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT coalesce(array_agg(DISTINCT e ->> 'path'), '{}'::text[])
      FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p_content) = 'array' THEN p_content ELSE '[]'::jsonb END) e
     WHERE jsonb_typeof(e) = 'object'
       AND e ->> 'type' = 'file'
       AND jsonb_typeof(e -> 'path') = 'string';
$$;

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
      FROM unnest(public.message_media_paths(OLD.content)) p
     WHERE TG_OP = 'DELETE'
        OR NEW.is_deleted IS TRUE
        OR p <> ALL (public.message_media_paths(NEW.content));

    IF cardinality(v_dropped) > 0 THEN
        PERFORM public.queue_federation_job('delete-message-media',
            jsonb_build_object('type', 'delete', 'paths', to_jsonb(v_dropped)));
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_messages_media_cleanup ON public.messages;
CREATE TRIGGER z_messages_media_cleanup
    AFTER UPDATE OF content, is_deleted OR DELETE ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.queue_message_media_cleanup();

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
        SELECT m.content
          FROM public.messages m
         WHERE m.is_deleted IS NOT TRUE
           AND m.channel_id IN (SELECT c.room FROM candidates c WHERE c.kind = 'c' AND c.room IS NOT NULL)
        UNION ALL
        SELECT m.content
          FROM public.messages m
         WHERE m.is_deleted IS NOT TRUE
           AND m.conversation_id IN (SELECT c.room FROM candidates c WHERE c.kind = 'd' AND c.room IS NOT NULL)
    ),
    referenced AS (
        SELECT unnest(public.message_media_paths(rm.content)) AS name FROM room_messages rm
        UNION
        SELECT unnest(public.message_media_paths(r.content_snapshot -> 'message' -> 'content'))
          FROM public.reports r
         WHERE r.content_snapshot -> 'message' -> 'content' IS NOT NULL
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
       AND NOT EXISTS (SELECT 1 FROM exporting x WHERE c.uploader IN (x.profile_id, x.auth_user_id))
     ORDER BY c.created_at
     LIMIT least(greatest(coalesce(p_limit, 500), 1), 1000);
END;
$$;

-- ---------------------------------------------------------------------------
-- Bucket and policies
-- ---------------------------------------------------------------------------

DO $$
BEGIN
    IF to_regclass('storage.objects') IS NULL OR to_regclass('storage.buckets') IS NULL THEN
        RAISE NOTICE 'storage schema absent, message_media bucket and policies skipped';
        RETURN;
    END IF;

    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('message_media', 'message_media', false, 52428800, ARRAY[
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
               'application/octet-stream'])
    ON CONFLICT (id) DO UPDATE SET
        public = false,
        file_size_limit = EXCLUDED.file_size_limit,
        allowed_mime_types = EXCLUDED.allowed_mime_types;

    -- Size limit and MIME list, for the client's pre-upload check.
    DROP POLICY IF EXISTS "Authenticated users read the message_media bucket" ON storage.buckets;
    CREATE POLICY "Authenticated users read the message_media bucket" ON storage.buckets
        AS PERMISSIVE FOR SELECT TO authenticated
        USING (id = 'message_media');

    DROP POLICY IF EXISTS "Room members can read message media" ON storage.objects;
    CREATE POLICY "Room members can read message media" ON storage.objects
        AS PERMISSIVE FOR SELECT TO authenticated
        USING (
            bucket_id = 'message_media'
            AND (
                (storage.foldername(name))[3] = (SELECT auth.uid())::text
                OR (storage.foldername(name))[3] = (SELECT public.get_current_profile_id())::text
                OR public.message_media_in_room(name)
                OR public.message_media_reported(name)
            )
        );

    DROP POLICY IF EXISTS "Room members can upload message media" ON storage.objects;
    CREATE POLICY "Room members can upload message media" ON storage.objects
        AS PERMISSIVE FOR INSERT TO authenticated
        WITH CHECK (
            bucket_id = 'message_media'
            AND (storage.foldername(name))[3] = (SELECT auth.uid())::text
            AND public.message_media_in_room(name)
        );

    DROP POLICY IF EXISTS "Uploaders and admins can delete message media" ON storage.objects;
    CREATE POLICY "Uploaders and admins can delete message media" ON storage.objects
        AS PERMISSIVE FOR DELETE TO authenticated
        USING (
            bucket_id = 'message_media'
            AND (
                (storage.foldername(name))[3] = (SELECT auth.uid())::text
                OR (storage.foldername(name))[3] = (SELECT public.get_current_profile_id())::text
                OR (SELECT public.is_current_user_admin())
            )
        );
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.message_media_in_room(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.message_media_in_room(text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.message_media_reported(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.message_media_reported(text) TO authenticated, service_role;

DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOREACH fn IN ARRAY ARRAY['public.federation_media_access(text, text)'::regprocedure,
                              'public.federation_post_access(uuid, text)'::regprocedure,
                              'public.federation_conversation_access(uuid, text)'::regprocedure,
                              'public.guard_message_media_paths()'::regprocedure,
                              'public.message_media_paths(jsonb)'::regprocedure,
                              'public.queue_message_media_cleanup()'::regprocedure,
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
