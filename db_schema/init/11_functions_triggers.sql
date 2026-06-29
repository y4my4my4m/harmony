-- =============================================================================
-- Harmony Database Schema - Trigger Functions
-- =============================================================================
-- Functions that are called by triggers (RETURNS trigger)
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PROFILE TRIGGERS
-- ---------------------------------------------------------------------------

-- Strips spoofing-vector characters (bidi overrides/isolates, zero-width &
-- invisible format chars, C0/C1 control chars), NFC-normalizes, trims, and
-- clamps to a max length. Shared by the profile sanitize trigger and the
-- hardening migration so local + federated writes are cleaned identically.
CREATE OR REPLACE FUNCTION public.sanitize_profile_string(
    p_input text,
    p_max integer,
    p_allow_newlines boolean DEFAULT false
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT CASE
        WHEN p_input IS NULL THEN NULL
        ELSE left(
            btrim(
                regexp_replace(
                    normalize(p_input, NFC),
                    CASE WHEN p_allow_newlines
                        -- keep TAB (U+0009) and LF (U+000A); strip the rest
                        THEN U&'[\0001-\0008\000B-\001F\007F-\009F\200B-\200F\202A-\202E\2060-\206F\FEFF]'
                        ELSE U&'[\0001-\001F\007F-\009F\200B-\200F\202A-\202E\2060-\206F\FEFF]'
                    END,
                    '',
                    'g'
                )
            ),
            p_max
        )
    END;
$$;

-- Sanitize user-controlled profile text on EVERY write. Local signup, profile
-- edits via Supabase REST/RLS, and federated actor upserts all pass through
-- this BEFORE trigger, so it is the authoritative guard regardless of client.
CREATE OR REPLACE FUNCTION public.sanitize_profile_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- display_name: single line, max 80; emptied -> NULL (keeps the
    -- profiles_display_name_not_blank constraint satisfied).
    IF NEW.display_name IS NOT NULL THEN
        NEW.display_name := NULLIF(public.sanitize_profile_string(NEW.display_name, 80, false), '');
    END IF;

    -- bio: line breaks allowed, max 500.
    IF NEW.bio IS NOT NULL THEN
        NEW.bio := NULLIF(public.sanitize_profile_string(NEW.bio, 500, true), '');
    END IF;

    -- profile_fields: at most 4 entries, name/value clamped to 255 each.
    IF NEW.profile_fields IS NOT NULL AND jsonb_typeof(NEW.profile_fields) = 'array' THEN
        NEW.profile_fields := COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'name',  COALESCE(public.sanitize_profile_string(elem->>'name', 255, false), ''),
                'value', COALESCE(public.sanitize_profile_string(elem->>'value', 255, false), '')
            ))
            FROM (
                SELECT elem
                FROM jsonb_array_elements(NEW.profile_fields) WITH ORDINALITY AS t(elem, ord)
                WHERE ord <= 4
            ) s
        ), '[]'::jsonb);
    END IF;

    -- custom_status: clamp the free-text fields, preserve structural keys.
    IF NEW.custom_status IS NOT NULL AND jsonb_typeof(NEW.custom_status) = 'object' THEN
        NEW.custom_status := NEW.custom_status || jsonb_strip_nulls(jsonb_build_object(
            'text',    public.sanitize_profile_string(NEW.custom_status->>'text', 128, false),
            'emoji',   public.sanitize_profile_string(NEW.custom_status->>'emoji', 64, false),
            'details', public.sanitize_profile_string(NEW.custom_status->>'details', 128, false),
            'state',   public.sanitize_profile_string(NEW.custom_status->>'state', 128, false)
        ));
    END IF;

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- GENERIC USER-INPUT TEXT SANITIZATION (servers/channels/roles/etc.)
-- ---------------------------------------------------------------------------
-- RLS lets any token-holder INSERT/UPDATE their own rows via the REST API, and
-- SECURITY DEFINER RPCs (create_thread, update_group_name, ban/kick, ...) also
-- write these tables. BEFORE INSERT/UPDATE triggers fire on EVERY write path,
-- so they are the authoritative guard against over-long / blank / spoofing
-- (bidi-override, zero-width, control char) text submitted past the UI.
--
-- All helpers below clamp + strip via public.sanitize_profile_string().

-- Generic single-line `name` column sanitizer.
-- TG_ARGV[0] = max length (default 100); TG_ARGV[1] = 'required' | 'optional'.
-- For required names, a blank value is rejected on INSERT (and on UPDATE when a
-- previously non-blank name is being blanked); pre-existing blank rows stay
-- editable. For optional names, blank collapses to NULL.
CREATE OR REPLACE FUNCTION public.sanitize_entity_name()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_max int := COALESCE(NULLIF(TG_ARGV[0], '')::int, 100);
    v_required boolean := (TG_ARGV[1] = 'required');
    v_clean text;
BEGIN
    v_clean := public.sanitize_profile_string(NEW.name, v_max, false);

    IF COALESCE(v_clean, '') = '' THEN
        IF v_required THEN
            IF TG_OP = 'INSERT' OR COALESCE(OLD.name, '') <> '' THEN
                RAISE EXCEPTION '% name must not be blank', TG_TABLE_NAME
                    USING ERRCODE = 'check_violation';
            END IF;
            NEW.name := COALESCE(v_clean, '');
        ELSE
            NEW.name := NULLIF(v_clean, '');
        END IF;
    ELSE
        NEW.name := v_clean;
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sanitize_server_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_name text := public.sanitize_profile_string(NEW.name, 100, false);
BEGIN
    IF COALESCE(v_name, '') = '' THEN
        IF TG_OP = 'INSERT' OR COALESCE(OLD.name, '') <> '' THEN
            RAISE EXCEPTION 'server name must not be blank' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    NEW.name := COALESCE(v_name, '');

    IF NEW.description IS NOT NULL THEN
        NEW.description := NULLIF(public.sanitize_profile_string(NEW.description, 500, true), '');
    END IF;

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- SERVER HANDLE (slug) for WebFinger/federation discovery
-- ---------------------------------------------------------------------------
-- Turn a display name into a slug-safe base, or NULL when nothing usable
-- remains (e.g. an all-CJK name) so callers fall back to the id prefix.
CREATE OR REPLACE FUNCTION public.slugify_server_name(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public, pg_temp
AS $$
    SELECT NULLIF(
        regexp_replace(
            regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9]+', '-', 'g'),
            '(^-+|-+$)', '', 'g'
        ),
    '');
$$;

-- Produce a slug for a local server that is unique AMONG LOCAL SERVERS. Users
-- and servers are separate actor types (Person vs Group): they're allowed to
-- share a handle, and WebFinger disambiguates by AS type (Lemmy-style). So this
-- only needs to dodge other server slugs, not usernames.
CREATE OR REPLACE FUNCTION public.generate_unique_server_slug(p_name text, p_id uuid)
RETURNS text
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    base text;
    candidate text;
    n integer := 0;
BEGIN
    base := left(coalesce(public.slugify_server_name(p_name), left(p_id::text, 8)), 60);
    candidate := base;
    WHILE EXISTS (
        SELECT 1 FROM public.servers s
        WHERE s.is_local_server = true
          AND lower(s.slug) = lower(candidate)
          AND s.id <> p_id
    ) LOOP
        n := n + 1;
        candidate := base || '-' || n;
    END LOOP;
    RETURN candidate;
END;
$$;

-- BEFORE INSERT: auto-assign a handle to local servers that don't supply one.
CREATE OR REPLACE FUNCTION public.assign_server_slug()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.is_local_server IS DISTINCT FROM true THEN
        RETURN NEW; -- remote servers keep NULL
    END IF;
    IF NEW.slug IS NOT NULL AND NEW.slug <> '' THEN
        RETURN NEW; -- explicit slug respected (format enforced by constraint)
    END IF;
    NEW.slug := public.generate_unique_server_slug(NEW.name, NEW.id);
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sanitize_channel_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_name text := public.sanitize_profile_string(NEW.name, 100, false);
BEGIN
    IF COALESCE(v_name, '') = '' THEN
        IF TG_OP = 'INSERT' OR COALESCE(OLD.name, '') <> '' THEN
            RAISE EXCEPTION 'channel name must not be blank' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    NEW.name := COALESCE(v_name, '');

    IF NEW.description IS NOT NULL THEN
        NEW.description := NULLIF(public.sanitize_profile_string(NEW.description, 1024, true), '');
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sanitize_bot_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    -- username keeps its own valid_username CHECK (charset + 3..32); don't touch.
    IF NEW.display_name IS NOT NULL THEN
        NEW.display_name := NULLIF(public.sanitize_profile_string(NEW.display_name, 100, false), '');
    END IF;
    IF NEW.bio IS NOT NULL THEN
        NEW.bio := NULLIF(public.sanitize_profile_string(NEW.bio, 500, true), '');
    END IF;
    IF NEW.website_url IS NOT NULL THEN
        NEW.website_url := NULLIF(public.sanitize_profile_string(NEW.website_url, 512, false), '');
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sanitize_report_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.reason IS NOT NULL THEN
        NEW.reason := public.sanitize_profile_string(NEW.reason, 200, false);
    END IF;
    IF NEW.comment IS NOT NULL THEN
        NEW.comment := NULLIF(public.sanitize_profile_string(NEW.comment, 1000, true), '');
    END IF;
    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sanitize_user_list_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    v_title text := public.sanitize_profile_string(NEW.title, 100, false);
BEGIN
    IF COALESCE(v_title, '') = '' THEN
        IF TG_OP = 'INSERT' OR COALESCE(OLD.title, '') <> '' THEN
            RAISE EXCEPTION 'list title must not be blank' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    NEW.title := COALESCE(v_title, '');

    IF NEW.description IS NOT NULL THEN
        NEW.description := NULLIF(public.sanitize_profile_string(NEW.description, 500, true), '');
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.sanitize_member_nickname()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.nickname IS NOT NULL THEN
        NEW.nickname := NULLIF(public.sanitize_profile_string(NEW.nickname, 64, false), '');
    END IF;
    RETURN NEW;
END;
$$;

-- posts.content_warning is federated (Mastodon CW/summary). Clamp rather than
-- reject so an over-long remote CW never blocks ingestion of an otherwise-valid
-- post; the CHECK backstop only guarantees the clamp held.
CREATE OR REPLACE FUNCTION public.sanitize_post_text()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.content_warning IS NOT NULL THEN
        NEW.content_warning := NULLIF(public.sanitize_profile_string(NEW.content_warning, 200, false), '');
    END IF;
    RETURN NEW;
END;
$$;

-- Promote first local user to instance admin
CREATE OR REPLACE FUNCTION public.promote_first_user_to_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
SET search_path = public
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
SET search_path = public
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
        122646786  -- Default permissions: VIEW_CHANNEL, CREATE_INVITE, SEND_MESSAGES, SEND_MESSAGES_IN_THREADS, CREATE_PUBLIC_THREADS, EMBED_LINKS, ATTACH_FILES, ADD_REACTIONS, USE_EXTERNAL_EMOJIS, READ_MESSAGE_HISTORY, CONNECT, SPEAK, STREAM
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
SET search_path = public
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

-- Create default server structure trigger (only for local servers)
CREATE OR REPLACE FUNCTION public.trigger_create_default_server_structure()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.is_local_server = true THEN
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
SET search_path = public
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

