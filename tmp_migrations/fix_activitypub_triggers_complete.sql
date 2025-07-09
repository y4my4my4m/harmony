-- =============================================
-- COMPREHENSIVE FIX FOR ACTIVITYPUB TRIGGERS
-- =============================================
-- This migration removes ALL problematic ActivityPub triggers and replaces them with simple, working versions

-- 1. DROP ALL EXISTING TRIGGERS AND FUNCTIONS
DROP TRIGGER IF EXISTS create_timeline_entries_trigger ON posts;
DROP TRIGGER IF EXISTS activitypub_follow_notification_trigger ON follows;
DROP TRIGGER IF EXISTS activitypub_favorite_notification_trigger ON post_interactions;
DROP TRIGGER IF EXISTS activitypub_reblog_notification_trigger ON post_interactions;
DROP TRIGGER IF EXISTS activitypub_mention_notification_trigger ON posts;
DROP TRIGGER IF EXISTS activitypub_reply_notification_trigger ON posts;
DROP TRIGGER IF EXISTS trigger_activitypub_follow_notifications ON follows;
DROP TRIGGER IF EXISTS trigger_activitypub_interaction_notifications ON post_interactions;
DROP TRIGGER IF EXISTS trigger_activitypub_post_notifications ON posts;

-- Drop all existing functions
DROP FUNCTION IF EXISTS create_timeline_entries();
DROP FUNCTION IF EXISTS create_activitypub_notification(UUID, VARCHAR(50), JSONB, INTEGER);
DROP FUNCTION IF EXISTS handle_activitypub_follow_notification();
DROP FUNCTION IF EXISTS handle_activitypub_favorite_notification();
DROP FUNCTION IF EXISTS handle_activitypub_reblog_notification();
DROP FUNCTION IF EXISTS handle_activitypub_mention_notification();
DROP FUNCTION IF EXISTS handle_activitypub_reply_notification();
DROP FUNCTION IF EXISTS handle_follow_notifications();
DROP FUNCTION IF EXISTS handle_interaction_notifications();
DROP FUNCTION IF EXISTS handle_post_notifications();
DROP FUNCTION IF EXISTS extract_activitypub_mentions(JSONB);
DROP FUNCTION IF EXISTS resolve_username_to_id(TEXT, TEXT);
DROP FUNCTION IF EXISTS extract_post_text_content(JSONB);
DROP FUNCTION IF EXISTS create_post_excerpt(JSONB, INTEGER);

-- 2. CREATE SIMPLE, WORKING FUNCTIONS

-- Simple function to create notifications without complex operations
CREATE OR REPLACE FUNCTION create_simple_activitypub_notification(
    p_user_id UUID,
    p_type VARCHAR(50),
    p_data JSONB
)
RETURNS UUID AS $$
DECLARE
    notification_id UUID;
BEGIN
    INSERT INTO notifications (
        user_id,
        type,
        data,
        expires_at,
        created_at
    ) VALUES (
        p_user_id,
        p_type,
        p_data,
        NOW() + '30 days'::interval,  -- Simple interval without multiplication
        NOW()
    ) RETURNING id INTO notification_id;

    RETURN notification_id;
END;
$$ LANGUAGE plpgsql;

