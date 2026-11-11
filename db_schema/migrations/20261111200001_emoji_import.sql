-- Remote emoji import: licence and origin kept, remote emoji listed by instance, names previewed.
--
-- emojis.license, emojis.source_domain, remote_emojis_cache.license
--   license is the origin's free text, at most 1024 characters. Misskey sends it on the Emoji tag
--   as _misskey_license.freeText (ApRendererService.renderEmoji). source_domain is the instance
--   an imported emoji came from; imported_from keeps the image URL, which may be a media host.
--   Rows imported earlier take source_domain from their cache row.
-- upsert_remote_emoji(..., p_license)
--   NULL leaves a stored licence unchanged: reaction sightings carry none. One origin holds at
--   most 10000 rows: past that a shortcode not yet stored is not recorded and the call returns
--   NULL. Emoji tags of inbound Notes write here (federation-backend utils/remoteEmojiCache.ts),
--   up to 50 a Note.
-- instance_emoji_import_name(shortcode)
--   Name an import takes: the part before any @host reduced to [A-Za-z0-9_-], at most 32;
--   'emoji' below 2 characters.
-- instance_emoji_name_held(name)
--   An active instance-level emoji of this instance holds the name, case-insensitive.
-- import_remote_emoji
--   20261107100001 plus license and source_domain copied from the cache row.
-- admin_list_remote_emojis(search, domain, sort, limit, offset)
--   remote_emojis_cache rows not imported. search matches the shortcode, domain the origin
--   exactly. import_name and name_taken say what an import would be called and whether an
--   instance emoji holds that name.
-- admin_remote_emoji_sources()
--   Origin domains of rows not imported, with their counts. At most 500.
-- admin_preview_emoji_imports(ids)
--   Per cache id, in the order given: the import name, whether it is taken by an instance emoji
--   or by an earlier id of the same call, and a free name (_<n> appended). Absent and imported
--   ids return no row. At most 200 ids.
-- admin_list_emojis
--   20261107100001 plus license and source_domain.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
ALTER TABLE public.emojis
    ADD COLUMN IF NOT EXISTS license text,
    ADD COLUMN IF NOT EXISTS source_domain text;
ALTER TABLE public.remote_emojis_cache
    ADD COLUMN IF NOT EXISTS license text;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.emojis'::regclass AND conname = 'emojis_license_check') THEN
        ALTER TABLE public.emojis ADD CONSTRAINT emojis_license_check
            CHECK (license IS NULL OR char_length(license) <= 1024);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.emojis'::regclass AND conname = 'emojis_source_domain_check') THEN
        ALTER TABLE public.emojis ADD CONSTRAINT emojis_source_domain_check
            CHECK (source_domain IS NULL OR char_length(source_domain) <= 255);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.remote_emojis_cache'::regclass
                      AND conname = 'remote_emojis_cache_license_check') THEN
        ALTER TABLE public.remote_emojis_cache ADD CONSTRAINT remote_emojis_cache_license_check
            CHECK (license IS NULL OR char_length(license) <= 1024);
    END IF;
END;
$$;

COMMENT ON COLUMN public.emojis.license IS
'Licence or attribution text of an imported emoji, as its origin instance states it.';
COMMENT ON COLUMN public.emojis.source_domain IS
'Instance an imported emoji came from. imported_from holds the image URL.';
COMMENT ON COLUMN public.remote_emojis_cache.license IS
'Licence or attribution text the origin sent with the emoji.';

UPDATE public.emojis e
   SET source_domain = lower(btrim(c.origin_domain))
  FROM public.remote_emojis_cache c
 WHERE c.imported_as = e.id
   AND e.source_domain IS NULL
   AND NULLIF(btrim(c.origin_domain), '') IS NOT NULL
   AND char_length(btrim(c.origin_domain)) <= 255;

-- ---------------------------------------------------------------------------
-- Cache writes
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.upsert_remote_emoji(text, text, text, text, text, text, boolean);

