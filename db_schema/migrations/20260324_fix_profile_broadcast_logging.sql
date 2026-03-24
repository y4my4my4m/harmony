BEGIN;

-- Add error logging to broadcast_profile_change so failures are visible
-- instead of being silently swallowed by EXCEPTION WHEN OTHERS
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
        'server-presence:' || v_server_id::text
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

COMMIT;