-- Prevent deletion of protected roles (allows cascade when server is deleted)
CREATE OR REPLACE FUNCTION public.prevent_protected_role_deletion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM servers WHERE id = OLD.server_id) THEN
        RETURN OLD;
    END IF;

    IF OLD.is_admin = true THEN
        RAISE EXCEPTION 'Cannot delete the Admin role. This role is protected.';
    END IF;

    IF OLD.is_default = true THEN
        RAISE EXCEPTION 'Cannot delete the @everyone role. This role is protected.';
    END IF;

    RETURN OLD;
END;
$$;

-- ---------------------------------------------------------------------------
-- TIMELINE TRIGGERS
-- ---------------------------------------------------------------------------

-- Add posts to timeline when created (optimized: bulk INSERT ... SELECT instead of loops)
CREATE OR REPLACE FUNCTION public.create_comprehensive_timeline_entries()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    
    -- Add to followers' home timelines based on visibility (bulk)
    IF NEW.visibility = 'public' THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT f.follower_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000
        FROM follows f
        JOIN profiles p ON f.follower_id = p.id
        WHERE f.following_id = NEW.author_id
          AND f.status IN ('accepted', 'pending')
          AND p.is_local = true
          AND f.follower_id != NEW.author_id
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    ELSIF NEW.visibility IN ('unlisted', 'followers') THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT f.follower_id, NEW.id, 'home', EXTRACT(epoch FROM NEW.created_at) * 1000000
        FROM follows f
        JOIN profiles p ON f.follower_id = p.id
        WHERE f.following_id = NEW.author_id
          AND f.status = 'accepted'
          AND p.is_local = true
          AND f.follower_id != NEW.author_id
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END IF;
    
    -- Add public posts to public timeline for all local users (bulk)
    IF NEW.visibility = 'public' THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT p.id, NEW.id, 'public', EXTRACT(epoch FROM NEW.created_at) * 1000000
        FROM profiles p
        WHERE p.is_local = true
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Add existing posts to new follower's timeline (optimized: bulk INSERT ... SELECT)
CREATE OR REPLACE FUNCTION public.add_existing_posts_to_new_follower_timeline()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.status = 'pending' THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT NEW.follower_id, sub.id, 'home', EXTRACT(epoch FROM sub.created_at) * 1000000
        FROM (
            SELECT p.id, p.created_at
            FROM posts p
            WHERE p.author_id = NEW.following_id
              AND p.visibility = 'public'
              AND NOT COALESCE(p.is_deleted, false)
              AND p.created_at > NOW() - INTERVAL '7 days'
            ORDER BY p.created_at DESC
            LIMIT 50
        ) sub
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    ELSIF NEW.status = 'accepted' THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT NEW.follower_id, sub.id, 'home', EXTRACT(epoch FROM sub.created_at) * 1000000
        FROM (
            SELECT p.id, p.created_at
            FROM posts p
            WHERE p.author_id = NEW.following_id
              AND p.visibility IN ('public', 'unlisted')
              AND NOT COALESCE(p.is_deleted, false)
              AND p.created_at > NOW() - INTERVAL '7 days'
            ORDER BY p.created_at DESC
            LIMIT 50
        ) sub
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Backfill timeline on follow acceptance (optimized: bulk INSERT ... SELECT)
CREATE OR REPLACE FUNCTION public.backfill_timeline_on_follow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Only for local followers
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = NEW.follower_id AND is_local = true) THEN
        RETURN NEW;
    END IF;
    
    -- When follow becomes accepted, add unlisted posts
    IF TG_OP = 'UPDATE' AND OLD.status = 'pending' AND NEW.status = 'accepted' THEN
        INSERT INTO timeline_entries (user_id, post_id, timeline_type, position)
        SELECT NEW.follower_id, sub.id, 'home', EXTRACT(epoch FROM sub.created_at) * 1000000
        FROM (
            SELECT p.id, p.created_at
            FROM posts p
            WHERE p.author_id = NEW.following_id
              AND p.visibility = 'unlisted'
              AND NOT COALESCE(p.is_deleted, false)
              AND p.created_at > NOW() - INTERVAL '7 days'
            ORDER BY p.created_at DESC
            LIMIT 50
        ) sub
        ON CONFLICT (user_id, post_id, timeline_type) DO NOTHING;
    END IF;
    
    RETURN NEW;
END;
$$;

-- Remove timeline entries on unfollow
CREATE OR REPLACE FUNCTION public.remove_timeline_on_unfollow()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    DELETE FROM timeline_entries
    WHERE user_id = OLD.follower_id
      AND post_id IN (SELECT id FROM posts WHERE author_id = OLD.following_id)
      AND timeline_type = 'home';
    
    RETURN OLD;
END;
$$;

-- Maintain denormalized followers_count / following_count on profiles.
-- Only follows with status = 'accepted' contribute (Mastodon / Pleroma /
-- GoToSocial all do this).
CREATE OR REPLACE FUNCTION public.update_follow_counts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_was_accepted boolean := false;
  v_is_accepted  boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_is_accepted  := (NEW.status = 'accepted');
  ELSIF TG_OP = 'UPDATE' THEN
    v_was_accepted := (OLD.status = 'accepted');
    v_is_accepted  := (NEW.status = 'accepted');
  ELSE
    v_was_accepted := (OLD.status = 'accepted');
  END IF;

  IF v_was_accepted = v_is_accepted THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_is_accepted THEN
    UPDATE public.profiles
       SET following_count = COALESCE(following_count, 0) + 1
     WHERE id = NEW.follower_id;
    UPDATE public.profiles
       SET followers_count = COALESCE(followers_count, 0) + 1
     WHERE id = NEW.following_id;
  ELSE
    UPDATE public.profiles
       SET following_count = GREATEST(COALESCE(following_count, 0) - 1, 0)
     WHERE id = COALESCE(NEW.follower_id, OLD.follower_id);
    UPDATE public.profiles
       SET followers_count = GREATEST(COALESCE(followers_count, 0) - 1, 0)
     WHERE id = COALESCE(NEW.following_id, OLD.following_id);
  END IF;

  RETURN COALESCE(NEW, OLD);
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
SET search_path = public
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
SET search_path = public
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

-- Extract hashtags from JSONB content - handles both MessagePart format and #text
CREATE OR REPLACE FUNCTION public.extract_hashtags_from_content(p_content jsonb)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  hashtags TEXT[] := ARRAY[]::TEXT[];
  item JSONB;
  text_content TEXT;
  hashtag_text TEXT;
  match_record RECORD;
  result TEXT[];
BEGIN
  IF p_content IS NULL OR jsonb_typeof(p_content) != 'array' THEN
    RETURN ARRAY[]::TEXT[];
  END IF;

  FOR item IN SELECT * FROM jsonb_array_elements(p_content)
  LOOP
    IF item->>'type' = 'hashtag' THEN
      hashtag_text := COALESCE(
        item->>'name',
        item->>'hashtag',
        item->>'normalized'
      );
      IF hashtag_text IS NOT NULL AND hashtag_text != '' THEN
        hashtag_text := regexp_replace(hashtag_text, '^#', '');
        hashtags := array_append(hashtags, lower(hashtag_text));
      END IF;
    ELSIF item->>'type' = 'text' THEN
      text_content := item->>'text';
      IF text_content IS NOT NULL THEN
        FOR match_record IN SELECT (regexp_matches(text_content, '#([a-zA-Z0-9_]+)', 'g'))[1] as tag
        LOOP
          IF match_record.tag IS NOT NULL THEN
            hashtags := array_append(hashtags, lower(match_record.tag));
          END IF;
        END LOOP;
      END IF;
    END IF;
  END LOOP;

  SELECT COALESCE(array_agg(DISTINCT t), ARRAY[]::TEXT[])
  INTO result
  FROM unnest(hashtags) t
  WHERE t IS NOT NULL;

  RETURN COALESCE(result, ARRAY[]::TEXT[]);
END;
$$;

COMMENT ON FUNCTION public.extract_hashtags_from_content(jsonb) IS
'Extract hashtags from JSONB content array. Handles both hashtag-type MessageParts and #text patterns.';

-- Insert or update hashtag, return ID
CREATE OR REPLACE FUNCTION public.upsert_hashtag(p_tag text)
RETURNS uuid
LANGUAGE plpgsql
AS $$
DECLARE
  v_hashtag_id uuid;
  v_normalized_tag text;
BEGIN
  v_normalized_tag := lower(trim(regexp_replace(p_tag, '^#', '')));

  SELECT id INTO v_hashtag_id
  FROM public.hashtags
  WHERE normalized_tag = v_normalized_tag;

  IF v_hashtag_id IS NULL THEN
    INSERT INTO public.hashtags (tag, normalized_tag, total_uses, daily_uses, first_used_at, last_used_at)
    VALUES (v_normalized_tag, v_normalized_tag, 1, 1, NOW(), NOW())
    ON CONFLICT (normalized_tag) DO UPDATE
    SET
      total_uses = hashtags.total_uses + 1,
      daily_uses = COALESCE(hashtags.daily_uses, 0) + 1,
      last_used_at = NOW()
    RETURNING id INTO v_hashtag_id;
  ELSE
    UPDATE public.hashtags
    SET
      total_uses = total_uses + 1,
      daily_uses = COALESCE(daily_uses, 0) + 1,
      last_used_at = NOW()
    WHERE id = v_hashtag_id;
  END IF;

  RETURN v_hashtag_id;
END;
$$;

COMMENT ON FUNCTION public.upsert_hashtag(text) IS
'Insert or update a hashtag and return its ID. Updates usage counts on conflict.';

-- Process post content to extract and link hashtags
CREATE OR REPLACE FUNCTION public.process_post_hashtags(p_post_id uuid, p_content jsonb)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    v_hashtag_array TEXT[];
    v_hashtag_text TEXT;
    v_hashtag_id UUID;
    v_position_counter INTEGER := 0;
    v_processed_count INTEGER := 0;
BEGIN
    v_hashtag_array := public.extract_hashtags_from_content(p_content);

    IF v_hashtag_array IS NULL THEN
        v_hashtag_array := ARRAY[]::TEXT[];
    END IF;

    IF array_length(v_hashtag_array, 1) IS NULL OR array_length(v_hashtag_array, 1) = 0 THEN
        RETURN 0;
    END IF;

    FOREACH v_hashtag_text IN ARRAY v_hashtag_array LOOP
        v_position_counter := v_position_counter + 1;
        v_hashtag_id := public.upsert_hashtag(v_hashtag_text);

        INSERT INTO public.post_hashtags (post_id, hashtag_id, position_in_content)
        VALUES (p_post_id, v_hashtag_id, v_position_counter)
        ON CONFLICT (post_id, hashtag_id) DO NOTHING;

        v_processed_count := v_processed_count + 1;
    END LOOP;

    RETURN v_processed_count;
END;
$$;

COMMENT ON FUNCTION public.process_post_hashtags(uuid, jsonb) IS
'Process post content to extract and link hashtags. Returns count of hashtags processed.';

