-- =============================================
-- ACTIVITYPUB NOTIFICATION TRIGGERS WITH CONTENT (FINAL)
-- =============================================
-- This migration includes post content excerpts and complete data structure

-- Drop existing triggers first to avoid conflicts
DROP TRIGGER IF EXISTS activitypub_follow_notification_trigger ON follows;
DROP TRIGGER IF EXISTS activitypub_favorite_notification_trigger ON post_interactions;
DROP TRIGGER IF EXISTS activitypub_reblog_notification_trigger ON post_interactions;
DROP TRIGGER IF EXISTS activitypub_mention_notification_trigger ON posts;
DROP TRIGGER IF EXISTS activitypub_reply_notification_trigger ON posts;

-- Drop existing functions
DROP FUNCTION IF EXISTS create_activitypub_notification(UUID, VARCHAR(50), JSONB, INTEGER);
DROP FUNCTION IF EXISTS handle_activitypub_follow_notification();
DROP FUNCTION IF EXISTS handle_activitypub_favorite_notification();
DROP FUNCTION IF EXISTS handle_activitypub_reblog_notification();
DROP FUNCTION IF EXISTS handle_activitypub_mention_notification();
DROP FUNCTION IF EXISTS handle_activitypub_reply_notification();

-- =============================================
-- HELPER FUNCTIONS
-- =============================================

-- Function to extract text content from post content (handles JSONB or text)
CREATE OR REPLACE FUNCTION extract_post_text_content(content_data JSONB)
RETURNS TEXT AS $$
BEGIN
    -- If content is a simple string
    IF jsonb_typeof(content_data) = 'string' THEN
        RETURN content_data #>> '{}';
    END IF;
    
    -- If content has text field
    IF content_data ? 'text' THEN
        RETURN content_data ->> 'text';
    END IF;
    
    -- If content has content field  
    IF content_data ? 'content' THEN
        RETURN content_data ->> 'content';
    END IF;
    
    -- Fallback: convert to text and clean up
    RETURN REGEXP_REPLACE(content_data::text, '[{}"]', '', 'g');
END;
$$ LANGUAGE plpgsql;

-- Function to create excerpt from post content
CREATE OR REPLACE FUNCTION create_post_excerpt(content_data JSONB, max_length INTEGER DEFAULT 100)
RETURNS TEXT AS $$
DECLARE
    full_text TEXT;
    excerpt TEXT;
BEGIN
    full_text := extract_post_text_content(content_data);
    
    -- Create excerpt
    IF LENGTH(full_text) <= max_length THEN
        excerpt := full_text;
    ELSE
        excerpt := LEFT(full_text, max_length - 3) || '...';
    END IF;
    
    -- Clean up whitespace
    excerpt := TRIM(REGEXP_REPLACE(excerpt, '\s+', ' ', 'g'));
    
    RETURN excerpt;
END;
$$ LANGUAGE plpgsql;

-- Enhanced function to create structured ActivityPub notifications with post content
CREATE OR REPLACE FUNCTION create_activitypub_notification(
    p_user_id UUID,
    p_type VARCHAR(50),
    p_data JSONB,
    p_expires_days INTEGER DEFAULT 30
)
RETURNS UUID AS $$
DECLARE
    notification_id UUID;
    final_data JSONB;
BEGIN
    -- Generate notification ID
    notification_id := gen_random_uuid();
    
    -- Build final data structure (no title/message fields in schema)
    final_data := p_data || jsonb_build_object(
        'notification_type', p_type,
        'created_at', NOW()::text
    );
    
    -- Insert notification
    INSERT INTO notifications (
        id,
        user_id,
        type,
        data,
        expires_at
    ) VALUES (
        notification_id,
        p_user_id,
        p_type,
        final_data,
        NOW() + (p_expires_days || ' days')::interval
    );
    
    RETURN notification_id;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- FOLLOW NOTIFICATIONS
-- =============================================

CREATE OR REPLACE FUNCTION handle_activitypub_follow_notification()
RETURNS TRIGGER AS $$
DECLARE
    follower_profile RECORD;