CREATE OR REPLACE FUNCTION public.upsert_remote_emoji(
    p_shortcode text,
    p_origin_domain text,
    p_full_code text,
    p_url text,
    p_static_url text DEFAULT NULL,
    p_category text DEFAULT NULL,
    p_is_animated boolean DEFAULT NULL,
    p_license text DEFAULT NULL)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_cap constant integer := 10000;
    v_id uuid;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.remote_emojis_cache c
                    WHERE c.shortcode = p_shortcode AND c.origin_domain = p_origin_domain)
       AND (SELECT count(*) FROM (SELECT 1 FROM public.remote_emojis_cache c
                                   WHERE c.origin_domain = p_origin_domain LIMIT v_cap) held) >= v_cap THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.remote_emojis_cache (
        shortcode, origin_domain, full_code, url, static_url, category, is_animated, license
    ) VALUES (
        p_shortcode, p_origin_domain, p_full_code, p_url, p_static_url, p_category, p_is_animated,
        NULLIF(left(btrim(p_license), 1024), '')
    )
    ON CONFLICT (shortcode, origin_domain) DO UPDATE SET
        url = EXCLUDED.url,
        static_url = COALESCE(EXCLUDED.static_url, remote_emojis_cache.static_url),
        last_seen_at = now(),
        usage_count = remote_emojis_cache.usage_count + 1,
        category = COALESCE(EXCLUDED.category, remote_emojis_cache.category),
        is_animated = COALESCE(EXCLUDED.is_animated, remote_emojis_cache.is_animated),
        license = COALESCE(EXCLUDED.license, remote_emojis_cache.license)
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

-- ---------------------------------------------------------------------------
-- Import names
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.instance_emoji_import_name(p_shortcode text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT CASE WHEN char_length(b.base) < 2 THEN 'emoji' ELSE b.base END
      FROM (SELECT left(regexp_replace(split_part(COALESCE(p_shortcode, ''), '@', 1),
                                       '[^A-Za-z0-9_-]', '', 'g'), 32) AS base) b
$$;

CREATE OR REPLACE FUNCTION public.instance_emoji_name_held(p_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.emojis e
         WHERE e.server_id IS NULL AND e.scope <> 'user'
           AND NULLIF(btrim(e.domain), '') IS NULL
           AND e.deleted_at IS NULL
           AND lower(e.name::text) = lower(p_name))
$$;

-- 42501 for client roles, P0002 no cache row, 23505 already imported or p_name taken, 22023 a
-- bad p_name, path, url or missing object. Without p_name the name is
-- instance_emoji_import_name(shortcode), with _<n> appended while an active instance emoji
-- holds it.
CREATE OR REPLACE FUNCTION public.import_remote_emoji(p_remote_emoji_id uuid, p_name text, p_path text, p_url text, p_actor uuid)
RETURNS public.emojis
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_remote public.remote_emojis_cache%ROWTYPE;
    v_name text := NULLIF(btrim(p_name), '');
    v_base text;
    v_n integer := 0;
    v_size integer;
    v_domain text;
    v_row public.emojis;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'Imports go through the federation backend' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_remote FROM public.remote_emojis_cache c WHERE c.id = p_remote_emoji_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Remote emoji not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_remote.imported_as IS NOT NULL THEN
        RAISE EXCEPTION 'Emoji already imported' USING ERRCODE = '23505';
    END IF;
    IF v_name IS NOT NULL AND v_name !~ '^[A-Za-z0-9_-]{2,64}$' THEN
        RAISE EXCEPTION 'Emoji names are 2 to 64 letters, digits, _ or -' USING ERRCODE = '22023';
    END IF;

    v_size := public.instance_emoji_object_ok(p_path, p_url);

    PERFORM pg_advisory_xact_lock(hashtextextended('instance_emojis', 0));
    IF v_name IS NOT NULL THEN
        IF public.instance_emoji_name_held(v_name) THEN
            RAISE EXCEPTION 'Emoji name already exists locally: %', v_name USING ERRCODE = '23505';
        END IF;
    ELSE
        v_base := public.instance_emoji_import_name(v_remote.shortcode);
        v_name := v_base;
        WHILE public.instance_emoji_name_held(v_name) LOOP
            v_n := v_n + 1;
            v_name := v_base || '_' || v_n;
        END LOOP;
    END IF;

    v_domain := lower(NULLIF(btrim(v_remote.origin_domain), ''));

    INSERT INTO public.emojis (name, url, server_id, uploader, scope, domain, file_size, imported_from,
                               license, source_domain)
    VALUES (v_name, p_url, NULL,
            CASE WHEN EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = p_actor) THEN p_actor END,
            'instance', NULL, v_size,
            CASE WHEN char_length(v_remote.url) <= 2048 AND v_remote.url ~* '^https?://' THEN v_remote.url END,
            NULLIF(left(btrim(v_remote.license), 1024), ''),
            CASE WHEN char_length(v_domain) <= 255 THEN v_domain END)
    RETURNING * INTO v_row;

    UPDATE public.remote_emojis_cache
       SET imported_as = v_row.id, imported_at = now()
     WHERE id = p_remote_emoji_id;

    IF p_actor IS NOT NULL THEN
        PERFORM public.log_admin_action(p_actor, 'instance_emoji_import', 'emoji', v_row.id::text,
                                        jsonb_build_object('name', v_row.name, 'from', v_remote.url,
                                                           'domain', v_remote.origin_domain));
    END IF;
    RETURN v_row;
