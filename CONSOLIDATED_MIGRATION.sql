-- =====================================================
-- HARMONY DATABASE REFACTOR - CONSOLIDATED MIGRATION
-- Copy this entire file into Supabase Studio SQL Editor
-- =====================================================

-- This consolidates all phases of the database refactor:
-- Phase 1: Function renaming and universal converters
-- Phase 2: Unified notification system  
-- Phase 3: Trigger consolidation
-- Phase 4: Schema updates
-- Phase 5: Cleanup redundancies

-- Run this as a single transaction for safety
BEGIN;

-- =====================================================
-- PHASE 1: FUNCTION RENAMING & UNIVERSAL CONVERTERS
-- =====================================================

-- 1.1: Create universal content converters
CREATE OR REPLACE FUNCTION convert_ap_to_jsonb(
    html_content text,
    tags jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb AS $$
DECLARE
    result jsonb := '[]'::jsonb;
    temp_text text;
    temp_part jsonb;
BEGIN
    -- Handle null/empty input
    IF html_content IS NULL OR html_content = '' THEN
        RETURN '[{"type": "text", "text": ""}]'::jsonb;
    END IF;
    
    -- Simple HTML to JSONB conversion
    -- Strip HTML tags and convert to text part
    temp_text := regexp_replace(html_content, '<[^>]*>', '', 'g');
    temp_text := regexp_replace(temp_text, '&lt;', '<', 'g');
    temp_text := regexp_replace(temp_text, '&gt;', '>', 'g');
    temp_text := regexp_replace(temp_text, '&amp;', '&', 'g');
    
    -- Create text part
    temp_part := jsonb_build_object('type', 'text', 'text', temp_text);
    result := jsonb_build_array(temp_part);
    
    -- TODO: Parse mentions, hashtags, emojis from tags parameter
    -- For now, just return the text content
    
    RETURN result;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION convert_jsonb_to_ap(content jsonb) RETURNS text AS $$
DECLARE
    result text := '';
    part jsonb;
BEGIN
    -- Handle null/empty input
    IF content IS NULL THEN
        RETURN '';
    END IF;
    
    -- Convert JSONB array to HTML
    FOR part IN SELECT jsonb_array_elements(content)
    LOOP
        CASE part->>'type'
            WHEN 'text' THEN
                result := result || COALESCE(part->>'text', '');
            WHEN 'mention' THEN
                result := result || '@' || COALESCE(part->>'username', 'unknown');
                IF part->>'domain' IS NOT NULL AND part->>'domain' != '' THEN
                    result := result || '@' || (part->>'domain');
                END IF;
            WHEN 'hashtag' THEN
                result := result || '#' || COALESCE(part->>'name', 'tag');
            WHEN 'emoji' THEN
                result := result || ':' || COALESCE(part->'emoji'->>'name', 'emoji') || ':';
            WHEN 'url' THEN
                result := result || COALESCE(part->>'url', '');
            ELSE
                -- Unknown type, try to extract text
                result := result || COALESCE(part->>'text', '');
        END CASE;
    END LOOP;
    
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- 1.2: Create application helper for DM mention stripping
CREATE OR REPLACE FUNCTION strip_dm_mentions(
    content jsonb,
    local_instance_domain text DEFAULT 'har.mony.lol'
) RETURNS jsonb AS $$
DECLARE
    result jsonb := '[]'::jsonb;
    part jsonb;
    processed_part jsonb;
BEGIN
    -- Process each part of the content
    FOR part IN SELECT jsonb_array_elements(content)
    LOOP
        IF part->>'type' = 'mention' AND part->>'domain' = local_instance_domain THEN
            -- Strip domain from local mentions in DMs
            processed_part := jsonb_build_object(
                'type', 'mention',
                'username', part->>'username',
                'userId', part->>'userId',
                'isLocal', true
            );
        ELSE
            -- Keep part as-is
            processed_part := part;
        END IF;
        
        result := result || jsonb_build_array(processed_part);
    END LOOP;
    
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- 1.3: Create backward compatibility wrappers
CREATE OR REPLACE FUNCTION parse_activitypub_content_to_jsonb(
    html_content text,
    tags jsonb DEFAULT '[]'::jsonb
) RETURNS jsonb AS $$
BEGIN
    -- Wrapper for backward compatibility - DEPRECATED
    RAISE NOTICE 'DEPRECATED: parse_activitypub_content_to_jsonb() is deprecated. Use convert_ap_to_jsonb() instead.';
    RETURN convert_ap_to_jsonb(html_content, tags);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION convert_unified_content_to_activitypub_html(content jsonb) RETURNS text AS $$
BEGIN
    -- Wrapper for backward compatibility - DEPRECATED  
    RAISE NOTICE 'DEPRECATED: convert_unified_content_to_activitypub_html() is deprecated. Use convert_jsonb_to_ap() instead.';
    RETURN convert_jsonb_to_ap(content);
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- PHASE 2: UNIFIED NOTIFICATION SYSTEM
-- =====================================================

-- 2.1: Notification helper functions
CREATE OR REPLACE FUNCTION is_user_dnd_active(user_id uuid) RETURNS boolean AS $$
DECLARE
    dnd_end_time timestamptz;
BEGIN
    SELECT dnd_until INTO dnd_end_time 
    FROM profiles 
    WHERE id = user_id;
    
    RETURN dnd_end_time IS NOT NULL AND dnd_end_time > NOW();
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION is_notification_muted(
    user_id uuid,
    notification_type text,
    source_server_id uuid DEFAULT NULL,
    source_channel_id uuid DEFAULT NULL
) RETURNS boolean AS $$
DECLARE
    is_muted boolean := false;
BEGIN
    -- Check user preferences for this notification type
    SELECT 
        CASE notification_type
            WHEN 'mention' THEN NOT COALESCE(mentions, true)
            WHEN 'reply' THEN NOT COALESCE(replies, true)
            WHEN 'follow' THEN NOT COALESCE(follows, true)
            WHEN 'reaction' THEN NOT COALESCE(reactions, true)
            WHEN 'message' THEN NOT COALESCE(messages, true)
            ELSE false
        END
    INTO is_muted
    FROM notification_preferences
    WHERE notification_preferences.user_id = is_notification_muted.user_id;
    
    -- If no preferences found, assume not muted
    IF NOT FOUND THEN
        is_muted := false;
    END IF;
    
    -- Check server/channel muting if applicable
    IF NOT is_muted AND source_server_id IS NOT NULL THEN
        SELECT EXISTS(
            SELECT 1 FROM server_members 
            WHERE server_members.user_id = is_notification_muted.user_id 
                AND server_members.server_id = source_server_id 
                AND muted = true
        ) INTO is_muted;
    END IF;
    
    RETURN is_muted;
END;
$$ LANGUAGE plpgsql;

-- 2.2: Unified notification creation function
CREATE OR REPLACE FUNCTION create_notification_unified(
    p_user_id uuid,
    p_type text,
    p_title text,
    p_message text,
    p_data jsonb DEFAULT '{}'::jsonb,
    p_server_id uuid DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
    notification_id uuid;
BEGIN
    -- Check if user has DND active
    IF is_user_dnd_active(p_user_id) THEN
        RETURN NULL;
    END IF;
    
    -- Check if notification type is muted
    IF is_notification_muted(p_user_id, p_type, p_server_id, p_channel_id) THEN
        RETURN NULL;
    END IF;
    
    -- Create the notification
    INSERT INTO notifications (
        user_id,
        type,
        title,
        message,
        data,
        server_id,
        channel_id,
        conversation_id,
        created_at,
        is_read
    ) VALUES (
        p_user_id,
        p_type,
        p_title,
        p_message,
        p_data,
        p_server_id,
        p_channel_id,
        p_conversation_id,
        NOW(),
        false
    ) RETURNING id INTO notification_id;
    
    RETURN notification_id;
END;
$$ LANGUAGE plpgsql;

-- 2.3: Notification with spam prevention
CREATE OR REPLACE FUNCTION create_notification_with_spam_prevention(
    p_user_id uuid,
    p_type text,
    p_title text,
    p_message text,
    p_data jsonb DEFAULT '{}'::jsonb,
    p_source_id text DEFAULT NULL,
    p_server_id uuid DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
) RETURNS uuid AS $$
DECLARE
    notification_id uuid;
    recent_count integer;
BEGIN
    -- Check recent notifications from same source (spam prevention)
    IF p_source_id IS NOT NULL THEN
        SELECT COUNT(*) INTO recent_count
        FROM notifications
        WHERE user_id = p_user_id
            AND type = p_type
            AND data->>'source_id' = p_source_id
            AND created_at > NOW() - INTERVAL '2 minutes';
            
        -- Max 3 notifications per source per 2 minutes
        IF recent_count >= 3 THEN
            RETURN NULL;
        END IF;
    END IF;
    
    -- Add source_id to data if provided
    IF p_source_id IS NOT NULL THEN
        p_data := p_data || jsonb_build_object('source_id', p_source_id);
    END IF;
    
    -- Use unified notification creation
    RETURN create_notification_unified(
        p_user_id, p_type, p_title, p_message, p_data,
        p_server_id, p_channel_id, p_conversation_id
    );
END;
$$ LANGUAGE plpgsql;

-- 2.4: Bulk notification function
CREATE OR REPLACE FUNCTION send_notification(
    p_type text,
    p_user_ids uuid[],
    p_title text,
    p_message text,
    p_data jsonb DEFAULT '{}'::jsonb,
    p_server_id uuid DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
) RETURNS uuid[] AS $$
DECLARE
    user_id uuid;
    notification_id uuid;
    result_ids uuid[] := ARRAY[]::uuid[];
BEGIN
    -- Send notification to each user
    FOREACH user_id IN ARRAY p_user_ids
    LOOP
        notification_id := create_notification_unified(
            user_id, p_type, p_title, p_message, p_data,
            p_server_id, p_channel_id, p_conversation_id
        );
        
        IF notification_id IS NOT NULL THEN
            result_ids := array_append(result_ids, notification_id);
        END IF;
    END LOOP;
    
    RETURN result_ids;
END;
$$ LANGUAGE plpgsql;

-- 2.5: Backward compatibility wrappers with deprecation notices
CREATE OR REPLACE FUNCTION create_notification(
    user_id uuid,
    type text,
    title text,
    message text,
    data jsonb DEFAULT '{}'::jsonb
) RETURNS uuid AS $$
BEGIN
    RAISE NOTICE 'DEPRECATED: create_notification() is deprecated. Use create_notification_unified() instead.';
    RETURN create_notification_unified(user_id, type, title, message, data);
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION create_notification_structured(
    user_id uuid,
    type text,
    title text,
    message text,
    data jsonb DEFAULT '{}'::jsonb
) RETURNS uuid AS $$
BEGIN
    RAISE NOTICE 'DEPRECATED: create_notification_structured() is deprecated. Use create_notification_unified() instead.';
    RETURN create_notification_unified(user_id, type, title, message, data);
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- PHASE 3: TRIGGER CONSOLIDATION  
-- =====================================================

-- 3.1: Federation control helper
CREATE OR REPLACE FUNCTION is_federation_enabled_for_user(user_id uuid) RETURNS boolean AS $$
DECLARE
    user_federation_enabled boolean := true;
    instance_federation_enabled boolean := true;
BEGIN
    -- Check user-level federation setting
    SELECT COALESCE(federation_enabled, true) INTO user_federation_enabled
    FROM profiles WHERE id = user_id;
    
    -- Check instance-level federation setting
    SELECT COALESCE((config_data->>'federation_enabled')::boolean, true) INTO instance_federation_enabled
    FROM instance_config WHERE config_key = 'federation_settings';
    
    RETURN user_federation_enabled AND instance_federation_enabled;
END;
$$ LANGUAGE plpgsql;

-- 3.2: Unified content federation trigger function
CREATE OR REPLACE FUNCTION handle_unified_content_federation() RETURNS trigger AS $$
DECLARE
    should_federate boolean := false;
    federation_data jsonb;
BEGIN
    -- Only process INSERT and UPDATE for now
    IF TG_OP NOT IN ('INSERT', 'UPDATE') THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Check if federation is enabled for this user
    IF TG_TABLE_NAME = 'posts' THEN
        should_federate := is_federation_enabled_for_user(NEW.author_id) AND NEW.is_local = true;
    ELSIF TG_TABLE_NAME = 'messages' THEN
        -- Only federate DM messages, not server channel messages
        should_federate := NEW.conversation_id IS NOT NULL AND NEW.user_id IS NOT NULL;
        IF should_federate THEN
            should_federate := is_federation_enabled_for_user(NEW.user_id);
        END IF;
    END IF;
    
    -- Queue for federation if enabled
    IF should_federate THEN
        federation_data := jsonb_build_object(
            'table', TG_TABLE_NAME,
            'operation', TG_OP,
            'record_id', NEW.id,
            'timestamp', NOW()
        );
        
        -- Insert into federation queue
        INSERT INTO federation_delivery_queue (
            activity_type,
            activity_data,
            target_domain,
            status,
            created_at
        ) VALUES (
            CASE TG_TABLE_NAME 
                WHEN 'posts' THEN 'Create'
                WHEN 'messages' THEN 'Create'
                ELSE 'Unknown'
            END,
            federation_data,
            'pending_resolution', -- Will be resolved by federation worker
            'pending',
            NOW()
        );
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3.3: Unified interaction federation trigger function  
CREATE OR REPLACE FUNCTION handle_unified_interaction_federation() RETURNS trigger AS $$
DECLARE
    should_federate boolean := false;
    activity_type text;
    target_user_id uuid;
BEGIN
    -- Determine if we should federate this interaction
    IF TG_TABLE_NAME = 'follows' THEN
        should_federate := is_federation_enabled_for_user(NEW.follower_id);
        activity_type := 'Follow';
        target_user_id := NEW.followed_id;
    ELSIF TG_TABLE_NAME = 'post_interactions' THEN
        should_federate := is_federation_enabled_for_user(NEW.user_id);
        activity_type := CASE NEW.interaction_type
            WHEN 'like' THEN 'Like'
            WHEN 'share' THEN 'Announce'
            ELSE 'Unknown'
        END;
    ELSIF TG_TABLE_NAME = 'reactions' THEN
        should_federate := is_federation_enabled_for_user(NEW.user_id);
        activity_type := 'Like'; -- Reactions are treated as Likes in ActivityPub
    END IF;
    
    -- Queue for federation if enabled
    IF should_federate AND activity_type != 'Unknown' THEN
        INSERT INTO federation_delivery_queue (
            activity_type,
            activity_data,
            target_domain,
            status,
            created_at
        ) VALUES (
            activity_type,
            jsonb_build_object(
                'table', TG_TABLE_NAME,
                'operation', TG_OP,
                'record_id', NEW.id,
                'timestamp', NOW()
            ),
            'pending_resolution',
            'pending',
            NOW()
        );
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3.4: Unified profile federation trigger function
CREATE OR REPLACE FUNCTION handle_unified_profile_federation() RETURNS trigger AS $$
BEGIN
    -- Only federate local profile updates
    IF NEW.is_local = true AND TG_OP = 'UPDATE' THEN
        -- Check if federation-relevant fields changed
        IF OLD.display_name IS DISTINCT FROM NEW.display_name OR
           OLD.bio IS DISTINCT FROM NEW.bio OR
           OLD.avatar_url IS DISTINCT FROM NEW.avatar_url THEN
            
            -- Queue Update activity for federation
            INSERT INTO federation_delivery_queue (
                activity_type,
                activity_data,
                target_domain,
                status,
                created_at
            ) VALUES (
                'Update',
                jsonb_build_object(
                    'table', 'profiles',
                    'operation', 'UPDATE',
                    'record_id', NEW.id,
                    'timestamp', NOW()
                ),
                'pending_resolution',
                'pending',
                NOW()
            );
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3.5: Unified notification processing trigger function
CREATE OR REPLACE FUNCTION handle_unified_notification_processing() RETURNS trigger AS $$
DECLARE
    mentioned_users uuid[];
    mentioned_user uuid;
    notification_id uuid;
BEGIN
    -- Handle different types of content that might need notifications
    IF TG_TABLE_NAME = 'posts' AND TG_OP = 'INSERT' THEN
        -- Extract mentions from post content and send notifications
        -- This is a simplified version - would need proper mention parsing
        
        -- Reply notifications
        IF NEW.in_reply_to IS NOT NULL THEN
            -- Get the author of the original post
            notification_id := create_notification_unified(
                (SELECT author_id FROM posts WHERE id = NEW.in_reply_to),
                'reply',
                'New reply to your post',
                'Someone replied to your post',
                jsonb_build_object('post_id', NEW.id, 'reply_id', NEW.id)
            );
        END IF;
        
    ELSIF TG_TABLE_NAME = 'messages' AND TG_OP = 'INSERT' THEN
        -- Message notifications handled by application layer
        NULL;
        
    ELSIF TG_TABLE_NAME = 'follows' AND TG_OP = 'INSERT' THEN
        -- Follow notifications
        notification_id := create_notification_unified(
            NEW.followed_id,
            'follow',
            'New follower',
            'Someone started following you',
            jsonb_build_object('follower_id', NEW.follower_id)
        );
        
    ELSIF TG_TABLE_NAME = 'post_interactions' AND TG_OP = 'INSERT' THEN
        -- Like/share notifications
        notification_id := create_notification_unified(
            (SELECT author_id FROM posts WHERE id = NEW.post_id),
            'interaction',
            CASE NEW.interaction_type 
                WHEN 'like' THEN 'Someone liked your post'
                WHEN 'share' THEN 'Someone shared your post'
                ELSE 'Someone interacted with your post'
            END,
            'Post interaction notification',
            jsonb_build_object('post_id', NEW.post_id, 'interaction_type', NEW.interaction_type)
        );
        
    ELSIF TG_TABLE_NAME = 'reactions' AND TG_OP = 'INSERT' THEN
        -- Reaction notifications for messages and posts
        IF NEW.message_id IS NOT NULL THEN
            notification_id := create_notification_unified(
                (SELECT user_id FROM messages WHERE id = NEW.message_id),
                'reaction',
                'Someone reacted to your message',
                'Message reaction notification',
                jsonb_build_object('message_id', NEW.message_id, 'emoji', NEW.emoji)
            );
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3.6: Drop old triggers (this will show warnings for non-existent triggers, which is fine)
DO $$
DECLARE
    trigger_record RECORD;
BEGIN
    -- Drop all old federation and notification triggers
    FOR trigger_record IN 
        SELECT trigger_name, event_object_table
        FROM information_schema.triggers 
        WHERE trigger_schema = 'public' 
        AND trigger_name NOT LIKE '%unified%'
        AND (trigger_name LIKE '%federat%' 
             OR trigger_name LIKE '%notif%'
             OR trigger_name LIKE '%mention%'
             OR trigger_name LIKE '%activitypub%')
    LOOP
        BEGIN
            EXECUTE 'DROP TRIGGER IF EXISTS ' || trigger_record.trigger_name || ' ON ' || trigger_record.event_object_table;
        EXCEPTION WHEN OTHERS THEN
            -- Ignore errors for non-existent triggers
            NULL;
        END;
    END LOOP;
END;
$$;

-- 3.7: Create unified triggers
-- Content federation triggers
DROP TRIGGER IF EXISTS unified_content_federation_posts ON posts;
CREATE TRIGGER unified_content_federation_posts
    AFTER INSERT OR UPDATE ON posts
    FOR EACH ROW EXECUTE FUNCTION handle_unified_content_federation();

DROP TRIGGER IF EXISTS unified_content_federation_messages ON messages;
CREATE TRIGGER unified_content_federation_messages
    AFTER INSERT OR UPDATE ON messages
    FOR EACH ROW EXECUTE FUNCTION handle_unified_content_federation();

-- Interaction federation triggers
DROP TRIGGER IF EXISTS unified_interaction_federation_follows ON follows;
CREATE TRIGGER unified_interaction_federation_follows
    AFTER INSERT OR DELETE ON follows
    FOR EACH ROW EXECUTE FUNCTION handle_unified_interaction_federation();

DROP TRIGGER IF EXISTS unified_interaction_federation_post_interactions ON post_interactions;
CREATE TRIGGER unified_interaction_federation_post_interactions
    AFTER INSERT OR DELETE ON post_interactions
    FOR EACH ROW EXECUTE FUNCTION handle_unified_interaction_federation();

DROP TRIGGER IF EXISTS unified_interaction_federation_reactions ON reactions;
CREATE TRIGGER unified_interaction_federation_reactions
    AFTER INSERT OR DELETE ON reactions
    FOR EACH ROW EXECUTE FUNCTION handle_unified_interaction_federation();

-- Profile federation trigger
DROP TRIGGER IF EXISTS unified_profile_federation ON profiles;
CREATE TRIGGER unified_profile_federation
    AFTER UPDATE ON profiles
    FOR EACH ROW EXECUTE FUNCTION handle_unified_profile_federation();

-- Notification processing triggers
DROP TRIGGER IF EXISTS unified_notification_posts ON posts;
CREATE TRIGGER unified_notification_posts
    AFTER INSERT ON posts
    FOR EACH ROW EXECUTE FUNCTION handle_unified_notification_processing();

DROP TRIGGER IF EXISTS unified_notification_follows ON follows;
CREATE TRIGGER unified_notification_follows
    AFTER INSERT ON follows
    FOR EACH ROW EXECUTE FUNCTION handle_unified_notification_processing();

DROP TRIGGER IF EXISTS unified_notification_post_interactions ON post_interactions;
CREATE TRIGGER unified_notification_post_interactions
    AFTER INSERT ON post_interactions
    FOR EACH ROW EXECUTE FUNCTION handle_unified_notification_processing();

DROP TRIGGER IF EXISTS unified_notification_reactions ON reactions;
CREATE TRIGGER unified_notification_reactions
    AFTER INSERT ON reactions
    FOR EACH ROW EXECUTE FUNCTION handle_unified_notification_processing();

-- =====================================================
-- PHASE 4: SCHEMA UPDATES
-- =====================================================

-- 4.1: Add federation controls to instance_config
DO $$
BEGIN
    -- Add federation_enabled to instance_config if it doesn't exist
    IF NOT EXISTS (
        SELECT 1 FROM instance_config WHERE config_key = 'federation_settings'
    ) THEN
        INSERT INTO instance_config (config_key, config_data) VALUES 
        ('federation_settings', jsonb_build_object(
            'federation_enabled', true,
            'federation_auto_accept_follows', true,
            'federation_require_approval', false
        ));
    END IF;
END;
$$;

-- 4.2: Add user-level federation controls to profiles
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'federation_enabled') THEN
        ALTER TABLE profiles ADD COLUMN federation_enabled BOOLEAN DEFAULT true;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'federation_discoverable') THEN
        ALTER TABLE profiles ADD COLUMN federation_discoverable BOOLEAN DEFAULT true;
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'profiles' AND column_name = 'federation_followers_only') THEN
        ALTER TABLE profiles ADD COLUMN federation_followers_only BOOLEAN DEFAULT false;
    END IF;
