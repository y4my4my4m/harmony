-- =============================================================================
-- Harmony Database Schema - Trigger Functions
-- =============================================================================
-- Functions that are called by triggers (RETURNS trigger)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PROFILE TRIGGERS
-- ---------------------------------------------------------------------------

-- Promote first local user to instance admin
CREATE OR REPLACE FUNCTION public.promote_first_user_to_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NEW.is_local = true OR NEW.is_local IS NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.profiles
            WHERE is_local = true AND id != NEW.id
        ) THEN
            NEW.is_admin := true;
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.promote_first_user_to_admin() IS 
'Sets is_admin=true on the first local profile created on the instance.';

-- Create notification preferences on new profile
CREATE OR REPLACE FUNCTION public.create_notification_preferences()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NEW.is_local = true OR NEW.is_local IS NULL THEN
        INSERT INTO notification_preferences (user_id)
        VALUES (NEW.id)
        ON CONFLICT (user_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.create_notification_preferences() IS 
'Creates notification preferences only for local users.';

-- ---------------------------------------------------------------------------
-- SERVER LIMIT ENFORCEMENT
-- ---------------------------------------------------------------------------

-- Check channel limit before insert (max 100 channels per server)
CREATE OR REPLACE FUNCTION public.check_channel_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  channel_count INTEGER;
  max_channels CONSTANT INTEGER := 100;
BEGIN
  -- Count existing channels for this server
  SELECT COUNT(*) INTO channel_count
  FROM channels
  WHERE server_id = NEW.server_id;
  
  -- Check if limit would be exceeded
  IF channel_count >= max_channels THEN
    RAISE EXCEPTION 'Channel limit exceeded: Maximum % channels per server', max_channels
      USING ERRCODE = 'check_violation';
  END IF;
  
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.check_channel_limit() IS 
'Enforces maximum 100 channels per server';

-- Check category limit before insert (max 25 categories per server)
CREATE OR REPLACE FUNCTION public.check_category_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  category_count INTEGER;
  max_categories CONSTANT INTEGER := 25;
BEGIN
  -- Count existing categories for this server
  SELECT COUNT(*) INTO category_count
  FROM channel_categories
  WHERE server_id = NEW.server_id;
  
  -- Check if limit would be exceeded
  IF category_count >= max_categories THEN
    RAISE EXCEPTION 'Category limit exceeded: Maximum % categories per server', max_categories
      USING ERRCODE = 'check_violation';
  END IF;
  
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.check_category_limit() IS 
'Enforces maximum 25 categories per server';

-- ---------------------------------------------------------------------------
-- SERVER TRIGGERS
-- ---------------------------------------------------------------------------

-- Create default @everyone role for new server
CREATE OR REPLACE FUNCTION public.create_default_server_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    everyone_role_id uuid;
    admin_role_id uuid;
BEGIN
    -- Create @everyone role (default for all members)
    INSERT INTO server_roles (
        server_id,
        name,
        color,
        position,
        is_default,
        is_admin,
        permissions
    ) VALUES (
        NEW.id,
        'everyone',
        '#99AAB5',
        0,
        true,
        false,
        104324161  -- Default Discord-like permissions
    ) RETURNING id INTO everyone_role_id;
    
    -- Create Admin role for the owner (highest position, all permissions)
    INSERT INTO server_roles (
        server_id,
        name,
        color,
        position,
        is_default,
        is_admin,
        permissions
    ) VALUES (
        NEW.id,
        'Admin',
        '#e74c3c',  -- Red color for admin
        999,        -- High position (owner is always above)
        false,
        true,       -- Mark as admin role
        2199023255551  -- All permissions (ADMINISTRATOR)
    ) RETURNING id INTO admin_role_id;
    
    -- Assign the Admin role to the server owner
    INSERT INTO user_roles (user_id, role_id, server_id)
    VALUES (NEW.owner, admin_role_id, NEW.id)
    ON CONFLICT (user_id, role_id) DO NOTHING;
    
    RETURN NEW;
END;
$$;

-- Helper: create default server structure (categories, channels)
CREATE OR REPLACE FUNCTION public.create_default_server_structure(p_server_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_text_category_id uuid;
    v_voice_category_id uuid;
BEGIN
    INSERT INTO public.channel_categories (server_id, name, "order")
    VALUES (p_server_id, 'Text Channels', 0)
    RETURNING id INTO v_text_category_id;

    INSERT INTO public.channels (server_id, name, type, category, "order")
    VALUES (p_server_id, 'general', 0, v_text_category_id, 0);

    INSERT INTO public.channel_categories (server_id, name, "order")
    VALUES (p_server_id, 'Voice Channels', 1)
    RETURNING id INTO v_voice_category_id;

    INSERT INTO public.channels (server_id, name, type, category, "order")
    VALUES (p_server_id, 'voice chat', 1, v_voice_category_id, 0);
END;
$$;

-- Create default server structure trigger (skips remote servers)
CREATE OR REPLACE FUNCTION public.trigger_create_default_server_structure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NEW.is_local_server = true OR NEW.is_local_server IS NULL THEN
        PERFORM public.create_default_server_structure(NEW.id);
    END IF;
    RETURN NEW;
END;
$$;

-- Assign default role to new server member
CREATE OR REPLACE FUNCTION public.assign_default_role_to_member()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    default_role_id uuid;
BEGIN
    IF NEW.status = 'accepted' THEN
        SELECT id INTO default_role_id
        FROM server_roles
        WHERE server_id = NEW.server_id AND is_default = true
        LIMIT 1;
        
        IF default_role_id IS NOT NULL THEN
            INSERT INTO user_roles (user_id, role_id, server_id)
            VALUES (NEW.user_id, default_role_id, NEW.server_id)
            ON CONFLICT (user_id, role_id) DO NOTHING;
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Set member instance from profile domain
CREATE OR REPLACE FUNCTION public.set_member_instance()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    SELECT domain INTO NEW.member_instance
    FROM profiles
    WHERE id = NEW.user_id;
    
    RETURN NEW;
END;
$$;

-- Prevent deletion of protected roles
CREATE OR REPLACE FUNCTION public.prevent_protected_role_deletion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.is_default = true THEN
        RAISE EXCEPTION 'Cannot delete the default @everyone role';
    END IF;
    RETURN OLD;
END;
$$;

-- ---------------------------------------------------------------------------
-- TIMELINE TRIGGERS
-- ---------------------------------------------------------------------------

-- Add posts to timeline when created
CREATE OR REPLACE FUNCTION public.create_comprehensive_timeline_entries()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    follower_record RECORD;
    local_user_record RECORD;
BEGIN
    IF COALESCE(NEW.is_deleted, false) THEN
        RETURN NEW;
    END IF;
    
    -- Add to author's own home timeline (local authors only)
    IF NEW.is_local THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        VALUES (NEW.author_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000)
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END IF;
    
    -- Add to followers' home timelines based on visibility
    IF NEW.visibility = 'public' THEN
        FOR follower_record IN 
            SELECT f.follower_id 
            FROM follows f 
            JOIN profiles p ON f.follower_id = p.id
            WHERE f.following_id = NEW.author_id 
              AND f.status IN ('accepted', 'pending')
              AND p.is_local = true
              AND f.follower_id != NEW.author_id
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (follower_record.follower_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        END LOOP;
    ELSIF NEW.visibility IN ('unlisted', 'followers') THEN
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
    
    -- Add public posts to public timeline for all local users
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

-- Add existing posts to new follower's timeline
CREATE OR REPLACE FUNCTION public.add_existing_posts_to_new_follower_timeline()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    post_record RECORD;
BEGIN
    IF NEW.status = 'pending' THEN
        FOR post_record IN 
            SELECT id, created_at
            FROM posts 
            WHERE author_id = NEW.following_id
              AND visibility = 'public'
              AND NOT COALESCE(is_deleted, false)
              AND created_at > NOW() - INTERVAL '7 days'
            ORDER BY created_at DESC
            LIMIT 50
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (NEW.follower_id, post_record.id, 'home', EXTRACT(epoch FROM post_record.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        END LOOP;
    ELSIF NEW.status = 'accepted' THEN
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
            VALUES (NEW.follower_id, post_record.id, 'home', EXTRACT(epoch FROM post_record.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        END LOOP;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Backfill timeline on follow acceptance
CREATE OR REPLACE FUNCTION public.backfill_timeline_on_follow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    post_record RECORD;
BEGIN
    -- Only for local followers
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = NEW.follower_id AND is_local = true) THEN
        RETURN NEW;
    END IF;
    
    -- When follow becomes accepted, add unlisted posts
    IF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status = 'accepted' THEN
        FOR post_record IN
            SELECT id, created_at
            FROM posts
            WHERE author_id = NEW.following_id
              AND visibility = 'unlisted'
              AND NOT COALESCE(is_deleted, false)
              AND created_at > NOW() - INTERVAL '7 days'
            ORDER BY created_at DESC
            LIMIT 50
        LOOP
            INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
            VALUES (NEW.follower_id, post_record.id, 'home', EXTRACT(epoch FROM post_record.created_at) * 1000000)
            ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
        END LOOP;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Remove timeline entries on unfollow
CREATE OR REPLACE FUNCTION public.remove_timeline_on_unfollow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    DELETE FROM timeline_entries
    WHERE user_id = OLD.follower_id
      AND post_id IN (SELECT id FROM posts WHERE author_id = OLD.following_id)
      AND timeline_type = 'home';
    
    RETURN OLD;
END;
$$;

-- ---------------------------------------------------------------------------
-- POST TRIGGERS
-- ---------------------------------------------------------------------------

-- Handle post soft delete
CREATE OR REPLACE FUNCTION public.handle_post_soft_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NEW.is_deleted = true AND (OLD.is_deleted = false OR OLD.is_deleted IS NULL) THEN
        -- Remove from all timelines
        DELETE FROM timeline_entries WHERE post_id = NEW.id;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Cascade delete reblogs when original is deleted
CREATE OR REPLACE FUNCTION public.cascade_delete_reblogs()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Mark reblogs as deleted too
    UPDATE posts
    SET is_deleted = true, deleted_at = NOW()
    WHERE (reblog->>'id')::uuid = NEW.id
      AND (is_deleted = false OR is_deleted IS NULL);
    
    RETURN NEW;
END;
$$;

-- Extract hashtags from post content
CREATE OR REPLACE FUNCTION public.trigger_extract_post_hashtags()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_hashtags text[];
    v_tag text;
    v_hashtag_id uuid;
BEGIN
    -- Extract hashtags from content
    SELECT array_agg(DISTINCT lower(m[1]))
    INTO v_hashtags
    FROM regexp_matches(
        COALESCE((SELECT string_agg(elem->>'text', ' ') FROM jsonb_array_elements(NEW.content) AS elem), ''),
        '#([a-zA-Z0-9_]+)',
        'g'
    ) AS m;
    
    IF v_hashtags IS NOT NULL THEN
        FOREACH v_tag IN ARRAY v_hashtags
        LOOP
            -- Insert or update hashtag
            INSERT INTO hashtags (tag, normalized_tag, total_uses, last_used_at)
            VALUES (v_tag, lower(v_tag), 1, NOW())
            ON CONFLICT (normalized_tag) DO UPDATE
            SET total_uses = hashtags.total_uses + 1,
                daily_uses = hashtags.daily_uses + 1,
                last_used_at = NOW()
            RETURNING id INTO v_hashtag_id;
            
            -- Link post to hashtag
            INSERT INTO post_hashtags (post_id, hashtag_id)
            VALUES (NEW.id, v_hashtag_id)
            ON CONFLICT (post_id, hashtag_id) DO NOTHING;
        END LOOP;
    END IF;
    
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- REACTION TRIGGERS
-- ---------------------------------------------------------------------------

-- Update favorites_count / reblogs_count on post_interactions insert/delete
CREATE OR REPLACE FUNCTION public.update_post_reaction_counts()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
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

-- Check emoji reaction limit for posts
CREATE OR REPLACE FUNCTION public.check_emoji_reaction_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    reaction_count integer;
BEGIN
    IF NEW.interaction_type = 'emoji_reaction' THEN
        SELECT COUNT(*) INTO reaction_count
        FROM post_interactions
        WHERE user_id = NEW.user_id
          AND post_id = NEW.post_id
          AND interaction_type = 'emoji_reaction';
        
        IF reaction_count >= 20 THEN
            RAISE EXCEPTION 'Maximum emoji reactions per post reached (20)';
        END IF;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Check emoji reaction limit for messages
CREATE OR REPLACE FUNCTION public.check_message_emoji_reaction_limit()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    reaction_count integer;
BEGIN
    SELECT COUNT(*) INTO reaction_count
    FROM reactions
    WHERE user_id = NEW.user_id AND message_id = NEW.message_id;
    
    IF reaction_count >= 20 THEN
        RAISE EXCEPTION 'Maximum emoji reactions per message reached (20)';
    END IF;
    
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- FEDERATION QUEUE TRIGGERS
-- ---------------------------------------------------------------------------

-- Queue post for federation
CREATE OR REPLACE FUNCTION public.trigger_queue_post_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NEW.is_local = false OR NEW.visibility NOT IN ('public', 'unlisted') THEN
        NEW.federation_status := 'skipped';
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        NEW.federation_status := 'queued';
        PERFORM public.queue_federation_job(
            'federate-post',
            jsonb_build_object(
                'type', 'create',
                'post_id', NEW.id,
                'author_id', NEW.author_id,
                'visibility', NEW.visibility,
                'created_at', NEW.created_at
            ), 5, 5, 3600
        );
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF OLD.federation_status IS DISTINCT FROM NEW.federation_status
           AND OLD.content = NEW.content
           AND OLD.is_deleted = NEW.is_deleted
           AND OLD.is_pinned = NEW.is_pinned THEN
            RETURN NEW;
        END IF;

        IF NEW.is_deleted = true AND OLD.is_deleted = false THEN
            NEW.federation_status := 'queued';
            PERFORM public.queue_federation_job(
                'federate-post',
                jsonb_build_object('type', 'delete', 'post_id', NEW.id, 'author_id', NEW.author_id),
                10, 5, 3600
            );
        ELSIF NEW.is_pinned IS DISTINCT FROM OLD.is_pinned THEN
            NEW.federation_status := 'queued';
            PERFORM public.queue_federation_job(
                'federate-post',
                jsonb_build_object('type', 'pin_change', 'post_id', NEW.id, 'author_id', NEW.author_id, 'is_pinned', NEW.is_pinned),
                5, 5, 3600
            );
        ELSIF NEW.content IS DISTINCT FROM OLD.content THEN
            NEW.federation_status := 'queued';
            PERFORM public.queue_federation_job(
                'federate-post',
                jsonb_build_object('type', 'update', 'post_id', NEW.id, 'author_id', NEW.author_id, 'visibility', NEW.visibility),
                5, 5, 3600
            );
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

-- Queue follow for federation
CREATE OR REPLACE FUNCTION public.trigger_queue_follow_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_follower_is_local BOOLEAN;
BEGIN
    SELECT is_local INTO v_follower_is_local FROM public.profiles WHERE id = NEW.follower_id;

    IF v_follower_is_local = true THEN
        IF TG_OP = 'INSERT' THEN
            NEW.federation_status := 'queued';
            PERFORM public.queue_federation_job(
                'federate-follow',
                jsonb_build_object(
                    'type', 'create',
                    'follow_id', NEW.id,
                    'follower_id', NEW.follower_id,
                    'following_id', NEW.following_id,
                    'status', NEW.status
                ), 5, 5, 3600
            );
        ELSIF TG_OP = 'DELETE' THEN
            PERFORM public.queue_federation_job(
                'federate-follow',
                jsonb_build_object(
                    'type', 'delete',
                    'follow_id', OLD.id,
                    'follower_id', OLD.follower_id,
                    'following_id', OLD.following_id
                ), 5, 5, 3600
            );
            RETURN OLD;
        END IF;
    ELSE
        NEW.federation_status := 'skipped';
    END IF;

    RETURN NEW;
END;
$$;

-- Queue interaction for federation
CREATE OR REPLACE FUNCTION public.trigger_queue_interaction_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.federation_status := 'queued';
        PERFORM public.queue_federation_job(
            'federate-reaction',
            jsonb_build_object(
                'type', 'create',
                'interaction_id', NEW.id,
                'interaction_type', NEW.interaction_type,
                'post_id', NEW.post_id,
                'user_id', NEW.user_id,
                'emoji_id', NEW.emoji_id,
                'custom_emoji_content', NEW.custom_emoji_content
            ), 5, 3, 1800
        );
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM public.queue_federation_job(
            'federate-reaction',
            jsonb_build_object(
                'type', 'delete',
                'interaction_id', OLD.id,
                'interaction_type', OLD.interaction_type,
                'post_id', OLD.post_id,
                'user_id', OLD.user_id
            ), 5, 3, 1800
        );
        RETURN OLD;
    END IF;

    RETURN NEW;
END;
$$;

-- Queue profile update for federation (includes custom_status)
CREATE OR REPLACE FUNCTION public.trigger_queue_profile_federation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_job_id uuid;
    v_has_pgboss boolean := false;
BEGIN
    IF NEW.is_local != true THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF (
            OLD.display_name IS NOT DISTINCT FROM NEW.display_name AND
            OLD.bio IS NOT DISTINCT FROM NEW.bio AND
            OLD.avatar_url IS NOT DISTINCT FROM NEW.avatar_url AND
            OLD.banner_url IS NOT DISTINCT FROM NEW.banner_url AND
            OLD.custom_status IS NOT DISTINCT FROM NEW.custom_status
        ) THEN
            RETURN NEW;
        END IF;
    END IF;

    SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'pgboss' AND table_name = 'job'
    ) INTO v_has_pgboss;

    IF v_has_pgboss THEN
        INSERT INTO pgboss.job (
            id, name, data, priority, retry_limit, expire_in, created_on, state
        ) VALUES (
            gen_random_uuid(), 'federate-profile',
            jsonb_build_object(
                'type', CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
                'profile_id', NEW.id,
                'username', NEW.username,
                'display_name', NEW.display_name,
                'bio', NEW.bio,
                'avatar_url', NEW.avatar_url,
                'banner_url', NEW.banner_url,
                'custom_status', NEW.custom_status
            ),
            3, 5, interval '1 hour', now(), 'created'
        ) RETURNING id INTO v_job_id;
        RAISE LOG 'Queued profile federation for % (job: %)', NEW.username, v_job_id;
    ELSE
        RAISE LOG 'Profile federation skipped for % - pg-boss not initialized', NEW.username;
    END IF;

    RETURN NEW;
EXCEPTION
    WHEN undefined_table THEN
        RAISE LOG 'Profile federation skipped - required tables not available';
        RETURN NEW;
    WHEN OTHERS THEN
        RAISE LOG 'Profile federation error: %', SQLERRM;
        RETURN NEW;
END;
$$;

-- Queue thread creation/updates for federation
CREATE OR REPLACE FUNCTION public.trigger_queue_thread_federation()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_creator_is_local BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT c.server_id, s.is_local_server INTO v_server_id, v_server_is_local
        FROM public.channels c JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        SELECT is_local INTO v_creator_is_local FROM public.profiles WHERE id = NEW.created_by;

        IF v_creator_is_local IS NOT TRUE THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;

        NEW.federation_status := 'queued';
        PERFORM public.queue_federation_job(
            'federate-thread',
            jsonb_build_object(
                'type', 'create', 'thread_id', NEW.id, 'channel_id', NEW.channel_id,
                'server_id', v_server_id, 'server_is_local', COALESCE(v_server_is_local, true),
                'created_by', NEW.created_by, 'created_at', NEW.created_at
            ), 5, 5, 900
        );
    ELSIF TG_OP = 'UPDATE' THEN
        IF (OLD.name IS NOT DISTINCT FROM NEW.name AND
            OLD.archived IS NOT DISTINCT FROM NEW.archived AND
            OLD.locked IS NOT DISTINCT FROM NEW.locked) THEN
            RETURN NEW;
        END IF;

        SELECT c.server_id, s.is_local_server INTO v_server_id, v_server_is_local
        FROM public.channels c JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        SELECT is_local INTO v_creator_is_local FROM public.profiles WHERE id = NEW.created_by;
        IF v_creator_is_local IS NOT TRUE THEN RETURN NEW; END IF;

        IF NEW.federation_status = 'local' OR NEW.federation_status IS NULL THEN
            NEW.federation_status := 'queued';
        END IF;

        PERFORM public.queue_federation_job(
            'federate-thread',
            jsonb_build_object(
                'type', 'update', 'thread_id', NEW.id, 'channel_id', NEW.channel_id,
                'server_id', v_server_id, 'server_is_local', COALESCE(v_server_is_local, true),
                'created_by', NEW.created_by
            ), 5, 5, 900
        );
    END IF;

    RETURN NEW;
EXCEPTION
    WHEN undefined_table THEN RETURN NEW;
    WHEN OTHERS THEN
        RAISE LOG 'Thread federation error: %', SQLERRM;
        RETURN NEW;
END;
$$;

-- Unpin message when it's soft-deleted
CREATE OR REPLACE FUNCTION public.handle_pinned_message_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.is_deleted = true AND OLD.is_deleted = false THEN
        NEW.is_pinned := false;
        NEW.pinned_at := NULL;
        NEW.pinned_by := NULL;
    END IF;
    RETURN NEW;
END;
$$;

-- Queue channel message for federation
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_author_is_local BOOLEAN;
BEGIN
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF NEW.metadata ? 'federated' THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;

        SELECT is_local INTO v_author_is_local
        FROM public.profiles
        WHERE id = NEW.user_id;

        IF v_author_is_local IS NOT TRUE THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;

        SELECT c.server_id, s.is_local_server
        INTO v_server_id, v_server_is_local
        FROM public.channels c
        JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        NEW.federation_status := 'queued';

        PERFORM public.queue_federation_job(
            'federate-channel-message',
            jsonb_build_object(
                'type', 'create',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id,
                'server_id', v_server_id,
                'server_is_local', COALESCE(v_server_is_local, true),
                'created_at', NEW.created_at
            ),
            5, 5, 900
        );
    END IF;

    RETURN NEW;
END;
$$;

-- Queue DM for federation
CREATE OR REPLACE FUNCTION public.trigger_queue_dm_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NEW.conversation_id IS NOT NULL AND NOT (NEW.metadata ? 'federated') THEN
        NEW.federation_status := 'queued';

        PERFORM public.queue_federation_job(
            'federate-dm',
            jsonb_build_object(
                'type', 'create',
                'message_id', NEW.id,
                'conversation_id', NEW.conversation_id,
                'user_id', NEW.user_id,
                'created_at', NEW.created_at
            ),
            5, 5, 3600
        );
    ELSE
        NEW.federation_status := 'skipped';
    END IF;

    RETURN NEW;
END;
$$;

-- Queue channel reaction for federation
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_reaction_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_is_local BOOLEAN;
    v_is_channel_message BOOLEAN;
BEGIN
    SELECT is_local INTO v_user_is_local FROM public.profiles WHERE id = NEW.user_id;
    IF v_user_is_local IS NOT TRUE THEN RETURN NEW; END IF;

    SELECT (channel_id IS NOT NULL AND conversation_id IS NULL) INTO v_is_channel_message
    FROM public.messages WHERE id = NEW.message_id;
    IF v_is_channel_message IS NOT TRUE THEN RETURN NEW; END IF;

    IF NEW.metadata ? 'federated' THEN RETURN NEW; END IF;

    NEW.federation_status := 'queued';
    PERFORM public.queue_federation_job(
        'federate-channel-reaction',
        jsonb_build_object(
            'type', 'create',
            'reaction_id', NEW.id,
            'message_id', NEW.message_id,
            'user_id', NEW.user_id,
            'emoji_id', NEW.emoji_id,
            'custom_emoji_content', NEW.custom_emoji_content
        ), 5, 3, 1800
    );
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_queue_channel_reaction_delete_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_user_is_local BOOLEAN;
    v_is_channel_message BOOLEAN;
BEGIN
    SELECT is_local INTO v_user_is_local FROM public.profiles WHERE id = OLD.user_id;
    IF v_user_is_local IS NOT TRUE THEN RETURN OLD; END IF;

    SELECT (channel_id IS NOT NULL AND conversation_id IS NULL) INTO v_is_channel_message
    FROM public.messages WHERE id = OLD.message_id;
    IF v_is_channel_message IS NOT TRUE THEN RETURN OLD; END IF;

    IF OLD.metadata ? 'federated' THEN RETURN OLD; END IF;

    PERFORM public.queue_federation_job(
        'federate-channel-reaction',
        jsonb_build_object(
            'type', 'delete',
            'reaction_id', OLD.id,
            'message_id', OLD.message_id,
            'user_id', OLD.user_id,
            'emoji_id', OLD.emoji_id,
            'custom_emoji_content', OLD.custom_emoji_content
        ), 5, 3, 1800
    );
    RETURN OLD;
END;
$$;

-- Queue DM reaction for federation
CREATE OR REPLACE FUNCTION public.trigger_queue_message_reaction_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF NEW.metadata ? 'federated' THEN RETURN NEW; END IF;
    NEW.federation_status := 'queued';
    PERFORM public.queue_federation_job(
        'federate-message-reaction',
        jsonb_build_object(
            'type', 'create',
            'reaction_id', NEW.id,
            'message_id', NEW.message_id,
            'user_id', NEW.user_id,
            'emoji_id', NEW.emoji_id,
            'custom_emoji_content', NEW.custom_emoji_content
        ), 5, 3, 1800
    );
    RETURN NEW;
END;
$$;

-- Queue channel message edit for federation
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_edit_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_author_is_local BOOLEAN;
BEGIN
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF OLD.content IS NOT DISTINCT FROM NEW.content THEN RETURN NEW; END IF;
        IF NEW.metadata ? 'federated' THEN RETURN NEW; END IF;

        SELECT is_local INTO v_author_is_local FROM public.profiles WHERE id = NEW.user_id;
        IF v_author_is_local IS NOT TRUE THEN RETURN NEW; END IF;

        PERFORM public.queue_federation_job(
            'federate-channel-message-edit',
            jsonb_build_object(
                'type', 'update',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id
            ), 5, 5, 900
        );
    END IF;
    RETURN NEW;
END;
$$;

-- Queue channel message delete for federation
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_delete_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_author_is_local BOOLEAN;
BEGIN
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF OLD.is_deleted = TRUE OR NEW.is_deleted = FALSE THEN RETURN NEW; END IF;
        IF NEW.metadata ? 'federated' THEN RETURN NEW; END IF;

        SELECT is_local INTO v_author_is_local FROM public.profiles WHERE id = NEW.user_id;
        IF v_author_is_local IS NOT TRUE THEN RETURN NEW; END IF;

        PERFORM public.queue_federation_job(
            'federate-channel-message-delete',
            jsonb_build_object(
                'type', 'delete',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id,
                'ap_id', NEW.metadata->>'ap_id'
            ), 5, 5, 900
        );
    END IF;
    RETURN NEW;
END;
$$;

-- Queue block for federation
-- NOTE: Column is 'blocked_user_id', NOT 'blocked_id'
CREATE OR REPLACE FUNCTION public.trigger_queue_block_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        NEW.federation_status := 'queued';
        
        -- Queue federation job with correct column name
        PERFORM public.queue_federation_job(
            'federate-block',
            jsonb_build_object(
                'type', 'create',
                'block_id', NEW.id,
                'blocker_id', NEW.blocker_id,
                'blocked_user_id', NEW.blocked_user_id
            ),
            3,
            3,
            1800
        );
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        PERFORM public.queue_federation_job(
            'federate-block',
            jsonb_build_object(
                'type', 'delete',
                'block_id', OLD.id,
                'blocker_id', OLD.blocker_id,
                'blocked_user_id', OLD.blocked_user_id
            ),
            3,
            3,
            1800
        );
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

-- Queue report for federation
CREATE OR REPLACE FUNCTION public.trigger_queue_report_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    NEW.federation_status := 'queued';

    PERFORM public.queue_federation_job(
        'federate-report',
        jsonb_build_object(
            'type', 'create',
            'report_id', NEW.id,
            'reporter_id', NEW.reporter_id,
            'reported_user_id', NEW.reported_user_id,
            'reported_post_id', NEW.reported_post_id,
            'reason', NEW.reason
        ),
        10, 5, 7200
    );

    RETURN NEW;
END;
$$;

-- Queue voice join/leave for federation
CREATE OR REPLACE FUNCTION public.trigger_queue_voice_channel_join_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_queue_voice_channel_leave_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    RETURN OLD;
END;
$$;

-- Route server membership changes
CREATE OR REPLACE FUNCTION public.route_server_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    INSERT INTO server_membership_events (server_id, user_id, event_type, payload)
    VALUES (
        NEW.server_id,
        NEW.user_id,
        CASE 
            WHEN TG_OP = 'INSERT' THEN 'join'
            WHEN NEW.status = 'accepted' AND OLD.status = 'pending' THEN 'accept'
            ELSE 'update'
        END,
        jsonb_build_object('status', NEW.status)
    );
    
    RETURN NEW;
END;
$$;

-- Route server leave
CREATE OR REPLACE FUNCTION public.route_server_leave()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM servers WHERE id = OLD.server_id) THEN
        INSERT INTO server_membership_events (server_id, user_id, event_type, payload)
        VALUES (OLD.server_id, OLD.user_id, 'leave', '{}'::jsonb);
    END IF;
    RETURN OLD;
END;
$$;

-- Route channel message
CREATE OR REPLACE FUNCTION public.route_channel_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Handled by other triggers
    RETURN NEW;
END;
$$;

-- Handle message federation
CREATE OR REPLACE FUNCTION public.handle_message_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Placeholder for federation handling
    RETURN NEW;
END;
$$;

-- Handle post federation
CREATE OR REPLACE FUNCTION public.handle_post_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Placeholder for federation handling
    RETURN NEW;
END;
$$;

-- Handle post interaction federation
CREATE OR REPLACE FUNCTION public.handle_post_interaction_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        RETURN NEW;
    ELSE
        RETURN OLD;
    END IF;
END;
$$;

-- Handle local post mention notifications
CREATE OR REPLACE FUNCTION public.handle_local_post_mention_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Placeholder
    RETURN NEW;
END;
$$;

-- Handle post mention notifications
CREATE OR REPLACE FUNCTION public.handle_post_mention_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Placeholder
    RETURN NEW;
END;
$$;

-- Handle remote user suspension
CREATE OR REPLACE FUNCTION public.handle_remote_user_suspension()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Remove from follows, etc.
    RETURN NEW;
END;
$$;

-- Increment unread mentions
CREATE OR REPLACE FUNCTION public.increment_unread_mentions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    UPDATE unread_counts
    SET mentions_count = mentions_count + 1, updated_at = NOW()
    WHERE user_id = NEW.user_id;
    
    RETURN NEW;
END;
$$;

-- Index message for search
CREATE OR REPLACE FUNCTION public.index_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Placeholder for full-text search indexing
    RETURN NEW;
END;
$$;

-- Cleanup users with dead federation endpoints
CREATE OR REPLACE FUNCTION public.cleanup_dead_endpoint_users(p_endpoint_url text)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
AS $$
DECLARE
    v_dead_profiles RECORD;
    v_follows_removed integer := 0;
BEGIN
    FOR v_dead_profiles IN
        SELECT id, username, domain, inbox_url, shared_inbox_url
        FROM profiles
        WHERE (inbox_url = p_endpoint_url OR shared_inbox_url = p_endpoint_url)
        AND is_local = false
    LOOP
        DELETE FROM follows WHERE following_id = v_dead_profiles.id;
        GET DIAGNOSTICS v_follows_removed = ROW_COUNT;
        DELETE FROM follows WHERE follower_id = v_dead_profiles.id;

        UPDATE profiles SET
            inbox_url = NULL, shared_inbox_url = NULL, updated_at = NOW()
        WHERE id = v_dead_profiles.id;

        RAISE NOTICE 'Cleaned up dead user: %@% (removed % follows)',
            v_dead_profiles.username, v_dead_profiles.domain, v_follows_removed;
    END LOOP;
END;
$$;

-- Trigger: auto-cleanup when endpoint is marked dead
CREATE OR REPLACE FUNCTION public.trigger_cleanup_dead_endpoint()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
AS $$
BEGIN
    IF NEW.is_dead = true AND (OLD.is_dead IS NULL OR OLD.is_dead = false) THEN
        PERFORM cleanup_dead_endpoint_users(NEW.endpoint_url);
    END IF;
    RETURN NEW;
END;
$$;

-- Process link previews (local)
CREATE OR REPLACE FUNCTION public.process_local_link_previews()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Skip federated messages
    IF COALESCE(NEW.metadata->>'federated', 'false') = 'true' THEN
        RETURN NEW;
    END IF;
    
    -- Placeholder for local link preview processing
    RETURN NEW;
END;
$$;

-- Process message link previews
CREATE OR REPLACE FUNCTION public.process_message_link_previews()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Skip federated messages
    IF COALESCE(NEW.metadata->>'federated', 'false') = 'true' THEN
        RETURN NEW;
    END IF;
    
    -- Placeholder for link preview processing
    RETURN NEW;
END;
$$;

-- Webhook external link previews
CREATE OR REPLACE FUNCTION public.webhook_external_link_previews()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    -- Placeholder
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- System message when a user joins a server
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_member_join_system_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
    v_channel_id uuid;
BEGIN
    IF NEW.status IS NOT NULL AND NEW.status != 'accepted' THEN
        RETURN NEW;
    END IF;

    SELECT system_channel_id INTO v_channel_id
    FROM server_settings
    WHERE server_id = NEW.server_id;

    IF v_channel_id IS NULL THEN
        v_channel_id := get_default_channel(NEW.server_id);
    END IF;

    IF v_channel_id IS NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO messages (channel_id, user_id, content, is_system, metadata)
    VALUES (
        v_channel_id,
        NEW.user_id,
        jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'has joined the server')),
        true,
        jsonb_build_object('type', 'member_join')
    );

    RETURN NEW;
END;
$$;

DO $$
BEGIN
    RAISE NOTICE 'Trigger functions created successfully';
END $$;

