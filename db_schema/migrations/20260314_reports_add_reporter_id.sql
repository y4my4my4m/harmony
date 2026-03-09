-- =============================================================================
-- Migration: Add reporter_id to get_reports_with_details RPC
-- =============================================================================
-- So admin panel can render reporter display names with custom emojis (DisplayName).
-- =============================================================================

BEGIN;

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
    reported_user_username text,
    reported_user_display_name text,
    reported_user_avatar_url text,
    reported_post_preview text,
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
LANGUAGE plpgsql STABLE SECURITY DEFINER
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
        reported_user.username::text,
        reported_user.display_name::text,
        reported_user.avatar_url::text,
        CASE
            WHEN r.reported_post_id IS NOT NULL THEN
                LEFT(
                    COALESCE(
                        (SELECT p.content->0->>'text' FROM public.posts p WHERE p.id = r.reported_post_id),
                        '[Post content unavailable]'
                    ),
                    200
                )
            ELSE NULL
        END::text,
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

COMMIT;

NOTIFY pgrst, 'reload schema';
