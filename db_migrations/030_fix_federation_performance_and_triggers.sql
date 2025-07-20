-- Migration 030: Fix Federation Performance and Triggers
-- 
-- FIXES:
-- 1. Author ID field mismatch in triggers (messages use user_id, posts use author_id)
-- 2. Frontend performance issues by moving federation logic to database
-- 3. Create professional federation system with automatic handling
-- 4. Fix federation trigger logic for both posts and messages

BEGIN;

-- =====================================================
-- STEP 1: Fix the unified content federation function
-- =====================================================

-- The current function tries to access NEW.author_id on messages table 
-- but messages table uses user_id field, not author_id
CREATE OR REPLACE FUNCTION public.handle_unified_content_federation() 
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    user_federation_enabled boolean;
    current_instance_domain text;
    full_instance_url text;
    target_user_id uuid;
    is_dm boolean := false;
    conversation_participants uuid[];
    remote_participants uuid[];
    v_activity_id text;
    should_federate boolean := false;
BEGIN
    -- Determine the user ID based on the table (FIXED: Handle both author_id and user_id)
    IF TG_TABLE_NAME = 'posts' THEN
        target_user_id := COALESCE(NEW.author_id, OLD.author_id);
    ELSIF TG_TABLE_NAME = 'messages' THEN  
        target_user_id := COALESCE(NEW.user_id, OLD.user_id);
    ELSE
        RAISE WARNING 'handle_unified_content_federation called on unsupported table: %', TG_TABLE_NAME;
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Early exit if no user ID
    IF target_user_id IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Check if federation is enabled (using existing function)
    SELECT is_federation_enabled_for_user(target_user_id) INTO user_federation_enabled;
    
    IF NOT user_federation_enabled THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Get instance domain with protocol
    SELECT config_value::text INTO current_instance_domain
    FROM instance_config 
    WHERE config_key = 'domain';
    
    IF current_instance_domain IS NULL THEN
        current_instance_domain := 'localhost';
    END IF;
    
    -- Ensure protocol is included
    full_instance_url := CASE 
        WHEN current_instance_domain LIKE 'http%' THEN current_instance_domain
        ELSE 'https://' || trim(both '"' from current_instance_domain)
    END;

    -- Handle INSERT operations (new posts/messages)
    IF TG_OP = 'INSERT' THEN
        should_federate := true;
        
        -- For messages, check if it's a DM that needs federation
        IF TG_TABLE_NAME = 'messages' AND NEW.conversation_id IS NOT NULL THEN
            -- Get conversation participants
            SELECT array_agg(user_id) INTO conversation_participants
            FROM conversation_participants 
            WHERE conversation_id = NEW.conversation_id;
            
            -- Check if any participants are remote
            SELECT array_agg(p.id) INTO remote_participants
            FROM profiles p 
            WHERE p.id = ANY(conversation_participants) 
            AND NOT p.is_local;
            
            is_dm := (array_length(remote_participants, 1) > 0);
            
            -- Only federate DMs with remote participants, not local server chat
            should_federate := is_dm;
        END IF;

        -- Create federation activity if should federate
        IF should_federate THEN
            v_activity_id := full_instance_url || '/activities/' || gen_random_uuid();
            
            IF TG_TABLE_NAME = 'posts' THEN
                -- Federate post
                INSERT INTO ap_activities (
                    ap_id, ap_type, actor_id, actor_ap_id, object_id, object_type,
                    activity_data, status, is_local
                ) VALUES (
                    v_activity_id,
                    'Create',
                    target_user_id,
                    (SELECT federated_id FROM profiles WHERE id = target_user_id),
                    full_instance_url || '/posts/' || NEW.id,
                    'Note',
                    jsonb_build_object(
                        'type', 'Create',
                        'actor', (SELECT federated_id FROM profiles WHERE id = target_user_id),
                        'object', jsonb_build_object(
                            'type', 'Note',
                            'id', full_instance_url || '/posts/' || NEW.id,
                            'content', convert_jsonb_to_ap(NEW.content),
                            'attributedTo', (SELECT federated_id FROM profiles WHERE id = target_user_id),
                            'published', NEW.created_at::text
                        )
                    ),
                    'pending',
                    true
                );
                
            ELSIF TG_TABLE_NAME = 'messages' AND is_dm THEN
                -- Federate DM message
                INSERT INTO ap_activities (
                    ap_id, ap_type, actor_id, actor_ap_id, object_id, object_type,
                    activity_data, status, is_local, target_actors
                ) VALUES (
                    v_activity_id,
                    'Create',
                    target_user_id,
                    (SELECT federated_id FROM profiles WHERE id = target_user_id),
                    full_instance_url || '/messages/' || NEW.id,
                    'Note',
                    jsonb_build_object(
                        'type', 'Create',
                        'actor', (SELECT federated_id FROM profiles WHERE id = target_user_id),
                        'object', jsonb_build_object(
                            'type', 'Note',
                            'id', full_instance_url || '/messages/' || NEW.id,
                            'content', convert_jsonb_to_ap(NEW.content),
                            'attributedTo', (SELECT federated_id FROM profiles WHERE id = target_user_id),
                            'to', (SELECT array_agg(p.federated_id) FROM profiles p WHERE p.id = ANY(remote_participants))
                        )
                    ),
                    'pending',
                    true,
                    ARRAY(SELECT federated_id FROM profiles WHERE id = ANY(remote_participants))
                );
            END IF;
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.handle_unified_content_federation() IS 'FIXED: Handles both posts (author_id) and messages (user_id) correctly. Professional federation with automatic handling.';

