-- =============================================================================
-- Migration: Trending hashtags honor an hours-based time window
-- =============================================================================
-- The explore "Trending" tab exposes a time filter (1h / 6h / 24h / 7d / 30d).
-- Previously get_trending_hashtags only accepted whole days, so 1h/6h/24h all
-- collapsed to a single day and the time filter did nothing for hashtags.
--
-- This replaces the function with an hours-based window (previous-period
-- comparison preserved for rising/falling trend). Param rename (p_days ->
-- p_hours) forces a DROP, so we re-grant afterwards.
-- =============================================================================

BEGIN;

DROP FUNCTION IF EXISTS public.get_trending_hashtags(integer, integer);

CREATE OR REPLACE FUNCTION public.get_trending_hashtags(
    p_hours integer DEFAULT 168,
    p_limit integer DEFAULT 20
)
RETURNS TABLE(
    tag text,
    uses_count bigint,
    unique_users bigint,
    change_percent numeric,
    trend text
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    v_current_start timestamptz;
    v_previous_start timestamptz;
BEGIN
    v_current_start := NOW() - (p_hours || ' hours')::INTERVAL;
    v_previous_start := NOW() - (p_hours * 2 || ' hours')::INTERVAL;

    RETURN QUERY
    WITH current_period AS (
        SELECT
            h.tag AS htag,
            COUNT(*) AS current_uses,
            COUNT(DISTINCT p.author_id) AS current_unique_users
        FROM post_hashtags ph
        JOIN hashtags h ON ph.hashtag_id = h.id
        JOIN posts p ON ph.post_id = p.id
        WHERE ph.created_at > v_current_start
        GROUP BY h.tag
    ),
    previous_period AS (
        SELECT
            h.tag AS htag,
            COUNT(*) AS previous_uses
        FROM post_hashtags ph
        JOIN hashtags h ON ph.hashtag_id = h.id
        JOIN posts p ON ph.post_id = p.id
        WHERE ph.created_at > v_previous_start
          AND ph.created_at <= v_current_start
        GROUP BY h.tag
    )
    SELECT
        cp.htag AS tag,
        cp.current_uses AS uses_count,
        cp.current_unique_users AS unique_users,
        CASE
            WHEN COALESCE(pp.previous_uses, 0) = 0 THEN
                CASE WHEN cp.current_uses > 0 THEN 100.0 ELSE 0.0 END
            ELSE
                ROUND(((cp.current_uses::numeric - pp.previous_uses::numeric) / pp.previous_uses::numeric) * 100, 1)
        END AS change_percent,
        CASE
            WHEN COALESCE(pp.previous_uses, 0) = 0 AND cp.current_uses > 0 THEN 'rising'
            WHEN cp.current_uses > COALESCE(pp.previous_uses, 0) * 1.05 THEN 'rising'
            WHEN cp.current_uses < COALESCE(pp.previous_uses, 0) * 0.95 THEN 'falling'
            ELSE 'stable'
        END AS trend
    FROM current_period cp
    LEFT JOIN previous_period pp ON cp.htag = pp.htag
    ORDER BY cp.current_uses DESC
    LIMIT p_limit;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_trending_hashtags(integer, integer) TO authenticated, anon;

NOTIFY pgrst, 'reload schema';

COMMIT;
