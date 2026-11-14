-- A new local server's slug skips the slugs of every local server, including private ones its
-- creator cannot read.
--
--   assign_server_slug, generate_unique_server_slug
--       definer. As invoker, the free-slug loop read servers under the creator's RLS: a private
--       server holding the name's slug (servers_select_public, servers_select_member) was
--       invisible, the loop returned that slug, and the insert failed on idx_servers_slug_local.
--       A name whose only Latin letters spell another private server's slug ("めじたぐharmony支部"
--       and a private "Harmony") could not be created.
--       Concurrent creates of one base slug take a transaction lock on it, so the second reads the
--       first's row before choosing.
--   generate_unique_server_slug is no longer granted to clients: as definer it would tell any
--       caller whether a private server holds a slug.
BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.generate_unique_server_slug(p_name text, p_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    base text;
    candidate text;
    n integer := 0;
BEGIN
    base := left(coalesce(public.slugify_server_name(p_name), left(p_id::text, 8)), 60);
    PERFORM pg_advisory_xact_lock(hashtextextended('server_slug:' || lower(base), 0));
    candidate := base;
    WHILE EXISTS (
        SELECT 1 FROM public.servers s
        WHERE s.is_local_server = true
          AND lower(s.slug) = lower(candidate)
          AND s.id <> p_id
    ) LOOP
        n := n + 1;
        candidate := base || '-' || n;
    END LOOP;
    RETURN candidate;
END;
$$;

REVOKE ALL ON FUNCTION public.generate_unique_server_slug(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_unique_server_slug(text, uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.assign_server_slug()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.is_local_server IS DISTINCT FROM true THEN
        RETURN NEW; -- remote servers keep NULL
    END IF;
    IF NEW.slug IS NOT NULL AND NEW.slug <> '' THEN
        RETURN NEW; -- explicit slug respected (format enforced by constraint)
    END IF;
    NEW.slug := public.generate_unique_server_slug(NEW.name, NEW.id);
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.assign_server_slug() FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