-- Extract hashtags from post content (trigger - delegates to process_post_hashtags)
CREATE OR REPLACE FUNCTION public.trigger_extract_post_hashtags()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.content IS NOT NULL AND jsonb_typeof(NEW.content) = 'array' THEN
    PERFORM public.process_post_hashtags(NEW.id, NEW.content);
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
SET search_path = public
AS $$
BEGIN
    -- Skip remote posts (they came from federation, don't re-federate)
    IF NEW.is_local = false THEN
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
SET search_path = public
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
SET search_path = public
AS $$
BEGIN
    -- Bookmarks are private/local-only; never federate them
    IF TG_OP = 'INSERT' AND NEW.interaction_type = 'bookmark' THEN
        NEW.federation_status := 'skipped';
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' AND OLD.interaction_type = 'bookmark' THEN
        RETURN OLD;
    END IF;

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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

    PERFORM public.queue_federation_job(
        'federate-profile',
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
        3, 5, 3600
    );

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Thread message handler: auto-add member, update thread stats
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.thread_message_handler()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.thread_id IS NOT NULL THEN
        INSERT INTO public.thread_members (thread_id, user_id)
        VALUES (NEW.thread_id, NEW.user_id)
        ON CONFLICT (thread_id, user_id) DO NOTHING;

        UPDATE public.threads
        SET
            message_count = message_count + 1,
            last_message_id = NEW.id,
            last_message_at = NEW.created_at,
            updated_at = NOW(),
            archived = CASE WHEN locked THEN archived ELSE false END,
            archived_at = CASE WHEN locked THEN archived_at ELSE NULL END
        WHERE id = NEW.thread_id;

        UPDATE public.threads t
        SET member_count = (
            SELECT COUNT(*) FROM public.thread_members tm WHERE tm.thread_id = t.id
        )
        WHERE t.id = NEW.thread_id;
    END IF;
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Thread message delete handler: decrement count, update last message
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.thread_message_delete_handler()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF OLD.thread_id IS NOT NULL THEN
        UPDATE public.threads
        SET message_count = GREATEST(0, message_count - 1)
        WHERE id = OLD.thread_id;

        UPDATE public.threads t
        SET
            last_message_id = (
                SELECT id FROM public.messages
                WHERE thread_id = t.id AND NOT is_deleted
                ORDER BY created_at DESC LIMIT 1
            ),
            last_message_at = (
                SELECT created_at FROM public.messages
                WHERE thread_id = t.id AND NOT is_deleted
                ORDER BY created_at DESC LIMIT 1
            )
        WHERE t.id = OLD.thread_id;
    END IF;
    RETURN OLD;
END;
$$;

-- Queue thread creation/updates for federation
CREATE OR REPLACE FUNCTION public.trigger_queue_thread_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_creator_is_local BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Threads with ap_id already set came from federation (stub or ChatThread)
        IF NEW.ap_id IS NOT NULL THEN
            NEW.federation_status := 'synced';
            RETURN NEW;
        END IF;

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
SET search_path = public
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
SET search_path = public
AS $$
BEGIN
    IF NEW.conversation_id IS NOT NULL
       AND NOT (NEW.metadata ? 'federated')
       AND NOT (COALESCE(NEW.is_system, false) = true)
    THEN
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
SET search_path = public
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
SET search_path = public
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

-- Queue DM reaction for federation (conversation messages only; channel
-- reactions are handled exclusively by trigger_queue_channel_reaction_federation).
CREATE OR REPLACE FUNCTION public.trigger_queue_message_reaction_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_dm BOOLEAN;
BEGIN
    IF NEW.metadata ? 'federated' THEN RETURN NEW; END IF;

    SELECT (conversation_id IS NOT NULL) INTO v_is_dm
    FROM public.messages WHERE id = NEW.message_id;
    IF v_is_dm IS NOT TRUE THEN RETURN NEW; END IF;

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

-- Queue DM reaction removal for federation (OLD-based; bound to AFTER DELETE).
CREATE OR REPLACE FUNCTION public.trigger_queue_message_reaction_delete_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_is_dm BOOLEAN;
BEGIN
    IF OLD.metadata ? 'federated' THEN RETURN OLD; END IF;

    SELECT (conversation_id IS NOT NULL) INTO v_is_dm
    FROM public.messages WHERE id = OLD.message_id;
    IF v_is_dm IS NOT TRUE THEN RETURN OLD; END IF;

    PERFORM public.queue_federation_job(
        'federate-message-reaction',
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

-- Broadcast message/DM reaction changes to the per-context message topic.
-- Replaces the reactions postgres_changes (CDC) subscription: clients receive
-- a compact reaction_event on the SAME private channel they already use for
-- message delivery (channel-messages-{id} / dm-conversation-{id}).
CREATE OR REPLACE FUNCTION public.broadcast_message_reaction_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_rec             record;
  v_channel_id      uuid;
  v_conversation_id uuid;
  v_topic           text;
  v_actor           record;
  v_emoji_name      text;
  v_emoji_url       text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_rec := OLD;
  ELSE
    v_rec := NEW;
  END IF;

  v_channel_id := v_rec.channel_id;
  v_conversation_id := v_rec.conversation_id;

  IF v_channel_id IS NULL AND v_conversation_id IS NULL THEN
    SELECT channel_id, conversation_id
      INTO v_channel_id, v_conversation_id
    FROM public.messages WHERE id = v_rec.message_id;
  END IF;

  IF v_conversation_id IS NOT NULL THEN
    v_topic := 'dm-conversation-' || v_conversation_id::text;
  ELSIF v_channel_id IS NOT NULL THEN
    v_topic := 'channel-messages-' || v_channel_id::text;
  ELSE
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT username, display_name, avatar_url
    INTO v_actor
  FROM public.profiles WHERE id = v_rec.user_id;

  -- Custom emoji name/url so a new chip renders correctly even when the
  -- receiver hasn't cached this emoji (e.g. cross-server / federated / bridged).
  IF v_rec.emoji_id IS NOT NULL THEN
    SELECT name, url INTO v_emoji_name, v_emoji_url
    FROM public.emojis WHERE id = v_rec.emoji_id;
  ELSE
    v_emoji_name := COALESCE(v_rec.metadata->>'remote_emoji_name', v_rec.custom_emoji_content);
    v_emoji_url := v_rec.metadata->>'remote_emoji_url';
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type',                 'reaction:' || lower(TG_OP),
      'op',                   TG_OP,
      'reaction_id',          v_rec.id,
      'message_id',           v_rec.message_id,
      'emoji_id',             v_rec.emoji_id,
      'emoji_name',           v_emoji_name,
      'emoji_url',            v_emoji_url,
      'custom_emoji_content', v_rec.custom_emoji_content,
      'user_id',              v_rec.user_id,
      'bot_id',               v_rec.bot_id,
      'metadata',             COALESCE(v_rec.metadata, '{}'::jsonb),
      'username',             COALESCE(
                                v_rec.metadata->'discord_user'->>'username',
                                v_actor.username
                              ),
      'display_name',         COALESCE(
                                v_rec.metadata->'discord_user'->>'display_name',
                                v_rec.metadata->'discord_user'->>'username',
                                v_actor.display_name
                              ),
      'avatar_url',           COALESCE(
                                v_rec.metadata->'discord_user'->>'avatar_url',
                                v_actor.avatar_url
                              )
    ),
    'reaction_event',
    v_topic,
    true
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'broadcast_message_reaction_event failed: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Queue channel message edit for federation
-- Local servers: federate ALL edits (including edits to federated messages by mods)
-- Non-local servers: federate only local authors' non-federated messages (own edits)
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_edit_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_federation_enabled BOOLEAN;
    v_author_is_local BOOLEAN;
BEGIN
    IF current_setting('harmony.silent_content_update', true) = 'true' THEN
        RETURN NEW;
    END IF;

    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF OLD.content IS NOT DISTINCT FROM NEW.content THEN RETURN NEW; END IF;

        SELECT c.server_id, s.is_local_server, s.federation_enabled
        INTO v_server_id, v_server_is_local, v_federation_enabled
        FROM public.channels c JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        IF v_server_is_local IS TRUE THEN
            -- Authoritative server: federate all edits if federation enabled
            IF v_federation_enabled IS NOT TRUE THEN RETURN NEW; END IF;
        ELSE
            -- Mirror server: only federate local author's own non-federated edits
            IF NEW.metadata ? 'federated' THEN RETURN NEW; END IF;
            SELECT is_local INTO v_author_is_local FROM public.profiles WHERE id = NEW.user_id;
            IF v_author_is_local IS NOT TRUE THEN RETURN NEW; END IF;
        END IF;

        PERFORM public.queue_federation_job(
            'federate-channel-message-edit',
            jsonb_build_object(
                'type', 'update',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id,
                'server_id', v_server_id,
                'server_is_local', COALESCE(v_server_is_local, true)
            ), 5, 5, 900
        );
    END IF;
    RETURN NEW;
END;
$$;

-- Queue channel message delete for federation
-- Local servers: federate ALL deletes (including mod deletes of remote users' messages)
-- Non-local servers: federate only local authors' non-federated messages (own deletes)
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_message_delete_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_federation_enabled BOOLEAN;
    v_author_is_local BOOLEAN;
BEGIN
    IF NEW.channel_id IS NOT NULL AND NEW.conversation_id IS NULL THEN
        IF OLD.is_deleted = TRUE OR NEW.is_deleted = FALSE THEN RETURN NEW; END IF;

        SELECT c.server_id, s.is_local_server, s.federation_enabled
        INTO v_server_id, v_server_is_local, v_federation_enabled
        FROM public.channels c JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        IF v_server_is_local IS TRUE THEN
            -- Authoritative server: federate all deletes if federation enabled
            IF v_federation_enabled IS NOT TRUE THEN RETURN NEW; END IF;
        ELSE
            -- Mirror server: only federate local author's own non-federated deletes
            IF NEW.metadata ? 'federated' THEN RETURN NEW; END IF;
            SELECT is_local INTO v_author_is_local FROM public.profiles WHERE id = NEW.user_id;
            IF v_author_is_local IS NOT TRUE THEN RETURN NEW; END IF;
        END IF;

        PERFORM public.queue_federation_job(
            'federate-channel-message-delete',
            jsonb_build_object(
                'type', 'delete',
                'message_id', NEW.id,
                'channel_id', NEW.channel_id,
                'user_id', NEW.user_id,
                'ap_id', NEW.metadata->>'ap_id',
                'server_id', v_server_id,
                'server_is_local', COALESCE(v_server_is_local, true)
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
SET search_path = public
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
SET search_path = public
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

-- Queue channel CRUD for federation (real-time, complements sweep)
CREATE OR REPLACE FUNCTION public.trigger_queue_channel_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_server_is_local boolean;
    v_federation_enabled boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        SELECT s.is_local_server, s.federation_enabled
        INTO v_server_is_local, v_federation_enabled
        FROM servers s WHERE s.id = OLD.server_id;

        IF v_server_is_local IS NOT TRUE OR v_federation_enabled IS NOT TRUE THEN
            RETURN OLD;
        END IF;

        PERFORM public.queue_federation_job(
            'federate-channel-crud',
            jsonb_build_object('type', 'delete', 'channel_id', OLD.id, 'server_id', OLD.server_id),
            5, 5, 900
        );
        RETURN OLD;
    END IF;

    IF NEW.is_remote THEN
        NEW.federation_status := 'skipped';
        RETURN NEW;
    END IF;

    SELECT s.is_local_server, s.federation_enabled
    INTO v_server_is_local, v_federation_enabled
    FROM servers s WHERE s.id = NEW.server_id;

    IF v_server_is_local IS NOT TRUE OR v_federation_enabled IS NOT TRUE THEN
        NEW.federation_status := 'skipped';
        RETURN NEW;
    END IF;

    -- Skip re-federation when only federation_status changed (prevents infinite loop)
    IF TG_OP = 'UPDATE' AND
       OLD.name          IS NOT DISTINCT FROM NEW.name AND
       OLD.description   IS NOT DISTINCT FROM NEW.description AND
       OLD.type          IS NOT DISTINCT FROM NEW.type AND
       OLD.category      IS NOT DISTINCT FROM NEW.category AND
       OLD.server_id     IS NOT DISTINCT FROM NEW.server_id AND
       OLD."order"       IS NOT DISTINCT FROM NEW."order" AND
       OLD.slowmode_seconds IS NOT DISTINCT FROM NEW.slowmode_seconds AND
       OLD.ap_id         IS NOT DISTINCT FROM NEW.ap_id
    THEN
        RETURN NEW;
    END IF;

    NEW.federation_status := 'queued';
    PERFORM public.queue_federation_job(
        'federate-channel-crud',
        jsonb_build_object(
            'type', CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
            'channel_id', NEW.id,
            'server_id', NEW.server_id
        ),
        5, 5, 900
    );
    RETURN NEW;
END;
$$;

-- Queue category CRUD for federation (real-time, complements sweep)
CREATE OR REPLACE FUNCTION public.trigger_queue_category_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_server_is_local boolean;
    v_federation_enabled boolean;
BEGIN
    IF TG_OP = 'DELETE' THEN
        SELECT s.is_local_server, s.federation_enabled
        INTO v_server_is_local, v_federation_enabled
        FROM servers s WHERE s.id = OLD.server_id;

        IF v_server_is_local IS NOT TRUE OR v_federation_enabled IS NOT TRUE THEN
            RETURN OLD;
        END IF;

        PERFORM public.queue_federation_job(
            'federate-category-crud',
            jsonb_build_object('type', 'delete', 'category_id', OLD.id, 'server_id', OLD.server_id),
            5, 5, 900
        );
        RETURN OLD;
    END IF;

    SELECT s.is_local_server, s.federation_enabled
    INTO v_server_is_local, v_federation_enabled
    FROM servers s WHERE s.id = NEW.server_id;

    IF v_server_is_local IS NOT TRUE OR v_federation_enabled IS NOT TRUE THEN
        NEW.federation_status := 'skipped';
        RETURN NEW;
    END IF;

    -- Skip re-federation when only federation_status changed (prevents infinite loop)
    IF TG_OP = 'UPDATE' AND
       OLD.name      IS NOT DISTINCT FROM NEW.name AND
       OLD."order"   IS NOT DISTINCT FROM NEW."order" AND
       OLD.server_id IS NOT DISTINCT FROM NEW.server_id
    THEN
        RETURN NEW;
    END IF;

    NEW.federation_status := 'queued';
    PERFORM public.queue_federation_job(
        'federate-category-crud',
        jsonb_build_object(
            'type', CASE WHEN TG_OP = 'INSERT' THEN 'create' ELSE 'update' END,
            'category_id', NEW.id,
            'server_id', NEW.server_id
        ),
        5, 5, 900
    );
    RETURN NEW;
END;
$$;

-- Queue server updates for federation (real-time, complements sweep)
CREATE OR REPLACE FUNCTION public.trigger_queue_server_update_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.is_local_server IS NOT TRUE OR NEW.federation_enabled IS NOT TRUE THEN
        RETURN NEW;
    END IF;

    IF OLD.name IS NOT DISTINCT FROM NEW.name
       AND OLD.description IS NOT DISTINCT FROM NEW.description
       AND OLD.icon IS NOT DISTINCT FROM NEW.icon
       AND OLD.banner IS NOT DISTINCT FROM NEW.banner
       AND OLD.public IS NOT DISTINCT FROM NEW.public
       AND OLD.federation_enabled IS NOT DISTINCT FROM NEW.federation_enabled
    THEN
        RETURN NEW;
    END IF;

    PERFORM public.queue_federation_job(
        'federate-server-update',
        jsonb_build_object('type', 'update', 'server_id', NEW.id),
        5, 5, 900
    );
    RETURN NEW;
END;
$$;

-- Queue voice join/leave for federation
CREATE OR REPLACE FUNCTION public.trigger_queue_voice_channel_join_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_server servers%ROWTYPE;
BEGIN
    SELECT * INTO v_server FROM servers WHERE id = NEW.server_id;

    IF v_server IS NULL OR NOT v_server.federation_enabled THEN
        RETURN NEW;
    END IF;

    PERFORM public.queue_federation_job(
        'federate-voice-join',
        jsonb_build_object(
            'channel_id', NEW.channel_id,
            'server_id', NEW.server_id,
            'user_id', NEW.user_id
        ),
        5, 3, 1800
    );

    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Voice join federation trigger failed: %', SQLERRM;
        RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trigger_queue_voice_channel_leave_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_server servers%ROWTYPE;
BEGIN
    SELECT * INTO v_server FROM servers WHERE id = OLD.server_id;

    IF v_server IS NULL OR NOT v_server.federation_enabled THEN
        RETURN OLD;
    END IF;

    PERFORM public.queue_federation_job(
        'federate-voice-leave',
        jsonb_build_object(
            'channel_id', OLD.channel_id,
            'server_id', OLD.server_id,
            'user_id', OLD.user_id
        ),
        5, 3, 1800
    );

    RETURN OLD;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Voice leave federation trigger failed: %', SQLERRM;
        RETURN OLD;
END;
$$;

-- Route server membership changes
CREATE OR REPLACE FUNCTION public.route_server_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_setting('harmony.skip_leave_message', true) = '1' THEN
        RETURN OLD;
    END IF;

    IF current_setting('harmony.account_delete', true) = '1' THEN
        RETURN OLD;
    END IF;

    -- Profile account deletion cascades user_servers rows after the profile
    -- row is gone; skip the audit event (no valid user_id FK target).
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = OLD.user_id) THEN
        RETURN OLD;
    END IF;

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
SET search_path = public
AS $$
BEGIN
    -- Handled by other triggers
    RETURN NEW;
END;
$$;

-- Classify a message for notification routing
CREATE OR REPLACE FUNCTION public.determine_message_federation_type(p_message_id uuid)
RETURNS text
LANGUAGE plpgsql STABLE
AS $$
DECLARE
  v_channel_id UUID;
  v_conversation_id UUID;
  v_remote_participant_count INTEGER := 0;
BEGIN
  SELECT channel_id, conversation_id
  INTO v_channel_id, v_conversation_id
  FROM messages
  WHERE id = p_message_id;

  IF v_channel_id IS NOT NULL THEN
    RETURN 'chat_local_only';
  ELSIF v_conversation_id IS NOT NULL THEN
    SELECT COUNT(DISTINCT cp.user_id)
    INTO v_remote_participant_count
    FROM conversation_participants cp
    JOIN profiles p ON cp.user_id = p.id
    WHERE cp.conversation_id = v_conversation_id
      AND NOT p.is_local
      AND cp.left_at IS NULL;

    IF v_remote_participant_count > 0 THEN
      RETURN 'dm_federated';
    ELSE
      RETURN 'dm_local_only';
    END IF;
  END IF;

  RETURN 'unknown';
END;
$$;

-- Canonical web handle and notification actor payload (includes handle field).
CREATE OR REPLACE FUNCTION public.profile_web_handle(
  p_username text,
  p_domain text,
  p_is_local boolean
) RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- Mirrors the profiles.web_handle generated column. Falls back to the bare
  -- '@username' when a remote profile has no resolvable domain so we never emit
  -- a NULL handle (string || NULL = NULL in SQL).
  SELECT CASE
    WHEN COALESCE(p_is_local, true) THEN '@' || p_username
    ELSE '@' || p_username || COALESCE(
      '@' || NULLIF(p_domain, ''),
      '@' || NULLIF(current_setting('app.domain', true), ''),
      ''
    )
  END;
$$;

CREATE OR REPLACE FUNCTION public.notification_actor_json(
  p_id uuid,
  p_username text,
  p_display_name text,
  p_avatar_url text,
  p_domain text,
  p_is_local boolean
) RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id', p_id,
    'user_id', p_id,
    'username', p_username,
    'display_name', COALESCE(p_display_name, p_username),
    'avatar_url', p_avatar_url,
    'domain', p_domain,
    'is_local', COALESCE(p_is_local, true),
    'handle', public.profile_web_handle(p_username, p_domain, p_is_local)
  );
$$;

CREATE OR REPLACE FUNCTION public.notification_actor_json(p public.profiles)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT public.notification_actor_json(
    p.id, p.username, p.display_name, p.avatar_url, p.domain, p.is_local
  );
$$;

CREATE OR REPLACE FUNCTION public.resolve_mention_profile_id(
  p_part jsonb,
  p_sender_user_id uuid,
  p_current_domain text
) RETURNS uuid
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_username text;
  v_domain text;
BEGIN
  IF p_part->>'type' IS DISTINCT FROM 'mention' THEN
    RETURN NULL;
  END IF;

  -- Structured userId from bridge slash commands / clients
  IF (p_part->>'userId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    SELECT id INTO v_user_id
    FROM profiles
    WHERE id = (p_part->>'userId')::uuid
      AND (p_sender_user_id IS NULL OR id <> p_sender_user_id);
    IF v_user_id IS NOT NULL THEN
      RETURN v_user_id;
    END IF;
  END IF;

  v_username := p_part->>'username';
  v_domain := p_part->>'domain';
  IF v_username IS NULL OR v_username = '' THEN
    RETURN NULL;
  END IF;

  IF v_domain IS NULL OR v_domain = p_current_domain THEN
    SELECT id INTO v_user_id
    FROM profiles
    WHERE username = v_username
      AND (domain IS NULL OR domain = p_current_domain)
      AND is_local = true
      AND (p_sender_user_id IS NULL OR id <> p_sender_user_id);
  ELSE
    SELECT id INTO v_user_id
    FROM profiles
    WHERE username = v_username
      AND domain = v_domain
      AND (p_sender_user_id IS NULL OR id <> p_sender_user_id);
  END IF;

  RETURN v_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.message_notification_sender_json(
  p_user_id uuid,
  p_bot_id uuid,
  p_metadata jsonb,
  p_sender_profile profiles
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_bot bots%ROWTYPE;
BEGIN
  IF p_user_id IS NOT NULL THEN
    RETURN notification_actor_json(p_sender_profile);
  END IF;

  IF p_metadata IS NOT NULL AND p_metadata ? 'discord_user' THEN
    RETURN jsonb_build_object(
      'username', p_metadata->'discord_user'->>'username',
      'display_name', COALESCE(
        p_metadata->'discord_user'->>'display_name',
        p_metadata->'discord_user'->>'username'
      ),
      'avatar_url', p_metadata->'discord_user'->>'avatar_url',
      'is_local', false,
      'handle', '@' || COALESCE(p_metadata->'discord_user'->>'username', 'discord')
    );
  END IF;

  IF p_bot_id IS NOT NULL THEN
    SELECT * INTO v_bot FROM bots WHERE id = p_bot_id;
    IF FOUND THEN
      RETURN jsonb_build_object(
        'username', v_bot.username,
        'display_name', COALESCE(v_bot.display_name, v_bot.username),
        'avatar_url', v_bot.avatar_url,
        'is_local', false,
        'handle', '@' || v_bot.username
      );
    END IF;
  END IF;

  RETURN '{}'::jsonb;
END;
$$;

-- Handle message federation - sends DM/group-chat/mention notifications
CREATE OR REPLACE FUNCTION public.handle_message_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
    v_sender_json jsonb;
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

    v_sender_json := message_notification_sender_json(
        NEW.user_id, NEW.bot_id, NEW.metadata, v_sender_profile
    );

    -- Channel mention notifications (includes federated messages)
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
                    mentioned_user_id := resolve_mention_profile_id(
                        content_part, NEW.user_id, current_domain
                    );

                    IF mentioned_user_id IS NOT NULL THEN
                        PERFORM send_notification_to_user(
                            'mention',
                            mentioned_user_id,
                            jsonb_build_object(
                                'sender', v_sender_json,
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
                                'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
                                'sender_display_name', COALESCE(
                                    v_sender_json->>'display_name',
                                    v_sender_profile.display_name
                                ),
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
                    AND (NEW.user_id IS NULL OR cp.user_id <> NEW.user_id)
                    AND cp.left_at IS NULL
                    AND p.is_local = true
                ),
                jsonb_build_object(
                    'sender', v_sender_json,
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', content_preview
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    'message_id', NEW.id,
                    'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
                    'sender_display_name', COALESCE(
                        v_sender_json->>'display_name',
                        v_sender_profile.display_name
                    ),
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
                    AND (NEW.user_id IS NULL OR cp.user_id <> NEW.user_id)
                    AND cp.left_at IS NULL
                    AND p.is_local = true
                ),
                jsonb_build_object(
                    'sender', v_sender_json,
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', content_preview
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    'message_id', NEW.id,
                    'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
                    'sender_display_name', COALESCE(
                        v_sender_json->>'display_name',
                        v_sender_profile.display_name
                    ),
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
                    AND (NEW.user_id IS NULL OR cp.user_id <> NEW.user_id)
                    AND cp.left_at IS NULL
                    AND p.is_local = true
                ),
                jsonb_build_object(
                    'sender', v_sender_json,
                    'message', jsonb_build_object(
                        'id', NEW.id,
                        'content_preview', content_preview
                    ),
                    'conversation', jsonb_build_object(
                        'id', NEW.conversation_id
                    ),
                    'message_id', NEW.id,
                    'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
                    'sender_display_name', COALESCE(
                        v_sender_json->>'display_name',
                        v_sender_profile.display_name
                    ),
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

-- Notify user when added to a GROUP conversation (local = notification, remote = federate invite).
-- Skips 1:1 DMs (type='direct') and the group creator.
CREATE OR REPLACE FUNCTION public.handle_conversation_participant_added()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_conversation conversations%ROWTYPE;
    v_inviter profiles%ROWTYPE;
    v_added_profile profiles%ROWTYPE;
    v_conversation_name TEXT;
BEGIN
    IF NEW.left_at IS NOT NULL THEN
        RETURN NEW;
    END IF;

    SELECT * INTO v_conversation FROM conversations WHERE id = NEW.conversation_id;

    -- Only notify for group conversations; 1:1 DMs (type='direct') need no invite notification.
    IF v_conversation.type != 'group' THEN
        RETURN NEW;
    END IF;

    -- Don't notify the creator of the group - they already know they created it.
    IF NEW.user_id = v_conversation.created_by THEN
        RETURN NEW;
    END IF;

    SELECT * INTO v_added_profile FROM profiles WHERE id = NEW.user_id;

    IF v_added_profile.is_local THEN
        v_conversation_name := COALESCE(NULLIF(TRIM(v_conversation.name), ''), 'a group conversation');

        SELECT p.* INTO v_inviter
        FROM conversation_participants cp
        JOIN profiles p ON p.id = cp.user_id
        WHERE cp.conversation_id = NEW.conversation_id AND cp.user_id != NEW.user_id AND cp.role = 'admin'
        ORDER BY cp.joined_at ASC LIMIT 1;

        PERFORM send_notification_to_user('dm', NEW.user_id,
            jsonb_build_object(
                'sender', jsonb_build_object('user_id', COALESCE(v_inviter.id, '00000000-0000-0000-0000-000000000000'),
                    'username', COALESCE(v_inviter.username, 'system'),
                    'display_name', COALESCE(v_inviter.display_name, v_inviter.username, 'System'),
                    'avatar_url', v_inviter.avatar_url),
                'conversation', jsonb_build_object('id', NEW.conversation_id, 'name', v_conversation_name),
                'conversation_id', NEW.conversation_id, 'preview', 'You were added to ' || v_conversation_name, 'is_invite', true),
            NULL, NULL, NEW.conversation_id, v_inviter.id, 'normal');
    ELSIF v_added_profile.inbox_url IS NOT NULL AND v_added_profile.inbox_url != '' THEN
        SELECT p.* INTO v_inviter
        FROM conversation_participants cp JOIN profiles p ON p.id = cp.user_id
        WHERE cp.conversation_id = NEW.conversation_id AND cp.user_id != NEW.user_id AND cp.role = 'admin'
        ORDER BY cp.joined_at ASC LIMIT 1;

        PERFORM public.queue_federation_job('federate-group-invite',
            jsonb_build_object('conversation_id', NEW.conversation_id,
                'inviter_id', COALESCE(v_inviter.id, (SELECT created_by FROM conversations WHERE id = NEW.conversation_id)),
                'invited_user_id', NEW.user_id),
            5, 5, 3600);
    END IF;

    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Conversation participant notification failed: %', SQLERRM;
        RETURN NEW;
END;
$$;

-- Queue federation when a participant leaves a group conversation
CREATE OR REPLACE FUNCTION public.handle_group_participant_left()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_conversation conversations%ROWTYPE;
BEGIN
    IF OLD.left_at IS NOT NULL OR NEW.left_at IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT * INTO v_conversation FROM conversations WHERE id = NEW.conversation_id;

    IF v_conversation.type != 'group' THEN
        RETURN NEW;
    END IF;

    PERFORM public.queue_federation_job(
        'federate-group-participant-change',
        jsonb_build_object(
            'conversation_id', NEW.conversation_id,
            'user_id', NEW.user_id,
            'change_type', 'left'
        ),
        5, 5, 3600
    );

    RETURN NEW;
EXCEPTION
    WHEN OTHERS THEN
        RAISE WARNING 'Group participant left federation failed: %', SQLERRM;
        RETURN NEW;
END;
$$;

-- Handle post federation
CREATE OR REPLACE FUNCTION public.handle_post_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
SET search_path = public
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
SET search_path = public
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
                                    'actor', notification_actor_json(
                                        author_profile.id,
                                        author_profile.username,
                                        author_profile.display_name,
                                        author_profile.avatar_url,
                                        author_profile.domain,
                                        author_profile.is_local
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
                                NULL, NULL, NULL,
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

-- Handle post mention notifications (all posts including federated)
CREATE OR REPLACE FUNCTION public.handle_post_mention_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    content_part JSONB;
    mentioned_username TEXT;
    mentioned_user_id UUID;
    author_profile RECORD;
    post_content_preview TEXT;
    reply_parent_author_id UUID;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- If this post is a reply, find the parent author so we can skip
        -- sending a duplicate mention notification (they already get a reply notification).
        IF NEW.in_reply_to IS NOT NULL THEN
            SELECT author_id INTO reply_parent_author_id
            FROM posts WHERE id = NEW.in_reply_to;
        END IF;

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
                            
                            -- Skip if the mentioned user is the parent post's author;
                            -- they already receive an activitypub_reply notification.
                            IF mentioned_user_id IS NOT NULL
                               AND mentioned_user_id IS DISTINCT FROM reply_parent_author_id THEN
                                PERFORM send_notification_to_user(
                                    'activitypub_mention',
                                    mentioned_user_id,
                                    jsonb_build_object(
                                        'actor', notification_actor_json(
                                            author_profile.id,
                                            author_profile.username,
                                            author_profile.display_name,
                                            author_profile.avatar_url,
                                            author_profile.domain,
                                            author_profile.is_local
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
                                    NULL, NULL, NULL,
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

-- Handle post reply notifications
CREATE OR REPLACE FUNCTION public.handle_post_reply_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
            'actor', notification_actor_json(
                replier_profile.id,
                replier_profile.username,
                replier_profile.display_name,
                replier_profile.avatar_url,
                replier_profile.domain,
                replier_profile.is_local
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
        NULL, NULL, NULL,
        NEW.author_id,
        'normal'
    );

    RETURN NEW;
END;
$$;

-- Handle remote user suspension
CREATE OR REPLACE FUNCTION public.handle_remote_user_suspension()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Remove from follows, etc.
    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Increment unread messages for server channel messages (skip muted channels)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_message_unread()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_server_id uuid;
BEGIN
    IF NEW.channel_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT server_id INTO v_server_id
    FROM public.channels WHERE id = NEW.channel_id;

    IF v_server_id IS NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.unread_counts (user_id, server_id, channel_id, unread_messages)
    SELECT us.user_id, v_server_id, NEW.channel_id, 1
    FROM public.user_servers us
    WHERE us.server_id = v_server_id
      AND us.status = 'accepted'
      AND (NEW.user_id IS NULL OR us.user_id <> NEW.user_id)
      AND NOT EXISTS (
          SELECT 1 FROM public.notification_channels nc
          WHERE nc.user_id = us.user_id
            AND nc.channel_id = NEW.channel_id
            AND nc.muted = true
            AND (nc.muted_until IS NULL OR nc.muted_until > NOW())
      )
    ON CONFLICT (user_id, channel_id) WHERE channel_id IS NOT NULL
    DO UPDATE SET
        unread_messages = unread_counts.unread_messages + 1,
        updated_at = now();

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Increment unread messages for DM/conversation messages
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_dm_unread()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.conversation_id IS NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.unread_counts (user_id, server_id, channel_id, conversation_id, unread_messages)
    SELECT cp.user_id, NULL, NULL, NEW.conversation_id, 1
    FROM public.conversation_participants cp
    WHERE cp.conversation_id = NEW.conversation_id
      AND cp.user_id != NEW.user_id
      AND cp.left_at IS NULL
      AND NOT EXISTS (
          SELECT 1 FROM public.notification_channels nc
          WHERE nc.user_id = cp.user_id
            AND nc.conversation_id = NEW.conversation_id
            AND nc.muted = true
            AND (nc.muted_until IS NULL OR nc.muted_until > NOW())
      )
    ON CONFLICT (user_id, conversation_id) WHERE conversation_id IS NOT NULL
    DO UPDATE SET
        unread_messages = unread_counts.unread_messages + 1,
        updated_at = now();

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Thread reply notification trigger function
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_thread_reply_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_thread record;
    v_sender record;
    v_channel_id uuid;
    v_server_id uuid;
    v_channel_name text;
    v_server_name text;
    content_preview text;
    v_member record;
BEGIN
    IF NEW.thread_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT t.id, t.parent_message_id, t.channel_id, t.created_by
    INTO v_thread
    FROM threads t WHERE t.id = NEW.thread_id;

    IF NOT FOUND THEN RETURN NEW; END IF;

    v_channel_id := v_thread.channel_id;

    SELECT c.server_id, c.name INTO v_server_id, v_channel_name
    FROM channels c WHERE c.id = v_channel_id;

    IF v_server_id IS NOT NULL THEN
        SELECT s.name INTO v_server_name FROM servers s WHERE s.id = v_server_id;
    END IF;

    SELECT p.id, p.username, p.display_name, p.avatar_url
    INTO v_sender FROM profiles p WHERE p.id = NEW.user_id;

    content_preview := extract_message_text(NEW.content);
    content_preview := TRIM(content_preview);
    IF LENGTH(content_preview) > 100 THEN
        content_preview := LEFT(content_preview, 100) || '...';
    END IF;
    IF content_preview = '' OR content_preview IS NULL THEN
        content_preview := 'New thread reply';
    END IF;

    FOR v_member IN
        SELECT tm.user_id
        FROM thread_members tm
        WHERE tm.thread_id = NEW.thread_id
          AND tm.user_id != NEW.user_id
          AND COALESCE(tm.muted, false) = false
    LOOP
        PERFORM send_notification_to_user(
            'thread_reply',
            v_member.user_id,
            jsonb_build_object(
                'sender', jsonb_build_object(
                    'user_id', v_sender.id,
                    'username', v_sender.username,
                    'display_name', v_sender.display_name,
                    'avatar_url', v_sender.avatar_url
                ),
                'message', jsonb_build_object(
                    'id', NEW.id,
                    'content_preview', content_preview
                ),
                'thread', jsonb_build_object(
                    'id', NEW.thread_id,
                    'parent_message_id', v_thread.parent_message_id
                ),
                'location', jsonb_build_object(
                    'server_id', v_server_id::text,
                    'server_name', v_server_name,
                    'channel_id', v_channel_id::text,
                    'channel_name', v_channel_name
                ),
                'message_id', NEW.id,
                'thread_id', NEW.thread_id,
                'server_id', v_server_id::text,
                'channel_id', v_channel_id::text,
                'preview', content_preview
            ),
            v_server_id,
            v_channel_id,
            NULL,
            NEW.user_id,
            'normal'
        );
    END LOOP;

    IF v_thread.created_by IS NOT NULL
       AND v_thread.created_by != NEW.user_id
       AND NOT EXISTS (
           SELECT 1 FROM thread_members
           WHERE thread_id = NEW.thread_id AND user_id = v_thread.created_by
       )
    THEN
        PERFORM send_notification_to_user(
            'thread_reply',
            v_thread.created_by,
            jsonb_build_object(
                'sender', jsonb_build_object(
                    'user_id', v_sender.id,
                    'username', v_sender.username,
                    'display_name', v_sender.display_name,
                    'avatar_url', v_sender.avatar_url
                ),
                'message', jsonb_build_object(
                    'id', NEW.id,
                    'content_preview', content_preview
                ),
                'thread', jsonb_build_object(
                    'id', NEW.thread_id,
                    'parent_message_id', v_thread.parent_message_id
                ),
                'location', jsonb_build_object(
                    'server_id', v_server_id::text,
                    'server_name', v_server_name,
                    'channel_id', v_channel_id::text,
                    'channel_name', v_channel_name
                ),
                'message_id', NEW.id,
                'thread_id', NEW.thread_id,
                'server_id', v_server_id::text,
                'channel_id', v_channel_id::text,
                'preview', content_preview
            ),
            v_server_id,
            v_channel_id,
            NULL,
            NEW.user_id,
            'normal'
        );
    END IF;

    RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Role mention notifications (@everyone, @role)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_role_mention_notifications()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_server_id uuid;
    v_channel_id uuid;
    v_channel_name text;
    v_server_name text;
    v_sender_profile profiles%ROWTYPE;
    v_sender_json jsonb;
    v_role_id uuid;
    v_role_is_default boolean;
    v_member_id uuid;
    content_part jsonb;
    content_preview text;
BEGIN
    IF NEW.channel_id IS NULL OR NEW.is_system THEN
        RETURN NEW;
    END IF;

    SELECT c.server_id, c.name INTO v_server_id, v_channel_name
    FROM channels c WHERE c.id = NEW.channel_id;
    IF v_server_id IS NULL THEN RETURN NEW; END IF;

    SELECT s.name INTO v_server_name FROM servers s WHERE s.id = v_server_id;

    IF jsonb_typeof(NEW.content) != 'array' THEN RETURN NEW; END IF;

    IF NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(NEW.content) elem
        WHERE elem->>'type' = 'role_mention'
    ) THEN
        RETURN NEW;
    END IF;

    SELECT * INTO v_sender_profile FROM profiles WHERE id = NEW.user_id;

    v_sender_json := message_notification_sender_json(
        NEW.user_id, NEW.bot_id, NEW.metadata, v_sender_profile
    );

    content_preview := LEFT(
        (SELECT string_agg(elem->>'text', ' ')
         FROM jsonb_array_elements(NEW.content) elem
         WHERE elem->>'type' = 'text'), 100);

    v_channel_id := NEW.channel_id;

    FOR content_part IN SELECT jsonb_array_elements(NEW.content)
    LOOP
        IF content_part->>'type' = 'role_mention' THEN
            v_role_id := (content_part->>'roleId')::uuid;
            IF v_role_id IS NULL THEN CONTINUE; END IF;

            SELECT is_default INTO v_role_is_default
            FROM server_roles WHERE id = v_role_id AND server_id = v_server_id;

            IF NOT FOUND THEN CONTINUE; END IF;

            IF v_role_is_default THEN
                FOR v_member_id IN
                    SELECT us.user_id FROM user_servers us
                    WHERE us.server_id = v_server_id
                      AND us.status = 'accepted'
                      AND (NEW.user_id IS NULL OR us.user_id <> NEW.user_id)
                LOOP
                    PERFORM send_notification_to_user(
                        'mention', v_member_id,
                        jsonb_build_object(
                            'sender', v_sender_json,
                            'message', jsonb_build_object('id', NEW.id, 'content_preview', content_preview),
                            'location', jsonb_build_object(
                                'server_id', v_server_id::text,
                                'server_name', v_server_name,
                                'channel_id', v_channel_id::text,
                                'channel_name', v_channel_name
                            ),
                            'message_id', NEW.id,
                            'mentioned_by', NEW.user_id,
                            'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
                            'sender_display_name', COALESCE(
                                v_sender_json->>'display_name',
                                v_sender_profile.display_name
                            ),
                            'server_id', v_server_id::text,
                            'server_name', v_server_name,
                            'channel_id', v_channel_id::text,
                            'channel_name', v_channel_name,
                            'preview', content_preview,
                            'is_role_mention', true,
                            'is_everyone', true
                        ),
                        v_server_id, v_channel_id, NULL, NEW.user_id, 'normal'
                    );
                END LOOP;
            ELSE
                FOR v_member_id IN
                    SELECT ur.user_id FROM user_roles ur
                    WHERE ur.role_id = v_role_id
                      AND ur.server_id = v_server_id
                      AND (NEW.user_id IS NULL OR ur.user_id <> NEW.user_id)
                LOOP
                    PERFORM send_notification_to_user(
                        'mention', v_member_id,
                        jsonb_build_object(
                            'sender', v_sender_json,
                            'message', jsonb_build_object('id', NEW.id, 'content_preview', content_preview),
                            'location', jsonb_build_object(
                                'server_id', v_server_id::text,
                                'server_name', v_server_name,
                                'channel_id', v_channel_id::text,
                                'channel_name', v_channel_name
                            ),
                            'message_id', NEW.id,
                            'mentioned_by', NEW.user_id,
                            'sender_username', COALESCE(v_sender_json->>'username', v_sender_profile.username),
                            'sender_display_name', COALESCE(
                                v_sender_json->>'display_name',
                                v_sender_profile.display_name
                            ),
                            'server_id', v_server_id::text,
                            'server_name', v_server_name,
                            'channel_id', v_channel_id::text,
                            'channel_name', v_channel_name,
                            'preview', content_preview,
                            'is_role_mention', true
                        ),
                        v_server_id, v_channel_id, NULL, NEW.user_id, 'normal'
                    );
                END LOOP;
            END IF;
        END IF;
    END LOOP;

    RETURN NEW;
END;
$$;

-- Increment unread mentions
CREATE OR REPLACE FUNCTION public.increment_unread_mentions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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

-- Index message for search
CREATE OR REPLACE FUNCTION public.index_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Placeholder for full-text search indexing
    RETURN NEW;
END;
$$;

-- Cleanup users with dead federation endpoints
CREATE OR REPLACE FUNCTION public.cleanup_dead_endpoint_users(p_endpoint_url text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NEW.is_dead = true AND (OLD.is_dead IS NULL OR OLD.is_dead = false) THEN
        PERFORM cleanup_dead_endpoint_users(NEW.endpoint_url);
    END IF;
    RETURN NEW;
END;
$$;

-- Process link previews (local Harmony URLs only, synchronous)
CREATE OR REPLACE FUNCTION public.process_local_link_previews()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
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
    v_is_local boolean;
BEGIN
    IF NEW.status IS NOT NULL AND NEW.status != 'accepted' THEN
        RETURN NEW;
    END IF;

    -- Only emit join messages for local servers, not remote server references
    SELECT is_local_server INTO v_is_local
    FROM servers
    WHERE id = NEW.server_id;

    IF v_is_local IS NOT TRUE THEN
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

-- ---------------------------------------------------------------------------
-- System message when a user leaves a server (mirror of the join message).
-- Skips kick/ban removals (those RPCs post their own message and set the
-- transaction-local `harmony.skip_leave_message` flag) and skips cascade
-- deletes when the whole server is removed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_member_leave_system_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel_id uuid;
    v_is_local boolean;
BEGIN
    -- A kick/ban already inserts "was kicked/banned" - don't also post "has left".
    IF current_setting('harmony.skip_leave_message', true) = '1' THEN
        RETURN OLD;
    END IF;

    IF current_setting('harmony.account_delete', true) = '1' THEN
        RETURN OLD;
    END IF;

    -- Profile account deletion cascades user_servers after the profile is gone.
    IF NOT EXISTS (SELECT 1 FROM profiles WHERE id = OLD.user_id) THEN
        RETURN OLD;
    END IF;

    -- Only emit for local servers, and skip cascade deletes (server gone).
    SELECT is_local_server INTO v_is_local
    FROM servers
    WHERE id = OLD.server_id;

    IF NOT FOUND OR v_is_local IS NOT TRUE THEN
        RETURN OLD;
    END IF;

    SELECT system_channel_id INTO v_channel_id
    FROM server_settings
    WHERE server_id = OLD.server_id;

    IF v_channel_id IS NULL THEN
        v_channel_id := get_default_channel(OLD.server_id);
    END IF;

    IF v_channel_id IS NULL THEN
        RETURN OLD;
    END IF;

    INSERT INTO messages (channel_id, user_id, content, is_system, metadata)
    VALUES (
        v_channel_id,
        OLD.user_id,
        jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'has left the server')),
        true,
        jsonb_build_object('type', 'member_leave')
    );

    RETURN OLD;
END;
$$;

-- =========================================================================
-- User Event Broadcast functions (Phase 1 scalability)
-- Push compact events to the user's broadcast channel via realtime.send(),
-- replacing per-table postgres_changes subscriptions.
-- =========================================================================

CREATE OR REPLACE FUNCTION public.broadcast_notification_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type', 'notification:new',
        'notification', jsonb_build_object(
          'id', NEW.id,
          'type', NEW.type,
          'data', NEW.data,
          'is_read', NEW.is_read,
          'is_clicked', NEW.is_clicked,
          'created_at', NEW.created_at,
          'updated_at', NEW.updated_at,
          'user_id', NEW.user_id,
          'expires_at', NEW.expires_at
        )
      ),
      'user_event',
      'user:' || NEW.user_id::text,
      true
    );
  ELSIF TG_OP = 'UPDATE' THEN
    IF OLD.is_read IS DISTINCT FROM NEW.is_read THEN
      PERFORM realtime.send(
        jsonb_build_object(
          'type', 'notification:update',
          'id', NEW.id,
          'is_read', NEW.is_read
        ),
        'user_event',
        'user:' || NEW.user_id::text,
        true
      );
    END IF;
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.broadcast_unread_count_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_record record;
  v_action text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_record := OLD;
    v_action := 'delete';
  ELSE
    v_record := NEW;
    v_action := 'upsert';
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type', 'unread:change',
      'action', v_action,
      'count', jsonb_build_object(
        'id', v_record.id,
        'user_id', v_record.user_id,
        'server_id', v_record.server_id,
        'channel_id', v_record.channel_id,
        'conversation_id', v_record.conversation_id,
        'unread_messages', v_record.unread_messages,
        'unread_mentions', v_record.unread_mentions,
        'last_read_at', v_record.last_read_at
      )
    ),
    'user_event',
    'user:' || v_record.user_id::text,
    true
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

-- =========================================================================
-- Phase 2: Expanded user event broadcast functions
-- =========================================================================

CREATE OR REPLACE FUNCTION public.broadcast_conversation_participant_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type', 'conversation:new',
        'conversation_id', NEW.conversation_id,
        'user_id', NEW.user_id
      ),
      'user_event',
      'user:' || NEW.user_id::text,
      true
    );
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.broadcast_user_server_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type', 'server:joined',
        'server_id', NEW.server_id,
        'user_id', NEW.user_id
      ),
      'user_event',
      'user:' || NEW.user_id::text,
      true
    );
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type', 'server:left',
        'server_id', OLD.server_id,
        'user_id', OLD.user_id
      ),
      'user_event',
      'user:' || OLD.user_id::text,
      true
    );
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.broadcast_server_change_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member_id uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    FOR v_member_id IN
      SELECT user_id FROM user_servers WHERE server_id = NEW.id
    LOOP
      PERFORM realtime.send(
        jsonb_build_object(
          'type', 'server:updated',
          'server', jsonb_build_object(
            'id', NEW.id,
            'name', NEW.name,
            'description', NEW.description,
            'icon', NEW.icon,
            'banner', NEW.banner,
            'public', NEW.public,
            'federation_enabled', NEW.federation_enabled,
            'updated_at', NEW.updated_at
          )
        ),
        'user_event',
        'user:' || v_member_id::text,
        true
      );
    END LOOP;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

