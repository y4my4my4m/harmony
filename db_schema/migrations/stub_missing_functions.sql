-- =============================================================================
-- STUB FUNCTIONS - Temporary implementations for missing RPC functions
-- =============================================================================
-- These functions are called by the frontend but were never implemented in production.
-- They return empty/default values to prevent errors.
-- TODO: Replace with proper implementations (see TODO_cleanRPC.md)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- DROP existing functions with changed signatures (required before CREATE OR REPLACE)
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_thread(text);
DROP FUNCTION IF EXISTS public.get_activitypub_conversation_context(uuid);
DROP FUNCTION IF EXISTS public.get_emoji_usage_analytics(uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.get_user_emoji_stats(uuid, uuid, integer);
DROP FUNCTION IF EXISTS public.get_most_used_emojis(uuid[], integer);

-- ---------------------------------------------------------------------------
-- 1. create_federated_profile - Creates a profile for a remote federated user
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_federated_profile(
    p_username text,
    p_display_name text DEFAULT NULL,
    p_domain text DEFAULT NULL,
    p_avatar_url text DEFAULT NULL,
    p_banner_url text DEFAULT NULL,
    p_bio text DEFAULT NULL,
    p_federated_id text DEFAULT NULL,
    p_inbox_url text DEFAULT NULL,
    p_outbox_url text DEFAULT NULL,
    p_followers_url text DEFAULT NULL,
    p_following_url text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_profile_id uuid;
BEGIN
    -- Check if profile already exists with this federated_id
    IF p_federated_id IS NOT NULL THEN
        SELECT id INTO v_profile_id 
        FROM public.profiles 
        WHERE federated_id = p_federated_id;
        
        IF v_profile_id IS NOT NULL THEN
            -- Update existing profile
            UPDATE public.profiles SET
                display_name = COALESCE(p_display_name, display_name),
                avatar_url = COALESCE(p_avatar_url, avatar_url),
                bio = COALESCE(p_bio, bio),
                inbox_url = COALESCE(p_inbox_url, inbox_url),
                outbox_url = COALESCE(p_outbox_url, outbox_url),
                followers_url = COALESCE(p_followers_url, followers_url),
                following_url = COALESCE(p_following_url, following_url),
                last_synced_at = NOW()
            WHERE id = v_profile_id;
            
            RETURN v_profile_id;
        END IF;
    END IF;
    
    -- Create new federated profile
    INSERT INTO public.profiles (
        username,
        display_name,
        domain,
        avatar_url,
        bio,
        federated_id,
        inbox_url,
        outbox_url,
        followers_url,
        following_url,
        is_local,
        last_synced_at
    ) VALUES (
        p_username,
        p_display_name,
        p_domain,
        p_avatar_url,
        p_bio,
        p_federated_id,
        p_inbox_url,
        p_outbox_url,
        p_followers_url,
        p_following_url,
        false,  -- Not a local user
        NOW()
    )
    RETURNING id INTO v_profile_id;
    
    RETURN v_profile_id;
END;
$$;

COMMENT ON FUNCTION public.create_federated_profile IS 'Creates or updates a profile for a remote federated user discovered via ActivityPub';

-- ---------------------------------------------------------------------------
-- 2. get_activitypub_conversation_context - Get ancestors/descendants of a post
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_activitypub_conversation_context(post_id uuid)
RETURNS TABLE(
    ancestors jsonb,
    descendants jsonb
)
LANGUAGE plpgsql
STABLE
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

-- ---------------------------------------------------------------------------
-- 3. get_activitypub_conversation_thread - Get all posts in a conversation
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 4. get_emoji_usage_analytics - Get emoji usage analytics for a server
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 5. get_most_used_emojis - Get most frequently used emojis
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 6. get_user_emoji_stats - Get user emoji usage statistics
-- ---------------------------------------------------------------------------
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

-- ---------------------------------------------------------------------------
-- 7. reset_daily_hashtag_counters - Reset daily hashtag counters
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reset_daily_hashtag_counters()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
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

-- ---------------------------------------------------------------------------
-- 8. update_hashtag_trending_scores - Update trending scores for hashtags
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_hashtag_trending_scores()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Update trending scores based on recent usage
    -- Using the actual column names: daily_uses, weekly_uses, total_uses
    -- Note: hashtags table doesn't have a trending_score column, 
    -- so we just update the weekly counter based on daily
    UPDATE public.hashtags
    SET 
        weekly_uses = COALESCE(weekly_uses, 0) + COALESCE(daily_uses, 0),
        updated_at = NOW()
    WHERE daily_uses > 0;
    
    RAISE NOTICE 'Hashtag trending scores updated';
EXCEPTION WHEN undefined_column THEN
    -- Columns don't exist, skip
    RAISE NOTICE 'trending columns do not exist, skipping update';
END;
$$;

COMMENT ON FUNCTION public.update_hashtag_trending_scores IS 'Update trending scores for hashtags based on usage patterns';

-- ---------------------------------------------------------------------------
-- 9. update_trending_posts - Update trending posts rankings
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
    -- Delete old trending entries for today's period
    DELETE FROM public.trending_posts 
    WHERE period_start = v_period_start AND period_type = 'daily';
    
    -- Insert new trending posts based on engagement
    -- Using actual columns: trending_score, engagement_score, velocity_score, 
    -- period_type, period_start, period_end, likes_count, reblogs_count, replies_count
    -- Posts table uses favorites_count (not likes_count)
    INSERT INTO public.trending_posts (
        post_id, 
        trending_score, 
        engagement_score, 
        velocity_score,
        period_type,
        period_start, 
        period_end,
        likes_count,
        reblogs_count,
        replies_count
    )
    SELECT 
        p.id,
        -- Trending score with time decay
        (COALESCE(p.favorites_count, 0) + COALESCE(p.reblogs_count, 0) * 2 + COALESCE(p.replies_count, 0) * 1.5) 
        * (1.0 / (EXTRACT(EPOCH FROM (v_now - p.created_at)) / 3600 + 1)) as trending_score,
        -- Total engagement
        (COALESCE(p.favorites_count, 0) + COALESCE(p.reblogs_count, 0) + COALESCE(p.replies_count, 0))::numeric as engagement_score,
        -- Velocity based on recency
        CASE 
            WHEN p.created_at > v_now - INTERVAL '1 hour' THEN 10.0
            WHEN p.created_at > v_now - INTERVAL '6 hours' THEN 5.0
            ELSE 1.0
        END::numeric as velocity_score,
        'daily'::text,
        v_period_start,
        v_period_end,
        COALESCE(p.favorites_count, 0),
        COALESCE(p.reblogs_count, 0),
        COALESCE(p.replies_count, 0)
    FROM posts p
    WHERE p.created_at > v_now - INTERVAL '48 hours'
        AND p.visibility IN ('public', 'unlisted')
    ORDER BY trending_score DESC
    LIMIT 100;
    
    RAISE NOTICE 'Trending posts updated';
EXCEPTION WHEN undefined_table THEN
    RAISE NOTICE 'trending_posts table does not exist, skipping update';
WHEN undefined_column THEN
    RAISE NOTICE 'Required columns do not exist, skipping update';
END;
$$;

COMMENT ON FUNCTION public.update_trending_posts IS 'Update trending posts rankings based on engagement metrics';

-- ---------------------------------------------------------------------------
-- VERIFICATION
-- ---------------------------------------------------------------------------
DO $$
BEGIN
    RAISE NOTICE '✅ Stub functions created successfully!';
    RAISE NOTICE 'These are temporary implementations - see TODO_cleanRPC.md for details';
END $$;

