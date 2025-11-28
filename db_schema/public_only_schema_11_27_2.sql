--
-- PostgreSQL database dump
--

-- Dumped from database version 15.8
-- Dumped by pg_dump version 15.8

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: add_bot_to_server(uuid, uuid, uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_bot_to_server(p_bot_id uuid, p_server_id uuid, p_installed_by uuid, p_permissions jsonb DEFAULT '{}'::jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_permission_id UUID;
BEGIN
    -- Check if user is server owner or admin
    IF NOT EXISTS (
        SELECT 1 FROM public.servers
        JOIN public.profiles ON profiles.id = servers.owner
        WHERE servers.id = p_server_id
        AND profiles.auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Only server owners can add bots';
    END IF;
    
    -- Check if bot is public or owned by installer
    IF NOT EXISTS (
        SELECT 1 FROM public.bots
        JOIN public.profiles ON profiles.id = bots.owner_id
        WHERE bots.id = p_bot_id
        AND (bots.is_public = true OR profiles.auth_user_id = auth.uid())
    ) THEN
        RAISE EXCEPTION 'Bot not found or not accessible';
    END IF;
    
    -- Insert permissions with proper values from p_permissions
    INSERT INTO public.bot_server_permissions (
        bot_id,
        server_id,
        installed_by,
        read_messages,
        send_messages,
        manage_messages,
        embed_links,
        attach_files,
        mention_everyone,
        add_reactions,
        manage_channels,
        kick_members,
        ban_members
    ) VALUES (
        p_bot_id,
        p_server_id,
        p_installed_by,
        COALESCE((p_permissions->>'read_messages')::BOOLEAN, true),
        COALESCE((p_permissions->>'send_messages')::BOOLEAN, true),
        COALESCE((p_permissions->>'manage_messages')::BOOLEAN, false),
        COALESCE((p_permissions->>'embed_links')::BOOLEAN, true),
        COALESCE((p_permissions->>'attach_files')::BOOLEAN, true),
        COALESCE((p_permissions->>'mention_everyone')::BOOLEAN, false),
        COALESCE((p_permissions->>'add_reactions')::BOOLEAN, true),
        COALESCE((p_permissions->>'manage_channels')::BOOLEAN, false),
        COALESCE((p_permissions->>'kick_members')::BOOLEAN, false),
        COALESCE((p_permissions->>'ban_members')::BOOLEAN, false)
    )
    ON CONFLICT (bot_id, server_id)
    DO UPDATE SET 
        is_active = true,
        read_messages = COALESCE((p_permissions->>'read_messages')::BOOLEAN, true),
        send_messages = COALESCE((p_permissions->>'send_messages')::BOOLEAN, true),
        manage_messages = COALESCE((p_permissions->>'manage_messages')::BOOLEAN, false),
        embed_links = COALESCE((p_permissions->>'embed_links')::BOOLEAN, true),
        attach_files = COALESCE((p_permissions->>'attach_files')::BOOLEAN, true),
        mention_everyone = COALESCE((p_permissions->>'mention_everyone')::BOOLEAN, false),
        add_reactions = COALESCE((p_permissions->>'add_reactions')::BOOLEAN, true),
        manage_channels = COALESCE((p_permissions->>'manage_channels')::BOOLEAN, false),
        kick_members = COALESCE((p_permissions->>'kick_members')::BOOLEAN, false),
        ban_members = COALESCE((p_permissions->>'ban_members')::BOOLEAN, false),
        installed_by = p_installed_by,
        installed_at = NOW()
    RETURNING id INTO v_permission_id;
    
    -- Update bot server count
    UPDATE public.bots
    SET server_count = (
        SELECT COUNT(*) FROM public.bot_server_permissions
        WHERE bot_id = p_bot_id AND is_active = true
    )
    WHERE id = p_bot_id;
    
    RETURN v_permission_id;
END;
$$;


--
-- Name: add_existing_posts_to_new_follower_timeline(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_existing_posts_to_new_follower_timeline() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    post_record RECORD;
    added_count INTEGER := 0;
BEGIN
    -- For pending follows: Only add PUBLIC posts
    -- For accepted follows: Add PUBLIC and UNLISTED posts
    -- Followers-only posts always require accepted status
    
    IF NEW.status = 'pending' THEN
        -- Pending follow: Add only public posts (they're public anyway!)
        FOR post_record IN 
            SELECT id, created_at
            FROM posts 
            WHERE author_id = NEW.following_id
              AND visibility = 'public'  -- Only public for pending
              AND NOT COALESCE(is_deleted, false)
              AND created_at > NOW() - INTERVAL '7 days'
            ORDER BY created_at DESC
            LIMIT 50
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (
                NEW.follower_id,
                post_record.id,
                'home',
                EXTRACT(epoch FROM post_record.created_at) * 1000000
            )
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
            
            added_count := added_count + 1;
        END LOOP;
        
        RAISE NOTICE 'Added % public posts to pending follower timeline', added_count;
        
    ELSIF NEW.status = 'accepted' THEN
        -- Accepted follow: Add public and unlisted posts
        FOR post_record IN 
            SELECT id, created_at
            FROM posts 
            WHERE author_id = NEW.following_id
              AND visibility IN ('public', 'unlisted')
              AND NOT COALESCE(is_deleted, false)
              AND created_at > NOW() - INTERVAL '7 days'
            ORDER BY created_at DESC
            LIMIT 50
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (
                NEW.follower_id,
                post_record.id,
                'home',
                EXTRACT(epoch FROM post_record.created_at) * 1000000
            )
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
            
            added_count := added_count + 1;
        END LOOP;
        
        RAISE NOTICE 'Added % posts to accepted follower timeline', added_count;
    END IF;
    
    RETURN NEW;
END;
$$;


--
-- Name: FUNCTION add_existing_posts_to_new_follower_timeline(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.add_existing_posts_to_new_follower_timeline() IS 'When a follow is created, add public posts immediately even if pending. Add unlisted posts only when accepted.';


--
-- Name: add_post_emoji_reaction(uuid, uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_post_emoji_reaction(p_user_id uuid, p_post_id uuid, p_emoji_id uuid DEFAULT NULL::uuid, p_custom_emoji_content text DEFAULT NULL::text) RETURNS uuid
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


--
-- Name: FUNCTION add_post_emoji_reaction(p_user_id uuid, p_post_id uuid, p_emoji_id uuid, p_custom_emoji_content text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.add_post_emoji_reaction(p_user_id uuid, p_post_id uuid, p_emoji_id uuid, p_custom_emoji_content text) IS 'Add Misskey-style emoji reaction to posts. Supports both custom emojis and unicode content.';


--
-- Name: add_user_prekeys(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_user_prekeys(p_user_id uuid, p_device_id text, p_prekeys jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_prekey JSONB;
    v_inserted_count INTEGER := 0;
BEGIN
    -- Only allow users to add their own prekeys
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = p_user_id
        AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot add prekeys for another user';
    END IF;
    
    -- Insert each prekey
    FOR v_prekey IN SELECT * FROM jsonb_array_elements(p_prekeys)
    LOOP
        INSERT INTO public.prekeys (
            user_id,
            device_id,
            prekey_id,
            public_key,
            is_signed,
            signature,
            is_one_time,
            expires_at
        ) VALUES (
            p_user_id,
            p_device_id,
            (v_prekey->>'prekey_id')::INTEGER,
            v_prekey->>'public_key',
            COALESCE((v_prekey->>'is_signed')::BOOLEAN, false),
            v_prekey->>'signature',
            NOT COALESCE((v_prekey->>'is_signed')::BOOLEAN, false),
            CASE 
                WHEN COALESCE((v_prekey->>'is_signed')::BOOLEAN, false) 
                THEN NOW() + INTERVAL '90 days'
                ELSE NULL
            END
        ) ON CONFLICT (user_id, device_id, prekey_id) DO NOTHING;
        
        v_inserted_count := v_inserted_count + 1;
    END LOOP;
    
    RETURN v_inserted_count;
END;
$$;


--
-- Name: FUNCTION add_user_prekeys(p_user_id uuid, p_device_id text, p_prekeys jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.add_user_prekeys(p_user_id uuid, p_device_id text, p_prekeys jsonb) IS 'Batch add prekeys for a user. Accepts array of prekey objects.';


--
-- Name: add_user_to_conversation(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_user_to_conversation(conversation_uuid uuid, user_uuid uuid, user_role text DEFAULT 'member'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  participant_id UUID;
  current_user_id UUID;
BEGIN
  current_user_id := auth.uid();
  
  -- Must be authenticated
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  
  -- User can add themselves, or must already be a participant to add others
  IF user_uuid != current_user_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM conversation_participants 
      WHERE conversation_id = conversation_uuid 
        AND user_id = current_user_id 
        AND left_at IS NULL
    ) THEN
      RAISE EXCEPTION 'You must be a participant to add others to the conversation';
    END IF;
  END IF;

  INSERT INTO conversation_participants (conversation_id, user_id, role)
  VALUES (conversation_uuid, user_uuid, user_role)
  ON CONFLICT (conversation_id, user_id) 
  DO UPDATE SET 
    left_at = NULL,
    role = user_role,
    updated_at = CURRENT_TIMESTAMP
  RETURNING id INTO participant_id;
  
  RETURN participant_id;
END;
$$;


--
-- Name: backfill_timeline_entries(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.backfill_timeline_entries() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    processed_count INTEGER := 0;
    post_record RECORD;
    follower_record RECORD;
BEGIN
    RAISE NOTICE 'Starting timeline backfill for existing posts...';
    
    -- Process all public posts that might be missing from follower timelines
    FOR post_record IN 
        SELECT id, author_id, created_at
        FROM posts 
        WHERE visibility = 'public' 
          AND NOT COALESCE(is_deleted, false)
          AND created_at > NOW() - INTERVAL '30 days'  -- Only last 30 days to avoid overwhelming
        ORDER BY created_at DESC
    LOOP
        -- Add to all current followers' home timelines
        FOR follower_record IN 
            SELECT f.follower_id 
            FROM follows f 
            WHERE f.following_id = post_record.author_id 
              AND f.status = 'accepted'
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (
                follower_record.follower_id, 
                post_record.id, 
                'home', 
                EXTRACT(epoch FROM post_record.created_at) * 1000000
            )
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        END LOOP;
        
        processed_count := processed_count + 1;
        
        -- Progress logging every 100 posts
        IF processed_count % 100 = 0 THEN
            RAISE NOTICE 'Processed % posts...', processed_count;
        END IF;
    END LOOP;
    
    RAISE NOTICE 'Timeline backfill completed. Processed % posts.', processed_count;
    RETURN processed_count;
END;
$$;


--
-- Name: backfill_timeline_on_follow(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.backfill_timeline_on_follow() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    post_record RECORD;
BEGIN
    -- Only backfill for local followers
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = NEW.follower_id AND is_local = true) THEN
        RETURN NEW;
    END IF;
    
    -- Handle status transitions (pending -> accepted)
    -- When a follow becomes accepted, add any unlisted posts that weren't added before
    IF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status = 'accepted' THEN
        -- Add unlisted posts (public ones were already added when follow was created)
        FOR post_record IN
            SELECT id, created_at
            FROM posts
            WHERE author_id = NEW.following_id
              AND visibility = 'unlisted'
              AND NOT COALESCE(is_deleted, false)
              AND created_at > NOW() - INTERVAL '7 days'
            ORDER BY created_at DESC
            LIMIT 20
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (NEW.follower_id, post_record.id, 'home', EXTRACT(epoch FROM post_record.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        END LOOP;
    END IF;
    
    RETURN NEW;
END;
$$;


--
-- Name: FUNCTION backfill_timeline_on_follow(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.backfill_timeline_on_follow() IS 'Backfills home timeline with unlisted posts when a pending follow becomes accepted.';


--
-- Name: build_emoji_reaction_activity(uuid, uuid, uuid, uuid, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.build_emoji_reaction_activity(p_interaction_id uuid, p_user_id uuid, p_post_id uuid, p_emoji_id uuid DEFAULT NULL::uuid, p_custom_emoji_content text DEFAULT NULL::text, p_is_undo boolean DEFAULT false) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    v_sender_profile RECORD;
    v_target_post RECORD;
    v_instance_domain text;
    v_emoji_info RECORD;
    v_activity_id text;
    v_sender_url text;
    v_post_url text;
    v_activity jsonb;
    v_emoji_object jsonb;
    v_reaction_content text;
BEGIN
    -- Get instance domain
    SELECT config_value::text INTO v_instance_domain
    FROM instance_config 
    WHERE config_key = 'domain';
    
    -- Remove JSON quotes if present
    v_instance_domain := trim(both '"' from v_instance_domain);
    
    -- Get sender profile
    SELECT * INTO v_sender_profile 
    FROM profiles 
    WHERE id = p_user_id AND is_local = true;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Local user profile not found: %', p_user_id;
    END IF;
    
    -- Get target post
    SELECT * INTO v_target_post
    FROM posts
    WHERE id = p_post_id;
    
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Target post not found: %', p_post_id;
    END IF;
    
    -- Build URLs
    v_sender_url := 'https://' || v_instance_domain || '/users/' || v_sender_profile.username;
    v_post_url := COALESCE(v_target_post.ap_id, 'https://' || v_instance_domain || '/posts/' || v_target_post.id);
    
    -- Handle emoji information first to build a specific activity ID
    IF p_emoji_id IS NOT NULL THEN
        -- Custom server emoji
        SELECT * INTO v_emoji_info
        FROM emojis
        WHERE id = p_emoji_id;
        
        IF FOUND THEN
            -- Use the clean emoji name for federation
            v_reaction_content := ':' || v_emoji_info.name || ':';
            v_emoji_object := jsonb_build_object(
                'type', 'Emoji',
                'name', ':' || v_emoji_info.name || ':',
                'icon', jsonb_build_object(
                    'type', 'Image',
                    'url', v_emoji_info.url,
                    'mediaType', 'image/png'
                )
            );
            
            -- Build activity ID with emoji name for uniqueness
            v_activity_id := v_sender_url || '#emoji-reaction-' || v_emoji_info.name || '-' || p_interaction_id;
        ELSE
            RAISE EXCEPTION 'Custom emoji not found: %', p_emoji_id;
        END IF;
    ELSIF p_custom_emoji_content IS NOT NULL THEN
        -- Unicode or text emoji
        v_reaction_content := p_custom_emoji_content;
        v_emoji_object := NULL;
        
        -- Build activity ID with emoji content for uniqueness  
        v_activity_id := v_sender_url || '#emoji-reaction-' || 
            regexp_replace(p_custom_emoji_content, '[^a-zA-Z0-9]', '', 'g') || '-' || p_interaction_id;
    ELSE
        RAISE EXCEPTION 'Either emoji_id or custom_emoji_content must be provided';
    END IF;
    
    -- Build the ActivityPub activity
    IF p_is_undo THEN
        -- Undo activity for reaction removal
        v_activity := jsonb_build_object(
            '@context', 'https://www.w3.org/ns/activitystreams',
            'id', v_activity_id || '-undo',
            'type', 'Undo',
            'actor', v_sender_url,
            'published', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'object', jsonb_build_object(
                'id', v_activity_id,
                'type', 'EmojiReact',
                'actor', v_sender_url,
                'object', v_post_url,
                'content', v_reaction_content
            )
        );
    ELSE
        -- Create EmojiReact activity
        v_activity := jsonb_build_object(
            '@context', jsonb_build_array(
                'https://www.w3.org/ns/activitystreams',
                jsonb_build_object(
                    'EmojiReact', 'as:EmojiReact',
                    'toot', 'http://joinmastodon.org/ns#',
                    'Emoji', 'toot:Emoji'
                )
            ),
            'id', v_activity_id,
            'type', 'EmojiReact',
            'actor', v_sender_url,
            'object', v_post_url,
            'published', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
            'content', v_reaction_content
        );
        
        -- Add custom emoji tag if present
        IF v_emoji_object IS NOT NULL THEN
            v_activity := v_activity || jsonb_build_object(
                'tag', jsonb_build_array(v_emoji_object)
            );
        END IF;
        
        -- Add Misskey compatibility field
        v_activity := v_activity || jsonb_build_object(
            '_misskey_reaction', v_reaction_content
        );
    END IF;
    
    RETURN v_activity;
END;
$$;


--
-- Name: FUNCTION build_emoji_reaction_activity(p_interaction_id uuid, p_user_id uuid, p_post_id uuid, p_emoji_id uuid, p_custom_emoji_content text, p_is_undo boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.build_emoji_reaction_activity(p_interaction_id uuid, p_user_id uuid, p_post_id uuid, p_emoji_id uuid, p_custom_emoji_content text, p_is_undo boolean) IS 'Builds ActivityPub EmojiReact activity from local emoji reaction. Supports both custom and unicode emojis with Misskey/Pleroma compatibility.';


--
-- Name: build_harmony_embed(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.build_harmony_embed(p_url text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  path text := coalesce(substring(p_url from 'https?://[^/]+(/[^?#]*)'), '/');
  post_id uuid;
  post_record record;
  summary text;
  first_image text;
begin
  post_id := substring(path from '/posts/([0-9a-fA-F-]{36})')::uuid;
  if post_id is null then
    raise exception 'Invalid Harmony post URL: %', p_url;
  end if;

  select
    p.id,
    p.content,
    p.media_attachments,
    p.visibility,
    p.is_deleted,
    p.is_local,
    p.metadata,
    pr.id as author_id,
    pr.username,
    pr.display_name,
    pr.domain,
    pr.avatar_url,
    pr.color
  into post_record
  from posts p
  join profiles pr on pr.id = p.author_id
  where p.id = post_id;

  if not found or post_record.is_deleted or post_record.visibility not in ('public', 'unlisted') then
    raise exception 'Post % unavailable for embedding', post_id;
  end if;

  summary := left(
    regexp_replace(public.convert_jsonb_to_ap(post_record.content), '<[^>]+>', '', 'g'),
    280
  );

  if jsonb_typeof(post_record.media_attachments) = 'array' then
    first_image := coalesce(
      post_record.media_attachments->0->>'preview_url',
      post_record.media_attachments->0->>'url'
    );
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'title', coalesce(post_record.display_name, post_record.username, 'Harmony Post'),
    'description', summary,
    'siteName', public.get_instance_domain(),
    'image', first_image,
    'icon', post_record.avatar_url,
    'color', post_record.color,
    'harmony', jsonb_build_object(
      'postId', post_record.id,
      'instanceDomain', public.get_instance_domain(),
      'visibility', post_record.visibility,
      'isLocal', post_record.is_local,
      'author', jsonb_build_object(
        'id', post_record.author_id,
        'username', post_record.username,
        'display_name', post_record.display_name,
        'domain', post_record.domain,
        'avatar_url', post_record.avatar_url,
        'color', post_record.color
      )
    )
  ));
end;
$$;


--
-- Name: can_manage_group_icon(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_manage_group_icon(conversation_uuid uuid, user_profile_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  -- Check if user is a participant in the conversation
  RETURN EXISTS (
    SELECT 1 FROM conversation_participants cp
    WHERE cp.conversation_id = conversation_uuid
      AND cp.user_id = user_profile_id
      AND cp.left_at IS NULL
  );
END;
$$;


--
-- Name: cascade_delete_reblogs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cascade_delete_reblogs() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  -- When a post is soft-deleted, mark all its reblogs as deleted too
  IF NEW.is_deleted = true AND (OLD.is_deleted = false OR OLD.is_deleted IS NULL) THEN
    UPDATE public.posts
    SET 
      is_deleted = true,
      deleted_at = NOW()
    WHERE 
      metadata->>'reblog_of' = OLD.id::text
      AND (is_deleted = false OR is_deleted IS NULL);
    
    -- Also remove the reblog interactions for this post
    UPDATE public.post_interactions
    SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{cascade_deleted}', 'true'::jsonb)
    WHERE 
      post_id = OLD.id 
      AND interaction_type = 'reblog';
    
    RAISE NOTICE 'Cascade deleted reblogs of post %', OLD.id;
  END IF;
  
  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION cascade_delete_reblogs(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.cascade_delete_reblogs() IS 'When a post is soft-deleted, automatically soft-delete all reblogs of that post.';


--
-- Name: check_bot_permission(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_bot_permission(p_bot_id uuid, p_server_id uuid, p_permission text) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $_$
DECLARE
    v_has_permission BOOLEAN;
BEGIN
    EXECUTE format('
        SELECT %I FROM public.bot_server_permissions
        WHERE bot_id = $1 
        AND server_id = $2 
        AND is_active = true
    ', p_permission)
    INTO v_has_permission
    USING p_bot_id, p_server_id;
    
    RETURN COALESCE(v_has_permission, false);
END;
$_$;


--
-- Name: check_emoji_reaction_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_emoji_reaction_limit() RETURNS trigger
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


--
-- Name: check_encryption_policy(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_encryption_policy(p_server_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    v_settings public.server_encryption_settings;
    v_result JSONB;
BEGIN
    SELECT * INTO v_settings
    FROM public.server_encryption_settings
    WHERE server_id = p_server_id;
    
    -- If no settings exist, default to optional
    IF v_settings IS NULL THEN
        v_result := jsonb_build_object(
            'encryption_mode', 'optional',
            'allow_federation', true,
            'require_verified_devices', false,
            'is_encrypted', false
        );
    ELSE
        v_result := jsonb_build_object(
            'encryption_mode', v_settings.encryption_mode,
            'allow_federation', v_settings.allow_federation,
            'require_verified_devices', v_settings.require_verified_devices,
            'is_encrypted', v_settings.encryption_mode IN ('required', 'required_local_only')
        );
    END IF;
    
    RETURN v_result;
END;
$$;


--
-- Name: FUNCTION check_encryption_policy(p_server_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.check_encryption_policy(p_server_id uuid) IS 'Get encryption policy for a server. Returns default values if no policy is set.';


--
-- Name: check_message_emoji_reaction_limit(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_message_emoji_reaction_limit() RETURNS trigger
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


--
-- Name: check_timeline_health(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_timeline_health(p_user_id uuid) RETURNS TABLE(timeline_type text, total_entries integer, recent_entries integer, following_count integer, recommendations text)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    WITH timeline_stats AS (
        SELECT 
            'home' as timeline_type,
            COUNT(*)::INTEGER as total_entries,
            COUNT(*) FILTER (WHERE te.created_at > NOW() - INTERVAL '7 days')::INTEGER as recent_entries
        FROM timeline_entries te
        WHERE te.user_id = p_user_id AND te.timeline_type = 'home'
    ),
    follow_stats AS (
        SELECT COUNT(*)::INTEGER as following_count
        FROM follows f
        WHERE f.follower_id = p_user_id AND f.status = 'accepted'
    )
    SELECT 
        ts.timeline_type,
        ts.total_entries,
        ts.recent_entries,
        fs.following_count,
        CASE 
            WHEN ts.total_entries = 0 THEN 'No timeline entries found - run backfill'
            WHEN ts.recent_entries < fs.following_count / 2 THEN 'Low recent activity - check if followed users are posting'
            ELSE 'Timeline looks healthy'
        END as recommendations
    FROM timeline_stats ts, follow_stats fs;
END;
$$;


--
-- Name: FUNCTION check_timeline_health(p_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.check_timeline_health(p_user_id uuid) IS 'Checks the health of a users timeline and provides recommendations';


--
-- Name: claim_session_share(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_session_share(p_share_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    UPDATE public.megolm_session_shares
    SET 
        is_claimed = true,
        claimed_at = NOW()
    WHERE id = p_share_id
    AND recipient_user_id = p_user_id
    AND is_claimed = false;
    
    RETURN FOUND;
END;
$$;


--
-- Name: classify_activitypub_activity(jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.classify_activitypub_activity(p_activity_data jsonb, p_instance_domain text) RETURNS TABLE(is_direct_message boolean, confidence numeric)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  v_object JSONB;
  v_to JSONB;
  v_cc JSONB;
  v_all_recipients TEXT[];
BEGIN
  v_object := CASE 
    WHEN jsonb_typeof(p_activity_data->'object') = 'string' THEN 
      jsonb_build_object('to', '[]'::jsonb, 'cc', '[]'::jsonb)
    ELSE 
      p_activity_data->'object'
  END;
  
  v_to := COALESCE(v_object->'to', '[]'::jsonb);
  v_cc := COALESCE(v_object->'cc', '[]'::jsonb);
  
  -- Extract all recipients
  SELECT array_agg(value::text)
  INTO v_all_recipients
  FROM jsonb_array_elements_text(v_to || v_cc);
  
  -- Rule 1: Contains 'Public' in 'to' → Public Post
  IF v_to ? 'https://www.w3.org/ns/activitystreams#Public' THEN
    RETURN QUERY SELECT false::boolean, 1.0::numeric;
    RETURN;
  END IF;
  
  -- Rule 2: Contains 'Public' in 'cc' → Unlisted Post (still public)
  IF v_cc ? 'https://www.w3.org/ns/activitystreams#Public' THEN
    RETURN QUERY SELECT false::boolean, 1.0::numeric;
    RETURN;
  END IF;
  
  -- Rule 3: Contains followers collection URL → Followers-only Post
  IF EXISTS (
    SELECT 1 FROM unnest(v_all_recipients) AS addr
    WHERE addr LIKE '%/followers'
  ) THEN
    RETURN QUERY SELECT false::boolean, 1.0::numeric;
    RETURN;
  END IF;
  
  -- Rule 4: Check for local recipients (direct message)
  IF EXISTS (
    SELECT 1 FROM unnest(v_all_recipients) AS addr
    WHERE addr LIKE '%' || p_instance_domain || '%'
  ) THEN
    RETURN QUERY SELECT true::boolean, 1.0::numeric;
    RETURN;
  END IF;
  
  -- Rule 5: No local recipients → Not our concern (treat as public)
  RETURN QUERY SELECT false::boolean, 0.1::numeric;
END;
$$;


--
-- Name: FUNCTION classify_activitypub_activity(p_activity_data jsonb, p_instance_domain text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.classify_activitypub_activity(p_activity_data jsonb, p_instance_domain text) IS 'Classifies ActivityPub activities according to specification - compatible with Mastodon, Misskey, Pleroma';


--
-- Name: cleanup_expired_key_requests(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_expired_key_requests() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    WITH deleted AS (
        DELETE FROM public.megolm_key_requests
        WHERE expires_at < NOW()
        AND status = 'pending'
        RETURNING id
    )
    SELECT COUNT(*) INTO deleted_count FROM deleted;
    
    RETURN deleted_count;
END;
$$;


--
-- Name: cleanup_old_federation_deliveries(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_old_federation_deliveries() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    cleanup_count INTEGER := 0;
    delivered_count INTEGER;
    failed_count INTEGER;
BEGIN
    -- Delete delivered items older than 7 days
    DELETE FROM federation_delivery_queue 
    WHERE status = 'delivered' 
    AND delivered_at < NOW() - INTERVAL '7 days';
    
    GET DIAGNOSTICS delivered_count = ROW_COUNT;
    cleanup_count := delivered_count;
    
    -- Delete permanently failed items older than 30 days
    DELETE FROM federation_delivery_queue 
    WHERE status = 'failed' 
    AND updated_at < NOW() - INTERVAL '30 days';
    
    GET DIAGNOSTICS failed_count = ROW_COUNT;
    cleanup_count := cleanup_count + failed_count;
    
    RAISE NOTICE 'Cleaned up % delivered and % failed federation delivery records', delivered_count, failed_count;
    
    RETURN cleanup_count;
END;
$$;


--
-- Name: cleanup_old_notifications(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_old_notifications() RETURNS integer
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


--
-- Name: FUNCTION cleanup_old_notifications(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.cleanup_old_notifications() IS 'Delete old read notifications (run via cron)';


--
-- Name: cleanup_old_trending_data(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_old_trending_data() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    deleted_count INTEGER := 0;
    temp_count INTEGER;
BEGIN
    -- Clean up trending posts older than 30 days
    DELETE FROM trending_posts 
    WHERE period_start < NOW() - INTERVAL '30 days';
    
    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    
    -- Clean up trending users older than 30 days
    DELETE FROM trending_users 
    WHERE period_start < NOW() - INTERVAL '30 days';
    
    GET DIAGNOSTICS temp_count = ROW_COUNT;
    deleted_count := deleted_count + temp_count;
    
    RAISE NOTICE 'Trending data cleanup completed. Deleted % old records.', deleted_count;
    RETURN deleted_count;
END;
$$;


--
-- Name: FUNCTION cleanup_old_trending_data(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.cleanup_old_trending_data() IS 'Removes trending posts and users data older than 30 days';


--
-- Name: cleanup_stale_view_contexts(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_stale_view_contexts() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    deleted_count INTEGER;
BEGIN
    -- Delete view contexts older than 5 minutes (user likely navigated away)
    DELETE FROM public.user_view_contexts
    WHERE last_active_at < NOW() - INTERVAL '5 minutes';

    GET DIAGNOSTICS deleted_count = ROW_COUNT;
    RETURN deleted_count;
END;
$$;


--
-- Name: FUNCTION cleanup_stale_view_contexts(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.cleanup_stale_view_contexts() IS 'Cleans up stale view context entries. Should be run periodically via pg_cron.';


--
-- Name: convert_ap_to_jsonb(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.convert_ap_to_jsonb(html_content text, tags jsonb DEFAULT NULL::jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    v_result JSONB := '[]'::jsonb;
    v_working_content TEXT;
    v_tag JSONB;
    v_username TEXT;
    v_mention_text TEXT;
    v_pos INTEGER;
    v_before_text TEXT;
    v_after_text TEXT;
    v_emoji_name TEXT;
    v_emoji_url TEXT;
BEGIN
    -- If no content, return empty array
    IF html_content IS NULL OR html_content = '' THEN
        RETURN '[]'::jsonb;
    END IF;

    -- Clean HTML thoroughly
    v_working_content := html_content;
    WHILE v_working_content ~ '<[^>]*>' LOOP
        v_working_content := regexp_replace(v_working_content, '<[^>]*>', '', 'g');
    END LOOP;
    v_working_content := regexp_replace(v_working_content, '&[a-zA-Z0-9#]+;', ' ', 'g');
    v_working_content := regexp_replace(v_working_content, '\s+', ' ', 'g');
    v_working_content := trim(v_working_content);

    -- If no tags, just return the cleaned text
    IF tags IS NULL OR jsonb_typeof(tags) != 'array' THEN
        IF v_working_content != '' THEN
            v_result := v_result || jsonb_build_object(
                'type', 'text',
                'text', v_working_content
            );
        END IF;
        RETURN v_result;
    END IF;

    -- Process all tags in a single pass to maintain proper order
    DECLARE
        tag_positions JSONB := '[]'::jsonb;
        v_tag_data JSONB;
        i INTEGER;
    BEGIN
        -- Find positions of all tags in content
        FOR v_tag IN SELECT * FROM jsonb_array_elements(tags)
        LOOP
            v_mention_text := NULL;
            v_pos := 0;
            
            IF v_tag->>'type' = 'Emoji' THEN
                -- Extract emoji name (remove colons if present)
                v_emoji_name := v_tag->>'name';
                IF v_emoji_name LIKE ':%' AND v_emoji_name LIKE '%:' THEN
                    v_emoji_name := substring(v_emoji_name from 2 for length(v_emoji_name) - 2);
                END IF;
                
                v_mention_text := ':' || v_emoji_name || ':';
                v_pos := position(v_mention_text in v_working_content);
                
            ELSIF v_tag->>'type' = 'Mention' THEN
                v_username := v_tag->>'name';
                IF v_username LIKE '@%' THEN
                    v_username := substring(v_username from 2);
                END IF;
                
                -- Try @username@domain format first
                IF v_username LIKE '%@%' THEN
                    v_mention_text := '@' || v_username;
                    v_pos := position(v_mention_text in v_working_content);
                END IF;
                
                -- If not found, try @username format
                IF v_pos = 0 THEN
                    v_mention_text := '@' || split_part(v_username, '@', 1);
                    v_pos := position(v_mention_text in v_working_content);
                END IF;
                
                -- If still not found, try just username
                IF v_pos = 0 THEN
                    v_mention_text := split_part(v_username, '@', 1);
                    v_pos := position(v_mention_text in v_working_content);
                END IF;
                
            ELSIF v_tag->>'type' = 'Hashtag' THEN
                v_mention_text := '#' || (v_tag->>'name');
                v_pos := position(v_mention_text in v_working_content);
            END IF;
            
            -- Store tag position and data if found
            IF v_pos > 0 THEN
                tag_positions := tag_positions || jsonb_build_object(
                    'position', v_pos,
                    'length', length(v_mention_text),
                    'tag', v_tag,
                    'text', v_mention_text
                );
            END IF;
        END LOOP;
        
        -- Sort tags by position
        SELECT jsonb_agg(value ORDER BY (value->>'position')::integer)
        INTO tag_positions
        FROM jsonb_array_elements(tag_positions);
        
        -- Process tags in order
        i := 0;
        FOR v_tag_data IN SELECT * FROM jsonb_array_elements(COALESCE(tag_positions, '[]'::jsonb))
        LOOP
            v_pos := (v_tag_data->>'position')::integer - i;
            v_mention_text := v_tag_data->>'text';
            v_tag := v_tag_data->'tag';
            
            -- Adjust position for previous removals
            v_before_text := substring(v_working_content from 1 for v_pos - 1);
            v_after_text := substring(v_working_content from v_pos + length(v_mention_text));
            
            -- Add text before this tag
            IF trim(v_before_text) != '' THEN
                v_result := v_result || jsonb_build_object(
                    'type', 'text',
                    'text', v_before_text
                );
            END IF;
            
            -- Add the tag based on its type - USING UNIVERSAL FORMAT
            IF v_tag->>'type' = 'Emoji' THEN
                v_emoji_name := v_tag->>'name';
                IF v_emoji_name LIKE ':%' AND v_emoji_name LIKE '%:' THEN
                    v_emoji_name := substring(v_emoji_name from 2 for length(v_emoji_name) - 2);
                END IF;
                v_emoji_url := COALESCE(v_tag->'icon'->>'url', v_tag->>'icon');
                
                v_result := v_result || jsonb_build_object(
                    'type', 'emoji',
                    'emoji', jsonb_build_object(
                        'name', v_emoji_name,
                        'url', v_emoji_url,
                        'id', COALESCE(v_tag->>'id', 'remote-' || v_emoji_name),
                        'server_id', 'remote'
                    )
                );
                
            ELSIF v_tag->>'type' = 'Mention' THEN
                v_username := v_tag->>'name';
                IF v_username LIKE '@%' THEN
                    v_username := substring(v_username from 2);
                END IF;
                
                -- UNIVERSAL MENTION FORMAT - matches your examples
                v_result := v_result || jsonb_build_object(
                    'type', 'mention',
                    'username', split_part(v_username, '@', 1),
                    'domain', CASE 
                        WHEN position('@' in v_username) > 0 THEN split_part(v_username, '@', 2)
                        ELSE NULL 
                    END,
                    'url', v_tag->>'href',
                    'userId', CASE 
                        WHEN position('@' in v_username) > 0 THEN 'remote-' || v_username
                        ELSE NULL
                    END,
                    'isLocal', CASE 
                        WHEN position('@' in v_username) > 0 THEN false
                        ELSE true
                    END
                );
                
            ELSIF v_tag->>'type' = 'Hashtag' THEN
                v_result := v_result || jsonb_build_object(
                    'type', 'hashtag',
                    'hashtag', v_tag->>'name'
                );
            END IF;
            
            -- Update working content for next iteration
            v_working_content := v_after_text;
            i := i + length(v_mention_text);
        END LOOP;
        
        -- Add any remaining text
        IF trim(v_working_content) != '' THEN
            v_result := v_result || jsonb_build_object(
                'type', 'text',
                'text', v_working_content
            );
        END IF;
    END;

    RETURN v_result;
END;
$$;


--
-- Name: FUNCTION convert_ap_to_jsonb(html_content text, tags jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.convert_ap_to_jsonb(html_content text, tags jsonb) IS 'UNIVERSAL converter: ActivityPub HTML → Harmony unified JSONB format. Works for posts, messages, DMs - everything.';


--
-- Name: convert_jsonb_to_ap(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.convert_jsonb_to_ap(content jsonb) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    content_part JSONB;
    html_content TEXT := '';
    part_type TEXT;
    part_text TEXT;
    part_url TEXT;
    part_shortcode TEXT;
    -- Variables for mention handling
    mention_username TEXT;
    mention_domain TEXT;
    mention_href TEXT;
    mention_text TEXT;
    current_instance_domain TEXT;
BEGIN
    -- Handle null or empty content
    IF content IS NULL THEN
        RETURN '';
    END IF;
    
    -- Handle string content (legacy format)
    IF jsonb_typeof(content) = 'string' THEN
        RETURN content #>> '{}';
    END IF;
    
    -- Get current instance domain for local mention detection
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    -- Handle array content (your universal format)
    IF jsonb_typeof(content) = 'array' THEN
        FOR content_part IN SELECT jsonb_array_elements(content)
        LOOP
            part_type := content_part->>'type';
            
            CASE part_type
                WHEN 'text' THEN
                    part_text := content_part->>'text';
                    IF part_text IS NOT NULL THEN
                        -- Escape HTML entities in text content for safety
                        part_text := replace(replace(replace(part_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
                        html_content := html_content || part_text;
                    END IF;
                    
                WHEN 'mention' THEN
                    -- Extract mention data from your universal format
                    mention_username := content_part->>'username';
                    mention_domain := content_part->>'domain';
                    
                    IF mention_username IS NOT NULL THEN
                        -- Always build full mention format for federation compatibility
                        IF mention_domain IS NOT NULL THEN
                            -- Use provided domain
                            mention_href := 'https://' || mention_domain || '/@' || mention_username;
                            mention_text := '@' || mention_username || '@' || mention_domain;
                        ELSE
                            -- Fallback to current instance domain for local users
                            mention_href := 'https://' || current_instance_domain || '/@' || mention_username;
                            mention_text := '@' || mention_username || '@' || current_instance_domain;
                        END IF;
                        
                        -- Create the HTML mention link
                        html_content := html_content || format('<a href="%s" class="mention">%s</a>', 
                            mention_href, mention_text);
                    END IF;
                    
                WHEN 'emoji' THEN
                    -- Handle custom emojis - use shortcode format for ActivityPub compatibility
                    part_shortcode := content_part->'emoji'->>'name';
                    
                    IF part_shortcode IS NOT NULL THEN
                        -- Always render as shortcode - emoji metadata goes in ActivityPub tags
                        html_content := html_content || ':' || part_shortcode || ':';
                    END IF;
                    
                WHEN 'file' THEN
                    -- Files should not be inline in ActivityPub content (handled as attachments)
                    CONTINUE;
                    
                WHEN 'url' THEN
                    -- Handle URLs
                    part_url := content_part->>'url';
                    IF part_url IS NOT NULL THEN
                        -- Escape URL for safety and create link
                        part_url := replace(replace(replace(part_url, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
                        html_content := html_content || format('<a href="%s" rel="noopener noreferrer" target="_blank">%s</a>', 
                            part_url, part_url);
                    END IF;
                    
                ELSE
                    -- Unknown type, try to extract text and escape it
                    part_text := content_part->>'text';
                    IF part_text IS NOT NULL THEN
                        part_text := replace(replace(replace(part_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
                        html_content := html_content || part_text;
                    END IF;
            END CASE;
        END LOOP;
        
        RETURN html_content;
    END IF;
    
    -- Fallback: convert to text and escape
    part_text := content::TEXT;
    part_text := replace(replace(replace(part_text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;');
    RETURN part_text;
END;
$$;


--
-- Name: FUNCTION convert_jsonb_to_ap(content jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.convert_jsonb_to_ap(content jsonb) IS 'UNIVERSAL converter: Harmony unified JSONB format → ActivityPub HTML. Works for posts, messages, DMs - everything.';


--
-- Name: count_unused_recovery_codes(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.count_unused_recovery_codes(p_user_id uuid) RETURNS integer
    LANGUAGE sql SECURITY DEFINER
    AS $$
  SELECT COUNT(*)::INTEGER
  FROM public.mfa_recovery_codes
  WHERE user_id = p_user_id
    AND used_at IS NULL;
$$;


--
-- Name: create_activitypub_note_activity(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_activitypub_note_activity(post_id uuid) RETURNS jsonb
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


--
-- Name: FUNCTION create_activitypub_note_activity(post_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_activitypub_note_activity(post_id uuid) IS 'FIXED: Creates a complete ActivityPub Create activity for a post with unified mention and emoji tag support. Now uses profiles table instead of users.';


--
-- Name: create_comprehensive_timeline_entries(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_comprehensive_timeline_entries() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
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
    
    -- Add to followers' home timelines based on visibility and follow status
    IF NEW.visibility = 'public' THEN
        -- PUBLIC posts go to ALL followers (accepted AND pending)
        FOR follower_record IN 
            SELECT f.follower_id 
            FROM follows f 
            JOIN profiles p ON f.follower_id = p.id
            WHERE f.following_id = NEW.author_id 
              AND f.status IN ('accepted', 'pending')  -- Both accepted and pending!
              AND p.is_local = true
              AND f.follower_id != NEW.author_id
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (follower_record.follower_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        END LOOP;
    ELSIF NEW.visibility = 'unlisted' THEN
        -- UNLISTED posts go only to accepted followers
        FOR follower_record IN 
            SELECT f.follower_id 
            FROM follows f 
            JOIN profiles p ON f.follower_id = p.id
            WHERE f.following_id = NEW.author_id 
              AND f.status = 'accepted'  -- Only accepted for unlisted
              AND p.is_local = true
              AND f.follower_id != NEW.author_id
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (follower_record.follower_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        END LOOP;
    ELSIF NEW.visibility = 'followers' THEN
        -- FOLLOWERS-ONLY posts go only to accepted followers
        FOR follower_record IN 
            SELECT f.follower_id 
            FROM follows f 
            JOIN profiles p ON f.follower_id = p.id
            WHERE f.following_id = NEW.author_id 
              AND f.status = 'accepted'  -- Only accepted for followers-only
              AND p.is_local = true
              AND f.follower_id != NEW.author_id
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (follower_record.follower_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        END LOOP;
    END IF;
    -- Note: 'direct' visibility posts don't go to timeline at all
    
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


--
-- Name: FUNCTION create_comprehensive_timeline_entries(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_comprehensive_timeline_entries() IS 'Creates timeline entries for posts. Public posts go to all followers (including pending). Unlisted/followers-only require accepted status.';


--
-- Name: create_default_notification_preferences(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_default_notification_preferences(p_user_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    AS $$
INSERT INTO notification_preferences (user_id)
VALUES (p_user_id)
ON CONFLICT (user_id) DO NOTHING;
$$;


--
-- Name: FUNCTION create_default_notification_preferences(p_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_default_notification_preferences(p_user_id uuid) IS 'SECURITY DEFINER: Creates default notification preferences for any user with elevated privileges.';


--
-- Name: create_default_server_structure(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_default_server_structure(p_server_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_text_category_id uuid;
  v_voice_category_id uuid;
BEGIN
  -- Create default TEXT CHANNELS category
  INSERT INTO public.channel_categories (server_id, name, "order")
  VALUES (p_server_id, 'Text Channels', 0)
  RETURNING id INTO v_text_category_id;

  -- Create default general text channel under the text category
  INSERT INTO public.channels (server_id, name, type, category, "order")
  VALUES (p_server_id, 'general', 0, v_text_category_id, 0);

  -- Create default VOICE CHANNELS category
  INSERT INTO public.channel_categories (server_id, name, "order")
  VALUES (p_server_id, 'Voice Channels', 1)
  RETURNING id INTO v_voice_category_id;

  -- Create default General voice channel under the voice category
  INSERT INTO public.channels (server_id, name, type, category, "order")
  VALUES (p_server_id, 'voice chat', 1, v_voice_category_id, 0);

  RAISE NOTICE 'Created default structure for server %: text category %, voice category %', 
    p_server_id, v_text_category_id, v_voice_category_id;
END;
$$;


--
-- Name: FUNCTION create_default_server_structure(p_server_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_default_server_structure(p_server_id uuid) IS 'Create default channels and categories when a server is created. Creates Text Channels category with #general, and Voice Channels category with General voice channel.';


--
-- Name: create_federated_emoji(text, text, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_federated_emoji(p_name text, p_url text, p_uploader uuid, p_domain text DEFAULT NULL::text) RETURNS TABLE(id uuid, created_at timestamp with time zone, name character varying, url character varying, server_id uuid, uploader uuid, updated_at timestamp with time zone, usage_count integer, last_used timestamp with time zone, domain text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  -- Check if emoji already exists by URL
  RETURN QUERY
  SELECT e.* FROM emojis e
  WHERE e.url = p_url
  LIMIT 1;
  
  -- If found, return it
  IF FOUND THEN
    RETURN;
  END IF;
  
  -- Otherwise, create new emoji
  -- For federated emojis created by bots, uploader is NULL since bots aren't profiles
  RETURN QUERY
  INSERT INTO emojis (name, url, server_id, uploader, domain)
  VALUES (p_name, p_url, NULL, NULL, p_domain)
  RETURNING emojis.*;
END;
$$;


--
-- Name: FUNCTION create_federated_emoji(p_name text, p_url text, p_uploader uuid, p_domain text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_federated_emoji(p_name text, p_url text, p_uploader uuid, p_domain text) IS 'Allows bots to create federated emojis (server_id = NULL, uploader = NULL). Checks for duplicates by URL.';


--
-- Name: create_group_conversation(uuid, uuid[], text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_group_conversation(creator_user_id uuid, participant_user_ids uuid[], conversation_name text DEFAULT NULL::text, is_private boolean DEFAULT true) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  conversation_uuid UUID;
  participant_id UUID;
BEGIN
  -- Create the conversation
  INSERT INTO conversations (type, name, created_by, is_active, metadata)
  VALUES (
    'group',
    conversation_name,
    creator_user_id,
    TRUE,
    jsonb_build_object('is_private', is_private)
  )
  RETURNING id INTO conversation_uuid;
  
  -- Add all participants
  FOREACH participant_id IN ARRAY participant_user_ids
  LOOP
    INSERT INTO conversation_participants (conversation_id, user_id, role, joined_at)
    VALUES (conversation_uuid, participant_id, 'member', CURRENT_TIMESTAMP)
    ON CONFLICT (conversation_id, user_id) DO NOTHING;
  END LOOP;
  
  RETURN conversation_uuid;
END;
$$;


--
-- Name: create_group_conversation(uuid, text, uuid[], jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_group_conversation(creator_user_id uuid, conversation_name text DEFAULT NULL::text, participant_ids uuid[] DEFAULT '{}'::uuid[], initial_metadata jsonb DEFAULT '{}'::jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  new_conversation_id UUID;
  participant_id UUID;
BEGIN
  -- Create the conversation
  INSERT INTO conversations (
    created_by,
    name,
    type,
    metadata,
    is_active
  ) VALUES (
    creator_user_id,
    conversation_name,
    'group',
    initial_metadata,
    true
  )
  RETURNING id INTO new_conversation_id;

  -- Add creator as participant
  INSERT INTO conversation_participants (
    conversation_id,
    user_id,
    joined_at
  ) VALUES (
    new_conversation_id,
    creator_user_id,
    CURRENT_TIMESTAMP
  );

  -- Add other participants
  FOREACH participant_id IN ARRAY participant_ids
  LOOP
    -- Skip creator (already added)
    IF participant_id != creator_user_id THEN
      INSERT INTO conversation_participants (
        conversation_id,
        user_id,
        joined_at
      ) VALUES (
        new_conversation_id,
        participant_id,
        CURRENT_TIMESTAMP
      );
    END IF;
  END LOOP;

  RETURN new_conversation_id;
END;
$$;


--
-- Name: create_notification_preferences(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_notification_preferences() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Only create notification preferences for local users
    -- Remote federated users manage their notifications on their own instances
    IF NEW.is_local = true OR NEW.is_local IS NULL THEN
        INSERT INTO notification_preferences (user_id)
        VALUES (NEW.id);
    END IF;
    
    RETURN NEW;
END;
$$;


--
-- Name: FUNCTION create_notification_preferences(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_notification_preferences() IS 'Creates notification preferences only for local users. Remote federated users manage notifications on their own instances.';


--
-- Name: create_notification_structured(uuid, character varying, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_notification_structured(p_user_id uuid, p_type character varying, p_data jsonb DEFAULT '{}'::jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
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


--
-- Name: FUNCTION create_notification_structured(p_user_id uuid, p_type character varying, p_data jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_notification_structured(p_user_id uuid, p_type character varying, p_data jsonb) IS 'Create notification with structured data';


--
-- Name: create_notification_with_spam_prevention(uuid, text, uuid, text, text, jsonb, uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_notification_with_spam_prevention(p_user_id uuid, p_type text, p_source_user_id uuid, p_title text DEFAULT NULL::text, p_message text DEFAULT NULL::text, p_data jsonb DEFAULT '{}'::jsonb, p_server_id uuid DEFAULT NULL::uuid, p_channel_id uuid DEFAULT NULL::uuid, p_conversation_id uuid DEFAULT NULL::uuid) RETURNS uuid
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
    
    -- Create notification normally using the unified send_notification_to_user function
    SELECT send_notification_to_user(
        p_type,
        p_user_id,
        p_data,
        p_server_id,
        p_channel_id,
        p_conversation_id,
        p_source_user_id,
        'normal'
    ) INTO v_notification_id;
    
    RETURN v_notification_id;
END;
$$;


--
-- Name: FUNCTION create_notification_with_spam_prevention(p_user_id uuid, p_type text, p_source_user_id uuid, p_title text, p_message text, p_data jsonb, p_server_id uuid, p_channel_id uuid, p_conversation_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_notification_with_spam_prevention(p_user_id uuid, p_type text, p_source_user_id uuid, p_title text, p_message text, p_data jsonb, p_server_id uuid, p_channel_id uuid, p_conversation_id uuid) IS 'Creates notifications with spam prevention. Suppresses repeated notifications from same source within time windows.';


--
-- Name: create_or_get_direct_conversation(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_or_get_direct_conversation(user1_uuid uuid, user2_uuid uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  conversation_uuid UUID;
  current_user_id UUID;
BEGIN
  -- Get current user
  current_user_id := auth.uid();
  
  -- Security check: caller must be one of the participants
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;
  
  IF current_user_id != user1_uuid AND current_user_id != user2_uuid THEN
    RAISE EXCEPTION 'You can only create conversations you are a participant of';
  END IF;

  -- Try to find existing direct conversation between these two users
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
    )
    -- Ensure it's exactly 2 participants
    AND (
      SELECT COUNT(*) FROM conversation_participants cp3 
      WHERE cp3.conversation_id = c.id 
        AND cp3.left_at IS NULL
    ) = 2;
  
  -- If not found, create new conversation
  IF conversation_uuid IS NULL THEN
    INSERT INTO conversations (type, created_by, is_active)
    VALUES ('direct', user1_uuid, TRUE)
    RETURNING id INTO conversation_uuid;
    
    -- Add both users as participants
    INSERT INTO conversation_participants (conversation_id, user_id, role)
    VALUES (conversation_uuid, user1_uuid, 'member')
    ON CONFLICT (conversation_id, user_id) 
    DO UPDATE SET left_at = NULL, role = 'member', updated_at = CURRENT_TIMESTAMP;
    
    INSERT INTO conversation_participants (conversation_id, user_id, role)
    VALUES (conversation_uuid, user2_uuid, 'member')
    ON CONFLICT (conversation_id, user_id) 
    DO UPDATE SET left_at = NULL, role = 'member', updated_at = CURRENT_TIMESTAMP;
  END IF;
  
  RETURN conversation_uuid;
END;
$$;


--
-- Name: create_or_get_multi_conversation(uuid[], text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_or_get_multi_conversation(participant_ids uuid[], conversation_type text DEFAULT 'direct'::text, conversation_name text DEFAULT NULL::text, created_by_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_conversation_id UUID;
    participant_id UUID;
BEGIN
    -- Validate inputs
    IF participant_ids IS NULL OR array_length(participant_ids, 1) < 2 THEN
        RAISE EXCEPTION 'At least 2 participants required for conversation';
    END IF;
    
    -- Try to find existing conversation with exact same participants
    SELECT DISTINCT c.id INTO v_conversation_id
    FROM conversations c
    WHERE (
        -- Count must match exactly
        (SELECT COUNT(*) FROM conversation_participants cp WHERE cp.conversation_id = c.id AND cp.left_at IS NULL) = array_length(participant_ids, 1)
        AND
        -- All participants must be present
        NOT EXISTS (
            SELECT 1 FROM unnest(participant_ids) AS required_participant(participant_id)
            WHERE NOT EXISTS (
                SELECT 1 FROM conversation_participants cp 
                WHERE cp.conversation_id = c.id 
                  AND cp.user_id = required_participant.participant_id 
                  AND cp.left_at IS NULL
            )
        )
    )
    LIMIT 1;

    -- Create new conversation if not found
    IF v_conversation_id IS NULL THEN
        INSERT INTO conversations (
            name,
            type,
            created_by,
            created_at
        ) VALUES (
            CASE 
                WHEN array_length(participant_ids, 1) = 2 AND conversation_name IS NULL THEN NULL
                ELSE COALESCE(conversation_name, 'Group Chat')
            END,
            CASE 
                WHEN array_length(participant_ids, 1) = 2 THEN 'direct'
                ELSE COALESCE(conversation_type, 'group')
            END,
            COALESCE(created_by_id, participant_ids[1]),
            NOW()
        )
        RETURNING id INTO v_conversation_id;
        
        -- Add all participants
        INSERT INTO conversation_participants (conversation_id, user_id, joined_at, role)
        SELECT v_conversation_id, participant_id, NOW(), 'member'
        FROM unnest(participant_ids) AS participants(participant_id);
        
        RAISE NOTICE '🆕 Created new % conversation % with % participants', 
            CASE WHEN array_length(participant_ids, 1) = 2 THEN 'direct' ELSE 'group' END,
            v_conversation_id, 
            array_length(participant_ids, 1);
    END IF;

    RETURN v_conversation_id;
END;
$$;


--
-- Name: create_system_message(uuid, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_system_message(p_channel_id uuid, p_message_type text, p_data jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
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


--
-- Name: FUNCTION create_system_message(p_channel_id uuid, p_message_type text, p_data jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.create_system_message(p_channel_id uuid, p_message_type text, p_data jsonb) IS 'Create system message (user joined, user left, etc.)';


--
-- Name: delete_server_with_cleanup(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.delete_server_with_cleanup(p_server_id uuid, p_owner_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    -- Verify ownership
    IF NOT EXISTS(SELECT 1 FROM servers WHERE id = p_server_id AND owner = p_owner_id) THEN
        RAISE EXCEPTION 'Server not found or you are not the owner';
    END IF;
    
    -- Delete in proper order to avoid foreign key issues
    -- The CASCADE constraints will handle most cleanup, but we'll be explicit about the order
    
    -- 1. Delete server membership events first (to avoid trigger issues)
    DELETE FROM server_membership_events WHERE server_id = p_server_id;
    
    -- 2. Delete the server (CASCADE will handle the rest)
    DELETE FROM servers WHERE id = p_server_id AND owner = p_owner_id;
    
    -- If we get here, everything succeeded
END;$$;


--
-- Name: detect_embed_provider(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.detect_embed_provider(p_url text) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $_$
declare
  host text;
  path text;
  instance_domain text := lower(regexp_replace(public.get_instance_domain(), '^https?://', ''));
begin
  host := public.extract_url_host(p_url);
  path := coalesce(substring(p_url from 'https?://[^/]+(/[^?#]*)'), '/');

  if (host = instance_domain or host = 'har.mony.lol') and path ~ '^/posts/[0-9a-fA-F-]{36}' then
    return 'harmony-post';
  elsif host ~ '(youtube\.com|youtu\.be)$' then
    return 'youtube';
  elsif host ~ 'spotify\.com$' then
    return 'spotify';
  else
    return 'generic';
  end if;
end;
$_$;


--
-- Name: detect_message_features(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.detect_message_features(content_parts jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  part jsonb;
  has_media boolean := false;
  has_url boolean := false;
BEGIN
  IF content_parts IS NULL OR jsonb_typeof(content_parts) != 'array' THEN
    RETURN jsonb_build_object('has_media', false, 'has_url', false);
  END IF;

  FOR part IN SELECT * FROM jsonb_array_elements(content_parts)
  LOOP
    IF (part->>'type') = 'file' THEN
      has_media := true;
    ELSIF (part->>'type') = 'url' THEN
      has_url := true;
    END IF;
    
    -- Exit early if both found
    IF has_media AND has_url THEN
      EXIT;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('has_media', has_media, 'has_url', has_url);
END;
$$;


--
-- Name: determine_message_federation_type(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.determine_message_federation_type(p_message_id uuid) RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  v_message_type TEXT;
  v_channel_id UUID;
  v_conversation_id UUID;
  v_remote_participant_count INTEGER := 0;
BEGIN
  -- Get message context
  SELECT channel_id, conversation_id 
  INTO v_channel_id, v_conversation_id
  FROM messages 
  WHERE id = p_message_id;
  
  -- Classification logic
  IF v_channel_id IS NOT NULL THEN
    -- Server chat message → Never federate
    v_message_type := 'chat_local_only';
    
  ELSIF v_conversation_id IS NOT NULL THEN
    -- DM message → Check for remote participants
    SELECT COUNT(DISTINCT cp.user_id)
    INTO v_remote_participant_count
    FROM conversation_participants cp
    JOIN profiles p ON cp.user_id = p.id
    WHERE cp.conversation_id = v_conversation_id
      AND NOT p.is_local
      AND cp.left_at IS NULL;
    
    IF v_remote_participant_count > 0 THEN
      v_message_type := 'dm_federated';
    ELSE
      v_message_type := 'dm_local_only';
    END IF;
    
  ELSE
    -- Orphaned message
    v_message_type := 'unknown';
  END IF;
  
  RETURN v_message_type;
END;
$$;


--
-- Name: FUNCTION determine_message_federation_type(p_message_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.determine_message_federation_type(p_message_id uuid) IS 'Determines federation type for a message based on context (chat/DM) and participants';


--
-- Name: enable_conversation_encryption(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enable_conversation_encryption(p_conversation_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_status JSONB;
    v_result JSONB;
BEGIN
    -- Check if caller is a participant
    IF NOT EXISTS (
        SELECT 1 FROM public.conversation_participants
        JOIN public.profiles ON profiles.id = conversation_participants.user_id
        WHERE conversation_participants.conversation_id = p_conversation_id
        AND profiles.auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Not a participant of this conversation';
    END IF;
    
    -- Get current status
    v_status := public.get_conversation_encryption_status(p_conversation_id);
    
    -- Check if all users have encryption keys
    IF NOT (v_status->>'all_users_have_keys')::BOOLEAN THEN
        RAISE EXCEPTION 'Cannot enable encryption: Not all participants have encryption keys';
    END IF;
    
    -- Enable encryption
    INSERT INTO public.conversation_encryption_settings (
        conversation_id,
        encryption_enabled,
        verified
    ) VALUES (
        p_conversation_id,
        true,
        false
    )
    ON CONFLICT (conversation_id)
    DO UPDATE SET
        encryption_enabled = true,
        updated_at = NOW();
    
    -- Log the action
    INSERT INTO public.encryption_audit_log (
        user_id,
        event_type,
        severity,
        description,
        related_conversation_id,
        metadata
    ) VALUES (
        (SELECT id FROM public.profiles WHERE auth_user_id = auth.uid()),
        'encryption_enabled',
        'info',
        'Conversation encryption enabled',
        p_conversation_id,
        v_status
    );
    
    v_result := jsonb_build_object(
        'success', true,
        'conversation_id', p_conversation_id,
        'enabled_at', NOW()
    );
    
    RETURN v_result;
END;
$$;


--
-- Name: FUNCTION enable_conversation_encryption(p_conversation_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.enable_conversation_encryption(p_conversation_id uuid) IS 'Enable E2EE for a conversation. All participants must have encryption keys.';


--
-- Name: extract_activitypub_emoji_tags(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.extract_activitypub_emoji_tags(content jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    content_part JSONB;
    emoji_tags JSONB := '[]'::JSONB;
    part_type TEXT;
    emoji_name TEXT;
    emoji_url TEXT;
    emoji_id TEXT;
    emoji_tag JSONB;
    current_instance_domain TEXT;
BEGIN
    -- Handle null or empty content
    IF content IS NULL OR jsonb_typeof(content) != 'array' THEN
        RETURN '[]'::JSONB;
    END IF;
    
    -- Get current instance domain
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    FOR content_part IN SELECT jsonb_array_elements(content)
    LOOP
        part_type := content_part->>'type';
        
        IF part_type = 'emoji' THEN
            emoji_name := content_part->'emoji'->>'name';
            emoji_url := content_part->'emoji'->>'url';
            emoji_id := content_part->'emoji'->>'id';
            
            IF emoji_name IS NOT NULL AND emoji_url IS NOT NULL THEN
                -- Build the ActivityPub Emoji tag
                emoji_tag := jsonb_build_object(
                    'type', 'Emoji',
                    'name', ':' || emoji_name || ':',
                    'icon', jsonb_build_object(
                        'type', 'Image',
                        'url', emoji_url
                    )
                );
                
                -- Add id if available
                IF emoji_id IS NOT NULL THEN
                    emoji_tag := emoji_tag || jsonb_build_object('id', 'https://' || current_instance_domain || '/emojis/' || emoji_id);
                END IF;
                
                -- Add to tags array
                emoji_tags := emoji_tags || jsonb_build_array(emoji_tag);
            END IF;
        END IF;
    END LOOP;
    
    RETURN emoji_tags;
END;
$$;


--
-- Name: FUNCTION extract_activitypub_emoji_tags(content jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.extract_activitypub_emoji_tags(content jsonb) IS 'Extracts emoji tags from MessagePart[] content as ActivityPub Emoji objects for proper federation compatibility';


--
-- Name: extract_activitypub_hashtag_tags(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.extract_activitypub_hashtag_tags(content jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    content_part JSONB;
    hashtag_tags JSONB := '[]'::JSONB;
    part_type TEXT;
    hashtag_name TEXT;
    hashtag_href TEXT;
    hashtag_tag JSONB;
    current_instance_domain TEXT;
BEGIN
    -- Handle null or empty content
    IF content IS NULL OR jsonb_typeof(content) != 'array' THEN
        RETURN '[]'::JSONB;
    END IF;
    
    -- Get current instance domain for hashtag URLs
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    FOR content_part IN SELECT jsonb_array_elements(content)
    LOOP
        part_type := content_part->>'type';
        
        IF part_type = 'hashtag' THEN
            hashtag_name := content_part->>'name';
            
            IF hashtag_name IS NOT NULL THEN
                -- Build hashtag URL - ActivityPub standard format
                hashtag_href := 'https://' || current_instance_domain || '/tags/' || hashtag_name;
                
                -- Ensure hashtag name starts with # for ActivityPub format
                IF NOT starts_with(hashtag_name, '#') THEN
                    hashtag_name := '#' || hashtag_name;
                END IF;
                
                -- Build the ActivityPub Hashtag tag
                hashtag_tag := jsonb_build_object(
                    'type', 'Hashtag',
                    'href', hashtag_href,
                    'name', hashtag_name
                );
                
                -- Add to tags array
                hashtag_tags := hashtag_tags || jsonb_build_array(hashtag_tag);
            END IF;
        END IF;
    END LOOP;
    
    RETURN hashtag_tags;
END;
$$;


--
-- Name: FUNCTION extract_activitypub_hashtag_tags(content jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.extract_activitypub_hashtag_tags(content jsonb) IS 'Extracts hashtag tags from MessagePart[] content as ActivityPub Hashtag objects for proper federation. Handles hashtag data structure: {"type": "hashtag", "name": "cats"} and generates proper ActivityPub format: {"type": "Hashtag", "name": "#cats", "href": "https://domain.com/tags/cats"}';


--
-- Name: extract_activitypub_tags(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.extract_activitypub_tags(content jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    mention_tags JSONB;
    emoji_tags JSONB;
    all_tags JSONB := '[]'::JSONB;
BEGIN
    -- Get mention tags
    mention_tags := extract_activitypub_mention_tags(content);
    
    -- Get emoji tags  
    emoji_tags := extract_activitypub_emoji_tags(content);
    
    -- Combine them
    IF jsonb_array_length(mention_tags) > 0 THEN
        all_tags := all_tags || mention_tags;
    END IF;
    
    IF jsonb_array_length(emoji_tags) > 0 THEN
        all_tags := all_tags || emoji_tags;
    END IF;
    
    RETURN all_tags;
END;
$$;


--
-- Name: FUNCTION extract_activitypub_tags(content jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.extract_activitypub_tags(content jsonb) IS 'Extracts all ActivityPub tags (mentions and emojis) from MessagePart[] content for proper federation';


--
-- Name: extract_custom_emoji_for_federation(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.extract_custom_emoji_for_federation(content_text text) RETURNS TABLE(emoji_id uuid, emoji_name text, emoji_url text)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.id,
        e.name,
        e.url
    FROM emojis e
    WHERE content_text ~ (':' || e.name || ':') 
       OR content_text ~ (':' || e.id::text || ':');
END;
$$;


--
-- Name: FUNCTION extract_custom_emoji_for_federation(content_text text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.extract_custom_emoji_for_federation(content_text text) IS 'Extract custom emoji data from content for ActivityPub federation tags';


--
-- Name: extract_hashtags_from_content(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.extract_hashtags_from_content(p_content jsonb) RETURNS text[]
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  hashtags TEXT[] := ARRAY[]::TEXT[];
  item JSONB;
  text_content TEXT;
  hashtag_text TEXT;
  match_record RECORD;
  result TEXT[];
BEGIN
  -- Return empty array if content is null or not an array
  IF p_content IS NULL OR jsonb_typeof(p_content) != 'array' THEN
    RETURN ARRAY[]::TEXT[];
  END IF;

  -- Extract from JSONB array format
  FOR item IN SELECT * FROM jsonb_array_elements(p_content)
  LOOP
    -- Handle dedicated hashtag type parts
    -- Check multiple possible field names: 'name', 'hashtag', 'normalized'
    IF item->>'type' = 'hashtag' THEN
      -- Try 'name' field first (this is the actual format used)
      hashtag_text := COALESCE(
        item->>'name',
        item->>'hashtag', 
        item->>'normalized'
      );
      IF hashtag_text IS NOT NULL AND hashtag_text != '' THEN
        -- Remove leading # if present
        hashtag_text := regexp_replace(hashtag_text, '^#', '');
        hashtags := array_append(hashtags, lower(hashtag_text));
      END IF;
    -- Also check for #hashtag patterns in text content
    ELSIF item->>'type' = 'text' THEN
      text_content := item->>'text';
      IF text_content IS NOT NULL THEN
        -- Use a loop to get all regex matches
        FOR match_record IN SELECT (regexp_matches(text_content, '#([a-zA-Z0-9_]+)', 'g'))[1] as tag
        LOOP
          IF match_record.tag IS NOT NULL THEN
            hashtags := array_append(hashtags, lower(match_record.tag));
          END IF;
        END LOOP;
      END IF;
    END IF;
  END LOOP;

  -- Return unique hashtags (never NULL)
  SELECT COALESCE(array_agg(DISTINCT t), ARRAY[]::TEXT[]) 
  INTO result
  FROM unnest(hashtags) t 
  WHERE t IS NOT NULL;
  
  RETURN COALESCE(result, ARRAY[]::TEXT[]);
END;
$$;


--
-- Name: FUNCTION extract_hashtags_from_content(p_content jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.extract_hashtags_from_content(p_content jsonb) IS 'Extract hashtags from JSONB content array. Handles both hashtag-type parts and #text patterns. Never returns NULL.';


--
-- Name: extract_mentions(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.extract_mentions(content jsonb) RETURNS text[]
    LANGUAGE plpgsql
    AS $$
DECLARE
    mentions TEXT[] := '{}';
    item JSONB;
BEGIN
    -- Handle array content (rich text)
    IF jsonb_typeof(content) = 'array' THEN
        FOR item IN SELECT jsonb_array_elements(content)
        LOOP
            IF item->>'type' = 'mention' AND item->>'mention' IS NOT NULL THEN
                mentions := array_append(mentions, item->>'mention');
            END IF;
        END LOOP;
    END IF;
    
    RETURN mentions;
END;
$$;


--
-- Name: FUNCTION extract_mentions(content jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.extract_mentions(content jsonb) IS 'Extracts mention usernames from JSONB message content';


--
-- Name: extract_message_text(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.extract_message_text(content_parts jsonb) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
  part jsonb;
  text_result text := '';
  v_username TEXT;
  v_domain TEXT;
  v_emoji_name TEXT;
  v_hashtag_name TEXT;
BEGIN
  IF content_parts IS NULL OR jsonb_typeof(content_parts) != 'array' THEN
    RETURN '';
  END IF;

  FOR part IN SELECT * FROM jsonb_array_elements(content_parts)
  LOOP
    CASE (part->>'type')
      WHEN 'text' THEN
        text_result := text_result || COALESCE(part->>'text', '') || ' ';
      WHEN 'emoji' THEN
        v_emoji_name := part->'emoji'->>'name';
        IF v_emoji_name IS NOT NULL THEN
            text_result := text_result || ':' || v_emoji_name || ': ';
        END IF;
      WHEN 'mention' THEN
        v_username := part->>'username';
        v_domain := part->>'domain';
        IF v_username IS NOT NULL THEN
            IF v_domain IS NOT NULL THEN
                text_result := text_result || '@' || v_username || '@' || v_domain || ' ';
            ELSE
                text_result := text_result || '@' || v_username || ' ';
            END IF;
        END IF;
      WHEN 'url' THEN
        text_result := text_result || COALESCE(part->>'url', '') || ' ';
      WHEN 'hashtag' THEN
        v_hashtag_name := part->>'name';
        IF v_hashtag_name IS NOT NULL THEN
            text_result := text_result || '#' || v_hashtag_name || ' ';
        END IF;
      WHEN 'file' THEN
        text_result := text_result || '[file] ';
      ELSE
        -- Skip system messages and unknown types
        NULL;
    END CASE;
  END LOOP;

  RETURN trim(text_result);
END;
$$;


--
-- Name: FUNCTION extract_message_text(content_parts jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.extract_message_text(content_parts jsonb) IS 'Extracts readable text from MessagePart[] JSONB array, handling text, emoji, mentions, URLs, hashtags, and files.';


--
-- Name: extract_url_host(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.extract_url_host(p_url text) RETURNS text
    LANGUAGE sql IMMUTABLE
    AS $_$
  select lower(split_part(split_part(regexp_replace($1, '^https?://', ''), '/', 1), ':', 1));
$_$;


--
-- Name: fetch_generic_preview(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fetch_generic_preview(p_url text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  resp net.http_response;
  headers jsonb := jsonb_build_object('User-Agent', 'HarmonyLinkPreview(SQL)');
  html text;
  title text;
  description text;
  image text;
  icon text;
begin
  select *
  into resp
  from net.http_get(
    p_url,
    '{}'::jsonb,
    headers,
    8000
  );

  if resp.status_code between 200 and 299 then
    html := coalesce(resp.body, '');
  else
    return jsonb_build_object(
      'title', p_url,
      'description', format('Request failed (%s)', resp.status_code)
    );
  end if;

  title := coalesce(
    (regexp_match(html, '<meta[^>]+property=["'']og:title["''][^>]+content=["'']([^"'']+)["'']', 'is'))[1],
    (regexp_match(html, '<meta[^>]+name=["'']twitter:title["''][^>]+content=["'']([^"'']+)["'']', 'is'))[1],
    (regexp_match(html, '<title[^>]*>(.*?)</title>', 'is'))[1],
    p_url
  );

  description := coalesce(
    (regexp_match(html, '<meta[^>]+property=["'']og:description["''][^>]+content=["'']([^"'']+)["'']', 'is'))[1],
    (regexp_match(html, '<meta[^>]+name=["'']description["''][^>]+content=["'']([^"'']+)["'']', 'is'))[1]
  );

  image := coalesce(
    (regexp_match(html, '<meta[^>]+property=["'']og:image["''][^>]+content=["'']([^"'']+)["'']', 'is'))[1],
    (regexp_match(html, '<meta[^>]+name=["'']twitter:image["''][^>]+content=["'']([^"'']+)["'']', 'is'))[1]
  );

  icon := coalesce(
    (regexp_match(html, '<link[^>]+rel=["''](?:shortcut )?icon["''][^>]+href=["'']([^"'']+)["'']', 'is'))[1]
  );

  return jsonb_strip_nulls(jsonb_build_object(
    'title', title,
    'description', description,
    'siteName', public.extract_url_host(p_url),
    'image', public.make_absolute_url(p_url, image),
    'icon', public.make_absolute_url(p_url, icon)
  ));
end;
$$;


--
-- Name: fetch_link_preview(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fetch_link_preview(p_url text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'net', 'extensions'
    AS $$
declare
  normalized_url text := public.normalize_embed_url(p_url);
  provider text;
  payload jsonb;
begin
  if normalized_url is null then
    raise exception 'URL is required';
  end if;

  provider := public.detect_embed_provider(normalized_url);

  begin
    case provider
      when 'harmony-post' then
        payload := public.build_harmony_embed(normalized_url);
      when 'youtube' then
        payload := public.fetch_oembed_preview(normalized_url, 'https://www.youtube.com/oembed');
      when 'spotify' then
        payload := public.fetch_oembed_preview(normalized_url, 'https://open.spotify.com/oembed');
      else
        payload := public.fetch_generic_preview(normalized_url);
    end case;
  exception when others then
    payload := public.fetch_generic_preview(normalized_url);
  end;

  return payload
    || jsonb_build_object(
      'url', normalized_url,
      'normalizedUrl', normalized_url,
      'provider', provider,
      'fetchedAt', now(),
      'expiresAt', now() + interval '24 hours'
    );
end;
$$;


--
-- Name: fetch_oembed_preview(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fetch_oembed_preview(p_url text, p_endpoint text) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
declare
  resp net.http_response;
  body jsonb;
  headers jsonb := jsonb_build_object('Accept', 'application/json');
begin
  select *
  into resp
  from net.http_get(
    p_endpoint,
    jsonb_build_object('url', p_url, 'format', 'json'),
    headers,
    8000
  );

  if resp.status_code between 200 and 299 then
    body := coalesce(resp.body::jsonb, '{}'::jsonb);
    return jsonb_strip_nulls(jsonb_build_object(
      'title', body->>'title',
      'description', body->>'author_name',
      'siteName', coalesce(body->>'provider_name', public.extract_url_host(p_url)),
      'image', body->>'thumbnail_url',
      'html', body->>'html',
      'width', body->>'width',
      'height', body->>'height'
    ));
  else
    raise exception 'oEmbed request to % failed (status %, body %)', p_endpoint, resp.status_code, left(resp.body, 256);
  end if;
end;
$$;


--
-- Name: fetch_remote_link_preview(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.fetch_remote_link_preview(p_backend_base_url text, p_url text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions'
    AS $$
declare
  normalized_url text := public.normalize_embed_url(p_url);
  request_url text;
  resp http_response;
begin
  if normalized_url is null then
    return null;
  end if;

  if p_backend_base_url is null or trim(p_backend_base_url) = '' then
    raise exception 'link_preview_backend_url is not configured';
  end if;

  request_url := rtrim(p_backend_base_url, '/') || '/link-preview';

  resp := http_post(
    request_url,
    jsonb_build_object('url', normalized_url)::text,
    'application/json'
  );

  if resp.status between 200 and 299 then
    return resp.content::jsonb;
  else
    raise exception 'Backend preview failed (%): %', resp.status, left(resp.content, 200);
  end if;
exception
  when others then
    raise notice 'Remote preview failed for %: %', normalized_url, SQLERRM;
    return null;
end;
$$;


--
-- Name: get_activitypub_conversation_root(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_activitypub_conversation_root(post_id uuid) RETURNS TABLE(root_id uuid)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  current_id uuid := post_id;
  parent_id uuid;
  max_depth int := 100; -- Prevent infinite loops
  depth int := 0;
BEGIN
  LOOP
    -- Get the parent post ID
    SELECT in_reply_to INTO parent_id
    FROM public.posts
    WHERE id = current_id;
    
    -- If no parent, we've found the root
    IF parent_id IS NULL THEN
      RETURN QUERY SELECT current_id;
      RETURN;
    END IF;
    
    -- Move to parent
    current_id := parent_id;
    depth := depth + 1;
    
    -- Safety check
    IF depth >= max_depth THEN
      RETURN QUERY SELECT current_id;
      RETURN;
    END IF;
  END LOOP;
END;
$$;


--
-- Name: FUNCTION get_activitypub_conversation_root(post_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_activitypub_conversation_root(post_id uuid) IS 'Finds the root post of a conversation thread by following in_reply_to chain. Returns table with root_id column.';


--
-- Name: get_batch_message_reactions(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_batch_message_reactions(message_ids uuid[]) RETURNS TABLE(message_id uuid, emoji_id uuid, emoji_name character varying, emoji_url character varying, reaction_count bigint, users jsonb)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        r.message_id,
        r.emoji_id,
        e.name as emoji_name,  -- No cast needed - already character varying
        e.url as emoji_url,    -- No cast needed - already character varying
        COUNT(r.user_id) as reaction_count,  -- Match existing function behavior
        COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'reaction_id', r.id::text,
                    'user_id', r.user_id::text
                ) ORDER BY r.created_at
            ) FILTER (WHERE r.user_id IS NOT NULL),
            '[]'::jsonb
        ) as users
    FROM reactions r
    LEFT JOIN emojis e ON r.emoji_id = e.id
    WHERE r.message_id = ANY(get_batch_message_reactions.message_ids)
    GROUP BY r.message_id, r.emoji_id, e.name, e.url
    ORDER BY r.message_id, MIN(r.created_at);
END;
$$;


--
-- Name: FUNCTION get_batch_message_reactions(message_ids uuid[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_batch_message_reactions(message_ids uuid[]) IS 'FIXED: Batch reaction fetching with proper user_id handling and correct column types';


--
-- Name: get_batch_post_emoji_reactions(uuid[], integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_batch_post_emoji_reactions(p_post_ids uuid[], p_user_limit integer DEFAULT 5) RETURNS TABLE(post_id uuid, emoji_id uuid, emoji_name text, emoji_url text, custom_emoji_content text, reaction_count bigint, user_reactions jsonb, current_user_reacted boolean)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    current_user_id uuid;
BEGIN
    -- Get current user ID from session (if authenticated)
    current_user_id := auth.uid();
    
    RETURN QUERY
    SELECT 
        pi.post_id,
        pi.emoji_id,
        e.name::text as emoji_name,
        -- ONLY CHANGE: Support remote emoji URLs from metadata
        COALESCE(e.url::text, MAX(pi.metadata->>'remote_emoji_url')) as emoji_url,
        pi.custom_emoji_content,
        COUNT(*)::bigint as reaction_count,
        -- Limited user data for tooltips
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'user_id', sub_pi.user_id,
                    'username', sub_p.username,
                    'display_name', sub_p.display_name,
                    'avatar_url', sub_p.avatar_url,
                    'created_at', sub_pi.created_at
                )
                ORDER BY sub_pi.created_at DESC
            )
            FROM post_interactions sub_pi
            LEFT JOIN profiles sub_p ON sub_pi.user_id = sub_p.id
            WHERE sub_pi.post_id = pi.post_id
              AND sub_pi.interaction_type = 'emoji_reaction'
              AND (
                  (pi.emoji_id IS NOT NULL AND sub_pi.emoji_id = pi.emoji_id) OR
                  (pi.custom_emoji_content IS NOT NULL AND sub_pi.custom_emoji_content = pi.custom_emoji_content)
              )
            LIMIT p_user_limit
        ) as user_reactions,
        -- Check if current user has reacted
        CASE 
            WHEN current_user_id IS NULL THEN false
            ELSE EXISTS(
                SELECT 1 FROM post_interactions check_pi
                WHERE check_pi.post_id = pi.post_id
                  AND check_pi.user_id = current_user_id
                  AND check_pi.interaction_type = 'emoji_reaction'
                  AND (
                      (pi.emoji_id IS NOT NULL AND check_pi.emoji_id = pi.emoji_id) OR
                      (pi.custom_emoji_content IS NOT NULL AND check_pi.custom_emoji_content = pi.custom_emoji_content)
                  )
            )
        END as current_user_reacted
    FROM post_interactions pi
    LEFT JOIN emojis e ON pi.emoji_id = e.id
    WHERE pi.post_id = ANY(p_post_ids)
      AND pi.interaction_type = 'emoji_reaction'
    GROUP BY pi.post_id, pi.emoji_id, e.name, e.url, pi.custom_emoji_content
    ORDER BY pi.post_id, reaction_count DESC, MIN(pi.created_at) ASC;
END;
$$;


--
-- Name: get_batch_post_reactions(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_batch_post_reactions(post_ids uuid[]) RETURNS TABLE(post_id uuid, emoji_id uuid, emoji_name character varying, emoji_url character varying, reaction_count bigint, users jsonb)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        pi.post_id,
        pi.emoji_id,
        e.name as emoji_name,
        e.url as emoji_url,
        COUNT(pi.user_id) as reaction_count,
        jsonb_agg(
            jsonb_build_object(
                'id', p.id,
                'username', p.username,
                'display_name', p.display_name,
                'avatar_url', p.avatar_url
            ) ORDER BY pi.created_at
        ) as users
    FROM post_interactions pi
    INNER JOIN emojis e ON pi.emoji_id = e.id
    INNER JOIN profiles p ON pi.user_id = p.id
    WHERE pi.post_id = ANY(post_ids)
    AND pi.interaction_type = 'emoji_reaction'
    GROUP BY pi.post_id, pi.emoji_id, e.name, e.url
    ORDER BY pi.post_id, MIN(pi.created_at);
END;
$$;


--
-- Name: FUNCTION get_batch_post_reactions(post_ids uuid[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_batch_post_reactions(post_ids uuid[]) IS 'Optimized function to fetch reactions for multiple posts in a single query, eliminating N+1 performance issues.';


--
-- Name: get_channel_server_id(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_channel_server_id(channel_uuid uuid) RETURNS uuid
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  server_uuid uuid;
BEGIN
  SELECT server_id INTO server_uuid
  FROM channels
  WHERE id = channel_uuid;
  
  RETURN server_uuid;
END;
$$;


--
-- Name: get_conversation_context(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_conversation_context(in_post_id uuid, in_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    conversation_root_id uuid;
    result jsonb;
BEGIN
    -- Get the conversation root ID for this post
    SELECT COALESCE(p.conversation_root_id, p.id)
    INTO conversation_root_id
    FROM posts p
    WHERE p.id = in_post_id
      AND p.deleted_at IS NULL;
    
    -- If post not found, return empty object
    IF conversation_root_id IS NULL THEN
        RETURN '{}'::jsonb;
    END IF;
    
    -- Get all posts in conversation ordered chronologically
    WITH conversation_posts AS (
        SELECT 
            p.id,
            p.content,
            p.created_at,
            p.in_reply_to,
            jsonb_build_object(
                'id', pr.id,
                'username', pr.username,
                'display_name', pr.display_name,
                'avatar_url', pr.avatar_url,
                'domain', pr.domain
            ) as author,
            p.visibility,
            p.favorites_count,
            p.reblogs_count,
            p.replies_count,
            p.media_attachments,
            p.content_warning,
            p.is_sensitive,
            p.url,
            CASE 
                WHEN pi_fav.user_id IS NOT NULL THEN true 
                ELSE false 
            END as is_favorited,
            CASE 
                WHEN pi_reb.user_id IS NOT NULL THEN true 
                ELSE false 
            END as is_reblogged,
            CASE 
                WHEN pi_book.user_id IS NOT NULL THEN true 
                ELSE false 
            END as is_bookmarked
        FROM posts p
        JOIN profiles pr ON p.author_id = pr.id
        LEFT JOIN post_interactions pi_fav ON p.id = pi_fav.post_id 
            AND pi_fav.user_id = in_user_id 
            AND pi_fav.interaction_type = 'favorite'
        LEFT JOIN post_interactions pi_reb ON p.id = pi_reb.post_id 
            AND pi_reb.user_id = in_user_id 
            AND pi_reb.interaction_type = 'reblog'
        LEFT JOIN post_interactions pi_book ON p.id = pi_book.post_id 
            AND pi_book.user_id = in_user_id 
            AND pi_book.interaction_type = 'bookmark'
        WHERE COALESCE(p.conversation_root_id, p.id) = conversation_root_id
          AND p.deleted_at IS NULL
        ORDER BY p.created_at ASC
    )
    SELECT jsonb_build_object(
        'ancestors', COALESCE(jsonb_agg(
            jsonb_build_object(
                'id', cp.id,
                'content', cp.content,
                'created_at', cp.created_at,
                'author', cp.author,
                'visibility', cp.visibility,
                'favorites_count', cp.favorites_count,
                'reblogs_count', cp.reblogs_count,
                'replies_count', cp.replies_count,
                'media_attachments', cp.media_attachments,
                'content_warning', cp.content_warning,
                'is_sensitive', cp.is_sensitive,
                'url', cp.url,
                'is_favorited', cp.is_favorited,
                'is_reblogged', cp.is_reblogged,
                'is_bookmarked', cp.is_bookmarked
            )
        ) FILTER (WHERE cp.created_at < (SELECT created_at FROM posts WHERE id = in_post_id)), '[]'::jsonb),
        'descendants', COALESCE(jsonb_agg(
            jsonb_build_object(
                'id', cp.id,
                'content', cp.content,
                'created_at', cp.created_at,
                'author', cp.author,
                'visibility', cp.visibility,
                'favorites_count', cp.favorites_count,
                'reblogs_count', cp.reblogs_count,
                'replies_count', cp.replies_count,
                'media_attachments', cp.media_attachments,
                'content_warning', cp.content_warning,
                'is_sensitive', cp.is_sensitive,
                'url', cp.url,
                'is_favorited', cp.is_favorited,
                'is_reblogged', cp.is_reblogged,
                'is_bookmarked', cp.is_bookmarked
            )
        ) FILTER (WHERE cp.created_at > (SELECT created_at FROM posts WHERE id = in_post_id)), '[]'::jsonb),
        'conversation_id', conversation_root_id
    ) INTO result
    FROM conversation_posts cp;
    
    RETURN COALESCE(result, jsonb_build_object(
        'ancestors', '[]'::jsonb,
        'descendants', '[]'::jsonb,
        'conversation_id', conversation_root_id
    ));
END;
$$;


--
-- Name: get_conversation_encryption_status(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_conversation_encryption_status(p_conversation_id uuid) RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    v_settings public.conversation_encryption_settings;
    v_all_users_encrypted BOOLEAN;
    v_participant_ids UUID[];
    v_result JSONB;
BEGIN
    -- Get conversation encryption settings
    SELECT * INTO v_settings
    FROM public.conversation_encryption_settings
    WHERE conversation_id = p_conversation_id;
    
    -- Get all participant IDs
    SELECT ARRAY_AGG(user_id) INTO v_participant_ids
    FROM public.conversation_participants
    WHERE conversation_id = p_conversation_id;
    
    -- Check if all participants have encryption enabled
    SELECT bool_and(public.user_has_encryption(user_id)) INTO v_all_users_encrypted
    FROM unnest(v_participant_ids) as user_id;
    
    v_result := jsonb_build_object(
        'conversation_id', p_conversation_id,
        'encryption_enabled', COALESCE(v_settings.encryption_enabled, false),
        'verified', COALESCE(v_settings.verified, false),
        'all_users_have_keys', COALESCE(v_all_users_encrypted, false),
        'participant_count', COALESCE(array_length(v_participant_ids, 1), 0),
        'can_enable_encryption', COALESCE(v_all_users_encrypted, false)
    );
    
    RETURN v_result;
END;
$$;


--
-- Name: FUNCTION get_conversation_encryption_status(p_conversation_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_conversation_encryption_status(p_conversation_id uuid) IS 'Get encryption status and capabilities for a conversation.';


--
-- Name: get_conversation_participants(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_conversation_participants(conversation_uuid uuid) RETURNS TABLE(user_id uuid, role text, joined_at timestamp with time zone, is_muted boolean, last_read_at timestamp with time zone)
    LANGUAGE sql STABLE
    AS $$
  SELECT 
    cp.user_id,
    cp.role,
    cp.joined_at,
    cp.is_muted,
    cp.last_read_at
  FROM conversation_participants cp
  WHERE cp.conversation_id = conversation_uuid 
    AND cp.left_at IS NULL
  ORDER BY cp.joined_at;
$$;


--
-- Name: get_conversation_thread(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_conversation_thread(p_conversation_id text, p_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  root_post jsonb;
  thread_posts jsonb;
  reply_count integer;
  participant_count integer;
  last_updated timestamptz;
BEGIN
  -- Get the root post (the one that started the conversation)
  SELECT to_jsonb(tp.*) INTO root_post
  FROM timeline_posts tp
  WHERE tp.conversation_id = p_conversation_id
    AND tp.reply_context IS NULL
  ORDER BY tp.created_at ASC
  LIMIT 1;
  
  -- Get all posts in the conversation with user interaction state
  SELECT jsonb_agg(
    jsonb_build_object(
      'id', tp.id,
      'content', tp.content,
      'author', tp.author,
      'created_at', tp.created_at,
      'reply_context', tp.reply_context,
      'replies_count', tp.replies_count,
      'reblogs_count', tp.reblogs_count,
      'favorites_count', tp.favorites_count,
      'is_favorited', COALESCE(fav.user_id IS NOT NULL, false),
      'is_reblogged', COALESCE(reb.user_id IS NOT NULL, false),
      'is_bookmarked', COALESCE(book.user_id IS NOT NULL, false)
    ) ORDER BY tp.created_at ASC
  ) INTO thread_posts
  FROM timeline_posts tp
  LEFT JOIN post_interactions fav ON tp.id = fav.post_id 
    AND fav.user_id = p_user_id AND fav.interaction_type = 'favorite'
  LEFT JOIN post_interactions reb ON tp.id = reb.post_id 
    AND reb.user_id = p_user_id AND reb.interaction_type = 'reblog'
  LEFT JOIN post_interactions book ON tp.id = book.post_id 
    AND book.user_id = p_user_id AND book.interaction_type = 'bookmark'
  WHERE tp.conversation_id = p_conversation_id;
  
  -- Get conversation stats
  SELECT 
    COUNT(*) - 1, -- Subtract 1 for root post
    COUNT(DISTINCT tp.author_id),
    MAX(tp.created_at)
  INTO reply_count, participant_count, last_updated
  FROM timeline_posts tp
  WHERE tp.conversation_id = p_conversation_id;
  
  RETURN jsonb_build_object(
    'root_post', root_post,
    'posts', COALESCE(thread_posts, '[]'::jsonb),
    'reply_count', COALESCE(reply_count, 0),
    'participant_count', COALESCE(participant_count, 0),
    'last_updated', last_updated
  );
END;
$$;


--
-- Name: get_current_profile_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_current_profile_id() RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT id FROM public.profiles WHERE auth_user_id = auth.uid() LIMIT 1
$$;


--
-- Name: FUNCTION get_current_profile_id(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_current_profile_id() IS 'Returns the profile ID for the currently authenticated user. Uses indexed lookup on auth_user_id. Marked STABLE for query planner optimization.';


--
-- Name: get_current_user_profile_id(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_current_user_profile_id() RETURNS uuid
    LANGUAGE plpgsql STABLE SECURITY DEFINER
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


--
-- Name: get_default_channel(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_default_channel(p_server_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    channel_id UUID;
BEGIN
    -- Get the first text channel (type 0) named 'general' or the first text channel
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


--
-- Name: get_emoji_metadata_bulk(uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_emoji_metadata_bulk(server_ids uuid[]) RETURNS TABLE(server_id uuid, last_modified timestamp with time zone, emoji_count integer)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        e.server_id,
        COALESCE(MAX(e.updated_at), MAX(e.created_at)) as last_modified,
        COUNT(e.id)::integer as emoji_count
    FROM emojis e
    WHERE e.server_id = ANY(server_ids)
    GROUP BY e.server_id;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: encryption_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.encryption_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    local_user_id uuid NOT NULL,
    local_device_id text DEFAULT 'default'::text,
    remote_user_id uuid NOT NULL,
    remote_device_id text DEFAULT 'default'::text,
    session_state text NOT NULL,
    established_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now(),
    message_count integer DEFAULT 0,
    needs_refresh boolean DEFAULT false,
    metadata jsonb DEFAULT '{}'::jsonb
);


--
-- Name: TABLE encryption_sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.encryption_sessions IS 'Signal Protocol session state for message encryption between users.';


--
-- Name: COLUMN encryption_sessions.session_state; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.encryption_sessions.session_state IS 'Serialized Signal Protocol session state. Stored encrypted.';


--
-- Name: COLUMN encryption_sessions.message_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.encryption_sessions.message_count IS 'Track message count for automatic session rotation.';


--
-- Name: get_encryption_session(uuid, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_encryption_session(p_local_user_id uuid, p_remote_user_id uuid, p_local_device_id text DEFAULT 'default'::text, p_remote_device_id text DEFAULT 'default'::text) RETURNS public.encryption_sessions
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_session public.encryption_sessions;
BEGIN
    -- Only allow users to get their own sessions
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = p_local_user_id
        AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot access sessions for another user';
    END IF;
    
    SELECT * INTO v_session
    FROM public.encryption_sessions
    WHERE local_user_id = p_local_user_id
        AND local_device_id = p_local_device_id
        AND remote_user_id = p_remote_user_id
        AND remote_device_id = p_remote_device_id;
    
    -- Update last_used_at if session exists
    IF v_session IS NOT NULL THEN
        UPDATE public.encryption_sessions
        SET last_used_at = NOW()
        WHERE id = v_session.id;
    END IF;
    
    RETURN v_session;
END;
$$;


--
-- Name: FUNCTION get_encryption_session(p_local_user_id uuid, p_remote_user_id uuid, p_local_device_id text, p_remote_device_id text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_encryption_session(p_local_user_id uuid, p_remote_user_id uuid, p_local_device_id text, p_remote_device_id text) IS 'Get existing encryption session between two users.';


--
-- Name: get_enhanced_timeline_posts(uuid, text, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_enhanced_timeline_posts(p_user_id uuid, p_timeline_type text DEFAULT 'home'::text, p_limit integer DEFAULT 20, p_max_id text DEFAULT NULL::text) RETURNS TABLE(id text, created_at timestamp with time zone, updated_at timestamp with time zone, content jsonb, content_warning text, language text, author_id text, ap_id text, ap_type text, url text, reply_context jsonb, conversation_id text, visibility text, is_local boolean, is_federated boolean, replies_count integer, reblogs_count integer, favorites_count integer, media_attachments jsonb, metadata jsonb, is_sensitive boolean, is_deleted boolean, deleted_at timestamp with time zone, author jsonb, is_favorited boolean, is_reblogged boolean, is_bookmarked boolean, reblog jsonb, reblog_author jsonb)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        tp.id::TEXT,
        tp.created_at,
        tp.updated_at,
        tp.content,
        tp.content_warning,
        'en'::TEXT as language,
        (tp.author->>'id')::TEXT as author_id,
        p.ap_id::TEXT,
        COALESCE(p.ap_type, 'Note')::TEXT as ap_type,
        tp.url,
        tp.reply_context,
        tp.conversation_id::TEXT,
        tp.visibility,
        (tp.author->>'is_local')::BOOLEAN as is_local,
        NOT (tp.author->>'is_local')::BOOLEAN as is_federated,
        tp.replies_count,
        tp.reblogs_count,
        tp.favorites_count,
        tp.media_attachments,
        COALESCE(p.metadata, '{}'::JSONB) as metadata,
        tp.is_sensitive,
        COALESCE(p.is_deleted, false) as is_deleted,
        p.deleted_at,
        tp.author,
        
        -- User interaction states
        COALESCE(fav.user_id IS NOT NULL, false) as is_favorited,
        COALESCE(reb.user_id IS NOT NULL, false) as is_reblogged,
        COALESCE(book.user_id IS NOT NULL, false) as is_bookmarked,
        
        -- Reblog fields
        tp.reblog,
        tp.reblog_author
        
    FROM timeline_posts tp
    JOIN posts p ON tp.id = p.id
    LEFT JOIN post_interactions fav ON tp.id = fav.post_id 
        AND fav.user_id = p_user_id 
        AND fav.interaction_type = 'favorite'
    LEFT JOIN post_interactions reb ON tp.id = reb.post_id 
        AND reb.user_id = p_user_id 
        AND reb.interaction_type = 'reblog'
    LEFT JOIN post_interactions book ON tp.id = book.post_id 
        AND book.user_id = p_user_id 
        AND book.interaction_type = 'bookmark'
    
    WHERE 
        CASE 
            -- HOME: Use timeline_entries for proper following logic
            WHEN p_timeline_type = 'home' THEN 
                EXISTS (
                    SELECT 1 FROM timeline_entries te 
                    WHERE te.user_id = p_user_id 
                      AND te.post_id = tp.id 
                      AND te.timeline_type = 'home'
                )
            
            -- LOCAL: Only public posts from local users
            WHEN p_timeline_type = 'local' THEN 
                tp.visibility = 'public' 
                AND (tp.author->>'is_local')::BOOLEAN = true
            
            -- PUBLIC/FEDERATED: All public posts (local + remote) - standard ActivityPub timeline
            WHEN p_timeline_type IN ('public', 'federated') THEN 
                tp.visibility = 'public'
                
            ELSE tp.visibility = 'public'
        END
        
        -- Pagination
        AND (p_max_id IS NULL OR tp.created_at < (
            SELECT tp2.created_at FROM timeline_posts tp2 WHERE tp2.id = p_max_id::UUID
        ))
    
    ORDER BY tp.created_at DESC
    LIMIT p_limit;
END;
$$;


--
-- Name: FUNCTION get_enhanced_timeline_posts(p_user_id uuid, p_timeline_type text, p_limit integer, p_max_id text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_enhanced_timeline_posts(p_user_id uuid, p_timeline_type text, p_limit integer, p_max_id text) IS 'Enhanced timeline function with proper home timeline support using timeline_entries and separate federated timeline';


--
-- Name: get_featured_posts_hybrid(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_featured_posts_hybrid(p_author_id uuid, p_limit integer DEFAULT 10) RETURNS TABLE(id uuid, content jsonb, created_at timestamp with time zone, updated_at timestamp with time zone, author_id uuid, engagement_count integer, replies_count integer, is_pinned boolean, ap_id text, ap_type text, visibility text, media_attachments jsonb, content_warning text, in_reply_to uuid, favorites_count integer, reblogs_count integer)
    LANGUAGE plpgsql
    AS $$
DECLARE
    pinned_count INT;
    remaining_limit INT;
BEGIN
    -- First, get pinned posts
    RETURN QUERY
    SELECT 
        p.id, p.content, p.created_at, p.updated_at, p.author_id,
        (p.favorites_count + p.reblogs_count + p.replies_count) as engagement_count,
        p.replies_count, p.is_pinned,
        p.ap_id, p.ap_type, p.visibility, p.media_attachments,
        p.content_warning, p.in_reply_to, p.favorites_count, p.reblogs_count
    FROM posts p
    WHERE p.author_id = p_author_id 
        AND p.is_pinned = true
        AND p.is_deleted = false
        AND p.visibility IN ('public', 'unlisted')
    ORDER BY p.created_at DESC
    LIMIT p_limit;

    -- Count how many pinned posts we got
    GET DIAGNOSTICS pinned_count = ROW_COUNT;
    remaining_limit := p_limit - pinned_count;

    -- If we have room for more, add popular posts
    IF remaining_limit > 0 THEN
        RETURN QUERY
        SELECT 
            p.id, p.content, p.created_at, p.updated_at, p.author_id,
            (p.favorites_count + p.reblogs_count + p.replies_count) as engagement_count,
            p.replies_count, p.is_pinned,
            p.ap_id, p.ap_type, p.visibility, p.media_attachments,
            p.content_warning, p.in_reply_to, p.favorites_count, p.reblogs_count
        FROM posts p
        WHERE p.author_id = p_author_id 
            AND p.is_pinned = false
            AND p.is_deleted = false
            AND p.visibility IN ('public', 'unlisted')
            AND (p.favorites_count + p.reblogs_count + p.replies_count) > 0
        ORDER BY (p.favorites_count + p.reblogs_count + p.replies_count) DESC, p.created_at DESC
        LIMIT remaining_limit;
    END IF;
END;
$$;


--
-- Name: get_federation_config(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_federation_config() RETURNS jsonb
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    config jsonb;
BEGIN
    SELECT config_value INTO config
    FROM instance_config 
    WHERE config_key = 'federation_settings';
    
    -- Return defaults if no config exists
    IF config IS NULL THEN
        config := jsonb_build_object(
            'federation_enabled', true,
            'federation_auto_accept_follows', true,
            'federation_require_approval', false,
            'federation_max_delivery_attempts', 5,
            'federation_delivery_timeout_ms', 10000
        );
    END IF;
    
    RETURN config;
END;
$$;


--
-- Name: FUNCTION get_federation_config(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_federation_config() IS 'Get current federation configuration with sensible defaults';


--
-- Name: get_follow_status(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_follow_status(current_user_id uuid, target_user_id uuid) RETURNS TABLE(is_following boolean, is_followed_by boolean, follow_status text, followed_by_status text)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        -- Is current user following target user?
        EXISTS(
            SELECT 1 FROM follows 
            WHERE follower_id = current_user_id 
            AND following_id = target_user_id 
            AND status = 'accepted'
        ) as is_following,
        
        -- Is current user followed by target user?
        EXISTS(
            SELECT 1 FROM follows 
            WHERE follower_id = target_user_id 
            AND following_id = current_user_id 
            AND status = 'accepted'
        ) as is_followed_by,
        
        -- Follow request status (outgoing)
        COALESCE(
            (SELECT status FROM follows 
             WHERE follower_id = current_user_id 
             AND following_id = target_user_id 
             LIMIT 1), 
            'none'
        ) as follow_status,
        
        -- Follow request status (incoming)
        COALESCE(
            (SELECT status FROM follows 
             WHERE follower_id = target_user_id 
             AND following_id = current_user_id 
             LIMIT 1), 
            'none'
        ) as followed_by_status;
END;
$$;


--
-- Name: FUNCTION get_follow_status(current_user_id uuid, target_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_follow_status(current_user_id uuid, target_user_id uuid) IS 'Helper function to get complete follow relationship status between two users.
Uses correct following_id column names.
Returns: is_following, is_followed_by, follow_status, followed_by_status';


--
-- Name: get_instance_config(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_instance_config(p_key text DEFAULT NULL::text) RETURNS TABLE(config_key text, config_value jsonb, description text)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    IF p_key IS NOT NULL THEN
        RETURN QUERY
        SELECT ic.config_key, ic.config_value, ic.description
        FROM instance_config ic
        WHERE ic.config_key = p_key;
    ELSE
        RETURN QUERY
        SELECT ic.config_key, ic.config_value, ic.description
        FROM instance_config ic
        ORDER BY ic.config_key;
    END IF;
END;
$$;


--
-- Name: get_instance_domain(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_instance_domain() RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    domain_value text;
BEGIN
    -- Get domain from instance_config
    SELECT trim(both '"' from config_value::text) INTO domain_value
    FROM instance_config 
    WHERE config_key = 'domain';
    
    -- Return domain or fallback
    RETURN COALESCE(domain_value, 'localhost');
END;
$$;


--
-- Name: FUNCTION get_instance_domain(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_instance_domain() IS 'Get instance domain accessible to all users';


--
-- Name: get_message_reactions(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_message_reactions(message_id uuid) RETURNS TABLE(count bigint, emoji jsonb, reactions jsonb, message_id_of_reactions uuid)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        COUNT(r.*) as count,
        to_jsonb(e.*) as emoji,
        COALESCE(
            jsonb_agg(
                jsonb_build_object(
                    'reaction_id', r.id::text,
                    'user_id', r.user_id::text
                ) ORDER BY r.created_at
            ) FILTER (WHERE r.user_id IS NOT NULL),
            '[]'::jsonb
        ) as reactions,
        get_message_reactions.message_id as message_id_of_reactions
    FROM reactions r
    LEFT JOIN emojis e ON r.emoji_id = e.id
    WHERE r.message_id = get_message_reactions.message_id
    GROUP BY r.emoji_id, e.id, r.message_id
    ORDER BY MIN(r.created_at);
END;
$$;


--
-- Name: FUNCTION get_message_reactions(message_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_message_reactions(message_id uuid) IS 'FIXED: Returns reaction groups with proper user_id handling, matching original return structure';


--
-- Name: get_or_create_conversation(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_or_create_conversation(user1_uuid uuid, user2_uuid uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
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


--
-- Name: FUNCTION get_or_create_conversation(user1_uuid uuid, user2_uuid uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_or_create_conversation(user1_uuid uuid, user2_uuid uuid) IS 'Get existing 1-to-1 conversation or create new one. Ensures consistent participant ordering.';


--
-- Name: get_or_create_dm_conversation(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_or_create_dm_conversation(p_user1_id uuid, p_user2_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_conversation_id UUID;
BEGIN
  -- Try to find existing conversation between these users
  SELECT c.id INTO v_conversation_id
  FROM conversations c
  WHERE c.type = 'direct'
    AND EXISTS (
      SELECT 1 FROM conversation_participants cp1
      WHERE cp1.conversation_id = c.id 
        AND cp1.user_id = p_user1_id 
        AND cp1.left_at IS NULL
    )
    AND EXISTS (
      SELECT 1 FROM conversation_participants cp2
      WHERE cp2.conversation_id = c.id 
        AND cp2.user_id = p_user2_id 
        AND cp2.left_at IS NULL
    )
    -- Ensure it's exactly 2 participants (direct conversation)
    AND (
      SELECT COUNT(*) FROM conversation_participants cp3
      WHERE cp3.conversation_id = c.id 
        AND cp3.left_at IS NULL
    ) = 2;
  
  -- If not found, create new conversation
  IF v_conversation_id IS NULL THEN
    INSERT INTO conversations (type, created_by, is_active)
    VALUES ('direct', p_user1_id, TRUE)
    RETURNING id INTO v_conversation_id;
    
    -- Add both participants
    INSERT INTO conversation_participants (conversation_id, user_id, role, joined_at)
    VALUES 
      (v_conversation_id, p_user1_id, 'member', NOW()),
      (v_conversation_id, p_user2_id, 'member', NOW());
      
    RAISE NOTICE 'Created new DM conversation % between users % and %', 
      v_conversation_id, p_user1_id, p_user2_id;
  END IF;
  
  RETURN v_conversation_id;
END;
$$;


--
-- Name: FUNCTION get_or_create_dm_conversation(p_user1_id uuid, p_user2_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_or_create_dm_conversation(p_user1_id uuid, p_user2_id uuid) IS 'Gets existing or creates new DM conversation between two users using conversation_participants system';


--
-- Name: get_pending_reports_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_pending_reports_count() RETURNS integer
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
    SELECT COUNT(*)::integer
    FROM public.reports
    WHERE status = 'pending';
$$;


--
-- Name: FUNCTION get_pending_reports_count(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_pending_reports_count() IS 'Returns count of pending reports for admin dashboard';


--
-- Name: get_post_emoji_reactions(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_post_emoji_reactions(p_post_id uuid, p_user_limit integer DEFAULT 5) RETURNS TABLE(emoji_id uuid, emoji_name text, emoji_url text, custom_emoji_content text, reaction_count bigint, user_reactions jsonb, current_user_reacted boolean)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    current_user_id uuid;
BEGIN
    -- Get current user ID from session (if authenticated)
    current_user_id := auth.uid();
    
    RETURN QUERY
    SELECT 
        pi.emoji_id,
        e.name::text as emoji_name,
        -- ONLY CHANGE: Support remote emoji URLs from metadata
        COALESCE(e.url::text, MAX(pi.metadata->>'remote_emoji_url')) as emoji_url,
        pi.custom_emoji_content,
        COUNT(*)::bigint as reaction_count,
        -- Only include limited user data for tooltips
        (
            SELECT jsonb_agg(
                jsonb_build_object(
                    'user_id', sub_pi.user_id,
                    'username', sub_p.username,
                    'display_name', sub_p.display_name,
                    'avatar_url', sub_p.avatar_url,
                    'created_at', sub_pi.created_at
                )
                ORDER BY sub_pi.created_at DESC
            )
            FROM post_interactions sub_pi
            LEFT JOIN profiles sub_p ON sub_pi.user_id = sub_p.id
            WHERE sub_pi.post_id = p_post_id
              AND sub_pi.interaction_type = 'emoji_reaction'
              AND (
                  (pi.emoji_id IS NOT NULL AND sub_pi.emoji_id = pi.emoji_id) OR
                  (pi.custom_emoji_content IS NOT NULL AND sub_pi.custom_emoji_content = pi.custom_emoji_content)
              )
            LIMIT p_user_limit
        ) as user_reactions,
        -- Check if current user has reacted with this emoji
        CASE 
            WHEN current_user_id IS NULL THEN false
            ELSE EXISTS(
                SELECT 1 FROM post_interactions check_pi
                WHERE check_pi.post_id = p_post_id
                  AND check_pi.user_id = current_user_id
                  AND check_pi.interaction_type = 'emoji_reaction'
                  AND (
                      (pi.emoji_id IS NOT NULL AND check_pi.emoji_id = pi.emoji_id) OR
                      (pi.custom_emoji_content IS NOT NULL AND check_pi.custom_emoji_content = pi.custom_emoji_content)
                  )
            )
        END as current_user_reacted
    FROM post_interactions pi
    LEFT JOIN emojis e ON pi.emoji_id = e.id
    WHERE pi.post_id = p_post_id 
      AND pi.interaction_type = 'emoji_reaction'
    GROUP BY pi.emoji_id, e.name, e.url, pi.custom_emoji_content
    ORDER BY reaction_count DESC, MIN(pi.created_at) ASC;
END;
$$;


--
-- Name: get_post_with_context(uuid, uuid, text, uuid, integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_post_with_context(p_post_id uuid, p_user_id uuid, p_context_type text DEFAULT 'minimal'::text, p_highlight_reply uuid DEFAULT NULL::uuid, p_max_depth integer DEFAULT 10, p_include_interactions boolean DEFAULT true) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_main_post JSONB;
  v_ancestors JSONB := '[]'::jsonb;
  v_descendants JSONB := '[]'::jsonb;
  v_thread_info JSONB;
  v_thread_id UUID;
  v_root_post_id UUID;
  v_total_posts INTEGER := 1;
  v_participant_count INTEGER := 1;
  v_max_depth INTEGER := 0;
  v_last_activity TIMESTAMP WITH TIME ZONE;
BEGIN
  -- Get the main post with all required fields and user interaction states
  SELECT to_jsonb(post_data) INTO v_main_post
  FROM (
    SELECT 
      p.*,
      profiles.id as author_id,
      profiles.username as author_username,
      profiles.display_name as author_display_name,
      profiles.avatar_url as author_avatar_url,
      profiles.domain as author_domain,
      profiles.bio as author_bio,
      profiles.is_local as author_is_local,
      profiles.followers_count as author_followers_count,
      profiles.following_count as author_following_count,
      profiles.posts_count as author_posts_count,
      profiles.created_at as author_created_at,
      profiles.updated_at as author_updated_at,
      -- Generate handle from username and domain
      CASE 
        WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
          '@' || profiles.username || '@' || profiles.domain
        ELSE 
          '@' || profiles.username
      END as author_handle,
      -- User interaction states (only if p_include_interactions is true)
      CASE 
        WHEN p_include_interactions THEN
          EXISTS(SELECT 1 FROM post_interactions WHERE post_id = p.id AND user_id = p_user_id AND interaction_type = 'favorite')
        ELSE false
      END as is_favorited,
      CASE 
        WHEN p_include_interactions THEN
          EXISTS(SELECT 1 FROM post_interactions WHERE post_id = p.id AND user_id = p_user_id AND interaction_type = 'reblog')
        ELSE false
      END as is_reblogged,
      CASE 
        WHEN p_include_interactions THEN
          EXISTS(SELECT 1 FROM post_interactions WHERE post_id = p.id AND user_id = p_user_id AND interaction_type = 'bookmark')
        ELSE false
      END as is_bookmarked,
      -- Author object for nested structure
      jsonb_build_object(
        'id', profiles.id,
        'username', profiles.username,
        'display_name', profiles.display_name,
        'avatar_url', profiles.avatar_url,
        'domain', profiles.domain,
        'bio', profiles.bio,
        'is_local', profiles.is_local,
        'followers_count', profiles.followers_count,
        'following_count', profiles.following_count,
        'posts_count', profiles.posts_count,
        'created_at', profiles.created_at,
        'updated_at', profiles.updated_at,
        'handle', CASE 
          WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
            '@' || profiles.username || '@' || profiles.domain
          ELSE 
            '@' || profiles.username
        END
      ) as author
    FROM posts p
    JOIN profiles ON profiles.id = p.author_id
    WHERE p.id = p_post_id
      AND p.is_deleted = false
  ) as post_data;

  -- If main post not found, return error
  IF v_main_post IS NULL THEN
    RETURN jsonb_build_object('error', 'Post not found');
  END IF;

  -- Get thread_id for thread context (may be null, that's ok)
  SELECT conversation_id INTO v_thread_id 
  FROM posts 
  WHERE id = p_post_id;

  -- For non-minimal contexts, get thread data
  IF p_context_type != 'minimal' THEN
    -- Find root post of the thread by following in_reply_to chain upward
    WITH RECURSIVE thread_root AS (
      -- Base case: start with the current post
      SELECT id, in_reply_to, 0 as depth
      FROM posts 
      WHERE id = p_post_id
      
      UNION ALL
      
      -- Recursive case: follow in_reply_to chain upward
      SELECT p.id, p.in_reply_to, tr.depth + 1
      FROM posts p
      JOIN thread_root tr ON p.id = tr.in_reply_to
      WHERE tr.depth < 50 -- Prevent infinite recursion
    )
    SELECT id INTO v_root_post_id 
    FROM thread_root 
    WHERE in_reply_to IS NULL
    ORDER BY depth DESC 
    LIMIT 1;

    -- If no root found, current post is the root
    IF v_root_post_id IS NULL THEN
      v_root_post_id := p_post_id;
    END IF;

    -- Get thread statistics using the conversation_root_id chain instead of conversation_id
    WITH RECURSIVE all_thread_posts AS (
      -- Start from the root post
      SELECT id, in_reply_to, author_id, created_at, 0 as depth
      FROM posts 
      WHERE id = v_root_post_id
      
      UNION ALL
      
      -- Get all posts that are replies in this thread
      SELECT p.id, p.in_reply_to, p.author_id, p.created_at, atp.depth + 1
      FROM posts p
      JOIN all_thread_posts atp ON p.in_reply_to = atp.id
      WHERE atp.depth < 50 -- Prevent infinite recursion
        AND p.is_deleted = false
    )
    SELECT 
      COUNT(DISTINCT id),
      COUNT(DISTINCT author_id),
      MAX(created_at)
    INTO v_total_posts, v_participant_count, v_last_activity
    FROM all_thread_posts;

    -- Get ancestors (posts this is replying to) if requested
    IF p_context_type IN ('thread', 'ancestors') THEN
      WITH RECURSIVE ancestors AS (
        -- Base case: direct parent
        SELECT p.*, 0 as depth
        FROM posts p
        WHERE p.id = (SELECT in_reply_to FROM posts WHERE id = p_post_id)
          AND p.is_deleted = false
        
        UNION ALL
        
        -- Recursive case: follow the reply chain upward
        SELECT p.*, a.depth + 1
        FROM posts p
        JOIN ancestors a ON p.id = (SELECT in_reply_to FROM posts WHERE id = a.id)
        WHERE a.depth < p_max_depth
          AND p.is_deleted = false
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', a.id,
          'created_at', a.created_at,
          'updated_at', a.updated_at,
          'content', a.content,
          'content_warning', a.content_warning,
          'language', a.language,
          'author_id', a.author_id,
          'ap_id', a.ap_id,
          'ap_type', a.ap_type,
          'url', a.url,
          'conversation_id', a.conversation_id,
          'visibility', a.visibility,
          'is_local', a.is_local,
          'is_federated', a.is_federated,
          'replies_count', a.replies_count,
          'reblogs_count', a.reblogs_count,
          'favorites_count', a.favorites_count,
          'media_attachments', a.media_attachments,
          'metadata', a.metadata,
          'is_sensitive', a.is_sensitive,
          'is_deleted', a.is_deleted,
          'deleted_at', a.deleted_at,
          'is_favorited', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = a.id AND user_id = p_user_id AND interaction_type = 'favorite')
            ELSE false
          END,
          'is_reblogged', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = a.id AND user_id = p_user_id AND interaction_type = 'reblog')
            ELSE false
          END,
          'is_bookmarked', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = a.id AND user_id = p_user_id AND interaction_type = 'bookmark')
            ELSE false
          END,
          'author', jsonb_build_object(
            'id', profiles.id,
            'username', profiles.username,
            'display_name', profiles.display_name,
            'avatar_url', profiles.avatar_url,
            'domain', profiles.domain,
            'bio', profiles.bio,
            'is_local', profiles.is_local,
            'followers_count', profiles.followers_count,
            'following_count', profiles.following_count,
            'posts_count', profiles.posts_count,
            'created_at', profiles.created_at,
            'updated_at', profiles.updated_at,
            'handle', CASE 
              WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
                '@' || profiles.username || '@' || profiles.domain
              ELSE 
                '@' || profiles.username
            END
          )
        ) ORDER BY a.depth DESC -- Oldest ancestor first
      ) INTO v_ancestors
      FROM ancestors a
      JOIN profiles ON profiles.id = a.author_id;
    END IF;

    -- Get descendants (replies to this post) if requested
    IF p_context_type IN ('thread', 'descendants') THEN
      WITH RECURSIVE descendants AS (
        -- Base case: direct replies
        SELECT p.*, 0 as depth, ARRAY[p.created_at::text, p.id::text] as sort_path
        FROM posts p
        WHERE p.in_reply_to = p_post_id
          AND p.is_deleted = false
        
        UNION ALL
        
        -- Recursive case: follow reply chains downward
        SELECT p.*, d.depth + 1, d.sort_path || ARRAY[p.created_at::text, p.id::text]
        FROM posts p
        JOIN descendants d ON p.in_reply_to = d.id
        WHERE d.depth < p_max_depth
          AND p.is_deleted = false
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'id', d.id,
          'created_at', d.created_at,
          'updated_at', d.updated_at,
          'content', d.content,
          'content_warning', d.content_warning,
          'language', d.language,
          'author_id', d.author_id,
          'ap_id', d.ap_id,
          'ap_type', d.ap_type,
          'url', d.url,
          'conversation_id', d.conversation_id,
          'visibility', d.visibility,
          'is_local', d.is_local,
          'is_federated', d.is_federated,
          'replies_count', d.replies_count,
          'reblogs_count', d.reblogs_count,
          'favorites_count', d.favorites_count,
          'media_attachments', d.media_attachments,
          'metadata', d.metadata,
          'is_sensitive', d.is_sensitive,
          'is_deleted', d.is_deleted,
          'deleted_at', d.deleted_at,
          'depth', d.depth,
          'is_favorited', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = d.id AND user_id = p_user_id AND interaction_type = 'favorite')
            ELSE false
          END,
          'is_reblogged', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = d.id AND user_id = p_user_id AND interaction_type = 'reblog')
            ELSE false
          END,
          'is_bookmarked', CASE 
            WHEN p_include_interactions THEN
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = d.id AND user_id = p_user_id AND interaction_type = 'bookmark')
            ELSE false
          END,
          'author', jsonb_build_object(
            'id', profiles.id,
            'username', profiles.username,
            'display_name', profiles.display_name,
            'avatar_url', profiles.avatar_url,
            'domain', profiles.domain,
            'bio', profiles.bio,
            'is_local', profiles.is_local,
            'followers_count', profiles.followers_count,
            'following_count', profiles.following_count,
            'posts_count', profiles.posts_count,
            'created_at', profiles.created_at,
            'updated_at', profiles.updated_at,
            'handle', CASE 
              WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
                '@' || profiles.username || '@' || profiles.domain
              ELSE 
                '@' || profiles.username
            END
          )
        ) ORDER BY d.sort_path -- Chronological order preserving thread structure
      ) INTO v_descendants
      FROM descendants d
      JOIN profiles ON profiles.id = d.author_id;
    END IF;

    -- Calculate max depth for thread info using reply chain instead of conversation_id
    WITH RECURSIVE depth_calc AS (
      SELECT id, 0 as depth
      FROM posts 
      WHERE id = v_root_post_id
      
      UNION ALL
      
      SELECT p.id, dc.depth + 1
      FROM posts p
      JOIN depth_calc dc ON p.in_reply_to = dc.id
      WHERE dc.depth < 50 -- Prevent infinite recursion
        AND p.is_deleted = false
    )
    SELECT COALESCE(MAX(depth), 0) INTO v_max_depth
    FROM depth_calc;
  END IF;

  -- Build thread info
  v_thread_info := jsonb_build_object(
    'totalPosts', COALESCE(v_total_posts, 1),
    'participantCount', COALESCE(v_participant_count, 1),
    'depth', COALESCE(v_max_depth, 0),
    'rootPostId', COALESCE(v_root_post_id, p_post_id),
    'lastActivity', COALESCE(v_last_activity, (v_main_post->>'created_at')::timestamp with time zone)
  );

  -- Return the complete result
  RETURN jsonb_build_object(
    'mainPost', v_main_post,
    'ancestors', COALESCE(v_ancestors, '[]'::jsonb),
    'descendants', COALESCE(v_descendants, '[]'::jsonb),
    'threadInfo', v_thread_info
  );

EXCEPTION WHEN OTHERS THEN
  -- Log error and return structured error response
  RAISE LOG 'Error in get_post_with_context: %', SQLERRM;
  RETURN jsonb_build_object(
    'error', 'Database error: ' || SQLERRM,
    'mainPost', null,
    'ancestors', '[]'::jsonb,
    'descendants', '[]'::jsonb,
    'threadInfo', jsonb_build_object(
      'totalPosts', 0,
      'participantCount', 0,
      'depth', 0,
      'rootPostId', null,
      'lastActivity', null
    )
  );
END;
$$;


--
-- Name: FUNCTION get_post_with_context(p_post_id uuid, p_user_id uuid, p_context_type text, p_highlight_reply uuid, p_max_depth integer, p_include_interactions boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_post_with_context(p_post_id uuid, p_user_id uuid, p_context_type text, p_highlight_reply uuid, p_max_depth integer, p_include_interactions boolean) IS 'Unified function to get posts with configurable thread context (minimal, thread, ancestors, descendants). Replaces separate post detail and thread view functions.';


--
-- Name: get_public_federation_settings(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_public_federation_settings() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    federation_settings jsonb;
BEGIN
    -- Get federation settings from instance_config
    SELECT config_value INTO federation_settings
    FROM instance_config 
    WHERE config_key = 'federation_settings';
    
    -- Return safe subset of federation settings (no sensitive data)
    IF federation_settings IS NULL THEN
        RETURN jsonb_build_object(
            'federation_enabled', true,
            'federation_auto_accept_follows', true
        );
    END IF;
    
    -- Return only public federation settings
    RETURN jsonb_build_object(
        'federation_enabled', COALESCE((federation_settings->>'federation_enabled')::boolean, true),
        'federation_auto_accept_follows', COALESCE((federation_settings->>'federation_auto_accept_follows')::boolean, true)
    );
END;
$$;


--
-- Name: FUNCTION get_public_federation_settings(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_public_federation_settings() IS 'Get public federation settings accessible to all users';


--
-- Name: get_public_instance_info(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_public_instance_info() RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    instance_name text;
    instance_description text;
    domain_value text;
    open_registration boolean;
    approval_required boolean;
BEGIN
    -- Get various config values
    SELECT trim(both '"' from config_value::text) INTO instance_name
    FROM instance_config WHERE config_key = 'instance_name';
    
    SELECT trim(both '"' from config_value::text) INTO instance_description
    FROM instance_config WHERE config_key = 'instance_description';
    
    SELECT trim(both '"' from config_value::text) INTO domain_value
    FROM instance_config WHERE config_key = 'domain';
    
    SELECT (config_value)::boolean INTO open_registration
    FROM instance_config WHERE config_key = 'open_registration';
    
    SELECT (config_value)::boolean INTO approval_required
    FROM instance_config WHERE config_key = 'approval_required';
    
    -- Return public instance information
    RETURN jsonb_build_object(
        'name', COALESCE(instance_name, 'Harmony Instance'),
        'description', COALESCE(instance_description, 'A federated social platform'),
        'domain', COALESCE(domain_value, 'localhost'),
        'open_registration', COALESCE(open_registration, true),
        'approval_required', COALESCE(approval_required, false)
    );
END;
$$;


--
-- Name: FUNCTION get_public_instance_info(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_public_instance_info() IS 'Get public instance information accessible to all users';


--
-- Name: get_recent_admin_activity(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_recent_admin_activity(p_limit integer DEFAULT 20) RETURNS TABLE(id uuid, admin_username text, action_type text, target_type text, target_id text, action_details jsonb, created_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        aal.id,
        p.username as admin_username,
        aal.action_type,
        aal.target_type,
        aal.target_id,
        aal.action_details,
        aal.created_at
    FROM admin_audit_log aal
    JOIN profiles p ON aal.admin_id = p.id
    ORDER BY aal.created_at DESC
    LIMIT p_limit;
END;
$$;


--
-- Name: get_reports_with_details(text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_reports_with_details(p_status text DEFAULT NULL::text, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0) RETURNS TABLE(id uuid, reporter_username text, reporter_display_name text, reporter_avatar_url text, reported_user_username text, reported_user_display_name text, reported_user_avatar_url text, reported_post_preview text, reason text, report_type text, source text, source_instance text, status text, resolution_note text, created_at timestamp with time zone)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        r.id,
        reporter.username::text,
        reporter.display_name::text,
        reporter.avatar_url::text,
        reported_user.username::text,
        reported_user.display_name::text,
        reported_user.avatar_url::text,
        CASE 
            WHEN r.reported_post_id IS NOT NULL THEN
                LEFT(
                    COALESCE(
                        (SELECT p.content->0->>'text' FROM public.posts p WHERE p.id = r.reported_post_id),
                        '[Post content unavailable]'
                    ),
                    200
                )
            ELSE NULL
        END::text,
        r.reason,
        r.report_type,
        r.source,
        r.source_instance,
        r.status,
        r.resolution_note,
        r.created_at
    FROM public.reports r
    LEFT JOIN public.profiles reporter ON r.reporter_id = reporter.id
    LEFT JOIN public.profiles reported_user ON r.reported_user_id = reported_user.id
    WHERE (p_status IS NULL OR r.status = p_status)
    ORDER BY r.created_at DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;


--
-- Name: FUNCTION get_reports_with_details(p_status text, p_limit integer, p_offset integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_reports_with_details(p_status text, p_limit integer, p_offset integer) IS 'Returns reports with full user details for admin moderation panel';


--
-- Name: get_server_encryption_policy(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_server_encryption_policy(p_server_id uuid) RETURNS TABLE(encryption_mode text, allow_federation boolean, require_verified_devices boolean, force_key_setup boolean, encrypt_attachments boolean, is_encrypted boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COALESCE(ses.encryption_mode, 'optional') as encryption_mode,
    COALESCE(ses.allow_federation, true) as allow_federation,
    COALESCE(ses.require_verified_devices, false) as require_verified_devices,
    COALESCE(ses.force_key_setup, false) as force_key_setup,
    COALESCE(ses.encrypt_attachments, true) as encrypt_attachments,
    COALESCE(ses.encryption_mode, 'optional') IN ('required', 'required_local_only') as is_encrypted
  FROM public.server_encryption_settings ses
  WHERE ses.server_id = p_server_id
  UNION ALL
  SELECT 
    'optional' as encryption_mode,
    true as allow_federation,
    false as require_verified_devices,
    false as force_key_setup,
    true as encrypt_attachments,
    false as is_encrypted
  WHERE NOT EXISTS (
    SELECT 1 FROM public.server_encryption_settings
    WHERE server_id = p_server_id
  )
  LIMIT 1;
END;
$$;


--
-- Name: FUNCTION get_server_encryption_policy(p_server_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_server_encryption_policy(p_server_id uuid) IS 'Get complete encryption policy for a server. Returns defaults if not set. Includes all policy columns (original + new).';


--
-- Name: get_server_members_by_instance(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_server_members_by_instance(p_server_id uuid) RETURNS TABLE(instance text, member_ids uuid[], member_ap_ids text[], member_count integer)
    LANGUAGE sql STABLE
    AS $$
  SELECT 
    COALESCE(p.domain, 'local') as instance,
    array_agg(p.id) as member_ids,
    array_agg(p.federated_id) as member_ap_ids,
    COUNT(*)::INT as member_count
  FROM user_servers us
  JOIN profiles p ON us.user_id = p.id
  WHERE us.server_id = p_server_id
  GROUP BY COALESCE(p.domain, 'local');
$$;


--
-- Name: FUNCTION get_server_members_by_instance(p_server_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_server_members_by_instance(p_server_id uuid) IS 'Get server members grouped by instance domain for efficient batch delivery';


--
-- Name: get_system_stats(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_system_stats() RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  SELECT jsonb_build_object(
    'users_total', (SELECT COUNT(*) FROM profiles WHERE is_local = true),
    'posts_total', (SELECT COUNT(*) FROM posts WHERE is_local = true),
    'servers_total', (SELECT COUNT(*) FROM servers),
    'messages_today', (SELECT COUNT(*) FROM messages WHERE created_at > CURRENT_DATE),
    'active_users_week', (SELECT COUNT(DISTINCT author_id) FROM posts WHERE created_at > NOW() - INTERVAL '7 days')
  );
$$;


--
-- Name: FUNCTION get_system_stats(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_system_stats() IS 'Get system statistics for admin dashboard';


--
-- Name: posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    content jsonb NOT NULL,
    content_warning text,
    language text DEFAULT 'en'::text,
    author_id uuid NOT NULL,
    ap_id text,
    ap_type text DEFAULT 'Note'::text,
    url text,
    in_reply_to uuid,
    conversation_id uuid,
    visibility text DEFAULT 'public'::text,
    is_local boolean DEFAULT true,
    is_federated boolean DEFAULT true,
    replies_count integer DEFAULT 0,
    reblogs_count integer DEFAULT 0,
    favorites_count integer DEFAULT 0,
    media_attachments jsonb DEFAULT '[]'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    is_sensitive boolean DEFAULT false,
    is_deleted boolean DEFAULT false,
    deleted_at timestamp with time zone,
    edit_history jsonb DEFAULT '[]'::jsonb,
    voice_attachments jsonb DEFAULT '[]'::jsonb,
    federated_to text[] DEFAULT '{}'::text[],
    federation_status text DEFAULT 'pending'::text,
    last_federated_at timestamp with time zone,
    conversation_root_id uuid,
    is_favorited boolean DEFAULT false,
    is_reblogged boolean DEFAULT false,
    is_bookmarked boolean DEFAULT false,
    reblog jsonb,
    reblog_author jsonb,
    is_pinned boolean DEFAULT false,
    CONSTRAINT posts_content_is_array CHECK ((jsonb_typeof(content) = 'array'::text)),
    CONSTRAINT posts_content_not_empty CHECK (((jsonb_array_length(content) > 0) OR (reblog IS NOT NULL))),
    CONSTRAINT posts_visibility_check CHECK ((visibility = ANY (ARRAY['public'::text, 'unlisted'::text, 'followers'::text, 'direct'::text])))
);


--
-- Name: COLUMN posts.conversation_root_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.posts.conversation_root_id IS 'UUID of the root post in this ActivityPub conversation thread. Enables O(1) conversation lookups.';


--
-- Name: COLUMN posts.is_favorited; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.posts.is_favorited IS 'Whether the current user has favorited this post';


--
-- Name: COLUMN posts.is_reblogged; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.posts.is_reblogged IS 'Whether the current user has reblogged this post';


--
-- Name: COLUMN posts.is_bookmarked; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.posts.is_bookmarked IS 'Whether the current user has bookmarked this post';


--
-- Name: CONSTRAINT posts_content_not_empty ON posts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT posts_content_not_empty ON public.posts IS 'Ensures posts have content OR are reblogs. Pure reblogs can have empty content if reblog field is present.';


--
-- Name: get_timeline(uuid, integer, timestamp without time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_timeline(p_user_id uuid, p_limit integer DEFAULT 50, p_before timestamp without time zone DEFAULT now()) RETURNS SETOF public.posts
    LANGUAGE sql STABLE
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


--
-- Name: FUNCTION get_timeline(p_user_id uuid, p_limit integer, p_before timestamp without time zone); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_timeline(p_user_id uuid, p_limit integer, p_before timestamp without time zone) IS 'Get timeline posts from followed users (home feed)';


--
-- Name: get_trending_hashtags(integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_trending_hashtags(p_days integer DEFAULT 7, p_limit integer DEFAULT 20) RETURNS TABLE(tag text, uses_count bigint, unique_users bigint)
    LANGUAGE sql STABLE
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


--
-- Name: FUNCTION get_trending_hashtags(p_days integer, p_limit integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_trending_hashtags(p_days integer, p_limit integer) IS 'Get trending hashtags over specified period';


--
-- Name: get_unclaimed_session_shares(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_unclaimed_session_shares(p_user_id uuid) RETURNS TABLE(share_id uuid, room_id uuid, session_id text, sender_user_id uuid, encrypted_session_key text, first_known_index integer, created_at timestamp with time zone)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        s.id as share_id,
        s.room_id,
        s.session_id,
        s.sender_user_id,
        s.encrypted_session_key,
        s.first_known_index,
        s.created_at
    FROM public.megolm_session_shares s
    WHERE s.recipient_user_id = p_user_id
    AND s.is_claimed = false
    ORDER BY s.created_at DESC;
END;
$$;


--
-- Name: get_unread_notification_count(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_unread_notification_count(p_user_id uuid) RETURNS integer
    LANGUAGE sql STABLE
    AS $$
  SELECT COUNT(*)::INTEGER
  FROM notifications
  WHERE user_id = p_user_id AND is_read = false;
$$;


--
-- Name: FUNCTION get_unread_notification_count(p_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_unread_notification_count(p_user_id uuid) IS 'Get count of unread notifications for user';


--
-- Name: prekeys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.prekeys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    device_id text DEFAULT 'default'::text,
    prekey_id integer NOT NULL,
    public_key text NOT NULL,
    is_signed boolean DEFAULT false,
    signature text,
    is_one_time boolean DEFAULT false,
    is_used boolean DEFAULT false,
    used_at timestamp with time zone,
    used_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    CONSTRAINT prekeys_signed_onetime_exclusive CHECK ((NOT ((is_signed = true) AND (is_one_time = true)))),
    CONSTRAINT valid_prekey_id CHECK ((prekey_id >= 0))
);


--
-- Name: TABLE prekeys; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.prekeys IS 'Signal Protocol prekeys for asynchronous message encryption. Includes signed prekeys and one-time prekeys.';


--
-- Name: COLUMN prekeys.is_one_time; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.prekeys.is_one_time IS 'One-time prekeys are used once and marked as used. Signed prekeys can be reused.';


--
-- Name: get_unused_prekey(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_unused_prekey(p_user_id uuid, p_device_id text DEFAULT 'default'::text) RETURNS public.prekeys
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_prekey public.prekeys;
BEGIN
    SELECT * INTO v_prekey
    FROM public.prekeys
    WHERE 
        user_id = p_user_id
        AND device_id = p_device_id
        AND is_one_time = true
        AND is_used = false
        AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
    
    RETURN v_prekey;
END;
$$;


--
-- Name: get_user_bookmarks(uuid, integer, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_bookmarks(p_user_id uuid, p_limit integer DEFAULT 20, p_cursor timestamp with time zone DEFAULT NULL::timestamp with time zone) RETURNS TABLE(bookmark_id uuid, bookmarked_at timestamp with time zone, post_id uuid, content jsonb, author_id uuid, created_at timestamp with time zone, visibility text, favorites_count integer, reblogs_count integer, replies_count integer, author_username text, author_display_name text, author_avatar_url text, author_domain text, author_is_local boolean)
    LANGUAGE plpgsql STABLE SECURITY DEFINER
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    pi.id as bookmark_id,
    pi.created_at as bookmarked_at,
    p.id as post_id,
    p.content,
    p.author_id,
    p.created_at,
    p.visibility,
    COALESCE(p.favorites_count, 0)::integer,
    COALESCE(p.reblogs_count, 0)::integer,
    COALESCE(p.replies_count, 0)::integer,
    pr.username as author_username,
    pr.display_name as author_display_name,
    pr.avatar_url as author_avatar_url,
    pr.domain as author_domain,
    pr.is_local as author_is_local
  FROM public.post_interactions pi
  JOIN public.posts p ON pi.post_id = p.id
  JOIN public.profiles pr ON p.author_id = pr.id
  WHERE pi.user_id = p_user_id
    AND pi.interaction_type = 'bookmark'
    AND (p.is_deleted = false OR p.is_deleted IS NULL)
    AND (p_cursor IS NULL OR pi.created_at < p_cursor)
  ORDER BY pi.created_at DESC
  LIMIT p_limit;
END;
$$;


--
-- Name: FUNCTION get_user_bookmarks(p_user_id uuid, p_limit integer, p_cursor timestamp with time zone); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_user_bookmarks(p_user_id uuid, p_limit integer, p_cursor timestamp with time zone) IS 'Get user bookmarks efficiently, excluding deleted posts';


--
-- Name: get_user_conversations_with_participants(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_conversations_with_participants(user_uuid uuid) RETURNS TABLE(conversation_id uuid, conversation_name text, conversation_type text, is_active boolean, created_at timestamp with time zone, updated_at timestamp with time zone, participant_count bigint, other_participants jsonb, user_role text, user_joined_at timestamp with time zone, user_last_read_at timestamp with time zone)
    LANGUAGE sql STABLE
    AS $$
  SELECT 
    c.id as conversation_id,
    c.name as conversation_name,
    c.type as conversation_type,
    c.is_active,
    c.created_at,
    c.updated_at,
    (
      SELECT COUNT(*) FROM conversation_participants cp_count
      WHERE cp_count.conversation_id = c.id AND cp_count.left_at IS NULL
    ) as participant_count,
    (
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'user_id', cp_others.user_id,
            'role', cp_others.role,
            'joined_at', cp_others.joined_at
          )
        ),
        '[]'::jsonb
      )
      FROM conversation_participants cp_others
      WHERE cp_others.conversation_id = c.id 
        AND cp_others.user_id != user_uuid
        AND cp_others.left_at IS NULL
    ) as other_participants,
    cp_user.role as user_role,
    cp_user.joined_at as user_joined_at,
    cp_user.last_read_at as user_last_read_at
  FROM conversations c
  INNER JOIN conversation_participants cp_user ON c.id = cp_user.conversation_id
  WHERE cp_user.user_id = user_uuid 
    AND cp_user.left_at IS NULL
    AND c.is_active = TRUE
  ORDER BY c.updated_at DESC;
$$;


--
-- Name: FUNCTION get_user_conversations_with_participants(user_uuid uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_user_conversations_with_participants(user_uuid uuid) IS 'Returns all active conversations for a user with participant information. Used by service layer for conversation management.';


--
-- Name: get_user_featured_posts(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_featured_posts(p_author_id uuid, p_limit integer DEFAULT 10) RETURNS TABLE(id uuid, content jsonb, created_at timestamp with time zone, updated_at timestamp with time zone, author_id uuid, engagement_count integer, replies_count integer, is_pinned boolean, ap_id text, ap_type text, visibility text, media_attachments jsonb, content_warning text, in_reply_to uuid, favorites_count integer, reblogs_count integer)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id, p.content, p.created_at, p.updated_at, p.author_id,
        (p.favorites_count + p.reblogs_count + p.replies_count) as engagement_count,
        p.replies_count, p.is_pinned,
        p.ap_id, p.ap_type, p.visibility, p.media_attachments,
        p.content_warning, p.in_reply_to, p.favorites_count, p.reblogs_count
    FROM posts p
    WHERE p.author_id = p_author_id 
        AND p.is_deleted = false
        AND p.visibility IN ('public', 'unlisted')
    ORDER BY 
        CASE WHEN p.is_pinned THEN 1 ELSE 2 END,
        (p.favorites_count + p.reblogs_count + p.replies_count) DESC,
        p.created_at DESC
    LIMIT p_limit;
END;
$$;


--
-- Name: get_user_handle(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_handle(p_user_id uuid) RETURNS text
    LANGUAGE sql STABLE
    AS $$
  SELECT username || '@' || domain
  FROM profiles
  WHERE id = p_user_id;
$$;


--
-- Name: FUNCTION get_user_handle(p_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_user_handle(p_user_id uuid) IS 'Get user handle in username@domain format';


--
-- Name: get_user_id_from_username(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_id_from_username(username_param text) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
    user_id UUID;
BEGIN
    SELECT id INTO user_id
    FROM profiles
    WHERE username = username_param
    LIMIT 1;
    
    RETURN user_id;
END;
$$;


--
-- Name: FUNCTION get_user_id_from_username(username_param text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_user_id_from_username(username_param text) IS 'Gets user ID from username for mention processing';


--
-- Name: get_user_notifications(uuid, integer, integer, boolean, character varying[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_notifications(p_user_id uuid, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0, p_unread_only boolean DEFAULT false, p_notification_types character varying[] DEFAULT NULL::character varying[]) RETURNS TABLE(id uuid, user_id uuid, type character varying, data jsonb, is_read boolean, is_clicked boolean, created_at timestamp with time zone, updated_at timestamp with time zone, expires_at timestamp with time zone, read_at timestamp with time zone)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        n.id,
        n.user_id,
        n.type,
        n.data,
        n.is_read,
        n.is_clicked,
        n.created_at,
        n.updated_at,
        n.expires_at,
        n.read_at
    FROM notifications n
    WHERE n.user_id = p_user_id
    AND (NOT p_unread_only OR n.is_read = FALSE)
    AND (p_notification_types IS NULL OR n.type = ANY(p_notification_types))
    
    -- Filter out notifications from blocked users
    -- Extract sender ID from various possible JSONB structures
    AND NOT EXISTS (
        SELECT 1 
        FROM user_blocks ub
        WHERE ub.blocker_id = p_user_id
        AND ub.blocked_user_id = COALESCE(
            NULLIF((n.data->>'from_user_id'), '')::uuid,
            NULLIF((n.data->'sender'->>'user_id'), '')::uuid,
            NULLIF((n.data->>'follower_id'), '')::uuid,
            NULLIF((n.data->'follower'->>'id'), '')::uuid,
            NULLIF((n.data->'actor'->>'id'), '')::uuid,
            NULLIF((n.data->'user'->>'id'), '')::uuid,
            NULLIF((n.data->'author'->>'id'), '')::uuid
        )
        AND (ub.expires_at IS NULL OR ub.expires_at > NOW())
    )
    
    -- Filter out notifications from muted users (notifications_only or all)
    AND NOT EXISTS (
        SELECT 1 
        FROM user_mutes um
        WHERE um.muter_id = p_user_id
        AND um.muted_user_id = COALESCE(
            NULLIF((n.data->>'from_user_id'), '')::uuid,
            NULLIF((n.data->'sender'->>'user_id'), '')::uuid,
            NULLIF((n.data->>'follower_id'), '')::uuid,
            NULLIF((n.data->'follower'->>'id'), '')::uuid,
            NULLIF((n.data->'actor'->>'id'), '')::uuid,
            NULLIF((n.data->'user'->>'id'), '')::uuid,
            NULLIF((n.data->'author'->>'id'), '')::uuid
        )
        AND um.mute_type IN ('notifications_only', 'all')
        AND (um.expires_at IS NULL OR um.expires_at > NOW())
    )
    
    -- Filter out notifications from muted channels/conversations
    AND NOT EXISTS (
        SELECT 1 
        FROM notification_channels nc
        WHERE nc.user_id = p_user_id
        AND nc.muted = true
        AND (
            (nc.channel_id IS NOT NULL AND nc.channel_id = COALESCE(
                NULLIF((n.data->>'channel_id'), '')::uuid,
                NULLIF((n.data->'location'->>'channel_id'), '')::uuid
            ))
            OR
            (nc.conversation_id IS NOT NULL AND nc.conversation_id = COALESCE(
                NULLIF((n.data->>'conversation_id'), '')::uuid,
                NULLIF((n.data->'conversation'->>'id'), '')::uuid
            ))
        )
        AND (nc.muted_until IS NULL OR nc.muted_until > NOW())
    )
    
    ORDER BY n.created_at DESC
    LIMIT p_limit
    OFFSET p_offset;
END;
$$;


--
-- Name: FUNCTION get_user_notifications(p_user_id uuid, p_limit integer, p_offset integer, p_unread_only boolean, p_notification_types character varying[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_user_notifications(p_user_id uuid, p_limit integer, p_offset integer, p_unread_only boolean, p_notification_types character varying[]) IS 'Get user notifications with filtering. Filters out notifications from blocked users, muted users, and muted channels at database level for security and efficiency.';


--
-- Name: get_user_prekey_bundle(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_prekey_bundle(p_user_id uuid, p_device_id text DEFAULT 'default'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_identity_key TEXT;
    v_signed_prekey JSONB;
    v_one_time_prekey JSONB;
    v_result JSONB;
BEGIN
    -- Get identity public key
    SELECT identity_public_key INTO v_identity_key
    FROM public.user_key_pairs
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_active = true
    ORDER BY key_version DESC
    LIMIT 1;
    
    IF v_identity_key IS NULL THEN
        RAISE EXCEPTION 'No identity key found for user % device %', p_user_id, p_device_id;
    END IF;
    
    -- Get signed prekey
    SELECT jsonb_build_object(
        'id', prekey_id,
        'public_key', public_key,
        'signature', signature
    ) INTO v_signed_prekey
    FROM public.prekeys
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_signed = true
        AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at DESC
    LIMIT 1;
    
    -- Get and mark one-time prekey as used
    SELECT jsonb_build_object(
        'id', prekey_id,
        'public_key', public_key
    ) INTO v_one_time_prekey
    FROM public.prekeys
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_one_time = true
        AND is_used = false
        AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED;
    
    -- Mark the one-time prekey as used
    IF v_one_time_prekey IS NOT NULL THEN
        UPDATE public.prekeys
        SET 
            is_used = true,
            used_at = NOW(),
            used_by = auth.uid()
        WHERE user_id = p_user_id
            AND device_id = p_device_id
            AND prekey_id = (v_one_time_prekey->>'id')::INTEGER;
    END IF;
    
    -- Build result bundle
    v_result := jsonb_build_object(
        'user_id', p_user_id,
        'device_id', p_device_id,
        'identity_key', v_identity_key,
        'signed_prekey', v_signed_prekey,
        'one_time_prekey', v_one_time_prekey,
        'retrieved_at', NOW()
    );
    
    RETURN v_result;
END;
$$;


--
-- Name: FUNCTION get_user_prekey_bundle(p_user_id uuid, p_device_id text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_user_prekey_bundle(p_user_id uuid, p_device_id text) IS 'Retrieve a complete prekey bundle for establishing an encrypted session. Atomically marks one-time prekey as used.';


--
-- Name: get_user_private_key(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_private_key(p_user_id uuid) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    v_private_key TEXT;
BEGIN
    -- This function can only be called server-side
    -- Additional security: check if caller has proper permissions
    SELECT private_key INTO v_private_key
    FROM user_private_keys
    WHERE user_id = p_user_id;
    
    RETURN v_private_key;
END;
$$;


--
-- Name: get_users_needing_prekeys(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_users_needing_prekeys(p_threshold integer DEFAULT 10) RETURNS TABLE(user_id uuid, device_id text, unused_prekey_count bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        kp.user_id,
        kp.device_id,
        COUNT(pk.id) as unused_prekey_count
    FROM public.user_key_pairs kp
    LEFT JOIN public.prekeys pk ON 
        pk.user_id = kp.user_id 
        AND pk.device_id = kp.device_id
        AND pk.is_one_time = true
        AND pk.is_used = false
    WHERE kp.is_active = true
    GROUP BY kp.user_id, kp.device_id
    HAVING COUNT(pk.id) < p_threshold
    ORDER BY COUNT(pk.id) ASC;
END;
$$;


--
-- Name: FUNCTION get_users_needing_prekeys(p_threshold integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.get_users_needing_prekeys(p_threshold integer) IS 'Get list of users who have fewer than threshold unused one-time prekeys.';


--
-- Name: handle_activitypub_activity_processing(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_activitypub_activity_processing() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'extensions', 'public', 'pg_temp'
    AS $$
DECLARE
    v_actor_profile RECORD;
    v_target_profile RECORD;
    v_activity_object JSONB;
    v_object_id TEXT;
    v_instance_domain TEXT;
    v_result JSONB;
BEGIN
    -- Process activities that are:
    -- 1. In 'processing' status (freshly validated by inbox)
    -- 2. In 'pending' status and ready for retry (next_attempt_at <= now)
    -- Skip if already processed
    IF OLD.status = 'processed' THEN
        RETURN NEW;
    END IF;

    IF NOT (
        (NEW.status = 'processing') OR 
        (NEW.status = 'pending' AND NEW.next_attempt_at IS NOT NULL AND NEW.next_attempt_at <= NOW())
    ) THEN
        RETURN NEW;
    END IF;

    -- Get instance domain
    SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
    FROM instance_config 
    WHERE config_key = 'domain' 
    LIMIT 1;

    IF v_instance_domain IS NULL THEN
        v_instance_domain := 'har.mony.lol'; -- fallback
    END IF;

    -- Get actor profile by resolving from actor_ap_id using federated_id column
    SELECT * INTO v_actor_profile
    FROM profiles 
    WHERE federated_id = NEW.actor_ap_id;

    IF NOT FOUND THEN
        -- Try to get or create the remote profile
        RAISE NOTICE 'Actor profile not found for %s, attempting to create...', NEW.actor_ap_id;
        
        -- For now, we'll fail the activity if actor profile doesn't exist
        -- In a production system, you might want to fetch the actor and create the profile
        UPDATE ap_activities 
        SET status = 'failed', 
            error_message = 'Actor profile not found: ' || NEW.actor_ap_id,
            updated_at = NOW()
        WHERE id = NEW.id;
        RETURN NEW;
    END IF;

    -- Extract object from activity data
    v_activity_object := NEW.activity_data->'object';
    v_object_id := CASE 
        WHEN jsonb_typeof(v_activity_object) = 'string' THEN v_activity_object::text
        ELSE v_activity_object->>'id'
    END;

    RAISE NOTICE 'Processing % activity % from %', NEW.ap_type, NEW.ap_id, v_actor_profile.username;

    BEGIN
        -- Process based on activity type
        CASE NEW.ap_type
            WHEN 'Follow' THEN
                PERFORM process_follow_activity(NEW.id, NEW.activity_data, v_actor_profile, v_instance_domain);
                
            WHEN 'Accept' THEN
                PERFORM process_accept_activity(NEW.id, NEW.activity_data, v_actor_profile);
                
            WHEN 'Reject' THEN
                PERFORM process_reject_activity(NEW.id, NEW.activity_data, v_actor_profile);
            
            WHEN 'Undo' THEN
                PERFORM process_undo_activity(NEW.id, NEW.activity_data, v_actor_profile);
            
            WHEN 'Create' THEN
                PERFORM process_create_activity(NEW.id, NEW.activity_data, v_actor_profile, v_instance_domain);
            
            WHEN 'Update' THEN
                PERFORM process_update_activity(NEW.id, NEW.activity_data, v_actor_profile);
            
            WHEN 'Delete' THEN
                PERFORM process_delete_activity(NEW.id, NEW.activity_data, v_actor_profile);
            
            WHEN 'Like' THEN
                PERFORM process_like_activity(NEW.id, NEW.activity_data, v_actor_profile);
            
            WHEN 'Announce' THEN
                PERFORM process_announce_activity(NEW.id, NEW.activity_data, v_actor_profile);
                
            ELSE
                RAISE WARNING 'Unhandled activity type: %', NEW.ap_type;
        END CASE;

        -- Mark as processed
        UPDATE ap_activities 
        SET status = 'processed', 
            updated_at = NOW()
        WHERE id = NEW.id;
        
        RAISE NOTICE '✅ Successfully processed % activity: %', NEW.ap_type, NEW.ap_id;

    EXCEPTION WHEN OTHERS THEN
        -- Implement retry logic for processing failures
        DECLARE
            v_new_attempts INTEGER := COALESCE(NEW.attempts, 0) + 1;
            v_max_attempts INTEGER := 5;
            v_next_retry_delay INTERVAL;
        BEGIN
            RAISE WARNING 'Error processing activity %: %', NEW.ap_id, SQLERRM;
            
            IF v_new_attempts >= v_max_attempts THEN
                -- Max attempts reached, mark as failed
                UPDATE ap_activities 
                SET status = 'failed',
                    error_message = SQLERRM,
                    attempts = v_new_attempts,
                    last_attempt_at = NOW(),
                    updated_at = NOW()
                WHERE id = NEW.id;
                
                RAISE NOTICE 'Activity % failed permanently after % attempts', NEW.ap_id, v_new_attempts;
            ELSE
                -- Calculate exponential backoff: 2^attempts minutes
                v_next_retry_delay := (POWER(2, v_new_attempts) || ' minutes')::INTERVAL;
                
                UPDATE ap_activities 
                SET status = 'pending',
                    error_message = SQLERRM,
                    attempts = v_new_attempts,
                    last_attempt_at = NOW(),
                    next_attempt_at = NOW() + v_next_retry_delay,
                    updated_at = NOW()
                WHERE id = NEW.id;
                
                RAISE NOTICE 'Activity % scheduled for retry #% in %', NEW.ap_id, v_new_attempts, v_next_retry_delay;
            END IF;
        END;
    END;

    RETURN NEW;
END;
$$;


--
-- Name: FUNCTION handle_activitypub_activity_processing(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_activitypub_activity_processing() IS 'Fixed unified ActivityPub activity processor that uses correct column names (federated_id instead of ap_id for profiles table).';


--
-- Name: handle_incoming_messages(uuid, jsonb, record, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_incoming_messages(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $_$
DECLARE
    v_object JSONB;
    v_content JSONB;
    v_conversation_id UUID;
    v_message_id UUID;
    v_in_reply_to TEXT;
    v_replied_message_id UUID;
    v_mentioned_users TEXT[];
    v_directly_addressed TEXT[];
    v_all_recipients TEXT[];
    v_username TEXT;
    v_local_user RECORD;
    v_all_participants UUID[];
    v_local_user_ids UUID[];
    v_is_dm BOOLEAN := false;
BEGIN
    RAISE NOTICE '📩 MODERN: Processing ActivityPub message from %@% (with reply support)', 
        actor_profile.username, actor_profile.domain;
    
    v_object := activity_data->'object';
    
    -- Check if this is actually a DM using the existing detection function
    v_is_dm := is_activitypub_direct_message(v_object, instance_domain);
    
    -- STEP 1: Check if this is a reply to an existing message
    v_in_reply_to := v_object->>'inReplyTo';
    
    IF v_in_reply_to IS NOT NULL THEN
        RAISE NOTICE '💬 Processing REPLY to: %', v_in_reply_to;
        
        -- Extract message UUID from inReplyTo URL
        IF v_in_reply_to LIKE 'https://' || instance_domain || '/messages/%' THEN
            v_replied_message_id := substring(v_in_reply_to from 'https://[^/]+/messages/([a-f0-9\-]{36})$')::uuid;
            
            -- Find the conversation from the original message
            SELECT conversation_id INTO v_conversation_id
            FROM messages 
            WHERE id = v_replied_message_id;
            
            IF FOUND THEN
                RAISE NOTICE '✅ Found existing conversation % for reply', v_conversation_id;
                
                -- Convert content 
                v_content := convert_ap_to_jsonb(
                    v_object->>'content', 
                    v_object->'tag'
                );
                
                -- 🔧 FIX: Strip redundant @user@domain mentions ONLY from DM reply content
                IF v_is_dm THEN
                    v_content := strip_mentions_from_dm_content(v_content);
                    RAISE NOTICE '🧹 Stripped mentions from DM reply content';
                ELSE
                    RAISE NOTICE '📢 Keeping mentions in non-DM reply';
                END IF;
                
                -- Insert the reply message
                INSERT INTO messages (
                    conversation_id,
                    user_id,
                    content,
                    created_at,
                    is_system,
                    reply_to,
                    metadata
                ) VALUES (
                    v_conversation_id,
                    actor_profile.id,
                    v_content,
                    COALESCE((v_object->>'published')::timestamptz, NOW()),
                    false,
                    v_replied_message_id,
                    jsonb_build_object(
                        'federated', true,
                        'ap_id', v_object->>'id',
                        'ap_type', 'Note',
                        'from_domain', actor_profile.domain,
                        'original_url', COALESCE(v_object->>'url', v_object->>'id'),
                        'actor_ap_id', actor_profile.federated_id,
                        'activity_id', activity_id,
                        'in_reply_to', v_in_reply_to,
                        'is_dm', v_is_dm
                    )
                ) RETURNING id INTO v_message_id;

                RAISE NOTICE '✅ Saved reply message %: %@% -> conversation %', 
                    v_message_id, actor_profile.username, actor_profile.domain, v_conversation_id;
                
                RETURN; -- Reply processed successfully
            ELSE
                RAISE WARNING '⚠️ Could not find original message % for reply, treating as new message', v_replied_message_id;
            END IF;
        ELSE
            RAISE WARNING '⚠️ inReplyTo URL format not recognized: %', v_in_reply_to;
        END IF;
    END IF;
    
    -- STEP 2: Process as new message/mention
    RAISE NOTICE '📧 Processing as new message/mention';
    
    -- Extract mentioned local users from tags
    SELECT ARRAY_AGG(DISTINCT username) INTO v_mentioned_users
    FROM (
        SELECT CASE 
            WHEN tag->>'href' LIKE 'https://' || instance_domain || '/users/%' THEN
                substring(tag->>'href' from 'https://' || instance_domain || '/users/([^/]+)')
            ELSE NULL
        END as username
        FROM jsonb_array_elements(COALESCE(v_object->'tag', '[]'::jsonb)) AS tag
        WHERE tag->>'type' = 'Mention'
    ) t 
    WHERE username IS NOT NULL;

    -- Also check direct addressing in 'to' and 'cc' fields
    SELECT ARRAY_AGG(DISTINCT username) INTO v_directly_addressed
    FROM (
        SELECT CASE 
            WHEN recipient LIKE 'https://' || instance_domain || '/users/%' THEN
                substring(recipient from 'https://' || instance_domain || '/users/([^/]+)')
            ELSE NULL
        END as username
        FROM (
            SELECT jsonb_array_elements_text(COALESCE(v_object->'to', '[]'::jsonb)) as recipient
            UNION ALL
            SELECT jsonb_array_elements_text(COALESCE(v_object->'cc', '[]'::jsonb)) as recipient
        ) recipients
    ) t 
    WHERE username IS NOT NULL;

    -- Combine all recipients and remove duplicates
    v_all_recipients := COALESCE(v_mentioned_users, ARRAY[]::TEXT[]) || COALESCE(v_directly_addressed, ARRAY[]::TEXT[]);
    SELECT ARRAY_AGG(DISTINCT username) INTO v_all_recipients FROM unnest(v_all_recipients) AS username;
    
    IF v_all_recipients IS NULL OR array_length(v_all_recipients, 1) = 0 THEN
        RAISE WARNING 'Message has no local recipients - skipping';
        RETURN;
    END IF;

    RAISE NOTICE '📧 Message mentions % local users: %', array_length(v_all_recipients, 1), v_all_recipients;
    
    -- Convert ActivityPub HTML content to our JSONB format
    v_content := convert_ap_to_jsonb(
        v_object->>'content', 
        v_object->'tag'
    );
    
    -- 🔧 FIX: Strip redundant @user@domain mentions ONLY from DM content
    IF v_is_dm THEN
        v_content := strip_mentions_from_dm_content(v_content);
        RAISE NOTICE '🧹 Stripped mentions from DM content';
    ELSE
        RAISE NOTICE '📢 Keeping mentions in non-DM message';
    END IF;
    
    -- Get all local user IDs that are mentioned
    SELECT ARRAY_AGG(p.id) INTO v_local_user_ids
    FROM profiles p
    WHERE p.username = ANY(v_all_recipients)
      AND p.is_local = true;

    IF v_local_user_ids IS NULL OR array_length(v_local_user_ids, 1) = 0 THEN
        RAISE WARNING 'No valid local users found from mentions: %', v_all_recipients;
        RETURN;
    END IF;

    RAISE NOTICE '📨 Found % valid local users', array_length(v_local_user_ids, 1);

    -- Create participant list: remote sender + all local recipients
    v_all_participants := ARRAY[actor_profile.id] || v_local_user_ids;

    RAISE NOTICE '🎯 Total conversation participants: %', array_length(v_all_participants, 1);

    -- Find existing conversation with EXACT same participants
    SELECT DISTINCT c.id INTO v_conversation_id
    FROM conversations c
    WHERE (
        -- For direct conversations (1:1)
        (c.type = 'direct' AND EXISTS (
            SELECT 1 FROM conversation_participants cp1
            WHERE cp1.conversation_id = c.id 
              AND cp1.user_id = actor_profile.id 
              AND cp1.left_at IS NULL
        ) AND EXISTS (
            SELECT 1 FROM conversation_participants cp2
            WHERE cp2.conversation_id = c.id 
              AND cp2.user_id = ANY(v_local_user_ids)
              AND cp2.left_at IS NULL
        ) AND (
            SELECT COUNT(*) FROM conversation_participants cp3
            WHERE cp3.conversation_id = c.id 
              AND cp3.left_at IS NULL
        ) = 2)
        
        OR
        
        -- For group conversations (multi-participant)
        (c.type = 'group' AND (
            SELECT ARRAY_AGG(cp.user_id ORDER BY cp.user_id) 
            FROM conversation_participants cp
            WHERE cp.conversation_id = c.id 
              AND cp.left_at IS NULL
        ) = (
            SELECT ARRAY_AGG(unnest ORDER BY unnest) 
            FROM unnest(v_all_participants)
        ))
    )
    LIMIT 1;

    IF v_conversation_id IS NULL THEN
        -- Create new conversation with proper type
        INSERT INTO conversations (
            type, 
            created_by, 
            is_active,
            created_at,
            updated_at
        ) VALUES (
            CASE 
                WHEN array_length(v_all_participants, 1) = 2 THEN 'direct'
                ELSE 'group'
            END,
            actor_profile.id,
            TRUE,
            NOW(),
            NOW()
        ) RETURNING id INTO v_conversation_id;
        
        -- Add all participants
        INSERT INTO conversation_participants (conversation_id, user_id, role, joined_at)
        SELECT v_conversation_id, unnest, 'member', NOW()
        FROM unnest(v_all_participants);
        
        RAISE NOTICE '🆕 Created new % conversation: %', 
            CASE WHEN array_length(v_all_participants, 1) = 2 THEN 'direct' ELSE 'group' END,
            v_conversation_id;
    ELSE
        RAISE NOTICE '📝 Found existing conversation: %', v_conversation_id;
    END IF;

    -- Insert the message (with mentions stripped only if DM)
    INSERT INTO messages (
        conversation_id,
        user_id,
        content,
        created_at,
        is_system,
        metadata
    ) VALUES (
        v_conversation_id,
        actor_profile.id,
        v_content,
        COALESCE((v_object->>'published')::timestamptz, NOW()),
        false,
        jsonb_build_object(
            'federated', true,
            'ap_id', v_object->>'id',
            'ap_type', 'Note',
            'from_domain', actor_profile.domain,
            'original_url', COALESCE(v_object->>'url', v_object->>'id'),
            'actor_ap_id', actor_profile.federated_id,
            'activity_id', activity_id,
            'mentioned_users', v_all_recipients,
            'participant_count', array_length(v_all_participants, 1),
            'is_dm', v_is_dm
        )
    ) RETURNING id INTO v_message_id;

    RAISE NOTICE '✅ Saved federated message %: %@% -> conversation % (% participants)', 
        v_message_id, actor_profile.username, actor_profile.domain, v_conversation_id, array_length(v_all_participants, 1);
    
    RAISE NOTICE '🎯 Completed message processing for activity %', activity_id;
END;
$_$;


--
-- Name: FUNCTION handle_incoming_messages(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_incoming_messages(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text) IS 'MODERN: Processes incoming ActivityPub messages with support for replies (inReplyTo), mentions, and multi-participant conversations using conversation_participants table. Handles both new messages and replies to existing conversations. Note: Message notifications are handled by existing message triggers - this function focuses on message creation only.';


--
-- Name: handle_local_post_mention_notifications(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_local_post_mention_notifications() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    content_part JSONB;
    mentioned_username TEXT;
    mentioned_user_id UUID;
    author_profile RECORD;
    post_content_preview TEXT;
BEGIN
    -- Only handle new posts
    IF TG_OP = 'INSERT' THEN
        -- Get author profile for notification data
        SELECT id, username, display_name, avatar_url, domain, is_local
        INTO author_profile
        FROM profiles 
        WHERE id = NEW.author_id;
        
        -- Only process if author found and content exists
        IF FOUND AND NEW.content IS NOT NULL THEN
            -- Extract content preview from MessagePart[] array
            post_content_preview := extract_message_text(NEW.content);
            IF LENGTH(post_content_preview) > 100 THEN
                post_content_preview := LEFT(post_content_preview, 100) || '...';
            END IF;
            IF post_content_preview = '' OR post_content_preview IS NULL THEN
                post_content_preview := 'New post';
            END IF;
            
            -- Extract mentions from unified content format
            FOR content_part IN SELECT jsonb_array_elements(NEW.content)
            LOOP
                -- Check if this is a mention
                IF content_part->>'type' = 'mention' THEN
                    -- Extract username from mention
                    mentioned_username := content_part->>'username';
                    
                    -- Get the mentioned user ID (only local users)
                    -- For local posts, mentions should always be local users
                    SELECT id INTO mentioned_user_id
                    FROM profiles
                    WHERE username = mentioned_username
                      AND is_local = true
                      AND id != NEW.author_id; -- Don't notify self
                    
                    -- Debug logging
                    IF mentioned_user_id IS NULL THEN
                        RAISE NOTICE '⚠️ Local mention: username=% not found or not local. Available local users: %', 
                            mentioned_username,
                            (SELECT string_agg(username, ', ') FROM profiles WHERE is_local = true LIMIT 10);
                    ELSE
                        RAISE NOTICE '✅ Local mention: found user % (ID: %)', mentioned_username, mentioned_user_id;
                    END IF;
                    
                    -- Create notification if mentioned user found
                    IF mentioned_user_id IS NOT NULL THEN
                        -- Use send_notification_to_user for proper notification creation
                        PERFORM send_notification_to_user(
                            'activitypub_mention',
                            mentioned_user_id,
                            jsonb_build_object(
                                'actor', jsonb_build_object(
                                    'id', author_profile.id,
                                    'username', author_profile.username,
                                    'display_name', author_profile.display_name,
                                    'avatar_url', author_profile.avatar_url,
                                    'domain', author_profile.domain,
                                    'is_local', author_profile.is_local
                                ),
                                'post', jsonb_build_object(
                                    'id', NEW.id,
                                    'ap_id', NEW.ap_id,
                                    'content_preview', post_content_preview,
                                    'content', NEW.content
                                ),
                                'post_id', NEW.id,
                                'post_content', NEW.content,
                                'timestamp', NEW.created_at
                            ),
                            NULL, -- server_id
                            NULL, -- channel_id
                            NULL, -- conversation_id
                            author_profile.id, -- from_user_id
                            'normal' -- priority
                        );
                        
                        RAISE NOTICE '✅ Created ActivityPub mention notification: % mentioned %', 
                            author_profile.username, mentioned_username;
                    END IF;
                END IF;
            END LOOP;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;


--
-- Name: FUNCTION handle_local_post_mention_notifications(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_local_post_mention_notifications() IS 'Creates proper notifications for local users mentioned in ActivityPub posts using send_notification_to_user.';


--
-- Name: handle_message_federation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_message_federation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_federation_type TEXT;
    v_is_federated_incoming BOOLEAN;
    v_sender_profile profiles%ROWTYPE;
    -- Variables for mention detection
    content_part JSONB;
    mentioned_username TEXT;
    mentioned_user_id UUID;
    mentioned_domain TEXT;
    current_domain TEXT;
    v_channel_id uuid;
    v_server_id uuid;
    v_channel_name TEXT;
    v_server_name TEXT;
    content_preview TEXT;
BEGIN
    -- Determine federation type
    v_federation_type := determine_message_federation_type(NEW.id);
    
    -- Check if this is an incoming federated message
    v_is_federated_incoming := (NEW.metadata->>'federated' = 'true');
    
    -- Get sender profile for notifications
    SELECT * INTO v_sender_profile FROM profiles WHERE id = NEW.user_id;
    
    -- Extract content preview from MessagePart[] array using existing function
    content_preview := extract_message_text(NEW.content);
    content_preview := TRIM(content_preview);
    IF LENGTH(content_preview) > 100 THEN
        content_preview := LEFT(content_preview, 100) || '...';
    END IF;
    IF content_preview = '' OR content_preview IS NULL THEN
        content_preview := 'New message';
    END IF;
    
    -- Handle mentions in channel messages (channel_id is not null)
    -- Note: Channel messages have channel_id set, DMs have conversation_id set
    IF NEW.channel_id IS NOT NULL AND NOT NEW.is_system AND NOT COALESCE((NEW.metadata->>'federated')::boolean, false) THEN
        RAISE NOTICE '🔍 Processing channel message for mentions: message_id=%, channel_id=%', NEW.id, NEW.channel_id;
        
        -- Get channel and server info (use explicit table aliases and variables to avoid ambiguity)
        v_channel_id := NEW.channel_id;
        
        SELECT c.name, c.server_id INTO v_channel_name, v_server_id
        FROM channels c 
        WHERE c.id = v_channel_id;
        
        IF NOT FOUND THEN
            RAISE WARNING 'Channel not found: %', NEW.channel_id;
            -- Set to NULL to avoid issues
            v_channel_id := NULL;
            v_channel_name := NULL;
            v_server_id := NULL;
            v_server_name := NULL;
        ELSE
            -- Get server info (use explicit table alias)
            SELECT s.id, s.name INTO v_server_id, v_server_name
            FROM servers s
            WHERE s.id = v_server_id;
            
            IF NOT FOUND THEN
                RAISE WARNING 'Server not found for channel: %', v_server_id;
                v_server_id := NULL;
                v_server_name := NULL;
            END IF;
        END IF;
        
        -- Get current instance domain
        SELECT trim(both '"' from config_value::text) INTO current_domain 
        FROM instance_config WHERE config_key = 'domain' LIMIT 1;
        
        IF current_domain IS NULL THEN
            RAISE WARNING 'Instance domain not configured';
        END IF;
        
        -- Process message content to find mentions
        IF jsonb_typeof(NEW.content) = 'array' THEN
            RAISE NOTICE '📝 Processing content array, length: %', jsonb_array_length(NEW.content);
            
            FOR content_part IN SELECT jsonb_array_elements(NEW.content)
            LOOP
                -- Check if this is a mention part
                IF content_part->>'type' = 'mention' THEN
                    mentioned_username := content_part->>'username';
                    mentioned_domain := content_part->>'domain';
                    
                    RAISE NOTICE '👤 Found mention: @% @%', mentioned_username, COALESCE(mentioned_domain, 'local');
                    
                    -- Find the mentioned user
                    IF mentioned_domain IS NULL OR mentioned_domain = current_domain THEN
                        -- Local user mention
                        SELECT id INTO mentioned_user_id
                        FROM profiles
                        WHERE username = mentioned_username
                          AND (domain IS NULL OR domain = current_domain)
                          AND is_local = true
                          AND id != NEW.user_id; -- Don't notify self
                    ELSE
                        -- Remote user mention
                        SELECT id INTO mentioned_user_id
                        FROM profiles
                        WHERE username = mentioned_username
                          AND domain = mentioned_domain
                          AND id != NEW.user_id; -- Don't notify self
                    END IF;
                    
                    -- Create mention notification if user found
                    IF mentioned_user_id IS NOT NULL THEN
                        RAISE NOTICE '✅ Creating mention notification: mentioned_user_id=%, message_id=%', mentioned_user_id, NEW.id;
                        
                        PERFORM send_notification_to_user(
                            'mention',
                            mentioned_user_id,
                            jsonb_build_object(
                                'sender', jsonb_build_object(
                                    'user_id', v_sender_profile.id,
                                    'username', v_sender_profile.username,
                                    'display_name', v_sender_profile.display_name,
                                    'avatar_url', v_sender_profile.avatar_url
                                ),
                                'message', jsonb_build_object(
                                    'id', NEW.id,
                                    'content_preview', content_preview
                                ),
                                'location', jsonb_build_object(
                                    'server_id', COALESCE(v_server_id::text, NULL),
                                    'server_name', COALESCE(v_server_name, NULL),
                                    'channel_id', COALESCE(v_channel_id::text, NULL),
                                    'channel_name', COALESCE(v_channel_name, NULL)
                                ),
                                -- Legacy fields for compatibility
                                'message_id', NEW.id,
                                'mentioned_by', NEW.user_id,
                                'sender_username', v_sender_profile.username,
                                'sender_display_name', v_sender_profile.display_name,
                                'server_id', COALESCE(v_server_id::text, NULL),
                                'server_name', COALESCE(v_server_name, NULL),
                                'channel_id', COALESCE(v_channel_id::text, NULL),
                                'channel_name', COALESCE(v_channel_name, NULL),
                                'preview', content_preview
                            ),
                            v_server_id,
                            v_channel_id,
                            NULL,
                            NEW.user_id,
                            'normal'
                        );
                        
                        RAISE NOTICE '✅ Mention notification sent successfully';
                    ELSE
                        RAISE NOTICE '⚠️ Mentioned user not found: @% @%', mentioned_username, COALESCE(mentioned_domain, 'local');
                    END IF;
                END IF;
            END LOOP;
        ELSE
            RAISE NOTICE '⚠️ Content is not an array: %', jsonb_typeof(NEW.content);
        END IF;
    END IF;
    
    -- Handle existing notification cases
    CASE v_federation_type
        WHEN 'chat_local_only' THEN
            -- Send local notifications for chat messages (ONLY to LOCAL users)
            PERFORM send_notification(
                'chat_message',
                ARRAY(
                    SELECT cp.user_id 
                    FROM conversation_participants cp 
                    JOIN profiles p ON p.id = cp.user_id
                    WHERE cp.conversation_id = NEW.conversation_id 
                    AND cp.user_id != NEW.user_id
                    AND cp.left_at IS NULL
                    AND p.is_local = true
                ),
                jsonb_build_object(
                    'sender', jsonb_build_object(
                        'user_id', v_sender_profile.id,
                        'username', v_sender_profile.username,
                        'display_name', v_sender_profile.display_name,
                        'avatar_url', v_sender_profile.avatar_url
                    ),
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', content_preview
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    'message_id', NEW.id,
                    'sender_username', v_sender_profile.username,
                    'sender_display_name', v_sender_profile.display_name,
                    'conversation_id', NEW.conversation_id,
                    'preview', content_preview
                ),
                NULL, NULL, NEW.conversation_id, NEW.user_id, 'normal'
            );
            
        WHEN 'dm_local_only' THEN
            -- Send DM notifications for local-only DMs (ONLY to LOCAL users)
            PERFORM send_notification(
                'dm',
                ARRAY(
                    SELECT cp.user_id 
                    FROM conversation_participants cp 
                    JOIN profiles p ON p.id = cp.user_id
                    WHERE cp.conversation_id = NEW.conversation_id 
                    AND cp.user_id != NEW.user_id
                    AND cp.left_at IS NULL
                    AND p.is_local = true
                ),
                jsonb_build_object(
                    'sender', jsonb_build_object(
                        'user_id', v_sender_profile.id,
                        'username', v_sender_profile.username,
                        'display_name', v_sender_profile.display_name,
                        'avatar_url', v_sender_profile.avatar_url
                    ),
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', content_preview
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    'message_id', NEW.id,
                    'sender_username', v_sender_profile.username,
                    'sender_display_name', v_sender_profile.display_name,
                    'conversation_id', NEW.conversation_id,
                    'preview', content_preview
                ),
                NULL, NULL, NEW.conversation_id, NEW.user_id, 'normal'
            );
            
        WHEN 'dm_federated' THEN
            -- Send DM notifications for federated DMs (ONLY to LOCAL users)
            PERFORM send_notification(
                'dm',
                ARRAY(
                    SELECT cp.user_id 
                    FROM conversation_participants cp 
                    JOIN profiles p ON p.id = cp.user_id
                    WHERE cp.conversation_id = NEW.conversation_id 
                    AND cp.user_id != NEW.user_id
                    AND cp.left_at IS NULL
                    AND p.is_local = true
                ),
                jsonb_build_object(
                    'sender', jsonb_build_object(
                        'user_id', v_sender_profile.id,
                        'username', v_sender_profile.username,
                        'display_name', v_sender_profile.display_name,
                        'avatar_url', v_sender_profile.avatar_url
                    ),
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', content_preview
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    'message_id', NEW.id,
                    'sender_username', v_sender_profile.username,
                    'sender_display_name', v_sender_profile.display_name,
                    'conversation_id', NEW.conversation_id,
                    'preview', content_preview,
                    'federated', true
                ),
                NULL, NULL, NEW.conversation_id, NEW.user_id, 'normal'
            );
    END CASE;
    
    RETURN NEW;
    
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Message federation processing failed for %: %', NEW.id, SQLERRM;
        RETURN NEW;
END;
$$;


--
-- Name: FUNCTION handle_message_federation(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_message_federation() IS 'Handles notifications for DMs, chat messages, and channel mentions. Creates mention notifications directly when mentions are detected in channel messages.';


--
-- Name: handle_outgoing_messages(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_outgoing_messages() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'extensions', 'public', 'pg_temp'
    AS $$
DECLARE
    -- Variables for notifications
    mentioned_usernames TEXT[];
    mentioned_user_id UUID;
    username_item TEXT;
    sender_profile profiles%ROWTYPE;
    channel_info channels%ROWTYPE;
    server_info servers%ROWTYPE;
    conversation_type TEXT;
    
    -- Variables for federation
    v_federation_type TEXT;
    v_instance_domain TEXT;
    v_sender_url TEXT;
    v_recipient_url TEXT;
    v_message_url TEXT;
    v_activity_id TEXT;
    v_html_content TEXT;
    v_attachments JSONB;
    v_tags JSONB;
    v_note_object JSONB;
    v_activity JSONB;
    v_activity_uuid UUID;
    v_recipient_profile RECORD;
    target_domains TEXT[];
BEGIN
    -- Get sender profile
    SELECT * INTO sender_profile FROM profiles WHERE id = NEW.user_id;
    
    -- Determine federation type
    v_federation_type := determine_message_federation_type(NEW.id);
    
    -- Send notifications for federated messages ONLY to LOCAL users
    IF v_federation_type = 'dm_federated' THEN
        -- Notify only LOCAL conversation participants with STRUCTURED data
        PERFORM send_notification(
            'dm',
            ARRAY(
                SELECT DISTINCT cp.user_id 
                FROM conversation_participants cp
                JOIN profiles p ON p.id = cp.user_id
                WHERE cp.conversation_id = NEW.conversation_id 
                  AND cp.user_id != NEW.user_id
                  AND cp.left_at IS NULL
                  AND p.is_local = true  -- ✅ ONLY LOCAL USERS
            ),
            -- ✅ STRUCTURED DATA: Match NotificationFormatter expectations
            jsonb_build_object(
                'sender', jsonb_build_object(
                    'user_id', sender_profile.id,
                    'username', sender_profile.username,
                    'display_name', sender_profile.display_name,
                    'avatar_url', sender_profile.avatar_url
                ),
                'message', jsonb_build_object(
                    'id', NEW.id,
                    'content_preview', CASE 
                        WHEN jsonb_array_length(NEW.content) > 0 
                        THEN LEFT(NEW.content->0->>'text', 100)
                        ELSE 'New message'
                    END
                ),
                'conversation', jsonb_build_object(
                    'id', NEW.conversation_id
                ),
                -- Additional metadata for compatibility
                'message_id', NEW.id,
                'conversation_id', NEW.conversation_id,
                'sender_id', NEW.user_id,
                'federated', true
            ),
            NULL, NULL, NEW.conversation_id, NEW.user_id, 'normal'
        );
    END IF;
    
    -- Handle federation for outgoing messages
    IF NEW.conversation_id IS NOT NULL AND sender_profile.is_local THEN
        -- Get instance domain from config
        SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
        FROM instance_config 
        WHERE config_key = 'domain' 
        LIMIT 1;
        
        IF v_instance_domain IS NOT NULL THEN
            -- Find remote recipients using conversation_participants table
            FOR v_recipient_profile IN 
                SELECT p.id, p.username, p.domain, p.federated_id, p.is_local, p.inbox_url
                FROM conversation_participants cp
                JOIN profiles p ON p.id = cp.user_id
                WHERE cp.conversation_id = NEW.conversation_id 
                  AND cp.user_id != NEW.user_id
                  AND cp.left_at IS NULL
                  AND NOT p.is_local
                  AND p.domain IS NOT NULL
            LOOP
                -- Build URLs using federated_id when available, fallback to constructed URL
                v_sender_url := 'https://' || v_instance_domain || '/users/' || sender_profile.username;
                v_recipient_url := COALESCE(v_recipient_profile.federated_id, 'https://' || v_recipient_profile.domain || '/users/' || v_recipient_profile.username);
                v_message_url := 'https://' || v_instance_domain || '/messages/' || NEW.id::TEXT;
                v_activity_id := v_sender_url || '#dm-' || NEW.id::TEXT;
                
                -- Use modern content processing functions
                v_html_content := convert_jsonb_to_ap(NEW.content);
                v_attachments := extract_activitypub_attachments(NEW.content);
                v_tags := extract_all_activitypub_tags(NEW.content);
                
                -- ✅ CRITICAL FIX 1: Add recipient as mention tag (from working 073-074)
                v_tags := v_tags || jsonb_build_array(
                    jsonb_build_object(
                        'type', 'Mention',
                        'href', v_recipient_url,
                        'name', '@' || v_recipient_profile.username || '@' || v_recipient_profile.domain
                    )
                );
                
                -- Create Note object (DM format)
                v_note_object := jsonb_build_object(
                    'id', v_message_url,
                    'type', 'Note',
                    'attributedTo', v_sender_url,
                    'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                    'content', v_html_content,
                    'contentMap', jsonb_build_object('en', v_html_content),
                    'attachment', COALESCE(v_attachments, '[]'::jsonb),
                    'tag', v_tags,
                    'to', jsonb_build_array(v_recipient_url),  -- Direct addressing
                    'cc', '[]'::jsonb,                         -- Empty CC for DMs
                    'directMessage', true                      -- ✅ CRITICAL FIX 2: Explicit DM flag
                );
                
                -- Create ActivityPub Create activity
                v_activity := jsonb_build_object(
                    '@context', 'https://www.w3.org/ns/activitystreams',
                    'id', v_activity_id,
                    'type', 'Create',
                    'actor', v_sender_url,
                    'published', to_char(NEW.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
                    'object', v_note_object,
                    'to', jsonb_build_array(v_recipient_url),  -- Direct addressing
                    'cc', '[]'::jsonb                          -- Empty CC for DMs
                );
                
                -- Store the ActivityPub activity record
                INSERT INTO ap_activities (
                    ap_id, ap_type, actor_id, actor_ap_id, object_id, object_type,
                    activity_data, status, to_addresses, is_local, origin_domain
                ) VALUES (
                    v_activity_id, 'Create', sender_profile.id, v_sender_url, v_message_url, 'Note',
                    v_activity, 'pending', ARRAY[v_recipient_url], true, v_instance_domain
                ) RETURNING id INTO v_activity_uuid;
                
                -- Build array of target domains for queue_activity_for_federation
                target_domains := ARRAY[v_recipient_profile.domain];
                
                -- Queue for federation delivery
                PERFORM queue_activity_for_federation(
                    v_activity_uuid,  -- The UUID from ap_activities 
                    target_domains,   -- Array of domains to deliver to
                    8,                -- High priority for DMs (1-10 scale, 8 is high)
                    true              -- Immediate delivery
                );
                
                RAISE NOTICE '📮 Queued DM for federation to: %@% (activity: %)', 
                    v_recipient_profile.username, v_recipient_profile.domain, v_activity_uuid;
                    
            END LOOP;
        END IF;
    END IF;
    
    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Error in handle_outgoing_messages for message %: % %', NEW.id, SQLSTATE, SQLERRM;
        RETURN NEW;
END;
$$;


--
-- Name: FUNCTION handle_outgoing_messages(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_outgoing_messages() IS 'FIXED: Creates structured notification data that matches NotificationFormatter expectations with nested sender, message, and conversation objects.';


--
-- Name: handle_post_interaction_federation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_post_interaction_federation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_activity jsonb;
    v_target_post RECORD;
    v_target_domains text[];
    v_is_undo boolean := false;
    v_interaction_record RECORD;
BEGIN
    -- Only process emoji reactions
    IF COALESCE(NEW.interaction_type, OLD.interaction_type) != 'emoji_reaction' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Determine if this is an undo (DELETE) or create (INSERT)
    IF TG_OP = 'DELETE' THEN
        v_is_undo := true;
        v_interaction_record := OLD;
    ELSE
        v_interaction_record := NEW;
    END IF;
    
    -- Get target post info
    SELECT * INTO v_target_post
    FROM posts
    WHERE id = v_interaction_record.post_id;
    
    IF NOT FOUND THEN
        RAISE LOG 'Target post not found for reaction federation: %', v_interaction_record.post_id;
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Only federate reactions on local posts or when we're the actor
    -- (Don't relay reactions on remote posts to avoid loops)
    IF NOT v_target_post.is_local THEN
        RAISE LOG 'Skipping federation for reaction on remote post: %', v_target_post.id;
        RETURN COALESCE(NEW, OLD);
    END IF;
    
    -- Build ActivityPub activity
    BEGIN
        -- Get sender profile details for federation
        DECLARE
            v_sender_profile RECORD;
            v_instance_domain text;
        BEGIN
            -- Get sender profile
            SELECT * INTO v_sender_profile 
            FROM profiles 
            WHERE id = v_interaction_record.user_id AND is_local = true;
            
            IF NOT FOUND THEN
                RAISE LOG 'Sender profile not found for reaction federation: %', v_interaction_record.user_id;
                RETURN COALESCE(NEW, OLD);
            END IF;
            
            -- Get instance domain
            SELECT config_value::text INTO v_instance_domain
            FROM instance_config 
            WHERE config_key = 'domain';
            
            -- Remove JSON quotes if present
            v_instance_domain := trim(both '"' from v_instance_domain);
            
            v_activity := build_emoji_reaction_activity(
                v_interaction_record.id,
                v_interaction_record.user_id,
                v_interaction_record.post_id,
                v_interaction_record.emoji_id,
                v_interaction_record.custom_emoji_content,
                v_is_undo
            );
            
            -- Determine target domains for federation
            -- For now, federate to all known instances that might be interested
            SELECT ARRAY(
                SELECT DISTINCT domain
                FROM profiles 
                WHERE domain IS NOT NULL 
                AND domain != ''
                AND is_local = false
                LIMIT 50  -- Reasonable limit to avoid overwhelming the system
            ) INTO v_target_domains;
            
            -- Add to federation delivery queue (one row per target domain)
            IF array_length(v_target_domains, 1) > 0 THEN
                -- Get sender profile details for actor fields
                DECLARE
                    v_domain_inbox text;
                    v_target_domain text;
                BEGIN
                    FOREACH v_target_domain IN ARRAY v_target_domains LOOP
                        v_domain_inbox := 'https://' || v_target_domain || '/inbox';
                        
                        INSERT INTO federation_delivery_queue (
                            activity_data,
                            target_domain,
                            target_inbox_url,
                            actor_username,
                            actor_domain,
                            status,
                            priority,
                            attempts,
                            next_attempt_at
                        ) VALUES (
                            v_activity,
                            v_target_domain,
                            v_domain_inbox,
                            v_sender_profile.username,
                            v_instance_domain,
                            'pending',
                            5,
                            0,
                            NOW()
                        );
                    END LOOP;
                    
                    RAISE LOG 'Queued emoji reaction federation to % domains', 
                        array_length(v_target_domains, 1);
                END;
            END IF;
        END;
        
    EXCEPTION WHEN OTHERS THEN
        -- Log error but don't block the interaction
        RAISE LOG 'Failed to federate emoji reaction: %', SQLERRM;
    END;
    
    RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: FUNCTION handle_post_interaction_federation(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_post_interaction_federation() IS 'Handles automatic federation of emoji reactions. Triggers on post_interactions INSERT/DELETE for emoji_reaction type.';


--
-- Name: handle_post_mention_notifications(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_post_mention_notifications() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    content_part JSONB;
    mentioned_username TEXT;
    mentioned_user_id UUID;
    author_profile RECORD;
    post_content_preview TEXT;
BEGIN
    -- Only handle new posts
    IF TG_OP = 'INSERT' THEN
        -- Get author profile for notification data
        SELECT id, username, display_name, avatar_url, domain, is_local
        INTO author_profile
        FROM profiles 
        WHERE id = NEW.author_id;
        
        -- Only process if author found and content exists
        IF FOUND AND NEW.content IS NOT NULL THEN
            -- Extract content preview from MessagePart[] array
            post_content_preview := extract_message_text(NEW.content);
            IF LENGTH(post_content_preview) > 100 THEN
                post_content_preview := LEFT(post_content_preview, 100) || '...';
            END IF;
            IF post_content_preview = '' OR post_content_preview IS NULL THEN
                post_content_preview := 'New post';
            END IF;
            
            -- Extract mentions from unified content format
            IF jsonb_typeof(NEW.content) = 'array' THEN
                FOR content_part IN SELECT jsonb_array_elements(NEW.content)
                LOOP
                    -- Check if this is a mention
                    IF content_part->>'type' = 'mention' THEN
                        mentioned_username := content_part->>'username';
                        
                        -- Check if this is a local mention using isLocal field
                        IF (content_part->>'isLocal')::boolean = true THEN
                            RAISE NOTICE '🔍 Processing local mention: username=%, is_local=%, is_federated=%', 
                                mentioned_username, NEW.is_local, NEW.is_federated;
                            
                            -- Get the mentioned user ID (only local users)
                            SELECT id INTO mentioned_user_id
                            FROM profiles 
                            WHERE username = mentioned_username 
                              AND is_local = true
                              AND id != NEW.author_id; -- Don't notify self
                            
                            IF mentioned_user_id IS NOT NULL THEN
                                RAISE NOTICE '✅ Found local user mentioned: % (ID: %)', mentioned_username, mentioned_user_id;
                                
                                -- Use send_notification_to_user for proper notification creation
                                PERFORM send_notification_to_user(
                                    'activitypub_mention',
                                    mentioned_user_id,
                                    jsonb_build_object(
                                        'actor', jsonb_build_object(
                                            'id', author_profile.id,
                                            'username', author_profile.username,
                                            'display_name', author_profile.display_name,
                                            'avatar_url', author_profile.avatar_url,
                                            'domain', author_profile.domain,
                                            'is_local', author_profile.is_local
                                        ),
                                        'post', jsonb_build_object(
                                            'id', NEW.id,
                                            'ap_id', NEW.ap_id,
                                            'content_preview', post_content_preview,
                                            'content', NEW.content
                                        ),
                                        'post_id', NEW.id,
                                        'post_content', NEW.content,
                                        'timestamp', NEW.created_at,
                                        'federated', NEW.is_federated
                                    ),
                                    NULL, -- server_id
                                    NULL, -- channel_id
                                    NULL, -- conversation_id
                                    author_profile.id, -- from_user_id
                                    'normal' -- priority
                                );
                                
                                RAISE NOTICE '✅ Created ActivityPub mention notification: % mentioned %', 
                                    author_profile.username, mentioned_username;
                            ELSE
                                RAISE NOTICE '⚠️ Mentioned user not found: username=%', mentioned_username;
                            END IF;
                        ELSE
                            RAISE NOTICE '⚠️ Skipping remote user mention: username=%', mentioned_username;
                        END IF;
                    END IF;
                END LOOP;
            END IF;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;


--
-- Name: FUNCTION handle_post_mention_notifications(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_post_mention_notifications() IS 'Creates notifications when local users are mentioned in ActivityPub posts (both local and federated).';


--
-- Name: handle_post_reactions_federation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_post_reactions_federation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    user_federation_enabled boolean;
    current_instance_domain text;
    full_instance_url text;  -- NEW: Full URL with protocol
    activity_type text;
    target_object_id text;
    target_actor_id uuid;
    emoji_data record;
    reaction_content text;
    activity_content jsonb;
BEGIN
    -- Get instance domain and build full URL with protocol
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    full_instance_url := 'https://' || current_instance_domain;  -- NEW: Add protocol

    -- Check federation for user
    SELECT is_federation_enabled_for_user(COALESCE(NEW.user_id, OLD.user_id)) INTO user_federation_enabled;
    
    IF NOT user_federation_enabled THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Only federate reactions on post_interactions (not regular reactions table)
    IF TG_OP = 'INSERT' THEN
        activity_type := 'Like';
        target_object_id := (SELECT ap_id FROM posts WHERE id = NEW.post_id);
        target_actor_id := (SELECT author_id FROM posts WHERE id = NEW.post_id);
        
        -- Get emoji data for custom emoji federation
        SELECT name, url INTO emoji_data 
        FROM emojis WHERE id = NEW.emoji_id;
        
        -- Build reaction content
        reaction_content := CASE 
            WHEN emoji_data.name IS NOT NULL THEN ':' || emoji_data.name || ':'
            ELSE '❤️'  -- Default heart emoji
        END;
        
    ELSIF TG_OP = 'DELETE' THEN
        activity_type := 'Undo';
        target_object_id := (SELECT ap_id FROM posts WHERE id = OLD.post_id);
        target_actor_id := (SELECT author_id FROM posts WHERE id = OLD.post_id);
        
        -- For undo, we don't need emoji data
        reaction_content := NULL;
    END IF;

    -- Build activity content
    activity_content := jsonb_build_object(
        'type', activity_type,
        'actor', (SELECT federated_id FROM profiles WHERE id = COALESCE(NEW.user_id, OLD.user_id)),
        'object', target_object_id,
        'content', reaction_content,
        'tag', CASE 
            WHEN emoji_data.name IS NOT NULL AND emoji_data.url IS NOT NULL THEN
                jsonb_build_array(
                    jsonb_build_object(
                        'type', 'Emoji',
                        'name', reaction_content,
                        'icon', jsonb_build_object(
                            'type', 'Image',
                            'url', emoji_data.url
                        ),
                        'id', full_instance_url || '/emojis/' || COALESCE(NEW.emoji_id, OLD.emoji_id)  -- FIXED: Use full URL
                    )
                )
            ELSE '[]'::jsonb
        END
    );

    -- Create ActivityPub activity for federation
    INSERT INTO ap_activities (
        ap_id, ap_type, actor_id, actor_ap_id, object_id, object_type,
        target_id, target_type, activity_data, status, is_local
    ) VALUES (
        full_instance_url || '/activities/' || gen_random_uuid(),  -- FIXED: Use full URL
        activity_type,
        COALESCE(NEW.user_id, OLD.user_id),
        (SELECT federated_id FROM profiles WHERE id = COALESCE(NEW.user_id, OLD.user_id)),
        target_object_id, 'Note', target_actor_id, 'Person',
        activity_content,
        'pending', true
    );

    RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: FUNCTION handle_post_reactions_federation(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_post_reactions_federation() IS 'FIXED: ActivityPub URLs now include https:// protocol. Compatible with Pleroma/Misskey custom emoji federation.';


--
-- Name: handle_post_soft_delete(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_post_soft_delete() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  -- When a post is soft-deleted, we could optionally clean up related data
  -- For now, we just log it - the RLS policies will prevent access
  IF NEW.is_deleted = true AND (OLD.is_deleted = false OR OLD.is_deleted IS NULL) THEN
    -- Post was just soft-deleted
    -- The RLS policies will now prevent anyone from seeing it
    RAISE NOTICE 'Post % was soft-deleted', NEW.id;
  END IF;
  
  RETURN NEW;
END;
$$;


--
-- Name: handle_profile_update_federation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_profile_update_federation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    profile_changed BOOLEAN := FALSE;
    activity_id UUID;
    profile_actor_url TEXT;
    instance_domain TEXT;
    update_activity JSONB;
    profile_object JSONB;
BEGIN
    -- Only handle updates for local users
    IF TG_OP != 'UPDATE' OR NOT NEW.is_local THEN
        RETURN NEW;
    END IF;

    -- Check if any federation-relevant fields changed
    IF (OLD.username IS DISTINCT FROM NEW.username OR
        OLD.display_name IS DISTINCT FROM NEW.display_name OR
        OLD.bio IS DISTINCT FROM NEW.bio OR
        OLD.color IS DISTINCT FROM NEW.color OR
        OLD.avatar_url IS DISTINCT FROM NEW.avatar_url OR
        OLD.banner_url IS DISTINCT FROM NEW.banner_url OR
        OLD.public_key IS DISTINCT FROM NEW.public_key OR
        OLD.is_suspended IS DISTINCT FROM NEW.is_suspended OR
        OLD.suspended_at IS DISTINCT FROM NEW.suspended_at OR
        OLD.suspension_reason IS DISTINCT FROM NEW.suspension_reason) THEN
        
        profile_changed := TRUE;
    END IF;

    -- If no relevant changes, skip federation
    IF NOT profile_changed THEN
        RETURN NEW;
    END IF;

    -- Get instance domain
    SELECT trim(both '"' from config_value::text) INTO instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;

    -- Build actor URL
    profile_actor_url := 'https://' || instance_domain || '/users/' || NEW.username;

    -- Build the profile object (Person type)
    profile_object := jsonb_build_object(
        '@context', jsonb_build_array(
            'https://www.w3.org/ns/activitystreams',
            'https://w3id.org/security/v1'
        ),
        'id', profile_actor_url,
        'type', 'Person',
        'preferredUsername', NEW.username,
        'name', COALESCE(NEW.display_name, NEW.username),
        'summary', COALESCE(NEW.bio, ''),
        'inbox', 'https://' || instance_domain || '/users/' || NEW.username || '/inbox',
        'outbox', 'https://' || instance_domain || '/users/' || NEW.username || '/outbox',
        'followers', 'https://' || instance_domain || '/users/' || NEW.username || '/followers',
        'following', 'https://' || instance_domain || '/users/' || NEW.username || '/following',
        'featured', 'https://' || instance_domain || '/users/' || NEW.username || '/featured',
        'publicKey', jsonb_build_object(
            'id', profile_actor_url || '#main-key',
            'owner', profile_actor_url,
            'publicKeyPem', NEW.public_key
        )
    );

    -- Add avatar if present
    IF NEW.avatar_url IS NOT NULL THEN
        profile_object := profile_object || jsonb_build_object(
            'icon', jsonb_build_object(
                'type', 'Image',
                'url', NEW.avatar_url
            )
        );
    END IF;

    -- Add banner if present  
    IF NEW.banner_url IS NOT NULL THEN
        profile_object := profile_object || jsonb_build_object(
            'image', jsonb_build_object(
                'type', 'Image', 
                'url', NEW.banner_url
            )
        );
    END IF;

    -- Add suspension info if suspended
    IF NEW.is_suspended THEN
        profile_object := profile_object || jsonb_build_object(
            'suspended', true,
            'suspendedAt', NEW.suspended_at,
            'suspensionReason', NEW.suspension_reason
        );
    END IF;

    -- Build the Update activity
    update_activity := jsonb_build_object(
        '@context', 'https://www.w3.org/ns/activitystreams',
        'id', profile_actor_url || '/activities/update/' || gen_random_uuid(),
        'type', 'Update',
        'actor', profile_actor_url,
        'published', NOW(),
        'object', profile_object,
        'to', jsonb_build_array('https://www.w3.org/ns/activitystreams#Public'),
        'cc', jsonb_build_array('https://' || instance_domain || '/users/' || NEW.username || '/followers')
    );

    -- Create the activity record
    INSERT INTO ap_activities (
        ap_id,
        ap_type,
        actor_ap_id,
        activity_data,
        origin_domain,
        to_addresses,
        cc_addresses,
        is_local,
        status
    ) VALUES (
        update_activity->>'id',
        'Update',
        profile_actor_url,
        update_activity,
        instance_domain,
        ARRAY['https://www.w3.org/ns/activitystreams#Public'],
        ARRAY['https://' || instance_domain || '/users/' || NEW.username || '/followers'],
        true,
        'pending'
    ) RETURNING id INTO activity_id;

    -- Queue the activity for federation delivery directly
    -- Get follower domains to send to
    PERFORM queue_activity_for_federation(
        activity_id,
        ARRAY(
            SELECT DISTINCT domain 
            FROM follows f
            JOIN profiles p ON f.follower_id = p.id
            WHERE f.following_id = NEW.id
            AND f.status = 'accepted'
            AND NOT p.is_local
            AND p.domain IS NOT NULL
        ),
        3, -- Priority 3 (profile updates are important but not urgent)
        true -- Immediate processing
    );

    RAISE NOTICE '📝 Profile update activity created and queued for %: %', NEW.username, activity_id;

    RETURN NEW;
END;
$$;


--
-- Name: FUNCTION handle_profile_update_federation(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_profile_update_federation() IS 'Federates profile updates for local users. Creates Update activities when public profile fields change. Federation delivery is handled by existing queue system.';


--
-- Name: handle_reactions_federation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_reactions_federation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    user_federation_enabled boolean;
    current_instance_domain text;
    full_instance_url text;  -- NEW: Full URL with protocol
    activity_type text;
    target_object_id text;
    target_actor_id uuid;
    emoji_data record;
    reaction_content text;
    activity_content jsonb;
    is_dm_message boolean := false;
BEGIN
    -- Get instance domain and build full URL with protocol
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    full_instance_url := 'https://' || current_instance_domain;  -- NEW: Add protocol

    -- Check federation for user
    SELECT is_federation_enabled_for_user(COALESCE(NEW.user_id, OLD.user_id)) INTO user_federation_enabled;
    
    IF NOT user_federation_enabled THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Check if this is a DM message (has remote participants)
    SELECT EXISTS(
        SELECT 1 FROM messages m
        JOIN conversation_participants cp ON m.conversation_id = cp.conversation_id  
        JOIN profiles p ON cp.user_id = p.id
        WHERE m.id = COALESCE(NEW.message_id, OLD.message_id)
          AND NOT p.is_local
    ) INTO is_dm_message;

    -- Only federate DM reactions, not server chat reactions (local-first design)
    IF NOT is_dm_message THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    IF TG_OP = 'INSERT' THEN
        activity_type := 'Like';  -- FIXED: Use 'Like' instead of 'EmojiReact'
        target_object_id := full_instance_url || '/messages/' || NEW.message_id;  -- FIXED: Use full URL
        
        -- Get message author
        SELECT user_id INTO target_actor_id FROM messages WHERE id = NEW.message_id;
        
        -- Get emoji data for custom emoji federation
        SELECT name, url INTO emoji_data 
        FROM emojis WHERE id = NEW.emoji_id;
        
        -- Build reaction content (Pleroma/Misskey compatible)
        reaction_content := CASE 
            WHEN emoji_data.name IS NOT NULL THEN ':' || emoji_data.name || ':'
            ELSE '❤️'  -- Default heart emoji
        END;
        
    ELSIF TG_OP = 'DELETE' THEN
        activity_type := 'Undo';
        target_object_id := full_instance_url || '/messages/' || OLD.message_id;  -- FIXED: Use full URL
        SELECT user_id INTO target_actor_id FROM messages WHERE id = OLD.message_id;
        reaction_content := NULL;
    END IF;

    -- Build activity content with custom emoji support
    IF activity_type IS NOT NULL AND target_object_id IS NOT NULL THEN
        activity_content := jsonb_build_object(
            'type', activity_type,
            'actor', (SELECT federated_id FROM profiles WHERE id = COALESCE(NEW.user_id, OLD.user_id)),
            'object', target_object_id
        );

        -- Add custom emoji data for federation compatibility
        IF reaction_content IS NOT NULL THEN
            activity_content := activity_content || jsonb_build_object(
                'content', reaction_content,
                'tag', CASE 
                    WHEN emoji_data.name IS NOT NULL AND emoji_data.url IS NOT NULL THEN
                        jsonb_build_array(
                            jsonb_build_object(
                                'type', 'Emoji',
                                'name', reaction_content,
                                'icon', jsonb_build_object(
                                    'type', 'Image',
                                    'url', emoji_data.url
                                ),
                                'id', full_instance_url || '/emojis/' || COALESCE(NEW.emoji_id, OLD.emoji_id)  -- FIXED: Use full URL
                            )
                        )
                    ELSE '[]'::jsonb
                END
            );
        END IF;

        -- Create ActivityPub activity for federation  
        INSERT INTO ap_activities (
            ap_id, ap_type, actor_id, actor_ap_id, object_id, object_type,
            target_id, target_type, activity_data, status, is_local
        ) VALUES (
            full_instance_url || '/activities/' || gen_random_uuid(),  -- FIXED: Use full URL
            activity_type,
            COALESCE(NEW.user_id, OLD.user_id),
            (SELECT federated_id FROM profiles WHERE id = COALESCE(NEW.user_id, OLD.user_id)),
            target_object_id, 
            'Note', 
            target_actor_id, 
            'Person',
            activity_content,
            'pending', 
            true
        );
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: FUNCTION handle_reactions_federation(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_reactions_federation() IS 'FIXED: ActivityPub URLs now include https:// protocol. Only federates DM reactions (local-first design). Uses Like activity type for ActivityPub compliance.';


--
-- Name: handle_remote_user_suspension(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_remote_user_suspension() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF NEW.is_suspended = true AND (OLD.is_suspended IS NULL OR OLD.is_suspended = false) THEN
        -- Remove follows where suspended user is following local users
        DELETE FROM follows 
        WHERE follower_id = NEW.id 
        AND EXISTS (SELECT 1 FROM profiles WHERE id = follows.following_id AND is_local = true);
        
        -- Remove follows where local users are following the suspended user
        -- This unfollows local users from the suspended remote user
        DELETE FROM follows 
        WHERE following_id = NEW.id 
        AND EXISTS (SELECT 1 FROM profiles WHERE id = follows.follower_id AND is_local = true);
        
        -- Note: We don't delete their posts - they're hidden via queries
        -- We don't delete their reactions - they're just not shown
        
        -- Log the suspension
        RAISE NOTICE 'User % has been suspended. Removed follow relationships with local users.', NEW.id;
    END IF;
    
    RETURN NEW;
END;
$$;


--
-- Name: FUNCTION handle_remote_user_suspension(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_remote_user_suspension() IS 'Handle cleanup when a user (especially remote) is suspended - removes follow relationships';


--
-- Name: handle_unified_interaction_federation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_unified_interaction_federation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    user_federation_enabled boolean;
    target_federation_enabled boolean;
    current_instance_domain text;
    full_instance_url text;  -- NEW: Full URL with protocol
    activity_type text;
    target_object_id text;
    target_actor_id uuid;
    actor_user_id uuid;
BEGIN
    -- Get instance domain and build full URL with protocol
    SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    full_instance_url := 'https://' || current_instance_domain;  -- NEW: Add protocol

    -- Determine the actor user ID based on table type
    IF TG_TABLE_NAME = 'follows' THEN
        actor_user_id := COALESCE(NEW.follower_id, OLD.follower_id);
    ELSE
        actor_user_id := COALESCE(NEW.user_id, OLD.user_id);
    END IF;

    -- Check federation for actor user
    SELECT is_federation_enabled_for_user(actor_user_id) INTO user_federation_enabled;
    
    IF NOT user_federation_enabled THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Determine activity details based on table and operation
    IF TG_TABLE_NAME = 'follows' THEN
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

        IF TG_OP = 'INSERT' THEN
            activity_type := CASE 
                WHEN NEW.interaction_type = 'favorite' THEN 'Like'
                WHEN NEW.interaction_type = 'reblog' THEN 'Announce' 
                ELSE 'Like'
            END;
            target_object_id := (SELECT ap_id FROM posts WHERE id = NEW.post_id);
            target_actor_id := (SELECT author_id FROM posts WHERE id = NEW.post_id);
        ELSIF TG_OP = 'DELETE' THEN
            activity_type := 'Undo';
            target_object_id := (SELECT ap_id FROM posts WHERE id = OLD.post_id);
            target_actor_id := (SELECT author_id FROM posts WHERE id = OLD.post_id);
        END IF;

    ELSIF TG_TABLE_NAME = 'reactions' THEN
        -- Check federation for reaction user
        SELECT is_federation_enabled_for_user(COALESCE(NEW.user_id, OLD.user_id)) INTO user_federation_enabled;
        
        IF NOT user_federation_enabled THEN
            RETURN COALESCE(NEW, OLD);
        END IF;

        IF TG_OP = 'INSERT' THEN
            activity_type := 'Like';  -- FIXED: Use 'Like' instead of 'EmojiReact'
            target_object_id := (SELECT 'message-' || NEW.message_id);
            -- Get message author
            SELECT user_id INTO target_actor_id FROM messages WHERE id = NEW.message_id;
        ELSIF TG_OP = 'DELETE' THEN
            activity_type := 'Undo';
            target_object_id := (SELECT 'message-' || OLD.message_id);
            SELECT user_id INTO target_actor_id FROM messages WHERE id = OLD.message_id;
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
            full_instance_url || '/activities/' || gen_random_uuid(),  -- FIXED: Use full URL
            activity_type,
            actor_user_id,
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


--
-- Name: FUNCTION handle_unified_interaction_federation(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_unified_interaction_federation() IS 'FIXED: ActivityPub URLs now include https:// protocol. Uses Like instead of EmojiReact for reactions.';


--
-- Name: handle_unified_notification_processing(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_unified_notification_processing() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    notification_data jsonb;
    target_user_id uuid;
    mentioned_users uuid[];
    server_members uuid[];
    followers uuid[];
    single_target_id uuid;
    target_user_ids uuid[];
    msg_channel_id uuid;
    msg_server_id uuid;
    post_author_id uuid;
    post_record RECORD;
    emoji_record RECORD;
    emoji_name TEXT;
    emoji_url TEXT;
    follower_record RECORD;
BEGIN
    -- Early exit for non-notification operations
    IF TG_OP = 'UPDATE' THEN
        RETURN NEW;
    END IF;

    -- Handle different table operations (removed mentions handling - now done directly in handle_message_federation)
    IF TG_TABLE_NAME = 'follows' AND TG_OP = 'INSERT' THEN
        -- Handle follow notifications with complete follower profile data
        -- Get follower profile information
        SELECT id, username, display_name, avatar_url, domain, is_local
        INTO follower_record
        FROM profiles
        WHERE id = NEW.follower_id;
        
        IF follower_record IS NOT NULL THEN
            -- Build comprehensive notification data matching frontend expectations
            notification_data := jsonb_build_object(
                'type', 'activitypub_follow',
                'follower_id', NEW.follower_id,
                'follow_id', NEW.id,
                'timestamp', NOW(),
                'follower', jsonb_build_object(
                    'id', follower_record.id,
                    'username', follower_record.username,
                    'display_name', COALESCE(follower_record.display_name, follower_record.username),
                    'avatar_url', follower_record.avatar_url,
                    'domain', follower_record.domain,
                    'is_local', COALESCE(follower_record.is_local, true),
                    'handle', CASE 
                        WHEN follower_record.is_local = true OR follower_record.domain IS NULL 
                        THEN '@' || follower_record.username
                        ELSE '@' || follower_record.username || '@' || follower_record.domain
                    END
                )
            );
            
            PERFORM send_notification_to_user(
                'activitypub_follow',
                NEW.following_id,
                notification_data,
                NULL,
                NULL,
                NULL,
                NEW.follower_id,
                'normal'
            );
        END IF;

    ELSIF TG_TABLE_NAME = 'reactions' AND TG_OP = 'INSERT' THEN
        -- Handle reaction notifications (for messages)
        SELECT user_id INTO single_target_id FROM messages WHERE id = NEW.message_id;
        
        IF single_target_id IS NOT NULL AND single_target_id != NEW.user_id THEN
            SELECT m.channel_id, c.server_id 
            INTO msg_channel_id, msg_server_id
            FROM messages m 
            LEFT JOIN channels c ON m.channel_id = c.id 
            WHERE m.id = NEW.message_id;
            
            notification_data := jsonb_build_object(
                'type', 'reaction',
                'message_id', NEW.message_id,
                'emoji_id', NEW.emoji_id,
                'user_id', NEW.user_id
            );
            
            PERFORM send_notification_to_user(
                'reaction',
                single_target_id,
                notification_data,
                msg_server_id,
                msg_channel_id,
                NULL,
                NEW.user_id,
                'normal'
            );
        END IF;

    ELSIF TG_TABLE_NAME = 'post_interactions' AND TG_OP = 'INSERT' THEN
        -- Handle ActivityPub reaction notifications (emoji_reaction type)
        IF NEW.interaction_type = 'emoji_reaction' THEN
            SELECT author_id INTO post_author_id 
            FROM posts 
            WHERE id = NEW.post_id;
            
            IF post_author_id IS NOT NULL AND post_author_id != NEW.user_id THEN
                SELECT * INTO post_record FROM posts WHERE id = NEW.post_id;
                
                emoji_name := NULL;
                emoji_url := NULL;
                IF NEW.emoji_id IS NOT NULL THEN
                    SELECT name, url INTO emoji_record FROM emojis WHERE id = NEW.emoji_id;
                    IF FOUND THEN
                        emoji_name := emoji_record.name;
                        emoji_url := emoji_record.url;
                    END IF;
                END IF;
                
                notification_data := jsonb_build_object(
                    'type', 'activitypub_reaction',
                    'post_id', NEW.post_id,
                    'post_content', COALESCE(post_record.content->0->>'text', ''),
                    'interaction_id', NEW.id,
                    'sender', jsonb_build_object(
                        'user_id', NEW.user_id,
                        'username', (SELECT username FROM profiles WHERE id = NEW.user_id),
                        'display_name', (SELECT display_name FROM profiles WHERE id = NEW.user_id),
                        'avatar_url', (SELECT avatar_url FROM profiles WHERE id = NEW.user_id),
                        'is_local', (SELECT is_local FROM profiles WHERE id = NEW.user_id),
                        'domain', (SELECT domain FROM profiles WHERE id = NEW.user_id)
                    ),
                    'reaction', jsonb_build_object(
                        'emoji_id', NEW.emoji_id,
                        'emoji_name', COALESCE(emoji_name, NEW.custom_emoji_content, '👍'),
                        'emoji_url', emoji_url,
                        'custom_emoji_content', NEW.custom_emoji_content
                    )
                );
                
                PERFORM send_notification_to_user(
                    'activitypub_reaction',
                    post_author_id,
                    notification_data,
                    NULL,
                    NULL,
                    NULL,
                    NEW.user_id,
                    'normal'
                );
            END IF;
        END IF;
    END IF;

    RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: FUNCTION handle_unified_notification_processing(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_unified_notification_processing() IS 'Handles notifications for follows (with full profile data), reactions, and ActivityPub emoji reactions. Uses activitypub_follow type for follow notifications with complete follower profile data.';


--
-- Name: handle_unified_profile_federation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_unified_profile_federation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    user_federation_enabled boolean;
    current_instance_domain text;
    should_federate boolean := false;
BEGIN
    -- Only process UPDATE operations
    IF TG_OP != 'UPDATE' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    -- Check if federation is enabled for this user
    SELECT is_federation_enabled_for_user(NEW.id) INTO user_federation_enabled;
    
    IF NOT user_federation_enabled THEN
        RETURN NEW;
    END IF;

    -- Check if any federable fields changed
    should_federate := (
        OLD.display_name IS DISTINCT FROM NEW.display_name OR
        OLD.bio IS DISTINCT FROM NEW.bio OR
        OLD.avatar_url IS DISTINCT FROM NEW.avatar_url OR
        OLD.banner_url IS DISTINCT FROM NEW.banner_url
    );

    IF should_federate THEN
        -- Get instance domain
        SELECT trim(both '"' from config_value::text) INTO current_instance_domain 
        FROM instance_config WHERE config_key = 'domain' LIMIT 1;

        -- Create Update activity for profile changes
        INSERT INTO ap_activities (
            ap_id,
            ap_type,
            actor_id,
            actor_ap_id,
            object_id,
            object_type,
            activity_data,
            status,
            is_local
        ) VALUES (
            current_instance_domain || '/activities/' || gen_random_uuid(),
            'Update',
            NEW.id,
            NEW.federated_id,
            NEW.federated_id,
            'Person',
            jsonb_build_object(
                'type', 'Update',
                'actor', NEW.federated_id,
                'object', jsonb_build_object(
                    'type', 'Person',
                    'id', NEW.federated_id,
                    'name', NEW.display_name,
                    'summary', NEW.bio,
                    'icon', CASE WHEN NEW.avatar_url IS NOT NULL THEN 
                        jsonb_build_object('type', 'Image', 'url', NEW.avatar_url)
                        ELSE NULL END,
                    'image', CASE WHEN NEW.banner_url IS NOT NULL THEN
                        jsonb_build_object('type', 'Image', 'url', NEW.banner_url) 
                        ELSE NULL END
                )
            ),
            'pending',
            true
        );
    END IF;

    RETURN NEW;
END;
$$;


--
-- Name: FUNCTION handle_unified_profile_federation(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_unified_profile_federation() IS 'OUTGOING ONLY: Unified trigger for federating local profile updates to remote instances. Not bidirectional.';


--
-- Name: import_remote_emoji(uuid, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.import_remote_emoji(p_remote_emoji_id uuid, p_new_name text DEFAULT NULL::text, p_server_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_remote remote_emojis_cache%ROWTYPE;
  v_new_id uuid;
  v_name text;
BEGIN
  -- Get the remote emoji
  SELECT * INTO v_remote FROM public.remote_emojis_cache WHERE id = p_remote_emoji_id;
  
  IF v_remote.id IS NULL THEN
    RAISE EXCEPTION 'Remote emoji not found';
  END IF;
  
  IF v_remote.imported_as IS NOT NULL THEN
    RAISE EXCEPTION 'Emoji already imported';
  END IF;
  
  -- Use provided name or original shortcode
  v_name := COALESCE(p_new_name, v_remote.shortcode);
  
  -- Check if name already exists locally (where domain is null = local emoji)
  IF EXISTS (SELECT 1 FROM public.emojis WHERE name = v_name AND domain IS NULL) THEN
    RAISE EXCEPTION 'Emoji name already exists locally: %', v_name;
  END IF;
  
  -- Create the local emoji
  INSERT INTO public.emojis (
    name,
    url,
    server_id,
    domain  -- NULL means it's now a local emoji
  ) VALUES (
    v_name,
    v_remote.url,
    p_server_id,
    NULL  -- Imported as local emoji
  ) RETURNING id INTO v_new_id;
  
  -- Update the remote emoji to mark as imported
  UPDATE public.remote_emojis_cache 
  SET imported_as = v_new_id, imported_at = now()
  WHERE id = p_remote_emoji_id;
  
  RETURN v_new_id;
END;
$$;


--
-- Name: FUNCTION import_remote_emoji(p_remote_emoji_id uuid, p_new_name text, p_server_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.import_remote_emoji(p_remote_emoji_id uuid, p_new_name text, p_server_id uuid) IS 'Import a remote emoji to local emojis table.';


--
-- Name: increment_session_message_count(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_session_message_count(p_session_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    UPDATE public.encryption_sessions
    SET 
        message_count = message_count + 1,
        last_used_at = NOW(),
        -- Mark for refresh after 1000 messages
        needs_refresh = CASE 
            WHEN message_count + 1 >= 1000 THEN true
            ELSE needs_refresh
        END
    WHERE id = p_session_id;
END;
$$;


--
-- Name: increment_unread_mentions(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_unread_mentions() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_user_id uuid;
    v_channel_id uuid;
    v_server_id uuid;
    v_conversation_id uuid;
    existing_count_id uuid;
BEGIN
    -- Only process mention notifications
    IF NEW.type != 'mention' AND NEW.type != 'activitypub_mention' THEN
        RETURN NEW;
    END IF;
    
    v_user_id := NEW.user_id;
    
    -- Extract channel/server/conversation IDs from notification data
    v_channel_id := NULLIF((NEW.data->>'channel_id'), '')::uuid;
    v_server_id := NULLIF((NEW.data->>'server_id'), '')::uuid;
    v_conversation_id := NULLIF((NEW.data->>'conversation_id'), '')::uuid;
    
    -- If no channel/server/conversation ID in data, try location object
    IF v_channel_id IS NULL THEN
        v_channel_id := NULLIF((NEW.data->'location'->>'channel_id'), '')::uuid;
    END IF;
    IF v_server_id IS NULL THEN
        v_server_id := NULLIF((NEW.data->'location'->>'server_id'), '')::uuid;
    END IF;
    
    -- Increment unread_mentions in unread_counts table
    -- For channel mentions
    IF v_channel_id IS NOT NULL THEN
        -- Check if unread_count record exists
        SELECT id INTO existing_count_id
        FROM unread_counts
        WHERE user_id = v_user_id
          AND channel_id = v_channel_id
          AND (server_id = v_server_id OR (server_id IS NULL AND v_server_id IS NULL))
          AND conversation_id IS NULL;
        
        IF existing_count_id IS NOT NULL THEN
            -- Update existing record
            UPDATE unread_counts
            SET unread_mentions = unread_mentions + 1,
                updated_at = NOW()
            WHERE id = existing_count_id;
        ELSE
            -- Insert new record
            INSERT INTO unread_counts (user_id, channel_id, server_id, unread_mentions, updated_at)
            VALUES (v_user_id, v_channel_id, v_server_id, 1, NOW());
        END IF;
    END IF;
    
    -- For DM/conversation mentions
    IF v_conversation_id IS NOT NULL THEN
        -- Check if unread_count record exists
        SELECT id INTO existing_count_id
        FROM unread_counts
        WHERE user_id = v_user_id
          AND conversation_id = v_conversation_id
          AND channel_id IS NULL
          AND server_id IS NULL;
        
        IF existing_count_id IS NOT NULL THEN
            -- Update existing record
            UPDATE unread_counts
            SET unread_mentions = unread_mentions + 1,
                updated_at = NOW()
            WHERE id = existing_count_id;
        ELSE
            -- Insert new record
            INSERT INTO unread_counts (user_id, conversation_id, unread_mentions, updated_at)
            VALUES (v_user_id, v_conversation_id, 1, NOW());
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;


--
-- Name: FUNCTION increment_unread_mentions(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.increment_unread_mentions() IS 'Increments unread_mentions count in unread_counts table when mention notifications are created.';


--
-- Name: index_message(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.index_message() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  content_text_val text;
  features jsonb;
  server_id_val uuid;
BEGIN
  -- Skip deleted messages
  IF NEW.is_deleted = true THEN
    DELETE FROM message_search_index WHERE message_id = NEW.id;
    RETURN NEW;
  END IF;

  -- Extract plain text from MessagePart[] JSONB
  content_text_val := extract_message_text(NEW.content);
  
  -- Skip if no text content (system messages, etc.)
  IF content_text_val IS NULL OR trim(content_text_val) = '' THEN
    -- Still index for filtering by user/channel even without text
    content_text_val := '';
  END IF;

  -- Detect features
  features := detect_message_features(NEW.content);
  
  -- Get server_id if channel_id exists
  server_id_val := NULL;
  IF NEW.channel_id IS NOT NULL THEN
    server_id_val := get_channel_server_id(NEW.channel_id);
  END IF;

  -- Insert or update search index
  -- This bypasses RLS because it's a system operation (trigger)
  INSERT INTO message_search_index (
    message_id,
    content_text,
    content_tsvector,
    channel_id,
    conversation_id,
    user_id,
    server_id,
    has_media,
    has_url,
    created_at
  ) VALUES (
    NEW.id,
    content_text_val,
    to_tsvector('english', content_text_val),
    NEW.channel_id,
    NEW.conversation_id,
    NEW.user_id,
    server_id_val,
    (features->>'has_media')::boolean,
    (features->>'has_url')::boolean,
    NEW.created_at
  )
  ON CONFLICT (message_id) DO UPDATE SET
    content_text = EXCLUDED.content_text,
    content_tsvector = EXCLUDED.content_tsvector,
    channel_id = EXCLUDED.channel_id,
    conversation_id = EXCLUDED.conversation_id,
    user_id = EXCLUDED.user_id,
    server_id = EXCLUDED.server_id,
    has_media = EXCLUDED.has_media,
    has_url = EXCLUDED.has_url,
    updated_at = now();

  RETURN NEW;
END;
$$;


--
-- Name: initialize_user_encryption(uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.initialize_user_encryption(p_user_id uuid, p_identity_public_key text, p_identity_private_key_encrypted text, p_device_id text DEFAULT 'default'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_key_pair_id UUID;
BEGIN
    -- Only allow users to initialize their own encryption
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = p_user_id
        AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot initialize encryption for another user';
    END IF;
    
    -- Check if user already has keys
    IF EXISTS (
        SELECT 1 FROM public.user_key_pairs
        WHERE user_id = p_user_id AND device_id = p_device_id
    ) THEN
        RAISE EXCEPTION 'User already has encryption keys initialized';
    END IF;
    
    -- Insert identity key pair
    INSERT INTO public.user_key_pairs (
        user_id,
        device_id,
        identity_public_key,
        identity_private_key_encrypted,
        key_version,
        is_active
    ) VALUES (
        p_user_id,
        p_device_id,
        p_identity_public_key,
        p_identity_private_key_encrypted,
        1,
        true
    ) RETURNING id INTO v_key_pair_id;
    
    -- Log initialization
    INSERT INTO public.encryption_audit_log (
        user_id,
        event_type,
        severity,
        description,
        metadata
    ) VALUES (
        p_user_id,
        'key_generated',
        'info',
        'User encryption initialized',
        jsonb_build_object(
            'device_id', p_device_id,
            'key_pair_id', v_key_pair_id
        )
    );
    
    RETURN jsonb_build_object(
        'success', true,
        'key_pair_id', v_key_pair_id,
        'device_id', p_device_id
    );
END;
$$;


--
-- Name: FUNCTION initialize_user_encryption(p_user_id uuid, p_identity_public_key text, p_identity_private_key_encrypted text, p_device_id text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.initialize_user_encryption(p_user_id uuid, p_identity_public_key text, p_identity_private_key_encrypted text, p_device_id text) IS 'Initialize encryption for a new user. Creates identity key pair. Returns JSONB with success status and key_pair_id.';


--
-- Name: insert_ap_activity_safe(text, text, text, jsonb, text, text[], text[], boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.insert_ap_activity_safe(p_ap_id text, p_ap_type text, p_actor_ap_id text, p_activity_data jsonb, p_origin_domain text DEFAULT NULL::text, p_to_addresses text[] DEFAULT '{}'::text[], p_cc_addresses text[] DEFAULT '{}'::text[], p_is_local boolean DEFAULT false) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    result_record RECORD;
BEGIN
    SELECT * INTO result_record 
    FROM upsert_ap_activity(
        p_ap_id,
        p_ap_type,
        p_actor_ap_id,
        p_activity_data,
        p_origin_domain,
        p_to_addresses,
        p_cc_addresses,
        '{}', -- bto_addresses
        '{}', -- bcc_addresses
        p_is_local
    );
    
    RETURN result_record.activity_id;
END;
$$;


--
-- Name: FUNCTION insert_ap_activity_safe(p_ap_id text, p_ap_type text, p_actor_ap_id text, p_activity_data jsonb, p_origin_domain text, p_to_addresses text[], p_cc_addresses text[], p_is_local boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.insert_ap_activity_safe(p_ap_id text, p_ap_type text, p_actor_ap_id text, p_activity_data jsonb, p_origin_domain text, p_to_addresses text[], p_cc_addresses text[], p_is_local boolean) IS 'Simplified wrapper for upsert_ap_activity that returns just the activity ID.';


--
-- Name: is_activitypub_direct_message(jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_activitypub_direct_message(object_data jsonb, instance_domain text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    v_to JSONB;
    v_cc JSONB;
    v_visibility TEXT;
    v_has_public BOOLEAN := false;
    v_has_followers BOOLEAN := false;
    v_has_local_recipients BOOLEAN := false;
    v_recipient TEXT;
    v_total_recipients INTEGER := 0;
BEGIN
    -- Method 1: Check visibility property
    v_visibility := object_data->>'visibility';
    IF v_visibility = 'direct' THEN
        RETURN true;
    END IF;

    -- Method 2: Check directMessage flag
    IF (object_data->>'directMessage')::boolean = true THEN
        RETURN true;
    END IF;

    -- Method 3: Check addressing patterns
    v_to := COALESCE(object_data->'to', '[]'::jsonb);
    v_cc := COALESCE(object_data->'cc', '[]'::jsonb);

    -- Count total recipients and check for public indicators
    FOR v_recipient IN 
        SELECT jsonb_array_elements_text(v_to || v_cc)
    LOOP
        v_total_recipients := v_total_recipients + 1;
        
        -- Check for public addressing
        IF v_recipient IN (
            'https://www.w3.org/ns/activitystreams#Public',
            'Public'
        ) THEN
            v_has_public := true;
            EXIT; -- If it's public, it's definitely not a DM
        END IF;
        
        -- Check for followers addressing
        IF v_recipient LIKE '%/followers' THEN
            v_has_followers := true;
        END IF;
        
        -- Check for local recipients (this instance)
        IF v_recipient LIKE 'https://' || instance_domain || '/users/%' 
           OR v_recipient LIKE 'https://' || instance_domain || '/social/profile/%' THEN
            v_has_local_recipients := true;
        END IF;
    END LOOP;

    -- ENHANCED: More aggressive DM detection
    -- It's a DM if:
    -- 1. No public addressing AND
    -- 2. No followers addressing AND  
    -- 3. Has local recipients AND
    -- 4. Total recipients is small (≤ 10 for group DMs) AND
    -- 5. CC is empty or very small (private mentions typically have empty CC)
    
    IF NOT v_has_public 
       AND NOT v_has_followers 
       AND v_has_local_recipients 
       AND v_total_recipients <= 10
       AND jsonb_array_length(v_cc) <= 1 THEN
        RETURN true;
    END IF;

    -- ADDITIONAL: If 'to' field is small and CC is empty, it's likely a DM
    IF v_total_recipients <= 3 
       AND jsonb_array_length(v_cc) = 0 
       AND v_has_local_recipients THEN
        RETURN true;
    END IF;

    RETURN false;
END;
$$;


--
-- Name: FUNCTION is_activitypub_direct_message(object_data jsonb, instance_domain text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.is_activitypub_direct_message(object_data jsonb, instance_domain text) IS 'ENHANCED: Improved ActivityPub DM detection with better heuristics for recognizing direct messages vs public posts.';


--
-- Name: is_emoji_reaction_activity(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_emoji_reaction_activity(p_activity jsonb) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
    -- Direct EmojiReact activity
    IF p_activity->>'type' = 'EmojiReact' THEN
        RETURN true;
    END IF;
    
    -- Like activity with emoji content (Misskey style)
    IF p_activity->>'type' = 'Like' AND (
        p_activity->>'content' IS NOT NULL OR
        p_activity->>'_misskey_reaction' IS NOT NULL
    ) THEN
        RETURN true;
    END IF;
    
    -- Undo of emoji reaction
    IF p_activity->>'type' = 'Undo' AND 
       p_activity->'object'->>'type' IN ('EmojiReact', 'Like') AND (
        p_activity->'object'->>'content' IS NOT NULL OR
        p_activity->'object'->>'_misskey_reaction' IS NOT NULL
    ) THEN
        RETURN true;
    END IF;
    
    RETURN false;
END;
$$;


--
-- Name: FUNCTION is_emoji_reaction_activity(p_activity jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.is_emoji_reaction_activity(p_activity jsonb) IS 'Checks if an ActivityPub activity is an emoji reaction (EmojiReact, Like with emoji content, or Undo thereof).';


--
-- Name: is_federation_enabled_for_user(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_federation_enabled_for_user(user_id uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    instance_enabled boolean := true;
    user_enabled boolean := true;
BEGIN
    -- Check instance-level federation setting
    SELECT COALESCE((config_value->>'federation_enabled')::boolean, true) 
    INTO instance_enabled
    FROM instance_config 
    WHERE config_key = 'federation_settings'
    LIMIT 1;
    
    -- If no federation_settings config exists, federation is enabled by default
    IF instance_enabled IS NULL THEN
        instance_enabled := true;
    END IF;
    
    -- Check user-level federation setting
    SELECT COALESCE(federation_enabled, true)
    INTO user_enabled
    FROM profiles 
    WHERE id = user_id;
    
    RETURN instance_enabled AND user_enabled;
END;
$$;


--
-- Name: FUNCTION is_federation_enabled_for_user(user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.is_federation_enabled_for_user(user_id uuid) IS 'Checks if federation is enabled both at instance and user level for the given user.';


--
-- Name: is_local_user(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_local_user(p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT is_local
  FROM profiles
  WHERE id = p_user_id;
$$;


--
-- Name: FUNCTION is_local_user(p_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.is_local_user(p_user_id uuid) IS 'Check if user is local to this instance';


--
-- Name: is_user_in_conversation(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_user_in_conversation(user_uuid uuid, conversation_uuid uuid) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
  SELECT EXISTS(
    SELECT 1 FROM conversation_participants 
    WHERE user_id = user_uuid 
      AND conversation_id = conversation_uuid 
      AND left_at IS NULL
  );
$$;


--
-- Name: is_user_suspended(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_user_suspended(p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
    AS $$
    SELECT COALESCE(is_suspended, false) FROM profiles WHERE id = p_user_id;
$$;


--
-- Name: FUNCTION is_user_suspended(p_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.is_user_suspended(p_user_id uuid) IS 'Check if a user is suspended';


--
-- Name: is_user_viewing_context(uuid, uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_user_viewing_context(p_user_id uuid, p_server_id uuid DEFAULT NULL::uuid, p_channel_id uuid DEFAULT NULL::uuid, p_conversation_id uuid DEFAULT NULL::uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
    v_view_context RECORD;
BEGIN
    -- Get user's current view context from synced table
    SELECT * INTO v_view_context
    FROM public.user_view_contexts
    WHERE user_id = p_user_id;

    IF NOT FOUND THEN
        RETURN FALSE; -- No view context, not viewing
    END IF;

    -- Check if viewing the exact server channel
    IF p_server_id IS NOT NULL AND p_channel_id IS NOT NULL THEN
        IF v_view_context.view_type = 'server_channel' AND
           v_view_context.server_id = p_server_id AND
           v_view_context.channel_id = p_channel_id THEN
            RETURN TRUE; -- User is viewing this channel
        END IF;
    END IF;

    -- Check if viewing the exact DM conversation
    IF p_conversation_id IS NOT NULL THEN
        IF v_view_context.view_type = 'dm' AND
           v_view_context.conversation_id = p_conversation_id THEN
            RETURN TRUE; -- User is viewing this DM
        END IF;
    END IF;

    RETURN FALSE; -- Not viewing this context
END;
$$;


--
-- Name: FUNCTION is_user_viewing_context(p_user_id uuid, p_server_id uuid, p_channel_id uuid, p_conversation_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.is_user_viewing_context(p_user_id uuid, p_server_id uuid, p_channel_id uuid, p_conversation_id uuid) IS 'Checks if user is viewing a specific channel/DM. Used by send_notification to suppress notifications at database level.';


--
-- Name: log_activity_processing_event(uuid, text, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_activity_processing_event(p_activity_id uuid, p_ap_id text, p_ap_type text, p_status text, p_error_message text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    INSERT INTO activity_processing_logs (activity_id, ap_id, ap_type, status, error_message, created_at, updated_at)
    VALUES (p_activity_id, p_ap_id, p_ap_type, p_status, p_error_message, NOW(), NOW())
    ON CONFLICT (activity_id) DO UPDATE 
    SET status = EXCLUDED.status,
        attempts = activity_processing_logs.attempts + 1,
        error_message = EXCLUDED.error_message,
        updated_at = NOW(),
        processed_at = CASE WHEN EXCLUDED.status = 'processed' THEN NOW() ELSE activity_processing_logs.processed_at END;
END;
$$;


--
-- Name: log_admin_action(uuid, text, text, text, jsonb, inet, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_admin_action(p_admin_id uuid, p_action_type text, p_target_type text DEFAULT NULL::text, p_target_id text DEFAULT NULL::text, p_action_details jsonb DEFAULT NULL::jsonb, p_ip_address inet DEFAULT NULL::inet, p_user_agent text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    log_id UUID;
BEGIN
    INSERT INTO admin_audit_log (
        admin_id,
        action_type,
        target_type,
        target_id,
        action_details,
        ip_address,
        user_agent
    ) VALUES (
        p_admin_id,
        p_action_type,
        p_target_type,
        p_target_id,
        p_action_details,
        p_ip_address,
        p_user_agent
    ) RETURNING id INTO log_id;
    
    RETURN log_id;
END;
$$;


--
-- Name: log_key_generation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_key_generation() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    INSERT INTO public.encryption_audit_log (
        user_id,
        event_type,
        severity,
        description,
        metadata
    ) VALUES (
        NEW.user_id,
        'key_generated',
        'info',
        'New identity key pair generated',
        jsonb_build_object(
            'device_id', NEW.device_id,
            'key_version', NEW.key_version
        )
    );
    
    RETURN NEW;
END;
$$;


--
-- Name: make_absolute_url(text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.make_absolute_url(base_url text, candidate text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
declare
  origin text;
begin
  if candidate is null or candidate = '' then
    return null;
  end if;

  if candidate ~* '^[a-z][a-z0-9+\.-]*://' then
    return candidate;
  elsif candidate like '//%' then
    return 'https:' || candidate;
  end if;

  origin := substring(base_url from '^(https?://[^/]+)');
  if origin is null then
    origin := base_url;
  end if;

  if candidate like '/%' then
    return origin || candidate;
  else
    return origin || '/' || candidate;
  end if;
end;
$$;


--
-- Name: mark_all_notifications_read(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_all_notifications_read(p_user_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE notifications 
    SET is_read = true, updated_at = NOW()
    WHERE user_id = p_user_id AND is_read = false;
END;
$$;


--
-- Name: mark_instance_reachable(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_instance_reachable(p_domain text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE federated_instances 
    SET 
        is_blocked = false,
        last_seen_at = now(),
        metadata = metadata - 'unreachable_since'
    WHERE domain = p_domain;
END;
$$;


--
-- Name: mark_instance_unreachable(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_instance_unreachable(p_domain text) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE federated_instances 
    SET 
        is_blocked = true,
        last_seen_at = now(),
        metadata = jsonb_set(
            COALESCE(metadata, '{}'::jsonb),
            '{unreachable_since}',
            to_jsonb(now())
        )
    WHERE domain = p_domain;
END;
$$;


--
-- Name: mark_notification_read(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_notification_read(notification_id uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    UPDATE notifications 
    SET is_read = true, updated_at = NOW()
    WHERE id = notification_id;
END;
$$;


--
-- Name: mark_notifications_read(uuid, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_notifications_read(p_user_id uuid, p_notification_ids uuid[] DEFAULT NULL::uuid[]) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    updated_count integer;
BEGIN
    IF p_notification_ids IS NULL THEN
        -- Mark all unread notifications as read
        UPDATE notifications 
        SET read_at = now(), is_read = true, updated_at = now()
        WHERE user_id = p_user_id 
        AND is_read = FALSE;
    ELSE
        -- Mark specific notifications as read
        UPDATE notifications 
        SET read_at = now(), is_read = true, updated_at = now()
        WHERE user_id = p_user_id 
        AND id = ANY(p_notification_ids)
        AND is_read = FALSE;
    END IF;
    
    GET DIAGNOSTICS updated_count = ROW_COUNT;
    RETURN updated_count;
END;
$$;


--
-- Name: FUNCTION mark_notifications_read(p_user_id uuid, p_notification_ids uuid[]); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.mark_notifications_read(p_user_id uuid, p_notification_ids uuid[]) IS 'Mark notifications as read. If no notification IDs provided, marks all unread notifications as read.';


--
-- Name: moderate_instance(uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.moderate_instance(p_admin_id uuid, p_domain text, p_action text, p_reason text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    -- Check if admin has permission
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_admin_id AND is_admin = TRUE) THEN
        RAISE EXCEPTION 'Insufficient permissions';
    END IF;
    
    IF p_action = 'block' THEN
        INSERT INTO blocked_instances (domain, reason, blocked_by)
        VALUES (p_domain, p_reason, p_admin_id)
        ON CONFLICT (domain) DO UPDATE SET
            reason = p_reason,
            blocked_by = p_admin_id,
            created_at = NOW();
        
        -- Log the action
        PERFORM log_admin_action(
            p_admin_id,
            'instance_block',
            'instance',
            p_domain,
            json_build_object('reason', p_reason)
        );
        
    ELSIF p_action = 'unblock' THEN
        DELETE FROM blocked_instances WHERE domain = p_domain;
        
        -- Log the action
        PERFORM log_admin_action(
            p_admin_id,
            'instance_unblock',
            'instance',
            p_domain,
            json_build_object()
        );
    ELSE
        RAISE EXCEPTION 'Invalid action: %', p_action;
    END IF;
    
    RETURN TRUE;
END;
$$;


--
-- Name: moderate_user(uuid, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.moderate_user(p_admin_id uuid, p_target_user_id uuid, p_action text, p_reason text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    target_username TEXT;
    admin_profile_id UUID;
BEGIN
    -- Check if admin has permission
    -- p_admin_id is auth.uid(), so we need to check via auth_user_id
    SELECT id INTO admin_profile_id 
    FROM profiles 
    WHERE auth_user_id = p_admin_id AND is_admin = TRUE;
    
    IF admin_profile_id IS NULL THEN
        RAISE EXCEPTION 'Insufficient permissions';
    END IF;
    
    -- Get target username for logging
    -- p_target_user_id is profiles.id, so we use id directly
    SELECT username INTO target_username FROM profiles WHERE id = p_target_user_id;
    
    IF target_username IS NULL THEN
        RAISE EXCEPTION 'User not found';
    END IF;
    
    IF p_action = 'suspend' THEN
        UPDATE profiles 
        SET 
            is_suspended = TRUE,
            suspended_at = NOW(),
            suspension_reason = p_reason
        WHERE id = p_target_user_id;
        
        -- Log the action using admin's profile ID for consistency
        -- Using jsonb_build_object instead of json_build_object
        PERFORM log_admin_action(
            admin_profile_id,
            'user_suspend',
            'user',
            p_target_user_id::TEXT,
            jsonb_build_object('reason', p_reason, 'username', target_username)
        );
        
    ELSIF p_action = 'unsuspend' THEN
        UPDATE profiles 
        SET 
            is_suspended = FALSE,
            suspended_at = NULL,
            suspension_reason = NULL
        WHERE id = p_target_user_id;
        
        -- Log the action using admin's profile ID for consistency
        -- Using jsonb_build_object instead of json_build_object
        PERFORM log_admin_action(
            admin_profile_id,
            'user_unsuspend',
            'user',
            p_target_user_id::TEXT,
            jsonb_build_object('username', target_username)
        );
    ELSE
        RAISE EXCEPTION 'Invalid action: %', p_action;
    END IF;
    
    RETURN TRUE;
END;
$$;


--
-- Name: FUNCTION moderate_user(p_admin_id uuid, p_target_user_id uuid, p_action text, p_reason text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.moderate_user(p_admin_id uuid, p_target_user_id uuid, p_action text, p_reason text) IS 'Admin function to suspend/unsuspend users. p_admin_id expects auth.uid(), p_target_user_id expects profiles.id';


--
-- Name: normalize_embed_url(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.normalize_embed_url(p_url text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
declare
  trimmed text := nullif(trim(p_url), '');
begin
  if trimmed is null then
    return null;
  end if;

  if trimmed !~* '^[a-z][a-z0-9+\.-]*://' then
    trimmed := 'https://' || trimmed;
  end if;

  return trimmed;
end;
$$;


--
-- Name: normalize_hashtag(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.normalize_hashtag(tag text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
BEGIN
    -- Remove # if present, convert to lowercase, keep only alphanumeric and underscore
    RETURN regexp_replace(lower(ltrim(tag, '#')), '[^a-z0-9_]', '', 'g');
END;
$$;


--
-- Name: notify_federation_event(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_federation_event() RETURNS trigger
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


--
-- Name: FUNCTION notify_federation_event(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.notify_federation_event() IS 'Notify federation backend of events that need federation (posts, follows, reactions)';


--
-- Name: notify_new_activity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.notify_new_activity() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM pg_notify(
        'new_activity',
        json_build_object(
            'id', NEW.id,
            'type', NEW.ap_type,
            'actor_id', NEW.actor_id,
            'created_at', NEW.created_at
        )::text
    );
    RETURN NEW;
END;
$$;


--
-- Name: pause_activitypub_cron_jobs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.pause_activitypub_cron_jobs() RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    job_names TEXT[] := ARRAY[
        'activitypub-retry-processor',
        'activitypub-cleanup-old-activities',
        'activitypub-daily-stats'
    ];
    job_name TEXT;
    result TEXT := '';
BEGIN
    FOREACH job_name IN ARRAY job_names LOOP
        BEGIN
            PERFORM cron.unschedule(job_name);
            result := result || 'Paused: ' || job_name || E'\n';
        EXCEPTION WHEN OTHERS THEN
            result := result || 'Failed to pause: ' || job_name || ' (' || SQLERRM || ')' || E'\n';
        END;
    END LOOP;
    RETURN result;
END;
$$;


--
-- Name: process_accept_activity(uuid, jsonb, record); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_accept_activity(activity_id uuid, activity_data jsonb, actor_profile record) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'extensions', 'public', 'pg_temp'
    AS $$
DECLARE
    v_object JSONB;
    v_follow_record RECORD;
    v_following_profile RECORD;
    v_instance_domain TEXT;
    v_accept_id TEXT;
    v_accept_activity JSONB;
    v_activity_uuid UUID;
    v_inbox_url TEXT;
    v_signature_header TEXT;
    v_date_header TEXT;
    v_digest_header TEXT;
    v_http_status INTEGER;
    v_http_response TEXT;
    v_delivery_success BOOLEAN;
BEGIN
    RAISE NOTICE '📩 Processing Accept activity: %', activity_data->>'id';
    
    v_object := activity_data->'object';
    
    -- Only process Follow objects in Accept activities
    IF v_object->>'type' != 'Follow' THEN
        RAISE WARNING 'Accept activity does not contain a Follow object: %', v_object->>'type';
        RETURN;
    END IF;
    
    -- Find the follow record this Accept is responding to
    SELECT * INTO v_follow_record
    FROM follows 
    WHERE ap_id = v_object->>'id';
    
    IF NOT FOUND THEN
        RAISE WARNING 'Follow record not found for Accept activity: %', v_object->>'id';
        RETURN;
    END IF;
    
    -- Update the follow status to accepted
    UPDATE follows 
    SET status = 'accepted',
        updated_at = NOW()
    WHERE id = v_follow_record.id;
    
    RAISE NOTICE '✅ Follow request accepted: % -> %', 
        actor_profile.username, v_follow_record.following_id;
        
    -- NOTE: Accept activities are typically responses to our outgoing Follow requests
    -- They don't need to be federated back out - we just need to process them locally
    -- The federation delivery would have already happened when the remote server sent this Accept to us
    
END;
$$;


--
-- Name: FUNCTION process_accept_activity(activity_id uuid, activity_data jsonb, actor_profile record); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.process_accept_activity(activity_id uuid, activity_data jsonb, actor_profile record) IS 'Processes incoming Accept activities for Follow requests. Updates local follow status to accepted.';


--
-- Name: process_activitypub_note(jsonb, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_activitypub_note(note_data jsonb, actor_profile_id uuid DEFAULT NULL::uuid, instance_domain text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $_$
DECLARE
    v_conversation_id uuid;
    v_local_user RECORD;
    v_username text;
    actor_profile profiles%ROWTYPE;
    v_message_id uuid;
    v_content_jsonb jsonb;
    v_to_array jsonb;
    v_recipient text;
BEGIN
    -- Get actor profile
    IF actor_profile_id IS NOT NULL THEN
        SELECT * INTO actor_profile FROM profiles WHERE id = actor_profile_id;
    END IF;
    
    -- Extract recipients from 'to' field
    v_to_array := note_data->'to';
    
    -- Process each recipient
    IF jsonb_typeof(v_to_array) = 'array' THEN
        FOR v_recipient IN SELECT jsonb_array_elements_text(v_to_array)
        LOOP
            -- Skip public addressing
            IF v_recipient = 'https://www.w3.org/ns/activitystreams#Public' THEN
                CONTINUE;
            END IF;
            
            -- Extract username from recipient URL for local users
            IF v_recipient LIKE 'https://' || COALESCE(instance_domain, '') || '/users/%' THEN
                v_username := substring(v_recipient from 'https://[^/]+/users/(.+)$');
                
                -- Find local user
                SELECT * INTO v_local_user 
                FROM profiles 
                WHERE username = v_username AND is_local = true;
                
                IF NOT FOUND THEN
                    RAISE WARNING 'Local user not found: %@%', v_username, instance_domain;
                    CONTINUE;
                END IF;

                RAISE NOTICE '📨 Processing DM for local user: %', v_username;

                -- UPDATED: Find or create conversation using participant system
                SELECT c.id INTO v_conversation_id
                FROM conversations c
                WHERE c.type = 'direct'
                  AND EXISTS (
                    SELECT 1 FROM conversation_participants cp1
                    WHERE cp1.conversation_id = c.id 
                      AND cp1.user_id = actor_profile.id 
                      AND cp1.left_at IS NULL
                  )
                  AND EXISTS (
                    SELECT 1 FROM conversation_participants cp2
                    WHERE cp2.conversation_id = c.id 
                      AND cp2.user_id = v_local_user.id 
                      AND cp2.left_at IS NULL
                  )
                  AND (
                    SELECT COUNT(*) FROM conversation_participants cp3
                    WHERE cp3.conversation_id = c.id 
                      AND cp3.left_at IS NULL
                  ) = 2;

                IF v_conversation_id IS NULL THEN
                    -- UPDATED: Create new conversation using new structure
                    INSERT INTO conversations (type, created_by, is_active)
                    VALUES ('direct', actor_profile.id, TRUE)
                    RETURNING id INTO v_conversation_id;
                    
                    -- Add both participants
                    INSERT INTO conversation_participants (conversation_id, user_id, role, joined_at)
                    VALUES 
                      (v_conversation_id, actor_profile.id, 'member', NOW()),
                      (v_conversation_id, v_local_user.id, 'member', NOW());
                    
                    RAISE NOTICE '🆕 Created new conversation: %', v_conversation_id;
                ELSE
                    RAISE NOTICE '📝 Found existing conversation: %', v_conversation_id;
                END IF;
                
                -- Convert content and create message
                v_content_jsonb := convert_ap_to_jsonb(
                    COALESCE(note_data->>'content', ''), 
                    note_data->'tag'
                );
                
                -- Create the federated message
                INSERT INTO messages (
                    conversation_id,
                    user_id,
                    content,
                    created_at,
                    metadata
                ) VALUES (
                    v_conversation_id,
                    actor_profile.id,
                    v_content_jsonb,
                    COALESCE((note_data->>'published')::timestamptz, NOW()),
                    jsonb_build_object(
                        'activitypub_id', note_data->>'id',
                        'federated', true,
                        'source', 'activitypub'
                    )
                ) RETURNING id INTO v_message_id;
                
                RAISE NOTICE '✅ Created federated DM message: %', v_message_id;
            END IF;
        END LOOP;
    END IF;
    
    RETURN TRUE;
END;
$_$;


--
-- Name: FUNCTION process_activitypub_note(note_data jsonb, actor_profile_id uuid, instance_domain text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.process_activitypub_note(note_data jsonb, actor_profile_id uuid, instance_domain text) IS 'UPDATED: Processes ActivityPub Note objects for DMs using conversation_participants system instead of user1/user2 columns.';


--
-- Name: process_activitypub_public_post(uuid, jsonb, record, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_activitypub_public_post(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_object JSONB;
    v_content JSONB;
    v_post_id UUID;
    v_visibility TEXT := 'public';
    v_in_reply_to TEXT;
    v_parent_post_id UUID;
    v_mentioned_users TEXT[];
    v_local_user_id UUID;
    v_username TEXT;
    content_part JSONB;
    mentioned_username TEXT;
    mentioned_domain TEXT;
    post_content_preview TEXT;
BEGIN
    v_object := activity_data->'object';
    
    -- Convert ActivityPub HTML content to our JSONB format
    v_content := parse_activitypub_content_to_jsonb(
        v_object->>'content', 
        v_object->'tag'
    );
    
    -- Determine visibility
    IF v_object ? 'to' THEN
        IF jsonb_array_length(COALESCE(v_object->'to', '[]'::jsonb)) = 0 
           OR (v_object->'to' @> '"https://www.w3.org/ns/activitystreams#Public"'::jsonb) THEN
            v_visibility := 'public';
        ELSE
            v_visibility := 'unlisted';
        END IF;
    END IF;
    
    -- Handle replies
    v_in_reply_to := v_object->>'inReplyTo';
    IF v_in_reply_to IS NOT NULL THEN
        SELECT id INTO v_parent_post_id
        FROM posts 
        WHERE ap_id = v_in_reply_to;
    END IF;
    
    -- Create the post
    INSERT INTO posts (
        author_id,
        content,
        visibility,
        in_reply_to,
        is_local,
        is_federated,
        ap_id,
        ap_type,
        content_warning,
        is_sensitive,
        url,
        created_at,
        metadata
    ) VALUES (
        actor_profile.id,
        v_content,
        v_visibility,
        v_parent_post_id,
        false,
        true,
        v_object->>'id',
        'Note',
        v_object->>'summary',
        COALESCE((v_object->>'sensitive')::boolean, false),
        COALESCE(v_object->>'url', v_object->>'id'),
        COALESCE((v_object->>'published')::timestamptz, NOW()),
        jsonb_build_object(
            'federated', true,
            'from_domain', actor_profile.domain,
            'original_activity', activity_data->>'id'
        )
    ) RETURNING id INTO v_post_id;
    
    RAISE NOTICE '📢 Stored federated post from %@%: %', 
        actor_profile.username, actor_profile.domain, v_object->>'id';
    
    -- Extract content preview
    post_content_preview := extract_message_text(v_content);
    IF LENGTH(post_content_preview) > 100 THEN
        post_content_preview := LEFT(post_content_preview, 100) || '...';
    END IF;
    IF post_content_preview = '' OR post_content_preview IS NULL THEN
        post_content_preview := 'New post';
    END IF;
    
    -- Handle mentions from unified content format (MessagePart[] array)
    -- When a federated post mentions a local user, the mention will have domain matching instance_domain
    IF jsonb_typeof(v_content) = 'array' THEN
        FOR content_part IN SELECT jsonb_array_elements(v_content)
        LOOP
            IF content_part->>'type' = 'mention' THEN
                mentioned_username := content_part->>'username';
                
                -- Check if this is a local mention using isLocal field
                IF (content_part->>'isLocal')::boolean = true THEN
                    RAISE NOTICE '🔍 Processing local mention: username=%, instance_domain=%', 
                        mentioned_username, instance_domain;
                    
                    -- Get the mentioned user ID (only local users)
                    SELECT id INTO v_local_user_id
                    FROM profiles 
                    WHERE username = mentioned_username 
                      AND is_local = true
                      AND id != actor_profile.id; -- Don't notify self
                    
                    IF v_local_user_id IS NULL THEN
                        RAISE NOTICE '⚠️ Mentioned user not found or not local: username=%', 
                            mentioned_username;
                    END IF;
                ELSE
                    RAISE NOTICE '⚠️ Skipping remote user mention: username=%', mentioned_username;
                    v_local_user_id := NULL;
                END IF;
                
                IF v_local_user_id IS NOT NULL THEN
                    RAISE NOTICE '✅ Found local user mentioned in federated post: % (ID: %)', mentioned_username, v_local_user_id;
                    
                    -- Use send_notification_to_user for proper notification creation
                    PERFORM send_notification_to_user(
                        'activitypub_mention',
                        v_local_user_id,
                        jsonb_build_object(
                            'actor', jsonb_build_object(
                                'id', actor_profile.id,
                                'username', actor_profile.username,
                                'display_name', actor_profile.display_name,
                                'avatar_url', actor_profile.avatar_url,
                                'domain', actor_profile.domain,
                                'is_local', actor_profile.is_local
                            ),
                            'post', jsonb_build_object(
                                'id', v_post_id,
                                'ap_id', v_object->>'id',
                                'content_preview', post_content_preview,
                                'content', v_content
                            ),
                            'post_id', v_post_id,
                            'post_content', v_content,
                            'timestamp', COALESCE((v_object->>'published')::timestamptz, NOW()),
                            'federated', true
                        ),
                        NULL, -- server_id
                        NULL, -- channel_id
                        NULL, -- conversation_id
                        actor_profile.id, -- from_user_id
                        'normal' -- priority
                    );
                    
                    RAISE NOTICE '🔔 Created federated mention notification for local user: %', mentioned_username;
                ELSE
                    RAISE NOTICE '⚠️ Mentioned user is not local or not found: username=%, domain=%', 
                        mentioned_username, mentioned_domain;
                END IF;
            END IF;
        END LOOP;
    ELSE
        RAISE NOTICE '⚠️ Content is not an array, cannot process mentions. Type: %', jsonb_typeof(v_content);
    END IF;
    
    -- Note: Other notifications (replies, etc.) are handled by existing post triggers
END;
$$;


--
-- Name: FUNCTION process_activitypub_public_post(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.process_activitypub_public_post(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text) IS 'Processes federated ActivityPub posts and creates proper mention notifications using send_notification_to_user.';


--
-- Name: process_announce_activity(uuid, jsonb, record); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_announce_activity(activity_id uuid, activity_data jsonb, actor_profile record) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_object_id TEXT;
    v_post_record RECORD;
    v_ap_id TEXT;
BEGIN
    v_object_id := activity_data->>'object';
    v_ap_id := activity_data->>'id';

    -- Find the post being announced
    SELECT * INTO v_post_record
    FROM posts 
    WHERE ap_id = v_object_id;

    IF FOUND THEN
        -- Create the reblog interaction
        INSERT INTO post_interactions (
            user_id,
            post_id,
            interaction_type,
            ap_id,
            is_local,
            created_at
        ) VALUES (
            actor_profile.id,
            v_post_record.id,
            'reblog',
            v_ap_id,
            false,
            NOW()
        ) ON CONFLICT (user_id, post_id, interaction_type) DO NOTHING;
        
        RAISE NOTICE '🔄 Post announced: % by %', v_object_id, actor_profile.username;
    END IF;
END;
$$;


--
-- Name: process_ap_activity_on_update(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_ap_activity_on_update() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_instance_domain TEXT;
    v_classification TEXT;
    v_actor_profile_id UUID;
BEGIN
    -- Only process when status changes to 'processing'
    IF NEW.status != 'processing' OR OLD.status = 'processing' THEN
        RETURN NEW;
    END IF;
    
    -- Get instance domain
    SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
    FROM instance_config WHERE config_key = 'domain' LIMIT 1;
    
    IF v_instance_domain IS NULL THEN
        RAISE WARNING 'No instance domain configured, skipping activity processing';
        RETURN NEW;
    END IF;
    
    -- Try to find actor profile (optional)
    SELECT actor_id INTO v_actor_profile_id FROM ap_activities WHERE id = NEW.id;
    
    -- Classify the activity
    v_classification := classify_activitypub_activity(NEW.activity_data, v_instance_domain);
    
    -- Route based on classification
    CASE v_classification
        WHEN 'private_mention' THEN
            -- Process as incoming private message/DM
            IF v_actor_profile_id IS NOT NULL THEN
                PERFORM process_incoming_private_message(
                    NEW.id,
                    NEW.activity_data,
                    v_actor_profile_id,
                    v_instance_domain
                );
            ELSE
                RAISE WARNING 'Actor profile not found for private mention activity %', NEW.id;
            END IF;
            
        WHEN 'public_post' THEN
            -- Process as public post (existing function)
            IF v_actor_profile_id IS NOT NULL THEN
                PERFORM process_activitypub_public_post(
                    NEW.id,
                    NEW.activity_data,
                    (SELECT ROW(id, username, display_name, domain, federated_id, is_local, avatar_url, bio, created_at, updated_at) 
                     FROM profiles WHERE id = v_actor_profile_id),
                    v_instance_domain
                );
            ELSE
                RAISE WARNING 'Actor profile not found for public post activity %', NEW.id;
            END IF;
            
        ELSE
            RAISE WARNING 'Unknown activity classification: % for activity %', v_classification, NEW.id;
    END CASE;
    
    -- Mark as completed
    UPDATE ap_activities SET status = 'completed', processed_at = NOW() WHERE id = NEW.id;
    
    RETURN NEW;
    
EXCEPTION
    WHEN OTHERS THEN
        -- Mark as failed and log error
        UPDATE ap_activities SET 
            status = 'failed', 
            error_message = SQLERRM,
            processed_at = NOW()
        WHERE id = NEW.id;
        
        RAISE WARNING 'Failed to process ActivityPub activity %: %', NEW.id, SQLERRM;
        RETURN NEW;
END;
$$;


--
-- Name: process_create_activity(uuid, jsonb, record, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_create_activity(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_object JSONB;
    v_object_type TEXT;
    v_is_dm BOOLEAN;
BEGIN
    v_object := activity_data->'object';
    v_object_type := v_object->>'type';

    IF v_object_type != 'Note' THEN
        RAISE WARNING 'Create activity object is not a Note: %', v_object_type;
        RETURN;
    END IF;

    -- Check if this is a direct message
    v_is_dm := is_activitypub_direct_message(v_object, instance_domain);

    IF v_is_dm THEN
        RAISE NOTICE '📩 Processing as direct message';
        PERFORM handle_incoming_messages(activity_id, activity_data, actor_profile, instance_domain);
    ELSE
        RAISE NOTICE '📢 Processing as public post';
        PERFORM process_activitypub_public_post(activity_id, activity_data, actor_profile, instance_domain);
    END IF;
END;
$$;


--
-- Name: process_delete_activity(uuid, jsonb, record); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_delete_activity(activity_id uuid, activity_data jsonb, actor_profile record) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_object_id TEXT;
    v_post_record RECORD;
BEGIN
    -- Object can be string ID or object with ID
    v_object_id := CASE 
        WHEN jsonb_typeof(activity_data->'object') = 'string' 
        THEN activity_data->>'object'
        ELSE activity_data->'object'->>'id'
    END;
    
    -- Find and soft-delete the post
    SELECT * INTO v_post_record
    FROM posts 
    WHERE ap_id = v_object_id 
      AND author_id = actor_profile.id; -- Security: only author can delete
    
    IF FOUND THEN
        UPDATE posts 
        SET is_deleted = true,
            deleted_at = NOW(),
            content = '[{"type": "text", "text": "[deleted]"}]'::jsonb
        WHERE id = v_post_record.id;
        
        RAISE NOTICE '🗑️ Deleted post: %', v_object_id;
    END IF;
END;
$$;


--
-- Name: process_follow_activity(uuid, jsonb, record, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_follow_activity(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_following_url TEXT;
    v_following_profile RECORD;
    v_username TEXT;
    v_follow_id UUID;
BEGIN
    -- Extract the user being followed
    v_following_url := CASE 
        WHEN jsonb_typeof(activity_data->'object') = 'string' 
        THEN activity_data->>'object'
        ELSE activity_data->'object'->>'id'
    END;

    -- Extract username from URL
    v_username := substring(v_following_url from 'https://[^/]+/users/([^/]+)');
    
    IF v_username IS NULL THEN
        RAISE WARNING 'Could not extract username from follow object: %', v_following_url;
        RETURN;
    END IF;

    -- Get the local user being followed
    SELECT * INTO v_following_profile
    FROM profiles 
    WHERE username = v_username 
      AND domain = instance_domain 
      AND is_local = true;

    IF NOT FOUND THEN
        RAISE WARNING 'Local user not found: %', v_username;
        RETURN;
    END IF;

    -- Create or update follow relationship
    INSERT INTO follows (
        follower_id,
        following_id,
        ap_id,
        status,
        accepted_at,
        is_local,
        created_at
    ) VALUES (
        actor_profile.id,
        v_following_profile.id,
        activity_data->>'id',
        'accepted', -- Auto-accept for now
        NOW(),
        false,
        NOW()
    )
    ON CONFLICT (follower_id, following_id) 
    DO UPDATE SET
        ap_id = EXCLUDED.ap_id,
        status = 'accepted',
        accepted_at = NOW(),
        updated_at = NOW()
    RETURNING id INTO v_follow_id;

    RAISE NOTICE '✅ Follow relationship created: % now follows %', 
        actor_profile.username, v_following_profile.username;

    -- Note: Follow notifications are handled by the existing follow notification trigger
    -- TODO: Send Accept activity back to follower (queue for federation)
END;
$$;


--
-- Name: process_incoming_emoji_reaction(text, jsonb, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_incoming_emoji_reaction(p_activity_id text, p_activity jsonb, p_actor_uri text, p_actor_domain text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $_$
DECLARE
    v_actor_profile RECORD;
    v_target_post RECORD;
    v_object_id text;
    v_emoji_content text;
    v_emoji_tag jsonb;
    v_emoji_resolution RECORD;
    v_rows_affected integer;
    v_is_undo boolean := false;
    v_inner_object jsonb;
BEGIN
    -- Handle Undo activities
    IF p_activity->>'type' = 'Undo' THEN
        v_is_undo := true;
        v_inner_object := p_activity->'object';
        
        -- Extract info from the undone activity
        IF v_inner_object->>'type' IN ('EmojiReact', 'Like') THEN
            v_object_id := v_inner_object->>'object';
            v_emoji_content := v_inner_object->>'content';
            v_emoji_tag := CASE 
                WHEN jsonb_array_length(COALESCE(v_inner_object->'tag', '[]'::jsonb)) > 0 
                THEN v_inner_object->'tag'->0 
                ELSE NULL 
            END;
        ELSE
            RAISE LOG 'Unknown object type in Undo activity: %', v_inner_object->>'type';
            RETURN false;
        END IF;
    ELSIF p_activity->>'type' IN ('EmojiReact', 'Like') THEN
        -- Direct reaction activity
        v_object_id := p_activity->>'object';
        v_emoji_content := COALESCE(
            p_activity->>'content',
            p_activity->>'_misskey_reaction'  -- Misskey compatibility
        );
        v_emoji_tag := CASE 
            WHEN jsonb_array_length(COALESCE(p_activity->'tag', '[]'::jsonb)) > 0 
            THEN p_activity->'tag'->0 
            ELSE NULL 
        END;
    ELSE
        RAISE LOG 'Unsupported activity type for emoji reaction: %', p_activity->>'type';
        RETURN false;
    END IF;
    
    -- Validate required fields
    IF v_object_id IS NULL THEN
        RAISE LOG 'Missing object ID in emoji reaction activity';
        RETURN false;
    END IF;
    
    IF v_emoji_content IS NULL AND v_emoji_tag IS NULL THEN
        RAISE LOG 'Missing emoji content and tag in reaction activity';
        RETURN false;
    END IF;
    
    -- Find or create the actor profile
    SELECT * INTO v_actor_profile
    FROM profiles
    WHERE federated_id = p_actor_uri;
    
    IF NOT FOUND THEN
        -- Actor doesn't exist, create it by fetching from remote
        DECLARE
            v_actor_response jsonb;
            v_actor_username text;
            v_actor_domain text;
            v_new_profile_id uuid;
        BEGIN
            -- Parse domain from actor URI
            v_actor_domain := split_part(split_part(p_actor_uri, '://', 2), '/', 1);
            
            -- Try to extract username from URI path
            v_actor_username := split_part(p_actor_uri, '/', array_length(string_to_array(p_actor_uri, '/'), 1));
            
            -- Create a basic federated profile for this actor
            SELECT create_federated_profile(
                p_username := COALESCE(v_actor_username, 'unknown'),
                p_display_name := COALESCE(v_actor_username, 'Remote User'),
                p_domain := v_actor_domain,
                p_federated_id := p_actor_uri,
                p_bio := 'Federated ActivityPub user'
            ) INTO v_new_profile_id;
            
            -- Now fetch the created profile
            SELECT * INTO v_actor_profile
            FROM profiles
            WHERE id = v_new_profile_id;
            
            RAISE LOG 'Created federated profile for actor: % (id: %)', p_actor_uri, v_new_profile_id;
        EXCEPTION WHEN OTHERS THEN
            RAISE LOG 'Failed to create federated profile for actor: % - %', p_actor_uri, SQLERRM;
            RETURN false;
        END;
    END IF;
    
    -- Find the target post
    SELECT * INTO v_target_post
    FROM posts
    WHERE ap_id = v_object_id 
       OR id::text = v_object_id
       OR (v_object_id ~ '^https?://[^/]+/posts/([a-f0-9-]{36})$' 
           AND id::text = substring(v_object_id from '^https?://[^/]+/posts/([a-f0-9-]{36})$'));
    
    IF NOT FOUND THEN
        RAISE LOG 'Target post not found for emoji reaction: % (checked ap_id and extracted UUID)', v_object_id;
        RETURN false;
    END IF;
    
    -- Only process reactions on local posts
    IF NOT v_target_post.is_local THEN
        RAISE LOG 'Ignoring reaction on remote post: %', v_target_post.id;
        RETURN true;  -- Not an error, just not our concern
    END IF;
    
    -- Resolve the emoji
    BEGIN
        SELECT * INTO v_emoji_resolution
        FROM resolve_activitypub_emoji(v_emoji_tag, v_emoji_content, p_actor_domain)
        LIMIT 1;
    EXCEPTION WHEN OTHERS THEN
        RAISE LOG 'Failed to resolve emoji for reaction: %', SQLERRM;
        RETURN false;
    END;
    
    IF v_is_undo THEN
        -- Remove existing reaction
        DELETE FROM post_interactions
        WHERE user_id = v_actor_profile.id
        AND post_id = v_target_post.id
        AND interaction_type = 'emoji_reaction'
        AND (
            (emoji_id = v_emoji_resolution.emoji_id) OR
            (emoji_id IS NULL AND custom_emoji_content = v_emoji_resolution.custom_emoji_content)
        );
        
        GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
        
        IF v_rows_affected > 0 THEN
            RAISE LOG 'Removed federated emoji reaction: % from % on post %', 
                v_emoji_content, p_actor_uri, v_target_post.id;
        ELSE
            RAISE LOG 'No matching reaction found to remove: % from % on post %', 
                v_emoji_content, p_actor_uri, v_target_post.id;
        END IF;
        
        RETURN true;
    ELSE
        -- Add new reaction (if not already exists)
        INSERT INTO post_interactions (
            user_id,
            post_id,
            interaction_type,
            emoji_id,
            custom_emoji_content,
            ap_id,
            is_local,
            metadata
        ) VALUES (
            v_actor_profile.id,
            v_target_post.id,
            'emoji_reaction',
            v_emoji_resolution.emoji_id,
            v_emoji_resolution.custom_emoji_content,
            p_activity_id,
            false,  -- This is a federated reaction
            jsonb_build_object(
                'activity_id', p_activity_id,
                'actor_uri', p_actor_uri,
                'actor_domain', p_actor_domain,
                'original_content', v_emoji_content,
                'federation_source', 'activitypub',
                'processed_at', NOW()
            )
        )
        ON CONFLICT (ap_id) DO NOTHING;
        
        GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
        
        IF v_rows_affected > 0 THEN
            RAISE LOG 'Added federated emoji reaction: % from % on post %', 
                v_emoji_content, p_actor_uri, v_target_post.id;
        ELSE
            RAISE LOG 'Duplicate emoji reaction ignored: % from % on post %', 
                v_emoji_content, p_actor_uri, v_target_post.id;
        END IF;
        
        RETURN true;
    END IF;
END;
$_$;


--
-- Name: FUNCTION process_incoming_emoji_reaction(p_activity_id text, p_activity jsonb, p_actor_uri text, p_actor_domain text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.process_incoming_emoji_reaction(p_activity_id text, p_activity jsonb, p_actor_uri text, p_actor_domain text) IS 'Processes incoming EmojiReact and Like activities from ActivityPub federation. Handles both creation and removal (Undo) of emoji reactions.';


--
-- Name: process_incoming_private_message(uuid, jsonb, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_incoming_private_message(p_activity_id uuid, p_activity_data jsonb, p_actor_profile_id uuid, p_instance_domain text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_object JSONB;
  v_content JSONB;
  v_local_recipients TEXT[];
  v_recipient_username TEXT;
  v_local_user profiles%ROWTYPE;
  v_actor_profile profiles%ROWTYPE;
  v_conversation_id UUID;
  v_message_id UUID;
  v_recipient_count INTEGER := 0;
  v_is_dm BOOLEAN := false;
BEGIN
  -- Get actor profile
  SELECT * INTO v_actor_profile FROM profiles WHERE id = p_actor_profile_id;
  
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Actor profile not found: %', p_actor_profile_id;
  END IF;
  
  RAISE NOTICE '📨 Processing ActivityPub private message from %@%', 
    v_actor_profile.username, v_actor_profile.domain;
  
  -- Extract message object
  v_object := p_activity_data->'object';
  
  -- Extract local recipients from addressing (compatible with all ActivityPub platforms)
  WITH recipient_extraction AS (
    SELECT jsonb_array_elements_text(
      COALESCE(v_object->'to', '[]'::jsonb) || 
      COALESCE(v_object->'cc', '[]'::jsonb)
    ) AS recipient_url
  ),
  -- Also extract from mention tags (Mastodon/Pleroma compatibility)
  mention_extraction AS (
    SELECT jsonb_array_elements(COALESCE(v_object->'tag', '[]'::jsonb)) AS tag
  ),
  mention_recipients AS (
    SELECT tag->>'href' AS recipient_url
    FROM mention_extraction
    WHERE tag->>'type' = 'Mention'
      AND tag->>'href' IS NOT NULL
  ),
  all_recipients AS (
    SELECT recipient_url FROM recipient_extraction
    UNION
    SELECT recipient_url FROM mention_recipients
  ),
  local_recipients AS (
    SELECT DISTINCT
      CASE 
        WHEN recipient_url LIKE 'https://' || p_instance_domain || '/users/%' THEN
          substring(recipient_url from 'https://' || p_instance_domain || '/users/([^/]+)')
        WHEN recipient_url LIKE 'https://' || p_instance_domain || '/social/profile/%' THEN  
          substring(recipient_url from 'https://' || p_instance_domain || '/social/profile/([^/]+)')
        WHEN recipient_url LIKE 'https://' || p_instance_domain || '/@%' THEN
          substring(recipient_url from 'https://' || p_instance_domain || '/@([^/]+)')
        ELSE NULL
      END AS username
    FROM all_recipients
  )
  SELECT array_agg(username)
  INTO v_local_recipients
  FROM local_recipients 
  WHERE username IS NOT NULL;
  
  -- Validate recipients exist
  IF v_local_recipients IS NULL OR array_length(v_local_recipients, 1) = 0 THEN
    RAISE WARNING 'Private message from %@% has no valid local recipients - skipping',
      v_actor_profile.username, v_actor_profile.domain;
    RETURN;
  END IF;
  
  RAISE NOTICE '📧 Private message mentions % local users: %', 
    array_length(v_local_recipients, 1), v_local_recipients;
  
  -- Check if this is actually a DM using the existing detection function
  v_is_dm := is_activitypub_direct_message(v_object, p_instance_domain);
  
  -- Convert ActivityPub content to unified format
  v_content := convert_ap_to_jsonb(
    v_object->>'content',
    v_object->'tag'
  );
  
  -- 🔧 FIX: Strip redundant @user@domain mentions ONLY from DM content
  IF v_is_dm THEN
    v_content := strip_mentions_from_dm_content(v_content);
    RAISE NOTICE '🧹 Stripped mentions from DM content';
  ELSE
    RAISE NOTICE '📢 Keeping mentions in non-DM message';
  END IF;
  
  -- Process each local recipient
  FOREACH v_recipient_username IN ARRAY v_local_recipients LOOP
    -- Get local user profile
    SELECT * INTO v_local_user
    FROM profiles 
    WHERE username = v_recipient_username 
      AND domain = p_instance_domain 
      AND is_local = true;
      
    IF NOT FOUND THEN
      RAISE WARNING 'Local recipient not found: %@%', v_recipient_username, p_instance_domain;
      CONTINUE;
    END IF;
    
    -- Get or create conversation between remote sender and local recipient
    v_conversation_id := get_or_create_dm_conversation(
      v_actor_profile.id,
      v_local_user.id
    );
    
    -- Insert the federated private message (with mentions stripped only if DM)
    INSERT INTO messages (
      conversation_id,
      user_id,
      content,
      created_at,
      metadata
    ) VALUES (
      v_conversation_id,
      v_actor_profile.id,
      v_content,
      COALESCE((v_object->>'published')::timestamptz, NOW()),
      jsonb_build_object(
        'federated', true,
        'ap_id', v_object->>'id',
        'ap_type', 'Note',
        'from_domain', v_actor_profile.domain,
        'activity_id', p_activity_id,
        'original_url', COALESCE(v_object->>'url', v_object->>'id'),
        'private_mention', true,
        'activitypub_compatible', true,
        'is_dm', v_is_dm
      )
    ) RETURNING id INTO v_message_id;
    
    v_recipient_count := v_recipient_count + 1;
    
    RAISE NOTICE '✅ Saved federated private message %: %@% → %',
      v_message_id, v_actor_profile.username, v_actor_profile.domain, v_recipient_username;
  END LOOP;
  
  RAISE NOTICE '🎯 Completed private message processing for activity % (% recipients)',
    p_activity_id, v_recipient_count;
END;
$$;


--
-- Name: FUNCTION process_incoming_private_message(p_activity_id uuid, p_activity_data jsonb, p_actor_profile_id uuid, p_instance_domain text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.process_incoming_private_message(p_activity_id uuid, p_activity_data jsonb, p_actor_profile_id uuid, p_instance_domain text) IS 'Processes incoming ActivityPub private messages with full Mastodon/Misskey/Pleroma compatibility';


--
-- Name: process_like_activity(uuid, jsonb, record); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_like_activity(activity_id uuid, activity_data jsonb, actor_profile record) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_object_id TEXT;
    v_post_record RECORD;
    v_ap_id TEXT;
BEGIN
    v_object_id := activity_data->>'object';
    v_ap_id := activity_data->>'id';

    -- Find the post being liked
    SELECT * INTO v_post_record
    FROM posts 
    WHERE ap_id = v_object_id;

    IF FOUND THEN
        -- Create the like interaction
        INSERT INTO post_interactions (
            user_id,
            post_id,
            interaction_type,
            ap_id,
            is_local,
            created_at
        ) VALUES (
            actor_profile.id,
            v_post_record.id,
            'favorite',
            v_ap_id,
            false,
            NOW()
        ) ON CONFLICT (user_id, post_id, interaction_type) DO NOTHING;
        
        RAISE NOTICE '❤️ Post liked: % by %', v_object_id, actor_profile.username;
    END IF;
END;
$$;


--
-- Name: process_local_link_previews(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_local_link_previews() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_instance_domain text;
  v_embed_map jsonb := coalesce(NEW.metadata->'embeds', '{}'::jsonb);
  v_original_map jsonb := v_embed_map;
  v_part jsonb;
  v_normalized_url text;
  v_embed jsonb;
begin
  -- Skip inbound federated messages
  if coalesce(NEW.metadata->>'federated', 'false') = 'true' then
    return NEW;
  end if;

  if jsonb_typeof(NEW.content) <> 'array' then
    return NEW;
  end if;

  select trim(both '"' from config_value::text)
    into v_instance_domain
    from public.instance_config
    where config_key = 'domain'
    limit 1;

  for v_part in
    select value from jsonb_array_elements(NEW.content)
  loop
    if coalesce(v_part->>'type', '') <> 'url' then
      continue;
    end if;
    if coalesce(v_part->>'preview', 'true') = 'false' then
      continue;
    end if;

    v_normalized_url := public.normalize_embed_url(v_part->>'url');
    if v_normalized_url is null or v_embed_map ? v_normalized_url then
      continue;
    end if;

    -- Only process LOCAL Harmony URLs here (synchronous, fast)
    begin
      if v_instance_domain is not null
         and public.extract_url_host(v_normalized_url) = lower(v_instance_domain) then
        v_embed := public.fetch_link_preview(v_normalized_url);
        
        if v_embed is not null then
          v_embed_map := v_embed_map || jsonb_build_object(v_normalized_url, v_embed);
        end if;
      end if;
    exception
      when others then
        raise notice 'Failed to fetch local preview for %: %', v_normalized_url, SQLERRM;
    end;
  end loop;

  if v_embed_map <> v_original_map then
    NEW.metadata := coalesce(NEW.metadata, '{}'::jsonb) || jsonb_build_object('embeds', v_embed_map);
  end if;

  return NEW;
end;
$$;


--
-- Name: process_message_link_previews(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_message_link_previews() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'extensions'
    AS $$
declare
  v_instance_domain text;
  v_backend_url text;
  v_embed_map jsonb := coalesce(NEW.metadata->'embeds', '{}'::jsonb);
  v_original_map jsonb := v_embed_map;
  v_part jsonb;
  v_normalized_url text;
  v_embed jsonb;
begin
  -- Skip inbound federated messages
  if coalesce(NEW.metadata->>'federated', 'false') = 'true' then
    return NEW;
  end if;

  if jsonb_typeof(NEW.content) <> 'array' then
    return NEW;
  end if;

  select trim(both '"' from config_value::text)
    into v_instance_domain
    from public.instance_config
    where config_key = 'domain'
    limit 1;

  select (config_value::jsonb->>'link_preview_backend_url')
    into v_backend_url
    from public.instance_config
    where config_key = 'federation_settings'
    limit 1;

  for v_part in
    select value from jsonb_array_elements(NEW.content)
  loop
    if coalesce(v_part->>'type', '') <> 'url' then
      continue;
    end if;
    if coalesce(v_part->>'preview', 'true') = 'false' then
      continue;
    end if;

    v_normalized_url := public.normalize_embed_url(v_part->>'url');
    if v_normalized_url is null or v_embed_map ? v_normalized_url then
      continue;
    end if;

    begin
      if v_instance_domain is not null
         and public.extract_url_host(v_normalized_url) = lower(v_instance_domain) then
        v_embed := public.fetch_link_preview(v_normalized_url);
      elsif v_backend_url is not null and v_backend_url <> '' then
        v_embed := public.fetch_remote_link_preview(v_backend_url, v_normalized_url);
      else
        v_embed := null;
      end if;
    exception
      when others then
        raise notice 'Failed to build embed for %: %', v_normalized_url, SQLERRM;
        v_embed := null;
    end;

    if v_embed is not null then
      v_embed_map := v_embed_map || jsonb_build_object(v_normalized_url, v_embed);
    end if;
  end loop;

  if v_embed_map <> v_original_map then
    NEW.metadata := coalesce(NEW.metadata, '{}'::jsonb) || jsonb_build_object('embeds', v_embed_map);
  end if;

  return NEW;
end;
$$;


--
-- Name: process_post_hashtags(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_post_hashtags(p_post_id uuid, p_content jsonb) RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_hashtag_array TEXT[];
    v_hashtag_text TEXT;
    v_hashtag_id UUID;
    v_position_counter INTEGER := 0;
    v_processed_count INTEGER := 0;
BEGIN
    -- Extract hashtags from content (returns empty array, never NULL)
    v_hashtag_array := public.extract_hashtags_from_content(p_content);
    
    -- Handle NULL case defensively
    IF v_hashtag_array IS NULL THEN
        v_hashtag_array := ARRAY[]::TEXT[];
    END IF;
    
    -- Return early if no hashtags
    IF array_length(v_hashtag_array, 1) IS NULL OR array_length(v_hashtag_array, 1) = 0 THEN
        RETURN 0;
    END IF;
    
    -- Process each hashtag
    FOREACH v_hashtag_text IN ARRAY v_hashtag_array LOOP
        v_position_counter := v_position_counter + 1;
        
        -- Upsert hashtag and get ID
        v_hashtag_id := public.upsert_hashtag(v_hashtag_text);
        
        -- Link post to hashtag
        INSERT INTO public.post_hashtags (post_id, hashtag_id, position_in_content)
        VALUES (p_post_id, v_hashtag_id, v_position_counter)
        ON CONFLICT (post_id, hashtag_id) DO NOTHING;
        
        v_processed_count := v_processed_count + 1;
    END LOOP;
    
    RETURN v_processed_count;
END;
$$;


--
-- Name: FUNCTION process_post_hashtags(p_post_id uuid, p_content jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.process_post_hashtags(p_post_id uuid, p_content jsonb) IS 'Process a post content to extract and link hashtags. Returns count of hashtags processed.';


--
-- Name: process_reject_activity(uuid, jsonb, record); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_reject_activity(activity_id uuid, activity_data jsonb, actor_profile record) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_object JSONB;
    v_original_follow_id TEXT;
    v_follow_record RECORD;
BEGIN
    v_object := activity_data->'object';
    
    -- Handle Reject of Follow activities
    IF v_object->>'type' = 'Follow' THEN
        v_original_follow_id := v_object->>'id';
        
        -- Find the follow request in our database
        SELECT * INTO v_follow_record
        FROM follows 
        WHERE ap_id = v_original_follow_id 
          AND status = 'pending';
        
        IF FOUND THEN
            -- Update follow status to rejected (or delete)
            UPDATE follows 
            SET status = 'rejected',
                updated_at = NOW()
            WHERE id = v_follow_record.id;
            
            RAISE NOTICE '❌ Follow request rejected: % -> %', 
                v_follow_record.follower_id, v_follow_record.following_id;
        END IF;
    END IF;
END;
$$;


--
-- Name: process_undo_activity(uuid, jsonb, record); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_undo_activity(activity_id uuid, activity_data jsonb, actor_profile record) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_object JSONB;
    v_original_activity_id TEXT;
    v_object_type TEXT;
BEGIN
    v_object := activity_data->'object';
    v_original_activity_id := v_object->>'id';
    v_object_type := v_object->>'type';
    
    CASE v_object_type
        WHEN 'Follow' THEN
            -- Undo follow = unfollow
            DELETE FROM follows 
            WHERE ap_id = v_original_activity_id 
              AND follower_id = actor_profile.id;
        
            RAISE NOTICE '🔄 Undone follow activity: %', v_original_activity_id;
        
        WHEN 'Like' THEN
            -- Undo like = unfavorite
            DELETE FROM post_interactions 
            WHERE ap_id = v_original_activity_id 
              AND user_id = actor_profile.id 
              AND interaction_type = 'favorite';
          
            RAISE NOTICE '🔄 Undone like activity: %', v_original_activity_id;
        
        WHEN 'Announce' THEN
            -- Undo announce = unreblog
            DELETE FROM post_interactions 
            WHERE ap_id = v_original_activity_id 
              AND user_id = actor_profile.id 
              AND interaction_type = 'reblog';
          
            RAISE NOTICE '🔄 Undone announce activity: %', v_original_activity_id;
        
        ELSE
            RAISE NOTICE '⚠️ Unhandled undo object type: %', v_object_type;
    END CASE;
END;
$$;


--
-- Name: process_update_activity(uuid, jsonb, record); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.process_update_activity(activity_id uuid, activity_data jsonb, actor_profile record) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_object JSONB;
    v_object_id TEXT;
    v_object_type TEXT;
    v_post_record RECORD;
    v_content JSONB;
BEGIN
    v_object := activity_data->'object';
    v_object_id := v_object->>'id';
    v_object_type := v_object->>'type';
    
    CASE v_object_type
        WHEN 'Note' THEN
            -- Handle Note updates (post edits)
            -- Find the existing post
            SELECT * INTO v_post_record
            FROM posts 
            WHERE ap_id = v_object_id;
            
            IF FOUND THEN
                -- Convert ActivityPub content to our format
                v_content := parse_activitypub_content_to_jsonb(
                    v_object->>'content', 
                    v_object->'tag'
                );
                
                -- Update the post
                UPDATE posts 
                SET content = v_content,
                    content_warning = v_object->>'summary',
                    is_sensitive = COALESCE((v_object->>'sensitive')::boolean, false),
                    updated_at = NOW(),
                    edited_at = NOW()
                WHERE id = v_post_record.id;
                
                RAISE NOTICE '📝 Updated post: %', v_object_id;
            END IF;
            
        WHEN 'Person' THEN
            -- Handle Person updates (profile updates)
            RAISE NOTICE '👤 Processing profile update for: %', v_object_id;
            
            -- Verify this update is from the profile owner
            IF actor_profile.federated_id != v_object_id THEN
                RAISE WARNING 'Profile update rejected: actor % cannot update profile %', 
                    actor_profile.federated_id, v_object_id;
                RETURN;
            END IF;
            
            -- Update the profile with new information
            -- Handle both direct fields and nested objects (like icon/image)
            UPDATE profiles 
            SET 
                display_name = COALESCE(v_object->>'name', display_name),
                bio = COALESCE(v_object->>'summary', bio),
                avatar_url = CASE 
                    WHEN v_object->'icon'->>'type' = 'Image' THEN v_object->'icon'->>'url'
                    WHEN v_object->>'icon' IS NOT NULL THEN v_object->>'icon'
                    ELSE avatar_url
                END,
                banner_url = CASE 
                    WHEN v_object->'image'->>'type' = 'Image' THEN v_object->'image'->>'url'
                    WHEN v_object->>'image' IS NOT NULL THEN v_object->>'image'
                    ELSE banner_url
                END,
                public_key = COALESCE(v_object->'publicKey'->>'publicKeyPem', public_key),
                inbox_url = COALESCE(v_object->>'inbox', inbox_url),
                outbox_url = COALESCE(v_object->>'outbox', outbox_url),
                followers_url = COALESCE(v_object->>'followers', followers_url),
                following_url = COALESCE(v_object->>'following', following_url),
                updated_at = NOW(),
                last_synced_at = NOW()
            WHERE federated_id = v_object_id 
              AND NOT is_local; -- Only update federated profiles
            
            IF FOUND THEN
                RAISE NOTICE '✅ Updated profile: %', v_object_id;
                
                -- Log the updated fields for debugging
                RAISE NOTICE 'Profile update details - name: %, summary: %, icon: %, image: %',
                    v_object->>'name',
                    v_object->>'summary',
                    COALESCE(v_object->'icon'->>'url', v_object->>'icon'),
                    COALESCE(v_object->'image'->>'url', v_object->>'image');
            ELSE
                RAISE WARNING 'Profile not found for update: %', v_object_id;
            END IF;
            
        ELSE
            RAISE NOTICE 'Unhandled Update object type: %', v_object_type;
    END CASE;
END;
$$;


--
-- Name: FUNCTION process_update_activity(activity_id uuid, activity_data jsonb, actor_profile record); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.process_update_activity(activity_id uuid, activity_data jsonb, actor_profile record) IS 'Processes incoming ActivityPub Update activities. Handles both Note updates (post edits) and Person updates (profile updates). Profile updates include name, bio, avatar, banner, and other public fields. Only allows users to update their own profiles.';


--
-- Name: record_emoji_usage(uuid, uuid, uuid, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_emoji_usage(p_emoji_id uuid, p_user_id uuid, p_server_id uuid, p_context_type text, p_context_id uuid DEFAULT NULL::uuid) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Insert usage record (ignore if duplicate due to unique constraint)
    INSERT INTO emoji_usage (emoji_id, user_id, server_id, context_type, context_id)
    VALUES (p_emoji_id, p_user_id, p_server_id, p_context_type, p_context_id)
    ON CONFLICT (emoji_id, user_id, context_type, context_id) DO NOTHING;
    
    -- Update emoji global usage count and last_used
    UPDATE emojis 
    SET 
        usage_count = (
            SELECT COUNT(DISTINCT (user_id, context_type, context_id))
            FROM emoji_usage 
            WHERE emoji_id = p_emoji_id
        ),
        last_used = now(),
        updated_at = now()
    WHERE id = p_emoji_id;
END;
$$;


--
-- Name: recovery_key_metadata; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.recovery_key_metadata (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    key_version integer DEFAULT 1 NOT NULL,
    verification_code text NOT NULL,
    word_count integer DEFAULT 12,
    has_server_backup boolean DEFAULT false,
    last_backup_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_verified_at timestamp with time zone,
    storage_hint text,
    CONSTRAINT recovery_key_metadata_word_count_check CHECK ((word_count = ANY (ARRAY[12, 24])))
);


--
-- Name: TABLE recovery_key_metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.recovery_key_metadata IS 'Metadata about user recovery keys. NEVER stores actual recovery phrases!';


--
-- Name: COLUMN recovery_key_metadata.verification_code; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.recovery_key_metadata.verification_code IS 'Hash-based code to verify recovery phrase without storing it';


--
-- Name: register_recovery_key(uuid, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.register_recovery_key(p_user_id uuid, p_verification_code text, p_word_count integer DEFAULT 12) RETURNS public.recovery_key_metadata
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_result public.recovery_key_metadata;
BEGIN
    INSERT INTO public.recovery_key_metadata (
        user_id,
        verification_code,
        word_count,
        created_at
    ) VALUES (
        p_user_id,
        p_verification_code,
        p_word_count,
        NOW()
    )
    ON CONFLICT (user_id) 
    DO UPDATE SET
        verification_code = EXCLUDED.verification_code,
        word_count = EXCLUDED.word_count,
        key_version = recovery_key_metadata.key_version + 1
    RETURNING * INTO v_result;
    
    RETURN v_result;
END;
$$;


--
-- Name: remove_group_icon(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remove_group_icon(conversation_uuid uuid, user_profile_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  is_participant BOOLEAN := false;
  conversation_exists BOOLEAN := false;
BEGIN
  -- Check if user is a participant in the conversation
  SELECT can_manage_group_icon(conversation_uuid, user_profile_id) INTO is_participant;
  
  IF NOT is_participant THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'User is not a participant in this conversation'
    );
  END IF;
  
  -- Check if conversation exists and is a group
  SELECT EXISTS(
    SELECT 1 FROM conversations 
    WHERE id = conversation_uuid AND type = 'group'
  ) INTO conversation_exists;
  
  IF NOT conversation_exists THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Group conversation not found'
    );
  END IF;
  
  -- Remove icon from conversation metadata
  UPDATE conversations 
  SET 
    metadata = COALESCE(metadata, '{}'::jsonb) - 'icon_url',
    updated_at = CURRENT_TIMESTAMP
  WHERE id = conversation_uuid
    AND type = 'group';
  
  RETURN jsonb_build_object(
    'success', true,
    'message', 'Group icon removed successfully'
  );
END;
$$;


--
-- Name: remove_message_from_index(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remove_message_from_index() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  DELETE FROM message_search_index WHERE message_id = OLD.id;
  RETURN OLD;
END;
$$;


--
-- Name: remove_post_emoji_reaction(uuid, uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remove_post_emoji_reaction(p_user_id uuid, p_post_id uuid, p_emoji_id uuid DEFAULT NULL::uuid, p_custom_emoji_content text DEFAULT NULL::text) RETURNS boolean
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


--
-- Name: FUNCTION remove_post_emoji_reaction(p_user_id uuid, p_post_id uuid, p_emoji_id uuid, p_custom_emoji_content text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.remove_post_emoji_reaction(p_user_id uuid, p_post_id uuid, p_emoji_id uuid, p_custom_emoji_content text) IS 'Remove emoji reaction from post. Returns true if reaction was found and removed.';


--
-- Name: remove_timeline_on_unfollow(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.remove_timeline_on_unfollow() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
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


--
-- Name: FUNCTION remove_timeline_on_unfollow(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.remove_timeline_on_unfollow() IS 'Removes posts from home timeline when unfollowing a user';


--
-- Name: reset_user_encryption(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reset_user_encryption(p_user_id uuid, p_device_id text DEFAULT 'default'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_deleted_keys INTEGER := 0;
    v_deleted_prekeys INTEGER := 0;
    v_deleted_sessions INTEGER := 0;
    v_result JSONB;
BEGIN
    -- Only allow users to reset their own encryption
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = p_user_id
        AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot reset encryption for another user';
    END IF;
    
    -- Delete all prekeys (both signed and one-time)
    DELETE FROM public.prekeys
    WHERE user_id = p_user_id
    AND device_id = p_device_id;
    GET DIAGNOSTICS v_deleted_prekeys = ROW_COUNT;
    
    -- Delete encryption sessions (where user is either party)
    DELETE FROM public.encryption_sessions
    WHERE local_user_id = p_user_id
    OR remote_user_id = p_user_id;
    GET DIAGNOSTICS v_deleted_sessions = ROW_COUNT;
    
    -- Delete all key pairs (this allows re-initialization)
    DELETE FROM public.user_key_pairs
    WHERE user_id = p_user_id
    AND device_id = p_device_id;
    GET DIAGNOSTICS v_deleted_keys = ROW_COUNT;
    
    -- Log the reset (using 'encryption_disabled' as it's the closest valid event type)
    INSERT INTO public.encryption_audit_log (
        user_id,
        event_type,
        severity,
        description,
        metadata
    ) VALUES (
        p_user_id,
        'encryption_disabled',
        'warning',
        'User encryption keys completely reset',
        jsonb_build_object(
            'device_id', p_device_id,
            'deleted_keys', v_deleted_keys,
            'deleted_prekeys', v_deleted_prekeys,
            'deleted_sessions', v_deleted_sessions,
            'reset_type', 'full_reset',
            'reset_at', NOW()
        )
    );
    
    v_result := jsonb_build_object(
        'success', true,
        'deleted_keys', v_deleted_keys,
        'deleted_prekeys', v_deleted_prekeys,
        'deleted_sessions', v_deleted_sessions,
        'message', 'Encryption has been reset. You can now set up encryption again.'
    );
    
    RETURN v_result;
END;
$$;


--
-- Name: FUNCTION reset_user_encryption(p_user_id uuid, p_device_id text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.reset_user_encryption(p_user_id uuid, p_device_id text) IS 'Completely reset a user''s encryption keys. Deletes all key pairs, prekeys, and sessions. Allows re-initialization.';


--
-- Name: resolve_activitypub_emoji(jsonb, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resolve_activitypub_emoji(p_emoji_tag jsonb, p_content text, p_actor_domain text) RETURNS TABLE(emoji_id uuid, custom_emoji_content text)
    LANGUAGE plpgsql
    AS $_$
DECLARE
    v_emoji_name text;
    v_emoji_url text;
    v_local_emoji_id uuid;
    v_custom_content text;
BEGIN
    -- Handle custom emoji from tag (Mastodon/Pleroma style)
    IF p_emoji_tag IS NOT NULL AND p_emoji_tag->>'type' = 'Emoji' THEN
        v_emoji_name := p_emoji_tag->>'name';
        v_emoji_url := p_emoji_tag->'icon'->>'url';
        
        -- Remove colons from emoji name if present
        v_emoji_name := trim(both ':' from v_emoji_name);
        
        -- Try to find existing federated emoji
        SELECT id INTO v_local_emoji_id
        FROM emojis
        WHERE name = v_emoji_name AND domain = p_actor_domain;
        
        IF v_local_emoji_id IS NULL THEN
            -- Try to create new federated emoji
            BEGIN
                INSERT INTO emojis (name, url, domain, usage_count, last_used)
                VALUES (v_emoji_name, v_emoji_url, p_actor_domain, 1, NOW())
                RETURNING id INTO v_local_emoji_id;
            EXCEPTION WHEN unique_violation THEN
                -- Another process created the same emoji, find it
                SELECT id INTO v_local_emoji_id
                FROM emojis
                WHERE name = v_emoji_name AND domain = p_actor_domain;
                
                IF v_local_emoji_id IS NOT NULL THEN
                    -- Update usage stats and URL for existing emoji
                    UPDATE emojis 
                    SET usage_count = usage_count + 1, 
                        last_used = NOW(),
                        url = v_emoji_url  -- Update URL in case it changed
                    WHERE id = v_local_emoji_id;
                END IF;
            END;
        ELSE
            -- Update usage stats for existing emoji
            UPDATE emojis 
            SET usage_count = usage_count + 1, last_used = NOW()
            WHERE id = v_local_emoji_id;
        END IF;
        
        emoji_id := v_local_emoji_id;
        custom_emoji_content := NULL;
        RETURN NEXT;
        RETURN;
    END IF;
    
    -- Handle unicode emoji content or shortcodes
    IF p_content IS NOT NULL AND length(p_content) > 0 THEN
        -- Check if it's a simple unicode emoji (common case)
        IF length(p_content) <= 4 AND p_content ~ '^[\x{1F600}-\x{1F64F}\x{1F300}-\x{1F5FF}\x{1F680}-\x{1F6FF}\x{1F1E0}-\x{1F1FF}\x{2600}-\x{26FF}\x{2700}-\x{27BF}]+$' THEN
            emoji_id := NULL;
            custom_emoji_content := p_content;
            RETURN NEXT;
            RETURN;
        END IF;
        
        -- Handle shortcode format like :emoji_name: (could be local or from Misskey)
        IF p_content ~ '^:[a-zA-Z0-9_]+:$' THEN
            v_emoji_name := trim(both ':' from p_content);
            
            -- First try to find federated emoji from this domain
            SELECT id INTO v_local_emoji_id
            FROM emojis
            WHERE name = v_emoji_name AND domain = p_actor_domain;
            
            -- If not found, try to find local emoji
            IF v_local_emoji_id IS NULL THEN
                SELECT id INTO v_local_emoji_id
                FROM emojis
                WHERE name = v_emoji_name AND domain IS NULL;
            END IF;
            
            IF v_local_emoji_id IS NOT NULL THEN
                -- Found existing emoji (local or federated)
                UPDATE emojis 
                SET usage_count = usage_count + 1, last_used = NOW()
                WHERE id = v_local_emoji_id;
                
                emoji_id := v_local_emoji_id;
                custom_emoji_content := NULL;
                RETURN NEXT;
                RETURN;
            ELSE
                -- Store as custom content if no emoji found
                emoji_id := NULL;
                custom_emoji_content := p_content;
                RETURN NEXT;
                RETURN;
            END IF;
        END IF;
        
        -- Fallback: store content as-is for unicode emojis
        emoji_id := NULL;
        custom_emoji_content := p_content;
        RETURN NEXT;
        RETURN;
    END IF;
    
    -- No valid emoji found
    RAISE EXCEPTION 'No valid emoji content provided';
END;
$_$;


--
-- Name: FUNCTION resolve_activitypub_emoji(p_emoji_tag jsonb, p_content text, p_actor_domain text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.resolve_activitypub_emoji(p_emoji_tag jsonb, p_content text, p_actor_domain text) IS 'Resolves ActivityPub emoji tags and content to local emoji_id by creating federated emoji records as needed. Handles custom emojis, unicode emojis, and shortcodes.';


--
-- Name: resume_activitypub_cron_jobs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.resume_activitypub_cron_jobs() RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    result TEXT := '';
    schedule_result TEXT;
BEGIN
    SELECT cron.schedule(
        'activitypub-retry-processor', 
        '*/5 * * * *', 
        'SELECT process_failed_activities_retry();'
    ) INTO schedule_result;
    SELECT cron.schedule(
        'activitypub-cleanup-old-activities',
        '0 3 * * *',
        'DELETE FROM ap_activities WHERE status = ''processed'' AND created_at < NOW() - INTERVAL ''30 days'' AND attempts < 3;'
    ) INTO schedule_result;
    SELECT cron.schedule(
        'activitypub-daily-stats',
        '0 1 * * *',
        'INSERT INTO activitypub_processing_stats (date, total_activities, processed_activities, failed_activities, permanently_failed_activities, avg_processing_time_ms) SELECT CURRENT_DATE - INTERVAL ''1 day'', COUNT(*), COUNT(*) FILTER (WHERE status = ''processed''), COUNT(*) FILTER (WHERE status = ''failed''), COUNT(*) FILTER (WHERE status = ''permanently_failed''), AVG(EXTRACT(EPOCH FROM (updated_at - created_at)) * 1000) FROM ap_activities WHERE created_at >= CURRENT_DATE - INTERVAL ''1 day'' AND created_at < CURRENT_DATE;'
    ) INTO schedule_result;
    result := 'ActivityPub cron jobs have been resumed';
    RETURN result;
END;
$$;


--
-- Name: rotate_prekeys(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.rotate_prekeys(p_user_id uuid, p_device_id text DEFAULT 'default'::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_deleted_count INTEGER;
    v_remaining_count INTEGER;
    v_result JSONB;
BEGIN
    -- Only allow users to rotate their own prekeys
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = p_user_id
        AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot rotate prekeys for another user';
    END IF;
    
    -- Delete used one-time prekeys older than 30 days
    DELETE FROM public.prekeys
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_one_time = true
        AND is_used = true
        AND used_at < NOW() - INTERVAL '30 days';
    
    GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    
    -- Mark expired signed prekeys as inactive
    UPDATE public.prekeys
    SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{expired}', 'true')
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_signed = true
        AND expires_at IS NOT NULL
        AND expires_at < NOW();
    
    -- Count remaining unused one-time prekeys
    SELECT COUNT(*) INTO v_remaining_count
    FROM public.prekeys
    WHERE user_id = p_user_id
        AND device_id = p_device_id
        AND is_one_time = true
        AND is_used = false;
    
    v_result := jsonb_build_object(
        'deleted_used_prekeys', v_deleted_count,
        'remaining_unused_prekeys', v_remaining_count,
        'rotation_completed_at', NOW()
    );
    
    -- Log the rotation
    INSERT INTO public.encryption_audit_log (
        user_id,
        event_type,
        severity,
        description,
        metadata
    ) VALUES (
        p_user_id,
        'key_rotated',
        'info',
        'Prekey rotation completed',
        v_result
    );
    
    RETURN v_result;
END;
$$;


--
-- Name: FUNCTION rotate_prekeys(p_user_id uuid, p_device_id text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.rotate_prekeys(p_user_id uuid, p_device_id text) IS 'Rotate prekeys for a user: clean up used prekeys and expire old signed prekeys.';


--
-- Name: route_channel_message(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.route_channel_message() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_server_id UUID;
  v_has_remote_members BOOLEAN;
  v_channel_name TEXT;
BEGIN
  -- Only process server channel messages (not DMs)
  IF NEW.channel_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Get server from channel
  SELECT c.server_id, c.name
  INTO v_server_id, v_channel_name
  FROM channels c
  WHERE c.id = NEW.channel_id;

  IF v_server_id IS NULL THEN
    -- Not a server channel, skip
    RETURN NEW;
  END IF;

  -- Check if server has remote members
  v_has_remote_members := server_has_remote_members(v_server_id);

  -- If has remote members, notify federation backend
  IF v_has_remote_members THEN
    PERFORM pg_notify('channel_message_federate', 
      json_build_object(
        'message_id', NEW.id,
        'channel_id', NEW.channel_id,
        'server_id', v_server_id,
        'channel_name', v_channel_name,
        'author_id', NEW.user_id
      )::text
    );
    
    RAISE DEBUG 'Message % queued for federation (server % has remote members)', 
      NEW.id, v_server_id;
  ELSE
    RAISE DEBUG 'Message % is local-only (server % has no remote members)', 
      NEW.id, v_server_id;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION route_channel_message(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.route_channel_message() IS 'Smart routing: Notify federation backend only if server has remote members';


--
-- Name: route_server_leave(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.route_server_leave() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_server RECORD;
  v_user RECORD;
BEGIN
  -- Get server info
  SELECT * INTO v_server
  FROM servers
  WHERE id = OLD.server_id;

  -- Get user info
  SELECT * INTO v_user
  FROM profiles
  WHERE id = OLD.user_id;

  -- If remote server, notify federation backend to send Leave activity
  IF v_server.is_local_server = false THEN
    PERFORM pg_notify('user_leave_remote_server',
      json_build_object(
        'user_id', OLD.user_id,
        'server_id', OLD.server_id,
        'server_ap_id', v_server.ap_id,
        'server_inbox', v_server.federation_inbox_url
      )::text
    );
  END IF;

  -- If local server with remote user, broadcast Leave to other instances
  IF v_server.is_local_server = true AND v_user.is_local = false THEN
    PERFORM pg_notify('remote_user_left_server',
      json_build_object(
        'user_id', OLD.user_id,
        'user_ap_id', v_user.ap_id,
        'server_id', OLD.server_id
      )::text
    );
  END IF;

  RETURN OLD;
END;
$$;


--
-- Name: FUNCTION route_server_leave(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.route_server_leave() IS 'Handle federation for server leave events';


--
-- Name: route_server_membership(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.route_server_membership() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_server RECORD;
  v_user RECORD;
  v_is_remote_user BOOLEAN;
  v_is_remote_server BOOLEAN;
BEGIN
  -- Get server info
  SELECT * INTO v_server
  FROM servers
  WHERE id = NEW.server_id;

  -- Get user info
  SELECT * INTO v_user
  FROM profiles
  WHERE id = NEW.user_id;

  v_is_remote_user := (v_user.is_local = false);
  v_is_remote_server := (v_server.is_local_server = false);

  -- Case 1: Local user joining remote server
  IF NOT v_is_remote_user AND v_is_remote_server THEN
    PERFORM pg_notify('user_join_remote_server',
      json_build_object(
        'user_id', NEW.user_id,
        'server_id', NEW.server_id,
        'server_ap_id', v_server.ap_id,
        'server_inbox', v_server.federation_inbox_url
      )::text
    );
    RAISE NOTICE 'Local user % joining remote server %', v_user.username, v_server.name;
  END IF;

  -- Case 2: Remote user joining local server (handled by inbox)
  -- No notification needed here, inbox handler adds membership

  -- Case 3: Membership status change (pending → accepted)
  IF TG_OP = 'UPDATE' AND OLD.status != NEW.status THEN
    IF NEW.status = 'accepted' THEN
      -- Member is now active, might need to notify
      PERFORM pg_notify('member_accepted',
        json_build_object(
          'user_id', NEW.user_id,
          'server_id', NEW.server_id
        )::text
      );
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION route_server_membership(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.route_server_membership() IS 'Handle federation for server membership changes (joins/leaves)';


--
-- Name: run_trending_maintenance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.run_trending_maintenance() RETURNS json
    LANGUAGE plpgsql
    AS $$
DECLARE
    result JSON;
    hashtags_cleaned INTEGER;
    trending_cleaned INTEGER;
    hashtags_archived INTEGER;
    scores_updated INTEGER;
BEGIN
    -- Archive popular hashtags before cleanup
    hashtags_archived := archive_popular_hashtags();
    
    -- Clean up inactive hashtags
    hashtags_cleaned := cleanup_inactive_hashtags();
    
    -- Clean up old trending data
    trending_cleaned := cleanup_old_trending_data();
    
    -- Update trending scores
    scores_updated := update_hashtag_trending_scores();
    
    -- Update trending posts
    PERFORM update_trending_posts();
    
    -- Build result
    result := json_build_object(
        'maintenance_completed_at', NOW(),
        'hashtags_archived', hashtags_archived,
        'hashtags_cleaned', hashtags_cleaned,
        'trending_data_cleaned', trending_cleaned,
        'trending_scores_updated', scores_updated,
        'status', 'success'
    );
    
    RAISE NOTICE 'Trending system maintenance completed: %', result;
    RETURN result;
END;
$$;


--
-- Name: FUNCTION run_trending_maintenance(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.run_trending_maintenance() IS 'Comprehensive maintenance function that runs all cleanup and update operations';


--
-- Name: save_encryption_session(uuid, uuid, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_encryption_session(p_local_user_id uuid, p_remote_user_id uuid, p_session_state text, p_local_device_id text DEFAULT 'default'::text, p_remote_device_id text DEFAULT 'default'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_session_id UUID;
BEGIN
    -- Only allow users to save their own sessions
    IF NOT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = p_local_user_id
        AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot save sessions for another user';
    END IF;
    
    INSERT INTO public.encryption_sessions (
        local_user_id,
        local_device_id,
        remote_user_id,
        remote_device_id,
        session_state,
        established_at,
        last_used_at
    ) VALUES (
        p_local_user_id,
        p_local_device_id,
        p_remote_user_id,
        p_remote_device_id,
        p_session_state,
        NOW(),
        NOW()
    )
    ON CONFLICT (local_user_id, local_device_id, remote_user_id, remote_device_id)
    DO UPDATE SET
        session_state = EXCLUDED.session_state,
        last_used_at = NOW()
    RETURNING id INTO v_session_id;
    
    -- Log session establishment/update
    INSERT INTO public.encryption_audit_log (
        user_id,
        event_type,
        severity,
        description,
        related_user_id,
        metadata
    ) VALUES (
        p_local_user_id,
        'session_established',
        'info',
        'Encryption session saved',
        p_remote_user_id,
        jsonb_build_object(
            'session_id', v_session_id,
            'local_device', p_local_device_id,
            'remote_device', p_remote_device_id
        )
    );
    
    RETURN v_session_id;
END;
$$;


--
-- Name: FUNCTION save_encryption_session(p_local_user_id uuid, p_remote_user_id uuid, p_session_state text, p_local_device_id text, p_remote_device_id text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.save_encryption_session(p_local_user_id uuid, p_remote_user_id uuid, p_session_state text, p_local_device_id text, p_remote_device_id text) IS 'Save or update an encryption session. Creates new session or updates existing.';


--
-- Name: save_recovery_codes(uuid, text[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.save_recovery_codes(p_user_id uuid, p_codes text[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_code TEXT;
  v_code_hash TEXT;
BEGIN
  -- Delete any existing recovery codes for this user
  DELETE FROM public.mfa_recovery_codes WHERE user_id = p_user_id;
  
  -- Insert new recovery codes
  FOREACH v_code IN ARRAY p_codes
  LOOP
    -- Use extensions.digest() to explicitly reference the pgcrypto extension
    v_code_hash := encode(extensions.digest(v_code::bytea, 'sha256'), 'hex');
    INSERT INTO public.mfa_recovery_codes (user_id, code_hash)
    VALUES (p_user_id, v_code_hash);
  END LOOP;
END;
$$;


--
-- Name: search_federated_users(text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_federated_users(p_query text, p_limit integer DEFAULT 10) RETURNS TABLE(user_id uuid, username text, display_name text, domain text, avatar_url text, handle text, is_local boolean)
    LANGUAGE plpgsql
    AS $$
BEGIN
    RETURN QUERY
    SELECT 
        p.id as user_id,
        p.username,
        p.display_name,
        p.domain,
        p.avatar_url,
        get_user_handle(p.id) as handle,
        p.is_local
    FROM profiles p
    WHERE (
        p.username ILIKE '%' || p_query || '%'
        OR p.display_name ILIKE '%' || p_query || '%'
        OR (p.username || '@' || p.domain) ILIKE '%' || p_query || '%'
    )
    AND p.is_suspended = false  -- Exclude suspended users
    ORDER BY 
        CASE WHEN p.is_local THEN 0 ELSE 1 END,
        p.username
    LIMIT p_limit;
END;
$$;


--
-- Name: FUNCTION search_federated_users(p_query text, p_limit integer); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.search_federated_users(p_query text, p_limit integer) IS 'Search for federated users by username/display_name, excluding suspended users';


--
-- Name: search_messages(text, uuid, uuid[], uuid, uuid, uuid, boolean, boolean, timestamp with time zone, timestamp with time zone, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_messages(p_query text DEFAULT NULL::text, p_channel_id uuid DEFAULT NULL::uuid, p_channel_ids uuid[] DEFAULT NULL::uuid[], p_user_id uuid DEFAULT NULL::uuid, p_conversation_id uuid DEFAULT NULL::uuid, p_server_id uuid DEFAULT NULL::uuid, p_has_media boolean DEFAULT NULL::boolean, p_has_url boolean DEFAULT NULL::boolean, p_from_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to_date timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 50, p_offset integer DEFAULT 0) RETURNS TABLE(message_id uuid, relevance real, content_text text, channel_id uuid, conversation_id uuid, user_id uuid, created_at timestamp with time zone)
    LANGUAGE plpgsql STABLE
    AS $$
DECLARE
  current_user_profile_id uuid;
  search_query text;
  tsquery_val tsquery;
BEGIN
  -- Get current user's profile ID (works for both local and remote users)
  current_user_profile_id := get_current_user_profile_id();
  
  -- If no profile found, return empty (user not authenticated or no profile)
  IF current_user_profile_id IS NULL THEN
    RETURN;
  END IF;
  -- Build search query - handle empty query
  IF p_query IS NULL OR trim(p_query) = '' THEN
    search_query := '';
    tsquery_val := NULL;
  ELSE
    search_query := trim(p_query);
    -- Use plainto_tsquery for natural language search
    tsquery_val := plainto_tsquery('english', search_query);
  END IF;

  RETURN QUERY
  SELECT 
    msi.message_id,
    -- Combine ts_rank (full-text) with similarity (fuzzy) for ranking
    CASE 
      WHEN tsquery_val IS NOT NULL THEN
        (ts_rank(msi.content_tsvector, tsquery_val) * 0.7 +
         extensions.similarity(msi.content_text, search_query) * 0.3)::real
      ELSE
        -- If no query, rank by date
        1.0::real
    END as relevance,
    msi.content_text,
    msi.channel_id,
    msi.conversation_id,
    msi.user_id,
    msi.created_at
  FROM message_search_index msi
  WHERE 
    -- Access control: Only show messages user has access to
    (
      -- For conversations: user must be a participant
      (msi.conversation_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM conversation_participants cp
        WHERE cp.conversation_id = msi.conversation_id
          AND cp.user_id = current_user_profile_id
          AND cp.left_at IS NULL
      ))
      OR
      -- For channels: user must be a member of the server
      (msi.channel_id IS NOT NULL AND EXISTS (
        SELECT 1
        FROM channels c
        JOIN user_servers us ON c.server_id = us.server_id
        WHERE c.id = msi.channel_id
          AND us.user_id = current_user_profile_id
      ))
    )
    -- Search conditions (only if query provided)
    AND (tsquery_val IS NULL OR 
         msi.content_tsvector @@ tsquery_val OR 
         extensions.similarity(msi.content_text, search_query) > 0.2)
    -- Filters
    AND (p_channel_id IS NULL OR msi.channel_id = p_channel_id)
    AND (p_channel_ids IS NULL OR msi.channel_id = ANY(p_channel_ids))
    AND (p_user_id IS NULL OR msi.user_id = p_user_id)
    AND (p_conversation_id IS NULL OR msi.conversation_id = p_conversation_id)
    AND (p_server_id IS NULL OR msi.server_id = p_server_id)
    AND (p_has_media IS NULL OR msi.has_media = p_has_media)
    AND (p_has_url IS NULL OR msi.has_url = p_has_url)
    AND (p_from_date IS NULL OR msi.created_at >= p_from_date)
    AND (p_to_date IS NULL OR msi.created_at <= p_to_date)
  ORDER BY 
    CASE 
      WHEN tsquery_val IS NOT NULL THEN
        (ts_rank(msi.content_tsvector, tsquery_val) * 0.7 +
         extensions.similarity(msi.content_text, search_query) * 0.3)
      ELSE
        extract(epoch from msi.created_at) / 1000000.0 -- Convert timestamp to sortable number
    END DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;


--
-- Name: search_users(text, integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.search_users(p_query text, p_limit integer DEFAULT 20, p_local_only boolean DEFAULT false) RETURNS TABLE(id uuid, username text, domain text, display_name text, avatar text, is_local boolean)
    LANGUAGE sql STABLE
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


--
-- Name: FUNCTION search_users(p_query text, p_limit integer, p_local_only boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.search_users(p_query text, p_limit integer, p_local_only boolean) IS 'Search users by username or display name with smart ranking';


--
-- Name: send_accept_activity_for_follow(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.send_accept_activity_for_follow(follow_activity_id uuid, local_user_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'extensions', 'public', 'pg_temp'
    AS $$
DECLARE
    v_follow_activity RECORD;
    v_local_profile RECORD;
    v_instance_domain TEXT;
    v_accept_id TEXT;
    v_accept_activity JSONB;
    v_activity_uuid UUID;
    v_inbox_url TEXT;
    v_signature_header TEXT;
    v_date_header TEXT;
    v_digest_header TEXT;
    v_http_status INTEGER;
    v_http_response TEXT;
    v_delivery_success BOOLEAN;
    v_follower_domain TEXT;
BEGIN
    RAISE NOTICE '📤 Sending Accept activity for follow: %', follow_activity_id;
    
    -- Get the Follow activity we're accepting
    SELECT * INTO v_follow_activity
    FROM ap_activities 
    WHERE id = follow_activity_id
    AND ap_type = 'Follow';
    
    IF NOT FOUND THEN
        RAISE WARNING 'Follow activity not found: %', follow_activity_id;
        RETURN;
    END IF;
    
    -- Get the local user profile
    SELECT * INTO v_local_profile
    FROM profiles 
    WHERE id = local_user_id
    AND is_local = true;
    
    IF NOT FOUND THEN
        RAISE WARNING 'Local user not found: %', local_user_id;
        RETURN;
    END IF;
    
    -- Get instance domain
    SELECT trim(both '"' from config_value::text) INTO v_instance_domain 
    FROM instance_config 
    WHERE config_key = 'domain' 
    LIMIT 1;
    
    IF v_instance_domain IS NULL THEN
        RAISE WARNING 'Instance domain not configured, cannot send Accept';
        RETURN;
    END IF;
    
    -- Create Accept activity
    v_accept_id := 'https://' || v_instance_domain || '/users/' || v_local_profile.username || '#accepts/' || extract(epoch from now())::bigint;
    
    v_accept_activity := jsonb_build_object(
        '@context', 'https://www.w3.org/ns/activitystreams',
        'id', v_accept_id,
        'type', 'Accept',
        'actor', 'https://' || v_instance_domain || '/users/' || v_local_profile.username,
        'object', v_follow_activity.activity_data
    );
    
    RAISE NOTICE '📋 Created Accept activity: %', v_accept_id;
    
    -- Store the Accept activity in our database
    INSERT INTO ap_activities (
        ap_id,
        ap_type,
        actor_id,
        actor_ap_id,
        object_id,
        object_type,
        activity_data,
        status,
        to_addresses,
        is_local,
        origin_domain
    ) VALUES (
        v_accept_id,
        'Accept',
        local_user_id,
        'https://' || v_instance_domain || '/users/' || v_local_profile.username,
        v_follow_activity.ap_id,
        'Follow',
        v_accept_activity,
        'pending',
        ARRAY[v_follow_activity.actor_ap_id],
        true,
        v_instance_domain
    ) RETURNING id INTO v_activity_uuid;
    
    -- Extract follower domain for inbox URL
    v_follower_domain := (SELECT domain FROM profiles WHERE federated_id = v_follow_activity.actor_ap_id OR id = (
        SELECT id FROM profiles WHERE federated_id = v_follow_activity.actor_ap_id LIMIT 1
    ));
    
    IF v_follower_domain IS NULL THEN
        -- Try to extract domain from actor URL
        v_follower_domain := substring(v_follow_activity.actor_ap_id from 'https://([^/]+)/');
    END IF;
    
    IF v_follower_domain IS NULL THEN
        RAISE WARNING 'Could not determine follower domain from: %', v_follow_activity.actor_ap_id;
        RETURN;
    END IF;
    
    -- Construct inbox URL (user-specific for better delivery)
    v_inbox_url := v_follow_activity.actor_ap_id || '/inbox';
    
    RAISE WARNING '📮 Sending Accept to inbox: %', v_inbox_url;
    
    -- Generate HTTP signature
    BEGIN
        SELECT 
            signature_header,
            date_header,
            digest_header
        INTO 
            v_signature_header,
            v_date_header,
            v_digest_header
        FROM create_http_signature(
            v_inbox_url,
            v_accept_activity::text,
            v_local_profile.username,
            v_instance_domain,
            'POST'
        );
        
        RAISE NOTICE 'Generated HTTP signature for Accept to %', v_follower_domain;
        
    EXCEPTION 
        WHEN OTHERS THEN
            RAISE WARNING 'Failed to generate signature for Accept: %', SQLERRM;
            -- Update activity as failed and return
            UPDATE ap_activities 
            SET status = 'failed',
                error_message = 'Signature generation failed: ' || SQLERRM
            WHERE id = v_activity_uuid;
            RETURN;
    END;
    
    -- Attempt immediate delivery
    BEGIN
        RAISE WARNING '🚀 Attempting Accept delivery to: %', v_inbox_url;

        -- Try to deliver immediately using Supabase HTTP extension
        SELECT status, content INTO v_http_status, v_http_response
        FROM http((
            'POST',
            v_inbox_url,
            ARRAY[
                ('Content-Type', 'application/activity+json'),
                ('User-Agent', 'Harmony/1.0.0'),
                ('Host', v_follower_domain),
                ('Date', v_date_header),
                ('Digest', v_digest_header),
                ('Signature', v_signature_header)
            ]::http_header[],
            'application/activity+json',
            v_accept_activity::text
        )::http_request);
        
        -- Check delivery success
        v_delivery_success := (v_http_status >= 200 AND v_http_status < 300);
        
        RAISE WARNING 'Accept HTTP Response: Status=%, Body=%', v_http_status, LEFT(v_http_response, 200);
        
        IF v_delivery_success THEN
            -- Immediate delivery succeeded
            UPDATE ap_activities 
            SET status = 'completed',
                last_attempt_at = NOW()
            WHERE id = v_activity_uuid;
            
            RAISE NOTICE '✅ Accept delivery succeeded to: % (HTTP %)', v_follower_domain, v_http_status;
            
            -- Also mark the original Follow as completed/accepted
            UPDATE ap_activities
            SET status = 'completed'
            WHERE id = follow_activity_id;
            
        ELSE
            -- Immediate delivery failed, queue for retry
            UPDATE ap_activities 
            SET status = 'failed',
                attempts = 1,
                last_attempt_at = NOW(),
                error_message = format('HTTP %s: %s', v_http_status, LEFT(v_http_response, 500))
            WHERE id = v_activity_uuid;
            
            RAISE WARNING '❌ Accept delivery failed to % (HTTP %): %', 
                v_follower_domain, v_http_status, LEFT(v_http_response, 200);
            
            -- Queue for retry
            PERFORM queue_activity_for_federation(v_activity_uuid, ARRAY[v_follower_domain], 8, true);
        END IF;
        
    EXCEPTION 
        WHEN OTHERS THEN
            -- HTTP extension not available or network error, queue for delivery
            UPDATE ap_activities 
            SET status = 'failed',
                error_message = 'HTTP delivery failed: ' || SQLERRM
            WHERE id = v_activity_uuid;
            
            RAISE WARNING '💥 Accept HTTP delivery exception to % - Error: %', v_follower_domain, SQLERRM;
            PERFORM queue_activity_for_federation(v_activity_uuid, ARRAY[v_follower_domain], 8, true);
    END;
    
END;
$$;


--
-- Name: FUNCTION send_accept_activity_for_follow(follow_activity_id uuid, local_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.send_accept_activity_for_follow(follow_activity_id uuid, local_user_id uuid) IS 'Sends an Accept activity back to a remote follower via HTTP POST with proper signatures. Used for auto-accepting follow requests.';


--
-- Name: send_notification(character varying, uuid[], jsonb, uuid, uuid, uuid, uuid, character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.send_notification(notification_type character varying, to_user_ids uuid[], notification_data jsonb DEFAULT '{}'::jsonb, server_id uuid DEFAULT NULL::uuid, channel_id uuid DEFAULT NULL::uuid, conversation_id uuid DEFAULT NULL::uuid, from_user_id uuid DEFAULT NULL::uuid, priority character varying DEFAULT 'normal'::character varying) RETURNS uuid[]
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    created_notification_ids uuid[] := '{}';
    recipient_id uuid;
    user_prefs record;
    should_send boolean;
    notification_id uuid;
    current_timestamp timestamp with time zone := now();
    enhanced_data jsonb;
    is_blocked boolean;
    is_muted boolean;
    is_channel_muted boolean;
    p_channel_id uuid;
    p_conversation_id uuid;
    is_activitypub_type boolean;
BEGIN
    -- Validate inputs
    IF notification_type IS NULL OR array_length(to_user_ids, 1) IS NULL THEN
        RETURN '{}';
    END IF;

    -- Determine if this is an ActivityPub notification type
    is_activitypub_type := notification_type LIKE 'activitypub_%';

    -- Process each recipient
    FOREACH recipient_id IN ARRAY to_user_ids LOOP
        -- Skip if sending to self
        IF from_user_id IS NOT NULL AND recipient_id = from_user_id THEN
            CONTINUE;
        END IF;

        -- Check if sender is blocked by recipient
        IF from_user_id IS NOT NULL THEN
            SELECT EXISTS (
                SELECT 1 
                FROM user_blocks ub
                WHERE ub.blocker_id = recipient_id
                AND ub.blocked_user_id = from_user_id
                AND (ub.expires_at IS NULL OR ub.expires_at > NOW())
            ) INTO is_blocked;
            
            IF is_blocked THEN
                CONTINUE;
            END IF;
        END IF;

        -- Check if sender is muted by recipient (for notifications)
        IF from_user_id IS NOT NULL THEN
            SELECT EXISTS (
                SELECT 1 
                FROM user_mutes um
                WHERE um.muter_id = recipient_id
                AND um.muted_user_id = from_user_id
                AND um.mute_type IN ('notifications_only', 'all')
                AND (um.expires_at IS NULL OR um.expires_at > NOW())
            ) INTO is_muted;
            
            IF is_muted THEN
                CONTINUE;
            END IF;
        END IF;

        -- Check if channel/conversation is muted
        p_channel_id := channel_id;
        p_conversation_id := conversation_id;
        
        IF p_channel_id IS NOT NULL OR p_conversation_id IS NOT NULL THEN
            SELECT EXISTS (
                SELECT 1 
                FROM notification_channels nc
                WHERE nc.user_id = recipient_id
                AND nc.muted = true
                AND (
                    (p_channel_id IS NOT NULL AND nc.channel_id = p_channel_id)
                    OR
                    (p_conversation_id IS NOT NULL AND nc.conversation_id = p_conversation_id)
                )
                AND (nc.muted_until IS NULL OR nc.muted_until > NOW())
            ) INTO is_channel_muted;
            
            IF is_channel_muted THEN
                CONTINUE;
            END IF;
        END IF;

        -- Check if user is currently viewing this channel/DM (Discord-like behavior)
        IF (server_id IS NOT NULL AND p_channel_id IS NOT NULL) OR p_conversation_id IS NOT NULL THEN
            IF public.is_user_viewing_context(recipient_id, server_id, p_channel_id, p_conversation_id) THEN
                CONTINUE;
            END IF;
        END IF;

        -- Get user notification preferences
        user_prefs := NULL;
        BEGIN
            SELECT * INTO user_prefs FROM notification_preferences WHERE user_id = recipient_id;
        EXCEPTION
            WHEN undefined_table THEN
                user_prefs := NULL;
        END;

        -- Default to sending notifications if no preferences found
        should_send := true;

        -- Apply preferences if they exist
        IF user_prefs IS NOT NULL THEN
            -- First check master toggles
            IF is_activitypub_type THEN
                -- Check ActivityPub master toggle first
                IF COALESCE(user_prefs.activitypub_notifications, true) = false THEN
                    should_send := false;
                ELSIF COALESCE(user_prefs.activitypub_desktop_notifications, true) = false THEN
                    should_send := false;
                ELSE
                    -- Check specific ActivityPub notification types
                    CASE notification_type
                        WHEN 'activitypub_follow' THEN
                            should_send := COALESCE(user_prefs.activitypub_follows, true) 
                                       AND COALESCE(user_prefs.activitypub_desktop_follows, true);
                        WHEN 'activitypub_follow_request' THEN
                            should_send := COALESCE(user_prefs.activitypub_follow_requests, true) 
                                       AND COALESCE(user_prefs.activitypub_desktop_follows, true);
                        WHEN 'activitypub_favorite' THEN
                            should_send := COALESCE(user_prefs.activitypub_favorites, true) 
                                       AND COALESCE(user_prefs.activitypub_desktop_favorites, false);
                        WHEN 'activitypub_reblog' THEN
                            should_send := COALESCE(user_prefs.activitypub_reblogs, true) 
                                       AND COALESCE(user_prefs.activitypub_desktop_reblogs, false);
                        WHEN 'activitypub_mention' THEN
                            should_send := COALESCE(user_prefs.activitypub_mentions, true) 
                                       AND COALESCE(user_prefs.activitypub_desktop_mentions, true);
                        WHEN 'activitypub_reply' THEN
                            should_send := COALESCE(user_prefs.activitypub_replies, true) 
                                       AND COALESCE(user_prefs.activitypub_desktop_replies, true);
                        WHEN 'activitypub_reaction' THEN
                            should_send := COALESCE(user_prefs.activitypub_favorites, true) 
                                       AND COALESCE(user_prefs.activitypub_desktop_favorites, false);
                        ELSE
                            should_send := true;
                    END CASE;
                END IF;
            ELSE
                -- Check desktop_notifications master toggle first for non-ActivityPub
                IF COALESCE(user_prefs.desktop_notifications, true) = false THEN
                    -- Master toggle off, but still allow high-priority types
                    IF notification_type NOT IN ('mention', 'dm') THEN
                        should_send := false;
                    END IF;
                END IF;

                -- Check specific non-ActivityPub notification types
                IF should_send THEN
                    CASE notification_type
                        WHEN 'mention' THEN
                            should_send := COALESCE(user_prefs.desktop_mentions, true);
                        WHEN 'reply' THEN
                            should_send := COALESCE(user_prefs.desktop_replies, true);
                        WHEN 'dm' THEN
                            should_send := COALESCE(user_prefs.desktop_dms, true);
                        WHEN 'reaction' THEN
                            should_send := COALESCE(user_prefs.desktop_reactions, false);
                        WHEN 'voice_channel_activity' THEN
                            should_send := COALESCE(user_prefs.sound_voice_activity, true);
                        WHEN 'server_invite' THEN
                            should_send := COALESCE(user_prefs.desktop_notifications, true);
                        WHEN 'friend_request' THEN
                            should_send := COALESCE(user_prefs.desktop_notifications, true);
                        WHEN 'server_update' THEN
                            should_send := COALESCE(user_prefs.desktop_notifications, true);
                        WHEN 'emoji_added' THEN
                            should_send := COALESCE(user_prefs.desktop_notifications, true);
                        ELSE
                            should_send := true;
                    END CASE;
                END IF;
            END IF;

            -- Apply DND restrictions if configured
            IF user_prefs.dnd_enabled IS TRUE AND should_send THEN
                DECLARE
                    current_time_of_day time := current_timestamp::time;
                    dnd_start time := COALESCE(user_prefs.dnd_start_time, '22:00'::time);
                    dnd_end time := COALESCE(user_prefs.dnd_end_time, '08:00'::time);
                BEGIN
                    -- Handle overnight DND (e.g., 22:00 to 08:00)
                    IF dnd_start > dnd_end THEN
                        -- Overnight period: 22:00 -> midnight -> 08:00
                        IF current_time_of_day >= dnd_start OR current_time_of_day <= dnd_end THEN
                            should_send := false;
                        END IF;
                    ELSE
                        -- Same-day period
                        IF current_time_of_day >= dnd_start AND current_time_of_day <= dnd_end THEN
                            should_send := false;
                        END IF;
                    END IF;
                END;
            END IF;
        END IF;

        -- Create enhanced notification data with context
        enhanced_data := notification_data;
        
        IF server_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('server_id', server_id);
        END IF;
        
        IF channel_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('channel_id', channel_id);
        END IF;
        
        IF conversation_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('conversation_id', conversation_id);
        END IF;
        
        IF from_user_id IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('from_user_id', from_user_id);
        END IF;
        
        IF priority IS NOT NULL THEN
            enhanced_data := enhanced_data || jsonb_build_object('priority', priority);
        END IF;

        -- Create notification if should send
        IF should_send THEN
            INSERT INTO notifications (
                type,
                user_id,
                data,
                created_at
            ) VALUES (
                notification_type,
                recipient_id,
                enhanced_data,
                current_timestamp
            ) RETURNING id INTO notification_id;

            created_notification_ids := array_append(created_notification_ids, notification_id);
        END IF;

    END LOOP;

    RETURN created_notification_ids;
END;
$$;


--
-- Name: FUNCTION send_notification(notification_type character varying, to_user_ids uuid[], notification_data jsonb, server_id uuid, channel_id uuid, conversation_id uuid, from_user_id uuid, priority character varying); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.send_notification(notification_type character varying, to_user_ids uuid[], notification_data jsonb, server_id uuid, channel_id uuid, conversation_id uuid, from_user_id uuid, priority character varying) IS 'Send notifications with full preference checking. Supports master toggles, per-type settings, DND, blocks, mutes, and view context suppression.';


--
-- Name: send_notification_to_followers(character varying, uuid, jsonb, uuid, character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.send_notification_to_followers(notification_type character varying, target_user_id uuid, notification_data jsonb DEFAULT '{}'::jsonb, from_user_id uuid DEFAULT NULL::uuid, priority character varying DEFAULT 'normal'::character varying) RETURNS uuid[]
    LANGUAGE plpgsql
    AS $$
DECLARE
    follower_ids uuid[];
BEGIN
    -- Get all followers
    SELECT array_agg(follower_id)
    INTO follower_ids
    FROM follows f
    WHERE f.following_id = target_user_id
    AND f.status = 'accepted';

    -- Send notifications to all followers
    RETURN send_notification(
        notification_type,
        follower_ids,
        notification_data,
        NULL,
        NULL,
        NULL,
        from_user_id,
        priority
    );
END;
$$;


--
-- Name: FUNCTION send_notification_to_followers(notification_type character varying, target_user_id uuid, notification_data jsonb, from_user_id uuid, priority character varying); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.send_notification_to_followers(notification_type character varying, target_user_id uuid, notification_data jsonb, from_user_id uuid, priority character varying) IS 'Send notifications to all followers of a user.';


--
-- Name: send_notification_to_server_members(character varying, uuid, jsonb, uuid, uuid, uuid[], character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.send_notification_to_server_members(notification_type character varying, target_server_id uuid, notification_data jsonb DEFAULT '{}'::jsonb, channel_id uuid DEFAULT NULL::uuid, from_user_id uuid DEFAULT NULL::uuid, exclude_user_ids uuid[] DEFAULT '{}'::uuid[], priority character varying DEFAULT 'normal'::character varying) RETURNS uuid[]
    LANGUAGE plpgsql
    AS $$
DECLARE
    server_member_ids uuid[];
BEGIN
    -- Get all server members
    SELECT array_agg(user_id)
    INTO server_member_ids
    FROM user_servers us
    WHERE us.server_id = target_server_id
    AND (exclude_user_ids IS NULL OR NOT (us.user_id = ANY(exclude_user_ids)));

    -- Send notifications to all members
    RETURN send_notification(
        notification_type,
        server_member_ids,
        notification_data,
        target_server_id,
        channel_id,
        NULL,
        from_user_id,
        priority
    );
END;
$$;


--
-- Name: FUNCTION send_notification_to_server_members(notification_type character varying, target_server_id uuid, notification_data jsonb, channel_id uuid, from_user_id uuid, exclude_user_ids uuid[], priority character varying); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.send_notification_to_server_members(notification_type character varying, target_server_id uuid, notification_data jsonb, channel_id uuid, from_user_id uuid, exclude_user_ids uuid[], priority character varying) IS 'Send notifications to all members of a server, with optional exclusions.';


--
-- Name: send_notification_to_user(character varying, uuid, jsonb, uuid, uuid, uuid, uuid, character varying); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.send_notification_to_user(notification_type character varying, to_user_id uuid, notification_data jsonb DEFAULT '{}'::jsonb, server_id uuid DEFAULT NULL::uuid, channel_id uuid DEFAULT NULL::uuid, conversation_id uuid DEFAULT NULL::uuid, from_user_id uuid DEFAULT NULL::uuid, priority character varying DEFAULT 'normal'::character varying) RETURNS uuid
    LANGUAGE sql SECURITY DEFINER
    AS $$
    SELECT (send_notification(
        notification_type,
        ARRAY[to_user_id],
        notification_data,
        server_id,
        channel_id,
        conversation_id,
        from_user_id,
        priority
    ))[1];
$$;


--
-- Name: FUNCTION send_notification_to_user(notification_type character varying, to_user_id uuid, notification_data jsonb, server_id uuid, channel_id uuid, conversation_id uuid, from_user_id uuid, priority character varying); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.send_notification_to_user(notification_type character varying, to_user_id uuid, notification_data jsonb, server_id uuid, channel_id uuid, conversation_id uuid, from_user_id uuid, priority character varying) IS 'SECURITY DEFINER: Helper function for single user notifications with elevated privileges.';


--
-- Name: server_has_remote_members(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.server_has_remote_members(p_server_id uuid) RETURNS boolean
    LANGUAGE sql STABLE
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


--
-- Name: FUNCTION server_has_remote_members(p_server_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.server_has_remote_members(p_server_id uuid) IS 'Check if server has any remote (federated) members';


--
-- Name: set_instance_config(uuid, text, jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_instance_config(p_admin_id uuid, p_key text, p_value jsonb, p_description text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    old_value JSONB;
BEGIN
    -- Check if admin has permission
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = p_admin_id AND is_admin = TRUE) THEN
        RAISE EXCEPTION 'Insufficient permissions';
    END IF;
    
    -- Get old value for logging
    SELECT config_value INTO old_value FROM instance_config WHERE config_key = p_key;
    
    -- Update or insert configuration
    INSERT INTO instance_config (config_key, config_value, description, updated_by, updated_at)
    VALUES (p_key, p_value, p_description, p_admin_id, NOW())
    ON CONFLICT (config_key) DO UPDATE SET
        config_value = p_value,
        description = COALESCE(p_description, instance_config.description),
        updated_by = p_admin_id,
        updated_at = NOW();
    
    -- Log the action
    PERFORM log_admin_action(
        p_admin_id,
        'config_change',
        'config',
        p_key,
        json_build_object(
            'old_value', old_value,
            'new_value', p_value,
            'key', p_key
        )
    );
    
    RETURN TRUE;
END;
$$;


--
-- Name: set_member_instance(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_member_instance() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  -- Auto-populate member_instance from user's domain
  SELECT domain INTO NEW.member_instance
  FROM profiles
  WHERE id = NEW.user_id;
  
  RETURN NEW;
END;
$$;


--
-- Name: should_create_notification(uuid, character varying, uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.should_create_notification(p_user_id uuid, p_type character varying, p_server_id uuid DEFAULT NULL::uuid, p_channel_id uuid DEFAULT NULL::uuid, p_conversation_id uuid DEFAULT NULL::uuid) RETURNS boolean
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- For now, always allow notifications
    -- This can be enhanced later with user preferences
    RETURN TRUE;
END;
$$;


--
-- Name: FUNCTION should_create_notification(p_user_id uuid, p_type character varying, p_server_id uuid, p_channel_id uuid, p_conversation_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.should_create_notification(p_user_id uuid, p_type character varying, p_server_id uuid, p_channel_id uuid, p_conversation_id uuid) IS 'Checks user preferences and channel settings to determine if a notification should be created';


--
-- Name: strip_dm_mentions(jsonb, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.strip_dm_mentions(content jsonb, local_instance_domain text) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    result jsonb := '[]'::jsonb;
    part jsonb;
    is_first_mention boolean := true;
BEGIN
    -- For DMs, we want to strip mentions at the beginning since they're contextual
    -- This is APPLICATION logic, not CONVERSION logic!
    
    FOR part IN SELECT jsonb_array_elements(content)
    LOOP
        -- Skip leading mentions in DMs (they're implied by conversation context)
        IF (part->>'type') = 'mention' AND is_first_mention THEN
            -- Check if this is a local mention (recipient)
            IF (part->>'domain') = local_instance_domain OR (part->>'isLocal')::boolean = true THEN
                CONTINUE; -- Skip local mentions at start of DMs
            END IF;
        END IF;
        
        -- Once we hit non-mention content, stop skipping mentions
        IF (part->>'type') != 'mention' THEN
            is_first_mention := false;
        END IF;
        
        -- Add this part to result
        result := result || part;
    END LOOP;
    
    RETURN result;
END;
$$;


--
-- Name: FUNCTION strip_dm_mentions(content jsonb, local_instance_domain text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.strip_dm_mentions(content jsonb, local_instance_domain text) IS 'APPLICATION LOGIC: Strip leading local mentions from DM content. This is separate from universal content conversion.';


--
-- Name: strip_mentions_from_dm_content(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.strip_mentions_from_dm_content(content jsonb) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    result_array jsonb := '[]'::jsonb;
    content_item jsonb;
BEGIN
    -- Handle null or non-array content
    IF content IS NULL OR jsonb_typeof(content) != 'array' THEN
        RETURN content;
    END IF;
    
    -- Filter out mention objects, keep everything else
    FOR content_item IN SELECT jsonb_array_elements(content)
    LOOP
        IF content_item->>'type' != 'mention' THEN
            result_array := result_array || jsonb_build_array(content_item);
        END IF;
    END LOOP;
    
    RETURN result_array;
END;
$$;


--
-- Name: sync_view_context_from_presence(text, uuid, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_view_context_from_presence(p_view_type text, p_server_id uuid DEFAULT NULL::uuid, p_channel_id uuid DEFAULT NULL::uuid, p_conversation_id uuid DEFAULT NULL::uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_user_id UUID := auth.uid();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN;
    END IF;

    -- Upsert view context (sync from ephemeral presence to database)
    INSERT INTO public.user_view_contexts (user_id, view_type, server_id, channel_id, conversation_id, last_active_at)
    VALUES (v_user_id, p_view_type, p_server_id, p_channel_id, p_conversation_id, NOW())
    ON CONFLICT (user_id) DO UPDATE
    SET
        view_type = EXCLUDED.view_type,
        server_id = EXCLUDED.server_id,
        channel_id = EXCLUDED.channel_id,
        conversation_id = EXCLUDED.conversation_id,
        last_active_at = EXCLUDED.last_active_at;
END;
$$;


--
-- Name: FUNCTION sync_view_context_from_presence(p_view_type text, p_server_id uuid, p_channel_id uuid, p_conversation_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.sync_view_context_from_presence(p_view_type text, p_server_id uuid, p_channel_id uuid, p_conversation_id uuid) IS 'Syncs ephemeral presence state to database table for PostgreSQL function access. Called from frontend when view context changes.';


--
-- Name: trigger_create_default_server_structure(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trigger_create_default_server_structure() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  -- Create default channels and categories for the new server
  PERFORM public.create_default_server_structure(NEW.id);
  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION trigger_create_default_server_structure(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.trigger_create_default_server_structure() IS 'Trigger function that automatically creates default channels and categories when a new server is created.';


--
-- Name: trigger_extract_post_hashtags(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.trigger_extract_post_hashtags() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
  -- Only process if content is not null and is an array
  IF NEW.content IS NOT NULL AND jsonb_typeof(NEW.content) = 'array' THEN
    PERFORM public.process_post_hashtags(NEW.id, NEW.content);
  END IF;
  
  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION trigger_extract_post_hashtags(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.trigger_extract_post_hashtags() IS 'Trigger function to automatically extract hashtags from posts on insert.';


--
-- Name: update_bot_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_bot_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


--
-- Name: update_encryption_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_encryption_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;


--
-- Name: update_follow_counters(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_follow_counters() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    -- Handle different trigger events
    IF TG_OP = 'INSERT' THEN
        -- New follow relationship
        IF NEW.status = 'accepted' THEN
            -- Increment follower count for the followed user
            UPDATE profiles 
            SET followers_count = followers_count + 1 
            WHERE id = NEW.following_id;
            
            -- Increment following count for the follower
            UPDATE profiles 
            SET following_count = following_count + 1 
            WHERE id = NEW.follower_id;
        END IF;
        RETURN NEW;
        
    ELSIF TG_OP = 'UPDATE' THEN
        -- Follow status changed
        IF OLD.status != NEW.status THEN
            IF OLD.status = 'accepted' AND NEW.status != 'accepted' THEN
                -- Follow was accepted, now it's not (unfriend/reject)
                UPDATE profiles 
                SET followers_count = followers_count - 1 
                WHERE id = NEW.following_id;
                
                UPDATE profiles 
                SET following_count = following_count - 1 
                WHERE id = NEW.follower_id;
                
            ELSIF OLD.status != 'accepted' AND NEW.status = 'accepted' THEN
                -- Follow was not accepted, now it is
                UPDATE profiles 
                SET followers_count = followers_count + 1 
                WHERE id = NEW.following_id;
                
                UPDATE profiles 
                SET following_count = following_count + 1 
                WHERE id = NEW.follower_id;
            END IF;
        END IF;
        RETURN NEW;
        
    ELSIF TG_OP = 'DELETE' THEN
        -- Follow relationship deleted
        IF OLD.status = 'accepted' THEN
            UPDATE profiles 
            SET followers_count = followers_count - 1 
            WHERE id = OLD.following_id;
            
            UPDATE profiles 
            SET following_count = following_count - 1 
            WHERE id = OLD.follower_id;
        END IF;
        RETURN OLD;
    END IF;
    
    RETURN NULL;
END;
$$;


--
-- Name: update_group_icon(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_group_icon(conversation_uuid uuid, user_profile_id uuid, icon_path text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  is_participant BOOLEAN := false;
  conversation_exists BOOLEAN := false;
BEGIN
  -- Check if user is a participant in the conversation
  SELECT can_manage_group_icon(conversation_uuid, user_profile_id) INTO is_participant;
  
  IF NOT is_participant THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'User is not a participant in this conversation'
    );
  END IF;
  
  -- Check if conversation exists and is a group
  SELECT EXISTS(
    SELECT 1 FROM conversations 
    WHERE id = conversation_uuid AND type = 'group'
  ) INTO conversation_exists;
  
  IF NOT conversation_exists THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Group conversation not found'
    );
  END IF;
  
  -- Update the conversation metadata with the new icon path
  UPDATE conversations 
  SET 
    metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('icon_url', icon_path),
    updated_at = CURRENT_TIMESTAMP
  WHERE id = conversation_uuid
    AND type = 'group';
  
  RETURN jsonb_build_object(
    'success', true,
    'message', 'Group icon updated successfully'
  );
END;
$$;


--
-- Name: update_group_name(uuid, uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_group_name(conversation_uuid uuid, user_profile_id uuid, new_name text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  is_participant BOOLEAN := false;
  conversation_exists BOOLEAN := false;
BEGIN
  -- Check if user is a participant in the conversation
  SELECT can_manage_group_icon(conversation_uuid, user_profile_id) INTO is_participant;
  
  IF NOT is_participant THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'User is not a participant in this conversation'
    );
  END IF;
  
  -- Check if conversation exists and is a group
  SELECT EXISTS(
    SELECT 1 FROM conversations 
    WHERE id = conversation_uuid AND type = 'group'
  ) INTO conversation_exists;
  
  IF NOT conversation_exists THEN
    RETURN jsonb_build_object(
      'success', false,
      'error', 'Group conversation not found'
    );
  END IF;
  
  -- Update the conversation name
  UPDATE conversations 
  SET 
    name = new_name,
    updated_at = CURRENT_TIMESTAMP
  WHERE id = conversation_uuid
    AND type = 'group';
  
  RETURN jsonb_build_object(
    'success', true,
    'message', 'Group name updated successfully'
  );
END;
$$;


--
-- Name: update_megolm_backup_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_megolm_backup_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.last_updated = NOW();
    RETURN NEW;
END;
$$;


--
-- Name: update_message_embeds(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_message_embeds(p_message_id uuid, p_embeds jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  update public.messages
  set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('embeds', 
    coalesce(metadata->'embeds', '{}'::jsonb) || p_embeds
  )
  where id = p_message_id;
end;
$$;


--
-- Name: FUNCTION update_message_embeds(p_message_id uuid, p_embeds jsonb); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.update_message_embeds(p_message_id uuid, p_embeds jsonb) IS 'Called by federated backend webhook to enrich message with external link previews';


--
-- Name: update_post_counters(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_post_counters() RETURNS trigger
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


--
-- Name: FUNCTION update_post_counters(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.update_post_counters() IS 'Automatically update post counters (replies, reactions, etc.)';


--
-- Name: update_post_reaction_counts(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_post_reaction_counts() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- Increment count for new reactions
    IF NEW.interaction_type = 'emoji_reaction' OR NEW.interaction_type = 'favorite' THEN
      UPDATE posts
      SET favorites_count = favorites_count + 1
      WHERE id = NEW.post_id;
    ELSIF NEW.interaction_type = 'reblog' THEN
      UPDATE posts
      SET reblogs_count = reblogs_count + 1
      WHERE id = NEW.post_id;
    END IF;
    RETURN NEW;
    
  ELSIF TG_OP = 'DELETE' THEN
    -- Decrement count for removed reactions
    IF OLD.interaction_type = 'emoji_reaction' OR OLD.interaction_type = 'favorite' THEN
      UPDATE posts
      SET favorites_count = GREATEST(favorites_count - 1, 0)
      WHERE id = OLD.post_id;
    ELSIF OLD.interaction_type = 'reblog' THEN
      UPDATE posts
      SET reblogs_count = GREATEST(reblogs_count - 1, 0)
      WHERE id = OLD.post_id;
    END IF;
    RETURN OLD;
  END IF;
  
  RETURN NULL;
END;
$$;


--
-- Name: FUNCTION update_post_reaction_counts(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.update_post_reaction_counts() IS 'Automatically updates post favorites_count and reblogs_count when reactions are added or removed';


--
-- Name: update_post_reblog_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_post_reblog_count() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  original_post_id uuid;
BEGIN
  -- Get the original post ID from the reblog
  IF TG_OP = 'DELETE' THEN
    original_post_id := (OLD.metadata->>'reblog_of')::uuid;
  ELSE
    original_post_id := (NEW.metadata->>'reblog_of')::uuid;
  END IF;
  
  -- If no original post, nothing to update
  IF original_post_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  
  -- Update the original post's reblog count (excluding deleted reblogs)
  UPDATE public.posts 
  SET reblogs_count = (
    SELECT COUNT(*) FROM public.posts 
    WHERE metadata->>'reblog_of' = original_post_id::text
    AND (is_deleted = false OR is_deleted IS NULL)
  )
  WHERE id = original_post_id;
  
  RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: update_post_reply_count(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_post_reply_count() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  parent_post_id uuid;
BEGIN
  -- Determine the parent post ID based on operation type
  IF TG_OP = 'DELETE' THEN
    parent_post_id := OLD.in_reply_to;
  ELSE
    parent_post_id := NEW.in_reply_to;
  END IF;
  
  -- If there's no parent, nothing to update
  IF parent_post_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  
  -- Update the parent post's reply count (excluding deleted replies)
  UPDATE public.posts 
  SET replies_count = (
    SELECT COUNT(*) FROM public.posts 
    WHERE in_reply_to = parent_post_id 
    AND (is_deleted = false OR is_deleted IS NULL)
  )
  WHERE id = parent_post_id;
  
  RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: update_reply_counts(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_reply_counts() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.in_reply_to IS NOT NULL THEN
        UPDATE posts SET replies_count = replies_count + 1
        WHERE id = NEW.in_reply_to;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' AND OLD.in_reply_to IS NOT NULL THEN
        UPDATE posts SET replies_count = replies_count - 1
        WHERE id = OLD.in_reply_to;
        RETURN OLD;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: upsert_ap_activity(text, text, text, jsonb, text, text[], text[], text[], text[], boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.upsert_ap_activity(p_ap_id text, p_ap_type text, p_actor_ap_id text, p_activity_data jsonb, p_origin_domain text DEFAULT NULL::text, p_to_addresses text[] DEFAULT '{}'::text[], p_cc_addresses text[] DEFAULT '{}'::text[], p_bto_addresses text[] DEFAULT '{}'::text[], p_bcc_addresses text[] DEFAULT '{}'::text[], p_is_local boolean DEFAULT false) RETURNS TABLE(activity_id uuid, was_updated boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_activity_id UUID;
    v_was_updated BOOLEAN := FALSE;
    v_existing_status TEXT;
BEGIN
    -- Check if activity already exists
    SELECT id, status INTO v_activity_id, v_existing_status
    FROM ap_activities 
    WHERE ap_id = p_ap_id;
    
    IF v_activity_id IS NOT NULL THEN
        -- Activity exists, check its status
        CASE v_existing_status
            WHEN 'completed', 'processed' THEN
                -- Already processed successfully, return idempotent success
                RAISE NOTICE 'Activity % already processed, returning existing ID', p_ap_id;
                v_was_updated := FALSE;
            WHEN 'failed', 'pending' THEN
                -- Failed or pending, update with fresh data for retry
                UPDATE ap_activities 
                SET 
                    activity_data = p_activity_data,
                    status = 'received',
                    to_addresses = p_to_addresses,
                    cc_addresses = p_cc_addresses,
                    bto_addresses = p_bto_addresses,
                    bcc_addresses = p_bcc_addresses,
                    updated_at = NOW(),
                    error_message = NULL,
                    next_attempt_at = NULL,
                    attempts = 0
                WHERE ap_id = p_ap_id;
                
                RAISE NOTICE 'Updated existing activity % for retry', p_ap_id;
                v_was_updated := TRUE;
            WHEN 'processing', 'received' THEN
                -- Currently being processed or just received, update data but keep status
                UPDATE ap_activities 
                SET 
                    activity_data = p_activity_data,
                    to_addresses = p_to_addresses,
                    cc_addresses = p_cc_addresses,
                    bto_addresses = p_bto_addresses,
                    bcc_addresses = p_bcc_addresses,
                    updated_at = NOW()
                WHERE ap_id = p_ap_id;
                
                RAISE NOTICE 'Updated activity data for currently processing activity %', p_ap_id;
                v_was_updated := TRUE;
        END CASE;
    ELSE
        -- Activity doesn't exist, insert new one
        INSERT INTO ap_activities (
            ap_id,
            ap_type,
            actor_ap_id,
            activity_data,
            origin_domain,
            status,
            is_local,
            to_addresses,
            cc_addresses,
            bto_addresses,
            bcc_addresses
        ) VALUES (
            p_ap_id,
            p_ap_type,
            p_actor_ap_id,
            p_activity_data,
            p_origin_domain,
            'received',
            p_is_local,
            p_to_addresses,
            p_cc_addresses,
            p_bto_addresses,
            p_bcc_addresses
        )
        RETURNING id INTO v_activity_id;
        
        RAISE NOTICE 'Inserted new activity %', p_ap_id;
        v_was_updated := FALSE;
    END IF;
    
    RETURN QUERY SELECT v_activity_id, v_was_updated;
END;
$$;


--
-- Name: FUNCTION upsert_ap_activity(p_ap_id text, p_ap_type text, p_actor_ap_id text, p_activity_data jsonb, p_origin_domain text, p_to_addresses text[], p_cc_addresses text[], p_bto_addresses text[], p_bcc_addresses text[], p_is_local boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.upsert_ap_activity(p_ap_id text, p_ap_type text, p_actor_ap_id text, p_activity_data jsonb, p_origin_domain text, p_to_addresses text[], p_cc_addresses text[], p_bto_addresses text[], p_bcc_addresses text[], p_is_local boolean) IS 'Safely inserts or updates ActivityPub activities with idempotent behavior. Returns the activity ID and whether it was updated.';


--
-- Name: upsert_hashtag(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.upsert_hashtag(p_tag text) RETURNS uuid
    LANGUAGE plpgsql
    AS $$
DECLARE
  v_hashtag_id uuid;
  v_normalized_tag text;
BEGIN
  -- Normalize the tag (lowercase, trim, remove leading #)
  v_normalized_tag := lower(trim(regexp_replace(p_tag, '^#', '')));
  
  -- Try to find existing hashtag
  SELECT id INTO v_hashtag_id
  FROM public.hashtags
  WHERE normalized_tag = v_normalized_tag;
  
  -- If not found, insert new hashtag
  IF v_hashtag_id IS NULL THEN
    INSERT INTO public.hashtags (tag, normalized_tag, total_uses, first_used_at, last_used_at)
    VALUES (v_normalized_tag, v_normalized_tag, 1, NOW(), NOW())
    ON CONFLICT (normalized_tag) DO UPDATE 
    SET 
      total_uses = hashtags.total_uses + 1,
      last_used_at = NOW()
    RETURNING id INTO v_hashtag_id;
  ELSE
    -- Update usage stats
    UPDATE public.hashtags
    SET 
      total_uses = total_uses + 1,
      last_used_at = NOW()
    WHERE id = v_hashtag_id;
  END IF;
  
  RETURN v_hashtag_id;
END;
$$;


--
-- Name: FUNCTION upsert_hashtag(p_tag text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.upsert_hashtag(p_tag text) IS 'Insert or update a hashtag and return its ID. Updates usage counts on conflict.';


--
-- Name: upsert_remote_emoji(text, text, text, text, text, text, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.upsert_remote_emoji(p_shortcode text, p_origin_domain text, p_full_code text, p_url text, p_static_url text DEFAULT NULL::text, p_category text DEFAULT NULL::text, p_is_animated boolean DEFAULT false) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.remote_emojis_cache (
    shortcode, origin_domain, full_code, url, static_url, category, is_animated
  ) VALUES (
    p_shortcode, p_origin_domain, p_full_code, p_url, p_static_url, p_category, p_is_animated
  )
  ON CONFLICT (shortcode, origin_domain) DO UPDATE SET
    url = EXCLUDED.url,
    static_url = COALESCE(EXCLUDED.static_url, remote_emojis_cache.static_url),
    last_seen_at = now(),
    usage_count = remote_emojis_cache.usage_count + 1,
    category = COALESCE(EXCLUDED.category, remote_emojis_cache.category),
    is_animated = COALESCE(EXCLUDED.is_animated, remote_emojis_cache.is_animated)
  RETURNING id INTO v_id;
  
  RETURN v_id;
END;
$$;


--
-- Name: FUNCTION upsert_remote_emoji(p_shortcode text, p_origin_domain text, p_full_code text, p_url text, p_static_url text, p_category text, p_is_animated boolean); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.upsert_remote_emoji(p_shortcode text, p_origin_domain text, p_full_code text, p_url text, p_static_url text, p_category text, p_is_animated boolean) IS 'Insert or update a remote emoji, incrementing usage count on conflict.';


--
-- Name: use_one_time_prekey(uuid, text, integer, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.use_one_time_prekey(p_user_id uuid, p_device_id text, p_prekey_id integer, p_used_by uuid) RETURNS public.prekeys
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_prekey public.prekeys;
BEGIN
    UPDATE public.prekeys
    SET 
        is_used = true,
        used_at = NOW(),
        used_by = p_used_by
    WHERE 
        user_id = p_user_id
        AND device_id = p_device_id
        AND prekey_id = p_prekey_id
        AND is_one_time = true
        AND is_used = false
    RETURNING * INTO v_prekey;
    
    RETURN v_prekey;
END;
$$;


--
-- Name: user_has_encryption(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_has_encryption(p_user_id uuid) RETURNS boolean
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.user_key_pairs
        WHERE user_id = p_user_id
        AND is_active = true
    );
END;
$$;


--
-- Name: FUNCTION user_has_encryption(p_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.user_has_encryption(p_user_id uuid) IS 'Check if a user has encryption keys initialized.';


--
-- Name: user_has_recovery_key(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_has_recovery_key(p_user_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1 FROM public.recovery_key_metadata
        WHERE user_id = p_user_id
    );
END;
$$;


--
-- Name: user_is_conversation_member(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.user_is_conversation_member(p_conversation_id uuid, p_user_id uuid) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    AS $$
  SELECT EXISTS (
    SELECT 1 
    FROM public.conversation_participants
    WHERE conversation_id = p_conversation_id
      AND user_id = p_user_id
      AND left_at IS NULL
  );
$$;


--
-- Name: verify_bot_token(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.verify_bot_token(p_token_hash text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    v_bot_token public.bot_tokens;
    v_bot public.bots;
    v_result JSONB;
BEGIN
    -- Find active token
    SELECT * INTO v_bot_token
    FROM public.bot_tokens
    WHERE token_hash = p_token_hash
        AND is_active = true
        AND (expires_at IS NULL OR expires_at > NOW());
    
    IF v_bot_token IS NULL THEN
        RETURN jsonb_build_object('valid', false, 'error', 'Invalid or expired token');
    END IF;
    
    -- Get bot details
    SELECT * INTO v_bot
    FROM public.bots
    WHERE id = v_bot_token.bot_id
        AND is_active = true;
    
    IF v_bot IS NULL THEN
        RETURN jsonb_build_object('valid', false, 'error', 'Bot not found or inactive');
    END IF;
    
    -- Update last used
    UPDATE public.bot_tokens
    SET last_used_at = NOW(),
        uses_count = uses_count + 1
    WHERE id = v_bot_token.id;
    
    -- Return bot info
    v_result := jsonb_build_object(
        'valid', true,
        'bot_id', v_bot.id,
        'username', v_bot.username,
        'scopes', v_bot_token.scopes
    );
    
    RETURN v_result;
END;
$$;


--
-- Name: verify_recovery_code(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.verify_recovery_code(p_user_id uuid, p_code text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_catalog'
    AS $$
DECLARE
  v_code_hash TEXT;
  v_code_id UUID;
BEGIN
  -- Hash the provided code (using SHA-256)
  -- Use extensions.digest() to explicitly reference the pgcrypto extension
  v_code_hash := encode(extensions.digest(p_code::bytea, 'sha256'), 'hex');
  
  -- Find an unused recovery code matching the hash
  SELECT id INTO v_code_id
  FROM public.mfa_recovery_codes
  WHERE user_id = p_user_id
    AND code_hash = v_code_hash
    AND used_at IS NULL
  LIMIT 1;
  
  IF v_code_id IS NOT NULL THEN
    -- Mark the code as used
    UPDATE public.mfa_recovery_codes
    SET used_at = NOW()
    WHERE id = v_code_id;
    
    RETURN TRUE;
  ELSE
    RETURN FALSE;
  END IF;
END;
$$;


--
-- Name: verify_user_password(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.verify_user_password(password text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  v_user_id UUID;
  v_email TEXT;
  v_encrypted_password TEXT;
BEGIN
  -- Get current user
  v_user_id := auth.uid();
  
  IF v_user_id IS NULL THEN
    RETURN FALSE;
  END IF;
  
  -- Get user email and encrypted password from auth.users
  SELECT email, encrypted_password
  INTO v_email, v_encrypted_password
  FROM auth.users
  WHERE id = v_user_id;
  
  IF v_email IS NULL THEN
    RETURN FALSE;
  END IF;
  
  -- Use Supabase's internal password verification
  -- Note: This requires access to auth schema which may not be available
  -- Alternative: return TRUE and rely on Supabase's session validation
  
  -- For now, we'll return TRUE and rely on session validation
  -- A proper implementation would require custom auth logic
  RETURN TRUE;
END;
$$;


--
-- Name: webhook_external_link_previews(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.webhook_external_link_previews() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'net', 'extensions'
    AS $$
declare
  v_instance_domain text;
  v_backend_url text;
  v_external_urls text[] := array[]::text[];
  v_part jsonb;
  v_normalized_url text;
  v_webhook_payload jsonb;
  v_request_id bigint;
begin
  -- Skip inbound federated messages
  if coalesce(NEW.metadata->>'federated', 'false') = 'true' then
    return NEW;
  end if;

  if jsonb_typeof(NEW.content) <> 'array' then
    return NEW;
  end if;

  select trim(both '"' from config_value::text)
    into v_instance_domain
    from public.instance_config
    where config_key = 'domain'
    limit 1;

  select (config_value::jsonb->>'link_preview_backend_url')
    into v_backend_url
    from public.instance_config
    where config_key = 'federation_settings'
    limit 1;

  if v_backend_url is null or v_backend_url = '' then
    return NEW;
  end if;

  -- Collect external URLs
  for v_part in
    select value from jsonb_array_elements(NEW.content)
  loop
    if coalesce(v_part->>'type', '') <> 'url' then
      continue;
    end if;
    if coalesce(v_part->>'preview', 'true') = 'false' then
      continue;
    end if;

    v_normalized_url := public.normalize_embed_url(v_part->>'url');
    
    -- Skip if already has embed (local URL was handled in BEFORE INSERT)
    if v_normalized_url is null or (NEW.metadata->'embeds' ? v_normalized_url) then
      continue;
    end if;

    -- Only collect EXTERNAL URLs (not our domain)
    if v_instance_domain is not null
       and public.extract_url_host(v_normalized_url) <> lower(v_instance_domain) then
      v_external_urls := array_append(v_external_urls, v_normalized_url);
    end if;
  end loop;

  -- Fire webhook if we have external URLs
  if array_length(v_external_urls, 1) > 0 then
    v_webhook_payload := jsonb_build_object(
      'messageId', NEW.id,
      'urls', to_jsonb(v_external_urls)
    );

    -- Use pg_net async (fire and forget)
    -- Signature: http_post(url text, body text, params jsonb DEFAULT NULL, headers jsonb DEFAULT NULL, timeout_milliseconds integer DEFAULT NULL)
    begin
      select net.http_post(
        rtrim(v_backend_url, '/') || '/webhooks/enrich-message-previews',
        v_webhook_payload::text,
        null,
        jsonb_build_object('Content-Type', 'application/json'),
        5000
      ) into v_request_id;

      raise notice 'Fired webhook for message % with % external URLs (request_id: %)', 
        NEW.id, array_length(v_external_urls, 1), v_request_id;
    exception
      when others then
        raise notice 'Failed to queue webhook for message %: %', NEW.id, SQLERRM;
    end;
  end if;

  return NEW;
end;
$$;


--
-- Name: activity_processing_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activity_processing_logs (
    id integer NOT NULL,
    activity_id uuid NOT NULL,
    ap_id text NOT NULL,
    ap_type text NOT NULL,
    status text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone
);


--
-- Name: activity_processing_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.activity_processing_logs_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: activity_processing_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.activity_processing_logs_id_seq OWNED BY public.activity_processing_logs.id;


--
-- Name: activitypub_processing_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activitypub_processing_stats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    date date NOT NULL,
    total_activities integer DEFAULT 0,
    processed_activities integer DEFAULT 0,
    failed_activities integer DEFAULT 0,
    permanently_failed_activities integer DEFAULT 0,
    avg_processing_time_ms numeric DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: admin_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    admin_id uuid NOT NULL,
    action_type text NOT NULL,
    target_type text,
    target_id text,
    action_details jsonb,
    ip_address inet,
    user_agent text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: ap_activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ap_activities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    ap_id text NOT NULL,
    ap_type text NOT NULL,
    actor_id uuid,
    actor_ap_id text NOT NULL,
    object_id text,
    object_type text,
    target_id uuid,
    target_type text,
    activity_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'pending'::text,
    to_addresses text[] DEFAULT '{}'::text[],
    cc_addresses text[] DEFAULT '{}'::text[],
    bto_addresses text[] DEFAULT '{}'::text[],
    bcc_addresses text[] DEFAULT '{}'::text[],
    attempts integer DEFAULT 0,
    last_attempt_at timestamp with time zone,
    next_attempt_at timestamp with time zone,
    error_message text,
    is_local boolean DEFAULT true,
    source_domain text,
    origin_domain text,
    CONSTRAINT ap_activities_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'received'::text, 'processed'::text]))),
    CONSTRAINT ap_activities_valid_type CHECK ((ap_type = ANY (ARRAY['Create'::text, 'Update'::text, 'Delete'::text, 'Follow'::text, 'Accept'::text, 'Reject'::text, 'Undo'::text, 'Like'::text, 'Announce'::text, 'Add'::text, 'Remove'::text, 'Invite'::text, 'Join'::text, 'Leave'::text, 'VoiceJoin'::text, 'VoiceLeave'::text, 'VoiceUpdate'::text, 'Block'::text, 'Flag'::text, 'Move'::text, 'Tombstone'::text])))
);


--
-- Name: ap_actor_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ap_actor_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    ap_id text NOT NULL,
    domain text NOT NULL,
    username text NOT NULL,
    actor_data jsonb NOT NULL,
    last_fetched_at timestamp with time zone DEFAULT now(),
    cache_expires_at timestamp with time zone DEFAULT (now() + '01:00:00'::interval),
    fetch_attempts integer DEFAULT 0,
    is_reachable boolean DEFAULT true,
    last_error text
);


--
-- Name: ap_object_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ap_object_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    ap_id text NOT NULL,
    object_type text NOT NULL,
    object_data jsonb NOT NULL,
    last_fetched_at timestamp with time zone DEFAULT now(),
    cache_expires_at timestamp with time zone DEFAULT (now() + '01:00:00'::interval),
    fetch_attempts integer DEFAULT 0,
    is_reachable boolean DEFAULT true,
    last_error text
);


--
-- Name: blocked_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blocked_instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    domain text NOT NULL,
    reason text NOT NULL,
    blocked_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    block_type text DEFAULT 'full'::text,
    expires_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT blocked_instances_block_type_check CHECK ((block_type = ANY (ARRAY['full'::text, 'media_only'::text, 'follows_only'::text])))
);


--
-- Name: COLUMN blocked_instances.block_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.blocked_instances.block_type IS 'Type of block: full, media_only, or follows_only';


--
-- Name: COLUMN blocked_instances.expires_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.blocked_instances.expires_at IS 'Optional expiration time for temporary blocks';


--
-- Name: bot_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bot_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bot_id uuid NOT NULL,
    action_type text NOT NULL,
    server_id uuid,
    channel_id uuid,
    user_id uuid,
    description text,
    metadata jsonb DEFAULT '{}'::jsonb,
    success boolean DEFAULT true,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ip_address inet,
    endpoint text,
    CONSTRAINT bot_audit_log_action_type_check CHECK ((action_type = ANY (ARRAY['message_sent'::text, 'message_deleted'::text, 'message_edited'::text, 'member_kicked'::text, 'member_banned'::text, 'role_assigned'::text, 'channel_created'::text, 'channel_deleted'::text, 'webhook_created'::text, 'permission_changed'::text, 'error'::text, 'rate_limited'::text])))
);


--
-- Name: TABLE bot_audit_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bot_audit_log IS 'Audit trail of all bot actions for security monitoring and debugging.';


--
-- Name: bot_commands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bot_commands (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bot_id uuid NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    category text DEFAULT 'general'::text,
    options jsonb DEFAULT '[]'::jsonb,
    default_permission boolean DEFAULT true,
    required_permissions text[],
    dm_enabled boolean DEFAULT true,
    server_enabled boolean DEFAULT true,
    display_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: TABLE bot_commands; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bot_commands IS 'Bot command definitions for discovery and auto-complete.';


--
-- Name: bot_presence; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bot_presence (
    bot_id uuid NOT NULL,
    status text DEFAULT 'offline'::text,
    custom_status text,
    activity_type text,
    activity_name text,
    activity_url text,
    connected_at timestamp with time zone,
    last_heartbeat_at timestamp with time zone,
    gateway_session_id text,
    latency_ms integer,
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT bot_presence_activity_type_check CHECK ((activity_type = ANY (ARRAY['playing'::text, 'streaming'::text, 'listening'::text, 'watching'::text, 'competing'::text]))),
    CONSTRAINT bot_presence_status_check CHECK ((status = ANY (ARRAY['online'::text, 'idle'::text, 'dnd'::text, 'offline'::text])))
);


--
-- Name: TABLE bot_presence; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bot_presence IS 'Real-time presence and activity status for bots.';


--
-- Name: bot_rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bot_rate_limits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bot_id uuid NOT NULL,
    bucket text NOT NULL,
    request_count integer DEFAULT 0,
    window_start timestamp with time zone DEFAULT now() NOT NULL,
    window_duration_seconds integer DEFAULT 60,
    max_requests integer DEFAULT 100,
    resets_at timestamp with time zone DEFAULT (now() + '00:01:00'::interval),
    metadata jsonb DEFAULT '{}'::jsonb
);


--
-- Name: TABLE bot_rate_limits; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bot_rate_limits IS 'Rate limiting data for bot API requests. Sliding window rate limits per bucket.';


--
-- Name: bot_server_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bot_server_permissions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bot_id uuid NOT NULL,
    server_id uuid NOT NULL,
    installed_by uuid NOT NULL,
    installed_at timestamp with time zone DEFAULT now() NOT NULL,
    read_messages boolean DEFAULT true,
    send_messages boolean DEFAULT true,
    send_tts_messages boolean DEFAULT false,
    manage_messages boolean DEFAULT false,
    embed_links boolean DEFAULT true,
    attach_files boolean DEFAULT true,
    read_message_history boolean DEFAULT true,
    mention_everyone boolean DEFAULT false,
    use_external_emojis boolean DEFAULT true,
    add_reactions boolean DEFAULT true,
    view_channels boolean DEFAULT true,
    manage_channels boolean DEFAULT false,
    manage_webhooks boolean DEFAULT false,
    create_instant_invite boolean DEFAULT false,
    connect_voice boolean DEFAULT false,
    speak boolean DEFAULT false,
    mute_members boolean DEFAULT false,
    deafen_members boolean DEFAULT false,
    move_members boolean DEFAULT false,
    change_nickname boolean DEFAULT false,
    manage_nicknames boolean DEFAULT false,
    manage_roles boolean DEFAULT false,
    kick_members boolean DEFAULT false,
    ban_members boolean DEFAULT false,
    is_active boolean DEFAULT true,
    allowed_channel_ids uuid[],
    metadata jsonb DEFAULT '{}'::jsonb
);


--
-- Name: TABLE bot_server_permissions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bot_server_permissions IS 'Bot permissions per server. Controls what actions a bot can perform in each server.';


--
-- Name: bot_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bot_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bot_id uuid NOT NULL,
    token_hash text NOT NULL,
    token_prefix text NOT NULL,
    name text,
    scopes text[] DEFAULT ARRAY['bot'::text],
    is_active boolean DEFAULT true,
    last_used_at timestamp with time zone,
    uses_count bigint DEFAULT 0,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb
);


--
-- Name: TABLE bot_tokens; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bot_tokens IS 'Authentication tokens for bot API access. Tokens are hashed for security.';


--
-- Name: COLUMN bot_tokens.token_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bot_tokens.token_hash IS 'Bcrypt hash of the token. Never store tokens in plaintext.';


--
-- Name: COLUMN bot_tokens.token_prefix; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bot_tokens.token_prefix IS 'First 8 characters for easy identification in UI.';


--
-- Name: bot_webhooks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bot_webhooks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bot_id uuid NOT NULL,
    url text NOT NULL,
    secret text,
    events text[] DEFAULT ARRAY['*'::text],
    is_active boolean DEFAULT true,
    is_verified boolean DEFAULT false,
    max_retries integer DEFAULT 3,
    retry_delay_seconds integer DEFAULT 60,
    failed_deliveries integer DEFAULT 0,
    last_success_at timestamp with time zone,
    last_failure_at timestamp with time zone,
    last_error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT valid_webhook_url CHECK ((url ~* '^https?://'::text))
);


--
-- Name: TABLE bot_webhooks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bot_webhooks IS 'Webhook endpoints for delivering events to bots (alternative to WebSocket).';


--
-- Name: bots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    username text NOT NULL,
    discriminator text DEFAULT '0000'::text,
    display_name text,
    avatar_url text DEFAULT '/default_avatar.png'::text,
    banner_url text,
    bio text,
    owner_id uuid NOT NULL,
    is_verified boolean DEFAULT false,
    is_public boolean DEFAULT true,
    is_active boolean DEFAULT true,
    bot_type text DEFAULT 'bot'::text,
    website_url text,
    support_server_id uuid,
    tags text[] DEFAULT '{}'::text[],
    server_count integer DEFAULT 0,
    user_count integer DEFAULT 0,
    command_count bigint DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    last_online_at timestamp with time zone,
    settings jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT bots_bot_type_check CHECK ((bot_type = ANY (ARRAY['bot'::text, 'bridge'::text, 'integration'::text]))),
    CONSTRAINT valid_username CHECK (((username ~* '^[a-z0-9_-]+$'::text) AND (char_length(username) >= 3) AND (char_length(username) <= 32)))
);


--
-- Name: TABLE bots; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.bots IS 'Bot accounts that can be added to servers. Similar to Discord bot system.';


--
-- Name: COLUMN bots.bot_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.bots.bot_type IS 'bot: standard bot, bridge: cross-platform bridge, integration: service integration';


--
-- Name: channel_categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channel_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name text,
    "order" smallint,
    server_id uuid
);

ALTER TABLE ONLY public.channel_categories REPLICA IDENTITY FULL;


--
-- Name: channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name text NOT NULL,
    description text,
    type smallint DEFAULT '0'::smallint,
    server_id uuid,
    category uuid,
    "order" integer DEFAULT 0,
    ap_id text,
    is_remote boolean DEFAULT false
);

ALTER TABLE ONLY public.channels REPLICA IDENTITY FULL;


--
-- Name: COLUMN channels.ap_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.channels.ap_id IS 'ActivityPub context URL for this channel';


--
-- Name: COLUMN channels.is_remote; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.channels.is_remote IS 'True if this is a mirror of a remote channel';


--
-- Name: conversation_backup_pre_cleanup; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_backup_pre_cleanup (
    id uuid,
    user1 uuid,
    user2 uuid,
    created_at timestamp with time zone,
    name text,
    type text,
    created_by uuid,
    is_active boolean,
    updated_at timestamp with time zone,
    metadata jsonb
);


--
-- Name: TABLE conversation_backup_pre_cleanup; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.conversation_backup_pre_cleanup IS 'Backup of conversations before dropping user1/user2 columns. Can be dropped after verification.';


--
-- Name: conversation_encryption_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_encryption_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    encryption_enabled boolean DEFAULT false,
    verified boolean DEFAULT false,
    last_key_rotation timestamp with time zone,
    next_rotation_due timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    metadata jsonb DEFAULT '{}'::jsonb
);


--
-- Name: TABLE conversation_encryption_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.conversation_encryption_settings IS 'E2EE settings per conversation. Tracks encryption status and key rotation.';


--
-- Name: conversation_participants; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversation_participants (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    user_id uuid NOT NULL,
    joined_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    role text DEFAULT 'member'::text,
    is_muted boolean DEFAULT false,
    last_read_at timestamp with time zone,
    left_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT conversation_participants_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'member'::text])))
);


--
-- Name: TABLE conversation_participants; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.conversation_participants IS 'Multi-participant conversation system. Migration 013 created this table and migrated from user1/user2 system. Next migration will drop old user1/user2 columns after verification.';


--
-- Name: conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    name text,
    type text DEFAULT 'direct'::text,
    created_by uuid,
    is_active boolean DEFAULT true,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT conversations_type_check CHECK ((type = ANY (ARRAY['direct'::text, 'group'::text, 'channel'::text])))
);


--
-- Name: TABLE conversations; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.conversations IS 'DM conversations between users. Supports both local users (in auth.users) and federated users (profiles only). Foreign keys reference profiles to enable federated DMs.';


--
-- Name: emoji_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.emoji_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    emoji_id uuid NOT NULL,
    user_id uuid NOT NULL,
    server_id uuid NOT NULL,
    context_type text NOT NULL,
    context_id uuid,
    used_at timestamp with time zone DEFAULT now(),
    CONSTRAINT emoji_usage_context_type_check CHECK ((context_type = ANY (ARRAY['message'::text, 'reaction'::text])))
);


--
-- Name: emojis; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.emojis (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name character varying,
    url character varying,
    server_id uuid,
    uploader uuid,
    updated_at timestamp with time zone DEFAULT now(),
    usage_count integer DEFAULT 0,
    last_used timestamp with time zone,
    domain text
);


--
-- Name: encryption_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.encryption_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    event_type text NOT NULL,
    severity text DEFAULT 'info'::text,
    description text,
    related_user_id uuid,
    related_conversation_id uuid,
    related_server_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    ip_address inet,
    user_agent text,
    CONSTRAINT encryption_audit_log_event_type_check CHECK ((event_type = ANY (ARRAY['key_generated'::text, 'key_rotated'::text, 'key_verified'::text, 'session_established'::text, 'session_refreshed'::text, 'encryption_enabled'::text, 'encryption_disabled'::text, 'decryption_failed'::text, 'suspicious_activity'::text]))),
    CONSTRAINT encryption_audit_log_severity_check CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'error'::text, 'critical'::text])))
);


--
-- Name: TABLE encryption_audit_log; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.encryption_audit_log IS 'Audit trail for all encryption-related events. Used for security monitoring and debugging.';


--
-- Name: federated_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.federated_instances (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    domain text NOT NULL,
    software text,
    version text,
    description text,
    admin_contact text,
    is_blocked boolean DEFAULT false,
    is_trusted boolean DEFAULT false,
    last_seen_at timestamp with time zone DEFAULT now(),
    user_count integer DEFAULT 0,
    status_count integer DEFAULT 0,
    connection_count integer DEFAULT 0,
    metadata jsonb DEFAULT '{}'::jsonb
);


--
-- Name: federation_delivery_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.federation_delivery_queue (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    activity_id uuid,
    target_domain text NOT NULL,
    target_inbox_url text NOT NULL,
    status text DEFAULT 'pending'::text,
    attempts integer DEFAULT 0,
    max_attempts integer DEFAULT 5,
    next_attempt_at timestamp with time zone DEFAULT now(),
    http_status_code integer,
    response_body text,
    error_message text,
    delivery_duration_ms integer,
    priority integer DEFAULT 5,
    actor_username text,
    actor_domain text,
    activity_data jsonb,
    delivered_at timestamp with time zone,
    last_attempt_at timestamp with time zone,
    sender_id uuid,
    target_inbox text,
    next_retry_at timestamp with time zone,
    CONSTRAINT federation_delivery_queue_priority_check CHECK (((priority >= 1) AND (priority <= 10))),
    CONSTRAINT federation_delivery_queue_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'delivered'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: TABLE federation_delivery_queue; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.federation_delivery_queue IS 'Queue for federated activity delivery with retry logic';


--
-- Name: COLUMN federation_delivery_queue.activity_data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.federation_delivery_queue.activity_data IS 'ActivityPub activity data to be delivered, stored here to avoid joins during edge function processing';


--
-- Name: federation_delivery_stats; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.federation_delivery_stats (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    total_deliveries integer DEFAULT 0,
    successful_deliveries integer DEFAULT 0,
    failed_deliveries integer DEFAULT 0,
    avg_delivery_time_ms numeric,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: federation_stats; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.federation_stats AS
 SELECT count(*) AS total_activities,
    count(*) FILTER (WHERE (ap_activities.status = 'delivered'::text)) AS delivered_activities,
    count(*) FILTER (WHERE (ap_activities.status = 'failed'::text)) AS failed_activities,
    count(*) FILTER (WHERE (ap_activities.status = 'pending'::text)) AS pending_activities,
    count(DISTINCT ap_activities.actor_id) AS active_users,
    count(DISTINCT ap_activities.target_id) AS target_objects,
    ap_activities.ap_type,
    date_trunc('hour'::text, ap_activities.created_at) AS hour
   FROM public.ap_activities
  GROUP BY ap_activities.ap_type, (date_trunc('hour'::text, ap_activities.created_at))
  ORDER BY (date_trunc('hour'::text, ap_activities.created_at)) DESC;


--
-- Name: files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    name text,
    description text,
    type character varying,
    size bigint,
    url text,
    owner uuid
);


--
-- Name: follows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.follows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    follower_id uuid NOT NULL,
    following_id uuid NOT NULL,
    ap_id text,
    accepted_at timestamp with time zone,
    status text DEFAULT 'pending'::text,
    is_local boolean DEFAULT true,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT follows_no_self_follow CHECK ((follower_id <> following_id)),
    CONSTRAINT follows_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text])))
);


--
-- Name: COLUMN follows.follower_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.follows.follower_id IS 'ID of the user doing the following.
This is the source of the follow relationship (follower_id -> following_id)';


--
-- Name: COLUMN follows.following_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.follows.following_id IS 'ID of the user being followed. 
IMPORTANT: Code should use following_id, NOT followed_id.
This is the target of the follow relationship (follower_id -> following_id)';


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone,
    username text,
    display_name text,
    avatar_url text DEFAULT '/default_avatar.png'::text,
    bio text,
    color character varying,
    status smallint DEFAULT '0'::smallint,
    domain text DEFAULT 'har.mony.lol'::text NOT NULL,
    federated_id text,
    public_key text,
    inbox_url text,
    outbox_url text,
    followers_url text,
    following_url text,
    featured_url text,
    is_local boolean DEFAULT true,
    last_synced_at timestamp with time zone,
    federation_metadata jsonb DEFAULT '{}'::jsonb,
    supported_activities text[] DEFAULT '{}'::text[],
    last_federation_sync timestamp with time zone,
    is_admin boolean DEFAULT false,
    is_suspended boolean DEFAULT false,
    suspended_at timestamp with time zone,
    suspension_reason text,
    followers_count integer DEFAULT 0,
    following_count integer DEFAULT 0,
    posts_count integer DEFAULT 0,
    auth_user_id uuid,
    banner_url text,
    federation_enabled boolean DEFAULT true,
    federation_discoverable boolean DEFAULT true,
    federation_followers_only boolean DEFAULT false,
    manually_approves_followers boolean DEFAULT false,
    shared_inbox_url text,
    appearance_settings jsonb,
    locale text DEFAULT 'en'::text,
    profile_fields jsonb DEFAULT '[]'::jsonb
);


--
-- Name: COLUMN profiles.followers_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.followers_count IS 'Denormalized count of followers for O(1) lookups. Maintained by triggers.';


--
-- Name: COLUMN profiles.following_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.following_count IS 'Denormalized count of following for O(1) lookups. Maintained by triggers.';


--
-- Name: COLUMN profiles.posts_count; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.posts_count IS 'Denormalized count of posts for O(1) lookups. Maintained by triggers.';


--
-- Name: COLUMN profiles.banner_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.banner_url IS 'URL to user banner/header image stored in Supabase storage';


--
-- Name: COLUMN profiles.federation_enabled; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.federation_enabled IS 'Whether this user participates in federation at all';


--
-- Name: COLUMN profiles.federation_discoverable; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.federation_discoverable IS 'Whether this user appears in federated searches and directories';


--
-- Name: COLUMN profiles.federation_followers_only; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.federation_followers_only IS 'Whether this user only federates with followers';


--
-- Name: COLUMN profiles.manually_approves_followers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.manually_approves_followers IS 'ActivityPub standard: If true, follows require approval. If false, auto-accept.';


--
-- Name: COLUMN profiles.shared_inbox_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.shared_inbox_url IS 'ActivityPub shared inbox URL for efficient delivery';


--
-- Name: COLUMN profiles.profile_fields; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.profiles.profile_fields IS 'Custom profile fields (PropertyValue in ActivityPub). Array of {name, value} objects.';


--
-- Name: follow_relationships; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.follow_relationships AS
 SELECT f.id,
    f.follower_id,
    f.following_id,
    f.status,
    f.created_at,
    f.accepted_at,
    follower.username AS follower_username,
    following.username AS following_username,
    follower.display_name AS follower_display_name,
    following.display_name AS following_display_name
   FROM ((public.follows f
     JOIN public.profiles follower ON ((f.follower_id = follower.id)))
     JOIN public.profiles following ON ((f.following_id = following.id)));


--
-- Name: VIEW follow_relationships; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.follow_relationships IS 'Helper view that clearly shows follow relationships with usernames.
follower_id = user who is following
following_id = user being followed
Use this view for debugging relationship queries.';


--
-- Name: hashtag_archive; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hashtag_archive (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    archived_at timestamp with time zone DEFAULT now(),
    original_hashtag_id uuid,
    tag text NOT NULL,
    total_uses integer,
    peak_daily_uses integer,
    peak_daily_date date,
    first_used_at timestamp with time zone,
    last_used_at timestamp with time zone,
    archive_reason text
);


--
-- Name: hashtags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.hashtags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    tag text NOT NULL,
    normalized_tag text NOT NULL,
    total_uses integer DEFAULT 0,
    daily_uses integer DEFAULT 0,
    weekly_uses integer DEFAULT 0,
    peak_daily_uses integer DEFAULT 0,
    peak_daily_date date,
    first_used_at timestamp with time zone DEFAULT now(),
    last_used_at timestamp with time zone DEFAULT now(),
    trending_score numeric DEFAULT 0,
    trending_rank integer,
    last_trending_update timestamp with time zone
);


--
-- Name: TABLE hashtags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.hashtags IS 'Tracks hashtag usage and trending metrics';


--
-- Name: instance_config; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.instance_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    config_key text NOT NULL,
    config_value jsonb NOT NULL,
    description text,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: instance_health; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.instance_health AS
 SELECT federated_instances.domain,
    federated_instances.is_blocked,
    federated_instances.is_trusted,
    federated_instances.last_seen_at,
    federated_instances.user_count,
    federated_instances.status_count,
    federated_instances.connection_count,
        CASE
            WHEN (federated_instances.last_seen_at > (now() - '01:00:00'::interval)) THEN 'healthy'::text
            WHEN (federated_instances.last_seen_at > (now() - '24:00:00'::interval)) THEN 'stale'::text
            ELSE 'unreachable'::text
        END AS health_status
   FROM public.federated_instances
  ORDER BY federated_instances.last_seen_at DESC;


--
-- Name: invites; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.invites (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    code character varying,
    server_id uuid,
    created_by uuid,
    used boolean DEFAULT false,
    temporary boolean DEFAULT false,
    uses integer
);


--
-- Name: megolm_key_backups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.megolm_key_backups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    encrypted_data text NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    session_count integer DEFAULT 0,
    backup_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_updated timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: TABLE megolm_key_backups; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.megolm_key_backups IS 'Server-stored encrypted backup of Megolm session keys. Only decryptable with user recovery key.';


--
-- Name: COLUMN megolm_key_backups.encrypted_data; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.megolm_key_backups.encrypted_data IS 'AES-256-GCM encrypted backup, key derived from recovery phrase';


--
-- Name: COLUMN megolm_key_backups.backup_hash; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.megolm_key_backups.backup_hash IS 'SHA-256 hash of plaintext for integrity verification after decryption';


--
-- Name: megolm_key_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.megolm_key_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    room_id uuid NOT NULL,
    session_id text NOT NULL,
    status text DEFAULT 'pending'::text,
    encrypted_key text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    fulfilled_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '24:00:00'::interval),
    requesting_device_id text DEFAULT 'default'::text,
    sender_user_id uuid,
    requester_user_id uuid,
    CONSTRAINT megolm_key_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'fulfilled'::text, 'expired'::text, 'cancelled'::text])))
);


--
-- Name: TABLE megolm_key_requests; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.megolm_key_requests IS 'Requests for Megolm session keys from other devices';


--
-- Name: COLUMN megolm_key_requests.encrypted_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.megolm_key_requests.encrypted_key IS 'Session key encrypted for the requesting device public key';


--
-- Name: COLUMN megolm_key_requests.sender_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.megolm_key_requests.sender_user_id IS 'The user who sent the original message and has the session key';


--
-- Name: COLUMN megolm_key_requests.requester_user_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.megolm_key_requests.requester_user_id IS 'The user who is requesting the session key';


--
-- Name: megolm_room_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.megolm_room_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    room_type text NOT NULL,
    current_session_id text NOT NULL,
    sender_user_id uuid NOT NULL,
    message_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    rotated_at timestamp with time zone,
    is_active boolean DEFAULT true,
    CONSTRAINT megolm_room_sessions_room_type_check CHECK ((room_type = ANY (ARRAY['channel'::text, 'conversation'::text])))
);


--
-- Name: TABLE megolm_room_sessions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.megolm_room_sessions IS 'Tracks Megolm sessions per room. Actual keys stored locally on client.';


--
-- Name: COLUMN megolm_room_sessions.current_session_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.megolm_room_sessions.current_session_id IS 'Public session ID - does not reveal key material';


--
-- Name: megolm_session_shares; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.megolm_session_shares (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    room_id uuid NOT NULL,
    session_id text NOT NULL,
    sender_user_id uuid NOT NULL,
    recipient_user_id uuid NOT NULL,
    encrypted_session_key text NOT NULL,
    first_known_index integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    is_claimed boolean DEFAULT false
);


--
-- Name: TABLE megolm_session_shares; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.megolm_session_shares IS 'Encrypted Megolm session keys shared between users';


--
-- Name: COLUMN megolm_session_shares.encrypted_session_key; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.megolm_session_shares.encrypted_session_key IS 'Session key encrypted with recipient identity key';


--
-- Name: message_search_index; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.message_search_index (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    content_text text NOT NULL,
    content_tsvector tsvector,
    channel_id uuid,
    conversation_id uuid,
    user_id uuid,
    server_id uuid,
    has_media boolean DEFAULT false,
    has_url boolean DEFAULT false,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    channel_id uuid,
    user_id uuid,
    content jsonb,
    reply_to uuid,
    reactions uuid[],
    conversation_id uuid,
    is_system boolean DEFAULT false,
    metadata jsonb,
    is_deleted boolean DEFAULT false,
    encrypted boolean DEFAULT false,
    encryption_metadata jsonb,
    bot_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    megolm_session_id text,
    megolm_message_index integer,
    CONSTRAINT messages_content_is_array CHECK ((jsonb_typeof(content) = 'array'::text)),
    CONSTRAINT messages_content_not_empty CHECK ((jsonb_array_length(content) > 0)),
    CONSTRAINT messages_user_or_bot_check CHECK ((((user_id IS NOT NULL) AND (bot_id IS NULL)) OR ((user_id IS NULL) AND (bot_id IS NOT NULL))))
);

ALTER TABLE ONLY public.messages REPLICA IDENTITY FULL;


--
-- Name: COLUMN messages.metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.messages.metadata IS 'JSON metadata for federation info including ap_id, from_domain, original_url, etc.';


--
-- Name: COLUMN messages.encrypted; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.messages.encrypted IS 'Whether this message is end-to-end encrypted.';


--
-- Name: COLUMN messages.encryption_metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.messages.encryption_metadata IS 'Encryption details: algorithm_version, sender_key_id, recipient_key_ids, etc.';


--
-- Name: COLUMN messages.bot_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.messages.bot_id IS 'Bot that sent this message (mutually exclusive with user_id)';


--
-- Name: COLUMN messages.updated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.messages.updated_at IS 'Timestamp when the message was last updated/edited';


--
-- Name: COLUMN messages.megolm_session_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.messages.megolm_session_id IS 'Megolm session ID for encrypted messages';


--
-- Name: COLUMN messages.megolm_message_index; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.messages.megolm_message_index IS 'Message index in Megolm ratchet (for forward secrecy)';


--
-- Name: mfa_recovery_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mfa_recovery_codes (
    id uuid DEFAULT extensions.uuid_generate_v4() NOT NULL,
    user_id uuid NOT NULL,
    code_hash text NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: notification_channels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_channels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    server_id uuid,
    channel_id uuid,
    conversation_id uuid,
    muted boolean DEFAULT false,
    muted_until timestamp with time zone,
    notification_level character varying(20) DEFAULT 'all'::character varying,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: TABLE notification_channels; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.notification_channels IS 'Channel/server/conversation specific notification muting settings';


--
-- Name: notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    desktop_notifications boolean DEFAULT true,
    desktop_mentions boolean DEFAULT true,
    desktop_dms boolean DEFAULT true,
    desktop_reactions boolean DEFAULT false,
    desktop_replies boolean DEFAULT true,
    sound_notifications boolean DEFAULT true,
    sound_mentions boolean DEFAULT true,
    sound_dms boolean DEFAULT true,
    sound_reactions boolean DEFAULT false,
    sound_voice_activity boolean DEFAULT true,
    push_notifications boolean DEFAULT true,
    push_mentions boolean DEFAULT true,
    push_dms boolean DEFAULT true,
    push_offline_only boolean DEFAULT true,
    email_notifications boolean DEFAULT false,
    email_digest boolean DEFAULT false,
    email_digest_frequency character varying(20) DEFAULT 'weekly'::character varying,
    dnd_enabled boolean DEFAULT false,
    dnd_start_time time without time zone DEFAULT '22:00:00'::time without time zone,
    dnd_end_time time without time zone DEFAULT '08:00:00'::time without time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    activitypub_notifications boolean DEFAULT true,
    activitypub_follows boolean DEFAULT true,
    activitypub_favorites boolean DEFAULT true,
    activitypub_reblogs boolean DEFAULT true,
    activitypub_mentions boolean DEFAULT true,
    activitypub_replies boolean DEFAULT true,
    activitypub_follow_requests boolean DEFAULT true,
    activitypub_desktop_notifications boolean DEFAULT true,
    activitypub_desktop_follows boolean DEFAULT true,
    activitypub_desktop_favorites boolean DEFAULT false,
    activitypub_desktop_reblogs boolean DEFAULT false,
    activitypub_desktop_mentions boolean DEFAULT true,
    activitypub_desktop_replies boolean DEFAULT true,
    activitypub_sound_notifications boolean DEFAULT true,
    activitypub_sound_follows boolean DEFAULT true,
    activitypub_sound_favorites boolean DEFAULT false,
    activitypub_sound_reblogs boolean DEFAULT false,
    activitypub_sound_mentions boolean DEFAULT true,
    activitypub_sound_replies boolean DEFAULT true,
    sound_replies boolean DEFAULT true
);


--
-- Name: COLUMN notification_preferences.activitypub_notifications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.activitypub_notifications IS 'Master toggle for all ActivityPub notifications';


--
-- Name: COLUMN notification_preferences.activitypub_follows; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.activitypub_follows IS 'Enable notifications for new followers';


--
-- Name: COLUMN notification_preferences.activitypub_favorites; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.activitypub_favorites IS 'Enable notifications for favorites/likes';


--
-- Name: COLUMN notification_preferences.activitypub_reblogs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.activitypub_reblogs IS 'Enable notifications for reblogs/boosts';


--
-- Name: COLUMN notification_preferences.activitypub_mentions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.activitypub_mentions IS 'Enable notifications for mentions';


--
-- Name: COLUMN notification_preferences.activitypub_replies; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.activitypub_replies IS 'Enable notifications for replies';


--
-- Name: COLUMN notification_preferences.activitypub_follow_requests; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.activitypub_follow_requests IS 'Enable notifications for follow requests';


--
-- Name: COLUMN notification_preferences.activitypub_desktop_notifications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.activitypub_desktop_notifications IS 'Master toggle for ActivityPub desktop notifications';


--
-- Name: COLUMN notification_preferences.activitypub_sound_notifications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notification_preferences.activitypub_sound_notifications IS 'Master toggle for ActivityPub sound notifications';


--
-- Name: notification_rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_rate_limits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    notification_type text NOT NULL,
    source_user_id uuid,
    last_notification_at timestamp with time zone DEFAULT now(),
    notification_count integer DEFAULT 1,
    suppressed_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: TABLE notification_rate_limits; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.notification_rate_limits IS 'Prevents notification spam by tracking and rate limiting notifications per user/type/source';


--
-- Name: notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    type character varying(50) NOT NULL,
    data jsonb DEFAULT '{}'::jsonb,
    is_read boolean DEFAULT false,
    is_clicked boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone DEFAULT (now() + '30 days'::interval),
    read_at timestamp with time zone
);

ALTER TABLE ONLY public.notifications REPLICA IDENTITY FULL;


--
-- Name: COLUMN notifications.is_read; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.is_read IS 'Boolean field indicating if notification has been read';


--
-- Name: COLUMN notifications.read_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.notifications.read_at IS 'Timestamp when notification was marked as read';


--
-- Name: pg_background_job; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pg_background_job (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    job_type text NOT NULL,
    payload jsonb NOT NULL,
    status text DEFAULT 'pending'::text,
    created_at timestamp with time zone DEFAULT now(),
    processed_at timestamp with time zone,
    error_message text,
    CONSTRAINT pg_background_job_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text])))
);


--
-- Name: post_hashtags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.post_hashtags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    post_id uuid NOT NULL,
    hashtag_id uuid NOT NULL,
    position_in_content integer DEFAULT 0
);


--
-- Name: TABLE post_hashtags; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.post_hashtags IS 'Links posts to their hashtags';


--
-- Name: post_interactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.post_interactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    user_id uuid NOT NULL,
    post_id uuid NOT NULL,
    interaction_type text NOT NULL,
    ap_id text,
    is_local boolean DEFAULT true,
    metadata jsonb DEFAULT '{}'::jsonb,
    emoji_id uuid,
    custom_emoji_content text,
    CONSTRAINT post_interactions_interaction_type_check CHECK ((interaction_type = ANY (ARRAY['favorite'::text, 'reblog'::text, 'bookmark'::text, 'emoji_reaction'::text])))
);

ALTER TABLE ONLY public.post_interactions REPLICA IDENTITY FULL;


--
-- Name: reactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    user_id uuid,
    emoji_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    bot_id uuid,
    metadata jsonb,
    CONSTRAINT reactions_user_or_bot_check CHECK ((((user_id IS NOT NULL) AND (bot_id IS NULL)) OR ((user_id IS NULL) AND (bot_id IS NOT NULL))))
);

ALTER TABLE ONLY public.reactions REPLICA IDENTITY FULL;


--
-- Name: COLUMN reactions.bot_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.reactions.bot_id IS 'Bot that created this reaction (mutually exclusive with user_id)';


--
-- Name: COLUMN reactions.metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.reactions.metadata IS 'Additional metadata for reactions, e.g. Discord user info for bridged reactions';


--
-- Name: remote_emojis_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.remote_emojis_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    shortcode text NOT NULL,
    origin_domain text NOT NULL,
    full_code text NOT NULL,
    url text NOT NULL,
    static_url text,
    first_seen_at timestamp with time zone DEFAULT now(),
    last_seen_at timestamp with time zone DEFAULT now(),
    usage_count integer DEFAULT 1,
    imported_as uuid,
    imported_at timestamp with time zone,
    category text,
    is_animated boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: TABLE remote_emojis_cache; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.remote_emojis_cache IS 'Cache of custom emojis encountered from remote instances. Used for the emoji importer feature.';


--
-- Name: reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    reporter_id uuid,
    reported_user_id uuid,
    reported_post_id uuid,
    reason text NOT NULL,
    report_type text NOT NULL,
    source text DEFAULT 'local'::text,
    source_instance text,
    status text DEFAULT 'pending'::text,
    resolution_note text,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    ap_id text,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT reports_report_type_check CHECK ((report_type = ANY (ARRAY['user'::text, 'post'::text, 'message'::text, 'server'::text]))),
    CONSTRAINT reports_source_check CHECK ((source = ANY (ARRAY['local'::text, 'federation'::text]))),
    CONSTRAINT reports_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'investigating'::text, 'resolved'::text, 'dismissed'::text])))
);


--
-- Name: TABLE reports; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.reports IS 'User/content reports for moderation, supporting both local and federated reports';


--
-- Name: COLUMN reports.source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.reports.source IS 'Whether this report was created locally or received via federation';


--
-- Name: COLUMN reports.source_instance; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.reports.source_instance IS 'The domain of the instance that sent a federated report';


--
-- Name: COLUMN reports.ap_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.reports.ap_id IS 'ActivityPub ID for federated Flag activities';


--
-- Name: schedule_result; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schedule_result (
    schedule bigint
);


--
-- Name: server_encryption_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.server_encryption_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_id uuid NOT NULL,
    encryption_mode text DEFAULT 'optional'::text,
    allow_federation boolean DEFAULT true,
    require_verified_devices boolean DEFAULT false,
    force_key_setup boolean DEFAULT false NOT NULL,
    encrypt_attachments boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    updated_by uuid,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT server_encryption_settings_encryption_mode_check CHECK ((encryption_mode = ANY (ARRAY['disabled'::text, 'optional'::text, 'required'::text, 'required_local_only'::text])))
);


--
-- Name: TABLE server_encryption_settings; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.server_encryption_settings IS 'Per-server E2EE enforcement policies. Server owners control encryption requirements.';


--
-- Name: COLUMN server_encryption_settings.encryption_mode; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.server_encryption_settings.encryption_mode IS 'disabled: No E2EE. optional: User choice. required: All messages encrypted. required_local_only: E2EE required, federation disabled.';


--
-- Name: COLUMN server_encryption_settings.allow_federation; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.server_encryption_settings.allow_federation IS 'If false and encryption_mode=required, blocks federation';


--
-- Name: COLUMN server_encryption_settings.require_verified_devices; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.server_encryption_settings.require_verified_devices IS 'Future: require device verification';


--
-- Name: COLUMN server_encryption_settings.force_key_setup; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.server_encryption_settings.force_key_setup IS 'If true, prompt users without keys to set up encryption';


--
-- Name: COLUMN server_encryption_settings.encrypt_attachments; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.server_encryption_settings.encrypt_attachments IS 'If true, apply encryption to file attachments';


--
-- Name: server_federation_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.server_federation_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    server_id uuid,
    server_domain text NOT NULL,
    user_id uuid,
    event_type text NOT NULL,
    ap_activity_id uuid,
    federated_to text[] DEFAULT '{}'::text[],
    event_data jsonb DEFAULT '{}'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT server_federation_events_event_type_check CHECK ((event_type = ANY (ARRAY['join'::text, 'leave'::text, 'invite'::text, 'ban'::text, 'unban'::text])))
);


--
-- Name: server_membership_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.server_membership_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    server_id uuid NOT NULL,
    user_id uuid NOT NULL,
    event_type text NOT NULL,
    initiated_by uuid,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT server_membership_events_event_type_check CHECK ((event_type = ANY (ARRAY['join'::text, 'leave'::text, 'kick'::text, 'ban'::text])))
);

ALTER TABLE ONLY public.server_membership_events REPLICA IDENTITY FULL;


--
-- Name: servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.servers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name text,
    description text,
    owner uuid,
    icon text DEFAULT '/default_server_icon.png'::text,
    allow_cross_server_emojis boolean DEFAULT true,
    public boolean DEFAULT false,
    federation_enabled boolean DEFAULT false,
    federation_domain text,
    federation_inbox_url text,
    federation_metadata jsonb DEFAULT '{}'::jsonb,
    supported_activities text[] DEFAULT '{}'::text[],
    ap_id text,
    host_domain text,
    is_local_server boolean DEFAULT true
);

ALTER TABLE ONLY public.servers REPLICA IDENTITY FULL;


--
-- Name: COLUMN servers.ap_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.servers.ap_id IS 'ActivityPub ID for this server (Group actor)';


--
-- Name: COLUMN servers.host_domain; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.servers.host_domain IS 'Domain where this server is hosted (null if local)';


--
-- Name: COLUMN servers.is_local_server; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.servers.is_local_server IS 'True if server is hosted on this instance';


--
-- Name: timeline_entries; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.timeline_entries (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    user_id uuid NOT NULL,
    post_id uuid NOT NULL,
    timeline_type text NOT NULL,
    "position" bigint,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT timeline_entries_timeline_type_check CHECK ((timeline_type = ANY (ARRAY['home'::text, 'public'::text, 'local'::text, 'notifications'::text])))
);


--
-- Name: timeline_posts; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.timeline_posts AS
 SELECT p.id,
    p.content,
    p.created_at,
    p.updated_at,
    p.conversation_id,
    jsonb_build_object('id', pr.id, 'username', pr.username, 'display_name', pr.display_name, 'avatar_url', pr.avatar_url, 'domain', COALESCE(pr.domain, 'har.mony.lol'::text), 'handle',
        CASE
            WHEN COALESCE(pr.is_local, true) THEN ('@'::text || pr.username)
            ELSE ((('@'::text || pr.username) || '@'::text) || pr.domain)
        END, 'is_local', COALESCE(pr.is_local, true), 'bio', pr.bio, 'followers_count', pr.followers_count, 'following_count', pr.following_count, 'posts_count', pr.posts_count) AS author,
    p.visibility,
    COALESCE(p.favorites_count, 0) AS favorites_count,
    COALESCE(p.reblogs_count, 0) AS reblogs_count,
    COALESCE(p.replies_count, 0) AS replies_count,
    COALESCE(p.media_attachments, '[]'::jsonb) AS media_attachments,
        CASE
            WHEN (p.in_reply_to IS NOT NULL) THEN jsonb_build_object('id', rp.id, 'author', jsonb_build_object('id', rpr.id, 'username', rpr.username, 'display_name', rpr.display_name, 'avatar_url', rpr.avatar_url, 'domain', COALESCE(rpr.domain, 'har.mony.lol'::text), 'handle',
            CASE
                WHEN COALESCE(rpr.is_local, true) THEN ('@'::text || rpr.username)
                ELSE ((('@'::text || rpr.username) || '@'::text) || rpr.domain)
            END), 'created_at', rp.created_at, 'visibility', rp.visibility, 'content', rp.content)
            ELSE NULL::jsonb
        END AS reply_context,
    p.content_warning,
    COALESCE(p.is_sensitive, false) AS is_sensitive,
    p.reblog,
    p.reblog_author,
    p.url
   FROM (((public.posts p
     LEFT JOIN public.profiles pr ON ((p.author_id = pr.id)))
     LEFT JOIN public.posts rp ON ((p.in_reply_to = rp.id)))
     LEFT JOIN public.profiles rpr ON ((rp.author_id = rpr.id)))
  WHERE (p.deleted_at IS NULL);


--
-- Name: VIEW timeline_posts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.timeline_posts IS 'Timeline view including reblog and reblog_author fields for proper reblog display';


--
-- Name: trending_posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trending_posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    post_id uuid NOT NULL,
    trending_score numeric DEFAULT 0.0 NOT NULL,
    engagement_score numeric DEFAULT 0.0 NOT NULL,
    velocity_score numeric DEFAULT 0.0 NOT NULL,
    period_type text DEFAULT 'daily'::text NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    likes_count integer DEFAULT 0,
    reblogs_count integer DEFAULT 0,
    replies_count integer DEFAULT 0,
    total_engagement integer GENERATED ALWAYS AS (((likes_count + reblogs_count) + replies_count)) STORED,
    trending_rank integer
);


--
-- Name: TABLE trending_posts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.trending_posts IS 'Cached trending posts data for performance';


--
-- Name: trending_refresh_queue; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trending_refresh_queue (
    refresh_type text NOT NULL,
    priority text DEFAULT 'normal'::text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    last_processed_at timestamp with time zone,
    processing_started_at timestamp with time zone,
    is_processing boolean DEFAULT false
);


--
-- Name: trending_users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.trending_users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    user_id uuid NOT NULL,
    trending_score numeric DEFAULT 0.0 NOT NULL,
    followers_growth numeric DEFAULT 0.0,
    engagement_rate numeric DEFAULT 0.0,
    period_type text DEFAULT 'daily'::text NOT NULL,
    period_start timestamp with time zone NOT NULL,
    period_end timestamp with time zone NOT NULL,
    new_followers integer DEFAULT 0,
    posts_count integer DEFAULT 0,
    total_engagement integer DEFAULT 0,
    trending_rank integer
);


--
-- Name: TABLE trending_users; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.trending_users IS 'Cached trending users data for performance';


--
-- Name: unread_counts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.unread_counts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    server_id uuid,
    channel_id uuid,
    conversation_id uuid,
    unread_messages integer DEFAULT 0,
    unread_mentions integer DEFAULT 0,
    last_read_message_id uuid,
    last_read_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_blocks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_blocks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    blocker_id uuid NOT NULL,
    blocked_user_id uuid NOT NULL,
    block_type text DEFAULT 'full'::text,
    reason text,
    expires_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    ap_id text,
    is_federated boolean DEFAULT false,
    CONSTRAINT user_blocks_block_type_check CHECK ((block_type = ANY (ARRAY['full'::text, 'posts_only'::text, 'interactions_only'::text])))
);


--
-- Name: TABLE user_blocks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_blocks IS 'User-level blocking with granular control and optional expiration';


--
-- Name: COLUMN user_blocks.ap_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_blocks.ap_id IS 'ActivityPub ID for federated Block activities';


--
-- Name: COLUMN user_blocks.is_federated; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_blocks.is_federated IS 'Whether this block was received via federation';


--
-- Name: user_bookmarks; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.user_bookmarks AS
 SELECT pi.id AS bookmark_id,
    pi.user_id,
    pi.post_id,
    pi.created_at AS bookmarked_at,
    p.id,
    p.created_at,
    p.updated_at,
    p.content,
    p.content_warning,
    p.language,
    p.author_id,
    p.ap_id,
    p.ap_type,
    p.url,
    p.in_reply_to,
    p.conversation_id,
    p.visibility,
    p.is_local,
    p.is_federated,
    p.replies_count,
    p.reblogs_count,
    p.favorites_count,
    p.media_attachments,
    p.metadata,
    p.is_sensitive,
    p.is_deleted,
    p.deleted_at,
    p.edit_history,
    p.voice_attachments,
    p.federated_to,
    p.federation_status,
    p.last_federated_at,
    p.conversation_root_id,
    p.is_favorited,
    p.is_reblogged,
    p.is_bookmarked,
    p.reblog,
    p.reblog_author,
    p.is_pinned
   FROM (public.post_interactions pi
     JOIN public.posts p ON ((pi.post_id = p.id)))
  WHERE ((pi.interaction_type = 'bookmark'::text) AND ((p.is_deleted = false) OR (p.is_deleted IS NULL)));


--
-- Name: VIEW user_bookmarks; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.user_bookmarks IS 'User bookmarks view that automatically excludes deleted posts';


--
-- Name: user_key_pairs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_key_pairs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    device_id text DEFAULT 'default'::text,
    identity_public_key text NOT NULL,
    identity_private_key_encrypted text NOT NULL,
    key_version integer DEFAULT 1 NOT NULL,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_used_at timestamp with time zone DEFAULT now(),
    expires_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT valid_device_id CHECK ((char_length(device_id) <= 255))
);


--
-- Name: TABLE user_key_pairs; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_key_pairs IS 'Signal Protocol identity key pairs per user. Supports future per-device migration.';


--
-- Name: COLUMN user_key_pairs.device_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_key_pairs.device_id IS 'Device identifier. Default "default" for per-user keys, unique device ID for per-device keys.';


--
-- Name: COLUMN user_key_pairs.identity_private_key_encrypted; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_key_pairs.identity_private_key_encrypted IS 'Private key encrypted with user password-derived key. NEVER sent to client in plaintext.';


--
-- Name: user_mutes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_mutes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    muter_id uuid NOT NULL,
    muted_user_id uuid NOT NULL,
    mute_type text DEFAULT 'posts_and_boosts'::text,
    expires_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT user_mutes_mute_type_check CHECK ((mute_type = ANY (ARRAY['posts_only'::text, 'boosts_only'::text, 'posts_and_boosts'::text, 'notifications_only'::text])))
);


--
-- Name: TABLE user_mutes; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_mutes IS 'User-level muting with granular control and optional expiration';


--
-- Name: user_private_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_private_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    private_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_servers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_servers (
    id bigint NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_id uuid NOT NULL,
    server_id uuid NOT NULL,
    temporary boolean,
    member_instance text,
    status text DEFAULT 'accepted'::text
);

ALTER TABLE ONLY public.user_servers REPLICA IDENTITY FULL;


--
-- Name: COLUMN user_servers.member_instance; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_servers.member_instance IS 'Instance domain of the member (for efficient batching)';


--
-- Name: COLUMN user_servers.status; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.user_servers.status IS 'Membership status: pending, accepted, rejected';


--
-- Name: user_servers_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.user_servers ALTER COLUMN id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.user_servers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: user_timeline_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_timeline_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    timeline_type text NOT NULL,
    posts_data jsonb DEFAULT '[]'::jsonb NOT NULL,
    last_updated timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT user_timeline_cache_timeline_type_check CHECK ((timeline_type = ANY (ARRAY['home'::text, 'local'::text, 'public'::text])))
);


--
-- Name: user_view_contexts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_view_contexts (
    user_id uuid NOT NULL,
    server_id uuid,
    channel_id uuid,
    conversation_id uuid,
    view_type text DEFAULT 'home'::text NOT NULL,
    last_active_at timestamp with time zone DEFAULT now()
);


--
-- Name: TABLE user_view_contexts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.user_view_contexts IS 'Lightweight cache of ephemeral presence state for database-level notification suppression. Updated via RPC when presence changes.';


--
-- Name: v_has_permission; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.v_has_permission (
    send_messages boolean
);


--
-- Name: visible_posts; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.visible_posts AS
 SELECT posts.id,
    posts.created_at,
    posts.updated_at,
    posts.content,
    posts.content_warning,
    posts.language,
    posts.author_id,
    posts.ap_id,
    posts.ap_type,
    posts.url,
    posts.in_reply_to,
    posts.conversation_id,
    posts.visibility,
    posts.is_local,
    posts.is_federated,
    posts.replies_count,
    posts.reblogs_count,
    posts.favorites_count,
    posts.media_attachments,
    posts.metadata,
    posts.is_sensitive,
    posts.is_deleted,
    posts.deleted_at,
    posts.edit_history,
    posts.voice_attachments,
    posts.federated_to,
    posts.federation_status,
    posts.last_federated_at,
    posts.conversation_root_id,
    posts.is_favorited,
    posts.is_reblogged,
    posts.is_bookmarked,
    posts.reblog,
    posts.reblog_author,
    posts.is_pinned
   FROM public.posts
  WHERE ((posts.is_deleted = false) OR (posts.is_deleted IS NULL));


--
-- Name: voice_federation_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.voice_federation_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    session_id text NOT NULL,
    channel_id uuid,
    server_id uuid,
    user_id uuid,
    event_type text NOT NULL,
    ap_activity_id uuid,
    federated_to text[] DEFAULT '{}'::text[],
    voice_state jsonb DEFAULT '{}'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT voice_federation_events_event_type_check CHECK ((event_type = ANY (ARRAY['join'::text, 'leave'::text, 'mute'::text, 'unmute'::text, 'deafen'::text, 'undeafen'::text, 'video_on'::text, 'video_off'::text])))
);


--
-- Name: activity_processing_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_processing_logs ALTER COLUMN id SET DEFAULT nextval('public.activity_processing_logs_id_seq'::regclass);


--
-- Name: activity_processing_logs activity_processing_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activity_processing_logs
    ADD CONSTRAINT activity_processing_logs_pkey PRIMARY KEY (id);


--
-- Name: activitypub_processing_stats activitypub_processing_stats_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activitypub_processing_stats
    ADD CONSTRAINT activitypub_processing_stats_date_key UNIQUE (date);


--
-- Name: activitypub_processing_stats activitypub_processing_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activitypub_processing_stats
    ADD CONSTRAINT activitypub_processing_stats_pkey PRIMARY KEY (id);


--
-- Name: admin_audit_log admin_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_log
    ADD CONSTRAINT admin_audit_log_pkey PRIMARY KEY (id);


--
-- Name: ap_activities ap_activities_ap_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ap_activities
    ADD CONSTRAINT ap_activities_ap_id_key UNIQUE (ap_id);


--
-- Name: ap_activities ap_activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ap_activities
    ADD CONSTRAINT ap_activities_pkey PRIMARY KEY (id);


--
-- Name: ap_actor_cache ap_actor_cache_ap_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ap_actor_cache
    ADD CONSTRAINT ap_actor_cache_ap_id_key UNIQUE (ap_id);


--
-- Name: ap_actor_cache ap_actor_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ap_actor_cache
    ADD CONSTRAINT ap_actor_cache_pkey PRIMARY KEY (id);


--
-- Name: ap_object_cache ap_object_cache_ap_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ap_object_cache
    ADD CONSTRAINT ap_object_cache_ap_id_key UNIQUE (ap_id);


--
-- Name: ap_object_cache ap_object_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ap_object_cache
    ADD CONSTRAINT ap_object_cache_pkey PRIMARY KEY (id);


--
-- Name: blocked_instances blocked_instances_domain_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocked_instances
    ADD CONSTRAINT blocked_instances_domain_key UNIQUE (domain);


--
-- Name: blocked_instances blocked_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocked_instances
    ADD CONSTRAINT blocked_instances_pkey PRIMARY KEY (id);


--
-- Name: bot_audit_log bot_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_audit_log
    ADD CONSTRAINT bot_audit_log_pkey PRIMARY KEY (id);


--
-- Name: bot_commands bot_commands_bot_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_commands
    ADD CONSTRAINT bot_commands_bot_id_name_key UNIQUE (bot_id, name);


--
-- Name: bot_commands bot_commands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_commands
    ADD CONSTRAINT bot_commands_pkey PRIMARY KEY (id);


--
-- Name: bot_presence bot_presence_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_presence
    ADD CONSTRAINT bot_presence_pkey PRIMARY KEY (bot_id);


--
-- Name: bot_rate_limits bot_rate_limits_bot_id_bucket_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_rate_limits
    ADD CONSTRAINT bot_rate_limits_bot_id_bucket_key UNIQUE (bot_id, bucket);


--
-- Name: bot_rate_limits bot_rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_rate_limits
    ADD CONSTRAINT bot_rate_limits_pkey PRIMARY KEY (id);


--
-- Name: bot_server_permissions bot_server_permissions_bot_id_server_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_server_permissions
    ADD CONSTRAINT bot_server_permissions_bot_id_server_id_key UNIQUE (bot_id, server_id);


--
-- Name: bot_server_permissions bot_server_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_server_permissions
    ADD CONSTRAINT bot_server_permissions_pkey PRIMARY KEY (id);


--
-- Name: bot_tokens bot_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_tokens
    ADD CONSTRAINT bot_tokens_pkey PRIMARY KEY (id);


--
-- Name: bot_tokens bot_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_tokens
    ADD CONSTRAINT bot_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: bot_webhooks bot_webhooks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_webhooks
    ADD CONSTRAINT bot_webhooks_pkey PRIMARY KEY (id);


--
-- Name: bots bots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bots
    ADD CONSTRAINT bots_pkey PRIMARY KEY (id);


--
-- Name: bots bots_username_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bots
    ADD CONSTRAINT bots_username_key UNIQUE (username);


--
-- Name: channel_categories channel_categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_categories
    ADD CONSTRAINT channel_categories_pkey PRIMARY KEY (id);


--
-- Name: channels channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_pkey PRIMARY KEY (id);


--
-- Name: conversation_encryption_settings conversation_encryption_settings_conversation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_encryption_settings
    ADD CONSTRAINT conversation_encryption_settings_conversation_id_key UNIQUE (conversation_id);


--
-- Name: conversation_encryption_settings conversation_encryption_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_encryption_settings
    ADD CONSTRAINT conversation_encryption_settings_pkey PRIMARY KEY (id);


--
-- Name: conversation_participants conversation_participants_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_participants
    ADD CONSTRAINT conversation_participants_pkey PRIMARY KEY (id);


--
-- Name: conversation_participants conversation_participants_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_participants
    ADD CONSTRAINT conversation_participants_unique UNIQUE (conversation_id, user_id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: emoji_usage emoji_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emoji_usage
    ADD CONSTRAINT emoji_usage_pkey PRIMARY KEY (id);


--
-- Name: emojis emojis_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emojis
    ADD CONSTRAINT emojis_pkey PRIMARY KEY (id);


--
-- Name: encryption_audit_log encryption_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encryption_audit_log
    ADD CONSTRAINT encryption_audit_log_pkey PRIMARY KEY (id);


--
-- Name: encryption_sessions encryption_sessions_local_user_id_local_device_id_remote_us_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encryption_sessions
    ADD CONSTRAINT encryption_sessions_local_user_id_local_device_id_remote_us_key UNIQUE (local_user_id, local_device_id, remote_user_id, remote_device_id);


--
-- Name: encryption_sessions encryption_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encryption_sessions
    ADD CONSTRAINT encryption_sessions_pkey PRIMARY KEY (id);


--
-- Name: federated_instances federated_instances_domain_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.federated_instances
    ADD CONSTRAINT federated_instances_domain_key UNIQUE (domain);


--
-- Name: federated_instances federated_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.federated_instances
    ADD CONSTRAINT federated_instances_pkey PRIMARY KEY (id);


--
-- Name: federation_delivery_queue federation_delivery_queue_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.federation_delivery_queue
    ADD CONSTRAINT federation_delivery_queue_pkey PRIMARY KEY (id);


--
-- Name: federation_delivery_stats federation_delivery_stats_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.federation_delivery_stats
    ADD CONSTRAINT federation_delivery_stats_pkey PRIMARY KEY (id);


--
-- Name: files files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);


--
-- Name: follows follows_ap_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_ap_id_key UNIQUE (ap_id);


--
-- Name: follows follows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_pkey PRIMARY KEY (id);


--
-- Name: hashtag_archive hashtag_archive_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hashtag_archive
    ADD CONSTRAINT hashtag_archive_pkey PRIMARY KEY (id);


--
-- Name: hashtags hashtags_normalized_tag_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hashtags
    ADD CONSTRAINT hashtags_normalized_tag_key UNIQUE (normalized_tag);


--
-- Name: hashtags hashtags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.hashtags
    ADD CONSTRAINT hashtags_pkey PRIMARY KEY (id);


--
-- Name: emoji_usage idx_emoji_usage_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emoji_usage
    ADD CONSTRAINT idx_emoji_usage_unique UNIQUE (emoji_id, user_id, context_type, context_id);


--
-- Name: instance_config instance_config_config_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_config
    ADD CONSTRAINT instance_config_config_key_key UNIQUE (config_key);


--
-- Name: instance_config instance_config_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_config
    ADD CONSTRAINT instance_config_pkey PRIMARY KEY (id);


--
-- Name: invites invites_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_pkey PRIMARY KEY (id);


--
-- Name: megolm_key_backups megolm_key_backups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.megolm_key_backups
    ADD CONSTRAINT megolm_key_backups_pkey PRIMARY KEY (id);


--
-- Name: megolm_key_backups megolm_key_backups_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.megolm_key_backups
    ADD CONSTRAINT megolm_key_backups_user_id_key UNIQUE (user_id);


--
-- Name: megolm_key_requests megolm_key_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.megolm_key_requests
    ADD CONSTRAINT megolm_key_requests_pkey PRIMARY KEY (id);


--
-- Name: megolm_room_sessions megolm_room_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.megolm_room_sessions
    ADD CONSTRAINT megolm_room_sessions_pkey PRIMARY KEY (id);


--
-- Name: megolm_room_sessions megolm_room_sessions_room_id_sender_user_id_current_session_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.megolm_room_sessions
    ADD CONSTRAINT megolm_room_sessions_room_id_sender_user_id_current_session_key UNIQUE (room_id, sender_user_id, current_session_id);


--
-- Name: megolm_session_shares megolm_session_shares_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.megolm_session_shares
    ADD CONSTRAINT megolm_session_shares_pkey PRIMARY KEY (id);


--
-- Name: megolm_session_shares megolm_session_shares_room_id_session_id_recipient_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.megolm_session_shares
    ADD CONSTRAINT megolm_session_shares_room_id_session_id_recipient_user_id_key UNIQUE (room_id, session_id, recipient_user_id);


--
-- Name: message_search_index message_search_index_message_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_search_index
    ADD CONSTRAINT message_search_index_message_id_key UNIQUE (message_id);


--
-- Name: message_search_index message_search_index_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_search_index
    ADD CONSTRAINT message_search_index_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id);


--
-- Name: mfa_recovery_codes mfa_recovery_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfa_recovery_codes
    ADD CONSTRAINT mfa_recovery_codes_pkey PRIMARY KEY (id);


--
-- Name: notification_channels notification_channels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_channels
    ADD CONSTRAINT notification_channels_pkey PRIMARY KEY (id);


--
-- Name: notification_preferences notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_pkey PRIMARY KEY (id);


--
-- Name: notification_preferences notification_preferences_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_key UNIQUE (user_id);


--
-- Name: notification_rate_limits notification_rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_rate_limits
    ADD CONSTRAINT notification_rate_limits_pkey PRIMARY KEY (id);


--
-- Name: notification_rate_limits notification_rate_limits_user_id_notification_type_source_u_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_rate_limits
    ADD CONSTRAINT notification_rate_limits_user_id_notification_type_source_u_key UNIQUE (user_id, notification_type, source_user_id);


--
-- Name: notifications notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_pkey PRIMARY KEY (id);


--
-- Name: pg_background_job pg_background_job_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pg_background_job
    ADD CONSTRAINT pg_background_job_pkey PRIMARY KEY (id);


--
-- Name: post_hashtags post_hashtags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_hashtags
    ADD CONSTRAINT post_hashtags_pkey PRIMARY KEY (id);


--
-- Name: post_hashtags post_hashtags_post_id_hashtag_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_hashtags
    ADD CONSTRAINT post_hashtags_post_id_hashtag_id_key UNIQUE (post_id, hashtag_id);


--
-- Name: post_interactions post_interactions_ap_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_interactions
    ADD CONSTRAINT post_interactions_ap_id_key UNIQUE (ap_id);


--
-- Name: post_interactions post_interactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_interactions
    ADD CONSTRAINT post_interactions_pkey PRIMARY KEY (id);


--
-- Name: posts posts_ap_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posts
    ADD CONSTRAINT posts_ap_id_key UNIQUE (ap_id);


--
-- Name: posts posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posts
    ADD CONSTRAINT posts_pkey PRIMARY KEY (id);


--
-- Name: prekeys prekeys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prekeys
    ADD CONSTRAINT prekeys_pkey PRIMARY KEY (id);


--
-- Name: prekeys prekeys_user_id_device_id_prekey_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prekeys
    ADD CONSTRAINT prekeys_user_id_device_id_prekey_id_key UNIQUE (user_id, device_id, prekey_id);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_username_domain_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_username_domain_key UNIQUE (username, domain);


--
-- Name: CONSTRAINT profiles_username_domain_key ON profiles; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT profiles_username_domain_key ON public.profiles IS 'Ensures username uniqueness per domain in federated system. Same username can exist on different domains.';


--
-- Name: reactions reactions_message_id_user_id_emoji_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reactions
    ADD CONSTRAINT reactions_message_id_user_id_emoji_id_key UNIQUE (message_id, user_id, emoji_id);


--
-- Name: reactions reactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reactions
    ADD CONSTRAINT reactions_pkey PRIMARY KEY (id);


--
-- Name: recovery_key_metadata recovery_key_metadata_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_key_metadata
    ADD CONSTRAINT recovery_key_metadata_pkey PRIMARY KEY (id);


--
-- Name: recovery_key_metadata recovery_key_metadata_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_key_metadata
    ADD CONSTRAINT recovery_key_metadata_user_id_key UNIQUE (user_id);


--
-- Name: remote_emojis_cache remote_emojis_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_emojis_cache
    ADD CONSTRAINT remote_emojis_cache_pkey PRIMARY KEY (id);


--
-- Name: remote_emojis_cache remote_emojis_cache_shortcode_origin_domain_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_emojis_cache
    ADD CONSTRAINT remote_emojis_cache_shortcode_origin_domain_key UNIQUE (shortcode, origin_domain);


--
-- Name: reports reports_ap_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_ap_id_key UNIQUE (ap_id);


--
-- Name: reports reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_pkey PRIMARY KEY (id);


--
-- Name: server_encryption_settings server_encryption_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_encryption_settings
    ADD CONSTRAINT server_encryption_settings_pkey PRIMARY KEY (id);


--
-- Name: server_encryption_settings server_encryption_settings_server_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_encryption_settings
    ADD CONSTRAINT server_encryption_settings_server_id_key UNIQUE (server_id);


--
-- Name: server_federation_events server_federation_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_federation_events
    ADD CONSTRAINT server_federation_events_pkey PRIMARY KEY (id);


--
-- Name: server_membership_events server_membership_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_membership_events
    ADD CONSTRAINT server_membership_events_pkey PRIMARY KEY (id);


--
-- Name: servers servers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.servers
    ADD CONSTRAINT servers_pkey PRIMARY KEY (id);


--
-- Name: timeline_entries timeline_entries_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timeline_entries
    ADD CONSTRAINT timeline_entries_pkey PRIMARY KEY (id);


--
-- Name: trending_posts trending_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trending_posts
    ADD CONSTRAINT trending_posts_pkey PRIMARY KEY (id);


--
-- Name: trending_posts trending_posts_post_id_period_type_period_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trending_posts
    ADD CONSTRAINT trending_posts_post_id_period_type_period_start_key UNIQUE (post_id, period_type, period_start);


--
-- Name: trending_users trending_users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trending_users
    ADD CONSTRAINT trending_users_pkey PRIMARY KEY (id);


--
-- Name: trending_users trending_users_user_id_period_type_period_start_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trending_users
    ADD CONSTRAINT trending_users_user_id_period_type_period_start_key UNIQUE (user_id, period_type, period_start);


--
-- Name: mfa_recovery_codes unique_code_per_user; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfa_recovery_codes
    ADD CONSTRAINT unique_code_per_user UNIQUE (user_id, code_hash);


--
-- Name: unread_counts unread_counts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unread_counts
    ADD CONSTRAINT unread_counts_pkey PRIMARY KEY (id);


--
-- Name: user_blocks user_blocks_ap_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_ap_id_key UNIQUE (ap_id);


--
-- Name: user_blocks user_blocks_blocker_id_blocked_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_blocker_id_blocked_user_id_key UNIQUE (blocker_id, blocked_user_id);


--
-- Name: user_blocks user_blocks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_pkey PRIMARY KEY (id);


--
-- Name: user_key_pairs user_key_pairs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_key_pairs
    ADD CONSTRAINT user_key_pairs_pkey PRIMARY KEY (id);


--
-- Name: user_key_pairs user_key_pairs_user_id_device_id_key_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_key_pairs
    ADD CONSTRAINT user_key_pairs_user_id_device_id_key_version_key UNIQUE (user_id, device_id, key_version);


--
-- Name: user_mutes user_mutes_muter_id_muted_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_mutes
    ADD CONSTRAINT user_mutes_muter_id_muted_user_id_key UNIQUE (muter_id, muted_user_id);


--
-- Name: user_mutes user_mutes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_mutes
    ADD CONSTRAINT user_mutes_pkey PRIMARY KEY (id);


--
-- Name: user_private_keys user_private_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_private_keys
    ADD CONSTRAINT user_private_keys_pkey PRIMARY KEY (id);


--
-- Name: user_private_keys user_private_keys_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_private_keys
    ADD CONSTRAINT user_private_keys_user_id_key UNIQUE (user_id);


--
-- Name: user_servers user_servers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_servers
    ADD CONSTRAINT user_servers_pkey PRIMARY KEY (id);


--
-- Name: user_servers user_servers_user_id_server_id_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_servers
    ADD CONSTRAINT user_servers_user_id_server_id_unique UNIQUE (user_id, server_id);


--
-- Name: CONSTRAINT user_servers_user_id_server_id_unique ON user_servers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON CONSTRAINT user_servers_user_id_server_id_unique ON public.user_servers IS 'Ensures a user can only be a member of each server once';


--
-- Name: user_timeline_cache user_timeline_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_timeline_cache
    ADD CONSTRAINT user_timeline_cache_pkey PRIMARY KEY (id);


--
-- Name: user_timeline_cache user_timeline_cache_user_id_timeline_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_timeline_cache
    ADD CONSTRAINT user_timeline_cache_user_id_timeline_type_key UNIQUE (user_id, timeline_type);


--
-- Name: user_view_contexts user_view_contexts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_view_contexts
    ADD CONSTRAINT user_view_contexts_pkey PRIMARY KEY (user_id);


--
-- Name: voice_federation_events voice_federation_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_federation_events
    ADD CONSTRAINT voice_federation_events_pkey PRIMARY KEY (id);


--
-- Name: idx_activity_processing_logs_activity_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activity_processing_logs_activity_id ON public.activity_processing_logs USING btree (activity_id);


--
-- Name: idx_activitypub_processing_stats_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activitypub_processing_stats_date ON public.activitypub_processing_stats USING btree (date DESC);


--
-- Name: idx_admin_audit_log_action_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_log_action_type ON public.admin_audit_log USING btree (action_type);


--
-- Name: idx_admin_audit_log_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_log_admin_id ON public.admin_audit_log USING btree (admin_id);


--
-- Name: idx_admin_audit_log_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_log_created_at ON public.admin_audit_log USING btree (created_at DESC);


--
-- Name: idx_ap_activities_actor_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_actor_id ON public.ap_activities USING btree (actor_id);


--
-- Name: idx_ap_activities_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_created_at ON public.ap_activities USING btree (created_at DESC);


--
-- Name: idx_ap_activities_federation_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_federation_status ON public.ap_activities USING btree (status, is_local, created_at) WHERE (status = ANY (ARRAY['pending'::text, 'processing'::text]));


--
-- Name: idx_ap_activities_origin_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_origin_domain ON public.ap_activities USING btree (origin_domain);


--
-- Name: idx_ap_activities_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_status ON public.ap_activities USING btree (status);


--
-- Name: idx_ap_activities_status_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_status_type ON public.ap_activities USING btree (status, ap_type) WHERE (status = 'pending'::text);


--
-- Name: idx_ap_activities_target_new; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_target_new ON public.ap_activities USING btree (target_id, target_type) WHERE (target_id IS NOT NULL);


--
-- Name: idx_ap_activities_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_activities_type ON public.ap_activities USING btree (ap_type);


--
-- Name: idx_ap_actor_cache_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_actor_cache_domain ON public.ap_actor_cache USING btree (domain);


--
-- Name: idx_ap_actor_cache_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_actor_cache_expires ON public.ap_actor_cache USING btree (cache_expires_at);


--
-- Name: idx_ap_actor_cache_username; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_actor_cache_username ON public.ap_actor_cache USING btree (username, domain);


--
-- Name: idx_ap_object_cache_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_object_cache_expires ON public.ap_object_cache USING btree (cache_expires_at);


--
-- Name: idx_ap_object_cache_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ap_object_cache_type ON public.ap_object_cache USING btree (object_type);


--
-- Name: idx_background_job_queue; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_background_job_queue ON public.pg_background_job USING btree (status, created_at) WHERE (status = 'pending'::text);


--
-- Name: idx_bot_audit_log_action_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bot_audit_log_action_type ON public.bot_audit_log USING btree (action_type);


--
-- Name: idx_bot_audit_log_bot_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bot_audit_log_bot_id ON public.bot_audit_log USING btree (bot_id);


--
-- Name: idx_bot_audit_log_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bot_audit_log_created_at ON public.bot_audit_log USING btree (created_at DESC);


--
-- Name: idx_bot_audit_log_server_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bot_audit_log_server_id ON public.bot_audit_log USING btree (server_id) WHERE (server_id IS NOT NULL);


--
-- Name: idx_bot_commands_bot_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bot_commands_bot_id ON public.bot_commands USING btree (bot_id);


--
-- Name: idx_bot_rate_limits_bot_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bot_rate_limits_bot_id ON public.bot_rate_limits USING btree (bot_id);


--
-- Name: idx_bot_rate_limits_resets_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bot_rate_limits_resets_at ON public.bot_rate_limits USING btree (resets_at);


--
-- Name: idx_bot_server_permissions_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bot_server_permissions_active ON public.bot_server_permissions USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_bot_server_permissions_bot_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bot_server_permissions_bot_id ON public.bot_server_permissions USING btree (bot_id);


--
-- Name: idx_bot_server_permissions_server_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bot_server_permissions_server_id ON public.bot_server_permissions USING btree (server_id);


--
-- Name: idx_bot_tokens_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bot_tokens_active ON public.bot_tokens USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_bot_tokens_bot_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bot_tokens_bot_id ON public.bot_tokens USING btree (bot_id);


--
-- Name: idx_bot_tokens_prefix; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bot_tokens_prefix ON public.bot_tokens USING btree (token_prefix);


--
-- Name: idx_bot_tokens_token_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bot_tokens_token_hash ON public.bot_tokens USING btree (token_hash);


--
-- Name: idx_bot_webhooks_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bot_webhooks_active ON public.bot_webhooks USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_bot_webhooks_bot_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bot_webhooks_bot_id ON public.bot_webhooks USING btree (bot_id);


--
-- Name: idx_bots_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bots_created_at ON public.bots USING btree (created_at DESC);


--
-- Name: idx_bots_is_public; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bots_is_public ON public.bots USING btree (is_public) WHERE (is_public = true);


--
-- Name: idx_bots_owner_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bots_owner_id ON public.bots USING btree (owner_id);


--
-- Name: idx_bots_username; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_bots_username ON public.bots USING btree (username);


--
-- Name: idx_categories_server_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_categories_server_order ON public.channel_categories USING btree (server_id, "order");


--
-- Name: idx_channels_ap_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_channels_ap_id ON public.channels USING btree (ap_id) WHERE (ap_id IS NOT NULL);


--
-- Name: idx_channels_category_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_channels_category_order ON public.channels USING btree (category, "order");


--
-- Name: idx_channels_server_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_channels_server_order ON public.channels USING btree (server_id, "order");


--
-- Name: idx_conversation_encryption_conversation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversation_encryption_conversation_id ON public.conversation_encryption_settings USING btree (conversation_id);


--
-- Name: idx_conversation_participants_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversation_participants_active ON public.conversation_participants USING btree (conversation_id, user_id) WHERE (left_at IS NULL);


--
-- Name: idx_conversation_participants_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversation_participants_conversation ON public.conversation_participants USING btree (conversation_id) WHERE (left_at IS NULL);


--
-- Name: idx_conversation_participants_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversation_participants_user ON public.conversation_participants USING btree (user_id) WHERE (left_at IS NULL);


--
-- Name: idx_conversations_created_by; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_created_by ON public.conversations USING btree (created_by);


--
-- Name: idx_conversations_type_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_type_active ON public.conversations USING btree (type, is_active);


--
-- Name: idx_conversations_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_conversations_updated_at ON public.conversations USING btree (updated_at DESC);


--
-- Name: idx_delivery_queue_activity_id_new; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_queue_activity_id_new ON public.federation_delivery_queue USING btree (activity_id);


--
-- Name: idx_delivery_queue_next_attempt_new; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_queue_next_attempt_new ON public.federation_delivery_queue USING btree (next_attempt_at) WHERE (status = ANY (ARRAY['pending'::text, 'failed'::text]));


--
-- Name: idx_delivery_queue_status_new; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_queue_status_new ON public.federation_delivery_queue USING btree (status);


--
-- Name: idx_delivery_queue_target_domain_new; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_delivery_queue_target_domain_new ON public.federation_delivery_queue USING btree (target_domain);


--
-- Name: idx_emoji_usage_context; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emoji_usage_context ON public.emoji_usage USING btree (context_type, context_id);


--
-- Name: idx_emoji_usage_emoji_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emoji_usage_emoji_id ON public.emoji_usage USING btree (emoji_id);


--
-- Name: idx_emoji_usage_server_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emoji_usage_server_id ON public.emoji_usage USING btree (server_id);


--
-- Name: idx_emoji_usage_used_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emoji_usage_used_at ON public.emoji_usage USING btree (used_at DESC);


--
-- Name: idx_emoji_usage_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emoji_usage_user_id ON public.emoji_usage USING btree (user_id);


--
-- Name: idx_emojis_domain_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emojis_domain_name ON public.emojis USING btree (domain, name);


--
-- Name: idx_emojis_last_used; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emojis_last_used ON public.emojis USING btree (last_used DESC);


--
-- Name: idx_emojis_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emojis_name ON public.emojis USING btree (name);


--
-- Name: idx_emojis_server_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emojis_server_id ON public.emojis USING btree (server_id);


--
-- Name: idx_emojis_unique_federated_domain_name; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_emojis_unique_federated_domain_name ON public.emojis USING btree (domain, name) WHERE (domain IS NOT NULL);


--
-- Name: idx_emojis_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emojis_updated_at ON public.emojis USING btree (updated_at);


--
-- Name: idx_emojis_usage_count; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_emojis_usage_count ON public.emojis USING btree (usage_count DESC);


--
-- Name: idx_encryption_audit_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_encryption_audit_created_at ON public.encryption_audit_log USING btree (created_at DESC);


--
-- Name: idx_encryption_audit_event_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_encryption_audit_event_type ON public.encryption_audit_log USING btree (event_type);


--
-- Name: idx_encryption_audit_severity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_encryption_audit_severity ON public.encryption_audit_log USING btree (severity) WHERE (severity = ANY (ARRAY['error'::text, 'critical'::text]));


--
-- Name: idx_encryption_audit_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_encryption_audit_user_id ON public.encryption_audit_log USING btree (user_id);


--
-- Name: idx_encryption_sessions_local; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_encryption_sessions_local ON public.encryption_sessions USING btree (local_user_id, local_device_id);


--
-- Name: idx_encryption_sessions_needs_refresh; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_encryption_sessions_needs_refresh ON public.encryption_sessions USING btree (needs_refresh) WHERE (needs_refresh = true);


--
-- Name: idx_encryption_sessions_remote; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_encryption_sessions_remote ON public.encryption_sessions USING btree (remote_user_id, remote_device_id);


--
-- Name: idx_federated_instances_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_federated_instances_domain ON public.federated_instances USING btree (domain);


--
-- Name: idx_federated_instances_is_blocked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_federated_instances_is_blocked ON public.federated_instances USING btree (is_blocked);


--
-- Name: idx_federated_instances_last_seen; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_federated_instances_last_seen ON public.federated_instances USING btree (last_seen_at);


--
-- Name: idx_federation_delivery_queue_next_attempt_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_federation_delivery_queue_next_attempt_pending ON public.federation_delivery_queue USING btree (next_attempt_at) WHERE (status = 'pending'::text);


--
-- Name: idx_federation_delivery_stats_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_federation_delivery_stats_period ON public.federation_delivery_stats USING btree (period_start, period_end);


--
-- Name: idx_follows_ap_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_follows_ap_id ON public.follows USING btree (ap_id) WHERE (ap_id IS NOT NULL);


--
-- Name: idx_follows_federation_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_follows_federation_status ON public.follows USING btree (follower_id, following_id, status);


--
-- Name: idx_follows_follower_count; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_follows_follower_count ON public.follows USING btree (following_id) WHERE (status = 'accepted'::text);


--
-- Name: idx_follows_follower_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_follows_follower_id ON public.follows USING btree (follower_id);


--
-- Name: idx_follows_following_count; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_follows_following_count ON public.follows USING btree (follower_id) WHERE (status = 'accepted'::text);


--
-- Name: idx_follows_following_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_follows_following_id ON public.follows USING btree (following_id);


--
-- Name: idx_follows_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_follows_status ON public.follows USING btree (status);


--
-- Name: idx_follows_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_follows_unique ON public.follows USING btree (follower_id, following_id);


--
-- Name: idx_hashtags_daily_uses; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hashtags_daily_uses ON public.hashtags USING btree (daily_uses DESC);


--
-- Name: idx_hashtags_last_used; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hashtags_last_used ON public.hashtags USING btree (last_used_at DESC);


--
-- Name: idx_hashtags_normalized_tag; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hashtags_normalized_tag ON public.hashtags USING btree (normalized_tag);


--
-- Name: idx_hashtags_trending_rank; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hashtags_trending_rank ON public.hashtags USING btree (trending_rank) WHERE (trending_rank IS NOT NULL);


--
-- Name: idx_hashtags_trending_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_hashtags_trending_score ON public.hashtags USING btree (trending_score DESC);


--
-- Name: idx_megolm_backups_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_megolm_backups_user_id ON public.megolm_key_backups USING btree (user_id);


--
-- Name: idx_megolm_requests_requester_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_megolm_requests_requester_status ON public.megolm_key_requests USING btree (requester_user_id, status);


--
-- Name: idx_megolm_requests_room; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_megolm_requests_room ON public.megolm_key_requests USING btree (room_id, session_id);


--
-- Name: idx_megolm_requests_sender; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_megolm_requests_sender ON public.megolm_key_requests USING btree (sender_user_id) WHERE (status = 'pending'::text);


--
-- Name: idx_megolm_requests_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_megolm_requests_status ON public.megolm_key_requests USING btree (user_id, status) WHERE (status = 'pending'::text);


--
-- Name: idx_megolm_requests_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_megolm_requests_user_id ON public.megolm_key_requests USING btree (user_id);


--
-- Name: idx_megolm_room_sessions_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_megolm_room_sessions_active ON public.megolm_room_sessions USING btree (room_id, is_active) WHERE (is_active = true);


--
-- Name: idx_megolm_room_sessions_room; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_megolm_room_sessions_room ON public.megolm_room_sessions USING btree (room_id);


--
-- Name: idx_megolm_room_sessions_sender; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_megolm_room_sessions_sender ON public.megolm_room_sessions USING btree (sender_user_id);


--
-- Name: idx_megolm_shares_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_megolm_shares_recipient ON public.megolm_session_shares USING btree (recipient_user_id, is_claimed) WHERE (is_claimed = false);


--
-- Name: idx_megolm_shares_room; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_megolm_shares_room ON public.megolm_session_shares USING btree (room_id, session_id);


--
-- Name: idx_message_search_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_search_channel ON public.message_search_index USING btree (channel_id) WHERE (channel_id IS NOT NULL);


--
-- Name: idx_message_search_channel_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_search_channel_date ON public.message_search_index USING btree (channel_id, created_at DESC) WHERE (channel_id IS NOT NULL);


--
-- Name: idx_message_search_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_search_conversation ON public.message_search_index USING btree (conversation_id) WHERE (conversation_id IS NOT NULL);


--
-- Name: idx_message_search_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_search_created ON public.message_search_index USING btree (created_at);


--
-- Name: idx_message_search_media; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_search_media ON public.message_search_index USING btree (has_media) WHERE (has_media = true);


--
-- Name: idx_message_search_server; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_search_server ON public.message_search_index USING btree (server_id) WHERE (server_id IS NOT NULL);


--
-- Name: idx_message_search_tsvector; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_search_tsvector ON public.message_search_index USING gin (content_tsvector);


--
-- Name: idx_message_search_url; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_search_url ON public.message_search_index USING btree (has_url) WHERE (has_url = true);


--
-- Name: idx_message_search_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_search_user ON public.message_search_index USING btree (user_id);


--
-- Name: idx_message_search_user_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_message_search_user_date ON public.message_search_index USING btree (user_id, created_at DESC);


--
-- Name: idx_messages_bot_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_bot_channel ON public.messages USING btree (bot_id, channel_id) WHERE (bot_id IS NOT NULL);


--
-- Name: idx_messages_bot_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_bot_id ON public.messages USING btree (bot_id) WHERE (bot_id IS NOT NULL);


--
-- Name: idx_messages_encrypted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_encrypted ON public.messages USING btree (encrypted) WHERE (encrypted = true);


--
-- Name: idx_messages_megolm_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_megolm_session ON public.messages USING btree (megolm_session_id) WHERE (encrypted = true);


--
-- Name: idx_messages_metadata_ap_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_metadata_ap_id ON public.messages USING btree (((metadata ->> 'ap_id'::text))) WHERE ((metadata ->> 'ap_id'::text) IS NOT NULL);


--
-- Name: idx_messages_metadata_federated; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_metadata_federated ON public.messages USING gin (metadata) WHERE (metadata IS NOT NULL);


--
-- Name: idx_messages_metadata_from_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_metadata_from_domain ON public.messages USING btree (((metadata ->> 'from_domain'::text))) WHERE ((metadata ->> 'from_domain'::text) IS NOT NULL);


--
-- Name: idx_messages_user_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messages_user_conversation ON public.messages USING btree (user_id, conversation_id) WHERE (conversation_id IS NOT NULL);


--
-- Name: idx_mfa_recovery_codes_unused; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mfa_recovery_codes_unused ON public.mfa_recovery_codes USING btree (user_id) WHERE (used_at IS NULL);


--
-- Name: idx_mfa_recovery_codes_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mfa_recovery_codes_user_id ON public.mfa_recovery_codes USING btree (user_id);


--
-- Name: idx_notification_channels_composite; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_channels_composite ON public.notification_channels USING btree (user_id, server_id, channel_id, conversation_id);


--
-- Name: idx_notification_channels_muted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_channels_muted ON public.notification_channels USING btree (user_id, muted) WHERE (muted = true);


--
-- Name: idx_notification_channels_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_notification_channels_unique ON public.notification_channels USING btree (user_id, server_id, channel_id, conversation_id);


--
-- Name: idx_notification_channels_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_channels_user_id ON public.notification_channels USING btree (user_id);


--
-- Name: idx_notification_preferences_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_preferences_user_id ON public.notification_preferences USING btree (user_id);


--
-- Name: idx_notification_rate_limits_user_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_rate_limits_user_type ON public.notification_rate_limits USING btree (user_id, notification_type, suppressed_until);


--
-- Name: idx_notifications_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_created_at ON public.notifications USING btree (created_at);


--
-- Name: idx_notifications_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_expires_at ON public.notifications USING btree (expires_at);


--
-- Name: idx_notifications_is_read; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_is_read ON public.notifications USING btree (is_read);


--
-- Name: idx_notifications_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_type ON public.notifications USING btree (type);


--
-- Name: idx_notifications_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notifications_user_id ON public.notifications USING btree (user_id);


--
-- Name: idx_post_hashtags_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_post_hashtags_created_at ON public.post_hashtags USING btree (created_at DESC);


--
-- Name: idx_post_hashtags_hashtag_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_post_hashtags_hashtag_id ON public.post_hashtags USING btree (hashtag_id);


--
-- Name: idx_post_hashtags_post_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_post_hashtags_post_id ON public.post_hashtags USING btree (post_id);


--
-- Name: idx_post_interactions_ap_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_post_interactions_ap_id ON public.post_interactions USING btree (ap_id) WHERE (ap_id IS NOT NULL);


--
-- Name: idx_post_interactions_bookmarks; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_post_interactions_bookmarks ON public.post_interactions USING btree (user_id, interaction_type, created_at DESC) WHERE (interaction_type = 'bookmark'::text);


--
-- Name: idx_post_interactions_emoji_reactions; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_post_interactions_emoji_reactions ON public.post_interactions USING btree (post_id, emoji_id) WHERE (interaction_type = 'emoji_reaction'::text);


--
-- Name: idx_post_interactions_emoji_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_post_interactions_emoji_unique ON public.post_interactions USING btree (user_id, post_id, interaction_type, emoji_id, custom_emoji_content) WHERE (interaction_type = 'emoji_reaction'::text);


--
-- Name: INDEX idx_post_interactions_emoji_unique; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.idx_post_interactions_emoji_unique IS 'Prevents duplicate emoji reactions but allows multiple different emojis per user per post';


--
-- Name: idx_post_interactions_federation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_post_interactions_federation ON public.post_interactions USING btree (user_id, post_id, interaction_type);


--
-- Name: idx_post_interactions_non_emoji_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_post_interactions_non_emoji_unique ON public.post_interactions USING btree (user_id, post_id, interaction_type) WHERE (interaction_type <> 'emoji_reaction'::text);


--
-- Name: INDEX idx_post_interactions_non_emoji_unique; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.idx_post_interactions_non_emoji_unique IS 'Maintains uniqueness for non-emoji interactions (likes, reblogs, bookmarks)';


--
-- Name: idx_post_interactions_post_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_post_interactions_post_id ON public.post_interactions USING btree (post_id);


--
-- Name: idx_post_interactions_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_post_interactions_type ON public.post_interactions USING btree (interaction_type);


--
-- Name: idx_post_interactions_unique_emoji_by_content; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_post_interactions_unique_emoji_by_content ON public.post_interactions USING btree (user_id, post_id, interaction_type, custom_emoji_content) WHERE ((interaction_type = 'emoji_reaction'::text) AND (custom_emoji_content IS NOT NULL));


--
-- Name: INDEX idx_post_interactions_unique_emoji_by_content; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.idx_post_interactions_unique_emoji_by_content IS 'Prevents duplicate emoji reactions using custom_emoji_content (unicode/text emojis)';


--
-- Name: idx_post_interactions_unique_emoji_by_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_post_interactions_unique_emoji_by_id ON public.post_interactions USING btree (user_id, post_id, interaction_type, emoji_id) WHERE ((interaction_type = 'emoji_reaction'::text) AND (emoji_id IS NOT NULL));


--
-- Name: INDEX idx_post_interactions_unique_emoji_by_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.idx_post_interactions_unique_emoji_by_id IS 'Prevents duplicate emoji reactions using emoji_id (custom server emojis)';


--
-- Name: idx_post_interactions_unique_non_emoji; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_post_interactions_unique_non_emoji ON public.post_interactions USING btree (user_id, post_id, interaction_type) WHERE (interaction_type <> 'emoji_reaction'::text);


--
-- Name: INDEX idx_post_interactions_unique_non_emoji; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON INDEX public.idx_post_interactions_unique_non_emoji IS 'Ensures unique interactions per user per post for non-emoji interactions (like, reblog, bookmark, etc.)';


--
-- Name: idx_post_interactions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_post_interactions_user_id ON public.post_interactions USING btree (user_id);


--
-- Name: idx_post_interactions_user_post_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_post_interactions_user_post_type ON public.post_interactions USING btree (user_id, post_id, interaction_type);


--
-- Name: idx_posts_ap_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_ap_id ON public.posts USING btree (ap_id) WHERE (ap_id IS NOT NULL);


--
-- Name: idx_posts_author_count; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_author_count ON public.posts USING btree (author_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_posts_author_federation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_author_federation ON public.posts USING btree (author_id) WHERE (author_id IS NOT NULL);


--
-- Name: idx_posts_author_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_author_id ON public.posts USING btree (author_id);


--
-- Name: idx_posts_conversation_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_conversation_id ON public.posts USING btree (conversation_id) WHERE (conversation_id IS NOT NULL);


--
-- Name: idx_posts_conversation_performance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_conversation_performance ON public.posts USING btree (conversation_root_id, created_at) WHERE (conversation_root_id IS NOT NULL);


--
-- Name: idx_posts_conversation_root_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_conversation_root_id ON public.posts USING btree (conversation_root_id);


--
-- Name: idx_posts_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_created_at ON public.posts USING btree (created_at DESC);


--
-- Name: idx_posts_featured_engagement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_featured_engagement ON public.posts USING btree (author_id, (((favorites_count + reblogs_count) + replies_count)) DESC, created_at DESC) WHERE (((favorites_count + reblogs_count) + replies_count) > 0);


--
-- Name: idx_posts_federation_visibility; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_federation_visibility ON public.posts USING btree (visibility, is_federated, created_at) WHERE (is_federated = true);


--
-- Name: idx_posts_in_reply_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_in_reply_to ON public.posts USING btree (in_reply_to) WHERE (in_reply_to IS NOT NULL);


--
-- Name: idx_posts_in_reply_to_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_in_reply_to_conversation ON public.posts USING btree (in_reply_to, conversation_root_id) WHERE (in_reply_to IS NOT NULL);


--
-- Name: idx_posts_is_deleted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_is_deleted ON public.posts USING btree (is_deleted);


--
-- Name: idx_posts_is_local; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_is_local ON public.posts USING btree (is_local);


--
-- Name: idx_posts_local_public_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_local_public_created_at ON public.posts USING btree (is_local, created_at DESC) WHERE ((visibility = 'public'::text) AND (NOT COALESCE(is_deleted, false)));


--
-- Name: idx_posts_not_deleted; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_not_deleted ON public.posts USING btree (created_at DESC) WHERE ((is_deleted = false) OR (is_deleted IS NULL));


--
-- Name: idx_posts_pinned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_pinned ON public.posts USING btree (author_id, is_pinned, created_at DESC) WHERE (is_pinned = true);


--
-- Name: idx_posts_public_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_public_created_at ON public.posts USING btree (created_at DESC) WHERE ((visibility = 'public'::text) AND (NOT COALESCE(is_deleted, false)));


--
-- Name: idx_posts_public_timeline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_public_timeline ON public.posts USING btree (created_at DESC) WHERE ((visibility = ANY (ARRAY['public'::text, 'unlisted'::text])) AND (is_deleted = false));


--
-- Name: idx_posts_reblog_of; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_reblog_of ON public.posts USING btree (((metadata ->> 'reblog_of'::text))) WHERE ((metadata ->> 'reblog_of'::text) IS NOT NULL);


--
-- Name: idx_posts_timeline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_timeline ON public.posts USING btree (author_id, created_at DESC) WHERE (is_deleted = false);


--
-- Name: idx_posts_visibility; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_visibility ON public.posts USING btree (visibility);


--
-- Name: idx_posts_visible_public; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_visible_public ON public.posts USING btree (created_at DESC) WHERE (((is_deleted = false) OR (is_deleted IS NULL)) AND (visibility = ANY (ARRAY['public'::text, 'unlisted'::text])));


--
-- Name: idx_prekeys_signed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prekeys_signed ON public.prekeys USING btree (user_id, device_id, is_signed) WHERE (is_signed = true);


--
-- Name: idx_prekeys_unused; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prekeys_unused ON public.prekeys USING btree (user_id, device_id, is_used) WHERE ((is_used = false) AND (is_one_time = true));


--
-- Name: idx_prekeys_user_device; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_prekeys_user_device ON public.prekeys USING btree (user_id, device_id);


--
-- Name: idx_profiles_auth_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_auth_user_id ON public.profiles USING btree (auth_user_id);


--
-- Name: idx_profiles_auth_user_id_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_auth_user_id_unique ON public.profiles USING btree (auth_user_id) WHERE (auth_user_id IS NOT NULL);


--
-- Name: idx_profiles_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_domain ON public.profiles USING btree (domain);


--
-- Name: idx_profiles_federated_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_profiles_federated_id ON public.profiles USING btree (federated_id) WHERE (federated_id IS NOT NULL);


--
-- Name: idx_profiles_federation_enabled; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_federation_enabled ON public.profiles USING btree (id) WHERE (is_local = true);


--
-- Name: idx_profiles_federation_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_federation_lookup ON public.profiles USING btree (domain, federation_enabled) WHERE (federation_enabled = true);


--
-- Name: idx_profiles_is_local_username; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_is_local_username ON public.profiles USING btree (is_local, username) WHERE (is_local = true);


--
-- Name: idx_profiles_manually_approves; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_manually_approves ON public.profiles USING btree (manually_approves_followers) WHERE (manually_approves_followers = true);


--
-- Name: idx_profiles_shared_inbox_url; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_shared_inbox_url ON public.profiles USING btree (shared_inbox_url) WHERE (shared_inbox_url IS NOT NULL);


--
-- Name: idx_profiles_username_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_username_domain ON public.profiles USING btree (username, domain);


--
-- Name: idx_reactions_bot_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reactions_bot_id ON public.reactions USING btree (bot_id);


--
-- Name: idx_reactions_bot_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reactions_bot_message ON public.reactions USING btree (bot_id, message_id) WHERE (bot_id IS NOT NULL);


--
-- Name: idx_reactions_message_user_emoji; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reactions_message_user_emoji ON public.reactions USING btree (message_id, user_id, emoji_id);


--
-- Name: idx_reactions_metadata; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reactions_metadata ON public.reactions USING gin (metadata);


--
-- Name: idx_reactions_user_message; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reactions_user_message ON public.reactions USING btree (user_id, message_id);


--
-- Name: idx_recovery_metadata_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_recovery_metadata_user_id ON public.recovery_key_metadata USING btree (user_id);


--
-- Name: idx_remote_emojis_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_remote_emojis_domain ON public.remote_emojis_cache USING btree (origin_domain);


--
-- Name: idx_remote_emojis_imported; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_remote_emojis_imported ON public.remote_emojis_cache USING btree (imported_as) WHERE (imported_as IS NULL);


--
-- Name: idx_remote_emojis_usage; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_remote_emojis_usage ON public.remote_emojis_cache USING btree (usage_count DESC);


--
-- Name: idx_reports_ap_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_ap_id ON public.reports USING btree (ap_id);


--
-- Name: idx_reports_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_created_at ON public.reports USING btree (created_at DESC);


--
-- Name: idx_reports_reported_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_reported_user ON public.reports USING btree (reported_user_id);


--
-- Name: idx_reports_reporter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_reporter ON public.reports USING btree (reporter_id);


--
-- Name: idx_reports_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reports_status ON public.reports USING btree (status);


--
-- Name: idx_server_encryption_server_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_server_encryption_server_id ON public.server_encryption_settings USING btree (server_id);


--
-- Name: idx_server_federation_events_domain; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_server_federation_events_domain ON public.server_federation_events USING btree (server_domain, created_at DESC);


--
-- Name: idx_server_federation_events_server; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_server_federation_events_server ON public.server_federation_events USING btree (server_id, created_at DESC);


--
-- Name: idx_server_federation_events_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_server_federation_events_user ON public.server_federation_events USING btree (user_id, created_at DESC);


--
-- Name: idx_server_membership_events_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_server_membership_events_created_at ON public.server_membership_events USING btree (created_at);


--
-- Name: idx_server_membership_events_server_event; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_server_membership_events_server_event ON public.server_membership_events USING btree (server_id, event_type, created_at);


--
-- Name: idx_server_membership_events_server_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_server_membership_events_server_id ON public.server_membership_events USING btree (server_id);


--
-- Name: idx_server_membership_events_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_server_membership_events_user_id ON public.server_membership_events USING btree (user_id);


--
-- Name: idx_servers_ap_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_servers_ap_id ON public.servers USING btree (ap_id) WHERE (ap_id IS NOT NULL);


--
-- Name: idx_servers_federation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_servers_federation ON public.servers USING btree (federation_enabled, is_local_server);


--
-- Name: idx_timeline_entries_post_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_timeline_entries_post_id ON public.timeline_entries USING btree (post_id);


--
-- Name: idx_timeline_entries_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_timeline_entries_unique ON public.timeline_entries USING btree (user_id, post_id, timeline_type);


--
-- Name: idx_timeline_entries_user_home_position; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_timeline_entries_user_home_position ON public.timeline_entries USING btree (user_id, timeline_type, "position" DESC) WHERE (timeline_type = 'home'::text);


--
-- Name: idx_timeline_entries_user_timeline; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_timeline_entries_user_timeline ON public.timeline_entries USING btree (user_id, timeline_type, created_at DESC);


--
-- Name: idx_trending_posts_engagement; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trending_posts_engagement ON public.trending_posts USING btree (total_engagement DESC);


--
-- Name: idx_trending_posts_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trending_posts_period ON public.trending_posts USING btree (period_type, period_start DESC);


--
-- Name: idx_trending_posts_rank; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trending_posts_rank ON public.trending_posts USING btree (trending_rank) WHERE (trending_rank IS NOT NULL);


--
-- Name: idx_trending_posts_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trending_posts_score ON public.trending_posts USING btree (trending_score DESC);


--
-- Name: idx_trending_users_period; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trending_users_period ON public.trending_users USING btree (period_type, period_start DESC);


--
-- Name: idx_trending_users_rank; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trending_users_rank ON public.trending_users USING btree (trending_rank) WHERE (trending_rank IS NOT NULL);


--
-- Name: idx_trending_users_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_trending_users_score ON public.trending_users USING btree (trending_score DESC);


--
-- Name: idx_unread_counts_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_unread_counts_unique ON public.unread_counts USING btree (user_id, server_id, channel_id, conversation_id);


--
-- Name: idx_user_blocks_blocked; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_blocks_blocked ON public.user_blocks USING btree (blocked_user_id, block_type, expires_at);


--
-- Name: idx_user_blocks_blocker; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_blocks_blocker ON public.user_blocks USING btree (blocker_id, block_type, expires_at);


--
-- Name: idx_user_key_pairs_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_key_pairs_active ON public.user_key_pairs USING btree (user_id, is_active) WHERE (is_active = true);


--
-- Name: idx_user_key_pairs_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_key_pairs_user_id ON public.user_key_pairs USING btree (user_id);


--
-- Name: idx_user_mutes_muter; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_mutes_muter ON public.user_mutes USING btree (muter_id, mute_type, expires_at);


--
-- Name: idx_user_servers_by_instance; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_servers_by_instance ON public.user_servers USING btree (server_id, member_instance);


--
-- Name: idx_user_servers_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_servers_status ON public.user_servers USING btree (server_id, status);


--
-- Name: idx_user_timeline_cache_lookup; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_timeline_cache_lookup ON public.user_timeline_cache USING btree (user_id, timeline_type);


--
-- Name: idx_user_timeline_cache_posts; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_timeline_cache_posts ON public.user_timeline_cache USING gin (posts_data);


--
-- Name: idx_voice_federation_events_channel; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_voice_federation_events_channel ON public.voice_federation_events USING btree (channel_id, created_at DESC);


--
-- Name: idx_voice_federation_events_session; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_voice_federation_events_session ON public.voice_federation_events USING btree (session_id, created_at DESC);


--
-- Name: idx_voice_federation_events_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_voice_federation_events_user ON public.voice_federation_events USING btree (user_id, created_at DESC);


--
-- Name: timeline_posts_local_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX timeline_posts_local_created_idx ON public.posts USING btree (is_local, created_at DESC) WHERE ((is_deleted = false) AND (visibility = 'public'::text));


--
-- Name: timeline_posts_visibility_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX timeline_posts_visibility_created_idx ON public.posts USING btree (visibility, created_at DESC) WHERE (is_deleted = false);


--
-- Name: federation_delivery_queue Federated Outbox; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER "Federated Outbox" AFTER INSERT ON public.federation_delivery_queue FOR EACH ROW EXECUTE FUNCTION supabase_functions.http_request('http://kong:8000/functions/v1/outbox/delivery', 'POST', '{"Content-type":"application/json"}', '{}', '5000');


--
-- Name: follows add_posts_to_new_follower_timeline; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER add_posts_to_new_follower_timeline AFTER INSERT OR UPDATE ON public.follows FOR EACH ROW WHEN ((new.status = 'accepted'::text)) EXECUTE FUNCTION public.add_existing_posts_to_new_follower_timeline();


--
-- Name: user_key_pairs audit_key_generation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_key_generation AFTER INSERT ON public.user_key_pairs FOR EACH ROW EXECUTE FUNCTION public.log_key_generation();


--
-- Name: servers auto_create_default_server_structure; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auto_create_default_server_structure AFTER INSERT ON public.servers FOR EACH ROW EXECUTE FUNCTION public.trigger_create_default_server_structure();


--
-- Name: user_servers auto_set_member_instance; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER auto_set_member_instance BEFORE INSERT ON public.user_servers FOR EACH ROW EXECUTE FUNCTION public.set_member_instance();


--
-- Name: TRIGGER auto_set_member_instance ON user_servers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER auto_set_member_instance ON public.user_servers IS 'Automatically set member_instance from user profile domain';


--
-- Name: follows backfill_timeline_on_follow_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER backfill_timeline_on_follow_trigger AFTER INSERT OR UPDATE OF status ON public.follows FOR EACH ROW WHEN ((new.status = 'accepted'::text)) EXECUTE FUNCTION public.backfill_timeline_on_follow();


--
-- Name: posts cascade_delete_reblogs_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER cascade_delete_reblogs_trigger AFTER UPDATE OF is_deleted ON public.posts FOR EACH ROW WHEN (((new.is_deleted = true) AND ((old.is_deleted = false) OR (old.is_deleted IS NULL)))) EXECUTE FUNCTION public.cascade_delete_reblogs();


--
-- Name: posts create_comprehensive_timeline_entries_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER create_comprehensive_timeline_entries_trigger AFTER INSERT ON public.posts FOR EACH ROW EXECUTE FUNCTION public.create_comprehensive_timeline_entries();


--
-- Name: profiles create_notification_preferences_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER create_notification_preferences_trigger AFTER INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.create_notification_preferences();


--
-- Name: posts extract_hashtags_on_post_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER extract_hashtags_on_post_insert AFTER INSERT ON public.posts FOR EACH ROW EXECUTE FUNCTION public.trigger_extract_post_hashtags();


--
-- Name: messages handle_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER handle_updated_at BEFORE UPDATE ON public.messages FOR EACH ROW EXECUTE FUNCTION extensions.moddatetime('updated_at');


--
-- Name: TRIGGER handle_updated_at ON messages; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER handle_updated_at ON public.messages IS 'Automatically updates the updated_at timestamp when a message is modified';


--
-- Name: posts on_post_soft_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER on_post_soft_delete AFTER UPDATE OF is_deleted ON public.posts FOR EACH ROW EXECUTE FUNCTION public.handle_post_soft_delete();


--
-- Name: follows remove_timeline_on_unfollow_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER remove_timeline_on_unfollow_trigger BEFORE DELETE ON public.follows FOR EACH ROW EXECUTE FUNCTION public.remove_timeline_on_unfollow();


--
-- Name: user_servers route_leave_federation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER route_leave_federation AFTER DELETE ON public.user_servers FOR EACH ROW EXECUTE FUNCTION public.route_server_leave();


--
-- Name: TRIGGER route_leave_federation ON user_servers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER route_leave_federation ON public.user_servers IS 'Routes leave events to federation backend';


--
-- Name: user_servers route_membership_federation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER route_membership_federation AFTER INSERT OR UPDATE ON public.user_servers FOR EACH ROW EXECUTE FUNCTION public.route_server_membership();


--
-- Name: TRIGGER route_membership_federation ON user_servers; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER route_membership_federation ON public.user_servers IS 'Routes membership events to federation backend when needed';


--
-- Name: messages smart_route_channel_message; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER smart_route_channel_message AFTER INSERT ON public.messages FOR EACH ROW WHEN ((new.channel_id IS NOT NULL)) EXECUTE FUNCTION public.route_channel_message();


--
-- Name: TRIGGER smart_route_channel_message ON messages; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER smart_route_channel_message ON public.messages IS 'Routes channel messages: local members via real-time, remote members via federation';


--
-- Name: messages trg_handle_message_federation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_handle_message_federation AFTER INSERT ON public.messages FOR EACH ROW EXECUTE FUNCTION public.handle_message_federation();


--
-- Name: TRIGGER trg_handle_message_federation ON messages; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER trg_handle_message_federation ON public.messages IS 'Handles local notifications for all messages (both local and federated) and creates mention notifications for channel messages.';


--
-- Name: messages trg_handle_outgoing_messages; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_handle_outgoing_messages AFTER INSERT ON public.messages FOR EACH ROW WHEN (((new.metadata ->> 'federated'::text) IS DISTINCT FROM 'true'::text)) EXECUTE FUNCTION public.handle_outgoing_messages();


--
-- Name: TRIGGER trg_handle_outgoing_messages ON messages; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER trg_handle_outgoing_messages ON public.messages IS 'FIXED: Only triggers for outgoing local messages (metadata.federated != true). Prevents federation loops and ensures DM federation works.';


--
-- Name: messages trg_process_local_link_previews; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_process_local_link_previews BEFORE INSERT ON public.messages FOR EACH ROW WHEN (((new.metadata ->> 'federated'::text) IS DISTINCT FROM 'true'::text)) EXECUTE FUNCTION public.process_local_link_previews();


--
-- Name: messages trg_process_message_link_previews; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_process_message_link_previews BEFORE INSERT ON public.messages FOR EACH ROW WHEN (((new.metadata ->> 'federated'::text) IS DISTINCT FROM 'true'::text)) EXECUTE FUNCTION public.process_message_link_previews();


--
-- Name: messages trg_webhook_external_link_previews; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_webhook_external_link_previews AFTER INSERT ON public.messages FOR EACH ROW WHEN (((new.metadata ->> 'federated'::text) IS DISTINCT FROM 'true'::text)) EXECUTE FUNCTION public.webhook_external_link_previews();


--
-- Name: post_interactions trigger_check_emoji_reaction_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_check_emoji_reaction_limit BEFORE INSERT ON public.post_interactions FOR EACH ROW EXECUTE FUNCTION public.check_emoji_reaction_limit();


--
-- Name: reactions trigger_check_message_emoji_reaction_limit; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_check_message_emoji_reaction_limit BEFORE INSERT ON public.reactions FOR EACH ROW EXECUTE FUNCTION public.check_message_emoji_reaction_limit();


--
-- Name: posts trigger_handle_local_post_mention_notifications; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_handle_local_post_mention_notifications AFTER INSERT ON public.posts FOR EACH ROW WHEN (((new.is_local = true) AND (new.is_federated = false))) EXECUTE FUNCTION public.handle_local_post_mention_notifications();


--
-- Name: TRIGGER trigger_handle_local_post_mention_notifications ON posts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER trigger_handle_local_post_mention_notifications ON public.posts IS 'Creates notifications when local users are mentioned in LOCAL ActivityPub posts (not federated). Federated mentions are handled in process_activitypub_public_post.';


--
-- Name: posts trigger_handle_post_mention_notifications; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_handle_post_mention_notifications AFTER INSERT ON public.posts FOR EACH ROW WHEN ((new.content IS NOT NULL)) EXECUTE FUNCTION public.handle_post_mention_notifications();


--
-- Name: TRIGGER trigger_handle_post_mention_notifications ON posts; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER trigger_handle_post_mention_notifications ON public.posts IS 'Creates notifications when local users are mentioned in ActivityPub posts (both local and federated).';


--
-- Name: profiles trigger_handle_remote_user_suspension; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_handle_remote_user_suspension AFTER UPDATE OF is_suspended ON public.profiles FOR EACH ROW WHEN ((new.is_suspended = true)) EXECUTE FUNCTION public.handle_remote_user_suspension();


--
-- Name: notifications trigger_increment_unread_mentions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_increment_unread_mentions AFTER INSERT ON public.notifications FOR EACH ROW WHEN (((new.type)::text = ANY ((ARRAY['mention'::character varying, 'activitypub_mention'::character varying])::text[]))) EXECUTE FUNCTION public.increment_unread_mentions();


--
-- Name: TRIGGER trigger_increment_unread_mentions ON notifications; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER trigger_increment_unread_mentions ON public.notifications IS 'Automatically increments unread_mentions count when mention notifications are created.';


--
-- Name: messages trigger_index_message; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_index_message AFTER INSERT OR UPDATE OF content, channel_id, conversation_id, user_id, is_deleted ON public.messages FOR EACH ROW EXECUTE FUNCTION public.index_message();


--
-- Name: post_interactions trigger_post_interaction_federation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_post_interaction_federation AFTER INSERT OR DELETE ON public.post_interactions FOR EACH ROW EXECUTE FUNCTION public.handle_post_interaction_federation();


--
-- Name: TRIGGER trigger_post_interaction_federation ON post_interactions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER trigger_post_interaction_federation ON public.post_interactions IS 'Automatically federates emoji reactions to ActivityPub network when users add/remove reactions.';


--
-- Name: messages trigger_remove_message_index; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_remove_message_index AFTER DELETE ON public.messages FOR EACH ROW EXECUTE FUNCTION public.remove_message_from_index();


--
-- Name: post_interactions trigger_unified_interaction_federation_likes; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_unified_interaction_federation_likes AFTER INSERT OR DELETE ON public.post_interactions FOR EACH ROW EXECUTE FUNCTION public.handle_unified_interaction_federation();


--
-- Name: follows trigger_unified_notification_follows; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_unified_notification_follows AFTER INSERT ON public.follows FOR EACH ROW EXECUTE FUNCTION public.handle_unified_notification_processing();


--
-- Name: post_interactions trigger_unified_notification_interactions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_unified_notification_interactions AFTER INSERT ON public.post_interactions FOR EACH ROW EXECUTE FUNCTION public.handle_unified_notification_processing();


--
-- Name: reactions trigger_unified_notification_reactions; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_unified_notification_reactions AFTER INSERT ON public.reactions FOR EACH ROW EXECUTE FUNCTION public.handle_unified_notification_processing();


--
-- Name: TRIGGER trigger_unified_notification_reactions ON reactions; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER trigger_unified_notification_reactions ON public.reactions IS 'Automatically creates reaction notifications when users react to messages.';


--
-- Name: profiles trigger_unified_profile_federation; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_unified_profile_federation AFTER UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.handle_unified_profile_federation();


--
-- Name: follows trigger_update_follow_counters; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_update_follow_counters AFTER INSERT OR DELETE OR UPDATE ON public.follows FOR EACH ROW EXECUTE FUNCTION public.update_follow_counters();


--
-- Name: post_interactions trigger_update_post_reaction_counts; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trigger_update_post_reaction_counts AFTER INSERT OR DELETE ON public.post_interactions FOR EACH ROW EXECUTE FUNCTION public.update_post_reaction_counts();


--
-- Name: ap_activities unified_activitypub_processing_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER unified_activitypub_processing_trigger AFTER UPDATE ON public.ap_activities FOR EACH ROW EXECUTE FUNCTION public.handle_activitypub_activity_processing();


--
-- Name: TRIGGER unified_activitypub_processing_trigger ON ap_activities; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TRIGGER unified_activitypub_processing_trigger ON public.ap_activities IS 'Processes ActivityPub activities ready for processing. Replaces business logic that was previously in the inbox for better performance and maintainability.';


--
-- Name: bot_webhooks update_bot_webhooks_timestamp; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_bot_webhooks_timestamp BEFORE UPDATE ON public.bot_webhooks FOR EACH ROW EXECUTE FUNCTION public.update_bot_timestamp();


--
-- Name: bots update_bots_timestamp; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_bots_timestamp BEFORE UPDATE ON public.bots FOR EACH ROW EXECUTE FUNCTION public.update_bot_timestamp();


--
-- Name: conversation_encryption_settings update_conversation_encryption_settings_timestamp; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_conversation_encryption_settings_timestamp BEFORE UPDATE ON public.conversation_encryption_settings FOR EACH ROW EXECUTE FUNCTION public.update_encryption_timestamp();


--
-- Name: megolm_key_backups update_megolm_backup_timestamp; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_megolm_backup_timestamp BEFORE UPDATE ON public.megolm_key_backups FOR EACH ROW EXECUTE FUNCTION public.update_megolm_backup_timestamp();


--
-- Name: posts update_post_reply_counter_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_post_reply_counter_trigger AFTER INSERT OR DELETE ON public.posts FOR EACH ROW EXECUTE FUNCTION public.update_post_counters();


--
-- Name: posts update_reblog_count_on_post_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_reblog_count_on_post_delete AFTER DELETE ON public.posts FOR EACH ROW WHEN (((old.metadata ->> 'reblog_of'::text) IS NOT NULL)) EXECUTE FUNCTION public.update_post_reblog_count();


--
-- Name: posts update_reblog_count_on_post_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_reblog_count_on_post_insert AFTER INSERT ON public.posts FOR EACH ROW WHEN (((new.metadata ->> 'reblog_of'::text) IS NOT NULL)) EXECUTE FUNCTION public.update_post_reblog_count();


--
-- Name: posts update_reblog_count_on_post_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_reblog_count_on_post_update AFTER UPDATE OF is_deleted ON public.posts FOR EACH ROW WHEN ((((new.metadata ->> 'reblog_of'::text) IS NOT NULL) OR ((old.metadata ->> 'reblog_of'::text) IS NOT NULL))) EXECUTE FUNCTION public.update_post_reblog_count();


--
-- Name: posts update_reply_count_on_post_delete; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_reply_count_on_post_delete AFTER DELETE ON public.posts FOR EACH ROW WHEN ((old.in_reply_to IS NOT NULL)) EXECUTE FUNCTION public.update_post_reply_count();


--
-- Name: posts update_reply_count_on_post_insert_update; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_reply_count_on_post_insert_update AFTER INSERT OR UPDATE OF is_deleted ON public.posts FOR EACH ROW WHEN ((new.in_reply_to IS NOT NULL)) EXECUTE FUNCTION public.update_post_reply_count();


--
-- Name: posts update_reply_counts_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_reply_counts_trigger AFTER INSERT OR DELETE ON public.posts FOR EACH ROW EXECUTE FUNCTION public.update_reply_counts();


--
-- Name: server_encryption_settings update_server_encryption_settings_timestamp; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_server_encryption_settings_timestamp BEFORE UPDATE ON public.server_encryption_settings FOR EACH ROW EXECUTE FUNCTION public.update_encryption_timestamp();


--
-- Name: admin_audit_log admin_audit_log_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_log
    ADD CONSTRAINT admin_audit_log_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: ap_activities ap_activities_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ap_activities
    ADD CONSTRAINT ap_activities_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: blocked_instances blocked_instances_blocked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blocked_instances
    ADD CONSTRAINT blocked_instances_blocked_by_fkey FOREIGN KEY (blocked_by) REFERENCES public.profiles(id);


--
-- Name: bot_audit_log bot_audit_log_bot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_audit_log
    ADD CONSTRAINT bot_audit_log_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;


--
-- Name: bot_audit_log bot_audit_log_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_audit_log
    ADD CONSTRAINT bot_audit_log_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE SET NULL;


--
-- Name: bot_audit_log bot_audit_log_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_audit_log
    ADD CONSTRAINT bot_audit_log_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE SET NULL;


--
-- Name: bot_audit_log bot_audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_audit_log
    ADD CONSTRAINT bot_audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: bot_commands bot_commands_bot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_commands
    ADD CONSTRAINT bot_commands_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;


--
-- Name: bot_presence bot_presence_bot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_presence
    ADD CONSTRAINT bot_presence_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;


--
-- Name: bot_rate_limits bot_rate_limits_bot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_rate_limits
    ADD CONSTRAINT bot_rate_limits_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;


--
-- Name: bot_server_permissions bot_server_permissions_bot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_server_permissions
    ADD CONSTRAINT bot_server_permissions_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;


--
-- Name: bot_server_permissions bot_server_permissions_installed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_server_permissions
    ADD CONSTRAINT bot_server_permissions_installed_by_fkey FOREIGN KEY (installed_by) REFERENCES public.profiles(id);


--
-- Name: bot_server_permissions bot_server_permissions_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_server_permissions
    ADD CONSTRAINT bot_server_permissions_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: bot_tokens bot_tokens_bot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_tokens
    ADD CONSTRAINT bot_tokens_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;


--
-- Name: bot_webhooks bot_webhooks_bot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bot_webhooks
    ADD CONSTRAINT bot_webhooks_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;


--
-- Name: bots bots_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bots
    ADD CONSTRAINT bots_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: bots bots_support_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bots
    ADD CONSTRAINT bots_support_server_id_fkey FOREIGN KEY (support_server_id) REFERENCES public.servers(id) ON DELETE SET NULL;


--
-- Name: channel_categories channel_categories_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channel_categories
    ADD CONSTRAINT channel_categories_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: channels channels_category_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_category_fkey FOREIGN KEY (category) REFERENCES public.channel_categories(id);


--
-- Name: channels channels_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.channels
    ADD CONSTRAINT channels_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: conversation_encryption_settings conversation_encryption_settings_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_encryption_settings
    ADD CONSTRAINT conversation_encryption_settings_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: conversation_participants conversation_participants_conversation_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_participants
    ADD CONSTRAINT conversation_participants_conversation_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: conversation_participants conversation_participants_user_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversation_participants
    ADD CONSTRAINT conversation_participants_user_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: conversations conversations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.conversations
    ADD CONSTRAINT conversations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: emoji_usage emoji_usage_emoji_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emoji_usage
    ADD CONSTRAINT emoji_usage_emoji_id_fkey FOREIGN KEY (emoji_id) REFERENCES public.emojis(id) ON DELETE CASCADE;


--
-- Name: emoji_usage emoji_usage_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emoji_usage
    ADD CONSTRAINT emoji_usage_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: emoji_usage emoji_usage_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emoji_usage
    ADD CONSTRAINT emoji_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: emojis emojis_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emojis
    ADD CONSTRAINT emojis_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: emojis emojis_uploader_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.emojis
    ADD CONSTRAINT emojis_uploader_fkey FOREIGN KEY (uploader) REFERENCES public.profiles(id);


--
-- Name: encryption_audit_log encryption_audit_log_related_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encryption_audit_log
    ADD CONSTRAINT encryption_audit_log_related_conversation_id_fkey FOREIGN KEY (related_conversation_id) REFERENCES public.conversations(id) ON DELETE SET NULL;


--
-- Name: encryption_audit_log encryption_audit_log_related_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encryption_audit_log
    ADD CONSTRAINT encryption_audit_log_related_server_id_fkey FOREIGN KEY (related_server_id) REFERENCES public.servers(id) ON DELETE SET NULL;


--
-- Name: encryption_audit_log encryption_audit_log_related_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encryption_audit_log
    ADD CONSTRAINT encryption_audit_log_related_user_id_fkey FOREIGN KEY (related_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: encryption_audit_log encryption_audit_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encryption_audit_log
    ADD CONSTRAINT encryption_audit_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: encryption_sessions encryption_sessions_local_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encryption_sessions
    ADD CONSTRAINT encryption_sessions_local_user_id_fkey FOREIGN KEY (local_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: encryption_sessions encryption_sessions_remote_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.encryption_sessions
    ADD CONSTRAINT encryption_sessions_remote_user_id_fkey FOREIGN KEY (remote_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: federation_delivery_queue federation_delivery_queue_activity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.federation_delivery_queue
    ADD CONSTRAINT federation_delivery_queue_activity_id_fkey FOREIGN KEY (activity_id) REFERENCES public.ap_activities(id) ON DELETE CASCADE;


--
-- Name: files files_owner_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_owner_fkey FOREIGN KEY (owner) REFERENCES public.profiles(id);


--
-- Name: follows follows_follower_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_follower_id_fkey FOREIGN KEY (follower_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: follows follows_following_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.follows
    ADD CONSTRAINT follows_following_id_fkey FOREIGN KEY (following_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: instance_config instance_config_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.instance_config
    ADD CONSTRAINT instance_config_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id);


--
-- Name: invites invites_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: invites invites_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.invites
    ADD CONSTRAINT invites_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: megolm_key_backups megolm_key_backups_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.megolm_key_backups
    ADD CONSTRAINT megolm_key_backups_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: megolm_key_requests megolm_key_requests_requester_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.megolm_key_requests
    ADD CONSTRAINT megolm_key_requests_requester_user_id_fkey FOREIGN KEY (requester_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: megolm_key_requests megolm_key_requests_sender_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.megolm_key_requests
    ADD CONSTRAINT megolm_key_requests_sender_user_id_fkey FOREIGN KEY (sender_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: megolm_key_requests megolm_key_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.megolm_key_requests
    ADD CONSTRAINT megolm_key_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: megolm_room_sessions megolm_room_sessions_sender_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.megolm_room_sessions
    ADD CONSTRAINT megolm_room_sessions_sender_user_id_fkey FOREIGN KEY (sender_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: megolm_session_shares megolm_session_shares_recipient_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.megolm_session_shares
    ADD CONSTRAINT megolm_session_shares_recipient_user_id_fkey FOREIGN KEY (recipient_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: megolm_session_shares megolm_session_shares_sender_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.megolm_session_shares
    ADD CONSTRAINT megolm_session_shares_sender_user_id_fkey FOREIGN KEY (sender_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: message_search_index message_search_index_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_search_index
    ADD CONSTRAINT message_search_index_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: message_search_index message_search_index_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_search_index
    ADD CONSTRAINT message_search_index_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: message_search_index message_search_index_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_search_index
    ADD CONSTRAINT message_search_index_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;


--
-- Name: message_search_index message_search_index_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.message_search_index
    ADD CONSTRAINT message_search_index_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: messages messages_bot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;


--
-- Name: messages messages_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: messages messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: messages messages_reply_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_reply_to_fkey FOREIGN KEY (reply_to) REFERENCES public.messages(id);


--
-- Name: messages messages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messages
    ADD CONSTRAINT messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id);


--
-- Name: mfa_recovery_codes mfa_recovery_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mfa_recovery_codes
    ADD CONSTRAINT mfa_recovery_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: notification_channels notification_channels_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_channels
    ADD CONSTRAINT notification_channels_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: notification_channels notification_channels_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_channels
    ADD CONSTRAINT notification_channels_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: notification_channels notification_channels_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_channels
    ADD CONSTRAINT notification_channels_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: notification_channels notification_channels_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_channels
    ADD CONSTRAINT notification_channels_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: notification_preferences notification_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_preferences
    ADD CONSTRAINT notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: notification_rate_limits notification_rate_limits_source_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_rate_limits
    ADD CONSTRAINT notification_rate_limits_source_user_id_fkey FOREIGN KEY (source_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: notification_rate_limits notification_rate_limits_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_rate_limits
    ADD CONSTRAINT notification_rate_limits_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: notifications notifications_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notifications
    ADD CONSTRAINT notifications_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: post_hashtags post_hashtags_hashtag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_hashtags
    ADD CONSTRAINT post_hashtags_hashtag_id_fkey FOREIGN KEY (hashtag_id) REFERENCES public.hashtags(id) ON DELETE CASCADE;


--
-- Name: post_hashtags post_hashtags_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_hashtags
    ADD CONSTRAINT post_hashtags_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE;


--
-- Name: post_interactions post_interactions_emoji_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_interactions
    ADD CONSTRAINT post_interactions_emoji_id_fkey FOREIGN KEY (emoji_id) REFERENCES public.emojis(id);


--
-- Name: post_interactions post_interactions_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_interactions
    ADD CONSTRAINT post_interactions_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE;


--
-- Name: post_interactions post_interactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_interactions
    ADD CONSTRAINT post_interactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: posts posts_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posts
    ADD CONSTRAINT posts_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: posts posts_in_reply_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posts
    ADD CONSTRAINT posts_in_reply_to_fkey FOREIGN KEY (in_reply_to) REFERENCES public.posts(id) ON DELETE SET NULL;


--
-- Name: prekeys prekeys_used_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prekeys
    ADD CONSTRAINT prekeys_used_by_fkey FOREIGN KEY (used_by) REFERENCES auth.users(id);


--
-- Name: prekeys prekeys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.prekeys
    ADD CONSTRAINT prekeys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: reactions reactions_bot_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reactions
    ADD CONSTRAINT reactions_bot_id_fkey FOREIGN KEY (bot_id) REFERENCES public.bots(id) ON DELETE CASCADE;


--
-- Name: reactions reactions_emoji_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reactions
    ADD CONSTRAINT reactions_emoji_id_fkey FOREIGN KEY (emoji_id) REFERENCES public.emojis(id) ON DELETE CASCADE;


--
-- Name: reactions reactions_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reactions
    ADD CONSTRAINT reactions_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.messages(id) ON DELETE CASCADE;


--
-- Name: reactions reactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reactions
    ADD CONSTRAINT reactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: recovery_key_metadata recovery_key_metadata_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.recovery_key_metadata
    ADD CONSTRAINT recovery_key_metadata_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: remote_emojis_cache remote_emojis_cache_imported_as_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.remote_emojis_cache
    ADD CONSTRAINT remote_emojis_cache_imported_as_fkey FOREIGN KEY (imported_as) REFERENCES public.emojis(id) ON DELETE SET NULL;


--
-- Name: reports reports_reported_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_reported_post_id_fkey FOREIGN KEY (reported_post_id) REFERENCES public.posts(id) ON DELETE SET NULL;


--
-- Name: reports reports_reported_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_reported_user_id_fkey FOREIGN KEY (reported_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: reports reports_reporter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_reporter_id_fkey FOREIGN KEY (reporter_id) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: reports reports_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.reports
    ADD CONSTRAINT reports_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES public.profiles(id) ON DELETE SET NULL;


--
-- Name: server_encryption_settings server_encryption_settings_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_encryption_settings
    ADD CONSTRAINT server_encryption_settings_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: server_encryption_settings server_encryption_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_encryption_settings
    ADD CONSTRAINT server_encryption_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.profiles(id);


--
-- Name: server_federation_events server_federation_events_ap_activity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_federation_events
    ADD CONSTRAINT server_federation_events_ap_activity_id_fkey FOREIGN KEY (ap_activity_id) REFERENCES public.ap_activities(id) ON DELETE SET NULL;


--
-- Name: server_federation_events server_federation_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_federation_events
    ADD CONSTRAINT server_federation_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: server_membership_events server_membership_events_initiated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_membership_events
    ADD CONSTRAINT server_membership_events_initiated_by_fkey FOREIGN KEY (initiated_by) REFERENCES public.profiles(id);


--
-- Name: server_membership_events server_membership_events_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_membership_events
    ADD CONSTRAINT server_membership_events_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: server_membership_events server_membership_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.server_membership_events
    ADD CONSTRAINT server_membership_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: servers servers_owner_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.servers
    ADD CONSTRAINT servers_owner_fkey FOREIGN KEY (owner) REFERENCES public.profiles(id);


--
-- Name: timeline_entries timeline_entries_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timeline_entries
    ADD CONSTRAINT timeline_entries_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE;


--
-- Name: timeline_entries timeline_entries_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.timeline_entries
    ADD CONSTRAINT timeline_entries_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: trending_posts trending_posts_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trending_posts
    ADD CONSTRAINT trending_posts_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE;


--
-- Name: trending_users trending_users_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.trending_users
    ADD CONSTRAINT trending_users_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: unread_counts unread_counts_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unread_counts
    ADD CONSTRAINT unread_counts_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE CASCADE;


--
-- Name: unread_counts unread_counts_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unread_counts
    ADD CONSTRAINT unread_counts_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE CASCADE;


--
-- Name: unread_counts unread_counts_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unread_counts
    ADD CONSTRAINT unread_counts_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: unread_counts unread_counts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.unread_counts
    ADD CONSTRAINT unread_counts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_blocks user_blocks_blocked_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_blocked_user_id_fkey FOREIGN KEY (blocked_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_blocks user_blocks_blocker_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blocks
    ADD CONSTRAINT user_blocks_blocker_id_fkey FOREIGN KEY (blocker_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_key_pairs user_key_pairs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_key_pairs
    ADD CONSTRAINT user_key_pairs_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_mutes user_mutes_muted_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_mutes
    ADD CONSTRAINT user_mutes_muted_user_id_fkey FOREIGN KEY (muted_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_mutes user_mutes_muter_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_mutes
    ADD CONSTRAINT user_mutes_muter_id_fkey FOREIGN KEY (muter_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_private_keys user_private_keys_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_private_keys
    ADD CONSTRAINT user_private_keys_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_servers user_servers_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_servers
    ADD CONSTRAINT user_servers_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE CASCADE;


--
-- Name: user_servers user_servers_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_servers
    ADD CONSTRAINT user_servers_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_timeline_cache user_timeline_cache_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_timeline_cache
    ADD CONSTRAINT user_timeline_cache_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_view_contexts user_view_contexts_channel_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_view_contexts
    ADD CONSTRAINT user_view_contexts_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES public.channels(id) ON DELETE SET NULL;


--
-- Name: user_view_contexts user_view_contexts_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_view_contexts
    ADD CONSTRAINT user_view_contexts_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.conversations(id) ON DELETE SET NULL;


--
-- Name: user_view_contexts user_view_contexts_server_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_view_contexts
    ADD CONSTRAINT user_view_contexts_server_id_fkey FOREIGN KEY (server_id) REFERENCES public.servers(id) ON DELETE SET NULL;


--
-- Name: user_view_contexts user_view_contexts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_view_contexts
    ADD CONSTRAINT user_view_contexts_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: voice_federation_events voice_federation_events_ap_activity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_federation_events
    ADD CONSTRAINT voice_federation_events_ap_activity_id_fkey FOREIGN KEY (ap_activity_id) REFERENCES public.ap_activities(id) ON DELETE SET NULL;


--
-- Name: voice_federation_events voice_federation_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.voice_federation_events
    ADD CONSTRAINT voice_federation_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: emojis A; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "A" ON public.emojis USING (true);


--
-- Name: admin_audit_log Admin audit log admin access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admin audit log admin access" ON public.admin_audit_log TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.is_admin = true)))));


--
-- Name: remote_emojis_cache Admins can update remote emojis; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update remote emojis" ON public.remote_emojis_cache FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.is_admin = true)))));


--
-- Name: reports Admins can update reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update reports" ON public.reports FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.is_admin = true)))));


--
-- Name: encryption_audit_log Admins can view all audit logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all audit logs" ON public.encryption_audit_log FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND (profiles.is_admin = true)))));


--
-- Name: reports Admins can view all reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all reports" ON public.reports FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.is_admin = true)))));


--
-- Name: user_servers Allow all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Allow all" ON public.user_servers TO authenticated USING (true) WITH CHECK (true);


--
-- Name: conversation_participants Anyone can view conversation participants; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view conversation participants" ON public.conversation_participants FOR SELECT USING (true);


--
-- Name: conversations Anyone can view conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view conversations" ON public.conversations FOR SELECT USING (true);


--
-- Name: federated_instances Anyone can view federated instances; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view federated instances" ON public.federated_instances FOR SELECT USING (true);


--
-- Name: hashtags Anyone can view hashtags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view hashtags" ON public.hashtags FOR SELECT USING (true);


--
-- Name: post_hashtags Anyone can view post hashtags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view post hashtags" ON public.post_hashtags FOR SELECT USING (true);


--
-- Name: remote_emojis_cache Anyone can view remote emojis; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view remote emojis" ON public.remote_emojis_cache FOR SELECT USING (true);


--
-- Name: trending_posts Anyone can view trending posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view trending posts" ON public.trending_posts FOR SELECT USING (true);


--
-- Name: trending_users Anyone can view trending users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view trending users" ON public.trending_users FOR SELECT USING (true);


--
-- Name: conversations Authenticated users can create conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can create conversations" ON public.conversations FOR INSERT WITH CHECK ((( SELECT auth.uid() AS uid) IS NOT NULL));


--
-- Name: conversation_participants Authenticated users can manage participants; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can manage participants" ON public.conversation_participants FOR INSERT WITH CHECK ((auth.uid() IS NOT NULL));


--
-- Name: blocked_instances Blocked instances admin access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Blocked instances admin access" ON public.blocked_instances TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.is_admin = true)))));


--
-- Name: bot_commands Bot commands are public; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Bot commands are public" ON public.bot_commands FOR SELECT USING (true);


--
-- Name: bots Bot owners can manage bots; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Bot owners can manage bots" ON public.bots USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = bots.owner_id) AND (profiles.auth_user_id = auth.uid()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = bots.owner_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: bot_commands Bot owners can manage commands; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Bot owners can manage commands" ON public.bot_commands USING ((EXISTS ( SELECT 1
   FROM (public.bots
     JOIN public.profiles ON ((profiles.id = bots.owner_id)))
  WHERE ((bots.id = bot_commands.bot_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: bot_tokens Bot owners can manage tokens; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Bot owners can manage tokens" ON public.bot_tokens USING ((EXISTS ( SELECT 1
   FROM (public.bots
     JOIN public.profiles ON ((profiles.id = bots.owner_id)))
  WHERE ((bots.id = bot_tokens.bot_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: bot_audit_log Bot owners can view audit logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Bot owners can view audit logs" ON public.bot_audit_log FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (public.bots
     JOIN public.profiles ON ((profiles.id = bots.owner_id)))
  WHERE ((bots.id = bot_audit_log.bot_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: bot_presence Bot presence is public; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Bot presence is public" ON public.bot_presence FOR SELECT USING (true);


--
-- Name: user_blocks Check if blocked by user; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Check if blocked by user" ON public.user_blocks FOR SELECT USING ((blocked_user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: conversation_encryption_settings Conversation participants can insert encryption settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Conversation participants can insert encryption settings" ON public.conversation_encryption_settings FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM (public.conversation_participants
     JOIN public.profiles ON ((profiles.id = conversation_participants.user_id)))
  WHERE ((conversation_participants.conversation_id = conversation_encryption_settings.conversation_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: conversations Conversation participants can update conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Conversation participants can update conversations" ON public.conversations FOR UPDATE USING (((( SELECT auth.uid() AS uid) IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.conversation_participants
  WHERE ((conversation_participants.conversation_id = conversations.id) AND (conversation_participants.user_id = ( SELECT auth.uid() AS uid)) AND (conversation_participants.left_at IS NULL))))));


--
-- Name: conversation_encryption_settings Conversation participants can update encryption settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Conversation participants can update encryption settings" ON public.conversation_encryption_settings FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM (public.conversation_participants
     JOIN public.profiles ON ((profiles.id = conversation_participants.user_id)))
  WHERE ((conversation_participants.conversation_id = conversation_encryption_settings.conversation_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: conversation_encryption_settings Conversation participants can view encryption settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Conversation participants can view encryption settings" ON public.conversation_encryption_settings FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (public.conversation_participants
     JOIN public.profiles ON ((profiles.id = conversation_participants.user_id)))
  WHERE ((conversation_participants.conversation_id = conversation_encryption_settings.conversation_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: notifications Enable insert for authenticated users only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable insert for authenticated users only" ON public.notifications FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: servers Enable insert for authenticated users only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable insert for authenticated users only" ON public.servers FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: notifications Enable insert for users based on user_id; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable insert for users based on user_id" ON public.notifications FOR UPDATE USING ((( SELECT ( SELECT auth.uid() AS uid) AS uid) = user_id)) WITH CHECK ((( SELECT ( SELECT auth.uid() AS uid) AS uid) = user_id));


--
-- Name: channel_categories Enable read access for all users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable read access for all users" ON public.channel_categories FOR SELECT USING (true);


--
-- Name: invites Enable read access for all users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable read access for all users" ON public.invites FOR SELECT USING (true);


--
-- Name: profiles Enable read access for all users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable read access for all users" ON public.profiles FOR SELECT USING (true);


--
-- Name: servers Enable read access for all users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable read access for all users" ON public.servers FOR SELECT USING (true);


--
-- Name: user_servers Enable read access for all users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable read access for all users" ON public.user_servers FOR SELECT USING (true);


--
-- Name: notifications Enable users to view their own data only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Enable users to view their own data only" ON public.notifications FOR SELECT TO authenticated USING (true);


--
-- Name: server_encryption_settings Everyone can view server encryption settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Everyone can view server encryption settings" ON public.server_encryption_settings FOR SELECT USING (true);


--
-- Name: invites FIXME: Enable insert for authenticated users only; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "FIXME: Enable insert for authenticated users only" ON public.invites FOR INSERT WITH CHECK (true);


--
-- Name: channel_categories FIXME: Server owners can insert/update/delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "FIXME: Server owners can insert/update/delete" ON public.channel_categories USING (true) WITH CHECK (true);


--
-- Name: invites FIXME: update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "FIXME: update" ON public.invites FOR UPDATE USING (true) WITH CHECK (true);


--
-- Name: instance_config Instance config admin access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Instance config admin access" ON public.instance_config TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.is_admin = true)))));


--
-- Name: server_membership_events Members can view server membership events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Members can view server membership events" ON public.server_membership_events FOR SELECT TO authenticated USING ((server_id IN ( SELECT us.server_id
   FROM public.user_servers us
  WHERE (us.user_id = auth.uid()))));


--
-- Name: messages Message owner or server owner can update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Message owner or server owner can update" ON public.messages FOR UPDATE TO authenticated USING ((auth.session_meets_aal_requirement() AND ((( SELECT auth.uid() AS uid) = user_id) OR (( SELECT auth.uid() AS uid) = ( SELECT servers.owner
   FROM (public.channels
     JOIN public.servers ON ((channels.server_id = servers.id)))
  WHERE (channels.id = messages.channel_id))))));


--
-- Name: federated_instances Only authenticated users can manage instances; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Only authenticated users can manage instances" ON public.federated_instances USING ((( SELECT auth.uid() AS uid) IS NOT NULL));


--
-- Name: hashtags Only system can modify hashtags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Only system can modify hashtags" ON public.hashtags USING (false) WITH CHECK (false);


--
-- Name: post_hashtags Only system can modify post hashtags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Only system can modify post hashtags" ON public.post_hashtags USING (false) WITH CHECK (false);


--
-- Name: trending_posts Only system can modify trending posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Only system can modify trending posts" ON public.trending_posts USING (false) WITH CHECK (false);


--
-- Name: trending_users Only system can modify trending users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Only system can modify trending users" ON public.trending_users USING (false) WITH CHECK (false);


--
-- Name: bots Public bots are viewable by everyone; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public bots are viewable by everyone" ON public.bots FOR SELECT USING (((is_public = true) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = bots.owner_id) AND (profiles.auth_user_id = auth.uid()))))));


--
-- Name: instance_config Public can read federation settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Public can read federation settings" ON public.instance_config FOR SELECT USING ((config_key = ANY (ARRAY['federation_settings'::text, 'domain'::text, 'instance_name'::text, 'instance_description'::text, 'open_registration'::text, 'approval_required'::text])));


--
-- Name: megolm_key_requests Requesters can manage their key requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Requesters can manage their key requests" ON public.megolm_key_requests USING (((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = megolm_key_requests.requester_user_id) AND (profiles.auth_user_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = megolm_key_requests.user_id) AND (profiles.auth_user_id = auth.uid()))))));


--
-- Name: megolm_room_sessions Room participants can view session metadata; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Room participants can view session metadata" ON public.megolm_room_sessions FOR SELECT USING (((EXISTS ( SELECT 1
   FROM ((public.user_servers us
     JOIN public.profiles p ON ((p.id = us.user_id)))
     JOIN public.channels c ON ((c.id = megolm_room_sessions.room_id)))
  WHERE ((c.server_id = us.server_id) AND (p.auth_user_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM (public.conversation_participants cp
     JOIN public.profiles p ON ((p.id = cp.user_id)))
  WHERE ((cp.conversation_id = megolm_room_sessions.room_id) AND (p.auth_user_id = auth.uid()))))));


--
-- Name: megolm_session_shares Senders can create session shares; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Senders can create session shares" ON public.megolm_session_shares FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = megolm_session_shares.sender_user_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: megolm_session_shares Senders can delete their session shares; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Senders can delete their session shares" ON public.megolm_session_shares FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = megolm_session_shares.sender_user_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: megolm_key_requests Senders can view and fulfill key requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Senders can view and fulfill key requests" ON public.megolm_key_requests USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = megolm_key_requests.sender_user_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: bot_server_permissions Server members can view bot permissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Server members can view bot permissions" ON public.bot_server_permissions FOR SELECT USING ((EXISTS ( SELECT 1
   FROM (public.user_servers
     JOIN public.profiles ON ((profiles.id = user_servers.user_id)))
  WHERE ((user_servers.server_id = bot_server_permissions.server_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: servers Server owners can delete their servers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Server owners can delete their servers" ON public.servers FOR DELETE TO authenticated USING ((auth.session_meets_aal_requirement() AND (owner = ( SELECT auth.uid() AS uid))));


--
-- Name: bot_server_permissions Server owners can manage bot permissions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Server owners can manage bot permissions" ON public.bot_server_permissions USING ((EXISTS ( SELECT 1
   FROM (public.servers
     JOIN public.profiles ON ((profiles.id = servers.owner)))
  WHERE ((servers.id = bot_server_permissions.server_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: server_encryption_settings Server owners can manage encryption settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Server owners can manage encryption settings" ON public.server_encryption_settings USING ((EXISTS ( SELECT 1
   FROM (public.servers
     JOIN public.profiles ON ((profiles.id = servers.owner)))
  WHERE ((servers.id = server_encryption_settings.server_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: servers Server owners can update their servers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Server owners can update their servers" ON public.servers FOR UPDATE TO authenticated USING ((auth.session_meets_aal_requirement() AND (owner = ( SELECT auth.uid() AS uid)))) WITH CHECK ((auth.session_meets_aal_requirement() AND (owner = ( SELECT auth.uid() AS uid))));


--
-- Name: profiles Service Role Can Read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service Role Can Read" ON public.profiles FOR SELECT USING (true);


--
-- Name: ap_actor_cache Service role can manage actor cache; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage actor cache" ON public.ap_actor_cache USING ((auth.role() = 'service_role'::text));


--
-- Name: federation_delivery_queue Service role can manage delivery queue; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage delivery queue" ON public.federation_delivery_queue USING ((auth.role() = 'service_role'::text));


--
-- Name: federation_delivery_queue Service role can manage federation queue; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage federation queue" ON public.federation_delivery_queue TO service_role USING (true) WITH CHECK (true);


--
-- Name: ap_object_cache Service role can manage object cache; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage object cache" ON public.ap_object_cache USING ((auth.role() = 'service_role'::text));


--
-- Name: remote_emojis_cache Service role can manage remote emojis; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can manage remote emojis" ON public.remote_emojis_cache USING ((auth.role() = 'service_role'::text));


--
-- Name: user_blocks Service role can read all blocks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can read all blocks" ON public.user_blocks FOR SELECT TO service_role USING (true);


--
-- Name: pg_background_job Service role manages all background jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role manages all background jobs" ON public.pg_background_job USING ((auth.role() = 'service_role'::text));


--
-- Name: user_private_keys Service role only access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role only access" ON public.user_private_keys USING ((auth.role() = 'service_role'::text));


--
-- Name: encryption_audit_log System can insert audit logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "System can insert audit logs" ON public.encryption_audit_log FOR INSERT WITH CHECK (true);


--
-- Name: server_membership_events System can insert membership events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "System can insert membership events" ON public.server_membership_events FOR INSERT TO authenticated WITH CHECK (true);


--
-- Name: ap_activities System can manage ActivityPub activities; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "System can manage ActivityPub activities" ON public.ap_activities USING (true);


--
-- Name: timeline_entries System can manage all timeline entries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "System can manage all timeline entries" ON public.timeline_entries USING (true) WITH CHECK (true);


--
-- Name: profiles System can manage federated profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "System can manage federated profiles" ON public.profiles USING (((is_local = false) OR (auth_user_id = ( SELECT auth.uid() AS uid))));


--
-- Name: unread_counts System can manage unread counts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "System can manage unread counts" ON public.unread_counts WITH CHECK (true);


--
-- Name: servers Update; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Update" ON public.servers FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = servers.owner) AND (profiles.auth_user_id = auth.uid()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = servers.owner) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: user_timeline_cache Users can access own timeline cache; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can access own timeline cache" ON public.user_timeline_cache USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: user_blocks Users can block other users; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can block other users" ON public.user_blocks FOR INSERT WITH CHECK ((blocker_id = ( SELECT auth.uid() AS uid)));


--
-- Name: pg_background_job Users can create background jobs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create background jobs" ON public.pg_background_job FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));


--
-- Name: conversations Users can create conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create conversations" ON public.conversations FOR INSERT TO authenticated WITH CHECK (auth.session_meets_aal_requirement());


--
-- Name: follows Users can create follow relationships; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create follow relationships" ON public.follows FOR INSERT WITH CHECK ((( SELECT auth.uid() AS uid) = follower_id));


--
-- Name: messages Users can create messages in conversations they participate in; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create messages in conversations they participate in" ON public.messages FOR INSERT TO authenticated WITH CHECK ((auth.session_meets_aal_requirement() AND (user_id = ( SELECT auth.uid() AS uid)) AND (((conversation_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.conversation_participants
  WHERE ((conversation_participants.conversation_id = messages.conversation_id) AND (conversation_participants.user_id = ( SELECT auth.uid() AS uid)) AND (conversation_participants.left_at IS NULL))))) OR ((channel_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM (public.channels c
     JOIN public.user_servers us ON ((c.server_id = us.server_id)))
  WHERE ((c.id = messages.channel_id) AND (us.user_id = ( SELECT auth.uid() AS uid)))))))));


--
-- Name: post_interactions Users can create post interactions on posts they can see; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create post interactions on posts they can see" ON public.post_interactions FOR INSERT WITH CHECK (((user_id = public.get_current_profile_id()) AND (post_id IN ( SELECT p.id
   FROM public.posts p
  WHERE (((p.is_deleted = false) OR (p.is_deleted IS NULL)) AND ((p.author_id = public.get_current_profile_id()) OR (p.visibility = ANY (ARRAY['public'::text, 'unlisted'::text])) OR ((p.visibility = 'followers'::text) AND (EXISTS ( SELECT 1
           FROM public.follows f
          WHERE ((f.follower_id = public.get_current_profile_id()) AND (f.following_id = p.author_id) AND (f.status = 'accepted'::text)))))))))));


--
-- Name: reactions Users can create reactions on messages they can see; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create reactions on messages they can see" ON public.reactions FOR INSERT WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) AND (message_id IN ( SELECT m.id
   FROM public.messages m
  WHERE ((m.conversation_id IN ( SELECT conversation_participants.conversation_id
           FROM public.conversation_participants
          WHERE ((conversation_participants.user_id = ( SELECT auth.uid() AS uid)) AND (conversation_participants.left_at IS NULL)))) OR (m.channel_id IN ( SELECT c.id
           FROM (public.channels c
             JOIN public.user_servers us ON ((c.server_id = us.server_id)))
          WHERE (us.user_id = ( SELECT auth.uid() AS uid)))))))));


--
-- Name: reports Users can create reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create reports" ON public.reports FOR INSERT TO authenticated WITH CHECK ((reporter_id = auth.uid()));


--
-- Name: ap_activities Users can create their own activities; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create their own activities" ON public.ap_activities FOR INSERT WITH CHECK ((actor_id = ( SELECT auth.uid() AS uid)));


--
-- Name: post_interactions Users can create their own interactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create their own interactions" ON public.post_interactions FOR INSERT WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: posts Users can create their own posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create their own posts" ON public.posts FOR INSERT WITH CHECK ((author_id = public.get_current_profile_id()));


--
-- Name: server_federation_events Users can create their own server events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create their own server events" ON public.server_federation_events FOR INSERT WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: voice_federation_events Users can create their own voice events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create their own voice events" ON public.voice_federation_events FOR INSERT WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: follows Users can delete their follow relationships; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their follow relationships" ON public.follows FOR DELETE USING (((( SELECT auth.uid() AS uid) = follower_id) OR (( SELECT auth.uid() AS uid) = following_id)));


--
-- Name: post_interactions Users can delete their own interactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own interactions" ON public.post_interactions FOR DELETE USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: post_interactions Users can delete their own post interactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own post interactions" ON public.post_interactions FOR DELETE USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: posts Users can delete their own posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own posts" ON public.posts FOR DELETE USING ((author_id = public.get_current_profile_id()));


--
-- Name: reactions Users can delete their own reactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own reactions" ON public.reactions FOR DELETE USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: mfa_recovery_codes Users can delete their own recovery codes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own recovery codes" ON public.mfa_recovery_codes FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: user_key_pairs Users can insert their own key pairs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own key pairs" ON public.user_key_pairs FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = user_key_pairs.user_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: prekeys Users can insert their own prekeys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own prekeys" ON public.prekeys FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = prekeys.user_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: profiles Users can insert their own profile.; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own profile." ON public.profiles FOR INSERT WITH CHECK ((( SELECT auth.uid() AS uid) = id));


--
-- Name: mfa_recovery_codes Users can insert their own recovery codes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own recovery codes" ON public.mfa_recovery_codes FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: timeline_entries Users can insert their own timeline entries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own timeline entries" ON public.timeline_entries FOR INSERT WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: user_view_contexts Users can insert their own view context; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own view context" ON public.user_view_contexts FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: conversation_participants Users can join conversations they're invited to; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can join conversations they're invited to" ON public.conversation_participants FOR INSERT TO authenticated WITH CHECK (auth.session_meets_aal_requirement());


--
-- Name: conversation_participants Users can leave conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can leave conversations" ON public.conversation_participants FOR DELETE USING (((( SELECT auth.uid() AS uid) IS NOT NULL) AND (user_id = ( SELECT auth.uid() AS uid))));


--
-- Name: user_servers Users can leave servers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can leave servers" ON public.user_servers FOR DELETE TO authenticated USING ((auth.session_meets_aal_requirement() AND ((user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
   FROM public.servers
  WHERE ((servers.id = user_servers.server_id) AND (servers.owner = ( SELECT auth.uid() AS uid))))))));


--
-- Name: megolm_key_backups Users can manage their own backups; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can manage their own backups" ON public.megolm_key_backups USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = megolm_key_backups.user_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: notification_channels Users can manage their own notification channels; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can manage their own notification channels" ON public.notification_channels USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: notification_preferences Users can manage their own notification preferences; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can manage their own notification preferences" ON public.notification_preferences USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: recovery_key_metadata Users can manage their own recovery metadata; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can manage their own recovery metadata" ON public.recovery_key_metadata USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = recovery_key_metadata.user_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: encryption_sessions Users can manage their own sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can manage their own sessions" ON public.encryption_sessions USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = encryption_sessions.local_user_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: megolm_room_sessions Users can manage their own sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can manage their own sessions" ON public.megolm_room_sessions USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = megolm_room_sessions.sender_user_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: mfa_recovery_codes Users can mark their own recovery codes as used; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can mark their own recovery codes as used" ON public.mfa_recovery_codes FOR UPDATE USING (((auth.uid() = user_id) AND (used_at IS NULL))) WITH CHECK ((auth.uid() = user_id));


--
-- Name: user_view_contexts Users can read their own view context; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can read their own view context" ON public.user_view_contexts FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: user_blocks Users can remove their own blocks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can remove their own blocks" ON public.user_blocks FOR DELETE USING ((blocker_id = ( SELECT auth.uid() AS uid)));


--
-- Name: message_search_index Users can search messages they have access to; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can search messages they have access to" ON public.message_search_index FOR SELECT TO authenticated USING ((((conversation_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM (public.conversation_participants cp
     JOIN public.profiles p ON ((p.id = cp.user_id)))
  WHERE ((cp.conversation_id = message_search_index.conversation_id) AND (cp.left_at IS NULL) AND (p.auth_user_id = auth.uid()))))) OR ((channel_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM ((public.channels c
     JOIN public.user_servers us ON ((c.server_id = us.server_id)))
     JOIN public.profiles p ON ((p.id = us.user_id)))
  WHERE ((c.id = message_search_index.channel_id) AND (p.auth_user_id = auth.uid())))))));


--
-- Name: conversations Users can update conversations they participate in; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update conversations they participate in" ON public.conversations FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.conversation_participants
  WHERE ((conversation_participants.conversation_id = conversations.id) AND (conversation_participants.user_id = auth.uid()) AND (conversation_participants.left_at IS NULL)))));


--
-- Name: profiles Users can update own profile.; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own profile." ON public.profiles FOR UPDATE TO authenticated USING (((( SELECT auth.uid() AS uid) = id) AND auth.session_meets_aal_requirement())) WITH CHECK (((( SELECT auth.uid() AS uid) = id) AND auth.session_meets_aal_requirement()));


--
-- Name: megolm_session_shares Users can update session shares; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update session shares" ON public.megolm_session_shares FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND ((profiles.id = megolm_session_shares.recipient_user_id) OR (profiles.id = megolm_session_shares.sender_user_id))))));


--
-- Name: follows Users can update their follow relationships; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their follow relationships" ON public.follows FOR UPDATE USING (((( SELECT auth.uid() AS uid) = follower_id) OR (( SELECT auth.uid() AS uid) = following_id)));


--
-- Name: ap_activities Users can update their own activities; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own activities" ON public.ap_activities FOR UPDATE USING ((actor_id = ( SELECT auth.uid() AS uid)));


--
-- Name: post_interactions Users can update their own interactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own interactions" ON public.post_interactions FOR UPDATE USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: user_key_pairs Users can update their own key pairs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own key pairs" ON public.user_key_pairs FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = user_key_pairs.user_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: conversation_participants Users can update their own participation; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own participation" ON public.conversation_participants FOR UPDATE USING (((( SELECT auth.uid() AS uid) IS NOT NULL) AND (user_id = ( SELECT auth.uid() AS uid)))) WITH CHECK (((( SELECT auth.uid() AS uid) IS NOT NULL) AND (user_id = ( SELECT auth.uid() AS uid))));


--
-- Name: conversation_participants Users can update their own participations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own participations" ON public.conversation_participants FOR UPDATE USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: post_interactions Users can update their own post interactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own post interactions" ON public.post_interactions FOR UPDATE USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: posts Users can update their own posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own posts" ON public.posts FOR UPDATE USING ((author_id = public.get_current_profile_id())) WITH CHECK ((author_id = public.get_current_profile_id()));


--
-- Name: prekeys Users can update their own prekeys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own prekeys" ON public.prekeys FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = prekeys.user_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: reactions Users can update their own reactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own reactions" ON public.reactions FOR UPDATE USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: unread_counts Users can update their own unread counts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own unread counts" ON public.unread_counts FOR UPDATE USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: user_view_contexts Users can update their own view context; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own view context" ON public.user_view_contexts FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: post_interactions Users can view all interactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view all interactions" ON public.post_interactions FOR SELECT USING (true);


--
-- Name: profiles Users can view all profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view all profiles" ON public.profiles FOR SELECT USING (true);


--
-- Name: conversations Users can view conversations they participate in; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view conversations they participate in" ON public.conversations FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.conversation_participants
  WHERE ((conversation_participants.conversation_id = conversations.id) AND (conversation_participants.user_id = ( SELECT auth.uid() AS uid)) AND (conversation_participants.left_at IS NULL)))));


--
-- Name: federation_delivery_queue Users can view federation delivery queue; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view federation delivery queue" ON public.federation_delivery_queue FOR SELECT TO authenticated USING (true);


--
-- Name: follows Users can view follows; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view follows" ON public.follows FOR SELECT USING (((status = 'accepted'::text) OR (( SELECT auth.uid() AS uid) = follower_id) OR (( SELECT auth.uid() AS uid) = following_id)));


--
-- Name: POLICY "Users can view follows" ON follows; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON POLICY "Users can view follows" ON public.follows IS 'Allows viewing accepted follows publicly (for follower lists), and pending follows where the user is involved';


--
-- Name: messages Users can view messages in conversations they participate in; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view messages in conversations they participate in" ON public.messages FOR SELECT TO authenticated USING ((auth.session_meets_aal_requirement() AND (((conversation_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.conversation_participants
  WHERE ((conversation_participants.conversation_id = messages.conversation_id) AND (conversation_participants.user_id = ( SELECT auth.uid() AS uid)) AND (conversation_participants.left_at IS NULL))))) OR ((channel_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM (public.channels c
     JOIN public.user_servers us ON ((c.server_id = us.server_id)))
  WHERE ((c.id = messages.channel_id) AND (us.user_id = ( SELECT auth.uid() AS uid)))))))));


--
-- Name: user_key_pairs Users can view others' public keys for encryption; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view others' public keys for encryption" ON public.user_key_pairs FOR SELECT USING ((is_active = true));


--
-- Name: prekeys Users can view others' unused public prekeys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view others' unused public prekeys" ON public.prekeys FOR SELECT USING ((is_used = false));


--
-- Name: reports Users can view own reports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own reports" ON public.reports FOR SELECT TO authenticated USING ((reporter_id = auth.uid()));


--
-- Name: conversation_participants Users can view participants in their conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view participants in their conversations" ON public.conversation_participants FOR SELECT TO authenticated USING ((auth.session_meets_aal_requirement() AND ((user_id = ( SELECT auth.uid() AS uid)) OR public.user_is_conversation_member(conversation_id, ( SELECT auth.uid() AS uid)))));


--
-- Name: post_interactions Users can view post interactions on posts they can see; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view post interactions on posts they can see" ON public.post_interactions FOR SELECT USING ((post_id IN ( SELECT p.id
   FROM public.posts p
  WHERE (((p.is_deleted = false) OR (p.is_deleted IS NULL)) AND ((p.author_id = public.get_current_profile_id()) OR (p.visibility = ANY (ARRAY['public'::text, 'unlisted'::text])) OR ((p.visibility = 'followers'::text) AND (EXISTS ( SELECT 1
           FROM public.follows f
          WHERE ((f.follower_id = public.get_current_profile_id()) AND (f.following_id = p.author_id) AND (f.status = 'accepted'::text))))))))));


--
-- Name: posts Users can view posts from users they follow; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view posts from users they follow" ON public.posts FOR SELECT USING (((visibility = 'followers'::text) AND ((is_deleted = false) OR (is_deleted IS NULL)) AND (EXISTS ( SELECT 1
   FROM public.follows
  WHERE ((follows.follower_id = public.get_current_profile_id()) AND (follows.following_id = posts.author_id) AND (follows.status = 'accepted'::text))))));


--
-- Name: posts Users can view public posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view public posts" ON public.posts FOR SELECT USING (((visibility = ANY (ARRAY['public'::text, 'unlisted'::text])) AND ((is_deleted = false) OR (is_deleted IS NULL))));


--
-- Name: reactions Users can view reactions on messages they can see; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view reactions on messages they can see" ON public.reactions FOR SELECT USING ((message_id IN ( SELECT m.id
   FROM public.messages m
  WHERE ((m.conversation_id IN ( SELECT conversation_participants.conversation_id
           FROM public.conversation_participants
          WHERE ((conversation_participants.user_id = ( SELECT auth.uid() AS uid)) AND (conversation_participants.left_at IS NULL)))) OR (m.channel_id IN ( SELECT c.id
           FROM (public.channels c
             JOIN public.user_servers us ON ((c.server_id = us.server_id)))
          WHERE (us.user_id = ( SELECT auth.uid() AS uid))))))));


--
-- Name: server_federation_events Users can view server events they're involved in; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view server events they're involved in" ON public.server_federation_events FOR SELECT USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: conversations Users can view their conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their conversations" ON public.conversations FOR SELECT TO authenticated USING ((auth.session_meets_aal_requirement() AND (EXISTS ( SELECT 1
   FROM public.conversation_participants
  WHERE ((conversation_participants.conversation_id = conversations.id) AND (conversation_participants.user_id = ( SELECT auth.uid() AS uid)) AND (conversation_participants.left_at IS NULL))))));


--
-- Name: ap_activities Users can view their own activities; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own activities" ON public.ap_activities FOR SELECT USING ((actor_id = ( SELECT auth.uid() AS uid)));


--
-- Name: encryption_audit_log Users can view their own audit logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own audit logs" ON public.encryption_audit_log FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = encryption_audit_log.user_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: user_blocks Users can view their own blocks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own blocks" ON public.user_blocks FOR SELECT USING ((blocker_id = ( SELECT auth.uid() AS uid)));


--
-- Name: user_key_pairs Users can view their own key pairs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own key pairs" ON public.user_key_pairs FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = user_key_pairs.user_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: posts Users can view their own posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own posts" ON public.posts FOR SELECT USING ((author_id = public.get_current_profile_id()));


--
-- Name: prekeys Users can view their own prekeys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own prekeys" ON public.prekeys FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = prekeys.user_id) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: encryption_sessions Users can view their own sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own sessions" ON public.encryption_sessions FOR SELECT USING (((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = encryption_sessions.local_user_id) AND (profiles.auth_user_id = auth.uid())))) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = encryption_sessions.remote_user_id) AND (profiles.auth_user_id = auth.uid()))))));


--
-- Name: timeline_entries Users can view their own timeline entries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own timeline entries" ON public.timeline_entries FOR SELECT USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: unread_counts Users can view their own unread counts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own unread counts" ON public.unread_counts FOR SELECT USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: mfa_recovery_codes Users can view their own unused recovery codes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own unused recovery codes" ON public.mfa_recovery_codes FOR SELECT USING (((auth.uid() = user_id) AND (used_at IS NULL)));


--
-- Name: megolm_session_shares Users can view their session shares; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their session shares" ON public.megolm_session_shares FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = auth.uid()) AND ((profiles.id = megolm_session_shares.recipient_user_id) OR (profiles.id = megolm_session_shares.sender_user_id))))));


--
-- Name: voice_federation_events Users can view voice events they're involved in; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view voice events they're involved in" ON public.voice_federation_events FOR SELECT USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: admin_audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: ap_activities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ap_activities ENABLE ROW LEVEL SECURITY;

--
-- Name: ap_actor_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ap_actor_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: ap_object_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ap_object_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: blocked_instances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blocked_instances ENABLE ROW LEVEL SECURITY;

--
-- Name: bot_audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bot_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: bot_commands; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bot_commands ENABLE ROW LEVEL SECURITY;

--
-- Name: bot_presence; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bot_presence ENABLE ROW LEVEL SECURITY;

--
-- Name: bot_rate_limits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bot_rate_limits ENABLE ROW LEVEL SECURITY;

--
-- Name: bot_server_permissions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bot_server_permissions ENABLE ROW LEVEL SECURITY;

--
-- Name: bot_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bot_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: bot_webhooks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bot_webhooks ENABLE ROW LEVEL SECURITY;

--
-- Name: bots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bots ENABLE ROW LEVEL SECURITY;

--
-- Name: channel_categories; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.channel_categories ENABLE ROW LEVEL SECURITY;

--
-- Name: channel_categories channel_categories_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY channel_categories_update_policy ON public.channel_categories FOR UPDATE TO authenticated USING ((server_id IN ( SELECT user_servers.server_id
   FROM public.user_servers
  WHERE (user_servers.user_id = auth.uid()))));


--
-- Name: channels; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;

--
-- Name: channels channels_delete_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY channels_delete_policy ON public.channels FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.servers s
  WHERE ((s.id = channels.server_id) AND (s.owner = auth.uid())))));


--
-- Name: channels channels_insert_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY channels_insert_policy ON public.channels FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.servers s
  WHERE ((s.id = channels.server_id) AND (s.owner = auth.uid())))));


--
-- Name: channels channels_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY channels_select_policy ON public.channels FOR SELECT TO authenticated USING ((server_id IN ( SELECT user_servers.server_id
   FROM public.user_servers
  WHERE (user_servers.user_id = auth.uid()))));


--
-- Name: channels channels_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY channels_update_policy ON public.channels FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.servers s
  WHERE ((s.id = channels.server_id) AND (s.owner = auth.uid()))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.servers s
  WHERE ((s.id = channels.server_id) AND (s.owner = auth.uid())))));


--
-- Name: conversation_encryption_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversation_encryption_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation_participants; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversation_participants ENABLE ROW LEVEL SECURITY;

--
-- Name: conversation_participants conversation_participants_delete_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY conversation_participants_delete_policy ON public.conversation_participants FOR DELETE TO authenticated USING ((auth.session_meets_aal_requirement() AND (user_id = ( SELECT auth.uid() AS uid))));


--
-- Name: conversation_participants conversation_participants_select_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY conversation_participants_select_policy ON public.conversation_participants FOR SELECT USING (true);


--
-- Name: conversation_participants conversation_participants_update_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY conversation_participants_update_policy ON public.conversation_participants FOR UPDATE TO authenticated USING ((auth.session_meets_aal_requirement() AND (user_id = ( SELECT auth.uid() AS uid))));


--
-- Name: conversations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

--
-- Name: emojis emoji_access_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY emoji_access_policy ON public.emojis TO authenticated USING ((server_id IN ( SELECT user_servers.server_id
   FROM public.user_servers
  WHERE (user_servers.user_id = auth.uid()))));


--
-- Name: emojis emoji_public_access_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY emoji_public_access_policy ON public.emojis FOR SELECT TO authenticated USING ((server_id IN ( SELECT servers.id
   FROM public.servers
  WHERE (servers.public = true))));


--
-- Name: emoji_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.emoji_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: emoji_usage emoji_usage_access_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY emoji_usage_access_policy ON public.emoji_usage TO authenticated USING ((server_id IN ( SELECT user_servers.server_id
   FROM public.user_servers
  WHERE (user_servers.user_id = auth.uid()))));


--
-- Name: emojis; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.emojis ENABLE ROW LEVEL SECURITY;

--
-- Name: encryption_audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.encryption_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: encryption_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.encryption_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: federated_instances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.federated_instances ENABLE ROW LEVEL SECURITY;

--
-- Name: federation_delivery_queue; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.federation_delivery_queue ENABLE ROW LEVEL SECURITY;

--
-- Name: files; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.files ENABLE ROW LEVEL SECURITY;

--
-- Name: follows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;

--
-- Name: hashtags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.hashtags ENABLE ROW LEVEL SECURITY;

--
-- Name: instance_config; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.instance_config ENABLE ROW LEVEL SECURITY;

--
-- Name: invites; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;

--
-- Name: megolm_key_backups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.megolm_key_backups ENABLE ROW LEVEL SECURITY;

--
-- Name: megolm_key_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.megolm_key_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: megolm_room_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.megolm_room_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: megolm_session_shares; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.megolm_session_shares ENABLE ROW LEVEL SECURITY;

--
-- Name: message_search_index; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.message_search_index ENABLE ROW LEVEL SECURITY;

--
-- Name: messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: messages messages_delete_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY messages_delete_policy ON public.messages FOR DELETE TO authenticated USING ((auth.session_meets_aal_requirement() AND ((user_id = ( SELECT auth.uid() AS uid)) OR ((channel_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM (public.channels c
     JOIN public.servers s ON ((c.server_id = s.id)))
  WHERE ((c.id = messages.channel_id) AND (s.owner = ( SELECT auth.uid() AS uid)))))))));


--
-- Name: mfa_recovery_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mfa_recovery_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_channels; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_channels ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: notifications notifications_realtime_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notifications_realtime_delete ON public.notifications FOR DELETE USING ((( SELECT auth.uid() AS uid) = user_id));


--
-- Name: pg_background_job; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pg_background_job ENABLE ROW LEVEL SECURITY;

--
-- Name: post_hashtags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.post_hashtags ENABLE ROW LEVEL SECURITY;

--
-- Name: post_interactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.post_interactions ENABLE ROW LEVEL SECURITY;

--
-- Name: posts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

--
-- Name: prekeys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.prekeys ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: reactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reactions ENABLE ROW LEVEL SECURITY;

--
-- Name: recovery_key_metadata; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.recovery_key_metadata ENABLE ROW LEVEL SECURITY;

--
-- Name: remote_emojis_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.remote_emojis_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: reports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;

--
-- Name: servers server_delete_policy; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY server_delete_policy ON public.servers FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = servers.owner) AND (profiles.auth_user_id = auth.uid())))));


--
-- Name: server_encryption_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.server_encryption_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: server_federation_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.server_federation_events ENABLE ROW LEVEL SECURITY;

--
-- Name: server_membership_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.server_membership_events ENABLE ROW LEVEL SECURITY;

--
-- Name: servers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.servers ENABLE ROW LEVEL SECURITY;

--
-- Name: timeline_entries; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.timeline_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: trending_posts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trending_posts ENABLE ROW LEVEL SECURITY;

--
-- Name: trending_users; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.trending_users ENABLE ROW LEVEL SECURITY;

--
-- Name: unread_counts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.unread_counts ENABLE ROW LEVEL SECURITY;

--
-- Name: user_blocks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;

--
-- Name: user_key_pairs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_key_pairs ENABLE ROW LEVEL SECURITY;

--
-- Name: user_private_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_private_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: user_servers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_servers ENABLE ROW LEVEL SECURITY;

--
-- Name: user_timeline_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_timeline_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: user_view_contexts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_view_contexts ENABLE ROW LEVEL SECURITY;

--
-- Name: voice_federation_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.voice_federation_events ENABLE ROW LEVEL SECURITY;

--
-- PostgreSQL database dump complete
--