-- Broadcast server settings changes to server-structure:{server_id} topic.
-- Covers server_encryption_settings and any future per-server settings tables.
CREATE OR REPLACE FUNCTION public.broadcast_server_settings_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object(
      'type', 'settings:' || lower(TG_OP),
      'table', TG_TABLE_NAME,
      'new', CASE WHEN TG_OP != 'DELETE' THEN to_jsonb(NEW) ELSE NULL END,
      'old', CASE WHEN TG_OP != 'INSERT' THEN to_jsonb(OLD) ELSE NULL END
    ),
    'server_event',
    'server-structure:' || NEW.server_id::text,
    true
  );
  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'broadcast_server_settings_change failed: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- =========================================================================
-- Server-structure broadcast functions (channels, categories, threads, etc.)
-- These send to server-structure:{server_id} with event "server_event".
-- Supabase handles fan-out - no SQL member loops (O(1) from DB).
-- =========================================================================

-- Channels INSERT/UPDATE/DELETE → server-structure:{server_id}
CREATE OR REPLACE FUNCTION public.broadcast_channel_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_server uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_server := OLD.server_id;
  ELSE
    v_server := NEW.server_id;
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type', 'channel:' || lower(TG_OP),
      'new', CASE WHEN TG_OP != 'DELETE' THEN to_jsonb(NEW) ELSE NULL END,
      'old', CASE WHEN TG_OP != 'INSERT' THEN to_jsonb(OLD) ELSE NULL END
    ),
    'server_event',
    'server-structure:' || v_server::text,
    true
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'broadcast_channel_change failed: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Channel categories INSERT/UPDATE/DELETE → server-structure:{server_id}
CREATE OR REPLACE FUNCTION public.broadcast_category_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_server uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_server := OLD.server_id;
  ELSE
    v_server := NEW.server_id;
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type', 'category:' || lower(TG_OP),
      'new', CASE WHEN TG_OP != 'DELETE' THEN to_jsonb(NEW) ELSE NULL END,
      'old', CASE WHEN TG_OP != 'INSERT' THEN to_jsonb(OLD) ELSE NULL END
    ),
    'server_event',
    'server-structure:' || v_server::text,
    true
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'broadcast_category_change failed: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Server membership events INSERT → server-structure:{server_id}
CREATE OR REPLACE FUNCTION public.broadcast_membership_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM realtime.send(
    jsonb_build_object(
      'type', 'membership:event',
      'new', to_jsonb(NEW)
    ),
    'server_event',
    'server-structure:' || NEW.server_id::text,
    true
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

-- Threads INSERT/UPDATE/DELETE → server-structure:{server_id} (via channel lookup)
CREATE OR REPLACE FUNCTION public.broadcast_thread_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_channel_id uuid;
  v_server_id  uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_channel_id := OLD.channel_id;
  ELSE
    v_channel_id := NEW.channel_id;
  END IF;

  SELECT server_id INTO v_server_id
  FROM channels
  WHERE id = v_channel_id;

  IF v_server_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type', 'thread:' || lower(TG_OP),
      'new', CASE WHEN TG_OP != 'DELETE' THEN to_jsonb(NEW) ELSE NULL END,
      'old', CASE WHEN TG_OP != 'INSERT' THEN to_jsonb(OLD) ELSE NULL END
    ),
    'server_event',
    'server-structure:' || v_server_id::text,
    true
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Server roles INSERT/UPDATE/DELETE → server-structure:{server_id}
CREATE OR REPLACE FUNCTION public.broadcast_role_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_server uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_server := OLD.server_id;
  ELSE
    v_server := NEW.server_id;
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type', 'role:' || lower(TG_OP),
      'new', CASE WHEN TG_OP != 'DELETE' THEN to_jsonb(NEW) ELSE NULL END,
      'old', CASE WHEN TG_OP != 'INSERT' THEN to_jsonb(OLD) ELSE NULL END
    ),
    'server_event',
    'server-structure:' || v_server::text,
    true
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- User role assignments INSERT/DELETE → server-structure:{server_id}
CREATE OR REPLACE FUNCTION public.broadcast_user_role_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_server uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_server := OLD.server_id;
  ELSE
    v_server := NEW.server_id;
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type', 'user_role:' || lower(TG_OP),
      'new', CASE WHEN TG_OP != 'DELETE' THEN to_jsonb(NEW) ELSE NULL END,
      'old', CASE WHEN TG_OP != 'INSERT' THEN to_jsonb(OLD) ELSE NULL END
    ),
    'server_event',
    'server-structure:' || v_server::text,
    true
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Channel permission overrides INSERT/UPDATE/DELETE → server-structure:{server_id}
CREATE OR REPLACE FUNCTION public.broadcast_permission_override_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_channel_id uuid;
  v_server_id  uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_channel_id := OLD.channel_id;
  ELSE
    v_channel_id := NEW.channel_id;
  END IF;

  SELECT server_id INTO v_server_id
  FROM channels
  WHERE id = v_channel_id;

  IF v_server_id IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type', 'permission_override:' || lower(TG_OP),
      'new', CASE WHEN TG_OP != 'DELETE' THEN to_jsonb(NEW) ELSE NULL END,
      'old', CASE WHEN TG_OP != 'INSERT' THEN to_jsonb(OLD) ELSE NULL END
    ),
    'server_event',
    'server-structure:' || v_server_id::text,
    true
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- =========================================================================
-- Presence broadcast functions (member join/leave, profile changes)
-- These send to server-presence:{server_id} with event "presence_event".
-- =========================================================================

