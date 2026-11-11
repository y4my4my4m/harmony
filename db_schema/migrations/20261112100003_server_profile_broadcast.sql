-- Server profile broadcast: a member's server profile edit reaches the other members live.
--
-- broadcast_user_server_change() sent member:join / member:leave only. It now also sends
-- member:update, with the member's five server profile fields, when an UPDATE changes one of
-- them (nickname, avatar_url, banner_url, bio, pronouns). Updates of folder_id, position, muted
-- and the like send nothing. INSERT and DELETE behave as before.
--
-- Converges by state.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.broadcast_user_server_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_row     record;
  v_payload jsonb;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row     := OLD;
    v_payload := jsonb_build_object('type', 'member:leave');
  ELSIF TG_OP = 'INSERT' THEN
    v_row     := NEW;
    v_payload := jsonb_build_object('type', 'member:join');
  ELSE
    IF NEW.nickname   IS NOT DISTINCT FROM OLD.nickname
       AND NEW.avatar_url IS NOT DISTINCT FROM OLD.avatar_url
       AND NEW.banner_url IS NOT DISTINCT FROM OLD.banner_url
       AND NEW.bio        IS NOT DISTINCT FROM OLD.bio
       AND NEW.pronouns   IS NOT DISTINCT FROM OLD.pronouns THEN
      RETURN NEW;
    END IF;
    v_row     := NEW;
    v_payload := jsonb_build_object(
      'type',       'member:update',
      'nickname',   NEW.nickname,
      'avatar_url', NEW.avatar_url,
      'banner_url', NEW.banner_url,
      'bio',        NEW.bio,
      'pronouns',   NEW.pronouns
    );
  END IF;

  PERFORM realtime.send(
    v_payload || jsonb_build_object('user_id', v_row.user_id, 'server_id', v_row.server_id),
    'presence_event',
    'server-presence:' || v_row.server_id::text,
    true
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_user_server_change ON public.user_servers;
CREATE TRIGGER trg_broadcast_user_server_change
    AFTER INSERT OR DELETE OR UPDATE OF nickname, avatar_url, banner_url, bio, pronouns ON public.user_servers
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_user_server_change();

NOTIFY pgrst, 'reload schema';

COMMIT;
