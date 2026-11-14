-- Follow-ups to 20261114200001_copy_emojis.
--
--   detach_copy_emojis (BEFORE DELETE ON servers)
--       a copy's mirrored emojis (ap_id set) are detached, not deleted with it: server_id and ap_id
--       NULL, as an emoji seen in an activity is stored. The sync took over such rows from earlier
--       activities, so reactions, post reactions and messages elsewhere may name them; they keep
--       their emoji. A local server's emojis go with it as before.
--   guard_copy_emoji_write (BEFORE UPDATE ON emojis)
--       a mirrored emoji's name and image are its host's: a request as authenticated or anon
--       (rename_emoji included, which runs as definer) cannot change them; the service role (the
--       sync) can. An instance admin still removes and restores one (deleted_at); the sync keeps a
--       removal that has deleted_by set.
--   trigger_queue_server_update_federation
--       as 20261105100001, and allow_cross_server_emojis: the Group carries it as
--       harmony:crossServerEmojis, and a copy stores it.
BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.detach_copy_emojis()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.is_local_server IS FALSE THEN
        UPDATE public.emojis
           SET server_id = NULL, ap_id = NULL
         WHERE server_id = OLD.id AND ap_id IS NOT NULL;
    END IF;
    RETURN OLD;
END;
$$;

REVOKE ALL ON FUNCTION public.detach_copy_emojis() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_servers_detach_copy_emojis ON public.servers;
CREATE TRIGGER a_servers_detach_copy_emojis
    BEFORE DELETE ON public.servers
    FOR EACH ROW EXECUTE FUNCTION public.detach_copy_emojis();

CREATE OR REPLACE FUNCTION public.guard_copy_emoji_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF OLD.ap_id IS NOT NULL AND OLD.server_id IS NOT NULL
       AND (NEW.name IS DISTINCT FROM OLD.name OR NEW.url IS DISTINCT FROM OLD.url)
       AND COALESCE(auth.role(), '') IN ('authenticated', 'anon') THEN
        RAISE EXCEPTION 'A copy''s emojis are renamed on the server''s own instance' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_copy_emoji_write() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_emojis_copy_guard ON public.emojis;
CREATE TRIGGER a_emojis_copy_guard
    BEFORE UPDATE OF name, url ON public.emojis
    FOR EACH ROW EXECUTE FUNCTION public.guard_copy_emoji_write();

-- As 20261105100001, with allow_cross_server_emojis.
CREATE OR REPLACE FUNCTION public.trigger_queue_server_update_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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
       AND OLD.federation_discoverable IS NOT DISTINCT FROM NEW.federation_discoverable
       AND OLD.allow_cross_server_emojis IS NOT DISTINCT FROM NEW.allow_cross_server_emojis
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

COMMIT;

NOTIFY pgrst, 'reload schema';
