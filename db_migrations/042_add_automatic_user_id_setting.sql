-- Migration 042: Add database functions for message creation
-- This allows us to trust database RLS completely

BEGIN;

-- ============================================================================
-- Add functions to create messages with automatic user_id from auth.uid()
-- ============================================================================

-- Function to create channel messages
CREATE OR REPLACE FUNCTION public.create_channel_message(
    p_channel_id uuid,
    p_content jsonb,
    p_reply_to uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_message_id uuid;
BEGIN
    INSERT INTO messages (
        user_id,
        channel_id,
        content,
        reply_to,
        metadata
    ) VALUES (
        auth.uid(),
        p_channel_id,
        p_content,
        p_reply_to,
        jsonb_build_object('created_via', 'harmony_client')
    ) RETURNING id INTO v_message_id;
    
    RETURN v_message_id;
END;
$function$;

-- Function to create DM messages
CREATE OR REPLACE FUNCTION public.create_dm_message(
    p_conversation_id uuid,
    p_content jsonb,
    p_reply_to uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_message_id uuid;
BEGIN
    INSERT INTO messages (
        user_id,
        conversation_id,
        content,
        reply_to,
        metadata
    ) VALUES (
        auth.uid(),
        p_conversation_id,
        p_content,
        p_reply_to,
        jsonb_build_object('created_via', 'harmony_client')
    ) RETURNING id INTO v_message_id;
    
    RETURN v_message_id;
END;
$function$;

COMMIT;