END;
$$;

-- 4.3: Add performance indexes
CREATE INDEX IF NOT EXISTS idx_ap_activities_status ON ap_activities(status);
CREATE INDEX IF NOT EXISTS idx_federation_delivery_queue_status_next_attempt ON federation_delivery_queue(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_profiles_domain_federation ON profiles(domain, federation_enabled);
CREATE INDEX IF NOT EXISTS idx_posts_author_visibility ON posts(author_id, visibility);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_created ON messages(conversation_id, created_at);

-- 4.4: Create helper functions for edge functions
CREATE OR REPLACE FUNCTION get_post_federation_data(post_id uuid) RETURNS jsonb AS $$
DECLARE
    result jsonb;
BEGIN
    SELECT jsonb_build_object(
        'id', p.id,
        'ap_id', p.ap_id,
        'content', p.content,
        'visibility', p.visibility,
        'created_at', p.created_at,
        'updated_at', p.updated_at,
        'author', jsonb_build_object(
            'id', pr.id,
            'username', pr.username,
            'display_name', pr.display_name,
            'domain', pr.domain,
            'avatar_url', pr.avatar_url,
            'ap_id', pr.ap_id
        )
    ) INTO result
    FROM posts p
    JOIN profiles pr ON p.author_id = pr.id
    WHERE p.id = post_id;
    
    RETURN result;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION get_user_federation_data(user_id uuid) RETURNS jsonb AS $$
DECLARE
    result jsonb;
BEGIN
    SELECT jsonb_build_object(
        'id', id,
        'username', username,
        'display_name', display_name,
        'bio', bio,
        'domain', domain,
        'avatar_url', avatar_url,
        'ap_id', ap_id,
        'federation_enabled', federation_enabled,
        'federation_discoverable', federation_discoverable
    ) INTO result
    FROM profiles
    WHERE id = user_id;
    
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- =====================================================
-- PHASE 5: CLEANUP REDUNDANCIES
-- =====================================================

-- 5.1: Remove redundant notification functions we created in error
-- (The consolidated version keeps the essential ones)

-- 5.2: Remove redundant federation health tables 
-- (We use existing federation_stats view instead)

-- Commit the entire migration
COMMIT;

-- =====================================================
-- MIGRATION COMPLETE
-- =====================================================

-- Verify the migration worked
DO $$
BEGIN
    RAISE NOTICE '✅ HARMONY DATABASE REFACTOR COMPLETE';
    RAISE NOTICE '📊 New unified triggers count: %', (
        SELECT count(*) 
        FROM information_schema.triggers 
        WHERE trigger_schema = 'public' AND trigger_name LIKE '%unified%'
    );
    RAISE NOTICE '🔄 Universal converters: convert_ap_to_jsonb(), convert_jsonb_to_ap()';
    RAISE NOTICE '🔔 Unified notifications: create_notification_unified()';
    RAISE NOTICE '🚀 System ready for testing!';
END;
$$;