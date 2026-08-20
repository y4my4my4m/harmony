BEGIN;

-- =============================================================================
-- Migration: Fix is_favorited to include emoji_reaction, add reply notifications,
--            fix federated channel mentions, add favorite notification handling
-- =============================================================================

-- =============================================================================
-- 1. Fix get_enhanced_timeline_posts: include 'emoji_reaction' in is_favorited
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_enhanced_timeline_posts(p_user_id uuid, p_timeline_type text DEFAULT 'home'::text, p_limit integer DEFAULT 20, p_max_id text DEFAULT NULL::text) RETURNS TABLE(id text, created_at timestamp with time zone, updated_at timestamp with time zone, content jsonb, content_warning text, language text, author_id text, ap_id text, ap_type text, url text, reply_context jsonb, conversation_id text, visibility text, is_local boolean, is_federated boolean, replies_count integer, reblogs_count integer, favorites_count integer, media_attachments jsonb, metadata jsonb, is_sensitive boolean, is_deleted boolean, deleted_at timestamp with time zone, author jsonb, is_favorited boolean, is_reblogged boolean, is_bookmarked boolean, reblog jsonb, reblog_author jsonb)
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
        
        COALESCE(fav.user_id IS NOT NULL, false) as is_favorited,
        COALESCE(reb.user_id IS NOT NULL, false) as is_reblogged,
        COALESCE(book.user_id IS NOT NULL, false) as is_bookmarked,
        
        tp.reblog,
        tp.reblog_author
        
    FROM timeline_posts tp
    JOIN posts p ON tp.id = p.id
    LEFT JOIN post_interactions fav ON tp.id = fav.post_id 
        AND fav.user_id = p_user_id 
        AND fav.interaction_type IN ('favorite', 'emoji_reaction')
    LEFT JOIN post_interactions reb ON tp.id = reb.post_id 
        AND reb.user_id = p_user_id 
        AND reb.interaction_type = 'reblog'
    LEFT JOIN post_interactions book ON tp.id = book.post_id 
        AND book.user_id = p_user_id 
        AND book.interaction_type = 'bookmark'
    
    WHERE 
        CASE 
            WHEN p_timeline_type = 'home' THEN 
                EXISTS (
                    SELECT 1 FROM timeline_entries te 
                    WHERE te.user_id = p_user_id 
                      AND te.post_id = tp.id 
                      AND te.timeline_type = 'home'
                )
            WHEN p_timeline_type = 'local' THEN 
                tp.visibility = 'public' 
                AND (tp.author->>'is_local')::BOOLEAN = true
            WHEN p_timeline_type IN ('public', 'federated') THEN 
                tp.visibility = 'public'
            ELSE tp.visibility = 'public'
        END
        AND (p_max_id IS NULL OR tp.created_at < (
            SELECT tp2.created_at FROM timeline_posts tp2 WHERE tp2.id = p_max_id::UUID
        ))
    
    ORDER BY tp.created_at DESC
    LIMIT p_limit;
END;
$$;

