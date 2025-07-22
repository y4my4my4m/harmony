BEGIN;

-- Migration 050: Fix send_notification Function to Match Actual Notifications Table Schema
-- The user's notifications table only has: id, user_id, type, data, is_read, is_clicked, created_at, updated_at, expires_at, read_at

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
    should_send boolean;
    notification_id uuid;
    current_timestamp timestamp with time zone := now();
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

        -- Get user notification preferences if table exists
        user_prefs := NULL;
        BEGIN
            SELECT * INTO user_prefs
            FROM notification_preferences
            WHERE notification_preferences.user_id = recipient_id;
        EXCEPTION
            WHEN undefined_table THEN
                -- notification_preferences table doesn't exist, send all notifications
                user_prefs := NULL;
        END;

        -- Default to sending notifications if no preferences found
        should_send := true;

        -- Apply preferences if they exist
        IF user_prefs IS NOT NULL THEN
            -- Check type-specific preferences
            CASE notification_type
                WHEN 'mention' THEN
                    should_send := COALESCE(user_prefs.mentions_enabled, true);
                WHEN 'reply' THEN
                    should_send := COALESCE(user_prefs.replies_enabled, true);
                WHEN 'dm' THEN
                    should_send := COALESCE(user_prefs.dms_enabled, true);
                WHEN 'follow' THEN
                    should_send := COALESCE(user_prefs.follows_enabled, true);
                WHEN 'like' THEN
                    should_send := COALESCE(user_prefs.likes_enabled, true);
                WHEN 'reblog' THEN
                    should_send := COALESCE(user_prefs.reblogs_enabled, true);
                WHEN 'reaction' THEN
                    should_send := COALESCE(user_prefs.reactions_enabled, true);
                ELSE
                    should_send := true; -- Default to sending for unknown types
            END CASE;

            -- Apply DND restrictions if configured
            IF user_prefs.dnd_enabled IS TRUE THEN
                IF current_timestamp::time BETWEEN 
                   COALESCE(user_prefs.dnd_start_time, '22:00'::time) AND 
                   COALESCE(user_prefs.dnd_end_time, '08:00'::time) THEN
                    should_send := false;
                END IF;
            END IF;
        END IF;

        -- Create enhanced notification data with context
        enhanced_data := notification_data;
        
        -- Add context information to the data field since we can't use separate columns
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
        
        IF priority IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('priority', priority);
        END IF;

        -- Create notification if should send - using ONLY existing columns
        IF should_send THEN
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
            
            RAISE NOTICE '✅ Notification sent: type=% to_user=% id=%', notification_type, recipient_id, notification_id;
        ELSE
            RAISE NOTICE '🔇 Notification skipped (user preferences): type=% to_user=%', notification_type, recipient_id;
        END IF;

    END LOOP;

    RETURN created_notification_ids;
END;
$$;

COMMENT ON FUNCTION public.send_notification(character varying, uuid[], jsonb, uuid, uuid, uuid, uuid, character varying) IS 
'SECURITY DEFINER: Unified notification function that matches the actual notifications table schema (id, user_id, type, data, is_read, is_clicked, created_at, updated_at, expires_at, read_at). Context information is stored in the data JSONB field.';

COMMIT;