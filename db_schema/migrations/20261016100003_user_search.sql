-- User search on trigram indexes.
--
-- search_local_users returns the accounts drive_share_file accepts as a user target, less
-- suspended and deleted ones and the caller. It matches a prefix of the username or of any word
-- of the display name.
--
-- search_federated_users matches a substring of the username, the display name or
-- username@domain, excludes suspended accounts, and orders local first, then by username. Input
-- is LIKE-escaped and a leading @ dropped. The username@domain arm is split so every arm has an
-- index:
--   no @ in the query     username@domain contains q  <=>  domain contains q (or username does)
--   one @ (a@b)           username ends with a and domain starts with b
--   more than one @       no username@domain matches
--
-- pg_trgm lives in schema extensions (20260101000000_baseline.sql). Its GIN indexes serve
-- ILIKE '%q%' and ILIKE 'q%' on the plain column; trigrams are case-folded.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE INDEX IF NOT EXISTS idx_profiles_username_trgm
    ON public.profiles USING gin (username extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_profiles_display_name_trgm
    ON public.profiles USING gin (display_name extensions.gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_profiles_domain_trgm
    ON public.profiles USING gin (domain extensions.gin_trgm_ops);

CREATE OR REPLACE FUNCTION public.search_local_users(p_query text, p_limit integer DEFAULT 8)
RETURNS TABLE(id uuid, username text, display_name text, avatar_url text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_query text := btrim(regexp_replace(coalesce(p_query, ''), '^\s*@+', ''));
    v_like text;
    v_caller uuid := public.get_current_profile_id();
BEGIN
    IF v_query = '' THEN
        RETURN;
    END IF;
    v_like := replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_');

    RETURN QUERY
    SELECT p.id, p.username, p.display_name, p.avatar_url
      FROM public.profiles p
     WHERE (p.username ILIKE v_like || '%'
            OR p.display_name ILIKE v_like || '%'
            OR p.display_name ILIKE '% ' || v_like || '%')
       AND p.is_local IS NOT FALSE
       AND p.auth_user_id IS NOT NULL
       AND p.is_suspended IS NOT TRUE
       AND p.deleted_at IS NULL
       AND p.id IS DISTINCT FROM v_caller
     ORDER BY lower(p.username) = lower(v_query) DESC,
              p.username ILIKE v_like || '%' DESC,
              p.display_name ILIKE v_like || '%' DESC,
              lower(p.username)
     LIMIT least(greatest(coalesce(p_limit, 8), 1), 20);
END;
$$;

REVOKE ALL ON FUNCTION public.search_local_users(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_local_users(text, integer) TO authenticated, service_role;

COMMENT ON FUNCTION public.search_local_users(text, integer) IS
    'Accounts of this instance a Drive file can be shared with, by username or display-name word prefix; caller excluded; at most 20.';

CREATE OR REPLACE FUNCTION public.search_federated_users(p_query text, p_limit integer DEFAULT 10)
RETURNS TABLE(user_id uuid, username text, display_name text, domain text, avatar_url text, handle text, is_local boolean)
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_query text := btrim(regexp_replace(coalesce(p_query, ''), '^\s*@+', ''));
    v_ats integer;
    v_like text;
    v_user text;
    v_domain text;
BEGIN
    IF v_query = '' THEN
        RETURN;
    END IF;
    v_ats := char_length(v_query) - char_length(replace(v_query, '@', ''));
    v_like := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    IF v_ats = 1 THEN
        v_user := '%' || replace(replace(replace(split_part(v_query, '@', 1), '\', '\\'), '%', '\%'), '_', '\_');
        v_domain := replace(replace(replace(split_part(v_query, '@', 2), '\', '\\'), '%', '\%'), '_', '\_') || '%';
    END IF;

    RETURN QUERY
    SELECT p.id, p.username, p.display_name, p.domain, p.avatar_url,
           p.username || '@' || p.domain, p.is_local
      FROM public.profiles p
     WHERE (p.username ILIKE v_like
            OR p.display_name ILIKE v_like
            OR (v_ats = 0 AND p.domain ILIKE v_like)
            OR (v_ats = 1 AND p.username ILIKE v_user AND p.domain ILIKE v_domain))
       AND p.is_suspended = false
     ORDER BY CASE WHEN p.is_local THEN 0 ELSE 1 END, p.username
     LIMIT least(greatest(coalesce(p_limit, 10), 1), 50);
END;
$$;

COMMIT;
