-- Reconciles the broadcast_* trigger functions between init/ and migrations/.
--
-- Eleven functions differ. In every one the difference includes the fourth
-- argument to realtime.send: init/ passes `private => true`, the migrated body
-- omits it. Two carry a further difference, both logging:
-- broadcast_server_settings_change loses a RAISE WARNING from an otherwise
-- identical handler, and broadcast_profile_change loses a per-server
-- BEGIN/EXCEPTION wrapper plus a RAISE LOG.
--
-- All eleven are behaviourally equivalent today:
--
--   realtime.send(payload jsonb, event text, topic text, private boolean DEFAULT true)
--
-- so the three- and four-argument calls are the same call, and the exception
-- wrapper init/ carries around a bare `PERFORM realtime.send(...)` cannot fire
-- because realtime.send catches WHEN OTHERS itself and only raises a warning.
--
-- init/ is carried over anyway, for two reasons.
--
-- `private` is not cosmetic: RLS on realtime.messages, and therefore
-- can_subscribe_to_topic, applies to private channels only. A public topic is
-- readable by anyone who can reach Realtime. These topics carry server
-- structure, role and membership changes, so the flag is the switch that
-- engages authorization at all. Its default lives in supabase/realtime, whose
-- version a self-hosted deployment chooses -- self-host/trim-supabase.py takes
-- upstream's compose as it finds it and this repository pins nothing. Spelling
-- the flag out removes the dependency on someone else's default.
--
-- The logging is worth having for the same reason: a broadcast that fails is
-- otherwise silent on both sides.
--
-- No behaviour change, so nothing new to assert. tests/30_reconciled_functions.sql
-- pins the property that matters -- a server-structure broadcast lands private.

BEGIN;

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

-- CREATE OR REPLACE resets a function's attributes to exactly what the statement
-- says, so replacing a body defined in init/ without a SET search_path drops the
-- pin that 20260616_performance_advisor_fixes.sql applied. These eleven are
-- SECURITY DEFINER; an unpinned search_path lets a caller shadow unqualified
-- names. init/ reaches the same state through the loop in
-- 99_performance_hardening.sql, which only touches functions that still lack one.
ALTER FUNCTION public.broadcast_category_change() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.broadcast_channel_change() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.broadcast_emoji_change() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.broadcast_membership_event() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.broadcast_permission_override_change() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.broadcast_profile_change() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.broadcast_role_change() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.broadcast_server_settings_change() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.broadcast_thread_change() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.broadcast_user_role_change() SET search_path = public, extensions, pg_temp;
ALTER FUNCTION public.broadcast_user_server_change() SET search_path = public, extensions, pg_temp;

COMMIT;