-- =============================================================================
-- 2. Fix get_post_with_context: include 'emoji_reaction' in is_favorited
--    Uses camelCase keys to match client expectations
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_post_with_context(p_post_id uuid, p_user_id uuid, p_context_type text DEFAULT 'minimal'::text, p_highlight_reply uuid DEFAULT NULL::uuid, p_max_depth integer DEFAULT 10, p_include_interactions boolean DEFAULT true) RETURNS jsonb
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
      CASE 
        WHEN profiles.domain IS NOT NULL AND profiles.domain != '' THEN 
          '@' || profiles.username || '@' || profiles.domain
        ELSE 
          '@' || profiles.username
      END as author_handle,
      CASE 
        WHEN p_include_interactions THEN
          EXISTS(SELECT 1 FROM post_interactions WHERE post_id = p.id AND user_id = p_user_id AND interaction_type IN ('favorite', 'emoji_reaction'))
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

  IF v_main_post IS NULL THEN
    RETURN jsonb_build_object('error', 'Post not found');
  END IF;

  SELECT conversation_id INTO v_thread_id 
  FROM posts 
  WHERE id = p_post_id;

  IF p_context_type != 'minimal' THEN
    WITH RECURSIVE thread_root AS (
      SELECT id, in_reply_to, 0 as depth
      FROM posts 
      WHERE id = p_post_id
      UNION ALL
      SELECT p.id, p.in_reply_to, tr.depth + 1
      FROM posts p
      JOIN thread_root tr ON p.id = tr.in_reply_to
      WHERE tr.depth < 50
    )
    SELECT id INTO v_root_post_id 
    FROM thread_root 
    WHERE in_reply_to IS NULL
    ORDER BY depth DESC 
    LIMIT 1;

    IF v_root_post_id IS NULL THEN
      v_root_post_id := p_post_id;
    END IF;

    WITH RECURSIVE all_thread_posts AS (
      SELECT id, in_reply_to, author_id, created_at, 0 as depth
      FROM posts 
      WHERE id = v_root_post_id
      UNION ALL
      SELECT p.id, p.in_reply_to, p.author_id, p.created_at, atp.depth + 1
      FROM posts p
      JOIN all_thread_posts atp ON p.in_reply_to = atp.id
      WHERE atp.depth < 50
        AND p.is_deleted = false
    )
    SELECT 
      COUNT(DISTINCT id),
      COUNT(DISTINCT author_id),
      MAX(created_at)
    INTO v_total_posts, v_participant_count, v_last_activity
    FROM all_thread_posts;

    IF p_context_type IN ('thread', 'ancestors') THEN
      WITH RECURSIVE ancestors AS (
        SELECT p.*, 0 as depth
        FROM posts p
        WHERE p.id = (SELECT in_reply_to FROM posts WHERE id = p_post_id)
          AND p.is_deleted = false
        UNION ALL
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
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = a.id AND user_id = p_user_id AND interaction_type IN ('favorite', 'emoji_reaction'))
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
        ) ORDER BY a.depth DESC
      ) INTO v_ancestors
      FROM ancestors a
      JOIN profiles ON profiles.id = a.author_id;
    END IF;

    IF p_context_type IN ('thread', 'descendants') THEN
      WITH RECURSIVE descendants AS (
        SELECT p.*, 0 as depth, ARRAY[p.created_at::text, p.id::text] as sort_path
        FROM posts p
        WHERE p.in_reply_to = p_post_id
          AND p.is_deleted = false
        UNION ALL
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
              EXISTS(SELECT 1 FROM post_interactions WHERE post_id = d.id AND user_id = p_user_id AND interaction_type IN ('favorite', 'emoji_reaction'))
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
        ) ORDER BY d.sort_path
      ) INTO v_descendants
      FROM descendants d
      JOIN profiles ON profiles.id = d.author_id;
    END IF;

    WITH RECURSIVE depth_calc AS (
      SELECT id, 0 as depth
      FROM posts 
      WHERE id = v_root_post_id
      UNION ALL
      SELECT p.id, dc.depth + 1
      FROM posts p
      JOIN depth_calc dc ON p.in_reply_to = dc.id
      WHERE dc.depth < 50
        AND p.is_deleted = false
    )
    SELECT COALESCE(MAX(depth), 0) INTO v_max_depth FROM depth_calc;
  END IF;

  v_thread_info := jsonb_build_object(
    'totalPosts', COALESCE(v_total_posts, 1),
    'participantCount', COALESCE(v_participant_count, 1),
    'depth', COALESCE(v_max_depth, 0),
    'rootPostId', COALESCE(v_root_post_id, p_post_id),
    'lastActivity', COALESCE(v_last_activity, (v_main_post->>'created_at')::timestamp with time zone)
  );

  RETURN jsonb_build_object(
    'mainPost', v_main_post,
    'ancestors', COALESCE(v_ancestors, '[]'::jsonb),
    'descendants', COALESCE(v_descendants, '[]'::jsonb),
    'threadInfo', v_thread_info
  );

EXCEPTION WHEN OTHERS THEN
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

-- =============================================================================
-- 3. Fix get_conversation_context: include 'emoji_reaction' in is_favorited
-- =============================================================================
CREATE OR REPLACE FUNCTION public.get_conversation_context(in_post_id uuid, in_user_id uuid) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    conversation_root_id uuid;
    result jsonb;
BEGIN
    SELECT COALESCE(p.conversation_root_id, p.id)
    INTO conversation_root_id
    FROM posts p
    WHERE p.id = in_post_id
      AND p.deleted_at IS NULL;
    
    IF conversation_root_id IS NULL THEN
        RETURN '{}'::jsonb;
    END IF;
    
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
            AND pi_fav.interaction_type IN ('favorite', 'emoji_reaction')
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

