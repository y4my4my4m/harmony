-- Filter muted and blocked users from federated timeline
-- When you mute a user with hide_from_timeline, or block them, their posts won't appear in your federated feed
BEGIN;

CREATE OR REPLACE FUNCTION public.get_federated_timeline(p_user_id uuid, p_limit integer DEFAULT 20, p_max_id text DEFAULT NULL::text)
RETURNS TABLE(
    id text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    content jsonb,
    content_warning text,
    language text,
    author_id text,
    ap_id text,
    ap_type text,
    url text,
    conversation_id text,
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
    is_bookmarked boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
BEGIN
    RETURN QUERY
    SELECT
        p.id::TEXT,
        p.created_at,
        p.updated_at,
        p.content,
        p.content_warning,
        p.language,
        p.author_id::TEXT,
        p.ap_id,
        p.ap_type,
        p.url,
        p.conversation_id::TEXT,
        p.visibility,
        p.is_local,
        p.is_federated,
        COALESCE(p.replies_count, 0)::INTEGER,
        COALESCE(p.reblogs_count, 0)::INTEGER,
        COALESCE(p.favorites_count, 0)::INTEGER,
        COALESCE(p.media_attachments, '[]'::jsonb),
        COALESCE(p.metadata, '{}'::jsonb),
        COALESCE(p.is_sensitive, false),
        jsonb_build_object(
            'id', pr.id,
            'username', pr.username,
            'display_name', pr.display_name,
            'avatar_url', pr.avatar_url,
            'domain', COALESCE(pr.domain, 'har.mony.lol'),
            'handle', CASE
                WHEN COALESCE(pr.is_local, true) THEN '@' || pr.username
                ELSE '@' || pr.username || '@' || pr.domain
            END,
            'is_local', COALESCE(pr.is_local, true),
            'bio', pr.bio,
            'color', pr.color
        ) AS author,
        EXISTS(
            SELECT 1 FROM post_interactions pi
            WHERE pi.post_id = p.id
              AND pi.user_id = p_user_id
              AND pi.interaction_type IN ('favorite', 'emoji_reaction')
        ) AS is_favorited,
        EXISTS(
            SELECT 1 FROM post_interactions pi
            WHERE pi.post_id = p.id
              AND pi.user_id = p_user_id
              AND pi.interaction_type = 'reblog'
        ) AS is_reblogged,
        EXISTS(
            SELECT 1 FROM post_interactions pi
            WHERE pi.post_id = p.id
              AND pi.user_id = p_user_id
              AND pi.interaction_type = 'bookmark'
        ) AS is_bookmarked

    FROM posts p
    INNER JOIN profiles pr ON p.author_id = pr.id

    WHERE
        p.is_local = false
        AND p.visibility = 'public'
        AND (p.is_deleted = false OR p.is_deleted IS NULL)
        AND p.deleted_at IS NULL
        AND (pr.is_suspended = false OR pr.is_suspended IS NULL)
        AND p.in_reply_to IS NULL
        -- Exclude blocked users (use get_current_profile_id for correct profile resolution)
        AND NOT EXISTS (
            SELECT 1 FROM user_blocks ub
            WHERE ub.blocker_id = public.get_current_profile_id()
              AND ub.blocked_user_id = p.author_id
        )
        -- Exclude muted users (when hide_from_timeline is true)
        AND NOT EXISTS (
            SELECT 1 FROM user_mutes um
            WHERE um.muter_id = public.get_current_profile_id()
              AND um.muted_user_id = p.author_id
              AND (um.hide_from_timeline = true OR um.hide_from_timeline IS NULL)
              AND (um.expires_at IS NULL OR um.expires_at > NOW())
        )
        AND (p_max_id IS NULL OR p.created_at < (
            SELECT p2.created_at FROM posts p2 WHERE p2.id::TEXT = p_max_id
        ))

    ORDER BY p.created_at DESC
    LIMIT p_limit;
END;
$$;

COMMIT;
