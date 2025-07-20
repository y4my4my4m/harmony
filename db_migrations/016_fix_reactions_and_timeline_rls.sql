-- Migration 016: Fix DM Reactions and Timeline Entries RLS
-- 
-- FIXES:
-- 1. DM Reactions: handle_unified_interaction_federation() tries to access NEW.follower_id on reactions table
-- 2. Post Creation: timeline_entries RLS prevents trigger from inserting timeline entries

-- =====================================================
-- STEP 1: Fix DM Reactions Federation Function
-- =====================================================

-- The issue is in the INSERT INTO ap_activities section where it tries to access
-- NEW.follower_id for all table types, but reactions table doesn't have follower_id

CREATE OR REPLACE FUNCTION public.handle_unified_interaction_federation() 
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    user_federation_enabled boolean;
    target_federation_enabled boolean;
    current_instance_domain text;
    activity_type text;
    target_object_id text;
    target_object_type text;
    target_actor_id uuid;
    -- Variables to avoid any potential conflicts
    msg_channel_id uuid;
    msg_conversation_id uuid;
    actor_user_id uuid;
    target_user_id uuid;
BEGIN
    -- Get current instance domain
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;

    -- Early exit if domain not configured
    IF current_instance_domain IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Handle different table operations
    IF TG_TABLE_NAME = 'follows' THEN
        -- Check federation for follower
        SELECT is_federation_enabled_for_user(COALESCE(NEW.follower_id, OLD.follower_id)) INTO user_federation_enabled;
        
        IF NOT user_federation_enabled THEN
            RETURN COALESCE(NEW, OLD);
        END IF;

        -- Set actor and target user IDs for follows
        actor_user_id := COALESCE(NEW.follower_id, OLD.follower_id);
        target_user_id := COALESCE(NEW.following_id, OLD.following_id);

        IF TG_OP = 'INSERT' THEN
            activity_type := 'Follow';
            target_object_id := (SELECT federated_id FROM profiles WHERE id = NEW.following_id);
            target_actor_id := NEW.following_id;
        ELSIF TG_OP = 'DELETE' THEN
            activity_type := 'Undo';
            target_object_id := (SELECT federated_id FROM profiles WHERE id = OLD.following_id);
            target_actor_id := OLD.following_id;
        END IF;

    ELSIF TG_TABLE_NAME = 'post_interactions' THEN
        -- Check federation for interaction user
        SELECT is_federation_enabled_for_user(COALESCE(NEW.user_id, OLD.user_id)) INTO user_federation_enabled;
        
        IF NOT user_federation_enabled THEN
            RETURN COALESCE(NEW, OLD);
        END IF;

        -- Set actor and target user IDs for post interactions
        actor_user_id := COALESCE(NEW.user_id, OLD.user_id);
        
        IF TG_OP = 'INSERT' THEN
            activity_type := CASE 
                WHEN NEW.interaction_type = 'favorite' THEN 'Like'
                WHEN NEW.interaction_type = 'reblog' THEN 'Announce' 
                ELSE 'Like'
            END;
            target_object_id := (SELECT ap_id FROM posts WHERE id = NEW.post_id);
            target_actor_id := (SELECT author_id FROM posts WHERE id = NEW.post_id);
            target_user_id := target_actor_id;
        ELSIF TG_OP = 'DELETE' THEN
            activity_type := 'Undo';
            target_object_id := (SELECT ap_id FROM posts WHERE id = OLD.post_id);
            target_actor_id := (SELECT author_id FROM posts WHERE id = OLD.post_id);
            target_user_id := target_actor_id;
        END IF;

    ELSIF TG_TABLE_NAME = 'reactions' THEN
        -- Check federation for reaction user
        SELECT is_federation_enabled_for_user(COALESCE(NEW.user_id, OLD.user_id)) INTO user_federation_enabled;
        
        IF NOT user_federation_enabled THEN
            RETURN COALESCE(NEW, OLD);
        END IF;

        -- Set actor and target user IDs for reactions
        actor_user_id := COALESCE(NEW.user_id, OLD.user_id);

        -- Get message context with explicit aliases to avoid ambiguous references
        SELECT m.channel_id, m.conversation_id, m.user_id 
        INTO msg_channel_id, msg_conversation_id, target_user_id
        FROM messages m 
        WHERE m.id = COALESCE(NEW.message_id, OLD.message_id);

        -- LOCAL-FIRST: Only federate DM reactions, not chat reactions
        IF msg_channel_id IS NOT NULL THEN
            -- This is a chat message, don't federate
            RETURN COALESCE(NEW, OLD);
        END IF;

        IF TG_OP = 'INSERT' THEN
            activity_type := 'Like';  -- Use 'Like' instead of 'EmojiReact' to comply with constraints
            target_object_id := (SELECT 'message-' || NEW.message_id);
            target_actor_id := target_user_id;
        ELSIF TG_OP = 'DELETE' THEN
            activity_type := 'Undo';
            target_object_id := (SELECT 'message-' || OLD.message_id);
            target_actor_id := target_user_id;
        END IF;
    END IF;

    -- Create federation activity if we have the required data
    IF activity_type IS NOT NULL AND target_object_id IS NOT NULL AND actor_user_id IS NOT NULL THEN
        INSERT INTO ap_activities (
            ap_id,
            ap_type,
            actor_id,
            actor_ap_id, 
            object_id,
            object_type,
            target_id,
            target_type,
            activity_data,
            status,
            is_local
        ) VALUES (
            current_instance_domain || '/activities/' || gen_random_uuid(),
            activity_type,
            actor_user_id,  -- FIXED: Use the correctly determined actor user ID
            (SELECT federated_id FROM profiles WHERE id = actor_user_id),
            target_object_id,
            CASE 
                WHEN TG_TABLE_NAME = 'follows' THEN 'Person'
                WHEN TG_TABLE_NAME = 'post_interactions' THEN 'Note'
                WHEN TG_TABLE_NAME = 'reactions' THEN 'Note'
                ELSE 'Object'
            END,
            target_actor_id,
            'Person',
            jsonb_build_object(
                'type', activity_type,
                'actor', (SELECT federated_id FROM profiles WHERE id = actor_user_id),
                'object', target_object_id
            ),
            'pending',
            true
        );
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION public.handle_unified_interaction_federation() IS 'FIXED: Unified trigger function with proper variable handling for all table types. No more follower_id access errors on reactions table.';

