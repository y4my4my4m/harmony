BEGIN;

-- ============================================================================
-- Private broadcast channels: proper GRANT + RLS on realtime.messages
--
-- All server-scoped broadcasts (server-structure, server-presence) use
-- private channels (private := true) for security. This requires:
--
-- 1. The `authenticated` role to have USAGE on the `realtime` schema
-- 2. SELECT/INSERT grants on `realtime.messages`
-- 3. RLS policies that allow authenticated users to read/write
--
-- Without these, private channel subscriptions fail with CHANNEL_ERROR.
--
-- User-scoped broadcasts (user:{profileId}) already work because they
-- use the same mechanism - this migration ensures it's properly set up
-- for ALL private channels.
-- ============================================================================

-- Step 1: Grant schema access
GRANT USAGE ON SCHEMA realtime TO authenticated;
GRANT USAGE ON SCHEMA realtime TO anon;

-- Step 2: Grant table access
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'realtime' AND c.relname = 'messages'
  ) THEN
    EXECUTE 'GRANT SELECT, INSERT ON realtime.messages TO authenticated';
    EXECUTE 'GRANT SELECT ON realtime.messages TO anon';
    RAISE NOTICE 'Granted access on realtime.messages';
  ELSE
    RAISE WARNING 'realtime.messages table does not exist - skipping grants';
  END IF;
END;
$$;

-- Step 3: Enable RLS and create permissive policies
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'realtime' AND c.relname = 'messages'
  ) THEN
    EXECUTE 'ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY';

    EXECUTE 'DROP POLICY IF EXISTS "authenticated_users_can_receive" ON realtime.messages';
    EXECUTE 'CREATE POLICY "authenticated_users_can_receive" ON realtime.messages
      FOR SELECT TO authenticated USING (true)';

    EXECUTE 'DROP POLICY IF EXISTS "authenticated_users_can_send" ON realtime.messages';
    EXECUTE 'CREATE POLICY "authenticated_users_can_send" ON realtime.messages
      FOR INSERT TO authenticated WITH CHECK (true)';

    RAISE NOTICE 'RLS policies created on realtime.messages';
  END IF;
END;
$$;

-- ============================================================================
-- Step 4: Update all server-scoped broadcast functions to explicitly pass
-- private := true (don't rely on default, be explicit)
-- ============================================================================

-- 4a. broadcast_server_settings_change
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

-- 4b. broadcast_channel_change
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

-- 4c. broadcast_category_change
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

-- 4d. broadcast_membership_event
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

-- 4e. broadcast_thread_change
CREATE OR REPLACE FUNCTION public.broadcast_thread_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_channel_id uuid;
  v_server_id uuid;
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

-- 4f. broadcast_role_change
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

-- 4g. broadcast_user_role_change
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

-- 4h. broadcast_permission_override_change
CREATE OR REPLACE FUNCTION public.broadcast_permission_override_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_channel_id uuid;
  v_server_id uuid;
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

-- 4i. broadcast_user_server_change (member join/leave)
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

-- 4j. broadcast_profile_change (profile updates → all servers)
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

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'broadcast_profile_change outer failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

-- 4k. broadcast_emoji_change
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
EXCEPTION WHEN OTHERS THEN
  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMIT;
