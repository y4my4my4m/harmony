-- =============================================
-- ACTIVITYPUB NOTIFICATION TRIGGERS MIGRATION
-- =============================================
-- This migration adds comprehensive notification triggers for ActivityPub interactions
-- including follows, favorites, reblogs, mentions, and replies.

-- =============================================
-- HELPER FUNCTIONS
-- =============================================

-- Function to create structured ActivityPub notifications
CREATE OR REPLACE FUNCTION create_activitypub_notification(
    p_user_id UUID,
    p_type VARCHAR(50),
    p_data JSONB,
    p_expires_days INTEGER DEFAULT 30
)
RETURNS UUID AS $$
DECLARE
    notification_id UUID;
    notification_title TEXT;
    notification_message TEXT;
BEGIN
    -- Generate notification title and message based on type
    CASE p_type
        WHEN 'activitypub_follow' THEN
            notification_title := 'New Follower';
            notification_message := COALESCE(p_data->>'follower_display_name', p_data->>'follower_username', 'Someone') || ' started following you';
        
        WHEN 'activitypub_favorite' THEN
            notification_title := 'Post Favorited';
            notification_message := COALESCE(p_data->>'user_display_name', p_data->>'user_username', 'Someone') || ' favorited your post';
        
        WHEN 'activitypub_reblog' THEN
            notification_title := 'Post Reblogged';
            notification_message := COALESCE(p_data->>'user_display_name', p_data->>'user_username', 'Someone') || ' reblogged your post';
        
        WHEN 'activitypub_mention' THEN
            notification_title := 'You were mentioned';
            notification_message := COALESCE(p_data->>'author_display_name', p_data->>'author_username', 'Someone') || ' mentioned you in a post';
        
        WHEN 'activitypub_reply' THEN
            notification_title := 'New Reply';
            notification_message := COALESCE(p_data->>'author_display_name', p_data->>'author_username', 'Someone') || ' replied to your post';
        
        WHEN 'activitypub_follow_request' THEN
            notification_title := 'Follow Request';
            notification_message := COALESCE(p_data->>'follower_display_name', p_data->>'follower_username', 'Someone') || ' requested to follow you';
        
        ELSE
            notification_title := 'ActivityPub Notification';
            notification_message := 'You have a new ActivityPub notification';
    END CASE;

    -- Insert notification
    INSERT INTO notifications (
        user_id,
        type,
        title,
        message,
        data,
        expires_at,
        created_at
    ) VALUES (
        p_user_id,
        p_type,
        notification_title,
        notification_message,
        p_data,
        NOW() + INTERVAL '1 day' * p_expires_days,
        NOW()
    ) RETURNING id INTO notification_id;

    RETURN notification_id;
END;
$$ LANGUAGE plpgsql;

-- Function to extract mentions from post content
CREATE OR REPLACE FUNCTION extract_activitypub_mentions(content JSONB)
RETURNS TEXT[] AS $$
DECLARE
    content_text TEXT;
    mentions TEXT[];
    mention_pattern TEXT := '@([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9.-]+))?';
BEGIN
    -- Convert JSONB content to text for mention extraction
    IF jsonb_typeof(content) = 'string' THEN
        content_text := content #>> '{}';
    ELSE
        content_text := content::TEXT;
    END IF;
    
    -- Extract @username mentions (simplified - could be enhanced)
    SELECT array_agg(DISTINCT (regexp_matches(content_text, mention_pattern, 'g'))[1])
    INTO mentions
    FROM regexp_matches(content_text, mention_pattern, 'g');
    
    RETURN COALESCE(mentions, ARRAY[]::TEXT[]);
END;
$$ LANGUAGE plpgsql;

-- Function to resolve username to user ID
CREATE OR REPLACE FUNCTION resolve_username_to_id(p_username TEXT, p_domain TEXT DEFAULT 'har.mony.lol')
RETURNS UUID AS $$
DECLARE
    user_id UUID;
BEGIN
    SELECT id INTO user_id
    FROM profiles
    WHERE username = p_username
    AND domain = COALESCE(p_domain, 'har.mony.lol');
    
    RETURN user_id;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- NOTIFICATION TRIGGER FUNCTIONS
-- =============================================

-- Trigger function for follow notifications
CREATE OR REPLACE FUNCTION handle_follow_notifications()
RETURNS TRIGGER AS $$
DECLARE
    follower_profile RECORD;
    following_profile RECORD;
    notification_data JSONB;
