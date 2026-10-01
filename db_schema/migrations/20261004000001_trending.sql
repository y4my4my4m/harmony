-- Trending: posts ranked server-side over the whole window, and hashtag counts that skip
-- deleted posts and boosts.
--
-- get_trending_posts(p_hours, p_media_only, p_local_only, p_domain, p_limit, p_offset, p_as_of)
--   Public, top-level, non-deleted posts created in (as_of - p_hours, as_of], by authors who are
--   neither suspended, silenced nor undiscoverable (profiles.federation_discoverable, the AP
--   `discoverable` flag, false). A post needs at least one reply, boost or favourite.
--   Replies are rows with in_reply_to, or remote replies whose parent is not yet fetched
--   (metadata.in_reply_to_ap_url). Boost rows (reblog IS NOT NULL) are left out; the boosted
--   post carries the counts.
--
--   score = (3 replies^0.9 + 2 reblogs^0.8 + favourites^0.7) * 0.5^(age / (p_hours / 2))
--   The engagement term is the one get_today_summary ranks followed posts by. The half-life
--   is half the window, so a post at the window's start needs four times the engagement
--   term of a fresh one.
--
--   p_media_only keeps posts for which post_has_profile_media() holds: an image or video in
--   media_attachments (composer uploads, outbox imports, Mastodon-API rows) or a file part
--   in content (inbox-delivered notes). p_local_only keeps posts.is_local; p_domain keeps
--   authors on that domain.
--
--   Paging is by offset against a fixed as_of. The first call passes p_as_of NULL; every row
--   carries the as_of used, and later pages pass it back so window and scores hold still.
--   p_as_of is clamped to now(). p_hours is clamped to [1, 720], p_limit to [1, 40],
--   p_offset to [0, 400].
--
--   SECURITY INVOKER: posts RLS applies, so a block in either direction hides the author.
--   is_favorited, is_reblogged and is_bookmarked are the caller's post_interactions.
--
-- get_trending_hashtags keeps its signature. Uses count posts that are not deleted and not
-- boosts, created inside the window; post_hashtags.created_at alone admitted old posts
-- fetched late. Tags rank by distinct authors, then uses, then name. p_hours is clamped to
-- [1, 720] and p_limit to [1, 50].
--
-- Measured on supabase/postgres 15.8.1.060, 1M posts over 30 days from 5000 authors (40%
-- local, the rest over 50 domains), 20% carrying media (half in media_attachments, half as
-- content file parts), 15% with any engagement, 30% tagged from 2000 hashtags; warm cache,
-- authenticated caller, page of 20:
--   get_trending_posts          all      media    this instance   one domain
--     24h                       51 ms    8.5 ms   10 ms           128 ms
--     7d                        123 ms   65 ms
--     30d                       309 ms   127 ms
--     24h, offset 200           37 ms
--   The media filter reads idx_posts_author_media, whose predicate it repeats.
--   get_trending_hashtags       before   after
--     24h                       78 ms    70 ms
--     7d                        685 ms   448 ms
--     30d                       920 ms   880-1020 ms

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.get_trending_posts(
    p_hours integer DEFAULT 24,
    p_media_only boolean DEFAULT false,
    p_local_only boolean DEFAULT false,
    p_domain text DEFAULT NULL,
    p_limit integer DEFAULT 20,
    p_offset integer DEFAULT 0,
    p_as_of timestamptz DEFAULT NULL
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
          v_offset, v_me;
END;
$$;

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
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_hours integer := LEAST(GREATEST(COALESCE(p_hours, 168), 1), 720);
    v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
    v_current_start timestamptz;
    v_previous_start timestamptz;
BEGIN
    v_current_start := now() - make_interval(hours => v_hours);
    v_previous_start := now() - make_interval(hours => v_hours * 2);

    RETURN QUERY
    WITH uses AS (
        SELECT ph.hashtag_id, p.author_id, p.created_at >= v_current_start AS is_current
          FROM public.post_hashtags ph
          JOIN public.posts p ON p.id = ph.post_id
         WHERE ph.created_at > v_previous_start
           AND p.created_at > v_previous_start
           AND p.is_deleted IS NOT TRUE
           AND p.reblog IS NULL
    ),
    current_period AS (
        SELECT u.hashtag_id,
               count(*) AS current_uses,
               count(DISTINCT u.author_id) AS current_unique_users
          FROM uses u
         WHERE u.is_current
         GROUP BY u.hashtag_id
    ),
    previous_period AS (
        SELECT u.hashtag_id, count(*) AS previous_uses
          FROM uses u
         WHERE NOT u.is_current
         GROUP BY u.hashtag_id
    )
    SELECT h.tag,
           cp.current_uses,
           cp.current_unique_users,
           CASE
               WHEN COALESCE(pp.previous_uses, 0) = 0 THEN 100.0
               ELSE ROUND(((cp.current_uses::numeric - pp.previous_uses::numeric)
                           / pp.previous_uses::numeric) * 100, 1)
           END,
           CASE
               WHEN COALESCE(pp.previous_uses, 0) = 0 THEN 'rising'
               WHEN cp.current_uses > pp.previous_uses * 1.05 THEN 'rising'
               WHEN cp.current_uses < pp.previous_uses * 0.95 THEN 'falling'
               ELSE 'stable'
           END
      FROM current_period cp
      JOIN public.hashtags h ON h.id = cp.hashtag_id
      LEFT JOIN previous_period pp ON pp.hashtag_id = cp.hashtag_id
     ORDER BY cp.current_unique_users DESC, cp.current_uses DESC, h.tag
     LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.get_trending_posts(integer, boolean, boolean, text, integer, integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_trending_posts(integer, boolean, boolean, text, integer, integer, timestamptz) TO anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.get_trending_hashtags(integer, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_trending_hashtags(integer, integer) TO anon, authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