-- User servers INSERT/DELETE → server-presence:{server_id} (member:join/leave)
CREATE OR REPLACE FUNCTION public.broadcast_user_server_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row   record;
  v_event text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row   := OLD;
    v_event := 'member:leave';
  ELSE
    v_row   := NEW;
    v_event := 'member:join';
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type',      v_event,
      'user_id',   v_row.user_id,
      'server_id', v_row.server_id
    ),
    'presence_event',
    'server-presence:' || v_row.server_id::text,
    true
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Profile UPDATE → server-presence:{server_id} for each server the user belongs to
CREATE OR REPLACE FUNCTION public.broadcast_profile_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_server_id uuid;
  v_server_count int := 0;
BEGIN
  IF OLD.display_name   IS NOT DISTINCT FROM NEW.display_name
     AND OLD.avatar_url IS NOT DISTINCT FROM NEW.avatar_url
     AND OLD.banner_url IS NOT DISTINCT FROM NEW.banner_url
     AND OLD.color      IS NOT DISTINCT FROM NEW.color
     AND OLD.bio        IS NOT DISTINCT FROM NEW.bio
     AND OLD.username   IS NOT DISTINCT FROM NEW.username
     AND OLD.custom_status IS NOT DISTINCT FROM NEW.custom_status
     AND OLD.federation_metadata IS NOT DISTINCT FROM NEW.federation_metadata
  THEN
    RETURN NEW;
  END IF;

  FOR v_server_id IN
    SELECT server_id FROM user_servers WHERE user_id = NEW.id
  LOOP
    v_server_count := v_server_count + 1;
    BEGIN
      PERFORM realtime.send(
        jsonb_build_object(
          'type',                 'profile:updated',
          'user_id',              NEW.id,
          'display_name',         NEW.display_name,
          'avatar_url',           NEW.avatar_url,
          'banner_url',           NEW.banner_url,
          'color',                NEW.color,
          'bio',                  NEW.bio,
          'username',             NEW.username,
          'custom_status',        NEW.custom_status,
          'federation_metadata',  NEW.federation_metadata
        ),
        'presence_event',
        'server-presence:' || v_server_id::text,
        true
      );
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'broadcast_profile_change failed for server %: %', v_server_id, SQLERRM;
    END;
  END LOOP;

  RAISE LOG 'broadcast_profile_change: sent to % servers for user %', v_server_count, NEW.id;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'broadcast_profile_change outer failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