END;
$$;

-- ---------------------------------------------------------------------------
-- Remote emoji an admin may import
-- ---------------------------------------------------------------------------

-- p_sort newest | oldest | name | usage. url is the static image when the origin sent one.
CREATE OR REPLACE FUNCTION public.admin_list_remote_emojis(
    p_search text DEFAULT NULL,
    p_domain text DEFAULT NULL,
    p_sort text DEFAULT 'newest',
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0)
RETURNS TABLE(id uuid, name text, url text, domain text, license text, first_seen_at timestamptz,
              usage_count integer, import_name text, name_taken boolean, total_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_search text := lower(NULLIF(btrim(p_search), ''));
    v_domain text := lower(NULLIF(btrim(p_domain), ''));
    v_sort text := COALESCE(p_sort, 'newest');
    v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));
    v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    IF v_sort NOT IN ('newest', 'oldest', 'name', 'usage') THEN
        RAISE EXCEPTION 'Unknown sort: %', v_sort USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH matched AS (
        SELECT c.*, count(*) OVER () AS total
          FROM public.remote_emojis_cache c
         WHERE c.imported_as IS NULL
           AND (v_search IS NULL OR strpos(lower(c.shortcode), v_search) > 0)
           AND (v_domain IS NULL OR lower(c.origin_domain) = v_domain)
         ORDER BY CASE WHEN v_sort = 'name' THEN lower(c.shortcode) END ASC NULLS LAST,
                  CASE WHEN v_sort = 'usage' THEN c.usage_count END DESC NULLS LAST,
                  CASE WHEN v_sort = 'oldest' THEN c.first_seen_at END ASC NULLS LAST,
                  c.first_seen_at DESC NULLS LAST, c.id DESC
         LIMIT v_limit OFFSET v_offset
    )
    SELECT m.id, m.shortcode, COALESCE(m.static_url, m.url), lower(m.origin_domain), m.license,
           m.first_seen_at, COALESCE(m.usage_count, 0),
           public.instance_emoji_import_name(m.shortcode),
           public.instance_emoji_name_held(public.instance_emoji_import_name(m.shortcode)),
           m.total
      FROM matched m
     ORDER BY CASE WHEN v_sort = 'name' THEN lower(m.shortcode) END ASC NULLS LAST,
              CASE WHEN v_sort = 'usage' THEN m.usage_count END DESC NULLS LAST,
              CASE WHEN v_sort = 'oldest' THEN m.first_seen_at END ASC NULLS LAST,
              m.first_seen_at DESC NULLS LAST, m.id DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_remote_emoji_sources()
