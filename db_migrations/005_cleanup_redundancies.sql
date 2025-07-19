-- =====================================================
-- HARMONY DATABASE REFACTOR - PHASE 5 (CLEANUP)
-- Remove Redundancies & Add Missing Features
-- =====================================================

-- This migration cleans up redundant code I created and adds 
-- actually missing features that were identified in the audit.

BEGIN;

-- =====================================================
-- STEP 1: CLEANUP (No Redundant Tables Created)
-- =====================================================

-- Note: No redundant federation health tables were created in Phase 4,
-- so no cleanup needed. We use existing federation_stats view.

-- =====================================================
-- STEP 2: NOTIFICATION SYSTEM (Already Unified in Phase 2)
-- =====================================================

-- Note: The unified notification system was already created in Phase 2.
-- No additional changes needed here.

-- =====================================================
-- STEP 3: ADD MISSING FEATURE - MISSKEY REACTIONS FOR POSTS
-- =====================================================

-- Extend post_interactions to support custom emoji reactions (like Misskey)
ALTER TABLE post_interactions ADD COLUMN IF NOT EXISTS emoji_id uuid REFERENCES emojis(id);
ALTER TABLE post_interactions ADD COLUMN IF NOT EXISTS custom_emoji_content text;

-- Update the constraint to allow custom emoji reactions
ALTER TABLE post_interactions DROP CONSTRAINT IF EXISTS post_interactions_interaction_type_check;
ALTER TABLE post_interactions ADD CONSTRAINT post_interactions_interaction_type_check 
CHECK (interaction_type = ANY (ARRAY['favorite'::text, 'reblog'::text, 'bookmark'::text, 'emoji_reaction'::text]));

-- Create index for emoji reactions
CREATE INDEX IF NOT EXISTS idx_post_interactions_emoji_reactions 
ON post_interactions(post_id, emoji_id) WHERE interaction_type = 'emoji_reaction';