BEGIN
    -- Only create notification for accepted follows
    IF NEW.status = 'accepted' THEN
        -- Get follower profile
        SELECT id, username, display_name, avatar_url, domain
        INTO follower_profile
        FROM profiles 
        WHERE id = NEW.follower_id;
        
        IF FOUND THEN
            PERFORM create_activitypub_notification(
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

-- =============================================
-- POST INTERACTION NOTIFICATIONS (FAVORITES & REBLOGS)
-- =============================================

CREATE OR REPLACE FUNCTION handle_activitypub_favorite_notification()
RETURNS TRIGGER AS $$
DECLARE
    post_record RECORD;
    user_profile RECORD;
    post_excerpt TEXT;
BEGIN
    -- Only for favorites
    IF NEW.interaction_type = 'favorite' THEN
        -- Get post details with author
        SELECT p.id, p.author_id, p.content, p.created_at,
               author.username as author_username, 
               author.display_name as author_display_name
        INTO post_record
        FROM posts p
        JOIN profiles author ON p.author_id = author.id
        WHERE p.id = NEW.post_id;
        
        -- Get user who favorited
        SELECT id, username, display_name, avatar_url, domain
        INTO user_profile
        FROM profiles 
        WHERE id = NEW.user_id;
        
        IF FOUND AND post_record.author_id != NEW.user_id THEN
            -- Create post excerpt
            post_excerpt := create_post_excerpt(post_record.content, 80);
            
            PERFORM create_activitypub_notification(
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
                    'post_content', post_excerpt,
                    'post_author', jsonb_build_object(
                        'username', post_record.author_username,
                        'display_name', post_record.author_display_name
                    ),
                    'interaction_id', NEW.id
                )
            );
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION handle_activitypub_reblog_notification()
RETURNS TRIGGER AS $$
DECLARE
    post_record RECORD;
    user_profile RECORD;
    post_excerpt TEXT;
BEGIN
    -- Only for reblogs
    IF NEW.interaction_type = 'reblog' THEN
        -- Get post details with author
        SELECT p.id, p.author_id, p.content, p.created_at,
               author.username as author_username, 
               author.display_name as author_display_name
        INTO post_record
        FROM posts p
        JOIN profiles author ON p.author_id = author.id
        WHERE p.id = NEW.post_id;
        
        -- Get user who reblogged
        SELECT id, username, display_name, avatar_url, domain
        INTO user_profile
        FROM profiles 
        WHERE id = NEW.user_id;
        
        IF FOUND AND post_record.author_id != NEW.user_id THEN
            -- Create post excerpt
            post_excerpt := create_post_excerpt(post_record.content, 80);
            
            PERFORM create_activitypub_notification(
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
                    'post_content', post_excerpt,
                    'post_author', jsonb_build_object(
                        'username', post_record.author_username,
                        'display_name', post_record.author_display_name
                    ),
                    'interaction_id', NEW.id
                )
            );
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- MENTION NOTIFICATIONS
-- =============================================

CREATE OR REPLACE FUNCTION handle_activitypub_mention_notification()
RETURNS TRIGGER AS $$
DECLARE
    mentioned_users TEXT[];
    mentioned_user TEXT;
    mentioned_profile RECORD;
    author_profile RECORD;
    post_excerpt TEXT;
    content_text TEXT;
