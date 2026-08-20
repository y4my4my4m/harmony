-- =============================================================================
-- Migration: Admin batch count RPCs
-- =============================================================================
-- Adds RPCs to batch-fetch post counts and server counts for admin panel,
-- eliminating N+1 queries in getUsers, getUserServers, getPublicServersForAdmin.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- get_admin_user_counts: post_count and server_count for each user (batch)
-- Used by AdminPanel user list to avoid N+1 per-user queries.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_admin_user_counts(p_user_ids uuid[])
RETURNS TABLE(user_id uuid, post_count bigint, server_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH post_counts AS (
    SELECT author_id, COUNT(*)::bigint AS cnt
    FROM public.posts
    WHERE author_id = ANY(p_user_ids) AND is_deleted = false
    GROUP BY author_id
  ),
  server_counts AS (
    SELECT user_id, COUNT(*)::bigint AS cnt
    FROM public.user_servers
    WHERE user_id = ANY(p_user_ids)
    GROUP BY user_id
  )
  SELECT
    id AS user_id,
    COALESCE(pc.cnt, 0) AS post_count,
    COALESCE(sc.cnt, 0) AS server_count
  FROM unnest(p_user_ids) AS id
  LEFT JOIN post_counts pc ON pc.author_id = id
  LEFT JOIN server_counts sc ON sc.user_id = id;
$$;

-- ---------------------------------------------------------------------------
-- get_server_member_counts: member_count for each server (batch)
-- Used by getUserServers and getPublicServersForAdmin to avoid N+1.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_server_member_counts(p_server_ids uuid[])
RETURNS TABLE(server_id uuid, member_count bigint)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  WITH counts AS (
    SELECT server_id, COUNT(*)::bigint AS cnt
    FROM public.user_servers
    WHERE server_id = ANY(p_server_ids)
    GROUP BY server_id
  )
  SELECT id AS server_id, COALESCE(c.cnt, 0) AS member_count
  FROM unnest(p_server_ids) AS id
  LEFT JOIN counts c ON c.server_id = id;
$$;

GRANT EXECUTE ON FUNCTION public.get_admin_user_counts(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_server_member_counts(uuid[]) TO authenticated;

NOTIFY pgrst, 'reload schema';

COMMIT;