BEGIN
    -- Only handle INSERT events (new follows)
    IF TG_OP != 'INSERT' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Get follower and following profiles
    SELECT * INTO follower_profile FROM profiles WHERE id = NEW.follower_id;
    SELECT * INTO following_profile FROM profiles WHERE id = NEW.following_id;
    
    -- Don't notify if profiles don't exist
    IF follower_profile IS NULL OR following_profile IS NULL THEN
        RETURN NEW;
    END IF;
    
    -- Don't notify if user follows themselves
    IF NEW.follower_id = NEW.following_id THEN
        RETURN NEW;
    END IF;
    
    -- Build notification data
    notification_data := jsonb_build_object(
        'follower_id', follower_profile.id,
        'follower_username', follower_profile.username,
        'follower_display_name', follower_profile.display_name,
        'follower_avatar_url', follower_profile.avatar_url,
        'follower_domain', follower_profile.domain,
        'follower_handle', CASE 
            WHEN follower_profile.domain = 'har.mony.lol' THEN '@' || follower_profile.username
            ELSE '@' || follower_profile.username || '@' || follower_profile.domain
        END,
        'follow_id', NEW.id,
        'follow_status', NEW.status,
        'timestamp', NEW.created_at,
        'location', jsonb_build_object(
            'instance_domain', 'har.mony.lol'
        )
    );
    
    -- Create notification based on follow status
    IF NEW.status = 'accepted' THEN
        PERFORM create_activitypub_notification(
            NEW.following_id,
            'activitypub_follow',
            notification_data
        );
    ELSIF NEW.status = 'pending' THEN
        PERFORM create_activitypub_notification(
            NEW.following_id,
            'activitypub_follow_request',
            notification_data
        );
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger function for post interaction notifications (favorites, reblogs)
CREATE OR REPLACE FUNCTION handle_interaction_notifications()
RETURNS TRIGGER AS $$
DECLARE
    post_info RECORD;
    user_profile RECORD;
    notification_data JSONB;
    notification_type TEXT;
BEGIN
    -- Only handle INSERT events (new interactions)
    IF TG_OP != 'INSERT' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Get post and user info
    SELECT p.*, a.username as author_username, a.display_name as author_display_name,
           a.avatar_url as author_avatar_url, a.domain as author_domain
    INTO post_info
    FROM posts p
    JOIN profiles a ON p.author_id = a.id
    WHERE p.id = NEW.post_id;
    
    SELECT * INTO user_profile FROM profiles WHERE id = NEW.user_id;
    
    -- Don't notify if post or user doesn't exist
    IF post_info IS NULL OR user_profile IS NULL THEN
        RETURN NEW;
    END IF;
    
    -- Don't notify if user interacts with their own post
    IF post_info.author_id = NEW.user_id THEN
        RETURN NEW;
    END IF;
    
    -- Determine notification type
    CASE NEW.interaction_type
        WHEN 'favorite' THEN
            notification_type := 'activitypub_favorite';
        WHEN 'reblog' THEN
            notification_type := 'activitypub_reblog';
        WHEN 'bookmark' THEN
            -- Don't notify for bookmarks (private action)
            RETURN NEW;
        ELSE
            RETURN NEW;
    END CASE;
    
    -- Build notification data
    notification_data := jsonb_build_object(
        'post_id', post_info.id,
        'post_content', post_info.content,
        'post_url', post_info.url,
        'user_id', user_profile.id,
        'user_username', user_profile.username,
        'user_display_name', user_profile.display_name,
        'user_avatar_url', user_profile.avatar_url,
        'user_domain', user_profile.domain,
        'user_handle', CASE 
            WHEN user_profile.domain = 'har.mony.lol' THEN '@' || user_profile.username
            ELSE '@' || user_profile.username || '@' || user_profile.domain
        END,
        'interaction_type', NEW.interaction_type,
        'interaction_id', NEW.id,
        'timestamp', NEW.created_at,
        'location', jsonb_build_object(
            'instance_domain', 'har.mony.lol'
        )
    );
    
    -- Create notification
    PERFORM create_activitypub_notification(
        post_info.author_id,
        notification_type,
        notification_data
    );
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger function for post notifications (mentions, replies)
CREATE OR REPLACE FUNCTION handle_post_notifications()
RETURNS TRIGGER AS $$
DECLARE
    author_profile RECORD;
    parent_post RECORD;
    mentioned_usernames TEXT[];
    username_item TEXT;
    mentioned_user_id UUID;
    notification_data JSONB;
