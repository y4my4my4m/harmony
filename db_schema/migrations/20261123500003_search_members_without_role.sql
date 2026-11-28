-- Roles -> Add member lists the members a role lacks, however many hold it.
--
-- The client asked search_server_members for 30 matches and dropped the role's members, so a role
-- holding the first 30 matches listed no one. search_server_members takes p_without_role and leaves
-- its members out before the limit. NULL, the default, leaves out no one: the three-argument call
-- answers as before. A role of another server leaves out no one. The three-argument function is
-- dropped, not overloaded: PostgREST answers PGRST203 to a call two overloads match.
-- Body otherwise, volatility, owner and grants as 20261113100001_member_directory.sql.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

DROP FUNCTION IF EXISTS public.search_server_members(uuid, text, integer);

CREATE OR REPLACE FUNCTION public.search_server_members(
    p_server_id uuid,
    p_query text,
    p_limit integer DEFAULT 20,
    p_without_role uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me     uuid := public.server_member_reader(p_server_id);
    v_limit  integer := least(greatest(COALESCE(p_limit, 20), 1), 50);
    v_like   text := public.member_search_pattern(p_query);
    v_needle text := lower(left(btrim(COALESCE(p_query, '')), 64));
    v_result jsonb;
BEGIN
    IF v_like IS NULL THEN
        RETURN '[]'::jsonb;
    END IF;

    WITH found AS (
        SELECT m.*,
               CASE WHEN lower(m.username) = v_needle OR m.sort_name = v_needle THEN 0
                    WHEN starts_with(lower(m.username), v_needle) OR starts_with(m.sort_name, v_needle) THEN 1
                    ELSE 2 END AS match_rank
          FROM public.server_member_presence(p_server_id, v_me, v_like) m
         WHERE p_without_role IS NULL
            OR NOT EXISTS (SELECT 1 FROM public.user_roles ur
                            WHERE ur.server_id = p_server_id
                              AND ur.role_id = p_without_role
                              AND ur.user_id = m.id)
    ),
    page AS (
        SELECT f.*, row_number() OVER (ORDER BY f.match_rank, f.sort_name COLLATE public.member_name, f.username, f.id) AS ord
          FROM found f
         ORDER BY f.match_rank, f.sort_name COLLATE public.member_name, f.username, f.id
         LIMIT v_limit
    )
    SELECT COALESCE(jsonb_agg(public.server_member_json(pr, p_server_id, NULL, pg.present, pg.pstatus, pg.mobile)
                              ORDER BY pg.ord), '[]'::jsonb)
      INTO v_result
      FROM page pg
      JOIN public.profiles pr ON pr.id = pg.id;
    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.search_server_members(uuid, text, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_server_members(uuid, text, integer, uuid) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
