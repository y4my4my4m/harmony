-- =============================================================================
-- Harmony Database Schema - Core Functions
-- =============================================================================
-- Helper functions, utilities, and commonly used operations
-- =============================================================================

-- ---------------------------------------------------------------------------
-- CONTENT LENGTH HELPERS
-- ---------------------------------------------------------------------------

-- Sum the character length of every `text` part in a MessagePart-shape jsonb
-- array (the format used by `messages.content` and `posts.content`). Walks
-- the array with `->`/`->>` (both IMMUTABLE) so the function itself can be
-- marked IMMUTABLE and referenced from CHECK constraints.
--
-- Non-text parts (mentions, emojis, files, urls, embeds) are skipped because
-- their payloads are structurally bounded by separate validation (file
-- count limits, URL parsing, mention resolution, …).
--
-- Returns 0 for NULL / non-array input so the CHECK constraint never raises
-- on malformed content — that case is handled by the
-- `messages_content_is_array` / `posts_content_is_array` constraints which
-- are checked first.
CREATE OR REPLACE FUNCTION public.jsonb_text_content_length(content jsonb)
RETURNS integer
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
AS $$
DECLARE
    total integer := 0;
    n integer;
    i integer;
    part jsonb;
BEGIN
    IF content IS NULL OR jsonb_typeof(content) <> 'array' THEN
        RETURN 0;
    END IF;

    n := jsonb_array_length(content);
    IF n = 0 THEN
        RETURN 0;
    END IF;

    FOR i IN 0..(n - 1) LOOP
        part := content -> i;
        IF jsonb_typeof(part) = 'object' AND (part ->> 'type') = 'text' THEN
            total := total + COALESCE(char_length(part ->> 'text'), 0);
        END IF;
    END LOOP;

    RETURN total;
END;
$$;

COMMENT ON FUNCTION public.jsonb_text_content_length(jsonb) IS
'Total character count across all text parts of a MessagePart[] jsonb. IMMUTABLE so it can be used from CHECK constraints. Keep MAX_MESSAGE_TEXT_LENGTH / MAX_POST_TEXT_LENGTH in src/utils/messageContentUtils.ts in sync with the constraint limits.';

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
    
    -- Clamp/sanitize free-text fields via the shared helper so the returned
    -- value matches what sanitize_profile_text() stores on the row.
    v_status := jsonb_build_object(
        'type', p_type,
        'text', public.sanitize_profile_string(p_text, 128, false),
        'emoji', public.sanitize_profile_string(p_emoji, 64, false),
        'emoji_url', p_emoji_url,
        'details', public.sanitize_profile_string(p_details, 128, false),
        'state', public.sanitize_profile_string(p_state, 128, false),
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

-- ---------------------------------------------------------------------------
-- CONTENT LENGTH ENFORCEMENT (admin config + absolute backstop)
-- ---------------------------------------------------------------------------
-- Length enforcement has TWO layers, both at the storage boundary so a
-- direct PostgREST POST (bypassing the application) can't slip through:
--
--   1. BEFORE INSERT/UPDATE triggers that read the LIVE admin config
--      (`instance_config.max_message_length` / `max_post_length`) and
--      reject if exceeded. This is the actual user-facing limit — the
--      same number the admin sees in the dashboard.
--
--   2. CHECK constraints that enforce a very large absolute ceiling
--      (50000 chars). Pure safety net for two cases:
--        a) the admin sets a wildly unreasonable value;
--        b) the trigger gets disabled by an operator.
--
-- A CHECK constraint cannot reference a config row (CHECKs must use
-- IMMUTABLE expressions), so the trigger is required to enforce the
-- admin-configured limit at the storage layer. The trigger is the
-- canonical limit; the CHECK is the seatbelt.
--
-- Encrypted messages are exempt from the plaintext char-length cap
-- because their `text` parts hold base64 ciphertext. A separate
-- byte-size cap on the whole row is enforced via the trigger so
-- encrypted rows can't grow unboundedly either.

-- Helper: read the admin config value, with a sensible default + clamp.
-- Falls back to `p_default` when the row is missing / unparseable, and
-- clamps to `[1, p_max_ceiling]` so a misconfigured admin value can't
-- silently disable enforcement.
CREATE OR REPLACE FUNCTION public.get_instance_config_int(
    p_key text,
    p_default integer,
    p_max_ceiling integer
)
RETURNS integer
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    raw_value jsonb;
    parsed integer;