-- =========================================================================
-- User-scoped broadcast functions (mutes, blocks)
-- These send to user:{id} with event "user_event" for cross-device sync.
-- =========================================================================

-- User mutes INSERT/DELETE → user:{muter_id}
CREATE OR REPLACE FUNCTION public.broadcast_user_mute_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row    record;
  v_user   uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row  := OLD;
    v_user := OLD.muter_id;
  ELSE
    v_row  := NEW;
    v_user := NEW.muter_id;
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type', 'mute:' || lower(TG_OP),
      'muted_user_id', v_row.muted_user_id
    ),
    'user_event',
    'user:' || v_user::text,
    true
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- User blocks INSERT/DELETE → user:{blocker_id}
CREATE OR REPLACE FUNCTION public.broadcast_user_block_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row    record;
  v_user   uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row  := OLD;
    v_user := OLD.blocker_id;
  ELSE
    v_row  := NEW;
    v_user := NEW.blocker_id;
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type', 'block:' || lower(TG_OP),
      'blocked_user_id', v_row.blocked_user_id
    ),
    'user_event',
    'user:' || v_user::text,
    true
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- =========================================================================
-- ActivityPub broadcast functions: posts, interactions, follows
-- Push events to user:{profile_id} via realtime.send()
-- =========================================================================

