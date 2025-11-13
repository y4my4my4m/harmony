-- ============================================
-- HARMONY ESSENTIAL FUNCTIONS
-- Simplified from 124 functions to 15 essential ones
-- ============================================

-- Federation functions moved to federation-backend (Node.js/TypeScript)
-- CRUD operations handled by frontend directly
-- Only complex/useful queries remain

-- ============================================
-- 1. CONVERSATION MANAGEMENT
-- ============================================

-- Note: Run drop_all_overloads_first.sql BEFORE this file!

CREATE FUNCTION get_or_create_conversation(
  user1_uuid UUID,
  user2_uuid UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  conversation_uuid UUID;
  sorted_users UUID[];
BEGIN
  -- Sort user IDs to ensure consistent ordering
  sorted_users := ARRAY[LEAST(user1_uuid, user2_uuid), GREATEST(user1_uuid, user2_uuid)];
  
  -- Find existing conversation with these exact participants
  SELECT cp1.conversation_id INTO conversation_uuid
  FROM conversation_participants cp1
  WHERE cp1.user_id = sorted_users[1]
    AND EXISTS (
      SELECT 1 FROM conversation_participants cp2
      WHERE cp2.conversation_id = cp1.conversation_id
        AND cp2.user_id = sorted_users[2]
    )
    AND NOT EXISTS (
      SELECT 1 FROM conversation_participants cp3
      WHERE cp3.conversation_id = cp1.conversation_id
        AND cp3.user_id NOT IN (sorted_users[1], sorted_users[2])
    )
  LIMIT 1;

  -- Create new conversation if not found
  IF conversation_uuid IS NULL THEN
    INSERT INTO conversations (is_group, created_at)
    VALUES (false, NOW())
    RETURNING id INTO conversation_uuid;

    INSERT INTO conversation_participants (conversation_id, user_id)
    VALUES 
      (conversation_uuid, user1_uuid),
      (conversation_uuid, user2_uuid);
      
    RAISE NOTICE 'Created new conversation: %', conversation_uuid;
  END IF;

  RETURN conversation_uuid;
END;
$$;

COMMENT ON FUNCTION get_or_create_conversation IS 
'Get existing 1-to-1 conversation or create new one. Ensures consistent participant ordering.';

-- ============================================
-- 2. USER UTILITIES
-- ============================================

CREATE FUNCTION get_user_handle(p_user_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT username || '@' || domain
  FROM profiles
  WHERE id = p_user_id;
$$;

COMMENT ON FUNCTION get_user_handle IS 
'Get user handle in username@domain format';

CREATE FUNCTION is_local_user(p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT is_local
  FROM profiles
  WHERE id = p_user_id;
$$;

COMMENT ON FUNCTION is_local_user IS
'Check if user is local to this instance';

-- ============================================
-- 3. SEARCH
-- ============================================

CREATE FUNCTION search_users(
  p_query TEXT,
  p_limit INT DEFAULT 20,
  p_local_only BOOLEAN DEFAULT false
)
RETURNS TABLE (
  id UUID,
  username TEXT,
  domain TEXT,
  display_name TEXT,
  avatar TEXT,
  is_local BOOLEAN
)
LANGUAGE sql
STABLE
AS $$
  SELECT id, username, domain, display_name, avatar_url, is_local
  FROM profiles
  WHERE (username ILIKE '%' || p_query || '%' OR display_name ILIKE '%' || p_query || '%')
    AND (NOT p_local_only OR is_local = true)
  ORDER BY 
    CASE WHEN username = p_query THEN 0 ELSE 1 END,
    CASE WHEN username ILIKE p_query || '%' THEN 0 ELSE 1 END,
    CASE WHEN is_local THEN 0 ELSE 1 END
  LIMIT p_limit;
$$;

COMMENT ON FUNCTION search_users IS
'Search users by username or display name with smart ranking';

-- ============================================
-- 4. TIMELINE/FEED
-- ============================================

CREATE FUNCTION get_timeline(
  p_user_id UUID,
  p_limit INT DEFAULT 50,
  p_before TIMESTAMP DEFAULT NOW()
)
RETURNS SETOF posts
LANGUAGE sql
STABLE
AS $$
  SELECT p.*
  FROM posts p
  WHERE p.author_id IN (
    SELECT following_id 
    FROM follows 
    WHERE follower_id = p_user_id AND status = 'accepted'
  )
  AND p.created_at < p_before
  ORDER BY p.created_at DESC
  LIMIT p_limit;
$$;

COMMENT ON FUNCTION get_timeline IS
'Get timeline posts from followed users (home feed)';

-- ============================================
-- 5. HASHTAG UTILITIES
-- ============================================

CREATE FUNCTION extract_hashtags_from_content(p_content JSONB)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  hashtags TEXT[] := ARRAY[]::TEXT[];
  item JSONB;
  text_content TEXT;
  matches TEXT[];
BEGIN
  -- Extract from JSONB array format
  IF jsonb_typeof(p_content) = 'array' THEN
    FOR item IN SELECT * FROM jsonb_array_elements(p_content)
    LOOP
      IF item->>'type' = 'text' THEN
        text_content := item->>'text';
        -- Extract hashtags (#word)
        matches := regexp_matches(text_content, '#([a-zA-Z0-9_]+)', 'g');
        IF matches IS NOT NULL THEN
          hashtags := hashtags || matches;
        END IF;
      END IF;
    END LOOP;
  END IF;

  RETURN array_remove(hashtags, NULL);
END;
$$;

COMMENT ON FUNCTION extract_hashtags_from_content IS
'Extract hashtags from JSONB content array';

CREATE FUNCTION get_trending_hashtags(
  p_days INT DEFAULT 7,
  p_limit INT DEFAULT 20
)
RETURNS TABLE (
  tag TEXT,
  uses_count BIGINT,
  unique_users BIGINT
)
LANGUAGE sql
STABLE
AS $$
  SELECT 
    h.tag,
    COUNT(*) as uses_count,
    COUNT(DISTINCT p.author_id) as unique_users
  FROM post_hashtags ph
  JOIN hashtags h ON ph.hashtag_id = h.id
  JOIN posts p ON ph.post_id = p.id
  WHERE ph.created_at > NOW() - (p_days || ' days')::INTERVAL
  GROUP BY h.tag
  ORDER BY uses_count DESC
  LIMIT p_limit;
$$;

COMMENT ON FUNCTION get_trending_hashtags IS
'Get trending hashtags over specified period';

-- ============================================
-- 6. SYSTEM UTILITIES
-- ============================================

CREATE FUNCTION create_system_message(
  p_channel_id UUID,
  p_message_type TEXT,
  p_data JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  message_id UUID;
  system_content JSONB;
BEGIN
  -- Create content based on message type
  system_content := jsonb_build_array(
    jsonb_build_object(
      'type', 'system',
      'systemType', p_message_type,
      'data', p_data
    )
  );

  INSERT INTO messages (channel_id, content, is_system, created_at)
  VALUES (p_channel_id, system_content, true, NOW())
  RETURNING id INTO message_id;

  RETURN message_id;
END;
$$;

COMMENT ON FUNCTION create_system_message IS
'Create system message (user joined, user left, etc.)';

CREATE FUNCTION create_default_server_structure(p_server_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Create default category
  INSERT INTO categories (server_id, name, position)
  VALUES (p_server_id, 'Text Channels', 0);

  -- Create general channel
  INSERT INTO channels (server_id, name, type, position)
  VALUES (p_server_id, 'general', 'text', 0);

  RAISE NOTICE 'Created default structure for server %', p_server_id;
END;
$$;

COMMENT ON FUNCTION create_default_server_structure IS
'Create default channels/categories when server is created';

-- ============================================
-- 7. NOTIFICATIONS
-- ============================================

CREATE FUNCTION create_notification_structured(
  p_user_id UUID,
  p_type VARCHAR,
  p_data JSONB DEFAULT '{}'::JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  notification_id UUID;
BEGIN
  -- Simple notification creation
  INSERT INTO notifications (user_id, type, data, created_at, is_read)
  VALUES (p_user_id, p_type, p_data, NOW(), false)
  RETURNING id INTO notification_id;

  RETURN notification_id;
END;
$$;

COMMENT ON FUNCTION create_notification_structured IS
'Create notification with structured data';

CREATE FUNCTION get_unread_notification_count(p_user_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
AS $$
  SELECT COUNT(*)::INTEGER
  FROM notifications
  WHERE user_id = p_user_id AND is_read = false;
$$;

COMMENT ON FUNCTION get_unread_notification_count IS
'Get count of unread notifications for user';

-- ============================================
-- 8. MAINTENANCE/CLEANUP (Called by cron)
-- ============================================

CREATE FUNCTION cleanup_old_notifications()
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  -- Delete read notifications older than 30 days
  DELETE FROM notifications
  WHERE is_read = true
    AND created_at < NOW() - INTERVAL '30 days';
    
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  RAISE NOTICE 'Deleted % old notifications', deleted_count;
  RETURN deleted_count;
END;
$$;

COMMENT ON FUNCTION cleanup_old_notifications IS
'Delete old read notifications (run via cron)';

-- ============================================
-- 9. STATS/ADMIN
-- ============================================

CREATE FUNCTION get_system_stats()
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'users_total', (SELECT COUNT(*) FROM profiles WHERE is_local = true),
    'posts_total', (SELECT COUNT(*) FROM posts WHERE is_local = true),
    'servers_total', (SELECT COUNT(*) FROM servers),
    'messages_today', (SELECT COUNT(*) FROM messages WHERE created_at > CURRENT_DATE),
    'active_users_week', (SELECT COUNT(DISTINCT author_id) FROM posts WHERE created_at > NOW() - INTERVAL '7 days')
  );
$$;

COMMENT ON FUNCTION get_system_stats IS
'Get system statistics for admin dashboard';

-- ============================================
-- 10. TRIGGER HELPER FUNCTIONS
-- ============================================

-- Automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

-- Notify federation backend of new events
CREATE OR REPLACE FUNCTION notify_federation_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- PostgreSQL NOTIFY for federation backend to listen
  -- Event type passed via TG_ARGV[0]
  PERFORM pg_notify('federation_events', json_build_object(
    'event', TG_ARGV[0],  -- Event type from trigger definition
    'table', TG_TABLE_NAME,
    'id', NEW.id,
    'data', row_to_json(NEW)
  )::text);
  
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION notify_federation_event IS
'Notify federation backend of events that need federation (posts, follows, reactions)';

-- Create timeline entries for new posts
CREATE OR REPLACE FUNCTION create_comprehensive_timeline_entries()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    follower_record RECORD;
    local_user_record RECORD;
BEGIN
    -- Skip deleted posts
    IF COALESCE(NEW.is_deleted, false) THEN
        RETURN NEW;
    END IF;
    
    -- Add to author's own home timeline (local authors only)
    IF NEW.is_local THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        VALUES (NEW.author_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000)
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END IF;
    
    -- Add to followers' home timelines (for all posts - local and federated)
    IF NEW.visibility IN ('public', 'unlisted') THEN
        FOR follower_record IN 
            SELECT f.follower_id 
            FROM follows f 
            JOIN profiles p ON f.follower_id = p.id
            WHERE f.following_id = NEW.author_id 
              AND f.status = 'accepted'
              AND p.is_local = true
              AND f.follower_id != NEW.author_id
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (follower_record.follower_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        END LOOP;
    END IF;
    
    -- Add to ALL local users' public timeline (for public posts only)
    IF NEW.visibility = 'public' THEN
        FOR local_user_record IN
            SELECT id FROM profiles WHERE is_local = true
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (local_user_record.id, NEW.id, 'public', EXTRACT(epoch FROM NEW.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        END LOOP;
    END IF;
    
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION create_comprehensive_timeline_entries IS
'Creates timeline entries for both local and federated posts';

-- Backfill timeline when following someone
CREATE OR REPLACE FUNCTION backfill_timeline_on_follow()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    post_record RECORD;
BEGIN
    -- Only backfill when follow is accepted and follower is local
    IF NEW.status != 'accepted' THEN
        RETURN NEW;
    END IF;
    
    -- Only backfill for local followers
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = NEW.follower_id AND is_local = true) THEN
        RETURN NEW;
    END IF;
    
    -- Add recent posts from followed user to follower's home timeline
    FOR post_record IN
        SELECT id, created_at
        FROM posts
        WHERE author_id = NEW.following_id
          AND visibility IN ('public', 'unlisted')
          AND NOT COALESCE(is_deleted, false)
        ORDER BY created_at DESC
        LIMIT 20
    LOOP
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        VALUES (NEW.follower_id, post_record.id, 'home', EXTRACT(epoch FROM post_record.created_at) * 1000000)
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END LOOP;
    
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION backfill_timeline_on_follow IS
'Backfills home timeline with recent posts when accepting a follow';

-- Remove posts from timeline when unfollowing
CREATE OR REPLACE FUNCTION remove_timeline_on_unfollow()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Remove all posts from unfollowed user from the follower's home timeline
    DELETE FROM timeline_entries
    WHERE user_id = OLD.follower_id
      AND timeline_type = 'home'
      AND post_id IN (
          SELECT id FROM posts WHERE author_id = OLD.following_id
      );
    
    RETURN OLD;
END;
$$;

COMMENT ON FUNCTION remove_timeline_on_unfollow IS
'Removes posts from home timeline when unfollowing a user';

-- Update post counters automatically
CREATE OR REPLACE FUNCTION update_post_counters()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Increment counter
    UPDATE posts
    SET 
      replies_count = replies_count + 1,
      updated_at = NOW()
    WHERE id = NEW.in_reply_to;
  ELSIF TG_OP = 'DELETE' THEN
    -- Decrement counter
    UPDATE posts
    SET 
      replies_count = GREATEST(0, replies_count - 1),
      updated_at = NOW()
    WHERE id = OLD.in_reply_to;
  END IF;
  
  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMENT ON FUNCTION update_post_counters IS
'Automatically update post counters (replies, reactions, etc.)';

-- ============================================
-- SUMMARY
-- ============================================
-- Total functions: ~15 (down from 124!)
-- 
-- Categories:
-- - Conversation: 1 function
-- - User utilities: 2 functions  
-- - Search: 1 function
-- - Timeline: 1 function
-- - Hashtags: 2 functions
-- - System: 2 functions
-- - Notifications: 2 functions
-- - Maintenance: 1 function
-- - Stats: 1 function
-- - Triggers: 3 helper functions
--
-- All federation logic moved to federation-backend/
-- All simple CRUD done via direct Supabase calls
-- Result: Clean, maintainable, efficient! 🎉

