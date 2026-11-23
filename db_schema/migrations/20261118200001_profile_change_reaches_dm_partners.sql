-- A profile change reaches the people one has a conversation with, as it reaches server members.
--
-- broadcast_profile_change sends profile:updated on server-presence:<id> of each server of the
-- profile, and now as user_event on user:<id> of each active local partner of an active
-- conversation, direct or group. A client joins server-presence only for the server it shows; the
-- user channel is always joined. Partner set as presence_publish (20261113100001): a partner the
-- profile blocks is skipped. Payload unchanged. A partner who also shares the shown server hears
-- it twice; the client applies it idempotently.
--
-- Server loop and field comparison as 20260101000000_baseline.sql.

BEGIN;

CREATE OR REPLACE FUNCTION public.broadcast_profile_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_payload jsonb;
  v_server_id uuid;
  v_partner uuid;
  v_server_count int := 0;
  v_partner_count int := 0;
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

  v_payload := jsonb_build_object(
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
  );

  FOR v_server_id IN
    SELECT server_id FROM public.user_servers WHERE user_id = NEW.id
  LOOP
    v_server_count := v_server_count + 1;
    BEGIN
      PERFORM realtime.send(v_payload, 'presence_event', 'server-presence:' || v_server_id::text, true);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'broadcast_profile_change failed for server %: %', v_server_id, SQLERRM;
    END;
  END LOOP;

  FOR v_partner IN
    SELECT DISTINCT other.user_id
      FROM public.conversation_participants mine
      JOIN public.conversation_participants other ON other.conversation_id = mine.conversation_id
      JOIN public.profiles p ON p.id = other.user_id
     WHERE mine.user_id = NEW.id AND mine.left_at IS NULL
       AND other.left_at IS NULL AND other.user_id <> NEW.id
       AND p.is_local IS TRUE
       AND NOT EXISTS (SELECT 1 FROM public.user_blocks bl
                        WHERE bl.blocker_id = NEW.id AND bl.blocked_user_id = other.user_id
                          AND (bl.expires_at IS NULL OR bl.expires_at > now()))
  LOOP
    v_partner_count := v_partner_count + 1;
    BEGIN
      PERFORM realtime.send(v_payload, 'user_event', 'user:' || v_partner::text, true);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'broadcast_profile_change failed for partner %: %', v_partner, SQLERRM;
    END;
  END LOOP;

  RAISE LOG 'broadcast_profile_change: sent to % servers and % partners for user %',
    v_server_count, v_partner_count, NEW.id;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'broadcast_profile_change outer failed: %', SQLERRM;
  RETURN NEW;
END;
$$;

COMMIT;
