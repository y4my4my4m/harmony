BEGIN;

-- =========================================================================
-- Broadcast Consolidation Migration
-- Adds all missing broadcast triggers for real-time updates.
-- All functions use realtime.send() for O(1) fan-out (no SQL member loops).
-- =========================================================================

-- =========================================================================
-- A. Server-structure broadcasts (channels, categories, threads, membership)
-- These were migration-only; now also in init for fresh installs.
-- =========================================================================

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
    'server-structure:' || v_server::text
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'broadcast_channel_change failed: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

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
    'server-structure:' || v_server::text
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'broadcast_category_change failed: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

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
    'server-structure:' || NEW.server_id::text
  );

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

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
    'server-structure:' || v_server_id::text
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- =========================================================================
-- B. New server-structure broadcasts (roles, user roles, permission overrides)
-- =========================================================================

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
    'server-structure:' || v_server::text
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RETURN COALESCE(NEW, OLD);
END;
$$;

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
    'server-structure:' || v_server::text
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RETURN COALESCE(NEW, OLD);
END;
$$;

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
    'server-structure:' || v_server_id::text
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- =========================================================================
-- C. Presence broadcasts (member join/leave, profile changes)
-- =========================================================================

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
    'server-presence:' || v_row.server_id::text
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE OR REPLACE FUNCTION public.broadcast_profile_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_server_id uuid;
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
      'server-presence:' || v_server_id::text
    );
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

-- =========================================================================
-- D. User-scoped broadcasts (mutes, blocks)
-- =========================================================================

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
-- E. Fix broadcast_server_change_event: add public + federation_enabled
-- =========================================================================

-- Locate and replace the existing function to include missing fields.
-- The function loops over server members (legacy pattern, not changed here).
CREATE OR REPLACE FUNCTION public.broadcast_server_change_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  member_record RECORD;
BEGIN
  FOR member_record IN
    SELECT user_id FROM user_servers WHERE server_id = NEW.id
  LOOP
    BEGIN
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
        'user:' || member_record.user_id::text,
        true
      );
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

-- =========================================================================
-- F. Triggers (idempotent - DROP IF EXISTS + CREATE)
-- =========================================================================

-- Server structure triggers
DROP TRIGGER IF EXISTS trg_broadcast_channel_change ON public.channels;
CREATE TRIGGER trg_broadcast_channel_change
    AFTER INSERT OR UPDATE OR DELETE ON public.channels
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_channel_change();

DROP TRIGGER IF EXISTS trg_broadcast_category_change ON public.channel_categories;
CREATE TRIGGER trg_broadcast_category_change
    AFTER INSERT OR UPDATE OR DELETE ON public.channel_categories
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_category_change();

DROP TRIGGER IF EXISTS trg_broadcast_membership_event ON public.server_membership_events;
CREATE TRIGGER trg_broadcast_membership_event
    AFTER INSERT ON public.server_membership_events
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_membership_event();

DROP TRIGGER IF EXISTS trg_broadcast_thread_change ON public.threads;
CREATE TRIGGER trg_broadcast_thread_change
    AFTER INSERT OR UPDATE OR DELETE ON public.threads
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_thread_change();

DROP TRIGGER IF EXISTS trg_broadcast_role_change ON public.server_roles;
CREATE TRIGGER trg_broadcast_role_change
    AFTER INSERT OR UPDATE OR DELETE ON public.server_roles
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_role_change();

DROP TRIGGER IF EXISTS trg_broadcast_user_role_change ON public.user_roles;
CREATE TRIGGER trg_broadcast_user_role_change
    AFTER INSERT OR DELETE ON public.user_roles
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_user_role_change();

DROP TRIGGER IF EXISTS trg_broadcast_permission_override ON public.channel_permission_overrides;
CREATE TRIGGER trg_broadcast_permission_override
    AFTER INSERT OR UPDATE OR DELETE ON public.channel_permission_overrides
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_permission_override_change();

-- Presence triggers
DROP TRIGGER IF EXISTS trg_broadcast_user_server_change ON public.user_servers;
CREATE TRIGGER trg_broadcast_user_server_change
    AFTER INSERT OR DELETE ON public.user_servers
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_user_server_change();

DROP TRIGGER IF EXISTS trg_broadcast_profile_change ON public.profiles;
CREATE TRIGGER trg_broadcast_profile_change
    AFTER UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_profile_change();

-- User-scoped triggers
DROP TRIGGER IF EXISTS trg_broadcast_user_mute ON public.user_mutes;
CREATE TRIGGER trg_broadcast_user_mute
    AFTER INSERT OR DELETE ON public.user_mutes
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_user_mute_change();

DROP TRIGGER IF EXISTS trg_broadcast_user_block ON public.user_blocks;
CREATE TRIGGER trg_broadcast_user_block
    AFTER INSERT OR DELETE ON public.user_blocks
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_user_block_change();

NOTIFY pgrst, 'reload schema';

COMMIT;