-- =============================================================================
-- 4. Reply notification trigger: send activitypub_reply when a reply is inserted
-- =============================================================================
CREATE OR REPLACE FUNCTION public.handle_post_reply_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    parent_post RECORD;
    replier_profile RECORD;
    reply_preview TEXT;
BEGIN
    IF NEW.in_reply_to IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT p.id, p.author_id, p.content, pr.is_local
    INTO parent_post
    FROM posts p
    JOIN profiles pr ON pr.id = p.author_id
    WHERE p.id = NEW.in_reply_to;

    IF NOT FOUND OR parent_post.is_local != true THEN
        RETURN NEW;
    END IF;

    IF parent_post.author_id = NEW.author_id THEN
        RETURN NEW;
    END IF;

    SELECT id, username, display_name, avatar_url, domain, is_local
    INTO replier_profile
    FROM profiles
    WHERE id = NEW.author_id;

    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    reply_preview := extract_message_text(NEW.content);
    IF LENGTH(reply_preview) > 100 THEN
        reply_preview := LEFT(reply_preview, 100) || '...';
    END IF;
    IF reply_preview = '' OR reply_preview IS NULL THEN
        reply_preview := 'New reply';
    END IF;

    PERFORM send_notification_to_user(
        'activitypub_reply',
        parent_post.author_id,
        jsonb_build_object(
            'actor', jsonb_build_object(
                'id', replier_profile.id,
                'username', replier_profile.username,
                'display_name', replier_profile.display_name,
                'avatar_url', replier_profile.avatar_url,
                'domain', replier_profile.domain,
                'is_local', replier_profile.is_local
            ),
            'post', jsonb_build_object(
                'id', NEW.id,
                'ap_id', NEW.ap_id,
                'content_preview', reply_preview,
                'content', NEW.content
            ),
            'parent_post', jsonb_build_object(
                'id', parent_post.id,
                'content_preview', extract_message_text(parent_post.content)
            ),
            'post_id', NEW.id,
            'parent_post_id', parent_post.id,
            'timestamp', NEW.created_at
        ),
        NULL,
        NULL,
        NULL,
        NEW.author_id,
        'normal'
    );

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trigger_handle_post_reply_notifications ON public.posts;
CREATE TRIGGER trigger_handle_post_reply_notifications
    AFTER INSERT ON public.posts
    FOR EACH ROW
    WHEN (NEW.in_reply_to IS NOT NULL)
    EXECUTE FUNCTION public.handle_post_reply_notifications();