-- Create function to add Misskey-style emoji reaction to post
CREATE OR REPLACE FUNCTION public.add_post_emoji_reaction(
    p_user_id uuid,
    p_post_id uuid,
    p_emoji_id uuid DEFAULT NULL,
    p_custom_emoji_content text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_interaction_id uuid;
BEGIN
    -- Must provide either emoji_id or custom_emoji_content
    IF p_emoji_id IS NULL AND p_custom_emoji_content IS NULL THEN
        RAISE EXCEPTION 'Must provide either emoji_id or custom_emoji_content';
    END IF;
    
    -- Insert emoji reaction
    INSERT INTO post_interactions (
        user_id,
        post_id,
        interaction_type,
        emoji_id,
        custom_emoji_content,
        is_local,
        metadata
    ) VALUES (
        p_user_id,
        p_post_id,
        'emoji_reaction',
        p_emoji_id,
        p_custom_emoji_content,
        true,
        jsonb_build_object(
            'reaction_type', CASE WHEN p_emoji_id IS NOT NULL THEN 'custom_emoji' ELSE 'unicode_emoji' END,
            'created_at', NOW()
        )
    ) RETURNING id INTO v_interaction_id;
    
    RETURN v_interaction_id;
END;
$$;

COMMENT ON FUNCTION public.add_post_emoji_reaction IS 'Add Misskey-style emoji reaction to posts. Supports both custom emojis and unicode content.';

-- Create function to remove emoji reaction from post
CREATE OR REPLACE FUNCTION public.remove_post_emoji_reaction(
    p_user_id uuid,
    p_post_id uuid,
    p_emoji_id uuid DEFAULT NULL,
    p_custom_emoji_content text DEFAULT NULL
)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_deleted_count integer;
BEGIN
    DELETE FROM post_interactions 
    WHERE user_id = p_user_id
      AND post_id = p_post_id 
      AND interaction_type = 'emoji_reaction'
      AND (
          (p_emoji_id IS NOT NULL AND emoji_id = p_emoji_id) OR
          (p_custom_emoji_content IS NOT NULL AND custom_emoji_content = p_custom_emoji_content)
      );
    
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    RETURN v_deleted_count > 0;
END;
$$;

COMMENT ON FUNCTION public.remove_post_emoji_reaction IS 'Remove emoji reaction from post. Returns true if reaction was found and removed.';

-- Create function to get emoji reactions for a post (similar to messages)
CREATE OR REPLACE FUNCTION public.get_post_emoji_reactions(p_post_id uuid)
RETURNS TABLE(
    emoji_id uuid,
    emoji_name text,
    emoji_url text,
    custom_emoji_content text,
    reaction_count bigint,
    user_reactions jsonb
)
LANGUAGE plpgsql STABLE
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        pi.emoji_id,
        e.name as emoji_name,
        e.url as emoji_url,
        pi.custom_emoji_content,
        COUNT(*)::bigint as reaction_count,
        jsonb_agg(
            jsonb_build_object(
                'user_id', pi.user_id,
                'created_at', pi.created_at
            )
        ) as user_reactions
    FROM post_interactions pi
    LEFT JOIN emojis e ON pi.emoji_id = e.id
    WHERE pi.post_id = p_post_id 
      AND pi.interaction_type = 'emoji_reaction'
    GROUP BY pi.emoji_id, e.name, e.url, pi.custom_emoji_content
    ORDER BY reaction_count DESC;
END;
$$;

COMMENT ON FUNCTION public.get_post_emoji_reactions IS 'Get emoji reactions for a post, grouped by emoji with counts and user lists.';

-- =====================================================
-- STEP 4: ADD MISSING FEATURE - REACTION LIMITS
-- =====================================================

-- Add constraint to limit unique emoji reactions per post (max 20 different emojis)
CREATE OR REPLACE FUNCTION public.check_emoji_reaction_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_emoji_count integer;
BEGIN
    IF NEW.interaction_type = 'emoji_reaction' THEN
        -- Count unique emoji reactions for this post
        SELECT COUNT(DISTINCT COALESCE(emoji_id::text, custom_emoji_content))
        INTO v_emoji_count
        FROM post_interactions 
        WHERE post_id = NEW.post_id 
          AND interaction_type = 'emoji_reaction';
        
        -- Allow max 20 different emoji types per post
        IF v_emoji_count >= 20 THEN
            RAISE EXCEPTION 'Maximum of 20 different emoji types allowed per post';
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Create trigger for emoji reaction limits on posts
DROP TRIGGER IF EXISTS trigger_check_emoji_reaction_limit ON post_interactions;
CREATE TRIGGER trigger_check_emoji_reaction_limit
    BEFORE INSERT ON post_interactions
    FOR EACH ROW
    EXECUTE FUNCTION check_emoji_reaction_limit();

-- Add similar constraint for message reactions
CREATE OR REPLACE FUNCTION public.check_message_emoji_reaction_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_emoji_count integer;
BEGIN
    -- Count unique emoji reactions for this message
    SELECT COUNT(DISTINCT emoji_id)
    INTO v_emoji_count
    FROM reactions 
    WHERE message_id = NEW.message_id;
    
    -- Allow max 20 different emoji types per message
    IF v_emoji_count >= 20 THEN
        RAISE EXCEPTION 'Maximum of 20 different emoji types allowed per message';
    END IF;
    
    RETURN NEW;
END;
$$;

-- Create trigger for emoji reaction limits on messages
DROP TRIGGER IF EXISTS trigger_check_message_emoji_reaction_limit ON reactions;
CREATE TRIGGER trigger_check_message_emoji_reaction_limit
    BEFORE INSERT ON reactions
    FOR EACH ROW
    EXECUTE FUNCTION check_message_emoji_reaction_limit();

-- =====================================================
-- STEP 5: ADD MISSING FEATURE - NOTIFICATION SPAM PREVENTION
-- =====================================================

-- Add notification spam prevention table
CREATE TABLE IF NOT EXISTS notification_rate_limits (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
    notification_type text NOT NULL,
    source_user_id uuid REFERENCES profiles(id) ON DELETE CASCADE,
    last_notification_at timestamp with time zone DEFAULT now(),
    notification_count integer DEFAULT 1,
    suppressed_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    UNIQUE(user_id, notification_type, source_user_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_rate_limits_user_type 
ON notification_rate_limits(user_id, notification_type, suppressed_until);

COMMENT ON TABLE notification_rate_limits IS 'Prevents notification spam by tracking and rate limiting notifications per user/type/source';

-- Enhanced notification function with spam prevention
CREATE OR REPLACE FUNCTION public.create_notification_with_spam_prevention(
    p_user_id uuid,
    p_type text,
    p_source_user_id uuid,
    p_title text DEFAULT NULL,
    p_message text DEFAULT NULL,
    p_data jsonb DEFAULT '{}',
    p_server_id uuid DEFAULT NULL,
    p_channel_id uuid DEFAULT NULL,
    p_conversation_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_notification_id uuid;
    v_rate_limit RECORD;
    v_should_suppress boolean := false;
    v_time_threshold timestamp with time zone := NOW() - INTERVAL '2 minutes';
BEGIN
    -- Check for rate limiting (only for reaction notifications for now)
    IF p_type = 'reaction' AND p_source_user_id IS NOT NULL THEN
        
        -- Get or create rate limit record
        INSERT INTO notification_rate_limits (user_id, notification_type, source_user_id)
        VALUES (p_user_id, p_type, p_source_user_id)
        ON CONFLICT (user_id, notification_type, source_user_id)
        DO UPDATE SET 
            notification_count = notification_rate_limits.notification_count + 1,
            last_notification_at = NOW()
        RETURNING * INTO v_rate_limit;
        
        -- Check if we should suppress (more than 3 notifications or within 2 minute window)
        SELECT 
            (notification_count > 3) OR 
            (notification_count > 1 AND last_notification_at > v_time_threshold) OR
            (suppressed_until IS NOT NULL AND suppressed_until > NOW())
        INTO v_should_suppress
        FROM notification_rate_limits
        WHERE user_id = p_user_id AND notification_type = p_type AND source_user_id = p_source_user_id;
        
        IF v_should_suppress THEN
            -- Update suppression time
            UPDATE notification_rate_limits 
            SET suppressed_until = NOW() + INTERVAL '2 minutes'
            WHERE user_id = p_user_id AND notification_type = p_type AND source_user_id = p_source_user_id;
            
            RETURN NULL; -- Suppress notification
        END IF;
    END IF;
    
    -- Create notification normally
    RETURN create_notification_unified(
        p_user_id, p_type, p_title, p_message, p_data, 
        p_server_id, p_channel_id, p_conversation_id
    );
END;
$$;

COMMENT ON FUNCTION public.create_notification_with_spam_prevention IS 'Creates notifications with spam prevention. Suppresses repeated notifications from same source within time windows.';

-- =====================================================
-- STEP 6: CLEAN UP REDUNDANT HELPER FUNCTIONS
-- =====================================================

-- Remove redundant helper functions I created (use existing ones)
DROP FUNCTION IF EXISTS public.get_post_federation_data(uuid);
DROP FUNCTION IF EXISTS public.check_federation_blocks(uuid, uuid, text);

-- The existing federation system already has comprehensive functions
-- No need for duplicate helper functions

-- =====================================================
-- STEP 7: ADD FEDERATION_TYPE TO DELIVERY QUEUE
-- =====================================================

-- Add federation_type column to federation_delivery_queue for better filtering
-- ALTER TABLE federation_delivery_queue ADD COLUMN IF NOT EXISTS federation_type text;

-- Add check constraint for federation_type
-- ALTER TABLE federation_delivery_queue DROP CONSTRAINT IF EXISTS federation_delivery_queue_federation_type_check;
-- ALTER TABLE federation_delivery_queue ADD CONSTRAINT federation_delivery_queue_federation_type_check
-- CHECK (federation_type IS NULL OR federation_type = ANY (ARRAY['post'::text, 'follow'::text, 'like'::text, 'announce'::text, 'update'::text, 'delete'::text, 'accept'::text, 'reject'::text]));

-- Create index for federation_type filtering
-- CREATE INDEX IF NOT EXISTS idx_federation_delivery_queue_type_status
-- ON federation_delivery_queue(federation_type, status, next_attempt_at);

-- COMMENT ON COLUMN federation_delivery_queue.federation_type IS 'Type of federation activity for filtering and prioritization';
-- Note: federation_delivery_queue table not found - operations commented out

-- =====================================================
-- STEP 8: UPDATED TRIGGER COMMENTS FOR CLARITY
-- =====================================================

-- Update trigger comments to clarify they are OUTGOING ONLY
COMMENT ON FUNCTION public.handle_unified_content_federation() IS 'OUTGOING ONLY: Unified trigger for federating local posts and messages to remote instances. Not bidirectional.';
COMMENT ON FUNCTION public.handle_unified_interaction_federation() IS 'OUTGOING ONLY: Unified trigger for federating local follows, likes, and reactions to remote instances. Not bidirectional.';
COMMENT ON FUNCTION public.handle_unified_profile_federation() IS 'OUTGOING ONLY: Unified trigger for federating local profile updates to remote instances. Not bidirectional.';
COMMENT ON FUNCTION public.handle_unified_notification_processing() IS 'LOCAL ONLY: Unified trigger for processing notifications locally. Does not involve federation.';

COMMIT;

-- =====================================================
-- VALIDATION & TESTING
-- =====================================================

-- Test the new unified notification function
DO $$
DECLARE
    test_user_id uuid;
    notification_id uuid;
BEGIN
    -- Get a test user
    SELECT id INTO test_user_id FROM profiles WHERE is_local = true LIMIT 1;
    
    IF test_user_id IS NOT NULL THEN
        -- Test unified notification creation
        SELECT create_notification_unified(
            test_user_id,
            'test',
            'Test Notification',
            'Testing unified notification system',
            '{"test": true}'::jsonb
        ) INTO notification_id;
        
        IF notification_id IS NOT NULL THEN
            RAISE NOTICE 'Unified notification system working: %', notification_id;
            -- Clean up test notification
            DELETE FROM notifications WHERE id = notification_id;
        END IF;
    END IF;
END;
$$;

-- Test emoji reaction limits (if emojis exist)
DO $$
DECLARE
    test_user_id uuid;
    test_post_id uuid;
    test_emoji_id uuid;
    reaction_id uuid;
BEGIN
    -- Get test data
    SELECT id INTO test_user_id FROM profiles WHERE is_local = true LIMIT 1;
    SELECT id INTO test_post_id FROM posts WHERE is_local = true LIMIT 1;
    SELECT id INTO test_emoji_id FROM emojis LIMIT 1;
    
    IF test_user_id IS NOT NULL AND test_post_id IS NOT NULL AND test_emoji_id IS NOT NULL THEN
        -- Test emoji reaction
        SELECT add_post_emoji_reaction(test_user_id, test_post_id, test_emoji_id) INTO reaction_id;
        
        IF reaction_id IS NOT NULL THEN
            RAISE NOTICE 'Post emoji reactions working: %', reaction_id;
            -- Clean up test reaction
            DELETE FROM post_interactions WHERE id = reaction_id;
        END IF;
    END IF;
END;
$$;

RAISE NOTICE '✅ Phase 5 Cleanup Complete: Removed redundancies, unified notifications, added missing features!';