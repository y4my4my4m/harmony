-- get_trending_posts pages by keyset as well as by offset.
--
-- Offset paging against a fixed as_of skips a post whenever a row above the offset leaves
-- the ranking between two pages: a deletion, a block, an unfavourite. Measured on the
-- e2e stack: deleting the fourth post of page 1 (limit 20, 30-day window) made offset 20
-- start one row later, and the post that had opened page 2 was on neither page.
--
-- p_after_score, p_after_created_at and p_after_id are the score, created_at and id of
-- the last row of the previous page. A page continues strictly after that row in the
-- ranking order (score DESC, created_at DESC, id DESC); rows that move above it are not
-- repeated and none below it is skipped. Scores are float8 computed against the pinned
-- as_of, so a row whose counts did not change reproduces its score exactly. p_offset still
-- applies, after the cursor; clients that send no cursor page as before.
--
-- The signature gains three trailing parameters with NULL defaults, so calls naming the
-- seven earlier parameters resolve to it. The seven-parameter function is dropped; beside
-- it, a seven-argument call matches both ("function ... is not unique").

BEGIN;

SET LOCAL lock_timeout = '3s';

DROP FUNCTION IF EXISTS public.get_trending_posts(integer, boolean, boolean, text, integer, integer, timestamptz);

CREATE OR REPLACE FUNCTION public.get_trending_posts(
    p_hours integer DEFAULT 24,
    p_media_only boolean DEFAULT false,
    p_local_only boolean DEFAULT false,
    p_domain text DEFAULT NULL,
    p_limit integer DEFAULT 20,
    p_offset integer DEFAULT 0,
    p_as_of timestamptz DEFAULT NULL,
    p_after_score double precision DEFAULT NULL,
    p_after_created_at timestamptz DEFAULT NULL,
    p_after_id uuid DEFAULT NULL
) RETURNS TABLE (
    id uuid,
    created_at timestamptz,
    updated_at timestamptz,
    content jsonb,
    content_warning text,
    language text,
    author_id uuid,
    ap_id text,
    ap_type text,
    url text,
    conversation_id uuid,
    visibility text,
    is_local boolean,
    is_federated boolean,
    replies_count integer,
    reblogs_count integer,
    favorites_count integer,
    media_attachments jsonb,
    metadata jsonb,
    is_sensitive boolean,
    author jsonb,
    is_favorited boolean,
    is_reblogged boolean,
    is_bookmarked boolean,
    score double precision,
    as_of timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_as_of timestamptz := LEAST(COALESCE(p_as_of, now()), now());
    v_hours integer := LEAST(GREATEST(COALESCE(p_hours, 24), 1), 720);
    v_since timestamptz;
    v_half_life double precision;
    v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 40);
    v_offset integer := LEAST(GREATEST(COALESCE(p_offset, 0), 0), 400);
    v_media_only boolean := COALESCE(p_media_only, false);
    v_local_only boolean := COALESCE(p_local_only, false);
    v_domain text := NULLIF(lower(btrim(p_domain)), '');
    -- A cursor needs all three parts; a partial one is ignored.
    v_keyset boolean := p_after_score IS NOT NULL AND p_after_created_at IS NOT NULL
                        AND p_after_id IS NOT NULL;
