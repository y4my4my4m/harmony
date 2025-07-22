-- Migration 075: Clean DM Fix
-- Fix incoming DM processing only - the local display issue is frontend, not database

BEGIN;

-- Fix handle_incoming_messages to use conversation_participants properly
CREATE OR REPLACE FUNCTION public.handle_incoming_messages(
    activity_id uuid, 
    activity_data jsonb, 
    actor_profile record, 
    instance_domain text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_object JSONB;
    v_content JSONB;
    v_mentioned_users TEXT[];
    v_local_user_ids UUID[];
    v_all_participants UUID[];
    v_conversation_id UUID;
    v_message_id UUID;
BEGIN
    v_object := activity_data->'object';
    
    -- Extract mentioned local users from tags and addressing
    SELECT ARRAY_AGG(DISTINCT username) INTO v_mentioned_users
    FROM (
        SELECT CASE 
            WHEN tag->>'href' LIKE 'https://' || instance_domain || '/users/%' THEN
                substring(tag->>'href' from 'https://' || instance_domain || '/users/([^/]+)')
            ELSE NULL
        END as username
        FROM jsonb_array_elements(COALESCE(v_object->'tag', '[]'::jsonb)) AS tag
        WHERE tag->>'type' = 'Mention'
        UNION
        SELECT CASE 
            WHEN recipient LIKE 'https://' || instance_domain || '/users/%' THEN
                substring(recipient from 'https://' || instance_domain || '/users/([^/]+)')
            ELSE NULL
        END as username
        FROM (
            SELECT jsonb_array_elements_text(COALESCE(v_object->'to', '[]'::jsonb)) as recipient
            UNION ALL
            SELECT jsonb_array_elements_text(COALESCE(v_object->'cc', '[]'::jsonb)) as recipient
        ) recipients
    ) t 
    WHERE username IS NOT NULL;

    IF v_mentioned_users IS NULL OR array_length(v_mentioned_users, 1) = 0 THEN
        RETURN;
    END IF;
    
    -- Get local user IDs (local users have domain = NULL)
    SELECT ARRAY_AGG(p.id) INTO v_local_user_ids
    FROM profiles p
    WHERE p.username = ANY(v_mentioned_users)
      AND p.domain IS NULL
      AND p.is_local = true;
    
    IF v_local_user_ids IS NULL OR array_length(v_local_user_ids, 1) = 0 THEN
        RETURN;
    END IF;

    -- Create participant list: remote sender + local recipients
    v_all_participants := ARRAY[actor_profile.id] || v_local_user_ids;

    -- Find existing conversation with exact participants
    SELECT c.id INTO v_conversation_id
    FROM conversations c
    WHERE c.type = CASE WHEN array_length(v_all_participants, 1) = 2 THEN 'direct' ELSE 'group' END
      AND (SELECT COUNT(*) FROM conversation_participants cp WHERE cp.conversation_id = c.id AND cp.left_at IS NULL) = array_length(v_all_participants, 1)
      AND NOT EXISTS (
          SELECT 1 FROM unnest(v_all_participants) AS required_participant(participant_id)
          WHERE NOT EXISTS (
              SELECT 1 FROM conversation_participants cp 
              WHERE cp.conversation_id = c.id 
                AND cp.user_id = required_participant.participant_id 
                AND cp.left_at IS NULL
          )
      )
    LIMIT 1;

    -- Create conversation if not found
    IF v_conversation_id IS NULL THEN
        INSERT INTO conversations (type, created_by, name)
        VALUES (
            CASE WHEN array_length(v_all_participants, 1) = 2 THEN 'direct' ELSE 'group' END,
            actor_profile.id,
            CASE WHEN array_length(v_all_participants, 1) > 2 THEN 'Group Chat' ELSE NULL END
        )
        RETURNING id INTO v_conversation_id;
        
        INSERT INTO conversation_participants (conversation_id, user_id, role)
        SELECT v_conversation_id, participant_id, 'member'
        FROM unnest(v_all_participants) AS participants(participant_id);
    END IF;

    -- Convert content and save message
    v_content := convert_ap_to_jsonb(v_object->>'content', v_object->'tag');
    
    INSERT INTO messages (conversation_id, user_id, content, created_at, metadata)
    VALUES (
        v_conversation_id,
        actor_profile.id,
        v_content,
        COALESCE((v_object->>'published')::timestamptz, NOW()),
        jsonb_build_object(
            'federated', true,
            'ap_id', v_object->>'id',
            'activity_id', activity_id
        )
    );
END;
$function$;

COMMIT;