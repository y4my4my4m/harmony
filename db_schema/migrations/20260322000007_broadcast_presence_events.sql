BEGIN;

-- ============================================================================
-- Step 2c: Replace postgres_changes on server-presence channel with broadcast.
--
-- Removes:
--   - CDC on user_servers (INSERT/DELETE filtered by server_id)
--   - CDC on profiles (UPDATE, UNFILTERED - worst offender, sends ALL profile
--     updates to ALL connected clients)
--
-- Replaces with:
--   - broadcast_user_server_change() on user_servers → sends member:join/leave
--     to server-presence:{server_id}
--   - broadcast_profile_change() on profiles UPDATE → sends profile_update
--     to every server-presence:{serverId} the user is a member of
-- ============================================================================

-- 1. user_servers INSERT/DELETE → broadcast to server-presence:{server_id}
CREATE OR REPLACE FUNCTION public.broadcast_user_server_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_row    record;
  v_event  text;
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
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_user_server_change ON user_servers;
CREATE TRIGGER trg_broadcast_user_server_change
  AFTER INSERT OR DELETE ON user_servers
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_user_server_change();


-- 2. profiles UPDATE → broadcast to every server the user belongs to
--    Only fires when columns that matter to the UI actually change.
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
        'federation_metadata',  NEW.federation_metadata
      ),
      'presence_event',
      'server-presence:' || v_server_id::text
    );
  END LOOP;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_profile_change ON profiles;
CREATE TRIGGER trg_broadcast_profile_change
  AFTER UPDATE ON profiles
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_profile_change();

COMMIT;
