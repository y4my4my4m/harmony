-- Personal emoji uploads; a per-user emoji limit.
--
-- create_my_emoji(name, path, url) is the client path for a personal upload and returns the
-- new row. path is <caller profile id>/<uuid>.<png|apng|gif|webp|jpg|jpeg> and must exist in
-- bucket emojis; url is <origin>/storage/v1/object/public/emojis/<path>. The database holds
-- no public storage origin, so the origin is checked for shape (http or https, a host, an
-- optional port and path prefix; no userinfo, query or fragment), not pinned. A path already
-- behind one of the caller's emojis is 23505. name keeps [A-Za-z0-9_-], at most 32
-- characters, 'emoji' below 2; a name the owner holds (case-insensitive) takes the first
-- free suffix _1, _2, ... file_size is the object's metadata size. is_ai_generated is false.
--
-- emojis_insert_user_scope is dropped: clients insert user-scope rows through
-- create_my_emoji only. The service role inserts AI-generated rows directly.
--
-- instance_config max_personal_emojis_per_user (public; default 50; 0 to 1000) caps the
-- user-scope rows of one owner. AI-generated personal emojis count toward the limit.
-- 0 turns personal emojis off. A value above 1000 reads as 1000; a missing, negative or
-- unparseable one as 50. Rows past a lowered limit stay. enforce_personal_emoji_limit, a
-- BEFORE INSERT trigger for every writer, raises PERSONAL_EMOJI_LIMIT (23514) under the
-- advisory lock 'user_emojis:<owner>', shared with rename_my_emoji and create_my_emoji.
--
-- Storage. A signed-in user uploads and deletes objects of bucket emojis named
-- <own profile id>/<file>, one folder deep. Server emojis are <server>/<uploader>/<file>,
-- two folders deep, under the MANAGE_EMOJIS policies, which are unchanged; their uuid cast
-- of the first folder holds for a profile id.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- instance_config max_personal_emojis_per_user
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
    v_keys text[] := public.public_instance_config_keys();
BEGIN
    IF NOT ('max_personal_emojis_per_user' = ANY (v_keys)) THEN
        EXECUTE format(
            'CREATE OR REPLACE FUNCTION public.public_instance_config_keys() RETURNS text[] '
            'LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS %L',
            format('SELECT %L::text[]', v_keys || 'max_personal_emojis_per_user'::text));
    END IF;
END;
$do$;

INSERT INTO public.instance_config (config_key, config_value, description)
VALUES ('max_personal_emojis_per_user', '50'::jsonb,
        'Personal emojis one user can hold, uploads and AI-generated (0-1000). 0 turns personal emojis off.')
ON CONFLICT (config_key) DO NOTHING;

CREATE OR REPLACE FUNCTION public.personal_emoji_limit()
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN (SELECT ic.config_value #>> '{}' FROM public.instance_config ic
               WHERE ic.config_key = 'max_personal_emojis_per_user') ~ '^\s*0+\s*$' THEN 0
        ELSE public.get_instance_config_int('max_personal_emojis_per_user', 50, 1000)
    END
$$;

COMMENT ON FUNCTION public.personal_emoji_limit() IS
'instance_config max_personal_emojis_per_user: 0 (personal emojis off) to 1000; 50 when unset.';

-- ---------------------------------------------------------------------------
-- Limit
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_personal_emoji_limit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_limit integer;
    v_held integer;
BEGIN
    IF NEW.uploader IS NULL THEN
        RETURN NEW;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('user_emojis:' || NEW.uploader::text, 0));

    v_limit := public.personal_emoji_limit();
    SELECT count(*) INTO v_held
      FROM public.emojis e
     WHERE e.scope = 'user'
       AND e.uploader = NEW.uploader;

    IF v_held < v_limit THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'PERSONAL_EMOJI_LIMIT: at most % personal emojis per user', v_limit
        USING ERRCODE = '23514';
END;
$$;

DROP TRIGGER IF EXISTS enforce_personal_emoji_limit ON public.emojis;
CREATE TRIGGER enforce_personal_emoji_limit
    BEFORE INSERT ON public.emojis
    FOR EACH ROW
    WHEN (NEW.scope = 'user')
    EXECUTE FUNCTION public.enforce_personal_emoji_limit();

-- ---------------------------------------------------------------------------
-- Client path
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS emojis_insert_user_scope ON public.emojis;

