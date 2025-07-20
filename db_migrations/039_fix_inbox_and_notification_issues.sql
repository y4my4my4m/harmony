-- Migration 039: Fix inbox processing issues
-- 1. Fix missing parse_activitypub_dm_content_to_jsonb function
-- 2. Remove server_id references from notifications table code

BEGIN;

-- ============================================================================
-- FIX 1: Replace missing parse_activitypub_dm_content_to_jsonb with convert_ap_to_jsonb
-- ============================================================================

-- Fix the handle_incoming_messages function to use the correct function
CREATE OR REPLACE FUNCTION public.handle_incoming_messages(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_object JSONB;
    v_content JSONB;
    v_mentioned_users TEXT[];
    v_username TEXT;
    v_local_user RECORD;
    v_conversation_id UUID;
    v_message_id UUID;
    v_directly_addressed TEXT[];
    v_all_recipients TEXT[];
    v_recipient TEXT;
    v_user_match TEXT;
    v_profile_match TEXT;
BEGIN
    RAISE NOTICE '📩 Processing ActivityPub direct message from %@%', 
        actor_profile.username, actor_profile.domain;
    
    v_object := activity_data->'object';
    
    -- Extract mentioned local users from tags
    SELECT ARRAY_AGG(DISTINCT username) INTO v_mentioned_users
    FROM (
        SELECT CASE 
            WHEN tag->>'href' LIKE 'https://' || instance_domain || '/users/%' THEN
                substring(tag->>'href' from 'https://' || instance_domain || '/users/([^/]+)')
            WHEN tag->>'href' LIKE 'https://' || instance_domain || '/social/profile/%' THEN
                substring(tag->>'href' from 'https://' || instance_domain || '/social/profile/([^/]+)')
            ELSE NULL
        END as username
        FROM jsonb_array_elements(COALESCE(v_object->'tag', '[]'::jsonb)) AS tag
        WHERE tag->>'type' = 'Mention'
    ) t 
    WHERE username IS NOT NULL;

    -- Also check direct addressing in 'to' and 'cc' fields
    SELECT ARRAY_AGG(DISTINCT username) INTO v_directly_addressed
    FROM (
        SELECT CASE 
            WHEN recipient LIKE 'https://' || instance_domain || '/users/%' THEN
                substring(recipient from 'https://' || instance_domain || '/users/([^/]+)')
            WHEN recipient LIKE 'https://' || instance_domain || '/social/profile/%' THEN
                substring(recipient from 'https://' || instance_domain || '/social/profile/([^/]+)')
            ELSE NULL
        END as username
        FROM (
            SELECT jsonb_array_elements_text(COALESCE(v_object->'to', '[]'::jsonb)) as recipient
            UNION ALL
            SELECT jsonb_array_elements_text(COALESCE(v_object->'cc', '[]'::jsonb)) as recipient
        ) recipients
    ) t 
    WHERE username IS NOT NULL;

    -- Combine all recipients
    v_all_recipients := COALESCE(v_mentioned_users, ARRAY[]::TEXT[]) || COALESCE(v_directly_addressed, ARRAY[]::TEXT[]);
    
    -- Remove duplicates
    SELECT ARRAY_AGG(DISTINCT username) INTO v_all_recipients
    FROM unnest(v_all_recipients) AS username;
    
    IF v_all_recipients IS NULL OR array_length(v_all_recipients, 1) = 0 THEN
        RAISE WARNING 'Direct message has no local recipients - skipping';
        RETURN;
    END IF;

    RAISE NOTICE '📧 DM mentions % local users: %', array_length(v_all_recipients, 1), v_all_recipients;
    
    -- ✅ FIX: Use convert_ap_to_jsonb instead of missing parse_activitypub_dm_content_to_jsonb
    v_content := convert_ap_to_jsonb(
        v_object->>'content', 
        v_object->'tag'
    );
    
    -- Process each mentioned local user
    FOREACH v_username IN ARRAY v_all_recipients LOOP
        -- ✅ FIX: Corrected local user lookup (domain should be NULL for local users)
        SELECT * INTO v_local_user
        FROM profiles 
        WHERE username = v_username 
          AND domain IS NULL  -- Local users have domain = NULL
          AND is_local = true;

        IF NOT FOUND THEN
            RAISE WARNING 'Local user not found: %@%', v_username, instance_domain;
            CONTINUE;
        END IF;

        RAISE NOTICE '📨 Processing DM for local user: %', v_username;

        -- Find or create conversation between remote sender and local recipient
        SELECT c.id INTO v_conversation_id
        FROM conversations c
        WHERE c.type = 'direct'
          AND EXISTS (
            SELECT 1 FROM conversation_participants cp1
            WHERE cp1.conversation_id = c.id 
              AND cp1.user_id = actor_profile.id 
              AND cp1.left_at IS NULL
          )
          AND EXISTS (
            SELECT 1 FROM conversation_participants cp2
            WHERE cp2.conversation_id = c.id 
              AND cp2.user_id = v_local_user.id 
              AND cp2.left_at IS NULL
          )
          AND (
            SELECT COUNT(*) FROM conversation_participants cp3
            WHERE cp3.conversation_id = c.id 
              AND cp3.left_at IS NULL
          ) = 2;

        IF NOT FOUND THEN
            -- Create new conversation
            INSERT INTO conversations (type, created_by, is_active)
            VALUES ('direct', actor_profile.id, TRUE)
            RETURNING id INTO v_conversation_id;
            
            -- Add both participants
            INSERT INTO conversation_participants (conversation_id, user_id, role, joined_at)
            VALUES 
              (v_conversation_id, actor_profile.id, 'member', NOW()),
              (v_conversation_id, v_local_user.id, 'member', NOW());
            
            RAISE NOTICE '🆕 Created new conversation: %', v_conversation_id;
        ELSE
            RAISE NOTICE '📝 Found existing conversation: %', v_conversation_id;
        END IF;

        -- Insert the DM message
        INSERT INTO messages (
            conversation_id,
            user_id,
            content,
            created_at,
            is_system,
            metadata
        ) VALUES (
            v_conversation_id,
            actor_profile.id,
            v_content,
            COALESCE((v_object->>'published')::timestamptz, NOW()),
            false,
            jsonb_build_object(
                'federated', true,
                'ap_id', v_object->>'id',
                'ap_type', 'Note',
                'from_domain', actor_profile.domain,
                'original_url', COALESCE(v_object->>'url', v_object->>'id'),
                'actor_ap_id', actor_profile.federated_id,
                'activity_id', activity_id
            )
        ) RETURNING id INTO v_message_id;

        RAISE NOTICE '✅ Saved federated DM %: %@% -> %', 
            v_message_id, actor_profile.username, actor_profile.domain, v_username;

        -- Note: DM notifications will be handled by existing message triggers
        -- No need to manually create notifications here
    END LOOP;
    
    RAISE NOTICE '🎯 Completed DM processing for activity %', activity_id;
END;
$function$;

-- ============================================================================
-- FIX 2: Fix create_notification_structured function to remove server_id column reference
-- ============================================================================

-- Update the create_notification_structured function to not reference server_id
CREATE OR REPLACE FUNCTION public.create_notification_structured(
    p_user_id uuid,
    p_type character varying,
    p_data jsonb DEFAULT '{}'::jsonb,
    p_channel_id uuid DEFAULT NULL::uuid,
    p_conversation_id uuid DEFAULT NULL::uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_notification_id UUID;
    v_should_create BOOLEAN;
    v_existing_count INTEGER;
    v_time_threshold TIMESTAMP WITH TIME ZONE;
BEGIN
    -- Set appropriate time threshold based on notification type
    v_time_threshold := CASE p_type
        WHEN 'mention' THEN NOW() - INTERVAL '5 minutes'
        WHEN 'reply' THEN NOW() - INTERVAL '5 minutes'
        WHEN 'dm' THEN NOW() - INTERVAL '2 minutes'
        WHEN 'follow' THEN NOW() - INTERVAL '10 minutes'
        ELSE NOW() - INTERVAL '1 minute'
    END;

    -- Check for spam/duplicate notifications
    SELECT COUNT(*) INTO v_existing_count
    FROM notifications n
    WHERE n.user_id = p_user_id
      AND n.type = p_type
      AND n.created_at > v_time_threshold
      AND (
          -- For mentions/replies, check if same source mentioned/replied to same target
          (p_type IN ('mention', 'reply') AND 
           n.data->>'sender'->>'user_id' = p_data->'sender'->>'user_id') OR
          -- For DMs, check if same conversation
          (p_type = 'dm' AND 
           n.data->'conversation'->>'id' = p_data->'conversation'->>'id') OR
          -- For follows, check if same follower
          (p_type = 'follow' AND 
           n.data->'follower'->>'user_id' = p_data->'follower'->>'user_id')
      );

    -- Don't create notification if too many recent similar notifications
    IF v_existing_count >= 3 THEN
        RAISE NOTICE 'Suppressing duplicate notification: type=%, user=%, recent_count=%', 
            p_type, p_user_id, v_existing_count;
        RETURN NULL;
    END IF;

    -- ✅ FIX: Insert notification without server_id column
    INSERT INTO notifications (
        user_id,
        type,
        data
    ) VALUES (
        p_user_id,
        p_type,
        p_data
    ) RETURNING id INTO v_notification_id;

    RAISE NOTICE '✅ Created notification: id=%, type=%, user=%', 
        v_notification_id, p_type, p_user_id;

    RETURN v_notification_id;
END;
$function$;

COMMIT;