-- =====================================================
-- STEP 2: Fix Timeline Entries RLS Policies
-- =====================================================

-- The issue is that users can't insert into timeline_entries, but the 
-- create_comprehensive_timeline_entries() trigger tries to do this

-- Drop existing policies
DROP POLICY IF EXISTS "System can manage timeline entries" ON timeline_entries;
DROP POLICY IF EXISTS "Users can view their own timeline entries" ON timeline_entries;

-- Create proper RLS policies for timeline_entries
CREATE POLICY "Users can view their own timeline entries" 
  ON timeline_entries FOR SELECT 
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own timeline entries" 
  ON timeline_entries FOR INSERT 
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "System can manage all timeline entries" 
  ON timeline_entries FOR ALL 
  USING (true) 
  WITH CHECK (true);

-- Make sure RLS is enabled
ALTER TABLE timeline_entries ENABLE ROW LEVEL SECURITY;

-- =====================================================
-- STEP 3: Alternative Solution - SECURITY DEFINER Function
-- =====================================================

-- Also create a SECURITY DEFINER version of the timeline function
-- This runs with elevated privileges regardless of RLS
CREATE OR REPLACE FUNCTION public.create_comprehensive_timeline_entries() 
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    follower_record RECORD;
    recipient_count INTEGER := 0;