-- =============================================================================
-- 5. Fix handle_message_federation: allow federated channel mentions
-- =============================================================================
CREATE OR REPLACE FUNCTION public.handle_message_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_federation_type TEXT;
    v_sender_profile profiles%ROWTYPE;
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
    v_federation_type := determine_message_federation_type(NEW.id);

    SELECT * INTO v_sender_profile FROM profiles WHERE id = NEW.user_id;

    content_preview := extract_message_text(NEW.content);
    content_preview := TRIM(content_preview);
    IF LENGTH(content_preview) > 100 THEN
        content_preview := LEFT(content_preview, 100) || '...';
    END IF;
    IF content_preview = '' OR content_preview IS NULL THEN
        content_preview := 'New message';
    END IF;

    -- Channel mention notifications (now includes federated messages)
    IF NEW.channel_id IS NOT NULL AND NOT NEW.is_system THEN
        v_channel_id := NEW.channel_id;

        SELECT c.name, c.server_id INTO v_channel_name, v_server_id
        FROM channels c WHERE c.id = v_channel_id;

        IF FOUND AND v_server_id IS NOT NULL THEN
            SELECT s.name INTO v_server_name FROM servers s WHERE s.id = v_server_id;
        END IF;

        SELECT trim(both '"' from config_value::text) INTO current_domain
        FROM instance_config WHERE config_key = 'domain' LIMIT 1;

        IF jsonb_typeof(NEW.content) = 'array' THEN
            FOR content_part IN SELECT jsonb_array_elements(NEW.content)
            LOOP
                IF content_part->>'type' = 'mention' THEN
                    mentioned_username := content_part->>'username';
                    mentioned_domain  := content_part->>'domain';

                    IF mentioned_domain IS NULL OR mentioned_domain = current_domain THEN
                        SELECT id INTO mentioned_user_id
                        FROM profiles
                        WHERE username = mentioned_username
                          AND (domain IS NULL OR domain = current_domain)
                          AND is_local = true
                          AND id != NEW.user_id;
                    ELSE
                        SELECT id INTO mentioned_user_id
                        FROM profiles
                        WHERE username = mentioned_username
                          AND domain = mentioned_domain
                          AND id != NEW.user_id;
                    END IF;

                    IF mentioned_user_id IS NOT NULL THEN
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
                    END IF;
                END IF;
            END LOOP;
        END IF;
    END IF;

    -- DM / group chat notifications
    CASE v_federation_type
        WHEN 'chat_local_only' THEN
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

        WHEN 'chat_federated' THEN
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
                    'preview', content_preview,
                    'federated', true
                ),
                NULL, NULL, NEW.conversation_id, NEW.user_id, 'normal'
            );

        WHEN 'federated_new_dm' THEN
            DECLARE
                v_inviter profiles%ROWTYPE;
            BEGIN
                SELECT p.* INTO v_inviter
                FROM conversation_participants cp
                JOIN profiles p ON p.id = cp.user_id
                WHERE cp.conversation_id = NEW.conversation_id
                AND cp.user_id != NEW.user_id
                ORDER BY cp.joined_at ASC LIMIT 1;

                PERFORM send_notification_to_user('dm', NEW.user_id,
                    jsonb_build_object(
                        'sender', jsonb_build_object('user_id', COALESCE(v_inviter.id, '00000000-0000-0000-0000-000000000000'),
                            'username', COALESCE(v_inviter.username, 'system'),
                            'display_name', COALESCE(v_inviter.display_name, v_inviter.username, 'System'),
                            'avatar_url', v_inviter.avatar_url),
                        'message', jsonb_build_object('id', NEW.id, 'content_preview', content_preview),
                        'conversation', jsonb_build_object('id', NEW.conversation_id),
                        'message_id', NEW.id,
                        'sender_username', COALESCE(v_inviter.username, 'system'),
                        'sender_display_name', COALESCE(v_inviter.display_name, v_inviter.username, 'System'),
                        'conversation_id', NEW.conversation_id,
                        'preview', content_preview,
                        'federated', true
                    ),
                    NULL, NULL, NEW.conversation_id, COALESCE(v_inviter.id, NEW.user_id), 'normal');
            END;

        ELSE
            NULL;
    END CASE;

    RETURN NEW;
END;
$$;

-- =============================================================================
-- 6. Fix unified notification handler: also handle 'favorite' interaction type
-- =============================================================================
CREATE OR REPLACE FUNCTION public.handle_unified_notification_processing() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
    single_target_id uuid;
    notification_data jsonb;
    msg_channel_id uuid;
    msg_server_id uuid;
    msg_conversation_id uuid;
    post_author_id uuid;
    post_record RECORD;
    emoji_record RECORD;
    emoji_name text;
    emoji_url text;
    reactor_profile RECORD;
    follower_profile RECORD;
