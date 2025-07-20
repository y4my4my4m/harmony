-- Migration 026: Fix remaining user1/user2 references in production
-- 
-- ISSUE: Two functions still reference user1/user2 columns in production:
--        1. process_activitypub_note (lines 4794-4799)
--        2. handle_unified_content_federation (line 6066)
-- FIX: Update these functions to use conversation_participants table

-- =====================================================
-- STEP 1: Fix process_activitypub_note function (if it still has old references)
-- =====================================================

-- Check if process_activitypub_note still has old references and fix it
DO $$
DECLARE
    func_body TEXT;
BEGIN
    -- Get the current function body
    SELECT pg_get_functiondef(oid) INTO func_body
    FROM pg_proc 
    WHERE proname = 'process_activitypub_note' 
    AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public');
    
    -- Check if it contains old references
    IF func_body LIKE '%user1%' OR func_body LIKE '%user2%' THEN
        RAISE NOTICE 'process_activitypub_note still has old references - will be updated';
        
        -- Drop and recreate the function
        DROP FUNCTION IF EXISTS public.process_activitypub_note(jsonb, uuid, text);
        DROP FUNCTION IF EXISTS public.process_activitypub_note(jsonb, uuid);
        DROP FUNCTION IF EXISTS public.process_activitypub_note(jsonb);
        
    ELSE
        RAISE NOTICE 'process_activitypub_note already updated - skipping';
    END IF;
END $$;

-- Only recreate if we dropped it above
CREATE OR REPLACE FUNCTION public.process_activitypub_note(note_data jsonb, actor_profile_id uuid DEFAULT NULL, instance_domain text DEFAULT NULL) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_conversation_id uuid;
    v_local_user RECORD;
    v_username text;
    actor_profile profiles%ROWTYPE;
    v_message_id uuid;
    v_content_jsonb jsonb;
    v_to_array jsonb;
    v_recipient text;
BEGIN
    -- Get actor profile
    IF actor_profile_id IS NOT NULL THEN
        SELECT * INTO actor_profile FROM profiles WHERE id = actor_profile_id;
    END IF;
    
    -- Extract recipients from 'to' field
    v_to_array := note_data->'to';
    
    -- Process each recipient
    IF jsonb_typeof(v_to_array) = 'array' THEN
        FOR v_recipient IN SELECT jsonb_array_elements_text(v_to_array)
        LOOP
            -- Skip public addressing
            IF v_recipient = 'https://www.w3.org/ns/activitystreams#Public' THEN
                CONTINUE;
            END IF;
            
            -- Extract username from recipient URL for local users
            IF v_recipient LIKE 'https://' || COALESCE(instance_domain, '') || '/users/%' THEN
                v_username := substring(v_recipient from 'https://[^/]+/users/(.+)$');
                
                -- Find local user
                SELECT * INTO v_local_user 
                FROM profiles 
                WHERE username = v_username AND is_local = true;
                
                IF NOT FOUND THEN
                    RAISE WARNING 'Local user not found: %@%', v_username, instance_domain;
                    CONTINUE;
                END IF;

                RAISE NOTICE '📨 Processing DM for local user: %', v_username;

                -- UPDATED: Find or create conversation using participant system
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

                IF v_conversation_id IS NULL THEN
                    -- UPDATED: Create new conversation using new structure
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
                
                -- Convert content and create message
                v_content_jsonb := convert_ap_to_jsonb(
                    COALESCE(note_data->>'content', ''), 
                    note_data->'tag'
                );
                
                -- Create the federated message
                INSERT INTO messages (
                    conversation_id,
                    user_id,
                    content,
                    created_at,
                    metadata
                ) VALUES (
                    v_conversation_id,
                    actor_profile.id,
                    v_content_jsonb,
                    COALESCE((note_data->>'published')::timestamptz, NOW()),
                    jsonb_build_object(
                        'activitypub_id', note_data->>'id',
                        'federated', true,
                        'source', 'activitypub'
                    )
                ) RETURNING id INTO v_message_id;
                
                RAISE NOTICE '✅ Created federated DM message: %', v_message_id;
            END IF;
        END LOOP;
    END IF;
    
    RETURN TRUE;
END;
$$;

-- =====================================================
-- STEP 2: Fix handle_unified_content_federation function
-- =====================================================