CREATE OR REPLACE FUNCTION public.create_my_emoji(p_name text, p_path text, p_url text)
RETURNS public.emojis
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_suffix text;
    v_origin text;
    v_size text;
    v_base text;
    v_name text;
    v_n integer := 0;
    v_row public.emojis;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
    END IF;

    IF p_path IS NULL OR p_path !~ ('^' || v_me::text
        || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(png|apng|gif|webp|jpg|jpeg)$') THEN
        RAISE EXCEPTION 'EMOJI_PATH: an emoji file is <your profile id>/<uuid>.<png|apng|gif|webp|jpg|jpeg>'
            USING ERRCODE = '22023';
    END IF;

    v_suffix := '/storage/v1/object/public/emojis/' || p_path;
    IF p_url IS NULL OR char_length(p_url) > 2048 OR right(p_url, char_length(v_suffix)) <> v_suffix THEN
        RAISE EXCEPTION 'EMOJI_URL: the url is not the public URL of %', p_path USING ERRCODE = '22023';
    END IF;
    v_origin := left(p_url, char_length(p_url) - char_length(v_suffix));
    IF v_origin !~ '^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*$' THEN
        RAISE EXCEPTION 'EMOJI_URL: the url is not the public URL of %', p_path USING ERRCODE = '22023';
    END IF;

    SELECT o.metadata ->> 'size' INTO v_size
      FROM storage.objects o
     WHERE o.bucket_id = 'emojis'
       AND o.name = p_path;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'EMOJI_FILE_MISSING: % is not in the emojis bucket', p_path USING ERRCODE = '22023';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended('user_emojis:' || v_me::text, 0));

    IF EXISTS (
        SELECT 1 FROM public.emojis e
         WHERE e.scope = 'user'
           AND e.uploader = v_me
           AND right(e.url::text, char_length(v_suffix)) = v_suffix) THEN
        RAISE EXCEPTION 'That file is one of your emojis' USING ERRCODE = '23505';
    END IF;

    v_base := left(regexp_replace(COALESCE(p_name, ''), '[^A-Za-z0-9_-]', '', 'g'), 32);
    IF char_length(v_base) < 2 THEN
        v_base := 'emoji';
    END IF;
    v_name := v_base;
    WHILE EXISTS (
        SELECT 1 FROM public.emojis e
         WHERE e.scope = 'user'
           AND e.uploader = v_me
           AND lower(e.name::text) = lower(v_name)) LOOP
        v_n := v_n + 1;
        v_name := v_base || '_' || v_n;
    END LOOP;

    INSERT INTO public.emojis (name, url, server_id, uploader, domain, scope, is_ai_generated, file_size)
    VALUES (v_name, p_url, NULL, v_me, NULL, 'user', false,
            CASE WHEN v_size ~ '^[0-9]{1,9}$' THEN v_size::integer END)
    RETURNING * INTO v_row;

    RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.create_my_emoji(text, text, text) IS
'Creates a personal emoji from the caller''s upload at <profile id>/<uuid>.<ext> in bucket emojis.';

-- ---------------------------------------------------------------------------
-- Storage
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    IF to_regclass('storage.objects') IS NULL THEN
        RAISE NOTICE 'storage schema absent, personal emoji storage policies skipped';
        RETURN;
    END IF;

    DROP POLICY IF EXISTS "Users can upload personal emojis" ON storage.objects;
    CREATE POLICY "Users can upload personal emojis" ON storage.objects
        AS PERMISSIVE FOR INSERT TO authenticated
        WITH CHECK (bucket_id = 'emojis'
                    AND array_length(storage.foldername(name), 1) = 1
                    AND (storage.foldername(name))[1] = (SELECT public.get_current_profile_id())::text);

    DROP POLICY IF EXISTS "Users can delete personal emojis" ON storage.objects;
    CREATE POLICY "Users can delete personal emojis" ON storage.objects
        AS PERMISSIVE FOR DELETE TO authenticated
        USING (bucket_id = 'emojis'
               AND array_length(storage.foldername(name), 1) = 1
               AND (storage.foldername(name))[1] = (SELECT public.get_current_profile_id())::text);
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.create_my_emoji(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_my_emoji(text, text, text) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.personal_emoji_limit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.personal_emoji_limit() TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.enforce_personal_emoji_limit() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enforce_personal_emoji_limit() TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