CREATE OR REPLACE FUNCTION public.broadcast_post_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_event          text;
  v_row            record;
  v_payload        jsonb;
  v_publish_public boolean := false;
  v_publish_local  boolean := false;
  v_tag            text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_event := 'post:deleted';
    v_row   := OLD;
  ELSIF TG_OP = 'INSERT' THEN
    v_event := 'post:new';
    v_row   := NEW;
  ELSE
    v_event := 'post:updated';
    v_row   := NEW;
  END IF;

  v_payload := jsonb_build_object(
    'type',       v_event,
    'post_id',    v_row.id,
    'author_id',  v_row.author_id,
    'visibility', v_row.visibility,
    'is_deleted', COALESCE(v_row.is_deleted, false),
    'is_local',   COALESCE(v_row.is_local, false),
    'ap_type',    v_row.ap_type
  );

  PERFORM realtime.send(
    v_payload,
    'user_event',
    'user:' || v_row.author_id::text,
    true
  );

  -- Profile timeline topic - gated on public visibility because realtime
  -- authorization is USING (true), so the topic name is the only access
  -- check. Author's own tabs still receive every event via the private
  -- user:{author_id} channel above.
  IF (TG_OP = 'INSERT' AND NEW.visibility = 'public')
     OR (TG_OP = 'UPDATE' AND (NEW.visibility = 'public' OR OLD.visibility = 'public'))
     OR (TG_OP = 'DELETE' AND OLD.visibility = 'public') THEN
    PERFORM realtime.send(
      v_payload,
      'feed_event',
      'feed:user:' || v_row.author_id::text,
      true
    );
  END IF;

  IF TG_OP = 'INSERT' THEN
    v_publish_public := (NEW.visibility = 'public' AND COALESCE(NEW.is_deleted, false) = false);
    v_publish_local  := v_publish_public AND COALESCE(NEW.is_local, false);
  ELSIF TG_OP = 'UPDATE' THEN
    v_publish_public := (NEW.visibility = 'public' OR OLD.visibility = 'public');
    v_publish_local  := v_publish_public
                       AND (COALESCE(NEW.is_local, false) OR COALESCE(OLD.is_local, false));
  ELSIF TG_OP = 'DELETE' THEN
    v_publish_public := (OLD.visibility = 'public');
    v_publish_local  := v_publish_public AND COALESCE(OLD.is_local, false);
  END IF;

  IF v_publish_public THEN
    PERFORM realtime.send(v_payload, 'feed_event', 'feed:public', true);
  END IF;
  IF v_publish_local THEN
    PERFORM realtime.send(v_payload, 'feed_event', 'feed:local', true);
  END IF;

  IF TG_OP = 'INSERT'
     AND NEW.visibility = 'public'
     AND COALESCE(NEW.is_deleted, false) = false THEN
    FOR v_tag IN
      SELECT h.normalized_tag
      FROM public.post_hashtags ph
      JOIN public.hashtags h ON h.id = ph.hashtag_id
      WHERE ph.post_id = NEW.id
    LOOP
      PERFORM realtime.send(v_payload, 'feed_event', 'feed:hashtag:' || v_tag, true);
    END LOOP;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.broadcast_post_interaction_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_interaction record;
  v_post_author uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_interaction := OLD;
  ELSE
    v_interaction := NEW;
  END IF;

  SELECT author_id INTO v_post_author
  FROM posts
  WHERE id = v_interaction.post_id;

  IF v_post_author IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type',             'post:interaction',
      'post_id',          v_interaction.post_id,
      'interaction_type', v_interaction.interaction_type,
      'user_id',          v_interaction.user_id,
      'emoji_id',         v_interaction.emoji_id,
      'op',               TG_OP
    ),
    'user_event',
    'user:' || v_post_author::text,
    true
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.broadcast_follow_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row     record;
  v_payload jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := OLD;
  ELSE
    v_row := NEW;
  END IF;

  v_payload := jsonb_build_object(
    'type',         'follow:change',
    'follower_id',  v_row.follower_id,
    'following_id', v_row.following_id,
    'status',       v_row.status,
    'op',           TG_OP
  );

  PERFORM realtime.send(v_payload, 'user_event', 'user:' || v_row.follower_id::text, true);
  PERFORM realtime.send(v_payload, 'user_event', 'user:' || v_row.following_id::text, true);

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Generic broadcast helper for the federation backend (Node BullMQ workers).
-- Mirrors db_schema/migrations/20260528_broadcast_user_event_rpc.sql.
-- The federation worker calls this via service_role Supabase RPC so it can
-- push events into the same `user:{profile_id}` / `user_event` topic that
-- DB triggers use, without granting INSERT on realtime.messages directly.
CREATE OR REPLACE FUNCTION public.broadcast_user_event(
  p_user_id uuid,
  p_payload jsonb
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_user_id IS NULL OR p_payload IS NULL THEN
    RETURN;
  END IF;

  PERFORM realtime.send(
    p_payload,
    'user_event',
    'user:' || p_user_id::text,
    true
  );
EXCEPTION WHEN OTHERS THEN
  RETURN;
END;
$$;

-- service_role ONLY. This pushes arbitrary payloads onto any user's realtime
-- channel; granting it to `authenticated` let any client forge notifications,
-- conversation updates, etc. for any victim. The federation worker calls it
-- with the service-role key; DB triggers call it as definer.
REVOKE EXECUTE ON FUNCTION public.broadcast_user_event(uuid, jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.broadcast_user_event(uuid, jsonb) TO service_role;

-- Home-feed realtime push: piggybacks on `create_comprehensive_timeline_entries()`
-- fan-out so local + remote posts both fire `home_feed:new_post` on every
-- recipient's `user:{profile_id}` channel without an extra Node round-trip.
CREATE OR REPLACE FUNCTION public.broadcast_home_feed_entry()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_author     uuid;
  v_created    timestamptz;
  v_visibility text;
  v_is_deleted boolean;
BEGIN
  IF NEW.timeline_type <> 'home' THEN
    RETURN NEW;
  END IF;

  SELECT author_id,
         created_at,
         visibility,
         COALESCE(is_deleted, false)
    INTO v_author, v_created, v_visibility, v_is_deleted
  FROM public.posts
  WHERE id = NEW.post_id;

  IF v_author IS NULL OR v_is_deleted THEN
    RETURN NEW;
  END IF;

  IF v_visibility NOT IN ('public', 'unlisted', 'followers') THEN
    RETURN NEW;
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type',         'home_feed:new_post',
      'post_id',      NEW.post_id,
      'author_id',    v_author,
      'created_at',   v_created,
      'visibility',   v_visibility,
      'source_table', 'timeline_entries'
    ),
    'user_event',
    'user:' || NEW.user_id::text,
    true
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

-- Snapshot reaction display key before emoji delete (FK handles emoji_id → NULL)
CREATE OR REPLACE FUNCTION public.prepare_emoji_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.post_interactions pi
  SET custom_emoji_content = CASE
      WHEN OLD.url IS NOT NULL THEN ':' || OLD.name || ':'
      ELSE OLD.name
    END
  WHERE pi.emoji_id = OLD.id
    AND pi.custom_emoji_content IS NULL;

  RETURN OLD;
END;
$$;

-- Emoji changes → server-presence:{server_id}
CREATE OR REPLACE FUNCTION public.broadcast_emoji_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_server uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_server := OLD.server_id;
  ELSE
    v_server := NEW.server_id;
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'type',      'emoji:' || lower(TG_OP),
      'new',       CASE WHEN TG_OP != 'DELETE' THEN to_jsonb(NEW) ELSE NULL END,
      'old',       CASE WHEN TG_OP != 'INSERT' THEN to_jsonb(OLD) ELSE NULL END
    ),
    'presence_event',
    'server-presence:' || v_server::text,
    true
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Megolm key request/fulfilled → user:{user_id}
CREATE OR REPLACE FUNCTION public.broadcast_key_request_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.sender_user_id IS NOT NULL THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type',               'encryption:key_request',
        'id',                 NEW.id,
        'requester_user_id',  NEW.requester_user_id,
        'sender_user_id',     NEW.sender_user_id,
        'room_id',            NEW.room_id,
        'session_id',         NEW.session_id,
        'status',             NEW.status,
        'request_signature',  NEW.request_signature,
        'request_signing_fingerprint', NEW.request_signing_fingerprint,
        'created_at',         NEW.created_at
      ),
      'user_event',
      'user:' || NEW.sender_user_id::text,
      true
    );
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'fulfilled' THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type',               'encryption:key_fulfilled',
        'id',                 NEW.id,
        'requester_user_id',  NEW.requester_user_id,
        'sender_user_id',     NEW.sender_user_id,
        'room_id',            NEW.room_id,
        'session_id',         NEW.session_id,
        'encrypted_key',      NEW.encrypted_key,
        'fulfilled_at',       NEW.fulfilled_at
      ),
      'user_event',
      'user:' || NEW.requester_user_id::text,
      true
    );
  END IF;

  RETURN NEW;