BEGIN
    SELECT config_value INTO raw_value
    FROM public.instance_config
    WHERE config_key = p_key;

    IF raw_value IS NULL THEN
        RETURN LEAST(p_default, p_max_ceiling);
    END IF;

    -- `config_value` is jsonb; values are stored as a number or string.
    BEGIN
        IF jsonb_typeof(raw_value) = 'number' THEN
            parsed := (raw_value::text)::integer;
        ELSIF jsonb_typeof(raw_value) = 'string' THEN
            parsed := (raw_value #>> '{}')::integer;
        ELSE
            parsed := NULL;
        END IF;
    EXCEPTION WHEN OTHERS THEN
        parsed := NULL;
    END;

    IF parsed IS NULL OR parsed < 1 THEN
        RETURN LEAST(p_default, p_max_ceiling);
    END IF;

    RETURN LEAST(parsed, p_max_ceiling);
END;
$$;

COMMENT ON FUNCTION public.get_instance_config_int(text, integer, integer) IS
'Read a numeric value out of `instance_config`, with a fallback default and a hard ceiling. Used by message/post length triggers to enforce the admin-configured limit at the storage layer.';

-- Trigger: enforce the admin-configured `max_message_length` on
-- `messages.content`. Plaintext char count for non-encrypted messages;
-- byte-size cap on the whole row for encrypted ones (the plaintext is
-- not visible here). System messages are exempt.
CREATE OR REPLACE FUNCTION public.enforce_message_length()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    soft_limit integer;
    text_len integer;
    encrypted_byte_limit constant integer := 50000;
BEGIN
    -- System messages are server-generated and tightly bounded.
    IF NEW.is_system IS TRUE THEN
        RETURN NEW;
    END IF;

    IF NEW.encrypted IS TRUE THEN
        -- Plaintext char count is invisible here; cap the on-disk
        -- ciphertext bytes so flipping `encrypted=true` from a direct
        -- POST can't be used to store an unbounded payload.
        IF octet_length(NEW.content::text) > encrypted_byte_limit THEN
            RAISE EXCEPTION 'Encrypted message payload exceeds maximum size of % bytes', encrypted_byte_limit
                USING ERRCODE = 'check_violation',
                      HINT = 'Send shorter messages — the plaintext limit is enforced by the client before encryption.';
        END IF;
        RETURN NEW;
    END IF;

    -- Read the admin's `max_message_length`, defaulting to 2000 and
    -- clamping to the absolute ceiling so a misconfigured admin value
    -- still leaves the CHECK constraint as a backstop.
    soft_limit := public.get_instance_config_int('max_message_length', 2000, 50000);

    text_len := public.jsonb_text_content_length(NEW.content);
    IF text_len > soft_limit THEN
        RAISE EXCEPTION 'Message text exceeds the instance limit of % characters (got %)', soft_limit, text_len
            USING ERRCODE = 'check_violation',
                  HINT = 'Trim the message or ask an instance admin to raise max_message_length in Chat Settings.';
    END IF;

    RETURN NEW;
END;
$$;

-- Same idea for posts: enforce `max_post_length` from instance_config.
CREATE OR REPLACE FUNCTION public.enforce_post_length()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    soft_limit integer;
    text_len integer;
BEGIN
    soft_limit := public.get_instance_config_int('max_post_length', 500, 50000);

    text_len := public.jsonb_text_content_length(NEW.content);
    IF text_len > soft_limit THEN
        RAISE EXCEPTION 'Post text exceeds the instance limit of % characters (got %)', soft_limit, text_len
            USING ERRCODE = 'check_violation',
                  HINT = 'Trim the post or ask an instance admin to raise max_post_length.';
    END IF;

    RETURN NEW;
END;
$$;

-- Apply the triggers + the backstop CHECK constraints.
DO $$
BEGIN
    -- Drop any earlier CHECK constraint that used the (now obsolete)
    -- 5000 / 10000 ceilings so we can re-create with the new 50000
    -- absolute safety net. Stripping whitespace before matching
    -- normalises PostgreSQL's canonical formatting.
    IF EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.conrelid
        WHERE c.conname = 'messages_text_length_check'
          AND r.relname = 'messages'
          AND regexp_replace(pg_get_constraintdef(c.oid), '\s+', '', 'g') ~ '<=\s*(?:5000|10000)\)'
    ) THEN
        ALTER TABLE public.messages DROP CONSTRAINT messages_text_length_check;
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_constraint c
        JOIN pg_class r ON r.oid = c.conrelid
        WHERE c.conname = 'posts_text_length_check'
          AND r.relname = 'posts'
          AND regexp_replace(pg_get_constraintdef(c.oid), '\s+', '', 'g') ~ '<=\s*(?:5000|10000)\)'
    ) THEN
        ALTER TABLE public.posts DROP CONSTRAINT posts_text_length_check;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'messages_text_length_check' AND conrelid = 'public.messages'::regclass
    ) THEN
        ALTER TABLE public.messages
            ADD CONSTRAINT messages_text_length_check
            CHECK (
                encrypted IS TRUE
                OR is_system IS TRUE
                OR public.jsonb_text_content_length(content) <= 50000
            );
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'posts_text_length_check' AND conrelid = 'public.posts'::regclass
    ) THEN
        ALTER TABLE public.posts
            ADD CONSTRAINT posts_text_length_check
            CHECK (public.jsonb_text_content_length(content) <= 50000);
    END IF;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_message_length ON public.messages;
CREATE TRIGGER trg_enforce_message_length
    BEFORE INSERT OR UPDATE OF content, encrypted, is_system ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_message_length();

DROP TRIGGER IF EXISTS trg_enforce_post_length ON public.posts;
CREATE TRIGGER trg_enforce_post_length
    BEFORE INSERT OR UPDATE OF content ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_post_length();

DO $$
BEGIN
    RAISE NOTICE 'Core functions created successfully';
END $$;

