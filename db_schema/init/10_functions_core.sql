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
SET search_path = public
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
SET search_path = public
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
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT is_admin FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
$$;

-- Check if current user is instance moderator
CREATE OR REPLACE FUNCTION public.is_current_user_moderator()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT is_moderator FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
$$;

-- Check if current user is admin OR moderator
CREATE OR REPLACE FUNCTION public.is_current_user_admin_or_mod()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT (is_admin OR is_moderator) FROM public.profiles WHERE auth_user_id = auth.uid()),
        false
    );
$$;

-- Check if current user can manage messages in a given channel
-- Checks server ownership, server admin role, and MANAGE_MESSAGES (bit 21)
CREATE OR REPLACE FUNCTION public.can_current_user_manage_messages_in_channel(p_channel_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_profile_id uuid;
    v_server_id uuid;
    v_is_owner boolean;
    v_has_perm boolean;
BEGIN
    v_profile_id := public.get_current_profile_id();
    IF v_profile_id IS NULL THEN RETURN false; END IF;

    SELECT server_id INTO v_server_id FROM public.channels WHERE id = p_channel_id;
    IF v_server_id IS NULL THEN RETURN false; END IF;

    SELECT (owner = v_profile_id) INTO v_is_owner FROM public.servers WHERE id = v_server_id;
    IF v_is_owner THEN RETURN true; END IF;

    -- Check if user has a role with ADMINISTRATOR (bit 0) or MANAGE_MESSAGES (bit 21)
    SELECT EXISTS (
        SELECT 1
        FROM public.user_roles ur
        JOIN public.server_roles sr ON sr.id = ur.role_id
        WHERE ur.user_id = v_profile_id
          AND sr.server_id = v_server_id
          AND (
              sr.is_admin = true
              OR (sr.permissions & (1::bigint << 0)) != 0
              OR (sr.permissions & (1::bigint << 21)) != 0
          )
    ) INTO v_has_perm;

    RETURN v_has_perm;
END;
$$;

-- Check if author is suspended (used by RLS)
CREATE OR REPLACE FUNCTION public.is_author_suspended(p_author_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT COALESCE(
        (SELECT COALESCE(is_suspended, false) FROM public.profiles WHERE id = p_author_id LIMIT 1),
        false
    )
$$;

COMMENT ON FUNCTION public.is_author_suspended(p_author_id uuid) IS 
'Returns true if the post author is suspended. Returns FALSE for missing profiles.';

-- ---------------------------------------------------------------------------
-- BLOCKING HELPERS
-- ---------------------------------------------------------------------------

-- Check if current user is blocked by a specific user
CREATE OR REPLACE FUNCTION public.is_blocked_by(target_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_blocks
        WHERE blocker_id = target_user_id
        AND blocked_user_id = public.get_current_profile_id()
    );
$$;

COMMENT ON FUNCTION public.is_blocked_by IS 'Check if the current user is blocked by the target user';

-- Check if current user has blocked a specific user
CREATE OR REPLACE FUNCTION public.has_blocked(target_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_blocks
        WHERE blocker_id = public.get_current_profile_id()
        AND blocked_user_id = target_user_id
    );
$$;

COMMENT ON FUNCTION public.has_blocked IS 'Check if the current user has blocked the target user';

-- ---------------------------------------------------------------------------
-- MUTING HELPERS
-- ---------------------------------------------------------------------------

-- Check if current user is muted by a specific user (not commonly needed, but for symmetry)
CREATE OR REPLACE FUNCTION public.is_muted_by(target_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_mutes
        WHERE muter_id = target_user_id
        AND muted_user_id = public.get_current_profile_id()
    );
$$;

COMMENT ON FUNCTION public.is_muted_by IS 'Check if the current user is muted by the target user';

-- Check if current user has muted a specific user
CREATE OR REPLACE FUNCTION public.has_muted(target_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_mutes
        WHERE muter_id = public.get_current_profile_id()
        AND muted_user_id = target_user_id
    );
$$;

COMMENT ON FUNCTION public.has_muted IS 'Check if the current user has muted the target user';

-- ---------------------------------------------------------------------------
-- SERVER HELPERS
-- ---------------------------------------------------------------------------

-- Membership check for RLS (SECURITY DEFINER bypasses user_servers RLS; avoids recursion)
CREATE OR REPLACE FUNCTION public.current_user_is_member_of_server(p_server_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1 FROM public.user_servers
        WHERE server_id = p_server_id
          AND user_id = public.get_current_profile_id()
    );
$$;

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
SET search_path = public
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
    WHERE c.type = 'direct'
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
    
    -- If not found, create new conversation using new schema
    IF conversation_uuid IS NULL THEN
        INSERT INTO conversations (type, created_by)
        VALUES ('direct', user1_uuid)
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
SET search_path = public
AS $$
DECLARE
    v_conversation_id uuid;
BEGIN
    -- Try to find existing conversation
    SELECT c.id INTO v_conversation_id
    FROM conversations c
    JOIN conversation_participants cp1 ON c.id = cp1.conversation_id AND cp1.user_id = p_user1_id
    JOIN conversation_participants cp2 ON c.id = cp2.conversation_id AND cp2.user_id = p_user2_id
    WHERE c.type = 'direct'
    LIMIT 1;
    
    IF v_conversation_id IS NULL THEN
        -- Create new conversation using new schema
        INSERT INTO conversations (type)
        VALUES ('direct')
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
SET search_path = public
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
        cp.is_muted,
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
    WHERE user_id = p_user_id AND is_read = false;
$$;

-- Create default notification preferences
CREATE OR REPLACE FUNCTION public.create_default_notification_preferences(p_user_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
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
SET search_path = public
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
SET search_path = public
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
SET search_path = public
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
-- On INSERT: preserve the caller's updated_at or default to created_at
-- On UPDATE: only bump when content actually changes (avoids false "edited" flag)
CREATE OR REPLACE FUNCTION public.handle_messages_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.updated_at := COALESCE(NEW.created_at, NOW());
        RETURN NEW;
    END IF;

    -- UPDATE: only bump when message content is actually edited
    IF OLD.content IS DISTINCT FROM NEW.content THEN
        NEW.updated_at := NOW();
    END IF;
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

-- Enforce force_sensitive: auto-set is_sensitive for posts by force_sensitive authors
CREATE OR REPLACE FUNCTION public.enforce_force_sensitive()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = NEW.author_id AND force_sensitive = true
    ) THEN
        NEW.is_sensitive := true;
    END IF;
    RETURN NEW;
END;
$$;

-- Handle posts insert updated_at (default to created_at so new posts don't appear edited)
CREATE OR REPLACE FUNCTION public.handle_posts_insert_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at := COALESCE(NEW.created_at, NOW());
    RETURN NEW;
END;
$$;

-- Handle posts updated_at (only on content edits, not status/count changes)
CREATE OR REPLACE FUNCTION public.handle_posts_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.content IS DISTINCT FROM NEW.content
       OR OLD.content_warning IS DISTINCT FROM NEW.content_warning
       OR OLD.is_sensitive IS DISTINCT FROM NEW.is_sensitive THEN
        NEW.updated_at := NOW();
    END IF;
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
-- LINK PREVIEW FUNCTIONS
-- ---------------------------------------------------------------------------
-- Architecture: local Harmony post URLs are resolved in SQL via build_harmony_embed.
-- External URLs are handled entirely by the federation backend (no HTTP from DB).
-- The federation backend detects URLs in new messages, fetches previews via
-- LinkPreviewService, and writes embeds back via update_message_embeds RPC.
-- ---------------------------------------------------------------------------

-- Classify URL into provider type
CREATE OR REPLACE FUNCTION public.detect_embed_provider(p_url text) RETURNS text
    LANGUAGE plpgsql STABLE AS $_$
declare
  host text;
  path text;
  instance_domain text := lower(regexp_replace(public.get_instance_domain(), '^https?://', ''));
begin
  host := public.extract_url_host(p_url);
  path := coalesce(substring(p_url from 'https?://[^/]+(/[^?#]*)'), '/');
  if (host = instance_domain or host = 'har.mony.lol') and path ~ '^/posts/[0-9a-fA-F-]{36}' then
    return 'harmony-post';
  elsif host ~ '(youtube\.com|youtu\.be)$' then return 'youtube';
  elsif host ~ 'spotify\.com$' then return 'spotify';
  else return 'generic';
  end if;
end;
$_$;

-- Build embed payload for local Harmony posts (pure SQL, no HTTP)
CREATE OR REPLACE FUNCTION public.build_harmony_embed(p_url text) RETURNS jsonb
    LANGUAGE plpgsql AS $$
declare
  path text := coalesce(substring(p_url from 'https?://[^/]+(/[^?#]*)'), '/');
  post_id uuid;
  post_record record;
  summary text;
  first_image text;
begin
  post_id := substring(path from '/posts/([0-9a-fA-F-]{36})')::uuid;
  if post_id is null then raise exception 'Invalid Harmony post URL: %', p_url; end if;

  select p.id, p.content, p.media_attachments, p.visibility, p.is_deleted, p.is_local, p.metadata,
         pr.id as author_id, pr.username, pr.display_name, pr.domain, pr.avatar_url, pr.color
  into post_record
  from posts p join profiles pr on pr.id = p.author_id where p.id = post_id;

  if not found or post_record.is_deleted or post_record.visibility not in ('public', 'unlisted') then
    raise exception 'Post % unavailable for embedding', post_id;
  end if;

  summary := left(regexp_replace(public.convert_jsonb_to_ap(post_record.content), '<[^>]+>', '', 'g'), 280);

  if jsonb_typeof(post_record.media_attachments) = 'array' then
    first_image := coalesce(post_record.media_attachments->0->>'preview_url', post_record.media_attachments->0->>'url');
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'title', coalesce(post_record.display_name, post_record.username, 'Harmony Post'),
    'description', summary, 'siteName', public.get_instance_domain(),
    'image', first_image, 'icon', post_record.avatar_url, 'color', post_record.color,
    'harmony', jsonb_build_object(
      'postId', post_record.id, 'instanceDomain', public.get_instance_domain(),
      'visibility', post_record.visibility, 'isLocal', post_record.is_local,
      'author', jsonb_build_object('id', post_record.author_id, 'username', post_record.username,
        'display_name', post_record.display_name, 'domain', post_record.domain,
        'avatar_url', post_record.avatar_url, 'color', post_record.color)
    )
  ));
end;
$$;

-- Dispatcher for local URLs (only harmony-post matters; external URLs go through the backend)
CREATE OR REPLACE FUNCTION public.fetch_link_preview(p_url text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public' AS $$
declare
  normalized_url text := public.normalize_embed_url(p_url);
  provider text;
  payload jsonb;
begin
  if normalized_url is null then raise exception 'URL is required'; end if;
  provider := public.detect_embed_provider(normalized_url);
  if provider = 'harmony-post' then
    payload := public.build_harmony_embed(normalized_url);
  else
    return null;
  end if;
  return payload || jsonb_build_object(
    'url', normalized_url, 'normalizedUrl', normalized_url, 'provider', provider,
    'fetchedAt', now(), 'expiresAt', now() + interval '24 hours');
end;
$$;

-- RPC: federation backend calls this to write embeds back after enrichment
CREATE OR REPLACE FUNCTION public.update_message_embeds(p_message_id uuid, p_embeds jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public' AS $$
begin
  update public.messages
  set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('embeds',
    coalesce(metadata->'embeds', '{}'::jsonb) || p_embeds
  )
  where id = p_message_id;
end;
$$;

GRANT EXECUTE ON FUNCTION public.update_message_embeds(uuid, jsonb) TO service_role;

-- RPC: federation backend calls this to write embeds for posts
CREATE OR REPLACE FUNCTION public.update_post_embeds(p_post_id uuid, p_embeds jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public' AS $$
begin
  update public.posts
  set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('embeds',
    coalesce(metadata->'embeds', '{}'::jsonb) || p_embeds
  )
  where id = p_post_id;
end;
$$;

GRANT EXECUTE ON FUNCTION public.update_post_embeds(uuid, jsonb) TO service_role;

-- ---------------------------------------------------------------------------
-- GRANTS
-- ---------------------------------------------------------------------------
GRANT EXECUTE ON FUNCTION public.get_current_profile_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_current_user_profile_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_current_user_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_current_user_moderator() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_current_user_admin_or_mod() TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_current_user_manage_messages_in_channel(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_or_get_direct_conversation(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_custom_status(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_custom_status(uuid, text, text, text, text, text, text, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.clear_custom_status(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_unread_notification_count(uuid) TO authenticated;

-- Blocking and muting helper functions
GRANT EXECUTE ON FUNCTION public.is_blocked_by(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_blocked(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_muted_by(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_muted(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_is_member_of_server(uuid) TO authenticated;

-- ---------------------------------------------------------------------------
-- FEDERATION JOB QUEUE
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.queue_federation_job(
    p_job_name text,
    p_job_data jsonb,
    p_priority integer DEFAULT 5,
    p_retry_limit integer DEFAULT 5,
    p_expire_in_seconds integer DEFAULT 3600
)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_job_id uuid;
    v_target_domain text;
BEGIN
    v_job_id := gen_random_uuid();

    PERFORM pg_notify('federation_jobs', json_build_object(
        'name', p_job_name,
        'id', v_job_id::text,
        'data', p_job_data
    )::text);

    RETURN v_job_id;
EXCEPTION
    WHEN OTHERS THEN
        v_target_domain := p_job_data->>'target_domain';
        IF v_target_domain IS NOT NULL AND v_target_domain != '' THEN
            RAISE LOG 'pg_notify failed, using delivery queue fallback for job % to %', p_job_name, v_target_domain;
            INSERT INTO public.federation_delivery_queue (
                activity_data, target_inbox_url, target_domain,
                sender_id, status, next_attempt_at
            ) VALUES (
                p_job_data,
                COALESCE(p_job_data->>'target_inbox', 'https://' || v_target_domain || '/inbox'),
                v_target_domain,
                (p_job_data->>'sender_id')::UUID,
                'pending',
                NOW()
            )
            RETURNING id INTO v_job_id;

            PERFORM pg_notify('federation_jobs', json_build_object(
                'name', 'delivery-queue-fallback',
                'id', v_job_id::text
            )::text);

            RETURN v_job_id;
        ELSE
            RAISE LOG 'pg_notify failed, skipping job %', p_job_name;
            RETURN NULL;
        END IF;
END;
$$;

DO $$
BEGIN
    RAISE NOTICE 'Core functions created successfully';
END $$;

