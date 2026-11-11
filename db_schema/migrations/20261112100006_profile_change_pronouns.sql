-- Account pronouns reach other members live.
--
-- broadcast_profile_change (baseline) sends profile:updated on each server-presence topic when a
-- profile field changes, and since 1.9.5 it is the only path: clients no longer broadcast their own
-- profile. It did not know profiles.pronouns (20261112100002), so a change to pronouns alone sent
-- nothing and other members kept the old value until a reload. It now compares and sends pronouns;
-- the client's handleProfileUpdate already reads the field. Otherwise as the baseline.
--
-- Converges by state: CREATE OR REPLACE only; the trigger trg_broadcast_profile_change is unchanged.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.broadcast_profile_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
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
     AND OLD.pronouns   IS NOT DISTINCT FROM NEW.pronouns
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
          'pronouns',             NEW.pronouns,
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

NOTIFY pgrst, 'reload schema';

COMMIT;
