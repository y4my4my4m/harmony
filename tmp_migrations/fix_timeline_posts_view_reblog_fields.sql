-- Fix timeline_posts view to include reblog and reblog_author fields
-- This allows reblog posts to be properly displayed in timelines

DROP VIEW IF EXISTS timeline_posts CASCADE;

CREATE VIEW timeline_posts AS
 SELECT p.id,
    p.content,
    p.created_at,
    p.updated_at,
    p.conversation_id,
    jsonb_build_object('id', pr.id, 'username', pr.username, 'display_name', pr.display_name, 'avatar_url', pr.avatar_url, 'domain', COALESCE(pr.domain, 'har.mony.lol'::text), 'handle',
        CASE
            WHEN COALESCE(pr.is_local, true) THEN ('@'::text || pr.username)
            ELSE ((('@'::text || pr.username) || '@'::text) || pr.domain)
        END, 'is_local', COALESCE(pr.is_local, true), 'bio', pr.bio, 'followers_count', pr.followers_count, 'following_count', pr.following_count, 'posts_count', pr.posts_count) AS author,
    p.visibility,
    COALESCE(p.favorites_count, 0) AS favorites_count,
    COALESCE(p.reblogs_count, 0) AS reblogs_count,
    COALESCE(p.replies_count, 0) AS replies_count,
    COALESCE(p.media_attachments, '[]'::jsonb) AS media_attachments,
        CASE
            WHEN (p.in_reply_to IS NOT NULL) THEN jsonb_build_object('id', rp.id, 'author', jsonb_build_object('id', rpr.id, 'username', rpr.username, 'display_name', rpr.display_name, 'avatar_url', rpr.avatar_url, 'domain', COALESCE(rpr.domain, 'har.mony.lol'::text), 'handle',
            CASE
                WHEN COALESCE(rpr.is_local, true) THEN ('@'::text || rpr.username)
                ELSE ((('@'::text || rpr.username) || '@'::text) || rpr.domain)
            END), 'created_at', rp.created_at, 'visibility', rp.visibility, 'content_preview', LEFT((rp.content)::text, 100))
            ELSE NULL::jsonb
        END AS reply_context,
    p.content_warning,
    COALESCE(p.is_sensitive, false) AS is_sensitive,
    p.reblog,  -- Add reblog field
    p.reblog_author,  -- Add reblog_author field
    p.url
   FROM (((public.posts p
     LEFT JOIN public.profiles pr ON ((p.author_id = pr.id)))
     LEFT JOIN public.posts rp ON ((p.in_reply_to = rp.id)))
     LEFT JOIN public.profiles rpr ON ((rp.author_id = rpr.id)))
  WHERE (p.deleted_at IS NULL);

-- Grant proper permissions
GRANT SELECT ON timeline_posts TO authenticated;
GRANT SELECT ON timeline_posts TO anon;

COMMENT ON VIEW timeline_posts IS 'Timeline view including reblog and reblog_author fields for proper reblog display';
