-- Fix notification database functions to use is_read instead of read_at
-- This fixes the issue where functions were returning incorrect results

-- 1. Fix get_unread_notification_count function
CREATE OR REPLACE FUNCTION public.get_unread_notification_count(p_user_id uuid) 
RETURNS integer
LANGUAGE sql STABLE
AS $$
    SELECT COUNT(*)::integer
    FROM notifications n
    WHERE n.user_id = p_user_id
    AND n.is_read = FALSE;
$$;

-- 2. Fix get_user_notifications function
CREATE OR REPLACE FUNCTION public.get_user_notifications(
    p_user_id uuid, 
    p_limit integer DEFAULT 20, 
    p_offset integer DEFAULT 0, 
    p_unread_only boolean DEFAULT false, 
    p_notification_types character varying[] DEFAULT NULL::character varying[]
) 
RETURNS TABLE(
    id uuid, 
    user_id uuid, 
    type character varying, 
    data jsonb, 
    is_read boolean, 
    is_clicked boolean, 
    created_at timestamp with time zone, 
    updated_at timestamp with time zone, 
    expires_at timestamp with time zone, 
    read_at timestamp with time zone
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        n.id,
        n.user_id,
        n.type,
        n.data,
        n.is_read,
        n.is_clicked,
        n.created_at,
        n.updated_at,
        n.expires_at,
        n.read_at
    FROM notifications n
    WHERE n.user_id = p_user_id
    AND (NOT p_unread_only OR n.is_read = FALSE)
    AND (p_notification_types IS NULL OR n.type = ANY(p_notification_types))
    ORDER BY n.created_at DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;

-- 3. Fix mark_notifications_read function
CREATE OR REPLACE FUNCTION public.mark_notifications_read(
    p_user_id uuid, 
    p_notification_ids uuid[] DEFAULT NULL::uuid[]
) 
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    updated_count integer;
BEGIN
    IF p_notification_ids IS NULL THEN
        -- Mark all unread notifications as read
        UPDATE notifications 
        SET read_at = now(), is_read = true, updated_at = now()
        WHERE user_id = p_user_id 
        AND is_read = FALSE;
    ELSE
        -- Mark specific notifications as read
        UPDATE notifications 
        SET read_at = now(), is_read = true, updated_at = now()
        WHERE user_id = p_user_id 
        AND id = ANY(p_notification_ids)
        AND is_read = FALSE;
    END IF;
    
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$;
