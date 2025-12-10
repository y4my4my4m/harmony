-- =============================================================================
-- Harmony Database Schema - Views
-- =============================================================================
-- Useful views for querying data
-- =============================================================================

-- ---------------------------------------------------------------------------
-- FOLLOW RELATIONSHIPS - Helper view for debugging
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.follow_relationships AS
SELECT 
    f.id,
    f.follower_id,
    f.following_id,
    f.status,
    f.created_at,
    f.federation_status,
    follower.username AS follower_username,
    following.username AS following_username,
    follower.display_name AS follower_display_name,
    following.display_name AS following_display_name,
    follower.domain AS follower_domain,
    following.domain AS following_domain
FROM public.follows f
JOIN public.profiles follower ON f.follower_id = follower.id
JOIN public.profiles following ON f.following_id = following.id;

COMMENT ON VIEW public.follow_relationships IS 
'Helper view that clearly shows follow relationships with usernames.
follower_id = user who is following
following_id = user being followed
Use this view for debugging relationship queries.';

-- ---------------------------------------------------------------------------
-- USER BOOKMARKS - Bookmarked posts view
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.user_bookmarks AS
SELECT 
    pi.id AS bookmark_id,
    pi.user_id,
    pi.post_id,
    pi.created_at AS bookmarked_at,
    p.*
FROM public.post_interactions pi
JOIN public.posts p ON pi.post_id = p.id
WHERE pi.interaction_type = 'bookmark'
  AND (p.is_deleted = false OR p.is_deleted IS NULL);

COMMENT ON VIEW public.user_bookmarks IS 'User bookmarks view that automatically excludes deleted posts';

-- ---------------------------------------------------------------------------
-- VISIBLE POSTS - Posts visible based on visibility settings
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.visible_posts AS
SELECT p.*
FROM public.posts p
JOIN public.profiles author ON p.author_id = author.id
WHERE p.is_deleted = false
  AND (author.is_suspended = false OR author.is_suspended IS NULL)
  AND p.visibility = 'public';

COMMENT ON VIEW public.visible_posts IS 'Public posts from non-suspended users';

-- ---------------------------------------------------------------------------
-- ACTIVE THREADS VIEW - Non-archived threads with stats
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.active_threads_view AS
SELECT 
    t.*,
    c.name AS channel_name,
    c.server_id,
    creator.username AS creator_username,
    creator.display_name AS creator_display_name,
    creator.avatar_url AS creator_avatar_url
FROM public.threads t
JOIN public.channels c ON t.channel_id = c.id
JOIN public.profiles creator ON t.created_by = creator.id
WHERE t.archived = false OR t.archived IS NULL;

COMMENT ON VIEW public.active_threads_view IS 'Active (non-archived) threads with channel and creator info';

-- ---------------------------------------------------------------------------
-- PINNED MESSAGES VIEW - Pinned messages with author info
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.pinned_messages_view AS
SELECT 
    m.*,
    author.username AS author_username,
    author.display_name AS author_display_name,
    author.avatar_url AS author_avatar_url,
    pinner.username AS pinner_username,
    pinner.display_name AS pinner_display_name
FROM public.messages m
JOIN public.profiles author ON m.user_id = author.id
LEFT JOIN public.profiles pinner ON m.pinned_by = pinner.id
WHERE m.is_pinned = true
  AND m.is_deleted = false
ORDER BY m.pinned_at DESC;

COMMENT ON VIEW public.pinned_messages_view IS 'Pinned messages with author and pinner info';

-- ---------------------------------------------------------------------------
-- FEDERATION STATS VIEW - Aggregated federation statistics
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.federation_stats AS
SELECT 
    count(*) AS total_activities,
    count(*) FILTER (WHERE status = 'completed') AS completed_activities,
    count(*) FILTER (WHERE status = 'failed') AS failed_activities,
    count(*) FILTER (WHERE status = 'pending') AS pending_activities,
    count(*) FILTER (WHERE status = 'processing') AS processing_activities,
    count(DISTINCT actor_id) AS unique_actors,
    activity_type,
    date_trunc('hour', created_at) AS hour