RETURNS TABLE(domain text, emoji_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT lower(c.origin_domain), count(*)
      FROM public.remote_emojis_cache c
     WHERE c.imported_as IS NULL
       AND NULLIF(btrim(c.origin_domain), '') IS NOT NULL
     GROUP BY lower(c.origin_domain)
     ORDER BY count(*) DESC, lower(c.origin_domain)
     LIMIT 500;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_preview_emoji_imports(p_ids uuid[])
RETURNS TABLE(id uuid, name text, taken boolean, suggested text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id uuid;
    v_seen uuid[] := '{}';
    v_claimed text[] := '{}';
    v_shortcode text;
    v_base text;
    v_free text;
    v_n integer;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;

    FOR v_id IN
        SELECT u.id FROM unnest((COALESCE(p_ids, '{}'::uuid[]))[1:200]) WITH ORDINALITY AS u(id, n) ORDER BY u.n
    LOOP
        CONTINUE WHEN v_id IS NULL OR v_id = ANY (v_seen);
        v_seen := v_seen || v_id;

        SELECT c.shortcode INTO v_shortcode
          FROM public.remote_emojis_cache c
         WHERE c.id = v_id AND c.imported_as IS NULL;
        CONTINUE WHEN NOT FOUND;

        v_base := public.instance_emoji_import_name(v_shortcode);
        v_free := v_base;
        v_n := 0;
        WHILE public.instance_emoji_name_held(v_free) OR lower(v_free) = ANY (v_claimed) LOOP
            v_n := v_n + 1;
            v_free := v_base || '_' || v_n;
        END LOOP;
        v_claimed := v_claimed || lower(v_free);

        id := v_id;
        name := v_base;
        taken := v_n > 0;
        suggested := v_free;
        RETURN NEXT;
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- admin_list_emojis with licence and origin
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.admin_list_emojis(text, text, text, text, integer, integer);

-- p_kind all | instance | imported | federated | server | personal | ai | not_imported;
-- p_status active | removed | all (ignored for not_imported); p_sort newest | oldest | name |
-- usage. not_imported rows are remote_emojis_cache rows with imported_as NULL: id is the cache
-- id, domain its origin, created_at its first sighting, usage_count its sightings. hotlinked:
-- an instance or imported emoji whose url is not an object of bucket emojis.
CREATE FUNCTION public.admin_list_emojis(
    p_search text DEFAULT NULL,
    p_kind text DEFAULT 'all',
    p_status text DEFAULT 'active',
    p_sort text DEFAULT 'newest',
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0)
RETURNS TABLE(id uuid, kind text, name text, url text, domain text, scope text, server_id uuid,
              server_name text, uploader uuid, uploader_username text, created_at timestamptz,
              usage_count integer, reaction_count bigint, deleted_at timestamptz,
              deleted_by_username text, imported_from text, hotlinked boolean,
              is_ai_generated boolean, total_count bigint, license text, source_domain text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_search text := lower(NULLIF(btrim(p_search), ''));
    v_kind text := COALESCE(p_kind, 'all');
    v_status text := COALESCE(p_status, 'active');
    v_sort text := COALESCE(p_sort, 'newest');
    v_limit integer := GREATEST(1, LEAST(COALESCE(p_limit, 50), 200));
    v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    IF v_kind NOT IN ('all', 'instance', 'imported', 'federated', 'server', 'personal', 'ai', 'not_imported') THEN
        RAISE EXCEPTION 'Unknown kind: %', v_kind USING ERRCODE = '22023';
    END IF;
    IF v_status NOT IN ('active', 'removed', 'all') THEN
        RAISE EXCEPTION 'Unknown status: %', v_status USING ERRCODE = '22023';
    END IF;
    IF v_sort NOT IN ('newest', 'oldest', 'name', 'usage') THEN
        RAISE EXCEPTION 'Unknown sort: %', v_sort USING ERRCODE = '22023';
    END IF;

    IF v_kind = 'not_imported' THEN
        RETURN QUERY
        WITH matched AS (
            SELECT c.*, count(*) OVER () AS total
              FROM public.remote_emojis_cache c
             WHERE c.imported_as IS NULL
               AND (v_search IS NULL
                    OR strpos(lower(c.shortcode), v_search) > 0
                    OR strpos(lower(c.origin_domain), v_search) > 0)
             ORDER BY CASE WHEN v_sort = 'name' THEN lower(c.shortcode) END ASC NULLS LAST,
                      CASE WHEN v_sort = 'usage' THEN c.usage_count END DESC NULLS LAST,
                      CASE WHEN v_sort = 'oldest' THEN c.first_seen_at END ASC NULLS LAST,
                      c.first_seen_at DESC NULLS LAST, c.id DESC
             LIMIT v_limit OFFSET v_offset
        )
        SELECT m.id, 'not_imported'::text, m.shortcode, COALESCE(m.static_url, m.url), lower(m.origin_domain),
               NULL::text, NULL::uuid, NULL::text, NULL::uuid, NULL::text, m.first_seen_at,
               COALESCE(m.usage_count, 0), 0::bigint, NULL::timestamptz, NULL::text, m.url, false,
               false, m.total, m.license, NULL::text
          FROM matched m
         ORDER BY CASE WHEN v_sort = 'name' THEN lower(m.shortcode) END ASC NULLS LAST,
                  CASE WHEN v_sort = 'usage' THEN m.usage_count END DESC NULLS LAST,
                  CASE WHEN v_sort = 'oldest' THEN m.first_seen_at END ASC NULLS LAST,
                  m.first_seen_at DESC NULLS LAST, m.id DESC;
        RETURN;
    END IF;

    RETURN QUERY
    WITH typed AS (
        SELECT e.*, public.emoji_kind(e) AS e_kind
          FROM public.emojis e
         WHERE (v_status = 'all'
                OR (v_status = 'active' AND e.deleted_at IS NULL)
                OR (v_status = 'removed' AND e.deleted_at IS NOT NULL))
    ), matched AS (
        SELECT t.*, s.name::text AS s_name, p.username::text AS owner_username,
               d.username::text AS remover_username, count(*) OVER () AS total
          FROM typed t
          LEFT JOIN public.servers s ON s.id = t.server_id
          LEFT JOIN public.profiles p ON p.id = t.uploader
          LEFT JOIN public.profiles d ON d.id = t.deleted_by
         WHERE (v_kind = 'all' OR t.e_kind = v_kind)
           AND (v_search IS NULL
                OR strpos(lower(t.name::text), v_search) > 0
                OR strpos(lower(COALESCE(t.domain, '')), v_search) > 0
                OR strpos(lower(COALESCE(t.source_domain, '')), v_search) > 0
                OR strpos(lower(COALESCE(s.name::text, '')), v_search) > 0
                OR strpos(lower(COALESCE(p.username::text, '')), v_search) > 0)
         ORDER BY CASE WHEN v_sort = 'name' THEN lower(t.name::text) END ASC NULLS LAST,
                  CASE WHEN v_sort = 'usage' THEN COALESCE(t.usage_count, 0) END DESC NULLS LAST,
                  CASE WHEN v_sort = 'oldest' THEN t.created_at END ASC NULLS LAST,
                  t.created_at DESC, t.id DESC
         LIMIT v_limit OFFSET v_offset
    )
    SELECT m.id, m.e_kind, m.name::text, m.url::text, m.domain, m.scope, m.server_id, m.s_name,
           m.uploader, m.owner_username, m.created_at, COALESCE(m.usage_count, 0),
           (SELECT count(*) FROM public.reactions r WHERE r.emoji_id = m.id),
           m.deleted_at, m.remover_username, m.imported_from,
           m.e_kind IN ('instance', 'imported') AND public.emoji_object_path(m.url) IS NULL,
           m.is_ai_generated, m.total, m.license, m.source_domain
      FROM matched m
     ORDER BY CASE WHEN v_sort = 'name' THEN lower(m.name::text) END ASC NULLS LAST,
              CASE WHEN v_sort = 'usage' THEN COALESCE(m.usage_count, 0) END DESC NULLS LAST,
              CASE WHEN v_sort = 'oldest' THEN m.created_at END ASC NULLS LAST,
              m.created_at DESC, m.id DESC;
END;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION public.upsert_remote_emoji(text, text, text, text, text, text, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_remote_emoji(text, text, text, text, text, text, boolean, text) TO service_role;

REVOKE ALL ON FUNCTION public.instance_emoji_import_name(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.instance_emoji_import_name(text) TO service_role;
REVOKE ALL ON FUNCTION public.instance_emoji_name_held(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.instance_emoji_name_held(text) TO service_role;

REVOKE ALL ON FUNCTION public.import_remote_emoji(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_remote_emoji(uuid, text, text, text, uuid) TO service_role;

REVOKE ALL ON FUNCTION public.admin_list_remote_emojis(text, text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_remote_emojis(text, text, text, integer, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_remote_emoji_sources() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_remote_emoji_sources() TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_preview_emoji_imports(uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_preview_emoji_imports(uuid[]) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_list_emojis(text, text, text, text, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_emojis(text, text, text, text, integer, integer) TO authenticated, service_role;

-- Prod definers have mixed owners, postgres and supabase_admin. A definer runs as its owner, and a
-- non-superuser owner has no EXECUTE on a helper with PUBLIC revoked.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT DISTINCT h.helper, pg_get_userbyid(p.proowner) AS owner
          FROM (VALUES
                  ('instance_emoji_import_name(text)',
                   ARRAY['import_remote_emoji', 'admin_list_remote_emojis', 'admin_preview_emoji_imports']),
                  ('instance_emoji_name_held(text)',
                   ARRAY['import_remote_emoji', 'admin_list_remote_emojis', 'admin_preview_emoji_imports']),
                  ('emoji_kind(public.emojis)', ARRAY['admin_list_emojis']),
                  ('emoji_object_path(text)', ARRAY['admin_list_emojis']),
                  ('instance_emoji_object_ok(text, text)', ARRAY['import_remote_emoji'])
               ) AS h(helper, callers)
          JOIN pg_proc p ON p.proname = ANY (h.callers) AND p.pronamespace = 'public'::regnamespace
    LOOP
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO %I', r.helper, r.owner);
    END LOOP;
END
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
