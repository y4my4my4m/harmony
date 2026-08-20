-- Creates six functions the application calls that production does not have.
--
-- All six exist in init/ and on staging; production predates them and no migration ever
-- created them, so six .rpc() calls answer PGRST202 there. check-rpc-coverage.sh tests the
-- application against a fresh init/ build, where they are present, so it cannot see this.
--
-- Every column these bodies touch was verified present in the production dump first.
-- plpgsql resolves column references at first execution, not at CREATE, so a body naming a
-- missing column installs cleanly and raises 42703 on every call.
--
-- The five STABLE functions carry an explicit SET search_path that init/ does not spell
-- out: init/ pins them in 99_performance_hardening.sql, which runs earlier, and CREATE OR
-- REPLACE resets function attributes.
--
-- get_livekit_config, update_session_context, update_session_heartbeat and
-- promote_first_user_to_admin are also absent from production and deliberately not here:
-- the first reads a column production's instance_webrtc_settings lacks, and nothing calls
-- the others.

BEGIN;

CREATE OR REPLACE FUNCTION public.get_activitypub_conversation_context(post_id uuid)
RETURNS TABLE(
    ancestors jsonb,
    descendants jsonb
)
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        -- Get ancestors (posts this post replies to)
        COALESCE(
            (SELECT jsonb_agg(
                jsonb_build_object(
                    'id', p.id,
                    'content', p.content,
                    'author_id', p.author_id,
                    'created_at', p.created_at
                ) ORDER BY p.created_at ASC
            )
            FROM posts p
            WHERE p.id = (SELECT in_reply_to FROM posts WHERE id = get_activitypub_conversation_context.post_id)
            ), '[]'::jsonb
        ) as ancestors,
        -- Get descendants (replies to this post)
        COALESCE(
            (SELECT jsonb_agg(
                jsonb_build_object(
                    'id', p.id,
                    'content', p.content,
                    'author_id', p.author_id,
                    'created_at', p.created_at
                ) ORDER BY p.created_at ASC
            )
            FROM posts p
            WHERE p.in_reply_to = get_activitypub_conversation_context.post_id
            ), '[]'::jsonb
        ) as descendants;
END;
$$;

COMMENT ON FUNCTION public.get_activitypub_conversation_context IS 'Get conversation context (ancestors and descendants) for a post';

CREATE OR REPLACE FUNCTION public.get_activitypub_conversation_thread(in_conversation_root_id text)
RETURNS TABLE(
    id uuid,
    content jsonb,
    author_id uuid,
    created_at timestamptz,
    in_reply_to uuid,
    conversation_root_id uuid
)
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id,
        p.content,
        p.author_id,
        p.created_at,
        p.in_reply_to,
        p.conversation_root_id
    FROM posts p
    WHERE p.conversation_root_id::text = in_conversation_root_id
    ORDER BY p.created_at ASC;
END;
$$;

COMMENT ON FUNCTION public.get_activitypub_conversation_thread IS 'Get all posts in an ActivityPub conversation thread';

CREATE OR REPLACE FUNCTION public.get_emoji_usage_analytics(
    p_server_id uuid,
    p_user_id uuid DEFAULT NULL,
    p_limit integer DEFAULT 10
)
RETURNS TABLE(
    emoji_id uuid,
    emoji_name text,
    emoji_url text,
    usage_count bigint,
    last_used timestamptz
)
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.id as emoji_id,
        e.name::text as emoji_name,
        e.url::text as emoji_url,
        COUNT(eu.id)::bigint as usage_count,
        MAX(eu.used_at) as last_used
    FROM emojis e
    LEFT JOIN emoji_usage eu ON e.id = eu.emoji_id 
        AND (p_user_id IS NULL OR eu.user_id = p_user_id)
    WHERE e.server_id = p_server_id
    GROUP BY e.id, e.name, e.url
    ORDER BY usage_count DESC
    LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION public.get_emoji_usage_analytics IS 'Get emoji usage analytics for a server';

CREATE OR REPLACE FUNCTION public.get_most_used_emojis(
    server_ids uuid[] DEFAULT NULL,
    "limit" integer DEFAULT 100
)
RETURNS TABLE(
    emoji_id uuid,
    emoji_name text,
    emoji_url text,
    server_id uuid,
    usage_count bigint
)
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.id as emoji_id,
        e.name::text as emoji_name,
        e.url::text as emoji_url,
        e.server_id,
        COALESCE(e.usage_count, 0)::bigint as usage_count
    FROM emojis e
    WHERE (server_ids IS NULL OR e.server_id = ANY(server_ids))
    ORDER BY e.usage_count DESC NULLS LAST
    LIMIT "limit";
END;
$$;

COMMENT ON FUNCTION public.get_most_used_emojis IS 'Get most frequently used emojis across servers';

CREATE OR REPLACE FUNCTION public.get_user_emoji_stats(
    p_user_id uuid,
    p_server_id uuid DEFAULT NULL,
    p_limit integer DEFAULT 20
)
RETURNS TABLE(
    emoji_id uuid,
    emoji_name text,
    emoji_url text,
    usage_count bigint,
    last_used timestamptz
)
LANGUAGE plpgsql
STABLE
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        eu.emoji_id,
        e.name::text as emoji_name,
        e.url::text as emoji_url,
        COUNT(eu.id)::bigint as usage_count,
        MAX(eu.used_at) as last_used
    FROM emoji_usage eu
    JOIN emojis e ON eu.emoji_id = e.id
    WHERE eu.user_id = p_user_id
        AND (p_server_id IS NULL OR eu.server_id = p_server_id)
    GROUP BY eu.emoji_id, e.name, e.url
    ORDER BY usage_count DESC
    LIMIT p_limit;
END;
$$;

COMMENT ON FUNCTION public.get_user_emoji_stats IS 'Get emoji usage statistics for a specific user';

CREATE OR REPLACE FUNCTION public.reset_daily_hashtag_counters()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Reset daily counters in hashtags table
    UPDATE public.hashtags
    SET 
        daily_uses = 0,
        updated_at = NOW()
    WHERE daily_uses > 0;
    
    RAISE NOTICE 'Daily hashtag counters reset';
EXCEPTION WHEN undefined_column THEN
    -- Column doesn't exist, skip
    RAISE NOTICE 'daily_uses column does not exist, skipping reset';
END;
$$;

COMMENT ON FUNCTION public.reset_daily_hashtag_counters IS 'Reset daily hashtag usage counters (called by scheduled job)';

-- Matches the entry added to init/98_enable_rls.sql. CREATE FUNCTION grants EXECUTE to
-- PUBLIC, and production's default privileges additionally grant anon, authenticated and
-- service_role, so without this the migration would hand every anonymous caller a
-- SECURITY DEFINER routine that zeroes hashtags.daily_uses instance-wide.
-- TrendingService.resetDailyCounters() holds the only .rpc() literal for it and has no
-- caller. init/ already revokes the rest of this class: archive_popular_hashtags,
-- backfill_timeline_entries, run_trending_maintenance.
REVOKE ALL ON FUNCTION public.reset_daily_hashtag_counters() FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