BEGIN
    -- Handle follows
    IF TG_TABLE_NAME = 'follows' AND TG_OP = 'INSERT' THEN
        SELECT id, username, display_name, avatar_url, domain, is_local
        INTO follower_profile
        FROM profiles
        WHERE id = NEW.follower_id;

        IF follower_profile.id IS NOT NULL THEN
            notification_data := jsonb_build_object(
                'type', 'activitypub_follow',
                'follower_id', NEW.follower_id,
                'follower', jsonb_build_object(
                    'id', follower_profile.id,
                    'username', follower_profile.username,
                    'display_name', follower_profile.display_name,
                    'avatar_url', follower_profile.avatar_url,
                    'domain', follower_profile.domain,
                    'is_local', follower_profile.is_local
                )
            );

            PERFORM send_notification_to_user(
                'activitypub_follow',
                NEW.following_id,
                notification_data,
                NULL, NULL, NULL,
                NEW.follower_id,
                'normal'
            );
        END IF;

    ELSIF TG_TABLE_NAME = 'reactions' AND TG_OP = 'INSERT' THEN
        SELECT user_id INTO single_target_id FROM messages WHERE id = NEW.message_id;
        
        IF single_target_id IS NOT NULL AND single_target_id != NEW.user_id THEN
            SELECT m.channel_id, c.server_id, m.conversation_id
            INTO msg_channel_id, msg_server_id, msg_conversation_id
            FROM messages m 
            LEFT JOIN channels c ON m.channel_id = c.id 
            WHERE m.id = NEW.message_id;
            
            SELECT id, username, display_name, avatar_url, domain, is_local
            INTO reactor_profile
            FROM profiles
            WHERE id = NEW.user_id;
            
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
                'type', 'reaction',
                'message_id', NEW.message_id,
                'emoji_id', NEW.emoji_id,
                'user_id', NEW.user_id,
                'emoji_name', emoji_name,
                'emoji_url', emoji_url,
                'reactor', CASE WHEN reactor_profile.id IS NOT NULL THEN
                    jsonb_build_object(
                        'id', reactor_profile.id,
                        'username', reactor_profile.username,
                        'display_name', reactor_profile.display_name,
                        'avatar_url', reactor_profile.avatar_url,
                        'domain', reactor_profile.domain,
                        'is_local', reactor_profile.is_local
                    )
                ELSE NULL END
            );

            IF msg_conversation_id IS NOT NULL THEN
                notification_data := notification_data || jsonb_build_object(
                    'conversation_id', msg_conversation_id
                );
            END IF;
            
            PERFORM send_notification_to_user(
                'reaction',
                single_target_id,
                notification_data,
                msg_server_id, msg_channel_id, msg_conversation_id,
                NEW.user_id,
                'normal'
            );
        END IF;

    ELSIF TG_TABLE_NAME = 'post_interactions' AND TG_OP = 'INSERT' THEN
        IF NEW.interaction_type IN ('emoji_reaction', 'favorite') THEN
            SELECT author_id INTO post_author_id 
            FROM posts 
            WHERE id = NEW.post_id;
            
            IF post_author_id IS NOT NULL AND post_author_id != NEW.user_id THEN
                SELECT * INTO post_record FROM posts WHERE id = NEW.post_id;
                
                SELECT id, username, display_name, avatar_url, domain, is_local
                INTO reactor_profile
                FROM profiles
                WHERE id = NEW.user_id;
                
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
                    'type', CASE WHEN NEW.interaction_type = 'favorite' THEN 'activitypub_favorite' ELSE 'activitypub_reaction' END,
                    'post_id', NEW.post_id,
                    'post', jsonb_build_object(
                        'id', post_record.id,
                        'content_preview', extract_message_text(post_record.content)
                    ),
                    'reaction', jsonb_build_object(
                        'emoji_id', NEW.emoji_id,
                        'emoji_name', COALESCE(emoji_name, NEW.custom_emoji_content),
                        'emoji_url', emoji_url,
                        'custom_emoji_content', NEW.custom_emoji_content
                    ),
                    'sender', CASE WHEN reactor_profile.id IS NOT NULL THEN
                        jsonb_build_object(
                            'id', reactor_profile.id,
                            'username', reactor_profile.username,
                            'display_name', reactor_profile.display_name,
                            'avatar_url', reactor_profile.avatar_url,
                            'domain', reactor_profile.domain,
                            'is_local', reactor_profile.is_local
                        )
                    ELSE NULL END
                );
                
                PERFORM send_notification_to_user(
                    CASE WHEN NEW.interaction_type = 'favorite' THEN 'activitypub_favorite' ELSE 'activitypub_reaction' END,
                    post_author_id,
                    notification_data,
                    NULL, NULL, NULL,
                    NEW.user_id,
                    'normal'
                );
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- =============================================================================
-- 7. Full implementation of handle_post_mention_notifications (replace placeholder)
-- =============================================================================
CREATE OR REPLACE FUNCTION public.handle_post_mention_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    content_part JSONB;
    mentioned_username TEXT;
    mentioned_user_id UUID;
    author_profile RECORD;
    post_content_preview TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT id, username, display_name, avatar_url, domain, is_local
        INTO author_profile
        FROM profiles 
        WHERE id = NEW.author_id;
        
        IF FOUND AND NEW.content IS NOT NULL THEN
            post_content_preview := extract_message_text(NEW.content);
            IF LENGTH(post_content_preview) > 100 THEN
                post_content_preview := LEFT(post_content_preview, 100) || '...';
            END IF;
            IF post_content_preview = '' OR post_content_preview IS NULL THEN
                post_content_preview := 'New post';
            END IF;
            
            IF jsonb_typeof(NEW.content) = 'array' THEN
                FOR content_part IN SELECT jsonb_array_elements(NEW.content)
                LOOP
                    IF content_part->>'type' = 'mention' THEN
                        mentioned_username := content_part->>'username';
                        
                        IF content_part->>'isLocal' = 'true' THEN
                            SELECT id INTO mentioned_user_id
                            FROM profiles 
                            WHERE username = mentioned_username 
                              AND is_local = true
                              AND id != NEW.author_id;
                            
                            IF mentioned_user_id IS NOT NULL THEN
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
                                    NULL,
                                    NULL,
                                    NULL,
                                    author_profile.id,
                                    'normal'
                                );
                            END IF;
                        END IF;
                    END IF;
                END LOOP;
            END IF;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;

