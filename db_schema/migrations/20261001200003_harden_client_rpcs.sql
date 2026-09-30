-- Client-callable SECURITY DEFINER functions that trusted caller-supplied identity or had no
-- authorization of their own.
--
-- Supabase's default privileges grant EXECUTE on new public functions to anon and authenticated
-- by name, so REVOKE ... FROM PUBLIC alone leaves a function callable by both. A fresh install
-- (staging included) exposed all six below to anon; production exposes pin_message,
-- unpin_message, send_notification and send_notification_to_user.
--
-- The caller's role is current_setting('role'): PostgREST's SET ROLE survives into a SECURITY
-- DEFINER body, where current_user is the owner.
--
--   update_message_embeds, update_message_content_silent
--       service_role only. Any caller could inject embeds into, or silently rewrite, any message.
--   pin_message, unpin_message
--       a client acts as its own profile; p_user_id is honoured only for trusted roles. A client
--       could pass a moderator's id. DM pins also require an active participant.
--   send_notification
--       service_role only; every SQL caller is SECURITY DEFINER and runs as the owner.
--   send_notification_to_user
--       service_role only. A client could send any type, as any sender, to anyone. Report
--       status notices move to notify_report_update, which takes only a report id.

BEGIN;

SET LOCAL lock_timeout = '3s';