BEGIN
    v_since := v_as_of - make_interval(hours => v_hours);
    v_half_life := v_hours * 1800.0;

    -- EXECUTE plans each call with its arguments. A cached generic plan does not know the
    -- window's width and joins profiles to posts by author: 34 s against 0.6 s for 7 days.
    RETURN QUERY EXECUTE $q$
    WITH ranked AS (
        -- float8 throughout: numeric power() cost 13 us a row (get_today_summary).
        SELECT p.*,
               (power(greatest(coalesce(p.replies_count, 0), 0)::float8, 0.9::float8) * 3
                + power(greatest(coalesce(p.reblogs_count, 0), 0)::float8, 0.8::float8) * 2
                + power(greatest(coalesce(p.favorites_count, 0), 0)::float8, 0.7::float8))
               * power(0.5::float8, extract(epoch FROM $2 - p.created_at)::float8 / $3)
                   AS rank_score
          FROM public.posts p
         WHERE p.visibility = 'public'
           AND p.is_deleted = false
           AND p.created_at > $1
           AND p.created_at <= $2
           AND p.reblog IS NULL
           AND p.in_reply_to IS NULL
           AND NOT (COALESCE(p.metadata, '{}'::jsonb) ? 'in_reply_to_ap_url')
           AND (coalesce(p.replies_count, 0) > 0
                OR coalesce(p.reblogs_count, 0) > 0
                OR coalesce(p.favorites_count, 0) > 0)
           AND (NOT $5 OR p.is_local)
           AND (NOT $4 OR public.post_has_profile_media(p.media_attachments, p.content))
    ),
    page AS (
        SELECT r.*, a.username AS a_username, a.display_name AS a_display_name,
               a.avatar_url AS a_avatar_url, a.banner_url AS a_banner_url, a.bio AS a_bio,
               a.color AS a_color, a.domain AS a_domain, a.is_local AS a_is_local,
               a.created_at AS a_created_at, a.updated_at AS a_updated_at,
               a.followers_count AS a_followers_count, a.following_count AS a_following_count,
               a.posts_count AS a_posts_count
          FROM ranked r
          JOIN public.profiles a ON a.id = r.author_id
         WHERE a.is_suspended IS NOT TRUE
           AND a.is_silenced IS NOT TRUE
           AND a.federation_discoverable IS NOT FALSE
           AND ($6::text IS NULL OR lower(a.domain) = $6)
           AND (NOT $10 OR (r.rank_score, r.created_at, r.id) < ($11, $12, $13))
         ORDER BY r.rank_score DESC, r.created_at DESC, r.id DESC
         LIMIT $7 OFFSET $8
    )
    SELECT pg.id,
           pg.created_at,
           pg.updated_at,
           pg.content,
           pg.content_warning,
           pg.language,
           pg.author_id,
           pg.ap_id,
           pg.ap_type,
           pg.url,
           pg.conversation_id,
           pg.visibility,
           pg.is_local,
           pg.is_federated,
           coalesce(pg.replies_count, 0),
           coalesce(pg.reblogs_count, 0),
           coalesce(pg.favorites_count, 0),
           coalesce(pg.media_attachments, '[]'::jsonb),
           coalesce(pg.metadata, '{}'::jsonb),
           coalesce(pg.is_sensitive, false),
           jsonb_build_object(
               'id', pg.author_id,
               'username', pg.a_username,
               'display_name', pg.a_display_name,
               'avatar_url', pg.a_avatar_url,
               'banner_url', pg.a_banner_url,
               'bio', pg.a_bio,
               'color', pg.a_color,
               'domain', pg.a_domain,
               'is_local', pg.a_is_local,
               'created_at', pg.a_created_at,
               'updated_at', pg.a_updated_at,
               'followers_count', pg.a_followers_count,
               'following_count', pg.a_following_count,
               'posts_count', pg.a_posts_count),
           EXISTS (SELECT 1 FROM public.post_interactions i
                    WHERE i.user_id = $9 AND i.post_id = pg.id
                      AND i.interaction_type IN ('favorite', 'emoji_reaction')),
           EXISTS (SELECT 1 FROM public.post_interactions i
                    WHERE i.user_id = $9 AND i.post_id = pg.id
                      AND i.interaction_type = 'reblog'),
           EXISTS (SELECT 1 FROM public.post_interactions i
                    WHERE i.user_id = $9 AND i.post_id = pg.id
                      AND i.interaction_type = 'bookmark'),
           pg.rank_score,
           $2
      FROM page pg
     ORDER BY pg.rank_score DESC, pg.created_at DESC, pg.id DESC
    $q$
    USING v_since, v_as_of, v_half_life, v_media_only, v_local_only, v_domain, v_limit,
          v_offset, v_me, v_keyset, p_after_score, p_after_created_at, p_after_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_trending_posts(integer, boolean, boolean, text, integer, integer, timestamptz, double precision, timestamptz, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_trending_posts(integer, boolean, boolean, text, integer, integer, timestamptz, double precision, timestamptz, uuid) TO anon, authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
