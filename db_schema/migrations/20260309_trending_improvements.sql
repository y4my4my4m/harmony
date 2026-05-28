-- =============================================================================
-- Migration: Trending Improvements
-- =============================================================================
-- Improves get_trending_hashtags to include change_percent and trend direction
-- by comparing current period vs previous period. Also schedules
-- update_trending_posts() if pg_cron is available.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Replace get_trending_hashtags with historical comparison
-- Must DROP first because we're changing the return type (adding columns).
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_trending_hashtags(integer, integer);

CREATE OR REPLACE FUNCTION public.get_trending_hashtags(
    p_days integer DEFAULT 7,
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
    v_current_start := NOW() - (p_days || ' days')::INTERVAL;
    v_previous_start := NOW() - (p_days * 2 || ' days')::INTERVAL;

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

-- ---------------------------------------------------------------------------
-- Try to schedule pg_cron jobs for trending updates (graceful fallback)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    -- Schedule update_trending_posts every 15 minutes
    PERFORM cron.schedule(
        'update-trending-posts',
        '*/15 * * * *',
        'SELECT public.update_trending_posts()'
    );

    -- Schedule update_hashtag_trending_scores every hour
    PERFORM cron.schedule(
        'update-hashtag-scores',
        '0 * * * *',
        'SELECT public.update_hashtag_trending_scores()'
    );

    -- Schedule reset_daily_hashtag_counters daily at midnight
    PERFORM cron.schedule(
        'reset-daily-hashtag-counters',
        '0 0 * * *',
        'SELECT public.reset_daily_hashtag_counters()'
    );

    RAISE NOTICE 'pg_cron jobs scheduled for trending updates';
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron not available - trending updates must be triggered manually or via external scheduler. Error: %', SQLERRM;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
