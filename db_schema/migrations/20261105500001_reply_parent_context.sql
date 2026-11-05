-- get_home_timeline_page rows carry reply_parent: the post a reply answers, read as the caller
-- (SECURITY INVOKER: posts RLS applies), shaped as the client's PostgREST embed
-- reply_parent:in_reply_to(...) (src/services/replyContext.ts REPLY_PARENT_COLUMNS):
--
--   { id, content, content_warning, visibility, is_deleted, media_attachments, created_at,
--     author: { id, username, display_name, avatar_url, domain, is_local } }
--
-- NULL when the row is not a reply or the caller may not read the parent. A deleted parent
-- has is_deleted true, content and content_warning NULL and no media. A reply's card in the
-- home timeline previews its parent from it. Otherwise as 20260101000000_baseline.sql.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.get_home_timeline_page(
    p_limit integer DEFAULT 20,
    p_before timestamptz DEFAULT NULL
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
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
            'my_interactions', COALESCE(i.my_interactions, '[]'::jsonb),
            'reply_parent', rp.reply_parent
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
LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
        'id', parent.id,
        'content', CASE WHEN parent.is_deleted THEN NULL ELSE parent.content END,
        'content_warning', CASE WHEN parent.is_deleted THEN NULL ELSE parent.content_warning END,
        'visibility', parent.visibility,
        'is_deleted', COALESCE(parent.is_deleted, false),
        'media_attachments', CASE WHEN parent.is_deleted THEN '[]'::jsonb
                                  ELSE COALESCE(parent.media_attachments, '[]'::jsonb) END,
        'created_at', parent.created_at,
        'author', CASE WHEN ppr.id IS NULL THEN NULL ELSE jsonb_build_object(
            'id', ppr.id,
            'username', ppr.username,
            'display_name', ppr.display_name,
            'avatar_url', ppr.avatar_url,
            'domain', ppr.domain,
            'is_local', ppr.is_local
        ) END
    ) AS reply_parent
    FROM public.posts parent
    LEFT JOIN public.profiles ppr ON ppr.id = parent.author_id
    WHERE parent.id = page.in_reply_to
) rp ON true
$$;

COMMENT ON FUNCTION public.get_home_timeline_page(integer, timestamptz) IS
'Single round-trip home feed: posts from accepted/pending follows + own posts, with author embed, caller interaction states and the parent a reply answers (reply_parent, NULL when unreadable). Caller resolved via get_current_profile_id(). SECURITY INVOKER so posts RLS applies.';

REVOKE ALL ON FUNCTION public.get_home_timeline_page(integer, timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_home_timeline_page(integer, timestamptz) TO anon, authenticated, service_role;

COMMIT;
