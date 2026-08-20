-- =============================================================================
-- get_home_timeline_page: single-round-trip home feed load
-- =============================================================================
-- The home feed previously cost 2 sequential PostgREST round trips: a follows
-- query, then a posts query with the ENTIRE follow list inlined into the URL
-- via .in('author_id', [...]) - which also degrades as the follow count grows
-- and eventually hits URL length limits. This function does the follows join
-- server-side and returns the page in ONE round trip.
--
-- Semantics replicate the client's getUserTimeline('home') exactly:
--   * posts authored by accepted OR pending follows, plus the user's own
--     (pending follows still show public posts - they're public anyway)
--   * no visibility filter beyond posts RLS (SECURITY INVOKER)
--   * is_deleted IS NULL OR false
--   * newest-first, cursor = created_at < p_before
--
-- Each row is the full posts row plus:
--   author           - profile jsonb in POST_AUTHOR_EMBED shape (includes
--                      supporter_membership array with tier)
--   my_interactions  - [{interaction_type, emoji_id}] for the calling user
-- so the client's existing row mapping applies unchanged.
--
-- Caller resolved server-side via get_current_profile_id() - no user-id
-- parameter (avoids the recurring auth-UUID vs profiles.id confusion).

BEGIN;

CREATE OR REPLACE FUNCTION public.get_home_timeline_page(
    p_limit integer DEFAULT 20,
    p_before timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
WITH me AS (
    SELECT public.get_current_profile_id() AS id
),
authors AS (
    SELECT f.following_id AS author_id
    FROM public.follows f
    WHERE f.follower_id = (SELECT id FROM me)
      AND f.status IN ('accepted', 'pending')
    UNION
    SELECT (SELECT id FROM me)
),
page AS (
    SELECT p.*
    FROM public.posts p
    WHERE p.author_id IN (SELECT author_id FROM authors)
      AND (p.is_deleted IS NULL OR p.is_deleted = false)
      AND (p_before IS NULL OR p.created_at < p_before)
    ORDER BY p.created_at DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)
)
SELECT COALESCE(
    jsonb_agg(
        to_jsonb(page.*) || jsonb_build_object(
            'author', a.author,
            'my_interactions', COALESCE(i.my_interactions, '[]'::jsonb)
        )
        ORDER BY page.created_at DESC
    ),
    '[]'::jsonb
)
FROM page
LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
        'id', pr.id,
        'username', pr.username,
        'display_name', pr.display_name,
        'avatar_url', pr.avatar_url,
        'color', pr.color,
        'domain', pr.domain,
        'is_local', pr.is_local,
        'is_suspended', pr.is_suspended,
        'supporter_membership', COALESCE((
            SELECT jsonb_agg(
                jsonb_build_object(
                    'is_active', s.is_active,
                    'tier', CASE WHEN t.id IS NULL THEN NULL ELSE
                        jsonb_build_object(
                            'name', t.name,
                            'badge_icon', t.badge_icon,
                            'badge_color', t.badge_color
                        ) END
                )
            )
            FROM public.instance_supporters s
            LEFT JOIN public.instance_supporter_tiers t ON t.id = s.tier_id
            WHERE s.user_id = pr.id
        ), '[]'::jsonb)
    ) AS author
    FROM public.profiles pr
    WHERE pr.id = page.author_id
) a ON true
LEFT JOIN LATERAL (
    SELECT jsonb_agg(
        jsonb_build_object(
            'interaction_type', pi.interaction_type,
            'emoji_id', pi.emoji_id
        )
    ) AS my_interactions
    FROM public.post_interactions pi
    WHERE pi.post_id = page.id
      AND pi.user_id = (SELECT id FROM me)
) i ON true
$$;

COMMENT ON FUNCTION public.get_home_timeline_page(integer, timestamptz) IS
'Single round-trip home feed: posts from accepted/pending follows + own posts, with author embed and caller interaction states. Caller resolved via get_current_profile_id(). SECURITY INVOKER so posts RLS applies.';

GRANT EXECUTE ON FUNCTION public.get_home_timeline_page(integer, timestamptz) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
