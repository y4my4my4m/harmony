-- =============================================
-- ACTIVITYPUB NOTIFICATION TRIGGERS MIGRATION (FINAL)
-- =============================================
-- This migration creates the correct data structure expected by NotificationFormatter
-- with nested objects like follower: { username, display_name, avatar_url }

-- =============================================
-- HELPER FUNCTIONS
-- =============================================

-- Function to create structured ActivityPub notifications (final corrected version)
CREATE OR REPLACE FUNCTION create_activitypub_notification(
    p_user_id UUID,
    p_type VARCHAR(50),
    p_data JSONB,
    p_expires_days INTEGER DEFAULT 30
)
RETURNS UUID AS $$
DECLARE
    notification_id UUID;
BEGIN
    -- Insert notification using actual schema (data field only)
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
    
    -- Build notification data with nested structure expected by NotificationFormatter
    notification_data := jsonb_build_object(
        'follower', jsonb_build_object(
            'id', follower_profile.id,
            'username', follower_profile.username,
            'display_name', follower_profile.display_name,
            'avatar_url', follower_profile.avatar_url,
            'domain', follower_profile.domain,
            'handle', CASE 
                WHEN follower_profile.domain = 'har.mony.lol' THEN '@' || follower_profile.username
                ELSE '@' || follower_profile.username || '@' || follower_profile.domain
            END
        ),
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
    post_content_text TEXT;
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
    
    -- Extract text content from post
    IF jsonb_typeof(post_info.content) = 'string' THEN
        post_content_text := post_info.content #>> '{}';
    ELSE
        post_content_text := post_info.content::TEXT;
    END IF;
    
    -- Build notification data with nested structure
    notification_data := jsonb_build_object(
        'user', jsonb_build_object(
            'id', user_profile.id,
            'username', user_profile.username,
            'display_name', user_profile.display_name,
            'avatar_url', user_profile.avatar_url,
            'domain', user_profile.domain,
            'handle', CASE 
                WHEN user_profile.domain = 'har.mony.lol' THEN '@' || user_profile.username
                ELSE '@' || user_profile.username || '@' || user_profile.domain
            END
        ),
        'post_id', post_info.id,
        'post_content', post_content_text,
        'post_url', post_info.url,
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
    post_content_text TEXT;
    parent_content_text TEXT;
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
    
    -- Extract text content from post
    IF jsonb_typeof(NEW.content) = 'string' THEN
        post_content_text := NEW.content #>> '{}';
    ELSE
        post_content_text := NEW.content::TEXT;
    END IF;
    
    -- Build base notification data with nested structure
    notification_data := jsonb_build_object(
        'author', jsonb_build_object(
            'id', author_profile.id,
            'username', author_profile.username,
            'display_name', author_profile.display_name,
            'avatar_url', author_profile.avatar_url,
            'domain', author_profile.domain,
            'handle', CASE 
                WHEN author_profile.domain = 'har.mony.lol' THEN '@' || author_profile.username
                ELSE '@' || author_profile.username || '@' || author_profile.domain
            END
        ),
        'post_id', NEW.id,
        'post_content', post_content_text,
        'post_url', NEW.url,
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
            -- Extract parent post content
            IF jsonb_typeof(parent_post.content) = 'string' THEN
                parent_content_text := parent_post.content #>> '{}';
            ELSE
                parent_content_text := parent_post.content::TEXT;
            END IF;
            
            PERFORM create_activitypub_notification(
                parent_post.author_id,
                'activitypub_reply',
                notification_data || jsonb_build_object(
                    'parent_post_id', parent_post.id,
                    'parent_post_content', parent_content_text
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
                notification_data
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

COMMENT ON FUNCTION create_activitypub_notification(UUID, VARCHAR, JSONB, INTEGER) IS 'Creates ActivityPub notifications with nested data structure for NotificationFormatter';
COMMENT ON FUNCTION extract_activitypub_mentions(JSONB) IS 'Extracts @username mentions from post content';
COMMENT ON FUNCTION resolve_username_to_id(TEXT, TEXT) IS 'Resolves username to user ID for mention notifications';
COMMENT ON FUNCTION handle_follow_notifications() IS 'Trigger function that creates notifications for new follows with proper data structure';
COMMENT ON FUNCTION handle_interaction_notifications() IS 'Trigger function that creates notifications for post interactions with proper data structure';
COMMENT ON FUNCTION handle_post_notifications() IS 'Trigger function that creates notifications for mentions and replies with proper data structure'; 