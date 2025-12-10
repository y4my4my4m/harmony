-- =============================================================================
-- Harmony Database Schema - Core Functions
-- =============================================================================
-- Helper functions, utilities, and commonly used operations
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PROFILE HELPERS
-- ---------------------------------------------------------------------------

-- Get current user's profile ID (used by RLS)
CREATE OR REPLACE FUNCTION public.get_current_profile_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT id FROM public.profiles WHERE auth_user_id = auth.uid() LIMIT 1;
$$;

COMMENT ON FUNCTION public.get_current_profile_id() IS 
'Returns the profile ID for the currently authenticated user. Used by RLS policies.';

-- Alternative function name for compatibility
CREATE OR REPLACE FUNCTION public.get_current_user_profile_id()
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
    profile_uuid uuid;
BEGIN
    SELECT id INTO profile_uuid
    FROM profiles
    WHERE auth_user_id = auth.uid()
    LIMIT 1;
    
    RETURN profile_uuid;
END;
$$;

-- Check if current user is admin
CREATE OR REPLACE FUNCTION public.is_current_user_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT COALESCE(
        (SELECT is_admin FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
$$;

-- Check if author is suspended (used by RLS)
CREATE OR REPLACE FUNCTION public.is_author_suspended(p_author_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
    SELECT COALESCE(
        (SELECT COALESCE(is_suspended, false) FROM public.profiles WHERE id = p_author_id LIMIT 1),
        false
    )
$$;

COMMENT ON FUNCTION public.is_author_suspended(p_author_id uuid) IS 
'Returns true if the post author is suspended. Returns FALSE for missing profiles.';

-- ---------------------------------------------------------------------------
-- SERVER HELPERS
-- ---------------------------------------------------------------------------

-- Get channel's server ID
CREATE OR REPLACE FUNCTION public.get_channel_server_id(channel_uuid uuid)
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
    SELECT server_id FROM public.channels WHERE id = channel_uuid LIMIT 1;
$$;

-- Get default channel for a server
CREATE OR REPLACE FUNCTION public.get_default_channel(p_server_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    channel_id UUID;
BEGIN
    SELECT id INTO channel_id
    FROM channels 
    WHERE server_id = p_server_id 
      AND type = 0 
    ORDER BY 
        CASE WHEN name = 'general' THEN 0 ELSE 1 END,
        "order" ASC,
        created_at ASC
    LIMIT 1;
    
    RETURN channel_id;
END;
$$;

-- Check if server has remote members
CREATE OR REPLACE FUNCTION public.server_has_remote_members(p_server_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
    SELECT EXISTS(
        SELECT 1 
        FROM user_servers us
        JOIN profiles p ON us.user_id = p.id
        WHERE us.server_id = p_server_id
          AND p.is_local = false
          AND us.status = 'accepted'
    );
$$;

-- Check bot permission
CREATE OR REPLACE FUNCTION public.check_bot_permission(p_bot_id uuid, p_server_id uuid, p_permission text)
RETURNS boolean
LANGUAGE plpgsql
AS $$
DECLARE
    v_has_permission boolean := false;
BEGIN
    SELECT 
        CASE p_permission
            WHEN 'read_messages' THEN read_messages
            WHEN 'send_messages' THEN send_messages
            WHEN 'manage_messages' THEN manage_messages
            WHEN 'embed_links' THEN embed_links
            WHEN 'attach_files' THEN attach_files
            WHEN 'mention_everyone' THEN mention_everyone
            WHEN 'add_reactions' THEN add_reactions
            WHEN 'manage_channels' THEN manage_channels
            WHEN 'kick_members' THEN kick_members
            WHEN 'ban_members' THEN ban_members
            ELSE false
        END INTO v_has_permission
    FROM bot_server_permissions
    WHERE bot_id = p_bot_id AND server_id = p_server_id AND is_active = true;
    
    RETURN COALESCE(v_has_permission, false);
END;
$$;

-- ---------------------------------------------------------------------------
-- CONVERSATION HELPERS
-- ---------------------------------------------------------------------------

-- Create or get direct conversation between two users
CREATE OR REPLACE FUNCTION public.create_or_get_direct_conversation(user1_uuid uuid, user2_uuid uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    conversation_uuid UUID;
    caller_profile_id UUID;
BEGIN
    -- SECURITY: Get caller's PROFILE ID (not auth.uid() which is different!)
    SELECT id INTO caller_profile_id FROM profiles WHERE auth_user_id = auth.uid();
    
    IF caller_profile_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;
    
    -- SECURITY: Caller must be one of the participants
    IF caller_profile_id != user1_uuid AND caller_profile_id != user2_uuid THEN
        RAISE EXCEPTION 'Unauthorized: You can only create conversations you are a participant of';
    END IF;
    
    -- Try to find existing direct conversation
    SELECT c.id INTO conversation_uuid
    FROM conversations c
    WHERE c.is_group = false
      AND EXISTS (
          SELECT 1 FROM conversation_participants cp1 
          WHERE cp1.conversation_id = c.id 
            AND cp1.user_id = user1_uuid 
            AND cp1.left_at IS NULL
      )
      AND EXISTS (
          SELECT 1 FROM conversation_participants cp2 
          WHERE cp2.conversation_id = c.id 
            AND cp2.user_id = user2_uuid 
            AND cp2.left_at IS NULL
      );
    
    -- If not found, create new conversation
    IF conversation_uuid IS NULL THEN
        INSERT INTO conversations (is_group, owner_id)
        VALUES (false, user1_uuid)
        RETURNING id INTO conversation_uuid;
        
        -- Add both users as participants
        INSERT INTO conversation_participants (conversation_id, user_id, role)
        VALUES (conversation_uuid, user1_uuid, 'member')
        ON CONFLICT (conversation_id, user_id) DO NOTHING;
        
        INSERT INTO conversation_participants (conversation_id, user_id, role)
        VALUES (conversation_uuid, user2_uuid, 'member')
        ON CONFLICT (conversation_id, user_id) DO NOTHING;
    END IF;
    
    RETURN conversation_uuid;
END;
$$;

-- Get or create DM conversation (for federation)
CREATE OR REPLACE FUNCTION public.get_or_create_dm_conversation(p_user1_id uuid, p_user2_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_conversation_id uuid;
BEGIN
    -- Try to find existing conversation
    SELECT c.id INTO v_conversation_id
    FROM conversations c
    JOIN conversation_participants cp1 ON c.id = cp1.conversation_id AND cp1.user_id = p_user1_id
    JOIN conversation_participants cp2 ON c.id = cp2.conversation_id AND cp2.user_id = p_user2_id
    WHERE c.is_group = false
    LIMIT 1;
    
    IF v_conversation_id IS NULL THEN
        -- Create new conversation
        INSERT INTO conversations (is_group)
        VALUES (false)
        RETURNING id INTO v_conversation_id;
        
        INSERT INTO conversation_participants (conversation_id, user_id)
        VALUES (v_conversation_id, p_user1_id), (v_conversation_id, p_user2_id);
    END IF;
    
    RETURN v_conversation_id;
END;
$$;

-- Add user to conversation
CREATE OR REPLACE FUNCTION public.add_user_to_conversation(conversation_uuid uuid, user_uuid uuid, user_role text DEFAULT 'member')
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    participant_id uuid;
BEGIN
    INSERT INTO conversation_participants (conversation_id, user_id, role)
    VALUES (conversation_uuid, user_uuid, user_role)
    ON CONFLICT (conversation_id, user_id) 
    DO UPDATE SET left_at = NULL, role = user_role
    RETURNING id INTO participant_id;
    
    RETURN participant_id;
END;
$$;

-- Get conversation participants
CREATE OR REPLACE FUNCTION public.get_conversation_participants(conversation_uuid uuid)
RETURNS TABLE(user_id uuid, role text, joined_at timestamp with time zone, is_muted boolean, last_read_at timestamp with time zone)
LANGUAGE plpgsql
AS $$
BEGIN
    RETURN QUERY
    SELECT 
        cp.user_id,
        cp.role,
        cp.joined_at,
        cp.muted as is_muted,
        cp.last_read_at
    FROM conversation_participants cp
    WHERE cp.conversation_id = conversation_uuid
      AND cp.left_at IS NULL;
END;
$$;

-- ---------------------------------------------------------------------------
-- NOTIFICATION HELPERS
-- ---------------------------------------------------------------------------

-- Get unread notification count
CREATE OR REPLACE FUNCTION public.get_unread_notification_count(p_user_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
AS $$
    SELECT COUNT(*)::INTEGER
    FROM notifications
    WHERE user_id = p_user_id AND read = false;
$$;

-- Create default notification preferences
CREATE OR REPLACE FUNCTION public.create_default_notification_preferences(p_user_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
    INSERT INTO notification_preferences (user_id)
    VALUES (p_user_id)
    ON CONFLICT (user_id) DO NOTHING;
$$;

-- ---------------------------------------------------------------------------
-- STATUS HELPERS
-- ---------------------------------------------------------------------------

-- Get custom status
CREATE OR REPLACE FUNCTION public.get_custom_status(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
AS $$
DECLARE
    v_status jsonb;
    v_expires_at timestamptz;
BEGIN
    SELECT custom_status INTO v_status
    FROM profiles
    WHERE id = p_user_id;
    
    IF v_status IS NULL THEN
        RETURN NULL;
    END IF;
    
    -- Check if expired
    v_expires_at := (v_status->>'expires_at')::timestamptz;
    IF v_expires_at IS NOT NULL AND v_expires_at < NOW() THEN
        UPDATE profiles SET custom_status = NULL WHERE id = p_user_id;
        RETURN NULL;
    END IF;
    
    RETURN v_status;
END;
$$;

-- Set custom status
CREATE OR REPLACE FUNCTION public.set_custom_status(
    p_user_id uuid,
    p_type text DEFAULT 'custom',
    p_text text DEFAULT NULL,
    p_emoji text DEFAULT NULL,
    p_emoji_url text DEFAULT NULL,
    p_details text DEFAULT NULL,
    p_state text DEFAULT NULL,
    p_duration_minutes integer DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_status jsonb;
    v_expires_at timestamptz;
BEGIN
    -- SECURITY: Verify the caller owns this profile
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = p_user_id AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot modify another user''s status';
    END IF;

    IF p_type NOT IN ('custom', 'playing', 'listening', 'watching', 'competing', 'streaming') THEN
        RAISE EXCEPTION 'Invalid activity type';
    END IF;
    
    IF p_duration_minutes IS NOT NULL AND p_duration_minutes > 0 THEN
        v_expires_at := NOW() + (p_duration_minutes || ' minutes')::interval;
    END IF;
    
    v_status := jsonb_build_object(
        'type', p_type,
        'text', p_text,
        'emoji', p_emoji,
        'emoji_url', p_emoji_url,
        'details', p_details,
        'state', p_state,
        'set_at', NOW(),
        'expires_at', v_expires_at
    );
    
    -- Remove null values
    v_status := (
        SELECT jsonb_object_agg(key, value)
        FROM jsonb_each(v_status)
        WHERE value IS NOT NULL AND value != 'null'::jsonb
    );
    
    UPDATE profiles
    SET custom_status = v_status, last_status_update = NOW()
    WHERE id = p_user_id;
    
    RETURN v_status;
END;
$$;

-- Clear custom status
CREATE OR REPLACE FUNCTION public.clear_custom_status(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- SECURITY: Verify the caller owns this profile
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = p_user_id AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot modify another user''s status';
    END IF;

    UPDATE profiles
    SET custom_status = NULL, last_status_update = NOW()
    WHERE id = p_user_id;
    
    RETURN true;
END;
$$;

-- ---------------------------------------------------------------------------
-- UTILITY FUNCTIONS
-- ---------------------------------------------------------------------------

-- Handle messages updated_at
CREATE OR REPLACE FUNCTION public.handle_messages_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

-- Update push subscription timestamp
CREATE OR REPLACE FUNCTION public.update_push_subscription_timestamp()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

-- Update roles updated_at
CREATE OR REPLACE FUNCTION public.update_roles_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$;

-- Extract message text from content parts
CREATE OR REPLACE FUNCTION public.extract_message_text(content_parts jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    result text := '';
    part jsonb;
BEGIN
    IF content_parts IS NULL OR jsonb_typeof(content_parts) != 'array' THEN
        RETURN '';
    END IF;
    
    FOR part IN SELECT jsonb_array_elements(content_parts)
    LOOP
        IF part->>'type' = 'text' THEN
            result := result || COALESCE(part->>'text', '');
        ELSIF part->>'type' = 'mention' THEN
            result := result || '@' || COALESCE(part->>'username', '');
        END IF;
    END LOOP;
    
    RETURN trim(result);
END;
$$;

-- Detect message features
CREATE OR REPLACE FUNCTION public.detect_message_features(content_parts jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    has_media boolean := false;
    has_url boolean := false;
    part jsonb;
BEGIN
    IF content_parts IS NULL OR jsonb_typeof(content_parts) != 'array' THEN
        RETURN jsonb_build_object('has_media', false, 'has_url', false);
    END IF;
    
    FOR part IN SELECT jsonb_array_elements(content_parts)
    LOOP
        IF part->>'type' IN ('image', 'video', 'audio', 'file') THEN
            has_media := true;
        ELSIF part->>'type' = 'url' THEN
            has_url := true;
        END IF;
    END LOOP;
    
    RETURN jsonb_build_object('has_media', has_media, 'has_url', has_url);
END;
$$;

-- Extract URL host
CREATE OR REPLACE FUNCTION public.extract_url_host(p_url text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    RETURN lower(regexp_replace(p_url, '^https?://([^/]+).*$', '\1'));
EXCEPTION
    WHEN OTHERS THEN
        RETURN NULL;
END;
$$;

-- Normalize embed URL
CREATE OR REPLACE FUNCTION public.normalize_embed_url(p_url text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    IF p_url IS NULL OR p_url = '' THEN
        RETURN NULL;
    END IF;
    -- Remove trailing slashes and normalize
    RETURN regexp_replace(trim(p_url), '/+$', '');
END;
$$;

-- ---------------------------------------------------------------------------
-- GRANTS
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.get_current_profile_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_current_user_profile_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_current_user_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_or_get_direct_conversation(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_custom_status(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_custom_status(uuid, text, text, text, text, text, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.clear_custom_status(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_unread_notification_count(uuid) TO authenticated;

DO $$
BEGIN
    RAISE NOTICE 'Core functions created successfully';
END $$;