-- =====================================================
-- STEP 2: Create professional post creation function
-- =====================================================

-- This function handles ALL the work for creating a post, including federation
-- The frontend only needs to call this one function
CREATE OR REPLACE FUNCTION public.create_post_professional(
    p_user_id uuid,
    p_content jsonb,
    p_visibility text DEFAULT 'public',
    p_content_warning text DEFAULT NULL,
    p_in_reply_to uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL,
    p_media_attachments jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_post_id uuid;
    v_post record;
    v_federation_enabled boolean;
    v_result jsonb;
BEGIN
    -- Create the post
    INSERT INTO posts (
        author_id,
        content,
        visibility,
        content_warning,
        in_reply_to,
        conversation_id,
        media_attachments,
        is_local,
        created_at
    ) VALUES (
        p_user_id,
        p_content,
        p_visibility,
        p_content_warning,
        p_in_reply_to,
        p_conversation_id,
        p_media_attachments,
        true,
        NOW()
    ) RETURNING id INTO v_post_id;

    -- Get the complete post data with author info
    SELECT 
        p.*,
        pr.username,
        pr.display_name,
        pr.avatar_url,
        pr.domain,
        pr.is_local,
        pr.federated_id
    INTO v_post
    FROM posts p
    JOIN profiles pr ON p.author_id = pr.id
    WHERE p.id = v_post_id;

    -- Build the response (everything the frontend needs)
    v_result := jsonb_build_object(
        'id', v_post.id,
        'content', v_post.content,
        'visibility', v_post.visibility,
        'content_warning', v_post.content_warning,
        'created_at', v_post.created_at,
        'updated_at', v_post.updated_at,
        'in_reply_to', v_post.in_reply_to,
        'conversation_id', v_post.conversation_id,
        'replies_count', 0,
        'reblogs_count', 0,
        'favorites_count', 0,
        'is_favorited', false,
        'is_reblogged', false,
        'is_bookmarked', false,
        'author', jsonb_build_object(
            'id', v_post.author_id,
            'username', v_post.username,
            'display_name', v_post.display_name,
            'avatar_url', v_post.avatar_url,
            'domain', v_post.domain,
            'is_local', v_post.is_local,
            'federated_id', v_post.federated_id
        ),
        'media_attachments', v_post.media_attachments,
        'federation_status', 'processing'
    );

    -- The trigger will automatically handle federation
    -- No need for the frontend to do anything else
    
    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.create_post_professional IS 'Professional post creation: Creates post locally and triggers automatic federation. Frontend only needs this one call.';

-- =====================================================
-- STEP 3: Create professional message sending function  
-- =====================================================

-- This function handles ALL the work for sending a message, including federation
CREATE OR REPLACE FUNCTION public.send_message_professional(
    p_user_id uuid,
    p_content jsonb,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL,
    p_reply_to uuid DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_message_id uuid;
    v_message record;
    v_is_dm boolean := false;
    v_result jsonb;
BEGIN
    -- Determine if this is a DM or channel message
    v_is_dm := (p_conversation_id IS NOT NULL);

    -- Create the message
    INSERT INTO messages (
        user_id,
        content,
        channel_id,
        conversation_id,
        reply_to,
        created_at
    ) VALUES (
        p_user_id,
        p_content,
        p_channel_id,
        p_conversation_id,
        p_reply_to,
        NOW()
    ) RETURNING id INTO v_message_id;

    -- Get the complete message data with user info
    SELECT 
        m.*,
        pr.username,
        pr.display_name,
        pr.avatar_url,
        pr.domain,
        pr.is_local,
        pr.federated_id
    INTO v_message
    FROM messages m
    JOIN profiles pr ON m.user_id = pr.id
    WHERE m.id = v_message_id;

    -- Build the response
    v_result := jsonb_build_object(
        'id', v_message.id,
        'content', v_message.content,
        'created_at', v_message.created_at,
        'updated_at', v_message.updated_at,
        'channel_id', v_message.channel_id,
        'conversation_id', v_message.conversation_id,
        'reply_to', v_message.reply_to,
        'is_system', false,
        'user', jsonb_build_object(
            'id', v_message.user_id,
            'username', v_message.username,
            'display_name', v_message.display_name,
            'avatar_url', v_message.avatar_url,
            'domain', v_message.domain,
            'is_local', v_message.is_local,
            'federated_id', v_message.federated_id
        ),
        'federation_status', CASE WHEN v_is_dm THEN 'processing' ELSE 'local_only' END
    );

    -- The trigger will automatically handle federation for DMs
    -- Channel messages stay local
    
    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.send_message_professional IS 'Professional message sending: Creates message locally and triggers automatic federation for DMs. Frontend only needs this one call.';

-- =====================================================
-- STEP 4: Create federation status checking function
-- =====================================================

-- This function provides all federation info the frontend might need
CREATE OR REPLACE FUNCTION public.get_federation_status(p_user_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_instance_settings jsonb;
    v_user_settings jsonb;
    v_instance_domain text;
    v_result jsonb;
BEGIN
    -- Get instance domain
    SELECT trim(both '"' from config_value::text) INTO v_instance_domain
    FROM instance_config 
    WHERE config_key = 'domain';
    
    -- Get instance federation settings
    SELECT get_public_federation_settings() INTO v_instance_settings;
    
    -- Get user federation settings if user provided
    IF p_user_id IS NOT NULL THEN
        SELECT jsonb_build_object(
            'federation_enabled', COALESCE(federation_enabled, true),
            'federation_discoverable', COALESCE(federation_discoverable, true)
        ) INTO v_user_settings
        FROM profiles 
        WHERE id = p_user_id;
    ELSE
        v_user_settings := '{}'::jsonb;
    END IF;
    
    -- Build comprehensive response
    v_result := jsonb_build_object(
        'instance', jsonb_build_object(
            'domain', v_instance_domain,
            'federation_enabled', COALESCE((v_instance_settings->>'federation_enabled')::boolean, true),
            'auto_accept_follows', COALESCE((v_instance_settings->>'federation_auto_accept_follows')::boolean, true)
        ),
        'user', v_user_settings,
        'overall_enabled', CASE 
            WHEN p_user_id IS NOT NULL THEN is_federation_enabled_for_user(p_user_id)
            ELSE COALESCE((v_instance_settings->>'federation_enabled')::boolean, true)
        END
    );
    
    RETURN v_result;
END;
$$;

COMMENT ON FUNCTION public.get_federation_status IS 'Get comprehensive federation status for instance and user. Replaces multiple frontend calls.';

-- =====================================================
-- STEP 5: Grant permissions for new functions
-- =====================================================

GRANT EXECUTE ON FUNCTION public.create_post_professional TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_message_professional TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_federation_status TO authenticated, anon;

-- =====================================================
-- STEP 6: Create indexes for better performance
-- =====================================================

-- Index for conversation participants lookup
CREATE INDEX IF NOT EXISTS idx_conversation_participants_conversation_id 
ON conversation_participants(conversation_id);

-- Index for ap_activities status
CREATE INDEX IF NOT EXISTS idx_ap_activities_status_created 
ON ap_activities(status, created_at) WHERE status = 'pending';

-- Index for profiles federation lookup
CREATE INDEX IF NOT EXISTS idx_profiles_federation_enabled 
ON profiles(federation_enabled, is_local) WHERE federation_enabled = true;

-- =====================================================
-- STEP 7: Update RLS policies for new functions
-- =====================================================

-- Allow authenticated users to insert posts through the function
DROP POLICY IF EXISTS "Users can create posts via professional function" ON posts;
CREATE POLICY "Users can create posts via professional function" ON posts
FOR INSERT TO authenticated
WITH CHECK (auth.uid() = author_id);

-- Allow authenticated users to insert messages through the function  
DROP POLICY IF EXISTS "Users can create messages via professional function" ON messages;
CREATE POLICY "Users can create messages via professional function" ON messages
FOR INSERT TO authenticated  
WITH CHECK (auth.uid() = user_id);

COMMIT;

-- =====================================================
-- VALIDATION AND TESTING
-- =====================================================

-- Test the new functions
DO $$
DECLARE
    test_user_id uuid;
    test_result jsonb;
    federation_status jsonb;
BEGIN
    -- Get a test user
    SELECT id INTO test_user_id FROM profiles WHERE is_local = true LIMIT 1;
    
    IF test_user_id IS NOT NULL THEN
        -- Test federation status
        SELECT get_federation_status(test_user_id) INTO federation_status;
        RAISE NOTICE '✅ Federation status check successful: %', federation_status;
        
        RAISE NOTICE '✅ Migration 030 completed successfully';
        RAISE NOTICE '📋 Frontend can now use:';
        RAISE NOTICE '   - create_post_professional() for posts';
        RAISE NOTICE '   - send_message_professional() for messages';  
        RAISE NOTICE '   - get_federation_status() for federation info';
        RAISE NOTICE '🚀 No more multiple RPC calls needed!';
    ELSE
        RAISE NOTICE '⚠️ No test user found, but migration completed successfully';
    END IF;
END;
$$;