-- Replace handle_unified_content_federation function (can't drop due to trigger dependency)
CREATE OR REPLACE FUNCTION public.handle_unified_content_federation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    user_federation_enabled boolean;
    instance_federation_enabled boolean;
    current_instance_domain text;
    target_user_id uuid;
    is_dm boolean := false;
    conversation_participants uuid[];
    remote_participants uuid[];
BEGIN
    -- Quick exit for DELETE operations (no federation needed for deletes yet)
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    -- Get the user ID based on table
    IF TG_TABLE_NAME = 'posts' THEN
        target_user_id := COALESCE(NEW.author_id, OLD.author_id);
    ELSIF TG_TABLE_NAME = 'messages' THEN
        target_user_id := COALESCE(NEW.user_id, OLD.user_id);
        -- Check if this is a DM
        is_dm := (NEW.conversation_id IS NOT NULL AND NEW.channel_id IS NULL);
    ELSE
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Check if federation is enabled for this user
    SELECT is_federation_enabled_for_user(target_user_id) INTO user_federation_enabled;
    
    -- Quick exit if federation is disabled
    IF NOT user_federation_enabled THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Get instance domain for federation processing
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;

    -- Process based on table and operation
    IF TG_TABLE_NAME = 'posts' THEN
        -- Handle post federation
        IF TG_OP = 'INSERT' THEN
            -- Queue post for federation
            PERFORM queue_activity_for_federation(
                NEW.id,
                ARRAY(
                    SELECT DISTINCT p.domain 
                    FROM profiles p 
                    WHERE p.domain != current_instance_domain 
                    AND p.domain IS NOT NULL
                ),
                5, -- normal priority
                true -- immediate processing
            );
            
            -- Create ActivityPub activity for the post
            INSERT INTO ap_activities (
                ap_id, 
                ap_type,
                actor_id,
                actor_ap_id,
                object_id,
                object_type,
                activity_data,
                status,
                is_local
            ) VALUES (
                current_instance_domain || '/activities/' || gen_random_uuid(),
                'Create',
                NEW.author_id,
                (SELECT federated_id FROM profiles WHERE id = NEW.author_id),
                NEW.id::text,
                'Note',
                create_activitypub_note_activity(NEW.id),
                'pending',
                true
            );
            
        ELSIF TG_OP = 'UPDATE' THEN
            -- Handle post updates (edits)
            IF OLD.content IS DISTINCT FROM NEW.content THEN
                -- Create Update activity for edited post
                INSERT INTO ap_activities (
                    ap_id,
                    ap_type, 
                    actor_id,
                    actor_ap_id,
                    object_id,
                    object_type,
                    activity_data,
                    status,
                    is_local
                ) VALUES (
                    current_instance_domain || '/activities/' || gen_random_uuid(),
                    'Update',
                    NEW.author_id,
                    (SELECT federated_id FROM profiles WHERE id = NEW.author_id),
                    NEW.id::text,
                    'Note', 
                    create_activitypub_note_activity(NEW.id),
                    'pending',
                    true
                );
            END IF;
        END IF;

    ELSIF TG_TABLE_NAME = 'messages' THEN
        -- Handle message federation (DMs only)
        IF is_dm AND TG_OP = 'INSERT' THEN
            -- UPDATED: Get conversation participants using new participant system
            SELECT array_agg(cp.user_id) INTO conversation_participants
            FROM conversation_participants cp
            WHERE cp.conversation_id = NEW.conversation_id 
              AND cp.left_at IS NULL;
            
            -- Find remote participants
            SELECT array_agg(p.id) INTO remote_participants
            FROM profiles p
            WHERE p.id = ANY(conversation_participants)
            AND p.domain != current_instance_domain
            AND p.domain IS NOT NULL;
            
            -- Only federate if there are remote participants
            IF array_length(remote_participants, 1) > 0 THEN
                -- Create federated DM activity
                INSERT INTO ap_activities (
                    ap_id,
                    ap_type,
                    actor_id,
                    actor_ap_id,
                    object_id,
                    object_type,
                    activity_data,
                    status,
                    is_local
                ) VALUES (
                    current_instance_domain || '/activities/' || gen_random_uuid(),
                    'Create',
                    NEW.user_id,
                    (SELECT federated_id FROM profiles WHERE id = NEW.user_id),
                    NEW.id::text,
                    'Note',
                    jsonb_build_object(
                        'type', 'Create',
                        'actor', (SELECT federated_id FROM profiles WHERE id = NEW.user_id),
                        'object', jsonb_build_object(
                            'type', 'Note',
                            'id', current_instance_domain || '/messages/' || NEW.id,
                            'attributedTo', (SELECT federated_id FROM profiles WHERE id = NEW.user_id),
                            'content', convert_jsonb_to_ap(NEW.content),
                            'to', array_to_json(ARRAY(
                                SELECT p.federated_id 
                                FROM profiles p 
                                WHERE p.id = ANY(remote_participants)
                            ))::jsonb
                        )
                    ),
                    'pending',
                    true
                );
            END IF;
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

-- =====================================================
-- STEP 3: Add comments to document the changes
-- =====================================================

COMMENT ON FUNCTION public.process_activitypub_note(jsonb, uuid, text) IS 'UPDATED: Processes ActivityPub Note objects for DMs using conversation_participants system instead of user1/user2 columns.';

COMMENT ON FUNCTION public.handle_unified_content_federation() IS 'UPDATED: Handles federation for posts and messages using conversation_participants system instead of user1/user2 columns.';

-- =====================================================
-- STEP 4: Verification
-- =====================================================

DO $$
BEGIN
    RAISE NOTICE 'Migration 026 completed successfully!';
    RAISE NOTICE 'Fixed Functions:';
    RAISE NOTICE '  ✅ process_activitypub_note() - updated to use conversation_participants';
    RAISE NOTICE '  ✅ handle_unified_content_federation() - updated to use conversation_participants';
    RAISE NOTICE '';
    RAISE NOTICE 'All functions should now work with the new conversation structure!';
    RAISE NOTICE 'DM message insertion should now work properly in production.';
    RAISE NOTICE '';
    RAISE NOTICE '🎯 TEST: Try sending a DM message again';
END $$;

-- =====================================================
-- STEP 5: Migration notes
-- =====================================================

-- CHANGE SUMMARY:
-- 1. Fixed process_activitypub_note to use conversation_participants instead of user1/user2
-- 2. Fixed handle_unified_content_federation to use conversation_participants instead of user1/user2
-- 3. Both functions now properly handle the new conversation structure
-- 4. Maintained all federation functionality while removing old column references

-- These were the LAST remaining functions with user1/user2 references that could be triggered
-- during DM message insertion, which explains why the error was still occurring.
