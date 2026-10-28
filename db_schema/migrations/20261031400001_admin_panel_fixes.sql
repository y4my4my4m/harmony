-- Admin panel: paged Drive usage, instance emoji uploads.
--
-- admin_drive_usage(search, limit, offset, profile) pages accounts holding Drive files or a
-- quota override, ordered by used bytes descending, then profile id. search is a
-- case-insensitive substring of username or display name; a leading @ is ignored. limit is
-- clamped to 1..200. total_count is the match count before limit and offset, repeated on every
-- row. p_profile returns that one account whatever it holds. The signature replaces
-- admin_drive_usage(integer, uuid); a second overload would make PostgREST's named-argument
-- call ambiguous.
--
-- Instance emoji files live at 00000000-0000-0000-0000-000000000000/<uuid>.<ext> in bucket
-- emojis. The bucket's server-emoji policies cast the first folder to uuid, so a non-uuid
-- folder raises 22P02 instead of falling through to another policy. Only instance admins
-- write or delete there.
--
-- create_instance_emoji(name, path, url) records an uploaded file as a local instance emoji
-- (scope 'instance', no server, no domain). Errors: 42501 not an admin; 22023 bad path, url or
-- missing object; 23505 the file is already an instance emoji. The url passes
-- is_storage_public_url (20261031200001_custom_stickers.sql): instance_config storage_origin,
-- when set, is its only origin. The name is the sanitised base, suffixed _1, _2, ... past a
-- case-insensitive clash among local instance-level emojis.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Drive usage
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_drive_usage(integer, uuid);

CREATE OR REPLACE FUNCTION public.admin_drive_usage(
    p_search text DEFAULT NULL,
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0,
    p_profile uuid DEFAULT NULL)
RETURNS TABLE (profile_id uuid, username text, display_name text, used_bytes bigint, quota_bytes bigint,
               ephemeral_bytes bigint, file_count bigint, quota_override bigint, total_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_search text := lower(NULLIF(ltrim(btrim(p_search), '@'), ''));
BEGIN
    IF NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    RETURN QUERY
    WITH holders AS (
        SELECT f.owner_id AS id FROM public.drive_files f WHERE p_profile IS NULL
        UNION
        SELECT o.profile_id FROM public.drive_quota_overrides o WHERE p_profile IS NULL
        UNION
        SELECT p_profile WHERE p_profile IS NOT NULL
    ), matched AS (
        SELECT p.id, p.username::text AS username, p.display_name::text AS display_name,
               public.drive_used_bytes(p.id) AS used
          FROM holders h
          JOIN public.profiles p ON p.id = h.id
         WHERE v_search IS NULL
            OR p_profile IS NOT NULL
            OR strpos(lower(p.username::text), v_search) > 0
            OR strpos(lower(COALESCE(p.display_name::text, '')), v_search) > 0
    ), paged AS (
        SELECT m.*, count(*) OVER () AS total
          FROM matched m
         ORDER BY m.used DESC, m.id
         LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))
        OFFSET GREATEST(COALESCE(p_offset, 0), 0)
    )
    SELECT g.id, g.username, g.display_name, g.used, public.drive_quota_bytes(g.id),
           COALESCE((SELECT sum(f.size_bytes) FROM public.drive_files f
                      WHERE f.owner_id = g.id AND f.state = 'ephemeral'), 0)::bigint,
           (SELECT count(*) FROM public.drive_files f WHERE f.owner_id = g.id AND f.state IN ('drive', 'ephemeral')),
           (SELECT o.quota_bytes FROM public.drive_quota_overrides o WHERE o.profile_id = g.id),
           g.total
      FROM paged g
     ORDER BY g.used DESC, g.id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Instance emoji uploads
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_instance_emoji(p_name text, p_path text, p_url text)
RETURNS public.emojis
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_suffix text;
    v_size text;
    v_base text;
    v_name text;
    v_n integer := 0;
    v_row public.emojis;
