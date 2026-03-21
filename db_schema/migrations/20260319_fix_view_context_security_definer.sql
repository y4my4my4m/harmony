BEGIN;

-- is_user_viewing_context is called from within send_notification_to_user,
-- which itself runs inside message INSERT triggers. The trigger session belongs
-- to the SENDER, but this function needs to read the RECIPIENT's row in
-- user_view_contexts. Without SECURITY DEFINER the RLS policy
-- "user_view_contexts_own_user" blocks the read and the function always
-- returns FALSE, causing duplicate notifications for actively-viewed contexts.

CREATE OR REPLACE FUNCTION public.is_user_viewing_context(
    p_user_id uuid,
    p_server_id uuid DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER
AS $$
DECLARE
    v_view_context RECORD;
BEGIN
    SELECT * INTO v_view_context
    FROM public.user_view_contexts
    WHERE user_id = p_user_id;

    IF NOT FOUND THEN
        RETURN FALSE;
    END IF;

    -- Check if viewing the exact server channel
    IF p_server_id IS NOT NULL AND p_channel_id IS NOT NULL THEN
        IF v_view_context.view_type = 'server_channel' AND
           v_view_context.server_id = p_server_id AND
           v_view_context.channel_id = p_channel_id THEN
            RETURN TRUE;
        END IF;
    END IF;

    -- Check if viewing the exact DM conversation
    IF p_conversation_id IS NOT NULL THEN
        IF v_view_context.view_type = 'dm' AND
           v_view_context.conversation_id = p_conversation_id THEN
            RETURN TRUE;
        END IF;
    END IF;

    RETURN FALSE;
END;
$$;

COMMENT ON FUNCTION public.is_user_viewing_context(uuid, uuid, uuid, uuid)
IS 'SECURITY DEFINER: Checks if user is viewing a specific channel/DM. Used by send_notification to suppress notifications at database level. Needs SECURITY DEFINER to bypass RLS when called from message triggers running as the sender.';

COMMIT;

NOTIFY pgrst, 'reload schema';