END;
$$;

-- Device approval requests → the account's own user channel so OTHER devices/tabs
-- of the same account get the Discord-style "New login on X - was this you?"
-- prompt, and so the REQUESTING device learns when it was approved (and can pick
-- up any encrypted key-sync bundle). Both events go to user:{user_id} because the
-- approval conversation is entirely within one account.
CREATE OR REPLACE FUNCTION public.broadcast_device_approval_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type',                  'device:approval_request',
        'id',                    NEW.id,
        'user_id',               NEW.user_id,
        'requesting_device_id',  NEW.requesting_device_id,
        'requesting_label',      NEW.requesting_label,
        'created_at',            NEW.created_at,
        'expires_at',            NEW.expires_at
      ),
      'user_event',
      'user:' || NEW.user_id::text,
      true
    );
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'approved' AND OLD.status IS DISTINCT FROM 'approved' THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type',                  'device:approved',
        'id',                    NEW.id,
        'user_id',               NEW.user_id,
        'requesting_device_id',  NEW.requesting_device_id,
        'approved_by_device_id', NEW.approved_by_device_id,
        'encrypted_sync_bundle', NEW.encrypted_sync_bundle,
        'resolved_at',           NEW.resolved_at
      ),
      'user_event',
      'user:' || NEW.user_id::text,
      true
    );
  ELSIF TG_OP = 'UPDATE' AND NEW.status = 'denied' AND OLD.status IS DISTINCT FROM 'denied' THEN
    PERFORM realtime.send(
      jsonb_build_object(
        'type',                  'device:denied',
        'id',                    NEW.id,
        'user_id',               NEW.user_id,
        'requesting_device_id',  NEW.requesting_device_id
      ),
      'user_event',
      'user:' || NEW.user_id::text,
      true
    );
  END IF;

  RETURN NEW;
END;
$$;

-- Conversation updates → user:{participant_id} for each active participant
CREATE OR REPLACE FUNCTION public.broadcast_conversation_updated()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_participant RECORD;
  v_changes jsonb := '{}'::jsonb;
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    v_changes := v_changes || jsonb_build_object('name', NEW.name);
  END IF;

  IF NEW.metadata IS DISTINCT FROM OLD.metadata THEN
    v_changes := v_changes || jsonb_build_object('metadata', COALESCE(NEW.metadata, '{}'::jsonb));
  END IF;

  IF v_changes = '{}'::jsonb THEN
    RETURN NEW;
  END IF;

  FOR v_participant IN
    SELECT user_id FROM conversation_participants
    WHERE conversation_id = NEW.id AND left_at IS NULL
  LOOP
    PERFORM realtime.send(
      jsonb_build_object(
        'type', 'conversation:updated',
        'conversation_id', NEW.id,
        'changes', v_changes
      ),
      'user_event',
      'user:' || v_participant.user_id::text,
      true
    );
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

-- Prevent modification of protected role flags (is_admin, is_default, name)
CREATE OR REPLACE FUNCTION public.prevent_protected_role_modification()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    IF OLD.is_admin = true AND NEW.is_admin = false THEN
        RAISE EXCEPTION 'Cannot remove admin status from the Admin role.';
    END IF;

    IF OLD.is_default = true AND NEW.is_default = false THEN
        RAISE EXCEPTION 'Cannot remove default status from the everyone role.';
    END IF;

    IF (OLD.is_admin = true OR OLD.is_default = true) AND OLD.name != NEW.name THEN
        RAISE EXCEPTION 'Cannot rename protected roles.';
    END IF;

    RETURN NEW;
END;
$$;

DO $$
BEGIN
    RAISE NOTICE 'Trigger functions created successfully';
END $$;