-- =============================================================================
-- 8. Full implementation of handle_local_post_mention_notifications
-- =============================================================================
CREATE OR REPLACE FUNCTION public.handle_local_post_mention_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    content_part JSONB;
    mentioned_username TEXT;
    mentioned_user_id UUID;
    author_profile RECORD;
    post_content_preview TEXT;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT id, username, display_name, avatar_url, domain, is_local
        INTO author_profile
        FROM profiles 
        WHERE id = NEW.author_id;
        
        IF FOUND AND NEW.content IS NOT NULL THEN
            post_content_preview := extract_message_text(NEW.content);
            IF LENGTH(post_content_preview) > 100 THEN
                post_content_preview := LEFT(post_content_preview, 100) || '...';
            END IF;
            IF post_content_preview = '' OR post_content_preview IS NULL THEN
                post_content_preview := 'New post';
            END IF;
            
            IF jsonb_typeof(NEW.content) = 'array' THEN
                FOR content_part IN SELECT jsonb_array_elements(NEW.content)
                LOOP
                    IF content_part->>'type' = 'mention' THEN
                        mentioned_username := content_part->>'username';
                        
                        SELECT id INTO mentioned_user_id
                        FROM profiles
                        WHERE username = mentioned_username
                          AND is_local = true
                          AND id != NEW.author_id;
                        
                        IF mentioned_user_id IS NOT NULL THEN
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
                                NULL,
                                NULL,
                                NULL,
                                author_profile.id,
                                'normal'
                            );
                        END IF;
                    END IF;
                END LOOP;
            END IF;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;

-- =============================================================================
-- 9. Fix increment_unread_mentions: was referencing wrong column 'mentions_count'
--    instead of correct column 'unread_mentions'
-- =============================================================================
CREATE OR REPLACE FUNCTION public.increment_unread_mentions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_id uuid;
    v_channel_id uuid;
    v_server_id uuid;
    v_conversation_id uuid;
    existing_count_id uuid;
BEGIN
    IF NEW.type != 'mention' AND NEW.type != 'activitypub_mention' THEN
        RETURN NEW;
    END IF;

    v_user_id := NEW.user_id;

    v_channel_id := NULLIF((NEW.data->>'channel_id'), '')::uuid;
    v_server_id := NULLIF((NEW.data->>'server_id'), '')::uuid;
    v_conversation_id := NULLIF((NEW.data->>'conversation_id'), '')::uuid;

    IF v_channel_id IS NULL THEN
        v_channel_id := NULLIF((NEW.data->'location'->>'channel_id'), '')::uuid;
    END IF;
    IF v_server_id IS NULL THEN
        v_server_id := NULLIF((NEW.data->'location'->>'server_id'), '')::uuid;
    END IF;

    IF v_channel_id IS NOT NULL THEN
        SELECT id INTO existing_count_id
        FROM unread_counts
        WHERE user_id = v_user_id
          AND channel_id = v_channel_id
          AND (server_id = v_server_id OR (server_id IS NULL AND v_server_id IS NULL))
          AND conversation_id IS NULL;

        IF existing_count_id IS NOT NULL THEN
            UPDATE unread_counts
            SET unread_mentions = unread_mentions + 1,
                updated_at = NOW()
            WHERE id = existing_count_id;
        ELSE
            INSERT INTO unread_counts (user_id, channel_id, server_id, unread_mentions, updated_at)
            VALUES (v_user_id, v_channel_id, v_server_id, 1, NOW());
        END IF;
    END IF;

    IF v_conversation_id IS NOT NULL THEN
        SELECT id INTO existing_count_id
        FROM unread_counts
        WHERE user_id = v_user_id
          AND conversation_id = v_conversation_id
          AND channel_id IS NULL
          AND server_id IS NULL;

        IF existing_count_id IS NOT NULL THEN
            UPDATE unread_counts
            SET unread_mentions = unread_mentions + 1,
                updated_at = NOW()
            WHERE id = existing_count_id;
        ELSE
            INSERT INTO unread_counts (user_id, conversation_id, unread_mentions, updated_at)
            VALUES (v_user_id, v_conversation_id, 1, NOW());
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;
