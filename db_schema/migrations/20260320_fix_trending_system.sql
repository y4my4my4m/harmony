-- =============================================================================
-- Migration: Fix trending system
-- =============================================================================
-- 1. Fix update_hashtag_trending_scores to actually compute trending_score,
--    trending_rank, and last_trending_update on the hashtags table.
-- 2. Fix update_trending_posts to exclude deleted posts.
-- 3. Add missing archive_popular_hashtags, cleanup_inactive_hashtags, and
--    run_trending_maintenance functions.
-- 4. Ensure pg_cron jobs are scheduled.
-- 5. Run update_trending_posts once immediately to seed data.
-- =============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Fix update_hashtag_trending_scores
-- ---------------------------------------------------------------------------

DROP FUNCTION update_hashtag_trending_scores();
CREATE OR REPLACE FUNCTION public.update_hashtag_trending_scores()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    updated_count INTEGER := 0;
BEGIN
    UPDATE public.hashtags
    SET 
        weekly_uses = COALESCE(weekly_uses, 0) + COALESCE(daily_uses, 0),
        updated_at = NOW()
    WHERE daily_uses > 0;

    UPDATE public.hashtags
    SET 
        trending_score = (COALESCE(daily_uses, 0) * 3.0 + COALESCE(weekly_uses, 0) * 0.5 + COALESCE(total_uses, 0) * 0.05),
        last_trending_update = NOW(),
        updated_at = NOW()
    WHERE COALESCE(daily_uses, 0) > 0 OR COALESCE(weekly_uses, 0) > 0;

    GET DIAGNOSTICS updated_count = ROW_COUNT;

    WITH ranked AS (
        SELECT id, ROW_NUMBER() OVER (ORDER BY trending_score DESC) AS rn
        FROM public.hashtags
        WHERE trending_score > 0
    )
    UPDATE public.hashtags h
    SET trending_rank = ranked.rn
    FROM ranked
    WHERE h.id = ranked.id;

    RAISE NOTICE 'Hashtag trending scores updated: % hashtags', updated_count;
    RETURN updated_count;
EXCEPTION WHEN undefined_column THEN
    RAISE NOTICE 'trending columns do not exist, skipping update';
    RETURN 0;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Fix update_trending_posts (exclude deleted)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_trending_posts()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_now timestamptz := NOW();
    v_period_start timestamptz := date_trunc('day', NOW());
    v_period_end timestamptz := v_period_start + INTERVAL '1 day';
BEGIN
    DELETE FROM public.trending_posts 
    WHERE period_start = v_period_start AND period_type = 'daily';
    
    INSERT INTO public.trending_posts (
        post_id, trending_score, engagement_score, velocity_score,
        period_type, period_start, period_end,
        likes_count, reblogs_count, replies_count
    )
    SELECT 
        p.id,
        (COALESCE(p.favorites_count, 0) + COALESCE(p.reblogs_count, 0) * 2 + COALESCE(p.replies_count, 0) * 1.5) 
        * (1.0 / (EXTRACT(EPOCH FROM (v_now - p.created_at)) / 3600 + 1)) as trending_score,
        (COALESCE(p.favorites_count, 0) + COALESCE(p.reblogs_count, 0) + COALESCE(p.replies_count, 0))::numeric,
        CASE 
            WHEN p.created_at > v_now - INTERVAL '1 hour' THEN 10.0
            WHEN p.created_at > v_now - INTERVAL '6 hours' THEN 5.0
            ELSE 1.0
        END::numeric,
        'daily'::text,
        v_period_start,
        v_period_end,
        COALESCE(p.favorites_count, 0),
        COALESCE(p.reblogs_count, 0),
        COALESCE(p.replies_count, 0)
    FROM posts p
    WHERE p.created_at > v_now - INTERVAL '48 hours'
        AND p.visibility IN ('public', 'unlisted')
        AND (p.is_deleted IS NULL OR p.is_deleted = false)
    ORDER BY trending_score DESC
    LIMIT 100;
    
    RAISE NOTICE 'Trending posts updated';
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'trending_posts table does not exist, skipping update';
WHEN undefined_column THEN
    RAISE NOTICE 'Required columns do not exist, skipping update';
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Add missing maintenance functions
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.archive_popular_hashtags()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    archived_count INTEGER := 0;
BEGIN
    UPDATE public.hashtags
    SET 
        peak_daily_uses = GREATEST(COALESCE(peak_daily_uses, 0), COALESCE(daily_uses, 0)),
        peak_daily_date = CASE 
            WHEN COALESCE(daily_uses, 0) > COALESCE(peak_daily_uses, 0) THEN CURRENT_DATE
            ELSE peak_daily_date
        END,
        updated_at = NOW()
    WHERE daily_uses > 0;

    GET DIAGNOSTICS archived_count = ROW_COUNT;
    RETURN archived_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.cleanup_inactive_hashtags()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    cleaned_count INTEGER := 0;
BEGIN
    DELETE FROM public.hashtags
    WHERE last_used_at < NOW() - INTERVAL '90 days'
      AND COALESCE(total_uses, 0) < 3;

    GET DIAGNOSTICS cleaned_count = ROW_COUNT;
    RETURN cleaned_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.run_trending_maintenance()
RETURNS json
LANGUAGE plpgsql
AS $$
DECLARE
    result JSON;
    hashtags_cleaned INTEGER;
    trending_cleaned INTEGER;
    hashtags_archived INTEGER;
    scores_updated INTEGER;
BEGIN
    hashtags_archived := archive_popular_hashtags();
    hashtags_cleaned := cleanup_inactive_hashtags();
    trending_cleaned := cleanup_old_trending_data();
    scores_updated := update_hashtag_trending_scores();
    PERFORM update_trending_posts();
    
    result := json_build_object(
        'maintenance_completed_at', NOW(),
        'hashtags_archived', hashtags_archived,
        'hashtags_cleaned', hashtags_cleaned,
        'trending_data_cleaned', trending_cleaned,
        'trending_scores_updated', scores_updated,
        'status', 'success'
    );
    
    RAISE NOTICE 'Trending system maintenance completed: %', result;
    RETURN result;
END;
$$;

COMMENT ON FUNCTION public.run_trending_maintenance IS 'Comprehensive maintenance function that runs all cleanup and update operations';

-- ---------------------------------------------------------------------------
-- 4. Schedule pg_cron jobs (idempotent)
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    BEGIN PERFORM cron.unschedule('update-trending-posts'); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN PERFORM cron.unschedule('update-hashtag-scores'); EXCEPTION WHEN OTHERS THEN NULL; END;
    BEGIN PERFORM cron.unschedule('reset-daily-hashtag-counters'); EXCEPTION WHEN OTHERS THEN NULL; END;

    PERFORM cron.schedule(
      'update-trending-posts',
      '*/15 * * * *',
      'SELECT public.update_trending_posts()'
    );
    PERFORM cron.schedule(
      'update-hashtag-scores',
      '0 * * * *',
      'SELECT public.update_hashtag_trending_scores()'
    );
    PERFORM cron.schedule(
      'reset-daily-hashtag-counters',
      '0 0 * * *',
      'SELECT public.reset_daily_hashtag_counters()'
    );

    RAISE NOTICE 'pg_cron jobs scheduled for trending updates';
  ELSE
    RAISE NOTICE 'pg_cron not available - run update_trending_posts() manually or via external scheduler';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. Seed trending data immediately
-- ---------------------------------------------------------------------------
SELECT public.update_trending_posts();
SELECT public.update_hashtag_trending_scores();

NOTIFY pgrst, 'reload schema';

COMMIT;