BEGIN
    -- Only handle INSERT events (new posts)
    IF TG_OP != 'INSERT' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Get author profile
    SELECT * INTO author_profile FROM profiles WHERE id = NEW.author_id;
    
    -- Don't process if author doesn't exist
    IF author_profile IS NULL THEN
        RETURN NEW;
    END IF;
    
    -- Build base notification data
    notification_data := jsonb_build_object(
        'post_id', NEW.id,
        'post_content', NEW.content,
        'post_url', NEW.url,
        'author_id', author_profile.id,
        'author_username', author_profile.username,
        'author_display_name', author_profile.display_name,
        'author_avatar_url', author_profile.avatar_url,
        'author_domain', author_profile.domain,
        'author_handle', CASE 
            WHEN author_profile.domain = 'har.mony.lol' THEN '@' || author_profile.username
            ELSE '@' || author_profile.username || '@' || author_profile.domain
        END,
        'timestamp', NEW.created_at,
        'location', jsonb_build_object(
            'instance_domain', 'har.mony.lol'
        )
    );
    
    -- Handle reply notifications
    IF NEW.in_reply_to IS NOT NULL THEN
        SELECT p.*, a.username as author_username, a.display_name as author_display_name
        INTO parent_post
        FROM posts p
        JOIN profiles a ON p.author_id = a.id
        WHERE p.id = NEW.in_reply_to;
        
        -- Notify parent post author if they exist and it's not a self-reply
        IF parent_post IS NOT NULL AND parent_post.author_id != NEW.author_id THEN
            PERFORM create_activitypub_notification(
                parent_post.author_id,
                'activitypub_reply',
                notification_data || jsonb_build_object(
                    'parent_post_id', parent_post.id,
                    'parent_post_content', parent_post.content
                )
            );
        END IF;
    END IF;
    
    -- Handle mention notifications
    mentioned_usernames := extract_activitypub_mentions(NEW.content);
    
    FOREACH username_item IN ARRAY mentioned_usernames
    LOOP
        mentioned_user_id := resolve_username_to_id(username_item);
        
        -- Notify mentioned user if they exist and it's not the author
        IF mentioned_user_id IS NOT NULL AND mentioned_user_id != NEW.author_id THEN
            PERFORM create_activitypub_notification(
                mentioned_user_id,
                'activitypub_mention',
                notification_data || jsonb_build_object(
                    'mention_content', NEW.content
                )
            );
        END IF;
    END LOOP;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- CREATE TRIGGERS
-- =============================================

-- Drop existing triggers if they exist
DROP TRIGGER IF EXISTS trigger_activitypub_follow_notifications ON follows;
DROP TRIGGER IF EXISTS trigger_activitypub_interaction_notifications ON post_interactions;
DROP TRIGGER IF EXISTS trigger_activitypub_post_notifications ON posts;

-- Create follow notification trigger
CREATE TRIGGER trigger_activitypub_follow_notifications
    AFTER INSERT ON follows
    FOR EACH ROW
    EXECUTE FUNCTION handle_follow_notifications();

-- Create interaction notification trigger
CREATE TRIGGER trigger_activitypub_interaction_notifications
    AFTER INSERT ON post_interactions
    FOR EACH ROW
    EXECUTE FUNCTION handle_interaction_notifications();

-- Create post notification trigger (for mentions and replies)
CREATE TRIGGER trigger_activitypub_post_notifications
    AFTER INSERT ON posts
    FOR EACH ROW
    EXECUTE FUNCTION handle_post_notifications();

-- =============================================
-- ENABLE REALTIME
-- =============================================

-- Ensure notifications table is enabled for realtime (might already be done)
ALTER publication supabase_realtime ADD TABLE notifications;

-- =============================================
-- VERIFICATION
-- =============================================

-- Verify triggers were created
SELECT 
    tgname as trigger_name,
    tgrelid::regclass as table_name,
    proname as function_name
FROM pg_trigger 
JOIN pg_proc ON pg_trigger.tgfoid = pg_proc.oid
WHERE tgname IN (
    'trigger_activitypub_follow_notifications', 
    'trigger_activitypub_interaction_notifications',
    'trigger_activitypub_post_notifications'
);

-- Add comments for documentation
COMMENT ON TRIGGER trigger_activitypub_follow_notifications ON follows IS 'Automatically creates notifications when users follow each other';
COMMENT ON TRIGGER trigger_activitypub_interaction_notifications ON post_interactions IS 'Automatically creates notifications for post interactions (favorites, reblogs)';
COMMENT ON TRIGGER trigger_activitypub_post_notifications ON posts IS 'Automatically creates notifications for mentions and replies in posts';

COMMENT ON FUNCTION create_activitypub_notification(UUID, VARCHAR, JSONB, INTEGER) IS 'Creates standardized ActivityPub notifications with proper formatting';
COMMENT ON FUNCTION extract_activitypub_mentions(JSONB) IS 'Extracts @username mentions from post content';
COMMENT ON FUNCTION resolve_username_to_id(TEXT, TEXT) IS 'Resolves username to user ID for mention notifications';
COMMENT ON FUNCTION handle_follow_notifications() IS 'Trigger function that creates notifications for new follows';
COMMENT ON FUNCTION handle_interaction_notifications() IS 'Trigger function that creates notifications for post interactions';
COMMENT ON FUNCTION handle_post_notifications() IS 'Trigger function that creates notifications for mentions and replies'; 