FROM public.ap_activities
GROUP BY activity_type, date_trunc('hour', created_at)
ORDER BY date_trunc('hour', created_at) DESC;

COMMENT ON VIEW public.federation_stats IS 'Aggregated federation activity statistics by hour';

-- ---------------------------------------------------------------------------
-- FEDERATION HEALTH METRICS VIEW - Instance health for admin dashboard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.federation_health_metrics AS
SELECT 
    fi.id,
    fi.domain AS remote_domain,
    fi.software AS software_name,
    fi.version AS software_version,
    fi.is_blocked,
    fi.is_silenced,
    fi.last_successful_sync AS last_success_at,
    fi.last_sync_attempt AS last_attempt_at,
    fi.consecutive_failures AS failure_count,
    fi.user_count,
    fi.status_count,
    fi.updated_at AS recorded_at,
    CASE 
        WHEN fi.is_blocked THEN 'blocked'
        WHEN fi.consecutive_failures = 0 THEN 'healthy'
        WHEN fi.consecutive_failures < 3 THEN 'degraded'
        ELSE 'unhealthy'
    END AS status,
    CASE
        WHEN fi.consecutive_failures = 0 THEN true
        ELSE false
    END AS success
FROM public.federated_instances fi;

COMMENT ON VIEW public.federation_health_metrics IS 'View of federation health for admin dashboard';

-- ---------------------------------------------------------------------------
-- INSTANCE HEALTH VIEW - Overall instance health summary
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.instance_health AS
SELECT
    (SELECT count(*) FROM public.profiles WHERE is_local = true) AS local_users,
    (SELECT count(*) FROM public.profiles WHERE is_local = false) AS remote_users,
    (SELECT count(*) FROM public.posts WHERE is_local = true) AS local_posts,
    (SELECT count(*) FROM public.posts WHERE is_local = false) AS remote_posts,
    (SELECT count(*) FROM public.federated_instances) AS known_instances,
    (SELECT count(*) FROM public.federated_instances WHERE is_blocked = true) AS blocked_instances,
    (SELECT count(*) FROM public.federation_delivery_queue WHERE status = 'pending') AS pending_deliveries,
    (SELECT count(*) FROM public.federation_delivery_queue WHERE status = 'failed') AS failed_deliveries,
    now() AS generated_at;

COMMENT ON VIEW public.instance_health IS 'Overall instance health summary';

-- ---------------------------------------------------------------------------
-- ACTIVE STATUSES VIEW - User custom statuses
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.active_statuses_view AS
SELECT 
    p.id AS user_id,
    p.username,
    p.display_name,
    p.avatar_url,
    p.custom_status,
    p.last_status_update,
    p.status AS presence_status
FROM public.profiles p
WHERE p.custom_status IS NOT NULL
  AND p.is_suspended = false
  AND p.is_local = true
ORDER BY p.last_status_update DESC;

COMMENT ON VIEW public.active_statuses_view IS 'Users with active custom statuses';

-- ---------------------------------------------------------------------------
-- TIMELINE POSTS VIEW - Optimized timeline query base
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW public.timeline_posts AS
SELECT 
    p.*,
    author.username AS author_username,
    author.display_name AS author_display_name,
    author.avatar_url AS author_avatar_url,
    author.domain AS author_domain,
    author.is_local AS author_is_local
FROM public.posts p
JOIN public.profiles author ON p.author_id = author.id
WHERE p.is_deleted = false
  AND (author.is_suspended = false OR author.is_suspended IS NULL);

COMMENT ON VIEW public.timeline_posts IS 'Base view for timeline queries with author info';

DO $$
BEGIN
    RAISE NOTICE 'Views created successfully';
END $$;