REVOKE ALL ON FUNCTION public.update_message_embeds(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_message_embeds(uuid, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.update_message_content_silent(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_message_content_silent(uuid, jsonb, jsonb) TO service_role;

REVOKE ALL ON FUNCTION public.send_notification(character varying, uuid[], jsonb, uuid, uuid, uuid, uuid, character varying)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_notification(character varying, uuid[], jsonb, uuid, uuid, uuid, uuid, character varying)
    TO service_role;

CREATE OR REPLACE FUNCTION public.pin_message(p_message_id uuid, p_user_id uuid DEFAULT auth.uid()) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
DECLARE
    v_channel_id uuid;
    v_conversation_id uuid;
    v_server_id uuid;
    v_pin_count integer;
    v_max_pins integer := 50; -- Discord-style limit
BEGIN
    -- A client acts as its own profile; p_user_id is honoured only for trusted roles.
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        p_user_id := public.get_current_profile_id();
        IF p_user_id IS NULL THEN
            RAISE EXCEPTION 'Unauthorized: Authentication required';
        END IF;
    END IF;
    -- Get message details
    SELECT channel_id, conversation_id INTO v_channel_id, v_conversation_id
    FROM "public"."messages"
    WHERE id = p_message_id AND NOT is_deleted;
    
    IF v_channel_id IS NULL AND v_conversation_id IS NULL THEN
        RAISE EXCEPTION 'Message not found or already deleted';
    END IF;
    
    -- Check if already pinned
    IF EXISTS (SELECT 1 FROM "public"."messages" WHERE id = p_message_id AND is_pinned = true) THEN
        RETURN true; -- Already pinned
    END IF;
    
    -- For channel messages, check permission and pin limit
    IF v_channel_id IS NOT NULL THEN
        SELECT server_id INTO v_server_id
        FROM "public"."channels"
        WHERE id = v_channel_id;
        
        -- Check pin count
        SELECT COUNT(*) INTO v_pin_count
        FROM "public"."messages"
        WHERE channel_id = v_channel_id AND is_pinned = true;
        
        IF v_pin_count >= v_max_pins THEN
            RAISE EXCEPTION 'Maximum pin limit (%) reached for this channel', v_max_pins;
        END IF;
        
        -- Check permission (PIN_MESSAGES or MANAGE_MESSAGES)
        IF NOT (
            "public"."has_permission"(p_user_id, v_server_id, 'PIN_MESSAGES', v_channel_id)
            OR
            "public"."has_permission"(p_user_id, v_server_id, 'MANAGE_MESSAGES', v_channel_id)
        ) THEN
            RAISE EXCEPTION 'Permission denied: cannot pin messages';
        END IF;
    END IF;
    
    -- For DM conversations, check if user is participant
    IF v_conversation_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM "public"."conversation_participants"
            WHERE conversation_id = v_conversation_id AND user_id = p_user_id AND left_at IS NULL
        ) THEN
            RAISE EXCEPTION 'Permission denied: not a participant in this conversation';
        END IF;
        
        -- Check pin count for DM
        SELECT COUNT(*) INTO v_pin_count
        FROM "public"."messages"
        WHERE conversation_id = v_conversation_id AND is_pinned = true;
        
        IF v_pin_count >= v_max_pins THEN
            RAISE EXCEPTION 'Maximum pin limit (%) reached for this conversation', v_max_pins;
        END IF;
    END IF;
    
    -- Pin the message
    UPDATE "public"."messages"
    SET 
        is_pinned = true,
        pinned_at = NOW(),
        pinned_by = p_user_id
    WHERE id = p_message_id;
    
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.pin_message(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pin_message(uuid, uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.unpin_message(p_message_id uuid, p_user_id uuid DEFAULT auth.uid()) RETURNS boolean
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public, pg_temp
    AS $$
DECLARE
    v_channel_id uuid;
    v_conversation_id uuid;
    v_server_id uuid;
BEGIN
    -- A client acts as its own profile; p_user_id is honoured only for trusted roles.
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        p_user_id := public.get_current_profile_id();
        IF p_user_id IS NULL THEN
            RAISE EXCEPTION 'Unauthorized: Authentication required';
        END IF;
    END IF;
    -- Get message details
    SELECT channel_id, conversation_id INTO v_channel_id, v_conversation_id
    FROM "public"."messages"
    WHERE id = p_message_id;
    
    IF v_channel_id IS NULL AND v_conversation_id IS NULL THEN
        RAISE EXCEPTION 'Message not found';
    END IF;
    
    -- Check if not pinned
    IF NOT EXISTS (SELECT 1 FROM "public"."messages" WHERE id = p_message_id AND is_pinned = true) THEN
        RETURN true; -- Already unpinned
    END IF;
    
    -- For channel messages, check permission
    IF v_channel_id IS NOT NULL THEN
        SELECT server_id INTO v_server_id
        FROM "public"."channels"
        WHERE id = v_channel_id;
        
        -- Check permission (PIN_MESSAGES or MANAGE_MESSAGES)
        IF NOT (
            "public"."has_permission"(p_user_id, v_server_id, 'PIN_MESSAGES', v_channel_id)
            OR
            "public"."has_permission"(p_user_id, v_server_id, 'MANAGE_MESSAGES', v_channel_id)
        ) THEN
            RAISE EXCEPTION 'Permission denied: cannot unpin messages';
        END IF;
    END IF;
    
    -- For DM conversations, check if user is participant
    IF v_conversation_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM "public"."conversation_participants"
            WHERE conversation_id = v_conversation_id AND user_id = p_user_id AND left_at IS NULL
        ) THEN
            RAISE EXCEPTION 'Permission denied: not a participant in this conversation';
        END IF;
    END IF;
    
    -- Unpin the message
    UPDATE "public"."messages"
    SET 
        is_pinned = false,
        pinned_at = NULL,
        pinned_by = NULL
    WHERE id = p_message_id;
    
    RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.unpin_message(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.unpin_message(uuid, uuid) TO authenticated, service_role;

-- send_notification_to_user is server-side: triggers and SECURITY DEFINER functions call it as
-- their owner. Its one client use, telling a reporter that a report changed, goes through
-- notify_report_update, which derives recipient and sender from the report and the caller.
REVOKE ALL ON FUNCTION public.send_notification_to_user(character varying, uuid, jsonb, uuid, uuid, uuid, uuid, character varying)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.send_notification_to_user(character varying, uuid, jsonb, uuid, uuid, uuid, uuid, character varying)
    TO service_role;

-- Sends report_update to the report's reporter. The caller resolved the report or is an
-- instance admin or moderator. The sender is the caller when p_show_resolver, else no one.
-- report_id and status in p_data are overwritten from the report row.
CREATE OR REPLACE FUNCTION public.notify_report_update(
    p_report_id uuid,
    p_data jsonb DEFAULT '{}'::jsonb,
    p_show_resolver boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_reporter uuid;
    v_status text;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Unauthorized: Authentication required';
    END IF;

    SELECT r.reporter_id, r.status INTO v_reporter, v_status
      FROM public.reports r
     WHERE r.id = p_report_id
       AND (r.resolved_by = v_caller OR public.is_current_user_admin_or_mod());

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Unauthorized: not a report this caller may update';
    END IF;
    IF v_reporter IS NULL THEN
        RETURN NULL;
    END IF;

    RETURN public.send_notification_to_user(
        'report_update',
        v_reporter,
        COALESCE(p_data, '{}'::jsonb)
            || jsonb_build_object('report_id', p_report_id, 'status', v_status,
                                  'show_resolver', p_show_resolver),
        NULL, NULL, NULL,
        CASE WHEN p_show_resolver THEN v_caller END,
        'normal'
    );
END;
$$;

REVOKE ALL ON FUNCTION public.notify_report_update(uuid, jsonb, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.notify_report_update(uuid, jsonb, boolean) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
