BEGIN;

-- ============================================================================
-- 1. Add account-level moderation columns to profiles
-- ============================================================================
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS force_sensitive boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS is_silenced boolean DEFAULT false;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS silenced_at timestamp with time zone;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS silenced_reason text;

-- ============================================================================
-- 1b. Drop duplicate log_admin_action overload (5-param version)
--     The production DB has both (uuid,text,text,text,jsonb) AND
--     (uuid,text,text,text,jsonb,inet,text). This causes ambiguity errors.
--     Keep only the 7-param version which is a superset.
-- ============================================================================
DROP FUNCTION IF EXISTS public.log_admin_action(uuid, text, text, text, jsonb);

-- ============================================================================
-- 2. Fix get_reports_with_details: add reporter_id, domain/is_local,
--    post ap_id/url/is_sensitive/content_warning, fix post preview
-- ============================================================================
DROP FUNCTION IF EXISTS public.get_reports_with_details(text, integer, integer);
CREATE OR REPLACE FUNCTION public.get_reports_with_details(
    p_status text DEFAULT NULL,
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0
)
RETURNS TABLE(
    id uuid,
    reporter_id uuid,
    reported_user_id uuid,
    reported_message_id uuid,
    reported_post_id uuid,
    reporter_username text,
    reporter_display_name text,
    reporter_avatar_url text,
    reporter_domain text,
    reporter_is_local boolean,
    reported_user_username text,
    reported_user_display_name text,
    reported_user_avatar_url text,
    reported_user_domain text,
    reported_user_is_local boolean,
    reported_post_preview text,
    reported_post_ap_id text,
    reported_post_url text,
    reported_post_is_sensitive boolean,
    reported_post_content_warning text,
    reported_message_preview text,
    reason text,
    comment text,
    report_type text,
    source text,
    source_instance text,
    status text,
    resolution_note text,
    created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    RETURN QUERY
    SELECT
        r.id,
        r.reporter_id,
        r.reported_user_id,
        r.reported_message_id,
        r.reported_post_id,
        reporter.username::text,
        reporter.display_name::text,
        reporter.avatar_url::text,
        reporter.domain::text,
        COALESCE(reporter.is_local, true),
        reported_user.username::text,
        reported_user.display_name::text,
        reported_user.avatar_url::text,
        reported_user.domain::text,
        COALESCE(reported_user.is_local, true),
        -- Post preview: robust extraction from JSONB content array
        CASE
            WHEN r.reported_post_id IS NOT NULL THEN
                LEFT(
                    COALESCE(
                        (SELECT string_agg(
                            CASE
                                WHEN part->>'type' = 'text' THEN COALESCE(part->>'text', '')
                                WHEN part->>'type' = 'url' THEN COALESCE(part->>'url', '[link]')
                                WHEN part->>'type' = 'mention' THEN '@' || COALESCE(part->>'username', 'user')
                                WHEN part->>'type' = 'hashtag' THEN '#' || COALESCE(part->>'name', 'tag')
                                WHEN part->>'type' = 'emoji' THEN ':' || COALESCE(part->'emoji'->>'name', 'emoji') || ':'
                                ELSE ''
                            END, ' '
                        )
                        FROM public.posts p, jsonb_array_elements(p.content) AS part
                        WHERE p.id = r.reported_post_id),
                        '[Post content unavailable]'
                    ),
                    500
                )
            ELSE NULL
        END::text,
        -- Post AP fields for "view on remote instance"
        CASE WHEN r.reported_post_id IS NOT NULL THEN
            (SELECT p.ap_id FROM public.posts p WHERE p.id = r.reported_post_id)
        ELSE NULL END::text,
        CASE WHEN r.reported_post_id IS NOT NULL THEN
            (SELECT p.url FROM public.posts p WHERE p.id = r.reported_post_id)
        ELSE NULL END::text,
        CASE WHEN r.reported_post_id IS NOT NULL THEN
            (SELECT p.is_sensitive FROM public.posts p WHERE p.id = r.reported_post_id)
        ELSE NULL END,
        CASE WHEN r.reported_post_id IS NOT NULL THEN
            (SELECT p.content_warning FROM public.posts p WHERE p.id = r.reported_post_id)
        ELSE NULL END::text,
        -- Message preview (unchanged)
        CASE
            WHEN r.reported_message_id IS NOT NULL THEN
                LEFT(
                    COALESCE(
                        (SELECT string_agg(
                            CASE
                                WHEN part->>'type' = 'text' THEN COALESCE(part->>'text', '')
                                WHEN part->>'type' = 'file' THEN '[' || COALESCE(part->>'fileType', 'file') || ': ' || COALESCE(part->>'filename', part->>'url', 'attachment') || ']'
                                WHEN part->>'type' = 'url' THEN COALESCE(part->>'url', '[link]')
                                WHEN part->>'type' = 'emoji' THEN COALESCE(part->'emoji'->>'name', ':emoji:')
                                WHEN part->>'type' = 'mention' THEN COALESCE(part->>'mention', '@user')
                                ELSE '[' || COALESCE(part->>'type', 'unknown') || ']'
                            END, ' '
                        )
                        FROM public.messages m, jsonb_array_elements(m.content) AS part
                        WHERE m.id = r.reported_message_id),
                        '[Message content unavailable]'
                    ),
                    300
                )
            ELSE NULL
        END::text,
        r.reason,
        r.comment,
        r.report_type,
        r.source,
        r.source_instance,
        r.status,
        r.resolution_note,
        r.created_at
    FROM public.reports r
    LEFT JOIN public.profiles reporter ON reporter.id = r.reporter_id
    LEFT JOIN public.profiles reported_user ON reported_user.id = r.reported_user_id
    WHERE (p_status IS NULL OR r.status = p_status)
    ORDER BY r.created_at DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

-- ============================================================================
-- 3. admin_moderate_post: per-post moderation (mark_sensitive, set_cw, delete)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.admin_moderate_post(
    p_post_id uuid,
    p_action text,
    p_value text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_admin_id uuid;
BEGIN
    SELECT id INTO v_admin_id
    FROM public.profiles
    WHERE auth_user_id = auth.uid()
      AND (is_admin = true OR is_moderator = true);

    IF v_admin_id IS NULL THEN
        RAISE EXCEPTION 'Insufficient permissions: admin or moderator role required';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM public.posts WHERE id = p_post_id) THEN
        RAISE EXCEPTION 'Post not found';
    END IF;

    IF p_action = 'mark_sensitive' THEN
        UPDATE public.posts SET is_sensitive = true WHERE id = p_post_id;
    ELSIF p_action = 'unmark_sensitive' THEN
        UPDATE public.posts SET is_sensitive = false WHERE id = p_post_id;
    ELSIF p_action = 'set_cw' THEN
        UPDATE public.posts SET content_warning = p_value WHERE id = p_post_id;
    ELSIF p_action = 'remove_cw' THEN
        UPDATE public.posts SET content_warning = NULL WHERE id = p_post_id;
    ELSIF p_action = 'delete' THEN
        UPDATE public.posts SET is_deleted = true, deleted_at = now() WHERE id = p_post_id;
    ELSE
        RAISE EXCEPTION 'Invalid action: %', p_action;
    END IF;

    PERFORM log_admin_action(
        v_admin_id,
        ('post_' || p_action)::text,
        'post'::text,
        p_post_id::text,
        jsonb_build_object('action', p_action, 'value', p_value)
    );

    RETURN true;
END;
$$;

-- ============================================================================
-- 4. Extend moderate_user with force_sensitive and silence actions
-- ============================================================================
CREATE OR REPLACE FUNCTION public.moderate_user(
    p_admin_id uuid,
    p_target_user_id uuid,
    p_action text,
    p_reason text DEFAULT NULL::text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    target_username TEXT;
    admin_profile_id UUID;
BEGIN
    SELECT id INTO admin_profile_id
    FROM profiles
    WHERE auth_user_id = p_admin_id AND (is_admin = TRUE OR is_moderator = TRUE);

    IF admin_profile_id IS NULL THEN
        RAISE EXCEPTION 'Insufficient permissions';
    END IF;

    SELECT username INTO target_username FROM profiles WHERE id = p_target_user_id;

    IF target_username IS NULL THEN
        RAISE EXCEPTION 'User not found';
    END IF;

    IF p_action = 'suspend' THEN
        UPDATE profiles
        SET is_suspended = TRUE, suspended_at = NOW(), suspension_reason = p_reason
        WHERE id = p_target_user_id;

        PERFORM log_admin_action(
            admin_profile_id, 'user_suspend'::text, 'user'::text,
            p_target_user_id::TEXT,
            jsonb_build_object('reason', p_reason, 'username', target_username)
        );

    ELSIF p_action = 'unsuspend' THEN
        UPDATE profiles
        SET is_suspended = FALSE, suspended_at = NULL, suspension_reason = NULL
        WHERE id = p_target_user_id;

        PERFORM log_admin_action(
            admin_profile_id, 'user_unsuspend'::text, 'user'::text,
            p_target_user_id::TEXT,
            jsonb_build_object('username', target_username)
        );

    ELSIF p_action = 'force_sensitive' THEN
        UPDATE profiles SET force_sensitive = TRUE WHERE id = p_target_user_id;

        PERFORM log_admin_action(
            admin_profile_id, 'user_force_sensitive'::text, 'user'::text,
            p_target_user_id::TEXT,
            jsonb_build_object('reason', p_reason, 'username', target_username)
        );

    ELSIF p_action = 'unforce_sensitive' THEN
        UPDATE profiles SET force_sensitive = FALSE WHERE id = p_target_user_id;

        PERFORM log_admin_action(
            admin_profile_id, 'user_unforce_sensitive'::text, 'user'::text,
            p_target_user_id::TEXT,
            jsonb_build_object('username', target_username)
        );

    ELSIF p_action = 'silence' THEN
        UPDATE profiles
        SET is_silenced = TRUE, silenced_at = NOW(), silenced_reason = p_reason
        WHERE id = p_target_user_id;

        PERFORM log_admin_action(
            admin_profile_id, 'user_silence'::text, 'user'::text,
            p_target_user_id::TEXT,
            jsonb_build_object('reason', p_reason, 'username', target_username)
        );

    ELSIF p_action = 'unsilence' THEN
        UPDATE profiles
        SET is_silenced = FALSE, silenced_at = NULL, silenced_reason = NULL
        WHERE id = p_target_user_id;

        PERFORM log_admin_action(
            admin_profile_id, 'user_unsilence'::text, 'user'::text,
            p_target_user_id::TEXT,
            jsonb_build_object('username', target_username)
        );

    ELSE
        RAISE EXCEPTION 'Invalid action: %', p_action;
    END IF;

    RETURN TRUE;
END;
$$;

-- ============================================================================
-- 5. Trigger: auto-set is_sensitive for posts by force_sensitive authors
-- ============================================================================
CREATE OR REPLACE FUNCTION public.enforce_force_sensitive()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = NEW.author_id AND force_sensitive = true
    ) THEN
        NEW.is_sensitive := true;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_force_sensitive_on_posts ON public.posts;
CREATE TRIGGER enforce_force_sensitive_on_posts
    BEFORE INSERT ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_force_sensitive();

-- ============================================================================
-- 6. Filter silenced users from federated timeline
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_federated_timeline(p_user_id uuid, p_limit integer DEFAULT 20, p_max_id text DEFAULT NULL::text) RETURNS TABLE(id text, created_at timestamp with time zone, updated_at timestamp with time zone, content jsonb, content_warning text, language text, author_id text, ap_id text, ap_type text, url text, conversation_id text, visibility text, is_local boolean, is_federated boolean, replies_count integer, reblogs_count integer, favorites_count integer, media_attachments jsonb, metadata jsonb, is_sensitive boolean, author jsonb, is_favorited boolean, is_reblogged boolean, is_bookmarked boolean)
    LANGUAGE plpgsql STABLE
    SECURITY DEFINER
    SET search_path = public
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
        AND (pr.is_silenced = false OR pr.is_silenced IS NULL)
        AND p.in_reply_to IS NULL
        AND (p_max_id IS NULL OR p.created_at < (
            SELECT p2.created_at FROM posts p2 WHERE p2.id::TEXT = p_max_id
        ))

    ORDER BY p.created_at DESC
    LIMIT p_limit;
END;
$$;

-- ============================================================================
-- 7. Update get_enhanced_timeline_posts to filter silenced on non-home timelines
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_enhanced_timeline_posts(p_user_id uuid, p_timeline_type text DEFAULT 'home'::text, p_limit integer DEFAULT 20, p_max_id text DEFAULT NULL::text) RETURNS TABLE(id text, created_at timestamp with time zone, updated_at timestamp with time zone, content jsonb, content_warning text, language text, author_id text, ap_id text, ap_type text, url text, reply_context jsonb, conversation_id text, visibility text, is_local boolean, is_federated boolean, replies_count integer, reblogs_count integer, favorites_count integer, media_attachments jsonb, metadata jsonb, is_sensitive boolean, is_deleted boolean, deleted_at timestamp with time zone, author jsonb, is_favorited boolean, is_reblogged boolean, is_bookmarked boolean, reblog jsonb, reblog_author jsonb)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT
        tp.id::TEXT,
        tp.created_at,
        tp.updated_at,
        tp.content,
        tp.content_warning,
        'en'::TEXT as language,
        (tp.author->>'id')::TEXT as author_id,
        p.ap_id::TEXT,
        COALESCE(p.ap_type, 'Note')::TEXT as ap_type,
        tp.url,
        tp.reply_context,
        tp.conversation_id::TEXT,
        tp.visibility,
        (tp.author->>'is_local')::BOOLEAN as is_local,
        NOT (tp.author->>'is_local')::BOOLEAN as is_federated,
        tp.replies_count,
        tp.reblogs_count,
        tp.favorites_count,
        tp.media_attachments,
        COALESCE(p.metadata, '{}'::JSONB) as metadata,
        tp.is_sensitive,
        COALESCE(p.is_deleted, false) as is_deleted,
        p.deleted_at,
        tp.author,

        COALESCE(fav.user_id IS NOT NULL, false) as is_favorited,
        COALESCE(reb.user_id IS NOT NULL, false) as is_reblogged,
        COALESCE(book.user_id IS NOT NULL, false) as is_bookmarked,

        tp.reblog,
        tp.reblog_author

    FROM timeline_posts tp
    JOIN posts p ON tp.id = p.id
    LEFT JOIN post_interactions fav ON tp.id = fav.post_id
        AND fav.user_id = p_user_id
        AND fav.interaction_type IN ('favorite', 'emoji_reaction')
    LEFT JOIN post_interactions reb ON tp.id = reb.post_id
        AND reb.user_id = p_user_id
        AND reb.interaction_type = 'reblog'
    LEFT JOIN post_interactions book ON tp.id = book.post_id
        AND book.user_id = p_user_id
        AND book.interaction_type = 'bookmark'

    WHERE
        CASE
            WHEN p_timeline_type = 'home' THEN
                EXISTS (
                    SELECT 1 FROM timeline_entries te
                    WHERE te.user_id = p_user_id
                      AND te.post_id = tp.id
                      AND te.timeline_type = 'home'
                )

            WHEN p_timeline_type = 'local' THEN
                tp.visibility = 'public'
                AND (tp.author->>'is_local')::BOOLEAN = true

            WHEN p_timeline_type IN ('public', 'federated') THEN
                tp.visibility = 'public'

            ELSE tp.visibility = 'public'
        END

        AND (
            p_timeline_type = 'home'
            OR NOT EXISTS (
                SELECT 1 FROM profiles spr
                WHERE spr.id = tp.author_id
                  AND spr.is_silenced = true
            )
        )

        AND (p_max_id IS NULL OR tp.created_at < (
            SELECT tp2.created_at FROM timeline_posts tp2 WHERE tp2.id = p_max_id::UUID
        ))

    ORDER BY tp.created_at DESC
    LIMIT p_limit;
END;
$$;

COMMIT;