-- Simple timeline entries function (just for author's own timeline)
CREATE OR REPLACE FUNCTION create_simple_timeline_entries()
RETURNS TRIGGER AS $$
BEGIN
    -- Only add to author's own timeline
    INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
    VALUES (NEW.author_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000);
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Simple follow notification function
CREATE OR REPLACE FUNCTION handle_simple_follow_notifications()
RETURNS TRIGGER AS $$
DECLARE
    follower_profile RECORD;
BEGIN
    -- Only handle new follows
    IF TG_OP = 'INSERT' AND NEW.status = 'accepted' THEN
        -- Get follower profile
        SELECT id, username, display_name, avatar_url, domain
        INTO follower_profile
        FROM profiles 
        WHERE id = NEW.follower_id;
        
        IF FOUND THEN
            PERFORM create_simple_activitypub_notification(
                NEW.following_id,
                'activitypub_follow',
                jsonb_build_object(
                    'follower', jsonb_build_object(
                        'id', follower_profile.id,
                        'username', follower_profile.username,
                        'display_name', follower_profile.display_name,
                        'avatar_url', follower_profile.avatar_url,
                        'domain', follower_profile.domain
                    ),
                    'follow_id', NEW.id
                )
            );
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Simple interaction notification function  
CREATE OR REPLACE FUNCTION handle_simple_interaction_notifications()
RETURNS TRIGGER AS $$
DECLARE
    post_record RECORD;
    user_profile RECORD;
BEGIN
    -- Only handle new interactions
    IF TG_OP = 'INSERT' THEN
        -- Get post and user info
        SELECT p.id, p.author_id, p.content
        INTO post_record
        FROM posts p
        WHERE p.id = NEW.post_id;
        
        -- Get user profile
        SELECT id, username, display_name, avatar_url, domain
        INTO user_profile
        FROM profiles 
        WHERE id = NEW.user_id;
        
        -- Only notify if post exists, user exists, and not self-interaction
        IF FOUND AND post_record.author_id != NEW.user_id THEN
            -- Handle favorites
            IF NEW.interaction_type = 'favorite' THEN
                PERFORM create_simple_activitypub_notification(
                    post_record.author_id,
                    'activitypub_favorite',
                    jsonb_build_object(
                        'user', jsonb_build_object(
                            'id', user_profile.id,
                            'username', user_profile.username,
                            'display_name', user_profile.display_name,
                            'avatar_url', user_profile.avatar_url,
                            'domain', user_profile.domain
                        ),
                        'post_id', post_record.id,
                        'interaction_id', NEW.id
                    )
                );
            END IF;
            
            -- Handle reblogs
            IF NEW.interaction_type = 'reblog' THEN
                PERFORM create_simple_activitypub_notification(
                    post_record.author_id,
                    'activitypub_reblog',
                    jsonb_build_object(
                        'user', jsonb_build_object(
                            'id', user_profile.id,
                            'username', user_profile.username,
                            'display_name', user_profile.display_name,
                            'avatar_url', user_profile.avatar_url,
                            'domain', user_profile.domain
                        ),
                        'post_id', post_record.id,
                        'interaction_id', NEW.id
                    )
                );
            END IF;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Simple post notification function (for replies only)
CREATE OR REPLACE FUNCTION handle_simple_post_notifications()
RETURNS TRIGGER AS $$
DECLARE
    parent_post RECORD;
    author_profile RECORD;
BEGIN
    -- Only handle new posts that are replies
    IF TG_OP = 'INSERT' AND NEW.in_reply_to IS NOT NULL THEN
        -- Get parent post
        SELECT id, author_id
        INTO parent_post
        FROM posts
        WHERE id = NEW.in_reply_to;
        
        -- Get reply author profile
        SELECT id, username, display_name, avatar_url, domain
        INTO author_profile
        FROM profiles 
        WHERE id = NEW.author_id;
        
        -- Only notify if parent exists and not replying to self
        IF FOUND AND parent_post.author_id != NEW.author_id THEN
            PERFORM create_simple_activitypub_notification(
                parent_post.author_id,
                'activitypub_reply',
                jsonb_build_object(
                    'author', jsonb_build_object(
                        'id', author_profile.id,
                        'username', author_profile.username,
                        'display_name', author_profile.display_name,
                        'avatar_url', author_profile.avatar_url,
                        'domain', author_profile.domain
                    ),
                    'post_id', NEW.id,
                    'parent_post_id', parent_post.id
                )
            );
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. CREATE SIMPLE TRIGGERS

-- Timeline trigger (simple version)
CREATE TRIGGER create_simple_timeline_entries_trigger
    AFTER INSERT ON posts
    FOR EACH ROW
    EXECUTE FUNCTION create_simple_timeline_entries();

-- Follow notification trigger
CREATE TRIGGER simple_activitypub_follow_notifications
    AFTER INSERT OR UPDATE ON follows
    FOR EACH ROW
    EXECUTE FUNCTION handle_simple_follow_notifications();

-- Interaction notification trigger
CREATE TRIGGER simple_activitypub_interaction_notifications
    AFTER INSERT ON post_interactions
    FOR EACH ROW
    EXECUTE FUNCTION handle_simple_interaction_notifications();

-- Post notification trigger (replies)
CREATE TRIGGER simple_activitypub_post_notifications
    AFTER INSERT ON posts
    FOR EACH ROW
    EXECUTE FUNCTION handle_simple_post_notifications();

-- 4. VERIFY SETUP
SELECT 
    'Simple ActivityPub triggers created successfully' as status,
    COUNT(*) as trigger_count
FROM pg_trigger 
WHERE tgname LIKE '%simple_activitypub%' OR tgname LIKE '%simple_timeline%'; 