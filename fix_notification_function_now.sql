-- URGENT FIX: Replace the broken send_notification function immediately
-- Run this directly in your Supabase SQL editor

CREATE OR REPLACE FUNCTION public.send_notification(
    notification_type character varying, 
    to_user_ids uuid[], 
    notification_data jsonb DEFAULT '{}'::jsonb, 
    server_id uuid DEFAULT NULL::uuid, 
    channel_id uuid DEFAULT NULL::uuid, 
    conversation_id uuid DEFAULT NULL::uuid, 
    from_user_id uuid DEFAULT NULL::uuid, 
    priority character varying DEFAULT 'normal'::character varying
) RETURNS uuid[]
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    created_notification_ids uuid[] := '{}';
    recipient_id uuid;
    user_prefs record;
    channel_prefs record;
    should_send boolean;
    notification_id uuid;
    current_timestamp timestamp with time zone := now();
    is_dnd_time boolean;
    enhanced_data jsonb;
BEGIN
    -- Validate inputs
    IF notification_type IS NULL OR array_length(to_user_ids, 1) IS NULL THEN
        RETURN '{}';
    END IF;

    -- Process each recipient
    FOREACH recipient_id IN ARRAY to_user_ids
    LOOP
        -- Skip if sending to self (optional check)
        IF from_user_id IS NOT NULL AND recipient_id = from_user_id THEN
            CONTINUE;
        END IF;

        -- Get user notification preferences (now allowed due to SECURITY DEFINER)
        SELECT * INTO user_prefs 
        FROM notification_preferences 
        WHERE notification_preferences.user_id = recipient_id;

        -- If no preferences found, create defaults and fetch them
        IF user_prefs IS NULL THEN
            PERFORM create_default_notification_preferences(recipient_id);
            SELECT * INTO user_prefs 
            FROM notification_preferences 
            WHERE notification_preferences.user_id = recipient_id;
            
            -- If still null after creation, skip this user
            IF user_prefs IS NULL THEN
                CONTINUE;
            END IF;
        END IF;

        -- Check DND (Do Not Disturb) settings
        is_dnd_time := false;
        IF user_prefs.dnd_enabled THEN
            is_dnd_time := (
                current_timestamp::time BETWEEN user_prefs.dnd_start_time AND user_prefs.dnd_end_time
            );
        END IF;

        -- Get channel/server specific preferences if applicable
        channel_prefs := NULL;
        IF channel_id IS NOT NULL OR server_id IS NOT NULL OR conversation_id IS NOT NULL THEN
            SELECT * INTO channel_prefs
            FROM notification_channels nc
            WHERE nc.user_id = recipient_id
            AND (
                nc.channel_id = channel_id OR
                nc.server_id = server_id OR
                nc.conversation_id = conversation_id
            );
        END IF;

        -- Determine if notification should be sent based on preferences
        should_send := true;

        -- Check type-specific preferences
        CASE notification_type
            WHEN 'mention' THEN
                should_send := user_prefs.mentions_enabled;
            WHEN 'reply' THEN
                should_send := user_prefs.replies_enabled;
            WHEN 'dm' THEN
                should_send := user_prefs.dms_enabled;
            WHEN 'follow' THEN
                should_send := user_prefs.follows_enabled;
            WHEN 'like' THEN
                should_send := user_prefs.likes_enabled;
            WHEN 'reblog' THEN
                should_send := user_prefs.reblogs_enabled;
            WHEN 'reaction' THEN
                should_send := user_prefs.reactions_enabled;
            ELSE
                should_send := true; -- Default to sending for unknown types
        END CASE;

        -- Apply DND restrictions
        IF is_dnd_time THEN
            should_send := false;
        END IF;

        -- Apply channel-specific overrides
        IF channel_prefs IS NOT NULL THEN
            IF channel_prefs.muted THEN
                should_send := false;
            END IF;
        END IF;

        -- Create notification if should send
        IF should_send THEN
            -- Enhance notification data with contextual information
            enhanced_data := notification_data;
            
            -- Add contextual metadata to the data JSON
            IF server_id IS NOT NULL THEN
                enhanced_data := enhanced_data || jsonb_build_object('server_id', server_id);
            END IF;
            
            IF channel_id IS NOT NULL THEN
                enhanced_data := enhanced_data || jsonb_build_object('channel_id', channel_id);
            END IF;
            
            IF conversation_id IS NOT NULL THEN
                enhanced_data := enhanced_data || jsonb_build_object('conversation_id', conversation_id);
            END IF;
            
            IF from_user_id IS NOT NULL THEN
                enhanced_data := enhanced_data || jsonb_build_object('from_user_id', from_user_id);
            END IF;
            
            IF priority IS NOT NULL AND priority != 'normal' THEN
                enhanced_data := enhanced_data || jsonb_build_object('priority', priority);
            END IF;

            -- 🚀 FIXED: Insert into existing table schema (only columns that exist)
            INSERT INTO notifications (
                type,
                user_id,
                data,
                created_at
            ) VALUES (
                notification_type,
                recipient_id,
                enhanced_data,
                current_timestamp
            ) RETURNING id INTO notification_id;

            created_notification_ids := array_append(created_notification_ids, notification_id);
        END IF;

    END LOOP;

    RETURN created_notification_ids;
END;
$$;