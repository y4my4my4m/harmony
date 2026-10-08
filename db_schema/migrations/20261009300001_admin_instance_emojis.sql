-- Instance admins list, rename and delete instance-level emojis.
--
-- An instance-level emoji is a row with scope = 'instance' (create_federated_emoji, bot and
-- Discord bridge uploads, import_remote_emoji without a server), or a row with no server and
-- a scope other than 'user': federation-backend inserts reaction and post emojis with
-- server_id NULL, domain set and the default scope 'server'. No RLS policy lets a client
-- write the second kind, so writes go through these SECURITY DEFINER functions.
--
-- admin_list_instance_emojis(search, source, sort, limit, offset) pages that set.
--   search  case-insensitive substring of name or domain; NULL or blank matches all
--   source  'all' | 'local' (domain IS NULL) | 'remote' (domain IS NOT NULL)
--   sort    'newest' (created_at DESC) | 'name' (lower(name) ASC)
--   limit   clamped to 1..200
-- total_count is the match count before limit and offset, repeated on every row.
-- reaction_count counts reactions rows referencing the emoji; they cascade on delete.
--
-- admin_rename_instance_emoji(id, name). name is 2..64 of [A-Za-z0-9_-]. A second
-- instance-level emoji with the same lower(name) and domain is a 23505. Message content
-- carries :name: tokens resolved by name at render time; a rename leaves those tokens
-- unresolved.
--
-- admin_delete_instance_emoji(id) deletes the row. reactions and emoji_usage rows cascade,
-- post_interactions.emoji_id and remote_emojis_cache.imported_as go NULL (the remote emoji
-- becomes importable again). The storage object stays: federated copies of local posts
-- reference its URL.
--
-- A row outside the instance-level set raises P0002 from rename and delete.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.admin_list_instance_emojis(
    p_search text DEFAULT NULL,
    p_source text DEFAULT 'all',
    p_sort text DEFAULT 'newest',
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0)
RETURNS TABLE(
    id uuid,
    name text,
    url text,
    domain text,
    scope text,
    uploader uuid,
    uploader_username text,
    created_at timestamptz,
    usage_count integer,
    reaction_count bigint,
    total_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_search text := lower(NULLIF(btrim(p_search), ''));
    v_source text := COALESCE(p_source, 'all');
    v_sort text := COALESCE(p_sort, 'newest');
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    IF v_source NOT IN ('all', 'local', 'remote') THEN
        RAISE EXCEPTION 'Unknown source: %', v_source USING ERRCODE = '22023';
    END IF;
    IF v_sort NOT IN ('newest', 'name') THEN
        RAISE EXCEPTION 'Unknown sort: %', v_sort USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    WITH matched AS (
        SELECT e.*, count(*) OVER () AS total
          FROM public.emojis e
         WHERE (e.scope = 'instance' OR (e.server_id IS NULL AND e.scope <> 'user'))
           AND (v_source = 'all'
                OR (v_source = 'local' AND e.domain IS NULL)
                OR (v_source = 'remote' AND e.domain IS NOT NULL))
           AND (v_search IS NULL
                OR strpos(lower(e.name::text), v_search) > 0
                OR strpos(lower(COALESCE(e.domain, '')), v_search) > 0)
         ORDER BY CASE WHEN v_sort = 'name' THEN lower(e.name::text) END ASC NULLS LAST,
                  e.created_at DESC, e.id DESC
         LIMIT GREATEST(1, LEAST(COALESCE(p_limit, 50), 200))
        OFFSET GREATEST(COALESCE(p_offset, 0), 0)
    )
    SELECT m.id, m.name::text, m.url::text, m.domain, m.scope, m.uploader,
           p.username::text, m.created_at, COALESCE(m.usage_count, 0),
           (SELECT count(*) FROM public.reactions r WHERE r.emoji_id = m.id),
           m.total
      FROM matched m
      LEFT JOIN public.profiles p ON p.id = m.uploader
     ORDER BY CASE WHEN v_sort = 'name' THEN lower(m.name::text) END ASC NULLS LAST,
              m.created_at DESC, m.id DESC;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_rename_instance_emoji(p_emoji_id uuid, p_name text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_name text := btrim(p_name);
    v_domain text;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    IF v_name IS NULL OR v_name !~ '^[A-Za-z0-9_-]{2,64}$' THEN
        RAISE EXCEPTION 'Emoji names are 2 to 64 letters, digits, _ or -' USING ERRCODE = '22023';
    END IF;

    SELECT e.domain INTO v_domain
      FROM public.emojis e
     WHERE e.id = p_emoji_id
       AND (e.scope = 'instance' OR (e.server_id IS NULL AND e.scope <> 'user'))
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Not an instance emoji' USING ERRCODE = 'P0002';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.emojis e
         WHERE e.id <> p_emoji_id
           AND (e.scope = 'instance' OR (e.server_id IS NULL AND e.scope <> 'user'))
           AND lower(e.name::text) = lower(v_name)
           AND e.domain IS NOT DISTINCT FROM v_domain) THEN
        RAISE EXCEPTION 'An instance emoji named % exists', v_name USING ERRCODE = '23505';
    END IF;

    UPDATE public.emojis SET name = v_name, updated_at = now() WHERE id = p_emoji_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_instance_emoji(p_emoji_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;

    DELETE FROM public.emojis e
     WHERE e.id = p_emoji_id
       AND (e.scope = 'instance' OR (e.server_id IS NULL AND e.scope <> 'user'));
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Not an instance emoji' USING ERRCODE = 'P0002';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_list_instance_emojis(text, text, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_instance_emojis(text, text, text, integer, integer) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_rename_instance_emoji(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_rename_instance_emoji(uuid, text) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.admin_delete_instance_emoji(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_instance_emoji(uuid) TO authenticated, service_role;

COMMIT;