BEGIN
    IF v_me IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;

    IF p_path IS NULL OR p_path !~ ('^00000000-0000-0000-0000-000000000000'
        || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|apng|gif|webp|jpg|jpeg)$') THEN
        RAISE EXCEPTION 'EMOJI_PATH: an instance emoji file is 00000000-0000-0000-0000-000000000000/<uuid>.<png|apng|gif|webp|jpg|jpeg>'
            USING ERRCODE = '22023';
    END IF;

    IF NOT public.is_storage_public_url(p_url, 'emojis', p_path) THEN
        RAISE EXCEPTION 'EMOJI_URL: the url is not the public URL of %', p_path USING ERRCODE = '22023';
    END IF;
    v_suffix := '/storage/v1/object/public/emojis/' || p_path;

    SELECT o.metadata ->> 'size' INTO v_size
      FROM storage.objects o
     WHERE o.bucket_id = 'emojis'
       AND o.name = p_path;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'EMOJI_FILE_MISSING: % is not in the emojis bucket', p_path USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('instance_emojis', 0));

    IF EXISTS (
        SELECT 1 FROM public.emojis e
         WHERE e.scope = 'instance'
           AND right(e.url::text, char_length(v_suffix)) = v_suffix) THEN
        RAISE EXCEPTION 'That file is an instance emoji' USING ERRCODE = '23505';
    END IF;

    v_base := left(regexp_replace(COALESCE(p_name, ''), '[^A-Za-z0-9_-]', '', 'g'), 32);
    IF char_length(v_base) < 2 THEN
        v_base := 'emoji';
    END IF;
    v_name := v_base;
    WHILE EXISTS (
        SELECT 1 FROM public.emojis e
         WHERE (e.scope = 'instance' OR (e.server_id IS NULL AND e.scope <> 'user'))
           AND e.domain IS NULL
           AND lower(e.name::text) = lower(v_name)) LOOP
        v_n := v_n + 1;
        v_name := v_base || '_' || v_n;
    END LOOP;

    INSERT INTO public.emojis (name, url, server_id, uploader, domain, scope, is_ai_generated, file_size)
    VALUES (v_name, p_url, NULL, v_me, NULL, 'instance', false,
            CASE WHEN v_size ~ '^[0-9]{1,9}$' THEN v_size::integer END)
    RETURNING * INTO v_row;

    PERFORM public.log_admin_action(v_me, 'instance_emoji_create', 'emoji', v_row.id::text,
                                    jsonb_build_object('name', v_row.name, 'url', v_row.url));
    RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.create_instance_emoji(text, text, text) IS
'Creates a local instance emoji from an admin upload at 00000000-0000-0000-0000-000000000000/<uuid>.<ext> in bucket emojis.';

DO $$
BEGIN
    IF to_regclass('storage.objects') IS NULL THEN
        RAISE NOTICE 'storage schema absent, instance emoji storage policies skipped';
        RETURN;
    END IF;

    DROP POLICY IF EXISTS "Admins upload instance emojis" ON storage.objects;
    CREATE POLICY "Admins upload instance emojis" ON storage.objects
        AS PERMISSIVE FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'emojis'
                    AND array_length(storage.foldername(name), 1) = 1
                    AND (storage.foldername(name))[1] = '00000000-0000-0000-0000-000000000000'
                    AND (SELECT public.is_current_user_admin()));

    DROP POLICY IF EXISTS "Admins delete instance emojis" ON storage.objects;
    CREATE POLICY "Admins delete instance emojis" ON storage.objects
        AS PERMISSIVE FOR DELETE TO authenticated
        USING (bucket_id = 'emojis'
               AND array_length(storage.foldername(name), 1) = 1
               AND (storage.foldername(name))[1] = '00000000-0000-0000-0000-000000000000'
               AND (SELECT public.is_current_user_admin()));
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.admin_drive_usage(text, integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_drive_usage(text, integer, integer, uuid) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.create_instance_emoji(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_instance_emoji(text, text, text) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