BEGIN
    -- Extract text content from post
    content_text := extract_post_text_content(NEW.content);
    
    -- Find all @mentions in the content
    mentioned_users := regexp_split_to_array(content_text, '@\w+');
    
    -- Get author profile
    SELECT id, username, display_name, avatar_url, domain
    INTO author_profile
    FROM profiles 
    WHERE id = NEW.author_id;
    
    -- Create post excerpt
    post_excerpt := create_post_excerpt(NEW.content, 80);
    
    -- Process each mention
    FOR mentioned_user IN 
        SELECT unnest(regexp_split_to_array(content_text, '\s+'))
        WHERE unnest(regexp_split_to_array(content_text, '\s+')) ~ '^@\w+'
    LOOP
        -- Clean up the username (remove @)
        mentioned_user := TRIM(LEADING '@' FROM mentioned_user);
        
        -- Find the mentioned user profile
        SELECT id, username, display_name, avatar_url, domain
        INTO mentioned_profile
        FROM profiles 
        WHERE username = mentioned_user AND id != NEW.author_id;
        
        IF FOUND THEN
            PERFORM create_activitypub_notification(
                mentioned_profile.id,
                'activitypub_mention',
                jsonb_build_object(
                    'author', jsonb_build_object(
                        'id', author_profile.id,
                        'username', author_profile.username,
                        'display_name', author_profile.display_name,
                        'avatar_url', author_profile.avatar_url,
                        'domain', author_profile.domain
                    ),
                    'post_id', NEW.id,
                    'post_content', post_excerpt,
                    'mentioned_username', mentioned_user
                )
            );
        END IF;
    END LOOP;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- REPLY NOTIFICATIONS
-- =============================================

CREATE OR REPLACE FUNCTION handle_activitypub_reply_notification()
RETURNS TRIGGER AS $$
DECLARE
    parent_post RECORD;
    author_profile RECORD;
    post_excerpt TEXT;
BEGIN
    -- Only for replies (posts with in_reply_to)
    IF NEW.in_reply_to IS NOT NULL THEN
        -- Get parent post details
        SELECT p.id, p.author_id, p.content,
               author.username as author_username,
               author.display_name as author_display_name
        INTO parent_post
        FROM posts p
        JOIN profiles author ON p.author_id = author.id
        WHERE p.id = NEW.in_reply_to;
        
        -- Get reply author profile
        SELECT id, username, display_name, avatar_url, domain
        INTO author_profile
        FROM profiles 
        WHERE id = NEW.author_id;
        
        IF FOUND AND parent_post.author_id != NEW.author_id THEN
            -- Create excerpt of the reply
            post_excerpt := create_post_excerpt(NEW.content, 80);
            
            PERFORM create_activitypub_notification(
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
                    'post_content', post_excerpt,
                    'parent_post_id', parent_post.id,
                    'parent_post_content', create_post_excerpt(parent_post.content, 50)
                )
            );
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================
-- CREATE TRIGGERS
-- =============================================

-- Follow notifications
CREATE TRIGGER activitypub_follow_notification_trigger
    AFTER UPDATE ON follows
    FOR EACH ROW
    WHEN (NEW.status = 'accepted' AND (OLD.status IS DISTINCT FROM NEW.status))
    EXECUTE FUNCTION handle_activitypub_follow_notification();

-- Favorite notifications
CREATE TRIGGER activitypub_favorite_notification_trigger
    AFTER INSERT ON post_interactions
    FOR EACH ROW
    WHEN (NEW.interaction_type = 'favorite')
    EXECUTE FUNCTION handle_activitypub_favorite_notification();

-- Reblog notifications
CREATE TRIGGER activitypub_reblog_notification_trigger
    AFTER INSERT ON post_interactions
    FOR EACH ROW
    WHEN (NEW.interaction_type = 'reblog')
    EXECUTE FUNCTION handle_activitypub_reblog_notification();

-- Mention notifications
CREATE TRIGGER activitypub_mention_notification_trigger
    AFTER INSERT ON posts
    FOR EACH ROW
    EXECUTE FUNCTION handle_activitypub_mention_notification();

-- Reply notifications
CREATE TRIGGER activitypub_reply_notification_trigger
    AFTER INSERT ON posts
    FOR EACH ROW
    WHEN (NEW.in_reply_to IS NOT NULL)
    EXECUTE FUNCTION handle_activitypub_reply_notification();

-- =============================================
-- VERIFICATION
-- =============================================

-- Verify triggers are created
SELECT 
    trigger_name,
    event_manipulation,
    event_object_table,
    action_statement
FROM information_schema.triggers 
WHERE trigger_name LIKE 'activitypub%notification%'
ORDER BY trigger_name;

COMMIT; 