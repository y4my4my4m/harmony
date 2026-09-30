-- user_servers_select_co_members and posts_select_public call a SECURITY DEFINER helper with a
-- per-row argument: current_user_is_member_of_server(server_id) once per membership row,
-- is_blocked_by(author_id) and has_blocked(author_id) once per scanned post. Each call is its
-- own index probe on user_servers or user_blocks. The caller's server set and block set are
-- instead computed once per query and tested as a hashed subplan.
--
-- Visibility is unchanged:
--   current_user_server_ids() returns every user_servers row of the caller, any status: the
--   rows current_user_is_member_of_server() tests for. A pending or banned row still exposes
--   that server's member list.
--   current_user_block_peer_ids() returns both block directions and ignores block_type and
--   expires_at, as is_blocked_by() and has_blocked() do.
--   With no profile behind auth.uid() (anon, or a JWT whose user has no profile) both sets are
--   empty, where the old helpers returned false.
--
-- NOT IN is sound here: user_servers.server_id, user_blocks.blocker_id,
-- user_blocks.blocked_user_id and posts.author_id are all NOT NULL.
--
-- Seeded local DB (2.3M messages, 1M posts, 5,000-member server; supabase/postgres
-- 15.8.1.060), EXPLAIN (ANALYZE, TIMING OFF) as authenticated, best of warm runs:
--   member list of the 5,000-member server      101 ms -> 0.59 ms
--   get_home_timeline_page(20, NULL)            311 ms -> 7.3 ms
--   count(*) over posts, 1M rows scanned        40.5 s -> 131 ms
-- Rows visible to 8 actors (anon, a JWT with no profile, blockers in both directions, banned
-- and pending members) are identical under both predicates on that dataset.
--
-- current_user_is_member_of_server() and has_blocked() remain as RPCs; no policy references
-- them after this migration.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.current_user_server_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    SELECT us.server_id
      FROM public.user_servers us
     WHERE us.user_id = (SELECT public.get_current_profile_id());
$$;

-- user_servers_select_co_members is TO authenticated.
REVOKE ALL ON FUNCTION public.current_user_server_ids() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.current_user_server_ids() TO authenticated;

CREATE OR REPLACE FUNCTION public.current_user_block_peer_ids()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    SELECT b.blocked_user_id
      FROM public.user_blocks b
     WHERE b.blocker_id = (SELECT public.get_current_profile_id())
    UNION
    SELECT b.blocker_id
      FROM public.user_blocks b
     WHERE b.blocked_user_id = (SELECT public.get_current_profile_id());
$$;

-- posts_select_public applies to every role, and a policy predicate executes as the querying
-- role: anon reading public posts needs EXECUTE.
REVOKE ALL ON FUNCTION public.current_user_block_peer_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_user_block_peer_ids() TO anon, authenticated;

ALTER POLICY "user_servers_select_co_members" ON public.user_servers
    USING (
        user_id = ( SELECT public.get_current_profile_id() )
        OR server_id IN ( SELECT public.current_user_server_ids() )
        OR ( SELECT public.is_current_user_admin() )
    );

ALTER POLICY "posts_select_public" ON public.posts
    USING (
        author_id = ( SELECT public.get_current_profile_id() )
        OR (
            author_id NOT IN ( SELECT public.current_user_block_peer_ids() )
            AND (
                visibility IN ('public', 'unlisted')
                OR (visibility = 'followers' AND EXISTS (
                    SELECT 1 FROM public.follows
                    WHERE follows.follower_id = ( SELECT public.get_current_profile_id() )
                      AND follows.following_id = posts.author_id
                      AND follows.status = 'accepted'
                ))
                OR (visibility = 'direct' AND EXISTS (
                    SELECT 1 WHERE posts.author_id = ( SELECT public.get_current_profile_id() )
                ))
            )
        )
    );

COMMIT;

NOTIFY pgrst, 'reload schema';