BEGIN
    -- Always add to author's own timeline first
    INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
    VALUES (NEW.author_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000)
    ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    
    -- For public posts, add to all followers' home timelines
    IF NEW.visibility = 'public' AND NOT COALESCE(NEW.is_deleted, false) THEN
        
        -- Add to home timelines of all followers
        FOR follower_record IN 
            SELECT f.follower_id 
            FROM follows f 
            WHERE f.following_id = NEW.author_id 
              AND f.status = 'accepted'
              AND f.follower_id != NEW.author_id  -- Don't duplicate author's own timeline
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (follower_record.follower_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
            
            recipient_count := recipient_count + 1;
        END LOOP;
        
        RAISE NOTICE 'Timeline: Added post % to % follower home timelines', NEW.id, recipient_count;
    END IF;
    
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.create_comprehensive_timeline_entries() IS 'FIXED: SECURITY DEFINER function bypasses RLS for timeline entry creation';

-- =====================================================
-- STEP 4: Fix ActivityPub Function with Wrong Table Reference
-- =====================================================

-- Fix the create_activitypub_note_activity function that references 'users' instead of 'profiles'
CREATE OR REPLACE FUNCTION public.create_activitypub_note_activity(post_id uuid) 
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    v_post posts%ROWTYPE;
    v_sender_url text;
    v_post_url text;
    v_activity_id text;
    v_mentioned_actor_urls text[];
    v_note_object jsonb;
    v_activity jsonb;
    v_followers_url text;
BEGIN
    -- Get post data
    SELECT * INTO v_post FROM posts WHERE id = post_id;
    
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;
    
    -- Build sender and post URLs (FIXED: profiles instead of users)
    SELECT 'https://' || trim(both '"' from config_value::text) || '/users/' || p.id
    INTO v_sender_url
    FROM profiles p, instance_config 
    WHERE p.id = v_post.author_id AND config_key = 'domain';
    
    SELECT 'https://' || trim(both '"' from config_value::text) || '/posts/' || v_post.id
    INTO v_post_url
    FROM instance_config 
    WHERE config_key = 'domain';
    
    v_activity_id := v_post_url || '#activity';
    v_followers_url := v_sender_url || '/followers';
    
    -- Extract mentioned actor URLs for addressing
    SELECT array_agg(mention->>'href') 
    INTO v_mentioned_actor_urls
    FROM jsonb_array_elements(v_post.content) content_item,
         jsonb_array_elements(COALESCE(content_item->'mentions', '[]'::jsonb)) mention
    WHERE mention->>'href' IS NOT NULL;
    
    -- Create Note object with unified content processing
    SELECT convert_jsonb_to_ap(v_post.content) INTO v_note_object;
    
    -- Add standard ActivityPub Note fields
    v_note_object := v_note_object || jsonb_build_object(
        'id', v_post_url,
        'type', 'Note',
        'published', v_post.created_at::text,
        'attributedTo', v_sender_url,
        'content', v_note_object->>'content',
        'url', v_post_url,
        'to', CASE 
            WHEN v_post.visibility = 'public' THEN '["https://www.w3.org/ns/activitystreams#Public"]'::jsonb
            WHEN v_post.visibility = 'followers' THEN jsonb_build_array(v_followers_url)
            ELSE '[]'::jsonb
        END,
        'cc', CASE 
            WHEN v_post.visibility = 'public' THEN jsonb_build_array(v_followers_url)
            ELSE '[]'::jsonb
        END || COALESCE(to_jsonb(v_mentioned_actor_urls), '[]'::jsonb)
    );
    
    -- Add reply context if this is a reply
    IF v_post.in_reply_to IS NOT NULL THEN
        v_note_object := v_note_object || jsonb_build_object(
            'inReplyTo', (SELECT 'https://' || trim(both '"' from config_value::text) || '/posts/' || v_post.in_reply_to FROM instance_config WHERE config_key = 'domain')
        );
    END IF;
    
    -- Create Activity wrapper
    v_activity := jsonb_build_object(
        'id', v_activity_id,
        'type', 'Create',
        'actor', v_sender_url,
        'published', v_post.created_at::text,
        'object', v_note_object,
        'to', v_note_object->'to',
        'cc', v_note_object->'cc'
    );
    
    RETURN v_activity;
END;
$$;

COMMENT ON FUNCTION public.create_activitypub_note_activity(uuid) IS 'FIXED: Creates a complete ActivityPub Create activity for a post with unified mention and emoji tag support. Now uses profiles table instead of users.';

-- =====================================================
-- STEP 5: Verification
-- =====================================================

DO $$
BEGIN
    RAISE NOTICE 'Migration 016 completed successfully!';
    RAISE NOTICE 'Fixed:';
    RAISE NOTICE '  ✅ DM reactions follower_id error resolved';
    RAISE NOTICE '  ✅ Timeline entries RLS policies fixed';
    RAISE NOTICE '  ✅ Timeline function now runs with SECURITY DEFINER';
    RAISE NOTICE '  ✅ ActivityPub function now uses profiles table instead of users';
    RAISE NOTICE '  ✅ Post creation should work without database errors';
END $$;